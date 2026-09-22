package com.aem.store

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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
    val packageName:String?,val downloadUrl:String?,val versionCode:Long?=null,val signingCertificateSha256:String?=null
)

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

private const val AEM_SUPABASE_URL="https://wfvvmyixqcwosmuldxoq.supabase.co"
private const val AEM_SUPABASE_KEY="sb_publishable_Imgtr_W_Z868cBsNEcWpeg_89FE2Mvb"

private suspend fun loadRemoteApps():List<StoreApp> = withContext(Dispatchers.IO) {
    val url=URL(AEM_SUPABASE_URL+"/rest/v1/applications?select=*,releases(*,artifacts(*))&order=name.asc")
    val conn=url.openConnection() as HttpURLConnection
    conn.setRequestProperty("apikey",AEM_SUPABASE_KEY)
    conn.setRequestProperty("Authorization","Bearer "+AEM_SUPABASE_KEY)
    conn.connectTimeout=10000
    conn.readTimeout=15000
    try {
        if(conn.responseCode !in 200..299) return@withContext emptyList()
        val body=conn.inputStream.bufferedReader().use{it.readText()}
        val rows=JSONArray(body)
        buildList {
            for(i in 0 until rows.length()){
                val a=rows.getJSONObject(i)
                val releases=a.optJSONArray("releases") ?: JSONArray()
                var best:JSONObject?=null
                var bestTime=Long.MIN_VALUE
                for(j in 0 until releases.length()){
                    val r=releases.getJSONObject(j)
                    if(r.optString("status")!="published") continue
                    val arts=r.optJSONArray("artifacts") ?: JSONArray()
                    var hasApk=false
                    for(k in 0 until arts.length()) if(arts.getJSONObject(k).optString("kind")=="apk") hasApk=true
                    val t=try{java.time.Instant.parse(r.optString("published_at")).toEpochMilli()}catch(_:Exception){0L}
                    if(hasApk && t>=bestTime){best=r;bestTime=t}
                }
                val r=best ?: continue
                val arts=r.optJSONArray("artifacts") ?: JSONArray()
                var apk:JSONObject?=null
                for(k in 0 until arts.length()) if(arts.getJSONObject(k).optString("kind")=="apk"){apk=arts.getJSONObject(k);break}
                val z=apk ?: continue
                add(StoreApp(a.optString("name"),a.optString("description"),a.optString("category","Other"),
                    "GitHub · "+a.optString("project"),listOf("Android APK","Automatic GitHub build"),
                    emptyList(),"Android",a.optString("package_identity").takeIf{it.isNotBlank()},
                    z.optString("download_url").takeIf{it.isNotBlank()},
                    z.optLong("version_code").takeIf{z.has("version_code") && !z.isNull("version_code")},
                    z.optString("signing_certificate_sha256").takeIf{it.isNotBlank()}))
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
            else -> "OPEN"
        }
    } catch(_:Exception) { "INSTALL" }
}

class MainActivity: ComponentActivity() {
    private var pendingDownload:Long = -1L
    private var lastDownloadedName:String = "AEM.apk"
    private var downloadManager:DownloadManager? = null

    private val downloadReceiver = object: BroadcastReceiver() {
        override fun onReceive(context:Context,intent:Intent) {
            if(intent.action == DownloadManager.ACTION_DOWNLOAD_COMPLETE) {
                val id=intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID,-1L)
                if(id==pendingDownload) {
                    val status=downloadManager?.query(DownloadManager.Query().setFilterById(id))
                    status?.use { if(it.moveToFirst()) {
                        val column=it.getColumnIndex(DownloadManager.COLUMN_STATUS)
                        if(column>=0 && it.getInt(column)==DownloadManager.STATUS_SUCCESSFUL) installDownloadedApk(id)
                    } }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState)
        downloadManager=getSystemService(DownloadManager::class.java)
        if(Build.VERSION.SDK_INT >= 33) registerReceiver(downloadReceiver,IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),Context.RECEIVER_NOT_EXPORTED) else registerReceiver(downloadReceiver,IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE))
        setContent { AemApp(::downloadApk,::openInstalledApp) }
    }

    override fun onDestroy() { unregisterReceiver(downloadReceiver); super.onDestroy() }

    override fun onResume() { super.onResume() }

    private fun openInstalledApp(app:StoreApp) { app.packageName?.let { try { startActivity(packageManager.getLaunchIntentForPackage(it)) } catch(_:Exception) {} } }

    private fun downloadApk(app:StoreApp) {
        val url=app.downloadUrl ?: return
        val request=DownloadManager.Request(Uri.parse(url))
            .setTitle("AEM · ${app.name}")
            .setDescription("Downloading release from AEM")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setMimeType("application/vnd.android.package-archive")
            .setDestinationInExternalFilesDir(this,Environment.DIRECTORY_DOWNLOADS,"${app.name}.apk")
            .addRequestHeader("Accept","application/vnd.android.package-archive")
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(false)
        pendingDownload=downloadManager?.enqueue(request) ?: -1L
    }

    private fun installDownloadedApk(id:Long) {
        val uri=downloadManager?.getUriForDownloadedFile(id) ?: return
        if(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName")))
            return
        }
        val install=Intent(Intent.ACTION_VIEW,uri).apply {
            setDataAndType(uri,"application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try { startActivity(install) } catch(_:Exception) {
            startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName")))
        }
    }
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun AemApp(onDownload:(StoreApp)->Unit,onOpen:(StoreApp)->Unit) {
    var selected by remember { mutableIntStateOf(0) }
    var dark by remember { mutableStateOf(true) }
    var query by remember { mutableStateOf("") }
    var selectedApp by remember { mutableStateOf<StoreApp?>(null) }
    var downloadRows by remember { mutableStateOf(emptyList<DownloadRow>()) }
    val context=LocalContext.current
    var apps by remember { mutableStateOf(emptyList<StoreApp>()) }
    /* source-driven catalog */
    var legacyAppsDisabled by remember { mutableStateOf(false) }
    if (false) listOf(
        StoreApp("Phormi","Private Android browser partner for AEM.","Browsers","GitHub · phormi-android",
            listOf("Web browsing","Downloads","AI/API integration"),listOf("Internet"),"Android","com.uong.phormi",null),
        StoreApp("Lite Read","PDF and document platform.","Productivity","GitHub · lite-read",
            listOf("PDF reading","Document handling"),emptyList(),"Android + Web",null,null)
    ))}
    LaunchedEffect(Unit) { try { val remote=loadRemoteApps(); if(remote.isNotEmpty()) apps=remote } catch(_:Exception) {} }
    LaunchedEffect(selected) { if(selected==3) while(true){ downloadRows=currentDownloads(context); kotlinx.coroutines.delay(1000) } }
    val visible=apps.filter { query.isBlank() || (listOf(it.name,it.description,it.category,it.source)+it.functionality).joinToString(" ").contains(query,true) }
    val scheme=if(dark) darkColorScheme(primary=Color(0xFFF04444),background=Color(0xFF09090C),surface=Color(0xFF15151B),surfaceVariant=Color(0xFF202027)) else lightColorScheme(primary=Color(0xFFC92F35))
    MaterialTheme(colorScheme=scheme) {
        Scaffold(
            topBar={TopAppBar(title={Text("AEM STORE",fontWeight=FontWeight.Black)},actions={
                IconButton(onClick={dark=!dark}){Icon(if(dark) Icons.Default.LightMode else Icons.Default.DarkMode,"Theme")}
                IconButton(onClick={}){Icon(Icons.Default.Notifications,"Notifications")}
            })},
            bottomBar={NavigationBar{
                val labels=listOf("Home","Apps","Updates","Downloads","Settings")
                val icons=listOf(Icons.Default.Home,Icons.Default.Apps,Icons.Default.SystemUpdate,Icons.Default.Download,Icons.Default.Settings)
                labels.forEachIndexed{i,label->NavigationBarItem(selected=selected==i,onClick={selected=i},icon={Icon(icons[i],label)},label={Text(label)})}
            }},
            containerColor=MaterialTheme.colorScheme.background
        ){pad->LazyColumn(Modifier.fillMaxSize().padding(pad).padding(horizontal=16.dp),verticalArrangement=Arrangement.spacedBy(14.dp),contentPadding=PaddingValues(vertical=18.dp)){
            item{OutlinedTextField(value=query,onValueChange={query=it},modifier=Modifier.fillMaxWidth(),singleLine=true,shape=RoundedCornerShape(18.dp),placeholder={Text("Search apps, features, categories")},leadingIcon={Icon(Icons.Default.Search,null)})}
            when(selected){
                0,1->{item{Surface(shape=RoundedCornerShape(24.dp),tonalElevation=3.dp){Column(Modifier.padding(22.dp)){Text("Software you control",fontSize=25.sp,fontWeight=FontWeight.Bold);Spacer(Modifier.height(7.dp));Text("Your projects publish releases. AEM discovers, distributes and updates them.",color=MaterialTheme.colorScheme.onSurfaceVariant);Spacer(Modifier.height(15.dp));Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){AssistChip(onClick={selected=1},label={Text("Browse apps")});AssistChip(onClick={selected=2},label={Text("Check updates")})}}}};item{Text(if(selected==0)"Your apps" else "All apps",fontSize=21.sp,fontWeight=FontWeight.Bold)};items(visible){app->AppCard(LocalContext.current,app,{selectedApp=app},{onDownload(app)},{onOpen(app)})}}
                2->{item{SectionTitle("Updates")};item{EmptyState("You're up to date","AEM will place compatible newer releases here.")}}
                3->{item{SectionTitle("Downloads")};if(downloadRows.isEmpty()) item{EmptyState("No downloads","AEM downloads will appear here with live progress.")} else items(downloadRows){d->Surface(shape=RoundedCornerShape(18.dp),tonalElevation=2.dp){Column(Modifier.fillMaxWidth().padding(16.dp)){Text(d.title,fontWeight=FontWeight.Bold);Text(d.status,color=MaterialTheme.colorScheme.onSurfaceVariant);LinearProgressIndicator(progress={d.progress/100f},modifier=Modifier.fillMaxWidth().padding(vertical=8.dp));Text("${d.progress}% · ${d.bytes} / ${if(d.total>0)d.total else "?"} bytes",fontSize=12.sp)}}}}
                else->{item{SectionTitle("Settings")};item{SettingRow("Appearance",if(dark)"Dark mode" else "Light mode"){dark=!dark}};item{SettingRow("Notifications","Release and update notifications"){} };item{SettingRow("Release channels","Stable · Beta · Development"){} };item{SettingRow("Source providers","GitHub now · more providers later"){} };item{SettingRow("Installer","Android package installation and security checks"){} }}
            }
        }}
        selectedApp?.let{app->AlertDialog(onDismissRequest={selectedApp=null},title={Text(app.name,fontWeight=FontWeight.Bold)},text={Column(verticalArrangement=Arrangement.spacedBy(9.dp)){Text(app.description);Text("Functionality",fontWeight=FontWeight.Bold);Text(app.functionality.joinToString(" · "));Text("Source",fontWeight=FontWeight.Bold);Text(app.source);Text("Permissions",fontWeight=FontWeight.Bold);Text(if(app.permissions.isEmpty())"None listed" else app.permissions.joinToString(" · "))}},confirmButton={Button(onClick={onDownload(app);selectedApp=null},enabled=app.downloadUrl!=null){Text("INSTALL")}},dismissButton={TextButton(onClick={selectedApp=null}){Text("Close")}})}
    }
}

@Composable private fun AppCard(context:Context,app:StoreApp,onDetails:()->Unit,onInstall:()->Unit,onOpen:()->Unit){
    Surface(shape=RoundedCornerShape(22.dp),tonalElevation=2.dp){Column(Modifier.fillMaxWidth().padding(17.dp)){
        Row(verticalAlignment=Alignment.CenterVertically){Box(Modifier.size(58.dp).background(MaterialTheme.colorScheme.primary,RoundedCornerShape(17.dp)),contentAlignment=Alignment.Center){Text(app.name.take(1),color=Color.White,fontWeight=FontWeight.Black,fontSize=22.sp)};Spacer(Modifier.width(14.dp));Column(Modifier.weight(1f)){Text(app.name,fontSize=18.sp,fontWeight=FontWeight.Bold);Text(app.category,color=MaterialTheme.colorScheme.onSurfaceVariant)};val state=remember(app.name){installedState(context,app)}
        FilledTonalButton(onClick={if(state=="OPEN"||state=="CURRENT") onOpen() else onInstall()},enabled=app.downloadUrl!=null||state=="OPEN"||state=="CURRENT"){Text(state)}}
        Spacer(Modifier.height(12.dp));Text(app.description,color=MaterialTheme.colorScheme.onSurfaceVariant);Spacer(Modifier.height(9.dp));Row(horizontalArrangement=Arrangement.spacedBy(7.dp)){AssistChip(onClick=onDetails,label={Text(app.platform)});AssistChip(onClick=onDetails,label={Text(app.functionality.firstOrNull()?:"Software")})};TextButton(onClick=onDetails){Text("Details")}
    }}
}
@Composable private fun SectionTitle(text:String){Text(text,fontSize=25.sp,fontWeight=FontWeight.Bold)}
@Composable private fun EmptyState(title:String,body:String){Surface(shape=RoundedCornerShape(22.dp),tonalElevation=2.dp){Column(Modifier.fillMaxWidth().padding(28.dp),horizontalAlignment=Alignment.CenterHorizontally){Icon(Icons.Default.CheckCircle,null,tint=MaterialTheme.colorScheme.primary,modifier=Modifier.size(42.dp));Spacer(Modifier.height(10.dp));Text(title,fontWeight=FontWeight.Bold,fontSize=18.sp);Text(body,color=MaterialTheme.colorScheme.onSurfaceVariant)}}}
@Composable private fun SettingRow(title:String,subtitle:String,onClick:()->Unit){Surface(shape=RoundedCornerShape(18.dp),tonalElevation=2.dp,modifier=Modifier.clickable(onClick=onClick)){Row(Modifier.fillMaxWidth().padding(18.dp),verticalAlignment=Alignment.CenterVertically){Column(Modifier.weight(1f)){Text(title,fontWeight=FontWeight.Bold);Text(subtitle,color=MaterialTheme.colorScheme.onSurfaceVariant,fontSize=13.sp)};Icon(Icons.Default.ChevronRight,null)}}}
