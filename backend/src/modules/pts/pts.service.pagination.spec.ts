import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PtsService } from './pts.service';
import { Pt } from './entities/pt.entity';
import { Company } from '../companies/entities/company.entity';
import { AuditLog } from '../audit-trail/entities/audit-log.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import { AuditService } from '../audit-trail/audit.service';
import { WorkerOperationalStatusService } from '../users/worker-operational-status.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentBundleService } from '../../shared/services/document-bundle.service';
import { SignaturesService } from '../signatures/signatures.service';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { MetricsService } from '../../shared/observability/metrics.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockQueryBuilder(overrides: Record<string, jest.Mock> = {}) {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
  Object.keys(qb).forEach((key) => {
    if (!['getManyAndCount', 'getMany'].includes(key)) {
      qb[key].mockReturnThis();
    }
  });
  return qb;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PtsService — findAll() pagination', () => {
  let service: PtsService;
  let mockQb: ReturnType<typeof makeMockQueryBuilder>;

  const mockRepository = {
    createQueryBuilder: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  };
  const mockCompanyRepository = {
    findOne: jest.fn().mockResolvedValue({ id: 'tenant-uuid' }),
    save: jest.fn(),
  };
  const mockAuditLogRepository = {
    find: jest.fn().mockResolvedValue([]),
  };
  const mockTenantService = {
    getTenantId: jest.fn().mockReturnValue('tenant-uuid'),
    getContext: jest.fn().mockReturnValue({
      companyId: 'tenant-uuid',
      siteScope: 'all',
      isSuperAdmin: false,
    }),
  };

  // deps extras do PtsService
  const noop = {};

  beforeEach(async () => {
    mockQb = makeMockQueryBuilder();
    mockRepository.createQueryBuilder.mockReturnValue(mockQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PtsService,
        { provide: getRepositoryToken(Pt), useValue: mockRepository },
        {
          provide: getRepositoryToken(Company),
          useValue: mockCompanyRepository,
        },
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockAuditLogRepository,
        },
        { provide: TenantService, useValue: mockTenantService },
        { provide: RiskCalculationService, useValue: noop },
        { provide: AuditService, useValue: noop },
        { provide: WorkerOperationalStatusService, useValue: noop },
        { provide: DocumentStorageService, useValue: noop },
        { provide: DocumentGovernanceService, useValue: noop },
        { provide: DocumentBundleService, useValue: noop },
        { provide: SignaturesService, useValue: noop },
        { provide: PublicValidationGrantService, useValue: noop },
        { provide: ForensicTrailService, useValue: noop },
        { provide: MetricsService, useValue: noop },
      ],
    }).compile();

    service = module.get<PtsService>(PtsService);
    Reflect.set(
      service as object,
      'refreshExpiredStatuses',
      jest.fn().mockResolvedValue(undefined),
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('deve aplicar paginação padrão (page=1, limit=20)', async () => {
    const result = await service.findAll();

    expect(result.page).toBe(1);
    expect(result.total).toBe(0);
    expect(mockQb.take).toHaveBeenCalledWith(20);
    expect(mockQb.skip).toHaveBeenCalledWith(0);
  });

  it('deve respeitar o limite máximo de 1000', async () => {
    await service.findAll({ page: 1, limit: 5000 });

    expect(mockQb.take).toHaveBeenCalledWith(1000);
  });

  it('deve calcular skip corretamente para page > 1', async () => {
    await service.findAll({ page: 4, limit: 100 });

    expect(mockQb.skip).toHaveBeenCalledWith(300); // (4-1) * 100
  });

  it('deve retornar total e data corretos', async () => {
    const fakePts = [{ id: 'pt-1' }, { id: 'pt-2' }] as Pt[];
    mockQb.getManyAndCount.mockResolvedValue([fakePts, 2]);

    const result = await service.findAll();

    expect(result.total).toBe(2);
    expect(result.data).toHaveLength(2);
    expect(result.lastPage).toBe(1);
  });

  it('deve aplicar filtro de company_id do tenant', async () => {
    await service.findAll();

    expect(mockQb.andWhere).toHaveBeenCalledWith('pt.company_id = :companyId', {
      companyId: 'tenant-uuid',
    });
  });
});

describe('PtsService — findAllForExport()', () => {
  let service: PtsService;
  let mockQb: ReturnType<typeof makeMockQueryBuilder>;

  const mockRepository = {
    createQueryBuilder: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  };
  const mockCompanyRepository = {
    findOne: jest.fn().mockResolvedValue({ id: 'tenant-uuid' }),
    save: jest.fn(),
  };
  const mockAuditLogRepository = {
    find: jest.fn().mockResolvedValue([]),
  };
  const mockTenantService = {
    getTenantId: jest.fn().mockReturnValue('tenant-uuid'),
    getContext: jest.fn().mockReturnValue({
      companyId: 'tenant-uuid',
      siteScope: 'all',
      isSuperAdmin: false,
    }),
  };
  const noop = {};

  beforeEach(async () => {
    mockQb = makeMockQueryBuilder();
    mockRepository.createQueryBuilder.mockReturnValue(mockQb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PtsService,
        { provide: getRepositoryToken(Pt), useValue: mockRepository },
        {
          provide: getRepositoryToken(Company),
          useValue: mockCompanyRepository,
        },
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockAuditLogRepository,
        },
        { provide: TenantService, useValue: mockTenantService },
        { provide: RiskCalculationService, useValue: noop },
        { provide: AuditService, useValue: noop },
        { provide: WorkerOperationalStatusService, useValue: noop },
        { provide: DocumentStorageService, useValue: noop },
        { provide: DocumentGovernanceService, useValue: noop },
        { provide: DocumentBundleService, useValue: noop },
        { provide: SignaturesService, useValue: noop },
        { provide: PublicValidationGrantService, useValue: noop },
        { provide: ForensicTrailService, useValue: noop },
        { provide: MetricsService, useValue: noop },
      ],
    }).compile();

    service = module.get<PtsService>(PtsService);
    Reflect.set(
      service as object,
      'refreshExpiredStatuses',
      jest.fn().mockResolvedValue(undefined),
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('deve limitar a 5000 registros', async () => {
    await service.findAllForExport();

    expect(mockQb.take).toHaveBeenCalledWith(5000);
  });

  it('deve continuar a exportação depois da primeira página', async () => {
    const firstPage = Array.from({ length: 5000 }, (_, index) => ({
      id: `pt-${index}`,
      created_at: new Date('2026-09-10T12:00:00.000Z'),
    }));
    const secondPage = [
      {
        id: 'pt-5000',
        created_at: new Date('2026-09-10T11:59:00.000Z'),
      },
    ];
    mockQb.getMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const result = await service.findAllForExport();

    expect(result).toHaveLength(5001);
    expect(mockRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(mockQb.andWhere).toHaveBeenCalledWith(
      '(pt.created_at < :exportCursorCreatedAt OR (pt.created_at = :exportCursorCreatedAt AND pt.id < :exportCursorId))',
      {
        exportCursorCreatedAt: firstPage.at(-1)?.created_at,
        exportCursorId: 'pt-4999',
      },
    );
  });

  it('deve aplicar filtro de tenant', async () => {
    await service.findAllForExport();

    expect(mockQb.andWhere).toHaveBeenCalledWith('pt.company_id = :companyId', {
      companyId: 'tenant-uuid',
    });
  });
});
