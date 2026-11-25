// SDK stdio edge cases: shutdown, failures, completion fallbacks, CLI contract, early input.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DshClient } from "../lib/client.js";
import { Session } from "../lib/session.js";
import { LiveConversation } from "../lib/live.js";
import { MuxStream } from "../lib/stream.js";
import { lastAssistantText } from "../lib/fold.js";

const fixture = fileURLToPath(new URL("./fixtures/sdk-server.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../bin/tui.js", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (mode = "") => `${quote(process.execPath)} ${quote(fixture)} ${mode}`;
const client = (mode = "", options = {}) =>
	new DshClient({ command: command(mode), onDiagnostic: () => {}, timeoutMs: 1000, ...options });
const runCli = (args, mode = "") => spawnSync(process.execPath, [cli, ...args], {
	env: { ...process.env, DSH_SDK_COMMAND: command(mode) }, encoding: "utf8", timeout: 10_000
});

test("shutdown RPC timeout still waits for exit, then SIGTERM; child is not left running", async () => {
	const c = client("hang-shutdown", { timeoutMs: 150, killGraceMs: 1000 });
	await c.initialize();
	await assert.rejects(c.shutdown(), /terminated with SIGTERM/);
	assert.equal(c.closedInfo.signal, "SIGTERM");
	assert.notEqual(c.child.signalCode ?? c.child.exitCode, null);
});

test("child ignoring SIGTERM is SIGKILLed after the grace period", async () => {
	const c = client("ignore-term", { timeoutMs: 150, killGraceMs: 200 });
	await c.initialize();
	await assert.rejects(c.shutdown(), /terminated with SIGKILL/);
	assert.equal(c.closedInfo.signal, "SIGKILL");
});

test("shutdown RPC error is reported only after the child has exited", async () => {
	const c = client("shutdown-error");
	await c.initialize();
	await assert.rejects(c.shutdown(), (e) => e.code === -32603 && /fixture shutdown failed/.test(e.message));
	assert.deepEqual(c.closedInfo, { code: 0, signal: null });
});

test("shutdown after an earlier failure waits for exit and rethrows the original failure", async () => {
	const c = client("exit");
	const failure = await c.initialize().catch((e) => e);
	assert.match(failure.message, /code=7/);
	await assert.rejects(c.shutdown(), (e) => e === failure);
	assert.equal(c.closedInfo.code, 7);
});

test("server→client requests are answered with -32601 instead of being dropped", async () => {
	const c = client("server-request");
	try {
		const result = await c.initialize();
		assert.equal(result.serverRequestError.code, -32601);
		assert.match(result.serverRequestError.message, /approval\/request/);
	} finally { await c.shutdown(); }
});

test("child crash during a conversation reports exit code", async () => {
	const c = client("crash-in-turn");
	const s = await Session.create(c);
	await assert.rejects(s.converse("hello"), /code=5/);
	await assert.rejects(c.shutdown(), /code=5/);
});

test("missing cwd fails with a clear directory error (library and CLI)", async () => {
	const c = client("", { cwd: "test/does-not-exist" });
	await assert.rejects(c.initialize(), /ディレクトリが存在しません/);
	const result = runCli(["run", "hello", "--cwd", "test/does-not-exist"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /dsh-tui: ディレクトリが存在しません: .*does-not-exist/);
});

test("rejected handshake is retryable; LiveConversation detaches its listeners on failure", async () => {
	const c = client("init-error-once");
	const s = await Session.create(c);
	const conv = new LiveConversation({ client: c, session: s });
	try {
		await assert.rejects(conv.open(), (e) => e.code === -32602);
		assert.equal(c.listenerCount("notification"), 0);
		assert.equal(c.listenerCount("failure"), 0);
		await conv.open();
		assert.equal(conv.state.connected, true);
		await s.converse("hello");
		assert.equal(lastAssistantText(conv.snapshot()), "OK");
	} finally { conv.close(); await c.shutdown(); }
});

test("shutdown before spawn blocks initialize; no child is ever spawned", async () => {
	const c = client();
	await c.shutdown();
	await assert.rejects(c.initialize(), /shutting down/);
	await assert.rejects(Session.create(c).then((s) => s.prompt("hello")), /shutting down/);
	assert.equal(c.child, undefined);
});

for (const mode of ["no-running", "no-status", "idle-before-end"]) {
	test(`converse completes on turn/end without observed running (${mode})`, async () => {
		const c = client(mode);
		try {
			const s = await Session.create(c);
			const started = Date.now();
			const view = await s.converse("hello", { timeoutMs: 10_000 });
			assert.equal(lastAssistantText(view), "OK");
			assert.ok(Date.now() - started < 3000, "must not wait for the conversation timeout");
		} finally { await c.shutdown(); }
	});
}

test("subagent notifications: MuxStream passes them through, transcript ignores them", async () => {
	const c = client("subagent");
	const s = await Session.create(c);
	const conv = new LiveConversation({ client: c, session: s });
	const ac = new AbortController();
	const types = [];
	const reader = (async () => {
		for await (const frame of new MuxStream(c).frames({ signal: ac.signal })) types.push(frame.payload.type);
	})();
	try {
		await conv.open();
		const view = await s.converse("hello");
		assert.equal(lastAssistantText(view), "OK");
		assert.equal(conv.state.messages.some((m) => m.text === "CHILD"), false);
		assert.ok(types.includes("subagent/started") && types.includes("subagent/finished"));
	} finally { ac.abort(); await reader; conv.close(); await c.shutdown(); }
});

test("MuxStream ends when the client shuts down normally and unsubscribes", async () => {
	const c = client();
	const iterator = new MuxStream(c).frames();
	const first = iterator.next();
	await c.initialize();
	await c.shutdown();
	assert.equal((await first).done, true);
	assert.equal(c.listenerCount("closed"), 0);
	assert.equal(c.listenerCount("notification"), 0);
});

test("run --json keeps the legacy schema with explicit nulls", () => {
	const result = runCli(["run", "hello", "--cwd", "test", "--json"]);
	assert.equal(result.status, 0, result.stderr);
	const out = JSON.parse(result.stdout);
	assert.deepEqual(Object.keys(out), ["sessionId", "agentPreset", "reply", "turn", "toolCalls", "usage", "turnEnd"]);
	assert.equal(out.agentPreset, null);
	assert.equal(out.reply, "OK");
	assert.equal(out.toolCalls, 0);
	assert.deepEqual(out.usage, { input: 3, output: 1 });
	assert.equal(out.turnEnd, "completed");
	assert.match(result.stdout, /^\{\n {2}"sessionId"/);
});

test("CLI: original error wins over a later shutdown failure, both reported", () => {
	const result = runCli(["run", "rpc-error", "--cwd", "test"], "shutdown-error");
	assert.equal(result.status, 1);
	const lines = result.stderr.trim().split("\n").filter((l) => l.startsWith("dsh-tui:"));
	assert.deepEqual(lines, ["dsh-tui: shutdown failed: fixture shutdown failed", "dsh-tui: fixture rejected"]);
});

// PTY helpers for the interactive entry point (node-pty is a devDependency).
async function startPty(t, mode) {
	let spawnPty;
	try { ({ spawn: spawnPty } = await import("node-pty")); } catch { t.skip("node-pty unavailable"); return null; }
	const pty = spawnPty(process.execPath, [cli, "test"], {
		name: "xterm-256color", cols: 100, rows: 30, cwd: fileURLToPath(new URL("..", import.meta.url)),
		env: { ...process.env, DSH_SDK_COMMAND: command(mode), NO_COLOR: "1" }
	});
	const state = { buffer: "", exited: null, pty };
	pty.onData((data) => { state.buffer += data; });
	pty.onExit((e) => { state.exited = e; });
	state.text = () => state.buffer.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
	state.waitFor = async (predicate, ms) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) { if (predicate()) return true; await sleep(25); }
		return false;
	};
	return state;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("interactive: input before initialize is sent verbatim and in order after the handshake", async (t) => {
	const p = await startPty(t, "slow-init,echo");
	if (!p) return;
	try {
		assert.ok(await p.waitFor(() => p.text().includes("接続中"), 5000), "connecting indicator rendered before handshake");
		// Make the input mode explicit: ESC → normal, i → insert; the HUD shows the mode.
		p.pty.write("\x1b"); await sleep(150);
		p.pty.write("i"); await sleep(150);
		assert.match(p.text().slice(-400), /insert/);
		p.pty.write("EARLY_ONE"); await sleep(100);
		p.pty.write("\r"); await sleep(100);
		p.pty.write("EARLY_TWO"); await sleep(100);
		p.pty.write("\r");
		assert.ok(p.text().includes("接続中"), "both inputs were submitted before initialize completed");
		assert.ok(await p.waitFor(() => p.text().includes("ECHO#2:EARLY_TWO"), 5000), `second reply; got: ${p.text().slice(-500)}`);
		assert.ok(p.text().includes("ECHO#1:EARLY_ONE"), "first input reached the SDK first, unchanged");
		p.pty.write("/exit"); await sleep(300);
		p.pty.write("\r");
		assert.ok(await p.waitFor(() => p.exited, 5000), "exits");
		assert.equal(p.exited.exitCode, 0);
	} finally { if (!p.exited) p.pty.kill(); }
});

test("interactive: /exit while initialize is pending exits 0 without an error", async (t) => {
	const p = await startPty(t, "slow-init");
	if (!p) return;
	try {
		assert.ok(await p.waitFor(() => p.text().includes("接続中"), 5000));
		p.pty.write("/exit"); await sleep(200);
		p.pty.write("\r");
		assert.ok(await p.waitFor(() => p.exited, 5000), "exits");
		assert.equal(p.exited.exitCode, 0);
		assert.doesNotMatch(p.text(), /dsh-tui: /);
	} finally { if (!p.exited) p.pty.kill(); }
});

for (const [signal, expected, shutdownError] of [["SIGINT", 130, false], ["SIGINT", 130, true], ["SIGTERM", 143, true]]) {
	test(`CLI: ${signal} during a turn preserves exit ${expected} (shutdownError=${shutdownError})`, async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn(process.execPath, [cli, "run", "hello", "--cwd", "test"], {
			env: { ...process.env, DSH_SDK_COMMAND: command(shutdownError ? "stall-turn,shutdown-error" : "stall-turn") }, stdio: ["ignore", "pipe", "pipe"]
		});
		let stderr = "";
		child.stderr.on("data", (d) => { stderr += d; });
		const deadline = Date.now() + 5000;
		while (!stderr.includes("fixture diagnostic") && Date.now() < deadline) await sleep(25);
		await sleep(100); // prompt sent, turn stalled
		child.kill(signal);
		const code = await new Promise((r) => child.on("close", (c) => r(c)));
		assert.equal(code, expected, stderr);
		if (shutdownError) assert.match(stderr, /shutdown failed: fixture shutdown failed/);
		else assert.doesNotMatch(stderr, /dsh-tui:/);
	});
}

test("CLI text output: reply on stdout (legacy fallback only when no assistant text)", () => {
	const result = runCli(["run", "hello", "--cwd", "test"]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "OK\n");
});

// T524 review regressions: validate public contracts and asynchronous ordering.
test("legacy URL constructor is rejected before starting any runtime", () => {
	assert.throws(() => new DshClient("http://example.invalid"), (e) => e.code === "sdk-legacy-baseurl");
});
for (const error of [false, true]) {
	test(`running then idle before delayed turn/end preserves outcome (error=${error})`, async () => {
		const c = client(error ? "running-idle-before-end,turn-error" : "running-idle-before-end");
		try {
			const s = await Session.create(c);
			if (error) await assert.rejects(s.converse("hello"), /SDK turn failed/);
			else {
				const view = await s.converse("hello");
				assert.equal(lastAssistantText(view), "OK");
				assert.equal(view.turnEnd?.reason.kind, "completed");
			}
		} finally { await c.shutdown(); }
	});
}
test("initialize has a separate longer timeout than normal RPCs", async () => {
	const c = client("slow-init", { timeoutMs: 100, initializeTimeoutMs: 2000 });
	try { await c.initialize(); } finally { await c.shutdown(); }
});
test("initialize timeout is fatal and never sends a second handshake", async () => {
	const c = client("timeout", { timeoutMs: 100, initializeTimeoutMs: 100 });
	const failure = await c.initialize().catch(e => e);
	try {
		assert.match(failure.message, /timeout: initialize/);
		assert.equal(c.failure, failure);
		await assert.rejects(c.initialize(), e => e === failure);
	} finally { await c.shutdown().catch(() => {}); }
});
test("SDK Session.create rejects unsupported options instead of discarding them", async () => {
	const c = client();
	for (const options of [{cwd: "/other"}, {cwd: null}, {cwd: 42}, {agentPreset: "code"}, {sessionId: "old"}])
		await assert.rejects(Session.create(c, options), e => e.code === "sdk-unsupported");
	assert.equal((await Session.create(c, {cwd: c.cwd})).cwd, c.cwd);
	assert.equal(c.child, undefined);
});
test("concurrent SDK open calls both await initialize", async () => {
	const c = client("slow-init");
	const conv = new LiveConversation({client: c, session: await Session.create(c)});
	try {
		const first = conv.open();
		await conv.open();
		assert.equal(conv.state.connected, true);
		await first;
		assert.equal(c.listenerCount("notification"), 1);
	} finally { conv.close(); await c.shutdown(); }
});
test("MuxStream drains notifications queued before failure", async () => {
	const c = client();
	const iterator = new MuxStream(c).frames();
	const pending = iterator.next();
	await c.initialize();
	c.emit("notification", "session.status", {sessionId: "s", status: "running"});
	await pending;
	c.emit("notification", "session.event", {sessionId: "s", event: {type: "turn/end"}});
	const failure = new Error("fixture failure");
	c.emit("failure", failure);
	try {
		assert.equal((await iterator.next()).value?.payload.event.type, "turn/end");
		await assert.rejects(iterator.next(), e => e === failure);
	} finally { await iterator.return(); await c.shutdown(); }
});
