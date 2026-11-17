import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findAgentConfigWrites } from "../../.claude/hooks/protect-agent-config.mjs";

// The Claude Code hook that keeps the agent from changing its own settings,
// hooks and skills in `.claude/` from the shell (the Edit/Write tools are
// covered by `deny` rules in .claude/settings.json). The process tests run the
// real script with a hook event on stdin: exit 2 blocks, exit 0 lets it through.
const script = fileURLToPath(
  new URL("../../.claude/hooks/protect-agent-config.mjs", import.meta.url),
);
const settingsFile = fileURLToPath(new URL("../../.claude/settings.json", import.meta.url));

function runHook(event: unknown) {
  const result = spawnSync(process.execPath, [script], {
    input: typeof event === "string" ? event : JSON.stringify(event),
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

const shellEvent = (tool_name: "Bash" | "PowerShell", command: string) => ({
  tool_name,
  tool_input: { command },
});

const blocked = [
  "echo x > .claude/settings.json",
  "echo x >> .claude\\settings.json",
  "Set-Content .claude/settings.json x",
  "Add-Content -Path .claude/settings.json -Value x",
  "'{}' | Out-File .claude/settings.local.json",
  "cat x | tee .claude/settings.json",
  "cp x .claude/hooks/guard-pr-merge.mjs",
  "mv a .claude/",
  "Copy-Item x .claude/hooks/a.mjs",
  "Move-Item a .claude",
  "rm .claude/settings.local.json",
  "Remove-Item .claude/hooks/block-env-read.mjs",
  "sed -i s/deny/allow/ .claude/settings.json",
  "cd .claude && echo x > settings.json",
  "cd .claude; rm settings.json",
  "Set-Location .claude; Set-Content settings.json x",
  `node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`,
  "git checkout main -- .claude/settings.json",
  "git restore .claude/settings.json",
  'bash -c "echo x > .claude/settings.json"',
  "echo x > .claude/worktrees/ws-1/.claude/settings.json",
  "echo x > .cla''ude/settings.json",
  // N3: the worktree exception never covers a path that climbs out of it.
  "echo x > .claude/worktrees/../settings.json",
  "echo x > .claude/worktrees/x/../../settings.json",
  "cp x .claude/worktrees/x/../../hooks/guard-pr-merge.mjs",
  "Set-Content .claude\\worktrees\\..\\settings.json x",
  "rm .claude/worktrees/./../settings.json",
  "cd .claude/worktrees/x/../.. && echo x > settings.json",
  "cd .claude/worktrees/x && cd ../.. && echo x > settings.json",
  "cd .claude/worktrees/x; cd ..; cd ..; rm settings.json",
  // A cd through a glob or `..` into .claude, then a write.
  "cd .cl*; echo x > settings.json",
  "cd .clau?e && rm settings.json",
  "cd .[c]laude; Set-Content settings.json x",
  "cd .{claude,x}; rm settings.json",
  "Set-Location -Path .cl* ; Set-Content settings.json x",
  "echo x > .cl*/settings.json",
  "rm .claud[e]/settings.json",
  // .mcp.json starts programs: same protection as .claude/.
  "echo x > .mcp.json",
  "Set-Content .mcp.json x",
  "rm .mcp.json",
  // Checkers that write.
  "npx eslint .claude/hooks --fix",
  "npx prettier --write .claude",
  "npx prettier .claude -w",
  "npx prettier --check .claude --write",
  "npx eslint .claude/hooks -o .claude/settings.json",
  "npx tsc .claude/hooks/a.mjs",
];

const allowed = [
  "cat .claude/settings.json",
  "Get-Content .claude\\settings.json",
  "ls .claude/hooks 2>/dev/null",
  "git diff .claude/settings.json",
  "git add .claude/hooks/guard-pr-merge.mjs",
  "node .claude/hooks/guard-pr-merge.mjs",
  "grep -n deny .claude/settings.json",
  // Agent worktrees live under .claude/worktrees/<name>/: ordinary work there.
  "cd .claude/worktrees/ws-1 && npm test",
  "git -C .claude/worktrees/ws-1 commit -m x",
  "echo x > .claude/worktrees/ws-1/src/a.ts",
  "npx vitest run tests/scripts",
  "cat CLAUDE.md",
  "echo hi > notes.txt",
  // Read-only checkers and the editor.
  "npx eslint .claude/hooks",
  "npx eslint .claude/hooks/lib/shell-text.mjs",
  "npx --no-install eslint .claude",
  "npx prettier --check .claude",
  "npx prettier --list-different .claude/settings.json",
  "npx prettier -c .claude",
  "npx.cmd prettier --check .claude",
  "code .claude/settings.json",
  "cat .mcp.json",
  "cd .claude/worktrees/ws-1 && cd src && npm test",
  "cd src/.. && npm test",
  "cd ../other && ls",
  "ls * ",
];

describe("findAgentConfigWrites", () => {
  it.each(blocked)("blocks: %s", (command) => {
    expect(findAgentConfigWrites(command).length).toBeGreaterThan(0);
  });

  it.each(allowed)("allows: %s", (command) => {
    expect(findAgentConfigWrites(command)).toEqual([]);
  });

  it("ignores a command that is not a string", () => {
    expect(findAgentConfigWrites(undefined)).toEqual([]);
  });
});

describe("settings.json", () => {
  const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as {
    permissions: { deny: string[] };
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  };

  it("denies the edit tools in .claude/ without covering agent worktrees", () => {
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      expect(settings.permissions.deny).toContain(`${tool}(.claude/*)`);
      expect(settings.permissions.deny).toContain(`${tool}(.claude/hooks/**)`);
      expect(settings.permissions.deny).toContain(`${tool}(.claude/skills/**)`);
    }
    expect(settings.permissions.deny.some((rule) => rule.includes(".claude/**"))).toBe(false);
  });

  it("denies rules/, output-styles/, .mcp.json and root-anchored variants of every .claude rule", () => {
    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      for (const root of ["", "/"]) {
        for (const folder of ["hooks", "skills", "agents", "commands", "rules", "output-styles"]) {
          expect(settings.permissions.deny).toContain(`${tool}(${root}.claude/${folder}/**)`);
        }
        expect(settings.permissions.deny).toContain(`${tool}(${root}.claude/*)`);
        expect(settings.permissions.deny).toContain(`${tool}(${root}.mcp.json)`);
      }
    }
  });

  it("denies credential helpers, git-credential-* programs, git tracing and environment listings", () => {
    const deny = settings.permissions.deny;

    for (const shell of ["Bash", "PowerShell"]) {
      expect(deny).toContain(`${shell}(git -c credential*)`);
      expect(deny).toContain(`${shell}(git config*credential.helper*)`);
      expect(deny).toContain(`${shell}(*git-credential-*)`);
      expect(deny).toContain(`${shell}(*GIT_TRACE_REDACT*)`);
      expect(deny).toContain(`${shell}(*GIT_CURL_VERBOSE*)`);
      expect(deny).toContain(`${shell}(*GIT_TRACE_CURL*)`);
      expect(deny).toContain(`${shell}(printenv*)`);
    }
    for (const listing of ["Get-ChildItem env:*", "gci env:*", "ls env:*", "dir env:*"]) {
      expect(deny).toContain(`PowerShell(${listing})`);
    }
    expect(deny).toContain("PowerShell(*GetEnvironmentVariable*TOKEN*)");
    expect(deny).toContain("Bash(env)");
    expect(deny).toContain("Bash(set)");
    // The BOOTSTRAP.md helper line (url-scoped key) must not be denied by a rule.
    expect(deny.some((rule) => rule.includes("credential.*.helper"))).toBe(false);
  });

  it("denies the Read tool on every .env file without an exception rule", () => {
    expect(settings.permissions.deny).toContain("Read(**/.env)");
    expect(settings.permissions.deny).toContain("Read(**/.env.*)");
    expect(settings.permissions.deny.some((rule) => rule.includes("!"))).toBe(false);
  });

  it("runs this hook for shell commands", () => {
    const commands = settings.hooks.PreToolUse.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(commands.some((command) => command.includes("protect-agent-config.mjs"))).toBe(true);
  });
});

describe("protect-agent-config hook (real process)", () => {
  it("blocks a shell write into .claude/ with exit 2 and explains who changes it", () => {
    const result = runHook(shellEvent("PowerShell", "Set-Content .claude/settings.json '{}'"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("właściciel");
  });

  it("lets a read through", () => {
    expect(runHook(shellEvent("Bash", "cat .claude/settings.json")).status).toBe(0);
  });

  it("exits 1 for a malformed event (a hook bug, not a block)", () => {
    expect(runHook("not json").status).toBe(1);
  });
});
