!macro customInit
  ; Ensure legacy Tauri shell and Rust sidecar/MCP helper processes release
  ; file locks before overwriting the installation directory during upgrades.
  nsExec::ExecToLog 'taskkill /F /IM dimo-server.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM dimo-mcp.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM dimo-workflow-mcp.exe /T'
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /F /IM dimo-server.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM dimo-mcp.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM dimo-workflow-mcp.exe /T'
!macroend

!macro customInstall
  ; Clean up legacy Tauri NSIS Uninstall registry entry so Windows Settings
  ; ("Installed Apps") does not display duplicate Dimo entries after a
  ; seamless Tauri -> Electron upgrade.
  StrCmp "${UNINSTALL_APP_KEY}" "Dimo" +3 0
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dimo"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Dimo"
!macroend
