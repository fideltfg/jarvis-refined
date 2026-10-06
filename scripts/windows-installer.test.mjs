import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import http from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { relayEnvironment } from '../deploy/windows/relay-launcher.mjs'
import { spawn, spawnSync } from 'node:child_process'

test('root provisioning selects the service user bus for every user command', {
  skip: !process.env.JARVIS_TEST_DOCKER,
}, () => {
  const source = readFileSync('deploy/windows/provision.sh', 'utf8')
  const helper = /^run_as_owner\(\) \{[\s\S]*?^\}/m.exec(source)?.[0]
  assert.ok(helper)
  assert.equal((source.match(/runuser -u/g) ?? []).length, 1)
  const command = `set -Eeuo pipefail
    useradd --create-home --shell /bin/bash jarvis
    OWNER=jarvis
    export HOME=/root USER=root XDG_RUNTIME_DIR=/run/user/0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus
    ${helper}
    expected_uid=$(id -u jarvis)
    expected_bus="unix:path=/run/user/$expected_uid/bus"
    run_as_owner bash -c 'test "$(id -un)" = jarvis && test "$HOME" = /home/jarvis && test "$USER" = jarvis && test "$XDG_RUNTIME_DIR" = "/run/user/$(id -u)" && test "$DBUS_SESSION_BUS_ADDRESS" = "unix:path=/run/user/$(id -u)/bus"'
    test "$(run_as_owner printenv DBUS_SESSION_BUS_ADDRESS)" = "$expected_bus"
    test "$DBUS_SESSION_BUS_ADDRESS" = unix:path=/run/user/0/bus
  `
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '-i', '--entrypoint', '/bin/bash',
    process.env.JARVIS_TEST_DOCKER, '-s'], { input: command, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('WSL provisioning repairs root-owned config parents without changing existing files', {
  skip: !process.env.JARVIS_TEST_DOCKER,
}, () => {
  const source = readFileSync('deploy/windows/provision.sh', 'utf8')
  const start = source.indexOf('    CONF_DIR="/home/$OWNER/.config/jarvis"')
  const end = source.indexOf('    if [[ ! -f $CONF_DIR/service.env ]]; then', start)
  assert.ok(start >= 0 && end > start)
  const command = `set -Eeuo pipefail
    umask 077
    useradd --create-home --shell /bin/bash jarvis
    OWNER=jarvis
    install -d -m 700 -o jarvis -g jarvis /home/jarvis/.config/jarvis
    touch /home/jarvis/.config/jarvis/service.env
    chown jarvis:jarvis /home/jarvis/.config/jarvis/service.env
    chmod 600 /home/jarvis/.config/jarvis/service.env
    test "$(stat -c %U /home/jarvis/.config)" = root
    if runuser -u jarvis -- mkdir /home/jarvis/.config/systemd; then exit 1; fi
    ${source.slice(start, end)}
    runuser -u jarvis -- mkdir -p /home/jarvis/.config/systemd/user
    runuser -u jarvis -- touch /home/jarvis/.config/systemd/user/test.service
    for directory in /home/jarvis/.config /home/jarvis/.config/jarvis /home/jarvis/.config/systemd /home/jarvis/.config/systemd/user; do
      test "$(stat -c %U:%G "$directory")" = jarvis:jarvis
      test "$(stat -c %a "$directory")" = 700
    done
    test "$(stat -c %U:%G:%a /home/jarvis/.config/jarvis/service.env)" = jarvis:jarvis:600
    ${source.slice(start, end)}
    test -f /home/jarvis/.config/systemd/user/test.service
  `
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '-i', '--entrypoint', '/bin/bash',
    process.env.JARVIS_TEST_DOCKER, '-s'], { input: command, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('PowerShell can parse the installer bootstrap', { skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH }, () => {
  const command = "$errors=$null; $tokens=$null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){$errors | Out-String | Write-Output; exit 1}"
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('legacy inbox WSL usage output fails the prerequisite check before installation', {
  skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH,
}, () => {
  const bootstrap = readFileSync('deploy/windows/bootstrap.ps1', 'utf8')
  assert.match(bootstrap, /if \(\$Action -eq 'CheckPrerequisites'\)/)
  assert.doesNotMatch(bootstrap, /--install', '--no-distribution/)
  const command = `
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    $helper=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Test-WslVersionSupport'}
    Invoke-Expression $helper.Extent.Text
    $legacy=[pscustomobject]@{ExitCode=0;Output='Usage: wsl.exe [Argument]' + [Environment]::NewLine + 'Arguments: --install --status'}
    $modern=[pscustomobject]@{ExitCode=0;Output='WSL version: 2.6.0' + [Environment]::NewLine + 'Kernel version: 6.6.0'}
    if(Test-WslVersionSupport $legacy){throw 'Legacy usage text was treated as version support'}
    if(-not (Test-WslVersionSupport $modern)){throw 'Modern WSL version output was rejected'}
    $failed=[pscustomobject]@{ExitCode=1;Output=''}
    if(Test-WslVersionSupport $failed){throw 'Failed WSL probe was treated as supported'}
    $check=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Test-InstallPrerequisites'}
    Invoke-Expression $check.Extent.Text
    function Set-SetupStep {param([string]$Name)}
    function Get-WslResult {param([string[]]$Arguments);return [pscustomobject]@{ExitCode=0;Output='Usage: wsl.exe [Argument]'}}
    $rejected=$false
    try { Test-InstallPrerequisites } catch { $rejected=$_.Exception.Message -match 'Current WSL is required before installing Jarvis' }
    if(-not $rejected){throw 'Prerequisite check did not explain how to update inbox WSL'}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('Ubuntu prerequisite must be registered as WSL2', {
  skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH,
}, () => {
  const command = `
    $ErrorActionPreference='Stop'
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    $helper=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Test-WslDistributionV2'}
    Invoke-Expression $helper.Extent.Text
    $Distro='Ubuntu-24.04'
    function Get-WslResult { param([string[]]$Arguments); return [pscustomobject]@{ExitCode=0;Output=$script:MockOutput} }
    $script:MockOutput="NAME STATE VERSION"+[Environment]::NewLine+"Ubuntu-24.04 Stopped 2"
    if(-not (Test-WslDistributionV2)){throw 'WSL2 distro was rejected'}
    $script:MockOutput="NAME STATE VERSION"+[Environment]::NewLine+"Ubuntu-24.04 Stopped 1"
    if(Test-WslDistributionV2){throw 'WSL1 distro was accepted'}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('prerequisite preflight accepts ready runtimes and rejects missing Linux Node', {
  skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH,
}, () => {
  const command = `
    $ErrorActionPreference='Stop'
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    foreach($name in @('Get-NodeMajorVersion','Test-WslVersionSupport','Get-WslDistributionNames','Test-WslDistributionExists','Test-WslDistributionV2','Test-InstallPrerequisites')){
      $helper=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq $name}
      Invoke-Expression $helper.Extent.Text
    }
    $Distro='Ubuntu-24.04'; $Wsl='wsl.exe'
    $script:MockWslVersion='WSL version: 2.6.0'
    $script:MockDistroVersion='2'; $script:MockLinuxNode='v24.21.0'
    function Set-SetupStep { param([string]$Name) }
    function Get-Command { param([string]$Name,[string]$ErrorAction); if($Name -eq 'node.exe'){return [pscustomobject]@{Source=$env:JARVIS_TEST_NATIVE}} }
    function Get-WslResult {
      param([string[]]$Arguments)
      if($Arguments -contains 'node'){return [pscustomobject]@{ExitCode=0;Output=$script:MockLinuxNode}}
      if($Arguments -contains '--verbose'){
        $output="NAME STATE VERSION"+[Environment]::NewLine+"Ubuntu-24.04 Stopped $script:MockDistroVersion"
        return [pscustomobject]@{ExitCode=0;Output=$output}
      }
      if($Arguments -contains '--quiet'){return [pscustomobject]@{ExitCode=0;Output='Ubuntu-24.04'}}
      return [pscustomobject]@{ExitCode=0;Output=$script:MockWslVersion}
    }
    if((Test-InstallPrerequisites) -ne $env:JARVIS_TEST_NATIVE){throw 'Ready prerequisites returned the wrong Windows Node path'}
    $script:MockLinuxNode='v20.19.0'; $rejected=$false
    try { Test-InstallPrerequisites } catch { $rejected=$_.Exception.Message -match 'Node.js 22 or newer must be installed system-wide' }
    if(-not $rejected){throw 'Missing Linux Node was not rejected'}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, JARVIS_TEST_NATIVE: process.execPath },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('install reads the distribution prerequisite from the manifest array under strict mode', {
  skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH,
}, () => {
  const command = `
    $ErrorActionPreference='Stop'
    Set-StrictMode -Version Latest
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    $lookup=$ast.FindAll({param($entry) $entry -is [System.Management.Automation.Language.AssignmentStatementAst] -and $entry.Left.Extent.Text -eq '$distributionPrerequisites'},$true)
    $validation=$ast.FindAll({param($entry) $entry -is [System.Management.Automation.Language.IfStatementAst] -and $entry.Extent.Text.StartsWith('if ($distributionPrerequisites.Count')},$true)
    if($lookup.Count -ne 1 -or $validation.Count -ne 1){throw 'Missing manifest array validation'}
    $Distro='Ubuntu-24.04'
    $manifest='{"prerequisites":[{"id":"wsl","minimumVersion":2},{"id":"linuxDistribution","name":"Ubuntu-24.04","dedicated":true},{"id":"windowsNode","minimumMajor":22},{"id":"linuxNode","minimumMajor":22}]}' | ConvertFrom-Json
    Invoke-Expression $lookup[0].Extent.Text
    Invoke-Expression $validation[0].Extent.Text
    foreach($prerequisites in @('[]','[{"id":"linuxDistribution","name":"OtherDistro"}]','[{"id":"linuxDistribution","name":"Ubuntu-24.04"},{"id":"linuxDistribution","name":"Ubuntu-24.04"}]')){
      $manifest=('{"prerequisites":'+$prerequisites+'}') | ConvertFrom-Json
      $rejected=$false
      try { Invoke-Expression $lookup[0].Extent.Text; Invoke-Expression $validation[0].Extent.Text } catch { $rejected=$_.Exception.Message -eq 'The installer prerequisite distribution is not supported.' }
      if(-not $rejected){throw 'Invalid distribution manifest was not rejected clearly'}
    }
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('full installer uses Program Files and exposes hidden relay/runtime actions', () => {
  const installer = readFileSync('deploy/windows/jarvis.iss', 'utf8')
  const bootstrap = readFileSync('deploy/windows/bootstrap.ps1', 'utf8')
  assert.match(installer, /DefaultDirName=\{autopf\}\\JarvisRefined/)
  assert.match(installer, /PrivilegesRequired=admin/)
  assert.match(installer, /UsePreviousAppDir=no/)
  assert.match(installer, /ExecAsOriginalUser\([^]*ewNoWait/)
  assert.match(installer, /InstallLogMemo\.Lines\.Add/)
  assert.match(installer, /WizardForm\.ProgressGauge\.Position/)
  assert.match(installer, /{commonappdata}\\JarvisRefined.*users-modify/)
  assert.match(installer, /ExecAsOriginalUser\(/)
  assert.match(installer, /RunInstallForOriginalUser/)
  assert.match(installer, /TNewMemo/)
  assert.match(installer, /-Action CheckPrerequisites/)
  assert.match(installer, /ExecAsOriginalUser\([^]*CheckPrerequisites/)
  assert.doesNotMatch(installer, /rootfs\.tar|node-linux\.tar\.xz|node-windows\.zip/)
  assert.match(bootstrap, /ValidateSet\([^\r\n]*'Relay'/)
  assert.match(bootstrap, /Test-InstallPrerequisites/)
  assert.match(bootstrap, /\$state\.windowsNodePath/)
  assert.match(bootstrap, /-WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput/)
  assert.match(bootstrap, /Register-UserTask -Suffix Runtime/)
  assert.match(bootstrap, /Register-UserTask -Suffix Relay/)
  assert.match(bootstrap, /Install-\$SessionId\.result/)
  assert.doesNotMatch(bootstrap, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce/)
})

test('bootstrap resolves the native system directory for both PowerShell architectures', {
  skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH,
}, () => {
  const command = `
    $ErrorActionPreference='Stop'
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    $helper=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Get-NativeSystemDirectory'}
    Invoke-Expression $helper.Extent.Text
    $root=$PWD.Path
    $native=Join-Path $root 'Sysnative'; $normal=Join-Path $root 'System32'
    if((Get-NativeSystemDirectory $root $true $false) -ne $native){throw '32-bit host did not select Sysnative'}
    if((Get-NativeSystemDirectory $root $true $true) -ne $normal){throw '64-bit host did not select System32'}
    if((Get-NativeSystemDirectory $root $false $false) -ne $normal){throw '32-bit OS did not select System32'}
    $outer=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.TryStatementAst]} | Select-Object -First 1
    if($outer.Body.Statements[0].Extent.Text -notmatch 'Is64BitProcess'){throw 'Architecture handoff must happen before acquiring the install lock'}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('Windows Node runtime validation uses PowerShell-safe version arguments', {
  skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH,
}, () => {
  const command = `
    $ErrorActionPreference='Stop'
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    $check=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Test-InstallPrerequisites'}
    $prerequisites=$check.Extent.Text
    if($prerequisites.Contains(' -e ')){throw 'Node check embeds script quotes in a native argument'}
    if(-not $prerequisites.Contains('--version')){throw 'Prerequisite check must use Node --version'}
    if($prerequisites -notmatch 'Ubuntu-24[.]04'){throw 'The dedicated Ubuntu prerequisite is not checked'}
    if($prerequisites -notmatch 'node.*--version'){throw 'The Linux Node prerequisite is not checked'}
    $node=$env:JARVIS_TEST_NATIVE
    $nodeVersionOutput=& $node --version
    $nodeVersionExitCode=$LASTEXITCODE
    $nodeVersion=($nodeVersionOutput | Out-String).Trim()
    $nodeMajor=0
    if($nodeVersion.StartsWith('v')){$nodeVersionParts=$nodeVersion.Substring(1).Split('.');[void][int]::TryParse($nodeVersionParts[0],[ref]$nodeMajor)}
    if($nodeVersionExitCode -ne 0 -or $nodeMajor -lt 22){throw "Supported Node runtime was rejected: [$nodeVersion], exit $nodeVersionExitCode, major $nodeMajor"}
    $oldOutput='v20.19.0'; $oldExit=0; $oldMajor=0
    if($oldOutput.StartsWith('v')){$oldParts=$oldOutput.Substring(1).Split('.');[void][int]::TryParse($oldParts[0],[ref]$oldMajor)}
    if($oldExit -ne 0 -or $oldMajor -lt 22){$rejected=$true}else{$rejected=$false}
    if(-not $rejected){throw 'Old Node runtime was accepted'}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, JARVIS_TEST_NATIVE: process.execPath },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('32-bit Windows PowerShell hands off to 64-bit with arguments and reboot exit code preserved', {
  skip: process.platform !== 'win32',
}, (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-native-handoff-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const command = `
    $ErrorActionPreference='Stop'
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    $helper=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -eq 'Get-NativeSystemDirectory'}
    $outer=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.TryStatementAst]} | Select-Object -First 1
    $handoff=$outer.Body.Statements[0].Extent.Text
    $probe=Join-Path $env:JARVIS_TEST_HANDOFF_ROOT 'probe.ps1'
    $body=@(
      'param([string]$Action,[string]$InstallDir,[switch]$ConfirmRemoveData)',
      $helper.Extent.Text,
      '$NativePowerShell=Join-Path (Get-NativeSystemDirectory) "WindowsPowerShell\\v1.0\\powershell.exe"',
      'function Set-SetupStep {param([string]$Name)}',
      $handoff,
      '[pscustomobject]@{Native=[Environment]::Is64BitProcess; Action=$Action; InstallDir=$InstallDir; Confirm=[bool]$ConfirmRemoveData} | ConvertTo-Json -Compress',
      'exit 3010'
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText($probe,$body)
    $host32=Join-Path $env:WINDIR 'SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe'
    $folder=Join-Path $env:JARVIS_TEST_HANDOFF_ROOT 'install folder with spaces'
    $output=& $host32 -NoProfile -ExecutionPolicy Bypass -File $probe -Action Stop -InstallDir $folder -ConfirmRemoveData
    if($LASTEXITCODE -ne 3010){throw 'Reboot exit code was not propagated'}
    $result=($output | Out-String) | ConvertFrom-Json
    if(-not $result.Native -or $result.Action -ne 'Stop' -or $result.InstallDir -ne $folder -or -not $result.Confirm){throw 'Native architecture or arguments changed'}
  `
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, JARVIS_TEST_HANDOFF_ROOT: directory },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('WSL probes report native errors instead of bypassing exit checks and redact credentials', { skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH }, () => {
  const command = `
    $ErrorActionPreference='Stop'; $PSNativeCommandUseErrorActionPreference=$true
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    foreach($definition in $ast.EndBlock.Statements) {
      if($definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        Invoke-Expression $definition.Extent.Text
      }
    }
    $Wsl=$env:JARVIS_TEST_NATIVE
    $arguments=@('-e','console.error("WSL unavailable");process.exit(7)')
    $result=Get-WslResult -Arguments $arguments
    if($result.ExitCode -ne 7 -or $result.Output -notmatch 'WSL unavailable'){throw 'Native failure was not returned'}
    if($ErrorActionPreference -ne 'Stop' -or -not $PSNativeCommandUseErrorActionPreference){throw 'Caller preferences changed'}
    $caught=$false
    try{Invoke-Wsl -Arguments $arguments -Capture}catch{
      $caught=$true
      if($_.Exception.Message -notmatch 'exit 7' -or $_.Exception.Message -notmatch 'WSL unavailable'){throw 'Native detail lost'}
    }
    if(-not $caught){throw 'Failed WSL operation did not throw'}
    $secret='a'*48
    $redacted=Protect-DiagnosticText "JARVIS_RELAY_TOKEN=$secret Bearer private-token sk-privatekey"
    if($redacted -match $secret -or $redacted -match 'private-token' -or $redacted -match 'sk-privatekey'){throw 'Credential was not redacted'}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, JARVIS_TEST_NATIVE: process.execPath },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('WSL progress streams with redaction while captured output stays private', {
  skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH,
}, (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-wsl-stream-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const command = `
    $ErrorActionPreference='Stop'
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    foreach($definition in $ast.EndBlock.Statements) {
      if($definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {Invoke-Expression $definition.Extent.Text}
    }
    function Protect-File {param([string]$Path)}
    $DataDir=$env:JARVIS_TEST_LOG_ROOT; $Action='Install'; $LogFile=Join-Path $DataDir 'Install.log'
    $Wsl=$env:JARVIS_TEST_NATIVE
    Invoke-Wsl -Arguments @('-e','console.log("Extracting release");console.error("JARVIS_AGENTS_TOKEN=streamsecret")')
    $captured=Invoke-Wsl -Arguments @('-e','console.log("captured-only")') -Capture
    if($captured -ne 'captured-only'){throw 'Captured output changed'}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, JARVIS_TEST_NATIVE: process.execPath, JARVIS_TEST_LOG_ROOT: directory },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const log = readFileSync(join(directory, 'Install.log'), 'utf8')
  assert.match(result.stdout, /Extracting release/)
  assert.match(log, /Extracting release/)
  assert.match(log, /JARVIS_AGENTS_TOKEN=\[REDACTED\]/)
  assert.doesNotMatch(result.stdout + log, /streamsecret|captured-only/)
})

test('installed relay reads its secret from a file and connects only to loopback', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-windows-relay-'))
  const file = join(directory, 'relay.json')
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const token = 'a'.repeat(48)
  writeFileSync(file, JSON.stringify({ url: 'ws://127.0.0.1:5173/bridge/relay', token }))
  assert.deepEqual(relayEnvironment(file), { JARVIS_RELAY_URL: 'ws://127.0.0.1:5173/bridge/relay', JARVIS_RELAY_TOKEN: token })
  for (const url of ['ws://evil.example/bridge/relay', 'ws://127.0.0.1:5173/other',
    'ws://user:password@127.0.0.1:5173/bridge/relay', 'ws://127.0.0.1:5173/bridge/relay?secret=x']) {
    writeFileSync(file, JSON.stringify({ url, token }))
    assert.throws(() => relayEnvironment(file), /local Jarvis/)
  }
  writeFileSync(file, JSON.stringify({ url: 'ws://127.0.0.1:5173/bridge/relay', token: 'invalid' }))
  assert.throws(() => relayEnvironment(file), /token/)
})

test('setup failure persists its step and redacted detail for the installer dialog', { skip: process.platform !== 'win32' && !process.env.JARVIS_TEST_PWSH }, (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-setup-report-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const command = `
    $ErrorActionPreference='Stop'
    $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD 'deploy/windows/bootstrap.ps1'),[ref]$null,[ref]$null)
    foreach($definition in $ast.EndBlock.Statements) {
      if($definition -is [System.Management.Automation.Language.FunctionDefinitionAst]) {Invoke-Expression $definition.Extent.Text}
    }
    function Protect-File {param([string]$Path)}
    function Remove-SetupResumeTask {}
    $DataDir=$env:JARVIS_TEST_LOG_ROOT; $Action='Install'
    $LogFile=Join-Path $DataDir 'Install.log'; $ErrorFile=Join-Path $DataDir 'Install-error.txt'
    $outer=$ast.EndBlock.Statements | Where-Object {$_ -is [System.Management.Automation.Language.TryStatementAst]} | Select-Object -First 1
    $handler=($outer.CatchClauses[0].Body.Statements | ForEach-Object {$_.Extent.Text}) -join [Environment]::NewLine
    Set-SetupStep 'Preparing Ubuntu'
    try {throw 'WSL unavailable PASSWORD=plain-secret OPENAI_API_KEY=another-secret'} catch {Invoke-Expression $handler}
  `
  const result = spawnSync(process.env.JARVIS_TEST_PWSH || 'powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8', env: { ...process.env, JARVIS_TEST_LOG_ROOT: directory },
  })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const report = readFileSync(join(directory, 'Install-error.txt'), 'utf8')
  const log = readFileSync(join(directory, 'Install.log'), 'utf8')
  assert.match(report, /Preparing Ubuntu/)
  assert.match(report, /WSL unavailable/)
  assert.match(report, /Install\.log/)
  assert.doesNotMatch(report + log, /plain-secret|another-secret/)
})

test('installed relay launcher authenticates and carries native-host bytes', { timeout: 10_000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-installed-relay-'))
  const nativePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\jarvis-installer-test-${process.pid}` : join(directory, 'native.sock')
  const nativeSockets = new Set()
  const native = net.createServer((socket) => {
    nativeSockets.add(socket)
    socket.on('data', (data) => socket.write(data))
    socket.on('close', () => nativeSockets.delete(socket))
  })
  const bridge = http.createServer()
  const websocket = new WebSocketServer({ server: bridge })
  let child
  context.after(() => {
    child?.kill()
    for (const client of websocket.clients) client.terminate()
    for (const socket of nativeSockets) socket.destroy()
    websocket.close()
    bridge.close()
    native.close()
    rmSync(directory, { recursive: true, force: true })
  })
  native.listen(nativePath)
  await once(native, 'listening')
  bridge.listen(0, '127.0.0.1')
  await once(bridge, 'listening')
  const token = 'b'.repeat(48)
  const config = join(directory, 'relay.json')
  writeFileSync(config, JSON.stringify({ token, url: `ws://127.0.0.1:${bridge.address().port}/bridge/relay` }))
  copyFileSync('deploy/windows/relay-launcher.mjs', join(directory, 'relay-launcher.mjs'))
  copyFileSync('public/jarvis-relay.mjs', join(directory, 'jarvis-relay.mjs'))
  const frame = Buffer.alloc(8)
  frame.writeUInt32LE(7, 0)
  frame.write('ping', 4)
  const exchange = new Promise((done, fail) => {
    websocket.on('connection', (socket) => {
      socket.on('message', (data, binary) => {
        if (binary) { done(Buffer.from(data)); return }
        const message = JSON.parse(data.toString())
        if (message.type === 'hello') {
          if (message.token !== token) { fail(new Error('Installed relay used the wrong token')); return }
          socket.send(JSON.stringify({ type: 'ready' }))
          socket.send(JSON.stringify({ type: 'open', id: 7 }))
        } else if (message.type === 'opened') socket.send(frame)
        else if (message.type === 'failed') fail(new Error(message.error))
      })
    })
  })
  child = spawn(process.execPath, [join(directory, 'relay-launcher.mjs'), config], {
    env: { ...process.env, JARVIS_RELAY_SOCKET: nativePath }, stdio: 'ignore',
  })
  assert.deepEqual(await exchange, frame)
})