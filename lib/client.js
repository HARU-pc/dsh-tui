import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

export function mintRpcId() { return `rpc-${randomUUID()}`; }
export function sdkUnsupported(feature) {
	return Object.assign(new Error(`${feature}: SDK モードでは未対応`), { code: "sdk-unsupported" });
}

/** cwd must be an existing directory; otherwise spawn reports a misleading ENOENT for /bin/sh. */
export function assertDirectory(dir) {
	let info;
	try { info = statSync(dir); }
	catch (error) {
		if (error.code === "ENOENT") throw Object.assign(new Error(`ディレクトリが存在しません: ${dir}`), { code: "ENOENT" });
		throw error;
	}
	if (!info.isDirectory()) throw Object.assign(new Error(`ディレクトリではありません: ${dir}`), { code: "ENOTDIR" });
}

const exitText = ({ code, signal }) => `code=${code}, signal=${signal}`;

/** One runtime per client. stdout is exclusively newline-delimited JSON-RPC.
 * ADR-0001. Command overrides are trusted shell commands supplied by the user.
 */
export class DshClient extends EventEmitter {
	// provider/model are required InitializeParams in dsh-sdk-protocol 0.2.0-rc.2, so defaults are always sent.
	constructor(options = {}) {
		super();
		if (typeof options === "string") throw Object.assign(new Error("URL transport was removed; use new DshClient({ cwd }) for SDK mode"), { code: "sdk-legacy-baseurl" });
		if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("DshClient options must be an object");
		const { cwd = process.cwd(), command = process.env.DSH_SDK_COMMAND ?? "dsh --profile sdk",
		provider = process.env.DSH_SDK_PROVIDER ?? "deepseek-official",
		model = process.env.DSH_SDK_MODEL ?? "deepseek-v4-pro", timeoutMs = 30_000, initializeTimeoutMs = 120_000, killGraceMs = 5_000,
		onDiagnostic = (text) => process.stderr.write(text) } = options;
		Object.assign(this, { cwd: resolve(cwd), command, provider, model, timeoutMs, initializeTimeoutMs, killGraceMs, onDiagnostic });
		this.sdk = true;
		this.pending = new Map();
		this.failure = null;
		this.closing = false;
		/** `{code, signal}` once the child has closed; MuxStream uses it to end late subscribers. */
		this.closedInfo = null;
	}
	#spawn() {
		if (this.closing) throw new Error("SDK is shutting down"); // never spawn a child nobody will reap
		assertDirectory(this.cwd);
		// exec avoids an intermediate shell surviving its SDK child at shutdown.
		this.child = spawn("/bin/sh", ["-c", `exec ${this.command}`], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
		this.exited = new Promise((resolveExit) => { this.resolveExit = resolveExit; });
		this.child.once("error", (error) => {
			this.fail(error);
			// A spawn failure may never emit "close"; settle exit waiters anyway.
			if (this.child.exitCode === null && this.child.pid === undefined) this.#closed(null, null);
		});
		// EPIPE etc. precede "close"; the close handler then attaches exit code/signal to the failure.
		this.child.stdin.on("error", (error) => { if (!this.closing) this.fail(error); });
		this.child.stderr.on("data", (chunk) => this.onDiagnostic(chunk.toString()));
		this.lines = createInterface({ input: this.child.stdout });
		this.lines.on("line", (line) => this.receive(line));
		this.child.once("close", (code, signal) => this.#closed(code, signal));
	}
	#closed(code, signal) {
		if (this.closedInfo) return;
		const info = this.closedInfo = { code, signal };
		this.resolveExit(info);
		// Failure is recorded before "closed" so listeners observing both see the cause (with exit status) first.
		if (!this.closing || code !== 0) {
			if (!this.failure) this.fail(Object.assign(new Error(`SDK process exited (${exitText(info)})`), { exit: info }));
			else if (!this.failure.exit) {
				this.failure.exit = info;
				this.failure.message += ` (SDK process exited ${exitText(info)})`;
			}
		}
		for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(this.failure ?? new Error("SDK process closed")); }
		this.pending.clear();
		this.emit("closed", info);
	}
	async initialize() {
		// Checked before the cached handshake: once shutdown has started no new work (and no spawn) begins.
		if (this.closing) throw new Error("SDK is shutting down");
		if (this.failure) throw this.failure;
		if (this.ready) return this.ready;
		if (!this.child) this.#spawn();
		const ready = this.ready = this.rpc("initialize", { cwd: this.cwd, provider: this.provider, model: this.model }, this.initializeTimeoutMs);
		// ADR-0002. Only explicit JSON-RPC rejections may be retried. A timeout leaves server state unknown and is fatal.
		ready.catch(() => { if (this.ready === ready) this.ready = null; });
		return ready;
	}
	fail(error) {
		if (this.failure) return;
		this.failure = error;
		for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
		this.pending.clear();
		this.emit("failure", error);
	}
	receive(line) {
		let frame;
		try {
			frame = JSON.parse(line);
			if (!frame || frame.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC envelope");
		} catch { this.fail(new Error("Invalid SDK stdout frame")); return; }
		const hasId = frame.id !== undefined && frame.id !== null;
		if (hasId && typeof frame.method === "string") {
			// Server→client requests are unused by 0.2.0-rc.2 but legal on the wire; answer like the
			// reference transport (-32601) so the server never waits on a silently dropped request.
			this.#write({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } });
		} else if (hasId) {
			const pending = this.pending.get(frame.id);
			if (!pending) return;
			this.pending.delete(frame.id); clearTimeout(pending.timer);
			if (frame.error) pending.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
			else if (Object.hasOwn(frame, "result")) pending.resolve(frame.result);
			else pending.reject(new Error("Invalid SDK response"));
		} else if (typeof frame.method === "string") this.emit("notification", frame.method, frame.params ?? {});
		else this.fail(new Error("Invalid SDK notification"));
	}
	#write(frame) {
		if (!this.child?.stdin.writable) return;
		this.child.stdin.write(JSON.stringify(frame) + "\n", (error) => { if (error && !this.closing) this.fail(error); });
	}
	rpc(method, params, timeoutMs = this.timeoutMs) {
		if (this.failure) return Promise.reject(this.failure);
		if (this.closedInfo) return Promise.reject(new Error("SDK process closed"));
		return new Promise((resolve, reject) => {
			const id = mintRpcId();
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const error = new Error(`SDK request timeout: ${method}`);
				// A late initialize reply cannot prove a second initialize would be safe.
				if (method === "initialize") this.fail(error);
				reject(error);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.#write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
		});
	}
	async request(method, params) {
		if (!["session/prompt", "shutdown"].includes(method)) throw sdkUnsupported(method);
		if (method === "shutdown") return this.shutdown();
		// Requests issued before the handshake completes wait for it (server rejects prompts until then).
		await this.initialize();
		if (this.closing) throw new Error("SDK is shutting down");
		return this.rpc(method, params);
	}
	async respond() { throw sdkUnsupported("approval/question response"); }
	/** Resolve `{code, signal}` when the child exits within `ms`, otherwise null. */
	async #waitExit(ms) {
		let timer;
		const timeout = new Promise((done) => { timer = setTimeout(() => done(null), ms); });
		try { return await Promise.race([this.exited, timeout]); }
		finally { clearTimeout(timer); }
	}
	/**
	 * Idempotent. Always waits for the child to exit, even when the shutdown RPC fails or the
	 * client already failed, so no SDK child outlives the client. A child that ignores shutdown
	 * and EOF for `timeoutMs` gets SIGTERM, then SIGKILL after `killGraceMs`.
	 * Outcome: the earliest cause wins — prior failure, then RPC error, then exit status.
	 */
	async shutdown() {
		if (this.shutdownTask) return this.shutdownTask;
		// closing is set synchronously before anything else, so a shutdown that precedes spawn
		// permanently blocks initialize()/#spawn() instead of caching a no-op task.
		this.closing = true;
		this.shutdownTask = (async () => {
			if (!this.child) return;
			const deadline = Date.now() + this.timeoutMs;
			let rpcError = null;
			if (!this.closedInfo) {
				try { await this.rpc("shutdown"); } catch (error) { rpcError = error; }
			}
			this.child.stdin.end();
			let result = await this.#waitExit(Math.max(0, deadline - Date.now()));
			let forced = null;
			if (!result) {
				for (const signal of ["SIGTERM", "SIGKILL"]) {
					forced = signal;
					this.child.kill(signal);
					result = await this.#waitExit(this.killGraceMs);
					if (result) break;
				}
			}
			if (forced) {
				const detail = result ? exitText(result) : "child did not exit after SIGKILL";
				throw Object.assign(new Error(`SDK shutdown exit timeout; child terminated with ${forced} (${detail})`), { exit: result, cause: rpcError ?? undefined });
			}
			if (this.failure) throw this.failure;
			if (rpcError) throw rpcError;
			if (result.code !== 0) throw Object.assign(new Error(`SDK shutdown failed (${exitText(result)})`), { exit: result });
		})();
		return this.shutdownTask;
	}
}
