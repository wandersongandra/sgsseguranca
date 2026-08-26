import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Risk } from './entities/risk.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { BaseService } from '../../shared/base/base.service';
import { RiskHistory } from './entities/risk-history.entity';
import { RiskCalculationService } from '../../shared/services/risk-calculation.service';
import { RequestContext } from '../../shared/middleware/request-context.middleware';
import { AuditService } from '../audit-trail/audit.service';
import { AuditAction } from '../audit-trail/enums/audit-action.enum';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';

@Injectable()
export class RisksService extends BaseService<Risk> {
  private readonly catalogCacheTtlMs = 30 * 60 * 1000;

  constructor(
    @InjectRepository(Risk)
    private readonly risksRepository: Repository<Risk>,
    @InjectRepository(RiskHistory)
    private readonly risksHistoryRepository: Repository<RiskHistory>,
    private readonly riskCalculationService: RiskCalculationService,
    private readonly auditService: AuditService,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    tenantService: TenantService,
  ) {
    super(risksRepository, tenantService, 'Risco');
  }

  override async findAll(
    where: FindOptionsWhere<Risk> = {},
    options?: { take?: number; select?: (keyof Risk)[] },
  ): Promise<Risk[]> {
    const tenantId = this.tenantService.getTenantId();
    const hasFilters = Object.keys(where || {}).length > 0;
    if (!tenantId || hasFilters) {
      return super.findAll(where, options);
    }

    const cacheKey = this.buildCatalogCacheKey(tenantId);
    const variantKey = this.buildCatalogVariantKey(options);
    const cachedByVariant =
      await this.cacheManager.get<Record<string, Risk[]>>(cacheKey);
    const cachedVariant = cachedByVariant?.[variantKey];
    if (cachedVariant) {
      return cachedVariant;
    }

    const data = await this.risksRepository.find({
      where: { company_id: tenantId },
      ...(options?.take !== undefined ? { take: options.take } : { take: 500 }),
      ...(options?.select?.length ? { select: options.select } : {}),
      order: { nome: 'ASC' },
    });

    await this.cacheManager.set(
      cacheKey,
      {
        ...(cachedByVariant || {}),
        [variantKey]: data,
      },
      this.catalogCacheTtlMs,
    );

    return data;
  }

  override async create(data: Partial<Risk>): Promise<Risk> {
    const payload = this.normalizeRiskPayload(data);
    const created = await super.create(payload);
    await this.risksHistoryRepository.save(
      this.risksHistoryRepository.create({
        risk_id: created.id,
        changed_by: RequestContext.getUserId(),
        old_value: {},
        new_value: payload as Record<string, unknown>,
      }),
    );
    await this.auditService.log({
      userId: RequestContext.getUserId() || 'system',
      action: AuditAction.CREATE,
      entity: 'Risk',
      entityId: created.id,
      changes: { before: null, after: this.toHistorySnapshot(created) },
      ip: (RequestContext.get('ip') as string) || 'unknown',
      userAgent: RequestContext.get('userAgent') || 'unknown',
      companyId: this.getTenantId(),
    });
    await this.invalidateCatalogCache(created.company_id);
    return created;
  }

  override async update(id: string, data: Partial<Risk>): Promise<Risk> {
    const current = await this.findOne(id);
    const payload = this.normalizeRiskPayload(data);
    const updated = await super.update(id, payload);

    await this.risksHistoryRepository.save(
      this.risksHistoryRepository.create({
        risk_id: updated.id,
        changed_by: RequestContext.getUserId(),
        old_value: this.toHistorySnapshot(current),
        new_value: this.toHistorySnapshot(updated),
      }),
    );
    await this.auditService.log({
      userId: RequestContext.getUserId() || 'system',
      action: AuditAction.UPDATE,
      entity: 'Risk',
      entityId: updated.id,
      changes: {
        before: this.toHistorySnapshot(current),
        after: this.toHistorySnapshot(updated),
      },
      ip: (RequestContext.get('ip') as string) || 'unknown',
      userAgent: RequestContext.get('userAgent') || 'unknown',
      companyId: this.getTenantId(),
    });
    await this.invalidateCatalogCache(updated.company_id);

    return updated;
  }

  override async remove(id: string): Promise<void> {
    const current = await this.findOne(id);
    await super.remove(id);
    await this.invalidateCatalogCache(current.company_id);
  }

  async findPaginated(opts?: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<OffsetPage<Risk>> {
    const tenantId = this.getTenantId('findPaginated');
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const query = this.risksRepository
      .createQueryBuilder('risk')
      .orderBy('risk.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    query
      .where('risk.company_id = :tenantId', { tenantId })
      .andWhere('risk.deleted_at IS NULL');

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      const clause = `(
        LOWER(risk.nome) LIKE :search
        OR LOWER(COALESCE(risk.categoria, '')) LIKE :search
        OR LOWER(COALESCE(risk.descricao, '')) LIKE :search
      )`;
      query.andWhere(clause, { search });
    }

    const [data, total] = await query.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  private normalizeRiskPayload(data: Partial<Risk>): Partial<Risk> {
    const probability = data.probability ?? null;
    const severity = data.severity ?? null;
    const exposure = data.exposure ?? null;
    const initialRisk = this.riskCalculationService.calculateScore(
      probability,
      severity,
      exposure,
    );
    const inferredResidual =
      data.residual_risk ||
      this.riskCalculationService.classifyByScore(initialRisk) ||
      null;

    return {
      ...data,
      probability,
      severity,
      exposure,
      initial_risk: initialRisk,
      residual_risk: inferredResidual,
      control_evidence: Boolean(data.control_evidence),
    };
  }

  private toHistorySnapshot(risk: Risk): Record<string, unknown> {
    return {
      id: risk.id,
      nome: risk.nome,
      categoria: risk.categoria,
      probability: risk.probability,
      severity: risk.severity,
      exposure: risk.exposure,
      initial_risk: risk.initial_risk,
      residual_risk: risk.residual_risk,
      control_hierarchy: risk.control_hierarchy,
      evidence_photo: risk.evidence_photo,
      evidence_document: risk.evidence_document,
      control_description: risk.control_description,
      control_evidence: risk.control_evidence,
      status: risk.status,
      updated_at: risk.updated_at,
    };
  }

  private buildCatalogCacheKey(tenantId: string): string {
    return `catalog:risks:${tenantId}`;
  }

  private buildCatalogVariantKey(options?: {
    take?: number;
    select?: (keyof Risk)[];
  }): string {
    const take = options?.take ?? 500;
    const select = Array.isArray(options?.select)
      ? options.select
          .map((field) => String(field))
          .sort()
          .join(',')
      : '';
    return `take:${take}|select:${select || '*'}`;
  }

  private async invalidateCatalogCache(
    tenantId?: string | null,
  ): Promise<void> {
    if (!tenantId) {
      return;
    }
    await this.cacheManager.del(this.buildCatalogCacheKey(tenantId));
  }
}
