import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  Inject,
  forwardRef,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import nodemailer, { Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { Repository, Between, LessThan, Not, In } from 'typeorm';
import { MailLog } from './entities/mail-log.entity';
import { Cat } from '../../modules/cats/entities/cat.entity';
import { EpisService } from '../../modules/epis/epis.service';
import { TrainingsService } from '../../modules/trainings/trainings.service';
import { PtsService } from '../../modules/pts/pts.service';
import { AprsService } from '../../modules/aprs/aprs.service';
import { ArrsService } from '../../modules/arrs/arrs.service';
import { NonConformitiesService } from '../../modules/nonconformities/nonconformities.service';
import { DdsService } from '../../modules/dds/dds.service';
import { DidsService } from '../../modules/dids/dids.service';
import { AuditsService } from '../../modules/audits/audits.service';
import { RdosService } from '../../modules/rdos/rdos.service';
import { PhotographicReportsService } from '../../modules/photographic-reports/photographic-reports.service';
import { PhotographicReportExportType } from '../../modules/photographic-reports/entities/photographic-report-export.entity';
import { CompaniesService } from '../../modules/companies/companies.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import type { TenantContext } from '../../shared/tenant/tenant.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { IntegrationResilienceService } from '../../shared/resilience/integration-resilience.service';
import { isApiCronDisabled } from '../../shared/utils/scheduler.util';
import { ReportsService } from '../../modules/reports/reports.service';
import { CompanyResponseDto } from '../../modules/companies/dto/company-response.dto';
import { Checklist } from '../../modules/checklists/entities/checklist.entity';
import { UpdateAlertSettingsDto } from './dto/update-alert-settings.dto';
import {
  DocumentMailArtifactType,
  DocumentMailDispatchResponseDto,
} from './dto/document-mail-dispatch-response.dto';
import {
  DistributedLockHandle,
  DistributedLockService,
} from '../../shared/redis/distributed-lock.service';
import {
  maskEmail,
  maskSensitiveText,
} from '../../shared/logging/log-sanitizer.util';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { PrivilegedDbService } from '../../shared/database/privileged-db.service';
import type { StorageObjectOwner } from '../../shared/storage/storage-object-reference';

type MailContext = { companyId?: string; userId?: string };

type MailProvider = 'smtp' | 'resend';
type LooseRecord = Record<string, unknown>;
type MailAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};
type ResendAttachment = Omit<MailAttachment, 'content'> & {
  content: string;
};
type ResendSendResponse = {
  data?: { id?: string } | null;
  error?: { message?: string } | null;
};

type MailDeliveryResult = {
  provider: MailProvider;
  messageId?: string;
  accepted: string[];
  rejected: string[];
  providerResponse?: string;
  raw: unknown;
};

type MailFailureDetails = {
  message: string;
  code:
    | 'MAIL_DELIVERY_FAILED'
    | 'MAIL_DISABLED'
    | 'MAIL_PROVIDER_TIMEOUT'
    | 'MAIL_PROVIDER_CIRCUIT_OPEN';
  provider?: MailProvider;
  blockedIp?: string;
  retryAfterSeconds?: number;
};

type SendMailMetadata = {
  html?: string;
  filename?: string;
};

type MailIdentity = {
  name: string;
  email: string;
};

type AlertSummarySection = {
  title: string;
  items: Array<{ label: string; value: number; critical: boolean }>;
};

type CompanyAlertSettings = {
  enabled: boolean;
  recipients: string[];
  includeWhatsapp: boolean;
  lookaheadDays: number;
  includeComplianceSummary: boolean;
  includeOperationsSummary: boolean;
  includeOccurrencesSummary: boolean;
  deliveryHour: number;
  weekdaysOnly: boolean;
  cadenceDays: number;
  skipWhenNoPending: boolean;
  minimumPendingItems: number;
  subjectPrefix: string | null;
  snoozeUntil: string | null;
  lastScheduledDispatchAt: string | null;
};

const DEFAULT_COMPANY_ALERT_SETTINGS: CompanyAlertSettings = {
  enabled: true,
  recipients: [],
  includeWhatsapp: false,
  lookaheadDays: 30,
  includeComplianceSummary: true,
  includeOperationsSummary: true,
  includeOccurrencesSummary: true,
  deliveryHour: 8,
  weekdaysOnly: true,
  cadenceDays: 1,
  skipWhenNoPending: false,
  minimumPendingItems: 0,
  subjectPrefix: null,
  snoozeUntil: null,
  lastScheduledDispatchAt: null,
};

const isLooseRecord = (value: unknown): value is LooseRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isExplicitlyDisabled(value: unknown): boolean {
  if (value === false) {
    return true;
  }

  if (typeof value !== 'string') {
    return false;
  }

  return ['false', '0', 'no', 'off', 'disabled'].includes(
    value.trim().toLowerCase(),
  );
}

@Injectable()
export class MailService {
  private resend: Resend | null = null;
  private transporter: Transporter | null = null;
  private readonly mailDeliveryEnabled: boolean;
  private readonly logger = new Logger(MailService.name);
  private alertsRunning = false;
  private lastScheduledAlertsAt = 0;
  private scheduledAlertsCursor = 0;
  private lastMissingProviderScheduledAlertWarnAt = 0;

  constructor(
    private configService: ConfigService,
    @InjectRepository(MailLog)
    private mailLogRepository: Repository<MailLog>,
    @InjectRepository(Cat)
    private readonly catsRepository: Repository<Cat>,
    private episService: EpisService,
    private trainingsService: TrainingsService,
    private ptsService: PtsService,
    private aprsService: AprsService,
    private arrsService: ArrsService,
    @InjectRepository(Checklist)
    private readonly checklistsRepository: Repository<Checklist>,
    private nonConformitiesService: NonConformitiesService,
    private ddsService: DdsService,
    private didsService: DidsService,
    private auditsService: AuditsService,
    @Inject(forwardRef(() => RdosService))
    private rdosService: RdosService,
    private companiesService: CompaniesService,
    private tenantService: TenantService,
    private documentStorageService: DocumentStorageService,
    private reportsService: ReportsService,
    private readonly integration: IntegrationResilienceService,
    private readonly distributedLock: DistributedLockService,
    private readonly privilegedDb: PrivilegedDbService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.mailDeliveryEnabled = !isExplicitlyDisabled(
      this.configService.get<string | boolean>('MAIL_ENABLED'),
    );
    if (!this.mailDeliveryEnabled) {
      this.logger.log(
        'MailService desabilitado por MAIL_ENABLED=false; envios e alertas de e-mail ficam inativos neste runtime.',
      );
      return;
    }

    const smtpHost = this.configService.get<string>('MAIL_HOST')?.trim();
    const smtpUser = this.configService.get<string>('MAIL_USER')?.trim();
    const smtpPass = this.configService.get<string>('MAIL_PASS')?.trim();
    const smtpPort = Number(
      this.configService.get<string>('MAIL_PORT') || '587',
    );
    const smtpSecureRaw = this.configService.get<string>('MAIL_SECURE');
    const smtpSecure =
      smtpSecureRaw === 'true' ||
      this.configService.get<boolean>('MAIL_SECURE') === true;
    const smtpTimeoutMs = this.resolveMailProviderTimeoutMs('smtp');

    // Resend tem prioridade sobre SMTP: é o provedor recomendado (domínio
    // verificado, feito para envio transacional) e, ao contrário do SMTP,
    // uma credencial travada/expirada aqui falha alto (nenhum provedor
    // configurado) em vez de silenciosamente escolher um SMTP quebrado
    // que ninguém percebe até checar os logs — foi exatamente isso que
    // aconteceu em produção quando MAIL_HOST/USER/PASS antigos e inválidos
    // tinham prioridade sobre um RESEND_API_KEY que nem chegou a ser lido.
    const resendApiKey = this.configService
      .get<string>('RESEND_API_KEY')
      ?.trim();
    if (resendApiKey) {
      this.resend = new Resend(resendApiKey);
      this.logger.log('MailService configurado com Resend.');
      return;
    }

    if (smtpHost && smtpUser && smtpPass) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number.isFinite(smtpPort) ? smtpPort : 587,
        secure: smtpSecure,
        connectionTimeout: smtpTimeoutMs,
        greetingTimeout: smtpTimeoutMs,
        socketTimeout: smtpTimeoutMs,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });
      this.logger.log(
        `MailService configurado com SMTP (${smtpHost}) timeout=${smtpTimeoutMs}ms.`,
      );
      return;
    }

    this.logger.warn(
      'Nenhum provedor de e-mail configurado. Configure RESEND_API_KEY ou SMTP (MAIL_HOST/MAIL_USER/MAIL_PASS).',
    );
  }

  getConfiguredProvider(): MailProvider | null {
    if (this.resend) {
      return 'resend';
    }
    if (this.transporter) {
      return 'smtp';
    }
    return null;
  }

  isDeliveryEnabled(): boolean {
    return this.mailDeliveryEnabled;
  }

  hasConfiguredProvider(): boolean {
    return this.getConfiguredProvider() !== null;
  }

  assertDispatchAvailable(): void {
    if (!this.mailDeliveryEnabled) {
      throw new ServiceUnavailableException(
        'Envio de e-mail desabilitado por MAIL_ENABLED=false neste runtime.',
      );
    }

    if (!this.hasConfiguredProvider()) {
      throw new ServiceUnavailableException(
        'Nenhum provedor de e-mail configurado. Configure RESEND_API_KEY ou SMTP.',
      );
    }
  }

  private resolveStoredDocumentLookupScope(
    moduleLabel: string,
    fallbackCompanyId: string | undefined,
  ): {
    companyId: string;
    siteIds: string[] | null;
  } {
    const tenantContext = this.tenantService.getContext();
    if (tenantContext?.companyId) {
      const scope = resolveSiteAccessScopeFromTenantService(
        this.tenantService,
        moduleLabel,
      );
      return {
        companyId: scope.companyId,
        siteIds: scope.hasCompanyWideAccess ? null : scope.siteIds,
      };
    }

    if (!fallbackCompanyId) {
      throw new BadRequestException(
        'companyId é obrigatório para enviar documento sem contexto de tenant.',
      );
    }

    return {
      companyId: fallbackCompanyId,
      siteIds: null,
    };
  }

  async sendStoredDocument(
    documentId: string,
    documentType: string,
    email: string,
    companyId?: string,
  ): Promise<DocumentMailDispatchResponseDto> {
    const resolvedCompanyId =
      companyId?.trim() || this.tenantService.getTenantId() || undefined;
    let fileKey: string | undefined;
    let subject = 'Documento Compartilhado - SGS';
    let docName = 'Documento';

    // Normaliza o tipo para evitar problemas de case
    const type = documentType.toUpperCase().trim();
    let storageOwner = this.resolveStoredDocumentOwner(type, documentId);

    try {
      switch (type) {
        case 'PT': {
          const pt = await this.ptsService.findOne(documentId);
          if (pt) {
            fileKey = pt.pdf_file_key;
            docName = `Permissão de Trabalho #${pt.numero}`;
            subject = `${docName}`;
          }
          break;
        }
        case 'APR': {
          const apr = await this.aprsService.findOne(documentId);
          if (apr) {
            fileKey = apr.pdf_file_key;
            docName = `APR: ${apr.titulo}`;
            subject = `${docName}`;
          }
          break;
        }
        case 'ARR': {
          const arr = await this.arrsService.findOne(documentId);
          if (arr) {
            fileKey = arr.pdf_file_key || undefined;
            docName = `ARR: ${arr.titulo}`;
            subject = `${docName}`;
          }
          break;
        }
        case 'REPORT':
        case 'MONTHLY_REPORT': {
          const report = await this.reportsService.findOne(documentId);
          const access = await this.reportsService.getPdfAccess(documentId);
          if (!access.hasFinalPdf || !access.fileKey) {
            throw new NotFoundException(
              'O relatório mensal ainda não possui PDF final emitido.',
            );
          }
          fileKey = access.fileKey;
          docName = report.titulo;
          subject = `${docName}`;
          break;
        }
        case 'TRAINING':
        case 'TREINAMENTO':
        case 'TRN': {
          const training = await this.trainingsService.findOne(documentId);
          const access = await this.trainingsService.getPdfAccess(documentId);
          if (!access.hasFinalPdf || !access.fileKey) {
            throw new NotFoundException(
              'O treinamento ainda não possui PDF final emitido.',
            );
          }
          fileKey = access.fileKey;
          docName = `Treinamento: ${training.nome}`;
          subject = `${docName}`;
          break;
        }
        case 'CHECKLIST': {
          const scope = this.resolveStoredDocumentLookupScope(
            'envio de checklist',
            resolvedCompanyId,
          );
          const checklist = await this.checklistsRepository.findOne({
            where: {
              id: documentId,
              company_id: scope.companyId,
              ...(scope.siteIds ? { site_id: In(scope.siteIds) } : {}),
            },
            select: ['id', 'pdf_file_key'],
          });
          if (checklist) {
            fileKey = checklist.pdf_file_key;
            docName = `Checklist`;
            subject = `${docName}`;
          }
          break;
        }
        case 'DDS': {
          const dds = await this.ddsService.findOne(documentId);
          if (dds) {
            fileKey = dds.pdf_file_key;
            docName = `DDS: ${dds.tema || 'Documento'}`;
            subject = `${docName}`;
          }
          break;
        }
        case 'DID': {
          const did = await this.didsService.findOne(documentId);
          if (did) {
            fileKey = did.pdf_file_key || undefined;
            docName = `DID: ${did.titulo}`;
            subject = `${docName}`;
          }
          break;
        }
        case 'CAT': {
          const scope = this.resolveStoredDocumentLookupScope(
            'envio de CAT',
            resolvedCompanyId,
          );
          const cat = await this.catsRepository.findOne({
            where: {
              id: documentId,
              company_id: scope.companyId,
              ...(scope.siteIds ? { site_id: In(scope.siteIds) } : {}),
            },
            select: ['id', 'numero', 'pdf_file_key'],
          });
          if (!cat) {
            throw new NotFoundException(
              'CAT não encontrada para envio por e-mail.',
            );
          }
          if (!cat.pdf_file_key) {
            throw new NotFoundException(
              'A CAT ainda não possui PDF final governado emitido.',
            );
          }
          fileKey = cat.pdf_file_key;
          docName = `CAT #${cat.numero}`;
          subject = `${docName}`;
          break;
        }
        case 'NONCONFORMITY':
        case 'NC': {
          const nc = await this.nonConformitiesService.findOne(documentId);
          const access =
            await this.nonConformitiesService.getPdfAccess(documentId);
          if (!access.hasFinalPdf || !access.fileKey) {
            throw new NotFoundException(
              'A não conformidade ainda não possui PDF final emitido.',
            );
          }
          fileKey = access.fileKey;
          docName = `Não Conformidade: ${nc.codigo_nc}`;
          subject = `${docName}`;
          break;
        }
        case 'AUDIT': {
          if (!resolvedCompanyId) {
            throw new BadRequestException(
              'companyId é obrigatório para enviar auditorias.',
            );
          }
          const audit = await this.auditsService.findOne(
            documentId,
            resolvedCompanyId,
          );
          const access = await this.auditsService.getPdfAccess(
            documentId,
            resolvedCompanyId,
          );
          if (!access.hasFinalPdf || !access.fileKey) {
            throw new NotFoundException(
              'A auditoria ainda não possui PDF final emitido.',
            );
          }
          fileKey = access.fileKey;
          docName = `Auditoria: ${audit.titulo}`;
          subject = `${docName}`;
          break;
        }
        case 'RDO': {
          const rdo = await this.rdosService.findOne(documentId);
          const access = await this.rdosService.getPdfAccess(documentId);
          if (!access.hasFinalPdf || !access.fileKey) {
            throw new NotFoundException(
              'O RDO ainda não possui PDF final emitido.',
            );
          }
          fileKey = access.fileKey;
          docName = `RDO ${rdo.numero}`;
          subject = `${docName}`;
          break;
        }
        case 'PHOTOGRAPHIC_REPORT': {
          const photographicReportsService = this.moduleRef.get(
            PhotographicReportsService,
            { strict: false },
          );
          const report = await photographicReportsService.findOne(documentId);
          const pdfExports = (report.exports ?? []).filter(
            (e) => e.export_type === PhotographicReportExportType.PDF,
          );
          if (!pdfExports.length) {
            throw new NotFoundException(
              'O relatório fotográfico ainda não possui exportação em PDF.',
            );
          }
          const latest = pdfExports.sort(
            (a, b) =>
              new Date(b.generated_at).getTime() -
              new Date(a.generated_at).getTime(),
          )[0];
          fileKey = latest.file_url;
          storageOwner = {
            resourceType: 'photographic-report-export',
            resourceId: latest.id,
          };
          docName = `Relatório Fotográfico — ${report.client_name} / ${report.project_name}`;
          subject = docName;
          break;
        }
        default:
          // Tenta buscar em outros módulos se necessário ou lança erro
          throw new BadRequestException(
            `Tipo de documento não suportado: ${type}`,
          );
      }
    } catch (error) {
      if (error instanceof NotFoundException) {
        const message = this.extractErrorMessage(error);
        if (
          /ainda nao possui pdf final|ainda não possui pdf final/i.test(message)
        ) {
          throw error;
        }
        throw new NotFoundException(
          `Documento do tipo ${type} com ID ${documentId} não encontrado.`,
        );
      }
      throw error;
    }

    if (!fileKey) {
      throw new NotFoundException(
        `O documento ${docName} não possui um arquivo PDF gerado/anexado.`,
      );
    }

    const pdfBuffer = await this.downloadMailAttachmentBuffer(fileKey, {
      companyId: resolvedCompanyId,
      userId: undefined,
      artifactLabel: docName,
      owner: storageOwner,
    });
    const attachmentFilename = this.buildAttachmentFilename(docName, fileKey);

    const html = this.buildGraphiteEmailHtml({
      eyebrow: 'Documento oficial',
      title: this.escapeHtml(docName),
      paragraphs: [
        'Olá,',
        `Você recebeu o documento <strong>${this.escapeHtml(docName)}</strong> através da plataforma SGS — Sistema de Gestão de Segurança.`,
        'O PDF oficial segue anexado neste e-mail para visualização, download e arquivamento.',
      ],
      note: 'Documentos emitidos pelo SGS possuem código de validação impresso. A autenticidade pode ser conferida a qualquer momento pela página indicada no rodapé do PDF.',
    });

    await this.sendMailSimple(
      email,
      subject,
      `Segue em anexo o documento ${docName}.`,
      { companyId },
      [
        {
          filename: attachmentFilename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
      {
        html,
        filename: attachmentFilename,
      },
    );

    this.logger.log({
      event: 'mail_document_sent',
      documentType: type,
      companyId: resolvedCompanyId,
      artifactType: 'governed_final_pdf',
      fallbackUsed: false,
      isOfficial: true,
      recipient: maskEmail(email),
    });

    return this.buildDocumentDispatchResponse({
      message:
        'O documento final governado foi enviado por e-mail com sucesso.',
      deliveryMode: 'sent',
      artifactType: 'governed_final_pdf',
      isOfficial: true,
      fallbackUsed: false,
      documentId,
      documentType: type,
    });
  }

  async sendStoredFileKey(
    fileKey: string,
    email: string,
    options?: {
      subject?: string;
      docName?: string;
      expiresInSeconds?: number;
      companyId?: string;
      userId?: string;
      owner?: StorageObjectOwner;
    },
  ): Promise<DocumentMailDispatchResponseDto> {
    if (!fileKey || !email) {
      throw new BadRequestException('fileKey e email são obrigatórios.');
    }

    const docName = options?.docName?.trim() || 'Documento';
    const subject = options?.subject?.trim() || 'Documento Compartilhado - SGS';
    const pdfBuffer = await this.downloadMailAttachmentBuffer(fileKey, {
      companyId: options?.companyId,
      userId: options?.userId,
      artifactLabel: docName,
      owner: options?.owner,
    });
    const attachmentFilename = this.buildAttachmentFilename(docName, fileKey);

    const html = this.buildGraphiteEmailHtml({
      eyebrow: 'Documento oficial',
      title: this.escapeHtml(docName),
      paragraphs: [
        'Olá,',
        `Você recebeu o documento <strong>${this.escapeHtml(docName)}</strong> através da plataforma SGS — Sistema de Gestão de Segurança.`,
        'O PDF oficial segue anexado neste e-mail para visualização, download e arquivamento.',
      ],
      note: 'Documentos emitidos pelo SGS possuem código de validação impresso. A autenticidade pode ser conferida a qualquer momento pela página indicada no rodapé do PDF.',
    });

    await this.sendMailSimple(
      email,
      subject,
      `Segue em anexo o documento ${docName}.`,
      {
        companyId: options?.companyId,
        userId: options?.userId,
      },
      [
        {
          filename: attachmentFilename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
      {
        html,
        filename: attachmentFilename,
      },
    );

    this.logger.warn({
      event: 'mail_document_sent_with_local_fallback',
      companyId: options?.companyId,
      userId: options?.userId,
      artifactType: 'local_uploaded_pdf',
      fallbackUsed: true,
      isOfficial: false,
      recipient: maskEmail(email),
    });

    return this.buildDocumentDispatchResponse({
      message:
        'O PDF local foi enviado por e-mail. Este envio não substitui o documento final governado.',
      deliveryMode: 'sent',
      artifactType: 'local_uploaded_pdf',
      isOfficial: false,
      fallbackUsed: true,
      fileKey,
    });
  }

  async sendUploadedPdfBuffer(
    pdfBuffer: Buffer,
    email: string,
    options?: {
      subject?: string;
      docName?: string;
      companyId?: string;
      userId?: string;
    },
  ): Promise<DocumentMailDispatchResponseDto> {
    if (!email) {
      throw new BadRequestException('email é obrigatório.');
    }

    const docName = options?.docName?.trim() || 'Documento';
    const subject = options?.subject?.trim() || 'Documento Compartilhado - SGS';
    const attachmentFilename = this.buildAttachmentFilename(docName);

    const html = this.buildGraphiteEmailHtml({
      eyebrow: 'Envio local / degradado',
      title: this.escapeHtml(docName),
      tone: 'warning',
      paragraphs: [
        'Olá,',
        `Você recebeu o documento <strong>${this.escapeHtml(docName)}</strong> através da plataforma SGS — Sistema de Gestão de Segurança.`,
        'O PDF está anexado neste e-mail para visualização e download.',
      ],
      note: 'Este envio utilizou um PDF local/degradado e não substitui o documento final governado.',
      footer: this.buildOfficialFooter('Canal operacional'),
    });

    await this.sendMailSimple(
      email,
      subject,
      `Segue em anexo o documento ${docName}. Este envio utilizou um PDF local/degradado e não substitui o documento final governado.`,
      {
        companyId: options?.companyId,
        userId: options?.userId,
      },
      [
        {
          filename: attachmentFilename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
      {
        html,
        filename: attachmentFilename,
      },
    );

    this.logger.warn({
      event: 'mail_document_sent_with_buffer_fallback',
      companyId: options?.companyId,
      userId: options?.userId,
      artifactType: 'local_uploaded_pdf',
      fallbackUsed: true,
      isOfficial: false,
      recipient: maskEmail(email),
    });

    return this.buildDocumentDispatchResponse({
      message:
        'O PDF local foi enviado por e-mail. Este envio não substitui o documento final governado.',
      deliveryMode: 'sent',
      artifactType: 'local_uploaded_pdf',
      isOfficial: false,
      fallbackUsed: true,
    });
  }

  buildDocumentDispatchResponse(input: {
    message: string;
    deliveryMode: 'queued' | 'sent';
    artifactType: DocumentMailArtifactType;
    isOfficial: boolean;
    fallbackUsed: boolean;
    documentType?: string;
    documentId?: string;
    fileKey?: string;
  }): DocumentMailDispatchResponseDto {
    return {
      success: true,
      message: input.message,
      deliveryMode: input.deliveryMode,
      artifactType: input.artifactType,
      isOfficial: input.isOfficial,
      fallbackUsed: input.fallbackUsed,
      documentType: input.documentType,
      documentId: input.documentId,
      fileKey: input.fileKey,
    };
  }

  async sendMail(
    to: string,
    subject: string,
    text: string,
    html?: string,
    context?: MailContext & { filename?: string },
  ): Promise<void> {
    await this.sendMailSimple(to, subject, text, context, undefined, {
      html,
      filename: context?.filename,
    });
  }

  async sendMailSimple(
    to: string,
    subject: string,
    text: string,
    context?: MailContext,
    attachments?: MailAttachment[],
    metadata?: SendMailMetadata,
  ): Promise<{
    info: unknown;
    previewUrl?: string;
    usingTestAccount: boolean;
  }> {
    const { fromEmail } = this.resolveFromAddress();
    const html = metadata?.html
      ? metadata.html
      : text
        ? `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1f2937;">${text.replace(
            /\n/g,
            '<br/>',
          )}</div>`
        : undefined;

    let delivery: MailDeliveryResult;
    try {
      delivery = await this.sendWithConfiguredProvider({
        to,
        subject,
        text,
        html,
        attachments,
      });
    } catch (error) {
      const failure = this.normalizeMailFailure(error);

      await this.persistMailLogSafely(
        {
          company_id: context?.companyId,
          user_id: context?.userId,
          to,
          subject,
          filename: metadata?.filename || 'alerta',
          using_test_account: false,
          status: 'failed',
          error_message: failure.message,
        },
        {
          event: 'mail_log_persist_failed_after_send_error',
          companyId: context?.companyId,
          userId: context?.userId,
          to: maskSensitiveText(to),
        },
      );

      this.logger.error(
        {
          event: 'mail_failed',
          companyId: context?.companyId,
          userId: context?.userId,
          provider: failure.provider,
          code: failure.code,
          blockedIp: failure.blockedIp,
          retryAfterSeconds: failure.retryAfterSeconds,
          error: failure.message,
        },
        error instanceof Error ? error.stack : undefined,
      );

      throw new ServiceUnavailableException({
        message: failure.message,
        code: failure.code,
        provider: failure.provider,
        blockedIp: failure.blockedIp,
        retryAfterSeconds: failure.retryAfterSeconds,
        degraded: true,
      });
    }

    const usingTestAccount =
      delivery.provider === 'resend' && fromEmail.endsWith('@resend.dev');

    await this.persistMailLogSafely(
      {
        company_id: context?.companyId,
        user_id: context?.userId,
        to,
        subject,
        filename: metadata?.filename || 'alerta',
        message_id: delivery.messageId,
        accepted: delivery.accepted,
        rejected: delivery.rejected,
        provider_response: delivery.providerResponse,
        using_test_account: usingTestAccount,
        status: 'sent',
      },
      {
        event: 'mail_log_persist_failed_after_success',
        companyId: context?.companyId,
        userId: context?.userId,
        to: maskSensitiveText(to),
        provider: delivery.provider,
        messageId: delivery.messageId,
      },
    );

    this.logger.log({
      event: 'mail_sent',
      companyId: context?.companyId,
      userId: context?.userId,
      messageId: delivery.messageId,
      provider: delivery.provider,
    });

    return {
      info: {
        data: { id: delivery.messageId },
        provider: delivery.provider,
        raw: delivery.raw,
      },
      previewUrl: undefined,
      usingTestAccount,
    };
  }

  private resolveFromAddress() {
    const fromName =
      this.configService.get<string>('MAIL_FROM_NAME')?.trim() ||
      'SGS - Sistema de Gestão de Segurança';
    const fromEmail =
      this.configService.get<string>('MAIL_FROM_EMAIL')?.trim() ||
      this.configService.get<string>('MAIL_USER')?.trim() ||
      'onboarding@resend.dev';
    return { fromName, fromEmail };
  }

  private resolveReplyToAddress(): MailIdentity {
    const { fromName, fromEmail } = this.resolveFromAddress();
    const replyToEmail =
      this.configService.get<string>('MAIL_REPLY_TO_EMAIL')?.trim() ||
      fromEmail;
    const replyToName =
      this.configService.get<string>('MAIL_REPLY_TO_NAME')?.trim() || fromName;

    return { name: replyToName, email: replyToEmail };
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildOfficialFooter(channelLabel = 'Comunicação oficial'): string {
    const { fromName } = this.resolveFromAddress();
    const replyTo = this.resolveReplyToAddress();
    return `${fromName} · ${channelLabel} · Respostas para ${replyTo.email}`;
  }

  buildGraphiteEmailHtml(options: {
    eyebrow: string;
    title: string;
    paragraphs: string[];
    bodyHtml?: string;
    cta?: { label: string; href: string };
    note?: string;
    footer?: string;
    tone?: 'neutral' | 'warning';
  }) {
    const tone = options.tone ?? 'neutral';
    const eyebrowStyles =
      tone === 'warning'
        ? 'display:inline-block;margin-bottom:16px;padding:6px 10px;border-radius:999px;background-color:#f4ede5;border:1px solid #dfd4c8;color:#9a5a00;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;'
        : 'display:inline-block;margin-bottom:16px;padding:6px 10px;border-radius:999px;background-color:#ece8e3;border:1px solid #d8d2cb;color:#3e3935;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;';
    const shellStyle =
      'font-family: Arial, sans-serif;color:#25221f;max-width:560px;margin:0 auto;padding:28px;background-color:#f6f5f3;border:1px solid #b7aea5;border-radius:18px;';
    const titleStyle = 'margin:0 0 12px;color:#25221f;';
    const bodyStyle = 'margin:0 0 12px;color:#5c5650;line-height:1.6;';
    const noteStyle = 'font-size:13px;color:#5c5650;line-height:1.6;';
    const footerStyle = 'font-size:11px;color:#77706a;';
    const ctaStyle =
      'display:inline-block;margin:8px 0 16px;padding:12px 20px;border-radius:10px;background-color:#3e3935;color:#f6f5f3;font-size:14px;font-weight:700;text-decoration:none;';

    return `
      <div style="${shellStyle}">
        <div style="height:4px;margin-bottom:18px;border-radius:999px;background-color:#3e3935;"></div>
        <div style="${eyebrowStyles}">
          ${options.eyebrow}
        </div>
        <h2 style="${titleStyle}">${options.title}</h2>
        ${options.paragraphs
          .map((paragraph) => `<p style="${bodyStyle}">${paragraph}</p>`)
          .join('')}
        ${options.bodyHtml || ''}
        ${
          options.cta
            ? `<a href="${options.cta.href}" style="${ctaStyle}">${options.cta.label}</a>`
            : ''
        }
        ${
          options.note
            ? `<p style="${noteStyle}"><strong>Observação:</strong> ${options.note}</p>`
            : ''
        }
        <hr style="border:none;border-top:1px solid #d8d2cb;margin:24px 0;" />
        <p style="${footerStyle}">
          ${options.footer || this.buildOfficialFooter()}
        </p>
      </div>
    `;
  }

  private async persistMailLogSafely(
    data: Partial<MailLog>,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      const companyId = await this.resolveMailLogCompanyId(data);
      if (!companyId) {
        const contextEvent =
          typeof context.event === 'string'
            ? context.event
            : 'mail_log_persist_skipped';
        this.logger.warn({
          ...context,
          event: contextEvent,
          reason: 'MAIL_LOG_COMPANY_ID_NOT_RESOLVED',
        });
        return;
      }

      const logData: Partial<MailLog> = {
        ...data,
        company_id: companyId,
      };
      const tenantContext: TenantContext = {
        companyId,
        userId: data.user_id,
        isSuperAdmin: false,
      };

      await this.tenantService.run(tenantContext, async () => {
        const log = this.mailLogRepository.create(logData);
        await this.mailLogRepository.save(log);
      });
    } catch (error) {
      this.logger.warn({
        ...context,
        error: this.extractErrorMessage(error),
      });
    }
  }

  private async resolveMailLogCompanyId(
    data: Partial<MailLog>,
  ): Promise<string | undefined> {
    const directCompanyId = data.company_id?.trim();
    if (directCompanyId) {
      return directCompanyId;
    }

    const contextCompanyId = this.tenantService.getTenantId()?.trim();
    if (contextCompanyId) {
      return contextCompanyId;
    }

    const userId = data.user_id?.trim();
    if (!userId) {
      return undefined;
    }

    let companyId: unknown;
    if (this.privilegedDb.isEnabled()) {
      companyId = await this.privilegedDb.withPrivilegedClient(
        async (client) => {
          await client.query('BEGIN');
          try {
            await client.query("SET LOCAL app.is_super_admin = 'true'");
            const result = await client.query<{ company_id?: string }>(
              `SELECT u.company_id FROM users u WHERE u.id = $1 AND u.deleted_at IS NULL LIMIT 1`,
              [userId],
            );
            await client.query('COMMIT');
            return result.rows[0]?.company_id;
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          }
        },
      );
    } else {
      const rows = await this.mailLogRepository.manager.query<
        Array<{ company_id?: unknown }>
      >(
        `WITH _ctx AS (SELECT set_config('app.is_super_admin', 'true', true))
         SELECT u.company_id FROM _ctx, users u WHERE u.id = $1 AND u.deleted_at IS NULL LIMIT 1`,
        [userId],
      );
      companyId = rows[0]?.company_id;
    }

    return typeof companyId === 'string' && companyId.trim()
      ? companyId
      : undefined;
  }

  private async downloadMailAttachmentBuffer(
    fileKey: string,
    context: {
      companyId?: string;
      userId?: string;
      artifactLabel: string;
      owner?: StorageObjectOwner;
    },
  ): Promise<Buffer> {
    try {
      if (!context.owner) {
        throw new BadRequestException(
          'Owner autoritativo é obrigatório para anexos de storage.',
        );
      }
      return await this.documentStorageService.downloadFileBuffer(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          context.owner,
          'p1-document-storage-downloadFileBuffer',
        ),
      );
    } catch (error) {
      const message = this.extractErrorMessage(error);
      this.logger.warn({
        event: 'mail_attachment_storage_failed',
        companyId: context.companyId,
        userId: context.userId,
        artifactType: 'stored_document',
        error: message,
      });
      if (
        error instanceof NotFoundException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException(
        `O artefato oficial de ${context.artifactLabel} não pôde ser obtido no storage governado para envio por e-mail.`,
      );
    }
  }

  private resolveStoredDocumentOwner(
    documentType: string,
    documentId: string,
  ): StorageObjectOwner {
    const resourceTypeByDocumentType: Record<string, string> = {
      PT: 'pt',
      APR: 'apr',
      ARR: 'arr',
      REPORT: 'report',
      MONTHLY_REPORT: 'report',
      TRAINING: 'training',
      TREINAMENTO: 'training',
      TRN: 'training',
      CHECKLIST: 'checklist',
      DDS: 'dds',
      DID: 'did',
      CAT: 'cat',
      NONCONFORMITY: 'nonconformity',
      NC: 'nonconformity',
      AUDIT: 'audit',
      RDO: 'rdo',
      PHOTOGRAPHIC_REPORT: 'photographic_report',
    };
    const resourceType = resourceTypeByDocumentType[documentType];
    if (!resourceType) {
      throw new BadRequestException(
        `Tipo de documento não suportado para anexo: ${documentType}.`,
      );
    }
    return { resourceType, resourceId: documentId };
  }

  private async sendWithConfiguredProvider(options: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: MailAttachment[];
  }): Promise<MailDeliveryResult> {
    const { fromName, fromEmail } = this.resolveFromAddress();
    const replyTo = this.resolveReplyToAddress();
    const recipients = this.normalizeRecipients(options.to);
    if (!recipients.length) {
      throw new BadRequestException(
        'Nenhum destinatário válido para envio de e-mail.',
      );
    }

    if (this.resend) {
      const timeoutMs = this.resolveMailProviderTimeoutMs('resend');
      const data = this.toResendSendResponse(
        await this.integration.execute<unknown>(
          'resend_email',
          () =>
            this.resend!.emails.send({
              from: `${fromName} <${fromEmail}>`,
              replyTo: `${replyTo.name} <${replyTo.email}>`,
              to: recipients.length === 1 ? recipients[0] : recipients,
              subject: options.subject,
              text: options.text,
              html: options.html || options.text,
              attachments: this.normalizeAttachmentsForResend(
                options.attachments,
              ),
            }),
          {
            timeoutMs,
            retry: { attempts: 2, mode: 'safe' },
          },
        ),
      );

      if (data?.error?.message) {
        throw new Error(`Resend Error: ${data.error.message}`);
      }

      return {
        provider: 'resend',
        messageId: data?.data?.id,
        accepted: recipients,
        rejected: [],
        providerResponse: 'Resend API',
        raw: data,
      };
    }

    if (this.transporter) {
      const timeoutMs = this.resolveMailProviderTimeoutMs('smtp');
      const rawInfo = await this.integration.execute<unknown>(
        'smtp_email',
        () =>
          this.transporter!.sendMail({
            from: `${fromName} <${fromEmail}>`,
            replyTo: `${replyTo.name} <${replyTo.email}>`,
            to: recipients.join(','),
            subject: options.subject,
            text: options.text,
            html: options.html || options.text,
            attachments: options.attachments,
          }),
        {
          timeoutMs,
          retry: { attempts: 2, mode: 'safe' },
        },
      );
      const info = this.toSmtpInfo(rawInfo);

      return {
        provider: 'smtp',
        messageId: info.messageId,
        accepted: this.toAddressList(info.accepted, recipients),
        rejected: this.toAddressList(info.rejected, []),
        providerResponse: info.response,
        raw: rawInfo,
      };
    }

    if (!this.mailDeliveryEnabled) {
      throw new ServiceUnavailableException(
        'Envio de e-mail desabilitado por MAIL_ENABLED=false neste runtime.',
      );
    }

    throw new ServiceUnavailableException(
      'Nenhum provedor de e-mail configurado. Configure RESEND_API_KEY ou SMTP.',
    );
  }

  private toAddressList(value: unknown, fallback: string[]): string[] {
    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && 'address' in item) {
            const address = (item as { address?: string }).address;
            return typeof address === 'string' ? address : '';
          }
          return String(item ?? '');
        })
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (typeof value === 'string') {
      return [value].filter(Boolean);
    }
    return fallback;
  }

  private toSmtpInfo(value: unknown): {
    messageId?: string;
    accepted?: unknown;
    rejected?: unknown;
    response?: string;
  } {
    const record = isLooseRecord(value) ? value : null;

    return {
      messageId:
        typeof record?.messageId === 'string' ? record.messageId : undefined,
      accepted: record?.accepted,
      rejected: record?.rejected,
      response:
        typeof record?.response === 'string' ? record.response : undefined,
    };
  }

  private toResendSendResponse(value: unknown): ResendSendResponse {
    const record = isLooseRecord(value) ? value : null;
    const data = isLooseRecord(record?.data) ? record.data : null;
    const error = isLooseRecord(record?.error) ? record.error : null;

    return {
      data: data
        ? {
            id: typeof data.id === 'string' ? data.id : undefined,
          }
        : null,
      error: error
        ? {
            message:
              typeof error.message === 'string' ? error.message : undefined,
          }
        : null,
    };
  }

  private normalizeAttachmentsForResend(
    attachments?: MailAttachment[],
  ): ResendAttachment[] | undefined {
    if (!attachments?.length) {
      return undefined;
    }

    return attachments.map((attachment) => {
      const content = Buffer.isBuffer(attachment.content)
        ? attachment.content.toString('base64')
        : attachment.content;

      return {
        ...attachment,
        content,
      };
    });
  }

  private resolveMailProviderTimeoutMs(provider: MailProvider): number {
    const providerEnv =
      provider === 'smtp' ? 'SMTP_EMAIL_TIMEOUT_MS' : 'RESEND_EMAIL_TIMEOUT_MS';
    const mailDeliveryTimeout = this.getEnvNumber(
      'MAIL_DELIVERY_TIMEOUT_MS',
      0,
    );
    const providerTimeout = this.getEnvNumber(providerEnv, 0);
    const integrationTimeout = this.getEnvNumber('INTEGRATION_TIMEOUT_MS', 0);
    const fallback = provider === 'smtp' ? 30_000 : 15_000;

    return Math.max(
      1_000,
      providerTimeout || mailDeliveryTimeout || integrationTimeout || fallback,
    );
  }

  private buildAttachmentFilename(docName: string, fileKey?: string): string {
    const keyName = fileKey?.split('/').pop()?.trim();
    if (keyName && keyName.toLowerCase().endsWith('.pdf')) {
      return keyName;
    }

    const normalized = docName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();

    return `${normalized || 'documento'}.pdf`;
  }

  async sendMonthlyReport(
    companyId: string,
    email: string,
    month?: number,
    year?: number,
  ) {
    const now = new Date();
    // Se não for especificado, gera do mês anterior
    if (!month || !year) {
      month = now.getMonth(); // 0-11. Se 0 (Jan), anterior é Dez (12)
      year = now.getFullYear();
      if (month === 0) {
        month = 12;
        year--;
      }
    }

    try {
      const reportArtifact = await this.reportsService.generateMonthlyReport(
        companyId,
        year,
        month,
      );

      const subject = `Relatório Mensal de Conformidade - ${String(
        month,
      ).padStart(2, '0')}/${year}`;

      const text = `Olá,\n\nSegue em anexo o relatório mensal de conformidade referente a ${String(
        month,
      ).padStart(2, '0')}/${year}.\n\nAtenciosamente,\nEquipe SGS`;
      const html = this.buildGraphiteEmailHtml({
        eyebrow: 'Relatório mensal',
        title: 'Relatório mensal de conformidade',
        paragraphs: [
          `Olá, segue o relatório mensal de conformidade referente a <strong>${String(
            month,
          ).padStart(2, '0')}/${year}</strong>.`,
          'O documento oficial segue em anexo para revisão executiva, acompanhamento documental e rastreabilidade do fechamento mensal.',
        ],
        note: 'Este envio faz parte da comunicação oficial do SGS.',
        footer:
          'SGS — Sistema de Gestão de Segurança · Relatório mensal oficial',
      });

      await this.sendMailSimple(
        email,
        subject,
        text,
        { companyId },
        [
          {
            filename: `relatorio-mensal-${year}-${String(month).padStart(
              2,
              '0',
            )}.pdf`,
            content: reportArtifact.buffer,
          },
        ],
        { html },
      );
    } catch (error) {
      const message = this.extractErrorMessage(error);
      this.logger.error(
        `Erro ao enviar relatório mensal para ${maskEmail(email)}: ${message}`,
      );
      throw error;
    }
  }

  async dispatchAlerts(options: {
    to?: string;
    includeWhatsapp?: boolean;
    companyId?: string;
    userId?: string;
    respectAutomationEnabled?: boolean;
  }) {
    const resolvedCompanyId = options.companyId;
    if (!resolvedCompanyId) {
      throw new ServiceUnavailableException(
        'Empresa não encontrada para o envio de alertas.',
      );
    }

    const settings = await this.getCompanyAlertSettings(resolvedCompanyId);
    if (options.respectAutomationEnabled && !settings.enabled) {
      return {
        recipients: [],
        previewUrl: undefined,
        usingTestAccount: undefined,
        whatsappSent: false,
      };
    }

    const company = await this.findCompany(resolvedCompanyId);
    const fallbackRecipients = this.resolveAlertFallbackRecipients(company);
    const recipients = this.normalizeRecipients(
      options.to || settings.recipients,
    );
    const recipientsToUse = recipients.length ? recipients : fallbackRecipients;

    if (!recipientsToUse.length) {
      throw new ServiceUnavailableException(
        'Nenhum destinatário configurado para alertas.',
      );
    }

    const summary = await this.tenantService.run(
      {
        companyId: resolvedCompanyId,
        isSuperAdmin: false,
        siteScope: 'all',
      },
      () =>
        this.buildAlertSummary(settings.lookaheadDays, {
          includeComplianceSummary: settings.includeComplianceSummary,
          includeOperationsSummary: settings.includeOperationsSummary,
          includeOccurrencesSummary: settings.includeOccurrencesSummary,
        }),
    );
    if (
      options.respectAutomationEnabled &&
      settings.skipWhenNoPending &&
      summary.pendingItemsCount === 0
    ) {
      return {
        recipients: [],
        previewUrl: undefined,
        usingTestAccount: undefined,
        whatsappSent: false,
      };
    }
    if (
      options.respectAutomationEnabled &&
      summary.pendingItemsCount < settings.minimumPendingItems
    ) {
      return {
        recipients: [],
        previewUrl: undefined,
        usingTestAccount: undefined,
        whatsappSent: false,
      };
    }

    const baseSubject = `Alertas de conformidade${
      company?.razao_social ? ` — ${company.razao_social}` : ''
    }${
      summary.pendingItemsCount > 0
        ? ` (${summary.pendingItemsCount} ${
            summary.pendingItemsCount === 1 ? 'pendência' : 'pendências'
          })`
        : ''
    }`;
    const prefix = settings.subjectPrefix?.trim();
    const subject = prefix ? `${prefix} ${baseSubject}` : baseSubject;

    const frontendUrl = this.configService
      .get<string>('FRONTEND_URL')
      ?.trim()
      ?.replace(/\/$/, '');
    const alertHtml = this.buildGraphiteEmailHtml({
      eyebrow: 'Resumo de segurança',
      title: `Resumo de segurança do trabalho — ${new Date().toLocaleDateString('pt-BR')}`,
      tone: summary.pendingItemsCount > 0 ? 'warning' : 'neutral',
      paragraphs: [
        company?.razao_social
          ? `Panorama diário de SST da <strong>${this.escapeHtml(company.razao_social)}</strong>.`
          : 'Panorama diário de saúde e segurança do trabalho da sua empresa.',
        summary.pendingItemsCount > 0
          ? `Há <strong>${summary.pendingItemsCount} ${
              summary.pendingItemsCount === 1
                ? 'pendência que requer'
                : 'pendências que requerem'
            }</strong> a atenção da sua equipe. Itens em destaque exigem ação imediata.`
          : 'Nenhuma pendência identificada no período. Sua operação está em dia.',
      ],
      bodyHtml: this.buildAlertSummaryBodyHtml(summary.sections),
      cta: frontendUrl
        ? { label: 'Abrir painel do SGS', href: `${frontendUrl}/dashboard` }
        : undefined,
      note: 'Este resumo é gerado automaticamente com base nos dados registrados no SGS. Frequência e conteúdo podem ser ajustados em Configurações > Alertas.',
    });

    const mailResult = await this.sendMailSimple(
      recipientsToUse.join(','),
      subject,
      summary.message,
      { companyId: resolvedCompanyId, userId: options.userId },
      undefined,
      { html: alertHtml, filename: 'alertas-conformidade' },
    );

    const whatsappEnabled =
      typeof options.includeWhatsapp === 'boolean'
        ? options.includeWhatsapp
        : settings.includeWhatsapp ||
          this.configService.get<string>('WHATSAPP_ALERTS_ENABLED') === 'true';

    const whatsappResult = whatsappEnabled
      ? await this.sendWhatsappWebhook({
          to: recipientsToUse,
          companyId: resolvedCompanyId,
          companyName: company?.razao_social,
          message: summary.message,
        })
      : { sent: false };

    return {
      recipients: recipientsToUse,
      previewUrl: mailResult.previewUrl,
      usingTestAccount: mailResult.usingTestAccount,
      whatsappSent: whatsappResult.sent,
    };
  }

  async getAlertSettingsSnapshot(companyId?: string) {
    if (!companyId) {
      throw new ServiceUnavailableException(
        'Empresa não encontrada para configurações de alertas.',
      );
    }

    const settings = await this.getCompanyAlertSettings(companyId);
    const company = await this.findCompany(companyId);
    const fallbackRecipients = this.resolveAlertFallbackRecipients(company);

    return {
      ...settings,
      fallbackRecipients,
      providerConfigured: this.isMailProviderConfigured(),
      nextScheduledDispatchAt: this.computeNextScheduledDispatchAt(settings),
    };
  }

  async updateAlertSettings(
    companyId: string | undefined,
    payload: UpdateAlertSettingsDto,
  ) {
    if (!companyId) {
      throw new ServiceUnavailableException(
        'Empresa não encontrada para configurações de alertas.',
      );
    }

    const current = await this.getCompanyAlertSettings(companyId);
    const next: CompanyAlertSettings = {
      enabled:
        typeof payload.enabled === 'boolean'
          ? payload.enabled
          : current.enabled,
      recipients:
        payload.recipients?.map((item) => item.trim()).filter(Boolean) ??
        current.recipients,
      includeWhatsapp:
        typeof payload.includeWhatsapp === 'boolean'
          ? payload.includeWhatsapp
          : current.includeWhatsapp,
      lookaheadDays:
        typeof payload.lookaheadDays === 'number'
          ? payload.lookaheadDays
          : current.lookaheadDays,
      includeComplianceSummary:
        typeof payload.includeComplianceSummary === 'boolean'
          ? payload.includeComplianceSummary
          : current.includeComplianceSummary,
      includeOperationsSummary:
        typeof payload.includeOperationsSummary === 'boolean'
          ? payload.includeOperationsSummary
          : current.includeOperationsSummary,
      includeOccurrencesSummary:
        typeof payload.includeOccurrencesSummary === 'boolean'
          ? payload.includeOccurrencesSummary
          : current.includeOccurrencesSummary,
      deliveryHour:
        typeof payload.deliveryHour === 'number'
          ? payload.deliveryHour
          : current.deliveryHour,
      weekdaysOnly:
        typeof payload.weekdaysOnly === 'boolean'
          ? payload.weekdaysOnly
          : current.weekdaysOnly,
      cadenceDays:
        typeof payload.cadenceDays === 'number'
          ? payload.cadenceDays
          : current.cadenceDays,
      skipWhenNoPending:
        typeof payload.skipWhenNoPending === 'boolean'
          ? payload.skipWhenNoPending
          : current.skipWhenNoPending,
      minimumPendingItems:
        typeof payload.minimumPendingItems === 'number'
          ? payload.minimumPendingItems
          : current.minimumPendingItems,
      subjectPrefix:
        typeof payload.subjectPrefix === 'string'
          ? payload.subjectPrefix.trim() || null
          : current.subjectPrefix,
      snoozeUntil:
        typeof payload.snoozeUntil === 'string' &&
        payload.snoozeUntil.trim().length > 0
          ? payload.snoozeUntil
          : null,
      lastScheduledDispatchAt: current.lastScheduledDispatchAt,
    };

    await this.companiesService.update(companyId, {
      alert_settings: next,
    });

    const company = await this.findCompany(companyId);
    const fallbackRecipients = this.resolveAlertFallbackRecipients(company);

    return {
      ...next,
      fallbackRecipients,
      providerConfigured: this.isMailProviderConfigured(),
      nextScheduledDispatchAt: this.computeNextScheduledDispatchAt(next),
    };
  }

  async getAlertSummaryPreview(companyId?: string) {
    if (!companyId) {
      throw new ServiceUnavailableException(
        'Empresa não encontrada para prévia de alertas.',
      );
    }

    const settings = await this.getCompanyAlertSettings(companyId);
    const summary = await this.tenantService.run(
      { companyId, isSuperAdmin: false, siteScope: 'all' },
      () =>
        this.buildAlertSummary(settings.lookaheadDays, {
          includeComplianceSummary: settings.includeComplianceSummary,
          includeOperationsSummary: settings.includeOperationsSummary,
          includeOccurrencesSummary: settings.includeOccurrencesSummary,
        }),
    );

    return {
      generatedAt: new Date().toISOString(),
      lookaheadDays: settings.lookaheadDays,
      pendingItemsCount: summary.pendingItemsCount,
      compliancePendingCount: summary.compliancePendingCount,
      operationsPendingCount: summary.operationsPendingCount,
      occurrencesPendingCount: summary.occurrencesPendingCount,
      summary: summary.message,
    };
  }

  private isMailProviderConfigured(): boolean {
    return Boolean(this.transporter || this.resend);
  }

  private async getCompanyAlertSettings(
    companyId: string,
  ): Promise<CompanyAlertSettings> {
    const buildFallbackSettings = (): CompanyAlertSettings => ({
      ...DEFAULT_COMPANY_ALERT_SETTINGS,
      deliveryHour: new Date().getHours(),
      weekdaysOnly: false,
    });

    const companiesServiceWithEntityLookup = this
      .companiesService as unknown as {
      findOneEntity?: (id: string) => Promise<{ alert_settings?: unknown }>;
    };
    if (typeof companiesServiceWithEntityLookup.findOneEntity !== 'function') {
      return buildFallbackSettings();
    }

    let company: { alert_settings?: unknown };
    try {
      company =
        (await companiesServiceWithEntityLookup.findOneEntity(companyId)) || {};
    } catch {
      return buildFallbackSettings();
    }
    const raw = isLooseRecord(company.alert_settings)
      ? company.alert_settings
      : {};

    const recipients = Array.isArray(raw.recipients)
      ? raw.recipients
      : DEFAULT_COMPANY_ALERT_SETTINGS.recipients;

    return {
      enabled:
        typeof raw.enabled === 'boolean'
          ? raw.enabled
          : DEFAULT_COMPANY_ALERT_SETTINGS.enabled,
      recipients: this.normalizeRecipients(recipients),
      includeWhatsapp:
        typeof raw.includeWhatsapp === 'boolean'
          ? raw.includeWhatsapp
          : DEFAULT_COMPANY_ALERT_SETTINGS.includeWhatsapp,
      lookaheadDays:
        typeof raw.lookaheadDays === 'number' &&
        Number.isFinite(raw.lookaheadDays)
          ? Math.min(120, Math.max(1, Math.round(raw.lookaheadDays)))
          : DEFAULT_COMPANY_ALERT_SETTINGS.lookaheadDays,
      includeComplianceSummary:
        typeof raw.includeComplianceSummary === 'boolean'
          ? raw.includeComplianceSummary
          : DEFAULT_COMPANY_ALERT_SETTINGS.includeComplianceSummary,
      includeOperationsSummary:
        typeof raw.includeOperationsSummary === 'boolean'
          ? raw.includeOperationsSummary
          : DEFAULT_COMPANY_ALERT_SETTINGS.includeOperationsSummary,
      includeOccurrencesSummary:
        typeof raw.includeOccurrencesSummary === 'boolean'
          ? raw.includeOccurrencesSummary
          : DEFAULT_COMPANY_ALERT_SETTINGS.includeOccurrencesSummary,
      deliveryHour:
        typeof raw.deliveryHour === 'number' &&
        Number.isFinite(raw.deliveryHour)
          ? Math.min(23, Math.max(0, Math.round(raw.deliveryHour)))
          : DEFAULT_COMPANY_ALERT_SETTINGS.deliveryHour,
      weekdaysOnly:
        typeof raw.weekdaysOnly === 'boolean'
          ? raw.weekdaysOnly
          : DEFAULT_COMPANY_ALERT_SETTINGS.weekdaysOnly,
      cadenceDays:
        typeof raw.cadenceDays === 'number' && Number.isFinite(raw.cadenceDays)
          ? Math.min(30, Math.max(1, Math.round(raw.cadenceDays)))
          : DEFAULT_COMPANY_ALERT_SETTINGS.cadenceDays,
      skipWhenNoPending:
        typeof raw.skipWhenNoPending === 'boolean'
          ? raw.skipWhenNoPending
          : DEFAULT_COMPANY_ALERT_SETTINGS.skipWhenNoPending,
      minimumPendingItems:
        typeof raw.minimumPendingItems === 'number' &&
        Number.isFinite(raw.minimumPendingItems)
          ? Math.min(999, Math.max(0, Math.round(raw.minimumPendingItems)))
          : DEFAULT_COMPANY_ALERT_SETTINGS.minimumPendingItems,
      subjectPrefix:
        typeof raw.subjectPrefix === 'string' &&
        raw.subjectPrefix.trim().length > 0
          ? raw.subjectPrefix.trim()
          : null,
      snoozeUntil:
        typeof raw.snoozeUntil === 'string' &&
        !Number.isNaN(new Date(raw.snoozeUntil).getTime())
          ? raw.snoozeUntil
          : null,
      lastScheduledDispatchAt:
        typeof raw.lastScheduledDispatchAt === 'string' &&
        raw.lastScheduledDispatchAt.trim().length > 0
          ? raw.lastScheduledDispatchAt
          : null,
    };
  }

  private normalizeRecipients(value: string | string[]) {
    if (Array.isArray(value)) {
      return value.map((item) => item.trim()).filter(Boolean);
    }
    return value
      .split(/[,;]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private resolveAlertFallbackRecipients(
    company?: Pick<CompanyResponseDto, 'email_contato'>,
  ) {
    const companyRecipients = this.normalizeRecipients(
      company?.email_contato || '',
    );
    const globalRecipients = this.normalizeRecipients(
      this.configService.get<string>('MAIL_ALERT_TO') || '',
    );

    return [...new Set([...companyRecipients, ...globalRecipients])];
  }

  private async findCompany(
    companyId: string,
  ): Promise<CompanyResponseDto | undefined> {
    try {
      return await this.companiesService.findOne(companyId);
    } catch {
      this.logger.warn({
        event: 'company_not_found',
        companyId,
      });
      return undefined;
    }
  }

  private async buildAlertSummary(
    lookaheadDays = 30,
    options?: {
      includeComplianceSummary?: boolean;
      includeOperationsSummary?: boolean;
      includeOccurrencesSummary?: boolean;
    },
  ): Promise<{
    message: string;
    sections: AlertSummarySection[];
    pendingItemsCount: number;
    compliancePendingCount: number;
    operationsPendingCount: number;
    occurrencesPendingCount: number;
  }> {
    const now = new Date();
    const limitDate = new Date();
    const days = Math.min(120, Math.max(1, Math.round(lookaheadDays)));
    limitDate.setDate(now.getDate() + days);
    const companyId = this.tenantService.getTenantId() || '';
    const includeCompliance = options?.includeComplianceSummary !== false;
    const includeOperations = options?.includeOperationsSummary !== false;
    const includeOccurrences = options?.includeOccurrencesSummary !== false;

    const [
      episExpired,
      episExpiring,
      trainingsExpired,
      trainingsExpiring,
      pendingPts,
      urgentPts,
      pendingAprs,
      pendingChecklists,
      openNonconformities,
      ddsCount,
      auditActionItems,
      nonconformityActionItems,
    ] = await Promise.all([
      this.episService.count({ where: { validade_ca: LessThan(now) } }),
      this.episService.count({
        where: { validade_ca: Between(now, limitDate) },
      }),
      this.trainingsService.count({
        where: { data_vencimento: LessThan(now) },
      }),
      this.trainingsService.count({
        where: { data_vencimento: Between(now, limitDate) },
      }),
      this.ptsService.count({ where: { status: 'Pendente' } }),
      this.ptsService.count({
        where: { status: 'Pendente', data_hora_inicio: LessThan(now) },
      }),
      this.aprsService.count({ where: { status: 'Pendente' } }),
      this.checklistsRepository.count({
        where: { status: 'Pendente', is_modelo: false },
      }),
      this.nonConformitiesService.count({
        where: { status: Not(In(['Encerrada', 'Concluída', 'Concluida'])) },
      }),
      this.ddsService.count(),
      this.auditsService.countPendingActionItems(companyId),
      this.nonConformitiesService.countPendingActionItems(companyId),
    ]);

    const actionItems = auditActionItems + nonconformityActionItems;

    const sections: AlertSummarySection[] = [];

    if (includeCompliance) {
      sections.push({
        title: 'Conformidade',
        items: [
          { label: 'EPIs vencidos', value: episExpired, critical: true },
          {
            label: `EPIs a vencer nos próximos ${days} dias`,
            value: episExpiring,
            critical: false,
          },
          {
            label: 'Treinamentos vencidos',
            value: trainingsExpired,
            critical: true,
          },
          {
            label: `Treinamentos a vencer nos próximos ${days} dias`,
            value: trainingsExpiring,
            critical: false,
          },
        ],
      });
    }

    if (includeOperations) {
      sections.push({
        title: 'Operações',
        items: [
          {
            label: 'Permissões de Trabalho aguardando aprovação',
            value: pendingPts,
            critical: false,
          },
          {
            label: 'PTs com início ultrapassado e ainda pendentes',
            value: urgentPts,
            critical: true,
          },
          {
            label: 'APRs aguardando aprovação',
            value: pendingAprs,
            critical: false,
          },
          {
            label: 'Checklists de inspeção pendentes',
            value: pendingChecklists,
            critical: false,
          },
          {
            label: 'DDS registrados no total',
            value: ddsCount,
            critical: false,
          },
        ],
      });
    }

    if (includeOccurrences) {
      sections.push({
        title: 'Ocorrências',
        items: [
          {
            label: 'Não conformidades em aberto',
            value: openNonconformities,
            critical: true,
          },
          {
            label: 'Ações corretivas pendentes (inspeções, auditorias e NCs)',
            value: actionItems,
            critical: false,
          },
        ],
      });
    }

    const compliancePendingCount = includeCompliance
      ? episExpired + episExpiring + trainingsExpired + trainingsExpiring
      : 0;
    const operationsPendingCount = includeOperations
      ? pendingPts + urgentPts + pendingAprs + pendingChecklists
      : 0;
    const occurrencesPendingCount = includeOccurrences
      ? openNonconformities + actionItems
      : 0;
    const pendingItemsCount =
      compliancePendingCount + operationsPendingCount + occurrencesPendingCount;

    const lines: string[] = [
      `Resumo de segurança do trabalho — ${now.toLocaleDateString('pt-BR')}`,
      '',
    ];

    if (!sections.length) {
      lines.push(
        'Nenhuma seção do resumo está habilitada nas configurações da empresa.',
        'Ative pelo menos uma seção em Configurações > Alertas para receber o panorama diário.',
      );
    } else {
      for (const section of sections) {
        lines.push(`${section.title}:`);
        for (const item of section.items) {
          const flag =
            item.critical && item.value > 0 ? ' — requer ação imediata' : '';
          lines.push(`- ${item.label}: ${item.value}${flag}`);
        }
        lines.push('');
      }

      if (pendingItemsCount > 0) {
        lines.push(`Total de pendências no período: ${pendingItemsCount}`);
        lines.push(
          'Acesse o painel do SGS para tratar as pendências e manter a conformidade da sua operação em dia.',
        );
      } else {
        lines.push(
          'Nenhuma pendência identificada no período. Continue acompanhando pelo painel do SGS.',
        );
      }
    }

    return {
      message: lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd(),
      sections,
      pendingItemsCount,
      compliancePendingCount,
      operationsPendingCount,
      occurrencesPendingCount,
    };
  }

  private buildAlertSummaryBodyHtml(sections: AlertSummarySection[]): string {
    const sectionTitleStyle =
      'margin:20px 0 8px;font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#3e3935;';
    const rowLabelStyle =
      'padding:7px 0;font-size:14px;color:#5c5650;border-bottom:1px solid #e4dfd9;';
    const rowValueStyle =
      'padding:7px 0;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #e4dfd9;color:#25221f;';
    const rowValueCriticalStyle =
      'padding:7px 0;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #e4dfd9;color:#9a3324;';

    return sections
      .map((section) => {
        const rows = section.items
          .map((item) => {
            const valueStyle =
              item.critical && item.value > 0
                ? rowValueCriticalStyle
                : rowValueStyle;
            return `<tr><td style="${rowLabelStyle}">${item.label}</td><td style="${valueStyle}">${item.value}</td></tr>`;
          })
          .join('');
        return `
          <h3 style="${sectionTitleStyle}">${section.title}</h3>
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">${rows}</table>
        `;
      })
      .join('');
  }

  private async sendWhatsappWebhook(payload: {
    to: string[];
    companyId: string;
    companyName?: string;
    message: string;
  }) {
    const webhookUrl = this.configService
      .get<string>('WHATSAPP_WEBHOOK_URL')
      ?.trim();
    if (!webhookUrl) {
      return { sent: false };
    }

    const controller = new AbortController();
    const timeoutMs = 15000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.integration.execute(
        'whatsapp_webhook',
        () =>
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          }),
        { timeoutMs, retry: { attempts: 2, mode: 'safe' } },
      );
      const sent = response.ok;
      if (!sent) {
        this.logger.warn({
          event: 'whatsapp_webhook_failed',
          status: response.status,
        });
      }
      return { sent };
    } catch (error) {
      const message = this.extractErrorMessage(error);
      this.logger.warn({
        event: 'whatsapp_webhook_error',
        error: message,
      });
      return { sent: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  // SECURITY: uso de @Cron evita saturar o event loop com setInterval
  @Cron(CronExpression.EVERY_MINUTE)
  private async runScheduledAlerts() {
    if (!this.mailDeliveryEnabled) {
      return;
    }

    if (isApiCronDisabled()) {
      this.logger.warn({
        event: 'mail_scheduled_alerts_skipped',
        reason: 'API_CRONS_DISABLED',
      });
      return;
    }

    if (!this.hasConfiguredProvider()) {
      const now = Date.now();
      if (now - this.lastMissingProviderScheduledAlertWarnAt > 60 * 60_000) {
        this.lastMissingProviderScheduledAlertWarnAt = now;
        this.logger.warn({
          event: 'mail_scheduled_alerts_skipped',
          reason: 'MAIL_PROVIDER_NOT_CONFIGURED',
        });
      }
      return;
    }

    if (this.alertsRunning) {
      return;
    }

    const minIntervalMs = this.getEnvNumber(
      'MAIL_ALERT_SCHEDULE_MIN_INTERVAL_MS',
      5 * 60_000,
    );
    const lockTtlMs = Math.max(
      minIntervalMs,
      this.getEnvNumber('MAIL_ALERT_SCHEDULE_LOCK_TTL_MS', 10 * 60_000),
    );
    const now = Date.now();
    if (now - this.lastScheduledAlertsAt < minIntervalMs) {
      return;
    }

    let lock: DistributedLockHandle | null;
    try {
      lock = await this.distributedLock.tryAcquire(
        'mail:scheduled-alerts',
        lockTtlMs,
      );
    } catch (error) {
      this.logger.error({
        event: 'mail_scheduled_alerts_lock_error',
        error: this.extractErrorMessage(error),
      });
      return;
    }

    if (!lock) {
      this.logger.debug({
        event: 'mail_scheduled_alerts_skipped',
        reason: 'LOCK_NOT_ACQUIRED',
      });
      return;
    }

    this.alertsRunning = true;
    try {
      this.lastScheduledAlertsAt = now;
      const companies = await this.companiesService.findAllActive();
      if (!companies.length) {
        return;
      }

      const batchSize = this.getEnvNumber('MAIL_ALERT_COMPANY_BATCH_SIZE', 10);
      const maxParallel = this.getEnvNumber(
        'MAIL_ALERT_COMPANY_MAX_PARALLEL',
        2,
      );
      const companyBatch = this.selectCompanyBatch(companies, batchSize);

      for (let i = 0; i < companyBatch.length; i += maxParallel) {
        const chunk = companyBatch.slice(i, i + maxParallel);
        const results = await Promise.allSettled(
          chunk.map(async (company) => {
            const settings = await this.getCompanyAlertSettings(company.id);
            const nowDate = new Date();
            if (!this.shouldDispatchScheduledAlert(settings, nowDate)) {
              return null;
            }

            const result = await this.dispatchAlerts({
              companyId: company.id,
              respectAutomationEnabled: true,
            });

            if (result.recipients.length) {
              await this.markScheduledDispatch(company.id, settings, nowDate);
            }

            return result;
          }),
        );

        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            return;
          }

          this.logger.warn({
            event: 'mail_scheduled_alert_company_failed',
            companyId: chunk[index]?.id,
            error: this.extractErrorMessage(result.reason),
          });
        });
      }
    } finally {
      this.alertsRunning = false;
      try {
        await this.distributedLock.release(lock);
      } catch (error) {
        this.logger.warn({
          event: 'mail_scheduled_alerts_lock_release_failed',
          error: this.extractErrorMessage(error),
        });
      }
    }
  }

  async listLogs(filters: {
    page?: string;
    pageSize?: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    to?: string;
    subject?: string;
    messageId?: string;
    companyId?: string;
    userId?: string;
  }) {
    const page = Math.max(Number(filters.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(filters.pageSize) || 20, 1), 100);
    const skip = (page - 1) * pageSize;

    const query = this.mailLogRepository
      .createQueryBuilder('log')
      .orderBy('log.created_at', 'DESC')
      .skip(skip)
      .take(pageSize);

    if (filters.companyId) {
      query.andWhere('log.company_id = :companyId', {
        companyId: filters.companyId,
      });
    }

    if (filters.userId) {
      query.andWhere('log.user_id = :userId', { userId: filters.userId });
    }

    if (filters.status) {
      query.andWhere('log.status = :status', { status: filters.status });
    }

    if (filters.to) {
      query.andWhere('log.to ILIKE :to', { to: `%${filters.to}%` });
    }

    if (filters.subject) {
      query.andWhere('log.subject ILIKE :subject', {
        subject: `%${filters.subject}%`,
      });
    }

    if (filters.messageId) {
      query.andWhere('log.message_id ILIKE :messageId', {
        messageId: `%${filters.messageId}%`,
      });
    }

    const startDate = filters.startDate
      ? new Date(filters.startDate)
      : undefined;
    if (startDate && !Number.isNaN(startDate.getTime())) {
      query.andWhere('log.created_at >= :startDate', { startDate });
    }

    const endDate = filters.endDate ? new Date(filters.endDate) : undefined;
    if (endDate && !Number.isNaN(endDate.getTime())) {
      query.andWhere('log.created_at <= :endDate', { endDate });
    }

    const [items, total] = await query.getManyAndCount();

    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  async exportLogs(filters: {
    startDate?: string;
    endDate?: string;
    status?: string;
    to?: string;
    subject?: string;
    messageId?: string;
    companyId?: string;
    userId?: string;
    limit?: string;
  }) {
    const limit = Math.min(Math.max(Number(filters.limit) || 1000, 1), 5000);
    const query = this.mailLogRepository
      .createQueryBuilder('log')
      .orderBy('log.created_at', 'DESC')
      .take(limit);

    if (filters.companyId) {
      query.andWhere('log.company_id = :companyId', {
        companyId: filters.companyId,
      });
    }

    if (filters.userId) {
      query.andWhere('log.user_id = :userId', { userId: filters.userId });
    }

    if (filters.status) {
      query.andWhere('log.status = :status', { status: filters.status });
    }

    if (filters.to) {
      query.andWhere('log.to ILIKE :to', { to: `%${filters.to}%` });
    }

    if (filters.subject) {
      query.andWhere('log.subject ILIKE :subject', {
        subject: `%${filters.subject}%`,
      });
    }

    if (filters.messageId) {
      query.andWhere('log.message_id ILIKE :messageId', {
        messageId: `%${filters.messageId}%`,
      });
    }

    const startDate = filters.startDate
      ? new Date(filters.startDate)
      : undefined;
    if (startDate && !Number.isNaN(startDate.getTime())) {
      query.andWhere('log.created_at >= :startDate', { startDate });
    }

    const endDate = filters.endDate ? new Date(filters.endDate) : undefined;
    if (endDate && !Number.isNaN(endDate.getTime())) {
      query.andWhere('log.created_at <= :endDate', { endDate });
    }

    const logs = await query.getMany();
    const header = [
      'id',
      'company_id',
      'user_id',
      'to',
      'subject',
      'filename',
      'message_id',
      'accepted',
      'rejected',
      'provider_response',
      'using_test_account',
      'status',
      'error_message',
      'created_at',
    ];

    const rows = logs.map((log) => [
      log.id,
      log.company_id,
      log.user_id,
      log.to,
      log.subject,
      log.filename,
      log.message_id,
      JSON.stringify(log.accepted || []),
      JSON.stringify(log.rejected || []),
      log.provider_response,
      String(log.using_test_account),
      log.status,
      log.error_message,
      log.created_at ? log.created_at.toISOString() : '',
    ]);

    const csv =
      [header, ...rows]
        .map((row) =>
          row
            .map((value) => {
              const text =
                value === undefined || value === null ? '' : String(value);
              const escaped = text.replace(/"/g, '""');
              return `"${escaped}"`;
            })
            .join(','),
        )
        .join('\n') + '\n';

    const filename = `mail-logs-${new Date().toISOString().slice(0, 10)}.csv`;

    return { csv, filename };
  }

  private getEnvNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }

  private normalizeMailFailure(error: unknown): MailFailureDetails {
    const message =
      this.extractErrorMessage(error).trim() || 'Erro desconhecido';

    const circuitBreakerMatch = message.match(
      /Circuit breaker integration:(?:smtp|resend)_email is OPEN(?:\.\s*Retry after\s*(\d+)ms\.)?/i,
    );
    if (circuitBreakerMatch) {
      const retryAfterMs = Number(circuitBreakerMatch[1] || '30000');
      const retryAfterSeconds = Number.isFinite(retryAfterMs)
        ? Math.max(1, Math.ceil(retryAfterMs / 1000))
        : 30;

      return {
        message:
          'A integracao de e-mail entrou em protecao apos falhas recentes. Aguarde alguns instantes e tente novamente.',
        code: 'MAIL_PROVIDER_CIRCUIT_OPEN',
        retryAfterSeconds,
      };
    }

    if (
      /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout|timed out|socket hang up|connection reset/i.test(
        message,
      )
    ) {
      return {
        message:
          'A integracao de e-mail nao respondeu a tempo. O envio nao foi concluido. Tente novamente em instantes e valide a conectividade do provedor.',
        code: 'MAIL_PROVIDER_TIMEOUT',
      };
    }

    if (/MAIL_ENABLED=false/i.test(message)) {
      return {
        message,
        code: 'MAIL_DISABLED',
      };
    }

    return {
      message,
      code: 'MAIL_DELIVERY_FAILED',
    };
  }

  private selectCompanyBatch<T extends { id: string }>(
    companies: T[],
    batchSize: number,
  ): T[] {
    if (!companies.length) {
      return [];
    }
    const size = Math.max(1, Math.min(batchSize, companies.length));
    const start = this.scheduledAlertsCursor % companies.length;
    const selected: T[] = [];

    for (let index = 0; index < size; index += 1) {
      selected.push(companies[(start + index) % companies.length]);
    }

    this.scheduledAlertsCursor = (start + size) % companies.length;
    return selected;
  }

  private computeNextScheduledDispatchAt(
    settings: CompanyAlertSettings,
    baseDate = new Date(),
  ): string | null {
    if (!settings.enabled) {
      return null;
    }

    let candidate = new Date(baseDate);

    if (settings.snoozeUntil) {
      const snoozeUntil = new Date(settings.snoozeUntil);
      if (!Number.isNaN(snoozeUntil.getTime()) && snoozeUntil > candidate) {
        candidate = snoozeUntil;
      }
    }

    candidate.setMinutes(0, 0, 0);
    if (candidate.getHours() >= settings.deliveryHour) {
      candidate.setDate(candidate.getDate() + 1);
    }
    candidate.setHours(settings.deliveryHour, 0, 0, 0);

    if (settings.lastScheduledDispatchAt) {
      const lastSent = new Date(settings.lastScheduledDispatchAt);
      if (!Number.isNaN(lastSent.getTime())) {
        const minByCadence = new Date(lastSent);
        minByCadence.setHours(settings.deliveryHour, 0, 0, 0);
        minByCadence.setDate(minByCadence.getDate() + settings.cadenceDays);
        if (candidate < minByCadence) {
          candidate = minByCadence;
        }
      }
    }

    if (settings.weekdaysOnly) {
      while (candidate.getDay() === 0 || candidate.getDay() === 6) {
        candidate.setDate(candidate.getDate() + 1);
        candidate.setHours(settings.deliveryHour, 0, 0, 0);
      }
    }

    return candidate.toISOString();
  }

  private shouldDispatchScheduledAlert(
    settings: CompanyAlertSettings,
    now: Date,
  ): boolean {
    if (!settings.enabled) {
      return false;
    }

    if (settings.snoozeUntil) {
      const snoozeUntil = new Date(settings.snoozeUntil);
      if (!Number.isNaN(snoozeUntil.getTime()) && now < snoozeUntil) {
        return false;
      }
    }

    if (settings.weekdaysOnly) {
      const day = now.getDay();
      if (day === 0 || day === 6) {
        return false;
      }
    }

    if (now.getHours() !== settings.deliveryHour) {
      return false;
    }

    if (!settings.lastScheduledDispatchAt) {
      return true;
    }

    const lastSent = new Date(settings.lastScheduledDispatchAt);
    if (Number.isNaN(lastSent.getTime())) {
      return true;
    }

    const nowStart = new Date(now);
    nowStart.setHours(0, 0, 0, 0);
    const lastStart = new Date(lastSent);
    lastStart.setHours(0, 0, 0, 0);
    const elapsedDays = Math.floor(
      (nowStart.getTime() - lastStart.getTime()) / (24 * 60 * 60 * 1000),
    );

    return elapsedDays >= settings.cadenceDays;
  }

  private async markScheduledDispatch(
    companyId: string,
    settings: CompanyAlertSettings,
    sentAt: Date,
  ) {
    await this.companiesService.update(companyId, {
      alert_settings: {
        ...settings,
        lastScheduledDispatchAt: sentAt.toISOString(),
      },
    });
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'Erro desconhecido';
  }
}
