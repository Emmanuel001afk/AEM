$ErrorActionPreference = 'Stop'
# Validates the real .NET -> NSIS build route using repository-owned test source.
# This does not assert that any third-party Android app has been ported.
$work = Join-Path $env:RUNNER_TEMP 'aem-native-source-test'
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item tests/fixtures/native/* $work
Copy-Item resources/icons/icon.ico (Join-Path $work 'fixture.ico')
$nsis = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache') -Filter makensis.exe -Recurse | Select-Object -First 1
if (!$nsis) { throw 'NSIS compiler cache not found after Windows packaging' }
$recipe = Join-Path $work 'aem-native.json'
$output = Join-Path $work 'outputs'
node -e "const fs=require('fs'); const {buildNativeSource}=require('./dist-electron/native-delivery.js'); buildNativeSource(process.argv[1],process.argv[2],process.argv[3]).then(r=>fs.writeFileSync(process.argv[4],JSON.stringify(r))).catch(e=>{console.error(e);process.exit(1)})" $recipe $nsis.FullName $output (Join-Path $work 'result.json')
if ($LASTEXITCODE -ne 0) { throw 'Native source build failed' }
$result = Get-Content (Join-Path $work 'result.json') | ConvertFrom-Json
node --input-type=module -e "import {verifyPE} from './scripts/verify-release.mjs'; verifyPE(process.argv[1])" $result.path
if ($LASTEXITCODE -ne 0) { throw 'Native Setup PE validation failed' }
if ((Get-FileHash $result.path -Algorithm SHA256).Hash.ToLower() -ne $result.manifest.sha256) { throw 'Native manifest hash mismatch' }
$install = Join-Path $work 'installed'
$p = Start-Process $result.path -ArgumentList @('/S', "/D=$install") -Wait -PassThru
if ($p.ExitCode -ne 0) { throw 'Native fixture installation failed' }
$exe = Join-Path $install 'AemNativeFixture.exe'
if (!(Test-Path $exe)) { throw 'Native fixture executable missing' }
$marker = Join-Path $work 'native-window.txt'
$p = Start-Process $exe -ArgumentList @('--smoke-file', "`"$marker`"") -PassThru
if (!$p.WaitForExit(30000)) { Stop-Process -Id $p.Id -Force; throw 'Native application launch timed out' }
if (!(Test-Path $marker) -or (Get-Content $marker) -ne 'native-window-shown') { throw 'Native Windows form did not show' }
$link = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AEM Native Fixture.lnk'
if (!(Test-Path $link)) { throw 'Native Start Menu entry missing' }
$registration = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.aem.pipelinefixture.windows'
if ($registration.DisplayVersion -ne '1.0.0') { throw 'Native uninstall registration missing' }
node -e "const assert=require('assert/strict'); const {getNativeInstallations,nativeUpdateState}=require('./dist-electron/native-registry.js'); getNativeInstallations('com.aem.pipelinefixture.windows').then(r=>{assert.equal(r.length,1);assert.equal(r[0].version,'1.0.0');assert.equal(r[0].installLocation,process.argv[1]);assert.equal(nativeUpdateState(r,'1.0.0'),'current');assert.equal(nativeUpdateState(r,'1.0.1'),'update');assert.equal(nativeUpdateState(r,'0.9.0'),'newer-installed')}).catch(e=>{console.error(e);process.exit(1)})" $install
if ($LASTEXITCODE -ne 0) { throw 'Native registry and version detection failed' }
$p = Start-Process (Join-Path $install 'Uninstall.exe') -ArgumentList @('/S', "_?=$install") -Wait -PassThru
if ($p.ExitCode -ne 0 -or (Test-Path $exe) -or (Test-Path $link)) { throw 'Native fixture uninstall failed' }
node -e "const assert=require('assert/strict');require('./dist-electron/native-registry.js').getNativeInstallations('com.aem.pipelinefixture.windows').then(r=>assert.equal(r.length,0)).catch(e=>{console.error(e);process.exit(1)})"
if ($LASTEXITCODE -ne 0) { throw 'Native registry still reports uninstalled fixture' }
Write-Host '::notice title=Native source route smoke::Repository-owned WinForms test source built, NSIS Setup verified, installed, native window shown, Start Menu/registration, real installed-version and update/downgrade comparison checked and uninstalled. This is not a third-party Android port.'
