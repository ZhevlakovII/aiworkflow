/**
 * core/test/canon-render-drift.test.ts — domain collapse:
 * phase-1: render(canon) emits live five + scaffolder legacy (base six).
 * phase-2: committed ports/<client>/agents match render for base six and
 * contain zero *-developer.md (non-canon port-only agents like OpenCode
 * aiwf.md are allowed extras).
 * Second test keeps render-never-writes-project-config invariant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { render } from "../src/render/engine.ts";

const REPO_ROOT = nodePath.join(import.meta.dirname, "..", "..");
const CANON_ROOT = nodePath.join(REPO_ROOT, "canon");
const ADAPTERS_ROOT = nodePath.join(REPO_ROOT, "tools", "adapters");

/** Clients used by phase-1 render smoke (historical trio). */
const CLIENTS = ["omp", "claude", "opencode"] as const;

/** Port SRC trees under ports/<id>/agents — render dir may differ (dsh → .dsh-aiwf). */
const PORT_CLIENTS: readonly { port: string; renderDir: string }[] = [
  { port: "omp", renderDir: ".omp" },
  { port: "claude", renderDir: ".claude" },
  { port: "opencode", renderDir: ".opencode" },
  { port: "cursor", renderDir: ".cursor" },
  { port: "dsh", renderDir: ".dsh-aiwf" },
];

/** Live five + scaffolder legacy (canon role files must match). */
const BASE_ROLES = ["critic", "executor", "explorer", "producer", "roadmapper", "scaffolder"] as const;
const DOMAIN_GONE = [
  "go-developer",
  "gradle-developer",
  "kmp-developer",
  "ktor-developer",
  "rust-developer",
  "swift-developer",
] as const;


/** UTF-8 text compare: strip BOM, normalize CRLF→LF (Windows-stable). */
function textNorm(buf: Buffer): string {
  let s = buf.toString("utf8");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function makeTmp(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "aiwf-canon-drift-"));
}

test("canon-render-drift: render(canon) emits live five + scaffolder legacy (base six; port trees phase-2)", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const report = render(CANON_ROOT, tmp, {
    clients: [...CLIENTS],
    adaptersRoot: ADAPTERS_ROOT,
  });
  assert.deepEqual(report.errors, [], `render errors: ${JSON.stringify(report.errors)}`);

  const baseRoles = [...BASE_ROLES];
  const domainGone = [...DOMAIN_GONE];

  const canonRoleFiles = readdirSync(nodePath.join(CANON_ROOT, "roles"))
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
  assert.deepEqual(canonRoleFiles, [...baseRoles].sort());

  const missing = [];
  const unexpectedDomain = [];
  for (const client of CLIENTS) {
    for (const roleId of baseRoles) {
      const rendered = nodePath.join(tmp, `.${client}`, "agents", `${roleId}.md`);
      if (!existsSync(rendered)) missing.push(`${client}/agents/${roleId}.md`);
    }
    for (const roleId of domainGone) {
      const rendered = nodePath.join(tmp, `.${client}`, "agents", `${roleId}.md`);
      if (existsSync(rendered)) unexpectedDomain.push(`${client}/agents/${roleId}.md`);
    }
  }
  assert.deepEqual(missing, [], `base roles not rendered: ${missing.join(", ")}`);
  assert.deepEqual(
    unexpectedDomain,
    [],
    `domain roles must not render from collapsed canon: ${unexpectedDomain.join(", ")}`,
  );

  const execRendered = nodePath.join(tmp, "." + "omp", "agents", "executor.md");
  if (existsSync(execRendered)) {
    const prose = readFileSync(execRendered, "utf-8");
    assert.match(prose, /правила проекта/i);
    assert.match(prose, /важнее общих идиом/i);
  }
});

test("canon-render-drift: committed ports/*/agents match render base six; zero domain md (phase-2)", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const report = render(CANON_ROOT, tmp, {
    clients: ["omp", "claude", "opencode", "cursor", "dsh"],
    adaptersRoot: ADAPTERS_ROOT,
  });
  assert.deepEqual(report.errors, [], `render errors: ${JSON.stringify(report.errors)}`);

  const drift: string[] = [];
  const missingPort: string[] = [];
  const domainInPorts: string[] = [];
  const domainRe = /^(go|kmp|gradle|ktor|rust|swift)-developer\.md$/;

  for (const { port, renderDir } of PORT_CLIENTS) {
    const portAgents = nodePath.join(REPO_ROOT, "ports", port, "agents");
    assert.ok(existsSync(portAgents), `ports/${port}/agents must exist`);

    for (const roleId of BASE_ROLES) {
      const rendered = nodePath.join(tmp, renderDir, "agents", `${roleId}.md`);
      const committed = nodePath.join(portAgents, `${roleId}.md`);
      if (!existsSync(committed)) {
        missingPort.push(`ports/${port}/agents/${roleId}.md`);
        continue;
      }
      if (!existsSync(rendered)) {
        drift.push(`render missing ${renderDir}/agents/${roleId}.md`);
        continue;
      }
      const a = textNorm(readFileSync(rendered));
      const b = textNorm(readFileSync(committed));
      if (a !== b) {
        drift.push(`ports/${port}/agents/${roleId}.md != render ${renderDir}/agents/${roleId}.md`);
      }
    }

    for (const name of readdirSync(portAgents)) {
      if (domainRe.test(name)) domainInPorts.push(`ports/${port}/agents/${name}`);
    }
  }

  // Belt: any ports/*/agents with collapsed domain filenames.
  const portsRoot = nodePath.join(REPO_ROOT, "ports");
  for (const ent of readdirSync(portsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const agentsDir = nodePath.join(portsRoot, ent.name, "agents");
    if (!existsSync(agentsDir)) continue;
    for (const name of readdirSync(agentsDir)) {
      if (domainRe.test(name)) domainInPorts.push(`ports/${ent.name}/agents/${name}`);
    }
  }

  assert.deepEqual(missingPort, [], `base roles missing in ports: ${missingPort.join(", ")}`);
  assert.deepEqual(drift, [], `ports agents drifted from render: ${drift.join(", ")}`);
  assert.deepEqual(
    [...new Set(domainInPorts)].sort(),
    [],
    `domain *-developer.md must be absent under ports/**/agents: ${[...new Set(domainInPorts)].join(", ")}`,
  );

  // Non-canon port-only agents may remain (e.g. OpenCode aiwf.md).
  assert.ok(
    existsSync(nodePath.join(REPO_ROOT, "ports", "opencode", "agents", "aiwf.md")),
    "OpenCode non-canon aiwf.md must be preserved",
  );
});


// Lead decision (T-canon-single-source): render must NEVER write project
// config — zonemap/delegation are project-owned (delegation may seed-if-absent;
// zonemap is not seeded), NOT a render/canon capability.
test("canon-render: render() on a root with pre-existing project zonemap/delegation leaves them byte-identical (never a render capability)", (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const seeds = {
    [nodePath.join("." + "omp", "zonemap.yml")]: "map:\n  - glob: real/**\n    tech: real\n    agent: real-developer\n",
    [nodePath.join("." + "omp", "delegation.yml")]: "design: claude\nexecute: claude\n",
    [nodePath.join("." + "opencode", "zonemap.yml")]: "map:\n  - glob: real/**\n    tech: real\n    agent: real-developer\n",
    [nodePath.join("." + "opencode", "delegation.yml")]: "design: opencode\nexecute: opencode\n",
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
