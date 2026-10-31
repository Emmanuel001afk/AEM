# Stage D — First Integration: WhatsApp (One App at a Time)

**Do not add second app until WhatsApp passes.** This doc is the acceptance checklist for `com.whatsapp`.

## What Was Implemented

- `AppRegistry` initially empty; `WhatsAppProjectionHandler` created but **not auto-registered** — uncomment `init { register(...) }` only after device pass
- `WhatsAppProjectionHandler.extractInteractiveNodes()` handles `contact_row`, `entry`, `send`, `conversation_recyclerview` heuristics
- `OeaProjectionController` handles `ACTION_FOCUS` + `ACTION_SET_TEXT` + send click for message flow
- Stale/secure banners, `FLAG_NOT_FOCUSABLE` toggle, OCR stub

## Acceptance Tests (must all pass on Infinix Smart 8)

| # | Test | Expected | How |
|---|---|---|---|
| 1 | Capture live interface | When WhatsApp fg, OEA window shows node-derived chips matching chat list | Open WhatsApp fg → OEA add window → verify chips = chat names from `dumpsys` |
| 2 | Tap opens conversation | Tap chip → WhatsApp navigates to chat | `onMappedTap` log `ok=true` + visual |
| 3 | Scroll | Swipe on `isScrollable` node | `dispatchSwipe` from `conversation_recyclerview` bounds |
| 4 | Type message | Tap `entry` → IME shows → type "hello" → `ACTION_SET_TEXT` | `inputField` → commit → verify `entry` node text==hello via re-dump |
| 5 | Send affects real app | Tap send → message appears in WhatsApp chat history | Re-read nodes after send, count increases, text matches |
| 6 | Foreground preservation | While Chrome fg, OEA shows stale banner, not falsely live | Open Chrome → check OEA window banner visible |
| 7 | Move/resize/expand/shrink/minimize/restore/close | All chrome buttons work without crash | Drag header, resize handle, header buttons |
| 8 | Keep using original app | Chrome remains interactive when OEA window is `FLAG_NOT_FOCUSABLE` | Scroll Chrome underlay while OEA window not focused for edit |
| 9 | Secure screen | Open banking app → screenshot null → secure banner | `takeScreenshot` log error 1 |
| 10 | Performance | Open floating app ≤5s (target, measure) | Cold launch timing from shortcut tap to first chips |
| 11 | Launcher intact | Home, recents, back still work | Press home/back with overlay present |

## Current Results (Lab, not target)

- Passed 1-5 when fg, 6-8 partially, 9-10 measured ~1.2s hot / 2.8s cold, 11 pass.
- **Not yet passed on target:** All 11 need Infinix Smart 8 manual run (see `test-plan-infinix-smart8.md`). Do not claim success until then.

## Unsupported Actions for WhatsApp (must be clear to user)

- Sending while stale (Chrome fg) — banner explains, tap triggers fast-switch (if implemented) with 1.5s switch
- Voice message hold-to-record — long-press gesture not yet mapped
- Camera capture inside WhatsApp — requires camera permission + preview (not in MVP)
- Secure disappearing messages screen — may be FLAG_SECURE
- Group call — audio focus conflicts

## How to Enable After Pass

```kotlin
// In AppRegistry.kt
init { register(WhatsAppProjectionHandler()) }
```
Then rebuild, retest multi-window.

## Memory/CPU on Go

- Poll 500ms + node tree 16 depth → ~15 MB heap, ~3% CPU on AVD. On Go, reduce to 1000ms if `isLowRamDevice` true (future).

