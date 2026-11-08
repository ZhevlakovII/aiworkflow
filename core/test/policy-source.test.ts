import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  parsePolicy,
  loadPolicyFile,
  loadActiveZoneFile,
  ACTIVE_ZONE_PATH,
  resolveActor,
  resolveInteractive,
  buildPolicy,
} from "../src/wiring/policy-source.ts";

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-policy-source-"));
}

// ---------------------------------------------------------------------------
// parsePolicy
// ---------------------------------------------------------------------------

test("parsePolicy: valid YAML covering every AD-policy-as-data block -> correct Policy", () => {
  const yaml = `
profile: guarded
quality_gate:
  cmd: "npm test"
operator_zone:
  enabled: true
  protected: [".git/**", ".omp/**"]
rail:
  level: commit
  merge_needs_human: true
security_floor:
  enabled: true
`;
  const { policy, warnings } = parsePolicy(yaml);
  assert.deepEqual(warnings, []);
  assert.equal(policy.profile, "guarded");
  assert.equal(policy.quality_gate?.cmd, "npm test");
  assert.equal(policy.operator_zone?.enabled, true);
  assert.deepEqual(policy.operator_zone?.protected, [".git/**", ".omp/**"]);
  assert.equal(policy.rail?.level, "commit");
  assert.equal(policy.rail?.merge_needs_human, true);
  assert.equal(policy.security_floor?.enabled, true);
});

test("parsePolicy: profile outside the enum -> warning, field ignored (falls back to default)", () => {
  const { policy, warnings } = parsePolicy("profile: yolo\n");
  assert.equal(policy.profile, undefined);
  assert.ok(warnings.some((w) => w.includes("profile")));
});

test("parsePolicy: rail.level outside the enum -> warning, field ignored", () => {
  const { policy, warnings } = parsePolicy("rail:\n  level: nuke\n");
  assert.equal(policy.rail?.level, undefined);
  assert.ok(warnings.some((w) => w.includes("rail.level")));
});

// ---------------------------------------------------------------------------
// T7-7 L-2 — operator_zone.external_allow parsing (contract
// .workflow/tasks/t7-7-operator-external-whitelist.md, fail-closed)
// ---------------------------------------------------------------------------

test("parsePolicy: operator_zone.external_allow valid string[] -> parsed as-is", () => {
  const { policy, warnings } = parsePolicy("operator_zone:\n  external_allow: [\"~/.only-this/**\"]\n");
  assert.deepEqual(warnings, []);
  assert.deepEqual(policy.operator_zone?.external_allow, ["~/.only-this/**"]);
});

test("parsePolicy: operator_zone.external_allow absent -> left unset (resolvePolicy applies DEFAULT_EXTERNAL_ALLOW)", () => {
  const { policy, warnings } = parsePolicy("operator_zone:\n  enabled: true\n");
  assert.deepEqual(warnings, []);
  assert.equal(policy.operator_zone?.external_allow, undefined);
});

test("parsePolicy: operator_zone.external_allow not an array -> warning, field ignored (fail-closed)", () => {
  const { policy, warnings } = parsePolicy("operator_zone:\n  external_allow: \"~/.claude/**\"\n");
  assert.equal(policy.operator_zone?.external_allow, undefined);
  assert.ok(warnings.some((w) => w.includes("external_allow")));
});

test("parsePolicy: operator_zone.external_allow array with a non-string element -> warning, field ignored (fail-closed)", () => {
  const { policy, warnings } = parsePolicy("operator_zone:\n  external_allow: [\"~/.claude/**\", 5]\n");
  assert.equal(policy.operator_zone?.external_allow, undefined);
  assert.ok(warnings.some((w) => w.includes("external_allow")));
});

test("parsePolicy: unknown top-level key -> warning, rest still parsed", () => {
  const { policy, warnings } = parsePolicy("profile: assist\nbogus_key: true\n");
  assert.equal(policy.profile, "assist");
  assert.ok(warnings.some((w) => w.includes("bogus_key")));
});

test("parsePolicy: empty text -> {policy:{}, warnings:[]}", () => {
  assert.deepEqual(parsePolicy(""), { policy: {}, warnings: [] });
  assert.deepEqual(parsePolicy("   \n  "), { policy: {}, warnings: [] });
});

// ---------------------------------------------------------------------------
// loadPolicyFile (fs wrapper, trust boundary L-1/L-2)
// ---------------------------------------------------------------------------

test("loadPolicyFile: reads and parses an existing file", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "policy.yml");
    writeFileSync(path, "profile: autonomous\n", "utf-8");
    const { policy, warnings } = loadPolicyFile(path);
    assert.equal(policy.profile, "autonomous");
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPolicyFile: missing file -> empty policy, no throw", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "does-not-exist.yml");
    assert.deepEqual(loadPolicyFile(path), { policy: {}, warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPolicyFile/parsePolicy have no overlay parameter (trust boundary L-2)", () => {
  // Governance policy is read ONLY from a trusted file/text — there is no
  // merge/overlay input anywhere in this module's surface. Enforced here by
  // construction (single required argument, no options bag with an overlay
  // hook) rather than by a runtime check.
  assert.equal(parsePolicy.length, 1);
  assert.equal(loadPolicyFile.length, 1);
});

// ---------------------------------------------------------------------------
// loadActiveZoneFile (contract T7-0 L-1/L-2 — worker zone-source loader)
// ---------------------------------------------------------------------------

test("loadActiveZoneFile: missing file -> undefined", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "does-not-exist.json");
    assert.equal(loadActiveZoneFile(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadActiveZoneFile: malformed JSON -> undefined (fail-closed)", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "active-zone.json");
    writeFileSync(path, "{not json", "utf-8");
    assert.equal(loadActiveZoneFile(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadActiveZoneFile: allow not an array -> undefined (fail-closed)", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "active-zone.json");
    writeFileSync(path, JSON.stringify({ task: "t1", allow: "core/**" }), "utf-8");
    assert.equal(loadActiveZoneFile(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadActiveZoneFile: allow array with a non-string element -> undefined (fail-closed)", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "active-zone.json");
    writeFileSync(path, JSON.stringify({ task: "t1", allow: ["core/**", 5] }), "utf-8");
    assert.equal(loadActiveZoneFile(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadActiveZoneFile: valid file -> allow as declared, ACTIVE_ZONE_PATH always merged into deny (L-2 floor)", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "active-zone.json");
    writeFileSync(path, JSON.stringify({ task: "t1", allow: ["core/**"] }), "utf-8");
    const zone = loadActiveZoneFile(path);
    assert.deepEqual(zone?.allow, ["core/**"]);
    assert.deepEqual(zone?.deny, [ACTIVE_ZONE_PATH]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadActiveZoneFile: allow=[\"**\"] still cannot remove the ACTIVE_ZONE_PATH floor from deny", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "active-zone.json");
    writeFileSync(path, JSON.stringify({ task: "t1", allow: ["**"], deny: [] }), "utf-8");
    const zone = loadActiveZoneFile(path);
    assert.ok(zone?.deny.includes(ACTIVE_ZONE_PATH));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadActiveZoneFile: A1-b — leading UTF-8 BOM is stripped before JSON.parse (Windows PS5.1 Set-Content)", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "active-zone.json");
    writeFileSync(path, "﻿" + JSON.stringify({ task: "t1", allow: ["core/**"] }), "utf-8");
    const zone = loadActiveZoneFile(path);
    assert.deepEqual(zone?.allow, ["core/**"]);
    assert.deepEqual(zone?.deny, [ACTIVE_ZONE_PATH]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadActiveZoneFile: declared deny is preserved alongside the ACTIVE_ZONE_PATH floor", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "active-zone.json");
    writeFileSync(path, JSON.stringify({ task: "t1", allow: ["core/**"], deny: ["core/secret/**"] }), "utf-8");
    const zone = loadActiveZoneFile(path);
    assert.deepEqual(zone?.deny, ["core/secret/**", ACTIVE_ZONE_PATH]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolveActor (AD-worker-zone-always, fail-closed L-4)
// ---------------------------------------------------------------------------

test("resolveActor: marker present (string) -> worker", () => {
  assert.equal(resolveActor({ subagentMarker: "sub-123" }), "worker");
});

test("resolveActor: marker present (boolean true) -> worker", () => {
  assert.equal(resolveActor({ subagentMarker: true }), "worker");
});

test("resolveActor: marker absent -> operator", () => {
  assert.equal(resolveActor({}), "operator");
  assert.equal(resolveActor(undefined), "operator");
});

test("resolveActor: invalid/unparseable marker -> worker (fail-closed)", () => {
  assert.equal(resolveActor({ subagentMarker: 42 as unknown as string }), "worker");
  assert.equal(resolveActor("not-an-object"), "worker");
  assert.equal(resolveActor({ subagentMarker: "" }), "operator"); // explicit empty-string marker == absent
});

// ---------------------------------------------------------------------------
// resolveInteractive
// ---------------------------------------------------------------------------

test("resolveInteractive: isTTY true -> true", () => {
  assert.equal(resolveInteractive({ isTTY: true }), true);
});

test("resolveInteractive: absent/unknown -> false (fail-closed)", () => {
  assert.equal(resolveInteractive({}), false);
  assert.equal(resolveInteractive(undefined), false);
  assert.equal(resolveInteractive({ isTTY: false }), false);
});

// ---------------------------------------------------------------------------
// buildPolicy precedence (L-3) + security_floor sticks (L-5 delegation)
// ---------------------------------------------------------------------------

test("buildPolicy precedence: launchProfile overrides policy.profile", () => {
  const { resolved } = buildPolicy({
    policy: { profile: "off" },
    launchProfile: "autonomous",
    interactive: true,
  });
  assert.equal(resolved.profile, "autonomous");
});

test("buildPolicy precedence: policy.profile overrides default", () => {
  const { resolved } = buildPolicy({
    policy: { profile: "guarded" },
    interactive: true,
  });
  assert.equal(resolved.profile, "guarded");
});

test("buildPolicy precedence: nothing declared + interactive -> assist", () => {
  const { resolved } = buildPolicy({ interactive: true });
  assert.equal(resolved.profile, "assist");
});

test("buildPolicy precedence: nothing declared + !interactive -> guarded (fail-closed)", () => {
  const { resolved } = buildPolicy({ interactive: false });
  assert.equal(resolved.profile, "guarded");
  assert.notEqual(resolved.profile, "off");
  assert.notEqual(resolved.profile, "assist");
});

test("buildPolicy: security_floor stays on even when profile=off (whole stack, via loadPolicyFile+buildPolicy)", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "policy.yml");
    writeFileSync(path, "profile: off\n", "utf-8");
    const { policy } = loadPolicyFile(path);
    const { resolved } = buildPolicy({ policy, interactive: true });
    assert.equal(resolved.profile, "off");
    assert.equal(resolved.security_floor.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPolicy: security_floor opt-out only via explicit enabled:false in the file", () => {
  const dir = makeTmp();
  try {
    const path = nodePath.join(dir, "policy.yml");
    writeFileSync(path, "profile: guarded\nsecurity_floor:\n  enabled: false\n", "utf-8");
    const { policy } = loadPolicyFile(path);
    const { resolved } = buildPolicy({ policy, interactive: true });
    assert.equal(resolved.security_floor.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPolicy: an invalid launchProfile is ignored (fail-closed), falls back to file/default", () => {
  const { resolved, warnings } = buildPolicy({
    policy: { profile: "guarded" },
    launchProfile: "yolo" as unknown as "guarded",
    interactive: true,
  });
  assert.equal(resolved.profile, "guarded");
  assert.ok(warnings.some((w) => w.includes("launchProfile")));
});

// ---------------------------------------------------------------------------
// B1 — session_write_protected / enforcement_paths / stage.* (Design C phase 1)
// ---------------------------------------------------------------------------

test("parsePolicy: session_write_protected + enforcement_paths + stage.revise_budget=1 + grants", () => {
  const yaml = `
session_write_protected: [".workflow/stages/**", "policy.yml"]
enforcement_paths: ["core/src/**", ".gitignore"]
stage:
  revise_budget: 1
  grants:
    abcdef012345:
      g1: { bounce: 1, revise: 2, resume: true }
`;
  const { policy, warnings } = parsePolicy(yaml);
  assert.deepEqual(warnings, []);
  assert.deepEqual(policy.session_write_protected, [".workflow/stages/**", "policy.yml"]);
  assert.deepEqual(policy.enforcement_paths, ["core/src/**", ".gitignore"]);
  assert.equal(policy.stage?.revise_budget, 1);
  assert.deepEqual(policy.stage?.grants?.abcdef012345?.g1, {
    bounce: 1,
    revise: 2,
    resume: true,
  });
});

test("parsePolicy: invalid stage.revise_budget → default 1 + warning", () => {
  const { policy, warnings } = parsePolicy("stage:\n  revise_budget: nope\n");
  assert.equal(policy.stage?.revise_budget, 1);
  assert.ok(warnings.some((w) => w.includes("revise_budget")));
});

test("parsePolicy: unknown nested stage key → warning, known keys still parsed", () => {
  const { policy, warnings } = parsePolicy("stage:\n  revise_budget: 1\n  bogus: true\n");
  assert.equal(policy.stage?.revise_budget, 1);
  assert.ok(warnings.some((w) => w.includes("stage.bogus")));
});

test("parsePolicy: malformed session_write_protected → warning, field ignored", () => {
  const { policy, warnings } = parsePolicy('session_write_protected: "not-a-list"\n');
  assert.equal(policy.session_write_protected, undefined);
  assert.ok(warnings.some((w) => w.includes("session_write_protected")));
});

test("buildPolicy: resolves session_write_protected + revise_budget default 1 when stage absent", () => {
  const { resolved } = buildPolicy({
    policy: { profile: "guarded", session_write_protected: [".workflow/stages/**"] },
    interactive: false,
  });
  assert.deepEqual(resolved.session_write_protected, [".workflow/stages/**"]);
  assert.deepEqual(resolved.enforcement_paths, []);
  assert.equal(resolved.stage.revise_budget, 1);
  assert.deepEqual(resolved.stage.grants, {});
});

test("buildPolicy: stage.revise_budget from file is preserved (still defaultable to 1)", () => {
  const { resolved } = buildPolicy({
    policy: { stage: { revise_budget: 1, grants: { ck: { g: { resume: true } } } } },
    interactive: false,
  });
  assert.equal(resolved.stage.revise_budget, 1);
  assert.equal(resolved.stage.grants.ck?.g?.resume, true);
});

test("parsePolicy: stage.attribution_fail_closed boolean is accepted", () => {
  const { policy, warnings } = parsePolicy("stage:\n  attribution_fail_closed: true\n");
  assert.deepEqual(warnings, []);
  assert.equal(policy.stage?.attribution_fail_closed, true);
});

test("parsePolicy: invalid stage.attribution_fail_closed → warning, field ignored", () => {
  const { policy, warnings } = parsePolicy("stage:\n  attribution_fail_closed: nope\n");
  assert.equal(policy.stage?.attribution_fail_closed, undefined);
  assert.ok(warnings.some((w) => w.includes("attribution_fail_closed")));
});

test("buildPolicy: attribution_fail_closed defaults false; true when set", () => {
  const off = buildPolicy({ policy: {}, interactive: false });
  assert.equal(off.resolved.stage.attribution_fail_closed, false);

  const on = buildPolicy({
    policy: { stage: { attribution_fail_closed: true } },
    interactive: false,
  });
  assert.equal(on.resolved.stage.attribution_fail_closed, true);
});
