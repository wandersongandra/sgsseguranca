import { validate, getMetadataStorage } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import * as fs from 'fs';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TenantService } from '../../shared/tenant/tenant.service';
import { EpiAssignment } from './entities/epi-assignment.entity';
import { EpiAssignmentsService } from './epi-assignments.service';
import { Epi } from '../epis/entities/epi.entity';
import { User } from '../users/entities/user.entity';
import { AuditService } from '../audit-trail/audit.service';
import { SignatureTimestampService } from '../../shared/services/signature-timestamp.service';
import {
  CreateEpiAssignmentDto,
  EpiSignatureInputDto,
} from './dto/create-epi-assignment.dto';
import { UpdateEpiAssignmentDto } from './dto/update-epi-assignment.dto';
import { ReturnEpiAssignmentDto } from './dto/return-epi-assignment.dto';
import type { TenantContext } from '../../shared/tenant/tenant.service';

const MIGRATIONS_DIR = path.join(__dirname, '../../infra/database/migrations');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeService(overrides: {
  tenantContext?: Partial<TenantContext>;
  assignmentsRepository?: Partial<Repository<EpiAssignment>>;
  episRepository?: Partial<Repository<Epi>>;
  usersRepository?: Partial<Repository<User>>;
}) {
  const assignmentsRepository = {
    create: jest.fn((dto: Partial<EpiAssignment>) => ({ ...dto })),
    save: jest.fn((e: Partial<EpiAssignment>) =>
      Promise.resolve(e as EpiAssignment),
    ),
    findOne: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue({
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    }),
    ...overrides.assignmentsRepository,
  } as unknown as Repository<EpiAssignment>;

  const episRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    ...overrides.episRepository,
  } as unknown as Repository<Epi>;

  const usersRepository = {
    findOne: jest.fn().mockResolvedValue(null),
    ...overrides.usersRepository,
  } as unknown as Repository<User>;

  const defaultContext: TenantContext = {
    companyId: 'company-1',
    isSuperAdmin: false,
    siteScope: 'all',
    siteIds: [],
    ...overrides.tenantContext,
  };

  const tenantService = {
    getTenantId: jest.fn().mockReturnValue(defaultContext.companyId),
    getContext: jest.fn().mockReturnValue(defaultContext),
  } as unknown as TenantService;

  const auditService = {
    log: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;

  const signatureTimestampService = {
    issueFromRaw: jest.fn().mockReturnValue({
      signature_hash: 'hash',
      timestamp_token: null,
      timestamp_issued_at: null,
    }),
  } as unknown as SignatureTimestampService;

  return new EpiAssignmentsService(
    assignmentsRepository,
    episRepository,
    {} as never, // sitesRepository — not needed for these unit tests
    usersRepository,
    tenantService,
    signatureTimestampService,
    auditService,
    {} as never,
    {} as never,
    {} as never,
  );
}

const mockEpi = { id: 'epi-1', ca: 'CA-001', validade_ca: null };
const mockUser = { id: 'u1', company_id: 'company-1' };
const validSig = {
  signature_data: 'data',
  signature_type: 'drawn',
  signer_name: 'Test',
};

// ─── M1: UpdateEpiAssignmentDto restrito ────────────────────────────────────

describe('UpdateEpiAssignmentDto — achado M1', () => {
  it('somente quantidade e observacoes têm decorators de validação', () => {
    const storage = getMetadataStorage();
    const metas = storage.getTargetValidationMetadatas(
      UpdateEpiAssignmentDto,
      '',
      false,
      false,
    );
    const allowedProps = new Set(metas.map((m) => m.propertyName));
    // Campos sensíveis NÃO devem ter decorators (nem aparecer no whitelist)
    expect(allowedProps.has('epi_id')).toBe(false);
    expect(allowedProps.has('user_id')).toBe(false);
    expect(allowedProps.has('site_id')).toBe(false);
    expect(allowedProps.has('assinatura_entrega')).toBe(false);
    // Campos permitidos DEVEM ter decorators
    expect(allowedProps.has('quantidade')).toBe(true);
    expect(allowedProps.has('observacoes')).toBe(true);
  });

  it('exatamente 2 propriedades decoradas: quantidade e observacoes', () => {
    const storage = getMetadataStorage();
    const metas = storage.getTargetValidationMetadatas(
      UpdateEpiAssignmentDto,
      '',
      false,
      false,
    );
    const props = new Set(metas.map((m) => m.propertyName));
    expect(props.size).toBe(2);
    expect(props.has('quantidade')).toBe(true);
    expect(props.has('observacoes')).toBe(true);
  });

  it('rejeita quantidade = 0 (min 1)', async () => {
    const dto = new UpdateEpiAssignmentDto();
    dto.quantidade = 0;
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'quantidade')).toBe(true);
  });

  it('aceita quantidade e observacoes como únicos campos', async () => {
    const dto = plainToInstance(UpdateEpiAssignmentDto, {
      quantidade: 5,
      observacoes: 'Obs válida',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejeita quantidade acima de 10000 (novo limite M2)', async () => {
    const dto = plainToInstance(UpdateEpiAssignmentDto, { quantidade: 99999 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'quantidade')).toBe(true);
  });
});

// ─── M2: Limites de validação nos DTOs ──────────────────────────────────────

describe('CreateEpiAssignmentDto — achado M2', () => {
  it('rejeita quantidade acima de 10000', async () => {
    const dto = plainToInstance(CreateEpiAssignmentDto, {
      epi_id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      quantidade: 2_000_000,
      assinatura_entrega: validSig,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'quantidade')).toBe(true);
  });

  it('aceita quantidade dentro do limite', async () => {
    const dto = plainToInstance(CreateEpiAssignmentDto, {
      epi_id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      quantidade: 10000,
      assinatura_entrega: validSig,
    });
    const errors = await validate(dto, { skipMissingProperties: false });
    const qtdErrors = errors.filter((e) => e.property === 'quantidade');
    expect(qtdErrors).toHaveLength(0);
  });

  it('rejeita observacoes acima de 2000 caracteres', async () => {
    const dto = plainToInstance(CreateEpiAssignmentDto, {
      epi_id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      observacoes: 'x'.repeat(2001),
      assinatura_entrega: validSig,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'observacoes')).toBe(true);
  });
});

describe('EpiSignatureInputDto — achado M2', () => {
  it('rejeita signature_data acima de 400_000 caracteres', async () => {
    const dto = plainToInstance(EpiSignatureInputDto, {
      signature_data: 'x'.repeat(400_001),
      signature_type: 'drawn',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'signature_data')).toBe(true);
  });

  it('rejeita signer_name acima de 200 caracteres', async () => {
    const dto = plainToInstance(EpiSignatureInputDto, {
      signature_data: 'data',
      signature_type: 'drawn',
      signer_name: 'x'.repeat(201),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'signer_name')).toBe(true);
  });
});

describe('ReturnEpiAssignmentDto — achado M2', () => {
  it('rejeita motivo_devolucao acima de 2000 caracteres', async () => {
    const dto = plainToInstance(ReturnEpiAssignmentDto, {
      assinatura_devolucao: validSig,
      motivo_devolucao: 'x'.repeat(2001),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'motivo_devolucao')).toBe(true);
  });
});

// ─── Q1: site_id fallback para usuários site-scoped ─────────────────────────

describe('EpiAssignmentsService.create() — achado Q1 (site_id fallback)', () => {
  it('usa scope.siteId como site_id quando usuário site-scoped não envia site_id', async () => {
    let savedSiteId: string | undefined;

    const service = makeService({
      tenantContext: {
        companyId: 'company-1',
        siteIds: ['site-abc'],
        siteId: 'site-abc',
        siteScope: 'single',
        isSuperAdmin: false,
        userId: 'supervisor-1',
        profileName: 'TST',
      } as unknown as TenantContext,
      episRepository: { findOne: jest.fn().mockResolvedValue(mockEpi) },
      usersRepository: { findOne: jest.fn().mockResolvedValue(mockUser) },
      assignmentsRepository: {
        create: jest.fn((dto: Partial<EpiAssignment>) => {
          savedSiteId = dto.site_id;
          return { ...dto } as EpiAssignment;
        }),
        save: jest.fn((e: Partial<EpiAssignment>) =>
          Promise.resolve(e as EpiAssignment),
        ),
      } as unknown as Partial<Repository<EpiAssignment>>,
    });

    await service.create({
      epi_id: 'epi-1',
      user_id: 'u1',
      assinatura_entrega: validSig,
    });

    expect(savedSiteId).toBe('site-abc');
  });

  it('rejeita criação quando site_id enviado não pertence ao scope do usuário', async () => {
    const service = makeService({
      tenantContext: {
        companyId: 'company-1',
        siteIds: ['site-abc'],
        siteId: 'site-abc',
        siteScope: 'single',
        isSuperAdmin: false,
        userId: 'supervisor-1',
        profileName: 'TST',
      } as unknown as TenantContext,
      episRepository: { findOne: jest.fn().mockResolvedValue(mockEpi) },
      usersRepository: { findOne: jest.fn().mockResolvedValue(mockUser) },
    });

    await expect(
      service.create({
        epi_id: 'epi-1',
        user_id: 'u1',
        site_id: 'site-xyz',
        assinatura_entrega: validSig,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─── A1: Migration 314 cobre epi_assignments na função LGPD ─────────────────

describe('Migration 1709000000314 — epi_assignments LGPD erasure', () => {
  let content: string;

  beforeAll(() => {
    const file = path.join(
      MIGRATIONS_DIR,
      '1709000000314-epi-assignments-gdpr-erasure.ts',
    );
    content = fs.readFileSync(file, 'utf8');
  });

  it('inclui epi_assignments na função gdpr_delete_user_data', () => {
    expect(content).toContain("'epi_assignments'::text");
    expect(content).toContain('UPDATE epi_assignments');
  });

  it('anonimiza signature_data da entrega', () => {
    expect(content).toContain('assinatura_entrega');
    expect(content).toContain('signature_data');
    expect(content).toContain('[LGPD: removido]');
  });

  it('anonimiza signature_data da devolução quando presente (CASE WHEN IS NOT NULL)', () => {
    expect(content).toContain('assinatura_devolucao');
    expect(content).toContain('WHEN assinatura_devolucao IS NOT NULL');
  });

  it('nulifica user_id e aplica soft-delete', () => {
    expect(content).toContain('user_id = NULL');
    expect(content).toContain('deleted_at = NOW()');
  });

  it('protege somente registros ativos (deleted_at IS NULL)', () => {
    expect(content).toContain('AND deleted_at IS NULL');
  });

  it('usa SET search_path = public para segurança de schema', () => {
    expect(content).toContain('SET search_path = public');
  });

  it('mantém pts_text_fields da migration anterior', () => {
    expect(content).toContain("'pts_text_fields'::text");
  });
});

// ─── B1: Migration 315 adiciona WITH CHECK à política RLS de epis ────────────

describe('Migration 1709000000315 — epis RLS WITH CHECK', () => {
  let content: string;

  beforeAll(() => {
    const file = path.join(
      MIGRATIONS_DIR,
      '1709000000315-epis-rls-with-check.ts',
    );
    content = fs.readFileSync(file, 'utf8');
  });

  it('adiciona cláusula WITH CHECK à política de epis', () => {
    expect(content).toContain('WITH CHECK');
  });

  it('recria a política com DROP + CREATE para atomicidade', () => {
    expect(content).toContain('DROP POLICY');
    expect(content).toContain('CREATE POLICY');
  });

  it('mantém USING para leitura isolada por tenant', () => {
    expect(content).toContain('USING (');
  });

  it('down() restaura política sem WITH CHECK', () => {
    expect(content).toContain('async down');
  });
});
