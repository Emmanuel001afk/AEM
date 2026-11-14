#!/usr/bin/env bash
# Real Android virtual-device smoke, not a replacement for Wi-Fi Direct/physical-device tests.
set -euo pipefail
fail() {
  message="Android install/launch smoke failed at line $1"
  echo "::error title=Android runtime smoke::$message"
  adb logcat -d -s AndroidRuntime:E > android-runtime.log || true
  exit 1
}
trap 'fail $LINENO' ERR
adb install -r release/app-release.apk
adb shell am start -W -n com.aem.store/.MainActivity | tee android-launch.txt
grep -q 'Status: ok' android-launch.txt
# Wait for the Capacitor WebView/React mount; process existence alone is not UI readiness.
ready=0
for attempt in $(seq 1 12); do
  adb shell pidof com.aem.store > /dev/null
  adb shell uiautomator dump /sdcard/aem-window.xml > /dev/null
  adb pull /sdcard/aem-window.xml android-window.xml > /dev/null
  if grep -qE 'text="(AEM|AEM Store|Home|Your software)' android-window.xml; then ready=1; break; fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then echo 'Accessible Store UI was not detected'; exit 1; fi
# Reinstall the SAME signed APK over itself; this does not establish cross-version update behavior.
adb install -r release/app-release.apk
adb shell am force-stop com.aem.store
adb shell am start -W -n com.aem.store/.MainActivity | tee android-relaunch.txt
grep -q 'Status: ok' android-relaunch.txt
adb shell pidof com.aem.store
printf '%s\n' '::notice title=Android runtime smoke::Signed APK installed, accessible Store UI detected, same-version reinstall and relaunch passed on API 29 x86_64 AVD. Physical transfer and update regression remain untested.'
