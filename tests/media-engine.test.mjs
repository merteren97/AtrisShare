import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { editSchema, mediaProbeSchema, segmentSchema } from "../dist/packages/domain/src/media.js";
import { MediaEngine } from "../dist/packages/media-engine/src/index.js";

// Real 64x48 VP8 WebM recorded from a solid-colour Chromium canvas with MediaRecorder.
// Kept inline so import/container/hash tests do not need a binary tool or downloaded fixture.
const WEBM = Buffer.from("GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAFYEU2bdLlNu4tTq4QVSalmU6yBbk27i1OrhBZUrmtTrIGTTbuLU6uEH0O2dVOsgdRNu4xTq4QcU7trU6yCAUbsrgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBEiYQ/gAAATYCGQ2hyb21lV0GGQ2hyb21lFlSua7yuuteBAXPFhxUDkZpDbS6DgQFV7oEBhoVWX1ZQOOCdsIFAuoEwU8CBAVWwkFWxgQFVuYECVbqBDVW7gQEfQ7Z1AQAAAAAAAGbngQCg4aGygQAAANACAJ0BKkAAMAAHBwiFhYiZhIglggJ08ma4vPMx5vpA/m8dWWohyP9feUOxJgB1oaqmqO6BAaWjsAIAnQEqQAAwAAqHCIWFiJmEiDgCAAaOT8zHm/FYAP7rrgAcU7trjbuLs4EAt4b3gQHxgdQ=", "base64");
const SHA = createHash("sha256").update(WEBM).digest("hex");
const PROBE = { duration: 4, width: 320, height: 240, hasAudio: true };
const EDIT = { inSeconds: 0.5, outSeconds: 2.5, crop: "vertical", gainDb: -6, caption: "" };
const missing = { ffmpegPath: join(tmpdir(), `absent-ffmpeg-${randomUUID()}`), ffprobePath: join(tmpdir(), `absent-ffprobe-${randomUUID()}`) };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atris-share-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, engine: new MediaEngine(directory, { ...missing, ...options }) };
}
async function noPartials(directory) {
  const files = await readdir(join(directory, "media"));
  assert.ok(files.every(name => /^[0-9a-f-]{36}\.mp4$/u.test(name)), `Unexpected partial files: ${files}`);
}
function box(kind, ...parts) {
  const data = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length + 8);
  header.write(kind, 4, "latin1");
  return Buffer.concat([header, data]);
}
// Structural MP4, deliberately not presented as a decodable video fixture.
function referenceMp4(reference) {
  const full = Buffer.alloc(8); full.writeUInt32BE(1, 4);
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isom")),
    box("moov", box("trak", box("mdia", box("minf", box("dinf", box("dref", full, reference)))))),
    box("mdat", Buffer.from([0, 1, 2, 3]))]);
}

/** Real child lifecycle with synthetic tool responses, never a mock successful render. */
function injected(onRender, records = []) {
  return (tool, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.ok(Object.keys(options.env).every(key => /^(path|systemroot|temp|tmp|tmpdir)$/iu.test(key)));
    const kind = tool === "test-ffmpeg" ? "ffmpeg" : "ffprobe";
    const script = args.includes("-version") ? `console.log('${kind} version test');` : kind === "ffprobe"
      ? `console.log(${JSON.stringify(JSON.stringify({ format: { duration: String(PROBE.duration) }, streams: [
        { codec_type: "video", width: PROBE.width, height: PROBE.height }, { codec_type: "audio" }
      ] }))});` : onRender(args, options);
    const child = nodeSpawn(process.execPath, ["-e", script], options);
    records.push({ tool: kind, args, options, child });
    return child;
  };
}
const injectedPaths = { ffmpegPath: "test-ffmpeg", ffprobePath: "test-ffprobe" };

test("media schemas reject nonfinite probes, reversed trims and unsafe edit values", () => {
  assert.deepEqual(mediaProbeSchema.parse(PROBE), PROBE);
  assert.deepEqual(editSchema.parse(EDIT), EDIT);
  for (const probe of [{ ...PROBE, duration: Infinity }, { ...PROBE, width: 0 }, { ...PROBE, height: 20000 }, { ...PROBE, extra: true }]) {
    assert.equal(mediaProbeSchema.safeParse(probe).success, false);
  }
  for (const edit of [{ ...EDIT, outSeconds: 0.1 }, { ...EDIT, inSeconds: -1 }, { ...EDIT, gainDb: 25 },
    { ...EDIT, caption: "bad\0text" }, { ...EDIT, crop: "dynamic-filter" }, { ...EDIT, inSeconds: NaN }, { ...EDIT, extra: true }]) {
    assert.equal(editSchema.safeParse(edit).success, false);
  }
});

test("segments are optional, bounded, chronological source ranges within the unchanged envelope", () => {
  const segments = [{ inSeconds: 0.5, outSeconds: 1 }, { inSeconds: 2, outSeconds: 2.5 }];
  assert.deepEqual(editSchema.parse({ ...EDIT, segments }), { ...EDIT, segments });
  assert.deepEqual(editSchema.parse({ ...EDIT, segments: undefined }).segments, undefined);
  assert.equal(editSchema.safeParse({ ...EDIT, inSeconds: 0, outSeconds: 0.001 }).success, true);
  assert.equal(segmentSchema.safeParse({ inSeconds: 0, outSeconds: 0.001 }).success, true);
  assert.equal(editSchema.safeParse({ ...EDIT, segments: [{ inSeconds: 0.5, outSeconds: 1 }, { inSeconds: 1, outSeconds: 2.5 }] }).success, true);
  const maximum = Array.from({ length: 32 }, (_, i) => ({ inSeconds: i / 32, outSeconds: (i + 1) / 32 }));
  assert.equal(editSchema.safeParse({ ...EDIT, inSeconds: 0, outSeconds: 1, segments: maximum }).success, true);
  for (const invalidSegments of [[], [...maximum, { inSeconds: 1, outSeconds: 1.01 }],
    [{ inSeconds: 0, outSeconds: 1 }], [{ inSeconds: 1, outSeconds: 3 }],
    [{ inSeconds: 1, outSeconds: 1 }], [{ inSeconds: 2, outSeconds: 1 }],
    [{ inSeconds: NaN, outSeconds: 1 }], [{ inSeconds: 1, outSeconds: Infinity }],
    [{ inSeconds: 0.5, outSeconds: 1.5 }, { inSeconds: 1, outSeconds: 2 }],
    [...segments].reverse(), [{ inSeconds: 0.5, outSeconds: 1, sourceId: randomUUID() }]]) {
    assert.equal(editSchema.safeParse({ ...EDIT, segments: invalidSegments }).success, false, JSON.stringify(invalidSegments));
  }
});

test("real WebM import hashes streamed bytes, uses content MIME and a managed UUID path", async t => {
  const { engine, directory } = await fixture(t);
  const id = randomUUID();
  const result = await engine.import(id, Readable.from([WEBM.subarray(0, 37), WEBM.subarray(37)]), "C:\\fakepath\\a\"b.MP4");
  assert.deepEqual(result, { id, filename: "a_b.mp4", sha256: SHA, bytes: WEBM.length, mimeType: "video/webm", probe: null });
  assert.equal(engine.path(id.toUpperCase()), join(directory, "media", `${id}.mp4`));
  assert.deepEqual(await readFile(engine.path(id)), WEBM);
  assert.equal(await engine.verify(id, SHA.toUpperCase()), true);
  assert.equal(await engine.verify(id, "0".repeat(64)), false);
  assert.equal(await engine.verify(id, "not-a-hash"), false);
  await writeFile(engine.path(id), Buffer.from("tampered"));
  assert.equal(await engine.verify(id, SHA), false);
  await engine.remove(id);
  await engine.remove(id);
  assert.equal(await engine.verify(id, SHA), false);
  await noPartials(directory);
});

test("strict UUIDs reject traversal, nil IDs, alternate encodings and source overwrite", async t => {
  const { engine } = await fixture(t);
  for (const id of ["../escape", "a/b", "%2e%2e", `${randomUUID()}.mp4`, "00000000-0000-0000-0000-000000000000", "00000000-0000-4000-0000-000000000000", "C:\\escape", "", `${randomUUID()}\n`]) {
    assert.throws(() => engine.path(id), /invalid_media_id/u);
    await assert.rejects(engine.import(id, Readable.from([WEBM]), "source.webm"), /invalid_media_id/u);
    await assert.rejects(engine.verify(id, SHA), /invalid_media_id/u);
    await assert.rejects(engine.inspect(id), /invalid_media_id/u);
    await assert.rejects(engine.remove(id), /invalid_media_id/u);
    await assert.rejects(engine.render(id, randomUUID(), EDIT, () => {}, new AbortController().signal), /invalid_media_id/u);
    await assert.rejects(engine.render(randomUUID(), id, EDIT, () => {}, new AbortController().signal), /invalid_media_id/u);
    await assert.rejects(engine.proxy(id, randomUUID(), () => {}, new AbortController().signal), /invalid_media_id/u);
    await assert.rejects(engine.proxy(randomUUID(), id, () => {}, new AbortController().signal), /invalid_media_id/u);
  }
  const id = randomUUID();
  await engine.import(id, Readable.from([WEBM]), "source.webm");
  await assert.rejects(engine.render(id, id.toUpperCase(), EDIT, () => {}, new AbortController().signal), /media_source_is_immutable/u);
  await assert.rejects(engine.proxy(id, id.toUpperCase(), () => {}, new AbortController().signal), /media_source_is_immutable/u);
  assert.equal(await engine.verify(id, SHA), true);
});

test("exclusive concurrent finalization preserves exactly one immutable original", async t => {
  const { engine, directory } = await fixture(t);
  const id = randomUUID();
  const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => engine.import(id, Readable.from([WEBM]), "source.webm")));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.find(result => result.status === "rejected").reason.code, "EEXIST");
  assert.equal(await engine.verify(id, SHA), true);
  await noPartials(directory);
});

test("invalid bytes, playlists and external MP4/WebM references are rejected before any tool executes", async t => {
  const { engine, directory } = await fixture(t, { spawn: () => { throw new Error("must_not_spawn"); } });
  const url = box("url ", Buffer.alloc(4), Buffer.from("file:///private/secret\0"));
  const externalWebm = Buffer.from(WEBM);
  // Replace a real Info child (TimecodeScale, three-byte ID) with PrevFilename of the same size.
  const at = externalWebm.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  assert.ok(at > 0);
  Buffer.from([0x3c, 0x83, 0xab]).copy(externalWebm, at);
  for (const data of [Buffer.from("not a video, despite the extension"), Buffer.from("#EXTM3U\n#EXTINF:1\nfile:///etc/passwd\n"),
    Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n"), Buffer.from("<MPD><BaseURL>https://example.invalid/</BaseURL></MPD>"),
    referenceMp4(url), externalWebm, WEBM.subarray(0, 60)]) {
    await assert.rejects(engine.import(randomUUID(), Readable.from([data]), "source.mp4"), /invalid_media_container|external_media_reference/u);
  }
  await assert.rejects(engine.import(randomUUID(), Readable.from([WEBM]), "source.m3u8"), /unsupported_media_extension/u);
  assert.deepEqual(await readdir(join(directory, "media")), []);
});

test("self-contained MP4 references are accepted structurally; extension never decides the container", async t => {
  const { engine } = await fixture(t);
  const selfContained = Buffer.alloc(4); selfContained.writeUInt32BE(1);
  const bytes = referenceMp4(box("url ", selfContained));
  const result = await engine.import(randomUUID(), Readable.from([bytes]), "CON.webm");
  assert.equal(result.mimeType, "video/mp4");
  assert.equal(result.filename, "media_CON.webm");
  assert.equal(result.probe, null);
});

test("unknown-sized WebM clusters cannot hide later external reference metadata", async t => {
  const { engine, directory } = await fixture(t);
  const live = Buffer.from(WEBM);
  const cluster = live.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
  const segment = live.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  assert.ok(cluster > 0 && segment > 0);
  // This fixture uses eight-byte sizes for both the segment and cluster.
  const unknown = Buffer.from([1, 255, 255, 255, 255, 255, 255, 255]);
  unknown.copy(live, segment + 4); unknown.copy(live, cluster + 4);
  const result = await engine.import(randomUUID(), Readable.from([live]), "live.webm");
  assert.equal(result.mimeType, "video/webm");
  // Info(size=5) -> PrevFilename(size=1, 'x'), placed after the live cluster and cues.
  const external = Buffer.concat([live, Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x85, 0x3c, 0x83, 0xab, 0x81, 0x78])]);
  await assert.rejects(engine.import(randomUUID(), Readable.from([external]), "source.webm"), /external_media_reference/u);
  await noPartials(directory);
});

test("bounded streaming, stream errors and cancellation leave no final or partial files", async t => {
  const { engine, directory } = await fixture(t, { maxImportBytes: WEBM.length - 1 });
  await assert.rejects(engine.import(randomUUID(), Readable.from([WEBM]), "source.webm"), /media_size_limit/u);
  const normal = new MediaEngine(directory, missing);
  const controller = new AbortController();
  const input = Readable.from((async function* () {
    yield WEBM.subarray(0, 128);
    await delay(20);
    controller.abort();
    yield WEBM.subarray(128);
  })());
  await assert.rejects(normal.import(randomUUID(), input, "source.webm", controller.signal), { name: "AbortError" });
  assert.equal(input.destroyed, true);
  await assert.rejects(normal.import(randomUUID(), Readable.from((async function* () {
    yield WEBM.subarray(0, 64); throw new Error("input_failed");
  })()), "source.webm"), /input_failed/u);
  const already = AbortSignal.abort();
  await assert.rejects(normal.import(randomUUID(), Readable.from([WEBM]), "source.webm", already), { name: "AbortError" });
  assert.deepEqual(await readdir(join(directory, "media")), []);
  assert.throws(() => new MediaEngine(directory, { maxImportBytes: 2 * 1024 ** 3 + 1 }), /invalid_media_limit/u);
});

test("missing tools are unavailable, imports remain real, inspect/render never fabricate results", async t => {
  const { engine, directory } = await fixture(t);
  assert.deepEqual(await engine.status(), { available: false, ffmpeg: false, ffprobe: false });
  const source = await engine.import(randomUUID(), Readable.from([WEBM]), "source.webm");
  assert.equal(source.probe, null);
  await assert.rejects(engine.inspect(source.id), /media_tool_unavailable: ffprobe/u);
  await assert.rejects(engine.render(source.id, randomUUID(), EDIT, () => {}, new AbortController().signal), /media_tool_unavailable: ffprobe/u);
  await assert.rejects(engine.proxy(source.id, randomUUID(), () => {}, new AbortController().signal), /media_tool_unavailable: ffprobe/u);
  await noPartials(directory);
});

test("status coalesces polling, caches for 15 seconds and retries failed tool checks after expiry", async t => {
  let now = 100000, healthy = true, launches = 0;
  t.mock.method(Date, "now", () => now);
  const { engine } = await fixture(t, { ...injectedPaths, spawn: (tool, args, options) => {
    launches++;
    assert.deepEqual(args, ["-version"]);
    const kind = tool === "test-ffmpeg" ? "ffmpeg" : "ffprobe";
    return nodeSpawn(process.execPath, ["-e", healthy ? `console.log('${kind} version test')` : "process.exitCode=1"], options);
  } });
  const available = { available: true, ffmpeg: true, ffprobe: true };
  const unavailable = { available: false, ffmpeg: false, ffprobe: false };
  const snapshots = await Promise.all(Array.from({ length: 12 }, () => engine.status()));
  assert.ok(snapshots.every(value => JSON.stringify(value) === JSON.stringify(available)));
  assert.equal(launches, 2);
  snapshots[0].ffmpeg = false;
  now += 14999;
  assert.deepEqual(await engine.status(), available, "callers cannot mutate cached status");
  assert.equal(launches, 2);
  healthy = false; now++;
  assert.deepEqual(await engine.status(), unavailable);
  assert.equal(launches, 4);
  healthy = true;
  assert.deepEqual(await engine.status(), unavailable);
  assert.equal(launches, 4, "failed checks are also bounded during snapshot polling");
  now += 15000;
  assert.deepEqual(await engine.status(), available);
  assert.equal(launches, 6);
});

test("probe process has a sanitized environment and closed input protocols; rotation uses display dimensions", async t => {
  const records = [];
  const { engine, directory } = await fixture(t, { ...injectedPaths, spawn: injected(() => "process.exit(2)", records) });
  assert.deepEqual(await engine.status(), { available: true, ffmpeg: true, ffprobe: true });
  const source = await engine.import(randomUUID(), Readable.from([WEBM]), "source.mkv");
  assert.deepEqual(source.probe, PROBE);
  assert.deepEqual(await engine.inspect(source.id), PROBE);
  const args = records.find(record => record.args.includes("-show_entries")).args;
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
  assert.equal(args[args.indexOf("-f") + 1], "matroska");
  // Select only stream side data; FFprobe 4.x lacks the stream_side_data child alias.
  assert.equal(args[args.indexOf("-show_entries") + 1], "format=duration,start_time:stream=codec_type,width,height,duration:stream_tags=rotate:stream_side_data_list");
  const displayEngine = new MediaEngine(directory, { ...injectedPaths, spawn: (_tool, _argv, options) => {
    return nodeSpawn(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify({ format: { duration: "2" }, streams: [
      { codec_type: "video", width: 320, height: 240, side_data_list: [{ rotation: -90 }] }
    ] }))})`], options);
  } });
  assert.deepEqual(await displayEngine.inspect(source.id), { duration: 2, width: 240, height: 320, hasAudio: false });
});

test("a present but failing or invalid probe rejects import and cleans up instead of returning null", async t => {
  const { directory } = await fixture(t);
  for (const script of ["process.stderr.write('invalid stream');process.exitCode=1", "console.log('not json')",
    "console.log(JSON.stringify({streams:[]}))", "console.log(JSON.stringify({format:{duration:'NaN'},streams:[{codec_type:'video',width:64,height:48}]}))"]) {
    const engine = new MediaEngine(directory, { ...injectedPaths, spawn: (_tool, _args, options) => nodeSpawn(process.execPath, ["-e", script], options) });
    await assert.rejects(engine.import(randomUUID(), Readable.from([WEBM]), "source.webm"));
    assert.deepEqual(await readdir(join(directory, "media")), []);
  }
});

test("import cancellation during probe waits for the child before deleting its temporary input", async t => {
  const { directory } = await fixture(t);
  const controller = new AbortController();
  let child;
  const engine = new MediaEngine(directory, { ...injectedPaths, spawn: (_tool, _args, options) => {
    child = nodeSpawn(process.execPath, ["-e", "process.stdout.write('started');setInterval(()=>{},1000)"], options);
    child.stdout.once("data", () => controller.abort());
    return child;
  } });
  await assert.rejects(engine.import(randomUUID(), Readable.from([WEBM]), "source.webm", controller.signal), { name: "AbortError" });
  assert.equal(child.killed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.deepEqual(await readdir(join(directory, "media")), []);
});

test("timeout/output flood kill and reap real children before cleanup", async t => {
  const { engine, directory } = await fixture(t);
  const source = await engine.import(randomUUID(), Readable.from([WEBM]), "source.webm");
  for (const [script, expected, options] of [
    ["setInterval(()=>{},1000)", /media_tool_timeout/u, { processTimeoutMs: 500 }],
    ["process.stdout.write('x'.repeat(16384));setInterval(()=>{},1000)", /media_tool_output_limit/u, { maxOutputBytes: 1024 }]
  ]) {
    let child;
    const limited = new MediaEngine(directory, { ...injectedPaths, ...options, spawn: (_tool, _args, spawnOptions) => {
      child = nodeSpawn(process.execPath, ["-e", script], spawnOptions); return child;
    } });
    await assert.rejects(limited.inspect(source.id), expected);
    assert.equal(child.killed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
  assert.equal(await engine.verify(source.id, SHA), true);
});

test("render uses static caption textfile, bounded trim/crop/gain and explicit H264/AAC; codec errors propagate", async t => {
  const records = [];
  const caption = "literal ' : ; [x] , \\ %{eif:1} 日本語\nsecond line";
  const wrapped = "literal '\n: ; [x] ,\n\\ %{eif:1}\n日本語\nsecond\nline";
  const { engine, directory } = await fixture(t, { ...injectedPaths, spawn: injected((args, options) => {
    assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
    assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
    assert.equal(args[args.indexOf("-c:a") + 1], "aac");
    assert.equal(args[args.indexOf("-af") + 1], "volume=-6dB");
    assert.match(args[args.indexOf("-vf") + 1], /crop=126:224:.*textfile=caption.txt:expansion=none/u);
    assert.match(args[args.indexOf("-vf") + 1], /fontsize=10:line_spacing=4/u);
    assert.ok(!args[args.indexOf("-vf") + 1].includes("%{"));
    assert.ok(args.every(arg => !arg.includes(caption)));
    // Read the actual file in the child; failure still must propagate and leave no output.
    return `const fs=require('node:fs');if(fs.readFileSync(${JSON.stringify(join(options.cwd, "caption.txt"))},'utf8')!==${JSON.stringify(wrapped)})throw Error('caption changed');process.stderr.write('Unknown encoder libx264');process.exitCode=1;`;
  }, records) });
  const source = await engine.import(randomUUID(), Readable.from([WEBM]), "source.webm");
  await assert.rejects(engine.render(source.id, randomUUID(), { ...EDIT, caption }, () => {}, new AbortController().signal), /media_ffmpeg_failed: Unknown encoder libx264/u);
  await assert.rejects(engine.render(source.id, randomUUID(), { ...EDIT, outSeconds: 5 }, () => {}, new AbortController().signal), /media_trim_out_of_bounds/u);
  assert.equal(records.filter(record => record.tool === "ffmpeg").length, 1);
  assert.equal(await engine.verify(source.id, SHA), true);
  await noPartials(directory);
});

test("captions exceeding the output text region reject before encoding and leave no partial files", async t => {
  const records = [];
  const { engine, directory } = await fixture(t, { ...injectedPaths, spawn: injected(() => { throw new Error("must_not_encode"); }, records) });
  const source = await engine.import(randomUUID(), Readable.from([WEBM]), "source.webm");
  for (const caption of ["word ".repeat(200), "W".repeat(1000), "\n".repeat(20), `e${"\u0301".repeat(40)}`]) {
    const outputId = randomUUID();
    await assert.rejects(engine.render(source.id, outputId, { ...EDIT, caption }, () => {}, new AbortController().signal), /media_caption_does_not_fit/u);
    await assert.rejects(readFile(engine.path(outputId)), { code: "ENOENT" });
    await noPartials(directory);
  }
  assert.equal(records.filter(record => record.tool === "ffmpeg").length, 0);
  assert.equal(await engine.verify(source.id, SHA), true);
});

test("render progress is monotonic, cancellation kills/reaps child and cleans partial output", async t => {
  const records = [];
  const { engine, directory } = await fixture(t, { ...injectedPaths, spawn: injected((args) => {
    return `require('node:fs').writeFileSync(${JSON.stringify(args.at(-1))},'partial');process.stdout.write('out_time_us=1000000\\nout_time_us=500000\\n');setInterval(()=>{},1000);`;
  }, records) });
  const source = await engine.import(randomUUID(), Readable.from([WEBM]), "source.webm");
  const controller = new AbortController(), progress = [];
  const outputId = randomUUID();
  await assert.rejects(engine.render(source.id, outputId, EDIT, value => {
    progress.push(value); if (value > 0) controller.abort();
  }, controller.signal), { name: "AbortError" });
  assert.deepEqual(progress, [0, 0.5]);
  const render = records.find(record => record.tool === "ffmpeg");
  assert.equal(render.child.killed, true);
  assert.ok(render.child.exitCode !== null || render.child.signalCode !== null);
  await assert.rejects(readFile(engine.path(outputId)), { code: "ENOENT" });
  assert.equal(await engine.verify(source.id, SHA), true);
  await noPartials(directory);
});

test("segmented render and proxy use isolated bounded encodes, duration-based progress and reap on cancel", async t => {
  for (const mode of ["segments", "proxy"]) {
    const records = [];
    const { engine, directory } = await fixture(t, { ...injectedPaths, spawn: injected(args => {
      assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
      assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
      assert.equal(args[args.indexOf("-c:a") + 1], "aac");
      assert.equal(args[args.indexOf("-fs") + 1], String(2 * 1024 ** 3 + 1));
      if (mode === "segments") {
        const graph = args[args.indexOf("-filter_complex") + 1];
        assert.match(graph, /aresample=async=1:first_pts=0,apad,atrim=end=3.5,asplit=2/u);
        assert.match(graph, /trim=start=0.5:end=1.5,setpts=PTS-0.5\/TB/u);
        assert.match(graph, /atrim=start=2.5:end=3.5,asetpts=PTS-2.5\/TB/u);
        assert.match(graph, /concat=n=2:v=1:a=1/u);
        assert.match(graph, /crop=126:224:.*drawtext=textfile=caption.txt:expansion=none/u);
        assert.match(graph, /volume=-6dB/u);
        assert.equal(args[args.indexOf("-t") + 1], "2");
        assert.ok(!args.includes("-ss"), "segment times refer to the original source");
      } else {
        assert.equal(args[args.indexOf("-vf") + 1], "scale=320:240");
        assert.ok(!args.includes("-ss") && !args.includes("-t") && !args.includes("-af"));
      }
      return `require('node:fs').writeFileSync(${JSON.stringify(args.at(-1))},'partial');process.stdout.write('out_time_us=1000000\\nout_time_us=500000\\n');setInterval(()=>{},1000);`;
    }, records) });
    const source = await engine.import(randomUUID(), Readable.from([WEBM]), "source.webm");
    const outputId = randomUUID(), controller = new AbortController(), progress = [];
    const observer = value => { progress.push(value); if (value > 0) controller.abort(); };
    await assert.rejects(mode === "proxy" ? engine.proxy(source.id, outputId, observer, controller.signal)
      : engine.render(source.id, outputId, { ...EDIT, outSeconds: 3.5, caption: "safe text", segments: [
        { inSeconds: 0.5, outSeconds: 1.5 }, { inSeconds: 2.5, outSeconds: 3.5 }
      ] }, observer, controller.signal), { name: "AbortError" });
    assert.deepEqual(progress, [0, mode === "proxy" ? 0.25 : 0.5]);
    const child = records.find(record => record.tool === "ffmpeg").child;
    assert.equal(child.killed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await assert.rejects(readFile(engine.path(outputId)), { code: "ENOENT" });
    assert.equal(await engine.verify(source.id, SHA), true);
    await noPartials(directory);
    await assert.rejects(engine.proxy(source.id, randomUUID(), () => {}, AbortSignal.abort()), { name: "AbortError" });
  }
});

async function realFfmpeg(args, options = {}) {
  return realMediaTool("ffmpeg", ["-hide_banner", "-nostdin", ...args], options);
}

async function realMediaTool(tool, args, options = {}) {
  const executable = tool === "ffmpeg" ? process.env.ATRIS_SHARE_FFMPEG : process.env.ATRIS_SHARE_FFPROBE;
  const child = nodeSpawn(executable ?? tool, ["-v", "error", ...args],
    { ...options, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [], errors = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.on("data", chunk => errors.push(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, Buffer.concat(errors).toString());
  return Buffer.concat(chunks);
}

function inkBounds(pixels, width, height) {
  assert.equal(pixels.length, width * height);
  let left = width, right = -1, top = height, bottom = -1, count = 0, bands = 0, previousInkRow = -Infinity;
  for (let y = 0; y < height; y++) {
    let row = false;
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] < 180) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      count++; row = true;
    }
    // Ignore tiny intra-glyph gaps that lossy encoding can open around punctuation.
    if (row) { if (y - previousInkRow > 3) bands++; previousInkRow = y; }
  }
  assert.ok(count > 0, "caption must produce visible glyphs");
  return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1, count, bands };
}

test("real 640x360 to 198x352 captions wrap all literal text and match an unclipped reference render", async t => {
  const { directory } = await fixture(t);
  const captions = [], filters = [];
  const engine = new MediaEngine(directory, { spawn: (tool, args, options) => {
    if (args.includes("-vf")) {
      filters.push(args[args.indexOf("-vf") + 1]);
      captions.push(readFile(join(options.cwd, "caption.txt"), "utf8"));
    }
    return nodeSpawn(tool, args, options);
  } });
  const status = await engine.status();
  if (!status.available) { t.skip(`External tools unavailable: ${JSON.stringify(status)}`); return; }
  const sourceBytes = await realFfmpeg(["-f", "lavfi", "-i", "color=c=black:size=640x360:rate=12", "-t", "1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]);
  const source = await engine.import(randomUUID(), Readable.from([sourceBytes]), "wide.mp4");
  for (const caption of [
    "AtrisShare · Create your story",
    "AtrisShare · Create your story with every moment worth sharing",
    "Literal %{pts} : ' [safe] , ; \\ %{eif:1}",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz"
  ]) {
    const output = await engine.render(source.id, randomUUID(), { ...EDIT, inSeconds: 0, outSeconds: 0.5, gainDb: 0, caption }, () => {}, new AbortController().signal);
    assert.deepEqual(output.probe, { width: 198, height: 352, duration: 0.5, hasAudio: false });
    const wrapped = await captions.at(-1), filter = filters.at(-1);
    assert.ok(wrapped.includes("\n"), "vertical caption must wrap");
    assert.equal(wrapped.replace(/\s/gu, ""), caption.replace(/\s/gu, ""), "every literal non-whitespace character survives wrapping");
    if (caption.includes("%{")) {
      for (const token of ["%{pts}", "'", "[safe]", ",", ";", "\\", "%{eif:1}"]) assert.ok(wrapped.includes(token), token);
    }
    assert.ok(!filter.includes("%{") && !filter.includes("AtrisShare"));
    const fontSize = Number(/fontsize=(\d+)/u.exec(filter)[1]);
    const spacing = Number(/line_spacing=(\d+)/u.exec(filter)[1]);
    assert.equal(fontSize, 12);
    const frame = await realFfmpeg(["-i", engine.path(output.id), "-frames:v", "1", "-vf", "format=gray", "-threads", "1", "-f", "rawvideo", "pipe:1"]);
    const actual = inkBounds(frame, 198, 352);
    // Independent oversized canvas: the same complete literal caption cannot be
    // clipped here. Compare all glyph bounds, line bands and ink, not just exit 0.
    await writeFile(join(directory, "reference.txt"), wrapped);
    const referenceFrame = await realFfmpeg(["-f", "lavfi", "-i", "color=c=black:size=1024x1024:rate=1", "-frames:v", "1",
      "-vf", `drawtext=textfile=reference.txt:expansion=none:fontcolor=white:fontsize=${fontSize}:line_spacing=${spacing}:x=64:y=64,format=gray`,
      "-threads", "1", "-f", "rawvideo", "pipe:1"], { cwd: directory });
    const expected = inkBounds(referenceFrame, 1024, 1024);
    assert.ok(actual.left >= 8 && actual.right < 190, JSON.stringify(actual));
    assert.ok(actual.top >= 8 && actual.bottom < 344, JSON.stringify(actual));
    assert.ok(Math.abs(actual.width - expected.width) <= 1, `glyph width: ${JSON.stringify({ actual, expected })}`);
    assert.ok(Math.abs(actual.height - expected.height) <= 1, `glyph height: ${JSON.stringify({ actual, expected })}`);
    assert.equal(actual.bands, expected.bands);
    assert.ok(Math.abs(actual.count / expected.count - 1) < 0.15, "all caption ink survives encoding");
    t.diagnostic(`${JSON.stringify(caption)}: font=${fontSize}, lines=${wrapped.split("\n").length}, ink=${actual.width}x${actual.height}, bounds=${actual.left},${actual.top}–${actual.right},${actual.bottom}`);
  }
  assert.equal(await engine.verify(source.id, source.sha256), true);
  await noPartials(directory);
});

test("real FFmpeg/FFprobe fixture: trim, square/vertical crop, caption, gain, progress and immutable source", async t => {
  const { directory } = await fixture(t);
  const engine = new MediaEngine(directory);
  const status = await engine.status();
  if (!status.available) { t.skip(`External tools unavailable: ${JSON.stringify(status)}`); return; }
  // Only use already configured/PATH tools; no downloads or bundled binaries.
  const executable = process.env.ATRIS_SHARE_FFMPEG ?? "ffmpeg";
  const child = nodeSpawn(executable, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2",
    "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [], errors = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.on("data", chunk => errors.push(chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const sourceBytes = Buffer.concat(chunks);
  const source = await engine.import(randomUUID(), Readable.from([sourceBytes]), "fixture.mp4");
  assert.equal(source.probe.hasAudio, true);
  assert.equal(source.probe.width, 320);
  for (const crop of ["square", "vertical"]) {
    const progress = [];
    const output = await engine.render(source.id, randomUUID(), { ...EDIT, crop, caption: "Literal %{pts} : ' [safe]" }, p => progress.push(p), new AbortController().signal);
    assert.equal(output.mimeType, "video/mp4");
    assert.ok(Math.abs(output.probe.duration - 2) < 0.15);
    assert.equal(output.probe.hasAudio, true);
    assert.ok(Math.abs(output.probe.width / output.probe.height - (crop === "square" ? 1 : 9 / 16)) < 0.001);
    assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((value, i) => i === 0 || value > progress[i - 1]));
    assert.equal(await engine.verify(output.id, output.sha256), true);
    assert.equal(await engine.verify(source.id, source.sha256), true);
  }
  assert.deepEqual(await readFile(engine.path(source.id)), sourceBytes);
  await noPartials(directory);
});

async function markerSource(engine, directory, size = "320x240") {
  const path = join(directory, `markers-${size}.mp4`);
  // Simultaneous white flashes + 1kHz beeps at .8s and 2.8s. A different
  // flash/beep in the discarded middle proves we removed content, not just time.
  const active = "between(t,0.8,0.92)+between(t,1.8,1.92)+between(t,2.8,2.92)";
  await realFfmpeg(["-f", "lavfi", "-i", `color=c=black:size=${size}:rate=50`,
    "-f", "lavfi", "-i", `aevalsrc='if(${active},0.5*sin(2*PI*1000*t),0)':s=48000`,
    "-vf", `drawbox=c=white:t=fill:enable='${active}'`, "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-n", path]);
  return engine.import(randomUUID(), Readable.from([await readFile(path)]), "markers.mp4");
}

function onsets(values, threshold, step) {
  const result = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > threshold && (i === 0 || values[i - 1] <= threshold)) result.push(i * step);
  }
  return result;
}

async function avMarkers(path) {
  const timing = JSON.parse(await realMediaTool("ffprobe", ["-select_streams", "v:0", "-show_entries",
    "format=start_time:frame=best_effort_timestamp_time", "-of", "json", path]));
  const origin = Number(timing.format.start_time);
  const frames = await realFfmpeg(["-i", path, "-an", "-vf", "scale=1:1,format=gray", "-vsync", "0", "-threads", "1", "-f", "rawvideo", "pipe:1"]);
  assert.equal(frames.length, timing.frames.length, "decoded pixels correspond to probed video timestamps");
  // Raw PCM alone drops packet timestamps. Materialize the shared-clock leading
  // gap when decoding, so delayed audio cannot masquerade as time-zero audio.
  const pcm = await realFfmpeg(["-i", path, "-vn", "-af", "aresample=async=1:first_pts=0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]);
  const rms = [];
  for (let at = 0; at + 480 * 4 <= pcm.length; at += 480 * 4) {
    let energy = 0;
    for (let i = 0; i < 480; i++) energy += pcm.readFloatLE(at + i * 4) ** 2;
    rms.push(Math.sqrt(energy / 480));
  }
  const video = onsets(frames, 128, 1).map(i => Number(timing.frames[i].best_effort_timestamp_time) - origin);
  return { video, audio: onsets(rms, 0.06, 0.01), rms, audioDuration: pcm.length / 4 / 48000,
    videoDuration: Number(timing.frames.at(-1).best_effort_timestamp_time) - origin + 1 / 50 };
}

function assertMarkers(actual, expected) {
  assert.equal(actual.video.length, expected.length, JSON.stringify(actual.video));
  assert.equal(actual.audio.length, expected.length, JSON.stringify(actual.audio));
  for (const [i, time] of expected.entries()) {
    assert.ok(Math.abs(actual.video[i] - time) <= 0.041, `video marker ${i}: ${actual.video[i]} vs ${time}`);
    assert.ok(Math.abs(actual.audio[i] - time) <= 0.031, `audio marker ${i}: ${actual.audio[i]} vs ${time}`);
    assert.ok(Math.abs(actual.video[i] - actual.audio[i]) <= 0.041, `A/V sync at marker ${i}`);
  }
}

test("real segmented render removes the middle: 2s concat, decoded A/V markers, gain and immutable source", async t => {
  const { directory } = await fixture(t);
  const engine = new MediaEngine(directory);
  if (!(await engine.status()).available) { t.skip("External FFmpeg/FFprobe unavailable"); return; }
  const source = await markerSource(engine, directory);
  const original = await avMarkers(engine.path(source.id));
  assertMarkers(original, [0.8, 1.8, 2.8]);
  const segments = [{ inSeconds: 0.5, outSeconds: 1.5 }, { inSeconds: 2.5, outSeconds: 3.5 }];
  const edit = { ...EDIT, outSeconds: 3.5, crop: "square", segments };
  const progress = [];
  const output = await engine.render(source.id, randomUUID(), edit, p => progress.push(p), new AbortController().signal);
  assert.ok(Math.abs(output.probe.duration - 2) < 0.08, JSON.stringify(output.probe));
  assert.deepEqual({ ...output.probe, duration: 2 }, { duration: 2, width: 240, height: 240, hasAudio: true });
  const actual = await avMarkers(engine.path(output.id));
  assertMarkers(actual, [0.3, 1.3]);
  assert.ok(Math.abs(actual.audioDuration - 2) < 0.05);
  assert.ok(Math.abs(actual.videoDuration - 2) < 0.05);
  const ratio = actual.rms[35] / original.rms[85];
  assert.ok(Math.abs(ratio - 10 ** (-6 / 20)) < 0.06, `gain amplitude ratio: ${ratio}`);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, i) => i === 0 || value > progress[i - 1]));
  assert.deepEqual(edit.segments, segments, "render does not rewrite source ranges or envelope");
  assert.equal(edit.inSeconds, 0.5); assert.equal(edit.outSeconds, 3.5);
  assert.equal(await engine.verify(source.id, source.sha256), true);
  assert.equal(await engine.verify(output.id, output.sha256), true);
  // Atomic/exclusive output publication also applies to multi-segment exports.
  await assert.rejects(engine.render(source.id, output.id, edit, () => {}, new AbortController().signal), { code: "EEXIST" });
  assert.equal(await engine.verify(output.id, output.sha256), true);
  // Same graph for video-only, including its one-segment form and static caption.
  const silentPath = join(directory, "silent.mp4");
  await realFfmpeg(["-i", engine.path(source.id), "-an", "-c:v", "copy", "-n", silentPath]);
  const silent = await engine.import(randomUUID(), Readable.from([await readFile(silentPath)]), "silent.mp4");
  for (const ranges of [segments, [segments[0]]]) {
    const result = await engine.render(silent.id, randomUUID(), { ...edit, crop: "vertical", caption: "Literal %{pts} safe wrapped caption", segments: ranges },
      () => {}, new AbortController().signal);
    assert.deepEqual({ ...result.probe, duration: ranges.length }, { duration: ranges.length, width: 126, height: 224, hasAudio: false });
    assert.ok(Math.abs(result.probe.duration - ranges.length) < 0.08);
    const pixels = await realFfmpeg(["-ss", "0.1", "-i", engine.path(result.id), "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "pipe:1"]);
    assert.ok(inkBounds(pixels, 126, 224).count > 0, "caption also appears on segmented exports");
  }
  await noPartials(directory);
  t.diagnostic(`Removed middle marker; decoded video onsets=${actual.video}, audio onsets=${actual.audio}, gain ratio=${ratio.toFixed(3)}`);
});

test("real delayed audio keeps its source clock through segments and proxy, including nonzero input start_time", async t => {
  const { directory } = await fixture(t);
  const engine = new MediaEngine(directory);
  if (!(await engine.status()).available) { t.skip("External FFmpeg/FFprobe unavailable"); return; }
  const path = join(directory, "delayed-audio.mp4");
  const videoActive = "between(t,1,1.12)+between(t,1.8,1.92)+between(t,2.8,2.92)";
  const audioActive = "between(t,0,0.12)+between(t,0.8,0.92)+between(t,1.8,1.92)";
  // Actual absent audio packets for the first second, not an encoded silent
  // prefix. Audio ends at 3s while video runs to 4s, exercising tail padding too.
  await realFfmpeg(["-f", "lavfi", "-i", "color=c=black:size=320x240:rate=50:duration=4",
    "-itsoffset", "1", "-f", "lavfi", "-i", `aevalsrc='if(${audioActive},0.5*sin(2*PI*1000*t),0)':s=48000:d=2`,
    "-vf", `drawbox=c=white:t=fill:enable='${videoActive}'`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-n", path]);
  for (const origin of [0, 5]) await t.test(`input start_time=${origin}`, async t => {
    const input = origin === 0 ? path : join(directory, "delayed-audio-shifted.mp4");
    if (origin) await realFfmpeg(["-i", path, "-map", "0", "-c", "copy", "-output_ts_offset", String(origin), "-n", input]);
    const timing = JSON.parse(await realMediaTool("ffprobe", ["-show_entries",
      "format=start_time,duration:stream=codec_type,start_time,duration", "-of", "json", input]));
    assert.ok(Math.abs(Number(timing.format.start_time) - origin) < 0.001, JSON.stringify(timing));
    const audioStart = Number(timing.streams.find(stream => stream.codec_type === "audio").start_time) - origin;
    assert.ok(audioStart > 0.95 && audioStart <= 1.01, `fixture audio really starts late: ${audioStart}`);
    t.diagnostic(`Source timing=${JSON.stringify(timing)}`);
    const source = await engine.import(randomUUID(), Readable.from([await readFile(input)]), "delayed.mp4");
    assert.ok(Math.abs(source.probe.duration - 4) < 0.01, "source duration excludes the container timestamp origin");
    assert.deepEqual(await engine.inspect(source.id), source.probe);
    await assert.rejects(engine.render(source.id, randomUUID(), { ...EDIT, inSeconds: 0, outSeconds: 4.5,
      segments: [{ inSeconds: 0, outSeconds: 4.5 }] }, () => {}, new AbortController().signal), /media_trim_out_of_bounds/u);
    assertMarkers(await avMarkers(engine.path(source.id)), [1, 1.8, 2.8]);
    const cases = [
      { name: "spans source start", segments: [[0, 2]], markers: [1, 1.8], silence: [[0, 0.9]] },
      { name: "cut before audio onset", segments: [[0.5, 2]], markers: [0.5, 1.3], silence: [[0, 0.4]] },
      { name: "cut after audio onset", segments: [[1.5, 3.5]], markers: [0.3, 1.3], silence: [[1.6, 1.95]] },
      { name: "multiple ranges with leading and trailing silence", segments: [[0, 0.5], [0.7, 1.4], [2.5, 3.5], [3.5, 4]],
        markers: [0.8, 1.5], silence: [[0, 0.7], [1.8, 2.65]] },
      { name: "entirely before audio onset", segments: [[0, 0.5]], markers: [], silence: [[0, 0.45]] },
      { name: "entirely after audio end", segments: [[3.5, 4]], markers: [], silence: [[0, 0.45]] }
    ];
    for (const { name, segments: ranges, markers, silence } of cases) {
      const segments = ranges.map(([inSeconds, outSeconds]) => ({ inSeconds, outSeconds }));
      const duration = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
      const output = await engine.render(source.id, randomUUID(), { ...EDIT, inSeconds: 0, outSeconds: 4, crop: "original", gainDb: 0, segments },
        () => {}, new AbortController().signal);
      const actual = await avMarkers(engine.path(output.id));
      assertMarkers(actual, markers);
      for (const [start, end] of silence) {
        assert.ok(actual.rms.slice(Math.ceil(start * 100), Math.floor(end * 100)).every(value => value < 0.005), `${name}: gap must be silence`);
      }
      assert.ok(Math.abs(output.probe.duration - duration) < 0.05, `${name}: container duration ${output.probe.duration}`);
      assert.ok(Math.abs(actual.audioDuration - duration) < 0.05, `${name}: decoded audio duration ${actual.audioDuration}`);
      assert.ok(Math.abs(actual.videoDuration - duration) < 0.025, `${name}: video duration ${actual.videoDuration}`);
      assert.equal(await engine.verify(output.id, output.sha256), true);
      t.diagnostic(`${name}: video=${actual.video}, audio=${actual.audio}, duration=${output.probe.duration}`);
    }
    const proxy = await engine.proxy(source.id, randomUUID(), () => {}, new AbortController().signal);
    const actual = await avMarkers(engine.path(proxy.id));
    assertMarkers(actual, [1, 1.8, 2.8]);
    assert.ok(actual.rms.slice(0, 90).every(value => value < 0.005), "proxy preserves leading audio gap on source clock");
    assert.ok(Math.abs(proxy.probe.duration - 4) < 0.05);
    assert.ok(Math.abs(actual.videoDuration - 4) < 0.025);
    assert.equal(await engine.verify(source.id, source.sha256), true);
    assert.equal(await engine.verify(proxy.id, proxy.sha256), true);
    await noPartials(directory);
    t.diagnostic(`Proxy: video=${actual.video}, audio=${actual.audio}, duration=${proxy.probe.duration}`);
  });
});

test("real proxy preserves full source timing/A/V markers and aspect, fits 1280x720, honors rotation", async t => {
  const { directory } = await fixture(t);
  const engine = new MediaEngine(directory);
  if (!(await engine.status()).available) { t.skip("External FFmpeg/FFprobe unavailable"); return; }
  const source = await markerSource(engine, directory, "1600x900");
  const progress = [];
  const proxy = await engine.proxy(source.id, randomUUID(), p => progress.push(p), new AbortController().signal);
  assert.deepEqual({ ...proxy.probe, duration: 4 }, { duration: 4, width: 1280, height: 720, hasAudio: true });
  assert.ok(Math.abs(proxy.probe.duration - source.probe.duration) < 0.05);
  const actual = await avMarkers(engine.path(proxy.id));
  assertMarkers(actual, [0.8, 1.8, 2.8]);
  assert.ok(Math.abs(actual.audioDuration - actual.videoDuration) < 0.05);
  assert.equal(proxy.mimeType, "video/mp4");
  assert.equal(proxy.bytes, (await readFile(engine.path(proxy.id))).length);
  assert.equal(await engine.verify(proxy.id, proxy.sha256), true);
  assert.equal(await engine.verify(source.id, source.sha256), true);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, i) => i === 0 || value > progress[i - 1]));
  const rotatedPath = join(directory, "rotated.mp4");
  await realFfmpeg(["-display_rotation", "90", "-i", engine.path(source.id), "-c", "copy", "-an", "-n", rotatedPath]);
  const rotated = await engine.import(randomUUID(), Readable.from([await readFile(rotatedPath)]), "rotated.mp4");
  assert.equal(rotated.probe.width, 900); assert.equal(rotated.probe.height, 1600);
  const portrait = await engine.proxy(rotated.id, randomUUID(), () => { throw new Error("observer ignored"); }, new AbortController().signal);
  assert.deepEqual({ ...portrait.probe, duration: 4 }, { duration: 4, width: 404, height: 720, hasAudio: false });
  assert.ok(Math.abs(portrait.probe.width / portrait.probe.height - 9 / 16) < 0.002);
  assert.ok(Math.abs(portrait.probe.duration - 4) < 0.05);
  assert.equal(await engine.verify(rotated.id, rotated.sha256), true);
  const anamorphicPath = join(directory, "anamorphic.mp4");
  await realFfmpeg(["-f", "lavfi", "-i", "color=size=300x200:rate=10", "-vf", "setsar=4/3", "-t", "0.5",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "2", "-n", anamorphicPath]);
  const anamorphic = await engine.import(randomUUID(), Readable.from([await readFile(anamorphicPath)]), "anamorphic.mp4");
  const corrected = await engine.proxy(anamorphic.id, randomUUID(), () => {}, new AbortController().signal);
  const display = await realFfmpeg(["-i", engine.path(corrected.id), "-frames:v", "1", "-vf", "scale=iw*sar:ih,setsar=1,format=gray", "-f", "rawvideo", "pipe:1"]);
  assert.equal(display.length, 400 * 200, "proxy retains 2:1 display aspect, including non-square source pixels");
  // Cancel actual encoders after their first structured output, then prove that
  // child close (not just kill request) and workspace cleanup preceded rejection.
  for (const mode of ["proxy", "segments"]) {
    const controller = new AbortController();
    let child;
    const cancelling = new MediaEngine(directory, { spawn: (tool, args, options) => {
      const process = nodeSpawn(tool, args, options);
      if (args.includes("-progress")) {
        child = process;
        child.stdout.once("data", () => controller.abort());
      }
      return process;
    } });
    const outputId = randomUUID(), observed = [];
    await assert.rejects(mode === "proxy" ? cancelling.proxy(source.id, outputId, p => observed.push(p), controller.signal)
      : cancelling.render(source.id, outputId, { ...EDIT, outSeconds: 3.5, segments: [
        { inSeconds: 0.5, outSeconds: 1.5 }, { inSeconds: 2.5, outSeconds: 3.5 }
      ] }, p => observed.push(p), controller.signal), { name: "AbortError" });
    assert.equal(child.killed, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.ok(!observed.includes(1));
    await assert.rejects(readFile(cancelling.path(outputId)), { code: "ENOENT" });
    await noPartials(directory);
    assert.equal(await engine.verify(source.id, source.sha256), true);
  }
  // Validate actual output, rather than trusting encoder exit 0 or input probe.
  for (const mode of ["short", "wrong-codec"]) {
    const invalid = new MediaEngine(directory, { spawn: (tool, args, options) => {
      if (args.includes("-progress")) {
        args = [...args];
        if (mode === "short") args.splice(-1, 0, "-t", "0.25");
        else args[args.indexOf("-c:v") + 1] = "mpeg4";
      }
      return nodeSpawn(tool, args, options);
    } });
    const outputId = randomUUID();
    await assert.rejects(invalid.proxy(source.id, outputId, () => {}, new AbortController().signal),
      mode === "short" ? /media_render_incomplete/u : /media_output_incompatible/u);
    await assert.rejects(readFile(invalid.path(outputId)), { code: "ENOENT" });
    await noPartials(directory);
  }
  // Enforce the existing media-byte limit on actual encoded bytes, before publish.
  const small = await engine.import(randomUUID(), Readable.from([WEBM]), "small.webm");
  const limited = new MediaEngine(directory, { maxImportBytes: WEBM.length });
  const limitedId = randomUUID();
  await assert.rejects(limited.proxy(small.id, limitedId, () => {}, new AbortController().signal), /media_size_limit|invalid_media_container|media_render_incomplete/u);
  await assert.rejects(readFile(limited.path(limitedId)), { code: "ENOENT" });
  await noPartials(directory);
  t.diagnostic(`Proxy decoded video onsets=${actual.video}, audio onsets=${actual.audio}; rotated dimensions=${portrait.probe.width}x${portrait.probe.height}`);
});
