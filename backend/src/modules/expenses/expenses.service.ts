import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import { randomUUID } from 'crypto';
import { TenantService } from '../../shared/tenant/tenant.service';
import { resolveSiteAccessScopeFromTenantService } from '../../shared/tenant/site-access-scope.util';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { DocumentStorageService } from '../../shared/services/document-storage.service';
import { cleanupUploadedFile } from '../../shared/storage/storage-compensation.util';
import { aoaToExcelBuffer } from '../../shared/utils/excel.util';
import { Site } from '../sites/entities/site.entity';
import { User } from '../users/entities/user.entity';
import { CreateExpenseAdvanceDto } from './dto/create-expense-advance.dto';
import { CreateExpenseItemDto } from './dto/create-expense-item.dto';
import { CreateExpenseReportDto } from './dto/create-expense-report.dto';
import { FindExpenseReportsQueryDto } from './dto/find-expense-reports-query.dto';
import { UpdateExpenseReportDto } from './dto/update-expense-report.dto';
import { ExpenseAdvance } from './entities/expense-advance.entity';
import { ExpenseCategory, ExpenseItem } from './entities/expense-item.entity';
import {
  ExpenseReport,
  ExpenseReportStatus,
} from './entities/expense-report.entity';

type ExpenseTotals = {
  totalAdvances: string;
  totalExpenses: string;
  balance: string;
  totalsByCategory: Record<ExpenseCategory, string>;
};

type ExpenseTenantContext = {
  companyId: string;
  userId?: string;
  siteId?: string;
  siteIds: string[];
  siteScope: 'single' | 'all';
  isAdmin: boolean;
};

export type ExpenseReportDetail = ExpenseReport & {
  totals: ExpenseTotals;
};

@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name);

  constructor(
    @InjectRepository(ExpenseReport)
    private readonly reportsRepository: Repository<ExpenseReport>,
    @InjectRepository(ExpenseAdvance)
    private readonly advancesRepository: Repository<ExpenseAdvance>,
    @InjectRepository(ExpenseItem)
    private readonly itemsRepository: Repository<ExpenseItem>,
    @InjectRepository(Site)
    private readonly sitesRepository: Repository<Site>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly tenantService: TenantService,
    private readonly documentStorageService: DocumentStorageService,
  ) {}

  async create(dto: CreateExpenseReportDto): Promise<ExpenseReportDetail> {
    const tenant = this.requireTenantContext();
    this.assertCanOwnReport(
      { site_id: dto.site_id, responsible_id: dto.responsible_id },
      tenant,
    );
    await this.assertSiteBelongsToCompany(dto.site_id, tenant.companyId);
    await this.assertUserBelongsToCompany(dto.responsible_id, tenant.companyId);
    this.assertValidPeriod(dto.period_start, dto.period_end);

    const report = this.reportsRepository.create({
      period_start: dto.period_start,
      period_end: dto.period_end,
      site_id: dto.site_id,
      responsible_id: dto.responsible_id,
      notes: dto.notes || null,
      company_id: tenant.companyId,
      status: ExpenseReportStatus.ABERTA,
    });

    const saved = await this.reportsRepository.save(report);
    this.logger.log({
      event: 'expense_report_created',
      reportId: saved.id,
      companyId: saved.company_id,
      siteId: saved.site_id,
    });
    return this.findOne(saved.id);
  }

  async findPaginated(
    query?: FindExpenseReportsQueryDto,
  ): Promise<OffsetPage<ExpenseReportDetail>> {
    const tenant = this.requireTenantContext({ allowMissingSiteScope: true });
    const { page, limit, skip } = normalizeOffsetPagination(query, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const idsQuery = this.reportsRepository
      .createQueryBuilder('report')
      .select('report.id', 'id')
      .where('report.deleted_at IS NULL')
      .andWhere('report.company_id = :companyId', {
        companyId: tenant.companyId,
      })
      .orderBy('report.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = this.reportsRepository
      .createQueryBuilder('report')
      .where('report.deleted_at IS NULL')
      .andWhere('report.company_id = :companyId', {
        companyId: tenant.companyId,
      });

    this.applyAccessScope(idsQuery, tenant);
    this.applyAccessScope(countQuery, tenant);

    if (query?.site_id) {
      this.assertRequestedSiteAllowed(query.site_id, tenant);
      idsQuery.andWhere('report.site_id = :requestedSiteId', {
        requestedSiteId: query.site_id,
      });
      countQuery.andWhere('report.site_id = :requestedSiteId', {
        requestedSiteId: query.site_id,
      });
    }

    if (query?.status) {
      idsQuery.andWhere('report.status = :status', { status: query.status });
      countQuery.andWhere('report.status = :status', {
        status: query.status,
      });
    }

    if (query?.period_start) {
      idsQuery.andWhere('report.period_end >= :periodStart', {
        periodStart: query.period_start,
      });
      countQuery.andWhere('report.period_end >= :periodStart', {
        periodStart: query.period_start,
      });
    }

    if (query?.period_end) {
      idsQuery.andWhere('report.period_start <= :periodEnd', {
        periodEnd: query.period_end,
      });
      countQuery.andWhere('report.period_start <= :periodEnd', {
        periodEnd: query.period_end,
      });
    }

    const [rows, total] = await Promise.all([
      idsQuery.getRawMany<{ id: string }>(),
      countQuery.getCount(),
    ]);
    const ids = rows.map((row) => row.id);

    if (ids.length === 0) {
      return toOffsetPage([], total, page, limit);
    }

    const reports = await this.reportsRepository.find({
      where: ids.map((id) => ({
        id,
        company_id: tenant.companyId,
        deleted_at: IsNull(),
      })),
      relations: ['site', 'responsible', 'closed_by'],
    });
    const details = await Promise.all(
      ids
        .map((id) => reports.find((report) => report.id === id))
        .filter((report): report is ExpenseReport => Boolean(report))
        .map((report) => this.withTotals(report)),
    );

    return toOffsetPage(details, total, page, limit);
  }

  async findOne(id: string): Promise<ExpenseReportDetail> {
    const report = await this.findScopedReport(id, {
      includeChildren: true,
    });
    return this.withTotals(report);
  }

  async update(
    id: string,
    dto: UpdateExpenseReportDto,
  ): Promise<ExpenseReportDetail> {
    const report = await this.findScopedReport(id);
    const tenant = this.requireTenantContext();
    this.assertCanMutateReport(report, tenant);
    this.assertReportOpen(report);

    if (dto.site_id) {
      this.assertRequestedSiteAllowed(dto.site_id, tenant);
      await this.assertSiteBelongsToCompany(dto.site_id, report.company_id);
      report.site_id = dto.site_id;
    }

    if (dto.responsible_id) {
      await this.assertUserBelongsToCompany(
        dto.responsible_id,
        report.company_id,
      );
      report.responsible_id = dto.responsible_id;
    }

    const nextStart = dto.period_start ?? report.period_start;
    const nextEnd = dto.period_end ?? report.period_end;
    this.assertValidPeriod(nextStart, nextEnd);
    report.period_start = nextStart;
    report.period_end = nextEnd;

    if (dto.notes !== undefined) {
      report.notes = dto.notes || null;
    }

    this.assertCanOwnReport(
      {
        site_id: report.site_id,
        responsible_id: report.responsible_id,
      },
      tenant,
    );

    await this.reportsRepository.save(report);
    return this.findOne(report.id);
  }

  async addAdvance(
    id: string,
    dto: CreateExpenseAdvanceDto,
    userId?: string,
  ): Promise<ExpenseReportDetail> {
    const report = await this.findScopedReport(id);
    this.assertCanMutateReport(report, this.requireTenantContext());
    this.assertReportOpen(report);

    const advance = this.advancesRepository.create({
      report_id: report.id,
      amount: this.formatMoney(dto.amount),
      advance_date: dto.advance_date,
      method: dto.method,
      description: dto.description || null,
      created_by_id: userId || null,
    });
    await this.advancesRepository.save(advance);
    return this.findOne(report.id);
  }

  async addItem(
    id: string,
    dto: CreateExpenseItemDto,
    file: Express.Multer.File,
    userId?: string,
  ): Promise<ExpenseReportDetail> {
    const report = await this.findScopedReport(id);
    this.assertCanMutateReport(report, this.requireTenantContext());
    this.assertReportOpen(report);

    const itemId = randomUUID();
    const buffer = this.readFileBuffer(file);
    const fileKey = this.documentStorageService.generateDocumentKey(
      report.company_id,
      'expenses',
      report.id,
      file.originalname || `comprovante-${itemId}`,
      { folderSegments: ['sites', report.site_id, 'receipts', itemId] },
    );

    const uploadedReference =
      await this.documentStorageService.uploadFileWithCapability(
        this.documentStorageService.referenceForExistingObject(
          fileKey,
          { resourceType: 'expense-item', resourceId: itemId },
          'p1-document-storage-uploadFile',
        ),
        buffer,
        file.mimetype || 'application/octet-stream',
      );

    try {
      const item = this.itemsRepository.create({
        id: itemId,
        report_id: report.id,
        category: dto.category,
        amount: this.formatMoney(dto.amount),
        expense_date: dto.expense_date,
        description: dto.description,
        vendor: dto.vendor || null,
        location: dto.location || null,
        receipt_file_key: fileKey,
        receipt_original_name: file.originalname || 'comprovante',
        receipt_mime_type: file.mimetype || 'application/octet-stream',
        created_by_id: userId || null,
      });
      await this.itemsRepository.save(item);
    } catch (error) {
      await cleanupUploadedFile(
        this.logger,
        `expense-report:${report.id}`,
        fileKey,
        (key) =>
          uploadedReference.key === key
            ? this.documentStorageService.deleteFile(uploadedReference)
            : Promise.resolve(),
      );
      throw error;
    }

    return this.findOne(report.id);
  }

  async removeItem(
    reportId: string,
    itemId: string,
  ): Promise<ExpenseReportDetail> {
    const report = await this.findScopedReport(reportId, {
      includeChildren: true,
    });
    this.assertCanMutateReport(report, this.requireTenantContext());
    this.assertReportOpen(report);
    const item = report.items?.find((current) => current.id === itemId);
    if (!item) {
      throw new NotFoundException('Despesa não encontrada nesta prestação.');
    }

    await this.itemsRepository.softDelete({
      id: item.id,
      report_id: report.id,
    });
    await cleanupUploadedFile(
      this.logger,
      `expense-item:${item.id}`,
      item.receipt_file_key,
      (key) =>
        this.documentStorageService.deleteFile(
          this.documentStorageService.referenceForExistingObject(
            key,
            { resourceType: 'expense-item', resourceId: item.id },
            'p1-document-storage-deleteFile',
          ),
        ),
    );
    return this.findOne(report.id);
  }

  async close(id: string, userId?: string): Promise<ExpenseReportDetail> {
    const report = await this.findScopedReport(id, {
      includeChildren: true,
    });
    this.assertAdminContext(this.requireTenantContext());
    this.assertReportOpen(report);
    const totals = this.calculateTotals(report);

    report.status = ExpenseReportStatus.FECHADA;
    report.closed_at = new Date();
    report.closed_by_id = userId || null;
    report.total_advances = totals.totalAdvances;
    report.total_expenses = totals.totalExpenses;
    report.balance = totals.balance;
    report.totals_by_category = totals.totalsByCategory;

    await this.reportsRepository.save(report);
    return this.findOne(report.id);
  }

  async getReceiptAccess(reportId: string, itemId: string) {
    const report = await this.findScopedReport(reportId, {
      includeChildren: true,
    });
    const item = report.items?.find((current) => current.id === itemId);
    if (!item) {
      throw new NotFoundException('Comprovante não encontrado.');
    }

    return {
      itemId: item.id,
      originalName: item.receipt_original_name,
      mimeType: item.receipt_mime_type,
      url: await this.documentStorageService.getSignedUrl(
        this.documentStorageService.referenceForExistingObject(
          item.receipt_file_key,
          {
            resourceType: 'expense-item',
            resourceId: item.id,
          },
          'p1-document-storage-getSignedUrl',
        ),
      ),
    };
  }

  async exportReport(id: string): Promise<Buffer> {
    const report = await this.findScopedReport(id, {
      includeChildren: true,
    });
    const totals = this.calculateTotals(report);

    return aoaToExcelBuffer([
      {
        name: 'Resumo',
        rows: [
          ['Obra', report.site?.nome || report.site_id],
          ['Responsável', report.responsible?.nome || report.responsible_id],
          ['Período', `${report.period_start} a ${report.period_end}`],
          ['Status', report.status],
          ['Total adiantado', Number(totals.totalAdvances)],
          ['Total despesas', Number(totals.totalExpenses)],
          ['Saldo', Number(totals.balance)],
        ],
        colWidths: [24, 40],
      },
      {
        name: 'Despesas',
        rows: [
          ['Data', 'Categoria', 'Descrição', 'Fornecedor/Local', 'Valor'],
          ...(report.items || []).map((item) => [
            item.expense_date,
            item.category,
            item.description,
            [item.vendor, item.location].filter(Boolean).join(' / '),
            Number(item.amount),
          ]),
        ],
        colWidths: [14, 18, 44, 32, 14],
      },
      {
        name: 'Adiantamentos',
        rows: [
          ['Data', 'Método', 'Descrição', 'Valor'],
          ...(report.advances || []).map((advance) => [
            advance.advance_date,
            advance.method,
            advance.description || '',
            Number(advance.amount),
          ]),
        ],
        colWidths: [14, 18, 44, 14],
      },
    ]);
  }

  private async findScopedReport(
    id: string,
    options?: { includeChildren?: boolean },
  ): Promise<ExpenseReport> {
    const tenant = this.requireTenantContext();
    const report = await this.reportsRepository.findOne({
      where: { id, company_id: tenant.companyId, deleted_at: IsNull() },
      relations: [
        'site',
        'responsible',
        'closed_by',
        ...(options?.includeChildren ? ['advances', 'items'] : []),
      ],
      order: {
        advances: { advance_date: 'ASC' },
        items: { expense_date: 'ASC' },
      },
    });

    if (!report) {
      throw new NotFoundException('Prestação de despesas não encontrada.');
    }
    this.assertCanViewReport(report, tenant);
    return report;
  }

  private async withTotals(
    report: ExpenseReport,
  ): Promise<ExpenseReportDetail> {
    const fullReport =
      report.items && report.advances
        ? report
        : await this.reportsRepository.findOneOrFail({
            where: {
              id: report.id,
              company_id: report.company_id,
              deleted_at: IsNull(),
            },
            relations: [
              'site',
              'responsible',
              'closed_by',
              'advances',
              'items',
            ],
          });

    return Object.assign(fullReport, {
      totals: this.calculateTotals(fullReport),
    });
  }

  private calculateTotals(report: ExpenseReport): ExpenseTotals {
    const totalAdvances = (report.advances || []).reduce(
      (sum, advance) => sum + Number(advance.amount || 0),
      0,
    );
    const totalExpenses = (report.items || []).reduce(
      (sum, item) => sum + Number(item.amount || 0),
      0,
    );
    const totalsByCategory = Object.values(ExpenseCategory).reduce(
      (acc, category) => {
        acc[category] = this.formatMoney(
          (report.items || [])
            .filter((item) => item.category === category)
            .reduce((sum, item) => sum + Number(item.amount || 0), 0),
        );
        return acc;
      },
      {} as Record<ExpenseCategory, string>,
    );

    return {
      totalAdvances: this.formatMoney(totalAdvances),
      totalExpenses: this.formatMoney(totalExpenses),
      balance: this.formatMoney(totalAdvances - totalExpenses),
      totalsByCategory,
    };
  }

  private requireTenantContext(options?: { allowMissingSiteScope?: boolean }): {
    companyId: string;
    userId?: string;
    siteId?: string;
    siteIds: string[];
    siteScope: 'single' | 'all';
    isAdmin: boolean;
  } {
    const context = this.tenantService.getContext();
    if (!context?.companyId?.trim()) {
      throw new UnauthorizedException(
        'Contexto de empresa não identificado para despesas.',
      );
    }

    const scope = resolveSiteAccessScopeFromTenantService(
      this.tenantService,
      'despesas',
      options,
    );

    return {
      companyId: scope.companyId,
      userId: scope.userId,
      siteId: scope.siteId,
      siteIds: scope.siteIds,
      siteScope: scope.siteScope,
      isAdmin: scope.hasCompanyWideAccess,
    };
  }

  private assertRequestedSiteAllowed(
    siteId: string,
    tenant: ExpenseTenantContext,
  ): void {
    if (tenant.isAdmin) {
      return;
    }
    if (!tenant.siteIds.includes(siteId)) {
      throw new ForbiddenException('Obra fora do escopo do usuário atual.');
    }
  }

  private applyAccessScope(
    query: SelectQueryBuilder<ExpenseReport>,
    tenant: ExpenseTenantContext,
  ): void {
    if (tenant.isAdmin) {
      return;
    }

    if (tenant.siteIds.length > 0) {
      query.andWhere('report.site_id IN (:...currentUserSiteIds)', {
        currentUserSiteIds: tenant.siteIds,
      });
      return;
    }

    if (tenant.userId) {
      query.andWhere('report.responsible_id = :currentUserId', {
        currentUserId: tenant.userId,
      });
      return;
    }

    query.andWhere('1 = 0');
  }

  private assertCanViewReport(
    report: Pick<ExpenseReport, 'site_id' | 'responsible_id'>,
    tenant: ExpenseTenantContext,
  ): void {
    if (tenant.isAdmin) {
      return;
    }

    const linkedBySite = tenant.siteIds.includes(report.site_id);
    const linkedByResponsibility = Boolean(
      tenant.userId && report.responsible_id === tenant.userId,
    );

    if (!linkedBySite && !linkedByResponsibility) {
      throw new ForbiddenException(
        'Prestação fora do escopo do usuário atual.',
      );
    }
  }

  private assertCanMutateReport(
    report: Pick<ExpenseReport, 'site_id' | 'responsible_id'>,
    tenant: ExpenseTenantContext,
  ): void {
    if (tenant.isAdmin) {
      return;
    }

    this.assertCanOwnReport(report, tenant);
  }

  private assertCanOwnReport(
    report: Pick<ExpenseReport, 'site_id' | 'responsible_id'>,
    tenant: ExpenseTenantContext,
  ): void {
    if (tenant.isAdmin) {
      return;
    }

    if (!tenant.userId || report.responsible_id !== tenant.userId) {
      throw new ForbiddenException(
        'Usuário operacional só pode alterar prestação vinculada ao próprio usuário.',
      );
    }

    if (!tenant.siteIds.includes(report.site_id)) {
      throw new ForbiddenException(
        'Usuário operacional só pode alterar despesas da própria obra.',
      );
    }
  }

  private assertAdminContext(tenant: ExpenseTenantContext): void {
    if (!tenant.isAdmin) {
      throw new ForbiddenException(
        'Somente Administrador da Empresa ou Administrador Geral pode fechar prestação de despesas.',
      );
    }
  }

  private async assertSiteBelongsToCompany(
    siteId: string,
    companyId: string,
  ): Promise<void> {
    const exists = await this.sitesRepository.exist({
      where: { id: siteId, company_id: companyId },
    });
    if (!exists) {
      throw new BadRequestException('Obra não pertence ao tenant atual.');
    }
  }

  private async assertUserBelongsToCompany(
    userId: string,
    companyId: string,
  ): Promise<void> {
    const exists = await this.usersRepository.exist({
      where: { id: userId, company_id: companyId, deletedAt: IsNull() },
    });
    if (!exists) {
      throw new BadRequestException(
        'Responsável não pertence ao tenant atual.',
      );
    }
  }

  private assertValidPeriod(start: string, end: string): void {
    if (new Date(start).getTime() > new Date(end).getTime()) {
      throw new BadRequestException(
        'A data inicial do período não pode ser maior que a data final.',
      );
    }
  }

  private assertReportOpen(report: ExpenseReport): void {
    if (report.status !== ExpenseReportStatus.ABERTA) {
      throw new BadRequestException(
        'Prestação fechada ou cancelada não pode ser alterada.',
      );
    }
  }

  private formatMoney(value: number): string {
    return value.toFixed(2);
  }

  private readFileBuffer(file: Express.Multer.File): Buffer {
    if (file.buffer?.length) {
      return file.buffer;
    }
    throw new BadRequestException('Falha ao ler o comprovante enviado.');
  }
}
