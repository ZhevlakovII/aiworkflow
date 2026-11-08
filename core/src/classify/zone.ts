/**
 * Zone / write-to-protected classification (T2b).
 *
 * T7-6 (contract L-4): `tools/policy/intent.py`/`guard-rules.yml` below are a
 * HISTORICAL source — both deleted in T7; this file is the source of truth
 * now (see `./rules.ts` header for the full note).
 *
 * Ported VERBATIM from `tools/policy/intent.py` lines 268-412 (`_token_list`,
 * `_token_regex_piece`, `_path_set_regex`, `_split_segments`,
 * `_resolve_cd_protected`, `_looks_absolute_or_elsewhere`,
 * `_segment_is_protected_write`, `_classify_chain`, `_is_write_to_protected`).
 * Contract L-1: verbatim-логика, NOT "improved" — the conservative-deny
 * behaviour on ambiguity is preserved exactly.
 *
 * ONE structural difference from intent.py, deliberate (contract §Модель):
 * intent.py read `path_set` as a single static global (`guard-rules.yml`
 * `path_set: [.git, .omp]`) baked into `rules`. Here the protected-set is
 * actor-aware and passed in by the caller (classify.ts) per call — worker
 * bash-denylist vs operator `operator_zone.protected` — so every function
 * below takes `protectedSet` as an explicit parameter instead of reading it
 * off a shared rules object. The segment/cd/token/regex machinery itself is
 * unchanged.
 *
 * FIX-3 (security review, preserved verbatim — see intent.py comment above
 * `_split_segments`): a flat "token ... path anywhere in the whole command"
 * scan gave (a) a false-negative — `cd .omp; echo bad > config.yml` doesn't
 * mention `.omp` next to the write token -> was let through; (b) a
 * false-positive — `echo x > out.txt; cat .omp/x` was denied even though the
 * write went to `out.txt`, not `.omp` (which was merely read in the NEXT,
 * unrelated segment). The fix: split into segments (`;` `&&` `||` `|`, with
 * `(...)` as ONE subshell-segment, recursed into), classify each segment
 * separately, and track `cd <path>` between segments of the SAME chain — a
 * subshell gets a COPY of the state and never leaks `cd` back out (bash
 * semantics). A write-token whose target is not PROVABLY outside protected
 * (a relative path under a protected cwd, or a token with no explicit target
 * at all under a protected cwd) is a conservative deny
 * (`intent.unknown_touching_protected: write`, guard-rules.yml).
 *
 * T7-6 (contract L-2, NOT a verbatim-port item — a deliberate, scoped fix
 * over intent.py, same spirit as FIX-1/2/3 above): `>`/`>>` matching
 * (`segmentIsProtectedWrite` + `extractWriteTargets`'s `matchToken`) is
 * quote/escape-aware — bash semantics, a `>` inside `'...'`/`"..."` or
 * preceded by an unquoted `\` is a literal character, never a redirect
 * operator. Scoped narrowly to `>`/`>>` alone.
 *
 * T7-9 (contract `.workflow/tasks/t7-9-hook-false-denies.md`, L-2 — amends
 * the T7-6 paragraph above): a WORD token (`rm`/`sed -i`/`install`/
 * `Remove-Item`/...) is now recognized only (a) at the segment's actual
 * command-word position (`skipCommandPrefix` — start of segment, past any
 * `VAR=val` env-assignments / `sudo`/`command` prefixes), or (b) inside an
 * unquoted-mask-false (i.e. QUOTED) region — case (b) is exactly what keeps
 * corpus.json's `powershell -Command "Remove-Item ..."` fixture matching (a
 * word token nested inside a quoted embedded-script argument is still a
 * real command word, just one level down). What's NEW is everything in
 * between: a token occurring unquoted mid-segment as a bare substring of a
 * path/argument (`tools/install.sh`, `grep x tools/install.sh`) no longer
 * matches — that was the T7-9 false-deny bug (symptom 2, coreutils `install`
 * mistaken for a write-command because it's also a path-segment name).
 * `>`/`>>` are unaffected (redirects legitimately appear anywhere in a
 * segment, not just at the command-word slot) — `matchToken` still routes
 * them straight to `findUnquotedRedirect`, unchanged.
 *
 * T7-9 L-1 (module-level, `maskHeredocs`, called once by `classify.ts`
 * before ANY classifier runs — security-floor/git-mut/zone all see the
 * masked text): a heredoc body (`<<WORD`, `<<'WORD'`, `<<"WORD'`, `<<-WORD`,
 * up to its terminator line) is classified as COMMANDS (fail-closed, left
 * untouched) by DEFAULT. It is masked to DATA ONLY when ALL three hold
 * (lead amendment over the original L-1 draft, which used an interpreter
 * DENYLIST — see the security-regression note below):
 *  (a) the heredoc's consumer command word (basename, `.exe`-stripped,
 *      lower-cased) is a known pure DATA-SINK (`DATA_SINK_WORDS`: `cat`,
 *      `tee`, `grep`/`egrep`/`fgrep`/`rg`, `wc`, `sort`, `uniq`, `head`,
 *      `tail`, `cut`, `tr`, `base64`, `diff`, `cmp`, `jq`, `less`, `more`) —
 *      NOT `awk`/`sed`/`xargs`/`read`/`while`/any shell builtin or compound
 *      keyword.
 *  (b) the heredoc is not attached to (or nested inside) a compound/loop
 *      construct on the same logical command (`while`/`until`/`for`/`if`/
 *      `then`/`elif`/`else`/`do`/`done`/`fi`/`{`/`}`/`(`/`)`) — in
 *      particular, not a redirect target of a construct closer (`done`/
 *      `}`/`)`).
 *  (c) every OTHER stage of the SAME pipeline (`|`, `|&`) also resolves to a
 *      data-sink command word from the same list.
 * In every other case (unknown/non-sink consumer, compound-construct
 * attachment, a non-sink sibling pipeline stage, or an unterminated
 * heredoc) — DO NOT mask; the body stays classified as commands.
 *
 * Security-regression note (why this replaced an interpreter DENYLIST): a
 * denylist ("mask unless consumer is bash/sh/node/...") silently treats any
 * UNLISTED consumer as an inert data sink — `xargs`, `awk`, and a bare
 * compound-construct closer (`done`, `}`) all fell through to "mask" even
 * though each can make the heredoc body's TEXT become executed commands
 * (`xargs cmd <<EOF` runs `cmd` with the body's lines as arguments; a
 * `while ... done <<EOF` loop's `read`/`$var` body consumes the heredoc line
 * by line as data it then executes; `{ cat; } <<EOF` closes on `}`, not
 * `cat`). The allowlist above only masks a heredoc whose consumer (and every
 * sibling pipeline stage) is PROVABLY inert — everything else, including
 * anything not on the short data-sink list, is conservatively fail-closed.
 */
import { TOKEN_TABLES } from "./rules.ts";

export type Shell = "posix" | "powershell";

/**
 * Regex-escape a literal string for embedding into a larger pattern.
 * Equivalent to Python's `re.escape` for these inputs (a leading backslash
 * before a non-special character, e.g. an escaped hyphen, is a harmless
 * no-op in both engines outside a character class).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip any run of `"`/`'` characters off both ends — port of Python's
 * `str.strip("\"'")`, which removes ANY combination of those characters from
 * both ends (not a matching-pair check).
 */
function stripQuotes(s: string): string {
  return s.replace(/^["']+/, "").replace(/["']+$/, "");
}

/**
 * Port of `_token_list` (intent.py:268). `shell` in {"posix","powershell"} ->
 * that table verbatim. Otherwise (shell_unknown, guard-rules.yml
 * `intent.shell_unknown: union`) -> union of both tables, de-duplicated,
 * order preserved (posix entries first).
 */
export function tokenList(shell?: Shell): readonly string[] {
  if (shell === "posix" || shell === "powershell") {
    return TOKEN_TABLES[shell];
  }
  const seen: string[] = [];
  for (const t of [...TOKEN_TABLES.posix, ...TOKEN_TABLES.powershell]) {
    if (!seen.includes(t)) seen.push(t);
  }
  return seen;
}

/**
 * Port of `_token_regex_piece` (intent.py:283). Symbol tokens (`>`, `>>`) —
 * no `\b` (they have no word-char boundaries). Word tokens — `\b`-wrapped,
 * internal spaces become `\s+` (so `"sed -i"` matches `sed   -i`).
 */
export function tokenRegexPiece(tok: string): string {
  if (/^[^\w\s]+$/.test(tok)) {
    return escapeRegExp(tok);
  }
  const parts = tok.split(" ");
  const body = parts.map(escapeRegExp).join(String.raw`\s+`);
  return String.raw`\b` + body + String.raw`\b`;
}

/**
 * Port of `_path_set_regex` (intent.py:292). Requires a "boundary" before the
 * protected-path alternation (start / whitespace / quote / `=:/\`) and after
 * (path separator, end, or word boundary) — so `.gitfoo` does not match
 * `.git`.
 */
export function pathSetRegex(protectedSet: readonly string[]): string {
  const alt = protectedSet.map(escapeRegExp).join("|");
  return String.raw`(?:^|[\s"'=:/\\])(?:` + alt + String.raw`)(?:[/\\]|$|\b)`;
}

// Port of `_SEP_RE` / `_CD_RE` (intent.py:312-313). `_SEP_RE.match(cmd, i)` in
// Python anchors the match AT position `i` (not a search from `i`) — ported
// here as "does the substring starting at i begin with a separator", via an
// explicit `^`-anchored regex tested against `cmd.slice(i)` (contract L-3,
// anchor-semantics must be preserved exactly).
//
// FIX-2 (security-review, minor — DELIBERATE improvement over intent.py, not
// a verbatim port): the original `_SEP_RE` (`&&|\|\||;|\|`) does NOT include
// bare `&` (background-job operator) or a literal newline — both are
// top-level shell command separators too. That gap let `cd .omp & echo bad >
// x` and `cd .omp\necho bad > x` slip past segmentation entirely (treated as
// ONE segment containing a `cd` token that `_CD_RE`/`CD_RE` doesn't match at
// the start, so the write after `&`/newline was never scanned against
// cwd_protected — a real cd-RCE bypass). Fixed here by adding bare `&` and
// `\r?\n` to the alternation. Alternation ORDER matters: `&&` MUST precede
// bare `&`, and `\|\|` MUST precede bare `\|` (regex alternation is
// leftmost-first, not longest-match — if `&` were listed before `&&`, input
// `&&` would be mis-split into two single-`&` separators with an empty
// segment between). This is a pre-existing intent.py separator-gap that the
// TS port closes; documented (not silently ported as a bug) per ledger
// «security-review fixes (FIX-1/2/3)».
const SEP_RE = /^(?:&&|\|\||;|\||&|\r?\n)/;
const CD_RE = /^cd\s+(\S+)/;

function matchSeparatorAt(cmd: string, i: number): string | null {
  const m = SEP_RE.exec(cmd.slice(i));
  return m ? m[0] : null;
}

/**
 * Port of `_split_segments` (intent.py:316). `;`/`&&`/`||`/`|` are top-level
 * separators; `(...)` is ONE segment (subshell), not split on this pass —
 * `_classify_chain` recurses into it.
 *
 * Amend A1 (lead-review, contract, security regression fix): quote-aware
 * separator matching — a separator character sitting INSIDE `'...'`/`"..."`
 * (or escaped, e.g. `\;`) is a literal character, never a real top-level
 * separator (bash semantics), reusing the SAME `unquotedMask` scan (incl.
 * its fail-closed unterminated-quote handling) `matchToken`/
 * `findUnquotedRedirect` use for `>`/`>>`. Regression this closes: splitting
 * BLINDLY on a `;`/`&&`/... byte that's actually inside quotes used to tear
 * a quoted string in half across two segments — the tail segment then began
 * mid-string with an orphan closing quote char, which the (quote-blind at
 * the time) per-segment redirect scan misread as a FRESH quote-OPEN,
 * masking the real `>`/`>>` that followed it as "quoted" -> false ALLOW
 * (e.g. `echo "a;b" > .git/x`). Paren-depth tracking (`(`/`)`) is
 * DELIBERATELY left quote-blind, unchanged from before (out of Amend A1's
 * scope; no corpus/contract evidence of a paren-in-quotes issue).
 */
export function splitSegments(cmd: string): string[] {
  const segments: string[] = [];
  const mask = unquotedMask(cmd);
  let buf = "";
  let depth = 0;
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (c === "(") {
      depth += 1;
      buf += c;
      i += 1;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      buf += c;
      i += 1;
      continue;
    }
    if (depth === 0 && mask[i]) {
      const sep = matchSeparatorAt(cmd, i);
      if (sep !== null) {
        segments.push(buf);
        buf = "";
        i += sep.length;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  if (buf) segments.push(buf);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Port of `_resolve_cd_protected` (intent.py:350). `cd -`/`cd ~`/empty ->
 * not-protected (can't resolve without real cwd tracking — conservative
 * false here matches intent.py, not a security regression: the write-check
 * itself stays conservative on ambiguous relative targets).
 */
export function resolveCdProtected(target: string, protectedSet: readonly string[]): boolean {
  const t = stripQuotes(target.trim());
  if (!t || t === "-" || t === "~") return false;
  for (const p of protectedSet) {
    if (t === p || t.startsWith(p + "/") || t.startsWith(p + "\\")) return true;
  }
  return false;
}

/**
 * Port of `_looks_absolute_or_elsewhere` (intent.py:360). The ONLY way a
 * write-target is provably OUTSIDE a protected cwd: it's explicitly
 * absolute (posix `/...`, home `~...`, windows drive `C:\...`, or a UNC
 * `\\...` path).
 */
export function looksAbsoluteOrElsewhere(tgt: string): boolean {
  return (
    tgt.startsWith("/") ||
    tgt.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(tgt) ||
    tgt.startsWith("\\\\")
  );
}

/**
 * Per-character "unquoted" mask (contract L-2, T7-6) — `true` at positions
 * NOT inside `'...'`/`"..."` and not themselves an escaped-away character;
 * `false` inside quotes (incl. the quote chars) and for a backslash + the
 * character it escapes (outside quotes: bash lets `\` escape the very next
 * char outright; inside double quotes: only `\$` `` \` `` `\"` `\\` are
 * real escapes — anything else inside double quotes is already non-operator
 * by virtue of being quoted, `\"` handling here exists only so an escaped
 * quote doesn't prematurely end the tracked double-quoted region).
 *
 * Amend A1 (lead-review, contract, security regression fix): FAIL-CLOSED on
 * an UNTERMINATED quote — if `segment` ends while still inside a quote (no
 * closing `'`/`"` found), the entire unterminated tail (from that quote's
 * OPENING char to end-of-string) is un-masked back to `true` (treated as
 * UNQUOTED) instead of staying masked-out. Ambiguous-quoting must never
 * HIDE a real operator character from redirect-detection — only a
 * PROVABLY-closed quote may mask.
 */
function unquotedMask(segment: string): boolean[] {
  const mask = new Array<boolean>(segment.length).fill(true);
  let quote: "" | "'" | '"' = "";
  let quoteStart = -1;
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (quote === "'") {
      mask[i] = false;
      if (c === "'") quote = "";
      i += 1;
      continue;
    }
    if (quote === '"') {
      mask[i] = false;
      if (c === "\\" && i + 1 < segment.length && '$`"\\'.includes(segment[i + 1])) {
        mask[i + 1] = false;
        i += 2;
        continue;
      }
      if (c === '"') quote = "";
      i += 1;
      continue;
    }
    // unquoted
    if (c === "\\" && i + 1 < segment.length) {
      mask[i] = false;
      mask[i + 1] = false; // escaped char is a literal, never an operator
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      mask[i] = false; // the opening quote char itself
      quote = c;
      quoteStart = i;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (quote !== "" && quoteStart >= 0) {
    // Unterminated quote (fail-closed, Amend A1): un-mask the whole
    // ambiguous tail back to unquoted.
    for (let k = quoteStart; k < mask.length; k++) mask[k] = true;
  }
  return mask;
}

/**
 * First UNQUOTED, UNESCAPED `>`/`>>` redirect-operator match in `segment`
 * (contract L-2, T7-6) — bash semantics: a quoted (`'...'`/`"..."`) or
 * backslash-escaped `>` is a literal character, never a redirect. Mirrors
 * the single-char-vs-two-char match shape `tokenRegexPiece`/`RegExp.exec`
 * would have produced for the SAME unquoted `>`/`>>` text (e.g. `op=">"`
 * still matches just the first `>` char even when it's the start of an
 * unquoted `>>`, same as the old flat-regex scan did) — ONLY the
 * quote/escape filter is new, nothing else about the match shape changes.
 */
function findUnquotedRedirect(segment: string, op: ">" | ">>"): { index: number; length: number } | null {
  const mask = unquotedMask(segment);
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] !== ">" || !mask[i]) continue;
    if (op === ">>") {
      if (segment[i + 1] === ">" && mask[i + 1]) return { index: i, length: 2 };
      continue;
    }
    return { index: i, length: 1 };
  }
  return null;
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const PREFIX_CMD_RE = /^(?:sudo|command)\s+/;

/**
 * Command-word START offset within `s` (T7-9, contract L-2) — skips leading
 * whitespace, then repeated `VAR=val ` env-assignments and `sudo`/`command`
 * prefixes, landing on the offset bash itself would treat as "the command".
 * Reused for two purposes: restricting WORD-token write-matching to the
 * actual command-word slot (`matchToken`), and resolving a heredoc's
 * consumer command (`commandWordBefore` -> `maskHeredocs`).
 */
function skipCommandPrefix(s: string): number {
  let off = 0;
  const lead = /^\s+/.exec(s);
  if (lead) off += lead[0].length;
  for (;;) {
    const rest = s.slice(off);
    const env = ENV_ASSIGN_RE.exec(rest);
    if (env) {
      off += env[0].length;
      continue;
    }
    const pre = PREFIX_CMD_RE.exec(rest);
    if (pre) {
      off += pre[0].length;
      continue;
    }
    break;
  }
  return off;
}

/**
 * Token match dispatch (contract L-2, T7-6/T7-9): `>`/`>>` go through the
 * quote/escape-aware `findUnquotedRedirect`, unrestricted position (a
 * redirect legitimately appears anywhere in a segment). Every other (WORD)
 * token must occur EITHER at the segment's own command-word position
 * (`cmdWordStart`, T7-9 L-2) OR inside a quoted region (`mask[idx] ===
 * false`) — preserves corpus.json's `powershell -Command "Remove-Item ..."`
 * (a word token nested inside a quoted embedded-script argument is still a
 * real command word one level down) while rejecting a bare unquoted
 * substring match inside a path/argument (`tools/install.sh`, T7-9 symptom
 * 2). Scans ALL occurrences (not just the first) so an early invalid
 * (bare-substring) hit doesn't hide a later valid (quoted or command-word)
 * one — conservative-deny direction, never under-detects.
 */
function matchToken(
  segment: string,
  tok: string,
  cmdWordStart: number,
  mask: readonly boolean[]
): { index: number; length: number } | null {
  if (tok === ">" || tok === ">>") return findUnquotedRedirect(segment, tok);
  const tokRe = new RegExp(tokenRegexPiece(tok), "g");
  let m: RegExpExecArray | null;
  while ((m = tokRe.exec(segment)) !== null) {
    const idx = m.index;
    if (idx === cmdWordStart || mask[idx] === false) {
      return { index: idx, length: m[0].length };
    }
    if (tokRe.lastIndex === idx) tokRe.lastIndex += 1; // safety: never spin on a zero-length match
  }
  return null;
}

/**
 * Port of `_segment_is_protected_write` (intent.py:370). For each write
 * token found in the segment: a direct mention of a protected path after the
 * token -> write. Otherwise, only if the cwd is (tracked as) protected: a
 * relative target that is not provably elsewhere -> write (conservative
 * deny); a token with no explicit target at all under a protected cwd ->
 * write too (`intent.unknown_touching_protected: write`).
 *
 * T7-6 (contract L-2): `>`/`>>` matching is quote-aware (`matchToken` ->
 * `findUnquotedRedirect`) — a quoted/escaped `>` is a literal char, not a
 * redirect.
 *
 * T7-9 (contract L-2): every other (WORD) token is now restricted to the
 * segment's command-word position or a quoted region (`matchToken` ->
 * `cmdWordStart`/`mask`, computed once here and reused across the token loop).
 */
export function segmentIsProtectedWrite(
  segment: string,
  tokens: readonly string[],
  pathPiece: string,
  cwdProtected: boolean
): boolean {
  const pathRe = new RegExp(pathPiece);
  const mask = unquotedMask(segment);
  const cmdWordStart = skipCommandPrefix(segment);
  for (const tok of tokens) {
    const m = matchToken(segment, tok, cmdWordStart, mask);
    if (!m) continue;
    const tail = segment.slice(m.index + m.length);
    if (pathRe.test(tail)) return true; // direct mention of protected path after the token
    if (!cwdProtected) continue;
    // relative write under a protected cwd — provably outside protected?
    const argM = /\S+/.exec(tail);
    if (!argM) return true; // token with no explicit target under protected cwd -> unknown -> write
    const tgt = stripQuotes(argM[0]);
    if (!looksAbsoluteOrElsewhere(tgt)) return true;
  }
  return false;
}

/**
 * Port of `_classify_chain` (intent.py:392). Walks segments of `cmd`,
 * tracking `cd`-induced protected-cwd state across segments of the SAME
 * chain. `(...)` subshells recurse with a COPY of the current state — `cd`
 * inside a subshell never leaks back out (bash semantics; FIX-3
 * subshell-isolation).
 */
export function classifyChain(
  cmd: string,
  shell: Shell | undefined,
  protectedSet: readonly string[],
  cwdProtected: boolean
): boolean {
  const tokens = tokenList(shell);
  const pathPiece = pathSetRegex(protectedSet);
  let state = cwdProtected;
  for (const seg of splitSegments(cmd)) {
    if (seg.startsWith("(") && seg.endsWith(")")) {
      if (classifyChain(seg.slice(1, -1), shell, protectedSet, state)) return true;
      continue; // subshell cd does not propagate outward (bash semantics)
    }
    const cdM = CD_RE.exec(seg);
    if (cdM) {
      state = resolveCdProtected(cdM[1], protectedSet);
      continue;
    }
    if (tokens.length > 0 && segmentIsProtectedWrite(seg, tokens, pathPiece, state)) return true;
  }
  return false;
}

/**
 * Port of `_is_write_to_protected` (intent.py:411). Entry point — chain
 * classification starting from `cwdProtected = false`.
 */
export function isWriteToProtected(
  cmd: string,
  shell: Shell | undefined,
  protectedSet: readonly string[]
): boolean {
  return classifyChain(cmd, shell, protectedSet, false);
}

// ---------------------------------------------------------------------------
// Bash allow-lane write-target extraction (contract T7-0 L-3) — a SEPARATE
// concern from the protected-set matching above (`isWriteToProtected`, T2b):
// this extracts the ACTUAL target-path TEXT of a recognized write-token so
// the caller (`classify.ts`) can glob-match it against `zone.allow` (worker
// allow-lane), the same way `classifyPath` (T2c) already does for Write/Edit.
//
// Best-effort, NOT the hard boundary (contract L-3: "hook = best-effort;
// жёсткая граница — zone-check рельса на коммите") — documented gaps:
//  - No `cd`-state tracking here (unlike `classifyChain` above): a relative
//    target after `cd somewhere && <write> target` is normalized against the
//    ORIGINAL cwd/repoRoot only, never the post-`cd` directory. Conservative
//    direction only (an actually-in-zone target can get wrongly denied after
//    an unresolved `cd`; the reverse — an actually-outside-zone target being
//    wrongly allowed — cannot happen from this gap alone).
//  - Per-token target-POSITION heuristic (`TARGET_MODE`), not a real
//    argument-parser:
//      "first" — redirect (`>`/`>>`) and single-path PS cmdlets (Out-File,
//        Set-Content, Add-Content, Clear-Content, Tee-Object): first
//        non-flag word is the path.
//      "last"  — cp/mv/sed -i/install/ln/Copy-Item/Move-Item: conventional
//        trailing DESTINATION arg. Earlier SOURCE arg(s) are simply not
//        extracted/checked at all — narrower coverage, not a bypass (the
//        actual write lands on the last arg; an out-of-zone source is a
//        read, not covered by this write-target check by design).
//      "all"   — rm/touch/mkdir/tee/dd/truncate/Remove-Item/ri/del/New-Item:
//        every non-flag word is a target (these commands take ONLY path
//        args in normal usage). A shape this word-split doesn't understand
//        (e.g. `dd of=path`, `=`-joined, not space-separated) is checked as
//        one literal word, which will almost never glob-match `zone.allow`
//        -> degrades to deny, the safe direction, not a bypass.
//  - A token with no `TARGET_MODE` entry contributes nothing -> falls
//    through to "nothing recognized" (contract: an unrecognized write-intent
//    keeps its PRE-L-3 behaviour, i.e. this step is not a NEW deny for it).
type TargetMode = "first" | "last" | "all";

const TARGET_MODE: Readonly<Record<string, TargetMode>> = {
  ">": "first",
  ">>": "first",
  "Out-File": "first",
  "Set-Content": "first",
  "Add-Content": "first",
  "Clear-Content": "first",
  "Tee-Object": "first",
  cp: "last",
  mv: "last",
  "sed -i": "last",
  install: "last",
  ln: "last",
  "Copy-Item": "last",
  "Move-Item": "last",
  tee: "all",
  rm: "all",
  touch: "all",
  mkdir: "all",
  dd: "all",
  truncate: "all",
  "Remove-Item": "all",
  ri: "all",
  del: "all",
  "New-Item": "all",
};

/** Whitespace-split `tail`, quote-stripped, flag words (`-x`, `--long`) dropped. */
function extractArgWords(tail: string): string[] {
  return tail
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !w.startsWith("-"))
    .map(stripQuotes);
}

function targetsForToken(tok: string, tail: string): string[] {
  const mode = TARGET_MODE[tok];
  if (!mode) return [];
  const args = extractArgWords(tail);
  if (args.length === 0) return [];
  if (mode === "first") return [args[0]];
  if (mode === "last") return [args[args.length - 1]];
  return args; // "all"
}

/** T7-6/T7-9 (contract L-2): same `matchToken` dispatch as `segmentIsProtectedWrite` — quote-aware `>`/`>>`, command-word/quoted-region-restricted WORD tokens. */
function segmentWriteTargets(segment: string, tokens: readonly string[]): string[] {
  const out: string[] = [];
  const mask = unquotedMask(segment);
  const cmdWordStart = skipCommandPrefix(segment);
  for (const tok of tokens) {
    const m = matchToken(segment, tok, cmdWordStart, mask);
    if (!m) continue;
    const tail = segment.slice(m.index + m.length);
    out.push(...targetsForToken(tok, tail));
  }
  return out;
}

/**
 * Extract every best-effort write-target TEXT from `cmd` (contract L-3).
 * Segments the same way `classifyChain` does (`;`/`&&`/`||`/`|`/bare `&`/
 * newline top-level separators; `(...)` recursed into as one subshell
 * segment) — but, UNLIKE `classifyChain`, does NOT track `cd` state (see
 * module doc-comment above — a deliberate, documented, conservative-only
 * simplification).
 *
 * Returned strings are RAW (not yet normalized/glob-matched) — the caller
 * (`classify.ts`) normalizes each with `normalizePath` and glob-matches
 * against `zone.allow`.
 */
export function extractWriteTargets(cmd: string, shell?: Shell): string[] {
  const tokens = tokenList(shell).filter((t) => t in TARGET_MODE);
  if (tokens.length === 0) return [];
  const out: string[] = [];
  for (const seg of splitSegments(cmd)) {
    if (seg.startsWith("(") && seg.endsWith(")")) {
      out.push(...extractWriteTargets(seg.slice(1, -1), shell));
      continue;
    }
    out.push(...segmentWriteTargets(seg, tokens));
  }
  return out;
}

/**
 * Contract A (shell SWP/freeze) — narrow bash extract: unquoted `>`/`>>`
 * targets + simple `tee <path>` only. Reuses `segmentWriteTargets` /
 * `findUnquotedRedirect` (no rm/cp/mv fan-out).
 */
export function extractBashRedirectTargets(cmd: string): string[] {
  const tokens = [">", ">>", "tee"];
  const out: string[] = [];
  for (const seg of splitSegments(cmd)) {
    if (seg.startsWith("(") && seg.endsWith(")")) {
      out.push(...extractBashRedirectTargets(seg.slice(1, -1)));
      continue;
    }
    out.push(...segmentWriteTargets(seg, tokens));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heredoc-body masking (T7-9, contract L-1, lead-amended — allowlist, NOT a
// denylist) — a preprocessing pass applied to the RAW `cmd` text, once, by
// `classify.ts`, BEFORE any classifier runs (security-floor / git-mut / zone
// all see the masked result equally — a heredoc body being "data, not
// commands" is not a zone-specific concern).
//
// Security-regression fix (lead amendment, supersedes the original L-1
// draft): the FIRST cut of this masking pass used an interpreter DENYLIST
// (mask unless the consumer is `bash`/`sh`/`node`/...). That silently
// treated `xargs`, `awk`, and a bare compound-construct closer (`done`/`}`)
// as inert data sinks, letting a heredoc body that's actually EXECUTED
// (`xargs cmd <<EOF`, `while ...; done <<EOF`, `{ cat; } <<EOF`) get masked
// away and slip past git-mut/security-floor. Replaced with a narrow
// ALLOWLIST (`isDataSinkHeredoc`, below) — see its doc-comment for the (a)/
// (b)/(c) conditions. Everything not provably safe stays fail-closed.
// ---------------------------------------------------------------------------

/** Consumer command words PROVABLY inert w.r.t. their stdin (contract L-1 condition (a)) — never execute/interpret it. */
const DATA_SINK_WORDS = new Set([
  "cat",
  "tee",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "wc",
  "sort",
  "uniq",
  "head",
  "tail",
  "cut",
  "tr",
  "base64",
  "diff",
  "cmp",
  "jq",
  "less",
  "more",
]);

/**
 * Compound/loop-construct keywords + grouping punctuation (contract L-1
 * condition (b)) — a heredoc word-extracted "consumer" landing on one of
 * these (typically because it's attached to a construct's CLOSER — `done`/
 * `fi`/`}`/`)` — or is itself a construct opener/mid-keyword) is NEVER
 * eligible for masking, regardless of `DATA_SINK_WORDS` membership (none of
 * these collide with that list today; kept as an explicit, self-documenting
 * check rather than relying solely on that non-overlap).
 */
const COMPOUND_KEYWORDS = new Set([
  "while",
  "until",
  "for",
  "if",
  "then",
  "elif",
  "else",
  "do",
  "done",
  "fi",
  "esac",
  "in",
  "select",
  "case",
  "function",
]);
const COMPOUND_PUNCT = new Set(["{", "}", "(", ")"]);

/**
 * Normalize a resolved command word for `DATA_SINK_WORDS`/`COMPOUND_KEYWORDS`
 * lookup: strip surrounding quotes, take the path basename (`/usr/bin/cat` ->
 * `cat`), drop a `.exe` suffix (Windows), lower-case. Mirrors `FIX-4`'s
 * `git`/`git.exe` treatment in `git.ts`, same spirit.
 */
function normalizeCommandWord(word: string): string {
  if (!word) return "";
  const stripped = stripQuotes(word);
  const base = stripped.split(/[\\/]/).pop() ?? stripped;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/** Skip `skipCommandPrefix`, then take the first whitespace-delimited word — the raw (un-normalized) command word of `s`. */
function firstCommandWord(s: string): string {
  const off = skipCommandPrefix(s);
  const wm = /^\S+/.exec(s.slice(off));
  return wm ? wm[0] : "";
}

/**
 * Resolve the command word of the statement immediately preceding `pos`
 * (a heredoc operator's index) in `cmd` — the heredoc's CONSUMER. Finds the
 * nearest unquoted top-level separator before `pos` (same `unquotedMask` +
 * `matchSeparatorAt` scan `splitSegments` uses) to bound the statement, then
 * `firstCommandWord` (env-assignments / `sudo`/`command` skip + first word).
 * Best-effort — a leading `(` (subshell) is stripped defensively but no
 * deeper paren-aware parsing is attempted; landing on a stray `(`/`)` simply
 * fails `DATA_SINK_WORDS` membership -> not masked (conservative-safe, not a
 * bypass — see module doc-comment above).
 *
 * NOTE (contract L-1 condition (b), why this "just works" for compound
 * constructs without deeper parsing): `firstCommandWord` never skips PAST an
 * unrecognized leading word — only env-assignments and `sudo`/`command` are
 * skipped. So a heredoc attached mid-construct (`do cat <<EOF`, `then cat
 * <<EOF`, `} <<EOF`, `done <<EOF`) always resolves to the CONSTRUCT keyword/
 * punctuation itself (`do`, `then`, `}`, `done`), never to the real command
 * that follows it on the same statement — which is exactly why it fails
 * `DATA_SINK_WORDS` and stays unmasked, independent of `COMPOUND_KEYWORDS`/
 * `COMPOUND_PUNCT` (those sets are kept anyway as an explicit, defense-in-
 * depth restatement of the same rule, contract L-1 (b)).
 */
function commandWordBefore(cmd: string, pos: number): string {
  const mask = unquotedMask(cmd.slice(0, pos));
  let stmtStart = 0;
  for (let i = 0; i < pos; i++) {
    if (mask[i]) {
      const sep = matchSeparatorAt(cmd, i);
      if (sep) stmtStart = i + sep.length;
    }
  }
  const stmt = cmd.slice(stmtStart, pos).replace(/^\(+/, "");
  return firstCommandWord(stmt);
}

// ---------------------------------------------------------------------------
// Pipeline-stage grouping (contract L-1 condition (c)) — top-level split of
// `cmd`, quote/paren-aware (same scan `splitSegments` uses), but WITHOUT
// trimming/discarding empty segments or losing which separator joined each
// pair — needed to walk from the heredoc's own stage to its PIPE-connected
// siblings (`|`, `|&`) specifically, distinct from `;`/`&&`/`||`/bare `&`/
// newline (which terminate a pipeline, not join it).
// ---------------------------------------------------------------------------

interface TopSeg {
  text: string;
  start: number;
  end: number;
  /** The raw separator token that ended this segment (`"&&"`,`"||"`,`";"`,`"|"`,`"&"`,`"\n"`/`"\r\n"`), or `null` for the last segment. */
  sepAfter: string | null;
}

function topLevelSplit(cmd: string): TopSeg[] {
  const segs: TopSeg[] = [];
  const mask = unquotedMask(cmd);
  let start = 0;
  let depth = 0;
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];
    if (c === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0 && mask[i]) {
      const sep = matchSeparatorAt(cmd, i);
      if (sep !== null) {
        segs.push({ text: cmd.slice(start, i), start, end: i, sepAfter: sep });
        i += sep.length;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  segs.push({ text: cmd.slice(start, n), start, end: n, sepAfter: null });
  return segs;
}

/**
 * Does `segs[i]` connect FORWARD to a next pipeline stage — a bare `|`
 * (single-char; `||` is tokenized as its own 2-char separator by
 * `matchSeparatorAt`/`SEP_RE`, never confused with this), or `|&` (which
 * `SEP_RE` — reused unmodified here — tokenizes as `|` immediately followed
 * by a ZERO-LENGTH bridge segment whose own `sepAfter` is bare `&`; detected
 * and skipped over as one unit)? Returns the segment-index OFFSET to the
 * next real stage (1 for `|`, 2 for `|&`), or 0 if not a connector.
 */
function pipeConnectorSkip(segs: readonly TopSeg[], i: number): number {
  if (segs[i]?.sepAfter !== "|") return 0;
  const bridge = segs[i + 1];
  if (bridge && bridge.text === "" && bridge.sepAfter === "&") return 2;
  return 1;
}

/** Every segment-index in the same pipeline as `segs[k]` (contract L-1 (c)), in order — includes `k` itself. */
function pipelineGroup(segs: readonly TopSeg[], k: number): number[] {
  const group = [k];
  let i = k;
  for (;;) {
    if (i - 1 >= 0 && i - 1 + pipeConnectorSkip(segs, i - 1) === i) {
      group.unshift(i - 1);
      i -= 1;
      continue;
    }
    if (i - 2 >= 0 && i - 2 + pipeConnectorSkip(segs, i - 2) === i) {
      group.unshift(i - 2);
      i -= 2;
      continue;
    }
    break;
  }
  let j = k;
  for (;;) {
    const skip = pipeConnectorSkip(segs, j);
    if (skip === 0) break;
    const next = j + skip;
    if (next >= segs.length) break;
    group.push(next);
    j = next;
  }
  return group;
}

/**
 * Contract L-1 (a)+(b)+(c): is the heredoc operator at `cmd[pos..]` eligible
 * for masking? All three must hold — see the module doc-comment for the full
 * rationale (allowlist, not a denylist).
 */
function isDataSinkHeredoc(cmd: string, pos: number): boolean {
  const consumer = commandWordBefore(cmd, pos);
  const norm = normalizeCommandWord(consumer);

  // (b) compound/loop-construct attachment -- explicit, defense-in-depth
  // (already implied by (a) below never matching a keyword/brace, see
  // `commandWordBefore`'s NOTE).
  if (COMPOUND_KEYWORDS.has(norm) || COMPOUND_PUNCT.has(consumer)) return false;

  // (a) consumer itself must be a provable data sink.
  if (!DATA_SINK_WORDS.has(norm)) return false;

  // (c) every OTHER stage of the same pipeline must be a data sink too.
  const segs = topLevelSplit(cmd);
  const k = segs.findIndex((s) => pos >= s.start && pos < s.end);
  if (k === -1) return false; // conservative: couldn't locate the stage -> don't mask
  for (const idx of pipelineGroup(segs, k)) {
    if (idx === k) continue;
    const stageWord = firstCommandWord(segs[idx].text.replace(/^\(+/, ""));
    if (!DATA_SINK_WORDS.has(normalizeCommandWord(stageWord))) return false;
  }
  return true;
}

// Heredoc header: `<<`, optional `-` (strips leading tabs off the terminator
// line), optional whitespace, then the delimiter word — single- or
// double-quoted, or bare (bash forbids whitespace/quotes/most shell
// metacharacters in a bare heredoc word; `<<<` here-strings never match this
// pattern since a THIRD `<` cannot start a bare/quoted word either, so
// `<<<WORD` is correctly left alone — not a heredoc, same-line content).
const HEREDOC_HEADER_RE = /<<(-)?[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s'"();|&<>]+))/g;

/**
 * Mask heredoc bodies out of `cmd` (contract L-1) — returns a rewritten
 * string safe to feed into every classifier (`matchSecurityFloor`,
 * `classifyGit`, `isWriteToProtected`/`extractWriteTargets`) in place of the
 * raw `cmd`. For each heredoc found (left to right, non-overlapping):
 *  - `isDataSinkHeredoc` (a)+(b)+(c) all hold -> keep the header line (its
 *    OWN redirect/write-intent, e.g. `cat >> f <<EOF`'s `>> f`, still gets
 *    classified normally), DROP the body+terminator lines entirely (they're
 *    DATA) — whatever follows the terminator line continues being
 *    classified normally, unaffected.
 *  - otherwise (the default) -> leave header+body+terminator UNTOUCHED
 *    (fail-closed: the body stays classified as commands).
 *  - no terminator line found (unclosed heredoc) -> fail-closed: the
 *    remainder of `cmd` from that point on is left UNTOUCHED (classified as
 *    commands), per contract.
 *  - no body text present at all (heredoc header is on the last line, no
 *    trailing newline) -> nothing to mask; scanning stops (nothing left).
 */
export function maskHeredocs(cmd: string): string {
  let out = "";
  let cursor = 0;
  HEREDOC_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEREDOC_HEADER_RE.exec(cmd)) !== null) {
    if (m.index < cursor) continue; // inside an already-consumed region
    const dash = m[1] === "-";
    const word = m[2] ?? m[3] ?? m[4] ?? "";
    if (!word) continue;
    const matchEnd = m.index + m[0].length;
    const headerNl = cmd.indexOf("\n", matchEnd);
    if (headerNl === -1) break; // no body text present in the string -- nothing to mask

    const termRe = new RegExp(
      dash ? `^[ \\t]*${escapeRegExp(word)}[ \\t]*$` : `^${escapeRegExp(word)}[ \\t]*$`
    );
    let lineStart = headerNl + 1;
    let afterTerm = -1;
    while (lineStart <= cmd.length) {
      let lineEnd = cmd.indexOf("\n", lineStart);
      const isLast = lineEnd === -1;
      if (isLast) lineEnd = cmd.length;
      if (termRe.test(cmd.slice(lineStart, lineEnd))) {
        afterTerm = isLast ? lineEnd : lineEnd + 1;
        break;
      }
      if (isLast) break;
      lineStart = lineEnd + 1;
    }

    if (afterTerm === -1) {
      // Unclosed heredoc (contract L-1, fail-closed): classify the whole
      // remainder as commands -- leave it untouched.
      out += cmd.slice(cursor);
      cursor = cmd.length;
      break;
    }

    if (isDataSinkHeredoc(cmd, m.index)) {
      out += cmd.slice(cursor, headerNl + 1); // header line only; body+terminator dropped
    } else {
      out += cmd.slice(cursor, afterTerm); // untouched: fail-closed, body IS commands
    }
    cursor = afterTerm;
    HEREDOC_HEADER_RE.lastIndex = cursor;
  }
  out += cmd.slice(cursor);
  return out;
}
