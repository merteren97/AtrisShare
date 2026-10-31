import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startApi } from "../dist/services/local-api/src/server.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-api-"));
  const api = await startApi({ dataDirectory: directory, allowedOrigins: ["http://127.0.0.1:1438"], vaultStatus: { available: false, provider: "unavailable" } });
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (path, options = {}) => fetch(`${api.origin}${path}`, {
    ...options, headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json", ...options.headers }
  });
  return { api, call };
}

test("loopback API requires session authentication and rejects hostile origins/URL credentials", async t => {
  const { api, call } = await fixture(t);
  assert.match(api.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${api.origin}/api/workspace`)).status, 401);
  assert.equal((await call("/api/workspace", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await call("/api/workspace", { headers: { Origin: "https://untrusted.example" } })).status, 403);
  assert.equal((await call("/api/workspace?token=oops")).status, 400);
  const valid = await call("/api/workspace", { headers: { Origin: "http://127.0.0.1:1438" } });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get("access-control-allow-origin"), "http://127.0.0.1:1438");
  assert.equal(valid.headers.get("cache-control"), "no-store");
  const snapshot = await valid.json();
  assert.deepEqual(snapshot.accounts, []);
  assert.equal(snapshot.context, null);
  assert.equal(snapshot.vault.available, false);
  assert.ok(!JSON.stringify(snapshot).includes(api.token));
});

test("API enforces explicit context on CRUD and preserves data across a fresh session", async t => {
  const { api, call } = await fixture(t);
  const account = await (await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Channel A", platform: "youtube" }) })).json();
  const other = await (await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Channel B", platform: "x" }) })).json();
  const project = await (await call("/api/projects", { method: "POST", body: JSON.stringify({ accountId: account.id, name: "Launch", description: "" }) })).json();
  const context = { accountId: account.id, projectId: project.id };
  assert.equal((await call("/api/context", { method: "PUT", body: JSON.stringify(context) })).status, 200);
  assert.equal((await call("/api/context", { method: "PUT", body: JSON.stringify({ accountId: other.id, projectId: project.id }) })).status, 404);
  assert.equal((await call("/api/memory")).status, 400);
  assert.equal((await call(`/api/memory?accountId=${account.id}`)).status, 400);
  const input = { context, kind: "decision", text: "Keep the intro short", reviewState: "suggested" };
  const memory = await (await call("/api/memory", { method: "POST", body: JSON.stringify(input) })).json();
  assert.equal(memory.revision, 1);
  const wrong = await call(`/api/memory/${memory.id}`, { method: "DELETE", body: JSON.stringify({ context: { accountId: other.id, projectId: null }, expectedRevision: 1 }) });
  assert.equal(wrong.status, 404);
  const patch = { ...input, text: "Confirmed shorter intro", reviewState: "confirmed", expectedRevision: 1 };
  assert.equal((await call(`/api/memory/${memory.id}`, { method: "PATCH", body: JSON.stringify(patch) })).status, 200);
  assert.equal((await call(`/api/memory/${memory.id}`, { method: "PATCH", body: JSON.stringify(patch) })).status, 409);
  const oldToken = api.token;
  const snapshot = await (await call("/api/workspace")).json();
  await api.close();
  const restarted = await startApi({ dataDirectory: snapshot.dataDirectory, vaultStatus: { available: false, provider: "unavailable" } });
  try {
    assert.notEqual(restarted.token, oldToken);
    assert.equal((await fetch(`${restarted.origin}/api/workspace`, { headers: { Authorization: `Bearer ${oldToken}` } })).status, 401);
    const headers = { Authorization: `Bearer ${restarted.token}` };
    const restored = await (await fetch(`${restarted.origin}/api/workspace`, { headers })).json();
    assert.deepEqual(restored.context, context);
    const records = await (await fetch(`${restarted.origin}/api/memory?accountId=${account.id}&projectId=${project.id}`, { headers })).json();
    assert.equal(records[0].text, "Confirmed shorter intro");
    assert.equal(records[0].revision, 2);
  } finally { await restarted.close(); }
});

test("invalid JSON/schema and oversized input produce bounded, non-sensitive errors", async t => {
  const { call } = await fixture(t);
  assert.equal((await call("/api/accounts", { method: "POST", body: "{" })).status, 400);
  const invalid = await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "", platform: "invented", access_token: "synthetic-secret" }) });
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes("synthetic-secret"));
  assert.equal((await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "x".repeat(40000), platform: "x" }) })).status, 413);
  assert.equal((await call("/api/accounts", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" })).status, 415);
});
