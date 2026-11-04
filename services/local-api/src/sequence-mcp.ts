import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sequenceOperationSchema, type SequenceJob } from "../../../packages/domain/src/sequence.js";
import { idSchema, type WorkspaceContext } from "../../../packages/domain/src/workspace.js";
import { studioContextSchema } from "../../../packages/domain/src/studio.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
import type { SequenceService } from "./sequence.js";
import { projectLifecycleGuard } from "./project-lifecycle.js";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export const sequenceGrantSchema=z.object({context:studioContextSchema,sourceIds:z.array(idSchema).min(1).max(128),allowExport:z.boolean().default(false)}).strict();
type Grant={context:{accountId:string;projectId:string};destinationId:string;sourceIds:string[];allowExport:boolean;expiresAt:number;assertActive:()=>void;proposals:Set<string>;jobs:Set<string>};
export class SequenceMcp {
  private readonly grants=new Map<string,Grant>();
  constructor(private readonly store:WorkspaceStore,private readonly sequence:SequenceService){}
  owns(auth:string){return /^Bearer [a-f0-9]{64}$/.test(auth)&&this.grants.has(hash(auth.slice(7)));}
  create(value:z.infer<typeof sequenceGrantSchema>,origin:string){const i=sequenceGrantSchema.parse(value);this.store.studio.scope(i.context);for(const id of i.sourceIds)this.store.studio.artifact(id,i.context);for(const[key,g]of this.grants)if(g.expiresAt<=Date.now())this.grants.delete(key);if(this.grants.size>=32)throw new WorkspaceError(409,"mcp_grant_limit");
    const token=randomBytes(32).toString("hex"),g:Grant={...i,destinationId:this.store.listAccounts().find(a=>a.id===i.context.accountId)!.destinationId,expiresAt:Date.now()+1800000,assertActive:projectLifecycleGuard(this.store,i.context,"mcp_grant_invalid",401),proposals:new Set(),jobs:new Set()};
    const entry=[new URL("./mcp.mjs",import.meta.url),new URL("../../mcp-server/src/index.js",import.meta.url)].map(url=>fileURLToPath(url)).find(path=>existsSync(path));if(!entry)throw new WorkspaceError(409,"mcp_runtime_unavailable");this.grants.set(hash(token),g);return{origin,token,expiresAt:new Date(g.expiresAt).toISOString(),tools:this.tools(g),command:{command:process.execPath,args:[entry]}};
  }
  revoke(token:string,context:WorkspaceContext){const key=hash(z.string().regex(/^[a-f0-9]{64}$/).parse(token)),g=this.grants.get(key);this.store.studio.scope(context);if(!g||g.context.accountId!==context.accountId||g.context.projectId!==context.projectId)throw new WorkspaceError(404,"mcp_grant_not_found");this.grants.delete(key);return{revoked:true};}
  private tools(g:Grant){return["sequence_sources","sequence_read","sequence_propose","sequence_preview","sequence_render_status","sequence_render_cancel",...(g.allowExport?["sequence_export"]:[])];}
  private grant(auth:string){const key=hash(auth.slice(7)),g=this.grants.get(key);if(!g||g.expiresAt<=Date.now())throw new WorkspaceError(401,"mcp_grant_invalid");try{g.assertActive();}catch(e){this.grants.delete(key);throw e;}if(this.store.listAccounts().find(a=>a.id===g.context.accountId)?.destinationId!==g.destinationId)throw new WorkspaceError(409,"ai_scope_mismatch");return g;}
  private snapshot(g:Grant){const s=this.sequence.get(g.context);if(s.clips.some(c=>!g.sourceIds.includes(c.sourceArtifactId)))throw new WorkspaceError(403,"mcp_scope_forbidden");return s;}
  private jobView(job:SequenceJob){const {snapshot,...metadata}=job;return metadata;}
  capabilities(auth:string){const g=this.grant(auth),account=this.store.listAccounts().find(a=>a.id===g.context.accountId)!;return{tools:this.tools(g),expiresAt:new Date(g.expiresAt).toISOString(),scope:{...g.context,sequenceId:this.sequence.get(g.context).id,sourceIds:g.sourceIds,destinationId:account.destinationId},includeMemory:false,includeTranscript:false};}
  async call(auth:string,value:unknown){const g=this.grant(auth),i=z.object({tool:z.string(),arguments:z.record(z.string(),z.unknown())}).strict().parse(value);if(!this.tools(g).includes(i.tool))throw new WorkspaceError(403,"mcp_tool_forbidden");
    if(i.tool==="sequence_sources"){z.object({}).strict().parse(i.arguments);return g.sourceIds.map(id=>{const a=this.store.studio.artifact(id,g.context);return{id:a.id,filename:a.filename,sha256:a.sha256,probe:a.probe};});}
    if(i.tool==="sequence_read"){z.object({}).strict().parse(i.arguments);const s=this.snapshot(g);return{...s,clips:s.clips.map(({timedCaptions,...c})=>c),timedCaptionsOmitted:true};}
    if(i.tool==="sequence_propose"){const a=z.object({expectedRevision:z.number().int().nonnegative(),summary:z.string().min(1).max(2000),operations:z.array(sequenceOperationSchema).min(1).max(128)}).strict().parse(i.arguments);this.snapshot(g);const p=this.sequence.externalProposal(g.context,a.expectedRevision,a.operations,a.summary,g.sourceIds);g.proposals.add(p.id);return p;}
    if(i.tool==="sequence_preview"){const a=z.object({proposalId:idSchema}).strict().parse(i.arguments);if(!g.proposals.has(a.proposalId))throw new WorkspaceError(403,"mcp_scope_forbidden");const s=this.snapshot(g),j=this.sequence.render(g.context,s.revision,"preview",a.proposalId);g.jobs.add(j.id);return this.jobView(j);}
    if(i.tool==="sequence_export"){const a=z.object({expectedRevision:z.number().int().nonnegative()}).strict().parse(i.arguments);this.snapshot(g);const j=this.sequence.render(g.context,a.expectedRevision,"export");g.jobs.add(j.id);return this.jobView(j);}
    const a=z.object({jobId:idSchema}).strict().parse(i.arguments);if(!g.jobs.has(a.jobId))throw new WorkspaceError(403,"mcp_scope_forbidden");if(i.tool==="sequence_render_cancel"){await this.sequence.cancel(a.jobId,g.context,"render");this.grant(auth);}return this.jobView(this.store.sequences.work<SequenceJob>(a.jobId,g.context,"render"));
  }
  close(){this.grants.clear();}
}
