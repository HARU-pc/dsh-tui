/** SDK notification iterator; legacy envelope parsers remain pure compatibility helpers. */

/** 从 SSE 块里抽出 data: 载荷（多行 data 连接；无 data 行返回 ""）。保留：兼容历史/测试。 */
export function extractSseData(chunk) {
	return chunk
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice(6))
		.join("");
}

/** 解析一帧 JSON 为 ServerRequest 信封；非法返回 null（坏帧跳过，不杀流）。 */
export function parseServerRequest(raw) {
	try {
		const message = JSON.parse(raw);
		if (!message || message.type !== "server-request" || typeof message.payload !== "object") {
			return null;
		}
		return message;
	} catch {
		return null;
	}
}

/**
 * 逐消息读取 mux WebSocket 流。yield 的是 ServerRequest 信封 `{ type, rpcId, method, payload }`
 * —— payload 是 MuxFrame（含 type 判别），rpcId 供应答（question/approval requested）。
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - 关闭流的信号（close() 用）。
 * @param {() => void} [opts.onOpen] - 连接建立、可收消息时回调（流已建立信号）。
 * @param {typeof WebSocket} [opts.WebSocketImpl] - 注入测试用 WebSocket 实现。
 */
export class MuxStream {
	constructor(client) { this.client = client; }
	/**
	 * Notifications are subscribed before the handshake so early events cannot be lost.
	 * Ends cleanly on abort or when the client's child closes normally (queued frames are
	 * drained first, including on failure); throws the client failure after queued frames. Always unsubscribes.
	 * subagent.* frames are passed through unfiltered (their payload has parentSessionId,
	 * not sessionId); LiveConversation/converse deliberately do not render them.
	 */
	async *frames({ signal, onOpen } = {}) {
		const client = this.client;
		if (!client?.sdk) throw new Error("MuxStream requires an SDK DshClient");
		const queue = [];
		let wake, failure = client.failure ?? null, aborted = signal?.aborted ?? false, ended = Boolean(client.closedInfo);
		const settle = () => { wake?.(); wake = null; };
		const notification = (method, params) => {
			const type = { "session.event": "session/event", "session.status": "session/status",
				"subagent.started": "subagent/started", "subagent.finished": "subagent/finished" }[method];
			if (type) { queue.push({ payload: { type, ...params } }); settle(); }
		};
		const failed = (error) => { failure = error; settle(); };
		const closed = () => { ended = true; settle(); };
		const abort = () => { aborted = true; settle(); };
		client.on("notification", notification);
		client.on("failure", failed);
		client.on("closed", closed);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			if (aborted) return;
			if (failure) throw failure;
			if (ended) return;
			await client.initialize(); onOpen?.();
			while (!aborted) {
				if (queue.length) yield queue.shift();
				else if (failure) throw failure;
				else if (ended) return;
				else await new Promise((resolve) => { wake = resolve; });
			}
		} finally {
			client.off("notification", notification); client.off("failure", failed); client.off("closed", closed);
			signal?.removeEventListener("abort", abort);
		}
	}
}

/** 应答一个可应答的 server-request（approval/question requested 用），走 /api/respond。 */
export async function respond(client, rpcId, result) {
	return client.respond(rpcId, result);
}
