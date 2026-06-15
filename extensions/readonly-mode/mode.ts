// ============================================================
// Mode definitions — the single source of truth for every mode.
// Each entry declaratively specifies injection strategy, scope
// policy, and tool policy key. Adding a mode = adding one line.
// ============================================================

import {
  BUILD_SYSTEM_PROMPT,
  READONLY_SYSTEM_PROMPT,
  READONLY_TRANSITION_PROMPT,
  DEBUG_TRANSITION_PROMPT,
} from "./prompts";
import {
  getAllowedScope,
} from "./scope";
import {
  TOOL_POLICIES,
  MERGED_DEBUG_POLICIES,
  DEFAULT_POLICY,
} from "./policies";
import type { ToolPolicy, BlockResult } from "./policies";
import { formatBlock } from "./policies";

// ──  Dimension types  ──

export type ModeName = "build" | "explore" | "debug";

export type ScopeKind = "all" | "workspace" | "paths";

// ──  Injection configuration (B-style: one boolean/object field per slot)  ──

export interface TransitionMessageConfig {
  /** Re-inject after N same-mode turns to refresh model attention.
   *  0 (default) = only on mode switch, never re-inject. */
  reinjectAfter?: number;
}

export interface InjectionConfig {
  /** Append to LLM system message every turn (outside history). */
  systemPrompt?: boolean;
  /** Invisible message before user prompt every turn (in history). */
  everyTurnMessage?: boolean;
  /** Invisible message on mode switch (in history, minimal tokens).
   *  Content comes from buildPrompt(mode).transitionMessage. */
  transitionMessage?: TransitionMessageConfig;
}

// ──  Full mode definition  ──

export interface ModeDef {
  name:       ModeName;
  label:      string;
  color:      string;       // ANSI escape code
  customType: string;       // message customType for history injection
  injection:  InjectionConfig;
  scopeKind:  ScopeKind;
  toolKey:    "build" | "readonly" | "debug";
}

// ──  The table — one row per mode  ──

export const MODES: Record<ModeName, ModeDef> = {
  build: {
    name:       "build",
    label:      "Build",
    color:      "\x1b[34m",
    customType: "build-mode-context",
    injection:  { transitionMessage: { reinjectAfter: 0 } },
    scopeKind:  "all",
    toolKey:    "build",
  },
  explore: {
    name:       "explore",
    label:      "Explore",
    color:      "\x1b[32m",
    customType: "explore-mode-context",
    injection:  {
      systemPrompt: true,
      transitionMessage: { reinjectAfter: 0 },
    },
    scopeKind:  "all",
    toolKey:    "readonly",
  },
  debug: {
    name:       "debug",
    label:      "Debug",
    color:      "\x1b[33m",
    customType: "debug-mode-context",
    injection:  { everyTurnMessage: true },
    scopeKind:  "all",
    toolKey:    "debug",
  },
};

// ============================================================
// Pure helpers
// ============================================================

/** Build the resolved set of allowed scope paths for a mode. */
export function buildScope(
  cwd: string,
  kind: ScopeKind,
  scopePaths: string[],
): string[] {
  switch (kind) {
    case "all":
      // sentinel: "all" means no scope limits
      return ["all"];
    case "workspace":
      return getAllowedScope(cwd, []);
    case "paths":
      if (scopePaths.includes("all")) return ["all"];
      return getAllowedScope(cwd, scopePaths);
  }
}

// ──  Prompt content per injection slot  ──

export interface PromptContent {
  systemPrompt?: string;
  everyTurnMessage?: string;
  transitionMessage?: string;
}

/** Build the prompt content for each injection slot of a mode.
 *  InjectionConfig decides which slots are active; this fills them. */
export function buildPrompt(mode: ModeName): PromptContent {
  switch (mode) {
    case "build":
      return {
        transitionMessage: BUILD_SYSTEM_PROMPT,
      };
    case "explore":
      return {
        systemPrompt: READONLY_SYSTEM_PROMPT,
        transitionMessage: READONLY_TRANSITION_PROMPT,
      };
    case "debug":
      return {
        everyTurnMessage: DEBUG_TRANSITION_PROMPT,
      };
  }
}

/** Resolve the tool policy for a given tool in a given mode. */
export function resolveToolPolicy(
  toolName: string,
  toolKey: "build" | "readonly" | "debug",
): ToolPolicy {
  if (toolKey === "build") return { type: "allow" };
  const table = toolKey === "debug" ? MERGED_DEBUG_POLICIES : TOOL_POLICIES;
  return table[toolName] ?? DEFAULT_POLICY;
}

// ============================================================
// Build injection result type
// ============================================================

export interface BuildInjectionResult {
  systemPrompt?: string;
  message?: { customType: string; content: string };
}

// ============================================================
// ModeState — the single mutable state held by the extension.
// All decision logic lives here; index.ts is pure wiring.
// ============================================================

export class ModeState {
  current: ModeName = "build";

  // ──  Transition tracking (internal)  ──
  private _prev: ModeName | undefined;
  private _prevScope: string | undefined;
  private _turns = 0;

  // ──  Derived  ──
  get def(): ModeDef { return MODES[this.current]; }
  get color(): string { return this.def.color; }
  get label(): string { return this.def.label; }

  /** Resolved scope directories for the current mode. */
  getScope(cwd: string): string[] {
    return buildScope(cwd, this.def.scopeKind, []);
  }

  /** Tool policy for the current mode. */
  resolveToolPolicy(toolName: string): ToolPolicy {
    return resolveToolPolicy(toolName, this.def.toolKey);
  }

  /** Compute injections for this turn. Returns null when nothing to inject. */
  buildInjection(): BuildInjectionResult | null {
    const cfg = this.def.injection;
    const changed = this._detectChange();
    const content = buildPrompt(this.current);

    // Decide whether to inject transition message this turn
    let injectTransition = false;
    if (cfg.transitionMessage) {
      const ri = cfg.transitionMessage.reinjectAfter ?? 0;
      injectTransition = changed || (ri > 0 && this._turns >= ri);
    }

    // Update tracking (after decision, before building result)
    this._turns = changed ? 0 : this._turns + 1;
    this._snapshot();

    const result: BuildInjectionResult = {};

    if (cfg.systemPrompt && content.systemPrompt) {
      result.systemPrompt = content.systemPrompt;
    }

    // Transition takes priority over everyTurn when both would fill the message slot
    if (injectTransition && content.transitionMessage) {
      result.message = { customType: this.def.customType, content: content.transitionMessage };
    } else if (cfg.everyTurnMessage && content.everyTurnMessage) {
      result.message = { customType: this.def.customType, content: content.everyTurnMessage };
    }

    return (result.systemPrompt || result.message) ? result : null;
  }

  // ──  Internal  ──
  private _detectChange(): boolean {
    return this._prev !== this.current;
  }

  private _snapshot(): void {
    this._prev = this.current;
    this._prevScope = ""; // retained for future scope tracking
  }
}

// ============================================================
// dispatchToolCall — pure decision: block or allow + audit flag.
// Extracted from index.ts so the dispatch chain is independently
// testable without the framework event system.
// ============================================================

export interface DispatchResult {
  /** undefined = allowed; defined = blocked with formatted reason */
  block?: { block: true; reason: string };
}

/** Resolve policy, run guard, format result — all in one callable unit. */
export function dispatchToolCall(
  event: { toolName: string; input: unknown },
  mode: ModeState,
  cwd: string,
): DispatchResult {
  if (mode.current === "build") return {};

  const policy = mode.resolveToolPolicy(event.toolName);
  let raw: BlockResult | undefined;

  if (policy.type === "block") {
    raw = {
      block: true,
      reason: policy.reason ?? "",
      hint: policy.hint ?? "switch_to_build",
      alternatives: policy.alternatives,
    };
  } else if (policy.type === "check") {
    raw = policy.check!(event, {
      scope: mode.getScope(cwd),
      cwd,
    });
  }

  const blocked = raw !== undefined;
  return {
    block: blocked ? formatBlock(raw) : undefined,
  };
}
