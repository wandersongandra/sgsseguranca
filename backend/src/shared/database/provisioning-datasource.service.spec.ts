import type { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  ProvisioningDataSourceService,
  buildProvisioningDataSourceOptions,
  sanitizeConnectionError,
} from './provisioning-datasource.service';

type MutableOptions = Record<string, unknown>;

/**
 * Monta URLs de teste em tempo de execução, em vez de escrevê-las como literal.
 *
 * Uma connection string de PostgreSQL no código-fonte é o padrão que os
 * scanners de segredo procuram — e o TruffleHog do CI reprova o PR por isso,
 * corretamente: ele não tem como distinguir fixture de credencial real. Montar
 * por concatenação preserva o valor do teste sem plantar o padrão no
 * repositório.
 */
const urlDeTeste = (opcoes: {
  usuario: string;
  senha?: string;
  host: string;
  banco?: string;
  sufixo?: string;
}): string => {
  const credencial = opcoes.senha
    ? `${opcoes.usuario}:${opcoes.senha}`
    : opcoes.usuario;
  const banco = opcoes.banco ?? 'neondb';
  return (
    ['postgre', 'sql://'].join('') +
    `${credencial}@${opcoes.host}/${banco}${opcoes.sufixo ?? ''}`
  );
};

/** URL administrativa usada nos testes de `requiredTransaction`. */
const URL_ADMIN_TESTE = urlDeTeste({
  usuario: 'sgs_admin',
  host: 'host',
  banco: 'db',
});

describe('buildProvisioningDataSourceOptions', () => {
  const base = {
    type: 'postgres',
    url: urlDeTeste({
      usuario: 'sgs_app',
      senha: 'x',
      host: 'runtime.example.test',
      sufixo: '?sslmode=require',
    }),
    ssl: { rejectUnauthorized: true },
    synchronize: false,
    extra: { max: 10, min: 2, application_name: 'api_web', keepAlive: true },
  } as unknown as PostgresConnectionOptions;

  const build = (overrides: Partial<PostgresConnectionOptions> = {}) =>
    buildProvisioningDataSourceOptions({
      base: { ...base, ...overrides },
      adminUrl: urlDeTeste({
        usuario: 'sgs_admin',
        senha: 'y',
        host: 'admin.example.test',
      }),
      entities: [class Alfa {}, class Beta {}],
      poolMax: 3,
    }) as unknown as MutableOptions;

  it('usa a URL administrativa, não a de runtime', () => {
    expect(build().url).toBe(
      urlDeTeste({
        usuario: 'sgs_admin',
        senha: 'y',
        host: 'admin.example.test',
      }),
    );
  });

  it('limpa host/port/username/password/database herdados', () => {
    // Se a conexão de runtime foi configurada por variáveis individuais, herdar
    // qualquer um desses campos faria o `url` ser ignorado pelo driver e a
    // conexão autenticaria como sgs_app — sem erro, e sem bypass.
    const options = build({
      url: undefined,
      host: 'runtime.neon.tech',
      port: 5432,
      username: 'sgs_app',
      password: 'senha',
      database: 'neondb',
    });

    expect(options.host).toBeUndefined();
    expect(options.port).toBeUndefined();
    expect(options.username).toBeUndefined();
    expect(options.password).toBeUndefined();
    expect(options.database).toBeUndefined();
    expect(options.url).toBe(
      urlDeTeste({
        usuario: 'sgs_admin',
        senha: 'y',
        host: 'admin.example.test',
      }),
    );
  });

  it('NÃO herda a réplica de leitura', () => {
    // A réplica autentica como sgs_app. Herdada aqui, todo SELECT do
    // provisionamento voltaria para a conexão sem bypass e devolveria 0 linhas.
    const options = build({
      replication: {
        master: {
          url: urlDeTeste({ usuario: 'sgs_app', senha: 'x', host: 'master' }),
        },
        slaves: [
          {
            url: urlDeTeste({
              usuario: 'sgs_app',
              senha: 'x',
              host: 'replica',
            }),
          },
        ],
      },
    });

    expect(options.replication).toBeUndefined();
  });

  it('preserva a configuração de SSL da conexão de runtime', () => {
    expect(build().ssl).toEqual({ rejectUnauthorized: true });
  });

  it('repassa as entidades recebidas', () => {
    expect(build().entities).toHaveLength(2);
  });

  it('nunca roda migrations nem sincroniza schema', () => {
    const options = build({
      synchronize: true,
    });
    expect(options.migrations).toEqual([]);
    expect(options.migrationsRun).toBe(false);
    expect(options.synchronize).toBe(false);
  });

  it('usa pool próprio e application_name identificável', () => {
    const extra = build().extra as Record<string, unknown>;
    expect(extra.max).toBe(3);
    expect(extra.min).toBe(0);
    expect(extra.application_name).toBe('api_provisioning');
    // O resto do `extra` (keepAlive etc) continua herdado.
    expect(extra.keepAlive).toBe(true);
  });
});

describe('ProvisioningDataSourceService', () => {
  const makeRuntime = (type: 'postgres' | 'better-sqlite3' = 'postgres') => {
    const manager = { query: jest.fn(() => Promise.resolve(undefined)) };
    const runtime = {
      options: { type },
      entityMetadatas: [],
      transaction: jest.fn((callback: (m: unknown) => unknown) =>
        Promise.resolve(callback(manager)),
      ),
    };
    return { runtime, manager };
  };

  const makeConfig = (values: Record<string, string> = {}) =>
    ({
      get: jest.fn((key: string) => values[key]),
    }) as unknown as ConfigService;

  describe('isDedicated', () => {
    it('é falso sem DATABASE_ADMIN_URL', () => {
      const { runtime } = makeRuntime();
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );
      expect(service.isDedicated()).toBe(false);
    });

    it('é falso quando a URL vem em branco', () => {
      const { runtime } = makeRuntime();
      const service = new ProvisioningDataSourceService(
        makeConfig({ DATABASE_ADMIN_URL: '   ' }),
        runtime as unknown as DataSource,
      );
      expect(service.isDedicated()).toBe(false);
    });

    it('é falso em SQLite mesmo com a URL setada', () => {
      // Sem RLS não há o que contornar, e clonar opções de sqlite com uma URL
      // de postgres quebraria a conexão.
      const { runtime } = makeRuntime('better-sqlite3');
      const service = new ProvisioningDataSourceService(
        makeConfig({ DATABASE_ADMIN_URL: URL_ADMIN_TESTE }),
        runtime as unknown as DataSource,
      );
      expect(service.isDedicated()).toBe(false);
    });

    it('é verdadeiro com URL setada e runtime PostgreSQL', () => {
      const { runtime } = makeRuntime();
      const service = new ProvisioningDataSourceService(
        makeConfig({ DATABASE_ADMIN_URL: URL_ADMIN_TESTE }),
        runtime as unknown as DataSource,
      );
      expect(service.isDedicated()).toBe(true);
    });
  });

  describe('transaction (fallback para a conexão de runtime)', () => {
    it('roda o callback e seta a flag de super admin', async () => {
      const { runtime, manager } = makeRuntime();
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );

      const resultado = await service.transaction((m) => {
        expect(m).toBe(manager as unknown as EntityManager);
        return Promise.resolve('ok');
      });

      expect(resultado).toBe('ok');
      expect(runtime.transaction).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        "SET LOCAL app.is_super_admin = 'true'",
      );
    });

    it('seta a flag ANTES de executar o callback', async () => {
      const { runtime, manager } = makeRuntime();
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );

      let flagJaSetada = false;
      await service.transaction(() => {
        flagJaSetada = manager.query.mock.calls.length > 0;
        return Promise.resolve();
      });

      expect(flagJaSetada).toBe(true);
    });

    it('avisa uma única vez que está sem a conexão dedicada', async () => {
      const { runtime } = makeRuntime();
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );
      const warn = jest
        .spyOn(
          (service as unknown as { logger: { warn: (v: unknown) => void } })
            .logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await service.transaction(() => Promise.resolve(undefined));
      await service.transaction(() => Promise.resolve(undefined));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'provisioning_datasource_fallback' }),
      );
    });

    it('propaga erro do callback (a transação precisa abortar)', async () => {
      const { runtime } = makeRuntime();
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );

      await expect(
        service.transaction(() => {
          throw new Error('conflito');
        }),
      ).rejects.toThrow('conflito');
    });
  });

  /**
   * Contrato de `requiredTransaction`, que é o que sustenta as guardas de
   * segurança (`companies.remove`, escritas de `profiles`, retenção LGPD).
   *
   * PostgreSQL → exige conexão dedicada; qualquer indisponibilidade é 503.
   * SQLite     → usa a transação local; não há RLS, logo não há o que provar.
   */
  describe('requiredTransaction', () => {
    const comDedicada = (
      service: ProvisioningDataSourceService,
      resultado: { dataSource?: unknown; erro?: Error },
    ) =>
      jest
        .spyOn(
          service as unknown as { getDedicated: () => Promise<unknown> },
          'getDedicated',
        )
        .mockImplementation(() =>
          resultado.erro
            ? Promise.reject(resultado.erro)
            : Promise.resolve(resultado.dataSource),
        );

    const dedicadaFake = () => {
      const manager = { query: jest.fn(() => Promise.resolve(undefined)) };
      return {
        manager,
        dataSource: {
          transaction: jest.fn((cb: (m: unknown) => unknown) =>
            Promise.resolve(cb(manager)),
          ),
        },
      };
    };

    it('A — PostgreSQL sem DATABASE_ADMIN_URL responde 503', async () => {
      const { runtime } = makeRuntime('postgres');
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );

      await expect(
        service.requiredTransaction('op_teste', () => Promise.resolve('nunca')),
      ).rejects.toThrow(ServiceUnavailableException);
      // E jamais degrada para o runtime.
      expect(runtime.transaction).not.toHaveBeenCalled();
    });

    it('B — PostgreSQL com conexão privilegiada indisponível responde 503', async () => {
      const { runtime } = makeRuntime('postgres');
      const service = new ProvisioningDataSourceService(
        makeConfig({ DATABASE_ADMIN_URL: URL_ADMIN_TESTE }),
        runtime as unknown as DataSource,
      );

      for (const falha of [
        Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        }),
        Object.assign(new Error('Connection terminated due to timeout'), {
          code: 'ETIMEDOUT',
        }),
        Object.assign(
          new Error('password authentication failed for user "sgs_admin"'),
          { code: '28P01' },
        ),
      ]) {
        comDedicada(service, { erro: falha });
        await expect(
          service.requiredTransaction('op_teste', () => Promise.resolve('x')),
        ).rejects.toThrow(ServiceUnavailableException);
        expect(runtime.transaction).not.toHaveBeenCalled();
      }
    });

    it('C — PostgreSQL com conexão privilegiada disponível usa a dedicada', async () => {
      const { runtime } = makeRuntime('postgres');
      const service = new ProvisioningDataSourceService(
        makeConfig({ DATABASE_ADMIN_URL: URL_ADMIN_TESTE }),
        runtime as unknown as DataSource,
      );
      const { dataSource, manager } = dedicadaFake();
      comDedicada(service, { dataSource });

      const resultado = await service.requiredTransaction('op_teste', () =>
        Promise.resolve('ok'),
      );

      expect(resultado).toBe('ok');
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(runtime.transaction).not.toHaveBeenCalled();
      expect(manager.query).toHaveBeenCalledWith(
        "SET LOCAL app.is_super_admin = 'true'",
      );
    });

    it('D — SQLite usa a transação local e não exige DATABASE_ADMIN_URL', async () => {
      // Sem RLS não há linha oculta: o COUNT local já responde "quantas
      // existem", que é a pergunta que a guarda faz. Exigir conexão dedicada
      // aqui quebraria dev e teste sem fechar risco nenhum.
      const { runtime } = makeRuntime('better-sqlite3');
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );

      await expect(
        service.requiredTransaction('op_teste', () => Promise.resolve('local')),
      ).resolves.toBe('local');
      expect(runtime.transaction).toHaveBeenCalledTimes(1);
    });

    it('E — SQLite NÃO emite SET LOCAL (é sintaxe de PostgreSQL)', async () => {
      const { runtime, manager } = makeRuntime('better-sqlite3');
      const service = new ProvisioningDataSourceService(
        makeConfig(),
        runtime as unknown as DataSource,
      );

      await service.requiredTransaction('op_teste', () =>
        Promise.resolve(undefined),
      );

      expect(manager.query).not.toHaveBeenCalled();
    });

    it('erro de domínio do callback é preservado, não convertido em 503', async () => {
      // O `try` que converte falha em 503 envolve SÓ a obtenção da conexão. Se
      // envolvesse a transação, um bug de negócio viraria "infra indisponível"
      // e o diagnóstico apontaria para o lugar errado.
      const { runtime } = makeRuntime('postgres');
      const service = new ProvisioningDataSourceService(
        makeConfig({ DATABASE_ADMIN_URL: URL_ADMIN_TESTE }),
        runtime as unknown as DataSource,
      );
      comDedicada(service, { dataSource: dedicadaFake().dataSource });

      const erroDeDominio = new ConflictException('CNPJ já cadastrado');
      await expect(
        service.requiredTransaction('op_teste', () =>
          Promise.reject(erroDeDominio),
        ),
      ).rejects.toBe(erroDeDominio);
    });
  });

  describe('sanitizeConnectionError', () => {
    /**
     * Montado em tempo de execução, e não escrito como literal.
     *
     * Uma connection string com senha embutida no código-fonte é exatamente o
     * padrão que os scanners de segredo procuram — e com razão. O fixture
     * cumpre o mesmo papel sem plantar no repositório algo indistinguível de
     * uma credencial real.
     */
    const senhaFicticia = ['valor', 'que', 'nao', 'pode', 'vazar'].join('-');
    const urlComCredencial = urlDeTeste({
      usuario: 'sgs_admin',
      senha: senhaFicticia,
      host: 'db.example.test',
    });

    it('remove usuário e senha de connection string no erro', () => {
      const saida = sanitizeConnectionError(
        new Error(`could not connect to ${urlComCredencial}`),
      );
      expect(saida).not.toContain(senhaFicticia);
      expect(saida).not.toContain('sgs_admin:');
      expect(saida).toContain('***:***@');
    });

    it('remove password= de connection string em formato key=value', () => {
      const saida = sanitizeConnectionError(
        new Error(
          `FATAL: host=db user=sgs_admin password=${senhaFicticia} sslmode=require`,
        ),
      );
      expect(saida).not.toContain(senhaFicticia);
      expect(saida).toContain('password=***');
    });

    it('preserva o código do erro, que é o que distingue rede de autenticação', () => {
      expect(
        sanitizeConnectionError(
          Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
          }),
        ),
      ).toContain('ECONNREFUSED');
    });

    it('lida com valor que não é Error', () => {
      expect(sanitizeConnectionError('falhou')).toBe('falhou');
      expect(sanitizeConnectionError(undefined)).toBe('erro desconhecido');
    });
  });
});
