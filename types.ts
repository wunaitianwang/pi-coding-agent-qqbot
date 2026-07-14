/**
 * Shared types for the pi-qqbot extension.
 */

export interface PiQQBotConfig {
	enabled: boolean;
	/** Connect the QQ gateway automatically on Pi startup. Default false: use /qqbot-start. */
	autoStart?: boolean;
	appId: string;
	clientSecret: string;
	sandbox?: boolean;
	allowUsers?: string[];
	allowGroups?: string[];
	replyPrefix?: string;
	maxQueueSize?: number;
	sendBusyNotice?: boolean;
	/** Allow forwarding non-qqbot pi slash commands from QQ (fire-and-forget). */
	allowCommands?: boolean;
	/** Include a tool-call transcript ("process") in the QQ reply. */
	showProcess?: boolean;
	debug?: boolean;
}

/** A normalized inbound QQ message (text only for the MVP). */
export interface QQInboundMessage {
	id: string; // platform message id, required for passive reply
	type: "private" | "group";
	text: string;
	userOpenId: string; // user_openid (private) or member_openid (group)
	groupOpenId?: string;
	raw: unknown;
	receivedAt: number;
	/** Internal: locally simulated message (/qqbot-fake). Reply is not sent to QQ. */
	fake?: boolean;
}

/**
 * Reply target. QQ replies must be sent as passive messages that reference the
 * originating msg_id (and msg_seq), inside a time window (C2C 60min, group 5min).
 */
export interface QQReplyTarget {
	type: "private" | "group";
	userOpenId: string;
	groupOpenId?: string;
	msgId: string; // original inbound message id
	createdAt: number; // to reason about the passive-reply window
}

export type ConnectionState =
	| "disabled"
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

/**
 * Process-local events mirrored into the Pi terminal that explicitly ran
 * /qqbot-start. These events are UI-only: they are never appended to the local
 * Pi session or sent to its model.
 */
export type QQTerminalEvent =
	| {
			kind: "runtime_state";
			connection: ConnectionState;
			detail?: string;
			queueSize: number;
			running: boolean;
			activeLabel?: string;
			at: number;
	  }
	| {
			kind: "inbound";
			messageId: string;
			channel: "private" | "group";
			senderLabel: string;
			text: string;
			fake: boolean;
			at: number;
	  }
	| { kind: "queued"; messageId: string; queueSize: number; at: number }
	| { kind: "run_start"; messageId: string; at: number }
	| { kind: "assistant_start"; messageId: string; at: number }
	| { kind: "assistant_delta"; messageId: string; delta: string; at: number }
	| { kind: "assistant_end"; messageId: string; at: number }
	| {
			kind: "tool_start";
			messageId: string;
			toolCallId: string;
			toolName: string;
			args: unknown;
			at: number;
	  }
	| {
			kind: "tool_end";
			messageId: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
			at: number;
	  }
	| {
			kind: "reply_start";
			messageId: string;
			chunks: number;
			fake: boolean;
			at: number;
	  }
	| {
			kind: "reply_end";
			messageId: string;
			ok: boolean;
			sentChunks: number;
			error?: string;
			at: number;
	  }
	| { kind: "run_end"; messageId: string; at: number }
	| { kind: "error"; messageId?: string; stage: string; message: string; at: number };

/** Optional observer owned by one Pi TUI process. */
export interface QQConversationObserver {
	onEvent(event: QQTerminalEvent): void;
	dispose(): void;
}
