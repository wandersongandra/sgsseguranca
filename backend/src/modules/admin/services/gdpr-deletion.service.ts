import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { GdprDeletionRequest } from '../entities/gdpr-deletion-request.entity';
import {
  GdprRetentionCleanupRun,
  GdprRetentionCleanupTrigger,
} from '../entities/gdpr-retention-cleanup-run.entity';
import { TenantService } from '../../../shared/tenant/tenant.service';
import { PrivilegedDbService } from '../../../shared/database/privileged-db.service';
import { ProvisioningDataSourceService } from '../../../shared/database/provisioning-datasource.service';

export type { GdprDeletionRequest as GDPRDeleteRequest };

type GDPRDeletionCountRow = {
  table_name?: string;
  deleted_count?: string | number;
};

type DeleteExpiredDataOptions = {
  triggeredBy?: GdprRetentionCleanupTrigger;
  triggerSource?: string;
};

type DeleteExpiredDataResult = {
  status: string;
  run_id?: string;
  tables_cleaned: { table: string; rows_deleted: number }[];
  total_rows_deleted: number;
  duration_ms: number;
  timestamp: string;
  error?: string;
};

export type DeleteCompanyDataResult =
  | {
      status: 'success';
      company_id: string;
      tables_affected: number;
      total_rows_deleted: number;
      warning: string;
      timestamp: string;
    }
  | {
      status: 'failed';
      company_id: string;
      failures: Array<{ table: string; error: string }>;
      timestamp: string;
    };

@Injectable()
export class GDPRDeletionService {
  private readonly logger = new Logger('GDPRDeletionService');

  constructor(
    private dataSource: DataSource,
    @InjectRepository(GdprDeletionRequest)
    private deletionRequestRepo: Repository<GdprDeletionRequest>,
    @InjectRepository(GdprRetentionCleanupRun)
    private retentionCleanupRunRepo: Repository<GdprRetentionCleanupRun>,
    private readonly tenantService: TenantService,
    private readonly privilegedDb: PrivilegedDbService,
    private readonly provisioningDataSource: ProvisioningDataSourceService,
  ) {}

  private async queryRows<T>(
    sql: string,
    parameters: unknown[] = [],
  ): Promise<T[]> {
    return this.dataSource.query(sql, parameters);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : 'Unknown GDPR error';
  }

  private toInt(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Persiste o registro de execução da retenção pela conexão privilegiada.
   *
   * `gdpr_retention_cleanup_runs` está classificada como OPERATIONAL_GLOBAL na
   * migration 187: a policy é `FOR ALL USING/WITH CHECK (is_super_admin() = true)`,
   * **sem cláusula de tenant**. Para `sgs_app` isso é escrita morta em qualquer
   * circunstância desde a migration 361.
   *
   * O efeito prático era perverso: mesmo depois de a limpeza em si voltar a
   * funcionar, gravar o run estouraria — inclusive dentro do `catch`, que tenta
   * registrar a falha e falha de novo. O operador via um erro de RLS sobre a
   * *tabela de auditoria*, não "0 linhas apagadas", e o diagnóstico ia para o
   * lugar errado.
   */
  private saveRetentionRun(
    run: GdprRetentionCleanupRun,
  ): Promise<GdprRetentionCleanupRun> {
    return this.provisioningDataSource.requiredTransaction(
      'gdpr_retention_cleanup_run_persist',
      (manager) => manager.save(GdprRetentionCleanupRun, run),
    );
  }

  private isValidUUID(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id,
    );
  }

  /**
   * Anonima todos os dados de um usuario (LGPD Art. 18, VI).
   * Persiste a requisicao em banco para auditoria e sobreviver a restarts.
   */
  async deleteUserData(userId: string): Promise<GdprDeletionRequest> {
    if (!this.isValidUUID(userId)) {
      throw new BadRequestException('Invalid user ID format');
    }

    // Idempotencia: retorna requisicao existente se ja concluida ou em andamento
    const existing = await this.deletionRequestRepo.findOne({
      where: { user_id: userId, status: In(['completed', 'in_progress']) },
      order: { request_date: 'DESC' },
    });
    if (existing) {
      this.logger.log(
        `[GDPR] Duplicate deletion request for ${userId} — returning existing record ${existing.id} (status=${existing.status})`,
      );
      return existing;
    }

    const record = this.deletionRequestRepo.create({
      id: uuid(),
      user_id: userId,
      request_date: new Date(),
      status: 'in_progress',
      tables_processed: [],
      error_message: null,
      completed_date: null,
    });

    await this.deletionRequestRepo.save(record);
    this.logger.log(
      `[GDPR] User deletion request: ${userId} (Request ID: ${record.id})`,
    );

    try {
      // Roda OBRIGATORIAMENTE na conexão privilegiada (sgs_admin).
      //
      // `gdpr_delete_user_data()` não é SECURITY DEFINER: executa com os
      // privilégios de quem chama. Duas coisas impediam isso de funcionar pela
      // conexão de runtime:
      //
      //  1. a migration 341 revogou EXECUTE de PUBLIC — `sgs_app` não tem
      //     permissão de executar a função (verificado no catálogo);
      //  2. mesmo que tivesse, a migration 361 tornou `is_super_admin()`
      //     inerte para `sgs_app`, então todas as tabelas alvo (com FORCE RLS)
      //     filtrariam as linhas do titular e a função anonimizaria 0
      //     registros, reportando "completed".
      //
      // O wrap anterior era `runAsGlobalSuperAdmin`, que só ajusta a
      // AsyncLocalStorage e a flag de sessão — nenhuma das duas resolve o
      // problema acima. O direito de exclusão (LGPD Art. 18, VI) ficava sem
      // efeito. A migration 374 concede EXECUTE a `sgs_admin`, e é por ela que
      // esta chamada passa a correr.
      const result = await this.privilegedDb.withRequiredPrivilegedClient(
        'gdpr_delete_user_data',
        async (client) => {
          await client.query('BEGIN');
          try {
            await client.query("SET LOCAL app.is_super_admin = 'true'");
            const rows = await client.query<GDPRDeletionCountRow>(
              `SELECT * FROM gdpr_delete_user_data($1)`,
              [userId],
            );
            await client.query('COMMIT');
            return rows.rows;
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        },
      );

      for (const row of result) {
        const tableName = row.table_name ?? 'unknown';
        const deletedCount = this.toInt(row.deleted_count);
        record.tables_processed.push({
          table: tableName,
          rows_deleted: deletedCount,
        });
        this.logger.log(`  ✓ ${tableName}: ${deletedCount} rows anonymized`);
      }

      record.status = 'completed';
      record.completed_date = new Date();
      this.logger.log(
        `[GDPR] User deletion completed. Total tables: ${record.tables_processed.length}`,
      );
    } catch (error: unknown) {
      record.status = 'failed';
      record.error_message = this.getErrorMessage(error);
      record.completed_date = new Date();
      this.logger.error(
        `[GDPR] User deletion failed: ${this.getErrorMessage(error)}`,
      );
    } finally {
      await this.deletionRequestRepo.save(record);
    }

    return record;
  }

  /**
   * Executa cleanup de dados expirados (TTL automatico).
   */
  async deleteExpiredData(
    options: DeleteExpiredDataOptions = {},
  ): Promise<DeleteExpiredDataResult> {
    const startTime = Date.now();
    const startedAt = new Date();
    const triggeredBy = options.triggeredBy ?? 'manual';
    const triggerSource =
      options.triggerSource ??
      (triggeredBy === 'scheduled'
        ? 'worker:gdpr-retention-cleanup'
        : 'admin:gdpr-cleanup-expired');
    this.logger.log('[TTL] Starting expired data cleanup...');

    return this.runAsGlobalSuperAdmin(async () => {
      try {
        // Mesma história de `deleteUserData`: `cleanup_expired_data()` não é
        // SECURITY DEFINER e teve EXECUTE revogado de PUBLIC pela migration
        // 341. Enquanto o runtime de produção era `neondb_owner` (dono da
        // função) isto funcionava; quando passou a ser `sgs_app`, em
        // 2026-07-25, virou "permission denied" — e a política de retenção
        // parou de rodar sem que ninguém percebesse, porque o catch abaixo
        // apenas grava o run como 'failed'.
        const result = await this.privilegedDb.withRequiredPrivilegedClient(
          'cleanup_expired_data',
          async (client) => {
            await client.query('BEGIN');
            try {
              await client.query("SET LOCAL app.is_super_admin = 'true'");
              const rows = await client.query<GDPRDeletionCountRow>(
                `SELECT * FROM cleanup_expired_data()`,
              );
              await client.query('COMMIT');
              return rows.rows;
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            }
          },
        );

        let totalRows = 0;
        const tables_cleaned: { table: string; rows_deleted: number }[] = [];

        for (const row of result) {
          const tableName = row.table_name ?? 'unknown';
          const deletedCount = this.toInt(row.deleted_count);
          tables_cleaned.push({ table: tableName, rows_deleted: deletedCount });
          totalRows += deletedCount;
          this.logger.log(`  ✓ ${tableName}: ${deletedCount} rows deleted`);
        }

        const duration = Date.now() - startTime;
        const completedAt = new Date();
        const run = await this.saveRetentionRun(
          this.retentionCleanupRunRepo.create({
            status: 'success',
            triggered_by: triggeredBy,
            trigger_source: triggerSource,
            tables_cleaned,
            total_rows_deleted: totalRows,
            duration_ms: duration,
            error_message: null,
            started_at: startedAt,
            completed_at: completedAt,
          }),
        );
        this.logger.log(
          `[TTL] Cleanup completed. Run ${run.id}. Total rows deleted: ${totalRows} in ${duration}ms`,
        );

        return {
          status: 'success',
          run_id: run.id,
          tables_cleaned,
          total_rows_deleted: totalRows,
          duration_ms: duration,
          timestamp: completedAt.toISOString(),
        };
      } catch (error: unknown) {
        const message = this.getErrorMessage(error);
        const completedAt = new Date();
        const duration = Date.now() - startTime;
        const run = await this.saveRetentionRun(
          this.retentionCleanupRunRepo.create({
            status: 'error',
            triggered_by: triggeredBy,
            trigger_source: triggerSource,
            tables_cleaned: [],
            total_rows_deleted: 0,
            duration_ms: duration,
            error_message: message,
            started_at: startedAt,
            completed_at: completedAt,
          }),
        );
        this.logger.error(`[TTL] Cleanup failed: ${message}`);

        return {
          status: 'error',
          run_id: run.id,
          tables_cleaned: [],
          total_rows_deleted: 0,
          duration_ms: duration,
          error: message,
          timestamp: completedAt.toISOString(),
        };
      }
    });
  }

  async getDeleteRequestStatus(
    requestId: string,
  ): Promise<GdprDeletionRequest | null> {
    return this.deletionRequestRepo.findOne({ where: { id: requestId } });
  }

  async getPendingRequests(): Promise<GdprDeletionRequest[]> {
    return this.deletionRequestRepo.find({
      where: { status: In(['pending', 'in_progress']) },
      order: { request_date: 'DESC' },
    });
  }

  async getRetentionCleanupRuns(
    limit = 50,
  ): Promise<GdprRetentionCleanupRun[]> {
    const take = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.retentionCleanupRunRepo.find({
      order: { created_at: 'DESC' },
      take,
    });
  }

  /**
   * Soft-delete atomico de empresa e todos os dados associados (LGPD offboarding).
   * All-or-nothing: qualquer falha de tabela faz rollback completo da transacao.
   */
  async deleteCompanyData(companyId: string): Promise<DeleteCompanyDataResult> {
    if (!this.isValidUUID(companyId)) {
      throw new BadRequestException('Invalid company ID format');
    }

    this.logger.warn(
      `[GDPR] ENTERPRISE: Soft-delete company ${companyId} initiated`,
    );

    // Descoberta dinamica fora da transacao (read-only, information_schema).
    const discoveredRows = await this.dataSource.query<
      { table_name: string }[]
    >(`
      SELECT DISTINCT c.table_name
      FROM information_schema.columns c
      INNER JOIN information_schema.columns d
        ON d.table_name = c.table_name
        AND d.table_schema = 'public'
        AND d.column_name = 'deleted_at'
      WHERE c.column_name = 'company_id'
        AND c.table_schema = 'public'
      ORDER BY c.table_name
    `);
    const tables = discoveredRows.map((r) => r.table_name);
    this.logger.log(
      `[GDPR] Discovered ${tables.length} tables with company_id + deleted_at`,
    );

    let totalRows = 0;
    const now = new Date();
    let failedTable = '<unknown>';

    try {
      // Sem ramo alternativo para a conexão de runtime.
      //
      // O `else` que existia aqui rodava os mesmos UPDATE na conexão `sgs_app`
      // com `SET LOCAL app.is_super_admin = 'true'`. Depois da migration 361
      // essa flag é inerte, então cada UPDATE afetaria 0 linhas **sem erro** e
      // este método retornaria `status: 'success'` com `total_rows_deleted: 0`
      // — offboarding de tenant reportado como concluído sem ter soft-deletado
      // nada. Ausência da conexão privilegiada agora é 503, não caminho B.
      await this.privilegedDb.withRequiredPrivilegedClient(
        'gdpr_delete_company_data',
        async (client) => {
          await client.query('BEGIN');
          try {
            await client.query("SET LOCAL app.is_super_admin = 'true'");
            for (const table of tables) {
              failedTable = table;
              const result = await client.query(
                `UPDATE "${table}" SET deleted_at = $1 WHERE company_id = $2 AND deleted_at IS NULL`,
                [now, companyId],
              );
              const affectedRows = result.rowCount ?? 0;
              totalRows += affectedRows;
              this.logger.log(
                `  ✓ ${table}: ${affectedRows} rows soft-deleted`,
              );
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        },
      );

      this.logger.warn(
        `[GDPR] ENTERPRISE: Company ${companyId} soft-deleted — ${tables.length} tables, ${totalRows} rows affected`,
      );
      return {
        status: 'success',
        company_id: companyId,
        tables_affected: tables.length,
        total_rows_deleted: totalRows,
        warning:
          'Company soft-deleted. Hard-delete by retention policy will occur automatically.',
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      // Indisponibilidade da conexão privilegiada não é "falha de tabela": é
      // uma condição de infraestrutura que o chamador precisa distinguir.
      // Convertê-la em `status: 'failed'` genérico esconderia a causa real
      // atrás de um erro de negócio.
      if (error instanceof ServiceUnavailableException) throw error;

      const message = this.getErrorMessage(error);
      this.logger.error(
        `[GDPR] ENTERPRISE: Company ${companyId} soft-delete FAILED on table "${failedTable}" — transaction rolled back. ${message}`,
      );
      return {
        status: 'failed',
        company_id: companyId,
        failures: [{ table: failedTable, error: message }],
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Verifica se um usuario e elegivel para delecao (LGPD Art. 18, VI).
   *
   * Retorna can_delete: false se:
   * - Usuario nao existe
   * - Ja existe requisicao pending/in_progress para este usuario (evita duplicatas)
   */
  async validateUserConsent(userId: string): Promise<{
    can_delete: boolean;
    reason?: string;
  }> {
    const users = await this.queryRows<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [userId],
    );

    if (users.length === 0) {
      return { can_delete: false, reason: 'User not found' };
    }

    const existing = await this.deletionRequestRepo.findOne({
      where: { user_id: userId, status: In(['pending', 'in_progress']) },
    });

    if (existing) {
      return {
        can_delete: false,
        reason: `Deletion request already ${existing.status} (id: ${existing.id})`,
      };
    }

    return { can_delete: true };
  }

  private runAsGlobalSuperAdmin<T>(callback: () => Promise<T>): Promise<T> {
    return Promise.resolve(
      this.tenantService.run(
        { companyId: undefined, isSuperAdmin: true, siteScope: 'all' },
        callback,
      ),
    );
  }
}
