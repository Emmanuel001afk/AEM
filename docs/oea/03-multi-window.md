# Stage E — Up to 3 Simultaneous Floating App Windows

**Prerequisite:** Each app must individually pass Stage D before combining. Do not claim 3-window support until 3 real app windows tested together.

## Design for Concurrency (implemented)

- `OeaFloatingWindows` tracks `windows: ConcurrentHashMap<id, View>` + `specs` + `projectionControllers`
- `MAX_WINDOWS = 3` — enforced with LRU eviction (non-focused oldest removed)
- `focusedWindowId` ensures only one window's `touchOverlay` is considered for dispatch (prevents incorrect input routing)
- Each `OeaProjectionController` has independent `Handler` + `lastBitmap` + `lastNodes` — no shared stale state
- `updateViewLayout` called per spec — no cross-window layout leak

## Tests for 3 Windows (to run after WhatsApp + 2nd + 3rd pass)

1. Open WhatsApp floating → open Messenger (com.facebook.orca) → open YouTube (com.google.android.youtube) — expect 3 windows visible
2. Tap each header → focus follows, z-order correct, no touch routed to wrong window
3. Type in WhatsApp's `entry` → verify Messenger/YouTube windows remain stale but not corrupted
4. Minimize one → others still interactive
5. Expand one to fullscreen → others still in `windows` map (not destroyed)
6. Close one → count 2, can add third again
7. Memory: check `adb shell dumpsys meminfo com.oea.launcher` < 250 MB on Go; CPU < 10%
8. Launcher stability: home/recents with 3 overlays — no SystemUI crash

## Current Status

- WhatsApp handler exists but not yet enabled (see 02-implementation-whatsapp.md)
- Messenger & YouTube handlers not yet created — must repeat Stage D per app
- **Not claimed** — doc exists to prevent premature 3-window claim

## Device-Specific Restriction

On Infinix Smart 8 Go, 3 windows may exceed memory — fallback to 2 if `isLowRamDevice` and `OeaDiagnostics` warns. Document actual max tested.

