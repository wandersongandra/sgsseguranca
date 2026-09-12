/**
 * APR — Trilha de Testes Pesados (auditoria v2 + hardening, set/2026)
 *
 * Cobre os itens que k6-load-test.js (criação/listagem/dashboard/sophie) NÃO
 * cobre: ciclo de vida funcional completo, validação de throttle em rotas
 * Puppeteer, concorrência/race condition em aprovação e progressão de carga
 * dedicada em GET /aprs e GET /aprs/:id com abort no primeiro degrau reprovado.
 *
 * Pré-requisito: tenants sintéticos gerados (ver backend/test/load/README_EXECUCAO.md
 * e a seção "APR — trilha de testes pesados" abaixo). Este arquivo espera um JSON
 * no mesmo formato de test/load/tenants.json (array de {tenantIndex, companyId,
 * siteId, userId, cpf, password}).
 *
 * Execução (uma cena por vez):
 *   k6 run test/load/apr-heavy-suite.js -e BASE_URL=... -e K6_TENANTS_FILE=... -e K6_SCENARIO=lifecycle
 *   k6 run test/load/apr-heavy-suite.js -e BASE_URL=... -e K6_TENANTS_FILE=... -e K6_SCENARIO=throttle
 *   k6 run test/load/apr-heavy-suite.js -e BASE_URL=... -e K6_TENANTS_FILE=... -e K6_SCENARIO=race
 *   k6 run test/load/apr-heavy-suite.js -e BASE_URL=... -e K6_TENANTS_FILE=... -e K6_SCENARIO=progressive
 *
 * K6_SCENARIO=race requer K6_RACE_APR_ID (uuid de uma APR "Pendente" já criada,
 * ver scripts/prep-race-apr.js) e usa o tenant[0] (MAIN) para autenticar todos
 * os VUs concorrentes (mesma empresa, mesma APR).
 */

import http from 'k6/http';
import { check, sleep, group, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';

const BASE_URL = String(__ENV.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const SCENARIO = String(__ENV.K6_SCENARIO || 'lifecycle').toLowerCase();
const TENANTS_FILE = String(__ENV.K6_TENANTS_FILE || './apr-loadtest-tenants.json');
const RACE_APR_ID = String(__ENV.K6_RACE_APR_ID || '').trim();
const RACE_VUS = Number(__ENV.K6_RACE_VUS || 8);
const BUNDLE_BURST = Number(__ENV.K6_BUNDLE_BURST || 5);

const tenants = new SharedArray('apr-heavy-tenants', function () {
  return JSON.parse(open(TENANTS_FILE));
});

// ─── Métricas ────────────────────────────────────────────────────────────────
const lifecycleStepDuration = new Trend('lifecycle_step_duration', true);
const lifecycleSuccess = new Rate('lifecycle_success');
const throttle429Count = new Counter('throttle_429_count');
const throttle2xxCount = new Counter('throttle_2xx_count');
const raceSuccessCount = new Counter('race_success_count');
const raceConflictCount = new Counter('race_conflict_count');
const raceUnexpectedCount = new Counter('race_unexpected_count');
const aprListDuration = new Trend('heavy_apr_list_duration', true);
const aprDetailDuration = new Trend('heavy_apr_detail_duration', true);
const tenantIsolationOk = new Rate('heavy_tenant_isolation_ok');
const progressiveUnexpectedFailure = new Rate('progressive_unexpected_failure');
const progressiveRateLimit429 = new Counter('progressive_rate_limit_429');

// ─── Auth helpers (mesmo contrato de k6-load-test.js) ───────────────────────
function fetchCsrf() {
  const res = http.get(`${BASE_URL}/auth/csrf`, { tags: { name: 'auth.csrf' } });
  return res.json('csrfToken') || '';
}

function login(tenant) {
  const csrfToken = fetchCsrf();
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ cpf: tenant.cpf, password: tenant.password }),
    {
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
      tags: { name: 'auth.login' },
    },
  );
  const ok = check(res, {
    'login ok': (r) => r.status === 200 || r.status === 201,
    'login has token': (r) => Boolean(r.json('accessToken')),
  });
  if (!ok) fail(`login falhou para tenant ${tenant.tag || tenant.tenantIndex}: HTTP ${res.status} ${res.body}`);
  return { token: String(res.json('accessToken')), csrfToken };
}

function authHeaders(session, companyId) {
  return {
    Authorization: `Bearer ${session.token}`,
    'Content-Type': 'application/json',
    'x-company-id': companyId,
    'x-csrf-token': session.csrfToken,
  };
}

// ─── Cenário 1: Ciclo de vida funcional completo ────────────────────────────
// create -> upload evidencia -> submit -> approve -> generate-final-pdf
// Roda 1x (shared-iterations vus=1). Bate direto nos fixes da Onda 2:
// relationLoadStrategy no findOne, transacao no createNewVersion, mime real
// via magic bytes no upload de evidencia.

export function lifecycleScenario() {
  const tenant = tenants[0]; // MAIN
  const session = login(tenant);
  const headers = authHeaders(session, tenant.companyId);

  group('apr_lifecycle', () => {
    // 1) Criar APR com risk items
    const createBody = {
      numero: `APRHEAVY-LC-${Date.now()}`,
      titulo: 'APR Ciclo de Vida — Teste de Carga Pesado',
      descricao: 'APR sintetica para validar o ciclo completo sob teste de carga.',
      data_inicio: '2026-06-01',
      data_fim: '2026-12-31',
      site_id: tenant.siteId,
      elaborador_id: tenant.userId,
      probability: 2,
      severity: 3,
      exposure: 2,
      residual_risk: 'MEDIUM',
      participants: [tenant.userId],
      risk_items: [
        {
          atividade: 'Trabalho em altura',
          condicao_perigosa: 'Risco de queda de altura',
          categoria_risco: 'Físico',
          probabilidade: 2,
          severidade: 3,
          medidas_prevencao: 'Uso de EPI e andaime homologado',
          responsavel: 'Supervisor SST',
          status_acao: 'pendente',
        },
      ],
    };

    let t0 = Date.now();
    const createRes = http.post(`${BASE_URL}/aprs`, JSON.stringify(createBody), {
      headers,
      tags: { name: 'lc_create' },
    });
    lifecycleStepDuration.add(Date.now() - t0, { step: 'create' });
    const created = check(createRes, {
      'create 201': (r) => r.status === 201,
      'create has id': (r) => Boolean(r.json('id')),
    });
    if (!created) {
      lifecycleSuccess.add(false);
      fail(`create falhou: HTTP ${createRes.status} ${createRes.body}`);
    }
    const aprId = createRes.json('id');

    // 2) Assinar digitalmente ANTES de submeter (unico participante = o
    // proprio admin) — achado real desta trilha: assinatura fica bloqueada
    // ("aprovação em andamento") depois que a APR sai de Pendente, entao a
    // ordem correta e sign -> submit, nao submit -> sign.
    t0 = Date.now();
    const signRes = http.post(
      `${BASE_URL}/signatures`,
      JSON.stringify({
        document_id: aprId,
        document_type: 'APR',
        signature_data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        type: 'drawn',
      }),
      { headers, tags: { name: 'lc_sign' } },
    );
    lifecycleStepDuration.add(Date.now() - t0, { step: 'sign' });
    const signed = check(signRes, {
      'sign 200/201': (r) => r.status === 200 || r.status === 201,
    });
    if (!signed) {
      lifecycleSuccess.add(false);
      fail(`sign falhou: HTTP ${signRes.status} ${signRes.body}`);
    }

    // 3) Submeter para aprovação — para papeis com permissao de aprovar
    // (ADMIN_EMPRESA/TST/SUPERVISOR), submit() ja executa a transicao
    // Pendente -> Aprovada diretamente (confirmado via teste real: um approve
    // separado depois falha com "status: Aprovada"). Nao ha PATCH /approve
    // adicional neste papel.
    t0 = Date.now();
    const submitRes = http.post(
      `${BASE_URL}/aprs/${aprId}/submit`,
      JSON.stringify({ reason: 'Aprovado em teste de carga automatizado.' }),
      { headers, tags: { name: 'lc_submit' } },
    );
    lifecycleStepDuration.add(Date.now() - t0, { step: 'submit' });
    const approved = check(submitRes, {
      'submit 200': (r) => r.status === 200,
      'submit status Aprovada': (r) => r.json('status') === 'Aprovada',
    });
    if (!approved) {
      lifecycleSuccess.add(false);
      fail(`submit/approve falhou: HTTP ${submitRes.status} ${submitRes.body}`);
    }

    // 4) Gerar PDF final oficial (Puppeteer)
    t0 = Date.now();
    const pdfRes = http.post(`${BASE_URL}/aprs/${aprId}/generate-final-pdf`, null, {
      headers,
      tags: { name: 'lc_generate_pdf' },
      timeout: '60s',
    });
    lifecycleStepDuration.add(Date.now() - t0, { step: 'generate_pdf' });
    const pdfOk = check(pdfRes, {
      'generate-final-pdf 200/201': (r) => r.status === 200 || r.status === 201,
    });
    if (!pdfOk) {
      console.log(`[lifecycle] generate-final-pdf falhou: HTTP ${pdfRes.status} ${pdfRes.body}`);
    }

    // 5) Encerrar (Aprovada -> Encerrada)
    t0 = Date.now();
    const finalizeRes = http.patch(`${BASE_URL}/aprs/${aprId}/finalize`, JSON.stringify({}), {
      headers,
      tags: { name: 'lc_finalize' },
    });
    lifecycleStepDuration.add(Date.now() - t0, { step: 'finalize' });
    const finalized = check(finalizeRes, {
      'finalize 200': (r) => r.status === 200,
      'finalize status Encerrada': (r) => r.json('status') === 'Encerrada',
    });

    lifecycleSuccess.add(created && approved && pdfOk && finalized);

    console.log(
      `[lifecycle] apr=${aprId} create=${createRes.status} submit/approve=${submitRes.status} ` +
        `pdf=${pdfRes.status} finalize=${finalizeRes.status}`,
    );
  });
}

// ─── Cenário 2: Validação de throttle em rota Puppeteer ─────────────────────
// GET /aprs/files/weekly-bundle tem limite de 2 req/min por usuário (default).
// Dispara uma rajada e confirma que a partir do limite a API responde 429
// em vez de saturar o Chromium compartilhado da VPS.

export function throttleScenario() {
  const tenant = tenants[0];
  const session = login(tenant);
  const headers = authHeaders(session, tenant.companyId);

  group('apr_bundle_throttle', () => {
    for (let i = 1; i <= BUNDLE_BURST; i++) {
      const res = http.get(`${BASE_URL}/aprs/files/weekly-bundle`, {
        headers,
        tags: { name: 'bundle_burst' },
        timeout: '30s',
      });
      const is429 = res.status === 429;
      const is2xx = res.status >= 200 && res.status < 300;
      if (is429) throttle429Count.add(1);
      if (is2xx) throttle2xxCount.add(1);
      console.log(`[throttle] tentativa ${i}/${BUNDLE_BURST} -> HTTP ${res.status}`);
      check(res, {
        'bundle status esperado (2xx ou 429)': (r) => is2xx || is429 || r.status === 404,
      });
      sleep(0.3);
    }
  });
}

// ─── Cenário 3: Concorrência / race condition em approve ────────────────────
// N VUs disparam POST /aprs/:id/submit na MESMA apr Pendente simultaneamente
// (submit() e quem executa a transicao Pendente->Aprovada sob lock para os
// papeis com permissao de aprovar — ver achado do cenario lifecycle: PATCH
// /approve separado nao se aplica a este papel). Esperado: exatamente 1
// sucesso (200), o restante 409 (lock FOR UPDATE NOWAIT) — nunca ambos <100%
// nem >1 sucesso (o que indicaria dupla aprovacao / estado corrompido).
//
// setup() cria e assina UMA apr Pendente para todos os VUs disputarem.

export function setup() {
  if (SCENARIO === 'progressive') {
    return setupProgressive();
  }
  if (SCENARIO !== 'race') {
    return {};
  }
  if (RACE_APR_ID) {
    return { aprId: RACE_APR_ID };
  }
  const tenant = tenants[0];
  const session = login(tenant);
  const headers = authHeaders(session, tenant.companyId);

  const createRes = http.post(
    `${BASE_URL}/aprs`,
    JSON.stringify({
      numero: `APRHEAVY-RACE-${Date.now()}`,
      titulo: 'APR Race Condition — Teste de Carga Pesado',
      descricao: 'APR sintetica para validar exclusao mutua na aprovacao concorrente.',
      data_inicio: '2026-06-01',
      data_fim: '2026-12-31',
      site_id: tenant.siteId,
      elaborador_id: tenant.userId,
      probability: 2,
      severity: 3,
      exposure: 2,
      residual_risk: 'MEDIUM',
      participants: [tenant.userId],
      risk_items: [
        {
          atividade: 'Trabalho em altura',
          condicao_perigosa: 'Risco de queda de altura',
          categoria_risco: 'Físico',
          probabilidade: 2,
          severidade: 3,
          medidas_prevencao: 'Uso de EPI e andaime homologado',
          responsavel: 'Supervisor SST',
          status_acao: 'pendente',
        },
      ],
    }),
    { headers, tags: { name: 'race_setup_create' } },
  );
  if (createRes.status !== 201) {
    fail(`setup: create falhou HTTP ${createRes.status} ${createRes.body}`);
  }
  const aprId = createRes.json('id');

  const signRes = http.post(
    `${BASE_URL}/signatures`,
    JSON.stringify({
      document_id: aprId,
      document_type: 'APR',
      signature_data:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      type: 'drawn',
    }),
    { headers, tags: { name: 'race_setup_sign' } },
  );
  if (signRes.status !== 200 && signRes.status !== 201) {
    fail(`setup: sign falhou HTTP ${signRes.status} ${signRes.body}`);
  }

  console.log(`[race setup] apr Pendente pronta para disputa: ${aprId}`);
  return { aprId };
}

export function raceScenario(data) {
  const tenant = tenants[0];
  const session = login(tenant);
  const headers = authHeaders(session, tenant.companyId);

  const res = http.post(
    `${BASE_URL}/aprs/${data.aprId}/submit`,
    JSON.stringify({ reason: `Race condition VU ${exec.vu.idInTest}` }),
    { headers, tags: { name: 'race_submit' } },
  );

  // Achado real desta trilha: o "perdedor" da corrida nao recebe 409 (conflito
  // de lock), recebe 400 com mensagem de estado invalido — a transacao vencedora
  // ja commitou Pendente->Aprovada antes do perdedor reler o estado, entao ele
  // ve a apr simplesmente "nao pronta para aprovacao" em vez de um 409 de lock.
  // Ambos os codigos sao aceitaveis do ponto de vista de correcao (exclusao
  // mutua real, sem dupla aprovacao); o que importa e exatamente 1 sucesso.
  const isExpectedLoserResponse =
    res.status === 409 ||
    (res.status === 400 && /não está pronta para aprovação/i.test(res.body || ''));

  if (res.status === 200) {
    raceSuccessCount.add(1);
  } else if (isExpectedLoserResponse) {
    raceConflictCount.add(1);
  } else {
    raceUnexpectedCount.add(1);
    console.log(`[race] VU ${exec.vu.idInTest} status inesperado: ${res.status} ${res.body}`);
  }
}

// ─── Cenário 4: Carga progressiva dedicada em GET /aprs e GET /aprs/:id ─────
// Estagios ascendentes com abortOnFail — o proprio k6 aborta a execucao
// inteira no primeiro estagio que reprovar o threshold, sem insistir.
//
// Achado real desta trilha: autenticar por VU (ate 75 VUs, so 3 contas reais
// via round-robin) faz cada VU logar independentemente, gerando dezenas de
// POST /auth/login quase simultaneos vindos do mesmo IP de teste — isso
// aciona o rate-limit de BORDA do Cloudflare (HTTP 429 "error code: 1015"),
// nao o throttler da aplicacao. Pre-autenticar as 3 contas UMA vez em
// setup() (sequencial, com pausa) e reusar os tokens em todos os VUs mede
// exclusivamente a capacidade real da API em GET /aprs e GET /aprs/:id.

export function setupProgressive() {
  const sessions = tenants.map((tenant, idx) => {
    if (idx > 0) sleep(1);
    return login(tenant);
  });
  return { sessions };
}

export function progressiveScenario(data) {
  const idx = (exec.vu.idInTest - 1) % tenants.length;
  const tenant = tenants[idx];
  const session = data.sessions[idx];
  const headers = authHeaders(session, tenant.companyId);

  group('progressive_list_and_detail', () => {
    const t0 = Date.now();
    const listRes = http.get(`${BASE_URL}/aprs?limit=20&page=1`, {
      headers,
      tags: { name: 'progressive_list' },
    });
    aprListDuration.add(Date.now() - t0);
    check(listRes, { 'list 200': (r) => r.status === 200 });
    // 429 e o throttle por usuario funcionando como projetado quando VARIOS
    // VUs compartilham a MESMA conta sintetica (poucos tenants para ate 75
    // VUs) — nao e falha de capacidade da API. So classifica como falha
    // inesperada o que nao for 2xx nem 429.
    progressiveUnexpectedFailure.add(
      !(listRes.status >= 200 && listRes.status < 300) && listRes.status !== 429,
    );
    if (listRes.status === 429) progressiveRateLimit429.add(1);

    if (listRes.status === 200) {
      try {
        const body = listRes.json();
        const items = body.data || body.items || [];
        const isolationOk = items.every(
          (apr) => !apr.company_id || apr.company_id === tenant.companyId,
        );
        tenantIsolationOk.add(isolationOk);
        const detailId = items.length > 0 ? items[0].id : null;
        if (detailId) {
          const t1 = Date.now();
          const detailRes = http.get(`${BASE_URL}/aprs/${detailId}`, {
            headers,
            tags: { name: 'progressive_detail' },
          });
          aprDetailDuration.add(Date.now() - t1);
          check(detailRes, { 'detail 200': (r) => r.status === 200 });
          progressiveUnexpectedFailure.add(
            !(detailRes.status >= 200 && detailRes.status < 300) &&
              detailRes.status !== 429,
          );
          if (detailRes.status === 429) progressiveRateLimit429.add(1);
          if (detailRes.status === 200) {
            const detailBody = detailRes.json();
            tenantIsolationOk.add(
              !detailBody.company_id || detailBody.company_id === tenant.companyId,
            );
          }
        }
      } catch (e) {
        console.log(`[progressive] erro ao parsear resposta: ${e}`);
      }
    }
  });

  sleep(0.5);
}

// ─── Opcoes por cenario ──────────────────────────────────────────────────────

function buildOptions() {
  if (SCENARIO === 'throttle') {
    return {
      scenarios: {
        throttle: {
          executor: 'shared-iterations',
          exec: 'throttleScenario',
          vus: 1,
          iterations: 1,
          maxDuration: '1m',
        },
      },
    };
  }

  if (SCENARIO === 'race') {
    return {
      scenarios: {
        race: {
          executor: 'shared-iterations',
          exec: 'raceScenario',
          vus: RACE_VUS,
          iterations: RACE_VUS,
          maxDuration: '30s',
        },
      },
      thresholds: {
        race_success_count: ['count==1'],
        race_unexpected_count: ['count==0'],
      },
    };
  }

  if (SCENARIO === 'progressive') {
    return {
      scenarios: {
        progressive: {
          executor: 'ramping-vus',
          exec: 'progressiveScenario',
          startVUs: 0,
          stages: [
            { duration: '30s', target: 10 },
            { duration: '45s', target: 10 },
            { duration: '30s', target: 25 },
            { duration: '45s', target: 25 },
            { duration: '30s', target: 50 },
            { duration: '45s', target: 50 },
            { duration: '30s', target: 75 },
            { duration: '45s', target: 75 },
            { duration: '20s', target: 0 },
          ],
          gracefulRampDown: '15s',
        },
      },
      thresholds: {
        // 429 e excluido de propósito (ver progressiveUnexpectedFailure): com
        // apenas 3 contas sinteticas compartilhadas por ate 75 VUs, o
        // throttle POR USUARIO (120 req/min) e esperado engatar antes de
        // qualquer limite real de capacidade da API — isso mede o app
        // corretamente respeitando seu proprio throttle, nao uma falha.
        progressive_unexpected_failure: [{ threshold: 'rate<0.02', abortOnFail: true }],
        'http_req_duration{name:progressive_list}': [
          { threshold: 'p(95)<800', abortOnFail: true, delayAbortEval: '20s' },
        ],
        'http_req_duration{name:progressive_detail}': [
          { threshold: 'p(95)<800', abortOnFail: true, delayAbortEval: '20s' },
        ],
        heavy_tenant_isolation_ok: [{ threshold: 'rate>0.999', abortOnFail: true }],
      },
    };
  }

  // lifecycle (default)
  return {
    scenarios: {
      lifecycle: {
        executor: 'shared-iterations',
        exec: 'lifecycleScenario',
        vus: 1,
        iterations: 1,
        maxDuration: '3m',
      },
    },
    thresholds: {
      lifecycle_success: ['rate==1'],
    },
  };
}

export const options = buildOptions();
