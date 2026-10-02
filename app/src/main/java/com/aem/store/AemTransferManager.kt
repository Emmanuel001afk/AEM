package com.aem.store

import android.Manifest
import android.content.*
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.p2p.*
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.*
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

data class AemTransferPeer(val name: String, val address: String)
data class AemTransferState(
    val status: String = "Ready",
    val peers: List<AemTransferPeer> = emptyList(),
    val progress: Int = 0,
    val transferredBytes: Long = 0L,
    val totalBytes: Long = 0L,
    val completed: Boolean = false
)

class AemTransferManager(private val context: Context) {
    companion object { private const val PORT = 38177 }
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(Dispatchers.IO)
    private val wifi: WifiP2pManager? = app.getSystemService(Context.WIFI_P2P_SERVICE)
    private val channel: WifiP2pManager.Channel? = wifi?.initialize(app, app.mainLooper, null)
    private var server: ServerSocket? = null
    private var sending = false
    private var selectedUris: List<Uri> = emptyList()
    private var peerList: List<AemTransferPeer> = emptyList()
    private var onState: ((AemTransferState) -> Unit)? = null
    private var state = AemTransferState()

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            when (intent.action) {
                WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> requestPeers()
                WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION -> requestConnectionInfo()
                WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> {
                    val enabled = intent.getIntExtra(WifiP2pManager.EXTRA_WIFI_STATE, WifiP2pManager.WIFI_P2P_STATE_DISABLED) == WifiP2pManager.WIFI_P2P_STATE_ENABLED
                    publish(if (enabled) "Wi-Fi Direct ready" else "Turn on Wi-Fi to use Transfer")
                }
            }
        }
    }

    fun bind(listener: (AemTransferState) -> Unit) {
        onState = listener
        val f = IntentFilter().apply {
            addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
            addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION)
        }
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("DEPRECATION") app.registerReceiver(receiver, f)
        publish("Ready")
    }

    fun close() {
        try { app.unregisterReceiver(receiver) } catch (_: Exception) {}
        stopServer()
        channel?.let { wifi?.removeGroup(it, null) }
        onState = null
    }

    fun hasPermission(): Boolean =
        if (Build.VERSION.SDK_INT >= 33)
            ContextCompat.checkSelfPermission(app, Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
        else ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    fun requiredPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    fun startReceiving() {
        if (!hasPermission()) { publish("Allow Nearby devices permission first"); return }
        if (wifi == null || channel == null) { publish("Wi-Fi Direct is unavailable on this phone"); return }
        sending = false
        publish("Creating a private transfer connection...")
        stopServer()
        wifi.createGroup(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() {
                publish("Waiting for another AEM phone to connect...")
                startServer()
            }
            override fun onFailure(reason: Int) {
                publish("Could not create transfer connection: " + reasonText(reason))
            }
        })
    }

    fun discover() {
        if (!hasPermission()) { publish("Allow Nearby devices permission first"); return }
        if (wifi == null || channel == null) { publish("Wi-Fi Direct is unavailable on this phone"); return }
        publish("Looking for nearby AEM phones...")
        wifi.discoverPeers(channel, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { publish("Nearby phones will appear below") }
            override fun onFailure(reason: Int) { publish("Discovery failed: " + reasonText(reason)) }
        })
    }

    fun chooseFiles(uris: List<Uri>) {
        selectedUris = uris
        val suffix = if (uris.size == 1) "" else "s"
        publish(if (uris.isEmpty()) "No files selected" else uris.size.toString() + " file" + suffix + " selected")
    }

    fun connectAndSend(peer: AemTransferPeer) {
        if (!hasPermission()) { publish("Allow Nearby devices permission first"); return }
        if (selectedUris.isEmpty()) { publish("Select files first"); return }
        if (wifi == null || channel == null) { publish("Wi-Fi Direct is unavailable on this phone"); return }
        sending = true
        publish("Connecting to " + peer.name + "...")
        val config = WifiP2pConfig().apply {
            deviceAddress = peer.address
            wps.setup = WpsInfo.PBC
        }
        wifi.connect(channel, config, object : WifiP2pManager.ActionListener {
            override fun onSuccess() { publish("Connection requested...") }
            override fun onFailure(reason: Int) { publish("Connection failed: " + reasonText(reason)) }
        })
    }

    private fun requestPeers() {
        if (!hasPermission() || wifi == null || channel == null) return
        wifi.requestPeers(channel) { list ->
            peerList = list.deviceList.map { AemTransferPeer(it.deviceName.ifBlank { "AEM phone" }, it.deviceAddress) }
            publish(state.status)
        }
    }

    private fun requestConnectionInfo() {
        if (!hasPermission() || wifi == null || channel == null) return
        wifi.requestConnectionInfo(channel) { info ->
            if (info.groupFormed && sending && !info.isGroupOwner) {
                val host = info.groupOwnerAddress?.hostAddress ?: return@requestConnectionInfo
                sending = false
                scope.launch { sendFiles(host) }
            }
        }
    }

    private fun startServer() {
        scope.launch {
            try {
                server = ServerSocket(PORT)
                while (!server!!.isClosed) {
                    val socket = server!!.accept()
                    receiveFiles(socket)
                    socket.close()
                }
            } catch (_: Exception) {}
        }
    }

    private suspend fun sendFiles(host: String) {
        try {
            publish("Connected. Preparing transfer...")
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, PORT), 10000)
                DataOutputStream(BufferedOutputStream(socket.getOutputStream())).use { out ->
                    out.writeInt(selectedUris.size)
                    val total = selectedUris.sumOf { contentLength(it) }
                    var done = 0L
                    publish("Sending files...", 0, done, total)
                    for (uri in selectedUris) {
                        val name = displayName(uri)
                        val length = contentLength(uri)
                        val bytes = name.toByteArray(Charsets.UTF_8)
                        out.writeInt(bytes.size)
                        out.write(bytes)
                        out.writeLong(length)
                        app.contentResolver.openInputStream(uri).use { input ->
                            if (input == null) throw IOException("Unable to read " + name)
                            val buffer = ByteArray(1024 * 64)
                            var remaining = length
                            while (remaining > 0) {
                                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                                if (n <= 0) throw IOException("File ended before transfer completed: " + name)
                                out.write(buffer, 0, n)
                                remaining -= n
                                done += n
                                publish("Sending " + name, percent(done, total), done, total)
                            }
                        }
                    }
                    out.flush()
                }
            }
            publish("Transfer completed successfully", 100, state.totalBytes, state.totalBytes, true)
        } catch (e: Exception) {
            publish("Transfer failed: " + (e.message ?: "connection interrupted"))
        }
    }

    private fun receiveFiles(socket: Socket) {
        scope.launch {
            try {
                DataInputStream(BufferedInputStream(socket.getInputStream())).use { input ->
                    val count = input.readInt().coerceIn(0, 100)
                    val dir = File(app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "AEM Transfer")
                    if (!dir.exists() && !dir.mkdirs()) throw IOException("Cannot create AEM Transfer folder")
                    val entries = ArrayList<Pair<String, Long>>(count)
                    repeat(count) {
                        val nameLen = input.readInt().coerceIn(1, 4096)
                        val nameBytes = ByteArray(nameLen)
                        input.readFully(nameBytes)
                        val name = String(nameBytes, Charsets.UTF_8).replace(Regex("[\\/:*?"<>|]"), "_").trim().ifBlank { "AEM-file" }
                        entries += name to input.readLong()
                    }
                    val total = entries.sumOf { it.second }
                    var done = 0L
                    publish("Receiving files...", 0, 0, total)
                    for ((name, length) in entries) {
                        val target = uniqueFile(dir, name)
                        FileOutputStream(target).use { out ->
                            var remaining = length
                            val buffer = ByteArray(1024 * 64)
                            while (remaining > 0) {
                                val n = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                                if (n <= 0) throw IOException("Connection ended while receiving " + name)
                                out.write(buffer, 0, n)
                                remaining -= n
                                done += n
                                publish("Receiving " + name, percent(done, total), done, total)
                            }
                        }
                    }
                    publish("Transfer received successfully", 100, done, total, true)
                }
            } catch (e: Exception) {
                publish("Receiving failed: " + (e.message ?: "connection interrupted"))
            }
        }
    }

    private fun stopServer() { try { server?.close() } catch (_: Exception) {}; server = null }
    private fun contentLength(uri: Uri): Long = try {
        app.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use {
            if (it.moveToFirst()) it.getLong(0).takeIf { n -> n >= 0 } ?: 0L else 0L
        } ?: 0L
    } catch (_: Exception) { 0L }

    private fun displayName(uri: Uri): String = try {
        app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: (uri.lastPathSegment ?: "AEM-file")
    } catch (_: Exception) { uri.lastPathSegment ?: "AEM-file" }

    private fun uniqueFile(dir: File, name: String): File {
        var file = File(dir, name)
        var i = 1
        while (file.exists()) {
            val dot = name.lastIndexOf('.')
            val base = if (dot > 0) name.substring(0, dot) else name
            val ext = if (dot > 0) name.substring(dot) else ""
            file = File(dir, base + " (" + i + ")" + ext)
            i++
        }
        return file
    }

    private fun percent(done: Long, total: Long): Int = if (total > 0) ((done * 100L) / total).toInt().coerceIn(0, 100) else 0
    private fun reasonText(reason: Int): String = when (reason) {
        WifiP2pManager.P2P_UNSUPPORTED -> "Wi-Fi Direct is not supported"
        WifiP2pManager.BUSY -> "Wi-Fi Direct is busy"
        WifiP2pManager.ERROR -> "Wi-Fi Direct reported an error"
        WifiP2pManager.NO_SERVICE_REQUESTS -> "No service request is available"
        else -> "Android error " + reason
    }

    private fun publish(status: String, progress: Int = state.progress, done: Long = state.transferredBytes, total: Long = state.totalBytes, completed: Boolean = false) {
        state = AemTransferState(status, peerList, progress, done, total, completed)
        main.post { onState?.invoke(state) }
    }
}