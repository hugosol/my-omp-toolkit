/**
 * L2 integration smoke: real omp extension loader + runner + agent registry
 * from the INSTALLED omp package (npm global), no model, no network.
 *
 *   bun tests/anchored-standard/smoke-omp.ts
 *
 * Asserts the persona + stripped-append pipeline through the real chaining
 * runner:
 *   1. session_start checks the base prompt against the § Role/§ Runtime
 *      strip markers; before_agent_start re-checks the per-turn prompt.
 *   2. Main sessions run on the persona for the whole session; provider
 *      payloads are never touched (no before_provider_request handler).
 *   3. After the first durable assistant message, context appends the
 *      stripped omp prompt as a developer message at index 1.
 *   4. Subagents (registry kind "sub") are exempt everywhere.
 *   5. Missing markers disable the session with one visible notification and
 *      self-heal when the markers return.
 */
import { expect } from "bun:test";

const OMP = "D:/nvm4w/nodejs/node_modules/@oh-my-pi/pi-coding-agent";
const extPath = new URL("../../extensions/anchored-standard/index.ts", import.meta.url).pathname.replace(
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
const { AgentRegistry } = await import(`${OMP}/src/registry/agent-registry.ts`);

const PERSONA = "You are a helpful software engineer assistant.";

const ROLE_MARKER = "§ Role";
const RUNTIME_MARKER = "§ Runtime";
const CONVENTIONS = "<system-conventions>smoke conventions</system-conventions>";
const PERSONA_SECTION = `${ROLE_MARKER}\npersona text\n# Escalation`;
const RUNTIME_SECTION = `${RUNTIME_MARKER}\n<skills>read, bash, edit</skills>\n<Tool Inventory>read, bash, edit</Tool Inventory>`;
const MARKED_BLOCK = `${CONVENTIONS}\n\n${PERSONA_SECTION}\n\n${RUNTIME_SECTION}`;
const FULL_PROMPT = [MARKED_BLOCK, "<repo-rules>AGENTS.md digest</repo-rules>"];
const STRIPPED_FULL = `${CONVENTIONS}\n\n${RUNTIME_SECTION}\n\n<repo-rules>AGENTS.md digest</repo-rules>`;
const BROKEN_PROMPT = ["<skills>read, bash</skills>", "<repo-rules>AGENTS.md digest</repo-rules>"];

const anthropicPayload = () => ({
	model: "claude-x",
	messages: [],
	system: [],
	max_tokens: 64000,
	tools: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "grep" }],
});

const toolCallMessage = () => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
	api: "anthropic",
	provider: "anthropic",
	model: "claude-x",
	usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } },
	stopReason: "toolUse",
	timestamp: Date.now(),
});

const userMessage = () => ({
	role: "user",
	content: [{ type: "text", text: "hi" }],
	timestamp: Date.now(),
});

const sentMessages: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
const actions = {
	sendMessage: (message: unknown, options?: unknown): void => {
		sentMessages.push({ message: message as Record<string, unknown>, options: options as Record<string, unknown> | undefined });
	},
	sendUserMessage: (): void => {},
	appendEntry: (): void => {},
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
const contextActions = (systemPrompt: string[]) => ({
	getModel: (): undefined => undefined,
	isIdle: (): boolean => true,
	abort: (): void => {},
	hasPendingMessages: (): boolean => false,
	shutdown: (): void => {},
	getContextUsage: (): undefined => undefined,
	compact: async (): Promise<void> => {},
	getSystemPrompt: (): string[] => systemPrompt,
});

let step = 0;
const pass = (label: string) => console.log(`✔ ${++step}. ${label}`);

const tmp = `${import.meta.dir}/smoke-tmp-${crypto.randomUUID()}`;

try {
	const loadResult = await loadExtensions([extPath], tmp);
	expect(loadResult.errors).toEqual([]);
	expect(loadResult.extensions).toHaveLength(1);
	pass("extension loads through the real omp loader with no errors");

	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage);

	// --- Main session ---
	const mainManager = SessionManager.create(tmp);
	const mainFile = mainManager.getSessionFile() ?? null;
	AgentRegistry.global().register({
		id: "Main",
		displayName: "Main",
		kind: "main",
		parentId: undefined,
		session: null,
		sessionFile: mainFile,
		status: "running",
	});
	const runner = new ExtensionRunner(loadResult.extensions, loadResult.runtime, tmp, mainManager, modelRegistry);
	runner.initialize(actions as never, contextActions(FULL_PROMPT) as never);

	await runner.emit({ type: "session_start" });
	expect(sentMessages).toEqual([]);
	pass("session_start: marked base prompt keeps the extension active");

	const agentStart = await runner.emitBeforeAgentStart("hello", undefined, FULL_PROMPT);
	expect(agentStart?.systemPrompt).toEqual([PERSONA]);
	pass("before_agent_start: prompt replaced with persona");

	const payload = anthropicPayload();
	const first = await runner.emitBeforeProviderRequest(payload, undefined);
	expect(first).toEqual(payload);
	pass("provider payload untouched: no cap, no tool narrowing, ever");

	// Frozen fixture: userMessage() regenerates Date.now() per call, so the
	// assertion side must reuse the same object, not a fresh timestamp twin.
	const firstUser = userMessage();
	const prePromote = await runner.emitContext([firstUser]);
	expect(prePromote).toEqual([firstUser]);
	pass("context: untouched while unpromoted");

	mainManager.appendMessage(toolCallMessage());

	const postPromote = await runner.emitContext([userMessage()]);
	expect(postPromote).toHaveLength(2);
	expect(postPromote[1].role).toBe("developer");
	expect(postPromote[1].content).toBe(STRIPPED_FULL);
	expect(String(postPromote[1].content)).not.toContain("persona text");
	pass("durable assistant message promotes: stripped omp prompt appended at index 1");

	const postPromoteStart = await runner.emitBeforeAgentStart("second prompt", undefined, FULL_PROMPT);
	expect(postPromoteStart?.systemPrompt).toEqual([PERSONA]);
	pass("before_agent_start: persona persists after promotion");

	// --- Subagent session: exempt everywhere ---
	const subManager = SessionManager.create(tmp);
	const subFile = subManager.getSessionFile() ?? null;
	AgentRegistry.global().register({
		id: "sub1",
		displayName: "sub1",
		kind: "sub",
		parentId: "Main",
		session: null,
		sessionFile: subFile,
		status: "running",
	});
	const subRunner = new ExtensionRunner(loadResult.extensions, loadResult.runtime, tmp, subManager, modelRegistry);

	const subStart = await subRunner.emitBeforeAgentStart("hello", undefined, FULL_PROMPT);
	expect(subStart).toBeUndefined();
	pass("subagent: original system prompt preserved");

	const subUser = userMessage();
	const subContext = await subRunner.emitContext([subUser]);
	expect(subContext).toEqual([subUser]);
	pass("subagent: no developer message injected");

	// --- Broken markers: disable, notify once, self-heal ---
	const noticesBefore = sentMessages.length;
	const brokenManager = SessionManager.create(tmp);
	const brokenRunner = new ExtensionRunner(loadResult.extensions, loadResult.runtime, tmp, brokenManager, modelRegistry);
	brokenRunner.initialize(actions as never, contextActions(BROKEN_PROMPT) as never);

	await brokenRunner.emit({ type: "session_start" });
	expect(sentMessages.length).toBe(noticesBefore + 1);
	const notice = sentMessages[sentMessages.length - 1];
	expect(notice.message.display).toBe(true);
	expect(notice.options?.triggerTurn).toBe(false);
	pass("session_start with broken markers: one visible notification");

	const brokenStart = await brokenRunner.emitBeforeAgentStart("hello", undefined, BROKEN_PROMPT);
	expect(brokenStart).toBeUndefined();
	expect(sentMessages.length).toBe(noticesBefore + 1);
	pass("broken markers: prompt untouched, notification deduplicated");

	brokenManager.appendMessage(toolCallMessage());
	const brokenContext = await brokenRunner.emitContext([userMessage()]);
	expect(brokenContext).toHaveLength(1);
	pass("broken markers: no developer message even after promotion");

	const healedStart = await brokenRunner.emitBeforeAgentStart("hello again", undefined, FULL_PROMPT);
	expect(healedStart?.systemPrompt).toEqual([PERSONA]);
	pass("markers recovered: extension self-heals at the next agent start");

	console.log("\nL2 smoke: all checks passed.");
} finally {
	AgentRegistry.resetGlobalForTests();
}
