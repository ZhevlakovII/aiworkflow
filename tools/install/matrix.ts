// matrix — live flavor flow expansion + soft-skip/abort policy.
// Contract: AD-flavor-registry + AD-soft-skip-abort-policy.

import type { FlavorId } from "./registry.ts";

/** Exactly four live flavors; default preset `all` equals this set. */
export const LIVE_FLAVORS = ["omp", "opencode", "cursor", "dsh"] as const satisfies readonly FlavorId[];

export type LiveFlavor = (typeof LIVE_FLAVORS)[number];

export class FlowError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

const REJECTED = new Set(["claude", "codex", "both"]);

/**
 * Expand a flow token to flavor ids.
 * `all` → four live flavors. Rejects claude|codex|both with FlowError (exit 2).
 */
export function expandFlow(flow: string): FlavorId[] {
  const f = flow.trim().toLowerCase();
  if (!f) throw new FlowError("empty flow");
  if (f === "all") return [...LIVE_FLAVORS];
  if ((LIVE_FLAVORS as readonly string[]).includes(f)) return [f as FlavorId];
  if (REJECTED.has(f)) {
    throw new FlowError(
      `rejected flow '${f}' (retired from installer UX); live: ${LIVE_FLAVORS.join("|")}|all`,
    );
  }
  throw new FlowError(`unknown flow '${f}'; live: ${LIVE_FLAVORS.join("|")}|all`);
}

export type SoftSkipResult = {
  installable: FlavorId[];
  skipped: FlavorId[];
  /** When true, caller must exit non-zero (selected non-cursor empty after probes). */
  abort: boolean;
  reason?: string;
};

/**
 * Soft-skip flavors whose harness CLI is absent; allow cursor-only;
 * abort if selected non-cursor selection resolves to nothing installable.
 * Cursor may soft-skip when absent; cursor-only selection never aborts via this rule.
 */
export function softSkip(
  selected: readonly FlavorId[],
  present: ReadonlySet<string> | readonly string[],
): SoftSkipResult {
  const have = present instanceof Set ? present : new Set(present);
  const installable: FlavorId[] = [];
  const skipped: FlavorId[] = [];
  for (const id of selected) {
    // Cursor soft-skips when absent (like harnesses); presence set may include "cursor".
    if (have.has(id)) installable.push(id);
    else skipped.push(id);
  }
  const selectedNonCursor = selected.filter((id) => id !== "cursor");
  const installableNonCursor = installable.filter((id) => id !== "cursor");
  // Abort when user selected any non-cursor flavor and none remain installable.
  // Cursor-only selection (selectedNonCursor empty) is always OK even if empty/skipped.
  const abort = selectedNonCursor.length > 0 && installableNonCursor.length === 0;
  return {
    installable,
    skipped,
    abort,
    reason: abort
      ? "selected non-cursor flavors have no installable harness CLI after soft-skip"
      : undefined,
  };
}
