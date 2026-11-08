import { test } from "node:test";
import assert from "node:assert/strict";

import type { StageGrants } from "../src/policy/policy.ts";
import {
  openNeedsHuman,
  tryApplyGrant,
  type GrantAppliedEvent,
} from "../src/stage/grants.ts";
import type { StageJournalEvent } from "../src/stage/journal.ts";

const CK = "abcdef012345";

function nh(reason: string): StageJournalEvent {
  return { type: "needs-human", reason };
}

function ga(grantId: string, kind: string, n?: number): StageJournalEvent {
  const e: StageJournalEvent = { type: "grant-applied", grant_id: grantId, kind };
  if (n !== undefined) e.n = n;
  return e;
}

test("openNeedsHuman: last NH with no later grant-applied is open", () => {
  assert.equal(openNeedsHuman([nh("gate")]), "gate");
  assert.equal(openNeedsHuman([nh("gate"), ga("g1", "bounce", 1)]), null);
  assert.equal(openNeedsHuman([nh("gate"), ga("g1", "bounce", 1), nh("revise")]), "revise");
  assert.equal(openNeedsHuman([{ type: "design-begin" }]), null);
});

test("matching grant applies once: gate→bounce, revise→revise, resume reasons", () => {
  const grants: StageGrants = {
    [CK]: {
      g_bounce: { bounce: 1 },
      g_revise: { revise: 2 },
      g_resume: { resume: true },
    },
  };

  const bounce = tryApplyGrant([nh("gate")], CK, grants);
  assert.deepEqual(bounce, {
    type: "grant-applied",
    grant_id: "g_bounce",
    kind: "bounce",
    n: 1,
  } satisfies GrantAppliedEvent);

  const revise = tryApplyGrant([nh("revise")], CK, grants);
  assert.deepEqual(revise, {
    type: "grant-applied",
    grant_id: "g_revise",
    kind: "revise",
    n: 2,
  });

  const infra = tryApplyGrant([nh("critic-infra")], CK, grants);
  assert.deepEqual(infra, {
    type: "grant-applied",
    grant_id: "g_resume",
    kind: "resume",
  });

  const corrupt = tryApplyGrant([nh("corrupt")], CK, grants);
  assert.deepEqual(corrupt, {
    type: "grant-applied",
    grant_id: "g_resume",
    kind: "resume",
  });
});

test("wrong kind → null (leave NH)", () => {
  const grants: StageGrants = {
    [CK]: { only_resume: { resume: true } },
  };
  assert.equal(tryApplyGrant([nh("gate")], CK, grants), null);
  assert.equal(tryApplyGrant([nh("revise")], CK, grants), null);
});

test("already-applied grant_id ignored; next unused matching grant used", () => {
  const grants: StageGrants = {
    [CK]: {
      g1: { bounce: 1 },
      g2: { bounce: 2 },
    },
  };
  const events: StageJournalEvent[] = [nh("gate"), ga("g1", "bounce", 1), nh("gate")];
  // g1 already applied in journal history → skip; use g2
  const applied = tryApplyGrant(events, CK, grants);
  assert.deepEqual(applied, {
    type: "grant-applied",
    grant_id: "g2",
    kind: "bounce",
    n: 2,
  });
});

test("already-applied id with no other match → null", () => {
  const grants: StageGrants = {
    [CK]: { g1: { bounce: 1 } },
  };
  assert.equal(
    tryApplyGrant([nh("gate"), ga("g1", "bounce", 1), nh("gate")], CK, grants),
    null,
  );
});

test("non-NH ignores grants", () => {
  const grants: StageGrants = {
    [CK]: { g1: { bounce: 1, revise: 1, resume: true } },
  };
  assert.equal(tryApplyGrant([{ type: "design-begin" }], CK, grants), null);
  assert.equal(tryApplyGrant([nh("gate"), ga("x", "bounce", 1)], CK, grants), null);
});

test("unknown ck12 or empty grants → null", () => {
  assert.equal(tryApplyGrant([nh("gate")], CK, {}), null);
  assert.equal(tryApplyGrant([nh("gate")], CK, { otherkey: { g: { bounce: 1 } } }), null);
});
