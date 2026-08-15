import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import {
  AprApprovalStep,
  AprApprovalStepStatus,
} from './entities/apr-approval-step.entity';
import { AprLog } from './entities/apr-log.entity';
import { Apr, AprStatus, APR_ALLOWED_TRANSITIONS } from './entities/apr.entity';
import {
  AprApprovalRecord,
  ApprovalRecordAction,
} from './entities/apr-approval-record.entity';
import { AprWorkflowConfig } from './entities/apr-workflow-config.entity';
import { AprWorkflowResolverService } from './services/apr-workflow-resolver.service';
import { NotificationsService } from '../notifications/notifications.service';
import { normalizeRoleName } from '../auth/role-normalization.util';
import { Role } from '../auth/enums/roles.enum';
import { APR_DEFAULT_APPROVAL_STEP_TEMPLATES } from './apr-permissions.constants';

const APR_LOG_ACTIONS = {
  APPROVED: 'APR_APROVADA',
  REJECTED: 'APR_REPROVADA',
  FINALIZED: 'APR_ENCERRADA',
} as const;
const POSTGRES_LOCK_NOT_AVAILABLE_CODE = '55P03';
const APR_ROW_LOCK_RETRY_DELAYS_MS = [50, 100, 200] as const;

type PostgresErrorLike = {
  code?: unknown;
  driverError?: unknown;
};

type AprLogAction = (typeof APR_LOG_ACTIONS)[keyof typeof APR_LOG_ACTIONS];
type AprWorkflowActor = {
  /** Sinal único de papel (ex.: `profile.nome` do token). */
  roleName?: string | null;
  /**
   * Todos os sinais de papel disponíveis — inclui o array `roles` que o
   * RolesGuard popula via RBAC quando o token não carrega `profile.nome`.
   * Sem isso, um ADMIN cujo token dependa desse fallback seria tratado como
   * não privilegiado e barrado nas etapas de aprovação.
   */
  roleNames?: Array<string | null | undefined>;
  ipAddress?: string | null;
};

@Injectable()
export class AprWorkflowService {
  private readonly logger = new Logger(AprWorkflowService.name);

  constructor(
    @InjectRepository(Apr)
    private readonly aprsRepository: Repository<Apr>,
    @InjectRepository(AprLog)
    private readonly aprLogsRepository: Repository<AprLog>,
    @InjectRepository(AprApprovalRecord)
    private readonly approvalRecordRepo: Repository<AprApprovalRecord>,
    private readonly tenantService: TenantService,
    private readonly forensicTrailService: ForensicTrailService,
    private readonly notificationsService: NotificationsService,
    @Optional()
    private readonly workflowResolver?: AprWorkflowResolverService,
  ) {}

  async executeAprWorkflowTransition(
    id: string,
    fn: (apr: Apr, manager: EntityManager) => Promise<Apr>,
  ): Promise<Apr> {
    if (!this.tenantService.getTenantId()) {
      throw new InternalServerErrorException(
        'Tenant context ausente em transição de APR',
      );
    }
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'APR',
    );
    const tenantId = scope.companyId;

    for (
      let attempt = 0;
      attempt <= APR_ROW_LOCK_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await this.aprsRepository.manager.transaction(
          async (manager) => {
            const queryParams: unknown[] = [id, tenantId];
            const siteClause = scope.hasCompanyWideAccess
              ? ''
              : ' AND "site_id" = ANY($3::uuid[])';
            if (!scope.hasCompanyWideAccess) {
              queryParams.push(scope.siteIds);
            }
            const rows = await manager.query<Apr[]>(
              `SELECT * FROM "aprs" WHERE "id" = $1 AND "company_id" = $2 AND "deleted_at" IS NULL${siteClause} FOR UPDATE NOWAIT`,
              queryParams,
            );

            if (!rows || rows.length === 0) {
              throw new NotFoundException(`APR com ID ${id} não encontrada`);
            }

            const apr = manager.getRepository(Apr).create(rows[0]);
            return fn(apr, manager);
          },
        );
      } catch (error: unknown) {
        if (!this.isPostgresLockNotAvailableError(error)) {
          throw error;
        }
        const retryDelayMs = APR_ROW_LOCK_RETRY_DELAYS_MS[attempt];
        this.logger.warn({
          event: 'apr_workflow_lock_conflict',
          aprId: id,
          retryCount: attempt,
          durationMs: retryDelayMs ?? 0,
        });
        if (retryDelayMs === undefined) {
          throw new ConflictException(
            'Outra operação está em andamento para esta APR. Tente novamente em instantes.',
          );
        }

        await this.waitForRetry(retryDelayMs);
      }
    }

    throw new ConflictException(
      'Outra operação está em andamento para esta APR. Tente novamente em instantes.',
    );
  }

  private isPostgresLockNotAvailableError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as PostgresErrorLike;
    if (candidate.code === POSTGRES_LOCK_NOT_AVAILABLE_CODE) {
      return true;
    }
    return (
      typeof candidate.driverError === 'object' &&
      candidate.driverError !== null &&
      'code' in candidate.driverError &&
      (candidate.driverError as { code?: unknown }).code ===
        POSTGRES_LOCK_NOT_AVAILABLE_CODE
    );
  }

  private waitForRetry(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  async approve(
    id: string,
    userId: string,
    reason?: string,
    actor?: AprWorkflowActor,
  ): Promise<Apr> {
    const saved = await this.executeAprWorkflowTransition(
      id,
      async (apr, manager) => {
        await this.assertAprReadyForApproval(apr, manager);

        const currentStatus = this.ensureAprStatus(apr.status);
        const allowed = APR_ALLOWED_TRANSITIONS[currentStatus];
        if (!allowed?.includes(AprStatus.APROVADA)) {
          throw new BadRequestException(
            `Transição inválida: ${currentStatus} → Aprovada. Permitidas: ${allowed?.join(', ') || 'nenhuma'}`,
          );
        }

        const actorContext = this.buildActorContext(actor);
        const approvalSteps = await this.ensureApprovalSteps(apr, manager);
        const currentPendingStep = this.getCurrentPendingStep(approvalSteps);
        const now = new Date();

        if (!actorContext.isPrivileged && currentPendingStep) {
          this.assertActorCanApproveCurrentStep(
            actorContext.roleNames,
            currentPendingStep,
          );

          currentPendingStep.status = AprApprovalStepStatus.APPROVED;
          currentPendingStep.approver_user_id = userId;
          currentPendingStep.decision_reason = reason?.trim() || null;
          currentPendingStep.decided_ip = actorContext.ipAddress;
          currentPendingStep.decided_at = now;

          await manager.getRepository(AprApprovalStep).save(currentPendingStep);
        } else {
          const pendingSteps = approvalSteps.filter(
            (step) => step.status === AprApprovalStepStatus.PENDING,
          );

          if (pendingSteps.length > 0) {
            await this.saveApprovalStepsSequentially(
              manager,
              pendingSteps.map((step) => ({
                ...step,
                status: AprApprovalStepStatus.APPROVED,
                approver_user_id: userId,
                decision_reason: reason?.trim() || null,
                decided_ip: actorContext.ipAddress,
                decided_at: now,
              })),
            );
          }
        }

        const refreshedSteps = await manager
          .getRepository(AprApprovalStep)
          .find({
            where: { apr_id: apr.id },
            order: { level_order: 'ASC' },
          });

        const hasPendingSteps = refreshedSteps.some(
          (step) => step.status === AprApprovalStepStatus.PENDING,
        );

        if (!hasPendingSteps) {
          apr.status = AprStatus.APROVADA;
          apr.aprovado_por_id = userId;
          apr.aprovado_em = now;
          if (reason) {
            apr.aprovado_motivo = reason;
          }
        }

        const persisted = await manager.getRepository(Apr).save(apr);
        await this.forensicTrailService.append(
          {
            eventType: FORENSIC_EVENT_TYPES.APR_APPROVED,
            module: 'apr',
            entityId: persisted.id,
            companyId: persisted.company_id,
            userId,
            metadata: {
              previousStatus: currentStatus,
              currentStatus: persisted.status,
              version: persisted.versao ?? 1,
              reason: reason ?? null,
            },
          },
          { manager },
        );
        return persisted;
      },
    );

    await this.addLog(
      id,
      userId,
      APR_LOG_ACTIONS.APPROVED,
      { ...this.buildAprTraceMetadata(saved), motivo: reason },
      { critical: true },
    );
    this.logger.log({ event: 'apr_approved', aprId: id, userId });
    // Notifica proximo aprovador (fire-and-forget — nao bloqueia resposta)
    void this.tryNotifyNextApprover(id, saved);
    return saved;
  }

  async reject(
    id: string,
    userId: string,
    reason: string,
    actor?: AprWorkflowActor,
  ): Promise<Apr> {
    if (!reason?.trim() || reason.trim().length < 10) {
      throw new BadRequestException(
        'Motivo de reprovação obrigatório com mínimo de 10 caracteres.',
      );
    }

    const saved = await this.executeAprWorkflowTransition(
      id,
      async (apr, manager) => {
        this.assertAprWorkflowTransitionAllowed(apr);

        const currentStatus = this.ensureAprStatus(apr.status);
        const allowed = APR_ALLOWED_TRANSITIONS[currentStatus];
        if (!allowed?.includes(AprStatus.CANCELADA)) {
          throw new BadRequestException(
            `Transição inválida: ${currentStatus} → Cancelada. Permitidas: ${allowed?.join(', ') || 'nenhuma'}`,
          );
        }

        const actorContext = this.buildActorContext(actor);
        const approvalSteps = await this.ensureApprovalSteps(apr, manager);
        const currentPendingStep = this.getCurrentPendingStep(approvalSteps);

        if (!actorContext.isPrivileged && currentPendingStep) {
          this.assertActorCanApproveCurrentStep(
            actorContext.roleNames,
            currentPendingStep,
          );
        }

        const now = new Date();
        if (currentPendingStep) {
          currentPendingStep.status = AprApprovalStepStatus.REJECTED;
          currentPendingStep.approver_user_id = userId;
          currentPendingStep.decision_reason = reason;
          currentPendingStep.decided_ip = actorContext.ipAddress;
          currentPendingStep.decided_at = now;
        }

        const futurePendingSteps = approvalSteps
          .filter(
            (step) =>
              step.status === AprApprovalStepStatus.PENDING &&
              step.level_order >
                (currentPendingStep?.level_order ?? Number.MIN_SAFE_INTEGER),
          )
          .map((step) => ({
            ...step,
            status: AprApprovalStepStatus.SKIPPED,
            decision_reason:
              step.decision_reason ??
              'Fluxo encerrado por reprovação anterior.',
            decided_ip: step.decided_ip ?? actorContext.ipAddress,
            decided_at: step.decided_at ?? now,
          }));

        if (currentPendingStep || futurePendingSteps.length > 0) {
          await this.saveApprovalStepsSequentially(manager, [
            ...(currentPendingStep ? [currentPendingStep] : []),
            ...futurePendingSteps,
          ]);
        }

        const previousStatus = currentStatus;
        apr.status = AprStatus.CANCELADA;
        apr.reprovado_por_id = userId;
        apr.reprovado_em = now;
        apr.reprovado_motivo = reason;

        const persisted = await manager.getRepository(Apr).save(apr);
        await this.forensicTrailService.append(
          {
            eventType: FORENSIC_EVENT_TYPES.DOCUMENT_CANCELED,
            module: 'apr',
            entityId: persisted.id,
            companyId: persisted.company_id,
            userId,
            metadata: {
              previousStatus,
              currentStatus: persisted.status,
              reason,
            },
          },
          { manager },
        );
        return persisted;
      },
    );

    await this.addLog(
      id,
      userId,
      APR_LOG_ACTIONS.REJECTED,
      { ...this.buildAprTraceMetadata(saved), motivo: reason },
      { critical: true },
    );
    this.logger.log({ event: 'apr_rejected', aprId: id, userId });
    return saved;
  }

  async finalize(
    id: string,
    userId: string,
    _actor?: AprWorkflowActor,
  ): Promise<Apr> {
    const saved = await this.executeAprWorkflowTransition(
      id,
      async (apr, manager) => {
        this.assertAprReadyForFinalization(apr);
        const currentStatus = this.ensureAprStatus(apr.status);
        const allowed = APR_ALLOWED_TRANSITIONS[currentStatus];
        if (!allowed?.includes(AprStatus.ENCERRADA)) {
          throw new BadRequestException(
            `Transição inválida: ${currentStatus} → Encerrada. Permitidas: ${allowed?.join(', ') || 'nenhuma'}`,
          );
        }

        apr.status = AprStatus.ENCERRADA;
        const persisted = await manager.getRepository(Apr).save(apr);
        await this.forensicTrailService.append(
          {
            eventType: FORENSIC_EVENT_TYPES.APR_FINALIZED,
            module: 'apr',
            entityId: persisted.id,
            companyId: persisted.company_id,
            userId,
            metadata: {
              previousStatus: currentStatus,
              currentStatus: persisted.status,
              version: persisted.versao ?? 1,
            },
          },
          { manager },
        );
        return persisted;
      },
    );

    await this.addLog(
      id,
      userId,
      APR_LOG_ACTIONS.FINALIZED,
      this.buildAprTraceMetadata(saved),
      { critical: true },
    );
    this.logger.log({ event: 'apr_finalized', aprId: id, userId });
    return saved;
  }

  async addLog(
    aprId: string,
    userId: string | undefined,
    acao: AprLogAction,
    metadata?: Record<string, unknown>,
    options?: { manager?: EntityManager; critical?: boolean },
  ): Promise<void> {
    try {
      const repository =
        options?.manager?.getRepository(AprLog) ?? this.aprLogsRepository;
      const log = repository.create({
        apr_id: aprId,
        usuario_id: userId ?? undefined,
        acao,
        metadata: metadata ?? undefined,
      });
      await repository.save(log);
    } catch {
      if (options?.critical) {
        throw new InternalServerErrorException(
          `Não foi possível registrar a trilha forense da APR (${acao}).`,
        );
      }
      this.logger.warn(`Falha ao gravar log de APR (${aprId}): ${acao}`);
    }
  }

  buildAprTraceMetadata(apr: Apr): Record<string, unknown> {
    return {
      companyId: apr.company_id,
      status: apr.status,
      versao: apr.versao ?? 1,
      siteId: apr.site_id,
      participantCount: Array.isArray(apr.participants)
        ? apr.participants.length
        : 0,
      riskItemCount: Array.isArray(apr.risk_items) ? apr.risk_items.length : 0,
      approvalStepCount: Array.isArray(apr.approval_steps)
        ? apr.approval_steps.length
        : 0,
    };
  }

  private async tryNotifyNextApprover(aprId: string, apr: Apr): Promise<void> {
    try {
      // Carrega steps direto do banco — o objeto `apr` vem de SELECT sem JOIN,
      // então apr.approval_steps estaria vazio mesmo após o save das etapas.
      const steps = await this.aprsRepository.manager
        .getRepository(AprApprovalStep)
        .find({ where: { apr_id: aprId }, order: { level_order: 'ASC' } });
      const nextStep = steps.find(
        (s) => s.status === AprApprovalStepStatus.PENDING,
      );
      if (!nextStep) return; // Fluxo concluido ou nao ha proxima etapa

      const companyId = this.tenantService.getTenantId();
      if (!companyId) return;

      await this.notificationsService.notifyEligibleApprovers({
        companyId,
        requiredRoleRaw: nextStep.approver_role,
        title: 'Aprovação de APR pendente',
        message: `A etapa "${nextStep.title ?? nextStep.approver_role}" da APR ${apr.numero ?? aprId} aguarda sua aprovação.`,
        data: { event: 'apr_approval_pending', aprId },
        logContext: `APR aprId=${aprId}`,
      });
    } catch (err) {
      this.logger.warn(
        `tryNotifyNextApprover inesperado para aprId=${aprId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  ensureAprStatus(status: unknown): AprStatus {
    if (Object.values(AprStatus).includes(status as AprStatus)) {
      return status as AprStatus;
    }
    throw new BadRequestException(
      `Status de APR inválido ou desconhecido: "${String(status)}". Valores aceitos: ${Object.values(AprStatus).join(', ')}.`,
    );
  }

  assertAprFormMutable(apr: Apr): void {
    const status = this.ensureAprStatus(apr.status);
    if (status !== AprStatus.PENDENTE) {
      throw new BadRequestException(
        'Somente APRs pendentes podem ser editadas pelo formulário. Use os fluxos formais de aprovação, cancelamento, encerramento ou nova versão.',
      );
    }

    const hasApprovalProgress = Array.isArray(apr.approval_steps)
      ? apr.approval_steps.some(
          (step) => step.status !== AprApprovalStepStatus.PENDING,
        )
      : false;
    if (hasApprovalProgress) {
      throw new BadRequestException(
        'APR com aprovação em andamento está bloqueada para edição. Gere uma nova versão para alterar o documento.',
      );
    }
  }

  assertAprRemovable(apr: Pick<Apr, 'status' | 'pdf_file_key'>): void {
    if (apr.pdf_file_key) {
      throw new BadRequestException(
        'Somente APRs pendentes e sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros fechados.',
      );
    }

    const status = this.ensureAprStatus(apr.status);
    if (status !== AprStatus.PENDENTE) {
      throw new BadRequestException(
        'Somente APRs pendentes e sem PDF final podem ser removidas. Use os fluxos formais de cancelamento/encerramento para registros fechados.',
      );
    }

    const typedApr = apr as Apr;
    const hasApprovalProgress = Array.isArray(typedApr.approval_steps)
      ? typedApr.approval_steps.some(
          (step) => step.status !== AprApprovalStepStatus.PENDING,
        )
      : false;
    if (hasApprovalProgress) {
      throw new BadRequestException(
        'APR com aprovação em andamento não pode ser removida. Gere uma nova versão ou siga o fluxo formal.',
      );
    }
  }

  async assertAprReadyForApproval(
    apr: Apr,
    manager: EntityManager,
  ): Promise<void> {
    const status = this.ensureAprStatus(apr.status);
    if (status !== AprStatus.PENDENTE) {
      throw new BadRequestException(
        `Esta APR não está pronta para aprovação (status: ${status}).`,
      );
    }

    const participantRows = await manager.query<Array<{ count: string }>>(
      'SELECT COUNT(*)::text AS count FROM "apr_participants" WHERE "apr_id" = $1',
      [apr.id],
    );
    const participantCount = Number(participantRows[0]?.count ?? 0);

    if (participantCount === 0) {
      throw new BadRequestException(
        'A APR deve ter pelo menos um participante.',
      );
    }

    const riskItemRows = await manager.query<
      Array<{
        count: string;
        sem_atividade: string;
        sem_agente: string;
        sem_medidas: string;
        sem_responsavel: string;
      }>
    >(
      `SELECT
         COUNT(*)::text                                                          AS count,
         COUNT(*) FILTER (WHERE COALESCE(TRIM("atividade"), '') = '')::text      AS sem_atividade,
         COUNT(*) FILTER (WHERE COALESCE(TRIM("agente_ambiental"), '') = '' AND
                                COALESCE(TRIM("condicao_perigosa"), '')  = '' AND
                                COALESCE(TRIM("fonte_circunstancia"), '') = '')::text AS sem_agente,
         COUNT(*) FILTER (WHERE COALESCE(TRIM("medidas_prevencao"), '') = '')::text   AS sem_medidas,
         COUNT(*) FILTER (WHERE COALESCE(TRIM("responsavel"), '') = '')::text         AS sem_responsavel
       FROM "apr_risk_items"
       WHERE "apr_id" = $1 AND "deleted_at" IS NULL`,
      [apr.id],
    );

    const persistedRiskItemCount = Number(riskItemRows[0]?.count ?? 0);

    if (persistedRiskItemCount === 0) {
      throw new BadRequestException(
        'A APR deve ter pelo menos um item de risco estruturado.',
      );
    }

    if (persistedRiskItemCount > 0) {
      const semAtividade = Number(riskItemRows[0]?.sem_atividade ?? 0);
      if (semAtividade > 0) {
        throw new BadRequestException(
          `${semAtividade} item(ns) de risco sem campo "Atividade" preenchido. Preencha antes de aprovar.`,
        );
      }

      const semAgente = Number(riskItemRows[0]?.sem_agente ?? 0);
      if (semAgente > 0) {
        throw new BadRequestException(
          `${semAgente} item(ns) de risco sem identificação do perigo (agente ambiental, condição perigosa ou fonte/circunstância). Preencha antes de aprovar.`,
        );
      }

      const semMedidas = Number(riskItemRows[0]?.sem_medidas ?? 0);
      if (semMedidas > 0) {
        throw new BadRequestException(
          `${semMedidas} item(ns) de risco sem medidas de controle e prevenção definidas. Preencha antes de aprovar.`,
        );
      }

      const semResponsavel = Number(riskItemRows[0]?.sem_responsavel ?? 0);
      if (semResponsavel > 0) {
        throw new BadRequestException(
          `${semResponsavel} item(ns) de risco sem responsável pela ação designado. Preencha antes de aprovar.`,
        );
      }
    }
  }

  assertAprReadyForFinalization(
    apr: Pick<
      Apr,
      | 'status'
      | 'pdf_file_key'
      | 'final_pdf_hash_sha256'
      | 'verification_code'
      | 'pdf_generated_at'
    >,
  ): void {
    const status = this.ensureAprStatus(apr.status);
    if (status !== AprStatus.APROVADA) {
      throw new BadRequestException(
        `Esta APR não está pronta para ser encerrada (status: ${status}).`,
      );
    }

    if (
      !apr.pdf_file_key ||
      !apr.final_pdf_hash_sha256 ||
      !apr.verification_code ||
      !apr.pdf_generated_at
    ) {
      throw new BadRequestException(
        'Não é possível encerrar a APR sem PDF final oficial gerado.',
      );
    }
  }

  assertAprWorkflowTransitionAllowed(
    apr: Pick<Apr, 'status' | 'pdf_file_key'>,
  ): void {
    if (apr.pdf_file_key) {
      throw new BadRequestException(
        'APR com PDF final emitido está bloqueada para mudança de status. Gere uma nova versão para seguir com alterações.',
      );
    }

    const status = this.ensureAprStatus(apr.status);
    if (status === AprStatus.ENCERRADA || status === AprStatus.CANCELADA) {
      throw new BadRequestException(
        `Não é possível alterar o fluxo de uma APR já ${status}.`,
      );
    }
  }

  private isPrivilegedApprovalRole(roleName?: string | null): boolean {
    const normalized = normalizeRoleName(roleName);
    return normalized === Role.ADMIN_GERAL || normalized === Role.ADMIN_EMPRESA;
  }

  /**
   * Normaliza e deduplica todos os sinais de papel de um ator (o `roleName`
   * único e o array `roleNames` do fallback RBAC) em um conjunto canônico.
   */
  private normalizeActorRoles(actor?: AprWorkflowActor): Role[] {
    const signals = [actor?.roleName, ...(actor?.roleNames ?? [])];
    const normalized = new Set<Role>();
    for (const signal of signals) {
      const role = normalizeRoleName(signal);
      if (role) {
        normalized.add(role);
      }
    }
    return [...normalized];
  }

  private buildActorContext(actor?: AprWorkflowActor) {
    const roleNames = this.normalizeActorRoles(actor);
    return {
      roleNames,
      ipAddress:
        typeof actor?.ipAddress === 'string' && actor.ipAddress.trim()
          ? actor.ipAddress
          : null,
      isPrivileged: roleNames.some((role) =>
        this.isPrivilegedApprovalRole(role),
      ),
    };
  }

  private assertActorCanApproveCurrentStep(
    actorRoleNames: Role[],
    step: AprApprovalStep,
  ): void {
    const expectedRole = normalizeRoleName(step.approver_role);

    if (!expectedRole || !actorRoleNames.includes(expectedRole)) {
      throw new BadRequestException(
        `A próxima etapa de aprovação exige o perfil "${step.approver_role}".`,
      );
    }
  }

  private getCurrentPendingStep(
    steps: AprApprovalStep[],
  ): AprApprovalStep | undefined {
    return steps
      .slice()
      .sort((left, right) => left.level_order - right.level_order)
      .find((step) => step.status === AprApprovalStepStatus.PENDING);
  }

  private async ensureApprovalSteps(
    apr: Apr,
    manager: EntityManager,
  ): Promise<AprApprovalStep[]> {
    const repository = manager.getRepository(AprApprovalStep);
    const existing = await repository.find({
      where: { apr_id: apr.id },
      order: { level_order: 'ASC' },
    });

    if (existing.length > 0) {
      return existing;
    }

    const created = await repository.save(
      APR_DEFAULT_APPROVAL_STEP_TEMPLATES.map((step) =>
        repository.create({
          apr_id: apr.id,
          level_order: step.level_order,
          title: step.title,
          approver_role: step.approver_role,
          status: AprApprovalStepStatus.PENDING,
        }),
      ),
    );

    return created.sort((left, right) => left.level_order - right.level_order);
  }

  private async saveApprovalStepsSequentially(
    manager: EntityManager,
    steps: AprApprovalStep[],
  ): Promise<void> {
    const repository = manager.getRepository(AprApprovalStep);

    for (const step of steps) {
      await repository.save(step);
    }
  }

  // ─── Configurable Workflow Methods ───────────────────────────────────────────

  async resolveAndAssignWorkflow(apr: Apr): Promise<string | null> {
    if (!this.workflowResolver) return null;
    try {
      const config = await this.workflowResolver.resolveWorkflow(
        apr.company_id,
        apr.site_id,
        apr.tipo_atividade ?? undefined,
      );
      if (this.workflowResolver.isFallback(config)) return null;
      return config.id;
    } catch {
      return null;
    }
  }

  async getWorkflowStatus(
    apr: Apr,
    _requestingUserId: string,
    requestingUserRole?: string | null,
  ): Promise<{
    currentStep: {
      stepOrder: number;
      roleName: string;
      isRequired: boolean;
    } | null;
    nextStep: { stepOrder: number; roleName: string } | null;
    history: AprApprovalRecord[];
    canEdit: boolean;
    canApprove: boolean;
    workflowConfig: AprWorkflowConfig | null;
  }> {
    const history = await this.approvalRecordRepo.find({
      where: { aprId: apr.id },
      order: { occurredAt: 'ASC' },
    });

    if (!apr.workflowConfigId || !this.workflowResolver) {
      return {
        currentStep: null,
        nextStep: null,
        history,
        canEdit: this.ensureAprStatus(apr.status) === AprStatus.PENDENTE,
        canApprove: false,
        workflowConfig: null,
      };
    }

    const config = await this.loadWorkflowConfig(apr.workflowConfigId);
    if (!config) {
      return {
        currentStep: null,
        nextStep: null,
        history,
        canEdit: this.ensureAprStatus(apr.status) === AprStatus.PENDENTE,
        canApprove: false,
        workflowConfig: null,
      };
    }

    const steps = config.steps.sort((a, b) => a.stepOrder - b.stepOrder);
    const completedOrders = new Set(
      history
        .filter((r) => r.action === ApprovalRecordAction.APROVADO)
        .map((r) => r.stepOrder),
    );

    const currentStep =
      steps.find((s) => !completedOrders.has(s.stepOrder)) ?? null;
    const nextStep = currentStep
      ? (steps.find((s) => s.stepOrder > currentStep.stepOrder) ?? null)
      : null;

    const hasApprovalProgress = history.some(
      (r) => r.action === ApprovalRecordAction.APROVADO && r.aprId === apr.id,
    );

    const canApprove =
      !!currentStep &&
      this.ensureAprStatus(apr.status) === AprStatus.PENDENTE &&
      normalizeRoleName(requestingUserRole) ===
        normalizeRoleName(currentStep.roleName);

    return {
      currentStep: currentStep
        ? {
            stepOrder: currentStep.stepOrder,
            roleName: currentStep.roleName,
            isRequired: currentStep.isRequired,
          }
        : null,
      nextStep: nextStep
        ? { stepOrder: nextStep.stepOrder, roleName: nextStep.roleName }
        : null,
      history,
      canEdit:
        !hasApprovalProgress &&
        this.ensureAprStatus(apr.status) === AprStatus.PENDENTE,
      canApprove,
      workflowConfig: config,
    };
  }

  async processApproval(
    apr: Apr,
    approverId: string,
    approverRoles: Array<string | null | undefined>,
    action: ApprovalRecordAction,
    reason?: string,
  ): Promise<void> {
    if (
      (action === ApprovalRecordAction.REPROVADO ||
        action === ApprovalRecordAction.REABERTO) &&
      !reason?.trim()
    ) {
      throw new BadRequestException(
        'Motivo obrigatório para reprovar ou reabrir uma APR.',
      );
    }

    // Conjunto canônico de papéis do ator (inclui o fallback RBAC `roles`).
    const actorRoles = this.normalizeActorRoles({ roleNames: approverRoles });
    const primaryRole = actorRoles[0] ?? 'unknown';

    if (action === ApprovalRecordAction.REABERTO) {
      const currentStatus = this.ensureAprStatus(apr.status);
      if (
        currentStatus === AprStatus.CANCELADA ||
        currentStatus === AprStatus.ENCERRADA
      ) {
        throw new BadRequestException(
          `Não é possível reabrir uma APR ${currentStatus}. Gere uma nova versão para continuar.`,
        );
      }
      if (apr.pdf_file_key) {
        throw new BadRequestException(
          'APR com PDF final emitido está bloqueada para reabertura. Gere uma nova versão para alterar o documento.',
        );
      }
    }

    if (!apr.workflowConfigId || !this.workflowResolver) {
      throw new BadRequestException(
        'Esta APR não possui workflow configurável associado.',
      );
    }

    const config = await this.loadWorkflowConfig(apr.workflowConfigId);
    if (!config) {
      throw new NotFoundException('Configuração de workflow não encontrada.');
    }

    const steps = config.steps.sort((a, b) => a.stepOrder - b.stepOrder);

    const history = await this.approvalRecordRepo.find({
      where: { aprId: apr.id },
      order: { occurredAt: 'ASC' },
    });

    const completedOrders = new Set(
      history
        .filter((r) => r.action === ApprovalRecordAction.APROVADO)
        .map((r) => r.stepOrder),
    );

    const currentStep = steps.find((s) => !completedOrders.has(s.stepOrder));

    if (action === ApprovalRecordAction.APROVADO) {
      if (!currentStep) {
        throw new BadRequestException(
          'Todos os passos já foram concluídos nesta APR.',
        );
      }

      const isPrivileged = actorRoles.some((role) =>
        this.isPrivilegedApprovalRole(role),
      );
      const normalizedRequired = normalizeRoleName(currentStep.roleName);
      if (
        !isPrivileged &&
        actorRoles.length > 0 &&
        normalizedRequired &&
        !actorRoles.includes(normalizedRequired)
      ) {
        throw new ForbiddenException(
          `O passo atual exige o perfil "${currentStep.roleName}".`,
        );
      }

      await this.approvalRecordRepo.save(
        this.approvalRecordRepo.create({
          aprId: apr.id,
          workflowConfigId: apr.workflowConfigId,
          stepOrder: currentStep.stepOrder,
          roleName: currentStep.roleName,
          approverId,
          action: ApprovalRecordAction.APROVADO,
          reason: reason ?? null,
          metadata: { approverRoles: actorRoles },
        }),
      );

      const newCompleted = new Set([...completedOrders, currentStep.stepOrder]);
      const allDone = steps.every((s) => newCompleted.has(s.stepOrder));

      if (allDone) {
        await this.aprsRepository.update(
          { id: apr.id, company_id: apr.company_id },
          {
            status: AprStatus.APROVADA,
            aprovado_por_id: approverId,
            aprovado_em: new Date(),
            aprovado_motivo: reason ?? undefined,
          },
        );
      }
    } else if (action === ApprovalRecordAction.REPROVADO) {
      const lastApproved = history
        .filter((r) => r.action === ApprovalRecordAction.APROVADO)
        .pop();

      await this.approvalRecordRepo.save(
        this.approvalRecordRepo.create({
          aprId: apr.id,
          workflowConfigId: apr.workflowConfigId,
          stepOrder: currentStep?.stepOrder ?? lastApproved?.stepOrder ?? 0,
          roleName: primaryRole,
          approverId,
          action: ApprovalRecordAction.REPROVADO,
          reason: reason ?? null,
          metadata: { approverRoles: actorRoles },
        }),
      );

      await this.aprsRepository.update(
        { id: apr.id, company_id: apr.company_id },
        { status: AprStatus.PENDENTE },
      );
    } else if (action === ApprovalRecordAction.REABERTO) {
      const lastApproved = history
        .filter((r) => r.action === ApprovalRecordAction.APROVADO)
        .pop();

      if (!lastApproved) {
        throw new BadRequestException(
          'Não há passo aprovado anterior para reabrir.',
        );
      }

      await this.approvalRecordRepo.save(
        this.approvalRecordRepo.create({
          aprId: apr.id,
          workflowConfigId: apr.workflowConfigId,
          stepOrder: lastApproved.stepOrder,
          roleName: primaryRole,
          approverId,
          action: ApprovalRecordAction.REABERTO,
          reason: reason ?? null,
          metadata: {
            approverRoles: actorRoles,
            reopenedFromStep: lastApproved.stepOrder,
          },
        }),
      );

      await this.aprsRepository.update(
        { id: apr.id, company_id: apr.company_id },
        { status: AprStatus.PENDENTE },
      );
    }
  }

  private async loadWorkflowConfig(
    workflowConfigId: string,
  ): Promise<AprWorkflowConfig | null> {
    const repo = this.aprsRepository.manager.getRepository(AprWorkflowConfig);
    return repo.findOne({
      where: { id: workflowConfigId },
      relations: ['steps'],
    });
  }
}
