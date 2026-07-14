import assert from "node:assert/strict";

import { normalizeConfig } from "./config.ts";

const legacy = normalizeConfig({
	enabled: true,
	autoStart: false,
	appId: "test",
	clientSecret: "test",
	commands: { modelPageSize: 99 },
});

assert.equal(legacy.schemaVersion, 2);
assert.equal(legacy.startup.mode, "manual");
assert.equal(legacy.commands.modelPageSize, 6);

const current = normalizeConfig({
	schemaVersion: 1,
	enabled: true,
	appId: "test",
	clientSecret: "test",
	startup: { mode: "auto" },
	commands: { modelPageSize: 0 },
});

assert.equal(current.schemaVersion, 2);
assert.equal(current.startup.mode, "auto");
assert.equal(current.commands.modelPageSize, 1);

console.log("config.test.ts: ok");
