/**
 * core/src/render/engine.ts — core canon -> client content-render, port of
 * `tools/render/engine.py` (T3).
 *
 * `render(canonRoot, outRoot, {clients, overlayRoot, target}) -> RenderReport`.
 *
 * L-1 (contract, HARD SCOPE BOUNDARY): this is CONTENT-render only — roles /
 * zonemap / delegation / policy -> client format. Guard-shim emission,
 * shim-integrity checking and machine-seed installation (`tools/render/
 * {shim,seed}.py` in the Python original) are OUT OF SCOPE here (T5, native
 * shims under the new model). There is no `ShimIntegrityError`, no
 * `shim_integrity` report field, no fail-closed abort tied to shim state —
 * `render()` here never raises on a per-client basis, it only records
 * `report.errors` for a broken adapter and moves on.
 *
 * `target` (target/polygon dimension, ported from the Python engine's
 * kusok3/universal-core-target-layer-p3): union of domain-roles from
 * `canonRoot/targets/<target>/roles/` on top of engine-canon roles
 * (`canonRoot/roles/`), plus target-config (zonemap/delegation/policy)
 * overriding the top-level canon default when the target carries it.
 * `target` omitted -> strictly the previous engine-only behaviour.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import nodePath from "node:path";

import { dump as dumpYaml, parse as parseYaml } from "./yaml.ts";
import {
  AdapterError,
  discoverClients,
  hasCapability,
  loadAdapter,
  resolveNative,
  shimBundlePath,
  targetPath as adapterTargetPath,
} from "./adapter.ts";
import type { Adapter } from "./adapter.ts";
import { bundleCore } from "./bundle.ts";

const posixPath = nodePath.posix;

export class RenderError extends Error {}

export const CONFIG_RESOURCE_CLASSES = ["zonemap", "delegation", "policy"] as const;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface SkippedEntry {
  client: string;
  resource: string;
  reason: string;
}

export interface RenderReport {
  written: string[];
  unchanged: string[];
  skipped: SkippedEntry[];
  unmanaged: string[];
  errors: string[];
}

export function createReport(): RenderReport {
  return { written: [], unchanged: [], skipped: [], unmanaged: [], errors: [] };
}

export function reportOk(report: RenderReport): boolean {
  return report.errors.length === 0;
}

// ---------------------------------------------------------------------------
// Canon resource model
// ---------------------------------------------------------------------------

export type ResourceKind = "role" | "config";

export interface Resource {
  resourceClass: string; // "roles" | "zonemap" | "delegation" | "policy"
  resourceId: string;
  kind: ResourceKind;
  data: Record<string, any>;
  source: string;
}

/** Port of `_FM_RE` (engine.py). Frontmatter block `---\n...\n---\n` + body. */
export const FM_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

function normalizeRoot(p: string): string {
  const n = p.replace(/\\/g, "/");
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile();
}

export function parseRoleFile(path: string): Record<string, any> {
  const text = readFileSync(path, "utf-8");
  const m = FM_RE.exec(text);
  if (!m) {
    throw new RenderError(`${path}: missing YAML frontmatter (--- ... ---) — malformed canon role`);
  }
  const fmText = m[1];
  const body = m[2];
  const fm = parseYaml(fmText) ?? {};
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) {
    throw new RenderError(`${path}: role frontmatter must be a mapping`);
  }
  const out: Record<string, any> = { ...(fm as Record<string, any>) };
  out.body = body.replace(/^\n+/, "").replace(/\n+$/, "");
  return out;
}

export function collectRoles(canonRoot: string): Resource[] {
  const root = normalizeRoot(canonRoot);
  const rolesDir = posixPath.join(root, "roles");
  const out: Resource[] = [];
  if (!isDir(rolesDir)) return out;
  const files = readdirSync(rolesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  for (const f of files) {
    const stem = f.slice(0, -3);
    if (stem.toLowerCase() === "readme") continue;
    const p = posixPath.join(rolesDir, f);
    const data = parseRoleFile(p);
    const rid = String(data.name ?? stem);
    out.push({ resourceClass: "roles", resourceId: rid, kind: "role", data, source: p });
  }
  out.sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
  return out;
}

/** target-dimension (ported kusok3): `canonRoot/targets/<target>/<name>.yml`
 * wins over the top-level `canonRoot/<name>.yml` when it exists. `target`
 * omitted -> strictly the previous (top-level-only) behaviour. */
export function collectConfig(canonRoot: string, name: string, target?: string): Resource {
  const root = normalizeRoot(canonRoot);
  let p = posixPath.join(root, `${name}.yml`);
  if (target) {
    const targetP = posixPath.join(root, "targets", target, `${name}.yml`);
    if (isFile(targetP)) p = targetP;
  }
  let data: Record<string, any> = {};
  if (isFile(p)) {
    const loaded = parseYaml(readFileSync(p, "utf-8"));
    data = loaded !== null && typeof loaded === "object" && !Array.isArray(loaded) ? (loaded as Record<string, any>) : {};
  }
  return { resourceClass: name, resourceId: name, kind: "config", data, source: p };
}

/** target-dimension (ported kusok3): optional `target` adds a union of
 * domain-roles from `canonRoot/targets/<target>/roles/` to the engine-canon
 * roles (`canonRoot/roles/`), and prefers target-config resources (zonemap/
 * delegation/policy) over the top-level canon default when the target
 * carries them. `target` omitted -> strictly the previous behaviour. */
export function collectResources(canonRoot: string, target?: string): Resource[] {
  const root = normalizeRoot(canonRoot);
  const out = [...collectRoles(root)];
  if (target) {
    out.push(...collectRoles(posixPath.join(root, "targets", target)));
  }
  for (const name of CONFIG_RESOURCE_CLASSES) {
    out.push(collectConfig(root, name, target));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Materialization (C3: default ⊕ overlay) + D3 native-resolve
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(overlay)) {
      const bv = base[k];
      out[k] = isPlainObject(bv) && isPlainObject(v) ? deepMerge(bv, v) : v;
    }
    return out;
  }
  return overlay;
}

export function readOverlay(overlayRoot: string, client: string, resourceId: string): Record<string, any> {
  const root = normalizeRoot(overlayRoot);
  const p = posixPath.join(root, client, `${resourceId}.yml`);
  if (!isFile(p)) return {};
  const data = parseYaml(readFileSync(p, "utf-8")) ?? {};
  if (!isPlainObject(data)) {
    throw new RenderError(`overlay ${p}: expected mapping, got ${typeof data}`);
  }
  return data as Record<string, any>;
}

/** D3: recursively resolves string leaves `"native"` -> `adapter.client`
 * (self). Applied only to `resourceClass === "delegation"`. */
export function resolveNativeDeep(data: unknown, adapter: Adapter): unknown {
  if (isPlainObject(data)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) out[k] = resolveNativeDeep(v, adapter);
    return out;
  }
  if (Array.isArray(data)) return data.map((v) => resolveNativeDeep(v, adapter));
  if (typeof data === "string") return resolveNative(adapter, data);
  return data;
}

/** Stable serialization for config resources (FR-render-deterministic): sortKeys. */
export function dumpConfigYaml(data: Record<string, any>): string {
  return dumpYaml(data, { sortKeys: true });
}

// ---------------------------------------------------------------------------
// Role frontmatter rendering (content.frontmatter.roles per adapter)
// ---------------------------------------------------------------------------

/** `universe` (T-canon-single-source, opencode bool_map): when set and
 * `fmt === "bool_map"`, EVERY key in `universe` is emitted (true if present
 * in `tools`, false otherwise) — reproduces OpenCode's explicit per-tool
 * denial map (`gated_commit: false`, ...), not just the granted subset. */
export function formatTools(tools: unknown, fmt: string, universe?: string[]): unknown {
  const arr = Array.isArray(tools) ? tools.map((t) => String(t)) : [];
  if (fmt === "bool_map" && universe && universe.length > 0) {
    const set = new Set(arr);
    const out: Record<string, boolean> = {};
    for (const t of universe) out[t] = set.has(t);
    return out;
  }
  if (arr.length === 0) {
    return fmt === "csv" || fmt === "csv_lower" ? "" : {};
  }
  if (fmt === "csv") return arr.join(", ");
  if (fmt === "csv_lower") return arr.map((t) => t.toLowerCase()).join(", ");
  if (fmt === "bool_map") {
    const out: Record<string, boolean> = {};
    for (const t of arr) out[t] = true;
    return out;
  }
  return arr;
}

/**
 * T-canon-single-source: canon tool-vocabulary -> client-native tool names.
 * `tool_map[canonName] === null` -> capability gap, DROP (AD-canon-superset,
 * mirrors the resource-class capability-skip already used for zonemap/
 * delegation/policy, applied at tool-name granularity). `canonName` absent
 * from `tool_map` -> identity passthrough (adapter didn't need to declare a
 * rename/drop for it). `tool_overrides[resourceId]` (port-name space, applied
 * AFTER the map) — `add`/`remove` for the rare per-role exception (OpenCode/CC
 * explorer needs Bash even though the neutral canon explorer capability list
 * doesn't grant it; OpenCode executor/domain roles never get Bash even though
 * canon does, containment).
 */
export function resolveToolNames(canonTools: readonly string[], resourceId: string, fmSpec: FrontmatterSpec): string[] {
  const map = fmSpec.tool_map;
  let out: string[];
  if (!map) {
    out = [...canonTools];
  } else {
    out = [];
    for (const t of canonTools) {
      if (t in map) {
        const mapped = map[t];
        if (mapped !== null) out.push(mapped);
      } else {
        out.push(t);
      }
    }
  }
  const overrides = fmSpec.tool_overrides?.[resourceId];
  if (overrides) {
    if (overrides.remove) out = out.filter((t) => !overrides.remove!.includes(t));
    if (overrides.add) for (const t of overrides.add) if (!out.includes(t)) out.push(t);
  }
  return out;
}

export interface FrontmatterSpec {
  fields?: string[];
  literals?: Record<string, unknown>;
  tools_format?: string;
  /** Canon tool name -> client tool name (or `null` to drop). Absent adapter
   * declaration -> identity (unchanged prior behaviour). */
  tool_map?: Record<string, string | null>;
  /** Per-role (resourceId), port-name-space tool add/remove exceptions. */
  tool_overrides?: Record<string, { add?: string[]; remove?: string[] }>;
  /** Full ordered client-native tool-key universe for `tools_format: bool_map` — see `formatTools`. */
  tools_universe?: string[];
  /** `model` field alias resolution (canon `@alias` -> client-concrete model name). Unmapped values pass through. */
  model_map?: Record<string, string>;
}

/**
 * T-canon-single-source: substitutes `{{insert:KEY}}` placeholders with
 * adapter-declared `content.inserts[KEY]` text (empty/absent -> "").
 * Paragraph-only placeholders (a paragraph consisting of nothing but the
 * token, e.g. the "Игнорируй ambient-правила..." line) DROP the whole
 * paragraph (surrounding blank line collapses too) when the value is empty —
 * so a port without that insert doesn't leave a stray double-blank-line.
 * Inline placeholders (mid-sentence, e.g. a commit-rail suffix or the
 * zone-guard dir token) substitute in place, "" when absent.
 */
export function substituteInserts(text: string, inserts: Record<string, string>): string {
  const INSERT_RE = /^\{\{insert:([\w-]+)\}\}$/;
  const paragraphs = text.split(/\n\n+/);
  const kept: string[] = [];
  for (const para of paragraphs) {
    const m = INSERT_RE.exec(para.trim());
    if (m) {
      const val = inserts[m[1]] ?? "";
      if (val.trim() === "") continue;
      kept.push(val);
      continue;
    }
    kept.push(para);
  }
  return kept.join("\n\n").replace(/\{\{insert:([\w-]+)\}\}/g, (_match, key: string) => inserts[key] ?? "");
}

/**
 * Frontmatter fields in the ADAPTER-DECLARED order (`fields`), not
 * alphabetical — the frontmatter must preserve the client's real layout
 * order (CC/OMP: name/description/model/tools).
 *
 * declared ∧ present -> emit; declared-but-absent -> OMIT (NOT force-null —
 * this is the p2/T2 optional-field fix, ported verbatim). `tools`: declared
 * ∧ present-∧-non-empty -> emit (formatted); absent/empty -> omit.
 */
export function renderRoleText(resource: Resource, fmSpec: FrontmatterSpec, inserts: Record<string, string> = {}): string {
  const fields = fmSpec.fields ?? [];
  const literals = fmSpec.literals ?? {};
  const toolsFormat = fmSpec.tools_format ?? "csv";
  const data = resource.data;

  const fm: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === "tools") {
      const rawTools = Array.isArray(data.tools) ? data.tools.map((t: unknown) => String(t)) : [];
      if (rawTools.length > 0) {
        const mapped = resolveToolNames(rawTools, resource.resourceId, fmSpec);
        fm[f] = formatTools(mapped, toolsFormat, fmSpec.tools_universe);
      }
    } else if (f in data) {
      let v = data[f];
      if (f === "model" && typeof v === "string" && fmSpec.model_map && v in fmSpec.model_map) {
        v = fmSpec.model_map[v];
      }
      fm[f] = typeof v === "string" ? substituteInserts(v, inserts) : v;
    } else if (f in literals) {
      fm[f] = literals[f];
    }
    // else: declared-but-absent field -> OMIT.
  }
  for (const [k, v] of Object.entries(literals)) {
    if (!(k in fm)) fm[k] = v;
  }

  const fmText = dumpYaml(fm, { sortKeys: false }).replace(/\n+$/, "");
  const body = substituteInserts(String(data.body ?? ""), inserts).replace(/^\n+/, "").replace(/\n+$/, "");
  return `---\n${fmText}\n---\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// IO helpers (write-if-changed = idempotency, C4; unmanaged walk)
// ---------------------------------------------------------------------------

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function relativePosix(root: string, target: string): string {
  const r = normalizeRoot(root);
  const t = target.replace(/\\/g, "/");
  if (t === r) return "";
  if (t.startsWith(`${r}/`)) return t.slice(r.length + 1);
  return t;
}

/** Writes `path` only if current content differs from `content` (C4,
 * FR-render-idempotent). Returns `true` if a write happened. */
export function writeIfChanged(path: string, content: string, report: RenderReport, label: string): boolean {
  ensureDir(posixPath.dirname(path));
  const bytes = Buffer.from(content, "utf-8");
  if (isFile(path)) {
    const existing = readFileSync(path);
    if (existing.equals(bytes)) {
      report.unchanged.push(label);
      return false;
    }
  }
  writeFileSync(path, bytes);
  report.written.push(label);
  return true;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    if (!isDir(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = posixPath.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) out.push(p);
    }
  }
  walk(root);
  return out.sort();
}

// ---------------------------------------------------------------------------
// render()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T5c-2: in-process client-wrapper templates (C5, contract L-4) — FIXED per
// client, owned by the engine. The adapter declares only style/entry/
// location (adapter.ts); the wrapper CONTENT below is the single source of
// truth. Each template receives the already-computed relative import paths
// to the bundled `shim/<client>-adapter` module and the bundled
// `wiring/policy-source` module (both under the bundled `_core` copy —
// `bundle.ts` mirrors `core/src` byte-for-byte, so `shim/<client>-adapter`
// and `wiring/policy-source` resolve inside it). No `.ts` extension on the
// vendor-facing import specifiers here (contract example, `../_core/shim/
// omp-adapter`) — matches the harness' own module resolution, not Node
// type-strip's `./yaml.ts`-style convention used inside this repo's own
// tests/sources.
//
// L-1: these strings are written to a FILE as build output — this module
// never itself imports `@oh-my-pi/...` / `@opencode-ai/plugin` (zero
// external deps in the core, contract DoD).
// ---------------------------------------------------------------------------

type WrapperTemplate = (adapterImportPath: string, wiringImportPath: string) => string;

const IN_PROCESS_WRAPPER_TEMPLATES: Record<string, WrapperTemplate> = {
  omp: (adapterImportPath, wiringImportPath) => `// AUTO-GENERATED by core/src/render/engine.ts (T5c-2) — DO NOT EDIT BY HAND.
// Regenerate via render(). OMP in-process shim wrapper: adapts the pure,
// bundled \`ompGuardDecision\` to the OMP extension hook API
// (\`pi.on("tool_call", ...)\`). Classification logic lives entirely in the
// bundled core (contract L-2) — this file is glue only.
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import { ompGuardDecision } from "${adapterImportPath}";
import { loadPolicyFile } from "${wiringImportPath}";

const DEPS = {
  loadPolicy: (cwd?: string) => loadPolicyFile((cwd || ".") + "/policy.yml"),
};

export default function hook(pi: HookAPI): void {
  pi.on("tool_call", (event: { toolName: string; input?: Record<string, unknown> }, ctx?: { hasUI?: boolean }) => {
    return ompGuardDecision(
      {
        toolName: event.toolName,
        input: event.input ?? {},
        cwd: process.cwd(),
        hasUI: ctx?.hasUI,
        subagentMarker: (event as { subagentMarker?: unknown }).subagentMarker,
      },
      DEPS
    );
  });
}
`,
  opencode: (adapterImportPath, wiringImportPath) => `// AUTO-GENERATED by core/src/render/engine.ts (T5c-2) — DO NOT EDIT BY HAND.
// Regenerate via render(). OpenCode in-process shim wrapper: adapts the
// pure, bundled \`opencodeGuardDecision\` to the OpenCode plugin API
// (\`tool.execute.before\`, deny = throw). Classification logic lives
// entirely in the bundled core (contract L-2) — this file is glue only.
import type { Plugin } from "@opencode-ai/plugin";
import { opencodeGuardDecision } from "${adapterImportPath}";
import { loadPolicyFile } from "${wiringImportPath}";

const DEPS = {
  loadPolicy: (cwd?: string) => loadPolicyFile((cwd || ".") + "/policy.yml"),
};

export const ZoneGuard: Plugin = async ({ directory }: { directory?: string }) => ({
  "tool.execute.before": async (
    input: { tool: string },
    output: { args?: Record<string, unknown> }
  ): Promise<void> => {
    const decision = opencodeGuardDecision(
      { tool: input.tool, args: output?.args ?? {}, directory },
      DEPS
    );
    if (decision) throw new Error(decision.reason);
  },
});
`,
};

export interface RenderOptions {
  clients?: string[];
  overlayRoot?: string;
  target?: string;
  /** T5c-1: root of the TS-core source tree to bundle for
   * `adapter.shim?.mode === "bundled"` clients. Defaults to `core/src`
   * sitting next to `canonRoot` in the repo layout
   * (`<dirname(canonRoot)>/core/src`). */
  coreSrcRoot?: string;
  /** T-canon-single-source: directory holding `<client>.yml` adapter files
   * directly (decoupled from `canonRoot` — adapters are tool-context, not
   * canon data, requirement AD-canon-tool-neutral). Defaults to
   * `<canonRoot>/adapters` (backward-compatible with the pre-existing
   * nested-under-canon layout used by fixtures); the real repo passes
   * `tools/adapters` explicitly (see `cli.ts`). */
  adaptersRoot?: string;
}

/**
 * `render(canonRoot, outRoot, options) -> RenderReport`. Content-render only
 * (L-1) — no shim emission/integrity, no fail-closed abort. A broken adapter
 * for a requested client is recorded in `report.errors`; that client is then
 * skipped entirely (no resources rendered for it), the rest of the render
 * proceeds normally.
 */
export function render(canonRoot: string, outRoot: string, options: RenderOptions = {}): RenderReport {
  const root = normalizeRoot(canonRoot);
  const out = normalizeRoot(outRoot);
  ensureDir(out);

  const overlayRoot = options.overlayRoot !== undefined
    ? normalizeRoot(options.overlayRoot)
    : posixPath.join(posixPath.dirname(root), ".workflow", "clients");

  const coreSrcRoot = options.coreSrcRoot !== undefined
    ? normalizeRoot(options.coreSrcRoot)
    : posixPath.join(posixPath.dirname(root), "core", "src");

  const adaptersRoot = options.adaptersRoot !== undefined
    ? normalizeRoot(options.adaptersRoot)
    : posixPath.join(root, "adapters");

  const clientList = options.clients !== undefined
    ? [...new Set(options.clients)].sort()
    : discoverClients(adaptersRoot);

  const report = createReport();
  const resources = collectResources(root, options.target);
  const claimed = new Set<string>();

  const adapters: Record<string, Adapter> = {};
  for (const client of clientList) {
    try {
      adapters[client] = loadAdapter(adaptersRoot, client);
    } catch (exc) {
      if (exc instanceof AdapterError) {
        report.errors.push(exc.message);
      } else {
        throw exc;
      }
    }
  }

  for (const client of clientList) {
    const adapter = adapters[client];
    if (adapter === undefined) continue;

    for (const res of resources) {
      if (!hasCapability(adapter, res.resourceClass)) {
        report.skipped.push({
          client,
          resource: `${res.resourceClass}:${res.resourceId}`,
          reason: `capability '${res.resourceClass}' not declared by adapter (AD-canon-superset-capability)`,
        });
        continue;
      }

      const { path: target } = adapterTargetPath(adapter, out, res.resourceClass, res.resourceId);

      let text: string;
      if (res.kind === "role") {
        const fmSpec = (adapter.frontmatter[res.resourceClass] ?? {}) as FrontmatterSpec;
        text = renderRoleText(res, fmSpec, adapter.roleInserts);
      } else {
        const overlay = readOverlay(overlayRoot, client, res.resourceId);
        let merged = deepMerge(res.data, overlay) as Record<string, any>;
        if (res.resourceClass === "delegation") {
          merged = resolveNativeDeep(merged, adapter) as Record<string, any>;
        }
        text = dumpConfigYaml(merged);
      }

      const label = relativePosix(out, target);
      writeIfChanged(target, text, report, label);
      claimed.add(target);
    }
  }

  // T5c-1: core-bundle emission (Model A) for `shim.mode === "bundled"`
  // clients — copies `coreSrcRoot` into the shim's declared `location` under
  // each such client's output dir (root-flag routed like D4). `shim: null`
  // or `mode: "native"` -> no bundle emitted (L-3, prior behaviour intact).
  for (const client of clientList) {
    const adapter = adapters[client];
    if (adapter === undefined || adapter.shim?.mode !== "bundled") continue;

    const bundleDir = shimBundlePath(adapter, out, adapter.shim.location);
    if (!isDir(coreSrcRoot)) {
      report.errors.push(
        `${client}: shim.mode 'bundled' but coreSrcRoot '${coreSrcRoot}' does not exist — bundle skipped`
      );
      continue;
    }
    const bundled = bundleCore(coreSrcRoot, bundleDir, report, `${relativePosix(out, bundleDir)}`);
    for (const p of bundled) claimed.add(p);
  }

  // T5c-2: in-process client-wrapper emission (C5, contract L-4) — for
  // `shim.mode === "bundled"` clients with `shim.style === "in-process"` and
  // a non-null `shim.entry`: emit a FIXED per-client wrapper (see
  // `IN_PROCESS_WRAPPER_TEMPLATES` below) that imports the bundled adapter
  // module and wires it into the vendor hook API. `style === "command-hook"`
  // or `entry === null` -> no wrapper (bundle alone is sufficient; command-
  // hook activation is a T6 config concern). An in-process client with no
  // registered template -> `report.errors` + skip (fail-soft, bundle stays).
  for (const client of clientList) {
    const adapter = adapters[client];
    if (adapter === undefined) continue;
    const shim = adapter.shim;
    if (shim === null || shim.mode !== "bundled") continue;
    if (shim.style !== "in-process") continue;
    if (shim.entry === null) continue;

    const template = IN_PROCESS_WRAPPER_TEMPLATES[client];
    if (template === undefined) {
      report.errors.push(
        `${client}: shim.style 'in-process' declared but no wrapper template is registered for this client — wrapper skipped (bundle unaffected)`
      );
      continue;
    }

    const entryPath = shimBundlePath(adapter, out, shim.entry);
    const bundleDir = shimBundlePath(adapter, out, shim.location);
    const relToBundle = posixPath.relative(posixPath.dirname(entryPath), bundleDir);
    const base = relToBundle === "" ? "." : relToBundle;
    const adapterImportPath = `${base}/shim/${client}-adapter`;
    const wiringImportPath = `${base}/wiring/policy-source`;

    const text = template(adapterImportPath, wiringImportPath);
    const label = relativePosix(out, entryPath);
    writeIfChanged(entryPath, text, report, label);
    claimed.add(entryPath);
  }

  // Unmanaged (C4): files in outRoot not claimed by any resource this render
  // touched -> reported, NEVER deleted (AD-manifest-structural-place).
  for (const p of walkFiles(out)) {
    if (!claimed.has(p)) report.unmanaged.push(relativePosix(out, p));
  }
  report.unmanaged.sort();

  return report;
}
