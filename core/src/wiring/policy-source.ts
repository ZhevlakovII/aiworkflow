/**
 * Policy-source wiring — trust-boundary loader for governance policy-as-data.
 * Source: docs/design/enforcement-governance-redesign-2026-09-18.md
 *   section B — AD-policy-as-data, AD-profile-resolution, AD-worker-zone-always,
 *   AD-security-floor.
 *
 * T5a (contract .workflow/tasks/ts-pivot-policy-source-t5a.md). Closes the
 * trust-boundary MAJOR from the T2b review: this is the ONLY place governance
 * `Policy` is populated from outside input. It reads a trusted, git-tracked
 * YAML file (L-1) — never from a config-overlay merge (L-2, see module doc
 * below) — and resolves actor/interactive signals fail-closed (L-3/L-4)
 * before handing off to the existing, LOCKED `resolvePolicy` (L-5, not
 * reimplemented here).
 *
 * Trust boundary (L-2): `loadPolicyFile`/`parsePolicy` take a path or raw
 * text ONLY. There is no overlay/merge parameter anywhere in this module —
 * governance-sensitive keys (profile, rail.*, operator_zone.*,
 * security_floor.*, quality_gate.cmd — the last is executed by the rail,
 * an RCE surface if it could come from an untrusted overlay) never pass
 * through `config_resolve`-style layering. That layering remains valid for
 * harness client-config (bash.patterns etc.) — a separate concern, untouched
 * here.
 */
import { existsSync, readFileSync } from "node:fs";

import { parse as parseYaml } from "../render/yaml.ts";
import {
  resolvePolicy,
  type Policy,
  type ResolvedPolicy,
  type StageGrant,
  type StageGrants,
} from "../policy/policy.ts";
import type { Profile, RailLevel } from "../policy/profile.ts";
import type { Actor } from "../classify/classify.ts";

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "profile",
  "quality_gate",
  "operator_zone",
  "rail",
  "security_floor",
  "session_write_protected",
  "enforcement_paths",
  "stage",
]);

const KNOWN_STAGE_KEYS = new Set(["revise_budget", "grants", "attribution_fail_closed"]);

const KNOWN_GRANT_KEYS = new Set(["bounce", "revise", "resume"]);

const PROFILES: readonly Profile[] = ["off", "assist", "guarded", "autonomous"];
const RAIL_LEVELS: readonly RailLevel[] = ["none", "commit", "push", "merge"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse a governance policy-as-data YAML document (AD-policy-as-data schema)
 * into a typed `Policy`. Never throws on malformed *content*: unknown
 * top-level keys, out-of-enum values, and wrong-shaped blocks degrade to
 * "field ignored" (falls back to preset default downstream in
 * `resolvePolicy`) with a warning collected for the caller — a broken/
 * partial policy file must never crash the enforcement wiring (fail-closed
 * means "fall back to the strict default", not "throw").
 *
 * Malformed YAML *syntax* (yaml.ts throws) still propagates — that is a
 * hard authoring error, not a data-shape ambiguity.
 */
export function parsePolicy(text: string): { policy: Policy; warnings: string[] } {
  const warnings: string[] = [];
  if (text == null || text.trim() === "") {
    return { policy: {}, warnings };
  }

  const raw = parseYaml(text);
  if (raw === null || raw === undefined) {
    return { policy: {}, warnings };
  }
  if (!isPlainObject(raw)) {
    warnings.push("policy document is not a mapping — ignoring entire file");
    return { policy: {}, warnings };
  }

  const policy: Policy = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`unknown top-level key '${key}' — ignored`);
    }
  }

  if ("profile" in raw) {
    const value = raw.profile;
    if (typeof value === "string" && (PROFILES as readonly string[]).includes(value)) {
      policy.profile = value as Profile;
    } else {
      warnings.push(`invalid 'profile' value (${JSON.stringify(value)}) — ignored, falling back to default`);
    }
  }

  if ("quality_gate" in raw) {
    const block = raw.quality_gate;
    if (isPlainObject(block)) {
      const cmd = block.cmd;
      if (cmd === undefined || typeof cmd === "string") {
        policy.quality_gate = { cmd };
      } else {
        warnings.push(`invalid 'quality_gate.cmd' value (${JSON.stringify(cmd)}) — ignored`);
      }
    } else {
      warnings.push(`invalid 'quality_gate' block (${JSON.stringify(block)}) — ignored`);
    }
  }

  if ("operator_zone" in raw) {
    const block = raw.operator_zone;
    if (isPlainObject(block)) {
      const enabled = block.enabled;
      const protectedList = block.protected;
      const externalAllow = block.external_allow;
      const out: NonNullable<Policy["operator_zone"]> = {};
      if (enabled === undefined || typeof enabled === "boolean") {
        out.enabled = enabled;
      } else {
        warnings.push(`invalid 'operator_zone.enabled' value (${JSON.stringify(enabled)}) — ignored`);
      }
      if (protectedList === undefined) {
        // absent — leave unset, resolvePolicy defaults to []
      } else if (Array.isArray(protectedList) && protectedList.every((p) => typeof p === "string")) {
        out.protected = protectedList as string[];
      } else {
        warnings.push(`invalid 'operator_zone.protected' value (${JSON.stringify(protectedList)}) — ignored`);
      }
      // T7-7 L-2 — fail-closed: absent -> leave unset (resolvePolicy falls
      // back to DEFAULT_EXTERNAL_ALLOW); malformed (not a string[]) -> same
      // fallback + a warning (never a partial/bogus whitelist).
      if (externalAllow === undefined) {
        // absent — leave unset, resolvePolicy defaults to DEFAULT_EXTERNAL_ALLOW
      } else if (Array.isArray(externalAllow) && externalAllow.every((p) => typeof p === "string")) {
        out.external_allow = externalAllow as string[];
      } else {
        warnings.push(
          `invalid 'operator_zone.external_allow' value (${JSON.stringify(externalAllow)}) — ignored, falling back to default`
        );
      }
      policy.operator_zone = out;
    } else {
      warnings.push(`invalid 'operator_zone' block (${JSON.stringify(block)}) — ignored`);
    }
  }

  if ("rail" in raw) {
    const block = raw.rail;
    if (isPlainObject(block)) {
      const level = block.level;
      const mergeNeedsHuman = block.merge_needs_human;
      const out: NonNullable<Policy["rail"]> = {};
      if (level === undefined) {
        // absent — leave unset
      } else if (typeof level === "string" && (RAIL_LEVELS as readonly string[]).includes(level)) {
        out.level = level as RailLevel;
      } else {
        warnings.push(`invalid 'rail.level' value (${JSON.stringify(level)}) — ignored, falling back to default`);
      }
      if (mergeNeedsHuman === undefined || typeof mergeNeedsHuman === "boolean") {
        out.merge_needs_human = mergeNeedsHuman;
      } else {
        warnings.push(`invalid 'rail.merge_needs_human' value (${JSON.stringify(mergeNeedsHuman)}) — ignored`);
      }
      policy.rail = out;
    } else {
      warnings.push(`invalid 'rail' block (${JSON.stringify(block)}) — ignored`);
    }
  }

  if ("security_floor" in raw) {
    const block = raw.security_floor;
    if (isPlainObject(block)) {
      const enabled = block.enabled;
      if (enabled === undefined || typeof enabled === "boolean") {
        policy.security_floor = { enabled };
      } else {
        warnings.push(`invalid 'security_floor.enabled' value (${JSON.stringify(enabled)}) — ignored`);
      }
    } else {
      warnings.push(`invalid 'security_floor' block (${JSON.stringify(block)}) — ignored`);
    }
  }

  if ("session_write_protected" in raw) {
    const value = raw.session_write_protected;
    if (Array.isArray(value) && value.every((p) => typeof p === "string")) {
      policy.session_write_protected = value as string[];
    } else {
      warnings.push(
        `invalid 'session_write_protected' value (${JSON.stringify(value)}) — ignored, falling back to []`
      );
    }
  }

  if ("enforcement_paths" in raw) {
    const value = raw.enforcement_paths;
    if (Array.isArray(value) && value.every((p) => typeof p === "string")) {
      policy.enforcement_paths = value as string[];
    } else {
      warnings.push(
        `invalid 'enforcement_paths' value (${JSON.stringify(value)}) — ignored, falling back to []`
      );
    }
  }

  if ("stage" in raw) {
    const block = raw.stage;
    if (isPlainObject(block)) {
      for (const key of Object.keys(block)) {
        if (!KNOWN_STAGE_KEYS.has(key)) {
          warnings.push(`unknown nested key 'stage.${key}' — ignored`);
        }
      }
      const out: NonNullable<Policy["stage"]> = {};

      if ("revise_budget" in block) {
        const rb = block.revise_budget;
        if (typeof rb === "number" && Number.isFinite(rb) && rb >= 0) {
          out.revise_budget = Math.floor(rb);
        } else {
          // B1 fail-closed: invalid revise_budget → default 1 (not ignored/unset).
          warnings.push(
            `invalid 'stage.revise_budget' value (${JSON.stringify(rb)}) — defaulting to 1`
          );
          out.revise_budget = 1;
        }
      }

      if ("grants" in block) {
        const grantsRaw = block.grants;
        if (grantsRaw === undefined) {
          // absent
        } else if (isPlainObject(grantsRaw)) {
          const grants: StageGrants = {};
          for (const [ck, grantMap] of Object.entries(grantsRaw)) {
            if (!isPlainObject(grantMap)) {
              warnings.push(
                `invalid 'stage.grants.${ck}' value (${JSON.stringify(grantMap)}) — ignored`
              );
              continue;
            }
            const parsedMap: Record<string, StageGrant> = {};
            for (const [gid, grant] of Object.entries(grantMap)) {
              if (!isPlainObject(grant)) {
                warnings.push(
                  `invalid 'stage.grants.${ck}.${gid}' value (${JSON.stringify(grant)}) — ignored`
                );
                continue;
              }
              for (const gkey of Object.keys(grant)) {
                if (!KNOWN_GRANT_KEYS.has(gkey)) {
                  warnings.push(`unknown nested key 'stage.grants.${ck}.${gid}.${gkey}' — ignored`);
                }
              }
              const entry: StageGrant = {};
              if (grant.bounce === undefined || typeof grant.bounce === "number") {
                entry.bounce = grant.bounce as number | undefined;
              } else {
                warnings.push(
                  `invalid 'stage.grants.${ck}.${gid}.bounce' (${JSON.stringify(grant.bounce)}) — ignored`
                );
              }
              if (grant.revise === undefined || typeof grant.revise === "number") {
                entry.revise = grant.revise as number | undefined;
              } else {
                warnings.push(
                  `invalid 'stage.grants.${ck}.${gid}.revise' (${JSON.stringify(grant.revise)}) — ignored`
                );
              }
              if (grant.resume === undefined || typeof grant.resume === "boolean") {
                entry.resume = grant.resume as boolean | undefined;
              } else {
                warnings.push(
                  `invalid 'stage.grants.${ck}.${gid}.resume' (${JSON.stringify(grant.resume)}) — ignored`
                );
              }
              parsedMap[gid] = entry;
            }
            grants[ck] = parsedMap;
          }
          out.grants = grants;
        } else {
          warnings.push(`invalid 'stage.grants' value (${JSON.stringify(grantsRaw)}) — ignored`);
        }
      }

      if ("attribution_fail_closed" in block) {
        const afc = block.attribution_fail_closed;
        if (typeof afc === "boolean") {
          out.attribution_fail_closed = afc;
        } else {
          // B3 fail-closed parse: invalid → leave unset (resolvePolicy defaults false).
          warnings.push(
            `invalid 'stage.attribution_fail_closed' value (${JSON.stringify(afc)}) — ignored, falling back to false`
          );
        }
      }

      policy.stage = out;
    } else {
      warnings.push(`invalid 'stage' block (${JSON.stringify(block)}) — ignored`);
    }
  }

  return { policy, warnings };
}

/**
 * Thin fs wrapper over `parsePolicy` (trust boundary, L-1/L-2): reads the
 * git-tracked policy file at `path` (default location decided by the
 * CALLER — this loader takes any path, no hardcoded default here, per
 * contract "путь — параметр загрузчика, НЕ хардкод в логике"). Missing
 * file -> empty policy, same as an empty/absent document (mirrors
 * render/adapter.ts's existsSync-guard pattern for canon reads).
 */
export function loadPolicyFile(path: string): { policy: Policy; warnings: string[] } {
  if (!existsSync(path)) {
    return { policy: {}, warnings: [] };
  }
  const text = readFileSync(path, "utf-8");
  return parsePolicy(text);
}

/**
 * Contract T7-0 L-1/L-2 — worker zone-source file. Relative path (from the
 * caller's cwd, same convention as `loadPolicyFile`'s `policy.yml`) that the
 * orchestrator (lead) writes per-task (`/aiwf-execute` step 2.5) and the
 * hook reads for `actor === "worker"` ONLY (never for `operator` — contract
 * L-1, the file is not even read on that path, see `command-hook.ts`
 * `runHook`).
 */
export const ACTIVE_ZONE_PATH = ".workflow/active-zone.json";

/**
 * Thin fs wrapper (trust boundary, mirrors `loadPolicyFile`): reads and
 * validates `<cwd>/.workflow/active-zone.json` — contract shape
 * `{task: string, allow: string[], deny?: string[]}`. Missing file /
 * unreadable / malformed JSON / not a plain object / `allow` not a
 * string[] -> `undefined` (fail-closed sentinel — the caller, `runHook`,
 * treats `undefined` exactly like "no zone", contract L-1 D9 deny).
 *
 * Contract L-2 (worker self-protection floor, ALWAYS applied on a
 * successfully-parsed file): `ACTIVE_ZONE_PATH` is unconditionally merged
 * into the returned `deny` — the zone file's OWN `deny`/`allow` content can
 * never remove this floor (a worker must never be able to widen its own
 * zone by rewriting the file that defines it, even with `allow: ["**"]`).
 * `task` is read/validated for shape only — not consulted by the
 * classifier.
 *
 * Amend A1-b: strips a leading UTF-8 BOM (`﻿`) before `JSON.parse` —
 * Windows PowerShell 5.1's `Set-Content` (the tool a lead uses to write this
 * file, contract L-6) emits a BOM by default, which otherwise fails
 * `JSON.parse` and degrades to the fail-closed `undefined` sentinel above.
 */
export function loadActiveZoneFile(path: string): { allow: string[]; deny: string[] } | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    const text = readFileSync(path, "utf-8");
    const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    raw = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (!isPlainObject(raw)) return undefined;
  const allowRaw = raw.allow;
  if (!Array.isArray(allowRaw) || !allowRaw.every((x): x is string => typeof x === "string")) {
    return undefined;
  }
  const denyRaw = raw.deny;
  const deny = Array.isArray(denyRaw) ? denyRaw.filter((x): x is string => typeof x === "string") : [];
  return { allow: allowRaw, deny: [...deny, ACTIVE_ZONE_PATH] };
}

/** Normalized actor-resolution signal. Exact per-harness shape is open (§E) — the loader consumes this already-normalized shape. */
export interface ActorSignals {
  subagentMarker?: string | boolean | null;
}

/**
 * Resolve the command actor (AD-worker-zone-always). Fail-closed (contract
 * L-4, critic m3): a present/truthy marker -> `worker`; a genuinely absent
 * marker -> `operator`; anything ambiguous, malformed, or an exception while
 * inspecting the signal -> `worker` (the strict path). Never defaults to
 * `operator` on uncertainty.
 */
export function resolveActor(signals: unknown): Actor {
  try {
    if (signals === null || signals === undefined) {
      return "operator";
    }
    if (typeof signals !== "object") {
      // Malformed signal shape — fail-closed.
      return "worker";
    }
    const marker = (signals as ActorSignals).subagentMarker;
    if (marker === undefined || marker === null) {
      return "operator";
    }
    if (typeof marker === "boolean") {
      return marker ? "worker" : "operator";
    }
    if (typeof marker === "string") {
      return marker.trim() !== "" ? "worker" : "operator";
    }
    // Unknown marker type — fail-closed.
    return "worker";
  } catch {
    return "worker";
  }
}

/** Normalized interactivity signal. The harness shim is expected to project `process.stdout.isTTY` (or equivalent) into this shape. */
export interface InteractiveSignals {
  isTTY?: boolean | null;
}

/**
 * Resolve interactivity (AD-profile-resolution). Fail-closed: absent/unknown
 * -> `false` (treated as headless -> the stricter default profile downstream
 * in `resolvePolicy`/`defaultProfile`).
 */
export function resolveInteractive(signals: unknown): boolean {
  try {
    if (signals === null || signals === undefined || typeof signals !== "object") {
      return false;
    }
    const isTTY = (signals as InteractiveSignals).isTTY;
    return isTTY === true;
  } catch {
    return false;
  }
}

export interface BuildPolicyInput {
  policy?: Policy;
  launchProfile?: Profile;
  interactive: boolean;
}

/**
 * Orchestrate precedence (L-3, AD-profile-resolution): explicit launch
 * parameter > policy-file `profile` > fail-closed default-by-interactivity.
 * Delegates the actual resolution to the LOCKED `resolvePolicy` (L-5) —
 * this function only assembles its input and forwards warnings collected
 * upstream (parse-time) alongside the resolution.
 */
export function buildPolicy(input: BuildPolicyInput): { resolved: ResolvedPolicy; warnings: string[] } {
  const { policy, interactive } = input;
  const warnings: string[] = [];

  // Defensive re-validation: launchProfile is typed as `Profile`, but at
  // runtime (type-strip, no enum) a caller could still hand in an arbitrary
  // string. Fail-closed: an out-of-enum launch parameter is ignored (falls
  // through to file.profile / default) rather than reaching resolvePolicy
  // with a bogus value.
  let launchProfile = input.launchProfile;
  if (launchProfile !== undefined && !(PROFILES as readonly string[]).includes(launchProfile)) {
    warnings.push(`invalid launchProfile value (${JSON.stringify(launchProfile)}) — ignored, falling back to policy-file/default`);
    launchProfile = undefined;
  }

  const resolved = resolvePolicy({
    policy,
    explicitProfile: launchProfile,
    interactive,
  });
  return { resolved, warnings };
}
