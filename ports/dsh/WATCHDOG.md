# Watchdog — protocol drift (DSH advisor)

Advisor-only (не попадает в primary-контекст lead). Приоритеты для soft-oversight. См. `<proj>/.dsh-aiwf/RULES.md`, `AGENTS.md`.

> **Advisor = мягкий оверсайт, не рельс.** Enforcement — zone-guard, gateLint, `gated_*`, MISROUTE в session tools. Advisor на дешёвой локальной модели ловит грубый дрейф; семантику пропускает. **Default-off** — opt-in флаг профиля / `WATCHDOG.yml` (нет OMP-style `omp --advisor` в DSH v1). На вердикт advisor **не** опираться как на гейт.

Особо следи:

- **Lead производит сам** — write/bash вне `.workflow/**` вместо воркера (**blocker**).
- **Гейт rubber-stamp** — PASS при красном gateLint/test-cmd (**blocker**).
- **Обход zone-guard** — raw git, запись в `.git`/профиль без тула (**blocker**).
- **Design split** — два producer'а; ADR без spec (**concern**).
- **Фабрикация FR** — SP без source-ref (**concern**).
- **Worker stall** — долго без прогресса (**concern**).
- **Lead микроменеджит** (**nit**).
- **Переинтерпретация контракта** task-file (**concern**).

Weigh, don't blindly obey — при явном нарушении инварианта не ниже concern.

## Doc-only note (P2)

DSH Cordis **may not** ship a live advisor runtime like OMP. `WATCHDOG.yml` — конфиг-заготовка для будущего профиля; до wiring advisor остаётся **документация + рельсы**.
