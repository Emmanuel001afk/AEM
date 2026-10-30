!macro customHeader
  !system "echo AEM Store installer custom header"
!macroend
!macro customInstall
  File /oname=$INSTDIR\resources\README.txt "${BUILD_RESOURCES_DIR}\README.txt"
!macroend
