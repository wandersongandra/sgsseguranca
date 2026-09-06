#!/usr/bin/env bash
set -Eeuo pipefail

BASE=/opt/sgs-loadtest
COMPOSE=(sudo -n docker compose --env-file "$BASE/infra/load-test/.env.loadtest" -f "$BASE/infra/load-test/compose.yml")
MINIO=sgs-loadtest-minio-loadtest-1
NETWORK=sgs-loadtest-internal
BUCKET_EXPECTED=sgs-loadtest-dds-test
TLS_DIR=/etc/sgs-loadtest/minio-tls
CA_CERT="$TLS_DIR/ca.crt"
CA_CERT_CONTAINER=/etc/ssl/certs/sgs-loadtest-minio-ca.crt
PROVIDER_CREDENTIAL_SCOPE=loadtest-dedicated-bucket-prefix
PROBE_PATH="${PROBE_PATH:-/tmp/storage-grant-cache-final-gate.cjs}"
RUN_TOKEN="$(date +%s)-$$-${RANDOM}"
TEMP_API="storage-runtime-api-${RUN_TOKEN}"
FAILURE_API="storage-runtime-failure-api-${RUN_TOKEN}"

if [[ ! -f "$PROBE_PATH" ]]; then
  echo 'Private provider probe was not supplied at the exact temporary path.' >&2
  exit 1
fi

read_container_env() {
  local key="$1"
  sudo -n docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$MINIO" \
    | awk -F= -v wanted="$key" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }'
}

MINIO_ADMIN_USER="$(read_container_env MINIO_ROOT_USER)"
MINIO_ADMIN_PASSWORD="$(read_container_env MINIO_ROOT_PASSWORD)"
MINIO_USER="$(read_container_env AWS_ACCESS_KEY_ID)"
MINIO_PASSWORD="$(read_container_env AWS_SECRET_ACCESS_KEY)"
MINIO_BUCKET="$(read_container_env AWS_BUCKET_NAME)"

if [[ -z "$MINIO_USER" || -z "$MINIO_PASSWORD" ]]; then
  echo 'Dedicated MinIO application credentials were not resolved.' >&2
  exit 1
fi
if [[ "$MINIO_USER" == "$MINIO_ADMIN_USER" || "$MINIO_PASSWORD" == "$MINIO_ADMIN_PASSWORD" ]]; then
  echo 'Application credential still matches the MinIO administrative identity.' >&2
  exit 1
fi
if [[ "$MINIO_BUCKET" != "$BUCKET_EXPECTED" ]]; then
  echo 'Existing MinIO bucket does not match the exact authorized loadtest bucket.' >&2
  exit 1
fi
if [[ "$(sudo -n docker inspect -f '{{.Config.Image}}' "$MINIO")" != 'minio/minio:latest' ]]; then
  echo 'Existing provider image does not match the authorized loadtest target.' >&2
  exit 1
fi
if ! sudo -n docker inspect -f '{{json .NetworkSettings.Networks}}' "$MINIO" | grep -q "\"$NETWORK\""; then
  echo 'Existing provider is not attached to the authorized loadtest network.' >&2
  exit 1
fi
if [[ "$(sudo -n docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' sgs-loadtest-api-loadtest-1 | awk -F= '$1 == "APP_ENV" {print $2; exit}')" != 'loadtest' ]]; then
  echo 'Permanent API does not carry the expected loadtest environment marker.' >&2
  exit 1
fi
if [[ "$(sudo -n docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' sgs-loadtest-api-loadtest-1 | awk -F= '$1 == "APP_LOADTEST_MARKER" {print $2; exit}')" != 'sgs-loadtest' ]]; then
  echo 'Permanent API does not carry the expected loadtest identity marker.' >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$BASE/infra/load-test/.env.loadtest")" != '600' ]]; then
  echo 'Loadtest environment file is not mode 600.' >&2
  exit 1
fi
if ! sudo -n test -s "$CA_CERT" || ! sudo -n test -s "$TLS_DIR/public.crt" || ! sudo -n test -s "$TLS_DIR/private.key"; then
  echo 'Verified MinIO TLS certificate material is missing.' >&2
  exit 1
fi
if [[ "$(sudo -n stat -c '%a' "$TLS_DIR/private.key")" != '600' ]]; then
  echo 'MinIO TLS private key permissions are too broad.' >&2
  exit 1
fi

TEMP_ENV_FILE=''
FAILURE_ENV_FILE=''
PROBE_ENV_FILE=''

cleanup() {
  sudo -n docker rm -f "$TEMP_API" >/dev/null 2>&1 || true
  sudo -n docker rm -f "$FAILURE_API" >/dev/null 2>&1 || true
  [[ -z "$TEMP_ENV_FILE" ]] || rm -f -- "$TEMP_ENV_FILE"
  [[ -z "$FAILURE_ENV_FILE" ]] || rm -f -- "$FAILURE_ENV_FILE"
  [[ -z "$PROBE_ENV_FILE" ]] || rm -f -- "$PROBE_ENV_FILE"
}
trap cleanup EXIT

TEMP_ENV_FILE="$(mktemp)"
FAILURE_ENV_FILE="$(mktemp)"
PROBE_ENV_FILE="$(mktemp)"
chmod 600 "$TEMP_ENV_FILE" "$FAILURE_ENV_FILE" "$PROBE_ENV_FILE"

write_provider_env() {
  local endpoint="$1"
  local output_file="$2"
  {
    printf '%s\n' 'LOCAL_DOCUMENT_STORAGE_DIR='
    printf 'AWS_BUCKET_NAME=%s\n' "$MINIO_BUCKET"
    printf 'AWS_ENDPOINT=%s\n' "$endpoint"
    printf 'AWS_S3_ENDPOINT=%s\n' "$endpoint"
    printf 'AWS_ACCESS_KEY_ID=%s\n' "$MINIO_USER"
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$MINIO_PASSWORD"
    printf '%s\n' "NODE_EXTRA_CA_CERTS=$CA_CERT_CONTAINER"
    printf '%s\n' 'LOADTEST_EPHEMERAL_TARGET_ACK=sgs-loadtest-ephemeral'
    printf '%s\n' 'S3_FORCE_PATH_STYLE=true'
    printf '%s\n' "STORAGE_ENDPOINT=$endpoint"
    printf '%s\n' "STORAGE_BUCKET=$MINIO_BUCKET"
    printf '%s\n' 'STORAGE_REGION=us-east-1'
    printf '%s\n' "STORAGE_ACCESS_KEY_ID=$MINIO_USER"
    printf '%s\n' "STORAGE_SECRET_ACCESS_KEY=$MINIO_PASSWORD"
    printf '%s\n' 'PROVIDER_TARGET_IDENTITY=sgs-loadtest-minio'
    printf '%s\n' "PROVIDER_NETWORK=$NETWORK"
    printf '%s\n' 'PROVIDER_TARGET_TYPE=minio'
    printf '%s\n' 'PROVIDER_RUNTIME_MARKER=sgs-loadtest'
    printf '%s\n' "PROVIDER_ALLOWED_BUCKET=$MINIO_BUCKET"
    printf '%s\n' "PROVIDER_CREDENTIAL_SCOPE=$PROVIDER_CREDENTIAL_SCOPE"
  } > "$output_file"
}

write_provider_env 'https://minio-loadtest:9000' "$TEMP_ENV_FILE"
write_provider_env 'https://127.0.0.1:1' "$FAILURE_ENV_FILE"
write_provider_env 'https://minio-loadtest:9000' "$PROBE_ENV_FILE"

sudo -n docker rm -f "$TEMP_API" >/dev/null 2>&1 || true
sudo -n docker rm -f "$FAILURE_API" >/dev/null 2>&1 || true
"${COMPOSE[@]}" run -d --no-deps --name "$TEMP_API" \
  -v "$CA_CERT:$CA_CERT_CONTAINER:ro" \
  --env-from-file "$TEMP_ENV_FILE" \
  api-loadtest >/dev/null

for attempt in $(seq 1 40); do
  if sudo -n docker exec "$TEMP_API" node -e "require('http').get({host:'127.0.0.1',port:3001,path:'/health/public',timeout:3000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 40 ]]; then
    echo 'Temporary S3 API did not become ready.' >&2
    sudo -n docker logs --tail 80 "$TEMP_API" >&2 || true
    exit 1
  fi
  sleep 2
done

TEMP_API_IP="$(sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$TEMP_API")"
if [[ -z "$TEMP_API_IP" ]]; then
  echo 'Temporary S3 API has no internal network address.' >&2
  exit 1
fi

"${COMPOSE[@]}" run -d --no-deps --name "$FAILURE_API" \
  -v "$CA_CERT:$CA_CERT_CONTAINER:ro" \
  --env-from-file "$FAILURE_ENV_FILE" \
  api-loadtest >/dev/null

for attempt in $(seq 1 40); do
  if sudo -n docker exec "$FAILURE_API" node -e "require('http').get({host:'127.0.0.1',port:3001,path:'/health/public',timeout:3000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 40 ]]; then
    echo 'Temporary provider-failure API did not become ready.' >&2
    sudo -n docker logs --tail 80 "$FAILURE_API" >&2 || true
    exit 1
  fi
  sleep 2
done

FAILURE_API_IP="$(sudo -n docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$FAILURE_API")"
if [[ -z "$FAILURE_API_IP" ]]; then
  echo 'Temporary provider-failure API has no internal network address.' >&2
  exit 1
fi

"${COMPOSE[@]}" run --rm --no-deps --entrypoint node \
  -v "$CA_CERT:$CA_CERT_CONTAINER:ro" \
  -v "$PROBE_PATH:/opt/load-test/scripts/storage-grant-cache-final-gate.cjs:ro" \
  --env-from-file "$PROBE_ENV_FILE" \
  -e LOADTEST_API_URL="http://$TEMP_API_IP:3001" \
  -e FAILURE_API_URL="http://$FAILURE_API_IP:3001" \
  seed-loadtest /opt/load-test/scripts/storage-grant-cache-final-gate.cjs
