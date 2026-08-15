import { describe, test, expect } from "bun:test";

import anchoredStandard, { name } from "../../extensions/anchored-standard/index";
import type { AgentRegistryLike } from "../../extensions/anchored-standard/phase";
import { readTextFile, writeTextFile } from "./helpers";

// URL.pathname carries a leading slash on Windows; strip it for the drive path.
const configPath = new URL("../../extensions/anchored-standard/config.json", import.meta.url).pathname.replace(
	/^\/([A-Za-z]:\/)/,
	"$1",
);
let shippedConfig = "";

type FakeHandler = (event: unknown, ctx: unknown) => unknown;

interface FakeApi {
	on(event: string, handler: FakeHandler): void;
	logger: { warn(message: string): void };
	pi: { AgentRegistry: { global(): AgentRegistryLike } };
}

interface FakeSessionManager {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	getEntries(): unknown[];
}

interface FakeContext {
	sessionManager: FakeSessionManager;
}

const ctx = (entries: unknown[] = [], options: { id?: string; file?: string } = {}): FakeContext => ({
	sessionManager: {
		getSessionId: () => options.id ?? "s1",
		getSessionFile: () => options.file,
		getEntries: () => entries,
	},
});

const userEntry = { type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
const assistantEntry = (blocks: unknown[] = []) => ({
	type: "message",
	id: "a",
	message: { role: "assistant", content: [{ type: "text", text: "ok" }, ...blocks] },
});
const toolCallBlock = { type: "toolCall", id: "t1", name: "read", arguments: {} };

const FULL_PROMPT = ["<skills>read, bash, edit</skills>", "<repo-rules>AGENTS.md text</repo-rules>"];

const ANTHROPIC_PAYLOAD = () => ({
	model: "claude-x",
	messages: [],
	system: [],
	max_tokens: 64000,
	tools: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "grep" }],
});

const CHAT_COMPLETIONS_PAYLOAD = () => ({
	model: "deepseek-v4",
	messages: [],
	max_completion_tokens: 8192,
	tools: [
		{ type: "function", function: { name: "read" } },
		{ type: "function", function: { name: "bash" } },
		{ type: "function", function: { name: "write" } },
	],
});

const RESPONSES_PAYLOAD = () => ({
	model: "gpt-x",
	input: [],
	max_output_tokens: 32768,
	tools: [{ type: "function", name: "read" }, { type: "function", name: "bash" }],
});

/** Build the fake API and apply the factory against it. */
function register(refs: Array<{ kind?: string; sessionFile?: string | null }> = []) {
	const handlers = new Map<string, FakeHandler>();
	const warns: string[] = [];
	const api: FakeApi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		logger: { warn: message => warns.push(String(message)) },
		pi: { AgentRegistry: { global: () => ({ list: () => refs }) } },
	};
	return { api, handlers, warns };
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
		expect(JSON.parse(shippedConfig)).toEqual({
			enabled: true,
			promoteOn: "either",
			bootstrapMaxTokens: 1024,
			personaText: "You are a helpful software engineer assistant.",
			restoreMode: "append",
			shellTools: ["bash", "pwsh"],
			commonTools: ["read"],
		});
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
		await withConfig({ ...JSON.parse(shippedConfig), promoteOn: "never" }, async () => {
			const { api } = register();
			await expect(apply(api)).rejects.toThrow(/promoteOn/);
		});
		await withConfig({ ...JSON.parse(shippedConfig), restoreMode: "magic" }, async () => {
			const { api } = register();
			await expect(apply(api)).rejects.toThrow(/restoreMode/);
		});
		await withConfig({ ...JSON.parse(shippedConfig), bootstrapMaxTokens: 0 }, async () => {
			const { api } = register();
			await expect(apply(api)).rejects.toThrow(/bootstrapMaxTokens/);
		});
	});
});

describe("before_agent_start", () => {
	test("unpromoted: system prompt becomes the persona (append mode)", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, ctx([]));
		expect(result).toEqual({ systemPrompt: ["You are a helpful software engineer assistant."] });
	});

	test("promoted + append mode: system prompt stays persona (whole-session)", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = await fire(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: FULL_PROMPT },
			ctx([assistantEntry()]),
		);
		expect(result).toEqual({ systemPrompt: ["You are a helpful software engineer assistant."] });
	});

	test("promoted + system-block mode: original prompt returns", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), restoreMode: "system-block" }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const result = await fire(
				handlers,
				"before_agent_start",
				{ type: "before_agent_start", systemPrompt: FULL_PROMPT },
				ctx([assistantEntry()]),
			);
			expect(result).toBeUndefined();
		});
	});

	test("unpromoted + system-block mode: persona replaces the prompt", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), restoreMode: "system-block" }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const result = await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, ctx([]));
			expect(result).toEqual({ systemPrompt: ["You are a helpful software engineer assistant."] });
		});
	});

	test("custom personaText is used verbatim", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), personaText: "Custom persona." }, async () => {
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
});

describe("before_provider_request", () => {
	test("unpromoted anthropic payload: tools narrowed, max_tokens capped", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() }, ctx([]))) as {
			tools: Array<{ name: string }>;
			max_tokens: number;
		};
		expect(result.tools.map(t => t.name)).toEqual(["read", "bash"]);
		expect(result.max_tokens).toBe(1024);
	});

	test("unpromoted chat-completions payload: nested names narrowed, max_completion_tokens capped", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload: CHAT_COMPLETIONS_PAYLOAD() }, ctx([]))) as {
			tools: Array<{ function: { name: string } }>;
			max_completion_tokens: number;
		};
		expect(result.tools.map(t => t.function.name)).toEqual(["read", "bash"]);
		expect(result.max_completion_tokens).toBe(1024);
	});

	test("unpromoted responses payload: max_output_tokens capped", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload: RESPONSES_PAYLOAD() }, ctx([]))) as {
			tools: Array<{ name: string }>;
			max_output_tokens: number;
		};
		expect(result.tools.map(t => t.name)).toEqual(["read", "bash"]);
		expect(result.max_output_tokens).toBe(1024);
	});

	test("cap never raises: a value below the cap is preserved", async () => {
		const { api, handlers } = register();
		await apply(api);
		const payload = ANTHROPIC_PAYLOAD();
		payload.max_tokens = 512;
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload }, ctx([]))) as {
			max_tokens: number;
		};
		expect(result.max_tokens).toBe(512);
	});

	test("custom bootstrapMaxTokens is honored", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), bootstrapMaxTokens: 2048 }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() }, ctx([]))) as {
				max_tokens: number;
			};
			expect(result.max_tokens).toBe(2048);
		});
	});

	test("promoted sessions get the untouched payload", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = await fire(
			handlers,
			"before_provider_request",
			{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
			ctx([assistantEntry([toolCallBlock])]),
		);
		expect(result).toBeUndefined();
	});

	test("subagents get the untouched payload", async () => {
		const { api, handlers } = register([{ kind: "sub", sessionFile: "/sessions/sub.jsonl" }]);
		await apply(api);
		const result = await fire(
			handlers,
			"before_provider_request",
			{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
			ctx([], { id: "sub1", file: "/sessions/sub.jsonl" }),
		);
		expect(result).toBeUndefined();
	});

	test("a missing bootstrap shell degrades to the full catalog with a warning (cap still applies)", async () => {
		const { api, handlers, warns } = register();
		await apply(api);
		const payload = { model: "m", max_tokens: 8000, tools: [{ name: "read" }, { name: "edit" }] };
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload }, ctx([]))) as {
			tools: unknown[];
			max_tokens: number;
		};
		expect(result.tools).toEqual(payload.tools);
		expect(result.max_tokens).toBe(1024);
		expect(warns.filter(w => w.includes("bootstrap shell"))).toHaveLength(1);
	});

	test("two present shells degrade to the full catalog with a warning", async () => {
		const { api, handlers, warns } = register();
		await apply(api);
		const payload = { model: "m", max_tokens: 8000, tools: [{ name: "read" }, { name: "bash" }, { name: "pwsh" }] };
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload }, ctx([]))) as {
			tools: unknown[];
			max_tokens: number;
		};
		expect(result.tools).toEqual(payload.tools);
		expect(result.max_tokens).toBe(1024);
		expect(warns.filter(w => w.includes("bootstrap shell"))).toHaveLength(1);
	});

	test("a missing common tool degrades to the full catalog with a warning", async () => {
		const { api, handlers, warns } = register();
		await apply(api);
		const payload = { model: "m", max_tokens: 8000, tools: [{ name: "bash" }, { name: "edit" }] };
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload }, ctx([]))) as {
			tools: unknown[];
			max_tokens: number;
		};
		expect(result.tools).toEqual(payload.tools);
		expect(result.max_tokens).toBe(1024);
		expect(warns.filter(w => w.includes("bootstrap shell"))).toHaveLength(1);
	});

	test("an unrecognized payload shape leaves the request untouched and warns once", async () => {
		const { api, handlers, warns } = register();
		await apply(api);
		const payload = { model: "m", tools: [{ name: "read" }, { name: "bash" }] };
		const result = await fire(handlers, "before_provider_request", { type: "before_provider_request", payload }, ctx([]));
		expect(result).toBeUndefined();
		expect(warns.filter(w => w.includes("output cap skipped"))).toHaveLength(1);
		await fire(handlers, "before_provider_request", { type: "before_provider_request", payload: { ...payload } }, ctx([]));
		expect(warns.filter(w => w.includes("output cap skipped"))).toHaveLength(1);
	});

	test("payloads without a tools array are capped but not narrowed", async () => {
		const { api, handlers } = register();
		await apply(api);
		const payload = { model: "m", max_tokens: 8000 };
		const result = (await fire(handlers, "before_provider_request", { type: "before_provider_request", payload }, ctx([]))) as {
			max_tokens: number;
		};
		expect(result.max_tokens).toBe(1024);
	});

	test("a session scan failure degrades to the untouched payload", async () => {
		const { api, handlers } = register();
		await apply(api);
		const broken = {
			sessionManager: {
				getSessionId: () => "s1",
				getSessionFile: () => "/sessions/s1.jsonl",
				getEntries: () => {
					throw new Error("scan failure");
				},
			},
		};
		const result = await fire(handlers, "before_provider_request", { type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() }, broken);
		expect(result).toBeUndefined();
	});
});

describe("promotion signals", () => {
	test("either: an assistant message without tool calls promotes", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = await fire(
			handlers,
			"before_provider_request",
			{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
			ctx([assistantEntry()]),
		);
		expect(result).toBeUndefined();
	});

	test("promoteOn tool-call: a text-only reply does NOT promote", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), promoteOn: "tool-call" }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const result = (await fire(
				handlers,
				"before_provider_request",
				{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
				ctx([assistantEntry()]),
			)) as { max_tokens: number };
			expect(result.max_tokens).toBe(1024);
		});
	});

	test("promoteOn tool-call: a tool call promotes", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), promoteOn: "tool-call" }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const result = await fire(
				handlers,
				"before_provider_request",
				{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
				ctx([assistantEntry([toolCallBlock])]),
			);
			expect(result).toBeUndefined();
		});
	});

	test("promoteOn assistant-message: a text-only reply promotes", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), promoteOn: "assistant-message" }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const result = await fire(
				handlers,
				"before_provider_request",
				{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
				ctx([assistantEntry()]),
			);
			expect(result).toBeUndefined();
		});
	});

	test("user messages never promote", async () => {
		const { api, handlers } = register();
		await apply(api);
		const result = (await fire(
			handlers,
			"before_provider_request",
			{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
			ctx([userEntry]),
		)) as { max_tokens: number };
		expect(result.max_tokens).toBe(1024);
	});

	test("promotion is memoized per session id", async () => {
		const { api, handlers } = register();
		await apply(api);
		expect(
			await fire(
				handlers,
				"before_provider_request",
				{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
				ctx([assistantEntry()], { id: "s1" }),
			),
		).toBeUndefined();
		// Same id answers from the memo even with empty entries.
		expect(
			await fire(handlers, "before_provider_request", { type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() }, ctx([], { id: "s1" })),
		).toBeUndefined();
		// A different session scans independently.
		const fresh = (await fire(
			handlers,
			"before_provider_request",
			{ type: "before_provider_request", payload: ANTHROPIC_PAYLOAD() },
			ctx([], { id: "s2" }),
		)) as { max_tokens: number };
		expect(fresh.max_tokens).toBe(1024);
	});
});

describe("context (append mode)", () => {
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

	test("promoted requests carry the captured prompt as a developer message", async () => {
		const { handlers } = await applyAndStart();
		const promoted = ctx([assistantEntry()]);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, promoted);
		const messages = [userEntry.message, assistantEntry().message];
		const result = (await fire(handlers, "context", { type: "context", messages }, promoted)) as { messages: Array<{ role: string; content: unknown }> };
		expect(result.messages).toHaveLength(3);
		expect(result.messages[1].role).toBe("developer");
		expect(result.messages[1].content).toBe(FULL_PROMPT.join("\n\n"));
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

	test("system-block mode: no developer message even when promoted", async () => {
		await withConfig({ ...JSON.parse(shippedConfig), restoreMode: "system-block" }, async () => {
			const { api, handlers } = register();
			await apply(api);
			const promoted = ctx([assistantEntry()]);
			await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, promoted);
			const result = await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, promoted);
			expect(result).toBeUndefined();
		});
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

	test("the prompt capture refreshes on later agent starts", async () => {
		const { handlers } = await applyAndStart();
		const promoted = ctx([assistantEntry()]);
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: FULL_PROMPT }, promoted);
		const newer = ["<skills>read, bash, edit, grep</skills>", "<repo-rules>updated</repo-rules>"];
		await fire(handlers, "before_agent_start", { type: "before_agent_start", systemPrompt: newer }, promoted);
		const result = (await fire(handlers, "context", { type: "context", messages: [userEntry.message] }, promoted)) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		expect(result.messages[1].content).toBe(newer.join("\n\n"));
	});
});
