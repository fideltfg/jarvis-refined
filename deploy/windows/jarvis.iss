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
DefaultDirName={autopf}\JarvisRefined
DefaultGroupName=Jarvis Refined
PrivilegesRequired=admin
UsePreviousAppDir=no
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

[Messages]
WelcomeLabel2=Before setup, install current WSL2, the dedicated Ubuntu-24.04 distribution, and Node.js 22 or newer in Windows and Ubuntu. Setup checks these prerequisites before installing files. Jarvis application files go under Program Files; WSL and runtime data stay in your Windows user profile. Keep this installer open to see progress.

[Dirs]
Name: "{commonappdata}\JarvisRefined"; Permissions: users-modify

[Files]
Source: "{#PayloadDir}\installer\bootstrap.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "{#PayloadDir}\installer\provision.sh"; DestDir: "{app}\installer"; Flags: ignoreversion
#ifndef RepairOnly
Source: "{#PayloadDir}\app.tar.gz"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\manifest.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\jarvis-relay.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\relay-launcher.mjs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Jarvis Refined"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Launch -InstallDir ""{app}"""
Name: "{group}\Stop Jarvis"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Stop -InstallDir ""{app}"""
Name: "{group}\Jarvis Diagnostics"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Status -InstallDir ""{app}"""
Name: "{group}\Configure Jarvis"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoExit -NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Configure -InstallDir ""{app}"""
Name: "{autodesktop}\Jarvis Refined"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Launch -InstallDir ""{app}"""

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\installer\bootstrap.ps1"" -Action Detach -InstallDir ""{app}"""; Flags: runhidden waituntilterminated

#endif

[Code]
var
  InstallLogMemo: TNewMemo;
  InstallSessionId: String;
  InstallProgressFile: String;
  InstallResultFile: String;
  InstallLogLineIndex: Integer;
  InstallProgressBase: Integer;
  InstallProgressPulse: Integer;
  InstallProgressDirection: Integer;

function GetTickCount: DWORD;
external 'GetTickCount@kernel32.dll stdcall';

procedure Sleep(dwMilliseconds: DWORD);
external 'Sleep@kernel32.dll stdcall';

procedure InitializeWizard;
begin
  InstallLogMemo := TNewMemo.Create(WizardForm);
  InstallLogMemo.Parent := WizardForm.InnerNotebook;
  InstallLogMemo.Left := WizardForm.StatusLabel.Left;
  InstallLogMemo.Top := WizardForm.FilenameLabel.Top + WizardForm.FilenameLabel.Height + ScaleY(8);
  InstallLogMemo.Width := WizardForm.InnerNotebook.ClientWidth - InstallLogMemo.Left - ScaleX(8);
  InstallLogMemo.Height := WizardForm.ProgressGauge.Top - InstallLogMemo.Top - ScaleY(8);
  InstallLogMemo.ScrollBars := ssVertical;
  InstallLogMemo.ReadOnly := True;
  InstallLogMemo.WordWrap := False;
  InstallLogMemo.Font.Name := 'Consolas';
  InstallLogMemo.Visible := False;
end;

function StageProgress(const S: String): Integer;
var
  Text: String;
begin
  Text := Lowercase(S);
  if Pos('checking installer state', Text) > 0 then Result := 3
  else if Pos('compatibility and payload', Text) > 0 then Result := 7
  else if Pos('wsl availability', Text) > 0 then Result := 12
  else if Pos('administrator approval', Text) > 0 then Result := 16
  else if Pos('updating the microsoft wsl', Text) > 0 then Result := 20
  else if Pos('importing the dedicated', Text) > 0 then Result := 28
  else if Pos('preparing ubuntu', Text) > 0 then Result := 38
  else if Pos('installing and checking linux', Text) > 0 then Result := 55
  else if Pos('extracting the application', Text) > 0 then Result := 58
  else if Pos('extracting the linux node', Text) > 0 then Result := 68
  else if Pos('installing the windows node', Text) > 0 then Result := 78
  else if Pos('configuring browser relay', Text) > 0 then Result := 86
  else if Pos('registering per-user startup', Text) > 0 then Result := 92
  else if Pos('checking windows localhost', Text) > 0 then Result := 96
  else Result := InstallProgressBase;
end;

function FriendlyStage(const S: String): String;
var
  Text: String;
begin
  Text := Lowercase(S);
  if Pos('checking installer state', Text) > 0 then Result := 'Checking setup state and system requirements...'
  else if Pos('compatibility and payload', Text) > 0 then Result := 'Verifying Windows compatibility and installer files...'
  else if Pos('wsl availability', Text) > 0 then Result := 'Checking whether WSL is ready...'
  else if Pos('administrator approval', Text) > 0 then Result := 'Requesting permission to configure WSL...'
  else if Pos('enabling windows wsl', Text) > 0 then Result := 'Enabling Windows WSL components; Windows may request a restart...'
  else if Pos('updating the microsoft wsl', Text) > 0 then Result := 'Updating WSL. This can take several minutes; keep this window open.'
  else if Pos('importing the dedicated', Text) > 0 then Result := 'Creating Jarvis''s dedicated Linux environment...'
  else if Pos('preparing ubuntu', Text) > 0 then Result := 'Preparing Ubuntu and installing prerequisites. This can take several minutes.'
  else if Pos('installing and checking linux', Text) > 0 then Result := 'Installing Jarvis services inside WSL...'
  else if Pos('extracting the application', Text) > 0 then Result := 'Unpacking Jarvis inside WSL; large archives can take several minutes.'
  else if Pos('extracting the linux node', Text) > 0 then Result := 'Installing the Linux runtime inside WSL...'
  else if Pos('installing the windows node', Text) > 0 then Result := 'Installing the Windows browser-relay runtime...'
  else if Pos('configuring browser relay', Text) > 0 then Result := 'Securing browser-relay credentials...'
  else if Pos('registering per-user startup', Text) > 0 then Result := 'Setting up Jarvis background startup tasks...'
  else if Pos('checking windows localhost', Text) > 0 then Result := 'Checking Jarvis services on this PC...'
  else if Pos('jarvis failed', Text) > 0 then Result := S
  else Result := 'Setting up Jarvis; see the live log below...';
end;

procedure PumpInstallLog;
var
  Lines: TStringList;
  Line: String;
begin
  if not FileExists(InstallProgressFile) then Exit;
  Lines := TStringList.Create;
  try
    Lines.LoadFromFile(InstallProgressFile);
    while InstallLogLineIndex < Lines.Count do begin
      Line := Lines[InstallLogLineIndex];
      InstallLogMemo.Lines.Add(Line);
      if InstallLogMemo.Lines.Count > 500 then InstallLogMemo.Lines.Delete(0);
      InstallProgressBase := StageProgress(Line);
      WizardForm.StatusLabel.Caption := FriendlyStage(Line);
      WizardForm.FilenameLabel.Caption := Line;
      Inc(InstallLogLineIndex);
    end;
  finally
    Lines.Free;
  end;
end;

function RunInstallForOriginalUser(var ResultCode: Integer): Boolean;
var
  Params, Bootstrap: String;
  ResultText: AnsiString;
  StartedAt: Cardinal;
begin
  InstallSessionId := IntToStr(GetTickCount);
  InstallProgressFile := ExpandConstant('{commonappdata}\JarvisRefined\Install-' + InstallSessionId + '.progress');
  InstallResultFile := ExpandConstant('{commonappdata}\JarvisRefined\Install-' + InstallSessionId + '.result');
  SaveStringToFile(InstallProgressFile, '', False);
  DeleteFile(InstallResultFile);
  Bootstrap := ExpandConstant('{app}\installer\bootstrap.ps1');
  Params := '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + Bootstrap +
    '" -Action Install -InstallDir "' + ExpandConstant('{app}') + '" -SessionId ' + InstallSessionId +
    ' -ProgressFile "' + InstallProgressFile + '"';
  if not ExecAsOriginalUser(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Params, ExpandConstant('{app}'), SW_HIDE, ewNoWait, ResultCode) then begin
    Result := False;
    Exit;
  end;

  InstallLogMemo.Visible := True;
  InstallLogLineIndex := 0;
  InstallProgressBase := 3;
  InstallProgressPulse := 0;
  InstallProgressDirection := 1;
  WizardForm.ProgressGauge.Position := InstallProgressBase;
  WizardForm.CancelButton.Enabled := False;
  WizardForm.NextButton.Enabled := False;
  WizardForm.BackButton.Enabled := False;
  StartedAt := GetTickCount;

  while not FileExists(InstallResultFile) do begin
    PumpInstallLog;
    InstallProgressPulse := InstallProgressPulse + InstallProgressDirection;
    if InstallProgressPulse >= 5 then InstallProgressDirection := -1;
    if InstallProgressPulse <= 0 then InstallProgressDirection := 1;
    WizardForm.ProgressGauge.Position := InstallProgressBase + InstallProgressPulse;
    WizardForm.Update;
    Sleep(250);
    if (GetTickCount - StartedAt) > 7200000 then begin
      Result := False;
      ResultCode := 1460;
      Exit;
    end;
  end;

  PumpInstallLog;
  if LoadStringFromFile(InstallResultFile, ResultText) then begin
    ResultCode := StrToInt(Trim(String(ResultText)));
    Result := True;
  end
  else begin
    Result := False;
    ResultCode := 1;
  end;
  DeleteFile(InstallResultFile);
  WizardForm.CancelButton.Enabled := True;
  WizardForm.NextButton.Enabled := True;
  WizardForm.BackButton.Enabled := True;
end;

function RecentInstallLog: String;
var
  FirstLine, I: Integer;
begin
  Result := '';
  if InstallLogMemo.Lines.Count > 12 then FirstLine := InstallLogMemo.Lines.Count - 12
  else FirstLine := 0;
  for I := FirstLine to InstallLogMemo.Lines.Count - 1 do
    Result := Result + #13#10 + InstallLogMemo.Lines[I];
end;

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
    FileExists(ExpandConstant('{app}\app.tar.gz'))) then
  begin
    Result := 'Select the existing Jarvis Refined installation folder. This repair does not include a fresh installation payload.';
    Exit;
  end;
#endif
  ExtractTemporaryFile('bootstrap.ps1');
  ExtractTemporaryFile('provision.sh');
  if not ExecAsOriginalUser(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    ExpandConstant('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{tmp}\bootstrap.ps1" -Action CheckPrerequisites -InstallDir "{app}"'),
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := 'Could not check the WSL/Ubuntu/Node prerequisites.'
  else if ResultCode <> 0 then begin
    Result := ProvisionFailure('CheckPrerequisites');
    Exit;
  end;
  if FileExists(ExpandConstant('{app}\installer\bootstrap.ps1')) then
  begin
    if not ExecAsOriginalUser(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
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
    WizardForm.StatusLabel.Caption := 'Setting up Jarvis for your Windows account';
    WizardForm.FilenameLabel.Caption := 'Configuring the dedicated Ubuntu distro, services and browser connection.';
    if not RunInstallForOriginalUser(ResultCode) then
      RaiseException('Could not complete Jarvis setup. Recent output:' + RecentInstallLog);
    if ResultCode = 3010 then
      MsgBox('Windows must restart before setup can continue. Restart, then run this installer again.', mbInformation, MB_OK)
    else if ResultCode <> 0 then
      RaiseException('Jarvis setup failed (exit ' + IntToStr(ResultCode) + ').' + #13#10 +
        'Recent setup output:' + RecentInstallLog);
  end;
end;