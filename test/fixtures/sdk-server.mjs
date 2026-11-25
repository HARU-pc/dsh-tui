// Fake `dsh --profile sdk` runtime for tests. argv[2] selects comma-separated edge modes
// (e.g. "slow-init,echo"); every mode flag supports composition.
import { createInterface } from "node:readline";
const modes = new Set((process.argv[2] ?? "").split(",").filter(Boolean));
const has = (m) => modes.has(m);
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
// Exit only after queued stdout is flushed; a bare process.exit() right after write can truncate frames.
const exitAfterFlush = (code) => process.stdout.write("", () => process.exit(code));
let promptCount = 0;
const notify = (method, params) => send({ method, params });
const response = (id, result) => send({ id, result });
let initialized = false, seq = 0, initAttempts = 0, pendingInit = null;
if (has("hang-shutdown") || has("ignore-term")) setInterval(() => {}, 1000); // survive EOF
if (has("ignore-term")) process.on("SIGTERM", () => {});
const handshake = (id, params, extra = {}) => {
	initialized = true;
	process.stderr.write("fixture diagnostic\n");
	response(id, { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "fixture" }, cwd: process.cwd(), params, ...extra });
};
for await (const line of createInterface({ input: process.stdin })) {
	const { id, method, params, error } = JSON.parse(line);
	if (method === undefined) {
		// Client response to our server→client request.
		if (id === "srv-1" && pendingInit) { handshake(pendingInit.id, pendingInit.params, { serverRequestError: error }); pendingInit = null; }
		continue;
	}
	if (method === "shutdown") {
		if (has("hang-shutdown") || has("ignore-term")) continue;
		if (has("shutdown-error")) { send({ id, error: { code: -32603, message: "fixture shutdown failed" } }); continue; }
		response(id, {});
		exitAfterFlush(has("bad-shutdown") ? 9 : 0);
		continue;
	}
	if (method === "initialize") {
		initAttempts++;
		if (has("exit")) { exitAfterFlush(7); continue; }
		if (has("malformed")) { console.log("not json"); continue; }
		if (has("timeout")) continue;
		if (!params.cwd || !params.provider || !params.model) throw new Error("missing handshake fields");
		if (has("init-error-once") && initAttempts === 1) { send({ id, error: { code: -32602, message: "fixture unknown model" } }); continue; }
		if (has("server-request")) { pendingInit = { id, params }; send({ id: "srv-1", method: "approval/request", params: {} }); continue; }
		if (has("slow-init")) { setTimeout(() => handshake(id, params), 600); continue; }
		handshake(id, params);
	} else if (method === "session/prompt") {
		if (!initialized || !params.contentBlocks) throw new Error("invalid prompt");
		if (params.contentBlocks[0].text === "rpc-error") { send({ id, error: { code: -32000, message: "fixture rejected" } }); continue; }
		const { sessionId } = params;
		const event = (type, data) => notify("session.event", { sessionId, event: { type, data, seq: ++seq, time: Date.now() } });
		const noRunning = has("no-running") || has("idle-before-end");
		const status = (value) => { if (!has("no-status") && !(noRunning && value === "running")) notify("session.status", { sessionId, status: value }); };
		const n = ++promptCount;
		// Include unrelated session activity; clients must filter by session id.
		notify("session.status", { sessionId: "other", status: "idle" });
		status("running");
		response(id, { messageId: `message-${seq}` });
		if (has("crash-in-turn")) { setTimeout(() => exitAfterFlush(5), 10); continue; }
		if (has("stall-turn")) continue; // running forever; used for signal handling
		setTimeout(() => {
			event("turn/start", { turn: 1 });
			event("user/message", { content: params.contentBlocks, source: { kind: "user" } });
			if (has("subagent")) {
				notify("subagent.started", { parentSessionId: sessionId, childSessionId: "child-1" });
				notify("session.event", { sessionId: "child-1", event: { type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "CHILD" }] } }, seq: ++seq, time: Date.now() } });
				notify("subagent.finished", { provider: "in-process", agentId: "child-1", parentSessionId: sessionId, childSessionId: "child-1", status: "completed", stopReason: { kind: "completed" } });
			}
			// echo: reply carries arrival order and exact prompt text so tests can assert content/order.
			const reply = has("echo") ? `ECHO#${n}:${params.contentBlocks[0].text}` : "OK";
			if (has("running-idle-before-end")) status("idle");
			const finish = () => {
			event("assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: reply }] }, usage: { inputTokens: 3, outputTokens: 1 } });
			if (has("idle-before-end")) status("idle");
			event("turn/end", { turn: 1, reason: { kind: has("turn-error") ? "error" : "completed" } });
			if (!has("idle-before-end") && !has("running-idle-before-end")) status("idle");
			};
			if (has("running-idle-before-end")) setTimeout(finish, 50);
			else finish();
		}, 25);
	}
}
