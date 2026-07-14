import assert from "node:assert/strict";

import { buildModelPage, MAX_MODEL_PAGE_SIZE, normalizeModelPageSize } from "./model-pages.ts";
import type { QQModelInfo } from "./qq-session.ts";

function models(count: number): QQModelInfo[] {
	return Array.from({ length: count }, (_, index) => ({
		provider: "test",
		id: `model-${index + 1}`,
		name: `Model ${index + 1}`,
		input: ["text"],
		reasoning: false,
	}));
}

for (const count of [0, 1, 5, 6, 7, 8, 25]) {
	const page = buildModelPage(models(count), 1, 99);
	assert.equal(page.pageSize, MAX_MODEL_PAGE_SIZE);
	assert.equal(page.total, count);
	assert.equal(page.totalPages, Math.max(1, Math.ceil(count / MAX_MODEL_PAGE_SIZE)));
	assert.ok(page.keyboardRows.length <= 5);
	assert.ok(page.keyboardRows.every((row) => row.length <= 2));
}

const first = buildModelPage(models(8), 1, 6);
assert.equal(first.models.length, 6);
assert.equal(first.totalPages, 2);
assert.deepEqual(first.fallbackCommands, ["/model page 2"]);
assert.equal(first.keyboardRows.at(-2)?.[0]?.command, "/model page 2");

const second = buildModelPage(models(8), 2, 6);
assert.equal(second.models.length, 2);
assert.deepEqual(second.fallbackCommands, ["/model page 1"]);
assert.equal(second.keyboardRows.at(-2)?.[0]?.command, "/model page 1");

assert.equal(normalizeModelPageSize(0), 1);
assert.equal(normalizeModelPageSize(100), MAX_MODEL_PAGE_SIZE);
assert.throws(() => buildModelPage(models(8), 3, 6), /页码无效/);

console.log("model-pages.test.ts: ok");
