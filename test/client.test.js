import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { DshClient, mintRpcId } from "../lib/client.js";
import { Session } from "../lib/session.js";
import { LiveConversation } from "../lib/live.js";
import { lastAssistantText } from "../lib/fold.js";
const fixture = fileURLToPath(new URL("./fixtures/sdk-server.mjs", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function client(mode = "", options = {}) {
	return new DshClient({ command: `${quote(process.execPath)} ${quote(fixture)} ${mode}`, onDiagnostic: () => {}, timeoutMs: 1000, ...options });
}

test("fresh rpc ids", () => { assert.match(mintRpcId(), /^rpc-/); assert.notEqual(mintRpcId(), mintRpcId()); });
test("SDK handshake uses cwd and route, stderr is diagnostic; shutdown exits", async () => {
	let diagnostic = "";
	const c = client("", { cwd: "test", onDiagnostic: (s) => { diagnostic += s; } });
	const result = await c.initialize();
	assert.equal(result.cwd, c.cwd);
	assert.equal(result.params.cwd, c.cwd);
	assert.equal(result.params.provider, c.provider);
	assert.match(diagnostic, /fixture diagnostic/);
	await c.shutdown();
	assert.equal((await c.exited).code, 0);
	assert.equal(c.pending.size, 0);
});
test("converse waits for idle and folds notifications, not the enqueue receipt", async () => {
	const c = client();
	try {
		const s = await Session.create(c);
		const view = await s.converse("hello");
		assert.equal(lastAssistantText(view), "OK");
		assert.equal(view.messages[0].text, "hello");
		assert.equal(view.turnEnd.reason.kind, "completed");
	} finally { await c.shutdown(); }
});
test("LiveConversation reuses event folding and SDK capabilities are explicitly disabled", async () => {
	const c = client();
	const s = await Session.create(c);
	const conv = new LiveConversation({ client: c, session: s });
	try {
		await conv.open();
		await s.converse("hello");
		assert.equal(lastAssistantText(conv.snapshot()), "OK");
		assert.equal(conv.state.running, false);
		await conv.cancelTurn(); assert.match(conv.state.notice, /SDK モードでは未対応/);
		await conv.refreshHistory(); assert.match(conv.state.notice, /SDK モードでは未対応/);
		await conv.refreshSubagents(); assert.deepEqual(conv.state.subagents, []);
		assert.equal(conv.startHistorySync(), undefined);
		await assert.rejects(s.history(), /SDK モードでは未対応/);
		await assert.rejects(Session.list(c), /SDK モードでは未対応/);
		assert.equal(c.child.exitCode, null, "unsupported cancel must not kill child");
		const next = await Session.create(c);
		await conv.switchSession(next);
		assert.equal(conv.state.connected, true);
		await next.converse("next session");
		assert.equal(conv.state.messages[0].text, "next session");
		assert.equal(conv.state.messages.length, 2);

	} finally { conv.close(); await c.shutdown(); }
	assert.equal(c.listenerCount("notification"), 0);
});
test("JSON-RPC errors keep structured codes", async () => {
	const c = client();
	try {
		const s = await Session.create(c);
		await assert.rejects(s.prompt("rpc-error"), (e) => e.code === -32000 && /fixture rejected/.test(e.message));
	} finally { await c.shutdown(); }
});
for (const mode of ["malformed", "exit", "timeout"]) {
	test(`SDK ${mode} fails pending requests`, async () => {
		const c = client(mode, { timeoutMs: 100, initializeTimeoutMs: 100 });
		await assert.rejects(c.initialize(), /Invalid SDK stdout|exited|timeout/);
		if (mode !== "exit") await c.shutdown().catch(() => {});
		assert.equal(c.pending.size, 0);
	});
}
test("nonzero shutdown exit is failure", async () => {
	const c = client("bad-shutdown");
	await c.initialize();
	await assert.rejects(c.shutdown(), /exited|failed/);
});

test("CLI uses the SDK command override, emits reply, and reports child failure nonzero", async () => {
	const { spawnSync } = await import("node:child_process");
	const cli = fileURLToPath(new URL("../bin/tui.js", import.meta.url));
	const result = spawnSync(process.execPath, [cli, "run", "hello", "--cwd", "test", "--json"], {
		env: { ...process.env, DSH_SDK_COMMAND: `${quote(process.execPath)} ${quote(fixture)}` }, encoding: "utf8", timeout: 5000
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).reply, "OK");
	const failed = spawnSync(process.execPath, [cli, "run", "hello"], {
		env: { ...process.env, DSH_SDK_COMMAND: `${quote(process.execPath)} ${quote(fixture)} exit` }, encoding: "utf8", timeout: 5000
	});
	assert.equal(failed.status, 1, failed.stderr);
	assert.match(failed.stderr, /SDK process exited/);
});

test("shutdown during a conversation releases the completion waiter", async () => {
	const c = client();
	const s = await Session.create(c);
	let shutdown;
	c.on("notification", (method, params) => {
		if (method === "session.status" && params.status === "running") shutdown = c.shutdown();
	});
	await assert.rejects(s.converse("hello"), /SDK closed/);
	await shutdown;
	assert.equal(c.listenerCount("closed"), 0);
});
