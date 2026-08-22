import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { Dds, DdsStatus } from './entities/dds.entity';
import { DdsSignatureInvite } from './entities/dds-signature-invite.entity';
import { IssueDdsSignatureInvitesDto } from './dto/dds-signature-invite.dto';
import { MailService } from '../../infra/mail/mail.service';
import { TurnstileService } from '../auth/turnstile.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import {
  signValidationToken,
  verifyValidationToken,
} from '../../shared/security/validation-token.util';
import { User } from '../users/entities/user.entity';
import { Signature } from '../signatures/entities/signature.entity';
import { SignaturesService } from '../signatures/signatures.service';

const DDS_PUBLIC_SIGNATURE_PORTAL = 'dds_public_signature';
const DEFAULT_INVITE_TTL_DAYS = 7;
const MAX_INVITE_TTL_DAYS = 30;
const SIGNATURE_DATA_MAX_LENGTH = 300_000;
const INVITE_EMAIL_FROM_NAME = 'SGS — Sistema de Gestão de Segurança';

type DdsSignatureInviteStatus = 'pending' | 'signed' | 'expired' | 'revoked';

export type DdsSignatureInviteLink = {
  inviteId: string | null;
  participantUserId: string;
  participantName: string;
  participantRole: string | null;
  status: DdsSignatureInviteStatus;
  expiresAt: string | null;
  signedAt: string | null;
  signingPath: string | null;
  signingUrl: string | null;
};

export type DdsSignatureInviteIssueResult = {
  ddsId: string;
  expiresAt: string | null;
  invites: DdsSignatureInviteLink[];
};

export type PublicDdsSignatureContext = {
  inviteId: string;
  status: 'pending' | 'signed';
  expiresAt: string;
  signedAt: string | null;
  signer: {
    name: string;
    role: string | null;
  };
  dds: {
    id: string;
    tema: string;
    data: string | null;
    status: DdsStatus;
    companyName: string | null;
    siteName: string | null;
    facilitatorName: string | null;
    version: number;
  };
};

export type PublicDdsSignatureSubmitResult = {
  signed: true;
  signatureId: string;
  signatureHash: string | null;
  signedAt: string | null;
};

@Injectable()
export class DdsSignatureInviteService implements OnModuleInit {
  private readonly logger = new Logger(DdsSignatureInviteService.name);

  constructor(
    @InjectRepository(DdsSignatureInvite)
    private readonly inviteRepository: Repository<DdsSignatureInvite>,
    @InjectRepository(Dds)
    private readonly ddsRepository: Repository<Dds>,
    private readonly tenantService: TenantService,
    private readonly signaturesService: SignaturesService,
    private readonly mailService: MailService,
    private readonly turnstileService: TurnstileService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const frontendUrl = this.resolveFrontendBaseUrl();
    if (!frontendUrl) {
      this.logger.warn(
        'FRONTEND_URL (ou NEXT_PUBLIC_APP_URL / APP_URL) não está configurado. ' +
          'Links de assinatura DDS serão gerados sem URL absoluta (signingUrl = null). ' +
          'Defina FRONTEND_URL no ambiente para que os emails incluam links clicáveis.',
      );
    }
  }

  async issueInvites(
    ddsId: string,
    dto: IssueDdsSignatureInvitesDto,
    createdByUserId: string,
  ): Promise<DdsSignatureInviteIssueResult> {
    const scope = this.getSiteAccessScopeOrThrow();
    const dds = await this.findDdsForInviteManagement(ddsId, scope.companyId);
    this.assertDdsCanReceivePublicSignatureInvites(dds);
    this.assertDdsSiteAllowed(dds.site_id, scope);

    const participants = this.resolveInviteParticipants(
      dds,
      dto.participant_user_ids,
    );
    const participantIds = participants.map((participant) => participant.id);
    const existingSignatures = await this.findParticipantSignatures(
      dds.id,
      dds.company_id,
      participantIds,
    );
    const existingSignatureByUser = new Map(
      existingSignatures.map((signature) => [signature.user_id, signature]),
    );
    const pendingParticipants = participants.filter(
      (participant) => !existingSignatureByUser.has(participant.id),
    );
    const expiresAt = this.resolveExpiresAt(dto.expires_in_days);

    const createdInvites = new Map<string, DdsSignatureInviteLink>();
    await this.inviteRepository.manager.transaction(async (manager) => {
      if (pendingParticipants.length === 0) {
        return;
      }

      await manager.getRepository(DdsSignatureInvite).update(
        {
          company_id: dds.company_id,
          dds_id: dds.id,
          participant_user_id: In(
            pendingParticipants.map((participant) => participant.id),
          ),
          used_at: IsNull(),
          revoked_at: IsNull(),
        },
        {
          revoked_at: new Date(),
          updated_at: new Date(),
        },
      );

      for (const participant of pendingParticipants) {
        const inviteId = randomUUID();
        const token = this.signInviteToken({
          inviteId,
          companyId: dds.company_id,
          ddsId: dds.id,
          ttlSeconds: this.secondsUntil(expiresAt),
        });
        const invite = manager.getRepository(DdsSignatureInvite).create({
          id: inviteId,
          company_id: dds.company_id,
          dds_id: dds.id,
          participant_user_id: participant.id,
          created_by_user_id: createdByUserId,
          signed_signature_id: null,
          token_hash: this.hashToken(token),
          dds_version: dds.version,
          expires_at: expiresAt,
          revoked_at: null,
          used_at: null,
          last_viewed_at: null,
          signed_ip_hash: null,
          signed_user_agent_hash: null,
        });
        const saved = await manager
          .getRepository(DdsSignatureInvite)
          .save(invite);
        createdInvites.set(
          participant.id,
          this.toInviteLink({
            invite: saved,
            participant,
            token,
            status: 'pending',
            signedAt: null,
          }),
        );
      }
    });

    for (const [participantId, link] of createdInvites.entries()) {
      const participant = participants.find((p) => p.id === participantId);
      if (!participant) continue;
      const email = participant.email;
      if (!email) continue;

      const subject = `Convite para assinar DDS: ${dds.tema}`;
      const plainText =
        `Olá ${participant.nome || 'participante'},\n\n` +
        `Você recebeu um convite para assinar o DDS "${dds.tema}".\n` +
        `Acesse o link abaixo para registrar sua assinatura:\n\n` +
        `${link.signingUrl ?? link.signingPath ?? '(link indisponível)'}\n\n` +
        `Este convite expira em ${expiresAt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' })}.\n\n` +
        `Att,\nEquipe SGS`;
      try {
        await this.mailService.sendMailSimple(
          email,
          subject,
          plainText,
          { companyId: dds.company_id, userId: createdByUserId },
          undefined,
          {
            html: this.buildInviteEmailHtml({
              participantName: participant.nome,
              ddsTema: dds.tema,
              ddsData: this.toDateString(dds.data),
              companyName: dds.company?.razao_social ?? null,
              siteName: dds.site?.nome ?? null,
              facilitadorName: dds.facilitador?.nome ?? null,
              signingUrl: link.signingUrl ?? link.signingPath ?? null,
              expiresAt,
            }),
            filename: 'convite-assinatura-dds',
          },
        );
        this.logger.log({
          event: 'dds_signature_invite_email_sent',
          ddsId: dds.id,
          companyId: dds.company_id,
          participantUserId: participant.id,
          inviteId: link.inviteId,
        });
      } catch (e) {
        this.logger.error(
          {
            event: 'dds_signature_invite_email_failed',
            ddsId: dds.id,
            companyId: dds.company_id,
            participantUserId: participant.id,
            inviteId: link.inviteId,
            error: e instanceof Error ? e.message : String(e),
          },
          e instanceof Error ? e.stack : undefined,
        );
      }
    }

    const invites = participants.map((participant) => {
      const existingSignature = existingSignatureByUser.get(participant.id);
      if (existingSignature) {
        return this.toInviteLink({
          invite: null,
          participant,
          token: null,
          status: 'signed',
          signedAt: existingSignature.signed_at ?? existingSignature.created_at,
        });
      }

      const created = createdInvites.get(participant.id);
      if (!created) {
        throw new ConflictException(
          'Não foi possível gerar o convite de assinatura para um participante.',
        );
      }
      return created;
    });

    this.logger.log({
      event: 'dds_signature_invites_issued',
      ddsId: dds.id,
      companyId: dds.company_id,
      generated: createdInvites.size,
      alreadySigned: existingSignatureByUser.size,
    });

    return {
      ddsId: dds.id,
      expiresAt: expiresAt.toISOString(),
      invites,
    };
  }

  async listInvites(ddsId: string): Promise<DdsSignatureInviteLink[]> {
    const scope = this.getSiteAccessScopeOrThrow();
    const dds = await this.findDdsForInviteManagement(ddsId, scope.companyId);
    this.assertDdsSiteAllowed(dds.site_id, scope);
    const participants = dds.participants ?? [];
    const participantIds = participants.map((participant) => participant.id);
    const signatures = await this.findParticipantSignatures(
      dds.id,
      dds.company_id,
      participantIds,
    );
    const signaturesByUser = new Map(
      signatures.map((signature) => [signature.user_id, signature]),
    );
    const latestInvites = await this.findLatestInvitesByParticipant(
      dds.id,
      dds.company_id,
      participantIds,
    );

    return participants.map((participant) => {
      const signature = signaturesByUser.get(participant.id);
      if (signature) {
        return this.toInviteLink({
          invite: latestInvites.get(participant.id) ?? null,
          participant,
          token: null,
          status: 'signed',
          signedAt: signature.signed_at ?? signature.created_at,
        });
      }

      const invite = latestInvites.get(participant.id) ?? null;
      return this.toInviteLink({
        invite,
        participant,
        token: null,
        status: this.resolveInviteStatus(invite),
        signedAt: null,
      });
    });
  }

  async getPublicContext(token: string): Promise<PublicDdsSignatureContext> {
    const payload = this.verifyInviteTokenPayload(token);
    const tokenHash = this.hashToken(token);

    return this.tenantService.run(
      { companyId: payload.companyId, isSuperAdmin: false, siteScope: 'all' },
      async () => {
        const invite = await this.loadInviteForToken({
          inviteId: payload.jti,
          companyId: payload.companyId,
          ddsId: payload.code,
          tokenHash,
          lock: false,
        });
        this.assertInviteUsable(invite, { allowUsed: true });
        if (!invite.used_at) {
          invite.last_viewed_at = new Date();
          invite.updated_at = new Date();
          await this.inviteRepository.save(invite);
        }
        const existingSignature = await this.findExistingParticipantSignature(
          invite.dds_id,
          invite.company_id,
          invite.participant_user_id,
        );
        return this.toPublicContext(
          invite,
          existingSignature ? 'signed' : 'pending',
          existingSignature?.signed_at ?? existingSignature?.created_at ?? null,
        );
      },
    );
  }

  async submitPublicSignature(
    token: string,
    input: {
      acceptedTerms: boolean;
      signatureData: string;
      turnstileToken?: string | null;
      ip?: string | null;
      userAgent?: string | null;
    },
  ): Promise<PublicDdsSignatureSubmitResult> {
    if (!input.acceptedTerms) {
      throw new BadRequestException(
        'Confirme a ciência antes de registrar a assinatura.',
      );
    }
    this.assertPublicSignatureData(input.signatureData);

    // Em produção (REQUIRE_TURNSTILE=true), o token Turnstile é obrigatório antes
    // de qualquer validação do convite — protege o portal público contra bots.
    const requireTurnstile =
      this.configService.get<string>('REQUIRE_TURNSTILE', 'false') === 'true';
    if (requireTurnstile && !input.turnstileToken) {
      throw new BadRequestException(
        'Verificação de segurança Turnstile obrigatória neste ambiente. Por favor, recarregue a página e tente novamente.',
      );
    }
    await this.turnstileService.assertHuman(input.turnstileToken ?? undefined, {
      remoteIp: input.ip,
      expectedAction: 'dds-signing',
    });

    const payload = this.verifyInviteTokenPayload(token);
    const tokenHash = this.hashToken(token);

    return this.tenantService.run(
      { companyId: payload.companyId, isSuperAdmin: false, siteScope: 'all' },
      () =>
        this.inviteRepository.manager.transaction(async (manager) => {
          const invite = await this.loadInviteForToken({
            manager,
            inviteId: payload.jti,
            companyId: payload.companyId,
            ddsId: payload.code,
            tokenHash,
            lock: true,
          });
          this.assertInviteUsable(invite);
          await this.assertParticipantStillBelongsToDds(invite, manager);

          const existingSignature =
            await this.findExistingParticipantSignatureWithManager(
              invite.dds_id,
              invite.company_id,
              invite.participant_user_id,
              manager,
            );
          if (existingSignature) {
            invite.used_at =
              existingSignature.signed_at ?? existingSignature.created_at;
            invite.signed_signature_id = existingSignature.id;
            invite.updated_at = new Date();
            await manager.getRepository(DdsSignatureInvite).save(invite);
            return {
              signed: true as const,
              signatureId: existingSignature.id,
              signatureHash: existingSignature.signature_hash ?? null,
              signedAt:
                existingSignature.signed_at?.toISOString() ??
                existingSignature.created_at.toISOString(),
            };
          }

          const signedAt = new Date();
          const signature = await this.signaturesService.createWithManager(
            {
              user_id: invite.participant_user_id,
              signer_user_id: invite.participant_user_id,
              document_id: invite.dds_id,
              document_type: 'DDS',
              signature_data: input.signatureData,
              type: 'digital',
              company_id: invite.company_id,
              integrity_context: {
                channel: 'dds_public_signature_link',
                invite_id: invite.id,
                dds_version: invite.dds_version,
                accepted_terms_at: signedAt.toISOString(),
                request_ip_hash: this.hashNullable(input.ip),
                request_user_agent_hash: this.hashNullable(input.userAgent),
              },
            },
            invite.participant_user_id,
            manager,
            invite.participant_user_id,
          );

          invite.used_at = signedAt;
          invite.signed_signature_id = signature.id;
          invite.signed_ip_hash = this.hashNullable(input.ip);
          invite.signed_user_agent_hash = this.hashNullable(input.userAgent);
          invite.updated_at = new Date();
          await manager.getRepository(DdsSignatureInvite).save(invite);

          this.logger.log({
            event: 'dds_public_signature_recorded',
            ddsId: invite.dds_id,
            companyId: invite.company_id,
            inviteId: invite.id,
            participantUserId: invite.participant_user_id,
            signatureId: signature.id,
          });

          return {
            signed: true as const,
            signatureId: signature.id,
            signatureHash: signature.signature_hash ?? null,
            signedAt:
              signature.signed_at?.toISOString() ?? signedAt.toISOString(),
          };
        }),
    );
  }

  private getSiteAccessScopeOrThrow() {
    if (
      !this.tenantService.getContext?.() &&
      !this.tenantService.getTenantId()
    ) {
      throw new UnauthorizedException(
        'Contexto de empresa não identificado para DDS.',
      );
    }

    return resolveSiteAccessScopeFromTenantService(this.tenantService, 'DDS', {
      allowMissingSiteScope: true,
    });
  }

  private async findDdsForInviteManagement(
    ddsId: string,
    companyId: string,
  ): Promise<Dds> {
    const dds = await this.ddsRepository.findOne({
      where: {
        id: ddsId,
        company_id: companyId,
        deleted_at: IsNull(),
      },
      relations: ['participants', 'site', 'company', 'facilitador'],
    });

    if (!dds) {
      throw new NotFoundException('DDS não encontrado.');
    }
    return dds;
  }

  private assertDdsCanReceivePublicSignatureInvites(dds: Dds): void {
    if (dds.is_modelo) {
      throw new BadRequestException(
        'Modelos de DDS não recebem link público de assinatura.',
      );
    }
    if (dds.pdf_file_key) {
      throw new BadRequestException(
        'DDS com PDF final emitido está bloqueado para novas assinaturas.',
      );
    }
    // SGS-DDS-INT-008: AUDITADO também deve bloquear novos convites — alinha com
    // assertWorkflowMutable no caminho autenticado.
    if (dds.status === DdsStatus.AUDITADO || dds.status === DdsStatus.ARQUIVADO) {
      throw new BadRequestException(
        'DDS auditado ou arquivado não recebe link público de assinatura.',
      );
    }
  }

  private assertDdsSiteAllowed(
    siteId: string | null | undefined,
    scope: ReturnType<DdsSignatureInviteService['getSiteAccessScopeOrThrow']>,
  ): void {
    if (
      !scope.hasCompanyWideAccess &&
      (!siteId || !scope.siteIds.includes(siteId))
    ) {
      throw new ForbiddenException(
        'DDS fora do escopo de obra do usuário atual.',
      );
    }
  }

  private resolveInviteParticipants(
    dds: Dds,
    requestedParticipantIds?: string[],
  ): User[] {
    const participants = dds.participants ?? [];
    if (participants.length === 0) {
      throw new BadRequestException(
        'O DDS precisa ter participantes definidos antes de gerar links de assinatura.',
      );
    }

    if (!requestedParticipantIds || requestedParticipantIds.length === 0) {
      return participants;
    }

    const participantById = new Map(
      participants.map((participant) => [participant.id, participant]),
    );
    const uniqueRequestedIds = Array.from(new Set(requestedParticipantIds));
    const invalidParticipant = uniqueRequestedIds.find(
      (participantId) => !participantById.has(participantId),
    );
    if (invalidParticipant) {
      throw new BadRequestException(
        'Um dos participantes informados não pertence a este DDS.',
      );
    }

    return uniqueRequestedIds.map(
      (participantId) => participantById.get(participantId) as User,
    );
  }

  private resolveExpiresAt(expiresInDays?: number): Date {
    const envDays = this.configService.get<string>(
      'DDS_SIGNATURE_INVITE_TTL_DAYS',
    );
    const configuredDays = Number(expiresInDays ?? envDays);
    const ttlDays =
      Number.isFinite(configuredDays) && configuredDays > 0
        ? Math.min(Math.floor(configuredDays), MAX_INVITE_TTL_DAYS)
        : DEFAULT_INVITE_TTL_DAYS;

    return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  }

  private secondsUntil(expiresAt: Date): number {
    return Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  }

  private signInviteToken(input: {
    inviteId: string;
    companyId: string;
    ddsId: string;
    ttlSeconds: number;
  }): string {
    return signValidationToken(
      {
        jti: input.inviteId,
        code: input.ddsId,
        companyId: input.companyId,
        portal: DDS_PUBLIC_SIGNATURE_PORTAL,
      },
      { expiresIn: input.ttlSeconds },
    );
  }

  private verifyInviteTokenPayload(token: string) {
    try {
      const payload = verifyValidationToken(token);
      if (payload.portal !== DDS_PUBLIC_SIGNATURE_PORTAL) {
        throw new Error('portal inválido');
      }
      return payload;
    } catch {
      throw new ForbiddenException('Link de assinatura inválido ou expirado.');
    }
  }

  private async resolveInviteByToken(
    token: string,
    options: { lock: boolean; touchLastViewed: boolean },
  ): Promise<{ invite: DdsSignatureInvite }> {
    const payload = this.verifyInviteTokenPayload(token);
    const tokenHash = this.hashToken(token);
    return this.tenantService.run(
      { companyId: payload.companyId, isSuperAdmin: false, siteScope: 'all' },
      async () => {
        const invite = await this.loadInviteForToken({
          inviteId: payload.jti,
          companyId: payload.companyId,
          ddsId: payload.code,
          tokenHash,
          lock: options.lock,
        });
        this.assertInviteUsable(invite, { allowUsed: true });
        if (options.touchLastViewed && !invite.used_at) {
          invite.last_viewed_at = new Date();
          invite.updated_at = new Date();
          await this.inviteRepository.save(invite);
        }
        return { invite };
      },
    );
  }

  private async loadInviteForToken(input: {
    manager?: EntityManager;
    inviteId: string;
    companyId: string;
    ddsId: string;
    tokenHash: string;
    lock: boolean;
  }): Promise<DdsSignatureInvite> {
    const repository =
      input.manager?.getRepository(DdsSignatureInvite) ?? this.inviteRepository;
    const query = repository
      .createQueryBuilder('invite')
      .leftJoinAndSelect('invite.dds', 'dds')
      .leftJoinAndSelect('dds.site', 'site')
      .leftJoinAndSelect('dds.company', 'company')
      .leftJoinAndSelect('dds.facilitador', 'facilitador')
      .leftJoinAndSelect('invite.participant', 'participant')
      .where('invite.id = :inviteId', { inviteId: input.inviteId })
      .andWhere('invite.company_id = :companyId', {
        companyId: input.companyId,
      })
      .andWhere('invite.dds_id = :ddsId', { ddsId: input.ddsId })
      .andWhere('invite.token_hash = :tokenHash', {
        tokenHash: input.tokenHash,
      })
      .andWhere('dds.deleted_at IS NULL');

    if (input.lock) {
      // Lock only the invite row. Without specifying tables TypeORM emits
      // "FOR UPDATE" without "OF", which PostgreSQL rejects when any
      // nullable side of a LEFT JOIN is present in the query.
      query.setLock('pessimistic_write', undefined, ['invite']);
    }

    const invite = await query.getOne();
    if (!invite || !invite.dds || !invite.participant) {
      throw new ForbiddenException('Link de assinatura inválido ou expirado.');
    }

    return invite;
  }

  private assertInviteUsable(
    invite: DdsSignatureInvite,
    options?: { allowUsed?: boolean },
  ): void {
    if (invite.revoked_at) {
      throw new GoneException('Link de assinatura revogado.');
    }
    if (invite.expires_at.getTime() <= Date.now()) {
      throw new GoneException('Link de assinatura expirado.');
    }
    if (!options?.allowUsed && invite.used_at) {
      throw new ConflictException('Este DDS já foi assinado por este link.');
    }
    if (invite.dds.is_modelo || invite.dds.pdf_file_key) {
      throw new GoneException(
        'DDS indisponível para assinatura por este link.',
      );
    }
    // SGS-DDS-INT-008: bloquear uso do convite em DDS auditado ou arquivado.
    if (
      invite.dds.status === DdsStatus.AUDITADO ||
      invite.dds.status === DdsStatus.ARQUIVADO
    ) {
      throw new GoneException('DDS auditado ou arquivado não aceita novas assinaturas por link público.');
    }
    if (invite.dds.version !== invite.dds_version) {
      throw new GoneException(
        'Link de assinatura invalidado porque o DDS foi alterado.',
      );
    }
  }

  private async assertParticipantStillBelongsToDds(
    invite: DdsSignatureInvite,
    manager: EntityManager,
  ): Promise<void> {
    const rows = await manager.query<Array<Record<string, unknown>>>(
      `
      SELECT 1
      FROM "dds_participants" participant
      INNER JOIN "dds" dds ON dds."id" = participant."dds_id"
      WHERE participant."dds_id" = $1
        AND participant."user_id" = $2
        AND dds."company_id" = $3
        AND dds."deleted_at" IS NULL
      LIMIT 1
      `,
      [invite.dds_id, invite.participant_user_id, invite.company_id],
    );

    if (rows.length === 0) {
      throw new GoneException(
        'Participante não pertence mais a este DDS. Solicite um novo link.',
      );
    }
  }

  private async findParticipantSignatures(
    ddsId: string,
    companyId: string,
    participantIds: string[],
  ): Promise<Signature[]> {
    if (participantIds.length === 0) {
      return [];
    }
    const signatures = await this.signaturesService.findByDocument(
      ddsId,
      'DDS',
    );
    return signatures.filter(
      (signature) =>
        signature.company_id === companyId &&
        participantIds.includes(signature.user_id) &&
        !this.isDdsTeamPhotoSignature(signature.type),
    );
  }

  private async findExistingParticipantSignature(
    ddsId: string,
    companyId: string,
    participantUserId: string,
  ): Promise<Signature | null> {
    const signatures = await this.signaturesService.findByDocument(
      ddsId,
      'DDS',
    );
    return (
      signatures.find(
        (signature) =>
          signature.company_id === companyId &&
          signature.user_id === participantUserId &&
          !this.isDdsTeamPhotoSignature(signature.type),
      ) ?? null
    );
  }

  private async findExistingParticipantSignatureWithManager(
    ddsId: string,
    companyId: string,
    participantUserId: string,
    manager: EntityManager,
  ): Promise<Signature | null> {
    const signatures = await manager.getRepository(Signature).find({
      where: {
        document_id: ddsId,
        document_type: 'DDS',
        company_id: companyId,
        user_id: participantUserId,
      },
      order: {
        created_at: 'DESC',
      },
    });

    return (
      signatures.find(
        (signature) => !this.isDdsTeamPhotoSignature(signature.type),
      ) ?? null
    );
  }

  private async findLatestInvitesByParticipant(
    ddsId: string,
    companyId: string,
    participantIds: string[],
  ): Promise<Map<string, DdsSignatureInvite>> {
    if (participantIds.length === 0) {
      return new Map();
    }
    const invites = await this.inviteRepository.find({
      where: {
        company_id: companyId,
        dds_id: ddsId,
        participant_user_id: In(participantIds),
      },
      order: {
        created_at: 'DESC',
      },
    });

    const latestByParticipant = new Map<string, DdsSignatureInvite>();
    for (const invite of invites) {
      if (!latestByParticipant.has(invite.participant_user_id)) {
        latestByParticipant.set(invite.participant_user_id, invite);
      }
    }
    return latestByParticipant;
  }

  private resolveInviteStatus(
    invite: DdsSignatureInvite | null,
  ): DdsSignatureInviteStatus {
    if (!invite) {
      return 'pending';
    }
    if (invite.used_at) {
      return 'signed';
    }
    if (invite.revoked_at) {
      return 'revoked';
    }
    if (invite.expires_at.getTime() <= Date.now()) {
      return 'expired';
    }
    return 'pending';
  }

  private toInviteLink(input: {
    invite: DdsSignatureInvite | null;
    participant: User;
    token: string | null;
    status: DdsSignatureInviteStatus;
    signedAt: Date | null;
  }): DdsSignatureInviteLink {
    const signingPath = input.token
      ? `/assinar/dds/${encodeURIComponent(input.token)}`
      : null;
    return {
      inviteId: input.invite?.id ?? null,
      participantUserId: input.participant.id,
      participantName: input.participant.nome,
      participantRole: input.participant.funcao ?? null,
      status: input.status,
      expiresAt: input.invite?.expires_at.toISOString() ?? null,
      signedAt: input.signedAt?.toISOString() ?? null,
      signingPath,
      signingUrl: signingPath
        ? this.resolvePublicSigningUrl(signingPath)
        : null,
    };
  }

  private toPublicContext(
    invite: DdsSignatureInvite,
    status: 'pending' | 'signed',
    signedAt: Date | null,
  ): PublicDdsSignatureContext {
    return {
      inviteId: invite.id,
      status,
      expiresAt: invite.expires_at.toISOString(),
      signedAt:
        signedAt?.toISOString() ?? invite.used_at?.toISOString() ?? null,
      signer: {
        name: invite.participant.nome,
        role: invite.participant.funcao ?? null,
      },
      dds: {
        id: invite.dds.id,
        tema: invite.dds.tema,
        data: this.toDateString(invite.dds.data),
        status: invite.dds.status,
        companyName: invite.dds.company?.razao_social ?? null,
        siteName: invite.dds.site?.nome ?? null,
        facilitatorName: invite.dds.facilitador?.nome ?? null,
        version: invite.dds.version,
      },
    };
  }

  private assertPublicSignatureData(signatureData: string): void {
    const trimmed = String(signatureData || '').trim();
    if (!trimmed) {
      throw new BadRequestException('Assinatura ausente.');
    }
    if (trimmed.length > SIGNATURE_DATA_MAX_LENGTH) {
      throw new BadRequestException('Assinatura excede o tamanho permitido.');
    }
    if (!trimmed.startsWith('data:image/png;base64,')) {
      throw new BadRequestException(
        'Assinatura pública deve ser uma imagem PNG em base64.',
      );
    }
  }

  private isDdsTeamPhotoSignature(type: string): boolean {
    return (
      type.startsWith('team_photo') || type === 'team_photo_reuse_justification'
    );
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private hashNullable(value?: string | null): string | null {
    const normalized = String(value || '').trim();
    if (!normalized) {
      return null;
    }
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  private resolveFrontendBaseUrl(): string | null {
    const raw =
      this.configService.get<string>('FRONTEND_URL')?.trim() ||
      this.configService.get<string>('NEXT_PUBLIC_APP_URL')?.trim() ||
      this.configService.get<string>('APP_URL')?.trim() ||
      '';
    return raw || null;
  }

  private resolvePublicSigningUrl(path: string): string | null {
    const rawBase = this.resolveFrontendBaseUrl();
    if (!rawBase) {
      return null;
    }

    try {
      const base = new URL(rawBase);
      return new URL(path, base).toString();
    } catch {
      return null;
    }
  }

  async revokeInviteById(
    ddsId: string,
    inviteId: string,
  ): Promise<{ inviteId: string; revokedAt: Date }> {
    const scope = this.getSiteAccessScopeOrThrow();
    const dds = await this.findDdsForInviteManagement(ddsId, scope.companyId);
    this.assertDdsSiteAllowed(dds.site_id, scope);

    const invite = await this.inviteRepository.findOne({
      where: {
        id: inviteId,
        dds_id: ddsId,
        company_id: dds.company_id,
      },
    });

    if (!invite) {
      throw new NotFoundException('Convite de assinatura não encontrado.');
    }
    if (invite.used_at) {
      throw new BadRequestException(
        'Convite já foi utilizado para assinar e não pode ser revogado.',
      );
    }
    if (invite.revoked_at) {
      throw new BadRequestException('Convite já foi revogado anteriormente.');
    }

    const revokedAt = new Date();
    invite.revoked_at = revokedAt;
    invite.updated_at = revokedAt;
    await this.inviteRepository.save(invite);

    this.logger.log({
      event: 'dds_signature_invite_revoked',
      ddsId,
      companyId: dds.company_id,
      inviteId,
    });

    return { inviteId: invite.id, revokedAt };
  }

  private buildInviteEmailHtml(input: {
    participantName: string;
    ddsTema: string;
    ddsData: string | null;
    companyName: string | null;
    siteName: string | null;
    facilitadorName: string | null;
    signingUrl: string | null;
    expiresAt: Date;
  }): string {
    const dateStr = input.expiresAt.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      timeZone: 'America/Sao_Paulo',
    });
    const ddsDateStr = input.ddsData
      ? new Date(input.ddsData + 'T12:00:00Z').toLocaleDateString('pt-BR', {
          day: '2-digit',
          month: 'long',
          year: 'numeric',
          timeZone: 'America/Sao_Paulo',
        })
      : null;

    const signingButton = input.signingUrl
      ? `<tr>
          <td style="padding:0 32px 32px">
            <a href="${this.escapeHtmlAttr(input.signingUrl)}"
               style="display:inline-block;background:#2f5d46;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
              Assinar DDS agora
            </a>
          </td>
        </tr>`
      : `<tr>
          <td style="padding:0 32px 32px">
            <p style="margin:0;color:#b91c1c;font-size:14px">
              Link de assinatura indisponível — entre em contato com o responsável pelo DDS.
            </p>
          </td>
        </tr>`;

    const metaRows = [
      input.companyName
        ? `<tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Empresa</td><td style="padding:4px 0 4px 12px;color:#111827;font-size:13px;font-weight:600">${this.escapeHtml(input.companyName)}</td></tr>`
        : '',
      input.siteName
        ? `<tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Obra / Site</td><td style="padding:4px 0 4px 12px;color:#111827;font-size:13px;font-weight:600">${this.escapeHtml(input.siteName)}</td></tr>`
        : '',
      ddsDateStr
        ? `<tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Data do DDS</td><td style="padding:4px 0 4px 12px;color:#111827;font-size:13px;font-weight:600">${ddsDateStr}</td></tr>`
        : '',
      input.facilitadorName
        ? `<tr><td style="padding:4px 0;color:#6b7280;font-size:13px">Facilitador</td><td style="padding:4px 0 4px 12px;color:#111827;font-size:13px;font-weight:600">${this.escapeHtml(input.facilitadorName)}</td></tr>`
        : '',
    ]
      .filter(Boolean)
      .join('');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08)">

        <tr>
          <td style="background:#2f5d46;padding:20px 32px">
            <p style="margin:0;color:#fff;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em">
              ${this.escapeHtml(INVITE_EMAIL_FROM_NAME)}
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 32px 16px">
            <h1 style="margin:0 0 6px;font-size:20px;color:#111827">Convite para assinar DDS</h1>
            <p style="margin:0;color:#6b7280;font-size:14px">${this.escapeHtml(input.ddsTema)}</p>
          </td>
        </tr>

        <tr>
          <td style="padding:0 32px 24px">
            <p style="margin:0 0 16px;color:#374151;line-height:1.65">
              Olá, <strong>${this.escapeHtml(input.participantName || 'participante')}</strong>.
            </p>
            <p style="margin:0 0 16px;color:#374151;line-height:1.65">
              Você foi identificado como participante do DDS acima e precisa registrar sua assinatura eletrônica no SGS.
              Clique no botão abaixo para acessar a página de assinatura pública.
            </p>
            ${metaRows ? `<table cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;background:#f9fafb;width:100%">${metaRows}</table>` : ''}
          </td>
        </tr>

        ${signingButton}

        <tr>
          <td style="padding:20px 32px;background:#f9fafb;border-top:1px solid #e5e7eb">
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6">
              Este convite expira em <strong>${dateStr}</strong>.
              Após o vencimento, solicite um novo link ao responsável pelo DDS.
              A assinatura é vinculada exclusivamente a este DDS e a este participante.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
  }

  private escapeHtml(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private escapeHtmlAttr(value: string): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private toDateString(value: Date | string | null | undefined): string | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }
    return String(value).slice(0, 10);
  }
}
