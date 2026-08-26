import { Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { AuditsService } from './audits.service';
import { Audit } from './entities/audit.entity';
import type { TenantRepositoryFactory } from '../../shared/tenant/tenant-repository';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import type { TenantService } from '../../shared/tenant/tenant.service';
import { markAuthorizedStorageReference } from '../../shared/storage/storage-object-reference';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];
type RemoveFinalDocumentReferenceInput = Parameters<
  DocumentGovernanceService['removeFinalDocumentReference']
>[0];

describe('AuditsService', () => {
  let service: AuditsService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    query: jest.Mock;
  };
  let tenantRepo: {
    findOne: jest.Mock;
  };
  let usersRepository: {
    findOne: jest.Mock;
  };
  let documentStorageService: Pick<
    DocumentStorageService,
    | 'generateDocumentKey'
    | 'referenceForExistingObject'
    | 'uploadFile'
    | 'uploadFileWithCapability'
    | 'deleteFile'
    | 'getSignedUrl'
  >;
  let documentBundleService: Pick<
    DocumentBundleService,
    'buildWeeklyPdfBundle'
  >;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    'registerFinalDocument' | 'removeFinalDocumentReference'
  >;

  beforeEach(() => {
    repository = {
      create: jest.fn((input: Partial<Audit>) => input as Audit),
      save: jest.fn((input) => Promise.resolve(input as unknown as Audit)),
      query: jest.fn(),
    };
    tenantRepo = {
      findOne: jest.fn(),
    };
    usersRepository = {
      findOne: jest.fn(),
    };
    documentStorageService = {
      generateDocumentKey: jest.fn(
        () => 'documents/company-1/audits/sites/site-1/audit-1/audit-final.pdf',
      ),
      referenceForExistingObject: jest.fn((key: string) => ({
        tenantId: 'company-1',
        key,
        owner: { resourceType: 'test', resourceId: key },
        purpose: 'test',
        legacy: !key.startsWith('documents/company-1/'),
      })),
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
    documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(() =>
        Promise.resolve({
          buffer: Buffer.from('audit-bundle'),
          fileName: 'Auditoria-2026-W11.pdf',
        }),
      ),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
    };

    service = new AuditsService(
      repository as unknown as Repository<Audit>,
      usersRepository as never,
      {
        wrap: jest.fn(() => tenantRepo),
      } as unknown as TenantRepositoryFactory,
      documentStorageService as DocumentStorageService,
      documentBundleService as DocumentBundleService,
      documentGovernanceService as DocumentGovernanceService,
      {
        issueToken: jest.fn().mockResolvedValue('token-mock'),
      } as unknown as import('../../shared/services/public-validation-grant.service').PublicValidationGrantService,
      {
        getTenantId: jest.fn(() => 'company-1'),
        getContext: jest.fn(() => ({
          companyId: 'company-1',
          isSuperAdmin: false,
          siteScope: 'all',
        })),
      } as unknown as TenantService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('anexa o PDF final da auditoria pela esteira central', async () => {
    const audit = {
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria de campo',
      data_auditoria: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as unknown as Audit;
    const update = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ update })),
    };
    tenantRepo.findOne.mockResolvedValue(audit);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(manager as never, 'hash-1');
      return { hash: 'hash-1', registryEntry: { id: 'registry-1' } };
    });

    const file = {
      originalname: 'audit-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-audit'),
    } as Express.Multer.File;

    await expect(
      service.attachPdf('audit-1', 'company-1', file, 'user-1'),
    ).resolves.toEqual({
      fileKey:
        'documents/company-1/audits/sites/site-1/audit-1/audit-final.pdf',
      folderPath: 'documents/company-1/audits/sites/site-1/audit-1',
      originalName: 'audit-final.pdf',
    });

    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        module: 'audit',
        entityId: 'audit-1',
        fileBuffer: file.buffer,
        createdBy: 'user-1',
      }),
    );
    const [id, payload] = update.mock.calls[0] as [
      string,
      {
        pdf_file_key: string;
        pdf_original_name: string;
        pdf_file_hash: string;
        pdf_generated_at: Date;
      },
    ];
    expect(id).toBe('audit-1');
    expect(payload.pdf_file_key).toBe(
      'documents/company-1/audits/sites/site-1/audit-1/audit-final.pdf',
    );
    expect(payload.pdf_original_name).toBe('audit-final.pdf');
    expect(payload.pdf_file_hash).toBe('hash-1');
    expect(payload.pdf_generated_at).toBeInstanceOf(Date);
  });

  it('normaliza campos em branco antes de persistir a auditoria', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria anterior',
    });
    usersRepository.findOne.mockResolvedValue({
      id: 'user-1',
      company_id: 'company-1',
      site_id: 'site-1',
    });

    const payload = {
      titulo: '  Auditoria de campo  ',
      data_auditoria: '2026-03-14',
      tipo_auditoria: '  Interna  ',
      site_id: 'site-1',
      auditor_id: 'user-1',
      representantes_empresa: '  ',
      objetivo: '  Verificar conformidade  ',
      escopo: '  ',
      referencias: [' NR-01 ', ' ', 'NR-12'],
      metodologia: '  Inspeção documental  ',
      caracterizacao: {
        cnae: '  1234-5/00 ',
        grau_risco: ' 2 ',
        num_trabalhadores: 0,
        turnos: '  ',
        atividades_principais: '  ',
      },
      documentos_avaliados: ['  Documento 1  ', '', '  '],
      resultados_conformidades: ['  Conformidade 1  ', ''],
      resultados_nao_conformidades: [
        {
          descricao: '  Desvio 1  ',
          requisito: '  NR-1  ',
          evidencia: '  Foto 1  ',
          classificacao: '  Grave  ',
        },
        {
          descricao: '  ',
          requisito: '  ',
          evidencia: '  ',
          classificacao: '  ',
        },
      ],
      resultados_observacoes: ['  Observacao 1  ', ' '],
      resultados_oportunidades: ['  Oportunidade 1  '],
      avaliacao_riscos: [
        {
          perigo: '  Queda  ',
          classificacao: '  Alto  ',
          impactos: '  Fratura  ',
          medidas_controle: '  EPI  ',
        },
        {
          perigo: '  ',
          classificacao: '  ',
          impactos: '  ',
          medidas_controle: '  ',
        },
      ],
      plano_acao: [
        {
          item: '  1  ',
          acao: '  Corrigir  ',
          responsavel: '  João  ',
          prazo: '  10/05/2026  ',
          status: '  Aberto  ',
        },
        {
          item: '  ',
          acao: '  ',
          responsavel: '  ',
          prazo: '  ',
          status: '  ',
        },
      ],
      checklist_respostas: [
        {
          sectionId: '  apr-pt-dds  ',
          sectionTitle: '  APR / PT / DDS  ',
          questionId: '  apr-antes-atividade  ',
          question:
            '  A APR é preenchida antes do início das atividades críticas?  ',
          requirement: '  NR-01 / Procedimento APR  ',
          criticality: 'alta',
          answer: 'nao',
          observation: '  APR aberta somente após início da atividade.  ',
          allowsPhoto: true,
          photoRequiredWhen: 'nao',
          suggestedAction: '  Implantar trava de início sem APR aprovada.  ',
          evidences: [
            {
              id: '  foto-1  ',
              fileName: '  apr-campo.jpg  ',
              mimeType: 'image/jpeg',
              size: 1280,
              dataUrl: '  data:image/jpeg;base64,AAA  ',
              capturedAt: '  2026-07-06T12:00:00.000Z  ',
              hash: '  hash-1  ',
            },
            {
              id: 'foto-invalida',
              fileName: 'foto-invalida.txt',
              mimeType: 'image/jpeg',
              size: 10,
              dataUrl: 'data:text/plain;base64,AAA',
              capturedAt: '2026-07-06T12:00:00.000Z',
            },
          ],
        },
        {
          sectionId: '  ',
          sectionTitle: '  ',
          questionId: '  ',
          question: '  ',
          requirement: '  ',
          criticality: 'alta',
          answer: 'sim',
        },
      ],
      conclusao: '  Concluída  ',
    };

    await expect(
      service.create(payload as never, 'company-1'),
    ).resolves.toEqual(
      expect.objectContaining({
        titulo: 'Auditoria de campo',
        tipo_auditoria: 'Interna',
        objetivo: 'Verificar conformidade',
        referencias: ['NR-01', 'NR-12'],
        documentos_avaliados: ['Documento 1'],
        resultados_conformidades: ['Conformidade 1'],
        resultados_nao_conformidades: [
          expect.objectContaining({ descricao: 'Desvio 1', requisito: 'NR-1' }),
        ],
        resultados_observacoes: ['Observacao 1'],
        resultados_oportunidades: ['Oportunidade 1'],
        avaliacao_riscos: [
          expect.objectContaining({ perigo: 'Queda', classificacao: 'Alto' }),
        ],
        plano_acao: [
          expect.objectContaining({ item: '1', responsavel: 'João' }),
        ],
        checklist_respostas: [
          expect.objectContaining({
            sectionId: 'apr-pt-dds',
            questionId: 'apr-antes-atividade',
            observation: 'APR aberta somente após início da atividade.',
            evidences: [
              expect.objectContaining({
                id: 'foto-1',
                fileName: 'apr-campo.jpg',
                hash: 'hash-1',
              }),
            ],
          }),
        ],
        conclusao: 'Concluída',
      }),
    );

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        titulo: 'Auditoria de campo',
        documentos_avaliados: ['Documento 1'],
        resultados_observacoes: ['Observacao 1'],
        checklist_respostas: [
          expect.objectContaining({
            questionId: 'apr-antes-atividade',
            evidences: [
              expect.objectContaining({
                dataUrl: 'data:image/jpeg;base64,AAA',
              }),
            ],
          }),
        ],
      }),
    );
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
    (
      repository as unknown as { createQueryBuilder: jest.Mock }
    ).createQueryBuilder = jest.fn().mockReturnValue(queryBuilder);

    await expect(
      service.findPaginated(
        {
          page: 1,
          limit: 20,
          search: ['forged'] as unknown as string,
        },
        'company-1',
      ),
    ).rejects.toThrow();

    expect(queryBuilder.getManyAndCount).not.toHaveBeenCalled();
  });

  it('rejeita auditor que nao pertence a obra selecionada', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria de campo',
      pdf_file_key: null,
    });
    usersRepository.findOne.mockResolvedValue({
      id: 'user-2',
      company_id: 'company-1',
      site_id: 'site-2',
    });

    await expect(
      service.update(
        'audit-1',
        {
          titulo: 'Auditoria de campo',
          data_auditoria: '2026-03-14',
          tipo_auditoria: 'Interna',
          site_id: 'site-1',
          auditor_id: 'user-2',
        },
        'company-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejeita auditor sem obra quando o perfil nao e corporativo', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria de campo',
      pdf_file_key: null,
    });
    usersRepository.findOne.mockResolvedValue({
      id: 'user-2',
      company_id: 'company-1',
      site_id: null,
      profile: { nome: 'Técnico de Segurança do Trabalho (TST)' },
    });

    await expect(
      service.create(
        {
          titulo: 'Auditoria de campo',
          data_auditoria: '2026-03-14',
          tipo_auditoria: 'Interna',
          site_id: 'site-1',
          auditor_id: 'user-2',
        },
        'company-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('permite auditor vinculado por site_links na obra selecionada', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria de campo',
      pdf_file_key: null,
    });
    usersRepository.findOne.mockResolvedValue({
      id: 'user-2',
      company_id: 'company-1',
      site_id: null,
      site_links: [{ site_id: 'site-1' }],
      profile: { nome: 'Técnico de Segurança do Trabalho (TST)' },
    });

    repository.create.mockImplementation(
      (input: Partial<Audit>) => input as Audit,
    );

    await expect(
      service.create(
        {
          titulo: 'Auditoria de campo',
          data_auditoria: '2026-03-14',
          tipo_auditoria: 'Interna',
          site_id: 'site-1',
          auditor_id: 'user-2',
        },
        'company-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        auditor_id: 'user-2',
      }),
    );
  });

  it('permite auditor corporativo sem obra vinculada', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria de campo',
      pdf_file_key: null,
    });
    usersRepository.findOne.mockResolvedValue({
      id: 'user-2',
      company_id: 'company-1',
      site_id: null,
      profile: { nome: 'Administrador da Empresa' },
    });

    repository.create.mockImplementation(
      (input: Partial<Audit>) => input as Audit,
    );
    await expect(
      service.create(
        {
          titulo: 'Auditoria de campo',
          data_auditoria: '2026-03-14',
          tipo_auditoria: 'Interna',
          site_id: 'site-1',
          auditor_id: 'user-2',
        },
        'company-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        auditor_id: 'user-2',
      }),
    );
  });

  it('permite auditor corporativo mesmo com obra secundária diferente', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria de campo',
      pdf_file_key: null,
    });
    usersRepository.findOne.mockResolvedValue({
      id: 'user-2',
      company_id: 'company-1',
      site_id: 'site-2',
      site_links: [{ site_id: 'site-2' }],
      profile: { nome: 'Administrador Geral' },
    });

    repository.create.mockImplementation(
      (input: Partial<Audit>) => input as Audit,
    );

    await expect(
      service.create(
        {
          titulo: 'Auditoria de campo',
          data_auditoria: '2026-03-14',
          tipo_auditoria: 'Interna',
          site_id: 'site-1',
          auditor_id: 'user-2',
        },
        'company-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        auditor_id: 'user-2',
      }),
    );
  });

  it('countPendingActionItems: usa jsonb_array_elements compatível com plano_acao jsonb e filtro tenant', async () => {
    repository.query.mockResolvedValue([{ total: '3' }]);

    await expect(service.countPendingActionItems('company-1')).resolves.toBe(3);

    const [sql, params] = repository.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "jsonb_array_elements(COALESCE(a.plano_acao::jsonb, '[]'::jsonb))",
    );
    expect(sql).toContain('WHERE a.company_id = $1 AND a.deleted_at IS NULL');
    expect(params).toEqual(['company-1']);
  });

  it('bloqueia atualizacao quando ja existe PDF final anexado', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/audits/audit-1/audit-final.pdf',
    });

    await expect(
      service.update(
        'audit-1',
        {
          titulo: 'Novo titulo',
          data_auditoria: '2026-03-14',
          tipo_auditoria: 'Interna',
          site_id: 'site-1',
          auditor_id: 'user-1',
        },
        'company-1',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(repository.save).not.toHaveBeenCalled();
  });

  it('bloqueia novo anexo quando a auditoria ja possui PDF final', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/audits/audit-1/audit-final.pdf',
    });

    const file = {
      originalname: 'audit-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-audit'),
    } as Express.Multer.File;

    await expect(
      service.attachPdf('audit-1', 'company-1', file, 'user-1'),
    ).rejects.toThrow(BadRequestException);

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
  });

  it('remove a auditoria via esteira central e aplica a policy de lifecycle', async () => {
    const audit = {
      id: 'audit-1',
      company_id: 'company-1',
    } as unknown as Audit;
    const softDelete = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ softDelete })),
    };
    tenantRepo.findOne.mockResolvedValue(audit);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: RemoveFinalDocumentReferenceInput) => {
      await input.removeEntityState?.(manager as never);
    });

    await expect(
      service.remove('audit-1', 'company-1'),
    ).resolves.toBeUndefined();

    const [removeInput] = (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mock.calls[0] as [RemoveFinalDocumentReferenceInput];
    expect(removeInput.companyId).toBe('company-1');
    expect(removeInput.module).toBe('audit');
    expect(removeInput.entityId).toBe('audit-1');
    expect(typeof removeInput.removeEntityState).toBe('function');
    expect(softDelete).toHaveBeenCalledWith('audit-1');
  });

  it('bloqueia remocao de auditoria que ja tem PDF final emitido', async () => {
    const audit = {
      id: 'audit-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/audit-1.pdf',
    } as unknown as Audit;
    tenantRepo.findOne.mockResolvedValue(audit);

    await expect(service.remove('audit-1', 'company-1')).rejects.toThrow(
      'sem PDF final',
    );
    expect(
      documentGovernanceService.removeFinalDocumentReference,
    ).not.toHaveBeenCalled();
  });

  it('remove o arquivo da auditoria do storage quando a governanca falha depois do upload', async () => {
    const audit = {
      id: 'audit-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'Auditoria de campo',
      data_auditoria: new Date('2026-03-14T08:00:00.000Z'),
      created_at: new Date('2026-03-14T07:00:00.000Z'),
    } as unknown as Audit;
    tenantRepo.findOne.mockResolvedValue(audit);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance failed'));

    const file = {
      originalname: 'audit-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-audit'),
    } as Express.Multer.File;

    await expect(
      service.attachPdf('audit-1', 'company-1', file, 'user-1'),
    ).rejects.toThrow('governance failed');

    expect(documentStorageService.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'documents/company-1/audits/sites/site-1/audit-1/audit-final.pdf',
      }),
    );
  });

  it('retorna contrato explicito quando a auditoria ainda nao possui PDF final emitido', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    });

    await expect(service.getPdfAccess('audit-1', 'company-1')).resolves.toEqual(
      {
        entityId: 'audit-1',
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'PDF final ainda não emitido para esta auditoria.',
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      },
    );
  });

  it('retorna disponibilidade degradada quando a URL assinada nao pode ser emitida', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/audits/audit-1/audit-final.pdf',
      pdf_folder_path: 'audits/company-1',
      pdf_original_name: 'audit-final.pdf',
    });
    (documentStorageService.getSignedUrl as jest.Mock).mockRejectedValueOnce(
      new Error('storage offline'),
    );

    await expect(service.getPdfAccess('audit-1', 'company-1')).resolves.toEqual(
      {
        entityId: 'audit-1',
        hasFinalPdf: true,
        availability: 'registered_without_signed_url',
        message:
          'PDF final emitido, mas a URL segura não está disponível no momento.',
        fileKey: 'documents/company-1/audits/audit-1/audit-final.pdf',
        folderPath: 'audits/company-1',
        originalName: 'audit-final.pdf',
        url: null,
      },
    );
  });

  it('retorna disponibilidade pronta quando o PDF final possui URL assinada', async () => {
    tenantRepo.findOne.mockResolvedValue({
      id: 'audit-1',
      company_id: 'company-1',
      pdf_file_key: 'documents/company-1/audits/audit-1/audit-final.pdf',
      pdf_folder_path: 'audits/company-1',
      pdf_original_name: 'audit-final.pdf',
    });

    await expect(service.getPdfAccess('audit-1', 'company-1')).resolves.toEqual(
      {
        entityId: 'audit-1',
        hasFinalPdf: true,
        availability: 'ready',
        message: null,
        fileKey: 'documents/company-1/audits/audit-1/audit-final.pdf',
        folderPath: 'audits/company-1',
        originalName: 'audit-final.pdf',
        url: 'https://signed.example/documents%2Fcompany-1%2Faudits%2Faudit-1%2Faudit-final.pdf',
      },
    );
  });
});
