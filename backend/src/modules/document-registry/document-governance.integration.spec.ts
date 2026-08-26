import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';
import { bootstrapBackendTestEnvironment } from '../../../test/setup/test-env';
import { AprsService } from '../aprs/aprs.service';
import { AprWorkflowService } from '../aprs/aprs-workflow.service';
import { AprsEvidenceService } from '../aprs/services/aprs-evidence.service';
import { AprsPdfService } from '../aprs/services/aprs-pdf.service';
import type { AprExcelService } from '../aprs/apr-excel.service';
import type { AprRiskMatrixService } from '../aprs/apr-risk-matrix.service';
import { Apr, AprStatus } from '../aprs/entities/apr.entity';
import { AprApprovalRecord } from '../aprs/entities/apr-approval-record.entity';
import { AprLog } from '../aprs/entities/apr-log.entity';
import { AprRiskEvidence } from '../aprs/entities/apr-risk-evidence.entity';
import { AprRiskItem } from '../aprs/entities/apr-risk-item.entity';
import { Activity } from '../activities/entities/activity.entity';
import type { AuditService } from '../audit-trail/audit.service';
import { AuditLog } from '../audit-trail/entities/audit-log.entity';
import { Audit } from '../audits/entities/audit.entity';
import { AuditsService } from '../audits/audits.service';
import { Company } from '../companies/entities/company.entity';
import { PdfIntegrityRecord } from '../../shared/entities/pdf-integrity-record.entity';
import type { CacheService } from '../../shared/cache/cache.service';
import type { DocumentBundleService } from '../../shared/services/document-bundle.service';
import type { DocumentStorageService } from '../../shared/services/document-storage.service';
import { PdfService } from '../../shared/services/pdf.service';
import { PdfValidatorService } from '../../shared/services/pdf-validator.service';
import type { PuppeteerPoolService } from '../../shared/services/puppeteer-pool.service';
import type { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import type { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import type { TenantRepositoryFactory } from '../../shared/tenant/tenant-repository';
import type { TenantService } from '../../shared/tenant/tenant.service';
import { Dds, DdsStatus } from '../dds/entities/dds.entity';
import { DdsService } from '../dds/dds.service';
import { DocumentRegistryEntry } from './entities/document-registry.entity';
import { DocumentRegistryVersionEntry } from './entities/document-registry-version.entity';
import { DocumentRegistryService } from './document-registry.service';
import { DocumentGovernanceService } from './document-governance.service';
import type { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { Epi } from '../epis/entities/epi.entity';
import { Machine } from '../machines/entities/machine.entity';
import { Profile } from '../profiles/entities/profile.entity';
import { Pt, PtStatus } from '../pts/entities/pt.entity';
import { PtsService } from '../pts/pts.service';
import { Risk } from '../risks/entities/risk.entity';
import { Site } from '../sites/entities/site.entity';
import type { SignaturesService } from '../signatures/signatures.service';
import { Tool } from '../tools/entities/tool.entity';
import { User } from '../users/entities/user.entity';
import type { WorkerOperationalStatusService } from '../users/worker-operational-status.service';

bootstrapBackendTestEnvironment();

function buildPdfBuffer(label: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n% ${label}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${'0'.repeat(
      140,
    )}\n%%EOF`,
    'ascii',
  );
}

function buildDocumentStorageStub() {
  return {
    generateDocumentKey: jest.fn(
      (
        companyId: string,
        module: string,
        entityId: string,
        originalName: string,
      ) => `documents/${companyId}/${module}/${entityId}/${originalName}`,
    ),
    uploadFile: jest.fn(() => Promise.resolve()),
    deleteFile: jest.fn(() => Promise.resolve()),
    getSignedUrl: jest.fn(() => Promise.resolve('https://example.com/doc.pdf')),
  } as unknown as Pick<
    DocumentStorageService,
    'generateDocumentKey' | 'uploadFile' | 'deleteFile' | 'getSignedUrl'
  >;
}

function buildTenantService(companyId: string | null): TenantService {
  return {
    getTenantId: jest.fn(() => companyId),
  } as unknown as TenantService;
}

function buildBundleService(): DocumentBundleService {
  return {} as unknown as DocumentBundleService;
}

function buildRiskCalculationService(): RiskCalculationService {
  return {} as unknown as RiskCalculationService;
}

function buildAuditService(): AuditService {
  return {} as unknown as AuditService;
}

function buildWorkerOperationalStatusService(): WorkerOperationalStatusService {
  return {} as unknown as WorkerOperationalStatusService;
}

type SignatureServiceMockEntry = {
  user_id?: string;
  type?: string;
  signature_data?: string | null;
};

function buildSignaturesService(
  signatures: SignatureServiceMockEntry[] = [],
): SignaturesService {
  return {
    findByDocument: jest.fn().mockResolvedValue(signatures),
    resolveSignatureData: jest.fn((signature: SignatureServiceMockEntry) =>
      Promise.resolve(signature.signature_data ?? null),
    ),
  } as unknown as SignaturesService;
}

function buildPuppeteerPoolStub(): PuppeteerPoolService {
  return {} as unknown as PuppeteerPoolService;
}

function buildPublicValidationGrantService(): PublicValidationGrantService {
  return {
    issueToken: jest.fn().mockResolvedValue('token-publico'),
  } as unknown as PublicValidationGrantService;
}

function buildAprRiskMatrixService(): AprRiskMatrixService {
  return {} as unknown as AprRiskMatrixService;
}

function buildAprExcelService(): AprExcelService {
  return {} as unknown as AprExcelService;
}

function buildForensicTrailService(): ForensicTrailService {
  return {
    append: jest.fn(),
  } as unknown as ForensicTrailService;
}

function buildCacheServiceStub(): CacheService {
  return {
    getOrSet: jest.fn(<T>(_key: string, factory: () => Promise<T>) =>
      factory(),
    ),
    del: jest.fn(() => Promise.resolve()),
  } as unknown as CacheService;
}

function buildTenantRepositoryFactory() {
  return {
    wrap: <T extends { id: string; company_id: string }>(
      repository: Repository<T>,
    ) => ({
      findOne: (
        id: string,
        companyId: string,
        options?: Omit<Parameters<Repository<T>['findOne']>[0], 'where'>,
      ) =>
        repository.findOne({
          ...(options || {}),
          where: {
            id,
            company_id: companyId,
          } as unknown as FindOptionsWhere<T>,
        }),
    }),
  } as unknown as TenantRepositoryFactory;
}

async function createSchema(schema: string) {
  const client = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres123',
    database: process.env.DATABASE_NAME || 'sst_db',
  });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await client.end();
  }
}

async function dropSchema(schema: string) {
  const client = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres123',
    database: process.env.DATABASE_NAME || 'sst_db',
  });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

async function createIntegrationDataSource(schema: string) {
  await createSchema(schema);
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres123',
    database: process.env.DATABASE_NAME || 'sst_db',
    schema,
    synchronize: true,
    entities: [
      Company,
      Profile,
      Site,
      User,
      Activity,
      Risk,
      Epi,
      Tool,
      Machine,
      Apr,
      AprLog,
      AprRiskItem,
      AprRiskEvidence,
      Dds,
      Audit,
      Pt,
      AuditLog,
      DocumentRegistryEntry,
      DocumentRegistryVersionEntry,
      PdfIntegrityRecord,
    ],
  });
  await dataSource.initialize();
  return dataSource;
}

describe('Document governance integration', () => {
  jest.setTimeout(30000);

  let dataSource: DataSource;
  let aprsService: AprsService;
  let ddsService: DdsService;
  let auditsService: AuditsService;
  let ptsService: PtsService;
  let registryRepository: Repository<DocumentRegistryEntry>;
  let integrityRepository: Repository<PdfIntegrityRecord>;
  let companyRepository: Repository<Company>;
  let profileRepository: Repository<Profile>;
  let siteRepository: Repository<Site>;
  let userRepository: Repository<User>;
  let aprRepository: Repository<Apr>;
  let ddsRepository: Repository<Dds>;
  let auditRepository: Repository<Audit>;
  let ptRepository: Repository<Pt>;
  let dbAvailable = false;

  const schema = `phase3_doc_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const companyId = '11111111-1111-4111-8111-111111111111';
  const siteId = '22222222-2222-4222-8222-222222222222';
  const profileId = '33333333-3333-4333-8333-333333333333';
  const userId = '44444444-4444-4444-8444-444444444444';

  beforeAll(async () => {
    try {
      dataSource = await createIntegrationDataSource(schema);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      return;
    }

    const pdfService = new PdfService(
      dataSource.getRepository(PdfIntegrityRecord),
      dataSource.getRepository(DocumentRegistryEntry),
      buildPuppeteerPoolStub(),
      new PdfValidatorService(),
    );
    const documentRegistryService = new DocumentRegistryService(
      dataSource.getRepository(DocumentRegistryEntry),
      dataSource.getRepository(DocumentRegistryVersionEntry),
      dataSource,
      buildTenantService(null),
      buildBundleService(),
      buildDocumentStorageStub() as DocumentStorageService,
    );
    const bundleService = buildBundleService();
    const governanceService = new DocumentGovernanceService(
      dataSource,
      pdfService,
      bundleService,
      documentRegistryService,
      buildForensicTrailService(),
    );
    const documentStorageService = buildDocumentStorageStub();
    const tenantService = buildTenantService(companyId);
    const signaturesService = buildSignaturesService([
      { user_id: userId, type: 'pin' },
    ]);
    const forensicTrailService = buildForensicTrailService();
    const aprsPdfService = new AprsPdfService(
      dataSource.getRepository(Apr),
      dataSource.getRepository(AprLog),
      tenantService,
      documentStorageService as unknown as DocumentStorageService,
      pdfService,
      governanceService,
      signaturesService,
      buildPublicValidationGrantService(),
    );
    const aprsEvidenceService = new AprsEvidenceService(
      dataSource.getRepository(Apr),
      dataSource.getRepository(AprLog),
      tenantService,
      documentStorageService as unknown as DocumentStorageService,
    );
    const aprWorkflowService = new AprWorkflowService(
      dataSource.getRepository(Apr),
      dataSource.getRepository(AprLog),
      dataSource.getRepository(AprApprovalRecord),
      tenantService,
      forensicTrailService,
      {
        create: jest.fn().mockResolvedValue(undefined),
        notifyEligibleApprovers: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    aprsService = new AprsService(
      dataSource.getRepository(Apr),
      dataSource.getRepository(AprLog),
      tenantService,
      buildRiskCalculationService(),
      buildAprRiskMatrixService(),
      buildAprExcelService(),
      documentStorageService as unknown as DocumentStorageService,
      pdfService,
      governanceService,
      bundleService,
      signaturesService,
      forensicTrailService,
      aprsPdfService,
      aprsEvidenceService,
      aprWorkflowService,
      buildCacheServiceStub(),
    );
    ddsService = new DdsService(
      dataSource.getRepository(Dds),
      dataSource.getRepository(User),
      buildTenantService(companyId),
      documentStorageService as unknown as DocumentStorageService,
      bundleService,
      governanceService,
      {} as never,
      buildSignaturesService([{ user_id: userId, type: 'pin' }]),
      buildPublicValidationGrantService(),
    );
    auditsService = new AuditsService(
      dataSource.getRepository(Audit),
      dataSource.getRepository(User),
      buildTenantRepositoryFactory(),
      documentStorageService as unknown as DocumentStorageService,
      bundleService,
      governanceService,
      buildPublicValidationGrantService(),
      buildTenantService(companyId),
    );
    ptsService = new PtsService(
      dataSource.getRepository(Pt),
      dataSource.getRepository(Company),
      dataSource.getRepository(AuditLog),
      buildTenantService(companyId),
      buildRiskCalculationService(),
      buildAuditService(),
      buildWorkerOperationalStatusService(),
      documentStorageService as unknown as DocumentStorageService,
      governanceService,
      bundleService,
      buildSignaturesService(),
      buildPublicValidationGrantService(),
      buildForensicTrailService(),
    );

    registryRepository = dataSource.getRepository(DocumentRegistryEntry);
    integrityRepository = dataSource.getRepository(PdfIntegrityRecord);
    companyRepository = dataSource.getRepository(Company);
    profileRepository = dataSource.getRepository(Profile);
    siteRepository = dataSource.getRepository(Site);
    userRepository = dataSource.getRepository(User);
    aprRepository = dataSource.getRepository(Apr);
    ddsRepository = dataSource.getRepository(Dds);
    auditRepository = dataSource.getRepository(Audit);
    ptRepository = dataSource.getRepository(Pt);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
    await dropSchema(schema);
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await dataSource.synchronize(true);

    await companyRepository.save({
      id: companyId,
      razao_social: 'Empresa Teste',
      cnpj: randomUUID(),
      endereco: 'Rua Teste',
      responsavel: 'Responsavel Teste',
      status: true,
    });
    await profileRepository.save({
      id: profileId,
      nome: 'Administrador',
      permissoes: { all: true },
      status: true,
    });
    await siteRepository.save({
      id: siteId,
      nome: 'Obra Teste',
      local: 'Local Teste',
      endereco: 'Endereco Teste',
      cidade: 'Cidade',
      estado: 'SP',
      status: true,
      company_id: companyId,
    });
    await userRepository.save({
      id: userId,
      nome: 'Usuario Teste',
      cpf: `${Math.floor(Math.random() * 100000000000)}`.padStart(11, '0'),
      email: `${randomUUID()}@example.com`,
      funcao: 'Tecnico',
      status: true,
      company_id: companyId,
      site_id: siteId,
      profile_id: profileId,
    });
  });

  it('governa APR final no banco real e preserva integridade historica apos remocao', async () => {
    if (!dbAvailable) return;
    const apr = await aprRepository.save({
      numero: 'APR-001',
      titulo: 'APR Integracao',
      descricao: 'Teste de integracao',
      data_inicio: new Date('2026-03-14'),
      data_fim: new Date('2026-03-15'),
      status: AprStatus.APROVADA,
      company_id: companyId,
      site_id: siteId,
      elaborador_id: userId,
      control_evidence: false,
      versao: 1,
      is_modelo: false,
      is_modelo_padrao: false,
    });

    // A APR precisa ter ao menos um participante antes de anexar o PDF final
    await aprRepository
      .createQueryBuilder()
      .relation('participants')
      .of(apr.id)
      .add(userId);

    await aprsService.attachPdf(
      apr.id,
      {
        originalname: 'apr-final.pdf',
        mimetype: 'application/pdf',
        buffer: buildPdfBuffer('apr'),
      } as Express.Multer.File,
      userId,
    );

    const registry = await registryRepository.findOneOrFail({
      where: { module: 'apr', entity_id: apr.id, company_id: companyId },
    });
    const integrity = await integrityRepository.findOneOrFail({
      where: { hash: registry.file_hash as string },
    });

    expect(registry.file_key).toContain(`/aprs/${apr.id}/apr-final.pdf`);
    expect(registry.file_hash).toHaveLength(64);
    expect(registry.company_id).toBe(companyId);
    expect(integrity.company_id).toBe(companyId);
    expect(integrity.signed_by_user_id).toBe(userId);

    await aprsService.remove(apr.id, userId);

    await expect(
      registryRepository.findOne({
        where: { module: 'apr', entity_id: apr.id, company_id: companyId },
      }),
    ).resolves.toBeNull();
    await expect(
      integrityRepository.findOne({
        where: { hash: registry.file_hash as string },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        hash: registry.file_hash,
        company_id: companyId,
      }),
    );
  });

  it('governa DDS final no banco real e preserva integridade historica apos remocao', async () => {
    if (!dbAvailable) return;
    const dds = await ddsRepository.save({
      tema: 'DDS Integracao',
      conteudo: 'Conteudo',
      data: new Date('2026-03-14'),
      status: DdsStatus.PUBLICADO,
      company_id: companyId,
      site_id: siteId,
      facilitador_id: userId,
      participants: [{ id: userId }],
    });

    await ddsService.attachPdf(dds.id, {
      originalname: 'dds-final.pdf',
      mimetype: 'application/pdf',
      buffer: buildPdfBuffer('dds'),
    } as Express.Multer.File);

    const registry = await registryRepository.findOneOrFail({
      where: { module: 'dds', entity_id: dds.id, company_id: companyId },
    });
    const integrity = await integrityRepository.findOneOrFail({
      where: { hash: registry.file_hash as string },
    });

    expect(registry.file_key).toContain(`/dds/${dds.id}/dds-final.pdf`);
    expect(registry.file_hash).toHaveLength(64);
    expect(registry.company_id).toBe(companyId);
    expect(integrity.company_id).toBe(companyId);

    await ddsService.remove(dds.id);

    await expect(
      registryRepository.findOne({
        where: { module: 'dds', entity_id: dds.id, company_id: companyId },
      }),
    ).resolves.toBeNull();
    await expect(
      integrityRepository.findOne({
        where: { hash: registry.file_hash as string },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        hash: registry.file_hash,
        company_id: companyId,
      }),
    );
  });

  it('governa auditoria final no banco real e preserva integridade historica apos remocao', async () => {
    if (!dbAvailable) return;
    const audit = await auditRepository.save({
      titulo: 'Auditoria Integracao',
      data_auditoria: new Date('2026-03-14'),
      tipo_auditoria: 'interna',
      company_id: companyId,
      site_id: siteId,
      auditor_id: userId,
    });

    await auditsService.attachPdf(
      audit.id,
      companyId,
      {
        originalname: 'audit-final.pdf',
        mimetype: 'application/pdf',
        buffer: buildPdfBuffer('audit'),
      } as Express.Multer.File,
      userId,
    );

    const registry = await registryRepository.findOneOrFail({
      where: { module: 'audit', entity_id: audit.id, company_id: companyId },
    });
    const integrity = await integrityRepository.findOneOrFail({
      where: { hash: registry.file_hash as string },
    });

    expect(registry.file_key).toContain(`/audits/${audit.id}/audit-final.pdf`);
    expect(registry.file_hash).toHaveLength(64);
    expect(registry.company_id).toBe(companyId);
    expect(integrity.company_id).toBe(companyId);
    expect(integrity.signed_by_user_id).toBe(userId);

    await auditsService.remove(audit.id, companyId);

    await expect(
      registryRepository.findOne({
        where: { module: 'audit', entity_id: audit.id, company_id: companyId },
      }),
    ).resolves.toBeNull();
    await expect(
      integrityRepository.findOne({
        where: { hash: registry.file_hash as string },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        hash: registry.file_hash,
        company_id: companyId,
      }),
    );
  });

  it('governa PT final no banco real e preserva integridade historica apos remocao', async () => {
    if (!dbAvailable) return;
    const pt = await ptRepository.save({
      numero: 'PT-001',
      titulo: 'PT Integracao',
      descricao: 'Teste de integracao',
      data_hora_inicio: new Date('2026-03-14T08:00:00.000Z'),
      data_hora_fim: new Date('2026-03-14T18:00:00.000Z'),
      status: PtStatus.APROVADA,
      company_id: companyId,
      site_id: siteId,
      responsavel_id: userId,
      control_evidence: false,
    });

    await ptsService.attachPdf(
      pt.id,
      {
        originalname: 'pt-final.pdf',
        mimetype: 'application/pdf',
        buffer: buildPdfBuffer('pt'),
      } as Express.Multer.File,
      userId,
    );

    const registry = await registryRepository.findOneOrFail({
      where: { module: 'pt', entity_id: pt.id, company_id: companyId },
    });
    const integrity = await integrityRepository.findOneOrFail({
      where: { hash: registry.file_hash as string },
    });

    expect(registry.file_key).toContain(`/pts/${pt.id}/pt-final.pdf`);
    expect(registry.file_hash).toHaveLength(64);
    expect(registry.company_id).toBe(companyId);
    expect(integrity.company_id).toBe(companyId);
    expect(integrity.signed_by_user_id).toBe(userId);

    await ptsService.remove(pt.id);

    await expect(
      registryRepository.findOne({
        where: { module: 'pt', entity_id: pt.id, company_id: companyId },
      }),
    ).resolves.toBeNull();
    await expect(
      integrityRepository.findOne({
        where: { hash: registry.file_hash as string },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        hash: registry.file_hash,
        company_id: companyId,
      }),
    );
  });
});
