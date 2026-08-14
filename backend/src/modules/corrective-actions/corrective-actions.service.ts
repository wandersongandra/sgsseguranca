import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsWhere,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import {
  CorrectiveAction,
  CorrectiveActionSource,
  CorrectiveActionPriority,
  CorrectiveActionStatus,
} from './entities/corrective-action.entity';
import {
  CreateCorrectiveActionDto,
  UpdateCorrectiveActionStatusDto,
} from './dto/create-corrective-action.dto';
import { UpdateCorrectiveActionDto } from './dto/update-corrective-action.dto';
import { TenantService } from '../../shared/tenant/tenant.service';
import {
  ResolvedSiteAccessScope,
  resolveSiteAccessScopeFromTenantService,
} from '../../shared/tenant/site-access-scope.util';
import { BaseService } from '../../shared/base/base.service';
import { NonConformitiesService } from '../nonconformities/nonconformities.service';
import { AuditsService } from '../audits/audits.service';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Notification } from '../notifications/entities/notification.entity';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';

const DEFAULT_SLA_BY_PRIORITY: Record<
  'low' | 'medium' | 'high' | 'critical',
  number
> = {
  low: 14,
  medium: 7,
  high: 3,
  critical: 1,
};

@Injectable()
export class CorrectiveActionsService extends BaseService<CorrectiveAction> {
  constructor(
    @InjectRepository(CorrectiveAction)
    private readonly correctiveActionsRepository: Repository<CorrectiveAction>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    private readonly nonConformitiesService: NonConformitiesService,
    private readonly auditsService: AuditsService,
    private readonly notificationsService: NotificationsService,
    tenantService: TenantService,
  ) {
    super(correctiveActionsRepository, tenantService, 'Ação Corretiva');
  }

  private getSiteAccessScopeOrThrow(): ResolvedSiteAccessScope {
    return resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'ações corretivas',
    );
  }

  private scopedWhere(
    scope: ResolvedSiteAccessScope,
    where: FindOptionsWhere<CorrectiveAction> = {},
  ): FindOptionsWhere<CorrectiveAction> {
    return {
      ...where,
      company_id: scope.companyId,
      ...(!scope.hasCompanyWideAccess ? { site_id: scope.siteId } : {}),
    };
  }

  private resolveWritableSiteId(
    siteId: string | null | undefined,
    scope: ResolvedSiteAccessScope,
  ): string | undefined {
    if (scope.hasCompanyWideAccess) {
      return siteId ?? undefined;
    }
    if (siteId && siteId !== scope.siteId) {
      throw new ForbiddenException('Obra fora do escopo do usuário atual.');
    }
    return scope.siteId;
  }

  async findOne(
    id: string,
    options: {
      relations?: string[];
      where?: FindOptionsWhere<CorrectiveAction>;
    } = {},
  ): Promise<CorrectiveAction> {
    const scope = this.getSiteAccessScopeOrThrow();
    return super.findOne(id, {
      ...options,
      where: this.scopedWhere(scope, options.where ?? {}),
    });
  }

  async create(
    dto: CreateCorrectiveActionDto,
    source: CorrectiveActionSource = 'manual',
  ): Promise<CorrectiveAction> {
    const scope = this.getSiteAccessScopeOrThrow();
    const priority = dto.priority || 'medium';
    const slaDays =
      dto.sla_days ||
      DEFAULT_SLA_BY_PRIORITY[priority] ||
      DEFAULT_SLA_BY_PRIORITY.medium;
    const dueDate = dto.due_date
      ? new Date(dto.due_date)
      : this.addDays(slaDays);

    const entity = this.correctiveActionsRepository.create({
      ...dto,
      company_id: scope.companyId,
      site_id: this.resolveWritableSiteId(dto.site_id, scope),
      due_date: dueDate,
      source_type: dto.source_type || source,
      status: dto.status || 'open',
      priority,
      sla_days: slaDays,
      escalation_level: 0,
    });

    return this.correctiveActionsRepository.save(entity);
  }

  async list(filters?: {
    status?: CorrectiveActionStatus;
    source_type?: CorrectiveActionSource;
    due?: 'overdue' | 'soon';
  }) {
    await this.markOverdueStatus();
    const scope = this.getSiteAccessScopeOrThrow();
    const where = this.scopedWhere(scope, {
      ...(filters?.status ? { status: filters.status } : {}),
      ...(filters?.source_type ? { source_type: filters.source_type } : {}),
    });

    const rows = await this.correctiveActionsRepository.find({
      where,
      relations: ['site', 'responsible_user'],
      order: { due_date: 'ASC', created_at: 'DESC' },
    });

    if (filters?.due === 'overdue') {
      return rows.filter((row) => row.status === 'overdue');
    }

    if (filters?.due === 'soon') {
      const limit = new Date();
      limit.setDate(limit.getDate() + 7);
      return rows.filter((row) => {
        if (row.status === 'done') return false;
        return row.due_date <= limit;
      });
    }

    return rows;
  }

  async listPaginated(filters?: {
    page?: number;
    limit?: number;
    status?: CorrectiveActionStatus;
    source_type?: CorrectiveActionSource;
    due?: 'overdue' | 'soon';
  }): Promise<OffsetPage<CorrectiveAction>> {
    await this.markOverdueStatus();
    const scope = this.getSiteAccessScopeOrThrow();
    const { page, limit, skip } = normalizeOffsetPagination(filters, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const query = this.correctiveActionsRepository
      .createQueryBuilder('ca')
      .leftJoinAndSelect('ca.site', 'site')
      .leftJoinAndSelect('ca.responsible_user', 'responsible_user')
      .where('ca.deleted_at IS NULL')
      .andWhere('ca.company_id = :companyId', { companyId: scope.companyId })
      .orderBy('ca.due_date', 'ASC')
      .addOrderBy('ca.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (!scope.hasCompanyWideAccess) {
      query.andWhere('ca.site_id = :siteId', { siteId: scope.siteId });
    }

    if (filters?.status) {
      query.andWhere('ca.status = :status', { status: filters.status });
    }

    if (filters?.source_type) {
      query.andWhere('ca.source_type = :sourceType', {
        sourceType: filters.source_type,
      });
    }

    if (filters?.due === 'overdue') {
      query.andWhere('ca.status = :overdueStatus', {
        overdueStatus: 'overdue',
      });
    }

    if (filters?.due === 'soon') {
      const now = new Date();
      const limitDate = new Date(now);
      limitDate.setDate(limitDate.getDate() + 7);
      query
        .andWhere('ca.status NOT IN (:...ignoredStatuses)', {
          ignoredStatuses: ['done', 'cancelled'],
        })
        .andWhere('ca.due_date BETWEEN :now AND :limitDate', {
          now,
          limitDate,
        });
    }

    const [data, total] = await query.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  async findSummary() {
    const scope = this.getSiteAccessScopeOrThrow();
    const baseWhere = this.scopedWhere(scope);
    const [all, open, inProgress, overdue, done] = await Promise.all([
      this.correctiveActionsRepository.count({
        where: baseWhere,
      }),
      this.correctiveActionsRepository.count({
        where: { ...baseWhere, status: 'open' },
      }),
      this.correctiveActionsRepository.count({
        where: { ...baseWhere, status: 'in_progress' },
      }),
      this.correctiveActionsRepository.count({
        where: { ...baseWhere, status: 'overdue' },
      }),
      this.correctiveActionsRepository.count({
        where: { ...baseWhere, status: 'done' },
      }),
    ]);

    const byPriorityQuery = this.correctiveActionsRepository
      .createQueryBuilder('ca')
      .select('ca.priority', 'priority')
      .addSelect('COUNT(*)', 'count')
      .where('ca.deleted_at IS NULL')
      .andWhere('ca.company_id = :companyId', { companyId: scope.companyId })
      .groupBy('ca.priority');
    if (!scope.hasCompanyWideAccess) {
      byPriorityQuery.andWhere('ca.site_id = :siteId', {
        siteId: scope.siteId,
      });
    }
    const byPriorityRows = await byPriorityQuery.getRawMany<{
      priority: CorrectiveActionPriority;
      count: string;
    }>();

    const byPriority: Record<CorrectiveActionPriority, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    for (const row of byPriorityRows) {
      const count = Number.parseInt(row.count, 10);
      byPriority[row.priority] = Number.isFinite(count) ? count : 0;
    }

    return {
      total: all,
      open,
      inProgress,
      overdue,
      done,
      complianceRate: all > 0 ? (done / all) * 100 : 100,
      byPriority,
    };
  }

  async createFromNonConformity(ncId: string) {
    const nc = await this.nonConformitiesService.findOne(ncId);
    const scope = this.getSiteAccessScopeOrThrow();
    const existing = await this.correctiveActionsRepository.findOne({
      where: this.scopedWhere(scope, {
        source_type: 'nonconformity',
        source_id: ncId,
      }),
      order: { created_at: 'DESC' },
    });
    if (existing) {
      return existing;
    }

    return this.create(
      {
        title: `Ação NC ${nc.codigo_nc || nc.id}`,
        description:
          nc.acao_definitiva_descricao || nc.descricao || 'Ação de NC',
        source_id: nc.id,
        source_type: 'nonconformity',
        site_id: nc.site_id,
        due_date:
          nc.acao_definitiva_data_prevista || nc.acao_definitiva_prazo
            ? new Date(
                nc.acao_definitiva_data_prevista || nc.acao_definitiva_prazo!,
              ).toISOString()
            : this.addDays(7).toISOString(),
        responsible_name:
          nc.acao_definitiva_responsavel || nc.responsavel_area || undefined,
        priority: this.mapRiskToPriority(nc.risco_nivel),
        status: 'open',
      },
      'nonconformity',
    );
  }

  private scopedActionsQuery() {
    const scope = this.getSiteAccessScopeOrThrow();
    const qb = this.correctiveActionsRepository
      .createQueryBuilder('ca')
      .where('ca.deleted_at IS NULL')
      .andWhere('ca.company_id = :companyId', { companyId: scope.companyId });
    if (!scope.hasCompanyWideAccess) {
      qb.andWhere('ca.site_id = :siteId', { siteId: scope.siteId });
    }
    return qb;
  }

  async getSlaOverview() {
    const now = new Date();
    const next48Hours = new Date(now);
    next48Hours.setHours(now.getHours() + 48);

    const counters = await this.scopedActionsQuery()
      .select('COUNT(*)', 'total')
      .addSelect(
        "SUM(CASE WHEN ca.status = 'overdue' THEN 1 ELSE 0 END)",
        'overdue',
      )
      .addSelect("SUM(CASE WHEN ca.status = 'done' THEN 1 ELSE 0 END)", 'done')
      .addSelect(
        "SUM(CASE WHEN ca.status NOT IN ('done', 'cancelled') AND ca.due_date >= :now AND ca.due_date <= :next48Hours THEN 1 ELSE 0 END)",
        'dueSoon',
      )
      .addSelect(
        "SUM(CASE WHEN ca.priority = 'critical' AND ca.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END)",
        'criticalOpen',
      )
      .addSelect(
        "SUM(CASE WHEN ca.priority = 'high' AND ca.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END)",
        'highOpen',
      )
      .setParameters({ now, next48Hours })
      .getRawOne<{
        total: string;
        overdue: string;
        done: string;
        dueSoon: string;
        criticalOpen: string;
        highOpen: string;
      }>();

    const total = Number.parseInt(counters?.total ?? '0', 10);
    const overdue = Number.parseInt(counters?.overdue ?? '0', 10);
    const done = Number.parseInt(counters?.done ?? '0', 10);
    const dueSoon = Number.parseInt(counters?.dueSoon ?? '0', 10);
    const criticalOpen = Number.parseInt(counters?.criticalOpen ?? '0', 10);
    const highOpen = Number.parseInt(counters?.highOpen ?? '0', 10);

    // Só busca os campos mínimos das ações já concluídas (não o conjunto
    // completo, que domina o volume) para calcular a média de dias de
    // resolução. Teto de segurança na mesma linha de findAllForExport
    // (dds.service.ts) — cálculo de média em JS porque AVG(data - data)
    // portável entre Postgres (produção) e SQLite (testes) exigiria
    // funções de data incompatíveis entre os dois drivers.
    const RESOLUTION_SAMPLE_LIMIT = 20000;
    const closedActions = await this.scopedActionsQuery()
      .andWhere('ca.closed_at IS NOT NULL')
      .select(['ca.id', 'ca.created_at', 'ca.closed_at'])
      .take(RESOLUTION_SAMPLE_LIMIT)
      .getMany();

    const avgResolutionDays =
      closedActions.length > 0
        ? (
            closedActions.reduce((sum, action) => {
              const closedAt = new Date(action.closed_at as Date).getTime();
              const createdAt = new Date(action.created_at).getTime();
              return sum + (closedAt - createdAt) / 86400000;
            }, 0) / closedActions.length
          ).toFixed(1)
        : '0.0';

    return {
      total,
      overdue,
      done,
      onTime: total - overdue,
      complianceRate: total > 0 ? (done / total) * 100 : 100,
      dueSoon,
      criticalOpen,
      highOpen,
      avgResolutionDays,
    };
  }

  async getSlaBySite() {
    const sitesQuery = this.scopedActionsQuery()
      .leftJoinAndSelect('ca.site', 'site')
      .select('site.id', 'siteId')
      .addSelect('site.nome', 'siteName')
      .addSelect('COUNT(ca.id)', 'total')
      .addSelect(
        "SUM(CASE WHEN ca.status = 'overdue' THEN 1 ELSE 0 END)",
        'overdue',
      )
      .addSelect(
        "SUM(CASE WHEN ca.priority = 'critical' AND ca.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END)",
        'criticalOpen',
      )
      .groupBy('site.nome')
      .addGroupBy('site.id');
    const sites = await sitesQuery.getRawMany<{
      siteId: string | null;
      siteName: string | null;
      total: string;
      overdue: string;
      criticalOpen: string;
    }>();

    return sites.map((s) => ({
      siteId: s.siteId,
      site: s.siteName || 'Sem Unidade',
      total: Number.parseInt(s.total, 10),
      overdue: Number.parseInt(s.overdue, 10),
      criticalOpen: Number.parseInt(s.criticalOpen, 10),
      complianceRate:
        Number.parseInt(s.total, 10) > 0
          ? ((Number.parseInt(s.total, 10) - Number.parseInt(s.overdue, 10)) /
              Number.parseInt(s.total, 10)) *
            100
          : 100,
    }));
  }

  async runSlaEscalationSweep() {
    return this.refreshOverdueActions();
  }

  async createFromAudit(auditId: string) {
    const scope = this.getSiteAccessScopeOrThrow();
    const audit = await this.auditsService.findOne(auditId, scope.companyId);
    const existing = await this.correctiveActionsRepository.findOne({
      where: this.scopedWhere(scope, {
        source_type: 'audit',
        source_id: auditId,
      }),
      order: { created_at: 'DESC' },
    });
    if (existing) {
      return existing;
    }
    const firstNC = audit.resultados_nao_conformidades?.[0];
    return this.create(
      {
        title: `Ação Auditoria ${audit.titulo}`,
        description:
          firstNC?.descricao ||
          audit.conclusao ||
          'Ação corretiva originada de auditoria.',
        source_id: audit.id,
        source_type: 'audit',
        site_id: audit.site_id,
        due_date: this.addDays(15).toISOString(),
        responsible_user_id: audit.auditor_id,
        priority: firstNC?.classificacao
          ? this.mapRiskToPriority(firstNC.classificacao)
          : 'medium',
        status: 'open',
      },
      'audit',
    );
  }

  async update(id: string, dto: UpdateCorrectiveActionDto) {
    const entity = await this.findOne(id, {
      relations: ['responsible_user', 'site'],
    });
    const scope = this.getSiteAccessScopeOrThrow();
    const nextPriority = dto.priority || entity.priority;
    const nextSlaDays =
      dto.sla_days ||
      entity.sla_days ||
      DEFAULT_SLA_BY_PRIORITY[nextPriority] ||
      DEFAULT_SLA_BY_PRIORITY.medium;

    Object.assign(entity, {
      ...dto,
      ...(dto.site_id !== undefined
        ? { site_id: this.resolveWritableSiteId(dto.site_id, scope) }
        : {}),
      ...(dto.due_date ? { due_date: new Date(dto.due_date) } : {}),
      priority: nextPriority,
      sla_days: nextSlaDays,
    });
    return this.correctiveActionsRepository.save(entity);
  }

  async updateStatus(id: string, dto: UpdateCorrectiveActionStatusDto) {
    const entity = await this.findOne(id, {
      relations: ['responsible_user', 'site'],
    });
    entity.status = dto.status;
    if (dto.evidence_notes !== undefined) {
      entity.evidence_notes = dto.evidence_notes;
    }
    entity.closed_at = dto.status === 'done' ? new Date() : undefined;
    if (dto.status !== 'done') {
      entity.escalation_level = Math.max(entity.escalation_level || 0, 0);
    }
    return this.correctiveActionsRepository.save(entity);
  }

  async remove(id: string) {
    // Soft delete: hard delete apagaria a ação corretiva vinculada a uma
    // não conformidade/auditoria já registrada, quebrando a trilha de
    // conformidade (mesmo padrão de BaseService.remove()).
    await this.findOne(id);
    await this.correctiveActionsRepository.softDelete(id);
  }

  /**
   * Marca como `overdue` as ações abertas cujo prazo venceu.
   *
   * É a única parte do antigo `refreshOverdueActions` que faz sentido no
   * caminho de leitura: um UPDATE escopado por tenant/obra, sem varredura nem
   * N+1. Mantém a listagem coerente com o prazo sem arrastar o escalonamento
   * junto.
   */
  private async markOverdueStatus(): Promise<void> {
    const scope = this.getSiteAccessScopeOrThrow();
    const where = this.scopedWhere(scope, {
      status: 'open',
      due_date: LessThan(new Date()),
      deleted_at: IsNull(),
    });
    await this.correctiveActionsRepository.update(where, { status: 'overdue' });
  }

  /**
   * Varredura de SLA: além de marcar vencidas, escala nível e notifica gestores.
   *
   * Roda no worker, acionada pela fila `sla-escalation` (o cron horário
   * `runCorrectiveActionsSlaEscalation` enfileira uma execução por tenant) ou
   * pelo endpoint explícito de sweep. NÃO deve ser chamada em rota de leitura:
   * ela carrega todas as ações vencidas do tenant sem limite e, para cada uma,
   * resolve destinatários e grava notificações — escritas disparadas por um GET,
   * multiplicadas por cada atualização de tela, que ainda impediam rotear a
   * listagem para a réplica de leitura.
   */
  private async refreshOverdueActions() {
    const scope = this.getSiteAccessScopeOrThrow();
    await this.markOverdueStatus();

    const overdueActions = await this.correctiveActionsRepository.find({
      where: this.scopedWhere(scope, {
        status: 'overdue',
        deleted_at: IsNull(),
      }),
    });

    let notificationsCreated = 0;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    for (const action of overdueActions) {
      const currentLevel = action.escalation_level || 0;
      const nextLevel = Math.min(currentLevel + 1, 2);
      if (nextLevel === currentLevel && action.last_reminder_at) {
        continue;
      }

      const recipients = await this.getEscalationRecipients(
        action.company_id,
        action.responsible_user_id,
        nextLevel,
      );

      for (const recipientId of recipients) {
        const existing = await this.notificationsRepository.findOne({
          where: {
            userId: recipientId,
            title: `Escalonamento SLA CAPA Nível ${nextLevel}`,
            createdAt: MoreThanOrEqual(todayStart),
          },
        });
        if (existing) continue;

        await this.notificationsService.create({
          companyId: action.company_id,
          userId: recipientId,
          type: 'warning',
          title: `Escalonamento SLA CAPA Nível ${nextLevel}`,
          message: `Ação "${action.title}" está vencida. Prioridade ${action.priority.toUpperCase()}.`,
          data: {
            actionUrl: '/dashboard/corrective-actions',
            actionText: 'Ver CAPA',
            correctiveActionId: action.id,
            escalationLevel: nextLevel,
            dueDate: action.due_date,
          },
        });
        notificationsCreated += 1;
      }

      action.escalation_level = nextLevel;
      action.last_reminder_at = new Date();
      await this.correctiveActionsRepository.save(action);
    }

    return {
      overdueActions: overdueActions.length,
      notificationsCreated,
    };
  }

  private async getEscalationRecipients(
    companyId: string,
    responsibleUserId: string | undefined,
    level: number,
  ): Promise<string[]> {
    const recipients = new Set<string>();
    if (responsibleUserId) {
      recipients.add(responsibleUserId);
    }

    if (level >= 2) {
      const managers = await this.usersRepository.find({
        where: { company_id: companyId, status: true },
        relations: ['profile'],
      });
      managers
        .filter((user) => {
          const profile = user.profile?.nome?.toLowerCase() || '';
          return (
            profile.includes('administrador') ||
            profile.includes('supervisor') ||
            profile.includes('técnico')
          );
        })
        .forEach((user) => recipients.add(user.id));
    }

    return [...recipients];
  }

  private mapRiskToPriority(
    risk: string,
  ): 'low' | 'medium' | 'high' | 'critical' {
    const normalized = (risk || '').toLowerCase();
    if (normalized.includes('crít') || normalized.includes('crit')) {
      return 'critical';
    }
    if (normalized.includes('grave') || normalized.includes('alto')) {
      return 'high';
    }
    if (normalized.includes('mod')) {
      return 'medium';
    }
    return 'low';
  }
}
