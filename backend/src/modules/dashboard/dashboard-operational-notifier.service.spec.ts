import { NotificationsService } from '../notifications/notifications.service';
import { DashboardOperationalNotifierService } from './dashboard-operational-notifier.service';

type DedupePayload = {
  companyId: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  dedupeKey: string;
};

describe('DashboardOperationalNotifierService', () => {
  it('fornece identidade server-generated para cada alerta deduplicado', async () => {
    const createDeduped = jest
      .fn<Promise<unknown>, [DedupePayload]>()
      .mockResolvedValue({});
    const service = new DashboardOperationalNotifierService({
      createDeduped,
    } as unknown as NotificationsService);

    await service.notifyPendingQueue({
      companyId: 'company-1',
      userId: 'user-1',
      queue: {
        degraded: true,
        failedSources: ['risks'],
        summary: {
          total: 3,
          critical: 1,
          high: 0,
          medium: 0,
          documents: 0,
          health: 0,
          actions: 0,
          slaBreached: 1,
        },
      },
    });

    expect(createDeduped).toHaveBeenCalledTimes(3);
    for (const [payload] of createDeduped.mock.calls) {
      expect(payload.dedupeKey).toMatch(
        /^dashboard:pending-queue:(degraded|sla-breached|critical):\d+$/,
      );
      expect(payload).not.toHaveProperty('dedupeWindowMinutes');
    }
  });

  it('mantém escopos distintos para degradação documental e pendência crítica', async () => {
    const createDeduped = jest
      .fn<Promise<unknown>, [DedupePayload]>()
      .mockResolvedValue({});
    const service = new DashboardOperationalNotifierService({
      createDeduped,
    } as unknown as NotificationsService);

    await service.notifyDocumentPendencies({
      companyId: 'company-1',
      userId: 'user-1',
      response: {
        degraded: true,
        failedSources: ['medical-exams'],
        summary: {
          byCriticality: { critical: 2, high: 0, medium: 0, low: 0 },
        },
      } as never,
    });

    expect(
      createDeduped.mock.calls.map(([payload]) => payload.dedupeKey),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^dashboard:document-pendencies:degraded:/),
        expect.stringMatching(/^dashboard:document-pendencies:critical:/),
      ]),
    );
  });
});
