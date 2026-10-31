package com.oea.launcher.multitask.apps

/**
 * Stage D — incremental app support, one at a time.
 * Do NOT add every app simultaneously. Each entry must pass acceptance tests on Infinix Smart 8.
 */
object AppRegistry {
    // Supported packages — only those that have passed Stage D validation
    private val handlers = mutableMapOf<String, AppProjectionHandler>()

    fun isSupported(pkg: String) = handlers.containsKey(pkg)
    fun supportedPackages(): List<String> = handlers.keys.toList()
    fun handlerFor(pkg: String): AppProjectionHandler? = handlers[pkg]

    // ── Bootstrap — Stage D step 1: WhatsApp proof of concept ──
    // Only register after `whatsapp` has passed:
    // - live presentation inside OEA window (not static)
    // - tap/scroll/type affect real WhatsApp and state updates
    // - keyboard works
    // - limitations documented
    // - launcher not regressed
    // Uncomment after POC passes on Infinix Smart 8:
    // init { register(WhatsAppProjectionHandler()) }

    fun register(handler: AppProjectionHandler) {
        require(handlers.size < 3) { "Up to 3 windows supported — multi-window validation must pass first" }
        handlers[handler.targetPackage] = handler
    }

    // For tests: allow mock registration
    fun registerForTest(handler: AppProjectionHandler) { handlers[handler.targetPackage] = handler }
    fun clearForTest() { handlers.clear() }
}

interface AppProjectionHandler {
    val targetPackage: String // e.g. "com.whatsapp"
    val displayName: String
    // Return true if node tree should be used vs screenshot+OCR
    fun prefersNodes(): Boolean = true
    // Given root node, extract interactive elements for projection mapping
    fun extractInteractiveNodes(root: android.view.accessibility.AccessibilityNodeInfo): List<MappedNode>
    // Handle send message etc. — must affect real app
    fun onMappedTap(node: MappedNode, controller: com.oea.launcher.multitask.OeaProjectionController): Boolean
}

data class MappedNode(
    val node: android.view.accessibility.AccessibilityNodeInfo,
    val boundsInScreen: android.graphics.Rect,
    val text: String?,
    val viewId: String?,
    val isEditable: Boolean,
    val isClickable: Boolean,
    val isScrollable: Boolean,
    // For OCR fallback
    val ocrText: String? = null
)
