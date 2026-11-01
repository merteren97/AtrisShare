import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { YouTubeService } from "../dist/services/local-api/src/youtube.js";
import { YouTubeProvider, desktopClientFromEnv } from "../dist/services/local-api/src/youtube-provider.js";
import { YOUTUBE_SCOPES } from "../dist/packages/domain/src/youtube.js";

const client = { clientId: "synthetic-desktop.apps.googleusercontent.com", clientSecret: "GOCSPX-synthetic-secret" };
const replacement = { clientId: "replacement-desktop.apps.googleusercontent.com", clientSecret: "GOCSPX-replacement-secret" };
const channel = `UC${"a".repeat(22)}`;
const origin = "http://127.0.0.1:12345";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const code = expected => failure => {
  assert.equal(failure.code, expected);
  for (const secret of [client.clientId, client.clientSecret, replacement.clientSecret, "sensitive-vault-diagnostic"]) {
    assert.ok(!JSON.stringify(failure).includes(secret));
    assert.ok(!failure.message.includes(secret));
  }
  return true;
};
function assertPrivate(setup) {
  assert.deepEqual(Object.keys(setup).sort(), ["available", "configured", "configuredSource", "scopes"]);
  for (const secret of [client.clientId, client.clientSecret, replacement.clientId, replacement.clientSecret]) assert.ok(!JSON.stringify(setup).includes(secret));
}
function fixture(t, options = {}) {
  const store = new WorkspaceStore(":memory:");
  const secrets = options.secrets ?? new Map();
  const calls = [];
  const vault = { status: { available: options.available ?? true, provider: "windows-dpapi" },
    async get(ref) { return options.get ? options.get(ref) : secrets.get(ref) ?? null; },
    async set(ref, value) { if (options.set) await options.set(ref, value); secrets.set(ref, value); },
    async delete(ref) { secrets.delete(ref); }
  };
  let auth;
  const provider = new YouTubeProvider(async (url, init) => {
    // All provider traffic stays in this fake transport; no fetch or remote OAuth request.
    calls.push({ url, fields: new URLSearchParams(init.body) });
    if (url.endsWith("/token")) {
      if (options.tokenGate) { options.tokenEntered.resolve(); await options.tokenGate.promise; }
      return json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600, scope: YOUTUBE_SCOPES.join(" ") });
    }
    if (url.endsWith("/v1/userinfo")) return json({ sub: "synthetic-subject" });
    if (url.includes("/youtube/v3/channels?")) return json({ items: [{ id: channel, snippet: { title: "Synthetic channel" } }] });
    assert.fail("Unexpected provider operation");
  });
  let clock = Date.now();
  const service = new YouTubeService(store, vault, { client: options.client ?? null, provider, now: () => clock,
    openBrowser: async value => { auth = new URL(value); return true; } });
  t.after(async () => { await service.close(); store.close(); });
  return { service, secrets, calls, store, vault, get auth() { return auth; }, advance: ms => { clock += ms; },
    start: () => service.start({ expectedChannelId: channel }, origin),
    callback: () => service.callback(new URLSearchParams({ state: auth.searchParams.get("state"), code: "synthetic-code" }), origin) };
}

test("local Desktop app config persists under a stable reserved vault ref and restart restores it without credential readback", async t => {
  const first = fixture(t);
  await first.service.loadLocalClient();
  assert.deepEqual(first.service.setup(), { configured: false, available: false, configuredSource: "none", scopes: YOUTUBE_SCOPES });
  const setup = await first.service.configure(client);
  assertPrivate(setup);
  assert.equal(setup.configuredSource, "local"); assert.equal(setup.available, true);
  assert.equal(first.calls.length, 0);
  assert.equal(first.secrets.size, 1);
  const [ref] = first.secrets.keys();
  assert.match(ref, /^account:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(JSON.parse(first.secrets.get(ref)), client);
  assert.deepEqual(first.store.listAccounts(), []);
  await first.service.close();

  const restarted = fixture(t, { secrets: first.secrets, client: replacement });
  await restarted.service.loadLocalClient();
  assertPrivate(restarted.service.setup());
  assert.equal(restarted.service.setup().configuredSource, "local");
  const session = await restarted.start();
  assert.equal(restarted.auth.searchParams.get("client_id"), client.clientId);
  assert.ok(!JSON.stringify(session).includes(client.clientSecret));
  restarted.service.cancel(session.id);
  await restarted.service.configure({ clientId: replacement.clientId });
  assert.equal(first.secrets.size, 1);
  assert.deepEqual(JSON.parse(first.secrets.get(ref)), { clientId: replacement.clientId });
  const third = fixture(t, { secrets: first.secrets });
  await third.service.loadLocalClient(); await third.start();
  assert.equal(third.auth.searchParams.get("client_id"), replacement.clientId);
});

test("missing local config falls back to environment; shared validation is bounded and rejects tokens/newlines", async t => {
  const previousId = process.env.ATRIS_SHARE_YOUTUBE_CLIENT_ID;
  const previousSecret = process.env.ATRIS_SHARE_YOUTUBE_CLIENT_SECRET;
  t.after(() => {
    if (previousId === undefined) delete process.env.ATRIS_SHARE_YOUTUBE_CLIENT_ID; else process.env.ATRIS_SHARE_YOUTUBE_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.ATRIS_SHARE_YOUTUBE_CLIENT_SECRET; else process.env.ATRIS_SHARE_YOUTUBE_CLIENT_SECRET = previousSecret;
  });
  process.env.ATRIS_SHARE_YOUTUBE_CLIENT_ID = client.clientId;
  process.env.ATRIS_SHARE_YOUTUBE_CLIENT_SECRET = client.clientSecret;
  const vault = { status: { available: true, provider: "windows-dpapi" }, async get() { return null; } };
  const service = new YouTubeService({}, vault);
  t.after(() => service.close());
  await service.loadLocalClient();
  assert.equal(service.setup().configuredSource, "env"); assert.equal(service.setup().available, true);
  process.env.ATRIS_SHARE_YOUTUBE_CLIENT_ID = `${"a".repeat(230)}.apps.googleusercontent.com`;
  assert.equal(desktopClientFromEnv(), null);
  process.env.ATRIS_SHARE_YOUTUBE_CLIENT_ID = client.clientId;
  process.env.ATRIS_SHARE_YOUTUBE_CLIENT_SECRET = `${client.clientSecret}\n`;
  assert.equal(desktopClientFromEnv(), null);
});

test("invalid config never writes to the vault and errors contain no supplied credential details", async t => {
  const f = fixture(t);
  for (const input of [null, {}, { clientId: "https://example.com" }, { clientId: "ya29.synthetic-access-token" },
    { ...client, access_token: "synthetic-token" }, { ...client, clientId: `${client.clientId}\n` },
    { ...client, clientId: `${"a".repeat(230)}.apps.googleusercontent.com` },
    { ...client, clientSecret: "" }, { ...client, clientSecret: "a".repeat(501) },
    { ...client, clientSecret: "ya29.synthetic-token" }, { ...client, clientSecret: "Bearer synthetic-token" },
    { ...client, clientSecret: `${client.clientSecret}\n` }, { ...client, clientSecret: "abc\rdef" }]) {
    await assert.rejects(f.service.configure(input), code("youtube_invalid_client_config"));
  }
  assert.equal(f.secrets.size, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.service.setup().configured, false);
});

test("unavailable vault and encrypted write failures never activate a new config", async t => {
  const f = fixture(t, { available: false });
  await f.service.loadLocalClient();
  await assert.rejects(f.service.configure(client), code("vault_unavailable"));
  assert.equal(f.service.setup().available, false); assert.equal(f.secrets.size, 0);
  const g = fixture(t, { client, set: async () => { throw new Error(`sensitive-vault-diagnostic ${replacement.clientSecret}`); } });
  await assert.rejects(g.service.configure(replacement), code("youtube_config_save_failed"));
  assert.equal(g.service.setup().configuredSource, "env");
  await g.start(); assert.equal(g.auth.searchParams.get("client_id"), client.clientId);
  assert.equal(g.secrets.size, 0);
});

test("malformed or unreadable saved config fails closed, stays private, and can be repaired locally", async t => {
  for (const saved of ["{sensitive-vault-diagnostic", "x".repeat(2049), "null", JSON.stringify({ ...client, refreshToken: "synthetic-token" }),
    JSON.stringify({ clientId: "not-a-desktop-client", clientSecret: client.clientSecret })]) {
    const f = fixture(t, { client, get: async () => saved });
    await f.service.loadLocalClient();
    assert.equal(f.service.setup().configured, false); assert.equal(f.service.setup().available, false);
    assert.equal(f.service.setup().configurationError, "youtube_config_invalid");
    assert.ok(!JSON.stringify(f.service.setup()).includes(client.clientSecret));
    await assert.rejects(f.start(), code("youtube_not_configured"));
    assertPrivate(await f.service.configure(replacement));
    assert.equal(f.service.setup().available, true);
  }
  const g = fixture(t, { client, get: async () => { throw new Error(`sensitive-vault-diagnostic ${client.clientSecret}`); } });
  await g.service.loadLocalClient();
  assert.equal(g.service.setup().configurationError, "youtube_config_load_failed");
  assert.equal(g.service.setup().configured, false);
});

test("awaiting and verifying OAuth sessions reject configuration changes before any write", async t => {
  const f = fixture(t, { client });
  const session = await f.start();
  await assert.rejects(f.service.configure(replacement), code("youtube_session_active"));
  await assert.rejects(f.service.loadLocalClient(), code("youtube_session_active"));
  assert.equal(f.secrets.size, 0);
  f.service.cancel(session.id);
  await f.service.configure(replacement);

  const tokenGate = deferred(), tokenEntered = deferred();
  const g = fixture(t, { client, tokenGate, tokenEntered });
  t.after(() => tokenGate.resolve());
  const verifying = await g.start();
  const callback = g.callback();
  await tokenEntered.promise;
  assert.equal(g.service.status(verifying.id).state, "verifying");
  await assert.rejects(g.service.configure(replacement), code("youtube_session_active"));
  assert.equal(g.secrets.size, 0);
  tokenGate.resolve(); await callback;
  assert.equal(g.service.status(verifying.id).state, "connected");
});

test("config lock fences starts, duplicate saves and loads across an asynchronous encrypted write", async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { client, set: async () => { entered.resolve(); await gate.promise; } });
  t.after(() => gate.resolve());
  const save = f.service.configure(replacement);
  await entered.promise;
  assert.equal(f.service.setup().available, false);
  await assert.rejects(f.start(), code("youtube_configuring"));
  await assert.rejects(f.service.configure(client), code("youtube_configuring"));
  await assert.rejects(f.service.loadLocalClient(), code("youtube_configuring"));
  gate.resolve(); const result = await save;
  assert.equal(result.available, true);
  await f.start(); assert.equal(f.auth.searchParams.get("client_id"), replacement.clientId);
});

test("load lock fences OAuth starts and saves until the local record has been selected", async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { client, get: async () => { entered.resolve(); await gate.promise; return JSON.stringify(replacement); } });
  t.after(() => gate.resolve());
  const load = f.service.loadLocalClient();
  await entered.promise;
  await assert.rejects(f.start(), code("youtube_configuring"));
  await assert.rejects(f.service.configure(client), code("youtube_configuring"));
  gate.resolve(); await load;
  await f.start(); assert.equal(f.auth.searchParams.get("client_id"), replacement.clientId);
});

test("expired sessions no longer block configuration", async t => {
  const f = fixture(t, { client });
  const session = await f.start();
  f.advance(10 * 60_000);
  await f.service.configure(replacement);
  assert.equal(f.service.status(session.id).state, "expired");
  await f.start(); assert.equal(f.auth.searchParams.get("client_id"), replacement.clientId);
});

test("changing app configuration never switches the client bound to an existing account grant", async t => {
  const f = fixture(t);
  await f.service.configure(client);
  const [appRef] = f.secrets.keys();
  const session = await f.start(); await f.callback();
  const accountId = f.service.status(session.id).accountId;
  assert.equal(f.secrets.size, 2);
  const grantRef = f.store.getYouTubeConnection(accountId, channel).credentialRef;
  assert.notEqual(grantRef, appRef);
  await f.service.configure(replacement);
  assert.deepEqual(await f.service.verify({ accountId, destinationId: channel }), { verified: true });
  const refresh = f.calls.find(call => call.fields.get("grant_type") === "refresh_token");
  assert.equal(refresh.fields.get("client_id"), client.clientId);
  assert.equal(refresh.fields.get("client_secret"), client.clientSecret);
  assert.equal(JSON.parse(f.secrets.get(appRef)).clientId, replacement.clientId);
  await f.service.disconnect({ accountId, destinationId: channel }, false);
  assert.equal(f.secrets.size, 1); assert.ok(f.secrets.has(appRef));
});

test("close waits for config writes and never activates their result after shutdown", async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { set: async () => { entered.resolve(); await gate.promise; } });
  t.after(() => gate.resolve());
  const save = f.service.configure(client);
  const rejected = assert.rejects(save, code("runtime_closing"));
  await entered.promise;
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  await assert.rejects(f.service.configure(replacement), code("runtime_closing"));
  gate.resolve(); await rejected; await closing;
  assert.equal(f.service.setup().configured, false); assert.equal(f.service.setup().available, false);
  await assert.rejects(f.start(), code("runtime_closing"));
  // An encrypted write already in progress can finish; only a fresh runtime may activate it.
  const next = fixture(t, { secrets: f.secrets });
  await next.service.loadLocalClient(); assert.equal(next.service.setup().configuredSource, "local");
});

test("close waits for pending local load and prevents activation", async t => {
  const entered = deferred(), gate = deferred();
  const f = fixture(t, { get: async () => { entered.resolve(); await gate.promise; return JSON.stringify(client); } });
  t.after(() => gate.resolve());
  const loading = f.service.loadLocalClient();
  const rejected = assert.rejects(loading, code("runtime_closing"));
  await entered.promise;
  const closing = f.service.close();
  gate.resolve(); await rejected; await closing;
  assert.equal(f.service.setup().configured, false);
  await assert.rejects(f.service.loadLocalClient(), code("runtime_closing"));
});
