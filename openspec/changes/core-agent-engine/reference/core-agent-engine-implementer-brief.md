# Motor de agentes en Core (v2): briefing para el implementador

Estado: **briefing preparado**. Fecha: 26 de septiembre de 2026. Este documento está escrito para quien vaya a implementar el plan sin haber participado en su diseño, sea una persona o un asistente de IA (por ejemplo, una sesión de Codex o de Claude Code). Léelo completo antes de tocar código.

## 1. Qué se va a construir, en una frase

Un motor de ejecución de grafos de agentes dentro de `specrails-core`, nativo de LangGraph y con checkpoint SQLite, que ejecuta **todos** los tipos de paso (turnos de rol, prompts libres a Claude/Codex/Gemini/Kimi, comandos shell, verificación con receipts, OpenSpec, decisores, condiciones, interrupciones humanas, fan-out y subgrafos); y la conversión del Loop Builder de `specrails-desktop` en el editor y almacén de las definiciones JSON de esos grafos, de modo que Desktop deja de ejecutar pasos y se limita a diseñar specs y grafos, lanzar, observar y entregar.

## 2. Documentos y orden de lectura

| Documento | Qué contiene | Cuándo leerlo |
|---|---|---|
| [`core-agent-engine.md`](core-agent-engine.md) | El plan: objetivo, diagnóstico verificado del código actual, decisiones y su justificación, arquitectura objetivo, etapas, riesgos, qué no hacer, decisiones tomadas y preguntas abiertas | Primero, completo |
| [`core-agent-engine-contracts.md`](core-agent-engine-contracts.md) | El contrato técnico: formato de definición, estado, piezas, semántica de ejecución, tablas SQLite, CLI, eventos, ficheros congelados, compatibilidad, correspondencia con el motor actual | Segundo, completo; después como referencia constante. **Manda sobre el plan** si discrepan |
| [`core-agent-engine-tasks-core.md`](core-agent-engine-tasks-core.md) | Bloques C0..C10 de Core con ficheros, firmas, tests y criterios de aceptación | Al empezar cada bloque de Core |
| [`core-agent-engine-tasks-desktop.md`](core-agent-engine-tasks-desktop.md) | Bloques D0..D8 de Desktop | Al empezar cada bloque de Desktop |
| `AGENTS.md` y `CLAUDE.md` de cada repositorio | Reglas de trabajo del repositorio (mapa de módulos, invariantes, verificación) | Antes del primer commit en ese repositorio |
| `specrails-core/docs/agent-runtime.md` | Cómo funciona el runtime actual (legado) que se conserva hasta Core 7 | Antes de C2 |
| `specrails-desktop/docs/internals/programmatic-agent-runtime.md`, `interactive-jobs.md`, `loop-step-log-explorer.md`, `safe-pr-review-flow.md`, `agent-runtime-framework-evaluation.md` | Cómo Desktop lanza y observa hoy a Core, cómo funcionan los loops y la entrega | Antes de D1 |

Regla de precedencia: código actual > contrato > tareas > plan, en el sentido de que si descubres que el código real difiere de lo que dice un documento, **no adaptes el código al documento sin pensar**: comprueba cuál es correcto, corrige el documento en el mismo commit y anota el hallazgo en la sección de decisiones del plan. Los números de línea de los documentos corresponden a Core 6.0.0 y Desktop 2.57.0; si `main` avanzó, localiza el símbolo por nombre.

## 3. Contexto mínimo del sistema

- **Dos repositorios, una frontera.** Desktop nunca importa Core en proceso (Core es ESM, Desktop es CommonJS más un sidecar `pkg`; `server/modules/agent-runtime/runtime/agent-runtime-loader.ts:67-73`). Desktop lanza `node <core>/dist/agent-runtime/cli.js <verbo> …` con su Node empaquetado (22.22.3) y consume una línea JSON por evento en stdout. Stdin de Core es `ignore`. Esa frontera **se mantiene**: todo lo nuevo pasa por verbos del CLI, ficheros congelados y eventos JSONL.
- **Ficheros congelados por run.** Desktop escribe con `flag: 'wx'` (crear solo si no existe) y modo 0600 bajo `<backlogRoot>/.specrails/pipeline/<runId>/`: contexto (`desktop-context.json`), configuración de runtime (`desktop-runtime-config.json`), y, nuevo, la definición del grafo (`desktop-workflow-definition.json`). Core escribe su request congelado y, nuevo, `run.sqlite`. Nada de esto se edita después de creado; un cambio exige un run nuevo.
- **Retención del paquete de runtime.** Cada run retiene el paquete exacto de Core con el que empezó (`agent-runtime-package.ts`), y `resume` usa el retenido. Por eso Core puede cambiar de motor sin dejar huérfanos los runs antiguos, y por eso el grafo implement en código (legado) no debe cambiar de identidad mientras exista.
- **Desktop es dueño de git, entrega y contabilidad.** Core exige `ownership.git === 'host'` y nunca hace commit, push ni PR. Core informa del uso (tokens, coste, con `null` para "desconocido"); Desktop escribe `ai_invocations`. Un valor desconocido nunca se convierte en cero.
- **Un solo motor por ejecución.** En el diseño final, Core dirige y ejecuta todo el grafo; Desktop no decide sucesores ni ejecuta pasos de grafos nuevos. Los loops guardados con el formato antiguo siguen en el motor actual de Desktop hasta la última etapa.

## 4. Preparación del entorno

1. Clona ambos repositorios como hermanos: `<raíz>/specrails-core` y `<raíz>/specrails-desktop` (Desktop busca un Core hermano en desarrollo; `docs/internals/programmatic-agent-runtime.md`).
2. Node: Core exige hoy ≥ 20.19.0 (`package.json` `engines`); el spike C1 decide si sube a ≥ 22.13.0. Desktop se desarrolla y empaqueta con 22.22.3 (`.github/workflows/desktop-release.yml:26`). Usa 22.22.3 para ambos salvo que un bloque diga lo contrario.
3. Core: `npm ci && npm run build && npm test`. Desktop: `npm ci && npm ci --prefix client && npm run typecheck && npx vitest run server/modules/loops` (una suite pequeña para comprobar el entorno; la completa tarda).
4. Para que Desktop use tu Core de desarrollo: `SPECRAILS_CORE_RUNTIME_PATH=<raíz>/specrails-core/dist/agent-runtime/index.js` al arrancar Desktop (`npm run dev`). Para el flujo completo empaquetado: `node scripts/assemble-bundled-core.mjs --source ../specrails-core` (descarga dependencias; no invoca proveedores).
5. Prueba de emparejamiento sin coste: `npm run build:server && node scripts/smoke-agent-runtime-pair.mjs` en Desktop (usa un modelo local ficticio; ejercita escrituras, verificación real, aprobación, reanudación, uso y propiedad de git).
6. Windows: no asumas rutas POSIX; usa las utilidades de proceso de cada repositorio (`src/installer/util/exec.ts` y `src/agent-runtime/cli-process.ts` en Core; `server/util/win-spawn.ts` en Desktop). La matriz de CI de Core corre en los tres sistemas.

## 5. Reglas de trabajo

1. **Un bloque, una rama, una PR** (o varias PR pequeñas dentro del bloque). Nombre de rama `feat/core-engine-<bloque>` en Core y `feat/core-engine-<bloque>` en Desktop. Commits convencionales (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
2. **Antes de empezar un bloque**: lee su sección en el documento de tareas, revalida las líneas citadas contra el código actual, y comprueba que las precondiciones (bloques previos publicados, spikes con decisión) se cumplen. Si una precondición falla, no empieces: anótalo en el plan.
3. **Tests junto a su sujeto** (`*.test.ts` al lado del fichero), con ejecutores y hosts simulados; nunca llamadas reales a proveedores en CI. No bajes umbrales de cobertura ni saltes tests. No borres tests del motor actual de Desktop ni del runner legado de Core antes de los bloques D8 y C10.
4. **Contrato primero.** Cualquier campo, verbo, evento, tabla o código nuevo se añade al contrato en el mismo commit que al código. Cualquier cambio de comportamiento de una pieza sube `nodeKindsVersion`.
5. **Desktop**: migraciones al final de `server/db/migrations.ts` (la última es la 63) y nunca renumeradas; ficheros nuevos bajo `server/modules/**` registrados en `server/modules/boundaries.json` con el script de auditoría y `npm run audit:architecture` en verde; `npm run docs:source-map` tras añadir o mover ficheros; claves i18n en los ocho locales de `client/src/i18n/`; `npm run typecheck` (incluye locales e imports sin uso).
6. **Core**: dirección de dependencias `shared ← pipeline ← agent-runtime ← installer` (`src/architecture.test.ts`); `src/pipeline/pipeline-state.ts` solo importa `node:*` porque se copia a cada proyecto; ficheros en kebab-case; `npm run ci` antes de cerrar un bloque.
7. **No inventes sustantivos de producto.** Se dice *workflow* o *grafo*, *pieza*, *componente*, *loop* (nombre de la sección de Desktop). Nada de "team", "recipe", "agent manager".
8. **Documenta en el mismo cambio**: README del módulo tocado, `docs/engine-v2/` en Core (C9), guías de usuario de Desktop cuando cambie algo visible.

## 6. Definición de "hecho" para cualquier bloque

- Todas las tareas del bloque implementadas y sus tests en verde, más las suites afectadas que nombra el bloque.
- Comandos de aceptación del bloque ejecutados y su salida recogida en la PR.
- Contrato y documentación actualizados en el mismo cambio.
- En Core: `npm run ci`. En Desktop: `npm run typecheck`, suites afectadas, `npm run audit:architecture`, `npm run docs:source-map`, `npm run check-core-compat`; al cerrar una etapa del plan, `npm run ci` completo (tarda; ejecútalo de todas formas).
- Ninguna nueva variable de entorno, flag o fichero sin documentar en el contrato.
- En la sección "Hecho cuando" del bloque, anota la fecha y el commit en el documento de tareas.

## 7. Protocolo de verificación del motor (desde C3)

La matriz de robustez (plan, sección 10) es obligatoria y se ejecuta en CI: kill -9 en cada frontera de nodo y durante nodos de escritura, dos procesos sobre el mismo run, presupuesto agotado, límite de recursión, `fail_fast`, interrupciones dentro de subgrafos y ramas, `fork`, reanudación con definición o paquete distintos, salidas grandes, cancelación en cada estado, Windows. El arnés vive en `src/agent-runtime/engine/runs/robustness.test.ts` y usa la variable de test `SPECRAILS_ENGINE_CRASH_AT` para matar el proceso hijo en el punto indicado. Un bloque que toque el motor no está hecho si la matriz no pasa en las tres plataformas.

## 8. Trampas conocidas (cosas que parecen errores y no lo son)

- **Stdin `ignore` en Core**: es deliberado; no añadas un canal bidireccional. Las interrupciones humanas terminan el proceso con exit 2 y se reanudan con `resume`.
- **Ficheros `wx`**: si un fichero congelado ya existe con otro contenido, el error "changed during an active run" es correcto; la solución es un run nuevo, no sobrescribir.
- **`additionalProperties: false` en `schemas/agent-runtime.schema.json`**: Core rechaza claves desconocidas. Añadir `roles` exige tocar el schema y re-vendorizarlo en Desktop (test de paridad byte a byte).
- **Snapshot del argv de Claude** (`compact-runtime.test.ts`, `__fixtures__/claude-architect-invocation.snapshot.json`): cualquier cambio en cómo se invoca a Claude para architect/developer/reviewer lo rompe a propósito. Los roles built-in deben producir exactamente el mismo argv después de C2.
- **`pipeline-state.ts` se copia compilado a cada proyecto**: no lo modifiques para el motor v2; el motor lo usa tal cual.
- **El grafo implement legado no cambia** mientras exista: `core-host.ts:79` y `workflow.ts:174-176` dejarían huérfanos los runs guardados. La definición de referencia y la de fábrica son documentos distintos.
- **`SPECRAILS_GIT_AUTO=false` es condicional en Desktop** (`loop-executors.ts:131`); para el motor v2, Desktop fuerza siempre `ownership.git: 'host'` (D1).
- **Un rechazo del revisor no es un fallo**: el run termina `succeeded` con `completion.ok: false` y exit 0. Exit 1 es solo para errores de ejecución. Si lo cambias, el fail-fast de Desktop abortaría loops legítimos.
- **Desconocido ≠ cero** en uso y coste, en Core y en Desktop.
- **Steering solo entre intentos** (decisión del 26 de septiembre de 2026): no portes el transporte de sesión viva de Claude/Codex a Core.
- **`node:sqlite` vs `better-sqlite3`**: la decisión es del spike C1; no elijas por costumbre. Desktop ejecuta Core con Node 22.22.3, donde `node:sqlite` existe sin flag.

## 9. Ante una duda

1. Busca la respuesta en el contrato; si está, síguela.
2. Si no está, mira la sección 14 del plan: cada pregunta abierta lleva la suposición que debes tomar.
3. Si tampoco está, toma la decisión más conservadora (la que no cambia comportamiento observable del legado, no añade permisos y no toca la entrega), anótala en la sección 14 del plan con fecha y motivo, y sigue.
4. Nunca resuelvas una duda ampliando el alcance (por ejemplo, unificando los adaptadores de proveedor de Desktop con los ejecutores de Core: está fuera de esta iniciativa).

## 10. Informe al cerrar cada bloque

Escribe en la PR: qué cambió (ficheros y contratos), cómo se validó (comandos y su resultado literal), qué quedó fuera y por qué, y qué precondiciones deja para el siguiente bloque. Actualiza el documento de tareas ("Hecho cuando" con fecha y commit) y, si hubo decisiones nuevas, la sección 14 del plan. No marques un bloque como hecho si algún test se saltó o si la aceptación se probó solo en una plataforma cuando el bloque exige tres.

## 11. Glosario rápido

- **Rail**: carril de ejecución de Desktop al que se arrastran specs y se lanza un loop.
- **Loop**: grafo guardado en Desktop (tabla `loops`); en el diseño final, una definición ejecutable por Core.
- **Definición**: JSON del grafo (contrato, sección 2).
- **Pieza**: tipo de nodo ejecutable por Core (contrato, sección 4).
- **Componente**: definición anidada reutilizable, subgrafo en LangGraph.
- **Run**: una ejecución de una definición; `runId`, directorio `pipeline/<runId>/`, `run.sqlite`.
- **Ledger**: tablas de evidencia de Core en `run.sqlite`.
- **Receipt**: registro determinista de una verificación (comandos, salidas, hashes) que Core produce y Desktop exige para entregar a revisión.
- **Journal (`state.json`)**: fases de implement; solo existe en grafos con la pieza `implementation`.
- **Legado**: runner actual de Core y grafo implement en código; se retira en Core 7.
- **Host**: Desktop.
