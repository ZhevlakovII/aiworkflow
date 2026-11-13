// dsh flavor — Cordis plugin under ~/.dsh/profiles/<profile>/plugins/aiwf + optional .dsh-aiwf overlay.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FlavorSpec } from "../registry.ts";
import {
  type InstallCtx,
  copyTree,
  ensureDir,
  readUtf8,
  renderAgents,
  rewriteImportsUnder,
  rmrf,
  seedIfAbsent,
  vendorDest,
  writeUtf8,
} from "../common.ts";

export type FlavorInstallOpts = InstallCtx & {
  spec: FlavorSpec;
  profile?: string;
};

export async function installFlavor(opts: FlavorInstallOpts): Promise<number> {
  const { repoRoot, check, spec } = opts;
  const src = path.join(repoRoot, "ports", "dsh");
  if (!fs.existsSync(src)) {
    console.error(`ports/dsh not found: ${src}`);
    return 1;
  }
  const profile = opts.profile || process.env.AIWF_DSH_PROFILE || "headless";
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  const profileDir = path.join(dshHome, "profiles", profile);
  const pluginDest = path.join(profileDir, "plugins", "aiwf");
  const patchDst = path.join(profileDir, "cordis.patch.yml");
  const overlay = opts.target ? path.join(opts.target, ".dsh-aiwf") : "";
  const frag = path.join(src, "cordis.patch.fragment.yml");

  console.log("flavor: dsh");
  console.log(`plugin:  ${pluginDest}`);
  console.log(`patch:   ${patchDst}`);
  console.log(`overlay: ${overlay || "<none>"}`);

  if (check) {
    console.log(`[check] would vendor core/src -> ${pluginDest}/core/src`);
    console.log(`[check] plugin -> ${pluginDest}`);
    console.log("[check] cordis.patch.yml merge");
    if (overlay) console.log(`[check] overlay -> ${overlay}`);
    return 0;
  }

  ensureDir(pluginDest);
  vendorDest(repoRoot, pluginDest, false);
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), "aiwf-dsh-"));
  try {
    copyTree(src, shadow);
    // do not copy cordis fragment as plugin body noise — copy all port files then rewrite
    rewriteImportsUnder(shadow, shadow);
    copyTree(shadow, pluginDest);
    rewriteImportsUnder(pluginDest, pluginDest);
    console.log(`[sync] plugin -> ${pluginDest}`);
  } finally {
    rmrf(shadow);
  }

  if (fs.existsSync(frag)) {
    const body = readUtf8(frag);
    ensureDir(profileDir);
    if (fs.existsSync(patchDst) && readUtf8(patchDst).includes("aiwf-dsh")) {
      console.log("[sync] cordis.patch.yml already has aiwf block");
    } else if (fs.existsSync(patchDst)) {
      fs.appendFileSync(patchDst, `\n# --- aiworkflow dsh (managed) ---\n${body}`, "utf8");
      console.log("[sync] cordis.patch.yml merged");
    } else {
      writeUtf8(patchDst, body);
      console.log("[sync] cordis.patch.yml created");
    }
  }

  if (overlay) {
    const rendered = renderAgents(repoRoot, "dsh");
    try {
      ensureDir(overlay);
      for (const f of ["AGENTS.md", "RULES.md", "WATCHDOG.md", "WATCHDOG.yml"]) {
        const from = path.join(src, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(overlay, f));
      }
      if (rendered.agentsSrc && fs.existsSync(rendered.agentsSrc)) {
        copyTree(rendered.agentsSrc, path.join(overlay, "agents"));
      }
      const skel = path.join(repoRoot, "canon", "delegation.yml");
      const seedSrc = fs.existsSync(skel) ? skel : path.join(src, "delegation.yml");
      if (fs.existsSync(seedSrc)) {
        seedIfAbsent(seedSrc, path.join(overlay, "delegation.yml"), false, "delegation.yml");
      }
      console.log(`[sync] overlay -> ${overlay}`);
    } finally {
      rmrf(rendered.tmpRoot);
    }
  }

  void spec;
  console.log("done");
  return 0;
}

export async function uninstallFlavor(opts: FlavorInstallOpts): Promise<number> {
  const profile = opts.profile || process.env.AIWF_DSH_PROFILE || "headless";
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
  const pluginDest = path.join(dshHome, "profiles", profile, "plugins", "aiwf");
  const overlay = opts.target ? path.join(opts.target, ".dsh-aiwf") : "";
  if (opts.check) {
    console.log(`[check] would remove ${pluginDest}`);
    if (overlay) console.log(`[check] would remove ${overlay}`);
    return 0;
  }
  if (fs.existsSync(pluginDest)) {
    rmrf(pluginDest);
    console.log(`[uninstall] removed ${pluginDest}`);
  }
  if (overlay && fs.existsSync(overlay)) {
    rmrf(overlay);
    console.log(`[uninstall] removed ${overlay}`);
  }
  return 0;
}
