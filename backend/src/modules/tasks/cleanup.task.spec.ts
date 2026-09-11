import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CleanupTask } from './cleanup.task';
import * as uploadUtils from '../../shared/interceptors/file-upload.interceptor';

type MockClient = {
  query: jest.Mock;
  calls: string[];
};

type MockClientOptions = {
  roleHasBypass?: boolean;
  countResult?: number;
  /** rowCount devolvido por cada DELETE sucessivo, em ordem de chamada. */
  deleteResults?: number[];
  /** Se true, o próximo DELETE lança um erro (para testar rollback). */
  failDeleteAt?: number;
};

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0].trim();
}

/**
 * Mock mínimo de um pg.PoolClient o suficiente para exercitar o padrão
 * BEGIN/SET LOCAL/query/COMMIT|ROLLBACK usado por purgeExpiredWithRlsBypass.
 * Inspeciona a primeira linha de cada SQL para decidir a resposta —
 * suficiente porque as queries reais do CleanupTask são sempre literais
 * fixos, nunca dinâmicos vindos de fora da classe.
 */
function makeClient(options: MockClientOptions = {}): MockClient {
  const calls: string[] = [];
  let deleteCallIndex = 0;

  const query = jest.fn((sql: string) => {
    const line = firstLine(sql);
    calls.push(line);

    if (/pg_has_role/.test(sql)) {
      return { rows: [{ has_role: options.roleHasBypass ?? true }] };
    }
    if (line === 'BEGIN' || line === 'COMMIT' || line === 'ROLLBACK') {
      return {};
    }
    if (/SET LOCAL/.test(sql)) {
      return {};
    }
    if (/SELECT count/i.test(sql)) {
      return { rows: [{ cnt: options.countResult ?? 0 }] };
    }
    if (/DELETE FROM/i.test(sql)) {
      const currentIndex = deleteCallIndex;
      deleteCallIndex += 1;
      if (options.failDeleteAt === currentIndex) {
        throw new Error('simulated delete failure');
      }
      const rowCount = options.deleteResults?.[currentIndex] ?? 0;
      return { rowCount };
    }
    return {};
  });

  return { query, calls };
}

/** privilegedDb mock com a conexão dedicada disponível e funcional. */
function makePrivilegedDbAvailable(client: MockClient) {
  return {
    isEnabled: () => true,
    withRequiredPrivilegedClient: jest.fn(
      async (
        _operation: string,
        fn: (client: MockClient) => Promise<unknown>,
      ) => fn(client),
    ),
  };
}

/**
 * privilegedDb mock reproduzindo o comportamento real de
 * PrivilegedDbService quando DATABASE_ADMIN_URL não está configurada:
 * withRequiredPrivilegedClient FALHA FECHADO (lança), nunca devolve um
 * resultado "de sucesso vazio".
 */
function makePrivilegedDbUnavailable() {
  return {
    isEnabled: () => false,
    withRequiredPrivilegedClient: jest.fn(() => {
      throw new ServiceUnavailableException(
        'Operação administrativa indisponível: conexão privilegiada não configurada.',
      );
    }),
  };
}

function buildTask(
  privilegedDb: unknown,
  overrides: Partial<{
    slaQueue: unknown;
    expiryQueue: unknown;
    pdfDlq: unknown;
    companiesService: unknown;
  }> = {},
) {
  const slaQueue = overrides.slaQueue ?? { add: jest.fn() };
  const expiryQueue = overrides.expiryQueue ?? { add: jest.fn() };
  const pdfDlq = overrides.pdfDlq ?? {
    getWaitingCount: jest.fn().mockResolvedValue(0),
  };
  const companiesService = overrides.companiesService ?? {
    findAllActive: jest.fn(),
  };

  return new CleanupTask(
    slaQueue as never,
    expiryQueue as never,
    pdfDlq as never,
    companiesService as never,
    privilegedDb as never,
  );
}

describe('CleanupTask', () => {
  const originalRedisDisabled = process.env.REDIS_DISABLED;
  const originalApiCronsDisabled = process.env.API_CRONS_DISABLED;
  const originalAuditRetention = process.env.AUDIT_LOG_RETENTION_DAYS;
  const originalAprMetricsRetention = process.env.APR_METRICS_RETENTION_DAYS;

  // process.env.X = undefined vira a STRING "undefined" em Node (não apaga
  // a chave) — por isso restaurar precisa deletar quando o valor original
  // era ausente, nunca atribuir undefined diretamente.
  function restoreEnv(key: string, original: string | undefined): void {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }

  afterEach(() => {
    restoreEnv('REDIS_DISABLED', originalRedisDisabled);
    restoreEnv('API_CRONS_DISABLED', originalApiCronsDisabled);
    restoreEnv('AUDIT_LOG_RETENTION_DAYS', originalAuditRetention);
    restoreEnv('APR_METRICS_RETENTION_DAYS', originalAprMetricsRetention);
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('jobs não relacionados à retenção (comportamento pré-existente)', () => {
    it('nao tenta enfileirar notificacoes quando REDIS_DISABLED=true', async () => {
      process.env.REDIS_DISABLED = 'true';
      const slaQueue = { add: jest.fn() };
      const expiryQueue = { add: jest.fn() };
      const companiesService = { findAllActive: jest.fn() };
      const task = buildTask(makePrivilegedDbUnavailable(), {
        slaQueue,
        expiryQueue,
        companiesService,
      });

      await task.runExpiryNotifications();
      await task.runCorrectiveActionsSlaEscalation();

      expect(companiesService.findAllActive).not.toHaveBeenCalled();
      expect(expiryQueue.add).not.toHaveBeenCalled();
      expect(slaQueue.add).not.toHaveBeenCalled();
    });

    it('executa cleanup agendado de uploads temporarios quando crons estao ativos', async () => {
      const cleanupSpy = jest
        .spyOn(uploadUtils, 'runTempUploadCleanupBestEffort')
        .mockResolvedValue(null);
      const task = buildTask(makePrivilegedDbUnavailable());

      await task.cleanupStaleTempUploads();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('nao executa crons quando API_CRONS_DISABLED=true (inclusive as duas retenções)', async () => {
      process.env.API_CRONS_DISABLED = 'true';
      const cleanupSpy = jest.spyOn(
        uploadUtils,
        'runTempUploadCleanupBestEffort',
      );
      const slaQueue = { add: jest.fn() };
      const expiryQueue = { add: jest.fn() };
      const companiesService = { findAllActive: jest.fn() };
      const privilegedDb = makePrivilegedDbUnavailable();
      const task = buildTask(privilegedDb, {
        slaQueue,
        expiryQueue,
        companiesService,
      });

      await task.cleanupOldLogs();
      await task.cleanupOldAprMetrics();
      task.generateWeeklyReports();
      await task.cleanupStaleTempUploads();
      await task.runExpiryNotifications();
      await task.runCorrectiveActionsSlaEscalation();

      // Nem chega a tentar falar com a conexão privilegiada — o guard de
      // API_CRONS_DISABLED corta antes.
      expect(privilegedDb.withRequiredPrivilegedClient).not.toHaveBeenCalled();
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(companiesService.findAllActive).not.toHaveBeenCalled();
      expect(expiryQueue.add).not.toHaveBeenCalled();
      expect(slaQueue.add).not.toHaveBeenCalled();
    });

    it('enfileira jobs por tenant com jobId determinístico para evitar duplicidade', async () => {
      process.env.REDIS_DISABLED = 'false';
      const slaQueue = { add: jest.fn().mockResolvedValue({ id: 'sla' }) };
      const expiryQueue = {
        add: jest.fn().mockResolvedValue({ id: 'expiry' }),
      };
      const companiesService = {
        findAllActive: jest.fn().mockResolvedValue([{ id: 'company-1' }]),
      };
      const task = buildTask(makePrivilegedDbUnavailable(), {
        slaQueue,
        expiryQueue,
        companiesService,
      });

      await task.runExpiryNotifications();
      await task.runCorrectiveActionsSlaEscalation();

      expect(expiryQueue.add).toHaveBeenCalledWith(
        'training-check',
        { tenantId: 'company-1', type: 'training-check' },
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          jobId: expect.stringMatching(
            /^expiry-notifications-training-check-company-1-\d{4}-\d{2}-\d{2}$/,
          ),
          removeOnFail: 1000,
        }),
      );
      expect(slaQueue.add).toHaveBeenCalledWith(
        'run-sla-sweep',
        { tenantId: 'company-1' },
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          jobId: expect.stringMatching(
            /^sla-escalation-run-sla-sweep-company-1-\d{4}-\d{2}-\d{2}t\d{2}$/,
          ),
        }),
      );
    });
  });

  describe('retenção de audit_logs / apr_metrics — conexão privilegiada', () => {
    it('cleanupOldLogs conta e apaga via withRequiredPrivilegedClient, nunca via conexão de runtime', async () => {
      const client = makeClient({
        roleHasBypass: true,
        countResult: 3,
        deleteResults: [3],
      });
      const privilegedDb = makePrivilegedDbAvailable(client);
      const task = buildTask(privilegedDb);

      await task.cleanupOldLogs();

      expect(privilegedDb.withRequiredPrivilegedClient).toHaveBeenCalledWith(
        'cleanup_audit_logs',
        expect.any(Function),
      );
      // Nenhuma outra dependência foi injetada capaz de tocar a conexão de
      // runtime — a própria assinatura do construtor (5 parâmetros, sem
      // Repository algum) já impede estruturalmente esse caminho.
      expect(client.calls).toEqual(
        expect.arrayContaining([
          expect.stringContaining('pg_has_role'),
          'BEGIN',
          expect.stringContaining('SET LOCAL'),
          expect.stringContaining('SELECT count'),
          'COMMIT',
          expect.stringContaining('DELETE FROM audit_logs'),
        ]),
      );
      expect(client.calls).not.toContain('ROLLBACK');
    });

    it('cleanupOldAprMetrics pagina em múltiplos lotes até esgotar os elegíveis (sem teto arbitrário)', async () => {
      // 3 lotes cheios (5000 cada) + 1 lote parcial (1200) encerra o loop —
      // total 16200, bem acima de qualquer teto fixo antigo (100_000 só
      // seria atingido em 20 lotes; aqui provamos que o loop não para no
      // primeiro lote nem em nenhum número mágico, só quando um lote vem
      // menor que batchSize).
      const client = makeClient({
        roleHasBypass: true,
        countResult: 16200,
        deleteResults: [5000, 5000, 5000, 1200],
      });
      const privilegedDb = makePrivilegedDbAvailable(client);
      const task = buildTask(privilegedDb);

      await task.cleanupOldAprMetrics();

      const deleteCalls = client.calls.filter((c) =>
        c.includes('DELETE FROM apr_metrics'),
      );
      expect(deleteCalls).toHaveLength(4);
      const beginCalls = client.calls.filter((c) => c === 'BEGIN');
      // 1 BEGIN para a contagem + 4 BEGIN (um por lote de exclusão).
      expect(beginCalls).toHaveLength(5);
    });

    it('não apaga nada quando não há registros elegíveis (eligible=0, deleted=0, sem erro)', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      const client = makeClient({
        roleHasBypass: true,
        countResult: 0,
        deleteResults: [0],
      });
      const task = buildTask(makePrivilegedDbAvailable(client));

      await task.cleanupOldLogs();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Old audit_logs cleaned up: 0 rows'),
      );
    });

    it('registra erro observável quando eligible > 0 mas deleted = 0 (divergência de RLS)', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const client = makeClient({
        roleHasBypass: true,
        countResult: 5,
        deleteResults: [0],
      });
      const task = buildTask(makePrivilegedDbAvailable(client));

      await task.cleanupOldLogs();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'não removeu nada apesar de 5 registro(s) elegível(is)',
        ),
      );
    });

    it('FALHA FECHADO (lança, não retorna {eligible:0,deleted:0}) quando a conexão privilegiada não está configurada', async () => {
      const privilegedDb = makePrivilegedDbUnavailable();
      const task = buildTask(privilegedDb);

      await expect(task.cleanupOldLogs()).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(task.cleanupOldAprMetrics()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('FALHA FECHADO quando sgs_admin perdeu a membership em sgs_rls_bypass (drift de configuração)', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const client = makeClient({ roleHasBypass: false });
      const task = buildTask(makePrivilegedDbAvailable(client));

      await expect(task.cleanupOldLogs()).rejects.toThrow(/sem sgs_rls_bypass/);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('sem sgs_rls_bypass'),
      );
      // Nunca chegou a tentar contar/apagar.
      expect(client.calls).not.toEqual(
        expect.arrayContaining([expect.stringContaining('SELECT count')]),
      );
    });

    it('erro durante a exclusão causa ROLLBACK e propaga (não engole a falha)', async () => {
      const client = makeClient({
        roleHasBypass: true,
        countResult: 2,
        failDeleteAt: 0,
      });
      const task = buildTask(makePrivilegedDbAvailable(client));

      await expect(task.cleanupOldLogs()).rejects.toThrow(
        'simulated delete failure',
      );
      expect(client.calls).toContain('ROLLBACK');
    });

    it('erro durante a contagem causa ROLLBACK e propaga', async () => {
      const client = makeClient({ roleHasBypass: true });
      client.query.mockImplementation((sql: string) => {
        const line = firstLine(sql);
        if (/pg_has_role/.test(sql)) return { rows: [{ has_role: true }] };
        if (line === 'BEGIN') return {};
        if (/SET LOCAL/.test(sql)) return {};
        if (/SELECT count/i.test(sql)) throw new Error('count failure');
        if (line === 'ROLLBACK') return {};
        return {};
      });
      const task = buildTask(makePrivilegedDbAvailable(client));

      await expect(task.cleanupOldLogs()).rejects.toThrow('count failure');
      expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('retenção inválida (0/negativa/NaN) cai no piso mínimo e usa o fallback documentado', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const logSpy = jest.spyOn(Logger.prototype, 'log');

      for (const invalidValue of ['0', '-1', 'abc', '3']) {
        // '3' é válido como número mas abaixo do piso de 7 dias.
        process.env.APR_METRICS_RETENTION_DAYS = invalidValue;
        const client = makeClient({
          roleHasBypass: true,
          countResult: 0,
          deleteResults: [0],
        });
        const task = buildTask(makePrivilegedDbAvailable(client));

        await task.cleanupOldAprMetrics();

        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            `APR_METRICS_RETENTION_DAYS="${invalidValue}" inválido`,
          ),
        );
        expect(logSpy).toHaveBeenCalledWith(
          expect.stringContaining('retention=90d'),
        );
        errorSpy.mockClear();
        logSpy.mockClear();
      }
    });

    it('retenção válida (>= piso) é respeitada sem log de erro', async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      process.env.APR_METRICS_RETENTION_DAYS = '30';
      const client = makeClient({
        roleHasBypass: true,
        countResult: 0,
        deleteResults: [0],
      });
      const task = buildTask(makePrivilegedDbAvailable(client));

      await task.cleanupOldAprMetrics();

      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('APR_METRICS_RETENTION_DAYS'),
      );
    });

    it('purgeExpiredWithRlsBypass recusa batchSize num alvo não ctidBatchSafe (audit_logs é particionada)', async () => {
      const client = makeClient({ roleHasBypass: true });
      const task = buildTask(makePrivilegedDbAvailable(client));

      await expect(
        // Acesso ao método privado é deliberado: é o único jeito de provar
        // a trava sem depender de um caller real já configurado errado.
        (
          task as unknown as {
            purgeExpiredWithRlsBypass: (options: {
              target: 'audit_logs';
              cutoff: Date;
              batchSize?: number;
            }) => Promise<{ eligible: number; deleted: number }>;
          }
        ).purgeExpiredWithRlsBypass({
          target: 'audit_logs',
          cutoff: new Date(),
          batchSize: 5000,
        }),
      ).rejects.toThrow(/ctidBatchSafe/);
    });
  });
});
