// opencode flavor — MIR tools/plugins/lib/commands; overlay agents + oneshot; merge opencode.json.
import * as fs from "node:fs";
import * as path from "node:path";
import type { FlavorSpec } from "../registry.ts";
import {
  type InstallCtx,
  ensureDir,
  fwdAbs,
  overlayAgents,
  projectScoped,
  readUtf8,
  renderAgents,
  rewriteImportsUnder,
  rmrf,
  sameAgentContent,
  seedIfAbsent,
  setManagedGitignore,
  shapedMirror,
  vendorDest,
  vendorHarness,
  writeUtf8,
} from "../common.ts";

export type FlavorInstallOpts = InstallCtx & {
  spec: FlavorSpec;
};

function mergeOpencodeJson(
  srcJson: string,
  jsonDst: string,
  agentsMdAbs: string,
  scoped: boolean,
  check?: boolean,
): void {
  const canon = JSON.parse(readUtf8(srcJson)) as Record<string, unknown>;
  let cfg: Record<string, unknown> = {};
  if (fs.existsSync(jsonDst)) {
    try {
      cfg = JSON.parse(readUtf8(jsonDst)) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }
  const cperm = (canon.permission || {}) as Record<string, unknown>;
  const perm = (cfg.permission || {}) as Record<string, unknown>;
  for (const [k, cv] of Object.entries(cperm)) {
    if (
      k === "bash" &&
      perm.bash &&
      typeof perm.bash === "object" &&
      cv &&
      typeof cv === "object"
    ) {
      perm.bash = { ...(perm.bash as object), ...(cv as object) };
    } else {
      perm[k] = cv;
    }
  }
  cfg.permission = perm;
  const instrPath = scoped ? ".opencode/AGENTS.md" : fwdAbs(agentsMdAbs);
  let instr = Array.isArray(cfg.instructions) ? [...(cfg.instructions as string[])] : [];
  if (
    !instr.includes(instrPath) &&
    !instr.includes("./AGENTS.md") &&
    !instr.includes(".opencode/AGENTS.md")
  ) {
    instr.push(instrPath);
  }
  cfg.instructions = instr;
  if (!("$schema" in cfg) && "$schema" in canon) cfg["$schema"] = canon["$schema"];
  const json = JSON.stringify(cfg, null, 2) + "\n";
  if (check) {
    const cur = fs.existsSync(jsonDst) ? readUtf8(jsonDst) : "";
    console.log(
      `[check] opencode.json: ${cur.trim() !== json.trim() ? "would change" : "in sync"}`,
    );
  } else {
    writeUtf8(jsonDst, json);
    console.log("[sync] opencode.json (permission + instructions merged)");
  }
}

export async function installFlavor(opts: FlavorInstallOpts): Promise<number> {
  const { repoRoot, check, keepAgents, spec } = opts;
  const scoped = projectScoped(opts);
  const dest = spec.resolveDest(opts.target);
  const src = path.join(repoRoot, "ports", "opencode");
  const srcJson = path.join(src, "opencode.json");
  if (!fs.existsSync(src) || !fs.existsSync(srcJson)) {
    console.error("ports/opencode or opencode.json missing");
    return 1;
  }
  const jsonDst = scoped
    ? path.join(opts.target!, "opencode.json")
    : path.join(dest, "opencode.json");

  console.log("flavor: opencode");
  console.log(`dest:   ${dest}  (${scoped ? "project-scoped" : "global"})`);

  if (!check) ensureDir(dest);
  vendorDest(repoRoot, dest, check);

  const oursDirs = ["tools", "plugins", "lib", "commands"];
  for (const t of oursDirs) {
    const s = path.join(src, t);
    if (!fs.existsSync(s)) continue;
    shapedMirror(repoRoot, dest, s, t, check);
  }
  vendorHarness(repoRoot, dest, check);
  if (!check) {
    for (const t of oursDirs) {
      const p = path.join(dest, t);
      if (fs.existsSync(p)) rewriteImportsUnder(p, dest);
    }
  }

  let canonAgentNames: string[] = [];
  let keptOverlays: string[] = [];
  const rendered = renderAgents(repoRoot, "opencode");
  try {
    canonAgentNames = rendered.canonNames;
    const agentsDst = path.join(dest, "agents");
    if (rendered.agentsSrc) {
      const ov = overlayAgents(rendered.agentsSrc, agentsDst, { check, keepAgents });
      keptOverlays = ov.keptOverlays;
    }
  } finally {
    rmrf(rendered.tmpRoot);
  }

  // Port-static oneshot agents after live render
  const agentsDst = path.join(dest, "agents");
  for (const name of ["aiwf-oneshot.md", "aiwf-reason.md"]) {
    const s = path.join(src, "agents", name);
    if (!fs.existsSync(s)) continue;
    const outFile = path.join(agentsDst, name);
    if (fs.existsSync(outFile) && keepAgents) {
      if (!sameAgentContent(s, outFile)) keptOverlays.push(name);
      continue;
    }
    if (check) {
      console.log(`[check] agents/${name}: would sync`);
    } else {
      ensureDir(agentsDst);
      fs.copyFileSync(s, outFile);
    }
  }
  if (!check) console.log("[sync] agents/ oneshot static (aiwf-oneshot, aiwf-reason)");

  const agentsMd = path.join(src, "AGENTS.md");
  if (fs.existsSync(agentsMd)) {
    const d = path.join(dest, "AGENTS.md");
    if (check) console.log(`[check] AGENTS.md: ${fs.existsSync(d) ? "compare" : "would create"}`);
    else {
      fs.copyFileSync(agentsMd, d);
      console.log("[sync] AGENTS.md");
    }
  }

  if (scoped) {
    const skel = path.join(repoRoot, "canon", "delegation.yml");
    if (fs.existsSync(skel)) seedIfAbsent(skel, path.join(dest, "delegation.yml"), check, "delegation.yml");
  }

  mergeOpencodeJson(srcJson, jsonDst, path.join(dest, "AGENTS.md"), scoped, check);

  if (scoped && opts.target) {
    const ignoreLines = [
      ".opencode/tools/",
      ".opencode/plugins/",
      ".opencode/lib/",
      ".opencode/commands/",
      ".opencode/AGENTS.md",
      "opencode.json",
      ...canonAgentNames.map((n) => `.opencode/agents/${n}`),
    ];
    setManagedGitignore(
      opts.target,
      "opencode",
      ignoreLines,
      keptOverlays.map((n) => `.opencode/agents/${n}`),
      check,
    );
  }

  console.log(check ? "CHECK done (nothing written)." : "OPENCODE flavor installed.");
  return 0;
}

export async function uninstallFlavor(opts: FlavorInstallOpts): Promise<number> {
  const dest = opts.spec.resolveDest(opts.target);
  if (opts.check) {
    console.log(`[check] would remove managed opencode tree: ${dest}`);
    if (opts.target) console.log(`[check] would leave shared head untouched`);
    return 0;
  }
  if (fs.existsSync(dest)) {
    rmrf(dest);
    console.log(`[uninstall] removed ${dest}`);
  } else console.log(`[uninstall] absent: ${dest}`);
  // project-scoped opencode.json at target root is managed — remove if present
  if (opts.target) {
    const j = path.join(opts.target, "opencode.json");
    if (fs.existsSync(j)) {
      fs.unlinkSync(j);
      console.log(`[uninstall] removed ${j}`);
    }
  }
  return 0;
}
