// install-runtime -- vendor core/src into a flavor dest and rewrite refs to the
// installed location (ADR AD-runtime-per-dest-vendor + AD-rewrite-installed-location).
//
// Wave A helper only: installers call this later (wave B). Callable from ps1/sh:
//   node tools/install-runtime.ts vendor --repo <repo> --dest <dest>
//   node tools/install-runtime.ts rewrite-imports --dest <dest> --under <dir> [--under ...]
//   node tools/install-runtime.ts rewrite-commands --dest <dest> --file <path> [--file ...] [--clone-root <path>]
//   node tools/install-runtime.ts smoke
//
// Rules (one for all flavors):
// 1. Copy core/src into dest/core/src before rewrite (+ core/package.json neighbor).
// 2. TS file-relative imports: replace (../)+core/src/ with rel path from that file dir
//    to dest/core/src/. Neighbor ../lib is left alone.
// 3. Cwd-resolved command strings: absolute path inside dest (never cache/clone).
//    Replaces <clone> token and optional --clone-root absolute prefixes.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Match existing installer CORE_RE: one-or-more ../ then core/src/. */
export const CORE_IMPORT_RE = /(?:\.\.\/)+core\/src\//g;

/** Cursor/skills token kept literal in port SRC until install rewrite. */
export const CLONE_TOKEN = "<clone>";

/** Neighbors of core/src required so node can start strip-types ESM under dest. */
export const CORE_NEIGHBORS = ["package.json"] as const;

export type VendorResult = {
  destCoreSrc: string;
  copiedFiles: number;
  neighbors: string[];
};

export type RewriteResult = {
  filesScanned: number;
  filesChanged: number;
  paths: string[];
};

/** Absolute path, forward slashes, no trailing slash (except drive root). */
export function fwdAbs(p: string): string {
  let abs = path.resolve(p);
  if (process.platform === "win32" && /^[a-z]:/i.test(abs)) {
    abs = abs[0].toUpperCase() + abs.slice(1);
  }
  return abs.replace(/\\/g, "/").replace(/\/+$/, "") || abs.replace(/\\/g, "/");
}

/** dest/core/src absolute, forward slashes, no trailing slash. */
export function destCoreSrcAbs(dest: string): string {
  return fwdAbs(path.join(dest, "core", "src"));
}

/**
 * Relative import prefix from filePath directory to dest/core/src/.
 * Always uses /, always ends with /. Examples:
 *   dest/lib/x.ts        - ../core/src/
 *   dest/tools/_lib/x.ts - ../../core/src/
 *   dest/hooks/pre/x.ts  - ../../core/src/
 */
export function coreImportPrefix(filePath: string, dest: string): string {
  const fileDir = path.dirname(path.resolve(filePath));
  const coreSrc = path.resolve(dest, "core", "src");
  let rel = path.relative(fileDir, coreSrc);
  if (!rel || rel === "") rel = ".";
  rel = rel.split(path.sep).join("/");
  if (!rel.startsWith(".") && !path.isAbsolute(rel)) rel = "./" + rel;
  if (!rel.endsWith("/")) rel += "/";
  return rel;
}

/** Replace (../)+core/src/ with the per-file relative prefix. Idempotent if already correct. */
export function rewriteImportsInText(text: string, filePath: string, dest: string): string {
  const prefix = coreImportPrefix(filePath, dest);
  return text.replace(CORE_IMPORT_RE, prefix);
}

/**
 * Rewrite cwd-resolved command/hook strings so core refs are absolute inside dest.
 * - <clone> becomes destAbs
 * - each cloneRoot (absolute) becomes destAbs
 * Never writes cache/clone paths; never leaves cwd-relative ./core.
 */
export function rewriteCommandsInText(
  text: string,
  dest: string,
  opts?: { cloneRoot?: string | string[] },
): string {
  const destAbs = fwdAbs(dest);
  let out = text.split(CLONE_TOKEN).join(destAbs);
  const roots = normalizeCloneRoots(opts && opts.cloneRoot);
  roots.sort(function (a, b) { return b.length - a.length; });
  for (const root of roots) {
    if (!root) continue;
    out = replaceAbsPrefix(out, root, destAbs);
  }
  return out;
}

function normalizeCloneRoots(cloneRoot?: string | string[]): string[] {
  if (!cloneRoot) return [];
  const list = Array.isArray(cloneRoot) ? cloneRoot : [cloneRoot];
  return list.map(function (r) { return fwdAbs(r); }).filter(Boolean);
}

function replaceAbsPrefix(text: string, fromAbs: string, toAbs: string): string {
  if (!fromAbs || fromAbs === toAbs) return text;
  const fromFwd = fromAbs;
  const fromBack = fromAbs.replace(/\//g, "\\");
  const flags = process.platform === "win32" ? "gi" : "g";
  const esc = function (s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
  let out = text.replace(new RegExp(esc(fromFwd), flags), toAbs);
  if (fromBack !== fromFwd) {
    out = out.replace(new RegExp(esc(fromBack), flags), toAbs);
  }
  return out;
}

/** Copy core/src into dest/core/src plus minimal neighbors (package.json). */
export function vendorCoreSrc(repoRoot: string, dest: string): VendorResult {
  const repo = path.resolve(repoRoot);
  const destRoot = path.resolve(dest);
  const srcCore = path.join(repo, "core", "src");
  const dstCore = path.join(destRoot, "core", "src");
  if (!fs.existsSync(srcCore) || !fs.statSync(srcCore).isDirectory()) {
    throw new Error("vendorCoreSrc: missing core/src at " + srcCore);
  }
  fs.mkdirSync(path.dirname(dstCore), { recursive: true });
  fs.cpSync(srcCore, dstCore, { recursive: true, force: true });
  const neighbors: string[] = [];
  for (const name of CORE_NEIGHBORS) {
    const from = path.join(repo, "core", name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(destRoot, "core", name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    neighbors.push(name);
  }
  return {
    destCoreSrc: fwdAbs(dstCore),
    copiedFiles: countFiles(dstCore),
    neighbors: neighbors,
  };
}

function countFiles(dir: string): number {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += countFiles(p);
    else if (ent.isFile()) n += 1;
  }
  return n;
}

const IMPORT_EXTS: Record<string, true> = {
  ".ts": true, ".mts": true, ".cts": true,
  ".js": true, ".mjs": true, ".cjs": true,
};

/** Walk under and rewrite file-relative core imports in place. */
export function rewriteImportsUnder(under: string, dest: string): RewriteResult {
  const root = path.resolve(under);
  const destRoot = path.resolve(dest);
  const changed: string[] = [];
  let scanned = 0;
  walk(root, function (file) {
    if (!IMPORT_EXTS[path.extname(file).toLowerCase()]) return;
    scanned += 1;
    const raw = fs.readFileSync(file, "utf8");
    if (!/(?:\.\.\/)+core\/src\//.test(raw)) return;
    const next = rewriteImportsInText(raw, file, destRoot);
    if (next !== raw) {
      const st = fs.statSync(file);
      fs.writeFileSync(file, next, "utf8");
      try { fs.utimesSync(file, st.atime, st.mtime); } catch (_e) { /* ignore */ }
      changed.push(file);
    }
  });
  return { filesScanned: scanned, filesChanged: changed.length, paths: changed };
}

/** Rewrite command-string files in place. */
export function rewriteCommandFiles(
  files: string[],
  dest: string,
  opts?: { cloneRoot?: string | string[] },
): RewriteResult {
  const destRoot = path.resolve(dest);
  const changed: string[] = [];
  let scanned = 0;
  for (const f of files) {
    const file = path.resolve(f);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error("rewriteCommandFiles: missing file " + file);
    }
    scanned += 1;
    const raw = fs.readFileSync(file, "utf8");
    const next = rewriteCommandsInText(raw, destRoot, opts);
    if (next !== raw) {
      fs.writeFileSync(file, next, "utf8");
      changed.push(file);
    }
  }
  return { filesScanned: scanned, filesChanged: changed.length, paths: changed };
}

function walk(dir: string, fn: (file: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, fn);
    else if (ent.isFile()) fn(p);
  }
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function argsAll(name: string, argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[++i]);
  }
  return out;
}

function usage(): never {
  console.error([
    "usage:",
    "  node tools/install-runtime.ts vendor --repo <repo> --dest <dest>",
    "  node tools/install-runtime.ts rewrite-imports --dest <dest> --under <dir> [--under ...]",
    "  node tools/install-runtime.ts rewrite-commands --dest <dest> --file <path> [--file ...] [--clone-root <path>]",
    "  node tools/install-runtime.ts smoke",
  ].join(String.fromCharCode(10)));
  process.exit(2);
}

function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export function runSmoke(): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const fail = function (m: string) { lines.push("FAIL  " + m); };
  const pass = function (m: string) { lines.push("  ok  " + m); };
  const repo = defaultRepoRoot();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwf-install-runtime-"));
  const dest = path.join(tmp, "dest");
  const fakeClone = path.join(tmp, "home", ".aiworkflow");
  fs.mkdirSync(fakeClone, { recursive: true });
  let allOk = true;
  const check = function (name: string, cond: boolean, detail?: unknown) {
    if (cond) pass(name);
    else {
      allOk = false;
      fail(name + (detail !== undefined ? " got=" + JSON.stringify(detail) : ""));
    }
  };
  try {
    const v = vendorCoreSrc(repo, dest);
    check("vendor wrote dest/core/src", fs.existsSync(path.join(dest, "core", "src")));
    check("vendor copied files", v.copiedFiles > 0, v.copiedFiles);
    check("vendor neighbor package.json", fs.existsSync(path.join(dest, "core", "package.json")));
    check("sample core entry present", fs.existsSync(path.join(dest, "core", "src", "shim", "command-hook.ts")));

    const libDir = path.join(dest, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const sampleTs = path.join(libDir, "sample.ts");
    const sampleBody = [
      "import { x } from \"../../../core/src/shim/command-hook.ts\";",
      "import { y } from \"../lib/neighbor.ts\";",
      "// clone-leak: " + fwdAbs(fakeClone) + "/core/src/rails/cli.ts",
      "",
    ].join(String.fromCharCode(10));
    fs.writeFileSync(sampleTs, sampleBody, "utf8");

    const deepDir = path.join(dest, "tools", "_lib");
    fs.mkdirSync(deepDir, { recursive: true });
    const deepTs = path.join(deepDir, "deep.ts");
    fs.writeFileSync(
      deepTs,
      "export { gateLint } from \"../../../../core/src/design/gate-lint.ts\";" + String.fromCharCode(10),
      "utf8",
    );

    const ri = rewriteImportsUnder(dest, dest);
    check("rewrite-imports changed >=2 files", ri.filesChanged >= 2, ri);
    const libAfter = fs.readFileSync(sampleTs, "utf8");
    const deepAfter = fs.readFileSync(deepTs, "utf8");
    check("lib import is ../core/src/", /from "\.\.\/core\/src\/shim\/command-hook\.ts"/.test(libAfter), libAfter);
    check("neighbor ../lib not rewritten", /from "\.\.\/lib\/neighbor\.ts"/.test(libAfter), libAfter);
    check("deep import is ../../core/src/", /from "\.\.\/\.\.\/core\/src\/design\/gate-lint\.ts"/.test(deepAfter), deepAfter);
    check("no leftover wrong-depth ../../../core/src/ in lib", !/from "\.\.\/\.\.\/\.\.\/core\/src\//.test(libAfter), libAfter);

    const hooksPath = path.join(dest, "hooks.json");
    const destAbs = fwdAbs(dest);
    const cloneAbs = fwdAbs(fakeClone);
    const hookBody = [
      "{",
      "  \"command\": \"node \\\"" + CLONE_TOKEN + "/core/src/shim/command-hook.ts\\\" cursor\",",
      "  \"rail\": \"node \\\"" + cloneAbs + "/core/src/rails/cli.ts\\\" commit\",",
      "}",
      "",
    ].join(String.fromCharCode(10));
    fs.writeFileSync(hooksPath, hookBody, "utf8");
    rewriteCommandFiles([hooksPath], dest, { cloneRoot: fakeClone });
    const hookAfter = fs.readFileSync(hooksPath, "utf8");
    check("hook has no <clone> token", hookAfter.indexOf(CLONE_TOKEN) < 0, hookAfter);
    check("hook has no .aiworkflow clone path", hookAfter.toLowerCase().indexOf(".aiworkflow") < 0, hookAfter);
    check(
      "hook abs path is inside dest",
      hookAfter.indexOf(destAbs + "/core/src/shim/command-hook.ts") >= 0 &&
        hookAfter.indexOf(destAbs + "/core/src/rails/cli.ts") >= 0,
      hookAfter,
    );
    check("hook does not use cwd-relative ./core", !/node\s+"\.\/core\//.test(hookAfter), hookAfter);

    check(
      "coreImportPrefix lib",
      coreImportPrefix(path.join(dest, "lib", "x.ts"), dest) === "../core/src/",
      coreImportPrefix(path.join(dest, "lib", "x.ts"), dest),
    );
    check(
      "coreImportPrefix tools/_lib",
      coreImportPrefix(path.join(dest, "tools", "_lib", "x.ts"), dest) === "../../core/src/",
      coreImportPrefix(path.join(dest, "tools", "_lib", "x.ts"), dest),
    );
    check(
      "coreImportPrefix hooks/pre",
      coreImportPrefix(path.join(dest, "hooks", "pre", "x.ts"), dest) === "../../core/src/",
      coreImportPrefix(path.join(dest, "hooks", "pre", "x.ts"), dest),
    );

    const libMid = fs.readFileSync(sampleTs, "utf8");
    rewriteImportsUnder(path.join(dest, "lib"), dest);
    check("import rewrite idempotent", fs.readFileSync(sampleTs, "utf8") === libMid);
    const hookMid = fs.readFileSync(hooksPath, "utf8");
    rewriteCommandFiles([hooksPath], dest, { cloneRoot: [fakeClone, dest] });
    check("command rewrite idempotent", fs.readFileSync(hooksPath, "utf8") === hookMid);
  } catch (e) {
    allOk = false;
    const msg = e && (e as Error).message ? (e as Error).message : String(e);
    lines.push("FAIL  exception: " + msg);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  lines.push(allOk ? (String.fromCharCode(10) + "ALL GREEN") : (String.fromCharCode(10) + "SMOKE FAILED"));
  return { ok: allOk, lines: lines };
}

function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage();
  if (cmd === "smoke") {
    const r = runSmoke();
    for (const line of r.lines) console.log(line);
    return r.ok ? 0 : 1;
  }
  if (cmd === "vendor") {
    const repo = arg("--repo", argv) || defaultRepoRoot();
    const dest = arg("--dest", argv);
    if (!dest) usage();
    const r = vendorCoreSrc(repo, dest as string);
    console.log(
      "[vendor] " + r.copiedFiles + " files -> " + r.destCoreSrc +
        (r.neighbors.length ? " (neighbors: " + r.neighbors.join(", ") + ")" : ""),
    );
    return 0;
  }
  if (cmd === "rewrite-imports") {
    const dest = arg("--dest", argv);
    const unders = argsAll("--under", argv);
    if (!dest || !unders.length) usage();
    let total = 0;
    for (const u of unders) {
      const r = rewriteImportsUnder(u, dest as string);
      total += r.filesChanged;
      console.log(
        "[rewrite-imports] under=" + path.resolve(u) +
          " scanned=" + r.filesScanned + " changed=" + r.filesChanged,
      );
    }
    console.log("[rewrite-imports] total changed=" + total);
    return 0;
  }
  if (cmd === "rewrite-commands") {
    const dest = arg("--dest", argv);
    const files = argsAll("--file", argv);
    const cloneRoots = argsAll("--clone-root", argv);
    if (!dest || !files.length) usage();
    const r = rewriteCommandFiles(files, dest as string, {
      cloneRoot: cloneRoots.length ? cloneRoots : undefined,
    });
    console.log(
      "[rewrite-commands] scanned=" + r.filesScanned +
        " changed=" + r.filesChanged + " dest=" + fwdAbs(dest as string),
    );
    return 0;
  }
  usage();
}

const isDirect = (function () {
  try {
    const self = path.resolve(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
    return self === invoked;
  } catch (_e) { return false; }
})();

if (isDirect) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) {
    const msg = e && (e as Error).message ? (e as Error).message : String(e);
    console.error("install-runtime error:", msg);
    process.exit(1);
  }
}
