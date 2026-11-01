import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { TranscriptionEngine } from "../dist/packages/media-engine/src/transcription.js";

const HELP = "usage: whisper-cli --model --file --output-json-full --output-file --language --print-progress --threads --no-gpu";
const SOURCE = Buffer.from("000000186674797069736f6d0000000069736f6d", "hex");
const MODEL = Buffer.concat([Buffer.from("lmgg"), Buffer.alloc(60)]);
const stamp = ms => `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
const segment = (from, to, text = " Local speech.") => ({ offsets: { from, to }, timestamps: { from: stamp(from), to: stamp(to) }, text });
const output = (segments = [segment(250, 1500)]) => ({ result: { language: "en" }, transcription: segments,
  params: { model: "C:\\private\\model.bin", file: "C:\\private\\source.mp4" }, systeminfo: "not for UI" });

function wavHeader(seconds = 4) {
  const bytes = Math.round(seconds * 32000), header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(bytes + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(bytes, 40);
  return header;
}
function wavScript(seconds = 4, header = wavHeader(seconds)) {
  return `const fs=require('node:fs');fs.writeFileSync('audio.wav',Buffer.from('${header.toString("base64")}','base64'));fs.truncateSync('audio.wav',${44 + Math.round(seconds * 32000)});`;
}
function jsonScript(value = output()) {
  return `require('node:fs').writeFileSync('transcript.json',${JSON.stringify(JSON.stringify(value))});`;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "atris-transcription-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, `${randomUUID()}.mp4`), model = join(directory, "ggml-test.bin");
  await writeFile(source, SOURCE); await writeFile(model, MODEL);
  return { directory, source, model };
}
function injected(model, configuration = {}) {
  const records = [];
  const engine = new TranscriptionEngine({ ffmpegPath: process.execPath, whisperPath: process.execPath, modelPath: model,
    spawn: (_path, args, options) => {
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      assert.ok(Object.keys(options.env).every(key => /^(path|systemroot|temp|tmp|tmpdir)$/iu.test(key)));
      const kind = args.includes("-version") ? "version" : args.includes("--help") ? "help" : args.includes("-i") ? "extract" : "transcribe";
      const script = configuration[kind] ?? (kind === "version" ? "console.log('ffmpeg version test')"
        : kind === "help" ? `process.stderr.write(${JSON.stringify(HELP)})` : kind === "extract" ? wavScript() : jsonScript());
      const child = nodeSpawn(process.execPath, ["-e", script], options);
      const record = { kind, args, options, child, existedAtClose: undefined };
      child.once("close", () => { record.existedAtClose = options.cwd ? existsSync(options.cwd) : undefined; });
      records.push(record);
      configuration.onSpawn?.(record);
      return child;
    } });
  return { engine, records };
}
async function cleaned(records) {
  for (const record of records) {
    assert.ok(record.child.exitCode !== null || record.child.signalCode !== null, "child must be reaped");
    if (record.options.cwd) {
      assert.equal(record.existedAtClose, true, "workspace survives until process and pipes close");
      assert.equal(existsSync(record.options.cwd), false, "app-owned workspace must be removed");
    }
  }
}
const signal = () => new AbortController().signal;

test("availability distinguishes missing native tools/model and requires an absolute local GGML model", async t => {
  const { directory, model, source } = await fixture(t);
  const missing = { ffmpegPath: join(directory, "absent-ffmpeg.exe"), whisperPath: join(directory, "absent-whisper.exe"), modelPath: model };
  const engine = new TranscriptionEngine(missing);
  assert.deepEqual(await engine.status(), { available: false, ffmpeg: false, whisper: false, model: true });
  await assert.rejects(engine.transcribe(source, () => {}, signal()), /transcription_tool_unavailable: whisper/u);
  for (const path of ["relative-model.bin", join(directory, "absent.bin"), directory]) {
    const unavailable = new TranscriptionEngine({ ...missing, modelPath: path });
    assert.equal((await unavailable.status()).model, false);
    await assert.rejects(unavailable.transcribe(source, () => {}, signal()), /model_unavailable_absolute_path_required/u);
  }
  await writeFile(model, Buffer.alloc(64));
  assert.equal((await new TranscriptionEngine(missing).status()).model, false);
  const good = await fixture(t);
  const noFfmpeg = new TranscriptionEngine({ ...missing, modelPath: good.model, whisperPath: process.execPath,
    spawn: (_path, args, options) => nodeSpawn(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(HELP)})`], options) });
  await assert.rejects(noFfmpeg.transcribe(good.source, () => {}, signal()), /tool_unavailable: ffmpeg/u);
});

test("status checks actual CLI capabilities, coalesces polling and returns immutable cached snapshots", async t => {
  const { model } = await fixture(t);
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const { engine, records } = injected(model);
  const values = await Promise.all(Array.from({ length: 8 }, () => engine.status()));
  assert.ok(values.every(value => value.available)); assert.equal(records.length, 2);
  values[0].model = false;
  assert.equal((await engine.status()).model, true);
  now += 15000;
  assert.equal((await engine.status()).available, true); assert.equal(records.length, 4);
  const bad = injected(model, { help: "console.log('usage: incompatible --model --file')" });
  assert.deepEqual(await bad.engine.status(), { available: false, ffmpeg: true, whisper: false, model: true });
  assert.equal((await new TranscriptionEngine({ whisperPath: "whisper.cmd", ffmpegPath: "ffmpeg.bat", modelPath: model }).status()).available, false);
});

test("closed extraction, full JSON CLI flags, real progress and complete WAV duration; paths/metadata never escape", async t => {
  const { model, source } = await fixture(t);
  const { engine, records } = injected(model, { transcribe: `process.stderr.write('whisper_print_progress_callback: progress =  25');setTimeout(()=>{
    process.stderr.write('%\\nwhisper_print_progress_callback: progress =  10%\\nwhisper_print_progress_callback: progress = 100%\\n');${jsonScript()}
  },10);` });
  // Split a real stderr message across chunks; duplicate/regressive and completion messages cannot fabricate progress.
  const progress = [];
  const result = await engine.transcribe(source, p => progress.push(p), signal());
  assert.deepEqual(result, { language: "en", segments: [{ start: 0.25, end: 1.5, text: "Local speech." }], duration: 4 });
  assert.deepEqual(progress, [0, 0.25, 1]);
  const extract = records.find(record => record.kind === "extract"), whisper = records.find(record => record.kind === "transcribe");
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(value(extract.args, "-protocol_whitelist"), "file,pipe");
  assert.equal(value(extract.args, "-format_whitelist"), "mov,matroska,webm");
  assert.equal(value(extract.args, "-f"), "mov");
  assert.equal(value(extract.args, "-enable_drefs"), "0"); assert.equal(value(extract.args, "-use_absolute_path"), "0");
  assert.equal(value(extract.args, "-ac"), "1"); assert.equal(value(extract.args, "-ar"), "16000");
  assert.equal(value(extract.args, "-c:a"), "pcm_s16le"); assert.equal(value(extract.args, "-t"), "7201");
  assert.equal(value(extract.args, "-map"), "0:a:0");
  assert.equal(value(whisper.args, "--model"), model); assert.equal(value(whisper.args, "--file"), "audio.wav");
  assert.ok(whisper.args.includes("--output-json-full")); assert.equal(value(whisper.args, "--output-file"), "transcript");
  assert.equal(value(whisper.args, "--language"), "auto"); assert.ok(!whisper.args.includes("--prompt"));
  assert.equal(whisper.options.cwd, extract.options.cwd); assert.notEqual(whisper.options.cwd, tmpdir());
  assert.deepEqual(await readFile(source), SOURCE);
  assert.ok(!JSON.stringify(result).includes("private"));
  await cleaned(records);
});

test("WebM is selected by signature regardless of managed extension; observers cannot interrupt cleanup", async t => {
  const { model, source } = await fixture(t);
  await writeFile(source, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]));
  const { engine, records } = injected(model, { transcribe: jsonScript(output([])) });
  assert.deepEqual(await engine.transcribe(source, () => { throw Error("observer"); }, signal()), { language: "en", segments: [], duration: 4 });
  const args = records.find(record => record.kind === "extract").args;
  assert.equal(args[args.indexOf("-f") + 1], "matroska"); assert.ok(!args.includes("-enable_drefs"));
  await cleaned(records);
});

test("malformed, reversed, overlapping, nonnumeric and out-of-audio timestamps reject without partial transcripts", async t => {
  const { model, source } = await fixture(t);
  const invalid = [
    { ...segment(0, 1000), offsets: { from: "0", to: 1000 } },
    { ...segment(0, 1000), offsets: { from: null, to: 1000 } },
    { ...segment(0, 1000), timestamps: { from: "00:99:00,000", to: "00:00:01,000" } },
    { ...segment(0, 1000), timestamps: { from: "00:00:00,001", to: "00:00:01,000" } },
    segment(1000, 1000), segment(2000, 1000), segment(0, 5000), segment(4000, 4010),
    { ...segment(0, 1000), offsets: { from: -1, to: 1000 } },
    { ...segment(0, 1000), offsets: { from: 0.5, to: 1000 } }
  ];
  for (const entry of invalid) {
    const { engine, records } = injected(model, { transcribe: jsonScript(output([entry])) });
    const progress = [];
    await assert.rejects(engine.transcribe(source, p => progress.push(p), signal()), /transcription_invalid_timestamps/u);
    assert.ok(!progress.includes(1)); await cleaned(records);
  }
  const overlap = injected(model, { transcribe: jsonScript(output([segment(0, 2000), segment(1500, 3000)])) });
  await assert.rejects(overlap.engine.transcribe(source, () => {}, signal()), /invalid_timestamps/u); await cleaned(overlap.records);
  const quantum = injected(model, { transcribe: jsonScript(output([segment(0, 4000)])), extract: wavScript(3.995) });
  const rounded = await quantum.engine.transcribe(source, () => {}, signal());
  assert.equal(rounded.segments[0].end, rounded.duration); await cleaned(quantum.records);
});

test("invalid JSON, unsafe transcript text/language and oversized JSON are rejected and removed", async t => {
  const { model, source } = await fixture(t);
  for (const script of ["require('node:fs').writeFileSync('transcript.json','not json')",
    "require('node:fs').writeFileSync('transcript.json',Buffer.from([255]))", "process.exit(0)",
    jsonScript({ ...output(), result: { language: "C:\\private" } }), jsonScript(output([segment(0, 1000, "bad\0text")])),
    jsonScript(output([segment(0, 1000, " \n ")])), jsonScript({ ...output(), transcription: null }),
    "const fs=require('node:fs');fs.writeFileSync('transcript.json','');fs.truncateSync('transcript.json',33554433)"
  ]) {
    const { engine, records } = injected(model, { transcribe: script });
    await assert.rejects(engine.transcribe(source, () => {}, signal()), /transcription_invalid_output|transcription_output_limit/u);
    await cleaned(records);
  }
});

test("no audio, bad/truncated PCM and over-two-hour audio fail explicitly before whisper inference", async t => {
  const { model, source } = await fixture(t);
  const badRate = wavHeader(); badRate.writeUInt32LE(48000, 24);
  for (const [extract, expected] of [
    ["process.stderr.write(\"Stream map '0:a:0' matches no streams. source=/private/input.mp4\");process.exitCode=1", /transcription_no_audio/u],
    [wavScript(0), /transcription_no_audio/u], [wavScript(7201), /transcription_unsupported_duration_limit_7200s/u],
    [wavScript(4, badRate), /transcription_invalid_audio/u],
    ["require('node:fs').writeFileSync('audio.wav','partial')", /transcription_invalid_audio/u],
    ["process.exit(0)", /^Error: transcription_invalid_audio$/u]
  ]) {
    const { engine, records } = injected(model, { extract });
    await assert.rejects(engine.transcribe(source, () => {}, signal()), expected);
    assert.equal(records.some(record => record.kind === "transcribe"), false); await cleaned(records);
  }
});

test("untrusted/relative source paths and unsupported CLI capabilities reject before extraction", async t => {
  const { model, source, directory } = await fixture(t);
  const { engine, records } = injected(model);
  for (const path of ["https://example.invalid/audio.mp4", "relative.mp4", directory, join(directory, "private-missing-source.mp4")]) {
    await assert.rejects(engine.transcribe(path, () => {}, signal()), /invalid_source/u);
  }
  await writeFile(source, Buffer.from("#EXTM3U\nhttps://example.invalid/audio"));
  await assert.rejects(engine.transcribe(source, () => {}, signal()), /invalid_source/u);
  assert.equal(records.length, 0);
  await writeFile(source, SOURCE);
  const bad = injected(model, { help: "console.log('unsupported whisper wrapper')" });
  await assert.rejects(bad.engine.transcribe(source, () => {}, signal()), /whisper_incompatible/u);
  assert.equal(bad.records.length, 1);
});

test("cancellation during help/extraction/inference kills and reaps before workspace cleanup", async t => {
  const { model, source } = await fixture(t);
  for (const stage of ["help", "extract", "transcribe"]) {
    const controller = new AbortController();
    const { engine, records } = injected(model, { [stage]: "process.stdout.write('started');setInterval(()=>{},1000)",
      onSpawn: record => { if (record.kind === stage) record.child.stdout.once("data", () => controller.abort()); } });
    const progress = [];
    await assert.rejects(engine.transcribe(source, p => progress.push(p), controller.signal), { name: "AbortError" });
    assert.equal(records.find(record => record.kind === stage).child.killed, true);
    assert.ok(!progress.includes(1)); await cleaned(records);
  }
  const already = injected(model);
  await assert.rejects(already.engine.transcribe(source, () => {}, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(already.records.length, 0);
});

test("bounded stdout/stderr floods and deadline kill/reap real processes, hiding raw paths in errors", async t => {
  const { model, source } = await fixture(t);
  for (const pipe of ["stdout", "stderr"]) {
    const { engine, records } = injected(model, { transcribe: `process.${pipe}.write('x\\n'.repeat(2*1024*1024));setInterval(()=>{},1000)` });
    await assert.rejects(engine.transcribe(source, () => {}, signal()), /transcription_tool_output_limit/u);
    assert.equal(records.at(-1).child.killed, true); await cleaned(records);
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { engine, records } = injected(model, { extract: "process.stdout.write('started');setInterval(()=>{},1000)",
    onSpawn: record => { if (record.kind === "extract") record.child.stdout.once("data", () => t.mock.timers.tick(300000)); } });
  await assert.rejects(engine.transcribe(source, () => {}, signal()), /transcription_tool_timeout/u);
  assert.equal(records.at(-1).child.killed, true); await cleaned(records);
  t.mock.timers.reset();
  const failed = injected(model, { transcribe: "process.stderr.write('secret source C:\\private\\source.mp4');process.exitCode=2" });
  await assert.rejects(failed.engine.transcribe(source, () => {}, signal()), { message: "transcription_whisper_failed" });
  await cleaned(failed.records);
});

async function localCommand(tool, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|temp|tmp|tmpdir)$/iu.test(key)));
  const child = nodeSpawn(tool, args, { ...options, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", size = 0, error;
  const collect = (chunk, standard) => {
    size += chunk.length;
    if (size > 2 * 1024 ** 2) { error ??= Error("fixture_output_limit"); child.kill("SIGKILL"); return; }
    if (standard) stdout += chunk.toString(); else stderr += chunk.toString();
  };
  child.stdout.on("data", chunk => collect(chunk, true)); child.stderr.on("data", chunk => collect(chunk, false));
  child.once("error", value => { error = value; });
  const timer = setTimeout(() => { error ??= Error("fixture_timeout"); child.kill("SIGKILL"); }, 30000);
  const code = await new Promise(resolve => child.once("close", resolve)).finally(() => clearTimeout(timer));
  if (error) throw error;
  assert.equal(code, 0, stderr); return stdout + stderr;
}

test("real Windows SAPI speech → FFmpeg MP4/WebM → local whisper.cpp recognizes phrase with valid source timings", { timeout: 120000 }, async t => {
  if (process.platform !== "win32") { t.skip("Windows SAPI acceptance fixture requires Windows"); return; }
  const engine = new TranscriptionEngine();
  const available = await engine.status();
  if (!available.available) { t.skip(`Configure external tools/model for local acceptance: ${JSON.stringify(available)}`); return; }
  const { directory } = await fixture(t), records = [];
  const recording = new TranscriptionEngine({ spawn: (tool, args, options) => {
    const child = nodeSpawn(tool, args, options);
    if (options.cwd) {
      const record = { child, options, existedAtClose: undefined }; records.push(record);
      child.once("close", () => { record.existedAtClose = existsSync(options.cwd); });
    }
    return child;
  } });
  const speechPath = join(directory, "speech.wav");
  const phrase = "The quick brown fox jumps over the lazy dog. This is a local speech recognition test. No audio leaves this computer.";
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try {
    $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female,[System.Speech.Synthesis.VoiceAge]::Adult,0,[System.Globalization.CultureInfo]::GetCultureInfo('en-US'));
    $s.Rate = -1; $s.SetOutputToWaveFile('${speechPath.replaceAll("'", "''")}'); $s.Speak('${phrase}');
  } finally { $s.Dispose() }`;
  await localCommand(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  const ffmpeg = process.env.ATRIS_SHARE_FFMPEG ?? "ffmpeg";
  const generated = [];
  for (const format of ["mp4", "webm"]) {
    // Deliberately retain .mp4 for WebM, matching immutable managed MediaEngine paths.
    const source = join(directory, `${randomUUID()}.mp4`);
    await localCommand(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:size=160x120:rate=10",
      "-i", speechPath, "-map", "0:v:0", "-map", "1:a:0", "-af", "adelay=1000:all=1,apad=pad_dur=2", "-shortest",
      "-c:v", format === "mp4" ? "libx264" : "libvpx", "-threads", "2", "-c:a", format === "mp4" ? "aac" : "libopus", "-f", format, "-n", source]);
    const before = createHash("sha256").update(await readFile(source)).digest("hex"), progress = [];
    const result = await recording.transcribe(source, p => progress.push(p), signal());
    const recognized = result.segments.map(segment => segment.text).join(" ");
    assert.match(recognized, /quick brown fox/iu); assert.match(recognized, /lazy dog/iu);
    assert.match(recognized, /local speech recognition test/iu);
    assert.equal(result.language, "en"); assert.ok(result.duration > 8 && result.duration < 30);
    assert.ok(result.segments.every((segment, i) => segment.start >= 0 && segment.end > segment.start
      && segment.end <= result.duration && (!i || segment.start >= result.segments[i - 1].end)));
    assert.ok(result.duration - result.segments.at(-1).end >= 0.5, "full duration includes trailing silence after the speech");
    assert.equal(progress[0], 0); assert.equal(progress.at(-1), 1);
    assert.ok(progress.every((p, i) => Number.isFinite(p) && p >= 0 && p <= 1 && (!i || p > progress[i - 1])));
    assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), before);
    assert.ok(!JSON.stringify(result).includes(directory));
    await cleaned(records);
    generated.push(source);
    t.diagnostic(`${format}: ${JSON.stringify(result)}; progress=${JSON.stringify(progress)}`);
  }
  const silent = join(directory, "silent.mp4");
  await localCommand(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", generated[0], "-an", "-c:v", "copy", "-n", silent]);
  await assert.rejects(recording.transcribe(silent, () => {}, signal()), /transcription_no_audio/u);
  await cleaned(records);
  assert.ok((await readdir(directory)).every(name => !name.startsWith("atris-share-transcription-")));
  assert.ok(isAbsolute(process.env.ATRIS_SHARE_WHISPER_MODEL));
});
