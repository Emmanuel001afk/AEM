package com.aem.store

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext

private data class StoreApp(
    val name:String,val description:String,val category:String,val source:String,
    val functionality:List<String>,val permissions:List<String>,val platform:String,
    val packageName:String?,val downloadUrl:String?,val versionCode:Long?=null,val versionName:String?=null,
    val signingCertificateSha256:String?=null,val sha256:String?=null,val sourceUpdatedAtMs:Long?=null
)

private fun parseIsoMillis(raw:String?):Long {
    if (raw.isNullOrBlank()) return 0L
    return try { java.time.Instant.parse(raw).toEpochMilli() } catch(_:Exception) { 0L }
}

private fun optNullableLong(obj:JSONObject,key:String):Long? {
    return if (obj.has(key) && !obj.isNull(key)) obj.optLong(key, Long.MIN_VALUE).takeIf { it != Long.MIN_VALUE } else null
}

private fun isX86_64ApkName(filename:String):Boolean = Regex("(^|[-_.])(x86_64|amd64)([-. _]|$)", RegexOption.IGNORE_CASE).containsMatchIn(filename)
private fun isDebugApkName(filename:String):Boolean = Regex("(^|[-_. ])debug([-. _]|$)", RegexOption.IGNORE_CASE).containsMatchIn(filename)
private fun devicePrefersX86_64():Boolean = Build.SUPPORTED_ABIS.firstOrNull()?.contains("x86_64", ignoreCase = true) == true

private const val RECEIPT_PREFS = "aem_store_receipts"
private fun saveApkReceipt(context:Context, pkg:String, sha256:String?, versionCode:Long?) {
    if (pkg.isBlank() || sha256.isNullOrBlank() || versionCode == null) return
    context.getSharedPreferences(RECEIPT_PREFS, Context.MODE_PRIVATE).edit()
        .putString("sha_$pkg", sha256.lowercase())
        .putLong("vc_$pkg", versionCode)
        .putLong("ts_$pkg", System.currentTimeMillis())
        .apply()
}
private fun hasMatchingApkReceipt(context:Context, pkg:String, app:StoreApp):Boolean {
    val expectedSha = app.sha256?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return false
    val prefs = context.getSharedPreferences(RECEIPT_PREFS, Context.MODE_PRIVATE)
    val savedSha = prefs.getString("sha_$pkg", null)?.lowercase() ?: return false
    val savedVc = prefs.getLong("vc_$pkg", Long.MIN_VALUE)
    return savedSha == expectedSha && (app.versionCode == null || savedVc == app.versionCode)
}

private data class DownloadRow(val id:Long,val title:String,val status:String,val progress:Int,val bytes:Long,val total:Long)
private fun currentDownloads(context:Context):List<DownloadRow>{
    val dm=context.getSystemService(DownloadManager::class.java) ?: return emptyList()
    val out=mutableListOf<DownloadRow>()
    dm.query(DownloadManager.Query()).use { cur ->
        while(cur.moveToNext()){
            val id=cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_ID))
            val title=cur.getString(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)) ?: "AEM download"
            val statusCode=cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val bytes=cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val total=cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
            val progress=if(total>0)((bytes*100)/total).toInt().coerceIn(0,100) else 0
            val status=when(statusCode){DownloadManager.STATUS_PENDING->"Queued";DownloadManager.STATUS_RUNNING->"Downloading";DownloadManager.STATUS_PAUSED->"Paused";DownloadManager.STATUS_SUCCESSFUL->"Completed";DownloadManager.STATUS_FAILED->"Failed";else->"Unknown"}
            out += DownloadRow(id,title,status,progress,bytes,total)
        }
    }
    return out
}

private const val AEM_SUPABASE_URL="https://zaaauldrktvytskerpmc.supabase.co"
private const val AEM_SUPABASE_KEY="sb_publishable_qpMgky-A6dJCU00F-dE4WA_SS_JQBQv"

private suspend fun loadRemoteApps():List<StoreApp> = withContext(Dispatchers.IO) {
    val url=URL(AEM_SUPABASE_URL+"/rest/v1/applications?select=*,releases(*,artifacts(*))&order=name.asc")
    val conn=url.openConnection() as HttpURLConnection
    conn.setRequestProperty("apikey",AEM_SUPABASE_KEY)
    conn.setRequestProperty("Authorization","Bearer "+AEM_SUPABASE_KEY)
    conn.setRequestProperty("Cache-Control","no-cache")
    conn.useCaches=false
    conn.connectTimeout=10000
    conn.readTimeout=15000
    val preferX86 = devicePrefersX86_64()
    val androidKinds = setOf("apk","apks","xapk","apkm")
    fun pickArtifact(r:JSONObject):JSONObject? {
        val arts = r.optJSONArray("artifacts") ?: JSONArray()
        var bestArt:JSONObject? = null
        var bestScore = Long.MIN_VALUE
        var bestNonDebug = -1
        var bestAbiMatch = -1
        var bestTs = Long.MIN_VALUE
        for (k in 0 until arts.length()) {
            val z = arts.getJSONObject(k)
            val platform = z.optString("platform", "android").lowercase()
            val kind = z.optString("kind").lowercase()
            val status = z.optString("signing_status", "ready").lowercase()
            val dl = z.optString("download_url")
            if (platform != "android" || kind !in androidKinds || status != "ready" || !dl.startsWith("https://", ignoreCase = true)) continue
            val vc = optNullableLong(z, "version_code") ?: optNullableLong(r, "version_code") ?: 0L
            val fname = z.optString("filename")
            val nonDebug = if (isDebugApkName(fname)) 0 else 1
            val isX86 = isX86_64ApkName(fname)
            val abiMatch = if (preferX86) (if (isX86) 1 else 0) else (if (isX86) 0 else 1)
            val ts = maxOf(parseIsoMillis(z.optString("source_updated_at")), parseIsoMillis(r.optString("published_at")))
            val better = bestArt == null ||
                vc > bestScore ||
                (vc == bestScore && abiMatch > bestAbiMatch) ||
                (vc == bestScore && abiMatch == bestAbiMatch && nonDebug > bestNonDebug) ||
                (vc == bestScore && abiMatch == bestAbiMatch && nonDebug == bestNonDebug && ts > bestTs)
            if (better) {
                bestArt = z; bestScore = vc; bestAbiMatch = abiMatch; bestNonDebug = nonDebug; bestTs = ts
            }
        }
        return bestArt
    }
    try {
        if(conn.responseCode !in 200..299) return@withContext emptyList()
        val body=conn.inputStream.bufferedReader().use{it.readText()}
        val rows=JSONArray(body)
        buildList {
            for(i in 0 until rows.length()){
                val a=rows.getJSONObject(i)
                val releases=a.optJSONArray("releases") ?: JSONArray()
                var bestRelease:JSONObject?=null
                var bestApk:JSONObject?=null
                var bestVersion=Long.MIN_VALUE
                var bestAbiMatch=-1
                var bestNonDebug=-1
                var bestTime=Long.MIN_VALUE
                for(j in 0 until releases.length()){
                    val r=releases.getJSONObject(j)
                    if(r.optString("status")!="published") continue
                    val candidateApk = pickArtifact(r) ?: continue
                    val releaseVersion = maxOf(
                        optNullableLong(candidateApk, "version_code") ?: Long.MIN_VALUE,
                        optNullableLong(r, "version_code") ?: Long.MIN_VALUE
                    )
                    val fname = candidateApk.optString("filename")
                    val abiMatch = if (preferX86) (if (isX86_64ApkName(fname)) 1 else 0) else (if (isX86_64ApkName(fname)) 0 else 1)
                    val nonDebug = if (isDebugApkName(fname)) 0 else 1
                    val t = maxOf(
                        parseIsoMillis(candidateApk.optString("source_updated_at")),
                        parseIsoMillis(r.optString("published_at")),
                        parseIsoMillis(r.optString("created_at"))
                    )
                    val better = bestRelease == null ||
                        releaseVersion > bestVersion ||
                        (releaseVersion == bestVersion && abiMatch > bestAbiMatch) ||
                        (releaseVersion == bestVersion && abiMatch == bestAbiMatch && nonDebug > bestNonDebug) ||
                        (releaseVersion == bestVersion && abiMatch == bestAbiMatch && nonDebug == bestNonDebug && t > bestTime)
                    if (better) {
                        bestRelease = r; bestApk = candidateApk; bestVersion = releaseVersion; bestAbiMatch = abiMatch; bestNonDebug = nonDebug; bestTime = t
                    }
                }
                val r = bestRelease ?: continue
                val z = bestApk ?: continue
                val pkgIdentity = z.optString("package_identity").takeIf { it.isNotBlank() }
                    ?: a.optString("package_identity").takeIf { it.isNotBlank() }
                val resolvedVerCode = optNullableLong(z, "version_code") ?: optNullableLong(r, "version_code")
                val resolvedVerName = z.optString("artifact_version_name").takeIf { it.isNotBlank() }
                    ?: r.optString("version_name").takeIf { it.isNotBlank() }
                val updatedMs = maxOf(parseIsoMillis(z.optString("source_updated_at")), parseIsoMillis(r.optString("published_at"))).takeIf { it > 0L }
                add(StoreApp(a.optString("name"),a.optString("description"),a.optString("category","Other"),
                    "Published APK · "+a.optString("project"),listOf("Android APK","Published release"),
                    emptyList(),"Android",pkgIdentity,
                    z.optString("download_url").takeIf{it.startsWith("https://",ignoreCase=true)},
                    resolvedVerCode,resolvedVerName,
                    z.optString("signing_certificate_sha256").takeIf{it.isNotBlank()},
                    z.optString("sha256").takeIf{it.isNotBlank()},
                    updatedMs))
            }
        }
    } finally { conn.disconnect() }
}

private fun installedSigningSha256(context:Context,pkg:String):String? {
    return try {
        val info=context.packageManager.getPackageInfo(pkg,PackageManager.GET_SIGNING_CERTIFICATES)
        val signatures=if(Build.VERSION.SDK_INT>=28) info.signingInfo?.apkContentsSigners else info.signatures
        signatures?.firstOrNull()?.let { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { b->"%02x".format(b) } }
    } catch(_:Exception) { null }
}

private fun installedState(context:Context, app:StoreApp):String {
    val pkg=app.packageName ?: return "INSTALL"
    return try {
        val info=context.packageManager.getPackageInfo(pkg,0)
        val installed=if(Build.VERSION.SDK_INT>=28) info.longVersionCode else info.versionCode.toLong()
        if(app.signingCertificateSha256!=null) {
            val actual=installedSigningSha256(context,pkg)
            if(actual!=null && !actual.equals(app.signingCertificateSha256,true)) return "INCOMPATIBLE"
        }
        when {
            app.versionCode!=null && installed<app.versionCode -> "UPDATE"
            app.versionCode!=null && installed>app.versionCode -> "CURRENT"
            app.versionCode!=null && installed==app.versionCode -> {
                val updatedAt = app.sourceUpdatedAtMs
                if (updatedAt != null && !hasMatchingApkReceipt(context, pkg, app) && updatedAt - info.lastUpdateTime > 120_000L) "UPDATE" else "OPEN"
            }
            else -> "OPEN"
        }
    } catch(_:Exception) { "INSTALL" }
}

class MainActivity: ComponentActivity() {
    private val pendingDownloads = mutableMapOf<Long, Pair<StoreApp, File>>()
    private var pendingPermissionDownloadId: Long? = null
    private var pendingIncomingUri: Uri? = null
    private var downloadManager:DownloadManager? = null
    private lateinit var transferManager: AemTransferManager
    private var transferState by mutableStateOf(AemTransferState())
    private var refreshGeneration by mutableIntStateOf(0)

    private val packageChangeReceiver = object: BroadcastReceiver() {
        override fun onReceive(context:Context, intent:Intent) {
            refreshGeneration++
        }
    }

    private val downloadReceiver = object: BroadcastReceiver() {
        override fun onReceive(context:Context,intent:Intent) {
            if(intent.action == DownloadManager.ACTION_DOWNLOAD_COMPLETE) {
                val id=intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID,-1L)
                val entry = pendingDownloads[id] ?: return
                val status=downloadManager?.query(DownloadManager.Query().setFilterById(id))
                status?.use { if(it.moveToFirst()) {
                    val column=it.getColumnIndex(DownloadManager.COLUMN_STATUS)
                    if(column>=0 && it.getInt(column)==DownloadManager.STATUS_SUCCESSFUL) {
                        if (verifyDownloadedApk(entry.second, entry.first)) {
                            pendingDownloads.remove(id)
                            entry.first.packageName?.let { pkg -> saveApkReceipt(context, pkg, entry.first.sha256, entry.first.versionCode) }
                            installDownloadedApk(id, entry.second)
                            refreshGeneration++
                        } else {
                            pendingDownloads.remove(id)
                            entry.second.delete()
                            Toast.makeText(context, "Package verification failed for ${entry.first.name}", Toast.LENGTH_LONG).show()
                        }
                    } else if (column >= 0 && it.getInt(column) == DownloadManager.STATUS_FAILED) {
                        pendingDownloads.remove(id)
                    }
                } }
            }
        }
    }

    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState)
        transferManager = AemTransferManager(this)
        transferManager.bind { transferState = it }
        if (savedInstanceState == null) handleIncomingInstall(intent)
        downloadManager=getSystemService(DownloadManager::class.java)
        if(Build.VERSION.SDK_INT >= 33) registerReceiver(downloadReceiver,IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),Context.RECEIVER_NOT_EXPORTED) else registerReceiver(downloadReceiver,IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE))
        val pkgFilter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REPLACED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addDataScheme("package")
        }
        if(Build.VERSION.SDK_INT >= 33) registerReceiver(packageChangeReceiver, pkgFilter, Context.RECEIVER_EXPORTED) else registerReceiver(packageChangeReceiver, pkgFilter)
        setContent { AemApp(::downloadApk,::openInstalledApp,transferManager,transferState,refreshGeneration,{ refreshGeneration++ }) }
    }

    override fun onDestroy() {
        transferManager.close()
        try { unregisterReceiver(downloadReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(packageChangeReceiver) } catch (_: Exception) {}
        super.onDestroy()
    }

    override fun onNewIntent(intent:Intent) { super.onNewIntent(intent); setIntent(intent); handleIncomingInstall(intent) }

    override fun onResume() {
        super.onResume()
        refreshGeneration++
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()) {
            pendingIncomingUri?.let { uri ->
                pendingIncomingUri = null
                AemApkInstaller.installUri(this, uri)
            }
            pendingPermissionDownloadId?.let { id ->
                pendingPermissionDownloadId = null
                installDownloadedApk(id, null)
            }
        }
    }

    private fun handleIncomingInstall(intent:Intent?) {
        val data = intent?.data ?: return
        if (intent.action == Intent.ACTION_VIEW && intent.type == "application/vnd.android.package-archive") {
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            setIntent(Intent(Intent.ACTION_MAIN))
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
                pendingIncomingUri = data
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
                return
            }
            AemApkInstaller.installUri(this, data)
        }
    }

    private fun openInstalledApp(app:StoreApp) { app.packageName?.let { try { startActivity(packageManager.getLaunchIntentForPackage(it)) } catch(_:Exception) {} } }

    private fun verifyDownloadedApk(file: File, app: StoreApp): Boolean {
        if (!file.isFile) return false
        val expectedSha = app.sha256?.trim()
        if (!expectedSha.isNullOrEmpty()) {
            val actualSha = try { sha256Hex(file) } catch (_: Exception) { return false }
            if (!actualSha.equals(expectedSha, ignoreCase = true)) return false
        }
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
        val info = packageManager.getPackageArchiveInfo(file.absolutePath, flags) ?: return false
        val expectedPkg = app.packageName?.takeIf { it.isNotBlank() }
        if (expectedPkg != null && info.packageName != expectedPkg) return false
        val actualVersion = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
        if (app.versionCode != null && actualVersion != app.versionCode) return false
        val expectedCert = app.signingCertificateSha256?.replace(":", "")?.replace(" ", "")?.takeIf { it.isNotBlank() }
        if (expectedCert != null) {
            val signers = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else @Suppress("DEPRECATION") info.signatures
            val matched = signers?.any { sig ->
                MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) }
                    .equals(expectedCert, ignoreCase = true)
            } == true
            if (!matched) return false
        }
        return true
    }

    private fun downloadApk(app:StoreApp) {
        val url=app.downloadUrl?.takeIf { it.startsWith("https://", ignoreCase = true) } ?: return
        val safeName = app.name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "aem-app" }
        val baseDir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: filesDir
        val destFile = File(baseDir, "$safeName.apk")
        if (destFile.exists()) destFile.delete()
        val request=DownloadManager.Request(Uri.parse(url))
            .setTitle("AEM · ${app.name}")
            .setDescription("Downloading release from AEM")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setMimeType("application/vnd.android.package-archive")
            .setDestinationInExternalFilesDir(this,Environment.DIRECTORY_DOWNLOADS,"$safeName.apk")
            .addRequestHeader("Accept","application/vnd.android.package-archive")
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(false)
        val id = downloadManager?.enqueue(request) ?: -1L
        if (id >= 0L) pendingDownloads[id] = app to destFile
    }

    private fun installDownloadedApk(id:Long, file: File?) {
        val uri=downloadManager?.getUriForDownloadedFile(id)
            ?: file?.let { FileProvider.getUriForFile(this, "$packageName.fileprovider", it) }
            ?: return
        if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            pendingPermissionDownloadId = id
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName")))
            return
        }
        val install=Intent(Intent.ACTION_VIEW,uri).apply {
            setDataAndType(uri,"application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try { startActivity(install) } catch(_:Exception) {
            pendingPermissionDownloadId = id
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName")))
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun AemApp(onDownload:(StoreApp)->Unit,onOpen:(StoreApp)->Unit,transfer:AemTransferManager,transferState:AemTransferState,refreshGeneration:Int,onManualRefresh:()->Unit) {
    var selected by remember { mutableIntStateOf(0) }
    var dark by remember { mutableStateOf(true) }
    var query by remember { mutableStateOf("") }
    var selectedApp by remember { mutableStateOf<StoreApp?>(null) }
    var downloadRows by remember { mutableStateOf(emptyList<DownloadRow>()) }
    val context=LocalContext.current
    var apps by remember { mutableStateOf(emptyList<StoreApp>()) }
    LaunchedEffect(refreshGeneration) { try { val remote=loadRemoteApps(); if(remote.isNotEmpty()) apps=remote } catch(_:Exception) {} }
    LaunchedEffect(selected) { if(selected==3) while(true){ downloadRows=currentDownloads(context); kotlinx.coroutines.delay(1000) } }
    val visible=apps.filter { query.isBlank() || (listOf(it.name,it.description,it.category,it.source)+it.functionality).joinToString(" ").contains(query,true) }
    val scheme=if(dark) darkColorScheme(primary=Color(0xFFF04444),background=Color(0xFF09090C),surface=Color(0xFF15151B),surfaceVariant=Color(0xFF202027)) else lightColorScheme(primary=Color(0xFFC92F35))
    MaterialTheme(colorScheme=scheme) {
        Scaffold(
            topBar={TopAppBar(title={Text("AEM STORE",fontWeight=FontWeight.Black)},actions={
                IconButton(onClick=onManualRefresh){Icon(Icons.Default.Refresh,"Refresh")}
                IconButton(onClick={dark=!dark}){Icon(if(dark) Icons.Default.LightMode else Icons.Default.DarkMode,"Theme")}
                IconButton(onClick={}){Icon(Icons.Default.Notifications,"Notifications")}
            })},
            bottomBar={NavigationBar{
                val labels=listOf("Home","Apps","Updates","Transfer","Settings")
                val icons=listOf(Icons.Default.Home,Icons.Default.Apps,Icons.Default.SystemUpdate,Icons.Default.SwapHoriz,Icons.Default.Settings)
                labels.forEachIndexed{i,label->NavigationBarItem(selected=selected==i,onClick={selected=i},icon={Icon(icons[i],label)},label={Text(label)})}
            }},
            containerColor=MaterialTheme.colorScheme.background
        ){pad->LazyColumn(Modifier.fillMaxSize().padding(pad).padding(horizontal=16.dp),verticalArrangement=Arrangement.spacedBy(14.dp),contentPadding=PaddingValues(vertical=18.dp)){
            item{OutlinedTextField(value=query,onValueChange={query=it},modifier=Modifier.fillMaxWidth(),singleLine=true,shape=RoundedCornerShape(18.dp),placeholder={Text("Search apps, features, categories")},leadingIcon={Icon(Icons.Default.Search,null)})}
            when(selected){
                0,1->{item{Surface(shape=RoundedCornerShape(24.dp),tonalElevation=3.dp){Column(Modifier.padding(22.dp)){Text("Software you control",fontSize=25.sp,fontWeight=FontWeight.Bold);Spacer(Modifier.height(7.dp));Text("Your projects publish releases. AEM discovers, distributes and updates them.",color=MaterialTheme.colorScheme.onSurfaceVariant);Spacer(Modifier.height(15.dp));Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){AssistChip(onClick={selected=1},label={Text("Browse apps")});AssistChip(onClick={selected=2},label={Text("Check updates")})}}}};item{Text(if(selected==0)"Your apps" else "All apps",fontSize=21.sp,fontWeight=FontWeight.Bold)};items(visible){app->AppCard(LocalContext.current,app,refreshGeneration,{selectedApp=app},{onDownload(app)},{onOpen(app)})}}
                2->{item{SectionTitle("Updates")};val updates=apps.filter{installedState(context,it)=="UPDATE"};if(updates.isEmpty()) item{EmptyState("You're up to date","AEM will place compatible newer releases here.")} else items(updates){app->AppCard(context,app,refreshGeneration,{selectedApp=app},{onDownload(app)},{onOpen(app)})}}
                3->{item{TransferPanel(context,transfer,transferState,downloadRows)}}
                else->{item{SectionTitle("Settings")};item{SettingRow("Appearance",if(dark)"Dark mode" else "Light mode"){dark=!dark}};item{SettingRow("Notifications","Release and update notifications"){} };item{SettingRow("Release channels","Stable · Beta · Development"){} };item{SettingRow("Source providers","GitHub now · more providers later"){} };item{SettingRow("Installer","Android package installation and security checks"){} }}
            }
        }}
        selectedApp?.let{app->val detailState=installedState(context,app);AlertDialog(onDismissRequest={selectedApp=null},title={Text(app.name,fontWeight=FontWeight.Bold)},text={Column(verticalArrangement=Arrangement.spacedBy(9.dp)){Text(app.description);Text("Functionality",fontWeight=FontWeight.Bold);Text(app.functionality.joinToString(" · "));Text("Source",fontWeight=FontWeight.Bold);Text(app.source);Text("Permissions",fontWeight=FontWeight.Bold);Text(if(app.permissions.isEmpty())"None listed" else app.permissions.joinToString(" · "))}},confirmButton={Button(onClick={if(detailState=="OPEN"||detailState=="CURRENT") onOpen(app) else onDownload(app);selectedApp=null},enabled=app.downloadUrl!=null||detailState=="OPEN"||detailState=="CURRENT"){Text(detailState)}},dismissButton={TextButton(onClick={selectedApp=null}){Text("Close")}})}
    }
}

@Composable
private fun TransferPanel(context:Context,transfer:AemTransferManager,state:AemTransferState,downloads:List<DownloadRow>) {
    var mode by remember { mutableIntStateOf(0) }
    val launcher=androidx.activity.compose.rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) transfer.chooseFiles(uris)
    }
    Column(verticalArrangement=Arrangement.spacedBy(12.dp)) {
        SectionTitle("Transfer")
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            FilterChip(selected=mode==0,onClick={mode=0},label={Text("Send")})
            FilterChip(selected=mode==1,onClick={mode=1},label={Text("Receive")})
            FilterChip(selected=mode==2,onClick={mode=2},label={Text("Downloads")})
        }
        if (mode==0) {
            Text("Send files directly to another AEM phone.",color=MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick={
                if (!transfer.hasPermission()) {
                    if (Build.VERSION.SDK_INT >= 33) (context as? Activity)?.requestPermissions(transfer.requiredPermissions(), 701)
                    else (context as? Activity)?.requestPermissions(transfer.requiredPermissions(), 701)
                } else launcher.launch(arrayOf("*/*"))
            }) { Text("Choose files") }
            if (state.status.contains("selected",true)) {
                Text(state.status,fontWeight=FontWeight.Bold)
                Button(onClick={transfer.discover()}) { Text("Find nearby AEM") }
            }
            state.peers.forEach { peer ->
                Surface(shape=RoundedCornerShape(18.dp),tonalElevation=2.dp,modifier=Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().padding(16.dp),verticalAlignment=Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)){Text(peer.name,fontWeight=FontWeight.Bold);Text("AEM transfer device",color=MaterialTheme.colorScheme.onSurfaceVariant,fontSize=12.sp)}
                        FilledTonalButton(onClick={transfer.connectAndSend(peer)}){Text("Send")}
                    }
                }
            }
        } else if (mode==1) {
            Text("Receive directly from another AEM phone. No cloud or database is used.",color=MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick={transfer.startReceiving()}) { Text("Ready to receive") }
        } else {
            if (downloads.isEmpty()) EmptyState("No downloads","AEM downloads will appear here with live progress.")
            else downloads.forEach { d ->
                Surface(shape=RoundedCornerShape(18.dp),tonalElevation=2.dp) {
                    Column(Modifier.fillMaxWidth().padding(16.dp)) {
                        Text(d.title,fontWeight=FontWeight.Bold)
                        Text(d.status,color=MaterialTheme.colorScheme.onSurfaceVariant)
                        LinearProgressIndicator(progress={d.progress/100f},modifier=Modifier.fillMaxWidth().padding(vertical=8.dp))
                        Text(d.progress.toString()+"% · "+d.bytes+" / "+if(d.total>0)d.total.toString() else "?",fontSize=12.sp)
                    }
                }
            }
        }
        if (state.status != "Ready") Text(state.status,color=MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.totalBytes > 0) LinearProgressIndicator(progress={state.progress/100f},modifier=Modifier.fillMaxWidth())
    }
}
@Composable private fun AppCard(context:Context,app:StoreApp,refreshGeneration:Int,onDetails:()->Unit,onInstall:()->Unit,onOpen:()->Unit){
    Surface(shape=RoundedCornerShape(22.dp),tonalElevation=2.dp){Column(Modifier.fillMaxWidth().padding(17.dp)){
        Row(verticalAlignment=Alignment.CenterVertically){Box(Modifier.size(58.dp).background(MaterialTheme.colorScheme.primary,RoundedCornerShape(17.dp)),contentAlignment=Alignment.Center){Text(app.name.take(1),color=Color.White,fontWeight=FontWeight.Black,fontSize=22.sp)};Spacer(Modifier.width(14.dp));Column(Modifier.weight(1f)){Text(app.name,fontSize=18.sp,fontWeight=FontWeight.Bold);Text(app.category,color=MaterialTheme.colorScheme.onSurfaceVariant)};val state=remember(app.name,app.versionCode,app.downloadUrl,app.sourceUpdatedAtMs,refreshGeneration){installedState(context,app)}
        FilledTonalButton(onClick={if(state=="OPEN"||state=="CURRENT") onOpen() else onInstall()},enabled=app.downloadUrl!=null||state=="OPEN"||state=="CURRENT"){Text(state)}}
        Spacer(Modifier.height(12.dp));Text(app.description,color=MaterialTheme.colorScheme.onSurfaceVariant);Spacer(Modifier.height(9.dp));Row(horizontalArrangement=Arrangement.spacedBy(7.dp)){AssistChip(onClick=onDetails,label={Text(app.platform)});AssistChip(onClick=onDetails,label={Text(app.functionality.firstOrNull()?:"Software")})};TextButton(onClick=onDetails){Text("Details")}
    }}
}
@Composable private fun SectionTitle(text:String){Text(text,fontSize=25.sp,fontWeight=FontWeight.Bold)}
@Composable private fun EmptyState(title:String,body:String){Surface(shape=RoundedCornerShape(22.dp),tonalElevation=2.dp){Column(Modifier.fillMaxWidth().padding(28.dp),horizontalAlignment=Alignment.CenterHorizontally){Icon(Icons.Default.CheckCircle,null,tint=MaterialTheme.colorScheme.primary,modifier=Modifier.size(42.dp));Spacer(Modifier.height(10.dp));Text(title,fontWeight=FontWeight.Bold,fontSize=18.sp);Text(body,color=MaterialTheme.colorScheme.onSurfaceVariant)}}}
@Composable private fun SettingRow(title:String,subtitle:String,onClick:()->Unit){Surface(shape=RoundedCornerShape(18.dp),tonalElevation=2.dp,modifier=Modifier.clickable(onClick=onClick)){Row(Modifier.fillMaxWidth().padding(18.dp),verticalAlignment=Alignment.CenterVertically){Column(Modifier.weight(1f)){Text(title,fontWeight=FontWeight.Bold);Text(subtitle,color=MaterialTheme.colorScheme.onSurfaceVariant,fontSize=13.sp)};Icon(Icons.Default.ChevronRight,null)}}}
