export interface ParsedQQCommand {
	name: string;
	args: string[];
	rawArgs: string;
}

const COMMAND_ALIASES: Record<string, string> = {
	"qqbot-help": "help",
	"qqbot-status": "status",
	"qqbot-last": "last",
	cancel: "stop",
};

const MAX_COMMAND_BYTES = 2048;
const MAX_ARGUMENTS = 20;

/** Parse one slash-prefixed QQ command without invoking a shell or a model. */
export function parseQQCommand(text: string): ParsedQQCommand | undefined {
	const source = text.trim();
	if (!source.startsWith("/")) return undefined;
	if (Buffer.byteLength(source, "utf8") > MAX_COMMAND_BYTES) throw new Error("命令过长，请缩短后重试");
	const separator = source.search(/\s/);
	const rawName = (separator < 0 ? source.slice(1) : source.slice(1, separator)).toLowerCase();
	if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(rawName)) throw new Error("命令名称无效；发送 /help 查看可用命令");
	const rawArgs = separator < 0 ? "" : source.slice(separator).trim();
	const args = tokenizeArguments(rawArgs);
	if (args.length > MAX_ARGUMENTS) throw new Error(`参数过多，最多允许 ${MAX_ARGUMENTS} 个`);
	return { name: COMMAND_ALIASES[rawName] ?? rawName, args, rawArgs };
}

function tokenizeArguments(source: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of source) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote) {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/u.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("命令中的引号没有闭合");
	if (current) args.push(current);
	return args;
}
