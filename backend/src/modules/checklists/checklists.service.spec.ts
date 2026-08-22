import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { ChecklistsService } from './checklists.service';
import { Checklist } from './entities/checklist.entity';
import { CreateChecklistDto } from './dto/create-checklist.dto';
import type { ChecklistItemValue } from './types/checklist-item.type';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { MailService } from '../../infra/mail/mail.service';
import type { SignaturesService } from '../signatures/signatures.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import type { UsersService } from '../users/users.service';
import type { SitesService } from '../sites/sites.service';
import type { NotificationsGateway } from '../notifications/notifications.gateway';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { DocumentRegistryService } from '../document-registry/document-registry.service';
import type { FileParserService } from '../document-import/services/file-parser.service';
import type { ConfigService } from '@nestjs/config';
import type { IntegrationResilienceService } from '../../shared/resilience/integration-resilience.service';
import type { OpenAiCircuitBreakerService } from '../../shared/resilience/openai-circuit-breaker.service';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];
type RemoveFinalDocumentReferenceInput = Parameters<
  DocumentGovernanceService['removeFinalDocumentReference']
>[0];
type SignaturesByDocumentResult = Awaited<
  ReturnType<SignaturesService['findByDocument']>
>;
type UserFindOneResult = Awaited<ReturnType<UsersService['findOne']>>;
type SiteFindOneResult = Awaited<ReturnType<SitesService['findOne']>>;

type ChecklistCreatePayload = Partial<Checklist> & {
  itens?: ChecklistItemValue[];
};

describe('ChecklistsService', () => {
  let service: ChecklistsService;
  let _lockedChecklistRow: Record<string, unknown> | null = null;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    findAndCount: jest.Mock;
    count: jest.Mock;
  };
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'uploadFile'
    | 'generateDocumentKey'
    | 'getPresignedDownloadUrl'
    | 'getSignedUrl'
    | 'deleteFile'
    | 'downloadFileBuffer'
  >;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    | 'registerFinalDocument'
    | 'removeFinalDocumentReference'
    | 'listFinalDocuments'
    | 'getModuleWeeklyBundle'
  >;
  let documentRegistryService: Pick<
    DocumentRegistryService,
    'validatePublicCode' | 'validateLegacyPublicCode'
  >;
  let notificationsGateway: Pick<NotificationsGateway, 'sendToCompany'>;
  let signaturesService: Pick<
    SignaturesService,
    'findByDocument' | 'removeByDocumentSystem'
  >;
  let usersService: Pick<UsersService, 'findOne'>;
  let sitesService: Pick<SitesService, 'findOne'>;
  let tenantService: TenantService;

  beforeEach(() => {
    repository = {
      create: jest.fn((payload: Partial<Checklist>) => payload),
      save: jest.fn((payload: Partial<Checklist>) =>
        Promise.resolve({
          id: payload.id || 'checklist-1',
          created_at:
            payload.created_at || new Date('2026-03-14T12:00:00.000Z'),
          updated_at: new Date('2026-03-14T12:00:00.000Z'),
          ...payload,
        }),
      ),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      findAndCount: jest.fn(),
      count: jest.fn(),
    };
    _lockedChecklistRow = null;
    (repository as unknown as { manager: { transaction: jest.Mock } }).manager =
      {
        transaction: jest.fn((fn: (m: unknown) => unknown) => {
          const lockedRow = _lockedChecklistRow;
          const innerRepo = {
            create: jest.fn((data: unknown) => data as Checklist),
            save: jest.fn((data: unknown) =>
              Promise.resolve({
                id: 'checklist-1',
                company_id: 'company-1',
                ...(data as object),
              }),
            ),
          };
          const innerManager = {
            query: jest.fn().mockResolvedValue(lockedRow ? [lockedRow] : []),
            getRepository: jest.fn().mockReturnValue(innerRepo),
          };
          return fn(innerManager);
        }),
      };
    documentStorageService = {
      uploadFile: jest.fn(),
      generateDocumentKey: jest.fn(
        (
          companyId: string,
          documentType: string,
          documentId: string,
          originalName: string,
          options?: { folderSegments?: string[] },
        ) =>
          [
            'documents',
            companyId,
            documentType,
            ...(options?.folderSegments ?? []),
            documentId,
            originalName,
          ].join('/'),
      ),
      getPresignedDownloadUrl: jest.fn(() =>
        Promise.resolve('https://example.com/checklist.pdf'),
      ),
      getSignedUrl: jest.fn(() =>
        Promise.resolve('https://example.com/checklist.pdf'),
      ),
      deleteFile: jest.fn(() => Promise.resolve()),
      downloadFileBuffer: jest.fn(() =>
        Promise.resolve(Buffer.from('%PDF-checklist-stored')),
      ),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
      listFinalDocuments: jest.fn(),
      getModuleWeeklyBundle: jest.fn(),
    };
    documentRegistryService = {
      validatePublicCode: jest.fn(),
      validateLegacyPublicCode: jest.fn(),
    };
    notificationsGateway = {
      sendToCompany: jest.fn(),
    };
    signaturesService = {
      findByDocument: jest.fn(() =>
        Promise.resolve([
          {
            id: 'signature-1',
            user_id: 'user-1',
            signature_data: 'data:image/png;base64,AAAA',
            created_at: '2026-03-14T12:00:00.000Z',
            user: { nome: 'Maria' },
          },
        ] as unknown as SignaturesByDocumentResult),
      ),
      removeByDocumentSystem: jest.fn(() => Promise.resolve(0)),
    };
    usersService = {
      findOne: jest.fn((id: string) =>
        Promise.resolve({
          id,
          company_id: 'company-1',
        } as unknown as UserFindOneResult),
      ),
    };
    sitesService = {
      findOne: jest.fn((id: string) =>
        Promise.resolve({
          id,
          company_id: 'company-1',
        } as unknown as SiteFindOneResult),
      ),
    };

    tenantService = {
      getTenantId: jest.fn(() => 'company-1'),
      getContext: jest.fn(() => ({
        companyId: 'company-1',
        siteId: 'site-1',
        siteScope: 'single',
        isSuperAdmin: false,
      })),
    } as unknown as TenantService;

    service = new ChecklistsService(
      repository as unknown as Repository<Checklist>,
      tenantService,
      {
        transaction: jest.fn(
          (cb: (m: { getRepository: () => typeof repository }) => unknown) =>
            cb({ getRepository: () => repository }),
        ),
      } as unknown as DataSource,
      { sendMailSimple: jest.fn() } as unknown as MailService,
      signaturesService as unknown as SignaturesService,
      notificationsGateway as NotificationsGateway,
      documentStorageService as DocumentStorageService,
      usersService as unknown as UsersService,
      sitesService as unknown as SitesService,
      documentGovernanceService as DocumentGovernanceService,
      documentRegistryService as DocumentRegistryService,
      {} as FileParserService,
      {
        get: jest.fn(),
      } as unknown as ConfigService,
      {
        execute: jest.fn(async <T>(_name: string, fn: () => Promise<T>) =>
          fn(),
        ),
      } as unknown as IntegrationResilienceService,
      {
        assertRequestAllowed: jest.fn(),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
        isCountableFailureStatus: jest.fn().mockReturnValue(false),
        isCountableFailureError: jest.fn().mockReturnValue(false),
      } as unknown as OpenAiCircuitBreakerService,
      {
        buildWeeklyPdfBundle: jest.fn(),
      } as never,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const getFirstCreatedChecklistPayload = (): ChecklistCreatePayload => {
    const createCalls = repository.create.mock.calls as Array<
      [ChecklistCreatePayload]
    >;
    return createCalls[0]?.[0] ?? {};
  };

  const getCreatedPresetTemplates = (): Checklist[] => {
    const saveCalls = repository.save.mock.calls as Array<[Checklist[]]>;
    return saveCalls[0]?.[0] ?? [];
  };

  it('desativa explicitamente o fluxo legado savePdfToStorage', async () => {
    await expect(service.savePdfToStorage('checklist-1')).rejects.toThrow(
      'O fluxo legado savePdfToStorage do checklist (checklist-1) foi descontinuado. Use attachPdf com o PDF oficial governado.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
  });

  it('anexa o PDF oficial padronizado do checklist na esteira governada', async () => {
    const checklist = {
      id: 'checklist-1',
      company_id: 'company-1',
      titulo: 'Checklist de campo',
      data: new Date('2026-03-14T12:00:00.000Z'),
      site_id: 'site-1',
      inspetor_id: 'user-1',
      is_modelo: false,
      pdf_file_key: null,
      created_at: new Date('2026-03-14T12:00:00.000Z'),
    } as unknown as Checklist;
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const manager = {
      getRepository: jest.fn(() => ({ update })),
    };
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(checklist);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(
        manager as unknown as EntityManager,
        'hash-1',
      );
      return { hash: 'hash-1', registryEntry: { id: 'registry-1' } };
    });

    const result = await service.attachPdf(
      'checklist-1',
      {
        originalname: 'checklist-oficial.pdf',
        mimetype: 'application/pdf',
        buffer: Buffer.from('%PDF-checklist-ui'),
      } as Express.Multer.File,
      'user-1',
    );

    expect(result.originalName).toBe('checklist-oficial.pdf');
    expect(result.folderPath).toEqual(
      expect.stringContaining(
        'documents/company-1/checklists/sites/site-1/2026/week-',
      ),
    );
    expect(documentStorageService.uploadFile).toHaveBeenCalledWith(
      expect.stringContaining('checklist-oficial.pdf'),
      Buffer.from('%PDF-checklist-ui'),
      'application/pdf',
    );
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        module: 'checklist',
        entityId: 'checklist-1',
        documentCode: 'CHK-2026-ECKLIST1',
        createdBy: 'user-1',
        originalName: 'checklist-oficial.pdf',
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'checklist-1' }),
      expect.objectContaining({
        pdf_original_name: 'checklist-oficial.pdf',
      }),
    );
  });

  it('remove checklist via esteira central para limpar o registry no mesmo fluxo', async () => {
    const checklist = {
      id: 'checklist-1',
      company_id: 'company-1',
    } as unknown as Checklist;
    const softDelete = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ softDelete })),
    };
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(checklist);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: RemoveFinalDocumentReferenceInput) => {
      await input.removeEntityState?.(manager as never);
    });

    await expect(service.remove('checklist-1')).resolves.toBeUndefined();

    const [removeInput] = (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mock.calls[0] as [RemoveFinalDocumentReferenceInput];
    expect(removeInput.companyId).toBe('company-1');
    expect(removeInput.module).toBe('checklist');
    expect(removeInput.entityId).toBe('checklist-1');
    expect(typeof removeInput.removeEntityState).toBe('function');
    expect(softDelete).toHaveBeenCalledWith('checklist-1');
  });

  it('mantem o legado desativado sem iniciar upload ou cleanup', async () => {
    await expect(service.savePdfToStorage('template-1')).rejects.toThrow(
      'O fluxo legado savePdfToStorage do checklist (template-1) foi descontinuado. Use attachPdf com o PDF oficial governado.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('rejeita checklist operacional sem obra ou inspetor', async () => {
    await expect(
      service.create({
        titulo: 'Checklist operacional',
        data: '2026-03-14',
        company_id: 'company-1',
        itens: [],
        is_modelo: false,
      } as unknown as CreateChecklistDto),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('valida obra e inspetor no create do checklist operacional', async () => {
    await service.create({
      titulo: 'Checklist operacional',
      data: '2026-03-14',
      company_id: 'company-1',
      site_id: 'site-1',
      inspetor_id: 'user-1',
      itens: [{ item: 'Inspecionar trava', status: 'ok' }],
      is_modelo: false,
    } as unknown as CreateChecklistDto);

    expect(sitesService.findOne).toHaveBeenCalledWith('site-1');
    expect(usersService.findOne).toHaveBeenCalledWith('user-1');
  });

  it('recalcula status final a partir dos itens no create', async () => {
    const result = await service.create({
      titulo: 'Checklist operacional',
      data: '2026-03-14',
      company_id: 'company-1',
      site_id: 'site-1',
      inspetor_id: 'user-1',
      itens: [
        { item: 'Inspecionar trava', status: 'ok' },
        { item: 'Verificar bloqueio', status: 'nok', observacao: 'Falha' },
      ],
      status: 'Conforme',
      is_modelo: false,
    } as unknown as CreateChecklistDto);

    expect(result.status).toBe('Não Conforme');
  });

  it('recalcula status final a partir dos subitens quando o item possui alternativas respondidas', async () => {
    const result = await service.create({
      titulo: 'Checklist com subitens',
      data: '2026-03-14',
      company_id: 'company-1',
      site_id: 'site-1',
      inspetor_id: 'user-1',
      itens: [
        {
          item: 'A cozinha atende aos requisitos?',
          status: 'sim',
          tipo_resposta: 'sim_nao_na',
          subitens: [
            { texto: 'Cobertura adequada', status: 'sim' },
            { texto: 'Ventilação adequada', status: 'nao' },
          ],
        },
      ],
      status: 'Conforme',
      is_modelo: false,
    } as unknown as CreateChecklistDto);

    expect(result.status).toBe('Não Conforme');
  });

  it('aceita topicos aninhados e preserva a hierarquia na resposta', async () => {
    const result = await service.create({
      titulo: 'Checklist hierarquico',
      data: '2026-03-14',
      company_id: 'company-1',
      site_id: 'site-1',
      inspetor_id: 'user-1',
      topicos: [
        {
          titulo: 'VERIFICACAO DA AREA DE VIVENCIA',
          itens: [
            {
              item: 'A area possui condicoes adequadas?',
              subitens: [
                { texto: 'Cobertura adequada' },
                { texto: 'Ventilacao adequada' },
                { texto: 'Iluminacao adequada' },
              ],
            },
          ],
        },
      ],
    } as unknown as CreateChecklistDto);

    const createdChecklist = getFirstCreatedChecklistPayload();
    const createdItems = createdChecklist.itens ?? [];
    const createdTopicItem = createdItems.find(
      (item) => item.topico_titulo === 'VERIFICACAO DA AREA DE VIVENCIA',
    );

    expect(createdTopicItem).toBeDefined();
    expect(createdTopicItem?.ordem_topico).toBe(1);
    expect(createdTopicItem?.ordem_item).toBe(1);
    expect(typeof createdTopicItem?.topico_id).toBe('string');
    expect(createdTopicItem?.subitens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ordem: 1,
          texto: 'Cobertura adequada',
        }),
        expect.objectContaining({
          ordem: 2,
          texto: 'Ventilacao adequada',
        }),
        expect.objectContaining({
          ordem: 3,
          texto: 'Iluminacao adequada',
        }),
      ]),
    );

    const topicos = (
      result as unknown as {
        topicos?: Array<{
          titulo: string;
          itens: Array<{
            item: string;
            subitens?: Array<{ ordem?: number; texto: string }>;
          }>;
        }>;
      }
    ).topicos;
    expect(topicos).toHaveLength(1);
    expect(topicos?.[0].titulo).toBe('VERIFICACAO DA AREA DE VIVENCIA');
    expect(topicos?.[0].itens[0].subitens?.[0].texto).toBe(
      'Cobertura adequada',
    );
    expect(topicos?.[0].itens[0].subitens?.[1].ordem).toBe(2);
  });

  it('aceita payload do frontend com topicos separados de itens e recompõe a hierarquia', async () => {
    const result = await service.create({
      titulo: 'Checklist frontend',
      data: '2026-03-14',
      company_id: 'company-1',
      site_id: 'site-1',
      inspetor_id: 'user-1',
      topicos: [
        { id: 'topic-1', titulo: 'AREA DE VIVENCIA', ordem: 1 },
        { id: 'topic-2', titulo: 'INSTALACOES ELETRICAS', ordem: 2 },
      ],
      itens: [
        {
          id: 'item-1',
          item: 'A area esta coberta?',
          topico_id: 'topic-1',
          topico_titulo: 'AREA DE VIVENCIA',
          ordem_topico: 1,
          ordem_item: 1,
          tipo_resposta: 'sim_nao_na',
          subitens: [{ texto: 'Cobertura adequada' }],
        },
        {
          id: 'item-2',
          item: 'Quadro eletrico identificado?',
          topico_id: 'topic-2',
          topico_titulo: 'INSTALACOES ELETRICAS',
          ordem_topico: 2,
          ordem_item: 1,
          tipo_resposta: 'sim_nao_na',
          subitens: [{ texto: 'Plaqueta visível' }],
        },
      ],
    } as unknown as CreateChecklistDto);

    const topicos = (
      result as unknown as {
        topicos?: Array<{
          titulo: string;
          itens: Array<{ item: string; subitens?: Array<{ texto: string }> }>;
        }>;
      }
    ).topicos;

    expect(topicos).toHaveLength(2);
    expect(topicos?.[0].titulo).toBe('AREA DE VIVENCIA');
    expect(topicos?.[0].itens[0].item).toBe('A area esta coberta?');
    expect(topicos?.[1].titulo).toBe('INSTALACOES ELETRICAS');
    expect(topicos?.[1].itens[0].subitens?.[0].texto).toBe('Plaqueta visível');
  });

  it('preserva metadados de Barreira Viva e calcula status da barreira no retorno', async () => {
    const result = await service.create({
      titulo: 'Checklist Barreira Viva',
      data: '2026-03-14',
      company_id: 'company-1',
      site_id: 'site-1',
      inspetor_id: 'user-1',
      topicos: [
        {
          id: 'topic-1',
          titulo: 'Barreira Física',
          descricao: 'Isolamento e contenção da área',
          ordem: 1,
          barreira_tipo: 'fisica',
          peso_barreira: 4,
          limite_ruptura: 1,
        },
      ],
      itens: [
        {
          id: 'item-1',
          item: 'Isolamento sinalizado',
          topico_id: 'topic-1',
          status: 'nao',
          tipo_resposta: 'sim_nao_na',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
          exige_foto_quando_nc: true,
          exige_observacao_quando_nc: true,
          acao_corretiva_imediata: 'Interditar frente de serviço',
        },
      ],
    } as unknown as CreateChecklistDto);

    const createdChecklist = getFirstCreatedChecklistPayload();
    const createdItems = createdChecklist.itens ?? [];

    expect(createdItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_descricao: 'Isolamento e contenção da área',
          barreira_tipo: 'fisica',
          peso_barreira: 4,
          limite_ruptura: 1,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
          exige_foto_quando_nc: true,
          exige_observacao_quando_nc: true,
          acao_corretiva_imediata: 'Interditar frente de serviço',
        }),
      ]),
    );

    const topicos = (
      result as unknown as {
        topicos?: Array<{
          titulo: string;
          descricao?: string;
          barreira_tipo?: string;
          status_barreira?: string;
          controles_rompidos?: number;
          bloqueia_operacao?: boolean;
        }>;
      }
    ).topicos;

    expect(topicos?.[0]).toMatchObject({
      titulo: 'Barreira Física',
      descricao: 'Isolamento e contenção da área',
      barreira_tipo: 'fisica',
      status_barreira: 'rompida',
      controles_rompidos: 1,
      bloqueia_operacao: true,
    });
  });

  it('bloqueia edicao quando o checklist ja possui PDF final emitido', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      company_id: 'company-1',
      titulo: 'Checklist finalizado',
      data: new Date('2026-03-14T12:00:00.000Z'),
      site_id: 'site-1',
      inspetor_id: 'user-1',
      is_modelo: false,
      pdf_file_key: 'documents/company-1/checklists/checklist-1.pdf',
    } as unknown as Checklist);

    await expect(
      service.update('checklist-1', { titulo: 'Novo título' }),
    ).rejects.toThrow(
      'Checklist com PDF final emitido. Edição bloqueada. Gere um novo checklist para alterar o documento.',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('invalida assinaturas quando o checklist sofre alteracao material', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      company_id: 'company-1',
      titulo: 'Checklist base',
      descricao: 'Descricao',
      equipamento: 'Detector',
      maquina: null,
      foto_equipamento: null,
      data: new Date('2026-03-14T12:00:00.000Z'),
      site_id: 'site-1',
      inspetor_id: 'user-1',
      itens: [{ item: 'Verificar trava', status: 'ok', fotos: [] }],
      is_modelo: false,
      pdf_file_key: null,
      categoria: 'SST',
      periodicidade: 'Diário',
      nivel_risco_padrao: 'Médio',
      auditado_por_id: null,
      data_auditoria: null,
      resultado_auditoria: null,
      notas_auditoria: null,
    } as unknown as Checklist);

    await service.update('checklist-1', {
      descricao: 'Descricao atualizada',
    });

    expect(signaturesService.removeByDocumentSystem).toHaveBeenCalledWith(
      'checklist-1',
      'CHECKLIST',
      {
        companyId: 'company-1',
        siteId: 'site-1',
      },
    );
  });

  it('preenche checklist a partir do template por allowlist segura', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'template-1',
      titulo: 'Modelo',
      descricao: 'Template',
      equipamento: 'Detector',
      maquina: null,
      foto_equipamento: null,
      data: new Date('2026-03-10'),
      status: 'Pendente',
      company_id: 'company-1',
      site_id: null,
      inspetor_id: null,
      itens: [
        {
          id: 'item-1',
          item: 'Verificar trava',
          tipo_resposta: 'conforme',
          obrigatorio: true,
          peso: 1,
          status: 'nok',
          observacao: 'template',
          fotos: ['template-photo'],
        },
      ],
      is_modelo: true,
      ativo: true,
      categoria: 'SST',
      periodicidade: 'Diário',
      nivel_risco_padrao: 'Médio',
      pdf_file_key: 'documents/template.pdf',
      pdf_folder_path: 'documents/company-1/checklists',
      pdf_original_name: 'template.pdf',
      created_at: new Date('2026-03-01'),
      updated_at: new Date('2026-03-01'),
    } as unknown as Checklist);

    const result = await service.fillFromTemplate('template-1', {
      data: '2026-03-15',
      site_id: 'site-1',
      inspetor_id: 'user-1',
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        titulo: 'Modelo',
        company_id: 'company-1',
        template_id: 'template-1',
        site_id: 'site-1',
        inspetor_id: 'user-1',
        is_modelo: false,
      }),
    );
    expect(result.is_modelo).toBe(false);
    const firstItem = (
      result.itens as unknown as Array<Record<string, unknown>>
    )[0];
    expect(firstItem).toEqual(
      expect.objectContaining({
        item: 'Verificar trava',
        status: 'ok',
        observacao: '',
        fotos: [],
      }),
    );
  });

  it('executa remoção em esteira com reset de signatures (CHECKLIST) e cleanup de fotos governadas', async () => {
    const checklist = {
      id: 'checklist-1',
      company_id: 'company-1',
      site_id: 'site-1',
      is_modelo: false,
      foto_equipamento:
        'gst:checklist-photo:eyJ2IjoxLCJraW5kIjoiZ292ZXJuZWQtc3RvcmFnZSIsInNjb3BlIjoiZXF1aXBtZW50IiwiZmlsZUtleSI6InRlc3Qta2V5Iiwib3JpZ2luYWxOYW1lIjoidGVzdC5qcGciLCJtaW1lVHlwZSI6ImltYWdlL2pwZWciLCJ1cGxvYWRlZEF0IjoiMjAyNS0wMS0wMVQwMDowMDowMC4wMDBaIn0',
    } as unknown as Checklist;
    const softDelete = jest.fn();
    const manager = { getRepository: jest.fn(() => ({ softDelete })) };
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(checklist);
    jest
      .spyOn(
        service as unknown as Record<string, jest.Mock>,
        'getGovernedChecklistPhotoEntries',
      )
      .mockReturnValue([
        {
          scope: 'equipment',
          fileKey: 'dummy',
          originalName: 'd.jpg',
          mimeType: 'image/jpeg',
        },
      ]);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: Record<string, unknown>) => {
      const fn = input.removeEntityState as
        ((m: unknown) => Promise<void>) | undefined;
      if (fn) await fn(manager);
    });
    (signaturesService.removeByDocumentSystem as jest.Mock).mockResolvedValue(
      2,
    );
    const cleanupSpy = jest
      .spyOn(
        service as unknown as Record<string, jest.Mock>,
        'cleanupGovernedChecklistPhotoFiles',
      )
      .mockResolvedValue(undefined);

    await service.remove('checklist-1');

    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).toHaveBeenCalled();
    expect(softDelete).toHaveBeenCalledWith('checklist-1');
    expect(signaturesService.removeByDocumentSystem).toHaveBeenCalledWith(
      'checklist-1',
      'CHECKLIST',
      { companyId: 'company-1', siteId: 'site-1' },
    );
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it('respeita scoping de templates: permite globais (site_id null) e site-specific no scope para onlyTemplates', async () => {
    // usa path com segment para cobrir cláusula (NULL OR IN)
    const rows = [
      { id: 't-global', is_modelo: true, site_id: null, titulo: 'Global' },
      { id: 't-site1', is_modelo: true, site_id: 'site-1', titulo: 'Site1' },
    ];
    const qbMock = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, 2]),
    };
    repository.createQueryBuilder.mockReturnValue(qbMock);

    const res = await service.findPaginated({
      onlyTemplates: true,
      segment: 'operacionais',
      page: 1,
      limit: 20,
    });

    expect(res.data).toHaveLength(2);
    // verifica que a query incluiu filtro para templates globais + scoped
    expect(qbMock.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('site_id IS NULL OR checklist.site_id IN'),
      expect.any(Object),
    );
  });

  it('sanitiza campos de texto ao preencher de template (buildFromTemplate)', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'template-1',
      titulo: 'Modelo <script>evil</script>',
      descricao: 'Desc <b>ok</b>',
      equipamento: 'Equip',
      maquina: null,
      foto_equipamento: null,
      data: new Date('2026-03-10'),
      status: 'Pendente',
      company_id: 'company-1',
      site_id: null,
      inspetor_id: null,
      itens: [{ item: 'Item', tipo_resposta: 'conforme' }],
      is_modelo: true,
      ativo: true,
      categoria: 'SST <img>',
      periodicidade: 'Diário',
      nivel_risco_padrao: 'Médio',
      created_at: new Date(),
      updated_at: new Date(),
    } as unknown as Checklist);

    const result = await service.fillFromTemplate('template-1', {
      data: '2026-03-15',
      site_id: 'site-1',
      inspetor_id: 'user-1',
      titulo: 'Preenchido <script>alert(1)</script>',
    });

    // sanitizePlainText remove tags
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        titulo: expect.not.stringContaining('<script>') as unknown,
        categoria: expect.not.stringContaining('<img>') as unknown,
      }),
    );
    expect(result).toBeDefined();
  });

  it('inclui os modelos padrão NR24, NR10, NR12, LOTO, NR35, NR33, máquina de solda, lixadeira, PEMT, plataforma elevatória, caminhão munck, furadeira/parafusadeira, talabarte, escada extensível e escada de abrir no bootstrap com a estrutura esperada', async () => {
    repository.find.mockResolvedValue([]);
    repository.save.mockImplementation((payload: Partial<Checklist>[]) =>
      Promise.resolve(
        payload.map((item, index) => ({
          id: `template-${index + 1}`,
          created_at: new Date('2026-03-14T12:00:00.000Z'),
          updated_at: new Date('2026-03-14T12:00:00.000Z'),
          ...item,
        })),
      ),
    );

    const result = await service.createPresetTemplates();

    expect(result.created).toBe(15);
    expect(result.skipped).toBe(0);

    const createdTemplates = getCreatedPresetTemplates();

    const nr24Template = createdTemplates.find(
      (item) => item.titulo === 'Checklist Operacional - NR24',
    );
    const nr10Template = createdTemplates.find(
      (item) => item.titulo === 'Checklist Operacional - NR10',
    );
    const nr12Template = createdTemplates.find(
      (item) => item.titulo === 'Checklist Operacional - NR12',
    );
    const lotoTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist Operacional - LOTO',
    );
    const nr35Template = createdTemplates.find(
      (item) => item.titulo === 'Checklist Operacional - NR35',
    );
    const nr33Template = createdTemplates.find(
      (item) => item.titulo === 'Checklist Operacional - NR33',
    );
    const weldingMachineTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Máquina de Solda',
    );
    const grinderTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Lixadeira',
    );
    const pemtTemplate = createdTemplates.find(
      (item) =>
        item.titulo === 'Checklist - Plataforma Elevatória Elétrica (PEMT)',
    );
    const elevatingPlatformTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Plataforma Elevatória',
    );
    const munckTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Caminhão Munck',
    );
    const portableDrillTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Furadeira/Parafusadeira Portátil',
    );
    const safetyLanyardTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Talabarte de Segurança',
    );
    const extensionLadderTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Escada Extensível',
    );
    const stepLadderTemplate = createdTemplates.find(
      (item) => item.titulo === 'Checklist - Escada de Abrir',
    );

    expect(nr24Template).toBeDefined();
    expect(nr24Template).toMatchObject({
      descricao:
        'Modelo padrão do sistema para verificação de condições de vivência e higiene ocupacional conforme NR24.',
      categoria: 'Operacional',
      periodicidade: 'Conforme rotina',
      nivel_risco_padrao: 'Médio',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(nr24Template?.equipamento).toBeUndefined();
    expect(nr24Template?.maquina).toBeUndefined();
    expect(nr24Template?.itens).toHaveLength(20);
    expect(nr24Template?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Aplicação e Dimensionamento',
          item: 'Dimensionamento - O dimensionamento considera o número de trabalhadores do turno de maior contingente?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Refeição e Água Potável',
          item: 'Local de refeição - Existe local de refeição compatível com o número de trabalhadores usuários?',
        }),
      ]),
    );
    expect(nr10Template).toBeDefined();
    expect(nr10Template).toMatchObject({
      descricao:
        'Modelo padrão do sistema para verificação operacional de conformidade em segurança com instalações e serviços em eletricidade conforme NR-10.',
      categoria: 'Operacional',
      periodicidade: 'Por atividade',
      nivel_risco_padrao: 'Alto',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(nr10Template?.equipamento).toBeUndefined();
    expect(nr10Template?.maquina).toBeUndefined();
    expect(nr10Template?.itens).toHaveLength(20);
    expect(nr10Template?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Gestão Documental e Técnica',
          item: 'Prontuário - O prontuário de instalações elétricas está disponível e atualizado quando exigível?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Desenergização, Bloqueio e Liberação',
          item: 'Ausência de tensão - A ausência de tensão foi constatada com instrumento adequado e procedimento válido?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(nr12Template).toBeDefined();
    expect(nr12Template).toMatchObject({
      descricao:
        'Modelo padrão do sistema para verificação operacional de conformidade em segurança no trabalho em máquinas e equipamentos conforme NR-12.',
      categoria: 'Operacional',
      periodicidade: 'Por atividade',
      nivel_risco_padrao: 'Alto',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(nr12Template?.equipamento).toBeUndefined();
    expect(nr12Template?.maquina).toBeUndefined();
    expect(nr12Template?.itens).toHaveLength(20);
    expect(nr12Template?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Proteções e Dispositivos de Segurança',
          item: 'Proteções fixas - As proteções fixas estão instaladas, íntegras e impedem acesso à zona de perigo?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Comandos, Partida e Bloqueio',
          item: 'Parada de emergência - Os dispositivos de parada de emergência estão acessíveis, identificados e funcionam corretamente?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(lotoTemplate).toBeDefined();
    expect(lotoTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para verificação operacional de bloqueio e etiquetagem de energias perigosas.',
      categoria: 'Operacional',
      periodicidade: 'Por intervenção',
      nivel_risco_padrao: 'Alto',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(lotoTemplate?.equipamento).toBeUndefined();
    expect(lotoTemplate?.maquina).toBeUndefined();
    expect(lotoTemplate?.itens).toHaveLength(20);
    expect(lotoTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Gestão, Escopo e Documentação',
          item: 'Procedimento LOTO - O procedimento de bloqueio e etiquetagem está formalizado, aprovado e disponível para a atividade?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Verificação de Energia Zero',
          item: 'Tentativa de partida - A tentativa controlada de partida confirmou a condição de energia zero quando aplicável?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(nr35Template).toBeDefined();
    expect(nr35Template).toMatchObject({
      descricao:
        'Modelo padrão do sistema para verificação operacional de conformidade em trabalho em altura conforme NR-35.',
      categoria: 'Operacional',
      periodicidade: 'Por atividade',
      nivel_risco_padrao: 'Alto',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(nr35Template?.equipamento).toBeUndefined();
    expect(nr35Template?.maquina).toBeUndefined();
    expect(nr35Template?.itens).toHaveLength(20);
    expect(nr35Template?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Gestão Documental e Planejamento',
          item: 'Procedimento operacional - O procedimento de trabalho em altura está formalizado, aprovado e disponível para a atividade?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Sistema de Proteção Contra Quedas',
          item: 'Conexão contínua - O método de trabalho garante proteção contínua durante toda a exposição ao risco de queda?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(nr33Template).toBeDefined();
    expect(nr33Template).toMatchObject({
      descricao:
        'Modelo padrão do sistema para verificação operacional de conformidade em entrada e trabalho em espaço confinado conforme NR-33.',
      categoria: 'Operacional',
      periodicidade: 'Por atividade',
      nivel_risco_padrao: 'Alto',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(nr33Template?.equipamento).toBeUndefined();
    expect(nr33Template?.maquina).toBeUndefined();
    expect(nr33Template?.itens).toHaveLength(20);
    expect(nr33Template?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'PET e Controle Formal da Entrada',
          item: 'Permissão de entrada e trabalho - A PET foi emitida, aprovada e está disponível no local da atividade?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Avaliação Atmosférica e Ventilação',
          item: 'Faixas aceitáveis - Os resultados de oxigênio, inflamáveis e contaminantes tóxicos estão dentro dos limites seguros definidos?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(weldingMachineTemplate).toBeDefined();
    expect(weldingMachineTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, integridade, segurança elétrica, operação, bloqueio e pós-uso de máquina de solda.',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Máquina de Solda',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(weldingMachineTemplate?.itens).toHaveLength(20);
    expect(weldingMachineTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Alimentação Elétrica e Aterramento',
          item: 'Cabo de alimentação - O cabo de alimentação está sem emendas improvisadas, cortes ou exposição de condutores?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Acessórios e Circuito de Soldagem',
          item: 'Garra de retorno - A garra de retorno está íntegra, com pressão adequada e contato firme com a peça ou bancada?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(grinderTemplate).toBeDefined();
    expect(grinderTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, integridade, segurança elétrica, operação, bloqueio e pós-uso de lixadeira.',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Lixadeira',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(grinderTemplate?.itens).toHaveLength(20);
    expect(grinderTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Disco, Rebolo, Lixa e Acessórios',
          item: 'Compatibilidade do acessório - O disco, rebolo, lixa ou acessório é compatível com o modelo e a rotação da lixadeira?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Proteções, Empunhadura e Segurança Elétrica',
          item: 'Guarda de proteção - A guarda de proteção está instalada, íntegra e corretamente posicionada?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(pemtTemplate).toBeDefined();
    expect(pemtTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, liberação, operação segura, manutenção e bloqueio de plataforma elevatória elétrica.',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Plataforma Elevatória Elétrica (PEMT)',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(pemtTemplate?.itens).toHaveLength(20);
    expect(pemtTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Identificação, Documentação e Liberação',
          item: 'Manual - O manual do fabricante está disponível para consulta?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'alto',
        }),
        expect.objectContaining({
          topico_titulo: 'Comandos e Emergência',
          item: 'Parada de emergência - A parada de emergência e a descida de emergência estão operantes?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(elevatingPlatformTemplate).toBeDefined();
    expect(elevatingPlatformTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, liberação, operação segura, emergência/resgate e pós-uso de plataforma elevatória (tesoura, articulada, telescópica, mastro; elétrica ou combustão).',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Plataforma Elevatória',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(elevatingPlatformTemplate?.itens).toHaveLength(20);
    expect(elevatingPlatformTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Identificação, Documentação e Liberação',
          item: 'Identificação - A placa ou etiqueta do fabricante está legível com marca, modelo e rastreabilidade do equipamento?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'alto',
        }),
        expect.objectContaining({
          topico_titulo: 'Comandos, Controles e Teste Funcional',
          item: 'Parada de emergência - Os botões de parada de emergência funcionam e interrompem os movimentos?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(munckTemplate).toBeDefined();
    expect(munckTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, patolamento, içamento, operação segura, bloqueio e pós-uso de caminhão munck/guindauto.',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Caminhão Munck',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(munckTemplate?.itens).toHaveLength(20);
    expect(munckTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Documentação, Identificação e Liberação',
          item: 'Tabela de carga - A tabela ou diagrama de carga do fabricante está disponível, legível e compatível com o equipamento?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Patolas, Estabilizadores e Nivelamento',
          item: 'Solo de apoio - O solo ou a base está sem risco de recalque, afundamento ou deslizamento sob as patolas?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Comandos, Área e Regras de Içamento',
          item: 'Carga suspensa - Não há pessoas sob carga suspensa ou em trajetória de queda potencial?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(portableDrillTemplate).toBeDefined();
    expect(portableDrillTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, liberação, uso seguro, controle de risco elétrico, manutenção, bloqueio e pós-uso de furadeira/parafusadeira portátil.',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Furadeira/Parafusadeira Portátil',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(portableDrillTemplate?.itens).toHaveLength(16);
    expect(portableDrillTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Identificação, Documentação e Condição Geral',
          item: 'Identificação da ferramenta - A ferramenta está identificada por código, patrimônio, número de série ou controle interno?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'alto',
        }),
        expect.objectContaining({
          topico_titulo: 'Segurança Elétrica e Alimentação',
          item: 'Tomada - O ponto de alimentação está em condição segura para uso da ferramenta?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(safetyLanyardTemplate).toBeDefined();
    expect(safetyLanyardTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, liberação, uso seguro, compatibilidade, conservação, higienização, bloqueio e descarte de talabarte de segurança.',
      categoria: 'EPI',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Talabarte de Segurança',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(safetyLanyardTemplate?.itens).toHaveLength(16);
    expect(safetyLanyardTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Identificação, CA e Documentação',
          item: 'Identificação do EPI - O talabarte está identificado por marca, modelo, lote, número de série ou código interno?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Resgate, Conservação e Descarte',
          item: 'Resgate - Existe procedimento de emergência e resgate compatível com a atividade?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(extensionLadderTemplate).toBeDefined();
    expect(extensionLadderTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, integridade, uso seguro, acesso temporário, bloqueio e interdição de escada extensível de uso individual.',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Escada Extensível',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(extensionLadderTemplate?.itens).toHaveLength(16);
    expect(extensionLadderTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Identificação e Documentação',
          item: 'Identificação - A escada possui identificação visível do fabricante, modelo e elemento de rastreabilidade?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Posicionamento e Uso Operacional Seguro',
          item: 'Prolongamento superior - A escada ultrapassa o nível superior em no mínimo 1 m quando utilizada como meio de acesso?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );
    expect(stepLadderTemplate).toBeDefined();
    expect(stepLadderTemplate).toMatchObject({
      descricao:
        'Modelo padrão do sistema para inspeção pré-uso, integridade, estabilidade, uso seguro, bloqueio e interdição de escada de abrir de uso individual.',
      categoria: 'Equipamento',
      periodicidade: 'Pré-uso diário',
      nivel_risco_padrao: 'Alto',
      equipamento: 'Escada de Abrir',
      is_modelo: true,
      ativo: true,
      company_id: 'company-1',
    });
    expect(stepLadderTemplate?.itens).toHaveLength(16);
    expect(stepLadderTemplate?.itens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topico_titulo: 'Estabilidade e Posicionamento',
          item: 'Limitadores de abertura - Os limitadores de abertura estão operantes na abertura máxima?',
          tipo_resposta: 'sim_nao_na',
          obrigatorio: true,
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
        expect.objectContaining({
          topico_titulo: 'Integridade Estrutural',
          item: 'Articuladores e dobradiças - Os articuladores, dobradiças, travas e limitadores estão em perfeito estado de conservação e funcionamento?',
          criticidade: 'critico',
          bloqueia_operacao_quando_nc: true,
        }),
      ]),
    );

    for (const item of nr24Template?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
      expect(item.criticidade).toBeUndefined();
      expect(item.bloqueia_operacao_quando_nc).toBeUndefined();
      expect(item.exige_foto_quando_nc).toBeUndefined();
      expect(item.exige_observacao_quando_nc).toBeUndefined();
      expect(item.acao_corretiva_imediata).toBeUndefined();
    }

    for (const item of nr10Template?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of nr12Template?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of lotoTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of nr35Template?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of nr33Template?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of weldingMachineTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of grinderTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of pemtTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of elevatingPlatformTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of munckTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of portableDrillTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of safetyLanyardTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of extensionLadderTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }

    for (const item of stepLadderTemplate?.itens ?? []) {
      expect(item.item).toMatch(/\?$/);
      expect(item.barreira_tipo).toBeUndefined();
      expect(item.peso_barreira).toBeUndefined();
      expect(item.limite_ruptura).toBeUndefined();
    }
  });

  describe('createWeldingMachineTemplate legado centralizado', () => {
    it('cria o modelo centralizado de máquina de solda quando não existe nenhum título compatível', async () => {
      repository.findOne.mockResolvedValueOnce(null);

      const result = await service.createWeldingMachineTemplate();

      expect(repository.findOne).toHaveBeenCalledWith({
        where: [
          {
            titulo: 'Checklist - Máquina de Solda',
            is_modelo: true,
            company_id: 'company-1',
            deleted_at: IsNull(),
          },
          {
            titulo: 'Checklist de Máquina de Solda',
            is_modelo: true,
            company_id: 'company-1',
            deleted_at: IsNull(),
          },
        ],
      });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          titulo: 'Checklist - Máquina de Solda',
          equipamento: 'Máquina de Solda',
          categoria: 'Equipamento',
          periodicidade: 'Pré-uso diário',
          nivel_risco_padrao: 'Alto',
          is_modelo: true,
          ativo: true,
          company_id: 'company-1',
        }),
      );
      expect(result).toMatchObject({
        titulo: 'Checklist - Máquina de Solda',
        equipamento: 'Máquina de Solda',
        is_modelo: true,
      });
      expect(result.itens).toHaveLength(20);
    });

    it('não cria duplicata quando já existe o título legado de máquina de solda', async () => {
      repository.findOne.mockResolvedValueOnce({
        id: 'legacy-weld',
        titulo: 'Checklist de Máquina de Solda',
        is_modelo: true,
        company_id: 'company-1',
      });

      const result = await service.createWeldingMachineTemplate();

      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        id: 'legacy-weld',
        titulo: 'Checklist de Máquina de Solda',
      });
    });
  });

  it('não duplica os modelos padrão NR24, NR10, NR12, LOTO, NR35, NR33, máquina de solda, lixadeira, PEMT, plataforma elevatória, caminhão munck, furadeira/parafusadeira, talabarte, escada extensível e escada de abrir quando o bootstrap é executado novamente', async () => {
    repository.find.mockResolvedValue([
      { titulo: 'Checklist Operacional - NR24' },
      { titulo: 'Checklist Operacional - NR10' },
      { titulo: 'Checklist Operacional - NR12' },
      { titulo: 'Checklist Operacional - LOTO' },
      { titulo: 'Checklist Operacional - NR35' },
      { titulo: 'Checklist Operacional - NR33' },
      { titulo: 'Checklist - Máquina de Solda' },
      { titulo: 'Checklist - Lixadeira' },
      { titulo: 'Checklist - Plataforma Elevatória Elétrica (PEMT)' },
      { titulo: 'Checklist - Plataforma Elevatória' },
      { titulo: 'Checklist - Caminhão Munck' },
      { titulo: 'Checklist - Furadeira/Parafusadeira Portátil' },
      { titulo: 'Checklist - Talabarte de Segurança' },
      { titulo: 'Checklist - Escada Extensível' },
      { titulo: 'Checklist - Escada de Abrir' },
    ]);

    const result = await service.createPresetTemplates();

    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(result).toEqual({
      created: 0,
      skipped: 15,
      templates: [
        { titulo: 'Checklist Operacional - NR24' },
        { titulo: 'Checklist Operacional - NR10' },
        { titulo: 'Checklist Operacional - NR12' },
        { titulo: 'Checklist Operacional - LOTO' },
        { titulo: 'Checklist Operacional - NR35' },
        { titulo: 'Checklist Operacional - NR33' },
        { titulo: 'Checklist - Máquina de Solda' },
        { titulo: 'Checklist - Lixadeira' },
        { titulo: 'Checklist - Plataforma Elevatória Elétrica (PEMT)' },
        { titulo: 'Checklist - Plataforma Elevatória' },
        { titulo: 'Checklist - Caminhão Munck' },
        { titulo: 'Checklist - Furadeira/Parafusadeira Portátil' },
        { titulo: 'Checklist - Talabarte de Segurança' },
        { titulo: 'Checklist - Escada Extensível' },
        { titulo: 'Checklist - Escada de Abrir' },
      ],
    });
  });

  it('valida codigo publico apenas quando o checklist existe no registry governado', async () => {
    (
      documentRegistryService.validatePublicCode as jest.Mock
    ).mockResolvedValueOnce({
      valid: true,
      code: 'CHK-2025-EF123456',
      document: {
        id: '12345678-1234-1234-1234-abcdef123456',
        module: 'checklist',
      },
    });
    repository.findOne.mockResolvedValueOnce({
      id: '12345678-1234-1234-1234-abcdef123456',
      titulo: 'Checklist 2025',
      status: 'Conforme',
      data: new Date('2025-12-30T00:00:00.000Z'),
      is_modelo: false,
      updated_at: new Date('2025-12-30T18:00:00.000Z'),
      site: { nome: 'Obra A' },
      inspetor: { nome: 'Maria' },
    });

    (
      documentRegistryService.validatePublicCode as jest.Mock
    ).mockResolvedValueOnce({
      valid: false,
      code: 'CHK-2026-EF123456',
      message: 'Documento não encontrado.',
    });

    const valid = await service.validateByCode('CHK-2025-EF123456', 'tenant-1');
    const invalid = await service.validateByCode(
      'CHK-2026-EF123456',
      'tenant-1',
    );

    expect(valid.valid).toBe(true);
    expect(valid.code).toBe('CHK-2025-EF123456');
    expect(invalid.valid).toBe(false);
    expect(documentRegistryService.validatePublicCode).toHaveBeenNthCalledWith(
      1,
      {
        code: 'CHK-2025-EF123456',
        companyId: 'tenant-1',
        expectedModule: 'checklist',
      },
    );
  });

  it('filtra arquivos semanais pela data documental e nao pela criacao', async () => {
    (
      documentGovernanceService.listFinalDocuments as jest.Mock
    ).mockResolvedValue([
      {
        entityId: 'checklist-1',
        title: 'Checklist datado',
        date: new Date('2025-12-31T00:00:00.000Z'),
        id: 'checklist-1',
        companyId: 'company-1',
        fileKey:
          'documents/company-1/checklists/2025/week-01/checklist-1/checklist-checklist-1.pdf',
        folderPath: 'checklists/company-1/2025/week-01',
        originalName: 'checklist-checklist-1.pdf',
      },
    ]);

    (tenantService.getContext as jest.Mock).mockReturnValue({
      companyId: 'company-1',
      siteScope: 'all',
      isSuperAdmin: false,
    });

    const files = await service.listStoredFiles({ year: 2025 });

    expect(files).toHaveLength(1);
    expect(files[0].entityId).toBe('checklist-1');
    expect(documentGovernanceService.listFinalDocuments).toHaveBeenCalledWith(
      'checklist',
      { year: 2025 },
    );
  });

  it('valida contrato legado sem expor metadados', async () => {
    (
      documentRegistryService.validateLegacyPublicCode as jest.Mock
    ).mockResolvedValue({
      valid: true,
      code: 'CHK-2026-EF123456',
    });

    const result = await service.validateByCodeLegacy('CHK-2026-EF123456');
    expect(result).toEqual({
      valid: true,
      code: 'CHK-2026-EF123456',
    });
  });

  it('retorna acesso ao PDF salvo do checklist', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      pdf_file_key: 'documents/company-1/checklists/checklist-1.pdf',
      pdf_folder_path: 'documents/company-1/checklists',
      pdf_original_name: 'checklist-1.pdf',
    } as unknown as Checklist);

    await expect(service.getPdfAccess('checklist-1')).resolves.toEqual({
      entityId: 'checklist-1',
      fileKey: 'documents/company-1/checklists/checklist-1.pdf',
      folderPath: 'documents/company-1/checklists',
      originalName: 'checklist-1.pdf',
      url: 'https://example.com/checklist.pdf',
      hasFinalPdf: true,
      availability: 'ready',
      message: 'PDF final do checklist disponível para acesso.',
    });
  });

  it('retorna signed url indisponivel quando o armazenamento nao resolve o PDF final', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      pdf_file_key: 'documents/company-1/checklists/checklist-1.pdf',
      pdf_folder_path: 'documents/company-1/checklists',
      pdf_original_name: 'checklist-1.pdf',
    } as unknown as Checklist);
    (documentStorageService.getSignedUrl as jest.Mock).mockResolvedValueOnce(
      null,
    );

    await expect(service.getPdfAccess('checklist-1')).resolves.toEqual({
      entityId: 'checklist-1',
      fileKey: 'documents/company-1/checklists/checklist-1.pdf',
      folderPath: 'documents/company-1/checklists',
      originalName: 'checklist-1.pdf',
      url: null,
      hasFinalPdf: true,
      availability: 'registered_without_signed_url',
      message:
        'PDF final registrado, mas a URL assinada não está disponível no momento.',
    });
  });

  it('reaproveita PDF armazenado ao enviar email', async () => {
    const sendStoredDocument = jest.fn().mockResolvedValue({
      success: true,
      message:
        'O documento final governado foi enviado por e-mail com sucesso.',
      deliveryMode: 'sent',
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
    });
    service = new ChecklistsService(
      repository as unknown as Repository<Checklist>,
      tenantService,
      {
        transaction: jest.fn(
          (cb: (m: { getRepository: () => typeof repository }) => unknown) =>
            cb({ getRepository: () => repository }),
        ),
      } as unknown as DataSource,
      { sendStoredDocument } as unknown as MailService,
      signaturesService as unknown as SignaturesService,
      notificationsGateway as NotificationsGateway,
      documentStorageService as DocumentStorageService,
      usersService as unknown as UsersService,
      sitesService as unknown as SitesService,
      documentGovernanceService as DocumentGovernanceService,
      documentRegistryService as DocumentRegistryService,
      {} as FileParserService,
      {
        get: jest.fn(),
      } as unknown as ConfigService,
      {
        execute: jest.fn(async <T>(_name: string, fn: () => Promise<T>) =>
          fn(),
        ),
      } as unknown as IntegrationResilienceService,
      {
        assertRequestAllowed: jest.fn(),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
        isCountableFailureStatus: jest.fn().mockReturnValue(false),
        isCountableFailureError: jest.fn().mockReturnValue(false),
      } as unknown as OpenAiCircuitBreakerService,
      {
        buildWeeklyPdfBundle: jest.fn(),
      } as never,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
    );

    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      titulo: 'Checklist de campo',
      company_id: 'company-1',
      data: new Date('2026-03-14T12:00:00.000Z'),
      pdf_file_key: 'documents/company-1/checklists/checklist-1.pdf',
      pdf_folder_path: 'documents/company-1/checklists',
      pdf_original_name: 'checklist-1.pdf',
    } as unknown as Checklist);
    jest.spyOn(service, 'getPdfAccess').mockResolvedValue({
      entityId: 'checklist-1',
      fileKey: 'documents/company-1/checklists/checklist-1.pdf',
      folderPath: 'documents/company-1/checklists',
      originalName: 'checklist-1.pdf',
      url: 'https://example.com/checklist.pdf',
      hasFinalPdf: true,
      availability: 'ready',
      message: 'PDF final do checklist disponível para acesso.',
    });

    const result = await service.sendEmail(
      'checklist-1',
      'cliente@empresa.com',
    );

    expect(sendStoredDocument).toHaveBeenCalledWith(
      'checklist-1',
      'CHECKLIST',
      'cliente@empresa.com',
      'company-1',
    );
    expect(result).toMatchObject({
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
    });
  });

  it('bloqueia envio de email quando o checklist ainda nao tem PDF final', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      titulo: 'Checklist de campo',
      company_id: 'company-1',
      data: new Date('2026-03-14T12:00:00.000Z'),
      pdf_file_key: null,
    } as unknown as Checklist);
    jest.spyOn(service, 'getPdfAccess').mockResolvedValue({
      entityId: 'checklist-1',
      fileKey: null,
      folderPath: null,
      originalName: null,
      url: null,
      hasFinalPdf: false,
      availability: 'not_emitted',
      message: 'O checklist ainda não possui PDF final emitido.',
    });

    await expect(
      service.sendEmail('checklist-1', 'cliente@empresa.com'),
    ).rejects.toThrow(
      'Emita o PDF final governado antes de enviar este checklist por e-mail.',
    );
  });

  it('anexa foto governada ao item do checklist', async () => {
    const checklistData = {
      id: 'checklist-1',
      company_id: 'company-1',
      titulo: 'Checklist base',
      descricao: 'Descricao',
      equipamento: 'Detector',
      maquina: null,
      foto_equipamento: null,
      data: new Date('2026-03-14T12:00:00.000Z'),
      site_id: 'site-1',
      inspetor_id: 'user-1',
      itens: [{ item: 'Verificar trava', status: 'ok', fotos: [] }],
      is_modelo: false,
      pdf_file_key: null,
      deleted_at: null,
    };
    jest
      .spyOn(service, 'findOneEntity')
      .mockResolvedValue(checklistData as unknown as Checklist);
    _lockedChecklistRow = checklistData;
    (
      signaturesService.removeByDocumentSystem as jest.Mock
    ).mockResolvedValueOnce(1);

    const result = await service.attachItemPhoto(
      'checklist-1',
      0,
      Buffer.from('png'),
      'foto.png',
      'image/png',
    );

    expect(result.scope).toBe('item');
    expect(result.storageMode).toBe('governed-storage');
    expect(result.photoReference).toContain('gst:checklist-photo:');
    expect(signaturesService.removeByDocumentSystem).toHaveBeenCalledWith(
      'checklist-1',
      'CHECKLIST',
      {
        companyId: 'company-1',
        siteId: 'site-1',
      },
    );
  });

  it('permite segundo upload de foto no mesmo item (nao rejeita a foto governada ja existente)', async () => {
    const checklistData = {
      id: 'checklist-1',
      company_id: 'company-1',
      titulo: 'Checklist base',
      foto_equipamento: null,
      data: new Date('2026-03-14T12:00:00.000Z'),
      site_id: 'site-1',
      inspetor_id: 'user-1',
      itens: [{ item: 'Verificar trava', status: 'ok', fotos: [] }],
      is_modelo: false,
      pdf_file_key: null,
      deleted_at: null,
    };
    jest
      .spyOn(service, 'findOneEntity')
      .mockResolvedValue(checklistData as unknown as Checklist);
    _lockedChecklistRow = checklistData;
    (signaturesService.removeByDocumentSystem as jest.Mock).mockResolvedValue(
      1,
    );

    const first = await service.attachItemPhoto(
      'checklist-1',
      0,
      Buffer.from('png'),
      'foto-1.png',
      'image/png',
    );
    expect(first.photoIndex).toBe(0);

    // A linha travada agora reflete a 1a foto governada. O 2o upload no mesmo
    // item NAO pode ser rejeitado pela validacao de referencia governada.
    const second = await service.attachItemPhoto(
      'checklist-1',
      0,
      Buffer.from('png'),
      'foto-2.png',
      'image/png',
    );
    expect(second.photoIndex).toBe(1);
    expect(second.storageMode).toBe('governed-storage');
  });

  it('upload de foto em item diferente preserva as fotos ja anexadas em outros itens', async () => {
    const checklistData = {
      id: 'checklist-1',
      company_id: 'company-1',
      titulo: 'Checklist base',
      foto_equipamento: null,
      data: new Date('2026-03-14T12:00:00.000Z'),
      site_id: 'site-1',
      inspetor_id: 'user-1',
      itens: [
        { item: 'Item A', status: 'ok', fotos: [] },
        { item: 'Item B', status: 'ok', fotos: [] },
      ],
      is_modelo: false,
      pdf_file_key: null,
      deleted_at: null,
    };
    jest
      .spyOn(service, 'findOneEntity')
      .mockResolvedValue(checklistData as unknown as Checklist);
    _lockedChecklistRow = checklistData;
    (signaturesService.removeByDocumentSystem as jest.Mock).mockResolvedValue(
      1,
    );

    await service.attachItemPhoto(
      'checklist-1',
      0,
      Buffer.from('png'),
      'a.png',
      'image/png',
    );
    const second = await service.attachItemPhoto(
      'checklist-1',
      1,
      Buffer.from('png'),
      'b.png',
      'image/png',
    );

    expect(second.itemIndex).toBe(1);
    const itens = (_lockedChecklistRow as { itens: Array<{ fotos: string[] }> })
      .itens;
    expect(itens[0].fotos).toHaveLength(1);
    expect(itens[1].fotos).toHaveLength(1);
    expect(itens[0].fotos[0]).not.toBe(itens[1].fotos[0]);
  });

  it('retorna acesso governado para a foto do equipamento do checklist', async () => {
    const checklistData = {
      id: 'checklist-1',
      company_id: 'company-1',
      is_modelo: false,
      pdf_file_key: null,
      deleted_at: null,
    };
    jest
      .spyOn(service, 'findOneEntity')
      .mockResolvedValue(checklistData as unknown as Checklist);
    _lockedChecklistRow = checklistData;

    const attached = await service.attachEquipmentPhoto(
      'checklist-1',
      Buffer.from('png'),
      'foto.png',
      'image/png',
    );

    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      company_id: 'company-1',
      is_modelo: false,
      foto_equipamento: attached.photoReference,
      pdf_file_key: null,
    } as unknown as Checklist);

    await expect(
      service.getEquipmentPhotoAccess('checklist-1'),
    ).resolves.toEqual({
      entityId: 'checklist-1',
      scope: 'equipment',
      itemIndex: null,
      photoIndex: null,
      hasGovernedPhoto: true,
      availability: 'ready',
      fileKey: 'documents/company-1/checklist-photos/checklist-1/foto.png',
      originalName: 'foto.png',
      mimeType: 'image/png',
      url: 'https://example.com/checklist.pdf',
      degraded: false,
      message: null,
    });
  });

  it('bloqueia acesso governado quando o equipamento nao possui foto armazenada', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      company_id: 'company-1',
      is_modelo: false,
      foto_equipamento: null,
      pdf_file_key: null,
    } as unknown as Checklist);

    await expect(
      service.getEquipmentPhotoAccess('checklist-1'),
    ).rejects.toThrow(
      'O checklist não possui foto do equipamento em armazenamento governado.',
    );
  });

  it('retorna acesso governado para a foto do item do checklist', async () => {
    const checklistData = {
      id: 'checklist-1',
      company_id: 'company-1',
      is_modelo: false,
      pdf_file_key: null,
      deleted_at: null,
      itens: [
        {
          item: 'Verificar trava',
          fotos: [],
        },
      ],
    };
    jest
      .spyOn(service, 'findOneEntity')
      .mockResolvedValue(checklistData as unknown as Checklist);
    _lockedChecklistRow = checklistData;

    const attached = await service.attachItemPhoto(
      'checklist-1',
      0,
      Buffer.from('png'),
      'foto.png',
      'image/png',
    );

    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      company_id: 'company-1',
      is_modelo: false,
      itens: [
        {
          item: 'Verificar trava',
          fotos: [attached.photoReference],
        },
      ],
    } as unknown as Checklist);

    await expect(
      service.getItemPhotoAccess('checklist-1', 0, 0),
    ).resolves.toEqual({
      entityId: 'checklist-1',
      scope: 'item',
      itemIndex: 0,
      photoIndex: 0,
      hasGovernedPhoto: true,
      availability: 'ready',
      fileKey: 'documents/company-1/checklist-photos/checklist-1/foto.png',
      originalName: 'foto.png',
      mimeType: 'image/png',
      url: 'https://example.com/checklist.pdf',
      degraded: false,
      message: null,
    });
  });

  it('bloqueia acesso governado quando a foto do item nao existe', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      company_id: 'company-1',
      is_modelo: false,
      pdf_file_key: null,
      itens: [
        {
          item: 'Verificar trava',
          fotos: [],
        },
      ],
    } as unknown as Checklist);

    await expect(
      service.getItemPhotoAccess('checklist-1', 0, 0),
    ).rejects.toThrow('A foto do item não está em armazenamento governado.');
  });

  it('retorna estado explicito quando checklist ainda não tem PDF salvo', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'checklist-1',
      pdf_file_key: null,
      company_id: 'company-1',
    } as unknown as Checklist);

    await expect(service.getPdfAccess('checklist-1')).resolves.toEqual({
      entityId: 'checklist-1',
      fileKey: null,
      folderPath: null,
      originalName: null,
      url: null,
      hasFinalPdf: false,
      availability: 'not_emitted',
      message: 'O checklist ainda não possui PDF final emitido.',
    });
  });

  // ── ensureCompanyPresetsExist (auto-bootstrap) ────────────────────────────

  describe('ensureCompanyPresetsExist via findPaginated', () => {
    it('executa bootstrap automatico quando empresa nao possui nenhum template', async () => {
      repository.count.mockResolvedValueOnce(0);
      repository.find.mockResolvedValueOnce([]);
      repository.save.mockResolvedValueOnce(
        Array.from({ length: 15 }, (_, i) => ({
          id: `tpl-${i}`,
          titulo: `Template ${i}`,
          is_modelo: true,
          company_id: 'company-1',
        })),
      );
      repository.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findPaginated({ onlyTemplates: true });

      const countCalls = repository.count.mock.calls as Array<
        [{ where?: Partial<Checklist> }]
      >;
      expect(countCalls[0]?.[0].where).toMatchObject({
        company_id: 'company-1',
        is_modelo: true,
      });
      expect(repository.save).toHaveBeenCalled();
    });

    it('nao executa bootstrap quando empresa ja possui templates', async () => {
      repository.count.mockResolvedValueOnce(5);
      repository.findAndCount.mockResolvedValueOnce([[], 5]);

      await service.findPaginated({ onlyTemplates: true });

      expect(repository.save).not.toHaveBeenCalled();
    });

    it('nao executa bootstrap quando onlyTemplates nao esta ativo', async () => {
      repository.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findPaginated({ onlyTemplates: false });

      expect(repository.count).not.toHaveBeenCalled();
    });

    it('executa bootstrap automatico em findAll com onlyTemplates', async () => {
      repository.count.mockResolvedValueOnce(0);
      repository.find
        .mockResolvedValueOnce([]) // bootstrap: sem templates existentes
        .mockResolvedValueOnce([]); // findAll result
      repository.save.mockResolvedValueOnce([]);

      await service.findAll({ onlyTemplates: true });

      const countCalls = repository.count.mock.calls as Array<
        [{ where?: Partial<Checklist> }]
      >;
      expect(countCalls[0]?.[0].where).toMatchObject({
        company_id: 'company-1',
        is_modelo: true,
      });
      expect(repository.save).toHaveBeenCalled();
    });

    it('nao executa bootstrap em findAll quando ja existem templates', async () => {
      repository.count.mockResolvedValueOnce(3);
      repository.find.mockResolvedValueOnce([
        { id: 'tpl-1', titulo: 'Template A', is_modelo: true },
      ]);

      const result = await service.findAll({ onlyTemplates: true });

      expect(repository.count).toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });

  // ── findPaginated com segmentos ───────────────────────────────────────────

  describe('findPaginated com segmentos', () => {
    type AndWhereCall = [string, Record<string, unknown>?];

    const buildQb = () => {
      const qb = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      repository.createQueryBuilder.mockReturnValue(qb);
      repository.count.mockResolvedValue(5);
      return qb;
    };

    const getAndWhereCalls = (qb: ReturnType<typeof buildQb>): AndWhereCall[] =>
      qb.andWhere.mock.calls as AndWhereCall[];

    it('aplica clausula de categoria Operacional e keywords para segmento normativos', async () => {
      const qb = buildQb();

      await service.findPaginated({
        onlyTemplates: true,
        segment: 'normativos',
      });

      const andWhereCalls = getAndWhereCalls(qb);
      const segmentCall = andWhereCalls.find(([sql]) =>
        sql.includes('normativos_category'),
      );
      expect(segmentCall).toBeDefined();
      expect(segmentCall![1]).toMatchObject({
        normativos_category: 'Operacional',
      });

      const keywordCall = andWhereCalls.find(([sql]) =>
        sql.includes('normativos_keyword'),
      );
      expect(keywordCall).toBeDefined();
      expect(keywordCall![1]).toMatchObject(
        expect.objectContaining({ normativos_keyword_0: '%nr%' }),
      );
    });

    it('aplica clausula NOT para excluir outros segmentos em operacionais', async () => {
      const qb = buildQb();

      await service.findPaginated({
        onlyTemplates: true,
        segment: 'operacionais',
      });

      const andWhereCalls = getAndWhereCalls(qb);
      const segmentCall = andWhereCalls.find(([sql]) =>
        sql.includes('operacionais_category'),
      );
      expect(segmentCall).toBeDefined();
      expect(segmentCall![0]).toContain('NOT');
    });

    it('aplica clausula de categoria Equipamento para segmento equipamentos', async () => {
      const qb = buildQb();

      await service.findPaginated({
        onlyTemplates: true,
        segment: 'equipamentos',
      });

      const andWhereCalls = getAndWhereCalls(qb);
      const segmentCall = andWhereCalls.find(([sql]) =>
        sql.includes('equipamentos_category'),
      );
      expect(segmentCall).toBeDefined();
      expect(segmentCall![1]).toMatchObject({
        equipamentos_category: 'Equipamento',
      });
    });

    it('aplica clausula de keywords para segmento veiculos sem filtro de categoria fixo', async () => {
      const qb = buildQb();

      await service.findPaginated({ onlyTemplates: true, segment: 'veiculos' });

      const andWhereCalls = getAndWhereCalls(qb);
      const segmentCall = andWhereCalls.find(([sql]) =>
        sql.includes('veiculos_vehicle'),
      );
      expect(segmentCall).toBeDefined();
      expect(segmentCall![1]).toMatchObject(
        expect.objectContaining({ veiculos_vehicle_0: '%veiculo%' }),
      );
    });

    it('aplica clausula de categoria EPI e keywords para segmento epis', async () => {
      const qb = buildQb();

      await service.findPaginated({ onlyTemplates: true, segment: 'epis' });

      const andWhereCalls = getAndWhereCalls(qb);
      const segmentCall = andWhereCalls.find(([sql]) =>
        sql.includes('epis_category'),
      );
      expect(segmentCall).toBeDefined();
      expect(segmentCall![1]).toMatchObject({ epis_category: 'EPI' });
    });

    it('ignora segment invalido e usa findAndCount sem queryBuilder', async () => {
      repository.count.mockResolvedValue(5);
      repository.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findPaginated({ onlyTemplates: true, segment: 'invalido' });

      expect(repository.createQueryBuilder).not.toHaveBeenCalled();
      expect(repository.findAndCount).toHaveBeenCalled();
    });

    it('retorna paginacao correta com page e limit customizados', async () => {
      repository.count.mockResolvedValue(5);
      const templates = Array.from({ length: 5 }, (_, i) => ({
        id: `tpl-${i}`,
        titulo: `Template ${i}`,
        company_id: 'company-1',
        is_modelo: true,
        deleted_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        data: new Date(),
        status: 'Pendente',
        ativo: true,
        itens: [],
      }));
      repository.findAndCount.mockResolvedValueOnce([templates, 25]);

      const result = await service.findPaginated({
        onlyTemplates: true,
        page: 2,
        limit: 5,
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(5);
      expect(result.total).toBe(25);
      expect(result.lastPage).toBe(5);
      expect(result.data).toHaveLength(5);
    });

    it('aplica filtro de categoria em findPaginated sem segment', async () => {
      repository.count.mockResolvedValue(5);
      repository.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findPaginated({
        onlyTemplates: true,
        category: 'Equipamento',
      });

      const findAndCountCalls = repository.findAndCount.mock.calls as Array<
        [{ where?: Partial<Checklist> }]
      >;
      const findAndCountArg = findAndCountCalls[0]?.[0];
      expect(findAndCountArg.where).toMatchObject({
        categoria: 'Equipamento',
      });
    });
  });

  // ── create: modelos não exigem site/inspetor ──────────────────────────────

  describe('create modelo de checklist', () => {
    it('cria modelo sem exigir site_id ou inspetor_id', async () => {
      await expect(
        service.create({
          titulo: 'Modelo de Inspeção NR-12',
          data: '2026-03-14',
          is_modelo: true,
          categoria: 'Operacional',
          itens: [{ item: 'Verificar proteções fixas', status: 'ok' }],
        } as unknown as CreateChecklistDto),
      ).resolves.toBeDefined();

      expect(repository.save).toHaveBeenCalled();
    });

    it('cria modelo preservando categoria e periodicidade', async () => {
      await service.create({
        titulo: 'Modelo LOTO',
        data: '2026-03-14',
        is_modelo: true,
        categoria: 'Operacional',
        periodicidade: 'Por intervenção',
        nivel_risco_padrao: 'Alto',
        itens: [{ item: 'Bloqueio identificado', status: 'ok' }],
      } as unknown as CreateChecklistDto);

      const payload = getFirstCreatedChecklistPayload();
      expect(payload).toMatchObject({
        categoria: 'Operacional',
        periodicidade: 'Por intervenção',
        nivel_risco_padrao: 'Alto',
        is_modelo: true,
      });
    });
  });

  // ── deriveChecklistStatus edge cases ─────────────────────────────────────

  describe('deriveChecklistStatus via create', () => {
    it('retorna Conforme quando todos os itens sao ok ou sim', async () => {
      const result = await service.create({
        titulo: 'Checklist ok',
        data: '2026-03-14',
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [
          { item: 'Item 1', status: 'ok' },
          { item: 'Item 2', status: 'sim' },
          { item: 'Item 3', status: 'Conforme' },
        ],
        is_modelo: false,
      } as unknown as CreateChecklistDto);

      expect(result.status).toBe('Conforme');
    });

    it('retorna Pendente quando todos os itens estao pendentes', async () => {
      const result = await service.create({
        titulo: 'Checklist pendente',
        data: '2026-03-14',
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [{ item: 'Item 1' }, { item: 'Item 2', status: 'Pendente' }],
        is_modelo: false,
      } as unknown as CreateChecklistDto);

      expect(result.status).toBe('Pendente');
    });

    it('retorna Nao Conforme com item nao e outro ok', async () => {
      const result = await service.create({
        titulo: 'Checklist misto',
        data: '2026-03-14',
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [
          { item: 'Item ok', status: 'ok' },
          { item: 'Item nao', status: 'nao' },
        ],
        is_modelo: false,
      } as unknown as CreateChecklistDto);

      expect(result.status).toBe('Não Conforme');
    });

    it('retorna Nao Conforme com item N/A e outro nok', async () => {
      const result = await service.create({
        titulo: 'Checklist na/nok',
        data: '2026-03-14',
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [
          { item: 'Item NA', status: 'na' },
          { item: 'Item nok', status: 'nok' },
        ],
        is_modelo: false,
      } as unknown as CreateChecklistDto);

      expect(result.status).toBe('Não Conforme');
    });
  });

  // ── fillFromTemplate: reset e isolamento de estado ───────────────────────

  describe('fillFromTemplate edge cases', () => {
    const buildTemplate = (overrides?: Partial<Checklist>): Checklist =>
      ({
        id: 'template-1',
        titulo: 'Modelo NR10',
        descricao: 'Template de inspeção',
        equipamento: null,
        maquina: null,
        foto_equipamento: null,
        data: new Date('2026-01-01'),
        status: 'Pendente',
        company_id: 'company-1',
        site_id: null,
        inspetor_id: null,
        itens: [
          {
            id: 'item-1',
            item: 'Verificar aterramento',
            tipo_resposta: 'sim_nao_na',
            obrigatorio: true,
            status: 'nok',
            observacao: 'Pendência do template',
            fotos: ['foto-template.png'],
            subitens: [
              { texto: 'Condutor PE', status: 'nao', observacao: 'defeito' },
            ],
          },
        ],
        is_modelo: true,
        ativo: true,
        categoria: 'Operacional',
        periodicidade: 'Por atividade',
        nivel_risco_padrao: 'Alto',
        pdf_file_key: null,
        pdf_folder_path: null,
        pdf_original_name: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
      }) as unknown as Checklist;

    it('redefine status (para sim em sim_nao_na), observacao e fotos dos itens ao preencher a partir de template', async () => {
      jest.spyOn(service, 'findOneEntity').mockResolvedValue(buildTemplate());

      await service.fillFromTemplate('template-1', {
        data: '2026-04-01',
        site_id: 'site-1',
        inspetor_id: 'user-1',
      });

      const payload = getFirstCreatedChecklistPayload();
      const item = payload.itens?.[0];
      expect(item?.status).toBe('sim'); // tipo_resposta: 'sim_nao_na' → reset para 'sim'
      expect(item?.observacao).toBe('');
      expect(item?.fotos).toEqual([]);
    });

    it('redefine status e observacao dos subitens ao preencher a partir de template', async () => {
      jest.spyOn(service, 'findOneEntity').mockResolvedValue(buildTemplate());

      await service.fillFromTemplate('template-1', {
        data: '2026-04-01',
        site_id: 'site-1',
        inspetor_id: 'user-1',
      });

      const payload = getFirstCreatedChecklistPayload();
      const subitem = payload.itens?.[0]?.subitens?.[0];
      expect(subitem?.status).toBeUndefined(); // subitems resetados
      expect(subitem?.observacao).toBe('');
    });

    it('rejeita fillFromTemplate quando o checklist referenciado nao e modelo', async () => {
      jest
        .spyOn(service, 'findOneEntity')
        .mockResolvedValue(buildTemplate({ is_modelo: false }));

      await expect(
        service.fillFromTemplate('template-1', {
          data: '2026-04-01',
          site_id: 'site-1',
          inspetor_id: 'user-1',
        }),
      ).rejects.toThrow('O checklist especificado não é um template');
    });

    it('preserva titulo, descricao, categoria e periodicidade do template no novo checklist', async () => {
      jest.spyOn(service, 'findOneEntity').mockResolvedValue(buildTemplate());

      await service.fillFromTemplate('template-1', {
        data: '2026-04-01',
        site_id: 'site-1',
        inspetor_id: 'user-1',
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          titulo: 'Modelo NR10',
          descricao: 'Template de inspeção',
          categoria: 'Operacional',
          periodicidade: 'Por atividade',
          nivel_risco_padrao: 'Alto',
          template_id: 'template-1',
          is_modelo: false,
        }),
      );
    });
  });

  // ── bootstrap: idempotência parcial ──────────────────────────────────────

  describe('createPresetTemplates idempotencia parcial', () => {
    it('cria apenas os templates que ainda nao existem quando ha bootstrap parcial', async () => {
      repository.find.mockResolvedValueOnce([
        { titulo: 'Checklist Operacional - NR24' },
        { titulo: 'Checklist Operacional - NR10' },
      ]);
      repository.save.mockImplementation((payload: Partial<Checklist>[]) =>
        Promise.resolve(
          payload.map((item, i) => ({
            id: `tpl-${i}`,
            created_at: new Date(),
            updated_at: new Date(),
            ...item,
          })),
        ),
      );

      const result = await service.createPresetTemplates();

      expect(result.created).toBe(13);
      expect(result.skipped).toBe(2);
      const savedTitles = (
        repository.save.mock.calls[0] as [Partial<Checklist>[]]
      )[0].map((t) => t.titulo);
      expect(savedTitles).not.toContain('Checklist Operacional - NR24');
      expect(savedTitles).not.toContain('Checklist Operacional - NR10');
    });

    it('não recria o modelo de máquina de solda quando já existe o título legado', async () => {
      repository.find.mockResolvedValueOnce([
        { titulo: 'Checklist de Máquina de Solda' },
      ]);
      repository.save.mockImplementation((payload: Partial<Checklist>[]) =>
        Promise.resolve(
          payload.map((item, i) => ({
            id: `tpl-${i}`,
            created_at: new Date(),
            updated_at: new Date(),
            ...item,
          })),
        ),
      );

      const result = await service.createPresetTemplates();

      expect(result.created).toBe(14);
      expect(result.skipped).toBe(1);
      const savedTitles = (
        repository.save.mock.calls[0] as [Partial<Checklist>[]]
      )[0].map((t) => t.titulo);
      expect(savedTitles).not.toContain('Checklist - Máquina de Solda');
    });
  });

  // ── update: validações complementares ────────────────────────────────────

  describe('update validacoes', () => {
    it('nao invalida assinaturas quando apenas campos de auditoria pos-assinatura mudam', async () => {
      jest.spyOn(service, 'findOneEntity').mockResolvedValue({
        id: 'checklist-1',
        company_id: 'company-1',
        titulo: 'Checklist base',
        descricao: 'Descricao',
        equipamento: 'Detector',
        maquina: null,
        foto_equipamento: null,
        data: new Date('2026-03-14T12:00:00.000Z'),
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [{ item: 'Verificar trava', status: 'ok', fotos: [] }],
        is_modelo: false,
        pdf_file_key: null,
        categoria: 'SST',
        periodicidade: 'Diário',
        nivel_risco_padrao: 'Médio',
        auditado_por_id: null,
        data_auditoria: null,
        resultado_auditoria: null,
        notas_auditoria: null,
      } as unknown as Checklist);

      // auditado_por_id e data_auditoria sao campos do auditor preenchidos apos a
      // assinatura do inspetor — nao devem invalidar assinaturas
      await service.update('checklist-1', {
        auditado_por_id: 'user-2',
        data_auditoria: '2026-04-28',
      });

      expect(signaturesService.removeByDocumentSystem).not.toHaveBeenCalled();
    });

    it('rejeita referencia governada arbitraria enviada fora do endpoint governado (update)', async () => {
      jest.spyOn(service, 'findOneEntity').mockResolvedValue({
        id: 'checklist-1',
        company_id: 'company-1',
        titulo: 'Checklist base',
        descricao: null,
        equipamento: null,
        maquina: null,
        foto_equipamento: null,
        data: new Date('2026-03-14T12:00:00.000Z'),
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [{ item: 'Item 1', status: 'ok', fotos: [] }],
        is_modelo: false,
        pdf_file_key: null,
        categoria: null,
        periodicidade: null,
        nivel_risco_padrao: null,
        auditado_por_id: null,
        data_auditoria: null,
        resultado_auditoria: null,
        notas_auditoria: null,
      } as unknown as Checklist);

      const forgedReference =
        'gst:checklist-photo:' +
        Buffer.from(
          JSON.stringify({
            v: 1,
            kind: 'governed-storage',
            scope: 'item',
            fileKey: 'documents/outra-empresa/forjada.png',
            originalName: 'forjada.png',
            mimeType: 'image/png',
            uploadedAt: '2026-03-14T12:00:00.000Z',
          }),
        ).toString('base64url');

      await expect(
        service.update('checklist-1', {
          itens: [
            { item: 'Item 1', status: 'ok', fotos: [forgedReference] },
          ] as unknown as import('./dto/checklist-item.dto').ChecklistItemDto[],
        }),
      ).rejects.toThrow('endpoint governado');
    });

    it('recalcula status ao atualizar itens via update', async () => {
      jest.spyOn(service, 'findOneEntity').mockResolvedValue({
        id: 'checklist-1',
        company_id: 'company-1',
        titulo: 'Checklist base',
        descricao: null,
        equipamento: null,
        maquina: null,
        foto_equipamento: null,
        data: new Date('2026-03-14T12:00:00.000Z'),
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [{ item: 'Item 1', status: 'ok', fotos: [] }],
        is_modelo: false,
        pdf_file_key: null,
        categoria: null,
        periodicidade: null,
        nivel_risco_padrao: null,
        auditado_por_id: null,
        data_auditoria: null,
        resultado_auditoria: null,
        notas_auditoria: null,
      } as unknown as Checklist);

      const result = await service.update('checklist-1', {
        itens: [
          { item: 'Item 1', status: 'ok' },
          { item: 'Item 2', status: 'nok' },
        ] as unknown as import('./dto/checklist-item.dto').ChecklistItemDto[],
      });

      expect(result.status).toBe('Não Conforme');
    });
  });

  // ── sanitização de entradas (HTML escape + remoção null-byte) ──────────────

  describe('sanitização de texto plano', () => {
    it('sanitiza titulo, descricao, observacoes e subitens removendo tags e null bytes', async () => {
      const result = await service.create({
        titulo: 'Checklist <script>alert(1)</script> & "teste" \u0000',
        descricao: '<b>desc</b> perigosa',
        data: '2026-03-14',
        company_id: 'company-1',
        site_id: 'site-1',
        inspetor_id: 'user-1',
        itens: [
          {
            item: 'Item com <img src=x onerror=1>',
            observacao: 'obs com & e < > \u0000',
            subitens: [
              { texto: 'sub <script>evil</script>', observacao: 'subobs' },
            ],
          },
        ],
        is_modelo: false,
      } as unknown as CreateChecklistDto);

      const created = getFirstCreatedChecklistPayload();
      expect(created.titulo).toBe(
        'Checklist &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;teste&quot; ',
      );
      expect(created.descricao).toBe('&lt;b&gt;desc&lt;/b&gt; perigosa');
      const firstItem = created.itens?.[0];
      expect(firstItem?.item).toBe('Item com &lt;img src=x onerror=1&gt;');
      expect(firstItem?.observacao).toBe('obs com &amp; e &lt; &gt; ');
      expect(firstItem?.subitens?.[0]?.texto).toBe(
        'sub &lt;script&gt;evil&lt;/script&gt;',
      );

      // status derivado a partir de itens sem falhas explicitas
      expect(['Pendente', 'Conforme']).toContain(result.status);
    });

    it('rejeita javascript: em imagens inline mas sanitiza outros textos', async () => {
      await expect(
        service.create({
          titulo: 'Com foto inline invalida',
          data: '2026-03-14',
          company_id: 'company-1',
          site_id: 'site-1',
          inspetor_id: 'user-1',
          itens: [
            {
              item: 'Foto',
              fotos: ['javascript:alert(1)'],
            },
          ],
          is_modelo: false,
        } as unknown as CreateChecklistDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── scoping / tenant e site access ────────────────────────────────────────

  describe('escopo de tenant e site (findOne/findPaginated)', () => {
    it('findOneEntity retorna NotFound para checklist fora do escopo de site do usuario', async () => {
      const scopedChecklist = {
        id: 'cl-1',
        company_id: 'company-1',
        site_id: 'site-2', // fora do escopo do usuario
        deleted_at: null,
      } as unknown as Checklist;

      (tenantService.getContext as jest.Mock).mockReturnValue({
        companyId: 'company-1',
        siteId: 'site-1',
        siteScope: 'single',
        isSuperAdmin: false,
      });
      repository.findOne.mockResolvedValueOnce(scopedChecklist);

      await expect(service.findOne('cl-1')).rejects.toThrow(
        'Checklist com ID cl-1 não encontrado',
      );
    });

    it('findPaginated aplica filtro site_id quando siteScope single e nao superadmin', async () => {
      (tenantService.getContext as jest.Mock).mockReturnValue({
        companyId: 'company-1',
        siteId: 'site-1',
        siteIds: ['site-1'],
        siteScope: 'single',
        isSuperAdmin: false,
      });
      repository.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findPaginated({});

      const callArg = (
        repository.findAndCount.mock.calls as Array<
          [{ where?: Record<string, unknown> }]
        >
      ).at(-1)?.[0];
      expect(callArg?.where?.site_id).toBeDefined();
    });

    it('findPaginated permite acesso amplo para super admin (sem filtro site)', async () => {
      (tenantService.getContext as jest.Mock).mockReturnValue({
        companyId: 'company-1',
        siteScope: 'all',
        isSuperAdmin: true,
      });
      repository.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findPaginated({});

      const callArg = (
        repository.findAndCount.mock.calls as Array<
          [{ where?: Record<string, unknown> }]
        >
      ).at(-1)?.[0];
      expect(callArg?.where?.site_id).toBeUndefined();
    });
  });

  // ── remoção transacional e atomicidade ────────────────────────────────────

  describe('remoção transacional (remove)', () => {
    it('executa remove com tx para governance, softDelete, cleanup fotos e reset signatures', async () => {
      const checklist = {
        id: 'checklist-del',
        company_id: 'company-1',
        site_id: 'site-1',
        foto_equipamento: null,
        itens: [],
      } as unknown as Checklist;

      const softDelete = jest.fn();
      const manager = {
        getRepository: jest.fn(() => ({ softDelete })),
      };

      jest.spyOn(service, 'findOneEntity').mockResolvedValue(checklist);
      (
        documentGovernanceService.removeFinalDocumentReference as jest.Mock
      ).mockImplementation(async (input: Record<string, unknown>) => {
        const fn = input.removeEntityState as
          ((m: unknown) => Promise<void>) | undefined;
        if (fn) await fn(manager);
      });

      const _cleanupSpy = jest
        .spyOn(
          service as unknown as Record<string, jest.Mock>,
          'cleanupGovernedChecklistPhotoFiles',
        )
        .mockResolvedValue(undefined);

      const resetSpy = jest
        .spyOn(
          service as unknown as Record<string, jest.Mock>,
          'resetChecklistSignatures',
        )
        .mockResolvedValue(undefined);

      await service.remove('checklist-del');

      expect(
        documentGovernanceService.removeFinalDocumentReference,
      ).toHaveBeenCalled();
      expect(softDelete).toHaveBeenCalledWith('checklist-del');
      // sem entradas de foto governada neste teste, cleanup nao disparado
      expect(resetSpy).toHaveBeenCalled();
    });

    it('bloqueia remocao de checklist que ja tem PDF final emitido', async () => {
      const checklist = {
        id: 'checklist-del',
        company_id: 'company-1',
        pdf_file_key: 'documents/checklist-del.pdf',
      } as unknown as Checklist;

      jest.spyOn(service, 'findOneEntity').mockResolvedValue(checklist);

      await expect(service.remove('checklist-del')).rejects.toThrow(
        'sem PDF final',
      );
      expect(
        documentGovernanceService.removeFinalDocumentReference,
      ).not.toHaveBeenCalled();
    });
  });

  // ── testes de índices de performance (via mocks de query) ─────────────────

  describe('índices de performance (verificação de queries otimizadas)', () => {
    it('findPaginated usa filtros por company_id + created_at (índices compostos)', async () => {
      repository.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findPaginated({ page: 1, limit: 20 });

      const lastCall = (
        repository.findAndCount.mock.calls as Array<
          [{ where?: Record<string, unknown>; order?: Record<string, string> }]
        >
      ).at(-1)?.[0];
      expect(lastCall?.where?.company_id).toBe('company-1');
      expect(lastCall?.order).toMatchObject({ created_at: 'DESC' });
    });

    it('usa queryBuilder com where company+site+status quando segment (alinhado com idx_checklists_company_site_status_created)', async () => {
      const qb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
      };
      repository.createQueryBuilder.mockReturnValue(qb);

      (tenantService.getContext as jest.Mock).mockReturnValue({
        companyId: 'company-1',
        siteScope: 'all',
        isSuperAdmin: true,
      });

      await service.findPaginated({ segment: 'operacionais' });

      expect(repository.createQueryBuilder).toHaveBeenCalledWith('checklist');
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('company_id'),
        expect.any(Object),
      );
    });
  });

  // Nota de expansão: sanitização no importFromWord (AI/stub path) agora força sanitizePlainText em campos (ver service.ts:3483+).
  // Testes de import full requerem mocks de fileParser + ai (coberto por E2E/load). Scoping de templates e rate em guards são testados via metadata e overrides.
});
