// task-file frontmatter парсер (TS-порт логики gate_setup.py).
// Достаёт зону {allow, deny, testCmd, gateOptional} без PyYAML/subprocess.

export interface Zone {
  allow: string[];
  deny: string[];
  testCmd?: string;
  gateOptional: boolean;
}

function frontmatter(text: string): string {
  const m = text.match(/^\s*---\s*\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
}

function globList(fm: string, key: string): string[] {
  const m = fm.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1]);
}

function scalar(fm: string, key: string): string | undefined {
  const m = fm.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!m) return undefined;
  return m[1].replace(/\s+#\s.*$/, "").trim().replace(/^"|"$/g, "");
}

/** Парсит зону из текста task-file. Применяет те же правила, что gate_setup.py:
 *  .workflow/** всегда allow (lead-state), вычищается из deny. */
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
