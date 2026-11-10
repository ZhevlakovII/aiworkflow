/**
 * core/src/zone/zonemap.ts (phase B2, contract L-1) — zone→tech→domain-agent
 * resolver, promoted into core from `.omp/tools/_lib/zonemap.ts` /
 * `.opencode/lib/zonemap.ts` (semantics preserved — see divergence note
 * below). Parses `.omp/zonemap.yml` / `.opencode/zonemap.yml`-shaped
 * documents: `map: [{glob,tech,agent}]`, `default: {agent}`,
 * `deny-domain: [{glob}]`.
 *
 * Both harness adapters are now thin re-export shims over this module
 * (contract L-4) — the old hand-rolled regex YAML parse (`.omp`/`.opencode`
 * originals) is retired in favour of the real YAML parser (`../render/yaml.ts`,
 * canon-subset, already used elsewhere in core) and `globToRegExp` from
 * `../classify/path-zone.ts` (the SAME glob engine `zone-check.ts` uses — no
 * third glob implementation, contract L-2 precedent).
 *
 * One documented semantic divergence from the pre-B2 harness resolver: probe-
 * path normalization (`norm`, below) now routes through `normalizePath`
 * (`../classify/path-zone.ts`), which — since T7-8 — lexically collapses
 * `.`/`..` segments before matching. The old harness `norm` (`zonecheck.ts`,
 * pre-B1) never did that collapse. No observable difference for any glob in
 * the real `.omp/zonemap.yml` / `.opencode/zonemap.yml` corpus (none contain
 * `.`/`..` segments) — flagged per contract, not a behavior change in
 * practice.
 */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "../render/yaml.ts";
import { globToRegExp, normalizePath } from "../classify/path-zone.ts";

export interface ZoneMapEntry {
  glob: string;
  tech: string;
  agent: string;
}

export interface ZoneMap {
  map: ZoneMapEntry[];
  defaultAgent: string;
  denyDomain: string[];
}

export interface ResolveAgentResult {
  agent: string;
  tech?: string;
  ambiguous: boolean;
  matched: string[];
  denied: string[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse a `zonemap.yml`-shaped document (real YAML, `../render/yaml.ts`) into a `ZoneMap`. */
export function parseZoneMap(text: string): ZoneMap {
  const doc = asRecord(parseYaml(text));

  const map: ZoneMapEntry[] = [];
  for (const rawEntry of asArray(doc.map)) {
    const entry = asRecord(rawEntry);
    const glob = asString(entry.glob);
    const tech = asString(entry.tech);
    const agent = asString(entry.agent);
    if (glob && tech && agent) map.push({ glob, tech, agent });
  }

  const defaultAgent = asString(asRecord(doc.default).agent) ?? "executor";

  const denyDomain: string[] = [];
  for (const rawEntry of asArray(doc["deny-domain"])) {
    const glob = asString(asRecord(rawEntry).glob);
    if (glob) denyDomain.push(glob);
  }

  return { map, defaultAgent, denyDomain };
}

/** Normalize a glob/path for zone-matching (see divergence note above — delegates to `normalizePath`, no repoRoot). */
function norm(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return normalizePath(trimmed) ?? trimmed.replace(/\\/g, "/");
}

/** Derive a concrete probe path from an allow-glob (cut the tail at the first `*`) to match against map-globs. */
function probePath(glob: string): string {
  let g = norm(glob).replace(/\*+.*$/, "");
  g = g.replace(/\/+$/, "");
  return g ? `${g}/__probe__` : "__probe__";
}

/**
 * Resolve a domain-agent from a task-zone's allow-globs.
 * `ambiguous=true` when the zone spans >1 distinct domain (lead decides, not
 * the model). `denied` lists allow-globs that fall under `deny-domain`
 * (legacy zone — flagged, not silently absorbed into a match).
 * Any denied allow-glob wins over partial domain matches: agent = defaultAgent
 * (executor), denied signal kept, stage not failed (roles-domain-collapse ADR).
 */
export function resolveAgent(allowGlobs: readonly string[], zm: ZoneMap): ResolveAgentResult {
  const denyRes = zm.denyDomain.map((g) => globToRegExp(g));
  const entries = zm.map.map((e) => ({ ...e, re: globToRegExp(e.glob) }));
  const hits = new Set<string>();
  const techs = new Set<string>();
  const denied: string[] = [];

  for (const raw of allowGlobs) {
    if (norm(raw) === ".workflow/**") continue; // lead-state, not a domain
    const probe = probePath(raw);
    if (denyRes.some((d) => d.test(probe))) {
      denied.push(raw);
      continue;
    }
    const e = entries.find((x) => x.re.test(probe));
    if (e) {
      hits.add(e.agent);
      techs.add(e.tech);
    }
  }

  const matched = [...hits];
  // Deny beats partial match of neighboring globs (ADR AD-keep-filled-routing-refine-denied).
  if (denied.length > 0) {
    return { agent: zm.defaultAgent, ambiguous: false, matched, denied };
  }
  if (matched.length === 1) return { agent: matched[0], tech: [...techs][0], ambiguous: false, matched, denied };
  if (matched.length === 0) return { agent: zm.defaultAgent, ambiguous: false, matched, denied };
  return { agent: zm.defaultAgent, ambiguous: true, matched, denied }; // mixed domains -> lead splits by zone
}

/** Hard load — throws if path missing/unreadable (diagnostic callers). */
export function loadZoneMap(path: string): ZoneMap {
  return parseZoneMap(readFileSync(path, "utf8"));
}

/** Empty map with executor default (missing-file / soft-fail shape). */
export function emptyZoneMap(): ZoneMap {
  return { map: [], defaultAgent: "executor", denyDomain: [] };
}

/**
 * Soft load for execute path: missing/unreadable file → null (never throws).
 * Callers resolve null as executor via emptyZoneMap / resolveExecuteAgent.
 */
export function tryLoadZoneMap(path: string): ZoneMap | null {
  try {
    return loadZoneMap(path);
  } catch {
    return null;
  }
}

/**
 * Execute-oriented resolve: missing zonemap file → executor, no throw/fail.
 * Denied / ambiguous still return executor with signals on the result.
 * Diagnostic CLI may still exit non-zero when a path is forced; this helper does not.
 */
export function resolveExecuteAgent(
  allowGlobs: readonly string[],
  zonemapPath: string,
): ResolveAgentResult {
  const zm = tryLoadZoneMap(zonemapPath) ?? emptyZoneMap();
  return resolveAgent(allowGlobs, zm);
}
