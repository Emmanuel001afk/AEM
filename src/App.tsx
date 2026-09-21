import {useEffect,useMemo,useState} from "react";
import {demoCatalog} from "./services/catalog/mock";
import {loadSupabaseCatalog} from "./services/catalog/supabase";
import {filterCatalog} from "./domain/catalog";
import {demoNotifications} from "./data/notifications";
import {requestGithubBuild,listBuildRequests} from "./services/builds/github";

const nav=["Home","Apps","Build","Updates","Downloads","Settings"];

export default function App(){
 const[tab,setTab]=useState("Home"),[dark,setDark]=useState(true),[q,setQ]=useState(""),[showNotifications,setShowNotifications]=useState(false);
 const[apps,setApps]=useState(demoCatalog),[connected,setConnected]=useState(false),[builds,setBuilds]=useState<any[]>([]);
 const[repo,setRepo]=useState(""),[ref,setRef]=useState("main"),[variant,setVariant]=useState("debug"),[channel,setChannel]=useState<"stable"|"beta"|"development">("development"),[building,setBuilding]=useState(false),[buildMessage,setBuildMessage]=useState("");
 const load=()=>{loadSupabaseCatalog().then(x=>{setApps(x);setConnected(true)}).catch(()=>setConnected(false));listBuildRequests().then(setBuilds).catch(()=>{})};
 useEffect(()=>{load();const t=setInterval(load,15000);return()=>clearInterval(t)},[]);
 const filtered=useMemo(()=>filterCatalog(apps,{query:q}),[apps,q]),unread=demoNotifications.filter(n=>!n.read).length;
 async function build(){setBuildMessage("");setBuilding(true);try{await requestGithubBuild({repository:repo,ref,variant,channel});setRepo("");setBuildMessage("Queued. AEM will build it automatically.");load()}catch(e){setBuildMessage(e instanceof Error?e.message:"Build request failed")}finally{setBuilding(false)}}
 return <main className={dark?"store dark":"store"}>
  <header><div className="brand"><span>A</span>EM <small>STORE</small></div><div className="head-actions"><button onClick={()=>setDark(!dark)}>{dark?"Light":"Dark"}</button><button className="icon" onClick={()=>setShowNotifications(!showNotifications)}>♢ {unread}</button></div></header>
  {showNotifications&&<section className="notification-panel"><b>Notifications</b>{demoNotifications.map(n=><p key={n.id}><strong>{n.title}</strong><br/>{n.body}</p>)}</section>}
  <nav>{nav.map(n=><button key={n} className={tab===n?"active":""} onClick={()=>setTab(n)}>{n}</button>)}</nav>
  {tab==="Home"&&<section className="hero"><p className="eyebrow">AEM STORE</p><h1>Your software.<br/><em>One place.</em></h1><p>Discover, build, install and update applications from GitHub.</p><div className="search"><span>⌕</span><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search apps, tools and releases"/></div></section>}
  {tab==="Build"&&<section className="content build-panel"><div className="section-head"><div><span>BUILD FROM SOURCE</span><h2>GitHub → APK</h2></div><span>AUTOMATIC</span></div><p>Give AEM any public GitHub Android repository. AEM queues it, builds it on GitHub Actions, captures the APK and publishes the result to the store.</p><div className="build-form"><input value={repo} onChange={e=>setRepo(e.target.value)} placeholder="owner/repository or GitHub URL"/><input value={ref} onChange={e=>setRef(e.target.value)} placeholder="Branch, tag or commit"/><select value={variant} onChange={e=>setVariant(e.target.value)}><option value="debug">Debug</option><option value="release">Release</option></select><select value={channel} onChange={e=>setChannel(e.target.value as any)}><option value="development">Development</option><option value="beta">Beta</option><option value="stable">Stable</option></select><button className="install" onClick={build} disabled={building||!repo.trim()}>{building?"QUEUEING…":"BUILD APK"}</button></div>{buildMessage&&<p className="build-message">{buildMessage}</p>}<div className="build-list"><h3>Build queue</h3>{builds.length?builds.map(b=><article className="card compact" key={b.id}><strong>{b.repository}</strong><span>{b.ref} · {b.variant} · {b.status}</span>{b.error&&<small>{b.error}</small>}</article>):<p>No builds yet.</p>}</div></section>}
  {(tab==="Apps"||tab==="Home")&&<section className="content"><div className="section-head"><div><span>LIBRARY</span><h2>{tab==="Home"?"Your applications":"All applications"}</h2></div><span>{filtered.length} apps · {connected?"LIVE":"DEMO"}</span></div><div className="grid">{filtered.map(a=><article className="card" key={a.id.project}><div className="app-icon">{a.name[0]}</div><div className="card-main"><div className="meta">{a.category} · {a.platforms.join(" · ")}</div><h3>{a.name}</h3><p>{a.description}</p><div className="chips">{a.functionality.slice(0,3).map(x=><span key={x}>{x}</span>)}</div></div><button className="install" onClick={()=>window.open((a.latest?.stable||a.latest?.beta||a.latest?.development)?.artifacts?.find((x:any)=>x.kind==="apk")?.downloadUrl || (a.sourceUrl||"#")+"/releases/latest","_blank")}>INSTALL</button><details><summary>Details</summary><p><b>Source</b> · GitHub · {a.id.project}</p><p><b>Permissions</b> · {a.permissions.join(", ")||"None listed"}</p></details></article>)}</div></section>}
  {tab==="Updates"&&<section className="empty"><h2>Updates</h2><p>AEM checks published releases and will surface compatible newer versions here.</p></section>}
  {tab==="Downloads"&&<section className="empty"><h2>Downloads</h2><p>Built and published artifacts will appear here with their release history.</p></section>}
  {tab==="Settings"&&<section className="empty"><h2>Settings</h2><p>Appearance · Language · Notifications · Release channels · Installer · Source providers</p></section>}
  <footer><span>● {connected?"Supabase connected":"Using local catalog"}</span><span>GitHub build engine · Android · Web</span></footer>
 </main>
}
