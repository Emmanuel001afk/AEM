# OEA Floating App Projection — Research, POC & Implementation

**Target:** Infinix Smart 8 / XOS / Android 13 (Go) — primary validation device  
**Module:** `oea/` (library, `com.oea.launcher`)  
**Existing OEA files inspected:** `oea/src/main/java/com/oea/launcher/multitask/OeaFloatingWindowService.kt`, `OeaFloatingWindows.kt`, `oea_floating_window.xml` — **not found in repository at bd19b59** (AEM baseline). Created as new library module to host investigation; AEM Store `app/` remains untouched.

This document is the entry point for the required workflow: **Investigation → Feasibility POC → Report → Incremental implementation → Multi-window validation**. Do not claim three-window support until three real windows tested together.

## Quick Navigation

- **Stage A — Investigation:** `00-investigation.md` — confirmed facts vs hypotheses, source inspection, API docs, device constraints
- **Stage B — Feasibility POC:** `01-feasibility-poc.md` — smallest test with one real app (WhatsApp), evidence, limitations
- **Stage C — Report:** POC report is in `01-feasibility-poc.md` bottom + `AEM_TRUTH.md`
- **Stage D — Incremental:** `02-implementation-whatsapp.md` — one app at a time, acceptance checklist
- **Stage E — Multi-window:** `03-multi-window.md` — up to 3 windows concurrency
- **Test Plan:** `test-plan-infinix-smart8.md` — device-specific steps, timings, failure modes
- **Manifest justification:** `oea/src/main/AndroidManifest.xml` comments + `00-investigation.md` permission table

## Current Implementation Status (2026-10-30)

| Component | State | Evidence |
|---|---|---|
| OEA-managed overlay & shortcut workspace | **Implemented** — `OeaFloatingWindows.showWorkspace()`, move/resize/expand/shrink/minimize/restore/close, 3-window LRU | Kotlin compiles, WindowManager params verified, manual test on generic API 33 AVD (workspace shows) |
| AccessibilityService skeleton | **Implemented** — `OeaFloatingWindowService` with `canTakeScreenshot`/`canPerformGestures`/`canRetrieveWindowContent`, screenshot helper, gesture delegate | Service registers, `dumpsys accessibility` shows `com.oea.launcher/.multitask.OeaFloatingWindowService` |
| Node-tree → projection mapping | **Partial** — `OeaProjectionController` + `WhatsAppProjectionHandler` + `AppRegistry` | Node extraction works when target is foreground; fails when background (expected) |
| Screenshot capture | **Available API 30+ but limited** — `takeScreenshot(Display.DEFAULT_DISPLAY)` returns visible screen only, null on `FLAG_SECURE` | Tested on API 33 emulator: Chrome foreground → bitmap is Chrome, not background WhatsApp |
| Gesture dispatch to background | **Blocked on stock Android 13** — `dispatchGesture` cancelled with `obscured` when target not active | Log `Gesture is obscured` observed; see `00-investigation.md` AOSP source link |
| OCR fallback | **Stub** — `OcrFallback` via ML Kit TextRecognition, invoked when nodes absent | Compiles, not yet validated against WhatsApp WebView |
| Keyboard/input | **Fragile** — `FLAG_NOT_FOCUSABLE` toggle + `ACTION_SET_TEXT` works only when overlay focusable, which breaks original app focus | Measured: original app loses touch while overlay is focusable |
| Multi-window (3) | **Not yet validated** — LRU and focus tracking exist, but no 3-app coexistence test | Requires Stage E after WhatsApp passes |

**Verdict:** Baseline floating workspace is usable; genuine background projection as specified is **not achievable on stock Android 13 without privileged APIs**. See `00-investigation.md` for precise failure and `01-feasibility-poc.md` for alternative path.

## How to Verify (without claiming unperformed tests)

```bash
npm run verify              # AEM Store still builds
npm run verify:oea          # Checks oea module files, permissions, Kotlin syntax, no AEM regression
```

Real-device acceptance requires Infinix Smart 8 manual steps in `test-plan-infinix-smart8.md`. Do not mark POC complete until those steps log success.

## Protecting Existing OEA/AEM Functionality

- `app/` (AEM Store) not modified except `settings.gradle.kts` adding `include(":oea")` — does not affect `app` build unless `oea` is depended upon (it is not).
- No launcher home-screen, navigation, or database code changed.
- Changes are reversible: remove `oea/` and `include(":oea")` restores prior state.

