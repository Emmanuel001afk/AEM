package com.aem.store;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.wifi.p2p.*;
import android.os.*;
import android.provider.OpenableColumns;
import android.graphics.Color;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class AemTransferActivity extends Activity {
    private static final int PORT=38177, PERM=7001, PICK=7002;
    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private BroadcastReceiver receiver;
    private final ExecutorService io=Executors.newCachedThreadPool();
    private final ArrayList<Uri> selected=new ArrayList<>();
    private final ArrayList<WifiP2pDevice> peers=new ArrayList<>();
    private LinearLayout root, peerBox;
    private TextView status, selectedText;
    private ProgressBar progress;
    private ServerSocket server;
    private boolean sending=false;

    @Override public void onCreate(Bundle b){
        super.onCreate(b);
        buildUi();
        manager=(WifiP2pManager)getSystemService(WIFI_P2P_SERVICE);
        channel=manager==null?null:manager.initialize(this,getMainLooper(),null);
        receiver=new BroadcastReceiver(){
            @Override public void onReceive(Context c,Intent i){
                String a=i.getAction();
                if(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(a)) requestPeers();
                if(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(a)) requestConnection();
            }
        };
        IntentFilter f=new IntentFilter();
        f.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        f.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        if(Build.VERSION.SDK_INT>=33) registerReceiver(receiver,f,Context.RECEIVER_NOT_EXPORTED); else registerReceiver(receiver,f);
        if(!hasPermission()) requestPermissions(requiredPermissions(),PERM);
    }

    private void buildUi(){
        root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(28,24,28,24);
        TextView title=new TextView(this); title.setText("Transfer"); title.setTextSize(28); title.setTextColor(Color.WHITE); title.setTypeface(null,1);
        root.setBackgroundColor(Color.rgb(9,9,12)); root.addView(title,new LinearLayout.LayoutParams(-1,-2));
        TextView sub=new TextView(this); sub.setText("Direct phone-to-phone transfer. No cloud or database."); sub.setTextColor(Color.LTGRAY); sub.setPadding(0,8,0,20); root.addView(sub);
        LinearLayout modes=new LinearLayout(this); modes.setOrientation(LinearLayout.HORIZONTAL);
        Button send=new Button(this); send.setText("Send"); Button receive=new Button(this); receive.setText("Receive");
        modes.addView(send,new LinearLayout.LayoutParams(0,-2,1)); modes.addView(receive,new LinearLayout.LayoutParams(0,-2,1)); root.addView(modes);
        Button choose=new Button(this); choose.setText("Choose files"); root.addView(choose);
        selectedText=new TextView(this); selectedText.setTextColor(Color.LTGRAY); selectedText.setText("No files selected"); selectedText.setPadding(0,12,0,12); root.addView(selectedText);
        status=new TextView(this); status.setTextColor(Color.WHITE); status.setText("Ready"); status.setPadding(0,8,0,12); root.addView(status);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); progress.setMax(100); root.addView(progress,new LinearLayout.LayoutParams(-1,-2));
        peerBox=new LinearLayout(this); peerBox.setOrientation(LinearLayout.VERTICAL); root.addView(peerBox);
        ScrollView scroll=new ScrollView(this); scroll.addView(root); setContentView(scroll);
        choose.setOnClickListener(v->pickFiles());
        receive.setOnClickListener(v->startReceive());
        send.setOnClickListener(v->{ if(selected.isEmpty()) pickFiles(); else discover(); });
    }

    private boolean hasPermission(){
        if(Build.VERSION.SDK_INT>=33) return checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES)==PackageManager.PERMISSION_GRANTED;
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }
    private String[] requiredPermissions(){
        if(Build.VERSION.SDK_INT>=33) return new String[]{Manifest.permission.NEARBY_WIFI_DEVICES};
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }
    @Override public void onRequestPermissionsResult(int r,String[] p,int[] g){
        super.onRequestPermissionsResult(r,p,g);
        if(r==PERM) status.setText(hasPermission()?"Permission granted. Ready.":"Nearby Wi-Fi permission is required.");
    }
    private void pickFiles(){
        Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT); i.addCategory(Intent.CATEGORY_OPENABLE); i.setType("*/*"); i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true); startActivityForResult(i,PICK);
    }
    @Override protected void onActivityResult(int r,int code,Intent data){
        super.onActivityResult(r,code,data);
        if(r!=PICK||data==null)return;
        selected.clear();
        if(data.getClipData()!=null) for(int i=0;i<data.getClipData().getItemCount();i++) selected.add(data.getClipData().getItemAt(i).getUri());
        else if(data.getData()!=null) selected.add(data.getData());
        selectedText.setText(selected.size()+" file"+(selected.size()==1?"":"s")+" selected");
    }

    private void startReceive(){
        if(!hasPermission()){requestPermissions(requiredPermissions(),PERM);return;}
        if(manager==null||channel==null){status.setText("Wi-Fi Direct is unavailable.");return;}
        status.setText("Creating private transfer connection...");
        manager.createGroup(channel,new WifiP2pManager.ActionListener(){
            public void onSuccess(){status.setText("Waiting for another AEM phone...");startServer();}
            public void onFailure(int r){status.setText("Could not create transfer connection: "+r);}
        });
    }
    private void discover(){
        if(!hasPermission()){requestPermissions(requiredPermissions(),PERM);return;}
        if(manager==null||channel==null)return;
        peerBox.removeAllViews(); status.setText("Looking for nearby phones...");
        manager.discoverPeers(channel,new WifiP2pManager.ActionListener(){
            public void onSuccess(){status.setText("Nearby phones will appear below.");}
            public void onFailure(int r){status.setText("Discovery failed: "+r);}
        });
    }
    private void requestPeers(){
        if(!hasPermission()||manager==null||channel==null)return;
        manager.requestPeers(channel,list->{peers.clear();peers.addAll(list.getDeviceList());renderPeers();});
    }
    private void renderPeers(){
        peerBox.removeAllViews();
        for(WifiP2pDevice d:peers){
            Button b=new Button(this); b.setText((d.deviceName==null||d.deviceName.isEmpty()?"Nearby phone":d.deviceName)+"  ·  Send");
            b.setOnClickListener(v->connect(d)); peerBox.addView(b);
        }
    }
    private void connect(WifiP2pDevice d){
        if(selected.isEmpty()){pickFiles();return;}
        sending=true; status.setText("Connecting to "+d.deviceName+"...");
        WifiP2pConfig c=new WifiP2pConfig(); c.deviceAddress=d.deviceAddress; c.wps.setup=WpsInfo.PBC;
        manager.connect(channel,c,new WifiP2pManager.ActionListener(){
            public void onSuccess(){status.setText("Connection requested...");}
            public void onFailure(int r){sending=false;status.setText("Connection failed: "+r);}
        });
    }
    private void requestConnection(){
        if(!hasPermission()||manager==null||channel==null)return;
        manager.requestConnectionInfo(channel,info->{
            if(info.groupFormed&&sending&&!info.isGroupOwner&&info.groupOwnerAddress!=null){
                sending=false; String host=info.groupOwnerAddress.getHostAddress(); io.execute(()->sendFiles(host));
            }
        });
    }
    private void startServer(){
        io.execute(()->{
            try{
                server=new ServerSocket(PORT);
                while(!server.isClosed()){ Socket s=server.accept(); receiveFiles(s); }
            }catch(Exception ignored){}
        });
    }
    private void sendFiles(String host){
        try(Socket s=new Socket()){
            s.connect(new InetSocketAddress(host,PORT),10000);
            DataOutputStream out=new DataOutputStream(new BufferedOutputStream(s.getOutputStream()));
            out.writeInt(selected.size());
            long total=0,done=0; for(Uri u:selected) total+=size(u);
            for(Uri u:selected){
                String name=name(u); byte[] nb=name.getBytes("UTF-8"); long len=size(u);
                out.writeInt(nb.length); out.write(nb); out.writeLong(len);
                InputStream in=getContentResolver().openInputStream(u); if(in==null)throw new IOException("Cannot read "+name);
                byte[] buf=new byte[65536]; long left=len; int n;
                while(left>0&&(n=in.read(buf,0,(int)Math.min(buf.length,left)))>0){out.write(buf,0,n);left-=n;done+=n;update("Sending "+name,percent(done,total));}
                in.close();
            }
            out.flush(); update("Transfer completed successfully",100);
        }catch(Exception e){update("Transfer failed: "+(e.getMessage()==null?"connection interrupted":e.getMessage()),0);}
    }
    private void receiveFiles(Socket s){
        io.execute(()->{
            try{
                DataInputStream in=new DataInputStream(new BufferedInputStream(s.getInputStream()));
                int count=Math.max(0,Math.min(100,in.readInt())); ArrayList<String> names=new ArrayList<>(); ArrayList<Long> sizes=new ArrayList<>(); long total=0,done=0;
                for(int i=0;i<count;i++){int nl=Math.max(1,Math.min(4096,in.readInt()));byte[] nb=new byte[nl];in.readFully(nb);String n=new String(nb,"UTF-8").replaceAll("[\\/:*?"<>|]","_");long z=in.readLong();names.add(n);sizes.add(z);total+=z;}
                File dir=new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"AEM Transfer"); if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cannot create transfer folder");
                for(int i=0;i<count;i++){File f=unique(new File(dir,names.get(i)));FileOutputStream out=new FileOutputStream(f);long left=sizes.get(i);byte[] buf=new byte[65536];while(left>0){int n=in.read(buf,0,(int)Math.min(buf.length,left));if(n<0)throw new IOException("Connection ended");out.write(buf,0,n);left-=n;done+=n;update("Receiving "+names.get(i),percent(done,total));}out.close();}
                update("Transfer received successfully",100);in.close();s.close();
            }catch(Exception e){update("Receiving failed: "+(e.getMessage()==null?"connection interrupted":e.getMessage()),0);}
        });
    }
    private File unique(File f){if(!f.exists())return f;String n=f.getName();int dot=n.lastIndexOf('.');String b=dot>0?n.substring(0,dot):n,e=dot>0?n.substring(dot):"";int i=1;File x;do{x=new File(f.getParentFile(),b+" ("+(i++)+")"+e);}while(x.exists());return x;}
    private long size(Uri u){try{CursorLike c=new CursorLike(getContentResolver().query(u,new String[]{OpenableColumns.SIZE},null,null,null));return c.size();}catch(Exception e){return 0;}}
    private String name(Uri u){try{CursorLike c=new CursorLike(getContentResolver().query(u,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null));return c.name(u);}catch(Exception e){return u.getLastPathSegment()==null?"AEM-file":u.getLastPathSegment();}}
    private int percent(long d,long t){return t>0?(int)Math.max(0,Math.min(100,d*100/t)):0;}
    private void update(String text,int pct){runOnUiThread(()->{status.setText(text);progress.setProgress(pct);});}
    private static class CursorLike{android.database.Cursor c;CursorLike(android.database.Cursor x){c=x;}long size(){try{return c!=null&&c.moveToFirst()&&c.getLong(0)>=0?c.getLong(0):0;}finally{if(c!=null)c.close();}}String name(Uri u){try{return c!=null&&c.moveToFirst()&&c.getString(0)!=null?c.getString(0):u.getLastPathSegment();}finally{if(c!=null)c.close();}}}
    @Override protected void onDestroy(){try{unregisterReceiver(receiver);}catch(Exception ignored){}try{if(server!=null)server.close();}catch(Exception ignored){}io.shutdownNow();super.onDestroy();}
}