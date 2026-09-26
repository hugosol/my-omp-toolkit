/**
 * codeBaseTools — an independent OMP extension that routes the agent's code
 * exploration toward the codebase-memory-mcp graph tools and the native `lsp`
 * tool, while leaving literal text search to the native text tools.
 *
 * The routing text is injected as hidden, persisted custom messages: the full
 * `init` once per session, then a one-line `reminder` on every enabled turn.
 * `/codebase-tools` toggles injection; off only stops injecting and never
 * erases history.
 *
 * State survives resume through a non-LLM `codebase-tools:state` session entry.
 * Extension factories are rebound per session (main and every subagent), and the
 * module graph is evaluated once, so `globalOn` is shared across invocations: a
 * subagent inherits the main session's toggle while keeping its own init state.
 */
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import { INIT_PROMPT, REMINDER_PROMPT } from "./prompts";
import {
	DEFAULT_STATE,
	INIT_MESSAGE_TYPE,
	REMINDER_MESSAGE_TYPE,
	STATE_CUSTOM_TYPE,
	type CodebaseToolsState,
	injectionFor,
	markedInit,
	readState,
	statusText,
	toggled,
} from "./state";

export const name = "codeBaseTools";

const STATUS_KEY = "codebase-tools";

/** Shared across main/subagent factory invocations; only a main session writes it. */
let globalOn = false;

export function __resetCodebaseToolsForTests(): void {
	globalOn = false;
}

export default function codeBaseTools(pi: ExtensionAPI): void {
	pi.setLabel("codeBaseTools");

	// Per-session state: re-invoking the factory gives each session its own closure.
	let state: CodebaseToolsState = { ...DEFAULT_STATE };

	const restore = (ctx: ExtensionContext): void => {
		state = readState(ctx.sessionManager.getBranch());
		// Only the main session owns the process-wide toggle; subagents inherit it.
		if (ctx.agent.kind === "main") globalOn = state.on;
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx.agent.kind === "main" ? state.on : globalOn));
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		restore(ctx);
	});

	// `new` / `fork` land on a branch without our state entry (off); `resume` restores it.
	pi.on("session_switch", async (_event, ctx: ExtensionContext) => {
		restore(ctx);
	});

	pi.on("before_agent_start", async (_event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		const enabled = ctx.agent.kind === "main" ? state.on : globalOn;
		const kind = injectionFor({ on: enabled, initInjected: state.initInjected });
		if (kind === null) return undefined;

		if (kind === "init") {
			state = markedInit(state);
			pi.appendEntry(STATE_CUSTOM_TYPE, state);
		}
		return {
			message: {
				customType: kind === "init" ? INIT_MESSAGE_TYPE : REMINDER_MESSAGE_TYPE,
				content: kind === "init" ? INIT_PROMPT : REMINDER_PROMPT,
				display: false as const,
				attribution: "agent" as const,
			},
		};
	});

	pi.registerCommand("codebase-tools", {
		description: "Toggle codeBaseTools routing-prompt injection for this session",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			state = toggled(state);
			globalOn = state.on;
			pi.appendEntry(STATE_CUSTOM_TYPE, state);
			ctx.ui.setStatus(STATUS_KEY, statusText(state.on));
			ctx.ui.notify(`codeBaseTools ${state.on ? "on" : "off"}`, "info");
		},
	});
}
