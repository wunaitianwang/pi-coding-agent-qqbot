import type { ParsedQQCommand } from "./command-parser";
import type { PiQQBotConfig, QQInboundMessage } from "./types";

export const QQ_COMMAND_NAMES = new Set([
	"help",
	"status",
	"last",
	"model",
	"thinking",
	"new",
	"sessions",
	"resume",
	"name",
	"compact",
	"stop",
]);

export const QQ_REMOTE_BLOCKED_COMMANDS = new Set([
	"login",
	"logout",
	"theme",
	"settings",
	"quit",
	"exit",
	"reload",
	"tree",
	"fork",
	"clone",
	"clear",
	"redo",
	"undo",
]);

export function isMutatingQQCommand(name: string): boolean {
	return ["model", "thinking", "new", "resume", "name", "compact", "stop"].includes(name);
}

export function authorizeQQCommand(
	config: PiQQBotConfig,
	msg: QQInboundMessage,
	command: ParsedQQCommand,
): { allowed: true } | { allowed: false; reason: string } {
	if (msg.fake) return { allowed: true };
	if (!QQ_COMMAND_NAMES.has(command.name)) {
		return {
			allowed: false,
			reason: QQ_REMOTE_BLOCKED_COMMANDS.has(command.name)
				? `命令 \`/${command.name}\` 只能在受信任的主机终端中执行。QQ 命令只管理隔离的 QQ 会话。`
				: `未知命令 \`/${command.name}\`。`,
		};
	}
	if (!config.commands.enabled && !["help", "status", "last"].includes(command.name)) {
		return { allowed: false, reason: "当前只允许 `/help`、`/status` 和 `/last`。请在主机配置 `commands.enabled: true`。" };
	}
	if (!isMutatingQQCommand(command.name)) return { allowed: true };
	const admins = config.commands.admins;
	if (msg.type === "private") {
		const allowed = admins.includes(msg.userOpenId);
		return allowed ? { allowed: true } : { allowed: false, reason: "你是普通用户，没有 QQ 会话管理权限。请让主机管理员将你加入 `commands.admins`。" };
	}
	const allowed = config.commands.allowInGroups && admins.includes(msg.userOpenId);
	return allowed ? { allowed: true } : { allowed: false, reason: "群聊管理命令默认关闭，或你不在 `commands.admins` 中。" };
}
