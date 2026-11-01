import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile, readdir } from "node:fs/promises";
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
  return { calls, bridge: new OpenCodeBridge({ executable: process.execPath, spawn, timeoutMs: options.timeoutMs ?? 15_000 }) };
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
    OPENCODE_CONFIG: "untrusted-global", OPENCODE_PERMISSION: '{"*":"allow"}', OPENCODE_SERVER_PASSWORD: "secret_server" };
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
    assert.deepEqual(result, { available: false, version: null, models: [], auth: "cli-managed", error: "ai_configuration_unsafe" });
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
    assert.equal((await bridge.discover()).error, "ai_configuration_unsafe");
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
