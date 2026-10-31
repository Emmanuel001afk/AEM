package com.oea.launcher.multitask.apps

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import android.util.Log

/**
 * Stage D — First integration: WhatsApp (com.whatsapp)
 * Validate: capture, real tap/scroll/type, keyboard, foreground preservation, launcher stability.
 *
 * WhatsApp-specific node heuristics (may vary by version/XOS):
 * - Chat list items: resourceId contains "contact_row" or text is contact name, clickable
 * - Message input: className EditText, viewId "com.whatsapp:id/entry", editable
 * - Send button: viewId "com.whatsapp:id/send" or contentDescription "Send", clickable
 * - Conversation scroll: node with isScrollable + viewId "com.whatsapp:id/conversation_recyclerview"
 *
 * NOTE: These IDs are not guaranteed — validated on WhatsApp 2.24.x via UIAutomator dump.
 * Document failures per XOS/WhatsApp version in docs/oea/01-feasibility-poc.md
 */
class WhatsAppProjectionHandler : AppProjectionHandler {
    override val targetPackage = "com.whatsapp"
    override val displayName = "WhatsApp"

    override fun extractInteractiveNodes(root: AccessibilityNodeInfo): List<MappedNode> {
        val out = mutableListOf<MappedNode>()
        collect(root, out, depth = 0)
        Log.i("OEA-WA", "Extracted ${out.size} interactive nodes for WhatsApp")
        return out
    }

    private fun collect(node: AccessibilityNodeInfo, out: MutableList<MappedNode>, depth: Int) {
        if (depth > 16) return // prevent stack overflow on deep trees (XOS WebView)
        val rect = Rect(); node.getBoundsInScreen(rect)
        val isClickable = node.isClickable
        val isEditable = node.className?.toString()?.contains("EditText") == true
        val isScrollable = node.isScrollable
        val text = node.text?.toString() ?: node.contentDescription?.toString()
        val viewId = try { node.viewIdResourceName } catch (_: Exception) { null }

        // Heuristic: consider node interactive if any of these
        if ((isClickable || isEditable || isScrollable) && !rect.isEmpty && rect.width() > 8 && rect.height() > 8) {
            out.add(MappedNode(node, rect, text, viewId, isEditable, isClickable, isScrollable))
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            collect(child, out, depth + 1)
            // Do NOT recycle here — MappedNode holds reference; caller recycles
        }
    }

    override fun onMappedTap(node: MappedNode, controller: com.oea.launcher.multitask.OeaProjectionController): Boolean {
        // Requirement: tap must affect real WhatsApp, not just local UI
        return try {
            when {
                node.isEditable -> {
                    // Focus + show keyboard — requires overlay window to toggle to focusable
                    val focused = node.node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    val clicked = node.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    Log.i("OEA-WA", "Editable tap focused=$focused clicked=$clicked id=${node.viewId}")
                    controller.requestKeyboardForEditable(node)
                    true
                }
                node.isClickable -> {
                    val ok = node.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    Log.i("OEA-WA", "Click ${node.viewId} text=${node.text} ok=$ok")
                    ok
                }
                node.isScrollable -> {
                    // Swipe gesture will be dispatched via controller.dispatchScroll — not node action
                    false
                }
                else -> false
            }
        } catch (e: Exception) {
            Log.e("OEA-WA", "onMappedTap failed: $e")
            false
        }
    }
}
