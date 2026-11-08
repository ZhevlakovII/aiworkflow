/**
 * core/src/shim/omp-adapter.ts — OMP in-process shim adapter (T5c-2).
 *
 * Reference (READ, NOT copied — re-ported onto the governance-aware core):
 * `.omp/hooks/pre/zone-guard.ts` / live `ports/omp/hooks/pre/zone-guard.ts`.
 * Pre-bridge OMP hooks carried their OWN path/command regex-classification
 * (PROTECTED, LEDGER, BASH_WRITE_OP, ...) and lead/worker split via
 * `ctx.hasUI`. This adapter carries ZERO classification logic of its own
 * (contract L-2) — it only shapes an `OmpEvent` into `HookInput` and hands
 * the verdict to `runHook` (T5b core). Every decision comes from
 * `classify`/`classifyPath` fed by `buildPolicy`/`resolveActor`/
 * `resolveInteractive` (T5a wiring), exactly like the command-hook shim.
 *
 * PURE (contract L-2/L-3): `ompGuardDecision` never throws, never touches
 * `process`/`fs` directly — policy access flows exclusively through
 * `deps.loadPolicy` (injectable, same shape as `HookDeps` in
 * `command-hook.ts`). The OMP `{block, reason}` return shape IS the
 * function's return value (not an exception) — throwing into the
 * `pi.on("tool_call", ...)` block-format is left to the wrapper glue
 * (engine-emitted, T5c-2 §3), same pure/impure split as `runHook` <-> `main`
 * in T5b (contract L-3).
 *
 * LIVE PATH-TOOL BRIDGE: `ports/omp/hooks/pre/zone-guard.ts` calls
 * `ompGuardDecision` for write/edit/ast_edit/notebook (SWP + execute
 * lead-freeze via `prodHookDeps`). Full bash/git/force-isolate rebind onto
 * `classify` remains STAGING/parked — those stay harness-local regex in the
 * port hook until design reopen of zone-guard↔core.
 *
 * Type-strip-safe (no enum/namespace/param-props/decorators), zero external
 * deps — only the core modules below (no `@oh-my-pi/...` import here; that
 * vendor import lives ONLY in the engine-emitted wrapper TEXT, T5c-2 §3).
 */
import { runHook, type HookDeps, type HookInput } from "./command-hook.ts";

/**
 * Live OMP tools are lowercase (`write`/`edit`/…); `runHook` PATH_TOOLS expect
 * CC-style (`Write`/`Edit`/`NotebookEdit`). Normalize here so SWP/lead-freeze
 * fire. `ast_edit` → `Edit`. Unlisted names pass through.
 */
function normalizeOmpTool(toolName: string): string {
  switch (toolName) {
    case "write":
      return "Write";
    case "edit":
    case "ast_edit":
      return "Edit";
    case "notebook":
      return "NotebookEdit";
    case "bash":
    case "eval":
      return "Bash";
    default:
      return toolName;
  }
}

/**
 * Normalized OMP `tool_call` hook-event shape (contract §1). `subagentMarker`
 * is a raw, not-yet-normalized actor signal (fed to `resolveActor` inside
 * `runHook`, same fail-closed contract as `HookInput.actorSignal`).
 *
 * §E-open (contract, verify T6): the exact OMP field that carries a
 * "this tool_call came from a spawned sub-task" marker is not confirmed
 * against a live `tool_call` payload here — `subagentMarker` is a
 * best-effort, caller-supplied signal (the wrapper glue is responsible for
 * extracting it from the real `event`/`ctx`, see engine-emitted OMP
 * template). Absent/unknown -> `resolveActor` defaults to operator
 * (fail-closed never relaxes the verdict, same as the CC/Codex adapters).
 */
export interface OmpEvent {
  toolName: string;
  input: Record<string, unknown>;
  cwd?: string;
  hasUI?: boolean;
  subagentMarker?: unknown;
}

/** OMP hook block-format (contract §1): `undefined` -> allow (no return needed). */
export interface OmpBlockDecision {
  block: true;
  reason: string;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  return undefined;
}

/**
 * `OmpEvent` -> `HookInput` (contract §1 mapping): `toolName` -> `tool`;
 * `input.path`/`input.file_path`/`input.notebook_path` -> `filePath`;
 * `input.command`/`input.code` -> `command`; `cwd` -> `cwd`; `subagentMarker`
 * -> `actorSignal`; `hasUI` -> `isTTY`. Pure field-shaping, no regex/glob
 * (contract L-2) — all decisions live in `runHook`.
 */
function parseOmpEvent(event: OmpEvent): HookInput {
  const input = event.input ?? {};
  return {
    tool: normalizeOmpTool(event.toolName),
    filePath: firstString(input.path, input.file_path, input.notebook_path),
    command: firstString(input.command, input.code),
    cwd: event.cwd,
    actorSignal: event.subagentMarker,
    isTTY: event.hasUI,
  };
}

/**
 * `ompGuardDecision(event, deps)` — pure decision function (contract §1).
 * `decision === "deny"` -> `{block: true, reason}`; `decision === "allow"`
 * -> `undefined` (matching the OMP `pi.on("tool_call", ...)` return
 * contract exactly, so the engine-emitted wrapper can `return
 * ompGuardDecision(...)` verbatim, no re-mapping needed).
 */
export function ompGuardDecision(event: OmpEvent, deps: HookDeps): OmpBlockDecision | undefined {
  const input = parseOmpEvent(event);
  const decision = runHook(input, deps);
  if (decision.decision === "deny") {
    return { block: true, reason: decision.reason ?? "zone-guard: запрещено политикой." };
  }
  return undefined;
}
