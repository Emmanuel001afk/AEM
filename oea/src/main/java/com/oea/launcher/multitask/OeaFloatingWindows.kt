package com.oea.launcher.multitask

import android.accessibilityservice.AccessibilityService
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationCompat
import com.oea.launcher.multitask.apps.AppProjectionHandler
import com.oea.launcher.multitask.apps.AppRegistry
import com.oea.launcher.multitask.apps.OcrFallback
import java.util.concurrent.ConcurrentHashMap

/**
 * Stage A — baseline: OEA-managed overlay and shortcut/workspace behavior.
 * This is NOT a completed third-party projection — see missing capabilities below.
 *
 * Baseline present:
 * - TYPE_APPLICATION_OVERLAY window (or TYPE_ACCESSIBILITY_OVERLAY if system allows)
 * - Header with drag/resize/minimize/close, workspace grid of app shortcuts
 * - Move/Resize/Expand/Shrink/Minimize/Restore/Close with WindowManager.updateViewLayout
 * - Up to 3 windows (MAX_WINDOWS) with lru, focus tracking to avoid input routing conflicts
 *
 * Missing / unverified before this investigation:
 * - Screenshot capture (needs BIND_ACCESSIBILITY_SERVICE + takeScreenshot API 30, verified on target)
 * - Gesture dispatch to background app (requires foreground — Android 13 drops obscured touches)
 * - Overlay touch handling vs original foreground app preservation (cannot both be touchable)
 * - Focus/keyboard InputMethod coordination (FLAG_NOT_FOCUSABLE toggling)
 * - Live sync freshness (500ms poll, stale indicator)
 *
 * Every permission/manifest change below is tied to a specific technical requirement.
 */

data class FloatingWindowSpec(
    val id: String, // UUID
    val targetPackage: String?, // null = workspace launcher, else e.g. com.whatsapp
    var x: Int,
    var y: Int,
    var width: Int,
    var height: Int,
    var minimized: Boolean = false,
    var expanded: Boolean = false,
    var lastCaptureAt: Long = 0L,
    var stale: Boolean = false,
    var secureBlocked: Boolean = false
)

object OeaFloatingWindows {

    private const val TAG = "OEA-Floating"
    const val MAX_WINDOWS = 3
    private const val CHANNEL_ID = "oea_floating"
    private const val NOTIF_ID = 7001

    private var windowManager: WindowManager? = null
    private var appContext: Context? = null
    private val windows = ConcurrentHashMap<String, View>() // id -> chrome root
    private val specs = ConcurrentHashMap<String, FloatingWindowSpec>()
    private val projectionControllers = ConcurrentHashMap<String, OeaProjectionController>()
    private var focusedWindowId: String? = null
    private val handler = Handler(Looper.getMainLooper())
    private var syncRunnable: Runnable? = null

    // Quick lookup for tests
    fun getSpec(id: String) = specs[id]
    fun getController(id: String) = projectionControllers[id]
    fun activeCount() = windows.size

    // ── Lifecycle — tied to launcher start, not on every Activity ──

    fun init(context: Context) {
        appContext = context.applicationContext
        windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createNotificationChannel(context)
        startSyncLoop()
        Log.i(TAG, "OEA floating init — maxWindows=$MAX_WINDOWS SDK=${Build.VERSION.SDK_INT}")
    }

    fun ensureForegroundNotification(service: AccessibilityService) {
        val ctx = service
        val intent = Intent(ctx, OeaFloatingWindowService::class.java) // placeholder; launcher can override
        val pi = PendingIntent.getActivity(ctx, 0, ctx.packageManager.getLaunchIntentForPackage(ctx.packageName), PendingIntent.FLAG_IMMUTABLE)
        val notif = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setContentTitle(ctx.getString(com.oea.launcher.R.string.oea_notification_title))
            .setContentText(ctx.getString(com.oea.launcher.R.string.oea_notification_text))
            .setSmallIcon(android.R.drawable.sym_def_app_icon)
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
        // On Android 14+, foregroundServiceType must be declared: specialUse
        if (Build.VERSION.SDK_INT >= 34) {
            service.startForeground(NOTIF_ID, notif, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            service.startForeground(NOTIF_ID, notif)
        }
    }

    private fun createNotificationChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ID, "OEA Floating", NotificationManager.IMPORTANCE_LOW))
        }
    }

    // ── Window creation — shortcut workspace (baseline) ──

    fun showWorkspace(context: Context): String {
        if (!Settings.canDrawOverlays(context)) {
            promptOverlayPermission(context)
            throw SecurityException("SYSTEM_ALERT_WINDOW not granted — required for OEA-managed floating workspace")
        }
        if (windows.size >= MAX_WINDOWS) {
            // LRU eviction: remove oldest non-focused
            val toRemove = specs.values.firstOrNull { it.id != focusedWindowId }?.id ?: specs.keys.first()
            removeWindow(toRemove)
            Log.w(TAG, "Max windows reached — evicted $toRemove")
        }
        val id = java.util.UUID.randomUUID().toString()
        val metrics = DisplayMetrics().also { (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getMetrics(it) }
        val spec = FloatingWindowSpec(
            id = id,
            targetPackage = null,
            x = 40,
            y = 160 + windows.size * 80, // stagger
            width = (metrics.widthPixels * 0.92).toInt(),
            height = 560,
        )
        specs[id] = spec
        val view = inflateChrome(context, spec, isWorkspace = true)
        windows[id] = view
        addToWindowManager(spec, view)
        focusedWindowId = id
        Log.i(TAG, "Workspace shown id=$id at ${spec.x},${spec.y} ${spec.width}x${spec.height}")
        return id
    }

    /** Increment D — one app at a time. First integration is WhatsApp. */
    fun addAppWindow(context: Context, targetPackage: String): String {
        if (windows.size >= MAX_WINDOWS) throw IllegalStateException("Up to $MAX_WINDOWS windows — close one first")
        if (!AppRegistry.isSupported(targetPackage)) {
            Log.w(TAG, "App $targetPackage not yet supported — only verified apps may be added (Stage D)")
            throw IllegalArgumentException("App $targetPackage not supported. Supported: ${AppRegistry.supportedPackages()}")
        }
        val id = java.util.UUID.randomUUID().toString()
        val metrics = DisplayMetrics().also { (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getMetrics(it) }
        val spec = FloatingWindowSpec(
            id = id,
            targetPackage = targetPackage,
            x = 60,
            y = 200 + windows.size * 60,
            width = (metrics.widthPixels * 0.88).toInt(),
            height = 640
        )
        specs[id] = spec
        val view = inflateChrome(context, spec, isWorkspace = false)
        windows[id] = view
        // Attach projection controller for this app
        val controller = OeaProjectionController(targetPackage, spec, view.findViewById(R.id.oea_content))
        projectionControllers[id] = controller
        addToWindowManager(spec, view)
        focusedWindowId = id
        // Launch target app *normally* (Android will bring it foreground) — then OEA attempts projection
        // This is the documented trade-off: exact foreground-preservation is blocked on stock Android 13
        launchTargetApp(context, targetPackage)
        controller.startSync()
        Log.i(TAG, "App window added id=$id pkg=$targetPackage")
        return id
    }

    private fun launchTargetApp(context: Context, pkg: String) {
        try {
            val launch = context.packageManager.getLaunchIntentForPackage(pkg)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (launch != null) context.startActivity(launch)
            else Toast.makeText(context, "Cannot launch $pkg — not installed", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.e(TAG, "launch $pkg failed: $e")
        }
    }

    // ── Chrome inflation & WindowManager ──

    private fun inflateChrome(context: Context, spec: FloatingWindowSpec, isWorkspace: Boolean): View {
        val inflater = LayoutInflater.from(context)
        // Use layout resource defined in oea/src/main/res/layout/oea_floating_window_chrome.xml
        val root = inflater.inflate(R.layout.oea_floating_window_chrome, null) as ViewGroup
        val title = root.findViewById<TextView>(R.id.oea_title)
        title.text = if (isWorkspace) "OEA Workspace" else spec.targetPackage ?: "OEA"

        // Header drag
        val header = root.findViewById<View>(R.id.oea_header)
        header.setOnTouchListener(MoveTouchListener(spec))

        // Resize
        root.findViewById<View>(R.id.oea_resize_handle).setOnTouchListener(ResizeTouchListener(spec))

        // Controls
        root.findViewById<View>(R.id.oea_minimize).setOnClickListener { minimize(spec.id) }
        root.findViewById<View>(R.id.oea_expand).setOnClickListener { expand(spec.id) }
        root.findViewById<View>(R.id.oea_close).setOnClickListener { removeWindow(spec.id) }

        // Focus handling — only one window receives projection touch at a time
        root.setOnClickListener {
            focusedWindowId = spec.id
            // Update z-order by re-adding (simpler than WindowManager reordering)
        }

        // Content: workspace shortcut grid (baseline) — actual apps show projection view
        val content = root.findViewById<FrameLayout>(R.id.oea_content)
        if (isWorkspace) {
            val grid = WorkspaceShortcutView(context).apply {
                onAppSelected = { pkg ->
                    try { addAppWindow(context, pkg) } catch (e: Exception) { Toast.makeText(context, e.message, Toast.LENGTH_SHORT).show() }
                }
            }
            content.addView(grid)
        }
        return root
    }

    private fun addToWindowManager(spec: FloatingWindowSpec, view: View) {
        val params = WindowManager.LayoutParams(
            spec.width, spec.height, spec.x, spec.y,
            if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else 2003, // legacy fallback, but TYPE_APPLICATION_OVERLAY is required
            // FLAG_NOT_FOCUSABLE allows original foreground app to remain touchable *but* then projection cannot receive keystrokes
            // We toggle this flag when EditText is focused (see OeaProjectionController)
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // Do NOT use FLAG_NOT_TOUCHABLE — OEA must receive taps in its window
        }
        windowManager?.addView(view, params)
        view.tag = params // store for updates
    }

    private fun updateLayout(spec: FloatingWindowSpec) {
        val view = windows[spec.id] ?: return
        val params = view.tag as? WindowManager.LayoutParams ?: return
        params.x = spec.x; params.y = spec.y; params.width = spec.width; params.height = spec.height
        windowManager?.updateViewLayout(view, params)
    }

    // ── Move / Resize / Expand / Shrink / Minimize / Restore / Close ──

    fun move(id: String, dx: Int, dy: Int) { specs[id]?.let { it.x += dx; it.y += dy; updateLayout(it) } }
    fun resize(id: String, dw: Int, dh: Int) { specs[id]?.let { it.width = (it.width + dw).coerceIn(220, 1080); it.height = (it.height + dh).coerceIn(180, 1800); updateLayout(it) } }
    fun expand(id: String) {
        specs[id]?.let {
            it.expanded = true
            val metrics = DisplayMetrics().also { m -> windowManager?.defaultDisplay?.getMetrics(m) }
            it.x = 0; it.y = 0; it.width = metrics.widthPixels; it.height = metrics.heightPixels
            updateLayout(it)
        }
    }
    fun shrink(id: String) {
        specs[id]?.let {
            it.expanded = false
            it.width = 500; it.height = 640
            updateLayout(it)
        }
    }
    fun minimize(id: String) {
        specs[id]?.let {
            it.minimized = true
            windows[it.id]?.findViewById<View>(R.id.oea_content)?.visibility = View.GONE
            it.height = 48 // header only
            updateLayout(it)
        }
    }
    fun restore(id: String) {
        specs[id]?.let {
            it.minimized = false
            windows[it.id]?.findViewById<View>(R.id.oea_content)?.visibility = View.VISIBLE
            it.height = 640
            updateLayout(it)
        }
    }
    fun close(id: String) = removeWindow(id)

    fun removeWindow(id: String) {
        windows[id]?.let { view ->
            try { windowManager?.removeView(view) } catch (e: Exception) { Log.w(TAG, "removeView $id: $e") }
        }
        windows.remove(id)
        specs.remove(id)
        projectionControllers[id]?.stopSync()
        projectionControllers.remove(id)
        if (focusedWindowId == id) focusedWindowId = specs.keys.firstOrNull()
        Log.i(TAG, "Removed window $id — remaining ${windows.size}")
    }

    // ── Touch helpers ──

    private class MoveTouchListener(val spec: FloatingWindowSpec) : View.OnTouchListener {
        var startX = 0f; var startY = 0f; var origX = 0; var origY = 0
        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { startX = e.rawX; startY = e.rawY; origX = spec.x; origY = spec.y; OeaFloatingWindows.focusedWindowId = spec.id; return true }
                MotionEvent.ACTION_MOVE -> { spec.x = origX + (e.rawX - startX).toInt(); spec.y = origY + (e.rawY - startY).toInt(); OeaFloatingWindows.updateLayout(spec); return true }
            }
            return false
        }
    }
    private class ResizeTouchListener(val spec: FloatingWindowSpec) : View.OnTouchListener {
        var startX = 0f; var startY = 0f; var origW = 0; var origH = 0
        override fun onTouch(v: View, e: MotionEvent): Boolean {
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { startX = e.rawX; startY = e.rawY; origW = spec.width; origH = spec.height; return true }
                MotionEvent.ACTION_MOVE -> { spec.width = (origW + (e.rawX - startX)).toInt().coerceIn(220, 1080); spec.height = (origH + (e.rawY - startY)).toInt().coerceIn(180, 1800); OeaFloatingWindows.updateLayout(spec); return true }
            }
            return false
        }
    }

    private fun promptOverlayPermission(ctx: Context) {
        Toast.makeText(ctx, ctx.getString(R.string.oea_overlay_permission_rationale), Toast.LENGTH_LONG).show()
        try { ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:${ctx.packageName}")).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }) } catch (_: Exception) {}
    }

    // ── Sync loop — screenshot freshness + stale indicator ──

    private fun startSyncLoop() {
        syncRunnable = object : Runnable {
            override fun run() {
                val now = System.currentTimeMillis()
                specs.values.forEach { spec ->
                    if (spec.targetPackage != null) {
                        val age = now - spec.lastCaptureAt
                        val shouldBeStale = age > 5000 || OeaFloatingWindowService.lastForegroundPackage != spec.targetPackage
                        if (spec.stale != shouldBeStale) {
                            spec.stale = shouldBeStale
                            windows[spec.id]?.findViewById<View>(R.id.oea_stale_banner)?.visibility = if (shouldBeStale) View.VISIBLE else View.GONE
                            if (shouldBeStale) Log.d(TAG, "Window ${spec.id} stale — age=${age}ms fg=${OeaFloatingWindowService.lastForegroundPackage} target=${spec.targetPackage}")
                        }
                    }
                }
                handler.postDelayed(this, 1000)
            }
        }
        handler.post(syncRunnable!!)
    }

    // ── Accessibility callbacks — must not falsely appear live ──

    fun onWindowStateChanged(event: AccessibilityEvent) {
        // Update stale flags quickly; projection controllers will refresh on next poll
        // If target app was closed, mark secureBlocked false but stale true until new capture
    }

    fun onContentChanged(event: AccessibilityEvent) {
        // Forward to relevant projection controller for node-tree diff
        val pkg = event.packageName?.toString() ?: return
        projectionControllers.values.forEach { if (it.targetPackage == pkg) it.onTargetContentChanged(event) }
    }

    fun onServiceInterrupted() {
        // Show unsupported state banner on all projection windows
        specs.values.forEach { spec ->
            if (spec.targetPackage != null) {
                spec.stale = true
                windows[spec.id]?.findViewById<View>(R.id.oea_stale_banner)?.apply {
                    visibility = View.VISIBLE
                    (this as TextView).text = appContext?.getString(R.string.oea_unsupported_state) ?: "Not interactive — check permissions"
                }
            }
        }
    }

    // ── Projection view placeholder — Stage B replaces shortcut grid with live bitmap + touch map ──

    // Workspace shortcut view (baseline) — lists installed apps that are *supported* (WhatsApp first)
    private class WorkspaceShortcutView(context: Context) : FrameLayout(context) {
        var onAppSelected: ((String) -> Unit)? = null
        init {
            // Simple vertical list of supported apps
            val container = android.widget.LinearLayout(context).apply { orientation = android.widget.LinearLayout.VERTICAL; setPadding(16,16,16,16) }
            AppRegistry.supportedPackages().forEach { pkg ->
                val btn = android.widget.Button(context).apply {
                    text = pkg
                    setOnClickListener { onAppSelected?.invoke(pkg) }
                }
                container.addView(btn, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { setMargins(0,8,0,8) })
            }
            if (container.childCount == 0) {
                val t = TextView(context).apply { text = "No supported apps yet — WhatsApp is first (Stage D)"; setPadding(16,16,16,16) }
                container.addView(t)
            }
            addView(container)
        }
    }
}
