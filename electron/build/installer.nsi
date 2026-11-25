; Dimo Custom Electron NSIS Installer Script
; Replicates the frameless Light/Dark modern installer experience while keeping
; full compatibility with electron-builder differential blockmaps, electron-updater
; silent/auto upgrades, and legacy Tauri v2 upgrades.

ManifestDPIAware true
ManifestDPIAwareness PerMonitorV2
XPStyle on

Var newStartMenuLink
Var oldStartMenuLink
Var newDesktopLink
Var oldDesktopLink
Var oldShortcutName
Var oldMenuDirectory
Var appExe
Var launchLink
Var installMode
Var PassiveMode
Var UpdateMode
Var NoShortcutMode

!define FOLDERID_UserProgramFiles {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}
!define KF_FLAG_CREATE 0x00008000
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

!include "common.nsh"
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "allowOnlyOneInstallerInstance.nsh"
!include "include\installUtil.nsh"
!include "include\installer.nsh"

RequestExecutionLevel user
BrandingText " "
ShowUninstDetails nevershow

!include "${BUILD_RESOURCES_DIR}\installer\hooks.nsh"

!define MUI_CUSTOMFUNCTION_GUIINIT DimoGuiInitInstaller
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.DimoGuiInitUninstaller

Function .onGUIEnd
  Call DimoGuiEnd
FunctionEnd

Function un.onGUIEnd
  Call un.DimoGuiEnd
FunctionEnd

; ============================================================================
; Installer pages: main (welcome / custom location / existing) -> progress -> finish
; ============================================================================
Page custom DimoPageMain DimoPageMainLeave

!define MUI_PAGE_CUSTOMFUNCTION_SHOW DimoInstFilesShow
!insertmacro MUI_PAGE_INSTFILES

Page custom DimoPageFinish DimoPageFinishLeave

; ============================================================================
; Uninstaller pages: confirm -> progress -> finish
; ============================================================================
UninstPage custom un.DimoPageConfirm un.DimoPageConfirmLeave

!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.DimoInstFilesShow
!insertmacro MUI_UNPAGE_INSTFILES

UninstPage custom un.DimoPageFinish

; ============================================================================
; Languages (configured via nsis.installerLanguages: [en_US, zh_CN])
; ============================================================================
!insertmacro addLangs
!include "${DIMO_INSTALLER_DIR}\strings.nsh"

; Custom /D= parser matching electron-builder multiUser.nsh (supports spaces).
!macro DimoGetDParameter outVar
  Push $R8
  Push $R9
  Push $R7
  Push $R6
  Push $R5

  ${StdUtils.GetAllParameters} $R8 "0"
  StrCpy $R9 ""
  StrLen $R7 $R8
  IntOp $R7 $R7 - 2
  StrCpy $R6 0

  ${Do}
    StrCpy $R5 $R8 3 $R6
    ${If} $R5 == "/D="
    ${OrIf} $R5 == "/d="
      IntOp $R6 $R6 + 3
      StrCpy $R9 $R8 "" $R6
      ${Break}
    ${EndIf}
    IntOp $R6 $R6 + 1
  ${LoopUntil} $R6 > $R7

  StrCpy ${outVar} $R9
  Pop $R5
  Pop $R6
  Pop $R7
  Pop $R9
  Pop $R8
!macroend

Function .onInit
  Call setInstallSectionSpaceRequired
  !insertmacro check64BitAndSetRegView
  !insertmacro ALLOW_ONLY_ONE_INSTALLER_INSTANCE

  ; Parse Tauri v2 bridge updater flags alongside electron-updater flags
  StrCpy $PassiveMode 0
  StrCpy $UpdateMode 0
  StrCpy $NoShortcutMode 0

  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CMDLINE "/NS" $0
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ; Always install per-user (no UAC prompt, no "choose user" page)
  StrCpy $installMode "CurrentUser"
  SetShellVarContext current

  ; Restore previous Electron install location, falling back to legacy Tauri
  ; location, then %LOCALAPPDATA%\Programs\Dimo.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $0 == ""
  ${AndIf} "${UNINSTALL_APP_KEY}" != "Dimo"
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dimo" "InstallLocation"
  ${EndIf}

  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${Else}
    StrCpy $0 "$LOCALAPPDATA\Programs"
    Push $1
    Push $2
    StrCpy $2 0
    System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
    ${If} $1 == 0
      System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
    ${EndIf}
    ${If} $2 != 0
      System::Call 'OLE32::CoTaskMemFree(p r2)'
    ${EndIf}
    Pop $2
    Pop $1
    StrCpy $INSTDIR "$0\${APP_FILENAME}"
  ${EndIf}

  ; Allow explicit /D= override
  !insertmacro DimoGetDParameter $R0
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${EndIf}
FunctionEnd

Var DimoCheckDir

!macro DimoInitProcessHelpers
  System::Call 'kernel32::GetCurrentProcessId() i.s'
  Pop $pid
  StrCpy $CmdPath "$SYSDIR\cmd.exe"
  StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
  Pop $0
  ${If} $0 != 0
    StrCpy $0 1
  ${EndIf}
  StrCpy $IsPowerShellAvailable $0
!macroend

!macro DimoFindRunningInDir dirVar outVar
  ${If} $IsPowerShellAvailable == 0
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_INSTDIR", t "${dirVar}")'
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_SELF_PID", t "$pid")'
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root = $$env:DIMO_NSIS_INSTDIR; if (-not $$root) { exit 1 }; $$prefix = $$root.TrimEnd('\') + '\'; $$procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue); $$exclude = New-Object 'System.Collections.Generic.HashSet[int]'; $$selfPid = 0; [void][int]::TryParse($$env:DIMO_NSIS_SELF_PID, [ref]$$selfPid); foreach ($$seed in @([int]$$PID, $$selfPid)) { $$cur = $$seed; while ($$cur -gt 0 -and $$exclude.Add($$cur)) { $$p = $$procs | Where-Object { $$_.ProcessId -eq $$cur } | Select-Object -First 1; $$cur = if ($$p) { [int]$$p.ParentProcessId } else { 0 } } }; $$hits = @($$procs | Where-Object { -not $$exclude.Contains([int]$$_.ProcessId) -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$hits.Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${outVar}
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_INSTDIR", i 0)'
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_SELF_PID", i 0)'
  ${Else}
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop ${outVar}
  ${EndIf}
!macroend

!macro DimoKillRunningInDir dirVar forceFlag
  Push $0
  ${If} $IsPowerShellAvailable == 0
    !if ${forceFlag} == 1
      StrCpy $0 "-Force"
    !else
      StrCpy $0 ""
    !endif
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_INSTDIR", t "${dirVar}")'
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_SELF_PID", t "$pid")'
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root = $$env:DIMO_NSIS_INSTDIR; if ($$root) { $$prefix = $$root.TrimEnd('\') + '\'; $$procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue); $$exclude = New-Object 'System.Collections.Generic.HashSet[int]'; $$selfPid = 0; [void][int]::TryParse($$env:DIMO_NSIS_SELF_PID, [ref]$$selfPid); foreach ($$seed in @([int]$$PID, $$selfPid)) { $$cur = $$seed; while ($$cur -gt 0 -and $$exclude.Add($$cur)) { $$p = $$procs | Where-Object { $$_.ProcessId -eq $$cur } | Select-Object -First 1; $$cur = if ($$p) { [int]$$p.ParentProcessId } else { 0 } } }; $$pids = @($$procs | Where-Object { -not $$exclude.Contains([int]$$_.ProcessId) -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty ProcessId); if ($$pids.Count -gt 0) { Stop-Process -Id $$pids $0 -ErrorAction SilentlyContinue; Wait-Process -Id $$pids -Timeout 5 -ErrorAction SilentlyContinue } }"`
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_INSTDIR", i 0)'
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_SELF_PID", i 0)'
  ${Else}
    !if ${forceFlag} == 1
      StrCpy $0 "/F"
    !else
      StrCpy $0 ""
    !endif
    nsExec::Exec `"$CmdPath" /C taskkill $0 /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $pid" /FI "USERNAME eq %USERNAME%"`
    Pop $0
  ${EndIf}
  Pop $0
!macroend

!macro DimoCheckAppRunningInDirBody dirVar labelPrefix
  ${If} "${dirVar}" == ""
    Return
  ${EndIf}

  ${If} ${isUpdated}
    Sleep 300
  ${EndIf}
  !insertmacro DimoFindRunningInDir "${dirVar}" $R0
  ${If} $R0 == 0
    ${If} ${isUpdated}
      Sleep 1000
      Goto ${labelPrefix}_stop_process
    ${EndIf}
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK ${labelPrefix}_stop_process
      Quit
    ${EndIf}
    ${labelPrefix}_stop_process:
    DetailPrint "$(appClosing)"
    !insertmacro DimoKillRunningInDir "${dirVar}" 0
    Sleep 300
    StrCpy $R1 0
    ${labelPrefix}_wait_loop:
      IntOp $R1 $R1 + 1
      !insertmacro DimoFindRunningInDir "${dirVar}" $R0
      ${If} $R0 == 0
        Sleep 1000
        !insertmacro DimoKillRunningInDir "${dirVar}" 1
        !insertmacro DimoFindRunningInDir "${dirVar}" $R0
        ${If} $R0 == 0
          Sleep 2000
        ${Else}
          Goto ${labelPrefix}_not_running
        ${EndIf}
      ${Else}
        Goto ${labelPrefix}_not_running
      ${EndIf}
      ${If} $R1 > 1
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY ${labelPrefix}_wait_loop
        Quit
      ${Else}
        Goto ${labelPrefix}_wait_loop
      ${EndIf}
    ${labelPrefix}_not_running:
  ${EndIf}
!macroend

Function DimoCheckAppRunning
  !insertmacro CHECK_APP_RUNNING
FunctionEnd

Function DimoCheckAppRunningInDir
  !insertmacro DimoInitProcessHelpers
  !insertmacro DimoCheckAppRunningInDirBody "$DimoCheckDir" "inst_dir"
FunctionEnd

Section "install" INSTALL_SECTION_ID
  InitPluginsDir

  ${IfNot} ${Silent}
    SetDetailsPrint none
  ${EndIf}

  ; User picked "Uninstall" on the existing-installation view
  ${If} $DimoAction == "uninstall"
  dimo_uninstall_retry:
    !insertmacro DimoSetStage "" "$(DIMO_PROGRESS_UNINSTALL)" 150
    ${If} $DimoExistingDir != ""
      StrCpy $appExe "$DimoExistingDir\${APP_EXECUTABLE_FILENAME}"
      StrCpy $DimoCheckDir "$DimoExistingDir"
      Call DimoCheckAppRunningInDir
    ${EndIf}

    !insertmacro DimoSetStage "" "$(DIMO_PROGRESS_UNINSTALL)" 450
    StrCpy $0 0
    ${If} $DimoExistingUninstall != ""
      !insertmacro GetInQuotes $R1 "$DimoExistingUninstall"
      ${If} $R1 == ""
        StrCpy $R1 "$DimoExistingUninstall"
      ${EndIf}
      ${If} $R1 != ""
      ${AndIf} ${FileExists} "$R1"
        StrCpy $R2 "$PLUGINSDIR\old-uninstaller.exe"
        !insertmacro copyFile "$R1" "$R2"
        ClearErrors
        ExecWait '"$R2" /S _?=$DimoExistingDir' $0
        ${If} ${Errors}
          ClearErrors
          ExecWait '"$R1" /S _?=$DimoExistingDir' $0
        ${EndIf}
      ${Else}
        ClearErrors
        ExecWait '$DimoExistingUninstall /S _?=$DimoExistingDir' $0
      ${EndIf}
      ${If} ${Errors}
      ${OrIf} $0 != 0
        !insertmacro DimoLog "uninstall failed: exit=$0 cmd=$DimoExistingUninstall dir=$DimoExistingDir"
        StrCpy $DimoErrTitle "$(DIMO_UNINSTALL_FAILED)"
        StrCpy $DimoErrCode "0xE0010003"
        Call DimoShowError
        Goto dimo_uninstall_retry
      ${EndIf}
    ${EndIf}

    Delete "$DimoExistingDir\${UNINSTALL_FILENAME}"
    Delete "$DimoExistingDir\uninstall.exe"
    RMDir "$DimoExistingDir"
    Goto dimo_install_done
  ${EndIf}

  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  ; Must be called before uninstallOldVersion
  !insertmacro setLinkVars

  !insertmacro DimoSetStage "" "$(DIMO_PROGRESS_PREPARE)" 50
  Call DimoCheckAppRunning

  Var /GLOBAL keepShortcuts
  StrCpy $keepShortcuts "false"
  !insertmacro setIsTryToKeepShortcuts
  ${If} $isTryToKeepShortcuts == "true"
    ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts
    ${If} $R1 == "true"
    ${AndIf} ${FileExists} "$appExe"
      StrCpy $keepShortcuts "true"
    ${EndIf}
  ${EndIf}

  !insertmacro DimoSetStage "" "$(DIMO_PROGRESS_PREPARE)" 100
  !insertmacro uninstallOldVersion SHELL_CONTEXT
  !insertmacro handleUninstallResult SHELL_CONTEXT

  ; Cleanly remove legacy Tauri v2 binaries if upgrading over a Tauri install
  ; (preserves user data via /UPDATE).
  ${If} "${UNINSTALL_APP_KEY}" != "Dimo"
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dimo" "UninstallString"
    ${If} $R0 != ""
      ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dimo" "InstallLocation"
      ${If} $R1 == ""
        StrCpy $R1 "$INSTDIR"
      ${EndIf}
      !insertmacro GetInQuotes $R2 "$R0"
      ${If} $R2 != ""
      ${AndIf} ${FileExists} "$R2"
        StrCpy $R3 "$PLUGINSDIR\legacy-tauri-uninstaller.exe"
        !insertmacro copyFile "$R2" "$R3"
        ExecWait '"$R3" /S /UPDATE _?=$R1' $0
      ${Else}
        ${If} $R2 == ""
          ${If} ${FileExists} "$R0"
            StrCpy $R3 "$PLUGINSDIR\legacy-tauri-uninstaller.exe"
            !insertmacro copyFile "$R0" "$R3"
            ExecWait '"$R3" /S /UPDATE _?=$R1' $0
          ${Else}
            ExecWait '$R0 /S /UPDATE _?=$R1' $0
          ${EndIf}
        ${EndIf}
      ${EndIf}
      Delete "$R1\uninstall.exe"
    ${EndIf}
  ${EndIf}

  ; Embed arch package verbatim (SetCompress off) so differential .blockmap
  ; locates stored members identically to stock electron-builder.
  !ifdef COMPRESS
    SetCompress off
  !endif

  Var /GLOBAL packageArch
  !insertmacro identify_package
  !insertmacro compute_files_for_current_arch

  !ifdef COMPRESS
    SetCompress "${COMPRESS}"
  !endif

  !insertmacro DimoSetStage "" "$(DIMO_PROGRESS_EXTRACT)" 120

  ; Extract 7z archive into $PLUGINSDIR\7z-out with live smooth progress updates (12% -> 87%).
  ; Verify extraction errors BEFORE touching $INSTDIR so a transient STATUS_DELETE_PENDING
  ; or AV/process lock on $INSTDIR is never misreported as a 7z extraction failure (0xE0010001).
  dimo_extract_retry:
    SetOutPath "$PLUGINSDIR"
    RMDir /r "$PLUGINSDIR\7z-out"
    CreateDirectory "$PLUGINSDIR\7z-out"
    ClearErrors
    SetOutPath "$PLUGINSDIR\7z-out"
    ${If} ${Errors}
      !insertmacro DimoLog "extract setup failed: SetOutPath $PLUGINSDIR\7z-out"
      SetOutPath "$PLUGINSDIR"
      StrCpy $DimoErrTitle "$(DIMO_EXTRACT_FAILED)"
      StrCpy $DimoErrCode "0xE0010001"
      Call DimoShowError
      Goto dimo_extract_retry
    ${EndIf}
    GetFunctionAddress $R9 DimoNsis7zCallback
    Nsis7z::ExtractWithCallback "$PLUGINSDIR\app-$packageArch.${COMPRESSION_METHOD}" $R9
    ${If} ${Errors}
      !insertmacro DimoLog "extract failed: Nsis7z error flag set (arch=$packageArch)"
      SetOutPath "$PLUGINSDIR"
      StrCpy $DimoErrTitle "$(DIMO_EXTRACT_FAILED)"
      StrCpy $DimoErrCode "0xE0010001"
      Call DimoShowError
      Goto dimo_extract_retry
    ${EndIf}
    ${IfNot} ${FileExists} "$PLUGINSDIR\7z-out\${APP_EXECUTABLE_FILENAME}"
      !insertmacro DimoLog "extract failed: missing ${APP_EXECUTABLE_FILENAME} in $PLUGINSDIR\7z-out"
      SetOutPath "$PLUGINSDIR"
      StrCpy $DimoErrTitle "$(DIMO_EXTRACT_FAILED)"
      StrCpy $DimoErrCode "0xE0010001"
      Call DimoShowError
      Goto dimo_extract_retry
    ${EndIf}
    SetOutPath "$PLUGINSDIR"

    Push 880
    Call DimoSetProgress

    ; Ensure $INSTDIR is writable and copy unpacked files into $INSTDIR
    ; (with retry loop for transient delete-pending/AV/process locks, then custom error UI)
    StrCpy $R1 0
  dimo_copy_loop:
    IntOp $R1 $R1 + 1
    ClearErrors
    SetOutPath "$INSTDIR"
    ${If} ${Errors}
      !insertmacro DimoLog "copy attempt $R1: SetOutPath failed ($INSTDIR)"
      ${If} $R1 < 6
        ${If} $R1 = 2
          Call DimoCheckAppRunning
        ${EndIf}
        Sleep 800
        Goto dimo_copy_loop
      ${EndIf}
      Goto dimo_copy_error
    ${EndIf}
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" "$INSTDIR"
    ${IfNot} ${Errors}
    ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Goto dimo_copy_done
    ${EndIf}
    !insertmacro DimoLog "copy attempt $R1: CopyFiles failed ($INSTDIR)"
    ${If} $R1 < 6
      ${If} $R1 = 2
        Call DimoCheckAppRunning
      ${EndIf}
      Sleep 800
      Goto dimo_copy_loop
    ${EndIf}
  dimo_copy_error:
    StrCpy $DimoErrTitle "$(DIMO_COPY_FAILED)"
    StrCpy $DimoErrCode "0xE0010002"
    Call DimoShowError
    Call DimoCheckAppRunning
    StrCpy $R1 0
    Goto dimo_copy_loop

  dimo_copy_done:
    RMDir /r "$PLUGINSDIR\7z-out"
    !insertmacro custom_files_post_decompression

  Push 910
  Call DimoSetProgress

  ; Store current installer for electron-updater differential updates
  !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"

  !insertmacro DimoSetStage "" "$(DIMO_PROGRESS_INSTALL)" 940

  !ifdef UNINSTALLER_ICON
    File "/oname=$INSTDIR\uninstallerIcon.ico" "${UNINSTALLER_ICON}"
  !endif

  WriteUninstaller "$INSTDIR\${UNINSTALL_FILENAME}"
  !insertmacro registryAddInstallInfo

  ; Register dimo:// deep-link protocol
  WriteRegStr HKCU "Software\Classes\dimo" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\dimo" "" "URL:${APP_ID} protocol"
  WriteRegStr HKCU "Software\Classes\dimo\DefaultIcon" "" '"$appExe",0'
  WriteRegStr HKCU "Software\Classes\dimo\shell\open\command" "" '"$appExe" "%1"'

  ; Register Dimo in Windows "Open with" menu without claiming default handlers
  !insertmacro DimoRegisterOpenWith

  !ifmacrodef registerFileAssociations
    !insertmacro registerFileAssociations
  !endif

  !ifmacrodef customInstall
    !insertmacro customInstall
  !endif

  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'

  !insertmacro DimoSetStage "" "$(DIMO_PROGRESS_FINISH)" 970

  ${If} $NoShortcutMode <> 1
    !insertmacro addStartMenuLink $keepShortcuts
    !insertmacro addDesktopLink $keepShortcuts
  ${EndIf}

  ${If} ${FileExists} "$newStartMenuLink"
    StrCpy $launchLink "$newStartMenuLink"
  ${Else}
    StrCpy $launchLink "$appExe"
  ${EndIf}

  dimo_install_done:
  Call DimoTickDone
  ${If} $PassiveMode = 1
  ${OrIf} ${isUpdated}
    SetAutoClose true
  ${EndIf}
SectionEnd
!if ${INSTALL_SECTION_ID} != ${DIMO_SEC_INSTALL}
  !error "DIMO_SEC_INSTALL must match INSTALL_SECTION_ID"
!endif

Function setInstallSectionSpaceRequired
  !ifdef APP_64_UNPACKED_SIZE
    !insertmacro setSpaceRequired ${INSTALL_SECTION_ID}
  !else
    !ifdef APP_ARM64_UNPACKED_SIZE
      SectionSetSize ${INSTALL_SECTION_ID} ${APP_ARM64_UNPACKED_SIZE}
    !else
      !insertmacro setSpaceRequired ${INSTALL_SECTION_ID}
    !endif
  !endif
FunctionEnd

Function .onInstSuccess
  ${If} $DimoAction == "uninstall"
    Return
  ${EndIf}
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
  ${OrIf} ${isUpdated}
    ${If} ${isForceRun}
      HideWindow
      !insertmacro StartApp
    ${Else}
      ClearErrors
      ${GetOptions} $CMDLINE "/R" $R0
      ${IfNot} ${Errors}
        ClearErrors
        ${GetOptions} $CMDLINE "/ARGS" $R0
        ${If} ${Errors}
          StrCpy $R0 ""
        ${EndIf}
        HideWindow
        ${If} $launchLink == ""
          StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        ${EndIf}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$R0"
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

; ============================================================================
; Uninstaller
; ============================================================================
Function un.onInit
  SetOutPath $INSTDIR
  !insertmacro check64BitAndSetRegView

  StrCpy $installMode "CurrentUser"
  SetShellVarContext current

  StrCpy $PassiveMode 0
  StrCpy $UpdateMode 0
  StrCpy $DeleteAppDataCheckboxState 0

  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/S" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}

  ClearErrors
  ${GetOptions} $R0 "/P" $R1
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $R0 "/UPDATE" $R1
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
FunctionEnd

Function un.atomicRMDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "$INSTDIR$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break
    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    IfFileExists "$INSTDIR$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "$PLUGINSDIR\old-install$R0\$R2"
      Push "$R0\$R2"
      Call un.atomicRMDir
      Pop $R3
      ${If} $R3 != 0
        Goto done
      ${EndIf}
      Goto continue

    isNotDir:
      ClearErrors
      Rename "$INSTDIR$R0\$R2" "$PLUGINSDIR\old-install$R0\$R2"
      StrCmp "$R0\$R2" "\${UNINSTALL_FILENAME}" 0 +2
      ClearErrors
      IfErrors 0 +3
      StrCpy $R3 "$INSTDIR$R0\$R2"
      Goto done

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R3 0

  done:
    FindClose $R1
    StrCpy $R0 $R3
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function un.restoreFiles
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 "$PLUGINSDIR\old-install$R0\*.*"
  FindFirst $R1 $R2 $R3

  loop:
    StrCmp $R2 "" break
    StrCmp $R2 "." continue
    StrCmp $R2 ".." continue

    IfFileExists "$INSTDIR$R0\$R2\*.*" isDir isNotDir

    isDir:
      CreateDirectory "$INSTDIR$R0\$R2"
      Push "$R0\$R2"
      Call un.restoreFiles
      Pop $R3
      Goto continue

    isNotDir:
      Rename "$PLUGINSDIR\old-install$R0\$R2" "$INSTDIR$R0\$R2"

    continue:
      FindNext $R1 $R2
      Goto loop

  break:
    StrCpy $R0 0
    FindClose $R1
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function un.DimoCheckAppRunning
  !insertmacro DimoInitProcessHelpers
  !insertmacro DimoCheckAppRunningInDirBody "$INSTDIR" "un"

  !ifmacrodef customUnInit
    !insertmacro customUnInit
  !endif
FunctionEnd

Section "un.Uninstall"
  SectionIn RO
  InitPluginsDir

  ${IfNot} ${Silent}
    SetDetailsPrint none
  ${EndIf}

  !insertmacro DimoSetStage "un." "$(DIMO_PROGRESS_UNINSTALL)" 100
  Call un.DimoCheckAppRunning

  !insertmacro setLinkVars

  Push 250
  Call un.DimoSetProgress

  ${If} ${isUpdated}
    ; Win32 Rename fails across volumes (ERROR_NOT_SAME_DEVICE) if $INSTDIR is on
    ; a different drive than %TEMP% ($PLUGINSDIR). Only stage via un.atomicRMDir
    ; when both paths share the same drive letter; otherwise fall through to RMDir /r.
    StrCpy $R1 $INSTDIR 2
    StrCpy $R2 $PLUGINSDIR 2
    ${If} $R1 == $R2
      CreateDirectory "$PLUGINSDIR\old-install"
      Push ""
      Call un.atomicRMDir
      Pop $R0
      ${If} $R0 != 0
        DetailPrint "File is busy, aborting: $R0"
        Push ""
        Call un.restoreFiles
        Pop $R0
        Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
      ${EndIf}
    ${EndIf}
  ${EndIf}

  SetOutPath $TEMP
  RMDir /r $INSTDIR

  Push 650
  Call un.DimoSetProgress

  ${IfNot} ${isKeepShortcuts}
  ${AndIf} $UpdateMode <> 1
    WinShell::UninstAppUserModelId "${APP_ID}"

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    !endif

    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      WinShell::UninstShortcut "$oldStartMenuLink"
      Delete "$oldStartMenuLink"
      ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" MenuDirectory
      ${IfNot} $R1 == ""
        RMDir "$SMPROGRAMS\$R1"
      ${EndIf}
    !endif
  ${EndIf}

  ; Unregister dimo:// protocol if it points to this installation
  ReadRegStr $R7 HKCU "Software\Classes\dimo\shell\open\command" ""
  ${If} $R7 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "Software\Classes\dimo"
  ${EndIf}

  !insertmacro DimoUnregisterOpenWith

  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'

  !ifmacrodef unregisterFileAssociations
    !insertmacro unregisterFileAssociations
  !endif

  Push 850
  Call un.DimoSetProgress

  ${If} $UpdateMode <> 1
  ${AndIfNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  ${EndIf}

  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
  ${AndIfNot} ${isUpdated}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    RMDir /r "$APPDATA\${APP_ID}"
    RMDir /r "$LOCALAPPDATA\${APP_ID}"
  ${EndIf}

  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"

  Call un.DimoTickDone

  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
  ${OrIf} ${isUpdated}
    SetAutoClose true
  ${EndIf}
SectionEnd
