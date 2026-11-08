/**
 * task-zone (phase-b1) — TS port (promoted to core, single implementation) of
 * `.omp/tools/_lib/task.ts` / `.opencode/lib/task.ts` (`parseZone`): reads a
 * task-file's YAML-ish frontmatter (`allow`/`deny`/`test-cmd`/`gate-optional`)
 * without PyYAML/subprocess, same logic as (the now-retired) `gate_setup.py`.
 *
 * `frontmatter`/`globList`/`scalar` are exported so `./gate-setup.ts` can
 * reuse them instead of keeping a private, drifting copy (contract L-1) —
 * `buildGateSetup`'s own behaviour (error message, `.workflow/**` auto-allow,
 * `DENY_STRIP` set, gate.cmd shape) is unchanged, only the three low-level
 * frontmatter helpers move here.
 */

export interface Zone {
  allow: string[];
  deny: string[];
  testCmd?: string;
  gateOptional: boolean;
}

export function frontmatter(text: string): string {
  const m = text.match(/^\s*---\s*\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
}

export function globList(fm: string, key: string): string[] {
  const m = fm.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
}

export function scalar(fm: string, key: string): string | undefined {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!m) return undefined;
  return m[1].replace(/\s+#\s.*$/, "").trim().replace(/^"|"$/g, "");
}

/** Parses the zone from task-file text. `.workflow/**` is always allow
 *  (lead-state) and stripped from deny. */
export function parseZone(text: string): Zone {
  const fm = frontmatter(text);
  const allow = globList(fm, "allow");
  let deny = globList(fm, "deny");
  if (allow.length && !allow.includes(".workflow/**")) allow.push(".workflow/**");
  deny = deny.filter((d) => ![".workflow/**", ".workflow/*", ".workflow"].includes(d));
  const testCmd = scalar(fm, "test-cmd");
  const gateOptional = (scalar(fm, "gate-optional") || "false").toLowerCase() === "true";
  return { allow, deny, testCmd, gateOptional };
}

export function scalarField(text: string, key: string): string | undefined {
  return scalar(frontmatter(text), key);
}
