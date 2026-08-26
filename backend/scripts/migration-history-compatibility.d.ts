export interface MigrationHistoryEntry {
  name?: string;
  transaction?: boolean;
  up?: (queryRunner: unknown) => Promise<void>;
  constructor?: { name?: string };
}

export function compareMigrations(
  left: MigrationHistoryEntry,
  right: MigrationHistoryEntry,
): number;
export function filterPendingMigrations(
  migrations: MigrationHistoryEntry[],
  executedNames: Set<string>,
): MigrationHistoryEntry[];
export function getLegacyNamesForCanonicalName(canonicalName: string): string[];
export function isMigrationEffectivelyExecuted(
  migrationOrName: MigrationHistoryEntry | string,
  executedNames: Set<string>,
): boolean;
