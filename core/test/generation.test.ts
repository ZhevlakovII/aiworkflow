import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generationFromTaskText,
  isLegacySpAdrGeneration,
  isSpecRoadmapGeneration,
} from "../src/design/generation.ts";

test("absent generation → legacy", () => {
  const t = "---\nid: a\nstage: design\n---\n\n# x\n";
  assert.equal(generationFromTaskText(t), "");
  assert.equal(isLegacySpAdrGeneration(t), true);
  assert.equal(isSpecRoadmapGeneration(t), false);
});

test("generation: sp-adr → legacy", () => {
  const t = "---\nid: a\nstage: design\ngeneration: sp-adr\n---\n\n# x\n";
  assert.equal(isLegacySpAdrGeneration(t), true);
  assert.equal(isSpecRoadmapGeneration(t), false);
});

test("generation: spec-roadmap → new path", () => {
  const t = "---\nid: a\nstage: design\ngeneration: spec-roadmap\n---\n\n# x\n";
  assert.equal(isSpecRoadmapGeneration(t), true);
  assert.equal(isLegacySpAdrGeneration(t), false);
});
