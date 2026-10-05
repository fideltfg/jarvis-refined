param(
    [ValidateSet('Install', 'EnableWsl', 'Launch', 'KeepAlive', 'Stop', 'Status', 'Configure', 'Detach', 'RemoveData')]
    [string]$Action = 'Install',
    [string]$InstallDir = $PSScriptRoot,
    [switch]$ConfirmRemoveData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Distro = 'JarvisRefined'
$DataDir = Join-Path $env:LOCALAPPDATA 'JarvisRefined'
$DistroDir = Join-Path $DataDir 'wsl'
$StateFile = Join-Path $DataDir 'state.json'
$RelayFile = Join-Path $DataDir 'relay.json'
$TaskPrefix = 'JarvisRefined'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$installLock = $null
$Step = 'Initializing setup'
$LogFile = Join-Path $DataDir "$Action.log"
$ErrorFile = Join-Path $DataDir "$Action-error.txt"

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

function Get-ManagedDistro {
    $keys = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue
    foreach ($key in $keys) {
        $entry = Get-ItemProperty $key.PSPath
        if ($entry.DistributionName -eq $Distro) {
            $path = ([string]$entry.BasePath) -replace '^\\\\\?\\', ''
            if ([IO.Path]::GetFullPath($path).TrimEnd('\') -ne [IO.Path]::GetFullPath($DistroDir).TrimEnd('\')) {
                throw 'A distro named JarvisRefined exists outside the managed data directory. It will not be changed.'
            }
            return $true
        }
    }
    return $false
}

function Invoke-Provision {
    param([string[]]$Arguments, [switch]$Capture)
    $windowsPath = Join-Path $InstallDir 'installer\provision.sh'
    $linuxPath = Invoke-Wsl -Arguments @('-d', $Distro, '-u', 'root', '--exec', 'wslpath', '-a', '-u', $windowsPath) -Capture
    return Invoke-Wsl -Arguments (@('-d', $Distro, '-u', 'root', '--exec', 'bash', $linuxPath) + $Arguments) -Capture:$Capture
}

function Protect-File {
    param([string]$Path)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls.exe $Path '/inheritance:r' '/grant:r' "*$($sid):(F)" '*S-1-5-18:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect the browser relay credential file.' }
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
        if ($ConfirmRemoveData) { $nativeArguments += '-ConfirmRemoveData' }
        & $NativePowerShell @nativeArguments
        exit $LASTEXITCODE
    }
    if ($Action -eq 'Install') {
        New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
        $installLock = [IO.File]::Open((Join-Path $DataDir '.install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        Remove-Item -LiteralPath $ErrorFile -Force -ErrorAction SilentlyContinue
    }
    Set-SetupStep 'Checking installer state'
    if ($Action -eq 'EnableWsl') {
        Set-SetupStep 'Enabling Windows WSL prerequisites'
        $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'WSL prerequisites require administrator approval.' }
        $restart = $false
        foreach ($feature in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
            $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
            $restart = $restart -or $result.RestartNeeded
        }
        if ($restart) { exit 3010 }
        Set-SetupStep 'Updating the Microsoft WSL package'
        Invoke-Wsl -Arguments @('--update')
        exit 0
    }

    $state = $null
    if (Test-Path -LiteralPath $StateFile) {
        $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        if ($state.schema -ne 1 -or $state.product -ne 'jarvis-refined') { throw 'Unrecognized Jarvis installer state; no distro changes were made.' }
    }

    if ($Action -eq 'Detach' -or $Action -eq 'RemoveData' -or $Action -eq 'Stop') {
        foreach ($suffix in @('Runtime', 'Relay')) {
            Stop-ScheduledTask -TaskName "$TaskPrefix-$suffix" -ErrorAction SilentlyContinue
            if ($Action -ne 'Stop') {
                Unregister-ScheduledTask -TaskName "$TaskPrefix-$suffix" -Confirm:$false -ErrorAction SilentlyContinue
            }
        }
        Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name JarvisRefinedSetup -ErrorAction SilentlyContinue
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
        Set-SetupStep 'Checking Windows compatibility and payload checksums'
        if ([Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This installer targets x64 Windows.' }
        if ([Environment]::OSVersion.Version.Build -lt 19045) { throw 'Windows 10 22H2 (build 19045) or Windows 11 is required.' }
        $manifest = Get-Content (Join-Path $InstallDir 'manifest.json') -Raw | ConvertFrom-Json
        if ($manifest.schema -ne 1 -or $manifest.product -ne 'jarvis-refined' -or $manifest.architecture -ne 'x64' -or -not $manifest.complete) {
            throw 'This is not a complete Windows installer payload.'
        }
        foreach ($name in @('app.tar.gz', 'rootfs.tar', 'node-linux.tar.xz', 'node-windows.zip', 'jarvis-relay.mjs', 'relay-launcher.mjs')) {
            $expected = $manifest.files.PSObject.Properties[$name].Value
            if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash (Join-Path $InstallDir $name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
                throw "Installer checksum verification failed: $name"
            }
        }
        if (-not $state) {
            if (Get-ManagedDistro) { throw 'A managed distro exists without installer state. Restore state before retrying.' }
            $state = [pscustomobject]@{ schema = 1; product = 'jarvis-refined'; phase = 'prerequisites'; port = (Find-Port); release = '' }
            Save-State $state
        }
        $needsWsl = -not (Test-Path $Wsl)
        if (-not $needsWsl) {
            Set-SetupStep 'Checking WSL availability'
            $probe = Get-WslResult -Arguments @('--version')
            $needsWsl = $probe.ExitCode -ne 0
            if (-not $needsWsl) {
                $probe = Get-WslResult -Arguments @('--status')
                $needsWsl = $probe.ExitCode -ne 0
            }
            if ($needsWsl) { Write-SetupLog $probe.Output }
        }
        if ($needsWsl) {
            Set-SetupStep 'Requesting administrator approval for WSL prerequisites'
            $resume = '"' + $NativePowerShell + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'installer\bootstrap.ps1') + '" -Action Install -InstallDir "' + $InstallDir + '"'
            New-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Force | Out-Null
            New-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name JarvisRefinedSetup -Value $resume -PropertyType String -Force | Out-Null
            $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'installer\bootstrap.ps1') + '" -Action EnableWsl -InstallDir "' + $InstallDir + '"'
            $elevated = Start-Process $NativePowerShell -Verb RunAs -ArgumentList $arguments -Wait -PassThru
            if ($elevated.ExitCode -eq 3010) {
                Write-Host 'Restart Windows to finish enabling WSL. Jarvis setup will resume at your next sign-in.'
                exit 3010
            }
            if ($elevated.ExitCode -ne 0) { throw 'WSL prerequisite installation failed or administrator approval was cancelled.' }
            Invoke-Wsl -Arguments @('--version')
        }
        if (-not (Get-ManagedDistro)) {
            Set-SetupStep 'Importing the dedicated Jarvis WSL distro'
            $state.phase = 'importing'; Save-State $state
            New-Item -ItemType Directory -Force -Path $DistroDir | Out-Null
            Invoke-Wsl -Arguments @('--import', $Distro, $DistroDir, (Join-Path $InstallDir 'rootfs.tar'), '--version', '2')
        }
        if ($state.phase -ne 'ready' -and $state.phase -ne 'installing') {
            Set-SetupStep 'Preparing Ubuntu and the Jarvis Linux user'
            Invoke-Provision -Arguments @('prepare')
            $state.phase = 'prepared'; Save-State $state
            Invoke-Wsl -Arguments @('--terminate', $Distro)
        }
        $linuxPayload = Invoke-Wsl -Arguments @('-d', $Distro, '-u', 'root', '--exec', 'wslpath', '-a', '-u', $InstallDir) -Capture
        $hash = $manifest.files.PSObject.Properties['app.tar.gz'].Value
        $state.phase = 'installing'; Save-State $state
        Set-SetupStep 'Installing and checking Linux application services'
        Invoke-Provision -Arguments @('install', $linuxPayload, $hash, [string]$state.port)
        Set-SetupStep 'Installing the Windows Node runtime'
        $runtime = Join-Path $InstallDir 'runtime'
        $extract = Join-Path $InstallDir 'runtime-staging'
        if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $extract | Out-Null
        Expand-Archive -LiteralPath (Join-Path $InstallDir 'node-windows.zip') -DestinationPath $extract -Force
        $nodes = @(Get-ChildItem -LiteralPath $extract -Filter node.exe -Recurse)
        if ($nodes.Count -ne 1) { throw 'Expected exactly one Node executable in the Windows runtime archive.' }
        New-Item -ItemType Directory -Force -Path $runtime | Out-Null
        Copy-Item -LiteralPath $nodes[0].FullName -Destination (Join-Path $runtime 'node.exe')
        Remove-Item -LiteralPath $extract -Recurse -Force
        & (Join-Path $runtime 'node.exe') -e 'if(process.platform!=="win32"||process.arch!=="x64"||+process.versions.node.split(".")[0]<22)process.exit(1)'
        if ($LASTEXITCODE -ne 0) { throw 'A compatible Windows Node runtime is required.' }
        Set-SetupStep 'Configuring browser relay credentials'
        $token = Invoke-Provision -Arguments @('relay-token') -Capture
        if ($token -notmatch '^[a-f0-9]{48}$') { throw 'Invalid relay credential from the managed distro.' }
        if (-not (Test-Path -LiteralPath $RelayFile)) { New-Item -ItemType File -Path $RelayFile -Force | Out-Null }
        Protect-File $RelayFile
        [IO.File]::WriteAllText($RelayFile, (@{ url = "ws://127.0.0.1:$($state.port)/bridge/relay"; token = $token } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $script = Join-Path $InstallDir 'installer\bootstrap.ps1'
        Set-SetupStep 'Registering per-user startup tasks'
        Register-UserTask -Suffix Runtime -Executable $NativePowerShell -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -Action KeepAlive -InstallDir "' + $InstallDir + '"')
        Register-UserTask -Suffix Relay -Executable (Join-Path $runtime 'node.exe') -Arguments ('"' + (Join-Path $InstallDir 'relay-launcher.mjs') + '" "' + $RelayFile + '"')
        Set-SetupStep 'Checking Windows localhost connectivity'
        Wait-Ready $state.port
        $state.phase = 'ready'; $state.release = $hash; Save-State $state
        Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name JarvisRefinedSetup -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName "$TaskPrefix-Runtime"
        Start-ScheduledTask -TaskName "$TaskPrefix-Relay"
        Start-Process "http://localhost:$($state.port)"
        Write-Host 'Jarvis installed in read-only mode. Configure your provider and browser extension before enabling actions.'
        exit 0
    }

    if (-not $state -or $state.phase -ne 'ready' -or -not (Get-ManagedDistro)) { throw 'Complete Jarvis setup first.' }
    switch ($Action) {
        'Launch' {
            Start-ScheduledTask -TaskName "$TaskPrefix-Runtime"
            Start-ScheduledTask -TaskName "$TaskPrefix-Relay"
            Wait-Ready $state.port
            Start-Process "http://localhost:$($state.port)"
        }
        'KeepAlive' {
            while ($true) {
                Invoke-Provision -Arguments @('start')
                & $Wsl -d $Distro -u jarvis --exec sleep infinity
                Start-Sleep -Seconds 5
            }
        }
        'Status' {
            Write-Host "Jarvis phase: $($state.phase); interface: http://localhost:$($state.port)"
            Invoke-Provision -Arguments @('status')
            Wait-Ready $state.port
        }
        'Configure' { & $Wsl -d $Distro -u jarvis --cd /opt/jarvis-refined/current }
    }
} catch {
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
    if ($installLock) { $installLock.Dispose() }
}