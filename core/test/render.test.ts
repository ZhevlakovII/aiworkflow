import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as yaml from "../src/render/yaml.ts";
import * as engine from "../src/render/engine.ts";
import * as adapterMod from "../src/render/adapter.ts";
import type { Resource } from "../src/render/engine.ts";

const FIXTURE_CANON = nodePath.join(import.meta.dirname, "fixtures", "canon-min");
const FIXTURE_ADAPTERS = nodePath.join(FIXTURE_CANON, "adapters");

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-render-ts-"));
}

function treeSnapshot(root: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  function walk(dir: string, rel: string): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = nodePath.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) out[relPath.replace(/\\/g, "/")] = readFileSync(abs);
    }
  }
  walk(root, "");
  return out;
}

// ---------------------------------------------------------------------------
// yaml.ts — round-trip invariant (contract §YAML)
// ---------------------------------------------------------------------------

test("yaml round-trip: nested maps, lists, list-of-maps, scalars", () => {
  const cases: unknown[] = [
    { map: [{ glob: "src/**", agent: "worker" }], default: null, deny_domain: [] },
    { stages: { design: { backend: "native" }, execute: { backend: "custom-model" } } },
    { risk_classes: [{ name: "refactoring", escalation: "none" }] },
    { a: 1, b: 1.5, c: true, d: false, e: null, f: "plain string", g: [1, 2, 3] },
    { nested: { deeply: { list: ["x", "y", { k: "v" }] } } },
    { emptyList: [], emptyMap: {} },
    { special: 'has "quotes", a colon: here, and \\backslash\\', multiline: "line1\nline2\ttabbed" },
  ];
  for (const c of cases) {
    const dumped = yaml.dump(c, { sortKeys: true });
    const reparsed = yaml.parse(dumped);
    assert.deepEqual(reparsed, c, `round-trip failed for ${JSON.stringify(c)}\ndumped:\n${dumped}`);
  }
});

test("yaml round-trip: role-frontmatter-style (sortKeys=false, insertion order preserved)", () => {
  const fm = { name: "sample", description: "d", model: "native", tools: "Read, Grep" };
  const dumped = yaml.dump(fm, { sortKeys: false });
  assert.deepEqual(yaml.parse(dumped), fm);
});

test("yaml: inline flow list/map parse", () => {
  assert.deepEqual(yaml.parse("fields: [name, description, model, tools]"), {
    fields: ["name", "description", "model", "tools"],
  });
  assert.deepEqual(yaml.parse("x: {a: 1, b: two}"), { x: { a: 1, b: "two" } });
  assert.deepEqual(yaml.parse("empty: []"), { empty: [] });
});

test("yaml: comments (full-line and trailing) are stripped, quoted '#' is not", () => {
  const text = '# full line comment\nkey: "value"   # trailing comment\nother: "has # inside quotes"\n';
  assert.deepEqual(yaml.parse(text), { key: "value", other: "has # inside quotes" });
});

test("yaml: scalars — bool/null/number/string variants", () => {
  assert.deepEqual(yaml.parse("a: true\nb: false\nc: null\nd: ~\ne: 42\nf: 3.14\ng: plain\nh: \"quoted\"\n"), {
    a: true,
    b: false,
    c: null,
    d: null,
    e: 42,
    f: 3.14,
    g: "plain",
    h: "quoted",
  });
});

test("yaml: dump is deterministic (sortKeys=true regardless of insertion order)", () => {
  const a = { z: 1, a: 2, m: 3 };
  const b = { a: 2, m: 3, z: 1 };
  assert.equal(yaml.dump(a, { sortKeys: true }), yaml.dump(b, { sortKeys: true }));
});

// ---------------------------------------------------------------------------
// engine.ts — render() checks (port of tools/tests/test_render_engine.py,
// minus shim-specific checks 5/6 — out of scope, T5)
// ---------------------------------------------------------------------------

test("render: determinism, idempotency, capability-skip, materialization, unmanaged", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const out1 = nodePath.join(tmp, "out1");
  const out2 = nodePath.join(tmp, "out2");
  const overlay = nodePath.join(tmp, "overlay");
  mkdirSync(nodePath.join(overlay, "claude"), { recursive: true });
  // Overlay = render INPUT (C3): overlay-key must win over the canon default.
  writeFileSync(
    nodePath.join(overlay, "claude", "delegation.yml"),
    "stages:\n  execute:\n    backend: custom-model\n",
    "utf-8"
  );

  const renderOptions: engine.RenderOptions = { clients: ["claude"], overlayRoot: overlay };

  // --- 1. Determinism ---------------------------------------------------
  const report1 = engine.render(FIXTURE_CANON, out1, renderOptions);
  engine.render(FIXTURE_CANON, out2, renderOptions);
  const snap1 = treeSnapshot(out1);
  const snap2 = treeSnapshot(out2);
  assert.deepEqual(snap1, snap2, "two independent renders must produce identical trees");

  // --- 2. Idempotency (C4) ------------------------------------------------
  const report1b = engine.render(FIXTURE_CANON, out1, renderOptions);
  assert.deepEqual(report1b.written, []);
  assert.ok(report1b.unchanged.length > 0);

  // --- 3. Capability-skip (AD-canon-superset) ------------------------------
  const skipPairs = new Set(report1.skipped.map((s) => `${s.client}:${s.resource.split(":", 1)[0]}`));
  assert.ok(skipPairs.has("claude:policy"), `expected claude:policy skip, got ${JSON.stringify([...skipPairs])}`);
  assert.equal(existsSync(nodePath.join(out1, ".claude", "policy.yml")), false);

  // --- 4. Materialization C3 (default⊕overlay) + D3 (native -> self) ------
  const delegationText = readFileSync(nodePath.join(out1, ".claude", "delegation.yml"), "utf-8");
  const merged = yaml.parse(delegationText) as any;
  assert.equal(merged.stages.design.backend, "claude"); // native -> self (D3)
  assert.equal(merged.stages.execute.backend, "custom-model"); // overlay wins (C3)

  // --- D4: zonemap rendered at out_root root (not under .claude/) ---------
  assert.equal(existsSync(nodePath.join(out1, "zonemap.yml")), true);
  assert.equal(existsSync(nodePath.join(out1, ".claude", "zonemap.yml")), false);

  // --- 7 (renumbered as last here). Unmanaged: stray file -> reported, NOT deleted --
  const strayDir = nodePath.join(out1, ".claude");
  const stray = nodePath.join(strayDir, "STRAY.txt");
  writeFileSync(stray, "posторонний файл — не должен удаляться\n", "utf-8");
  const report3 = engine.render(FIXTURE_CANON, out1, renderOptions);
  assert.ok(report3.unmanaged.includes(".claude/STRAY.txt"), JSON.stringify(report3.unmanaged));
  assert.equal(existsSync(stray), true);
});

test("render: multi-client (claude+omp), omp gets policy resource too", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const out = nodePath.join(tmp, "out");
  // omp fixture adapter declares shim.mode=bundled (T5c-1) -> pass a hermetic
  // coreSrcRoot fixture so this pre-existing content-only test stays green
  // (a nonexistent-coreSrcRoot bundle-failure path is covered in bundle.test.ts).
  const fakeCoreSrc = nodePath.join(import.meta.dirname, "fixtures", "fake-core");
  const report = engine.render(FIXTURE_CANON, out, {
    clients: ["claude", "omp"],
    overlayRoot: nodePath.join(tmp, "no-overlay"),
    coreSrcRoot: fakeCoreSrc,
  });
  assert.deepEqual(report.errors, []);
  assert.equal(existsSync(nodePath.join(out, ".omp", "policy.yml")), true);
  const policyData = yaml.parse(readFileSync(nodePath.join(out, ".omp", "policy.yml"), "utf-8")) as any;
  assert.deepEqual(policyData, { risk_classes: [{ name: "refactoring", escalation: "none" }] });
  // omp role frontmatter uses tools_format=csv_lower.
  const roleText = readFileSync(nodePath.join(out, ".omp", "agents", "sample.md"), "utf-8");
  assert.match(roleText, /tools: "read, grep"/);
});

test("render: unknown client adapter-load-failure is recorded in report.errors, does not throw", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const out = nodePath.join(tmp, "out");
  const report = engine.render(FIXTURE_CANON, out, { clients: ["no-such-client"] });
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /no-such-client/);
});

// ---------------------------------------------------------------------------
// target-dimension (union domain-roles + target-config override)
// ---------------------------------------------------------------------------

test("target-dim: with target -> domain-role present; zonemap overridden", () => {
  const withTarget = engine.collectResources(FIXTURE_CANON, "demo-target");
  const roleIdsWithTarget = new Set(withTarget.filter((r) => r.resourceClass === "roles").map((r) => r.resourceId));
  assert.ok(roleIdsWithTarget.has("domain-role"));
  assert.ok(roleIdsWithTarget.has("sample"));

  const zonemapWithTarget = withTarget.find((r) => r.resourceClass === "zonemap")!;
  assert.deepEqual(zonemapWithTarget.data.map, [{ glob: "target-src/**", agent: "target-worker" }]);
});

test("target-dim: without target -> engine-only (backward compatible, L-1)", () => {
  const noTarget = engine.collectResources(FIXTURE_CANON);
  const roleIdsNoTarget = new Set(noTarget.filter((r) => r.resourceClass === "roles").map((r) => r.resourceId));
  assert.deepEqual(roleIdsNoTarget, new Set(["sample"]));

  const zonemapNoTarget = noTarget.find((r) => r.resourceClass === "zonemap")!;
  assert.deepEqual(zonemapNoTarget.data.map, [{ glob: "src/**", agent: "worker" }]);
});

// ---------------------------------------------------------------------------
// optional-field emit/omit (p2/T2 fix, ported) — synthetic resources, no
// fixture files touched (mirrors tools/tests/test_render_engine.py).
// ---------------------------------------------------------------------------

test("renderRoleText: declared-and-present optional field is emitted; declared-but-absent is OMITTED (not null)", () => {
  const fmSpecOptional = {
    fields: ["name", "description", "model", "tools", "read-summarize"],
    tools_format: "csv_lower",
  };
  const synthPresent: Resource = {
    resourceClass: "roles",
    resourceId: "synth-present",
    kind: "role",
    data: { name: "synth-present", description: "d", model: "m", tools: ["read"], "read-summarize": false, body: "body" },
    source: "synth-present.md",
  };
  const synthAbsent: Resource = {
    resourceClass: "roles",
    resourceId: "synth-absent",
    kind: "role",
    data: { name: "synth-absent", description: "d", model: "m", tools: ["read"], body: "body" },
    source: "synth-absent.md",
  };

  const textPresent = engine.renderRoleText(synthPresent, fmSpecOptional);
  const textAbsent = engine.renderRoleText(synthAbsent, fmSpecOptional);

  const mPresent = engine.FM_RE.exec(textPresent);
  const mAbsent = engine.FM_RE.exec(textAbsent);
  assert.ok(mPresent && mAbsent);
  const fmPresent = yaml.parse(mPresent![1]) as any;
  const fmAbsent = yaml.parse(mAbsent![1]) as any;

  assert.equal(fmPresent["read-summarize"], false);
  assert.equal("read-summarize" in fmAbsent, false, `expected omission, got ${JSON.stringify(fmAbsent)}`);
});

// ---------------------------------------------------------------------------
// adapter.ts — direct D3/D4 sanity (used indirectly above, tested directly too)
// ---------------------------------------------------------------------------

test("adapter: target_path D4 root flag routes to out_root directly, not out_root/dir", () => {
  const a = adapterMod.loadAdapter(FIXTURE_ADAPTERS, "claude");
  const zonemap = adapterMod.targetPath(a, "/out", "zonemap", "zonemap");
  assert.equal(zonemap.isRoot, true);
  assert.equal(zonemap.path, "/out/zonemap.yml");
  const delegation = adapterMod.targetPath(a, "/out", "delegation", "delegation");
  assert.equal(delegation.isRoot, false);
  assert.equal(delegation.path, "/out/.claude/delegation.yml");
});

test("adapter: resolveNative D3 — 'native' resolves to self, other values pass through", () => {
  const a = adapterMod.loadAdapter(FIXTURE_ADAPTERS, "claude");
  assert.equal(adapterMod.resolveNative(a, "native"), "claude");
  assert.equal(adapterMod.resolveNative(a, "custom-model"), "custom-model");
});

test("adapter: discoverClients is sorted", () => {
  // T5c-2 added a hermetic `opencode.yml` fixture adapter to this shared dir
  // (2nd in-process wrapper-template coverage, see inproc-shim.test.ts) —
  // sorted set grows accordingly (claude < omp < opencode).
  assert.deepEqual(adapterMod.discoverClients(FIXTURE_ADAPTERS), ["claude", "omp", "opencode"]);
});
