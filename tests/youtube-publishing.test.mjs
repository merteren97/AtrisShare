import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { YouTubePublishing } from "../dist/services/local-api/src/youtube-publishing.js";
import { YouTubeService } from "../dist/services/local-api/src/youtube.js";
import { WorkspaceStore } from "../dist/packages/storage/src/store.js";
import { WorkspaceError } from "../dist/packages/storage/src/config.js";

const channel = `UC${"a".repeat(22)}`;
const otherChannel = `UC${"b".repeat(22)}`;
const video = "abcdefgh_-1";
const token = "synthetic-internal-token";
const sessionUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=synthetic-id";
const signal = () => new AbortController().signal;
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const metadata = { title: "Synthetic title", description: "Synthetic description", visibility: "private", madeForKids: false, notifySubscribers: false };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const errorCode = code => error => error instanceof WorkspaceError && error.code === code && error.message === code;
function transport(replies) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!new URL(url).searchParams.has("access_token"));
    calls.push({ url: new URL(url), init });
    assert.ok(replies.length, "Unexpected transport call (possible automatic retry)");
    const reply = replies.shift();
    return typeof reply === "function" ? reply(url, init) : reply;
  } };
}

test("catalog resolves the destination's official uploads playlist and returns only owned, bounded metadata", async () => {
  const item = (owner = channel, id = video) => ({
    snippet: { channelId: channel, videoOwnerChannelId: owner, title: "Owned video", description: "not exposed",
      publishedAt: "2026-10-20T00:00:00Z", thumbnails: { medium: { url: "https://i.ytimg.com/vi/abcdefgh_-1/mqdefault.jpg" } } },
    contentDetails: { videoId: id, videoPublishedAt: "2026-10-19T00:00:00Z" }
  });
  const deleted = item(); delete deleted.contentDetails.videoPublishedAt;
  const unsafeThumbnail = item(channel, "abcdefgh_-2");
  unsafeThumbnail.snippet.thumbnails.medium.url = "https://hostile.example/tracker";
  const t = transport([
    json({ items: [{ id: channel, contentDetails: { relatedPlaylists: { uploads: "UU_synthetic" } } }] }),
    json({ items: [item(), item(otherChannel), deleted, unsafeThumbnail], nextPageToken: "next-page" })
  ]);
  const result = await new YouTubePublishing(t.fetch).catalog(token, channel, "current-page", signal());
  assert.deepEqual(result, { items: [
    { id: video, title: "Owned video", publishedAt: "2026-10-19T00:00:00Z", thumbnail: "https://i.ytimg.com/vi/abcdefgh_-1/mqdefault.jpg" },
    { id: "abcdefgh_-2", title: "Owned video", publishedAt: "2026-10-19T00:00:00Z", thumbnail: null }
  ], nextPageToken: "next-page" });
  assert.equal(t.calls[0].url.origin, "https://www.googleapis.com");
  assert.equal(t.calls[0].url.pathname, "/youtube/v3/channels");
  assert.equal(t.calls[0].url.searchParams.get("id"), channel);
  assert.equal(t.calls[0].url.searchParams.get("part"), "contentDetails");
  assert.equal(t.calls[1].url.pathname, "/youtube/v3/playlistItems");
  assert.equal(t.calls[1].url.searchParams.get("playlistId"), "UU_synthetic");
  assert.equal(t.calls[1].url.searchParams.get("pageToken"), "current-page");
  assert.equal(t.calls[1].url.searchParams.get("maxResults"), "50");
});

test("catalog refuses mismatched, ambiguous and malformed uploads destinations before listing", async () => {
  for (const value of [
    { items: [] },
    { items: [{ id: otherChannel, contentDetails: { relatedPlaylists: { uploads: "UU_other" } } }] },
    { items: [{ id: channel, contentDetails: { relatedPlaylists: { uploads: "https://hostile.example" } } }] }
  ]) {
    const t = transport([json(value)]);
    await assert.rejects(new YouTubePublishing(t.fetch).catalog(token, channel, null, signal()), errorCode("youtube_invalid_response"));
    assert.equal(t.calls.length, 1);
  }
});

test("initiation sends explicit privacy, audience, notification and media metadata to videos.insert", async () => {
  for (const visibility of ["private", "unlisted", "public"]) {
    const t = transport([new Response(null, { status: 200, headers: { Location: sessionUrl } })]);
    const value = { ...metadata, visibility, madeForKids: visibility === "public", notifySubscribers: visibility === "public" };
    assert.equal(await new YouTubePublishing(t.fetch).initiate(token, value, 12345, "video/mp4", signal()), sessionUrl);
    const { url, init } = t.calls[0];
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, "/upload/youtube/v3/videos");
    assert.equal(url.searchParams.get("uploadType"), "resumable");
    assert.equal(url.searchParams.get("part"), "snippet,status");
    assert.equal(url.searchParams.get("notifySubscribers"), String(value.notifySubscribers));
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-Upload-Content-Length"], "12345");
    assert.equal(init.headers["X-Upload-Content-Type"], "video/mp4");
    assert.deepEqual(JSON.parse(init.body), { snippet: { title: value.title, description: value.description },
      status: { privacyStatus: visibility, selfDeclaredMadeForKids: value.madeForKids } });
  }
});

test("session URLs reject credential exfiltration hosts, paths, credentials, fragments and extra query fields", async () => {
  const invalid = [
    "http://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=x",
    sessionUrl.replace("www.googleapis.com", "www.googleapis.com.hostile.example"),
    sessionUrl.replace("www.googleapis.com", "hostile.example"),
    sessionUrl.replace("www.googleapis.com", "user:password@www.googleapis.com"),
    sessionUrl.replace("www.googleapis.com", "www.googleapis.com:443"),
    sessionUrl.replace("/upload/youtube/v3/videos", "/upload/other"),
    sessionUrl.replace("/upload/youtube/v3/videos", "/other/../upload/youtube/v3/videos"),
    sessionUrl.replace("uploadType=resumable", "uploadType=multipart"),
    sessionUrl.replace("upload_id=synthetic-id", "upload_id="),
    `${sessionUrl}&upload_id=another`, `${sessionUrl}&key=unexpected`, `${sessionUrl}#fragment`,
    sessionUrl.replace("synthetic-id", "%0Ainjection"), "//www.googleapis.com/upload/youtube/v3/videos"
  ];
  for (const url of invalid) {
    const t = transport([]);
    const p = new YouTubePublishing(t.fetch);
    await assert.rejects(p.query(token, url, 10, signal()), errorCode("youtube_invalid_session"));
    await assert.rejects(p.upload(token, url, Buffer.from("x"), 0, 1, signal()), errorCode("youtube_invalid_session"));
    assert.equal(t.calls.length, 0);
    const init = transport([new Response(null, { headers: { Location: url } })]);
    await assert.rejects(new YouTubePublishing(init.fetch).initiate(token, metadata, 1, "video/mp4", signal()), errorCode("youtube_invalid_session"));
  }
  const t = transport([new Response(null, { status: 308 })]);
  assert.deepEqual(await new YouTubePublishing(t.fetch).query(token, sessionUrl.replace("www.googleapis.com", "youtube.googleapis.com"), 10, signal()),
    { state: "incomplete", offset: 0 });
});

test("query and upload implement resumable byte ranges, final receipts and missing sessions", async () => {
  const t = transport([
    new Response(null, { status: 308 }),
    new Response(null, { status: 308, headers: { Range: "bytes=0-3", Location: "https://hostile.example/ignored" } }),
    json({ id: video }, 201), new Response(null, { status: 404 }), new Response(null, { status: 410 })
  ]);
  const p = new YouTubePublishing(t.fetch);
  assert.deepEqual(await p.query(token, sessionUrl, 10, signal()), { state: "incomplete", offset: 0 });
  assert.equal(t.calls[0].init.method, "PUT");
  assert.equal(t.calls[0].init.headers["Content-Length"], "0");
  assert.equal(t.calls[0].init.headers["Content-Range"], "bytes */10");
  assert.deepEqual(await p.upload(token, sessionUrl, Buffer.from("abcd"), 0, 10, signal()), { state: "incomplete", offset: 4 });
  assert.equal(t.calls[1].init.headers["Content-Range"], "bytes 0-3/10");
  assert.equal(t.calls[1].init.headers["Content-Length"], "4");
  assert.equal(Buffer.from(t.calls[1].init.body).toString(), "abcd");
  assert.deepEqual(await p.upload(token, sessionUrl, Buffer.from("efghij"), 4, 10, signal()), { state: "complete", videoId: video });
  assert.equal(t.calls[2].init.headers["Content-Range"], "bytes 4-9/10");
  assert.deepEqual(await p.query(token, sessionUrl, 10, signal()), { state: "missing" });
  assert.deepEqual(await p.query(token, sessionUrl, 10, signal()), { state: "missing" });
});

test("resumable receipts reject malformed/overflow ranges and invalid final IDs", async () => {
  for (const range of ["bytes=1-3", "bytes=0-10", "bytes=0--1", "bytes=0-1,4-5", "bytes=0-01", "bytes=0-9007199254740992", "nonsense"]) {
    const t = transport([new Response(null, { status: 308, headers: { Range: range } })]);
    await assert.rejects(new YouTubePublishing(t.fetch).query(token, sessionUrl, 10, signal()), errorCode("youtube_invalid_response"));
  }
  for (const id of ["", "too-short", "https://hostile.example", "abcdefghij!", "a".repeat(12)]) {
    const t = transport([json({ id })]);
    await assert.rejects(new YouTubePublishing(t.fetch).query(token, sessionUrl, 10, signal()), errorCode("youtube_invalid_response"));
  }
  const t = transport([new Response(null, { status: 308, headers: { Range: "bytes=0-9" } })]);
  assert.deepEqual(await new YouTubePublishing(t.fetch).query(token, sessionUrl, 10, signal()), { state: "incomplete", offset: 10 });
});

test("invalid byte arithmetic and metadata are rejected before transport", async () => {
  const t = transport([]);
  const p = new YouTubePublishing(t.fetch);
  for (const bytes of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(p.query(token, sessionUrl, bytes, signal()), errorCode("youtube_invalid_request"));
    await assert.rejects(p.initiate(token, metadata, bytes, "video/mp4", signal()), errorCode("youtube_invalid_request"));
  }
  for (const [buffer, offset, total] of [[Buffer.alloc(0), 0, 1], [Buffer.alloc(2), 0, 1], [Buffer.alloc(1), -1, 1], [Buffer.alloc(1), 0.5, 2], [Buffer.alloc(1), 2, 2]]) {
    await assert.rejects(p.upload(token, sessionUrl, buffer, offset, total, signal()), errorCode("youtube_invalid_request"));
  }
  await assert.rejects(p.initiate(token, { ...metadata, madeForKids: undefined }, 1, "video/mp4", signal()), errorCode("youtube_invalid_request"));
  await assert.rejects(p.initiate(token, metadata, 1, "video/mp4\r\nInjected: bad", signal()), errorCode("youtube_invalid_request"));
  assert.equal(t.calls.length, 0);
});

test("processing requires explicit provider success, never equates an upload receipt with publication", async () => {
  for (const [processingStatus, uploadStatus, expected] of [
    ["processing", "uploaded", "processing"], [undefined, "processed", "processing"],
    ["succeeded", "processed", "succeeded"], ["failed", "uploaded", "failed"],
    ["terminated", "uploaded", "failed"], ["succeeded", "rejected", "failed"], [undefined, "deleted", "failed"]
  ]) {
    const t = transport([json({ items: [{ id: video, status: { uploadStatus },
      ...(processingStatus ? { processingDetails: { processingStatus } } : {}) }] })]);
    assert.deepEqual(await new YouTubePublishing(t.fetch).processing(token, video, signal()),
      { state: expected, url: `https://www.youtube.com/watch?v=${video}` });
    assert.equal(t.calls[0].url.pathname, "/youtube/v3/videos");
    assert.equal(t.calls[0].url.searchParams.get("part"), "processingDetails,status");
    assert.equal(t.calls[0].url.searchParams.get("id"), video);
  }
});

test("response parsing is byte bounded, rejects invalid JSON and exposes only fixed status codes", async () => {
  for (const response of [new Response("not-json"), new Response("x".repeat(1024 * 1024 + 1)),
    new Response("{}", { headers: { "Content-Length": String(1024 * 1024 + 1) } })]) {
    const t = transport([response]);
    await assert.rejects(new YouTubePublishing(t.fetch).query(token, sessionUrl, 10, signal()), errorCode("youtube_invalid_response"));
  }
  for (const [status, code] of [[401, "youtube_reauth_required"], [403, "youtube_access_denied"], [429, "youtube_rate_limited"],
    [400, "youtube_request_failed"], [500, "youtube_upload_uncertain"], [408, "youtube_upload_uncertain"]]) {
    const t = transport([json({ error: { message: "synthetic-sensitive-provider-error" } }, status)]);
    await assert.rejects(new YouTubePublishing(t.fetch).query(token, sessionUrl, 10, signal()), errorCode(code));
    assert.equal(t.calls.length, 1);
  }
  const t = transport([new Response(null, { status: 307, headers: { Location: "https://hostile.example" } })]);
  await assert.rejects(new YouTubePublishing(t.fetch).initiate(token, metadata, 10, "video/mp4", signal()), errorCode("youtube_redirect_rejected"));
  assert.equal(t.calls.length, 1);
});

test("upload network errors and timeouts are uncertain, combined with caller abort, and never automatically retried", async t => {
  const network = transport([() => { throw new Error("synthetic-sensitive-network-error"); }]);
  await assert.rejects(new YouTubePublishing(network.fetch).initiate(token, metadata, 10, "video/mp4", signal()), errorCode("youtube_upload_uncertain"));
  assert.equal(network.calls.length, 1);
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", milliseconds => { assert.equal(milliseconds, 30_000); return timeout.signal; });
  const started = deferred();
  const pending = transport([(_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    started.resolve();
  })]);
  const query = new YouTubePublishing(pending.fetch).query(token, sessionUrl, 10, signal());
  await started.promise;
  timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
  await assert.rejects(query, errorCode("youtube_upload_uncertain"));
  assert.equal(pending.calls.length, 1);
  const aborted = new AbortController(); aborted.abort();
  const none = transport([]);
  await assert.rejects(new YouTubePublishing(none.fetch).upload(token, sessionUrl, Buffer.from("x"), 0, 1, aborted.signal), errorCode("youtube_upload_uncertain"));
  assert.equal(none.calls.length, 0);
});

test("a stalled response body observes cancellation and preserves upload uncertainty", async () => {
  const caller = new AbortController();
  const reading = deferred();
  const body = new ReadableStream({ pull() { reading.resolve(); } });
  const t = transport([new Response(body)]);
  const pending = new YouTubePublishing(t.fetch).query(token, sessionUrl, 10, caller.signal);
  await reading.promise;
  caller.abort();
  await assert.rejects(pending, errorCode("youtube_upload_uncertain"));
});

function verifiedFixture(t, shared = false) {
  const directory = shared ? mkdtempSync(join(tmpdir(), "atris-share-verified-")) : null;
  const store = new WorkspaceStore(directory ? join(directory, "workspace.sqlite") : ":memory:");
  const scopes = ["openid", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"];
  const saved = { clientId: "synthetic.apps.googleusercontent.com", accessToken: "synthetic-old-token", refreshToken: "synthetic-refresh",
    expiresAt: 0, scopes };
  const secrets = new Map([["synthetic-old-ref", JSON.stringify(saved)]]);
  const input = { accountId: randomUUID(), destinationId: channel };
  const connection = store.connectYouTube({ ...input, displayName: "Synthetic channel", providerSubjectId: "synthetic-subject",
    credentialRef: "synthetic-old-ref", grantedScopes: scopes, expectedRevision: null });
  const control = { channels: [{ id: channel, title: "Synthetic channel" }], subject: "synthetic-subject",
    get: null, tokens: null, identity: null, set: null, delete: null, revocations: 0 };
  const vault = { status: { available: true, provider: "windows-dpapi" },
    async get(ref) { if (control.get) await control.get(); return secrets.get(ref); },
    async set(ref, value) { secrets.set(ref, value); if (control.set) await control.set(); },
    async delete(ref) { if (control.delete) await control.delete(ref); secrets.delete(ref); } };
  const provider = {
    async tokens(_client, fields, operationSignal) {
      assert.equal(fields.grant_type, "refresh_token");
      assert.equal(fields.refresh_token, "synthetic-refresh");
      assert.ok(operationSignal instanceof AbortSignal);
      if (control.tokens) await control.tokens();
      return { access_token: token, token_type: "Bearer", expires_in: 3600 };
    },
    scopes(_tokens, previous) { return previous; },
    async identity(accessToken) {
      assert.equal(accessToken, token);
      if (control.identity) await control.identity();
      return { subject: control.subject, channels: control.channels };
    },
    async revoke(refreshToken, operationSignal) {
      assert.equal(refreshToken, "synthetic-refresh");
      assert.equal(operationSignal.aborted, false);
      control.revocations++;
    }
  };
  const service = new YouTubeService(store, vault, { client: null, provider });
  const peerStore = directory ? new WorkspaceStore(join(directory, "workspace.sqlite")) : null;
  const peer = peerStore ? new YouTubeService(peerStore, vault, { client: null, provider }) : null;
  t.after(async () => {
    await service.close(); await peer?.close(); store.close(); peerStore?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  return { store, secrets, input, connection, control, service, peer, peerStore };
}

test("withVerified refreshes and CAS-persists credentials before running an internal callback", async t => {
  const f = verifiedFixture(t);
  const result = await f.service.withVerified(f.input, async (accessToken, operationSignal) => {
    assert.equal(accessToken, token);
    assert.equal(operationSignal.aborted, false);
    const current = f.store.getYouTubeConnection(f.input.accountId, channel);
    assert.equal(current.revision, f.connection.revision + 1);
    assert.equal(JSON.parse(f.secrets.get(current.credentialRef)).accessToken, token);
    assert.equal(JSON.parse(f.secrets.get(current.credentialRef)).refreshToken, "synthetic-refresh");
    return { internalOperation: "done" };
  });
  assert.deepEqual(result, { internalOperation: "done" });
  assert.equal(f.secrets.size, 1);
  assert.ok(!JSON.stringify(f.store.listAccounts()).includes(token));
  assert.ok(!JSON.stringify(f.store.listAccounts()).includes("credentialRef"));
});

test("upload verification requires exactly one matching channel while ordinary verify retains multi-channel semantics", async t => {
  const f = verifiedFixture(t);
  f.control.channels.push({ id: otherChannel, title: "Other channel" });
  assert.deepEqual(await f.service.verify(f.input), { verified: true });
  let called = false;
  await assert.rejects(f.service.withVerified(f.input, async () => { called = true; }), errorCode("youtube_channel_mismatch"));
  assert.equal(called, false);
  assert.equal(f.store.listAccounts()[0].status, "reauth-required");
});

test("withVerified fences stale or disconnected connections at every asynchronous credential boundary", async t => {
  for (const boundary of ["get", "tokens", "identity", "set", "delete"]) await t.test(boundary, async t => {
    const f = verifiedFixture(t);
    const entered = deferred(); const release = deferred();
    f.control[boundary] = async () => { entered.resolve(); await release.promise; };
    let called = false;
    const pending = f.service.withVerified(f.input, async () => { called = true; });
    await entered.promise;
    const latest = f.store.getYouTubeConnection(f.input.accountId, channel);
    f.store.setYouTubeStatus(latest, "disconnected");
    release.resolve();
    await assert.rejects(pending, errorCode("connection_conflict"));
    assert.equal(called, false);
    assert.equal(f.store.listAccounts()[0].status, "disconnected");
    if (boundary === "set") assert.equal(f.secrets.size, 1, "Losing vault generation must be removed");
  });
});

test("withVerified holds the account lock through the callback and shutdown aborts/tracks that callback", async t => {
  const f = verifiedFixture(t);
  const entered = deferred(); const release = deferred();
  let callbackSignal;
  assert.equal(f.service.isBusy(f.input.accountId), false);
  const pending = f.service.withVerified(f.input, async (_accessToken, operationSignal) => {
    callbackSignal = operationSignal; entered.resolve(); await release.promise; return "finished";
  });
  assert.equal(f.service.isBusy(f.input.accountId), true);
  await entered.promise;
  assert.equal(f.service.isBusy(f.input.accountId), true);
  assert.equal(f.service.isBusy(randomUUID()), false);
  await assert.rejects(f.service.verify(f.input), errorCode("connection_conflict"));
  await assert.rejects(f.service.disconnect(f.input, false), errorCode("connection_conflict"));
  let closed = false;
  const close = f.service.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(callbackSignal.aborted, true);
  assert.equal(closed, false);
  release.resolve();
  assert.equal(await pending, "finished");
  assert.equal(f.service.isBusy(f.input.accountId), false);
  await close;
  assert.equal(closed, true);
});

test("callback failures do not mutate verified account identity and release the lock", async t => {
  const f = verifiedFixture(t);
  await assert.rejects(f.service.withVerified(f.input, async () => { throw new WorkspaceError(403, "youtube_access_denied"); }), errorCode("youtube_access_denied"));
  assert.equal(f.service.isBusy(f.input.accountId), false);
  assert.equal(f.store.listAccounts()[0].status, "connected");
  assert.equal(await f.service.withVerified(f.input, async () => "retry"), "retry");
});

test("callback guard stays valid after persistence and across awaits for an unchanged connection", { timeout: 5000 }, async t => {
  const f = verifiedFixture(t);
  const result = await f.service.withVerified(f.input, async (accessToken, operationSignal, guard) => {
    const persisted = f.store.getYouTubeConnection(f.input.accountId, channel);
    assert.notEqual(persisted.credentialRef, f.connection.credentialRef);
    assert.equal(persisted.revision, f.connection.revision + 1);
    assert.equal(accessToken, token);
    assert.equal(operationSignal.aborted, false);
    assert.equal(guard(), undefined);
    await Promise.resolve();
    assert.equal(guard(), undefined);
    return "guarded";
  });
  assert.equal(result, "guarded");
  assert.equal(f.service.isBusy(f.input.accountId), false);
});

test("callback guard blocks the next chunk after another runtime disconnects, revokes or refreshes", { timeout: 10_000 }, async t => {
  for (const action of ["disconnect", "revoke", "refresh"]) await t.test(action, { timeout: 3000 }, async t => {
    const f = verifiedFixture(t, true);
    const entered = deferred(); const release = deferred();
    const tx = transport([
      new Response(null, { headers: { Location: sessionUrl } }),
      new Response(null, { status: 308, headers: { Range: "bytes=0-3" } })
    ]);
    const publishing = new YouTubePublishing(tx.fetch);
    let verified;
    const pending = f.service.withVerified(f.input, async (accessToken, operationSignal, guard) => {
      verified = f.store.getYouTubeConnection(f.input.accountId, channel);
      guard();
      const url = await publishing.initiate(accessToken, metadata, 8, "video/mp4", operationSignal);
      guard();
      await publishing.upload(accessToken, url, Buffer.from("abcd"), 0, 8, operationSignal);
      entered.resolve();
      await release.promise;
      assert.equal(operationSignal.aborted, false, "A different runtime does not abort the local signal");
      guard();
      await publishing.upload(accessToken, url, Buffer.from("efgh"), 4, 8, operationSignal);
    });
    const rejected = assert.rejects(pending, errorCode("connection_conflict"));
    t.after(() => release.resolve());
    try {
      await entered.promise;
      assert.notEqual(f.store, f.peerStore);
      assert.equal(f.service.isBusy(f.input.accountId), true);
      assert.equal(f.peer.isBusy(f.input.accountId), false);
      if (action === "refresh") await f.peer.verify(f.input);
      else await f.peer.disconnect(f.input, action === "revoke");
      const latest = f.peerStore.getYouTubeConnection(f.input.accountId, channel);
      assert.ok(latest.revision > verified.revision);
      assert.notEqual(latest.credentialRef, verified.credentialRef);
      assert.equal(f.control.revocations, action === "revoke" ? 1 : 0);
    } finally { release.resolve(); }
    await rejected;
    assert.equal(tx.calls.length, 2, "No chunk is sent with the fenced token");
    assert.equal(f.service.isBusy(f.input.accountId), false);
    assert.equal(f.store.listAccounts()[0].status, action === "refresh" ? "connected" : "disconnected");
  });
});

test("callback guard observes shutdown after an await and releases the busy lock", { timeout: 5000 }, async t => {
  const f = verifiedFixture(t);
  const entered = deferred(); const release = deferred();
  const pending = f.service.withVerified(f.input, async (_accessToken, _signal, guard) => {
    guard(); entered.resolve();
    await release.promise;
    guard();
  });
  const rejected = assert.rejects(pending, errorCode("runtime_closing"));
  t.after(() => release.resolve());
  await entered.promise;
  const close = f.service.close();
  assert.equal(f.service.isBusy(f.input.accountId), true);
  release.resolve();
  await rejected;
  await close;
  assert.equal(f.service.isBusy(f.input.accountId), false);
});
