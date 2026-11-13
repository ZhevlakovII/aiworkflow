import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandFlow, softSkip, FlowError, LIVE_FLAVORS } from "./matrix.ts";

describe("expandFlow", () => {
  it("expands all to four live flavors", () => {
    assert.deepEqual(expandFlow("all"), [...LIVE_FLAVORS]);
  });

  it("rejects claude|codex|both", () => {
    for (const bad of ["claude", "codex", "both"]) {
      assert.throws(() => expandFlow(bad), (e: unknown) => e instanceof FlowError && e.exitCode === 2);
    }
  });
});

describe("softSkip", () => {
  it("allows cursor-only", () => {
    const r = softSkip(["cursor"], new Set(["cursor"]));
    assert.equal(r.abort, false);
    assert.deepEqual(r.installable, ["cursor"]);
  });

  it("aborts when selected non-cursor becomes empty", () => {
    const r = softSkip(["omp", "cursor"], new Set(["cursor"]));
    assert.equal(r.abort, true);
    assert.deepEqual(r.installable, ["cursor"]);
  });

  it("soft-skips absent harness but keeps present", () => {
    const r = softSkip(["omp", "opencode"], new Set(["omp"]));
    assert.equal(r.abort, false);
    assert.deepEqual(r.installable, ["omp"]);
    assert.deepEqual(r.skipped, ["opencode"]);
  });
});
