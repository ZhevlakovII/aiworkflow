// cursor flavor — vendor; render agents (MIR global / overlay project); skills/hooks rewrite <clone>.
import * as fs from "node:fs";
import * as path from "node:path";
import type { FlavorSpec } from "../registry.ts";
import {
  type InstallCtx,
  ensureDir,
  fwdAbs,
  listFilesRecursive,
  mirrorAgents,
  overlayAgents,
  projectScoped,
  readUtf8,
  renderAgents,
  rewriteClone,
  rewriteCommandsOnFiles,
  rmrf,
  seedIfAbsent,
  setManagedGitignore,
  vendorDest,
  writeUtf8,
} from "../common.ts";

export type FlavorInstallOpts = InstallCtx & {
  spec: FlavorSpec;
};

export async function installFlavor(opts: FlavorInstallOpts): Promise<number> {
  const { repoRoot, check, keepAgents, spec } = opts;
  const scoped = projectScoped(opts);
  const dest = spec.resolveDest(opts.target);
  const src = path.join(repoRoot, "ports", "cursor");
  if (!fs.existsSync(src)) {
    console.error(`ports/cursor not found: ${src}`);
    return 1;
  }
  const leadTpl = path.join(repoRoot, "tools", "templates", "lead-protocol.md");
  const agentsMdSrc = path.join(repoRoot, "AGENTS.md");

  console.log("flavor: cursor");
  console.log(`dest:   ${dest}  (${scoped ? "project-scoped" : "global"})`);

  if (!check) ensureDir(dest);
  vendorDest(repoRoot, dest, check);

  let canonAgentNames: string[] = [];
  let keptOverlays: string[] = [];
  const cmdRewriteFiles: string[] = [];
  const rendered = renderAgents(repoRoot, "cursor");
  try {
    canonAgentNames = rendered.canonNames;
    const agentsDst = path.join(dest, "agents");
    if (rendered.agentsSrc) {
      if (!scoped) {
        mirrorAgents(rendered.agentsSrc, agentsDst, check);
        if (!check && fs.existsSync(agentsDst)) {
          for (const f of fs.readdirSync(agentsDst).filter((n) => n.endsWith(".md"))) {
            const p = path.join(agentsDst, f);
            writeUtf8(p, rewriteClone(readUtf8(p), dest));
            cmdRewriteFiles.push(p);
          }
        }
      } else {
        const ov = overlayAgents(rendered.agentsSrc, agentsDst, {
          check,
          keepAgents,
          rewrite: (b) => rewriteClone(b, dest),
        });
        keptOverlays = ov.keptOverlays;
        if (!check && fs.existsSync(agentsDst)) {
          for (const f of fs.readdirSync(agentsDst).filter((n) => n.endsWith(".md"))) {
            cmdRewriteFiles.push(path.join(agentsDst, f));
          }
        }
      }
    }
  } finally {
    rmrf(rendered.tmpRoot);
  }

  const skillsSrc = path.join(src, "skills");
  const skillsDst = path.join(dest, "skills");
  if (fs.existsSync(skillsSrc)) {
    for (const dir of fs.readdirSync(skillsSrc, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const skillFile = path.join(skillsSrc, dir.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const body = rewriteClone(readUtf8(skillFile), dest);
      const out = path.join(skillsDst, dir.name, "SKILL.md");
      if (check) {
        const cur = fs.existsSync(out) ? readUtf8(out) : "";
        console.log(
          `[check] skills/${dir.name}/SKILL.md: ${cur !== body ? "would change" : "in sync"}`,
        );
      } else {
        ensureDir(path.dirname(out));
        writeUtf8(out, body);
        cmdRewriteFiles.push(out);
      }
    }
    if (!check) console.log("[sync] skills/ (<clone> -> dest)");
  }

  const hooksSrc = path.join(src, "hooks.json");
  const hooksDst = path.join(dest, "hooks.json");
  if (fs.existsSync(hooksSrc)) {
    const body = rewriteClone(readUtf8(hooksSrc), dest);
    if (check) {
      const cur = fs.existsSync(hooksDst) ? readUtf8(hooksDst) : "";
      console.log(`[check] hooks.json: ${cur.trim() !== body.trim() ? "would change" : "in sync"}`);
    } else {
      writeUtf8(hooksDst, body);
      cmdRewriteFiles.push(hooksDst);
      console.log("[sync] hooks.json (<clone> -> dest)");
    }
  }

  if (!check) rewriteCommandsOnFiles(dest, cmdRewriteFiles, repoRoot);

  if (scoped && opts.target && fs.existsSync(agentsMdSrc)) {
    seedIfAbsent(agentsMdSrc, path.join(opts.target, "AGENTS.md"), check, "AGENTS.md");
  }

  if (fs.existsSync(leadTpl)) {
    const leadDst = path.join(dest, "rules", "aiwf-lead.mdc");
    const leadBody = rewriteClone(readUtf8(leadTpl), dest);
    if (check) {
      console.log(
        `[check] rules/aiwf-lead.mdc: ${fs.existsSync(leadDst) ? "exists (will NOT overwrite)" : "would create"}`,
      );
    } else if (fs.existsSync(leadDst)) {
      console.log("[keep] rules/aiwf-lead.mdc exists - not overwritten");
    } else {
      writeUtf8(leadDst, leadBody);
      console.log("[sync] rules/aiwf-lead.mdc (if-absent)");
    }
  }

  if (scoped && opts.target) {
    const ignoreLines = [
      ".cursor/skills/",
      ".cursor/hooks.json",
      ...canonAgentNames.map((n) => `.cursor/agents/${n}`),
    ];
    setManagedGitignore(
      opts.target,
      "cursor",
      ignoreLines,
      keptOverlays.map((n) => `.cursor/agents/${n}`),
      check,
    );
  }

  console.log(check ? "CHECK done (nothing written)." : `CURSOR flavor installed (${fwdAbs(dest)}).`);
  return 0;
}

export async function uninstallFlavor(opts: FlavorInstallOpts): Promise<number> {
  const dest = opts.spec.resolveDest(opts.target);
  if (opts.check) {
    console.log(`[check] would remove managed cursor tree: ${dest}`);
    return 0;
  }
  // Only remove managed subtrees we own; prefer full dest rm for global/project .cursor install root.
  if (fs.existsSync(dest)) {
    // Remove vendored core + agents/skills/hooks/rules we manage
    for (const sub of ["core", "agents", "skills", "hooks.json", "tools", "rules/aiwf-lead.mdc"]) {
      const p = path.join(dest, sub);
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        if (st.isDirectory()) rmrf(p);
        else fs.unlinkSync(p);
      }
    }
    console.log(`[uninstall] cleaned managed cursor paths under ${dest}`);
  } else console.log(`[uninstall] absent: ${dest}`);
  void listFilesRecursive;
  return 0;
}
