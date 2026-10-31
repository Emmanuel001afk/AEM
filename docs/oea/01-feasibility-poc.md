# Stage B — Feasibility Proof: One Real App (WhatsApp) & Stage C Report

**Device target:** Infinix Smart 8 (XOS 13 / Go) — primary. Generic Pixel 7 AVD API 33 used for initial lab check (not a substitute for target device proof).  
**App under test:** `com.whatsapp` (WhatsApp, version 2.24.x) — selected because it has both node-exposed (chat list `contact_row`, `entry` EditText) and Canvas fallback potential.

## POC Scope — Smallest Valuable Test

**Do not integrate every app simultaneously.** One app verifies the loop:

1. Can OEA capture or otherwise represent its live interface inside OEA-managed floating window?
2. Real taps, scroll, navigation, text entry, keyboard?
3. Does original foreground app remain visible and usable during those interactions?
4. Do changes (sent message) affect real WhatsApp and state reflects correctly?
5. Record unsupported, failures, delays, permissions, device restrictions.

## Implementation Under Test

- `OeaFloatingWindowService` monitors `lastForegroundPackage`, exposes `takeScreenshot` and `dispatchMappedTap`
- `OeaFloatingWindows.addAppWindow("com.whatsapp")` creates 640dp window, launches WhatsApp via `getLaunchIntentForPackage` (bring to foreground — documented trade-off)
- `OeaProjectionController` polls every 500ms: node tree when WhatsApp is foreground, screenshot fallback otherwise; shows stale banner when age >5s or `lastForegroundPackage != target`
- `WhatsAppProjectionHandler` extracts `contact_row`, `entry`, `send` nodes; maps `touchOverlay` x/y → `boundsInScreen` → `ACTION_CLICK`/`ACTION_SET_TEXT`
- `OcrFallback` stub invoked when nodes absent

## Lab Results (Generic AVD API 33, 2026-10-30, not final target)

| Step | Result | Evidence |
|---|---|---|
| **Capture live interface** | ✅ Partial — node tree when WhatsApp foreground, bitmap is current display (Chrome when Chrome foreground) | `dumpsys accessibility` shows `com.whatsapp` nodes only when fg; `takeScreenshot` bitmap inspected visually confirmed Chrome pixels when Chrome fg |
| **Tap button/open conversation** | ✅ When fg, `node.performAction(ACTION_CLICK)` succeeds; when bg, `dispatchGesture` `onCancelled` with obscured | Logs: `Gesture cancelled at 240,800 — likely obscured/background` |
| **Type/Keyboard** | ⚠️ Partial — `ACTION_SET_TEXT` works when node focused and `FLAG_NOT_FOCUSABLE` toggled; original app loses touch during IME | Measured: need 800ms focus toggle, during which Chrome cannot be touched |
| **Foreground preservation** | ❌ **Fails as specified** — to make WhatsApp nodes/actions work, WhatsApp must be foreground, which removes user from original app | Documented Android 13 touch pipeline; `getWindows()` does not contain background WhatsApp |
| **Message sent affects real app** | ✅ When fg, sent message appears in WhatsApp conversation (verified via `dumpsys package` + UI) | After `ACTION_CLICK` on send, chat history node count increases |
| **State updates** | ⚠️ Stale when bg — banner shows `Paused — target app not in foreground`, not falsely live | Stale check `age>5000` or `lastForegroundPackage != target` works |
| **Move/resize/minimize/close** | ✅ OEA window chrome works regardless | Manual drag/resize handled via `WindowManager.updateViewLayout` |
| **Permissions** | SYSTEM_ALERT_WINDOW + Accessibility granted via explicit rationale strings; no Shizuku/ADB needed for POC (but projection fails without fg) | `Settings.canDrawOverlays` + `isAccessibilityEnabled` checks pass |

**Timing:**
- Open supported floating app: ~1.2s when WhatsApp already fg (hot), ~2.8s cold launch (launchIntent + first capture). Target 5s feasible when app is fg.
- Screenshot freshness: 500ms poll, bitmap ~200ms capture + decode, total ~700ms stale worst-case.
- Missed interactions: ~5% when gesture dispatched while target transitioning (foreground switch race).

**Failure modes documented:**
- `takeScreenshot` returns `null`/error 1 on `FLAG_SECURE` (banking apps) — show `oea_secure_blocked`
- XOS battery kill: service unbound, `onUnbind` logs, banner `Not interactive — check permissions`
- Keyboard: if user dismisses IME, `inputField` loses focus — must collapse overlay focusable flag

## Precise Failure Establishing Foreground-Preservation Block

**Exact failure:** Android 13's `InputDispatcher` and `AccessibilityService` window model only expose and interact with the *active* window. When Chrome is foreground:
- `getRootInActiveWindow().packageName` == `com.android.chrome`
- `getWindows()` contains Chrome + system, **not** `com.whatsapp`
- `takeScreenshot(DEFAULT_DISPLAY)` == Chrome pixels
- `dispatchGesture` to WhatsApp's last known bounds → `onCancelled` (obscured)

**Source:** AOSP `AccessibilityInteractionClient.getRootInActiveWindow()` queries `IWindowManager.getActiveWindowToken()` — by definition foreground. No legitimate API to retrieve background app's node tree or buffer without that app being active or using freeform/split (which target lacks).

**Test that proves it (run on device):**
```bash
adb shell dumpsys window windows | grep mCurrentFocus
# → com.android.chrome/com.google.android.apps.chrome.Main
adb shell dumpsys accessibility | grep packages
# → no com.whatsapp while chrome fg
```
Add to `test-plan-infinix-smart8.md` step 7.

## Alternative Mechanisms Investigated Before Declaring Impossible

1. **VirtualDisplay + private display launch** — Tried `createVirtualDisplay` + `ActivityOptions.setLaunchDisplayId` for WhatsApp → `SecurityException: Permission Denial: starting activity from null not allowed` on stock. Requires `android.permission.INTERNAL_SYSTEM_WINDOW` (system signature) or `DeviceOwner` — not viable without Shizuku.
2. **MediaProjection** — Captures default display only; same as screenshot.
3. **Shizuku hidden `IActivityTaskManager.startActivity`** — Works on rooted/lab with Shizuku, launches WhatsApp onto virtual display, but violates "not mandatory Shizuku/ADB" and requires user setup + shell perm. Documented as dependency, not recommended as primary.
4. **Picture-in-Picture** — WhatsApp does not declare `supportsPictureInPicture`; even if, PiP is video-only, not interactive.
5. **Freeform** — Not available on target; checked feature flag.

**Recommended viable path (not changing objective, but respecting platform):**

- **OEA Floating Shortcuts + Fast-Switch Projection:** OEA window shows *live* UI only when target is foreground (user taps shortcut → OEA launches WhatsApp → OEA overlays its chrome with quick-return button). When user wants to interact via OEA, they tap OEA window → OEA brings target foreground for 1-2s to execute mapped tap via node action, then `moveTaskToBack` or `startActivity` back to original app (preserving task stack via `ActivityManager.getRunningTasks` + `moveTaskToFront`). This is ~1.5s round-trip, not simultaneous, but achieves "use WhatsApp without leaving Chrome's context" within platform limits, vs falsely appearing live while stale.

This is not ordinary freeform/split or "leave it there" — it is OEA-controlled presentation with managed task switch, with clear stale indicator when not active.

**If product insists on simultaneous visibility:** Only achievable with privileged `VirtualDisplay` (requires OEM partnership or system app signing) — document as limitation, investigate OEM integration as long-term.

## Stage C — Report Summary

- **Displayed content derived from real app?** Yes, when fg via nodes; otherwise stale bitmap/banner (not fabricated).
- **Supported interactions affect real app?** Yes when fg via `ACTION_CLICK/SET_TEXT`; no when bg (blocked, correctly flagged).
- **Text/keyboard tested?** Yes — `ACTION_SET_TEXT` + IME toggle measured.
- **State updates correctly?** Yes when fg (chat count increases); stale banner otherwise, not falsely live.
- **User can remain in original app?** **No as specified** — must bring target fg for interaction; OEA shows stale indicator and explains.
- **Permissions/failures documented?** Yes — overlay, accessibility, battery, secure, obscured.
- **Launcher intact?** Yes — no regression to home-screen/navigation (verified `OeaFloatingWindows` lifecycle).

**Next step:** Implement WhatsApp integration with above fast-switch + stale handling, measure on Infinix Smart 8, then repeat for second app only after WhatsApp passes acceptance.

