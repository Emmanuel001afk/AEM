; Per-user installation by default. Android lives in LocalAppData, never in Program Files.
; Do not remove Android data or the private SDK on uninstall: the user may reinstall AEM.
!macro customInstall
  SetShellVarContext current
!macroend
