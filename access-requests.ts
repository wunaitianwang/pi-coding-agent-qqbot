import { randomBytes } from "node:crypto";

import type { QQInboundMessage } from "./types";

export type QQAccessRole = "user" | "admin";

export interface QQAccessRequest {
	code: string;
	userOpenId: string;
	createdAt: number;
	expiresAt: number;
	/** Original message metadata for a bounded passive approval/denial reply. */
	message: QQInboundMessage;
}

export interface QQAccessRequestAdmission {
	request?: QQAccessRequest;
	created: boolean;
	suppressed: boolean;
}

/**
 * In-memory pending access requests. Requests never grant permission by
 * themselves; only a local Pi command can approve one and persist the config.
 */
export class QQAccessRequestStore {
	private readonly byCode = new Map<string, QQAccessRequest>();
	private readonly codeByUser = new Map<string, string>();
	private readonly deniedUntil = new Map<string, number>();

	constructor(
		private readonly ttlMs = 10 * 60 * 1000,
		private readonly maxPending = 20,
		private readonly denyCooldownMs = 60 * 60 * 1000,
	) {}

	admit(message: QQInboundMessage, now = Date.now()): QQAccessRequestAdmission {
		this.purge(now);
		if (message.type !== "private") return { created: false, suppressed: true };
		if ((this.deniedUntil.get(message.userOpenId) ?? 0) > now) {
			return { created: false, suppressed: true };
		}
		const existingCode = this.codeByUser.get(message.userOpenId);
		if (existingCode) {
			const existing = this.byCode.get(existingCode);
			if (existing) return { request: existing, created: false, suppressed: false };
		}
		if (this.byCode.size >= this.maxPending) return { created: false, suppressed: true };
		const request: QQAccessRequest = {
			code: this.createCode(),
			userOpenId: message.userOpenId,
			createdAt: now,
			expiresAt: now + this.ttlMs,
			message: redactRequestMessage(message),
		};
		this.byCode.set(request.code, request);
		this.codeByUser.set(request.userOpenId, request.code);
		return { request, created: true, suppressed: false };
	}

	list(now = Date.now()): QQAccessRequest[] {
		this.purge(now);
		return [...this.byCode.values()].sort((left, right) => left.createdAt - right.createdAt);
	}

	get(code: string, now = Date.now()): QQAccessRequest | undefined {
		this.purge(now);
		return this.byCode.get(normalizeCode(code));
	}

	approve(code: string, now = Date.now()): QQAccessRequest | undefined {
		const request = this.get(code, now);
		if (request) this.remove(request);
		return request;
	}

	deny(code: string, now = Date.now()): QQAccessRequest | undefined {
		const request = this.get(code, now);
		if (!request) return undefined;
		this.remove(request);
		this.deniedUntil.set(request.userOpenId, now + this.denyCooldownMs);
		return request;
	}

	get size(): number {
		this.purge(Date.now());
		return this.byCode.size;
	}

	private purge(now: number): void {
		for (const request of this.byCode.values()) {
			if (request.expiresAt <= now) this.remove(request);
		}
		for (const [user, expiry] of this.deniedUntil) {
			if (expiry <= now) this.deniedUntil.delete(user);
		}
	}

	private remove(request: QQAccessRequest): void {
		this.byCode.delete(request.code);
		if (this.codeByUser.get(request.userOpenId) === request.code) {
			this.codeByUser.delete(request.userOpenId);
		}
	}

	private createCode(): string {
		for (;;) {
			const code = randomBytes(5).toString("base64url").toUpperCase().replace(/[-_]/g, "").slice(0, 6);
			if (code.length === 6 && !this.byCode.has(code)) return code;
		}
	}
}

export function normalizeAccessRole(value: string | undefined): QQAccessRole | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "user" || normalized === "普通" || normalized === "普通用户") return "user";
	if (normalized === "admin" || normalized === "管理员" || normalized === "管理") return "admin";
	return undefined;
}

function normalizeCode(value: string): string {
	return value.trim().toUpperCase();
}

function redactRequestMessage(message: QQInboundMessage): QQInboundMessage {
	return {
		id: message.id,
		type: "private",
		text: "",
		userOpenId: message.userOpenId,
		attachments: [],
		raw: undefined,
		receivedAt: message.receivedAt,
	};
}
