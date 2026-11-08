/**
 * core/test/canon-render-drift.test.ts — T-canon-single-source requirement 5:
 * `canon/roles/*.md` + `tools/adapters/*.yml` rendered into a temp root MUST
 * be byte-identical to the committed port `agents/*.md` for every role that
 * originates from canon (`ports/omp/agents`, `ports/claude/agents`, `ports/opencode/agents`).
 * A manual edit of a port copy (bypassing canon) -> red test — this is the
 * single-source enforcement the task exists for.
 * Port sources live under `ports/<client>/`; consumer dest remains `.<client>/` (adapter dir:).
 *
 * Port files with no canon-neutral origin (OpenCode `aiwf.md` — lead
 * tool-gate, port-only) are deliberately excluded (render() never claims
 * them, they must not be diffed against anything).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { render } from "../src/render/engine.ts";

const REPO_ROOT = nodePath.join(import.meta.dirname, "..", "..");
const CANON_ROOT = nodePath.join(REPO_ROOT, "canon");
const ADAPTERS_ROOT = nodePath.join(REPO_ROOT, "tools", "adapters");

const CLIENTS = ["omp", "claude", "opencode"] as const;

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-canon-drift-"));
}

test("canon-render-drift: render(canon, tools/adapters) into temp == committed */agents/*.md (roles from canon)", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const report = render(CANON_ROOT, tmp, {
    clients: [...CLIENTS],
    adaptersRoot: ADAPTERS_ROOT,
  });
  assert.deepEqual(report.errors, [], `render errors: ${JSON.stringify(report.errors)}`);

  // Roles with committed port copies (canon → ports/<client>/agents).
  const roleIds = [
    "critic",
    "executor",
    "explorer",
    "producer",
    "scaffolder",
    "go-developer",
    "gradle-developer",
    "kmp-developer",
    "ktor-developer",
    "rust-developer",
    "swift-developer",
  ];

  // Render still stamps consumer layout `.<client>/agents` (adapter dir:).
  // Committed port SOURCE for all listed clients is `ports/<client>/agents`.
  const committedRoot = (_client: (typeof CLIENTS)[number]): string =>
    nodePath.join(REPO_ROOT, "ports", _client);

  const mismatches: string[] = [];
  for (const client of CLIENTS) {
    for (const roleId of roleIds) {
      const renderRel = nodePath.join(`.${client}`, "agents", `${roleId}.md`);
      const rendered = nodePath.join(tmp, renderRel);
      const committed = nodePath.join(committedRoot(client), "agents", `${roleId}.md`);
      const label = `${client}/agents/${roleId}.md`;
      if (!existsSync(rendered)) {
        mismatches.push(`${label}: not rendered (adapter capability gap?)`);
        continue;
      }
      if (!existsSync(committed)) {
        mismatches.push(`${label}: rendered but not committed in repo`);
        continue;
      }
      const renderedText = readFileSync(rendered, "utf-8");
      const committedText = readFileSync(committed, "utf-8");
      if (renderedText !== committedText) {
        mismatches.push(`${label}: DRIFT (committed copy diverges from canon render)`);
      }
    }
  }

  assert.deepEqual(mismatches, [], `canon <-> port drift:\n${mismatches.join("\n")}`);
});

// ---------------------------------------------------------------------------
// Lead decision (T-canon-single-source): render must NEVER write project
// config — `zonemap`/`delegation` are project-owned (installer seeds them
// only if absent), NOT a render/canon capability. `tools/adapters/{omp,
// opencode}.yml` deliberately declare `capabilities: [roles]` only, so
// `render()` never claims/writes `.omp|.opencode/{zonemap,delegation}.yml`,
// regardless of what `canon/{zonemap,delegation}.yml` contain.
// ---------------------------------------------------------------------------

test("canon-render: render() on a root with pre-existing project zonemap/delegation leaves them byte-identical (never a render capability)", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const seeds: Record<string, string> = {
    ".omp/zonemap.yml": "map:\n  - glob: real/**\n    tech: real\n    agent: real-developer\n",
    ".omp/delegation.yml": "design: claude\nexecute: claude\n",
    ".opencode/zonemap.yml": "map:\n  - glob: real/**\n    tech: real\n    agent: real-developer\n",
    ".opencode/delegation.yml": "design: opencode\nexecute: opencode\n",
  };
  for (const [rel, content] of Object.entries(seeds)) {
    const abs = nodePath.join(tmp, rel);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }

  const report = render(CANON_ROOT, tmp, {
    clients: [...CLIENTS],
    adaptersRoot: ADAPTERS_ROOT,
  });
  assert.deepEqual(report.errors, []);

  for (const [rel, content] of Object.entries(seeds)) {
    const abs = nodePath.join(tmp, rel);
    assert.equal(readFileSync(abs, "utf-8"), content, `${rel} must stay byte-identical — render() must never touch project config`);
    assert.ok(!report.written.includes(rel.replace(/\\/g, "/")), `${rel} must not be in report.written`);
  }
});
