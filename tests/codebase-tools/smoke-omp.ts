/**
 * L2 integration smoke: real omp extension loader + runner from the INSTALLED
 * omp package (npm global), no model, no network.
 *
 *   bun tests/codebase-tools/smoke-omp.ts
 *
 * Checks the `/codebase-tools` toggle, init-once-then-reminder injection, state
 * persistence through appendEntry, resume restore, and subagent inheritance.
 */
import { expect } from "bun:test";

const OMP = "D:/nvm4w/nodejs/node_modules/@oh-my-pi/pi-coding-agent";
const extPath = new URL("../../extensions/codebase-tools/index.ts", import.meta.url).pathname.replace(
	/^\/([A-Za-z]:\/)/,
	"$1",
);

// Dynamic imports are required: the omp install path is environment-specific
// (npm global) and this smoke must not hard-fail toolkit runs on machines
// without it — static imports would break module evaluation eagerly.
const { loadExtensions } = await import(`${OMP}/src/extensibility/extensions/loader.ts`);
const { ExtensionRunner } = await import(`${OMP}/src/extensibility/extensions/runner.ts`);
const { SessionManager } = await import(`${OMP}/src/session/session-manager.ts`);
const { ModelRegistry } = await import(`${OMP}/src/config/model-registry.ts`);
const { AuthStorage } = await import(`${OMP}/src/session/auth-storage.ts`);

const INIT_TYPE = "codebase-tools:init";
const REMINDER_TYPE = "codebase-tools:reminder";
const STATE_TYPE = "codebase-tools:state";

const statuses: Array<{ key: string; text: string | undefined }> = [];
const fakeUi = {
	setStatus: (key: string, text: string | undefined): void => {
		statuses.push({ key, text });
	},
	notify: (): void => {},
};

const contextActions = {
	getModel: (): undefined => undefined,
	isIdle: (): boolean => true,
	abort: (): void => {},
	hasPendingMessages: (): boolean => false,
	shutdown: (): void => {},
	getContextUsage: (): undefined => undefined,
	compact: async (): Promise<void> => {},
	getSystemPrompt: (): string[] => ["base-system"],
};

interface ManagerLike {
	appendCustomEntry(customType: string, data?: unknown): string;
}

function actionsFor(manager: ManagerLike) {
	return {
		sendMessage: (): void => {},
		sendUserMessage: (): void => {},
		appendEntry: (customType: string, data?: unknown): void => {
			manager.appendCustomEntry(customType, data);
		},
		setLabel: (): void => {},
		getActiveTools: (): string[] => [],
		getAllTools: (): unknown[] => [],
		setActiveTools: async (): Promise<void> => {},
		getCommands: (): unknown[] => [],
		setModel: async (): Promise<boolean> => false,
		getThinkingLevel: (): string => "max",
		setThinkingLevel: async (): Promise<void> => {},
		getSessionName: (): string => "smoke",
		setSessionName: (): void => {},
		registerProvider: (): void => {},
		unregisterProvider: (): void => {},
		getServiceTiers: async (): Promise<unknown[]> => [],
		setServiceTier: async (): Promise<void> => {},
	};
}

const MAIN_AGENT = { kind: "main", id: "Main", name: "main", depth: 0 } as const;
const SUB_AGENT = { kind: "sub", id: "0-Explore", name: "explore", depth: 1, parentId: "Main" } as const;

const tmp = `${import.meta.dir}/smoke-tmp-${crypto.randomUUID()}`;
let step = 0;
const pass = (label: string) => console.log(`✔ ${++step}. ${label}`);

const loadResult = await loadExtensions([extPath], tmp);
expect(loadResult.errors).toEqual([]);
expect(loadResult.extensions).toHaveLength(1);
pass("extension loads through the real omp loader with no errors");

const authStorage = await AuthStorage.create(":memory:");
const modelRegistry = new ModelRegistry(authStorage);

function makeRunner(manager: unknown, agent: unknown) {
	const runner = new ExtensionRunner(
		loadResult.extensions,
		loadResult.runtime,
		tmp,
		manager as never,
		modelRegistry,
		undefined,
		undefined,
		undefined,
		undefined,
		agent as never,
	);
	runner.initialize(actionsFor(manager as ManagerLike) as never, contextActions as never, undefined, fakeUi as never);
	return runner;
}

// --- main: off -> toggle -> init -> reminder ---
const mainManager = SessionManager.create(tmp);
const mainRunner = makeRunner(mainManager, MAIN_AGENT);
await mainRunner.emit({ type: "session_start" });
expect(statuses[statuses.length - 1]).toEqual({ key: "codebase-tools", text: undefined });
expect(await mainRunner.emitBeforeAgentStart("hi", undefined, ["base-system"])).toBeUndefined();
pass("main session starts off");

const command = mainRunner.getCommand("codebase-tools");
expect(command).toBeDefined();
await command!.handler("", mainRunner.createCommandContext());
expect(mainManager.getEntries().some(entry => entry.type === "custom" && entry.customType === STATE_TYPE)).toBe(true);
pass("/codebase-tools toggles on and persists state");

const first = await mainRunner.emitBeforeAgentStart("hi", undefined, ["base-system"]);
expect(first?.messages?.[0]?.customType).toBe(INIT_TYPE);
const second = await mainRunner.emitBeforeAgentStart("again", undefined, ["base-system"]);
expect(second?.messages?.[0]?.customType).toBe(REMINDER_TYPE);
pass("first enabled turn injects init, then reminder");

// --- resume: persisted on + initInjected -> reminder only ---
const resumedManager = SessionManager.create(tmp);
resumedManager.appendCustomEntry(STATE_TYPE, { on: true, initInjected: true });
const resumedRunner = makeRunner(resumedManager, MAIN_AGENT);
await resumedRunner.emit({ type: "session_start" });
expect((await resumedRunner.emitBeforeAgentStart("hi", undefined, ["base-system"]))?.messages?.[0]?.customType).toBe(
	REMINDER_TYPE,
);
pass("resume restores on + initInjected, no duplicate init");

// --- resume: on but not initialized -> init ---
const freshManager = SessionManager.create(tmp);
freshManager.appendCustomEntry(STATE_TYPE, { on: true, initInjected: false });
const freshRunner = makeRunner(freshManager, MAIN_AGENT);
await freshRunner.emit({ type: "session_start" });
expect((await freshRunner.emitBeforeAgentStart("hi", undefined, ["base-system"]))?.messages?.[0]?.customType).toBe(
	INIT_TYPE,
);
pass("resume of an un-initialized on state injects init");

// --- subagent inherits the main toggle ---
const subManager = SessionManager.create(tmp);
const subRunner = makeRunner(subManager, SUB_AGENT);
await subRunner.emit({ type: "session_start" });
expect((await subRunner.emitBeforeAgentStart("task", undefined, ["base-system"]))?.messages?.[0]?.customType).toBe(
	INIT_TYPE,
);
expect((await subRunner.emitBeforeAgentStart("task", undefined, ["base-system"]))?.messages?.[0]?.customType).toBe(
	REMINDER_TYPE,
);
pass("subagent inherits the main toggle and runs its own init");

// --- off restore stays silent ---
const offManager = SessionManager.create(tmp);
offManager.appendCustomEntry(STATE_TYPE, { on: false, initInjected: true });
const offRunner = makeRunner(offManager, MAIN_AGENT);
await offRunner.emit({ type: "session_start" });
expect(await offRunner.emitBeforeAgentStart("hi", undefined, ["base-system"])).toBeUndefined();
pass("off restore injects nothing");

console.log("\nL2 smoke: all checks passed.");
