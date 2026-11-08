/**
 * Governance profile model.
 * Source: docs/design/enforcement-governance-redesign-2026-09-18.md
 *   section B — AD-profile-presets, AD-profile-resolution.
 *
 * Node type-stripping does not support enum/namespace/decorators — using
 * union types + `as const` instead (runtime-agnostic, Node+Bun compatible).
 */

/** Governance strictness profile. Order (least -> most strict): off < assist < guarded < autonomous. */
export type Profile = "off" | "assist" | "guarded" | "autonomous";

/** Explicit ordering used by canTransition (policy.ts) — kept alongside the type it orders. */
export const PROFILE_ORDER: readonly Profile[] = ["off", "assist", "guarded", "autonomous"] as const;

/** Git-rail granularity (concern 3 — rail). See AD-policy-as-data. */
export type RailLevel = "none" | "commit" | "push" | "merge";

/** Per-profile defaults for the four orthogonal concerns (SP-concerns-orthogonal). */
export interface ConcernDefaults {
  quality_gate: boolean;
  operator_zone: boolean;
  rail: RailLevel;
  security_floor: boolean;
}

/**
 * Preset table — values MUST match AD-profile-presets exactly (locked spec, table in section B).
 * security_floor is `true` in every preset (SP-security-floor-always, critic B3) — it is never
 * disabled by a preset, only by explicit user opt-out (see policy.ts resolvePolicy).
 */
export const PRESETS: Record<Profile, ConcernDefaults> = {
  off: {
    quality_gate: false,
    operator_zone: false,
    rail: "none",
    security_floor: true,
  },
  assist: {
    quality_gate: true,
    operator_zone: false,
    rail: "none",
    security_floor: true,
  },
  guarded: {
    quality_gate: true,
    operator_zone: true,
    rail: "commit",
    security_floor: true,
  },
  autonomous: {
    quality_gate: true,
    operator_zone: true,
    rail: "merge",
    security_floor: true,
  },
};
