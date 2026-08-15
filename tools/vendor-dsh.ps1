param(
  [string]$SourceRoot = 'C:\works\deepseek-harness',
  [string]$DestRoot = 'C:\works\cimdev-test-agent\third-party\dsh'
)

# Vendors the DSH source closure for the local Host seams into this repo.
# It copies source, tests, package.json and notices, excluding build artifacts.
$packages = @(
  'vendor\cordis','vendor\include','vendor\loader','vendor\cosmokit','vendor\schemastery',
  'packages\util\brand','packages\runtime-diagnostics\invariants','packages\llm\llm',
  'packages\sandbox\sandbox','packages\sandbox\sandbox-local','packages\sandbox\sandbox-windows-acl',
  'packages\core\scope','packages\core\session','packages\session\session-persistence','packages\session\session-persistence-jsonl',
  'packages\storage\storage','packages\storage\storage-domain','packages\subprocess\subprocess','packages\subprocess\subprocess-local',
  'packages\util\timeout','packages\typert\protocol','packages\workspace\workspace','native\landlock-run\packages\entry','packages\attachment\attachment'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $DestRoot | Out-Null

foreach ($p in $packages) {
  $src = Join-Path $SourceRoot $p
  $dst = Join-Path $DestRoot $p
  if (-not (Test-Path -LiteralPath $src)) {
    Write-Warning "Missing source: $src"
    continue
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
  robocopy $src $dst /E /XD node_modules lib dist .tsbuildinfo /XF *.tsbuildinfo /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy failed for $src" }
  Write-Output "COPIED $p"
}

Copy-Item -LiteralPath (Join-Path $SourceRoot 'LICENSE') -Destination (Join-Path $DestRoot 'LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $SourceRoot 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $DestRoot 'THIRD_PARTY_NOTICES.md') -Force
Write-Output 'DONE'
