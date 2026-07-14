import type { QQInboundMessage, QQKeyboard, QQKeyboardButton } from "./types";

export interface QQCommandButton {
	label: string;
	command: string;
	primary?: boolean;
}

/**
 * Build a conservative two-column QQ command keyboard.
 *
 * QQ's "specified user" button permission uses platform user IDs, while C2C
 * and group-v2 events expose openids/member_openids. Sending those openids as
 * specify_user_ids makes the official client reject the click as unauthorized.
 * The server still enforces the allowlist/admin policy on every resulting
 * command message, so buttons use permission.type=2 (everyone in this chat may
 * click) and authorization remains authoritative in command-controller.ts.
 */
export function buildCommandKeyboard(msg: QQInboundMessage, rows: QQCommandButton[][]): QQKeyboard | undefined {
	if (!msg.userOpenId || !rows.length) return undefined;
	const contentRows = rows.slice(0, 5).map((row, rowIndex) => ({
		buttons: row.slice(0, 5).map((button, columnIndex) => makeButton(msg, button, rowIndex, columnIndex)),
	}));
	if (!contentRows.some((row) => row.buttons.length)) return undefined;
	return { content: { rows: contentRows.filter((row) => row.buttons.length) } };
}

function makeButton(
	msg: QQInboundMessage,
	button: QQCommandButton,
	rowIndex: number,
	columnIndex: number,
): QQKeyboardButton {
	const label = button.label.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 20) || "操作";
	const command = button.command.trim().slice(0, 300);
	return {
		id: `cmd-${rowIndex}-${columnIndex}`,
		render_data: { label, visited_label: label, style: button.primary ? 1 : 0 },
		action: {
			type: 2,
			permission: { type: 2 },
			data: command,
			reply: false,
			enter: msg.type === "private",
			unsupport_tips: `请手动发送：${command}`.slice(0, 80),
		},
	};
}
