// gated_merge — L3 merge-рельс как нативный OMP-тул (Phase-1). Capability-probe в TS, git через pi.exec.
// Raw `git merge` блочит bash.patterns → модель зовёт этот тул. L3 = capability-gated: недостающая
// способность → INSUFFICIENT → autonomy capped (не мёржит вслепую).
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { ok, err } from "./_lib/result";

const RISKY = new Set(["security", "migration"]);

const factory: CustomToolFactory = (pi) => {
  const git = (args: string[]) => pi.exec("git", args, { cwd: pi.cwd });
  const verify = async (ref: string) => (await git(["rev-parse", "--verify", ref])).code === 0;

  return {
    name: "gated_merge",
    label: "Gated merge (L3)",
    loadMode: "essential",
    description:
      "Автономный merge (raw `git merge` заблокирован). CAPABILITY-PROBE по классу: green-gate / clean-rebase / " +
      "forced-critic (feature,refactor) / rollback. Недоступна → INSUFFICIENT (мёржит человек). security/migration — нужен allowRisky. " +
      "Секвенс: probe → merge --no-ff → свежий gate на результате → RED? откат.",
    parameters: pi.zod.object({
      branch: pi.zod.string().describe("feature-ветка для merge"),
      base: pi.zod.string().optional().describe("базовая ветка (дефолт main/master)"),
      class: pi.zod.string().optional().describe("класс задачи: feature|refactor|trivial|security|migration"),
      findings: pi.zod.string().optional().describe("critic findings-файл (forced-critic для feature/refactor)"),
      gate: pi.zod.string().optional().describe("gate-команда на merge-результат (дефолт .workflow/gate.cmd)"),
      allowRisky: pi.zod.boolean().optional().describe("явно разрешить L3 для security/migration"),
    }),
    async execute(_id, params, _u, _ctx, _sig) {
      const klass = (params.class || "feature").toLowerCase();
      const branch = params.branch;

      if ((await git(["rev-parse", "--git-dir"])).code !== 0) return err("не git-репо");

      let base = params.base || "";
      if (!base) {
        for (const b of ["main", "master"]) if (await verify(b)) { base = b; break; }
      }
      if (!base) return err("не найдена base-ветка (main/master); задай base");
      for (const ref of [base, branch]) if (!(await verify(ref))) return err("ветка не найдена: " + ref);

      // gate резолв
      let gate = params.gate || "";
      if (!gate) {
        const gp = path.resolve(pi.cwd, ".workflow/gate.cmd");
        if (fs.existsSync(gp)) gate = fs.readFileSync(gp, "utf8").trim();
      }

      const header = `=== L3 MERGE PROBE: ${branch} → ${base} (class=${klass}) ===`;

      // CLASS-GATE
      if (RISKY.has(klass) && !params.allowRisky)
        return err(`${header}\nкласс '${klass}' — L3 запрещён по умолчанию (нужен allowRisky). ОТКАЗ.`);

      // CAPABILITY-PROBE
      const caps: string[] = [];
      const insufficient: string[] = [];

      if (gate) caps.push("green-gate");
      else insufficient.push("green-gate: нет gate-команды (.workflow/gate.cmd)");

      const mt = await git(["merge-tree", "--write-tree", base, branch]);
      if (mt.code === 0) caps.push("clean-rebase");
      else if (mt.code === 1) insufficient.push("clean-rebase: конфликты base←branch");
      else insufficient.push(`clean-rebase: merge-tree недоступен (code=${mt.code})`);

      if (klass === "feature" || klass === "refactor") {
        if (!params.findings) insufficient.push("forced-critic: нет critic-evidence (findings)");
        else {
          const fp = path.resolve(pi.cwd, params.findings);
          if (!fs.existsSync(fp)) insufficient.push("forced-critic: findings-файл не найден");
          else {
            const blockers = fs.readFileSync(fp, "utf8").split("\n").filter((l) => l.trim().toLowerCase().startsWith("[blocker]"));
            if (blockers.length) insufficient.push(`forced-critic: critic нашёл ${blockers.length} blocker(ов)`);
            else caps.push("forced-critic (0 blocker)");
          }
        }
      }
      if (klass === "migration") caps.push("rollback (reset --hard pre-ref)");

      const probe = `${header}\n  capabilities: ${caps.join(", ") || "—"}`;
      if (insufficient.length)
        return err(`${probe}\n  INSUFFICIENT:\n${insufficient.map((i) => "   [x] " + i).join("\n")}\nL3 INSUFFICIENT → autonomy capped. ОТКАЗ (мёржит человек/L2-PR).`);

      if ((await git(["status", "--porcelain"])).stdout.trim())
        return err(`${probe}\nGUARD: дерево грязное — очисти перед L3-merge. ОТКАЗ.`);

      const cur = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if ((await git(["checkout", base])).code !== 0) return err("checkout base не удался");
      const baseRef = (await git(["rev-parse", "HEAD"])).stdout.trim();

      const m = await git(["merge", "--no-ff", "--no-edit", branch]);
      if (m.code !== 0) {
        await git(["merge", "--abort"]);
        await git(["checkout", cur]);
        return err(`${probe}\nMERGE конфликт (probe разошёлся с реальностью) → abort. ОТКАЗ.`);
      }

      // FRESH GATE на merge-результате
      if (gate) {
        const g = await pi.exec("sh", ["-c", gate], { cwd: pi.cwd });
        if (g.code !== 0) {
          await git(["reset", "--hard", baseRef]); // ROLLBACK
          await git(["checkout", cur]);
          return err(`${probe}\nGATE RED (exit ${g.code}) — merge ОТКАЧЕН (reset ${baseRef.slice(0, 8)}). ОТКАЗ.\n${g.stdout}`);
        }
      }
      const merged = (await git(["rev-parse", "HEAD"])).stdout.trim();
      return ok(`${probe}\nL3 MERGED: ${branch} → ${base} (${merged.slice(0, 8)}). pre-ref ${baseRef.slice(0, 8)} для отката.`);
    },
  };
};

export default factory;
