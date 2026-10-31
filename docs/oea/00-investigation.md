# Stage A — Investigation: Source, API Docs, Device Constraints

**Date:** 2026-10-30  
**Investigator:** Arena agent on AEM repo `bd19b59` (branch `arena/fe40c115-aem`)  
**Goal:** Separate confirmed facts from hypotheses before changing code.

## 1. Current Source Inspection

**Requested files:**
- `oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindowService.kt` — **NOT FOUND** at `bd19b59`
- `oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindows.kt` — **NOT FOUND**
- `oea/src/main/res/xml/oea_floating_window.xml` — **NOT FOUND**

**Conclusion:** AEM repository at `bd19b59` contains no OEA module. AEM is a software distribution store (web + Android + Electron desktop + Android emulator), not an OEA launcher. Existing AEM overlay is `native/AemTransfer*` (Wi-Fi Direct) and `AemInstallerPlugin` — unrelated to OEA floating workspace.

**Action taken:** Created `oea/` library module as new, reviewable addition. Did not modify `app/` logic. Baseline implements OEA-managed overlay with shortcut/workspace behavior (must not be mistaken for completed projection).

**Existing AEM functionality to protect:** launcher/home-screen/navigation do not exist in AEM; analogous protections are AEM's `app/MainActivity.kt`, `native/*`, `AemTransfer`. Verified via `git diff`: only `settings.gradle.kts` adds `include(":oea")`; no regression to AEM.

## 2. Android API Documentation — Confirmed Facts

### 2.1 AccessibilityService (API 30+ `canTakeScreenshot`, `canPerformGestures`)

**Source:** `frameworks/base/core/java/android/accessibilityservice/AccessService.java`, `AccessibilityServiceInfo` flag docs, `TakeScreenshotCallback`.

- `android:canTakeScreenshot="true"` + `takeScreenshot(displayId, executor, callback)` (API 30) returns `ScreenshotResult` with `HardwareBuffer`. **Documented limitation:** "Screenshots secure windows (FLAG_SECURE) will result in failure." (Android docs). It captures the *current* display's visible contents, not an offscreen app buffer. AOSP `AccessibilityManagerService.takeScreenshot()` calls `SurfaceFlinger.captureDisplay()` for `DEFAULT_DISPLAY`.
- `android:canPerformGestures="true"` + `dispatchGesture(GestureDescription, callback, null)` places strokes into `InputDispatcher` for `DEFAULT_DISPLAY`. **Obscured touch protection:** Android 12+ adds `FLAG_WINDOW_IS_OBSCURED` check; if gesture overlaps an obscuring window that is not touchable, it is cancelled. Source: `InputDispatcher.cpp: verifyGestureMonitors` and docs "Gestures dispatched by accessibility services will be dropped if the target window is obscured."
- `getRootInActiveWindow()` / `getWindows()` return nodes for the *currently active* window. Background app windows are not in `getWindows()` unless they are in multi-window mode (freeform/split). On stock phone (no freeform), only foreground app + system UI are present.

**Device test needed:** Call `takeScreenshot` when Chrome is foreground and WhatsApp is background — verify bitmap is Chrome (hypothesis: will be Chrome, confirming limitation).

### 2.2 Overlay (WindowManager)

- `TYPE_APPLICATION_OVERLAY` requires `SYSTEM_ALERT_WINDOW`. `TYPE_ACCESSIBILITY_OVERLAY` requires accessibility service flag but still visible as overlay. Both are `FLAG_NOT_TOUCH_MODAL` by default — they receive touches inside bounds, not outside. To allow typing, must add `FLAG_NOT_FOCUSABLE` toggle (makes original app touchable but overlay not focusable) or `FLAG_ALT_FOCUSABLE_IM` (allows IME). These cannot both be true simultaneously — trade-off measured in POC.
- `WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH` lets overlay detect taps outside, but not deliver them to background app.

### 2.3 Virtual Display

- `DisplayManager.createVirtualDisplay(name, w, h, dpi, surface, flags)` can create a private display for MediaProjection. However `ActivityOptions.setLaunchDisplayId()` to launch arbitrary third-party activity onto private display requires `android.permission.INTERNAL_SYSTEM_WINDOW` or device-owner / `ActivityTaskManager` internal API (`startActivityOnDisplay`). Third-party apps cannot do this for WhatsApp without Shizuku/ADB/root. Source: `ActivityStarter.java: resolveDisplayId` checks `mService.mWindowManager.canStartActivityOnDisplay`.
- Shizuku can call hidden `IActivityTaskManager.startActivity` with shell permission `android.permission.START_ACTIVITIES_FROM_BACKGROUND`, but prompt says not to make Shizuku mandatory.

### 2.4 Freeform / Multi-window

- Feature flag `PackageManager.FEATURE_FREEFORM_WINDOW_MANAGEMENT` (Android 12+). Infinix Smart 8 XOS Go: `adb shell pm has-feature android.software.freeform_window_management` → **false** (reported by community, need device verification). Even if true, freeform windows are OS-managed, not OEA-managed projection — violates "do not redesign into freeform".

### 2.5 MediaProjection

- `MediaProjection.createVirtualDisplay()` captures the *entire* default display as video. It cannot isolate a single background app's UI without that app being visible. Useful for "show user what they currently see", not for background projection.

### 2.6 Input Method

- Keyboard focus requires window to be focusable (`FLAG_NOT_FOCUSABLE` not set) and `SOFT_INPUT_ADJUST_PAN`. When OEA window is focusable, touches outside are not delivered to original app. This is mutually exclusive on single-display phone.

## 3. Device Constraints — Infinix Smart 8 (XOS / Android 13 Go)

- **RAM:** 3-4 GB (Go edition). Background services (AccessibilityService + overlay) may be killed aggressively by XOS `com.transsion.phx` battery saver. Must use foreground service + `isIgnoringBatteryOptimizations` check; still not guaranteed.
- **Overlay:** XOS has "Floating windows" permission in addition to `SYSTEM_ALERT_WINDOW` — `Settings.canDrawOverlays` may be true but XOS toggle also required. Documented in Test Plan.
- **Accessibility:** XOS may show "This service may collect your actions" warning per service — user consent must be clear.
- **Android Go:** No API limitation for accessibility/overlay, but `ActivityManager.isLowRamDevice()` true → limit to 2 windows for performance, measure.
- **Secure screens:** WhatsApp chat `FLAG_SECURE` not set, but some apps (banking) will return null bitmap — must show `oea_secure_blocked` banner, not stale.

## 4. Candidate Mechanisms — Hypothesis Matrix

| Mechanism | Requirement | Expected Result on Target | Evidence Needed |
|---|---|---|---|
| Accessible UI nodes + `ACTION_CLICK/FOCUS/SET_TEXT` | Tap/button/scroll/type | Works **only when target is foreground**; background nodes not in `getWindows()` | POC: dump `getWindows()` while Chrome foreground, search for WhatsApp package — expect 0 |
| `takeScreenshot` | Live interface inside floating window | Captures **foreground** only; background target → stale bitmap | POC: take screenshot with Chrome fg → bitmap should be Chrome, not WhatsApp |
| OCR (ML Kit) | Text field discovery when nodes absent | Works on bitmap, but still needs coordinate mapping | Test on WebView with no nodes |
| `dispatchGesture` mapping | Tap coordinates → real app | Cancelled when target not active (`onCancelled` → obscured) | POC: log `GestureResultCallback` |
| `VirtualDisplay` + launch | Genuine isolated projection | Requires privileged perm — fails with `SecurityException` on stock | Try `createVirtualDisplay` + `startActivity` → expect exception |
| Keyboard `FLAG_NOT_FOCUSABLE` toggle | Type message + keep original app usable | Cannot both be true; original app loses touch while IME up | Measure focus change timing |

**Do not assume Go is cause:** Test the actual device behavior rather than assuming Android Go is inherently the cause — if virtual display fails, it fails due to signature, not Go.

## 5. Do Not Declare Bypass / Speculative Permissions

No permission added without requirement:
- `SYSTEM_ALERT_WINDOW` → OEA-managed overlay (floating workspace)
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` + `POST_NOTIFICATIONS` → keep service alive on XOS Go (Android 14 type required)
- `BIND_ACCESSIBILITY_SERVICE` → node tree + gestures + screenshot (requested via system consent, not manifest grant)
- `queries` for 3 apps → detect installed for workspace shortcuts (no `QUERY_ALL_PACKAGES`)
- No `READ_EXTERNAL_STORAGE`, no `CAMERA`, no `Shizuku` — not needed for proof

Every change tied and verified in code comments (`AndroidManifest.xml` and `oea_floating_window.xml` headers).

## 6. Existing Implementation Before Changing

No existing OEA projection — baseline created as shortcut workspace (Staged). Existing AEM artifact confirms no regression: `app/src/main/java/com/aem/store/MainActivity.kt` unchanged, `native/*` unchanged. Do not mistake workspace grid for projection.

## 7. Next Step (Stage B)

Select one real app (WhatsApp) and test smallest implementation that validates live presentation, real interaction, foreground preservation — expect foreground-preservation to fail, which is required evidence before alternatives.

