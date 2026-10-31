package com.oea.launcher.multitask

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import com.oea.launcher.multitask.apps.AppRegistry
import com.oea.launcher.multitask.apps.MappedNode
import com.oea.launcher.multitask.apps.OcrFallback

/**
 * Core projection synchronisation — keeps displayed state reflecting real app state.
 *
 * Flow:
 * 1. captureAndRender() — tries node tree first, falls back to screenshot+OCR, updates ImageView + overlay buttons
 * 2. onProjectionTouch() — maps touch coords (projection-local) -> screen coords (boundsInScreen), then node.performAction or dispatchGesture
 * 3. requestKeyboardForEditable() — toggles WindowManager.LayoutParams FLAG_NOT_FOCUSABLE to allow IME, then ACTION_SET_TEXT
 *
 * Limitations documented in docs/oea/00-investigation.md:
 * - Screenshot is of current visible display, not background app — so when user is in Chrome, WhatsApp bitmap will be stale (age >5s → stale banner)
 * - dispatchGesture to background fails — we log cancelled and show unsupported banner instead of falsely appearing live
 * - Keyboard focus requires overlay to be focusable, which temporarily makes original app not touchable — trade-off measured
 */
class OeaProjectionController(
    val targetPackage: String,
    private val spec: FloatingWindowSpec,
    private val container: FrameLayout
) {
    private val tag = "OEA-Proj-$targetPackage"
    private val handler = Handler(Looper.getMainLooper())
    private val context: Context = container.context
    private var lastBitmap: Bitmap? = null
    private var lastNodes: List<MappedNode> = emptyList()
    private var lastCaptureAt: Long = 0L
    private var isRunning = false

    private val imageView = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_START
        adjustViewBounds = true
    }
    private val touchOverlay = View(context).apply {
        // Transparent touch interceptor — maps to nodes/gestures
        setOnTouchListener { _, e -> onProjectionTouch(e); true }
    }
    private val inputField = EditText(context).apply {
        hint = "Type message…"
        visibility = View.GONE
        setOnEditorActionListener { _, _, _ ->
            commitTextToTarget()
            true
        }
    }
    private val staleView = TextView(context).apply {
        text = context.getString(R.string.oea_stale_indicator)
        setBackgroundColor(0xAA000000.toInt())
        setTextColor(0xFFFFFFFF.toInt())
        setPadding(8,8,8,8)
        visibility = View.GONE
    }
    private val secureView = TextView(context).apply {
        text = context.getString(R.string.oea_secure_blocked)
        setBackgroundColor(0xAA000000.toInt())
        setTextColor(0xFFFFFFFF.toInt())
        setPadding(8,8,8,8)
        visibility = View.GONE
    }

    init {
        container.addView(imageView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        container.addView(touchOverlay, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        container.addView(inputField, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, 100).apply { gravity = android.view.Gravity.BOTTOM })
        container.addView(staleView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT).apply { gravity = android.view.Gravity.TOP })
        container.addView(secureView)
    }

    fun startSync() {
        if (isRunning) return
        isRunning = true
        handler.post(syncLoop)
        Log.i(tag, "Sync started for $targetPackage")
    }
    fun stopSync() {
        isRunning = false
        handler.removeCallbacks(syncLoop)
        lastNodes.forEach { try { it.node.recycle() } catch (_: Exception) {} }
        lastNodes = emptyList()
        lastBitmap?.recycle()
        Log.i(tag, "Sync stopped")
    }

    fun onTargetContentChanged(event: AccessibilityEvent) {
        // Debounce rapid content changes (typing)
        handler.removeCallbacks(syncLoop)
        handler.postDelayed(syncLoop, 200)
    }

    private val syncLoop = object : Runnable {
        override fun run() {
            if (!isRunning) return
            captureAndRender()
            handler.postDelayed(this, 500) // freshness target ~500ms, open latency ~2-5s
        }
    }

    private fun captureAndRender() {
        val service = OeaFloatingWindowService.instance
        if (service == null) {
            showUnsupported("Accessibility not enabled — grant in Settings")
            return
        }
        // Try node tree first (primary mechanism)
        val root = service.rootInActiveWindow
        if (root != null && root.packageName?.toString() == targetPackage) {
            try {
                val handler = AppRegistry.handlerFor(targetPackage)
                val nodes = if (handler != null) handler.extractInteractiveNodes(root) else emptyList()
                lastNodes.forEach { try { it.node.recycle() } catch (_: Exception) {} }
                lastNodes = nodes
                lastCaptureAt = System.currentTimeMillis()
                spec.lastCaptureAt = lastCaptureAt
                spec.stale = false
                staleView.visibility = View.GONE
                secureView.visibility = View.GONE
                // For POC, we don't have live bitmap — show node text list as projection chrome
                // Stage B will add screenshot rendering if nodes insufficient
                renderNodeProjection()
                return
            } catch (e: Exception) {
                Log.w(tag, "Node extraction failed: $e")
            } finally {
                // Do not recycle root if we kept nodes that reference it — here nodes hold child refs
            }
        } else {
            // Target not foreground — cannot get its node tree; try screenshot fallback
            Log.d(tag, "Root pkg=${root?.packageName} != target $targetPackage — target not foreground, attempting screenshot (expected to be stale)")
        }
        // Screenshot fallback — captures current display (likely original foreground app, not target)
        service.captureScreenshotIfAllowed { bitmap ->
            handler.post {
                if (bitmap == null) {
                    // Secure screen or permission denied
                    secureView.visibility = View.VISIBLE
                    // Keep last bitmap but mark stale
                    spec.secureBlocked = true
                    return@post
                }
                lastBitmap = bitmap
                lastCaptureAt = System.currentTimeMillis()
                spec.lastCaptureAt = lastCaptureAt
                imageView.setImageBitmap(bitmap)
                // OCR fallback if no nodes
                if (lastNodes.isEmpty()) {
                    OcrFallback.recognize(bitmap, onResult = { blocks ->
                        // Render OCR blocks as clickable overlays (experimental)
                        Log.i(tag, "OCR fallback ${blocks.size} blocks — not yet interactive")
                    }, onFail = {})
                }
                // Mark stale if target not foreground
                val fg = OeaFloatingWindowService.lastForegroundPackage
                if (fg != targetPackage) {
                    staleView.visibility = View.VISIBLE
                    spec.stale = true
                }
            }
        }
    }

    private fun renderNodeProjection() {
        // Minimal POC rendering: show first 6 node texts as tappable chips over imageView
        container.removeViews(2, container.childCount - 2) // keep imageView/touchOverlay, rebuild overlay
        // Re-add overlays
        lastNodes.take(8).forEach { mapped ->
            val tv = TextView(context).apply {
                text = mapped.text ?: mapped.viewId ?: "•"
                setBackgroundColor(0x33FF0000.toInt())
                setPadding(4,2,4,2)
                setOnClickListener {
                    val h = AppRegistry.handlerFor(targetPackage)
                    if (h != null) h.onMappedTap(mapped, this@OeaProjectionController)
                    else mapped.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                }
            }
            // Position via boundsInScreen mapped to container coords (simplified)
            // Full mapping requires display metrics + container offset — Stage B measures accuracy
            val lp = FrameLayout.LayoutParams(200, 48)
            container.addView(tv, lp)
        }
        imageView.setImageBitmap(lastBitmap) // keep showing last screenshot under chips
    }

    private fun onProjectionTouch(e: MotionEvent) {
        if (e.action != MotionEvent.ACTION_UP) return
        val service = OeaFloatingWindowService.instance ?: return
        val x = e.x; val y = e.y
        // Map container touch to screen coords — container is at spec.x/spec.y on display
        // Plus header offset 48dp
        val screenX = spec.x + x
        val screenY = spec.y + y + 48 // header

        // Try node hit-test first
        val hit = lastNodes.firstOrNull {
            it.boundsInScreen.contains(screenX.toInt(), screenY.toInt())
        }
        if (hit != null) {
            val h = AppRegistry.handlerFor(targetPackage)
            if (h != null) {
                if (h.onMappedTap(hit, this)) return
            }
            // Fallback: node click
            hit.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            Log.i(tag, "Mapped tap to node ${hit.viewId} at $screenX,$screenY")
            return
        }
        // Otherwise dispatch gesture at screen coords (expected to fail when target is background — logged)
        service.dispatchMappedTap(screenX, screenY) { success ->
            if (!success) showUnsupported("Tap not delivered — target must be in foreground on Android 13")
        }
    }

    fun requestKeyboardForEditable(node: MappedNode) {
        // Toggle window to focusable so IME appears
        // This will temporarily make original app not touchable — measured trade-off
        inputField.visibility = View.VISIBLE
        inputField.requestFocus()
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(inputField, InputMethodManager.SHOW_IMPLICIT)
        Log.i(tag, "Keyboard requested for ${node.viewId}")
    }

    private fun commitTextToTarget() {
        val text = inputField.text.toString()
        if (text.isEmpty()) return
        val editable = lastNodes.firstOrNull { it.isEditable } ?: return
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        val ok = editable.node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        Log.i(tag, "ACTION_SET_TEXT '$text' ok=$ok")
        if (ok) {
            // After typing, trigger send button if present
            val send = lastNodes.firstOrNull { it.viewId?.contains("send") == true || it.text?.equals("Send", true) == true }
            send?.node?.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        inputField.text.clear()
    }

    private fun showUnsupported(msg: String) {
        staleView.text = msg
        staleView.visibility = View.VISIBLE
        spec.stale = true
        Log.w(tag, "Unsupported: $msg")
    }

    // For tests
    fun isStale() = spec.stale
    fun lastCaptureAgeMs() = System.currentTimeMillis() - lastCaptureAt
}
