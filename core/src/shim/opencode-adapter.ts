/**
 * core/src/shim/opencode-adapter.ts — OpenCode in-process shim adapter (T5c-2).
 *
 * Reference (READ, NOT copied — re-ported onto the governance-aware core):
 * `.opencode/plugins/zone-guard.ts` / live `ports/opencode/plugins/zone-guard.ts`.
 * Pre-bridge OpenCode plugins carried their OWN path/command
 * regex-classification (PROTECTED, GIT_MUT, PIPE_SHELL, RM_RF, ...) and
 * deny-by-`throw`. This adapter carries ZERO classification logic of its
 * own (contract L-2) — it only shapes an `OcEvent` into `HookInput` and
 * hands the verdict to `runHook` (T5b core).
 *
 * PURE (contract L-2/L-3): `opencodeGuardDecision` never throws — it RETURNS
 * a decision (`{deny: true, reason}` | `undefined`); the `throw new Error`
 * that OpenCode's `tool.execute.before` deny-contract requires is done by
 * the port plugin / engine-emitted wrapper (same pure/impure split as
 * `runHook` <-> `main` in T5b, contract L-3).
 *
 * OpenCode gives no lead/worker marker in `tool.execute.before` (documented
 * gap, same as the live port plugin header) — `actorSignal` is always
 * `undefined` here, so `resolveActor` (inside `runHook`) falls back to its
 * no-signal default (operator), fail-closed.
 *
 * LIVE PATH-TOOL BRIDGE: `ports/opencode/plugins/zone-guard.ts` calls
 * `opencodeGuardDecision` for write/edit/patch/notebook (SWP + execute
 * lead-freeze via `prodHookDeps`). Full bash/git rebind onto `classify`
 * remains STAGING/parked — those stay harness-local regex in the port
 * plugin until design reopen of zone-guard↔core.
 *
 * Type-strip-safe, zero external deps — no `@opencode-ai/plugin` import
 * here; that vendor import lives ONLY in the engine-emitted wrapper TEXT.
 */
import { runHook, type HookDeps, type HookInput } from "./command-hook.ts";

/**
 * Live OC tools are lowercase (`write`/`edit`/`patch`/`notebook`);
 * `runHook` PATH_TOOLS expect CC-style. `patch` → `MultiEdit`.
 */
function normalizeOcTool(tool: string): string {
  switch (tool) {
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "patch":
      return "MultiEdit";
    case "notebook":
      return "NotebookEdit";
    case "bash":
      return "Bash";
    default:
      return tool;
  }
}

/** Normalized OpenCode `tool.execute.before` hook-event shape (contract §2). */
export interface OcEvent {
  tool: string;
  args: Record<string, unknown>;
  directory?: string;
}

/** OpenCode deny-format (contract §2): `undefined` -> allow (wrapper does nothing). */
export interface OcDenyDecision {
  deny: true;
  reason: string;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  return undefined;
}

/**
 * `OcEvent` -> `HookInput` (contract §2 mapping): `tool` -> `tool`;
 * `args.filePath`/`args.path`/`args.notebookPath` -> `filePath`;
 * `args.command` -> `command`; `directory` -> `cwd`; `actorSignal` ->
 * `undefined` (OpenCode gives no marker); `isTTY` -> `undefined`. Pure
 * field-shaping, no regex/glob (contract L-2).
 */
function parseOcEvent(event: OcEvent): HookInput {
  const args = event.args ?? {};
  return {
    tool: normalizeOcTool(event.tool),
    filePath: firstString(args.filePath, args.path, args.notebookPath),
    command: firstString(args.command),
    cwd: event.directory,
    actorSignal: undefined,
    isTTY: undefined,
  };
}

/**
 * `opencodeGuardDecision(event, deps)` — pure decision function (contract
 * §2). `decision === "deny"` -> `{deny: true, reason}` (reason sourced from
 * the core verdict); `decision === "allow"` -> `undefined`.
 */
export function opencodeGuardDecision(event: OcEvent, deps: HookDeps): OcDenyDecision | undefined {
  const input = parseOcEvent(event);
  const decision = runHook(input, deps);
  if (decision.decision === "deny") {
    return { deny: true, reason: decision.reason ?? "zone-guard: запрещено политикой." };
  }
  return undefined;
}
