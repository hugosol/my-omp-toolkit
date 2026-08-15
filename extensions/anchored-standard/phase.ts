/**
 * Promotion phase tracking: subagent detection and the memoized promotion
 * scan over durable session entries. Pure state machine — no extension
 * runtime access, unit tested with structural fakes.
 *
 * Promotion signal (hardcoded): the first durable assistant message entry.
 */

/** Structural view of the ExtensionContext pieces this module needs. */
export interface PhaseContext {
	sessionManager?: {
		getSessionId?: () => string;
		getSessionFile?: () => string | undefined;
		getEntries?: () => unknown[];
	};
}

/** Structural view of one injected AgentRegistry entry. */
export interface RegistryRefLike {
	kind?: string;
	sessionFile?: string | null;
	session?: unknown;
}

/** Structural view of the injected AgentRegistry surface. */
export interface AgentRegistryLike {
	list?: () => RegistryRefLike[];
}

/**
 * Scan durable session entries for the promotion signal: any assistant
 * message entry promotes.
 */
export function scanPromotion(entries: unknown[]): boolean {
	return entries.some(entry => {
		if (typeof entry !== "object" || entry === null) return false;
		if (!("type" in entry) || entry.type !== "message" || !("message" in entry)) return false;
		const message = entry.message;
		if (typeof message !== "object" || message === null) return false;
		return "role" in message && message.role === "assistant";
	});
}

/**
 * Subagent detection via the injected registry: registry kind is "main"
 * exactly for the driving agent; task-spawned children ("sub") and passive
 * advisors are exempt so they keep the original omp prompt.
 * Best-effort: an unavailable registry or an unmatched session falls back to
 * main semantics.
 */
export function isSubagent(ctx: PhaseContext, registry: AgentRegistryLike | undefined): boolean {
	if (!registry || typeof registry.list !== "function") return false;
	const file = ctx.sessionManager?.getSessionFile?.();
	const sid = ctx.sessionManager?.getSessionId?.();
	for (const ref of registry.list()) {
		if (!ref) continue;
		if (file !== undefined && ref.sessionFile === file) return ref.kind !== "main";
		const session = ref.session;
		if (sid !== undefined && typeof session === "object" && session !== null && "getSessionId" in session) {
			const getSessionId = session.getSessionId;
			if (typeof getSessionId === "function" && getSessionId() === sid) return ref.kind !== "main";
		}
	}
	return false;
}

export interface PhaseTracker {
	/**
	 * Whether the session has reached the promoted (append-active) phase.
	 * Subagents and sessions without a readable session context are always
	 * "promoted" — but those sessions are gated separately by the caller, so
	 * the phase is only meaningful for main sessions. Promoted sessions are
	 * memoized per id.
	 */
	isPromoted(ctx: PhaseContext): boolean;
	/** Test hook: drop all memoized decisions. */
	reset(): void;
}

/** Whether the context carries a readable session id. */
export function hasSessionContext(ctx: PhaseContext): boolean {
	try {
		const sid = ctx.sessionManager?.getSessionId?.();
		return typeof sid === "string" && sid.length > 0;
	} catch {
		return false;
	}
}

export function createPhaseTracker(registryProvider: () => AgentRegistryLike | undefined): PhaseTracker {
	const promoted = new Set<string>();

	return {
		isPromoted(ctx) {
			if (isSubagent(ctx, registryProvider())) return true;
			if (!hasSessionContext(ctx)) return true;
			const sid = ctx.sessionManager?.getSessionId?.() ?? "";
			if (promoted.has(sid)) return true;
			try {
				const entries = ctx.sessionManager?.getEntries?.() ?? [];
				const hit = scanPromotion(entries);
				if (hit) promoted.add(sid);
				return hit;
			} catch {
				return true; // a scan failure must never trap a session unpromoted
			}
		},
		reset() {
			promoted.clear();
		},
	};
}
