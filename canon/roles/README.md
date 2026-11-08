# canon/roles/ — тир1 (writable canon), единственный источник ролей

Тир: 1 — `canon/` (writable, только данные). См. AD-three-tier-partition,
AD-canon-dir-layout.

**Подключено к рантайму (T-canon-single-source).** Это ЕДИНСТВЕННЫЙ
источник role-defs: `producer`, `critic`, `explorer`, `scaffolder`,
`executor` + 6 обобщённых домен-executor'ов (`kmp-developer`, `go-developer`,
`gradle-developer`, `ktor-developer`, `rust-developer`, `swift-developer`)
— 11 ролей. `scaffolder` — только стадия scaffold (каркас); reuse на
execute запрещён prose роли.
Frontmatter и тело — нейтральные: без имён инструментов/провайдеров, без
проектных путей/имён. Портовые различия (frontmatter-формат, tool-имена,
ambient-ignore/discovery/zone-guard/commit-rail формулировки) — НЕ в этих
файлах; они выражены как `{{insert:KEY}}`-плейсхолдеры, подставляемые
рендером (`core/src/render/engine.ts` `substituteInserts`) из
`tools/adapters/<client>.yml` `content.inserts` (+ `tool_map`/
`tool_overrides`/`model_map`/`tools_universe` — маппинг тул-имён/модель-алиасов
per client). Портовые `agents/*.md` (`.omp/agents/`, `.claude/agents/`,
`.opencode/agents/`) для перечисленных ролей — СГЕНЕРИРОВАННЫЙ артефакт:
`node core/src/render/cli.ts render --out .` из корня репо. Ручная правка
портовой копии = drift, ловится `core/test/canon-render-drift.test.ts`.
Порты здесь не правятся — проекция после фазы 1 (canon+core).

**Политика ролей (intake human-review):** model-`critic` — **default off**,
включение только явным opt-in (task frontmatter / CLI `--critic`); роль
`critic` остаётся рычагом, не удаляется. **Design** = проектирование/разбивка
(spec±ADR) с grounding через explorer/inventory — **не** harness Plan Mode.
Макро-стадия `plan` (нарезка зон/тикетов) ≠ Plan Mode харнесса. Prose роли
целит ≤~60 строк; пайплайн стадий / class→critic таблицы — в механике, не
в role prose.

Портовые файлы без нейтрального канон-смысла (OpenCode `.opencode/agents/
aiwf.md` — lead tool-gate, специфичный для OpenCode-примary-агента) в каноне
НЕ представлены — рендер их не трогает и не удаляет (AD-canon-superset-
capability: канон — надмножество, не диктует состав портового каталога).

Проектные (target-специфичные) домен-агенты — НЕ здесь и НЕ в каноне вообще:
наполнение строго в самом проекте (`<project>/<port>/agents/<role>.md` —
project overlay, резолвится первым, см. `core/src/roles/resolve.ts`).
