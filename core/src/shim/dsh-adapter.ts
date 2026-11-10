/**
 * core/src/shim/dsh-adapter.ts — DSH (DeepSeek Harness / Cordis) in-process shim adapter.
 *
 * Reference pattern: `core/src/shim/omp-adapter.ts` + live `ports/dsh/hooks/pre/zone-guard.ts`.
 * PURE (contract L-2/L-3): `dshGuardDecision` never throws — shapes `DshEvent` into
 * `HookInput`, delegates to `runHook`; deny → `{block, reason}` for Cordis pre-execute.
 *
 * Type-strip-safe, zero external deps — `@deepseek-ai/cordis` lives only in the port plugin.
 */
import { runHook, type HookDeps, type HookInput } from "./command-hook.ts";

/** Cordis / DSH tool names → HookInput PATH_TOOLS (CC-style) casing. */
function normalizeDshTool(toolName: string): string {
  switch (toolName) {
    case "write":
    case "file_write":
      return "Write";
    case "edit":
    case "file_edit":
    case "ast_edit":
      return "Edit";
    case "notebook":
    case "notebook_edit":
      return "NotebookEdit";
    case "bash":
    case "shell":
    case "exec":
      return "Bash";
    default:
      return toolName;
  }
}

export interface DshEvent {
  toolName: string;
  input: Record<string, unknown>;
  cwd?: string;
  /** Cordis may expose interactive session hint (lead TUI). */
  isInteractive?: boolean;
  subagentMarker?: unknown;
}

export interface DshBlockDecision {
  block: true;
  reason: string;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  return undefined;
}

function parseDshEvent(event: DshEvent): HookInput {
  const input = event.input ?? {};
  return {
    tool: normalizeDshTool(event.toolName),
    filePath: firstString(
      input.path,
      input.filePath,
      input.file_path,
      input.notebook_path,
      input.notebookPath,
    ),
    command: firstString(input.command, input.code, input.shell),
    cwd: event.cwd,
    actorSignal: event.subagentMarker,
    isTTY: event.isInteractive,
  };
}

export function dshGuardDecision(event: DshEvent, deps: HookDeps): DshBlockDecision | undefined {
  const decision = runHook(parseDshEvent(event), deps);
  if (decision.decision === "deny") {
    return { block: true, reason: decision.reason ?? "zone-guard: запрещено политикой." };
  }
  return undefined;
}
