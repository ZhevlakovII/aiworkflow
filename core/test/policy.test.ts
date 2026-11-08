import { test } from "node:test";
import assert from "node:assert/strict";

import { PRESETS } from "../src/policy/profile.ts";
import { canTransition, resolvePolicy } from "../src/policy/policy.ts";
import type { Profile } from "../src/policy/profile.ts";
import { DEFAULT_EXTERNAL_ALLOW } from "../src/classify/rules.ts";

test("each PRESET resolves into the expected concerns (AD-profile-presets, exact values)", () => {
  const expected: Record<Profile, { quality_gate: boolean; operator_zone: boolean; rail: string; security_floor: boolean }> = {
    off: { quality_gate: false, operator_zone: false, rail: "none", security_floor: true },
    assist: { quality_gate: true, operator_zone: false, rail: "none", security_floor: true },
    guarded: { quality_gate: true, operator_zone: true, rail: "commit", security_floor: true },
    autonomous: { quality_gate: true, operator_zone: true, rail: "merge", security_floor: true },
  };

  for (const profile of Object.keys(expected) as Profile[]) {
    // sanity: the preset table itself matches the locked spec
    assert.deepEqual(PRESETS[profile], expected[profile]);

    const resolved = resolvePolicy({ explicitProfile: profile, interactive: true });
    assert.equal(resolved.profile, profile);
    assert.equal(resolved.quality_gate.enabled, expected[profile].quality_gate);
    assert.equal(resolved.operator_zone.enabled, expected[profile].operator_zone);
    assert.equal(resolved.rail.level, expected[profile].rail);
    assert.equal(resolved.security_floor.enabled, expected[profile].security_floor);
  }
});

test("explicitProfile overrides policy.profile", () => {
  const resolved = resolvePolicy({
    policy: { profile: "off" },
    explicitProfile: "autonomous",
    interactive: true,
  });
  assert.equal(resolved.profile, "autonomous");
});

test("fail-closed: interactive=false and no profile declared -> guarded (not off/assist)", () => {
  const resolved = resolvePolicy({ interactive: false });
  assert.equal(resolved.profile, "guarded");
  assert.notEqual(resolved.profile, "off");
  assert.notEqual(resolved.profile, "assist");
});

test("interactive=true and no profile declared -> assist", () => {
  const resolved = resolvePolicy({ interactive: true });
  assert.equal(resolved.profile, "assist");
});

test("concern-override: explicit rail.level overrides the preset", () => {
  const resolved = resolvePolicy({
    policy: { profile: "assist", rail: { level: "merge" } },
    interactive: true,
  });
  // preset for "assist" is rail=none, but the explicit override wins
  assert.equal(resolved.rail.level, "merge");
});

test("security_floor stays true even when profile=off", () => {
  const resolved = resolvePolicy({ explicitProfile: "off", interactive: true });
  assert.equal(resolved.security_floor.enabled, true);
});

test("security_floor is disabled only via explicit enabled=false opt-out", () => {
  const resolved = resolvePolicy({
    policy: { security_floor: { enabled: false } },
    explicitProfile: "guarded",
    interactive: true,
  });
  assert.equal(resolved.security_floor.enabled, false);
});

test("canTransition: raising strictness is allowed, lowering is forbidden", () => {
  assert.equal(canTransition("off", "guarded"), true);
  assert.equal(canTransition("autonomous", "off"), false);
  assert.equal(canTransition("guarded", "guarded"), true);
});

test("ResolvedPolicy is frozen: mutation is rejected (strict-mode TypeError)", () => {
  const resolved = resolvePolicy({ explicitProfile: "guarded", interactive: true });

  assert.throws(() => {
    // @ts-expect-error — intentional mutation attempt against a frozen object
    resolved.profile = "off";
  }, TypeError);

  assert.throws(() => {
    // @ts-expect-error — intentional mutation attempt against a frozen nested object
    resolved.rail.level = "none";
  }, TypeError);

  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.rail), true);
  assert.equal(Object.isFrozen(resolved.operator_zone.protected), true);
  assert.equal(Object.isFrozen(resolved.operator_zone.external_allow), true);
});

// ---------------------------------------------------------------------------
// T7-7 L-2 — operator_zone.external_allow default/override
// ---------------------------------------------------------------------------

test("resolvePolicy: operator_zone.external_allow defaults to DEFAULT_EXTERNAL_ALLOW when unset", () => {
  const resolved = resolvePolicy({ explicitProfile: "guarded", interactive: true });
  assert.deepEqual(resolved.operator_zone.external_allow, [...DEFAULT_EXTERNAL_ALLOW]);
});

test("resolvePolicy: operator_zone.external_allow, when set, REPLACES the default wholesale", () => {
  const resolved = resolvePolicy({
    explicitProfile: "guarded",
    interactive: true,
    policy: { operator_zone: { external_allow: ["~/.only-this/**"] } },
  });
  assert.deepEqual(resolved.operator_zone.external_allow, ["~/.only-this/**"]);
});
