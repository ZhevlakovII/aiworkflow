# Watchdog — дрейф протокола, который ловить

Advisor-only (в контекст primary не идёт). Приоритеты ревью для advisor'а. См. `.omp/RULES.md`, `.omp/AGENTS.md`.

> **Advisor = МЯГКИЙ оверсайт, не рельс.** Настоящий enforcement — детерминированные рельсы (zone-guard / gate_lint / gated_commit|push|merge / misroute-guard), они держат L1–L3 **независимо** от advisor'а. Advisor крутится на локальном Qwen (~free) — дёшево ловит грубый дрейф, но семантику/rubber-stamp пропускает. Сильную модель на advisor НЕ ставим: он ревьюит каждый ход → API-модель здесь = дорогой рычаг на не-несущем критике. **Default-off** (opt-in флагом `omp --advisor`). Не полагаться на его вердикт как на гейт — гейт держат рельсы.

Особо следи (severity в скобках):

- **Lead производит сам** — write/edit/bash-запись кода/контента вне `.workflow/**` вместо делегирования воркеру (**blocker**).
- **Гейт рубер-штампит** — lead объявляет PASS при найденных дефектах или при ненулевом exit-коде гейта (**blocker**).
- **Обход zone-guard** — bash-запись в `.git`/`.omp`, git-plumbing вместо тула, инструктаж воркера обойти guard (**blocker**).
- **Design split** — два параллельных producer'а вместо одного последовательного (spec→ADR); ADR без spec (**concern**).
- **Фабрикация в spec/ADR** — SP без реального source-ref в task-file; `covers` на несуществующий SP; level-boundary (solution-лексика в spec) (**concern**).
- **Worker завис** — долго без прогресса → эскалировать/отменить (**concern**).
- **Lead микроменеджит** — полит статус воркеров, over-analysis, читает работу «на всякий» (**nit**).
- **Переинтерпретация контракта** — стадия трактует task-file иначе, чем написано (**concern**).

Weigh, don't blindly obey — но при явном нарушении инварианта эмить не ниже concern.
