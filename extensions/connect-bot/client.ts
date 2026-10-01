/**
 * Wire client for connect-bot: the extension's only network dependency.
 *
 * The panel base URL is configuration (`./config`); every other wire detail is
 * a protocol constant fixed by the contract and hard-coded here — the single
 * route `POST /api/sessions/events`, the `{ proxy: false }` fetch option (the
 * panel is on the LAN and must never travel through an ambient `http_proxy`),
 * the `{sessionId, kind, data}` envelope with no version and no timestamp, the
 * closed kind enum, and the two response shapes.
 *
 * Tests replace the fetch transport through {@link __setPushClientForTest}
 * (mirroring model-cost's `__setOmpModuleLoaderForTest`) instead of patching
 * `globalThis.fetch`, so a test sees the real URL, init, serialization and
 * response parsing.
 */

/** Closed kind enum of the wire contract; each kind has its own `data` shape. */
export type PushKind = "register" | "heartbeat" | "state" | "unregister";

/**
 * One event envelope, `{sessionId, kind, data}`. `data` is omitted for
 * `unregister`, whose contract body is `{sessionId, kind}` alone.
 */
export interface PushEnvelope {
	sessionId: string;
	kind: PushKind;
	data?: Record<string, unknown>;
}

/** The single session-event route. Protocol constant, never configuration. */
export const EVENTS_PATH = "/api/sessions/events";

/** `register` answers fast or not at all: arming either connects or reports failure. */
export const REGISTER_TIMEOUT_MS = 1000;

/** `unregister` is best-effort and must not hold the command for long. */
export const UNREGISTER_TIMEOUT_MS = 1500;

/**
 * `heartbeat`/`state` answer fast or are dropped: nothing is buffered or
 * retried, and the next push self-heals a missed one.
 */
export const PUSH_TIMEOUT_MS = 1500;

/** Minimal response surface used here; the toolkit tsconfig carries no DOM fetch types. */
export interface PushHttpResponse {
	status: number;
	text(): Promise<string>;
}

/** Minimal request surface used here; `proxy` is a bun-only fetch option. */
export interface PushFetchInit {
	method: "POST";
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
	/** Never route the panel request through an ambient/`http_proxy` proxy. */
	proxy: false;
}

/** The one network dependency: perform a single fetch call. */
export type PushTransport = (url: string, init: PushFetchInit) => Promise<PushHttpResponse>;

const defaultTransport: PushTransport = (url, init) =>
	// bun-types' RequestInit has no `proxy: false` variant, so the fetch surface
	// is narrowed to the subset this module actually relies on.
	(globalThis.fetch as unknown as PushTransport)(url, init);

let transport: PushTransport = defaultTransport;

/**
 * Test seam: replace the fetch transport. Pass `null` to restore the real one.
 * Module-level so tests exercise the production URL, init and parsing without
 * patching `globalThis.fetch`.
 */
export function __setPushClientForTest(replacement: PushTransport | null): void {
	transport = replacement ?? defaultTransport;
}

/** Result of one push attempt. */
export interface PushOutcome {
	/** True for a 2xx response. */
	ok: boolean;
	/** HTTP status, kept for the offline path where any answer means the panel is reachable. */
	status: number;
	/** Parsed JSON body, or `undefined` when the body was empty or not JSON. */
	body: unknown;
}

/**
 * POST one event. Resolves for any HTTP response, whatever its status; rejects
 * only when the request itself fails or exceeds `timeoutMs`. No retry: a
 * failed event is dropped.
 */
export async function pushEvent(
	endpoint: string,
	envelope: PushEnvelope,
	timeoutMs: number,
): Promise<PushOutcome> {
	const response = await transport(`${endpoint}${EVENTS_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(envelope),
		signal: AbortSignal.timeout(timeoutMs),
		proxy: false,
	});
	let body: unknown;
	try {
		body = JSON.parse(await response.text());
	} catch {
		body = undefined;
	}
	return { ok: response.status >= 200 && response.status < 300, status: response.status, body };
}

/**
 * Read a `register` success receipt, `{ outcome: "registered", onlineCount: N }`
 * (N includes this session). `undefined` for anything else — a non-2xx answer,
 * or a 2xx answer whose body is not the registered receipt.
 */
export function readRegisterOutcome(outcome: PushOutcome): { onlineCount: number } | undefined {
	if (!outcome.ok || outcome.body === null || typeof outcome.body !== "object") return undefined;
	const { outcome: kind, onlineCount } = outcome.body as { outcome?: unknown; onlineCount?: unknown };
	if (kind !== "registered" || typeof onlineCount !== "number") return undefined;
	return { onlineCount };
}
