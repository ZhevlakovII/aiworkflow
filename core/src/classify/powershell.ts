/**
 * PowerShell-tool classifier (T8 H1, contract
 * `.workflow/tasks/t8-status-quo-holes.md`).
 *
 * The CC `PowerShell` tool bypassed the PreToolUse hook entirely (matcher +
 * `runHook` routed only Bash/Write/Edit). This module gives a PowerShell
 * command the SAME verdict an equivalent bash command gets from
 * `classify()`:
 *   1. security-floor — the bash `SECURITY_DENY` patterns (text-level, same
 *      as the Bash surface) PLUS the PS-specific `SECURITY_DENY_POWERSHELL`
 *      (`Remove-Item -Recurse -Force` + aliases/prefixes, `rd /s /q`,
 *      `[IO.Directory]::Delete(p, $true)`).
 *   2. git-mut / branch-delete — `classifyGit` (same rail reach semantics)
 *      over a PS-normalized text (`GIT.EXE`/`"...\git.exe" commit` forms).
 *   3. write-to-protected — BOTH the bash token scan (`isWriteToProtected`,
 *      union token table — "never worse than Bash") AND the PS-native target
 *      extraction below (case-insensitive cmdlets/aliases, `-Path`/
 *      `-LiteralPath`/`-FilePath`/`-Destination` params, `Set-Location`
 *      tracking, `[IO.File]::Write*`).
 *   4. worker allow-lane (`zone.allow` explicit) — PS-native targets ONLY
 *      (the bash word-split extraction would misread PS params/values, e.g.
 *      `New-Item -ItemType File x` -> `File` as a target -> false deny).
 *
 * PS-native parsing is a best-effort lexer, NOT a PowerShell parser.
 * Direction on ambiguity is conservative (an unresolvable target text — a
 * `$var`, a `(subexpression)` — is kept as literal text, which never matches
 * a `zone.allow` glob -> worker deny). Unrecognized forms fall back to the
 * Bash-equivalent verdict (step 3's bash scan), never better-than-nothing.
 *
 * Type-strip-safe, zero external deps.
 */
import type { ResolvedPolicy } from "../policy/policy.ts";
import { matchSecurityFloor } from "./security-floor.ts";
import { classifyGit, type Verdict } from "./git.ts";
import { isWriteToProtected, extractWriteTargets, pathSetRegex } from "./zone.ts";
import { normalizePath, pathMatches, globToRegExp } from "./path-zone.ts";
import { resolveProtectedSet, type Actor, type ZoneOptions } from "./classify.ts";
import { SECURITY_DENY_POWERSHELL } from "./rules.ts";

export interface ClassifyPowerShellOptions {
  policy: ResolvedPolicy;
  /** Fail-closed: omitted -> `"worker"` (same as `classify()`). */
  actor?: Actor;
  zone?: ZoneOptions;
  repoRoot?: string;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export interface PsWord {
  /** Unquoted text (quotes removed, backtick escapes resolved). */
  text: string;
  /** `text` split at UNQUOTED commas (PS array-argument syntax `a,b`). */
  pieces: string[];
  quoted: boolean;
}

export interface PsStatement {
  words: PsWord[];
  /** File targets of `>`/`>>`/`N>`/`*>` redirects (stream merges `2>&1` excluded). */
  redirects: PsWord[];
  /** Nested `(...)`/`{...}`/`$(...)`/`@(...)`/`"$(...)"` bodies, each parsed as its own statement list. */
  children: PsStatement[][];
}

/** Index after the closing `'` of a single-quoted string starting at `i` (`''` = escaped quote), or -1 if unterminated. */
function skipSingle(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "'") {
      if (src[j + 1] === "'") {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return -1;
}

/** Index after the closing `"` of a double-quoted string starting at `i` (backtick escapes, `""`, nested `$(...)`), or -1. */
function skipDouble(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "`") {
      j += 2;
      continue;
    }
    if (c === '"') {
      if (src[j + 1] === '"') {
        j += 2;
        continue;
      }
      return j + 1;
    }
    if (c === "$" && src[j + 1] === "(") {
      j = readGroup(src, j + 1).end;
      continue;
    }
    j += 1;
  }
  return -1;
}

/**
 * Balanced `(`/`{` group starting at `start` (quote-aware). Unterminated ->
 * the whole rest is the content (fail-closed: it still gets classified).
 */
function readGroup(src: string, start: number): { content: string; end: number } {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const e = skipSingle(src, i);
      i = e < 0 ? i + 1 : e;
      continue;
    }
    if (c === '"') {
      const e = skipDouble(src, i);
      i = e < 0 ? i + 1 : e;
      continue;
    }
    if (c === "`") {
      i += 2;
      continue;
    }
    if (c === "(" || c === "{") depth += 1;
    else if (c === ")" || c === "}") {
      depth -= 1;
      if (depth === 0) return { content: src.slice(start + 1, i), end: i + 1 };
    }
    i += 1;
  }
  return { content: src.slice(start + 1), end: src.length };
}

/** Every `$(...)` subexpression inside an expandable (double-quoted) string body — those execute. */
function subexpressions(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] === "`") {
      i += 2;
      continue;
    }
    if (body[i] === "$" && body[i + 1] === "(") {
      const g = readGroup(body, i + 1);
      out.push(g.content);
      i = g.end;
      continue;
    }
    i += 1;
  }
  return out;
}

function unescapeDouble(raw: string): string {
  return raw.replace(/``/g, "\u0000").replace(/`(.)/g, "$1").replace(/\u0000/g, "`").replace(/""/g, '"');
}

interface WordBuf {
  text: string;
  piece: string;
  pieces: string[];
  quoted: boolean;
}

/**
 * Split a PowerShell script into statements (`;`, newline, `|`, `&&`, `||`,
 * trailing `&`), words, redirects and nested groups.
 *
 * Fail-closed on ambiguity: an unterminated quote/here-string is NOT treated
 * as a string — its opening char becomes a literal and lexing continues
 * unquoted (an operator can never be hidden by a quote that never closes).
 * `#` comments are deliberately NOT recognized (text after `#` is still
 * classified — at worst a false deny, never a hidden write).
 */
export function parseScript(src: string): PsStatement[] {
  const out: PsStatement[] = [];
  let st: PsStatement = { words: [], redirects: [], children: [] };
  let w: WordBuf | null = null;
  let pendingRedirect = false;

  const finishWord = (): void => {
    if (!w) return;
    const word: PsWord = { text: w.text, pieces: [...w.pieces, w.piece], quoted: w.quoted };
    if (pendingRedirect) {
      st.redirects.push(word);
      pendingRedirect = false;
    } else {
      st.words.push(word);
    }
    w = null;
  };
  const finishStmt = (): void => {
    finishWord();
    pendingRedirect = false;
    if (st.words.length > 0 || st.redirects.length > 0 || st.children.length > 0) out.push(st);
    st = { words: [], redirects: [], children: [] };
  };
  const buf = (): WordBuf => {
    if (!w) w = { text: "", piece: "", pieces: [], quoted: false };
    return w;
  };
  const append = (s: string): void => {
    const b = buf();
    b.text += s;
    b.piece += s;
  };

  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i] as string;

    if (c === "`") {
      if (src[i + 1] === "\n") {
        finishWord();
        i += 2;
        continue;
      }
      if (src[i + 1] === "\r" && src[i + 2] === "\n") {
        finishWord();
        i += 3;
        continue;
      }
      if (i + 1 < n) append(src[i + 1] as string);
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") {
      finishWord();
      i += 1;
      continue;
    }
    if (c === "\r" || c === "\n" || c === ";") {
      finishStmt();
      i += 1;
      continue;
    }
    if (c === "|") {
      finishStmt();
      i += src[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === "&") {
        finishStmt();
        i += 2;
        continue;
      }
      // Call operator at statement start (`& git ...`, `& "C:\x.exe"`) — not a separator.
      if (w === null && st.words.length === 0 && !pendingRedirect) {
        i += 1;
        continue;
      }
      finishStmt(); // trailing background operator
      i += 1;
      continue;
    }
    if (c === ">") {
      const cur = w as WordBuf | null;
      if (cur && !cur.quoted && cur.pieces.length === 0 && /^[1-6*]$/.test(cur.text)) {
        w = null; // stream prefix of `2>` / `*>` — part of the operator, not a word
      } else {
        finishWord();
      }
      i += 1;
      if (src[i] === ">") i += 1;
      if (src[i] === "&" && /[1-6]/.test(src[i + 1] ?? "")) {
        i += 2; // stream merge (`2>&1`) — no file target
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    if (c === "@" && (src[i + 1] === "'" || src[i + 1] === '"') && /^[ \t]*\r?\n/.test(src.slice(i + 2))) {
      const q = src[i + 1];
      const bodyStart = i + 2;
      const rest = src.slice(bodyStart);
      const m = (q === "'" ? /\r?\n'@/ : /\r?\n"@/).exec(rest);
      if (m) {
        const body = rest.slice(0, m.index);
        if (q === '"') for (const sub of subexpressions(body)) st.children.push(parseScript(sub));
        append(body);
        buf().quoted = true;
        i = bodyStart + m.index + m[0].length;
        continue;
      }
      // unterminated here-string: fall through, '@' is a literal
    }
    if (c === "'") {
      const e = skipSingle(src, i);
      if (e < 0) {
        append("'");
        i += 1;
        continue;
      }
      append(src.slice(i + 1, e - 1).replace(/''/g, "'"));
      buf().quoted = true;
      i = e;
      continue;
    }
    if (c === '"') {
      const e = skipDouble(src, i);
      if (e < 0) {
        append('"');
        i += 1;
        continue;
      }
      const raw = src.slice(i + 1, e - 1);
      for (const sub of subexpressions(raw)) st.children.push(parseScript(sub));
      append(unescapeDouble(raw));
      buf().quoted = true;
      i = e;
      continue;
    }
    if (c === "(" || c === "{" || ((c === "$" || c === "@") && (src[i + 1] === "(" || src[i + 1] === "{"))) {
      const open = c === "(" || c === "{" ? i : i + 1;
      const g = readGroup(src, open);
      st.children.push(parseScript(g.content));
      append(src.slice(i, g.end));
      i = g.end;
      continue;
    }
    if (c === ",") {
      const b = buf();
      b.text += ",";
      b.pieces.push(b.piece);
      b.piece = "";
      i += 1;
      continue;
    }
    append(c);
    i += 1;
  }
  finishStmt();
  return out;
}

/** Merge `a, b` / `a ,b` (array arguments split by whitespace around the comma) into one word. */
function mergeArrayWords(words: readonly PsWord[]): PsWord[] {
  const out: PsWord[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    const prevOpen = prev !== undefined && prev.pieces.length > 1 && prev.pieces[prev.pieces.length - 1] === "";
    const curOpen = w.pieces.length > 1 && w.pieces[0] === "";
    if (prev && (prevOpen || curOpen)) {
      out[out.length - 1] = {
        text: prev.text + w.text,
        pieces: [...prev.pieces, ...w.pieces].filter((p) => p !== ""),
        quoted: prev.quoted || w.quoted,
      };
      continue;
    }
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cmdlet schemas (write-target binding)
// ---------------------------------------------------------------------------

type ParamKind = "target" | "dest" | "name" | "newname" | "value";
type PosKind = "target" | "skip" | "dest" | "newname";

interface CmdSchema {
  /** Full parameter names (lower-case) -> kind. Unlisted params are SWITCHES (never consume the next word — conservative). */
  params: Readonly<Record<string, ParamKind>>;
  /** Exact-only parameter aliases (lower-case). */
  aliases?: Readonly<Record<string, ParamKind>>;
  positional: readonly PosKind[];
  restPositional: PosKind;
  /** copy/move: no destination -> current directory is the target. */
  defaultDest?: boolean;
  /** New-Item/mkdir: `-Name` joined onto each `-Path`. */
  joinName?: boolean;
}

const PATH_ALIASES: Readonly<Record<string, ParamKind>> = { pspath: "target", lp: "target" };

const COMMON_VALUED = new Set([
  "erroraction",
  "warningaction",
  "informationaction",
  "progressaction",
  "errorvariable",
  "warningvariable",
  "informationvariable",
  "outvariable",
  "outbuffer",
  "pipelinevariable",
]);
const COMMON_VALUED_ALIASES = new Set(["ea", "wa", "infa", "proga", "ev", "wv", "iv", "ov", "ob", "pv"]);

const CONTENT_SCHEMA: CmdSchema = {
  params: {
    path: "target",
    literalpath: "target",
    value: "value",
    encoding: "value",
    filter: "value",
    include: "value",
    exclude: "value",
    credential: "value",
    stream: "value",
  },
  aliases: PATH_ALIASES,
  positional: ["target", "skip"],
  restPositional: "skip",
};

const CLEAR_CONTENT_SCHEMA: CmdSchema = { ...CONTENT_SCHEMA, positional: ["target"] };

const OUT_FILE_SCHEMA: CmdSchema = {
  params: {
    filepath: "target",
    literalpath: "target",
    path: "target",
    encoding: "value",
    width: "value",
    inputobject: "value",
  },
  aliases: PATH_ALIASES,
  positional: ["target", "skip"],
  restPositional: "skip",
};

const TEE_SCHEMA: CmdSchema = {
  params: {
    filepath: "target",
    literalpath: "target",
    path: "target",
    inputobject: "value",
    variable: "value",
    encoding: "value",
  },
  aliases: PATH_ALIASES,
  positional: ["target"],
  restPositional: "skip",
};

const NEW_ITEM_SCHEMA: CmdSchema = {
  params: {
    path: "target",
    name: "name",
    itemtype: "value",
    value: "value",
    target: "value",
    credential: "value",
  },
  aliases: { ...PATH_ALIASES, type: "value" },
  positional: ["target"],
  restPositional: "target",
  joinName: true,
};

const REMOVE_SCHEMA: CmdSchema = {
  params: {
    path: "target",
    literalpath: "target",
    filter: "value",
    include: "value",
    exclude: "value",
    credential: "value",
    stream: "value",
  },
  aliases: PATH_ALIASES,
  positional: ["target"],
  restPositional: "target",
};

const COPY_SCHEMA: CmdSchema = {
  params: {
    destination: "dest",
    path: "value", // source — read, not written
    literalpath: "value",
    filter: "value",
    include: "value",
    exclude: "value",
    credential: "value",
    tosession: "value",
    fromsession: "value",
  },
  aliases: { pspath: "value", lp: "value" },
  positional: ["skip", "dest"],
  restPositional: "target",
  defaultDest: true,
};

const MOVE_SCHEMA: CmdSchema = {
  params: {
    destination: "dest",
    path: "target", // source is removed -> written
    literalpath: "target",
    filter: "value",
    include: "value",
    exclude: "value",
    credential: "value",
  },
  aliases: PATH_ALIASES,
  positional: ["target", "dest"],
  restPositional: "target",
  defaultDest: true,
};

const RENAME_SCHEMA: CmdSchema = {
  params: {
    path: "target",
    literalpath: "target",
    newname: "newname",
    credential: "value",
  },
  aliases: PATH_ALIASES,
  positional: ["target", "newname"],
  restPositional: "target",
};

const LOCATION_SCHEMA: CmdSchema = {
  params: { path: "target", literalpath: "target", stackname: "value" },
  aliases: PATH_ALIASES,
  positional: ["target"],
  restPositional: "skip",
};

/** Command name (lower-case, basename, `.exe` stripped) -> schema. `exeOk:false` = alias only (a real `x.exe` is a different program). */
const SCHEMAS: Readonly<Record<string, { schema: CmdSchema; exeOk: boolean }>> = {
  "set-content": { schema: CONTENT_SCHEMA, exeOk: false },
  sc: { schema: CONTENT_SCHEMA, exeOk: false },
  "add-content": { schema: CONTENT_SCHEMA, exeOk: false },
  ac: { schema: CONTENT_SCHEMA, exeOk: false },
  "clear-content": { schema: CLEAR_CONTENT_SCHEMA, exeOk: false },
  clc: { schema: CLEAR_CONTENT_SCHEMA, exeOk: false },
  "out-file": { schema: OUT_FILE_SCHEMA, exeOk: false },
  "tee-object": { schema: TEE_SCHEMA, exeOk: false },
  tee: { schema: TEE_SCHEMA, exeOk: false },
  "new-item": { schema: NEW_ITEM_SCHEMA, exeOk: false },
  ni: { schema: NEW_ITEM_SCHEMA, exeOk: false },
  mkdir: { schema: NEW_ITEM_SCHEMA, exeOk: false },
  md: { schema: NEW_ITEM_SCHEMA, exeOk: false },
  "remove-item": { schema: REMOVE_SCHEMA, exeOk: false },
  ri: { schema: REMOVE_SCHEMA, exeOk: false },
  rm: { schema: REMOVE_SCHEMA, exeOk: false },
  rmdir: { schema: REMOVE_SCHEMA, exeOk: false },
  rd: { schema: REMOVE_SCHEMA, exeOk: false },
  del: { schema: REMOVE_SCHEMA, exeOk: false },
  erase: { schema: REMOVE_SCHEMA, exeOk: false },
  "copy-item": { schema: COPY_SCHEMA, exeOk: false },
  cpi: { schema: COPY_SCHEMA, exeOk: false },
  copy: { schema: COPY_SCHEMA, exeOk: false },
  cp: { schema: COPY_SCHEMA, exeOk: false },
  "move-item": { schema: MOVE_SCHEMA, exeOk: false },
  mi: { schema: MOVE_SCHEMA, exeOk: false },
  move: { schema: MOVE_SCHEMA, exeOk: false },
  mv: { schema: MOVE_SCHEMA, exeOk: false },
  "rename-item": { schema: RENAME_SCHEMA, exeOk: false },
  rni: { schema: RENAME_SCHEMA, exeOk: false },
  ren: { schema: RENAME_SCHEMA, exeOk: false },
};

const LOCATION_SET = new Set(["set-location", "sl", "cd", "chdir", "push-location", "pushd"]);
const LOCATION_PUSH = new Set(["push-location", "pushd"]);
const LOCATION_POP = new Set(["pop-location", "popd"]);
/** External posix write-tools reachable from PowerShell (Git-for-Windows etc.) — delegated to the bash extractor. */
const POSIX_EXTERNAL = new Set(["touch", "sed", "dd", "truncate", "install", "ln"]);
const BASH_HOSTS = new Set(["bash", "sh"]);
const PS_HOSTS = new Set(["powershell", "pwsh"]);

function resolveParam(schema: CmdSchema, name: string): ParamKind | "switch" {
  const aliasKind = schema.aliases?.[name];
  if (aliasKind) return aliasKind;
  const kinds: ParamKind[] = [];
  for (const [full, kind] of Object.entries(schema.params)) {
    if (full.startsWith(name)) kinds.push(kind);
  }
  // Ambiguous prefix: prefer the most write-relevant reading (conservative).
  for (const k of ["target", "dest", "newname", "name"] as const) {
    if (kinds.includes(k)) return k;
  }
  if (kinds.includes("value")) return "value";
  if (COMMON_VALUED_ALIASES.has(name)) return "value";
  for (const full of COMMON_VALUED) if (full.startsWith(name)) return "value";
  return "switch";
}

function joinPath(base: string, rel: string): string {
  if (!base) return rel;
  if (!rel) return base;
  return base.replace(/[\\/]+$/, "") + "/" + rel;
}

function dirName(p: string): string {
  const m = /^(.*)[\\/][^\\/]*$/.exec(p);
  return m ? (m[1] as string) : "";
}

function isAbsoluteLike(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p) || p.startsWith("~") || /^[A-Za-z][\w]*:/.test(p);
}

/** Bind a statement's argument words (after the command word) to its write-target texts. */
function bindTargets(schema: CmdSchema, args: readonly PsWord[]): string[] {
  const targets: string[] = [];
  const names: string[] = [];
  const newNames: string[] = [];
  let destSeen = false;
  let pos = 0;
  let endOfParams = false;
  const words = mergeArrayWords(args);

  const apply = (kind: ParamKind | PosKind, values: readonly string[]): void => {
    if (kind === "target") targets.push(...values);
    else if (kind === "dest") {
      destSeen = true;
      targets.push(...values);
    } else if (kind === "name") names.push(...values);
    else if (kind === "newname") newNames.push(...values);
  };

  for (let k = 0; k < words.length; k++) {
    const w = words[k] as PsWord;
    if (!endOfParams && !w.quoted && w.text === "--") {
      endOfParams = true;
      continue;
    }
    const pm = !endOfParams && !w.quoted ? /^-([A-Za-z][\w-]*)(?::([\s\S]*))?$/.exec(w.text) : null;
    if (pm) {
      const kind = resolveParam(schema, (pm[1] as string).toLowerCase());
      if (kind === "switch") continue;
      let values: string[];
      if (pm[2] !== undefined && pm[2] !== "") {
        values = pm[2].split(",");
      } else {
        const next = words[k + 1];
        if (!next) continue;
        k += 1;
        values = next.pieces;
      }
      apply(kind, values);
      continue;
    }
    const posKind = schema.positional[pos] ?? schema.restPositional;
    pos += 1;
    if (posKind !== "skip") apply(posKind, w.pieces);
  }

  let out = [...targets];
  if (schema.joinName && names.length > 0) {
    const bases = targets.length > 0 ? targets : [""];
    out = [];
    for (const b of bases) for (const nm of names) out.push(joinPath(b, nm));
  }
  if (newNames.length > 0) {
    for (const p of targets) for (const nn of newNames) out.push(joinPath(dirName(p), nn));
  }
  if (schema.defaultDest && !destSeen) out.push(".");
  return out.filter((t) => t !== "");
}

// ---------------------------------------------------------------------------
// Target extraction (walk)
// ---------------------------------------------------------------------------

interface WalkCtx {
  cwd: string;
  stack: string[];
}

const UNKNOWN_CWD = "<unknown-cwd>";

function resolveAgainst(ctx: WalkCtx, target: string): string {
  if (!ctx.cwd || isAbsoluteLike(target)) return target;
  return joinPath(ctx.cwd, target);
}

function commandName(word: PsWord): { name: string; exe: boolean } {
  const base = (word.text.split(/[\\/]/).pop() ?? "").toLowerCase();
  const exe = /\.exe$/.test(base);
  return { name: exe ? base.slice(0, -4) : base, exe };
}

function walk(stmts: readonly PsStatement[], ctxIn: WalkCtx, out: string[]): void {
  const ctx: WalkCtx = { cwd: ctxIn.cwd, stack: [...ctxIn.stack] };
  for (const st of stmts) {
    // Nested groups get a COPY of the location state (never leaks back out).
    for (const child of st.children) walk(child, ctx, out);

    for (const r of st.redirects) {
      for (const p of r.pieces) {
        if (p === "" || /^\$null$/i.test(p)) continue;
        out.push(resolveAgainst(ctx, p));
      }
    }

    let words = st.words;
    // `$x = <command> ...` assignment prefix; `. script` dot-source operator.
    if (words.length >= 2 && /^\$[\w:{}]+$/.test(words[0]!.text) && words[1]!.text === "=") words = words.slice(2);
    if (words.length > 0 && !words[0]!.quoted && words[0]!.text === ".") words = words.slice(1);
    if (words.length === 0) continue;

    const { name, exe } = commandName(words[0] as PsWord);
    const args = words.slice(1);

    if (!exe && LOCATION_SET.has(name)) {
      const [dest] = bindTargets(LOCATION_SCHEMA, args);
      if (LOCATION_PUSH.has(name)) ctx.stack.push(ctx.cwd);
      // No argument (PS7: home) / `-` / `+` (history) -> location not statically known.
      if (dest === undefined || dest === "-" || dest === "+") ctx.cwd = UNKNOWN_CWD;
      else ctx.cwd = resolveAgainst(ctx, dest);
      continue;
    }
    if (!exe && LOCATION_POP.has(name)) {
      ctx.cwd = ctx.stack.length > 0 ? (ctx.stack.pop() as string) : UNKNOWN_CWD;
      continue;
    }

    const entry = SCHEMAS[name];
    if (entry && (!exe || entry.exeOk)) {
      for (const t of bindTargets(entry.schema, args)) out.push(resolveAgainst(ctx, t));
      continue;
    }

    if (POSIX_EXTERNAL.has(name)) {
      const text = [name, ...args.map((a) => a.text)].join(" ");
      for (const t of extractWriteTargets(text, "posix")) out.push(resolveAgainst(ctx, t));
      continue;
    }

    if (PS_HOSTS.has(name)) {
      const idx = args.findIndex((a) => !a.quoted && /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i.test(a.text));
      if (idx >= 0) {
        const script = args
          .slice(idx + 1)
          .map((a) => a.text)
          .join(" ");
        walk(parseScript(script), ctx, out);
      }
      continue;
    }

    if (BASH_HOSTS.has(name)) {
      const idx = args.findIndex((a) => !a.quoted && a.text === "-c");
      const script = idx >= 0 ? args[idx + 1] : undefined;
      if (script) for (const t of extractWriteTargets(script.text)) out.push(resolveAgainst(ctx, t));
      continue;
    }
  }
}

const DOTNET_IO_RE = /\[\s*(?:system\s*\.\s*)?io\s*\.\s*(file|directory)\s*\]\s*::\s*(\w+)\s*\(/gi;

/** Split `a, b, (c, d)` at top-level commas (quote/paren-aware). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "'" || c === '"') {
      const e = c === "'" ? skipSingle(s, i) : skipDouble(s, i);
      const end = e < 0 ? s.length : e;
      cur += s.slice(i, end);
      i = end;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth += 1;
    if (c === ")" || c === "}" || c === "]") depth -= 1;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function literalArg(arg: string): string {
  const m = /^'((?:[^']|'')*)'$/.exec(arg);
  if (m) return (m[1] as string).replace(/''/g, "'");
  const d = /^"((?:[^"`]|`.|"")*)"$/.exec(arg);
  if (d) return unescapeDouble(d[1] as string);
  return arg; // variable / expression -> raw text (never matches an allow glob -> conservative)
}

/** `[IO.File]::` Write* | Append* | Create* | Delete | Move | Copy | Replace | OpenWrite + `[IO.Directory]::` CreateDirectory | Delete | Move targets. */
function dotnetTargets(cmd: string): string[] {
  const out: string[] = [];
  DOTNET_IO_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOTNET_IO_RE.exec(cmd)) !== null) {
    const kind = (m[1] as string).toLowerCase();
    const method = (m[2] as string).toLowerCase();
    const g = readGroup(cmd, m.index + m[0].length - 1);
    const args = splitArgs(g.content).map(literalArg);
    let picked: string[] = [];
    if (kind === "file") {
      if (/^(write|append|create)/.test(method) || method === "delete" || method === "openwrite") picked = args.slice(0, 1);
      else if (method === "move" || method === "replace") picked = args.slice(0, method === "move" ? 2 : 3);
      else if (method === "copy") picked = args.slice(1, 2);
    } else {
      if (method === "createdirectory" || method === "delete") picked = args.slice(0, 1);
      else if (method === "move") picked = args.slice(0, 2);
    }
    out.push(...picked.filter((a) => a !== ""));
  }
  return out;
}

/**
 * Every best-effort write-target text of a PowerShell command (raw — not
 * normalized). Relative targets after `Set-Location`/`cd`/`Push-Location`
 * are joined onto the tracked location text.
 */
export function extractPsWriteTargets(cmd: string): string[] {
  const out: string[] = [];
  walk(parseScript(cmd), { cwd: "", stack: [] }, out);
  out.push(...dotnetTargets(cmd));
  return out;
}

/**
 * Contract A (shell SWP/freeze) — redirect file targets only (`>`/`>>`/
 * `N>`/`*>`), excluding stream merges and `$null`. Nested groups included.
 * Does not bind cmdlet `-Path`/`Set-Content` args (those stay on the full
 * `extractPsWriteTargets` path).
 */
export function extractPsRedirectTargets(cmd: string): string[] {
  const out: string[] = [];
  const walkRedirects = (stmts: readonly PsStatement[]): void => {
    for (const st of stmts) {
      for (const child of st.children) walkRedirects(child);
      for (const r of st.redirects) {
        for (const p of r.pieces) {
          if (p === "" || /^\$null$/i.test(p)) continue;
          out.push(p);
        }
      }
    }
  };
  walkRedirects(parseScript(cmd));
  return out;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function matchPsSecurityFloor(cmd: string): string | null {
  for (const rule of SECURITY_DENY_POWERSHELL) {
    if (new RegExp(rule.pattern, rule.flags).test(cmd)) return rule.message;
  }
  return null;
}

/**
 * Resolve PowerShell backtick escapes into a canonical text, for the
 * text-level security-floor/git checks below ONLY (T8-H2 CRITICAL —
 * `` g`it commit `` / `` Remove-I`tem -Recurse -Force `` bypassed those
 * regexes on raw text). Backtick+CRLF/LF (line continuation) -> space;
 * backtick+any other char -> that char. Best-effort / over-detection is
 * fine here — this is not used for target extraction, only pattern match.
 */
function resolveBacktickEscapes(cmd: string): string {
  return cmd.replace(/`\r?\n/g, " ").replace(/`(.)/gs, "$1");
}

/** `GIT.EXE commit`, `& "C:\...\git.exe" commit` -> `git commit` (so `classifyGit` sees the bash-equivalent form). */
function normalizeGitForms(cmd: string): string {
  return cmd.replace(/\bgit(?:\.exe)?['"]?(?=\s)/gi, "git");
}

function expandProtected(entry: string): string[] {
  if (/[*?]/.test(entry)) return [entry];
  const t = entry.replace(/\/+$/, "");
  return [t, t + "/**"];
}

function isProtectedTarget(target: string, protectedSet: readonly string[], repoRoot: string | undefined): boolean {
  if (new RegExp(pathSetRegex(protectedSet), "i").test(" " + target)) return true;
  const norm = normalizePath(target, repoRoot);
  if (norm === null) return false; // outside repo — same as the Bash surface (no repo-boundary concept here)
  const lower = norm.toLowerCase();
  return protectedSet.some((p) => expandProtected(p).some((g) => globToRegExp(g.toLowerCase()).test(lower)));
}

/**
 * Classify a PowerShell-tool command (T8 H1). Same step order and actor/
 * zone semantics as `classify()` (see module doc-comment).
 */
export function classifyPowerShell(cmd: string, options: ClassifyPowerShellOptions): Verdict {
  const { policy, zone } = options;
  const command = cmd ?? "";
  const canonical = resolveBacktickEscapes(command);

  if (policy.security_floor.enabled) {
    const reason =
      matchSecurityFloor(command) ??
      matchPsSecurityFloor(command) ??
      matchSecurityFloor(canonical) ??
      matchPsSecurityFloor(canonical);
    if (reason) return { decision: "deny", reason };
  }

  const gitVerdict =
    classifyGit(normalizeGitForms(command), policy.rail.level) ??
    classifyGit(normalizeGitForms(canonical), policy.rail.level);
  if (gitVerdict) return gitVerdict;

  const actor: Actor = options.actor ?? "worker";
  const protectedSet = resolveProtectedSet(actor, policy, zone);
  let targets: string[];
  try {
    targets = extractPsWriteTargets(command);
  } catch {
    return {
      decision: "deny",
      reason: "zone-guard: PowerShell-команда не разобрана (слишком глубокая вложенность/ошибка парсера) — запрещено.",
    };
  }

  if (protectedSet.length > 0) {
    const bashHit = isWriteToProtected(command, undefined, protectedSet);
    const psHit = targets.find((t) => isProtectedTarget(t, protectedSet, options.repoRoot));
    if (bashHit || psHit !== undefined) {
      return {
        decision: "deny",
        reason: `zone-guard: PowerShell-запись/удаление под ${protectedSet.join("|")} запрещена.`,
      };
    }
  }

  if (actor === "worker" && zone?.allow !== undefined) {
    for (const raw of targets) {
      const norm = normalizePath(raw, options.repoRoot);
      if (norm === null || !pathMatches(norm, zone.allow)) {
        return {
          decision: "deny",
          reason: `zone-guard: PowerShell-запись в '${raw}' вне allow-полосы воркера.`,
        };
      }
    }
  }

  return { decision: "allow" };
}
