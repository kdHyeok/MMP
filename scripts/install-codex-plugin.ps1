param(
  [string]$MarketplacePath = (Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'),
  [string]$PluginPath
)

$ErrorActionPreference = 'Stop'
$repoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$MarketplacePath = [IO.Path]::GetFullPath($MarketplacePath)
$marketplaceDir = Split-Path $MarketplacePath -Parent
# Codex resolves source.path from the catalog root, not .agents/plugins.
$catalogFolder = Split-Path $marketplaceDir -Leaf
$catalogParent = Split-Path $marketplaceDir -Parent
if ($catalogFolder -eq 'plugins' -and (Split-Path $catalogParent -Leaf) -eq '.agents') {
  $marketplaceRoot = Split-Path $catalogParent -Parent
} elseif ($catalogFolder -eq '.claude-plugin') {
  $marketplaceRoot = $catalogParent
} else {
  throw 'MarketplacePath must be <root>/.agents/plugins/marketplace.json or <root>/.claude-plugin/marketplace.json.'
}
if (-not $PluginPath) { $PluginPath = Join-Path $marketplaceRoot 'plugins\mmp' }
$PluginPath = [IO.Path]::GetFullPath($PluginPath)
$rootPrefix = $marketplaceRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if (-not $PluginPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'PluginPath must be inside the marketplace root.'
}
$sourcePath = './' + $PluginPath.Substring($rootPrefix.Length).Replace('\', '/')
$pluginParent = Split-Path $PluginPath -Parent
$pluginName = Split-Path $PluginPath -Leaf

if ($pluginName -ne 'mmp') {
  throw 'PluginPath must end with mmp.'
}

if (Test-Path $PluginPath) {
  throw "Plugin path already exists: $PluginPath. Remove or rename it before a fresh install."
}

if (Test-Path $MarketplacePath) {
  $marketplace = Get-Content -Raw $MarketplacePath | ConvertFrom-Json
} else {
  $marketplace = [pscustomobject]@{
    name = 'personal'
    interface = [pscustomobject]@{ displayName = 'Personal' }
    plugins = @()
  }
}

if (-not $marketplace.name) {
  throw "Marketplace name is missing: $MarketplacePath"
}

$existing = @($marketplace.plugins | Where-Object { $_.name -eq $pluginName })
if ($existing.Count -gt 0) {
  throw "Marketplace already contains $pluginName. Use the plugin update flow instead."
}

New-Item -ItemType Directory -Force -Path $pluginParent, $PluginPath | Out-Null
New-Item -ItemType Directory -Force -Path $marketplaceDir | Out-Null
foreach ($item in @('.codex-plugin', 'assets', 'skills', 'src', 'bin', 'hooks', '.mcp.json', 'package.json', 'package-lock.json', 'README.md')) {
  Copy-Item -LiteralPath (Join-Path $repoPath $item) -Destination $PluginPath -Recurse
}

Push-Location $PluginPath
try {
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
} finally {
  Pop-Location
}

$entry = [pscustomobject]@{
  name = $pluginName
  source = [pscustomobject]@{ source = 'local'; path = $sourcePath }
  policy = [pscustomobject]@{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }
  category = 'Productivity'
}
$marketplace.plugins = @($marketplace.plugins) + $entry
[IO.File]::WriteAllText($MarketplacePath, ($marketplace | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding $false))

codex plugin marketplace add $marketplaceRoot
if ($LASTEXITCODE -ne 0) {
  throw 'codex plugin marketplace add failed.'
}
codex plugin add "$pluginName@$($marketplace.name)"
if ($LASTEXITCODE -ne 0) {
  throw 'codex plugin add failed.'
}

Write-Host "Installed $pluginName from $PluginPath"
Write-Host 'Open a new Codex task to load the MCP tools and skill.'
Write-Host 'Review and trust the MMP hook definition in Codex before using MR review.'
