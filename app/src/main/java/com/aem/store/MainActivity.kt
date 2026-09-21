package com.aem.store

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private data class StoreApp(
    val name:String,val description:String,val category:String,val source:String,
    val functionality:List<String>,val permissions:List<String>,val platform:String,val state:String
)

class MainActivity: ComponentActivity() {
    override fun onCreate(savedInstanceState:Bundle?) { super.onCreate(savedInstanceState); setContent { AemApp() } }
}

@Composable
private fun AemApp() {
    var selected by remember { mutableIntStateOf(0) }
    var dark by remember { mutableStateOf(true) }
    var query by remember { mutableStateOf("") }
    var selectedApp by remember { mutableStateOf<StoreApp?>(null) }
    val apps = remember {
        listOf(
            StoreApp("Phormi","Private Android browser partner for AEM.","Browsers","GitHub · phormi-android",
                listOf("Web browsing","Downloads","AI/API integration"),listOf("Internet"),"Android","OPEN"),
            StoreApp("Lite Read","PDF and document platform.","Productivity","GitHub · lite-read",
                listOf("PDF reading","Document handling"),emptyList(),"Android + Web","OPEN")
        )
    }
    val visible = apps.filter {
        query.isBlank() || listOf(it.name,it.description,it.category,it.source,*it.functionality)
            .joinToString(" ").contains(query,ignoreCase=true)
    }
    val scheme = if (dark) darkColorScheme(
        primary=Color(0xFFF04444),background=Color(0xFF09090C),
        surface=Color(0xFF15151B),surfaceVariant=Color(0xFF202027)
    ) else lightColorScheme(primary=Color(0xFFC92F35))

    MaterialTheme(colorScheme=scheme) {
        Scaffold(
            containerColor=MaterialTheme.colorScheme.background,
            topBar={
                TopAppBar(
                    title={Text("AEM STORE",fontWeight=FontWeight.Black)},
                    actions={
                        IconButton(onClick={dark=!dark}) {
                            Icon(if(dark) Icons.Default.LightMode else Icons.Default.DarkMode,"Theme")
                        }
                        IconButton(onClick={}) { Icon(Icons.Default.Notifications,"Notifications") }
                    }
                )
            },
            bottomBar={
                NavigationBar {
                    val labels=listOf("Home","Apps","Updates","Downloads","Settings")
                    val icons=listOf(Icons.Default.Home,Icons.Default.Apps,Icons.Default.SystemUpdate,Icons.Default.Download,Icons.Default.Settings)
                    labels.forEachIndexed { i,label ->
                        NavigationBarItem(selected=selected==i,onClick={selected=i},
                            icon={Icon(icons[i],label)},label={Text(label)})
                    }
                }
            }
        ) { pad ->
            LazyColumn(
                Modifier.fillMaxSize().padding(pad).padding(horizontal=16.dp),
                verticalArrangement=Arrangement.spacedBy(14.dp),
                contentPadding=PaddingValues(vertical=18.dp)
            ) {
                item {
                    OutlinedTextField(value=query,onValueChange={query=it},modifier=Modifier.fillMaxWidth(),
                        singleLine=true,shape=RoundedCornerShape(18.dp),
                        placeholder={Text("Search apps, features, categories")},
                        leadingIcon={Icon(Icons.Default.Search,null)})
                }
                when(selected) {
                    0,1 -> {
                        item {
                            Surface(shape=RoundedCornerShape(24.dp),tonalElevation=3.dp) {
                                Column(Modifier.padding(22.dp)) {
                                    Text("Software you control",fontSize=25.sp,fontWeight=FontWeight.Bold)
                                    Spacer(Modifier.height(7.dp))
                                    Text("Your projects publish releases. AEM discovers them, organizes them and handles distribution and updates.",
                                        color=MaterialTheme.colorScheme.onSurfaceVariant)
                                    Spacer(Modifier.height(15.dp))
                                    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                                        AssistChip(onClick={selected=1},label={Text("Browse apps")})
                                        AssistChip(onClick={selected=2},label={Text("Check updates")})
                                    }
                                }
                            }
                        }
                        item { Text(if(selected==0) "Your apps" else "All apps",fontSize=21.sp,fontWeight=FontWeight.Bold) }
                        items(visible) { app -> AppCard(app){selectedApp=app} }
                    }
                    2 -> { item { SectionTitle("Updates") }; item { EmptyState("You're up to date","AEM will place compatible newer releases here when they arrive.") } }
                    3 -> { item { SectionTitle("Downloads") }; item { EmptyState("No active downloads","Downloads and their progress will appear here.") } }
                    else -> {
                        item { SectionTitle("Settings") }
                        item { SettingRow("Appearance",if(dark) "Dark mode" else "Light mode"){dark=!dark} }
                        item { SettingRow("Notifications","Release and update notifications"){} }
                        item { SettingRow("Release channels","Stable · Beta · Development"){} }
                        item { SettingRow("Source providers","GitHub now · more providers later"){} }
                        item { SettingRow("Installer","Android package installation"){} }
                    }
                }
            }
        }

        selectedApp?.let { app ->
            AlertDialog(onDismissRequest={selectedApp=null},
                title={Text(app.name,fontWeight=FontWeight.Bold)},
                text={Column(verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    Text(app.description)
                    Text("Functionality",fontWeight=FontWeight.Bold); Text(app.functionality.joinToString(" · "))
                    Text("Source",fontWeight=FontWeight.Bold); Text(app.source)
                    Text("Platform",fontWeight=FontWeight.Bold); Text(app.platform)
                    Text("Permissions",fontWeight=FontWeight.Bold)
                    Text(if(app.permissions.isEmpty()) "None declared" else app.permissions.joinToString(" · "))
                }},
                confirmButton={Button(onClick={selectedApp=null}){Text(app.state)}},
                dismissButton={TextButton(onClick={selectedApp=null}){Text("Close")}})
        }
    }
}

@Composable private fun AppCard(app:StoreApp,onDetails:()->Unit) {
    Surface(shape=RoundedCornerShape(22.dp),tonalElevation=2.dp) {
        Column(Modifier.fillMaxWidth().padding(17.dp)) {
            Row(verticalAlignment=Alignment.CenterVertically) {
                Box(Modifier.size(56.dp).background(MaterialTheme.colorScheme.primary,RoundedCornerShape(16.dp)),
                    contentAlignment=Alignment.Center) {
                    Text(app.name.take(1),color=Color.White,fontWeight=FontWeight.Black,fontSize=22.sp)
                }
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f)) {
                    Text(app.name,fontSize=18.sp,fontWeight=FontWeight.Bold)
                    Text(app.category,color=MaterialTheme.colorScheme.onSurfaceVariant)
                }
                FilledTonalButton(onClick=onDetails){Text(app.state)}
            }
            Spacer(Modifier.height(12.dp))
            Text(app.description,color=MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(9.dp))
            Row(horizontalArrangement=Arrangement.spacedBy(7.dp)) {
                AssistChip(onClick=onDetails,label={Text(app.platform)})
                AssistChip(onClick=onDetails,label={Text(app.functionality.firstOrNull() ?: "Software")})
            }
        }
    }
}

@Composable private fun SectionTitle(text:String) { Text(text,fontSize=25.sp,fontWeight=FontWeight.Bold) }

@Composable private fun EmptyState(title:String,body:String) {
    Surface(shape=RoundedCornerShape(22.dp),tonalElevation=2.dp) {
        Column(Modifier.fillMaxWidth().padding(28.dp),horizontalAlignment=Alignment.CenterHorizontally) {
            Icon(Icons.Default.CheckCircle,null,tint=MaterialTheme.colorScheme.primary,modifier=Modifier.size(42.dp))
            Spacer(Modifier.height(10.dp)); Text(title,fontWeight=FontWeight.Bold,fontSize=18.sp)
            Text(body,color=MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable private fun SettingRow(title:String,subtitle:String,onClick:()->Unit) {
    Surface(shape=RoundedCornerShape(18.dp),tonalElevation=2.dp,modifier=Modifier.clickable(onClick=onClick)) {
        Row(Modifier.fillMaxWidth().padding(18.dp),verticalAlignment=Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text(title,fontWeight=FontWeight.Bold); Text(subtitle,color=MaterialTheme.colorScheme.onSurfaceVariant,fontSize=13.sp) }
            Icon(Icons.Default.ChevronRight,null)
        }
    }
}
