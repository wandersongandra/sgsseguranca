/* BE-010: real BullMQ PDF job gate for the isolated loadtest. */
"use strict";

const { assertLoadtestEnvironment } = require('./loadtest-target-guard.cjs');
assertLoadtestEnvironment({ requireApi: true, requireDatabase: true, requireRedis: true });

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("/app/node_modules/pg");
const { Queue } = require("/app/node_modules/bullmq");
const argon2 = require("/app/node_modules/argon2");

const API_URL = String(
  process.env.LOADTEST_API_URL || "http://api-loadtest:3001",
).replace(/\/+$/, "");
const PASSWORD = String(process.env.LOADTEST_ADMIN_PASSWORD || "");
const MARKER = "SGS_LOADTEST_SYNTHETIC";
const RUN_TOKEN = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const RUN_ID = `PDF_WORKER_RUNTIME_${RUN_TOKEN}`;
const REPORT_YEAR = new Date().getUTCFullYear();
const REPORT_MONTH = new Date().getUTCMonth() + 1;
const JOB_WAIT_TIMEOUT_MS = Number(
  process.env.BE010_JOB_WAIT_TIMEOUT_MS || 180_000,
);
if (!Number.isFinite(JOB_WAIT_TIMEOUT_MS) || JOB_WAIT_TIMEOUT_MS <= 0 || JOB_WAIT_TIMEOUT_MS > 900_000) {
  throw new Error('BE010_JOB_WAIT_TIMEOUT_MS must be a finite value between 1 and 900000 ms');
}

function createSyntheticCpf() {
  const digits = Array.from(crypto.randomBytes(9), (value) => value % 10);
  if (new Set(digits).size === 1) digits[0] = (digits[0] + 1) % 10;
  const firstCheck =
    (digits.reduce((sum, digit, index) => sum + digit * (10 - index), 0) * 10) %
    11;
  digits.push(firstCheck === 10 ? 0 : firstCheck);
  const secondCheck =
    (digits.reduce((sum, digit, index) => sum + digit * (11 - index), 0) * 10) %
    11;
  digits.push(secondCheck === 10 ? 0 : secondCheck);
  return digits.join("");
}

const FIXTURE = {
  companyId: crypto.randomUUID(),
  siteId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  cpf: createSyntheticCpf(),
  cnpj: `99${crypto
    .randomBytes(6)
    .toString("hex")
    .replace(
      /[a-f]/gi,
      (letter) => (letter.toLowerCase().charCodeAt(0) - 96) % 10,
    )}`,
};

const FIXTURE_B = {
  companyId: crypto.randomUUID(),
  siteId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  cpf: createSyntheticCpf(),
  cnpj: `99${crypto
    .randomBytes(6)
    .toString("hex")
    .replace(
      /[a-f]/gi,
      (letter) => (letter.toLowerCase().charCodeAt(0) - 96) % 10,
    )}`,
};

function safeHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function keyFromHex(value, name) {
  if (!/^[a-f0-9]{64}$/i.test(value || "")) {
    throw new Error(`${name} ausente ou inválida`);
  }
  return Buffer.from(value, "hex");
}

function hashKeyFromEnvironment() {
  const value = String(process.env.FIELD_ENCRYPTION_HASH_KEY || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("FIELD_ENCRYPTION_HASH_KEY ausente ou inválida");
  }
  return value;
}

function encryptCpf(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `enc:v1:${iv.toString("base64url")}:${cipher
    .getAuthTag()
    .toString("base64url")}:${ciphertext.toString("base64url")}`;
}

async function provisionFixture(client, fixture = FIXTURE) {
  if (!PASSWORD) {
    throw new Error("senha sintética gerenciada está ausente");
  }
  const fieldKey = keyFromHex(
    process.env.FIELD_ENCRYPTION_KEY,
    "FIELD_ENCRYPTION_KEY",
  );
  const hashKey = hashKeyFromEnvironment();
  const cpfHash = crypto
    .createHmac("sha256", hashKey)
    .update(fixture.cpf)
    .digest("hex");
  const cpfCiphertext = encryptCpf(fixture.cpf, fieldKey);
  const passwordHash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  await client.query("BEGIN");
  try {
    const profile = await client.query(
      `SELECT id
         FROM profiles
        WHERE nome = 'Administrador da Empresa'
          AND status = true
        ORDER BY id
        LIMIT 1`,
    );
    if (!profile.rows[0]) {
      throw new Error("perfil sintético obrigatório ausente");
    }
    await client.query(
      `INSERT INTO companies
       (id, razao_social, cnpj, endereco, responsavel, status)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [
        fixture.companyId,
        `${MARKER} ${RUN_ID} ${fixture === FIXTURE ? "A" : "B"} Empresa`,
        fixture.cnpj,
        "Ambiente isolado de validação",
        "Seed sintético do gate",
      ],
    );
    await client.query(
      `INSERT INTO sites (id, nome, local, company_id, status)
       VALUES ($1, $2, $3, $4, true)`,
      [
        fixture.siteId,
        `${MARKER} ${RUN_ID} ${fixture === FIXTURE ? "A" : "B"} Site`,
        "VPS load-test",
        fixture.companyId,
      ],
    );
    await client.query(
      `INSERT INTO users
       (id, nome, cpf, cpf_hash, cpf_ciphertext, email, funcao, password,
        status, company_id, site_id, profile_id, module_access_keys,
        identity_type, access_status, ai_processing_consent, must_change_password)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, true, $8, $9, $10,
               '[]'::jsonb, 'system_user', 'credentialed', false, false)`,
      [
        fixture.userId,
        `${MARKER} ${RUN_ID} ${fixture === FIXTURE ? "A" : "B"} Admin`,
        cpfHash,
        cpfCiphertext,
        `pdf-worker-${RUN_TOKEN}-${fixture === FIXTURE ? "a" : "b"}@invalid.test`,
        "Administrador de teste",
        passwordHash,
        fixture.companyId,
        fixture.siteId,
        profile.rows[0].id,
      ],
    );
    await client.query("COMMIT");
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function softDeleteFixture(client, fixture = FIXTURE) {
  await client.query("BEGIN");
  try {
    await client.query(
      `UPDATE users
          SET status = false, deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [fixture.userId, fixture.companyId],
    );
    await client.query(
      `UPDATE sites
          SET status = false, deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [fixture.siteId, fixture.companyId],
    );
    await client.query(
      `UPDATE companies
          SET status = false, deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [fixture.companyId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM companies WHERE id = $1 AND deleted_at IS NULL)::int
         AS active_companies,
       (SELECT COUNT(*) FROM sites WHERE id = $2 AND deleted_at IS NULL)::int
         AS active_sites,
       (SELECT COUNT(*) FROM users WHERE id = $3 AND deleted_at IS NULL)::int
         AS active_users`,
    [fixture.companyId, fixture.siteId, fixture.userId],
  );
  const row = result.rows[0];
  if (row.active_companies || row.active_sites || row.active_users) {
    throw new Error("cleanup exato da fixture não foi confirmado");
  }
}

async function assertFixtureAuthMaterial(client, fixture = FIXTURE) {
  const hashKey = hashKeyFromEnvironment();
  const expectedCpfHash = crypto
    .createHmac("sha256", hashKey)
    .update(fixture.cpf)
    .digest("hex");
  const rowResult = await client.query(
    `SELECT cpf_hash, password, status, deleted_at
       FROM users
      WHERE id = $1 AND company_id = $2
      LIMIT 1`,
    [fixture.userId, fixture.companyId],
  );
  const row = rowResult.rows[0];
  const rowMatches =
    row?.cpf_hash === expectedCpfHash &&
    row.status === true &&
    row.deleted_at === null;
  const passwordMatches =
    typeof row?.password === "string" &&
    row.password.startsWith("$argon2") &&
    (await argon2.verify(row.password, PASSWORD));
  const functionResult = await client.query(
    `SELECT id, company_id, status, password
       FROM public.find_login_user($1, NULL)
      WHERE id = $2
      LIMIT 1`,
    [expectedCpfHash, fixture.userId],
  );
  const functionRow = functionResult.rows[0];
  const functionMatches =
    functionResult.rowCount === 1 &&
    functionRow.company_id === fixture.companyId &&
    functionRow.status === true &&
    typeof functionRow.password === "string";
  if (!rowMatches || !passwordMatches || !functionMatches) {
    throw new Error(
      `fixture auth material invalid: row=${rowMatches} password=${passwordMatches} function=${functionMatches}`,
    );
  }
}

async function assertApplicationLoginLookup(fixture = FIXTURE) {
  const appClient = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await appClient.connect();
    const hashKey = hashKeyFromEnvironment();
    const expectedCpfHash = crypto
      .createHmac("sha256", hashKey)
      .update(fixture.cpf)
      .digest("hex");
    const result = await appClient.query(
      `SELECT id, company_id, status, password
         FROM find_login_user($1, $2)
        WHERE id = $3
        LIMIT 1`,
      [expectedCpfHash, null, fixture.userId],
    );
    const row = result.rows[0];
    const matches =
      result.rowCount === 1 &&
      row.company_id === fixture.companyId &&
      row.status === true &&
      typeof row.password === "string" &&
      (await argon2.verify(row.password, PASSWORD));
    if (!matches)
      throw new Error("application login lookup returned no fixture");
  } catch (error) {
    throw new Error(
      `application login lookup failed: ${error instanceof Error ? error.name : "UnknownError"}`,
    );
  } finally {
    await appClient.end();
  }
}

function decryptCpf(ciphertext) {
  const [, version, ivText, tagText, dataText] = String(ciphertext).split(":");
  if (version !== "v1") throw new Error("ciphertext de CPF incompatível");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(process.env.FIELD_ENCRYPTION_KEY, "hex"),
    Buffer.from(ivText, "base64url"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function jsonBody(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function cookies(values) {
  return values
    .map((value) => String(value).split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
}

function csrfCookie(values) {
  return (
    values
      .map((value) => String(value))
      .filter((value) => /^csrf-token=.+/.test(value))
      .at(-1)
      ?.split(";", 1)[0] || ""
  );
}

async function createSession(user) {
  let csrf;
  try {
    csrf = await fetch(`${API_URL}/auth/csrf`, {
      headers: {
        "x-forwarded-for": "10.246.0.1",
        "x-loadtest-run-id": RUN_ID,
        "user-agent": "be010-gate/1.0",
      },
    });
  } catch (error) {
    throw new Error(
      `CSRF fetch falhou: ${error instanceof Error ? error.name : "UnknownError"}`,
    );
  }
  const csrfBody = await jsonBody(csrf);
  const csrfSetCookies =
    typeof csrf.headers.getSetCookie === "function"
      ? csrf.headers.getSetCookie()
      : [csrf.headers.get("set-cookie") || ""];
  const csrfHeaderCookie = csrfCookie(csrfSetCookies);
  if (!csrf.ok || !csrfBody?.csrfToken || !csrfHeaderCookie) {
    throw new Error("CSRF inicial falhou");
  }

  const login = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: csrfHeaderCookie,
      "x-csrf-token": csrfBody.csrfToken,
      "x-forwarded-for": "10.246.0.2",
      "x-loadtest-run-id": RUN_ID,
      "user-agent": "be010-gate/1.0",
    },
    body: JSON.stringify({ cpf: user.cpf, password: PASSWORD }),
  });
  const loginBody = await jsonBody(login);
  const loginSetCookies =
    typeof login.headers.getSetCookie === "function"
      ? login.headers.getSetCookie()
      : [login.headers.get("set-cookie") || ""];
  if (!login.ok || typeof loginBody?.accessToken !== "string") {
    const publicMessage =
      typeof loginBody?.message === "string" ? loginBody.message : "unknown";
    throw new Error(
      `login sintético falhou: HTTP ${login.status} message=${publicMessage}`,
    );
  }
  return {
    accessToken: loginBody.accessToken,
    cookie: cookies([csrfHeaderCookie, ...loginSetCookies]),
    csrfToken: csrfBody.csrfToken,
  };
}

async function call(session, method, path) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "x-forwarded-for": "10.246.0.3",
        "x-loadtest-run-id": RUN_ID,
        "user-agent": "be010-gate/1.0",
      },
    });
  } catch (error) {
    throw new Error(
      `${method} ${path} fetch falhou: ${error instanceof Error ? error.name : "UnknownError"}`,
    );
  }
  return { status: response.status, body: await jsonBody(response) };
}

async function waitForTerminal(job, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let state = await job.getState();
  while (!["completed", "failed", "cancelled"].includes(state)) {
    if (Date.now() >= deadline) throw new Error(`job não terminou: ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = await job.getState();
  }
  return state;
}

async function waitForReportArtifact(
  client,
  companyId,
  year,
  month,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let report;
  do {
    const reportResult = await client.query(
      `SELECT id, pdf_file_key, pdf_file_hash, pdf_generated_at
         FROM reports
        WHERE company_id = $1 AND ano = $2 AND mes = $3
          AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [companyId, year, month],
    );
    report = reportResult.rows[0];
    if (report?.pdf_file_key && report.pdf_file_hash) return report;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  return report;
}

async function cleanupReportExactly(
  client,
  reportId,
  companyId,
  storageRoot,
  expectedPhysicalPath,
) {
  const reportResult = await client.query(
    `SELECT id, company_id, pdf_file_key
       FROM reports
      WHERE id = $1 AND company_id = $2
      LIMIT 1`,
    [reportId, companyId],
  );
  const report = reportResult.rows[0];
  if (!report) throw new Error("relatório sintético não pertence à fixture");

  let physicalPath;
  if (report.pdf_file_key) {
    physicalPath = path.resolve(storageRoot, report.pdf_file_key);
    if (!physicalPath.startsWith(`${storageRoot}${path.sep}`)) {
      throw new Error("chave de cleanup saiu do storage root permitido");
    }
    if (expectedPhysicalPath && physicalPath !== expectedPhysicalPath) {
      throw new Error("chave física do relatório divergiu da leitura validada");
    }
  }

  const registryResult = await client.query(
    `SELECT id, file_key, status, deleted_at
       FROM document_registry
      WHERE company_id = $1
        AND module = 'report'
        AND entity_id = $2
        AND document_type = 'pdf'
      LIMIT 1`,
    [companyId, reportId],
  );
  const registry = registryResult.rows[0];
  if (
    registry &&
    report.pdf_file_key &&
    registry.file_key !== report.pdf_file_key
  ) {
    throw new Error("registry sintético divergiu da chave do relatório");
  }

  await client.query("BEGIN");
  try {
    if (registry) {
      await client.query(
        `UPDATE document_registry
            SET status = 'EXPIRED', deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
          WHERE id = $1
            AND company_id = $2
            AND module = 'report'
            AND entity_id = $3
            AND document_type = 'pdf'`,
        [registry.id, companyId, reportId],
      );
    }
    await client.query(
      `UPDATE reports
          SET deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND company_id = $2`,
      [reportId, companyId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  if (physicalPath && fs.existsSync(physicalPath)) {
    fs.unlinkSync(physicalPath);
  }

  const residual = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM reports
         WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL)::int AS active_reports,
       (SELECT COUNT(*) FROM document_registry
         WHERE company_id = $2 AND module = 'report' AND entity_id = $1
           AND document_type = 'pdf' AND deleted_at IS NULL)::int AS active_registry`,
    [reportId, companyId],
  );
  const row = residual.rows[0];
  const storageObjectRemoved =
    physicalPath === undefined || !fs.existsSync(physicalPath);
  if (row.active_reports !== 0 || row.active_registry !== 0) {
    throw new Error("estado ativo do relatório sintético permaneceu");
  }
  if (!storageObjectRemoved)
    throw new Error("objeto físico sintético presente");
  return { storageObjectRemoved, physicalPath };
}

async function cleanupReportWithApi(
  client,
  session,
  reportId,
  companyId,
  storageRoot,
  expectedPhysicalPath,
) {
  let apiDeleteStatus = null;
  let apiDeleteError = false;
  if (session) {
    try {
      const deleted = await call(session, "DELETE", `/reports/${reportId}`);
      apiDeleteStatus = deleted.status;
      if (![200, 204].includes(deleted.status)) apiDeleteError = true;
    } catch {
      apiDeleteError = true;
    }
  }
  const exactCleanup = await cleanupReportExactly(
    client,
    reportId,
    companyId,
    storageRoot,
    expectedPhysicalPath,
  );
  return {
    reportDeleted: true,
    storageObjectRemoved: exactCleanup.storageObjectRemoved,
    apiDeleteStatus,
    cleanupMode:
      apiDeleteStatus !== null && !apiDeleteError
        ? "api-delete-plus-exact-verification"
        : "exact-migration-cleanup",
  };
}

async function main() {
  if (
    process.env.APP_ENV !== "loadtest" ||
    process.env.APP_LOADTEST_MARKER !== "sgs-loadtest" ||
    process.env.DATABASE_NAME !== "sgs_loadtest" ||
    !PASSWORD ||
    !process.env.FIELD_ENCRYPTION_KEY ||
    !process.env.FIELD_ENCRYPTION_HASH_KEY
  ) {
    throw new Error("guard de loadtest recusou o ambiente");
  }

  const client = new Client({
    connectionString:
      process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL,
  });
  const queue = new Queue("pdf-generation", {
    connection: { url: process.env.REDIS_QUEUE_URL },
  });
  await client.connect();
  let session;
  let sessionB;
  let job;
  let jobB;
  let jobId;
  let jobIdB;
  let reportId;
  let reportIdB;
  let physicalPath;
  let physicalPathB;
  let output;
  let fixtureCreated = false;
  let fixtureBCreated = false;
  const storageRoot = path.resolve(
    process.env.LOCAL_DOCUMENT_STORAGE_DIR || "/app/loadtest-data/documents",
  );
  const cleanup = {
    reportDeleted: false,
    reportBDeleted: false,
    jobRemoved: false,
    jobBRemoved: false,
    storageObjectRemoved: false,
    storageObjectBRemoved: false,
    fixtureDeleted: false,
    fixtureBDeleted: false,
    reportApiDeleteStatus: null,
    reportBApiDeleteStatus: null,
    reportCleanupMode: null,
    reportBCleanupMode: null,
  };
  const cleanupErrors = [];
  let cleanupFailure;
  try {
    await provisionFixture(client);
    fixtureCreated = true;
    await provisionFixture(client, FIXTURE_B);
    fixtureBCreated = true;
    const userResult = await client.query(
      `SELECT id, company_id, site_id, cpf_ciphertext
         FROM users
        WHERE id = $1
          AND company_id = $2
           AND status = true
           AND deleted_at IS NULL
        LIMIT 1`,
      [FIXTURE.userId, FIXTURE.companyId],
    );
    const user = userResult.rows[0];
    if (!user?.cpf_ciphertext) throw new Error("fixture sintética A ausente");

    const userBResult = await client.query(
      `SELECT id, company_id, site_id, cpf_ciphertext
         FROM users
        WHERE id = $1
          AND company_id = $2
           AND status = true
           AND deleted_at IS NULL
        LIMIT 1`,
      [FIXTURE_B.userId, FIXTURE_B.companyId],
    );
    const userB = userBResult.rows[0];
    if (!userB?.cpf_ciphertext) throw new Error("fixture sintética B ausente");

    await assertFixtureAuthMaterial(client);
    await assertApplicationLoginLookup();
    await assertFixtureAuthMaterial(client, FIXTURE_B);
    await assertApplicationLoginLookup(FIXTURE_B);
    session = await createSession({ cpf: FIXTURE.cpf });
    sessionB = await createSession({ cpf: FIXTURE_B.cpf });
    const existingReport = await client.query(
      `SELECT id
         FROM reports
        WHERE company_id = $1
          AND ano = $2
          AND mes = $3
          AND deleted_at IS NULL
        LIMIT 1`,
      [user.company_id, REPORT_YEAR, REPORT_MONTH],
    );
    if (existingReport.rowCount) {
      throw new Error("período sintético já possui relatório ativo");
    }
    const existingReportB = await client.query(
      `SELECT id
         FROM reports
        WHERE company_id = $1
          AND ano = $2
          AND mes = $3
          AND deleted_at IS NULL
        LIMIT 1`,
      [userB.company_id, REPORT_YEAR, REPORT_MONTH],
    );
    if (existingReportB.rowCount) {
      throw new Error("período sintético B já possui relatório ativo");
    }

    const reportPath = `/reports/monthly?year=${REPORT_YEAR}&month=${REPORT_MONTH}`;
    const [enqueue, enqueueB] = await Promise.all([
      call(session, "GET", reportPath),
      call(sessionB, "GET", reportPath),
    ]);
    if (enqueue.status !== 200 || typeof enqueue.body?.jobId !== "string") {
      throw new Error(`enqueue de relatório falhou: HTTP ${enqueue.status}`);
    }
    jobId = enqueue.body.jobId;
    if (enqueueB.status !== 200 || typeof enqueueB.body?.jobId !== "string") {
      throw new Error(`enqueue de relatório B falhou: HTTP ${enqueueB.status}`);
    }
    jobIdB = enqueueB.body.jobId;

    const duplicateEnqueue = await call(session, "GET", reportPath);
    if (
      duplicateEnqueue.status !== 200 ||
      duplicateEnqueue.body?.jobId !== enqueue.body.jobId
    ) {
      throw new Error(
        "submissão duplicada não reutilizou o job determinístico",
      );
    }

    job = await queue.getJob(enqueue.body.jobId);
    if (!job) throw new Error("job de PDF não encontrado no Redis");
    jobB = await queue.getJob(enqueueB.body.jobId);
    if (!jobB) throw new Error("job de PDF B não encontrado no Redis");
    const [state, stateB] = await Promise.all([
      waitForTerminal(job, JOB_WAIT_TIMEOUT_MS),
      waitForTerminal(jobB, JOB_WAIT_TIMEOUT_MS),
    ]);
    if (state !== "completed" || stateB !== "completed") {
      throw new Error(`job de PDF terminou em ${state}/${stateB}`);
    }

    const report = await waitForReportArtifact(
      client,
      user.company_id,
      REPORT_YEAR,
      REPORT_MONTH,
    );
    if (report) reportId = report.id;
    if (!report?.pdf_file_key || !report.pdf_file_hash) {
      throw new Error("job concluído sem hash/chave governada no relatório");
    }

    const reportB = await waitForReportArtifact(
      client,
      userB.company_id,
      REPORT_YEAR,
      REPORT_MONTH,
    );
    if (reportB) reportIdB = reportB.id;
    if (!reportB?.pdf_file_key || !reportB.pdf_file_hash) {
      throw new Error("job B concluído sem hash/chave governada no relatório");
    }

    const access = await call(session, "GET", `/reports/${report.id}/pdf`);
    if (access.status !== 200 || access.body?.hasFinalPdf !== true) {
      throw new Error(`acesso governado do PDF falhou: HTTP ${access.status}`);
    }

    const crossTenantAccess = await call(
      sessionB,
      "GET",
      `/reports/${report.id}/pdf`,
    );
    if (![403, 404].includes(crossTenantAccess.status)) {
      throw new Error(
        `isolamento cross-tenant falhou: HTTP ${crossTenantAccess.status}`,
      );
    }
    const crossTenantJob = await call(
      sessionB,
      "GET",
      `/reports/status/${jobId}`,
    );
    if (![403, 404].includes(crossTenantJob.status)) {
      throw new Error(
        `visibilidade cross-tenant do job falhou: HTTP ${crossTenantJob.status}`,
      );
    }

    const accessB = await call(sessionB, "GET", `/reports/${reportB.id}/pdf`);
    if (accessB.status !== 200 || accessB.body?.hasFinalPdf !== true) {
      throw new Error(
        `acesso governado do PDF B falhou: HTTP ${accessB.status}`,
      );
    }

    physicalPath = path.resolve(storageRoot, report.pdf_file_key);
    if (!physicalPath.startsWith(`${storageRoot}${path.sep}`)) {
      throw new Error("chave física saiu do storage root permitido");
    }
    physicalPathB = path.resolve(storageRoot, reportB.pdf_file_key);
    if (!physicalPathB.startsWith(`${storageRoot}${path.sep}`)) {
      throw new Error("chave física B saiu do storage root permitido");
    }

    let pdf;
    try {
      pdf = fs.readFileSync(physicalPath);
    } catch (error) {
      throw new Error(
        `leitura física do PDF falhou: ${error instanceof Error ? error.name : "UnknownError"} ${error && typeof error === "object" && "code" in error ? error.code : ""}`,
      );
    }
    const actualHash = crypto.createHash("sha256").update(pdf).digest("hex");
    const integrity =
      pdf.subarray(0, 5).toString("latin1") === "%PDF-" &&
      pdf.includes(Buffer.from("%%EOF")) &&
      actualHash === report.pdf_file_hash;
    if (!integrity)
      throw new Error("integridade física do PDF do worker falhou");

    let pdfB;
    try {
      pdfB = fs.readFileSync(physicalPathB);
    } catch (error) {
      throw new Error(
        `leitura física do PDF B falhou: ${error instanceof Error ? error.name : "UnknownError"} ${error && typeof error === "object" && "code" in error ? error.code : ""}`,
      );
    }
    const actualHashB = crypto.createHash("sha256").update(pdfB).digest("hex");
    const integrityB =
      pdfB.subarray(0, 5).toString("latin1") === "%PDF-" &&
      pdfB.includes(Buffer.from("%%EOF")) &&
      actualHashB === reportB.pdf_file_hash;
    if (!integrityB)
      throw new Error("integridade física do PDF B do worker falhou");

    output = {
      pass: true,
      runId: RUN_ID,
      marker: MARKER,
      tenantHash: safeHash(user.company_id),
      reportPeriod: `${REPORT_YEAR}-${String(REPORT_MONTH).padStart(2, "0")}`,
      jobState: state,
      reportIdPrefix: String(report.id).slice(0, 8),
      storageKeyTenantScoped: String(report.pdf_file_key).startsWith(
        `documents/${user.company_id}/`,
      ),
      pdf: {
        bytes: pdf.length,
        sha256Short: safeHash(pdf),
        header: pdf.subarray(0, 5).toString("latin1"),
        eof: pdf.includes(Buffer.from("%%EOF")),
      },
      physicalStorage: "local-fs-shared-volume",
      governedAccess: true,
      duplicateSubmissionReusedJob: true,
      tenantB: {
        tenantHash: safeHash(userB.company_id),
        reportIdPrefix: String(reportB.id).slice(0, 8),
        storageKeyTenantScoped: String(reportB.pdf_file_key).startsWith(
          `documents/${userB.company_id}/`,
        ),
        pdf: {
          bytes: pdfB.length,
          sha256Short: safeHash(pdfB),
          header: pdfB.subarray(0, 5).toString("latin1"),
          eof: pdfB.includes(Buffer.from("%%EOF")),
        },
        governedAccess: true,
      },
      crossTenantPdfDenied: true,
      crossTenantJobDenied: true,
      concurrentTenantJobs: true,
    };
  } finally {
    if (reportId) {
      try {
        const result = await cleanupReportWithApi(
          client,
          session,
          reportId,
          FIXTURE.companyId,
          storageRoot,
          physicalPath,
        );
        cleanup.reportDeleted = result.reportDeleted;
        cleanup.storageObjectRemoved = result.storageObjectRemoved;
        cleanup.reportApiDeleteStatus = result.apiDeleteStatus;
        cleanup.reportCleanupMode = result.cleanupMode;
      } catch (error) {
        cleanupFailure ||= error;
        cleanupErrors.push(
          `report=${error instanceof Error ? error.constructor.name : "UnknownError"}${cleanup.reportApiDeleteStatus === null ? "" : `:${cleanup.reportApiDeleteStatus}`}`,
        );
      }
    }
    if (reportIdB) {
      try {
        const result = await cleanupReportWithApi(
          client,
          sessionB,
          reportIdB,
          FIXTURE_B.companyId,
          storageRoot,
          physicalPathB,
        );
        cleanup.reportBDeleted = result.reportDeleted;
        cleanup.storageObjectBRemoved = result.storageObjectRemoved;
        cleanup.reportBApiDeleteStatus = result.apiDeleteStatus;
        cleanup.reportBCleanupMode = result.cleanupMode;
      } catch (error) {
        cleanupFailure ||= error;
        cleanupErrors.push(
          `reportB=${error instanceof Error ? error.constructor.name : "UnknownError"}${cleanup.reportBApiDeleteStatus === null ? "" : `:${cleanup.reportBApiDeleteStatus}`}`,
        );
      }
    }
    if (jobId) {
      try {
        const currentJob = job || (await queue.getJob(jobId));
        if (currentJob) await currentJob.remove();
        cleanup.jobRemoved = !(await queue.getJob(jobId));
        if (!cleanup.jobRemoved) throw new Error("job ainda presente");
      } catch (error) {
        cleanupFailure ||= error;
        cleanupErrors.push(
          `job=${error instanceof Error ? error.constructor.name : "UnknownError"}`,
        );
      }
    } else {
      cleanup.jobRemoved = true;
    }
    if (jobIdB) {
      try {
        const currentJob = jobB || (await queue.getJob(jobIdB));
        if (currentJob) await currentJob.remove();
        cleanup.jobBRemoved = !(await queue.getJob(jobIdB));
        if (!cleanup.jobBRemoved) throw new Error("job B ainda presente");
      } catch (error) {
        cleanupFailure ||= error;
        cleanupErrors.push(
          `jobB=${error instanceof Error ? error.constructor.name : "UnknownError"}`,
        );
      }
    } else {
      cleanup.jobBRemoved = true;
    }
    if (fixtureCreated) {
      try {
        await softDeleteFixture(client);
        cleanup.fixtureDeleted = true;
      } catch (error) {
        cleanupFailure ||= error;
        cleanupErrors.push(
          `fixture=${error instanceof Error ? error.constructor.name : "UnknownError"}`,
        );
      }
    } else {
      cleanup.fixtureDeleted = true;
    }
    if (fixtureBCreated) {
      try {
        await softDeleteFixture(client, FIXTURE_B);
        cleanup.fixtureBDeleted = true;
      } catch (error) {
        cleanupFailure ||= error;
        cleanupErrors.push(
          `fixtureB=${error instanceof Error ? error.constructor.name : "UnknownError"}`,
        );
      }
    } else {
      cleanup.fixtureBDeleted = true;
    }
    await queue.close();
    await client.end();
    if (cleanupFailure) {
      throw new Error(
        `cleanup bounded falhou: ${cleanupErrors.join(",") || (cleanupFailure instanceof Error ? cleanupFailure.constructor.name : "UnknownError")}`,
      );
    }
  }
  if (!output) throw new Error("probe não produziu resultado");
  if (
    !cleanup.reportDeleted ||
    !cleanup.reportBDeleted ||
    !cleanup.jobRemoved ||
    !cleanup.jobBRemoved ||
    !cleanup.storageObjectRemoved ||
    !cleanup.storageObjectBRemoved ||
    !cleanup.fixtureDeleted ||
    !cleanup.fixtureBDeleted
  ) {
    throw new Error("cleanup bounded do RUN_ID não foi confirmado");
  }
  console.log(JSON.stringify({ ...output, cleanup }));
}

main().catch((error) => {
  console.error(
    `[BE010-FAIL] ${error instanceof Error ? error.message : String(error)} runId=${RUN_ID}`,
  );
  process.exitCode = 1;
});
