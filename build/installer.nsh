; Install into the folder named after the app. The old Claude Desk install (same app id) is replaced.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Switchdesk"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Switchdesk"
!macroend

; "Open with" for code and text files: Switchdesk is listed in each type's Open with menu, without
; taking over the app that opens the type now. Picking it opens the file in a tab (see openPaths in
; src/main.js); "Open folder in Switchdesk" on folders opens the folder.
!define SWITCHDESK_PROGID "Switchdesk.File"

!macro switchdeskOpenWith EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${SWITCHDESK_PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro switchdeskNoOpenWith EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${SWITCHDESK_PROGID}"
!macroend

!macro switchdeskTypes MACRO
  !insertmacro ${MACRO} txt
  !insertmacro ${MACRO} md
  !insertmacro ${MACRO} markdown
  !insertmacro ${MACRO} mdx
  !insertmacro ${MACRO} json
  !insertmacro ${MACRO} jsonc
  !insertmacro ${MACRO} json5
  !insertmacro ${MACRO} jsonl
  !insertmacro ${MACRO} js
  !insertmacro ${MACRO} mjs
  !insertmacro ${MACRO} cjs
  !insertmacro ${MACRO} jsx
  !insertmacro ${MACRO} ts
  !insertmacro ${MACRO} mts
  !insertmacro ${MACRO} cts
  !insertmacro ${MACRO} tsx
  !insertmacro ${MACRO} css
  !insertmacro ${MACRO} scss
  !insertmacro ${MACRO} sass
  !insertmacro ${MACRO} less
  !insertmacro ${MACRO} html
  !insertmacro ${MACRO} htm
  !insertmacro ${MACRO} xml
  !insertmacro ${MACRO} svg
  !insertmacro ${MACRO} yml
  !insertmacro ${MACRO} yaml
  !insertmacro ${MACRO} toml
  !insertmacro ${MACRO} ini
  !insertmacro ${MACRO} cfg
  !insertmacro ${MACRO} conf
  !insertmacro ${MACRO} env
  !insertmacro ${MACRO} log
  !insertmacro ${MACRO} csv
  !insertmacro ${MACRO} tsv
  !insertmacro ${MACRO} py
  !insertmacro ${MACRO} pyi
  !insertmacro ${MACRO} rb
  !insertmacro ${MACRO} go
  !insertmacro ${MACRO} rs
  !insertmacro ${MACRO} java
  !insertmacro ${MACRO} kt
  !insertmacro ${MACRO} kts
  !insertmacro ${MACRO} scala
  !insertmacro ${MACRO} c
  !insertmacro ${MACRO} h
  !insertmacro ${MACRO} cpp
  !insertmacro ${MACRO} hpp
  !insertmacro ${MACRO} cc
  !insertmacro ${MACRO} cxx
  !insertmacro ${MACRO} cs
  !insertmacro ${MACRO} fs
  !insertmacro ${MACRO} php
  !insertmacro ${MACRO} pl
  !insertmacro ${MACRO} lua
  !insertmacro ${MACRO} swift
  !insertmacro ${MACRO} dart
  !insertmacro ${MACRO} r
  !insertmacro ${MACRO} sh
  !insertmacro ${MACRO} bash
  !insertmacro ${MACRO} zsh
  !insertmacro ${MACRO} fish
  !insertmacro ${MACRO} ps1
  !insertmacro ${MACRO} psm1
  !insertmacro ${MACRO} bat
  !insertmacro ${MACRO} cmd
  !insertmacro ${MACRO} sql
  !insertmacro ${MACRO} graphql
  !insertmacro ${MACRO} gql
  !insertmacro ${MACRO} proto
  !insertmacro ${MACRO} vue
  !insertmacro ${MACRO} svelte
  !insertmacro ${MACRO} astro
  !insertmacro ${MACRO} ipynb
  !insertmacro ${MACRO} tf
  !insertmacro ${MACRO} hcl
  !insertmacro ${MACRO} gradle
  !insertmacro ${MACRO} properties
  !insertmacro ${MACRO} lock
  !insertmacro ${MACRO} diff
  !insertmacro ${MACRO} patch
!macroend

!macro customInstall
  ; The file type Switchdesk opens.
  WriteRegStr HKCU "Software\Classes\${SWITCHDESK_PROGID}" "" "Switchdesk file"
  WriteRegStr HKCU "Software\Classes\${SWITCHDESK_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\${SWITCHDESK_PROGID}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ; The app itself, as Windows lists it under Open with / Choose another app.
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Switchdesk"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro switchdeskTypes switchdeskOpenWith
  ; Right-click a folder (or the empty space inside one): Open folder in Switchdesk.
  WriteRegStr HKCU "Software\Classes\Directory\shell\Switchdesk" "" "Open folder in Switchdesk"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Switchdesk" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Switchdesk\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Switchdesk" "" "Open folder in Switchdesk"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Switchdesk" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Switchdesk\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro switchdeskTypes switchdeskNoOpenWith
  DeleteRegKey HKCU "Software\Classes\${SWITCHDESK_PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Switchdesk"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Switchdesk"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
