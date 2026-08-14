import { Test, TestingModule } from '@nestjs/testing';
import { MailService } from './mail.service';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import nodemailer from 'nodemailer';
import { MailLog } from './entities/mail-log.entity';
import { EpisService } from '../../modules/epis/epis.service';
import { TrainingsService } from '../../modules/trainings/trainings.service';
import { PtsService } from '../../modules/pts/pts.service';
import { AprsService } from '../../modules/aprs/aprs.service';
import { ArrsService } from '../../modules/arrs/arrs.service';
import { Checklist } from '../../modules/checklists/entities/checklist.entity';
import { NonConformitiesService } from '../../modules/nonconformities/nonconformities.service';
import { DdsService } from '../../modules/dds/dds.service';
import { DidsService } from '../../modules/dids/dids.service';
import { AuditsService } from '../../modules/audits/audits.service';
import { RdosService } from '../../modules/rdos/rdos.service';
import { CompaniesService } from '../../modules/companies/companies.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import {
  ServiceUnavailableException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ReportsService } from '../../modules/reports/reports.service';
import { IntegrationResilienceService } from '../../shared/resilience/integration-resilience.service';
import { DistributedLockService } from '../../shared/redis/distributed-lock.service';
import { Cat } from '../../modules/cats/entities/cat.entity';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { PrivilegedDbService } from '../../shared/database/privileged-db.service';

// Mock do Resend
const mockResendSend = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => ({
      emails: {
        send: mockResendSend,
      },
    })),
  };
});

type MailLogRepositoryMock = {
  create: jest.Mock<Partial<MailLog>, [Partial<MailLog>]>;
  save: jest.Mock<Promise<MailLog & { id: string }>, [Partial<MailLog>]>;
  createQueryBuilder: jest.Mock;
  manager: {
    query: jest.Mock<
      Promise<Array<{ company_id?: string }>>,
      [string, unknown[]]
    >;
  };
};

type PtDocument = Awaited<ReturnType<PtsService['findOne']>>;
type ArrDocument = Awaited<ReturnType<ArrsService['findOne']>>;
type DidDocument = Awaited<ReturnType<DidsService['findOne']>>;
type MailServiceWithScheduledAlerts = {
  runScheduledAlerts(): Promise<void>;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);
const getFirstMockArgument = (mockFn: jest.Mock): unknown => {
  const calls = mockFn.mock.calls as unknown[][];
  const firstCall = calls[0];
  return isUnknownArray(firstCall) ? firstCall[0] : undefined;
};

describe('MailService', () => {
  const originalApiCronsDisabled = process.env.API_CRONS_DISABLED;
  let loggerErrorSpy: jest.SpyInstance;
  let service: MailService;
  let documentStorageService: DocumentStorageService;
  let ptsService: PtsService;
  let arrsService: ArrsService;
  let didsService: DidsService;
  let mailLogRepository: MailLogRepositoryMock;

  const mockMailLogRepository: MailLogRepositoryMock = {
    create: jest.fn((dto: Partial<MailLog>) => dto),
    save: jest.fn((log: Partial<MailLog>) =>
      Promise.resolve({ ...(log as MailLog), id: 'log-123' }),
    ),
    createQueryBuilder: jest.fn(),
    manager: {
      query: jest
        .fn<Promise<Array<{ company_id?: string }>>, [string, unknown[]]>()
        .mockResolvedValue([]),
    },
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'RESEND_API_KEY') return 're_123456';
      if (key === 'MAIL_FROM_EMAIL') return 'test@example.com';
      return null;
    }),
  };

  const mockDocumentStorageService = {
    getPresignedDownloadUrl: jest.fn(),
    downloadFileBuffer: jest.fn(),
  };
  const mockCatsRepository = {
    findOne: jest.fn(),
  };
  const mockChecklistRepository = {
    findOne: jest.fn(),
  };

  // Mock dos serviços de domínio
  const mockDomainService = {
    findOne: jest.fn(),
    getPdfAccess: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    findAllActive: jest.fn().mockResolvedValue([]),
  };

  const mockTenantService = {
    run: jest.fn((_ctx: unknown, cb: () => unknown) => cb()),
    getContext: jest.fn<ReturnType<TenantService['getContext']>, []>(
      () => undefined,
    ),
    getTenantId: jest.fn((): string | undefined => 'company-1'),
  };
  const mockIntegrationResilienceService = {
    execute: jest.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  };
  const mockDistributedLockService = {
    tryAcquire: jest.fn(() =>
      Promise.resolve({
        key: 'lock:mail:scheduled-alerts',
        token: 'token-1',
      }),
    ),
    release: jest.fn(() => Promise.resolve(true)),
  };

  beforeEach(async () => {
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: ConfigService, useValue: mockConfigService },
        {
          provide: getRepositoryToken(MailLog),
          useValue: mockMailLogRepository,
        },
        {
          provide: getRepositoryToken(Cat),
          useValue: mockCatsRepository,
        },
        {
          provide: DocumentStorageService,
          useValue: mockDocumentStorageService,
        },
        { provide: EpisService, useValue: mockDomainService },
        { provide: TrainingsService, useValue: mockDomainService },
        { provide: PtsService, useValue: mockDomainService },
        { provide: AprsService, useValue: mockDomainService },
        { provide: ArrsService, useValue: mockDomainService },
        {
          provide: getRepositoryToken(Checklist),
          useValue: mockChecklistRepository,
        },
        { provide: NonConformitiesService, useValue: mockDomainService },
        { provide: DdsService, useValue: mockDomainService },
        { provide: DidsService, useValue: mockDomainService },
        { provide: AuditsService, useValue: mockDomainService },
        { provide: RdosService, useValue: mockDomainService },
        { provide: CompaniesService, useValue: mockDomainService },
        { provide: TenantService, useValue: mockTenantService },
        { provide: ReportsService, useValue: mockDomainService },
        {
          provide: IntegrationResilienceService,
          useValue: mockIntegrationResilienceService,
        },
        {
          provide: DistributedLockService,
          useValue: mockDistributedLockService,
        },
        {
          provide: PrivilegedDbService,
          useValue: {
            isEnabled: jest.fn(() => false),
            withPrivilegedClient: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<MailService>(MailService);
    documentStorageService = module.get<DocumentStorageService>(
      DocumentStorageService,
    );
    ptsService = module.get<PtsService>(PtsService);
    arrsService = module.get<ArrsService>(ArrsService);
    didsService = module.get<DidsService>(DidsService);
    mailLogRepository = module.get<MailLogRepositoryMock>(
      getRepositoryToken(MailLog),
    );
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
    process.env.API_CRONS_DISABLED = originalApiCronsDisabled;
    jest.clearAllMocks();
  });

  it('deve estar definido', () => {
    expect(service).toBeDefined();
  });

  it('não emite warning de provedor ausente quando MAIL_ENABLED=false', async () => {
    const loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const loggerLogSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const disabledConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'MAIL_ENABLED') return 'false';
        return null;
      }),
    };

    const disabledModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: ConfigService, useValue: disabledConfigService },
        {
          provide: getRepositoryToken(MailLog),
          useValue: mockMailLogRepository,
        },
        {
          provide: getRepositoryToken(Cat),
          useValue: mockCatsRepository,
        },
        {
          provide: DocumentStorageService,
          useValue: mockDocumentStorageService,
        },
        { provide: EpisService, useValue: mockDomainService },
        { provide: TrainingsService, useValue: mockDomainService },
        { provide: PtsService, useValue: mockDomainService },
        { provide: AprsService, useValue: mockDomainService },
        { provide: ArrsService, useValue: mockDomainService },
        {
          provide: getRepositoryToken(Checklist),
          useValue: mockChecklistRepository,
        },
        { provide: NonConformitiesService, useValue: mockDomainService },
        { provide: DdsService, useValue: mockDomainService },
        { provide: DidsService, useValue: mockDomainService },
        { provide: AuditsService, useValue: mockDomainService },
        { provide: RdosService, useValue: mockDomainService },
        { provide: CompaniesService, useValue: mockDomainService },
        { provide: TenantService, useValue: mockTenantService },
        { provide: ReportsService, useValue: mockDomainService },
        {
          provide: IntegrationResilienceService,
          useValue: mockIntegrationResilienceService,
        },
        {
          provide: DistributedLockService,
          useValue: mockDistributedLockService,
        },
        {
          provide: PrivilegedDbService,
          useValue: {
            isEnabled: jest.fn(() => false),
            withPrivilegedClient: jest.fn(),
          },
        },
      ],
    }).compile();

    try {
      const disabledService = disabledModule.get<MailService>(MailService);
      const disabledScheduler =
        disabledService as unknown as MailServiceWithScheduledAlerts;

      expect(loggerLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('MAIL_ENABLED=false'),
      );
      expect(loggerWarnSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'MAIL_PROVIDER_NOT_CONFIGURED',
        }),
      );

      await disabledScheduler.runScheduledAlerts();

      expect(mockDistributedLockService.tryAcquire).not.toHaveBeenCalled();
      expect(loggerWarnSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'MAIL_PROVIDER_NOT_CONFIGURED',
        }),
      );

      let error: unknown;
      try {
        await disabledService.sendMailSimple(
          'user@example.com',
          'Assunto',
          'Texto',
        );
      } catch (caughtError) {
        error = caughtError;
      }

      if (!(error instanceof ServiceUnavailableException)) {
        throw new Error('MAIL_ENABLED=false deveria bloquear envio.');
      }

      expect(error.getResponse()).toMatchObject({
        code: 'MAIL_DISABLED',
      });
    } finally {
      await disabledModule.close();
      loggerWarnSpy.mockRestore();
      loggerLogSpy.mockRestore();
    }
  });

  describe('sendMailSimple', () => {
    it('deve enviar um email com sucesso e salvar o log', async () => {
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-123' },
        error: null,
      });

      const result = await service.sendMailSimple(
        'user@example.com',
        'Assunto Teste',
        'Conteúdo do email',
        { companyId: 'comp-1', userId: 'user-1' },
      );

      const sendPayload = getFirstMockArgument(mockResendSend);
      if (!isRecord(sendPayload)) {
        throw new Error('Payload do Resend não foi registrado corretamente.');
      }

      const createdLog = mailLogRepository.create.mock.calls[0]?.[0];
      if (!isRecord(createdLog)) {
        throw new Error('Log de e-mail não foi criado corretamente.');
      }

      expect(sendPayload.to).toBe('user@example.com');
      expect(sendPayload.subject).toBe('Assunto Teste');
      expect(createdLog.status).toBe('sent');
      expect(createdLog.message_id).toBe('msg-123');
      expect(mailLogRepository.save).toHaveBeenCalled();

      if (!isRecord(result.info) || !isRecord(result.info.data)) {
        throw new Error('Resposta do envio não retornou o payload esperado.');
      }

      expect(result.info.data.id).toBe('msg-123');
    });

    it('continua reportando sucesso quando o log de sucesso falha após a entrega', async () => {
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-123' },
        error: null,
      });
      mailLogRepository.save.mockRejectedValueOnce(
        new Error('database unavailable'),
      );

      await expect(
        service.sendMailSimple(
          'user@example.com',
          'Assunto Teste',
          'Conteúdo do email',
          { companyId: 'comp-1', userId: 'user-1' },
        ),
      ).resolves.toMatchObject({
        usingTestAccount: false,
        info: {
          data: { id: 'msg-123' },
          provider: 'resend',
        },
      });
    });

    it('resolve o tenant pelo userId antes de persistir mail_logs', async () => {
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-123' },
        error: null,
      });
      mockTenantService.getTenantId.mockReturnValueOnce(undefined);
      mailLogRepository.manager.query.mockResolvedValueOnce([
        { company_id: 'company-1' },
      ]);

      await service.sendMailSimple(
        'user@example.com',
        'Assunto Teste',
        'Conteúdo do email',
        { userId: 'user-1' },
      );

      expect(mailLogRepository.manager.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM _ctx, users u'),
        ['user-1'],
      );
      expect(mockTenantService.run).toHaveBeenCalledWith(
        {
          companyId: 'company-1',
          userId: 'user-1',
          isSuperAdmin: false,
        },
        expect.any(Function),
      );
      expect(mailLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          company_id: 'company-1',
          user_id: 'user-1',
          status: 'sent',
        }),
      );
      expect(mailLogRepository.save).toHaveBeenCalled();
    });

    it('nao persiste mail_logs quando nao ha tenant resolvido', async () => {
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-123' },
        error: null,
      });
      mockTenantService.getTenantId.mockReturnValueOnce(undefined);
      mailLogRepository.manager.query.mockResolvedValueOnce([]);

      await service.sendMailSimple(
        'user@example.com',
        'Assunto Teste',
        'Conteúdo do email',
        { userId: 'user-1' },
      );

      expect(mailLogRepository.create).not.toHaveBeenCalled();
      expect(mailLogRepository.save).not.toHaveBeenCalled();
    });

    it('deve lançar ServiceUnavailableException e salvar log de erro quando o Resend falhar', async () => {
      const errorMsg = 'API Key inválida';
      mockResendSend.mockResolvedValue({
        data: null,
        error: { message: errorMsg },
      });

      await expect(
        service.sendMailSimple('user@example.com', 'Assunto', 'Texto'),
      ).rejects.toThrow(ServiceUnavailableException);

      const createdLog = mailLogRepository.create.mock.calls[0]?.[0];
      if (!isRecord(createdLog)) {
        throw new Error('Log de erro do Resend não foi criado.');
      }

      expect(createdLog.status).toBe('failed');
      expect(createdLog.error_message).toEqual(
        expect.stringContaining(errorMsg),
      );
      expect(mailLogRepository.save).toHaveBeenCalled();
    });

    it('deve capturar exceções inesperadas durante o envio', async () => {
      mockResendSend.mockRejectedValue(new Error('Erro de rede'));

      await expect(
        service.sendMailSimple('user@example.com', 'Assunto', 'Texto'),
      ).rejects.toThrow(ServiceUnavailableException);

      const createdLog = mailLogRepository.create.mock.calls[0]?.[0];
      if (!isRecord(createdLog)) {
        throw new Error('Log de exceção de envio não foi criado.');
      }

      expect(createdLog.status).toBe('failed');
      expect(createdLog.error_message).toBe('Erro de rede');
    });

    it('usa timeout configurado para SMTP no transporte e no wrapper resiliente', async () => {
      const smtpSendMail = jest.fn().mockResolvedValue({
        messageId: 'smtp-1',
        accepted: ['smtp@example.com'],
        rejected: [],
        response: '250 OK',
      });
      const smtpTransport = {
        sendMail: smtpSendMail,
      } as unknown as nodemailer.Transporter;
      const createTransportSpy = jest.spyOn(nodemailer, 'createTransport');
      createTransportSpy.mockImplementation(
        (() => smtpTransport) as typeof nodemailer.createTransport,
      );
      const smtpConfigService = {
        get: jest.fn((key: string) => {
          switch (key) {
            case 'MAIL_HOST':
              return 'smtp.example.com';
            case 'MAIL_USER':
              return 'smtp-user';
            case 'MAIL_PASS':
              return 'smtp-pass';
            case 'MAIL_PORT':
              return '2525';
            case 'MAIL_SECURE':
              return 'false';
            case 'SMTP_EMAIL_TIMEOUT_MS':
              return '30000';
            case 'MAIL_FROM_EMAIL':
              return 'test@example.com';
            case 'MAIL_FROM_NAME':
              return 'SGS';
            default:
              return null;
          }
        }),
      };

      const smtpModule = await Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: smtpConfigService },
          {
            provide: getRepositoryToken(MailLog),
            useValue: mockMailLogRepository,
          },
          {
            provide: getRepositoryToken(Cat),
            useValue: mockCatsRepository,
          },
          {
            provide: DocumentStorageService,
            useValue: mockDocumentStorageService,
          },
          { provide: EpisService, useValue: mockDomainService },
          { provide: TrainingsService, useValue: mockDomainService },
          { provide: PtsService, useValue: mockDomainService },
          { provide: AprsService, useValue: mockDomainService },
          { provide: ArrsService, useValue: mockDomainService },
          {
            provide: getRepositoryToken(Checklist),
            useValue: mockChecklistRepository,
          },
          { provide: NonConformitiesService, useValue: mockDomainService },
          { provide: DdsService, useValue: mockDomainService },
          { provide: DidsService, useValue: mockDomainService },
          { provide: AuditsService, useValue: mockDomainService },
          { provide: RdosService, useValue: mockDomainService },
          { provide: CompaniesService, useValue: mockDomainService },
          { provide: TenantService, useValue: mockTenantService },
          { provide: ReportsService, useValue: mockDomainService },
          {
            provide: IntegrationResilienceService,
            useValue: mockIntegrationResilienceService,
          },
          {
            provide: DistributedLockService,
            useValue: mockDistributedLockService,
          },
          {
            provide: PrivilegedDbService,
            useValue: {
              isEnabled: jest.fn(() => false),
              withPrivilegedClient: jest.fn(),
            },
          },
        ],
      }).compile();

      const smtpService = smtpModule.get<MailService>(MailService);

      await smtpService.sendMailSimple(
        'smtp@example.com',
        'Assunto SMTP',
        'Conteudo SMTP',
      );

      expect(createTransportSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 2525,
          connectionTimeout: 30000,
          greetingTimeout: 30000,
          socketTimeout: 30000,
        }),
      );
      expect(mockIntegrationResilienceService.execute).toHaveBeenCalledWith(
        'smtp_email',
        expect.any(Function),
        expect.objectContaining({
          timeoutMs: 30000,
          retry: { attempts: 2, mode: 'safe' },
        }),
      );

      await smtpModule.close();
      createTransportSpy.mockRestore();
    });
  });

  describe('sendStoredDocument', () => {
    it('deve enviar um documento PT corretamente', async () => {
      const mockPt: PtDocument = {
        id: 'pt-1',
        numero: '123',
        pdf_file_key: 'pts/arquivo.pdf',
      } as unknown as PtDocument;
      const findPtSpy = jest
        .spyOn(ptsService, 'findOne')
        .mockResolvedValue(mockPt);
      const downloadBufferSpy = jest
        .spyOn(documentStorageService, 'downloadFileBuffer')
        .mockResolvedValue(Buffer.from('pdf-content'));
      mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

      const result = await service.sendStoredDocument(
        'pt-1',
        'PT',
        'destinatario@example.com',
      );

      expect(findPtSpy).toHaveBeenCalledWith('pt-1');
      expect(downloadBufferSpy).toHaveBeenCalledWith('pts/arquivo.pdf');
      const sendPayload = getFirstMockArgument(mockResendSend);
      if (!isRecord(sendPayload) || !isUnknownArray(sendPayload.attachments)) {
        throw new Error('Payload do Resend para PT não contém anexos válidos.');
      }

      expect(sendPayload.to).toBe('destinatario@example.com');
      expect(String(sendPayload.subject)).toContain(
        'Permissão de Trabalho #123',
      );
      const firstAttachment = sendPayload.attachments[0];
      if (!isRecord(firstAttachment)) {
        throw new Error('Anexo do PT não foi serializado corretamente.');
      }
      expect(String(firstAttachment.filename)).toContain('.pdf');
      expect(mailLogRepository.save).toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        artifactType: 'governed_final_pdf',
        isOfficial: true,
        fallbackUsed: false,
        documentId: 'pt-1',
        documentType: 'PT',
      });
    });

    it('deve lançar NotFoundException se o documento não for encontrado no serviço de origem', async () => {
      jest
        .spyOn(ptsService, 'findOne')
        .mockRejectedValue(new NotFoundException());

      await expect(
        service.sendStoredDocument('pt-invalida', 'PT', 'email@test.com'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve lançar NotFoundException se o documento não tiver chave de arquivo (pdf_file_key)', async () => {
      const mockPtSemArquivo: PtDocument = {
        id: 'pt-1',
        numero: '123',
        pdf_file_key: null,
      } as unknown as PtDocument;
      jest.spyOn(ptsService, 'findOne').mockResolvedValue(mockPtSemArquivo);

      await expect(
        service.sendStoredDocument('pt-1', 'PT', 'email@test.com'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve enviar uma ARR com PDF final governado', async () => {
      const arr: ArrDocument = {
        id: 'arr-1',
        titulo: 'Bloqueio de área quente',
        pdf_file_key: 'documents/company-1/arrs/arr-1/arr-final.pdf',
      } as ArrDocument;
      const findArrSpy = jest
        .spyOn(arrsService, 'findOne')
        .mockResolvedValue(arr);
      const downloadBufferSpy = jest
        .spyOn(documentStorageService, 'downloadFileBuffer')
        .mockResolvedValue(Buffer.from('arr-pdf'));
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-arr-1' },
        error: null,
      });

      const result = await service.sendStoredDocument(
        'arr-1',
        'ARR',
        'destinatario@example.com',
      );

      expect(findArrSpy).toHaveBeenCalledWith('arr-1');
      expect(downloadBufferSpy).toHaveBeenCalledWith(
        'documents/company-1/arrs/arr-1/arr-final.pdf',
      );
      expect(result).toMatchObject({
        success: true,
        artifactType: 'governed_final_pdf',
        isOfficial: true,
        fallbackUsed: false,
        documentId: 'arr-1',
        documentType: 'ARR',
      });
    });

    it('restringe envio de CAT ao escopo de obra da requisicao', async () => {
      const requestContextGetSpy = jest
        .spyOn(RequestContext, 'get')
        .mockReturnValue(undefined);
      try {
        mockTenantService.getContext.mockReturnValue({
          companyId: 'company-1',
          userId: 'user-1',
          isSuperAdmin: false,
          siteScope: 'single',
          siteIds: ['site-1'],
        });
        mockCatsRepository.findOne.mockResolvedValue({
          id: 'cat-1',
          numero: 'CAT-2026-0001',
          pdf_file_key: 'documents/company-1/cats/cat-1/final.pdf',
        });
        jest
          .spyOn(documentStorageService, 'downloadFileBuffer')
          .mockResolvedValue(Buffer.from('cat-pdf'));
        mockResendSend.mockResolvedValue({
          data: { id: 'msg-cat-1' },
          error: null,
        });

        await service.sendStoredDocument(
          'cat-1',
          'CAT',
          'destinatario@example.com',
          'company-1',
        );

        const [findOptions] = mockCatsRepository.findOne.mock.calls[0] as [
          { where: { company_id: string; site_id: unknown } },
        ];

        expect(findOptions.where.company_id).toBe('company-1');
        expect(findOptions.where.site_id).toBeDefined();
      } finally {
        mockTenantService.getContext.mockReturnValue(undefined);
        requestContextGetSpy.mockRestore();
      }
    });

    it('usa companyId explicito quando nao ha contexto tenant para CAT', async () => {
      mockTenantService.getContext.mockReturnValueOnce(undefined);
      mockCatsRepository.findOne.mockResolvedValue({
        id: 'cat-1',
        numero: 'CAT-2026-0001',
        pdf_file_key: 'documents/company-1/cats/cat-1/final.pdf',
      });
      jest
        .spyOn(documentStorageService, 'downloadFileBuffer')
        .mockResolvedValue(Buffer.from('cat-pdf'));
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-cat-1' },
        error: null,
      });

      await service.sendStoredDocument(
        'cat-1',
        'CAT',
        'destinatario@example.com',
        'company-1',
      );

      const [findOptions] = mockCatsRepository.findOne.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];

      expect(findOptions.where.company_id).toBe('company-1');
      expect(findOptions.where).not.toHaveProperty('site_id');
    });

    it('deve enviar um DID com PDF final governado', async () => {
      const did: DidDocument = {
        id: 'did-1',
        titulo: 'Alinhamento de campo',
        pdf_file_key: 'documents/company-1/dids/did-1/did-final.pdf',
      } as DidDocument;
      const findDidSpy = jest
        .spyOn(didsService, 'findOne')
        .mockResolvedValue(did);
      const downloadBufferSpy = jest
        .spyOn(documentStorageService, 'downloadFileBuffer')
        .mockResolvedValue(Buffer.from('did-pdf'));
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-did-1' },
        error: null,
      });

      const result = await service.sendStoredDocument(
        'did-1',
        'DID',
        'destinatario@example.com',
      );

      expect(findDidSpy).toHaveBeenCalledWith('did-1');
      expect(downloadBufferSpy).toHaveBeenCalledWith(
        'documents/company-1/dids/did-1/did-final.pdf',
      );
      expect(result).toMatchObject({
        success: true,
        artifactType: 'governed_final_pdf',
        isOfficial: true,
        fallbackUsed: false,
        documentId: 'did-1',
        documentType: 'DID',
      });
    });

    it('deve lançar erro para tipos de documento não suportados', async () => {
      await expect(
        service.sendStoredDocument('id', 'TIPO_INVALIDO', 'email@test.com'),
      ).rejects.toThrow('Tipo de documento não suportado');
    });

    it('deve enviar uma APR com PDF final governado', async () => {
      const mockApr = {
        id: 'apr-1',
        titulo: 'APR Trabalho em Altura',
        pdf_file_key: 'documents/company-1/aprs/apr-1/apr-final.pdf',
      };
      const findAprSpy = jest
        .spyOn(service['aprsService'], 'findOne')
        .mockResolvedValue(mockApr as never);
      const downloadBufferSpy = jest
        .spyOn(documentStorageService, 'downloadFileBuffer')
        .mockResolvedValue(Buffer.from('apr-pdf'));
      mockResendSend.mockResolvedValue({
        data: { id: 'msg-apr-1' },
        error: null,
      });

      const result = await service.sendStoredDocument(
        'apr-1',
        'APR',
        'destinatario@example.com',
      );

      expect(findAprSpy).toHaveBeenCalledWith('apr-1');
      expect(downloadBufferSpy).toHaveBeenCalledWith(
        'documents/company-1/aprs/apr-1/apr-final.pdf',
      );
      expect(result).toMatchObject({
        success: true,
        artifactType: 'governed_final_pdf',
        isOfficial: true,
        fallbackUsed: false,
        documentId: 'apr-1',
        documentType: 'APR',
      });
      const sendPayload = getFirstMockArgument(mockResendSend);
      if (!isRecord(sendPayload)) {
        throw new Error('Payload do Resend para APR não registrado.');
      }
      expect(String(sendPayload.subject)).toContain(
        'APR: APR Trabalho em Altura',
      );
    });

    it('deve lançar NotFoundException quando APR não tem pdf_file_key', async () => {
      jest.spyOn(service['aprsService'], 'findOne').mockResolvedValue({
        id: 'apr-2',
        titulo: 'APR Sem PDF',
        pdf_file_key: null,
      } as never);

      await expect(
        service.sendStoredDocument('apr-2', 'APR', 'email@test.com'),
      ).rejects.toThrow(NotFoundException);
    });

    it('continua processando o lote mesmo quando uma empresa falha', async () => {
      process.env.API_CRONS_DISABLED = 'false';
      mockDomainService.findAllActive.mockResolvedValue([
        { id: 'company-1' },
        { id: 'company-2' },
      ]);
      mockConfigService.get.mockImplementation(((key: string) => {
        if (key === 'RESEND_API_KEY') return 're_123456';
        if (key === 'MAIL_FROM_EMAIL') return 'test@example.com';
        if (key === 'MAIL_ALERT_TO') return 'ops@example.com';
        if (key === 'MAIL_ALERT_COMPANY_BATCH_SIZE') return '10';
        if (key === 'MAIL_ALERT_COMPANY_MAX_PARALLEL') return '2';
        return null;
      }) as never);

      const dispatchAlertsSpy = jest
        .spyOn(service, 'dispatchAlerts')
        .mockRejectedValueOnce(new Error('mail provider down'))
        .mockResolvedValueOnce({
          recipients: ['ops@example.com'],
          previewUrl: undefined,
          usingTestAccount: false,
          whatsappSent: false,
        });

      await expect(
        (
          service as unknown as MailServiceWithScheduledAlerts
        ).runScheduledAlerts(),
      ).resolves.toBeUndefined();

      expect(dispatchAlertsSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('assertDispatchAvailable', () => {
    it('lança ServiceUnavailableException quando nenhum provider está configurado e mail está habilitado', async () => {
      const noProviderConfigService = {
        get: jest.fn((key: string) => {
          // MAIL_ENABLED não definido (default habilitado), mas sem provider
          if (key === 'MAIL_FROM_EMAIL') return 'test@example.com';
          return null;
        }),
      };

      const noProviderModule = await Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: noProviderConfigService },
          {
            provide: getRepositoryToken(MailLog),
            useValue: mockMailLogRepository,
          },
          { provide: getRepositoryToken(Cat), useValue: mockCatsRepository },
          {
            provide: DocumentStorageService,
            useValue: mockDocumentStorageService,
          },
          { provide: EpisService, useValue: mockDomainService },
          { provide: TrainingsService, useValue: mockDomainService },
          { provide: PtsService, useValue: mockDomainService },
          { provide: AprsService, useValue: mockDomainService },
          { provide: ArrsService, useValue: mockDomainService },
          {
            provide: getRepositoryToken(Checklist),
            useValue: mockChecklistRepository,
          },
          { provide: NonConformitiesService, useValue: mockDomainService },
          { provide: DdsService, useValue: mockDomainService },
          { provide: DidsService, useValue: mockDomainService },
          { provide: AuditsService, useValue: mockDomainService },
          { provide: RdosService, useValue: mockDomainService },
          { provide: CompaniesService, useValue: mockDomainService },
          { provide: TenantService, useValue: mockTenantService },
          { provide: ReportsService, useValue: mockDomainService },
          {
            provide: IntegrationResilienceService,
            useValue: mockIntegrationResilienceService,
          },
          {
            provide: DistributedLockService,
            useValue: mockDistributedLockService,
          },
          {
            provide: PrivilegedDbService,
            useValue: {
              isEnabled: jest.fn(() => false),
              withPrivilegedClient: jest.fn(),
            },
          },
        ],
      }).compile();

      try {
        const noProviderService =
          noProviderModule.get<MailService>(MailService);

        expect(noProviderService.isDeliveryEnabled()).toBe(true);
        expect(noProviderService.hasConfiguredProvider()).toBe(false);
        expect(noProviderService.getConfiguredProvider()).toBeNull();

        let error: unknown;
        try {
          noProviderService.assertDispatchAvailable();
        } catch (caughtError) {
          error = caughtError;
        }

        if (!(error instanceof ServiceUnavailableException)) {
          throw new Error(
            'assertDispatchAvailable deveria lançar quando sem provider.',
          );
        }
        expect(error.message).toContain('provedor de e-mail');
      } finally {
        await noProviderModule.close();
      }
    });

    it('lança ServiceUnavailableException quando MAIL_ENABLED=false independente do provider', async () => {
      const disabledConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'MAIL_ENABLED') return 'false';
          if (key === 'RESEND_API_KEY') return 're_valid_key';
          if (key === 'MAIL_FROM_EMAIL') return 'test@example.com';
          return null;
        }),
      };

      const disabledModule = await Test.createTestingModule({
        providers: [
          MailService,
          { provide: ConfigService, useValue: disabledConfigService },
          {
            provide: getRepositoryToken(MailLog),
            useValue: mockMailLogRepository,
          },
          { provide: getRepositoryToken(Cat), useValue: mockCatsRepository },
          {
            provide: DocumentStorageService,
            useValue: mockDocumentStorageService,
          },
          { provide: EpisService, useValue: mockDomainService },
          { provide: TrainingsService, useValue: mockDomainService },
          { provide: PtsService, useValue: mockDomainService },
          { provide: AprsService, useValue: mockDomainService },
          { provide: ArrsService, useValue: mockDomainService },
          {
            provide: getRepositoryToken(Checklist),
            useValue: mockChecklistRepository,
          },
          { provide: NonConformitiesService, useValue: mockDomainService },
          { provide: DdsService, useValue: mockDomainService },
          { provide: DidsService, useValue: mockDomainService },
          { provide: AuditsService, useValue: mockDomainService },
          { provide: RdosService, useValue: mockDomainService },
          { provide: CompaniesService, useValue: mockDomainService },
          { provide: TenantService, useValue: mockTenantService },
          { provide: ReportsService, useValue: mockDomainService },
          {
            provide: IntegrationResilienceService,
            useValue: mockIntegrationResilienceService,
          },
          {
            provide: DistributedLockService,
            useValue: mockDistributedLockService,
          },
          {
            provide: PrivilegedDbService,
            useValue: {
              isEnabled: jest.fn(() => false),
              withPrivilegedClient: jest.fn(),
            },
          },
        ],
      }).compile();

      try {
        const disabledService = disabledModule.get<MailService>(MailService);

        expect(disabledService.isDeliveryEnabled()).toBe(false);

        let error: unknown;
        try {
          disabledService.assertDispatchAvailable();
        } catch (caughtError) {
          error = caughtError;
        }

        if (!(error instanceof ServiceUnavailableException)) {
          throw new Error(
            'assertDispatchAvailable deveria lançar quando MAIL_ENABLED=false.',
          );
        }
        expect(error.message).toContain('MAIL_ENABLED=false');
      } finally {
        await disabledModule.close();
      }
    });

    it('não lança quando provider está configurado e MAIL_ENABLED não é false', () => {
      // O service padrão do beforeEach usa RESEND_API_KEY — deve passar
      expect(() => service.assertDispatchAvailable()).not.toThrow();
      expect(service.isDeliveryEnabled()).toBe(true);
      expect(service.hasConfiguredProvider()).toBe(true);
      expect(service.getConfiguredProvider()).toBe('resend');
    });
  });
});
