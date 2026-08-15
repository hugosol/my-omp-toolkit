import { describe, test, expect } from "bun:test";

import anchoredStandard, { name } from "../../extensions/anchored-standard/index";
import type { AgentRegistryLike } from "../../extensions/anchored-standard/phase";
import { ROLE_MARKER, RUNTIME_MARKER } from "../../extensions/anchored-standard/strip";
import { readTextFile, writeTextFile } from "./helpers";

// URL.pathname carries a leading slash on Windows; strip it for the drive path.
const configPath = new URL("../../extensions/anchored-standard/config.json", import.meta.url).pathname.replace(
	/^\/([A-Za-z]:\/)/,
	"$1",
);
let shippedConfig = "";

type FakeHandler = (event: unknown, ctx: unknown) => unknown;

interface FakeUi {
	notifyCalls: Array<{ message: string; type?: string }>;
	setStatusCalls: Array<{ key: string; text?: string }>;
	notify(message: string, type?: string): void;
	setStatus(key: string, text: string | undefined): void;
}

interface FakeApi {
	on(event: string, handler: FakeHandler): void;
	logger: { warn(message: string): void };
	sendMessage: (message: unknown, options?: unknown) => void;
	pi: { AgentRegistry: { global(): AgentRegistryLike } };
}

interface FakeSessionManager {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getEntries(): unknown[];
}

interface FakeContext {
	sessionManager: FakeSessionManager;
	getSystemPrompt(): string[];
	hasUI: boolean;
	mode: string;
	ui: FakeUi;
}

interface CtxOptions {
	id?: string;
	file?: string;
	basePrompt?: string[];
	hasUI?: boolean;
	mode?: string;
}

const makeUi = (): FakeUi => {
	const ui = {
		notifyCalls: [] as Array<{ message: string; type?: string }>,
		setStatusCalls: [] as Array<{ key: string; text?: string }>,
		notify(message: string, type?: string): void {
			ui.notifyCalls.push({ message, type });
		},
		setStatus(key: string, text: string | undefined): void {
			ui.setStatusCalls.push({ key, text });
		},
	};
	return ui as FakeUi;
};

const ctx = (entries: unknown[] = [], options: CtxOptions = {}): FakeContext => {
	const ui = makeUi();
	return {
		sessionManager: {
			getSessionId: () => options.id ?? "s1",
			getSessionFile: () => options.file,
			getEntries: () => entries,
		},
		getSystemPrompt: () => options.basePrompt ?? FULL_PROMPT,
		hasUI: options.hasUI ?? false,
		mode: options.mode ?? "print",
		ui,
	};
};

const userEntry = { type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
const assistantEntry = () => ({
	type: "message",
	id: "a",
	message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
});

const CONVENTIONS = "<system-conventions>safety conventions</system-conventions>";
const PERSONA_SECTION = `${ROLE_MARKER}\npersona section text\n# Escalation`;
const RUNTIME_SECTION = `${RUNTIME_MARKER}\n<skills>read, bash, edit</skills>\n<Tool Inventory>read, bash, edit</Tool Inventory>`;
const MARKED_BLOCK = `${CONVENTIONS}\n\n${PERSONA_SECTION}\n\n${RUNTIME_SECTION}`;
const FULL_PROMPT = [MARKED_BLOCK, "<repo-rules>AGENTS.md digest</repo-rules>"];
const BROKEN_PROMPT = ["<skills>read, bash</skills>", "<repo-rules>AGENTS.md digest</repo-rules>"];
const STRIPPED_FULL = `${CONVENTIONS}\n\n${RUNTIME_SECTION}\n\n<repo-rules>AGENTS.md digest</repo-rules>`;
const PERSONA = "You are a helpful software engineer assistant.";

/** Build the fake API and apply the factory against it. */
function register(refs: Array<{ kind?: string; sessionFile?: string | null }> = []) {
	const handlers = new Map<string, FakeHandler>();
	const warns: string[] = [];
	const sent: Array<{ message: Record<string, unknown>; options?: unknown }> = [];
	const api: FakeApi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		logger: { warn: message => warns.push(String(message)) },
		sendMessage: (message, options) => sent.push({ message: message as Record<string, unknown>, options }),
		pi: { AgentRegistry: { global: () => ({ list: () => refs }) } },
	};
	return { api, handlers, warns, sent };
}

async function apply(api: FakeApi): Promise<void> {
	await anchoredStandard(api as Parameters<typeof anchoredStandard>[0]);
}

async function fire(handlers: Map<string, FakeHandler>, event: string, payload: unknown, context: unknown): Promise<unknown> {
	const handler = handlers.get(event);
	if (!handler) throw new Error(`handler not registered: ${event}`);
	return handler(payload, context);
}

/** Rewrite config.json for one test; restore in finally. */
async function withConfig(config: unknown, fn: () => Promise<void>): Promise<void> {
	await writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
	try {
		await fn();
	} finally {
		await writeTextFile(configPath, shippedConfig);
	}
}

// ---------------------------------------------------------------------------

describe("extension", () => {
	test("shipped config.json matches the agreed defaults", async () => {
		shippedConfig = await readTextFile(configPath);
		expect(JSON.parse(shippedConfig)).toEqual({ enabled: true });
	});

	test("exports a diagnostic extension name", () => {
		expect(typeof name).toBe("string");
		expect(name.length).toBeGreaterThan(0);
	});

	test("enabled: false registers no handlers", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), enabled: false }, async () => {
			const { api, handlers } = register();
			await apply(api);
			expect(handlers.size).toBe(0);
		});
	});

	test("invalid config fails at load time", async () => {
		await withConfig({ enabled: "on" }, async () => {
			const { api } = register();
			await expect(apply(api)).rejects.toThrow(/enabled/);
		});
		await withConfig({ personaText: "" }, async () => {
			const { api } = register();
			await expect(apply(api)).rejects.toThrow(/personaText/);
		});
	});

	test("retired config keys are silently ignored", async () => {
		await withConfig(
			{
				enabled: true,
				personaText: PERSONA,
				promoteOn: "never",
				bootstrapMaxTokens: 0,
				restoreMode: "magic",
				shellTools: [],
				commonTools: [],
			},
			async () => {
				const { api, handlers } = register();
				await apply(api);
				const result = await fire(
					handlers,
					"before_agent_start",
					{ type: "before_agent_start", systemPrompt: FULL_PROMPT },
					ctx([]),
				);
				expect(result).toEqual({ systemPrompt: [PERSONA] });
			},
		);
	});
});

describe("hook surface", () => {
	test("registers session_start, before_agent_start, and context only", async () => {
		const { api, handlers } = register();
		await apply(api);
		expect([...handlers.keys()].sort()).toEqual(["before_agent_start", "context", "session_start"]);
		expect(handlers.has("before_provider_request")).toBe(false);
	});
});

describe("before_agent_start", () => {
	test("unpromoted: system prompt becomes the persona", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, ctx([]));
		expect(result).toEqual({ systemPrompt: [PERSONA] });
	});

	test("promoted: persona stays for the whole session", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = await fire(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: FULL_PROMPT },
			ctx([assistantEntry()]),
		);
		expect(result).toEqual({ systemPrompt: [PERSONA] });
	});

	test("custom personaText is used verbatim", async () => {
		await withConfig({ enabled: true, personaText: "Custom persona." }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const result = await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, ctx([]));
			expect(result).toEqual({ systemPrompt: ["Custom persona."] });
		});
	});

	test("subagents keep their original prompt", async () => {
		const { api, handlers } = register([{ kind: "sub", sessionFile: "/sessions/sub.jsonl" }]);
		await apply(api);
		const result = await fire(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: FULL_PROMPT },
			ctx([], { id: "sub1", file: "/sessions/sub.jsonl" }),
		);
		expect(result).toBeUndefined();
	});

	test("sessions without a readable session id keep their original prompt", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, {});
		expect(result).toBeUndefined();
	});

	test("missing strip markers: prompt untouched, one visible warning, latch set", async () => {
		const { api, handlers, warns, sent } = register();
		await apply(api);
		const result = await fire(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: BROKEN_PROMPT },
			ctx([]),
		);
		expect(result).toBeUndefined();
		expect(warns.filter(w => w.includes("锚点"))).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.customType).toBe("anchored-standard/anchor-mismatch");
		expect(sent[0].message.display).toBe(true);
		expect(sent[0].message.attribution).toBe("agent");
		expect(sent[0].options).toEqual({ triggerTurn: false });

		// Same session reports only once, even when the next start is still broken.
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: BROKEN_PROMPT }, ctx([]));
		expect(sent).toHaveLength(1);
		expect(warns.filter(w => w.includes("锚点"))).toHaveLength(1);
	});

	test("an agent start without systemPrompt disables instead of replacing", async () => {
		const { api, handlers, sent } = register();
		await apply(api);
		const result = await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: [] }, ctx([]));
		expect(result).toBeUndefined();
		expect(sent).toHaveLength(1);
	});

	test("markers recovered on a later start: persona returns (self-heal)", async () => {
		const { api, handlers, sent } = register();
		await apply(api);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: BROKEN_PROMPT }, ctx([]));
		const healed = await fire(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: FULL_PROMPT },
			ctx([assistantEntry()]),
		);
		expect(healed).toEqual({ systemPrompt: [PERSONA] });
		expect(sent).toHaveLength(1); // notification stays one-per-session
	});
});

describe("session_start", () => {
	test("good base prompt: extension stays active, no notification", async () => {
		const { api, handlers, warns, sent } = register();
		await apply(api);
		await fire(handlers, "session_start", { type: "session_start" }, ctx([]));
		expect(warns).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("broken base prompt: latch set, one warning message, TUI notify and status", async () => {
		const { api, handlers, warns, sent } = register();
		await apply(api);
		const session = ctx([], { basePrompt: BROKEN_PROMPT, hasUI: true, mode: "tui" });
		await fire(handlers, "session_start", { type: "session_start" }, session);
		expect(warns.filter(w => w.includes("锚点"))).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(session.ui.notifyCalls).toHaveLength(1);
		expect(session.ui.notifyCalls[0].type).toBe("warning");
		expect(session.ui.notifyCalls[0].message).toContain("锚点");
		expect(session.ui.setStatusCalls).toHaveLength(1);
		expect(session.ui.setStatusCalls[0].key).toBe("anchored-standard");

		// All later hooks stay untouched for that session.
		const start = await fire(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: BROKEN_PROMPT },
			ctx([assistantEntry()]),
		);
		expect(start).toBeUndefined();
		const result = await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, ctx([assistantEntry()]));
		expect(result).toBeUndefined();
		expect(sent).toHaveLength(1);
	});

	test("print mode: no UI calls, stderr path is taken", async () => {
		const { api, handlers, sent } = register();
		await apply(api);
		const session = ctx([], { basePrompt: BROKEN_PROMPT, mode: "print" });
		await fire(handlers, "session_start", { type: "session_start" }, session);
		expect(session.ui.notifyCalls).toEqual([]);
		expect(session.ui.setStatusCalls).toEqual([]);
		expect(sent).toHaveLength(1);
	});

	test("subagent session_start is skipped entirely", async () => {
		const { api, handlers, warns, sent } = register([{ kind: "sub", sessionFile: "/sessions/sub.jsonl" }]);
		await apply(api);
		const sub = ctx([], { id: "sub1", file: "/sessions/sub.jsonl", basePrompt: BROKEN_PROMPT, hasUI: true, mode: "tui" });
		await fire(handlers, "session_start", { type: "session_start" }, sub);
		expect(warns).toEqual([]);
		expect(sent).toEqual([]);
		expect(sub.ui.notifyCalls).toEqual([]);
	});

	test("an empty base prompt is not a verdict: wait for the agent start", async () => {
		const { api, handlers, warns, sent } = register();
		await apply(api);
		await fire(handlers, "session_start", { type: "session_start" }, ctx([], { basePrompt: [] }));
		expect(warns).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("a session without an id is skipped", async () => {
		const { api, handlers, sent } = register();
		await apply(api);
		await fire(handlers, "session_start", { type: "session_start" }, ctx([], { id: "" }));
		expect(sent).toEqual([]);
	});

	test("markers recovered after a broken startup: self-heal at agent start", async () => {
		const { api, handlers, sent } = register();
		await apply(api);
		await fire(handlers, "session_start", { type: "session_start" }, ctx([], { basePrompt: BROKEN_PROMPT }));
		const healed = await fire(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: FULL_PROMPT },
			ctx([assistantEntry()]),
		);
		expect(healed).toEqual({ systemPrompt: [PERSONA] });
		expect(sent).toHaveLength(1);
		const result = (await fire(
			handlers,
			"context",
			{ type: "context", messages: [userEntry.message] },
			ctx([assistantEntry()]),
		)) as { messages: Array<{ role: string; content: unknown }> };
		expect(result.messages).toHaveLength(2);
		expect(result.messages[1].role).toBe("developer");
	});
});

describe("context", () => {
	const applyAndStart = async () => {
		const { api, handlers } = register();
		await apply(api);
		return { handlers };
	};

	test("unpromoted requests get untouched messages", async () => {
		const { handlers } = await applyAndStart();
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, ctx([]));
		const result = await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, ctx([]));
		expect(result).toBeUndefined();
	});

	test("promoted requests carry the stripped prompt as a developer message", async () => {
		const { handlers } = await applyAndStart();
		const promoted = ctx([assistantEntry()]);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, promoted);
		const messages = [userEntry.message, assistantEntry().message];
		const result = (await fire(handlers, "context", { type: "context", messages }, promoted)) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		expect(result.messages).toHaveLength(3);
		expect(result.messages[1].role).toBe("developer");
		expect(result.messages[1].content).toBe(STRIPPED_FULL);
		expect(String(result.messages[1].content)).not.toContain("persona section text");
	});

	test("the developer message is inserted on every promoted request", async () => {
		const { handlers } = await applyAndStart();
		const promoted = ctx([assistantEntry()]);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, promoted);
		for (let i = 0; i < 3; i++) {
			const result = (await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, promoted)) as {
				messages: Array<{ role: string }>;
			};
			expect(result.messages).toHaveLength(2);
			expect(result.messages[1].role).toBe("developer");
		}
	});

	test("no captured prompt means no developer message", async () => {
		const { handlers } = await applyAndStart();
		const promoted = ctx([assistantEntry()]);
		const result = await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, promoted);
		expect(result).toBeUndefined();
	});

	test("subagents never get the developer message", async () => {
		const { api, handlers } = register([{ kind: "sub", sessionFile: "/sessions/sub.jsonl" }]);
		await apply(api);
		const sub = ctx([], { id: "sub1", file: "/sessions/sub.jsonl" });
		const result = await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, sub);
		expect(result).toBeUndefined();
	});

	test("a session with broken anchors gets no developer message even when promoted", async () => {
		const { api, handlers } = register();
		await apply(api);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: BROKEN_PROMPT }, ctx([]));
		const promoted = ctx([assistantEntry()]);
		const result = await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, promoted);
		expect(result).toBeUndefined();
	});

	test("the prompt capture refreshes on later agent starts", async () => {
		const { handlers } = await applyAndStart();
		const promoted = ctx([assistantEntry()]);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, promoted);
		const newerRuntime = `${RUNTIME_MARKER}\n<skills>updated</skills>`;
		const newer = [`${CONVENTIONS}\n\n${ROLE_MARKER}\nupdated persona\n\n${newerRuntime}`, "<repo-rules>updated</repo-rules>"];
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: newer }, promoted);
		const result = (await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, promoted)) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		expect(result.messages[1].content).toBe(`${CONVENTIONS}\n\n${newerRuntime}\n\n<repo-rules>updated</repo-rules>`);
	});

	test("an empty message list still gets the developer message at index 0", async () => {
		const { handlers } = await applyAndStart();
		const promoted = ctx([assistantEntry()]);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, promoted);
		const result = (await fire(handlers, "context", { type: "context", messages: [] }, promoted)) as {
			messages: Array<{ role: string }>;
		};
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("developer");
	});
});
