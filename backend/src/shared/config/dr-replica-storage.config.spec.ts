import { resolveDrReplicaStorageConfig } from './dr-replica-storage.config';

function reader(values: Record<string, unknown>) {
  return (key: string): unknown => values[key];
}

const completeReplica = (overrides: Record<string, unknown> = {}) => ({
  DR_STORAGE_REPLICA_BUCKET: 'dr-bucket',
  DR_STORAGE_REPLICA_ENDPOINT: 'https://dr.example.invalid',
  DR_STORAGE_REPLICA_REGION: 'auto',
  DR_STORAGE_REPLICA_ACCESS_KEY_ID: 'dr-access',
  DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: 'dr-secret',
  AWS_BUCKET_NAME: 'primary-bucket',
  AWS_ACCESS_KEY_ID: 'primary-access',
  AWS_SECRET_ACCESS_KEY: 'primary-secret',
  ...overrides,
});

describe('resolveDrReplicaStorageConfig', () => {
  it('mantém DR desabilitado quando nenhuma configuração de réplica existe', () => {
    expect(
      resolveDrReplicaStorageConfig(
        reader({
          AWS_BUCKET_NAME: 'primary-bucket',
          AWS_ACCESS_KEY_ID: 'primary-access',
          AWS_SECRET_ACCESS_KEY: 'primary-secret',
        }),
      ),
    ).toEqual({
      configured: false,
      bucketName: null,
      endpoint: null,
      region: 'auto',
      forcePathStyle: false,
      accessKeyId: '',
      secretAccessKey: '',
    });
  });

  it('tolera somente defaults não materiais sem considerar DR configurado', () => {
    expect(
      resolveDrReplicaStorageConfig(
        reader({
          DR_STORAGE_REPLICA_REGION: 'auto',
          DR_STORAGE_REPLICA_FORCE_PATH_STYLE: true,
        }),
      ),
    ).toEqual({
      configured: false,
      bucketName: null,
      endpoint: null,
      region: 'auto',
      forcePathStyle: false,
      accessKeyId: '',
      secretAccessKey: '',
    });
  });

  it('aceita réplica completa e independente com boolean já convertido pelo ConfigService', () => {
    expect(
      resolveDrReplicaStorageConfig(
        reader(completeReplica({ DR_STORAGE_REPLICA_FORCE_PATH_STYLE: false })),
      ),
    ).toEqual({
      configured: true,
      bucketName: 'dr-bucket',
      endpoint: 'https://dr.example.invalid',
      region: 'auto',
      forcePathStyle: true,
      accessKeyId: 'dr-access',
      secretAccessKey: 'dr-secret',
    });
  });

  it.each(['true', ' TRUE ', 'false', ' FALSE ', true, false])(
    'aceita forcePathStyle canônico %p sem TypeError',
    (rawForcePathStyle) => {
      expect(() =>
        resolveDrReplicaStorageConfig(
          reader({ DR_STORAGE_REPLICA_FORCE_PATH_STYLE: rawForcePathStyle }),
        ),
      ).not.toThrow();
    },
  );

  it.each(['yes', '1', 'enabled', 'TRUE-ish'])(
    'falha fechado para boolean não canônico %p',
    (invalidBoolean) => {
      expect(() =>
        resolveDrReplicaStorageConfig(
          reader({ DR_STORAGE_REPLICA_FORCE_PATH_STYLE: invalidBoolean }),
        ),
      ).toThrow('DR_STORAGE_REPLICA_FORCE_PATH_STYLE must be true or false');
    },
  );

  it.each([0, 1, {}, [], Symbol('invalid')])(
    'falha de forma explícita para tipo inválido no forcePathStyle: %p',
    (invalidBoolean) => {
      expect(() =>
        resolveDrReplicaStorageConfig(
          reader({ DR_STORAGE_REPLICA_FORCE_PATH_STYLE: invalidBoolean }),
        ),
      ).toThrow('DR_STORAGE_REPLICA_FORCE_PATH_STYLE must be a boolean');
    },
  );

  it.each([
    ['DR_STORAGE_REPLICA_BUCKET', 123],
    ['DR_STORAGE_REPLICA_ENDPOINT', true],
    ['DR_STORAGE_REPLICA_REGION', {}],
    ['DR_STORAGE_REPLICA_ACCESS_KEY_ID', []],
    ['DR_STORAGE_REPLICA_SECRET_ACCESS_KEY', 42],
  ])('falha fechado sem TypeError quando %s não é string', (key, value) => {
    expect(() =>
      resolveDrReplicaStorageConfig(reader({ [key]: value })),
    ).toThrow(`${key} must be a string`);
  });

  it('normaliza espaços antes de validar independência', () => {
    expect(() =>
      resolveDrReplicaStorageConfig(
        reader(
          completeReplica({
            DR_STORAGE_REPLICA_BUCKET: ' primary-bucket ',
            AWS_BUCKET_NAME: 'primary-bucket',
          }),
        ),
      ),
    ).toThrow('replica bucket must be independent');
  });

  it('não usa credenciais primárias como fallback para réplica parcial', () => {
    expect(() =>
      resolveDrReplicaStorageConfig(
        reader({
          DR_STORAGE_REPLICA_BUCKET: 'dr-bucket',
          DR_STORAGE_REPLICA_ENDPOINT: 'https://dr.example.invalid',
          AWS_ACCESS_KEY_ID: 'primary-access',
          AWS_SECRET_ACCESS_KEY: 'primary-secret',
        }),
      ),
    ).toThrow('DR_STORAGE_REPLICA_ACCESS_KEY_ID');
  });

  it('lista todos os campos materiais ausentes na réplica parcial', () => {
    expect(() =>
      resolveDrReplicaStorageConfig(
        reader({ DR_STORAGE_REPLICA_BUCKET: 'dr-bucket' }),
      ),
    ).toThrow(
      'DR_STORAGE_REPLICA_ENDPOINT, DR_STORAGE_REPLICA_ACCESS_KEY_ID, DR_STORAGE_REPLICA_SECRET_ACCESS_KEY',
    );
  });

  it('falha quando o bucket de DR reutiliza o bucket primário', () => {
    expect(() =>
      resolveDrReplicaStorageConfig(
        reader(
          completeReplica({ DR_STORAGE_REPLICA_BUCKET: 'primary-bucket' }),
        ),
      ),
    ).toThrow('replica bucket must be independent');
  });

  it('também detecta reutilização via alias AWS_S3_BUCKET', () => {
    expect(() =>
      resolveDrReplicaStorageConfig(
        reader(
          completeReplica({
            AWS_BUCKET_NAME: undefined,
            AWS_S3_BUCKET: 'dr-bucket',
          }),
        ),
      ),
    ).toThrow('replica bucket must be independent');
  });

  it('falha quando a chave de acesso de DR reutiliza a primária', () => {
    expect(() =>
      resolveDrReplicaStorageConfig(
        reader(
          completeReplica({
            DR_STORAGE_REPLICA_ACCESS_KEY_ID: 'primary-access',
          }),
        ),
      ),
    ).toThrow('replica access key must be independent');
  });

  it('falha quando o segredo de DR reutiliza o segredo primário', () => {
    expect(() =>
      resolveDrReplicaStorageConfig(
        reader(
          completeReplica({
            DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: 'primary-secret',
          }),
        ),
      ),
    ).toThrow('replica secret must be independent');
  });

  it('não inclui os valores secretos na mensagem de erro de reutilização', () => {
    let message = '';
    try {
      resolveDrReplicaStorageConfig(
        reader(
          completeReplica({
            DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: 'super-sensitive-value',
            AWS_SECRET_ACCESS_KEY: 'super-sensitive-value',
          }),
        ),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('replica secret must be independent');
    expect(message).not.toContain('super-sensitive-value');
  });

  it('trata null/undefined em campos opcionais como ausência, sem crash', () => {
    expect(
      resolveDrReplicaStorageConfig(
        reader({
          DR_STORAGE_REPLICA_BUCKET: null,
          DR_STORAGE_REPLICA_ENDPOINT: undefined,
          DR_STORAGE_REPLICA_REGION: null,
          DR_STORAGE_REPLICA_ACCESS_KEY_ID: undefined,
          DR_STORAGE_REPLICA_SECRET_ACCESS_KEY: null,
          DR_STORAGE_REPLICA_FORCE_PATH_STYLE: undefined,
        }),
      ),
    ).toMatchObject({
      configured: false,
      region: 'auto',
      forcePathStyle: false,
    });
  });
});
