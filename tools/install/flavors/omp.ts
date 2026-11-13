// omp flavor — vendor+render+MIR tools/hooks; project overlay agents; config splice; gitignore.
import * as fs from "node:fs";
import * as path from "node:path";
import type { FlavorSpec } from "../registry.ts";
import {
  type InstallCtx,
  ensureDir,
  fwdAbs,
  mirrorAgents,
  overlayAgents,
  projectScoped,
  readUtf8,
  renderAgents,
  rewriteImportsUnder,
  rmrf,
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

const MARKER =
  "# ===== AIWORKFLOW PRODUCT - managed by tools/install.ps1 (do not edit below) =====";

function spliceConfig(repoRoot: string, dest: string, scoped: boolean, check?: boolean): void {
  const canonCfg = path.join(repoRoot, "ports", "omp", "config.yml");
  const destCfg = path.join(dest, "config.yml");
  if (!fs.existsSync(canonCfg)) throw new Error(`canon config.yml not found: ${canonCfg}`);
  const canonLines = readUtf8(canonCfg).replace(/\r\n/g, "\n").split("\n");
  const extIdx = canonLines.findIndex((l) => l.startsWith("extensions:"));
  if (extIdx < 0) throw new Error("canon config.yml has no 'extensions:'");
  let productBody = canonLines.slice(extIdx).join("\n");
  if (!scoped) productBody = productBody.replace(/\.\/\.omp\//g, "~/.omp/agent/");

  let headText = "";
  if (fs.existsSync(destCfg)) {
    const g = readUtf8(destCfg).replace(/\r\n/g, "\n").split("\n");
    let cut = g.length;
    for (let i = 0; i < g.length; i++) {
      if (g[i] === MARKER || /^extensions:/.test(g[i]!)) {
        cut = i;
        break;
      }
    }
    let headLines = cut > 0 ? g.slice(0, cut) : [];
    let n = headLines.length;
    while (n > 0 && (headLines[n - 1]!.trim() === "" || /^#\s*={3,}/.test(headLines[n - 1]!))) n--;
    headLines = n > 0 ? headLines.slice(0, n) : [];
    headText = headLines.join("\n");
  }
  const newCfg = (headText.trimEnd() + "\n\n" + MARKER + "\n" + productBody).trimEnd() + "\n";
  if (check) {
    const cur = fs.existsSync(destCfg) ? readUtf8(destCfg) : "";
    console.log(`[check] config.yml: ${cur !== newCfg ? "would change" : "in sync"}`);
  } else {
    writeUtf8(destCfg, newCfg);
    console.log("[sync] config.yml: product block rebuilt (head preserved)");
  }
}

export async function installFlavor(opts: FlavorInstallOpts): Promise<number> {
  const { repoRoot, check, keepAgents, spec } = opts;
  const scoped = projectScoped(opts);
  const dest = spec.resolveDest(opts.target);
  const canon = path.join(repoRoot, "ports", "omp");
  if (!fs.existsSync(canon)) {
    console.error(`canon not found: ${canon}`);
    return 1;
  }
  console.log(`flavor: omp`);
  console.log(`canon:  ${canon}`);
  console.log(`dest:   ${dest}  (${scoped ? "project-scoped" : "global"})`);

  if (!check) ensureDir(dest);
  vendorDest(repoRoot, dest, check);

  for (const t of ["tools", "hooks"]) {
    const src = path.join(canon, t);
    if (!fs.existsSync(src)) continue;
    shapedMirror(repoRoot, dest, src, t, check);
  }
  vendorHarness(repoRoot, dest, check);
  if (!check) {
    const unders: string[] = [];
    for (const t of ["tools", "hooks"]) {
      const p = path.join(dest, t);
      if (fs.existsSync(p)) unders.push(p);
    }
    for (const u of unders) rewriteImportsUnder(u, dest);
  }

  let canonAgentNames: string[] = [];
  let keptOverlays: string[] = [];
  const rendered = renderAgents(repoRoot, "omp");
  try {
    canonAgentNames = rendered.canonNames;
    const agentsDst = path.join(dest, "agents");
    if (rendered.agentsSrc) {
      if (!scoped) {
        mirrorAgents(rendered.agentsSrc, agentsDst, check);
      } else {
        const ov = overlayAgents(rendered.agentsSrc, agentsDst, { check, keepAgents });
        keptOverlays = ov.keptOverlays;
      }
    }
  } finally {
    rmrf(rendered.tmpRoot);
  }

  for (const f of ["RULES.md", "AGENTS.md", "WATCHDOG.md", "WATCHDOG.yml"]) {
    const src = path.join(canon, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dest, f);
    if (scoped && f === "RULES.md") {
      seedIfAbsent(src, dst, check, f);
      continue;
    }
    if (check) {
      const differ = !fs.existsSync(dst) || readUtf8(src) !== readUtf8(dst);
      console.log(`[check] ${f}: ${differ ? "would change" : "in sync"}`);
    } else {
      fs.copyFileSync(src, dst);
      console.log(`[sync] ${f}`);
    }
  }

  if (scoped) {
    const skel = path.join(repoRoot, "canon", "delegation.yml");
    if (fs.existsSync(skel)) seedIfAbsent(skel, path.join(dest, "delegation.yml"), check, "delegation.yml");
  }

  spliceConfig(repoRoot, dest, scoped, check);

  if (scoped && opts.target) {
    const ignoreLines = [
      ".omp/tools/",
      ".omp/hooks/",
      ".omp/RULES.md",
      ".omp/AGENTS.md",
      ".omp/WATCHDOG.md",
      ".omp/WATCHDOG.yml",
      ".omp/config.yml",
      ...canonAgentNames.map((n) => `.omp/agents/${n}`),
    ];
    setManagedGitignore(
      opts.target,
      "omp",
      ignoreLines,
      keptOverlays.map((n) => `.omp/agents/${n}`),
      check,
    );
  }

  console.log(check ? "CHECK done (nothing written)." : `INSTALL done (${fwdAbs(dest)}).`);
  return 0;
}

export async function uninstallFlavor(opts: FlavorInstallOpts): Promise<number> {
  const dest = opts.spec.resolveDest(opts.target);
  if (opts.check) {
    console.log(`[check] would remove managed omp tree: ${dest}`);
    return 0;
  }
  if (fs.existsSync(dest)) {
    rmrf(dest);
    console.log(`[uninstall] removed ${dest}`);
  } else {
    console.log(`[uninstall] absent: ${dest}`);
  }
  return 0;
}
