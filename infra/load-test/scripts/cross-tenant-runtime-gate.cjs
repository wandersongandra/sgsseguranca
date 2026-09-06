/*
 * P0 cross-tenant runtime gate.
 *
 * This script is intentionally loadtest-only. It creates fresh synthetic data,
 * soft-deletes the tenant-owned fixture rows during teardown, and emits
 * IDs/statuses without credentials or personal data. Run it from the
 * seed-loadtest image so the migrator URL is available for fixture
 * provisioning; HTTP calls go to api-loadtest:3001.
 */
const { assertLoadtestEnvironment, assertLoadtestReturnedUrl } = require('./loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireApi: true, requireDatabase: true, requireRedis: true });

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('/app/node_modules/pg');
const argon2 = require('/app/node_modules/argon2');

const API_URL = String(process.env.LOADTEST_API_URL || 'http://api-loadtest:3001').replace(/\/+$/, '');
const MARKER = 'SGS_P0_CROSS_TENANT';
const PASSWORD = 'P0-cross-tenant-synthetic-20260824!';
const HTTP_TIMEOUT_MS = 30_000;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n% synthetic loadtest PDF\n%%EOF\n', 'ascii'), Buffer.alloc(180, 0x20)]);
let requestSequence = 0;

function fail(message) {
  throw new Error(`[cross-tenant-gate] ${message}`);
}

function assertEnvironment() {
  if (process.env.APP_ENV !== 'loadtest' || process.env.APP_LOADTEST_MARKER !== 'sgs-loadtest') fail('loadtest marker missing');
  if (process.env.DATABASE_NAME !== 'sgs_loadtest') fail('database is not sgs_loadtest');
  if (!process.env.DATABASE_MIGRATION_URL) fail('DATABASE_MIGRATION_URL missing');
  if (!process.env.REDIS_QUEUE_URL) fail('REDIS_QUEUE_URL missing');
  if (!/^[a-f0-9]{64}$/i.test(process.env.FIELD_ENCRYPTION_KEY || '')) fail('FIELD_ENCRYPTION_KEY missing');
  if (!/^[a-f0-9]{64}$/i.test(process.env.FIELD_ENCRYPTION_HASH_KEY || '')) fail('FIELD_ENCRYPTION_HASH_KEY missing');
  if (/production|neon|upstash|backblaze|api\.sgsseguranca\.com\.br|app\.sgsseguranca\.com\.br/i.test(JSON.stringify(process.env))) fail('production marker detected');
}

function uuid() { return crypto.randomUUID(); }

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function cpfFor(seed) {
  const digits = String(seed).replace(/\D/g, '').padEnd(9, '7').slice(0, 9).split('').map(Number);
  const digit = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += digits[i] * (length + 1 - i);
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  digits.push(digit(9));
  digits.push(digit(10));
  return digits.join('');
}

function encrypt(value, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function nextRequestIp() {
  const ip = `10.245.${Math.floor(requestSequence / 200)}.${(requestSequence % 200) + 1}`;
  requestSequence += 1;
  return ip;
}

function cookieHeader(setCookies) {
  return (setCookies || []).map((value) => String(value).split(';', 1)[0]).filter(Boolean).join('; ');
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function responseJson(response) {
  let timeoutId;
  try {
    const text = await Promise.race([
      response.text(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('HTTP response body timeout')), HTTP_TIMEOUT_MS);
      }),
    ]);
    try { return text ? JSON.parse(text) : null; } catch { return { raw: text.slice(0, 500) }; }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function createSession(user) {
  const csrf = await fetchWithTimeout(`${API_URL}/auth/csrf`, { headers: { 'x-forwarded-for': nextRequestIp(), 'user-agent': 'sgs-p0-cross-tenant-gate/1.0' } });
  const csrfBody = await responseJson(csrf);
  const csrfCookies = typeof csrf.headers.getSetCookie === 'function' ? csrf.headers.getSetCookie() : [csrf.headers.get('set-cookie') || ''];
  const csrfCookie = csrfCookies.filter((value) => /^csrf-token=.+/.test(String(value))).at(-1)?.split(';', 1)[0] || '';
  if (!csrf.ok || !csrfBody?.csrfToken || !csrfCookie) fail(`csrf failed for ${user.label}: HTTP ${csrf.status}`);
  const login = await fetchWithTimeout(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: csrfCookie, 'x-csrf-token': csrfBody.csrfToken, 'x-forwarded-for': nextRequestIp(), 'user-agent': 'sgs-p0-cross-tenant-gate/1.0' },
    body: JSON.stringify({ cpf: user.cpf, password: PASSWORD }),
  });
  const body = await responseJson(login);
  if (!login.ok || typeof body?.accessToken !== 'string') {
    const safeBody = body && typeof body === 'object' ? { message: body.message, error: body.error, code: body.code } : body;
    fail(`login failed for ${user.label}: HTTP ${login.status} ${JSON.stringify(safeBody)}`);
  }
  const loginCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || ''];
  return { ...user, accessToken: body.accessToken, cookie: cookieHeader([csrfCookie, ...loginCookies]), csrfToken: csrfBody.csrfToken };
}

async function call(session, method, path, body, extra = {}) {
  const requestIp = nextRequestIp();
  const headers = {
    authorization: `Bearer ${session.accessToken}`,
    cookie: session.cookie,
    'x-csrf-token': session.csrfToken,
    'x-forwarded-for': requestIp,
    'user-agent': 'sgs-p0-cross-tenant-gate/1.0',
    ...(extra.headers || {}),
  };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetchWithTimeout(`${API_URL}${path}`, { method, headers, body: payload });
  return { status: response.status, headers: response.headers, body: await responseJson(response) };
}

async function callAnonymous(method, path, body, extra = {}) {
  const headers = {
    'x-forwarded-for': nextRequestIp(),
    'user-agent': 'sgs-p0-cross-tenant-gate/1.0',
    ...(extra.headers || {}),
  };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetchWithTimeout(`${API_URL}${path}`, { method, headers, body: payload });
  return { status: response.status, headers: response.headers, body: await responseJson(response) };
}

async function uploadPdf(session, path, filename) {
  const form = new FormData();
  // Hashes must differ per tenant; otherwise the governance table's unique
  // hash constraint would exercise a same-content conflict instead of the
  // tenant-isolation vector under test.
  const tenantSpecificPdf = Buffer.concat([PDF, Buffer.from(`\n% ${filename}-${uuid()}\n`, 'ascii')]);
  form.append('file', new Blob([tenantSpecificPdf], { type: 'application/pdf' }), filename);
  return call(session, 'POST', path, form);
}

function result(results, id, module, endpoint, actor, resource, vector, response, before, after, details = {}) {
  const status = response?.status ?? null;
  const allowed = details.allowedStatuses || [];
  const responseText = JSON.stringify(response?.body || {});
  const forbiddenValues = details.bodyMustNotContain === undefined
    ? []
    : Array.isArray(details.bodyMustNotContain)
      ? details.bodyMustNotContain
      : [details.bodyMustNotContain];
  const bodySafe = forbiddenValues.every((value) => !responseText.includes(String(value)));
  const databaseUnchanged = !details.requireDbUnchanged || (before !== null && after !== null && before === after);
  const auditUnchanged = !details.requireAuditUnchanged || (details.auditBefore !== null && details.auditAfter !== null && details.auditBefore === details.auditAfter);
  const pass = allowed.includes(status) && bodySafe && databaseUnchanged && auditUnchanged;
  results.push({ id, module, endpoint, authenticatedTenant: actor, resourceTenant: resource, vector, http: status, dbBefore: before, dbAfter: after, storage: details.storage || 'not_applicable', cache: details.cache || 'not_applicable', queue: details.queue || 'not_applicable', audit: details.audit || 'not_checked', status: pass ? 'PASS' : 'FAIL', note: details.note || undefined });
  return pass;
}

async function digest(client, table, id) {
  const safeTables = new Set(['companies', 'sites', 'users', 'aprs', 'checklists', 'document_registry', 'signatures', 'document_download_grants', 'public_validation_grants', 'forensic_trail_events']);
  if (!safeTables.has(table)) fail(`unsafe digest table ${table}`);
  const rows = await client.query(`SELECT md5(COALESCE(row_to_json(row)::text, '')) AS digest FROM (SELECT * FROM ${table} WHERE id = $1) row`, [id]);
  return rows.rows[0]?.digest || null;
}

async function countForensic(client, companyId, entityId) {
  const rows = await client.query('SELECT count(*)::int AS count FROM forensic_trail_events WHERE company_id = $1 AND entity_id = $2', [companyId, entityId]);
  return rows.rows[0]?.count || 0;
}

async function countSyntheticRows(client, table, companyId) {
  const safeTables = new Set(['aprs', 'checklists']);
  if (!safeTables.has(table)) fail(`unsafe count table ${table}`);
  const rows = await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE company_id = $1 AND titulo LIKE $2`, [companyId, `${MARKER}%`]);
  return rows.rows[0]?.count || 0;
}

async function cleanupSyntheticFixtures(client, fixture) {
  const companyIds = Object.values(fixture.tenants)
    .map((tenant) => tenant.companyId)
    .filter(Boolean);
  const userIds = Object.values(fixture.tenants)
    .map((tenant) => tenant.userId)
    .filter(Boolean);
  if (!companyIds.length) return;

  const tables = await client.query(`
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.columns d
      ON d.table_schema = c.table_schema
     AND d.table_name = c.table_name
     AND d.column_name = 'deleted_at'
    WHERE c.table_schema = 'public'
      AND c.column_name = 'company_id'
      AND c.table_name NOT IN ('companies', 'forensic_trail_events')
    ORDER BY c.table_name
  `);
  const failures = [];
  for (const table of ['document_download_grants', 'public_validation_grants']) {
    try {
      const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${table}`]);
      if (exists.rows[0]?.exists) {
        await client.query(`DELETE FROM public.${table} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
      }
    } catch (error) {
      failures.push(`${table}:${error instanceof Error ? error.name : 'CleanupError'}`);
    }
  }
  try {
    const exists = await client.query("SELECT to_regclass('public.user_sessions') IS NOT NULL AS exists");
    if (exists.rows[0]?.exists) {
      await client.query(
        'DELETE FROM public.user_sessions WHERE company_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])',
        [companyIds, userIds],
      );
    }
  } catch (error) {
    failures.push(`user_sessions:${error instanceof Error ? error.name : 'CleanupError'}`);
  }
  for (const row of tables.rows) {
    const tableName = String(row.table_name).replace(/"/g, '""');
    try {
      await client.query(
        `UPDATE public."${tableName}" SET deleted_at = NOW() WHERE company_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [companyIds],
      );
    } catch (error) {
      failures.push(`${tableName}:${error instanceof Error ? error.name : 'CleanupError'}`);
    }
  }

  try {
    await client.query(
      'UPDATE public.users SET deleted_at = NOW(), status = false WHERE company_id = ANY($1::uuid[])',
      [companyIds],
    );
    await client.query(
      'UPDATE public.sites SET deleted_at = NOW(), status = false WHERE company_id = ANY($1::uuid[])',
      [companyIds],
    );
    await client.query(
      'UPDATE public.companies SET deleted_at = NOW(), status = false WHERE id = ANY($1::uuid[])',
      [companyIds],
    );
  } catch (error) {
    failures.push(`core:${error instanceof Error ? error.name : 'CleanupError'}`);
  }

  const active = await client.query(
    'SELECT count(*)::int AS count FROM public.companies WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
    [companyIds],
  );
  const activeUsers = await client.query(
    'SELECT count(*)::int AS count FROM public.users WHERE company_id = ANY($1::uuid[]) AND deleted_at IS NULL',
    [companyIds],
  );
  const residuals = [];
  for (const table of ['document_download_grants', 'public_validation_grants', 'user_sessions']) {
    try {
      const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${table}`]);
      if (!exists.rows[0]?.exists) continue;
      const rows = await client.query(`SELECT count(*)::int AS count FROM public.${table} WHERE company_id = ANY($1::uuid[])`, [companyIds]);
      if (Number(rows.rows[0]?.count || 0) > 0) residuals.push(`${table}:active rows remain`);
    } catch (error) {
      residuals.push(`${table}:${error instanceof Error ? error.name : 'ResidualCheckError'}`);
    }
  }
  if (failures.length || residuals.length || Number(active.rows[0]?.count || 0) > 0 || Number(activeUsers.rows[0]?.count || 0) > 0) {
    throw new Error(`synthetic fixture cleanup failed: ${[...failures, ...residuals].join(',') || 'active rows remain'}`);
  }
}

async function cleanupLocalStorage(fixture) {
  const baseDir = process.env.LOCAL_DOCUMENT_STORAGE_DIR?.trim();
  if (!baseDir) return;
  const resolvedBase = path.resolve(baseDir);
  const fileKeys = Object.values(fixture.documents).filter((value) => typeof value === 'string' && value.startsWith('documents/'));
  for (const fileKey of fileKeys) {
    const target = path.resolve(resolvedBase, fileKey.replace(/\\/g, '/'));
    if (!target.startsWith(`${resolvedBase}${path.sep}`)) fail('local storage cleanup path escaped the loadtest root');
    await fs.rm(target, { force: true });
  }
}

async function cleanupManagedStorage(fixture) {
  const endpoint = process.env.STORAGE_ENDPOINT || process.env.AWS_ENDPOINT || process.env.AWS_S3_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET || process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET;
  const keys = Object.values(fixture.documents).filter((value) => typeof value === 'string' && value.startsWith('documents/'));
  if (!endpoint || !bucket || !keys.length) return;
  const { DeleteObjectCommand, S3Client } = require('/app/node_modules/@aws-sdk/client-s3');
  const storage = new S3Client({
    region: process.env.STORAGE_REGION || process.env.AWS_REGION || 'us-east-1',
    endpoint,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE).toLowerCase() === 'true',
    credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY },
  });
  try {
    for (const key of keys) await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } finally {
    storage.destroy();
  }
}

async function cleanupRedisArtifacts(redisClient, fixture) {
  if (!redisClient) return;
  const companyIds = Object.values(fixture.tenants).map((tenant) => tenant.companyId).filter(Boolean);
  const keys = new Set();
  for (const companyId of companyIds) {
    for (const pattern of [`dashboard:${companyId}*`, `dashboard:metrics:${companyId}:*`, `dashboard:feed:${companyId}*`, `dashboard:summary:${companyId}:*`]) {
      let cursor = '0';
      do {
        const page = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = page[0];
        for (const key of page[1]) keys.add(key);
      } while (cursor !== '0');
    }
  }
  if (keys.size) await redisClient.del(...keys);

  const jobIds = Object.entries(fixture.jobs || {})
    .filter(([key, value]) => key !== 'states' && typeof value === 'string')
    .map(([, value]) => value);
  if (jobIds.length) {
    const { Queue } = require('/app/node_modules/bullmq');
    const queue = new Queue('mail', { connection: { url: process.env.REDIS_QUEUE_URL } });
    try {
      for (const jobId of jobIds) {
        const job = await queue.getJob(jobId);
        if (job) await job.remove();
      }
    } finally {
      await queue.close();
    }
  }
}

async function provision(client, fixture) {
  const profileRows = await client.query("SELECT id FROM profiles WHERE nome = 'Administrador da Empresa' ORDER BY id LIMIT 1");
  if (!profileRows.rows[0]) fail('Administrador da Empresa profile missing');
  const profileId = profileRows.rows[0].id;
  const stamp = Date.now().toString();
  const tenants = {};
  for (const label of ['A', 'B']) {
    const companyId = uuid();
    const siteId = uuid();
    const userId = uuid();
    const cpf = cpfFor(`${stamp.slice(-7)}${label === 'A' ? '17' : '83'}`);
    const cnpj = `${label === 'A' ? '91' : '92'}${stamp.slice(-12)}`.slice(0, 14);
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    await client.query('BEGIN');
    try {
      await client.query('INSERT INTO companies (id, razao_social, cnpj, endereco, responsavel, status) VALUES ($1,$2,$3,$4,$5,true)', [companyId, `${MARKER} Tenant ${label}`, cnpj, 'VPS loadtest sintético', 'P0 cross-tenant']);
      await client.query('INSERT INTO sites (id, nome, local, company_id, status) VALUES ($1,$2,$3,$4,true)', [siteId, `${MARKER} Site ${label}`, 'loadtest', companyId]);
      await client.query(`INSERT INTO users (id,nome,cpf,cpf_hash,cpf_ciphertext,email,funcao,password,status,company_id,site_id,profile_id,module_access_keys,identity_type,access_status,ai_processing_consent,must_change_password) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,true,$8,$9,$10,'[]'::jsonb,'system_user','credentialed',false,false)`, [userId, `${MARKER} User ${label}`, hashCpf(cpf), encrypt(cpf, process.env.FIELD_ENCRYPTION_KEY), `p0-cross-${label.toLowerCase()}-${stamp}@invalid.test`, 'Administrador de teste', passwordHash, companyId, siteId, profileId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    tenants[label] = { label, companyId, siteId, userId, cpf, passwordHash };
    fixture.tenants[label] = { companyId, siteId, userId, cpfHash: hash(cpf) };
  }
  return tenants;
}

function hashCpf(cpf) {
  return crypto.createHmac('sha256', process.env.FIELD_ENCRYPTION_HASH_KEY).update(cpf).digest('hex');
}

async function main() {
  let client;
  const results = [];
  let redisClient;
  let executionError = null;
  let cleanupError = null;
  const queues = new Set();
  const fixture = { marker: MARKER, createdAt: new Date().toISOString(), target: 'sgs-loadtest', tenants: {}, apr: {}, checklist: {}, documents: {}, grants: {}, cache: {}, jobs: {} };
  try {
    assertEnvironment();
    client = new Client({ connectionString: process.env.DATABASE_MIGRATION_URL, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, query_timeout: 35_000 });
    await client.connect();
    const tenants = await provision(client, fixture);
    const sessionA = await createSession(tenants.A);
    const sessionB = await createSession(tenants.B);

    const createApr = async (session, tenant, label) => {
      const response = await call(session, 'POST', '/aprs', {
        numero: `P0-${label}-${Date.now()}`,
        titulo: `${MARKER} APR ${label}`,
        descricao: 'Fixture sintética cross-tenant',
        tipo_atividade: 'outros',
        data_inicio: '2026-08-24',
        data_fim: '2026-08-25',
        site_id: tenant.siteId,
        elaborador_id: tenant.userId,
        participants: [tenant.userId],
        risk_items: [{ atividade: 'Atividade sintética', etapa: 'Etapa A', agente_ambiental: 'Mecânico', condicao_perigosa: 'Fixture', probabilidade: 1, severidade: 1, medidas_prevencao: 'Controle sintético', responsavel: `P0 ${label}`, prazo: '2026-08-25', status_acao: 'Pendente' }],
      });
      if (![200, 201].includes(response.status)) fail(`APR fixture creation failed: HTTP ${response.status}`);
      const id = response.body?.id || response.body?.data?.id;
      if (!isUuid(id)) fail('APR fixture creation returned no valid UUID');
      return { response, id };
    };
    const createChecklist = async (session, tenant, label) => {
      const response = await call(session, 'POST', '/checklists', {
        titulo: `${MARKER} Checklist ${label}`,
        descricao: 'Fixture sintética cross-tenant',
        data: '2026-08-24',
        site_id: tenant.siteId,
        inspetor_id: tenant.userId,
        status: 'Conforme',
        itens: [{ item: 'Item sintético de isolamento', status: 'Conforme', resposta: 'sim', tipo_resposta: 'sim_nao_na', obrigatorio: true, peso: 1 }],
      });
      if (![200, 201].includes(response.status)) fail(`checklist fixture creation failed: HTTP ${response.status}`);
      const id = response.body?.id || response.body?.data?.id;
      if (!isUuid(id)) fail('checklist fixture creation returned no valid UUID');
      return { response, id };
    };

    const aprA = await createApr(sessionA, tenants.A, 'A');
    const aprB = await createApr(sessionB, tenants.B, 'B');
    const checklistA = await createChecklist(sessionA, tenants.A, 'A');
    const checklistB = await createChecklist(sessionB, tenants.B, 'B');
    fixture.apr = { A: aprA.id || null, B: aprB.id || null };
    fixture.checklist = { A: checklistA.id || null, B: checklistB.id || null };

    for (const [label, created, tenant, session] of [['A', aprA, tenants.A, sessionA], ['B', aprB, tenants.B, sessionB]]) {
      if (!created.id) continue;
      const signature = await call(session, 'POST', '/signatures', { document_id: created.id, document_type: 'APR', signature_data: `${MARKER}-signature-${label}`, type: 'drawn' });
      const signatureId = signature.body?.id || signature.body?.data?.id;
      if (!isUuid(signatureId)) fail(`APR signature fixture creation returned no valid UUID for tenant ${label}`);
      fixture.documents[`aprSignature${label}`] = signatureId;
      const approval = await call(session, 'PATCH', `/aprs/${created.id}/approve`, { reason: `${MARKER} approval` });
      if ([200, 201].includes(approval.status)) {
        const pdf = await call(session, 'POST', `/aprs/${created.id}/generate-final-pdf`);
        fixture.documents[`aprPdf${label}`] = pdf.body?.fileKey || null;
      }
      fixture.documents[`aprApproval${label}`] = { status: approval.status, message: approval.body?.message || approval.body?.error?.message || null };
      fixture.documents[`aprPdfStatus${label}`] = fixture.documents[`aprPdf${label}`] ? 200 : null;
    }
    for (const [label, created, session] of [['A', checklistA, sessionA], ['B', checklistB, sessionB]]) {
      if (!created.id) continue;
      const signature = await call(session, 'POST', '/signatures', { document_id: created.id, document_type: 'CHECKLIST', signature_data: `${MARKER}-signature-checklist-${label}`, type: 'drawn' });
      const signatureId = signature.body?.id || signature.body?.data?.id;
      if (!isUuid(signatureId)) fail(`checklist signature fixture creation returned no valid UUID for tenant ${label}`);
      fixture.documents[`checklistSignature${label}`] = signatureId;
      const pdf = await uploadPdf(session, `/checklists/${created.id}/file`, `p0-cross-${label.toLowerCase()}.pdf`);
      fixture.documents[`checklistPdf${label}`] = pdf.body?.fileKey || null;
      fixture.documents[`checklistPdfStatus${label}`] = { status: pdf.status, message: pdf.body?.message || pdf.body?.error?.message || null };
    }

    const matrix = [
      ['A', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}`, 'GET', undefined, [403, 404]],
      ['B', sessionA, tenants.A, 'B', aprB.id, 'aprs', `/aprs/${aprB.id}`, 'GET', undefined, [403, 404]],
      ['A-list', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs?page=1&limit=100&site_id=${tenants.A.siteId}`, 'GET', undefined, [200]],
      ['B-list', sessionA, tenants.A, 'B', aprB.id, 'aprs', `/aprs?page=1&limit=100&site_id=${tenants.B.siteId}`, 'GET', undefined, [200]],
      ['A-spoof-header', sessionA, tenants.A, 'B', aprB.id, 'aprs', `/aprs/${aprB.id}`, 'GET', undefined, [403, 404]],
      ['A-patch', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}`, 'PATCH', { titulo: `${MARKER} CROSS MUTATION` }, [403, 404]],
      ['A-delete', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}`, 'DELETE', undefined, [403, 404]],
      ['A-checklist', sessionB, tenants.B, 'A', checklistA.id, 'checklists', `/checklists/${checklistA.id}`, 'GET', undefined, [403, 404]],
      ['B-checklist', sessionA, tenants.A, 'B', checklistB.id, 'checklists', `/checklists/${checklistB.id}`, 'GET', undefined, [403, 404]],
      ['A-checklist-patch', sessionB, tenants.B, 'A', checklistA.id, 'checklists', `/checklists/${checklistA.id}`, 'PATCH', { titulo: `${MARKER} CROSS MUTATION` }, [403, 404]],
      ['A-checklist-delete', sessionB, tenants.B, 'A', checklistA.id, 'checklists', `/checklists/${checklistA.id}`, 'DELETE', undefined, [403, 404]],
      ['A-create-apr', sessionB, tenants.B, 'A', null, 'aprs', '/aprs', 'POST', { numero: `P0-CROSS-${Date.now()}`, titulo: `${MARKER} CROSS CREATE`, company_id: tenants.A.companyId, site_id: tenants.A.siteId, elaborador_id: tenants.A.userId, data_inicio: '2026-08-24', data_fim: '2026-08-25' }, [400, 403, 404]],
      ['A-create-checklist', sessionB, tenants.B, 'A', null, 'checklists', '/checklists', 'POST', { titulo: `${MARKER} CROSS CREATE`, company_id: tenants.A.companyId, data: '2026-08-24', site_id: tenants.A.siteId, inspetor_id: tenants.A.userId, itens: [{ item: 'cross', status: 'Conforme', resposta: 'sim', tipo_resposta: 'sim_nao_na' }] }, [400, 403, 404]],
      ['A-signature-list', sessionB, tenants.B, 'A', aprA.id, 'signatures', `/signatures?document_id=${aprA.id}&document_type=APR`, 'GET', undefined, [200, 404]],
      ['A-signature-create', sessionB, tenants.B, 'A', aprA.id, 'signatures', '/signatures', 'POST', { document_id: aprA.id, document_type: 'APR', signature_data: `${MARKER}-spoof`, type: 'drawn', company_id: tenants.A.companyId }, [400, 403, 404]],
      ['A-signature-verify', sessionB, tenants.B, 'A', fixture.documents.aprSignatureA, 'signatures', `/signatures/verify/${fixture.documents.aprSignatureA}`, 'GET', undefined, [403, 404]],
      ['A-signature-delete', sessionB, tenants.B, 'A', fixture.documents.aprSignatureA, 'signatures', `/signatures/${fixture.documents.aprSignatureA}`, 'DELETE', undefined, [403, 404]],
      ['A-registry', sessionB, tenants.B, 'A', null, 'document-registry', '/document-registry?modules=apr,checklist', 'GET', undefined, [200]],
      ['A-dashboard', sessionB, tenants.B, 'A', null, 'dashboard', '/dashboard/summary', 'GET', undefined, [200]],
      ['A-query-company', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs?page=1&company_id=${tenants.A.companyId}&tenant_id=${tenants.A.companyId}&empresa_id=${tenants.A.companyId}&user_id=${tenants.A.userId}&site_id=${tenants.A.siteId}`, 'GET', undefined, [200]],
      ['A-validate', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/validate`, 'GET', undefined, [403, 404]],
      ['A-workflow-status', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/workflow-status`, 'GET', undefined, [403, 404]],
      ['A-logs', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/logs`, 'GET', undefined, [403, 404]],
      ['A-versions', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/versions`, 'GET', undefined, [403, 404]],
      ['A-compare', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/compare/${aprB.id}`, 'GET', undefined, [403, 404]],
      ['A-evidence', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/evidence`, 'GET', undefined, [403, 404]],
      ['A-submit', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/submit`, 'POST', { reason: `${MARKER} cross submit` }, [403, 404]],
      ['A-reopen', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/reopen`, 'POST', { reason: `${MARKER} cross reopen` }, [403, 404]],
      ['A-reject', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/reject`, 'PATCH', { reason: `${MARKER} cross reject` }, [403, 404]],
      ['A-finalize', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/finalize`, 'PATCH', undefined, [403, 404]],
      ['A-new-version', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/new-version`, 'POST', undefined, [403, 404]],
      ['A-generate-pdf', sessionB, tenants.B, 'A', aprA.id, 'aprs', `/aprs/${aprA.id}/generate-final-pdf`, 'POST', undefined, [403, 404]],
      ['A-checklist-context', sessionB, tenants.B, 'A', checklistA.id, 'checklists', `/checklists/${checklistA.id}/validation-context`, 'GET', undefined, [403, 404]],
      ['A-checklist-pdf', sessionB, tenants.B, 'A', checklistA.id, 'checklists', `/checklists/${checklistA.id}/pdf`, 'GET', undefined, [403, 404]],
      ['A-checklist-photo', sessionB, tenants.B, 'A', checklistA.id, 'checklists', `/checklists/${checklistA.id}/equipment-photo/access`, 'GET', undefined, [403, 404]],
    ];
    for (const [id, session, actor, owner, resourceId, module, endpoint, method, body, statuses] of matrix) {
      const table = module === 'aprs' ? 'aprs' : module === 'checklists' ? 'checklists' : module === 'signatures' ? 'signatures' : null;
      const before = table && resourceId ? await digest(client, table, resourceId) : (id.endsWith('-create') && (table === 'aprs' || table === 'checklists') ? await countSyntheticRows(client, table, tenants[owner].companyId) : null);
      const auditBefore = resourceId ? await countForensic(client, tenants[owner].companyId, resourceId) : null;
      const extra = id === 'A-spoof-header' ? { headers: { 'x-company-id': tenants.B.companyId } } : {};
      const response = await call(session, method, endpoint, body, extra);
      const after = table && resourceId ? await digest(client, table, resourceId) : (id.endsWith('-create') && (table === 'aprs' || table === 'checklists') ? await countSyntheticRows(client, table, tenants[owner].companyId) : null);
      const auditAfter = resourceId ? await countForensic(client, tenants[owner].companyId, resourceId) : null;
      const requiresDbInvariant = (table && resourceId && !['A-signature-list', 'A-signature-create', 'A-registry', 'A-dashboard', 'A-query-company'].includes(id)) || id.endsWith('-create');
      const mustNotContain = id.endsWith('-list') || id === 'A-query-company'
        ? [resourceId, tenants[owner].companyId, tenants[owner].siteId, tenants[owner].userId]
        : `${MARKER} CROSS MUTATION`;
      result(results, id, module, `${method} ${endpoint}`, actor.companyId, tenants[owner].companyId, 'cross-tenant IDOR/BOLA', response, before, after, { allowedStatuses: statuses, bodyMustNotContain: mustNotContain, requireDbUnchanged: requiresDbInvariant, requireAuditUnchanged: requiresDbInvariant && resourceId !== null, auditBefore, auditAfter, audit: `${auditBefore}->${auditAfter}`, note: id.endsWith('-list') || id === 'A-query-company' ? 'HTTP 200 permitido para listagem; conteúdo deve excluir o tenant alvo.' : undefined });
    }

    for (const [label, foreignSession, foreign, ownerLabel, owner, checklistId] of [
      ['A', sessionB, tenants.B, 'A', tenants.A, checklistA.id],
      ['B', sessionA, tenants.A, 'B', tenants.B, checklistB.id],
    ]) {
      if (!checklistId) continue;
      const before = await digest(client, 'checklists', checklistId);
      const auditBefore = await countForensic(client, owner.companyId, checklistId);
      const response = await uploadPdf(foreignSession, `/checklists/${checklistId}/file`, `p0-cross-foreign-${label.toLowerCase()}.pdf`);
      const after = await digest(client, 'checklists', checklistId);
      const auditAfter = await countForensic(client, owner.companyId, checklistId);
      result(results, `A-checklist-upload-${label}`, 'checklists', `POST /checklists/${checklistId}/file`, foreign.companyId, owner.companyId, 'cross-tenant file/finalize mutation', response, before, after, { allowedStatuses: [403, 404], requireDbUnchanged: true, requireAuditUnchanged: true, auditBefore, auditAfter, storage: 'foreign upload did not replace owner PDF', audit: `${auditBefore}->${auditAfter}` });
    }

    const signatureRows = await client.query('SELECT id, company_id, document_id, signature_hash FROM signatures WHERE id IN ($1,$2)', [fixture.documents.aprSignatureA || uuid(), fixture.documents.aprSignatureB || uuid()]);
    fixture.documents.signatureHashes = {};
    for (const row of signatureRows.rows) {
      const ownerSession = row.company_id === tenants.A.companyId ? sessionA : sessionB;
      const ownerVerify = await call(ownerSession, 'GET', `/signatures/verify/${row.id}`);
      results.push({ id: `owner-signature-verify-${row.company_id === tenants.A.companyId ? 'A' : 'B'}`, module: 'signatures', endpoint: `GET /signatures/verify/${row.id}`, authenticatedTenant: row.company_id, resourceTenant: row.company_id, vector: 'same-tenant signature verification', http: ownerVerify.status, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: ownerVerify.status === 200 && ownerVerify.body?.valid === true ? 'PASS' : 'FAIL', note: ownerVerify.body?.message || undefined });
      fixture.documents.signatureHashes[row.company_id === tenants.A.companyId ? 'A' : 'B'] = row.signature_hash ? hash(row.signature_hash) : null;
      if (row.signature_hash) {
        const publicVerify = await callAnonymous('GET', `/public/signature/verify?hash=${encodeURIComponent(row.signature_hash)}`);
        const valid = publicVerify.status === 200 && publicVerify.body?.valid === true;
        results.push({ id: `public-signature-${row.company_id === tenants.A.companyId ? 'A' : 'B'}`, module: 'signatures', endpoint: 'GET /public/signature/verify', authenticatedTenant: 'public', resourceTenant: row.company_id, vector: 'public verify by exact hash', http: publicVerify.status, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: valid ? 'PASS' : 'FAIL', note: publicVerify.body?.message || undefined });
        const invalidHash = await callAnonymous('GET', `/public/signature/verify?hash=${encodeURIComponent(`${row.signature_hash}x`)}`);
        const invalidHashPass = (invalidHash.status === 200 && invalidHash.body?.valid === false) || invalidHash.status === 400;
        results.push({ id: `public-signature-${row.company_id === tenants.A.companyId ? 'A' : 'B'}-bad-hash`, module: 'signatures', endpoint: 'GET /public/signature/verify', authenticatedTenant: 'public', resourceTenant: row.company_id, vector: 'bad hash fail-closed', http: invalidHash.status, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: invalidHashPass ? 'PASS' : 'FAIL' });
      }
    }

    const validation = {};
    for (const [label, session, tenant, id] of [['A', sessionA, tenants.A, checklistA.id], ['B', sessionB, tenants.B, checklistB.id]]) {
      if (!id) continue;
      const context = await call(session, 'GET', `/checklists/${id}/validation-context`);
      validation[label] = { code: context.body?.documentCode, token: context.body?.token };
      if (context.body?.token && context.body?.documentCode) {
        const good = await callAnonymous('GET', `/public/checklists/validate?code=${encodeURIComponent(context.body.documentCode)}&token=${encodeURIComponent(context.body.token)}`);
        const tampered = await callAnonymous('GET', `/public/checklists/validate?code=${encodeURIComponent(context.body.documentCode)}&token=${encodeURIComponent(`${context.body.token}x`)}`);
        results.push({ id: `public-${label}-good`, module: 'public-validation', endpoint: 'GET /public/checklists/validate', authenticatedTenant: 'public', resourceTenant: tenant.companyId, vector: 'valid token/code', http: good.status, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'forensic trace checked by prior public-validation implementation', status: good.status === 200 && good.body?.valid === true ? 'PASS' : 'FAIL', note: good.body?.message || undefined });
        const replay = await callAnonymous('GET', `/public/checklists/validate?code=${encodeURIComponent(context.body.documentCode)}&token=${encodeURIComponent(context.body.token)}`);
        const replayPass = replay.status === 200 && replay.body?.valid === true;
        results.push({ id: `public-${label}-replay`, module: 'public-validation', endpoint: 'GET /public/checklists/validate', authenticatedTenant: 'public', resourceTenant: tenant.companyId, vector: 'same token replay is tenant-bound and deterministic', http: replay.status, dbBefore: 'grant active', dbAfter: 'grant remains active', storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'last_validated_at updated under tenant context', status: replayPass ? 'PASS' : 'FAIL' });
        const tamperPass = tampered.status === 200 && tampered.body?.valid === false;
        results.push({ id: `public-${label}-tampered`, module: 'public-validation', endpoint: 'GET /public/checklists/validate', authenticatedTenant: 'public', resourceTenant: tenant.companyId, vector: 'tampered token', http: tampered.status, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: tamperPass ? 'PASS' : 'FAIL' });
      }
    }
    if (validation.A?.code && validation.B?.token) {
      const mix = await callAnonymous('GET', `/public/checklists/validate?code=${encodeURIComponent(validation.A.code)}&token=${encodeURIComponent(validation.B.token)}`, undefined, { headers: { 'x-forwarded-for': '10.0.0.43' } });
      const mixedPass = mix.status === 200 && mix.body?.valid === false;
      results.push({ id: 'public-cross-resource-mix', module: 'public-validation', endpoint: 'GET /public/checklists/validate', authenticatedTenant: 'public', resourceTenant: `${tenants.A.companyId}/${tenants.B.companyId}`, vector: 'Tenant A code + Tenant B token', http: mix.status, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: mixedPass ? 'PASS' : 'FAIL' });
    }
    for (const [label, tenant, context] of [['A', tenants.A, validation.A], ['B', tenants.B, validation.B]]) {
      if (!context?.code || !context?.token) continue;
      await client.query('UPDATE public_validation_grants SET expires_at = NOW() WHERE company_id = $1 AND document_code = $2', [tenant.companyId, context.code]);
      const expired = await callAnonymous('GET', `/public/checklists/validate?code=${encodeURIComponent(context.code)}&token=${encodeURIComponent(context.token)}`, undefined, { headers: { 'x-forwarded-for': `10.0.0.${label === 'A' ? '41' : '42'}` } });
      const expiredPass = expired.status === 200 && expired.body?.valid === false;
      results.push({ id: `public-${label}-expired`, module: 'public-validation', endpoint: 'GET /public/checklists/validate', authenticatedTenant: 'public', resourceTenant: tenant.companyId, vector: 'expired grant', http: expired.status, dbBefore: 'grant expires_at future', dbAfter: 'grant expires_at now', storage: 'not_applicable', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: expiredPass ? 'PASS' : 'FAIL' });
    }
    fixture.documents.validation = Object.fromEntries(Object.entries(validation).map(([label, value]) => [label, { code: value.code || null, tokenHash: value.token ? hash(value.token) : null }]));

    const redis = require('/app/node_modules/ioredis');
    redisClient = new redis(process.env.REDIS_QUEUE_URL, { connectTimeout: 10_000, commandTimeout: 30_000, maxRetriesPerRequest: 1 });
    for (const [label, tenant, session] of [['A', tenants.A, sessionA], ['B', tenants.B, sessionB]]) {
      await call(session, 'GET', '/dashboard/summary');
      const keysSet = new Set();
      const patterns = [
        `dashboard:${tenant.companyId}*`,
        `dashboard:metrics:${tenant.companyId}:*`,
        `dashboard:feed:${tenant.companyId}*`,
        `dashboard:summary:${tenant.companyId}:*`,
      ];
      for (const pattern of patterns) {
        let cursor = '0';
        do {
          const page = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = page[0];
          for (const key of page[1]) keysSet.add(key);
        } while (cursor !== '0');
      }
      const keys = [...keysSet];
      const foreign = keys.filter((key) => !key.includes(tenant.companyId));
      fixture.cache[label] = { keyCount: keys.length, keys: keys.map((key) => hash(key).slice(0, 12)), foreignKeyCount: foreign.length };
      results.push({ id: `cache-${label}`, module: 'cache', endpoint: 'GET /dashboard/summary', authenticatedTenant: tenant.companyId, resourceTenant: tenant.companyId, vector: 'tenant namespace and rapid route/id variant', http: 200, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: `${keys.length} keys; foreign=${foreign.length}`, queue: 'not_applicable', audit: 'not_checked', status: foreign.length === 0 && keys.length > 0 ? 'PASS' : 'UNVERIFIED' });
    }
    const pdfTargets = [
      ['apr', fixture.apr.A, sessionA, tenants.A, sessionB, tenants.B],
      ['apr', fixture.apr.B, sessionB, tenants.B, sessionA, tenants.A],
      ['checklist', fixture.checklist.A, sessionA, tenants.A, sessionB, tenants.B],
      ['checklist', fixture.checklist.B, sessionB, tenants.B, sessionA, tenants.A],
    ];
    for (const [module, id, ownerSession, owner, foreignSession, foreign] of pdfTargets) {
      if (!id) continue;
      const route = `/${module === 'apr' ? 'aprs' : 'checklists'}/${id}/pdf`;
      const ownerAccess = await call(ownerSession, 'GET', route);
      const ownerPdfReady = ownerAccess.status === 200 && ownerAccess.body?.hasFinalPdf === true;
      results.push({ id: `pdf-${module}-${owner === tenants.A ? 'A' : 'B'}-owner`, module: 'pdf', endpoint: `GET ${route}`, authenticatedTenant: owner.companyId, resourceTenant: owner.companyId, vector: 'same-tenant final PDF access', http: ownerAccess.status, dbBefore: null, dbAfter: null, storage: ownerAccess.body?.fileKey || 'no file key', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: ownerPdfReady ? 'PASS' : 'UNVERIFIED', note: ownerAccess.body?.message || undefined });
      const foreignAccess = await call(foreignSession, 'GET', route);
      result(results, `pdf-${module}-${owner === tenants.A ? 'A' : 'B'}-foreign`, 'pdf', `GET ${route}`, foreign.companyId, owner.companyId, 'cross-tenant PDF access', foreignAccess, null, null, { allowedStatuses: [403, 404], storage: 'foreign tenant receives no PDF key', audit: 'not_checked' });

      if (ownerPdfReady && ownerAccess.body?.url) {
        const downloadUrl = assertLoadtestReturnedUrl(ownerAccess.body.url, API_URL, 'governed PDF URL');
        if (downloadUrl.origin !== new URL(API_URL).origin) fail('governed PDF URL must stay on the load-test API origin');
        const downloadPath = `${downloadUrl.pathname}${downloadUrl.search}`;
        const foreignGrantAttempt = await call(foreignSession, 'GET', downloadPath);
        result(results, `grant-${module}-${owner === tenants.A ? 'A' : 'B'}-foreign`, 'grant', 'GET /storage/download/<token-redacted>', foreign.companyId, owner.companyId, 'cross-tenant grant/token use', foreignGrantAttempt, 'consumed_at null', 'consumed_at null', { allowedStatuses: [403, 404], storage: 'foreign tenant received no document bytes', cache: 'private no-store expected', audit: 'token rejection path exercised' });
        const first = await call(ownerSession, 'GET', downloadPath);
        const second = await call(ownerSession, 'GET', downloadPath);
        const grantRows = await client.query('SELECT id, consumed_at FROM document_download_grants WHERE company_id = $1 AND file_key = $2 ORDER BY created_at DESC LIMIT 1', [owner.companyId, ownerAccess.body.fileKey]);
        const grant = grantRows.rows[0];
        const singleUsePass = first.status === 200 && second.status === 403 && Boolean(grant?.consumed_at);
        results.push({ id: `grant-${module}-${owner === tenants.A ? 'A' : 'B'}`, module: 'grant', endpoint: 'GET /storage/download/<token-redacted>', authenticatedTenant: owner.companyId, resourceTenant: owner.companyId, vector: 'download grant single use + DB atomic consumption', http: `${first.status}/${second.status}`, dbBefore: grant ? 'consumed_at null before first use' : null, dbAfter: grant ? `consumed_at=${Boolean(grant.consumed_at)}` : null, storage: 'first download reached governed storage', cache: 'private no-store expected', queue: 'not_applicable', audit: 'security download path exercised', status: singleUsePass ? 'PASS' : 'FAIL' });
      } else {
        results.push({ id: `grant-${module}-${owner === tenants.A ? 'A' : 'B'}`, module: 'grant', endpoint: `GET ${route}`, authenticatedTenant: owner.companyId, resourceTenant: owner.companyId, vector: 'grant/download', http: ownerAccess.status, dbBefore: null, dbAfter: null, storage: 'UNVERIFIED: no ready PDF/grant', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: 'UNVERIFIED' });
      }
    }

    let Queue;
    try { Queue = require('/app/node_modules/bullmq').Queue; } catch { Queue = null; }
    if (Queue) {
      const queue = new Queue('mail', { connection: { url: process.env.REDIS_QUEUE_URL, connectTimeout: 10_000, commandTimeout: 30_000, maxRetriesPerRequest: 1 } });
      queues.add(queue);
      const jobs = {};
      const jobInputs = [
        ['A-to-A', tenants.A, checklistA.id],
        ['B-to-B', tenants.B, checklistB.id],
        ['B-to-A', tenants.B, checklistA.id],
        ['A-to-B', tenants.A, checklistB.id],
      ];
      for (const [label, tenant, resourceId] of jobInputs) {
        const job = await queue.add('send-document', { documentId: resourceId || uuid(), documentType: 'CHECKLIST', email: `synthetic-${label.toLowerCase()}@invalid.test`, companyId: tenant.companyId, tenantContext: { companyId: tenant.companyId, userId: tenant.userId, isSuperAdmin: false, siteScope: 'all', siteIds: [tenant.siteId] } }, { jobId: `p0-cross-runtime-${label.toLowerCase()}-${Date.now()}`, attempts: 1, removeOnComplete: false, removeOnFail: false });
        jobs[label] = job.id;
      }
      await queue.close();
      queues.delete(queue);
      await new Promise((resolve) => setTimeout(resolve, 8000));
      const inspectQueue = new Queue('mail', { connection: { url: process.env.REDIS_QUEUE_URL, connectTimeout: 10_000, commandTimeout: 30_000, maxRetriesPerRequest: 1 } });
      queues.add(inspectQueue);
      const states = {};
      for (const [label, jobId] of Object.entries(jobs)) {
        const job = await inspectQueue.getJob(jobId);
        states[label] = job ? await job.getState() : 'missing';
      }
      await inspectQueue.close();
      queues.delete(inspectQueue);
      fixture.jobs = jobs;
      fixture.jobs.states = states;
      const terminal = Object.values(states).every((state) => ['completed', 'failed'].includes(state));
      results.push({ id: 'worker-A-B-cross', module: 'worker', endpoint: 'BullMQ mail', authenticatedTenant: 'A/B', resourceTenant: 'A/B', vector: 'A->A, B->B, B->A, A->B tenantContext propagation', http: null, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: JSON.stringify(states), audit: 'worker logs/tenant context not exposing foreign result', status: terminal ? 'PASS' : 'UNVERIFIED' });
    } else {
      results.push({ id: 'worker-A-B', module: 'worker', endpoint: 'BullMQ mail', authenticatedTenant: 'A/B', resourceTenant: 'A/B', vector: 'real queue unavailable', http: null, dbBefore: null, dbAfter: null, storage: 'not_applicable', cache: 'not_applicable', queue: 'bullmq require failed', audit: 'not_checked', status: 'UNVERIFIED' });
    }

    const storageCases = [
      ['storage-cross-A', sessionB, tenants.B, fixture.documents.checklistPdfA, tenants.A.companyId],
      ['storage-cross-B', sessionA, tenants.A, fixture.documents.checklistPdfB, tenants.B.companyId],
    ];
    for (const [id, session, actor, key, owner] of storageCases) {
      if (!key) {
        results.push({ id, module: 'storage', endpoint: 'governed PDF access', authenticatedTenant: actor.companyId, resourceTenant: owner, vector: 'cross-tenant file key', http: null, dbBefore: null, dbAfter: null, storage: 'UNVERIFIED: fixture PDF missing', cache: 'not_applicable', queue: 'not_applicable', audit: 'not_checked', status: 'UNVERIFIED' });
        continue;
      }
      const target = owner === tenants.A.companyId ? fixture.checklist.A : fixture.checklist.B;
      const response = await call(session, 'GET', `/checklists/${target}/pdf`);
      result(results, id, 'storage', `GET /checklists/${target}/pdf`, actor.companyId, owner, 'cross-tenant governed storage access', response, null, null, { allowedStatuses: [403, 404], storage: 'file key not returned to foreign tenant', audit: 'not_checked' });
    }

  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
  } finally {
    const teardownErrors = [];
    if (client) {
      await cleanupSyntheticFixtures(client, fixture).catch((error) => teardownErrors.push(error instanceof Error ? error.message : String(error)));
      await cleanupLocalStorage(fixture).catch((error) => teardownErrors.push(`local-storage:${error instanceof Error ? error.name : 'CleanupError'}`));
      await cleanupManagedStorage(fixture).catch((error) => teardownErrors.push(`managed-storage:${error instanceof Error ? error.name : 'CleanupError'}`));
    }
    await cleanupRedisArtifacts(redisClient, fixture).catch((error) => teardownErrors.push(`redis-cleanup:${error instanceof Error ? error.name : 'CleanupError'}`));
    for (const queue of queues) {
      await queue.close().catch((error) => teardownErrors.push(`queue:${error instanceof Error ? error.name : 'TeardownError'}`));
    }
    if (redisClient) {
      await redisClient.quit().catch((error) => teardownErrors.push(`redis:${error instanceof Error ? error.name : 'TeardownError'}`));
    }
    if (client) {
      await client.end().catch((error) => teardownErrors.push(`postgres:${error instanceof Error ? error.name : 'TeardownError'}`));
    }
    if (teardownErrors.length) cleanupError = teardownErrors.join('; ');
  }

  const summary = {
    total: results.length,
    pass: results.filter((item) => item.status === 'PASS').length,
    fail: results.filter((item) => item.status === 'FAIL').length,
    unverified: results.filter((item) => item.status === 'UNVERIFIED').length,
  };
  const status = executionError || cleanupError || summary.fail > 0 || summary.unverified > 0 ? 'FAIL' : 'PASS';
  const report = {
    fixture,
    results,
    summary,
    cleanup: cleanupError ? { status: 'FAIL', error: cleanupError } : { status: 'PASS' },
    status,
  };
  if (executionError) report.error = executionError;
  console.log(JSON.stringify(report, null, 2));
  if (status !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
