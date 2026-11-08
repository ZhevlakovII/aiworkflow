import { test } from "node:test";
import assert from "node:assert/strict";

import { parseZone, scalarField, frontmatter, globList, scalar } from "../src/design/task-zone.ts";

// ---------------------------------------------------------------------------
// task-zone (phase-b1) — parseZone/scalarField, ported from
// `.omp/tools/_lib/task.ts` / `.opencode/lib/task.ts` (contract L-1).
// ---------------------------------------------------------------------------

function fm(body: string): string {
  return `---\n${body}\n---\n\n# task\n`;
}

test("parseZone: no allow -> empty allow, no auto .workflow/** append", () => {
  const z = parseZone(fm(`id: x`));
  assert.deepEqual(z.allow, []);
  assert.deepEqual(z.deny, []);
  assert.equal(z.testCmd, undefined);
  assert.equal(z.gateOptional, false);
});

test("parseZone: allow present -> .workflow/** auto-appended (once)", () => {
  const z = parseZone(fm(`allow: ["core/**"]`));
  assert.deepEqual(z.allow, ["core/**", ".workflow/**"]);
});

test("parseZone: allow already includes .workflow/** -> not duplicated", () => {
  const z = parseZone(fm(`allow: ["core/**", ".workflow/**"]`));
  assert.deepEqual(z.allow, ["core/**", ".workflow/**"]);
});

test("parseZone: deny strips .workflow/** / .workflow/* / .workflow", () => {
  const z = parseZone(fm(`allow: ["core/**"]\ndeny: [".git/**", ".workflow/**", ".workflow/*", ".workflow"]`));
  assert.deepEqual(z.deny, [".git/**"]);
});

test("parseZone: test-cmd + gate-optional scalars parsed", () => {
  const z = parseZone(fm(`allow: ["core/**"]\ntest-cmd: "npm test"\ngate-optional: true`));
  assert.equal(z.testCmd, "npm test");
  assert.equal(z.gateOptional, true);
});

test("parseZone: gate-optional absent -> false", () => {
  const z = parseZone(fm(`allow: ["core/**"]`));
  assert.equal(z.gateOptional, false);
});

test("scalarField: reads an arbitrary frontmatter scalar key", () => {
  const text = fm(`id: t7-2\ncapability: zone-check\nexecute-model: sonnet`);
  assert.equal(scalarField(text, "id"), "t7-2");
  assert.equal(scalarField(text, "capability"), "zone-check");
  assert.equal(scalarField(text, "execute-model"), "sonnet");
  assert.equal(scalarField(text, "nope"), undefined);
});

test("frontmatter/globList/scalar: low-level helpers (reused by gate-setup.ts)", () => {
  const text = fm(`allow: ["a/**", "b/**"]\ntest-cmd: "cd core && node --test"`);
  const f = frontmatter(text);
  assert.deepEqual(globList(f, "allow"), ["a/**", "b/**"]);
  assert.equal(scalar(f, "test-cmd"), "cd core && node --test");
});

test("frontmatter: no --- block -> empty string", () => {
  assert.equal(frontmatter("# no frontmatter here\n"), "");
});
