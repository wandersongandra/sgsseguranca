import { QueryFailedError, Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RdosService } from './rdos.service';
import { Rdo } from './entities/rdo.entity';
import { CreateRdoDto } from './dto/create-rdo.dto';
import { UpdateRdoDto } from './dto/update-rdo.dto';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { MailService } from '../../infra/mail/mail.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { DocumentRegistryService } from '../document-registry/document-registry.service';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import type { RdoAuditService } from './rdo-audit.service';
import type { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import type { AppendForensicTrailEventInput } from '../forensic-trail/forensic-trail.service';
import type { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import type { DocumentVideosService } from '../document-videos/document-videos.service';

const COMPANY_ID = 'company-1';
const RDO_ID = '11111111-2222-3333-4444-555555555555';
const RDO_ACTIVITY_PHOTO_REF_PREFIX = 'gst:rdo-activity-photo:';

function buildActivityPhotoReference(
  fileKey: string,
  originalName = 'foto.jpg',
) {
  return `${RDO_ACTIVITY_PHOTO_REF_PREFIX}${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: 'governed-storage',
      scope: 'activity',
      fileKey,
      originalName,
      mimeType: 'image/jpeg',
      uploadedAt: '2026-03-16T10:00:00.000Z',
      sizeBytes: 2048,
    }),
    'utf8',
  ).toString('base64url')}`;
}

function makeRdo(overrides: Partial<Rdo> = {}): Rdo {
  return {
    id: RDO_ID,
    numero: 'RDO-202603-001',
    data: new Date('2026-03-16'),
    status: 'rascunho',
    company_id: COMPANY_ID,
    houve_acidente: false,
    houve_paralisacao: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Rdo;
}

const getFirstCreateArg = (
  createMock: jest.Mock,
): Partial<Rdo> & { company_id?: string } => {
  const firstCall = createMock.mock.calls[0] as [Partial<Rdo>] | undefined;

  if (!firstCall) {
    throw new Error('repository.create não foi chamado.');
  }

  return firstCall[0];
};

describe('RdosService', () => {
  let service: RdosService;
  let _lockedRdoRow: Record<string, unknown> | null = null;
  let repository: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: {
      getRepository: jest.Mock;
      transaction: jest.Mock;
    };
  };
  let tenantService: Pick<TenantService, 'getTenantId' | 'getContext'>;
  let mailService: Pick<
    MailService,
    'sendMail' | 'sendMailSimple' | 'sendStoredDocument'
  >;
  let mailQueue: { add: jest.Mock };
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'uploadFile'
    | 'getSignedUrl'
    | 'downloadFileBuffer'
    | 'deleteFile'
    | 'generateDocumentKey'
  >;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    | 'syncFinalDocumentMetadata'
    | 'registerFinalDocument'
    | 'listFinalDocuments'
    | 'getModuleWeeklyBundle'
    | 'removeFinalDocumentReference'
  >;
  let documentRegistryService: Pick<DocumentRegistryService, 'findByDocument'>;
  let documentBundleService: Pick<
    DocumentBundleService,
    'buildWeeklyPdfBundle'
  >;
  let rdoAuditService: Pick<
    RdoAuditService,
    | 'recordCancellation'
    | 'recordEvent'
    | 'getEventsForRdo'
    | 'recordStatusChange'
    | 'recordPdfGenerated'
    | 'recordSignature'
  >;
  let forensicTrailService: Pick<ForensicTrailService, 'append'>;
  let signatureTimestampService: Pick<
    SignatureTimestampService,
    'issueFromHash'
  >;
  let documentVideosService: Pick<
    DocumentVideosService,
    'listByDocument' | 'uploadForDocument' | 'getAccess' | 'removeFromDocument'
  >;
  let siteScopedRepository: { exist: jest.Mock };
  let userScopedRepository: { exist: jest.Mock };

  beforeEach(() => {
    _lockedRdoRow = null;
    const defaultQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: null }),
      getRawMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      getMany: jest.fn().mockResolvedValue([]),
    };
    repository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn((input) => Promise.resolve(input as Rdo)),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((input) => ({ ...input }) as Rdo),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(defaultQb),
      manager: {
        getRepository: jest.fn((entity) => {
          if (entity === Site) {
            return siteScopedRepository;
          }

          if (entity === User) {
            return userScopedRepository;
          }

          throw new Error(`Repository não mapeado no teste: ${String(entity)}`);
        }),
        transaction: jest.fn((fn: (m: unknown) => unknown) => {
          const lockedRow = _lockedRdoRow;
          const innerRepo = {
            create: jest.fn((data: unknown) => data as Rdo),
            save: jest.fn((data: unknown) =>
              Promise.resolve({
                id: RDO_ID,
                company_id: COMPANY_ID,
                ...(data as object),
              } as Rdo),
            ),
            update: jest.fn().mockResolvedValue(undefined),
          };
          const innerManager = {
            query: jest.fn().mockResolvedValue(lockedRow ? [lockedRow] : []),
            getRepository: jest.fn((entity: unknown) => {
              if (entity === Rdo) return innerRepo;
              if (entity === Site) return siteScopedRepository;
              if (entity === User) return userScopedRepository;
              throw new Error(
                `Repository transacional não mapeado no teste: ${String(entity)}`,
              );
            }),
          };
          return fn(innerManager);
        }),
      },
    };
    siteScopedRepository = {
      exist: jest.fn().mockResolvedValue(true),
    };
    userScopedRepository = {
      exist: jest.fn().mockResolvedValue(true),
    };
    tenantService = {
      getTenantId: jest.fn(() => COMPANY_ID),
      getContext: jest.fn(() => ({
        companyId: COMPANY_ID,
        siteId: undefined,
        siteScope: 'all',
        isSuperAdmin: false,
      })),
    };
    mailService = {
      sendMail: jest.fn().mockResolvedValue(undefined),
      sendMailSimple: jest.fn().mockResolvedValue(undefined),
      sendStoredDocument: jest.fn().mockResolvedValue({
        success: true,
        message: 'Documento final governado enviado.',
        deliveryMode: 'sent',
        artifactType: 'governed_final_pdf',
        isOfficial: true,
        fallbackUsed: false,
      }),
    };
    mailQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    };
    documentStorageService = {
      uploadFile: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest.fn().mockResolvedValue('https://storage.test/rdo.pdf'),
      downloadFileBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-rdo')),
      deleteFile: jest.fn().mockResolvedValue(undefined),
      generateDocumentKey: jest
        .fn()
        .mockReturnValue(
          'documents/company-1/rdos/11111111-2222-3333-4444-555555555555/rdo.pdf',
        ),
    };
    documentGovernanceService = {
      syncFinalDocumentMetadata: jest
        .fn()
        .mockResolvedValue({ id: 'registry-1' }),
      registerFinalDocument: jest.fn().mockResolvedValue({
        hash: 'hash-rdo',
        registryEntry: { id: 'registry-1' },
      }),
      listFinalDocuments: jest.fn().mockResolvedValue([]),
      getModuleWeeklyBundle: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-bundle'),
        fileName: 'rdo-bundle.pdf',
      }),
      removeFinalDocumentReference: jest.fn().mockResolvedValue(undefined),
    };
    documentRegistryService = {
      findByDocument: jest.fn().mockResolvedValue(null),
    };
    documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(),
    };
    rdoAuditService = {
      recordCancellation: jest.fn().mockResolvedValue(undefined),
      recordEvent: jest.fn().mockResolvedValue(undefined),
      getEventsForRdo: jest.fn().mockResolvedValue([
        {
          id: 'event-1',
          event_type: 'SIGNED',
          user_id: 'user-1',
          created_at: new Date('2026-03-16T12:00:00Z'),
          details: { signatureType: 'responsavel' },
        },
      ]),
      recordStatusChange: jest.fn().mockResolvedValue(undefined),
      recordPdfGenerated: jest.fn().mockResolvedValue(undefined),
      recordSignature: jest.fn().mockResolvedValue(undefined),
    };
    forensicTrailService = {
      append: jest.fn().mockResolvedValue(undefined),
    };
    signatureTimestampService = {
      issueFromHash: jest.fn((signatureHash: string, issuedAt?: string) => ({
        signature_hash: signatureHash,
        timestamp_token: `token.${signatureHash}`,
        timestamp_authority: 'internal-hmac-v1',
        timestamp_issued_at: issuedAt || '2026-03-16T12:00:00.000Z',
      })),
    };
    documentVideosService = {
      listByDocument: jest.fn(() => Promise.resolve([])),
      uploadForDocument: jest.fn(),
      getAccess: jest.fn(),
      removeFromDocument: jest.fn(),
    };

    service = new RdosService(
      repository as unknown as Repository<Rdo>,
      tenantService as TenantService,
      mailService as MailService,
      mailQueue as unknown as import('bullmq').Queue,
      documentStorageService as DocumentStorageService,
      documentGovernanceService as DocumentGovernanceService,
      documentRegistryService as DocumentRegistryService,
      documentBundleService as unknown as DocumentBundleService,
      rdoAuditService as RdoAuditService,
      forensicTrailService as ForensicTrailService,
      signatureTimestampService as SignatureTimestampService,
      documentVideosService as DocumentVideosService,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  // ─── create ──────────────────────────────────────────────────────────────────

  it('cria RDO com numero gerado automaticamente', async () => {
    repository.createQueryBuilder.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: 'RDO-202603-002' }),
    });
    const dto: CreateRdoDto = {
      data: '2026-03-16',
      status: 'rascunho',
    };
    const result = await service.create(dto);
    expect(result.numero).toMatch(/^RDO-\d{6}-003$/);
    expect(repository.save).toHaveBeenCalled();
  });

  it('rejeita create quando o banco sinaliza número duplicado na empresa', async () => {
    repository.save.mockRejectedValue(
      new QueryFailedError('INSERT', [], {
        code: '23505',
        constraint: 'UQ_rdos_company_numero',
      } as never),
    );

    await expect(
      service.create({
        data: '2026-03-16',
      }),
    ).rejects.toThrow('Já existe um RDO com este número na empresa atual.');
  });

  it('usa company_id do tenant quando o DTO nao fornece', async () => {
    repository.count.mockResolvedValue(0);
    const dto: CreateRdoDto = { data: '2026-03-16' };
    await service.create(dto);
    const createdArg = getFirstCreateArg(repository.create);
    expect(createdArg.company_id).toBe(COMPANY_ID);
  });

  it('rejeita create quando o site nao pertence a empresa atual', async () => {
    siteScopedRepository.exist.mockResolvedValue(false);

    await expect(
      service.create({
        data: '2026-03-16',
        site_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    ).rejects.toThrow('Site inválido para a empresa/tenant atual.');
  });

  it('bloqueia create com status diferente de rascunho', async () => {
    await expect(
      service.create({
        data: '2026-03-16',
        status: 'aprovado',
      }),
    ).rejects.toThrow(
      'O status do RDO é controlado pelo fluxo formal de tramitação.',
    );
  });

  // ─── findPaginated ───────────────────────────────────────────────────────────

  it('rejeita filtro paginado com status inválido', async () => {
    await expect(
      service.findPaginated({ status: 'encerrado' as never }),
    ).rejects.toThrow('Status de filtro do RDO inválido.');
  });

  it('rejeita filtro paginado com data inicial inválida', async () => {
    await expect(
      service.findPaginated({ data_inicio: '2026-02-30' }),
    ).rejects.toThrow(
      'A data inicial do filtro deve ser uma data válida no formato YYYY-MM-DD.',
    );
  });

  it('rejeita filtro paginado com intervalo invertido', async () => {
    await expect(
      service.findPaginated({
        data_inicio: '2026-03-31',
        data_fim: '2026-03-01',
      }),
    ).rejects.toThrow('O período informado para consulta de RDO é inválido.');
  });

  it('pagina RDOs usando consulta estreita de ids e carrega relacoes sob demanda', async () => {
    const first = makeRdo({ id: 'rdo-1', numero: 'RDO-001' });
    const second = makeRdo({ id: 'rdo-2', numero: 'RDO-002' });
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([{ id: second.id }, { id: first.id }]),
      getCount: jest.fn().mockResolvedValue(2),
    };
    repository.createQueryBuilder.mockReturnValue(qb);
    repository.find.mockResolvedValue([first, second]);

    const result = await service.findPaginated({ page: 1, limit: 2 });

    expect(result.total).toBe(2);
    expect(result.data.map((item) => item.id)).toEqual([second.id, first.id]);
    // Regressão GDPR: RDOs soft-deletados não podem contar no total nem
    // criar buracos na página. É o primeiro clause do applyFindPaginatedFilters,
    // então entra via .where().
    expect(qb.where).toHaveBeenCalledWith('rdo.deleted_at IS NULL', {});
    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        relations: ['site', 'responsavel'],
      }),
    );
    expect(qb.getRawMany).toHaveBeenCalled();
    expect(qb.getCount).toHaveBeenCalled();
  });

  it('aplica busca server-side por numero, obra e responsavel', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ id: RDO_ID }]),
      getCount: jest.fn().mockResolvedValue(1),
    };
    repository.createQueryBuilder.mockReturnValue(qb);
    repository.find.mockResolvedValue([makeRdo()]);

    await service.findPaginated({ search: 'Central' });

    expect(qb.leftJoin).toHaveBeenCalledWith('rdo.site', 'site');
    expect(qb.leftJoin).toHaveBeenCalledWith('rdo.responsavel', 'responsavel');
    expect(qb.andWhere).toHaveBeenCalledWith(
      "(rdo.numero ILIKE :search ESCAPE '\\\\' OR site.nome ILIKE :search ESCAPE '\\\\' OR responsavel.nome ILIKE :search ESCAPE '\\\\')",
      expect.objectContaining({ search: '%Central%' }),
    );
  });

  it('rejeita search malformado em vez de cair em 500', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ id: RDO_ID }]),
      getCount: jest.fn().mockResolvedValue(1),
    };
    repository.createQueryBuilder.mockReturnValue(qb);

    await expect(
      service.findPaginated({
        search: ['forged'] as unknown as string,
      }),
    ).rejects.toThrow();

    expect(qb.getRawMany).not.toHaveBeenCalled();
    expect(qb.getCount).not.toHaveBeenCalled();
  });

  // ─── findOne ─────────────────────────────────────────────────────────────────

  it('retorna RDO existente pelo ID', async () => {
    const rdo = makeRdo();
    repository.findOne.mockResolvedValue(rdo);
    await expect(service.findOne(RDO_ID)).resolves.toEqual(rdo);
  });

  it('lanca NotFoundException quando RDO nao existe', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(service.findOne('inexistente')).rejects.toThrow(
      NotFoundException,
    );
  });

  // ─── update ──────────────────────────────────────────────────────────────────

  it('atualiza campos do RDO', async () => {
    const rdo = makeRdo();
    repository.findOne.mockResolvedValue(rdo);
    const dto: UpdateRdoDto = {
      observacoes: 'Atualizado',
    };
    const result = await service.update(RDO_ID, dto);
    expect(result.observacoes).toBe('Atualizado');
    expect(repository.save).toHaveBeenCalled();
  });

  it('rejeita update quando o responsavel nao pertence a empresa atual', async () => {
    const rdo = makeRdo({ responsavel_id: 'resp-atual' });
    repository.findOne.mockResolvedValue(rdo);
    userScopedRepository.exist.mockResolvedValue(false);

    await expect(
      service.update(RDO_ID, {
        responsavel_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      }),
    ).rejects.toThrow('Responsável inválido para a empresa/tenant atual.');
  });

  it('bloqueia troca de company_id pelo endpoint generico', async () => {
    repository.findOne.mockResolvedValue(makeRdo());

    await expect(
      service.update(RDO_ID, {
        company_id: 'company-2',
      } as unknown as UpdateRdoDto),
    ).rejects.toThrow(
      'O company_id do RDO não pode ser alterado pelo endpoint genérico.',
    );
  });

  it('exige motivo quando o RDO registra paralisação', async () => {
    repository.findOne.mockResolvedValue(makeRdo());

    await expect(
      service.update(RDO_ID, {
        houve_paralisacao: true,
        motivo_paralisacao: '   ',
      }),
    ).rejects.toThrow(
      'Informe o motivo da paralisação quando o RDO registrar paralisação.',
    );
  });

  it('remove arquivos órfãos quando fotos de atividade saem do payload no update', async () => {
    const oldPhotoRef = buildActivityPhotoReference(
      'documents/company-1/rdo-activity-photos/rdo-1/old-photo.jpg',
      'old-photo.jpg',
    );
    repository.findOne.mockResolvedValue(
      makeRdo({
        servicos_executados: [
          {
            descricao: 'Concretagem',
            percentual_concluido: 50,
            fotos: [oldPhotoRef],
          },
        ],
      }),
    );

    await service.update(RDO_ID, {
      servicos_executados: [
        {
          descricao: 'Concretagem',
          percentual_concluido: 80,
          fotos: [],
        },
      ],
    });

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'documents/company-1/rdo-activity-photos/rdo-1/old-photo.jpg',
    );
  });

  // ─── updateStatus ────────────────────────────────────────────────────────────

  it('transiciona status de rascunho para enviado', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'rascunho' }));
    const result = await service.updateStatus(RDO_ID, 'enviado');
    expect(result.status).toBe('enviado');
    expect(rdoAuditService.recordStatusChange).toHaveBeenCalledWith(
      RDO_ID,
      'rascunho',
      'enviado',
    );
  });

  it('transiciona status para cancelado através do cancelamento explícito', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'enviado' }));
    const result = await service.cancel(RDO_ID, 'Erro de preenchimento');
    expect(result.status).toBe('cancelado');
    const cancelTrailCalls = (forensicTrailService.append as jest.Mock).mock
      .calls as Array<[AppendForensicTrailEventInput, { manager?: unknown }]>;
    const firstCancelTrailCall = cancelTrailCalls[0];
    if (!firstCancelTrailCall) {
      throw new Error('Expected forensic cancellation trail call');
    }
    const [cancelTrailInput, cancelTrailOptions] = firstCancelTrailCall;
    const cancelTrailMetadata = cancelTrailInput.metadata as Record<
      string,
      unknown
    >;
    expect(cancelTrailInput.eventType).toBe(
      FORENSIC_EVENT_TYPES.DOCUMENT_CANCELED,
    );
    expect(cancelTrailInput.module).toBe('rdo');
    expect(cancelTrailInput.entityId).toBe(RDO_ID);
    expect(cancelTrailInput.companyId).toBe(COMPANY_ID);
    expect(cancelTrailMetadata.previousStatus).toBe('enviado');
    expect(cancelTrailMetadata.currentStatus).toBe('cancelado');
    expect(cancelTrailMetadata.reason).toBe('Erro de preenchimento');
    expect(cancelTrailOptions.manager).toBeDefined();
    expect(rdoAuditService.recordCancellation).toHaveBeenCalledWith(
      RDO_ID,
      'Erro de preenchimento',
      'enviado',
    );
  });

  it('bloqueia cancelamento quando o RDO ja possui PDF final governado', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'aprovado' }));
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      id: 'registry-1',
      file_key: 'documents/rdo.pdf',
    });

    await expect(service.cancel(RDO_ID, 'Tentativa tardia')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('exige assinaturas antes de aprovar o RDO', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'enviado' }));
    await expect(service.updateStatus(RDO_ID, 'aprovado')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('aprova RDO enviado quando as duas assinaturas estão presentes', async () => {
    // Regressão: a aprovação validava o status "aprovado" no próprio RDO
    // (via assertRdoReadyForFinalDocument), tornando a transição impossível.
    repository.findOne.mockResolvedValue(
      makeRdo({
        status: 'enviado',
        assinatura_responsavel: JSON.stringify({ nome: 'Resp Teste' }),
        assinatura_engenheiro: JSON.stringify({ nome: 'Eng Teste' }),
      }),
    );
    const result = await service.updateStatus(RDO_ID, 'aprovado');
    expect(result.status).toBe('aprovado');
    expect(rdoAuditService.recordStatusChange).toHaveBeenCalledWith(
      RDO_ID,
      'enviado',
      'aprovado',
    );
  });

  it('bloqueia transicao de status invalida', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'aprovado' }));
    await expect(service.updateStatus(RDO_ID, 'rascunho')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('bloqueia transicao direta de rascunho para aprovado', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'rascunho' }));
    await expect(service.updateStatus(RDO_ID, 'aprovado')).rejects.toThrow(
      BadRequestException,
    );
  });

  // ─── getAuditTrail ──────────────────────────────────────────────────────────

  it('retorna a trilha de auditoria do RDO', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    const result = await service.getAuditTrail(RDO_ID);
    expect(result).toEqual([
      {
        id: 'event-1',
        eventType: 'SIGNED',
        eventLabel: 'Assinado',
        userId: 'user-1',
        createdAt: new Date('2026-03-16T12:00:00Z'),
        details: { signatureType: 'responsavel' },
      },
    ]);
    expect(rdoAuditService.getEventsForRdo).toHaveBeenCalledWith(RDO_ID);
  });

  // ─── activity photos ────────────────────────────────────────────────────────

  it('anexa foto governada a uma atividade do RDO', async () => {
    const rdoData = makeRdo({
      status: 'enviado',
      servicos_executados: [
        { descricao: 'Concretagem', percentual_concluido: 50, fotos: [] },
      ],
      assinatura_responsavel:
        '{"nome":"Resp","cpf":"123","signed_at":"2026-03-16T12:00:00.000Z"}',
    });
    repository.findOne.mockResolvedValue(rdoData);
    _lockedRdoRow = rdoData as unknown as Record<string, unknown>;

    const result = await service.attachActivityPhoto(
      RDO_ID,
      0,
      Buffer.from('fake-image'),
      'atividade.jpg',
      'image/jpeg',
    );

    expect(result.activityIndex).toBe(0);
    expect(result.photoIndex).toBe(0);
    expect(result.photoReference).toContain(RDO_ACTIVITY_PHOTO_REF_PREFIX);
    expect(documentStorageService.uploadFile).toHaveBeenCalled();
    expect(rdoAuditService.recordEvent).toHaveBeenCalledWith(
      RDO_ID,
      'ACTIVITY_PHOTO_UPLOADED',
      expect.objectContaining({
        activityIndex: 0,
        photoIndex: 0,
        signaturesReset: true,
      }),
    );
  });

  it('retorna acesso assinado para foto governada da atividade', async () => {
    repository.findOne.mockResolvedValue(
      makeRdo({
        servicos_executados: [
          {
            descricao: 'Concretagem',
            percentual_concluido: 50,
            fotos: [
              buildActivityPhotoReference(
                'documents/company-1/rdo-activity-photos/rdo-1/foto.jpg',
              ),
            ],
          },
        ],
      }),
    );

    const result = await service.getActivityPhotoAccess(RDO_ID, 0, 0);

    expect(result.fileKey).toBe(
      'documents/company-1/rdo-activity-photos/rdo-1/foto.jpg',
    );
    expect(result.url).toBe('https://storage.test/rdo.pdf');
  });

  it('remove foto governada da atividade e limpa o storage', async () => {
    const rdoData = makeRdo({
      status: 'enviado',
      servicos_executados: [
        {
          descricao: 'Concretagem',
          percentual_concluido: 50,
          fotos: [
            buildActivityPhotoReference(
              'documents/company-1/rdo-activity-photos/rdo-1/foto.jpg',
            ),
          ],
        },
      ],
    });
    repository.findOne.mockResolvedValue(rdoData);
    _lockedRdoRow = rdoData as unknown as Record<string, unknown>;

    const result = await service.removeActivityPhoto(RDO_ID, 0, 0);

    expect(result.removed).toBe(true);
    expect(result.removedFileKey).toBe(
      'documents/company-1/rdo-activity-photos/rdo-1/foto.jpg',
    );
    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'documents/company-1/rdo-activity-photos/rdo-1/foto.jpg',
    );
    expect(rdoAuditService.recordEvent).toHaveBeenCalledWith(
      RDO_ID,
      'ACTIVITY_PHOTO_REMOVED',
      expect.objectContaining({
        activityIndex: 0,
        photoIndex: 0,
      }),
    );
  });

  // ─── sign ────────────────────────────────────────────────────────────────────

  it('registra assinatura do responsavel', async () => {
    const rdo = makeRdo({ status: 'enviado' });
    repository.findOne.mockResolvedValue(rdo);
    const result = await service.sign(RDO_ID, {
      tipo: 'responsavel',
      nome: 'João Silva',
      cpf: '12345678900',
    });
    expect(result.assinatura_responsavel).toBeDefined();
    const parsed = JSON.parse(result.assinatura_responsavel!) as {
      nome: string;
      cpf: string;
      signed_at: string;
      signature_mode: string;
      verification_mode: string;
      document_hash: string;
      signature_hash: string;
      timestamp_token: string;
      timestamp_authority: string;
    };
    expect(parsed.nome).toBe('João Silva');
    expect(parsed.cpf).toBe('12345678900');
    expect(parsed.signature_mode).toBe('operational_ack');
    expect(parsed.verification_mode).toBe('operational_ack');
    expect(parsed.document_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.signature_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.timestamp_token).toContain(parsed.signature_hash);
    expect(parsed.timestamp_authority).toBe('internal-hmac-v1');
    expect(parsed.signed_at).toBeDefined();
    const signatureTrailCalls = (forensicTrailService.append as jest.Mock).mock
      .calls as Array<[AppendForensicTrailEventInput, { manager?: unknown }]>;
    const firstSignatureTrailCall = signatureTrailCalls[0];
    if (!firstSignatureTrailCall) {
      throw new Error('Expected forensic signature trail call');
    }
    const [signatureTrailInput, signatureTrailOptions] =
      firstSignatureTrailCall;
    const signatureTrailMetadata = signatureTrailInput.metadata as Record<
      string,
      unknown
    >;
    expect(signatureTrailInput.eventType).toBe(
      FORENSIC_EVENT_TYPES.SIGNATURE_RECORDED,
    );
    expect(signatureTrailInput.module).toBe('rdo');
    expect(signatureTrailInput.entityId).toBe(RDO_ID);
    expect(signatureTrailInput.companyId).toBe(COMPANY_ID);
    expect(signatureTrailMetadata.signatureType).toBe('responsavel');
    expect(signatureTrailMetadata.verificationMode).toBe('operational_ack');
    expect(signatureTrailMetadata.signatureMode).toBe('operational_ack');
    expect(signatureTrailMetadata.signerName).toBe('João Silva');
    expect(signatureTrailMetadata.signerCpfSuffix).toBe('8900');
    expect(signatureTrailMetadata.signatureHash).toBe(parsed.signature_hash);
    expect(signatureTrailOptions.manager).toBeDefined();
    expect(rdoAuditService.recordSignature).toHaveBeenCalledWith(
      RDO_ID,
      'responsavel',
      'João Silva',
    );
  });

  it('registra assinatura do engenheiro', async () => {
    const rdo = makeRdo({ status: 'enviado' });
    repository.findOne.mockResolvedValue(rdo);
    const result = await service.sign(RDO_ID, {
      tipo: 'engenheiro',
      nome: 'Ana Engenheira',
      cpf: '98765432100',
    });
    expect(result.assinatura_engenheiro).toBeDefined();
    const parsed = JSON.parse(result.assinatura_engenheiro!) as {
      nome: string;
      signature_mode: string;
      verification_mode: string;
      signature_hash: string;
    };
    expect(parsed.nome).toBe('Ana Engenheira');
    expect(parsed.signature_mode).toBe('operational_ack');
    expect(parsed.verification_mode).toBe('operational_ack');
    expect(parsed.signature_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(rdoAuditService.recordSignature).toHaveBeenCalledWith(
      RDO_ID,
      'engenheiro',
      'Ana Engenheira',
    );
  });

  it('bloqueia assinatura enquanto o RDO ainda esta em rascunho', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'rascunho' }));

    await expect(
      service.sign(RDO_ID, {
        tipo: 'responsavel',
        nome: 'João Silva',
        cpf: '12345678900',
      }),
    ).rejects.toThrow('Envie o RDO para revisão antes de coletar assinaturas.');
  });

  // ─── markPdfSaved ────────────────────────────────────────────────────────────

  it('despromove explicitamente o endpoint legado save-pdf', async () => {
    const rdo = makeRdo({
      status: 'aprovado',
      assinatura_responsavel: '{"nome":"Resp"}',
      assinatura_engenheiro: '{"nome":"Eng"}',
    });
    repository.findOne.mockResolvedValue(rdo);

    await expect(
      service.markPdfSaved(RDO_ID, {
        filename: 'rdo-2026.pdf',
      }),
    ).rejects.toThrow(
      'O endpoint legado POST /rdos/:id/save-pdf foi descontinuado.',
    );
    expect(rdoAuditService.recordEvent).toHaveBeenCalledWith(
      RDO_ID,
      'LEGACY_SAVE_PDF_ATTEMPT',
      expect.objectContaining({
        endpoint: 'POST /rdos/:id/save-pdf',
        deprecated: true,
      }),
    );
  });

  it('bloqueia alteracao quando o RDO ja possui PDF final governado', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      id: 'registry-1',
    });
    const dto: UpdateRdoDto = { observacoes: 'Nao deveria editar' };

    await expect(service.update(RDO_ID, dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  // ─── getPdfAccess ────────────────────────────────────────────────────────────

  it('retorna contrato explícito quando o PDF final ainda não foi emitido', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue(
      null,
    );

    await expect(service.getPdfAccess(RDO_ID)).resolves.toEqual({
      entityId: RDO_ID,
      hasFinalPdf: false,
      availability: 'not_emitted',
      message: 'O PDF final do RDO ainda não foi emitido.',
      fileKey: null,
      folderPath: null,
      originalName: null,
      url: null,
    });
  });

  it('retorna disponibilidade degradada quando a URL assinada falha', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      file_key: 'documents/rdo.pdf',
      folder_path: 'rdos/company-1/2026/week-12',
      original_name: 'rdo.pdf',
    });
    (documentStorageService.getSignedUrl as jest.Mock).mockRejectedValue(
      new Error('signed-url unavailable'),
    );

    await expect(service.getPdfAccess(RDO_ID)).resolves.toEqual({
      entityId: RDO_ID,
      hasFinalPdf: true,
      availability: 'registered_without_signed_url',
      message:
        'O PDF final do RDO foi emitido, mas a URL segura não está disponível agora.',
      fileKey: 'documents/rdo.pdf',
      folderPath: 'rdos/company-1/2026/week-12',
      originalName: 'rdo.pdf',
      url: null,
    });
  });

  it('fornece o PDF oficial do RDO como buffer quando o download governado e possivel', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      file_key:
        'documents/company-1/rdos/11111111-2222-3333-4444-555555555555/rdo.pdf',
      folder_path: 'rdos/company-1/2026/week-12',
      original_name: 'RDO-RDO-202603-001.pdf',
    });

    await expect(service.downloadPdf(RDO_ID)).resolves.toEqual({
      buffer: Buffer.from('%PDF-rdo'),
      fileName: 'RDO-RDO-202603-001.pdf',
    });

    expect(documentStorageService.downloadFileBuffer).toHaveBeenCalledWith(
      'documents/company-1/rdos/11111111-2222-3333-4444-555555555555/rdo.pdf',
    );
  });

  // ─── sendEmail ───────────────────────────────────────────────────────────────

  it('envia e-mail oficial com PDF final governado para cada destinatario', async () => {
    const rdo = makeRdo({
      numero: 'RDO-202603-001',
      pdf_file_key: 'documents/rdo.pdf',
    });
    repository.findOne.mockResolvedValue(rdo);
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValueOnce(
      {
        file_key: 'documents/rdo.pdf',
        original_name: 'rdo.pdf',
        folder_path: 'rdos/company-1/week-12',
      },
    );

    const result = await service.sendEmail(RDO_ID, [
      'gestor@empresa.com',
      'eng@empresa.com',
    ]);

    expect(mailQueue.add).toHaveBeenCalledTimes(2);
    expect(mailQueue.add).toHaveBeenNthCalledWith(
      1,
      'send-document',
      expect.objectContaining({
        documentId: RDO_ID,
        documentType: 'RDO',
        email: 'gestor@empresa.com',
        companyId: COMPANY_ID,
      }),
      expect.anything(),
    );
    expect(mailService.sendStoredDocument).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      deliveryMode: 'queued',
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
      recipients: 2,
      documentType: 'RDO',
      documentId: RDO_ID,
    });
  });

  it('recorre ao envio síncrono quando a fila de e-mail está indisponível', async () => {
    const rdo = makeRdo({
      numero: 'RDO-202603-001',
      pdf_file_key: 'documents/rdo.pdf',
    });
    repository.findOne.mockResolvedValue(rdo);
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValueOnce(
      {
        file_key: 'documents/rdo.pdf',
        original_name: 'rdo.pdf',
        folder_path: 'rdos/company-1/week-12',
      },
    );
    mailQueue.add.mockRejectedValueOnce(new Error('fila indisponível'));

    const result = await service.sendEmail(RDO_ID, ['gestor@empresa.com']);

    expect(mailQueue.add).toHaveBeenCalledTimes(1);
    expect(mailService.sendStoredDocument).toHaveBeenCalledWith(
      RDO_ID,
      'RDO',
      'gestor@empresa.com',
      COMPANY_ID,
    );
    expect(result).toMatchObject({
      deliveryMode: 'sent',
      recipients: 1,
    });
  });

  it('nao envia e-mail quando lista de destinatarios esta vazia', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    await service.sendEmail(RDO_ID, []);
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('bloqueia envio de email quando o RDO ainda nao possui PDF final governado', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ pdf_file_key: null }));
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue(
      null,
    );

    await expect(
      service.sendEmail(RDO_ID, ['gestor@empresa.com']),
    ).rejects.toThrow(
      'Emita o PDF final governado antes de enviar este RDO por e-mail.',
    );

    expect(mailService.sendStoredDocument).not.toHaveBeenCalled();
    expect(mailQueue.add).not.toHaveBeenCalled();
  });

  // ─── listFiles ───────────────────────────────────────────────────────────────

  it('lista arquivos governados pelo document registry', async () => {
    (
      documentGovernanceService.listFinalDocuments as jest.Mock
    ).mockResolvedValue([
      {
        entityId: RDO_ID,
        id: RDO_ID,
        title: 'RDO-202603-001',
        date: new Date('2026-03-16'),
        companyId: COMPANY_ID,
        fileKey: 'documents/rdo.pdf',
        folderPath: 'rdos/company-1/2026/week-12',
        originalName: 'rdo.pdf',
        module: 'rdo',
      },
    ]);
    const result = await service.listFiles();
    expect(documentGovernanceService.listFinalDocuments).toHaveBeenCalledWith(
      'rdo',
      {},
    );
    expect(result).toHaveLength(1);
  });

  it('retorna overview analitico consolidado do tenant atual', async () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({
        totalRdos: 12,
        rascunho: 5,
        enviado: 4,
        aprovado: 3,
        cancelado: 2,
      }),
    };
    repository.createQueryBuilder.mockReturnValue(qb);

    await expect(service.getAnalyticsOverview()).resolves.toEqual({
      totalRdos: 12,
      rascunho: 5,
      enviado: 4,
      aprovado: 3,
      cancelado: 2,
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────────────

  it('remove o RDO pelo ID', async () => {
    const rdo = makeRdo();
    repository.findOne.mockResolvedValue(rdo);
    await expect(service.remove(RDO_ID)).resolves.toBeUndefined();
    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).toHaveBeenCalled();
    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        module: 'rdo',
        entityId: RDO_ID,
        trailEventType: FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
        trailMetadata: {
          removalMode: 'hard_remove',
        },
      }),
    );
    expect(repository.remove).toHaveBeenCalledWith(rdo);
    expect(forensicTrailService.append).toHaveBeenCalledWith(
      expect.objectContaining<AppendForensicTrailEventInput>({
        eventType: FORENSIC_EVENT_TYPES.DOCUMENT_HARD_REMOVED,
        module: 'rdo',
        entityId: RDO_ID,
        companyId: COMPANY_ID,
      }),
    );
    expect(rdoAuditService.recordEvent).not.toHaveBeenCalledWith(
      RDO_ID,
      'REMOVED',
    );
  });

  it('remove fotos governadas das atividades ao excluir o RDO', async () => {
    const photoKey = 'documents/company-1/rdo-activity-photos/rdo-1/foto.jpg';
    repository.findOne.mockResolvedValue(
      makeRdo({
        servicos_executados: [
          {
            descricao: 'Concretagem',
            percentual_concluido: 50,
            fotos: [buildActivityPhotoReference(photoKey)],
          },
        ],
      }),
    );

    await service.remove(RDO_ID);

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(photoKey);
  });

  it('bloqueia remocao fisica de RDO aprovado', async () => {
    repository.findOne.mockResolvedValue(makeRdo({ status: 'aprovado' }));
    await expect(service.remove(RDO_ID)).rejects.toThrow(
      'RDOs aprovados ou cancelados não podem ser excluídos fisicamente',
    );
  });

  it('lanca NotFoundException ao remover RDO inexistente', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(service.remove('inexistente')).rejects.toThrow(
      NotFoundException,
    );
  });

  // ─── generateNumero (via create) ─────────────────────────────────────────────

  it('gera numero sequencial por mes (nao por total da empresa)', async () => {
    repository.createQueryBuilder.mockReturnValueOnce({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: 'RDO-202603-005' }),
    });
    const dto: CreateRdoDto = {
      data: '2026-03-16',
    };
    const result = await service.create(dto);
    expect(result.numero).toMatch(/^RDO-\d{6}-006$/);
  });

  it('inicia sequencia em 001 quando nao ha RDOs no mes', async () => {
    // default mock already returns { max: null } — no override needed
    const dto: CreateRdoDto = {
      data: '2026-04-01',
    };
    const result = await service.create(dto);
    expect(result.numero).toMatch(/^RDO-\d{6}-001$/);
  });

  // ─── update (status bypass protection) ───────────────────────────────────────

  it('bloqueia alteracao de status pelo endpoint generico de update', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    const dto: UpdateRdoDto = { status: 'aprovado' };
    await expect(service.update(RDO_ID, dto)).rejects.toThrow(
      'Use PATCH /rdos/:id/status para alterar o status do RDO.',
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  // ─── sign (PDF lock) ──────────────────────────────────────────────────────────

  it('bloqueia assinatura quando o RDO ja possui PDF final governado', async () => {
    repository.findOne.mockResolvedValue(makeRdo());
    (documentRegistryService.findByDocument as jest.Mock).mockResolvedValue({
      id: 'registry-1',
      file_key: 'documents/rdo.pdf',
    });

    await expect(
      service.sign(RDO_ID, {
        tipo: 'responsavel',
        nome: 'João',
        cpf: '12345678900',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  // ─── assinatura e lifecycle ──────────────────────────────────────────────────

  it('invalida assinaturas e devolve RDO aprovado para enviado quando o conteúdo muda', async () => {
    const rdo = makeRdo({
      status: 'aprovado',
      observacoes: 'Versão original',
      assinatura_responsavel:
        '{"nome":"Resp","cpf":"123","signed_at":"2026-03-16T12:00:00.000Z"}',
      assinatura_engenheiro:
        '{"nome":"Eng","cpf":"456","signed_at":"2026-03-16T12:30:00.000Z"}',
    });
    repository.findOne.mockResolvedValue(rdo);

    const result = await service.update(RDO_ID, {
      observacoes: 'Versão alterada',
    });

    expect(result.status).toBe('enviado');
    expect(result.assinatura_responsavel).toBeNull();
    expect(result.assinatura_engenheiro).toBeNull();
    expect(rdoAuditService.recordEvent).toHaveBeenCalledWith(
      RDO_ID,
      'SIGNATURES_RESET',
      expect.objectContaining({ reason: 'content_changed' }),
    );
  });

  it('limpa assinaturas quando o RDO volta para rascunho', async () => {
    repository.findOne.mockResolvedValue(
      makeRdo({
        status: 'enviado',
        assinatura_responsavel:
          '{"nome":"Resp","cpf":"123","signed_at":"2026-03-16T12:00:00.000Z"}',
        assinatura_engenheiro:
          '{"nome":"Eng","cpf":"456","signed_at":"2026-03-16T12:30:00.000Z"}',
      }),
    );

    const result = await service.updateStatus(RDO_ID, 'rascunho');

    expect(result.status).toBe('rascunho');
    expect(result.assinatura_responsavel).toBeNull();
    expect(result.assinatura_engenheiro).toBeNull();
    expect(rdoAuditService.recordEvent).toHaveBeenCalledWith(
      RDO_ID,
      'SIGNATURES_RESET',
      expect.objectContaining({ reason: 'returned_to_draft' }),
    );
  });

  // ─── savePdf (cleanup on governance failure) ──────────────────────────────────

  it('remove arquivo do storage quando a governanca falha no savePdf', async () => {
    repository.findOne.mockResolvedValue(
      makeRdo({
        status: 'aprovado',
        assinatura_responsavel: '{"nome":"Resp"}',
        assinatura_engenheiro: '{"nome":"Eng"}',
      }),
    );
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance failure'));

    const file = {
      originalname: 'rdo.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-rdo'),
    } as Express.Multer.File;

    await expect(service.savePdf(RDO_ID, file)).rejects.toThrow(
      'governance failure',
    );
    expect(documentStorageService.deleteFile).toHaveBeenCalled();
  });

  // ─── exportExcel ─────────────────────────────────────────────────────────────

  it('exporta planilha Excel com dados dos RDOs', async () => {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        makeRdo({
          mao_de_obra: [
            { funcao: 'Pedreiro', quantidade: 5, turno: 'manha', horas: 8 },
          ],
          equipamentos: [
            {
              nome: 'Trator',
              quantidade: 1,
              horas_trabalhadas: 6,
              horas_ociosas: 2,
            },
          ],
          clima_manha: 'ensolarado',
        }),
      ]),
    };
    repository.createQueryBuilder.mockReturnValue(qb);

    const buffer = await service.exportExcel();
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('retorna buffer vazio de Excel quando nao ha RDOs', async () => {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    repository.createQueryBuilder.mockReturnValue(qb);

    const buffer = await service.exportExcel();
    expect(buffer).toBeInstanceOf(Buffer);
  });
});
