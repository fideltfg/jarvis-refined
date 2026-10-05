#ifndef PayloadDir
  #error Supply /DPayloadDir with the complete package:windows output directory.
#endif
#ifndef ReleaseVersion
  #define ReleaseVersion "0.0.0"
#endif

[Setup]
AppId={{B6365DF4-77B1-4BC9-9C36-7D57E9B1A791}
#ifdef RepairOnly
AppName=Jarvis Refined Setup Repair
Uninstallable=no
#else
AppName=Jarvis Refined
#endif
AppVersion={#ReleaseVersion}
DefaultDirName={localappdata}\Programs\JarvisRefined
DefaultGroupName=Jarvis Refined
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0.19045
OutputDir={#PayloadDir}\output
#ifdef RepairOnly
OutputBaseFilename=JarvisRefined-Repair-{#ReleaseVersion}-x64
#else
OutputBaseFilename=JarvisRefined-Setup-{#ReleaseVersion}-x64
#endif
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
UninstallDisplayName=Jarvis Refined (keeps WSL data)

[Files]
Source: "{#PayloadDir}\installer\bootstrap.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "{#PayloadDir}\installer\provision.sh"; DestDir: "{app}\installer"; Flags: ignoreversion
#ifndef RepairOnly
Source: "{#PayloadDir}\app.tar.gz"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\rootfs.tar"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\node-linux.tar.xz"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\node-windows.zip"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\manifest.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\jarvis-relay.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\relay-launcher.mjs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Jarvis Refined"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Launch -InstallDir ""{app}"""
Name: "{group}\Stop Jarvis"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Stop -InstallDir ""{app}"""
Name: "{group}\Jarvis Diagnostics"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Status -InstallDir ""{app}"""
Name: "{group}\Configure Jarvis"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Configure -InstallDir ""{app}"""
Name: "{autodesktop}\Jarvis Refined"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Launch -InstallDir ""{app}"""

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Detach -InstallDir ""{app}"""; Flags: runhidden waituntilterminated

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\runtime-staging"
#endif

[Code]
function ProvisionFailure(Action: String): String;
var
  Details: AnsiString;
  Path: String;
begin
  Path := GetEnv('LOCALAPPDATA') + '\JarvisRefined\' + Action + '-error.txt';
  if LoadStringFromFile(Path, Details) then
    Result := Copy(UTF8Decode(Details), 1, 1800)
  else
    Result := 'Jarvis provisioning failed. Run the installed bootstrap in Windows PowerShell to see the error. Log location: ' +
      GetEnv('LOCALAPPDATA') + '\JarvisRefined\' + Action + '.log';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
#ifdef RepairOnly
  if not (FileExists(ExpandConstant('{app}\installer\bootstrap.ps1')) and
    FileExists(ExpandConstant('{app}\manifest.json')) and
    FileExists(ExpandConstant('{app}\app.tar.gz')) and
    FileExists(ExpandConstant('{app}\rootfs.tar')) and
    FileExists(ExpandConstant('{app}\node-linux.tar.xz')) and
    FileExists(ExpandConstant('{app}\node-windows.zip'))) then
  begin
    Result := 'Select the existing Jarvis Refined installation folder. This repair does not include a fresh installation payload.';
    Exit;
  end;
#endif
  if FileExists(ExpandConstant('{app}\installer\bootstrap.ps1')) then
  begin
    ExtractTemporaryFile('bootstrap.ps1');
    ExtractTemporaryFile('provision.sh');
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      ExpandConstant('-NoProfile -ExecutionPolicy Bypass -File "{tmp}\bootstrap.ps1" -Action Stop -InstallDir "{app}"'),
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      Result := 'Could not stop the existing Jarvis runtime.'
    else if ResultCode <> 0 then
      Result := ProvisionFailure('Stop');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      ExpandConstant('-NoProfile -ExecutionPolicy Bypass -File "{app}\installer\bootstrap.ps1" -Action Install -InstallDir "{app}"'),
      '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Could not launch Jarvis provisioning.');
    if ResultCode = 3010 then
      MsgBox('Restart Windows to finish WSL setup. Jarvis provisioning will resume at sign-in.', mbInformation, MB_OK)
    else if ResultCode <> 0 then
      RaiseException(ProvisionFailure('Install'));
  end;
end;