$ErrorActionPreference = 'Stop'
# Run on a disposable Windows CI VM. This is not a substitute for visual QA.
$setup = @(Get-ChildItem release/*-Setup-x64.exe)
$portable = @(Get-ChildItem release/*-Portable-x64.exe)
if ($setup.Count -ne 1 -or $portable.Count -ne 1) { throw 'Missing/ambiguous installers' }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\AEM Store Smoke'
function Assert-Launch($exe) {
  $env:AEM_SMOKE_TEST = '1'
  $env:AEM_SMOKE_RESULT = Join-Path $env:TEMP "aem-smoke-$([guid]::NewGuid()).json"
  $p = Start-Process -FilePath $exe -PassThru
  try {
    if (!$p.WaitForExit(60000)) { throw 'Application smoke launch timed out' }
    if (!(Test-Path $env:AEM_SMOKE_RESULT)) { throw 'Renderer did not acknowledge installed launch' }
    $result = Get-Content $env:AEM_SMOKE_RESULT | ConvertFrom-Json
    if (!$result.ok) { throw 'Renderer smoke test failed' }
    return $result
  } finally {
    if (!$p.HasExited) { Stop-Process -Id $p.Id -Force }
    Remove-Item $env:AEM_SMOKE_RESULT -ErrorAction SilentlyContinue
    Remove-Item Env:AEM_SMOKE_TEST, Env:AEM_SMOKE_RESULT -ErrorAction SilentlyContinue
  }
}
$upgradeMarker = $null
$priorData = $null
$version = (Get-Content package.json | ConvertFrom-Json).version
if (Test-Path previous-release) {
  $previous = @(Get-ChildItem previous-release/*-Setup-x64.exe)
  if ($previous.Count -eq 1 -and $previous[0].Name -match 'AEM-Store-(\d+\.\d+\.\d+)-Setup-x64.exe') {
    $priorVersion = $Matches[1]
    if ([version]$priorVersion -ge [version]'0.2.11' -and [version]$priorVersion -lt [version]$version) {
      $p = Start-Process $previous[0].FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
      if ($p.ExitCode -ne 0) { throw 'Previous version installation failed' }
      $prior = Assert-Launch (Join-Path $installDir 'AEM Store.exe')
      $priorData = $prior.userData
      if (!$priorData) { throw 'Previous app did not report actual data path' }
      $upgradeMarker = Join-Path $priorData 'aem-upgrade-preservation.txt'
      Set-Content $upgradeMarker 'preserve-across-version-upgrade'
    }
  }
}
$p = Start-Process $setup[0].FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Setup exit $($p.ExitCode)" }
$exe = Join-Path $installDir 'AEM Store.exe'
if (!(Test-Path $exe)) { throw 'Installed executable missing' }
if ((Get-Item $exe).VersionInfo.ProductName -ne 'AEM Store') { throw 'Executable product resources missing' }
Add-Type -AssemblyName System.Drawing
$actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
if (!$actualIcon) { throw 'Installed executable has no extractable icon' }
$expectedIcon = [System.Drawing.Icon]::new((Resolve-Path resources/icons/icon.ico).Path, $actualIcon.Size)
$actualBitmap = $actualIcon.ToBitmap()
$expectedBitmap = $expectedIcon.ToBitmap()
$compared = 0; $different = 0
for ($x = 0; $x -lt $expectedBitmap.Width; $x++) {
  for ($y = 0; $y -lt $expectedBitmap.Height; $y++) {
    $expected = $expectedBitmap.GetPixel($x, $y)
    if ($expected.A -lt 128) { continue }
    $actual = $actualBitmap.GetPixel($x, $y)
    $compared++
    if ([Math]::Abs([int]$expected.R - [int]$actual.R) -gt 8 -or [Math]::Abs([int]$expected.G - [int]$actual.G) -gt 8 -or [Math]::Abs([int]$expected.B - [int]$actual.B) -gt 8) { $different++ }
  }
}
$actualBitmap.Dispose(); $expectedBitmap.Dispose(); $actualIcon.Dispose(); $expectedIcon.Dispose()
if ($compared -eq 0 -or $different / $compared -gt 0.05) { throw 'Installed application icon does not match AEM branding' }
$start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AEM Store.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AEM Store.lnk'
foreach ($link in @($start, $desktop)) {
  if (!(Test-Path $link)) { throw "Shortcut missing: $link" }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
  if ($shortcut.TargetPath -ne $exe) { throw "Wrong shortcut target: $link" }
}
$version = (Get-Content package.json | ConvertFrom-Json).version
$registration = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object {
  $_.DisplayName -in @('AEM Store', "AEM Store $version") -and $_.DisplayVersion -eq $version -and
  $_.UninstallString -and $_.UninstallString.IndexOf($installDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
if (!$registration) { throw 'Uninstall registration missing' }
$firstLaunch = Assert-Launch $exe
if ($firstLaunch.version -ne $version) { throw 'Installed application version differs from the build' }
if ($upgradeMarker) {
  if (!(Test-Path $upgradeMarker) -or $firstLaunch.userData -ne $priorData) { throw 'Cross-version upgrade lost data or changed its location' }
  Remove-Item $upgradeMarker
  Write-Host "::notice title=Windows upgrade regression::Upgraded $priorVersion to $version, launched the installed app and preserved its actual user-data directory."
} else {
  Write-Host '::notice title=Windows upgrade regression::Cross-version test skipped: no previous compatible smoke-enabled artifact. Same-version reinstall still tested.'
}
# Same-version reinstall exercises preservation; cross-version upgrades still need hardware QA.
$data = $firstLaunch.userData
if (!$data) { throw 'Application did not report its actual user-data directory' }
New-Item -ItemType Directory -Force $data | Out-Null
$marker = Join-Path $data 'smoke-preservation.txt'
Set-Content $marker 'preserve'
$p = Start-Process $setup[0].FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
if ($p.ExitCode -ne 0 -or !(Test-Path $marker)) { throw 'Reinstall failed or removed data' }
Assert-Launch $exe
Assert-Launch $portable[0].FullName
$uninstaller = @(Get-ChildItem $installDir/*Uninstall*.exe)
if ($uninstaller.Count -ne 1) { throw 'Uninstaller missing' }
# NSIS _?= keeps the uninstaller in place so Wait tracks the actual uninstall process.
$p = Start-Process $uninstaller[0].FullName -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru
if ($p.ExitCode -ne 0 -or (Test-Path $exe)) { throw 'Uninstall failed' }
if (!(Test-Path $marker)) { throw 'Uninstall unexpectedly deleted application data' }
if (Test-Path $start) { throw 'Start Menu shortcut survived uninstall' }
Remove-Item $marker
Write-Host 'Setup, resources, shortcuts, renderer launch, reinstall, portable and uninstall smoke passed.'
