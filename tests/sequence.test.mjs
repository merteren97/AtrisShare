import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { defaultSequenceProfile, applySequenceOperations, sequenceFrames, sequencePositions, legacySequenceClips } from "../dist/packages/domain/src/sequence.js";
import { SequenceService } from "../dist/services/local-api/src/sequence.js";
import { SequenceMcp } from "../dist/services/local-api/src/sequence-mcp.js";
import { startApi } from "../dist/services/local-api/src/server.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

function fixture(t,path=":memory:") { const store=new WorkspaceStore(path);t.after(()=>store.close());const account=store.createAccount({displayName:"Editor",platform:"local"}),project=store.createProject({accountId:account.id,name:"Montage",description:""}),context={accountId:account.id,projectId:project.id};const add=(name)=>store.studio.addArtifact({id:randomUUID(),...context,filename:name,sha256:(name==="A.mp4"?"a":"b").repeat(64),bytes:16,mimeType:"video/mp4",probe:{duration:60,width:640,height:360,hasAudio:true},sourceId:null,channelVideoId:null,createdAt:new Date().toISOString(),kind:"source"});const A=add("A.mp4"),B=add("B.mp4");return{store,account,project,context,A,B}; }
const clip=(a,start=0,end=30)=>({id:randomUUID(),sourceArtifactId:a.id,sourceSha256:a.sha256,inFrame:start,outFrame:end,gapBeforeFrames:0,crop:"original",gainDb:0,caption:""});
const empty=()=>({profile:{...defaultSequenceProfile},clips:[]});
const err=code=>e=>e.code===code;

test("A10–20 → B5–18 → A40–45 uses independent placements and integer output positions",t=>{
 const f=fixture(t),clips=[clip(f.A,300,600),clip(f.B,150,540),clip(f.A,1200,1350)],s=applySequenceOperations(empty(),[{type:"appendClips",clips}],id=>f.store.studio.artifact(id,f.context));
 assert.equal(sequenceFrames(s),840);assert.deepEqual(sequencePositions(s).map(p=>[p.startFrame,p.endFrame]),[[0,300],[300,690],[690,840]]);
 const moved=applySequenceOperations(s,[{type:"moveClip",clipId:clips[2].id,index:0},{type:"trimClip",clipId:clips[0].id,inFrame:330,outFrame:570}],id=>f.store.studio.artifact(id,f.context));
 assert.equal(moved.clips[0].inFrame,1200);assert.equal(moved.clips[1].inFrame,330);assert.equal(s.clips[0].inFrame,300);
 assert.throws(()=>applySequenceOperations(s,[{type:"duplicateClip",clipId:clips[0].id,newClipId:clips[1].id}],id=>f.store.studio.artifact(id,f.context)),/sequence_duplicate_clip/);
});
test("split preserves source clock/cues and gap delete differs from ripple",t=>{
 const f=fixture(t),a={...clip(f.A,300,600),timedCaptions:[{start:11,end:12,text:"Literal"}]},b=clip(f.B,60,120),source=id=>f.store.studio.artifact(id,f.context),s=applySequenceOperations(empty(),[{type:"appendClips",clips:[a,b]}],source),id=randomUUID();
 const split=applySequenceOperations(s,[{type:"splitClip",clipId:a.id,atFrame:450,newClipId:id}],source);assert.deepEqual(split.clips.map(c=>[c.inFrame,c.outFrame]),[[300,450],[450,600],[60,120]]);assert.equal(sequenceFrames(split),360);assert.deepEqual(split.clips[1].timedCaptions,a.timedCaptions);
 const gap=applySequenceOperations(split,[{type:"removeClip",clipId:id,closeGap:false}],source),ripple=applySequenceOperations(split,[{type:"removeClip",clipId:id,closeGap:true}],source);assert.equal(sequenceFrames(gap),360);assert.equal(gap.clips[1].gapBeforeFrames,150);assert.equal(sequenceFrames(ripple),210);
 for(const ops of [[{type:"trimClip",clipId:a.id,inFrame:600,outFrame:7000}],[{type:"splitClip",clipId:a.id,atFrame:300,newClipId:randomUUID()}],[{type:"setClipGain",clipId:randomUUID(),gainDb:0}],[{type:"appendClips",clips:[{...clip(f.A),sourceSha256:"c".repeat(64)}]}]])assert.throws(()=>applySequenceOperations(s,ops,source));
});
test("persistent batch history is atomic, CAS protected, branch-aware, isolated and restored with project",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"atris-sequence-"));const path=join(dir,"workspace.sqlite"),f=fixture(t,path);t.after(()=>rm(dir,{recursive:true,force:true}));const initial=f.store.sequences.get(f.context),a=clip(f.A,30,90),b=clip(f.B,0,60);let s=f.store.sequences.apply(f.context,0,[{type:"appendClips",clips:[a,b,clip(f.A,120,180)]}]);
 assert.throws(()=>f.store.sequences.apply(f.context,0,[{type:"setClipGain",clipId:a.id,gainDb:-6}]),err("revision_conflict"));
 assert.throws(()=>f.store.sequences.apply(f.context,1,[{type:"setClipGain",clipId:a.id,gainDb:-6},{type:"trimClip",clipId:b.id,inFrame:50,outFrame:50000}]));assert.equal(f.store.sequences.get(f.context).clips[0].gainDb,0);
 s=f.store.sequences.apply(f.context,1,[{type:"setClipGain",clipId:a.id,gainDb:-6},{type:"setClipFraming",clipId:b.id,crop:"square"}]);assert.equal(s.historyLength,3);s=f.store.sequences.history(f.context,s.revision,"undo");assert.equal(s.clips[0].gainDb,0);assert.equal(s.clips[1].crop,"original");s=f.store.sequences.history(f.context,s.revision,"redo");assert.equal(s.clips[0].gainDb,-6);
 const second=new WorkspaceStore(path);try{assert.deepEqual(second.sequences.get(f.context),s);const other=f.store.createAccount({displayName:"Other",platform:"local"});assert.throws(()=>second.sequences.get({...f.context,accountId:other.id}),err("context_not_found"));}finally{second.close();}
 s=f.store.sequences.history(f.context,s.revision,"undo");s=f.store.sequences.apply(f.context,s.revision,[{type:"setCaption",clipId:a.id,caption:"branch"}]);assert.throws(()=>f.store.sequences.history(f.context,s.revision,"redo"),err("sequence_history_bounds"));
 const removed=f.store.trashProject(f.project.id,{context:f.context,expectedRevision:1});assert.throws(()=>f.store.sequences.get(f.context));f.store.restoreProject(f.project.id,{context:f.context,expectedRevision:removed.revision});assert.deepEqual(f.store.sequences.get(f.context),s);assert.equal(s.id,initial.id);
});
test("explicit legacy import preserves kept ranges and complete original history",t=>{const f=fixture(t),e={inSeconds:1,outSeconds:10,segments:[{inSeconds:1,outSeconds:3},{inSeconds:7,outSeconds:10}],crop:"vertical",cropX:.2,gainDb:-4,caption:"Legacy",timedCaptions:[{start:2,end:3,text:"speech"}]};f.store.studio.edit(f.A.id,f.context,0,e);const before=f.store.studio.timeline(f.A.id,f.context),clips=legacySequenceClips(f.A,e,30,randomUUID);f.store.sequences.apply(f.context,0,[{type:"appendClips",clips}]);assert.deepEqual(clips.map(c=>[c.inFrame,c.outFrame]),[[30,90],[210,300]]);assert.equal(clips[1].cropX,.2);assert.deepEqual(f.store.studio.timeline(f.A.id,f.context),before);});

test("pre-v12 SQLite upgrades back up atomically without inventing sequences or merging legacy timelines",async t=>{const dir=await mkdtemp(join(tmpdir(),"atris-seq-migration-"));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,"workspace.sqlite");let s=new WorkspaceStore(path),account=s.createAccount({displayName:"Old",platform:"local"}),p=s.createProject({accountId:account.id,name:"Old project",description:"preserved"});s.close();const db=new DatabaseSync(path);db.exec("DROP TABLE sequence_work; DROP TABLE sequences; PRAGMA user_version=11;");db.close();s=new WorkspaceStore(path);try{assert.equal(s.listProjects(account.id)[0].description,"preserved");assert.equal(s.db.prepare("SELECT count(*) n FROM sequences").get().n,0);const backup=new DatabaseSync(`${path}.before-v12.sqlite`);try{assert.equal(backup.prepare("PRAGMA user_version").get().user_version,11);assert.equal(backup.prepare("SELECT name FROM projects WHERE id=?").get(p.id).name,"Old project");}finally{backup.close();}}finally{s.close();}});

function controlledService(f,bridge){const studio={engine:{verify:async()=>true,remove:async()=>{},renderSequence:async()=>{throw new Error("not requested");}}};const service=new SequenceService(f.store,studio,bridge??{discover:async()=>({available:true,models:["test/model"],error:null}),proposeSequence:async()=>({summary:"Batch",operations:[],sessionId:null})});return service;}
async function waitFor(fn){for(let i=0;i<300;i++){const result=fn();if(result.state!=="running")return result;await delay(10);}assert.fail("work did not settle");}
test("AI multi-operation proposal is uncommitted until human acceptance, stale proposals cannot overwrite manual edits",async t=>{const f=fixture(t),a=clip(f.A,0,300);f.store.sequences.apply(f.context,0,[{type:"appendClips",clips:[a,clip(f.B),clip(f.A,600,630)]}]);const service=controlledService(f,{discover:async()=>({available:true,models:["test/model"],error:null}),proposeSequence:async({prompt})=>{const p=JSON.parse(prompt);assert.equal(p.snapshot.clips.length,3);assert.equal(p.snapshot.clips[0].timedCaptions,undefined);return{summary:"Trim and gain",operations:[{type:"trimClip",clipId:a.id,inFrame:30,outFrame:270},{type:"setClipGain",clipId:a.id,gainDb:-6}]};}});t.after(()=>service.close());const input={context:f.context,expectedRevision:1,model:"test/model",instruction:"Shorten",scope:"sequence",selectedClipIds:[],allowRemote:true};let p=await service.propose(input);p=await waitFor(()=>service.proposals(f.context).find(x=>x.id===p.id));assert.equal(p.state,"ready");assert.equal(service.get(f.context).revision,1);await service.review(p.id,f.context,"accept");let s=service.get(f.context);assert.equal(s.clips[0].gainDb,-6);s=f.store.sequences.history(f.context,s.revision,"undo");assert.equal(s.clips[0].gainDb,0);assert.equal(s.clips[0].inFrame,0);const external=service.externalProposal(f.context,s.revision,[{type:"setClipGain",clipId:a.id,gainDb:-12}],"Older",[f.A.id,f.B.id]);f.store.sequences.apply(f.context,s.revision,[{type:"setCaption",clipId:a.id,caption:"Manual"}]);await assert.rejects(service.review(external.id,f.context,"accept"),err("revision_conflict"));assert.equal(service.get(f.context).clips[0].caption,"Manual");});
test("selected-clip AI rejects out-of-scope operations and invalid batches without partial changes",async t=>{const f=fixture(t),a=clip(f.A),b=clip(f.B);f.store.sequences.apply(f.context,0,[{type:"appendClips",clips:[a,b]}]);const service=controlledService(f,{discover:async()=>({available:true,models:["test/model"]}),proposeSequence:async()=>({summary:"Invalid scope",operations:[{type:"setClipGain",clipId:b.id,gainDb:-6}]})});t.after(()=>service.close());let p=await service.propose({context:f.context,expectedRevision:1,model:"test/model",instruction:"Only first",scope:"selected",selectedClipIds:[a.id],allowRemote:true});p=await waitFor(()=>service.proposals(f.context).find(x=>x.id===p.id));assert.equal(p.state,"failed");assert.equal(p.error,"ai_selection_scope");assert.equal(service.get(f.context).revision,1);});
test("quiet model request is cancelled by trash/restore and old MCP capability never revives",async t=>{const f=fixture(t),a=clip(f.A);f.store.sequences.apply(f.context,0,[{type:"appendClips",clips:[a]}]);let aborted=false;const service=controlledService(f,{discover:async()=>({available:true,models:["test/model"]}),proposeSequence:async(_i,signal)=>new Promise((_,reject)=>{signal.addEventListener("abort",()=>{aborted=true;reject(new Error("aborted"));},{once:true});})});t.after(()=>service.close());const mcp=new SequenceMcp(f.store,service),grant=mcp.create({context:f.context,sourceIds:[f.A.id],allowExport:false},"http://127.0.0.1:1234"),auth=`Bearer ${grant.token}`;assert.ok(!mcp.capabilities(auth).tools.includes("sequence_export"));let p=await service.propose({context:f.context,expectedRevision:1,model:"test/model",instruction:"wait",scope:"sequence",selectedClipIds:[],allowRemote:true});await delay(30);const trash=f.store.trashProject(f.project.id,{context:f.context,expectedRevision:1});f.store.restoreProject(f.project.id,{context:f.context,expectedRevision:trash.revision});await delay(1200);assert.equal(aborted,true);assert.equal(service.proposals(f.context).find(x=>x.id===p.id).state,"cancelled");assert.throws(()=>mcp.capabilities(auth),err("mcp_grant_invalid"));});
test("sequence MCP restricts source allowlist and exposes proposals without accept/publish authority",async t=>{const f=fixture(t),a=clip(f.A);f.store.sequences.apply(f.context,0,[{type:"appendClips",clips:[a]}]);const service=controlledService(f);t.after(()=>service.close());const mcp=new SequenceMcp(f.store,service),g=mcp.create({context:f.context,sourceIds:[f.A.id],allowExport:false},"http://127.0.0.1:1234"),auth=`Bearer ${g.token}`;const s=await mcp.call(auth,{tool:"sequence_read",arguments:{}});assert.equal(s.clips.length,1);assert.equal(s.clips[0].timedCaptions,undefined);for(const tool of ["approve","publish","sequence_accept","sequence_export"])await assert.rejects(mcp.call(auth,{tool,arguments:{}}),err("mcp_tool_forbidden"));await assert.rejects(mcp.call(auth,{tool:"sequence_propose",arguments:{expectedRevision:1,summary:"Wrong source",operations:[{type:"appendClips",clips:[clip(f.B)]}]}}),err("mcp_scope_forbidden"));const p=await mcp.call(auth,{tool:"sequence_propose",arguments:{expectedRevision:1,summary:"Quieter",operations:[{type:"setClipGain",clipId:a.id,gainDb:-3}]}});assert.equal(p.state,"ready");assert.equal(service.get(f.context).clips[0].gainDb,0);mcp.revoke(g.token,f.context);assert.throws(()=>mcp.capabilities(auth),err("mcp_grant_invalid"));});

test("render snapshot survives later edits and a cancelled late result cannot register an artifact",async t=>{
  const f=fixture(t),a=clip(f.A),removed=[];f.store.sequences.apply(f.context,0,[{type:"appendClips",clips:[a]}]);
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const studio={engine:{verify:async()=>true,remove:async id=>removed.push(id),renderSequence:async(id,sourcesnapshot)=>{entered();await gate;return{id,filename:"output.mp4",sha256:"c".repeat(64),bytes:40,mimeType:"video/mp4",probe:{width:sourcesnapshot.profile.width,height:sourcesnapshot.profile.height,duration:1,hasAudio:true}};}}};
  const service=new SequenceService(f.store,studio);t.after(()=>service.close());
  const job=service.render(f.context,1,"export");await started;
  f.store.sequences.apply(f.context,1,[{type:"setClipGain",clipId:a.id,gainDb:-12}]);
  assert.equal(job.snapshot.clips[0].gainDb,0);assert.equal(job.sequenceRevision,1);
  const cancel=service.cancel(job.id,f.context,"render");release();await cancel;
  assert.equal(service.jobs(f.context)[0].state,"cancelled");assert.equal(f.store.studio.artifacts(f.context).length,2);assert.equal(removed.length,1);
});

test("sequence proposals redact recognizable credentials in appended static/timed text and summaries",t=>{
  const f=fixture(t),service=controlledService(f),secret=`sk-${"x".repeat(32)}`;t.after(()=>service.close());
  const c={...clip(f.A),caption:secret,timedCaptions:[{start:0,end:.5,text:secret}]};
  const p=service.externalProposal(f.context,0,[{type:"appendClips",clips:[c]}],secret,[f.A.id]);
  assert.ok(!JSON.stringify(p).includes(secret));assert.equal(p.state,"ready");
  assert.equal(service.get(f.context).clips.length,0);
});

test("real HTTP project lifecycle and empty sequence routes are authenticated and revision-controlled",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"atris-seq-api-"));
 const api=await startApi({dataDirectory:dir,vaultStatus:{available:false,backend:"unavailable",reason:"test"}});
 t.after(async()=>{await api.close();await rm(dir,{recursive:true,force:true});});
 const call=async(path,method="GET",body)=>{const r=await fetch(api.origin+path,{method,headers:{Authorization:`Bearer ${api.token}`,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const account=(await call("/api/accounts","POST",{displayName:"Test",platform:"local"})).body;
 const p=(await call("/api/projects","POST",{accountId:account.id,name:"Project",description:""})).body;
 const context={accountId:account.id,projectId:p.id},q=new URLSearchParams(context);
 const s=await call(`/api/sequence?${q}`);assert.equal(s.status,200);assert.equal(s.body.clips.length,0);
 const renamed=await call(`/api/projects/${p.id}`,"PATCH",{context,expectedRevision:p.revision,name:"Renamed",description:"Saved"});assert.equal(renamed.status,200);
 assert.equal((await call(`/api/projects/${p.id}`,"PATCH",{context,expectedRevision:1,name:"Stale",description:""})).status,409);
 const trash=await call(`/api/projects/${p.id}`,"DELETE",{context,expectedRevision:renamed.body.revision});assert.equal(trash.status,200);
 assert.equal((await call(`/api/sequence?${q}`)).status,404);assert.equal((await call(`/api/projects?accountId=${account.id}&state=trashed`)).body.length,1);
 assert.equal((await call(`/api/projects/${p.id}/restore`,"POST",{context,expectedRevision:trash.body.revision})).status,200);
 assert.equal((await call(`/api/sequence?${q}`)).body.id,s.body.id);
 const unauthorized=await fetch(api.origin+`/api/sequence?${q}`);assert.equal(unauthorized.status,401);await unauthorized.arrayBuffer();
});

test("external SDK reaches real sequence routes with source-bound proposals, no approval authority and restart-safe revocation",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"atris-seq-sdk-")),f=fixture(t,join(dir,"atris-share.sqlite")),a=clip(f.A);
 f.store.sequences.apply(f.context,0,[{type:"appendClips",clips:[a]}]);
 const api=await startApi({dataDirectory:dir,vaultStatus:{available:false,backend:"unavailable",reason:"test"}});
 let client; t.after(async()=>{await client?.close();await api.close();await rm(dir,{recursive:true,force:true});});
 const response=await fetch(api.origin+"/api/sequence/grants",{method:"POST",headers:{Authorization:`Bearer ${api.token}`,"Content-Type":"application/json"},body:JSON.stringify({context:f.context,sourceIds:[f.A.id],allowExport:false})});assert.equal(response.status,201);const grant=await response.json();
 const transport=new StdioClientTransport({command:grant.command.command,args:grant.command.args,stderr:"pipe",env:{ATRIS_SHARE_MCP_ORIGIN:api.origin,ATRIS_SHARE_MCP_GRANT:grant.token}});let stderr="";transport.stderr.on("data",b=>stderr+=b);client=new Client({name:"sequence-acceptance",version:"1"});await client.connect(transport);
 const tools=(await client.listTools()).tools.map(t=>t.name);assert.ok(tools.includes("sequence_propose"));assert.ok(!tools.includes("sequence_export"));assert.ok(!tools.includes("approve"));
 const read=await client.callTool({name:"sequence_read",arguments:{}});assert.equal(JSON.parse(read.content[0].text).clips[0].id,a.id);
 const proposal=await client.callTool({name:"sequence_propose",arguments:{expectedRevision:1,summary:"SDK proposal",operations:[{type:"setClipGain",clipId:a.id,gainDb:-8}]}});const p=JSON.parse(proposal.content[0].text);assert.equal(p.state,"ready");assert.equal(f.store.sequences.get(f.context).revision,1);
 const forbidden=await client.callTool({name:"sequence_accept",arguments:{proposalId:p.id}});assert.equal(forbidden.isError,true);
 const revoked=await fetch(api.origin+"/api/sequence/grants/revoke",{method:"POST",headers:{Authorization:`Bearer ${api.token}`,"Content-Type":"application/json"},body:JSON.stringify({context:f.context,token:grant.token})});assert.equal(revoked.status,200);await revoked.arrayBuffer();
 assert.equal((await client.callTool({name:"sequence_read",arguments:{}})).isError,true);assert.equal(stderr,"");
});
