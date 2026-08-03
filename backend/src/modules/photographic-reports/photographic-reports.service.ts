import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Repository, IsNull } from 'typeorm';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentRegistryService } from '../document-registry/document-registry.service';
import { PdfService } from '../../shared/services/pdf.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { FileInspectionService } from '../../shared/security/file-inspection.service';
import { AiAnalysisService } from '../ai/services/ai-analysis.service';
import {
  cleanupUploadedTempFile,
  createTemporaryUploadOptions,
  inspectUploadedFileBuffer,
  readUploadedFileBuffer,
  validateFileMagicBytes,
} from '../../shared/interceptors/file-upload.interceptor';
import {
  normalizeOffsetPagination,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { PhotographicReport } from './entities/photographic-report.entity';
import { PhotographicReportDay } from './entities/photographic-report-day.entity';
import { PhotographicReportImage } from './entities/photographic-report-image.entity';
import {
  PhotographicReportExport,
  PhotographicReportExportType,
} from './entities/photographic-report-export.entity';
import { CreatePhotographicReportDto } from './dto/create-photographic-report.dto';
import { CreatePhotographicReportDayDto } from './dto/create-photographic-report-day.dto';
import { UpdatePhotographicReportDayDto } from './dto/update-photographic-report-day.dto';
import { UpdatePhotographicReportDto } from './dto/update-photographic-report.dto';
import { UpdatePhotographicReportImageDto } from './dto/update-photographic-report-image.dto';
import { ReorderPhotographicReportImagesDto } from './dto/reorder-photographic-report-images.dto';
import { UploadPhotographicReportImagesDto } from './dto/upload-photographic-report-images.dto';
import {
  buildPhotographicReportHtml,
  type PhotographicReportRenderableImage,
} from './photographic-reports.renderer';
import { buildPhotographicReportWordBuffer } from './photographic-reports.word';
import {
  PhotographicReportDayResponse,
  PhotographicReportExportResponse,
  PhotographicReportImageResponse,
  PhotographicReportListItemResponse,
  PhotographicReportResponse,
} from './photographic-reports.types';
import {
  PhotographicReportAreaStatus,
  PhotographicReportShift,
  PhotographicReportStatus,
  PhotographicReportTone,
} from './entities/photographic-report.entity';
import { Company } from '../companies/entities/company.entity';
import { escapeLikePattern } from '../../shared/utils/sql.util';
import { MailService } from '../../infra/mail/mail.service';
import { DocumentMailDispatchResponseDto } from '../../infra/mail/dto/document-mail-dispatch-response.dto';
import { defaultJobOptions } from '../../infra/queue/default-job-options';

type PhotographicReportWithCounts = PhotographicReport & {
  dayCount?: number;
  imageCount?: number;
};

type PhotographicReportAnalysisResult = Awaited<
  ReturnType<AiAnalysisService['analyzePhotographicReportImage']>
>;

const DEFAULT_IMAGE_MAX_FILE_SIZE = 15 * 1024 * 1024;
const PDF_MIME_TYPE = 'application/pdf';
const WORD_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

@Injectable()
export class PhotographicReportsService {
  private readonly logger = new Logger(PhotographicReportsService.name);

  constructor(
    @InjectRepository(PhotographicReport)
    private readonly reportRepository: Repository<PhotographicReport>,
    @InjectRepository(PhotographicReportDay)
    private readonly dayRepository: Repository<PhotographicReportDay>,
    @InjectRepository(PhotographicReportImage)
    private readonly imageRepository: Repository<PhotographicReportImage>,
    @InjectRepository(PhotographicReportExport)
    private readonly exportRepository: Repository<PhotographicReportExport>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentRegistryService: DocumentRegistryService,
    private readonly pdfService: PdfService,
    private readonly aiAnalysisService: AiAnalysisService,
    private readonly fileInspectionService: FileInspectionService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @Inject(forwardRef(() => MailService))
    private readonly mailService: MailService,
    @InjectQueue('mail')
    private readonly mailQueue: Queue,
  ) {}

  createUploadOptions(maxFileSize = DEFAULT_IMAGE_MAX_FILE_SIZE) {
    return createTemporaryUploadOptions({ maxFileSize });
  }

  getImageUploadMaxSize(): number {
    return DEFAULT_IMAGE_MAX_FILE_SIZE;
  }

  private getCompanyIdOrThrow(): string {
    const companyId = this.tenantService.getTenantId();
    if (!companyId) {
      throw new BadRequestException(
        'Contexto de empresa não identificado. Faça login novamente.',
      );
    }
    return companyId;
  }

  private normalizeText(value?: string | null): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeSearchQuery(value: unknown): string | null {
    if (typeof value !== 'string') {
      if (value == null) {
        return null;
      }

      throw new BadRequestException('Parâmetro de busca inválido.');
    }

    return this.normalizeText(value);
  }

  private normalizeRequiredText(value: string, fieldLabel: string): string {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      throw new BadRequestException(
        `Campo obrigatório ausente: ${fieldLabel}.`,
      );
    }
    return normalized;
  }

  private normalizeStringArray(
    values?: Array<string | null | undefined> | null,
    maxItems = 8,
  ): string[] | null {
    const normalized = (values || [])
      .map((value) => this.normalizeText(value))
      .filter((value): value is string => Boolean(value))
      .slice(0, maxItems);

    return normalized.length > 0 ? normalized : null;
  }

  private normalizeDate(value?: string | null): string | null {
    const normalized = this.normalizeText(value);
    if (!normalized) return null;
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Data inválida.');
    }
    return parsed.toISOString().slice(0, 10);
  }

  private normalizeTime(value: string, fieldLabel: string): string {
    const normalized = String(value ?? '').trim();
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
      throw new BadRequestException(`Horário inválido em ${fieldLabel}.`);
    }
    return normalized.slice(0, 5);
  }

  private buildReportCode(
    report: Pick<PhotographicReport, 'id' | 'start_date'>,
  ): string {
    const year =
      this.normalizeDate(report.start_date)?.slice(0, 4) ||
      new Date().getFullYear().toString();
    return `RFP-${year}-${report.id.slice(0, 8).toUpperCase()}`;
  }

  private buildFileSlug(
    report: Pick<
      PhotographicReport,
      'client_name' | 'project_name' | 'activity_type'
    >,
  ): string {
    return [report.client_name, report.project_name, report.activity_type]
      .map((value) =>
        String(value || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9]+/g, '_')
          .replace(/^_+|_+$/g, ''),
      )
      .filter(Boolean)
      .join('_')
      .slice(0, 120);
  }

  private buildCoverHighlight(report: PhotographicReport): string {
    if (
      report.area_status === PhotographicReportAreaStatus.LOJA_FECHADA ||
      report.area_status === PhotographicReportAreaStatus.AREA_CONTROLADA ||
      report.shift === PhotographicReportShift.NOTURNO
    ) {
      return 'ATIVIDADE REGISTRADA COM CONTROLE OPERACIONAL, MENOR INTERFERÊNCIA EXTERNA E CONDIÇÕES FAVORÁVEIS PARA EXECUÇÃO SEGURA.';
    }

    return 'ATIVIDADE REGISTRADA COM ORGANIZAÇÃO OPERACIONAL, CONTROLE DA FRENTE DE SERVIÇO E BOAS CONDIÇÕES DE EXECUÇÃO.';
  }

  private compareDateStrings(
    left?: string | null,
    right?: string | null,
  ): number {
    return String(left || '').localeCompare(String(right || ''));
  }

  private async signUrl(storageKey?: string | null): Promise<string | null> {
    if (!storageKey) {
      return null;
    }
    try {
      return await this.documentStorageService.getSignedUrl(storageKey, 3600);
    } catch (error) {
      this.logger.warn(
        `Falha ao assinar URL de storage ${storageKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async fileBufferToDataUrl(
    storageKey?: string | null,
    mimeType = 'image/jpeg',
  ): Promise<string | null> {
    if (!storageKey) {
      return null;
    }
    try {
      const buffer =
        await this.documentStorageService.downloadFileBuffer(storageKey);
      return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (error) {
      this.logger.warn(
        `Falha ao carregar imagem ${storageKey} para renderização: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private guessImageMimeType(filename?: string | null): string {
    const ext = String(filename || '')
      .split('.')
      .pop()
      ?.toLowerCase();
    switch (ext) {
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      case 'gif':
        return 'image/gif';
      case 'jpg':
      case 'jpeg':
      default:
        return 'image/jpeg';
    }
  }

  private assertReportCompany(
    report: PhotographicReport,
    companyId: string,
  ): void {
    if (report.company_id !== companyId) {
      throw new NotFoundException('Relatório fotográfico não encontrado.');
    }
  }

  private async findReportEntity(
    id: string,
    companyId: string,
  ): Promise<PhotographicReport> {
    const report = await this.reportRepository.findOne({
      where: { id, company_id: companyId, deleted_at: IsNull() },
      relations: {
        days: true,
        images: { reportDay: true },
        exports: true,
      },
    });

    if (!report) {
      throw new NotFoundException('Relatório fotográfico não encontrado.');
    }

    return report;
  }

  private sortDays(days: PhotographicReportDay[]): PhotographicReportDay[] {
    return [...days].sort((left, right) =>
      this.compareDateStrings(left.activity_date, right.activity_date),
    );
  }

  private sortImages(
    images: PhotographicReportImage[],
  ): PhotographicReportImage[] {
    return [...images].sort(
      (left, right) => left.image_order - right.image_order,
    );
  }

  private async renumberImages(report: PhotographicReport): Promise<void> {
    const orderedImages = await this.imageRepository.find({
      where: {
        report_id: report.id,
        company_id: report.company_id,
        deleted_at: IsNull(),
      },
      order: {
        image_order: 'ASC',
        created_at: 'ASC',
      },
    });

    for (let index = 0; index < orderedImages.length; index += 1) {
      const image = orderedImages[index];
      if (!image) {
        continue;
      }
      image.image_order = index + 1;
    }
    await this.imageRepository.save(orderedImages);
  }

  private mapDayEntity(
    day: PhotographicReportDay,
    imageCount = 0,
  ): PhotographicReportDayResponse {
    return {
      id: day.id,
      report_id: day.report_id,
      activity_date: day.activity_date,
      day_summary: day.day_summary,
      created_at: day.created_at.toISOString(),
      updated_at: day.updated_at.toISOString(),
      image_count: imageCount,
    };
  }

  private async mapImageEntity(
    image: PhotographicReportImage,
    dayMap: Map<string, PhotographicReportDayResponse>,
  ): Promise<PhotographicReportImageResponse> {
    const downloadUrl = await this.signUrl(image.image_url);
    return {
      id: image.id,
      report_id: image.report_id,
      report_day_id: image.report_day_id,
      image_url: image.image_url,
      download_url: downloadUrl,
      image_order: image.image_order,
      manual_caption: image.manual_caption,
      ai_title: image.ai_title,
      ai_description: image.ai_description,
      ai_positive_points: image.ai_positive_points,
      ai_technical_assessment: image.ai_technical_assessment,
      ai_condition_classification: image.ai_condition_classification,
      ai_recommendations: image.ai_recommendations,
      created_at: image.created_at.toISOString(),
      updated_at: image.updated_at.toISOString(),
      day: image.report_day_id ? dayMap.get(image.report_day_id) || null : null,
    };
  }

  private async mapExportEntity(
    exportEntity: PhotographicReportExport,
  ): Promise<PhotographicReportExportResponse> {
    return {
      id: exportEntity.id,
      report_id: exportEntity.report_id,
      export_type: exportEntity.export_type,
      file_url: exportEntity.file_url,
      download_url: await this.signUrl(exportEntity.file_url),
      generated_by: exportEntity.generated_by,
      generated_at: exportEntity.generated_at.toISOString(),
    };
  }

  private async mapDetailedResponse(
    report: PhotographicReport,
  ): Promise<PhotographicReportResponse> {
    const sortedDays = this.sortDays(report.days || []);
    const sortedImages = this.sortImages(report.images || []);
    const dayImageCountMap = new Map<string, number>();
    for (const image of sortedImages) {
      if (!image.report_day_id) {
        continue;
      }
      const currentCount = dayImageCountMap.get(image.report_day_id) ?? 0;
      dayImageCountMap.set(image.report_day_id, currentCount + 1);
    }
    const mappedDays = sortedDays.map((day) => {
      const imageCount = dayImageCountMap.get(day.id) ?? 0;
      return this.mapDayEntity(day, imageCount);
    });
    const dayMap = new Map(mappedDays.map((day) => [day.id, day]));
    const mappedImages = await Promise.all(
      sortedImages.map((image) => this.mapImageEntity(image, dayMap)),
    );
    const mappedExports = await Promise.all(
      [...(report.exports || [])]
        .sort((left, right) =>
          this.compareDateStrings(
            left.generated_at.toISOString(),
            right.generated_at.toISOString(),
          ),
        )
        .map((entry) => this.mapExportEntity(entry)),
    );

    return {
      id: report.id,
      company_id: report.company_id,
      client_id: report.client_id,
      project_id: report.project_id,
      client_name: report.client_name,
      project_name: report.project_name,
      unit_name: report.unit_name,
      location: report.location,
      activity_type: report.activity_type,
      report_tone: report.report_tone,
      area_status: report.area_status,
      shift: report.shift,
      start_date: report.start_date,
      end_date: report.end_date,
      start_time: report.start_time,
      end_time: report.end_time,
      responsible_name: report.responsible_name,
      contractor_company: report.contractor_company,
      general_observations: report.general_observations,
      ai_summary: report.ai_summary,
      final_conclusion: report.final_conclusion,
      status: report.status,
      created_by: report.created_by,
      created_at: report.created_at.toISOString(),
      updated_at: report.updated_at.toISOString(),
      day_count: mappedDays.length,
      image_count: mappedImages.length,
      export_count: mappedExports.length,
      last_exported_at:
        mappedExports.length > 0
          ? mappedExports[mappedExports.length - 1]?.generated_at || null
          : null,
      days: mappedDays,
      images: mappedImages,
      exports: mappedExports,
    };
  }

  private mapListItem(
    report: PhotographicReportWithCounts,
  ): PhotographicReportListItemResponse {
    const exports = [...(report.exports || [])].sort((left, right) =>
      this.compareDateStrings(
        left.generated_at.toISOString(),
        right.generated_at.toISOString(),
      ),
    );

    return {
      id: report.id,
      company_id: report.company_id,
      client_id: report.client_id,
      project_id: report.project_id,
      client_name: report.client_name,
      project_name: report.project_name,
      unit_name: report.unit_name,
      location: report.location,
      activity_type: report.activity_type,
      report_tone: report.report_tone,
      area_status: report.area_status,
      shift: report.shift,
      start_date: report.start_date,
      end_date: report.end_date,
      start_time: report.start_time,
      end_time: report.end_time,
      responsible_name: report.responsible_name,
      contractor_company: report.contractor_company,
      general_observations: report.general_observations,
      ai_summary: report.ai_summary,
      final_conclusion: report.final_conclusion,
      status: report.status,
      created_by: report.created_by,
      created_at: report.created_at.toISOString(),
      updated_at: report.updated_at.toISOString(),
      day_count: Number(report.dayCount ?? 0),
      image_count: Number(report.imageCount ?? 0),
      export_count: exports.length,
      last_exported_at: exports.at(-1)?.generated_at.toISOString() || null,
    };
  }

  private markEditingIfNeeded(
    report: PhotographicReport,
    nextStatus: PhotographicReportStatus,
  ): void {
    if (
      report.status === PhotographicReportStatus.FINALIZADO ||
      report.status === PhotographicReportStatus.EXPORTADO
    ) {
      report.status = PhotographicReportStatus.EM_EDICAO;
      return;
    }

    report.status = nextStatus;
  }

  private async ensureDayBelongsToReport(
    report: PhotographicReport,
    dayId: string,
  ): Promise<PhotographicReportDay> {
    const day = await this.dayRepository.findOne({
      where: {
        id: dayId,
        report_id: report.id,
        company_id: report.company_id,
        deleted_at: IsNull(),
      },
    });

    if (!day) {
      throw new BadRequestException(
        'A data informada não pertence ao relatório.',
      );
    }

    return day;
  }

  private async ensureImageBelongsToReport(
    report: PhotographicReport,
    imageId: string,
  ): Promise<PhotographicReportImage> {
    const image = await this.imageRepository.findOne({
      where: {
        id: imageId,
        report_id: report.id,
        company_id: report.company_id,
        deleted_at: IsNull(),
      },
      relations: { reportDay: true },
    });

    if (!image) {
      throw new NotFoundException('Foto não encontrada no relatório.');
    }

    return image;
  }

  private async ensureExportBelongsToReport(
    report: PhotographicReport,
    exportId: string,
  ): Promise<PhotographicReportExport> {
    const exportEntity = await this.exportRepository.findOne({
      where: {
        id: exportId,
        report_id: report.id,
        company_id: report.company_id,
        deleted_at: IsNull(),
      },
    });

    if (!exportEntity) {
      throw new NotFoundException('Exportação não encontrada.');
    }

    return exportEntity;
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
    status?: PhotographicReportStatus;
  }) {
    const companyId = this.getCompanyIdOrThrow();
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 12,
      maxLimit: 50,
    });

    const query = this.reportRepository
      .createQueryBuilder('report')
      .leftJoinAndSelect('report.exports', 'report_export')
      .where('report.company_id = :companyId', { companyId })
      .andWhere('report.deleted_at IS NULL')
      .orderBy('report.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .loadRelationCountAndMap('report.dayCount', 'report.days')
      .loadRelationCountAndMap('report.imageCount', 'report.images');

    if (opts?.status) {
      query.andWhere('report.status = :status', { status: opts.status });
    }

    const searchTerm = this.normalizeSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      query.andWhere(
        `(
          LOWER(report.client_name) LIKE :search ESCAPE '\\' OR
          LOWER(report.project_name) LIKE :search ESCAPE '\\' OR
          LOWER(COALESCE(report.unit_name, '')) LIKE :search ESCAPE '\\' OR
          LOWER(COALESCE(report.location, '')) LIKE :search ESCAPE '\\' OR
          LOWER(report.activity_type) LIKE :search ESCAPE '\\' OR
          LOWER(report.responsible_name) LIKE :search ESCAPE '\\' OR
          LOWER(report.contractor_company) LIKE :search ESCAPE '\\'
        )`,
        { search },
      );
    }

    const [items, total] = await query.getManyAndCount();
    const data = items.map((item) => this.mapListItem(item));
    return toOffsetPage(data, total, page, limit);
  }

  async findAll(): Promise<PhotographicReportListItemResponse[]> {
    const page = await this.findPaginated({ page: 1, limit: 100 });
    return page.data;
  }

  async findOne(id: string): Promise<PhotographicReportResponse> {
    const report = await this.findReportEntity(id, this.getCompanyIdOrThrow());
    return this.mapDetailedResponse(report);
  }

  async create(
    dto: CreatePhotographicReportDto,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const startDate = this.normalizeDate(dto.start_date);
    const endDate = this.normalizeDate(dto.end_date || null);

    if (startDate && endDate && endDate < startDate) {
      throw new BadRequestException(
        'A data final não pode ser anterior à data inicial.',
      );
    }

    const report = this.reportRepository.create({
      company_id: companyId,
      client_id: this.normalizeText(dto.client_id),
      project_id: this.normalizeText(dto.project_id),
      client_name: this.normalizeRequiredText(dto.client_name, 'Cliente'),
      project_name: this.normalizeRequiredText(dto.project_name, 'Obra'),
      unit_name: this.normalizeText(dto.unit_name),
      location: this.normalizeText(dto.location),
      activity_type: this.normalizeRequiredText(
        dto.activity_type,
        'Tipo de atividade',
      ),
      report_tone: dto.report_tone || PhotographicReportTone.POSITIVO,
      area_status: dto.area_status || PhotographicReportAreaStatus.LOJA_ABERTA,
      shift: dto.shift || PhotographicReportShift.DIURNO,
      start_date: startDate || dto.start_date,
      end_date: endDate,
      start_time: this.normalizeTime(dto.start_time, 'Horário de início'),
      end_time: this.normalizeTime(dto.end_time, 'Horário de término'),
      responsible_name: this.normalizeRequiredText(
        dto.responsible_name,
        'Responsável pelo relatório',
      ),
      contractor_company: this.normalizeRequiredText(
        dto.contractor_company,
        'Empresa executora',
      ),
      general_observations: this.normalizeText(dto.general_observations),
      ai_summary: null,
      final_conclusion: null,
      status: PhotographicReportStatus.RASCUNHO,
      created_by: RequestContext.getUserId() || null,
    });

    const saved = await this.reportRepository.save(report);

    await this.dayRepository.save(
      this.dayRepository.create({
        company_id: companyId,
        report_id: saved.id,
        activity_date: saved.start_date,
        day_summary: null,
      }),
    );

    return this.findOne(saved.id);
  }

  async update(
    id: string,
    dto: UpdatePhotographicReportDto,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(id, companyId);

    let hasMutations = false;

    if (dto.client_id !== undefined) {
      report.client_id = this.normalizeText(dto.client_id);
      hasMutations = true;
    }
    if (dto.project_id !== undefined) {
      report.project_id = this.normalizeText(dto.project_id);
      hasMutations = true;
    }
    if (dto.client_name !== undefined) {
      report.client_name = this.normalizeRequiredText(
        dto.client_name,
        'Cliente',
      );
      hasMutations = true;
    }
    if (dto.project_name !== undefined) {
      report.project_name = this.normalizeRequiredText(
        dto.project_name,
        'Obra',
      );
      hasMutations = true;
    }
    if (dto.unit_name !== undefined) {
      report.unit_name = this.normalizeText(dto.unit_name);
      hasMutations = true;
    }
    if (dto.location !== undefined) {
      report.location = this.normalizeText(dto.location);
      hasMutations = true;
    }
    if (dto.activity_type !== undefined) {
      report.activity_type = this.normalizeRequiredText(
        dto.activity_type,
        'Tipo de atividade',
      );
      hasMutations = true;
    }
    if (dto.report_tone !== undefined) {
      report.report_tone = dto.report_tone;
      hasMutations = true;
    }
    if (dto.area_status !== undefined) {
      report.area_status = dto.area_status;
      hasMutations = true;
    }
    if (dto.shift !== undefined) {
      report.shift = dto.shift;
      hasMutations = true;
    }
    if (dto.start_date !== undefined) {
      report.start_date =
        this.normalizeDate(dto.start_date) || report.start_date;
      hasMutations = true;
    }
    if (dto.end_date !== undefined) {
      report.end_date = this.normalizeDate(dto.end_date);
      hasMutations = true;
    }
    if (dto.start_time !== undefined) {
      report.start_time = this.normalizeTime(
        dto.start_time,
        'Horário de início',
      );
      hasMutations = true;
    }
    if (dto.end_time !== undefined) {
      report.end_time = this.normalizeTime(dto.end_time, 'Horário de término');
      hasMutations = true;
    }
    if (dto.responsible_name !== undefined) {
      report.responsible_name = this.normalizeRequiredText(
        dto.responsible_name,
        'Responsável pelo relatório',
      );
      hasMutations = true;
    }
    if (dto.contractor_company !== undefined) {
      report.contractor_company = this.normalizeRequiredText(
        dto.contractor_company,
        'Empresa executora',
      );
      hasMutations = true;
    }
    if (dto.general_observations !== undefined) {
      report.general_observations = this.normalizeText(
        dto.general_observations,
      );
      hasMutations = true;
    }
    if (dto.ai_summary !== undefined) {
      report.ai_summary = this.normalizeText(dto.ai_summary);
      hasMutations = true;
    }
    if (dto.final_conclusion !== undefined) {
      report.final_conclusion = this.normalizeText(dto.final_conclusion);
      hasMutations = true;
    }
    if (dto.status !== undefined && dto.status !== report.status) {
      throw new BadRequestException(
        'A transição de status deve ocorrer pelos fluxos dedicados (análise, finalização ou exportação).',
      );
    }

    if (hasMutations) {
      this.markEditingIfNeeded(report, report.status);
    }

    await this.reportRepository.save(report);
    return this.findOne(report.id);
  }

  async saveDraft(
    id: string,
    dto: UpdatePhotographicReportDto,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(id, companyId);
    Object.assign(report, {
      ...report,
      ...dto,
      status: PhotographicReportStatus.RASCUNHO,
      client_id:
        dto.client_id !== undefined
          ? this.normalizeText(dto.client_id)
          : report.client_id,
      project_id:
        dto.project_id !== undefined
          ? this.normalizeText(dto.project_id)
          : report.project_id,
      client_name:
        dto.client_name !== undefined
          ? this.normalizeRequiredText(dto.client_name, 'Cliente')
          : report.client_name,
      project_name:
        dto.project_name !== undefined
          ? this.normalizeRequiredText(dto.project_name, 'Obra')
          : report.project_name,
      unit_name:
        dto.unit_name !== undefined
          ? this.normalizeText(dto.unit_name)
          : report.unit_name,
      location:
        dto.location !== undefined
          ? this.normalizeText(dto.location)
          : report.location,
      activity_type:
        dto.activity_type !== undefined
          ? this.normalizeRequiredText(dto.activity_type, 'Tipo de atividade')
          : report.activity_type,
      report_tone: dto.report_tone ?? report.report_tone,
      area_status: dto.area_status ?? report.area_status,
      shift: dto.shift ?? report.shift,
      start_date:
        dto.start_date !== undefined
          ? this.normalizeDate(dto.start_date) || report.start_date
          : report.start_date,
      end_date:
        dto.end_date !== undefined
          ? this.normalizeDate(dto.end_date)
          : report.end_date,
      start_time:
        dto.start_time !== undefined
          ? this.normalizeTime(dto.start_time, 'Horário de início')
          : report.start_time,
      end_time:
        dto.end_time !== undefined
          ? this.normalizeTime(dto.end_time, 'Horário de término')
          : report.end_time,
      responsible_name:
        dto.responsible_name !== undefined
          ? this.normalizeRequiredText(
              dto.responsible_name,
              'Responsável pelo relatório',
            )
          : report.responsible_name,
      contractor_company:
        dto.contractor_company !== undefined
          ? this.normalizeRequiredText(
              dto.contractor_company,
              'Empresa executora',
            )
          : report.contractor_company,
      general_observations:
        dto.general_observations !== undefined
          ? this.normalizeText(dto.general_observations)
          : report.general_observations,
      ai_summary:
        dto.ai_summary !== undefined
          ? this.normalizeText(dto.ai_summary)
          : report.ai_summary,
      final_conclusion:
        dto.final_conclusion !== undefined
          ? this.normalizeText(dto.final_conclusion)
          : report.final_conclusion,
    });
    await this.reportRepository.save(report);
    return this.findOne(report.id);
  }

  async remove(id: string): Promise<void> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(id, companyId);

    if (
      report.status === PhotographicReportStatus.FINALIZADO ||
      report.status === PhotographicReportStatus.EXPORTADO ||
      (report.exports || []).length > 0
    ) {
      throw new BadRequestException(
        'Somente relatórios fotográficos sem exportação final podem ser removidos. Use os fluxos formais de cancelamento para registros já finalizados/exportados.',
      );
    }

    const exportKeys = Array.from(
      new Set(
        (report.exports || []).map((entry) => entry.file_url).filter(Boolean),
      ),
    );
    const imageKeys = Array.from(
      new Set(
        (report.images || []).map((entry) => entry.image_url).filter(Boolean),
      ),
    );

    for (const fileKey of imageKeys) {
      try {
        await this.documentStorageService.deleteFile(fileKey);
      } catch (error) {
        this.logger.warn(
          `Falha ao limpar imagem do relatório ${report.id} (${fileKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    for (const fileKey of exportKeys) {
      try {
        await this.documentStorageService.deleteFile(fileKey);
      } catch (error) {
        this.logger.warn(
          `Falha ao limpar arquivo do relatório ${report.id} (${fileKey}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.documentGovernanceService.removeFinalDocumentReference({
      companyId: report.company_id,
      module: 'photographic_report',
      entityId: report.id,
      documentType: 'pdf',
      cleanupStoredFile: () => Promise.resolve(undefined),
    });

    await this.reportRepository.softDelete(report.id);
  }

  async createDay(
    reportId: string,
    dto: CreatePhotographicReportDayDto,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const activityDate = this.normalizeDate(dto.activity_date);
    if (!activityDate) {
      throw new BadRequestException('Data da atividade obrigatória.');
    }

    const existingDay = (report.days || []).find(
      (day) => day.activity_date === activityDate,
    );
    if (existingDay) {
      existingDay.day_summary =
        dto.day_summary !== undefined
          ? this.normalizeText(dto.day_summary)
          : existingDay.day_summary;
      this.markEditingIfNeeded(report, PhotographicReportStatus.EM_EDICAO);
      await this.dayRepository.save(existingDay);
      await this.reportRepository.save(report);
      return this.findOne(report.id);
    }

    this.markEditingIfNeeded(report, PhotographicReportStatus.AGUARDANDO_FOTOS);
    await this.reportRepository.save(report);

    await this.dayRepository.save(
      this.dayRepository.create({
        company_id: companyId,
        report_id: report.id,
        activity_date: activityDate,
        day_summary: this.normalizeText(dto.day_summary),
      }),
    );

    return this.findOne(report.id);
  }

  async updateDay(
    reportId: string,
    dayId: string,
    dto: UpdatePhotographicReportDayDto,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const day = await this.ensureDayBelongsToReport(report, dayId);

    if (dto.activity_date !== undefined) {
      const nextDate =
        this.normalizeDate(dto.activity_date) || day.activity_date;
      const duplicate = (report.days || []).find(
        (item) => item.id !== day.id && item.activity_date === nextDate,
      );
      if (duplicate) {
        throw new BadRequestException(
          'Já existe uma data cadastrada para essa mesma atividade.',
        );
      }
      day.activity_date = nextDate;
    }
    if (dto.day_summary !== undefined) {
      day.day_summary = this.normalizeText(dto.day_summary);
    }

    this.markEditingIfNeeded(report, PhotographicReportStatus.EM_EDICAO);
    await this.dayRepository.save(day);
    await this.reportRepository.save(report);
    return this.findOne(report.id);
  }

  async removeDay(
    reportId: string,
    dayId: string,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    await this.ensureDayBelongsToReport(report, dayId);
    await this.dayRepository.delete({
      id: dayId,
      report_id: report.id,
      company_id: companyId,
    });
    this.markEditingIfNeeded(report, PhotographicReportStatus.EM_EDICAO);
    await this.reportRepository.save(report);
    return this.findOne(report.id);
  }

  async uploadImages(
    reportId: string,
    files: Express.Multer.File[],
    dto: UploadPhotographicReportImagesDto,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    if (!Array.isArray(files) || !files.length) {
      throw new BadRequestException('Nenhuma foto enviada.');
    }

    let targetDay: PhotographicReportDay | null = null;
    if (dto.report_day_id) {
      targetDay = await this.ensureDayBelongsToReport(
        report,
        dto.report_day_id,
      );
    } else if (dto.activity_date) {
      const normalizedDate = this.normalizeDate(dto.activity_date);
      if (normalizedDate) {
        targetDay =
          (report.days || []).find(
            (day) => day.activity_date === normalizedDate,
          ) ||
          (await this.dayRepository.save(
            this.dayRepository.create({
              company_id: companyId,
              report_id: report.id,
              activity_date: normalizedDate,
              day_summary: null,
            }),
          ));
      }
    }

    const startingOrder =
      Math.max(...(report.images || []).map((image) => image.image_order), 0) ||
      0;
    const createdImages: PhotographicReportImage[] = [];

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file || typeof file !== 'object' || Array.isArray(file)) {
          throw new BadRequestException('Arquivo de foto inválido.');
        }
        const buffer = await readUploadedFileBuffer(
          file,
          'Nenhuma foto enviada.',
        );
        validateFileMagicBytes(buffer, [
          'image/jpeg',
          'image/png',
          'image/webp',
        ]);
        await inspectUploadedFileBuffer(
          buffer,
          file,
          this.fileInspectionService,
        );

        const storageKey = this.documentStorageService.generateDocumentKey(
          companyId,
          'photographic-report',
          report.id,
          file.originalname || `foto-${index + 1}.jpg`,
          {
            folderSegments: [
              'images',
              targetDay?.activity_date ||
                this.normalizeDate(dto.activity_date) ||
                report.start_date,
            ],
          },
        );

        await this.documentStorageService.uploadFile(
          storageKey,
          buffer,
          file.mimetype,
        );
        createdImages.push(
          this.imageRepository.create({
            company_id: companyId,
            report_id: report.id,
            report_day_id: targetDay?.id || null,
            image_url: storageKey,
            image_order: startingOrder + index + 1,
            manual_caption: this.normalizeText(dto.manual_caption) || null,
            ai_title: null,
            ai_description: null,
            ai_positive_points: null,
            ai_technical_assessment: null,
            ai_condition_classification: null,
            ai_recommendations: null,
          }),
        );
      }

      await this.imageRepository.save(createdImages);
      this.markEditingIfNeeded(
        report,
        PhotographicReportStatus.AGUARDANDO_ANALISE,
      );
      await this.reportRepository.save(report);
      return this.findOne(report.id);
    } catch (error) {
      for (const image of createdImages) {
        try {
          await this.documentStorageService.deleteFile(image.image_url);
        } catch {
          /* best effort cleanup */
        }
      }
      throw error;
    } finally {
      for (const file of files) {
        await cleanupUploadedTempFile(file).catch(() => undefined);
      }
    }
  }

  async updateImage(
    reportId: string,
    imageId: string,
    dto: UpdatePhotographicReportImageDto,
  ): Promise<PhotographicReportImageResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const image = await this.ensureImageBelongsToReport(report, imageId);

    if (dto.report_day_id !== undefined) {
      image.report_day_id = dto.report_day_id
        ? (await this.ensureDayBelongsToReport(report, dto.report_day_id)).id
        : null;
    }
    if (dto.manual_caption !== undefined) {
      image.manual_caption = this.normalizeText(dto.manual_caption);
    }
    if (dto.image_order !== undefined) {
      image.image_order = dto.image_order;
    }
    if (dto.ai_title !== undefined) {
      image.ai_title = this.normalizeText(dto.ai_title);
    }
    if (dto.ai_description !== undefined) {
      image.ai_description = this.normalizeText(dto.ai_description);
    }
    if (dto.ai_positive_points !== undefined) {
      image.ai_positive_points = this.normalizeStringArray(
        dto.ai_positive_points,
        8,
      );
    }
    if (dto.ai_technical_assessment !== undefined) {
      image.ai_technical_assessment = this.normalizeText(
        dto.ai_technical_assessment,
      );
    }
    if (dto.ai_condition_classification !== undefined) {
      image.ai_condition_classification = this.normalizeText(
        dto.ai_condition_classification,
      );
    }
    if (dto.ai_recommendations !== undefined) {
      image.ai_recommendations = this.normalizeStringArray(
        dto.ai_recommendations,
        5,
      );
    }

    this.markEditingIfNeeded(report, PhotographicReportStatus.EM_EDICAO);
    await this.imageRepository.save(image);
    await this.reportRepository.save(report);
    const mapped = await this.mapImageEntity(
      image,
      new Map(
        (report.days || []).map((day) => [
          day.id,
          {
            id: day.id,
            report_id: day.report_id,
            activity_date: day.activity_date,
            day_summary: day.day_summary,
            created_at: day.created_at.toISOString(),
            updated_at: day.updated_at.toISOString(),
            image_count: (report.images || []).filter(
              (item) => item.report_day_id === day.id,
            ).length,
          } satisfies PhotographicReportDayResponse,
        ]),
      ),
    );
    return mapped;
  }

  async removeImage(
    reportId: string,
    imageId: string,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const image = await this.ensureImageBelongsToReport(report, imageId);

    try {
      await this.documentStorageService.deleteFile(image.image_url);
    } catch (error) {
      this.logger.warn(
        `Falha ao remover imagem do storage (${image.image_url}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.imageRepository.delete({ id: image.id });
    await this.renumberImages(report);
    this.markEditingIfNeeded(report, PhotographicReportStatus.EM_EDICAO);
    await this.reportRepository.save(report);
    return this.findOne(report.id);
  }

  async reorderImages(
    reportId: string,
    dto: ReorderPhotographicReportImagesDto,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const images = this.sortImages(report.images || []);

    if (dto.imageIds.length !== images.length) {
      throw new BadRequestException(
        'A ordem enviada deve conter exatamente todas as fotos do relatório.',
      );
    }

    const imageMap = new Map(images.map((image) => [image.id, image]));
    dto.imageIds.forEach((imageId, index) => {
      const image = imageMap.get(imageId);
      if (!image) {
        throw new BadRequestException('A ordem enviada contém foto inválida.');
      }
      image.image_order = index + 1;
    });

    this.markEditingIfNeeded(report, PhotographicReportStatus.EM_EDICAO);
    await this.imageRepository.save([...imageMap.values()]);
    await this.reportRepository.save(report);
    return this.findOne(report.id);
  }

  private buildImageAnalysisContext(
    report: PhotographicReport,
    image: PhotographicReportImage,
    day?: PhotographicReportDay | null,
  ): string {
    return JSON.stringify(
      {
        client_name: report.client_name,
        project_name: report.project_name,
        unit_name: report.unit_name,
        location: report.location,
        activity_type: report.activity_type,
        report_tone: report.report_tone,
        area_status: report.area_status,
        shift: report.shift,
        start_date: report.start_date,
        end_date: report.end_date,
        manual_caption: image.manual_caption,
        activity_date: day?.activity_date || null,
        day_summary: day?.day_summary || null,
        general_observations: report.general_observations,
      },
      null,
      2,
    );
  }

  private applyImageAnalysis(
    image: PhotographicReportImage,
    analysis: PhotographicReportAnalysisResult,
  ): void {
    image.ai_title = analysis.title;
    image.ai_description = analysis.description;
    image.ai_positive_points = analysis.positivePoints;
    image.ai_technical_assessment = analysis.technicalAssessment;
    image.ai_condition_classification = analysis.conditionClassification;
    image.ai_recommendations = analysis.preventiveRecommendation
      ? [analysis.preventiveRecommendation]
      : [];
  }

  async analyzeImage(
    reportId: string,
    imageId: string,
  ): Promise<PhotographicReportImageResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const image = await this.ensureImageBelongsToReport(report, imageId);
    const day = image.report_day_id
      ? (report.days || []).find((item) => item.id === image.report_day_id) ||
        null
      : null;

    const buffer = await this.documentStorageService.downloadFileBuffer(
      image.image_url,
    );
    const analysis =
      await this.aiAnalysisService.analyzePhotographicReportImage(
        buffer,
        this.buildImageAnalysisContext(report, image, day),
        companyId,
      );

    this.applyImageAnalysis(image, analysis);
    await this.imageRepository.save(image);
    this.markEditingIfNeeded(report, PhotographicReportStatus.ANALISADO);
    await this.reportRepository.save(report);

    return this.mapImageEntity(
      image,
      new Map(
        report.days?.map((dayItem) => [
          dayItem.id,
          {
            id: dayItem.id,
            report_id: dayItem.report_id,
            activity_date: dayItem.activity_date,
            day_summary: dayItem.day_summary,
            created_at: dayItem.created_at.toISOString(),
            updated_at: dayItem.updated_at.toISOString(),
          } satisfies PhotographicReportDayResponse,
        ]) || [],
      ),
    );
  }

  async analyzeAllImages(
    reportId: string,
  ): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const sortedImages = this.sortImages(report.images || []);
    if (sortedImages.length === 0) {
      throw new BadRequestException('Relatório sem fotos.');
    }

    for (const image of sortedImages) {
      const day = image.report_day_id
        ? (report.days || []).find((item) => item.id === image.report_day_id) ||
          null
        : null;
      const buffer = await this.documentStorageService.downloadFileBuffer(
        image.image_url,
      );
      const analysis =
        await this.aiAnalysisService.analyzePhotographicReportImage(
          buffer,
          this.buildImageAnalysisContext(report, image, day),
          companyId,
        );
      this.applyImageAnalysis(image, analysis);
      await this.imageRepository.save(image);
    }

    const summary = await this.aiAnalysisService.summarizePhotographicReport({
      context: JSON.stringify(
        {
          client_name: report.client_name,
          project_name: report.project_name,
          unit_name: report.unit_name,
          location: report.location,
          activity_type: report.activity_type,
          report_tone: report.report_tone,
          area_status: report.area_status,
          shift: report.shift,
          general_observations: report.general_observations,
          days: (report.days || []).map((day) => ({
            activity_date: day.activity_date,
            day_summary: day.day_summary,
          })),
          images: sortedImages.map((image) => ({
            order: image.image_order,
            title: image.ai_title,
            description: image.ai_description,
            positivePoints: image.ai_positive_points,
            technicalAssessment: image.ai_technical_assessment,
            classification: image.ai_condition_classification,
          })),
        },
        null,
        2,
      ),
      tenantId: companyId,
    });

    report.ai_summary = summary.summary;
    report.final_conclusion = summary.finalConclusion;
    this.markEditingIfNeeded(report, PhotographicReportStatus.ANALISADO);
    await this.reportRepository.save(report);
    return this.findOne(report.id);
  }

  async generateReportSummary(
    reportId: string,
  ): Promise<PhotographicReportResponse> {
    return this.analyzeAllImages(reportId);
  }

  async finalize(reportId: string): Promise<PhotographicReportResponse> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    if ((report.images || []).length === 0) {
      throw new BadRequestException('Relatório sem fotos.');
    }

    const analyzed = await this.analyzeAllImages(reportId);
    const persisted = await this.findReportEntity(analyzed.id, companyId);
    persisted.status = PhotographicReportStatus.FINALIZADO;
    await this.reportRepository.save(persisted);
    return this.findOne(persisted.id);
  }

  private async resolveCompanyLogoDataUrl(
    companyId: string,
  ): Promise<string | null> {
    try {
      const company = await this.companyRepository.findOne({
        where: { id: companyId },
        select: ['id', 'logo_storage_key', 'logo_content_type'],
      });
      if (!company?.logo_storage_key) return null;
      const buf = await this.documentStorageService.downloadFileBuffer(
        company.logo_storage_key,
      );
      const mime = company.logo_content_type ?? 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (error) {
      this.logger.warn(
        `Logo da empresa ${companyId} indisponível durante geração de PDF: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async buildPdfBuffer(
    report: PhotographicReportResponse,
  ): Promise<Buffer> {
    const renderableImages: PhotographicReportRenderableImage[] = [];
    for (const image of report.images) {
      renderableImages.push({
        ...image,
        data_url: await this.fileBufferToDataUrl(
          image.image_url,
          this.guessImageMimeType(image.image_url),
        ),
        activity_date_label: image.day?.activity_date || report.start_date,
      });
    }

    const logoDataUrl = await this.resolveCompanyLogoDataUrl(report.company_id);
    const html = buildPhotographicReportHtml(report, {
      companyName: report.client_name,
      generatedAt: new Date().toISOString(),
      renderableImages,
      logoDataUrl,
    });

    return this.pdfService.generateFromHtml(html, {
      preferCssPageSize: true,
      displayHeaderFooter: true,
      footerTemplate: `
        <div style="width:100%;font-size:8px;color:#6a7e91;padding:0 14mm;box-sizing:border-box;font-family:Arial,sans-serif;">
          <div style="border-top:1px solid #dbe3ea;padding-top:4px;display:flex;justify-content:space-between;align-items:center;width:100%;">
            <span>SGS · Relatório Fotográfico</span>
            <span>Pág. <span class="pageNumber"></span> de <span class="totalPages"></span></span>
          </div>
        </div>
      `,
      margin: {
        top: '10mm',
        right: '10mm',
        bottom: '18mm',
        left: '10mm',
      },
    });
  }

  private async buildWordBuffer(
    report: PhotographicReportResponse,
  ): Promise<Buffer> {
    const renderableImages: PhotographicReportRenderableImage[] = [];
    for (const image of report.images) {
      renderableImages.push({
        ...image,
        data_url: await this.fileBufferToDataUrl(
          image.image_url,
          this.guessImageMimeType(image.image_url),
        ),
        activity_date_label: image.day?.activity_date || report.start_date,
      });
    }

    return buildPhotographicReportWordBuffer(report, {
      companyName: report.client_name,
      generatedAt: new Date().toISOString(),
      renderableImages,
    });
  }

  private async persistExportRecord(params: {
    report: PhotographicReport;
    fileKey: string;
    exportType: PhotographicReportExportType;
    originalName: string;
    mimeType: string;
    fileBuffer: Buffer;
  }): Promise<PhotographicReportExport> {
    const generatedBy = RequestContext.getUserId() || null;

    if (params.exportType === PhotographicReportExportType.PDF) {
      await this.documentGovernanceService.registerFinalDocument({
        companyId: params.report.company_id,
        module: 'photographic_report',
        entityId: params.report.id,
        title: `Relatório Fotográfico - ${params.report.client_name} / ${params.report.project_name}`,
        documentDate: params.report.end_date || params.report.start_date,
        fileKey: params.fileKey,
        folderPath: params.fileKey.split('/').slice(0, -1).join('/'),
        originalName: params.originalName,
        mimeType: params.mimeType,
        fileBuffer: params.fileBuffer,
        createdBy: generatedBy,
        documentCode: this.buildReportCode(params.report),
        documentType: 'pdf',
      });
    }

    return this.exportRepository.save(
      this.exportRepository.create({
        company_id: params.report.company_id,
        report_id: params.report.id,
        export_type: params.exportType,
        file_url: params.fileKey,
        generated_by: generatedBy,
        generated_at: new Date(),
      }),
    );
  }

  private async buildExportBufferAndPersist(params: {
    report: PhotographicReportResponse;
    exportType: PhotographicReportExportType;
  }): Promise<{
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    fileKey: string;
  }> {
    const companyId = params.report.company_id;
    const slug = this.buildFileSlug(params.report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension =
      params.exportType === PhotographicReportExportType.PDF ? 'pdf' : 'docx';
    const mimeType =
      params.exportType === PhotographicReportExportType.PDF
        ? PDF_MIME_TYPE
        : WORD_MIME_TYPE;
    const fileName = `RELATORIO_FOTOGRAFICO_${slug || 'documento'}_${stamp}.${extension}`;
    const fileKey = this.documentStorageService.generateDocumentKey(
      companyId,
      'photographic-report',
      params.report.id,
      fileName,
      { folderSegments: ['exports', params.exportType] },
    );

    const buffer =
      params.exportType === PhotographicReportExportType.PDF
        ? await this.buildPdfBuffer(params.report)
        : await this.buildWordBuffer(params.report);

    await this.documentStorageService.uploadFile(fileKey, buffer, mimeType);

    try {
      await this.persistExportRecord({
        report: await this.findReportEntity(params.report.id, companyId),
        fileKey,
        exportType: params.exportType,
        originalName: fileName,
        mimeType,
        fileBuffer: buffer,
      });
    } catch (error) {
      try {
        await this.documentStorageService.deleteFile(fileKey);
      } catch {
        /* best effort cleanup */
      }
      throw error;
    }

    const current = await this.findReportEntity(params.report.id, companyId);
    current.status = PhotographicReportStatus.EXPORTADO;
    await this.reportRepository.save(current);

    return { buffer, fileName, mimeType, fileKey };
  }

  async exportPdf(
    reportId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const report = await this.findOne(reportId);
    if (report.images.length === 0) {
      throw new BadRequestException('Relatório sem fotos.');
    }
    const result = await this.buildExportBufferAndPersist({
      report,
      exportType: PhotographicReportExportType.PDF,
    });
    return { buffer: result.buffer, fileName: result.fileName };
  }

  async exportWord(
    reportId: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const report = await this.findOne(reportId);
    if (report.images.length === 0) {
      throw new BadRequestException('Relatório sem fotos.');
    }
    const result = await this.buildExportBufferAndPersist({
      report,
      exportType: PhotographicReportExportType.WORD,
    });
    return { buffer: result.buffer, fileName: result.fileName };
  }

  async listExports(
    reportId: string,
  ): Promise<PhotographicReportExportResponse[]> {
    const report = await this.findOne(reportId);
    return report.exports;
  }

  async downloadExport(
    reportId: string,
    exportId: string,
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    const companyId = this.getCompanyIdOrThrow();
    const report = await this.findReportEntity(reportId, companyId);
    const exportEntity = await this.ensureExportBelongsToReport(
      report,
      exportId,
    );
    const buffer = await this.documentStorageService.downloadFileBuffer(
      exportEntity.file_url,
    );
    const fileName =
      exportEntity.file_url.split('/').pop() ||
      `${this.buildFileSlug(report)}.${exportEntity.export_type === PhotographicReportExportType.PDF ? 'pdf' : 'docx'}`;
    const mimeType =
      exportEntity.export_type === PhotographicReportExportType.PDF
        ? PDF_MIME_TYPE
        : WORD_MIME_TYPE;
    return { buffer, fileName, mimeType };
  }

  async getPdfAccess(reportId: string) {
    const report = await this.findOne(reportId);
    const registryEntry = await this.documentRegistryService.findByDocument(
      'photographic_report',
      report.id,
      'pdf',
      report.company_id,
    );

    if (!registryEntry) {
      return {
        entityId: report.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message: 'O relatório fotográfico ainda não possui PDF final emitido.',
        fileKey: null,
        folderPath: null,
        originalName: null,
        url: null,
      };
    }

    const url = await this.signUrl(registryEntry.file_key);
    return {
      entityId: report.id,
      hasFinalPdf: true,
      availability: url ? 'ready' : 'registered_without_signed_url',
      message: url
        ? 'PDF final governado disponível para download.'
        : 'PDF final emitido, mas a URL segura está temporariamente indisponível.',
      fileKey: registryEntry.file_key,
      folderPath: registryEntry.file_key.split('/').slice(0, -1).join('/'),
      originalName:
        registryEntry.original_name ||
        registryEntry.file_key.split('/').pop() ||
        null,
      url,
    };
  }

  async sendEmail(
    id: string,
    to: string[],
  ): Promise<DocumentMailDispatchResponseDto & { recipients: number }> {
    const report = await this.findOne(id);
    if (!to.length) {
      return {
        success: true,
        message: 'Nenhum destinatário informado para envio do relatório.',
        deliveryMode: 'sent',
        artifactType: 'governed_final_pdf',
        isOfficial: false,
        fallbackUsed: false,
        documentId: report.id,
        documentType: 'PHOTOGRAPHIC_REPORT',
        recipients: 0,
      };
    }

    const pdfExports = (report.exports ?? []).filter(
      (e) => e.export_type === PhotographicReportExportType.PDF,
    );
    if (!pdfExports.length) {
      throw new BadRequestException(
        'Exporte o relatório em PDF antes de enviar por e-mail.',
      );
    }

    const context = this.tenantService.getContext();
    const companyId = context?.companyId ?? report.company_id;
    const workerTenantContext = {
      companyId,
      isSuperAdmin: context?.isSuperAdmin ?? false,
      siteScope: context?.siteScope,
      ...(context?.siteScope === 'single' ? { siteIds: context.siteIds } : {}),
    };

    let queuedCount = 0;
    let syncFallbackUsed = false;

    for (const email of to) {
      try {
        await this.mailQueue.add(
          'send-document',
          {
            documentId: report.id,
            documentType: 'PHOTOGRAPHIC_REPORT',
            email,
            companyId,
            tenantContext: workerTenantContext,
          },
          defaultJobOptions,
        );
        queuedCount++;
      } catch (error) {
        this.logger.warn(
          `Fila de e-mail indisponível para relatório fotográfico ${report.id}, aplicando fallback síncrono: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.mailService.sendStoredDocument(
          report.id,
          'PHOTOGRAPHIC_REPORT',
          email,
          companyId,
        );
        syncFallbackUsed = true;
      }
    }

    const deliveryMode: 'queued' | 'sent' =
      queuedCount === to.length ? 'queued' : 'sent';

    return {
      success: true,
      message:
        deliveryMode === 'queued'
          ? `Relatório fotográfico enfileirado para envio a ${to.length} destinatário(s).`
          : `Relatório fotográfico enviado a ${to.length} destinatário(s) via fallback síncrono.`,
      deliveryMode,
      artifactType: 'governed_final_pdf',
      isOfficial: false,
      fallbackUsed: syncFallbackUsed,
      documentId: report.id,
      documentType: 'PHOTOGRAPHIC_REPORT',
      recipients: to.length,
    };
  }
}
