import { describe, test, expect } from "bun:test";
import { checkBash, checkDebugBash, checkSearchPaths, checkLsp, checkBrowser, checkTask, checkDebugTask } from "../../extensions/readonly-mode/checks.ts";

// ============================================================
// checkBash
// ============================================================

describe("checkBash", () => {
  test("allows standalone read-only commands", () => {
    const allowed = ["ls", "ls -la", "cat file.txt", "grep pattern file", "pwd", "echo hello", "awk '{print $1}'", "jq .", "sed 's/a/b/'", "stat file"];
    for (const cmd of allowed) {
      expect(checkBash({ input: { command: cmd } })).toBeUndefined();
    }
  });

  test("allows read-only commands with sudo", () => {
    expect(checkBash({ input: { command: "sudo ls" } })).toBeUndefined();
    expect(checkBash({ input: { command: "sudo cat /etc/hosts" } })).toBeUndefined();
  });

  test("allows command -v for read-only commands", () => {
    expect(checkBash({ input: { command: "command -v ls" } })).toBeUndefined();
    expect(checkBash({ input: { command: "command -v sed" } })).toBeUndefined();
  });

  test("allows git read-only subcommands", () => {
    const allowed = ["git log", "git diff", "git status", "git show HEAD", "git branch", "git stash list"];
    for (const cmd of allowed) {
      expect(checkBash({ input: { command: cmd } })).toBeUndefined();
    }
  });

  test("allows ecosystem read-only commands", () => {
    const allowed = ["npm ls", "cargo tree", "pip list", "pip3 freeze", "go version", "node --version", "rustc --version"];
    for (const cmd of allowed) {
      expect(checkBash({ input: { command: cmd } })).toBeUndefined();
    }
  });

  test("blocks empty command", () => {
    const result = checkBash({ input: { command: "" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("Empty");
  });

  test("blocks undefined command", () => {
    const result = checkBash({ input: {} });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("Empty");
  });

  test("blocks command chaining with &&", () => {
    const result = checkBash({ input: { command: "ls && rm file" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("chaining");
    expect(result!.hint).toBe("use_alternative");
  });

  test("blocks command chaining with ||", () => {
    const result = checkBash({ input: { command: "ls || echo fail" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("chaining");
  });

  test("blocks command chaining with ;", () => {
    const result = checkBash({ input: { command: "ls; rm file" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("chaining");
  });

  test("blocks command substitution with backticks", () => {
    const result = checkBash({ input: { command: "echo `whoami`" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("chaining");
  });

  test("blocks command substitution with $()", () => {
    const result = checkBash({ input: { command: "echo $(whoami)" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("chaining");
  });

  test("blocks output redirection >> (append)", () => {
    const result = checkBash({ input: { command: "ls >> out.txt" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("redirection");
  });

  test("blocks output redirection >>", () => {
    const result = checkBash({ input: { command: "echo x >> log.txt" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("redirection");
  });

  test("blocks tee pipe", () => {
    const result = checkBash({ input: { command: "ls | tee out.txt" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("redirection");
  });

  test("blocks sed -i (in-place editing)", () => {
    const result = checkBash({ input: { command: "sed -i 's/a/b/' file" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("sed -i");
    expect(result!.hint).toBe("use_alternative");
  });

  test("allows sed without -i", () => {
    expect(checkBash({ input: { command: "sed 's/a/b/' file" } })).toBeUndefined();
  });

  test("blocks non-whitelisted commands", () => {
    const result = checkBash({ input: { command: "rm -rf /" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("whitelist");
    expect(result!.hint).toBe("silent");
  });

  test("blocks mkdir", () => {
    const result = checkBash({ input: { command: "mkdir newdir" } });
    expect(result).toBeDefined();
  });

  test("blocks curl", () => {
    const result = checkBash({ input: { command: "curl https://example.com" } });
    expect(result).toBeDefined();
  });
});

// ============================================================
// checkSearchPaths
// ============================================================

describe("checkSearchPaths", () => {
  const cwd = "/home/user/project";

  test("allows empty paths (default workspace search)", () => {
    expect(checkSearchPaths({ input: {} }, cwd, [])).toBeUndefined();
    expect(checkSearchPaths({ input: { paths: [] } }, cwd, [])).toBeUndefined();
  });

  test("allows when scopeOverride is 'all'", () => {
    expect(checkSearchPaths({ input: { paths: "/etc/passwd" } }, cwd, ["all"])).toBeUndefined();
  });

  test("allows paths within the workspace", () => {
    expect(checkSearchPaths({ input: { paths: "src/main.ts" } }, cwd, [])).toBeUndefined();
    expect(checkSearchPaths({ input: { paths: ["src/a.ts", "test/b.ts"] } }, cwd, [])).toBeUndefined();
  });

  test("allows paths that are internal URIs", () => {
    expect(checkSearchPaths({ input: { paths: "skill://my-skill" } }, cwd, [])).toBeUndefined();
    expect(checkSearchPaths({ input: { paths: "omp://config" } }, cwd, [])).toBeUndefined();
  });

  test("blocks paths outside the workspace", () => {
    const result = checkSearchPaths({ input: { paths: "/etc/passwd" } }, cwd, []);
    expect(result).toBeDefined();
    expect(result!.reason).toContain("outside allowed scope");
    expect(result!.hint).toBe("use_alternative");
  });

  test("blocks when some paths are outside scope", () => {
    const result = checkSearchPaths({ input: { paths: ["src/main.ts", "/etc/shadow"] } }, cwd, []);
    expect(result).toBeDefined();
    expect(result!.reason).toContain("/etc/shadow");
  });
});

// ============================================================
// checkLsp
// ============================================================

describe("checkLsp", () => {
  test("blocks rename", () => {
    const result = checkLsp({ input: { action: "rename" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("rename");
  });

  test("blocks rename_file", () => {
    const result = checkLsp({ input: { action: "rename_file" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("rename_file");
  });

  test("blocks code_actions with apply: true", () => {
    const result = checkLsp({ input: { action: "code_actions", apply: true } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("code_actions");
  });

  test("allows code_actions without apply", () => {
    expect(checkLsp({ input: { action: "code_actions" } })).toBeUndefined();
    expect(checkLsp({ input: { action: "code_actions", apply: false } })).toBeUndefined();
  });

  test("allows read-only LSP actions", () => {
    const allowed = ["definition", "hover", "references", "symbols", "diagnostics"];
    for (const action of allowed) {
      expect(checkLsp({ input: { action } })).toBeUndefined();
    }
  });

  test("allows no action specified", () => {
    expect(checkLsp({ input: {} })).toBeUndefined();
  });
});

// ============================================================
// checkBrowser
// ============================================================

describe("checkBrowser", () => {
  test("blocks run action", () => {
    const result = checkBrowser({ input: { action: "run" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("Browser");
    expect(result!.hint).toBe("use_alternative");
  });

  test("allows open action", () => {
    expect(checkBrowser({ input: { action: "open" } })).toBeUndefined();
  });

  test("allows close action", () => {
    expect(checkBrowser({ input: { action: "close" } })).toBeUndefined();
  });

  test("allows no action specified", () => {
    expect(checkBrowser({ input: {} })).toBeUndefined();
  });
});

// ============================================================
// checkTask
// ============================================================

describe("checkTask", () => {
  test("blocks missing agent", () => {
    const result = checkTask({ input: {} });
    expect(result).toBeDefined();
    expect(result!.hint).toBe("switch_to_build");
  });

  test("allows read-only agents", () => {
    const allowed = ["explore", "librarian", "plan", "reviewer"];
    for (const agent of allowed) {
      expect(checkTask({ input: { agent } })).toBeUndefined();
    }
  });

  test("blocks alternative agents with hint", () => {
    const blocked = ["task", "quick_task"];
    for (const agent of blocked) {
      const result = checkTask({ input: { agent } });
      expect(result).toBeDefined();
      expect(result!.hint).toBe("use_alternative");
      expect(result!.reason).toContain(agent);
    }
  });

  test("blocks unknown agents with switch_to_build", () => {
    const result = checkTask({ input: { agent: "oracle" } });
    expect(result).toBeDefined();
    expect(result!.hint).toBe("switch_to_build");
    expect(result!.reason).toContain("oracle");
  });
});

// ============================================================
// checkDebugBash — Debug mode core protection
// ============================================================

describe("checkDebugBash", () => {
  test("allows test and diagnostic commands", () => {
    const allowed = [
      "bun test",
      "npm test",
      "npx vitest",
      "cargo test",
      "pytest",
      "go test ./...",
      "tsc --noEmit",
      "cargo check",
      "eslint .",
      "npm run test",
      "npx jest --coverage",
      "python -m pytest -v",
    ];
    for (const cmd of allowed) {
      expect(checkDebugBash({ input: { command: cmd } })).toBeUndefined();
    }
  });

  test("allows read-only commands", () => {
    const allowed = ["ls", "cat file.txt", "grep pattern file", "pwd", "git log", "git diff", "npm ls"];
    for (const cmd of allowed) {
      expect(checkDebugBash({ input: { command: cmd } })).toBeUndefined();
    }
  });

  test("blocks destructive file commands", () => {
    const blocked = ["rm file.txt", "rm -rf dir", "sudo rm -rf /", "rmdir dir", "mv a b", "mkdir dir", "touch file", "chmod 777 file", "chown user file", "truncate -s 0 file"];
    for (const cmd of blocked) {
      const result = checkDebugBash({ input: { command: cmd } });
      expect(result).toBeDefined();
      expect(result!.reason).toContain("Destructive");
    }
  });

  test("blocks destructive git commands", () => {
    const blocked = ["git push", "git commit -m 'x'", "git merge main", "git rebase main", "git reset --hard HEAD~1", "git branch -D feature", "sudo git push"];
    for (const cmd of blocked) {
      const result = checkDebugBash({ input: { command: cmd } });
      expect(result).toBeDefined();
    }
  });

  test("allows read-only git commands", () => {
    const allowed = ["git log", "git diff", "git status", "git show HEAD", "git branch", "git stash list"];
    for (const cmd of allowed) {
      expect(checkDebugBash({ input: { command: cmd } })).toBeUndefined();
    }
  });

  test("blocks command chaining", () => {
    const result = checkDebugBash({ input: { command: "ls && rm file" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("chaining");
  });

  test("blocks output redirection", () => {
    expect(checkDebugBash({ input: { command: "ls > out.txt" } })).toBeDefined();
    expect(checkDebugBash({ input: { command: "echo x >> log" } })).toBeDefined();
    expect(checkDebugBash({ input: { command: "cat file | tee log" } })).toBeDefined();
  });

  test("blocks sed -i", () => {
    const result = checkDebugBash({ input: { command: "sed -i 's/a/b/' file" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("Destructive");
  });

  test("blocks package install commands", () => {
    const blocked = ["npm install pkg", "npm uninstall pkg", "pip install pkg", "cargo install tool", "brew install pkg", "apt install pkg"];
    for (const cmd of blocked) {
      const result = checkDebugBash({ input: { command: cmd } });
      expect(result).toBeDefined();
    }
  });
});

// ============================================================
// checkDebugTask — Debug mode agent whitelist
// ============================================================

describe("checkDebugTask", () => {
  test("allows readonly agents", () => {
    const allowed = ["explore", "librarian", "plan", "reviewer"];
    for (const agent of allowed) {
      expect(checkDebugTask({ input: { agent } })).toBeUndefined();
    }
  });

  test("allows oracle", () => {
    expect(checkDebugTask({ input: { agent: "oracle" } })).toBeUndefined();
  });

  test("blocks task and quick_task", () => {
    const blocked = ["task", "quick_task"];
    for (const agent of blocked) {
      const result = checkDebugTask({ input: { agent } });
      expect(result).toBeDefined();
      expect(result!.hint).toBe("use_alternative");
    }
  });

  test("blocks unknown agents", () => {
    const result = checkDebugTask({ input: { agent: "designer" } });
    expect(result).toBeDefined();
    expect(result!.reason).toContain("designer");
  });

  test("blocks missing agent", () => {
    const result = checkDebugTask({ input: {} });
    expect(result).toBeDefined();
    expect(result!.hint).toBe("switch_to_build");
  });
});
