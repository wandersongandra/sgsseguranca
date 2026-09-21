import { buildPeriodicNotificationDedupeKey } from './notification-dedupe-key.util';

describe('buildPeriodicNotificationDedupeKey', () => {
  it('mantém a mesma identidade dentro do período e muda no próximo', () => {
    const period = 60 * 60 * 1000;
    const first = buildPeriodicNotificationDedupeKey(
      'dashboard:pending-queue:critical',
      60,
      period + 1,
    );
    const samePeriod = buildPeriodicNotificationDedupeKey(
      'dashboard:pending-queue:critical',
      60,
      period + period / 2,
    );
    const nextPeriod = buildPeriodicNotificationDedupeKey(
      'dashboard:pending-queue:critical',
      60,
      period * 2,
    );

    expect(first).toBe('dashboard:pending-queue:critical:3600000');
    expect(samePeriod).toBe(first);
    expect(nextPeriod).not.toBe(first);
  });

  it('falha para subject, período ou timestamp inválidos', () => {
    expect(() => buildPeriodicNotificationDedupeKey('', 60)).toThrow(
      'subject cannot be empty',
    );
    expect(() => buildPeriodicNotificationDedupeKey('event', 0)).toThrow(
      'period must be positive',
    );
    expect(() =>
      buildPeriodicNotificationDedupeKey('event', 60, Number.NaN),
    ).toThrow('timestamp must be finite');
  });
});
