// zone-check (TS-порт tools/zone_check.py) — enforcement ВНУТРИ OMP, не python-subprocess.
// Каждый путь: матчит ≥1 allow-glob И ни один deny-glob, иначе violation.
// Globs gitignore-подобные: ** (любые сегменты), * (в сегменте), ?.

export function globToRe(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, "/");
  const out: string[] = ["^"];
  let i = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g.slice(i, i + 2) === "**") {
        out.push(".*");
        i += 2;
        if (i < g.length && g[i] === "/") i += 1; // `**/` съедает слэш
        continue;
      }
      out.push("[^/]*");
    } else if (c === "?") {
      out.push("[^/]");
    } else {
      out.push(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    i += 1;
  }
  out.push("$");
  return new RegExp(out.join(""));
}

export function norm(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** Возвращает список violation-строк (пусто = чисто). allow обязателен. */
export function zoneCheck(paths: string[], allow: string[], deny: string[]): string[] {
  const A = allow.filter((x) => x.trim()).map(globToRe);
  const D = deny.filter((x) => x.trim()).map(globToRe);
  const ps = paths.map(norm).filter((p) => p);
  const violations: string[] = [];
  for (const p of ps) {
    if (D.some((d) => d.test(p))) violations.push(`${p}: matches deny-zone`);
    else if (!A.some((a) => a.test(p))) violations.push(`${p}: вне allow-zone`);
  }
  return violations;
}
