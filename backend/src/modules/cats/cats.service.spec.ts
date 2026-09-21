import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import type { AuditService } from '../audit-trail/audit.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import { markAuthorizedStorageReference } from '../../shared/storage/storage-object-reference';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { DocumentRegistryService } from '../document-registry/document-registry.service';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import { CatsService } from './cats.service';
import type { CreateCatDto } from './dto/create-cat.dto';
import type { UpdateCatDto } from './dto/update-cat.dto';
import { Cat } from './entities/cat.entity';

const COMPANY_ID = 'company-1';
const CAT_ID = '11111111-2222-3333-4444-555555555555';

function makeCat(overrides: Partial<Cat> = {}): Cat {
  return {
    id: CAT_ID,
    numero: 'CAT-20260319-0001',
    company_id: COMPANY_ID,
    site_id: 'site-1',
    data_ocorrencia: new Date('2026-03-19T10:00:00Z'),
    tipo: 'tipico',
    gravidade: 'moderada',
    descricao: 'Queda sem afastamento',
    status: 'aberta',
    attachments: [],
    created_at: new Date('2026-03-19T10:00:00Z'),
    updated_at: new Date('2026-03-19T10:00:00Z'),
    ...overrides,
  } as Cat;
}

describe('CatsService', () => {
  let service: CatsService;
  let catsRepository: {
    create: jest.Mock;
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
  };
  let queryBuilder: {
    leftJoinAndSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    groupBy: jest.Mock;
    getRawMany: jest.Mock;
  };
  let usersRepository: { exist: jest.Mock };
  let sitesRepository: { exist: jest.Mock };
  /** Linha devolvida pelo SELECT ... FOR UPDATE NOWAIT em cada teste. */
  let _lockedCatRow: Record<string, unknown> | null = null;
  let tenantService: Pick<TenantService, 'getContext' | 'getTenantId'>;
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'generateDocumentKey'
    | 'referenceForExistingObject'
    | 'uploadFile'
    | 'uploadFileWithCapability'
    | 'getSignedUrl'
    | 'deleteFile'
  >;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    'registerFinalDocument'
  >;
  let documentRegistryService: Pick<DocumentRegistryService, 'findByDocument'>;
  let auditService: Pick<AuditService, 'log'>;

  beforeEach(() => {
    queryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    catsRepository = {
      create: jest.fn((input: Partial<Cat>) => ({ ...input }) as Cat),
      createQueryBuilder: jest.fn(() => queryBuilder),
      findOne: jest.fn(),
      save: jest.fn((input: Cat) => Promise.resolve(input)),
      count: jest.fn().mockResolvedValue(0),
    };
    // `addAttachment`/`removeAttachment` passaram a mutar o jsonb `attachments`
    // sob SELECT ... FOR UPDATE NOWAIT dentro de uma transação, para impedir que
    // dois uploads concorrentes sobrescrevam um ao outro. O mock reproduz esse
    // caminho: `query` devolve a linha travada e `getRepository` devolve um repo
    // que delega ao mock principal, de modo que as asserções sobre `save`
    // continuem valendo.
    _lockedCatRow = null;
    (
      catsRepository as unknown as { manager: { transaction: jest.Mock } }
    ).manager = {
      transaction: jest.fn((fn: (m: unknown) => unknown) => {
        const lockedRow = _lockedCatRow;
        const innerManager = {
          query: jest.fn().mockResolvedValue(lockedRow ? [lockedRow] : []),
          getRepository: jest.fn().mockReturnValue({
            create: jest.fn((data: unknown) => data as Cat),
            save: jest.fn(
              (data: Cat): Promise<Cat> =>
                catsRepository.save(data) as Promise<Cat>,
            ),
          }),
        };
        return fn(innerManager);
      }),
    };
    usersRepository = {
      exist: jest.fn().mockResolvedValue(true),
    };
    sitesRepository = {
      exist: jest.fn().mockResolvedValue(true),
    };
    tenantService = {
      getContext: jest.fn(() => undefined),
      getTenantId: jest.fn(() => COMPANY_ID),
    };
    documentStorageService = {
      referenceForExistingObject: jest.fn((key: string, owner, purpose) => ({
        tenantId: COMPANY_ID,
        key,
        owner,
        purpose,
      })),
      generateDocumentKey: jest
        .fn()
        .mockReturnValue(
          'documents/company-1/cats/sites/site-1/cat-1/cat-final.pdf',
        ),
      uploadFile: jest.fn().mockResolvedValue(undefined),
      uploadFileWithCapability: jest.fn((reference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
      ),
      getSignedUrl: jest
        .fn()
        .mockResolvedValue('https://storage.example.test/cat-final.pdf'),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn().mockResolvedValue({
        hash: 'hash-cat-pdf',
        registryEntry: {
          id: 'registry-1',
          document_code: 'CAT-2026-11111111',
        },
      }),
    };
    documentRegistryService = {
      findByDocument: jest.fn().mockResolvedValue(null),
    };
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    service = new CatsService(
      catsRepository as unknown as Repository<Cat>,
      usersRepository as unknown as Repository<User>,
      sitesRepository as unknown as Repository<Site>,
      tenantService as TenantService,
      documentStorageService as DocumentStorageService,
      documentGovernanceService as DocumentGovernanceService,
      documentRegistryService as DocumentRegistryService,
      auditService as AuditService,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const useSiteScopedTenant = (siteIds = ['site-1']): void => {
    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: COMPANY_ID,
      userId: 'viewer-1',
      isSuperAdmin: false,
      siteScope: 'single',
      siteIds,
    });
  };

  it('bloqueia create quando o site nao pertence a empresa atual', async () => {
    sitesRepository.exist.mockResolvedValue(false);

    const dto: CreateCatDto = {
      numero: 'CAT-20260319-0007',
      data_ocorrencia: '2026-03-19T10:00:00.000Z',
      descricao: 'Descricao da CAT',
      site_id: 'site-outra-empresa',
    };

    await expect(service.create(dto, 'user-1')).rejects.toThrow(
      new BadRequestException(
        'Obra/setor informado não pertence à empresa atual.',
      ),
    );
    expect(catsRepository.save).not.toHaveBeenCalled();
  });

  it('bloqueia create em obra fora do escopo do usuario', async () => {
    useSiteScopedTenant(['site-1']);

    await expect(
      service.create(
        {
          numero: 'CAT-20260319-0008',
          data_ocorrencia: '2026-03-19T10:00:00.000Z',
          descricao: 'Descricao da CAT',
          site_id: 'site-2',
        },
        'user-1',
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(sitesRepository.exist).not.toHaveBeenCalled();
    expect(catsRepository.save).not.toHaveBeenCalled();
  });

  it('restringe listagem e resumo ao escopo de obra do usuario', async () => {
    useSiteScopedTenant(['site-1']);

    await service.findPaginated({ page: 1, limit: 20 });
    await service.getSummary();

    const [countOptions] = catsRepository.count.mock.calls[0] as [
      { where: { company_id: string; site_id: unknown } },
    ];

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'cat.site_id IN (:...currentSiteIds)',
      { currentSiteIds: ['site-1'] },
    );
    expect(countOptions.where.company_id).toBe(COMPANY_ID);
    expect(countOptions.where.site_id).toBeDefined();
  });

  it('bloqueia update quando o colaborador nao pertence a empresa atual', async () => {
    catsRepository.findOne.mockResolvedValue(makeCat());
    usersRepository.exist.mockResolvedValue(false);

    const dto: UpdateCatDto = {
      worker_id: 'worker-outra-empresa',
    };

    await expect(service.update(CAT_ID, dto, 'user-1')).rejects.toThrow(
      new BadRequestException(
        'Colaborador informado não pertence à empresa atual.',
      ),
    );
    expect(catsRepository.save).not.toHaveBeenCalled();
  });

  it('limpa o arquivo do storage quando o save do anexo falha', async () => {
    const cat = makeCat();
    catsRepository.findOne.mockResolvedValue(cat);
    // Linha devolvida pelo SELECT ... FOR UPDATE NOWAIT do lock de anexos.
    _lockedCatRow = cat as unknown as Record<string, unknown>;
    catsRepository.save.mockRejectedValueOnce(new Error('db-failure'));

    await expect(
      service.addAttachment(
        CAT_ID,
        {
          fileBuffer: Buffer.from('conteudo-cat'),
          originalName: 'evidencia-cat.pdf',
          mimeType: 'application/pdf',
        },
        'user-1',
      ),
    ).rejects.toThrow('db-failure');

    expect(
      documentStorageService.uploadFileWithCapability,
    ).toHaveBeenCalledTimes(1);
    expect(documentStorageService.deleteFile).toHaveBeenCalledTimes(1);
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it('bloqueia novo anexo quando a CAT está fechada', async () => {
    catsRepository.findOne.mockResolvedValue(makeCat({ status: 'fechada' }));

    await expect(
      service.addAttachment(
        CAT_ID,
        {
          fileBuffer: Buffer.from('conteudo-cat'),
          originalName: 'evidencia-cat.pdf',
          mimeType: 'application/pdf',
        },
        'user-1',
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'CAT fechada ou com PDF final não aceita alteração de anexos.',
      ),
    );

    expect(
      documentStorageService.uploadFileWithCapability,
    ).not.toHaveBeenCalled();
    expect(catsRepository.save).not.toHaveBeenCalled();
  });

  it('remove o arquivo do storage ao excluir anexo da CAT', async () => {
    const attachment = {
      id: 'attachment-1',
      file_name: 'evidencia-cat.pdf',
      file_key: 'cats/company-1/2026/03/file.pdf',
      file_type: 'application/pdf',
      category: 'geral' as const,
      uploaded_at: new Date('2026-03-19T10:00:00Z'),
      uploaded_by_id: 'user-1',
    };
    const cat = makeCat({ attachments: [attachment] });
    catsRepository.findOne.mockResolvedValue(cat);
    // A remoção também roda sob lock: o SELECT ... FOR UPDATE NOWAIT devolve a
    // mesma CAT, de onde o anexo alvo é filtrado.
    _lockedCatRow = cat as unknown as Record<string, unknown>;

    await service.removeAttachment(CAT_ID, attachment.id, 'user-1');

    expect(catsRepository.save).toHaveBeenCalledTimes(1);
    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ key: attachment.file_key }),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        entity: 'CAT',
        entityId: CAT_ID,
        companyId: COMPANY_ID,
      }),
    );
  });

  it('bloqueia remoção de anexo quando a CAT está fechada', async () => {
    const attachment = {
      id: 'attachment-1',
      file_name: 'evidencia-cat.pdf',
      file_key: 'cats/company-1/2026/03/file.pdf',
      file_type: 'application/pdf',
      category: 'geral' as const,
      uploaded_at: new Date('2026-03-19T10:00:00Z'),
      uploaded_by_id: 'user-1',
    };
    catsRepository.findOne.mockResolvedValue(
      makeCat({ status: 'fechada', attachments: [attachment] }),
    );
    _lockedCatRow = makeCat({
      status: 'fechada',
      attachments: [attachment],
    }) as unknown as Record<string, unknown>;

    await expect(
      service.removeAttachment(CAT_ID, attachment.id, 'user-1'),
    ).rejects.toThrow(
      new BadRequestException(
        'CAT fechada ou com PDF final não aceita alteração de anexos.',
      ),
    );

    expect(catsRepository.save).not.toHaveBeenCalled();
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('gera acesso ao anexo e registra auditoria de leitura', async () => {
    const attachment = {
      id: 'attachment-1',
      file_name: 'evidencia-cat.pdf',
      file_key: 'cats/company-1/2026/03/file.pdf',
      file_type: 'application/pdf',
      category: 'investigacao' as const,
      uploaded_at: new Date('2026-03-19T10:00:00Z'),
      uploaded_by_id: 'user-1',
    };
    catsRepository.findOne.mockResolvedValue(
      makeCat({
        attachments: [attachment],
      }),
    );

    const result = await service.getAttachmentAccess(
      CAT_ID,
      attachment.id,
      'viewer-1',
    );

    expect(result).toEqual({
      attachmentId: attachment.id,
      fileName: attachment.file_name,
      fileType: attachment.file_type,
      url: 'https://storage.example.test/cat-final.pdf',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.READ,
        entity: 'CAT',
        entityId: CAT_ID,
        companyId: COMPANY_ID,
      }),
    );
  });

  it('falha quando o anexo solicitado nao existe', async () => {
    catsRepository.findOne.mockResolvedValue(makeCat());

    await expect(
      service.getAttachmentAccess(CAT_ID, 'attachment-inexistente', 'viewer-1'),
    ).rejects.toThrow(
      new NotFoundException('Anexo não encontrado para esta CAT.'),
    );
  });

  it('retorna contrato explicito quando a CAT ainda nao possui PDF final governado', async () => {
    catsRepository.findOne.mockResolvedValue(
      makeCat({
        pdf_file_key: undefined,
      }),
    );

    await expect(service.getPdfAccess(CAT_ID)).resolves.toEqual({
      catId: CAT_ID,
      hasFinalPdf: false,
      availability: 'not_emitted',
      message:
        'A CAT ainda não possui PDF final emitido. Gere o documento final governado para habilitar download e envio oficial.',
      degraded: false,
      fileKey: null,
      folderPath: null,
      originalName: null,
      fileHash: null,
      documentCode: 'CAT-2026-11111111',
      url: null,
    });
  });

  it('nao localiza PDF de CAT fora do escopo de obra do usuario', async () => {
    useSiteScopedTenant(['site-1']);
    catsRepository.findOne.mockResolvedValue(null);

    await expect(service.getPdfAccess(CAT_ID)).rejects.toThrow(
      NotFoundException,
    );
    const [findOptions] = catsRepository.findOne.mock.calls[0] as [
      { where: { company_id: string; site_id: unknown } },
    ];

    expect(findOptions.where.company_id).toBe(COMPANY_ID);
    expect(findOptions.where.site_id).toBeDefined();
  });

  it('anexa PDF final governado quando a CAT esta fechada', async () => {
    catsRepository.findOne.mockResolvedValue(
      makeCat({
        status: 'fechada',
      }),
    );

    const file = {
      originalname: 'cat-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('pdf'),
    } as Express.Multer.File;

    const result = await service.attachPdf(CAT_ID, file, 'user-1');

    expect(documentStorageService.generateDocumentKey).toHaveBeenCalledWith(
      COMPANY_ID,
      'cats',
      CAT_ID,
      'cat-final.pdf',
      { folderSegments: ['sites', 'site-1'] },
    );
    expect(documentGovernanceService.registerFinalDocument).toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        catId: CAT_ID,
        hasFinalPdf: true,
        availability: 'ready',
        fileHash: 'hash-cat-pdf',
      }),
    );
  });

  it('bloqueia emissao de PDF final para CAT que ainda nao foi fechada', async () => {
    catsRepository.findOne.mockResolvedValue(
      makeCat({
        status: 'investigacao',
      }),
    );

    const file = {
      originalname: 'cat-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('pdf'),
    } as Express.Multer.File;

    await expect(service.attachPdf(CAT_ID, file, 'user-1')).rejects.toThrow(
      new BadRequestException(
        'A CAT precisa estar fechada antes da emissão do PDF final governado.',
      ),
    );
  });
});
