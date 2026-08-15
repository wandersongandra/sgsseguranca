/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { EntityManager, Repository } from 'typeorm';
import { AprsService } from './aprs.service';
import { Apr, AprStatus } from './entities/apr.entity';
import { AprLog } from './entities/apr-log.entity';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import type { PdfService } from '../../shared/services/pdf.service';
import type { DocumentGovernanceService } from '../document-registry/document-governance.service';
import type { SignaturesService } from '../signatures/signatures.service';
import type { StorageService } from '../../shared/services/storage.service';
import type { AprRiskMatrixService } from './apr-risk-matrix.service';
import type { AprExcelService } from './apr-excel.service';
import type { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { FORENSIC_EVENT_TYPES } from '../forensic-trail/forensic-trail.constants';
import type { AppendForensicTrailEventInput } from '../forensic-trail/forensic-trail.service';
import type { MetricsService } from '../../shared/observability/metrics.service';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import type { CacheService } from '../../shared/cache/cache.service';
import { AprsEvidenceService } from './services/aprs-evidence.service';
import { AprsPdfService } from './services/aprs-pdf.service';
import { AprWorkflowService } from './aprs-workflow.service';
import { BadRequestException } from '@nestjs/common';

type RegisterFinalDocumentInput = Parameters<
  DocumentGovernanceService['registerFinalDocument']
>[0];
type RemoveFinalDocumentReferenceInput = Parameters<
  DocumentGovernanceService['removeFinalDocumentReference']
>[0];
type EvidenceRepositoryInput = Record<string, unknown>;
type RepositoryEntityName = { name?: string };
type AprFindOneArgs = {
  where?: {
    id?: string;
  };
};
type AprParticipantMock = { id?: string; nome?: string };
type AprRiskItemMock = { id?: string; categoria?: string };
type ConfiguredApr = Omit<
  Partial<Apr>,
  | 'id'
  | 'company_id'
  | 'status'
  | 'pdf_file_key'
  | 'participants'
  | 'risk_items'
> & {
  id?: string;
  company_id?: string;
  status?: AprStatus;
  pdf_file_key?: string | null;
  participants?: AprParticipantMock[];
  risk_items?: AprRiskItemMock[];
};
type AprCountRow = { count: string };
type AprTransactionQueryRow = ConfiguredApr | AprCountRow;
type TransactionManagerMock = {
  getRepository: jest.Mock<unknown, [RepositoryEntityName]>;
  query: jest.Mock<Promise<AprTransactionQueryRow[]>, [string, unknown[]?]>;
};
type AprRepositoryMock = {
  findOne: jest.Mock<Promise<ConfiguredApr | null>, [AprFindOneArgs?]>;
  save: jest.Mock<Promise<Apr>, [Apr]>;
  createQueryBuilder: jest.Mock;
  manager: {
    getRepository: jest.Mock<unknown, [RepositoryEntityName]>;
    query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
    transaction: jest.Mock<
      Promise<unknown>,
      [(manager: TransactionManagerMock) => Promise<unknown>]
    >;
  };
};
type SignatureLookupResult = Awaited<
  ReturnType<SignaturesService['findByDocument']>
>;

describe('AprsService', () => {
  let service: AprsService;
  let tenantService: Pick<TenantService, 'getTenantId' | 'getContext' | 'run'>;
  let aprRepository: AprRepositoryMock;
  let aprLogsRepository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let documentStorageService: Pick<
    DocumentStorageService,
    'generateDocumentKey' | 'uploadFile' | 'deleteFile' | 'getSignedUrl'
  >;
  let pdfService: Pick<PdfService, 'generateFromHtml'>;
  let documentGovernanceService: Pick<
    DocumentGovernanceService,
    'registerFinalDocument' | 'removeFinalDocumentReference'
  >;
  let signaturesService: Pick<
    SignaturesService,
    'findByDocument' | 'resolveSignatureData'
  >;
  let aprRiskMatrixService: Pick<
    AprRiskMatrixService,
    'evaluate' | 'normalizeCategory' | 'summarize'
  >;
  let riskCalculationService: Pick<
    RiskCalculationService,
    'calculateScore' | 'classifyByScore'
  >;
  let aprExcelService: Pick<
    AprExcelService,
    'previewImport' | 'buildTemplateWorkbook' | 'buildDetailWorkbook'
  >;
  let forensicTrailService: Pick<ForensicTrailService, 'append'>;
  let metricsService: Pick<MetricsService, 'incrementAprCreated'>;
  let cacheService: Pick<CacheService, 'getOrSet' | 'del'>;

  beforeEach(() => {
    aprRepository = {
      findOne: jest
        .fn<Promise<ConfiguredApr | null>, [AprFindOneArgs?]>()
        .mockResolvedValue(null),
      save: jest.fn((input: Apr) => Promise.resolve(input)),
      createQueryBuilder: jest.fn(),
      manager: {
        getRepository: jest.fn((entity: RepositoryEntityName) => {
          if (entity.name === 'AprRiskEvidence') {
            return {
              count: jest.fn().mockResolvedValue(0),
              find: jest.fn().mockResolvedValue([]),
              remove: jest.fn().mockResolvedValue([]),
            };
          }
          return {
            save: jest.fn((input: Apr) => aprRepository.save(input)),
            create: jest.fn((input: Partial<Apr>) => input as unknown as Apr),
            findOne: jest.fn((args?: AprFindOneArgs) =>
              aprRepository.findOne(args),
            ),
            find: jest.fn().mockResolvedValue([]),
          };
        }),
        query: jest.fn().mockResolvedValue([]),
        transaction: jest.fn(
          (callback: (manager: TransactionManagerMock) => Promise<unknown>) =>
            Promise.resolve(
              callback({
                getRepository: jest.fn((entity: RepositoryEntityName) => {
                  if (entity.name === 'Apr') {
                    return {
                      save: jest.fn((input: Apr) => aprRepository.save(input)),
                      create: jest.fn(
                        (input: Partial<Apr>) => input as unknown as Apr,
                      ),
                      findOne: jest.fn((args?: AprFindOneArgs) =>
                        aprRepository.findOne(args),
                      ),
                    };
                  }
                  if (entity.name === 'AprRiskEvidence') {
                    return {
                      count: jest.fn().mockResolvedValue(0),
                    };
                  }
                  return {
                    save: jest.fn((input: Record<string, unknown>) =>
                      Promise.resolve(input),
                    ),
                    create: jest.fn((input: Record<string, unknown>) => input),
                    find: jest.fn().mockResolvedValue([]),
                  };
                }),
                query: jest
                  .fn<Promise<AprTransactionQueryRow[]>, [string, unknown[]?]>()
                  .mockImplementation(async (sql, params) => {
                    const id =
                      Array.isArray(params) && typeof params[0] === 'string'
                        ? params[0]
                        : undefined;
                    const configured = await aprRepository.findOne({
                      where: { id },
                    });
                    if (String(sql).includes('"apr_participants"')) {
                      return [
                        {
                          count: String(
                            Array.isArray(configured?.participants)
                              ? configured.participants.length
                              : 0,
                          ),
                        },
                      ];
                    }
                    if (String(sql).includes('"apr_risk_items"')) {
                      return [
                        {
                          count: String(
                            Array.isArray(configured?.risk_items)
                              ? configured.risk_items.length
                              : 0,
                          ),
                        },
                      ];
                    }
                    return [
                      configured || {
                        id,
                        company_id: 'company-1',
                        status: AprStatus.PENDENTE,
                        pdf_file_key: null,
                      },
                    ];
                  }),
              }),
            ),
        ),
      },
    };
    aprLogsRepository = {
      create: jest.fn((input: Partial<AprLog>) => input as unknown as AprLog),
      save: jest.fn(() => Promise.resolve()),
      find: jest.fn().mockResolvedValue([]),
    };
    documentStorageService = {
      generateDocumentKey: jest.fn(
        () => 'documents/company-1/aprs/apr-1/apr-final.pdf',
      ),
      uploadFile: jest.fn(() => Promise.resolve()),
      deleteFile: jest.fn(() => Promise.resolve()),
      getSignedUrl: jest.fn((key: string) =>
        Promise.resolve(`https://signed.example/${encodeURIComponent(key)}`),
      ),
    };
    pdfService = {
      generateFromHtml: jest.fn(() => Promise.resolve(Buffer.from('%PDF-1.4'))),
    };
    documentGovernanceService = {
      registerFinalDocument: jest.fn(),
      removeFinalDocumentReference: jest.fn(),
    };
    signaturesService = {
      findByDocument: jest.fn(() => {
        const result: SignatureLookupResult = [
          { user_id: 'user-1', signature_data: 'assinatura' },
        ] as SignatureLookupResult;
        return Promise.resolve(result);
      }),
      resolveSignatureData: jest.fn((signature) =>
        Promise.resolve(signature.signature_data ?? null),
      ),
    };
    aprRiskMatrixService = {
      evaluate: jest.fn(
        (probability?: number | null, severity?: number | null) => {
          if (!probability || !severity) {
            return { score: null, categoria: null, prioridade: null };
          }
          const score = Number(probability) * Number(severity);
          if (score <= 2) {
            return {
              score,
              categoria: 'Aceitável',
              prioridade: 'Não prioritário',
            };
          }
          if (score <= 4) {
            return {
              score,
              categoria: 'Atenção',
              prioridade: 'Prioridade básica',
            };
          }
          if (score <= 6) {
            return {
              score,
              categoria: 'Substancial',
              prioridade: 'Prioridade preferencial',
            };
          }
          return {
            score,
            categoria: 'Crítico',
            prioridade: 'Prioridade máxima',
          };
        },
      ),
      normalizeCategory: jest.fn((value?: string | null) => {
        if (!value) return null;
        if (value === 'Crítico') return 'Crítico';
        if (value === 'Substancial') return 'Substancial';
        if (value === 'Atenção' || value === 'De Atenção') return 'Atenção';
        return 'Aceitável';
      }),
      summarize: jest.fn((categories: Array<string | null | undefined>) => ({
        total: categories.filter(Boolean).length,
        aceitavel: categories.filter((value) => value === 'Aceitável').length,
        atencao: categories.filter(
          (value) => value === 'Atenção' || value === 'De Atenção',
        ).length,
        substancial: categories.filter((value) => value === 'Substancial')
          .length,
        critico: categories.filter((value) => value === 'Crítico').length,
      })),
    };
    riskCalculationService = {
      calculateScore: jest.fn(() => 0),
      classifyByScore: jest.fn(() => null),
    };
    aprExcelService = {
      previewImport: jest.fn(),
      buildTemplateWorkbook: jest.fn(() =>
        Promise.resolve(Buffer.from('template')),
      ),
      buildDetailWorkbook: jest.fn(() =>
        Promise.resolve(Buffer.from('detail')),
      ),
    };
    forensicTrailService = {
      append: jest.fn(() =>
        Promise.resolve({ id: 'trail-1' } as unknown as Awaited<
          ReturnType<ForensicTrailService['append']>
        >),
      ),
    };
    metricsService = {
      incrementAprCreated: jest.fn(),
    };
    cacheService = {
      getOrSet: jest.fn(<T>(_key: string, factory: () => Promise<T>) =>
        factory(),
      ) as unknown as CacheService['getOrSet'],
      del: jest.fn(() => Promise.resolve()),
    };
    tenantService = {
      getTenantId: jest.fn(() => 'company-1'),
      getContext: jest.fn(() => ({
        companyId: 'company-1',
        siteScope: 'all',
        isSuperAdmin: false,
      })),
      run: jest.fn((_ctx: unknown, cb: () => unknown) => cb()),
    } as unknown as Pick<TenantService, 'getTenantId' | 'getContext' | 'run'>;
    const documentBundleService = {
      buildWeeklyPdfBundle: jest.fn(),
    };

    const aprsPdfService = new AprsPdfService(
      aprRepository as unknown as Repository<Apr>,
      aprLogsRepository as unknown as Repository<AprLog>,
      tenantService as TenantService,
      documentStorageService as DocumentStorageService,
      pdfService as PdfService,
      documentGovernanceService as DocumentGovernanceService,
      signaturesService as SignaturesService,
      { issueToken: jest.fn().mockResolvedValue('token-publico') } as never,
      {
        getPresignedInlineViewUrl: jest.fn(),
      } as unknown as StorageService,
    );
    const aprsEvidenceService = new AprsEvidenceService(
      aprRepository as unknown as Repository<Apr>,
      aprLogsRepository as unknown as Repository<AprLog>,
      tenantService as TenantService,
      documentStorageService as DocumentStorageService,
    );
    const aprWorkflowService = new AprWorkflowService(
      aprRepository as unknown as Repository<Apr>,
      aprLogsRepository as unknown as Repository<AprLog>,
      {
        find: jest.fn().mockResolvedValue([]),
        save: jest.fn(),
        create: jest.fn((p) => p),
      } as never,
      tenantService as TenantService,
      forensicTrailService as ForensicTrailService,
      {
        create: jest.fn().mockResolvedValue(undefined),
        notifyEligibleApprovers: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    service = new AprsService(
      aprRepository as unknown as Repository<Apr>,
      aprLogsRepository as unknown as Repository<AprLog>,
      tenantService as TenantService,
      riskCalculationService as RiskCalculationService,
      aprRiskMatrixService as unknown as AprRiskMatrixService,
      aprExcelService as unknown as AprExcelService,
      documentStorageService as DocumentStorageService,
      pdfService as PdfService,
      documentGovernanceService as DocumentGovernanceService,
      documentBundleService as unknown as DocumentBundleService,
      signaturesService as SignaturesService,
      forensicTrailService as ForensicTrailService,
      aprsPdfService,
      aprsEvidenceService,
      aprWorkflowService,
      cacheService as CacheService,
      metricsService as MetricsService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('incrementa métrica de negócio ao criar APR', async () => {
    const createdApr = {
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      elaborador_id: 'user-1',
      participants: [],
      risk_items: [],
    } as unknown as Apr;

    const serviceInternals = service as unknown as {
      validateRelatedEntityScope: (...args: unknown[]) => Promise<void>;
      syncRiskItems: (...args: unknown[]) => Promise<void>;
      addLog: (...args: unknown[]) => Promise<void>;
    };
    jest
      .spyOn(serviceInternals, 'validateRelatedEntityScope')
      .mockResolvedValue(undefined);
    jest.spyOn(serviceInternals, 'syncRiskItems').mockResolvedValue(undefined);
    jest.spyOn(serviceInternals, 'addLog').mockResolvedValue(undefined);
    jest.spyOn(service, 'findOne').mockResolvedValue(createdApr);

    aprRepository.manager.transaction.mockImplementation(
      async (
        callback: (manager: TransactionManagerMock) => Promise<unknown>,
      ) => {
        const aprRepo = {
          create: jest.fn(() => createdApr),
          findOne: jest.fn(() => Promise.resolve(null)),
          find: jest.fn(() => Promise.resolve([])),
          save: jest.fn(() => Promise.resolve(createdApr)),
          update: jest.fn(() => Promise.resolve(undefined)),
        };
        return Promise.resolve(
          callback({
            getRepository: jest.fn((_entity: RepositoryEntityName) => aprRepo),
            query: jest
              .fn<Promise<AprTransactionQueryRow[]>, [string, unknown[]?]>()
              .mockResolvedValue([]),
          }),
        );
      },
    );

    await service.create(
      {
        numero: 'APR-001',
        titulo: 'APR Teste',
        descricao: 'Teste',
        data_inicio: new Date('2026-03-24'),
        data_fim: new Date('2026-03-25'),
        site_id: 'site-1',
        elaborador_id: 'user-1',
        itens_risco: [],
        participants: [],
      } as never,
      'user-1',
    );

    expect(metricsService.incrementAprCreated).toHaveBeenCalledWith(
      'company-1',
      AprStatus.PENDENTE,
    );
  });

  it('não silencia falha de trilha crítica da APR', async () => {
    aprLogsRepository.save.mockRejectedValueOnce(
      new Error('audit unavailable'),
    );

    const serviceInternals = service as unknown as {
      addLog: (...args: unknown[]) => Promise<void>;
    };

    await expect(
      serviceInternals.addLog(
        'apr-1',
        'user-1',
        'APR_APROVADA',
        { status: AprStatus.APROVADA },
        { critical: true },
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  describe('is_modelo_padrao (modelo-padrão da empresa) — restrição de papel', () => {
    const callGuard = (roleNames?: Array<string | null | undefined>): void =>
      (
        service as unknown as {
          assertCanManageCompanyTemplate: (
            r?: Array<string | null | undefined>,
          ) => void;
        }
      ).assertCanManageCompanyTemplate(roleNames);

    it.each([
      ['Administrador Geral'],
      ['Administrador da Empresa'],
      ['Técnico de Segurança do Trabalho (TST)'],
    ])('permite papel privilegiado definir o modelo-padrão (%s)', (role) => {
      expect(() => callGuard([role])).not.toThrow();
    });

    it.each([
      // Variantes não-canônicas (aliases/acentos/maiúsculas) resolvidas via
      // normalizeRoleName — não devem bloquear admin legítimo.
      ['ADMIN_EMPRESA'],
      ['ADMINISTRADOR DA EMPRESA'],
      ['SUPER_ADMIN'],
      ['TECNICO SST'],
    ])('permite papel privilegiado em grafia divergente (%s)', (role) => {
      expect(() => callGuard([role])).not.toThrow();
    });

    it('permite quando profile.nome está vazio mas roles (RBAC) trazem papel privilegiado', () => {
      expect(() => callGuard(['', 'Administrador da Empresa'])).not.toThrow();
    });

    it.each([
      ['Supervisor / Encarregado'],
      ['Operador / Colaborador'],
      ['Trabalhador'],
      [''],
    ])('bloqueia papel operacional de definir o modelo-padrão (%s)', (role) => {
      expect(() => callGuard([role])).toThrow(ForbiddenException);
    });

    it('bloqueia quando não há nenhum sinal de papel (vazio/undefined/null)', () => {
      expect(() => callGuard([])).toThrow(ForbiddenException);
      expect(() => callGuard(undefined)).toThrow(ForbiddenException);
      expect(() => callGuard([undefined, null, ''])).toThrow(
        ForbiddenException,
      );
    });

    it('create() rejeita is_modelo_padrao=true vindo de papel operacional', async () => {
      await expect(
        service.create(
          {
            numero: 'APR-MODELO',
            titulo: 'APR Modelo',
            data_inicio: new Date('2026-03-24'),
            data_fim: new Date('2026-03-25'),
            site_id: 'site-1',
            elaborador_id: 'user-1',
            itens_risco: [],
            participants: [],
            is_modelo_padrao: true,
          } as never,
          'user-1',
          { roleNames: ['Operador / Colaborador'] },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('verifyFinalPdfPublic — isolamento por tenant do token', () => {
    it('escopa a leitura ao companyId do token via tenantService.run (RLS)', async () => {
      aprRepository.findOne.mockResolvedValueOnce({
        id: 'apr-1',
        numero: 'APR-001',
        titulo: 'APR Teste',
        status: AprStatus.APROVADA,
        versao: 1,
        verification_code: 'ABC123',
        final_pdf_hash_sha256: null,
        pdf_file_key: 'documents/company-9/apr/apr-1.pdf',
        pdf_generated_at: null,
        aprovado_em: null,
        company_id: 'company-9',
        company: { razao_social: 'ACME' },
        site: { nome: 'Obra 1' },
        approval_steps: [],
      } as unknown as ConfiguredApr);

      const result = await service.verifyFinalPdfPublic('ABC123', 'company-9');

      expect(result.valid).toBe(true);
      expect(tenantService.run).toHaveBeenCalledWith(
        { companyId: 'company-9', isSuperAdmin: false, siteScope: 'all' },
        expect.any(Function),
      );
    });

    it('não eleva contexto quando não há companyId (fail-closed sob RLS)', async () => {
      aprRepository.findOne.mockResolvedValueOnce(null);

      const result = await service.verifyFinalPdfPublic('ABC123');

      expect(result.valid).toBe(false);
      expect(tenantService.run).not.toHaveBeenCalled();
    });
  });

  it('bloqueia usuarios que nao pertencem a obra selecionada da APR', async () => {
    const userRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1),
    };
    const scopedRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest.fn().mockResolvedValue(0),
    };
    const manager = {
      getRepository: jest.fn((entity: RepositoryEntityName) =>
        entity.name === 'User' ? userRepository : scopedRepository,
      ),
    } as unknown as EntityManager;
    const serviceInternals = service as unknown as {
      validateRelatedEntityScope: (input: {
        manager: EntityManager;
        companyId: string;
        siteId: string;
        elaboradorId: string;
        participants: string[];
      }) => Promise<void>;
    };

    await expect(
      serviceInternals.validateRelatedEntityScope({
        manager,
        companyId: 'company-1',
        siteId: 'site-1',
        elaboradorId: 'user-1',
        participants: ['user-1', 'user-outra-obra'],
      }),
    ).rejects.toThrow(
      'Usuários do documento contém vínculo(s) inválido(s) para a obra/setor selecionada.',
    );
  });

  it('permite participante company-scoped em APR com obra selecionada', async () => {
    const userRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(2),
    };
    const scopedRepository = {
      exist: jest.fn().mockResolvedValue(true),
      count: jest.fn().mockResolvedValue(0),
    };
    const manager = {
      getRepository: jest.fn((entity: RepositoryEntityName) =>
        entity.name === 'User' ? userRepository : scopedRepository,
      ),
    } as unknown as EntityManager;
    const serviceInternals = service as unknown as {
      validateRelatedEntityScope: (input: {
        manager: EntityManager;
        companyId: string;
        siteId: string;
        elaboradorId: string;
        participants: string[];
      }) => Promise<void>;
    };

    await expect(
      serviceInternals.validateRelatedEntityScope({
        manager,
        companyId: 'company-1',
        siteId: 'site-1',
        elaboradorId: 'user-1',
        participants: ['user-1', 'user-company-scoped'],
      }),
    ).resolves.toBeUndefined();
  });

  it('lista APRs com filtros operacionais server-side e contexto mínimo para a fila', async () => {
    const rows = [
      {
        id: 'apr-1',
        numero: 'APR-001',
        titulo: 'APR Torre Norte',
        descricao: 'Montagem de estrutura',
        data_inicio: new Date('2026-03-20T00:00:00.000Z'),
        data_fim: new Date('2026-03-27T00:00:00.000Z'),
        status: AprStatus.PENDENTE,
        versao: 1,
        is_modelo: false,
        is_modelo_padrao: false,
        company_id: 'company-1',
        site_id: 'site-1',
        elaborador_id: 'user-1',
        auditado_por_id: null,
        aprovado_por_id: null,
        pdf_file_key: null,
        pdf_original_name: null,
        classificacao_resumo: {
          total: 1,
          aceitavel: 0,
          atencao: 0,
          substancial: 1,
          critico: 0,
        },
        created_at: new Date('2026-03-20T10:00:00.000Z'),
        updated_at: new Date('2026-03-26T12:00:00.000Z'),
        company: { id: 'company-1', razao_social: 'Empresa Teste' },
        site: { id: 'site-1', nome: 'Torre Norte' },
        elaborador: { id: 'user-1', nome: 'Ana Silva', funcao: 'TST' },
        auditado_por: null,
        aprovado_por: null,
      },
    ];

    const qb = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([rows, 1]),
    };

    aprRepository.createQueryBuilder.mockReturnValue(qb);

    const result = await service.findPaginated({
      page: 2,
      limit: 30,
      search: 'APR-001',
      status: AprStatus.PENDENTE,
      siteId: 'site-1',
      responsibleId: 'user-1',
      dueFilter: 'next-7-days',
      sort: 'deadline-asc',
    });

    expect(aprRepository.createQueryBuilder).toHaveBeenCalledWith('apr');
    expect(qb.leftJoin).toHaveBeenCalledWith('apr.site', 'site');
    expect(qb.leftJoin).toHaveBeenCalledWith('apr.elaborador', 'elaborador');
    expect(qb.where).toHaveBeenCalledWith('apr.company_id = :companyId', {
      companyId: 'company-1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('apr.numero ILIKE :search'),
      { search: '%APR-001%' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('apr.status = :status', {
      status: AprStatus.PENDENTE,
    });
    expect(qb.andWhere).toHaveBeenCalledWith('apr.site_id = :siteId', {
      siteId: 'site-1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('CASE'),
      expect.objectContaining({
        responsibleId: 'user-1',
        approvedStates: [AprStatus.APROVADA, AprStatus.ENCERRADA],
      }),
    );
    expect(qb.andWhere).toHaveBeenCalledWith(
      "apr.data_fim >= CURRENT_DATE AND apr.data_fim <= CURRENT_DATE + INTERVAL '7 days'",
    );
    expect(qb.orderBy).toHaveBeenCalledWith(
      'apr.data_fim',
      'ASC',
      'NULLS LAST',
    );
    expect(result.total).toBe(1);
    expect(result.page).toBe(2);
    expect(result.limit).toBe(30);
    expect(result.data[0]).toMatchObject({
      id: 'apr-1',
      site: { nome: 'Torre Norte' },
      elaborador: { nome: 'Ana Silva' },
      updated_at: new Date('2026-03-26T12:00:00.000Z'),
    });
  });

  it('materializa a ordenacao priority em alias antes de paginar', async () => {
    const qb = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    aprRepository.createQueryBuilder.mockReturnValue(qb);

    await service.findPaginated({
      page: 1,
      limit: 20,
      sort: 'priority',
    });

    // Regressão GDPR: APRs soft-deletadas (ex.: titular anonimizado) não
    // podem aparecer na listagem nem contar no total.
    expect(qb.andWhere).toHaveBeenCalledWith('apr.deleted_at IS NULL');
    expect(qb.addSelect).toHaveBeenCalledWith(
      expect.stringContaining("WHEN apr.status = 'Pendente'"),
      'apr_priority_order',
    );
    expect(qb.orderBy).toHaveBeenCalledWith('apr_priority_order', 'ASC');
    expect(qb.addOrderBy).toHaveBeenCalledWith(
      'apr.data_fim',
      'ASC',
      'NULLS LAST',
    );
    expect(qb.addOrderBy).toHaveBeenCalledWith('apr.updated_at', 'DESC');
  });

  it('rejeita search malformado em vez de cair em 500', async () => {
    const qb = {
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn(),
    };

    aprRepository.createQueryBuilder.mockReturnValue(qb);

    await expect(
      service.findPaginated({
        page: 1,
        limit: 20,
        search: ['forged'] as unknown as string,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(qb.getManyAndCount).not.toHaveBeenCalled();
  });

  it('bloqueia anexo manual de PDF final da APR pela esteira descontinuada', async () => {
    const apr = {
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'APR Torre',
      numero: 'APR-001',
      data_inicio: new Date('2026-03-14T10:00:00.000Z'),
      created_at: new Date('2026-03-14T09:00:00.000Z'),
      status: AprStatus.APROVADA,
      pdf_file_key: null,
      is_modelo: false,
      participants: [{ id: 'user-1' }],
    } as unknown as Apr;
    const update = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ update })),
    };
    aprRepository.findOne
      .mockResolvedValueOnce(apr)
      .mockResolvedValueOnce(apr)
      .mockResolvedValueOnce({
        ...apr,
        pdf_file_key: 'documents/company-1/aprs/apr-1/APR-001_v1.pdf',
        pdf_folder_path: 'aprs/company-1',
        pdf_original_name: 'APR-001_v1.pdf',
      });
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(
        manager as unknown as EntityManager,
        'hash-1',
      );
      return { hash: 'hash-1', registryEntry: { id: 'registry-1' } };
    });

    const file = {
      originalname: 'apr-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-apr'),
    } as Express.Multer.File;

    await expect(service.attachPdf('apr-1', file, 'user-1')).rejects.toThrow(
      'Anexo manual de PDF final descontinuado para APR apr-1.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(
      documentGovernanceService.registerFinalDocument,
    ).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('gera o PDF final oficial da APR no backend e registra o documento governado', async () => {
    const apr = {
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'APR Torre',
      numero: 'APR-001',
      data_inicio: new Date('2026-03-14T10:00:00.000Z'),
      data_fim: new Date('2026-03-20T10:00:00.000Z'),
      created_at: new Date('2026-03-14T09:00:00.000Z'),
      updated_at: new Date('2026-03-14T09:30:00.000Z'),
      status: AprStatus.APROVADA,
      pdf_file_key: null,
      is_modelo: false,
      participants: [{ id: 'user-1', nome: 'Maria' }],
      company: { razao_social: 'Empresa Teste', cnpj: '00.000.000/0001-00' },
      site: { nome: 'Obra Centro' },
      elaborador: { nome: 'Maria' },
      risk_items: [
        {
          id: 'risk-1',
          ordem: 0,
          atividade: 'Montagem',
          agente_ambiental: 'Ruído',
          condicao_perigosa: 'Altura',
          fonte_circunstancia: 'Plataforma',
          lesao: 'Fratura',
          probabilidade: 2,
          severidade: 3,
          score_risco: 6,
          categoria_risco: 'Substancial',
          prioridade: 'Prioridade preferencial',
          medidas_prevencao: 'Linha de vida',
          responsavel: 'Supervisor',
          prazo: new Date('2026-03-20T00:00:00.000Z'),
          status_acao: 'Aberta',
        },
      ],
    } as unknown as Apr;
    const update = jest.fn();
    const manager = {
      getRepository: jest.fn((entity: { name?: string }) => {
        if (entity?.name === 'Apr') {
          return { update };
        }
        return {
          find: jest.fn().mockResolvedValue([]),
        };
      }),
    };
    aprRepository.findOne
      .mockResolvedValueOnce(apr)
      .mockResolvedValueOnce(apr)
      .mockResolvedValueOnce(null) // supersedingRow check — no superseding APR
      .mockResolvedValueOnce({
        ...apr,
        pdf_file_key: 'documents/company-1/aprs/apr-1/APR-001_v1.pdf',
        pdf_folder_path: 'aprs/company-1',
        pdf_original_name: 'APR-001_v1.pdf',
      });
    (aprRepository as unknown as { manager: unknown }).manager = manager;
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockImplementation(async (input: RegisterFinalDocumentInput) => {
      await input.persistEntityMetadata?.(manager as never, 'hash-1');
      return { hash: 'hash-1', registryEntry: { id: 'registry-1' } };
    });

    await expect(service.generateFinalPdf('apr-1', 'user-1')).resolves.toEqual(
      expect.objectContaining({
        entityId: 'apr-1',
        generated: true,
        hasFinalPdf: true,
      }),
    );

    expect(pdfService.generateFromHtml).toHaveBeenCalledWith(
      expect.stringContaining('ANÁLISE PRELIMINAR DE RISCOS'),
      expect.any(Object),
    );
    expect(documentStorageService.uploadFile).toHaveBeenCalledWith(
      expect.stringContaining('/aprs/apr-1/'),
      expect.any(Buffer),
      'application/pdf',
    );
    expect(
      documentGovernanceService.registerFinalDocument,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'apr',
        entityId: 'apr-1',
        createdBy: 'user-1',
      }),
    );
  });

  it('bloqueia anexo final quando a APR ainda nao foi aprovada', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'APR Torre',
      numero: 'APR-001',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
      is_modelo: false,
      participants: [{ id: 'user-1' }],
    });

    const file = {
      originalname: 'apr-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-apr'),
    } as Express.Multer.File;

    await expect(service.attachPdf('apr-1', file, 'user-1')).rejects.toThrow(
      'Anexo manual de PDF final descontinuado para APR apr-1.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('remove a APR via esteira central e aplica a policy de lifecycle', async () => {
    const apr = {
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    } as unknown as Apr;
    const softDelete = jest.fn();
    const manager = {
      getRepository: jest.fn(() => ({ softDelete })),
    };
    aprRepository.findOne.mockResolvedValue(apr);
    (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mockImplementation(async (input: RemoveFinalDocumentReferenceInput) => {
      await input.removeEntityState?.(manager as unknown as EntityManager);
    });

    await expect(service.remove('apr-1', 'user-1')).resolves.toBeUndefined();

    const [removeInput] = (
      documentGovernanceService.removeFinalDocumentReference as jest.Mock
    ).mock.calls[0] as [RemoveFinalDocumentReferenceInput];
    expect(removeInput.companyId).toBe('company-1');
    expect(removeInput.module).toBe('apr');
    expect(removeInput.entityId).toBe('apr-1');
    expect(removeInput.trailEventType).toBe(
      FORENSIC_EVENT_TYPES.FINAL_DOCUMENT_REMOVED,
    );
    expect(removeInput.trailMetadata).toEqual({ removalMode: 'soft_delete' });
    expect(typeof removeInput.removeEntityState).toBe('function');
    expect(softDelete).toHaveBeenCalledWith('apr-1');
  });

  it('bloqueia remocao quando a APR ja saiu do estado pendente', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: null,
    });

    await expect(service.remove('apr-1', 'user-1')).rejects.toThrow(
      /Somente APRs pendentes e sem PDF final podem ser removidas\./,
    );
  });

  it('não faz upload nem rollback de storage no fluxo manual descontinuado', async () => {
    const apr = {
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'APR Torre',
      numero: 'APR-001',
      data_inicio: new Date('2026-03-14T10:00:00.000Z'),
      created_at: new Date('2026-03-14T09:00:00.000Z'),
      status: AprStatus.APROVADA,
      pdf_file_key: null,
      is_modelo: false,
      participants: [{ id: 'user-1' }],
    } as unknown as Apr;
    aprRepository.findOne.mockResolvedValue(apr);
    (
      documentGovernanceService.registerFinalDocument as jest.Mock
    ).mockRejectedValue(new Error('governance failed'));

    const file = {
      originalname: 'apr-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-apr'),
    } as Express.Multer.File;

    await expect(service.attachPdf('apr-1', file, 'user-1')).rejects.toThrow(
      'Anexo manual de PDF final descontinuado para APR apr-1.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
    expect(documentStorageService.deleteFile).not.toHaveBeenCalled();
  });

  it('bloqueia anexo final quando faltam assinaturas dos participantes', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      site_id: 'site-1',
      titulo: 'APR Torre',
      numero: 'APR-001',
      data_inicio: new Date('2026-03-14T10:00:00.000Z'),
      created_at: new Date('2026-03-14T09:00:00.000Z'),
      status: AprStatus.APROVADA,
      pdf_file_key: null,
      is_modelo: false,
      participants: [{ id: 'user-1' }, { id: 'user-2' }],
    });
    (signaturesService.findByDocument as jest.Mock).mockResolvedValue([
      { user_id: 'user-1' },
    ]);

    const file = {
      originalname: 'apr-final.pdf',
      mimetype: 'application/pdf',
      buffer: Buffer.from('%PDF-apr'),
    } as Express.Multer.File;

    await expect(service.attachPdf('apr-1', file, 'user-1')).rejects.toThrow(
      'Anexo manual de PDF final descontinuado para APR apr-1.',
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('bloqueia alteracao de status via endpoint update (bypass de workflow)', async () => {
    await expect(
      service.update('apr-1', { status: 'Aprovada' } as never),
    ).rejects.toThrow(
      'Use os endpoints /approve, /reject ou /finalize para alterar o status da APR.',
    );

    expect(aprRepository.findOne).not.toHaveBeenCalled();
  });

  it('bloqueia update comum quando a APR ja esta aprovada, mesmo sem PDF final', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: null,
    });

    await expect(
      service.update(
        'apr-1',
        {
          titulo: 'APR revisada fora do fluxo oficial',
        },
        'user-1',
      ),
    ).rejects.toThrow(
      /Somente APRs pendentes podem ser editadas pelo formulário\./,
    );
  });

  it('registra cancelamento da APR na trilha imutável', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });

    await expect(
      service.reject('apr-1', 'user-1', 'Risco não aceito', {
        roleName: 'Técnico de Segurança do Trabalho (TST)',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'apr-1',
        status: AprStatus.CANCELADA,
      }),
    );

    const appendCalls = (forensicTrailService.append as jest.Mock).mock
      .calls as Array<[AppendForensicTrailEventInput, { manager?: unknown }]>;
    const firstAppendCall = appendCalls[0];
    if (!firstAppendCall) {
      throw new Error('Expected forensic append call');
    }
    const [appendInput, appendOptions] = firstAppendCall;
    const appendMetadata = appendInput.metadata as Record<string, unknown>;
    expect(appendInput.eventType).toBe(FORENSIC_EVENT_TYPES.DOCUMENT_CANCELED);
    expect(appendInput.module).toBe('apr');
    expect(appendInput.entityId).toBe('apr-1');
    expect(appendInput.companyId).toBe('company-1');
    expect(appendInput.userId).toBe('user-1');
    expect(appendMetadata.previousStatus).toBe(AprStatus.PENDENTE);
    expect(appendMetadata.currentStatus).toBe(AprStatus.CANCELADA);
    expect(appendMetadata.reason).toBe('Risco não aceito');
    expect(appendOptions.manager).toBeDefined();
  });

  it('aprova APR pelo pipeline de escrita com apenas as relações necessárias', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-approve-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
      data_inicio: new Date('2026-03-20T00:00:00.000Z'),
      data_fim: new Date('2026-03-21T00:00:00.000Z'),
      participants: [{ id: 'user-1' }],
      risk_items: [
        {
          id: 'risk-1',
          ordem: 0,
          atividade: 'Montagem',
          agente_ambiental: 'Ruído',
          condicao_perigosa: 'Altura',
          fonte_circunstancia: 'Plataforma',
          lesao: 'Fratura',
          probabilidade: 2,
          severidade: 3,
          score_risco: 6,
          categoria_risco: 'Substancial',
          prioridade: 'Prioridade preferencial',
          medidas_prevencao: 'Linha de vida',
          responsavel: 'Supervisor',
          prazo: null,
          status_acao: 'Aberta',
        },
      ],
    } as unknown as Apr);

    const result = await service.approve(
      'apr-approve-1',
      'user-1',
      'Aprovacao controlada',
      { roleName: 'Técnico de Segurança do Trabalho (TST)' },
    );

    expect(aprRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'apr-approve-1',
        status: AprStatus.APROVADA,
        aprovado_por_id: 'user-1',
        aprovado_motivo: 'Aprovacao controlada',
      }),
    );
    expect(result.status).toBe(AprStatus.APROVADA);
    expect(aprLogsRepository.save).toHaveBeenCalled();
  });

  it('encerra APR pelo pipeline de escrita mínimo sem eager-load genérico', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-finalize-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: 'documents/company-1/aprs/apr-finalize-1/apr-final.pdf',
      final_pdf_hash_sha256: 'a'.repeat(64),
      verification_code: 'APR-FINALIZE-1',
      pdf_generated_at: new Date('2026-03-24T10:00:00.000Z'),
    });

    const result = await service.finalize('apr-finalize-1', 'user-1');

    expect(aprRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'apr-finalize-1',
        status: AprStatus.ENCERRADA,
      }),
    );
    expect(result.status).toBe(AprStatus.ENCERRADA);
    expect(aprLogsRepository.save).toHaveBeenCalled();
  });

  it('bloqueia criacao de nova versao quando APR nao esta aprovada', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      numero: 'APR-001',
      versao: 1,
      pdf_file_key: null,
    });

    await expect(service.createNewVersion('apr-1', 'user-1')).rejects.toThrow(
      'Somente APRs Aprovadas podem gerar nova versão.',
    );
  });

  it('compara duas versões da mesma APR com resumo de adições, remoções e mudanças', async () => {
    aprRepository.findOne.mockImplementation((input?: AprFindOneArgs) => {
      const where = input?.where;
      if (where?.id === 'apr-base') {
        return Promise.resolve({
          id: 'apr-base',
          numero: 'APR-001',
          versao: 1,
          status: AprStatus.PENDENTE,
          parent_apr_id: null,
          company_id: 'company-1',
          risk_items: [
            {
              id: 'risk-1',
              ordem: 0,
              atividade: 'Montagem',
              agente_ambiental: 'Ruído',
              condicao_perigosa: 'Altura',
              fonte_circunstancia: 'Plataforma',
              lesao: 'Fratura',
              probabilidade: 2,
              severidade: 3,
              score_risco: 6,
              categoria_risco: 'Substancial',
              prioridade: 'Prioridade preferencial',
              medidas_prevencao: 'Linha de vida',
              responsavel: 'Supervisor',
              prazo: new Date('2026-03-20T00:00:00.000Z'),
              status_acao: 'Aberta',
            },
          ],
        } as unknown as Apr);
      }

      if (where?.id === 'apr-target') {
        return Promise.resolve({
          id: 'apr-target',
          numero: 'APR-001-v2',
          versao: 2,
          status: AprStatus.PENDENTE,
          parent_apr_id: 'apr-base',
          company_id: 'company-1',
          risk_items: [
            {
              id: 'risk-2',
              ordem: 0,
              atividade: 'Montagem',
              agente_ambiental: 'Ruído',
              condicao_perigosa: 'Altura',
              fonte_circunstancia: 'Plataforma',
              lesao: 'Fratura',
              probabilidade: 3,
              severidade: 3,
              score_risco: 9,
              categoria_risco: 'Crítico',
              prioridade: 'Prioridade máxima',
              medidas_prevencao: 'Linha de vida reforçada',
              responsavel: 'Supervisor',
              prazo: new Date('2026-03-21T00:00:00.000Z'),
              status_acao: 'Em andamento',
            },
            {
              id: 'risk-3',
              ordem: 1,
              atividade: 'Içamento',
              agente_ambiental: 'Carga suspensa',
              condicao_perigosa: 'Movimentação',
              fonte_circunstancia: 'Grua',
              lesao: 'Trauma',
              probabilidade: 2,
              severidade: 2,
              score_risco: 4,
              categoria_risco: 'Atenção',
              prioridade: 'Prioridade básica',
              medidas_prevencao: 'Área isolada',
              responsavel: 'TST',
              prazo: new Date('2026-03-22T00:00:00.000Z'),
              status_acao: 'Aberta',
            },
          ],
        } as unknown as Apr);
      }

      return Promise.resolve(null);
    });

    const result = await service.compareVersions('apr-base', 'apr-target');

    expect(result).toMatchObject({
      summary: {
        totalBase: 1,
        totalTarget: 2,
        added: 1,
        removed: 0,
        changed: 1,
      },
      added: [
        expect.objectContaining({
          atividade_processo: 'Içamento',
        }),
      ],
    });

    expect(result.changed[0]).toMatchObject({
      index: 0,
    });
    expect(result.changed[0]?.changedFields).toEqual(
      expect.arrayContaining([
        'probabilidade',
        'categoria_risco',
        'medidas_prevencao',
      ]),
    );
  });

  it('retorna contrato explicito quando a APR ainda nao possui PDF final', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      pdf_file_key: null,
      pdf_folder_path: null,
      pdf_original_name: null,
    } as unknown as Apr);

    await expect(service.getPdfAccess('apr-1')).resolves.toEqual({
      entityId: 'apr-1',
      hasFinalPdf: false,
      availability: 'not_emitted',
      message: 'A APR ainda não possui PDF final emitido.',
      originalName: null,
      contentType: null,
      expiresAt: null,
      url: null,
    });
  });

  it('lista evidencias da APR com URLs assinadas quando disponiveis', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'evidence-1',
        apr_id: 'apr-1',
        apr_risk_item_id: 'risk-1',
        uploaded_by_id: 'user-1',
        uploaded_by: { nome: 'Carlos' },
        file_key: 'documents/company-1/aprs/apr-1/evidence-1.jpg',
        original_name: 'evidence-1.jpg',
        mime_type: 'image/jpeg',
        file_size_bytes: 1024,
        hash_sha256: 'hash-1',
        watermarked_file_key:
          'documents/company-1/aprs/apr-1/evidence-1-watermarked.jpg',
        watermarked_hash_sha256: 'hash-watermarked-1',
        watermark_text: 'APR-001',
        captured_at: new Date('2026-03-16T10:00:00.000Z'),
        uploaded_at: new Date('2026-03-16T10:05:00.000Z'),
        latitude: '-23.5505',
        longitude: '-46.6333',
        accuracy_m: '5.4',
        device_id: 'device-1',
        ip_address: '127.0.0.1',
        exif_datetime: new Date('2026-03-16T09:59:00.000Z'),
        integrity_flags: { gps: true },
        apr_risk_item: { ordem: 3 },
      },
    ]);
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
    });
    (aprRepository as unknown as { manager: unknown }).manager = {
      getRepository: jest.fn(() => ({ find })),
    };

    const result = (await service.listAprEvidences('apr-1')) as Array<{
      id: string;
      uploaded_by_name?: string;
      risk_item_ordem?: number;
      url?: string;
      watermarked_url?: string;
    }>;

    expect(find).toHaveBeenCalledWith({
      where: { apr_id: 'apr-1' },
      relations: ['apr_risk_item', 'uploaded_by'],
      order: { uploaded_at: 'DESC' },
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'evidence-1',
      uploaded_by_name: 'Carlos',
      risk_item_ordem: 3,
    });
    expect(result[0]).not.toHaveProperty('file_key');
    expect(result[0]).not.toHaveProperty('latitude');
    expect(result[0]?.url).toContain('documents%2Fcompany-1%2Faprs');
    expect(result[0]?.watermarked_url).toContain('watermarked');
  });

  it('salva evidencias fotograficas da APR no storage e registra o hash', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      elaborador_id: 'user-1',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });

    const riskItemRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'risk-1',
        apr_id: 'apr-1',
        ordem: 0,
      }),
    };
    const save = jest.fn((input: EvidenceRepositoryInput) =>
      Promise.resolve({
        ...input,
        id: 'evidence-1',
      }),
    );
    const evidenceRepository = {
      create: jest.fn((input: EvidenceRepositoryInput) => input),
      save,
    };
    (aprRepository as unknown as { manager: unknown }).manager = {
      getRepository: jest.fn((entity: RepositoryEntityName) => {
        if (entity.name === 'AprRiskItem') return riskItemRepository;
        return evidenceRepository;
      }),
    };

    const file = {
      originalname: 'evidence.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]),
      size: 5,
    } as Express.Multer.File;

    const result = await service.uploadRiskEvidence(
      'apr-1',
      'risk-1',
      file,
      {
        captured_at: '2026-03-16T10:00:00.000Z',
        latitude: -23.55,
        longitude: -46.63,
        accuracy_m: 4.2,
        device_id: 'pixel',
      },
      'user-1',
      '127.0.0.1',
    );

    expect(result).toMatchObject({
      id: 'evidence-1',
      originalName: 'evidence.jpg',
    });
    expect(result).not.toHaveProperty('fileKey');
    expect(typeof result.hashSha256).toBe('string');
    expect(result.hashSha256).toBeTruthy();

    expect(documentStorageService.uploadFile).toHaveBeenCalledWith(
      'documents/company-1/aprs/apr-1/apr-final.pdf',
      file.buffer,
      'image/jpeg',
    );
    expect(evidenceRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        apr_id: 'apr-1',
        apr_risk_item_id: 'risk-1',
        uploaded_by_id: 'user-1',
        file_key: 'documents/company-1/aprs/apr-1/apr-final.pdf',
        original_name: 'evidence.jpg',
        mime_type: 'image/jpeg',
        file_size_bytes: 5,
        ip_address: '127.0.0.0', // /24 mascarado por maskIpAddress
      }),
    );
  });

  it('bloqueia upload de evidencia quando a APR ja esta aprovada, mesmo sem PDF final', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: null,
    });

    const file = {
      originalname: 'evidence.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00]),
      size: 5,
    } as Express.Multer.File;

    await expect(
      service.uploadRiskEvidence(
        'apr-1',
        'risk-1',
        file,
        {},
        'user-1',
        '127.0.0.1',
      ),
    ).rejects.toThrow(
      /Somente APRs pendentes podem ser editadas pelo formulário\./,
    );

    expect(documentStorageService.uploadFile).not.toHaveBeenCalled();
  });

  it('bloqueia cancelamento quando a APR ja possui PDF final emitido', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: 'documents/company-1/aprs/apr-1/apr-final.pdf',
      final_pdf_hash_sha256: 'a'.repeat(64),
      verification_code: 'APR-ABC123',
      pdf_generated_at: new Date('2026-03-24T10:00:00.000Z'),
    });

    await expect(
      service.reject('apr-1', 'user-1', 'Cancelamento tardio'),
    ).rejects.toThrow(
      /APR com PDF final emitido está bloqueada para mudança de status\./,
    );
  });

  it('delega encerramento para o workflow e retorna APR atualizada', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: 'documents/company-1/aprs/apr-1/apr-final.pdf',
      final_pdf_hash_sha256: 'a'.repeat(64),
      verification_code: 'APR-ABC123',
      pdf_generated_at: new Date('2026-03-24T10:00:00.000Z'),
    });

    await expect(service.finalize('apr-1', 'user-1')).resolves.toEqual(
      expect.objectContaining({
        id: 'apr-1',
        status: AprStatus.ENCERRADA,
      }),
    );
  });

  // ─── findOne ───────────────────────────────────────────────────────────────

  it('findOne lança NotFoundException quando a APR não existe', async () => {
    aprRepository.findOne.mockResolvedValue(null);

    await expect(service.findOne('apr-inexistente')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.findOne('apr-inexistente')).rejects.toThrow(
      'APR com ID apr-inexistente não encontrada',
    );
  });

  it('findOne retorna a APR com as relações solicitadas quando encontrada', async () => {
    const apr = {
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      risk_items: [],
      itens_risco: [],
      participants: [],
    } as unknown as Apr;
    aprRepository.findOne.mockResolvedValue(apr);

    const result = await service.findOne('apr-1');

    expect(result.id).toBe('apr-1');
    expect(aprRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        relations: expect.arrayContaining([
          'company',
          'site',
          'risk_items',
          'participants',
          'approval_steps',
        ]),
      }),
    );
  });

  // ─── update — detecção de conflito otimista ───────────────────────────────

  it('update lança ConflictException quando o timestamp de guarda está desatualizado em mais de 1 segundo', async () => {
    const updatedAt = new Date('2026-01-01T10:00:00.000Z');
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
      updated_at: updatedAt,
    });

    await expect(
      service.update('apr-1', {
        _conflict_guard_updated_at: '2026-01-01T09:00:00.000Z',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('update não lança ConflictException quando o timestamp de guarda está dentro da tolerância de 1 segundo', async () => {
    const updatedAt = new Date('2026-01-01T10:00:00.500Z');
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
      updated_at: updatedAt,
      risk_items: [],
      itens_risco: [],
      participants: [],
    });

    aprRepository.manager.query.mockResolvedValue([]);

    await expect(
      service.update(
        'apr-1',
        {
          _conflict_guard_updated_at: '2026-01-01T10:00:00.200Z',
          titulo: 'APR Atualizada',
        },
        'user-1',
      ),
    ).resolves.toBeDefined();
  });

  // ─── getLogs ───────────────────────────────────────────────────────────────

  it('getLogs lança NotFoundException quando a APR não existe', async () => {
    aprRepository.findOne.mockResolvedValue(null);

    await expect(service.getLogs('apr-inexistente')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('getLogs retorna logs ordenados por data_hora DESC', async () => {
    const logs = [
      { id: 'log-2', apr_id: 'apr-1', data_hora: new Date('2026-03-02') },
      { id: 'log-1', apr_id: 'apr-1', data_hora: new Date('2026-03-01') },
    ] as unknown as AprLog[];

    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.PENDENTE,
      pdf_file_key: null,
    });
    (
      aprLogsRepository as unknown as { find: jest.Mock }
    ).find.mockResolvedValue(logs);

    const result = await service.getLogs('apr-1');

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('log-2');
    expect(
      (aprLogsRepository as unknown as { find: jest.Mock }).find,
    ).toHaveBeenCalledWith({
      where: { apr_id: 'apr-1' },
      order: { data_hora: 'DESC' },
    });
  });

  // ─── getVersionHistory ─────────────────────────────────────────────────────

  it('getVersionHistory lança InternalServerErrorException quando tenant está ausente', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-1',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: null,
      parent_apr_id: null,
    });
    // buildAprWhere usa o contexto completo; aqui simulamos perda do tenant
    // no passo seguinte de carregamento do historico.
    (tenantService.getTenantId as jest.Mock).mockReturnValue(null);

    await expect(service.getVersionHistory('apr-1')).rejects.toThrow(
      'Tenant context ausente em consulta de APR (getVersionHistory)',
    );
  });

  it('getVersionHistory retorna todas as versões da cadeia documental ordenadas por versao ASC', async () => {
    aprRepository.findOne.mockResolvedValue({
      id: 'apr-root',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      pdf_file_key: null,
      parent_apr_id: null,
    });

    const versions = [
      { id: 'apr-root', versao: 1, parent_apr_id: null },
      { id: 'apr-v2', versao: 2, parent_apr_id: 'apr-root' },
    ] as unknown as Apr[];

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(versions),
    };
    aprRepository.createQueryBuilder.mockReturnValue(qb);

    const result = await service.getVersionHistory('apr-root');

    expect(result).toHaveLength(2);
    expect(result[0]?.versao).toBe(1);
    expect(qb.where).toHaveBeenCalledWith(
      '(apr.id = :rootId OR apr.parent_apr_id = :rootId)',
      { rootId: 'apr-root' },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('apr.company_id = :tenantId', {
      tenantId: 'company-1',
    });
    expect(qb.orderBy).toHaveBeenCalledWith('apr.versao', 'ASC');
  });

  // ─── getAnalyticsOverview ──────────────────────────────────────────────────

  it('getAnalyticsOverview lança InternalServerErrorException quando tenant está ausente', async () => {
    (tenantService.getTenantId as jest.Mock).mockReturnValue(null);

    await expect(service.getAnalyticsOverview()).rejects.toThrow(
      InternalServerErrorException,
    );
    await expect(service.getAnalyticsOverview()).rejects.toThrow(
      'Tenant context ausente em consulta de APR (analytics)',
    );
  });

  it('getAnalyticsOverview retorna contagens agregadas por status e score médio de risco', async () => {
    (aprRepository as unknown as { count: jest.Mock }).count = jest
      .fn()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(6);

    const riskQb = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ avg: '7.5', criticos: '3' }),
    };
    aprRepository.createQueryBuilder.mockReturnValue(riskQb);

    const result = await service.getAnalyticsOverview();

    expect(result.totalAprs).toBe(10);
    expect(result.aprovadas).toBe(4);
    expect(result.pendentes).toBe(6);
    expect(result.riscosCriticos).toBe(3);
    expect(result.mediaScoreRisco).toBe(8);
  });

  it('getAnalyticsOverview delega ao cache e evita consulta dupla ao banco', async () => {
    const cached = {
      totalAprs: 5,
      aprovadas: 2,
      pendentes: 3,
      riscosCriticos: 1,
      mediaScoreRisco: 6,
    };
    (cacheService.getOrSet as jest.Mock).mockResolvedValueOnce(cached);

    const result = await service.getAnalyticsOverview();

    expect(result).toEqual(cached);
    expect(aprRepository.createQueryBuilder).not.toHaveBeenCalled();
  });

  // ─── validateCompliance ────────────────────────────────────────────────────

  it('validateCompliance retorna isValid=true e score=100 quando o motor de regras não está configurado', async () => {
    (aprRepository as unknown as { findOneOrFail: jest.Mock }).findOneOrFail =
      jest.fn().mockResolvedValue({
        id: 'apr-1',
        company_id: 'company-1',
        risk_items: [],
      });

    const result = await service.validateCompliance('apr-1');

    expect(result.isValid).toBe(true);
    expect(result.score).toBe(100);
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.appliedRuleSnapshot).toBe('[]');
  });

  // ─── createNewVersion ──────────────────────────────────────────────────────

  it('cria nova versão com número incrementado, status PENDENTE e parent_apr_id apontando para a raiz', async () => {
    const original = {
      id: 'apr-root',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      numero: 'APR-001',
      versao: 1,
      parent_apr_id: null,
      titulo: 'APR Teste',
      descricao: 'Descrição',
      tipo_atividade: null,
      frente_trabalho: null,
      area_risco: null,
      turno: null,
      local_execucao_detalhado: null,
      responsavel_tecnico_nome: 'Eng. Silva',
      responsavel_tecnico_registro: null,
      data_inicio: new Date('2026-03-01'),
      data_fim: new Date('2026-03-31'),
      is_modelo: false,
      is_modelo_padrao: false,
      probability: null,
      severity: null,
      exposure: null,
      initial_risk: null,
      residual_risk: null,
      control_description: null,
      control_evidence: null,
      itens_risco: [],
      classificacao_resumo: null,
      activities: [],
      risks: [],
      epis: [],
      tools: [],
      machines: [],
      participants: [{ id: 'user-1' }],
      risk_items: [],
    } as unknown as Apr;

    const newVersion = {
      ...original,
      id: 'apr-v2',
      versao: 2,
      parent_apr_id: 'apr-root',
      status: AprStatus.PENDENTE,
      numero: 'APR-001-v2',
      elaborador_id: 'user-1',
    } as unknown as Apr;

    jest
      .spyOn(service, 'findOne')
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(newVersion);

    const versionQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: '1' }),
    };
    aprRepository.createQueryBuilder.mockReturnValue(versionQb);

    (aprRepository as unknown as { create: jest.Mock }).create = jest.fn(
      (input: Partial<Apr>) => ({ ...input, id: 'apr-v2' }) as unknown as Apr,
    );

    jest
      .spyOn(
        service['aprsPdfService'] as Pick<
          AprsPdfService,
          'regeneratePdfWithSupersededWatermark'
        >,
        'regeneratePdfWithSupersededWatermark',
      )
      .mockResolvedValue(undefined);

    const result = await service.createNewVersion('apr-root', 'user-1');

    expect(result.versao).toBe(2);
    expect(result.parent_apr_id).toBe('apr-root');
    expect(result.status).toBe(AprStatus.PENDENTE);
    expect(result.numero).toBe('APR-001-v2');
    expect(result.elaborador_id).toBe('user-1');
    expect(aprRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        versao: 2,
        parent_apr_id: 'apr-root',
        status: AprStatus.PENDENTE,
      }),
    );
  });

  it('cria nova versão usando MAX da cadeia quando já existem versões superiores', async () => {
    const original = {
      id: 'apr-root',
      company_id: 'company-1',
      status: AprStatus.APROVADA,
      numero: 'APR-002',
      versao: 1,
      parent_apr_id: null,
      titulo: 'APR Multi-versão',
      descricao: null,
      tipo_atividade: null,
      frente_trabalho: null,
      area_risco: null,
      turno: null,
      local_execucao_detalhado: null,
      responsavel_tecnico_nome: 'Eng. Santos',
      responsavel_tecnico_registro: null,
      data_inicio: new Date('2026-04-01'),
      data_fim: new Date('2026-04-30'),
      is_modelo: false,
      is_modelo_padrao: false,
      probability: null,
      severity: null,
      exposure: null,
      initial_risk: null,
      residual_risk: null,
      control_description: null,
      control_evidence: null,
      itens_risco: [],
      classificacao_resumo: null,
      activities: [],
      risks: [],
      epis: [],
      tools: [],
      machines: [],
      participants: [],
      risk_items: [],
    } as unknown as Apr;

    const newVersionV4 = {
      ...original,
      id: 'apr-v4',
      versao: 4,
      parent_apr_id: 'apr-root',
      status: AprStatus.PENDENTE,
      numero: 'APR-002-v4',
      elaborador_id: 'user-2',
    } as unknown as Apr;

    jest
      .spyOn(service, 'findOne')
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(newVersionV4);

    const versionQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: '3' }),
    };
    aprRepository.createQueryBuilder.mockReturnValue(versionQb);

    (aprRepository as unknown as { create: jest.Mock }).create = jest.fn(
      (input: Partial<Apr>) => ({ ...input, id: 'apr-v4' }) as unknown as Apr,
    );

    jest
      .spyOn(
        service['aprsPdfService'] as Pick<
          AprsPdfService,
          'regeneratePdfWithSupersededWatermark'
        >,
        'regeneratePdfWithSupersededWatermark',
      )
      .mockResolvedValue(undefined);

    const result = await service.createNewVersion('apr-root', 'user-2');

    expect(result.versao).toBe(4);
    expect(result.numero).toBe('APR-002-v4');
  });
});
