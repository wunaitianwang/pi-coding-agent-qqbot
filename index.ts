/**
 * pi-qqbot: connect the official QQ Bot API to Pi (text-only MVP).
 *
 * Lifecycle:
 *  - Commands are registered immediately (in the factory).
 *  - The QQ runtime (sockets/timers + an ISOLATED agent session) starts in
 *    session_start and is torn down in session_shutdown.
 *
 * Isolation: QQ messages are handled by a separate SDK-created AgentSession, so
 * they never touch the local user's TUI session. See router.ts / qq-session.ts.
 *
 * Security: QQ turns a local coding agent into a remote control surface. The
 * runtime defaults to disabled with empty allowlists; empty allowlists mean no
 * inbound message is processed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, validateEnabled } from "./config";
import { PiQQBotRuntime } from "./router";
import type { PiQQBotConfig } from "./types";

let runtime: PiQQBotRuntime | undefined;
let currentConfig: PiQQBotConfig | undefined;
let debugCommandRegistered = false;

export default function (pi: ExtensionAPI) {
	// Create + connect the runtime on demand (shared by /qqbot-start and autoStart).
	const connect = async (ctx: ExtensionContext): Promise<void> => {
		if (runtime) return;
		if (!currentConfig) return;
		const rt = new PiQQBotRuntime(pi, currentConfig);
		runtime = rt;
		await rt.start(ctx);
	};

	pi.registerCommand("qqbot-start", {
		description: "Connect the Pi QQBot gateway",
		handler: async (_args, ctx) => {
			if (!currentConfig || !currentConfig.enabled) {
				ctx.ui.notify("pi-qqbot: not enabled (set \"enabled\": true in ~/.pi/agent/pi-qqbot.json)", "warning");
				return;
			}
			const invalid = validateEnabled(currentConfig);
			if (invalid) {
				ctx.ui.notify(`pi-qqbot: cannot start (${invalid})`, "warning");
				return;
			}
			if (runtime) {
				ctx.ui.notify(`pi-qqbot already running\n${runtime.statusText()}`, "info");
				return;
			}
			await connect(ctx);
			ctx.ui.notify(runtime?.statusText() ?? "pi-qqbot started", "info");
		},
	});

	pi.registerCommand("qqbot-stop", {
		description: "Disconnect the Pi QQBot gateway",
		handler: async (_args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("pi-qqbot is not running", "info");
				return;
			}
			await runtime.stop();
			runtime = undefined;
			ctx.ui.notify("pi-qqbot stopped", "info");
		},
	});

	pi.registerCommand("qqbot-status", {
		description: "Show Pi QQBot connection status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(runtime?.statusText() ?? "pi-qqbot is not running", "info");
		},
	});

	pi.registerCommand("qqbot-reconnect", {
		description: "Reconnect the Pi QQBot gateway",
		handler: async (_args, ctx) => {
			if (!runtime) {
				ctx.ui.notify("pi-qqbot is not running", "info");
				return;
			}
			await runtime.reconnect();
			ctx.ui.notify(runtime.statusText(), "info");
		},
	});

	pi.registerCommand("qqbot-last", {
		description: "Show last QQBot inbound/outbound summary",
		handler: async (_args, ctx) => {
			ctx.ui.notify(runtime?.lastSummary() ?? "no QQBot events yet", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const { config, missing, parseError } = await loadConfig();

		if (parseError) {
			if (ctx.hasUI) ctx.ui.notify(`pi-qqbot: invalid config (${parseError})`, "warning");
			return;
		}
		if (!config.enabled) {
			if (missing && ctx.hasUI) {
				ctx.ui.notify("pi-qqbot: no config found (~/.pi/agent/pi-qqbot.json); disabled", "info");
			}
			return;
		}

		const invalid = validateEnabled(config);
		if (invalid) {
			if (ctx.hasUI) ctx.ui.notify(`pi-qqbot: cannot start (${invalid})`, "warning");
			return;
		}

		currentConfig = config;

		// Debug-only local test command, gated behind config.debug.
		if (config.debug && !debugCommandRegistered) {
			debugCommandRegistered = true;
			pi.registerCommand("qqbot-fake", {
				description: "[debug] Simulate an inbound QQ private message",
				handler: async (args, cctx) => {
					if (!args.trim()) {
						cctx.ui.notify("Usage: /qqbot-fake <message>", "warning");
						return;
					}
					if (!runtime) {
						cctx.ui.notify("pi-qqbot is not running (use /qqbot-start)", "warning");
						return;
					}
					runtime.simulateInbound(args.trim());
				},
			});
		}

		// Do NOT connect automatically unless autoStart is set. Otherwise the user
		// opens the gateway on demand with /qqbot-start (avoids startup reconnect
		// spam when the network cannot reach QQ).
		if (config.autoStart) {
			runtime = new PiQQBotRuntime(pi, config);
			await runtime.start(ctx);
		} else if (ctx.hasUI) {
			ctx.ui.notify("pi-qqbot: ready (not connected). Use /qqbot-start to connect.", "info");
		}
	});

	pi.on("session_shutdown", async () => {
		await runtime?.stop();
		runtime = undefined;
	});
}
