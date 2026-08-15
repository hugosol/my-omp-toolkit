/**
 * anchored-standard — two-phase bootstrap extension for Oh My Pi.
 *
 * Mirrors the dsh-anchored-standard preset mechanics on the omp ExtensionAPI:
 *
 *  1. Tool surface. While the session is unpromoted, the provider wire request
 *     is narrowed to one platform shell plus the common tools (default
 *     `read`); after promotion every provider request carries the full
 *     catalog.
 *  2. Output budget. The first model requests are capped at
 *     `bootstrapMaxTokens` (default 1024) via the same wire rewrite. The cap
 *     is applied per request and simply stops being applied after promotion —
 *     nothing is injected into harness state, so there is no cap-leak.
 *  3. Injected context. The system prompt is replaced with a minimal persona
 *     for the bootstrap phase (and, in `restoreMode: "append"`, for the whole
 *     session). The full omp prompt — main template (skills list, rules),
 *     project prompt (AGENTS.md digests), safety blocks — is captured at
 *     `before_agent_start` and, after promotion, appended as one developer
 *     message so the system-prompt prefix never changes. `restoreMode:
 *     "system-block"` restores the original prompt as system blocks instead;
 *     `"none"` keeps the persona for the whole session.
 *
 * Promotion is derived from durable session entries, so resume/reload
 * preserves the phase. Subagents (registry kind !== "main") are always
 * exempt: their first request carries the full catalog.
 *
 * Robustness (same philosophy as the dsh preset):
 *  - Promotion decisions are memoized per session id for this process.
 *  - Every filter degrades to the untouched request on its own failure, with
 *    a one-time warning — a bug here can never brick a session or eat context.
 *  - Invalid config fails at load time (the extension loader surfaces it).
 *  - No network calls, no telemetry.
 */

import type {
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import { loadConfig } from "./config";
import { createPhaseTracker, hasSessionContext, isSubagent } from "./phase";
import { capMaxTokens, narrowTools } from "./transform";

/** Diagnostic name used by loader diagnostics. */
export const name = "anchored-standard";

// omp runs extensions under bun; import.meta.dir is the module's directory.
const extensionDir = (import.meta as unknown as { dir?: string }).dir ?? "";

export default async function anchoredStandard(pi: ExtensionAPI): Promise<void> {
	const { config, missing } = await loadConfig(`${extensionDir}/config.json`);
	if (!config.enabled) return;

	const warned = new Set<string>();
	const warnOnce = (key: string, message: string): void => {
		if (warned.has(key)) return;
		warned.add(key);
		try {
			pi.logger.warn(message);
		} catch {
			// Logger unavailable — the guard exists only to avoid spamming.
		}
	};
	if (missing) {
		warnOnce("config-missing", "anchored-standard: config.json not found next to index.ts; using defaults");
	}

	const tracker = createPhaseTracker(config, () => pi.pi.AgentRegistry.global());
	/** Latest full omp prompt captured at agent start (append mode source). */
	let capturedPrompt: string[] = [];

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		if (!hasSessionContext(ctx)) return;
		try {
			const current = Array.isArray(event.systemPrompt) ? [...event.systemPrompt] : [];
			if (current.length > 0) capturedPrompt = current;
			if (isSubagent(ctx, pi.pi.AgentRegistry.global())) return;
			if (config.restoreMode === "system-block" && tracker.isPromoted(ctx)) return;
			return { systemPrompt: [config.personaText] };
		} catch (error) {
			// A filter bug must never eat the real prompt.
			warnOnce("agent-start", `anchored-standard: before_agent_start filter failed, keeping original prompt: ${String((error as Error)?.message ?? error)}`);
			return;
		}
	});

	pi.on("before_provider_request", async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
		try {
			if (tracker.isPromoted(ctx)) return;
			let out = event.payload;
			const cap = capMaxTokens(out, config.bootstrapMaxTokens);
			if (cap.unrecognized) {
				warnOnce("cap-shape", "anchored-standard: unrecognized provider payload shape, output cap skipped");
			}
			out = cap.payload;
			const narrowed = narrowTools(out, config);
			if (narrowed.degraded) {
				warnOnce(
					"tools",
					`anchored-standard: expected exactly one bootstrap shell and every common tool; shells=${JSON.stringify(narrowed.degraded.shells)}, missing=${JSON.stringify(narrowed.degraded.missing)} — bootstrap disabled, full catalog exposed`,
				);
				out = narrowed.payload;
			} else {
				out = narrowed.payload;
			}
			return out === event.payload ? undefined : out;
		} catch (error) {
			// A filter bug must never brick a request: leave it untouched.
			warnOnce("request", `anchored-standard: request filter failed, leaving request untouched: ${String((error as Error)?.message ?? error)}`);
			return;
		}
	});

	pi.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
		if (config.restoreMode !== "append") return;
		if (!hasSessionContext(ctx)) return;
		try {
			// Explicit subagent gate: the real runtime re-binds a fresh extension
			// instance per session, but a shared instance must never leak a
			// captured main-session prompt into a subagent context.
			if (isSubagent(ctx, pi.pi.AgentRegistry.global())) return;
			if (!tracker.isPromoted(ctx)) return;
			if (!Array.isArray(event.messages) || capturedPrompt.length === 0) return;
			const devMessage = {
				role: "developer" as const,
				content: capturedPrompt.join("\n\n"),
				timestamp: Date.now(),
			};
			const insertAt = Math.min(1, event.messages.length);
			return {
				messages: [...event.messages.slice(0, insertAt), devMessage, ...event.messages.slice(insertAt)],
			};
		} catch (error) {
			// A filter bug must never eat the user's context.
			warnOnce("context", `anchored-standard: append filter failed, keeping original messages: ${String((error as Error)?.message ?? error)}`);
			return;
		}
	});
}
