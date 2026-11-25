// 单元飞轮：mux SSE 传输层 —— 解析、分帧、坏帧容错。
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSseData, parseServerRequest, MuxStream } from "../lib/stream.js";

test("extractSseData：抽 data: 行并连接多行", () => {
	// 一个帧的 JSON 被拆成多行 data 字段（SSE 允许），拼接后是完整 JSON
	const chunk = 'event: msg\ndata: {"a":1,\ndata: "b":2}\n\n';
	assert.equal(extractSseData(chunk), '{"a":1,"b":2}');
});

test("extractSseData：注释/心跳行无 data → 空串", () => {
	assert.equal(extractSseData(": connected"), "");
	assert.equal(extractSseData(""), "");
});

test("parseServerRequest：合法信封解析出 payload", () => {
	const raw = JSON.stringify({ type: "server-request", rpcId: "r-1", method: "events.mux", payload: { type: "stream/error", error: { code: "internal", message: "x" } } });
	const message = parseServerRequest(raw);
	assert.equal(message.rpcId, "r-1");
	assert.equal(message.payload.type, "stream/error");
});

test("parseServerRequest：坏 JSON / 非 server-request → null（坏帧跳过不杀流）", () => {
	assert.equal(parseServerRequest("{not json"), null);
	assert.equal(parseServerRequest(JSON.stringify({ type: "server-response", rpcId: "r", result: {} })), null);
	assert.equal(parseServerRequest(JSON.stringify({ type: "server-request", rpcId: "r" })), null); // 无 payload
});


test("SDK stream maps notifications and removes subscriptions on abort", async () => {
	const { EventEmitter } = await import("node:events");
	const client = new EventEmitter();
	client.sdk = true;
	client.initialize = async () => {};
	const ac = new AbortController();
	const stream = new MuxStream(client);
	const iterator = stream.frames({ signal: ac.signal });
	const next = iterator.next();
	client.emit("notification", "session.event", { sessionId: "s", event: { seq: 1 } });
	assert.deepEqual((await next).value.payload, { type: "session/event", sessionId: "s", event: { seq: 1 } });
	ac.abort();
	assert.equal((await iterator.next()).done, true);
	assert.equal(client.listenerCount("notification"), 0);
});

test("SDK stream drains queued frames then ends on client close; failure is thrown", async () => {
	const { EventEmitter } = await import("node:events");
	const client = new EventEmitter();
	client.sdk = true;
	client.initialize = async () => {};
	const iterator = new MuxStream(client).frames();
	const first = iterator.next();
	await new Promise((r) => setImmediate(r));
	client.emit("notification", "session.status", { sessionId: "s", status: "idle" });
	client.emit("closed", { code: 0, signal: null });
	assert.equal((await first).value.payload.type, "session/status");
	assert.equal((await iterator.next()).done, true);
	assert.equal(client.listenerCount("closed") + client.listenerCount("notification") + client.listenerCount("failure"), 0);

	const failing = new EventEmitter();
	failing.sdk = true;
	failing.initialize = async () => {};
	const it2 = new MuxStream(failing).frames();
	const pending = it2.next();
	await new Promise((r) => setImmediate(r));
	failing.emit("failure", new Error("boom"));
	await assert.rejects(pending, /boom/);
});
