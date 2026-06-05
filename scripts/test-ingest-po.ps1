# Test harness that simulates a Power Automate POST to ingest-po-from-email.
# Useful for testing the portal-side end-to-end without forwarding email.
#
# Usage:
#   $env:PO_INGEST_TOKEN = "<value of PO_INGEST_TOKEN Supabase secret>"
#   .\test-ingest-po.ps1 -PdfPath "C:\path\to\some.pdf" -HwiCode "HWI-26-200"
#
# What it does:
#   1. Reads the PDF as bytes, base64-encodes it
#   2. Builds a JSON payload identical to what Power Automate sends
#   3. POSTs to the deployed edge function with the shared secret
#   4. Pretty-prints the response
#
# Expected outcomes:
#   - is_po=true + HWI code visible on doc/email → "ok":true, file lands in portal
#   - is_po=true + no HWI code anywhere → "reason":"no-hwi-code"
#   - is_po=false (e.g. an invoice or quote) → "reason":"no-po-found"
#   - HWI code points to non-existent project → "reason":"project-not-found"

param(
  [Parameter(Mandatory=$true)] [string]$PdfPath,
  [Parameter(Mandatory=$true)] [string]$HwiCode,
  [string]$IngestToken = $env:PO_INGEST_TOKEN,
  [string]$FromEmail = "kkim@hydrowates.com",
  [string]$Subject = "Fwd: PO from customer",
  [string]$ProjectRef = "uooklwtysposkuwocbup"
)

if ([string]::IsNullOrWhiteSpace($IngestToken)) {
  Write-Host "ERROR: ingest token missing." -ForegroundColor Red
  Write-Host "  Set `$env:PO_INGEST_TOKEN to the value of the PO_INGEST_TOKEN Supabase secret," -ForegroundColor Red
  Write-Host "  or pass -IngestToken on the command line." -ForegroundColor Red
  exit 1
}

$INGEST_URL = "https://$ProjectRef.supabase.co/functions/v1/ingest-po-from-email"

if (-not (Test-Path $PdfPath)) {
  Write-Host "ERROR: file not found: $PdfPath" -ForegroundColor Red
  exit 1
}

$filename = Split-Path $PdfPath -Leaf
$bytes = [System.IO.File]::ReadAllBytes($PdfPath)
$b64 = [Convert]::ToBase64String($bytes)

$payload = @{
  subject     = $Subject
  body        = "Hi team, forwarding the attached PO. Project $HwiCode. Thanks."
  fromEmail   = $FromEmail
  fromName    = "Test sender"
  attachments = @(
    @{
      filename      = $filename
      contentBase64 = $b64
      contentType   = "application/pdf"
    }
  )
} | ConvertTo-Json -Depth 5 -Compress

Write-Host ""
Write-Host "=== POSTing to ingest-po-from-email ===" -ForegroundColor Cyan
Write-Host "  Project code : $HwiCode"
Write-Host "  PDF          : $filename ($([Math]::Round($bytes.Length / 1KB,1)) KB)"
Write-Host "  From email   : $FromEmail"
Write-Host ""

try {
  $resp = Invoke-RestMethod -Method Post -Uri $INGEST_URL `
    -Headers @{ "X-Ingest-Token" = $IngestToken; "Content-Type" = "application/json" } `
    -Body $payload -TimeoutSec 120
  Write-Host "=== Response ===" -ForegroundColor Cyan
  $resp | ConvertTo-Json -Depth 5
  Write-Host ""
  if ($resp.ok) {
    Write-Host "SUCCESS." -ForegroundColor Green
    Write-Host "  Project: $($resp.projectName) ($($resp.customer))"
    foreach ($u in $resp.uploaded) {
      Write-Host "  Uploaded: $($u.name) - PO #$($u.po_number) - sharepoint=$($u.sharepoint)"
    }
  } else {
    Write-Host "Function returned ok=false." -ForegroundColor Yellow
    Write-Host "  reason : $($resp.reason)"
    Write-Host "  msg    : $($resp.message)"
  }
} catch {
  Write-Host "REQUEST FAILED:" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)"
  if ($_.ErrorDetails) { Write-Host "  body: $($_.ErrorDetails.Message)" }
}
