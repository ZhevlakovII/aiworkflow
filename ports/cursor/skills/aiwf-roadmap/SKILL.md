---
name: aiwf-roadmap
description: Roadmap stage — judge begin → roadmapper in zone → check → done → rail commit
---

Requires task `generation: spec-roadmap` (legacy sp-adr → use `aiwf-scaffold` only with scaffold lever).

1. Read task-file (`allow`, roadmap DoD/AC). Task id = basename without `.md`. Confirm generation is `spec-roadmap`.
2. Judge begin:
   ```
   node "<clone>/core/src/stage/judge-cli.ts" roadmap-begin --task <task-file>
   ```
3. Write `.workflow/active-zone.json` `{"task":"<id>","allow":[...],"by":"judge"}` (UTF-8, no BOM).
4. Spawn subagent `roadmapper` (fixed; no zonemap domain resolve) in zone; narrow return only.
5. Zone check staged vs allow (diagnostic; no judge event):
   ```
   node "<clone>/core/src/zone/zone-check-cli.ts" --allow "<csv>" [--deny "<csv>"] --staged
   ```
6. Judge done (`ok` if zone clean, else `violation`):
   ```
   node "<clone>/core/src/stage/judge-cli.ts" roadmap-done --task <task-file> --outcome ok|violation
   ```
7. Commit via rail (no `--gate` while zone active):
   ```
   node "<clone>/core/src/rails/cli.ts" commit -m "<msg>"
   ```
8. Delete `.workflow/active-zone.json`. Report files / zone / gate / commit.
