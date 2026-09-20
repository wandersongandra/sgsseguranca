import {
  compareMigrations,
  filterPendingMigrations,
  getLegacyNamesForCanonicalName,
  isMigrationEffectivelyExecuted,
} from '../../../scripts/migration-history-compatibility';
import {
  readCompatibilityManifest,
  readMigrationManifest,
} from '../../../scripts/migration-manifest';
import sanitizedLedger from '../../../test/fixtures/migration-history-sanitized.json';

describe('migration history compatibility', () => {
  const canonicalNames = readMigrationManifest().entries.map(
    (migration) => migration.name,
  );
  const canonicalNameSet = new Set(canonicalNames);
  const compatibility = readCompatibilityManifest();
  const executedNames = new Set(sanitizedLedger.rows.map((row) => row.name));

  it('preserves the proven aliases and validates every target', () => {
    expect(readMigrationManifest().issues).toEqual([]);
    expect(compatibility.aliases).toMatchObject({
      CanonicalizeAiInteractionsUuids1709000000182:
        'CanonicalizeAiInteractionsUuids1709000000385',
      AddAuditChecklistResponses1709000000342:
        'AddAuditChecklistResponses1709000000386',
      CreateInspectionsTable1709000000378:
        'CreateInspectionsTable1709000000387',
      GrantForensicTrailToSgsAdmin1709000000379:
        'GrantForensicTrailToSgsAdmin1709000000388',
      GrantTenantValidationToSgsAdmin1709000000380:
        'GrantTenantValidationToSgsAdmin1709000000389',
    });

    expect(Object.keys(compatibility.aliases)).toHaveLength(23);
    expect(
      Object.entries(compatibility.aliases).every(
        ([legacyName, canonicalName]) =>
          legacyName.length > 0 &&
          canonicalName.length > 0 &&
          legacyName !== canonicalName &&
          canonicalNameSet.has(canonicalName),
      ),
    ).toBe(true);
    expect(new Set(Object.keys(compatibility.aliases)).size).toBe(
      Object.keys(compatibility.aliases).length,
    );
  });

  it('keeps historical ordering unchanged', () => {
    expect(Object.keys(compatibility.order)).toHaveLength(10);

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

  it('reconciles the sanitized historical ledger without unknown drift', () => {
    const unknownDrift = sanitizedLedger.rows
      .map((row) => row.name)
      .filter(
        (name) =>
          !canonicalNameSet.has(name) &&
          !Object.prototype.hasOwnProperty.call(compatibility.aliases, name),
      );

    expect(sanitizedLedger.rows).toHaveLength(328);
    expect(new Set(sanitizedLedger.rows.map((row) => row.name)).size).toBe(326);
    expect(
      sanitizedLedger.rows.filter(
        (row) => row.name === 'AddCompanyContactEmail1709000000078',
      ),
    ).toHaveLength(2);
    expect(
      sanitizedLedger.rows.filter(
        (row) => row.name === 'AddRestrictiveRlsCriticalTables1709000000079',
      ),
    ).toHaveLength(2);
    expect(unknownDrift).toEqual([]);
  });

  it('reports only the post-cutover migrations as pending', () => {
    const pending = filterPendingMigrations(
      readMigrationManifest().entries,
      executedNames,
    ).map((migration) => migration.name);

    expect(pending).toHaveLength(15);
    expect(pending).toEqual([
      'CreateDurableIdempotencyRecords1709000000391',
      'HardenSecurityDefinerFunctions1709000000392',
      'TightenRuntimeFunctionGrants1709000000393',
      'HardenMaterializedViewRuntimeAccess1709000000394',
      'HardenPhotographicReportRlsRoleGate1709000000395',
      'CreatePublicAprEvidenceVerifyFunction1709000000396',
      'RemoveMutableSuperAdminPolicyAuthority1709000000397',
      'RestrictRuntimeDatabasePrivileges1709000000398',
      'HardenDurableIdempotencyRls1709000000399',
      'RemoveNeonSampleTable1709000000400',
      'HardenRuntimePgStatStatementsAccess1709000000401',
      'AddSignatureKeyVersioning1709000000402',
      'DropRedundantAprCompositeIndexes1709000000403',
      'AddMissingAprWorkflowForeignKeys1709000000404',
      'HardenSiteScopeFailClosed1709000000405',
    ]);
  });

  it('supports the 0383 double-satisfaction relationship', () => {
    const legacy0383 = 'AddPublicSignatureVerifyFunction1709000000383';
    const canonical0383 = 'AddPublicSignatureVerifyFunction1709000000383';
    const canonical0390 = 'FixPublicSignatureVerifyTimestamp1709000000390';

    expect(
      isMigrationEffectivelyExecuted(canonical0383, new Set([legacy0383])),
    ).toBe(true);
    expect(
      isMigrationEffectivelyExecuted(canonical0390, new Set([legacy0383])),
    ).toBe(true);
    expect(getLegacyNamesForCanonicalName(canonical0390)).toEqual([legacy0383]);
  });

  it('does not report a canonical migration as pending when its legacy row exists', () => {
    const migrations = [
      { name: 'AddMustChangePasswordToUsers1709000000182' },
      { name: 'CanonicalizeAiInteractionsUuids1709000000385' },
    ];
    const names = new Set([
      'AddMustChangePasswordToUsers1709000000182',
      'CanonicalizeAiInteractionsUuids1709000000182',
    ]);

    expect(filterPendingMigrations(migrations, names)).toEqual([]);
  });
});
