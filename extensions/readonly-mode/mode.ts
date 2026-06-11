// ============================================================
// Mode definitions — the single source of truth for every mode.
// Each entry declaratively specifies injection strategy, scope
// policy, and tool policy key. Adding a mode = adding one line.
// ============================================================

import {
  BUILD_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  DEBUG_TRANSITION_PROMPT,
  exploreSystemPrompt,
} from "./prompts";
import {
  getAllowedScope,
  buildScopeGuide,
} from "./scope";
import {
  TOOL_POLICIES,
  MERGED_DEBUG_POLICIES,
  DEFAULT_POLICY,
} from "./policies";
import type { ToolPolicy } from "./policies";

// ──  Dimension types  ──

export type ModeName = "build" | "chat" | "explore" | "debug";

export type ScopeKind = "all" | "workspace" | "paths";

export type InjectionKind =
  | "system_prompt"
  | "message_every_turn"
  | "message_on_transition";

// ──  Injection configuration  ──

export interface InjectionConfig {
  kind: InjectionKind;
  reinjectAfter?: number; // only for message_on_transition; 0 = never
}

// ──  Full mode definition  ──

export interface ModeDef {
  name:       ModeName;
  label:      string;       // display label (Explore appends scope paths)
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
    injection:  { kind: "message_on_transition", reinjectAfter: 0 },
    scopeKind:  "all",
    toolKey:    "build",
  },
  chat: {
    name:       "chat",
    label:      "Chat",
    color:      "\x1b[38;5;214m",
    customType: "chat-mode-context",
    injection:  { kind: "system_prompt" },
    scopeKind:  "workspace",
    toolKey:    "readonly",
  },
  explore: {
    name:       "explore",
    label:      "Explore",
    color:      "\x1b[32m",
    customType: "explore-mode-context",
    injection:  { kind: "system_prompt" },
    scopeKind:  "paths",
    toolKey:    "readonly",
  },
  debug: {
    name:       "debug",
    label:      "Debug",
    color:      "\x1b[33m",
    customType: "debug-mode-context",
    injection:  { kind: "message_every_turn" },
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

/** Build the prompt content (system prompt or transition message) for a mode. */
export function buildPromptContent(
  mode: ModeName,
  scopePaths: string[],
  cwd: string,
): string {
  const scopeFooter = () =>
    `\nAllowed search paths:\n${buildScopeGuide(buildScope(cwd, MODES[mode].scopeKind, scopePaths))}`;

  switch (mode) {
    case "build":
      return BUILD_SYSTEM_PROMPT;
    case "debug":
      return DEBUG_TRANSITION_PROMPT;
    case "chat":
      return CHAT_SYSTEM_PROMPT + scopeFooter();
    case "explore": {
      const isAll = scopePaths.includes("all");
      const desc = isAll
        ? "all directories (including workspace and ~/.omp/agent)"
        : `workspace + ${scopePaths.join(", ")} (and ~/.omp/agent)`;
      return exploreSystemPrompt(desc) + (isAll ? "" : scopeFooter());
    }
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
// Turn injection result type
// ============================================================

export type TurnInjection =
  | { kind: "system_prompt"; content: string }
  | { kind: "message"; customType: string; content: string }
  | null;

// ============================================================
// ModeState — the single mutable state held by the extension.
// All decision logic lives here; index.ts is pure wiring.
// ============================================================

export class ModeState {
  current:    ModeName = "build";
  scopePaths: string[] = [];

  // ──  Transition tracking (internal)  ──
  private _prev: ModeName | undefined;
  private _prevScope: string | undefined;
  private _turns = 0;

  // ──  Derived  ──
  get def(): ModeDef { return MODES[this.current]; }
  get color(): string { return this.def.color; }

  get label(): string {
    if (this.current === "explore" && this.scopePaths.length > 0) {
      const d = this.scopePaths.includes("all")
        ? "all"
        : this.scopePaths.join(", ");
      return `Explore: ${d}`;
    }
    return this.def.label;
  }

  /** Resolved scope directories for the current mode. */
  getScope(cwd: string): string[] {
    return buildScope(cwd, this.def.scopeKind, this.scopePaths);
  }

  /** Tool policy for the current mode. */
  resolveToolPolicy(toolName: string): ToolPolicy {
    return resolveToolPolicy(toolName, this.def.toolKey);
  }

  /** Determine turn injection for this turn. Returns null when nothing to inject. */
  beginTurn(cwd: string): TurnInjection {
    const cfg = this.def.injection;
    const changed = this._detectChange();

    // Decide whether to inject this turn
    let shouldInject: boolean;
    switch (cfg.kind) {
      case "system_prompt":
      case "message_every_turn":
        shouldInject = true;
        break;
      case "message_on_transition":
        shouldInject = changed
          || (cfg.reinjectAfter! > 0
              && this._turns >= cfg.reinjectAfter!);
        break;
    }

    // Update tracking
    this._turns = changed ? 0 : this._turns + 1;
    this._snapshot();

    if (!shouldInject) return null;

    const content = buildPromptContent(
      this.current, this.scopePaths, cwd,
    );

    return cfg.kind === "system_prompt"
      ? { kind: "system_prompt", content }
      : { kind: "message", customType: this.def.customType, content };
  }

  // ──  Internal  ──
  private _detectChange(): boolean {
    const prevKey = (this._prevScope ?? "");
    const currKey = this.scopePaths.join("|");
    return this._prev !== this.current || prevKey !== currKey;
  }

  private _snapshot(): void {
    this._prev = this.current;
    this._prevScope = this.scopePaths.join("|");
  }
}
