import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationsGateway } from './notifications.gateway';
import { TenantService } from '../../shared/tenant/tenant.service';
import { normalizeOffsetPagination } from '../../shared/utils/offset-pagination.util';
import { User } from '../users/entities/user.entity';
import { Role } from '../auth/enums/roles.enum';
import { normalizeRoleName } from '../auth/role-normalization.util';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private static readonly DEDUPE_KEY_MAX_LENGTH = 255;

  private toGatewayPayload(
    notification: Notification,
  ): Record<string, unknown> {
    return {
      id: notification.id,
      company_id: notification.company_id,
      userId: notification.userId,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      read: notification.read,
      createdAt: notification.createdAt,
      readAt: notification.readAt,
    };
  }

  constructor(
    @InjectRepository(Notification)
    private repo: Repository<Notification>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private gateway: NotificationsGateway,
    private readonly tenantService: TenantService,
  ) {}

  async create(data: {
    companyId: string;
    userId: string;
    type: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
  }) {
    const notification = await this.tenantService.run(
      {
        companyId: data.companyId,
        isSuperAdmin: false,
        userId: data.userId,
        siteScope: 'all',
      },
      () =>
        this.repo.save({
          company_id: data.companyId,
          userId: data.userId,
          type: data.type,
          title: data.title,
          message: data.message,
          data: data.data,
        }),
    );

    this.sendRealtime(notification, data.type);

    return notification;
  }

  /**
   * Notifica usuários elegíveis a decidir a próxima etapa de um fluxo de
   * aprovação (APR, DDS, etc.): usuários com o papel exigido pela etapa mais
   * ADMIN_GERAL (que pode aprovar qualquer etapa). Best-effort — erros de
   * notificação individual ou da consulta nunca propagam para o chamador.
   */
  async notifyEligibleApprovers(params: {
    companyId: string;
    requiredRoleRaw?: string | null;
    title: string;
    message: string;
    data?: Record<string, unknown>;
    logContext: string;
  }): Promise<void> {
    try {
      const requiredRole = normalizeRoleName(
        params.requiredRoleRaw ?? undefined,
      );
      if (!requiredRole) {
        this.logger.warn(
          `notifyEligibleApprovers[${params.logContext}]: approver_role "${params.requiredRoleRaw}" não reconhecido — notificando apenas ADMIN_GERAL.`,
        );
      }

      const eligible = await this.userRepository
        .createQueryBuilder('u')
        .innerJoin('u.profile', 'p')
        .where('u.company_id = :companyId', { companyId: params.companyId })
        .andWhere('u.deleted_at IS NULL')
        .andWhere('p.nome IN (:...roles)', {
          roles: [requiredRole, Role.ADMIN_GERAL].filter(
            (r): r is Role => r !== null,
          ),
        })
        .getMany();

      await Promise.all(
        eligible.map((u) =>
          this.create({
            companyId: params.companyId,
            userId: u.id,
            type: 'info',
            title: params.title,
            message: params.message,
            data: params.data,
          }).catch((err: unknown) =>
            this.logger.warn(
              `Falha ao notificar usuário ${u.id} sobre ${params.logContext}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
        ),
      );
    } catch (err) {
      this.logger.warn(
        `notifyEligibleApprovers[${params.logContext}] falhou: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async createDeduped(data: {
    companyId: string;
    userId: string;
    type: string;
    title: string;
    message: string;
    data?: Record<string, unknown>;
    dedupeKey: string;
  }): Promise<Notification> {
    const dedupeKey = this.normalizeDedupeKey(data.dedupeKey);
    const result = await this.tenantService.run(
      {
        companyId: data.companyId,
        isSuperAdmin: false,
        userId: data.userId,
        siteScope: 'all',
      },
      async () => {
        const insertResult = (await this.repo
          .createQueryBuilder()
          .insert()
          .into(Notification)
          .values({
            company_id: data.companyId,
            userId: data.userId,
            type: data.type,
            title: data.title,
            message: data.message,
            data: data.data as
              QueryDeepPartialEntity<Record<string, unknown>> | undefined,
            dedupeKey,
          })
          .onConflict(
            '("company_id", "userId", "dedupe_key") WHERE "dedupe_key" IS NOT NULL AND "deleted_at" IS NULL DO NOTHING',
          )
          .returning(['id'])
          .execute()) as unknown as {
          identifiers?: Array<Record<string, unknown>>;
          raw?: unknown;
        };

        const insertedId = this.readInsertedId(insertResult);
        if (insertedId) {
          const notification = await this.repo.findOne({
            where: {
              id: insertedId,
              company_id: data.companyId,
              userId: data.userId,
            },
          });
          if (!notification) {
            throw new Error(
              'Notification insert returned an id that could not be read back',
            );
          }
          return { notification, created: true };
        }

        const existing = await this.repo.findOne({
          where: {
            company_id: data.companyId,
            userId: data.userId,
            dedupeKey,
          },
        });
        if (!existing) {
          throw new Error(
            'Notification dedupe conflict did not resolve to an existing row',
          );
        }
        return { notification: existing, created: false };
      },
    );

    if (result.created) {
      this.sendRealtime(result.notification, data.type);
    }
    return result.notification;
  }

  private normalizeDedupeKey(value: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error('Notification dedupe key cannot be empty');
    }
    if (normalized.length > NotificationsService.DEDUPE_KEY_MAX_LENGTH) {
      throw new Error('Notification dedupe key exceeds 255 characters');
    }
    if (
      [...normalized].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw new Error('Notification dedupe key contains control characters');
    }
    return normalized;
  }

  private readInsertedId(result: {
    identifiers?: Array<Record<string, unknown>>;
    raw?: unknown;
  }): string | undefined {
    const identifier = result.identifiers?.[0]?.['id'];
    if (typeof identifier === 'string' && identifier) {
      return identifier;
    }
    const rawValues: unknown[] = Array.isArray(result.raw) ? result.raw : [];
    const raw = rawValues[0];
    const rawId =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>)['id']
        : undefined;
    return typeof rawId === 'string' && rawId ? rawId : undefined;
  }

  private sendRealtime(notification: Notification, type: string): void {
    try {
      this.gateway.sendToUser(
        notification.userId,
        'notification',
        this.toGatewayPayload(notification),
      );
    } catch (error) {
      this.logger.warn({
        event: 'notification_realtime_delivery_failed',
        userId: notification.userId,
        notificationId: notification.id,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async markAsRead(id: string, userId: string, companyId: string) {
    await this.tenantService.run(
      { companyId, isSuperAdmin: false, userId, siteScope: 'all' },
      () =>
        this.repo.update(
          { id, userId, company_id: companyId },
          { read: true, readAt: new Date() },
        ),
    );
    return { success: true };
  }

  async markAllAsRead(userId: string, companyId: string) {
    await this.tenantService.run(
      { companyId, isSuperAdmin: false, userId, siteScope: 'all' },
      () =>
        this.repo.update(
          { userId, company_id: companyId, read: false },
          { read: true, readAt: new Date() },
        ),
    );
    return { success: true };
  }

  async getUnreadCount(userId: string, companyId: string): Promise<number> {
    return this.tenantService.run(
      { companyId, isSuperAdmin: false, userId, siteScope: 'all' },
      () =>
        this.repo.count({
          where: { userId, company_id: companyId, read: false },
        }),
    );
  }

  async findAll(userId: string, companyId: string, page = 1, limit = 20) {
    const {
      page: safePage,
      limit: safeLimit,
      skip,
    } = normalizeOffsetPagination(
      { page, limit },
      { defaultLimit: 20, maxLimit: 100 },
    );
    const [items, total] = await this.tenantService.run(
      { companyId, isSuperAdmin: false, userId, siteScope: 'all' },
      () =>
        this.repo.findAndCount({
          where: { userId, company_id: companyId },
          order: { createdAt: 'DESC' },
          skip,
          take: safeLimit,
        }),
    );

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }
}
