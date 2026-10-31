package com.oea.launcher.multitask

import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.Log

/**
 * Gesture dispatch helpers — OCR alone not interactive, dispatch alone not independent input channel.
 * This delegate centralizes mapping and logging of obscured/background failures.
 */
object OeaGestureDelegate {
    private const val TAG = "OEA-Gesture"

    fun tap(x: Float, y: Float): GestureDescription {
        val p = Path().apply { moveTo(x, y) }
        return GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(p, 0, 60)).build()
    }

    fun swipe(sx: Float, sy: Float, ex: Float, ey: Float, duration: Int = 300): GestureDescription {
        val p = Path().apply { moveTo(sx, sy); lineTo(ex, ey) }
        return GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(p, 0, duration.toLong())).build()
    }

    fun logResult(success: Boolean, x: Float, y: Float) {
        if (success) Log.i(TAG, "Gesture at $x,$y delivered")
        else Log.w(TAG, "Gesture at $x,$y cancelled — background/obscured on Android 13 (expected)")
    }
}
