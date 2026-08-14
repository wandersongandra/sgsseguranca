param(
  [switch]$ConfirmLoadTestReset,
  [switch]$LowMemory
)

$ErrorActionPreference = 'Stop'
if (-not $ConfirmLoadTestReset) {
  throw 'Refusing reset. Re-run with -ConfirmLoadTestReset; this removes only SGS load-test volumes.'
}
if ($env:APP_ENV -ne 'loadtest') {
  throw 'Refusing reset unless APP_ENV=loadtest is set in the current shell.'
}

$composeArgs = @('--env-file', '.env.loadtest', '-f', 'compose.yml')
if ($LowMemory) { $composeArgs += @('-f', 'compose.low-memory.yml') }
$composeArgs += @('config')
docker compose @composeArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Compose safety validation failed.' }

$downArgs = @('--env-file', '.env.loadtest', '-f', 'compose.yml')
if ($LowMemory) { $downArgs += @('-f', 'compose.low-memory.yml') }
$downArgs += @('down', '--volumes', '--remove-orphans')
docker compose @downArgs
if ($LASTEXITCODE -ne 0) { throw 'Load-test reset failed.' }
