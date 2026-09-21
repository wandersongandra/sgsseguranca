const MINUTES_IN_MILLISECONDS = 60 * 1000;

/**
 * Cria uma identidade de evento periódica quando o domínio já define uma
 * cadência de repetição. O período é parte da identidade, não um filtro de
 * consulta temporal, portanto a unicidade permanece garantida pelo banco.
 */
export function buildPeriodicNotificationDedupeKey(
  subject: string,
  periodMinutes: number,
  now = Date.now(),
): string {
  const normalizedSubject = subject.trim();
  if (!normalizedSubject) {
    throw new Error('Notification dedupe subject cannot be empty');
  }
  if (!Number.isFinite(periodMinutes) || periodMinutes <= 0) {
    throw new Error('Notification dedupe period must be positive');
  }
  if (!Number.isFinite(now)) {
    throw new Error('Notification dedupe timestamp must be finite');
  }

  const periodMilliseconds =
    Math.max(1, Math.floor(periodMinutes)) * MINUTES_IN_MILLISECONDS;
  const periodStart = Math.floor(now / periodMilliseconds) * periodMilliseconds;
  return `${normalizedSubject}:${periodStart}`;
}
