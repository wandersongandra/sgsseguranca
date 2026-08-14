const path = require('path');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const { URL } = require('url');

dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function parseCliArgs(argv) {
  const options = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const arg = token.slice(2);
    if (!arg) continue;
    const equalIndex = arg.indexOf('=');
    if (equalIndex === -1) {
      options[arg] = true;
      continue;
    }
    const key = arg.slice(0, equalIndex);
    const value = arg.slice(equalIndex + 1);
    options[key] = value;
  }
  return options;
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function maskEmail(value) {
  if (!value || !value.includes('@')) return null;
  const [local, domain] = value.split('@');
  if (!local || !domain) return null;
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function resolveProvider(env) {
  if ((env.RESEND_API_KEY || '').trim()) {
    return 'resend';
  }
  if (
    (env.MAIL_HOST || '').trim() &&
    (env.MAIL_USER || '').trim() &&
    (env.MAIL_PASS || '').trim()
  ) {
    return 'smtp';
  }
  return 'none';
}

async function verifySmtpProvider(env, timeoutMs) {
  const port = toPositiveInt(env.MAIL_PORT, 587);
  const secureRaw = (env.MAIL_SECURE || '').trim().toLowerCase();
  const secure = secureRaw === 'true' || secureRaw === '1' || port === 465;
  const transporter = nodemailer.createTransport({
    host: env.MAIL_HOST,
    port,
    secure,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    auth: {
      user: env.MAIL_USER,
      pass: env.MAIL_PASS,
    },
  });

  try {
    await transporter.verify();
    return {
      ok: true,
      provider: 'smtp',
      host: env.MAIL_HOST,
      port,
      secure,
      login: maskEmail(env.MAIL_USER),
    };
  } catch (error) {
    return {
      ok: false,
      provider: 'smtp',
      host: env.MAIL_HOST,
      port,
      secure,
      login: maskEmail(env.MAIL_USER),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    transporter.close();
  }
}

async function inspectMailQueues(env, options) {
  if (!(env.REDIS_URL || '').trim()) {
    return {
      ok: null,
      accessible: false,
      connectionMode: 'missing_redis_url',
      reason: 'REDIS_URL ausente.',
      mail: null,
      dlq: null,
      failedJobs: [],
      dlqJobs: [],
      prunedFailedJobIds: [],
      pruneSkipped: true,
      warnings: ['Inspeção das filas ignorada por ausência de REDIS_URL.'],
    };
  }

  const warnings = [];
  const redisTimeoutMs = toPositiveInt(options['redis-timeout-ms'], 3_000);

  const redis = new IORedis(env.REDIS_URL, {
    connectTimeout: redisTimeoutMs,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  const swallowRedisErrors = () => {};
  redis.on('error', swallowRedisErrors);

  const mailQueue = new Queue('mail', { connection: redis });
  const mailDlqQueue = new Queue('mail-dlq', { connection: redis });
  const prunedFailedJobIds = [];
  let pruneSkipped = false;

  try {
    await Promise.all([mailQueue.waitUntilReady(), mailDlqQueue.waitUntilReady()]);
    const mailCounts = await mailQueue.getJobCounts(
      'active',
      'wait',
      'completed',
      'failed',
      'delayed',
    );
    const dlqCounts = await mailDlqQueue.getJobCounts('wait', 'failed');

    const failedJobLimit = toPositiveInt(options['failed-limit'], 20);
    const dlqJobLimit = toPositiveInt(options['dlq-limit'], 20);

    const failedEnd =
      (mailCounts.failed || 0) > 0
        ? Math.min((mailCounts.failed || 0) - 1, failedJobLimit - 1)
        : -1;
    const dlqEnd =
      (dlqCounts.wait || 0) > 0
        ? Math.min((dlqCounts.wait || 0) - 1, dlqJobLimit - 1)
        : -1;

    const failedJobs =
      failedEnd >= 0
        ? await mailQueue.getJobs(['failed'], 0, failedEnd, true)
        : [];
    const dlqJobs =
      dlqEnd >= 0 ? await mailDlqQueue.getJobs(['wait'], 0, dlqEnd, true) : [];

    if (options['prune-failed']) {
      const minAgeMinutes = toPositiveInt(options['min-age-minutes'], 60);
      const minAgeMs = minAgeMinutes * 60 * 1000;
      const now = Date.now();

      if ((dlqCounts.wait || 0) > 0) {
        pruneSkipped = true;
        warnings.push(
          'Prune de failures ignorado porque a mail-dlq ainda possui itens pendentes.',
        );
      } else {
        for (const job of failedJobs) {
          const finishedAt =
            job.finishedOn || job.processedOn || job.timestamp || 0;
          const ageMs = Math.max(0, now - finishedAt);
          if (ageMs < minAgeMs) {
            continue;
          }
          await job.remove();
          prunedFailedJobIds.push(String(job.id));
        }
      }
    }

    return {
      ok: true,
      accessible: true,
      connectionMode: 'connected',
      reason: null,
      warnings,
      pruneSkipped,
      prunedFailedJobIds,
      mail: {
        active: mailCounts.active || 0,
        waiting: mailCounts.wait || 0,
        completed: mailCounts.completed || 0,
        failed: mailCounts.failed || 0,
        delayed: mailCounts.delayed || 0,
        total: Object.values(mailCounts).reduce(
          (acc, value) => acc + Number(value || 0),
          0,
        ),
      },
      dlq: {
        waiting: dlqCounts.wait || 0,
        failed: dlqCounts.failed || 0,
      },
      failedJobs: failedJobs.map((job) => ({
        id: String(job.id),
        name: job.name,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp || null,
        finishedOn: job.finishedOn || null,
        failedReason: job.failedReason || null,
      })),
      dlqJobs: dlqJobs.map((job) => {
        const data =
          job && typeof job.data === 'object' && job.data !== null ? job.data : {};
        return {
          id: String(job.id),
          name: job.name,
          originalJobName:
            typeof data.originalJobName === 'string'
              ? data.originalJobName
              : null,
          originalJobId:
            typeof data.originalJobId === 'string' ? data.originalJobId : null,
          failedAt: typeof data.failedAt === 'string' ? data.failedAt : null,
          errorMessage:
            data.error &&
            typeof data.error === 'object' &&
            typeof data.error.message === 'string'
              ? data.error.message
              : null,
        };
      }),
    };
  } catch (error) {
    warnings.push(
      'Não foi possível acessar o Redis para inspecionar filas neste ambiente.',
    );
    return {
      ok: null,
      accessible: false,
      connectionMode: 'connection_error',
      reason: error instanceof Error ? error.message : String(error),
      mail: null,
      dlq: null,
      failedJobs: [],
      dlqJobs: [],
      prunedFailedJobIds,
      pruneSkipped: true,
      warnings,
    };
  } finally {
    await Promise.allSettled([mailQueue.close(), mailDlqQueue.close()]);
    redis.removeListener('error', swallowRedisErrors);
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
  }
}

async function runAudit() {
  const options = parseCliArgs(process.argv.slice(2));
  const timeoutMs = toPositiveInt(options['smtp-timeout-ms'], 10_000);
  const report = {
    version: 1,
    type: 'mail_runtime_audit',
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'fail',
    provider: {
      configured: resolveProvider(process.env),
      verification: null,
    },
    queues: null,
    warnings: [],
    errors: [],
  };

  try {
    const provider = report.provider.configured;
    if (provider === 'smtp') {
      report.provider.verification = await verifySmtpProvider(
        process.env,
        timeoutMs,
      );
      if (!report.provider.verification.ok) {
        report.errors.push(
          `Falha na verificação SMTP: ${report.provider.verification.error}`,
        );
      }
    } else if (provider === 'resend') {
      report.provider.verification = {
        ok: null,
        provider,
        note:
          'Validação ativa não implementada para este provider neste script; configuração detectada por ambiente.',
      };
      report.warnings.push(
        `Provider ${provider} detectado sem verificação ativa neste script.`,
      );
    } else {
      report.provider.verification = {
        ok: false,
        provider: 'none',
        note: 'Nenhum provider de e-mail detectado no ambiente.',
      };
      report.errors.push('Nenhum provider de e-mail configurado.');
    }

    report.queues = await inspectMailQueues(process.env, options);
    report.warnings.push(...(report.queues.warnings || []));

    const providerOk =
      report.provider.verification &&
      (report.provider.verification.ok === true ||
        report.provider.verification.ok === null);
    const queuesAccessible = report.queues?.accessible !== false;
    const dlqEmpty = report.queues?.dlq?.waiting === 0;
    const failedHistory = report.queues?.mail?.failed || 0;
    const prunedSome = (report.queues?.prunedFailedJobIds || []).length > 0;

    if (
      providerOk &&
      queuesAccessible &&
      dlqEmpty &&
      (failedHistory === 0 || prunedSome)
    ) {
      report.status = 'pass';
    } else if (providerOk && !queuesAccessible) {
      report.status = 'warn';
      report.warnings.push(
        'Provider validado, mas a inspeção de filas não pôde ser concluída neste ambiente.',
      );
    } else if (providerOk && dlqEmpty) {
      report.status = 'warn';
      report.warnings.push(
        'Provider validado e DLQ vazia, mas ainda existem failures retidos na fila principal.',
      );
    } else if (providerOk) {
      report.status = 'warn';
    } else {
      report.status = 'fail';
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    report.status = 'fail';
  } finally {
    report.completedAt = new Date().toISOString();
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  console.log(`Mail Runtime Audit: ${report.status.toUpperCase()}`);
  console.log(`Provider configurado: ${report.provider.configured}`);
  if (report.provider.verification) {
    if (report.provider.verification.ok === true) {
      console.log('Verificação do provider: OK');
    } else if (report.provider.verification.ok === false) {
      console.log(
        `Verificação do provider: FALHOU (${report.provider.verification.error || report.provider.verification.note})`,
      );
    } else {
      console.log(
        `Verificação do provider: ${report.provider.verification.note || 'indeterminada'}`,
      );
    }
  }

  if (report.queues) {
    if (report.queues.accessible === false) {
      console.log(`Filas: indisponíveis (${report.queues.reason})`);
    } else {
      console.log(
        `Fila mail: active=${report.queues.mail?.active || 0}, wait=${report.queues.mail?.waiting || 0}, failed=${report.queues.mail?.failed || 0}, completed=${report.queues.mail?.completed || 0}`,
      );
      console.log(
        `Mail DLQ: waiting=${report.queues.dlq?.waiting || 0}, failed=${report.queues.dlq?.failed || 0}`,
      );
      if ((report.queues.prunedFailedJobIds || []).length > 0) {
        console.log(
          `Failed jobs removidos da fila principal: ${report.queues.prunedFailedJobIds.join(', ')}`,
        );
      }
    }
  }

  if (report.warnings.length) {
    console.log('Warnings:');
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }

  if (report.errors.length) {
    console.log('Errors:');
    for (const error of report.errors) {
      console.log(`- ${error}`);
    }
  }
}

runAudit().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
