import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { PdfRateLimitService } from '../auth/services/pdf-rate-limit.service';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { PtsController } from './pts.controller';
import { PtsService } from './pts.service';

jest.setTimeout(15000);

describe('PtsController (http)', () => {
  const ptId = '11111111-1111-4111-8111-111111111111';
  let currentUser: { userId?: string; id?: string } = { userId: 'user-1' };
  let app: INestApplication;

  const ptsService = {
    attachPdf: jest.fn(),
    listStoredFiles: jest.fn(),
    getWeeklyBundle: jest.fn(),
    findOne: jest.fn(),
    getPdfAccess: jest.fn(),
    replaceSignatures: jest.fn(),
    createSignature: jest.fn(),
  };
  const pdfRateLimitService = {
    checkDownloadLimit: jest.fn(),
  };

  beforeEach(() => {
    currentUser = { userId: 'user-1' };
    ptsService.attachPdf.mockReset();
    ptsService.listStoredFiles.mockReset();
    ptsService.getWeeklyBundle.mockReset();
    ptsService.findOne.mockReset();
    ptsService.getPdfAccess.mockReset();
    ptsService.replaceSignatures.mockReset();
    ptsService.createSignature.mockReset();
    pdfRateLimitService.checkDownloadLimit.mockReset();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PtsController],
      providers: [
        {
          provide: PtsService,
          useValue: ptsService,
        },
        {
          provide: PdfRateLimitService,
          useValue: pdfRateLimitService,
        },
        { provide: FileInspectionService, useValue: { inspect: jest.fn() } },
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
      .overrideInterceptor(TenantInterceptor)
      .useValue({
        intercept: (
          _context: ExecutionContext,
          next: CallHandler,
        ): Observable<unknown> => next.handle(),
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('anexa o PDF final quando a PT ja esta aprovada e encaminha userId explicitamente', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.attachPdf.mockResolvedValue({
      fileKey: 'documents/company-1/pts/pt-1/pt-final.pdf',
      folderPath: 'pts/company-1',
      originalName: 'pt-final.pdf',
    });

    await request(httpServer)
      .post(`/pts/${ptId}/file`)
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'pt-final.pdf',
        contentType: 'application/pdf',
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual({
          fileKey: 'documents/company-1/pts/pt-1/pt-final.pdf',
          folderPath: 'pts/company-1',
          originalName: 'pt-final.pdf',
        });
      });

    expect(ptsService.attachPdf).toHaveBeenCalledWith(
      ptId,
      expect.objectContaining({
        originalname: 'pt-final.pdf',
        mimetype: 'application/pdf',
      }),
      'user-1',
    );
  });

  it('usa req.user.id como fallback explicito quando userId nao existir', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    currentUser = { id: 'legacy-user-1' };
    ptsService.attachPdf.mockResolvedValue({
      fileKey: 'documents/company-1/pts/pt-1/pt-final.pdf',
      folderPath: 'pts/company-1',
      originalName: 'pt-final.pdf',
    });

    await request(httpServer)
      .post(`/pts/${ptId}/file`)
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'pt-final.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(ptsService.attachPdf).toHaveBeenCalledWith(
      ptId,
      expect.objectContaining({
        originalname: 'pt-final.pdf',
      }),
      'legacy-user-1',
    );
  });

  it('retorna 400 quando a PT ainda nao esta aprovada para anexo final', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.attachPdf.mockRejectedValue(
      new BadRequestException(
        'A PT precisa estar aprovada antes do anexo do PDF final.',
      ),
    );

    await request(httpServer)
      .post(`/pts/${ptId}/file`)
      .attach('file', Buffer.from('%PDF-1.4 test'), {
        filename: 'pt-final.pdf',
        contentType: 'application/pdf',
      })
      .expect(400)
      .expect(({ body }) => {
        const payload = body as { message?: string };
        expect(payload.message).toBe(
          'A PT precisa estar aprovada antes do anexo do PDF final.',
        );
      });

    expect(ptsService.attachPdf).toHaveBeenCalledWith(
      ptId,
      expect.any(Object),
      'user-1',
    );
  });

  it('nao consome o rate limit ao abrir os dados da PT', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.findOne.mockResolvedValue({
      id: ptId,
      numero: 'PT-001',
    });

    await request(httpServer).get(`/pts/${ptId}`).expect(200);

    expect(pdfRateLimitService.checkDownloadLimit).not.toHaveBeenCalled();
    expect(ptsService.findOne).toHaveBeenCalledWith(ptId);
  });

  it('consome o rate limit ao solicitar o acesso ao PDF final', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.getPdfAccess.mockResolvedValue({
      entityId: ptId,
      fileKey: 'documents/company-1/pts/pt-1/pt-final.pdf',
      folderPath: 'pts/company-1',
      originalName: 'pt-final.pdf',
      url: 'https://storage.example/pt-final.pdf',
    });

    await request(httpServer)
      .get(`/pts/${ptId}/pdf`)
      .expect(200)
      .expect(({ body }) => {
        const payload = body as { url?: string };
        expect(payload.url).toBe('https://storage.example/pt-final.pdf');
      });

    expect(pdfRateLimitService.checkDownloadLimit).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
    );
    expect(ptsService.getPdfAccess).toHaveBeenCalledWith(ptId);
  });

  it('ignora company_id do client na listagem de arquivos da PT', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.listStoredFiles.mockResolvedValue([]);

    await request(httpServer)
      .get('/pts/files/list')
      .query({
        company_id: 'tenant-forjado',
        year: '2026',
        week: '17',
      })
      .expect(200);

    expect(ptsService.listStoredFiles).toHaveBeenCalledWith({
      year: 2026,
      week: 17,
    });
  });

  it('rejeita filtros de ano e semana inválidos nas rotas de arquivos', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];

    await request(httpServer)
      .get('/pts/files/list')
      .query({ year: 'abc', week: '99' })
      .expect(400);

    expect(ptsService.listStoredFiles).not.toHaveBeenCalled();
  });

  it('rejeita semana ISO fora do intervalo permitido', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];

    await request(httpServer)
      .get('/pts/files/list')
      .query({ year: '2026', week: '99' })
      .expect(400);

    expect(ptsService.listStoredFiles).not.toHaveBeenCalled();
  });

  it('ignora company_id do client no bundle semanal da PT', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.getWeeklyBundle.mockResolvedValue({
      buffer: Buffer.from('pt bundle'),
      fileName: 'pt-bundle.pdf',
    });

    await request(httpServer)
      .get('/pts/files/weekly-bundle')
      .query({
        company_id: 'tenant-forjado',
        year: '2026',
        week: '17',
      })
      .expect(200);

    expect(ptsService.getWeeklyBundle).toHaveBeenCalledWith({
      year: 2026,
      week: 17,
    });
  });

  it('encaminha a substituição atômica de assinaturas com o usuário autenticado', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.replaceSignatures.mockResolvedValue({
      entityId: ptId,
      replaced: 1,
    });

    await request(httpServer)
      .put(`/pts/${ptId}/signatures`)
      .send({
        signatures: [
          {
            user_id: '22222222-2222-4222-8222-222222222222',
            signature_data: 'data:image/png;base64,signature',
            type: 'drawn',
          },
        ],
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ entityId: ptId, replaced: 1 });
      });

    expect(ptsService.replaceSignatures).toHaveBeenCalledWith(
      ptId,
      expect.objectContaining({ signatures: expect.any(Array) as unknown }),
      'user-1',
    );
  });

  it('encaminha assinatura avulsa pela rota PT com o usuário autenticado', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    ptsService.createSignature.mockResolvedValue({
      entityId: ptId,
      created: true,
    });

    await request(httpServer)
      .post(`/pts/${ptId}/signatures`)
      .send({
        signature_data: 'data:image/png;base64,signature',
        type: 'drawn',
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual({ entityId: ptId, created: true });
      });

    expect(ptsService.createSignature).toHaveBeenCalledWith(
      ptId,
      expect.objectContaining({
        signature_data: 'data:image/png;base64,signature',
        type: 'drawn',
      }),
      'user-1',
    );
  });
});
