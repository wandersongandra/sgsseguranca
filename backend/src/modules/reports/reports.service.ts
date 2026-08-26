import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Apr } from '../aprs/entities/apr.entity';
import { Checklist } from '../checklists/entities/checklist.entity';
import { Report } from './entities/report.entity';
import { PdfService } from '../../shared/services/pdf.service';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import { Company } from '../companies/entities/company.entity';
import { DocumentGovernanceService } from '../document-registry/document-governance.service';
import { DocumentRegistryService } from '../document-registry/document-registry.service';
import { PublicValidationGrantService } from '../../shared/services/public-validation-grant.service';
import { Dds } from '../dds/entities/dds.entity';
import { Epi } from '../epis/entities/epi.entity';
import { Pt } from '../pts/entities/pt.entity';
import { Training } from '../trainings/entities/training.entity';
import { storageKeyFingerprint } from '../../shared/storage/storage-compensation.util';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import * as fs from 'fs';
import * as path from 'path';

type MonthlyReportStats = {
  aprs_count: number;
  pts_count: number;
  dds_count: number;
  checklists_count: number;
  trainings_count: number;
  epis_expired_count: number;
};

type MonthlyReportDateColumn =
  | 'data_inicio'
  | 'data_hora_inicio'
  | 'data'
  | 'data_conclusao'
  | 'validade_ca';

type MonthRange = {
  monthStart: string;
  nextMonth: string;
};

export type ReportPdfAccessAvailability =
  'not_emitted' | 'ready' | 'registered_without_signed_url';

export type ReportPdfAccessResponse = {
  entityId: string;
  hasFinalPdf: boolean;
  availability: ReportPdfAccessAvailability;
  message: string;
  degraded: boolean;
  fileKey: string | null;
  folderPath: string | null;
  originalName: string | null;
  fileHash: string | null;
  documentCode: string | null;
  url: string | null;
};

export type GeneratedReportArtifact = {
  buffer: Buffer;
  report: Report;
  documentCode: string;
  originalName: string;
  title: string;
};

const MONTHLY_REPORT_DATE_COLUMNS = new Set<MonthlyReportDateColumn>([
  'data_inicio',
  'data_hora_inicio',
  'data',
  'data_conclusao',
  'validade_ca',
]);

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private monthlyReportTemplate: string;

  constructor(
    @InjectRepository(Report)
    private readonly reportRepository: Repository<Report>,
    @InjectRepository(Apr)
    private readonly aprsRepository: Repository<Apr>,
    @InjectRepository(Checklist)
    private readonly checklistsRepository: Repository<Checklist>,
    @InjectRepository(Dds)
    private readonly ddsRepository: Repository<Dds>,
    @InjectRepository(Epi)
    private readonly episRepository: Repository<Epi>,
    @InjectRepository(Pt)
    private readonly ptsRepository: Repository<Pt>,
    @InjectRepository(Training)
    private readonly trainingsRepository: Repository<Training>,
    private readonly pdfService: PdfService,
    private readonly documentStorageService: DocumentStorageService,
    private readonly documentGovernanceService: DocumentGovernanceService,
    private readonly documentRegistryService: DocumentRegistryService,
    private readonly tenantService: TenantService,
    private readonly publicValidationGrantService: PublicValidationGrantService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
  ) {
    this.loadTemplates();
  }

  /**
   * Código documental + token de validação pública (grant) do relatório
   * mensal. O código é determinístico (o mesmo do PDF final governado),
   * então o token vale antes e depois da emissão.
   */
  async getValidationContext(
    id: string,
  ): Promise<{ documentCode: string; token: string | null }> {
    const report = await this.findOne(id);
    const documentCode = this.buildMonthlyReportDocumentCode(report);
    let token: string | null = null;

    try {
      token = await this.publicValidationGrantService.issueToken({
        code: documentCode,
        companyId: report.company_id,
        portal: 'report_public_validation',
        documentId: report.id,
      });
    } catch (error) {
      this.logger.warn({
        event: 'report_validation_token_unavailable',
        reportId: report.id,
        companyId: report.company_id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { documentCode, token };
  }

  private getTenantContextOrThrow(): {
    companyId: string;
    siteId?: string;
    siteScope: 'single' | 'all';
    isSuperAdmin: boolean;
  } {
    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'relatorios',
    );

    return {
      companyId: scope.companyId,
      siteId: scope.siteId,
      siteScope: scope.siteScope,
      isSuperAdmin: scope.isSuperAdmin,
    };
  }

  private resolveMonthlyTemplatePath(): string | null {
    const fileName = 'monthly-report.template.html';
    const candidates = [
      path.join(__dirname, 'templates', fileName),
      path.join(process.cwd(), 'dist', 'reports', 'templates', fileName),
      path.join(process.cwd(), 'src', 'reports', 'templates', fileName),
      path.join(
        process.cwd(),
        'backend',
        'src',
        'reports',
        'templates',
        fileName,
      ),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private buildFallbackMonthlyTemplate(): string {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>Relatório Mensal SST</title>
  <style>
    @page { size: A4 landscape; margin: 0; }
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; color: #25221f; margin: 0; padding: 0; background: #fff; }
    .page { width: 297mm; min-height: 210mm; padding: 12mm 14mm; display: flex; flex-direction: column; }
    .header { margin: -14mm -14mm 0; padding: 14mm 14mm 10mm; background: #2c2825; color: #fff; border-bottom: 2.6mm solid #3e3935; position: relative; min-height: 38mm; display: flex; align-items: flex-start; gap: 14px; }
    .header-logo { flex-shrink: 0; width: 42mm; height: 18mm; background: rgba(255,255,255,0.05); border-radius: 4px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .header-logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .header-content { flex-grow: 1; }
    .title { font-size: 16pt; font-weight: 700; margin: 0; }
    .subtitle { color: #c4bcb6; font-size: 9.5pt; margin: 4px 0 0; }
    .document-chip { position: absolute; top: 10mm; right: 14mm; width: 52mm; background: #fff; color: #25221f; border-radius: 6px; padding: 8px 10px; }
    .document-chip .k { font-size: 7pt; text-transform: uppercase; letter-spacing: .08em; color: #8f8882; font-weight: 700; }
    .document-chip .v { margin-top: 6px; font-size: 11pt; font-weight: 700; }
    .document-chip .m { margin-top: 4px; font-size: 7.5pt; color: #67615b; }
    .body { flex-grow: 1; padding-top: 8mm; }
    .meta-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; break-inside: avoid; page-break-inside: avoid; }
    .meta { background: #f6f5f3; border: 1px solid #d5cec7; border-radius: 6px; padding: 10px 12px; }
    .meta .k { color: #8f8882; font-size: 7.3pt; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; margin-bottom: 5px; display: block; }
    .meta .v { font-weight: 700; font-size: 10pt; color: #25221f; display: block; line-height: 1.35; }
    .strip { display: grid; grid-template-columns: 1.3fr repeat(3, minmax(0, 1fr)); gap: 10px; background: #f6f5f3; border: 1px solid #d5cec7; border-radius: 8px; margin-bottom: 12px; overflow: hidden; break-inside: avoid; page-break-inside: avoid; }
    .strip-summary { border-left: 4px solid #1d6b43; padding: 12px 14px; }
    .strip-summary .t { font-size: 10.5pt; font-weight: 700; color: #25221f; margin-bottom: 4px; }
    .strip-summary .b { font-size: 8.6pt; line-height: 1.45; color: #57534e; }
    .pill { background: #fff; border-left: 4px solid #3e3935; padding: 10px 12px; display: flex; flex-direction: column; justify-content: center; }
    .pill.success { border-left-color: #1d6b43; }
    .pill.warning { border-left-color: #9a5a00; }
    .pill.danger { border-left-color: #b3261e; }
    .pill .k { font-size: 7pt; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; color: #8f8882; margin-bottom: 5px; }
    .pill .v { font-size: 13pt; font-weight: 700; color: #25221f; }
    h2 { margin: 14px 0 8px; font-size: 11pt; color: #25221f; }
    .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; break-inside: avoid; page-break-inside: avoid; }
    .stat-card { background: #fff; border: 1px solid #d5cec7; border-radius: 6px; padding: 12px 14px; min-height: 72px; position: relative; overflow: hidden; }
    .stat-card::after { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: #18517C; }
    .stat-card.primary::after { background: #18517C; }
    .stat-card.success::after { background: #166534; }
    .stat-card.warning::after { background: #92400e; }
    .stat-card.danger::after { background: #991b1b; }
    .stat-value { display: block; font-size: 19pt; font-weight: 800; color: #111827; margin-top: 5px; margin-bottom: 4px; line-height: 1; }
    .stat-label { display: block; font-size: 8pt; color: #6B7280; font-weight: 600; line-height: 1.35; }
    .analysis { margin-top: 0; border: 1px solid #d5cec7; border-radius: 6px; background: #f6f5f3; padding: 14px; overflow-wrap: anywhere; word-break: break-word; }
    .analysis .t { font-size: 10.5pt; font-weight: 700; margin-bottom: 8px; color: #25221f; }
    .analysis pre { white-space: pre-wrap; font-family: inherit; margin: 0; line-height: 1.65; font-size: 9.6pt; overflow-wrap: anywhere; word-break: break-word; }
    .governance { margin-top: 12px; background: #f0ede9; border: 1px solid #d5cec7; border-radius: 6px; padding: 10px 12px; break-inside: avoid; page-break-inside: avoid; }
    .governance .k { font-size: 7.2pt; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; color: #8f8882; margin-bottom: 4px; }
    .governance .v { font-size: 8.5pt; color: #57534e; line-height: 1.45; }
    .footer { margin-top: auto; display: flex; justify-content: space-between; border-top: 1px solid #d5cec7; padding-top: 10mm; font-size: 8pt; color: #8f8882; break-inside: avoid; page-break-inside: avoid; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      {{logo_block}}
      <div class="header-content">
        <h1 class="title">Relatório SGS - {{periodo}}</h1>
        <div class="subtitle">Relatório executivo de desempenho documental e conformidade</div>
      </div>
      <div class="document-chip">
        <div class="k">Emissão documental</div>
        <div class="v">{{periodo}}</div>
        <div class="m">{{dataEmissao}}</div>
      </div>
    </div>

    <div class="body">
      <div class="meta-grid">
        <div class="meta"><span class="k">Empresa</span><span class="v">{{companyName}}</span></div>
        <div class="meta"><span class="k">Período</span><span class="v">{{periodo}}</span></div>
        <div class="meta"><span class="k">Emissão</span><span class="v">{{dataEmissao}}</span></div>
        <div class="meta"><span class="k">Status</span><span class="v">{{status_signal}}</span></div>
      </div>

      <div class="strip">
        <div class="strip-summary">
          <div class="t">Leitura executiva do período</div>
          <div class="b">{{executive_summary_text}}</div>
        </div>
        <div class="pill {{operational_tone}}">
          <div class="k">Registros</div>
          <div class="v">{{operational_total}}</div>
        </div>
        <div class="pill {{training_tone}}">
          <div class="k">Treinamentos</div>
          <div class="v">{{trainings_count}}</div>
        </div>
        <div class="pill {{status_tone}}">
          <div class="k">Status</div>
          <div class="v">{{status_signal}}</div>
        </div>
      </div>

      <h2>Indicadores mensais</h2>
      <div class="stats">
        {{stats_cards}}
      </div>

      <div class="analysis">
        <div class="t">Análise e recomendações</div>
        <pre>{{analise_executiva}}</pre>
      </div>

      <div class="governance">
        <div class="k">Governança documental</div>
        <div class="v">{{governance_note}}</div>
      </div>
    </div>

    <div class="footer">
      <span>SGS — Sistema de Gestão de Segurança</span>
      <span>Documento confidencial · Emissão digital institucional</span>
    </div>
  </div>
</body>
</html>`;
  }

  private loadTemplates() {
    try {
      const templatePath = this.resolveMonthlyTemplatePath();
      if (!templatePath) {
        this.logger.warn(
          'Template mensal não encontrado em disco. Usando template fallback embutido.',
        );
        this.monthlyReportTemplate = this.buildFallbackMonthlyTemplate();
        return;
      }

      this.monthlyReportTemplate = fs.readFileSync(templatePath, 'utf-8');
      this.logger.log(
        `Template de relatório mensal carregado: ${templatePath}`,
      );
    } catch (error) {
      this.logger.error(
        'Falha ao carregar template de relatório mensal. Usando fallback embutido.',
        error,
      );
      this.monthlyReportTemplate = this.buildFallbackMonthlyTemplate();
    }
  }

  async findAll(): Promise<Report[]> {
    const { companyId } = this.getTenantContextOrThrow();
    return this.reportRepository.find({
      where: { company_id: companyId },
      order: { created_at: 'DESC' },
      take: 100,
    });
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
  }): Promise<OffsetPage<Report>> {
    const { companyId } = this.getTenantContextOrThrow();
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 12,
      maxLimit: 50,
    });

    const [data, total] = await this.reportRepository.findAndCount({
      where: { company_id: companyId },
      order: { created_at: 'DESC' },
      skip,
      take: limit,
    });

    return toOffsetPage(data, total, page, limit);
  }

  async findOne(id: string): Promise<Report> {
    const { companyId } = this.getTenantContextOrThrow();
    const report = await this.reportRepository.findOne({
      where: { id, company_id: companyId },
    });
    if (!report) {
      throw new NotFoundException(`Relatório com ID ${id} não encontrado`);
    }
    return report;
  }

  async remove(id: string): Promise<void> {
    const report = await this.findOne(id);
    if (report.pdf_file_key) {
      await this.documentGovernanceService.removeFinalDocumentReference({
        companyId: report.company_id,
        module: 'report',
        entityId: report.id,
        cleanupStoredFile: (fileKey) =>
          this.documentStorageService.deleteFile(
            this.documentStorageService.referenceForExistingObject(
              fileKey,
              {
                resourceType: 'report',
                resourceId: report.id,
              },
              'document-registry:report:pdf',
            ),
          ),
      });
    }
    // Soft delete: a entidade tem @DeleteDateColumn; hard delete destruiria
    // permanentemente um relatório mensal já emitido sem retenção histórica.
    await this.reportRepository.softDelete(id);
  }

  async generateBuffer(
    reportType: string,
    params: unknown,
  ): Promise<GeneratedReportArtifact> {
    switch (reportType) {
      case 'monthly': {
        const parsedParams =
          (params as Partial<{
            companyId: string;
            year: number;
            month: number;
            generatedBy?: string;
          }>) || {};
        const { companyId, year, month, generatedBy } = parsedParams;
        if (!companyId || !year || !month) {
          throw new BadRequestException(
            'Parâmetros obrigatórios ausentes para relatório mensal (companyId, year, month)',
          );
        }
        return this.generateMonthlyReport(companyId, year, month, generatedBy);
      }
      default:
        throw new BadRequestException(
          `Tipo de relatório não suportado: ${reportType}`,
        );
    }
  }

  async generateMonthlyReport(
    companyId: string,
    year: number,
    month: number,
    generatedBy?: string,
  ): Promise<GeneratedReportArtifact> {
    const { siteId, siteScope, isSuperAdmin } = this.getTenantContextOrThrow();

    // Defense-in-depth: ensure the tenant context company matches the job params (protects against tampered jobs)
    if (this.getTenantContextOrThrow().companyId !== companyId) {
      this.logger.warn(
        `Report generation companyId mismatch: context=${this.getTenantContextOrThrow().companyId} job=${companyId}`,
      );
      throw new BadRequestException(
        'Company context mismatch for report generation',
      );
    }

    this.logger.log(
      `Iniciando geração de relatório mensal para empresa ${companyId} (Período: ${month}/${year})`,
    );

    const company = await this.companyRepository.findOne({
      where: { id: companyId },
      select: ['id', 'razao_social', 'logo_storage_key', 'logo_content_type'],
    });
    if (!company) {
      throw new NotFoundException('Empresa nao encontrada.');
    }

    const logoDataUrl = await this.resolveLogoDataUrl(
      companyId,
      company.logo_storage_key,
      company.logo_content_type,
    );
    const logoHtml: string | null = logoDataUrl
      ? `<img src="${logoDataUrl}" alt="Logo" style="max-height:30px;max-width:120px;object-fit:contain;" />`
      : null;

    const reportData = await this.tenantService.run(
      { companyId, isSuperAdmin, siteId, siteScope },
      async () =>
        this.buildMonthlyReportRecord(companyId, year, month, generatedBy),
    );

    const html = this.buildMonthlyReportHtml({
      companyName: company.razao_social,
      month,
      year,
      estatisticas: reportData.estatisticas,
      analise_gandra: reportData.analise_gandra,
      logoHtml,
    });

    const buffer = await this.pdfService.generateFromHtml(html, {
      landscape: true,
      preferCssPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: this.buildMonthlyReportFooterTemplate(
        company.razao_social,
      ),
      margin: {
        top: '0mm',
        right: '0mm',
        bottom: '8mm',
        left: '0mm',
      },
    });

    return {
      buffer,
      report: reportData,
      documentCode: this.buildMonthlyReportDocumentCode(reportData),
      originalName: this.buildMonthlyReportOriginalName(reportData),
      title: reportData.titulo,
    };
  }

  private async buildMonthlyReportRecord(
    companyId: string,
    year: number,
    month: number,
    generatedBy?: string,
  ): Promise<Report> {
    const { siteId, siteScope, isSuperAdmin } = this.getTenantContextOrThrow();
    const scopedSiteId =
      !isSuperAdmin && siteScope !== 'all' ? siteId : undefined;
    const [
      aprsCount,
      ptsCount,
      ddsCount,
      checklistsCount,
      trainingsCount,
      expiredEpisCount,
    ] = await Promise.all([
      this.countByMonth(
        this.aprsRepository,
        'apr',
        'data_inicio',
        companyId,
        year,
        month,
        scopedSiteId,
      ),
      this.countByMonth(
        this.ptsRepository,
        'pt',
        'data_hora_inicio',
        companyId,
        year,
        month,
        scopedSiteId,
      ),
      this.countByMonth(
        this.ddsRepository,
        'dds',
        'data',
        companyId,
        year,
        month,
        scopedSiteId,
      ),
      this.countByMonth(
        this.checklistsRepository,
        'checklist',
        'data',
        companyId,
        year,
        month,
        scopedSiteId,
      ),
      this.countByMonth(
        this.trainingsRepository,
        'training',
        'data_conclusao',
        companyId,
        year,
        month,
        undefined,
      ),
      this.countByMonth(
        this.episRepository,
        'epi',
        'validade_ca',
        companyId,
        year,
        month,
        undefined,
      ),
    ]);

    const estatisticas: MonthlyReportStats = {
      aprs_count: aprsCount,
      pts_count: ptsCount,
      dds_count: ddsCount,
      checklists_count: checklistsCount,
      trainings_count: trainingsCount,
      epis_expired_count: expiredEpisCount,
    };

    const analise_gandra = this.buildMonthlyAnalysis(year, month, estatisticas);
    const titulo = `Relatório Mensal SGS - ${String(month).padStart(2, '0')}/${year}`;
    const descricao =
      'Relatório consolidado com indicadores mensais de APR, PT, DDS, checklists, treinamentos e vencimentos de EPI.';

    const existing = await this.reportRepository.findOne({
      where: { company_id: companyId, ano: year, mes: month },
    });

    if (existing) {
      existing.titulo = titulo;
      existing.descricao = descricao;
      existing.estatisticas = estatisticas;
      existing.analise_gandra = analise_gandra;
      if (generatedBy && !existing.generated_by) {
        existing.generated_by = generatedBy;
      }
      return this.reportRepository.save(existing);
    }

    return this.reportRepository.save(
      this.reportRepository.create({
        titulo,
        descricao,
        mes: month,
        ano: year,
        company_id: companyId,
        estatisticas,
        analise_gandra,
        generated_by: generatedBy ?? null,
      }),
    );
  }

  private async countByMonth<T extends { company_id: string }>(
    repository: Repository<T>,
    alias: string,
    dateColumn: MonthlyReportDateColumn,
    companyId: string,
    year: number,
    month: number,
    siteId?: string,
  ): Promise<number> {
    if (!MONTHLY_REPORT_DATE_COLUMNS.has(dateColumn)) {
      throw new BadRequestException(
        `Coluna de data não permitida: ${dateColumn}`,
      );
    }

    const { monthStart, nextMonth } = this.resolveMonthRange(year, month);

    return repository
      .createQueryBuilder(alias)
      .where(`${alias}.company_id = :companyId`, { companyId })
      .andWhere(
        siteId ? `${alias}.site_id = :siteId` : '1=1',
        siteId ? { siteId } : {},
      )
      .andWhere(`${alias}.${dateColumn} IS NOT NULL`)
      .andWhere(`${alias}.${dateColumn} >= :monthStart`, { monthStart })
      .andWhere(`${alias}.${dateColumn} < :nextMonth`, { nextMonth })
      .andWhere(`${alias}.deleted_at IS NULL`)
      .getCount();
  }

  private resolveMonthRange(year: number, month: number): MonthRange {
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      throw new BadRequestException(
        'Ano e mês do relatório mensal devem ser inteiros válidos.',
      );
    }

    if (month < 1 || month > 12) {
      throw new BadRequestException(
        'Mês do relatório mensal deve estar entre 1 e 12.',
      );
    }

    const monthStart = new Date(Date.UTC(year, month - 1, 1))
      .toISOString()
      .slice(0, 10);
    const nextMonth = new Date(Date.UTC(year, month, 1))
      .toISOString()
      .slice(0, 10);

    return { monthStart, nextMonth };
  }

  private buildMonthlyAnalysis(
    year: number,
    month: number,
    stats: MonthlyReportStats,
  ): string {
    const totalOperationalRecords =
      stats.aprs_count +
      stats.pts_count +
      stats.dds_count +
      stats.checklists_count;

    const highlights = [
      `${totalOperationalRecords} registros operacionais emitidos no período`,
      `${stats.trainings_count} treinamento(s) concluído(s)`,
    ];

    if (stats.epis_expired_count > 0) {
      highlights.push(
        `${stats.epis_expired_count} EPI(s) com CA vencido identificado(s) no mês`,
      );
    }

    return `No período ${String(month).padStart(2, '0')}/${year}, foram registrados ${highlights.join(', ')}. Priorize revisão das frentes com menor emissão preventiva e trate imediatamente qualquer vencimento de EPI para evitar bloqueios operacionais.`;
  }

  private buildMonthlyReportDocumentCode(report: Report): string {
    return `RPT-${report.ano}-${String(report.mes).padStart(2, '0')}-${report.id.slice(0, 8).toUpperCase()}`;
  }

  private buildMonthlyReportOriginalName(report: Report): string {
    return `RELATORIO_MENSAL_${String(report.mes).padStart(2, '0')}-${report.ano}.pdf`;
  }

  private async resolveLogoDataUrl(
    companyId: string,
    storageKey: string | null | undefined,
    contentType: string | null | undefined,
  ): Promise<string | null> {
    if (!storageKey) return null;
    try {
      const buf = await this.documentStorageService.downloadFileBuffer(
        this.documentStorageService.referenceForExistingObject(
          storageKey,
          {
            resourceType: 'company',
            resourceId: companyId,
          },
          'company-logo',
        ),
      );
      const mime = contentType ?? 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (error) {
      this.logger.warn({
        event: 'report_company_logo_download_failed',
        companyId,
        keyFingerprint: storageKeyFingerprint(storageKey),
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
      return null;
    }
  }

  private escapeHtml(value: string | number | null | undefined): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private resolveOperationalTone(
    total: number,
  ): 'success' | 'info' | 'warning' | 'danger' {
    if (total <= 0) {
      return 'danger';
    }

    if (total < 10) {
      return 'warning';
    }

    if (total >= 25) {
      return 'success';
    }

    return 'info';
  }

  private buildMonthlyReportLogoBlock(logoHtml?: string | null): string {
    const trimmed = String(logoHtml || '').trim();
    if (!trimmed) {
      return '';
    }

    return `<div class="header-logo">${trimmed}</div>`;
  }

  private buildMonthlyReportFooterTemplate(companyName: string): string {
    const escapedCompanyName = this.escapeHtml(companyName);

    return `
      <div style="width: 100%; font-size: 8px; color: #6B7280; padding: 0 16mm; box-sizing: border-box; font-family: Arial, sans-serif;">
        <div style="border-top: 1px solid #D3DCE6; padding-top: 4px; display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <span>SGS · ${escapedCompanyName}</span>
          <span>Pág. <span class="pageNumber"></span> de <span class="totalPages"></span></span>
        </div>
      </div>
    `;
  }

  async getPdfAccess(id: string): Promise<ReportPdfAccessResponse> {
    const report = await this.findOne(id);
    const registryEntry = await this.documentRegistryService.findByDocument(
      'report',
      report.id,
      'pdf',
      report.company_id,
    );

    if (!report.pdf_file_key) {
      return {
        entityId: report.id,
        hasFinalPdf: false,
        availability: 'not_emitted',
        message:
          'O relatório mensal ainda não possui PDF final emitido. Gere o documento oficial para habilitar download, impressão e envio governado.',
        degraded: false,
        fileKey: null,
        folderPath: null,
        originalName: null,
        fileHash: null,
        documentCode:
          registryEntry?.document_code ||
          this.buildMonthlyReportDocumentCode(report),
        url: null,
      };
    }

    let url: string | null = null;
    let availability: ReportPdfAccessAvailability = 'ready';
    let degraded = false;
    let message = 'PDF final governado disponível para acesso.';

    try {
      url = await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          report.pdf_file_key,
          {
            resourceType: 'report',
            resourceId: report.id,
          },
          'document-registry:report:pdf',
        ),
      );
    } catch (error) {
      availability = 'registered_without_signed_url';
      degraded = true;
      message =
        'PDF final registrado, mas a URL segura não está disponível no momento. Tente novamente quando o storage estiver saudável.';
      this.logger.warn({
        event: 'report_pdf_signed_url_failed',
        reportId: report.id,
        keyFingerprint: storageKeyFingerprint(report.pdf_file_key),
        errorName: error instanceof Error ? error.name : 'unknown_error',
      });
    }

    return {
      entityId: report.id,
      hasFinalPdf: true,
      availability,
      message,
      degraded,
      fileKey: report.pdf_file_key,
      folderPath: report.pdf_folder_path || null,
      originalName: report.pdf_original_name || null,
      fileHash: registryEntry?.file_hash || report.pdf_file_hash || null,
      documentCode:
        registryEntry?.document_code ||
        this.buildMonthlyReportDocumentCode(report),
      url,
    };
  }

  private buildMonthlyReportHtml(data: {
    companyName: string;
    month: number;
    year: number;
    estatisticas: MonthlyReportStats;
    analise_gandra: string;
    logoHtml?: string | null;
  }): string {
    const { companyName, month, year, estatisticas, analise_gandra } = data;
    const expiredEpis = Number(estatisticas.epis_expired_count ?? 0);
    const trainingsCount = Number(estatisticas.trainings_count ?? 0);
    const operationalTotal =
      Number(estatisticas.aprs_count ?? 0) +
      Number(estatisticas.pts_count ?? 0) +
      Number(estatisticas.dds_count ?? 0) +
      Number(estatisticas.checklists_count ?? 0);
    const statusSignal =
      expiredEpis > 0
        ? 'Atenção'
        : operationalTotal >= 25
          ? 'Ativa'
          : 'Estável';
    const operationalTone = this.resolveOperationalTone(operationalTotal);
    const statusTone =
      expiredEpis > 0 ? 'danger' : operationalTotal >= 25 ? 'success' : 'info';
    const trainingTone = trainingsCount > 0 ? 'success' : 'warning';
    const governanceNote = `Documento emitido para ${companyName} com fechamento mensal de ${String(month).padStart(2, '0')}/${year}, preservando rastreabilidade executiva dos indicadores de SST.`;
    const replaceToken = (source: string, token: string, value: string) =>
      source.split(`{{${token}}}`).join(value);

    const metricLabels: Record<string, { label: string; style: string }> = {
      aprs_count: { label: 'APRs Emitidas', style: 'primary' },
      pts_count: { label: 'PTs Emitidas', style: 'primary' },
      dds_count: { label: 'DDS Realizados', style: 'success' },
      checklists_count: { label: 'Checklists Aplicados', style: 'primary' },
      trainings_count: { label: 'Treinamentos Concluídos', style: 'success' },
      epis_expired_count: { label: 'EPIs com CA Vencido', style: 'danger' },
    };

    const statsCardsHtml = Object.entries(estatisticas)
      .map(([key, value]) => {
        const metric = metricLabels[key];
        if (!metric) return '';
        const cardStyle =
          metric.style === 'danger' && value === 0 ? 'success' : metric.style;
        const finalValue = value ?? 0;

        return `
          <div class="stat-card ${cardStyle}">
            <span class="stat-value">${String(finalValue)}</span>
            <span class="stat-label">${this.escapeHtml(metric.label)}</span>
          </div>
        `;
      })
      .join('');

    const reportPeriod = `${String(month).padStart(2, '0')}/${year}`;
    const generatedAt = new Date().toLocaleString('pt-BR');
    const executiveSummaryText = `Visão rápida do fechamento de ${reportPeriod}: ${operationalTotal} registros operacionais, ${trainingsCount} treinamento(s)${expiredEpis > 0 ? ` e ${expiredEpis} EPI(s) com CA vencido` : ''}.`;
    const escapedCompanyName = this.escapeHtml(companyName);
    const escapedPeriod = this.escapeHtml(reportPeriod);
    const escapedGeneratedAt = this.escapeHtml(generatedAt);
    const escapedStatusSignal = this.escapeHtml(statusSignal);
    const escapedExecutiveSummaryText = this.escapeHtml(executiveSummaryText);
    const escapedGovernanceNote = this.escapeHtml(governanceNote);
    const escapedAnalysis = this.escapeHtml(analise_gandra);

    let html = this.monthlyReportTemplate;
    html = replaceToken(html, 'companyName', escapedCompanyName);
    html = replaceToken(html, 'periodo', escapedPeriod);
    html = replaceToken(html, 'dataEmissao', escapedGeneratedAt);
    html = replaceToken(
      html,
      'documentTitle',
      'Fechamento mensal de conformidade',
    );
    html = replaceToken(
      html,
      'logo_block',
      this.buildMonthlyReportLogoBlock(data.logoHtml),
    );
    html = replaceToken(html, 'operational_total', String(operationalTotal));
    html = replaceToken(html, 'operational_tone', operationalTone);
    html = replaceToken(html, 'trainings_count', String(trainingsCount));
    html = replaceToken(html, 'status_signal', escapedStatusSignal);
    html = replaceToken(html, 'status_tone', statusTone);
    html = replaceToken(html, 'training_tone', trainingTone);
    html = replaceToken(
      html,
      'executive_summary_text',
      escapedExecutiveSummaryText,
    );
    html = replaceToken(html, 'governance_note', escapedGovernanceNote);
    html = replaceToken(html, 'stats_cards', statsCardsHtml);
    html = replaceToken(html, 'analise_executiva', escapedAnalysis);

    return html;
  }
}
