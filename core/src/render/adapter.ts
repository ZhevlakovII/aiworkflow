/**
 * core/src/render/adapter.ts — port of `tools/render/adapter.py` (T3).
 *
 * Parses `canon/adapters/<client>.yml`: `client`, `dir`, `capabilities[]`,
 * `content.{frontmatter,layout}`, `machine_seed.{template,location,root}`.
 * Validation: unknown client / broken declaration -> `AdapterError`.
 *
 * D3 (LOCKED, ported verbatim): `resolveNative()` treats the value `"native"`
 * as "the current client's own model" (self) — CC->claude, OpenCode->opencode,
 * OMP->omp. External backends are NOT resolved here (only an explicit,
 * out-of-canon user action).
 *
 * C5 / L-1 (contract): the guard-shim is NOT parsed/declared by this module —
 * shim templating+registration is T5 (native shims), out of scope here. This
 * adapter model knows nothing about shims, exactly like its Python ancestor.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";

import { parse as parseYaml } from "./yaml.ts";

const posixPath = nodePath.posix;

export class AdapterError extends Error {}

export interface LayoutEntry {
  /** Relative path template, may carry `{id}` (roles). */
  template: string;
  /** D4: `true` => path is relative to out_root directly, not out_root/dir. */
  root: boolean;
}

/** T5c-1: optional shim declaration. `mode: "bundled"` -> render() emits a
 * core-bundle (`bundle.ts`) under `location` (`root` flag routes exactly like
 * `LayoutEntry.root` / D4). `mode: "native"` -> hand-authored shim, render
 * emits no bundle for it. The adapter declares ONLY mode+location+style+entry
 * — the shim-wrapper CONTENT (OMP `pi.on` / OpenCode plugin glue) is a FIXED
 * per-client template owned by the render engine (T5c-2 §3, contract L-4),
 * not this module.
 *
 * T5c-2: `style` — `"in-process"` (engine emits a thin client-wrapper at
 * `entry` importing the bundled adapter) vs `"command-hook"` (bundle is
 * sufficient, activation is a client-config concern deferred to T6; default
 * when absent, preserves T5c-1 behaviour). `entry` — rel-path (relative to
 * `dir`, honouring the same `root` routing as `location`) of the wrapper
 * file to emit; `null` (default) -> no wrapper emitted regardless of `style`. */
export interface ShimDecl {
  mode: "bundled" | "native";
  location: string;
  root: boolean;
  style: "in-process" | "command-hook";
  entry: string | null;
}

export interface Adapter {
  client: string;
  dir: string;
  capabilities: readonly string[];
  frontmatter: Record<string, any>;
  layout: Record<string, LayoutEntry>;
  machineSeedTemplate: string | null;
  machineSeedLocation: string;
  machineSeedRoot: boolean;
  shim: ShimDecl | null;
  /** T-canon-single-source: `content.inserts` — named port-specific text
   * fragments (ambient-ignore line, discovery-tool mechanism, zone-guard dir
   * token, commit-rail wording, description invocation-hints, ...) substituted
   * into canon role body/frontmatter-string-fields at `{{insert:KEY}}`
   * placeholders (see `engine.ts` `substituteInserts`). Absent key -> "".
   * Optional, defaults to `{}` (roles without placeholders are unaffected). */
  roleInserts: Record<string, string>;
}

export interface TargetPathResult {
  path: string;
  isRoot: boolean;
}

function normalizeRoot(p: string): string {
  const n = p.replace(/\\/g, "/");
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

export function hasCapability(adapter: Adapter, resourceClass: string): boolean {
  return adapter.capabilities.includes(resourceClass);
}

/** D3: `"native"` -> self (current client's name). Anything else passes through unchanged. */
export function resolveNative(adapter: Adapter, value: unknown): unknown {
  return value === "native" ? adapter.client : value;
}

/**
 * Returns `{path, isRoot}` (absolute path under `outRoot`). Throws
 * `AdapterError` if there is no layout entry for `resourceClass` (a config
 * bug, not a capability-gap — the caller is expected to have already checked
 * `hasCapability`).
 */
export function targetPath(
  adapter: Adapter,
  outRoot: string,
  resourceClass: string,
  resourceId: string
): TargetPathResult {
  const entry = adapter.layout[resourceClass];
  if (entry === undefined) {
    throw new AdapterError(
      `${adapter.client}: capability '${resourceClass}' объявлена, но content.layout.${resourceClass} отсутствует в адаптере`
    );
  }
  const rel = entry.template.split("{id}").join(resourceId);
  const root = normalizeRoot(outRoot);
  if (entry.root) {
    return { path: posixPath.join(root, rel), isRoot: true };
  }
  return { path: posixPath.join(root, adapter.dir, rel), isRoot: false };
}

/**
 * T5c-1: resolves `adapter.shim.location` to an absolute path under
 * `outRoot`, honouring the same root-flag routing as `targetPath`/D4:
 * `root: true` -> `<outRoot>/<location>`; else -> `<outRoot>/<adapter.dir>/
 * <location>`. Callers are expected to have already checked
 * `adapter.shim?.mode === "bundled"`.
 */
export function shimBundlePath(adapter: Adapter, outRoot: string, location: string): string {
  const root = normalizeRoot(outRoot);
  const entry: LayoutEntry = { template: location, root: adapter.shim?.root ?? false };
  return entry.root ? posixPath.join(root, entry.template) : posixPath.join(root, adapter.dir, entry.template);
}

function parseLayout(client: string, layoutRaw: Record<string, unknown> | undefined): Record<string, LayoutEntry> {
  const layout: Record<string, LayoutEntry> = {};
  for (const [rc, spec] of Object.entries(layoutRaw ?? {})) {
    if (typeof spec === "string") {
      layout[rc] = { template: spec, root: false };
    } else if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
      const obj = spec as Record<string, unknown>;
      const tmpl = obj.path ?? obj.template;
      if (!tmpl) {
        throw new AdapterError(`${client}: content.layout.${rc} missing path/template`);
      }
      layout[rc] = { template: String(tmpl), root: Boolean(obj.root ?? false) };
    } else {
      throw new AdapterError(`${client}: content.layout.${rc} invalid spec (${JSON.stringify(spec)})`);
    }
  }
  return layout;
}

/** Parse `<adaptersRoot>/<client>.yml`. `adaptersRoot` is the directory
 * containing the adapter YAML files directly (T-canon-single-source: caller
 * decides the location — `tools/adapters` in the real repo, a fixture dir in
 * tests — this module no longer assumes "canonRoot/adapters"). Throws
 * `AdapterError` on any validation failure (missing file, malformed YAML,
 * schema violation). */
export function loadAdapter(adaptersRoot: string, client: string): Adapter {
  const root = normalizeRoot(adaptersRoot);
  const path = posixPath.join(root, `${client}.yml`);
  if (!existsSync(path)) {
    throw new AdapterError(`unknown client '${client}': ${path} not found`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf-8")) ?? {};
  } catch (exc) {
    throw new AdapterError(`${client}: broken adapter declaration (${(exc as Error).message})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterError(`${client}: adapter declaration must be a mapping`);
  }
  const data = raw as Record<string, unknown>;
  if (data.client !== client) {
    throw new AdapterError(
      `${client}: adapter 'client' field (${JSON.stringify(data.client)}) does not match filename`
    );
  }
  const dir = data.dir;
  if (typeof dir !== "string" || dir.length === 0) {
    throw new AdapterError(`${client}: adapter must declare non-empty 'dir'`);
  }
  let caps = data.capabilities;
  if (caps === undefined || caps === null) caps = [];
  if (!Array.isArray(caps) || !caps.every((c) => typeof c === "string")) {
    throw new AdapterError(`${client}: 'capabilities' must be a list of strings`);
  }

  const content = (data.content ?? {}) as unknown;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new AdapterError(`${client}: 'content' must be a mapping`);
  }
  const contentObj = content as Record<string, unknown>;
  const frontmatter = (contentObj.frontmatter ?? {}) as Record<string, any>;
  const layout = parseLayout(client, (contentObj.layout ?? {}) as Record<string, unknown>);

  const seed = (data.machine_seed ?? {}) as unknown;
  if (typeof seed !== "object" || seed === null || Array.isArray(seed)) {
    throw new AdapterError(`${client}: 'machine_seed' must be a mapping`);
  }
  const seedObj = seed as Record<string, unknown>;

  const shim = parseShim(client, data.shim);

  const insertsRaw = (contentObj.inserts ?? {}) as unknown;
  if (typeof insertsRaw !== "object" || insertsRaw === null || Array.isArray(insertsRaw)) {
    throw new AdapterError(`${client}: content.inserts must be a mapping`);
  }
  const roleInserts: Record<string, string> = {};
  for (const [k, v] of Object.entries(insertsRaw as Record<string, unknown>)) {
    roleInserts[k] = v === null || v === undefined ? "" : String(v);
  }

  return {
    client,
    dir,
    capabilities: Object.freeze([...new Set(caps as string[])].sort()),
    frontmatter,
    layout,
    machineSeedTemplate: (seedObj.template as string | null | undefined) ?? null,
    machineSeedLocation: String(seedObj.location ?? ""),
    machineSeedRoot: Boolean(seedObj.root ?? false),
    shim,
    roleInserts,
  };
}

/** T5c-1/T5c-2: `shim` is optional. Absent -> `null` (unchanged behaviour,
 * C5/L-1 — adapters without a shim declaration are not affected). Present ->
 * `mode` required and must be `bundled`|`native`; `location` string (default
 * ""); `root` bool (default false); `style` optional, must be
 * `in-process`|`command-hook` (default `"command-hook"` — preserves T5c-1
 * behaviour, no wrapper emission); `entry` optional string|null (default
 * `null` -> wrapper not emitted). Anything malformed -> `AdapterError`. */
function parseShim(client: string, raw: unknown): ShimDecl | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdapterError(`${client}: 'shim' must be a mapping`);
  }
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode;
  if (mode !== "bundled" && mode !== "native") {
    throw new AdapterError(`${client}: shim.mode must be 'bundled' or 'native', got ${JSON.stringify(mode)}`);
  }
  const styleRaw = obj.style;
  const style = styleRaw === undefined || styleRaw === null ? "command-hook" : styleRaw;
  if (style !== "in-process" && style !== "command-hook") {
    throw new AdapterError(
      `${client}: shim.style must be 'in-process' or 'command-hook', got ${JSON.stringify(styleRaw)}`
    );
  }
  const entryRaw = obj.entry;
  const entry = entryRaw === undefined || entryRaw === null ? null : String(entryRaw);
  return {
    mode,
    location: String(obj.location ?? ""),
    root: Boolean(obj.root ?? false),
    style,
    entry,
  };
}

/** Sorted list of clients by `<adaptersRoot>/*.yml` (determinism). Same
 * decoupled-location contract as `loadAdapter` (see above). */
export function discoverClients(adaptersRoot: string): string[] {
  const root = normalizeRoot(adaptersRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".yml"))
    .map((e) => e.name.slice(0, -4))
    .sort();
}
