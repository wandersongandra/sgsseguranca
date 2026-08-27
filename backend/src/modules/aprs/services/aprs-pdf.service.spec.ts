import { EntityManager, Repository } from 'typeorm';
import type { TenantService } from '../../../shared/tenant/tenant.service';
import type { DocumentStorageService } from '../../../shared/services/document-storage.service';
import type { PdfService } from '../../../shared/services/pdf.service';
import type { DocumentGovernanceService } from '../../document-registry/document-governance.service';
import type { SignaturesService } from '../../signatures/signatures.service';
import { AprLog } from '../entities/apr-log.entity';
import { Apr, AprStatus } from '../entities/apr.entity';
import { AprsPdfService } from './aprs-pdf.service';
import { markAuthorizedStorageReference } from '../../../shared/storage/storage-object-reference';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];

describe('AprsPdfService', () => {
  let service: AprsPdfService;

  let aprRepository: {
    findOne: jest.Mock;
    manager: {
      getRepository: jest.Mock;
    };
  };
  let aprLogsRepository: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let tenantService: Pick<TenantService, 'getTenantId' | 'getContext'>;
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'generateDocumentKey'
    | 'referenceForExistingObject'
    | 'uploadFile'
    | 'uploadFileWithCapability'
    | 'deleteFile'
    | 'getSignedUrl'
  >;
  let pdfService: Pick<PdfService, 'generateFromHtml'>;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    'registerFinalDocument'
  >;
  let signaturesService: Pick<
    SignaturesService,
    'findByDocument' | 'resolveSignatureData'
  >;

  beforeEach(() => {
    const update = jest.fn();
    const findEvidences = jest.fn().mockResolvedValue([]);

    aprRepository = {
      findOne: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: { name?: string }) => {
          if (entity?.name === 'Apr') {
            return { update };
          }
          if (entity?.name === 'AprRiskEvidence') {
            return { find: findEvidences };
          }
          return {};
        }),
      },
    };

    aprLogsRepository = {
      create: jest.fn((input: Partial<AprLog>) => input as unknown as AprLog),
      save: jest.fn(() => Promise.resolve()),
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
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: { resourceType: string; resourceId: string },
          purpose: string,
        ) => ({
          tenantId: 'company-1',
          key,
          owner,
          purpose,
        }),
      ),
      generateDocumentKey: jest.fn(
        () => 'documents/company-1/aprs/sites/site-1/apr-1/apr-final.pdf',
      ),
      uploadFile: jest.fn(() => Promise.resolve()),
      uploadFileWithCapability: jest.fn((reference) =>
        Promise.resolve(markAuthorizedStorageReference(reference)),
      ),
      deleteFile: jest.fn(() => Promise.resolve()),
      getSignedUrl: jest.fn((reference) =>
        Promise.resolve(
          `https://signed.example/${encodeURIComponent(reference.key)}`,
        ),
      ),
    };
    pdfService = {
      generateFromHtml: jest.fn(() => Promise.resolve(Buffer.from('%PDF-1.4'))),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(
        async (input: RegisterFinalDocumentInput) => {
          await input.persistEntityMetadata?.(
            aprRepository.manager as unknown as EntityManager,
            'hash-1',
          );
          return {
            hash: 'hash-1',
            registryEntry: { id: 'registry-1' },
          } as never;
        },
      ),
    };
    signaturesService = {
      findByDocument: jest.fn(() =>
        Promise.resolve([
          { user_id: 'user-1', signature_data: 'assinatura' },
        ] as unknown as Awaited<
          ReturnType<SignaturesService['findByDocument']>
        >),
      ),
      resolveSignatureData: jest.fn((signature) =>
        Promise.resolve(signature.signature_data ?? null),
      ),
    };

    service = new AprsPdfService(
      aprRepository as unknown as Repository<Apr>,
      aprLogsRepository as unknown as Repository<AprLog>,
      tenantService as TenantService,
      documentStorageService as DocumentStorageService,
      pdfService as PdfService,
      documentGovernanceService as DocumentGovernanceService,
      signaturesService as SignaturesService,
      { issueToken: jest.fn().mockResolvedValue('token-publico') } as never,
    );
  });

  it('storeFinalPdfBuffer salva no storage governado e persiste metadados na APR', async () => {
    const apr = {
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'APR Torre',
      numero: 'APR-001',
      data_inicio: new Date('2026-03-14T10:00:00.000Z'),
      created_at: new Date('2026-03-14T09:00:00.000Z'),
    } as unknown as Apr;
    const buffer = Buffer.from('%PDF-apr');

    const result = await service.storeFinalPdfBuffer(apr, {
      buffer,
      originalName: 'apr-final.pdf',
      mimeType: 'application/pdf',
      userId: 'user-1',
    });

    expect(
      documentStorageService.uploadFileWithCapability,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/aprs/sites/site-1/apr-1/apr-final.pdf',
      }),
      buffer,
      'application/pdf',
    );
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'apr',
        entityId: 'apr-1',
        fileKey: 'documents/company-1/aprs/sites/site-1/apr-1/apr-final.pdf',
        createdBy: 'user-1',
      }),
    );
    expect(result).toEqual({
      fileKey: 'documents/company-1/aprs/sites/site-1/apr-1/apr-final.pdf',
      folderPath: 'documents/company-1/aprs/sites/site-1/apr-1',
      originalName: 'apr-final.pdf',
    });
  });

  it('storeFinalPdfBuffer exclui arquivo do storage quando governance lança erro', async () => {
    const apr = {
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'APR Torre',
      numero: 'APR-001',
      data_inicio: new Date('2026-03-14T10:00:00.000Z'),
      created_at: new Date('2026-03-14T09:00:00.000Z'),
    } as unknown as Apr;

    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance falhou'));

    await expect(
      service.storeFinalPdfBuffer(apr, {
        buffer: Buffer.from('%PDF-apr'),
        originalName: 'apr-final.pdf',
        mimeType: 'application/pdf',
        userId: 'user-1',
      }),
    ).rejects.toThrow('governance falhou');

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/aprs/sites/site-1/apr-1/apr-final.pdf',
      }),
    );
  });

  it('attachPdf foi descontinuado e não registra PDF final oficial', () => {
    const file = {
      originalname: 'apr-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-apr'),
    } as Express.Multer.File;

    expect(() => service.attachPdf('apr-1', file, 'user-1')).toThrow(
      'Anexo manual de PDF final descontinuado',
    );
    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
  });

  it('generateFinalPdf retorna acesso existente sem regerar quando PDF já existe', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/aprs/apr-1/existing.pdf',
      pdf_folder_path: 'aprs/company-1',
      pdf_original_name: 'APR-001_v1.pdf',
    });

    const result = await service.generateFinalPdf('apr-1', 'user-1');

    expect(pdfService.generateFromHtml).not.toHaveBeenCalled();
    expect(result.generated).toBe(false);
    expect(result.hasFinalPdf).toBe(true);
    expect(result.entityId).toBe('apr-1');
  });

  it('generateFinalPdf gera PDF oficial e retorna acesso governado', async () => {
    aprRepository.findOne
      .mockResolvedValueOnce({
        id: 'apr-1',
        company_id: 'company-1',
        pdf_file_key: null,
        pdf_folder_path: null,
        pdf_original_name: null,
      })
      .mockResolvedValueOnce({
        id: 'apr-1',
        company_id: 'company-1',
        site_id: 'site-1',
        titulo: 'APR Torre',
        numero: 'APR-001',
        status: AprStatus.APROVADA,
        data_inicio: new Date('2026-03-14T10:00:00.000Z'),
        data_fim: new Date('2026-03-20T10:00:00.000Z'),
        created_at: new Date('2026-03-14T09:00:00.000Z'),
        updated_at: new Date('2026-03-14T09:30:00.000Z'),
        pdf_file_key: null,
        is_modelo: false,
        participants: [
          {
            id: 'user-1',
            nome: 'Maria',
            funcao: 'Técnica de Segurança',
            profile: { nome: 'TST' },
          },
        ],
        company: {
          razao_social: 'Empresa Teste',
          cnpj: '00.000.000/0001-00',
        },
        site: { nome: 'Obra Centro' },
        elaborador: { nome: 'Maria' },
        risk_items: [
          {
            id: 'risk-1',
            atividade: 'Montagem de estrutura metálica',
            agente_ambiental: 'jhguh8h8i',
            condicao_perigosa: 'jghuhuihui',
            fonte_circunstancia: 'jguhuhuhgu',
            lesao: 'gugiuguhu',
            probabilidade: 4,
            severidade: 5,
            categoria_risco: 'Crítico',
            medidas_prevencao:
              'Isolar a área, inspecionar ancoragem e exigir linha de vida certificada.',
          },
        ],
      })
      .mockResolvedValueOnce(null) // supersedingRow check — no superseding APR
      .mockResolvedValueOnce({
        id: 'apr-1',
        company_id: 'company-1',
        site_id: 'site-1',
        pdf_file_key: 'documents/company-1/aprs/apr-1/apr-final.pdf',
        pdf_folder_path: 'aprs/company-1',
        pdf_original_name: 'APR-001_v1.pdf',
      });

    const result = await service.generateFinalPdf('apr-1', 'user-1');

    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('APR - ANÁLISE PRELIMINAR DE RISCOS'),
      expect.objectContaining({
        format: 'A4',
        landscape: true,
        preferCssPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        margin: {
          top: '0mm',
          right: '0mm',
          bottom: '8mm',
          left: '0mm',
        },
      }),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        footerTemplate: expect.stringContaining('pageNumber') as unknown,
      }),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        footerTemplate: expect.stringContaining('totalPages') as unknown,
      }),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('size: A4 landscape;'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('APR - ANÁLISE PRELIMINAR DE RISCOS'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Reconhecimento de Riscos'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Medidas de Prevenção'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('critério de ação'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Assinaturas registradas'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Cargo / função'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Técnica de Segurança'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Assinatura registrada no SGS'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Calculado e registrado após a emissão'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('.apr-risk-table'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('.risk-badge--critical'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('--teal: #1d5b8d;'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('Informação operacional não qualificada'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.not.stringContaining('jhguh8h8i'),
      expect.any(Object),
    );
    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.not.stringContaining('jghuhuihui'),
      expect.any(Object),
    );
    expect(
      documentStorageService.uploadFileWithCapability,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/aprs/sites/site-1/apr-1/apr-final.pdf',
      }),
      expect.any(Buffer),
      'application/pdf',
    );
    expect(result).toMatchObject({
      entityId: 'apr-1',
      generated: true,
      hasFinalPdf: true,
    });
  });

  it('regeneratePdfWithSupersededWatermark retorna silenciosamente quando APR sem PDF', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      pdf_file_key: null,
    });

    await expect(
      service.regeneratePdfWithSupersededWatermark('apr-1', 'user-1'),
    ).resolves.toBeUndefined();

    expect(pdfService.generateFromHtml).not.toHaveBeenCalled();
  });

  it('regeneratePdfWithSupersededWatermark silencia erros internos', async () => {
    aprRepository.findOne.mockRejectedValue(new Error('db offline'));

    await expect(
      service.regeneratePdfWithSupersededWatermark('apr-1', 'user-1'),
    ).resolves.toBeUndefined();

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });
});
