import * as path from 'path';
import { DisasterRecoveryExecutionService } from '../src/modules/disaster-recovery/disaster-recovery-execution.service';
import { DisasterRecoveryIntegrityService } from '../src/modules/disaster-recovery/disaster-recovery-integrity.service';
import { DISASTER_RECOVERY_DEFAULT_BACKUP_ROOT } from '../src/modules/disaster-recovery/disaster-recovery.constants';
import { resolveDisasterRecoveryEnvironment } from '../src/modules/disaster-recovery/disaster-recovery.util';
import {
  appendAuditLog,
  getStringArg,
  hasFlag,
  parseCliArgs,
  runWithSuperAdminContext,
  withNestAppContext,
  writeJsonFile,
} from './disaster-recovery/common';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = hasFlag(args, 'dry-run');
  const verifyHashes = hasFlag(args, 'verify-hashes');
  const includeOrphans = hasFlag(args, 'include-orphans');
  const limitPerSourceValue = getStringArg(args, 'limit-per-source');
  const limitPerSource =
    limitPerSourceValue && Number.isFinite(Number(limitPerSourceValue))
      ? Number(limitPerSourceValue)
      : undefined;
  const triggerSource = getStringArg(args, 'trigger-source') || 'manual';
  const requestedByUserId = getStringArg(args, 'requested-by-user-id');
  const companyId = getStringArg(args, 'company-id');
  const environment = resolveDisasterRecoveryEnvironment(
    getStringArg(args, 'environment') || process.env.DR_ENVIRONMENT_NAME,
    process.env.NODE_ENV,
  );
  const outputPath = path.resolve(
    process.cwd(),
    getStringArg(args, 'output') ||
      path.join(
        process.env.DR_BACKUP_ROOT || DISASTER_RECOVERY_DEFAULT_BACKUP_ROOT,
        'reports',
        environment,
        `integrity-scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      ),
  );
  const auditPath = path.resolve(
    process.cwd(),
    process.env.DR_BACKUP_ROOT || DISASTER_RECOVERY_DEFAULT_BACKUP_ROOT,
    'audit',
    'integrity-scan.jsonl',
  );

  if (dryRun) {
    const plan = {
      status: 'dry_run',
      environment,
      companyId: companyId || null,
      verifyHashes,
      includeOrphans,
      limitPerSource: limitPerSource ?? null,
      outputPath,
      notes: [
        'Dry-run executado. Nenhuma consulta ao banco/storage foi realizada.',
        'Para validação pós-restore real, execute sem --dry-run apontando o ambiente para o banco restaurado.',
      ],
    };
    await writeJsonFile(outputPath, plan);
    await appendAuditLog(auditPath, {
      event: 'dr_integrity_scan_dry_run',
      status: 'dry_run',
      operation: 'integrity_scan',
      timestamp: new Date().toISOString(),
      metadata: plan,
    });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  await withNestAppContext(
    {
      REDIS_DISABLED: process.env.REDIS_DISABLED || 'true',
      API_CRONS_DISABLED: process.env.API_CRONS_DISABLED || 'true',
    },
    async (app) => {
      const executionService = app.get(DisasterRecoveryExecutionService);
      const integrityService = app.get(DisasterRecoveryIntegrityService);

      const execution = await runWithSuperAdminContext(app, async () =>
        executionService.startExecution({
          operationType: 'integrity_scan',
          scope: includeOrphans ? 'storage' : 'system',
          environment,
          triggerSource,
          requestedByUserId,
          artifactPath: outputPath,
          metadata: {
            companyId: companyId || null,
            verifyHashes,
            includeOrphans,
            limitPerSource: limitPerSource ?? null,
          },
        }),
      );

      try {
        const report = await runWithSuperAdminContext(app, () =>
          integrityService.scan({
            companyId,
            verifyHashes,
            includeOrphans,
            limitPerSource,
          }),
        );

        await writeJsonFile(outputPath, report);
        await runWithSuperAdminContext(app, async () =>
          executionService.finalizeExecution(execution.id, {
            status:
              report.summary.criticalIssues > 0 || report.summary.highIssues > 0
                ? 'partial'
                : 'success',
            artifactPath: outputPath,
            metadata: {
              summary: report.summary,
            },
          }),
        );

        await appendAuditLog(auditPath, {
          event: 'dr_integrity_scan_completed',
          status:
            report.summary.criticalIssues > 0 || report.summary.highIssues > 0
              ? 'partial'
              : 'success',
          operation: 'integrity_scan',
          timestamp: new Date().toISOString(),
          metadata: {
            outputPath,
            summary: report.summary,
          },
        });

        console.log(JSON.stringify(report.summary, null, 2));
      } catch (error) {
        await runWithSuperAdminContext(app, async () =>
          executionService.finalizeExecution(execution.id, {
            status: 'failed',
            artifactPath: outputPath,
            errorMessage:
              error instanceof Error ? error.message : 'integrity_scan_failed',
          }),
        );
        await appendAuditLog(auditPath, {
          event: 'dr_integrity_scan_failed',
          status: 'failed',
          operation: 'integrity_scan',
          timestamp: new Date().toISOString(),
          metadata: {
            outputPath,
            errorMessage: error instanceof Error ? error.message : 'unknown',
          },
        });
        throw error;
      }
    },
  );
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      '[DR][SCAN] Falha:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
