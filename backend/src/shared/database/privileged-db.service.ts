import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';

/**
 * Conexao DEDICADA para operacoes privilegiadas (cross-tenant) — etapa 2 do
 * hardening de bypass de RLS. Ver backend/docs/RUNBOOK_RLS_BYPASS_HARDENING.md.
 *
 * Autentica com a role `sgs_admin` (membro de `sgs_rls_bypass`) via
 * DATABASE_ADMIN_URL, SEPARADA da conexao de runtime (`sgs_app`). Quando o
 * bypass for revogado do `sgs_app`, as operacoes legitimas que precisam de
 * acesso cross-tenant (exclusao LGPD, trilha forense, jobs sem tenant)
 * continuam funcionando por aqui, e o runtime comum perde o poder de escalar.
 *
 * DORMENTE por padrao: se DATABASE_ADMIN_URL nao estiver setada, isEnabled()
 * retorna false e NADA e inicializado (nenhum pool, nenhuma conexao).
 *
 * ## ATENCAO — a orientacao original desta classe ficou obsoleta e perigosa
 *
 * O texto que estava aqui dizia: "callers devem checar isEnabled() e cair no
 * comportamento atual (bypass na conexao comum) enquanto a conexao dedicada nao
 * existir". Isso fazia sentido durante o rollout incremental, ANTES da migration
 * 361 — enquanto `sgs_app` ainda era membro de `sgs_rls_bypass` e o fallback de
 * fato funcionava.
 *
 * Depois da 361 o fallback deixou de ser equivalente: virou um caminho que
 * enxerga MENOS. `SET LOCAL app.is_super_admin` nao concede mais nada na conexao
 * de runtime, entao SELECT devolve 0 linhas e UPDATE afeta 0 linhas **sem erro**.
 * Cada `else` escrito seguindo aquela instrucao virou um defeito silencioso.
 *
 * O padrao correto hoje:
 *   - operacao cross-tenant, destrutiva, de GDPR ou de seguranca
 *       → `withRequiredPrivilegedClient(operation, fn)` — falha FECHADO (503);
 *   - `isEnabled()` serve para health check e telemetria, nao para escolher
 *     caminho de execucao.
 */
@Injectable()
export class PrivilegedDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrivilegedDbService.name);
  private pool: Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  /**
   * Torna visível, no boot, um estado que antes só aparecia como
   * comportamento estranho meses depois.
   *
   * Não derruba a aplicação de propósito: sem esta conexão, login, leitura e
   * escrita dentro de um tenant continuam corretos. Só as operações
   * cross-tenant ficam indisponíveis — e elas agora respondem 503 em vez de
   * "sucesso" vazio. Transformar a ausência da env em crash de boot converteria
   * um erro de configuração em indisponibilidade total, o que é pior. A
   * degradação é reportada em `GET /health/detailed` → `checks.admin_operations`.
   */
  onModuleInit(): void {
    if (this.isEnabled()) return;
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const message =
      'DATABASE_ADMIN_URL nao configurada: operacoes cross-tenant privilegiadas ' +
      '(exclusao de empresa, exclusao LGPD, retencao, provisionamento de tenant) ' +
      'vao responder 503. A conexao de runtime nao tem bypass de RLS desde a migration 361.';

    if (isProduction) {
      this.logger.error({
        event: 'privileged_connection_unconfigured',
        severity: 'HIGH',
        message,
      });
    } else {
      this.logger.warn({
        event: 'privileged_connection_unconfigured',
        message,
      });
    }
  }

  private get adminUrl(): string {
    return (this.config.get<string>('DATABASE_ADMIN_URL') ?? '').trim();
  }

  /** True somente quando DATABASE_ADMIN_URL esta configurada. */
  isEnabled(): boolean {
    return this.adminUrl.length > 0;
  }

  /**
   * Exige a conexao privilegiada, ou falha FECHADO.
   *
   * Existe porque `isEnabled()` sozinho convida ao padrao errado:
   *
   *     if (privilegedDb.isEnabled()) { ...sgs_admin... }
   *     else { ...runtime com SET LOCAL app.is_super_admin... }
   *
   * Depois da migration 361 esse `else` nao e um fallback — e um caminho que
   * enxerga menos do que deveria. A flag de sessao virou no-op na conexao de
   * runtime, entao SELECT devolve 0 linhas e UPDATE afeta 0 linhas, **sem
   * erro**. Uma operacao cross-tenant que caia ali reporta sucesso sem ter
   * feito nada, e uma guarda que dependa da contagem passa a autorizar o que
   * deveria bloquear.
   *
   * O principio e: ausencia de conexao privilegiada nao significa "nao ha
   * dados". Significa "nao foi possivel provar a condicao". Isso e 503, nao
   * caminho alternativo.
   *
   * @param operation identificador estavel da operacao, para log/alerta
   *                  (ex.: 'gdpr_delete_user_data'). Nunca inclua segredos.
   */
  assertAvailable(operation: string): void {
    if (this.isEnabled()) return;

    this.logger.error({
      event: 'privileged_connection_required',
      operation,
      severity: 'HIGH',
      message:
        'DATABASE_ADMIN_URL ausente: operacao cross-tenant bloqueada em vez de ' +
        'executar pela conexao de runtime, que nao enxerga as linhas por RLS.',
    });

    throw new ServiceUnavailableException(
      'Operação administrativa indisponível: conexão privilegiada não configurada.',
    );
  }

  /**
   * `withPrivilegedClient` que exige a conexao dedicada em qualquer ambiente.
   *
   * Use em toda operacao onde "0 linhas" seria interpretado como autorizacao,
   * sucesso, ou ausencia de dados. Nunca envolva esta chamada num try/catch que
   * converta a excecao em caminho alternativo.
   */
  async withRequiredPrivilegedClient<T>(
    operation: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    this.assertAvailable(operation);
    return this.withPrivilegedClient(fn);
  }

  private getPool(): Pool {
    if (!this.isEnabled()) {
      throw new Error(
        'PrivilegedDbService: DATABASE_ADMIN_URL nao configurada. A conexao privilegiada esta dormente.',
      );
    }
    if (!this.pool) {
      const url = this.adminUrl;
      const requireSsl =
        /sslmode=require/i.test(url) ||
        String(this.config.get('DATABASE_SSL') ?? '').toLowerCase() === 'true';
      const allowInsecure =
        String(
          this.config.get('DATABASE_SSL_ALLOW_INSECURE') ?? '',
        ).toLowerCase() === 'true';
      const max = Number(this.config.get('DATABASE_ADMIN_POOL_MAX') ?? 3);

      this.pool = new Pool({
        connectionString: url,
        ssl: requireSsl ? { rejectUnauthorized: !allowInsecure } : undefined,
        max: Number.isFinite(max) && max > 0 ? max : 3,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
      });
      this.pool.on('error', (err: Error) => {
        this.logger.error(
          `Erro no pool privilegiado (sgs_admin): ${err.message}`,
        );
      });
      this.logger.log('Conexao privilegiada (sgs_admin) inicializada.');
    }
    return this.pool;
  }

  /**
   * Executa `fn` com um client da conexao privilegiada. O client ja vem com
   * statement_timeout aplicado. O caller e responsavel pela transacao e por
   * qualquer `SET LOCAL app.is_super_admin = 'true'` que a operacao exigir.
   * Lanca se a conexao dedicada nao estiver configurada (checar isEnabled()).
   */
  async withPrivilegedClient<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.getPool().connect();
    try {
      await client.query("SET statement_timeout = '30000'");
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => undefined);
      this.pool = null;
    }
  }
}
