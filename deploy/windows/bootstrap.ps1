param(
    [ValidateSet('CheckPrerequisites', 'Install', 'Launch', 'KeepAlive', 'Relay', 'Stop', 'Status', 'Configure', 'Detach', 'RemoveData')]
    [string]$Action = 'Install',
    [string]$InstallDir = $PSScriptRoot,
    [string]$SessionId = '',
    [string]$ProgressFile = '',
    [switch]$ConfirmRemoveData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Distro = 'Ubuntu-24.04'
$DataDir = Join-Path $env:LOCALAPPDATA 'JarvisRefined'
$StateFile = Join-Path $DataDir 'state.json'
$RelayFile = Join-Path $DataDir 'relay.json'
$TaskPrefix = 'JarvisRefined'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$Step = 'Checking setup'
$LogFile = Join-Path $DataDir "$Action.log"
$ErrorFile = Join-Path $DataDir "$Action-error.txt"
$installLock = $null
$InstallExitCode = 1

function Get-NativeSystemDirectory {
    param(
        [string]$WindowsDirectory = $env:WINDIR,
        [bool]$OperatingSystem64 = [Environment]::Is64BitOperatingSystem,
        [bool]$Process64 = [Environment]::Is64BitProcess
    )
    if ($OperatingSystem64 -and -not $Process64) { return Join-Path $WindowsDirectory 'Sysnative' }
    return Join-Path $WindowsDirectory 'System32'
}

$NativeSystemDirectory = Get-NativeSystemDirectory
$Wsl = Join-Path $NativeSystemDirectory 'wsl.exe'
$NativePowerShell = Join-Path $NativeSystemDirectory 'WindowsPowerShell\v1.0\powershell.exe'

function Protect-DiagnosticText {
    param([string]$Text)
    $Text = $Text -replace '(?i)\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)[^\s]+', '$1[REDACTED]'
    $Text = $Text -replace '(?i)Bearer\s+[^\s]+', 'Bearer [REDACTED]'
    $Text = $Text -replace '\bsk-[A-Za-z0-9_-]+', '[REDACTED]'
    return $Text -replace '(?i)\b[a-f0-9]{48,}\b', '[REDACTED]'
}

function Protect-File {
    param([string]$Path)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path '/inheritance:r' '/grant:r' "*$($sid):(F)" '*S-1-5-18:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the setup log or browser relay credentials.' }
}

function Write-SetupLog {
    param([string]$Text)
    try {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        if (-not (Test-Path -LiteralPath $LogFile)) {
            New-Item -ItemType File -Path $LogFile | Out-Null
            Protect-File $LogFile
        }
        $line = '{0:u} [{1}] {2}' -f [DateTime]::UtcNow, $Action, (Protect-DiagnosticText $Text)
        [IO.File]::AppendAllText($LogFile, "$line`r`n", [Text.UTF8Encoding]::new($false))
        if ($ProgressFile) { [IO.File]::AppendAllText($ProgressFile, "$line`r`n", [Text.UTF8Encoding]::new($false)) }
    } catch { }
}

function Set-SetupStep {
    param([string]$Name)
    $script:Step = $Name
    Write-Host "Jarvis setup: $Name"
    Write-SetupLog $Name
}

function Get-WslResult {
    param([string[]]$Arguments, [switch]$Stream)
    $previousPreference = $ErrorActionPreference
    $lines = [Collections.Generic.List[string]]::new()
    try {
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        & $Wsl @Arguments 2>&1 | ForEach-Object {
            $line = ([string]$_) -replace "`0", ''
            $lines.Add($line)
            if ($Stream -and $line.Trim()) {
                $safe = Protect-DiagnosticText $line
                Write-Host $safe
                Write-SetupLog $safe
            }
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ ExitCode = $code; Output = ($lines -join "`n").Trim() }
}

function Test-WslVersionSupport {
    param($Result)
    return $Result.ExitCode -eq 0 -and $Result.Output -match '(?im)^WSL version:\s*\d+'
}

function Get-NodeMajorVersion {
    param([string]$Version)
    $major = 0
    if ($Version -match '^v?(\d+)\.') { [void][int]::TryParse($Matches[1], [ref]$major) }
    return $major
}

function Get-WslDistributionNames {
    $result = Get-WslResult -Arguments @('--list', '--quiet')
    if ($result.ExitCode -ne 0) { return @() }
    return @($result.Output -split "`r?`n" | ForEach-Object { $_.Trim().TrimStart('*').Trim() } | Where-Object { $_ })
}

function Test-WslDistributionExists {
    return (Get-WslDistributionNames) -contains $Distro
}

function Test-WslDistributionV2 {
    $result = Get-WslResult -Arguments @('--list', '--verbose')
    if ($result.ExitCode -ne 0) { return $false }
    foreach ($line in ($result.Output -split "`r?`n")) {
        if ($line -match ('^\s*\*?\s*' + [regex]::Escape($Distro) + '\s+.+\s+2\s*$')) { return $true }
    }
    return $false
}

function Get-ManagedDistro {
    if (-not (Test-Path -LiteralPath $StateFile)) { return $false }
    $savedState = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
    if ($savedState.product -ne 'jarvis-refined' -or
        -not ($savedState.PSObject.Properties.Name -contains 'distro') -or
        $savedState.distro -ne $Distro) { return $false }
    return Test-WslDistributionExists
}

function Test-InstallPrerequisites {
    Set-SetupStep 'Checking WSL2, dedicated Ubuntu 24.04, and Node prerequisites'
    $wslVersion = Get-WslResult -Arguments @('--version')
    if (-not (Test-WslVersionSupport $wslVersion)) {
        throw 'Current WSL is required before installing Jarvis. In Administrator PowerShell run: wsl --install --no-distribution; restart Windows if requested.'
    }
    if (-not (Test-WslDistributionExists)) {
        throw "The dedicated Ubuntu 24.04 WSL distro '$Distro' is required. Install it with 'wsl --install --distribution Ubuntu-24.04', launch it once, and use it only for Jarvis. Do not select a personal distro."
    }
    if (-not (Test-WslDistributionV2)) {
        throw "The dedicated distro '$Distro' must use WSL2. Convert it with 'wsl --set-version Ubuntu-24.04 2' and rerun setup."
    }
    $windowsNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $windowsNode) { throw 'Install Node.js 22 or newer for Windows (Node 24 LTS recommended) and ensure node.exe is on PATH before running setup.' }
    $windowsVersionOutput = & $windowsNode.Source --version
    $windowsNodeExit = $LASTEXITCODE
    $windowsVersion = ($windowsVersionOutput | Out-String).Trim()
    if ($windowsNodeExit -ne 0 -or (Get-NodeMajorVersion $windowsVersion) -lt 22) {
        throw "Windows Node.js 22 or newer is required; found '$windowsVersion'."
    }
    $linuxVersion = Get-WslResult -Arguments @('-d', $Distro, '-u', 'root', '--exec', 'node', '--version')
    if ($linuxVersion.ExitCode -ne 0 -or (Get-NodeMajorVersion $linuxVersion.Output) -lt 22) {
        throw "Node.js 22 or newer must be installed system-wide inside WSL distro $Distro before setup."
    }
    return $windowsNode.Source
}

function Invoke-Wsl {
    param([string[]]$Arguments, [switch]$Capture)
    $result = Get-WslResult -Arguments $Arguments -Stream:(-not $Capture)
    if ($result.ExitCode -ne 0) {
        $detail = Protect-DiagnosticText $result.Output
        if ($detail.Length -gt 4000) { $detail = $detail.Substring($detail.Length - 4000) }
        throw "WSL operation failed (exit $($result.ExitCode)): $detail"
    }
    if ($Capture) { return $result.Output }
}

function Save-State {
    param($State)
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $temporary = "$StateFile.tmp"
    $State | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $StateFile -Force
}

function Invoke-Provision {
    param([string[]]$Arguments, [switch]$Capture)
    $windowsPath = Join-Path $InstallDir 'installer\provision.sh'
    $linuxPath = Invoke-Wsl -Arguments @('-d', $Distro, '-u', 'root', '--exec', 'wslpath', '-a', '-u', $windowsPath) -Capture
    return Invoke-Wsl -Arguments (@('-d', $Distro, '-u', 'root', '--exec', 'bash', $linuxPath) + $Arguments) -Capture:$Capture
}

function Register-UserTask {
    param([string]$Suffix, [string]$Executable, [string]$Arguments)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $taskAction = New-ScheduledTaskAction -Execute $Executable -Argument $Arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName "$TaskPrefix-$Suffix" -Action $taskAction -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
}

function Remove-SetupResumeTask {
    Unregister-ScheduledTask -TaskName "$TaskPrefix-Resume" -Confirm:$false -ErrorAction SilentlyContinue
}

function Wait-Ready {
    param([int]$Port)
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:$Port/bridge/health" -TimeoutSec 2
            if ($health.ok) {
                $face = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
                if ($face.StatusCode -eq 200) { return }
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw 'Jarvis did not become reachable through Windows localhost. Run Diagnostics; WSL forwarding or a port conflict may be responsible.'
}

function Find-Port {
    for ($port = 5173; $port -le 5199; $port++) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start(); return $port } catch { } finally { $listener.Stop() }
    }
    throw 'No free Jarvis frontend port was found between 5173 and 5199.'
}

try {
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        Set-SetupStep 'Switching to native 64-bit PowerShell'
        $nativeArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
            '-Action', $Action, '-InstallDir', $InstallDir)
        if ($SessionId) { $nativeArguments += @('-SessionId', $SessionId) }
        if ($ProgressFile) { $nativeArguments += @('-ProgressFile', $ProgressFile) }
        if ($ConfirmRemoveData) { $nativeArguments += '-ConfirmRemoveData' }
        & $NativePowerShell @nativeArguments
        exit $LASTEXITCODE
    }
    if ($Action -eq 'Install') {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        $installLock = [IO.File]::Open((Join-Path $DataDir '.install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        Remove-Item -LiteralPath $ErrorFile -Force -ErrorAction SilentlyContinue
        Remove-SetupResumeTask
    }
    Set-SetupStep 'Checking installer state'
    if ($Action -eq 'CheckPrerequisites') {
        $windowsNodePath = Test-InstallPrerequisites
        Write-Host "Prerequisites ready: WSL2, $Distro, Windows Node $windowsNodePath, and Linux Node."
        exit 0
    }
    $state = $null
    if (Test-Path -LiteralPath $StateFile) {
        $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        if ($state.schema -ne 1 -or $state.product -ne 'jarvis-refined') { throw 'Unrecognized Jarvis installer state; no distro changes were made.' }
    }
    if ($Action -eq 'Detach' -or $Action -eq 'RemoveData' -or $Action -eq 'Stop') {
        foreach ($suffix in @('Runtime', 'Relay', 'Resume')) {
            Stop-ScheduledTask -TaskName "$TaskPrefix-$suffix" -ErrorAction SilentlyContinue
            if ($Action -ne 'Stop') {
                Unregister-ScheduledTask -TaskName "$TaskPrefix-$suffix" -Confirm:$false -ErrorAction SilentlyContinue
            }
        }
        if ($Action -ne 'Stop' -and (Test-Path -LiteralPath $RelayFile)) { Remove-Item -LiteralPath $RelayFile -Force }
        if (Get-ManagedDistro) {
            Invoke-Provision -Arguments @('stop')
            Invoke-Wsl -Arguments @('--terminate', $Distro)
            if ($Action -eq 'RemoveData') {
                if (-not $ConfirmRemoveData) { throw 'Data deletion requires -ConfirmRemoveData. Saved data has not been deleted.' }
                Invoke-Wsl -Arguments @('--unregister', $Distro)
                Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Host 'Jarvis stopped. WSL data is retained unless RemoveData was explicitly confirmed.'
        exit 0
    }
    if ($Action -eq 'Install') {
        Set-SetupStep 'Checking Windows compatibility and installer files'
        if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This installer targets x64 Windows.' }
        if ([Environment]::OSVersion.Version.Build -lt 19045) { throw 'Windows 10 22H2 (build 19045) or Windows 11 is required.' }
        $manifest = Get-Content (Join-Path $InstallDir 'manifest.json') -Raw | ConvertFrom-Json
        if ($manifest.schema -ne 1 -or $manifest.product -ne 'jarvis-refined' -or $manifest.architecture -ne 'x64' -or -not $manifest.complete) { throw 'This is not a complete Windows installer payload.' }
        foreach ($name in @('app.tar.gz', 'jarvis-relay.mjs', 'relay-launcher.mjs')) {
            $expected = $manifest.files.PSObject.Properties[$name].Value
            if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash (Join-Path $InstallDir $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
                throw "Installer checksum verification failed: $name"
            }
        }
        $windowsNodePath = Test-InstallPrerequisites
        $distributionPrerequisites = @($manifest.prerequisites | Where-Object { $_.id -eq 'linuxDistribution' })
        if ($distributionPrerequisites.Count -ne 1 -or $distributionPrerequisites[0].name -ne $Distro) { throw 'The installer prerequisite distribution is not supported.' }
        if (-not $state) {
            $state = [pscustomobject]@{ schema = 1; product = 'jarvis-refined'; distro = $Distro; windowsNodePath = $windowsNodePath; phase = 'prerequisites'; port = (Find-Port); release = '' }
        } else {
            $state.distro = $Distro
            $state.windowsNodePath = $windowsNodePath
        }
        Save-State $state
        if (-not (Test-WslDistributionExists)) { throw "The required WSL distro $Distro is no longer registered." }
        if ($state.phase -ne 'ready' -and $state.phase -ne 'installing') {
            Set-SetupStep 'Preparing the dedicated Ubuntu distro for Jarvis'
            Invoke-Provision -Arguments @('prepare')
            $state.phase = 'prepared'; Save-State $state
            Invoke-Wsl -Arguments @('--terminate', $Distro)
        }
        $linuxPayload = Invoke-Wsl -Arguments @('-d', $Distro, '-u', 'root', '--exec', 'wslpath', '-a', '-u', $InstallDir) -Capture
        $hash = $manifest.files.PSObject.Properties['app.tar.gz'].Value
        $state.phase = 'installing'; Save-State $state
        Set-SetupStep 'Installing and checking Linux application services'
        Invoke-Provision -Arguments @('install', $linuxPayload, $hash, [string]$state.port)
        Set-SetupStep 'Configuring browser relay credentials'
        $token = Invoke-Provision -Arguments @('relay-token') -Capture
        if ($token -notmatch '^[a-f0-9]{48}$') { throw 'Invalid relay credential from the managed distro.' }
        if (-not (Test-Path -LiteralPath $RelayFile)) { New-Item -ItemType File -Path $RelayFile -Force | Out-Null }
        Protect-File $RelayFile
        [IO.File]::WriteAllText($RelayFile, (@{ url = "ws://127.0.0.1:$($state.port)/bridge/relay"; token = $token } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $script = Join-Path $InstallDir 'installer\bootstrap.ps1'
        Set-SetupStep 'Registering per-user startup tasks'
        Register-UserTask -Suffix Runtime -Executable $NativePowerShell -Arguments ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '" -Action KeepAlive -InstallDir "' + $InstallDir + '"')
        Register-UserTask -Suffix Relay -Executable $NativePowerShell -Arguments ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '" -Action Relay -InstallDir "' + $InstallDir + '"')
        Set-SetupStep 'Checking Windows localhost connectivity'
        Wait-Ready $state.port
        $state.phase = 'ready'; $state.release = $hash; Save-State $state
        Remove-SetupResumeTask
        Start-ScheduledTask -TaskName "$TaskPrefix-Runtime"
        Start-ScheduledTask -TaskName "$TaskPrefix-Relay"
        Start-Process "http://localhost:$($state.port)"
        Write-Host 'Jarvis installed in read-only mode. Configure your provider and browser extension before enabling actions.'
        $InstallExitCode = 0
        exit 0
    }
    if (-not $state -or $state.phase -ne 'ready' -or -not (Get-ManagedDistro)) { throw 'Complete Jarvis setup first.' }
    switch ($Action) {
        'Launch' { Start-ScheduledTask -TaskName "$TaskPrefix-Runtime"; Start-ScheduledTask -TaskName "$TaskPrefix-Relay"; Wait-Ready $state.port; Start-Process "http://localhost:$($state.port)" }
        'KeepAlive' { while ($true) { Invoke-Provision -Arguments @('start'); & $Wsl -d $Distro -u jarvis --exec sleep infinity; Start-Sleep -Seconds 5 } }
        'Relay' {
            $node = $state.windowsNodePath
            $launcher = Join-Path $InstallDir 'relay-launcher.mjs'
            $stdout = Join-Path $DataDir 'relay.log'; $stderr = Join-Path $DataDir 'relay-error.log'
            while ($true) {
                foreach ($log in @($stdout, $stderr)) { if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) { Remove-Item -LiteralPath $log -Force } }
                Start-Process -FilePath $node -ArgumentList ('"' + $launcher + '" "' + $RelayFile + '"') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
                Start-Sleep -Seconds 5
            }
        }
        'Status' { Write-Host "Jarvis phase: $($state.phase); interface: http://localhost:$($state.port)"; Invoke-Provision -Arguments @('status'); Wait-Ready $state.port }
        'Configure' { & $Wsl -d $Distro -u jarvis --cd /opt/jarvis-refined/current }
    }
} catch {
    $InstallExitCode = 1
    if ($Action -eq 'Install') { Remove-SetupResumeTask }
    $failure = Protect-DiagnosticText "Jarvis failed during: $Step`r`n$($_.Exception.Message)`r`nLog: $LogFile"
    Write-SetupLog $failure
    try {
        if (-not (Test-Path -LiteralPath $ErrorFile)) { New-Item -ItemType File -Path $ErrorFile | Out-Null }
        Protect-File $ErrorFile
        [IO.File]::WriteAllText($ErrorFile, $failure, [Text.UTF8Encoding]::new($false))
    } catch { }
    Write-Error $failure -ErrorAction Continue
    exit 1
} finally {
    if ($Action -eq 'Install' -and $SessionId -and $ProgressFile) {
        try {
            $resultPath = Join-Path (Split-Path -Parent $ProgressFile) "Install-$SessionId.result"
            [IO.File]::WriteAllText($resultPath, [string]$InstallExitCode, [Text.UTF8Encoding]::new($false))
        } catch { }
    }
    if ($installLock) { $installLock.Dispose() }
}
