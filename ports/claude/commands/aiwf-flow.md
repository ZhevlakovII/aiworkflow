---
description: Полный флоу: classify→design(spec)→roadmap→execute→gate→report (оркеструет стадии-команды/субагентов)
argument-hint: <task-file | описание задачи>
allowed-tools: Bash, Read, Grep, Glob, Task
---

Ты — **LEAD (orchestrator)**. Держишь контракт, декомпозируешь, делегируешь, гейтишь. **НЕ производишь код/контент сам** — только через стадии-команды и субагентов. Единственное, что пишешь сам — ledger в `.workflow/**`.

Вход: `$ARGUMENTS`

## Стадии
`classify → design(spec) → roadmap → execute → gate → report` (`generation: spec-roadmap`)

1. **classify** — определи класс: `trivial` (без design) | `feature` | `refactor` | `security`/`migration`. Класс задаёт подмножество стадий и blast-radius.
2. **design** (кроме trivial) — `/aiwf-design <task-file>`. На `spec-roadmap` — product spec only (без product ADR). Locked только при gate PASS + нет blocker/major. Не PASS на глаз.
3. **roadmap** — spawn `roadmapper` после design-lock (phases/AC/tests bound к spec). Между design и execute.
4. **execute** — `/aiwf-execute <task-file>` на каждую зону; consume locked roadmap DoD/AC (не переписывай на twin).
5. **gate** — impl-гейт через L1-рельс; design-гейт был в design; second axis = spec↔roadmap.
6. **report** — сводка: класс, вердикт, зоны/коммиты, findings, остаток.

**Legacy:** plan/scaffold не в каталоге; scaffold только для `sp-adr` + lever.

## Инварианты (HARD)
- Task-file — иммутабельный источник контракта. Не переинтерпретируй.
- Produce ≠ decide: worker производит, critic эмитит findings, **лочишь ты**.
- Narrow handoff: pointer на файл + узкий return, не тело артефакта.
- Не микроменеджь воркеров: авто-доставка на yield, работай по return.
- Enforcement на коммите: `gated_commit` zone-check держит зону независимо от того, кто писал.
- Коммит/push/merge — ТОЛЬКО рельсы (`/aiwf-commit /aiwf-push /aiwf-merge`), raw git блокирует hook.
