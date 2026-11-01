import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { editSchema, mediaProbeSchema } from "../dist/packages/domain/src/media.js";
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
  }
  const id = randomUUID();
  await engine.import(id, Readable.from([WEBM]), "source.webm");
  await assert.rejects(engine.render(id, id.toUpperCase(), EDIT, () => {}, new AbortController().signal), /media_source_is_immutable/u);
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
  assert.equal(args[args.indexOf("-show_entries") + 1], "format=duration:stream=codec_type,width,height,duration:stream_tags=rotate:stream_side_data_list");
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

async function realFfmpeg(args, options = {}) {
  const child = nodeSpawn(process.env.ATRIS_SHARE_FFMPEG ?? "ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", ...args],
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
