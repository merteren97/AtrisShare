import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { SocialStore, SOCIAL_MIGRATION_SQL, socialDigest } from "../dist/packages/storage/src/social-store.js";
import { SocialService } from "../dist/services/local-api/src/social.js";
import { SocialProvider, SocialRemoteError, parseSocialJson, socialUploadUrl } from "../dist/services/local-api/src/social-provider.js";
import { SocialPublishing, tikTokChunkPlan, linkedinPlainText } from "../dist/services/local-api/src/social-publishing.js";
import { socialDraftSchema, socialScopes } from "../dist/packages/domain/src/social.js";
import { socialRoute } from "../dist/services/local-api/src/social-routes.js";
import { isSocialAuthorizationUrl, openSocialAuthorizationBrowser } from "../dist/services/local-api/src/social-browser.js";

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const cleanups = new WeakMap();
async function until(predicate) { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error("Barrier not reached"); await new Promise(r => setTimeout(r, 5)); } }
async function fixture(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "social-test-"));
  const workspace = new WorkspaceStore(join(directory, "workspace.sqlite")), db = new DatabaseSync(join(directory, "workspace.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='social_connections'").get()) db.exec(SOCIAL_MIGRATION_SQL);
  let clock = Date.now(); const secrets = options.secrets ?? new Map(), calls = [], urls = [];
  const control = { subject: "123456", liSubject: "member-1", ttSubject: "tt-open-id", destination: "urn:li:person:member-1", acl: true, failCreate: false,
    missingReceipt: false, processing: false, tokenGate: null, onCall: null, scopes: null, creator: { creator_nickname: "Synthetic Creator", creator_username: "synthetic",
      privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"], comment_disabled: false, duet_disabled: true, stitch_disabled: true, max_video_post_duration_sec: 300 }, ...options.control };
  const bytes = Buffer.alloc(128000, 7); const mediaPath = join(directory, "fixture.mp4"); await writeFile(mediaPath, bytes);
  const transport = async (url, init) => {
    const u = new URL(url); calls.push({ url, init }); assert.equal(u.protocol, "https:"); assert.equal(init.redirect, "error");
    assert.ok(!u.searchParams.has("access_token"));
    if (control.onCall) await control.onCall(u, init);
    if (u.pathname.endsWith("/token") || u.pathname === "/oauth/v2/accessToken" || u.pathname === "/v2/oauth/token/") {
      if (control.tokenGate) await control.tokenGate.promise;
      const provider = u.hostname === "api.x.com" ? "x" : u.hostname === "www.linkedin.com" ? "linkedin" : "tiktok";
      const scopes = provider === "x" ? ["tweet.read", "users.read", "tweet.write", "media.write", "offline.access"] : provider === "linkedin" ? ["openid", "profile", "w_member_social", "r_organization_admin", "w_organization_social", "r_organization_social"] : ["user.info.basic", "video.publish"];
      return json({ access_token: "synthetic-access-token", ...(provider !== "linkedin" ? { refresh_token: "synthetic-refresh-token" } : {}),
        expires_in: 3600, scope: control.scopes ?? scopes.join(provider === "tiktok" ? "," : " "), ...(provider === "tiktok" ? { open_id: control.ttSubject, refresh_expires_in: 31536000 } : {}) });
    }
    if (u.pathname === "/2/users/me") return json({ data: { id: control.subject, name: "Synthetic X", username: "synthetic" } });
    if (u.pathname === "/v2/userinfo") return json({ sub: control.liSubject, name: "Synthetic LinkedIn" });
    if (u.pathname === "/rest/organizationAcls") return json({ elements: control.acl ? [{ roleAssignee: `urn:li:person:${control.liSubject}`, organization: "urn:li:organization:7788", state: "APPROVED", role: "ADMINISTRATOR" }] : [], paging: { links: [] } });
    if (u.pathname === "/v2/user/info/") return json({ data: { user: { open_id: control.ttSubject, display_name: "Synthetic TikTok" } }, error: { code: "ok" } });
    if (u.pathname === "/v2/post/publish/creator_info/query/") return json({ data: control.creator, error: { code: "ok" } });
    if (u.pathname === "/2/media/upload/initialize") return json({ data: { id: "778899" } });
    if (u.pathname.endsWith("/append")) return new Response(null, { status: 204 });
    if (u.pathname.endsWith("/finalize")) return json({ data: { processing_info: { state: control.processing ? "pending" : "succeeded", check_after_secs: 1 } } });
    if (u.pathname === "/2/media/upload") return json({ data: { processing_info: { state: control.processing ? "pending" : "succeeded", check_after_secs: 1 } } });
    if (u.pathname === "/2/tweets" && init.method === "POST") {
      if (control.failCreate) throw new Error("synthetic-sensitive-network-error");
      if (control.missingReceipt) return json({ data: {} }, 201);
      return json({ data: { id: "990011", text: "created" } }, 201);
    }
    if (u.pathname === "/2/tweets/990011") return json({ data: { id: "990011", author_id: control.subject } });
    if (u.pathname === "/rest/videos" && u.searchParams.get("action") === "initializeUpload") return json({ value: { video: "urn:li:video:synthetic", uploadToken: "synthetic-upload-secret", uploadUrlsExpireAt: clock + 86400000,
      uploadInstructions: [{ firstByte: 0, lastByte: bytes.length - 1, uploadUrl: "https://www.linkedin.com/dms-uploads/synthetic/uploadedVideo?token=synthetic-signed-secret" }] } });
    if (u.pathname.startsWith("/dms-uploads/")) { assert.equal(init.headers.Authorization, undefined); return new Response(null, { status: 200, headers: { ETag: "synthetic-part-tag" } }); }
    if (u.pathname === "/rest/videos" && u.searchParams.get("action") === "finalizeUpload") return new Response(null, { status: 200 });
    if (u.pathname.startsWith("/rest/videos/")) return json({ id: "urn:li:video:synthetic", owner: control.destination, status: control.processing ? "PROCESSING" : "AVAILABLE" });
    if (u.pathname === "/rest/posts" && init.method === "POST") {
      if (control.failCreate) throw new Error("synthetic-sensitive-create-error");
      return new Response(null, { status: 201, headers: control.missingReceipt ? {} : { "x-restli-id": "urn:li:share:554433" } });
    }
    if (u.pathname.startsWith("/rest/posts/")) return json({ id: "urn:li:share:554433", author: control.destination, lifecycleState: "PUBLISHED" });
    if (u.pathname === "/v2/post/publish/video/init/") return json({ data: { publish_id: "synthetic-job-id", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=synthetic&upload_token=synthetic-upload-secret" }, error: { code: "ok" } });
    if (u.hostname === "open-upload.tiktokapis.com") { assert.equal(init.headers.Authorization, undefined); return new Response(null, { status: 201 }); }
    if (u.pathname === "/v2/post/publish/status/fetch/") return new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[9223372036854775000]},"error":{"code":"ok"}}');
    if (u.pathname.endsWith("/revoke") || u.pathname.endsWith("/revoke/")) return new Response(null, { status: 200 });
    throw new Error(`Unexpected synthetic endpoint ${u.pathname}`);
  };
  const vault = { status: { available: true, provider: "windows-dpapi" },
    async get(ref) { return secrets.get(ref) ?? null; }, async set(ref, value) { secrets.set(ref, value); if (options.vaultGate) await options.vaultGate.promise; }, async delete(ref) { secrets.delete(ref); } };
  const store = new SocialStore(db, scope => workspace.resolveContext(scope), (scope, action, id) => db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,'local-user',?)").run(randomUUID(), scope.accountId, scope.projectId, action, id, new Date(clock).toISOString()),
    (id, scope) => workspace.studio.artifact(id, scope), () => clock);
  const provider = new SocialProvider(transport, () => clock), publisher = new SocialPublishing(provider, async () => {});
  const service = new SocialService(store, vault, { provider, publisher, mediaPath: () => mediaPath, now: () => clock, openBrowser: async url => { urls.push(new URL(url)); return true; } });
  if (!cleanups.has(t)) { cleanups.set(t, []); t.after(async () => { for (const close of cleanups.get(t).reverse()) await close(); }); }
  cleanups.get(t).push(async () => { await service.close(); db.close(); workspace.close(); if (!options.directory) await rm(directory, { recursive: true, force: true }); });
  async function configure(provider, extra = {}) { return service.configure({ provider, clientId: "synthetic-client", callbackPort: provider === "x" ? await freePort() : 0,
    nativePkceEnabled: true, loopbackApproved: true, publicApp: true, audited: true, organizationAccess: false, ...(provider === "tiktok" ? { clientSecret: "synthetic-client-secret" } : {}), ...extra }); }
  async function callback(parameters = {}) { const auth = urls.at(-1); return fetch(`${auth.searchParams.get("redirect_uri")}?${new URLSearchParams({ state: auth.searchParams.get("state"), code: "synthetic-code", ...parameters })}`, { redirect: "manual" }); }
  async function connected(provider = "x", destination) {
    if (!store.config(provider)) await configure(provider);
    const s = await service.start({ provider }); assert.equal((await callback()).status, 303);
    const pending = service.status(s.id); assert.equal(pending.state, "select-destination", pending.error);
    const selected = await service.selectDestination(s.id, destination ?? pending.destinations[0].id); assert.equal(selected.state, "connected", selected.error);
    return store.accounts().find(a => a.accountId === selected.accountId);
  }
  function target(account) { const p = workspace.createProject({ accountId: account.accountId, name: "Test project", description: "" }); return { accountId: account.accountId, projectId: p.id, destinationId: account.destinationId }; }
  function media(target) { const artifact = { id: randomUUID(), accountId: target.accountId, projectId: target.projectId, filename: "test.mp4", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mimeType: "video/mp4", probe: { duration: 5, width: 720, height: 1280, hasAudio: true }, sourceId: null, channelVideoId: null, kind: "export", createdAt: new Date(clock).toISOString() }; workspace.studio.addArtifact(artifact); return { context: { accountId: target.accountId, projectId: target.projectId }, artifactId: artifact.id }; }
  return { service, store, workspace, db, vault, secrets, directory, calls, urls, control, configure, callback, connected, target, media, bytes, mediaPath,
    advance(ms) { clock += ms; }, config(provider) { return JSON.parse(secrets.get(store.config(provider).ref)); } };
}
async function freePort() { const { createServer } = await import("node:net"); const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const xMetadata = text => ({ provider: "x", text, paidPartnership: false, madeWithAi: false });
const liMetadata = text => ({ provider: "linkedin", text, title: "Video", visibility: "PUBLIC", reshareDisabled: false });
const ttMetadata = (extra = {}) => ({ provider: "tiktok", text: "Caption", privacy: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: false, disclosure: false, ownBrand: false, brandedContent: false, madeWithAi: false, musicConsent: true, brandedConsent: false, ...extra });

test("provider setup gates and vault-only configuration are explicit", async t => {
  const f = await fixture(t); assert.ok((await f.service.setup()).every(s => !s.available));
  await f.configure("linkedin", { nativePkceEnabled: false });
  assert.equal((await f.service.setup()).find(s => s.provider === "linkedin").reason, "social_linkedin_native_not_enabled");
  await assert.rejects(f.service.start({ provider: "linkedin" }), /social_linkedin_native_not_enabled/);
  await f.configure("x", { loopbackApproved: false }); await assert.rejects(f.service.start({ provider: "x" }), /social_x_redirect_not_approved/);
  const rows = JSON.stringify(f.db.prepare("SELECT * FROM social_configs").all()); assert.ok(!rows.includes("synthetic-client"));
  assert.ok(!JSON.stringify(await f.service.setup()).includes("synthetic-client"));
});

for (const provider of ["x", "linkedin", "tiktok"]) test(`${provider} real loopback OAuth, provider PKCE encoding, explicit destination and scoped identity`, async t => {
  const f = await fixture(t); await f.configure(provider); const s = await f.service.start({ provider });
  const auth = f.urls.at(-1); assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(isSocialAuthorizationUrl(auth.href), true, "system-browser allowlist must accept the actual service URL");
  assert.match(auth.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/social\//);
  assert.equal((await f.callback()).status, 303); assert.equal(f.service.status(s.id).state, "select-destination");
  const tokenCall = f.calls.find(c => new URL(c.url).pathname.endsWith("token") || c.url.includes("accessToken") || c.url.endsWith("token/"));
  const body = new URLSearchParams(tokenCall.init.body), verifier = body.get("code_verifier");
  assert.equal(createHash("sha256").update(verifier).digest(provider === "tiktok" ? "hex" : "base64url"), auth.searchParams.get("code_challenge"));
  assert.equal(body.get("client_secret"), provider === "tiktok" ? "synthetic-client-secret" : null);
  assert.equal(f.store.accounts().length, 0, "OAuth callback alone must not choose an account");
  assert.equal((await fetch(new URL("/result", auth.searchParams.get("redirect_uri")))).headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  const dest = f.service.status(s.id).destinations[0].id; const done = await f.service.selectDestination(s.id, dest);
  assert.equal(done.state, "connected"); const a = f.service.accounts()[0]; assert.equal(a.destinationId, dest);
  assert.ok(!JSON.stringify(a).includes("credentialRef")); assert.ok(!JSON.stringify(done).includes("synthetic-access"));
  const cap = await f.service.verify(a); assert.equal(cap.provider, provider); assert.equal(cap.text, provider !== "tiktok");
  const persisted = JSON.stringify(f.db.prepare("SELECT * FROM social_connections").all());
  for (const secret of ["synthetic-access-token", "synthetic-refresh-token", "synthetic-client-secret", "synthetic-code"]) assert.ok(!persisted.includes(secret));
});

test("OAuth rejects state replay/duplicates, hostile Origin and destination substitution", async t => {
  const f = await fixture(t); await f.configure("x"); const s = await f.service.start({ provider: "x" });
  assert.equal((await f.callback({ state: "wrong" })).status, 400); assert.equal(f.calls.length, 0);
  const auth = f.urls.at(-1), uri = auth.searchParams.get("redirect_uri"), state = auth.searchParams.get("state");
  assert.equal((await fetch(`${uri}?state=${state}&state=${state}&code=code`)).status, 400);
  assert.equal((await fetch(`${uri}?state=${state}&code=code`, { headers: { Origin: "https://hostile.example" } })).status, 400);
  assert.equal((await f.callback()).status, 303); assert.equal((await f.callback()).status, 400);
  await assert.rejects(f.service.selectDestination(s.id, "forged-destination"), /social_destination_mismatch/);
  assert.equal((await f.service.selectDestination(s.id, "123456")).state, "connected");
});

test("cancelled OAuth exchange cannot persist an account or overwrite cancellation", async t => {
  const f = await fixture(t); await f.configure("x"); const s = await f.service.start({ provider: "x" });
  const gate = deferred(); f.control.tokenGate = gate; const callback = f.callback(); await until(() => f.calls.length > 0);
  await f.service.cancelSession(s.id); gate.resolve(); await callback;
  assert.equal(f.service.status(s.id).state, "cancelled"); assert.equal(f.store.accounts().length, 0); assert.equal(f.secrets.size, 1);
});

test("expired sessions and missing scopes fail closed", async t => {
  const f = await fixture(t); await f.configure("x"); let s = await f.service.start({ provider: "x" }); f.advance(600001);
  assert.equal(f.service.status(s.id).state, "expired");
  f.control.scopes = "users.read"; s = await f.service.start({ provider: "x" }); await f.callback();
  assert.equal(f.service.status(s.id).error, "social_missing_scope"); assert.equal(f.store.accounts().length, 0);
});

test("LinkedIn organization discovery and fresh roles prevent unauthorized post creation", async t => {
  const f = await fixture(t); await f.configure("linkedin", { organizationAccess: true });
  const a = await f.connected("linkedin", "urn:li:organization:7788"); f.control.destination = a.destinationId;
  const target = f.target(a), draft = await f.service.create({ target, metadata: liMetadata("Company post"), media: null });
  f.control.acl = false; f.service.approve(draft.id, target, draft.digest); const result = await f.service.wait(draft.id, target);
  assert.equal(result.state, "failed"); assert.equal(result.error, "social_destination_permission_lost");
  assert.equal(f.calls.filter(c => new URL(c.url).pathname === "/rest/posts").length, 0);
  assert.equal(f.service.accounts()[0].status, "reauth-required");
});

test("X immutable text approval is scope-bound, one-shot, and receipt-backed", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), draft = await f.service.create({ target, metadata: xMetadata("Approved text"), media: null });
  assert.equal(draft.digest, socialDigest(draft.payload));
  assert.throws(() => f.service.approve(draft.id, { ...target, projectId: randomUUID() }, draft.digest), /context_not_found/);
  assert.throws(() => f.service.approve(draft.id, target, "f".repeat(64)), /social_approval_stale/);
  f.service.approve(draft.id, target, draft.digest); assert.throws(() => f.service.approve(draft.id, target, draft.digest), /social_post_busy|social_approval_stale/);
  const result = await f.service.wait(draft.id, target); assert.equal(result.state, "succeeded"); assert.deepEqual(result.receipt.postIds, ["990011"]);
  const create = f.calls.find(c => new URL(c.url).pathname === "/2/tweets" && c.init.method === "POST"); assert.equal(JSON.parse(create.init.body).text, "Approved text");
  assert.throws(() => f.service.approve(draft.id, target, draft.digest), /social_approval_stale/);
});

for (const missing of [false, true]) test(`ambiguous X create (${missing ? "malformed receipt" : "transport loss"}) remains uncertain and reconciliation never reposts`, async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), draft = await f.service.create({ target, metadata: xMetadata("Once"), media: null });
  f.control.failCreate = !missing; f.control.missingReceipt = missing; f.service.approve(draft.id, target, draft.digest);
  assert.equal((await f.service.wait(draft.id, target)).state, "uncertain");
  const count = f.calls.filter(c => new URL(c.url).pathname === "/2/tweets").length;
  f.service.reconcile(draft.id, target); const result = await f.service.wait(draft.id, target);
  assert.equal(result.state, "uncertain"); assert.equal(result.error, "social_receipt_missing");
  assert.equal(f.calls.filter(c => new URL(c.url).pathname === "/2/tweets").length, count);
});

test("media snapshot hashes are checked before any provider mutation", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), media = f.media(target);
  const draft = await f.service.create({ target, metadata: xMetadata("Video"), media }); await writeFile(f.mediaPath, Buffer.alloc(f.bytes.length, 99));
  f.service.approve(draft.id, target, draft.digest); const result = await f.service.wait(draft.id, target);
  assert.equal(result.error, "social_media_changed"); assert.equal(f.calls.filter(c => new URL(c.url).pathname.includes("media/upload")).length, 0);
});

test("X video uses dedicated v2 upload paths and fresh identity before every write", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), media = f.media(target);
  const draft = await f.service.create({ target, metadata: xMetadata("Video"), media }); f.service.approve(draft.id, target, draft.digest);
  const result = await f.service.wait(draft.id, target); assert.equal(result.state, "succeeded");
  const paths = f.calls.map(c => new URL(c.url).pathname); assert.ok(paths.includes("/2/media/upload/initialize")); assert.ok(paths.includes("/2/media/upload/778899/append")); assert.ok(paths.includes("/2/media/upload/778899/finalize"));
  for (let i = 0; i < f.calls.length; i++) if (f.calls[i].init.method === "POST" && /\/2\/(media|tweets)/.test(paths[i])) assert.equal(paths[i - 1], "/2/users/me");
});

test("per-write approval TTL prevents finalize/create after an upload await", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), media = f.media(target);
  const draft = await f.service.create({ target, metadata: xMetadata("Video"), media });
  let active;
  f.control.onCall = async u => { if (u.pathname.endsWith("/append")) {
    const owner = f.db.prepare("SELECT owner FROM social_posts WHERE id=?").get(draft.id).owner;
    for (let i = 0; i < 11; i++) { f.advance(60000); f.store.checkpoint(active, owner); }
  } };
  active = f.service.approve(draft.id, target, draft.digest); const result = await f.service.wait(draft.id, target);
  assert.equal(result.error, "social_approval_expired"); assert.equal(f.calls.filter(c => new URL(c.url).pathname.endsWith("/finalize")).length, 0);
});

test("dispatch stop during identity await prevents the next write", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), draft = await f.service.create({ target, metadata: xMetadata("Stopped"), media: null });
  const gate = deferred(); let reached = false;
  f.control.onCall = async u => { if (u.pathname === "/2/users/me") { reached = true; await gate.promise; } };
  f.service.approve(draft.id, target, draft.digest); await until(() => reached); f.service.stop(draft.id, target); gate.resolve();
  const result = await f.service.wait(draft.id, target); assert.equal(result.dispatchRevoked, true); assert.equal(f.calls.filter(c => new URL(c.url).pathname === "/2/tweets").length, 0);
});

test("LinkedIn video uploads signed ranges without a bearer and consumes x-restli-id", async t => {
  const f = await fixture(t), a = await f.connected("linkedin"), target = f.target(a), media = f.media(target);
  const draft = await f.service.create({ target, metadata: liMetadata("Hello *literal*"), media }); f.service.approve(draft.id, target, draft.digest);
  const result = await f.service.wait(draft.id, target); assert.equal(result.state, "accepted"); assert.deepEqual(result.receipt.postIds, ["urn:li:share:554433"]);
  const create = f.calls.find(c => new URL(c.url).pathname === "/rest/posts"); assert.equal(JSON.parse(create.init.body).commentary, "Hello \\*literal\\*");
  assert.equal(create.init.headers["LinkedIn-Version"], "202610"); assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM social_posts").all()).includes("synthetic-upload-secret"));
  f.service.reconcile(draft.id, target); const read = await f.service.wait(draft.id, target); assert.equal(read.error, "social_readback_unavailable");
});

test("TikTok fresh creator metadata, explicit disclosures and lossless status IDs", async t => {
  const f = await fixture(t), a = await f.connected("tiktok"), target = f.target(a), media = f.media(target);
  await assert.rejects(f.service.create({ target, metadata: ttMetadata({ allowDuet: true }), media }), /social_privacy_changed/);
  assert.equal(socialDraftSchema.safeParse({ target, metadata: ttMetadata({ musicConsent: false }), media }).success, false);
  assert.equal(socialDraftSchema.safeParse({ target, metadata: ttMetadata({ disclosure: true }), media }).success, false);
  assert.equal(socialDraftSchema.safeParse({ target, metadata: ttMetadata({ disclosure: true, brandedContent: true, brandedConsent: true }), media }).success, false);
  const draft = await f.service.create({ target, metadata: ttMetadata({ disclosure: true, ownBrand: true }), media });
  assert.throws(() => f.service.approve(draft.id, target, draft.digest), /social_tiktok_consent_required/);
  f.service.approve(draft.id, target, draft.digest, true); const result = await f.service.wait(draft.id, target);
  assert.equal(result.state, "succeeded"); assert.deepEqual(result.receipt.postIds, ["9223372036854775000"]);
  const init = f.calls.find(c => new URL(c.url).pathname === "/v2/post/publish/video/init/");
  assert.equal(JSON.parse(init.init.body).post_info.brand_organic_toggle, true); assert.equal(JSON.parse(init.init.body).post_info.disable_duet, true);
});

test("TikTok private/internal app and unaudited public accounts cannot publish", async t => {
  const f = await fixture(t); await f.configure("tiktok", { publicApp: false }); const a = await f.connected("tiktok"), target = f.target(a), media = f.media(target);
  assert.equal((await f.service.verify(a)).video, false); await assert.rejects(f.service.create({ target, metadata: ttMetadata(), media }), /social_tiktok_public_app_required/);
  await f.service.disconnect(a, false); await f.configure("tiktok", { publicApp: true, audited: false });
  const s = await f.service.start({ provider: "tiktok", accountId: a.accountId, expectedDestinationId: a.destinationId }); await f.callback(); await f.service.selectDestination(s.id, a.destinationId);
  f.control.creator.privacy_level_options = ["PUBLIC_TO_EVERYONE", "SELF_ONLY"];
  assert.equal((await f.service.verify(a)).reasons[0], "social_tiktok_private_account_required");
});

test("TikTok HTTP-200 failure envelopes and rate-limit diagnostics are sanitized", async () => {
  const provider = new SocialProvider(async () => json({ error: { code: "spam_risk_too_many_posts", message: "synthetic-sensitive" } }));
  await assert.rejects(provider.creator("token", new AbortController().signal), e => e.code === "social_daily_cap" && !e.message.includes("synthetic"));
  const limited = new SocialProvider(async () => json({ detail: "secret" }, 429, { "x-rate-limit-reset": "2000000000" }));
  await assert.rejects(limited.api("x", "/2/users/me", "token", "GET", undefined, new AbortController().signal), e => e.code === "social_rate_limited" && e.retryAt === 2000000000000);
});

test("bounded responses reject oversize streams and redirects without reflecting provider data", async () => {
  for (const response of [new Response("x".repeat(1024 * 1024 + 1)), new Response(null, { status: 302, headers: { Location: "https://hostile.example" } })]) {
    const provider = new SocialProvider(async () => response);
    await assert.rejects(provider.api("x", "/2/tweets", "token", "POST", {}, new AbortController().signal, true), e => e instanceof SocialRemoteError && e.uncertain && !e.message.includes("hostile"));
  }
});

test("signed upload URL validation rejects SSRF and credential forwarding paths", () => {
  for (const url of ["http://127.0.0.1/file", "https://www.linkedin.com.evil/dms-uploads/x", "https://user:pass@www.linkedin.com/dms-uploads/x", "https://www.linkedin.com:444/dms-uploads/x", "https://www.linkedin.com/dms-uploads/x#fragment", "https://open-upload.tiktokapis.com.evil/video/"]) assert.throws(() => socialUploadUrl("linkedin", url), /social_invalid_upload_url/);
  assert.equal(socialUploadUrl("tiktok", "https://upload.us.tiktokapis.com/video/?upload_token=opaque"), "https://upload.us.tiktokapis.com/video/?upload_token=opaque");
});

test("grant fencing in another store preempts per-write dispatch and preserves independent targets", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), draft = await f.service.create({ target, metadata: xMetadata("Bound"), media: null });
  const g = await fixture(t, { directory: f.directory, secrets: f.secrets });
  const gate = deferred(); let reached = false; f.control.onCall = async u => { if (u.pathname === "/2/users/me") { reached = true; await gate.promise; } };
  f.service.approve(draft.id, target, draft.digest); await until(() => reached); await g.service.disconnect(a, false); gate.resolve();
  const result = await f.service.wait(draft.id, target); assert.equal(result.state, "failed"); assert.equal(f.calls.filter(c => new URL(c.url).pathname === "/2/tweets").length, 0);
  assert.equal(f.store.accounts()[0].status, "disconnected");
});

test("refresh rotation uses CAS and persisted credentials survive restart without OAuth sessions", async t => {
  const f = await fixture(t), a = await f.connected(); const old = f.store.connection(a).credentialRef; f.advance(3600000);
  await f.service.verify(a); const current = f.store.connection(a); assert.notEqual(current.credentialRef, old); assert.equal(f.secrets.has(old), false); assert.equal(current.revision, a.revision);
  const g = await fixture(t, { directory: f.directory, secrets: f.secrets }); assert.equal(g.service.accounts()[0].accountId, a.accountId); await g.service.verify(a);
  assert.throws(() => g.service.status(randomUUID()), /social_session_not_found/);
});

test("crosspost has separate immutable approvals and independent failure receipts", async t => {
  const f = await fixture(t), x = await f.connected(), li = await f.connected("linkedin"), xt = f.target(x), lt = f.target(li);
  const xp = await f.service.create({ target: xt, metadata: xMetadata("X variant"), media: null }), lp = await f.service.create({ target: lt, metadata: liMetadata("LinkedIn variant"), media: null });
  assert.notEqual(xp.digest, lp.digest); f.control.onCall = async u => { if (u.pathname === "/2/tweets") throw new Error("lost response"); };
  f.service.approve(xp.id, xt, xp.digest); f.service.approve(lp.id, lt, lp.digest);
  const [xr, lr] = await Promise.all([f.service.wait(xp.id, xt), f.service.wait(lp.id, lt)]); assert.equal(xr.state, "uncertain"); assert.equal(lr.state, "accepted");
});

test("route adapter accepts strict context and never exposes configuration/credential records", async t => {
  const f = await fixture(t); await f.configure("x");
  const base = "http://127.0.0.1:1";
  const result = await socialRoute(f.service, "GET", new URL("/api/social", base), async () => ({})); assert.equal(result.status, 200); assert.ok(!JSON.stringify(result).includes("synthetic-client"));
  await assert.rejects(socialRoute(f.service, "POST", new URL("/api/social/verify", base), async () => ({ accountId: randomUUID(), destinationId: "123", accessToken: "forged" })));
  assert.equal(await socialRoute(f.service, "GET", new URL("/api/social/credentials", base), async () => ({})), null);
});

test("media processing pause requires renewed approval and never repeats upload initialization", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), media = f.media(target);
  const draft = await f.service.create({ target, metadata: xMetadata("Wait for media"), media }); f.control.processing = true;
  f.service.approve(draft.id, target, draft.digest); assert.equal((await f.service.wait(draft.id, target)).state, "processing");
  f.control.processing = false; f.service.reconcile(draft.id, target); const ready = await f.service.wait(draft.id, target);
  assert.equal(ready.receipt.providerState, "MEDIA_READY"); assert.equal(ready.state, "accepted");
  assert.equal(f.calls.filter(c => new URL(c.url).pathname === "/2/tweets").length, 0);
  f.service.approve(draft.id, target, draft.digest); assert.equal((await f.service.wait(draft.id, target)).state, "succeeded");
  assert.equal(f.calls.filter(c => new URL(c.url).pathname.endsWith("/initialize")).length, 1);
  assert.equal(f.calls.filter(c => new URL(c.url).pathname === "/2/tweets").length, 1);
});

test("lost media-post create receipt cannot become a media-ready retry authorization", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), media = f.media(target);
  const draft = await f.service.create({ target, metadata: xMetadata("Never duplicate"), media }); f.control.failCreate = true;
  f.service.approve(draft.id, target, draft.digest); assert.equal((await f.service.wait(draft.id, target)).state, "uncertain");
  f.service.reconcile(draft.id, target); const result = await f.service.wait(draft.id, target);
  assert.equal(result.state, "uncertain"); assert.equal(result.receipt.providerState, "POST_DISPATCHING");
  assert.throws(() => f.service.approve(draft.id, target, draft.digest), /social_approval_stale/);
});

test("durable refresh lease serializes remote token rotation across runtimes", async t => {
  const f = await fixture(t), a = await f.connected(), g = await fixture(t, { directory: f.directory, secrets: f.secrets });
  f.advance(3600000); g.advance(3600000); const gate = deferred(); g.control.tokenGate = gate;
  const winning = g.service.verify(a); await until(() => g.calls.some(c => c.url.endsWith("/token")));
  try { await assert.rejects(f.service.verify(a), /social_account_busy/); }
  finally { gate.resolve(); }
  await winning; const winner = f.store.connection(a).credentialRef;
  assert.equal(f.secrets.has(winner), true); await f.service.verify(a);
  assert.equal(f.store.connection(a).credentialRef, winner);
  assert.equal(f.service.accounts()[0].status, "connected");
  assert.equal(f.db.prepare("SELECT count(*) n FROM social_refresh_leases").get().n, 0);
});

test("revocation failure retains encrypted grant for explicit retry and fences every new write", async t => {
  const f = await fixture(t), a = await f.connected();
  f.control.onCall = async u => { if (u.pathname.endsWith("/revoke")) throw new Error("synthetic-sensitive-revoke-error"); };
  await assert.rejects(f.service.disconnect(a, true), /social_unavailable/);
  assert.equal(f.service.accounts()[0].status, "reauth-required"); assert.ok(f.store.connection(a).credentialRef);
  await assert.rejects(f.service.verify(a), /social_connection_changed/);
  f.control.onCall = null; await f.service.disconnect(a, true); assert.equal(f.service.accounts()[0].status, "disconnected");
  assert.equal(f.secrets.size, 1, "only the app configuration remains");
});

test("configuration replacement and payload tampering invalidate old approvals", async t => {
  const f = await fixture(t), a = await f.connected(), target = f.target(a), draft = await f.service.create({ target, metadata: xMetadata("Original"), media: null });
  const tampered = structuredClone(draft); tampered.payload.metadata.text = "Changed";
  f.db.prepare("UPDATE social_posts SET data=? WHERE id=?").run(JSON.stringify(tampered), draft.id);
  assert.throws(() => f.service.approve(draft.id, target, draft.digest), /social_approval_stale/);
  f.db.prepare("UPDATE social_posts SET data=? WHERE id=?").run(JSON.stringify(draft), draft.id);
  await f.configure("x"); assert.throws(() => f.service.approve(draft.id, target, draft.digest), /social_connection_changed/);
});

test("crosspost media source must have its explicit original account/project context", async t => {
  const f = await fixture(t), a = await f.connected(), b = await f.connected("linkedin"), at = f.target(a), bt = f.target(b), media = f.media(at);
  await assert.rejects(f.service.create({ target: bt, metadata: liMetadata("Wrong source context"), media: { ...media, context: { accountId: bt.accountId, projectId: bt.projectId } } }), /artifact_not_found/);
  const valid = await f.service.create({ target: bt, metadata: liMetadata("Explicit crosspost"), media });
  assert.equal(valid.payload.media.context.accountId, at.accountId); assert.equal(valid.payload.target.accountId, bt.accountId);
});

test("SQLite main/WAL and public posts never contain OAuth or signed-upload credentials", async t => {
  const f = await fixture(t), a = await f.connected("tiktok"), target = f.target(a), media = f.media(target);
  const draft = await f.service.create({ target, metadata: ttMetadata(), media }); f.service.approve(draft.id, target, draft.digest, true); await f.service.wait(draft.id, target);
  const buffers = [await readFile(join(f.directory, "workspace.sqlite")), await readFile(join(f.directory, "workspace.sqlite-wal"))];
  for (const sensitive of ["synthetic-access-token", "synthetic-refresh-token", "synthetic-client-secret", "synthetic-upload-secret", "synthetic-code"]) {
    for (const buffer of buffers) assert.ok(!buffer.includes(Buffer.from(sensitive)));
    assert.ok(!JSON.stringify(f.service.posts(target)).includes(sensitive));
  }
});

test("chunk planning, LinkedIn plaintext escaping and int64 preservation are deterministic", () => {
  assert.deepEqual(tikTokChunkPlan(50000123, 10000000), { chunkSize: 10000000, count: 5 });
  assert.deepEqual(tikTokChunkPlan(100), { chunkSize: 100, count: 1 });
  assert.equal(linkedinPlainText("a[link](x) \\ *b*"), "a\\[link\\]\\(x\\) \\\\ \\*b\\*");
  assert.deepEqual(parseSocialJson('{"id":9223372036854775000,"text":"9223372036854775000","n":12}'), { id: "9223372036854775000", text: "9223372036854775000", n: 12 });
  assert.equal(socialScopes({ provider: "linkedin", organizationAccess: false }).includes("r_member_social"), false);
});

test("system-browser launcher rejects arbitrary URLs and OAuth URL substitution before spawning", async () => {
  for (const raw of ["https://hostile.example", "file:///C:/test", "https://x.com.evil/i/oauth2/authorize?state=x", "https://x.com/i/oauth2/authorize?client_id=forged", "https://accounts.google.com/o/oauth2/v2/auth?x=1"]) {
    assert.equal(isSocialAuthorizationUrl(raw), false); assert.equal(await openSocialAuthorizationBrowser(raw), false);
  }
});
