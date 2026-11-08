import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  resolveRolePrompt,
  stripFrontmatter,
  isBaseRole,
  installRootFromToolUrl,
  type RoleFsSeam,
} from "../src/roles/resolve.ts";

// ---------------------------------------------------------------------------
// in-memory fs-seam (pure + fs-seam, contract L-2 — no real fs touched here)
// ---------------------------------------------------------------------------

function memSeam(files: Record<string, string>): RoleFsSeam {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
  };
}

const md = (role: string, body: string) => `---\nid: ${role}\n---\n\n${body}\n`;

// ---------------------------------------------------------------------------
// resolveRolePrompt — resolution order
// ---------------------------------------------------------------------------

test("resolveRolePrompt: project overlay wins over install", () => {
  const projectRoot = "/repo";
  const installRoot = "/install";
  const files = {
    [path.join(projectRoot, ".omp", "agents", "producer.md")]: md("producer", "PROJECT producer"),
    [path.join(installRoot, "agents", "producer.md")]: md("producer", "INSTALL producer"),
  };
  const r = resolveRolePrompt({ role: "producer", projectRoot, portDir: ".omp", installRoot }, memSeam(files));
  assert.equal(r.source, "project");
  assert.equal(r.text, "PROJECT producer");
  assert.equal(r.error, undefined);
});

test("resolveRolePrompt: install used when project has no overlay", () => {
  const projectRoot = "/repo";
  const installRoot = "/install";
  const files = {
    [path.join(installRoot, "agents", "critic.md")]: md("critic", "INSTALL critic"),
  };
  const r = resolveRolePrompt({ role: "critic", projectRoot, portDir: ".omp", installRoot }, memSeam(files));
  assert.equal(r.source, "install");
  assert.equal(r.text, "INSTALL critic");
});

test("resolveRolePrompt: domain role with no direct match anywhere -> executor fallback (project)", () => {
  const projectRoot = "/repo";
  const files = {
    [path.join(projectRoot, ".omp", "agents", "executor.md")]: md("executor", "PROJECT executor"),
  };
  const r = resolveRolePrompt({ role: "kmp-developer", projectRoot, portDir: ".omp" }, memSeam(files));
  assert.equal(r.source, "fallback-executor");
  assert.equal(r.text, "PROJECT executor");
});

test("resolveRolePrompt: domain role falls back to INSTALLED executor when neither layer has the domain role", () => {
  const projectRoot = "/repo";
  const installRoot = "/install";
  const files = {
    [path.join(installRoot, "agents", "executor.md")]: md("executor", "INSTALL executor"),
  };
  const r = resolveRolePrompt({ role: "go-developer", projectRoot, portDir: ".omp", installRoot }, memSeam(files));
  assert.equal(r.source, "fallback-executor");
  assert.equal(r.text, "INSTALL executor");
});

test("resolveRolePrompt: domain role's OWN project file wins even over an installed executor", () => {
  const projectRoot = "/repo";
  const installRoot = "/install";
  const files = {
    [path.join(projectRoot, ".omp", "agents", "kmp-developer.md")]: md("kmp-developer", "PROJECT kmp-developer"),
    [path.join(installRoot, "agents", "executor.md")]: md("executor", "INSTALL executor"),
  };
  const r = resolveRolePrompt({ role: "kmp-developer", projectRoot, portDir: ".omp", installRoot }, memSeam(files));
  assert.equal(r.source, "project");
  assert.equal(r.text, "PROJECT kmp-developer");
});

test("resolveRolePrompt: base role not found anywhere -> explicit error, never an empty prompt", () => {
  const r = resolveRolePrompt({ role: "producer", projectRoot: "/repo", portDir: ".omp" }, memSeam({}));
  assert.equal(r.text, undefined);
  assert.match(r.error ?? "", /role-spec не найден/);
  assert.match(r.error ?? "", /producer/);
});

test("resolveRolePrompt: domain role not found anywhere (incl. executor fallback) -> explicit error", () => {
  const r = resolveRolePrompt({ role: "rust-developer", projectRoot: "/repo", portDir: ".omp" }, memSeam({}));
  assert.equal(r.text, undefined);
  assert.match(r.error ?? "", /role-spec не найден/);
});

test("resolveRolePrompt: frontmatter is stripped for both project and install sources", () => {
  const projectRoot = "/repo";
  const files = {
    [path.join(projectRoot, ".claude", "agents", "explorer.md")]: "---\nid: explorer\n---\n\nExplorer prose.\n",
  };
  const r = resolveRolePrompt({ role: "explorer", projectRoot, portDir: ".claude" }, memSeam(files));
  assert.equal(r.text, "Explorer prose.");
  assert.equal(r.source, "project");
});

// ---------------------------------------------------------------------------
// stripFrontmatter
// ---------------------------------------------------------------------------

test("stripFrontmatter: frontmatter removed, prose kept", () => {
  assert.equal(stripFrontmatter("---\nid: x\n---\n\nbody text\n"), "body text");
});

test("stripFrontmatter: leading BOM does not break frontmatter detection", () => {
  const text = "\uFEFF---\nid: x\n---\n\nbody after bom\n";
  assert.equal(stripFrontmatter(text), "body after bom");
});

test("stripFrontmatter: CRLF line endings do not break the frontmatter split", () => {
  const text = "---\r\nid: x\r\n---\r\n\r\nCRLF body\r\n";
  assert.equal(stripFrontmatter(text), "CRLF body");
});

test("stripFrontmatter: no leading '---' -> whole text kept, trimmed", () => {
  assert.equal(stripFrontmatter("  hello world  "), "hello world");
});

// ---------------------------------------------------------------------------
// isBaseRole / installRootFromToolUrl
// ---------------------------------------------------------------------------

test("isBaseRole: base roles vs domain roles", () => {
  assert.equal(isBaseRole("producer"), true);
  assert.equal(isBaseRole("critic"), true);
  assert.equal(isBaseRole("explorer"), true);
  assert.equal(isBaseRole("scaffolder"), true);
  assert.equal(isBaseRole("executor"), true);
  assert.equal(isBaseRole("kmp-developer"), false);
  assert.equal(isBaseRole("go-developer"), false);
});

test("installRootFromToolUrl: <installRoot>/tools/<name>.ts -> installRoot (Bun/Node import.meta.url shape)", () => {
  const url = "file:///C:/repo/.omp/tools/execute_worker.ts";
  const root = installRootFromToolUrl(url).replace(/\\/g, "/");
  assert.match(root, /\/repo\/\.omp$/);
});
