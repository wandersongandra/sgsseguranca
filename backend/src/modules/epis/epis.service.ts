import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { FindManyOptions, FindOptionsWhere, Repository } from 'typeorm';
import { Epi } from './entities/epi.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { BaseService } from '../../shared/base/base.service';
import {
  normalizeOffsetPagination,
  OffsetPage,
  toOffsetPage,
} from '../../shared/utils/offset-pagination.util';
import { normalizeOptionalSearchQuery } from '../../shared/utils/query-normalization.util';
import { escapeLikePattern } from '../../shared/utils/sql.util';

@Injectable()
export class EpisService extends BaseService<Epi> {
  private readonly catalogCacheTtlMs = 30 * 60 * 1000;

  constructor(
    @InjectRepository(Epi)
    private readonly episRepository: Repository<Epi>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    tenantService: TenantService,
  ) {
    super(episRepository, tenantService, 'EPI');
  }

  /**
   * Ponte tipada DTO → entidade.
   *
   * `CreateEpiDto.validade_ca` é `string` (validada com `@IsDateString()`, que
   * é o contrato correto para JSON) enquanto `Epi.validade_ca` é `Date`. Até
   * agora essa divergência ficava escondida atrás do `DeepPartial<T>` genérico
   * de `BaseController` — que era justamente o mecanismo que também desligava
   * a validação inteira. Com os overrides tipados no controller, a conversão
   * passa a ser explícita e verificada pelo compilador.
   */
  static toEntityPayload<T extends { validade_ca?: string }>(
    dto: T,
  ): Omit<T, 'validade_ca'> & { validade_ca?: Date } {
    const { validade_ca, ...rest } = dto;
    return {
      ...rest,
      ...(validade_ca !== undefined
        ? { validade_ca: new Date(validade_ca) }
        : {}),
    };
  }

  override async findAll(
    where: FindOptionsWhere<Epi> = {},
    options?: { take?: number; select?: (keyof Epi)[] },
  ): Promise<Epi[]> {
    const tenantId = this.tenantService.getTenantId();
    const hasFilters = Object.keys(where || {}).length > 0;
    if (!tenantId || hasFilters) {
      return super.findAll(where, options);
    }

    const cacheKey = this.buildCatalogCacheKey(tenantId);
    const variantKey = this.buildCatalogVariantKey(options);
    const cachedByVariant =
      await this.cacheManager.get<Record<string, Epi[]>>(cacheKey);
    const cachedVariant = cachedByVariant?.[variantKey];
    if (cachedVariant) {
      return cachedVariant;
    }

    const data = await this.episRepository.find({
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

  override async create(data: Partial<Epi>): Promise<Epi> {
    const created = await super.create(data);
    await this.invalidateCatalogCache(created.company_id);
    return created;
  }

  override async update(id: string, data: Partial<Epi>): Promise<Epi> {
    const updated = await super.update(id, data);
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
  }): Promise<OffsetPage<Epi>> {
    const tenantId = this.getTenantId();
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const query = this.episRepository
      .createQueryBuilder('epi')
      .orderBy('epi.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    query
      .where('epi.company_id = :tenantId', { tenantId })
      .andWhere('epi.deleted_at IS NULL');

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      const condition = `(
        LOWER(epi.nome) LIKE :search ESCAPE '\\'
        OR LOWER(COALESCE(epi.ca, '')) LIKE :search ESCAPE '\\'
      )`;
      query.andWhere(condition, { search });
    }

    const [data, total] = await query.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  async count(options?: FindManyOptions<Epi>): Promise<number> {
    const tenantId = this.tenantService.getTenantId();
    const where = options?.where ?? {};
    return this.episRepository.count({
      ...(options ?? {}),
      where: tenantId ? { ...where, company_id: tenantId } : where,
    });
  }

  async findCaExpirySummary(days = 30): Promise<{
    total: number;
    expired: number;
    expiringSoon: number;
    withoutValidity: number;
    windowDays: number;
  }> {
    const tenantId = this.tenantService.getTenantId();
    const now = new Date();
    const limitDate = new Date();
    limitDate.setDate(limitDate.getDate() + days);

    const query = this.episRepository
      .createQueryBuilder('epi')
      .where('epi.deleted_at IS NULL');
    if (tenantId) {
      query.andWhere('epi.company_id = :tenantId', { tenantId });
    }

    const epis = await query.getMany();

    const summary = epis.reduce(
      (acc, epi) => {
        acc.total += 1;

        if (!epi.validade_ca) {
          acc.withoutValidity += 1;
          return acc;
        }

        const validityDate = new Date(epi.validade_ca);
        if (Number.isNaN(validityDate.getTime())) {
          acc.withoutValidity += 1;
          return acc;
        }

        if (validityDate < now) {
          acc.expired += 1;
        } else if (validityDate <= limitDate) {
          acc.expiringSoon += 1;
        }

        return acc;
      },
      {
        total: 0,
        expired: 0,
        expiringSoon: 0,
        withoutValidity: 0,
        windowDays: days,
      },
    );

    return summary;
  }

  async dispatchExpiryNotifications(
    days: number,
  ): Promise<{ dispatched: number; timestamp: Date }> {
    const tenantId = this.tenantService.getTenantId();
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + days);

    const qb = this.episRepository
      .createQueryBuilder('epi')
      .where('epi.validade_ca BETWEEN :now AND :future', { now, future })
      .andWhere('epi.deleted_at IS NULL');

    if (tenantId) {
      qb.andWhere('epi.company_id = :tenantId', { tenantId });
    }

    const expiring = await qb.getMany();
    return {
      dispatched: expiring.length,
      timestamp: new Date(),
    };
  }
  private buildCatalogCacheKey(tenantId: string): string {
    return `catalog:epis:${tenantId}`;
  }

  private buildCatalogVariantKey(options?: {
    take?: number;
    select?: (keyof Epi)[];
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
