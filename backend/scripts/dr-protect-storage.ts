import * as path from 'path';
import { DisasterRecoveryStorageProtectionService } from '../src/modules/disaster-recovery/disaster-recovery-storage-protection.service';
import { DISASTER_RECOVERY_DEFAULT_BACKUP_ROOT } from '../src/modules/disaster-recovery/disaster-recovery.constants';
import { resolveDisasterRecoveryEnvironment } from '../src/modules/disaster-recovery/disaster-recovery.util';
import {
  appendAuditLog,
  getStringArg,
  hasFlag,
  parseCliArgs,
  resolveReplicaStorageRuntimeConfig,
  runWithSuperAdminContext,
  withNestAppContext,
  writeJsonFile,
} from './disaster-recovery/common';

function resolveSourceStorageSummary(env: NodeJS.ProcessEnv): {
  mode: 'managed' | 'legacy' | 'unconfigured';
  bucketName: string | null;
  endpoint: string | null;
} {
  if (env.AWS_BUCKET_NAME) {
    return {
      mode: 'managed',
      bucketName: env.AWS_BUCKET_NAME,
      endpoint: env.AWS_ENDPOINT || null,
    };
  }

  if (env.AWS_S3_BUCKET) {
    return {
      mode: 'legacy',
      bucketName: env.AWS_S3_BUCKET,
      endpoint: env.AWS_S3_ENDPOINT || null,
    };
  }

  return {
    mode: 'unconfigured',
    bucketName: null,
    endpoint: null,
  };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const execute = hasFlag(args, 'execute');
  const dryRun = !execute || hasFlag(args, 'dry-run');
  const triggerSource = getStringArg(args, 'trigger-source') || 'manual';
  const requestedByUserId = getStringArg(args, 'requested-by-user-id');
  const companyId = getStringArg(args, 'company-id');
  const limitPerSourceValue = getStringArg(args, 'limit-per-source');
  const limitPerSource =
    limitPerSourceValue && Number.isFinite(Number(limitPerSourceValue))
      ? Number(limitPerSourceValue)
      : undefined;
  const forceReplace = hasFlag(args, 'force-replace');
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
        `storage-protection-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      ),
  );
  const auditPath = path.resolve(
    process.cwd(),
    process.env.DR_BACKUP_ROOT || DISASTER_RECOVERY_DEFAULT_BACKUP_ROOT,
    'audit',
    'storage-protection.jsonl',
  );

  if (dryRun) {
    const replicaRuntime = resolveReplicaStorageRuntimeConfig(process.env);
    const plan = {
      status: 'dry_run',
      environment,
      triggerSource,
      companyId: companyId || null,
      limitPerSource: limitPerSource ?? null,
      forceReplace,
      outputPath,
      source: resolveSourceStorageSummary(process.env),
      replica: {
        configured: replicaRuntime.configured,
        bucketName: replicaRuntime.bucketName,
        endpoint: replicaRuntime.endpoint,
        region: replicaRuntime.region,
        strategy: 'secondary_bucket_replication',
      },
      notes: [
        'Dry-run executado. Nenhum artefato foi copiado para o bucket secundário.',
        replicaRuntime.configured
          ? 'A réplica está configurada; a execução real vai depender de banco e storage principais acessíveis.'
          : 'A réplica ainda não está configurada. Defina DR_STORAGE_REPLICA_BUCKET e credenciais compatíveis para copiar os artefatos governados.',
      ],
    };

    await writeJsonFile(outputPath, plan);
    await appendAuditLog(auditPath, {
      event: 'dr_storage_protection_dry_run',
      status: 'dry_run',
      operation: 'storage_replication',
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
      const protectionService = app.get(
        DisasterRecoveryStorageProtectionService,
      );
      const report = await runWithSuperAdminContext(app, () =>
        protectionService.replicateGovernedArtifacts({
          dryRun,
          triggerSource,
          requestedByUserId,
          artifactPath: outputPath,
          companyId,
          limitPerSource,
          forceReplace,
        }),
      );

      await writeJsonFile(outputPath, report);
      await appendAuditLog(auditPath, {
        event: 'dr_storage_protection_completed',
        status: report.summary.failed > 0 ? 'partial' : 'success',
        operation: 'storage_replication',
        timestamp: new Date().toISOString(),
        metadata: {
          outputPath,
          summary: report.summary,
          source: report.source,
          replica: report.replica,
        },
      });

      console.log(JSON.stringify(report.summary, null, 2));
    },
  );
}

main().catch(async (error) => {
  const auditPath = path.resolve(
    process.cwd(),
    process.env.DR_BACKUP_ROOT || DISASTER_RECOVERY_DEFAULT_BACKUP_ROOT,
    'audit',
    'storage-protection.jsonl',
  );

  await appendAuditLog(auditPath, {
    event: 'dr_storage_protection_failed',
    status: 'failed',
    operation: 'storage_replication',
    timestamp: new Date().toISOString(),
    metadata: {
      errorMessage:
        error instanceof Error ? error.message : 'storage_protection_failed',
    },
  });

  console.error(
    '[DR][STORAGE] Falha:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
