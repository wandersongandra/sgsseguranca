/**
 * prod-gandra-mail-smoke.js
 *
 * Valida o pipeline de e-mail em produção:
 *  1. Checa provider configurado (Resend / SMTP)
 *  2. Checa logs recentes (últimos 20)
 *  3. Dispara alerta de conformidade e confirma entrega via mail_logs
 *  4. Envia documento (APR emitida anteriormente) por e-mail e confirma entrega
 *
 * Uso:
 *   TEST_COMPANY_ID=<uuid> SMOKE_MAIL_RECIPIENT=seu@email.com \
 *   PROD_SMOKE_API_BASE_URL=https://api.sgsseguranca.com.br \
 *   node scripts/prod-gandra-mail-smoke.js
 *
 * Variáveis opcionais (lidas de .env / temp/prod-safe-test-gandra.env):
 *   PROD_SMOKE_CPF / PROD_SMOKE_PASSWORD  — credenciais do usuário admin de smoke
 *   APR_ID_FOR_MAIL_TEST                   — ID de APR existente para teste de envio de doc
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { connectRuntimePgClient } = require('./lib/pg-runtime-client');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({
  path: path.resolve(__dirname, '../../temp/prod-safe-test-gandra.env'),
});

const API_BASE_URL = String(
  process.env.PROD_SMOKE_API_BASE_URL || 'https://api.sgsseguranca.com.br',
).replace(/\/$/, '');

const TEST_COMPANY_ID = String(process.env.TEST_COMPANY_ID || '').trim();
const TEST_COMPANY_NAME = String(
  process.env.TEST_COMPANY_NAME || 'Gandra Tecnologia',
).trim();
const SMOKE_MAIL_RECIPIENT = String(
  process.env.SMOKE_MAIL_RECIPIENT || '',
).trim();

const UA = 'sgs-prod-gandra-mail-smoke/1.0';

// ─── helpers ──────────────────────────────────────────────────────────────────

function log(tag, msg, extra) {
  const line = `[${tag}] ${msg}`;
  if (extra !== undefined) {
    console.log(line, typeof extra === 'object' ? JSON.stringify(extra, null, 2) : extra);
  } else {
    console.log(line);
  }
}

function step(n, msg) {
  console.log(`\n${'─'.repeat(60)}\nSTEP ${n}: ${msg}\n${'─'.repeat(60)}`);
}

function maskEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const visible = Math.min(4, Math.max(2, local.length));
  return `${local.slice(0, visible)}***@${domain}`;
}

function extractCookie(setCookieHeader, cookieName) {
  if (!setCookieHeader) return '';
  const chunks = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : String(setCookieHeader).split(/,(?=[^;]+?=)/g);
  let last = '';
  for (const chunk of chunks) {
    const match = String(chunk)
      .trim()
      .match(new RegExp(`^${cookieName}=([^;]+)`));
    if (match && match[1]) last = `${cookieName}=${match[1]}`;
  }
  return last;
}

async function login(cpf, password) {
  const csrfRes = await fetch(`${API_BASE_URL}/auth/csrf`, {
    headers: { 'User-Agent': UA },
  });
  const csrfBody = await csrfRes.json().catch(() => ({}));
  const csrfToken =
    typeof csrfBody?.csrfToken === 'string' ? csrfBody.csrfToken.trim() : '';
  const csrfCookie = extractCookie(csrfRes.headers.get('set-cookie'), 'csrf-token');
  if (!csrfRes.ok || !csrfToken || !csrfCookie)
    throw new Error(`Falha ao obter CSRF. status=${csrfRes.status}`);

  const loginRes = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'x-csrf-token': csrfToken,
      Cookie: csrfCookie,
    },
    body: JSON.stringify({ cpf, password }),
  });
  const loginBody = await loginRes.json().catch(() => ({}));
  if (!loginRes.ok || typeof loginBody?.accessToken !== 'string')
    throw new Error(
      `Falha no login. status=${loginRes.status} body=${JSON.stringify(loginBody)}`,
    );
  return { accessToken: loginBody.accessToken, user: loginBody.user || null };
}

async function getMutationCsrfHeaders() {
  const res = await fetch(`${API_BASE_URL}/auth/csrf`, {
    headers: { 'User-Agent': UA },
  });
  const body = await res.json().catch(() => ({}));
  const token = typeof body?.csrfToken === 'string' ? body.csrfToken.trim() : '';
  const cookie = extractCookie(res.headers.get('set-cookie'), 'csrf-token');
  if (!res.ok || !token || !cookie)
    throw new Error(`Falha CSRF mutação. status=${res.status}`);
  return { 'x-csrf-token': token, Cookie: cookie };
}

async function api(pathname, accessToken, options = {}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': UA,
    'x-company-id': TEST_COMPANY_ID,
    ...(options.headers || {}),
  };
  if (options.includeCsrf) Object.assign(headers, await getMutationCsrfHeaders());
  if (options.json) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${API_BASE_URL}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.json ? JSON.stringify(options.json) : options.body,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text || null; }
  return { status: response.status, ok: response.ok, body };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── smoke steps ──────────────────────────────────────────────────────────────

function assertSmokeConfiguration() {
  if (!TEST_COMPANY_ID) throw new Error('TEST_COMPANY_ID ausente. Defina na env.');
  if (TEST_COMPANY_NAME !== 'Gandra Tecnologia')
    throw new Error(`TEST_COMPANY_NAME inesperado: ${TEST_COMPANY_NAME}`);

  const cpf = process.env.PROD_SMOKE_CPF;
  const password = process.env.PROD_SMOKE_PASSWORD;
  if (!cpf || !password)
    throw new Error('PROD_SMOKE_CPF e PROD_SMOKE_PASSWORD são obrigatórios.');

  return { cpf, password };
}

function printSmokeHeader() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('SGS — Smoke de E-mail (produção)');
  console.log(`API: ${API_BASE_URL}`);
  console.log(`Empresa: ${TEST_COMPANY_NAME} (${TEST_COMPANY_ID})`);
  console.log(`Destinatário de teste: ${maskEmail(SMOKE_MAIL_RECIPIENT) || '(não definido)'}`);
  console.log(`${'═'.repeat(60)}\n`);
}

async function loginSmokeAdmin(cpf, password) {
  step(1, 'Login como admin');
  const { accessToken, user } = await login(cpf, password);
  log('OK', `Logado como ${user?.email || cpf} (role: ${user?.role || '?'})`);
  return accessToken;
}

async function verifyMailProvider(accessToken) {
  step(2, 'Verificar provider de e-mail configurado');
  const settingsRes = await api('/mail/alerts/settings', accessToken);
  if (!settingsRes.ok) {
    log('WARN', `Não foi possível ler configurações. status=${settingsRes.status}`, settingsRes.body);
  } else {
    const s = settingsRes.body;
    log('INFO', 'Configurações de alerta', {
      enabled: s?.enabled,
      providerConfigured: s?.providerConfigured,
      recipients: s?.recipients,
      fallbackRecipients: s?.fallbackRecipients,
      deliveryHour: s?.deliveryHour,
      weekdaysOnly: s?.weekdaysOnly,
      cadenceDays: s?.cadenceDays,
      nextScheduledDispatchAt: s?.nextScheduledDispatchAt,
    });
    if (!s?.providerConfigured) {
      log('ERROR', 'Nenhum provider de e-mail configurado no servidor! (RESEND_API_KEY / MAIL_HOST ausentes)');
      process.exitCode = 1;
    }
  }
}

async function previewComplianceAlerts(accessToken) {
  step(3, 'Preview de alertas de conformidade (sem enviar)');
  const previewRes = await api('/mail/alerts/preview', accessToken);
  if (!previewRes.ok) {
    log('WARN', `Falha no preview. status=${previewRes.status}`, previewRes.body);
  } else {
    const p = previewRes.body;
    log('INFO', 'Resumo de pendências', {
      pendingItemsCount: p?.pendingItemsCount,
      compliancePendingCount: p?.compliancePendingCount,
      operationsPendingCount: p?.operationsPendingCount,
      occurrencesPendingCount: p?.occurrencesPendingCount,
      generatedAt: p?.generatedAt,
    });
  }
}

async function inspectRecentMailLogs(accessToken) {
  step(4, 'Verificar logs de e-mail recentes');
  const logsRes = await api('/mail/logs?pageSize=10&page=1', accessToken);
  if (!logsRes.ok) {
    log('WARN', `Falha ao listar logs. status=${logsRes.status}`, logsRes.body);
  } else {
    const { items = [], total } = logsRes.body || {};
    log('INFO', `Total de logs: ${total}. Últimos ${items.length}:`);
    for (const entry of items) {
      const status = entry.status === 'success' ? '✓' : '✗';
      log(status === '✓' ? 'OK' : 'ERR', `[${entry.created_at?.slice(0, 19)}] ${status} to=${maskEmail(entry.to)} subject="${entry.subject}" provider_response=${entry.provider_response || '-'} msg_id=${entry.message_id || '-'}`);
      if (entry.error_message) log('DETAIL', `  erro: ${entry.error_message}`);
    }
    const errors = items.filter((e) => e.status === 'error');
    if (errors.length > 0) {
      log('WARN', `${errors.length} falha(s) nos últimos logs.`);
    } else if (items.length > 0) {
      log('OK', 'Todos os logs recentes com status=success.');
    } else {
      log('WARN', 'Nenhum log de e-mail encontrado. Nunca enviou ou logs foram limpos.');
    }
  }
}

async function dispatchComplianceAlert(accessToken) {
  step(5, `Disparar alerta de conformidade para ${maskEmail(SMOKE_MAIL_RECIPIENT)}`);
  const alertRes = await api('/mail/alerts/dispatch', accessToken, {
    method: 'POST',
    includeCsrf: true,
    json: { to: SMOKE_MAIL_RECIPIENT, includeWhatsapp: false },
  });
  if (!alertRes.ok) {
    log('ERROR', `Falha no disparo de alerta. status=${alertRes.status}`, alertRes.body);
    process.exitCode = 1;
  } else {
    log('OK', 'Alerta disparado', alertRes.body);
  }
}

async function verifyAlertDelivery(accessToken) {
  step(6, 'Aguardar 5s e verificar entrega nos logs');
  await sleep(5000);
  const logsAfterRes = await api('/mail/logs?pageSize=5&page=1', accessToken);
  if (logsAfterRes.ok) {
    const { items = [] } = logsAfterRes.body || {};
    const latest = items[0];
    if (!latest) {
      log('WARN', 'Nenhum log encontrado após disparo.');
    } else {
      log('INFO', 'Log mais recente', {
        status: latest.status,
        to: maskEmail(latest.to),
        subject: latest.subject,
        message_id: latest.message_id,
        provider_response: latest.provider_response,
        error_message: latest.error_message || null,
        created_at: latest.created_at,
      });
      if (latest.status === 'success') {
        log('OK', `E-mail entregue! message_id=${latest.message_id}`);
      } else {
        log('ERROR', `Entrega falhou: ${latest.error_message}`);
        process.exitCode = 1;
      }
    }
  }
}

async function sendAprDocument(accessToken, aprId) {
  step(7, `Enviar APR (${aprId}) por e-mail para ${maskEmail(SMOKE_MAIL_RECIPIENT)}`);
  const docMailRes = await api('/mail/send-stored-document', accessToken, {
    method: 'POST',
    includeCsrf: true,
    json: { documentId: aprId, documentType: 'APR', email: SMOKE_MAIL_RECIPIENT },
  });
  if (!docMailRes.ok) {
    log('ERROR', `Falha ao enfileirar envio de APR. status=${docMailRes.status}`, docMailRes.body);
    process.exitCode = 1;
  } else {
    log('OK', 'Envio de APR enfileirado', {
      deliveryMode: docMailRes.body?.deliveryMode,
      artifactType: docMailRes.body?.artifactType,
      isOfficial: docMailRes.body?.isOfficial,
      message: docMailRes.body?.message,
    });

    // Aguardar processamento do worker
    log('INFO', 'Aguardando 8s para o worker processar...');
    await sleep(8000);

    const logsDocRes = await api('/mail/logs?pageSize=3&page=1', accessToken);
    if (logsDocRes.ok) {
      const { items = [] } = logsDocRes.body || {};
      const latest = items[0];
      if (latest) {
        log('INFO', 'Log mais recente (envio doc)', {
          status: latest.status,
          subject: latest.subject,
          message_id: latest.message_id,
          provider_response: latest.provider_response,
          error_message: latest.error_message || null,
        });
        if (latest.status === 'success') {
          log('OK', `APR entregue por e-mail! message_id=${latest.message_id}`);
        } else {
          log('ERROR', `Entrega de APR falhou: ${latest.error_message}`);
          process.exitCode = 1;
        }
      }
    }
  }
}

function printFinalResult() {
  const exitCode = process.exitCode || 0;
  console.log(`\n${'═'.repeat(60)}`);
  if (exitCode === 0) {
    console.log('✓ SMOKE DE E-MAIL CONCLUÍDO COM SUCESSO');
  } else {
    console.log('✗ SMOKE DE E-MAIL FALHOU — veja os logs acima');
  }
  console.log(`${'═'.repeat(60)}\n`);
}

async function runEmailDeliverySmoke(accessToken) {
  if (!SMOKE_MAIL_RECIPIENT) {
    log('SKIP', 'SMOKE_MAIL_RECIPIENT não definido — pulando disparo de alerta e envio de documento.');
    console.log('\n✓ Smoke de e-mail concluído (steps 1-4 apenas — sem envio real).');
    return;
  }

  await dispatchComplianceAlert(accessToken);
  await verifyAlertDelivery(accessToken);

  const aprId = process.env.APR_ID_FOR_MAIL_TEST;
  if (aprId) {
    await sendAprDocument(accessToken, aprId);
  } else {
    log('SKIP', 'APR_ID_FOR_MAIL_TEST não definido — pulando envio de documento por e-mail.');
  }

  printFinalResult();
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { cpf, password } = assertSmokeConfiguration();
  printSmokeHeader();

  const accessToken = await loginSmokeAdmin(cpf, password);

  await verifyMailProvider(accessToken);
  await previewComplianceAlerts(accessToken);
  await inspectRecentMailLogs(accessToken);
  await runEmailDeliverySmoke(accessToken);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message || err);
  process.exit(1);
});
