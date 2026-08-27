import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { NonConformity } from '../entities/nonconformity.entity';
import { NcStatus } from '../nonconformities.service';
import { TenantService } from '../../../shared/tenant/tenant.service';
import {
  getScopedSiteIds,
  resolveSiteAccessScopeFromTenantService,
} from '../../../shared/tenant/site-access-scope.util';
import { DocumentStorageService } from '../../../shared/services/document-storage.service';
import { PdfService } from '../../../shared/services/pdf.service';
import { DocumentGovernanceService } from '../../document-registry/document-governance.service';
import { cleanupUploadedFile } from '../../../shared/storage/storage-compensation.util';
import {
  GovernedPdfAccessAvailability,
  GovernedPdfAccessResponseDto,
} from '../../../shared/dto/governed-pdf-access-response.dto';
import { NonConformityWorkflowLockService } from './nonconformity-workflow-lock.service';
import { PublicValidationGrantService } from '../../../shared/services/public-validation-grant.service';
import { getNonConformityClosureMissingFields } from '../utils/nonconformity-closure.util';
import {
  CivilDocumentCalendar,
  formatNonConformityCivilDate,
  getNonConformityCivilCalendar,
  parseNonConformityCivilDate,
  parseNonConformityTimestampDate,
} from '../utils/nonconformity-document-calendar.util';

export type NcPdfAccessAvailability = GovernedPdfAccessAvailability;
type NcPdfAccessResponse = GovernedPdfAccessResponseDto;

type GovernedAttachmentReferencePayload = {
  v: 1;
  kind: 'governed-storage';
  fileKey: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  sizeBytes?: number | null;
};

type PdfImagePresentation = {
  dataUri: string;
  label: string;
  orientation: 'portrait' | 'landscape' | 'square' | 'unknown';
};

type PublicValidationPresentation = {
  url: string | null;
  qrDataUri: string | null;
};

const GOVERNED_ATTACHMENT_REF_PREFIX = 'gst:nc-attachment:';
const MAX_EMBEDDED_PHOTOS = 24;
const MAX_EMBEDDED_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_COMPANY_LOGO_BYTES = 2 * 1024 * 1024;
const PDF_TIME_ZONE = 'America/Araguaina';
const PUBLIC_VALIDATION_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

// Espelha NC_STATUS_LABEL do frontend (nonConformitiesService.ts) — o PDF
// oficial deve mostrar o rótulo em português usado no resto do sistema, não
// o valor bruto do enum (ex.: "Aberta", não "ABERTA").
const NC_STATUS_LABEL_PT: Record<string, string> = {
  [NcStatus.ABERTA]: 'Aberta',
  [NcStatus.EM_ANDAMENTO]: 'Em Andamento',
  [NcStatus.AGUARDANDO_VALIDACAO]: 'Aguardando Validação',
  [NcStatus.ENCERRADA]: 'Encerrada',
};

@Injectable()
export class NonConformitiesPdfService {
  private readonly logger = new Logger(NonConformitiesPdfService.name);

  constructor(
    @InjectRepository(NonConformity)
    private readonly nonConformitiesRepository: Repository<NonConformity>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly pdfService: PdfService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly workflowLock: NonConformityWorkflowLockService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
  ) {}

  private async findOneEntity(id: string): Promise<NonConformity> {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'nao conformidades',
    );
    const nc = await this.nonConformitiesRepository.findOne({
      where: {
        id,
        company_id: scope.companyId,
        deleted_at: IsNull(),
        ...(!scope.hasCompanyWideAccess
          ? { site_id: In(getScopedSiteIds(scope)) }
          : {}),
      },
      relations: ['site', 'company', 'checklist', 'resolved_by_user'],
    });

    if (!nc) {
      throw new NotFoundException(
        `Não conformidade com ID ${id} não encontrada`,
      );
    }

    return nc;
  }

  private normalizeStatus(value?: string | null): NcStatus {
    const known = Object.values(NcStatus);
    return known.includes(value as NcStatus)
      ? (value as NcStatus)
      : NcStatus.ABERTA;
  }

  async getPdfAccess(id: string): Promise<NcPdfAccessResponse> {
    const nc = await this.findOneEntity(id);
    if (!nc.pdf_file_key) {
      return {
        entityId: nc.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'PDF final ainda não foi emitido para esta não conformidade.',
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
    }

    try {
      const url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          nc.pdf_file_key,
          {
            resourceType: 'nonconformity',
            resourceId: nc.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
      );
      return {
        entityId: nc.id,
        hasFinalPdf: true,
        availability: 'ready',
        fileKey: nc.pdf_file_key,
        folderPath: nc.pdf_folder_path || null,
        originalName: nc.pdf_original_name || null,
        url,
        message: null,
      };
    } catch (error) {
      this.logger.warn({
        event: 'nonconformity_final_pdf_signed_url_failed',
        nonconformityId: id,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return {
        entityId: nc.id,
        hasFinalPdf: true,
        availability: 'registered_without_signed_url',
        fileKey: nc.pdf_file_key,
        folderPath: nc.pdf_folder_path || null,
        originalName: nc.pdf_original_name || null,
        url: null,
        message:
          'PDF final registrado, mas a URL segura do storage não está disponível no momento.',
      };
    }
  }

  async generateFinalPdf(
    id: string,
    userId?: string,
  ): Promise<NcPdfAccessResponse & { generated: boolean }> {
    return this.workflowLock.runExclusive(
      id,
      (assertLeaseHealthy: () => void) =>
        this.generateFinalPdfLocked(id, assertLeaseHealthy, userId),
    );
  }

  private async generateFinalPdfLocked(
    id: string,
    assertLeaseHealthy: () => void,
    userId?: string,
  ): Promise<NcPdfAccessResponse & { generated: boolean }> {
    const nc = await this.findOneEntity(id);
    const status = this.normalizeStatus(nc.status);

    if (nc.pdf_file_key) {
      return { ...(await this.getPdfAccess(id)), generated: false };
    }

    if (status !== NcStatus.ENCERRADA) {
      throw new BadRequestException(
        'O PDF final só pode ser emitido após o encerramento da não conformidade.',
      );
    }

    const missingClosureFields = getNonConformityClosureMissingFields(nc);
    if (missingClosureFields.length > 0) {
      throw new UnprocessableEntityException(
        `Não é possível emitir o PDF final: a não conformidade encerrada está incompleta. Preencha: ${missingClosureFields.join(', ')}.`,
      );
    }

    const documentCode = this.buildNcDocumentCode(nc);
    const verificationCode =
      nc.verification_code ||
      `NC-${randomBytes(5).toString('hex').toUpperCase()}`;
    const generatedAt = new Date();

    let logoDataUri: string | null = null;
    if (nc.company?.logo_storage_key) {
      try {
        logoDataUri = await this.resolveCompanyLogoDataUri(
          nc.company.logo_storage_key,
          nc.company_id,
        );
      } catch {
        this.logger.warn(
          `Falha ao resolver logo da empresa para PDF da NC ${id}`,
        );
      }
    }

    const { images, unembeddedAttachments } =
      await this.resolveAttachmentPresentation(nc);
    const publicValidation = await this.buildPublicValidationPresentation(
      nc,
      documentCode,
    );

    const html = this.renderNcFinalPdfHtml({
      nc,
      images,
      unembeddedAttachments,
      documentCode,
      logoDataUri,
      authenticity: {
        verificationCode,
        generatedAt,
        integrityMessage:
          'O hash SHA-256 é calculado e registrado no catálogo oficial após a emissão.',
        ...publicValidation,
      },
    });

    const buffer = await this.pdfService.generateFromHtml(html, {
      format: 'A4',
      landscape: false,
      preferCssPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: this.buildFooterTemplate({ documentCode, generatedAt }),
      margin: { top: '0mm', right: '0mm', bottom: '22mm', left: '0mm' },
    });

    const originalName = this.buildFinalPdfOriginalName(nc);
    try {
      assertLeaseHealthy();
      await this.storeFinalPdfBuffer(nc, {
        buffer,
        originalName,
        mimeType: 'application/pdf',
        userId,
        verificationCode,
        generatedAt,
        documentCode,
        assertLeaseHealthy,
      });
    } catch (error) {
      // Defesa para rollout com mais de uma réplica em versões diferentes:
      // a atualização condicional abaixo pode indicar que outra emissão já
      // finalizou a NC. O arquivo recém-enviado já foi compensado em
      // storeFinalPdfBuffer; neste caso devolvemos a versão oficial existente.
      try {
        const refreshed = await this.findOneEntity(id);
        if (refreshed.pdf_file_key) {
          return { ...(await this.getPdfAccess(id)), generated: false };
        }
      } catch {
        // Preserva o erro original de governança/estado se a releitura falhar.
      }
      throw error;
    }

    return { ...(await this.getPdfAccess(id)), generated: true };
  }

  private async storeFinalPdfBuffer(
    nc: NonConformity,
    input: {
      buffer: Buffer;
      originalName: string;
      mimeType: string;
      userId?: string;
      verificationCode: string;
      generatedAt: Date;
      documentCode: string;
      assertLeaseHealthy: () => void;
    },
  ): Promise<{ fileKey: string; folderPath: string; originalName: string }> {
    const documentDate = this.resolveNcDocumentDate(nc);
    const calendar = this.resolveNcDocumentCalendar(nc);
    const year = calendar.year;
    const week = String(calendar.isoWeek).padStart(2, '0');

    const fileKey = this.documentStorageService.generateDocumentKey(
      nc.company_id,
      'nonconformities',
      nc.id,
      input.originalName,
      {
        folderSegments: [
          ...(nc.site_id ? ['sites', nc.site_id] : []),
          String(year),
          `week-${week}`,
        ],
      },
    );
    const folderPath = fileKey.split('/').slice(0, -1).join('/');

    input.assertLeaseHealthy();
    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'nonconformity', resourceId: nc.id },
          'p1-document-storage-uploadFile',
        ),
        input.buffer,
        input.mimeType,
      );

    try {
      input.assertLeaseHealthy();
      await this.documentGovernanceService.registerFinalDocument({
        companyId: nc.company_id,
        module: 'nonconformity',
        entityId: nc.id,
        title: nc.codigo_nc || nc.tipo || 'Não Conformidade',
        documentDate,
        documentCode: input.documentCode,
        fileKey,
        folderPath,
        originalName: input.originalName,
        mimeType: input.mimeType,
        createdBy: input.userId,
        fileBuffer: input.buffer,
        persistEntityMetadata: async (manager, computedHash) => {
          input.assertLeaseHealthy();
          const result = await manager
            .getRepository(NonConformity)
            .createQueryBuilder()
            .update(NonConformity)
            .set({
              pdf_file_key: fileKey,
              pdf_folder_path: folderPath,
              pdf_original_name: input.originalName,
              final_pdf_hash_sha256: computedHash,
              verification_code: input.verificationCode,
              pdf_generated_at: input.generatedAt,
            })
            .where('id = :id', { id: nc.id })
            .andWhere('company_id = :companyId', {
              companyId: nc.company_id,
            })
            .andWhere('status = :closedStatus', {
              closedStatus: NcStatus.ENCERRADA,
            })
            .andWhere('pdf_file_key IS NULL')
            .execute();

          if (result.affected !== 1) {
            throw new ConflictException(
              'A não conformidade foi alterada durante a emissão do PDF final. Revise o status e tente novamente.',
            );
          }
        },
      });
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `nonconformity:${nc.id}`,
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }

    return { fileKey, folderPath, originalName: input.originalName };
  }

  private buildNcDocumentCode(
    nc: Pick<NonConformity, 'id' | 'data_identificacao' | 'created_at'>,
  ): string {
    const calendar = this.resolveNcDocumentCalendar(nc);
    const year = calendar.year;
    const week = String(calendar.isoWeek).padStart(2, '0');
    return `NONCONFORMITY-${year}-${week}-${nc.id.slice(0, 8).toUpperCase()}`;
  }

  private resolveNcDocumentCalendar(
    nc: Pick<NonConformity, 'data_identificacao' | 'created_at'>,
  ): CivilDocumentCalendar {
    const civilDate =
      parseNonConformityCivilDate(nc.data_identificacao) ||
      parseNonConformityTimestampDate(nc.created_at, PDF_TIME_ZONE) ||
      parseNonConformityTimestampDate(new Date(), PDF_TIME_ZONE);

    // `new Date()` é sempre válido; o fallback abaixo apenas mantém o tipo
    // explícito e evita que uma entrada legada inválida altere o código/pasta.
    return getNonConformityCivilCalendar(
      civilDate || { year: 1970, month: 1, day: 1 },
    );
  }

  private resolveNcDocumentDate(
    nc: Pick<NonConformity, 'data_identificacao' | 'created_at'>,
  ): Date {
    const calendar = this.resolveNcDocumentCalendar(nc);
    return new Date(Date.UTC(calendar.year, calendar.month - 1, calendar.day));
  }

  private buildFinalPdfOriginalName(
    nc: Pick<NonConformity, 'codigo_nc' | 'id'>,
  ): string {
    const reference = String(nc.codigo_nc || nc.id || 'nc')
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return `${reference || 'nc'}.pdf`;
  }

  /**
   * Cria uma URL pública apenas a partir de uma origem configurada e de um
   * grant assinado do servidor. O HTML do PDF recebe o QR como data URI, sem
   * qualquer download de rede durante a renderização do Chromium.
   */
  private async buildPublicValidationPresentation(
    nc: Pick<NonConformity, 'id' | 'company_id'>,
    documentCode: string,
  ): Promise<PublicValidationPresentation> {
    const portalOrigin = this.resolvePublicValidationPortalOrigin();
    if (!portalOrigin) {
      this.logger.warn({
        event: 'nonconformity_pdf_public_validation_unavailable',
        ncId: nc.id,
        reason: 'public_portal_origin_not_configured',
      });
      return { url: null, qrDataUri: null };
    }

    try {
      const token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: nc.company_id,
        documentId: nc.id,
        portal: 'nonconformity_public_validation',
        expiresInSeconds: PUBLIC_VALIDATION_TOKEN_TTL_SECONDS,
      });
      const validationUrl = new URL(
        `/validar/${encodeURIComponent(documentCode)}`,
        portalOrigin,
      );
      validationUrl.searchParams.set('token', token);
      const url = validationUrl.toString();
      const qrDataUri = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 256,
        color: {
          dark: '#0F2036',
          light: '#FFFFFF',
        },
      });

      return { url, qrDataUri };
    } catch (error) {
      this.logger.warn({
        event: 'nonconformity_pdf_public_validation_unavailable',
        ncId: nc.id,
        companyId: nc.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { url: null, qrDataUri: null };
    }
  }

  private resolvePublicValidationPortalOrigin(): string | null {
    const configuredOrigins = [
      process.env.FRONTEND_URL,
      process.env.NEXT_PUBLIC_APP_URL,
      process.env.APP_URL,
    ];

    for (const candidate of configuredOrigins) {
      const value = String(candidate || '').trim();
      if (!value) {
        continue;
      }

      try {
        const parsed = new URL(value);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          return parsed.origin;
        }
      } catch {
        // Tenta a próxima variável; nenhum valor é interpolado no HTML.
      }
    }

    return null;
  }

  /**
   * O renderer de PDF bloqueia rede externa por segurança. Logo, logos de
   * empresa precisam ser convertidos para data URI antes de entrar no HTML.
   */
  private async resolveCompanyLogoDataUri(
    storageKey: string,
    companyId: string,
  ): Promise<string | null> {
    const buffer = await this.documentStorageService.downloadFileBuffer(
      this.documentStorageService.referenceForExistingObject(
        storageKey,
        { resourceType: 'company', resourceId: companyId },
        'p1-document-storage-downloadFileBuffer',
      ),
    );
    if (buffer.length === 0 || buffer.length > MAX_COMPANY_LOGO_BYTES) {
      this.logger.warn(
        `Logo da empresa ignorado no PDF da NC: tamanho inválido (${buffer.length} bytes)`,
      );
      return null;
    }

    const mimeType = this.resolveSupportedImageMimeType(buffer);
    if (!mimeType) {
      this.logger.warn(
        'Logo da empresa ignorado no PDF da NC: formato de imagem não suportado',
      );
      return null;
    }

    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  private resolveSupportedImageMimeType(
    buffer: Buffer,
  ): 'image/png' | 'image/jpeg' | 'image/webp' | null {
    if (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return 'image/jpeg';
    }
    if (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'image/webp';
    }
    return null;
  }

  private estimateDataUriBytes(value: string): number {
    const separatorIndex = value.indexOf(',');
    if (separatorIndex < 0) return 0;
    const base64Length = value
      .slice(separatorIndex + 1)
      .replace(/\s/g, '').length;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((base64Length * 3) / 4) - padding);
  }

  /**
   * Resolve os anexos da NC em duas listas: fotos incorporáveis (data URIs
   * base64) e anexos não incorporados (texto descritivo). Todo anexo
   * registrado no formulário aparece de alguma forma no PDF final — imagem
   * incorporada, ou, quando não é possível/seguro incorporar (PDF de
   * evidência, imagem que falhou ao carregar, URL manual), ao menos como
   * item de texto — nunca desaparece silenciosamente do documento oficial.
   *
   * Segurança: NUNCA busca URL externa arbitrária (o Puppeteer já bloqueia
   * requisições de rede em `PdfService`, isto é defesa em profundidade contra
   * SSRF). Só duas origens são consideradas seguras para incorporação como
   * imagem:
   *  - `data:image/...` já embutido pelo cliente (captura de câmera);
   *  - referência de anexo governado (`gst:nc-attachment:...`) cujo fileKey
   *    aponta para o storage interno do próprio tenant — baixado via
   *    downloadFileBuffer, com o prefixo completo da própria NC (e obra,
   *    quando aplicável) conferido antes do download.
   * Qualquer outra URL manual (http/https digitado pelo usuário) nunca é
   * baixada — só listada como texto.
   */
  private async resolveAttachmentPresentation(
    nc: Pick<NonConformity, 'id' | 'anexos' | 'company_id' | 'site_id'>,
  ): Promise<{
    images: PdfImagePresentation[];
    unembeddedAttachments: string[];
  }> {
    const entries = Array.isArray(nc.anexos) ? nc.anexos : [];
    const images: PdfImagePresentation[] = [];
    const unembeddedAttachments: string[] = [];
    let embeddedImageBytes = 0;

    const addImage = (
      dataUri: string,
      label: string,
      buffer: Buffer,
    ): boolean => {
      if (images.length >= MAX_EMBEDDED_PHOTOS) {
        unembeddedAttachments.push(
          `${label} (foto não incorporada: limite de ${MAX_EMBEDDED_PHOTOS} fotos por PDF atingido)`,
        );
        return false;
      }
      if (embeddedImageBytes + buffer.length > MAX_EMBEDDED_IMAGE_BYTES) {
        unembeddedAttachments.push(
          `${label} (foto não incorporada: limite total de evidências visuais do PDF atingido)`,
        );
        return false;
      }

      images.push({
        dataUri,
        label,
        orientation: this.resolveImageOrientation(buffer),
      });
      embeddedImageBytes += buffer.length;
      return true;
    };

    for (const [index, rawEntry] of entries.entries()) {
      const entry = String(rawEntry || '').trim();
      if (!entry) continue;

      if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(entry)) {
        const sizeBytes = this.estimateDataUriBytes(entry);
        const label = `Foto anexada ${index + 1}`;
        if (sizeBytes === 0 || sizeBytes > MAX_EMBEDDED_IMAGE_BYTES) {
          unembeddedAttachments.push(
            `${label} (foto legada não incorporada: tamanho inválido para o PDF)`,
          );
          continue;
        }

        const encoded = entry.slice(entry.indexOf(',') + 1);
        const buffer = Buffer.from(encoded, 'base64');
        const mimeType = this.resolveSupportedImageMimeType(buffer);
        if (!mimeType) {
          unembeddedAttachments.push(
            `${label} (foto legada não incorporada: formato não suportado)`,
          );
          continue;
        }

        addImage(
          `data:${mimeType};base64,${buffer.toString('base64')}`,
          label,
          buffer,
        );
        continue;
      }

      const governed = this.parseGovernedAttachmentReference(entry);
      if (governed) {
        const label = governed.originalName || `Anexo governado ${index + 1}`;
        if (
          governed.mimeType.startsWith('image/') &&
          this.isExpectedAttachmentStorageKey(nc, governed.fileKey)
        ) {
          if (images.length >= MAX_EMBEDDED_PHOTOS) {
            unembeddedAttachments.push(
              `${label} (foto não incorporada: limite de ${MAX_EMBEDDED_PHOTOS} fotos por PDF atingido)`,
            );
            continue;
          }
          try {
            const buffer = await this.documentStorageService.downloadFileBuffer(
              this.documentStorageService.referenceForExistingObject(
                governed.fileKey,
                {
                  resourceType: 'nc-attachment',
                  resourceId: nc.id,
                },
                'p1-document-storage-downloadFileBuffer',
              ),
            );
            const mimeType = this.resolveSupportedImageMimeType(buffer);
            if (!mimeType) {
              unembeddedAttachments.push(
                `${label} (foto não incorporada: conteúdo não corresponde a uma imagem suportada)`,
              );
              continue;
            }
            addImage(
              `data:${mimeType};base64,${buffer.toString('base64')}`,
              label,
              buffer,
            );
          } catch (error) {
            this.logger.warn({
              event: 'nonconformity_governed_attachment_embed_failed',
              keyFingerprint: createHash('sha256')
                .update(governed.fileKey)
                .digest('hex')
                .slice(0, 16),
              errorName: error instanceof Error ? error.name : 'unknown_error',
            });
            unembeddedAttachments.push(
              `${label} (falha ao carregar a pré-visualização; disponível no storage oficial da não conformidade)`,
            );
          }
        } else {
          unembeddedAttachments.push(
            `${label} (arquivo ${governed.mimeType}, disponível no storage oficial da não conformidade)`,
          );
        }
        continue;
      }

      if (entry.startsWith('data:')) {
        unembeddedAttachments.push(
          `Anexo legado ${index + 1} não incorporado (formato não suportado)`,
        );
      } else {
        unembeddedAttachments.push(`Referência manual: ${entry.slice(0, 320)}`);
      }
    }

    return { images, unembeddedAttachments };
  }

  private isExpectedAttachmentStorageKey(
    nc: Pick<NonConformity, 'id' | 'company_id' | 'site_id'>,
    fileKey: string,
  ): boolean {
    const basePrefix = `documents/${nc.company_id}/nonconformity-attachments/`;
    const directPrefix = `${basePrefix}${nc.id}/`;
    const sitePrefix = nc.site_id
      ? `${basePrefix}sites/${nc.site_id}/${nc.id}/`
      : null;

    return (
      fileKey.startsWith(directPrefix) ||
      Boolean(sitePrefix && fileKey.startsWith(sitePrefix))
    );
  }

  private resolveImageOrientation(
    buffer: Buffer,
  ): PdfImagePresentation['orientation'] {
    const dimensions = this.resolveImageDimensions(buffer);
    if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
      return 'unknown';
    }

    const ratio = dimensions.width / dimensions.height;
    if (ratio > 1.12) {
      return 'landscape';
    }
    if (ratio < 0.89) {
      return 'portrait';
    }
    return 'square';
  }

  private resolveImageDimensions(
    buffer: Buffer,
  ): { width: number; height: number } | null {
    if (
      buffer.length >= 24 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }

    if (
      buffer.length >= 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      return this.resolveJpegDimensions(buffer);
    }

    if (
      buffer.length >= 30 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return this.resolveWebpDimensions(buffer);
    }

    return null;
  }

  private resolveJpegDimensions(
    buffer: Buffer,
  ): { width: number; height: number } | null {
    const startOfFrameMarkers = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
      0xcf,
    ]);
    let offset = 2;

    while (offset + 3 < buffer.length) {
      while (offset < buffer.length && buffer[offset] !== 0xff) {
        offset += 1;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= buffer.length) {
        return null;
      }

      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9) {
        continue;
      }
      if (marker === 0xda || offset + 1 >= buffer.length) {
        return null;
      }

      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) {
        return null;
      }
      if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
        return {
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }

    return null;
  }

  private resolveWebpDimensions(
    buffer: Buffer,
  ): { width: number; height: number } | null {
    const variant = buffer.subarray(12, 16).toString('ascii');
    if (variant === 'VP8X' && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }

    if (variant === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
      };
    }

    if (
      variant === 'VP8 ' &&
      buffer.length >= 30 &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a
    ) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }

    return null;
  }

  private parseGovernedAttachmentReference(
    value?: string | null,
  ): GovernedAttachmentReferencePayload | null {
    if (!value || !value.startsWith(GOVERNED_ATTACHMENT_REF_PREFIX)) {
      return null;
    }
    try {
      const encoded = value.slice(GOVERNED_ATTACHMENT_REF_PREFIX.length);
      const parsed = JSON.parse(
        Buffer.from(encoded, 'base64url').toString('utf8'),
      ) as GovernedAttachmentReferencePayload;
      if (
        parsed?.v !== 1 ||
        parsed?.kind !== 'governed-storage' ||
        typeof parsed.fileKey !== 'string' ||
        typeof parsed.mimeType !== 'string'
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private escapeHtml(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    const str =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
          ? String(value)
          : '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private formatCivilDate(
    value?: Date | string | null,
    fallback = '-',
  ): string {
    return formatNonConformityCivilDate(
      parseNonConformityCivilDate(value),
      fallback,
    );
  }

  private formatOperationDate(
    value?: Date | string | null,
    fallback = '-',
  ): string {
    return formatNonConformityCivilDate(
      parseNonConformityTimestampDate(value, PDF_TIME_ZONE),
      fallback,
    );
  }

  private formatDisplayDateTime(
    value?: Date | string | null,
    fallback = '-',
  ): string {
    if (!value) return fallback;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) return fallback;
    return parsed.toLocaleString('pt-BR', { timeZone: PDF_TIME_ZONE });
  }

  private textOr(value?: string | null, fallback = '-'): string {
    const trimmed = String(value ?? '').trim();
    return trimmed ? trimmed : fallback;
  }

  private buildFooterTemplate(input: {
    documentCode: string;
    generatedAt: Date;
  }): string {
    return `
      <div style="width: 100%; font-size: 7.1pt; color: #374151; padding: 0 16mm 2mm; box-sizing: border-box; font-family: Arial, Helvetica, sans-serif;">
        <div style="border-top: 0.25mm solid #D3DCE6; padding-top: 1.3mm; display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
          <div>
            <div style="font-weight: 700;">SGS &mdash; Sistema de Gestão de Segurança</div>
            <div>Gerado em ${this.escapeHtml(this.formatDisplayDateTime(input.generatedAt))}</div>
          </div>
          <div style="text-align: right;">
            <div style="font-weight: 700;">ID: ${this.escapeHtml(input.documentCode)}</div>
            <div>Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Paleta e tipografia espelham os tokens do design system de PDF do SGS
   * (frontend/src/lib/pdf-system/tokens — pdfColors/visualTokens/pdfTypography)
   * usado por APR/PT/DDS/Checklist, para o PDF da NC ficar visualmente
   * consistente com os demais documentos oficiais do sistema.
   */
  private renderNcFinalPdfHtml(input: {
    nc: NonConformity;
    documentCode: string;
    logoDataUri: string | null;
    images: PdfImagePresentation[];
    unembeddedAttachments: string[];
    authenticity: {
      verificationCode: string;
      generatedAt: Date;
      integrityMessage: string;
      url: string | null;
      qrDataUri: string | null;
    };
  }): string {
    const {
      nc,
      documentCode,
      logoDataUri,
      images,
      unembeddedAttachments,
      authenticity,
    } = input;
    const esc = (v: unknown) => this.escapeHtml(v);
    const statusLabel = (value?: string | null) =>
      NC_STATUS_LABEL_PT[value || ''] || this.textOr(value);

    const gridField = (label: string, value: string) => `
      <div class="grid-field">
        <div class="label">${esc(label)}</div>
        <div class="value">${esc(value)}</div>
      </div>
    `;

    const narrativeCard = (title: string, content?: string | null) => `
      <div class="card">
        <div class="card-title-strip">${esc(title)}</div>
        <div class="card-body"><p>${esc(this.textOr(content))}</p></div>
      </div>
    `;

    const actionCard = (title: string, fields: Array<[string, string]>) => `
      <div class="card">
        <div class="card-title-strip">${esc(title)}</div>
        <div class="grid-2">
          ${fields.map(([label, value]) => gridField(label, value)).join('')}
        </div>
      </div>
    `;

    const listOrDash = (values?: string[] | null) =>
      values && values.length > 0 ? values.join(', ') : '-';

    const hasImediata = Boolean(
      nc.acao_imediata_descricao ||
      nc.acao_imediata_responsavel ||
      nc.acao_imediata_data ||
      nc.acao_imediata_status,
    );
    const hasDefinitiva = Boolean(
      nc.acao_definitiva_descricao ||
      nc.acao_definitiva_responsavel ||
      nc.acao_definitiva_recursos ||
      nc.acao_definitiva_prazo ||
      nc.acao_definitiva_data_prevista,
    );
    const hasPreventiva = Boolean(
      nc.acao_preventiva_medidas ||
      nc.acao_preventiva_treinamento ||
      nc.acao_preventiva_revisao_procedimento ||
      nc.acao_preventiva_melhoria_processo ||
      nc.acao_preventiva_epc_epi,
    );

    const photosHtml =
      images.length > 0
        ? `
          <section class="pdf-section photo-section">
            <div class="section-title"><span class="bar"></span><h2>Fotos e evidências anexadas</h2></div>
            <div class="card photo-card">
              <div class="photo-grid">
                ${images
                  .map(
                    (img) => `
                  <figure class="photo-item photo-item--${esc(img.orientation)}">
                    <img src="${esc(img.dataUri)}" alt="${esc(img.label)}" />
                    <figcaption>${esc(img.label)}</figcaption>
                  </figure>
                `,
                  )
                  .join('')}
              </div>
            </div>
          </section>
        `
        : '';

    const unembeddedAttachmentsHtml =
      unembeddedAttachments.length > 0
        ? `
          <section class="pdf-section attachment-section">
            ${images.length === 0 ? '<div class="section-title"><span class="bar"></span><h2>Anexos referenciados</h2></div>' : ''}
            <div class="card attachment-card">
              <div class="card-title-strip">${images.length > 0 ? 'Outros anexos (não incorporados a este PDF)' : 'Anexos referenciados (não incorporados a este PDF)'}</div>
              <div class="card-body">
                <ul class="attachment-list">
                  ${unembeddedAttachments.map((item) => `<li>${esc(item)}</li>`).join('')}
                </ul>
              </div>
            </div>
          </section>
        `
        : '';

    const signRow = (role: string, name?: string | null) => `
      <div class="sign-row">
        <div class="role">${esc(role)}</div>
        <div class="name">${esc(this.textOr(name))}</div>
      </div>
    `;

    return `
      <!DOCTYPE html>
      <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <style>
            /* Reserva a área do rodapé também no layout CSS. Sem isso, páginas
               com cards longos invadem o footer do Chromium. */
            @page { size: A4; margin: 0 0 22mm; }
            * { box-sizing: border-box; }
            :root {
              --brand: #18517C;
              --brand-strong: #0F2036;
              --brand-on: #FFFFFF;
              --info: #1865B0;
              --ink: #111827;
              --text-secondary: #374151;
              --text-muted: #6B7280;
              --border: #D3DCE6;
              --border-strong: #8694A6;
              --surface: #FFFFFF;
              --surface-muted: #EEF3F8;
              --page-bg: #F6F8FB;
              --success: #1B5E3E;
            }
            body { margin: 0; background: var(--page-bg); color: var(--ink); font-family: Arial, Helvetica, sans-serif; font-size: 9.2pt; line-height: 1.45; }
            h1, h2, h3, p { margin: 0; }
            .page-content { padding: 0 16mm 5mm; }

            .header-band { background: var(--brand); padding: 6mm 16mm 5mm; display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 1.4mm solid var(--brand-strong); }
            .header-left { display: flex; align-items: flex-start; gap: 5mm; }
            .header-logo { max-width: 30mm; max-height: 16mm; object-fit: contain; background: #fff; border-radius: 1.5mm; padding: 1.5mm; }
            .header-title h1 { font-size: 15.2pt; color: var(--brand-on); font-weight: 700; letter-spacing: .01em; text-transform: uppercase; }
            .header-title p { font-size: 9pt; color: #DFE7EF; margin-top: 1.6mm; }
            .header-code-box { background: var(--surface); border: 0.35mm solid var(--border-strong); border-radius: 2.8mm; min-width: 46mm; overflow: hidden; }
            .header-code-label { background: var(--info); color: #fff; font-size: 7pt; font-weight: 700; text-align: center; padding: 1.3mm 2mm; letter-spacing: .04em; text-transform: uppercase; }
            .header-code-value { text-align: center; font-weight: 700; font-size: 9.5pt; color: var(--ink); padding: 2.2mm 3mm 1mm; }
            .header-code-status { text-align: center; font-size: 7pt; color: var(--text-secondary); padding: 0 3mm 2.2mm; }

            .meta-cards { display: flex; gap: 2.4mm; padding: 4mm 16mm 0; }
            .meta-card { flex: 1; background: var(--surface); border: 0.3mm solid var(--border); border-radius: 2.8mm; padding: 2.6mm 3.2mm 2.6mm 4.2mm; position: relative; overflow: hidden; }
            .meta-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2.2mm; background: var(--brand); }
            .meta-card .label { font-size: 7pt; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .03em; }
            .meta-card .value { font-size: 9.2pt; font-weight: 700; color: var(--ink); margin-top: 1mm; }

            .section-title { display: flex; align-items: center; gap: 2mm; margin: 7mm 0 3mm; break-inside: avoid-page; page-break-inside: avoid; break-after: avoid-page; page-break-after: avoid; }
            .section-title .bar { width: 2.4mm; height: 5.5mm; background: var(--brand); border-radius: 1mm; display: inline-block; }
            .section-title h2 { font-size: 9.5pt; font-weight: 700; color: var(--ink); text-transform: uppercase; letter-spacing: .02em; }

            .card { background: var(--surface); border: 0.3mm solid var(--border); border-radius: 2.8mm; position: relative; overflow: hidden; margin-bottom: 4mm; break-inside: avoid-page; page-break-inside: avoid; }
            .card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2.4mm; background: var(--brand); }
            .card-title-strip { background: var(--surface-muted); margin: 1.2mm 1.2mm 0; border-radius: 1.6mm 1.6mm 0 0; padding: 2mm 4mm 2mm 5.5mm; font-size: 9.5pt; font-weight: 700; color: var(--ink); }
            .card-body { padding: 3mm 4mm 3.5mm 5.5mm; }
            .card-body p { white-space: pre-wrap; font-size: 9.2pt; color: var(--ink); }

            .grid-2 { display: grid; grid-template-columns: 1fr 1fr; margin-left: 1.2mm; }
            .grid-field { padding: 2.6mm 3mm 2.6mm 4.3mm; border-top: 0.25mm solid var(--border); }
            .grid-field:nth-child(-n+2) { border-top: 0; }
            .grid-field:nth-child(odd) { border-right: 0.25mm solid var(--border); }
            .grid-field .label { font-size: 7pt; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .02em; }
            .grid-field .value { font-size: 9.2pt; color: var(--ink); margin-top: 0.8mm; }

            .pdf-section { break-inside: auto; page-break-inside: auto; }
            .photo-section, .attachment-section { break-before: auto; page-break-before: auto; }
            /* A grade de evidências pode continuar na página seguinte. Só cada
               foto individual é mantida inteira, evitando uma página em branco
               quando o conjunto completo não cabe no espaço restante. */
            .photo-card, .attachment-card { break-inside: auto; page-break-inside: auto; }
            .photo-card::before { display: none; }
            .photo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3mm; padding: 3mm 4mm 3.5mm; }
            .photo-item { margin: 0; min-width: 0; border: 0.3mm solid var(--border); border-radius: 2mm; padding: 1.5mm; background: #fff; break-inside: avoid-page; page-break-inside: avoid; }
            .photo-item img { width: 100%; height: 48mm; object-fit: contain; display: block; background: var(--surface-muted); border-radius: 1mm; }
            .photo-item--portrait { grid-column: span 2; }
            .photo-item--portrait img { height: 94mm; }
            .photo-item figcaption { font-size: 6.8pt; color: var(--text-muted); text-align: center; margin-top: 1mm; }

            .attachment-list { margin: 0; padding-left: 4mm; font-size: 8.8pt; color: var(--ink); }
            .attachment-list li { margin-bottom: 1.2mm; }

            .gov-card { background: var(--surface); border: 0.35mm solid var(--border-strong); border-radius: 2.8mm; position: relative; overflow: hidden; margin-top: 2mm; break-inside: avoid-page; page-break-inside: avoid; }
            .gov-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2.5mm; background: var(--brand); }
            .gov-body { display: flex; gap: 3mm; padding: 3mm 4mm 4mm 5.5mm; }
            .sign-panel { flex: 1; }
            .sign-panel-heading { font-size: 7pt; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .02em; margin-bottom: 1.7mm; }
            .sign-row { background: #fff; border: 0.25mm solid var(--border); border-radius: 1.6mm; padding: 2mm 3mm; margin-bottom: 2mm; }
            .sign-row .role { font-size: 7pt; font-weight: 700; color: var(--text-muted); text-transform: uppercase; }
            .sign-row .name { font-size: 8.8pt; font-weight: 700; color: var(--ink); margin-top: 0.6mm; }
            .auth-panel { width: 72mm; background: var(--surface-muted); border: 0.25mm solid var(--border); border-radius: 1.8mm; padding: 2.6mm 3mm; position: relative; }
            .auth-panel .heading { font-size: 7pt; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 1.8mm; }
            .auth-content { display: flex; gap: 2.2mm; align-items: flex-start; }
            .auth-qr { flex: 0 0 23mm; width: 23mm; height: 23mm; background: #fff; border: 0.25mm solid var(--border); border-radius: 1.2mm; padding: 1mm; }
            .auth-qr img { display: block; width: 100%; height: 100%; }
            .auth-copy { flex: 1; min-width: 0; }
            .auth-panel .code { font-size: 8.8pt; font-weight: 700; color: var(--ink); margin-top: 1mm; }
            .auth-panel .integrity, .auth-panel .validation-note { font-size: 6.8pt; color: var(--text-muted); margin-top: 1.5mm; overflow-wrap: anywhere; }
            .auth-panel .validation-link { display: block; font-size: 6.8pt; color: var(--info); font-weight: 700; margin-top: 1.5mm; text-decoration: none; }
            .auth-panel .validation-unavailable { font-size: 6.8pt; color: var(--text-secondary); margin-top: 1.8mm; }
            .badge-valid { display: inline-block; margin-top: 2.2mm; background: var(--success); color: #fff; font-size: 7pt; font-weight: 700; border-radius: 1.5mm; padding: 1mm 2.6mm; }
          </style>
        </head>
        <body>
          <div class="header-band">
            <div class="header-left">
              ${logoDataUri ? `<img class="header-logo" src="${esc(logoDataUri)}" alt="Logo da empresa" />` : ''}
              <div class="header-title">
                <h1>Relatório de Não Conformidade</h1>
                <p>Documento oficial de registro, tratativa e encerramento do desvio</p>
              </div>
            </div>
            <div class="header-code-box">
              <div class="header-code-label">Identificador</div>
              <div class="header-code-value">${esc(documentCode)}</div>
              <div class="header-code-status">Status: ${esc(statusLabel(nc.status))}</div>
            </div>
          </div>

            <div class="meta-cards">
            <div class="meta-card"><div class="label">Empresa</div><div class="value">${esc(this.textOr(nc.company?.razao_social))}</div></div>
            <div class="meta-card"><div class="label">Unidade</div><div class="value">${esc(this.textOr(nc.site?.nome))}</div></div>
            <div class="meta-card"><div class="label">Local/Setor</div><div class="value">${esc(this.textOr(nc.local_setor_area))}</div></div>
            <div class="meta-card"><div class="label">Data de identificação</div><div class="value">${esc(this.formatCivilDate(nc.data_identificacao))}</div></div>
          </div>

          <div class="page-content">
            <div class="section-title"><span class="bar"></span><h2>Identificação</h2></div>
            <div class="card">
              <div class="grid-2">
                ${gridField('Código', this.textOr(nc.codigo_nc))}
                ${gridField('Tipo', this.textOr(nc.tipo))}
                ${gridField('Atividade envolvida', this.textOr(nc.atividade_envolvida))}
                ${gridField('Responsável pela área', this.textOr(nc.responsavel_area))}
                ${gridField('Auditor/Técnico responsável', this.textOr(nc.auditor_responsavel))}
                ${gridField('Unidade/Site', this.textOr(nc.site?.nome))}
                ${nc.checklist ? gridField('Checklist de origem', this.textOr(nc.checklist.titulo)) : ''}
                ${gridField('Classificação', listOrDash(nc.classificacao))}
              </div>
            </div>

            <div class="section-title"><span class="bar"></span><h2>Descrição do desvio</h2></div>
            ${narrativeCard('Descrição', nc.descricao)}
            ${narrativeCard('Evidência observada', nc.evidencia_observada)}
            ${narrativeCard('Condição insegura', nc.condicao_insegura)}
            ${nc.ato_inseguro ? narrativeCard('Ato inseguro', nc.ato_inseguro) : ''}

            <div class="section-title"><span class="bar"></span><h2>Requisito e classificação de risco</h2></div>
            <div class="card">
              <div class="grid-2">
                ${gridField('Norma regulamentadora (NR)', this.textOr(nc.requisito_nr))}
                ${gridField('Item do requisito', this.textOr(nc.requisito_item))}
                ${gridField('Procedimento', this.textOr(nc.requisito_procedimento))}
                ${gridField('Política', this.textOr(nc.requisito_politica))}
                ${gridField('Perigo', this.textOr(nc.risco_perigo))}
                ${gridField('Risco associado', this.textOr(nc.risco_associado))}
                ${gridField('Consequências', listOrDash(nc.risco_consequencias))}
                ${gridField('Nível de risco', this.textOr(nc.risco_nivel))}
                ${gridField('Causa', listOrDash(nc.causa))}
                ${gridField('Causa (outro)', this.textOr(nc.causa_outro))}
              </div>
            </div>

            ${
              hasImediata || hasDefinitiva || hasPreventiva
                ? '<div class="section-title"><span class="bar"></span><h2>Plano de ação</h2></div>'
                : ''
            }
            ${
              hasImediata
                ? actionCard('Ação corretiva imediata', [
                    ['Medida adotada', this.textOr(nc.acao_imediata_descricao)],
                    ['Responsável', this.textOr(nc.acao_imediata_responsavel)],
                    [
                      'Data da ação',
                      this.formatCivilDate(nc.acao_imediata_data),
                    ],
                    [
                      'Status',
                      this.textOr(nc.acao_imediata_status, 'Pendente'),
                    ],
                  ])
                : ''
            }
            ${
              hasDefinitiva
                ? actionCard('Ação corretiva definitiva', [
                    [
                      'Descrição detalhada',
                      this.textOr(nc.acao_definitiva_descricao),
                    ],
                    [
                      'Responsável pela execução',
                      this.textOr(nc.acao_definitiva_responsavel),
                    ],
                    [
                      'Prazo para implementação',
                      this.formatCivilDate(nc.acao_definitiva_prazo),
                    ],
                    [
                      'Data prevista de conclusão',
                      this.formatCivilDate(nc.acao_definitiva_data_prevista),
                    ],
                    [
                      'Recursos necessários',
                      this.textOr(nc.acao_definitiva_recursos),
                    ],
                  ])
                : ''
            }
            ${
              hasPreventiva
                ? actionCard('Ação preventiva', [
                    [
                      'Medidas para evitar reincidência',
                      this.textOr(nc.acao_preventiva_medidas),
                    ],
                    [
                      'Treinamento necessário',
                      this.textOr(nc.acao_preventiva_treinamento),
                    ],
                    [
                      'Revisão de procedimento',
                      this.textOr(nc.acao_preventiva_revisao_procedimento),
                    ],
                    [
                      'Melhoria de processo',
                      this.textOr(nc.acao_preventiva_melhoria_processo),
                    ],
                    [
                      'Implementação de EPC/EPI',
                      this.textOr(nc.acao_preventiva_epc_epi),
                    ],
                  ])
                : ''
            }

            <div class="section-title"><span class="bar"></span><h2>Verificação e encerramento</h2></div>
            <div class="card">
              <div class="grid-2">
                ${gridField('Resultado da verificação', this.textOr(nc.verificacao_resultado))}
                ${gridField('Responsável pela verificação', this.textOr(nc.verificacao_responsavel))}
                ${gridField('Data da verificação', this.formatCivilDate(nc.verificacao_data))}
                ${gridField('Status atual', statusLabel(nc.status))}
                ${nc.closed_at ? gridField('Data de encerramento', this.formatOperationDate(nc.closed_at)) : ''}
                ${nc.resolved_by ? gridField('Usuário que encerrou', this.textOr(nc.resolved_by_user?.nome || nc.resolved_by)) : ''}
              </div>
            </div>
            ${nc.verificacao_evidencias ? narrativeCard('Evidências da verificação', nc.verificacao_evidencias) : ''}
            ${nc.observacoes_gerais ? narrativeCard('Observações gerais', nc.observacoes_gerais) : ''}

            ${photosHtml}
            ${unembeddedAttachmentsHtml}

            <div class="section-title"><span class="bar"></span><h2>Governança, autenticidade e rastreabilidade</h2></div>
            <div class="gov-card">
              <div class="gov-body">
                <div class="sign-panel">
                  <div class="sign-panel-heading">Responsáveis e confirmações registradas</div>
                  ${signRow('Responsável da área', nc.assinatura_responsavel_area || nc.responsavel_area)}
                  ${signRow('Técnico/Auditor', nc.assinatura_tecnico_auditor || nc.auditor_responsavel)}
                  ${signRow('Gestão', nc.assinatura_gestao)}
                </div>
                <div class="auth-panel">
                  <div class="heading">Autenticidade</div>
                  <div class="auth-content">
                    ${
                      authenticity.qrDataUri
                        ? `<div class="auth-qr"><img src="${esc(authenticity.qrDataUri)}" alt="QR Code para validação pública" /></div>`
                        : ''
                    }
                    <div class="auth-copy">
                      <div class="code">Código: ${esc(documentCode)}</div>
                      <div class="code">Verificação: ${esc(authenticity.verificationCode)}</div>
                      <div class="integrity">${esc(authenticity.integrityMessage)}</div>
                      <div class="validation-note">Emitido em ${esc(this.formatDisplayDateTime(authenticity.generatedAt))}</div>
                      ${
                        authenticity.url
                          ? `<a class="validation-link" href="${esc(authenticity.url)}">Validar no portal público</a>`
                          : '<div class="validation-unavailable">A validação pública não foi incorporada porque a origem segura do portal não está configurada.</div>'
                      }
                    </div>
                  </div>
                  <div class="badge-valid">Documento final</div>
                </div>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
  }
}
