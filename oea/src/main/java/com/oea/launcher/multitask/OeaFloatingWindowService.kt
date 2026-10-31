package com.oea.launcher.multitask

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import java.util.concurrent.Executor

/**
 * Stage A — Confirmed facts vs hypotheses:
 *
 * CONFIRMED (source + device behavior):
 * - AccessibilityService can observe window/content changes and read node tree via getRootInActiveWindow()/getWindows().
 * - takeScreenshot() (API 30) captures the *current* default display contents, not a background app's offscreen buffer. On Infinix Smart 8 / Android 13, secure (FLAG_SECURE) windows return status 1 / null buffer. Verified via AOSP source: frameworks/base/services/accessibility.
 * - dispatchGesture() dispatches to the *active* display's touch pipeline. On Android 13, touches obscured by overlay are dropped unless FLAG_NOT_TOUCHABLE handling; background app windows are not touch targets.
 * - TYPE_APPLICATION_OVERLAY windows (with SYSTEM_ALERT_WINDOW) are the legitimate way to present OEA's own floating workspace; TYPE_ACCESSIBILITY_OVERLAY is accessibility-only and still subject to touch-obscuring rules.
 * - VirtualDisplay launch of arbitrary third-party Activity onto private display requires privileged signature/DEVICE_OWNER — not available to OEA as third-party launcher on stock XOS.
 * - Infinix Smart 8 XOS (Go) does NOT declare freeformWindowManagement; `adb shell pm has-feature android.software.freeform_window_management` returns false (tested 2025-10, documented device).
 *
 * HYPOTHESES TO VALIDATE (Stage B):
 * - Can we combine node-tree extraction + screenshot as visual projection? (POC: WhatsApp chat list node bounds → overlay buttons)
 * - Does coordinate mapping + dispatchGesture achieve real interaction while original app remains visible? (Requires target to be foreground per Android touch pipeline — hypothesis expected to FAIL, evidence needed)
 * - Does OCR fallback improve element discovery for non-exposed Canvas/WebView?
 * - Does InputMethod coordination work when overlay is focusable?
 */

class OeaFloatingWindowService : AccessibilityService() {

    companion object {
        const val TAG = "OEA-Floating-Service"
        // Used by OeaFloatingWindows.kt to check if service is alive
        var instance: OeaFloatingWindowService? = null
            private set
        // Last known foreground package (from TYPE_WINDOW_STATE_CHANGED)
        var lastForegroundPackage: String? = null
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var isForegroundPackageTracking = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // Keep service alive on Android Go — use foreground notification via OeaFloatingWindows
        OeaFloatingWindows.ensureForegroundNotification(this)
        // Lower notification timeout is already in XML (50ms) for freshness
        serviceInfo = serviceInfo.apply {
            // Ensure flags from XML are respected; do not silently add extra flags without requirement
            flags = flags or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        }
        Log.i(TAG, "Service connected. DisplayId=${resources.displayMetrics.densityDpi} SDK=${Build.VERSION.SDK_INT}")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        // Track foreground package for "original app remains visible" validation
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.toString()?.let {
                if (it != packageName) lastForegroundPackage = it
            }
            OeaFloatingWindows.onWindowStateChanged(event)
        }
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
            event.eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED) {
            OeaFloatingWindows.onContentChanged(event)
        }
        // Log for diagnostics — not for production PII; truncated
        Log.d(TAG, "event=${AccessibilityEvent.eventToString(event.eventType)} pkg=${event.packageName}")
    }

    override fun onInterrupt() {
        Log.w(TAG, "Interrupted — launcher navigation may lose accessibility sync")
        OeaFloatingWindows.onServiceInterrupted()
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        instance = null
        Log.w(TAG, "Unbound — permission revoked or battery optimization killed service (common on XOS Go)")
        OeaFloatingWindows.onServiceInterrupted()
        return super.onUnbind(intent)
    }

    // ── Capability probes — each tied to a specific requirement ──

    /** Requirement: screenshot capture for fallback (candidate mechanism). Returns null on secure screens. */
    fun captureScreenshotIfAllowed(
        onResult: (android.graphics.Bitmap?) -> Unit
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.w(TAG, "takeScreenshot requires API 30 — device is ${Build.VERSION.SDK_INT}")
            onResult(null)
            return
        }
        // takeScreenshot was added in API 30; signature uses Executor + callback
        val displayId = Display.DEFAULT_DISPLAY // required: default display, not private virtual display
        val executor = Executor { it.run() } // main thread executor for callback
        try {
            takeScreenshot(displayId, executor, object : TakeScreenshotCallback {
                override fun onSuccess(screenshot: ScreenshotResult) {
                    // screenshot.hardwareBuffer → Bitmap; screenshot.colorSpace may be null
                    // Note: This bitmap is of the *currently visible* screen, NOT background WhatsApp when Chrome is foreground.
                    // Documented limitation in docs/oea/00-investigation.md
                    val buffer = screenshot.hardwareBuffer
                    val bitmap = try {
                        // Use HardwareBuffer to Bitmap conversion (API 30)
                        android.graphics.Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                    } catch (e: Exception) {
                        Log.e(TAG, "wrapHardwareBuffer failed: $e")
                        null
                    } finally {
                        buffer.close()
                    }
                    onResult(bitmap)
                }
                override fun onFailure(errorCode: Int) {
                    // 1=ERROR_TAKE_SCREENSHOT_INTERNAL, 2=provider failed, secure window etc.
                    Log.w(TAG, "takeScreenshot failed code=$errorCode (secure=${errorCode==1})")
                    onResult(null)
                }
            })
        } catch (e: SecurityException) {
            Log.e(TAG, "Screenshot security: ${e.message} — user may have denied or OEM blocked")
            onResult(null)
        }
    }

    /** Requirement: gesture dispatch — tap/scroll in projection mapped to real app */
    fun dispatchMappedTap(screenX: Float, screenY: Float, resultCallback: (Boolean) -> Unit) {
        // Hypothesis: dispatchGesture to background app should affect it
        // Actual behavior (AOSP GestureManages): only active window receives; obscured taps are dropped.
        // We still implement for Stage B proof, with logging to prove failure mode.
        val path = Path().apply { moveTo(screenX, screenY) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 80)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        val ok = dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                Log.i(TAG, "dispatchGesture completed at $screenX,$screenY")
                resultCallback(true)
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                Log.w(TAG, "dispatchGesture cancelled at $screenX,$screenY — likely obscured/background")
                resultCallback(false)
            }
        }, null)
        if (!ok) {
            Log.w(TAG, "dispatchGesture rejected immediately — service not connected or gesture malformed")
            resultCallback(false)
        }
    }

    fun dispatchSwipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Int = 300, cb: (Boolean)->Unit = {}) {
        val path = Path().apply { moveTo(startX, startY); lineTo(endX, endY) }
        val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.toLong())).build()
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(desc: GestureDescription?) { cb(true) }
            override fun onCancelled(desc: GestureDescription?) { cb(false) }
        }, null)
    }

    // ── Node tree helpers — requirement: accessible UI interaction ──

    fun findNodeByViewId(viewId: String): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        val nodes = root.findAccessibilityNodeInfosByViewId(viewId)
        return nodes.firstOrNull().also { root.recycle() } // caller must recycle returned node
    }

    fun findNodeByText(text: String): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        val nodes = root.findAccessibilityNodeInfosByText(text)
        return nodes.firstOrNull().also { /* root not recycled if returning node that holds reference */ }
    }

    fun getInteractiveWindows(): List<android.view.accessibility.AccessibilityWindowInfo> = windows ?: emptyList()

    // ── Overlay permission check — tied to floating workspace requirement ──
    fun hasOverlayPermission(): Boolean = Settings.canDrawOverlays(this)

    // ── Diagnostic dump for docs/oea/00-investigation.md ──
    fun dumpDiagnostics(): String = buildString {
        appendLine("OEA Diagnostics — SDK=${Build.VERSION.SDK_INT} package=$packageName")
        appendLine("foreground=$lastForegroundPackage")
        appendLine("overlay=${hasOverlayPermission()}")
        appendLine("windows=${windows?.size ?: -1}")
        appendLine("rootPackage=${rootInActiveWindow?.packageName ?: "null"}")
    }
}
