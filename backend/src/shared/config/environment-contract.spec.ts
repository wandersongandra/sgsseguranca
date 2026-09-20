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
    TRUSTED_PROXY_MODE: 'cidr',
    DATABASE_URL: 'postgresql://user:password@db.example.invalid/sgs',
    JWT_SECRET: strong('access'),
    JWT_REFRESH_SECRET: strong('refresh'),
    SIGNATURE_TIMESTAMP_SECRET: strong('signature'),
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

  it('aceita metadata de identidade do build no runtime', () => {
    expect(() =>
      assertNoUnknownSgsEnvironmentKeys({
        ...apiEnvironment(),
        APP_COMMIT_SHA: 'release-sha',
        APP_VERSION: '2026.09.01',
        BUILD_ID: 'build-42',
      }),
    ).not.toThrow();
  });

  it('aceita configurações de produção consumidas pelo bootstrap da API', () => {
    expect(() =>
      assertNoUnknownSgsEnvironmentKeys({
        ...apiEnvironment(),
        ADMIN_IP_ALLOWLIST_REQUIRED: 'true',
        TENANT_BACKUP_ENCRYPTION_KEY: strong('tenant-backup'),
        DLQ_PRUNE_BATCH: '25',
        REDIS_USERNAME: 'runtime-user',
      }),
    ).not.toThrow();
  });

  it('aceita variáveis ambientais do runner por nome exato', () => {
    expect(() =>
      assertNoUnknownSgsEnvironmentKeys({
        ...apiEnvironment(),
        ENABLE_RUNNER_TRACING: '1',
        LEGACY_PASSWORD_AUTH_ENABLED: 'true',
        XDG_RUNTIME_DIR: '/tmp/runtime',
      }),
    ).not.toThrow();

    expect(() =>
      assertNoUnknownSgsEnvironmentKeys({
        ...apiEnvironment(),
        ENABLE_RUNNER_TRACINGE: '1',
      }),
    ).toThrow('ENABLE_RUNNER_TRACINGE');
  });

  it('mantém variável de evidência restrita ao contexto de teste', () => {
    const env = {
      ...apiEnvironment(),
      NODE_ENV: 'test',
      DR_E2E_EVIDENCE_PATH: 'temp/dr-e2e-evidence.json',
      TENANT_BACKUP_ROOT: 'temp/tenant-backups',
    };

    expect(() => validateCommonEnvironment(env, { component: 'api' })).toThrow(
      'DR_E2E_EVIDENCE_PATH, TENANT_BACKUP_ROOT',
    );
    expect(() =>
      validateCommonEnvironment(env, {
        component: 'api',
        allowedUnknownKeys: ['DR_E2E_EVIDENCE_PATH', 'TENANT_BACKUP_ROOT'],
      }),
    ).not.toThrow();

    expect(() =>
      validateCommonEnvironment(
        { ...env, NODE_ENV: 'production' },
        {
          component: 'api',
          allowedUnknownKeys: ['DR_E2E_EVIDENCE_PATH', 'TENANT_BACKUP_ROOT'],
        },
      ),
    ).toThrow('DR_E2E_EVIDENCE_PATH');
  });

  it('valida configuração válida de API sem expor valores', () => {
    expect(() =>
      validateCommonEnvironment(apiEnvironment(), { component: 'api' }),
    ).not.toThrow();
  });

  it('aceita um alias de cada grupo de credenciais do banco', () => {
    const env: NodeJS.ProcessEnv = {
      ...apiEnvironment(),
      DATABASE_URL: '',
      PGHOST: 'db.example.invalid',
      PGUSER: 'runtime',
      PGPASSWORD: strong('database'),
      PGDATABASE: 'sgs',
    };

    expect(() =>
      validateCommonEnvironment(env, { component: 'api' }),
    ).not.toThrow();

    delete env.PGPASSWORD;
    expect(() => validateCommonEnvironment(env, { component: 'api' })).toThrow(
      'DATABASE_URL or database host credentials: REQUIRED',
    );
  });

  it('exige modo explícito de proxy em ambiente semelhante à produção', () => {
    const missing = apiEnvironment();
    delete missing.TRUSTED_PROXY_MODE;
    expect(() =>
      validateCommonEnvironment(missing, { component: 'api' }),
    ).toThrow('TRUSTED_PROXY_MODE: REQUIRED_IN_PRODUCTION_LIKE_ENVIRONMENT');

    const invalid = apiEnvironment();
    invalid.TRUSTED_PROXY_MODE = 'trust-all';
    expect(() =>
      validateCommonEnvironment(invalid, { component: 'api' }),
    ).toThrow('TRUSTED_PROXY_MODE: INVALID_VALUE');
  });

  it('valida o boundary autenticado sem fallback para outro segredo', () => {
    const env = apiEnvironment();
    env.TRUSTED_PROXY_MODE = 'authenticated';
    env.TRUSTED_PROXY_AUTH_SECRET = strong('proxy-auth');
    env.TRUSTED_FORWARDED_HOP_CIDRS = '10.0.0.0/8';

    expect(() =>
      validateCommonEnvironment(env, { component: 'api' }),
    ).not.toThrow();

    const missingSecret = { ...env };
    delete missingSecret.TRUSTED_PROXY_AUTH_SECRET;
    expect(() =>
      validateCommonEnvironment(missingSecret, { component: 'api' }),
    ).toThrow('TRUSTED_PROXY_AUTH_SECRET');

    const sharedSecret = {
      ...env,
      TRUSTED_PROXY_AUTH_SECRET: env.JWT_SECRET,
    };
    expect(() =>
      validateCommonEnvironment(sharedSecret, { component: 'api' }),
    ).toThrow(
      'TRUSTED_PROXY_AUTH_SECRET: MUST_DIFFER_FROM_APPLICATION_SECRETS',
    );
  });

  it('aceita três domínios criptográficos distintos em ambiente não local', () => {
    const env = apiEnvironment();

    expect(env.JWT_SECRET).not.toBe(env.JWT_REFRESH_SECRET);
    expect(env.JWT_SECRET).not.toBe(env.SIGNATURE_TIMESTAMP_SECRET);
    expect(env.JWT_REFRESH_SECRET).not.toBe(env.SIGNATURE_TIMESTAMP_SECRET);
    expect(() =>
      validateCommonEnvironment(env, { component: 'api' }),
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

  it('exige chave de timestamp dedicada e diferente da chave JWT fora do local', () => {
    const missingSignatureKey = apiEnvironment();
    delete missingSignatureKey.SIGNATURE_TIMESTAMP_SECRET;
    expect(() =>
      validateCommonEnvironment(missingSignatureKey, { component: 'api' }),
    ).toThrow('SIGNATURE_TIMESTAMP_SECRET: REQUIRED');

    const placeholder = apiEnvironment();
    placeholder.SIGNATURE_TIMESTAMP_SECRET =
      'your_signature_timestamp_secret_change_me';
    expect(() =>
      validateCommonEnvironment(placeholder, { component: 'api' }),
    ).toThrow('SIGNATURE_TIMESTAMP_SECRET: PLACEHOLDER');

    const shared = apiEnvironment();
    shared.SIGNATURE_TIMESTAMP_SECRET = shared.JWT_SECRET;
    expect(() =>
      validateCommonEnvironment(shared, { component: 'api' }),
    ).toThrow('SIGNATURE_TIMESTAMP_SECRET: MUST_DIFFER_FROM_JWT_SECRET');
  });

  it('rejeita distinctness compartilhada entre timestamp e refresh JWT', () => {
    const sharedWithRefresh = apiEnvironment();
    sharedWithRefresh.SIGNATURE_TIMESTAMP_SECRET =
      sharedWithRefresh.JWT_REFRESH_SECRET;

    expect(() =>
      validateCommonEnvironment(sharedWithRefresh, { component: 'api' }),
    ).toThrow(
      'SIGNATURE_TIMESTAMP_SECRET: MUST_DIFFER_FROM_JWT_REFRESH_SECRET',
    );
  });

  it('aceita rotação com chave ativa separada e chaves históricas somente-verificação', () => {
    const env = apiEnvironment();
    delete env.SIGNATURE_TIMESTAMP_SECRET;
    env.SIGNATURE_TIMESTAMP_ACTIVE_KEY_ID = '2026-09';
    env.SIGNATURE_TIMESTAMP_ACTIVE_SECRET = strong('active-signature');
    env.SIGNATURE_TIMESTAMP_VERIFICATION_KEYS_JSON = JSON.stringify({
      'legacy-v1': strong('historical-signature'),
    });

    expect(() =>
      validateCommonEnvironment(env, { component: 'api' }),
    ).not.toThrow();
  });

  it('exige o par ativo completo e rejeita mapa histórico malformado', () => {
    const missingPair = apiEnvironment();
    delete missingPair.SIGNATURE_TIMESTAMP_ACTIVE_SECRET;
    missingPair.SIGNATURE_TIMESTAMP_ACTIVE_KEY_ID = '2026-09';
    expect(() =>
      validateCommonEnvironment(missingPair, { component: 'api' }),
    ).toThrow('REQUIRED_TOGETHER');

    const malformed = apiEnvironment();
    malformed.SIGNATURE_TIMESTAMP_VERIFICATION_KEYS_JSON = '{not-json';
    expect(() =>
      validateCommonEnvironment(malformed, { component: 'api' }),
    ).toThrow('SIGNATURE_TIMESTAMP_VERIFICATION_KEYS_JSON: INVALID_JSON');
  });

  it('rejeita typo da chave dedicada no namespace SGS', () => {
    expect(() =>
      assertNoUnknownSgsEnvironmentKeys({
        ...apiEnvironment(),
        SIGNATURE_TIMESTAP_SECRET: 'synthetic-typo',
      }),
    ).toThrow('SIGNATURE_TIMESTAP_SECRET');
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
