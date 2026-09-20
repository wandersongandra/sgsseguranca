export type DrReplicaStorageConfig = {
  configured: boolean;
  bucketName: string | null;
  endpoint: string | null;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
};

type ReadConfig = (key: string) => unknown;

function fail(message: string): never {
  throw new Error(`DR_REPLICA_STORAGE_CONFIG_INVALID: ${message}`);
}

function normalizeString(key: string, value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    fail(`${key} must be a string`);
  }

  return value.trim();
}

function normalizeBoolean(key: string, value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    fail(`${key} must be a boolean`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'false') {
    return false;
  }
  if (normalized === 'true') {
    return true;
  }

  fail(`${key} must be true or false`);
}

export function resolveDrReplicaStorageConfig(
  read: ReadConfig,
): DrReplicaStorageConfig {
  const bucketName = normalizeString(
    'DR_STORAGE_REPLICA_BUCKET',
    read('DR_STORAGE_REPLICA_BUCKET'),
  );
  const endpoint = normalizeString(
    'DR_STORAGE_REPLICA_ENDPOINT',
    read('DR_STORAGE_REPLICA_ENDPOINT'),
  );
  const region =
    normalizeString(
      'DR_STORAGE_REPLICA_REGION',
      read('DR_STORAGE_REPLICA_REGION'),
    ) || 'auto';
  const accessKeyId = normalizeString(
    'DR_STORAGE_REPLICA_ACCESS_KEY_ID',
    read('DR_STORAGE_REPLICA_ACCESS_KEY_ID'),
  );
  const secretAccessKey = normalizeString(
    'DR_STORAGE_REPLICA_SECRET_ACCESS_KEY',
    read('DR_STORAGE_REPLICA_SECRET_ACCESS_KEY'),
  );
  const forcePathStyle = normalizeBoolean(
    'DR_STORAGE_REPLICA_FORCE_PATH_STYLE',
    read('DR_STORAGE_REPLICA_FORCE_PATH_STYLE'),
  );

  // Region/force-path-style may be harmless defaults in an environment.
  // A replica is considered intentionally configured only when at least one
  // material endpoint/bucket/credential field is present.
  const hasReplicaConfiguration = [
    bucketName,
    endpoint,
    accessKeyId,
    secretAccessKey,
  ].some((value) => value.length > 0);

  if (!hasReplicaConfiguration) {
    return {
      configured: false,
      bucketName: null,
      endpoint: null,
      region,
      forcePathStyle: false,
      accessKeyId: '',
      secretAccessKey: '',
    };
  }

  const missing = [
    ['DR_STORAGE_REPLICA_BUCKET', bucketName],
    ['DR_STORAGE_REPLICA_ENDPOINT', endpoint],
    ['DR_STORAGE_REPLICA_ACCESS_KEY_ID', accessKeyId],
    ['DR_STORAGE_REPLICA_SECRET_ACCESS_KEY', secretAccessKey],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    fail(`missing required replica setting(s): ${missing.join(', ')}`);
  }

  const primaryBucket =
    normalizeString('AWS_BUCKET_NAME', read('AWS_BUCKET_NAME')) ||
    normalizeString('AWS_S3_BUCKET', read('AWS_S3_BUCKET'));
  const primaryAccessKeyId = normalizeString(
    'AWS_ACCESS_KEY_ID',
    read('AWS_ACCESS_KEY_ID'),
  );
  const primarySecretAccessKey = normalizeString(
    'AWS_SECRET_ACCESS_KEY',
    read('AWS_SECRET_ACCESS_KEY'),
  );

  if (primaryBucket && primaryBucket === bucketName) {
    fail('replica bucket must be independent from the primary storage bucket');
  }
  if (primaryAccessKeyId && primaryAccessKeyId === accessKeyId) {
    fail('replica access key must be independent from the primary storage key');
  }
  if (primarySecretAccessKey && primarySecretAccessKey === secretAccessKey) {
    fail('replica secret must be independent from the primary storage secret');
  }

  return {
    configured: true,
    bucketName,
    endpoint,
    region,
    forcePathStyle: forcePathStyle || Boolean(endpoint),
    accessKeyId,
    secretAccessKey,
  };
}
