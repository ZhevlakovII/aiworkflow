import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as engine from "../src/render/engine.ts";
import * as adapterMod from "../src/render/adapter.ts";
import { bundleCore } from "../src/render/bundle.ts";

const FIXTURE_CANON = nodePath.join(import.meta.dirname, "fixtures", "canon-min");
const FIXTURE_ADAPTERS = nodePath.join(FIXTURE_CANON, "adapters");
const FAKE_CORE = nodePath.join(import.meta.dirname, "fixtures", "fake-core");

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-bundle-ts-"));
}

// ---------------------------------------------------------------------------
// bundleCore — faithful copy + nested structure + idempotency
// ---------------------------------------------------------------------------

test("bundleCore: faithful copy, all files present, content identical, nested structure preserved", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const outDir = nodePath.join(tmp, "_core");
  const report = engine.createReport();

  const claimed = bundleCore(FAKE_CORE, outDir, report, "_core");

  assert.equal(existsSync(nodePath.join(outDir, "a.ts")), true);
  assert.equal(existsSync(nodePath.join(outDir, "c.ts")), true);
  assert.equal(existsSync(nodePath.join(outDir, "sub", "b.ts")), true, "nested structure preserved");

  for (const rel of ["a.ts", "c.ts", nodePath.join("sub", "b.ts")]) {
    const srcText = readFileSync(nodePath.join(FAKE_CORE, rel), "utf-8");
    const dstText = readFileSync(nodePath.join(outDir, rel), "utf-8");
    assert.equal(dstText, srcText, `content mismatch for ${rel}`);
  }

  assert.equal(claimed.length, 3);
  assert.equal(report.written.length, 3);
  assert.equal(report.unchanged.length, 0);
});

test("bundleCore: idempotency — 2nd run writes nothing, reports unchanged", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const outDir = nodePath.join(tmp, "_core");

  const report1 = engine.createReport();
  bundleCore(FAKE_CORE, outDir, report1, "_core");
  assert.equal(report1.written.length, 3);

  const report2 = engine.createReport();
  const claimed2 = bundleCore(FAKE_CORE, outDir, report2, "_core");
  assert.deepEqual(report2.written, []);
  assert.equal(report2.unchanged.length, 3);
  assert.equal(claimed2.length, 3);
});

// ---------------------------------------------------------------------------
// adapter.ts — shim field parse
// ---------------------------------------------------------------------------

test("adapter: shim field parsed (mode/location/root/style/entry)", () => {
  const omp = adapterMod.loadAdapter(FIXTURE_ADAPTERS, "omp");
  assert.deepEqual(omp.shim, {
    mode: "bundled",
    location: "hooks/_core",
    root: false,
    style: "in-process",
    entry: "hooks/pre/zone-guard.ts",
  });
});

test("adapter: no shim declared -> shim: null", () => {
  const claude = adapterMod.loadAdapter(FIXTURE_ADAPTERS, "claude");
  assert.equal(claude.shim, null);
});

test("adapter: invalid shim.mode -> AdapterError", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const canonCopy = nodePath.join(tmp, "canon-min");
  // Minimal copy: only adapters/ dir needed for loadAdapter, with a broken shim.
  mkdirSync(nodePath.join(canonCopy, "adapters"), { recursive: true });
  writeFileSync(
    nodePath.join(canonCopy, "adapters", "broken.yml"),
    "client: broken\ndir: \".broken\"\ncapabilities: []\nshim:\n  mode: not-a-real-mode\n  location: x\n",
    "utf-8"
  );
  assert.throws(() => adapterMod.loadAdapter(nodePath.join(canonCopy, "adapters"), "broken"), adapterMod.AdapterError);
});

test("adapter: shimBundlePath honours root flag (D4-style routing)", () => {
  const omp = adapterMod.loadAdapter(FIXTURE_ADAPTERS, "omp");
  const nonRoot = adapterMod.shimBundlePath(omp, "/out", "hooks/_core");
  assert.equal(nonRoot, "/out/.omp/hooks/_core");

  const rooted: adapterMod.Adapter = {
    ...omp,
    shim: { mode: "bundled", location: "hooks/_core", root: true, style: "command-hook", entry: null },
  };
  const rootPath = adapterMod.shimBundlePath(rooted, "/out", "hooks/_core");
  assert.equal(rootPath, "/out/hooks/_core");
});

// ---------------------------------------------------------------------------
// render() — bundle emission wiring
// ---------------------------------------------------------------------------

test("render: bundled-shim adapter + coreSrcRoot -> bundle emitted at routed path, claimed (not unmanaged)", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const out = nodePath.join(tmp, "out");

  const report = engine.render(FIXTURE_CANON, out, {
    clients: ["omp"],
    overlayRoot: nodePath.join(tmp, "no-overlay"),
    coreSrcRoot: FAKE_CORE,
  });

  assert.deepEqual(report.errors, []);
  const bundleRoot = nodePath.join(out, ".omp", "hooks", "_core");
  assert.equal(existsSync(nodePath.join(bundleRoot, "a.ts")), true);
  assert.equal(existsSync(nodePath.join(bundleRoot, "sub", "b.ts")), true);
  assert.equal(existsSync(nodePath.join(bundleRoot, "c.ts")), true);

  // claimed, not unmanaged.
  const unmanagedBundleHits = report.unmanaged.filter((p) => p.startsWith(".omp/hooks/_core"));
  assert.deepEqual(unmanagedBundleHits, []);
});

test("render: adapter without shim -> bundle not emitted, prior content-behaviour intact (regression)", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const out = nodePath.join(tmp, "out");

  const report = engine.render(FIXTURE_CANON, out, {
    clients: ["claude"],
    overlayRoot: nodePath.join(tmp, "no-overlay"),
    coreSrcRoot: FAKE_CORE,
  });

  assert.deepEqual(report.errors, []);
  assert.equal(existsSync(nodePath.join(out, ".claude", "_core")), false);
  assert.equal(existsSync(nodePath.join(out, ".claude", "hooks")), false);
  // Ordinary content still rendered.
  assert.equal(existsSync(nodePath.join(out, "zonemap.yml")), true);
});

test("render: bundled-shim but nonexistent coreSrcRoot -> report.errors non-empty, render does not throw, other content still rendered", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const out = nodePath.join(tmp, "out");
  const missingCoreSrc = nodePath.join(tmp, "no-such-core-src");

  const report = engine.render(FIXTURE_CANON, out, {
    clients: ["omp"],
    overlayRoot: nodePath.join(tmp, "no-overlay"),
    coreSrcRoot: missingCoreSrc,
  });

  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /coreSrcRoot/);
  assert.equal(existsSync(nodePath.join(out, ".omp", "hooks", "_core")), false);
  // Other omp content resources (roles/zonemap/delegation/policy) still rendered.
  assert.equal(existsSync(nodePath.join(out, ".omp", "policy.yml")), true);
  assert.equal(existsSync(nodePath.join(out, ".omp", "agents", "sample.md")), true);
});
