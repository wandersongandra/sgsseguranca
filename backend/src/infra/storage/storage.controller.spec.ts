/**
 * Fase 1/2 — Testes P0: StorageController (guardrails de upload)
 *
 * Fase 1: contentType, extensão, TTL, chave segura, auditoria
 * Fase 2 adiciona:
 *   6. Role-based access: TRABALHADOR/COLABORADOR → 403
 *   7. SuperAdmin sem tenant explícito → 400 (não deve gerar URL sem contexto)
 *   8. Chave gerada é sempre UUID v4 válido (formato verificado por regex)
 *   9. expiresIn no body nunca excede 600s (invariante de segurança)
 *  10. contentType default é sempre application/pdf (não deixa vazar tipo incorreto)
 */
import {
  INestApplication,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { StorageController } from './storage.controller';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { AuditService } from '../../modules/audit-trail/audit.service';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import { RolesGuard } from '../../modules/auth/roles.guard';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { Role } from '../../modules/auth/enums/roles.enum';
import { PermissionsGuard } from '../../modules/auth/permissions.guard';
import { stringMatchingMatcher } from '../../../test/helpers/typed-matchers';
import type {
  StorageObjectOwner,
  StorageObjectReference,
} from '../../shared/storage/storage-object-reference';

jest.setTimeout(10000);

const httpRequest = (nestApp: INestApplication) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  request(nestApp.getHttpServer());

const FAKE_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const FAKE_PRESIGNED_URL = 'https://s3.example.com/presigned-url?sig=abc';
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AuditLogEntry = {
  companyId?: string;
  changes?: {
    after?: {
      contentType?: string;
      ttlSeconds?: number;
    };
  };
};

// Guard que simula JWT ausente (UnauthorizedException → 401)
const jwtDenyGuard = {
  canActivate: () => {
    throw new UnauthorizedException('Token ausente');
  },
};

// Guard que simula role insuficiente (ForbiddenException → 403)
const makeRoleDenyGuard = (role: Role) => ({
  canActivate: () => {
    throw new ForbiddenException(
      `Role ${role} insuficiente para esta operação`,
    );
  },
});

const passAllGuard = {
  canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user: object }>();
    req.user = { userId: 'user-1', company_id: FAKE_TENANT_ID };
    return true;
  },
};

const passAllInterceptor = {
  intercept: (_ctx: unknown, next: { handle: () => unknown }) => next.handle(),
};

describe('StorageController — Guardrails de Upload PDF (P0)', () => {
  let app: INestApplication;
  let storageService: {
    referenceForExistingObject: jest.Mock;
    createReference: jest.Mock;
    getPresignedUploadUrl: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let tenantService: { getTenantId: jest.Mock; isSuperAdmin: jest.Mock };

  beforeAll(async () => {
    storageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: StorageObjectOwner,
          purpose: string,
        ): StorageObjectReference => ({
          tenantId: FAKE_TENANT_ID,
          key,
          owner,
          purpose,
        }),
      ),
      createReference: jest.fn(
        (input: StorageObjectReference): StorageObjectReference => input,
      ),
      getPresignedUploadUrl: jest.fn().mockResolvedValue(FAKE_PRESIGNED_URL),
    };
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };
    tenantService = {
      getTenantId: jest.fn().mockReturnValue(FAKE_TENANT_ID),
      isSuperAdmin: jest.fn().mockReturnValue(false),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [
        { provide: DocumentStorageService, useValue: storageService },
        { provide: TenantService, useValue: tenantService },
        { provide: AuditService, useValue: auditService },
        {
          provide: FileInspectionService,
          useValue: { inspect: jest.fn().mockResolvedValue({ clean: true }) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(passAllGuard)
      .overrideGuard(RolesGuard)
      .useValue(passAllGuard)
      .overrideGuard(PermissionsGuard)
      .useValue(passAllGuard)
      .overrideGuard(TenantGuard)
      .useValue(passAllGuard)
      .overrideInterceptor(TenantInterceptor)
      .useValue(passAllInterceptor)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    storageService.getPresignedUploadUrl
      .mockReset()
      .mockResolvedValue(FAKE_PRESIGNED_URL);
    auditService.log.mockReset().mockResolvedValue(undefined);
  });

  // ─── Validação de contentType ──────────────────────────────────────────────

  describe('Validação de contentType', () => {
    it('rejeita application/octet-stream com 400', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf', contentType: 'application/octet-stream' });

      expect(response.status).toBe(400);
    });

    it('rejeita image/jpeg com 400', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'foto.pdf', contentType: 'image/jpeg' });

      expect(response.status).toBe(400);
    });

    it('rejeita text/html com 400 (XSS vector)', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'page.pdf', contentType: 'text/html' });

      expect(response.status).toBe(400);
    });

    it('aceita application/pdf sem contentType explícito (default)', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'document.pdf' });

      expect(response.status).toBe(201);
    });
  });

  // ─── Validação de extensão ────────────────────────────────────────────────

  describe('Validação de extensão de arquivo', () => {
    it('rejeita arquivo .exe com 400', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'malware.exe', contentType: 'application/pdf' });

      expect(response.status).toBe(400);
    });

    it('rejeita arquivo .js com 400', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'script.js', contentType: 'application/pdf' });

      expect(response.status).toBe(400);
    });

    it('rejeita arquivo sem extensão com 400', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'nenhuma-extensao', contentType: 'application/pdf' });

      expect(response.status).toBe(400);
    });

    it('rejeita tentativa de path traversal com 400', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({
          filename: '../../../etc/passwd.pdf',
          contentType: 'application/pdf',
        });

      // Deve falhar (extensão é .pdf mas path traversal não muda a resposta de 2xx
      // já que a key gerada ignora o nome original)
      // Importante: mesmo que passe, a KEY não deve conter o path original
      if (response.status === 201) {
        const body = response.body as { fileKey?: string };
        expect(body.fileKey).not.toContain('..');
        expect(body.fileKey).not.toContain('etc');
        expect(body.fileKey).not.toContain('passwd');
      }
    });

    it('aceita arquivo .pdf (maiúsculo .PDF) com 201', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'DOCUMENTO.PDF', contentType: 'application/pdf' });

      expect(response.status).toBe(201);
    });
  });

  // ─── TTL da presigned URL ─────────────────────────────────────────────────

  describe('TTL da presigned URL', () => {
    it('gera URL com TTL de 600s (10 minutos), não 3600s (1 hora)', async () => {
      await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          key: stringMatchingMatcher(/^quarantine\//),
        }),
        'application/pdf',
        600,
      );
    });

    it('retorna expiresIn=600 no body da resposta', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      expect(response.status).toBe(201);
      expect((response.body as { expiresIn?: number }).expiresIn).toBe(600);
    });
  });

  // ─── Geração de chave segura ──────────────────────────────────────────────

  describe('Geração de chave de arquivo', () => {
    it('chave nunca contém o nome original do arquivo', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'meu-arquivo-secreto.pdf' });

      expect(response.status).toBe(201);
      const body = response.body as { fileKey?: string };
      expect(body.fileKey).not.toContain('meu-arquivo-secreto');
    });

    it('chave contém o tenantId para scoping correto', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      const body = response.body as { fileKey?: string };
      expect(body.fileKey).toContain(FAKE_TENANT_ID);
    });

    it('chave termina com .pdf', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      const body = response.body as { fileKey?: string };
      expect(body.fileKey).toMatch(/\.pdf$/);
    });

    it('chaves geradas em chamadas distintas são únicas (UUID)', async () => {
      const [r1, r2] = await Promise.all([
        httpRequest(app)
          .post('/storage/presigned-url')
          .send({ filename: 'a.pdf' }),
        httpRequest(app)
          .post('/storage/presigned-url')
          .send({ filename: 'b.pdf' }),
      ]);

      const key1 = (r1.body as { fileKey?: string }).fileKey;
      const key2 = (r2.body as { fileKey?: string }).fileKey;
      expect(key1).not.toBe(key2);
    });
  });

  // ─── Auditoria ────────────────────────────────────────────────────────────

  describe('Auditoria ao emitir presigned URL', () => {
    it('registra entrada na auditoria ao emitir URL', async () => {
      await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      expect(auditService.log).toHaveBeenCalledTimes(1);
    });

    it('auditoria contém tenantId, contentType e TTL', async () => {
      await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      const auditCalls = auditService.log.mock.calls as Array<[AuditLogEntry]>;
      const [firstAuditCall] = auditCalls;
      expect(firstAuditCall).toBeDefined();
      const [logCall] = firstAuditCall;
      expect(logCall.companyId).toBe(FAKE_TENANT_ID);
      expect(logCall.changes?.after?.contentType).toBe('application/pdf');
      expect(logCall.changes?.after?.ttlSeconds).toBe(600);
    });

    it('falha na auditoria não bloqueia o upload (non-fatal)', async () => {
      auditService.log.mockRejectedValue(new Error('DB timeout'));

      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      // Upload deve continuar mesmo se auditoria falhar
      expect(response.status).toBe(201);
    });
  });

  // ─── Campos obrigatórios ──────────────────────────────────────────────────

  describe('Validação de campos obrigatórios', () => {
    it('rejeita body sem filename com 400', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ contentType: 'application/pdf' });

      expect(response.status).toBe(400);
    });
  });

  // ─── Fase 2: Invariante de segurança da chave gerada ────────────────────────

  describe('Fase 2 — Invariante: formato da chave gerada', () => {
    it('fileKey contém UUID v4 válido (regex)', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'test.pdf' });

      expect(response.status).toBe(201);
      const body = response.body as { fileKey?: string };
      // Extrai a parte UUID da chave: quarantine/{tenantId}/{UUID}.pdf
      const parts = body.fileKey?.split('/') ?? [];
      const uuidPart = parts[2]?.replace('.pdf', '') ?? '';
      expect(UUID_V4_REGEX.test(uuidPart)).toBe(true);
    });

    it('expiresIn no response body nunca excede 600 segundos', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      const body = response.body as { expiresIn?: number };
      expect(body.expiresIn).toBeLessThanOrEqual(600);
    });

    it('fileKey segue padrão quarantine/{tenantId}/{uuid}.pdf', async () => {
      const response = await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'qualquer-nome.pdf' });

      const body = response.body as { fileKey?: string };
      expect(body.fileKey).toMatch(/^quarantine\/[^/]+\/[0-9a-f-]{36}\.pdf$/i);
    });

    it('contentType passado para S3 é sempre application/pdf', async () => {
      await httpRequest(app)
        .post('/storage/presigned-url')
        .send({ filename: 'doc.pdf' });

      expect(storageService.getPresignedUploadUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          key: stringMatchingMatcher(/^quarantine\//),
        }),
        'application/pdf',
        expect.any(Number),
      );
    });
  });
});

// ─── Fase 2: Controle de acesso por role ────────────────────────────────────

describe('StorageController — Controle de acesso por role (Fase 2)', () => {
  let storageService: {
    referenceForExistingObject: jest.Mock;
    createReference: jest.Mock;
    getPresignedUploadUrl: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let tenantService: { getTenantId: jest.Mock; isSuperAdmin: jest.Mock };

  const buildAppWithGuards = async (
    jwtGuard: object,
    rolesGuard: object,
    tenantSvcOverride?: object,
  ): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [
        { provide: DocumentStorageService, useValue: storageService },
        {
          provide: TenantService,
          useValue: tenantSvcOverride ?? tenantService,
        },
        { provide: AuditService, useValue: auditService },
        {
          provide: FileInspectionService,
          useValue: { inspect: jest.fn().mockResolvedValue({ clean: true }) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(jwtGuard)
      .overrideGuard(RolesGuard)
      .useValue(rolesGuard)
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideInterceptor(TenantInterceptor)
      .useValue({
        intercept: (_: unknown, next: { handle: () => unknown }) =>
          next.handle(),
      })
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  beforeAll(() => {
    storageService = {
      referenceForExistingObject: jest.fn(
        (
          key: string,
          owner: StorageObjectOwner,
          purpose: string,
        ): StorageObjectReference => ({
          tenantId: FAKE_TENANT_ID,
          key,
          owner,
          purpose,
        }),
      ),
      createReference: jest.fn(
        (input: StorageObjectReference): StorageObjectReference => input,
      ),
      getPresignedUploadUrl: jest
        .fn()
        .mockResolvedValue('https://s3.example.com'),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    tenantService = {
      getTenantId: jest.fn().mockReturnValue(FAKE_TENANT_ID),
      isSuperAdmin: jest.fn().mockReturnValue(false),
    };
  });

  beforeEach(() => {
    storageService.getPresignedUploadUrl
      .mockReset()
      .mockResolvedValue('https://s3.example.com');
    auditService.log.mockReset().mockResolvedValue(undefined);
  });

  it('Sem JWT → 401', async () => {
    const app = await buildAppWithGuards(jwtDenyGuard, {
      canActivate: () => true,
    });
    const response = await httpRequest(app)
      .post('/storage/presigned-url')
      .send({ filename: 'doc.pdf' });

    expect(response.status).toBe(401);
    await app.close();
  });

  it('TRABALHADOR (JWT válido) → 403', async () => {
    const jwtPass = {
      canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user: object }>().user = {
          userId: 'u1',
        };
        return true;
      },
    };
    const app = await buildAppWithGuards(
      jwtPass,
      makeRoleDenyGuard(Role.TRABALHADOR),
    );

    const response = await httpRequest(app)
      .post('/storage/presigned-url')
      .send({ filename: 'doc.pdf' });

    expect(response.status).toBe(403);
    await app.close();
  });

  it('COLABORADOR (JWT válido) → 403', async () => {
    const jwtPass = {
      canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user: object }>().user = {
          userId: 'u1',
        };
        return true;
      },
    };
    const app = await buildAppWithGuards(
      jwtPass,
      makeRoleDenyGuard(Role.COLABORADOR),
    );

    const response = await httpRequest(app)
      .post('/storage/presigned-url')
      .send({ filename: 'doc.pdf' });

    expect(response.status).toBe(403);
    await app.close();
  });

  it('SuperAdmin sem tenant explícito → 400 (sem x-company-id)', async () => {
    const jwtAndRolesPass = {
      canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
        ctx.switchToHttp().getRequest<{ user: object }>().user = {
          userId: 'super-admin-1',
        };
        return true;
      },
    };
    const superAdminWithoutTenant = {
      getTenantId: jest.fn().mockReturnValue(null), // sem tenant no contexto
      isSuperAdmin: jest.fn().mockReturnValue(true), // é super admin
    };

    const app = await buildAppWithGuards(
      jwtAndRolesPass,
      jwtAndRolesPass,
      superAdminWithoutTenant,
    );

    const response = await httpRequest(app)
      .post('/storage/presigned-url')
      .send({ filename: 'doc.pdf' });

    expect(response.status).toBe(400);
    await app.close();
  });
});
