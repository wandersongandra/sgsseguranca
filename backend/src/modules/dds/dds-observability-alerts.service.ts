import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { Company } from '../companies/entities/company.entity';
import { TenantService } from '../../shared/tenant/tenant.service';
import { User } from '../users/entities/user.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../../infra/mail/mail.service';
import {
  DistributedLockHandle,
  DistributedLockService,
} from '../../shared/redis/distributed-lock.service';
import { ForensicTrailEvent } from '../forensic-trail/entities/forensic-trail-event.entity';
import { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import {
  DdsObservabilityOverview,
  DdsObservabilityService,
} from './dds-observability.service';
import { Role } from '../auth/enums/roles.enum';
import { buildPeriodicNotificationDedupeKey } from '../notifications/notification-dedupe-key.util';

type DdsAlertCode =
  | 'dds_public_suspicious_spike'
  | 'dds_public_blocked_spike'
  | 'dds_governance_backlog'
  | 'dds_approval_backlog';

type DdsAlertPreviewItem = {
  code: DdsAlertCode;
  severity: 'warning' | 'critical';
  title: string;
  message: string;
  metric: number;
  threshold: number;
};

export type DdsObservabilityAlertsPreview = {
  generatedAt: string;
  tenantScope: 'tenant' | 'global';
  automationEnabled: boolean;
  recipients: {
    notificationUsers: number;
    emailRecipients: string[];
  };
  alerts: DdsAlertPreviewItem[];
  investigationQueue: Array<{
    documentRef: string;
    suspicious: number;
    blocked: number;
    lastSeenAt: string | null;
  }>;
};

export type DdsObservabilityAlertsDispatchResult = {
  generatedAt: string;
  tenantScope: 'tenant' | 'global';
  dispatched: boolean;
  notificationsCreated: number;
  emailSent: boolean;
  webhookSent: boolean;
  alerts: DdsAlertPreviewItem[];
};

type CompanyAlertSettings = {
  recipients?: string[];
  enabled?: boolean;
};

@Injectable()
export class DdsObservabilityAlertsService {
  private readonly logger = new Logger(DdsObservabilityAlertsService.name);

  constructor(
    private readonly observabilityService: DdsObservabilityService,
    private readonly tenantService: TenantService,
    private readonly notificationsService: NotificationsService,
    @Inject(forwardRef(() => MailService))
    private readonly mailService: MailService,
    private readonly distributedLock: DistributedLockService,
    private readonly forensicTrail: ForensicTrailService,
    @InjectRepository(Company)
    private readonly companyRepository: Repository<Company>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(ForensicTrailEvent)
    private readonly forensicEventRepository: Repository<ForensicTrailEvent>,
  ) {}

  async getPreview(
    companyId?: string | null,
  ): Promise<DdsObservabilityAlertsPreview> {
    const effectiveCompanyId = companyId ?? null;
    const { overview, company, recipients } = await this.runInTenantScope(
      effectiveCompanyId,
      async () => {
        const overview = await this.observabilityService.getOverview();
        const company = effectiveCompanyId
          ? await this.companyRepository.findOne({
              where: { id: effectiveCompanyId },
            })
          : null;
        const recipients = await this.resolveRecipients(effectiveCompanyId);

        return { overview, company, recipients };
      },
    );

    return {
      generatedAt: new Date().toISOString(),
      tenantScope: overview.tenantScope,
      automationEnabled: this.isAutomationEnabled(),
      recipients: {
        notificationUsers: recipients.notificationUserIds.length,
        emailRecipients: this.resolveEmailRecipients(company),
      },
      alerts: this.buildAlerts(overview),
      investigationQueue: overview.publicValidation.topDocuments
        .filter((item) => item.suspicious > 0 || item.blocked > 0)
        .slice(0, 5),
    };
  }

  async dispatch(
    companyId?: string | null,
  ): Promise<DdsObservabilityAlertsDispatchResult> {
    const effectiveCompanyId = companyId ?? null;
    const preview = await this.getPreview(effectiveCompanyId);
    const recipients = await this.runInTenantScope(effectiveCompanyId, () =>
      this.resolveRecipients(effectiveCompanyId),
    );
    const emailRecipients = preview.recipients.emailRecipients;
    const dedupeWindowMinutes = this.getNumberEnv(
      'DDS_ALERTS_DEDUPE_MINUTES',
      240,
    );

    const dispatchableAlerts: DdsAlertPreviewItem[] = [];
    for (const alert of preview.alerts) {
      const companyScope = effectiveCompanyId ?? recipients.companyId;
      if (
        companyScope &&
        !(await this.wasAlertDispatchedRecently(
          companyScope,
          alert.code,
          dedupeWindowMinutes,
        ))
      ) {
        dispatchableAlerts.push(alert);
      }
    }

    if (!dispatchableAlerts.length || !recipients.companyId) {
      return {
        generatedAt: new Date().toISOString(),
        tenantScope: preview.tenantScope,
        dispatched: false,
        notificationsCreated: 0,
        emailSent: false,
        webhookSent: false,
        alerts: dispatchableAlerts,
      };
    }

    let notificationsCreated = 0;
    for (const userId of recipients.notificationUserIds) {
      for (const alert of dispatchableAlerts) {
        await this.notificationsService.createDeduped({
          companyId: recipients.companyId,
          userId,
          type: alert.severity === 'critical' ? 'error' : 'warning',
          title: alert.title,
          message: alert.message,
          data: {
            route: '/dashboard/dds',
            companyId: recipients.companyId,
            category: 'dds-observability',
            alertCode: alert.code,
          },
          dedupeKey: buildPeriodicNotificationDedupeKey(
            `dds:observability:${alert.code}`,
            dedupeWindowMinutes,
          ),
        });
        notificationsCreated += 1;
      }
    }

    const emailSent = await this.sendComplianceEmail(
      recipients.companyId,
      emailRecipients,
      dispatchableAlerts,
      preview.investigationQueue,
    );
    const webhookSent = await this.sendWebhook(
      recipients.companyId,
      dispatchableAlerts,
      preview.investigationQueue,
    );

    for (const alert of dispatchableAlerts) {
      await this.forensicTrail.append({
        eventType: 'DDS_ALERT_DISPATCHED',
        module: 'dds_alerting',
        entityId: recipients.companyId,
        companyId: recipients.companyId,
        metadata: {
          alertCode: alert.code,
          severity: alert.severity,
          metric: alert.metric,
          threshold: alert.threshold,
          emailSent,
          webhookSent,
        },
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      tenantScope: preview.tenantScope,
      dispatched: true,
      notificationsCreated,
      emailSent,
      webhookSent,
      alerts: dispatchableAlerts,
    };
  }

  @Cron('*/15 * * * *')
  async runScheduledDispatch(): Promise<void> {
    if (!this.isAutomationEnabled()) {
      return;
    }

    let lock: DistributedLockHandle | null;
    try {
      lock = await this.distributedLock.tryAcquire(
        'dds:observability-alerts',
        10 * 60_000,
      );
    } catch (error) {
      this.logger.warn({
        event: 'dds_alerts_lock_error',
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!lock) {
      return;
    }

    try {
      // Enumeração cross-tenant precisa rodar como super-admin: a tabela
      // `companies` tem RLS (id = current_company() OR is_super_admin()) e este
      // cron não tem contexto de tenant — sem o wrap, a RLS retornaria 0 e os
      // alertas DDS nunca seriam despachados. O dispatch por empresa já roda no
      // contexto do tenant via runInTenantScope(companyId).
      const companies = await this.tenantService.run(
        { companyId: undefined, isSuperAdmin: true, siteScope: 'all' },
        () =>
          this.companyRepository.find({
            where: { status: true },
            select: ['id'],
          }),
      );
      for (const company of companies) {
        const companyId = typeof company.id === 'string' ? company.id : null;
        if (!companyId) {
          continue;
        }
        try {
          await this.dispatch(companyId);
        } catch (error) {
          this.logger.warn({
            event: 'dds_alerts_dispatch_failed',
            companyId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await this.distributedLock.release(lock);
    }
  }

  private buildAlerts(
    overview: DdsObservabilityOverview,
  ): DdsAlertPreviewItem[] {
    const suspiciousThreshold = this.getNumberEnv(
      'DDS_ALERTS_SUSPICIOUS_THRESHOLD',
      5,
    );
    const blockedThreshold = this.getNumberEnv(
      'DDS_ALERTS_BLOCKED_THRESHOLD',
      2,
    );
    const governanceThreshold = this.getNumberEnv(
      'DDS_ALERTS_PENDING_GOVERNANCE_THRESHOLD',
      5,
    );
    const approvalThreshold = this.getNumberEnv(
      'DDS_ALERTS_PENDING_APPROVAL_THRESHOLD',
      5,
    );

    const alerts: DdsAlertPreviewItem[] = [];
    if (overview.publicValidation.suspiciousLast7d >= suspiciousThreshold) {
      alerts.push({
        code: 'dds_public_suspicious_spike',
        severity: 'critical',
        title: 'Pico de validações públicas suspeitas no DDS',
        message: `${overview.publicValidation.suspiciousLast7d} consultas suspeitas foram registradas nos últimos 7 dias.`,
        metric: overview.publicValidation.suspiciousLast7d,
        threshold: suspiciousThreshold,
      });
    }
    if (overview.publicValidation.blockedLast7d >= blockedThreshold) {
      alerts.push({
        code: 'dds_public_blocked_spike',
        severity: 'critical',
        title: 'Bloqueios antifraude acima do limite no DDS',
        message: `${overview.publicValidation.blockedLast7d} consultas públicas foram bloqueadas pelo portal DDS.`,
        metric: overview.publicValidation.blockedLast7d,
        threshold: blockedThreshold,
      });
    }
    if (overview.portfolio.pendingGovernance >= governanceThreshold) {
      alerts.push({
        code: 'dds_governance_backlog',
        severity: 'warning',
        title: 'Backlog de governança DDS',
        message: `${overview.portfolio.pendingGovernance} DDS ainda não concluíram a emissão governada do PDF final.`,
        metric: overview.portfolio.pendingGovernance,
        threshold: governanceThreshold,
      });
    }
    if (overview.approvals.pending >= approvalThreshold) {
      alerts.push({
        code: 'dds_approval_backlog',
        severity: 'warning',
        title: 'Fluxos DDS pendentes de aprovação',
        message: `${overview.approvals.pending} DDS aguardam aprovação ou conclusão do fluxo de governança.`,
        metric: overview.approvals.pending,
        threshold: approvalThreshold,
      });
    }

    return alerts;
  }

  private async resolveRecipients(companyId?: string | null): Promise<{
    companyId: string | null;
    notificationUserIds: string[];
  }> {
    if (!companyId) {
      return {
        companyId: null,
        notificationUserIds: [],
      };
    }

    const users = await this.userRepository
      .createQueryBuilder('user')
      .leftJoin('user.profile', 'profile')
      .select(['user.id'])
      .where('user.company_id = :companyId', { companyId })
      .andWhere('user.status = :status', { status: true })
      .andWhere('user.deleted_at IS NULL')
      .andWhere('profile.nome IN (:...roles)', {
        roles: [Role.ADMIN_EMPRESA, Role.TST, Role.SUPERVISOR],
      })
      .getMany();

    return {
      companyId,
      notificationUserIds: users.map((item) => item.id),
    };
  }

  private runInTenantScope<T>(
    companyId: string | null,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (!companyId) {
      return callback();
    }

    return this.tenantService.run(
      {
        companyId,
        isSuperAdmin: false,
        siteScope: 'all',
      },
      callback,
    );
  }

  private resolveEmailRecipients(company: Company | null): string[] {
    const recipients = new Set<string>();
    const alertSettings = (company?.alert_settings ||
      {}) as CompanyAlertSettings;
    for (const recipient of alertSettings.recipients || []) {
      if (typeof recipient === 'string' && recipient.trim()) {
        recipients.add(recipient.trim().toLowerCase());
      }
    }

    if (company?.email_contato?.trim()) {
      recipients.add(company.email_contato.trim().toLowerCase());
    }

    return Array.from(recipients);
  }

  private async wasAlertDispatchedRecently(
    companyId: string,
    alertCode: DdsAlertCode,
    dedupeWindowMinutes: number,
  ): Promise<boolean> {
    const threshold = new Date(Date.now() - dedupeWindowMinutes * 60 * 1000);
    const events = await this.forensicEventRepository.find({
      where: {
        company_id: companyId,
        module: 'dds_alerting',
        event_type: 'DDS_ALERT_DISPATCHED',
        created_at: MoreThanOrEqual(threshold),
      },
      order: { created_at: 'DESC' },
      take: 20,
    });

    return events.some((event) => event.metadata?.['alertCode'] === alertCode);
  }

  private async sendComplianceEmail(
    companyId: string,
    recipients: string[],
    alerts: DdsAlertPreviewItem[],
    investigationQueue: DdsObservabilityAlertsPreview['investigationQueue'],
  ): Promise<boolean> {
    if (!recipients.length) {
      return false;
    }

    const lines = [
      'Alerta operacional DDS',
      '',
      ...alerts.map((alert) => `- ${alert.title}: ${alert.message}`),
    ];
    if (investigationQueue.length) {
      lines.push('', 'Fila de investigação sugerida:');
      lines.push(
        ...investigationQueue.map(
          (item) =>
            `- ${item.documentRef}: suspeitas=${item.suspicious}, bloqueios=${item.blocked}`,
        ),
      );
    }

    try {
      await this.mailService.sendMailSimple(
        recipients.join(','),
        'DDS • Alerta operacional de governança e antifraude',
        lines.join('\n'),
        { companyId },
      );
      return true;
    } catch (error) {
      this.logger.warn({
        event: 'dds_alert_email_failed',
        companyId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async sendWebhook(
    companyId: string,
    alerts: DdsAlertPreviewItem[],
    investigationQueue: DdsObservabilityAlertsPreview['investigationQueue'],
  ): Promise<boolean> {
    const url = String(process.env.DDS_COMPLIANCE_WEBHOOK_URL || '').trim();
    if (!url) {
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          alerts,
          investigationQueue,
        }),
        signal: controller.signal,
      });
      return response.ok;
    } catch (error) {
      this.logger.warn({
        event: 'dds_alert_webhook_failed',
        companyId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isAutomationEnabled(): boolean {
    return String(process.env.DDS_ALERTS_ENABLED || '').trim() === 'true';
  }

  private getNumberEnv(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
