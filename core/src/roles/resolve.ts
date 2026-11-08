/**
 * roles/resolve.ts (A1, `.workflow/tasks/a1-role-prompt-resolver.md`) — the
 * single core resolver for a role's system-prompt text. Replaces 6 duplicated
 * `rolePrompt` + frontmatter-strip copies: `.omp/tools/{execute,design,codex}_worker.ts`,
 * `.opencode/tools/{execute,design,codex}_worker.ts`, plus
 * `core/src/design/claude-worker.ts`'s own copy (kept there only as a
 * re-export for backward compat).
 *
 * Fact this fixes (task "Факт"): those 6 copies read ONLY
 * `<cwd>/.<port>/agents/<role>.md` — in a prod OMP install (product in
 * `~/.omp/agent/`, project has only `.omp/zonemap.yml`) or a global OpenCode
 * install (`~/.config/opencode`), that file doesn't exist in the project ->
 * empty system prompt for the domain worker, and `claude-worker.ts` (CC
 * `/aiwf-design`) has no fallback at all in a CC-only project.
 *
 * Resolution order (task "Требуется" §1):
 *   1. `<projectRoot>/<portDir>/agents/<role>.md`   (project overlay — wins)
 *   2. `<installRoot>/agents/<role>.md`             (installed canon, if any;
 *      installRoot = the tool's OWN install root, NOT cwd)
 *   3. domain roles (anything that is not one of the base roles below) repeat
 *      1+2 for `executor` (`source: "fallback-executor"`).
 * A BASE role (producer/critic/explorer/scaffolder/executor) found nowhere in the above
 * -> `{ error }` with an explicit reason. Never an empty/undefined prompt for
 * a base role silently swallowed by a caller.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { splitMaxsplit } from "../design/py-text.ts";

/** Roles with no further fallback. Anything else (`kmp-developer`, `go-developer`, ...)
 *  is a "domain role" and falls back to `executor` when not found directly. */
const BASE_ROLES = new Set(["producer", "critic", "explorer", "scaffolder", "executor"]);

export function isBaseRole(role: string): boolean {
  return BASE_ROLES.has(role);
}

/**
 * Frontmatter-strip — verbatim Python `role_prompt`'s rule: `text.split("---", 2)`,
 * keep part[2] (the body) only if the split produced exactly 3 parts (i.e. at
 * least 2 `---` markers); otherwise keep the whole (trimmed) text unchanged
 * (Python's own maxsplit<3 quirk, preserved intentionally — contract L-1).
 *
 * Tolerates a leading UTF-8 BOM (`﻿`, common on Windows-authored .md
 * files) and CRLF line endings (both routed through plain `"---"` substring
 * matching, so CRLF never breaks marker detection — `.trim()` at the end
 * strips any residual `\r`).
 */
export function stripFrontmatter(text: string): string {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!t.startsWith("---")) return t.trim();
  const parts = splitMaxsplit(t, "---", 2);
  if (parts.length === 3) return (parts[2] as string).trim();
  return t.trim();
}

export interface RoleFsSeam {
  exists(p: string): boolean;
  readFile(p: string): string;
}

export type RolePromptSource = "project" | "install" | "fallback-executor";

export interface ResolveRolePromptOptions {
  role: string;
  /** project/repo root the task-file's zone is anchored to (NOT necessarily cwd). */
  projectRoot: string;
  /** port dir name holding `agents/<role>.md` under `projectRoot`, e.g. ".omp" / ".opencode" / ".claude". */
  portDir: string;
  /** the tool's OWN install root (e.g. `~/.omp/agent`), NOT cwd. Absent -> no install layer checked. */
  installRoot?: string;
}

export interface ResolveRolePromptResult {
  text?: string;
  source?: RolePromptSource;
  path?: string;
  error?: string;
}

function roleFilePath(root: string, portDir: string | undefined, role: string): string {
  return portDir ? path.join(root, portDir, "agents", `${role}.md`) : path.join(root, "agents", `${role}.md`);
}

function findRole(
  deps: RoleFsSeam,
  projectRoot: string,
  portDir: string,
  installRoot: string | undefined,
  role: string,
): { text: string; source: "project" | "install"; path: string } | undefined {
  const projectPath = roleFilePath(projectRoot, portDir, role);
  if (deps.exists(projectPath)) {
    return { text: stripFrontmatter(deps.readFile(projectPath)), source: "project", path: projectPath };
  }
  if (installRoot) {
    const installPath = roleFilePath(installRoot, undefined, role);
    if (deps.exists(installPath)) {
      return { text: stripFrontmatter(deps.readFile(installPath)), source: "install", path: installPath };
    }
  }
  return undefined;
}

/** Single resolver for a role's system-prompt (pure + fs-seam, contract L-2 — no direct fs access here). */
export function resolveRolePrompt(options: ResolveRolePromptOptions, deps: RoleFsSeam): ResolveRolePromptResult {
  const { role, projectRoot, portDir, installRoot } = options;

  const direct = findRole(deps, projectRoot, portDir, installRoot, role);
  if (direct) return direct;

  const tried = [roleFilePath(projectRoot, portDir, role)];
  if (installRoot) tried.push(roleFilePath(installRoot, undefined, role));

  if (!isBaseRole(role)) {
    const fallback = findRole(deps, projectRoot, portDir, installRoot, "executor");
    if (fallback) return { text: fallback.text, source: "fallback-executor", path: fallback.path };
    tried.push(roleFilePath(projectRoot, portDir, "executor"));
    if (installRoot) tried.push(roleFilePath(installRoot, undefined, "executor"));
  }

  return { error: `role-spec не найден для роли "${role}" (искал: ${tried.join(", ")})` };
}

/**
 * installRoot from the tool file's OWN location — NOT cwd — via `import.meta.url`
 * (works under both Bun and Node: `fileURLToPath` is a standard `node:url` export
 * both runtimes implement). Assumes the standard `<installRoot>/tools/<name>.ts`
 * layout, true both for the repo canon (`.omp/tools/*.ts`, `.opencode/tools/*.ts`)
 * and for a global install (`~/.omp/agent/tools/*.ts`, `~/.config/opencode/tools/*.ts`).
 */
export function installRootFromToolUrl(toolFileUrl: string): string {
  const toolFilePath = fileURLToPath(toolFileUrl);
  return path.dirname(path.dirname(toolFilePath));
}
