import { z } from "zod";
import { idSchema } from "../../../packages/domain/src/workspace.js";
import { socialAccountActionSchema, socialConfigSchema, socialDraftSchema, socialPostActionSchema, socialStartSchema, socialTargetSchema,
  socialTextRequestSchema, socialTextCancelSchema } from "../../../packages/domain/src/social.js";
import type { SocialService } from "./social.js";
import type { SocialTextService } from "./social-text.js";
import { WorkspaceError } from "../../../packages/storage/src/config.js";

export interface SocialRouteResult { status: number; body: unknown }
export interface SocialRouteOptions { text?: SocialTextService; signal?: AbortSignal }
/** Mount ONLY after the existing runtime bearer/Host/Origin checks. No OAuth callback passes through server.ts. */
export async function socialRoute(service: SocialService, method: string, url: URL, body: () => Promise<unknown>, options: SocialRouteOptions = {}): Promise<SocialRouteResult | null> {
  const result = (value: unknown, status = 200) => ({ status, body: value });
  const path = url.pathname;
  if (method === "POST" && path === "/api/social/x/text-metrics") {
    const input = z.object({ text: z.string().max(10000) }).strict().parse(await body()); return result(service.textMetrics(input.text));
  }
  if (path.startsWith("/api/social/ai/")) {
    if (!options.text) throw new WorkspaceError(409, "social_ai_unavailable");
    if (method === "GET" && path === "/api/social/ai/setup") return result(await options.text.setup(options.signal, url.searchParams.get("refresh") === "1"));
    if (method === "POST" && path === "/api/social/ai/suggest") return result(await options.text.suggest(socialTextRequestSchema.parse(await body()), options.signal));
    if (method === "POST" && path === "/api/social/ai/cancel") return result(await options.text.cancel(socialTextCancelSchema.parse(await body())));
    return null;
  }
  if (method === "GET" && path === "/api/social") return result({ setup: await service.setup(), accounts: service.accounts() });
  if (method === "POST" && path === "/api/social/config") return result(await service.configure(socialConfigSchema.parse(await body())));
  if (method === "POST" && path === "/api/social/sessions") return result(await service.start(socialStartSchema.parse(await body())), 201);
  const session = /^\/api\/social\/sessions\/([^/]+)(?:\/(open|cancel|select))?$/.exec(path);
  if (session) {
    const id = idSchema.parse(session[1]);
    if (method === "GET" && !session[2]) return result(service.status(id));
    if (method === "POST" && session[2] === "open") return result(await service.reopen(id));
    if (method === "POST" && session[2] === "cancel") return result(await service.cancelSession(id));
    if (method === "POST" && session[2] === "select") return result(await service.selectDestination(id, z.object({ destinationId: socialTargetSchema.shape.destinationId }).strict().parse(await body()).destinationId));
  }
  if (method === "POST" && path === "/api/social/verify") return result(await service.verify(socialAccountActionSchema.parse(await body())));
  if (method === "POST" && path === "/api/social/disconnect") {
    const v = socialAccountActionSchema.extend({ revoke: z.boolean() }).strict().parse(await body()); return result(await service.disconnect(v, v.revoke));
  }
  if (method === "GET" && path === "/api/social/posts") {
    const target = socialTargetSchema.parse(Object.fromEntries(["accountId", "projectId", "destinationId"].map(k => [k, url.searchParams.get(k)])));
    return result(service.posts(target));
  }
  if (method === "POST" && path === "/api/social/posts") return result(await service.create(socialDraftSchema.parse(await body())), 201);
  const post = /^\/api\/social\/posts\/([^/]+)\/(approve|reconcile|stop)$/.exec(path);
  if (method === "POST" && post) {
    const id = idSchema.parse(post[1]);
    if (post[2] === "approve") { const v = socialPostActionSchema.parse(await body()); return result(service.approve(id, v.target, v.digest, v.tiktokConsent), 202); }
    const v = z.object({ target: socialTargetSchema }).strict().parse(await body());
    return result(post[2] === "reconcile" ? service.reconcile(id, v.target) : service.stop(id, v.target), post[2] === "reconcile" ? 202 : 200);
  }
  return null;
}
