import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startApi } from "../dist/services/local-api/src/server.js";
import { YouTubeProvider } from "../dist/services/local-api/src/youtube-provider.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";

const channelA = `UC${"a".repeat(22)}`;
const channelB = `UC${"b".repeat(22)}`;
const client = { clientId: "synthetic-test.apps.googleusercontent.com", clientSecret: "synthetic-client-secret" };
const scopes = ["openid", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Provider operation did not reach the expected barrier");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "atris-share-youtube-"));
  const secrets = options.secrets ?? new Map();
  let clock = Date.now();
  let authUrl;
  const calls = [];
  const control = { channel: channelA, subject: "google-subject-a", granted: scopes.join(" "), tokenError: null,
    omitRefresh: false, omitRefreshScope: false, revokeError: false, tokenGate: null, identityGate: null, revokeGate: null,
    browser: true, networkError: false, ...options.control };
  const transport = async (url, init) => {
    const address = new URL(url);
    assert.equal(address.protocol, "https:");
    assert.equal(init.redirect, "error");
    assert.ok(!address.searchParams.has("access_token"));
    calls.push({ url, init });
    if (control.networkError) throw new Error("synthetic-sensitive-network-error");
    if (address.pathname === "/token") {
      if (control.tokenGate) await control.tokenGate.promise;
      if (control.tokenError) return json({ error: control.tokenError, error_description: "synthetic-sensitive-provider-error" }, 400);
      const fields = new URLSearchParams(init.body);
      const refresh = fields.get("grant_type") === "refresh_token";
      return json({ access_token: refresh ? "synthetic-refreshed-token" : "synthetic-access-token", token_type: "Bearer", expires_in: 3600,
        ...(!refresh && !control.omitRefresh ? { refresh_token: "synthetic-refresh-token" } : {}),
        ...(!(refresh && control.omitRefreshScope) ? { scope: control.granted } : {}) });
    }
    if (address.pathname === "/v1/userinfo") {
      if (control.identityGate) await control.identityGate.promise;
      assert.match(init.headers.Authorization, /^Bearer synthetic-/);
      return json({ sub: control.subject });
    }
    if (address.pathname === "/youtube/v3/channels") {
      assert.equal(address.searchParams.get("mine"), "true");
      return json({ items: [{ id: control.channel, snippet: { title: "Verified test channel" } }] });
    }
    if (address.pathname === "/revoke") {
      if (control.revokeGate) await control.revokeGate.promise;
      return control.revokeError ? json({ error: "server_error" }, 503) : new Response(null, { status: 200 });
    }
    throw new Error("Unexpected provider endpoint");
  };
  const vault = { status: { available: true, provider: "windows-dpapi" },
    async get(ref) { return secrets.get(ref) ?? null; },
    async set(ref, secret) { secrets.set(ref, secret); if (options.vaultGate) await options.vaultGate.promise; },
    async delete(ref) { secrets.delete(ref); } };
  const api = await startApi({ dataDirectory: directory, credentialVault: vault, allowedOrigins: ["http://127.0.0.1:1438"],
    youtube: { client, provider: new YouTubeProvider(transport), now: () => clock,
      openBrowser: async url => { authUrl = new URL(url); return control.browser; } } });
  t.after(async () => { await api.close(); if (!options.directory) await rm(directory, { recursive: true, force: true }); });
  const call = (path, input, method = input === undefined ? "GET" : "POST") => fetch(`${api.origin}${path}`, {
    method, headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  async function start(accountId) {
    const response = await call("/api/youtube/sessions", { expectedChannelId: channelA, ...(accountId ? { accountId } : {}) });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function callback(parameters = {}) {
    const query = new URLSearchParams({ state: authUrl.searchParams.get("state"), code: "synthetic-authorization-code", ...parameters });
    return fetch(`${api.origin}/oauth/youtube/callback?${query}`, { redirect: "manual" });
  }
  async function connected() {
    const session = await start();
    assert.equal((await callback()).status, 303);
    const result = await (await call(`/api/youtube/sessions/${session.id}`)).json();
    assert.equal(result.state, "connected", result.error);
    return (await (await call("/api/workspace")).json()).accounts.find(account => account.id === result.accountId);
  }
  return { api, call, start, callback, connected, control, calls, secrets, directory,
    get authUrl() { return authUrl; }, advance: ms => { clock += ms; } };
}

test("official desktop PKCE flow verifies subject/channel and persists only vault references", async t => {
  const f = await fixture(t);
  const demo = await (await f.call("/api/accounts", { displayName: "Existing demo", platform: "youtube" })).json();
  const session = await f.start();
  assert.equal(session.state, "awaiting-browser");
  const url = f.authUrl;
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("redirect_uri"), `${f.api.origin}/oauth/youtube/callback`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(url.searchParams.get("scope").split(" "), scopes);
  assert.ok(!JSON.stringify(session).includes(url.searchParams.get("state")));
  assert.equal((await f.callback()).status, 303);
  const exchange = new URLSearchParams(f.calls.find(call => call.url.endsWith("/token")).init.body);
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(createHash("sha256").update(exchange.get("code_verifier")).digest("base64url"), url.searchParams.get("code_challenge"));
  const state = await (await f.call("/api/workspace")).json();
  assert.equal(state.accounts.find(account => account.id === demo.id).status, "demo");
  const account = state.accounts.find(account => account.status === "connected");
  assert.equal(account.destinationId, channelA);
  assert.equal(account.connection.providerSubjectId, "google-subject-a");
  assert.ok(!JSON.stringify(state).includes("synthetic-access-token"));
  assert.ok(!JSON.stringify(state).includes("credentialRef"));
  assert.equal(f.secrets.size, 1);
  const database = await readFile(join(f.directory, "atris-share.sqlite"));
  const wal = await readFile(join(f.directory, "atris-share.sqlite-wal"));
  for (const secret of ["synthetic-access-token", "synthetic-refresh-token", "synthetic-client-secret", "synthetic-authorization-code"]) {
    assert.ok(!database.includes(Buffer.from(secret)) && !wal.includes(Buffer.from(secret)));
  }
  const result = await fetch(`${f.api.origin}/oauth/youtube/result`);
  assert.match(result.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!(await result.text()).includes("synthetic-"));
});

test("callback rejects hostile origins, mismatched/duplicate state, replay and arbitrary credential input", async t => {
  const f = await fixture(t);
  await f.start();
  assert.equal((await f.callback({ state: "wrong" })).status, 400);
  const duplicate = new URLSearchParams({ state: f.authUrl.searchParams.get("state"), code: "code" });
  duplicate.append("state", f.authUrl.searchParams.get("state"));
  assert.equal((await fetch(`${f.api.origin}/oauth/youtube/callback?${duplicate}`)).status, 400);
  assert.equal((await fetch(`${f.api.origin}/oauth/youtube/callback?${duplicate}`, { headers: { Origin: "https://hostile.example" } })).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.callback()).status, 303);
  assert.equal((await f.callback()).status, 400);
  assert.equal(f.calls.filter(call => call.url.endsWith("/token")).length, 1);
  assert.equal((await f.call("/api/youtube/sessions", { expectedChannelId: channelB, access_token: "forged" })).status, 400);
  assert.equal((await fetch(`${f.api.origin}/api/youtube`)).status, 401);
  assert.equal((await f.call("/api/vault")).status, 404);
});

test("wrong channel, denied scopes/consent, missing refresh and issuer mismatch cannot create accounts", async t => {
  for (const scenario of [
    { control: { channel: channelB }, error: "youtube_channel_mismatch" },
    { control: { granted: "openid" }, error: "youtube_missing_scope" },
    { control: { omitRefresh: true }, error: "youtube_refresh_missing" },
    { parameters: { error: "access_denied", error_description: "do-not-echo" }, error: "youtube_consent_denied" },
    { parameters: { iss: "https://hostile.example" }, error: "youtube_invalid_callback" }
  ]) await t.test(scenario.error, async t => {
    const f = await fixture(t, { control: scenario.control });
    const session = await f.start();
    assert.equal((await f.callback(scenario.parameters)).status, 303);
    const result = await (await f.call(`/api/youtube/sessions/${session.id}`)).json();
    assert.equal(result.state, "failed"); assert.equal(result.error, scenario.error);
    assert.deepEqual((await (await f.call("/api/workspace")).json()).accounts, []);
    assert.equal(f.secrets.size, 0);
  });
});

test("expired/cancelled sessions and cancellation during vault write cannot persist credentials", async t => {
  const f = await fixture(t);
  let session = await f.start();
  f.advance(10 * 60_000);
  assert.equal((await f.callback()).status, 400);
  assert.equal((await (await f.call(`/api/youtube/sessions/${session.id}`)).json()).state, "expired");
  session = await f.start();
  assert.equal((await f.call(`/api/youtube/sessions/${session.id}/cancel`, {})).status, 200);
  assert.equal((await f.callback()).status, 400);
  const gate = deferred();
  const g = await fixture(t, { vaultGate: gate });
  session = await g.start();
  const callback = g.callback();
  await until(() => g.secrets.size);
  await g.call(`/api/youtube/sessions/${session.id}/cancel`, {});
  gate.resolve();
  await callback;
  assert.deepEqual((await (await g.call("/api/workspace")).json()).accounts, []);
  assert.equal(g.secrets.size, 0);
});

test("callback is consumed before exchange and a second active session is rejected", async t => {
  const gate = deferred();
  const f = await fixture(t, { control: { tokenGate: gate } });
  await f.start();
  const first = f.callback();
  await until(() => f.calls.length);
  assert.equal((await f.callback()).status, 400);
  assert.equal((await f.call("/api/youtube/sessions", { expectedChannelId: channelB })).status, 409);
  gate.resolve();
  assert.equal((await first).status, 303);
  assert.equal(f.calls.filter(call => call.url.endsWith("/token")).length, 1);
});

test("refresh keeps the refresh grant, re-verifies identity and fences incorrect account/destination", async t => {
  const f = await fixture(t);
  const account = await f.connected();
  f.control.omitRefreshScope = true;
  const input = { accountId: account.id, destinationId: channelA };
  assert.equal((await f.call("/api/youtube/verify", { ...input, destinationId: channelB })).status, 404);
  assert.equal((await f.call("/api/youtube/verify", input)).status, 200);
  assert.equal(f.secrets.size, 1);
  assert.equal(JSON.parse([...f.secrets.values()][0]).refreshToken, "synthetic-refresh-token");
  assert.equal(JSON.parse([...f.secrets.values()][0]).accessToken, "synthetic-refreshed-token");
  f.control.subject = "another-google-subject";
  assert.equal((await f.call("/api/youtube/verify", input)).status, 409);
  const snapshot = await (await f.call("/api/workspace")).json();
  assert.equal(snapshot.accounts[0].status, "reauth-required");
  assert.equal(snapshot.accounts[0].connection.providerSubjectId, account.connection.providerSubjectId);
  assert.equal((await f.call("/api/youtube/verify", input)).status, 409);
});

test("invalid_grant blocks use and provider details never escape the API", async t => {
  const f = await fixture(t);
  const account = await f.connected();
  f.control.tokenError = "invalid_grant";
  const response = await f.call("/api/youtube/verify", { accountId: account.id, destinationId: channelA });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "youtube_reauth_required" });
  assert.equal((await (await f.call("/api/workspace")).json()).accounts[0].status, "reauth-required");
});

test("transient network failure preserves the grant for explicit verification retry", async t => {
  const f = await fixture(t);
  const account = await f.connected();
  const input = { accountId: account.id, destinationId: channelA };
  f.control.networkError = true;
  const response = await f.call("/api/youtube/verify", input);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "youtube_unavailable" });
  assert.equal((await (await f.call("/api/workspace")).json()).accounts[0].status, "connected");
  assert.equal(f.secrets.size, 1);
  f.control.networkError = false;
  assert.equal((await f.call("/api/youtube/verify", input)).status, 200);
});

test("disconnect preserves projects/memory and failed revocation is explicitly retryable", async t => {
  const f = await fixture(t);
  const account = await f.connected();
  const input = { accountId: account.id, destinationId: channelA, revoke: true };
  const project = await (await f.call("/api/projects", { accountId: account.id, name: "Keep me", description: "" })).json();
  const context = { accountId: account.id, projectId: project.id };
  await f.call("/api/memory", { context, kind: "decision", text: "Preserve this", reviewState: "confirmed" });
  f.control.revokeError = true;
  assert.equal((await f.call("/api/youtube/disconnect", input)).status, 502);
  assert.equal(f.secrets.size, 1);
  assert.equal((await (await f.call("/api/workspace")).json()).accounts[0].status, "reauth-required");
  f.control.revokeError = false;
  assert.equal((await f.call("/api/youtube/disconnect", input)).status, 200);
  assert.equal(f.secrets.size, 0);
  assert.equal((await (await f.call("/api/workspace")).json()).accounts[0].status, "disconnected");
  assert.equal((await (await f.call(`/api/memory?accountId=${account.id}&projectId=${project.id}`)).json())[0].text, "Preserve this");
  await f.start(account.id);
  assert.equal((await f.callback()).status, 303);
  assert.equal((await (await f.call("/api/workspace")).json()).accounts[0].id, account.id);
  assert.equal((await (await f.call("/api/workspace")).json()).accounts[0].status, "connected");
});

test("two runtimes cannot overwrite or delete the winning refresh credentials", async t => {
  const a = await fixture(t);
  const account = await a.connected();
  const gate = deferred();
  const b = await fixture(t, { directory: a.directory, secrets: a.secrets, control: { tokenGate: gate } });
  const input = { accountId: account.id, destinationId: channelA };
  const stale = b.call("/api/youtube/verify", input);
  await until(() => b.calls.length);
  assert.equal((await a.call("/api/youtube/verify", input)).status, 200);
  gate.resolve();
  assert.equal((await stale).status, 409);
  assert.equal(a.secrets.size, 1);
  assert.equal((await a.call("/api/youtube/verify", input)).status, 200);
  await b.api.close();
});

test("revocation fences reconnects completed during the remote request", async t => {
  const a = await fixture(t);
  const account = await a.connected();
  const gate = deferred(); a.control.revokeGate = gate;
  const b = await fixture(t, { directory: a.directory, secrets: a.secrets });
  const disconnect = a.call("/api/youtube/disconnect", { accountId: account.id, destinationId: channelA, revoke: true });
  await until(() => a.calls.some(call => call.url.endsWith("/revoke")));
  await b.start(account.id); await b.callback();
  gate.resolve();
  assert.equal((await disconnect).status, 409);
  const snapshot = await (await b.call("/api/workspace")).json();
  assert.equal(snapshot.accounts[0].status, "reauth-required");
  assert.equal(a.secrets.size, 1);
  await b.api.close();
});

test("restart restores verified accounts without exposing credentials or restoring OAuth sessions", async t => {
  const f = await fixture(t);
  const account = await f.connected();
  const pending = await f.start(account.id);
  await f.api.close();
  const next = await fixture(t, { directory: f.directory, secrets: f.secrets });
  const restored = await (await next.call("/api/workspace")).json();
  assert.equal(restored.accounts[0].id, account.id);
  assert.equal(restored.accounts[0].status, "connected");
  assert.equal((await next.call(`/api/youtube/sessions/${pending.id}`)).status, 404);
  assert.equal((await next.call("/api/youtube/verify", { accountId: account.id, destinationId: channelA })).status, 200);
  await next.api.close();
});

test("unconfigured/unavailable vault is fail-closed and demo accounts cannot be promoted", async t => {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-no-youtube-"));
  const api = await startApi({ dataDirectory: directory, vaultStatus: { available: false, provider: "unavailable" }, youtube: { client: null } });
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const response = await fetch(`${api.origin}/api/youtube/sessions`, { method: "POST", headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ expectedChannelId: channelA }) });
  assert.equal(response.status, 409);
  const store = new WorkspaceStore(join(directory, "atris-share.sqlite"));
  try {
    const demo = store.createAccount({ displayName: "Demo", platform: "youtube" });
    assert.throws(() => store.getYouTubeConnection(demo.id, channelA), /youtube_account_not_found/);
    assert.equal(store.listAccounts()[0].status, "demo");
  } finally { store.close(); }
});
