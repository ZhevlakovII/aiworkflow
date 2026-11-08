/**
 * core/src/render/yaml.ts — zero-dep, minimal YAML for the canon-subset (T3).
 *
 * Node has no built-in YAML and external deps are forbidden (contract L-4).
 * This is NOT a general-purpose YAML implementation — it covers exactly the
 * constructs the render engine needs to read/write (see `canon/{zonemap,
 * delegation,policy,adapters/*,roles/*}.yml` for the real corpus this was
 * shaped against):
 *
 *   - nested block mappings, 2-space indent (`key:\n  nested: value`)
 *   - block sequences (`- item`), including sequences-of-mappings
 *     (`- glob: "x"\n  agent: y`)
 *   - inline flow collections: `[a, b]` and `{k: v}`
 *   - scalars: double/single-quoted strings (with `\n`/`\t`/`\r`/`\"`/`\\`
 *     escapes for double-quoted, `''` -> `'` for single-quoted), bare
 *     (unquoted) strings, `true`/`false`, `null`/`~`, integers, floats
 *   - full-line and trailing `#` comments (comment markers inside quotes are
 *     NOT treated as comments)
 *
 * Block scalars (`|`, `>`), anchors/aliases, tags, multi-document streams —
 * explicitly NOT supported (not present in the canon corpus, contract says
 * "не требуются").
 *
 * `dump()` always emits BLOCK style (never flow), double-quotes every string
 * scalar (unambiguous, trivially reversible — no plain-scalar quoting-rules
 * heuristics needed) and leaves booleans/null/numbers bare. This is NOT
 * byte-identical to Python's `yaml.safe_dump` — the contract explicitly
 * scopes T3's yaml-correctness criterion to determinism + validity +
 * `parse(dump(x))` round-trip, not byte-parity with PyYAML (that is a
 * separate, later authority-transfer concern).
 */

export class YamlError extends Error {}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

interface RawLine {
  indent: number;
  content: string;
}

/** Strip a `#` comment that is NOT inside a quoted string and is preceded by
 * whitespace or is the first character (YAML comment-boundary rule). */
function stripComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return s.slice(0, i);
    }
  }
  return s;
}

function preprocess(text: string): RawLine[] {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const lines: RawLine[] = [];
  for (const raw of rawLines) {
    if (raw.trim() === "") continue;
    let i = 0;
    while (i < raw.length && raw[i] === " ") i += 1;
    if (i < raw.length && raw[i] === "\t") {
      throw new YamlError(`tabs are not supported in indentation: ${JSON.stringify(raw)}`);
    }
    const indent = i;
    const rest = raw.slice(i);
    const stripped = stripComment(rest).replace(/[ \t]+$/, "");
    if (stripped === "") continue; // whole line was a comment
    lines.push({ indent, content: stripped });
  }
  return lines;
}

function isSeqItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function unquoteKey(k: string): string {
  if (k.length >= 2 && ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")))) {
    return k.slice(1, -1);
  }
  return k;
}

/** Find the top-level (quote-aware) `key: value` split of a mapping-entry line. */
function splitKeyValue(content: string): { key: string; valuePart: string } {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === ":" && (i + 1 === content.length || content[i + 1] === " ")) {
      return { key: unquoteKey(content.slice(0, i).trim()), valuePart: content.slice(i + 1).trim() };
    }
  }
  throw new YamlError(`expected "key: value" mapping entry, got: ${JSON.stringify(content)}`);
}

/** Same as `splitKeyValue`, but for an INLINE flow-map entry (no
 * trailing-space-after-colon requirement — inline entries are comma-delimited). */
function splitKeyValueFlow(s: string): { key: string; valuePart: string } {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === ":") {
      return { key: unquoteKey(s.slice(0, i).trim()), valuePart: s.slice(i + 1).trim() };
    }
  }
  return { key: unquoteKey(s.trim()), valuePart: "" };
}

/** True if `s` (already trimmed) looks like the START of a `key: value`
 * mapping entry rather than a plain/quoted/flow scalar. Used to decide
 * whether a sequence-item's inline content (`- glob: "x"`) is itself a
 * mapping (continued on following more-indented lines) or a plain scalar
 * (`- Read`). */
function looksLikeMappingEntry(s: string): boolean {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'") || t.startsWith("[") || t.startsWith("{")) return false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (inDouble) {
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === ":" && (i + 1 === t.length || t[i + 1] === " ")) return true;
  }
  return false;
}

/** Top-level (bracket/quote-aware) split on `sep` — used for inline
 * `[a, b]` / `{k: v}` flow collections. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inDouble) {
      cur += c;
      if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      cur += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      cur += c;
      continue;
    }
    if (c === "[" || c === "{") {
      depth += 1;
      cur += c;
      continue;
    }
    if (c === "]" || c === "}") {
      depth -= 1;
      cur += c;
      continue;
    }
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function unescapeDouble(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === "n") {
        out += "\n";
        i += 1;
      } else if (next === "t") {
        out += "\t";
        i += 1;
      } else if (next === "r") {
        out += "\r";
        i += 1;
      } else if (next === '"') {
        out += '"';
        i += 1;
      } else if (next === "\\") {
        out += "\\";
        i += 1;
      } else {
        out += c;
      }
    } else {
      out += c;
    }
  }
  return out;
}

function unescapeSingle(s: string): string {
  return s.replace(/''/g, "'");
}

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?\d+[eE][+-]?\d+$/;

function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === "") return null;
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return unescapeDouble(t.slice(1, -1));
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return unescapeSingle(t.slice(1, -1));
  if (t === "null" || t === "Null" || t === "NULL" || t === "~") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (INT_RE.test(t)) return parseInt(t, 10);
  if (FLOAT_RE.test(t)) return parseFloat(t);
  return t; // bare (unquoted) string, as-is
}

function parseFlowList(text: string): unknown[] {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return splitTopLevel(inner, ",").map((part) => parseScalarOrFlow(part.trim()));
}

function parseFlowMap(text: string): Record<string, unknown> {
  const inner = text.slice(1, -1).trim();
  const result: Record<string, unknown> = {};
  if (inner === "") return result;
  for (const part of splitTopLevel(inner, ",")) {
    const { key, valuePart } = splitKeyValueFlow(part.trim());
    result[key] = parseScalarOrFlow(valuePart);
  }
  return result;
}

function parseScalarOrFlow(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("[")) return parseFlowList(t);
  if (t.startsWith("{")) return parseFlowMap(t);
  return parseScalar(t);
}

interface Pos {
  i: number;
}

function parseValueBlock(lines: RawLine[], pos: Pos, indent: number): unknown {
  if (pos.i >= lines.length || lines[pos.i].indent !== indent) return null;
  if (isSeqItem(lines[pos.i].content)) return parseSequence(lines, pos, indent);
  return parseMapping(lines, pos, indent);
}

function parseMapping(
  lines: RawLine[],
  pos: Pos,
  indent: number,
  firstEntryContent?: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let pending = firstEntryContent;
  for (;;) {
    let content: string;
    if (pending !== undefined) {
      content = pending;
      pending = undefined;
    } else {
      if (pos.i >= lines.length) break;
      const line = lines[pos.i];
      if (line.indent !== indent) break;
      if (isSeqItem(line.content)) break;
      content = line.content;
      pos.i += 1;
    }
    const { key, valuePart } = splitKeyValue(content);
    if (valuePart.length > 0) {
      result[key] = parseScalarOrFlow(valuePart);
    } else if (pos.i < lines.length && lines[pos.i].indent > indent) {
      result[key] = parseValueBlock(lines, pos, lines[pos.i].indent);
    } else {
      result[key] = null;
    }
  }
  return result;
}

function parseSequence(lines: RawLine[], pos: Pos, indent: number): unknown[] {
  const result: unknown[] = [];
  while (pos.i < lines.length && lines[pos.i].indent === indent && isSeqItem(lines[pos.i].content)) {
    const line = lines[pos.i];
    pos.i += 1;
    const after = line.content.slice(1); // drop leading '-'
    const trimmedAfter = after.replace(/^ +/, "");
    const spaceCount = after.length - trimmedAfter.length;
    if (trimmedAfter.length === 0) {
      if (pos.i < lines.length && lines[pos.i].indent > line.indent) {
        result.push(parseValueBlock(lines, pos, lines[pos.i].indent));
      } else {
        result.push(null);
      }
      continue;
    }
    const contentIndent = line.indent + 1 + spaceCount;
    if (looksLikeMappingEntry(trimmedAfter)) {
      result.push(parseMapping(lines, pos, contentIndent, trimmedAfter));
    } else {
      result.push(parseScalarOrFlow(trimmedAfter));
    }
  }
  return result;
}

/** Parse canon-subset YAML text into a plain JS value (object/array/scalar/null). */
export function parse(text: string): unknown {
  const lines = preprocess(text);
  if (lines.length === 0) return null;
  if (lines.length === 1 && !isSeqItem(lines[0].content) && !looksLikeMappingEntry(lines[0].content)) {
    // Whole document is a single-line scalar or flow collection (`{}`/`[]`/`true`/...).
    return parseScalarOrFlow(lines[0].content);
  }
  const pos: Pos = { i: 0 };
  const base = lines[0].indent;
  const value = parseValueBlock(lines, pos, base);
  if (pos.i !== lines.length) {
    throw new YamlError(
      `unexpected content while parsing (stopped at line ${pos.i} of ${lines.length} — indentation mismatch)`
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// dump()
// ---------------------------------------------------------------------------

export interface DumpOptions {
  /** Sort mapping keys alphabetically (config resources). Default: insertion order (role frontmatter). */
  sortKeys?: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dumpString(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  out += '"';
  return out;
}

function dumpScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return dumpString(v);
  throw new YamlError(`cannot dump value of type ${typeof v}: ${JSON.stringify(v)}`);
}

function dumpKeyValue(key: string, value: unknown, indentLevel: number, sortKeys: boolean): string[] {
  const prefix = "  ".repeat(indentLevel);
  if (value === null || value === undefined) return [`${prefix}${key}: null`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}${key}: []`];
    return [`${prefix}${key}:`, ...dumpSequence(value, indentLevel + 1, sortKeys)];
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return [`${prefix}${key}: {}`];
    return [`${prefix}${key}:`, ...dumpMapping(value, indentLevel + 1, sortKeys)];
  }
  return [`${prefix}${key}: ${dumpScalar(value)}`];
}

function dumpMapping(obj: Record<string, unknown>, indentLevel: number, sortKeys: boolean): string[] {
  const keys = Object.keys(obj);
  const ordered = sortKeys ? [...keys].sort() : keys;
  const lines: string[] = [];
  for (const key of ordered) lines.push(...dumpKeyValue(key, obj[key], indentLevel, sortKeys));
  return lines;
}

function dumpSequence(arr: unknown[], indentLevel: number, sortKeys: boolean): string[] {
  const prefix = "  ".repeat(indentLevel);
  const lines: string[] = [];
  for (const item of arr) {
    if (isPlainObject(item)) {
      const keys = Object.keys(item);
      if (keys.length === 0) {
        lines.push(`${prefix}- {}`);
        continue;
      }
      const subLines = dumpMapping(item, 0, sortKeys);
      subLines.forEach((l, idx) => lines.push(idx === 0 ? `${prefix}- ${l}` : `${prefix}  ${l}`));
    } else if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${prefix}- []`);
        continue;
      }
      lines.push(`${prefix}-`);
      lines.push(...dumpSequence(item, indentLevel + 1, sortKeys));
    } else {
      lines.push(`${prefix}- ${dumpScalar(item)}`);
    }
  }
  return lines;
}

/** Deterministic block-style serialization (see module docstring re: not
 * byte-identical to PyYAML). Always ends with a single trailing `\n`. */
export function dump(value: unknown, options: DumpOptions = {}): string {
  const sortKeys = options.sortKeys ?? false;
  if (isPlainObject(value)) {
    const lines = dumpMapping(value, 0, sortKeys);
    return lines.length ? `${lines.join("\n")}\n` : "{}\n";
  }
  if (Array.isArray(value)) {
    const lines = dumpSequence(value, 0, sortKeys);
    return lines.length ? `${lines.join("\n")}\n` : "[]\n";
  }
  return `${dumpScalar(value)}\n`;
}
