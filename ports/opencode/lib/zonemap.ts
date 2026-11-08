// zonemap adapter (phase-b2, contract L-4) — thin shim over core/src/zone/zonemap.ts.
// Parsing/matching logic now lives in core: the old hand-rolled regex YAML
// parse (port of OMP _lib/zonemap.ts) is retired in favour of the real YAML
// parser (core/src/render/yaml.ts) and globToRegExp (core/src/classify/path-
// zone.ts — the same glob engine zonecheck.ts already delegates to since
// phase-b1). Exported API (ZoneMapEntry, ZoneMap, parseZoneMap, resolveAgent,
// loadZoneMap) is UNCHANGED for existing callers — only the implementation
// moved. One documented semantic divergence (T7-8 lexical `.`/`..` collapse
// in the probe-path normalizer, absent from the old local `norm`) — see
// core's zonemap.ts doc-comment and the phase-b2 task return; no observable
// effect on the real .opencode/zonemap.yml corpus (no `.`/`..` globs).
export type { ZoneMapEntry, ZoneMap } from "../../../core/src/zone/zonemap.ts";
export { parseZoneMap, resolveAgent, loadZoneMap } from "../../../core/src/zone/zonemap.ts";
