package com.aem.store;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.*;
import android.content.pm.*;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.wifi.p2p.*;
import android.net.wifi.WpsInfo;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.graphics.drawable.Drawable;
import android.graphics.Bitmap;
import android.util.Size;
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
    private static final int PROTOCOL=3;
    private WifiP2pManager manager; private WifiP2pManager.Channel channel; private BroadcastReceiver receiver;
    private final ExecutorService io=Executors.newCachedThreadPool();
    private final ArrayList<Item> selected=new ArrayList<>(); private final ArrayList<WifiP2pDevice> peers=new ArrayList<>();
    private LinearLayout root,peerBox,contentGrid; private TextView status,selectedText,categoryTitle,modeHint; private ProgressBar progress; private ServerSocket server; private boolean sending=false; private String activeCategory="Apps"; private final HashMap<String,ArrayList<Item>> exportedApps=new HashMap<>(); private final ArrayList<TextView> categoryButtons=new ArrayList<>();

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

    private int dp(int v){return (int)(v*getResources().getDisplayMetrics().density+0.5f);}
    private GradientDrawable bg(int color,int radius){GradientDrawable g=new GradientDrawable();g.setColor(color);g.setCornerRadius(dp(radius));return g;}
    private Button actionButton(String text){Button b=new Button(this);b.setText(text);b.setTextSize(15);b.setAllCaps(false);b.setTextColor(Color.WHITE);b.setMinHeight(dp(52));b.setPadding(dp(12),0,dp(12),0);return b;}

    private void buildUi(){
        root=new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16),dp(14),dp(16),dp(12));
        root.setBackgroundColor(Color.rgb(8,9,12));

        LinearLayout top=new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView title=new TextView(this);
        title.setText("Transfer");
        title.setTextSize(26);
        title.setTextColor(Color.WHITE);
        title.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        top.addView(title,new LinearLayout.LayoutParams(0,dp(44),1));
        TextView close=new TextView(this);
        close.setText("×");
        close.setTextSize(30);
        close.setGravity(Gravity.CENTER);
        close.setTextColor(Color.WHITE);
        close.setOnClickListener(v->finish());
        top.addView(close,new LinearLayout.LayoutParams(dp(44),dp(44)));
        root.addView(top);

        TextView sub=new TextView(this);
        sub.setText("Direct phone-to-phone transfer • no internet or cloud");
        sub.setTextSize(13);
        sub.setTextColor(Color.rgb(170,175,185));
        root.addView(sub,new LinearLayout.LayoutParams(-1,dp(30)));

        LinearLayout modes=new LinearLayout(this);
        modes.setPadding(0,dp(8),0,dp(8));
        Button send=actionButton("Send");
        Button receive=actionButton("Receive");
        send.setTextSize(16);receive.setTextSize(16);
        send.setTextColor(Color.WHITE);receive.setTextColor(Color.WHITE);
        send.setBackground(bg(Color.rgb(50,92,210),14));
        receive.setBackground(bg(Color.rgb(31,34,41),14));
        LinearLayout.LayoutParams mp=new LinearLayout.LayoutParams(0,dp(58),1);mp.setMargins(0,0,dp(6),0);modes.addView(send,mp);
        LinearLayout.LayoutParams rp=new LinearLayout.LayoutParams(0,dp(58),1);rp.setMargins(dp(6),0,0,0);modes.addView(receive,rp);
        root.addView(modes);

        modeHint=label("Choose what to send, then select a nearby phone.",13,Color.rgb(170,175,185));
        modeHint.setPadding(2,2,2,8);
        root.addView(modeHint,new LinearLayout.LayoutParams(-1,dp(30)));

        categoryTitle=new TextView(this);
        categoryTitle.setText("Apps");
        categoryTitle.setTextSize(19);
        categoryTitle.setTextColor(Color.WHITE);
        categoryTitle.setTypeface(null,1);
        categoryTitle.setPadding(0,dp(8),0,dp(8));
        root.addView(categoryTitle,new LinearLayout.LayoutParams(-1,dp(42)));

        HorizontalScrollView tabsScroll=new HorizontalScrollView(this);
        tabsScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout tabs=new LinearLayout(this);
        tabs.setOrientation(LinearLayout.HORIZONTAL);
        String[] categories={"Apps","Photos","Videos","Music","Files"};
        for(String c:categories){
            TextView b=new TextView(this);
            categoryButtons.add(b);
            b.setText(c);b.setTextSize(14);b.setGravity(Gravity.CENTER);b.setTextColor(Color.LTGRAY);
            b.setPadding(dp(18),0,dp(18),0);
            b.setBackground(bg(Color.rgb(27,29,35),22));
            b.setOnClickListener(v->{activeCategory=c;renderCategory();});
            LinearLayout.LayoutParams tp=new LinearLayout.LayoutParams(-2,dp(42));tp.setMargins(0,0,dp(8),0);tabs.addView(b,tp);
        }
        tabsScroll.addView(tabs);
        root.addView(tabsScroll,new LinearLayout.LayoutParams(-1,dp(50)));

        contentGrid=new LinearLayout(this);
        contentGrid.setOrientation(LinearLayout.VERTICAL);
        contentGrid.setPadding(0,dp(8),0,dp(8));
        ScrollView contentScroll=new ScrollView(this);
        contentScroll.setFillViewport(true);
        contentScroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        contentScroll.addView(contentGrid);
        root.addView(contentScroll,new LinearLayout.LayoutParams(-1,0,1));

        LinearLayout selectedBar=new LinearLayout(this);
        selectedBar.setGravity(Gravity.CENTER_VERTICAL);
        selectedBar.setPadding(dp(14),0,dp(14),0);
        selectedBar.setBackground(bg(Color.rgb(24,26,32),14));
        selectedText=new TextView(this);
        selectedText.setTextColor(Color.WHITE);selectedText.setTextSize(13);
        selectedBar.addView(selectedText,new LinearLayout.LayoutParams(0,dp(48),1));
        TextView clear=new TextView(this);clear.setText("Clear");clear.setTextColor(Color.rgb(130,170,255));clear.setGravity(Gravity.CENTER);
        clear.setOnClickListener(v->{selected.clear();exportedApps.clear();refreshSelectedText();});
        selectedBar.addView(clear,new LinearLayout.LayoutParams(dp(60),dp(48)));
        root.addView(selectedBar,new LinearLayout.LayoutParams(-1,dp(52)));

        status=new TextView(this);
        status.setTextColor(Color.rgb(190,195,205));status.setTextSize(12);
        status.setPadding(dp(2),dp(6),dp(2),dp(4));
        root.addView(status,new LinearLayout.LayoutParams(-1,dp(28)));

        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress,new LinearLayout.LayoutParams(-1,dp(5)));

        peerBox=new LinearLayout(this);
        peerBox.setOrientation(LinearLayout.VERTICAL);
        peerBox.setPadding(0,dp(4),0,0);
        root.addView(peerBox);

        LinearLayout bottom=new LinearLayout(this);
        Button chooseFiles=actionButton("Add files");
        Button chooseFolder=actionButton("Add folder");
        LinearLayout.LayoutParams bp=new LinearLayout.LayoutParams(0,dp(50),1);bp.setMargins(0,dp(6),dp(5),0);bottom.addView(chooseFiles,bp);
        LinearLayout.LayoutParams fp=new LinearLayout.LayoutParams(0,dp(50),1);fp.setMargins(dp(5),dp(6),0,0);bottom.addView(chooseFolder,fp);
        root.addView(bottom,new LinearLayout.LayoutParams(-1,dp(56)));

        setContentView(root);

        chooseFiles.setOnClickListener(v->pickFiles());
        chooseFolder.setOnClickListener(v->pickFolder());
        receive.setOnClickListener(v->startReceive());
        send.setOnClickListener(v->{if(selected.isEmpty()){status.setText("Select something to send first.");return;}discover();});
        refreshSelectedText();
        status.setText("Ready");
        updateCategoryButtons();
        renderCategory();
    }
    private boolean hasPermission(){
        return Build.VERSION.SDK_INT>=33?checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES)==PackageManager.PERMISSION_GRANTED:checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }
    private String[] requiredPermissions(){
        ArrayList<String> p=new ArrayList<>();
        p.add(Build.VERSION.SDK_INT>=33?Manifest.permission.NEARBY_WIFI_DEVICES:Manifest.permission.ACCESS_FINE_LOCATION);
        if(Build.VERSION.SDK_INT>=33){
            p.add(Manifest.permission.READ_MEDIA_IMAGES);
            p.add(Manifest.permission.READ_MEDIA_VIDEO);
            p.add(Manifest.permission.READ_MEDIA_AUDIO);
        }else if(Build.VERSION.SDK_INT>=23){
            p.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        return p.toArray(new String[0]);
    }
    @Override public void onRequestPermissionsResult(int r,String[] p,int[] g){super.onRequestPermissionsResult(r,p,g);if(r==PERM){status.setText(hasPermission()?"Permission granted. Ready.":"Required permission was not granted.");renderCategory();}}

    private void renderCategory(){
        if(contentGrid==null)return;
        contentGrid.removeAllViews();
        categoryTitle.setText(activeCategory);
        updateCategoryButtons();
        if("Apps".equals(activeCategory)){renderApps();return;}
        if("Files".equals(activeCategory)){renderFiles();return;}
        renderMedia(activeCategory);
    }

    private TextView label(String text,int size,int color){
        TextView v=new TextView(this);v.setText(text);v.setTextSize(size);v.setTextColor(color);return v;
    }

    private void updateCategoryButtons(){
        for(TextView b:categoryButtons){
            boolean active=b.getText().toString().equals(activeCategory);
            b.setTextColor(active?Color.WHITE:Color.LTGRAY);
            b.setTypeface(Typeface.DEFAULT,active?Typeface.BOLD:Typeface.NORMAL);
            b.setBackground(bg(active?Color.rgb(50,92,210):Color.rgb(27,29,35),22));
        }
    }

    private TextView section(String text){
        TextView v=label(text,14,Color.rgb(170,175,185));
        v.setTypeface(Typeface.DEFAULT,Typeface.BOLD);
        v.setPadding(0,dp(10),0,dp(8));
        return v;
    }

    private void renderApps(){
        TextView hint=section("INSTALLED APPLICATIONS");
        hint.setPadding(0,0,0,8);contentGrid.addView(hint);
        GridLayout grid=new GridLayout(this);grid.setColumnCount(2);
        PackageManager pm=getPackageManager();
        List<ApplicationInfo> all=new ArrayList<>(pm.getInstalledApplications(PackageManager.GET_META_DATA));
        all.removeIf(a->a.packageName.equals(getPackageName()));
        Collections.sort(all,(a,b)->String.valueOf(pm.getApplicationLabel(a)).compareToIgnoreCase(String.valueOf(pm.getApplicationLabel(b))));
        for(ApplicationInfo app:all){
            LinearLayout card=new LinearLayout(this);card.setOrientation(LinearLayout.VERTICAL);card.setPadding(dp(10),dp(10),dp(10),dp(10));
            card.setBackground(bg(Color.rgb(25,27,32),16));
            CheckBox box=new CheckBox(this);box.setText("SELECT");box.setTextColor(Color.LTGRAY);box.setTextSize(11);
            ImageView icon=new ImageView(this);Drawable d=null;try{d=pm.getApplicationIcon(app);}catch(Exception ignored){}
            if(d!=null)icon.setImageDrawable(d);
            card.addView(icon,new LinearLayout.LayoutParams(-1,dp(78)));
            TextView name=label(String.valueOf(pm.getApplicationLabel(app)),15,Color.WHITE);
            name.setTypeface(Typeface.DEFAULT,Typeface.BOLD);name.setGravity(Gravity.CENTER);
            card.addView(name,new LinearLayout.LayoutParams(-1,-2));
            TextView pkg=label(app.packageName,10,Color.GRAY);pkg.setGravity(Gravity.CENTER);card.addView(pkg);
            TextView badge=label(isSystemApp(app)?"SYSTEM APP":"INSTALLED APP",10,isSystemApp(app)?Color.rgb(255,190,80):Color.rgb(110,210,150));
            badge.setGravity(Gravity.CENTER);card.addView(badge);
            box.setOnCheckedChangeListener((button,checked)->{
                if(checked){
                    ArrayList<Item> made=new ArrayList<>();
                    exportInstalledApp(app,made);
                    exportedApps.put(app.packageName,made);
                }else{
                    ArrayList<Item> made=exportedApps.remove(app.packageName);
                    if(made!=null)selected.removeAll(made);
                    refreshSelectedText();
                }
            });
            card.addView(box);
            GridLayout.LayoutParams gp=new GridLayout.LayoutParams();
            gp.width=0;gp.height=GridLayout.LayoutParams.WRAP_CONTENT;
            gp.columnSpec=GridLayout.spec(GridLayout.UNDEFINED,1f);
            gp.setMargins(dp(4),dp(4),dp(4),dp(4));
            grid.addView(card,gp);
        }
        contentGrid.addView(grid);
    }

    private void renderMedia(String category){
        String permission=category.equals("Photos")?Manifest.permission.READ_MEDIA_IMAGES:category.equals("Videos")?Manifest.permission.READ_MEDIA_VIDEO:Manifest.permission.READ_MEDIA_AUDIO;
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED){
            Button allow=new Button(this);allow.setText("ALLOW "+category.toUpperCase()+" ACCESS");
            allow.setOnClickListener(v->requestPermissions(new String[]{permission},PERM));
            contentGrid.addView(label("AEM needs permission to show "+category.toLowerCase()+" directly in the transfer picker.",14,Color.LTGRAY));
            contentGrid.addView(allow);return;
        }
        io.execute(()->{
            ArrayList<Item> items=new ArrayList<>();
            Uri base=category.equals("Photos")?MediaStore.Images.Media.EXTERNAL_CONTENT_URI:category.equals("Videos")?MediaStore.Video.Media.EXTERNAL_CONTENT_URI:MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            String[] proj={MediaStore.MediaColumns._ID,MediaStore.MediaColumns.DISPLAY_NAME,MediaStore.MediaColumns.SIZE};
            Cursor c=null;try{
                c=getContentResolver().query(base,proj,null,null,MediaStore.MediaColumns.DATE_ADDED+" DESC");
                if(c!=null){
                    int id=c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID),name=c.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME),size=c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
                    int count=0;
                    while(c.moveToNext()&&count++<100){
                        long row=c.getLong(id);String n=c.getString(name);long z=c.isNull(size)?0:c.getLong(size);
                        items.add(new Item(ContentUris.withAppendedId(base,row),n,z));
                    }
                }
            }catch(Exception e){runOnUiThread(()->status.setText("Could not load "+category+": "+safe(e)));}finally{if(c!=null)c.close();}
            runOnUiThread(()->showMediaItems(category,items));
        });
    }

    private void showMediaItems(String category,ArrayList<Item> items){
        contentGrid.removeAllViews();
        contentGrid.addView(section(items.size()+" "+category.toUpperCase()+" AVAILABLE"));
        for(Item x:items){
            LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(10),dp(8),dp(10),dp(8));row.setBackground(bg(Color.rgb(24,26,31),14));
            ImageView thumb=new ImageView(this); thumb.setScaleType(ImageView.ScaleType.CENTER_CROP); thumb.setImageResource(android.R.drawable.ic_menu_gallery); row.addView(thumb,new LinearLayout.LayoutParams(dp(70),dp(70))); if(!category.equals("Music"))loadThumbnail(thumb,x.uri);
            LinearLayout textBox=new LinearLayout(this);textBox.setOrientation(LinearLayout.VERTICAL);
            textBox.addView(label(x.name,14,Color.WHITE));textBox.addView(label(format(x.size),11,Color.GRAY));
            row.addView(textBox,new LinearLayout.LayoutParams(0,-2,1));
            CheckBox box=new CheckBox(this);box.setText("SELECT");box.setTextColor(Color.LTGRAY);
            box.setOnCheckedChangeListener((b,checked)->{if(checked){if(!containsItem(x))selected.add(x);}else removeItem(x);refreshSelectedText();});
            row.addView(box);
            contentGrid.addView(row,new LinearLayout.LayoutParams(-1,-2));
        }
        if(items.isEmpty())contentGrid.addView(label("No "+category.toLowerCase()+" found on this device.",14,Color.GRAY));
    }

    private boolean containsItem(Item x){for(Item y:selected)if(String.valueOf(y.uri).equals(String.valueOf(x.uri)))return true;return false;}
    private void removeItem(Item x){Iterator<Item> it=selected.iterator();while(it.hasNext())if(String.valueOf(it.next().uri).equals(String.valueOf(x.uri)))it.remove();}

    private void loadThumbnail(ImageView view,Uri uri){
        if(Build.VERSION.SDK_INT<29)return;
        io.execute(()->{
            try{
                Bitmap b=getContentResolver().loadThumbnail(uri,new Size(120,120),null);
                runOnUiThread(()->view.setImageBitmap(b));
            }catch(Exception ignored){}
        });
    }

    private void renderFiles(){
        contentGrid.addView(section("FILES & DOCUMENTS"));
        contentGrid.addView(label("Documents, ZIPs, APKs and folders are transferred directly. AEM does not open or play them.",13,Color.LTGRAY));
        Button b=new Button(this);b.setText("BROWSE FILES");b.setOnClickListener(v->pickFiles());contentGrid.addView(b);
        Button f=new Button(this);f.setText("BROWSE FOLDER");f.setOnClickListener(v->pickFolder());contentGrid.addView(f);
        contentGrid.addView(label("Selected files stay in the transfer list below.",12,Color.GRAY));
    }

    private int exportInstalledApp(ApplicationInfo app,ArrayList<Item> made){
        int added=0;try{
            File dir=new File(getCacheDir(),"aem-downloads");
            if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cannot create transfer cache");
            ArrayList<String> paths=new ArrayList<>();
            if(app.sourceDir!=null)paths.add(app.sourceDir);
            if(app.splitSourceDirs!=null)Collections.addAll(paths,app.splitSourceDirs);
            for(int i=0;i<paths.size();i++){
                File src=new File(paths.get(i));if(!src.isFile()||!src.canRead())continue;
                File out=new File(dir,app.packageName+(i==0?".apk":"-split"+i+".apk"));
                try(InputStream in=new FileInputStream(src);OutputStream o=new FileOutputStream(out)){
                    byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)if(n>0)o.write(b,0,n);
                }
                Item item=new Item(FileProvider.getUriForFile(this,getPackageName()+".fileprovider",out),out.getName(),out.length());
                selected.add(item);made.add(item);added++;
            }
        }catch(Exception e){update("Could not prepare "+app.packageName+": "+(e.getMessage()==null?"access denied":e.getMessage()),0);}
        refreshSelectedText();return added;
    }

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
    private void addTree(Uri tree){addTree(tree,"");}
    private void addTree(Uri tree,String relative){
        Cursor c=null;try{String doc=DocumentsContract.getTreeDocumentId(tree);Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,doc);
            c=getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE},null,null,null);
            if(c!=null)while(c.moveToNext()){String id=c.getString(0),name=c.getString(1),mime=c.getString(2);Uri child=DocumentsContract.buildDocumentUriUsingTree(tree,id);
                String path=relative.isEmpty()?name:relative+"/"+name;
                if(DocumentsContract.Document.MIME_TYPE_DIR.equals(mime))addTree(child,path);
                else selected.add(new Item(child,path,Math.max(0,c.isNull(3)?size(child):c.getLong(3))));
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
    private int exportInstalledApp(ApplicationInfo app){ArrayList<Item> made=new ArrayList<>();return exportInstalledApp(app,made);}

    private void startReceive(){if(!hasPermission()){requestPermissions(requiredPermissions(),PERM);return;}
        sending=false;
        modeHint.setText("Receive mode: keep this screen open while the sender connects.");if(manager==null||channel==null){status.setText("Wi-Fi Direct is unavailable.");return;}
        status.setText("Creating private transfer connection...");manager.createGroup(channel,new WifiP2pManager.ActionListener(){public void onSuccess(){status.setText("Waiting for another AEM phone...");startServer();}public void onFailure(int r){status.setText("Could not create transfer connection: "+r);}});
    }
    private void discover(){if(!hasPermission()){requestPermissions(requiredPermissions(),PERM);return;}
        modeHint.setText("Send mode: select a nearby phone below to begin.");if(manager==null||channel==null)return;peerBox.removeAllViews();status.setText("Looking for nearby phones...");
        manager.discoverPeers(channel,new WifiP2pManager.ActionListener(){public void onSuccess(){status.setText("Nearby phones will appear below.");}public void onFailure(int r){status.setText("Discovery failed: "+r);}});
    }
    private void requestPeers(){if(!hasPermission()||manager==null||channel==null)return;manager.requestPeers(channel,list->{peers.clear();peers.addAll(list.getDeviceList());renderPeers();});}
    private void renderPeers(){peerBox.removeAllViews();for(WifiP2pDevice d:peers){
        Button b=actionButton((d.deviceName==null||d.deviceName.isEmpty()?"Nearby phone":d.deviceName)+"  •  Send");
        b.setGravity(Gravity.CENTER);b.setBackground(bg(Color.rgb(34,38,47),12));
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(56));p.setMargins(0,dp(4),0,dp(4));peerBox.addView(b,p);
        b.setOnClickListener(v->connect(d));
    }}
    private void connect(WifiP2pDevice d){if(selected.isEmpty()){status.setText("Select at least one item first.");return;}sending=true;status.setText("Connecting to "+d.deviceName+"...");WifiP2pConfig c=new WifiP2pConfig();c.deviceAddress=d.deviceAddress;c.wps.setup=WpsInfo.PBC;
        manager.connect(channel,c,new WifiP2pManager.ActionListener(){public void onSuccess(){status.setText("Connection requested...");}public void onFailure(int r){sending=false;status.setText("Connection failed: "+r);}});
    }
    private void requestConnection(){if(!hasPermission()||manager==null||channel==null)return;manager.requestConnectionInfo(channel,info->{if(info.groupFormed&&sending&&!info.isGroupOwner&&info.groupOwnerAddress!=null){
            sending=false;io.execute(()->sendFiles(info.groupOwnerAddress.getHostAddress()));}});
    }
    private void startServer(){io.execute(()->{try{server=new ServerSocket(PORT);while(!server.isClosed()){Socket s=server.accept();receiveFiles(s);}}catch(Exception ignored){}});}
    
    private void sendFiles(String host){
        try(Socket s=new Socket()){
            s.setTcpNoDelay(true);
            s.setSendBufferSize(1024*1024);
            s.connect(new InetSocketAddress(host,PORT),15000);
            s.setSoTimeout(60000);
            DataOutputStream out=new DataOutputStream(new BufferedOutputStream(s.getOutputStream(),256*1024));
            out.writeInt(PROTOCOL);out.writeInt(selected.size());
            long total=0,done=0;for(Item x:selected)total+=x.size;out.writeLong(total);
            byte[] b=new byte[256*1024];
            for(Item x:selected){
                byte[] nb=x.name.getBytes("UTF-8");out.writeInt(nb.length);out.write(nb);out.writeLong(x.size);
                MessageDigest md=MessageDigest.getInstance("SHA-256");
                try(InputStream in=getContentResolver().openInputStream(x.uri)){
                    if(in==null)throw new IOException("Cannot read "+x.name);
                    long left=x.size;int n;
                    while(left>0&&(n=in.read(b,0,(int)Math.min(b.length,left)))>0){
                        out.write(b,0,n);md.update(b,0,n);left-=n;done+=n;update("Sending "+x.name+" · "+percent(done,total)+"%",percent(done,total));
                    }
                    if(left!=0)throw new IOException("Source changed while reading "+x.name);
                }
                out.write(md.digest());
            }
            out.flush();
            int result=inResult(s);
            update(result==1?"Transfer completed and verified":"Transfer rejected",result==1?100:0);
        }catch(Exception e){update("Transfer failed: "+safe(e),0);}
    }
    private int inResult(Socket s)throws IOException{DataInputStream in=new DataInputStream(new BufferedInputStream(s.getInputStream()));return in.readInt();}
    
    private void receiveFiles(Socket s){io.execute(()->{
        try(Socket sock=s){
            sock.setTcpNoDelay(true);sock.setReceiveBufferSize(1024*1024);sock.setSoTimeout(60000);
            DataInputStream in=new DataInputStream(new BufferedInputStream(sock.getInputStream(),256*1024));
            int protocol=in.readInt();if(protocol!=PROTOCOL)throw new IOException("Unsupported transfer protocol");
            int count=in.readInt();if(count<0||count>1000)throw new IOException("Invalid item count");
            long declaredTotal=in.readLong();if(declaredTotal<0)throw new IOException("Invalid total size");
            ArrayList<Header> hs=new ArrayList<>();long total=0;
            for(int i=0;i<count;i++){
                int nl=in.readInt();if(nl<1||nl>16384)throw new IOException("Invalid file name");
                byte[] nb=new byte[nl];in.readFully(nb);String name=safePath(new String(nb,"UTF-8"));
                long size=in.readLong();if(size<0)throw new IOException("Invalid file size");
                hs.add(new Header(name,size,null));total+=size;
                if(total<0||total>declaredTotal)throw new IOException("Invalid transfer size");
            }
            File dir=new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"AEM Transfer");
            if(!dir.exists()&&!dir.mkdirs())throw new IOException("Cannot create transfer folder");
            long done=0;byte[] b=new byte[256*1024];
            for(Header h:hs){
                File f=unique(new File(dir,h.name));File parent=f.getParentFile();
                if(parent!=null&&!parent.exists()&&!parent.mkdirs())throw new IOException("Cannot create destination folder");
                MessageDigest md=MessageDigest.getInstance("SHA-256");
                try(OutputStream out=new BufferedOutputStream(new FileOutputStream(f),256*1024)){
                    long left=h.size;while(left>0){
                        int n=in.read(b,0,(int)Math.min(b.length,left));if(n<0)throw new IOException("Connection ended");
                        out.write(b,0,n);md.update(b,0,n);left-=n;done+=n;
                        update("Receiving "+h.name+" · "+percent(done,total)+"%",percent(done,total));
                    }
                }
                byte[] expected=new byte[32];in.readFully(expected);
                if(!Arrays.equals(expected,md.digest())){f.delete();throw new IOException("Integrity check failed for "+h.name);}
            }
            DataOutputStream ack=new DataOutputStream(new BufferedOutputStream(sock.getOutputStream(),64*1024));
            ack.writeInt(1);ack.flush();update("Transfer received and verified successfully",100);
        }catch(Exception e){
            try{DataOutputStream ack=new DataOutputStream(new BufferedOutputStream(s.getOutputStream(),64*1024));ack.writeInt(0);ack.flush();}catch(Exception ignored){}
            update("Receiving failed: "+safe(e),0);
        }
    });}
    private static final class Header{String name;long size;byte[] hash;Header(String n,long s,byte[] h){name=n;size=s;hash=h;}}
    private byte[] sha256(Item x)throws Exception{MessageDigest md=MessageDigest.getInstance("SHA-256");try(InputStream in=getContentResolver().openInputStream(x.uri)){if(in==null)throw new IOException("Cannot read "+x.name);byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)if(n>0)md.update(b,0,n);}return md.digest();}
    private String safePath(String n){n=n.replace('\\','/').replace('\0','_').replaceAll("^[\\/]+","");String[] p=n.split("/");StringBuilder b=new StringBuilder();for(String x:p){x=x.replaceAll("[\\:*?\"<>|]","_").trim();if(x.isEmpty()||x.equals(".")||x.equals(".."))continue;if(b.length()>0)b.append(File.separator);b.append(x);}return b.length()==0?"AEM-file":b.toString();}
    private File unique(File f){if(!f.exists())return f;String n=f.getName();int dot=n.lastIndexOf('.');String b=dot>0?n.substring(0,dot):n,e=dot>0?n.substring(dot):"";int i=1;File x;do{x=new File(f.getParentFile(),b+" ("+(i++)+")"+e);}while(x.exists());return x;}
    private int percent(long d,long t){return t>0?(int)Math.max(0,Math.min(100,d*100/t)):0;}
    private String safe(Exception e){String m=e.getMessage();return m==null?"connection interrupted":m;}
    private void update(String text,int pct){runOnUiThread(()->{status.setText(text);progress.setProgress(pct);});}
    @Override protected void onDestroy(){try{unregisterReceiver(receiver);}catch(Exception ignored){}try{if(server!=null)server.close();}catch(Exception ignored){}try{if(manager!=null&&channel!=null)manager.removeGroup(channel,new WifiP2pManager.ActionListener(){public void onSuccess(){}public void onFailure(int r){}});}catch(Exception ignored){}io.shutdownNow();super.onDestroy();}
}