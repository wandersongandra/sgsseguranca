import { Repository } from 'typeorm';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DdsService } from './dds.service';
import { Dds, DdsStatus } from './entities/dds.entity';
import {
  DdsApprovalAction,
  DdsApprovalRecord,
} from './entities/dds-approval-record.entity';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { DocumentVideosService } from '../document-videos/document-videos.service';
import type { SignaturesService } from '../signatures/signatures.service';
import type { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { Signature } from '../signatures/entities/signature.entity';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import { UserSite } from '../users/entities/user-site.entity';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];
type RemoveFinalDocumentReferenceInput = Parameters<
  DocumentGovernanceService['removeFinalDocumentReference']
>[0];

describe('DdsService', () => {
  type SiteFindOneArgs = { where?: { id?: string } };
  type UserFindWhere = {
    id?: {
      value?: string[];
      _value?: string[];
    };
    company_id?: string;
    site_id?: string | object;
    deletedAt?: object;
  };
  type UserFindArgs = {
    where?: UserFindWhere | UserFindWhere[];
  };
  type UserSiteFindArgs = {
    where?: {
      user_id?: unknown;
      company_id?: unknown;
      site_id?: string;
    };
  };
  type MockManager = {
    getRepository: jest.Mock;
    transaction: jest.Mock;
  };

  let service: DdsService;
  let repository: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: {
      getRepository: jest.Mock;
      transaction: jest.Mock;
    };
  };
  let documentStorageService: Pick<
    DocumentStorageService,
    'generateDocumentKey' | 'uploadFile' | 'deleteFile' | 'getSignedUrl'
  >;
  let documentBundleService: Pick<
    DocumentBundleService,
    'buildWeeklyPdfBundle'
  >;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    | 'registerFinalDocument'
    | 'removeFinalDocumentReference'
    | 'listFinalDocuments'
  >;
  let documentVideosService: Pick<
    DocumentVideosService,
    'listByDocument' | 'uploadForDocument' | 'getAccess' | 'removeFromDocument'
  >;
  let signaturesService: Pick<
    SignaturesService,
    'findByDocument' | 'replaceDocumentSignatures' | 'findManyByDocuments'
  >;
  let publicValidationGrantService: Pick<
    PublicValidationGrantService,
    'issueToken'
  >;
  let signatureRepository: { delete: jest.Mock };
  let approvalRepository: { find: jest.Mock };
  let siteRepository: { findOne: jest.Mock };
  let userRepository: {
    find: jest.Mock<Promise<User[]>, [UserFindArgs]>;
    createQueryBuilder: jest.Mock;
  };
  let userSiteRepository: {
    find: jest.Mock<Promise<UserSite[]>, [UserSiteFindArgs]>;
  };
  let transactionalDdsRepository: {
    save: jest.Mock;
    update: jest.Mock;
    softDelete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  const makeUser = (overrides: Partial<User>): User =>
    Object.assign(
      new User(),
      {
        id: 'user-1',
        nome: 'Usuário DDS',
        cpf: null,
        email: 'usuario.dds@example.com',
        funcao: null,
        status: true,
        ai_processing_consent: false,
        company_id: 'company-1',
        site_id: undefined,
        profile_id: 'profile-1',
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
      } satisfies Partial<User>,
      overrides,
    );

  beforeEach(() => {
    signatureRepository = {
      delete: jest.fn(() => Promise.resolve()),
    };
    approvalRepository = {
      find: jest.fn(() =>
        Promise.resolve([
          {
            id: 'approval-approved-1',
            dds_id: 'dds-1',
            company_id: 'company-1',
            cycle: 1,
            level_order: 1,
            action: DdsApprovalAction.APPROVED,
            created_at: new Date('2026-03-15T09:00:00.000Z'),
          },
        ]),
      ),
    };
    siteRepository = {
      findOne: jest.fn((options: SiteFindOneArgs) =>
        Promise.resolve(
          options.where?.id ? ({ id: options.where.id } as Site) : null,
        ),
      ),
    };
    userRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      })),
      find: jest.fn<Promise<User[]>, [UserFindArgs]>((options) => {
        const where = Array.isArray(options.where)
          ? options.where[0]
          : options.where;
        const ids = Array.isArray(where?.id?.value)
          ? where.id.value
          : Array.isArray(where?.id?._value)
            ? where.id._value
            : [];
        return Promise.resolve(ids.map((id) => makeUser({ id })));
      }),
    };
    userSiteRepository = {
      find: jest.fn<Promise<UserSite[]>, [UserSiteFindArgs]>(() =>
        Promise.resolve([]),
      ),
    };
    transactionalDdsRepository = {
      save: jest.fn((input) => Promise.resolve(input as Dds)),
      update: jest.fn(),
      softDelete: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        setLock: jest.fn().mockReturnThis(),
        whereInIds: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      })),
    };
    const manager = {} as MockManager;
    manager.getRepository = jest.fn((entity: unknown) => {
      if (entity === Signature) {
        return signatureRepository;
      }
      if (entity === DdsApprovalRecord) {
        return approvalRepository;
      }
      if (entity === Site) {
        return siteRepository;
      }
      if (entity === User) {
        return userRepository;
      }
      if (entity === UserSite) {
        return userSiteRepository;
      }
      if (entity === Dds) {
        return transactionalDdsRepository;
      }
      return {};
    });
    manager.transaction = jest.fn(
      (callback: (transactionManager: MockManager) => unknown) =>
        callback(manager),
    );
    repository = {
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      save: jest.fn((input) => Promise.resolve(input as Dds)),
      create: jest.fn((input) => input as Dds),
      createQueryBuilder: jest.fn(() => {
        const builder = {
          leftJoin: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
        };
        return builder;
      }),
      manager,
    };
    documentStorageService = {
      generateDocumentKey: jest.fn(
        () => 'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
      ),
      uploadFile: jest.fn(() => Promise.resolve()),
      deleteFile: jest.fn(() => Promise.resolve()),
      getSignedUrl: jest.fn(() =>
        Promise.resolve('https://example.com/dds.pdf'),
      ),
    };
    documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(() =>
        Promise.resolve({
          buffer: Buffer.from('pdf-bundle'),
          fileName: 'DDS-2026-W18.pdf',
        }),
      ),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
      listFinalDocuments: jest.fn(() => Promise.resolve([])),
    };
    documentVideosService = {
      listByDocument: jest.fn(() => Promise.resolve([])),
      uploadForDocument: jest.fn(),
      getAccess: jest.fn(),
      removeFromDocument: jest.fn(),
    };
    signaturesService = {
      findByDocument: jest.fn(() => Promise.resolve([])),
      replaceDocumentSignatures: jest.fn(),
      findManyByDocuments: jest.fn(() => Promise.resolve([])),
    };
    publicValidationGrantService = {
      issueToken: jest.fn(),
    };

    service = new DdsService(
      repository as unknown as Repository<Dds>,
      userRepository as unknown as Repository<User>,
      {
        getTenantId: jest.fn(() => 'company-1'),
        isSuperAdmin: jest.fn(() => false),
        getContext: jest.fn(() => ({
          companyId: 'company-1',
          isSuperAdmin: false,
          siteScope: 'all',
        })),
      } as unknown as TenantService,
      documentStorageService as DocumentStorageService,
      documentBundleService as DocumentBundleService,
      documentGovernanceService as DocumentGovernanceService,
      documentVideosService as DocumentVideosService,
      signaturesService as SignaturesService,
      publicValidationGrantService as PublicValidationGrantService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rejeita company_id forjado no payload ao criar DDS', async () => {
    await expect(
      service.create({
        tema: 'DDS trabalho em altura',
        data: '2026-04-15',
        conteudo: 'Análise das barreiras, permissões e inspeções do turno.',
        site_id: '11111111-1111-4111-8111-111111111111',
        facilitador_id: '22222222-2222-4222-8222-222222222222',
        participants: ['33333333-3333-4333-8333-333333333333'],
        company_id: 'tenant-forjado',
      } as never),
    ).rejects.toThrow(BadRequestException);

    expect(repository.create).not.toHaveBeenCalled();
  });

  it('lista pessoas do DDS filtrando por obra selecionada — apenas funcionarios vinculados a essa obra ou sem obra aparecem para selecao de participantes', async () => {
    const getManyAndCount = jest.fn().mockResolvedValue([
      [
        makeUser({
          id: 'user-1',
          nome: 'Ana TST',
          funcao: 'TST',
          company_id: 'company-1',
          site_id: 'site-1',
          status: true,
        }),
        makeUser({
          id: 'user-2',
          nome: 'Bruno Brigadista',
          funcao: 'Brigadista',
          company_id: 'company-1',
          site_id: undefined,
          status: true,
        }),
        makeUser({
          id: 'user-3',
          nome: 'Carlos Operacional',
          funcao: 'Operador',
          company_id: 'company-1',
          site_id: 'site-1',
          status: false,
        }),
      ],
      3,
    ]);
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getManyAndCount,
    };
    userRepository.createQueryBuilder.mockReturnValue(queryBuilder);

    const result = await service.listPeople({
      page: 1,
      limit: 100,
      siteId: 'site-1',
    });

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'user.company_id = :tenantId',
      { tenantId: 'company-1' },
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'user.deleted_at IS NULL',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      "(user.status = true OR user.password IS NULL OR btrim(user.password) = '')",
    );
    // siteId da obra selecionada gera filtro WHERE — apenas vinculados a essa obra (ou sem obra) aparecem
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('site_id IN (:...siteIds)'),
      { siteIds: ['site-1'] },
    );
    expect(result.data).toEqual([
      {
        id: 'user-1',
        nome: 'Ana TST',
        funcao: 'TST',
        company_id: 'company-1',
        site_id: 'site-1',
        status: true,
      },
      {
        id: 'user-2',
        nome: 'Bruno Brigadista',
        funcao: 'Brigadista',
        company_id: 'company-1',
        site_id: null,
        status: true,
      },
      {
        id: 'user-3',
        nome: 'Carlos Operacional',
        funcao: 'Operador',
        company_id: 'company-1',
        site_id: 'site-1',
        status: false,
      },
    ]);
  });

  it('anexa o PDF final do DDS pela esteira central', async () => {
    const dds = {
      id: 'dds-1',
      company_id: 'company-1',
      site_id: 'site-1',
      tema: 'DDS Trabalho em Altura',
      status: DdsStatus.AUDITADO,
      participants: [{ id: 'user-1' }],
      data: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as Dds;
    const update = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ update })),
    };
    repository.findOne.mockResolvedValue(dds);
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      {
        user_id: 'user-1',
        type: 'digital',
        signature_data: 'sig-1',
      },
    ]);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(manager as never, 'hash-1');
      return { hash: 'hash-1', registryEntry: { id: 'registry-1' } };
    });

    const file = {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-dds'),
    } as Express.Multer.File;

    const result = await service.attachPdf('dds-1', file, {
      userId: 'user-emissor',
      ip: '10.10.10.10',
      userAgent: 'jest-agent',
    });

    expect(result).toEqual(
      expect.objectContaining({
        fileKey: 'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
        folderPath: 'documents/company-1/dds/sites/site-1/dds-1',
        originalName: 'dds-final.pdf',
        storageMode: 's3',
        degraded: false,
      }),
    );
    expect(documentStorageService.generateDocumentKey).toHaveBeenCalledWith(
      'company-1',
      'dds',
      'dds-1',
      'dds-final.pdf',
      { folderSegments: ['sites', 'site-1'] },
    );

    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'dds',
        entityId: 'dds-1',
        documentCode: 'DDS-2026-DDS1',
        fileBuffer: file.buffer,
        createdBy: 'user-emissor',
      }),
    );
    const [id, payload] = update.mock.calls[0] as [
      string,
      {
        pdf_file_key: string;
        pdf_folder_path: string;
        pdf_original_name: string;
        document_code: string;
        final_pdf_hash_sha256: string;
        pdf_generated_at: Date;
        emitted_by_user_id: string | null;
        emitted_ip: string | null;
        emitted_user_agent: string | null;
      },
    ];
    expect(id).toBe('dds-1');
    expect(payload.pdf_file_key).toBe(
      'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
    );
    expect(payload.pdf_folder_path).toBe(
      'documents/company-1/dds/sites/site-1/dds-1',
    );
    expect(payload.pdf_original_name).toBe('dds-final.pdf');
    expect(payload.document_code).toBe('DDS-2026-DDS1');
    expect(payload.final_pdf_hash_sha256).toBe('hash-1');
    expect(payload.pdf_generated_at).toBeInstanceOf(Date);
    expect(payload.emitted_by_user_id).toBe('user-emissor');
    expect(payload.emitted_ip).toBe('10.10.10.10');
    expect(payload.emitted_user_agent).toBe('jest-agent');
  });

  it('bloqueia atualizacao quando ja existe PDF final anexado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/dds/dds-1/dds-final.pdf',
    });

    await expect(
      service.update('dds-1', { tema: 'Novo tema' }),
    ).rejects.toThrow(BadRequestException);

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia atualizacao quando o DDS ja foi auditado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.AUDITADO,
      participants: [{ id: 'user-1' }],
    });

    await expect(
      service.update('dds-1', { tema: 'Novo tema' }),
    ).rejects.toThrow('DDS auditado.');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('getPdfAccess: retorna contrato explicito quando o PDF final ainda nao foi emitido', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    });

    await expect(service.getPdfAccess('dds-1')).resolves.toEqual({
      ddsId: 'dds-1',
      hasFinalPdf: false,
      availability: 'not_emitted',
      message:
        'O DDS ainda não possui PDF final emitido. Gere o documento final para habilitar download governado.',
      degraded: false,
      fileKey: null,
      folderPath: null,
      originalName: null,
      url: null,
    });
  });

  it('getPdfAccess: retorna disponibilidade degradada quando a URL assinada nao pode ser emitida', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/dds/dds-1/dds-final.pdf',
      pdf_folder_path: 'dds/company-1',
      pdf_original_name: 'dds-final.pdf',
    });
    (documentStorageService.getSignedUrl as jest.Mock).mockRejectedValueOnce(
      new Error('storage offline'),
    );

    await expect(service.getPdfAccess('dds-1')).resolves.toEqual({
      ddsId: 'dds-1',
      hasFinalPdf: true,
      availability: 'registered_without_signed_url',
      message:
        'PDF final registrado, mas a URL segura não está disponível no momento. O storage está em modo degradado.',
      degraded: true,
      fileKey: 'documents/company-1/dds/dds-1/dds-final.pdf',
      folderPath: 'dds/company-1',
      originalName: 'dds-final.pdf',
      url: null,
    });
  });

  it('listStoredFiles: retorna contrato da tela com obra e respeita o escopo do DDS', async () => {
    (
      documentGovernanceService.listFinalDocuments as jest.Mock
    ).mockResolvedValue([
      {
        id: 'dds-1',
        entityId: 'dds-1',
        title: 'Titulo do registry',
        date: new Date('2026-04-28T08:00:00.000Z'),
        companyId: 'company-1',
        fileKey: 'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
        folderPath: 'documents/company-1/dds/sites/site-1/dds-1',
        originalName: 'dds-final.pdf',
        module: 'dds',
      },
      {
        id: 'dds-fora-do-escopo',
        entityId: 'dds-fora-do-escopo',
        title: 'Registro sem DDS visivel',
        date: new Date('2026-04-28T09:00:00.000Z'),
        companyId: 'company-1',
        fileKey:
          'documents/company-1/dds/sites/site-2/dds-fora-do-escopo/dds-final.pdf',
        folderPath: 'documents/company-1/dds/sites/site-2/dds-fora-do-escopo',
        originalName: 'dds-final.pdf',
        module: 'dds',
      },
    ]);
    repository.find.mockResolvedValue([
      Object.assign(new Dds(), {
        id: 'dds-1',
        company_id: 'company-1',
        site_id: 'site-1',
        site: { id: 'site-1', nome: 'Obra Norte' } as Site,
        tema: 'DDS Trabalho em Altura',
        data: new Date('2026-04-28T08:00:00.000Z'),
      }),
    ]);

    await expect(
      service.listStoredFiles({ year: 2026, week: 18 }),
    ).resolves.toEqual([
      {
        ddsId: 'dds-1',
        tema: 'DDS Trabalho em Altura',
        data: '2026-04-28',
        companyId: 'company-1',
        siteId: 'site-1',
        siteName: 'Obra Norte',
        fileKey: 'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
        folderPath: 'documents/company-1/dds/sites/site-1/dds-1',
        originalName: 'dds-final.pdf',
      },
    ]);
    expect(documentGovernanceService.listFinalDocuments).toHaveBeenCalledWith(
      'dds',
      { year: 2026, week: 18 },
    );
    expect(repository.find).toHaveBeenCalledWith(
      expect.objectContaining({
        relations: ['site'],
      }),
    );
  });

  it('listStoredFiles: retorna vazio sem consultar documentos quando usuario de obra nao tem site no contexto', async () => {
    service = new DdsService(
      repository as unknown as Repository<Dds>,
      userRepository as unknown as Repository<User>,
      {
        getTenantId: jest.fn(() => 'company-1'),
        isSuperAdmin: jest.fn(() => false),
        getContext: jest.fn(() => ({
          companyId: 'company-1',
          userId: 'user-tst-sem-obra',
          isSuperAdmin: false,
          siteScope: 'single',
          siteIds: [],
        })),
      } as unknown as TenantService,
      documentStorageService as DocumentStorageService,
      documentBundleService as DocumentBundleService,
      documentGovernanceService as DocumentGovernanceService,
      documentVideosService as DocumentVideosService,
      signaturesService as SignaturesService,
      publicValidationGrantService as PublicValidationGrantService,
    );

    await expect(
      service.listStoredFiles({ year: 2026, week: 18 }),
    ).resolves.toEqual([]);
    expect(documentGovernanceService.listFinalDocuments).not.toHaveBeenCalled();
    expect(repository.find).not.toHaveBeenCalled();
  });

  it('getWeeklyBundle: monta pacote apenas com DDS visiveis no escopo da obra', async () => {
    (
      documentGovernanceService.listFinalDocuments as jest.Mock
    ).mockResolvedValue([
      {
        id: 'dds-1',
        entityId: 'dds-1',
        title: 'Titulo do registry',
        date: new Date('2026-04-28T08:00:00.000Z'),
        companyId: 'company-1',
        fileKey: 'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
        folderPath: 'documents/company-1/dds/sites/site-1/dds-1',
        originalName: 'dds-final.pdf',
        module: 'dds',
      },
      {
        id: 'dds-fora-do-escopo',
        entityId: 'dds-fora-do-escopo',
        title: 'Registro sem DDS visivel',
        date: new Date('2026-04-28T09:00:00.000Z'),
        companyId: 'company-1',
        fileKey:
          'documents/company-1/dds/sites/site-2/dds-fora-do-escopo/dds-final.pdf',
        folderPath: 'documents/company-1/dds/sites/site-2/dds-fora-do-escopo',
        originalName: 'dds-fora-do-escopo.pdf',
        module: 'dds',
      },
    ]);
    repository.find.mockResolvedValue([
      Object.assign(new Dds(), {
        id: 'dds-1',
        company_id: 'company-1',
        site_id: 'site-1',
        site: { id: 'site-1', nome: 'Obra Norte' } as Site,
        tema: 'DDS Trabalho em Altura',
        data: new Date('2026-04-28T08:00:00.000Z'),
      }),
    ]);

    await expect(
      service.getWeeklyBundle({ year: 2026, week: 18 }),
    ).resolves.toEqual({
      buffer: Buffer.from('pdf-bundle'),
      fileName: 'DDS-2026-W18.pdf',
    });
    expect(documentBundleService.buildWeeklyPdfBundle).toHaveBeenCalledWith(
      'DDS',
      { year: 2026, week: 18 },
      [
        {
          fileKey: 'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
          title: 'DDS Trabalho em Altura',
          originalName: 'dds-final.pdf',
          date: '2026-04-28',
        },
      ],
    );
  });

  it('getValidationContext: emite token publico assinado para o codigo documental', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      site_id: 'site-1',
      tema: 'DDS Trabalho em Altura',
      data: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    });
    (publicValidationGrantService.issueToken as jest.Mock).mockResolvedValue(
      'token-publico',
    );

    const result = await service.getValidationContext('dds-1');

    expect(result.documentCode).toBe('DDS-2026-DDS1');
    expect(result.token).toBe('token-publico');
    expect(publicValidationGrantService.issueToken).toHaveBeenCalledWith({
      code: 'DDS-2026-DDS1',
      companyId: 'company-1',
      portal: 'dds_public_validation',
      documentId: 'dds-1',
    });
  });

  it('falha o anexo final quando o storage governado do DDS está indisponível', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      site_id: 'site-1',
      tema: 'DDS Trabalho em Altura',
      status: DdsStatus.AUDITADO,
      participants: [{ id: 'user-1' }],
      data: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    });
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      {
        user_id: 'user-1',
        type: 'digital',
        signature_data: 'sig-1',
      },
    ]);
    (documentStorageService.uploadFile as jest.Mock).mockRejectedValue(
      new Error('S3 is not enabled'),
    );

    const file = {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-dds'),
    } as Express.Multer.File;

    await expect(service.attachPdf('dds-1', file)).rejects.toThrow(
      'S3 is not enabled',
    );

    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('updateAudit: bloqueia DDS auditado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      site_id: 'site-1',
      facilitador_id: 'user-1',
      participants: [{ id: 'user-1' }],
      status: DdsStatus.AUDITADO,
    });

    await expect(
      service.updateAudit('dds-1', {
        auditado_por_id: 'user-2',
        data_auditoria: '2026-03-15T10:00:00.000Z',
        resultado_auditoria: 'Conforme' as never,
      }),
    ).rejects.toThrow('DDS auditado não pode ter auditoria alterada.');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('updateAudit: bloqueia DDS com PDF final emitido', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      site_id: 'site-1',
      facilitador_id: 'user-1',
      participants: [{ id: 'user-1' }],
      status: DdsStatus.PUBLICADO,
      pdf_file_key: 'documents/company-1/dds/dds-1/dds-final.pdf',
    });

    await expect(
      service.updateAudit('dds-1', {
        auditado_por_id: 'user-2',
        data_auditoria: '2026-03-15T10:00:00.000Z',
        resultado_auditoria: 'Conforme' as never,
      }),
    ).rejects.toThrow(
      'DDS com PDF final emitido não pode ter auditoria alterada.',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('uploadVideoAttachment: bloqueia DDS auditado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.AUDITADO,
      is_modelo: false,
    });

    await expect(
      service.uploadVideoAttachment(
        'dds-1',
        {
          buffer: Buffer.from('video'),
          originalName: 'evidencia.mp4',
          mimeType: 'video/mp4',
        },
        'operador-1',
      ),
    ).rejects.toThrow('DDS auditado.');

    expect(documentVideosService.uploadForDocument).not.toHaveBeenCalled();
  });

  it('rejeita criacao quando o site nao pertence a empresa do DDS', async () => {
    siteRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      service.create({
        tema: 'DDS Integridade',
        data: '2026-03-14',
        site_id: 'site-x',
        facilitador_id: 'user-1',
        participants: ['user-1'],
      }),
    ).rejects.toThrow('O site informado não pertence à empresa atual do DDS.');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejeita participante fora da obra selecionada ao criar DDS', async () => {
    userRepository.find
      .mockResolvedValueOnce([makeUser({ id: 'facilitador-1' })])
      .mockResolvedValueOnce([]);

    await expect(
      service.create({
        tema: 'DDS Integridade',
        data: '2026-03-14',
        site_id: 'site-1',
        facilitador_id: 'facilitador-1',
        participants: ['participante-outra-obra'],
      }),
    ).rejects.toThrow(
      'Participantes informado(s) não pertencem à obra/setor selecionada do DDS.',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('permite participante company-scoped no DDS da obra selecionada', async () => {
    userRepository.find
      .mockResolvedValueOnce([makeUser({ id: 'facilitador-1' })])
      .mockResolvedValueOnce([makeUser({ id: 'participante-company-scoped' })]);

    await service.create({
      tema: 'DDS Integridade',
      data: '2026-03-14',
      site_id: 'site-1',
      facilitador_id: 'facilitador-1',
      participants: ['participante-company-scoped'],
    });

    const participantFindArgs = userRepository.find.mock.calls[1]?.[0];
    expect(Array.isArray(participantFindArgs?.where)).toBe(true);
    if (!Array.isArray(participantFindArgs?.where)) {
      throw new Error('Consulta de participantes deve usar filtros por obra.');
    }
    expect(participantFindArgs.where[0]).toMatchObject({ site_id: 'site-1' });
    expect(participantFindArgs.where[1]?.site_id).toEqual(expect.any(Object));
    expect(repository.save).toHaveBeenCalled();
  });

  it('permite participante vinculado à obra via user_sites ao criar DDS', async () => {
    userRepository.find
      .mockResolvedValueOnce([makeUser({ id: 'facilitador-1' })])
      .mockResolvedValueOnce([]);
    userSiteRepository.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { user_id: 'participante-vinculado' },
      ] as UserSite[]);

    await service.create({
      tema: 'DDS Integridade',
      data: '2026-03-14',
      site_id: 'site-1',
      facilitador_id: 'facilitador-1',
      participants: ['participante-vinculado'],
    });

    const participantSiteFindArgs = userSiteRepository.find.mock.calls[1]?.[0];
    expect(participantSiteFindArgs?.where).toMatchObject({
      site_id: 'site-1',
    });
    expect(repository.save).toHaveBeenCalled();
  });

  it('bloqueia transicao de status quando ja existe PDF final anexado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: 'rascunho',
      pdf_file_key: 'documents/company-1/dds/dds-1/dds-final.pdf',
    });

    await expect(
      service.updateStatus('dds-1', DdsStatus.PUBLICADO),
    ).rejects.toThrow(BadRequestException);

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia novo anexo quando o DDS ja possui PDF final', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/dds/dds-1/dds-final.pdf',
    });

    const file = {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-dds'),
    } as Express.Multer.File;

    await expect(service.attachPdf('dds-1', file)).rejects.toThrow(
      BadRequestException,
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
  });

  it('remove o DDS via esteira central e aplica a policy de lifecycle', async () => {
    const dds = {
      id: 'dds-1',
      company_id: 'company-1',
    } as Dds;
    const softDelete = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ softDelete })),
    };
    repository.findOne.mockResolvedValue(dds);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: RemoveFinalDocumentReferenceInput) => {
      await input.removeEntityState?.(manager as never);
    });

    await expect(service.remove('dds-1')).resolves.toBeUndefined();

    const [removeInput] = (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mock.calls[0] as [RemoveFinalDocumentReferenceInput];
    expect(removeInput.companyId).toBe('company-1');
    expect(removeInput.module).toBe('dds');
    expect(removeInput.entityId).toBe('dds-1');
    expect(typeof removeInput.removeEntityState).toBe('function');
    expect(softDelete).toHaveBeenCalledWith('dds-1');
  });

  it('remove o arquivo do DDS do storage quando a governanca falha depois do upload', async () => {
    const dds = {
      id: 'dds-1',
      company_id: 'company-1',
      site_id: 'site-1',
      tema: 'DDS Trabalho em Altura',
      status: DdsStatus.AUDITADO,
      participants: [{ id: 'user-1' }],
      data: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as Dds;
    repository.findOne.mockResolvedValue(dds);
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      {
        user_id: 'user-1',
        type: 'digital',
        signature_data: 'sig-1',
      },
    ]);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance failed'));

    const file = {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-dds'),
    } as Express.Multer.File;

    await expect(service.attachPdf('dds-1', file)).rejects.toThrow(
      'governance failed',
    );

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'documents/company-1/dds/sites/site-1/dds-1/dds-final.pdf',
    );
  });

  it('bloqueia PDF final quando o DDS ainda esta em rascunho', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.RASCUNHO,
      participants: [{ id: 'user-1' }],
      created_at: new Date('2026-03-14T07:00:00.000Z'),
      data: new Date('2026-03-14T08:00:00.000Z'),
    });

    const file = {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-dds'),
    } as Express.Multer.File;

    await expect(service.attachPdf('dds-1', file)).rejects.toThrow(
      'O DDS precisa estar auditado por fluxo de aprovação antes do anexo do PDF final.',
    );

    expect(signaturesService.findByDocument).not.toHaveBeenCalled();
    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('bloqueia PDF final quando faltam assinaturas de participantes', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.AUDITADO,
      participants: [{ id: 'user-1' }, { id: 'user-2' }],
      created_at: new Date('2026-03-14T07:00:00.000Z'),
      data: new Date('2026-03-14T08:00:00.000Z'),
    });
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      {
        user_id: 'user-1',
        type: 'digital',
        signature_data: 'sig-1',
      },
    ]);

    const file = {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-dds'),
    } as Express.Multer.File;

    await expect(service.attachPdf('dds-1', file)).rejects.toThrow(
      'Todos os participantes precisam assinar o DDS antes do anexo do PDF final.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('updateStatus: avanca status de rascunho para publicado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.RASCUNHO,
      is_modelo: false,
    });

    const result = await service.updateStatus('dds-1', DdsStatus.PUBLICADO);
    expect(result.status).toBe(DdsStatus.PUBLICADO);
    expect(repository.save).toHaveBeenCalled();
  });

  it('updateStatus: rejeita transicao invalida', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.AUDITADO,
      is_modelo: false,
    });

    await expect(
      service.updateStatus('dds-1', DdsStatus.PUBLICADO),
    ).rejects.toThrow(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('updateStatus: bloqueia publicacao de modelo de DDS', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.RASCUNHO,
      is_modelo: true,
    });

    await expect(
      service.updateStatus('dds-1', DdsStatus.PUBLICADO),
    ).rejects.toThrow('Modelos de DDS não podem ser publicados ou auditados.');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('updateStatus: bloqueia auditoria de modelo de DDS', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.PUBLICADO,
      is_modelo: true,
    });

    await expect(
      service.updateStatus('dds-1', DdsStatus.AUDITADO),
    ).rejects.toThrow(BadRequestException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia PDF final quando o DDS auditado nao possui fluxo de aprovacao concluido', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      site_id: 'site-1',
      participants: [{ id: 'user-1' }],
      data: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
      status: DdsStatus.AUDITADO,
      is_modelo: false,
      auditado_por_id: 'auditor-1',
      data_auditoria: new Date('2026-03-15T10:00:00.000Z'),
      resultado_auditoria: 'Conforme',
    });
    approvalRepository.find.mockResolvedValue([
      {
        id: 'approval-1',
        dds_id: 'dds-1',
        company_id: 'company-1',
        cycle: 1,
        level_order: 1,
        action: DdsApprovalAction.PENDING,
        created_at: new Date('2026-03-15T09:00:00.000Z'),
      },
    ]);

    const file = {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-dds'),
    } as Express.Multer.File;

    await expect(service.attachPdf('dds-1', file)).rejects.toThrow(
      'O DDS precisa ter fluxo de aprovação concluído antes do anexo do PDF final.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('replaceSignatures: rejeita quando DDS nao tem participantes', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      facilitador_id: 'facilitador-1',
      participants: [],
      is_modelo: false,
    });

    await expect(
      service.replaceSignatures(
        'dds-1',
        { participant_signatures: [] },
        'operador-1',
      ),
    ).rejects.toThrow(
      'O DDS precisa ter participantes definidos antes das assinaturas.',
    );
    expect(signaturesService.replaceDocumentSignatures).not.toHaveBeenCalled();
  });

  it('listSignatures: valida o DDS no tenant antes de buscar assinaturas', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.PUBLICADO,
    });
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      {
        id: 'signature-1',
        document_id: 'dds-1',
        document_type: 'DDS',
      },
    ]);

    await expect(service.listSignatures('dds-1')).resolves.toHaveLength(1);

    expect(repository.findOne).toHaveBeenCalledTimes(1);
    expect(signaturesService.findByDocument).toHaveBeenCalledWith(
      'dds-1',
      'DDS',
    );
  });

  it('replaceSignatures: bloqueia DDS auditado', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.AUDITADO,
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: false,
    });

    await expect(
      service.replaceSignatures(
        'dds-1',
        {
          participant_signatures: [
            { user_id: 'user-1', signature_data: 'sig', type: 'digital' },
          ],
        },
        'operador-1',
      ),
    ).rejects.toThrow('DDS auditado.');

    expect(signaturesService.replaceDocumentSignatures).not.toHaveBeenCalled();
  });

  it('invalida assinaturas existentes quando o conteudo operacional do DDS muda', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.PUBLICADO,
      tema: 'DDS antigo',
      conteudo: 'Conteudo inicial',
      data: new Date('2026-03-14T08:00:00.000Z'),
      site_id: 'site-1',
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: false,
    });

    await expect(
      service.update('dds-1', {
        conteudo: 'Conteudo revisado',
        confirm_signature_reset: true,
      }),
    ).resolves.toMatchObject({
      id: 'dds-1',
      conteudo: 'Conteudo revisado',
    });

    expect(signatureRepository.delete).toHaveBeenCalledWith({
      company_id: 'company-1',
      document_id: 'dds-1',
      document_type: 'DDS',
    });
  });

  it('bloqueia edicao quando o DDS possui aprovacao pendente', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      status: DdsStatus.PUBLICADO,
      tema: 'DDS antigo',
      conteudo: 'Conteudo inicial',
      data: new Date('2026-03-14T08:00:00.000Z'),
      site_id: 'site-1',
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: false,
    });
    approvalRepository.find.mockResolvedValue([
      {
        id: 'approval-1',
        dds_id: 'dds-1',
        company_id: 'company-1',
        cycle: 1,
        level_order: 1,
        action: DdsApprovalAction.PENDING,
        created_at: new Date('2026-03-15T09:00:00.000Z'),
      },
    ]);

    await expect(
      service.update('dds-1', {
        conteudo: 'Conteudo revisado',
      }),
    ).rejects.toThrow('DDS com aprovação em andamento não pode ser alterado.');
  });

  it('replaceSignatures: rejeita quando DDS e um modelo', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: true,
    });

    await expect(
      service.replaceSignatures(
        'dds-1',
        {
          participant_signatures: [
            { user_id: 'user-1', signature_data: 'sig', type: 'digital' },
          ],
        },
        'operador-1',
      ),
    ).rejects.toThrow(
      'Modelos de DDS não podem receber assinaturas de execução.',
    );
    expect(signaturesService.replaceDocumentSignatures).not.toHaveBeenCalled();
  });

  it('operationalizeTemplate: revalida site e facilitador no tenant', async () => {
    repository.findOne.mockResolvedValue({
      id: 'template-1',
      company_id: 'company-1',
      site_id: 'site-1',
      facilitador_id: 'facilitador-1',
      is_modelo: true,
      tema: 'Modelo DDS',
      conteudo: 'Conteudo',
    });
    siteRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      service.operationalizeTemplate('template-1', {
        site_id: 'site-outra-empresa',
      }),
    ).rejects.toThrow('O site informado não pertence à empresa atual do DDS.');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('replaceSignatures: rejeita participante fora do DDS', async () => {
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: false,
    });

    await expect(
      service.replaceSignatures(
        'dds-1',
        {
          participant_signatures: [
            { user_id: 'user-externo', signature_data: 'sig', type: 'digital' },
          ],
        },
        'operador-1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(signaturesService.replaceDocumentSignatures).not.toHaveBeenCalled();
  });

  it('replaceSignatures: rejeita foto duplicada sem justificativa', async () => {
    repository.createQueryBuilder.mockImplementationOnce(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'dds-old', tema: 'DDS antigo', data: '2026-03-10' },
        ]),
    }));
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: false,
    });
    (signaturesService.findManyByDocuments as jest.Mock).mockResolvedValue([
      {
        document_id: 'dds-old',
        type: 'team_photo_1',
        signature_data: JSON.stringify({
          imageData: 'data:image/jpeg;base64,old',
          capturedAt: '2026-03-10T08:00:00.000Z',
          hash: 'hash-dup',
          metadata: { userAgent: 'jest' },
        }),
      },
    ]);

    await expect(
      service.replaceSignatures(
        'dds-1',
        {
          participant_signatures: [
            { user_id: 'user-1', signature_data: 'sig', type: 'digital' },
          ],
          team_photos: [
            {
              imageData: 'data:image/jpeg;base64,new',
              capturedAt: '2026-03-14T08:00:00.000Z',
              hash: 'hash-dup',
              metadata: { userAgent: 'jest' },
            },
          ],
          // sem photo_reuse_justification
        },
        'operador-1',
      ),
    ).rejects.toThrow('Detectamos reuso potencial de foto.');
    expect(signaturesService.replaceDocumentSignatures).not.toHaveBeenCalled();
  });

  it('replaceSignatures: aceita assinaturas sem fotos duplicadas normalmente', async () => {
    repository.createQueryBuilder.mockImplementationOnce(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    }));
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: false,
    });

    const result = await service.replaceSignatures(
      'dds-1',
      {
        participant_signatures: [
          { user_id: 'user-1', signature_data: 'sig-1', type: 'digital' },
        ],
        team_photos: [
          {
            imageData: 'data:image/jpeg;base64,photo',
            capturedAt: '2026-03-14T08:00:00.000Z',
            hash: 'hash-novo',
            metadata: { userAgent: 'jest' },
          },
        ],
      },
      'operador-1',
    );

    expect(result.participantSignatures).toBe(1);
    expect(result.teamPhotos).toBe(1);
    expect(result.duplicatePhotoWarnings).toHaveLength(0);
    expect(signaturesService.replaceDocumentSignatures).toHaveBeenCalledTimes(
      1,
    );
  });

  it('persiste assinaturas do DDS com o participante correto e justificativa de reuso quando necessario', async () => {
    repository.createQueryBuilder.mockImplementationOnce(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          id: 'dds-old',
          tema: 'DDS antigo',
          data: '2026-03-10',
        },
      ]),
    }));
    repository.findOne.mockResolvedValue({
      id: 'dds-1',
      company_id: 'company-1',
      facilitador_id: 'facilitador-1',
      participants: [{ id: 'user-1' }],
      is_modelo: false,
    });
    (signaturesService.findManyByDocuments as jest.Mock).mockResolvedValue([
      {
        document_id: 'dds-old',
        type: 'team_photo_1',
        signature_data: JSON.stringify({
          imageData: 'data:image/jpeg;base64,old-photo',
          capturedAt: '2026-03-10T08:00:00.000Z',
          hash: 'hash-duplicado',
          metadata: { userAgent: 'jest' },
        }),
      },
    ]);

    await expect(
      service.replaceSignatures(
        'dds-1',
        {
          participant_signatures: [
            {
              user_id: 'user-1',
              signature_data: '1234',
              type: 'hmac',
              pin: '1234',
            },
          ],
          team_photos: [
            {
              imageData: 'data:image/jpeg;base64,new-photo',
              capturedAt: '2026-03-14T08:00:00.000Z',
              hash: 'hash-duplicado',
              metadata: { userAgent: 'jest' },
            },
          ],
          photo_reuse_justification:
            'Equipe reaproveitou a mesma imagem por indisponibilidade temporaria de camera em campo.',
        },
        'operador-1',
      ),
    ).resolves.toEqual({
      participantSignatures: 1,
      teamPhotos: 1,
      duplicatePhotoWarnings: ['hash-duplicado'],
    });

    const replaceCalls = (
      signaturesService.replaceDocumentSignatures as jest.Mock
    ).mock.calls as Array<
      [
        {
          document_id: string;
          document_type: string;
          authenticated_user_id: string;
          signatures: Array<{
            user_id: string;
            signer_user_id?: string;
            type: string;
            pin?: string;
          }>;
        },
      ]
    >;
    const replaceCall = replaceCalls[0]?.[0];

    expect(replaceCall).toBeDefined();
    expect(replaceCall.document_id).toBe('dds-1');
    expect(replaceCall.document_type).toBe('DDS');
    expect(replaceCall.authenticated_user_id).toBe('operador-1');
    expect(replaceCall.signatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: 'user-1',
          signer_user_id: 'user-1',
          type: 'hmac',
          pin: '1234',
        }),
        expect.objectContaining({
          user_id: 'facilitador-1',
          signer_user_id: 'facilitador-1',
          type: 'team_photo_1',
        }),
      ]),
    );

    // Justificativa de reuso de foto agora é salva na coluna dds.photo_reuse_justification,
    // não mais como uma entrada na tabela de assinaturas.
    const [, updatedPayload] = transactionalDdsRepository.update.mock
      .calls[0] as [string, { photo_reuse_justification?: string }];
    expect(transactionalDdsRepository.update).toHaveBeenCalledWith(
      'dds-1',
      expect.any(Object),
    );
    expect(updatedPayload.photo_reuse_justification).toContain(
      'indisponibilidade',
    );
  });

  it('getHistoricalPhotoHashes: falha fechado sem tenant no contexto', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    repository.createQueryBuilder.mockReturnValue(queryBuilder);

    const serviceWithoutTenant = new DdsService(
      repository as unknown as Repository<Dds>,
      userRepository as unknown as Repository<User>,
      {
        getTenantId: jest.fn(() => null),
      } as unknown as TenantService,
      documentStorageService as DocumentStorageService,
      documentBundleService as DocumentBundleService,
      documentGovernanceService as DocumentGovernanceService,
      documentVideosService as DocumentVideosService,
      signaturesService as SignaturesService,
      publicValidationGrantService as PublicValidationGrantService,
    );

    await expect(
      serviceWithoutTenant.getHistoricalPhotoHashes(50, undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(queryBuilder.where).not.toHaveBeenCalled();
    expect(signaturesService.findManyByDocuments).not.toHaveBeenCalled();
  });

  it('getHistoricalPhotoHashes: usa apenas o tenant autenticado', async () => {
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    repository.createQueryBuilder.mockReturnValue(queryBuilder);

    await service.getHistoricalPhotoHashes(50, undefined);

    expect(queryBuilder.where).toHaveBeenCalledWith(
      'dds.company_id = :companyScopeId',
      { companyScopeId: 'company-1' },
    );
    expect(signaturesService.findManyByDocuments).toHaveBeenCalledWith(
      [],
      'DDS',
      expect.objectContaining({ companyId: 'company-1' }),
    );
  });
});
