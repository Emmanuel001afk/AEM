package com.aem.store;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.content.pm.*;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.net.wifi.p2p.*;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.view.*;
import android.widget.*;
import androidx.core.content.FileProvider;
import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

public class AemTransferActivity extends Activity {
    private static final int PORT=38177, PERM=7001, PICK=7002, FOLDER=7003;
    private static final int PROTOCOL=2;
    private WifiP2pManager manager; private WifiP2pManager.Channel channel; private BroadcastReceiver receiver;
    private final ExecutorService io=Executors.newCachedThreadPool();
    private final ArrayList<Item> selected=new ArrayList<>(); private final ArrayList<WifiP2pDevice> peers=new ArrayList<>();
    private LinearLayout root,peerBox; private TextView status,selectedText; private ProgressBar progress; private ServerSocket server; private boolean sending=false;

    private static final class Item {
        final Uri uri; final String name; final long size;
        Item(Uri u,String n,long s){uri=u;name=n;size=Math.max(0,s);}
    }

    @Override public void onCreate(Bundle b){
        super.onCreate(b); buildUi();
        manager=(WifiP2pManager)getSystemService(WIFI_P2P_SERVICE);
        channel=manager==null?null:manager.initialize(this,getMainLooper(),null);
        receiver=new BroadcastReceiver(){@Override public void onReceive(Context c,Intent i){
            String a=i.getAction();
            if(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION.equals(a)) requestPeers();
            if(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION.equals(a)) requestConnection();
        }};
        IntentFilter f=new IntentFilter(); f.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION); f.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        if(Build.VERSION.SDK_INT>=33) registerReceiver(receiver,f,Context.RECEIVER_NOT_EXPORTED); else registerReceiver(receiver,f);
        if(!hasPermission()) requestPermissions(requiredPermissions(),PERM);
    }

    private void buildUi(){
        root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(28,24,28,24); root.setBackgroundColor(Color.rgb(9,9,12));
        TextView title=new TextView(this); title.setText("Transfer"); title.setTextSize(28); title.setTextColor(Color.WHITE); title.setTypeface(null,1); root.addView(title,new LinearLayout.LayoutParams(-1,-2));
        TextView sub=new TextView(this); sub.setText("Direct device-to-device transfer. No mobile data, internet, cloud or database."); sub.setTextColor(Color.LTGRAY); sub.setPadding(0,8,0,20); root.addView(sub);
        LinearLayout modes=new LinearLayout(this); Button send=new Button(this); send.setText("Send"); Button receive=new Button(this); receive.setText("Receive");
        modes.addView(send,new LinearLayout.LayoutParams(0,-2,1)); modes.addView(receive,new LinearLayout.LayoutParams(0,-2,1)); root.addView(modes);
        Button choose=new Button(this); choose.setText("Choose files"); root.addView(choose);
        Button folder=new Button(this); folder.setText("Choose folder"); root.addView(folder);
        Button apps=new Button(this); apps.setText("Choose installed apps (including system apps)"); root.addView(apps);
        selectedText=new TextView(this); selectedText.setTextColor(Color.LTGRAY); selectedText.setPadding(0,12,0,12); root.addView(selectedText);
        status=new TextView(this); status.setTextColor(Color.WHITE); status.setPadding(0,8,0,12); root.addView(status);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal); progress.setMax(100); root.addView(progress,new LinearLayout.LayoutParams(-1,-2));
        peerBox=new LinearLayout(this); peerBox.setOrientation(LinearLayout.VERTICAL); root.addView(peerBox);
        ScrollView scroll=new ScrollView(this); scroll.addView(root); setContentView(scroll); refreshSelectedText(); status.setText("Ready");
        choose.setOnClickListener(v->pickFiles()); folder.setOnClickListener(v->pickFolder()); apps.setOnClickListener(v->pickInstalledApps());
        receive.setOnClickListener(v->startReceive()); send.setOnClickListener(v->{if(selected.isEmpty())pickFiles();else discover();});
    }

    private boolean hasPermission(){return Build.VERSION.SDK_INT>=33?checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES)==PackageManager.PERMISSION_GRANTED:checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;}
    private String[] requiredPermissions(){return Build.VERSION.SDK_INT>=33?new String[]{Manifest.permission.NEARBY_WIFI_DEVICES}:new String[]{Manifest.permission.ACCESS_FINE_LOCATION};}
    @Override public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);if(r==PERM)status.setText(hasPermission()?"Permission granted. Ready.":"Nearby Wi-Fi permission is required.");}

    private void pickFiles(){Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("*/*");i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);startActivityForResult(i,PICK);}
    private void pickFolder(){Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(i,FOLDER);}
    @Override protected void onActivityResult(int r,int code,Intent data){
        super.onActivityResult(r,code,data); if(data==null)return;
        if(r==PICK){if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)addUri(data.getClipData().getItemAt(i).getUri(),null);
            else if(data.getData()!=null)addUri(data.getData(),null);}
        else if(r==FOLDER){Uri u=data.getData();if(u!=null){try{getContentResolver().takePersistableUriPermission(u,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){};addTree(u);}}
        refreshSelectedText();
    }
    private void addUri(Uri u,String forcedName){String n=forcedName==null?displayName(u):forcedName;long s=size(u);if(s<0)s=0;selected.add(new Item(u,n,s));}
    private void addTree(Uri tree){
        Cursor c=null;try{String doc=DocumentsContract.getTreeDocumentId(tree);Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,doc);
            c=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE},null,null,null);
            if(c!=null)while(c.moveToNext()){String id=c.getString(0),name=c.getString(1),mime=c.getString(2);Uri child=DocumentsContract.buildDocumentUriUsingTree(tree,id);
                if(DocumentsContract.Document.MIME_TYPE_DIR.equals(mime))addTree(child);
                else selected.add(new Item(child,name,Math.max(0,c.isNull(3)?size(child):c.getLong(3))));
            }
        }catch(Exception e){update("Folder selection failed: "+e.getMessage(),0);}finally{if(c!=null)c.close();}}
    private String displayName(Uri u){Cursor c=null;try{c=getContentResolver().query(u,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null);return c!=null&&c.moveToFirst()&&!c.isNull(0)?c.getString(0):"AEM-file";}catch(Exception e){return u.getLastPathSegment()==null?"AEM-file":u.getLastPathSegment();}finally{if(c!=null)c.close();}}
    private long size(Uri u){Cursor c=null;try{c=getContentResolver().query(u,new String[]{OpenableColumns.SIZE},null,null,null);return c!=null&&c.moveToFirst()&&!c.isNull(0)?c.getLong(0):0;}catch(Exception e){return 0;}finally{if(c!=null)c.close();}}
    private void refreshSelectedText(){long total=0;for(Item x:selected)total+=x.size;selectedText.setText(selected.size()+" item"+(selected.size()==1?"":"s")+" selected · "+format(total));}
    private String format(long n){double x=n;if(x<1024)return n+" B";if(x<1048576)return String.format(Locale.US,"%.1f KB",x/1024);if(x<1073741824)return String.format(Locale.US,"%.1f MB",x/1048576);return String.format(Locale.US,"%.2f GB",x/1073741824);}

    private void pickInstalledApps(){
        PackageManager pm=getPackageManager();List<ApplicationInfo> all=pm.getInstalledApplications(PackageManager.GET_META_DATA);all.removeIf(a->a.packageName.equals(getPackageName()));
        Collections.sort(all,(a,b)->String.valueOf(pm.getApplicationLabel(a)).compareToIgnoreCase(String.valueOf(pm.getApplicationLabel(b))));
        String[] labels=new String[all.size()];boolean[] checked=new boolean[all.size()];
        for(int i=0;i<all.size();i++){ApplicationInfo a=all.get(i);labels[i]=String.valueOf(pm.getApplicationLabel(a))+" · "+a.packageName+(isSystemApp(a)?" [system]":"");}
        new AlertDialog.Builder(this).setTitle("Select apps").setMultiChoiceItems(labels,checked,(d,w,c)->checked[w]=c).setNegativeButton("Cancel",null).setPositiveButton("Add to transfer",(d,w)->{
            int added=0;for(int i=0;i<all.size();i++)if(checked[i])added+=exportInstalledApp(all.get(i));selectedText.setText(added+" APK component"+(added==1?"":"s")+" prepared for transfer");}).show();
    }
    private boolean isSystemApp(ApplicationInfo a){return (a.flags&(ApplicationInfo.FLAG_SYSTEM|ApplicationInfo.FLAG_UPDATED_SYSTEM_APP))!=0;}
    private int exportInstalledApp(ApplicationInfo app){
        int added=0;try{File dir=new File(getCacheDir(),"aem-downloads");if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cannot create transfer cache");
            ArrayList<String> paths=new ArrayList<>();if(app.sourceDir!=null)paths.add(app.sourceDir);if(app.splitSourceDirs!=null)Collections.addAll(paths,app.splitSourceDirs);
            for(int i=0;i<paths.size();i++){File src=new File(paths.get(i));if(!src.isFile()||!src.canRead())continue;File out=new File(dir,app.packageName+(i==0?".apk":"-split"+i+".apk"));
                try(InputStream in=new FileInputStream(src);OutputStream o=new FileOutputStream(out)){byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)if(n>0)o.write(b,0,n);}
                selected.add(new Item(FileProvider.getUriForFile(this,getPackageName()+".fileprovider",out),out.getName(),out.length()));added++;}
        }catch(Exception e){update("Could not prepare "+app.packageName+": "+(e.getMessage()==null?"access denied":e.getMessage()),0);}return added;
    }

    private void startReceive(){if(!hasPermission()){requestPermissions(requiredPermissions(),PERM);return;}if(manager==null||channel==null){status.setText("Wi-Fi Direct is unavailable.");return;}
        status.setText("Creating private transfer connection...");manager.createGroup(channel,new WifiP2pManager.ActionListener(){public void onSuccess(){status.setText("Waiting for another AEM phone...");startServer();}public void onFailure(int r){status.setText("Could not create transfer connection: "+r);}});
    }
    private void discover(){if(!hasPermission()){requestPermissions(requiredPermissions(),PERM);return;}if(manager==null||channel==null)return;peerBox.removeAllViews();status.setText("Looking for nearby phones...");
        manager.discoverPeers(channel,new WifiP2pManager.ActionListener(){public void onSuccess(){status.setText("Nearby phones will appear below.");}public void onFailure(int r){status.setText("Discovery failed: "+r);}});
    }
    private void requestPeers(){if(!hasPermission()||manager==null||channel==null)return;manager.requestPeers(channel,list->{peers.clear();peers.addAll(list.getDeviceList());renderPeers();});}
    private void renderPeers(){peerBox.removeAllViews();for(WifiP2pDevice d:peers){Button b=new Button(this);b.setText((d.deviceName==null||d.deviceName.isEmpty()?"Nearby phone":d.deviceName)+" · Send");b.setOnClickListener(v->connect(d));peerBox.addView(b);}}
    private void connect(WifiP2pDevice d){if(selected.isEmpty()){pickFiles();return;}sending=true;status.setText("Connecting to "+d.deviceName+"...");WifiP2pConfig c=new WifiP2pConfig();c.deviceAddress=d.deviceAddress;c.wps.setup=WpsInfo.PBC;
        manager.connect(channel,c,new WifiP2pManager.ActionListener(){public void onSuccess(){status.setText("Connection requested...");}public void onFailure(int r){sending=false;status.setText("Connection failed: "+r);}});
    }
    private void requestConnection(){if(!hasPermission()||manager==null||channel==null)return;manager.requestConnectionInfo(channel,info->{if(info.groupFormed&&sending&&!info.isGroupOwner&&info.groupOwnerAddress!=null){
            sending=false;io.execute(()->sendFiles(info.groupOwnerAddress.getHostAddress()));}});
    }
    private void startServer(){io.execute(()->{try{server=new ServerSocket(PORT);while(!server.isClosed()){Socket s=server.accept();receiveFiles(s);}}catch(Exception ignored){}});}
    
    private void sendFiles(String host){
        try(Socket s=new Socket()){s.connect(new InetSocketAddress(host,PORT),15000);s.setSoTimeout(30000);
            DataOutputStream out=new DataOutputStream(new BufferedOutputStream(s.getOutputStream()));out.writeInt(PROTOCOL);out.writeInt(selected.size());
            long total=0,done=0;for(Item x:selected)total+=x.size;out.writeLong(total);
            for(Item x:selected){byte[] nb=x.name.getBytes("UTF-8");out.writeInt(nb.length);out.write(nb);out.writeLong(x.size);
                byte[] digest=sha256(x);out.writeInt(digest.length);out.write(digest);
                try(InputStream in=getContentResolver().openInputStream(x.uri)){if(in==null)throw new IOException("Cannot read "+x.name);byte[] b=new byte[65536];long left=x.size;int n;
                    while(left>0&&(n=in.read(b,0,(int)Math.min(b.length,left)))>0){out.write(b,0,n);left-=n;done+=n;update("Sending "+x.name,percent(done,total));}
                    if(left!=0)throw new IOException("Source changed while reading "+x.name);
                }}
            out.flush();int result=inResult(s);update(result==1?"Transfer completed and verified":"Transfer rejected",result==1?100:0);
        }catch(Exception e){update("Transfer failed: "+safe(e),0);}
    }
    private int inResult(Socket s)throws IOException{DataInputStream in=new DataInputStream(new BufferedInputStream(s.getInputStream()));return in.readInt();}
    
    private void receiveFiles(Socket s){io.execute(()->{try(Socket sock=s){sock.setSoTimeout(30000);DataInputStream in=new DataInputStream(new BufferedInputStream(sock.getInputStream()));
            int protocol=in.readInt();if(protocol!=PROTOCOL)throw new IOException("Unsupported transfer protocol");int count=in.readInt();if(count<0||count>1000)throw new IOException("Invalid item count");long declaredTotal=in.readLong();if(declaredTotal<0)throw new IOException("Invalid total size");
            ArrayList<Header> hs=new ArrayList<>();long total=0;for(int i=0;i<count;i++){int nl=in.readInt();if(nl<1||nl>16384)throw new IOException("Invalid file name");byte[] nb=new byte[nl];in.readFully(nb);String name=safePath(new String(nb,"UTF-8"));long size=in.readLong();if(size<0)throw new IOException("Invalid file size");int dl=in.readInt();if(dl!=32)throw new IOException("Invalid checksum");byte[] hash=new byte[dl];in.readFully(hash);hs.add(new Header(name,size,hash));total+=size;if(total<0||total>declaredTotal)throw new IOException("Invalid transfer size");}
            File dir=new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"AEM Transfer");if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cannot create transfer folder");
            long done=0;for(Header h:hs){File f=unique(new File(dir,h.name));File parent=f.getParentFile();if(parent!=null&&!parent.exists()&&!parent.mkdirs())throw new IOException("Cannot create destination folder");
                MessageDigest md=MessageDigest.getInstance("SHA-256");try(OutputStream out=new FileOutputStream(f)){byte[] b=new byte[65536];long left=h.size;while(left>0){int n=in.read(b,0,(int)Math.min(b.length,left));if(n<0)throw new IOException("Connection ended");out.write(b,0,n);md.update(b,0,n);left-=n;done+=n;update("Receiving "+h.name,percent(done,total));}}
                if(!Arrays.equals(h.hash,md.digest())){f.delete();throw new IOException("Integrity check failed for "+h.name);}
            }
            DataOutputStream ack=new DataOutputStream(new BufferedOutputStream(sock.getOutputStream()));ack.writeInt(1);ack.flush();update("Transfer received and verified successfully",100);
        }catch(Exception e){try{DataOutputStream ack=new DataOutputStream(new BufferedOutputStream(s.getOutputStream()));ack.writeInt(0);ack.flush();}catch(Exception ignored){}update("Receiving failed: "+safe(e),0);}});
    }
    private static final class Header{String name;long size;byte[] hash;Header(String n,long s,byte[] h){name=n;size=s;hash=h;}}
    private byte[] sha256(Item x)throws Exception{MessageDigest md=MessageDigest.getInstance("SHA-256");try(InputStream in=getContentResolver().openInputStream(x.uri)){if(in==null)throw new IOException("Cannot read "+x.name);byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)if(n>0)md.update(b,0,n);}return md.digest();}
    private String safePath(String n){n=n.replace('\\','/').replace('\0','_').replaceAll("^[\\/]+","");String[] p=n.split("/");StringBuilder b=new StringBuilder();for(String x:p){x=x.replaceAll("[\\:*?\"<>|]","_").trim();if(x.isEmpty()||x.equals(".")||x.equals(".."))continue;if(b.length()>0)b.append(File.separator);b.append(x);}return b.length()==0?"AEM-file":b.toString();}
    private File unique(File f){if(!f.exists())return f;String n=f.getName();int dot=n.lastIndexOf('.');String b=dot>0?n.substring(0,dot):n,e=dot>0?n.substring(dot):"";int i=1;File x;do{x=new File(f.getParentFile(),b+" ("+(i++)+")"+e);}while(x.exists());return x;}
    private int percent(long d,long t){return t>0?(int)Math.max(0,Math.min(100,d*100/t)):0;}
    private String safe(Exception e){String m=e.getMessage();return m==null?"connection interrupted":m;}
    private void update(String text,int pct){runOnUiThread(()->{status.setText(text);progress.setProgress(pct);});}
    @Override protected void onDestroy(){try{unregisterReceiver(receiver);}catch(Exception ignored){}try{if(server!=null)server.close();}catch(Exception ignored){}io.shutdownNow();super.onDestroy();}
}