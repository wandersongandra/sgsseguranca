export type NonConformityDateInput = Date | string | null | undefined;

export type CivilDocumentDate = {
  year: number;
  month: number;
  day: number;
};

export type CivilDocumentCalendar = CivilDocumentDate & {
  isoWeek: number;
  isoWeekYear: number;
};

function isValidCivilDate(value: CivilDocumentDate): boolean {
  const candidate = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return (
    candidate.getUTCFullYear() === value.year &&
    candidate.getUTCMonth() === value.month - 1 &&
    candidate.getUTCDate() === value.day
  );
}

function toCivilDateFromUtc(date: Date): CivilDocumentDate {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * Converte uma coluna PostgreSQL `date` para seus componentes civis. Datas
 * sem horário são deliberadamente lidas em UTC: `2026-03-10` deve permanecer
 * 10/03 em qualquer fuso do processo Node.
 */
export function parseNonConformityCivilDate(
  input: NonConformityDateInput,
): CivilDocumentDate | null {
  if (!input) {
    return null;
  }

  if (typeof input === 'string') {
    const dateOnly = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      const result: CivilDocumentDate = {
        year: Number(dateOnly[1]),
        month: Number(dateOnly[2]),
        day: Number(dateOnly[3]),
      };
      return isValidCivilDate(result) ? result : null;
    }
  }

  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return toCivilDateFromUtc(parsed);
}

/**
 * Converte um timestamp para a data de operação. Diferente de uma coluna
 * `date`, timestamps devem respeitar o fuso de negócio para não trocar a data
 * de encerramento perto da meia-noite UTC.
 */
export function parseNonConformityTimestampDate(
  input: NonConformityDateInput,
  timeZone: string,
): CivilDocumentDate | null {
  if (!input) {
    return null;
  }

  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(parsed);
    const lookup = new Map(parts.map((part) => [part.type, part.value]));
    const result: CivilDocumentDate = {
      year: Number(lookup.get('year')),
      month: Number(lookup.get('month')),
      day: Number(lookup.get('day')),
    };
    return isValidCivilDate(result) ? result : null;
  } catch {
    return null;
  }
}

export function getNonConformityCivilCalendar(
  date: CivilDocumentDate,
): CivilDocumentCalendar {
  const target = new Date(Date.UTC(date.year, date.month - 1, date.day));
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const isoWeekYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoWeekYear, 0, 1));
  const isoWeek = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );

  return {
    ...date,
    isoWeek,
    isoWeekYear,
  };
}

export function formatNonConformityCivilDate(
  date: CivilDocumentDate | null,
  fallback = '-',
): string {
  if (!date) {
    return fallback;
  }

  return [
    String(date.day).padStart(2, '0'),
    String(date.month).padStart(2, '0'),
    String(date.year),
  ].join('/');
}
