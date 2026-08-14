import { EntityManager, Repository } from 'typeorm';
import type { TenantService } from '../../../shared/tenant/tenant.service';
import type { DocumentStorageService } from '../../../shared/services/document-storage.service';
import type { StorageService } from '../../../shared/services/storage.service';
import type { PdfService } from '../../../shared/services/pdf.service';
import type { DocumentGovernanceService } from '../../document-registry/document-governance.service';
import type { PublicValidationGrantService } from '../../../shared/services/public-validation-grant.service';
import { NonConformity } from '../entities/nonconformity.entity';
import { NcStatus } from '../nonconformities.service';
import { NonConformitiesPdfService } from './nonconformities-pdf.service';
import type { NonConformityWorkflowLockService } from './nonconformity-workflow-lock.service';
import type { DocumentRegistryEntry } from '../../document-registry/entities/document-registry.entity';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];
type RegisterFinalDocumentResult = Awaited<
  ReturnType<DocumentGovernanceService['registerFinalDocument']>
>;

describe('NonConformitiesPdfService', () => {
  let service: NonConformitiesPdfService;

  let ncRepository: {
    findOne: jest.Mock;
    update: jest.Mock;
    manager: { getRepository: jest.Mock };
  };
  let tenantService: Pick<TenantService, 'getTenantId' | 'getContext'>;
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'generateDocumentKey'
    | 'uploadFile'
    | 'deleteFile'
    | 'getSignedUrl'
    | 'downloadFileBuffer'
  >;
  let storageService: Pick<StorageService, 'downloadFileBuffer'>;
  let pdfService: Pick<PdfService, 'generateFromHtml' | 'computeHash'>;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    'registerFinalDocument'
  >;
  let publicValidationGrantService: Pick<
    PublicValidationGrantService,
    'issueToken'
  >;
  let workflowLock: { runExclusive: jest.Mock };

  const originalFrontendUrl = process.env.FRONTEND_URL;

  const baseNc = {
    id: 'nc-1',
    company_id: 'company-1',
    site_id: 'site-1',
    codigo_nc: 'NC-001',
    tipo: 'Operacional',
    data_identificacao: new Date('2026-03-10T00:00:00.000Z'),
    created_at: new Date('2026-03-09T00:00:00.000Z'),
    local_setor_area: 'Área 1',
    atividade_envolvida: 'Inspeção',
    responsavel_area: 'Equipe',
    auditor_responsavel: 'Auditor',
    descricao: 'Descrição do desvio',
    evidencia_observada: 'Evidência',
    condicao_insegura: 'Condição insegura',
    requisito_nr: 'NR-12',
    requisito_item: '12.1',
    risco_perigo: 'Perigo',
    risco_associado: 'Risco',
    risco_nivel: 'Alto',
    acao_definitiva_descricao: 'Adequar a proteção da máquina',
    acao_definitiva_responsavel: 'Fernanda Lopes',
    acao_definitiva_prazo: new Date('2026-03-20T00:00:00.000Z'),
    verificacao_resultado: 'Sim',
    verificacao_evidencias: 'Proteção verificada no local',
    verificacao_data: new Date('2026-03-21T00:00:00.000Z'),
    verificacao_responsavel: 'João da Silva',
    assinatura_responsavel_area: 'Fernanda Lopes',
    assinatura_tecnico_auditor: 'João da Silva',
    status: NcStatus.ENCERRADA,
    anexos: [],
    pdf_file_key: null,
    verification_code: null,
  } as unknown as NonConformity;

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://app.sgs.example';
    const update = jest.fn();
    const conditionalUpdateBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    conditionalUpdateBuilder.update.mockReturnValue(conditionalUpdateBuilder);
    conditionalUpdateBuilder.set.mockReturnValue(conditionalUpdateBuilder);
    conditionalUpdateBuilder.where.mockReturnValue(conditionalUpdateBuilder);
    conditionalUpdateBuilder.andWhere.mockReturnValue(conditionalUpdateBuilder);

    ncRepository = {
      findOne: jest.fn(),
      update: jest.fn(() => Promise.resolve()),
      manager: {
        getRepository: jest.fn(() => ({
          update,
          createQueryBuilder: jest.fn(() => conditionalUpdateBuilder),
        })),
      },
    };
    tenantService = {
      getTenantId: jest.fn(() => 'company-1'),
      getContext: jest.fn(() => ({
        siteScope: 'all',
        companyId: 'company-1',
        isSuperAdmin: false,
      })),
    };
    documentStorageService = {
      generateDocumentKey: jest.fn(
        () =>
          'documents/company-1/nonconformities/sites/site-1/nc-1/nc-final.pdf',
      ),
      uploadFile: jest.fn(() => Promise.resolve()),
      deleteFile: jest.fn(() => Promise.resolve()),
      getSignedUrl: jest.fn((key: string) =>
        Promise.resolve(`https://signed.example/${encodeURIComponent(key)}`),
      ),
      downloadFileBuffer: jest.fn(() => Promise.resolve(Buffer.from('img'))),
    };
    storageService = {
      downloadFileBuffer: jest.fn().mockResolvedValue(Buffer.from('')),
    };
    pdfService = {
      generateFromHtml: jest.fn(() => Promise.resolve(Buffer.from('%PDF-1.4'))),
      computeHash: jest.fn(() => 'hash-regenerated'),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(
        async (
          input: RegisterFinalDocumentInput,
        ): Promise<RegisterFinalDocumentResult> => {
          await input.persistEntityMetadata?.(
            ncRepository.manager as unknown as EntityManager,
            'hash-1',
          );
          return {
            hash: 'hash-1',
            registryEntry: { id: 'registry-1' } as DocumentRegistryEntry,
          };
        },
      ),
    };
    publicValidationGrantService = {
      issueToken: jest.fn().mockResolvedValue('validation-token'),
    };
    workflowLock = {
      runExclusive: jest.fn(
        async (
          _id: string,
          operation: (assertLeaseHealthy: () => void) => Promise<unknown>,
        ): Promise<unknown> => operation(() => undefined),
      ),
    };

    service = new NonConformitiesPdfService(
      ncRepository as unknown as Repository<NonConformity>,
      tenantService as TenantService,
      documentStorageService as DocumentStorageService,
      storageService as StorageService,
      pdfService as PdfService,
      documentGovernanceService as DocumentGovernanceService,
      workflowLock as unknown as NonConformityWorkflowLockService,
      publicValidationGrantService as PublicValidationGrantService,
    );
  });

  afterAll(() => {
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
      return;
    }
    process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it('getPdfAccess sinaliza not_emitted quando a NC não tem PDF final', async () => {
    ncRepository.findOne.mockResolvedValue({ ...baseNc, pdf_file_key: null });

    await expect(service.getPdfAccess('nc-1')).resolves.toMatchObject({
      hasFinalPdf: false,
      availability: 'not_emitted',
    });
  });

  it('getPdfAccess retorna ready com URL assinada quando já existe PDF', async () => {
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      pdf_file_key: 'documents/company-1/nonconformities/nc-1/existing.pdf',
      pdf_original_name: 'NC-001.pdf',
    });

    const access = await service.getPdfAccess('nc-1');

    expect(access.hasFinalPdf).toBe(true);
    expect(access.availability).toBe('ready');
    expect(access.url).toContain('https://signed.example/');
  });

  it('generateFinalPdf gera o PDF oficial e registra no storage governado', async () => {
    ncRepository.findOne.mockResolvedValue({ ...baseNc });

    const result = await service.generateFinalPdf('nc-1', 'user-1');

    expect(pdfService.generateFromHtml).toHaveBeenCalled();
    expect(documentStorageService.uploadFile).toHaveBeenCalledWith(
      'documents/company-1/nonconformities/sites/site-1/nc-1/nc-final.pdf',
      expect.any(Buffer),
      'application/pdf',
    );
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'nonconformity', entityId: 'nc-1' }),
    );
    expect(result.generated).toBe(true);
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
    const generatedCall = (pdfService.generateFromHtml as jest.Mock).mock
      .calls[0] as unknown as [string, { margin?: { bottom?: string } }];
    expect(generatedCall[1].margin?.bottom).toBe('22mm');
  });

  it('verifica a posse do lease antes do upload e da persistência final', async () => {
    const assertLeaseHealthy = jest.fn();
    workflowLock.runExclusive.mockImplementation(
      async (
        _id: string,
        operation: (assertHealthy: () => void) => Promise<unknown>,
      ) => operation(assertLeaseHealthy),
    );
    ncRepository.findOne.mockResolvedValue({ ...baseNc });

    await service.generateFinalPdf('nc-1', 'user-1');

    expect(assertLeaseHealthy).toHaveBeenCalledTimes(4);
    expect(documentStorageService.uploadFile).toHaveBeenCalled();
    expect(documentGovernanceService.registerFinalDocument).toHaveBeenCalled();
  });

  it('generateFinalPdf é idempotente quando a NC está encerrada e já tem PDF', async () => {
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      status: NcStatus.ENCERRADA,
      pdf_file_key: 'documents/company-1/nonconformities/nc-1/existing.pdf',
    });

    const result = await service.generateFinalPdf('nc-1', 'user-1');

    expect(pdfService.generateFromHtml).not.toHaveBeenCalled();
    expect(result.generated).toBe(false);
    expect(result.hasFinalPdf).toBe(true);
  });

  it('generateFinalPdf não substitui um documento final já registrado', async () => {
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      status: NcStatus.ENCERRADA,
      pdf_file_key: 'documents/company-1/nonconformities/nc-1/old.pdf',
    });

    const result = await service.generateFinalPdf('nc-1', 'user-1');

    expect(pdfService.generateFromHtml).not.toHaveBeenCalled();
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
    expect(result.generated).toBe(false);
  });

  it('generateFinalPdf rejeita documento final antes do encerramento', async () => {
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      status: NcStatus.EM_ANDAMENTO,
      pdf_file_key: null,
    });

    await expect(service.generateFinalPdf('nc-1', 'user-1')).rejects.toThrow(
      'O PDF final só pode ser emitido após o encerramento',
    );

    expect(pdfService.generateFromHtml).not.toHaveBeenCalled();
    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('não emite PDF final para NC legada encerrada sem evidências mínimas de eficácia', async () => {
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      verificacao_evidencias: ' ',
      assinatura_tecnico_auditor: null,
    });

    await expect(service.generateFinalPdf('nc-1', 'user-1')).rejects.toThrow(
      'a não conformidade encerrada está incompleta',
    );

    expect(pdfService.generateFromHtml).not.toHaveBeenCalled();
    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('generateFinalPdf remove o arquivo recém-enviado quando a governança falha', async () => {
    ncRepository.findOne.mockResolvedValue({ ...baseNc });
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance falhou'));

    await expect(service.generateFinalPdf('nc-1', 'user-1')).rejects.toThrow(
      'governance falhou',
    );

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'documents/company-1/nonconformities/sites/site-1/nc-1/nc-final.pdf',
    );
  });

  it('cancela e limpa o upload se a NC for reaberta antes de persistir o PDF final', async () => {
    ncRepository.findOne.mockResolvedValue({ ...baseNc });
    const builder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    builder.update.mockReturnValue(builder);
    builder.set.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.andWhere.mockReturnValue(builder);
    ncRepository.manager.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn(() => builder),
    });

    await expect(service.generateFinalPdf('nc-1', 'user-1')).rejects.toThrow(
      'foi alterada durante a emissão do PDF final',
    );

    expect(builder.andWhere).toHaveBeenCalledWith('status = :closedStatus', {
      closedStatus: NcStatus.ENCERRADA,
    });
    expect(builder.andWhere).toHaveBeenCalledWith('pdf_file_key IS NULL');
    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'documents/company-1/nonconformities/sites/site-1/nc-1/nc-final.pdf',
    );
  });

  it('devolve a versão oficial concorrente após compensar o upload local', async () => {
    const currentNc = {
      ...baseNc,
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    } as unknown as NonConformity;
    ncRepository.findOne.mockImplementation(() => Promise.resolve(currentNc));
    const builder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn(() => {
        currentNc.pdf_file_key =
          'documents/company-1/nonconformities/sites/site-1/nc-1/official.pdf';
        currentNc.pdf_folder_path =
          'documents/company-1/nonconformities/sites/site-1/nc-1';
        currentNc.pdf_original_name = 'NC-001.pdf';
        return { affected: 0 };
      }),
    };
    builder.update.mockReturnValue(builder);
    builder.set.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.andWhere.mockReturnValue(builder);
    ncRepository.manager.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn(() => builder),
    });

    const result = await service.generateFinalPdf('nc-1', 'user-1');

    expect(result.generated).toBe(false);
    expect(result.fileKey).toBe(currentNc.pdf_file_key);
    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      'documents/company-1/nonconformities/sites/site-1/nc-1/nc-final.pdf',
    );
  });

  it('serializa emissões concorrentes e devolve o mesmo PDF final', async () => {
    const currentNc = {
      ...baseNc,
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    } as unknown as NonConformity;
    ncRepository.findOne.mockImplementation(() => Promise.resolve(currentNc));

    const queuedLocks = new Map<string, Promise<void>>();
    workflowLock.runExclusive.mockImplementation(
      async (
        id: string,
        operation: (assertLeaseHealthy: () => void) => Promise<unknown>,
      ) => {
        const previous = queuedLocks.get(id) ?? Promise.resolve();
        let releaseCurrent!: () => void;
        const current = new Promise<void>((resolve) => {
          releaseCurrent = resolve;
        });
        queuedLocks.set(
          id,
          previous.then(() => current),
        );
        await previous;
        try {
          return await operation(() => undefined);
        } finally {
          releaseCurrent();
        }
      },
    );

    const builder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn(() => {
        if (
          String(currentNc.status) !== 'ENCERRADA' ||
          currentNc.pdf_file_key !== null
        ) {
          return { affected: 0 };
        }
        currentNc.pdf_file_key =
          'documents/company-1/nonconformities/sites/site-1/nc-1/nc-final.pdf';
        currentNc.pdf_folder_path =
          'documents/company-1/nonconformities/sites/site-1/nc-1';
        currentNc.pdf_original_name = 'NC-001.pdf';
        return { affected: 1 };
      }),
    };
    builder.update.mockReturnValue(builder);
    builder.set.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.andWhere.mockReturnValue(builder);
    ncRepository.manager.getRepository.mockReturnValue({
      createQueryBuilder: jest.fn(() => builder),
    });

    const [first, second] = await Promise.all([
      service.generateFinalPdf('nc-1', 'user-1'),
      service.generateFinalPdf('nc-1', 'user-2'),
    ]);

    expect(pdfService.generateFromHtml).toHaveBeenCalledTimes(1);
    expect(documentStorageService.uploadFile).toHaveBeenCalledTimes(1);
    expect(first.generated).toBe(true);
    expect(second.generated).toBe(false);
    expect(first.fileKey).toBe(currentNc.pdf_file_key);
    expect(second.fileKey).toBe(currentNc.pdf_file_key);
  });

  it('generateFinalPdf inclui recursos/prazo/data prevista da ação definitiva e status em português', async () => {
    const governedPdfAttachmentRef =
      'gst:nc-attachment:' +
      Buffer.from(
        JSON.stringify({
          v: 1,
          kind: 'governed-storage',
          fileKey: 'documents/company-1/nonconformities/nc-1/laudo.pdf',
          originalName: 'laudo-tecnico.pdf',
          mimeType: 'application/pdf',
          uploadedAt: '2026-03-10T00:00:00.000Z',
        }),
      ).toString('base64url');

    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      status: NcStatus.ENCERRADA,
      acao_definitiva_descricao: 'Reciclar treinamento da equipe',
      acao_definitiva_responsavel: 'Fernanda Lopes',
      acao_definitiva_recursos: 'Sala de treinamento e instrutor externo',
      acao_definitiva_prazo: new Date('2026-08-15T00:00:00.000Z'),
      acao_definitiva_data_prevista: new Date('2026-08-20T00:00:00.000Z'),
      anexos: [governedPdfAttachmentRef],
    });

    await service.generateFinalPdf('nc-1', 'user-1');

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];

    // Bug: "Recursos necessários" era preenchido no formulário mas nunca
    // aparecia no PDF final.
    expect(html).toContain('Sala de treinamento e instrutor externo');
    // Bug: prazo e data prevista são duas perguntas distintas do formulário;
    // o PDF só mostrava uma (a outra era descartada silenciosamente).
    expect(html).toContain('15/08/2026');
    expect(html).toContain('20/08/2026');
    // Bug: status aparecia como valor bruto do enum ("EM_ANDAMENTO") em vez
    // do rótulo em português usado no resto do sistema.
    expect(html).toContain('Encerrada');
    expect(html).not.toContain('>ENCERRADA<');
    // Bug: anexo governado não-imagem (ex.: laudo em PDF) desaparecia do
    // PDF final sem nenhuma menção.
    expect(html).toContain('laudo-tecnico.pdf');
  });

  it('não baixa foto governada que pertença a outra NC ou obra', async () => {
    const foreignAttachmentReference =
      'gst:nc-attachment:' +
      Buffer.from(
        JSON.stringify({
          v: 1,
          kind: 'governed-storage',
          fileKey:
            'documents/company-1/nonconformity-attachments/sites/site-outra/nc-outra/foto.png',
          originalName: 'foto-de-outra-nc.png',
          mimeType: 'image/png',
          uploadedAt: '2026-03-10T00:00:00.000Z',
        }),
      ).toString('base64url');
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      anexos: [foreignAttachmentReference],
    });

    await service.generateFinalPdf('nc-1', 'user-1');

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];
    expect(documentStorageService.downloadFileBuffer).not.toHaveBeenCalled();
    expect(html).toContain('foto-de-outra-nc.png');
  });

  it('incorpora a logo de storage como data URI, sem depender de rede externa', async () => {
    (storageService.downloadFileBuffer as jest.Mock).mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    );
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      company: { logo_storage_key: 'companies/company-1/logo.png' },
    });

    await service.generateFinalPdf('nc-1', 'user-1');

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];
    expect(html).toContain('alt="Logo da empresa"');
    expect(html).toContain('data:image/png;base64,');
  });

  it('incorpora QR local e link público com grant assinado, sem URL externa no renderer', async () => {
    ncRepository.findOne.mockResolvedValue({ ...baseNc });

    await service.generateFinalPdf('nc-1', 'user-1');

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];
    expect(publicValidationGrantService.issueToken).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'NONCONFORMITY-2026-11-NC-1',
        companyId: 'company-1',
        documentId: 'nc-1',
        portal: 'nonconformity_public_validation',
      }),
    );
    expect(html).toContain('class="auth-qr"');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('Validar no portal público');
    expect(html).toContain(
      'https://app.sgs.example/validar/NONCONFORMITY-2026-11-NC-1?token=validation-token',
    );
  });

  it('mantém fallback textual quando não há uma origem segura do portal público', async () => {
    const environment = {
      frontend: process.env.FRONTEND_URL,
      nextPublic: process.env.NEXT_PUBLIC_APP_URL,
      app: process.env.APP_URL,
    };
    delete process.env.FRONTEND_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.APP_URL;
    ncRepository.findOne.mockResolvedValue({ ...baseNc });

    try {
      await service.generateFinalPdf('nc-1', 'user-1');
    } finally {
      if (environment.frontend === undefined) {
        delete process.env.FRONTEND_URL;
      } else {
        process.env.FRONTEND_URL = environment.frontend;
      }
      if (environment.nextPublic === undefined) {
        delete process.env.NEXT_PUBLIC_APP_URL;
      } else {
        process.env.NEXT_PUBLIC_APP_URL = environment.nextPublic;
      }
      if (environment.app === undefined) {
        delete process.env.APP_URL;
      } else {
        process.env.APP_URL = environment.app;
      }
    }

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];
    expect(publicValidationGrantService.issueToken).not.toHaveBeenCalled();
    expect(html).toContain('class="validation-unavailable"');
    expect(html).toContain('origem segura do portal não está configurada');
  });

  it('preserva a data civil, mostra timestamps no fuso operacional e usa a mesma semana na pasta e no código', async () => {
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      data_identificacao: new Date('2026-03-10T00:00:00.000Z'),
      closed_at: new Date('2026-03-10T01:30:00.000Z'),
    });

    await service.generateFinalPdf('nc-1', 'user-1');

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];
    expect(html).toContain('NONCONFORMITY-2026-11-NC-1');
    expect(html).toContain('10/03/2026');
    // 01:30 UTC ainda é 09/03 em America/Araguaina (UTC-3).
    expect(html).toContain('09/03/2026');
    expect(documentStorageService.generateDocumentKey).toHaveBeenCalledWith(
      'company-1',
      'nonconformities',
      'nc-1',
      'NC-001.pdf',
      expect.objectContaining({
        folderSegments: ['sites', 'site-1', '2026', 'week-11'],
      }),
    );
  });

  it('mantém cada foto inteira e amplia fotos verticais sem reter toda a grade em uma página', async () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(1280, 20);
    const portraitDataUri = `data:image/png;base64,${png.toString('base64')}`;
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      anexos: [portraitDataUri],
    });

    await service.generateFinalPdf('nc-1', 'user-1');

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];
    expect(html).toContain('photo-item--portrait');
    expect(html).toContain(
      '.photo-card, .attachment-card { break-inside: auto;',
    );
    expect(html).toContain('.photo-item--portrait img { height: 94mm; }');
  });

  it('inventaria fotos além do limite individualmente, sem cortar anexos silenciosamente', async () => {
    const jpegDataUri = `data:image/jpeg;base64,${Buffer.from([
      0xff, 0xd8, 0xff, 0xd9,
    ]).toString('base64')}`;
    ncRepository.findOne.mockResolvedValue({
      ...baseNc,
      anexos: Array.from({ length: 25 }, () => jpegDataUri),
    });

    await service.generateFinalPdf('nc-1', 'user-1');

    const [html] = (pdfService.generateFromHtml as jest.Mock).mock.calls[0] as [
      string,
    ];
    expect(
      html.match(/<figure class="photo-item photo-item--/g) || [],
    ).toHaveLength(24);
    expect(html).toContain(
      'Foto anexada 25 (foto não incorporada: limite de 24 fotos por PDF atingido)',
    );
  });
});
