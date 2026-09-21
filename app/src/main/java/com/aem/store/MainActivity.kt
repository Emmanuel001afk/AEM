package com.aem.store

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private data class StoreApp(val name:String,val description:String,val version:String,val state:String)

class MainActivity: ComponentActivity(){ override fun onCreate(savedInstanceState:Bundle?){super.onCreate(savedInstanceState);setContent{AemApp()}} }

@Composable fun AemApp(){
    var selected by remember { mutableIntStateOf(0) }
    val apps = remember { listOf(StoreApp("Phormi","Fast private browser","Latest","OPEN"),StoreApp("Lite Read","PDF and document platform","Latest","OPEN")) }
    MaterialTheme(colorScheme=darkColorScheme(primary=Color(0xFFF04444),background=Color(0xFF09090C),surface=Color(0xFF15151B))) {
        Scaffold(containerColor=Color(0xFF09090C),bottomBar={NavigationBar(containerColor=Color(0xFF111116)){listOf("Home","Apps","Updates","Downloads","Settings").forEachIndexed{ i,label->NavigationBarItem(selected=selected==i,onClick={selected=i},icon={Text(label.take(1))},label={Text(label)})}}}){pad->
            LazyColumn(modifier=Modifier.fillMaxSize().padding(pad).padding(horizontal=18.dp),verticalArrangement=Arrangement.spacedBy(14.dp),contentPadding=PaddingValues(vertical=20.dp)){
                item{Text("AEM",fontSize=30.sp,fontWeight=FontWeight.Black);Text("Your software. One store.",color=Color.White.copy(alpha=.55f))}
                item{Surface(shape=RoundedCornerShape(24.dp),color=Color(0xFF17171D)){Column(Modifier.padding(22.dp)){Text("Software you control",fontSize=25.sp,fontWeight=FontWeight.Bold);Spacer(Modifier.height(8.dp));Text("Releases arrive from your existing projects. AEM handles discovery, distribution and Android updates.",color=Color.White.copy(alpha=.65f))}}}
                item{Text(if(selected==2)"Updates" else if(selected==3)"Downloads" else "Your apps",fontSize=21.sp,fontWeight=FontWeight.Bold)}
                items(apps){app->Surface(shape=RoundedCornerShape(20.dp),color=Color(0xFF15151B)){Row(Modifier.fillMaxWidth().padding(16.dp),verticalAlignment=Alignment.CenterVertically){Box(Modifier.size(54.dp).background(Color(0xFFF04444),RoundedCornerShape(15.dp)));Spacer(Modifier.width(14.dp));Column(Modifier.weight(1f)){Text(app.name,fontWeight=FontWeight.Bold,fontSize=18.sp);Text(app.description,color=Color.White.copy(alpha=.55f));Text(app.version,color=Color.White.copy(alpha=.4f),fontSize=12.sp)}Button(onClick={}){Text(app.state)}}}}
            }
        }}
    }
}
