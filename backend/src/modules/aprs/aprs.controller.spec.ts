/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  CallHandler,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PERMISSIONS_KEY } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { ForensicAuditInterceptor } from '../../shared/interceptors/forensic-audit.interceptor';
import { REQUEST_TIMEOUT_KEY } from '../../shared/interceptors/timeout.interceptor';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import { PdfRateLimitService } from '../auth/services/pdf-rate-limit.service';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { AprsController } from './aprs.controller';
import { AprsService } from './aprs.service';
import { AprWorkflowService } from './aprs-workflow.service';
import { AprFeatureFlagGuard } from './guards/apr-feature-flag.guard';
import { AprMetricsInterceptor } from './interceptors/apr-metrics.interceptor';

jest.setTimeout(15000);

describe('AprsController (http)', () => {
  const aprId = '11111111-1111-4111-8111-111111111111';
  let currentUser: {
    userId?: string;
    id?: string;
    profile?: { nome?: string | null };
  } = {
    userId: 'user-1',
    profile: { nome: 'Administrador da Empresa' },
  };
  let app: INestApplication;
  let controller: AprsController;

  const aprsService = {
    attachPdf: jest.fn(),
    create: jest.fn(),
    findPaginated: jest.fn(),
    listStoredFiles: jest.fn(),
    getWeeklyBundle: jest.fn(),
    getCapabilities: jest.fn(),
    findOne: jest.fn(),
    getPdfAccess: jest.fn(),
    generateFinalPdf: jest.fn(),
    compareVersions: jest.fn(),
    uploadRiskEvidence: jest.fn(),
    previewExcelImport: jest.fn(),
    approve: jest.fn(),
    reject: jest.fn(),
    finalize: jest.fn(),
  };
  const pdfRateLimitService = {
    checkDownloadLimit: jest.fn(),
  };
  const forensicTrailService = {
    append: jest.fn(),
  };
  const fileInspectionService = {
    inspect: jest.fn().mockResolvedValue({ safe: true }),
  };
  const aprWorkflowService = {
    getWorkflowStatus: jest.fn(),
    processApproval: jest.fn(),
  };

  const getForensicAppendMetadata = (): {
    eventType?: string;
    module?: string;
    entityId?: string;
    userId?: string;
    metadata?: {
      action?: string;
      method?: string;
    };
  } => {
    const calls = forensicTrailService.append.mock.calls as Array<
      [
        {
          eventType?: string;
          module?: string;
          entityId?: string;
          userId?: string;
          metadata?: {
            action?: string;
            method?: string;
          };
        },
      ]
    >;

    return calls[0]?.[0] ?? {};
  };

  beforeEach(() => {
    currentUser = {
      userId: 'user-1',
      profile: { nome: 'Administrador da Empresa' },
    };
    aprsService.attachPdf.mockReset();
    aprsService.create.mockReset();
    aprsService.findPaginated.mockReset();
    aprsService.listStoredFiles.mockReset();
    aprsService.getWeeklyBundle.mockReset();
    aprsService.getCapabilities.mockReset();
    aprsService.findOne.mockReset();
    aprsService.getPdfAccess.mockReset();
    aprsService.generateFinalPdf.mockReset();
    aprsService.compareVersions.mockReset();
    aprsService.uploadRiskEvidence.mockReset();
    aprsService.previewExcelImport.mockReset();
    aprsService.approve.mockReset();
    aprsService.reject.mockReset();
    aprsService.finalize.mockReset();
    aprWorkflowService.getWorkflowStatus.mockReset();
    aprWorkflowService.processApproval.mockReset();
    pdfRateLimitService.checkDownloadLimit.mockReset();
    forensicTrailService.append.mockReset();
    fileInspectionService.inspect.mockClear();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AprsController],
      providers: [
        { provide: AprsService, useValue: aprsService },
        { provide: PdfRateLimitService, useValue: pdfRateLimitService },
        { provide: ForensicTrailService, useValue: forensicTrailService },
        {
          provide: FileInspectionService,
          useValue: fileInspectionService,
        },
        {
          provide: AprWorkflowService,
          useValue: aprWorkflowService,
        },
        ForensicAuditInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<{
            user?: typeof currentUser;
          }>();
          req.user = currentUser;
          return true;
        },
      })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AprFeatureFlagGuard)
      .useValue({ canActivate: () => true })
      .overrideInterceptor(TenantInterceptor)
      .useValue({
        intercept: (
          _context: ExecutionContext,
          next: CallHandler,
        ): Observable<unknown> => next.handle(),
      })
      .overrideInterceptor(AprMetricsInterceptor)
      .useValue({
        intercept: (
          _context: ExecutionContext,
          next: CallHandler,
        ): Observable<unknown> => next.handle(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    controller = moduleRef.get(AprsController);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('retorna 410 no anexo manual de PDF final da APR', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];

    const response = await request(httpServer)
      .post(`/aprs/${aprId}/file`)
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'apr-final.pdf',
        contentType: 'application/pdf',
      })
      .expect(410);

    const body = response.body as { message?: string };
    expect(body.message).toContain(
      'O anexo manual de PDF final da APR foi descontinuado',
    );
    expect(aprsService.attachPdf).not.toHaveBeenCalled();
  });

  it('informa se o motor de regras está disponível para o tenant atual', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.getCapabilities.mockResolvedValue({ rulesEngine: false });

    await request(httpServer)
      .get('/aprs/capabilities')
      .expect(200)
      .expect({ rulesEngine: false });

    expect(aprsService.getCapabilities).toHaveBeenCalledTimes(1);
  });

  it('separa permissões críticas da APR sem reutilizar can_create_apr', () => {
    const prototype = AprsController.prototype;
    const permissionsFor = (methodName: keyof AprsController): string[] => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
      const handler = descriptor?.value as object;
      return Reflect.getMetadata(PERMISSIONS_KEY, handler) as string[];
    };

    expect(permissionsFor('create')).toEqual(['can_create_apr']);
    expect(permissionsFor('update')).toEqual(['can_update_apr']);
    expect(permissionsFor('approvePatch')).toEqual(['can_approve_apr']);
    expect(permissionsFor('rejectPatch')).toEqual(['can_reject_apr']);
    expect(permissionsFor('finalizePatch')).toEqual(['can_finalize_apr']);
    expect(permissionsFor('generateFinalPdf')).toEqual([
      'can_generate_apr_pdf',
    ]);
    expect(permissionsFor('attachFile')).toEqual(['can_import_apr_pdf']);
  });

  it('aceita strings vazias em campos opcionais tipados do risk_items', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.create.mockResolvedValue({
      id: aprId,
      numero: 'APR-001',
      titulo: 'APR Teste',
      data_inicio: '2026-04-30',
      data_fim: '2026-04-30',
      site_id: '11111111-1111-4111-8111-111111111111',
      elaborador_id: '22222222-2222-4222-8222-222222222222',
      risk_items: [],
    });

    await request(httpServer)
      .post('/aprs')
      .send({
        numero: 'APR-001',
        titulo: 'APR Teste',
        data_inicio: '2026-04-30',
        data_fim: '2026-04-30',
        site_id: '11111111-1111-4111-8111-111111111111',
        elaborador_id: '22222222-2222-4222-8222-222222222222',
        risk_items: [
          {
            atividade: 'Atividade A',
            probabilidade: '',
            severidade: '',
            hierarquia_controle: '',
            prazo: '',
          },
        ],
      })
      .expect(201);

    expect(aprsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        risk_items: [
          expect.objectContaining({
            probabilidade: undefined,
            severidade: undefined,
            hierarquia_controle: undefined,
            prazo: undefined,
          }),
        ],
      }),
      'user-1',
      { roleNames: ['Administrador da Empresa'] },
    );
  });

  it('nao consome o rate limit ao abrir os dados da APR', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.findOne.mockResolvedValue({
      id: aprId,
      numero: 'APR-001',
    });

    await request(httpServer).get(`/aprs/${aprId}`).expect(200);

    expect(pdfRateLimitService.checkDownloadLimit).not.toHaveBeenCalled();
    expect(aprsService.findOne).toHaveBeenCalledWith(aprId);
  });

  it('retorna o status do fluxo da APR sem exigir escrita no módulo', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.findOne.mockResolvedValue({
      id: aprId,
      status: 'Aprovada',
      company_id: 'company-1',
      workflowConfigId: 'workflow-1',
    });
    aprWorkflowService.getWorkflowStatus.mockResolvedValue({
      currentStep: null,
      nextStep: null,
      history: [
        {
          id: 'record-1',
          aprId,
          stepOrder: 1,
          roleName: 'Administrador da Empresa',
          approverId: 'user-1',
          action: 'APROVADO',
          reason: null,
          occurredAt: '2026-05-03T20:00:00.000Z',
        },
      ],
      canEdit: false,
      canApprove: false,
      workflowConfig: null,
    });

    await request(httpServer)
      .get(`/aprs/${aprId}/workflow-status`)
      .expect(200)
      .expect(({ body }) => {
        const payload = body as {
          history?: Array<{ action?: string }>;
          canApprove?: boolean;
        };
        expect(payload.history?.[0]?.action).toBe('APROVADO');
        expect(payload.canApprove).toBe(false);
      });

    expect(aprsService.findOne).toHaveBeenCalledWith(aprId);
    expect(aprWorkflowService.getWorkflowStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: aprId }),
      'user-1',
      'Administrador da Empresa',
    );
  });

  it('encaminha filtros operacionais de listagem da APR para o service', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.findPaginated.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      lastPage: 1,
    });

    await request(httpServer)
      .get('/aprs')
      .query({
        page: '2',
        limit: '30',
        search: 'APR-2026',
        status: 'Pendente',
        company_id: 'tenant-forjado',
        site_id: 'site-1',
        responsible_id: 'user-7',
        due_filter: 'next-7-days',
        sort: 'deadline-asc',
      })
      .expect(200);

    expect(aprsService.findPaginated).toHaveBeenCalledWith({
      page: 2,
      limit: 30,
      search: 'APR-2026',
      status: 'Pendente',
      siteId: 'site-1',
      responsibleId: 'user-7',
      dueFilter: 'next-7-days',
      sort: 'deadline-asc',
      isModeloPadrao: undefined,
      contextFilter: undefined,
      userId: 'user-1',
    });
  });

  it('rejeita search malformado na listagem da APR', () => {
    expect(() =>
      controller.findPaginated(
        1,
        20,
        ['forged'] as unknown as string,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).toThrow();

    expect(aprsService.findPaginated).not.toHaveBeenCalled();
  });

  it('ignora company_id do client na listagem de arquivos da APR', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.listStoredFiles.mockResolvedValue([]);

    await request(httpServer)
      .get('/aprs/files/list')
      .query({
        company_id: 'tenant-forjado',
        year: '2026',
        week: '16',
      })
      .expect(200);

    expect(aprsService.listStoredFiles).toHaveBeenCalledWith({
      year: 2026,
      week: 16,
    });
  });

  it('ignora company_id do client no bundle semanal da APR', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.getWeeklyBundle.mockResolvedValue({
      buffer: Buffer.from('apr bundle'),
      fileName: 'apr-bundle.pdf',
    });

    await request(httpServer)
      .get('/aprs/files/weekly-bundle')
      .query({
        company_id: 'tenant-forjado',
        year: '2026',
        week: '16',
      })
      .expect(200);

    expect(aprsService.getWeeklyBundle).toHaveBeenCalledWith({
      year: 2026,
      week: 16,
    });
  });

  it('consome o rate limit ao solicitar o acesso ao PDF final da APR', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.getPdfAccess.mockResolvedValue({
      entityId: aprId,
      hasFinalPdf: true,
      availability: 'ready',
      fileKey: 'documents/company-1/aprs/apr-1/apr-final.pdf',
      folderPath: 'aprs/company-1',
      originalName: 'apr-final.pdf',
      url: 'https://storage.example/apr-final.pdf',
    });

    await request(httpServer)
      .get(`/aprs/${aprId}/pdf`)
      .expect(200)
      .expect(({ body }) => {
        const payload = body as { url?: string; hasFinalPdf?: boolean };
        expect(payload.url).toBe('https://storage.example/apr-final.pdf');
        expect(payload.hasFinalPdf).toBe(true);
      });

    expect(pdfRateLimitService.checkDownloadLimit).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
    );
    expect(aprsService.getPdfAccess).toHaveBeenCalledWith(aprId);
  });

  it('encaminha a evidência fotográfica da APR para o backend com metadata normalizada', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.uploadRiskEvidence.mockResolvedValue({
      id: 'evidence-1',
      originalName: 'evidence.jpg',
      hashSha256: 'hash-1',
    });

    await request(httpServer)
      .post(
        `/aprs/${aprId}/risk-items/22222222-2222-4222-8222-222222222222/evidence`,
      )
      .field('captured_at', '2026-03-16T10:00:00.000Z')
      .field('latitude', '-23.5505')
      .field('longitude', '-46.6333')
      .field('accuracy_m', '5.4')
      .field('device_id', 'unit-test')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xdb]), {
        filename: 'evidence.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);

    expect(aprsService.uploadRiskEvidence).toHaveBeenCalledWith(
      aprId,
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({
        originalname: 'evidence.jpg',
        mimetype: 'image/jpeg',
      }),
      expect.objectContaining({
        captured_at: '2026-03-16T10:00:00.000Z',
        latitude: -23.5505,
        longitude: -46.6333,
        accuracy_m: 5.4,
        device_id: 'unit-test',
      }),
      'user-1',
      expect.any(String),
    );
  });

  it('encaminha o userId explicito para gerar o PDF final oficial da APR', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.generateFinalPdf.mockResolvedValue({
      entityId: aprId,
      generated: true,
      hasFinalPdf: true,
      availability: 'ready',
      fileKey: 'documents/company-1/aprs/apr-1/apr-final.pdf',
      folderPath: 'aprs/company-1',
      originalName: 'apr-final.pdf',
      url: 'https://storage.example/apr-final.pdf',
    });

    await request(httpServer)
      .post(`/aprs/${aprId}/generate-final-pdf`)
      .expect(201)
      .expect(({ body }) => {
        const payload = body as { generated?: boolean; hasFinalPdf?: boolean };
        expect(payload.generated).toBe(true);
        expect(payload.hasFinalPdf).toBe(true);
      });

    expect(aprsService.generateFinalPdf).toHaveBeenCalledWith(aprId, 'user-1');
  });

  it('configura timeout estendido para a geração do PDF final oficial', () => {
    const timeoutMs = Reflect.getMetadata(
      REQUEST_TIMEOUT_KEY,
      Object.getOwnPropertyDescriptor(
        AprsController.prototype,
        'generateFinalPdf',
      )?.value as object,
    ) as number | undefined;

    expect(timeoutMs).toBe(180000);
  });

  it('encaminha a comparação entre versões da APR para o backend', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    const targetId = '22222222-2222-4222-8222-222222222222';
    aprsService.compareVersions.mockResolvedValue({
      base: { id: aprId, numero: 'APR-001', versao: 1 },
      target: { id: targetId, numero: 'APR-001-v2', versao: 2 },
      summary: {
        totalBase: 1,
        totalTarget: 2,
        added: 1,
        removed: 0,
        changed: 1,
      },
      added: [],
      removed: [],
      changed: [],
    });

    await request(httpServer)
      .get(`/aprs/${aprId}/compare/${targetId}`)
      .expect(200)
      .expect(({ body }) => {
        const payload = body as {
          summary?: { changed?: number; totalTarget?: number };
        };
        expect(payload.summary?.changed).toBe(1);
        expect(payload.summary?.totalTarget).toBe(2);
      });

    expect(aprsService.compareVersions).toHaveBeenCalledWith(aprId, targetId);
  });

  it('faz preview da planilha APR antes da persistencia', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.previewExcelImport.mockResolvedValue({
      fileName: 'apr.xlsx',
      sheetName: 'APR',
      importedRows: 1,
      ignoredRows: 0,
      warnings: [],
      errors: [],
      matchedColumns: { atividade_processo: 'Atividade/Processo' },
      draft: {
        numero: 'APR-001',
        risk_items: [],
      },
    });

    await request(httpServer)
      .post('/aprs/import/excel/preview')
      .attach('file', Buffer.from('504b0304140000000800', 'hex'), {
        filename: 'apr.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      .expect(201);

    expect(aprsService.previewExcelImport).toHaveBeenCalledWith(
      expect.any(Buffer),
      'apr.xlsx',
    );
    expect(fileInspectionService.inspect).toHaveBeenCalledWith(
      expect.any(Buffer),
      'apr.xlsx',
    );
  });

  it('aprova a APR via PATCH usando o pipeline forense canonico', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.approve.mockResolvedValue({
      id: aprId,
      status: 'Aprovada',
    });

    await request(httpServer)
      .patch(`/aprs/${aprId}/approve`)
      .send({ reason: 'Aprovacao canonica' })
      .expect(200)
      .expect(({ body }) => {
        const payload = body as { id?: string; status?: string };
        expect(payload.id).toBe(aprId);
        expect(payload.status).toBe('Aprovada');
      });

    expect(aprsService.approve).toHaveBeenCalledWith(
      aprId,
      'user-1',
      'Aprovacao canonica',
      expect.objectContaining({
        roleName: 'Administrador da Empresa',
        ipAddress: expect.any(String),
      }),
    );
    const forensicEvent = getForensicAppendMetadata();
    expect(forensicEvent.eventType).toBe('AUDIT_APPROVE');
    expect(forensicEvent.module).toBe('apr');
    expect(forensicEvent.entityId).toBe(aprId);
    expect(forensicEvent.userId).toBe('user-1');
    expect(forensicEvent.metadata?.action).toBe('approve');
    expect(forensicEvent.metadata?.method).toBe('PATCH');
  });

  it('aprova a APR via POST legado (antes do sunset) passando pela mesma trilha forense', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    // Determinístico: fixa o relógio ANTES do sunset para exercitar o caminho de
    // compatibilidade legado. Em produção, após 2026-06-30, o alias retorna 410
    // (coberto pelos testes de sunset). restoreMocks:true reverte o spy.
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-06-01T00:00:00Z').getTime());
    aprsService.approve.mockResolvedValue({
      id: aprId,
      status: 'Aprovada',
    });

    await request(httpServer)
      .post(`/aprs/${aprId}/approve`)
      .send({ reason: 'Compat legado auditada' })
      .expect(200)
      .expect('Deprecation', 'true')
      .expect('Sunset', 'Tue, 30 Jun 2026 00:00:00 GMT')
      .expect(
        'Warning',
        '299 - "POST /aprs/:id/approve is deprecated; use PATCH /aprs/:id/approve"',
      )
      .expect(({ body }) => {
        const payload = body as { id?: string; status?: string };
        expect(payload.id).toBe(aprId);
        expect(payload.status).toBe('Aprovada');
      });

    expect(aprsService.approve).toHaveBeenCalledWith(
      aprId,
      'user-1',
      'Compat legado auditada',
      expect.objectContaining({
        roleName: 'Administrador da Empresa',
        ipAddress: expect.any(String),
      }),
    );
    const forensicEvent = getForensicAppendMetadata();
    expect(forensicEvent.eventType).toBe('AUDIT_APPROVE');
    expect(forensicEvent.module).toBe('apr');
    expect(forensicEvent.entityId).toBe(aprId);
    expect(forensicEvent.userId).toBe('user-1');
    expect(forensicEvent.metadata?.action).toBe('approve');
    expect(forensicEvent.metadata?.method).toBe('POST');
  });

  it('rejeita a APR via PATCH usando o pipeline forense canonico', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.reject.mockResolvedValue({
      id: aprId,
      status: 'Cancelada',
      reprovado_motivo: 'Motivo canônico',
    });

    await request(httpServer)
      .patch(`/aprs/${aprId}/reject`)
      .send({ reason: 'Motivo canônico' })
      .expect(200)
      .expect(({ body }) => {
        const payload = body as {
          id?: string;
          status?: string;
          reprovado_motivo?: string;
        };
        expect(payload.id).toBe(aprId);
        expect(payload.status).toBe('Cancelada');
        expect(payload.reprovado_motivo).toBe('Motivo canônico');
      });

    expect(aprsService.reject).toHaveBeenCalledWith(
      aprId,
      'user-1',
      'Motivo canônico',
      expect.objectContaining({
        roleName: 'Administrador da Empresa',
        ipAddress: expect.any(String),
      }),
    );
    const forensicEvent = getForensicAppendMetadata();
    expect(forensicEvent.eventType).toBe('AUDIT_REJECT');
    expect(forensicEvent.module).toBe('apr');
    expect(forensicEvent.entityId).toBe(aprId);
    expect(forensicEvent.userId).toBe('user-1');
    expect(forensicEvent.metadata?.action).toBe('reject');
    expect(forensicEvent.metadata?.method).toBe('PATCH');
  });

  it('rejeita a APR via POST legado (antes do sunset) passando pela mesma trilha forense', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-06-01T00:00:00Z').getTime());
    aprsService.reject.mockResolvedValue({
      id: aprId,
      status: 'Cancelada',
      reprovado_motivo: 'Compat legado',
    });

    await request(httpServer)
      .post(`/aprs/${aprId}/reject`)
      .send({ reason: 'Compat legado' })
      .expect(200)
      .expect('Deprecation', 'true')
      .expect('Sunset', 'Tue, 30 Jun 2026 00:00:00 GMT')
      .expect(
        'Warning',
        '299 - "POST /aprs/:id/reject is deprecated; use PATCH /aprs/:id/reject"',
      );

    expect(aprsService.reject).toHaveBeenCalledWith(
      aprId,
      'user-1',
      'Compat legado',
      expect.objectContaining({
        roleName: 'Administrador da Empresa',
        ipAddress: expect.any(String),
      }),
    );
    const forensicEvent = getForensicAppendMetadata();
    expect(forensicEvent.eventType).toBe('AUDIT_REJECT');
    expect(forensicEvent.module).toBe('apr');
    expect(forensicEvent.entityId).toBe(aprId);
    expect(forensicEvent.userId).toBe('user-1');
    expect(forensicEvent.metadata?.action).toBe('reject');
    expect(forensicEvent.metadata?.method).toBe('POST');
  });

  it('encerra a APR via PATCH usando o pipeline forense canonico', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    aprsService.finalize.mockResolvedValue({
      id: aprId,
      status: 'Encerrada',
    });

    await request(httpServer)
      .patch(`/aprs/${aprId}/finalize`)
      .expect(200)
      .expect(({ body }) => {
        const payload = body as { id?: string; status?: string };
        expect(payload.id).toBe(aprId);
        expect(payload.status).toBe('Encerrada');
      });

    expect(aprsService.finalize).toHaveBeenCalledWith(
      aprId,
      'user-1',
      expect.objectContaining({
        roleName: 'Administrador da Empresa',
        ipAddress: expect.any(String),
      }),
    );
    const forensicEvent = getForensicAppendMetadata();
    expect(forensicEvent.eventType).toBe('AUDIT_FINALIZE');
    expect(forensicEvent.module).toBe('apr');
    expect(forensicEvent.entityId).toBe(aprId);
    expect(forensicEvent.userId).toBe('user-1');
    expect(forensicEvent.metadata?.action).toBe('finalize');
    expect(forensicEvent.metadata?.method).toBe('PATCH');
  });

  it('encerra a APR via POST legado (antes do sunset) passando pela mesma trilha forense', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-06-01T00:00:00Z').getTime());
    aprsService.finalize.mockResolvedValue({
      id: aprId,
      status: 'Encerrada',
    });

    await request(httpServer)
      .post(`/aprs/${aprId}/finalize`)
      .expect(200)
      .expect('Deprecation', 'true')
      .expect('Sunset', 'Tue, 30 Jun 2026 00:00:00 GMT')
      .expect(
        'Warning',
        '299 - "POST /aprs/:id/finalize is deprecated; use PATCH /aprs/:id/finalize"',
      );

    expect(aprsService.finalize).toHaveBeenCalledWith(
      aprId,
      'user-1',
      expect.objectContaining({
        roleName: 'Administrador da Empresa',
        ipAddress: expect.any(String),
      }),
    );
    const forensicEvent = getForensicAppendMetadata();
    expect(forensicEvent.eventType).toBe('AUDIT_FINALIZE');
    expect(forensicEvent.module).toBe('apr');
    expect(forensicEvent.entityId).toBe(aprId);
    expect(forensicEvent.userId).toBe('user-1');
    expect(forensicEvent.metadata?.action).toBe('finalize');
    expect(forensicEvent.metadata?.method).toBe('POST');
  });

  it('POST legado de approve retorna 410 Gone após a data de sunset', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-01T00:00:00Z').getTime());

    await request(httpServer)
      .post(`/aprs/${aprId}/approve`)
      .send({ reason: 'test' })
      .expect(410);

    jest.spyOn(Date, 'now').mockRestore();
  });

  it('POST legado de reject retorna 410 Gone após a data de sunset', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-01T00:00:00Z').getTime());

    await request(httpServer)
      .post(`/aprs/${aprId}/reject`)
      .send({ reason: 'Motivo suficientemente longo para passar validação' })
      .expect(410);

    jest.spyOn(Date, 'now').mockRestore();
  });

  it('POST legado de finalize retorna 410 Gone após a data de sunset', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-01T00:00:00Z').getTime());

    await request(httpServer).post(`/aprs/${aprId}/finalize`).expect(410);

    jest.spyOn(Date, 'now').mockRestore();
  });
});
