import { notificationBelongsToTenant, prependUniqueNotification } from './useRealtimeNotifications';
import type { AppNotification } from '@/services/notificationsService';

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'notification-1',
    company_id: 'tenant-a',
    type: 'info',
    title: 'Aviso',
    message: 'Mensagem',
    read: false,
    createdAt: '2026-09-02T12:00:00.000Z',
    ...overrides,
  };
}

describe('realtime notification tenant boundary', () => {
  it('accepts only notifications for the active tenant', () => {
    const current = notification();

    expect(notificationBelongsToTenant(current, 'tenant-a')).toBe(true);
    expect(notificationBelongsToTenant(current, 'tenant-b')).toBe(false);
    expect(notificationBelongsToTenant(current, null)).toBe(false);
    expect(notificationBelongsToTenant(notification({ company_id: undefined }), 'tenant-a')).toBe(
      false,
    );
  });

  it('does not increment state twice when polling and websocket race', () => {
    const current = [notification()];
    const duplicate = notification();
    const incoming = notification({ id: 'notification-2' });

    expect(prependUniqueNotification(current, duplicate)).toBe(current);
    expect(prependUniqueNotification(current, incoming)).toEqual([incoming, ...current]);
  });
});
