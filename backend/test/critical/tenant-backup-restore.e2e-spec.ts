import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Role } from '../../src/modules/auth/enums/roles.enum';
import {
  DISASTER_RECOVERY_DEFAULT_RPO_HOURS,
  DISASTER_RECOVERY_DEFAULT_RTO_HOURS,
} from '../../src/modules/disaster-recovery/disaster-recovery.constants';
import { TenantBackupService } from '../../src/modules/disaster-recovery/tenant-backup.service';
import type { TenantBackupExecutionResult } from '../../src/modules/disaster-recovery/tenant-backup.types';
import { createApr } from '../factories/apr.factory';
import { TestApp } from '../helpers/test-app';

const describeE2E =
  process.env.E2E_INFRA_AVAILABLE === 'false' ? describe.skip : describe;
const DEFAULT_PASSWORD = 'Password@123';

function buildRestorePhrase(companyId: string): string {
  return `RESTORE ${companyId}`;
}

async function issueStepUpToken(
  testApp: TestApp,
  headers: Record<string, string>,
  csrfHeaders: Record<string, string>,
  reason: 'tenant_backup' | 'tenant_restore',
): Promise<string> {
  const response = await testApp
    .request()
    .post('/auth/step-up/verify')
    .set(headers)
    .set(csrfHeaders)
    .send({
      reason,
      password: DEFAULT_PASSWORD,
    });

  expect([200, 201]).toContain(response.status);
  const body = response.body as { stepUpToken?: string };
  expect(body.stepUpToken).toBeTruthy();
  return String(body.stepUpToken);
}

describeE2E('E2E Critical - Tenant backup/restore DR', () => {
  let testApp: TestApp;
  let backupRoot: string;
  let csrfHeaders: Record<string, string>;
  let tenantBackupService: TenantBackupService;
  const previousBackupRoot = process.env.TENANT_BACKUP_ROOT;

  beforeAll(async () => {
    backupRoot = path.join(tmpdir(), 'sgs-dr-e2e', randomUUID());
    process.env.TENANT_BACKUP_ROOT = backupRoot;

    testApp = await TestApp.create();
    await testApp.resetDatabase();
    csrfHeaders = await testApp.csrfHeaders();
    tenantBackupService = testApp.app.get(TenantBackupService);
  });

  afterAll(async () => {
    if (testApp) {
      await testApp.close();
    }
    await fs.rm(backupRoot, { recursive: true, force: true });

    if (previousBackupRoot === undefined) {
      delete process.env.TENANT_BACKUP_ROOT;
    } else {
      process.env.TENANT_BACKUP_ROOT = previousBackupRoot;
    }
  });

  it('deve exportar tenant, permitir perda lógica e restaurar dados no mesmo tenant', async () => {
    const adminSession = await testApp.loginAs(Role.ADMIN_EMPRESA, 'tenantA');
    const superAdminSession = await testApp.loginAs(
      Role.SUPER_ADMIN,
      'tenantA',
    );
    const tenantA = testApp.getTenant('tenantA');
    const tecnicA = testApp.getUser('tenantA', Role.TST);

    const createdApr = await createApr(testApp, adminSession, {
      numero: 'APR-DR-001',
      titulo: 'APR DR Restore',
      siteId: tenantA.siteId,
      elaboradorId: tecnicA.id,
    });
    expect(createdApr.id).toBeTruthy();

    const consentVersionId = randomUUID();
    const userConsentId = randomUUID();
    const mappedConsentVersionId = randomUUID();
    const replacementConsentVersionId = randomUUID();
    const mappedUserConsentId = randomUUID();
    await testApp.setupQuery(
      `INSERT INTO consent_versions (
         id, type, version_label, body_md, body_hash, summary,
         effective_at, retired_at
       )
       VALUES ($1, 'marketing', $2, $3, $4, $5, NOW(), NOW())`,
      [
        consentVersionId,
        `dr-e2e-${consentVersionId}`,
        'Versão controlada para validar dependência global no restore de DR.',
        'a'.repeat(64),
        'Evidência E2E de restore privilegiado.',
      ],
    );
    await testApp.setupQuery(
      `INSERT INTO consent_versions (
         id, type, version_label, body_md, body_hash, summary,
         effective_at, retired_at
       )
       VALUES ($1, 'cookies', $2, $3, $4, $5, NOW(), NOW())`,
      [
        mappedConsentVersionId,
        `dr-e2e-${mappedConsentVersionId}`,
        'Versão controlada para validar reconciliação por chave natural.',
        'b'.repeat(64),
        'Evidência E2E de reconciliação de consentimento.',
      ],
    );
    await testApp.setupQuery(
      `INSERT INTO user_consents (
         id, user_id, company_id, type, version_id, accepted_at,
         migrated_from_legacy, notes
       )
       VALUES ($1, $2, $3, 'marketing', $4, NOW(), false, $5)`,
      [
        userConsentId,
        tecnicA.id,
        tenantA.companyId,
        consentVersionId,
        'Evidência E2E de restore privilegiado.',
      ],
    );
    await testApp.setupQuery(
      `INSERT INTO user_consents (
         id, user_id, company_id, type, version_id, accepted_at,
         migrated_from_legacy, notes
       )
       VALUES ($1, $2, $3, 'cookies', $4, NOW(), false, $5)`,
      [
        mappedUserConsentId,
        tecnicA.id,
        tenantA.companyId,
        mappedConsentVersionId,
        'Evidência E2E de reconciliação de consentimento.',
      ],
    );

    const superAdminHeaders = testApp.authHeaders(superAdminSession);
    const backupStepUpToken = await issueStepUpToken(
      testApp,
      superAdminHeaders,
      csrfHeaders,
      'tenant_backup',
    );
    const backupStartedAt = Date.now();
    const backupTriggerResponse = await testApp
      .request()
      .post(`/admin/tenants/${tenantA.companyId}/backup`)
      .set(superAdminHeaders)
      .set(csrfHeaders)
      .set('X-Step-Up-Token', backupStepUpToken);
    expect([200, 201]).toContain(backupTriggerResponse.status);

    const backupBody = backupTriggerResponse.body as
      | {
          job_id?: string;
          mode?: 'inline';
          result?: TenantBackupExecutionResult;
        }
      | undefined;
    let backupResult =
      backupBody?.mode === 'inline' ? backupBody.result : undefined;

    if (!backupResult && backupBody?.job_id) {
      backupResult = await tenantBackupService.backupTenant(tenantA.companyId, {
        triggerSource: 'manual',
        requestedByUserId: superAdminSession.userId,
      });
    }

    if (!backupResult) {
      backupResult = await tenantBackupService.backupTenant(tenantA.companyId, {
        triggerSource: 'manual',
        requestedByUserId: superAdminSession.userId,
      });
    }

    const backupDurationMs = Date.now() - backupStartedAt;
    const { backupId, filePath: backupFilePath } = backupResult;
    expect(backupId.length).toBeGreaterThan(5);
    expect(backupFilePath.length).toBeGreaterThan(10);
    expect(backupResult.rowCounts.companies).toBe(1);
    expect(backupResult.rowCounts.aprs).toBeGreaterThanOrEqual(1);
    expect(backupResult.rowCounts.users).toBeGreaterThanOrEqual(1);
    expect(backupResult.rowCounts.consent_versions).toBeGreaterThanOrEqual(1);
    expect(backupResult.rowCounts.user_consents).toBeGreaterThanOrEqual(1);
    const exportedTableNames = Object.keys(backupResult.rowCounts);
    expect(
      exportedTableNames.some((table) =>
        /^ai_interactions_(?:\d{4}_\d{2}|default)$/.test(table),
      ),
    ).toBe(false);
    expect(
      exportedTableNames.some((table) =>
        /^mail_logs_(?:\d{4}_\d{2}|default)$/.test(table),
      ),
    ).toBe(false);

    const backupFileStat = await fs.stat(backupResult.filePath);
    const metadataFileStat = await fs.stat(backupResult.metadataPath);
    expect(backupFileStat.size).toBeGreaterThan(0);
    expect(metadataFileStat.size).toBeGreaterThan(0);

    const metadataRaw = await fs.readFile(backupResult.metadataPath, 'utf8');
    const metadata = JSON.parse(metadataRaw) as {
      checksumSha256?: string;
      rowCounts?: Record<string, number>;
      schemaVersion?: string | null;
    };
    expect(metadata.checksumSha256).toBe(backupResult.checksumSha256);
    expect(metadata.rowCounts).toEqual(backupResult.rowCounts);

    if (process.env.E2E_PRESERVE_MIGRATED_SCHEMA === 'true') {
      expect(backupResult.schemaVersion).toBeTruthy();
      expect(metadata.schemaVersion).toBe(backupResult.schemaVersion);
    }

    const backupListResponse = await testApp
      .request()
      .get(`/admin/tenants/${tenantA.companyId}/backups`)
      .set(superAdminHeaders);
    expect(backupListResponse.status).toBe(200);
    const listBody = backupListResponse.body as Array<{ backupId?: string }>;
    expect(Array.isArray(listBody)).toBe(true);
    expect(listBody.some((item) => item.backupId === backupId)).toBe(true);

    const deleteResponse = await testApp
      .request()
      .delete(`/aprs/${createdApr.id}`)
      .set(testApp.authHeaders(adminSession))
      .set(csrfHeaders);
    expect(deleteResponse.status).toBe(200);

    const missingAfterDelete = await testApp
      .request()
      .get(`/aprs/${createdApr.id}`)
      .set(testApp.authHeaders(adminSession));
    expect(missingAfterDelete.status).toBe(404);

    const deletedRowsRaw: unknown = await testApp.setupQuery(
      'SELECT deleted_at FROM aprs WHERE id = $1',
      [createdApr.id],
    );
    expect(Array.isArray(deletedRowsRaw)).toBe(true);
    if (!Array.isArray(deletedRowsRaw)) {
      throw new Error('Expected query result to be an array');
    }
    const deletedRows = deletedRowsRaw as Array<{
      deleted_at?: string | null;
    }>;
    expect(deletedRows[0]?.deleted_at).toBeTruthy();

    await testApp.setupQuery(
      'DELETE FROM user_consents WHERE id = ANY($1::uuid[])',
      [[userConsentId, mappedUserConsentId]],
    );
    await testApp.setupQuery(
      'DELETE FROM consent_versions WHERE id = ANY($1::uuid[])',
      [[consentVersionId, mappedConsentVersionId]],
    );
    await testApp.setupQuery(
      `INSERT INTO consent_versions (
         id, type, version_label, body_md, body_hash, summary,
         effective_at, retired_at
       )
       VALUES ($1, 'cookies', $2, $3, $4, $5, NOW(), NOW())`,
      [
        replacementConsentVersionId,
        `dr-e2e-${mappedConsentVersionId}`,
        'Versão controlada para validar reconciliação por chave natural.',
        'b'.repeat(64),
        'Evidência E2E de reconciliação de consentimento.',
      ],
    );

    const restoreStepUpToken = await issueStepUpToken(
      testApp,
      superAdminHeaders,
      csrfHeaders,
      'tenant_restore',
    );
    const restoreStartedAt = Date.now();
    const restoreResponse = await testApp
      .request()
      .post(`/admin/tenants/${tenantA.companyId}/restore`)
      .set(superAdminHeaders)
      .set(csrfHeaders)
      .set('X-Step-Up-Token', restoreStepUpToken)
      .field('mode', 'overwrite_same_tenant')
      .field('backup_id', backupId)
      .field('confirm_company_id', tenantA.companyId)
      .field('confirm_phrase', buildRestorePhrase(tenantA.companyId))
      .attach('file', backupFilePath);
    expect([200, 201]).toContain(restoreResponse.status);
    const restoreDurationMs = Date.now() - restoreStartedAt;

    const restoreBody = restoreResponse.body as
      | {
          mode?: 'inline';
          result?: {
            targetCompanyId?: string;
            mode?: 'overwrite_same_tenant' | 'clone_to_new_tenant';
            restoredRowsByTable?: Record<string, number>;
          };
        }
      | undefined;

    expect(restoreBody?.mode).toBe('inline');
    expect(restoreBody?.result?.mode).toBe('overwrite_same_tenant');
    expect(restoreBody?.result?.targetCompanyId).toBe(tenantA.companyId);
    expect(restoreBody?.result?.restoredRowsByTable?.companies).toBe(1);
    expect(
      restoreBody?.result?.restoredRowsByTable?.aprs,
    ).toBeGreaterThanOrEqual(1);

    const restoredAprResponse = await testApp
      .request()
      .get(`/aprs/${createdApr.id}`)
      .set(testApp.authHeaders(adminSession));
    expect(restoredAprResponse.status).toBe(200);
    const restoredApr = restoredAprResponse.body as {
      id?: string;
      titulo?: string;
    };
    expect(restoredApr.id).toBe(createdApr.id);
    expect(restoredApr.titulo).toBe('APR DR Restore');

    const restoredRowsRaw: unknown = await testApp.setupQuery(
      'SELECT deleted_at FROM aprs WHERE id = $1',
      [createdApr.id],
    );
    expect(Array.isArray(restoredRowsRaw)).toBe(true);
    if (!Array.isArray(restoredRowsRaw)) {
      throw new Error('Expected query result to be an array');
    }
    const restoredRows = restoredRowsRaw as Array<{
      deleted_at?: string | null;
    }>;
    expect(restoredRows[0]?.deleted_at ?? null).toBeNull();

    const restoredConsentRows = await testApp.setupQuery<
      Array<{
        inserted_version_count: number;
        source_version_count: number;
        replacement_version_count: number;
        consent_count: number;
        remapped_consent_count: number;
      }>
    >(
      `SELECT
         (SELECT COUNT(*)::int FROM consent_versions WHERE id = $1) AS inserted_version_count,
         (SELECT COUNT(*)::int FROM consent_versions WHERE id = $2) AS source_version_count,
         (SELECT COUNT(*)::int FROM consent_versions WHERE id = $3) AS replacement_version_count,
         (SELECT COUNT(*)::int FROM user_consents WHERE id = $4 AND version_id = $1) AS consent_count,
         (SELECT COUNT(*)::int FROM user_consents WHERE id = $5 AND version_id = $3) AS remapped_consent_count`,
      [
        consentVersionId,
        mappedConsentVersionId,
        replacementConsentVersionId,
        userConsentId,
        mappedUserConsentId,
      ],
    );
    expect(restoredConsentRows[0]?.inserted_version_count).toBe(1);
    expect(restoredConsentRows[0]?.source_version_count).toBe(0);
    expect(restoredConsentRows[0]?.replacement_version_count).toBe(1);
    expect(restoredConsentRows[0]?.consent_count).toBe(1);
    expect(restoredConsentRows[0]?.remapped_consent_count).toBe(1);

    const observedBackupFreshnessMs = Math.max(
      0,
      Date.now() - Date.parse(backupResult.exportedAt),
    );
    expect(observedBackupFreshnessMs).toBeLessThanOrEqual(
      DISASTER_RECOVERY_DEFAULT_RPO_HOURS * 60 * 60 * 1000,
    );
    expect(restoreDurationMs).toBeLessThanOrEqual(
      DISASTER_RECOVERY_DEFAULT_RTO_HOURS * 60 * 60 * 1000,
    );

    const evidencePath = process.env.DR_E2E_EVIDENCE_PATH?.trim();
    if (evidencePath) {
      await fs.mkdir(path.dirname(evidencePath), { recursive: true });
      await fs.writeFile(
        evidencePath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            validationMode:
              process.env.E2E_PRESERVE_MIGRATED_SCHEMA === 'true'
                ? 'clean-migrations'
                : 'entity-synchronize',
            privilegedExportEnabled: Boolean(process.env.DATABASE_ADMIN_URL),
            backup: {
              durationMs: backupDurationMs,
              freshnessMsAtValidation: observedBackupFreshnessMs,
              fileSizeBytes: backupFileStat.size,
              metadataFileSizeBytes: metadataFileStat.size,
              schemaVersion: backupResult.schemaVersion,
              checksumSha256: backupResult.checksumSha256,
              rowCounts: backupResult.rowCounts,
            },
            restore: {
              durationMs: restoreDurationMs,
              restoredRowsByTable:
                restoreBody?.result?.restoredRowsByTable ?? {},
            },
            targets: {
              rpoHours: DISASTER_RECOVERY_DEFAULT_RPO_HOURS,
              rtoHours: DISASTER_RECOVERY_DEFAULT_RTO_HOURS,
            },
            checks: {
              backupFilesNonEmpty: true,
              metadataChecksumMatches: true,
              partitionChildrenExcluded: true,
              aprRecovered: true,
              aprSoftDeleteCleared: true,
            },
          },
          null,
          2,
        ),
        'utf8',
      );
    }
  }, 120_000);
});
