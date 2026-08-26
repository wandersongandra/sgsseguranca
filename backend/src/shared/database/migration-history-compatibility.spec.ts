import {
  compareMigrations,
  filterPendingMigrations,
  getLegacyNamesForCanonicalName,
  isMigrationEffectivelyExecuted,
} from '../../../scripts/migration-history-compatibility';

describe('migration history compatibility', () => {
  it('treats an executed legacy identity as applied without rewriting history', () => {
    const canonicalName = 'CanonicalizeAiInteractionsUuids1709000000385';
    const legacyName = 'CanonicalizeAiInteractionsUuids1709000000182';
    const executedNames = new Set([legacyName]);

    expect(getLegacyNamesForCanonicalName(canonicalName)).toEqual([legacyName]);
    expect(isMigrationEffectivelyExecuted(canonicalName, executedNames)).toBe(
      true,
    );
  });

  it('keeps the historical order for migrations moved to unique active IDs', () => {
    const auditIndexes = {
      name: 'AprIndexesConstraintsGdprEvidence1709000000342',
    };
    const checklist = {
      name: 'AddAuditChecklistResponses1709000000386',
    };

    expect([auditIndexes, checklist].sort(compareMigrations)).toEqual([
      checklist,
      auditIndexes,
    ]);
  });

  it('does not report a canonical migration as pending when only its legacy row exists', () => {
    const migrations = [
      { name: 'AddMustChangePasswordToUsers1709000000182' },
      { name: 'CanonicalizeAiInteractionsUuids1709000000385' },
    ];
    const executedNames = new Set([
      'AddMustChangePasswordToUsers1709000000182',
      'CanonicalizeAiInteractionsUuids1709000000182',
    ]);

    expect(filterPendingMigrations(migrations, executedNames)).toEqual([]);
  });
});
