/**
 * Contract B — active-zone parse keeps optional `by` without breaking L1 load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseActiveZone } from "../src/rails/active-zone.ts";

test("parseActiveZone: absent by → zone without by", () => {
  const res = parseActiveZone(JSON.stringify({ task: "t1", allow: ["core/**"] }));
  assert.equal(res.kind, "zone");
  if (res.kind === "zone") {
    assert.equal(res.by, undefined);
    assert.deepEqual(res.zone.allow, ["core/**"]);
  }
});

test("parseActiveZone: by:judge preserved", () => {
  const res = parseActiveZone(
    JSON.stringify({ task: "t1", allow: ["core/**"], by: "judge" }),
  );
  assert.equal(res.kind, "zone");
  if (res.kind === "zone") assert.equal(res.by, "judge");
});

test("parseActiveZone: by other string preserved (legacy lead)", () => {
  const res = parseActiveZone(
    JSON.stringify({ task: "t1", allow: ["core/**"], by: "lead" }),
  );
  assert.equal(res.kind, "zone");
  if (res.kind === "zone") assert.equal(res.by, "lead");
});

test("parseActiveZone: non-string by ignored (L1 load still zone)", () => {
  const res = parseActiveZone(
    JSON.stringify({ task: "t1", allow: ["core/**"], by: 42 }),
  );
  assert.equal(res.kind, "zone");
  if (res.kind === "zone") assert.equal(res.by, undefined);
});

test("parseActiveZone: deny + by still floors active-zone path", () => {
  const res = parseActiveZone(
    JSON.stringify({
      task: "t1",
      allow: ["core/**"],
      deny: ["secrets/**"],
      by: "judge",
    }),
  );
  assert.equal(res.kind, "zone");
  if (res.kind === "zone") {
    assert.equal(res.by, "judge");
    assert.ok(res.zone.deny.includes(".workflow/active-zone.json"));
    assert.ok(res.zone.deny.includes("secrets/**"));
  }
});
