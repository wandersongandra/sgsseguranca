import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
  Repository,
  FindOptionsWhere,
  DeepPartial,
  ObjectLiteral,
} from 'typeorm';
import { TenantService } from '../tenant/tenant.service';
import { RequestContext } from '../middleware/request-context.middleware';

type SensitiveWriteFields = {
  company_id?: unknown;
  empresa_id?: unknown;
  profile_id?: unknown;
  role?: unknown;
  roles?: unknown;
  permissions?: unknown;
  permissoes?: unknown;
};

export abstract class BaseService<T extends ObjectLiteral> {
  private readonly logger = new Logger(BaseService.name);

  constructor(
    protected readonly repository: Repository<T>,
    protected readonly tenantService: TenantService,
    protected readonly entityName: string,
  ) {}

  protected getTenantId(operation = 'tenant-scoped operation'): string {
    const tenantId = this.tenantService.getTenantId();
    if (!tenantId) {
      this.logger.warn({
        event: 'tenant_context_required',
        scope: 'TENANT_REQUIRED',
        service: this.entityName,
        operation,
        requestId: RequestContext.getRequestId() ?? null,
      });
      throw new BadRequestException(
        `Contexto de empresa não definido para ${this.entityName}.`,
      );
    }
    return tenantId;
  }

  protected applyTenantFilter(
    where: FindOptionsWhere<T> = {},
    operation = 'tenant-scoped query',
  ): FindOptionsWhere<T> {
    const tenantId = this.getTenantId(operation);

    return {
      ...where,
      company_id: tenantId,
    };
  }

  protected addDays(days: number, fromDate: Date = new Date()): Date {
    const date = new Date(fromDate);
    date.setDate(date.getDate() + days);
    return date;
  }

  private sanitizeWritePayload(data: DeepPartial<T>): DeepPartial<T> {
    const next = Object.assign(
      {} as DeepPartial<T> & SensitiveWriteFields,
      data,
    );

    delete next.company_id;
    delete next.empresa_id;
    delete next.profile_id;
    delete next.role;
    delete next.roles;
    delete next.permissions;
    delete next.permissoes;

    return next;
  }

  async findAll(
    where: FindOptionsWhere<T> = {},
    options?: { take?: number; select?: (keyof T)[] },
  ): Promise<T[]> {
    return this.repository.find({
      where: this.applyTenantFilter(where, 'findAll'),
      ...(options?.take !== undefined && { take: options.take }),
      ...(options?.select?.length && { select: options.select }),
    });
  }

  async findOne(
    id: string,
    options: { relations?: string[]; where?: FindOptionsWhere<T> } = {},
  ): Promise<T> {
    const where = this.applyTenantFilter(
      {
        ...(options.where ?? {}),
        id,
      } as unknown as FindOptionsWhere<T>,
      'findOne',
    );

    const entity = await this.repository.findOne({
      where,
      relations: options.relations,
    });

    if (!entity) {
      throw new NotFoundException(`${this.entityName} não encontrado(a).`);
    }

    return entity;
  }

  async create(data: DeepPartial<T>): Promise<T> {
    // Defesa em profundidade: nunca confiar em company_id vindo do client.
    const next = this.sanitizeWritePayload(data);

    const entity = this.repository.create({
      ...next,
      company_id: this.getTenantId('create'),
    } as DeepPartial<T> & { company_id: string });
    return this.repository.save(entity);
  }

  async update(id: string, data: DeepPartial<T>): Promise<T> {
    const entity = await this.findOne(id);

    // Bloqueio de mass assignment: impedir alteração de campos sensíveis via payload.
    const next = this.sanitizeWritePayload(data);

    this.repository.merge(entity, next);
    return this.repository.save(entity);
  }

  async remove(id: string): Promise<void> {
    // Soft delete: cadastros (máquinas, ferramentas, EPIs, riscos, ações
    // corretivas) são referenciados por junções de documentos já emitidos
    // (ex.: apr_machines/apr_tools/apr_risks/apr_epis, epi_assignments).
    // Hard delete ou é bloqueado por FK sem cascade, ou — pior — com
    // ON DELETE CASCADE apaga silenciosamente o vínculo em documentos
    // históricos de SST, corrompendo a integridade probatória.
    await this.findOne(id);
    await this.repository.softDelete(id);
  }
}
