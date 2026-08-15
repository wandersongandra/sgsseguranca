import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE_URL = String(
  process.env.APR_REMOTE_BASE_URL || 'http://127.0.0.1:3001',
).replace(/\/$/, '');
const CPF = String(process.env.LOADTEST_ADMIN_CPF || '');
const PASSWORD = String(process.env.LOADTEST_ADMIN_PASSWORD || '');
const COMPANY_ID = String(process.env.LOADTEST_COMPANY_ID || '');
const SITE_ID = String(process.env.LOADTEST_SITE_ID || '');
const USER_ID = String(process.env.LOADTEST_USER_ID || '');

function envInt(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function assertLoadtestOnly() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('NODE_ENV=production bloqueado.');
  if (
    process.env.APP_ENV !== 'loadtest' ||
    process.env.APP_LOADTEST_MARKER !== 'sgs-loadtest'
  ) {
    throw new Error(
      'Marcador APP_ENV=loadtest/APP_LOADTEST_MARKER=sgs-loadtest ausente.',
    );
  }
  if (!/^\d{11}$/.test(CPF) || !PASSWORD)
    throw new Error('Credencial sintética ausente.');
  for (const [name, value] of Object.entries(process.env)) {
    const normalized = String(value || '').toLowerCase();
    if (
      [
        'neon.tech',
        'upstash.io',
        'backblaze',
        'api.sgsseguranca.com.br',
        'app.sgsseguranca.com.br',
      ].some((marker) => normalized.includes(marker))
    ) {
      throw new Error(`Marcador externo/produção detectado em ${name}.`);
    }
  }
}

function assertConcurrencyCapacity(concurrency) {
  if (concurrency <= 20) return;
  if (process.env.APR_REMOTE_ALLOW_HIGH_CONCURRENCY !== 'true') {
    throw new Error(
      'Acima de 20 workers exige APR_REMOTE_ALLOW_HIGH_CONCURRENCY=true.',
    );
  }
  const minFreeMb = envInt('APR_REMOTE_MIN_FREE_MEMORY_MB', 8192, 2048, 65536);
  const freeMb = Math.floor(os.freemem() / (1024 * 1024));
  if (freeMb < minFreeMb) {
    throw new Error(
      `Concorrência ${concurrency} bloqueada: ${freeMb} MB livres; mínimo configurado ${minFreeMb} MB.`,
    );
  }
}

class HttpSession {
  constructor() {
    this.cookies = new Map();
    this.accessToken = '';
    this.csrfToken = '';
  }

  updateCookies(response) {
    const values =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (response.headers.get('set-cookie') || '').split(/,(?=[^;]+?=)/g);
    for (const value of values) {
      const pair = String(value).split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator > 0)
        this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  headers(extra = {}, mutating = false) {
    const headers = {
      Accept: 'application/json',
      'x-company-id': COMPANY_ID,
      ...extra,
    };
    const cookie = [...this.cookies.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
    if (cookie) headers.Cookie = cookie;
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    if (mutating && this.csrfToken) headers['x-csrf-token'] = this.csrfToken;
    return headers;
  }

  async request(method, endpoint, body, mutating = false) {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: this.headers(
        body === undefined ? {} : { 'Content-Type': 'application/json' },
        mutating,
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.updateCookies(response);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text.slice(0, 500);
    }
    return { status: response.status, body: parsed };
  }
}

async function login() {
  const session = new HttpSession();
  const csrf = await session.request('GET', '/auth/csrf');
  session.csrfToken = String(csrf.body?.csrfToken || '');
  if (csrf.status !== 200 || !session.csrfToken)
    throw new Error(`CSRF HTTP ${csrf.status}`);
  const login = await session.request(
    'POST',
    '/auth/login',
    { cpf: CPF, password: PASSWORD },
    true,
  );
  session.accessToken = String(login.body?.accessToken || '');
  if (![200, 201].includes(login.status) || !session.accessToken)
    throw new Error(`login HTTP ${login.status}`);
  const me = await session.request('GET', '/auth/me');
  if (me.status !== 200 || me.body?.user?.company_id !== COMPANY_ID)
    throw new Error(`auth/me inválido HTTP ${me.status}`);
  return session;
}

async function emitOne(session, index, prefix) {
  const startedAt = Date.now();
  const numero = `${prefix}-${String(index + 1).padStart(4, '0')}`;
  try {
    const created = await session.request(
      'POST',
      '/aprs',
      {
        numero,
        titulo: `APR VPS load-test ${String(index + 1).padStart(4, '0')}`,
        data_inicio: '2026-08-13',
        data_fim: '2026-08-14',
        site_id: SITE_ID,
        elaborador_id: USER_ID,
        participants: [USER_ID],
        risk_items: [
          {
            atividade: 'Operação sintética de carga',
            agente_ambiental: 'Ruído',
            condicao_perigosa: 'Exposição eventual',
            fonte_circunstancia: 'Fixture load-test',
            lesao: 'Perda auditiva',
            probabilidade: 2,
            severidade: 2,
            medidas_prevencao: 'Uso de EPI sintético',
            responsavel: 'Administrador de teste',
          },
        ],
      },
      true,
    );
    if (created.status !== 201)
      throw new Error(
        `criação HTTP ${created.status}: ${JSON.stringify(created.body)}`,
      );
    const id = String(created.body?.id || '');
    if (!id) throw new Error('criação sem id');

    const signature = await session.request(
      'POST',
      '/signatures',
      {
        document_id: id,
        document_type: 'APR',
        signature_data: `assinatura-sintetica-vps-${index + 1}`,
        type: 'drawn',
      },
      true,
    );
    if (signature.status !== 201)
      throw new Error(
        `assinatura HTTP ${signature.status}: ${JSON.stringify(signature.body)}`,
      );

    const approval = await session.request(
      'PATCH',
      `/aprs/${id}/approve`,
      { reason: 'Aprovação sintética do lote VPS.' },
      true,
    );
    if (![200, 201].includes(approval.status))
      throw new Error(
        `aprovação HTTP ${approval.status}: ${JSON.stringify(approval.body)}`,
      );

    const pdf = await session.request(
      'POST',
      `/aprs/${id}/generate-final-pdf`,
      undefined,
      true,
    );
    if (![200, 201].includes(pdf.status))
      throw new Error(`PDF HTTP ${pdf.status}: ${JSON.stringify(pdf.body)}`);

    const finalized = await session.request(
      'PATCH',
      `/aprs/${id}/finalize`,
      undefined,
      true,
    );
    if (![200, 201].includes(finalized.status))
      throw new Error(
        `finalização HTTP ${finalized.status}: ${JSON.stringify(finalized.body)}`,
      );

    const detail = await session.request('GET', `/aprs/${id}`);
    if (detail.status !== 200)
      throw new Error(
        `consulta final HTTP ${detail.status}: ${JSON.stringify(detail.body)}`,
      );
    return {
      index,
      numero,
      id,
      status: 'Encerrada',
      durationMs: Date.now() - startedAt,
      finalPdfHashSha256: detail.body?.final_pdf_hash_sha256 || null,
    };
  } catch (error) {
    return {
      index,
      numero,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function recoverOne(session, id) {
  const detail = await session.request('GET', `/aprs/${id}`);
  if (detail.status !== 200)
    throw new Error(`consulta ${id} HTTP ${detail.status}`);
  let current = detail.body;
  if (current?.status === 'Pendente') {
    const signature = await session.request(
      'POST',
      '/signatures',
      {
        document_id: id,
        document_type: 'APR',
        signature_data: `assinatura-sintetica-vps-recovery-${id}`,
        type: 'drawn',
      },
      true,
    );
    if (signature.status !== 201)
      throw new Error(`assinatura recovery HTTP ${signature.status}`);
    const approval = await session.request(
      'PATCH',
      `/aprs/${id}/approve`,
      { reason: 'Recuperação sintética do lote VPS.' },
      true,
    );
    if (![200, 201].includes(approval.status))
      throw new Error(`aprovação recovery HTTP ${approval.status}`);
    current = approval.body;
  }
  if (current?.status !== 'Encerrada') {
    if (!current?.final_pdf_hash_sha256) {
      const pdf = await session.request(
        'POST',
        `/aprs/${id}/generate-final-pdf`,
        undefined,
        true,
      );
      if (![200, 201].includes(pdf.status))
        throw new Error(`PDF recovery HTTP ${pdf.status}`);
    }
    const finalized = await session.request(
      'PATCH',
      `/aprs/${id}/finalize`,
      undefined,
      true,
    );
    if (![200, 201].includes(finalized.status))
      throw new Error(`finalização recovery HTTP ${finalized.status}`);
  }
  const verified = await session.request('GET', `/aprs/${id}`);
  if (verified.status !== 200 || verified.body?.status !== 'Encerrada')
    throw new Error(`pós-condição recovery inválida para ${id}`);
  return { id, status: 'Encerrada' };
}

async function main() {
  assertLoadtestOnly();
  const total = envInt('APR_REMOTE_TOTAL', 100, 1, 100);
  const startIndex = envInt('APR_REMOTE_START_INDEX', 0, 0, 99);
  if (startIndex + total > 100)
    throw new Error(
      'APR_REMOTE_START_INDEX + APR_REMOTE_TOTAL não pode exceder 100.',
    );
  const requested = Number(process.env.APR_REMOTE_CONCURRENCY ?? 5);
  if (Number.isFinite(requested) && requested > 100)
    throw new Error('APR_REMOTE_CONCURRENCY máximo é 100.');
  const concurrency = envInt(
    'APR_REMOTE_CONCURRENCY',
    5,
    1,
    Math.min(total, 100),
  );
  assertConcurrencyCapacity(concurrency);
  const prefix = String(
    process.env.APR_REMOTE_PREFIX || `APR-VPS-LOADTEST-${Date.now()}`,
  )
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 42);
  const delayMs = envInt('APR_REMOTE_DELAY_MS', 0, 0, 60000);
  const reportFile =
    process.env.APR_REMOTE_REPORT_FILE || '/tmp/apr-remote-batch-report.json';
  const session = await login();
  const recoveryIds = String(process.env.APR_REMOTE_RECOVER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (recoveryIds.length) {
    const recovered = [];
    for (const id of recoveryIds) {
      try {
        recovered.push(await recoverOne(session, id));
        console.log(`[RECOVERY] OK ${id}`);
      } catch (error) {
        recovered.push({ id, status: 'failed', error: errorMessage(error) });
        console.log(`[RECOVERY] FAIL ${id} ${errorMessage(error)}`);
      }
      if (delayMs > 0) await sleep(delayMs);
    }
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(
      reportFile,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), recovery: recovered }, null, 2)}\n`,
      'utf8',
    );
    if (recovered.some((item) => item.status === 'failed'))
      process.exitCode = 1;
    return;
  }
  const results = Array(total);
  let nextIndex = 0;
  const startedAt = Date.now();
  async function worker() {
    while (true) {
      const index = startIndex + nextIndex++;
      if (index >= startIndex + total) return;
      results[index - startIndex] = await emitOne(session, index, prefix);
      const result = results[index - startIndex];
      console.log(
        `[${index + 1}/${total}] ${result.status === 'Encerrada' ? 'OK' : 'FAIL'} ${result.numero} ${result.durationMs}ms`,
      );
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const successful = results.filter((result) => result.status === 'Encerrada');
  const failed = results.filter((result) => result.status === 'failed');
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    total,
    startIndex,
    concurrency,
    delayMs,
    successful: successful.length,
    failed: failed.length,
    elapsedMs: Date.now() - startedAt,
    results,
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`APR_REMOTE_REPORT=${reportFile}`);
  console.log(
    `APR_REMOTE_RESULT total=${total} concurrency=${concurrency} success=${successful.length} failed=${failed.length} elapsedMs=${report.elapsedMs}`,
  );
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
