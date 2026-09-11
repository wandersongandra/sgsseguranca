import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository, LessThan } from 'typeorm';
import type { Queue } from 'bullmq';
import { AuditLog } from '../audit-trail/entities/audit-log.entity';
import { AprMetric } from '../aprs/entities/apr-metric.entity';
import { CompaniesService } from '../companies/companies.service';
import { isApiCronDisabled } from '../../shared/utils/scheduler.util';
import * as uploadUtils from '../../shared/interceptors/file-upload.interceptor';
import {
  buildDeterministicJobId,
  getUtcDateJobKey,
  getUtcHourJobKey,
} from '../../infra/queue/default-job-options';
import { PrivilegedDbService } from '../../shared/database/privileged-db.service';

const DLQ_ALERT_THRESHOLD =
  parseInt(process.env.DLQ_MAX_WAITING || '2000', 10) * 0.75;

/**
 * Alvos permitidos para purgeExpiredWithRlsBypass(), com metadado de
 * segurança sobre o modo de exclusão em lote. `ctidBatchSafe: false` marca
 * tabelas particionadas (ex.: audit_logs, RANGE-partitioned — ver migration
 * 1709000000091) onde `ctid` não é único fora de cada partição: um DELETE
 * em lote por `ctid` ali pode apagar linhas erradas em silêncio. O registro
 * (em vez de aceitar `table`/`column` como string livre) existe justamente
 * para que passar `batchSize` num alvo não seguro falhe em tempo de
 * execução, não em produção sem ninguém notar (achado da auditoria v2).
 */
const PURGE_TARGETS = {
  audit_logs: {
    table: 'audit_logs',
    column: 'timestamp',
    ctidBatchSafe: false,
  },
  apr_metrics: {
    table: 'apr_metrics',
    column: '"occurredAt"',
    ctidBatchSafe: true,
  },
} as const;
type PurgeTargetKey = keyof typeof PURGE_TARGETS;

@Injectable()
export class CleanupTask {
  private readonly logger = new Logger(CleanupTask.name);
  private readonly redisDisabled = /^true$/i.test(
    process.env.REDIS_DISABLED || '',
  );

  constructor(
    @InjectRepository(AuditLog)
    private auditLogRepo: Repository<AuditLog>,
    @InjectRepository(AprMetric)
    private aprMetricRepo: Repository<AprMetric>,
    @InjectQueue('sla-escalation') private readonly slaQueue: Queue,
    @InjectQueue('expiry-notifications') private readonly expiryQueue: Queue,
    @InjectQueue('pdf-generation-dlq') private readonly pdfDlq: Queue,
    private readonly companiesService: CompaniesService,
    private readonly privilegedDb: PrivilegedDbService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldLogs() {
    if (isApiCronDisabled()) {
      this.logger.warn(
        'API_CRONS_DISABLED=true: limpeza agendada de logs foi pulada neste runtime.',
      );
      return;
    }

    const retentionDays = this.resolveRetentionDays(
      process.env.AUDIT_LOG_RETENTION_DAYS,
      365,
      'AUDIT_LOG_RETENTION_DAYS',
    );
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const { eligible, deleted } = await this.purgeExpiredWithRlsBypass({
      target: 'audit_logs',
      cutoff,
      ormFallback: (manager) => {
        const repo = manager.getRepository(AuditLog);
        return {
          count: () => repo.count({ where: { timestamp: LessThan(cutoff) } }),
          deleteBatch: async (limit) => {
            const rows = await repo.find({
              where: { timestamp: LessThan(cutoff) },
              select: ['id'],
              take: limit,
            });
            if (rows.length === 0) return 0;
            const result = await repo.delete(rows.map((r) => r.id));
            return result.affected ?? rows.length;
          },
        };
      },
    });

    this.reportPurgeResult('audit_logs', eligible, deleted, retentionDays);
  }

  @Cron('15 4 * * *') // Diariamente às 04:15 — fora do horário do cleanupOldLogs (meia-noite)
  async cleanupOldAprMetrics() {
    if (isApiCronDisabled()) {
      this.logger.warn(
        'API_CRONS_DISABLED=true: limpeza agendada de apr_metrics foi pulada neste runtime.',
      );
      return;
    }

    const retentionDays = this.resolveRetentionDays(
      process.env.APR_METRICS_RETENTION_DAYS,
      90,
      'APR_METRICS_RETENTION_DAYS',
    );
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    // É observabilidade operacional (1 linha por GET /aprs/:id + eventos de
    // mutação), não trilha de auditoria/forense — retenção padrão de 90 dias
    // é suficiente (contra 365 de audit_logs). Mas por escrever MUITO mais
    // (toda visualização, não só ações) o volume elegível por execução pode
    // ficar bem maior que audit_logs — apaga em lotes (cada um com seu
    // próprio commit no caminho privilegiado) para não segurar uma
    // transação longa/lock demorado numa tabela de alto tráfego.
    const { eligible, deleted } = await this.purgeExpiredWithRlsBypass({
      target: 'apr_metrics',
      cutoff,
      batchSize: 5000,
      ormFallback: (manager) => {
        const repo = manager.getRepository(AprMetric);
        return {
          count: () => repo.count({ where: { occurredAt: LessThan(cutoff) } }),
          deleteBatch: async (limit) => {
            const rows = await repo.find({
              where: { occurredAt: LessThan(cutoff) },
              select: ['id'],
              take: limit,
            });
            if (rows.length === 0) return 0;
            const result = await repo.delete(rows.map((r) => r.id));
            return result.affected ?? rows.length;
          },
        };
      },
    });

    this.reportPurgeResult('apr_metrics', eligible, deleted, retentionDays);
  }

  /**
   * Retenção com piso mínimo — sem isso, uma env var inválida/0/negativa
   * (`=0`, `=-1`, `=abc`) vira purga total (ou um cutoff no futuro que
   * apaga tudo, inclusive o que acabou de ser escrito) com bypass de RLS
   * ativo, em todos os tenants (achado da auditoria v2). `minDays=7` é uma
   * trava de bom senso — nenhuma das duas tabelas tem motivo pra reter
   * menos que isso.
   */
  private resolveRetentionDays(
    raw: string | undefined,
    fallback: number,
    envVarName: string,
    minDays = 7,
  ): number {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= minDays) {
      return parsed;
    }
    if (raw !== undefined && raw !== '') {
      this.logger.error(
        `CleanupTask: ${envVarName}="${raw}" inválido (precisa ser inteiro >= ${minDays}) — usando fallback de ${fallback} dias.`,
      );
    }
    return fallback;
  }

  /**
   * Reaproveitado por cleanupOldLogs()/cleanupOldAprMetrics(): ambas as
   * tabelas têm RLS ativo e este cron roda fora de requisição HTTP, sem
   * contexto de tenant — a limpeza é intencionalmente global (todos os
   * tenants), então exige bypass de RLS. `target` só aceita chaves de
   * PURGE_TARGETS (nunca string livre vinda de fora desta classe).
   */
  private async purgeExpiredWithRlsBypass(options: {
    target: PurgeTargetKey;
    cutoff: Date;
    batchSize?: number;
    ormFallback: (manager: import('typeorm').EntityManager) => {
      count: () => Promise<number>;
      deleteBatch: (limit: number) => Promise<number>;
    };
  }): Promise<{ eligible: number; deleted: number }> {
    const { target, cutoff, batchSize, ormFallback } = options;
    const meta = PURGE_TARGETS[target];
    const { table, column, ctidBatchSafe } = meta;
    const label = table;

    if (batchSize && batchSize > 0 && !ctidBatchSafe) {
      // Trava de segurança, não só documentação: tabelas particionadas (ex.:
      // audit_logs) não têm ctid único fora de cada partição — um DELETE em
      // lote por ctid ali apagaria linhas erradas em silêncio. Ver comentário
      // de PURGE_TARGETS.
      throw new Error(
        `CleanupTask: purge em lote por ctid não é seguro em "${table}" (ctidBatchSafe=false) — ` +
          'remova batchSize ou use a chave primária via ormFallback.deleteBatch em ambos os caminhos.',
      );
    }

    if (!this.privilegedDb.isEnabled()) {
      // auditLogRepo/aprMetricRepo são injetados sem connection name
      // explícito — ambos compartilham a mesma conexão/manager default, por
      // isso usar auditLogRepo.manager aqui serve para as duas tabelas.
      return this.auditLogRepo.manager.transaction(async (manager) => {
        const roleCheck = (await manager.query<{ has_role: boolean }[]>(
          `SELECT pg_has_role(current_user, 'sgs_rls_bypass', 'member') AS has_role`,
        )) as Array<{ has_role: boolean }>;
        if (!roleCheck[0]?.has_role) {
          this.logger.error(
            `CleanupTask: papel de runtime não possui sgs_rls_bypass — ` +
              `limpeza de ${label} abortada para evitar exclusão parcial com RLS ativo.`,
          );
          return { eligible: 0, deleted: 0 };
        }

        await manager.query(`SET LOCAL app.is_super_admin = 'true'`);
        const fallback = ormFallback(manager);
        const eligibleCount = await fallback.count();

        // Caminho de fallback (sem PrivilegedDbService habilitado): ainda
        // roda tudo numa única transação — não tem o benefício de commits
        // por lote que o caminho privilegiado abaixo tem — mas ao menos
        // respeita batchSize em vez de ignorá-lo silenciosamente (achado da
        // auditoria v2), apagando por chave primária em páginas.
        const pageSize = batchSize && batchSize > 0 ? batchSize : Infinity;
        let deletedCount = 0;
        for (;;) {
          const batchDeleted = await fallback.deleteBatch(
            Number.isFinite(pageSize) ? pageSize : 100_000,
          );
          deletedCount += batchDeleted;
          if (!Number.isFinite(pageSize) || batchDeleted < pageSize) break;
        }
        return { eligible: eligibleCount, deleted: deletedCount };
      });
    }

    return this.privilegedDb.withPrivilegedClient(async (client) => {
      // Verificação prévia: falha rápida se o papel de runtime perdeu sgs_rls_bypass.
      // Sem isso, SET LOCAL is_super_admin continua sendo emitido mas a policy
      // RESTRICTIVE ainda filtra por tenant, tornando o DELETE inócuo (apaga 0
      // linhas) e o alerta pós-delete o único sinal do problema.
      const roleCheck = await client.query<{ has_role: boolean }>(
        `SELECT pg_has_role(current_user, 'sgs_rls_bypass', 'member') AS has_role`,
      );
      if (!roleCheck.rows[0]?.has_role) {
        this.logger.error(
          `CleanupTask: papel de runtime não possui sgs_rls_bypass — ` +
            `limpeza de ${label} abortada para evitar exclusão parcial com RLS ativo.`,
        );
        return { eligible: 0, deleted: 0 };
      }

      // A contagem também precisa do bypass ativo (SET LOCAL só vale dentro
      // da própria transação) — sem isso a RLS filtraria a contagem por
      // tenant e "eligible" ficaria incorreto (tipicamente 0), mascarando
      // justamente a divergência que reportPurgeResult() existe pra pegar.
      let eligibleCount: number;
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL app.is_super_admin = 'true'");
        const countResult = await client.query<{ cnt: number }>(
          `SELECT count(*)::int AS cnt FROM ${table} WHERE ${column} < $1`,
          [cutoff],
        );
        eligibleCount = countResult.rows[0]?.cnt ?? 0;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      let deletedCount = 0;
      if (batchSize && batchSize > 0) {
        // Cada lote é sua própria transação curta (BEGIN/SET LOCAL/COMMIT) —
        // diferente de fazer tudo numa transação só, isso evita segurar locks
        // por todo o tempo de uma exclusão potencialmente grande. Seguro por
        // ctid aqui porque ctidBatchSafe já foi checado acima.
        for (;;) {
          await client.query('BEGIN');
          try {
            await client.query("SET LOCAL app.is_super_admin = 'true'");
            const batchResult = await client.query(
              `DELETE FROM ${table} WHERE ctid IN (
                 SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT $2
               )`,
              [cutoff, batchSize],
            );
            await client.query('COMMIT');
            const batchDeleted = batchResult.rowCount ?? 0;
            deletedCount += batchDeleted;
            if (batchDeleted < batchSize) break;
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        }
      } else {
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL app.is_super_admin = 'true'");
          const deleteResult = await client.query(
            `DELETE FROM ${table} WHERE ${column} < $1`,
            [cutoff],
          );
          await client.query('COMMIT');
          deletedCount = deleteResult.rowCount ?? 0;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }

      return { eligible: eligibleCount, deleted: deletedCount };
    });
  }

  private reportPurgeResult(
    label: string,
    eligible: number,
    deleted: number,
    retentionDays: number,
  ): void {
    // Divergência aqui significa que o bypass deixou de valer (ex.: papel do
    // runtime perdeu `sgs_rls_bypass`). Sem este alerta a falha volta a ser
    // silenciosa, que foi exatamente o defeito original.
    if (eligible > 0 && deleted === 0) {
      this.logger.error(
        `Retenção de ${label} não removeu nada apesar de ${eligible} registro(s) elegível(is) — ` +
          'verifique se o papel de runtime ainda possui bypass de RLS (sgs_rls_bypass).',
      );
      return;
    }

    this.logger.log(
      `Old ${label} cleaned up: ${deleted} rows (retention=${retentionDays}d, elegíveis=${eligible})`,
    );
  }

  @Cron(CronExpression.EVERY_WEEK)
  generateWeeklyReports() {
    if (isApiCronDisabled()) {
      this.logger.warn(
        'API_CRONS_DISABLED=true: geração semanal agendada foi pulada neste runtime.',
      );
      return;
    }

    this.logger.log('Starting weekly reports generation...');
    // Lógica de geração de relatórios semanais
  }

  @Cron('0 8 * * *') // Daily at 08:00
  async runExpiryNotifications() {
    if (isApiCronDisabled()) {
      this.logger.warn(
        'API_CRONS_DISABLED=true: notificações agendadas de vencimento foram puladas neste runtime.',
      );
      return;
    }

    if (this.redisDisabled) {
      this.logger.warn(
        'REDIS_DISABLED=true: notificações assíncronas de vencimento foram puladas neste runtime.',
      );
      return;
    }

    const tenants = await this.companiesService.findAllActive();
    const dateKey = getUtcDateJobKey();
    for (const tenant of tenants) {
      await this.expiryQueue.add(
        'training-check',
        { tenantId: tenant.id, type: 'training-check' },
        {
          jobId: buildDeterministicJobId(
            'expiry-notifications:training-check',
            tenant.id,
            dateKey,
          ),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      );
      await this.expiryQueue.add(
        'epi-check',
        { tenantId: tenant.id, type: 'epi-check' },
        {
          jobId: buildDeterministicJobId(
            'expiry-notifications:epi-check',
            tenant.id,
            dateKey,
          ),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      );
      await this.expiryQueue.add(
        'medical-exam-check',
        { tenantId: tenant.id, type: 'medical-exam-check' },
        {
          jobId: buildDeterministicJobId(
            'expiry-notifications:medical-exam-check',
            tenant.id,
            dateKey,
          ),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 1000,
        },
      );
    }
    this.logger.log(
      `Expiry notifications enqueued for ${tenants.length} tenants`,
    );
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanupStaleTempUploads() {
    if (isApiCronDisabled()) {
      this.logger.warn(
        'API_CRONS_DISABLED=true: limpeza agendada de uploads temporários foi pulada neste runtime.',
      );
      return;
    }

    await uploadUtils.runTempUploadCleanupBestEffort(this.logger);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async runCorrectiveActionsSlaEscalation() {
    if (isApiCronDisabled()) {
      this.logger.warn(
        'API_CRONS_DISABLED=true: varredura agendada de SLA foi pulada neste runtime.',
      );
      return;
    }

    if (this.redisDisabled) {
      this.logger.warn(
        'REDIS_DISABLED=true: varredura assíncrona de SLA foi pulada neste runtime.',
      );
      return;
    }

    const tenants = await this.companiesService.findAllActive();
    const hourKey = getUtcHourJobKey();
    for (const tenant of tenants) {
      await this.slaQueue.add(
        'run-sla-sweep',
        { tenantId: tenant.id },
        {
          jobId: buildDeterministicJobId(
            'sla-escalation:run-sla-sweep',
            tenant.id,
            hourKey,
          ),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          // Evita retenção infinita no Redis em caso de falhas repetidas.
          removeOnFail: 1000,
        },
      );
    }
    this.logger.log(`SLA sweep enqueued for ${tenants.length} tenants`);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async checkPdfDlqDepth() {
    if (this.redisDisabled) return;

    try {
      const waiting = await this.pdfDlq.getWaitingCount();
      if (waiting >= DLQ_ALERT_THRESHOLD) {
        this.logger.warn({
          event: 'pdf_dlq_depth_high',
          waiting,
          threshold: DLQ_ALERT_THRESHOLD,
          message:
            'PDF DLQ próxima do limite — investigate falhas recorrentes de geração de PDF',
        });
      }
    } catch (err) {
      this.logger.error(
        `Falha ao checar profundidade do PDF DLQ: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
