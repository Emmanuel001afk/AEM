import {createClient} from "npm:@supabase/supabase-js@2";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-github-token"};

function json(body:unknown,status=200){return Response.json(body,{status,headers:{...cors,"Content-Type":"application/json"}})}
function admin(){const raw=Deno.env.get("SUPABASE_SECRET_KEYS")||"{}";const keys=JSON.parse(raw);const key=keys.default||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!key)throw new Error("Supabase server key unavailable");return createClient(Deno.env.get("SUPABASE_URL")!,key)}

async function githubUser(token:string){
 const r=await fetch("https://api.github.com/user",{headers:{"Accept":"application/vnd.github+json","Authorization":`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28"}});
 if(!r.ok)throw new Error("Invalid GitHub credential");
 return r.json();
}

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 try{
  const token=(req.headers.get("x-github-token")||"").trim();
  if(!token)return json({error:"GitHub credential required"},401);
  await githubUser(token);
  const body=await req.json().catch(()=>({}));
  const action=String(body.action||"");
  const sb=admin();

  if(action==="claim"){
    const row=(await sb.from("build_requests").select("*").eq("status","queued").order("created_at",{ascending:true}).limit(1).maybeSingle()).data;
    if(!row)return json({found:false});
    const access=await fetch(`https://api.github.com/repos/${row.repository}`,{headers:{"Accept":"application/vnd.github+json","Authorization":`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28"}});
    if(!access.ok)return json({found:false});
    const updated=await sb.from("build_requests").update({status:"running",workflow_run_id:Number(body.run_id||0)||null,updated_at:new Date().toISOString()}).eq("id",row.id).eq("status","queued").select("*").single();
    if(updated.error)throw updated.error;
    return json({found:true,request:updated.data});
  }

  if(action==="fail"||action==="cancel"){
    const id=String(body.id||"");
    if(!id)return json({error:"Build request id required"},400);
    const request=(await sb.from("build_requests").select("id,repository,workflow_run_id").eq("id",id).maybeSingle()).data;
    if(!request)return json({error:"Build request not found"},404);
    if(String(body.repository||"")!==String(request.repository))return json({error:"Repository mismatch"},403);
    if(Number(body.run_id||0)!==Number(request.workflow_run_id||0))return json({error:"Workflow run mismatch"},403);
    const access=await fetch(`https://api.github.com/repos/${request.repository}`,{headers:{"Accept":"application/vnd.github+json","Authorization":`Bearer ${token}`,"X-GitHub-Api-Version":"2022-11-28"}});
    if(!access.ok)return json({error:"GitHub credential cannot access the requested repository."},403);
    const status=action==="cancel"?"queued":"failed";
    const patch:any={status,error:body.error?String(body.error):null,updated_at:new Date().toISOString()};
    if(action==="cancel")patch.workflow_run_id=null;
    const updated=await sb.from("build_requests").update(patch).eq("id",id).eq("status","running").select("id,status,error").maybeSingle();
    if(updated.error)throw updated.error;
    return json({ok:true,request:updated.data});
  }

  return json({error:"Unsupported action"},400);
 }catch(e){return json({error:e instanceof Error?e.message:String(e)},500)}
});