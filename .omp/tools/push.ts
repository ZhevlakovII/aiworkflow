// gated_push — L2 push/PR-рельс как нативный OMP-тул (Phase-1). Guards в TS, git/gh через pi.exec.
// Raw `git push` блочит bash.patterns → модель зовёт этот тул.
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { ok, err } from "./_lib/result";

const factory: CustomToolFactory = (pi) => {
  const git = (args: string[]) => pi.exec("git", args, { cwd: pi.cwd });
  return {
    name: "gated_push",
    label: "Gated push",
    loadMode: "essential",
    description:
      "Единственный путь к push (raw `git push` заблокирован; `git merge` — отдельный merge-тул). " +
      "Гейт доставки: ветка не protected, дерево чистое, есть коммиты вперёд. Пушит feature-ветку -u; опц. PR через gh.",
    parameters: pi.zod.object({
      remote: pi.zod.string().optional().describe("remote (дефолт origin)"),
      protected: pi.zod.string().optional().describe("protected-ветки csv (дефолт main,master)"),
      pr: pi.zod.boolean().optional().describe("открыть PR через gh после push"),
      base: pi.zod.string().optional().describe("базовая ветка PR (дефолт main)"),
      title: pi.zod.string().optional(),
      body: pi.zod.string().optional(),
    }),
    async execute(_id, params, _u, _ctx, _sig) {
      const remote = params.remote || "origin";
      const protectedSet = new Set((params.protected || "main,master").split(",").map((s) => s.trim()).filter(Boolean));

      if ((await git(["rev-parse", "--git-dir"])).code !== 0) return err("не git-репо");
      const remotes = (await git(["remote"])).stdout.split(/\s+/).filter(Boolean);
      if (!remotes.includes(remote)) return err(`remote '${remote}' не настроен (есть: ${remotes.join(",") || "нет"})`);

      const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if (protectedSet.has(branch)) return err(`ветка '${branch}' protected — автономный push запрещён (L3). Переключись на feature-ветку.`);
      if (!branch || branch === "HEAD") return err("detached HEAD — нет ветки для push");

      const porcelain = (await git(["status", "--porcelain"])).stdout.trim();
      if (porcelain) {
        return err("дерево грязное (ungated-изменения мимо commit-рельса):\n" +
          porcelain.split("\n").slice(0, 20).map((l) => "  " + l).join("\n") +
          "\nЗакоммить через gated_commit или почисти.");
      }

      const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
      if (up.code === 0) {
        const ahead = (await git(["rev-list", "--count", `${up.stdout.trim()}..HEAD`])).stdout.trim();
        if (ahead === "0") return err(`нет коммитов вперёд ${up.stdout.trim()} — нечего пушить`);
      }

      const push = await git(["push", "-u", remote, branch]);
      if (push.code !== 0) return err("PUSH FAILED:\n" + push.stderr);
      let out = `PUSHED ${branch} → ${remote}\n${push.stderr || push.stdout}`;

      if (params.pr) {
        const base = params.base || "main";
        const title = params.title || `${branch}: automated change (L2, human approves merge)`;
        const body = params.body || "Autonomous L2 flow: commits went through the zone-gated commit-rail. Human approves merge.";
        const pr = await pi.exec("gh", ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body], { cwd: pi.cwd });
        if (pr.code !== 0) return err(out + "\nPR CREATE FAILED (push прошёл):\n" + pr.stderr);
        out += "\nPR OPENED:\n" + pr.stdout;
      }
      return ok(out);
    },
  };
};

export default factory;
