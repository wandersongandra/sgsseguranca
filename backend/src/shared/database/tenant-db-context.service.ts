import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TenantService } from '../tenant/tenant.service';
import { DbTimingsService } from './db-timings.service';

/**
 * Injeção automática de contexto RLS no pool de conexões PostgreSQL.
 *
 * PROBLEMA RESOLVIDO:
 *   TypeORM usa um pool de conexões (pg.Pool). Quando um repositório executa
 *   um `find()`, ele pega UMA conexão do pool. A sessão dessa conexão específica
 *   precisa ter `app.current_company_id` definido ANTES de qualquer query para
 *   que o PostgreSQL RLS funcione corretamente.
 *
 *   As abordagens anteriores (SET no interceptor ou SET LOCAL em um queryRunner
 *   separado) não funcionam porque cada operação pode pegar uma conexão
 *   diferente do pool.
 *
 * SOLUÇÃO:
 *   Patcheamos o método `pool.connect()` do pg driver. Toda vez que o TypeORM
 *   pega uma conexão do pool (para qualquer operação: repositório, queryRunner,
 *   etc.), nossa função é chamada PRIMEIRO. Ela lê o `TenantContext` da
 *   AsyncLocalStorage (propagada por Node.js para toda a cadeia async) e executa
 *   um único `set_config(...)` que define as variáveis de sessão do PostgreSQL
 *   para essa conexão específica.
 *
 * RESULTADO:
 *   - Todos os repositórios injetados usam RLS automaticamente.
 *   - Zero mudanças necessárias em qualquer service.
 *   - Overhead mínimo: 1 round-trip extra por conexão borrowed do pool.
 *   - Seguro com connection pooling: a cada acquire, o contexto é reescrito.
 *
 * SUPER ADMIN:
 *   Quando `isSuperAdmin = true` no contexto, a policy RLS:
 *   `USING (company_id = current_company() OR is_super_admin() = true)`
 *   permite acesso cross-tenant.
 *
 * CONTEXTO ADICIONAL:
 *   `app.current_user_id`, `app.current_site_id` e `app.current_site_ids` são
 *   preenchidos por requisição para suportar policies RLS mais granulares,
 *   inclusive usuários autorizados para mais de uma obra.
 *   `app.current_site_scope` diferencia navegação de usuário normal
 *   (`single`) de jobs internos e rotinas administrativas (`all`).
 *
 * LOGIN (rota pública):
 *   Não há contexto → `app.current_company_id = ''` e `app.is_super_admin = false`.
 *   A AuthService usa `SET LOCAL app.is_super_admin = true` dentro de uma
 *   transação explícita para encontrar o usuário sem restrição de tenant.
 */
@Injectable()
export class TenantDbContextService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TenantDbContextService.name);
  private readonly patchedPools = new WeakSet<PgPool>();
  private readonly patchedQuerySymbol = Symbol.for('db_timings_patched_query');
  private readonly tenantContextKeySymbol = Symbol.for('tenant_db_context_key');
  private readonly pgTimeouts = resolvePgSessionTimeouts();
  private bootstrapWaitInterval?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantService: TenantService,
    private readonly dbTimings: DbTimingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.dataSource.isInitialized) {
      this.patchPool();
      return;
    }

    // SQLite e outros drivers não possuem RLS PostgreSQL. Para PostgreSQL,
    // aguardar em background criaria uma janela entre initialize() e o patch
    // em que o servidor poderia aceitar uma query sem contexto.
    if (String(this.dataSource.options.type) !== 'postgres') {
      return;
    }

    await this.waitForPostgresInitialization();
    this.patchPool();
  }

  onModuleDestroy(): void {
    this.clearBootstrapWaitInterval();
  }

  private clearBootstrapWaitInterval(): void {
    if (!this.bootstrapWaitInterval) {
      return;
    }
    clearInterval(this.bootstrapWaitInterval);
    this.bootstrapWaitInterval = undefined;
  }

  private async waitForPostgresInitialization(): Promise<void> {
    const timeoutMs = clampTimeoutMs(
      process.env.DB_RLS_CONTEXT_BOOTSTRAP_TIMEOUT_MS,
      30_000,
      5 * 60_000,
    );
    const startedAt = Date.now();

    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this.dataSource.isInitialized) {
          this.clearBootstrapWaitInterval();
          resolve();
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          this.clearBootstrapWaitInterval();
          reject(
            new Error(
              'TenantDbContextService: PostgreSQL não inicializou dentro do prazo; ' +
                'startup abortado antes de aceitar requests sem contexto RLS.',
            ),
          );
        }
      };

      this.clearBootstrapWaitInterval();
      this.bootstrapWaitInterval = setInterval(check, 25);
      this.bootstrapWaitInterval.unref();
      check();
    });
  }

  private patchPool(): void {
    // TypeORM's PostgresDriver expõe o pg.Pool como `.master` e, quando
    // replication está habilitado, também em `.slaves[]`.
    const driver = this.dataSource.driver as unknown as {
      master?: PgPool;
      slaves?: PgPool[];
    };

    const pools = [
      { label: 'master', pool: driver.master },
      ...(Array.isArray(driver.slaves)
        ? driver.slaves.map((pool, index) => ({
            label: `slave:${index}`,
            pool,
          }))
        : []),
    ].filter((entry): entry is { label: string; pool: PgPool } =>
      isPgPool(entry.pool),
    );

    if (pools.length === 0) {
      const message =
        'TenantDbContextService: pg Pools não encontrados no driver TypeORM. ' +
        'O contexto RLS não pôde ser instalado.';

      this.logger.error(message);

      // SQLite e outros drivers não possuem o pool PostgreSQL nem RLS. Em
      // produção/teste PostgreSQL, porém, continuar o bootstrap sem o patch
      // transformaria uma falha de segurança em um estado fail-open.
      if (String(this.dataSource.options.type) === 'postgres') {
        throw new Error(message);
      }

      this.logger.warn(
        'TenantDbContextService: driver não-PostgreSQL detectado; ' +
          'injeção de contexto RLS não se aplica.',
      );
      return;
    }

    const patchedLabels = pools
      .filter(({ pool }) => !this.patchedPools.has(pool))
      .map(({ label, pool }) => {
        this.patchSinglePool(pool, label);
        return label;
      });

    if (patchedLabels.length > 0) {
      this.logger.log(
        'pg Pools patcheados para contexto RLS: ' + patchedLabels.join(', '),
      );
    }
  }

  private patchSinglePool(pool: PgPool, label: string): void {
    if (this.patchedPools.has(pool)) return;

    const tenantService = this.tenantService;
    const logger = this.logger;
    const rawConnect = pool.connect;

    const originalConnect = (): Promise<PgClient> =>
      new Promise((resolve, reject) => {
        rawConnect.call(pool, (err: Error | null, client: unknown) => {
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }

          if (!isPgClient(client)) {
            reject(
              new Error(
                'TenantDbContextService: pool.connect não retornou client.',
              ),
            );
            return;
          }

          resolve(client);
        });
      });

    /**
     * Injeta o contexto RLS em uma conexão adquirida do pool (lógica comum
     * entre o path de callback e o path de Promise).
     */
    const injectRlsContext = async (borrowStart: bigint): Promise<PgClient> => {
      const client = await originalConnect();
      const borrowMs =
        Number(process.hrtime.bigint() - borrowStart) / 1_000_000;
      this.dbTimings.recordBorrowWait(borrowMs);
      const ctx = tenantService.getContext();
      const siteScope =
        ctx?.siteScope ?? (ctx?.isSuperAdmin ? 'all' : 'single');
      const siteIds = this.serializeSiteIds(ctx);
      const allowRlsBypass = Boolean(ctx?.isSuperAdmin && !ctx.companyId);
      const contextKey = this.buildContextKey(ctx);
      const anyClient = client as unknown as Record<string | symbol, unknown>;
      const previousContextKey = anyClient[this.tenantContextKeySymbol];

      try {
        if (previousContextKey !== contextKey) {
          /**
           * Usa set_config com parâmetros para evitar SQL injection.
           * is_local = false → nível de sessão (persiste pela conexão até que seja
           * sobrescrito no próximo pool.connect() para esta conexão).
           *
           * Combina os dois SET em uma única query para minimizar round-trips.
           *
           * empty string → current_company() lança exceção → capturada → retorna NULL
           * → RLS bloqueia. Isso é o comportamento correto para rotas sem tenant.
           */
          const setStart = process.hrtime.bigint();
          await client.query(
            `SELECT
               set_config('app.current_company',                     $1, false),
               set_config('app.current_company_id',                  $1, false),
               set_config('app.is_super_admin',                      $2, false),
               set_config('app.current_user_id',                     $3, false),
               set_config('app.current_site_id',                     $4, false),
               set_config('app.current_site_ids',                    $5, false),
               set_config('app.current_site_scope',                  $6, false),
               set_config('statement_timeout',                       $7, false),
               set_config('lock_timeout',                            $8, false),
               set_config('idle_in_transaction_session_timeout',     $9, false)`,
            [
              ctx?.companyId ?? '',
              String(allowRlsBypass),
              ctx?.userId ?? '',
              ctx?.siteId ?? '',
              siteIds,
              siteScope,
              String(this.pgTimeouts.statementTimeoutMs),
              String(this.pgTimeouts.lockTimeoutMs),
              String(this.pgTimeouts.idleInTransactionTimeoutMs),
            ],
          );
          anyClient[this.tenantContextKeySymbol] = contextKey;
          const setMs = Number(process.hrtime.bigint() - setStart) / 1_000_000;
          this.dbTimings.recordRlsContextSet(setMs);
        }
      } catch (err) {
        // Fail-closed: se não conseguir setar o contexto, zera o tenant para
        // evitar vazamento cross-tenant em conexões reaproveitadas do pool.
        logger.error(
          `TenantDbContextService: falha ao injetar contexto RLS na conexão ${label} (fail-closed)`,
          err,
        );
        try {
          await client.query(
            `SELECT
               set_config('app.current_company',                     $1, false),
               set_config('app.current_company_id',                  $1, false),
               set_config('app.is_super_admin',                      $2, false),
               set_config('app.current_user_id',                     $3, false),
               set_config('app.current_site_id',                     $4, false),
               set_config('app.current_site_ids',                    $5, false),
               set_config('app.current_site_scope',                  $6, false),
               set_config('statement_timeout',                       $7, false),
               set_config('lock_timeout',                            $8, false),
               set_config('idle_in_transaction_session_timeout',     $9, false)`,
            [
              '',
              'false',
              '',
              '',
              '',
              'single',
              String(this.pgTimeouts.statementTimeoutMs),
              String(this.pgTimeouts.lockTimeoutMs),
              String(this.pgTimeouts.idleInTransactionTimeoutMs),
            ],
          );
          anyClient[this.tenantContextKeySymbol] = this.buildContextKey({
            companyId: '',
            isSuperAdmin: false,
            userId: '',
            siteId: '',
            siteScope: 'single',
          });
        } catch (resetErr) {
          try {
            client.release(resetErr as Error);
          } catch {
            // ignore
          }
          throw resetErr;
        }
      }

      this.patchClientQuery(client);
      return client;
    };

    /**
     * IMPORTANTE: TypeORM (v0.3.x) usa a forma CALLBACK de pool.connect():
     *   pool.connect((err, client, release) => { ... })
     *
     * Precisamos suportar AMBAS as formas para não quebrar o TypeORM:
     *  - Callback: pool.connect(fn) → chama fn(null, client, release)
     *  - Promise:  pool.connect()   → retorna Promise<PgClient>
     */
    pool.connect = (
      callback?: PgPoolConnectCallback,
    ): Promise<PgClient> | void => {
      const borrowStart = process.hrtime.bigint();

      if (typeof callback === 'function') {
        // Forma callback — usada pelo TypeORM para adquirir conexões de pool
        injectRlsContext(borrowStart)
          .then((client) => {
            callback(null, client, (err?: Error) => client.release(err));
          })
          .catch((err: Error) => {
            callback(err);
          });
        return;
      }

      // Forma Promise — usada quando pool.connect() é chamado sem callback
      return injectRlsContext(borrowStart);
    };

    this.patchedPools.add(pool);
  }

  private patchClientQuery(client: PgClient): void {
    if (!this.dbTimings.isEnabled()) return;

    const anyClient = client as unknown as Record<string | symbol, unknown>;
    if (anyClient[this.patchedQuerySymbol]) return;
    anyClient[this.patchedQuerySymbol] = true;

    const originalQuery = client.query.bind(client) as PgClient['query'];
    client.query = async (sql: string, params?: unknown[]) => {
      const start = process.hrtime.bigint();
      try {
        return await originalQuery(sql, params);
      } finally {
        const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
        this.dbTimings.recordQuery(ms);
      }
    };
  }

  private buildContextKey(ctx?: {
    companyId?: string;
    isSuperAdmin?: boolean;
    userId?: string;
    siteId?: string;
    siteIds?: string[];
    siteScope?: string;
  }): string {
    const siteScope = ctx?.siteScope ?? (ctx?.isSuperAdmin ? 'all' : 'single');
    const allowRlsBypass = Boolean(ctx?.isSuperAdmin && !ctx.companyId);
    return [
      ctx?.companyId ?? '',
      String(allowRlsBypass),
      ctx?.userId ?? '',
      ctx?.siteId ?? '',
      this.serializeSiteIds(ctx),
      siteScope,
      String(this.pgTimeouts.statementTimeoutMs),
      String(this.pgTimeouts.lockTimeoutMs),
      String(this.pgTimeouts.idleInTransactionTimeoutMs),
    ].join('|');
  }

  private serializeSiteIds(ctx?: {
    siteId?: string;
    siteIds?: string[];
  }): string {
    return Array.from(
      new Set(
        [...(ctx?.siteIds ?? []), ctx?.siteId]
          .map((siteId) => String(siteId || '').trim())
          .filter(Boolean),
      ),
    ).join(',');
  }
}

/** Tipo mínimo do pg.PoolClient necessário para o patch. */
interface PgClient {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: (err?: boolean | Error) => void;
}

const isPgClient = (value: unknown): value is PgClient =>
  typeof value === 'object' &&
  value !== null &&
  'query' in value &&
  typeof value.query === 'function' &&
  'release' in value &&
  typeof value.release === 'function';

type PgPoolConnectCallback = (
  err: Error | null,
  client?: PgClient,
  release?: (err?: Error) => void,
) => void;

type PgPoolConnect = (
  callback?: PgPoolConnectCallback,
) => Promise<PgClient> | void;

interface PgPool {
  connect: PgPoolConnect;
}

const isPgPool = (value: unknown): value is PgPool =>
  typeof value === 'object' &&
  value !== null &&
  'connect' in value &&
  typeof value.connect === 'function';

function clampTimeoutMs(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(parsed), 50), max);
}

function resolvePgSessionTimeouts(): {
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
} {
  // Defaults are intentionally strict for web. Worker services should override
  // via env in Railway if they legitimately need longer runtimes.
  const statementTimeoutMs = clampTimeoutMs(
    process.env.PG_STATEMENT_TIMEOUT_MS,
    25_000,
    10 * 60_000,
  );
  const lockTimeoutMs = clampTimeoutMs(
    process.env.PG_LOCK_TIMEOUT_MS,
    2_000,
    60_000,
  );
  const idleInTransactionTimeoutMs = clampTimeoutMs(
    process.env.PG_IDLE_IN_TX_TIMEOUT_MS,
    15_000,
    10 * 60_000,
  );

  return {
    statementTimeoutMs,
    lockTimeoutMs,
    idleInTransactionTimeoutMs,
  };
}
