# Bulk-sync every HWI-25 and HWI-26 project from SharePoint into the portal.
# Pulls everything (POs, quotes, equipment certs, root-level test certs) —
# uses sharepoint_source_id to dedupe, so re-running is safe.
#
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."   # https://supabase.com/dashboard/account/tokens
#   .\bulk-sync-all.ps1
#
# Or pass directly:
#   .\bulk-sync-all.ps1 -SupabaseToken "sbp_..."
#
# Watch progress live by tailing .bulk-sync-progress.txt on the Desktop.

param(
  [string]$SupabaseToken = $env:SUPABASE_ACCESS_TOKEN,
  [string]$ProjectRef    = "vpdcikiyaifppkkantrb"   # LifeOSBase — the project both the portal and travel app share
)

if ([string]::IsNullOrWhiteSpace($SupabaseToken)) {
  Write-Host "ERROR: Supabase access token missing." -ForegroundColor Red
  Write-Host "  Set `$env:SUPABASE_ACCESS_TOKEN or pass -SupabaseToken." -ForegroundColor Red
  Write-Host "  Get one at https://supabase.com/dashboard/account/tokens" -ForegroundColor Yellow
  exit 1
}

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$logPath      = Join-Path $env:USERPROFILE "Desktop\.bulk-sync-log.txt"
$progressPath = Join-Path $env:USERPROFILE "Desktop\.bulk-sync-progress.txt"

$mgmtHeaders = @{ Authorization = "Bearer $SupabaseToken" }
$keys = Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ProjectRef/api-keys" -Headers $mgmtHeaders
$serviceRole = ($keys | Where-Object { $_.name -eq "service_role" }).api_key

$sql = "select id, name from public.cportal_projects where name ~* '^HWI-(25|26)-' order by name desc"
$body = @{ query = $sql } | ConvertTo-Json -Compress
$projects = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" -Headers $mgmtHeaders -ContentType "application/json" -Body $body

$total = $projects.Count
$startTime = Get-Date

"=== Bulk sync started $startTime ===" | Out-File -FilePath $logPath -Encoding utf8
"Projects to process: $total (HWI-25 and HWI-26)" | Out-File -FilePath $logPath -Append -Encoding utf8
"" | Out-File -FilePath $logPath -Append -Encoding utf8

$totals = @{
  processed = 0
  noFolder = 0
  upToDate = 0
  errors = 0
  totalNewFiles = 0
  quotesAdded = 0
  posAdded = 0
  certsAdded = 0
}

foreach ($p in $projects) {
  $totals.processed++
  $elapsed = (Get-Date) - $startTime
  $elapsedStr = "{0:hh\:mm\:ss}" -f $elapsed

  @"
PROGRESS: $($totals.processed) of $total projects processed
ELAPSED: $elapsedStr
LAST: $($p.name)
RUNNING TOTALS:
  Files added: $($totals.totalNewFiles)  (quotes=$($totals.quotesAdded), POs=$($totals.posAdded), certs=$($totals.certsAdded))
  No matching folder: $($totals.noFolder)
  Up to date: $($totals.upToDate)
  Errors: $($totals.errors)
"@ | Out-File -FilePath $progressPath -Encoding utf8

  $invokeBody = @{ projectId = $p.id } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "https://$ProjectRef.supabase.co/functions/v1/sync-files-from-sharepoint" -Headers @{ "Authorization" = "Bearer $serviceRole"; "apikey" = $serviceRole } -ContentType "application/json" -Body $invokeBody -ErrorAction Stop -TimeoutSec 120

    if ($resp.status -eq "no-folder") {
      $totals.noFolder++
      "[$($totals.processed)/$total] $($p.name): no-folder" | Out-File -FilePath $logPath -Append -Encoding utf8
    } elseif ($resp.summary) {
      $thisAdded = 0
      $byKind = @()
      foreach ($folder in $resp.summary.PSObject.Properties) {
        $stats = $folder.Value
        $thisAdded += $stats.added
        if ($folder.Name -eq "Quote") { $totals.quotesAdded += $stats.added }
        elseif ($folder.Name -eq "Purchase Order") { $totals.posAdded += $stats.added }
        elseif ($folder.Name -eq "Inspection Documents" -or $folder.Name -eq "Project root (Certificates)") { $totals.certsAdded += $stats.added }
        if ($stats.added -gt 0 -or $stats.errors -gt 0) {
          $byKind += "$($folder.Name)=$($stats.added)" + $(if ($stats.errors -gt 0) { "(err=$($stats.errors))" } else { "" })
        }
      }
      $totals.totalNewFiles += $thisAdded
      if ($thisAdded -eq 0) {
        $totals.upToDate++
        "[$($totals.processed)/$total] $($p.name): up-to-date" | Out-File -FilePath $logPath -Append -Encoding utf8
      } else {
        "[$($totals.processed)/$total] $($p.name): added $thisAdded files ($($byKind -join ', '))" | Out-File -FilePath $logPath -Append -Encoding utf8
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

  Start-Sleep -Milliseconds 500
}

$endTime = Get-Date
$totalElapsed = $endTime - $startTime
$elapsedStr = "{0:hh\:mm\:ss}" -f $totalElapsed

@"

=== Bulk sync complete $endTime ===
Total elapsed: $elapsedStr
FINAL TOTALS:
  Projects processed: $($totals.processed)
  Files added: $($totals.totalNewFiles)
    Quotes: $($totals.quotesAdded)
    POs: $($totals.posAdded)
    Certificates: $($totals.certsAdded)
  No matching folder: $($totals.noFolder)
  Up to date: $($totals.upToDate)
  Errors: $($totals.errors)
"@ | Out-File -FilePath $logPath -Append -Encoding utf8

@"
DONE: $($totals.processed) of $total projects processed
ELAPSED: $elapsedStr
FINAL TOTALS:
  Files added: $($totals.totalNewFiles)  (quotes=$($totals.quotesAdded), POs=$($totals.posAdded), certs=$($totals.certsAdded))
  No matching folder: $($totals.noFolder)
  Up to date: $($totals.upToDate)
  Errors: $($totals.errors)
"@ | Out-File -FilePath $progressPath -Encoding utf8
