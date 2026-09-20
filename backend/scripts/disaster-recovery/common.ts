import { spawn, spawnSync, type SpawnOptions } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '../../src/shared/resilience/circuit-breaker.service';
import { IntegrationResilienceService } from '../../src/shared/resilience/integration-resilience.service';
import { RetryService } from '../../src/shared/resilience/retry.service';
import { DisasterRecoveryReplicaStorageService } from '../../src/modules/disaster-recovery/disaster-recovery-replica-storage.service';
import { resolveDrReplicaStorageConfig } from '../../src/shared/config/dr-replica-storage.config';
import { formatCommandFailure } from '../../src/modules/disaster-recovery/disaster-recovery-cli.util';

type CliArgValue = string | boolean;
export type CliArgs = Record<string, CliArgValue>;

type DatabaseRuntimeConfig =
  | {
      url: string;
      target: string;
    }
  | {
      host: string;
      port: number;
      username: string;
      password: string;
      database: string;
      target: string;
    };

type AppContextEnvOverrides = Record<string, string | undefined>;

type ReplicaStorageRuntimeConfig = {
  configured: boolean;
  bucketName: string | null;
  endpoint: string | null;
  region: string;
  forcePathStyle: boolean;
  envOverrides: NodeJS.ProcessEnv;
};

type ExecutionSummary = {
  event: string;
  status: string;
  operation: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

function sanitizeDatabaseUrlForPgCli(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete('uselibpqcompat');
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (const rawArg of argv) {
    if (!rawArg.startsWith('--')) {
      continue;
    }

    const withoutPrefix = rawArg.slice(2);
    const [key, ...rest] = withoutPrefix.split('=');
    if (!key) {
      continue;
    }

    if (rest.length === 0) {
      args[key] = true;
      continue;
    }

    args[key] = rest.join('=');
  }

  return args;
}

export function getStringArg(args: CliArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function hasFlag(args: CliArgs, key: string): boolean {
  return args[key] === true;
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeJsonFile(
  filePath: string,
  payload: unknown,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function appendAuditLog(
  filePath: string,
  payload: ExecutionSummary,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

export async function statFile(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.size;
}

export function checkCommandAvailable(command: string): boolean {
  const result =
    command === 'pg_dump'
      ? spawnSync('pg_dump', ['--version'], { stdio: 'ignore', shell: false })
      : command === 'pg_restore'
        ? spawnSync('pg_restore', ['--version'], {
            stdio: 'ignore',
            shell: false,
          })
        : command === 'node'
          ? spawnSync('node', ['--version'], {
              stdio: 'ignore',
              shell: false,
            })
          : undefined;
  if (!result) {
    return false;
  }
  return result.status === 0;
}

export async function runCommand(input: {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const options: SpawnOptions = {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    };
    const child =
      input.command === 'pg_dump'
        ? spawn('pg_dump', input.args, options)
        : input.command === 'pg_restore'
          ? spawn('pg_restore', input.args, options)
          : input.command === 'node'
            ? spawn('node', input.args, options)
            : undefined;

    if (!child) {
      reject(new Error(`Comando não permitido: ${input.command}`));
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const details = (stderr || stdout).trim();
      reject(
        new Error(
          formatCommandFailure({
            command: input.command,
            args: input.args,
            code,
            details,
          }),
        ),
      );
    });
  });
}

export function resolveDatabaseRuntimeConfig(): DatabaseRuntimeConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const runtime = require('../database-runtime.config.js') as {
    resolveDatabaseConfig: () => DatabaseRuntimeConfig;
  };

  return runtime.resolveDatabaseConfig();
}

export function buildPgEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nextEnv = { ...process.env, ...(baseEnv || {}) };
  const sslEnabled =
    /^true$/i.test(nextEnv.DATABASE_SSL || '') ||
    /^true$/i.test(nextEnv.DATABASE_SSL_ALLOW_INSECURE || '') ||
    /^true$/i.test(nextEnv.BANCO_DE_DADOS_SSL || '');

  if (sslEnabled && !nextEnv.PGSSLMODE) {
    nextEnv.PGSSLMODE = /^true$/i.test(
      nextEnv.DATABASE_SSL_ALLOW_INSECURE || '',
    )
      ? 'require'
      : 'require';
  }

  return nextEnv;
}

export function buildPgDumpArgs(
  config: DatabaseRuntimeConfig,
  outputFilePath: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  const schemas = (process.env.DR_BACKUP_SCHEMAS || 'public')
    .split(',')
    .map((schema) => schema.trim())
    .filter((schema) => schema.length > 0);

  const args = [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--enable-row-security',
    `--file=${outputFilePath}`,
    ...schemas.map((schema) => `--schema=${schema}`),
  ];

  const env = buildPgEnv();
  const basePgOptions = (env.PGOPTIONS || '').trim();
  const superAdminOption = '-c app.is_super_admin=true';
  if (!basePgOptions.includes(superAdminOption)) {
    env.PGOPTIONS = [basePgOptions, superAdminOption]
      .filter((part) => part.length > 0)
      .join(' ');
  }
  if ('url' in config) {
    args.push(`--dbname=${sanitizeDatabaseUrlForPgCli(config.url)}`);
    return { args, env };
  }

  env.PGPASSWORD = config.password;
  args.push(`--host=${config.host}`);
  args.push(`--port=${config.port}`);
  args.push(`--username=${config.username}`);
  args.push(config.database);
  return { args, env };
}

export function buildPgRestoreArgs(
  backupFilePath: string,
  targetDatabaseUrl: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      `--dbname=${sanitizeDatabaseUrlForPgCli(targetDatabaseUrl)}`,
      backupFilePath,
    ],
    env: buildPgEnv(),
  };
}

export async function withTemporaryEnv<T>(
  overrides: AppContextEnvOverrides,
  fn: () => Promise<T>,
): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key]);
    if (typeof value === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function withNestAppContext<T>(
  overrides: AppContextEnvOverrides,
  fn: (app: import('@nestjs/common').INestApplicationContext) => Promise<T>,
): Promise<T> {
  return withTemporaryEnv(overrides, async () => {
    const [{ NestFactory }, { AppModule }] = await Promise.all([
      import('@nestjs/core'),
      import('../../src/app.module'),
    ]);

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });

    try {
      return await fn(app);
    } finally {
      await app.close();
    }
  });
}

export async function runWithSuperAdminContext<T>(
  app: import('@nestjs/common').INestApplicationContext,
  fn: () => Promise<T>,
): Promise<T> {
  const { TenantService } =
    await import('../../src/shared/tenant/tenant.service');
  const tenantService = app.get(TenantService);
  return await tenantService.run(
    { companyId: undefined, isSuperAdmin: true },
    fn,
  );
}

export function resolveReplicaStorageRuntimeConfig(
  baseEnv: NodeJS.ProcessEnv = process.env,
): ReplicaStorageRuntimeConfig {
  const replica = resolveDrReplicaStorageConfig((key) => baseEnv[key]);

  return {
    configured: replica.configured,
    bucketName: replica.bucketName,
    endpoint: replica.endpoint,
    region: replica.region,
    forcePathStyle: replica.forcePathStyle,
    envOverrides: {
      ...baseEnv,
      AWS_BUCKET_NAME: replica.bucketName || undefined,
      AWS_S3_BUCKET: undefined,
      AWS_ENDPOINT: replica.endpoint || undefined,
      AWS_S3_ENDPOINT: undefined,
      AWS_REGION: replica.region,
      AWS_ACCESS_KEY_ID: replica.accessKeyId || undefined,
      AWS_SECRET_ACCESS_KEY: replica.secretAccessKey || undefined,
      S3_FORCE_PATH_STYLE: replica.forcePathStyle ? 'true' : 'false',
    },
  };
}

export function createStandaloneReplicaStorageService(
  baseEnv: NodeJS.ProcessEnv = process.env,
): DisasterRecoveryReplicaStorageService {
  const configService = new ConfigService(baseEnv);
  const integration = new IntegrationResilienceService(
    configService,
    new CircuitBreakerService(),
    new RetryService(),
  );

  return new DisasterRecoveryReplicaStorageService(configService, integration);
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code !== 'ENOENT') {
      throw error;
    }
  }
}
