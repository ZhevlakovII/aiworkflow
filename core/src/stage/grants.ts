/**
 * Design-stage human grants — pure apply (minimal cut).
 *
 * Fold journal for open needs-human; match unused policy grant to reason;
 * return grant-applied event or null. No bounce/revise machines here.
 *
 * Source: AD-revise-with-human-budget / core-grants-apply.
 */
import type { StageGrant, StageGrants } from "../policy/policy.ts";
import type { StageJournalEvent } from "./journal.ts";

export const NEEDS_HUMAN_REASONS = ["gate", "revise", "critic-infra", "corrupt"] as const;
export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number];

export type GrantKind = "bounce" | "revise" | "resume";

export interface GrantAppliedEvent {
  type: "grant-applied";
  grant_id: string;
  kind: GrantKind;
  n?: number;
}

export function isNeedsHumanReason(s: string): s is NeedsHumanReason {
  return (NEEDS_HUMAN_REASONS as readonly string[]).includes(s);
}

/**
 * Open needs-human = last `needs-human` with no later `grant-applied`
 * (any grant-applied after NH clears for this minimal cut).
 */
export function openNeedsHuman(events: readonly StageJournalEvent[]): NeedsHumanReason | null {
  let nhIdx = -1;
  let reason: unknown;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "needs-human") {
      nhIdx = i;
      reason = events[i]!.reason;
      break;
    }
  }
  if (nhIdx < 0) return null;
  for (let i = nhIdx + 1; i < events.length; i++) {
    if (events[i]!.type === "grant-applied") return null;
  }
  if (typeof reason !== "string" || !isNeedsHumanReason(reason)) return null;
  return reason;
}

function appliedGrantIds(events: readonly StageJournalEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type === "grant-applied" && typeof e.grant_id === "string") {
      ids.add(e.grant_id);
    }
  }
  return ids;
}

/** Match unused grant fields to open NH reason. */
function matchGrant(
  reason: NeedsHumanReason,
  grant: StageGrant,
): { kind: GrantKind; n?: number } | null {
  if (reason === "gate") {
    if (typeof grant.bounce === "number" && Number.isFinite(grant.bounce)) {
      return { kind: "bounce", n: grant.bounce };
    }
    return null;
  }
  if (reason === "revise") {
    if (typeof grant.revise === "number" && Number.isFinite(grant.revise)) {
      return { kind: "revise", n: grant.revise };
    }
    return null;
  }
  // critic-infra | corrupt
  if (grant.resume === true) {
    return { kind: "resume" };
  }
  return null;
}

/**
 * Try one grant apply for ck12. Returns event to append, or null
 * (no open NH / wrong kind / no unused matching grant).
 */
export function tryApplyGrant(
  events: readonly StageJournalEvent[],
  ck12: string,
  grants: StageGrants,
): GrantAppliedEvent | null {
  const reason = openNeedsHuman(events);
  if (!reason) return null;

  const byCk = grants[ck12];
  if (!byCk) return null;

  const used = appliedGrantIds(events);
  for (const [grantId, grant] of Object.entries(byCk)) {
    if (used.has(grantId)) continue;
    const matched = matchGrant(reason, grant);
    if (!matched) continue;
    const event: GrantAppliedEvent = {
      type: "grant-applied",
      grant_id: grantId,
      kind: matched.kind,
    };
    if (matched.n !== undefined) event.n = matched.n;
    return event;
  }
  return null;
}
