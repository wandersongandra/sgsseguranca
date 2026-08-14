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
import { PermissionsGuard } from '../auth/permissions.guard';
import { RolesGuard } from '../auth/roles.guard';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { NonConformitiesController } from './nonconformities.controller';
import { NonConformitiesService } from './nonconformities.service';
import { NonConformitiesPdfService } from './services/nonconformities-pdf.service';
import { NonConformityResponseDto } from './dto/nonconformity-response.dto';

describe('NonConformitiesController (http)', () => {
  let app: INestApplication;

  const nonConformitiesService = {
    findPaginated: jest.fn(),
    listStoredFiles: jest.fn(),
    getWeeklyBundle: jest.fn(),
    removeAttachment: jest.fn(),
  };

  const nonConformitiesPdfService = {
    generateFinalPdf: jest.fn(),
  };

  beforeEach(() => {
    nonConformitiesService.findPaginated.mockReset();
    nonConformitiesService.listStoredFiles.mockReset();
    nonConformitiesService.getWeeklyBundle.mockReset();
    nonConformitiesService.removeAttachment.mockReset();
    nonConformitiesPdfService.generateFinalPdf.mockReset();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NonConformitiesController],
      providers: [
        {
          provide: NonConformitiesService,
          useValue: nonConformitiesService,
        },
        {
          provide: NonConformitiesPdfService,
          useValue: nonConformitiesPdfService,
        },
        {
          provide: FileInspectionService,
          useValue: { inspectBuffer: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
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
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('valida paginação e busca da listagem de NC via DTO dedicado', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    const mockPage = {
      data: [
        // SECURITY: service returns NonConformityResponseDto instances (or shapes) with internal keys stripped
        {
          id: 'nc-1',
          codigo_nc: 'NC-001',
          company_id: 'c1',
        } as unknown as NonConformityResponseDto,
      ],
      total: 1,
      page: 2,
      limit: 30,
    };
    nonConformitiesService.findPaginated.mockResolvedValue(mockPage);

    const res = await request(httpServer)
      .get('/nonconformities')
      .query({
        page: '2',
        limit: '30',
        search: '  solda  ',
      })
      .expect(200);

    // SECURITY: responses from service use NonConformityResponseDto (no raw internal storage keys)
    expect((res.body as { data?: unknown }).data).toBeDefined();
    expect(nonConformitiesService.findPaginated).toHaveBeenCalledWith({
      page: 2,
      limit: 30,
      search: 'solda',
    });
  });

  it('rejeita limit fora da faixa válida na listagem de NC', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];

    await request(httpServer)
      .get('/nonconformities')
      .query({ limit: '500' })
      .expect(400);

    expect(nonConformitiesService.findPaginated).not.toHaveBeenCalled();
  });

  it('ignora company_id do client na listagem de arquivos de NC', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    nonConformitiesService.listStoredFiles.mockResolvedValue([]);

    await request(httpServer)
      .get('/nonconformities/files/list')
      .query({
        company_id: 'tenant-forjado',
        year: '2026',
        week: '22',
      })
      .expect(200);

    expect(nonConformitiesService.listStoredFiles).toHaveBeenCalledWith({
      year: 2026,
      week: 22,
    });
  });

  it('rejeita semana inválida na listagem de arquivos de NC', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];

    await request(httpServer)
      .get('/nonconformities/files/list')
      .query({ week: '99' })
      .expect(400);

    expect(nonConformitiesService.listStoredFiles).not.toHaveBeenCalled();
  });

  it('bloqueia upload manual de PDF final para preservar a emissão oficial', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];

    await request(httpServer)
      .post('/nonconformities/11111111-1111-4111-8111-111111111111/file')
      .expect(410);
  });

  it('encaminha a remoção imediata de anexo governado pelo endpoint dedicado', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    nonConformitiesService.removeAttachment.mockResolvedValue({
      entityId: '11111111-1111-4111-8111-111111111111',
      attachments: [],
      attachmentCount: 0,
      removedAttachmentReference: 'gst:nc-attachment:ref',
      storageCleanup: 'removed',
      message: 'Anexo removido da não conformidade e do storage oficial.',
    });

    await request(httpServer)
      .delete(
        '/nonconformities/11111111-1111-4111-8111-111111111111/attachments/0',
      )
      .expect(200);

    expect(nonConformitiesService.removeAttachment).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      0,
    );
  });

  it('ignora company_id do client no bundle semanal de NC', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    nonConformitiesService.getWeeklyBundle.mockResolvedValue({
      buffer: Buffer.from('nc bundle'),
      fileName: 'nc.pdf',
    });

    await request(httpServer)
      .get('/nonconformities/files/weekly-bundle')
      .query({
        company_id: 'tenant-forjado',
        year: '2026',
        week: '22',
      })
      .expect(200);

    expect(nonConformitiesService.getWeeklyBundle).toHaveBeenCalledWith({
      year: 2026,
      week: 22,
    });
  });
});
