import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import { Role } from '../auth/enums/roles.enum';
import { AuditResult, Dds, DdsStatus } from './entities/dds.entity';
import {
  DdsApprovalAction,
  DdsApprovalRecord,
} from './entities/dds-approval-record.entity';
import { DdsService } from './dds.service';
import {
  DdsApprovalStepInputDto,
  InitializeDdsApprovalFlowDto,
} from './dto/dds-approval.dto';
import { User } from '../users/entities/user.entity';
import { SignaturesService } from '../signatures/signatures.service';
import { Signature } from '../signatures/entities/signature.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { NotificationsService } from '../notifications/notifications.service';
import { normalizeRoleName } from '../auth/role-normalization.util';

type ApprovalActorContext = {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  pin?: string | null;
};

type ApprovalStepState = {
  level_order: number;
  title: string;
  approver_role: string;
  status: DdsApprovalAction;
  pending_record_id: string | null;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  event_hash: string | null;
  actor_signature_id: string | null;
  actor_signature_hash: string | null;
  actor_signature_signed_at: Date | null;
  actor_signature_timestamp_authority: string | null;
};

type DdsApprovalFlow = {
  ddsId: string;
  companyId: string;
  activeCycle: number | null;
  status: 'not_started' | 'pending' | 'approved' | 'rejected' | 'canceled';
  currentStep: ApprovalStepState | null;
  steps: ApprovalStepState[];
  events: DdsApprovalRecord[];
};

const DEFAULT_DDS_APPROVAL_STEPS: DdsApprovalStepInputDto[] = [
  {
    title: 'Conferência técnica SST',
    approver_role: Role.TST,
  },
  {
    title: 'Validação da liderança operacional',
    approver_role: Role.SUPERVISOR,
  },
  {
    title: 'Aprovação administrativa da empresa',
    approver_role: Role.ADMIN_EMPRESA,
  },
];

@Injectable()
export class DdsApprovalService {
  private readonly logger = new Logger(DdsApprovalService.name);

  constructor(
    @InjectRepository(DdsApprovalRecord)
    private readonly approvalRepository: Repository<DdsApprovalRecord>,
    @InjectRepository(Dds)
    private readonly ddsRepository: Repository<Dds>,
    private readonly ddsService: DdsService,
    private readonly signaturesService: SignaturesService,
    private readonly tenantService: TenantService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getFlow(ddsId: string): Promise<DdsApprovalFlow> {
    const dds = await this.ddsService.findOne(ddsId);
    const events = await this.getEvents(dds);
    return this.buildFlow(dds, events);
  }

  async initializeFlow(
    ddsId: string,
    dto: InitializeDdsApprovalFlowDto = {},
    actor: ApprovalActorContext,
  ): Promise<DdsApprovalFlow> {
    const steps = this.normalizeSteps(dto.steps);
    await this.withApprovalWriteLock(
      ddsId,
      async ({ dds, approvals, users }) => {
        this.assertApprovalMutable(dds);
        await this.getActorOrThrow(users, actor.userId, dds.company_id);

        const events = await this.getEvents(dds, approvals);
        const currentFlow = this.buildFlow(dds, events);
        if (
          currentFlow.status === 'pending' ||
          currentFlow.status === 'approved' ||
          currentFlow.status === 'rejected'
        ) {
          throw new BadRequestException(
            'O DDS já possui um fluxo de aprovação ativo. Reabra o fluxo rejeitado ou consulte o histórico.',
          );
        }

        const nextCycle = (currentFlow.activeCycle ?? 0) + 1;
        for (const [index, step] of steps.entries()) {
          await this.appendEvent(
            approvals,
            dds,
            {
              cycle: nextCycle,
              level_order: index + 1,
              title: step.title,
              approver_role: step.approver_role,
              action: DdsApprovalAction.PENDING,
              actor,
            },
            'Não foi possível iniciar o fluxo de aprovação do DDS por concorrência simultânea.',
          );
        }
      },
    );

    return this.getFlow(ddsId);
  }

  async approveStep(
    ddsId: string,
    approvalRecordId: string,
    reason: string | undefined,
    actor: ApprovalActorContext,
  ): Promise<DdsApprovalFlow> {
    await this.withApprovalWriteLock(
      ddsId,
      async ({ dds, approvals, users, ddsRepository }) => {
        this.assertApprovalMutable(dds);
        const approvingActor = await this.getActorOrThrow(
          users,
          actor.userId,
          dds.company_id,
        );
        const pendingStep = await this.getPendingStepOrThrow(
          approvals,
          dds,
          approvalRecordId,
        );
        const flow = this.buildFlow(dds, await this.getEvents(dds, approvals));
        this.assertStepCanBeDecided(flow, pendingStep);
        this.assertActorCanDecide(approvingActor, pendingStep);
        const approvalSignature = await this.createApprovalSignature(
          dds,
          actor,
          approvals,
          {
            action: DdsApprovalAction.APPROVED,
            cycle: pendingStep.cycle,
            levelOrder: pendingStep.level_order,
            title: pendingStep.title,
            approverRole: pendingStep.approver_role,
            reason,
            approvalRecordId,
          },
        );

        await this.appendEvent(
          approvals,
          dds,
          {
            cycle: pendingStep.cycle,
            level_order: pendingStep.level_order,
            title: pendingStep.title,
            approver_role: pendingStep.approver_role,
            action: DdsApprovalAction.APPROVED,
            actor,
            reason,
            signature: approvalSignature,
          },
          'Esta etapa do DDS já recebeu uma decisão concorrente. Atualize a tela antes de tentar novamente.',
        );

        const latestFlow = this.buildFlow(
          dds,
          await this.getEvents(dds, approvals),
        );
        if (latestFlow.status === 'approved') {
          await ddsRepository.update(dds.id, {
            status: DdsStatus.AUDITADO,
            auditado_por_id: actor.userId,
            data_auditoria: new Date(),
            resultado_auditoria: AuditResult.CONFORME,
            notas_auditoria:
              reason?.trim() ||
              'Fluxo de aprovação DDS concluído sem ressalvas.',
          });
        }
      },
    );

    const flow = await this.getFlow(ddsId);

    // Notificar o próximo aprovador de forma assíncrona (fire-and-forget).
    // Erros de notificação nunca bloqueiam o fluxo de aprovação.
    void this.tryNotifyNextApprover(ddsId, flow);

    return flow;
  }

  /** Envia notificação in-app para usuários elegíveis a aprovar a próxima etapa. */
  private async tryNotifyNextApprover(
    ddsId: string,
    flow: DdsApprovalFlow,
  ): Promise<void> {
    if (flow.status !== 'pending' || !flow.currentStep) return;
    try {
      const companyId = this.tenantService.getTenantId();
      if (!companyId) return;

      const nextStep = flow.currentStep;
      await this.notificationsService.notifyEligibleApprovers({
        companyId,
        requiredRoleRaw: nextStep.approver_role,
        title: 'Aprovação de DDS pendente',
        message: `A etapa "${nextStep.title}" aguarda sua aprovação.`,
        data: { event: 'dds_approval_pending', ddsId },
        logContext: `DDS ddsId=${ddsId}`,
      });
    } catch (err) {
      this.logger.error(
        `tryNotifyNextApprover falhou para ddsId=${ddsId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async rejectStep(
    ddsId: string,
    approvalRecordId: string,
    reason: string | undefined,
    actor: ApprovalActorContext,
  ): Promise<DdsApprovalFlow> {
    const normalizedReason = String(reason || '').trim();
    if (normalizedReason.length < 10) {
      throw new BadRequestException(
        'Informe um motivo de reprovação com pelo menos 10 caracteres.',
      );
    }

    await this.withApprovalWriteLock(
      ddsId,
      async ({ dds, approvals, users }) => {
        this.assertApprovalMutable(dds);
        const rejectingActor = await this.getActorOrThrow(
          users,
          actor.userId,
          dds.company_id,
        );
        const pendingStep = await this.getPendingStepOrThrow(
          approvals,
          dds,
          approvalRecordId,
        );
        const flow = this.buildFlow(dds, await this.getEvents(dds, approvals));
        this.assertStepCanBeDecided(flow, pendingStep);
        this.assertActorCanDecide(rejectingActor, pendingStep);
        const rejectionSignature = await this.createApprovalSignature(
          dds,
          actor,
          approvals,
          {
            action: DdsApprovalAction.REJECTED,
            cycle: pendingStep.cycle,
            levelOrder: pendingStep.level_order,
            title: pendingStep.title,
            approverRole: pendingStep.approver_role,
            reason: normalizedReason,
            approvalRecordId,
          },
        );

        await this.appendEvent(
          approvals,
          dds,
          {
            cycle: pendingStep.cycle,
            level_order: pendingStep.level_order,
            title: pendingStep.title,
            approver_role: pendingStep.approver_role,
            action: DdsApprovalAction.REJECTED,
            actor,
            reason: normalizedReason,
            signature: rejectionSignature,
          },
          'Esta etapa do DDS já recebeu uma decisão concorrente. Atualize a tela antes de tentar novamente.',
        );
      },
    );

    return this.getFlow(ddsId);
  }

  async reopenFlow(
    ddsId: string,
    reason: string,
    actor: ApprovalActorContext,
  ): Promise<DdsApprovalFlow> {
    const normalizedReason = String(reason || '').trim();
    if (normalizedReason.length < 10) {
      throw new BadRequestException(
        'Informe um motivo de reabertura com pelo menos 10 caracteres.',
      );
    }
    await this.withApprovalWriteLock(
      ddsId,
      async ({ dds, approvals, users }) => {
        this.assertApprovalMutable(dds);
        await this.getActorOrThrow(users, actor.userId, dds.company_id);
        const currentFlow = this.buildFlow(
          dds,
          await this.getEvents(dds, approvals),
        );
        if (
          currentFlow.status !== 'rejected' ||
          currentFlow.activeCycle == null
        ) {
          throw new BadRequestException(
            'Somente fluxos de DDS reprovados podem ser reabertos por este endpoint.',
          );
        }
        const reopenSignature = await this.createApprovalSignature(
          dds,
          actor,
          approvals,
          {
            action: DdsApprovalAction.REOPENED,
            cycle: currentFlow.activeCycle,
            levelOrder: 0,
            title: 'Reabertura controlada',
            approverRole: 'Sistema',
            reason: normalizedReason,
          },
        );

        await this.appendEvent(
          approvals,
          dds,
          {
            cycle: currentFlow.activeCycle,
            level_order: 0,
            title: 'Reabertura controlada',
            approver_role: 'Sistema',
            action: DdsApprovalAction.REOPENED,
            actor,
            reason: normalizedReason,
            signature: reopenSignature,
          },
          'O fluxo de aprovação DDS já foi reaberto por outra operação concorrente.',
        );

        const nextCycle = currentFlow.activeCycle + 1;
        const steps = currentFlow.steps.map((step) => ({
          title: step.title,
          approver_role: step.approver_role,
        }));
        for (const [index, step] of steps.entries()) {
          await this.appendEvent(
            approvals,
            dds,
            {
              cycle: nextCycle,
              level_order: index + 1,
              title: step.title,
              approver_role: step.approver_role,
              action: DdsApprovalAction.PENDING,
              actor,
            },
            'O fluxo de aprovação DDS já foi reaberto por outra operação concorrente.',
          );
        }
      },
    );

    return this.getFlow(ddsId);
  }

  private async withApprovalWriteLock<T>(
    ddsId: string,
    callback: (resources: {
      dds: Dds;
      approvals: Repository<DdsApprovalRecord>;
      users: Repository<User>;
      ddsRepository: Repository<Dds>;
    }) => Promise<T>,
  ): Promise<T> {
    const companyId = this.tenantService.getTenantId();
    // SGS-DDS-SEC-011: falha fechada — contexto de empresa é obrigatório.
    if (!companyId) {
      throw new UnauthorizedException('Contexto de empresa não identificado para DDS.');
    }
    return this.ddsRepository.manager.transaction(async (manager) => {
      const ddsRepository = manager.getRepository(Dds);
      const approvals = manager.getRepository(DdsApprovalRecord);
      const users = manager.getRepository(User);
      const qb = ddsRepository
        .createQueryBuilder('dds')
        .setLock('pessimistic_write')
        .where('dds.id = :ddsId', { ddsId })
        .andWhere('dds.deleted_at IS NULL')
        .andWhere('dds.company_id = :companyId', { companyId });

      const dds = await qb.getOne();

      if (!dds) {
        throw new NotFoundException(`DDS com ID ${ddsId} não encontrado`);
      }

      return callback({
        dds,
        approvals,
        users,
        ddsRepository,
      });
    });
  }

  private normalizeSteps(
    steps?: DdsApprovalStepInputDto[],
  ): DdsApprovalStepInputDto[] {
    const normalized = (steps?.length ? steps : DEFAULT_DDS_APPROVAL_STEPS)
      .map((step) => ({
        title: String(step.title || '').trim(),
        approver_role: String(step.approver_role || '').trim(),
      }))
      .filter((step) => step.title && step.approver_role);

    if (normalized.length === 0 || normalized.length > 5) {
      throw new BadRequestException(
        'Informe entre 1 e 5 níveis de aprovação para o DDS.',
      );
    }

    const invalidStep = normalized.find(
      (step) => !normalizeRoleName(step.approver_role),
    );
    if (invalidStep) {
      throw new BadRequestException(
        `Perfil aprovador inválido para DDS: ${invalidStep.approver_role}. Use um perfil RBAC válido.`,
      );
    }

    return normalized;
  }

  private assertApprovalMutable(dds: Dds): void {
    if (dds.is_modelo) {
      throw new BadRequestException(
        'Modelos de DDS não podem iniciar fluxo de aprovação operacional.',
      );
    }
    if (dds.status === DdsStatus.RASCUNHO) {
      throw new BadRequestException(
        'Publique o DDS antes de iniciar o fluxo de aprovação.',
      );
    }
    if (dds.status === DdsStatus.AUDITADO) {
      throw new BadRequestException(
        'DDS auditado não pode ter novo fluxo de aprovação.',
      );
    }
    if (dds.status === DdsStatus.ARQUIVADO) {
      throw new BadRequestException(
        'DDS arquivado não pode ter fluxo de aprovação alterado.',
      );
    }
    if (dds.pdf_file_key) {
      throw new BadRequestException(
        'DDS com PDF final emitido não pode ter fluxo de aprovação alterado.',
      );
    }
  }

  private async getActorOrThrow(
    userRepository: Repository<User>,
    actorUserId: string,
    companyId: string,
  ): Promise<User> {
    const actor = await userRepository.findOne({
      where: {
        id: actorUserId,
        company_id: companyId,
        deletedAt: IsNull(),
      },
      relations: ['profile'],
    });
    if (!actor) {
      throw new BadRequestException(
        'Usuário aprovador não pertence à empresa atual do DDS.',
      );
    }

    return actor;
  }

  private assertActorCanDecide(
    actor: User,
    pendingStep: DdsApprovalRecord,
  ): void {
    const actorRole = normalizeRoleName(actor.profile?.nome);
    const requiredRole = normalizeRoleName(pendingStep.approver_role);

    if (actorRole === Role.ADMIN_GERAL) {
      return;
    }

    if (!actorRole || !requiredRole || actorRole !== requiredRole) {
      throw new ForbiddenException(
        `A etapa "${pendingStep.title}" exige aprovação do perfil "${pendingStep.approver_role}".`,
      );
    }
  }

  private async getPendingStepOrThrow(
    approvalRepository: Repository<DdsApprovalRecord>,
    dds: Dds,
    approvalRecordId: string,
  ): Promise<DdsApprovalRecord> {
    const pendingStep = await approvalRepository.findOne({
      where: {
        id: approvalRecordId,
        company_id: dds.company_id,
        dds_id: dds.id,
        action: DdsApprovalAction.PENDING,
      },
    });

    if (!pendingStep) {
      throw new NotFoundException(
        'Etapa de aprovação pendente não encontrada para este DDS.',
      );
    }

    return pendingStep;
  }

  private assertStepCanBeDecided(
    flow: DdsApprovalFlow,
    pendingStep: DdsApprovalRecord,
  ): void {
    if (flow.status === 'rejected') {
      throw new BadRequestException(
        'Fluxo de aprovação reprovado. Reabra o fluxo antes de nova decisão.',
      );
    }

    const currentStep = flow.currentStep;
    if (!currentStep || currentStep.pending_record_id !== pendingStep.id) {
      throw new BadRequestException(
        'A etapa informada não é a próxima etapa pendente do fluxo.',
      );
    }
  }

  private async getEvents(
    dds: Dds,
    approvalRepository: Repository<DdsApprovalRecord> = this.approvalRepository,
  ): Promise<DdsApprovalRecord[]> {
    return approvalRepository.find({
      where: {
        company_id: dds.company_id,
        dds_id: dds.id,
      },
      relations: ['actor'],
      order: {
        cycle: 'ASC',
        level_order: 'ASC',
        event_at: 'ASC',
        created_at: 'ASC',
      },
    });
  }

  private buildFlow(dds: Dds, events: DdsApprovalRecord[]): DdsApprovalFlow {
    if (events.length === 0) {
      return {
        ddsId: dds.id,
        companyId: dds.company_id,
        activeCycle: null,
        status: 'not_started',
        currentStep: null,
        steps: [],
        events,
      };
    }

    const activeCycle = Math.max(...events.map((event) => event.cycle));
    const cycleEvents = events.filter((event) => event.cycle === activeCycle);
    const levelOrders = Array.from(
      new Set(
        cycleEvents
          .map((event) => event.level_order)
          .filter((levelOrder) => levelOrder > 0),
      ),
    ).sort((first, second) => first - second);

    const steps = levelOrders.map((levelOrder) => {
      const levelEvents = cycleEvents.filter(
        (event) => event.level_order === levelOrder,
      );
      const pending = levelEvents.find(
        (event) => event.action === DdsApprovalAction.PENDING,
      );
      const latestDecision = [...levelEvents]
        .reverse()
        .find((event) =>
          [
            DdsApprovalAction.APPROVED,
            DdsApprovalAction.REJECTED,
            DdsApprovalAction.CANCELED,
          ].includes(event.action),
        );
      const latest = latestDecision || pending || levelEvents[0];
      return {
        level_order: levelOrder,
        title: latest.title,
        approver_role: latest.approver_role,
        status: latestDecision?.action || DdsApprovalAction.PENDING,
        pending_record_id:
          latestDecision?.action === DdsApprovalAction.APPROVED ||
          latestDecision?.action === DdsApprovalAction.REJECTED ||
          latestDecision?.action === DdsApprovalAction.CANCELED
            ? null
            : pending?.id || null,
        decided_by_user_id: latestDecision?.actor_user_id || null,
        decided_at: latestDecision?.event_at || null,
        decision_reason: latestDecision?.decision_reason || null,
        event_hash: latestDecision?.event_hash || pending?.event_hash || null,
        actor_signature_id: latestDecision?.actor_signature_id || null,
        actor_signature_hash: latestDecision?.actor_signature_hash || null,
        actor_signature_signed_at:
          latestDecision?.actor_signature_signed_at || null,
        actor_signature_timestamp_authority:
          latestDecision?.actor_signature_timestamp_authority || null,
      };
    });

    const rejected = steps.find(
      (step) => step.status === DdsApprovalAction.REJECTED,
    );
    const currentStep =
      steps.find((step) => step.status === DdsApprovalAction.PENDING) || null;
    const status = rejected
      ? 'rejected'
      : steps.length > 0 &&
          steps.every((step) => step.status === DdsApprovalAction.APPROVED)
        ? 'approved'
        : currentStep
          ? 'pending'
          : 'canceled';

    return {
      ddsId: dds.id,
      companyId: dds.company_id,
      activeCycle,
      status,
      currentStep,
      steps,
      events,
    };
  }

  private async appendEvent(
    approvalRepository: Repository<DdsApprovalRecord>,
    dds: Dds,
    input: {
      cycle: number;
      level_order: number;
      title: string;
      approver_role: string;
      action: DdsApprovalAction;
      actor: ApprovalActorContext;
      reason?: string | null;
      signature?: Signature | null;
    },
    duplicateConflictMessage: string,
  ): Promise<DdsApprovalRecord> {
    const latest = await approvalRepository.findOne({
      where: {
        company_id: dds.company_id,
        dds_id: dds.id,
      },
      order: {
        event_at: 'DESC',
        created_at: 'DESC',
      },
    });
    const eventAt = new Date();
    const previousHash = latest?.event_hash || null;
    const reason = input.reason?.trim() || null;
    const decidedIp = input.actor.ip?.slice(0, 64) || null;
    const decidedUserAgent = input.actor.userAgent?.slice(0, 2000) || null;
    const actorSignatureId = input.signature?.id || null;
    const actorSignatureHash = input.signature?.signature_hash || null;
    const actorSignatureSignedAt = input.signature?.signed_at || null;
    const actorSignatureTimestampAuthority =
      input.signature?.timestamp_authority || null;
    const hashPayload = {
      company_id: dds.company_id,
      dds_id: dds.id,
      cycle: input.cycle,
      level_order: input.level_order,
      title: input.title,
      approver_role: input.approver_role,
      action: input.action,
      actor_user_id: input.actor.userId,
      decision_reason: reason,
      decided_ip: decidedIp,
      decided_user_agent: decidedUserAgent,
      actor_signature_id: actorSignatureId,
      actor_signature_hash: actorSignatureHash,
      actor_signature_signed_at: actorSignatureSignedAt?.toISOString() || null,
      actor_signature_timestamp_authority: actorSignatureTimestampAuthority,
      event_at: eventAt.toISOString(),
      previous_event_hash: previousHash,
    };

    const record = approvalRepository.create({
      company_id: dds.company_id,
      dds_id: dds.id,
      cycle: input.cycle,
      level_order: input.level_order,
      title: input.title,
      approver_role: input.approver_role,
      action: input.action,
      actor_user_id: input.actor.userId,
      actor_signature_id: actorSignatureId,
      actor_signature_hash: actorSignatureHash,
      actor_signature_signed_at: actorSignatureSignedAt,
      actor_signature_timestamp_authority: actorSignatureTimestampAuthority,
      decision_reason: reason,
      decided_ip: decidedIp,
      decided_user_agent: decidedUserAgent,
      event_at: eventAt,
      previous_event_hash: previousHash,
      event_hash: createHash('sha256')
        .update(JSON.stringify(hashPayload))
        .digest('hex'),
    });

    try {
      return await approvalRepository.save(record);
    } catch (error) {
      if (this.isApprovalConflictError(error)) {
        throw new ConflictException(duplicateConflictMessage);
      }
      throw error;
    }
  }

  private async createApprovalSignature(
    dds: Dds,
    actor: ApprovalActorContext,
    approvalRepository: Repository<DdsApprovalRecord>,
    input: {
      action: DdsApprovalAction;
      cycle: number;
      levelOrder: number;
      title: string;
      approverRole: string;
      reason?: string | undefined;
      approvalRecordId?: string;
    },
  ): Promise<Signature> {
    const normalizedPin = String(actor.pin || '').trim();
    if (!/^\d{4,6}$/.test(normalizedPin)) {
      throw new BadRequestException(
        'PIN obrigatório com 4 a 6 dígitos para assinar decisões do fluxo DDS.',
      );
    }

    return this.signaturesService.createWithManager(
      {
        document_id: dds.id,
        document_type: 'DDS',
        user_id: actor.userId,
        company_id: dds.company_id,
        type: 'hmac',
        signature_data: 'HMAC_PENDING',
        pin: normalizedPin,
        integrity_context: {
          scope: 'dds_approval_flow',
          approval_action: input.action,
          approval_cycle: input.cycle,
          approval_level_order: input.levelOrder,
          approval_title: input.title,
          approver_role: input.approverRole,
          approval_reason: input.reason?.trim() || null,
          approval_record_id: input.approvalRecordId || null,
        },
      },
      actor.userId,
      approvalRepository.manager,
      actor.userId,
    );
  }

  private isApprovalConflictError(error: unknown): boolean {
    if (error instanceof QueryFailedError) {
      const driverError = (
        error as QueryFailedError & { driverError?: unknown }
      ).driverError as
        | {
            code?: string;
            constraint?: string;
            detail?: string;
          }
        | undefined;

      if (driverError?.code === '23505') {
        const constraint = String(
          driverError.constraint || driverError.detail || '',
        ).toLowerCase();
        return (
          constraint.includes('idx_dds_approval_records_pending_unique') ||
          constraint.includes('idx_dds_approval_records_decision_unique') ||
          constraint.includes('idx_dds_approval_records_hash')
        );
      }
    }

    const message =
      error instanceof Error
        ? error.message.toLowerCase()
        : typeof error === 'string'
          ? error.toLowerCase()
          : '';

    return (
      message.includes('idx_dds_approval_records_pending_unique') ||
      message.includes('idx_dds_approval_records_decision_unique') ||
      message.includes('idx_dds_approval_records_hash') ||
      message.includes('duplicate key')
    );
  }
}
