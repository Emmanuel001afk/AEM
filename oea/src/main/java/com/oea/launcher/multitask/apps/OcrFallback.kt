package com.oea.launcher.multitask.apps

import android.graphics.Bitmap
import android.graphics.Rect
import android.util.Log
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

/**
 * Candidate mechanism: OCR + visual recognition for elements not exposed via accessibility tree.
 * OCR alone does not create interactive app — it only helps locate text fields/buttons on bitmap.
 * Used when handler.extractInteractiveNodes finds no editable/clickable nodes (e.g., WebView/Canvas).
 */
object OcrFallback {
    private const val TAG = "OEA-OCR"
    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    fun recognize(bitmap: Bitmap, onResult: (List<OcrBlock>) -> Unit, onFail: (Exception) -> Unit) {
        val image = InputImage.fromBitmap(bitmap, 0)
        recognizer.process(image)
            .addOnSuccessListener { visionText ->
                val blocks = visionText.textBlocks.map { block ->
                    OcrBlock(
                        text = block.text,
                        boundingBox = block.boundingBox ?: Rect(),
                        // Heuristic: if block contains "Send" or arrow, treat as button
                        isProbablyButton = block.text.contains("Send", true) || block.text.contains("→") || block.text.length < 12
                    )
                }
                Log.i(TAG, "OCR found ${blocks.size} blocks")
                onResult(blocks)
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "OCR failed: $e")
                onFail(e)
            }
    }
    data class OcrBlock(val text: String, val boundingBox: Rect, val isProbablyButton: Boolean)
}
