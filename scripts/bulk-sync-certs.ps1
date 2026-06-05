# Bulk-sync ONLY root-level Certificate*.pdf files for all HWI-NN projects.
# Skips the subfolder loop (no extra POs, quotes, or equipment certs pulled).
#
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # https://supabase.com/dashboard/account/tokens
#   .\bulk-sync-certs.ps1                    # defaults to HWI-26
#   .\bulk-sync-certs.ps1 -YearPrefix "HWI-25"
#
# Watch progress at .bulk-sync-certs-progress.txt on the Desktop.

param(
  [string]$SupabaseToken = $env:SUPABASE_ACCESS_TOKEN,
  [string]$ProjectRef    = "uooklwtysposkuwocbup",
  [string]$YearPrefix    = "HWI-26"
)

if ([string]::IsNullOrWhiteSpace($SupabaseToken)) {
  Write-Host "ERROR: Supabase access token missing." -ForegroundColor Red
  Write-Host "  Set `$env:SUPABASE_ACCESS_TOKEN or pass -SupabaseToken." -ForegroundColor Red
  exit 1
}

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$logPath      = Join-Path $env:USERPROFILE "Desktop\.bulk-sync-certs-log.txt"
$progressPath = Join-Path $env:USERPROFILE "Desktop\.bulk-sync-certs-progress.txt"

$mgmtHeaders = @{ Authorization = "Bearer $SupabaseToken" }
$keys = Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ProjectRef/api-keys" -Headers $mgmtHeaders
$serviceRole = ($keys | Where-Object { $_.name -eq "service_role" }).api_key

$sql = "select id, name from public.projects where name ~* '^$YearPrefix-' order by name desc"
$body = @{ query = $sql } | ConvertTo-Json -Compress
$projects = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" -Headers $mgmtHeaders -ContentType "application/json" -Body $body

$total      = $projects.Count
$startTime  = Get-Date

"=== Cert-only bulk sync started $startTime ===" | Out-File -FilePath $logPath -Encoding utf8
"Projects to process: $total ($YearPrefix only, certsOnly=true)" | Out-File -FilePath $logPath -Append -Encoding utf8
"" | Out-File -FilePath $logPath -Append -Encoding utf8

$totals = @{
  processed    = 0
  noFolder     = 0
  certsAdded   = 0
  upToDate     = 0
  errors       = 0
}

foreach ($p in $projects) {
  $totals.processed++
  $elapsed     = (Get-Date) - $startTime
  $elapsedStr  = "{0:hh\:mm\:ss}" -f $elapsed

  @"
PROGRESS: $($totals.processed) of $total $YearPrefix projects processed
ELAPSED: $elapsedStr
LAST: $($p.name)
RUNNING TOTALS:
  Certificates added: $($totals.certsAdded)
  No matching folder: $($totals.noFolder)
  No cert at root:    $($totals.upToDate)
  Errors:             $($totals.errors)
"@ | Out-File -FilePath $progressPath -Encoding utf8

  $invokeBody = @{ projectId = $p.id; certsOnly = $true } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "https://$ProjectRef.supabase.co/functions/v1/sync-files-from-sharepoint" -Headers @{ "Authorization" = "Bearer $serviceRole"; "apikey" = $serviceRole } -ContentType "application/json" -Body $invokeBody -ErrorAction Stop -TimeoutSec 120

    if ($resp.status -eq "no-folder") {
      $totals.noFolder++
      "[$($totals.processed)/$total] $($p.name): no-folder" | Out-File -FilePath $logPath -Append -Encoding utf8
    } elseif ($resp.summary) {
      $certStats = $resp.summary."Project root (Certificates)"
      $added     = if ($certStats) { $certStats.added } else { 0 }
      $totals.certsAdded += $added
      if ($added -gt 0) {
        "[$($totals.processed)/$total] $($p.name): +$added certificate(s)" | Out-File -FilePath $logPath -Append -Encoding utf8
      } else {
        $totals.upToDate++
      }
    } else {
      $totals.errors++
      "[$($totals.processed)/$total] $($p.name): UNKNOWN RESPONSE - $($resp | ConvertTo-Json -Compress)" | Out-File -FilePath $logPath -Append -Encoding utf8
    }
  } catch {
    $totals.errors++
    $errMsg = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    "[$($totals.processed)/$total] $($p.name): ERROR - $errMsg" | Out-File -FilePath $logPath -Append -Encoding utf8
  }

  Start-Sleep -Milliseconds 250
}

$endTime       = Get-Date
$totalElapsed  = $endTime - $startTime
$elapsedStr    = "{0:hh\:mm\:ss}" -f $totalElapsed

@"

=== Cert-only bulk sync complete $endTime ===
Total elapsed: $elapsedStr
FINAL TOTALS:
  Projects processed:  $($totals.processed)
  Certificates added:  $($totals.certsAdded)
  No matching folder:  $($totals.noFolder)
  No cert at root:     $($totals.upToDate)
  Errors:              $($totals.errors)
"@ | Out-File -FilePath $logPath -Append -Encoding utf8

@"
DONE: $($totals.processed) of $total $YearPrefix projects processed
ELAPSED: $elapsedStr
FINAL TOTALS:
  Certificates added: $($totals.certsAdded)
  No matching folder: $($totals.noFolder)
  No cert at root:    $($totals.upToDate)
  Errors:             $($totals.errors)
"@ | Out-File -FilePath $progressPath -Encoding utf8
