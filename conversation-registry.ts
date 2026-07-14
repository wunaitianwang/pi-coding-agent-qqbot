import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { QQAgentSession } from "./qq-session";
import type { PiQQBotConfig, QQInboundMessage } from "./types";

interface ConversationEntry {
	key: string;
	session: QQAgentSession;
	lastUsedAt: number;
	initializing?: Promise<void>;
}

export class ConversationRegistry {
	private readonly entries = new Map<string, ConversationEntry>();
	private readonly config: PiQQBotConfig;
	private readonly agentDir: string;
	private readonly cwd: string;
	private disposed = false;

	constructor(config: PiQQBotConfig, agentDir: string, cwd: string) {
		this.config = config;
		this.agentDir = agentDir;
		this.cwd = cwd;
	}

	async get(msg: QQInboundMessage): Promise<QQAgentSession> {
		if (this.disposed) throw new Error("QQ conversation registry is disposed");
		await this.evictExpired();
		const key = conversationKey(msg);
		let entry = this.entries.get(key);
		if (!entry) {
			await this.evictIfNeeded();
			entry = { key, session: new QQAgentSession(), lastUsedAt: Date.now() };
			this.entries.set(key, entry);
			const sessionDir = this.config.sessions.mode === "persistent" ? this.sessionDirFor(key) : undefined;
			entry.initializing = (async () => {
				if (sessionDir) await mkdir(sessionDir, { recursive: true, mode: 0o700 });
				await entry?.session.init(this.cwd, {
					sessionDir,
					persistent: this.config.sessions.mode === "persistent",
					restore: this.config.sessions.restore,
				});
			})();
		}
		try {
			await entry.initializing;
		} catch (err) {
			if (this.entries.get(key) === entry) this.entries.delete(key);
			await entry.session.dispose();
			throw err;
		}
		entry.initializing = undefined;
		entry.lastUsedAt = Date.now();
		return entry.session;
	}

	peek(msg: QQInboundMessage): QQAgentSession | undefined {
		return this.entries.get(conversationKey(msg))?.session;
	}

	get residentCount(): number {
		return this.entries.size;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const entries = [...this.entries.values()];
		this.entries.clear();
		await Promise.allSettled(entries.map(async (entry) => {
			await entry.initializing?.catch(() => undefined);
			await entry.session.dispose();
		}));
	}

	private async evictExpired(): Promise<void> {
		const cutoff = Date.now() - this.config.sessions.idleDisposeMs;
		const expired = [...this.entries.values()].filter(
			(entry) => entry.lastUsedAt < cutoff && !entry.session.isStreaming() && !entry.initializing,
		);
		for (const entry of expired) {
			if (this.entries.get(entry.key) !== entry) continue;
			this.entries.delete(entry.key);
			await entry.session.dispose();
		}
	}

	private sessionDirFor(key: string): string {
		const hash = createHash("sha256").update(`pi-qqbot\0${key}`).digest("hex").slice(0, 32);
		return join(this.agentDir, "qqbot", "sessions", hash);
	}

	private async evictIfNeeded(): Promise<void> {
		const maxResident = this.config.sessions.maxResident;
		if (this.entries.size < maxResident) return;
		const idle = [...this.entries.values()]
			.filter((entry) => !entry.session.isStreaming())
			.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
		if (!idle) throw new Error("QQ 会话资源已满，且所有会话都在运行，请稍后重试");
		this.entries.delete(idle.key);
		await idle.session.dispose();
	}
}

export function conversationKey(msg: QQInboundMessage): string {
	return msg.type === "private" ? `private:${msg.userOpenId}` : `group:${msg.groupOpenId ?? ""}`;
}
