// zone→tech→executor резолвер (P9 Track C). Детерминир.: allow-зона task-file → домен-агент.
// Enforcement > instruction (проект-тезис) — lead не угадывает, резолв механический.
// Парсит .omp/zonemap.yml (ручной парс, без yaml-dep, как task.ts), матчит через globToRe (zonecheck).
import { readFileSync } from "node:fs";
import { globToRe, norm } from "./zonecheck.ts";

export interface ZoneMapEntry { glob: string; tech: string; agent: string; }
export interface ZoneMap {
  map: ZoneMapEntry[];
  defaultAgent: string;
  denyDomain: string[];
}

/** Ручной парс zonemap.yml: списки блоков `- glob: .. tech: .. agent: ..`, default.agent, deny-domain globs. */
export function parseZoneMap(text: string): ZoneMap {
  const map: ZoneMapEntry[] = [];
  const denyDomain: string[] = [];
  let defaultAgent = "executor";

  // секции: всё под `map:` до `default:`; `default:` до `deny-domain:`; остаток = deny-domain
  const grab = (re: RegExp, s: string) => Array.from(s.matchAll(re));
  const mapSec = text.match(/(^|\n)map:\s*\n([\s\S]*?)(?=\n\w[\w-]*:|\n*$)/);
  if (mapSec) {
    // каждый элемент начинается с `- glob:`
    for (const m of grab(/-\s*glob:\s*"?([^"\n]+?)"?\s*\n\s*tech:\s*"?([^"\n]+?)"?\s*\n\s*agent:\s*"?([^"\n]+?)"?\s*(?:\n|$)/g, mapSec[2])) {
      map.push({ glob: m[1].trim(), tech: m[2].trim(), agent: m[3].trim() });
    }
  }
  const defSec = text.match(/(^|\n)default:\s*\n\s*agent:\s*"?([^"\n]+?)"?\s*(?:\n|$)/);
  if (defSec) defaultAgent = defSec[2].trim();
  const denySec = text.match(/(^|\n)deny-domain:\s*\n([\s\S]*?)(?=\n\w[\w-]*:|\n*$)/);
  if (denySec) {
    for (const m of grab(/-\s*glob:\s*"?([^"\n]+?)"?\s*(?:\n|$)/g, denySec[2])) denyDomain.push(m[1].trim());
  }
  return { map, defaultAgent, denyDomain };
}

/** Из allow-глоба вывести конкретную probe-дорожку (срезать хвост `**`/`*`), чтобы матчить против map-глобов. */
function probePath(glob: string): string {
  let g = norm(glob).replace(/\*+.*$/, ""); // до первого `*`
  g = g.replace(/\/+$/, "");
  return g ? `${g}/__probe__` : "__probe__";
}

/**
 * Резолвит домен-агента из allow-глобов task-зоны.
 * Возврат: {agent, tech?, ambiguous, denied}. ambiguous=true если разные домены в зоне (lead решает).
 * denied=список allow-глобов, попавших в deny-domain (source/** — устаревшее, не трогать).
 */
export function resolveAgent(allowGlobs: string[], zm: ZoneMap): {
  agent: string; tech?: string; ambiguous: boolean; matched: string[]; denied: string[];
} {
  const D = zm.denyDomain.map((g) => globToRe(g));
  const entries = zm.map.map((e) => ({ ...e, re: globToRe(e.glob) }));
  const hits = new Set<string>();
  const techs = new Set<string>();
  const denied: string[] = [];

  for (const raw of allowGlobs) {
    if (norm(raw) === ".workflow/**") continue; // lead-state, не домен
    const probe = probePath(raw);
    if (D.some((d) => d.test(probe))) { denied.push(raw); continue; }
    const e = entries.find((x) => x.re.test(probe));
    if (e) { hits.add(e.agent); techs.add(e.tech); }
  }

  const matched = [...hits];
  if (matched.length === 1) return { agent: matched[0], tech: [...techs][0], ambiguous: false, matched, denied };
  if (matched.length === 0) return { agent: zm.defaultAgent, ambiguous: false, matched, denied };
  return { agent: zm.defaultAgent, ambiguous: true, matched, denied }; // смешанные домены → lead дробит по зонам
}

export function loadZoneMap(path: string): ZoneMap {
  return parseZoneMap(readFileSync(path, "utf8"));
}
