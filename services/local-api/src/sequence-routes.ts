import { z } from "zod";
import { sequenceActionSchema, sequenceMutationSchema, legacySequenceClips } from "../../../packages/domain/src/sequence.js";
import { randomUUID } from "node:crypto";
import { WorkspaceError } from "../../../packages/storage/src/config.js";
import { studioContextSchema } from "../../../packages/domain/src/studio.js";
import { idSchema } from "../../../packages/domain/src/workspace.js";
import { sequenceProposalRequestSchema, type SequenceService } from "./sequence.js";
import type { WorkspaceStore } from "../../../packages/storage/src/store.js";
export async function sequenceRoute(service: SequenceService, store: WorkspaceStore, method: string, url: URL, body: () => Promise<unknown>) {
  const path = url.pathname, base = "/api/sequence", context = () => studioContextSchema.parse({accountId:url.searchParams.get("accountId"),projectId:url.searchParams.get("projectId")});
  if (method === "GET" && path === base) return {status:200,body:service.get(context())};
  if (method === "GET" && path === `${base}/jobs`) return {status:200,body:service.jobs(context())};
  if (method === "GET" && path === `${base}/proposals`) return {status:200,body:service.proposals(context())};
  if (method === "POST" && path === `${base}/operations`) {const i=sequenceMutationSchema.parse(await body()); return {status:200,body:await service.apply(i.context,i.expectedRevision,i.operations)};}
  if (method === "POST" && path === `${base}/clips`) {
    const i=sequenceActionSchema.extend({analysisId:idSchema,analysisRevision:z.number().int().nonnegative(),candidateIds:z.array(idSchema).min(1).max(8)}).parse(await body());
    const run=store.clips.get(i.analysisId,i.context),s=service.get(i.context),artifact=store.studio.artifact(run.artifactId,i.context);
    if(run.state!=="ready"||run.revision!==i.analysisRevision||artifact.sha256!==run.sourceSha256||store.studio.timeline(artifact.id,i.context).revision!==run.baseRevision)throw new WorkspaceError(409,"revision_conflict");
    const clips=i.candidateIds.flatMap(id=>{const c=run.candidates.find(c=>c.id===id);if(!c)throw new WorkspaceError(400,"clip_not_found");return legacySequenceClips(artifact,c.edit,s.profile.fps,randomUUID);});
    return {status:200,body:await service.apply(i.context,i.expectedRevision,[{type:"appendClips",clips}])};
  }
  if (method === "POST" && [base+"/undo",base+"/redo"].includes(path)) {const i=sequenceActionSchema.parse(await body()); return {status:200,body:store.sequences.history(i.context,i.expectedRevision,path.endsWith("undo")?"undo":"redo")};}
  if (method === "POST" && path === `${base}/legacy`) {const i=sequenceActionSchema.extend({artifactId:idSchema}).parse(await body()); return {status:200,body:await service.legacy(i.context,i.expectedRevision,i.artifactId)};}
  if (method === "POST" && path === `${base}/render`) {const i=sequenceActionSchema.extend({kind:z.enum(["preview","export"]),proposalId:idSchema.optional()}).parse(await body()); return {status:202,body:service.render(i.context,i.expectedRevision,i.kind,i.proposalId)};}
  if (method === "POST" && path === `${base}/proposals`) return {status:202,body:await service.propose(sequenceProposalRequestSchema.parse(await body()))};
  const match=/^\/api\/sequence\/(jobs|proposals)\/([^/]+)\/(accept|reject|cancel|preview)$/.exec(path);
  if (method === "POST" && match) {const id=idSchema.parse(match[2]),i=z.object({context:studioContextSchema}).strict().parse(await body()),action=match[3];
    if(action==="cancel") return {status:200,body:await service.cancel(id,i.context,match[1]==="jobs"?"render":"proposal")};
    if(match[1]!=="proposals") return null;
    if(action==="preview") {const s=service.get(i.context);return {status:202,body:service.render(i.context,s.revision,"preview",id)};}
    return {status:200,body:await service.review(id,i.context,action as "accept"|"reject")};
  }
  return null;
}
