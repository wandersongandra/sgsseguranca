import type { ObjectSchema, ValidationResult } from 'joi';

describe('AppModule production environment validation', () => {
  const postgresScheme = 'postgresql://';

  const productionEnv = {
    NODE_ENV: 'production',
    TRUSTED_PROXY_MODE: 'cidr',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    DATABASE_URL: `${postgresScheme}sgs_app:placeholder@ep-example.sa-east-1.aws.neon.tech/neondb`,
    DATABASE_SSL: true,
    DATABASE_POOLER_ALLOW_SESSION_RLS: true,
    REDIS_DISABLED: 'true',
    JWT_SECRET: 'sgs-prod-access-key-A9'.repeat(4),
    JWT_REFRESH_SECRET: 'sgs-prod-refresh-key-B8'.repeat(4),
    SIGNATURE_TIMESTAMP_SECRET: 's'.repeat(64),
    JWT_ISSUER: 'https://api.sgsseguranca.com.br',
    JWT_AUDIENCE: 'sgs-app',
    MFA_TOTP_ENCRYPTION_KEY: 'c'.repeat(32),
    AWS_BUCKET_NAME: 'sgs-01',
    AWS_ENDPOINT:
      'https://6c64d54915231ae358b11475b268ae9b.r2.cloudflarestorage.com',
    AWS_ACCESS_KEY_ID: 'primary-test-access-key',
    AWS_SECRET_ACCESS_KEY: 'primary-test-secret',
    S3_FORCE_PATH_STYLE: true,
    DR_STORAGE_REPLICA_BUCKET: 'sgs-02',
    DR_STORAGE_REPLICA_ENDPOINT:
      'https://6c64d54915231ae358b11475b268ae9b.r2.cloudflarestorage.com',
    DR_STORAGE_REPLICA_ACCESS_KEY_ID: 'dr-test-access-key',
    DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: 'dr-test-secret',
    DR_STORAGE_REPLICA_FORCE_PATH_STYLE: true,
    // Campos de segurança obrigatórios em produção
    CSRF_TOKEN_SECRET: 'a'.repeat(32),
    BULL_BOARD_PASS: 'admin-secure-pass',
    ANTIVIRUS_PROVIDER: 'clamav',
    AUTH_DUMMY_PASSWORD_HASH: 'a'.repeat(64),
    SECURITY_AUDIT_HMAC_KEY: 'd'.repeat(32),
    DOCUMENT_DOWNLOAD_TOKEN_SECRET: 'e'.repeat(64),
    FIELD_ENCRYPTION_ENABLED: true,
    FIELD_ENCRYPTION_KEY: 'f'.repeat(64),
    FIELD_ENCRYPTION_HASH_KEY: 'g'.repeat(64),
    FEATURE_AI_ENABLED: 'false',
    MAIL_ENABLED: 'false',
  };

  const originalEnv = process.env;
  let validationSchema: ObjectSchema;

  const applyProductionEnvironment = () => {
    process.env = {
      ...originalEnv,
      ...Object.fromEntries(
        Object.entries(productionEnv).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    };
  };

  beforeAll(async () => {
    // Importar AppModule repetidamente após jest.resetModules() reinstancia
    // dependências que registram listeners em `process`. O schema é imutável
    // para estes testes; carregá-lo uma única vez testa o mesmo contrato sem
    // produzir um falso vazamento de listeners no harness.
    applyProductionEnvironment();
    const appModule = (await import('./app.module')) as {
      validationSchema: ObjectSchema;
    };
    validationSchema = appModule.validationSchema;
    process.env = originalEnv;
  });

  beforeEach(() => {
    applyProductionEnvironment();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function validate(values: Record<string, unknown>) {
    return validationSchema.validate(values, {
      abortEarly: false,
      allowUnknown: true,
    });
  }

  function getCustomMessage(result: ValidationResult): string {
    const context = result.error?.details[0]?.context as
      { message?: string } | undefined;
    return context?.message || result.error?.message || '';
  }

  it('aceita configuração R2 governada com réplica DR e credenciais independentes', () => {
    const result = validate(productionEnv);

    expect(result.error).toBeUndefined();
  });

  it('reutiliza o schema sem acumular listeners de exit no processo', () => {
    const listenersBefore = process.listenerCount('exit');

    for (let index = 0; index < 20; index += 1) {
      const result = validate(productionEnv);
      expect(result.error).toBeUndefined();
    }

    expect(process.listenerCount('exit')).toBe(listenersBefore);
  });

  it('bloqueia typo do namespace SGS sem rejeitar o ambiente do container', () => {
    const result = validate({
      ...productionEnv,
      PATH: '/usr/bin',
      HOSTNAME: 'synthetic-container',
      JWT_AUDIENCEE: 'must-not-be-printed',
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain('JWT_AUDIENCEE');
    expect(result.error?.message).not.toContain('must-not-be-printed');
  });

  it('bloqueia produção sem chave HMAC exclusiva para auditoria', () => {
    const result = validate({
      ...productionEnv,
      SECURITY_AUDIT_HMAC_KEY: '',
    });

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('SECURITY_AUDIT_HMAC_KEY');
  });

  it('bloqueia produção sem bucket ou credenciais do storage documental', () => {
    const result = validate({
      ...productionEnv,
      AWS_BUCKET_NAME: '',
      AWS_ACCESS_KEY_ID: '',
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain(
      'Produção exige storage documental governado',
    );
  });

  it('bloqueia Cloudflare R2 em produção sem path-style habilitado', () => {
    const result = validate({
      ...productionEnv,
      S3_FORCE_PATH_STYLE: false,
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain(
      'Cloudflare R2 exige S3_FORCE_PATH_STYLE=true',
    );
  });

  it('bloqueia tentativa de TLS inseguro no Postgres', () => {
    const result = validate({
      ...productionEnv,
      DATABASE_SSL: false,
      DATABASE_SSL_ALLOW_INSECURE: true,
      DATABASE_SSL_ALLOW_INSECURE_FORCE: true,
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain('DATABASE_SSL_ALLOW_INSECURE');
  });

  it('bloqueia bucket DR sem endpoint de réplica', () => {
    const result = validate({
      ...productionEnv,
      DR_STORAGE_REPLICA_ENDPOINT: '',
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain(
      'DR_STORAGE_REPLICA_BUCKET foi configurado',
    );
  });

  it('exige credenciais DR canônicas mesmo quando credenciais primárias existem', () => {
    const result = validate({
      ...productionEnv,
      DR_STORAGE_REPLICA_ACCESS_KEY_ID: '',
      DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: '',
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain(
      'DR_STORAGE_REPLICA_BUCKET foi configurado',
    );
  });

  it('bloqueia REFRESH_CSRF_ENFORCED=false fora de development/test', () => {
    const result = validate({
      ...productionEnv,
      NODE_ENV: 'staging',
      REFRESH_CSRF_ENFORCED: false,
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain(
      'REFRESH_CSRF_ENFORCED: MUST_BE_TRUE_NON_LOCAL',
    );
  });

  it('permite REFRESH_CSRF_ENFORCED=false em development local', () => {
    const result = validate({
      ...productionEnv,
      NODE_ENV: 'development',
      REFRESH_CSRF_ENFORCED: false,
    });

    expect(result.error).toBeUndefined();
  });

  it('bloqueia REFRESH_CSRF_REPORT_ONLY=true fora de development/test', () => {
    const result = validate({
      ...productionEnv,
      NODE_ENV: 'staging',
      REFRESH_CSRF_ENFORCED: true,
      REFRESH_CSRF_REPORT_ONLY: true,
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain(
      'REFRESH_CSRF_REPORT_ONLY=true só é permitido em ambiente local',
    );
  });

  it('bloqueia staging sem issuer ou audience JWT', () => {
    const result = validate({
      ...productionEnv,
      NODE_ENV: 'staging',
      JWT_ISSUER: '',
      JWT_AUDIENCE: '',
      REFRESH_CSRF_ENFORCED: true,
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain('JWT_ISSUER: REQUIRED');
  });

  it('bloqueia segredo JWT previsível ou compartilhado fora do ambiente local', () => {
    const weak = validate({
      ...productionEnv,
      NODE_ENV: 'staging',
      JWT_SECRET: 'a'.repeat(64),
      REFRESH_CSRF_ENFORCED: true,
    });
    const shared = validate({
      ...productionEnv,
      NODE_ENV: 'staging',
      JWT_REFRESH_SECRET: productionEnv.JWT_SECRET,
      REFRESH_CSRF_ENFORCED: true,
    });

    expect(getCustomMessage(weak)).toContain('não podem usar placeholders');
    expect(getCustomMessage(shared)).toContain(
      'JWT_REFRESH_SECRET: MUST_DIFFER_FROM_JWT_SECRET',
    );
  });

  it('bloqueia produção sem chave dedicada de timestamp ou com chave JWT compartilhada', () => {
    const missing = validate({
      ...productionEnv,
      SIGNATURE_TIMESTAMP_SECRET: '',
    });
    const shared = validate({
      ...productionEnv,
      SIGNATURE_TIMESTAMP_SECRET: productionEnv.JWT_SECRET,
    });
    const sharedWithRefresh = validate({
      ...productionEnv,
      SIGNATURE_TIMESTAMP_SECRET: productionEnv.JWT_REFRESH_SECRET,
    });

    expect(getCustomMessage(missing)).toContain(
      'SIGNATURE_TIMESTAMP_SECRET: REQUIRED',
    );
    expect(getCustomMessage(shared)).toContain(
      'SIGNATURE_TIMESTAMP_SECRET: MUST_DIFFER_FROM_JWT_SECRET',
    );
    expect(getCustomMessage(sharedWithRefresh)).toContain(
      'SIGNATURE_TIMESTAMP_SECRET: MUST_DIFFER_FROM_JWT_REFRESH_SECRET',
    );
  });

  it('aceita somente o par ativo quando a chave legada está no mapa de verificação', () => {
    const rotated = {
      ...productionEnv,
      SIGNATURE_TIMESTAMP_SECRET: '',
      SIGNATURE_TIMESTAMP_ACTIVE_KEY_ID: '2026-09',
      SIGNATURE_TIMESTAMP_ACTIVE_SECRET: 'a'.repeat(64),
      SIGNATURE_TIMESTAMP_VERIFICATION_KEYS_JSON: JSON.stringify({
        'legacy-v1': 'b'.repeat(64),
      }),
    };

    const result = validate(rotated);

    expect(result.error).toBeUndefined();
  });

  it('bloqueia access token sem expiração em staging', () => {
    const result = validate({
      ...productionEnv,
      NODE_ENV: 'staging',
      ACCESS_TOKEN_TTL: 'infinite',
      REFRESH_CSRF_ENFORCED: true,
    });

    expect(result.error).toBeDefined();
    expect(getCustomMessage(result)).toContain('deve ser finito e positivo');
  });

  it('permite REFRESH_CSRF_REPORT_ONLY=true em development local', () => {
    const result = validate({
      ...productionEnv,
      NODE_ENV: 'development',
      REFRESH_CSRF_REPORT_ONLY: true,
    });

    expect(result.error).toBeUndefined();
  });
});
