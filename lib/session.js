/**
 * 会话模型：DSH host 上一个会话的客户端视图。
 *
 * milestone 2 的核心：把 session.create / session.prompt / session.history
 * 封装成「建会话 → 发消息 → 等轮结束 → 折叠视图」的最小闭环。
 * 任何 UI（Ink 界面、CLI 一次性调用、VSCode 侧栏）都只依赖这一层。
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sdkUnsupported } from "./client.js";
import { foldEvents } from "./fold.js";
import { readRecent } from "./registry.js";

/**
 * PTC 模式 = DSH `code` agent preset：
 * 具备标准模式全部能力，并通过 Code Mode SDK 呈现工具 —— 模型写一个
 * TypeScript 程序由 run_code 执行，多步操作一次往返。TUI 默认用它建会话。
 */
export const PTC_PRESET = "code";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Session {
	/**
	 * @param {import("./client.js").DshClient} client - 载体（或实现 request(method, payload) 的替身）。
	 * @param {string} sessionId - host 上持久化的会话 id。
	 * @param {{ agentPreset?: string|null, cwd?: string|null }} [meta]
	 */
	constructor(client, sessionId, { agentPreset = null, cwd = null } = {}) {
		this.client = client;
		this.sessionId = sessionId;
		this.agentPreset = agentPreset;
		this.cwd = cwd;
	}

	/** 列出 host 上全部会话（updatedAt 降序）。 */
	static async list(client) {
		if (client.sdk) throw sdkUnsupported("セッション一覧・再開");
		const { items } = await client.request("session.list", {});
		return items;
	}

	/**
	 * 新建会话，默认 PTC 模式（agentPreset: "code"），可用 opts.agentPreset 覆盖。
	 * @param {import("./client.js").DshClient} client
	 * @param {{ cwd?: string, agentPreset?: string, sessionId?: string }} [opts]
	 */
	static async create(client, { cwd, agentPreset, sessionId } = {}) {
		if (client.sdk) {
			if (cwd !== undefined && (typeof cwd !== "string" || resolve(cwd) !== client.cwd)) throw sdkUnsupported("session cwd override");
			if (agentPreset !== undefined || sessionId !== undefined) throw sdkUnsupported("session preset/id override");
			// Local identity only; the handshake is awaited by the first request (client.request), so a
			// UI can render and accept input before initialize completes.
			return new Session(client, randomUUID(), { cwd: client.cwd, agentPreset: null });
		}
		if (agentPreset === undefined) agentPreset = PTC_PRESET;
		const payload = {};
		if (cwd) payload.cwd = cwd;
		if (agentPreset) payload.agentPreset = agentPreset;
		if (sessionId) payload.sessionId = sessionId;
		const { sessionId: id, agentPreset: resolved } = await client.request("session.create", payload);
		return new Session(client, id, { agentPreset: resolved ?? agentPreset, cwd });
	}

	/** 复用 host 上已存在的会话（找不到抛 session-not-found）。 */
	static async open(client, sessionId) {
		const items = await Session.list(client);
		const found = items.find((item) => item.sessionId === sessionId);
		if (!found) {
			const error = new Error(`session not found: ${sessionId}`);
			error.code = "session-not-found";
			throw error;
		}
		return new Session(client, sessionId, {
			agentPreset: found.agentPreset ?? null,
			cwd: found.cwd ?? null
		});
	}

	/**
	 * 恢复最近会话：优先用客户端记忆（registry），否则 host 上最近更新的
	 * 非 blank 已存在会话。两者都落空返回 null（调用方应新建）。
	 * @param {import("./client.js").DshClient} client
	 * @param {{ remembered?: { sessionId, cwd?, agentPreset? }|null, items?: Array } } [opts]
	 */
	static async openRecent(client, { remembered = readRecent(), items } = {}) {
		const list = items ?? (await Session.list(client));
		let candidate = null;
		if (remembered && remembered.sessionId) {
			const found = list.find((item) => item.sessionId === remembered.sessionId);
			if (found && !found.blank) candidate = found;
		}
		if (!candidate) {
			// 最近更新的非 blank 会话（updatedAt 降序已在 list 里保证）
			candidate = list.find((item) => !item.blank) ?? null;
		}
		if (!candidate) return null;
		return new Session(client, candidate.sessionId, {
			agentPreset: candidate.agentPreset ?? null,
			cwd: candidate.cwd ?? null
		});
	}

	/** 读一页历史（事件页按消息边界对齐；不带动 agent，读存储）。 */
	async history({ beforeSeq, maxMessages } = {}) {
		if (this.client.sdk) throw sdkUnsupported("履歴");
		const payload = { sessionId: this.sessionId };
		if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq;
		if (maxMessages !== undefined) payload.maxMessages = maxMessages;
		return this.client.request("session.history", payload);
	}

	/** 发送一条文本消息（mode: queue=排队发送 / steer=插队引导）。 */
	async prompt(text, { mode = "queue" } = {}) {
		if (this.client.sdk) return this.client.request("session/prompt", { sessionId: this.sessionId, contentBlocks: [{ type: "text", text }] });
		return this.client.request("session.prompt", {
			sessionId: this.sessionId,
			mode,
			content: [{ type: "text", text }]
		});
	}

	/**
	 * 最小闭环：发消息 → 轮询 history 直到本轮的 turn/end → 返回折叠视图。
	 *
	 * 以 prompt 前的 lastSeq 为基线，只认基线之后出现的 turn/end（避免复用时
	 * 把旧轮当作本轮）。turn 以 error 结束会抛出 turn-error；超时抛 turn-timeout。
	 *
	 * @param {string} text - 要发送的文本。
	 * @param {{ timeoutMs?: number, pollMs?: number }} [opts]
	 * @returns {Promise<{messages, tools, turn, lastTurnEnd, lastSeq, accepted: true}>}
	 */
	async converse(text, { timeoutMs = 120_000, pollMs = 500 } = {}) {
		if (this.client.sdk) return this.converseSdk(text, timeoutMs);
		const before = await this.history({ maxMessages: 1 });
		const baseSeq = before.events.length
			? Math.max(...before.events.map((entry) => entry.event.seq))
			: -1;

		const res = await this.prompt(text);
		if (res.command) {
			// 以 / 开头的消息走 host 命令注册表，不进模型 —— 折叠当前页即可返回。
			const view = foldEvents(before.events);
			return { ...view, accepted: true, command: res.command, turnEnd: view.lastTurnEnd };
		}

		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const page = await this.history({ maxMessages: 64 });
			const view = foldEvents(page.events);
			const turnEnd = view.lastTurnEnd;
			// 只认「turn/end 事件自身的 seq」越过基线，而非 view.lastSeq：否则新 user 事件会
			// 提前 return 上一轮的 lastTurnEnd（假完成）。fold 会在 lastTurnEnd 上记录 end 的 seq。
			if (turnEnd && turnEnd.seq > baseSeq) {
				const reason = turnEnd.reason;
				if (reason && reason.kind === "error") {
					const error = new Error(
						`turn error: ${(reason.error && reason.error.message) || "unknown"}`
					);
					error.code = "turn-error";
					error.reason = reason;
					throw error;
				}
				return { ...view, accepted: true, turnEnd };
			}
			await sleep(pollMs);
		}

		const error = new Error(`turn not finished within ${timeoutMs}ms`);
		error.code = "turn-timeout";
		throw error;
	}
	/**
	 * Single-flight CLI interval, never the enqueue receipt. Completion:
	 * - both `idle` and this session's durable `turn/end`, in either order, or
	 * - `turn/end` while no `running` has been observed, after `settleMs` without further events
	 *   (covers no status at all, and `idle` arriving before `turn/end`).
	 * The fallbacks keep a missed status transition from turning into a full `timeoutMs` wait.
	 */
	async converseSdk(text, timeoutMs, { settleMs = 500 } = {}) {
		const events = [];
		let running = false, idle = false, turnEnded = false;
		let onNotification, onFailure, onClosed, timer, settleTimer;
		const done = new Promise((resolve, reject) => {
			const armSettle = () => {
				clearTimeout(settleTimer);
				if (turnEnded && !running) settleTimer = setTimeout(resolve, settleMs);
			};
			onNotification = (method, params) => {
				if (params.sessionId !== this.sessionId) return;
				if (method === "session.event") {
					events.push({ event: params.event });
					if (params.event?.type === "turn/end") {
						turnEnded = true;
						if (idle) { resolve(); return; }
					}
					armSettle();
				}
				if (method === "session.status") {
					if (params.status === "running") { running = true; idle = false; clearTimeout(settleTimer); }
					if (params.status === "idle") {
						idle = true;
						// ADR-0002. Status alone cannot certify success: the durable turn/end owns the outcome.
						if (turnEnded) resolve();
					}
				}
			};
			onFailure = reject;
			onClosed = (info) => reject(Object.assign(
				new Error(`SDK closed before conversation completed (code=${info?.code}, signal=${info?.signal})`), { exit: info }));
			timer = setTimeout(() => reject(Object.assign(new Error("SDK conversation timeout"), { code: "turn-timeout" })), timeoutMs);
			this.client.on("notification", onNotification);
			this.client.on("failure", onFailure);
			this.client.on("closed", onClosed);
		});
		// Observe rejection immediately, including failure before the prompt receipt.
		done.catch(() => {});
		try {
			await this.prompt(text);
			await done;
			const view = foldEvents(events);
			if (view.lastTurnEnd?.reason?.kind === "error") throw new Error("SDK turn failed");
			return { ...view, accepted: true, turnEnd: view.lastTurnEnd };
		} finally {
			clearTimeout(timer);
			clearTimeout(settleTimer);
			this.client.off("notification", onNotification);
			this.client.off("failure", onFailure);
			this.client.off("closed", onClosed);
		}
	}

}
