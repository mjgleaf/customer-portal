# Bulk-sync every project for a given HWI year prefix (e.g. HWI-26).
# Now reference-only — no bytes downloaded, no Supabase Storage writes.
# Equipment certs, POs, quotes, root certs all sync as metadata.
#
# Usage:
#   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."
#   .\bulk-sync-year.ps1                      # defaults to HWI-26
#   .\bulk-sync-year.ps1 -YearPrefix "HWI-25"

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

$logPath      = Join-Path $env:USERPROFILE "Desktop\.bulk-sync-year-log.txt"
$progressPath = Join-Path $env:USERPROFILE "Desktop\.bulk-sync-year-progress.txt"

$mgmtHeaders = @{ Authorization = "Bearer $SupabaseToken" }
$keys = Invoke-RestMethod -Method Get -Uri "https://api.supabase.com/v1/projects/$ProjectRef/api-keys" -Headers $mgmtHeaders
$serviceRole = ($keys | Where-Object { $_.name -eq "service_role" }).api_key

$sql = "select id, name from public.projects where name ~* '^$YearPrefix-' order by name desc"
$body = @{ query = $sql } | ConvertTo-Json -Compress
$projects = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$ProjectRef/database/query" -Headers $mgmtHeaders -ContentType "application/json" -Body $body

$total = $projects.Count
$startTime = Get-Date

"=== $YearPrefix bulk sync started $startTime ===" | Out-File -FilePath $logPath -Encoding utf8
"Projects to process: $total (reference-only)" | Out-File -FilePath $logPath -Append -Encoding utf8
"" | Out-File -FilePath $logPath -Append -Encoding utf8

$totals = @{
  processed = 0
  noFolder = 0
  upToDate = 0
  errors = 0
  totalNewFiles = 0
  posAdded = 0
  quotesAdded = 0
  rootCertsAdded = 0
  equipmentCertsAdded = 0
}

foreach ($p in $projects) {
  $totals.processed++
  $elapsed = (Get-Date) - $startTime
  $elapsedStr = "{0:hh\:mm\:ss}" -f $elapsed

  @"
PROGRESS: $($totals.processed) of $total $YearPrefix projects processed
ELAPSED: $elapsedStr
LAST: $($p.name)
RUNNING TOTALS:
  Files added: $($totals.totalNewFiles)
    POs:               $($totals.posAdded)
    Quotes:            $($totals.quotesAdded)
    Test certs (root): $($totals.rootCertsAdded)
    Equipment certs:   $($totals.equipmentCertsAdded)
  No matching folder: $($totals.noFolder)
  Up to date:         $($totals.upToDate)
  Errors:             $($totals.errors)
"@ | Out-File -FilePath $progressPath -Encoding utf8

  $invokeBody = @{ projectId = $p.id } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "https://$ProjectRef.supabase.co/functions/v1/sync-files-from-sharepoint" -Headers @{ "Authorization" = "Bearer $serviceRole"; "apikey" = $serviceRole } -ContentType "application/json" -Body $invokeBody -ErrorAction Stop -TimeoutSec 240

    if ($resp.status -eq "no-folder") {
      $totals.noFolder++
      "[$($totals.processed)/$total] $($p.name): no-folder" | Out-File -FilePath $logPath -Append -Encoding utf8
    } elseif ($resp.summary) {
      $thisAdded = 0
      foreach ($folder in $resp.summary.PSObject.Properties) {
        $a = [int]$folder.Value.added
        $thisAdded += $a
        switch ($folder.Name) {
          "Purchase Order"                        { $totals.posAdded += $a }
          "Quote"                                  { $totals.quotesAdded += $a }
          "Project root (Certificates)"            { $totals.rootCertsAdded += $a }
          "Equipment certificates (loadout)"       { $totals.equipmentCertsAdded += $a }
        }
      }
      $totals.totalNewFiles += $thisAdded
      if ($thisAdded -eq 0) {
        $totals.upToDate++
      } else {
        "[$($totals.processed)/$total] $($p.name): +$thisAdded files" | Out-File -FilePath $logPath -Append -Encoding utf8
      }
    } else {
      $totals.errors++
      "[$($totals.processed)/$total] $($p.name): UNKNOWN" | Out-File -FilePath $logPath -Append -Encoding utf8
    }
  } catch {
    $totals.errors++
    $errMsg = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    "[$($totals.processed)/$total] $($p.name): ERROR - $errMsg" | Out-File -FilePath $logPath -Append -Encoding utf8
  }

  Start-Sleep -Milliseconds 250
}

$endTime = Get-Date
$totalElapsed = $endTime - $startTime
$elapsedStr = "{0:hh\:mm\:ss}" -f $totalElapsed

@"

=== $YearPrefix bulk sync complete $endTime ===
Total elapsed: $elapsedStr
FINAL TOTALS:
  Projects processed:  $($totals.processed)
  Files added:         $($totals.totalNewFiles)
    POs:               $($totals.posAdded)
    Quotes:            $($totals.quotesAdded)
    Test certs (root): $($totals.rootCertsAdded)
    Equipment certs:   $($totals.equipmentCertsAdded)
  No matching folder:  $($totals.noFolder)
  Up to date:          $($totals.upToDate)
  Errors:              $($totals.errors)
"@ | Out-File -FilePath $logPath -Append -Encoding utf8

@"
DONE: $($totals.processed) of $total $YearPrefix projects processed
ELAPSED: $elapsedStr
FINAL TOTALS:
  Files added: $($totals.totalNewFiles)
    POs:               $($totals.posAdded)
    Quotes:            $($totals.quotesAdded)
    Test certs (root): $($totals.rootCertsAdded)
    Equipment certs:   $($totals.equipmentCertsAdded)
  No matching folder: $($totals.noFolder)
  Up to date:         $($totals.upToDate)
  Errors:             $($totals.errors)
"@ | Out-File -FilePath $progressPath -Encoding utf8
