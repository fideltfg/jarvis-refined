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