#!/usr/bin/env node
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolveVersion } from "../lib/version.js";
import { DshClient, sdkUnsupported, assertDirectory } from "../lib/client.js";
import { Session } from "../lib/session.js";
import { lastAssistantText } from "../lib/fold.js";
import { startInteractive } from "./interactive.js";

const require = createRequire(import.meta.url);
async function main() {
	const args = process.argv.slice(2);
	if (["--version", "-v"].includes(args[0])) { console.log(resolveVersion(require("../package.json"))); return; }
	if (["--help", "-h"].includes(args[0])) {
		console.log("dsh-tui [directory] [--cwd directory] [--new]\ndsh-tui run <prompt> [--cwd directory] [--json]\nDSH_SDK_COMMAND (default: dsh --profile sdk), DSH_SDK_PROVIDER, DSH_SDK_MODEL\n履歴・セッション一覧・再開・中断・subagent 一覧: SDK モードでは未対応");
		return;
	}
	const run = args[0] === "run";
	if (run) args.shift();
	let cwd = process.cwd(), prompt, json = false, directory;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd") {
			if (!args[i + 1]) throw new Error("--cwd requires a directory");
			cwd = resolve(args[++i]);
		} else if (arg === "--json" && run) json = true;
		else if (arg === "--new") continue;
		else if (["--resume", "--session", "--preset"].includes(arg)) throw sdkUnsupported(arg);
		else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		else if (run && prompt === undefined) prompt = arg;
		else if (!run && directory === undefined) { directory = arg; cwd = resolve(arg); }
		else throw new Error(`unexpected argument: ${arg}`);
	}
	assertDirectory(cwd);
	if (!run) {
		if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("interactive SDK mode requires a TTY; use dsh-tui run <prompt>");
		await startInteractive({ cwd });
		return;
	}
	if (!prompt) throw new Error("run requires a prompt");
	const client = new DshClient({ cwd });
	// A signal requests the same idempotent shutdown the finally block awaits. The conversation
	// then rejects with "SDK closed before conversation completed"; that is the expected effect of
	// the signal, so it is suppressed and the conventional 128+signo exit code is used instead.
	let signalled = null;
	const signalExit = (signal) => { signalled ??= signal; void client.shutdown().catch(() => {}); };
	process.on("SIGINT", signalExit);
	process.on("SIGTERM", signalExit);
	let primary = null;
	try {
		const session = await Session.create(client);
		const view = await session.converse(prompt);
		const reply = lastAssistantText(view);
		if (json) console.log(formatJson(session, view, reply ?? ""));
		else {
			// Same as the pre-SDK CLI: tool-call count on stderr, "(无回复)" only when no assistant text exists.
			if (view.tools.length > 0) console.error(`[${session.sessionId}] ${view.tools.length} 次工具调用`);
			console.log(reply ?? "(无回复)");
		}
	} catch (error) {
		if (!signalled) { primary = error; throw error; }
	} finally {
		process.removeListener("SIGINT", signalExit);
		process.removeListener("SIGTERM", signalExit);
		try { await client.shutdown(); }
		catch (shutdownError) {
			// The original failure wins; a distinct shutdown failure is reported, never swallowed.
			if (!primary && !signalled) throw shutdownError;
			if (shutdownError !== primary) console.error(`dsh-tui: shutdown failed: ${shutdownError.message}`);
		}
		if (signalled) process.exitCode = signalled === "SIGINT" ? 130 : 143;
	}
}

/**
 * `run --json` keeps the pre-SDK schema (2-space indent). SDK has no agent presets, so
 * agentPreset is always null; usage sums assistant message usage when the events carry it
 * (0 otherwise); turnEnd is the reason kind or null. See docs/dsh-0.2-sdk.md.
 */
function formatJson(session, view, reply) {
	const usage = view.messages.reduce((acc, m) => {
		if (m.usage) { acc.input += m.usage.inputTokens ?? 0; acc.output += m.usage.outputTokens ?? 0; }
		return acc;
	}, { input: 0, output: 0 });
	return JSON.stringify({
		sessionId: session.sessionId,
		agentPreset: session.agentPreset ?? null,
		reply,
		turn: view.turn ?? null,
		toolCalls: view.tools.length,
		usage,
		turnEnd: view.turnEnd?.reason?.kind ?? null
	}, null, 2);
}
main().catch((error) => { console.error(`dsh-tui: ${error.message}`); process.exitCode = 1; });
