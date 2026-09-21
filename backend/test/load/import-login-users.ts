/**
 * Importa usuários de CSV para testes de carga/login.
 *
 * Uso:
 *   node ./node_modules/ts-node/dist/bin.js -r tsconfig-paths/register test/load/import-login-users.ts
 *   node ./node_modules/ts-node/dist/bin.js -r tsconfig-paths/register test/load/import-login-users.ts --dry-run
 *
 * Variáveis opcionais:
 *   IMPORT_USERS_FILE=test/load/fixtures/users-batch-2026-03-28.csv
 *   IMPORT_USERS_OUTPUT_FILE=test/load/fixtures/login-users.generated.json
 *   IMPORT_USERS_DEFAULT_PASSWORD=Teste@123
 *   IMPORT_USERS_MULTIPLIER=3
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { Pool, type PoolConfig } from 'pg';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';

type CsvUser = {
  name: string;
  email: string;
  cpf: string;
  originalCpf: string;
  companyName: string;
  roleTitle: string;
};

type CompanyRow = {
  id: string;
  razao_social: string;
};

type ProfileRow = {
  id: string;
  nome: string;
};

type ExistingUserRow = {
  id: string;
  cpf: string | null;
  email: string | null;
};

type K6Credential = {
  cpf: string;
  password: string;
  companyId: string;
  companyName: string;
  email: string;
  name: string;
  profile: string;
};

const DEFAULT_INPUT_FILE = path.resolve(
  __dirname,
  'fixtures/users-batch-2026-03-28.csv',
);
const DEFAULT_OUTPUT_FILE = path.resolve(
  __dirname,
  'fixtures/login-users.generated.json',
);

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const autoFixInvalidCpf =
  args.has('--autofix-invalid-cpf') ||
  /^true$/i.test(process.env.IMPORT_USERS_AUTOFIX_INVALID_CPF || 'false');

const inputFile = path.resolve(
  process.cwd(),
  process.env.IMPORT_USERS_FILE || DEFAULT_INPUT_FILE,
);
const outputFile = path.resolve(
  process.cwd(),
  process.env.IMPORT_USERS_OUTPUT_FILE || DEFAULT_OUTPUT_FILE,
);
const defaultPassword =
  process.env.IMPORT_USERS_DEFAULT_PASSWORD || 'Teste@123';
const importUsersMultiplier = clampInt(
  process.env.IMPORT_USERS_MULTIPLIER,
  1,
  1,
  20,
);
const minOutputCredentialPool = clampInt(
  process.env.IMPORT_USERS_MIN_POOL_SIZE,
  120,
  1,
  50000,
);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const PROFILE_ADMIN_EMPRESA = 'Administrador da Empresa';
const PROFILE_TST = 'Técnico de Segurança do Trabalho (TST)';
const PROFILE_SUPERVISOR = 'Supervisor / Encarregado';
const PROFILE_OPERADOR = 'Operador / Colaborador';
const ARGON2_IMPORT_OPTIONS: argon2.HashOptions & { raw?: false } = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

async function main() {
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Arquivo CSV não encontrado: ${inputFile}`);
  }

  const parsedUsers = parseInputCsv(inputFile);
  const { users: normalizedUsers, cpfFixes } = normalizeUsersForImport(
    parsedUsers,
    autoFixInvalidCpf,
  );
  const users = expandUserPool(normalizedUsers, importUsersMultiplier);
  if (!users.length) {
    throw new Error('Nenhum usuário válido encontrado no CSV.');
  }

  validateUserBatch(users);

  const pool = new Pool(buildDbConfig());

  const companyCache = new Map<string, string>();
  const credentials: K6Credential[] = [];

  let createdCompanies = 0;
  let reusedCompanies = 0;
  let insertedUsers = 0;
  let updatedUsers = 0;

  const passwordHash = await argon2.hash(
    defaultPassword,
    ARGON2_IMPORT_OPTIONS,
  );

  const client = await pool.connect();

  try {
    if (!dryRun) {
      await client.query('BEGIN');
    }

    await client.query("SET app.is_super_admin = 'true'");

    const profileNames = Array.from(
      new Set(users.map((user) => mapTitleToProfile(user.roleTitle))),
    );
    const profileRows = await client.query<ProfileRow>(
      `SELECT id, nome
       FROM profiles
       WHERE nome = ANY($1::varchar[])`,
      [profileNames],
    );

    const profileMap = new Map(
      profileRows.rows.map((row) => [row.nome, row.id]),
    );

    const missingProfiles = profileNames.filter(
      (profileName) => !profileMap.has(profileName),
    );
    if (missingProfiles.length) {
      throw new Error(
        `Perfis não encontrados no banco: ${missingProfiles.join(', ')}. Rode o seed de perfis primeiro.`,
      );
    }

    for (const user of users) {
      const companyId = await ensureCompany(
        client,
        user.companyName,
        companyCache,
        dryRun,
      );

      if (companyCache.get(`${user.companyName}:created`) === '1') {
        createdCompanies += 1;
        companyCache.set(`${user.companyName}:created`, 'counted');
      }

      if (companyCache.get(`${user.companyName}:created`) === '0') {
        reusedCompanies += 1;
        companyCache.set(`${user.companyName}:created`, 'counted');
      }

      const profileName = mapTitleToProfile(user.roleTitle);
      const profileId = profileMap.get(profileName);

      if (!profileId) {
        throw new Error(
          `Perfil não resolvido para ${user.name}: ${profileName}`,
        );
      }

      if (!dryRun) {
        const existing = await client.query<ExistingUserRow>(
          `SELECT id, cpf, email
           FROM users
           WHERE cpf = $1 OR email = $2
           LIMIT 1`,
          [user.cpf, user.email],
        );

        if (existing.rows.length) {
          await client.query(
            `UPDATE users
             SET nome = $2,
                 email = $3,
                 funcao = $4,
                 password = $5,
                 company_id = $6,
                 profile_id = $7,
                 status = true,
                 deleted_at = NULL,
                 updated_at = NOW()
             WHERE id = $1`,
            [
              existing.rows[0].id,
              user.name,
              user.email,
              user.roleTitle,
              passwordHash,
              companyId,
              profileId,
            ],
          );
          updatedUsers += 1;
        } else {
          await client.query(
            `INSERT INTO users (
               nome,
               cpf,
               email,
               funcao,
               password,
               company_id,
               profile_id,
               status,
               created_at,
               updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW(), NOW())`,
            [
              user.name,
              user.cpf,
              user.email,
              user.roleTitle,
              passwordHash,
              companyId,
              profileId,
            ],
          );
          insertedUsers += 1;
        }
      }

      credentials.push({
        cpf: user.cpf,
        password: defaultPassword,
        companyId,
        companyName: user.companyName,
        email: user.email,
        name: user.name,
        profile: profileName,
      });
    }

    if (!dryRun) {
      await client.query('COMMIT');
    }
  } catch (error) {
    if (!dryRun) {
      await client.query('ROLLBACK');
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  if (credentials.length < minOutputCredentialPool) {
    throw new Error(
      [
        `Pool final insuficiente: ${credentials.length} credenciais.`,
        `Mínimo exigido: ${minOutputCredentialPool}.`,
        'Aumente IMPORT_USERS_MULTIPLIER ou adicione mais usuários no CSV base.',
      ].join(' '),
    );
  }
  fs.writeFileSync(outputFile, JSON.stringify(credentials, null, 2));
  if (cpfFixes.length > 0) {
    const cpfFixesOutput = outputFile.replace(/\.json$/i, '.cpf-fixes.json');
    fs.writeFileSync(cpfFixesOutput, JSON.stringify(cpfFixes, null, 2));
    console.log(`- Mapa de CPFs ajustados: ${cpfFixesOutput}`);
  }

  console.log('\nImport de usuários concluído.');
  console.log(`- Modo dry-run: ${dryRun ? 'sim' : 'nao'}`);
  console.log(
    `- Autoajuste de CPF inválido: ${autoFixInvalidCpf ? 'sim' : 'nao'}`,
  );
  console.log(`- Multiplicador de pool: ${importUsersMultiplier}x`);
  console.log(`- Pool mínimo esperado: ${minOutputCredentialPool}`);
  console.log(`- Usuários no CSV: ${users.length}`);
  console.log(`- Usuários inseridos: ${insertedUsers}`);
  console.log(`- Usuários atualizados: ${updatedUsers}`);
  console.log(`- Empresas criadas: ${createdCompanies}`);
  console.log(`- Empresas reutilizadas: ${reusedCompanies}`);
  console.log(`- Arquivo K6 gerado em: ${outputFile}`);
}

function parseInputCsv(filePath: string): CsvUser[] {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const idxName = headers.indexOf('Nome Completo');
  const idxEmail = headers.indexOf('E-mail');
  const idxCpf = headers.indexOf('CPF');
  const idxCompany = headers.indexOf('Empresa');
  const idxRole = headers.indexOf('Cargo');

  if ([idxName, idxEmail, idxCpf, idxCompany, idxRole].some((idx) => idx < 0)) {
    throw new Error(
      'CSV inválido. Cabeçalhos esperados: Nome Completo,E-mail,CPF,Empresa,Cargo',
    );
  }

  const users: CsvUser[] = [];

  for (let i = 1; i < lines.length; i++) {
    const columns = parseCsvLine(lines[i]);
    const name = (columns[idxName] || '').trim();
    const email = (columns[idxEmail] || '').trim().toLowerCase();
    const cpf = normalizeCpf(columns[idxCpf] || '');
    const companyName = (columns[idxCompany] || '').trim();
    const roleTitle = (columns[idxRole] || '').trim();

    if (!name && !email && !cpf && !companyName && !roleTitle) {
      continue;
    }

    users.push({
      name,
      email,
      cpf,
      originalCpf: cpf,
      companyName,
      roleTitle,
    });
  }

  return users;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      const nextChar = line[i + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  result.push(current.trim());
  return result;
}

function validateUserBatch(users: CsvUser[]) {
  const errors: string[] = [];
  const seenCpf = new Set<string>();
  const seenEmail = new Set<string>();

  users.forEach((user, index) => {
    const row = index + 2;

    if (!user.name) errors.push(`Linha ${row}: nome vazio`);
    if (!user.email) errors.push(`Linha ${row}: e-mail vazio`);
    if (!user.companyName) errors.push(`Linha ${row}: empresa vazia`);
    if (!user.roleTitle) errors.push(`Linha ${row}: cargo vazio`);

    if (user.cpf.length !== 11) {
      errors.push(`Linha ${row}: CPF inválido (precisa ter 11 dígitos)`);
    } else if (!isValidCpf(user.cpf)) {
      errors.push(`Linha ${row}: CPF inválido pelo dígito verificador`);
    }

    if (seenCpf.has(user.cpf)) {
      errors.push(`Linha ${row}: CPF duplicado no CSV (${user.cpf})`);
    }
    if (seenEmail.has(user.email)) {
      errors.push(`Linha ${row}: e-mail duplicado no CSV (${user.email})`);
    }

    seenCpf.add(user.cpf);
    seenEmail.add(user.email);
  });

  if (errors.length > 0) {
    throw new Error(`Falhas de validação no CSV:\n- ${errors.join('\n- ')}`);
  }
}

function normalizeUsersForImport(
  users: CsvUser[],
  autoFixCpf: boolean,
): {
  users: CsvUser[];
  cpfFixes: Array<{ email: string; from: string; to: string }>;
} {
  const result: CsvUser[] = [];
  const seenCpf = new Set<string>();
  const cpfFixes: Array<{ email: string; from: string; to: string }> = [];

  users.forEach((user, index) => {
    const normalizedUser: CsvUser = { ...user };
    const isCpfValid =
      normalizedUser.cpf.length === 11 && isValidCpf(normalizedUser.cpf);

    if (!isCpfValid) {
      if (!autoFixCpf) {
        result.push(normalizedUser);
        return;
      }

      let attempt = 0;
      let candidate: string;
      do {
        candidate = generateValidCpf(index + 1 + attempt * 1000);
        attempt += 1;
      } while (seenCpf.has(candidate));

      cpfFixes.push({
        email: normalizedUser.email,
        from: normalizedUser.originalCpf || normalizedUser.cpf,
        to: candidate,
      });
      normalizedUser.cpf = candidate;
    }

    seenCpf.add(normalizedUser.cpf);
    result.push(normalizedUser);
  });

  return { users: result, cpfFixes };
}

function expandUserPool(users: CsvUser[], multiplier: number): CsvUser[] {
  if (multiplier <= 1) {
    return users;
  }

  const expanded: CsvUser[] = [];
  const usedEmails = new Set<string>();
  const usedCpfs = new Set<string>();
  let cpfSeed = users.length + 1;

  for (let copyIndex = 0; copyIndex < multiplier; copyIndex++) {
    for (const user of users) {
      if (copyIndex === 0) {
        expanded.push(user);
        usedEmails.add(user.email);
        usedCpfs.add(user.cpf);
        continue;
      }

      const email = buildSyntheticEmail(user.email, copyIndex, usedEmails);
      const cpf = buildSyntheticCpf(usedCpfs, cpfSeed);
      cpfSeed += 1;

      expanded.push({
        ...user,
        name: `${user.name} ${copyIndex + 1}`,
        email,
        cpf,
      });
      usedEmails.add(email);
      usedCpfs.add(cpf);
    }
  }

  return expanded;
}

function normalizeCpf(input: string): string {
  return String(input || '').replace(/\D/g, '');
}

function isValidCpf(cpf: string): boolean {
  if (!cpf || cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calcDigit = (base: string, factor: number): number => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) {
      sum += Number(base[i]) * (factor - i);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  const digit1 = calcDigit(cpf.slice(0, 9), 10);
  const digit2 = calcDigit(cpf.slice(0, 10), 11);

  return digit1 === Number(cpf[9]) && digit2 === Number(cpf[10]);
}

function generateValidCpf(seed: number): string {
  const base = String(100000000 + (seed % 899999999))
    .padStart(9, '0')
    .slice(-9);
  const digit1 = calcCpfDigit(base, 10);
  const digit2 = calcCpfDigit(`${base}${digit1}`, 11);
  return `${base}${digit1}${digit2}`;
}

function calcCpfDigit(base: string, startFactor: number): number {
  let sum = 0;
  for (let i = 0; i < base.length; i++) {
    sum += Number(base[i]) * (startFactor - i);
  }
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

function mapTitleToProfile(roleTitle: string): string {
  const normalized = removeDiacritics(roleTitle).toLowerCase();

  if (normalized.includes('supervisor')) {
    return PROFILE_SUPERVISOR;
  }

  if (normalized.includes('tecnico') || normalized.includes('engenheiro')) {
    return PROFILE_TST;
  }

  if (normalized.includes('gestor') || normalized.includes('coordenador')) {
    return PROFILE_ADMIN_EMPRESA;
  }

  return PROFILE_OPERADOR;
}

function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function ensureCompany(
  client: { query: Pool['query'] },
  companyName: string,
  cache: Map<string, string>,
  dryRunFlag: boolean,
): Promise<string> {
  const cachedId = cache.get(companyName);
  if (cachedId) {
    return cachedId;
  }

  const existing = await client.query<CompanyRow>(
    `SELECT id, razao_social
     FROM companies
     WHERE LOWER(razao_social) = LOWER($1)
     ORDER BY created_at ASC
     LIMIT 1`,
    [companyName],
  );

  if (existing.rows.length > 0) {
    const companyId = existing.rows[0].id;
    cache.set(companyName, companyId);
    cache.set(`${companyName}:created`, '0');
    return companyId;
  }

  if (dryRunFlag) {
    const fakeId = `dry-run-${slugify(companyName)}`;
    cache.set(companyName, fakeId);
    cache.set(`${companyName}:created`, '1');
    return fakeId;
  }

  const cnpj = await generateUniqueCnpj(client, companyName);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO companies (
       razao_social,
       cnpj,
       endereco,
       responsavel,
       status,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, true, NOW(), NOW())
     RETURNING id`,
    [companyName, cnpj, 'Endereço de teste', 'Importador K6'],
  );

  const companyId = inserted.rows[0].id;
  cache.set(companyName, companyId);
  cache.set(`${companyName}:created`, '1');
  return companyId;
}

async function generateUniqueCnpj(
  client: { query: Pool['query'] },
  companyName: string,
): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const candidate = makeDeterministicCnpj(companyName, attempt);
    const exists = await client.query<{ id: string }>(
      `SELECT id FROM companies WHERE cnpj = $1 LIMIT 1`,
      [candidate],
    );
    if (!exists.rows.length) {
      return candidate;
    }
  }

  throw new Error(`Falha ao gerar CNPJ único para empresa: ${companyName}`);
}

function makeDeterministicCnpj(companyName: string, attempt: number): string {
  const hashHex = createHash('sha1')
    .update(`${companyName}:${attempt}`)
    .digest('hex');

  const numericBase = hashHex
    .replace(/[a-f]/g, (char) => String(char.charCodeAt(0) % 10))
    .slice(0, 8);

  return `${numericBase}000100`;
}

function slugify(value: string): string {
  return removeDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function buildSyntheticEmail(
  email: string,
  copyIndex: number,
  usedEmails: Set<string>,
): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.indexOf('@');
  const localPart = atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
  const domainPart = atIndex >= 0 ? trimmed.slice(atIndex + 1) : 'teste.local';
  let attempt = 0;

  while (true) {
    const suffix =
      attempt === 0 ? `${copyIndex + 1}` : `${copyIndex + 1}-${attempt}`;
    const candidate = `${localPart}+load${suffix}@${domainPart}`;
    if (!usedEmails.has(candidate)) {
      return candidate;
    }
    attempt += 1;
  }
}

function buildSyntheticCpf(usedCpfs: Set<string>, seed: number): string {
  let attempt = 0;

  while (attempt < 10000) {
    const candidate = generateValidCpf(seed + attempt);
    if (!usedCpfs.has(candidate)) {
      return candidate;
    }
    attempt += 1;
  }

  throw new Error('Falha ao gerar CPF único para ampliar o pool de carga.');
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.floor(parsed);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function buildDbConfig(): PoolConfig {
  const databaseUrl =
    process.env.DATABASE_URL ||
    process.env.DATABASE_PUBLIC_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL;

  const sslEnabled =
    /^true$/i.test(process.env.DB_SSL || '') ||
    /^true$/i.test(process.env.DATABASE_SSL || '') ||
    (databaseUrl?.includes('sslmode=require') ?? false);

  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.DB_POOL_MAX || 10),
    };
  }

  return {
    host:
      process.env.DATABASE_HOST ||
      process.env.POSTGRES_HOST ||
      process.env.DB_HOST ||
      'localhost',
    port: Number(
      process.env.DATABASE_PORT ||
        process.env.POSTGRES_PORT ||
        process.env.DB_PORT ||
        5432,
    ),
    database:
      process.env.DATABASE_NAME ||
      process.env.POSTGRES_DB ||
      process.env.DB_NAME ||
      'postgres',
    user:
      process.env.DATABASE_USER ||
      process.env.POSTGRES_USER ||
      process.env.DB_USERNAME ||
      'postgres',
    password:
      process.env.DATABASE_PASSWORD ||
      process.env.POSTGRES_PASSWORD ||
      process.env.DB_PASSWORD ||
      '',
    ssl: sslEnabled ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.DB_POOL_MAX || 10),
  };
}

void main().catch((error) => {
  console.error('\nFalha no import de usuários:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
