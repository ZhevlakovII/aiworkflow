# Ключевые решения

Только короткие локи. Археология → `docs/archive/` (local-canon only; не в публичном installable surface). EN-зеркало → `docs/en/`.

## Publish

- Публичный dist = whitelist через `publish.sh` / `publish.ps1`; никогда `git push origin master` — только `bash publish.sh` или `.\publish.ps1`.

## Макро-флоу

**Дефолт:** `classify → design(spec) → roadmap → execute → gate → report` (design+roadmap для нетривиального; `trivial` может без design где class policy уже позволяет).

**Каталог стадий:** classify · design · roadmap · execute · gate · report. Имена `plan` / `scaffold` **не** в каталоге. Critic — opt-in (`critic`/`critic-opt-in`). Plan-тул — non-gate utility.

**Generation marker:** `generation: spec-roadmap` = новый путь (spec + roadmap, без product ADR). Absent / `generation: sp-adr` = legacy dual SP+ADR (+ optional scaffold lever). Exclusive path per contract — no mixed axes.

- Lead оркестрирует; не производит production-код/контент.
- Session-драйверы: `design_session` / `roadmap_session` / `execute_session`; `scaffold_session` только legacy + scaffold on. Judge/journal в `core/src/stage/` (общий ck12: strip id/supersedes/stage + `binds` на design-задачу; stage `roadmap`).
- Механический design-гейт = `gate-lint` / judge — красный ≠ PASS. New gen second axis = spec↔roadmap (`ac`/`phase` covers).
- Task-file (`.workflow/tasks/<id>.md`) — иммутабельный контракт.

## Роли

Текст канона: `canon/roles/` → в port `agents/` на install/render.

producer · critic · explorer · roadmapper · executor. `scaffolder` — retired на `spec-roadmap` (legacy only). Доменный агент — не канон: consumer overlay + запись заполненной project zonemap.

Резолв execute: нет карты / пустая / miss / deny / ambiguous → `executor`; ровно одно совпадение → имя из карты. Правила проекта на `executor` (и любом domain-акторе) важнее общих идиом. Produce ≠ decide: worker производит; critic находит; **лочит lead**.

## Рельсы L1–L3

Сырой `git commit|push|merge|reset|…` режет хук. Только rail CLI / gated-тулы (`core/src/rails/cli.ts`): commit → push → merge. На L1 — zone-check staged-путей.

## Zone-guards (что живо)

| Слой | Поведение |
|------|-----------|
| Path / Write | command-hook + адаптеры; allow-глобы active-zone |
| Bash / PS | мост в core guard (SWP / freeze) до regex-хвостов харнесса |
| SWP | `session_write_protected` — deny operator Write/Edit на protected stage-пути |
| Freeze | lead freeze при открытом execute |
| `by:judge` | зона/grants через judge, не freeform |
| Не живо | полный design rebind zone-guard (отложен навсегда) |

## Ограничения

- **SWP** — protected stage-файлы не правятся operator-тулами.
- **Freeze** — заморозка правок lead на время открытого execute.
- **by:judge** — зона/grants от судьи, не произвольный lead-write зоны.
- **Tasks** — create-only контракты; после авторства не переписывать.
- **Ports-as-SRC** — правим `ports/<client>/`; install штампует consumer `.<client>/`. В product-репо нет root dogfood.

## Порты

| Клиент | SRC | Dest у consumer | Installer |
|--------|-----|-----------------|-----------|
| omp | `ports/omp/` | `.omp/` или `~/.omp/agent` | live |
| cursor | `ports/cursor/` | `.cursor/` / `~/.cursor` | live |
| opencode | `ports/opencode/` | `.opencode/` (+ root `opencode.json`) | live |
| dsh | `ports/dsh/` | профиль `~/.dsh/profiles/<profile>/plugins/aiwf/` + проект `.dsh-aiwf/` | live |
| claude | `ports/claude/` | (unused by installer) | **not** in UX |

**Installer CLI (2026-11-13):** primary = `node tools/aiwf.ts` (`setup` \| `install` \| `uninstall` \| `head`); modes `full|key|soft|yolo`; soft never overwrites existing shared head; uninstall never touches `~/.config/aiwf`. Rejected flows: `claude` \| `codex` \| `both`.

**DSH P1 (2026-11-09):** `gated_merge`, `code_search`/`outline`/`callers` (ast-index), `hooks/dsh-telemetry.ts`, seed `delegation.yml`, setup `--flow all` → dsh.

**DSH P2 (2026-11-09):** `plan`/`synthesize`/`archive_spec`, `hooks/queue-runner` (`DSH_QUEUE`/`AIWF_QUEUE`), `WATCHDOG.md`+`WATCHDOG.yml` (doc-only advisor), fan-out **unsupported** (`backend.ts` fail-closed).

## Shared head + install lifecycle (2026-11-11)

### Shared head path

Resolve: `AIWF_CONFIG_HOME` → `$XDG_CONFIG_HOME/aiwf` → `~/.config/aiwf` (Windows: profile `.config/aiwf`, not %APPDATA%).
Contents: `models.yml` (providers, maxSubagents) + `config.yml` **only** `modelRoles`.
Theme stays in flavor OMP config. Product-block never copied into head.

### Legacy migrate + modelRoles sync

- If shared head absent and home agent has binding → one-shot import models.yml and/or modelRoles (no product-block).
- After **successful** copy: **strip** legacy home-agent models.yml. Failed copy does not delete.
- Do **not** strip modelRoles from OMP home `config.yml` as sole store.
- **Sync shared → OMP** modelRoles on seed, import, every setup_roles write (product block preserved).
- User edits shared head. OpenCode/DSH do not read the OMP mirror.
- Project `.omp/models.yml` and `.dsh-aiwf/models.yml` beat shared list.

### Bootstrap (not clone-root)

bootstrap downloads `aiworkflow-install.zip` + neighbor sha256, verifies, extracts to temp cache,
runs setup from cache, deletes cache **only on success**; on failure retains + prints path.
Does not delete existing `~/.aiworkflow`. Dest is self-contained with vendored `<dest>/core/src`.

### Flow membership

`omp|claude|opencode|cursor|dsh|all|both`. Default `all` **includes cursor + dsh**. `both` excludes them.
Harness CLI soft-optional on multi-flow (solo flow hard for that flow).

### Path rewrite (all flavors incl OpenCode)

OpenCode **does** rewrite core paths (stale INSTALL claim that it skips rewrite because `../lib` is relative is false).
All flavors rewrite to **vendored dest**, not clone/cache.

### Update / uninstall

- **Update** = re-bootstrap latest/pin with sum verify; head preserved; project models seed-if-absent preserved; modelRoles still synced OMP from head.
- **Uninstall** = installer flag: removes managed flavor trees incl vendored core + mirrored canon agents; may clear download cache;
  does **not** remove shared head / OMP modelRoles mirror without explicit head purge; does **not** delete `~/.aiworkflow` or user project seed-if-absent without purge.
