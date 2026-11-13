# AI Workflow — DSH (Cordis) control point

Порт OMP-контракта для DeepSeek Harness (`dsh`). Плагин живёт в профиле `~/.dsh/profiles/<profile>/plugins/aiwf/`; **проектный overlay** — `<proj>/.dsh-aiwf/` (AGENTS, agents, zonemap).

## Роли (`.dsh-aiwf/agents/`)
producer · critic · explorer · **roadmapper** · executor · (domain overlays). `scaffolder` — retired на `generation: spec-roadmap` (legacy + lever only). Резолв домена — `execute_session` + `.dsh-aiwf/zonemap.yml`.

## Стадии
**Дефолт** (`generation: spec-roadmap`): `classify → design(spec) → roadmap → execute → gate → report`

**Design** — только `design_session(begin|gate|critic-record|lock)` + spawn producer/critic; spec-only на new generation.  
**Roadmap** — `roadmap_session(begin|check|done)` + `roadmapper` (fail-closed unless spec-roadmap).  
**Execute** — `execute_session(begin|check|done)` + executor/domain; consume locked roadmap.  
**Scaffold** — legacy only (`scaffold_session`); refuse на `spec-roadmap`.

MISROUTE fail-closed: session tool отказывает при неверном `stage` в task-file.

## Рельсы (L1–L2)
- `gated_commit` / `gated_push` — единственные пути к commit/push (raw git deny в `tools/pre-execute`).
- Логика зоны/гейта — `core/` (judge, gateLint, rails).

## Enforcement
Cordis `tools/pre-execute` → `dshGuardDecision` (core). Worker зона — `.workflow/active-zone.json` (UTF-8, no BOM).

## P2 (autonomy utilities)

- `plan` / `synthesize` — one-shot вне автоконтура; nested harness: `DSH_ONESHOT=1`.
- `archive_spec` — living spec merge; reconcile/dedupe opt-in.
- Queue: `DSH_QUEUE=1` или `AIWF_QUEUE=1` — см. README (inject best-effort).
- WATCHDOG — doc-only advisor priorities (`.dsh-aiwf/WATCHDOG.md`).
- **Fan-out:** unsupported — только native `dsh` + lead spawn (`delegation.yml`).

## Install
`bash tools/install-dsh.sh --target <proj>` или `setup -Flow dsh`. См. `ports/dsh/README.md`.
