!macro customHeader
  !system "echo AEM Store installer custom header"
!macroend
!macro customInstall
  SetOutPath "$INSTDIR\resources"
  File /oname=README.txt "${BUILD_RESOURCES_DIR}\README.txt"
!macroend
