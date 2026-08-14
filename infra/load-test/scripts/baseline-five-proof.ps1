Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$base = 'https://api-loadtest.sgsseguranca.com.br'
$tenant = '00000000-0000-4000-8000-000000000001'
$sshKey = 'C:\Users\User\.ssh\sgs-loadtest-vps_ed25519'
$sshTarget = 'sgsops@83.229.115.37'
$remoteEnv = '/opt/sgs-loadtest/infra/load-test/.env.loadtest'
$password = [Environment]::GetEnvironmentVariable('LOADTEST_ADMIN_PASSWORD', 'Process')

function Get-ProxyKeyFromSsh {
  $remoteCommand = @'
set -eu
env_file='/opt/sgs-loadtest/infra/load-test/.env.loadtest'
count=$(grep -Ec '^LOADTEST_PROXY_KEY=' "$env_file")
test "$count" -eq 1
line=$(grep -E '^LOADTEST_PROXY_KEY=' "$env_file")
value="${line#*=}"
printf '%s\n' '__SGS_SECRET_BEGIN__'
printf '%s' "$value" | base64 -w 0
printf '\n%s\n' '__SGS_SECRET_END__'
'@
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = 'ssh.exe'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @(
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-i', $sshKey,
    $sshTarget,
    $remoteCommand
  )) { [void]$startInfo.ArgumentList.Add($argument) }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  $blocks = [regex]::Matches(
    $stdout,
    '(?ms)^__SGS_SECRET_BEGIN__\r?\n(?<payload>[A-Za-z0-9+/=]+)\r?\n__SGS_SECRET_END__\r?\n?$'
  )
  $script:SSH_EXTRACTION_BLOCK_COUNT = $blocks.Count
  if ($process.ExitCode -ne 0 -or $blocks.Count -ne 1) { throw 'GATE_KEY_EXTRACTION_FAILED' }

  try {
    $bytes = [Convert]::FromBase64String($blocks[0].Groups['payload'].Value)
    $value = [Text.Encoding]::UTF8.GetString($bytes).Trim([char]13, [char]10)
  } catch {
    throw 'GATE_KEY_EXTRACTION_FAILED'
  }
  if ($value -notmatch '^[a-fA-F0-9]{64}$') { throw 'GATE_KEY_EXTRACTION_FAILED' }
  return $value
}

function Invoke-SafeRequest {
  param(
    [string]$Uri,
    [ValidateSet('Get', 'Post')][string]$Method,
    [hashtable]$Headers,
    [Microsoft.PowerShell.Commands.WebRequestSession]$WebSession,
    [string]$Body
  )
  $params = @{
    Uri = $Uri
    Method = $Method
    Headers = $Headers
    SkipHttpErrorCheck = $true
  }
  if ($null -ne $WebSession) { $params.WebSession = $WebSession }
  if ($PSBoundParameters.ContainsKey('Body')) { $params.Body = $Body }
  return Invoke-WebRequest @params
}

$gate = $null
$password = [string]$password
try {
  if ([string]::IsNullOrWhiteSpace($password)) { throw 'secure proof password missing' }
  $gate = Get-ProxyKeyFromSsh
  Write-Output "SSH_EXTRACTION_BLOCK_COUNT=$SSH_EXTRACTION_BLOCK_COUNT"
  Write-Output "GATE_KEY_FORMAT_VALID=$([bool]($gate -match '^[a-fA-F0-9]{64}$'))"

  $public = Invoke-SafeRequest -Uri "$base/health/public" -Method Get -Headers @{ Accept = 'application/json' }
  $publicStatus = [int]$public.StatusCode
  $readyWithoutKey = Invoke-SafeRequest -Uri "$base/health/ready" -Method Get -Headers @{ Accept = 'application/json' }
  $readyWithoutKeyStatus = [int]$readyWithoutKey.StatusCode
  $preflightHeaders = @{ Accept = 'application/json'; 'X-Loadtest-Key' = $gate; 'X-Test-Run-ID' = 'sgs-proof-preflight-' + [Guid]::NewGuid().ToString('N') }
  $readyWithKey = Invoke-SafeRequest -Uri "$base/health/ready" -Method Get -Headers $preflightHeaders
  $readyWithKeyStatus = [int]$readyWithKey.StatusCode
  Write-Output "PUBLIC_STATUS=$publicStatus"
  Write-Output "READY_WITHOUT_KEY_STATUS=$readyWithoutKeyStatus"
  Write-Output "READY_WITH_KEY_STATUS=$readyWithKeyStatus"
  if ($publicStatus -ne 200 -or $readyWithoutKeyStatus -ne 401 -or $readyWithKeyStatus -ne 200) { throw 'GATE_KEY_EXTRACTION_FAILED' }

  $users = @(Get-Content './tests/load/grafana/data/synthetic-users.json' -Raw | ConvertFrom-Json | Where-Object { $_.alias -match '^loadtest-baseline-(00[6-9]|010)$' })
  if ($users.Count -ne 5) { throw 'LOGIN_PROOF_FAILED' }

  $tested = 0
  $total401 = 0
  $total403 = 0
  $total429 = 0
  $total5xx = 0
  foreach ($user in $users) {
    $run = 'sgs-baseline-proof-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
    $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $commonHeaders = @{ Accept = 'application/json'; 'X-Loadtest-Key' = $gate; 'X-Test-Run-ID' = $run }
    $csrf = Invoke-SafeRequest -Uri "$base/auth/csrf" -Method Get -Headers $commonHeaders -WebSession $session
    $csrfStatus = [int]$csrf.StatusCode
    $csrfToken = ''
    try { $csrfToken = [string](($csrf.Content | ConvertFrom-Json).csrfToken) } catch { $csrfToken = '' }

    $loginStatus = 'SKIPPED'
    $token = ''
    $authMeStatus = 'SKIPPED'
    $mfaStatus = 'SKIPPED'
    $userMatch = $false
    $tenantMatch = $false
    if ($csrfStatus -eq 200 -and $csrfToken) {
      $loginHeaders = @{ Accept = 'application/json'; 'Content-Type' = 'application/json'; 'X-Loadtest-Key' = $gate; 'X-Test-Run-ID' = $run; 'x-csrf-token' = $csrfToken }
      $body = @{ cpf = $user.login; password = $password } | ConvertTo-Json -Compress
      $login = Invoke-SafeRequest -Uri "$base/auth/login" -Method Post -Headers $loginHeaders -Body $body -WebSession $session
      $loginStatus = [int]$login.StatusCode
      try { $token = [string](($login.Content | ConvertFrom-Json).accessToken) } catch { $token = '' }
    }
    if ($loginStatus -in @(200, 201) -and $token) {
      $protected = @{ Accept = 'application/json'; Authorization = "Bearer $token"; 'X-Loadtest-Key' = $gate; 'X-Test-Run-ID' = $run }
      $me = Invoke-SafeRequest -Uri "$base/auth/me" -Method Get -Headers $protected -WebSession $session
      $authMeStatus = [int]$me.StatusCode
      try {
        $meUser = ($me.Content | ConvertFrom-Json).user
        $userMatch = [string]$meUser.id -eq [string]$user.user_id
        $tenantMatch = [string]$meUser.company_id -eq $tenant
      } catch { $userMatch = $false; $tenantMatch = $false }
      $mfa = Invoke-SafeRequest -Uri "$base/auth/mfa/status" -Method Get -Headers $protected -WebSession $session
      $mfaStatus = [int]$mfa.StatusCode
    }

    $codes = @($csrfStatus, $loginStatus)
    if ($authMeStatus -ne 'SKIPPED') { $codes += $authMeStatus }
    if ($mfaStatus -ne 'SKIPPED') { $codes += $mfaStatus }
    $n401 = @($codes | Where-Object { $_ -eq 401 }).Count
    $n403 = @($codes | Where-Object { $_ -eq 403 }).Count
    $n429 = @($codes | Where-Object { $_ -eq 429 }).Count
    $n5xx = @($codes | Where-Object { $_ -ge 500 -and $_ -le 599 }).Count
    $total401 += $n401; $total403 += $n403; $total429 += $n429; $total5xx += $n5xx; $tested++
    Write-Output "ALIAS=$($user.alias) CSRF_STATUS=$csrfStatus LOGIN_STATUS=$loginStatus ACCESS_TOKEN_PRESENT=$([bool]$token) AUTH_ME_STATUS=$authMeStatus EXPECTED_USER_MATCH=$userMatch EXPECTED_TENANT_MATCH=$tenantMatch MFA_STATUS=$mfaStatus HTTP_401_COUNT=$n401 HTTP_403_COUNT=$n403 HTTP_429_COUNT=$n429 HTTP_5XX_COUNT=$n5xx"

    $failedCode = @($codes | Where-Object { $_ -in @(401, 403, 429) -or ($_ -ge 500 -and $_ -le 599) }).Count -gt 0
    if ($failedCode -or -not $token -or -not $userMatch -or -not $tenantMatch -or $loginStatus -notin @(200, 201) -or $authMeStatus -ne 200 -or $mfaStatus -ne 200) {
      Write-Output "TOTAL_USERS_TESTED=$tested TOTAL_LOGINS=$tested TOTAL_401=$total401 TOTAL_403=$total403 TOTAL_429=$total429 TOTAL_5XX=$total5xx RETRIES=0 PROOF_FAILED=true"
      exit 10
    }
    $token = $null
    $session = $null
    if ($tested -lt $users.Count) { Start-Sleep -Seconds 5 }
  }
  Write-Output "TOTAL_USERS_TESTED=$tested TOTAL_LOGINS=$tested TOTAL_401=$total401 TOTAL_403=$total403 TOTAL_429=$total429 TOTAL_5XX=$total5xx RETRIES=0 PROOF_FAILED=false"
} catch {
  if ($_.Exception.Message -eq 'GATE_KEY_EXTRACTION_FAILED') {
    if ($null -eq $SSH_EXTRACTION_BLOCK_COUNT) { $SSH_EXTRACTION_BLOCK_COUNT = 0 }
    Write-Output "SSH_EXTRACTION_BLOCK_COUNT=$SSH_EXTRACTION_BLOCK_COUNT"
    Write-Output 'GATE_KEY_FORMAT_VALID=False'
    exit 20
  }
  Write-Output 'PROOF_FAILED=true'
  exit 10
} finally {
  $gate = $null
  $password = $null
  $token = $null
  $session = $null
}
