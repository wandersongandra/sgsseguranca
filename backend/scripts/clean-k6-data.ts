/**
 * Limpeza de dados de teste de carga k6.
 *
 * O seed atual identifica ownership por uma dupla estável: empresas com
 * prefixo K6_ e um usuário de fixture com e-mail k6.*@test.local. A mutação
 * exige, além disso, target explícito, autorização ambiental e confirmação.
 *
 * Uso seguro:
 *   DATABASE_URL=... APP_ENV=loadtest \
 *   SGS_K6_ALLOWED_DATABASE=... SGS_K6_ALLOWED_HOST=... \
 *   SGS_K6_ALLOWED_PORT=5432 \
 *   npx ts-node scripts/clean-k6-data.ts
 *
 * Execução explícita:
 *   ... SGS_K6_CLEANUP_ALLOWED=true SGS_K6_MAX_COMPANIES=100 \
 *   npx ts-node scripts/clean-k6-data.ts --execute --confirm-loadtest-cleanup
 */

import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

const COMPANY_MARKER = 'K6\\_%';
const OWNER_EMAIL_MARKER = 'k6.%@test.local';
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_DATABASE_PORT = 5432;

type QueryRow = Record<string, unknown>;

export interface CleanupCounts {
  companies: number;
  sites: number;
  users: number;
  aprs: number;
  pts: number;
}

export interface CleanupTarget {
  databaseName: string;
  hostname: string;
  port: number;
  isLocal: boolean;
  sslMode?: string;
}

export interface CleanupArguments {
  dryRun: boolean;
  execute: boolean;
  confirmation: boolean;
}

export interface CleanupResult {
  mode: 'dry-run' | 'execute';
  target: CleanupTarget;
  counts: CleanupCounts;
}

interface CleanupQueryResult<T extends QueryRow = QueryRow> {
  rows: T[];
  rowCount: number | null;
}

export interface CleanupDbClient {
  query<T extends QueryRow = QueryRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<CleanupQueryResult<T>>;
  release(error?: Error): void;
}

export interface CleanupPool {
  connect(): Promise<CleanupDbClient>;
  end(): Promise<void>;
}

export type CleanupPoolFactory = (options: PoolConfig) => CleanupPool;

export class CleanupGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanupGuardError';
  }
}

export class CleanupExecutionError extends Error {
  constructor() {
    super('A limpeza K6 falhou e foi revertida.');
    this.name = 'CleanupExecutionError';
  }
}

const COUNT_SQL = `
  SELECT
    (SELECT count(*) FROM public.companies c
      WHERE c.razao_social LIKE $1 ESCAPE CHR(92)
        AND c.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM public.users owner_user
          WHERE owner_user.company_id = c.id
            AND owner_user.email LIKE $2
            AND owner_user.deleted_at IS NULL
        )) AS companies,
    (SELECT count(*) FROM public.sites s
      WHERE s.company_id IN (
        SELECT c.id FROM public.companies c
        WHERE c.razao_social LIKE $1 ESCAPE CHR(92)
          AND c.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.users owner_user
            WHERE owner_user.company_id = c.id
              AND owner_user.email LIKE $2
              AND owner_user.deleted_at IS NULL
          )
      ) AND s.deleted_at IS NULL) AS sites,
    (SELECT count(*) FROM public.users u
      WHERE u.company_id IN (
        SELECT c.id FROM public.companies c
        WHERE c.razao_social LIKE $1 ESCAPE CHR(92)
          AND c.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.users owner_user
            WHERE owner_user.company_id = c.id
              AND owner_user.email LIKE $2
              AND owner_user.deleted_at IS NULL
          )
      ) AND u.deleted_at IS NULL) AS users,
    (SELECT count(*) FROM public.aprs a
      WHERE a.company_id IN (
        SELECT c.id FROM public.companies c
        WHERE c.razao_social LIKE $1 ESCAPE CHR(92)
          AND c.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.users owner_user
            WHERE owner_user.company_id = c.id
              AND owner_user.email LIKE $2
              AND owner_user.deleted_at IS NULL
          )
      ) AND a.deleted_at IS NULL) AS aprs,
    (SELECT count(*) FROM public.pts p
      WHERE p.company_id IN (
        SELECT c.id FROM public.companies c
        WHERE c.razao_social LIKE $1 ESCAPE CHR(92)
          AND c.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.users owner_user
            WHERE owner_user.company_id = c.id
              AND owner_user.email LIKE $2
              AND owner_user.deleted_at IS NULL
          )
      ) AND p.deleted_at IS NULL) AS pts
`;

const CREATE_TARGETS_SQL = `
  CREATE TEMP TABLE k6_cleanup_targets ON COMMIT DROP AS
  SELECT c.id AS company_id
  FROM public.companies c
  WHERE false
`;

const INSERT_TARGETS_SQL = `
  INSERT INTO k6_cleanup_targets (company_id)
  SELECT c.id
  FROM public.companies c
  WHERE c.razao_social LIKE $1 ESCAPE CHR(92)
    AND c.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.users owner_user
      WHERE owner_user.company_id = c.id
        AND owner_user.email LIKE $2
        AND owner_user.deleted_at IS NULL
    )
`;

const TARGETED_COUNT_SQL = `
  SELECT
    (SELECT count(*) FROM k6_cleanup_targets) AS companies,
    (SELECT count(*) FROM public.sites s
      WHERE s.company_id IN (SELECT company_id FROM k6_cleanup_targets)
        AND s.deleted_at IS NULL) AS sites,
    (SELECT count(*) FROM public.users u
      WHERE u.company_id IN (SELECT company_id FROM k6_cleanup_targets)
        AND u.deleted_at IS NULL) AS users,
    (SELECT count(*) FROM public.aprs a
      WHERE a.company_id IN (SELECT company_id FROM k6_cleanup_targets)
        AND a.deleted_at IS NULL) AS aprs,
    (SELECT count(*) FROM public.pts p
      WHERE p.company_id IN (SELECT company_id FROM k6_cleanup_targets)
        AND p.deleted_at IS NULL) AS pts
`;

const MUTATIONS = [
  `UPDATE public.aprs SET deleted_at = $1
   WHERE company_id IN (SELECT company_id FROM k6_cleanup_targets)
     AND deleted_at IS NULL`,
  `UPDATE public.pts SET deleted_at = $1
   WHERE company_id IN (SELECT company_id FROM k6_cleanup_targets)
     AND deleted_at IS NULL`,
  `UPDATE public.sites SET deleted_at = $1
   WHERE company_id IN (SELECT company_id FROM k6_cleanup_targets)
     AND deleted_at IS NULL`,
  `UPDATE public.users SET deleted_at = $1
   WHERE company_id IN (SELECT company_id FROM k6_cleanup_targets)
     AND deleted_at IS NULL`,
  `UPDATE public.companies SET deleted_at = $1
   WHERE id IN (SELECT company_id FROM k6_cleanup_targets)
     AND deleted_at IS NULL`,
] as const;

function requiredEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new CleanupGuardError(`${key} é obrigatório e deve ser explícito.`);
  }
  return value;
}

function parsePort(value: string, key: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new CleanupGuardError(`${key} inválido.`);
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CleanupGuardError(`${key} inválido.`);
  }
  return port;
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function parseDatabaseTarget(
  databaseUrl: string,
  env: NodeJS.ProcessEnv,
): CleanupTarget {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new CleanupGuardError('DATABASE_URL inválida.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new CleanupGuardError('DATABASE_URL não é PostgreSQL.');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (
    !hostname ||
    hostname.includes(',') ||
    hostname.includes('*') ||
    /\s/.test(hostname)
  ) {
    throw new CleanupGuardError('host do DATABASE_URL inválido.');
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  } catch {
    throw new CleanupGuardError('nome do banco no DATABASE_URL inválido.');
  }

  if (
    !databaseName ||
    databaseName.includes('/') ||
    databaseName.includes('\0')
  ) {
    throw new CleanupGuardError(
      'nome do banco no DATABASE_URL ausente ou inválido.',
    );
  }

  const port = parsed.port
    ? parsePort(parsed.port, 'porta do DATABASE_URL')
    : DEFAULT_DATABASE_PORT;
  const allowedDatabase = requiredEnvironmentValue(
    env,
    'SGS_K6_ALLOWED_DATABASE',
  );
  const allowedHost = normalizeHostname(
    requiredEnvironmentValue(env, 'SGS_K6_ALLOWED_HOST'),
  );
  if (
    !allowedHost ||
    allowedHost.includes(',') ||
    allowedHost.includes('*') ||
    /\s/.test(allowedHost)
  ) {
    throw new CleanupGuardError('SGS_K6_ALLOWED_HOST inválido.');
  }
  const allowedPort = parsePort(
    requiredEnvironmentValue(env, 'SGS_K6_ALLOWED_PORT'),
    'SGS_K6_ALLOWED_PORT',
  );

  if (databaseName !== allowedDatabase) {
    throw new CleanupGuardError(
      'DATABASE_URL não corresponde ao banco autorizado.',
    );
  }
  if (hostname !== allowedHost) {
    throw new CleanupGuardError(
      'DATABASE_URL não corresponde ao host autorizado.',
    );
  }
  if (port !== allowedPort) {
    throw new CleanupGuardError(
      'DATABASE_URL não corresponde à porta autorizada.',
    );
  }

  return {
    databaseName,
    hostname,
    port,
    isLocal: LOCAL_DATABASE_HOSTS.has(hostname),
    sslMode: parsed.searchParams.get('sslmode')?.trim().toLowerCase(),
  };
}

function assertEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.APP_ENV !== 'loadtest') {
    throw new CleanupGuardError('APP_ENV=loadtest é obrigatório.');
  }
  if (env.NODE_ENV?.trim().toLowerCase() === 'production') {
    throw new CleanupGuardError('cleanup K6 é proibido em produção.');
  }
}

function assertSslPolicy(
  env: NodeJS.ProcessEnv,
  target: CleanupTarget,
): boolean {
  const configuredSsl = env.DATABASE_SSL?.trim().toLowerCase();
  if (
    configuredSsl !== undefined &&
    configuredSsl !== 'true' &&
    configuredSsl !== 'false'
  ) {
    throw new CleanupGuardError('DATABASE_SSL inválido.');
  }

  const sslDisabled = configuredSsl === 'false';
  const sslMode = target.sslMode;
  const insecureUrlModes = new Set(['disable', 'allow', 'prefer']);
  const strictUrlModes = new Set(['require', 'verify-ca', 'verify-full']);

  if (
    sslMode &&
    !insecureUrlModes.has(sslMode) &&
    !strictUrlModes.has(sslMode)
  ) {
    throw new CleanupGuardError('sslmode do DATABASE_URL inválido.');
  }
  if (sslMode && insecureUrlModes.has(sslMode) && !target.isLocal) {
    throw new CleanupGuardError(
      'DATABASE_URL sem TLS só é permitido em target local.',
    );
  }
  if (sslDisabled && !target.isLocal) {
    throw new CleanupGuardError(
      'DATABASE_SSL=false só é permitido em target local.',
    );
  }
  if (sslDisabled && sslMode && strictUrlModes.has(sslMode)) {
    throw new CleanupGuardError('DATABASE_SSL e sslmode estão em conflito.');
  }
  if (!sslDisabled && sslMode === 'disable') {
    throw new CleanupGuardError('DATABASE_SSL e sslmode estão em conflito.');
  }
  return !sslDisabled;
}

function assertExactTrue(env: NodeJS.ProcessEnv, key: string): void {
  if (env[key] !== 'true') {
    throw new CleanupGuardError(`${key}=true explícito é obrigatório.`);
  }
}

function parseMaximumCompanies(env: NodeJS.ProcessEnv): number {
  const value = requiredEnvironmentValue(env, 'SGS_K6_MAX_COMPANIES');
  if (!/^\d+$/.test(value)) {
    throw new CleanupGuardError('SGS_K6_MAX_COMPANIES inválido.');
  }

  const maximum = Number(value);
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new CleanupGuardError('SGS_K6_MAX_COMPANIES inválido.');
  }
  return maximum;
}

export function parseCleanupArguments(
  argv: readonly string[],
): CleanupArguments {
  let execute = false;
  let dryRun = false;
  let confirmation = false;

  for (const argument of argv) {
    if (argument === '--execute') {
      if (execute) throw new CleanupGuardError('--execute repetido.');
      execute = true;
    } else if (argument === '--dry-run') {
      if (dryRun) throw new CleanupGuardError('--dry-run repetido.');
      dryRun = true;
    } else if (argument === '--confirm-loadtest-cleanup') {
      if (confirmation) {
        throw new CleanupGuardError('--confirm-loadtest-cleanup repetido.');
      }
      confirmation = true;
    } else {
      throw new CleanupGuardError(`flag não permitida: ${argument}`);
    }
  }

  if (execute && dryRun) {
    throw new CleanupGuardError('--execute e --dry-run são incompatíveis.');
  }
  if (confirmation && !execute) {
    throw new CleanupGuardError('confirmação só pode acompanhar --execute.');
  }

  return {
    execute,
    confirmation,
    dryRun: !execute,
  };
}

function parseCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new CleanupExecutionError();
  }
  return count;
}

function countsFromRow(row: QueryRow | undefined): CleanupCounts {
  if (!row) throw new CleanupExecutionError();
  return {
    companies: parseCount(row.companies),
    sites: parseCount(row.sites),
    users: parseCount(row.users),
    aprs: parseCount(row.aprs),
    pts: parseCount(row.pts),
  };
}

function mutationTimestamp(): string {
  return new Date().toISOString();
}

function createDefaultPool(options: PoolConfig): CleanupPool {
  return new Pool(options) as unknown as CleanupPool;
}

async function countDryRun(client: CleanupDbClient): Promise<CleanupCounts> {
  const result = await client.query(COUNT_SQL, [
    COMPANY_MARKER,
    OWNER_EMAIL_MARKER,
  ]);
  return countsFromRow(result.rows[0]);
}

async function executeCleanup(
  client: CleanupDbClient,
  maximumCompanies: number,
): Promise<CleanupCounts> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query(CREATE_TARGETS_SQL);
    await client.query(INSERT_TARGETS_SQL, [
      COMPANY_MARKER,
      OWNER_EMAIL_MARKER,
    ]);
    const countsResult = await client.query(TARGETED_COUNT_SQL);
    const counts = countsFromRow(countsResult.rows[0]);

    if (counts.companies > maximumCompanies) {
      throw new CleanupGuardError(
        'quantidade de companies excede SGS_K6_MAX_COMPANIES.',
      );
    }

    const timestamp = mutationTimestamp();
    for (const mutation of MUTATIONS) {
      await client.query(mutation, [timestamp]);
    }

    await client.query('COMMIT');
    return counts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof CleanupGuardError) throw error;
    throw new CleanupExecutionError();
  }
}

export async function runCleanup(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  poolFactory: CleanupPoolFactory = createDefaultPool,
): Promise<CleanupResult> {
  const args = parseCleanupArguments(argv);
  assertEnvironment(env);

  const databaseUrl = requiredEnvironmentValue(env, 'DATABASE_URL');
  const target = parseDatabaseTarget(databaseUrl, env);
  const sslEnabled = assertSslPolicy(env, target);

  let maximumCompanies: number | undefined;
  if (args.execute) {
    assertExactTrue(env, 'SGS_K6_CLEANUP_ALLOWED');
    if (!args.confirmation) {
      throw new CleanupGuardError(
        '--confirm-loadtest-cleanup é obrigatório com --execute.',
      );
    }
    maximumCompanies = parseMaximumCompanies(env);
  }

  const pool = poolFactory({
    connectionString: databaseUrl,
    ssl: sslEnabled ? { rejectUnauthorized: true } : false,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  let client: CleanupDbClient | undefined;

  try {
    client = await pool.connect();
    let counts: CleanupCounts;
    if (args.dryRun) {
      counts = await countDryRun(client);
    } else if (maximumCompanies !== undefined) {
      counts = await executeCleanup(client, maximumCompanies);
    } else {
      throw new CleanupGuardError('limite de companies não configurado.');
    }

    return {
      mode: args.dryRun ? 'dry-run' : 'execute',
      target,
      counts,
    };
  } finally {
    client?.release();
    await pool.end();
  }
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

async function main(): Promise<void> {
  try {
    const result = await runCleanup();
    const mode =
      result.mode === 'dry-run'
        ? 'dry-run; nenhum dado alterado'
        : 'execute; transação concluída';
    console.log(`[clean-k6-data] ${mode}.`);
    console.log(
      `[clean-k6-data] companies=${result.counts.companies} sites=${result.counts.sites} users=${result.counts.users} aprs=${result.counts.aprs} pts=${result.counts.pts}`,
    );
  } catch (error) {
    console.error(
      `[clean-k6-data] operação negada/falhou: ${safeErrorName(error)}.`,
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
