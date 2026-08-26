import {
  CallHandler,
  ExecutionContext,
  INestApplication,
  ValidationPipe,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Observable } from 'rxjs';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../modules/auth/permissions.guard';
import { RolesGuard } from '../../modules/auth/roles.guard';
import { TenantGuard } from '../../shared/guards/tenant.guard';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { TenantInterceptor } from '../../shared/tenant/tenant.interceptor';
import { TenantService } from '../../shared/tenant/tenant.service';
import { MailController } from './mail.controller';
import { MailService } from './mail.service';
import { MailDlqService } from './mail-dlq.service';

jest.setTimeout(15000);

describe('MailController (http)', () => {
  let app: INestApplication;
  let currentUser: {
    company_id?: string;
    companyId?: string;
    userId?: string;
  } = {
    company_id: 'company-1',
    userId: 'user-1',
  };
  let currentTenantContext:
    | {
        companyId: string;
        userId?: string;
        siteId?: string;
        siteIds?: string[];
        siteScope: 'single' | 'all';
        isSuperAdmin: boolean;
      }
    | undefined;

  const mailService = {
    sendStoredDocument: jest.fn(),
    sendStoredFileKey: jest.fn(),
    sendUploadedPdfBuffer: jest.fn(),
    buildDocumentDispatchResponse: jest.fn(),
    assertDispatchAvailable: jest.fn(),
  };

  const mailQueue = {
    add: jest.fn(),
  };

  beforeEach(() => {
    currentUser = {
      company_id: 'company-1',
      userId: 'user-1',
    };
    currentTenantContext = undefined;
    mailService.sendStoredDocument.mockReset();
    mailService.sendStoredFileKey.mockReset();
    mailService.sendUploadedPdfBuffer.mockReset();
    mailService.buildDocumentDispatchResponse.mockReset();
    mailService.assertDispatchAvailable.mockReset();
    mailQueue.add.mockReset();
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MailController],
      providers: [
        {
          provide: MailDlqService,
          useValue: {
            logFailure: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: mailService,
        },
        {
          provide: TenantService,
          useValue: {
            getTenantId: jest.fn(() => 'company-1'),
            isSuperAdmin: jest.fn(() => false),
            getContext: jest.fn(() => currentTenantContext),
          },
        },
        {
          provide: getQueueToken('mail'),
          useValue: mailQueue,
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('bloqueia enqueue de documento quando o runtime de e-mail esta desabilitado', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    mailService.assertDispatchAvailable.mockImplementation(() => {
      throw new ServiceUnavailableException(
        'Envio de e-mail desabilitado por MAIL_ENABLED=false neste runtime.',
      );
    });

    await request(httpServer)
      .post('/mail/send-stored-document')
      .send({
        documentId: 'arr-1',
        documentType: 'ARR',
        email: 'destinatario@example.com',
      })
      .expect(503);

    expect(mailQueue.add).not.toHaveBeenCalled();
  });

  it('rejeita payload inválido no envio de documento armazenado', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];

    await request(httpServer)
      .post('/mail/send-stored-document')
      .send({
        documentId: 'arr-1',
        documentType: 'ARR',
        email: 'email-invalido',
      })
      .expect(400);

    expect(mailQueue.add).not.toHaveBeenCalled();
  });

  it('enfileira envio de documento armazenado com contexto tenant do request', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    mailService.buildDocumentDispatchResponse.mockReturnValue({
      success: true,
      message: 'Solicitação recebida.',
      deliveryMode: 'queued',
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
      documentId: 'cat-1',
      documentType: 'CAT',
    });

    await request(httpServer)
      .post('/mail/send-stored-document')
      .send({
        documentId: 'cat-1',
        documentType: 'CAT',
        email: 'destinatario@example.com',
      })
      .expect(201);

    expect(mailQueue.add).toHaveBeenCalledWith(
      'send-document',
      expect.any(Object),
      expect.any(Object),
    );
    const [, queuedPayload] = mailQueue.add.mock.calls[0] as [
      string,
      {
        documentId: string;
        documentType: string;
        email: string;
        companyId: string;
        tenantContext?: {
          companyId: string;
          siteScope: 'single' | 'all';
        };
      },
    ];
    expect(queuedPayload).toMatchObject({
      documentId: 'cat-1',
      documentType: 'CAT',
      email: 'destinatario@example.com',
      companyId: 'company-1',
    });
    expect(queuedPayload.tenantContext).toMatchObject({
      companyId: 'company-1',
      siteScope: 'all',
    });
    expect(mailService.sendStoredDocument).not.toHaveBeenCalled();
  });

  it('usa o tenant efetivo do header para super admin ao enfileirar documento', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    currentUser = {
      company_id: 'platform-company',
      userId: 'super-admin-1',
    };
    currentTenantContext = {
      companyId: 'tenant-b',
      userId: 'super-admin-1',
      siteScope: 'all',
      siteIds: [],
      isSuperAdmin: true,
    };
    mailService.buildDocumentDispatchResponse.mockReturnValue({
      success: true,
      message: 'Solicitação recebida.',
      deliveryMode: 'queued',
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
      documentId: 'cat-tenant-b',
      documentType: 'CAT',
    });

    await request(httpServer)
      .post('/mail/send-stored-document')
      .send({
        documentId: 'cat-tenant-b',
        documentType: 'CAT',
        email: 'destinatario@example.com',
      })
      .expect(201);

    const [, queuedPayload] = mailQueue.add.mock.calls[0] as [
      string,
      {
        companyId: string;
        tenantContext?: {
          companyId: string;
          isSuperAdmin: boolean;
          siteScope: 'single' | 'all';
        };
      },
    ];

    expect(queuedPayload.companyId).toBe('tenant-b');
    expect(queuedPayload.tenantContext).toMatchObject({
      companyId: 'tenant-b',
      isSuperAdmin: true,
      siteScope: 'all',
    });
  });

  it('degrada para envio síncrono quando a fila de envio oficial está indisponível', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    mailQueue.add.mockRejectedValue(new Error('Redis offline'));
    mailService.sendStoredDocument.mockResolvedValue({
      success: true,
      message: 'Documento enviado.',
      deliveryMode: 'sent',
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
      documentId: 'cat-1',
      documentType: 'CAT',
    });

    await request(httpServer)
      .post('/mail/send-stored-document')
      .send({
        documentId: 'cat-1',
        documentType: 'CAT',
        email: 'destinatario@example.com',
      })
      .expect(201);

    expect(mailQueue.add).toHaveBeenCalledTimes(1);
    expect(mailService.sendStoredDocument).toHaveBeenCalledWith(
      'cat-1',
      'CAT',
      'destinatario@example.com',
      'company-1',
    );
  });

  it('degrada para envio síncrono por buffer quando o storage falha', async () => {
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    mailService.sendUploadedPdfBuffer.mockResolvedValue({
      success: true,
      message:
        'O PDF local foi enviado por e-mail. Este envio não substitui o documento final governado.',
      deliveryMode: 'sent',
      artifactType: 'local_uploaded_pdf',
      isOfficial: false,
      fallbackUsed: true,
    });

    await request(httpServer)
      .post('/mail/send-uploaded-document')
      .field('email', 'destinatario@example.com')
      .field('docName', 'RDO Teste')
      .attach('file', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'), {
        filename: 'rdo.pdf',
        contentType: 'application/pdf',
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          success: true,
          deliveryMode: 'sent',
          artifactType: 'local_uploaded_pdf',
          isOfficial: false,
          fallbackUsed: true,
        });
      });

    expect(mailQueue.add).not.toHaveBeenCalled();
    expect(mailService.sendUploadedPdfBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      'destinatario@example.com',
      expect.objectContaining({
        docName: 'RDO Teste',
        companyId: 'company-1',
        userId: 'user-1',
      }),
    );
  });
});
