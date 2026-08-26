import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { FindOptionsWhere, Repository } from 'typeorm';
import { Machine } from './entities/machine.entity';
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
export class MachinesService extends BaseService<Machine> {
  private readonly catalogCacheTtlMs = 30 * 60 * 1000;

  constructor(
    @InjectRepository(Machine)
    private readonly machinesRepository: Repository<Machine>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    tenantService: TenantService,
  ) {
    super(machinesRepository, tenantService, 'Máquina');
  }

  override async findAll(
    where: FindOptionsWhere<Machine> = {},
    options?: { take?: number; select?: (keyof Machine)[] },
  ): Promise<Machine[]> {
    const tenantId = this.tenantService.getTenantId();
    const hasFilters = Object.keys(where || {}).length > 0;
    if (!tenantId || hasFilters) {
      return super.findAll(where, options);
    }

    const cacheKey = this.buildCatalogCacheKey(tenantId);
    const variantKey = this.buildCatalogVariantKey(options);
    const cachedByVariant =
      await this.cacheManager.get<Record<string, Machine[]>>(cacheKey);
    const cachedVariant = cachedByVariant?.[variantKey];
    if (cachedVariant) {
      return cachedVariant;
    }

    const data = await this.machinesRepository.find({
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

  override async create(data: Partial<Machine>): Promise<Machine> {
    const created = await super.create(data);
    await this.invalidateCatalogCache(created.company_id);
    return created;
  }

  override async update(id: string, data: Partial<Machine>): Promise<Machine> {
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
  }): Promise<OffsetPage<Machine>> {
    const tenantId = this.getTenantId('findPaginated');
    const { page, limit, skip } = normalizeOffsetPagination(opts, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const query = this.machinesRepository
      .createQueryBuilder('machine')
      .orderBy('machine.created_at', 'DESC')
      .skip(skip)
      .take(limit);

    query
      .where('machine.company_id = :tenantId', { tenantId })
      .andWhere('machine.deleted_at IS NULL');

    const searchTerm = normalizeOptionalSearchQuery(opts?.search);
    if (searchTerm) {
      const search = `%${escapeLikePattern(searchTerm.toLowerCase())}%`;
      const clause = `(
        LOWER(machine.nome) LIKE :search ESCAPE '\\'
        OR LOWER(COALESCE(machine.placa, '')) LIKE :search ESCAPE '\\'
        OR LOWER(COALESCE(machine.descricao, '')) LIKE :search ESCAPE '\\'
      )`;
      query.andWhere(clause, { search });
    }

    const [data, total] = await query.getManyAndCount();
    return toOffsetPage(data, total, page, limit);
  }

  private buildCatalogCacheKey(tenantId: string): string {
    return `catalog:machines:${tenantId}`;
  }

  private buildCatalogVariantKey(options?: {
    take?: number;
    select?: (keyof Machine)[];
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
