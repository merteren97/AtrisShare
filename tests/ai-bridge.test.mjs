import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { OpenCodeBridge } from "../dist/packages/ai-bridge/src/opencode.js";

const AGENT = "atrisshare-proposal";
const MODEL = "fixture/scoped-model";
const EDIT = { inSeconds: 0, outSeconds: 2, crop: "vertical", gainDb: -3, caption: "İyi 🎬" };
const PROPOSAL = { summary: "Synthetic proposal 🎬", edit: EDIT };
const SESSION = "ses_fixture";
const PROMPT = "Prepared synthetic scoped context only — never publish.";
const signal = () => new AbortController().signal;
const event = (type, part, sessionID = SESSION) => ({ type, sessionID, part: { sessionID, ...part } });
const start = () => event("step_start", { id: "prt_start", type: "step-start" });
const text = (value = JSON.stringify(PROPOSAL), id = "prt_text") => event("text", { id, type: "text", text: value, time: { start: 1, end: 2 } });
const finish = (reason = "stop") => event("step_finish", { id: "prt_finish", type: "step-finish", reason });
const jsonl = events => events.map(value => JSON.stringify(value)).join("\n") + "\n";
const success = (value = JSON.stringify(PROPOSAL)) => jsonl([start(), text(value), finish()]);
const print = value => `process.stdout.write(${JSON.stringify(value)});`;
const code = message => error => error instanceof Error && error.message === message;

function resolvedAgent(config) {
  const configured = config.agent[AGENT];
  return { name: AGENT, mode: "primary", native: false, options: {}, steps: 1,
    tools: { bash: false, read: false, edit: false, task: false, skill: false, webfetch: false },
    // Official last-match-wins rules include overridden defaults.
    permission: [{ permission: "*", pattern: "*", action: "allow" },
      ...Object.entries(configured.permission).flatMap(([permission, value]) => typeof value === "string"
        ? [{ permission, pattern: "*", action: value }]
        : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action })))] };
}

/** Trusted process injection, backed by REAL Node children for lifecycle/UTF-8 tests. */
function fixture(options = {}) {
  const calls = [];
  const spawn = (executable, args, spawnOptions) => {
    const call = { executable, args, options: spawnOptions };
    calls.push(call);
    assert.equal(executable, process.execPath);
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(spawnOptions.detached, process.platform !== "win32");
    const config = JSON.parse(spawnOptions.env.OPENCODE_CONFIG_CONTENT);
    let script;
    if (args[0] === "--version") script = print(options.version ?? "1.19.5\n");
    else if (args[0] === "debug" && args[1] === "config") {
      options.config?.(config);
      script = print(options.configText ?? JSON.stringify(config));
    } else if (args[0] === "debug" && args[1] === "agent") {
      const agent = resolvedAgent(config);
      options.agent?.(agent);
      script = print(options.agentText ?? JSON.stringify(agent));
    } else if (args[0] === "models") script = print(options.models ?? `${MODEL}\n${MODEL}\nfixture/nested/model:latest\n`);
    else {
      assert.equal(args[0], "run");
      script = options.run?.(call) ?? print(success());
    }
    if (options.command) script = options.command(call, script);
    const child = nodeSpawn(process.execPath, ["-e", script], spawnOptions);
    call.child = child;
    return child;
  };
  return { calls, bridge: new OpenCodeBridge({ executable: process.execPath, spawn, timeoutMs: options.timeoutMs ?? 15_000,
    catalogDirectory: options.catalogDirectory }) };
}

async function cleaned(calls) {
  for (const call of calls) {
    assert.notEqual(call.child.exitCode ?? call.child.signalCode, null, "must await child close before settling");
    await assert.rejects(access(dirname(call.options.cwd)), { code: "ENOENT" });
  }
}

test("discovery validates isolated config and actual primary agent, deduplicates only CLI-reported IDs", async () => {
  const { bridge, calls } = fixture();
  assert.deepEqual(await bridge.discover(), { available: true, version: "1.19.5", models: [MODEL, "fixture/nested/model:latest"], auth: "cli-managed", error: null });
  assert.deepEqual(calls.map(call => call.args), [["--version", "--pure"], ["debug", "config", "--pure"],
    ["debug", "agent", AGENT, "--pure"], ["models", "--pure"]]);
  assert.equal(new Set(calls.map(call => call.options.cwd)).size, 1);
  await cleaned(calls);
});

test("proposal writes prompt only to stdin; exact schema result and fixed redacted progress", async () => {
  const { bridge, calls } = fixture({ run: () => `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(input!==${JSON.stringify(PROMPT)})process.exit(9);${print(success())}});` });
  const events = [];
  assert.deepEqual(await bridge.propose({ model: MODEL, prompt: PROMPT }, value => events.push(value), signal()), { ...PROPOSAL, sessionId: SESSION });
  assert.deepEqual(events, [{ type: "started", message: "Starting proposal" }, { type: "activity", message: "Preparing proposal" }]);
  assert.deepEqual(calls.at(-1).args, ["run", "--pure", "--format", "json", "--model", MODEL,
    "--agent", AGENT, "--title", "AtrisShare proposal"]);
  assert.ok(calls.every(call => !call.args.some(arg => arg.includes(PROMPT) || arg === "--auto")));
  await cleaned(calls);
});

test("child environment excludes parent tokens, OAuth, ATRIS_SHARE_*, Node options and config while preserving only credential store path", async t => {
  const sentinels = { ATRIS_SHARE_SOCIAL_TOKEN: "secret_social", ATRIS_SHARE_OPENCODE: process.execPath,
    OPENAI_API_KEY: "secret_openai", ANTHROPIC_AUTH_TOKEN: "secret_auth", NODE_OPTIONS: "--trace-warnings",
    OPENCODE_CONFIG: "untrusted-global", OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_SERVER_PASSWORD: "secret_server",
    OPENCODE_MODELS_PATH: "untrusted-models.json", OPENCODE_MODELS_URL: "https://untrusted.invalid" };
  const previous = Object.fromEntries(Object.keys(sentinels).map(key => [key, process.env[key]]));
  Object.assign(process.env, sentinels);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const { bridge, calls } = fixture({ run: call => {
    const env = call.options.env, root = dirname(call.options.cwd);
    for (const key of Object.keys(sentinels)) assert.equal(env[key], undefined);
    assert.equal(env.HOME, join(root, "home"));
    assert.equal(env.USERPROFILE, env.HOME);
    assert.equal(env.XDG_CONFIG_HOME, join(root, "config"));
    assert.equal(env.OPENCODE_CONFIG_DIR, join(root, "config", "opencode"));
    for (const key of ["XDG_CACHE_HOME", "XDG_STATE_HOME", "TEMP", "TMP", "TMPDIR", "OPENCODE_DB"]) assert.ok(env[key].startsWith(root));
    assert.ok(isAbsolute(env.XDG_DATA_HOME));
    assert.ok(!env.XDG_DATA_HOME.startsWith(root));
    for (const key of ["OPENCODE_PURE", "OPENCODE_DISABLE_DEFAULT_PLUGINS", "OPENCODE_DISABLE_PROJECT_CONFIG",
      "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_DISABLE_AUTOUPDATE"]) assert.equal(env[key], "1");
    assert.ok(Object.keys(env).every(key => /^(PATH|SYSTEMROOT|WINDIR|APPDATA|LOCALAPPDATA|HOME|USERPROFILE|XDG_\w+|TEMP|TMP|TMPDIR|OPENCODE_\w+|NO_COLOR)$/iu.test(key)));
    return print(success());
  } });
  await bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal());
  await cleaned(calls);
});

test("clip ranking uses the same isolated JSONL lifecycle with a strict ranking-only schema", async () => {
  const ranking = { ranking: [{ id: "a339d924-c69f-45eb-82ca-c88b5f78e61c", reason: "Complete thought" }] };
  const { bridge, calls } = fixture({ run: () => print(success(JSON.stringify(ranking))) });
  assert.deepEqual(await bridge.rankClips({ model: MODEL, prompt: PROMPT }, signal()), { ...ranking, sessionId: SESSION });
  await cleaned(calls);
  const invalid = fixture();
  await assert.rejects(invalid.bridge.rankClips({ model: MODEL, prompt: PROMPT }, signal()), code("ai_protocol_error"));
  await cleaned(invalid.calls);
});

test("UTF-8 JSONL survives every byte split, CRLF and an unterminated final line", async () => {
  const wire = success().trimEnd().replaceAll("\n", "\r\n");
  const { bridge, calls } = fixture({ run: () => `const b=Buffer.from(${JSON.stringify(wire)});let i=0;const timer=setInterval(()=>{if(i===b.length){clearInterval(timer);return;}process.stdout.write(b.subarray(i,i+1));i++;},1);` });
  assert.deepEqual(await bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), { ...PROPOSAL, sessionId: SESSION });
  await cleaned(calls);
});

test("accepts exactly a single json fence and assistant text split over parts", async () => {
  const value = JSON.stringify(PROPOSAL);
  for (const wire of [success("\n```json\n" + value + "\n```\n"),
    jsonl([start(), text(value.slice(0, 20)), text(value.slice(20), "prt_second"), finish()])]) {
    const { bridge, calls } = fixture({ run: () => print(wire) });
    assert.deepEqual(await bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), { ...PROPOSAL, sessionId: SESSION });
    await cleaned(calls);
  }
});

test("unsafe effective config fails closed before debug agent, models or inference; no raw config/errors escape", async t => {
  const cases = {
    "global permission": config => { config.permission.bash = "allow"; },
    "nested permission": config => { config.permission.read = { "*.env": "ask" }; },
    "missing wildcard": config => { delete config.permission["*"]; },
    "agent mode": config => { config.agent[AGENT].mode = "subagent"; },
    "agent disabled": config => { config.agent[AGENT].disable = true; },
    "agent name fallback": config => { config.agent[AGENT].name = "build"; },
    "agent missing": config => { delete config.agent[AGENT]; },
    "agent permission": config => { config.agent[AGENT].permission.read = "allow"; },
    "agent tool": config => { config.agent[AGENT].tools.bash = true; },
    "global tool": config => { config.tools.unknown_future_tool = true; },
    "mcp": config => { config.mcp.secret = { command: ["secret-token"] }; },
    "plugin": config => { config.plugin = ["secret-plugin"]; },
    "plugin origins": config => { config.plugin_origins = [{ spec: "secret-plugin" }]; },
    "provider override": config => { config.provider = { secret: { apiKey: "secret-token" } }; },
    "instructions": config => { config.instructions = ["secret-file"]; },
    "skills": config => { config.skills.urls = ["https://secret.invalid"]; },
    "unexpected agent": config => { config.agent.build = {}; },
    "default fallback": config => { config.default_agent = "build"; },
    "agent model override": config => { config.agent[AGENT].model = "secret/other"; }
  };
  for (const [name, config] of Object.entries(cases)) await t.test(name, async () => {
    const { bridge, calls } = fixture({ config });
    const result = await bridge.discover();
    assert.deepEqual(result, { available: false, version: "1.19.5", models: [], auth: "cli-managed", error: "ai_configuration_unsafe" });
    assert.equal(calls.length, 2);
    await cleaned(calls);
  });
});

test("actual resolved agent cannot introduce fallback, enabled/unknown tools or any permission after the deny barrier", async t => {
  const cases = {
    "wrong actual name": agent => { agent.name = "build"; },
    "wrong actual mode": agent => { agent.mode = "all"; },
    "enabled tool": agent => { agent.tools.bash = true; },
    "unknown tool": agent => { agent.tools.malicious = true; },
    "missing tools": agent => { delete agent.tools; },
    "permission allow": agent => { agent.permission.push({ permission: "read", pattern: "*", action: "allow" }); },
    "implicit truncate exception": agent => { agent.permission.push({ permission: "external_directory", pattern: "/tool-output/*", action: "allow" }); },
    "permission ask": agent => { agent.permission.push({ permission: "future", pattern: "*", action: "ask" }); },
    "missing barrier": agent => { agent.permission = [{ permission: "read", pattern: "*", action: "deny" }]; },
    "unknown options": agent => { agent.options = { tools: "unsafe" }; }
  };
  for (const [name, agent] of Object.entries(cases)) await t.test(name, async () => {
    const { bridge, calls } = fixture({ agent });
    await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_configuration_unsafe"));
    assert.equal(calls.length, 3);
    await cleaned(calls);
  });
});

test("version pin and malformed debug output never fall back to a different configuration", async () => {
  for (const options of [{ version: "1.20.0" }, { configText: "secret-token invalid json" }, { agentText: "secret-token" },
    { command: (call, script) => call.args[0] === "debug" ? "process.stderr.write('secret-token');process.exit(7);" : script }]) {
    const { bridge, calls } = fixture(options);
    const result = await bridge.discover();
    assert.equal(result.error, options.version ? "ai_version_unsupported" : "ai_configuration_unsafe");
    assert.equal(result.version, options.version ?? "1.19.5");
    assert.ok(calls.every(call => call.args[0] !== "run"));
    await cleaned(calls);
  }
});

test("models are newline verified IDs, never verbose output, controls, flags or invented fallbacks", async () => {
  for (const models of ["provider/model\nsecret-token", "provider/model\nprovider/bad\u001b[0m\n", "--model evil", "provider/model\rBAD\n", "{\"provider\":\"model\"}", "provider/model\n \n"]) {
    const { bridge } = fixture({ models });
    assert.equal((await bridge.discover()).error, "ai_protocol_error");
  }
  const { bridge, calls } = fixture({ models: "" });
  assert.deepEqual((await bridge.discover()).models, []);
  await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_model_unavailable"));
  assert.ok(calls.every(call => call.args[0] !== "run"));
});

test("protocol and proposal validation reject incomplete/error/tool output even with successful process exit", async t => {
  const invalid = {
    "empty": "", "raw prose": "secret-token\n", "bad JSONL": "{\n",
    "no start": jsonl([text(), finish()]), "no finish": jsonl([start(), text()]),
    "no text": jsonl([start(), finish()]), "no session": jsonl([{ ...start(), sessionID: undefined }, text(), finish()]),
    "mixed session": jsonl([start(), text(undefined, "prt_text"), finish()]).replace('"sessionID":"ses_fixture"', '"sessionID":"ses_other"'),
    "tool use": jsonl([start(), { type: "tool_use", sessionID: SESSION, part: { type: "tool", tool: "bash", input: "secret-token" } }]),
    "runtime error": jsonl([{ type: "error", error: { message: "secret-token" } }]),
    "unknown event": jsonl([{ type: "future_event", sessionID: SESSION }]),
    "failed finish": jsonl([start(), text(), finish("length")]),
    "tool calls finish": jsonl([start(), text(), finish("tool-calls")]),
    "duplicate text": jsonl([start(), text(), text(), finish()]),
    "text after finish": jsonl([start(), text(), finish(), text("{}", "prt_extra")]),
    "wrong part": jsonl([start(), event("text", { id: "prt_text", type: "tool", text: JSON.stringify(PROPOSAL) }), finish()]),
    "invalid UTF8": null,
    "multiple JSON": success(JSON.stringify(PROPOSAL) + JSON.stringify(PROPOSAL)),
    "surrounding prose": success("Here is JSON: " + JSON.stringify(PROPOSAL)),
    "multiple fences": success("```json\n" + JSON.stringify(PROPOSAL) + "\n```\n```json\n{}\n```"),
    "wrong fence": success("```javascript\n" + JSON.stringify(PROPOSAL) + "\n```"),
    "extra output property": success(JSON.stringify({ ...PROPOSAL, publish: true })),
    "empty summary": success(JSON.stringify({ ...PROPOSAL, summary: "" })),
    "long summary": success(JSON.stringify({ ...PROPOSAL, summary: "x".repeat(2001) })),
    "invalid edit": success(JSON.stringify({ ...PROPOSAL, edit: { ...EDIT, inSeconds: -1 } })),
    "extra edit property": success(JSON.stringify({ ...PROPOSAL, edit: { ...EDIT, command: "secret-token" } }))
  };
  for (const [name, wire] of Object.entries(invalid)) await t.test(name, async () => {
    const { bridge, calls } = fixture({ run: () => wire === null ? "process.stdout.write(Buffer.from([0xff,0xfe,10]));" : print(wire) });
    await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_protocol_error"));
    await cleaned(calls);
  });
});

test("nonzero exit and stderr are sanitized, never a fake successful proposal", async () => {
  const { bridge, calls } = fixture({ run: () => print(success()) + "process.stderr.write('OAuth secret-token');process.exitCode=9;" });
  await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_process_failed"));
  await cleaned(calls);
});

test("stdout and stderr caps terminate a live child and await close before deleting its workspace", async () => {
  for (const [stream, count] of [["stdout", 2 * 1024 * 1024 + 1], ["stderr", 32 * 1024 + 1]]) {
    const { bridge, calls } = fixture({ run: () => `process.${stream}.write(Buffer.alloc(${count},65));setInterval(()=>{},1000);` });
    await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_output_limit"));
    await cleaned(calls);
  }
});

test("a tool_use event aborts immediately rather than waiting for the child timeout", async () => {
  const { bridge, calls } = fixture({ run: () => print(jsonl([{ type: "tool_use", part: { tool: "bash" } }])) + "setInterval(()=>{},1000);" });
  await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_protocol_error"));
  await cleaned(calls);
});

async function waitForRun(calls) {
  for (let i = 0; i < 500; i++) {
    const call = calls.find(call => call.args[0] === "run");
    if (call) return call;
    await delay(10);
  }
  assert.fail("run child was not spawned");
}

test("cancellation shuts down owned tree, awaits close, then removes isolated temp files", async () => {
  const controller = new AbortController();
  const { bridge, calls } = fixture({ run: () => "setInterval(()=>{},1000);" });
  const pending = bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError", message: "ai_cancelled" });
  await waitForRun(calls);
  controller.abort(new Error("secret-token"));
  await rejected;
  await cleaned(calls);
});

test("timeout applies to the entire operation including preflight, with bounded constructor limits", async () => {
  const { bridge, calls } = fixture({ timeoutMs: 100, command: () => "setInterval(()=>{},1000);" });
  assert.equal((await bridge.discover()).error, "ai_timeout");
  await cleaned(calls);
  for (const timeoutMs of [0, -1, NaN, Infinity, 180001, 1.5]) assert.throws(() => new OpenCodeBridge({ timeoutMs }), code("ai_invalid_timeout"));
});

test("inference timeout kills the running child before returning ai_timeout", async () => {
  const { bridge, calls } = fixture({ timeoutMs: 1500, run: () => "setInterval(()=>{},1000);" });
  await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_timeout"));
  assert.ok(calls.some(call => call.args[0] === "run"));
  await cleaned(calls);
});

test("already cancelled calls spawn nothing; no arbitrary abort reason is returned", async () => {
  const controller = new AbortController(); controller.abort("secret-token");
  const { bridge, calls } = fixture();
  assert.equal((await bridge.discover(controller.signal)).error, "ai_cancelled");
  await assert.rejects(bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, controller.signal), { name: "AbortError", message: "ai_cancelled" });
  assert.equal(calls.length, 0);
});

test("input is bounded, model IDs cannot inject switches or controls, and only discovered models run", async () => {
  const { bridge, calls } = fixture();
  for (const input of [{ model: "--auto", prompt: PROMPT }, { model: "x/y\n--auto", prompt: PROMPT },
    { model: MODEL, prompt: "" }, { model: MODEL, prompt: "x\0y" }, { model: MODEL, prompt: "🎬".repeat(32769) }]) {
    await assert.rejects(bridge.propose(input, () => {}, signal()), code("ai_invalid_input"));
  }
  assert.equal(calls.length, 0);
  await assert.rejects(bridge.propose({ model: "other/model", prompt: PROMPT }, () => {}, signal()), code("ai_model_unavailable"));
  assert.ok(calls.every(call => call.args[0] !== "run"));
});

test("async spawn ENOENT and synchronous spawn failures are sanitized and do not become unhandled events", async () => {
  for (const spawn of [
    (_executable, _args, options) => nodeSpawn(join(options.cwd, "missing-opencode.exe"), [], options),
    () => { throw new Error("secret-token"); }
  ]) {
    const result = await new OpenCodeBridge({ executable: process.execPath, spawn }).discover();
    assert.equal(result.available, false);
    assert.ok(["ai_unavailable", "ai_process_failed"].includes(result.error));
    assert.ok(!JSON.stringify(result).includes("secret-token"));
  }
});

test("trusted fake spawn also gates resolution and cleanup on close, not exit or abort", async () => {
  const controller = new AbortController();
  let child, cwd;
  const spawn = (_executable, _args, options) => {
    cwd = options.cwd;
    child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => controller.abort());
    return child;
  };
  let settled = false;
  const pending = new OpenCodeBridge({ executable: process.execPath, spawn }).discover(controller.signal).then(value => { settled = true; return value; });
  while (!child) await delay(5);
  await delay(10);
  child.emit("exit", null, "SIGKILL");
  await delay(10);
  assert.equal(settled, false);
  await access(cwd);
  child.emit("close", null, "SIGKILL");
  assert.equal((await pending).error, "ai_cancelled");
  await assert.rejects(access(dirname(cwd)), { code: "ENOENT" });
});

test("executable overrides reject relative paths, shims and control characters", async () => {
  for (const executable of ["opencode", "./opencode", "C:\\bad\0opencode.exe", ...(process.platform === "win32"
    ? ["C:\\npm\\opencode.cmd", "C:\\npm\\opencode.ps1", "\\\\server\\opencode.exe"] : [])]) {
    assert.throws(() => new OpenCodeBridge({ executable }), code("ai_invalid_executable"));
  }
  // There is no shell fallback even if an explicitly selected binary is absent.
  const missing = process.platform === "win32" ? "C:\\missing-atris-share-fixture\\opencode.exe" : "/missing-atris-share-fixture/opencode";
  assert.equal((await new OpenCodeBridge({ executable: missing }).discover()).error, "ai_unavailable");
});

test("independent proposal calls use fresh isolated working/config directories and no session resume", async () => {
  const { bridge, calls } = fixture();
  await Promise.all([1, 2].map(() => bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, signal())));
  const runs = calls.filter(call => call.args[0] === "run");
  assert.equal(new Set(runs.map(call => call.options.cwd)).size, 2);
  assert.ok(runs.every(call => !call.args.some(arg => ["--continue", "--session", "--fork", "--attach"].includes(arg))));
  await cleaned(calls);
});

test("cancellation also kills a real grandchild before cleanup", async () => {
  const controller = new AbortController();
  const { bridge, calls } = fixture({ run: () => `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync('grandchild.pid',String(child.pid));setInterval(()=>{},1000);` });
  const pending = bridge.propose({ model: MODEL, prompt: PROMPT }, () => {}, controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const run = await waitForRun(calls);
  let pid;
  for (let i = 0; i < 300; i++) {
    if ((await readdir(run.options.cwd)).includes("grandchild.pid")) { pid = Number(await readFile(join(run.options.cwd, "grandchild.pid"), "utf8")); break; }
    await delay(10);
  }
  assert.ok(Number.isSafeInteger(pid));
  controller.abort();
  await rejected;
  let alive = true;
  for (let i = 0; i < 200; i++) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    await delay(10);
  }
  assert.equal(alive, false, "owned grandchild must not be orphaned");
  await cleaned(calls);
});

const BUILTIN = "fixture/old-builtin";
const NEW_MODEL = "fixture/new-catalog-model";
function rawCatalog(models) {
  return { fixture: { id: "fixture", name: "Fixture provider", env: [], npm: "@ai-sdk/openai-compatible",
    models: Object.fromEntries(models.map(id => [id.slice("fixture/".length), {
      id: id.slice("fixture/".length), name: id, release_date: "2026-01-01", attachment: false,
      reasoning: false, temperature: true, tool_call: false, limit: { context: 8192, output: 1024 }
    }])) } };
}

/** Emulates upstream disk override + swallowed download failure in real children. */
function catalogFixture(options = {}) {
  const state = options.state ?? { models: [NEW_MODEL], mode: "ok", refreshes: 0 };
  const load = `const fs=require('node:fs');const path=require('node:path');
    const source=process.env.OPENCODE_MODELS_PATH;
    const catalog=source?JSON.parse(fs.readFileSync(source,'utf8')):${JSON.stringify(rawCatalog([BUILTIN]))};
    const ids=Object.entries(catalog).flatMap(([p,v])=>Object.keys(v.models).map(m=>p+'/'+m));`;
  const result = fixture({ ...options, command(call, script) {
    assert.equal(call.options.env.OPENCODE_DISABLE_MODELS_FETCH, "1");
    assert.equal(call.options.env.OPENCODE_MODELS_URL, undefined);
    if (call.args[0] === "models" && call.args.includes("--refresh")) {
      state.refreshes++;
      assert.equal(call.options.env.OPENCODE_MODELS_PATH, undefined, "refresh must target fresh isolated upstream cache");
      if (state.mode === "hang") return "setInterval(()=>{},1000);";
      if (state.mode === "exit") return "process.stderr.write('secret-download-error');process.exit(7);";
      const content = state.mode === "corrupt" ? "{not-json" : state.mode === "shape" ? "{}" : JSON.stringify(state.catalog ?? rawCatalog(state.models));
      const write = state.mode === "missing" ? "" : `const fs=require('node:fs');const path=require('node:path');
        const file=path.join(process.env.XDG_CACHE_HOME,'opencode','models.json');fs.mkdirSync(path.dirname(file),{recursive:true});
        fs.writeFileSync(file,${JSON.stringify(content)});${state.mode === "oversized" ? "fs.truncateSync(file,16*1024*1024+1);" : ""}`;
      const notice = state.notice ?? "Models cache refreshed\n";
      const output = print(notice + (state.mode === "missing" ? [BUILTIN] : state.models).join("\n") + "\n");
      return state.delay ? `setTimeout(()=>{${write}${output}},${state.delay});` : write + output;
    }
    if (call.args[0] === "models") return state.listMode === "exit" ? "process.stderr.write('secret-load-error');process.exit(7);"
      : load + `process.stdout.write(${state.enumeratedModels ? JSON.stringify(state.enumeratedModels) : "ids"}.join('\\n')+'\\n');`;
    if (call.args[0] === "run") return load + `if(!source||!ids.includes(${JSON.stringify(call.args[call.args.indexOf("--model") + 1])}))process.exit(8);` + script;
    return script;
  } });
  return { ...result, state };
}

async function catalogDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "atris-catalog-test-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
async function snapshotFile(directory) {
  const files = await readdir(directory);
  assert.equal(files.length, 1, "only one atomic envelope, no leftover temporary files");
  assert.match(files[0], /^catalog-[a-f0-9]{64}\.json$/u);
  return join(directory, files[0]);
}
async function expireCatalog(directory) {
  const file = await snapshotFile(directory);
  const value = JSON.parse(await readFile(file, "utf8"));
  value.refreshedAt = new Date(Date.now() - 60 * 60 * 1000 - 1000).toISOString();
  await writeFile(file, JSON.stringify(value));
  return value;
}
async function waitForRefresh(calls, count = 1) {
  for (let i = 0; i < 500; i++) {
    const matches = calls.filter(call => call.args.includes("--refresh"));
    if (matches.length >= count) return matches.at(-1);
    await delay(10);
  }
  assert.fail("refresh child was not spawned");
}

test("catalog first refresh persists raw catalog and new IDs; a new bridge discovers and proposes without fetching or built-in fallback", async t => {
  const directory = await catalogDirectory(t);
  const first = catalogFixture({ catalogDirectory: directory });
  const found = await first.bridge.discover();
  assert.equal(found.available, true);
  assert.deepEqual(found.models, [NEW_MODEL]);
  assert.equal(found.catalog.state, "current");
  assert.ok(Number.isFinite(Date.parse(found.catalog.refreshedAt)));
  assert.equal(first.state.refreshes, 1);
  const file = await snapshotFile(directory);
  const envelope = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(envelope, { schemaVersion: 1, executable: process.execPath, version: "1.19.5",
    refreshedAt: found.catalog.refreshedAt, catalog: rawCatalog([NEW_MODEL]), models: [NEW_MODEL] });
  assert.ok(first.calls.every(call => !["run", "auth"].includes(call.args[0])));
  const second = catalogFixture({ catalogDirectory: directory, state: { models: [BUILTIN], mode: "missing", refreshes: 0 } });
  assert.deepEqual(await second.bridge.discover(), found);
  assert.deepEqual(await second.bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal()), { ...PROPOSAL, sessionId: SESSION });
  assert.equal(second.state.refreshes, 0);
  const pinned = second.calls.filter(call => ["run", "models"].includes(call.args[0]));
  assert.ok(pinned.every(call => call.options.env.OPENCODE_MODELS_PATH === join(call.options.cwd, "models.json")));
  await cleaned([...first.calls, ...second.calls]);
});

test("forced refresh bypasses TTL and replaces models used by subsequent discovery and inference", async t => {
  const directory = await catalogDirectory(t);
  const { bridge, calls, state } = catalogFixture({ catalogDirectory: directory });
  await bridge.discover();
  state.models = ["fixture/replacement"];
  const refreshed = await bridge.discover(undefined, { refresh: true });
  assert.equal(refreshed.available, true);
  assert.deepEqual(refreshed.models, state.models);
  assert.equal(state.refreshes, 2);
  assert.deepEqual((await bridge.discover()).models, state.models);
  await bridge.propose({ model: state.models[0], prompt: PROMPT }, () => {}, signal());
  await assert.rejects(bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_model_unavailable"));
  assert.equal(state.refreshes, 2);
  assert.deepEqual(JSON.parse(await readFile(await snapshotFile(directory), "utf8")).catalog, rawCatalog(state.models));
  await cleaned(calls);
});

test("raw official catalog aliases do not invalidate unrelated selectable models", async t => {
  const directory = await catalogDirectory(t);
  const catalog = rawCatalog([NEW_MODEL, "fixture/@cf/openai/gpt-oss-20b", "fixture/~google/gemini-flash-latest"]);
  const { bridge, calls } = catalogFixture({ catalogDirectory: directory,
    state: { models: [NEW_MODEL], mode: "ok", refreshes: 0, catalog, enumeratedModels: [NEW_MODEL] } });
  const found = await bridge.discover();
  assert.equal(found.available, true);
  assert.deepEqual(found.models, [NEW_MODEL]);
  assert.deepEqual(JSON.parse(await readFile(await snapshotFile(directory), "utf8")).catalog, catalog);
  await bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal());
  await cleaned(calls);
});

test("swallowed download failure retains stale IDs, timestamp and version, does not overwrite disk, and retries even after a fresh forced-refresh failure", async t => {
  const directory = await catalogDirectory(t);
  const { bridge, calls, state } = catalogFixture({ catalogDirectory: directory });
  const found = await bridge.discover();
  const file = await snapshotFile(directory);
  const before = await readFile(file, "utf8");
  state.mode = "missing";
  const failed = await bridge.discover(undefined, { refresh: true });
  assert.deepEqual(failed, { available: false, version: "1.19.5", models: [NEW_MODEL], auth: "cli-managed",
    error: "ai_catalog_refresh_failed", catalog: { state: "stale", refreshedAt: found.catalog.refreshedAt } });
  assert.equal(await readFile(file, "utf8"), before);
  state.mode = "ok"; state.models = ["fixture/recovered"];
  assert.deepEqual((await bridge.discover()).models, state.models);
  assert.equal(state.refreshes, 3);
  await cleaned(calls);
});

test("expired persisted catalogs refresh automatically; failed refresh remains stale across new bridges and retries on next discovery", async t => {
  const directory = await catalogDirectory(t);
  const first = catalogFixture({ catalogDirectory: directory });
  await first.bridge.discover();
  const expired = await expireCatalog(directory);
  const second = catalogFixture({ catalogDirectory: directory, state: { models: [BUILTIN], mode: "missing", refreshes: 0 } });
  const failed = await second.bridge.discover();
  assert.equal(failed.error, "ai_catalog_refresh_failed");
  assert.equal(failed.version, "1.19.5");
  assert.deepEqual(failed.models, [NEW_MODEL]);
  assert.deepEqual(failed.catalog, { state: "stale", refreshedAt: expired.refreshedAt });
  // Inference can use the last-known raw snapshot, but cannot perform a refresh.
  await second.bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal());
  assert.equal(second.state.refreshes, 1);
  second.state.mode = "ok";
  const recovered = await second.bridge.discover();
  assert.equal(recovered.available, true);
  assert.equal(recovered.catalog.state, "current");
  assert.deepEqual(recovered.models, [BUILTIN]);
  assert.equal(second.state.refreshes, 2);
  await cleaned([...first.calls, ...second.calls]);
});

test("refresh is not published until enumeration from the pinned raw catalog also succeeds", async t => {
  const directory = await catalogDirectory(t);
  const { bridge, calls, state } = catalogFixture({ catalogDirectory: directory });
  const first = await bridge.discover();
  const file = await snapshotFile(directory), before = await readFile(file, "utf8");
  state.models = ["fixture/unloadable"]; state.listMode = "exit";
  const failed = await bridge.discover(undefined, { refresh: true });
  assert.deepEqual(failed, { ...first, available: false, error: "ai_catalog_refresh_failed",
    catalog: { ...first.catalog, state: "stale" } });
  assert.equal(await readFile(file, "utf8"), before);
  await snapshotFile(directory);
  await cleaned(calls);
});

test("missing/corrupt/oversized refresh files cannot be mistaken for CLI success, even with model IDs and exact notice", async t => {
  for (const mode of ["missing", "corrupt", "shape", "oversized", "exit"]) await t.test(mode, async t => {
    const directory = await catalogDirectory(t);
    const { bridge, calls } = catalogFixture({ catalogDirectory: directory, state: { models: [NEW_MODEL], mode, refreshes: 0 } });
    assert.deepEqual(await bridge.discover(), { available: false, version: "1.19.5", models: [], auth: "cli-managed",
      error: "ai_catalog_refresh_failed", catalog: { state: "stale", refreshedAt: null } });
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_catalog_refresh_failed"));
    assert.ok(calls.every(call => call.args[0] !== "run"));
    await cleaned(calls);
  });
});

test("corrupt, oversized and wrong-key persisted envelopes trigger recovery; inference alone never downloads", async t => {
  for (const corruption of ["json", "oversized", "executable", "version", "timestamp", "models", "catalog", "schema"]) await t.test(corruption, async t => {
    const directory = await catalogDirectory(t);
    const first = catalogFixture({ catalogDirectory: directory });
    await first.bridge.discover();
    const file = await snapshotFile(directory);
    const envelope = JSON.parse(await readFile(file, "utf8"));
    if (corruption === "json") await writeFile(file, "{invalid");
    else if (corruption === "oversized") await truncate(file, 21 * 1024 * 1024);
    else {
      if (corruption === "executable") envelope.executable = "other-executable";
      if (corruption === "version") envelope.version = "1.20.0";
      if (corruption === "timestamp") envelope.refreshedAt = "invalid";
      if (corruption === "models") envelope.models = ["--secret-token"];
      if (corruption === "catalog") envelope.catalog = {};
      if (corruption === "schema") envelope.schemaVersion = 2;
      await writeFile(file, JSON.stringify(envelope));
    }
    const second = catalogFixture({ catalogDirectory: directory });
    await assert.rejects(second.bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_catalog_refresh_failed"));
    assert.equal(second.state.refreshes, 0);
    assert.equal((await second.bridge.discover()).available, true);
    assert.equal(second.state.refreshes, 1);
    await snapshotFile(directory);
    await cleaned([...first.calls, ...second.calls]);
  });
});

test("refresh accepts only the exact known notice, otherwise model IDs remain strict", async t => {
  for (const notice of ["", "Models cache refreshed\n", "Models cache refreshed: secret-token\n", "\u001b[92mModels cache refreshed\u001b[0m\n"]) await t.test(JSON.stringify(notice), async t => {
    const directory = await catalogDirectory(t);
    const { bridge, calls } = catalogFixture({ catalogDirectory: directory, state: { models: [NEW_MODEL], mode: "ok", refreshes: 0, notice } });
    const found = await bridge.discover();
    assert.equal(found.available, notice === "" || notice === "Models cache refreshed\n");
    if (!found.available) assert.equal(found.error, "ai_catalog_refresh_failed");
    await cleaned(calls);
  });
});

test("explicit refresh without a directory retains an in-memory snapshot reused by inference", async () => {
  const { bridge, calls, state } = catalogFixture();
  assert.deepEqual((await bridge.discover()).models, [BUILTIN], "legacy mode is unchanged until refresh requested");
  const found = await bridge.discover(undefined, { refresh: true });
  assert.equal(found.available, true);
  assert.equal(found.catalog, undefined, "do not imply persistent catalog configuration");
  assert.deepEqual(found.models, [NEW_MODEL]);
  await bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal());
  assert.equal(state.refreshes, 1);
  await cleaned(calls);
});

test("shared bridge concurrent discoveries perform one initial download; independent bridge instances also serialize the same cache", async t => {
  const directory = await catalogDirectory(t);
  const first = catalogFixture({ catalogDirectory: directory, state: { models: [NEW_MODEL], mode: "ok", refreshes: 0, delay: 150 } });
  const second = catalogFixture({ catalogDirectory: directory });
  const results = await Promise.all([first.bridge.discover(), first.bridge.discover(), second.bridge.discover()]);
  assert.ok(results.every(result => result.available && result.models[0] === NEW_MODEL));
  assert.equal(first.state.refreshes + second.state.refreshes, 1);
  await Promise.all([first.bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal()),
    first.bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal())]);
  assert.equal(new Set(first.calls.filter(call => call.args[0] === "run").map(call => call.options.cwd)).size, 2);
  await cleaned([...first.calls, ...second.calls]);
});

test("overlapping forced refreshes serialize publication so an older download cannot overwrite the newer request", async t => {
  const directory = await catalogDirectory(t);
  const first = catalogFixture({ catalogDirectory: directory, state: { models: ["fixture/older"], mode: "ok", refreshes: 0, delay: 500 } });
  const second = catalogFixture({ catalogDirectory: directory, state: { models: ["fixture/newer"], mode: "ok", refreshes: 0 } });
  const older = first.bridge.discover(undefined, { refresh: true });
  await waitForRefresh(first.calls);
  const newer = second.bridge.discover(undefined, { refresh: true });
  assert.deepEqual((await older).models, ["fixture/older"]);
  assert.deepEqual((await newer).models, ["fixture/newer"]);
  assert.deepEqual(JSON.parse(await readFile(await snapshotFile(directory), "utf8")).models, ["fixture/newer"]);
  assert.deepEqual((await first.bridge.discover()).models, ["fixture/newer"]);
  await cleaned([...first.calls, ...second.calls]);
});

test("catalog refresh cancellation and timeout kill the real child, retain prior cache, and permit recovery", async t => {
  for (const mode of ["cancel", "timeout"]) await t.test(mode, async t => {
    const directory = await catalogDirectory(t);
    const first = catalogFixture({ catalogDirectory: directory });
    await first.bridge.discover();
    const file = await snapshotFile(directory), before = await readFile(file, "utf8");
    const second = catalogFixture({ catalogDirectory: directory, timeoutMs: mode === "timeout" ? 1500 : 15_000,
      state: { models: [NEW_MODEL], mode: "hang", refreshes: 0 } });
    const controller = new AbortController();
    const pending = second.bridge.discover(controller.signal, { refresh: true });
    await waitForRefresh(second.calls);
    if (mode === "cancel") controller.abort(new Error("secret-token"));
    const failed = await pending;
    assert.equal(failed.error, mode === "cancel" ? "ai_cancelled" : "ai_timeout");
    assert.equal(failed.version, "1.19.5");
    assert.deepEqual(failed.models, [NEW_MODEL]);
    assert.equal(failed.catalog.state, "stale");
    assert.equal(await readFile(file, "utf8"), before);
    await cleaned(second.calls);
    second.state.mode = "ok";
    assert.equal((await second.bridge.discover()).available, true);
    await cleaned([...first.calls, ...second.calls]);
  });
});

test("cancelling a queued catalog consumer does not cancel the owning refresh or wedge later consumers", async t => {
  const directory = await catalogDirectory(t);
  const { bridge, calls } = catalogFixture({ catalogDirectory: directory, state: { models: [NEW_MODEL], mode: "ok", refreshes: 0, delay: 1000 } });
  const owner = bridge.discover();
  await waitForRefresh(calls);
  const controller = new AbortController();
  const waiter = bridge.discover(controller.signal);
  for (let i = 0; i < 500 && calls.filter(call => call.args[0] === "debug" && call.args[1] === "agent").length < 2; i++) await delay(5);
  await delay(50);
  controller.abort();
  assert.equal((await waiter).error, "ai_cancelled");
  assert.equal((await owner).available, true);
  assert.equal((await bridge.discover()).available, true);
  await cleaned(calls);
});

test("unsupported versions preserve only bounded semver and fail closed before config, catalog or inference", async t => {
  const directory = await catalogDirectory(t);
  for (const version of ["1.20.0", "1.19.5-beta.1+build", "1.19.5+build", "01.19.5", "secret-token", "1.19.5\nsecret-token", "1.19.5+" + "a".repeat(60)]) {
    const { bridge, calls } = catalogFixture({ catalogDirectory: directory, version });
    const found = await bridge.discover();
    assert.equal(found.error, "ai_version_unsupported");
    assert.equal(found.version, ["1.20.0", "1.19.5-beta.1+build", "1.19.5+build"].includes(version) ? version : null);
    assert.deepEqual(found.catalog, { state: "stale", refreshedAt: null });
    assert.equal(calls.length, 1);
    await assert.rejects(bridge.propose({ model: NEW_MODEL, prompt: PROMPT }, () => {}, signal()), code("ai_version_unsupported"));
    assert.ok(calls.every(call => call.args[0] === "--version"));
    await cleaned(calls);
  }
  assert.deepEqual(await readdir(directory), []);
  for (const catalogDirectory of ["relative/catalog", "bad\0path"]) {
    assert.throws(() => new OpenCodeBridge({ catalogDirectory }), code("ai_invalid_catalog_directory"));
  }
});
