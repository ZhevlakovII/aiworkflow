/**
 * Governance policy resolution.
 * Source: docs/design/enforcement-governance-redesign-2026-09-18.md
 *   section B — AD-policy-as-data, AD-profile-resolution, AD-security-floor.
 *
 * LOCKED spec. Do not reinterpret values — see PRESETS in profile.ts.
 */

import { PRESETS, PROFILE_ORDER, type ConcernDefaults, type Profile, type RailLevel } from "./profile.ts";
import { DEFAULT_EXTERNAL_ALLOW } from "../classify/rules.ts";

/**
 * User-authored policy-as-data (AD-policy-as-data). Every field optional — absence means
 * "inherit from the resolved profile preset".
 */
export interface Policy {
  profile?: Profile;
  quality_gate?: {
    cmd?: string;
  };
  operator_zone?: {
    enabled?: boolean;
    protected?: string[];
    /**
     * T7-7 L-2 — operator external-whitelist override (contract
     * `.workflow/tasks/t7-7-operator-external-whitelist.md`). Absent -> the
     * code-side `DEFAULT_EXTERNAL_ALLOW` (`classify/rules.ts`) applies.
     * When set, REPLACES the default wholesale (not merged) — same
     * replace-not-merge convention as the rest of this policy shape.
     */
    external_allow?: string[];
  };
  rail?: {
    level?: RailLevel;
    merge_needs_human?: boolean;
  };
  security_floor?: {
    enabled?: boolean;
  };
  /**
   * B1 / Design C — paths the lead (operator) session must not write
   * (future command-hook enforcement). Absent -> resolve to [].
   */
  session_write_protected?: string[];
  /**
   * B1 / Design C — paths whose diffs are enforcement-sensitive (L1 trailer /
   * L3 merge probe). Absent -> resolve to [].
   */
  enforcement_paths?: string[];
  /**
   * B1 / Design C — stage-machine budgets and human grants.
   * `revise_budget` defaults to **1** on resolve (session lock; not 5).
   * `grants` applied on judge entry when needs-human is open (see stage/grants.ts).
   * `attribution_fail_closed` (B3): when true, L1 refuses new unattributed
   * design artifacts; default **false** on resolve (W12 until enabled).
   */
  stage?: {
    revise_budget?: number;
    grants?: StageGrants;
    attribution_fail_closed?: boolean;
  };
}

/** Human grant entries keyed by contract-key then grant-id (AD-revise-with-human-budget). */
export type StageGrants = Record<string, Record<string, StageGrant>>;

export interface StageGrant {
  bounce?: number;
  revise?: number;
  resume?: boolean;
}

export interface ResolvedQualityGate {
  enabled: boolean;
  cmd: string | null;
}

export interface ResolvedOperatorZone {
  enabled: boolean;
  protected: string[];
  /** T7-7 L-2 — operator external-whitelist (outside-repoRoot harness-home globs, `~`-prefixed). */
  external_allow: string[];
}

export interface ResolvedRail {
  level: RailLevel;
  merge_needs_human: boolean;
}

export interface ResolvedSecurityFloor {
  enabled: boolean;
}

export interface ResolvedStage {
  /** Critic revise budget per contract. Default **1** (B1 session lock). */
  revise_budget: number;
  /** Parsed grants map — apply on judge entry when needs-human. */
  grants: StageGrants;
  /**
   * B3 — refuse new unattributed `docs/design/*-{spec,adr}.md` on L1.
   * Default **false** (W12 / grandfather window until explicitly enabled).
   */
  attribution_fail_closed: boolean;
}

/** Fully resolved, immutable-in-run policy (SP-profile-explicit-immutable, AD-profile-resolution). */
export interface ResolvedPolicy {
  profile: Profile;
  quality_gate: ResolvedQualityGate;
  operator_zone: ResolvedOperatorZone;
  rail: ResolvedRail;
  security_floor: ResolvedSecurityFloor;
  /** Exported for future command-hook session-write enforcement (B1). */
  session_write_protected: string[];
  enforcement_paths: string[];
  stage: ResolvedStage;
}

export interface ResolvePolicyInput {
  policy?: Partial<Policy>;
  explicitProfile?: Profile;
  interactive: boolean;
}

/** Fail-closed default profile when nothing was declared explicitly (AD-profile-resolution, critic B1/M1). */
function defaultProfile(interactive: boolean): Profile {
  // interactive (TTY) -> "assist": operator is the authority, not caged by default.
  // headless/non-interactive without an explicit profile -> "guarded" minimum (fail-closed).
  // NEVER "off"/"assist" by default when headless (documented decision: guarded-minimum chosen
  // over a hard refuse-to-run, per contract L-2 / spec AD-profile-resolution).
  return interactive ? "assist" : "guarded";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    for (const key of Object.getOwnPropertyNames(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Resolve a governance policy into a concrete, frozen ResolvedPolicy.
 *
 * Profile source precedence: explicitProfile > policy.profile > fail-closed default.
 * Preset is applied first, then explicit policy keys override individual concerns
 * (concern-override, AD-policy-as-data). security_floor is always true unless the
 * user explicitly opts out with `security_floor.enabled === false` (AD-security-floor).
 */
export function resolvePolicy(input: ResolvePolicyInput): ResolvedPolicy {
  const { policy, explicitProfile, interactive } = input;

  const profile: Profile = explicitProfile ?? policy?.profile ?? defaultProfile(interactive);
  const preset: ConcernDefaults = PRESETS[profile];

  const qualityGate: ResolvedQualityGate = {
    enabled: preset.quality_gate,
    cmd: policy?.quality_gate?.cmd ?? null,
  };

  const operatorZone: ResolvedOperatorZone = {
    enabled: policy?.operator_zone?.enabled ?? preset.operator_zone,
    protected: policy?.operator_zone?.protected ?? [],
    external_allow: policy?.operator_zone?.external_allow ?? DEFAULT_EXTERNAL_ALLOW.slice(),
  };

  const rail: ResolvedRail = {
    level: policy?.rail?.level ?? preset.rail,
    merge_needs_human: policy?.rail?.merge_needs_human ?? true,
  };

  // security_floor is on in every preset (SP-security-floor-always). It is turned off ONLY by
  // an explicit `enabled === false` in the user policy — never implicitly, never by profile.
  const securityFloor: ResolvedSecurityFloor = {
    enabled: policy?.security_floor?.enabled === false ? false : true,
  };

  // B1: empty defaults; revise_budget locked to 1 when absent/invalid upstream.
  const reviseBudgetRaw = policy?.stage?.revise_budget;
  const reviseBudget =
    typeof reviseBudgetRaw === "number" && Number.isFinite(reviseBudgetRaw) && reviseBudgetRaw >= 0
      ? Math.floor(reviseBudgetRaw)
      : 1;

  const resolved: ResolvedPolicy = {
    profile,
    quality_gate: qualityGate,
    operator_zone: operatorZone,
    rail,
    security_floor: securityFloor,
    session_write_protected: policy?.session_write_protected ?? [],
    enforcement_paths: policy?.enforcement_paths ?? [],
    stage: {
      revise_budget: reviseBudget,
      grants: policy?.stage?.grants ?? {},
      // B3: absent/invalid → false (W12); only explicit `true` enables fail-closed.
      attribution_fail_closed: policy?.stage?.attribution_fail_closed === true,
    },
  };

  return deepFreeze(resolved);
}

/**
 * Downgrade-guard (SP-profile-explicit-immutable, analogous to D14): raising strictness is
 * allowed, lowering it is not. Pure function — no runtime integration in this piece.
 */
export function canTransition(from: Profile, to: Profile): boolean {
  return PROFILE_ORDER.indexOf(to) >= PROFILE_ORDER.indexOf(from);
}
