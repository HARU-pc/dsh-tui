#!/usr/bin/env node
// SDK lifecycle belongs to this entry point; Ink remains a passive view.
import { render } from "ink";
import React from "react";
import { DshClient } from "../lib/client.js";
import { Session } from "../lib/session.js";
import { LiveConversation } from "../lib/live.js";
import App from "../ui/components.js";
import { routeSlash } from "../lib/commands.js";

/**
 * The UI is rendered before the SDK handshake completes (docs/dsh-0.2-sdk.md "Startup"):
 * Orca pastes the task once the composer is visible, so the composer must accept input
 * immediately. Input sent early is echoed as pending and Session.prompt → client.request
 * awaits initialize before writing it, in submission order. Fatal errors are printed once,
 * after Ink unmounts.
 */
export async function startInteractive({ cwd = process.cwd(), clientOptions = {}, renderOptions = {} } = {}) {
	const client = new DshClient({ cwd, ...clientOptions });
	let session, conv, app, exiting, fatal = null;
	const signalExit = () => { void exit(); };
	const exit = (code = 0, error = null) => {
		// Only the call that starts exiting may record a fatal error: once a normal exit (/exit,
		// Ctrl+C) has begun, rejections it causes itself (e.g. a pending initialize failing with
		// "SDK process closed") are consequences of the shutdown, not failures to report.
		if (exiting) return exiting;
		fatal = error;
		exiting = (async () => {
			conv?.close();
			app?.unmount();
			let shutdownError = null;
			try { await client.shutdown(); } catch (e) { shutdownError = e; }
			const reported = fatal ?? shutdownError;
			if (reported) {
				console.error(`dsh-tui: ${reported.message}`);
				if (shutdownError && fatal && shutdownError !== fatal && shutdownError.message !== fatal.message) {
					console.error(`dsh-tui: shutdown failed: ${shutdownError.message}`);
				}
				code = 1;
			}
			process.exitCode = code;
			process.removeListener("SIGINT", signalExit);
			process.removeListener("SIGTERM", signalExit);
		})();
		return exiting;
	};
	client.on("failure", (error) => { void exit(1, error); });
	process.on("SIGINT", signalExit);
	process.on("SIGTERM", signalExit);
	try {
		session = await Session.create(client); // local id; does not wait for the handshake
		// A signal during startup already began exiting: never render or start the handshake after that.
		if (exiting) return;
		conv = new LiveConversation({ client, session });
		const onCommand = async (input) => {
			const routed = routeSlash(input.startsWith("/") ? input : `/${input}`);
			if (!routed) return;
			switch (routed.local ? routed.action : null) {
				case "exit": await exit(); return;
				case "new":
					if (conv.state.running) { conv.state.notice = "実行中のセッション切替は未対応です"; break; }
					session = await Session.create(client);
					await conv.switchSession(session);
					conv.state.notice = `新規セッション: ${session.sessionId}`;
					break;
				case "status": conv.state.notice = `SDK | ${session.sessionId} | ${client.model} | ${client.cwd}`; break;
				case "help": conv.state.notice = "/new /status /help /exit | 履歴・一覧・再開・中断・host コマンド: SDK モードでは未対応"; break;
				default: conv.state.notice = "履歴・一覧・再開・host コマンド: SDK モードでは未対応";
			}
			conv.emit();
		};
		app = render(React.createElement(App, {
			conv, session, onCommand, onExit: () => { void exit(); }, getSession: () => session
		}), { exitOnCtrlC: false, ...renderOptions });
		// The App's effect calls conv.open() (subscribe + handshake); a rejected handshake that is
		// not a child failure (e.g. JSON-RPC error for an unknown model) is fatal here, reported once.
		if (!exiting) client.initialize().catch((error) => { void exit(1, error); });
		await app.waitUntilExit();
	} catch (error) {
		await exit(1, error);
	} finally { await exit(process.exitCode || 0); }
}
