// Shared install helpers: paths, vendor/render, MIR/overlay, gitignore, spawn.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  vendorCoreSrc,
  vendorHarnessProtected,
  rewriteImportsUnder,
  rewriteCommandFiles,
  fwdAbs,
} from "../install-runtime.ts";

export type InstallCtx = {
  repoRoot: string;
  /** Project dir for project-scoped install; empty/undefined = global. */
  target?: string;
  check?: boolean;
  keepAgents?: boolean;
};

export function toolsDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function defaultRepoRoot(): string {
  return path.resolve(toolsDir(), "..", "..");
}

export function projectScoped(ctx: InstallCtx): boolean {
  return Boolean(ctx.target && ctx.target.trim());
}

export function homeDir(): string {
  return os.homedir();
}

export function xdgConfigHome(): string {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return path.join(homeDir(), ".config");
}

export function sharedHeadDir(): string {
  if (process.env.AIWF_CONFIG_HOME) return process.env.AIWF_CONFIG_HOME;
  return path.join(xdgConfigHome(), "aiwf");
}

export function headExists(): boolean {
  const head = sharedHeadDir();
  const models = path.join(head, "models.yml");
  const cfg = path.join(head, "config.yml");
  return fs.existsSync(models) || fs.existsSync(cfg);
}

export function readUtf8(p: string): string {
  return fs.readFileSync(p, "utf8");
}

export function writeUtf8(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

export function sameTextNorm(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

export function sameAgentContent(srcFile: string, dstFile: string): boolean {
  if (!fs.existsSync(dstFile)) return false;
  return sameTextNorm(readUtf8(srcFile), readUtf8(dstFile));
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Mirror src -> dst (delete extras under dst). */
export function mirrorTree(src: string, dst: string): void {
  ensureDir(dst);
  const srcFiles = listFilesRecursive(src).map((f) => path.relative(src, f));
  const srcSet = new Set(srcFiles.map((r) => r.split(path.sep).join("/")));
  for (const rel of srcFiles) {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }
  for (const existing of listFilesRecursive(dst)) {
    const rel = path.relative(dst, existing).split(path.sep).join("/");
    if (!srcSet.has(rel)) fs.unlinkSync(existing);
  }
  const prune = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) prune(path.join(d, ent.name));
    }
    if (fs.readdirSync(d).length === 0 && path.resolve(d) !== path.resolve(dst)) {
      fs.rmdirSync(d);
    }
  };
  prune(dst);
}

/** Copy tree without deleting extras. */
export function copyTree(src: string, dst: string): void {
  ensureDir(dst);
  for (const rel of listFilesRecursive(src).map((f) => path.relative(src, f))) {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }
}

export function runNodeScript(scriptAbs: string, args: string[], opts?: { inherit?: boolean }): number {
  const r = spawnSync(process.execPath, [scriptAbs, ...args], {
    encoding: "utf8",
    stdio: opts?.inherit === false ? "pipe" : "inherit",
  });
  return r.status ?? 1;
}

export function runCmd(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: false });
  return {
    status: r.status ?? 1,
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
  };
}

export function which(cmd: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8", shell: false });
  return (r.status ?? 1) === 0;
}

export function vendorDest(repoRoot: string, dest: string, check?: boolean): void {
  if (check) {
    console.log(`[check] would vendor core/src -> ${fwdAbs(dest)}/core/src`);
    return;
  }
  vendorCoreSrc(repoRoot, dest);
}

export function vendorHarness(repoRoot: string, dest: string, check?: boolean): void {
  if (check) {
    console.log(`[check] would vendor-harness -> ${fwdAbs(dest)}/tools/harness-protected.ts`);
    return;
  }
  vendorHarnessProtected(repoRoot, dest);
}

/** Copy srcDir into temp shaped as dest/<relUnder>, rewrite imports vs shadow root. */
export function shapedMirror(
  _repoRoot: string,
  dest: string,
  srcDir: string,
  relUnder: string,
  check?: boolean,
): void {
  const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aiwf-install-"));
  try {
    const shadowSub = path.join(shadowRoot, relUnder);
    ensureDir(path.dirname(shadowSub));
    copyTree(srcDir, shadowSub);
    rewriteImportsUnder(shadowSub, shadowRoot);
    if (check) {
      console.log(`[check] ${relUnder}/: would mirror`);
    } else {
      mirrorTree(shadowSub, path.join(dest, relUnder));
      console.log(`[sync] ${relUnder}/ mirrored`);
    }
  } finally {
    rmrf(shadowRoot);
  }
}

export type RenderAgentsResult = {
  agentsSrc: string;
  tmpRoot: string;
  canonNames: string[];
};

/** Render canon roles for client; returns path to agents dir under tmp (caller must rmrf tmpRoot). */
export function renderAgents(repoRoot: string, client: string): RenderAgentsResult {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `aiwf-render-${client}-`));
  const renderCli = path.join(repoRoot, "core", "src", "render", "cli.ts");
  const canon = path.join(repoRoot, "canon");
  const adapters = path.join(repoRoot, "tools", "adapters");
  const code = runNodeScript(renderCli, [
    "render",
    "--out",
    tmpRoot,
    "--clients",
    client,
    "--canon",
    canon,
    "--adapters",
    adapters,
  ]);
  if (code !== 0) {
    rmrf(tmpRoot);
    throw new Error(`canon render failed for ${client} (exit ${code})`);
  }
  const candidates = [
    path.join(tmpRoot, `.${client}`, "agents"),
    path.join(tmpRoot, "agents"),
  ];
  let agentsSrc = "";
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      agentsSrc = c;
      break;
    }
  }
  const canonNames = agentsSrc
    ? fs.readdirSync(agentsSrc).filter((n) => n.endsWith(".md"))
    : [];
  return { agentsSrc, tmpRoot, canonNames };
}

export type OverlayResult = { keptOverlays: string[] };

/** Overlay *.md from agentsSrc into agentsDst; KeepAgents freezes existing. */
export function overlayAgents(
  agentsSrc: string,
  agentsDst: string,
  opts: { check?: boolean; keepAgents?: boolean; rewrite?: (body: string) => string },
): OverlayResult {
  const keptOverlays: string[] = [];
  if (!agentsSrc || !fs.existsSync(agentsSrc)) return { keptOverlays };
  if (!opts.check) ensureDir(agentsDst);
  let changed = 0;
  for (const name of fs.readdirSync(agentsSrc).filter((n) => n.endsWith(".md"))) {
    const from = path.join(agentsSrc, name);
    const to = path.join(agentsDst, name);
    let body = readUtf8(from);
    if (opts.rewrite) body = opts.rewrite(body);
    const exists = fs.existsSync(to);
    if (exists && opts.keepAgents) {
      if (!sameAgentContent(from, to)) keptOverlays.push(name);
      continue;
    }
    if (opts.check) {
      const cur = exists ? readUtf8(to) : "";
      if (!sameTextNorm(cur, body)) changed++;
    } else {
      writeUtf8(to, body);
    }
  }
  if (opts.check) console.log(`[check] agents/ (overlay): ${changed} file(s) would change`);
  else console.log("[sync] agents/ overlaid from rendered canon");
  return { keptOverlays };
}

/** Global MIR of agents. */
export function mirrorAgents(agentsSrc: string, agentsDst: string, check?: boolean): void {
  if (!agentsSrc || !fs.existsSync(agentsSrc)) return;
  if (check) {
    console.log("[check] agents/: would mirror");
    return;
  }
  mirrorTree(agentsSrc, agentsDst);
  console.log("[sync] agents/ mirrored (rendered from canon)");
}

export function setManagedGitignore(
  targetRoot: string,
  flavor: string,
  ignoreLines: string[],
  exceptionLines: string[],
  check?: boolean,
): void {
  const ignPath = path.join(targetRoot, ".gitignore");
  const begin = `# >>> aiworkflow ${flavor} (managed) >>>`;
  const end = `# <<< aiworkflow ${flavor} (managed) <<<`;
  const body = [...ignoreLines, ...exceptionLines.map((e) => `!${e}`)];
  const block = [begin, ...body, end];
  const existing = fs.existsSync(ignPath) ? readUtf8(ignPath) : "";
  const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === begin && startIdx < 0) startIdx = i;
    else if (lines[i] === end && startIdx >= 0 && endIdx < 0) endIdx = i;
  }
  let newLines: string[];
  if (startIdx >= 0 && endIdx >= startIdx) {
    newLines = [...lines.slice(0, startIdx), ...block, ...lines.slice(endIdx + 1)];
  } else if (lines.length > 0) {
    newLines = [...lines, "", ...block];
  } else {
    newLines = [...block];
  }
  const newText = newLines.join("\n").replace(/\s+$/, "") + "\n";
  const existingNorm = existing ? existing.replace(/\r\n/g, "\n").replace(/\s+$/, "") + "\n" : "";
  if (check) {
    console.log(`[check] .gitignore (${flavor} block): ${existingNorm !== newText ? "would change" : "in sync"}`);
  } else {
    writeUtf8(ignPath, newText);
    console.log(`[sync] .gitignore (${flavor} managed block)`);
  }
}

export function seedIfAbsent(src: string, dst: string, check?: boolean, label?: string): void {
  const name = label || path.basename(dst);
  if (fs.existsSync(dst)) {
    console.log(`[${check ? "check" : "keep"}] ${name}: exists - kept`);
    return;
  }
  if (check) {
    console.log(`[check] ${name}: ABSENT -> would seed`);
    return;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  console.log(`[sync] ${name} (seeded once)`);
}

export function rewriteClone(text: string, dest: string): string {
  return text.split("<clone>").join(fwdAbs(dest));
}

export function rewriteCommandsOnFiles(dest: string, files: string[], cloneRoot: string): void {
  if (files.length === 0) return;
  rewriteCommandFiles(files, dest, { cloneRoot });
}

export { fwdAbs, rewriteImportsUnder, vendorCoreSrc, vendorHarnessProtected };
