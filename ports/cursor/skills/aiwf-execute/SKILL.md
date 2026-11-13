---
name: aiwf-execute
description: Execute stage — judge begin → domain agent in zone → done → rail commit
---

1. Read task-file (`allow`, `test-cmd`, pointers). Task id = basename without `.md`.
   - On `generation: spec-roadmap`: consume locked **roadmap** pointer (+ locked spec). DoD/acceptance comes from the locked roadmap — do **not** re-author DoD on the execute twin.
   - Legacy: may still carry richer DoD on the execute task.
2. Judge begin:
   ```
   node "<clone>/core/src/stage/judge-cli.ts" execute-begin --task <task-file>
   ```
3. Resolve agent. Consumer may have `.cursor`, but zonemap often lives under `.omp` / project root — use project zonemap if present, else skip domain → `executor`:
   ```
   node "<clone>/core/src/zone/zonemap-cli.ts" --zonemap ".omp/zonemap.yml" --allow "<glob>" ...
   ```
   (Substitute `.opencode/zonemap.yml` or other project zonemap path when that is the consumer map. Missing zonemap → agent=`executor`.)
4. Write `.workflow/active-zone.json` `{"task":"<id>","allow":[...],"by":"judge"}` (UTF-8, no BOM).
5. Spawn subagent in zone; narrow return only. Follow roadmap AC/tests (spec-roadmap).
6. Judge done (`ok` if in-zone, else `violation`):
   ```
   node "<clone>/core/src/stage/judge-cli.ts" execute-done --task <task-file> --outcome ok|violation
   ```
7. Commit via rail (no `--gate` while zone active):
   ```
   node "<clone>/core/src/rails/cli.ts" commit -m "<msg>"
   ```
8. Delete `.workflow/active-zone.json`. Report files / zone / gate / commit.
