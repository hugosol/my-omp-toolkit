/**
 * L2 integration smoke: real omp extension loader + runner + agent registry
 * from the INSTALLED omp package (npm global), no model, no network.
 *
 *   bun tests/anchored-standard/smoke-omp.ts
 *
 * Asserts the three transforms through the real chaining pipeline:
 *   1. before_agent_start replaces the system prompt with the persona
 *      (unpromoted).
 *   2. before_provider_request caps max_tokens and narrows the wire tools.
 *   3. After a durable assistant tool call is recorded, promotion opens the
 *      full catalog and the context handler appends the captured prompt as a
 *      developer message.
 *   4. Subagents (registry kind "sub") are exempt everywhere.
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
const FULL_PROMPT = ["<skills>read, bash, edit</skills>", "<repo-rules>AGENTS.md digest</repo-rules>"];

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

	// --- Main session: bootstrap applies ---
	// File-backed managers: in-memory sessions all report an empty session
	// file, which would collide in the registry file-match used for subagent
	// detection. Real sessions are always file-backed.
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

	const agentStart = await runner.emitBeforeAgentStart("hello", undefined, FULL_PROMPT);
	expect(agentStart?.systemPrompt).toEqual([PERSONA]);
	pass("before_agent_start: unpromoted prompt replaced with persona");

	const first = await runner.emitBeforeProviderRequest(anthropicPayload(), undefined);
	expect(first.tools.map(t => t.name)).toEqual(["read", "bash"]);
	expect(first.max_tokens).toBe(1024);
	pass("before_provider_request: tools narrowed and max_tokens capped on request #1");

	const second = await runner.emitBeforeProviderRequest(anthropicPayload(), undefined);
	expect(second.max_tokens).toBe(1024);
	pass("request #2 before promotion stays bootstrapped");

	// Frozen fixture: userMessage() regenerates Date.now() per call, so the
	// assertion side must reuse the same object, not a fresh timestamp twin.
	const firstUser = userMessage();
	const prePromote = await runner.emitContext([firstUser]);
	expect(prePromote).toEqual([firstUser]);
	pass("context: untouched while unpromoted");

	mainManager.appendMessage(toolCallMessage());

	// The handler returns undefined (untouched); the runner therefore passes
	// the original payload through — assert the wire body stays full.
	const promotedRequest = await runner.emitBeforeProviderRequest(anthropicPayload(), undefined);
	expect(promotedRequest.max_tokens).toBe(64000);
	expect(promotedRequest.tools).toHaveLength(4);
	pass("durable tool call promotes: wire request untouched after promotion");

	const postPromote = await runner.emitContext([userMessage()]);
	expect(postPromote).toHaveLength(2);
	expect(postPromote[1].role).toBe("developer");
	expect(postPromote[1].content).toBe(FULL_PROMPT.join("\n\n"));
	pass("context: captured omp prompt appended as developer message after promotion");

	const postPromoteStart = await runner.emitBeforeAgentStart("second prompt", undefined, FULL_PROMPT);
	expect(postPromoteStart?.systemPrompt).toEqual([PERSONA]);
	pass("before_agent_start: persona persists after promotion (append mode)");

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

	const subRequest = await subRunner.emitBeforeProviderRequest(anthropicPayload(), undefined);
	expect(subRequest.max_tokens).toBe(64000);
	expect(subRequest.tools).toHaveLength(4);
	pass("subagent: full catalog from the first request");

	const subUser = userMessage();
	const subContext = await subRunner.emitContext([subUser]);
	expect(subContext).toEqual([subUser]);
	pass("subagent: no developer message injected");

	console.log("\nL2 smoke: all checks passed.");
} finally {
	AgentRegistry.resetGlobalForTests();
}
