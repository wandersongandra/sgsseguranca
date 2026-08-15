import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions, EntityManager } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

/**
 * Reduz um erro de conexão ao que é diagnosticável, sem carregar credencial.
 *
 * Erros de driver podem trazer a connection string inteira — com o par
 * usuário/senha embutido no formato de URL — e este texto vai para log
 * estruturado, que é agregado e retido. Preserva-se o código (`ECONNREFUSED`,
 * `ETIMEDOUT`, `28P01`), que é o que permite distinguir rede de autenticação, e
 * a mensagem com a credencial removida.
 */
export function sanitizeConnectionError(error: unknown): string {
  const bruto =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'erro desconhecido';
  // Códigos de driver (`ECONNREFUSED`, `ETIMEDOUT`, `28P01`) são sempre string
  // ou number. Qualquer outro tipo é descartado em vez de virar
  // "[object Object]" no log estruturado.
  const codigoBruto: unknown =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const codigo =
    typeof codigoBruto === 'string' || typeof codigoBruto === 'number'
      ? String(codigoBruto)
      : '';

  const semCredencial = bruto
    // URL com credencial embutida vira ***:*** na parte de autenticacao.
    .replace(/([a-z+]+:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1***:***@')
    // password=... / pwd=... em connection strings no formato key=value
    .replace(/\b(password|pwd)\s*=\s*[^\s;&]+/gi, '$1=***');

  return codigo ? `${codigo}: ${semCredencial}` : semCredencial;
}

/**
 * Monta as opções da conexão dedicada a partir das da conexão de runtime.
 *
 * Exportada para poder ser testada isoladamente: os erros possíveis aqui são
 * silenciosos e graves (herdar a réplica manda os SELECTs de volta para a
 * credencial sem bypass; esquecer de limpar host/port faz o `url` ser ignorado),
 * e nenhum deles apareceria como exceção — só como "não encontrou o convite".
 */
export function buildProvisioningDataSourceOptions(input: {
  base: PostgresConnectionOptions;
  adminUrl: string;
  entities: unknown[];
  poolMax: number;
}): DataSourceOptions {
  const { base, adminUrl, entities, poolMax } = input;
  return {
    ...base,
    name: 'tenant-provisioning',
    // A URL dedicada substitui QUALQUER forma de endereçamento herdada — tanto
    // `url` quanto o conjunto host/port/username/password/database. Deixar
    // qualquer um deles para trás faria a conexão autenticar com a credencial
    // errada, que é justamente o bug que esta classe existe para corrigir.
    url: adminUrl,
    host: undefined,
    port: undefined,
    username: undefined,
    password: undefined,
    database: undefined,
    // A réplica de leitura aponta para a credencial de runtime. Herdá-la aqui
    // mandaria os SELECTs de volta para a conexão sem bypass.
    replication: undefined,
    entities,
    // Esta conexão jamais roda DDL. Migrations continuam sendo responsabilidade
    // exclusiva de DATABASE_MIGRATION_URL.
    migrations: [],
    migrationsRun: false,
    synchronize: false,
    extra: {
      ...((base.extra ?? {}) as Record<string, unknown>),
      // Pool mínimo: provisionamento é raro e não deve segurar conexões do Neon
      // à toa.
      max: poolMax,
      min: 0,
      application_name: 'api_provisioning',
    },
  } as DataSourceOptions;
}

/**
 * Conexão TypeORM dedicada para **provisionamento de tenant** — o punhado de
 * operações que criam um tenant do zero e portanto não têm tenant nenhum para
 * usar como contexto.
 *
 * ## Por que isto existe
 *
 * A migration 361 revogou a membership de `sgs_app` em `sgs_rls_bypass`, e
 * `is_super_admin()` começa checando exatamente essa membership:
 *
 * ```sql
 * IF NOT pg_has_role(current_user, 'sgs_rls_bypass', 'MEMBER') THEN RETURN false;
 * ```
 *
 * Ou seja: na conexão de runtime, `SET LOCAL app.is_super_admin = 'true'` virou
 * um no-op. Toda política que dependa de `is_super_admin()` passou a negar. Para
 * a maioria do sistema isso é irrelevante (há sempre um `company_id` no
 * contexto), mas o provisionamento é o caso em que **a empresa ainda não
 * existe** — não há `current_company()` a comparar, e todas as políticas caem no
 * ramo `is_super_admin()`, que agora é falso. O fluxo morre na primeira query.
 *
 * A saída é a mesma que `PrivilegedDbService` usa: autenticar como `sgs_admin`
 * (membro de `sgs_rls_bypass`) via `DATABASE_ADMIN_URL`. A diferença é que
 * `PrivilegedDbService` entrega um client `pg` cru, e o provisionamento precisa
 * de entidades TypeORM — transformers de criptografia de campo, defaults de
 * `BaseAuditEntity`, cascatas. Reescrever isso em SQL literal duplicaria o
 * conhecimento de colunas em dois lugares. Então aqui clonamos a configuração da
 * conexão de runtime e trocamos **apenas a credencial**.
 *
 * ## Degradação
 *
 * Fora de produção, sem `DATABASE_ADMIN_URL`, cai na conexão de runtime com
 * aviso alto — em desenvolvimento a role local costuma ter bypass, ou o banco é
 * SQLite e não há RLS nenhuma a contornar.
 *
 * **Em produção não degrada:** `DATABASE_ADMIN_URL` é requisito operacional
 * desde a migration 361, e cair no runtime ali produziria um sistema que parece
 * funcionar e não funciona. E `requiredTransaction()` não degrada em ambiente
 * nenhum quando o alvo é PostgreSQL — ver o comentário do método.
 */
@Injectable()
export class ProvisioningDataSourceService implements OnModuleDestroy {
  private readonly logger = new Logger(ProvisioningDataSourceService.name);
  private dedicated: DataSource | null = null;
  private initializing: Promise<DataSource> | null = null;
  private fallbackWarned = false;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly runtimeDataSource: DataSource,
  ) {}

  private get adminUrl(): string {
    return (this.config.get<string>('DATABASE_ADMIN_URL') ?? '').trim();
  }

  /**
   * True quando existe uma conexão dedicada utilizável — `DATABASE_ADMIN_URL`
   * setada **e** runtime em PostgreSQL. Em SQLite (dev) não há RLS e não faz
   * sentido clonar a conexão.
   */
  isDedicated(): boolean {
    return this.adminUrl.length > 0 && this.isPostgres;
  }

  /**
   * O risco que motiva todo o fail-closed deste arquivo é específico do
   * PostgreSQL: é lá que existe RLS, e é lá que uma query pode devolver 0
   * linhas por política em vez de por ausência de dados. Em SQLite não há RLS
   * — a conexão local **é** a verdade.
   */
  private get isPostgres(): boolean {
    return this.runtimeDataSource.options.type === 'postgres';
  }

  /**
   * `SET LOCAL app.is_super_admin` é sintaxe de PostgreSQL. Emiti-la em SQLite
   * derruba a transação com erro de sintaxe — por isso a flag é condicional, e
   * não incondicional como era antes.
   */
  private runWithSuperAdminFlag<T>(
    dataSource: DataSource,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (manager) => {
      if (this.isPostgres) {
        await manager.query("SET LOCAL app.is_super_admin = 'true'");
      }
      return fn(manager);
    });
  }

  /**
   * Obtém a conexão dedicada convertendo **apenas** falha de
   * obtenção/inicialização em 503.
   *
   * O escopo estreito é deliberado: se o `try` envolvesse também a execução da
   * transação, qualquer erro de domínio levantado dentro do callback viraria
   * "conexão privilegiada indisponível" — trocando um diagnóstico correto por
   * um enganoso e escondendo bug de negócio atrás de problema de infra.
   */
  private async acquireDedicated(operation: string): Promise<DataSource> {
    try {
      return await this.getDedicated();
    } catch (error) {
      this.logger.error({
        event: 'privileged_connection_required',
        operation,
        severity: 'HIGH',
        reason: sanitizeConnectionError(error),
        message:
          'Falha ao obter a conexão privilegiada: operação bloqueada em vez de ' +
          'executada pela conexão de runtime, que não enxerga as linhas por RLS.',
      });
      throw new ServiceUnavailableException(
        'Operação administrativa indisponível: conexão privilegiada não disponível.',
      );
    }
  }

  /**
   * Executa `fn` numa transação com `app.is_super_admin = 'true'` setado.
   *
   * Na conexão dedicada a flag tem efeito (o papel é membro de
   * `sgs_rls_bypass`); na de runtime é inócua, e o callback só funciona se o
   * papel local tiver bypass — o caso de desenvolvimento.
   */
  async transaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const dataSource = this.isDedicated()
      ? await this.acquireDedicated('tenant_provisioning')
      : this.resolveFallbackDataSource('tenant_provisioning');

    return this.runWithSuperAdminFlag(dataSource, fn);
  }

  /**
   * `transaction` que exige a conexao dedicada em **qualquer ambiente**,
   * inclusive desenvolvimento.
   *
   * Use quando o resultado da query decide uma condicao de seguranca — em
   * particular quando "0 linhas" seria interpretado como autorizacao. O
   * exemplo canonico e a trava de `companies.remove()`: contar usuarios
   * vinculados pela conexao de runtime devolve 0 por RLS, e a guarda que
   * deveria bloquear a exclusao passa a liberar.
   *
   * Diferente de `transaction()`, aqui nao ha degradacao **no PostgreSQL**:
   * sem conexao privilegiada nao ha como provar a condicao, e o correto e
   * recusar.
   *
   * **SQLite é exceção deliberada, não brecha.** O fail-closed existe porque a
   * RLS pode esconder linhas; SQLite não tem RLS, então um `COUNT` local já
   * responde "quantas linhas existem" — que é justamente a pergunta que a
   * guarda precisa fazer. Exigir `DATABASE_ADMIN_URL` em SQLite quebraria
   * desenvolvimento e testes locais sem fechar risco nenhum.
   */
  async requiredTransaction<T>(
    operation: string,
    fn: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (!this.isPostgres) {
      return this.runWithSuperAdminFlag(this.runtimeDataSource, fn);
    }

    if (!this.adminUrl) {
      this.logger.error({
        event: 'privileged_connection_required',
        operation,
        severity: 'HIGH',
        message:
          'DATABASE_ADMIN_URL ausente: operacao bloqueada em vez de consultada ' +
          'pela conexao de runtime, que nao enxerga as linhas por RLS.',
      });
      throw new ServiceUnavailableException(
        'Operação administrativa indisponível: conexão privilegiada não configurada.',
      );
    }

    const dataSource = await this.acquireDedicated(operation);
    return this.runWithSuperAdminFlag(dataSource, fn);
  }

  /**
   * Decide o que fazer quando nao ha conexao dedicada.
   *
   * Em **producao** nao ha decisao a tomar: `DATABASE_ADMIN_URL` e requisito
   * operacional desde a migration 361, e a ausencia dela e erro de
   * configuracao. Degradar para o runtime ali produziria um sistema que parece
   * funcionar e nao funciona — provisionamento devolvendo "convite invalido"
   * para convites validos, por exemplo. Falha fechado.
   *
   * Fora de producao, degrada com aviso: em desenvolvimento a role local
   * costuma ter bypass (ou o banco e SQLite, sem RLS), e exigir a conexao
   * dedicada quebraria o ambiente de todo mundo sem ganho de seguranca.
   */
  private resolveFallbackDataSource(operation: string): DataSource {
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const isPostgres = this.runtimeDataSource.options.type === 'postgres';

    if (isProduction) {
      this.logger.error({
        event: 'privileged_connection_required',
        operation,
        severity: 'HIGH',
        message:
          'DATABASE_ADMIN_URL ausente em producao: operacao de provisionamento ' +
          'bloqueada. A conexao de runtime nao tem bypass de RLS desde a migration 361.',
      });
      throw new ServiceUnavailableException(
        'Operação administrativa indisponível: conexão privilegiada não configurada.',
      );
    }

    if (!this.fallbackWarned) {
      this.fallbackWarned = true;
      this.logger.warn({
        event: 'provisioning_datasource_fallback',
        operation,
        message: isPostgres
          ? 'DATABASE_ADMIN_URL ausente (fora de produção): provisionamento vai usar a conexão de runtime. ' +
            'Se o papel local não for membro de sgs_rls_bypass, a criação de tenant falhará por RLS.'
          : 'Runtime não é PostgreSQL: provisionamento usando a conexão de runtime (sem RLS).',
      });
    }
    return this.runtimeDataSource;
  }

  private async getDedicated(): Promise<DataSource> {
    if (this.dedicated?.isInitialized) return this.dedicated;
    // Duas requisições simultâneas de onboarding não podem inicializar dois pools.
    this.initializing ??= this.initializeDedicated().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  private async initializeDedicated(): Promise<DataSource> {
    const options = buildProvisioningDataSourceOptions({
      base: this.runtimeDataSource.options as PostgresConnectionOptions,
      adminUrl: this.adminUrl,
      // `entityMetadatas` é a lista já resolvida pelo autoLoadEntities. Ler dela
      // (e não de `options.entities`) garante que o clone enxergue as mesmas
      // entidades que a aplicação registrou.
      entities: this.runtimeDataSource.entityMetadatas.map(
        (metadata) => metadata.target,
      ),
      poolMax: Number(this.config.get('DATABASE_ADMIN_POOL_MAX') ?? 3),
    });

    const dataSource = new DataSource(options);
    await dataSource.initialize();
    this.dedicated = dataSource;
    this.logger.log({
      event: 'provisioning_datasource_initialized',
      entities: this.runtimeDataSource.entityMetadatas.length,
    });
    return dataSource;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.dedicated?.isInitialized) {
      await this.dedicated.destroy().catch(() => undefined);
    }
    this.dedicated = null;
  }
}
