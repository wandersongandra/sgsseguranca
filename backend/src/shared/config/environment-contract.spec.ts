import {
  EnvironmentContractError,
  assertNoUnknownSgsEnvironmentKeys,
  parseStrictBoolean,
  parseStrictPositiveInteger,
  validateCommonEnvironment,
} from './environment-contract';

const strong = (prefix: string) => `${prefix}-${'x'.repeat(64)}`;

function apiEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'staging',
    DATABASE_URL: 'postgresql://user:password@db.example.invalid/sgs',
    JWT_SECRET: strong('access'),
    JWT_REFRESH_SECRET: strong('refresh'),
    JWT_ISSUER: 'https://api.example.invalid',
    JWT_AUDIENCE: 'sgs-test',
    REFRESH_CSRF_ENFORCED: 'true',
    REDIS_DISABLED: 'true',
    MAIL_ENABLED: 'false',
    FEATURE_AI_ENABLED: 'false',
    FIELD_ENCRYPTION_ENABLED: 'true',
    FIELD_ENCRYPTION_KEY: strong('field'),
    FIELD_ENCRYPTION_HASH_KEY: strong('hash'),
    DOCUMENT_DOWNLOAD_TOKEN_SECRET: strong('download'),
  };
}

describe('environment contract', () => {
  it('aceita variáveis do sistema sem aceitar typo do namespace SGS', () => {
    const env = {
      ...apiEnvironment(),
      PATH: '/usr/bin',
      HOSTNAME: 'container',
      HOME: '/tmp',
      JWT_AUDIENCEE: 'typo',
    };

    expect(() => assertNoUnknownSgsEnvironmentKeys(env)).toThrow(
      'JWT_AUDIENCEE',
    );
    expect(() =>
      assertNoUnknownSgsEnvironmentKeys({ ...env, JWT_AUDIENCEE: undefined }),
    ).not.toThrow();
  });

  it('valida configuração válida de API sem expor valores', () => {
    expect(() =>
      validateCommonEnvironment(apiEnvironment(), { component: 'api' }),
    ).not.toThrow();
  });

  it('falha em boolean, número e URL inválidos', () => {
    const env = apiEnvironment();
    env.FEATURE_AI_ENABLED = 'maybe';
    expect(() => validateCommonEnvironment(env, { component: 'api' })).toThrow(
      'FEATURE_AI_ENABLED: INVALID_BOOLEAN',
    );

    expect(() =>
      parseStrictPositiveInteger({ PORT: '-1' }, 'PORT', {
        min: 1,
        max: 65535,
      }),
    ).toThrow('PORT: INVALID_NUMBER');
    expect(() =>
      validateCommonEnvironment(
        { ...apiEnvironment(), API_PUBLIC_URL: 'not-a-url' },
        { component: 'api' },
      ),
    ).toThrow('API_PUBLIC_URL: INVALID_URL');
  });

  it('falha em segredo ausente, placeholder ou JWT sem issuer/audience', () => {
    const missing = apiEnvironment();
    delete missing.JWT_SECRET;
    expect(() =>
      validateCommonEnvironment(missing, { component: 'api' }),
    ).toThrow('JWT_SECRET: REQUIRED');

    const placeholder = apiEnvironment();
    placeholder.JWT_SECRET = 'changeme';
    expect(() =>
      validateCommonEnvironment(placeholder, { component: 'api' }),
    ).toThrow('JWT_SECRET: PLACEHOLDER');

    const missingClaims = apiEnvironment();
    delete missingClaims.JWT_ISSUER;
    expect(() =>
      validateCommonEnvironment(missingClaims, { component: 'api' }),
    ).toThrow('JWT_ISSUER: REQUIRED');
  });

  it('falha quando feature ativa não possui dependência obrigatória', () => {
    const ai = apiEnvironment();
    ai.FEATURE_AI_ENABLED = 'true';
    ai.AI_PROVIDER = 'openai';
    expect(() => validateCommonEnvironment(ai, { component: 'api' })).toThrow(
      'OPENAI_API_KEY: REQUIRED',
    );

    const mail = apiEnvironment();
    mail.MAIL_ENABLED = 'true';
    expect(() => validateCommonEnvironment(mail, { component: 'api' })).toThrow(
      'MAIL provider: REQUIRED_WHEN_MAIL_ENABLED',
    );
  });

  it('mantém o worker independente de JWT/CSRF, mas exige DB, Redis e heartbeat', () => {
    const env: NodeJS.ProcessEnv = {
      ...apiEnvironment(),
      NODE_ENV: 'staging',
      REDIS_DISABLED: 'false',
      REDIS_QUEUE_URL: 'redis://:password@redis.example.invalid:6379',
      WORKER_HEARTBEAT_REQUIRED: 'true',
      WORKER_HEARTBEAT_ENABLED: 'true',
      WORKER_HEARTBEAT_KEY: 'worker:heartbeat:test',
      WORKER_HEARTBEAT_TTL_SECONDS: '90',
    };
    delete env.JWT_SECRET;
    delete env.JWT_REFRESH_SECRET;
    delete env.JWT_ISSUER;
    delete env.JWT_AUDIENCE;
    delete env.REFRESH_CSRF_ENFORCED;

    expect(() =>
      validateCommonEnvironment(env, {
        component: 'worker',
        requireQueueRedis: true,
      }),
    ).not.toThrow();

    const noRedis = { ...env, REDIS_DISABLED: 'true' };
    expect(() =>
      validateCommonEnvironment(noRedis, {
        component: 'worker',
        requireQueueRedis: true,
      }),
    ).toThrow('REDIS_DISABLED: WORKER_REDIS_REQUIRED');
  });

  it('mantém erros sanitizados, sem valor de secret ou URL', () => {
    const secret = 'super-secret-value-that-must-not-appear';
    try {
      validateCommonEnvironment(
        { ...apiEnvironment(), JWT_SECRET: secret, JWT_AUDIENCEE: secret },
        { component: 'api' },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentContractError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it('aceita apenas os booleanos definidos pelo contrato', () => {
    expect(parseStrictBoolean({ FLAG: 'false' }, 'FLAG')).toBe(false);
    expect(parseStrictBoolean({ FLAG: 'TRUE' }, 'FLAG')).toBe(true);
    expect(parseStrictBoolean({ FLAG: '0' }, 'FLAG')).toBe(false);
    expect(parseStrictBoolean({ FLAG: 'yes' }, 'FLAG')).toBe(true);
    expect(() => parseStrictBoolean({ FLAG: 'truthy' }, 'FLAG')).toThrow(
      'FLAG: INVALID_BOOLEAN',
    );
  });
});
