package com.aem.store

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pDeviceList
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

data class AemTransferPeer(
    val address: String,
    val name: String,
)

data class AemTransferState(
    val status: String = "Ready",
    val progress: Int = 0,
    val totalBytes: Long = 0L,
    val peers: List<AemTransferPeer> = emptyList(),
)

object AemApkInstaller {
    private const val MAX_APK_BYTES = 2L * 1024L * 1024L * 1024L

    fun installUri(context: Context, uri: Uri) {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "content" && scheme != "file") {
            Toast.makeText(context, "Unsupported package URI scheme", Toast.LENGTH_SHORT).show()
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return
        }

        val staged = File(context.cacheDir, "aem-incoming-${System.currentTimeMillis()}.apk")
        try {
            val stream = context.contentResolver.openInputStream(uri)
                ?: throw IllegalStateException("Cannot read package stream")
            stream.use { input ->
                FileOutputStream(staged).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val n = input.read(buffer)
                        if (n < 0) break
                        total += n
                        if (total > MAX_APK_BYTES) throw IllegalStateException("Package exceeds 2 GB safety limit")
                        if (n > 0) output.write(buffer, 0, n)
                    }
                }
            }
            val flags = if (Build.VERSION.SDK_INT >= 28) {
                PackageManager.GET_SIGNING_CERTIFICATES
            } else {
                @Suppress("DEPRECATION")
                PackageManager.GET_SIGNATURES
            }
            val info = context.packageManager.getPackageArchiveInfo(staged.absolutePath, flags)
                ?: throw IllegalStateException("File is not a valid Android APK")
            if (info.packageName.isNullOrBlank()) {
                throw IllegalStateException("APK has no package identity")
            }
            val shareUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", staged)
            val install = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(shareUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(install)
        } catch (e: Exception) {
            staged.delete()
            Toast.makeText(context, e.message ?: "Unable to open APK", Toast.LENGTH_LONG).show()
        }
    }
}

class AemTransferManager(private val context: Context) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var listener: ((AemTransferState) -> Unit)? = null
    private var state = AemTransferState()
    private val selectedUris = mutableListOf<Uri>()
    private var manager: WifiP2pManager? = null
    private var channel: WifiP2pManager.Channel? = null
    private var receiver: BroadcastReceiver? = null

    fun bind(onState: (AemTransferState) -> Unit) {
        listener = onState
        onState(state)
        if (manager == null) {
            manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
            channel = manager?.initialize(context, Looper.getMainLooper(), null)
        }
        if (receiver == null && manager != null) {
            val r = object : BroadcastReceiver() {
                @SuppressLint("MissingPermission")
                override fun onReceive(ctx: Context, intent: Intent) {
                    if (intent.action == WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION && hasPermission()) {
                        manager?.requestPeers(channel) { list: WifiP2pDeviceList ->
                            val found = list.deviceList.map { d ->
                                AemTransferPeer(d.deviceAddress ?: "", d.deviceName?.ifBlank { d.deviceAddress } ?: "Nearby phone")
                            }.filter { it.address.isNotBlank() }
                            update(state.copy(peers = found, status = if (found.isEmpty()) "Scanning nearby…" else "Found ${found.size} device(s)"))
                        }
                    }
                }
            }
            receiver = r
            val filter = IntentFilter().apply {
                addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
            }
            if (Build.VERSION.SDK_INT >= 33) {
                context.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
            } else {
                context.registerReceiver(r, filter)
            }
        }
    }

    fun close() {
        receiver?.let {
            try {
                context.unregisterReceiver(it)
            } catch (_: Exception) {
            }
        }
        receiver = null
        listener = null
    }

    fun requiredPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    fun hasPermission(): Boolean =
        requiredPermissions().all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    fun chooseFiles(uris: List<Uri>) {
        selectedUris.clear()
        selectedUris.addAll(uris)
        update(state.copy(status = "${selectedUris.size} file(s) selected"))
    }

    @SuppressLint("MissingPermission")
    fun discover() {
        if (!hasPermission()) {
            update(state.copy(status = "Grant nearby Wi-Fi permission first"))
            return
        }
        val mgr = manager ?: return update(state.copy(status = "Wi-Fi Direct unavailable on this device"))
        val ch = channel ?: return
        mgr.discoverPeers(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                update(state.copy(status = "Scanning for nearby AEM phones…"))
            }

            override fun onFailure(reason: Int) {
                update(state.copy(status = "Peer scan unavailable (code $reason)"))
            }
        })
    }

    @SuppressLint("MissingPermission")
    fun connectAndSend(peer: AemTransferPeer) {
        if (!hasPermission() || selectedUris.isEmpty()) {
            update(state.copy(status = "Select files and grant nearby permission first"))
            return
        }
        val mgr = manager ?: return
        val ch = channel ?: return
        val cfg = WifiP2pConfig().apply { deviceAddress = peer.address }
        mgr.connect(ch, cfg, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                update(state.copy(status = "Connecting to ${peer.name}…"))
            }

            override fun onFailure(reason: Int) {
                update(state.copy(status = "Could not connect to ${peer.name} (code $reason)"))
            }
        })
    }

    @SuppressLint("MissingPermission")
    fun startReceiving() {
        if (!hasPermission()) {
            update(state.copy(status = "Grant nearby Wi-Fi permission first"))
            return
        }
        val mgr = manager ?: return update(state.copy(status = "Wi-Fi Direct unavailable"))
        val ch = channel ?: return
        mgr.createGroup(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                update(state.copy(status = "Ready to receive on Wi-Fi Direct"))
            }

            override fun onFailure(reason: Int) {
                update(state.copy(status = "Receiver setup failed (code $reason)"))
            }
        })
    }

    private fun update(next: AemTransferState) {
        state = next
        mainHandler.post { listener?.invoke(next) }
    }
}

internal fun sha256Hex(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(64 * 1024)
    file.inputStream().buffered().use { input ->
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            if (n > 0) md.update(buf, 0, n)
        }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
}
