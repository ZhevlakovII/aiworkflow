import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  artifactsFromTask,
  buildAttributionIndex,
  evaluateStagedAttribution,
  isDesignArtifact,
} from "../src/stage/attribution.ts";
import { artifactHash } from "../src/stage/journal.ts";
import { gatedCommit } from "../src/rails/commit.ts";
import { nodeGitSeam, type GitSeam } from "../src/rails/git-seam.ts";
import type { ResolvedPolicy } from "../src/policy/policy.ts";
import { resolvePolicy } from "../src/policy/policy.ts";

/** Minimal task + fenced SP/AD that gateLint PASSes (source → task L9). */
const OWNED_TASK_LINES = [
  "---",
  "id: owned",
  "stage: design",
  "class: feature",
  'zone:',
  '  allow: ["docs/design/**"]',
  "---",
  "",
  "# Owned task body",
  "",
];
const OWNED_TASK_TEXT = OWNED_TASK_LINES.join("\n");
const OWNED_SOURCE_LINE = 9; // "# Owned task body"

function validOwnedSpecAdr(taskRel = ".workflow/tasks/owned.md"): { spec: string; adr: string } {
  return {
    spec: [
      "```spec",
      "id: SP-owned",
      `source: ${taskRel}#L${OWNED_SOURCE_LINE}`,
      "statement: owned requirement",
      "```",
      "",
    ].join("\n"),
    adr: [
      "```adr",
      "id: AD-owned",
      "covers: SP-owned",
      "statement: owned decision",
      "```",
      "",
    ].join("\n"),
  };
}

function makeTmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

function policyWithAttribution(failClosed: boolean): ResolvedPolicy {
  // quality_gate concern comes from profile preset (guarded=on). Build an
  // assist/off-gate policy by using profile "off" then overriding rail, OR
  // use guarded and pass gateCmd that always passes. Prefer gate off via a
  // non-frozen-friendly path: resolve with assist + rail override, then the
  // preset still enables quality_gate — so we pass an explicit always-green
  // gateCmd at gatedCommit call sites instead of mutating frozen policy.
  return resolvePolicy({
    policy: {
      profile: "assist",
      rail: { level: "commit" },
      stage: { attribution_fail_closed: failClosed },
    },
    interactive: true,
  });
}

function initRepo(): { dir: string; git: GitSeam } {
  const dir = makeTmp("aiwf-attr-");
  const git = nodeGitSeam(dir);
  assert.equal(git.run(["git", "init", "-q", "-b", "main"]).code, 0);
  git.run(["git", "config", "user.email", "test@example.com"]);
  git.run(["git", "config", "user.name", "Attr Test"]);
  writeFileSync(path.join(dir, "README.md"), "init\n");
  git.run(["git", "add", "-A"]);
  assert.equal(git.run(["git", "commit", "-q", "-m", "init"]).code, 0);
  return { dir, git };
}

// ---------------------------------------------------------------------------
// template matcher
// ---------------------------------------------------------------------------

test("isDesignArtifact: matches docs/design/*-{spec,adr}.md", () => {
  assert.equal(isDesignArtifact("docs/design/foo-spec.md"), true);
  assert.equal(isDesignArtifact("docs/design/foo-adr.md"), true);
  assert.equal(isDesignArtifact("docs/design/nested/bar-spec.md"), true);
  assert.equal(isDesignArtifact("docs/design\\win-adr.md"), true);
});

test("isDesignArtifact: rejects non-template paths", () => {
  assert.equal(isDesignArtifact("docs/design/readme.md"), false);
  assert.equal(isDesignArtifact("docs/other/foo-spec.md"), false);
  assert.equal(isDesignArtifact("core/src/foo-spec.md"), false);
  assert.equal(isDesignArtifact("docs/design/"), false);
  assert.equal(isDesignArtifact("foo-spec.md"), false);
});

test("artifactsFromTask: tid + first non-.workflow allow → spec/adr", () => {
  const text = [
    "---",
    "id: my-task",
    'zone:',
    '  allow: [".workflow/ledger/**", "docs/design/**"]',
    "---",
    "",
  ].join("\n");
  const arts = artifactsFromTask(text, "stem");
  assert.equal(arts.tid, "my-task");
  assert.equal(arts.outDir, "docs/design");
  assert.equal(arts.spec, "docs/design/my-task-spec.md");
  assert.equal(arts.adr, "docs/design/my-task-adr.md");
});

test("artifactsFromTask: missing id/allow → stem + docs/design default", () => {
  const arts = artifactsFromTask("# bare\n", "bare-stem");
  assert.equal(arts.tid, "bare-stem");
  assert.equal(arts.spec, "docs/design/bare-stem-spec.md");
  assert.equal(arts.adr, "docs/design/bare-stem-adr.md");
});

// ---------------------------------------------------------------------------
// index from tmp journals
// ---------------------------------------------------------------------------

test("buildAttributionIndex: maps lock spec/adr; last lock wins", () => {
  const dir = makeTmp("aiwf-attr-idx-");
  try {
    const stages = path.join(dir, ".workflow", "stages");
    mkdirSync(stages, { recursive: true });

    writeFileSync(
      path.join(stages, "aaaaaaaaaaaa.design.ndjson"),
      [
        JSON.stringify({ type: "design-begin", task: "t.md" }),
        JSON.stringify({
          type: "design-lock",
          spec: "docs/design/a-spec.md",
          adr: "docs/design/a-adr.md",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    writeFileSync(
      path.join(stages, "bbbbbbbbbbbb.design.ndjson"),
      [
        JSON.stringify({
          type: "design-lock",
          spec: "docs/design/a-spec.md",
          adr: "docs/design/b-adr.md",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    // no lock — ignored
    writeFileSync(
      path.join(stages, "cccccccccccc.design.ndjson"),
      JSON.stringify({ type: "design-begin", task: "x.md" }) + "\n",
      "utf-8",
    );

    const idx = buildAttributionIndex(dir);
    assert.equal(idx.get("docs/design/a-spec.md")?.ck12, "bbbbbbbbbbbb");
    assert.equal(idx.get("docs/design/a-adr.md")?.ck12, "aaaaaaaaaaaa");
    assert.equal(idx.get("docs/design/b-adr.md")?.ck12, "bbbbbbbbbbbb");
    assert.equal(idx.has("docs/design/missing-spec.md"), false);
  } finally {
    cleanup(dir);
  }
});

test("buildAttributionIndex: falls back to design-begin.task when lock lacks paths", () => {
  const dir = makeTmp("aiwf-attr-fb-");
  try {
    const stages = path.join(dir, ".workflow", "stages");
    mkdirSync(stages, { recursive: true });
    mkdirSync(path.join(dir, ".workflow", "tasks"), { recursive: true });
    writeFileSync(
      path.join(dir, ".workflow", "tasks", "fb.md"),
      ["---", "id: fb", 'zone:', '  allow: ["docs/design/**"]', "---", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      path.join(stages, "dddddddddddd.design.ndjson"),
      [
        JSON.stringify({ type: "design-begin", task: ".workflow/tasks/fb.md" }),
        JSON.stringify({ type: "design-lock" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const idx = buildAttributionIndex(dir);
    assert.equal(idx.get("docs/design/fb-spec.md")?.ck12, "dddddddddddd");
    assert.equal(idx.get("docs/design/fb-adr.md")?.locked, true);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// fail-closed via gatedCommit
// ---------------------------------------------------------------------------

test("fail-closed: new unattributed spec → attribution-denied + reset", () => {
  const { dir, git } = initRepo();
  try {
    mkdirSync(path.join(dir, "docs", "design"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "design", "orphan-spec.md"), "# orphan\n");

    const policy = policyWithAttribution(true);

    const result = gatedCommit({
      git,
      policy,
      message: "add orphan",
      actor: "operator",
      repoRoot: dir,
      gateCmd: "true",
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "attribution-denied");
    assert.match(result.detail ?? "", /orphan-spec\.md/);

    const staged = git.run(["git", "diff", "--cached", "--name-only"]);
    assert.equal(staged.stdout.trim(), "");
  } finally {
    cleanup(dir);
  }
});

test("fail-closed: attributed+locked spec allowed", () => {
  const { dir, git } = initRepo();
  try {
    mkdirSync(path.join(dir, "docs", "design"), { recursive: true });
    mkdirSync(path.join(dir, ".workflow", "tasks"), { recursive: true });
    mkdirSync(path.join(dir, ".workflow", "stages"), { recursive: true });

    const taskRel = ".workflow/tasks/owned.md";
    writeFileSync(path.join(dir, taskRel), OWNED_TASK_TEXT, "utf-8");
    const { spec, adr } = validOwnedSpecAdr(taskRel);
    writeFileSync(path.join(dir, "docs", "design", "owned-spec.md"), spec, "utf-8");
    writeFileSync(path.join(dir, "docs", "design", "owned-adr.md"), adr, "utf-8");

    writeFileSync(
      path.join(dir, ".workflow", "stages", "eeeeeeeeeeee.design.ndjson"),
      [
        JSON.stringify({ type: "design-begin", task: taskRel }),
        JSON.stringify({
          type: "design-lock",
          spec: "docs/design/owned-spec.md",
          adr: "docs/design/owned-adr.md",
          specHash: artifactHash(spec),
          adrHash: artifactHash(adr),
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const policy = policyWithAttribution(true);

    const result = gatedCommit({
      git,
      policy,
      message: "add owned",
      actor: "operator",
      repoRoot: dir,
      gateCmd: "true",
    });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status, "committed");
  } finally {
    cleanup(dir);
  }
});

test("fail-closed: tampered spec after lock → attribution-denied", () => {
  const { dir, git } = initRepo();
  try {
    mkdirSync(path.join(dir, "docs", "design"), { recursive: true });
    mkdirSync(path.join(dir, ".workflow", "tasks"), { recursive: true });
    mkdirSync(path.join(dir, ".workflow", "stages"), { recursive: true });

    const taskRel = ".workflow/tasks/owned.md";
    writeFileSync(path.join(dir, taskRel), OWNED_TASK_TEXT, "utf-8");
    const { spec, adr } = validOwnedSpecAdr(taskRel);
    writeFileSync(path.join(dir, "docs", "design", "owned-spec.md"), spec, "utf-8");
    writeFileSync(path.join(dir, "docs", "design", "owned-adr.md"), adr, "utf-8");

    writeFileSync(
      path.join(dir, ".workflow", "stages", "ffffffffffff.design.ndjson"),
      [
        JSON.stringify({ type: "design-begin", task: taskRel }),
        JSON.stringify({
          type: "design-lock",
          spec: "docs/design/owned-spec.md",
          adr: "docs/design/owned-adr.md",
          specHash: artifactHash(spec),
          adrHash: artifactHash(adr),
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    // Tamper after lock — still fenced/valid-looking but different bytes.
    writeFileSync(
      path.join(dir, "docs", "design", "owned-spec.md"),
      spec.replace("owned requirement", "TAMPERED requirement"),
      "utf-8",
    );

    const policy = policyWithAttribution(true);
    const result = gatedCommit({
      git,
      policy,
      message: "tamper owned",
      actor: "operator",
      repoRoot: dir,
      gateCmd: "true",
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "attribution-denied");
    assert.match(result.detail ?? "", /hash mismatch|tamper/);
  } finally {
    cleanup(dir);
  }
});

test("fail-closed: matching hashes + gate PASS → commit ok", () => {
  const { dir, git } = initRepo();
  try {
    mkdirSync(path.join(dir, "docs", "design"), { recursive: true });
    mkdirSync(path.join(dir, ".workflow", "tasks"), { recursive: true });
    mkdirSync(path.join(dir, ".workflow", "stages"), { recursive: true });

    const taskRel = ".workflow/tasks/owned.md";
    writeFileSync(path.join(dir, taskRel), OWNED_TASK_TEXT, "utf-8");
    const { spec, adr } = validOwnedSpecAdr(taskRel);
    const specPath = path.join(dir, "docs", "design", "owned-spec.md");
    const adrPath = path.join(dir, "docs", "design", "owned-adr.md");
    writeFileSync(specPath, spec, "utf-8");
    writeFileSync(adrPath, adr, "utf-8");

    const specH = artifactHash(spec);
    const adrH = artifactHash(adr);
    writeFileSync(
      path.join(dir, ".workflow", "stages", "111111111111.design.ndjson"),
      [
        JSON.stringify({ type: "design-begin", task: taskRel }),
        JSON.stringify({
          type: "design-lock",
          spec: "docs/design/owned-spec.md",
          adr: "docs/design/owned-adr.md",
          specHash: specH,
          adrHash: adrH,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    // Sanity: hashes still match current files.
    assert.equal(artifactHash(spec), specH);
    assert.equal(artifactHash(adr), adrH);

    const policy = policyWithAttribution(true);
    const result = gatedCommit({
      git,
      policy,
      message: "hash-bound owned",
      actor: "operator",
      repoRoot: dir,
      gateCmd: "true",
    });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status, "committed");
  } finally {
    cleanup(dir);
  }
});

test("fail-closed: existing HEAD spec without owner grandfathered", () => {
  const { dir, git } = initRepo();
  try {
    mkdirSync(path.join(dir, "docs", "design"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "design", "legacy-spec.md"), "# legacy\n");
    git.run(["git", "add", "-A"]);
    assert.equal(git.run(["git", "commit", "-q", "-m", "legacy"]).code, 0);

    // Modify the HEAD file (still in HEAD) — no journal owner.
    writeFileSync(path.join(dir, "docs", "design", "legacy-spec.md"), "# legacy v2\n");

    const policy = policyWithAttribution(true);

    const result = gatedCommit({
      git,
      policy,
      message: "edit legacy",
      actor: "operator",
      repoRoot: dir,
      gateCmd: "true",
    });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status, "committed");
  } finally {
    cleanup(dir);
  }
});

test("flag off: new unattributed spec allowed", () => {
  const { dir, git } = initRepo();
  try {
    mkdirSync(path.join(dir, "docs", "design"), { recursive: true });
    writeFileSync(path.join(dir, "docs", "design", "free-spec.md"), "# free\n");

    const policy = policyWithAttribution(false);
    assert.equal(policy.stage.attribution_fail_closed, false);

    const result = gatedCommit({
      git,
      policy,
      message: "add free",
      actor: "operator",
      repoRoot: dir,
      gateCmd: "true",
    });
    assert.equal(result.ok, true, result.detail);
    assert.equal(result.status, "committed");
  } finally {
    cleanup(dir);
  }
});

test("evaluateStagedAttribution: skip when flag false even with staged artifacts", () => {
  const dir = makeTmp("aiwf-attr-skip-");
  try {
    const policy = policyWithAttribution(false);
    const verdict = evaluateStagedAttribution({
      staged: ["docs/design/x-spec.md"],
      policy,
      git: nodeGitSeam(dir),
      repoRoot: dir,
    });
    assert.equal(verdict.ok, true);
  } finally {
    cleanup(dir);
  }
});

test("resolvePolicy: attribution_fail_closed defaults false", () => {
  const resolved = resolvePolicy({ policy: { profile: "guarded" }, interactive: false });
  assert.equal(resolved.stage.attribution_fail_closed, false);
});
