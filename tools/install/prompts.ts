// prompts — interactive ask helpers for full/key modes (readline).
// Contract: AD-mode-table-and-resolver (full = all prompts; key = flavors + soft-skip + scope).

import * as fs from "node:fs";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

function openTty(): { in: fs.ReadStream; out: fs.WriteStream } | undefined {
  try {
    if (process.platform === "win32") return undefined;
    if (!fs.existsSync("/dev/tty")) return undefined;
    return {
      in: fs.createReadStream("/dev/tty"),
      out: fs.createWriteStream("/dev/tty"),
    };
  } catch {
    return undefined;
  }
}

async function withRl<T>(fn: (rl: readline.Interface) => Promise<T>): Promise<T> {
  const tty = !(stdin.isTTY && stdout.isTTY) ? openTty() : undefined;
  const rl = readline.createInterface({
    input: tty?.in ?? stdin,
    output: tty?.out ?? stdout,
  });
  try {
    return await fn(rl);
  } finally {
    rl.close();
    tty?.in.destroy();
    tty?.out.destroy();
  }
}

/** Ask a yes/no question. */
export async function askYesNo(question: string, defaultValue = false): Promise<boolean> {
  if (!(stdin.isTTY || openTty())) return defaultValue;
  return withRl(async (rl) => {
    const hint = defaultValue ? "Y/n" : "y/N";
    const ans = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (!ans) return defaultValue;
    if (ans === "y" || ans === "yes") return true;
    if (ans === "n" || ans === "no") return false;
    return defaultValue;
  });
}

/** Ask user to pick one of options. */
export async function askSelect<T extends string>(
  question: string,
  options: readonly T[],
  fallback?: T,
): Promise<T> {
  if (options.length === 0) throw new Error("askSelect: empty options");
  if (!(stdin.isTTY || openTty())) {
    return fallback !== undefined ? fallback : options[0]!;
  }
  return withRl(async (rl) => {
    console.log(question);
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
    const def = fallback ?? options[0]!;
    const ans = (await rl.question(`choice [default ${def}]: `)).trim();
    if (!ans) return def;
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
    if ((options as readonly string[]).includes(ans)) return ans as T;
    return def;
  });
}

/** Ask multi-select among options (comma / space separated numbers or names; empty = fallback/all). */
export async function askMultiSelect<T extends string>(
  question: string,
  options: readonly T[],
  fallback?: readonly T[],
): Promise<T[]> {
  if (options.length === 0) throw new Error("askMultiSelect: empty options");
  if (!(stdin.isTTY || openTty())) {
    return fallback !== undefined ? [...fallback] : [...options];
  }
  return withRl(async (rl) => {
    console.log(question);
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
    const defLabel = (fallback ?? options).join(",");
    const ans = (await rl.question(`select (comma/space; empty=${defLabel}): `)).trim();
    if (!ans) return fallback !== undefined ? [...fallback] : [...options];
    if (ans.toLowerCase() === "all") return [...options];
    const parts = ans.split(/[,\s]+/).filter(Boolean);
    const picked: T[] = [];
    for (const p of parts) {
      const n = Number(p);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        picked.push(options[n - 1]!);
        continue;
      }
      if ((options as readonly string[]).includes(p)) picked.push(p as T);
    }
    return picked.length > 0 ? [...new Set(picked)] : fallback !== undefined ? [...fallback] : [...options];
  });
}

/** Ask free-form text. */
export async function askText(question: string, defaultValue = ""): Promise<string> {
  if (!(stdin.isTTY || openTty())) return defaultValue;
  return withRl(async (rl) => {
    const ans = (await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `)).trim();
    return ans || defaultValue;
  });
}
