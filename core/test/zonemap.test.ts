import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parseZoneMap, resolveAgent, loadZoneMap } from "../src/zone/zonemap.ts";
import { runZonemapCli } from "../src/zone/zonemap-cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
// A4 (finmanage-project-overlay): the repo's real .omp/zonemap.yml is now an
// empty scaffold (target-specific content moved into the project). This
// fixture is a frozen copy of the old filled zonemap (`git show HEAD:.omp/zonemap.yml`
// before A4) so these parity/DoD assertions keep exercising real map/deny-domain shapes.
const REAL_ZONEMAP = resolve(here, "fixtures/zonemap-finmanage.yml");

// ---------------------------------------------------------------------------
// parseZoneMap (real YAML parser, contract L-1)
// ---------------------------------------------------------------------------

test("parseZoneMap: parses the real .omp/zonemap.yml — 7 map entries, default=executor, deny source/**", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  assert.equal(zm.map.length, 7);
  assert.equal(zm.defaultAgent, "executor");
  assert.deepEqual(zm.denyDomain, ["source/**"]);
});

test("parseZoneMap: entry shape {glob,tech,agent} preserved, order preserved (specificity = declaration order)", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  assert.deepEqual(zm.map[0], { glob: "core/**", tech: "kmp", agent: "kmp-developer" });
  assert.deepEqual(zm.map[5], { glob: "build-logic/**", tech: "gradle", agent: "gradle-developer" });
  assert.deepEqual(zm.map[6], { glob: "bot/**", tech: "go", agent: "go-developer" });
});

test("parseZoneMap: missing map/default/deny-domain sections -> empty map, default=executor, empty deny", () => {
  const zm = parseZoneMap("id: x\n");
  assert.deepEqual(zm.map, []);
  assert.equal(zm.defaultAgent, "executor");
  assert.deepEqual(zm.denyDomain, []);
});

test("parseZoneMap: malformed map entries (missing a field) are dropped, not thrown", () => {
  const zm = parseZoneMap(`map:\n  - glob: "core/**"\n    tech: kmp\n  - glob: "bot/**"\n    tech: go\n    agent: go-developer\n`);
  assert.deepEqual(zm.map, [{ glob: "bot/**", tech: "go", agent: "go-developer" }]);
});

// ---------------------------------------------------------------------------
// resolveAgent — parity with the pre-B2 harness resolver
// (.omp/tools/_lib/zonemap.test.ts fixtures, ported 1:1 as assertions)
// ---------------------------------------------------------------------------

test("resolveAgent: core/money/** -> kmp-developer, tech=kmp, not ambiguous", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["core/money/**"], zm);
  assert.equal(r.agent, "kmp-developer");
  assert.equal(r.tech, "kmp");
  assert.equal(r.ambiguous, false);
});

test("resolveAgent: features/transactions/impl/** -> kmp-developer", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["features/transactions/impl/**"], zm);
  assert.equal(r.agent, "kmp-developer");
});

test("resolveAgent: bot/internal/core/** -> go-developer, tech=go", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["bot/internal/core/**"], zm);
  assert.equal(r.agent, "go-developer");
  assert.equal(r.tech, "go");
});

test("resolveAgent: build-logic/plugins/src/** -> gradle-developer, tech=gradle, not ambiguous", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["build-logic/plugins/src/**"], zm);
  assert.equal(r.agent, "gradle-developer");
  assert.equal(r.tech, "gradle");
  assert.equal(r.ambiguous, false);
});

test("resolveAgent: mixed domains (core/** + bot/**) -> ambiguous, default agent, matched has 2 entries", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["core/**", "bot/**"], zm);
  assert.equal(r.ambiguous, true);
  assert.equal(r.agent, "executor");
  assert.equal(r.matched.length, 2);
});

test("resolveAgent: unknown zone (docs/**) -> default executor, not ambiguous, no match", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["docs/**"], zm);
  assert.equal(r.agent, "executor");
  assert.equal(r.ambiguous, false);
  assert.equal(r.matched.length, 0);
});

test("resolveAgent: source/app/** -> denied, no domain matched", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["source/app/**"], zm);
  assert.deepEqual(r.denied, ["source/app/**"]);
  assert.equal(r.matched.length, 0);
});

test("resolveAgent: .workflow/** in the zone is ignored (not a domain, doesn't cause ambiguity)", () => {
  const zm = loadZoneMap(REAL_ZONEMAP);
  const r = resolveAgent(["core/money/**", ".workflow/**"], zm);
  assert.equal(r.agent, "kmp-developer");
  assert.equal(r.ambiguous, false);
});

// ---------------------------------------------------------------------------
// runZonemapCli (argv/fs shell, contract L-2)
// ---------------------------------------------------------------------------

const REAL_ZONEMAP_TEXT = readFileSync(REAL_ZONEMAP, "utf8");
function fakeReadFile(text: string) {
  return (_p: string) => text;
}

test("CLI: --zonemap missing -> exit 2 usage error", () => {
  const out = runZonemapCli(["--allow", "core/**"], { readFile: fakeReadFile(REAL_ZONEMAP_TEXT) });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /--zonemap/);
});

test("CLI: --allow missing -> exit 2 usage error", () => {
  const out = runZonemapCli(["--zonemap", "x.yml"], { readFile: fakeReadFile(REAL_ZONEMAP_TEXT) });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /--allow/);
});

test("CLI: unknown flag -> exit 2 usage error", () => {
  const out = runZonemapCli(["--bogus"], { readFile: fakeReadFile(REAL_ZONEMAP_TEXT) });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /неизвестный аргумент/);
});

test("CLI: unreadable zonemap file -> exit 2, stderr mentions the path", () => {
  const out = runZonemapCli(["--zonemap", "nope.yml", "--allow", "core/**"], {
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(out.exitCode, 2);
  assert.match(out.stderr, /nope\.yml/);
});

test("CLI: DoD — --allow 'core/**' against the real zonemap -> exit 0, stdout 'kmp-developer'", () => {
  const out = runZonemapCli(["--zonemap", REAL_ZONEMAP, "--allow", "core/**"], { readFile: (p) => readFileSync(p, "utf8") });
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, "kmp-developer");
});

test("CLI: repeated --allow spanning two domains -> exit 3 ambiguous, stdout empty", () => {
  const out = runZonemapCli(["--zonemap", "z.yml", "--allow", "core/**", "--allow", "bot/**"], {
    readFile: fakeReadFile(REAL_ZONEMAP_TEXT),
  });
  assert.equal(out.exitCode, 3);
  assert.match(out.stdout, /AMBIGUOUS/);
});

test("CLI: --allow under deny-domain -> exit 4 denied-domain", () => {
  const out = runZonemapCli(["--zonemap", "z.yml", "--allow", "source/app/**"], {
    readFile: fakeReadFile(REAL_ZONEMAP_TEXT),
  });
  assert.equal(out.exitCode, 4);
  assert.match(out.stdout, /DENIED-DOMAIN/);
});

test("CLI: denied-domain takes priority over ambiguous when both present", () => {
  const out = runZonemapCli(
    ["--zonemap", "z.yml", "--allow", "core/**", "--allow", "bot/**", "--allow", "source/app/**"],
    { readFile: fakeReadFile(REAL_ZONEMAP_TEXT) },
  );
  assert.equal(out.exitCode, 4);
});

test("CLI: unknown/default zone -> exit 0, stdout 'executor'", () => {
  const out = runZonemapCli(["--zonemap", "z.yml", "--allow", "docs/**"], { readFile: fakeReadFile(REAL_ZONEMAP_TEXT) });
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, "executor");
});

test("CLI: --json prints the full ResolveAgentResult, exit code still reflects ambiguous/denied", () => {
  const out = runZonemapCli(["--zonemap", "z.yml", "--allow", "core/**", "--json"], {
    readFile: fakeReadFile(REAL_ZONEMAP_TEXT),
  });
  assert.equal(out.exitCode, 0);
  const parsed = JSON.parse(out.stdout);
  assert.equal(parsed.agent, "kmp-developer");
  assert.equal(parsed.tech, "kmp");
  assert.equal(parsed.ambiguous, false);
});
