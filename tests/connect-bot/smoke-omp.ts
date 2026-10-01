/**
 * L2 integration smoke: the real omp extension loader + ExtensionRunner +
 * native extension discovery, against the real `extensions/connect-bot`.
 *
 * Covers the load/config half of the ticket: the extension mounts with no
 * error, its id is derived from the directory name, a configured extensions
 * root discovers it with no second switch, and the endpoint config drives the
 * mount — a missing config.json still mounts (default endpoint, no `enabled`
 * gate), malformed content fails the mount.
 *
 * Run: bun tests/connect-bot/smoke-omp.ts
 */
import { expect } from "bun:test";
import * as fs from "node:fs/promises";

const OMP = "D:/nvm4w/nodejs/node_modules/@oh-my-pi/pi-coding-agent";
const OVERRIDE_ENDPOINT = "http://panel.local:9000";

// Dynamic imports are required: the omp install path is environment-specific
// (npm global) and this smoke must not hard-fail toolkit runs on machines
// without it — static imports would break module evaluation eagerly.
const { loadExtensions } = await import(`${OMP}/src/extensibility/extensions/loader.ts`);
const { ExtensionRunner } = await import(`${OMP}/src/extensibility/extensions/runner.ts`);
const { SessionManager } = await import(`${OMP}/src/session/session-manager.ts`);
const { ModelRegistry } = await import(`${OMP}/src/config/model-registry.ts`);
const { AuthStorage } = await import(`${OMP}/src/session/auth-storage.ts`);
const { discoverExtensionModulePaths, getExtensionNameFromPath } = await import(
	`${OMP}/src/discovery/helpers.ts`
);

const extensionsRoot = new URL("../../extensions", import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, "$1");
const extensionDir = `${extensionsRoot}/connect-bot`;
const entryPath = `${extensionDir}/index.ts`;

const hostActions = {
	sendMessage: (): void => {},
	sendUserMessage: (): void => {},
	appendEntry: (): void => {},
	getActiveTools: (): string[] => [],
	getAllTools: (): unknown[] => [],
	setActiveTools: async (): Promise<void> => {},
	getCommands: (): unknown[] => [],
	setModel: async (): Promise<boolean> => false,
	getThinkingLevel: (): string => "max",
	setThinkingLevel: async (): Promise<void> => {},
	getServiceTiers: async (): Promise<unknown[]> => [],
	setServiceTier: async (): Promise<void> => {},
	getSessionName: (): string => "smoke",
	setSessionName: (): void => {},
	registerProvider: (): void => {},
	unregisterProvider: (): void => {},
};

const contextActions = {
	getModel: (): undefined => undefined,
	isIdle: (): boolean => true,
	abort: (): void => {},
	hasPendingMessages: (): boolean => false,
	shutdown: (): void => {},
	getContextUsage: (): undefined => undefined,
	compact: async (): Promise<void> => {},
	getSystemPrompt: (): string[] => [],
};

let step = 0;
const pass = (label: string) => console.log(`✔ ${++step}. ${label}`);

const tmp = `${import.meta.dir}/smoke-tmp-${crypto.randomUUID()}`;

/** Copy the whole extension into its own directory so a substitute config.json drives the mount. */
async function stagedEntry(label: string, configJson: string | null): Promise<string> {
	const dir = `${tmp}/${label}`;
	await fs.mkdir(dir, { recursive: true });
	for (const entry of await fs.readdir(extensionDir)) {
		if (!entry.endsWith(".ts")) continue;
		await fs.copyFile(`${extensionDir}/${entry}`, `${dir}/${entry}`);
	}
	if (configJson !== null) {
		await fs.writeFile(`${dir}/config.json`, configJson);
	}
	return `${dir}/index.ts`;
}

try {
	const extensionModule = await import(new URL("../../extensions/connect-bot/index.ts", import.meta.url).href);
	expect(extensionModule.name).toBe("connect-bot");

	const loadResult = await loadExtensions([entryPath], tmp);
	expect(loadResult.errors).toEqual([]);
	expect(loadResult.extensions).toHaveLength(1);
	expect([...loadResult.extensions[0].commands.keys()]).toEqual(["connect-bot"]);
	expect(getExtensionNameFromPath(loadResult.extensions[0].resolvedPath)).toBe("connect-bot");
	pass('real loader mounts it with no errors; the /connect-bot command is registered and id/name agree');

	const discovered = await discoverExtensionModulePaths({} as never, extensionsRoot);
	const discoveredConnectBot = discovered.filter(path => getExtensionNameFromPath(path) === "connect-bot");
	expect(discoveredConnectBot).toHaveLength(1);
	expect(discoveredConnectBot[0].replace(/\\/g, "/")).toMatch(/\/connect-bot\/index\.ts$/);
	pass("the configured extensions root discovers it: dropping the directory in is the whole install");

	const authStorage = await AuthStorage.create(":memory:");
	const runner = new ExtensionRunner(
		loadResult.extensions,
		loadResult.runtime,
		tmp,
		SessionManager.create(tmp),
		new ModelRegistry(authStorage),
	);
	runner.initialize(hostActions as never, contextActions as never);
	await runner.emit({ type: "session_start" });
	pass("ExtensionRunner initializes and dispatches to it without error (command registered)");

	// The state machine hooks and the session-switch hooks are accepted by the
	// real runner, and dispatching them on an unarmed session does nothing (no
	// panel, no error).
	expect([...loadResult.extensions[0].handlers.keys()].sort()).toEqual([
		"agent_end",
		"agent_start",
		"session_branch",
		"session_stop",
		"session_switch",
	]);
	await runner.emit({ type: "agent_start" });
	await runner.emit({
		type: "session_stop",
		messages: [],
		turn_id: 0,
		session_id: "smoke",
		stop_hook_active: false,
		signal: new AbortController().signal,
	});
	await runner.emit({ type: "agent_end", messages: [] });
	// 未接入时「切换即断开」是零动作：这两个事件在真 runner 上必须安静通过。
	await runner.emit({ type: "session_switch", reason: "resume", previousSessionFile: undefined });
	await runner.emit({ type: "session_branch", previousSessionFile: undefined });
	pass("the state-machine and session-switch hooks mount and dispatch through the real runner");

	const missing = await loadExtensions([await stagedEntry("missing-config", null)], tmp);
	expect(missing.errors).toEqual([]);
	expect(missing.extensions).toHaveLength(1);
	pass("a missing config.json still mounts: default endpoint, no `enabled` gate");

	const overridden = await loadExtensions(
		// The stray `enabled` key is the point: this extension has no such gate.
		[await stagedEntry("override-config", JSON.stringify({ endpoint: OVERRIDE_ENDPOINT, enabled: false }))],
		tmp,
	);
	expect(overridden.errors).toEqual([]);
	expect(overridden.extensions).toHaveLength(1);
	pass("an endpoint override mounts cleanly, and a stray `enabled: false` gates nothing");

	const malformed = await loadExtensions([await stagedEntry("malformed-config", "{ not json")], tmp);
	expect(malformed.extensions).toEqual([]);
	expect(malformed.errors).toHaveLength(1);
	expect(malformed.errors[0].error).toMatch(/Failed to load extension/);
	pass("malformed config.json fails the mount and the loader reports the error");

	console.log("\nL2 smoke: all checks passed.");
} finally {
	await fs.rm(tmp, { recursive: true, force: true });
}
