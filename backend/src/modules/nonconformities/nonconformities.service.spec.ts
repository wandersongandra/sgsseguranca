import { Repository } from 'typeorm';
import { NonConformitiesService, NcStatus } from './nonconformities.service';
import { NonConformity } from './entities/nonconformity.entity';
import { NonConformityResponseDto } from './dto/nonconformity-response.dto';
import { Checklist } from '../checklists/entities/checklist.entity';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { AuditService } from '../audit-trail/audit.service';
import type { Site } from '../sites/entities/site.entity';
import type { NonConformityWorkflowLockService } from './services/nonconformity-workflow-lock.service';

type RemoveFinalDocumentReferenceInput = Parameters<
  DocumentGovernanceService['removeFinalDocumentReference']
>[0];

describe('NonConformitiesService', () => {
  let service: NonConformitiesService;
  let _lockedNcRow: Record<string, unknown> | null = null;
  let repository: {
    create: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let sitesRepository: {
    findOne: jest.Mock;
  };
  let checklistsRepository: {
    findOne: jest.Mock;
  };
  let documentStorageService: Pick<
    DocumentStorageService,
    'uploadFile' | 'deleteFile' | 'getSignedUrl' | 'generateDocumentKey'
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
  let auditService: Pick<AuditService, 'log'>;
  let workflowLock: { runExclusive: jest.Mock };

  beforeEach(() => {
    _lockedNcRow = null;
    repository = {
      create: jest.fn((input: Partial<NonConformity>) => input),
      findOne: jest.fn(),
      find: jest.fn(() => Promise.resolve([])),
      save: jest.fn((input) =>
        Promise.resolve(input as unknown as NonConformity),
      ),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    (repository as unknown as { manager: { transaction: jest.Mock } }).manager =
      {
        transaction: jest.fn((fn: (m: unknown) => unknown) => {
          const lockedRow = _lockedNcRow;
          const innerRepo = {
            create: jest.fn((data: unknown) => data as NonConformity),
            save: jest.fn((data: unknown) =>
              Promise.resolve({
                id: 'nc-1',
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
    sitesRepository = {
      findOne: jest.fn(),
    };
    checklistsRepository = {
      findOne: jest.fn(),
    };
    documentStorageService = {
      uploadFile: jest.fn(),
      deleteFile: jest.fn(() => Promise.resolve()),
      generateDocumentKey: jest.fn(
        (
          companyId: string,
          documentType: string,
          documentId: string,
          originalName: string,
        ) =>
          `documents/${companyId}/${documentType}/${documentId}/${originalName}`,
      ),
      getSignedUrl: jest.fn(() =>
        Promise.resolve('https://example.com/nc.pdf'),
      ),
    };
    documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(() =>
        Promise.resolve({
          buffer: Buffer.from('nc-bundle'),
          fileName: 'Nao_Conformidade-2026-W11.pdf',
        }),
      ),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
      listFinalDocuments: jest.fn(),
    };
    auditService = { log: jest.fn() };
    workflowLock = {
      runExclusive: jest.fn(
        async (
          _id: string,
          operation: (assertLeaseHealthy: () => void) => Promise<unknown>,
        ): Promise<unknown> => operation(() => undefined),
      ),
    };

    sitesRepository.findOne.mockResolvedValue({
      id: 'site-1',
      company_id: 'company-1',
      status: true,
    });
    checklistsRepository.findOne.mockResolvedValue(null);

    service = new NonConformitiesService(
      repository as unknown as Repository<NonConformity>,
      sitesRepository as unknown as Repository<Site>,
      checklistsRepository as unknown as Repository<Checklist>,
      {
        getTenantId: jest.fn(() => 'company-1'),
        getContext: jest.fn(() => ({
          companyId: 'company-1',
          isSuperAdmin: false,
          siteScope: 'all',
        })),
      } as unknown as TenantService,
      documentStorageService as DocumentStorageService,
      documentBundleService as DocumentBundleService,
      documentGovernanceService as DocumentGovernanceService,
      auditService as AuditService,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
      workflowLock as unknown as NonConformityWorkflowLockService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('remove a NC via esteira central para limpar o registry corretamente', async () => {
    const nc = {
      id: 'nc-1',
      company_id: 'company-1',
    } as unknown as NonConformity;
    const softDelete = jest.fn();
    const manager = {
      query: jest.fn().mockResolvedValue([nc]),
      getRepository: jest.fn(() => ({
        create: jest.fn((row: NonConformity) => row),
        softDelete,
      })),
    };
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(nc);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: RemoveFinalDocumentReferenceInput) => {
      await input.removeEntityState?.(manager as never);
    });

    await expect(service.remove('nc-1')).resolves.toBeUndefined();

    const [removeInput] = (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mock.calls[0] as [RemoveFinalDocumentReferenceInput];
    expect(removeInput.companyId).toBe('company-1');
    expect(removeInput.module).toBe('nonconformity');
    expect(removeInput.entityId).toBe('nc-1');
    expect(typeof removeInput.removeEntityState).toBe('function');
    expect(softDelete).toHaveBeenCalledWith('nc-1');
  });

  it('não exclui do storage uma referência governada que pertença a outra NC ou obra', async () => {
    const foreignAttachmentReference = `gst:nc-attachment:${Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'governed-storage',
        fileKey:
          'documents/company-1/nonconformity-attachments/sites/site-outra/nc-outra/foto.png',
        originalName: 'foto-de-outra-nc.png',
        mimeType: 'image/png',
        uploadedAt: new Date().toISOString(),
      }),
    ).toString('base64url')}`;
    const nc = {
      id: 'nc-1',
      company_id: 'company-1',
      site_id: 'site-1',
      anexos: [foreignAttachmentReference],
      pdf_file_key: null,
    } as unknown as NonConformity;
    const manager = {
      query: jest.fn().mockResolvedValue([nc]),
      getRepository: jest.fn(() => ({
        create: jest.fn((row: NonConformity) => row),
        softDelete: jest.fn(),
      })),
    };
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(nc);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: RemoveFinalDocumentReferenceInput) => {
      await input.removeEntityState?.(manager as never);
    });

    await service.remove('nc-1');

    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('bloqueia remocao de NC que ja tem PDF final emitido', async () => {
    const nc = {
      id: 'nc-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/nc-1.pdf',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(nc);

    await expect(service.remove('nc-1')).rejects.toThrow('sem PDF final');
    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).not.toHaveBeenCalled();
  });

  it('bloqueia edição quando a NC tem PDF final emitido', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.ENCERRADA,
      pdf_file_key: 'nonconformities/company-1/2026/week-11/nc-1.pdf',
    } as unknown as NonConformity);

    await expect(
      service.update('nc-1', { descricao: 'Novo texto' }),
    ).rejects.toThrow('Não conformidade com PDF final emitido é imutável');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia edição mesmo se uma NC legada com PDF final estiver reaberta', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.EM_ANDAMENTO,
      pdf_file_key: 'nonconformities/company-1/2026/week-11/nc-1.pdf',
      anexos: [],
      descricao: 'Texto antigo',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);
    _lockedNcRow = entity as unknown as Record<string, unknown>;

    await expect(
      service.update('nc-1', { descricao: 'Novo texto' }),
    ).rejects.toThrow('Não conformidade com PDF final emitido é imutável');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia reabertura de NC com PDF final já emitido', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.ENCERRADA,
      pdf_file_key: 'nonconformities/company-1/2026/week-11/nc-1.pdf',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);

    await expect(service.updateStatus('nc-1', NcStatus.ABERTA)).rejects.toThrow(
      'PDF final emitido não pode ter o status alterado',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('trata PATCH do mesmo status de uma NC finalizada como idempotente', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.ENCERRADA,
      pdf_file_key: 'nonconformities/company-1/2026/week-11/nc-1.pdf',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);

    await expect(
      service.updateStatus('nc-1', NcStatus.ENCERRADA),
    ).resolves.toBeDefined();

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('update() rejeita transição de status fora do fluxo permitido (pula etapas)', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.ABERTA,
      anexos: [],
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);

    await expect(
      service.update('nc-1', { status: NcStatus.ENCERRADA }),
    ).rejects.toThrow('Transição de "ABERTA" para "ENCERRADA" não permitida');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('update() carimba closed_at/resolved_by ao encerrar por uma transição válida', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.AGUARDANDO_VALIDACAO,
      anexos: [],
      closed_at: null,
      resolved_by: null,
      acao_definitiva_descricao: 'Instalar a proteção coletiva especificada.',
      acao_definitiva_responsavel: 'Responsável da manutenção',
      acao_definitiva_prazo: new Date('2026-03-20T00:00:00.000Z'),
      verificacao_resultado: 'Sim',
      verificacao_evidencias: 'Proteção instalada e testada em campo.',
      verificacao_data: new Date('2026-03-21T00:00:00.000Z'),
      verificacao_responsavel: 'Técnico SST',
      assinatura_responsavel_area: 'Responsável da área',
      assinatura_tecnico_auditor: 'Técnico SST',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);
    _lockedNcRow = entity as unknown as Record<string, unknown>;

    const result = await service.update('nc-1', {
      status: NcStatus.ENCERRADA,
    });

    expect(result.status).toBe(NcStatus.ENCERRADA);
    expect(result.closed_at).toBeInstanceOf(Date);
  });

  it('bloqueia encerramento sem ação, eficácia, evidência e assinaturas', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.AGUARDANDO_VALIDACAO,
      anexos: [],
      verificacao_resultado: 'Não',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);
    _lockedNcRow = entity as unknown as Record<string, unknown>;

    await expect(
      service.updateStatus('nc-1', NcStatus.ENCERRADA),
    ).rejects.toThrow('Não é possível encerrar a não conformidade');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('update() não reprocessa transição quando o status enviado é igual ao atual', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.EM_ANDAMENTO,
      anexos: [],
      descricao: 'Texto antigo',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);
    _lockedNcRow = entity as unknown as Record<string, unknown>;

    await expect(
      service.update('nc-1', {
        status: NcStatus.EM_ANDAMENTO,
        descricao: 'Texto novo',
      }),
    ).resolves.toBeDefined();

    expect(
      (repository as unknown as { manager: { transaction: jest.Mock } }).manager
        .transaction,
    ).toHaveBeenCalled();
  });

  it('recusa salvar uma edição stale depois que outra operação atualiza a NC', async () => {
    const baseline = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.EM_ANDAMENTO,
      anexos: [],
      descricao: 'Texto original',
      updated_at: new Date('2026-08-03T12:00:00.000Z'),
    } as unknown as NonConformity;
    const changedByAnotherOperation = {
      ...baseline,
      descricao: 'Texto da outra operação',
      updated_at: new Date('2026-08-03T12:01:00.000Z'),
    };
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(baseline);
    _lockedNcRow = changedByAnotherOperation;

    await expect(
      service.update('nc-1', { descricao: 'Minha edição antiga' }),
    ).rejects.toThrow('foi alterada por outra operação');
  });

  it('gera o código de validação a partir da data civil da NC, sem deslocamento de fuso', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      data_identificacao: '2021-01-01',
      created_at: new Date('2021-01-01T03:30:00.000Z'),
    } as unknown as NonConformity);

    await expect(service.getValidationContext('nc-1')).resolves.toMatchObject({
      documentCode: 'NONCONFORMITY-2021-53-NC-1',
      token: 'token-mock',
    });
  });

  it('update() rejeita transição de status fora do fluxo permitido (pula etapas)', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.ABERTA,
      anexos: [],
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);

    await expect(
      service.update('nc-1', { status: NcStatus.ENCERRADA }),
    ).rejects.toThrow('Transição de "ABERTA" para "ENCERRADA" não permitida');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('update() carimba closed_at/resolved_by ao encerrar por uma transição válida', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.AGUARDANDO_VALIDACAO,
      anexos: [],
      closed_at: null,
      resolved_by: null,
      acao_definitiva_descricao: 'Instalar a proteção coletiva especificada.',
      acao_definitiva_responsavel: 'Responsável da manutenção',
      acao_definitiva_prazo: new Date('2026-03-20T00:00:00.000Z'),
      verificacao_resultado: 'Sim',
      verificacao_evidencias: 'Proteção instalada e testada em campo.',
      verificacao_data: new Date('2026-03-21T00:00:00.000Z'),
      verificacao_responsavel: 'Técnico SST',
      assinatura_responsavel_area: 'Responsável da área',
      assinatura_tecnico_auditor: 'Técnico SST',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);
    _lockedNcRow = entity as unknown as Record<string, unknown>;

    const result = await service.update('nc-1', {
      status: NcStatus.ENCERRADA,
    });

    expect(result.status).toBe(NcStatus.ENCERRADA);
    const [savedArg] = repository.save.mock.calls[0] as [NonConformity];
    expect(savedArg.status).toBe(NcStatus.ENCERRADA);
    expect(savedArg.closed_at).toBeInstanceOf(Date);
  });

  it('update() não reprocessa transição quando o status enviado é igual ao atual', async () => {
    const entity = {
      id: 'nc-1',
      company_id: 'company-1',
      status: NcStatus.EM_ANDAMENTO,
      anexos: [],
      descricao: 'Texto antigo',
    } as unknown as NonConformity;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue(entity);
    _lockedNcRow = entity as unknown as Record<string, unknown>;

    await expect(
      service.update('nc-1', {
        status: NcStatus.EM_ANDAMENTO,
        descricao: 'Texto novo',
      }),
    ).resolves.toBeDefined();

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: NcStatus.EM_ANDAMENTO }),
    );
  });

  it('filtra arquivos semanais pela data documental da NC', async () => {
    (
      documentGovernanceService.listFinalDocuments as jest.Mock
    ).mockResolvedValue([
      {
        entityId: 'nc-1',
        id: 'nc-1',
        title: 'NC-001',
        date: new Date('2025-12-31T00:00:00.000Z'),
        companyId: 'company-1',
        fileKey: 'nonconformities/company-1/2025/week-01/nc-1.pdf',
        folderPath: 'nonconformities/company-1/2025/week-01',
        originalName: 'nc-1.pdf',
        module: 'nonconformity',
      },
    ]);
    repository.find.mockResolvedValue([
      {
        id: 'nc-1',
        pdf_file_key: 'nonconformities/company-1/2025/week-01/nc-1.pdf',
        pdf_folder_path: 'nonconformities/company-1/2025/week-01',
        pdf_original_name: 'nc-1.pdf',
      },
    ]);

    const files = await service.listStoredFiles({ year: 2025 });

    expect(files).toHaveLength(1);
    expect(files[0].entityId).toBe('nc-1');
    expect(documentGovernanceService.listFinalDocuments).toHaveBeenCalledWith(
      'nonconformity',
      { year: 2025 },
    );
  });

  it('lista de arquivos semanais reflete o PDF atual da NC, não o congelado no document_registry', async () => {
    (
      documentGovernanceService.listFinalDocuments as jest.Mock
    ).mockResolvedValue([
      {
        entityId: 'nc-1',
        id: 'nc-1',
        title: 'NC-001',
        date: new Date('2026-03-10T00:00:00.000Z'),
        companyId: 'company-1',
        fileKey: 'nonconformities/company-1/2026/week-11/old-emissao.pdf',
        folderPath: 'nonconformities/company-1/2026/week-11',
        originalName: 'old-emissao.pdf',
        module: 'nonconformity',
      },
    ]);
    repository.find.mockResolvedValue([
      {
        id: 'nc-1',
        pdf_file_key:
          'nonconformities/company-1/2026/week-11/regenerado-mais-recente.pdf',
        pdf_folder_path: 'nonconformities/company-1/2026/week-11',
        pdf_original_name: 'regenerado-mais-recente.pdf',
      },
    ]);

    const files = await service.listStoredFiles({ year: 2026 });

    expect(files).toHaveLength(1);
    expect(files[0].fileKey).toBe(
      'nonconformities/company-1/2026/week-11/regenerado-mais-recente.pdf',
    );
    expect(files[0].originalName).toBe('regenerado-mais-recente.pdf');
  });

  it('retorna metadados do PDF mesmo quando a URL assinada falha', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      pdf_file_key: 'nonconformities/company-1/2026/week-11/nc-1.pdf',
      pdf_folder_path: 'nonconformities/company-1/2026/week-11',
      pdf_original_name: 'nc-1.pdf',
    } as unknown as NonConformity);
    (documentStorageService.getSignedUrl as jest.Mock).mockRejectedValueOnce(
      new Error('storage offline'),
    );

    await expect(service.getPdfAccess('nc-1')).resolves.toEqual({
      entityId: 'nc-1',
      hasFinalPdf: true,
      availability: 'registered_without_signed_url',
      fileKey: 'nonconformities/company-1/2026/week-11/nc-1.pdf',
      folderPath: 'nonconformities/company-1/2026/week-11',
      originalName: 'nc-1.pdf',
      url: null,
      message:
        'PDF final registrado, mas a URL segura do storage não está disponível no momento.',
    });
  });

  it('sinaliza explicitamente quando o PDF final ainda não foi emitido', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    } as unknown as NonConformity);

    await expect(service.getPdfAccess('nc-1')).resolves.toEqual({
      entityId: 'nc-1',
      hasFinalPdf: false,
      availability: 'not_emitted',
      fileKey: null,
      folderPath: null,
      originalName: null,
      url: null,
      message: 'PDF final ainda não foi emitido para esta não conformidade.',
    });
  });

  it('bloqueia criação com anexo inline, mesmo dentro de limites de tamanho', async () => {
    const oversizedInlineAttachment = `data:image/jpeg;base64,${Buffer.alloc(
      1024 * 1024 + 32,
      1,
    ).toString('base64')}`;

    await expect(
      service.create({
        codigo_nc: 'NC-001',
        tipo: 'Operacional',
        data_identificacao: '2026-03-10',
        local_setor_area: 'Área 1',
        atividade_envolvida: 'Inspeção',
        responsavel_area: 'Maria',
        auditor_responsavel: 'João',
        descricao: 'Descrição',
        evidencia_observada: 'Evidência',
        condicao_insegura: 'Condição',
        requisito_nr: 'NR-1',
        requisito_item: '1.1',
        risco_perigo: 'Perigo',
        risco_associado: 'Risco',
        risco_nivel: 'Alto',
        status: 'ABERTA',
        anexos: [oversizedInlineAttachment],
      }),
    ).rejects.toThrow('Novos anexos devem ser enviados pelo endpoint dedicado');

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia criação com referência governada forjada no payload', async () => {
    const forgedReference = `gst:nc-attachment:${Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'governed-storage',
        fileKey: 'documents/company-1/nonconformity-attachments/nc-1/foto.png',
        originalName: 'foto.png',
        mimeType: 'image/png',
        uploadedAt: new Date().toISOString(),
      }),
    ).toString('base64url')}`;

    await expect(
      service.create({
        codigo_nc: 'NC-001',
        tipo: 'Operacional',
        data_identificacao: '2026-03-10',
        local_setor_area: 'Área 1',
        atividade_envolvida: 'Inspeção',
        responsavel_area: 'Maria',
        auditor_responsavel: 'João',
        descricao: 'Descrição',
        evidencia_observada: 'Evidência',
        condicao_insegura: 'Condição',
        requisito_nr: 'NR-1',
        requisito_item: '1.1',
        risco_perigo: 'Perigo',
        risco_associado: 'Risco',
        risco_nivel: 'Alto',
        status: 'ABERTA',
        anexos: [forgedReference],
      }),
    ).rejects.toThrow(
      'Anexos governados devem ser enviados pelo endpoint dedicado do módulo.',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('registra no audit trail apenas metadados da NC, sem PII ou blobs de anexos', async () => {
    const inlineBlob = `data:image/jpeg;base64,${Buffer.from(
      'imagem confidencial',
    ).toString('base64')}`;
    repository.save.mockImplementation((input: NonConformity) =>
      Promise.resolve({ ...input, id: 'nc-audit' }),
    );

    await service.create({
      codigo_nc: 'NC-AUD-001',
      tipo: 'Operacional',
      data_identificacao: '2026-03-10',
      local_setor_area: 'Área 1',
      atividade_envolvida: 'Inspeção',
      responsavel_area: 'Responsável confidencial',
      auditor_responsavel: 'Auditor confidencial',
      descricao: 'Descrição confidencial com CPF 123.456.789-09',
      evidencia_observada: 'Evidência confidencial',
      condicao_insegura: 'Condição insegura',
      requisito_nr: 'NR-1',
      requisito_item: '1.1',
      risco_perigo: 'Perigo',
      risco_associado: 'Risco',
      risco_nivel: 'Alto',
      status: 'ABERTA',
    });

    const [auditInput] = (auditService.log as jest.Mock).mock.calls[0] as [
      { changes: unknown },
    ];
    const serialized = JSON.stringify(auditInput.changes);
    expect(serialized).not.toContain('Descrição confidencial');
    expect(serialized).not.toContain('123.456.789-09');
    expect(serialized).not.toContain(inlineBlob);
    expect(serialized).toContain('nonconformity-audit-v2');
  });

  it('bloqueia criação quando já existe código NC ativo na empresa', async () => {
    repository.findOne.mockResolvedValueOnce({ id: 'nc-existing' });

    await expect(
      service.create({
        codigo_nc: 'nc-001',
        tipo: 'Operacional',
        data_identificacao: '2026-03-10',
        local_setor_area: 'Área 1',
        atividade_envolvida: 'Inspeção',
        responsavel_area: 'Maria',
        auditor_responsavel: 'João',
        descricao: 'Descrição',
        evidencia_observada: 'Evidência',
        condicao_insegura: 'Condição',
        requisito_nr: 'NR-1',
        requisito_item: '1.1',
        risco_perigo: 'Perigo',
        risco_associado: 'Risco',
        risco_nivel: 'Alto',
        status: 'ABERTA',
      }),
    ).rejects.toThrow(
      'Já existe uma não conformidade com este código na empresa atual.',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('aceita checklist_id opcional ao criar NC e propaga no payload (validação tenant)', async () => {
    checklistsRepository.findOne.mockResolvedValueOnce({
      id: 'checklist-xyz',
      company_id: 'company-1',
      site_id: 'site-1',
    });
    sitesRepository.findOne.mockResolvedValue({
      id: 'site-1',
      company_id: 'company-1',
      status: true,
    });

    const result = await service.create({
      codigo_nc: 'NC-CHK-001',
      tipo: 'Inspeção',
      data_identificacao: '2026-03-10',
      local_setor_area: 'Área 1',
      atividade_envolvida: 'Checklist item',
      responsavel_area: 'Equipe',
      auditor_responsavel: 'Auditor',
      descricao: 'NC oriunda de checklist',
      evidencia_observada: 'Evidência',
      condicao_insegura: 'Falha',
      requisito_nr: 'NR-12',
      requisito_item: 'Item X',
      risco_perigo: 'Perigo',
      risco_associado: 'Risco',
      risco_nivel: 'Alto',
      status: 'ABERTA',
      site_id: 'site-1',
      checklist_id: 'checklist-xyz',
    });

    expect(checklistsRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'checklist-xyz',
          company_id: 'company-1',
        }) as unknown,
      }),
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ checklist_id: 'checklist-xyz' }),
    );
    expect(result).toBeDefined();
    // SECURITY: main responses must not leak internal storage keys
    expect(
      (result as unknown as Record<string, unknown>).pdf_file_key,
    ).toBeUndefined();
    expect(
      (result as unknown as Record<string, unknown>).pdf_folder_path,
    ).toBeUndefined();
    expect(
      (result as unknown as Record<string, unknown>).pdf_original_name,
    ).toBeUndefined();
    expect(result).toBeInstanceOf(NonConformityResponseDto); // via plainToClass shape
  });

  it('rejeita criação de NC com checklist_id de outra empresa ou inexistente', async () => {
    checklistsRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      service.create({
        codigo_nc: 'NC-CHK-002',
        tipo: 'Inspeção',
        data_identificacao: '2026-03-10',
        local_setor_area: 'Área 1',
        atividade_envolvida: 'Checklist item',
        responsavel_area: 'Equipe',
        auditor_responsavel: 'Auditor',
        descricao: 'NC',
        evidencia_observada: 'Evid',
        condicao_insegura: 'Falha',
        requisito_nr: 'NR-1',
        requisito_item: '1',
        risco_perigo: 'P',
        risco_associado: 'R',
        risco_nivel: 'Alto',
        status: 'ABERTA',
        checklist_id: 'checklist-other',
      }),
    ).rejects.toThrow(
      'O checklist informado não foi encontrado ou não pertence à empresa atual.',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia atualização quando o novo código NC já está em uso na empresa', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      codigo_nc: 'NC-001',
      anexos: [],
      pdf_file_key: null,
    } as unknown as NonConformity);
    repository.findOne.mockResolvedValueOnce({ id: 'nc-2' });

    await expect(
      service.update('nc-1', { codigo_nc: 'nc-002' }),
    ).rejects.toThrow(
      'Já existe uma não conformidade com este código na empresa atual.',
    );

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('attachAttachment: salva evidência governada no storage oficial', async () => {
    const ncData = {
      id: 'nc-1',
      company_id: 'company-1',
      anexos: ['https://evidencias.example.com/foto-antiga.jpg'],
      pdf_file_key: null,
      deleted_at: null,
    };
    jest
      .spyOn(service, 'findOneEntity')
      .mockResolvedValue(ncData as unknown as NonConformity);
    _lockedNcRow = ncData;

    const result = await service.attachAttachment(
      'nc-1',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'foto.png',
    );

    expect(documentStorageService.uploadFile).toHaveBeenCalledWith(
      expect.stringContaining('nonconformity-attachments'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      'image/png',
    );
    // A partir do fix, o save acontece dentro do manager.transaction (innerRepo.save),
    // não direto no repository.save. Verifica pelo retorno da operação.
    expect(result.storageMode).toBe('governed-storage');
    expect(result.degraded).toBe(false);
    expect(result.attachment.originalName).toBe('foto.png');
    // SECURITY: attach response must use governed ref pattern (no raw fileKey)
    expect(result.attachmentReference).toContain('gst:nc-attachment:');
    expect(
      (result.attachment as Record<string, unknown>).fileKey,
    ).toBeUndefined();
    // Verifica que o anexo foi incluído na lista do resultado
    expect(result.attachments).toEqual(
      expect.arrayContaining([expect.stringContaining('gst:nc-attachment:')]),
    );
  });

  it('attachAttachment rejeita conteúdo sem assinatura de arquivo permitida', async () => {
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      anexos: [],
      pdf_file_key: null,
    } as unknown as NonConformity);

    await expect(
      service.attachAttachment(
        'nc-1',
        Buffer.from('conteúdo forjado'),
        'foto.png',
      ),
    ).rejects.toThrow('conteúdo do anexo não corresponde');

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('removeAttachment exclui a referência e o arquivo governado imediatamente', async () => {
    const attachmentReference = `gst:nc-attachment:${Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'governed-storage',
        fileKey: 'documents/company-1/nonconformity-attachments/nc-1/foto.png',
        originalName: 'foto.png',
        mimeType: 'image/png',
        uploadedAt: new Date().toISOString(),
      }),
    ).toString('base64url')}`;
    const ncData = {
      id: 'nc-1',
      company_id: 'company-1',
      anexos: [attachmentReference],
      pdf_file_key: null,
      deleted_at: null,
    };
    jest
      .spyOn(service, 'findOneEntity')
      .mockResolvedValue(ncData as unknown as NonConformity);
    _lockedNcRow = ncData;

    await expect(service.removeAttachment('nc-1', 0)).resolves.toMatchObject({
      entityId: 'nc-1',
      attachments: [],
      attachmentCount: 0,
      storageCleanup: 'removed',
    });

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'documents/company-1/nonconformity-attachments/nc-1/foto.png',
    );
  });

  it('getAttachmentAccess rejeita referência governada fora da pasta da NC', async () => {
    const governedReference = `gst:nc-attachment:${Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'governed-storage',
        fileKey:
          'documents/company-1/nonconformity-attachments/nc-outra/foto.png',
        originalName: 'foto.png',
        mimeType: 'image/png',
        uploadedAt: new Date().toISOString(),
      }),
    ).toString('base64url')}`;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      anexos: [governedReference],
    } as unknown as NonConformity);

    await expect(service.getAttachmentAccess('nc-1', 0)).rejects.toThrow(
      'não corresponde à não conformidade solicitada',
    );
    expect(documentStorageService.getSignedUrl).not.toHaveBeenCalled();
  });

  it('getAttachmentAccess: sinaliza modo degradado quando a URL segura do anexo falha', async () => {
    const governedReference = `gst:nc-attachment:${Buffer.from(
      JSON.stringify({
        v: 1,
        kind: 'governed-storage',
        fileKey: 'documents/company-1/nonconformity-attachments/nc-1/foto.png',
        originalName: 'foto.png',
        mimeType: 'image/png',
        uploadedAt: new Date().toISOString(),
      }),
    ).toString('base64url')}`;
    jest.spyOn(service, 'findOneEntity').mockResolvedValue({
      id: 'nc-1',
      company_id: 'company-1',
      anexos: [governedReference],
    } as unknown as NonConformity);
    (documentStorageService.getSignedUrl as jest.Mock).mockRejectedValueOnce(
      new Error('storage offline'),
    );

    await expect(service.getAttachmentAccess('nc-1', 0)).resolves.toEqual({
      entityId: 'nc-1',
      index: 0,
      hasGovernedAttachment: true,
      availability: 'registered_without_signed_url',
      fileKey: 'documents/company-1/nonconformity-attachments/nc-1/foto.png',
      originalName: 'foto.png',
      mimeType: 'image/png',
      url: null,
      degraded: true,
      message:
        'Anexo governado registrado, mas a URL segura do storage não está disponível no momento.',
    });
  });

  it('getAnalyticsOverview: retorna contagem consolidada por status', async () => {
    jest.spyOn(service, 'summarizeByStatus').mockResolvedValue({
      total: 9,
      filtered: 9,
      byStatus: {
        ABERTA: 3,
        EM_ANDAMENTO: 2,
        AGUARDANDO_VALIDACAO: 1,
        ENCERRADA: 3,
      },
      filterStatus: null,
    });

    await expect(service.getAnalyticsOverview()).resolves.toEqual({
      totalNonConformities: 9,
      abertas: 3,
      emAndamento: 2,
      aguardandoValidacao: 1,
      encerradas: 3,
    });
  });

  it('rejeita search malformado em vez de cair em 500', async () => {
    const queryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repository.createQueryBuilder.mockReturnValue(queryBuilder);

    await expect(
      service.findPaginated({
        page: 1,
        limit: 20,
        search: ['forged'] as unknown as string,
      }),
    ).rejects.toThrow();

    expect(queryBuilder.getManyAndCount).not.toHaveBeenCalled();
  });

  it('bloqueia criação já encerrada para impedir bypass do workflow', async () => {
    const validNc = {
      codigo_nc: 'NC-VALID',
      tipo: 'Operacional',
      data_identificacao: '2026-06-23',
      local_setor_area: 'Área Teste',
      atividade_envolvida: 'Teste',
      responsavel_area: 'Teste',
      auditor_responsavel: 'Teste',
      descricao: 'Descrição',
      evidencia_observada: 'Evidência',
      condicao_insegura: 'Condição',
      requisito_nr: 'NR-1',
      requisito_item: '1.1',
      risco_perigo: 'Perigo',
      risco_associado: 'Risco',
      risco_nivel: 'Baixo',
      status: 'ENCERRADA',
    };

    await expect(service.create(validNc)).rejects.toThrow(
      'Uma não conformidade deve ser criada com status ABERTA',
    );
    expect(repository.save).not.toHaveBeenCalled();
  });
});
