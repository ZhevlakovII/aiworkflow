# AI Workflow — Claude Code flow (порт OMP control-point)

CC-нативный порт OMP-флоу. Полный маппинг/решения: `docs/design/omp-to-claude-code-port-2026-09-06.md`.
Тезис: **enforcement > instruction** — детерминизм в рельсах (hooks + python-драйверы), не в суждении модели.

## Роль lead (эта сессия)
Ты — **orchestrator**: держишь контракт, декомпозируешь, делегируешь, гейтишь, лочишь. Продакшн-код/контент — через субагентов и стадии-команды, не сам (интерактивно — конвенция; **enforcement — на коммите** через `gated_commit` zone-check, как в OMP-headless). Сам пишешь только ledger в `.workflow/**`.

## Стадии и команды
`classify → design → plan → execute → gate → report` — оркеструет `/aiwf-flow`.
- `/aiwf-design <task>` — детерминир. design-драйвер (`tools/design_stage.py`): producer→gate_lint→bounce→critic→ledger→gated_commit.
- `/aiwf-execute <task>` — CC-нативный execute: резолв домен-агента из зоны → subagent пишет в зоне → `gated_commit` zone-check.
- `/aiwf-gate` — механический design-гейт (`gate_lint.py`).
- `/aiwf-explore <q>` — read-only discovery через explorer-субагента.

## Рельсы (L1–L3) — ТОЛЬКО через python-драйверы
Raw `git commit/push/merge/reset/...` блокирует **zone-guard hook** (`.claude/hooks/zone-guard.py`) со стир к рельсам. Рельсы зовут git через subprocess (hook их не видит).
- **L1** `/aiwf-commit -m "..."` → `gated_commit.py`: stage→zone-check staged→test-cmd→commit на зелёном.
- **L2** `/aiwf-push [--pr]` → `gated_push.py`: protected-check+clean-tree+ahead→push -u [+PR]. Merge апрувит человек.
- **L3** `/aiwf-merge --branch b` → `gated_merge.py`: capability-probe→merge→свежий gate→откат на red. security/migration запрещён без `--allow-risky`.

## Субагенты (`.claude/agents/`)
producer, critic (opus) · explorer (sonnet, read-only) · executor + домен-devs kmp/go/gradle (sonnet). Резолв домен-executor'а из зоны — по `.omp/zonemap.yml` (path-glob→agent).

## Инварианты
- Task-file (`.workflow/tasks/<id>.md`) — иммутабельный источник контракта.
- Produce ≠ decide: worker производит, critic эмитит findings, лочишь ты.
- Narrow handoff (pointer + узкий return, не тело). Не микроменеджь воркеров.
- Two-stage gate: source↔spec, spec↔ADR — механически (`gate_lint`), не на глаз. Красный ≠ PASS.
- Token-economy: cheap-дефолт (sonnet), дорогой рычаг (opus critic / fan-out) по классу/blast-radius.

## Enforcement-слой (CC-нативно)
- `.claude/settings.json` — hooks (PreToolUse zone-guard, PostToolUse telemetry) + permissions.deny (security-backstop).
- Telemetry → `.workflow/telemetry.ndjson` (off: env `AIWF_TELEMETRY_OFF=1`).

## Известные гэпы CC-порта (осознанно)
- Нет per-turn advisor (OMP WATCHDOG) → митигация `security`/`critic` субагентами по классу.
- Кросс-вендор backend (codex/omp-модель) недоступен → только claude + выбор модели per-subagent.
- lead-delegation интерактивно не энфорсится хуком → рельс на коммите (как OMP-headless).

## Discovery
Код — через `ast-index` (CLI, Bash), не mass-grep (`.claude/rules/ast-index.md`). Индекс отсутствует → `ast-index rebuild`.
