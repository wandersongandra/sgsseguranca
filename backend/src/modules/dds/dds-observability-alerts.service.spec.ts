import type { Repository } from 'typeorm';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MailService } from '../../infra/mail/mail.service';
import type { DistributedLockService } from '../../shared/redis/distributed-lock.service';
import type { TenantService } from '../../shared/tenant/tenant.service';
import type { ForensicTrailService } from '../forensic-trail/forensic-trail.service';
import type { Company } from '../companies/entities/company.entity';
import type { User } from '../users/entities/user.entity';
import type { ForensicTrailEvent } from '../forensic-trail/entities/forensic-trail-event.entity';
import type { DdsObservabilityService } from './dds-observability.service';
import { DdsObservabilityAlertsService } from './dds-observability-alerts.service';

describe('DdsObservabilityAlertsService', () => {
  beforeEach(() => {
    process.env.DDS_ALERTS_SUSPICIOUS_THRESHOLD = '5';
    process.env.DDS_ALERTS_BLOCKED_THRESHOLD = '2';
    process.env.DDS_ALERTS_PENDING_GOVERNANCE_THRESHOLD = '3';
    process.env.DDS_ALERTS_PENDING_APPROVAL_THRESHOLD = '4';
    process.env.DDS_ALERTS_DEDUPE_MINUTES = '240';
  });

  it('gera preview com alertas ativos e fila de investigação', async () => {
    let inTenantScope = false;
    const observabilityService = {
      getOverview: jest.fn().mockResolvedValue({
        tenantScope: 'tenant',
        publicValidation: {
          suspiciousLast7d: 6,
          blockedLast7d: 2,
          topDocuments: [
            {
              documentRef: 'DDS-2026-ABCD1234',
              suspicious: 3,
              blocked: 1,
              lastSeenAt: '2026-04-18T10:00:00.000Z',
            },
          ],
        },
        portfolio: { pendingGovernance: 5 },
        approvals: { pending: 4 },
      }),
    } as unknown as DdsObservabilityService;

    const companyRepository = {
      findOne: jest.fn(() => {
        expect(inTenantScope).toBe(true);
        return Promise.resolve({
          id: 'company-1',
          email_contato: 'compliance@example.com',
          alert_settings: { recipients: ['sst@example.com'] },
        });
      }),
    } as unknown as Repository<Company>;

    const getMany = jest.fn(() => {
      expect(inTenantScope).toBe(true);
      return Promise.resolve([{ id: 'user-1' }, { id: 'user-2' }]);
    });
    const userRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany,
      }),
    } as unknown as Repository<User>;
    const run = jest.fn(
      async (_context: unknown, callback: () => Promise<unknown>) => {
        inTenantScope = true;
        try {
          return await callback();
        } finally {
          inTenantScope = false;
        }
      },
    );
    const tenantService = { run } as unknown as TenantService;

    const service = new DdsObservabilityAlertsService(
      observabilityService,
      tenantService,
      { createDeduped: jest.fn() } as unknown as NotificationsService,
      { sendMailSimple: jest.fn() } as unknown as MailService,
      {
        tryAcquire: jest.fn(),
        release: jest.fn(),
      } as unknown as DistributedLockService,
      { append: jest.fn() } as unknown as ForensicTrailService,
      companyRepository,
      userRepository,
      {
        find: jest.fn().mockResolvedValue([]),
      } as unknown as Repository<ForensicTrailEvent>,
    );

    const preview = await service.getPreview('company-1');

    expect(run).toHaveBeenCalledWith(
      {
        companyId: 'company-1',
        isSuperAdmin: false,
        siteScope: 'all',
      },
      expect.any(Function),
    );
    expect(preview.recipients).toEqual({
      notificationUsers: 2,
      emailRecipients: ['sst@example.com', 'compliance@example.com'],
    });
    expect(preview.alerts.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'dds_public_suspicious_spike',
        'dds_public_blocked_spike',
        'dds_governance_backlog',
        'dds_approval_backlog',
      ]),
    );
    expect(preview.investigationQueue).toEqual([
      expect.objectContaining({ documentRef: 'DDS-2026-ABCD1234' }),
    ]);
  });

  it('dispara notificações e e-mail quando existem alertas não deduplicados', async () => {
    const observabilityService = {
      getOverview: jest.fn().mockResolvedValue({
        tenantScope: 'tenant',
        publicValidation: {
          suspiciousLast7d: 6,
          blockedLast7d: 0,
          topDocuments: [],
        },
        portfolio: { pendingGovernance: 0 },
        approvals: { pending: 0 },
      }),
    } as unknown as DdsObservabilityService;

    const notificationsService = {
      createDeduped: jest.fn().mockResolvedValue({}),
    };
    const mailService = {
      sendMailSimple: jest.fn().mockResolvedValue({}),
    };
    const forensicTrail = {
      append: jest.fn().mockResolvedValue({}),
    };
    const tenantService = {
      run: jest.fn(
        (
          _context: unknown,
          callback: () => Promise<unknown>,
        ): Promise<unknown> => callback(),
      ),
    } as unknown as TenantService;

    const service = new DdsObservabilityAlertsService(
      observabilityService,
      tenantService,
      notificationsService as unknown as NotificationsService,
      mailService as unknown as MailService,
      {
        tryAcquire: jest.fn(),
        release: jest.fn(),
      } as unknown as DistributedLockService,
      forensicTrail as unknown as ForensicTrailService,
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'company-1',
          email_contato: 'compliance@example.com',
          alert_settings: { recipients: [] },
        }),
      } as unknown as Repository<Company>,
      {
        createQueryBuilder: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
        }),
      } as unknown as Repository<User>,
      {
        find: jest.fn().mockResolvedValue([]),
      } as unknown as Repository<ForensicTrailEvent>,
    );

    await expect(service.dispatch('company-1')).resolves.toMatchObject({
      dispatched: true,
      notificationsCreated: 1,
      emailSent: true,
      alerts: [
        expect.objectContaining({ code: 'dds_public_suspicious_spike' }),
      ],
    });

    expect(notificationsService.createDeduped).toHaveBeenCalledTimes(1);
    const calls = notificationsService.createDeduped.mock
      .calls as unknown as Array<
      [
        {
          dedupeKey?: unknown;
          dedupeWindowMinutes?: unknown;
        },
      ]
    >;
    const payload = calls[0][0];
    expect(payload.dedupeKey).toEqual(
      expect.stringMatching(
        /^dds:observability:dds_public_suspicious_spike:\d+$/,
      ),
    );
    expect(payload).not.toHaveProperty('dedupeWindowMinutes');
    expect(mailService.sendMailSimple).toHaveBeenCalledTimes(1);
    expect(forensicTrail.append).toHaveBeenCalledTimes(1);
  });
});
