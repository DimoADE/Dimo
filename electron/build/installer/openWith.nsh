; Dimo Windows "Open With" Registration (HKCU, non-intrusive)
; Registers Dimo in Explorer's "Open with" list via OpenWithProgids,
; Applications\Dimo.exe\SupportedTypes, and SystemFileAssociations\text\OpenWithList
; without modifying any file extension's default handler.

!ifndef DIMO_OPEN_WITH_NSH
!define DIMO_OPEN_WITH_NSH

!macro _DimoRegOpenWithExt EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "Dimo.File" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
!macroend

!macro _DimoUnregOpenWithExt EXT
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "Dimo.File"
!macroend

!macro _DimoForEachOpenWithExt MACRO_NAME
  ; Markdown & HTML
  !insertmacro ${MACRO_NAME} ".md"
  !insertmacro ${MACRO_NAME} ".mdx"
  !insertmacro ${MACRO_NAME} ".markdown"
  !insertmacro ${MACRO_NAME} ".html"
  !insertmacro ${MACRO_NAME} ".htm"

  ; Config & Data
  !insertmacro ${MACRO_NAME} ".yaml"
  !insertmacro ${MACRO_NAME} ".yml"
  !insertmacro ${MACRO_NAME} ".toml"
  !insertmacro ${MACRO_NAME} ".json"
  !insertmacro ${MACRO_NAME} ".xml"
  !insertmacro ${MACRO_NAME} ".ini"
  !insertmacro ${MACRO_NAME} ".conf"
  !insertmacro ${MACRO_NAME} ".cfg"
  !insertmacro ${MACRO_NAME} ".env"
  !insertmacro ${MACRO_NAME} ".properties"
  !insertmacro ${MACRO_NAME} ".csv"
  !insertmacro ${MACRO_NAME} ".log"
  !insertmacro ${MACRO_NAME} ".txt"
  !insertmacro ${MACRO_NAME} ".lock"
  !insertmacro ${MACRO_NAME} ".sql"
  !insertmacro ${MACRO_NAME} ".graphql"

  ; Source Code & Scripts
  !insertmacro ${MACRO_NAME} ".ts"
  !insertmacro ${MACRO_NAME} ".tsx"
  !insertmacro ${MACRO_NAME} ".js"
  !insertmacro ${MACRO_NAME} ".jsx"
  !insertmacro ${MACRO_NAME} ".mjs"
  !insertmacro ${MACRO_NAME} ".cjs"
  !insertmacro ${MACRO_NAME} ".css"
  !insertmacro ${MACRO_NAME} ".scss"
  !insertmacro ${MACRO_NAME} ".sass"
  !insertmacro ${MACRO_NAME} ".less"
  !insertmacro ${MACRO_NAME} ".vue"
  !insertmacro ${MACRO_NAME} ".svelte"
  !insertmacro ${MACRO_NAME} ".rs"
  !insertmacro ${MACRO_NAME} ".py"
  !insertmacro ${MACRO_NAME} ".go"
  !insertmacro ${MACRO_NAME} ".java"
  !insertmacro ${MACRO_NAME} ".kt"
  !insertmacro ${MACRO_NAME} ".swift"
  !insertmacro ${MACRO_NAME} ".dart"
  !insertmacro ${MACRO_NAME} ".c"
  !insertmacro ${MACRO_NAME} ".h"
  !insertmacro ${MACRO_NAME} ".cpp"
  !insertmacro ${MACRO_NAME} ".hpp"
  !insertmacro ${MACRO_NAME} ".cs"
  !insertmacro ${MACRO_NAME} ".rb"
  !insertmacro ${MACRO_NAME} ".php"
  !insertmacro ${MACRO_NAME} ".lua"
  !insertmacro ${MACRO_NAME} ".sh"
  !insertmacro ${MACRO_NAME} ".bash"
  !insertmacro ${MACRO_NAME} ".zsh"
  !insertmacro ${MACRO_NAME} ".ps1"

  ; Images, PDF, Video
  !insertmacro ${MACRO_NAME} ".png"
  !insertmacro ${MACRO_NAME} ".jpg"
  !insertmacro ${MACRO_NAME} ".jpeg"
  !insertmacro ${MACRO_NAME} ".gif"
  !insertmacro ${MACRO_NAME} ".svg"
  !insertmacro ${MACRO_NAME} ".webp"
  !insertmacro ${MACRO_NAME} ".avif"
  !insertmacro ${MACRO_NAME} ".bmp"
  !insertmacro ${MACRO_NAME} ".heic"
  !insertmacro ${MACRO_NAME} ".heif"
  !insertmacro ${MACRO_NAME} ".tif"
  !insertmacro ${MACRO_NAME} ".tiff"
  !insertmacro ${MACRO_NAME} ".ico"
  !insertmacro ${MACRO_NAME} ".pdf"
  !insertmacro ${MACRO_NAME} ".mp4"

  ; Office (OpenXML)
  !insertmacro ${MACRO_NAME} ".docx"
  !insertmacro ${MACRO_NAME} ".xlsx"
  !insertmacro ${MACRO_NAME} ".pptx"
!macroend

!macro DimoRegisterOpenWith
  WriteRegStr HKCU "Software\Classes\Dimo.File" "" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\Dimo.File\DefaultIcon" "" '"$appExe",0'
  WriteRegStr HKCU "Software\Classes\Dimo.File\shell\open\command" "" '"$appExe" "%1"'

  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" '"$appExe",0'
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'

  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\text\OpenWithList\${APP_EXECUTABLE_FILENAME}" "" ""

  !insertmacro _DimoForEachOpenWithExt _DimoRegOpenWithExt
!macroend

!macro DimoUnregisterOpenWith
  ReadRegStr $R7 HKCU "Software\Classes\Dimo.File\shell\open\command" ""
  ${If} $R7 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    !insertmacro _DimoForEachOpenWithExt _DimoUnregOpenWithExt
    DeleteRegKey HKCU "Software\Classes\Dimo.File"
    DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\text\OpenWithList\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}

  ReadRegStr $R7 HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" ""
  ${If} $R7 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend

!endif
