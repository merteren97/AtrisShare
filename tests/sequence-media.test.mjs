import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaEngine } from "../dist/packages/media-engine/src/index.js";
const ffmpeg=process.env.ATRIS_SHARE_FFMPEG??"ffmpeg",ffprobe=process.env.ATRIS_SHARE_FFPROBE??"ffprobe";
async function run(tool,args){return new Promise((resolve,reject)=>{const child=spawn(tool,args,{windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});const out=[],err=[];child.stdout.on("data",b=>out.push(b));child.stderr.on("data",b=>err.push(b));child.once("error",reject);child.once("close",code=>code===0?resolve(Buffer.concat(out)):reject(new Error(Buffer.concat(err).toString())));});}
const base=["-hide_banner","-nostdin","-loglevel","error"];
test("real heterogeneous A→B→A montage normalizes frame/size/audio, keeps timing and source hashes",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"atris-sequence-real-"));t.after(()=>rm(dir,{recursive:true,force:true}));const engine=new MediaEngine(dir,{ffmpegPath:ffmpeg,ffprobePath:ffprobe});if(!(await engine.status()).available){t.skip("FFmpeg/FFprobe not available");return;}
 const a=join(dir,"a.mp4"),b=join(dir,"b.mp4");
 await run(ffmpeg,[...base,"-f","lavfi","-i","color=c=red:s=320x240:r=24:d=4","-itsoffset","0.5","-f","lavfi","-i","sine=frequency=440:sample_rate=44100:duration=3","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac","-y",a]);
 await run(ffmpeg,[...base,"-f","lavfi","-i","color=c=blue:s=426x240:r=60:d=3","-c:v","libx264","-pix_fmt","yuv420p","-y",b]);
 const A=await engine.import(randomUUID(),createReadStream(a),"A.mp4"),B=await engine.import(randomUUID(),createReadStream(b),"B.mp4");const make=(s,i,o)=>({id:randomUUID(),sourceArtifactId:s.id,sourceSha256:s.sha256,inFrame:i,outFrame:o,gapBeforeFrames:0,crop:"original",gainDb:0,caption:""});
 const s={schemaVersion:1,id:randomUUID(),context:{accountId:randomUUID(),projectId:randomUUID()},revision:3,profile:{width:640,height:360,fps:30,sampleRate:48000},clips:[make(A,0,30),make(B,15,45),make(A,60,90)],cursor:1,historyLength:2},id=randomUUID(),progress=[];
 const result=await engine.renderSequence(id,s,[A,B].map(a=>({id:a.id,sha256:a.sha256,probe:a.probe})),p=>progress.push(p),new AbortController().signal);
 assert.ok(Math.abs(result.probe.duration-3)<.08);assert.equal(result.probe.hasAudio,true);assert.equal(result.probe.width,640);assert.equal(result.probe.height,360);assert.equal(progress.at(-1),1);
 const color=async time=>{const pixels=await run(ffmpeg,[...base,"-ss",String(time),"-i",engine.path(id),"-frames:v","1","-vf","crop=100:100:270:130,scale=1:1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);return [...pixels.subarray(0,3)];};
 const red=await color(.7),blue=await color(1.5),redAgain=await color(2.5);assert.ok(red[0]>red[2]+100);assert.ok(blue[2]>blue[0]+100);assert.ok(redAgain[0]>redAgain[2]+100);
 const audio=await run(ffmpeg,[...base,"-i",engine.path(id),"-vn","-ac","1","-ar","48000","-f","s16le","pipe:1"]);const rms=(start,end)=>{let sum=0,n=0;for(let i=Math.round(start*48000)*2;i<Math.round(end*48000)*2&&i+1<audio.length;i+=2){sum+=audio.readInt16LE(i)**2;n++;}return Math.sqrt(sum/n);};assert.ok(rms(.05,.3)<80,"leading silence must preserve audio offset");assert.ok(rms(.65,.9)>500);assert.ok(rms(1.1,1.8)<80,"silent clip must not borrow neighboring audio");assert.ok(rms(2.1,2.8)>500);
 for(const x of[A,B])assert.equal(await engine.verify(x.id,x.sha256),true);assert.equal(createHash("sha256").update(await readFile(engine.path(A.id))).digest("hex"),A.sha256);
 const probe=JSON.parse((await run(ffprobe,["-v","error","-show_entries","stream=r_frame_rate,sample_rate,channels,sample_aspect_ratio","-of","json",engine.path(id)])).toString());assert.equal(probe.streams[0].r_frame_rate,"30/1");assert.equal(probe.streams[0].sample_aspect_ratio,"1:1");assert.equal(probe.streams[1].sample_rate,"48000");assert.equal(probe.streams[1].channels,2);
 const gap=structuredClone(s);gap.clips[1].gapBeforeFrames=15;gap.clips[2].gainDb=-12;const g=await engine.renderSequence(randomUUID(),gap,[A,B].map(a=>({id:a.id,sha256:a.sha256,probe:a.probe})),()=>{},new AbortController().signal);assert.ok(Math.abs(g.probe.duration-3.5)<.08);
 const c=join(dir,"c.mp4"),rotated=join(dir,"rotated.mp4");
 await run(ffmpeg,[...base,"-f","lavfi","-i","color=c=green:s=240x320:r=30:d=2","-vf","select='not(mod(n,3))',setsar=2","-fps_mode","vfr","-c:v","libx264","-pix_fmt","yuv420p","-y",c]);
 await run(ffmpeg,[...base,"-i",c,"-c","copy","-metadata:s:v:0","rotate=90","-y",rotated]);
 const C=await engine.import(randomUUID(),createReadStream(rotated),"rotated-vfr.mp4");
 const mixed={...s,clips:[make(A,0,15),make(B,0,15),{...make(C,0,30),crop:"vertical",caption:"Literal %{pts}",timedCaptions:[{start:.1,end:.5,text:"VFR"}]},make(A,60,90)]};
 const m=await engine.renderSequence(randomUUID(),mixed,[A,B,C],()=>{},new AbortController().signal);assert.ok(Math.abs(m.probe.duration-3)<.08);assert.equal(m.probe.width,640);assert.equal(m.probe.height,360);assert.equal(await engine.verify(C.id,C.sha256),true);
 const abort=new AbortController();abort.abort();await assert.rejects(engine.renderSequence(randomUUID(),s,[A,B],()=>{},abort.signal),/abort/i);assert.ok((await readdir(join(dir,"media"))).every(n=>/^[a-f0-9-]+\.mp4$/.test(n)),"no partial workspaces remain");
});
