import { mkdir, writeFile } from 'node:fs/promises';
import { freemem } from 'node:os';
import path from 'node:path';
import type { LoginSession, TestApp } from '../helpers/test-app';
import type { AprBody } from '../helpers/apr-test.factory';
import { Role } from '../../src/modules/auth/enums/roles.enum';

type BatchResult = {
  index: number;
  id?: string;
  numero: string;
  status: 'Encerrada' | 'failed';
  durationMs: number;
  pdfFileKey?: string | null;
  finalPdfHashSha256?: string | null;
  error?: string;
};

type BatchReport = {
  generatedAt: string;
  total: number;
  concurrency: number;
  successful: number;
  failed: number;
  elapsedMs: number;
  results: BatchResult[];
};

function envInt(name: string, fallback: number, min: number, max: number) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function assertTestOnlyEnvironment() {
  if (process.env.APR_BATCH_CONFIRM_TEST !== 'true') {
    throw new Error(
      'Defina APR_BATCH_CONFIRM_TEST=true para confirmar uma execução somente no ambiente de teste.',
    );
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Execução bloqueada: NODE_ENV=production.');
  }

  const databaseHost = String(process.env.DATABASE_HOST || '').toLowerCase();
  const databasePort = Number(process.env.DATABASE_PORT || 0);
  const databaseName = String(process.env.DATABASE_NAME || '');

  if (!['127.0.0.1', 'localhost'].includes(databaseHost)) {
    throw new Error(
      `Execução bloqueada: DATABASE_HOST deve ser local (recebido: ${databaseHost || 'vazio'}).`,
    );
  }
  if (databasePort !== 5433 || databaseName !== 'sst_test') {
    throw new Error(
      `Execução bloqueada: alvo esperado é 127.0.0.1:5433/sst_test (recebido: ${databaseHost}:${databasePort}/${databaseName}).`,
    );
  }
  if (process.env.E2E_PRESERVE_MIGRATED_SCHEMA !== 'true') {
    throw new Error(
      'Defina E2E_PRESERVE_MIGRATED_SCHEMA=true para preservar as migrations e as colunas de integridade.',
    );
  }

  const forbiddenMarkers = [
    'neon.tech',
    'upstash.io',
    'backblaze',
    'api.sgsseguranca.com.br',
    'app.sgsseguranca.com.br',
  ];
  for (const [name, value] of Object.entries(process.env)) {
    const normalized = String(value || '').toLowerCase();
    if (forbiddenMarkers.some((marker) => normalized.includes(marker))) {
      throw new Error(
        `Execução bloqueada: ${name} contém marcador externo/produção.`,
      );
    }
  }
}

function assertConcurrencyCapacity(concurrency: number) {
  if (concurrency <= 20) return;

  const minimumFreeMemoryMb = envInt(
    'APR_BATCH_MIN_FREE_MEMORY_MB',
    2048,
    512,
    65536,
  );
  const freeMemoryMb = Math.floor(freemem() / (1024 * 1024));
  if (freeMemoryMb < minimumFreeMemoryMb) {
    throw new Error(
      `Execução bloqueada: ${concurrency} workers exigem pelo menos ${minimumFreeMemoryMb} MB livres (disponível: ${freeMemoryMb} MB). Use APR_BATCH_CONCURRENCY<=20 ou um host dedicado.`,
    );
  }
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

async function emitOneApr(
  testApp: TestApp,
  creatorSession: LoginSession,
  approverSession: LoginSession,
  csrfHeaders: Record<string, string>,
  index: number,
  numero: string,
  siteId: string,
  elaboradorId: string,
): Promise<BatchResult> {
  const startedAt = Date.now();

  try {
    const { createTestApr } = await import('../helpers/apr-test.factory');
    const apr = await createTestApr(testApp, creatorSession, {
      numero,
      titulo: `APR concorrente ${String(index + 1).padStart(4, '0')} — fixture sintética`,
      siteId,
      elaboradorId,
      participantIds: [elaboradorId],
    });

    const signature = await testApp
      .request()
      .post('/signatures')
      .set(testApp.authHeaders(creatorSession))
      .set(csrfHeaders)
      .send({
        document_id: apr.id,
        document_type: 'APR',
        signature_data: `assinatura-sintetica-apr-${index + 1}`,
        type: 'drawn',
      });
    if (signature.status !== 201) {
      throw new Error(
        `assinatura HTTP ${signature.status}: ${JSON.stringify(signature.body)}`,
      );
    }

    const approval = await testApp
      .request()
      .patch(`/aprs/${apr.id}/approve`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send({ reason: 'Aprovação sintética do lote concorrente de teste.' });
    if (![200, 201].includes(approval.status)) {
      throw new Error(
        `aprovação HTTP ${approval.status}: ${JSON.stringify(approval.body)}`,
      );
    }

    const pdf = await testApp
      .request()
      .post(`/aprs/${apr.id}/generate-final-pdf`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send();
    if (![200, 201].includes(pdf.status)) {
      throw new Error(`PDF HTTP ${pdf.status}: ${JSON.stringify(pdf.body)}`);
    }

    const finalized = await testApp
      .request()
      .patch(`/aprs/${apr.id}/finalize`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders)
      .send();
    if (![200, 201].includes(finalized.status)) {
      throw new Error(
        `finalização HTTP ${finalized.status}: ${JSON.stringify(finalized.body)}`,
      );
    }

    const detail = await testApp
      .request()
      .get(`/aprs/${apr.id}`)
      .set(testApp.authHeaders(approverSession))
      .set(csrfHeaders);
    if (detail.status !== 200) {
      throw new Error(
        `consulta final HTTP ${detail.status}: ${JSON.stringify(detail.body)}`,
      );
    }

    const body = detail.body as AprBody & {
      pdf_file_key?: string | null;
      final_pdf_hash_sha256?: string | null;
    };
    return {
      index,
      id: apr.id,
      numero,
      status: 'Encerrada',
      durationMs: Date.now() - startedAt,
      pdfFileKey: body.pdf_file_key,
      finalPdfHashSha256: body.final_pdf_hash_sha256,
    };
  } catch (error: unknown) {
    return {
      index,
      numero,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}

async function writeReport(report: BatchReport) {
  const reportFile = String(process.env.APR_BATCH_REPORT_FILE || '').trim();
  if (!reportFile) return;

  const absolutePath = path.resolve(reportFile);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Relatório salvo em: ${absolutePath}`);
}

async function main() {
  const { TestApp } = await import('../helpers/test-app');
  const { createApproverSession, createCreatorSession, createTestTenant } =
    await import('../helpers/apr-test.factory');

  assertTestOnlyEnvironment();

  if (process.env.APR_BATCH_BOOTSTRAP !== 'true') {
    throw new Error(
      'Defina APR_BATCH_BOOTSTRAP=true: o bootstrap reseta apenas o banco local sst_test e cria fixtures sintéticas.',
    );
  }

  const total = envInt('APR_BATCH_TOTAL', 10, 1, 100);
  const requestedConcurrency = Number(process.env.APR_BATCH_CONCURRENCY ?? 3);
  const highConcurrency =
    process.env.APR_BATCH_ALLOW_HIGH_CONCURRENCY === 'true';
  if (
    Number.isFinite(requestedConcurrency) &&
    requestedConcurrency > 20 &&
    !highConcurrency
  ) {
    throw new Error(
      'Para APR_BATCH_CONCURRENCY acima de 20, defina APR_BATCH_ALLOW_HIGH_CONCURRENCY=true explicitamente.',
    );
  }
  const concurrencyMax = highConcurrency
    ? Math.min(total, 100)
    : Math.min(total, 20);
  const concurrency = envInt('APR_BATCH_CONCURRENCY', 3, 1, concurrencyMax);
  assertConcurrencyCapacity(concurrency);
  const prefix = String(
    process.env.APR_BATCH_PREFIX || 'APR-CONCURRENT-E2E-2026',
  )
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, 42);

  const testApp = await TestApp.create();
  const startedAt = Date.now();

  try {
    await testApp.resetDatabase();
    const tenant = createTestTenant(testApp);
    const creatorSession = await createCreatorSession(testApp);
    const approverSession = await createApproverSession(testApp);
    const tst = testApp.getUser('tenantA', Role.TST);
    const csrfHeaders = await testApp.csrfHeaders();
    const results: Array<BatchResult | undefined> = [];
    results.length = total;
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;

        const numero = `${prefix}-${String(index + 1).padStart(4, '0')}`;
        results[index] = await emitOneApr(
          testApp,
          creatorSession,
          approverSession,
          csrfHeaders,
          index,
          numero,
          tenant.siteId,
          tst.id,
        );
        const result = results[index];
        console.log(
          `[${index + 1}/${total}] ${result?.status === 'Encerrada' ? 'OK' : 'FAIL'} ${numero} ${result?.durationMs ?? 0}ms`,
        );
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const completedResults = results.filter((result): result is BatchResult =>
      Boolean(result),
    );
    const successful = completedResults.filter(
      (result) => result.status === 'Encerrada',
    );
    const failed = completedResults.filter(
      (result) => result.status === 'failed',
    );
    const report: BatchReport = {
      generatedAt: new Date().toISOString(),
      total,
      concurrency,
      successful: successful.length,
      failed: failed.length,
      elapsedMs: Date.now() - startedAt,
      results: completedResults,
    };

    console.log('\n===== APR BATCH RESULT =====');
    console.log(`Total: ${report.total}`);
    console.log(`Concorrência: ${report.concurrency}`);
    console.log(`Sucesso: ${report.successful}`);
    console.log(`Falhas: ${report.failed}`);
    console.log(`Tempo total: ${report.elapsedMs}ms`);
    console.log(`Tenant: ${tenant.companyId}`);
    console.log(`Site: ${tenant.siteId}`);
    await writeReport(report);

    if (failed.length > 0) {
      for (const result of failed.slice(0, 10)) {
        console.error(
          `FAIL ${result.numero}: ${result.error || 'erro desconhecido'}`,
        );
      }
      process.exitCode = 1;
    }
  } finally {
    await testApp.close();
  }
}

void main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
