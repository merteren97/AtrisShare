import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startApi } from "../dist/services/local-api/src/server.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { randomUUID } from "node:crypto";
import { projectRoute } from "../dist/services/local-api/src/project-routes.js";

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
  const account = await (await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Workspace A", platform: "local" }) })).json();
  const other = await (await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Workspace B", platform: "local" }) })).json();
  assert.equal(account.status, "local");
  assert.equal(account.platform, "local");
  assert.equal((await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Fake channel", platform: "youtube" }) })).status, 400);
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

test("mounted social/scheduler routes retain runtime authentication, exact X counting and schedule CAS", async t => {
  const { api, call } = await fixture(t);
  assert.equal((await fetch(`${api.origin}/api/social`)).status, 401);
  const social = await (await call("/api/social")).json(); assert.deepEqual(social.accounts, []); assert.equal(social.setup.length, 3);
  const metrics = await (await call("/api/social/x/text-metrics", { method: "POST", body: JSON.stringify({ text: "https://example.com/a/very/long/url" }) })).json();
  assert.equal(metrics.weightedLength, 23); assert.equal(metrics.valid, true);
  assert.equal((await call("/api/queue")).status, 400);
  const a = await (await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Synthetic", platform: "local" }) })).json();
  const p = await (await call("/api/projects", { method: "POST", body: JSON.stringify({ accountId: a.id, name: "Test", description: "" }) })).json();
  const context = { accountId: a.id, projectId: p.id }, snapshot = await (await call("/api/workspace")).json();
  const w = new WorkspaceStore(join(snapshot.dataDirectory, "atris-share.sqlite"));
  let draft;
  try {
    const artifactId = randomUUID();
    w.studio.addArtifact({ id: artifactId, ...context, filename: "synthetic.mp4", sha256: "a".repeat(64), bytes: 1, mimeType: "video/mp4", probe: null, sourceId: null, channelVideoId: null, createdAt: new Date().toISOString() });
    draft = w.studio.create({ context, artifactId, title: "Scheduled synthetic", description: "", visibility: "private", madeForKids: false, notifySubscribers: false }, a.destinationId);
  } finally { w.close(); }
  const start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) + "T09:00";
  const created = await call("/api/schedules", { method: "POST", body: JSON.stringify({ context, name: "HTTP queue", kind: "youtube", draftId: draft.id,
    rule: { frequency: "daily", localStart: start, timeZone: "UTC", weekdays: [], missedPolicy: "ask" } }) });
  assert.equal(created.status, 201); const schedule = await created.json();
  const url = `/api/queue?${new URLSearchParams(context)}`, queued = await (await call(url)).json();
  assert.equal(queued.schedules[0].id, schedule.id); assert.equal(queued.occurrences[0].state, "scheduled"); assert.equal(queued.drafts.length, 0);
  const pause = () => call(`/api/schedules/${schedule.id}/pause`, { method: "POST", body: JSON.stringify({ context, expectedRevision: 1 }) });
  assert.equal((await pause()).status, 200); assert.equal((await pause()).status, 409);
  const notices = await (await call("/api/queue/notifications")).json(); assert.deepEqual(notices.occurrences, []); assert.equal(notices.next, null);
  assert.equal((await call("/api/queue/notifications?afterId=invalid&afterDueAt=yesterday")).status, 400);
});

test("memory logical deletion is scoped, audited and durable after API restart", async t => {
  const { api, call } = await fixture(t), a = await (await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Export", platform: "local" }) })).json();
  const context = { accountId: a.id, projectId: null };
  const note = await (await call("/api/memory", { method: "POST", body: JSON.stringify({ context, kind: "decision", text: "İçerik 😀", reviewState: "confirmed" }) })).json();
  const dataDirectory = (await (await call("/api/workspace")).json()).dataDirectory;
  assert.equal((await call(`/api/memory/${note.id}`, { method: "DELETE", body: JSON.stringify({ context, expectedRevision: 9 }) })).status, 409);
  assert.equal((await call(`/api/memory/${note.id}`, { method: "DELETE", body: JSON.stringify({ context, expectedRevision: note.revision }) })).status, 200);
  await api.close();
  const restarted = await startApi({ dataDirectory, vaultStatus: { available: false, provider: "unavailable" } });
  try {
    const response = await fetch(`${restarted.origin}/api/memory?accountId=${a.id}&projectId=`, { headers: { Authorization: `Bearer ${restarted.token}` } });
    assert.deepEqual(await response.json(), []);
  } finally { await restarted.close(); }
});

test("video tool settings reject arbitrary commands and persist an explicit PATH reset across restart", async t => {
  const { api, call } = await fixture(t);
  assert.equal((await fetch(`${api.origin}/api/settings/media-tools`)).status, 401);
  const initial = await (await call("/api/settings/media-tools")).json();
  assert.equal(initial.restartRequired, false);
  for (const input of [
    { ffmpegPath: "cmd.exe /c anything", ffprobePath: "" },
    { ffmpegPath: process.execPath, ffprobePath: "" },
    { ffmpegPath: "", ffprobePath: "", shell: true }
  ]) assert.equal((await call("/api/settings/media-tools", { method: "POST", body: JSON.stringify(input) })).status, 400);
  const reset = await call("/api/settings/media-tools", { method: "POST", body: JSON.stringify({ ffmpegPath: "", ffprobePath: "" }) });
  assert.equal(reset.status, 200);
  const directory = (await (await call("/api/workspace")).json()).dataDirectory;
  await api.close();
  const restarted = await startApi({ dataDirectory: directory, vaultStatus: { available: false, provider: "unavailable" } });
  try {
    const restored = await (await fetch(`${restarted.origin}/api/settings/media-tools`, { headers: { Authorization: `Bearer ${restarted.token}` } })).json();
    assert.equal(restored.ffmpegPath, ""); assert.equal(restored.ffprobePath, "");
    assert.equal(restored.configurationError, false); assert.equal(restored.restartRequired, false);
  } finally { await restarted.close(); }
});

test("project route helper validates revisions and scope for update/trash/restore", async t => {
  const store = new WorkspaceStore(":memory:"); t.after(() => store.close());
  const a = store.createAccount({ displayName: "Local", platform: "local" }), b = store.createAccount({ displayName: "Other", platform: "local" });
  const route = (method, path, input) => projectRoute(store, method, new URL(path, "http://127.0.0.1"), async () => input);
  const created = await route("POST", "/api/projects", { accountId: a.id, name: "Original", description: "Keep" });
  assert.equal(created.status, 201); const p = created.body, context = { accountId: a.id, projectId: p.id };
  const patch = { context, expectedRevision: 1, name: "Renamed", description: "Updated" };
  const updated = await route("PATCH", `/api/projects/${p.id}`, patch);
  assert.equal(updated.body.name, "Renamed"); assert.equal(updated.body.revision, 2);
  await assert.rejects(route("PATCH", `/api/projects/${p.id}`, patch), /revision_conflict/);
  await assert.rejects(route("PATCH", `/api/projects/${p.id}`, { ...patch, expectedRevision: 2, context: { accountId: b.id, projectId: p.id } }), /project_not_found/);
  await assert.rejects(route("DELETE", `/api/projects/${p.id}`, { context, expectedRevision: 0 }));
  await assert.rejects(route("GET", `/api/projects?accountId=${a.id}&state=all`));
  const deleted = await route("DELETE", `/api/projects/${p.id}`, { context, expectedRevision: 2 });
  assert.ok(deleted.body.deletedAt); assert.equal(deleted.body.revision, 3);
  assert.deepEqual((await route("GET", `/api/projects?accountId=${a.id}`)).body, []);
  assert.equal((await route("GET", `/api/projects?accountId=${a.id}&state=trashed`)).body[0].id, p.id);
  await assert.rejects(route("POST", `/api/projects/${p.id}/restore`, { context, expectedRevision: 2 }), /revision_conflict/);
  const restored = await route("POST", `/api/projects/${p.id}/restore`, { context, expectedRevision: 3 });
  assert.equal(restored.body.deletedAt, null); assert.equal(restored.body.revision, 4); assert.equal(restored.body.description, "Updated");
  assert.equal(await route("GET", "/api/unrelated"), null);
});

test("running API rejects deleted project scope across studio/AI/render/transcription/queue", async t => {
  const { call } = await fixture(t);
  const a = await (await call("/api/accounts", { method: "POST", body: JSON.stringify({ displayName: "Lifecycle", platform: "local" }) })).json();
  const p = await (await call("/api/projects", { method: "POST", body: JSON.stringify({ accountId: a.id, name: "Trash me", description: "" }) })).json();
  const context = { accountId: a.id, projectId: p.id }, artifactId = randomUUID();
  await call("/api/context", { method: "PUT", body: JSON.stringify(context) });
  const state = await (await call("/api/workspace")).json(), writer = new WorkspaceStore(join(state.dataDirectory, "atris-share.sqlite"));
  // The server owner mounts projectRoute; exercise the shared-store boundary in
  // the real HTTP runtime independently of that integration step.
  try { writer.trashProject(p.id, { context, expectedRevision: 1 }); } finally { writer.close(); }
  const query = new URLSearchParams(context);
  for (const path of [`/api/studio?${query}`, `/api/memory?${query}`, `/api/queue?${query}`, `/api/ai/runs?${query}&artifactId=${artifactId}`, `/api/media/${artifactId}/transcript?${query}`]) {
    const response = await call(path); assert.equal(response.status, 404, path); assert.equal((await response.json()).error, "context_not_found", path);
  }
  for (const [path, extra] of [["/api/context", {}], [`/api/media/${artifactId}/render`, { expectedRevision: 0 }], [`/api/media/${artifactId}/proxy`, {}], [`/api/media/${artifactId}/transcribe`, {}]]) {
    const response = await call(path, { method: path === "/api/context" ? "PUT" : "POST", body: JSON.stringify(path === "/api/context" ? context : { context, ...extra }) });
    assert.equal(response.status, 404, path); assert.equal((await response.json()).error, "context_not_found", path);
  }
  for (const [path, body] of [["/api/ai/grants", { context, destinationId: a.destinationId, artifactId, includeMemory: false }],
    ["/api/ai/runs", { context, destinationId: a.destinationId, artifactId, model: "controlled/model", prompt: "Never sent", includeMemory: false, allowRemote: true }]]) {
    const response = await call(path, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 404, path); assert.equal((await response.json()).error, "context_not_found", path);
  }
  const snapshot = await (await call("/api/workspace")).json();
  assert.deepEqual(snapshot.context, { accountId: a.id, projectId: null }); assert.deepEqual(snapshot.projects, []);
});
