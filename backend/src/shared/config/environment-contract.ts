import { URL } from 'node:url';

export type EnvironmentComponent =
  'api' | 'worker' | 'migration' | 'script' | 'loadtest';

export type EnvironmentContractOptions = {
  component: EnvironmentComponent;
  knownKeys?: Iterable<string>;
  requireDatabase?: boolean;
  requireQueueRedis?: boolean;
  validateFeatureIntegrations?: boolean;
};

export class EnvironmentContractError extends Error {
  readonly code = 'ENVIRONMENT_CONTRACT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentContractError';
  }
}

/**
 * Chaves do processo que pertencem ao runtime do SGS ou aos scripts
 * operacionais inventariados. Valores nunca fazem parte das mensagens.
 *
 * A lista é deliberadamente explícita: variáveis do SO/container são aceitas
 * por política separada abaixo, enquanto novas variáveis SGS exigem inclusão
 * consciente neste contrato.
 */
export const KNOWN_SGS_ENV_KEYS = new Set<string>([
  'ACCESS_TOKEN_TTL',
  'ADMIN_EMPRESA_MFA_ENFORCEMENT_DATE',
  'ADMIN_EMPRESA_MFA_REQUIRED',
  'ADMIN_EMPRESA_STEP_UP_PASSWORD_FALLBACK_ENABLED',
  'ADMIN_GERAL_MFA_REQUIRED',
  'ADMIN_IP_ALLOWLIST',
  'AI_HISTORY_DEFAULT_DAYS',
  'AI_HISTORY_MAX_DAYS',
  'AI_HISTORY_MAX_LIMIT',
  'AI_PROVIDER',
  'AI_RECOVERY_MAX_AGE_MS',
  'ALERTS_DLQ_COOLDOWN_MS',
  'ALERTS_ENABLED',
  'ALERTS_ERROR_RATE_THRESHOLD',
  'ALERTS_HTTP_AVG_LATENCY_MS_THRESHOLD',
  'ALERTS_MIN_REQUESTS',
  'ALERTS_POOL_USAGE_THRESHOLD',
  'ALERTS_QUEUE_WAITING_THRESHOLD',
  'ALLOW_DEV_LOGIN_BYPASS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTIVIRUS_PROVIDER',
  'API_CRONS_DISABLED',
  'API_PUBLIC_URL',
  'APP_ENV',
  'APP_LOADTEST_MARKER',
  'APP_URL',
  'APR_CREATE_TENANT_THROTTLE_HOUR_LIMIT',
  'APR_CREATE_TENANT_THROTTLE_LIMIT',
  'APR_CREATE_USER_THROTTLE_LIMIT',
  'APR_FINAL_PDF_REQUEST_TIMEOUT_MS',
  'APR_ID_FOR_MAIL_TEST',
  'APR_LIST_TENANT_THROTTLE_HOUR_LIMIT',
  'APR_LIST_TENANT_THROTTLE_LIMIT',
  'APR_LIST_USER_THROTTLE_LIMIT',
  'APR_OVERVIEW_CACHE_TTL_SECONDS',
  'ARR_CREATE_TENANT_THROTTLE_HOUR_LIMIT',
  'ARR_CREATE_TENANT_THROTTLE_LIMIT',
  'ARR_PDF_SIGNED_URL_EXPIRY_SECONDS',
  'ARR_STATUS_TENANT_THROTTLE_HOUR_LIMIT',
  'ARR_STATUS_TENANT_THROTTLE_LIMIT',
  'ARR_UPDATE_TENANT_THROTTLE_HOUR_LIMIT',
  'ARR_UPDATE_TENANT_THROTTLE_LIMIT',
  'ARR_UPLOAD_TENANT_THROTTLE_HOUR_LIMIT',
  'ARR_UPLOAD_TENANT_THROTTLE_LIMIT',
  'AUDIT_LOG_RETENTION_DAYS',
  'AUTH_COOKIE_DOMAIN',
  'AUTH_COOKIE_SAMESITE',
  'AUTH_COOKIE_SECURE',
  'AUTH_DUMMY_PASSWORD_HASH',
  'AUTH_ME_TENANT_THROTTLE_HOUR_LIMIT',
  'AUTH_ME_TENANT_THROTTLE_LIMIT',
  'AUTH_ME_THROTTLE_LIMIT',
  'AUTH_ME_THROTTLE_TTL',
  'AUTH_PRINCIPAL_BRIDGE_CACHE_TTL_SECONDS',
  'AUTH_PROFILE_NAME_CACHE_TTL_SECONDS',
  'AUTH_SESSION_USER_CACHE_TTL_SECONDS',
  'AWS_ACCESS_KEY_ID',
  'AWS_BUCKET_NAME',
  'AWS_ENDPOINT',
  'AWS_REGION',
  'AWS_S3_BUCKET',
  'AWS_S3_ENDPOINT',
  'AWS_SECRET_ACCESS_KEY',
  'BACKEND_PUBLIC_URL',
  'BACKUP_SECRET_KEY',
  'BANCO_DE_DADOS_SSL',
  'BASE_URL',
  'BULL_BOARD_PASS',
  'BULL_BOARD_USER',
  'CACHE_WARMING_ENABLED',
  'CALL_AUTH_ME',
  'CHANGE_PASSWORD_THROTTLE_LIMIT',
  'CHANGE_PASSWORD_THROTTLE_TTL',
  'CLAMAV_HOST',
  'CLAMAV_PORT',
  'CLAMAV_TIMEOUT_MS',
  'CLEANUP_TEST_DATA',
  'CLIENT_FINGERPRINT_MODE',
  'CORS_ALLOW_PRIVATE_NETWORK_DEV',
  'CORS_ALLOWED_ORIGINS',
  'CSRF_THROTTLE_LIMIT',
  'CSRF_THROTTLE_TTL',
  'CSRF_TOKEN_SECRET',
  'CSRF_TOKEN_TTL_SECONDS',
  'DASHBOARD_CACHE_ENABLED',
  'DASHBOARD_CACHE_TTL_ACTIVITIES',
  'DASHBOARD_CACHE_TTL_METRICS',
  'DASHBOARD_DOCUMENT_AVAILABILITY_SCHEDULER_ENABLED',
  'DASHBOARD_DOCUMENT_AVAILABILITY_WARMUP_COMPANY_LIMIT',
  'DASHBOARD_DOCUMENT_AVAILABILITY_WARMUP_CONCURRENCY',
  'DASHBOARD_DOCUMENT_AVAILABILITY_WARMUP_DELAY_MS',
  'DASHBOARD_DOCUMENT_AVAILABILITY_WARMUP_ENABLED',
  'DASHBOARD_DOCUMENT_PENDENCIES_CACHE_TTL_SECONDS',
  'DASHBOARD_INVALIDATE_TENANT_THROTTLE_HOUR_LIMIT',
  'DASHBOARD_INVALIDATE_TENANT_THROTTLE_LIMIT',
  'DASHBOARD_INVALIDATE_USER_THROTTLE_LIMIT',
  'DASHBOARD_KPIS_TENANT_THROTTLE_HOUR_LIMIT',
  'DASHBOARD_KPIS_TENANT_THROTTLE_LIMIT',
  'DASHBOARD_KPIS_USER_THROTTLE_LIMIT',
  'DASHBOARD_STORAGE_AVAILABILITY_CACHE_TTL_SECONDS',
  'DASHBOARD_SUMMARY_TENANT_THROTTLE_HOUR_LIMIT',
  'DASHBOARD_SUMMARY_TENANT_THROTTLE_LIMIT',
  'DASHBOARD_SUMMARY_USER_THROTTLE_LIMIT',
  'DATABASE_ADMIN_POOL_MAX',
  'DATABASE_ADMIN_URL',
  'DATABASE_DIRECT_URL',
  'DATABASE_HOST',
  'DATABASE_MIGRATION_URL',
  'DATABASE_NAME',
  'DATABASE_PASSWORD',
  'DATABASE_POOLER_ALLOW_SESSION_RLS',
  'DATABASE_PORT',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'DATABASE_REPLICA_URL',
  'DATABASE_SSL',
  'DATABASE_SSL_ALLOW_INSECURE',
  'DATABASE_SSL_ALLOW_INSECURE_FORCE',
  'DATABASE_SSL_CA',
  'DATABASE_TYPE',
  'DATABASE_URL',
  'DATABASE_USER',
  'DB_APPLICATION_NAME',
  'DB_APPLICATION_NAME_WEB',
  'DB_APPLICATION_NAME_WORKER',
  'DB_CONNECTION_TIMEOUT_MS',
  'DB_IDLE_TIMEOUT_MS',
  'DB_POOL_MAX',
  'DB_POOL_MIN',
  'DB_PREPARE_THRESHOLD',
  'DB_RLS_CONTEXT_BOOTSTRAP_TIMEOUT_MS',
  'DB_STATEMENT_TIMEOUT_MS',
  'DB_SYNC',
  'DB_TIMINGS_ENABLED',
  'DDS_ALERTS_BLOCKED_THRESHOLD',
  'DDS_ALERTS_DEDUPE_MINUTES',
  'DDS_ALERTS_ENABLED',
  'DDS_ALERTS_PENDING_APPROVAL_THRESHOLD',
  'DDS_ALERTS_PENDING_GOVERNANCE_THRESHOLD',
  'DDS_ALERTS_SUSPICIOUS_THRESHOLD',
  'DDS_APPROVAL_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_APPROVAL_TENANT_THROTTLE_LIMIT',
  'DDS_BATCH_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_BATCH_TENANT_THROTTLE_LIMIT',
  'DDS_COMPLIANCE_WEBHOOK_URL',
  'DDS_CREATE_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_CREATE_TENANT_THROTTLE_LIMIT',
  'DDS_EXPORT_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_EXPORT_TENANT_THROTTLE_LIMIT',
  'DDS_HISTORICAL_PHOTO_HASH_LIMIT',
  'DDS_PDF_SIGNED_URL_EXPIRY_SECONDS',
  'DDS_SIGNATURES_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_SIGNATURES_TENANT_THROTTLE_LIMIT',
  'DDS_STATUS_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_STATUS_TENANT_THROTTLE_LIMIT',
  'DDS_UPLOAD_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_UPLOAD_TENANT_THROTTLE_LIMIT',
  'DDS_VIDEO_UPLOAD_TENANT_THROTTLE_HOUR_LIMIT',
  'DDS_VIDEO_UPLOAD_TENANT_THROTTLE_LIMIT',
  'DEV_ADMIN_CPF',
  'DEV_ADMIN_PASSWORD',
  'DEV_LOGIN_BYPASS',
  'DIAG_MEMORY',
  'DID_CREATE_TENANT_THROTTLE_HOUR_LIMIT',
  'DID_CREATE_TENANT_THROTTLE_LIMIT',
  'DID_PDF_SIGNED_URL_EXPIRY_SECONDS',
  'DID_STATUS_TENANT_THROTTLE_HOUR_LIMIT',
  'DID_STATUS_TENANT_THROTTLE_LIMIT',
  'DID_UPDATE_TENANT_THROTTLE_HOUR_LIMIT',
  'DID_UPDATE_TENANT_THROTTLE_LIMIT',
  'DID_UPLOAD_TENANT_THROTTLE_HOUR_LIMIT',
  'DID_UPLOAD_TENANT_THROTTLE_LIMIT',
  'DISABLE_AUTO_CONSENT_SEED',
  'DISABLE_EXTERNAL_NOTIFICATIONS',
  'DISABLE_LOGIN_THROTTLE_IN_DEV',
  'DLQ_MAX_WAITING',
  'DOCUMENT_DOWNLOAD_TOKEN_SECRET',
  'DOCUMENT_IMPORT_EXTRACTED_TEXT_MAX_BYTES',
  'DOCUMENT_IMPORT_OFFICE_MAX_UNCOMPRESSED_BYTES',
  'DOCUMENT_IMPORT_QUEUE_ATTEMPTS',
  'DOCUMENT_IMPORT_QUEUE_CONCURRENCY',
  'DOCUMENT_IMPORT_QUEUE_TIMEOUT_MS',
  'DR_ALLOW_PRODUCTION_RESTORE',
  'DR_BACKUP_RETENTION_DAYS',
  'DR_BACKUP_ROOT',
  'DR_BACKUP_SCHEMAS',
  'DR_ENVIRONMENT_NAME',
  'DR_RESTORE_CONFIRMATION_TOKEN',
  'DR_STORAGE_BACKUP_PREFIX',
  'DR_STORAGE_REPLICA_ACCESS_KEY_ID',
  'DR_STORAGE_REPLICA_BUCKET',
  'DR_STORAGE_REPLICA_ENDPOINT',
  'DR_STORAGE_REPLICA_FORCE_PATH_STYLE',
  'DR_STORAGE_REPLICA_REGION',
  'DR_STORAGE_REPLICA_SECRET_ACCESS_KEY',
  'DR_TARGET_DATABASE_URL',
  'DR_TARGET_ENVIRONMENT',
  'ENABLE_ENTERPRISE_FTS_MIGRATIONS',
  'ENABLE_ENTERPRISE_SCHEMA_SEPARATION',
  'EXPECT_REFRESH_COOKIES',
  'FEATURE_AI_ENABLED',
  'FIELD_ENCRYPTION_ENABLED',
  'FIELD_ENCRYPTION_HASH_KEY',
  'FIELD_ENCRYPTION_KEY',
  'FORBIDDEN_SPIKE_BLOCK_SECONDS',
  'FORBIDDEN_SPIKE_THRESHOLD',
  'FORBIDDEN_SPIKE_WINDOW_SECONDS',
  'FORCE_PASSWORD_CHANGE_TOKEN_TTL_SECONDS',
  'FORGOT_PASSWORD_JITTER_MS',
  'FORGOT_PASSWORD_MIN_PROCESSING_MS',
  'FORGOT_PASSWORD_RATE_LIMIT_CPF_ATTEMPTS',
  'FORGOT_PASSWORD_RATE_LIMIT_IP_ATTEMPTS',
  'FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS',
  'FORGOT_PASSWORD_THROTTLE_LIMIT',
  'FORGOT_PASSWORD_THROTTLE_TTL',
  'FRONTEND_URL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GOOGLE_API_KEY',
  'HIBP_CHECK_ENABLED',
  'HIBP_TIMEOUT_MS',
  'HOME',
  'HTTP_LOG_REQUEST_BODY',
  'IDEMPOTENCY_DURABLE_RETENTION_SECONDS',
  'IDEMPOTENCY_MAX_KEYS_PER_SCOPE',
  'IDEMPOTENCY_MAX_RESPONSE_BYTES',
  'IDEMPOTENCY_TTL_SECONDS',
  'INSPECTION_INLINE_EVIDENCE_MAX_BYTES',
  'INTEGRATION_CB_FAILURE_THRESHOLD',
  'INTEGRATION_CB_RESET_TIMEOUT_MS',
  'INTEGRATION_CB_SUCCESS_THRESHOLD',
  'INTEGRATION_RETRY_ATTEMPTS',
  'INTEGRATION_RETRY_BASE_DELAY_MS',
  'INTEGRATION_RETRY_JITTER_RATIO',
  'INTEGRATION_RETRY_MAX_DELAY_MS',
  'INTEGRATION_TIMEOUT_MS',
  'JAEGER_AGENT_HOST',
  'JAEGER_AGENT_PORT',
  'JAEGER_ENDPOINT',
  'JEST_WORKER_ID',
  'JWT_AUDIENCE',
  'JWT_EXPIRES_IN',
  'JWT_ISSUER',
  'JWT_REFRESH_EXPIRATION',
  'JWT_REFRESH_SECRET',
  'JWT_SECRET',
  'K6_COMPANY_ID',
  'K6_LOGIN_CPF',
  'K6_LOGIN_PASSWORD',
  'LANG',
  'LEGACY_CPF_PLAINTEXT_LOOKUP_ENABLED',
  'LEGAL_AI_CONSENT_VERSION',
  'LEGAL_POLICY_VERSION',
  'LEGAL_TERMS_VERSION',
  'LOADTEST_ADMIN_CPF',
  'LOADTEST_ADMIN_PASSWORD',
  'LOADTEST_API_URL',
  'LOADTEST_COMPANY_ID',
  'LOADTEST_SITE_ID',
  'LOADTEST_USER_ID',
  'LOCAL_DOCUMENT_STORAGE_DIR',
  'LOG_LEVEL',
  'LOGIN_COMPANY_ID',
  'LOGIN_CPF',
  'LOGIN_FAIL_ACCOUNT_BLOCK_SECONDS',
  'LOGIN_FAIL_ACCOUNT_MAX',
  'LOGIN_FAIL_BLOCK_SECONDS',
  'LOGIN_FAIL_MAX',
  'LOGIN_FAIL_WINDOW_SECONDS',
  'LOGIN_PASSWORD',
  'LOGIN_THROTTLE_LIMIT',
  'LOGIN_THROTTLE_TTL',
  'LOGIN_USERS_FILE',
  'MAIL_ALERT_COMPANY_BATCH_SIZE',
  'MAIL_ALERT_COMPANY_MAX_PARALLEL',
  'MAIL_ALERT_SCHEDULE_LOCK_TTL_MS',
  'MAIL_ALERT_SCHEDULE_MIN_INTERVAL_MS',
  'MAIL_ENABLED',
  'MAIL_FROM_EMAIL',
  'MAIL_FROM_NAME',
  'MAIL_HOST',
  'MAIL_PASS',
  'MAIL_PORT',
  'MAIL_REPLY_TO_EMAIL',
  'MAIL_REPLY_TO_NAME',
  'MAIL_REQUEST_TIMEOUT_MS',
  'MAIL_SECURE',
  'MAIL_USER',
  'MAX_ACTIVE_SESSIONS_PER_USER',
  'MAX_TEST_DOCUMENTS',
  'MFA_BOOTSTRAP_TTL_SECONDS',
  'MFA_ENABLED',
  'MFA_ISSUER',
  'MFA_JWT_SECRET',
  'MFA_LOGIN_CHALLENGE_TTL_SECONDS',
  'MFA_MAX_CHALLENGE_ATTEMPTS',
  'MFA_STEP_UP_TTL_SECONDS',
  'MFA_TOTP_ENCRYPTION_KEY',
  'MIGRATION_ADVISORY_LOCK_ID',
  'MIGRATION_ADVISORY_LOCK_INPUT',
  'MIGRATION_ADVISORY_LOCK_TIMEOUT_MS',
  'MIGRATION_DEFERRED_IDS',
  'N1_QUERY_BLOCKING_ENABLED',
  'N1_QUERY_DETECTION_ENABLED',
  'N1_QUERY_THRESHOLD',
  'N1_SLOW_QUERY_THRESHOLD',
  'NEW_RELIC_ENABLED',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_LEGAL_AI_CONSENT_VERSION',
  'NEXT_PUBLIC_LEGAL_POLICY_VERSION',
  'NEXT_PUBLIC_LEGAL_TERMS_VERSION',
  'NODE_ENV',
  'NVIDIA_API_BASE_URL',
  'NVIDIA_API_KEY',
  'NVIDIA_FALLBACK_MODEL',
  'NVIDIA_MODEL',
  'NVIDIA_REASONING_EFFORT',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_FALLBACK_MODEL',
  'OPENAI_MODEL',
  'OPENAI_REASONING_EFFORT',
  'OPENAI_VISION_MODEL',
  'OTEL_ENABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'OTEL_SERVICE_VERSION',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
  'PAGINATION_LIMIT_MAX',
  'PAGINATION_PAGE_MAX',
  'PASSWORD_ARGON2_MEMORY_COST_KIB',
  'PASSWORD_ARGON2_PARALLELISM',
  'PASSWORD_ARGON2_TIME_COST',
  'PASSWORD_HASH_MAX_CONCURRENCY',
  'PASSWORD_HASH_WRITE_MAX_CONCURRENCY',
  'PASSWORD_MIN_LENGTH',
  'PASSWORD_VERIFY_MAX_CONCURRENCY',
  'PDF_BROWSER_ACQUIRE_TIMEOUT_MS',
  'PDF_BROWSER_MAX_USES',
  'PDF_BROWSER_POOL_SIZE',
  'PDF_GENERATION_CONCURRENCY',
  'PDF_GENERATION_RSS_WARN_MB',
  'PDF_PAGE_TIMEOUT_MS',
  'PDF_QUEUE_JOB_TIMEOUT_MS',
  'PDF_REQUEST_TIMEOUT_MS',
  'PERF_PROFILING_ENABLED',
  'PERF_PROFILING_SAMPLE_RATE',
  'PG_IDLE_IN_TX_TIMEOUT_MS',
  'PG_LOCK_TIMEOUT_MS',
  'PG_STATEMENT_TIMEOUT_MS',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGUSER',
  'PORT',
  'POSTGRES_DB',
  'POSTGRES_HOST',
  'POSTGRES_MIGRATOR_PASSWORD',
  'POSTGRES_MIGRATOR_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_PORT',
  'POSTGRES_URL',
  'POSTGRES_USER',
  'POSTGRESQL_URL',
  'PREVIEW_OUT_DIR',
  'PREVIEW_PHOTO',
  'PREVIEW_SHOT_DIR',
  'PROD_SMOKE_API_BASE_URL',
  'PROD_SMOKE_COMPANY_CNPJ',
  'PROD_SMOKE_COMPANY_NAME',
  'PROD_SMOKE_CPF',
  'PROD_SMOKE_PASSWORD',
  'PROD_SMOKE_PROFILE_NAME',
  'PROD_SMOKE_USER_CPF',
  'PROD_SMOKE_USER_EMAIL',
  'PROD_SMOKE_USER_NAME',
  'PRODUCTION_SAFE_TEST_MODE',
  'PROMETHEUS_PORT',
  'PUBLIC_DDS_SIGNATURE_THROTTLE_LIMIT',
  'PUBLIC_DDS_SIGNATURE_THROTTLE_TTL',
  'PUBLIC_VALIDATION_BLOCK_SUSPICIOUS_UA',
  'PUBLIC_VALIDATION_KILL_SWITCH',
  'PUBLIC_VALIDATION_LEGACY_COMPAT',
  'PUBLIC_VALIDATION_LOG_CONTRACT_USAGE',
  'PUBLIC_VALIDATION_THROTTLE_LIMIT',
  'PUBLIC_VALIDATION_THROTTLE_TTL_MS',
  'PUBLIC_VALIDATION_TOKEN_TTL_SECONDS',
  'PUPPETEER_CACHE_DIR',
  'PUPPETEER_EXECUTABLE_PATH',
  'PUSH_SUBSCRIPTION_DELETE_THROTTLE_LIMIT',
  'PUSH_SUBSCRIPTION_DELETE_THROTTLE_TTL',
  'RBAC_ACCESS_CACHE_TTL_SECONDS',
  'RBAC_ACCESS_DEBUG',
  'RBAC_ACCESS_LOCAL_CACHE_TTL_SECONDS',
  'RBAC_WARMUP_DELAY_MS',
  'RBAC_WARMUP_ENABLED',
  'RBAC_WARMUP_USER_LIMIT',
  'RECOVER_NULL_PASSWORD_NO_EXIT',
  'REDIS_ALLOW_IN_MEMORY_FALLBACK_IN_PROD',
  'REDIS_ALLOW_INSECURE_INTERNAL',
  'REDIS_AUTH_HOST',
  'REDIS_AUTH_PASSWORD',
  'REDIS_AUTH_PORT',
  'REDIS_AUTH_TLS',
  'REDIS_AUTH_TLS_ALLOW_INSECURE',
  'REDIS_AUTH_URL',
  'REDIS_AUTH_USERNAME',
  'REDIS_CACHE_HOST',
  'REDIS_CACHE_PASSWORD',
  'REDIS_CACHE_PORT',
  'REDIS_CACHE_TLS',
  'REDIS_CACHE_TLS_ALLOW_INSECURE',
  'REDIS_CACHE_URL',
  'REDIS_CACHE_USERNAME',
  'REDIS_CONNECTION_CACHE_KEY_SECRET',
  'REDIS_DISABLED',
  'REDIS_FAIL_OPEN',
  'REDIS_HOST',
  'REDIS_PASSWORD',
  'REDIS_PORT',
  'REDIS_PUBLIC_URL',
  'REDIS_QUEUE_HOST',
  'REDIS_QUEUE_PASSWORD',
  'REDIS_QUEUE_PORT',
  'REDIS_QUEUE_TLS',
  'REDIS_QUEUE_TLS_ALLOW_INSECURE',
  'REDIS_QUEUE_URL',
  'REDIS_QUEUE_USERNAME',
  'REDIS_RATE_LIMIT_HOST',
  'REDIS_RATE_LIMIT_PASSWORD',
  'REDIS_RATE_LIMIT_PORT',
  'REDIS_RATE_LIMIT_TLS',
  'REDIS_RATE_LIMIT_TLS_ALLOW_INSECURE',
  'REDIS_RATE_LIMIT_URL',
  'REDIS_RATE_LIMIT_USERNAME',
  'REDIS_TLS',
  'REDIS_URL',
  'REFRESH_BINDING',
  'REFRESH_CSRF_ENFORCED',
  'REFRESH_CSRF_REPORT_ONLY',
  'REFRESH_THROTTLE_LIMIT',
  'REFRESH_THROTTLE_TTL',
  'REFRESH_TOKEN_COOKIE_DOMAIN',
  'REFRESH_TOKEN_COOKIE_SAMESITE',
  'REFRESH_TOKEN_COOKIE_SECURE',
  'REFRESH_TOKEN_TTL',
  'REFRESH_TOKEN_TTL_DAYS',
  'REPORTS_QUEUE_SCAN_MAX_PER_STATE',
  'REQUEST_TIMEOUT_MS',
  'REQUIRE_EXPLICIT_TENANT_FOR_SUPER_ADMIN',
  'REQUIRE_NO_PENDING_MIGRATIONS',
  'RESEND_API_KEY',
  'RESET_TOKEN_CONSUMED_TTL_SECONDS',
  'RESET_TOKEN_RATE_LIMIT_ATTEMPTS',
  'RESET_TOKEN_RATE_LIMIT_WINDOW_SECONDS',
  'S3_CONNECTION_TIMEOUT_MS',
  'S3_FORCE_PATH_STYLE',
  'S3_MAX_ATTEMPTS',
  'S3_SOCKET_TIMEOUT_MS',
  'SECURITY_AUDIT_HMAC_KEY',
  'SECURITY_HARDENING_PHASE',
  'SEED_ON_BOOTSTRAP',
  'SEND_COMPANY_HEADER',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'SENTRY_RELEASE',
  'SENTRY_SMOKE_MARKER',
  'SENTRY_TRACES_SAMPLE_RATE',
  'SGS_TEMP_DIR',
  'SIGNATURE_VERIFY_THROTTLE_LIMIT',
  'SIGNATURE_VERIFY_THROTTLE_TTL',
  'SMOKE_MAIL_RECIPIENT',
  'SQLITE_DB_PATH',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_BUCKET',
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_SECRET_ACCESS_KEY',
  'SWAGGER_PASS',
  'SWAGGER_USER',
  'TENANT_RATE_LIMIT_DEFAULT_PLAN',
  'TENANT_VALIDATION_WARMUP_DELAY_MS',
  'TENANT_VALIDATION_WARMUP_ENABLED',
  'TEST_COMPANY_ID',
  'TEST_COMPANY_NAME',
  'TEST_DOCUMENT_PREFIX',
  'THROTTLE_LIMIT',
  'THROTTLE_TTL',
  'THROTTLER_API_LIMIT',
  'THROTTLER_AUTH_FALLBACK_LOG_COOLDOWN_MS',
  'THROTTLER_AUTH_LIMIT',
  'THROTTLER_AUTH_LOCAL_FALLBACK_ENABLED',
  'THROTTLER_AUTH_LOCAL_FALLBACK_LIMIT',
  'THROTTLER_AUTH_LOCAL_FALLBACK_TTL_MS',
  'THROTTLER_AUTH_ME_LOCAL_FALLBACK_LIMIT',
  'THROTTLER_AUTH_ME_LOCAL_FALLBACK_TTL_MS',
  'THROTTLER_DASHBOARD_LIMIT',
  'THROTTLER_DECISION_TIMEOUT_MS',
  'THROTTLER_ENABLED',
  'THROTTLER_FAIL_CLOSED',
  'THROTTLER_FAIL_CLOSED_AUTH_ROUTES',
  'THROTTLER_PUBLIC_LIMIT',
  'THROTTLER_PUBLIC_LOCAL_FALLBACK_ENABLED',
  'THROTTLER_PUBLIC_LOCAL_FALLBACK_LIMIT',
  'THROTTLER_PUBLIC_LOCAL_FALLBACK_TTL_MS',
  'THROTTLER_STORAGE_FAIL_OPEN',
  'THROTTLER_STORAGE_REDIS_TIMEOUT_MS',
  'THROTTLER_WINDOW_MS',
  'TURNSTILE_ENABLED',
  'TURNSTILE_SECRET_KEY',
  'TURNSTILE_VERIFY_TIMEOUT_MS',
  'TZ',
  'URL_DO_BANCO_DE_DADOS',
  'URL_REDIS',
  'UV_THREADPOOL_SIZE',
  'VALIDATION_TOKEN_SECRET',
  'VAPID_MAILTO',
  'VAPID_PRIVATE_KEY',
  'VAPID_PUBLIC_KEY',
  'WORKER_HEARTBEAT_ENABLED',
  'WORKER_HEARTBEAT_KEY',
  'WORKER_HEARTBEAT_REQUIRED',
  'WORKER_HEARTBEAT_TTL_SECONDS',
  'WORKER_TENANT_QUOTA_DELAY_MS',
  'WORKER_TENANT_QUOTA_JITTER_MS',
  'WORKER_TENANT_QUOTA_MAIL_DELAY_MS',
  'WORKER_TENANT_QUOTA_MAIL_JITTER_MS',
  'WORKER_TENANT_QUOTA_MAIL_MAX_ACTIVE',
  'WORKER_TENANT_QUOTA_MAIL_TTL_SECONDS',
  'WORKER_TENANT_QUOTA_PDF_DELAY_MS',
  'WORKER_TENANT_QUOTA_PDF_JITTER_MS',
  'WORKER_TENANT_QUOTA_PDF_MAX_ACTIVE',
  'WORKER_TENANT_QUOTA_PDF_TTL_SECONDS',
  'WORKER_TENANT_QUOTA_TTL_SECONDS',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
]);

const SAFE_SYSTEM_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'HOSTNAME',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'TERM',
  'TZ',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_VERSION',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_user_agent',
  'npm_config_noproxy',
  'npm_config_node_gyp',
  'npm_config_globalconfig',
  'npm_config_init_module',
  'npm_config_local_prefix',
  'npm_config_metrics_registry',
  'npm_config_node_gyp',
  'npm_config_prefix',
  'npm_config_cache',
  'npm_execpath',
  'npm_node_execpath',
  'npm_lifecycle_event',
  'npm_lifecycle_script',
  'npm_package_json',
  'npm_package_name',
  'npm_package_version',
  'npm_command',
  'CI',
  'CONTINUOUS_INTEGRATION',
  'DEBIAN_FRONTEND',
  'FORCE_COLOR',
  'NO_COLOR',
  'SHLVL',
  'DISPLAY',
  'COMSPEC',
  'ComSpec',
  'SystemRoot',
  'WINDIR',
  'OS',
  'PATHEXT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'HOMESHARE',
  'VSCODE_INJECTION',
  // Variáveis injetadas pelo launcher/ambiente de execução, não consumidas
  // pelo SGS. São permitidas por nome exato; typos continuam bloqueados.
  'OPENAI_API_BASE',
  'REFRESH_ENV_VARS',
  'PUPPETEER_SKIP_DOWNLOAD',
]);

const SGS_NAMESPACE_PREFIXES = [
  'ACCESS_',
  'ADMIN_',
  'AI_',
  'ALERTS_',
  'ALLOW_',
  'ANTHROPIC_',
  'ANTIVIRUS_',
  'API_',
  'APP_',
  'APR_',
  'ARR_',
  'AUDIT_',
  'AUTH_',
  'AWS_',
  'BACKEND_',
  'BACKUP_',
  'BASE_',
  'BULL_',
  'CACHE_',
  'CHANGE_',
  'CLAMAV_',
  'CORS_',
  'CSRF_',
  'DASHBOARD_',
  'DATABASE_',
  'DB_',
  'DDS_',
  'DEV_',
  'DID_',
  'DISABLE_',
  'DLQ_',
  'DOCUMENT_',
  'DR_',
  'ENABLE_',
  'EXPECT_',
  'FEATURE_',
  'FIELD_',
  'FORBIDDEN_',
  'FORCE_',
  'FORGOT_',
  'FRONTEND_',
  'GEMINI_',
  'HIBP_',
  'HTTP_',
  'IDEMPOTENCY_',
  'INSPECTION_',
  'INTEGRATION_',
  'JAEGER_',
  'JWT_',
  'K6_',
  'LEGAL_',
  'LEGACY_',
  'LOADTEST_',
  'LOCAL_',
  'LOGIN_',
  'MAIL_',
  'MAX_',
  'MFA_',
  'MIGRATION_',
  'N1_',
  'NEW_RELIC_',
  'NEXT_PUBLIC_',
  'NVIDIA_',
  'OPENAI_',
  'OTEL_',
  'PAGINATION_',
  'PASSWORD_',
  'PDF_',
  'PERF_',
  'PG',
  'POSTGRES',
  'PREVIEW_',
  'PROD_',
  'PRODUCTION_',
  'PROMETHEUS_',
  'PUBLIC_',
  'PUPPETEER_',
  'PUSH_',
  'RBAC_',
  'RECOVER_',
  'REDIS_',
  'REFRESH_',
  'REPORTS_',
  'REQUEST_',
  'RESET_',
  'S3_',
  'SECURITY_',
  'SEED_',
  'SENTRY_',
  'SGS_',
  'SIGNATURE_',
  'SMOKE_',
  'SQLITE_',
  'STORAGE_',
  'SWAGGER_',
  'TENANT_',
  'TEST_',
  'THROTTLE',
  'TURNSTILE_',
  'URL_',
  'VALIDATION_',
  'VAPID_',
  'WORKER_',
  'XDG_',
];

function isSafeSystemKey(key: string): boolean {
  return (
    SAFE_SYSTEM_ENV_KEYS.has(key) ||
    key.startsWith('npm_') ||
    key.startsWith('NPM_CONFIG_') ||
    key.startsWith('LC_')
  );
}

function isSgsNamespaceKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SGS_NAMESPACE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function findUnknownSgsEnvironmentKeys(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  knownKeys: Iterable<string> = KNOWN_SGS_ENV_KEYS,
): string[] {
  const known = new Set(knownKeys);
  return Object.keys(env)
    .filter((key) => env[key] !== undefined)
    .filter((key) => !isSafeSystemKey(key))
    .filter((key) => !known.has(key))
    .filter(isSgsNamespaceKey)
    .sort();
}

export function assertNoUnknownSgsEnvironmentKeys(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  knownKeys?: Iterable<string>,
): void {
  const unknownKeys = findUnknownSgsEnvironmentKeys(env, knownKeys);
  if (unknownKeys.length > 0) {
    throw new EnvironmentContractError(
      `Unknown SGS environment variable(s): ${unknownKeys.join(', ')}`,
    );
  }
}

function readString(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  key: string,
): string {
  const value = env[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

export function parseStrictBoolean(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  key: string,
  fallback?: boolean,
): boolean {
  const raw = readString(env, key).toLowerCase();
  if (raw === '') {
    if (fallback !== undefined) return fallback;
    throw new EnvironmentContractError(`${key}: REQUIRED_BOOLEAN`);
  }
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  throw new EnvironmentContractError(`${key}: INVALID_BOOLEAN`);
}

export function parseStrictPositiveInteger(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; required?: boolean } = {},
): number | undefined {
  const raw = readString(env, key);
  if (raw === '') {
    if (options.required)
      throw new EnvironmentContractError(`${key}: REQUIRED_NUMBER`);
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new EnvironmentContractError(`${key}: INVALID_NUMBER`);
  }
  const value = Number(raw);
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new EnvironmentContractError(`${key}: OUT_OF_RANGE`);
  }
  return value;
}

export function assertUrl(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  key: string,
  options: {
    schemes: string[];
    required?: boolean;
    allowEmpty?: boolean;
    allowCredentials?: boolean;
  },
): void {
  const raw = readString(env, key);
  if (raw === '') {
    if (options.required && !options.allowEmpty) {
      throw new EnvironmentContractError(`${key}: REQUIRED_URL`);
    }
    return;
  }
  if (/\\s/.test(raw)) {
    throw new EnvironmentContractError(`${key}: INVALID_URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EnvironmentContractError(`${key}: INVALID_URL`);
  }
  if (
    !options.schemes.includes(parsed.protocol.replace(':', '').toLowerCase()) ||
    !parsed.hostname
  ) {
    throw new EnvironmentContractError(`${key}: INVALID_URL`);
  }
  if (!options.allowCredentials && (parsed.username || parsed.password)) {
    throw new EnvironmentContractError(`${key}: URL_CREDENTIALS_NOT_ALLOWED`);
  }
}

function isPlaceholder(value: string): boolean {
  return /(?:changeme|change[-_ ]?me|your[-_ ]?(?:key|secret|password)|test[-_ ]?secret|default[-_ ]?(?:key|secret|password)|password|secret|example\.invalid|replace[-_ ]?me|<[^>]+>)/i.test(
    value,
  );
}

export function assertSecret(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  key: string,
  options: {
    required?: boolean;
    minLength?: number;
    allowPlaceholder?: boolean;
  } = {},
): void {
  const raw = readString(env, key);
  if (!raw) {
    if (options.required)
      throw new EnvironmentContractError(`${key}: REQUIRED`);
    return;
  }
  if (!options.allowPlaceholder && isPlaceholder(raw)) {
    throw new EnvironmentContractError(`${key}: PLACEHOLDER`);
  }
  if (options.minLength && raw.length < options.minLength) {
    throw new EnvironmentContractError(`${key}: INVALID_LENGTH`);
  }
}

function isNonLocalEnvironment(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
): boolean {
  const value = readString(env, 'NODE_ENV').toLowerCase();
  return value !== '' && value !== 'development' && value !== 'test';
}

export function validateCommonEnvironment(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  options: EnvironmentContractOptions,
): void {
  const knownKeys = options.knownKeys ?? KNOWN_SGS_ENV_KEYS;
  assertNoUnknownSgsEnvironmentKeys(env, knownKeys);

  const nodeEnv = readString(env, 'NODE_ENV').toLowerCase() || 'development';
  if (!['development', 'test', 'staging', 'production'].includes(nodeEnv)) {
    throw new EnvironmentContractError('NODE_ENV: INVALID_VALUE');
  }

  parseStrictPositiveInteger(env, 'PORT', { min: 1, max: 65535 });
  parseStrictBoolean(env, 'REDIS_DISABLED', false);

  if (options.requireDatabase !== false) {
    const hasUrl = [
      'DATABASE_URL',
      'DATABASE_PRIVATE_URL',
      'DATABASE_PUBLIC_URL',
      'DATABASE_MIGRATION_URL',
      'DATABASE_DIRECT_URL',
      'URL_DO_BANCO_DE_DADOS',
      'POSTGRES_URL',
      'POSTGRESQL_URL',
    ].some((key) => readString(env, key) !== '');
    const hasParts = [
      'DATABASE_HOST',
      'PGHOST',
      'POSTGRES_HOST',
      'DATABASE_USER',
      'PGUSER',
      'POSTGRES_USER',
      'DATABASE_PASSWORD',
      'PGPASSWORD',
      'POSTGRES_PASSWORD',
      'DATABASE_NAME',
      'PGDATABASE',
      'POSTGRES_DB',
    ].every((key) => readString(env, key) !== '');
    const databaseType =
      readString(env, 'DATABASE_TYPE').toLowerCase() || 'postgres';
    if (
      databaseType !== 'sqlite' &&
      databaseType !== 'better-sqlite3' &&
      !hasUrl &&
      !hasParts
    ) {
      throw new EnvironmentContractError(
        'DATABASE_URL or database host credentials: REQUIRED',
      );
    }
  }

  for (const key of [
    'DATABASE_PORT',
    'PGPORT',
    'POSTGRES_PORT',
    'REDIS_PORT',
    'REDIS_AUTH_PORT',
    'REDIS_CACHE_PORT',
    'REDIS_QUEUE_PORT',
    'REDIS_RATE_LIMIT_PORT',
    'MAIL_PORT',
    'PROMETHEUS_PORT',
  ]) {
    parseStrictPositiveInteger(env, key, { min: 1, max: 65535 });
  }

  for (const key of [
    'DATABASE_URL',
    'DATABASE_PRIVATE_URL',
    'DATABASE_PUBLIC_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_DIRECT_URL',
    'URL_DO_BANCO_DE_DADOS',
    'POSTGRES_URL',
    'POSTGRESQL_URL',
  ]) {
    assertUrl(env, key, {
      schemes: ['postgres', 'postgresql'],
      allowCredentials: true,
    });
  }
  for (const key of [
    'REDIS_URL',
    'REDIS_AUTH_URL',
    'REDIS_CACHE_URL',
    'REDIS_QUEUE_URL',
    'REDIS_RATE_LIMIT_URL',
    'URL_REDIS',
    'REDIS_PUBLIC_URL',
  ]) {
    assertUrl(env, key, {
      schemes: ['redis', 'rediss'],
      allowCredentials: true,
    });
  }
  for (const key of [
    'API_PUBLIC_URL',
    'FRONTEND_URL',
    'CORS_ALLOWED_ORIGINS',
  ]) {
    if (key === 'CORS_ALLOWED_ORIGINS') continue;
    assertUrl(env, key, { schemes: ['http', 'https'] });
  }

  const isNonLocal = isNonLocalEnvironment(env);
  if (isNonLocal && options.component === 'api') {
    assertSecret(env, 'JWT_SECRET', { required: true, minLength: 64 });
    assertSecret(env, 'JWT_REFRESH_SECRET', { required: true, minLength: 64 });
    if (
      readString(env, 'JWT_SECRET') === readString(env, 'JWT_REFRESH_SECRET')
    ) {
      throw new EnvironmentContractError(
        'JWT_REFRESH_SECRET: MUST_DIFFER_FROM_JWT_SECRET',
      );
    }
    if (!readString(env, 'JWT_ISSUER'))
      throw new EnvironmentContractError('JWT_ISSUER: REQUIRED');
    if (!readString(env, 'JWT_AUDIENCE'))
      throw new EnvironmentContractError('JWT_AUDIENCE: REQUIRED');
  }

  if (options.requireQueueRedis) {
    const redisDisabled = parseStrictBoolean(env, 'REDIS_DISABLED', false);
    const hasQueueUrl = [
      'REDIS_QUEUE_URL',
      'REDIS_URL',
      'URL_REDIS',
      'REDIS_PUBLIC_URL',
    ].some((key) => readString(env, key) !== '');
    const hasQueueHost = ['REDIS_QUEUE_HOST', 'REDIS_HOST'].some(
      (key) => readString(env, key) !== '',
    );
    if (redisDisabled)
      throw new EnvironmentContractError(
        'REDIS_DISABLED: WORKER_REDIS_REQUIRED',
      );
    if (!hasQueueUrl && !hasQueueHost)
      throw new EnvironmentContractError(
        'REDIS_QUEUE_URL or REDIS_HOST: REQUIRED_FOR_WORKER',
      );
  }

  if (options.validateFeatureIntegrations !== false) {
    const aiFlagRaw = readString(env, 'FEATURE_AI_ENABLED');
    const aiEnabled =
      aiFlagRaw === '' ? true : parseStrictBoolean(env, 'FEATURE_AI_ENABLED');
    const aiProvider = readString(env, 'AI_PROVIDER').toLowerCase() || 'openai';
    if (isNonLocal && aiEnabled && !['stub', 'local'].includes(aiProvider)) {
      const providerKey =
        aiProvider === 'nvidia'
          ? 'NVIDIA_API_KEY'
          : aiProvider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : aiProvider === 'gemini'
              ? 'GEMINI_API_KEY'
              : 'OPENAI_API_KEY';
      assertSecret(env, providerKey, { required: true, minLength: 16 });
    }

    const mailEnabled =
      readString(env, 'MAIL_ENABLED').toLowerCase() !== 'false';
    if (isNonLocal && mailEnabled) {
      const hasResend = readString(env, 'RESEND_API_KEY') !== '';
      const hasSmtp = ['MAIL_HOST', 'MAIL_USER', 'MAIL_PASS'].every(
        (key) => readString(env, key) !== '',
      );
      if (!hasResend && !hasSmtp) {
        throw new EnvironmentContractError(
          'MAIL provider: REQUIRED_WHEN_MAIL_ENABLED',
        );
      }
    }

    const encryptionEnabled =
      readString(env, 'FIELD_ENCRYPTION_ENABLED').toLowerCase() !== 'false';
    if (isNonLocal && encryptionEnabled) {
      assertSecret(env, 'FIELD_ENCRYPTION_KEY', {
        required: true,
        minLength: 32,
      });
      assertSecret(env, 'FIELD_ENCRYPTION_HASH_KEY', {
        required: true,
        minLength: 32,
      });
    }

    if (
      isNonLocal &&
      (options.component === 'api' || options.component === 'worker')
    ) {
      assertSecret(env, 'DOCUMENT_DOWNLOAD_TOKEN_SECRET', {
        required: true,
        minLength: 32,
      });
    }
  }

  if (
    isNonLocal &&
    options.component === 'api' &&
    readString(env, 'REFRESH_CSRF_ENFORCED').toLowerCase() !== 'true'
  ) {
    throw new EnvironmentContractError(
      'REFRESH_CSRF_ENFORCED: MUST_BE_TRUE_NON_LOCAL',
    );
  }

  if (
    options.component === 'worker' &&
    readString(env, 'WORKER_HEARTBEAT_REQUIRED').toLowerCase() === 'true'
  ) {
    parseStrictPositiveInteger(env, 'WORKER_HEARTBEAT_TTL_SECONDS', {
      min: 30,
      max: 3600,
      required: true,
    });
    if (!readString(env, 'WORKER_HEARTBEAT_KEY')) {
      throw new EnvironmentContractError(
        'WORKER_HEARTBEAT_KEY: REQUIRED_WHEN_HEARTBEAT_REQUIRED',
      );
    }
  }
}
