!macro stopStagedSidecars
  ; Stop only sidecar/MCP helper processes running inside $INSTDIR so upgrades
  ; and uninstalls release file locks without killing unrelated headless
  ; `dimo serve` daemons running elsewhere on the machine.
  ${if} "$INSTDIR" != ""
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_INSTDIR", t "$INSTDIR")'
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$root = $$env:DIMO_NSIS_INSTDIR; if ($$root) { $$prefix = $$root.TrimEnd('\') + '\'; $$targets = @('dimo-server.exe', 'dimo-mcp.exe', 'dimo-workflow-mcp.exe'); Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -and ($$targets -contains $$_.Name.ToLowerInvariant()) -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$prefix, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }"`
    System::Call 'Kernel32::SetEnvironmentVariable(t "DIMO_NSIS_INSTDIR", i 0)'
  ${endIf}
!macroend

!macro customCheckAppRunning
  ; Runs inside the install section after the user confirms installation and
  ; chooses $INSTDIR, right before uninstallOldVersion/installApplicationFiles.
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !insertmacro stopStagedSidecars
!macroend

!macro customUnInit
  !insertmacro stopStagedSidecars
!macroend

!macro customInstall
  ; Clean up legacy Tauri NSIS Uninstall registry entry so Windows Settings
  ; ("Installed Apps") does not display duplicate Dimo entries after a
  ; seamless Tauri -> Electron upgrade. Only remove HKLM in per-machine
  ; (elevated) installs so per-user installs never assume elevation.
  ${if} "${UNINSTALL_APP_KEY}" != "Dimo"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dimo"
    ${if} $installMode == "all"
      DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dimo"
    ${endIf}
  ${endIf}
!macroend
