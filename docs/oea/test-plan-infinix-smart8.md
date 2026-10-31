# Test Plan — Infinix Smart 8 (XOS 13 Go) — Primary Validation

**Do not assume Go is cause of limitation — test actual behavior.**

## Device Setup

1. Factory reset or clear OEA data
2. Enable Developer Options → USB debugging → authorize `adb`
3. `adb shell pm has-feature android.software.freeform_window_management` → record false/true
4. Verify Android version: `adb shell getprop ro.build.version.release` → 13
5. Install OEA debug APK: `adb install oea-debug.apk`
6. Grant overlay: Settings → Apps → OEA → Display over other apps → Allow + XOS Floating windows toggle (if present)
7. Enable accessibility: Settings → Accessibility → OEA Floating → On → confirm warning
8. Disable battery optimization: XOS Settings → Battery → OEA → Unrestricted

## Stage B/D Steps (WhatsApp)

- Pre: Install WhatsApp, log in, have 2 chats
- Step 1: Open Chrome to `example.com` → open OEA workspace (swipe launcher handle) → tap WhatsApp shortcut → measure time shortcut→first chips (target ≤5s)
- Step 2: Inspect `adb shell dumpsys accessibility` → WhatsApp nodes only when fg
- Step 3: `adb shell dumpsys window windows | grep mCurrentFocus` while Chrome fg → should be Chrome
- Step 4: Try tapping OEA's WhatsApp chip while Chrome fg → expect stale banner, log `Gesture cancelled`
- Step 5: Bring WhatsApp fg → OEA window should refresh chips within 700ms → tap contact → verify navigation
- Step 6: Type "OEA test" → verify `ACTION_SET_TEXT` + send → check conversation contains message (real WhatsApp)
- Step 7: `takeScreenshot` while Chrome fg → bitmap is Chrome (screenshot test)
- Step 8: Open secure app (e.g., Settings → banking) → screenshot null → secure banner
- Step 9: Keyboard: tap entry → IME shows → type → verify focus toggle makes Chrome untouchable during IME (expected trade-off)
- Step 10: Move/resize/minimize/close OEA window → verify
- Step 11: Home/recents → verify not regressed

## Multi-window (Stage E)

- After WhatsApp passes, repeat for Messenger, then YouTube, then test 3 together per `03-multi-window.md` checks 1-8.

## Evidence to Capture

- Screen recording (both Chrome fg + OEA overlay visible)
- `logcat -s OEA-Floating OEA-Proj OEA-WA` for 30s
- `adb shell dumpsys meminfo com.oea.launcher`
- Screenshots of stale/secure banners

## Failure Handling

- If `SYSTEM_ALERT_WINDOW` denied → banner prompts, not crash
- If accessibility killed by XOS → `onUnbind` → stale banner `Not interactive — check permissions`, suggest re-enable
- If target app killed → `lastNodes` empty, banner, not stale live-window

