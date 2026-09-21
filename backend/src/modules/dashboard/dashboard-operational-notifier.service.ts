import { Injectable } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { buildPeriodicNotificationDedupeKey } from '../notifications/notification-dedupe-key.util';
import { DashboardDocumentPendenciesResponse } from './dashboard-document-pendency.types';

type PendingQueuePayload = {
  userId?: string;
  companyId?: string;
  queue: {
    degraded?: boolean;
    failedSources?: string[];
    summary: {
      total: number;
      critical: number;
      high: number;
      medium: number;
      documents: number;
      health: number;
      actions: number;
      slaBreached?: number;
      slaDueToday?: number;
      slaDueSoon?: number;
    };
  };
};

@Injectable()
export class DashboardOperationalNotifierService {
  constructor(private readonly notificationsService: NotificationsService) {}

  async notifyPendingQueue(input: PendingQueuePayload): Promise<void> {
    if (!input.userId || !input.companyId) {
      return;
    }

    if (input.queue.degraded) {
      await this.notificationsService.createDeduped({
        companyId: input.companyId,
        userId: input.userId,
        type: 'error',
        title: 'Fila operacional carregada com ressalvas',
        message: `Algumas fontes da fila operacional falharam: ${(input.queue.failedSources || []).join(', ')}.`,
        data: {
          route: '/dashboard',
          companyId: input.companyId,
          category: 'pending-queue',
        },
        dedupeKey: buildPeriodicNotificationDedupeKey(
          'dashboard:pending-queue:degraded',
          180,
        ),
      });
    }

    if ((input.queue.summary.slaBreached || 0) > 0) {
      await this.notificationsService.createDeduped({
        companyId: input.companyId,
        userId: input.userId,
        type: 'warning',
        title: 'Pendências com SLA estourado',
        message: `${input.queue.summary.slaBreached} item(ns) da fila operacional estão com SLA vencido e exigem priorização imediata.`,
        data: {
          route: '/dashboard',
          companyId: input.companyId,
          category: 'pending-queue',
        },
        dedupeKey: buildPeriodicNotificationDedupeKey(
          'dashboard:pending-queue:sla-breached',
          240,
        ),
      });
    }

    if (input.queue.summary.critical > 0) {
      await this.notificationsService.createDeduped({
        companyId: input.companyId,
        userId: input.userId,
        type: 'warning',
        title: 'Itens críticos na fila operacional',
        message: `${input.queue.summary.critical} item(ns) críticos estão bloqueando a operação e precisam de ação rápida.`,
        data: {
          route: '/dashboard',
          companyId: input.companyId,
          category: 'pending-queue',
        },
        dedupeKey: buildPeriodicNotificationDedupeKey(
          'dashboard:pending-queue:critical',
          240,
        ),
      });
    }
  }

  async notifyDocumentPendencies(input: {
    userId?: string;
    companyId?: string;
    response: DashboardDocumentPendenciesResponse;
  }): Promise<void> {
    if (!input.userId || !input.companyId) {
      return;
    }

    if (input.response.degraded) {
      await this.notificationsService.createDeduped({
        companyId: input.companyId,
        userId: input.userId,
        type: 'error',
        title: 'Central documental com fontes degradadas',
        message: `A central documental foi carregada com falhas em: ${input.response.failedSources.join(', ')}.`,
        data: {
          route: '/dashboard/document-pendencies',
          companyId: input.companyId,
          category: 'document-pendencies',
        },
        dedupeKey: buildPeriodicNotificationDedupeKey(
          'dashboard:document-pendencies:degraded',
          180,
        ),
      });
    }

    if ((input.response.summary.byCriticality.critical || 0) > 0) {
      await this.notificationsService.createDeduped({
        companyId: input.companyId,
        userId: input.userId,
        type: 'warning',
        title: 'Pendências documentais críticas',
        message: `${input.response.summary.byCriticality.critical} pendência(s) críticas estão impedindo fechamento documental ou conformidade imediata.`,
        data: {
          route: '/dashboard/document-pendencies',
          companyId: input.companyId,
          category: 'document-pendencies',
        },
        dedupeKey: buildPeriodicNotificationDedupeKey(
          'dashboard:document-pendencies:critical',
          240,
        ),
      });
    }
  }
}
