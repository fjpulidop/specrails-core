# Motor de agentes en Core: un motor LangGraph completo, con los grafos definidos en Desktop

Estado: **plan preparado (v4); implementación pendiente**. Fecha: 26 de septiembre de 2026 (v1: 25 de septiembre de 2026).

Base sobre la que se escribió: specrails-core **6.0.0** (`integration-contract.json` `schemaVersion: "5.0"`, `RUNTIME_API_VERSION = 1`, `CORE_WORKFLOW_VERSION = '6'` en `src/agent-runtime/core-host.ts:24`, `ROLE_INSTRUCTIONS_VERSION = '9'` en `src/agent-runtime/prompts.ts:7`, `@langchain/langgraph` **1.4.14** y `@langchain/langgraph-checkpoint` **1.1.5** en `package.json:75-77`); specrails-desktop **2.57.0** (`CORE_BUNDLE_VERSION: "6.0.0"` en `.github/workflows/desktop-release.yml:48`, `SUPPORTED_CORE_MAJORS = [4, 5, 6]` en `server/core-package.ts:5`, última migración de base de datos: **63** en `server/db/migrations.ts`).

Este documento sigue las convenciones de [`implementation-efficiency.md`](implementation-efficiency.md): bloques Core `C0..Cn`, bloques Desktop `D0..Dn`, tabla de etapas y responsabilidad explícita por repositorio. Los identificadores marcados como *(propuesto)* no existen todavía; el resto son reales y se han contrastado con el código fuente. Los números de línea corresponden a la base indicada; al retomar el plan hay que revalidarlos (sección 15).

**Cómo llegó el plan hasta aquí.** v1 proponía un catálogo de workflows TypeScript dentro de Core invocables desde los loops. v2 y v3 trasladaron la autoría de los grafos a Desktop y, para los grafos híbridos, delegaban los pasos de Desktop mediante una interrupción. El maintainer fijó finalmente la dirección: **Desktop guarda solo las definiciones JSON de los grafos y todo el motor de pasos es Core; y ya que se construye, el motor debe explotar LangGraph a fondo y ser robusto de verdad, en vez de portar a código reglas intermedias.** v4 es ese diseño: un **motor v2** en Core, nativo de LangGraph, que ejecuta todos los tipos de paso (incluidos los prompts nativos a los proveedores y los comandos shell), un formato de definición JSON que Desktop edita y almacena, y una retirada ordenada del motor de loops de Desktop y del grafo implement en código. Se conservan las protecciones verificadas en v1: los runs guardados siguen reanudando con su paquete retenido, Desktop sigue siendo dueño de la entrega, la contabilidad y las specs, y ningún código del usuario ejecuta dentro de Core.

## Documentos que guían la implementación

| Documento | Uso |
|---|---|
| [Contrato técnico compartido](core-agent-engine-contracts.md) | Fuente única de formatos, piezas, estado, tablas, CLI, eventos, ficheros congelados y compatibilidad. Manda sobre este plan si discrepan |
| [Tareas de Core (C0..C10)](core-agent-engine-tasks-core.md) | Ficheros, firmas, tests y aceptación por bloque de specrails-core |
| [Tareas de Desktop (D0..D8)](core-agent-engine-tasks-desktop.md) | Ficheros, firmas, tests y aceptación por bloque de specrails-desktop |
| [Briefing para el implementador](core-agent-engine-implementer-brief.md) | Cómo preparar el entorno, reglas de trabajo, definición de hecho, trampas conocidas y qué hacer ante dudas; pensado para una persona o un asistente de IA sin el contexto de la conversación que produjo este plan |

Los cambios OpenSpec emparejados (`core-agent-engine` en ambos repositorios) se crean al iniciar la etapa 1 a partir de estos documentos (sección 15).

## 1. Objetivo y medida de éxito

Objetivo: **un loop es una definición JSON de un grafo que Core ejecuta con LangGraph.** El usuario compone el grafo en el Loop Builder con piezas ejecutadas por Core (turno de rol, prompt nativo al proveedor, shell, verificación, OpenSpec, decisor, condición, aprobación, pregunta, mapa paralelo, componente reutilizable, implement como subgrafo), lo guarda, publica, forkea y exporta; al lanzarlo desde un rail, Core lo ejecuta como un run durable con checkpoint SQLite, receipts, uso por paso, interrupciones, fan-out acotado y reanudación tras cualquier corte. Los grafos de fábrica (Quick SDD, Freestyle, Implement, Batch) son definiciones de Desktop. Desktop diseña specs y grafos, lanza, muestra y entrega; Core ejecuta. Nada del recorrido vive en Desktop.

Señales medibles al terminar la etapa 6:

1. Quick SDD, Freestyle, Implement y Batch se ejecutan como definiciones de Desktop sobre el motor v2 con paridad de resultado frente al comportamiento actual (mismos receipts y aceptación en el fixture de implement; misma secuencia de pasos en Quick SDD), en los cuatro CLIs y en openai-compatible.
2. Un grafo con fan-out (revisar cada ticket del rail en paralelo con concurrencia 2 y una unión que agrega veredictos) se ejecuta con `Send` y un nodo diferido de unión, con checkpoint por rama.
3. Matar el proceso de Core o Desktop en cualquier frontera de nodo y reanudar continúa sin repetir nodos terminados ni duplicar contabilidad (matriz de robustez de la sección 10 en verde).
4. "Repetir desde aquí" en la vista del job bifurca el run desde un nodo anterior mediante el historial de checkpoints de LangGraph y conserva el run original.
5. Cada nodo se ve como paso en `LoopStepExplorer` con su uso; la suma por run coincide con el `runtime-result`.
6. El built-in en código `specrails-implementation` sigue byte-idéntico hasta Core 7 y los runs guardados reanudan con su paquete retenido.
7. Los loops guardados con el formato actual se migran al formato nuevo con paridad demostrada por tests antes de retirar el motor de Desktop.

## 2. Diagnóstico verificado (resumen)

**Core tiene un runner LangGraph fino sobre un ledger propio.** `runWorkflow` (`specrails-core/src/agent-runtime/workflow.ts:150`) construye un `StateGraph` con un `addNode` por nodo (`:489-492`), una única arista estática `START → entry` (`:491`) y enrutado dinámico por `Command({goto})` (`:459-477`); compila con un `FileCheckpointSaver` propio (`graph-checkpointer.ts`) y guarda ledger y checkpoint en un sobre atómico (`durable-store.ts`) con lease por directorio (`:140-172`). Usa `interrupt()` (`:353-359`), `getStateHistory` para bifurcar (`:509-511`), `getState` (`:500`), `Command({resume})` (`:502`), `invoke` con `durability: 'sync'` (`:526`) y `Annotation` (`graph/state.ts:1`). **No usa** `Send`, subgrafos, `addConditionalEdges`, `retryPolicy`, `stream`/`writer`, `Store` ni caché de nodos; reintentos, presupuesto, `maxTransitions`, invalidación y recuperación de escrituras interrumpidas son código propio. Solo existe un grafo en producción, en código: `runCoreWorkflow` (`core-host.ts:75-149`, `CORE_NODE_ORDER` en `graph/state.ts:74-76`); el CLI solo lo ejecuta a él (`cli.ts:182`).

**Las piezas de dominio ya existen y son valiosas.** `coreNodes(deps)` (`graph/nodes.ts:441-443`), `createRoleInvoker` (`graph/roles.ts:58-192`: presupuesto, continuidad de sesión, escalado, salida estructurada con reparación, uso), ejecutores por proveedor (`cli-executor.ts`: Claude `-p --output-format stream-json`, Codex `exec`/`exec resume` con sandbox, Gemini `-p` con `--approval-mode plan`/`--yolo`, Kimi print mode; `openai-executor.ts`; `kimi-acp.ts`), `verifyPipeline`/`validateVerificationRequest` (`pipeline/pipeline-state.ts:886, 984`) con receipts y aislamiento de entorno, `OpenSpecTools` con OpenSpec 1.4.1 fijado (`openspec.ts:11, 80-82`), `archive` (`graph/artifacts.ts`), guardrails, política de review, prompts de rol, eficiencia y evaluación. `AgentRequest` (`executor-types.ts:85-111`) ya admite `idleTimeoutMs`, `resumeSessionId`, `outputSchema`, `signal` y `onEvent`; los permisos derivan del rol (`cli-executor.ts:30`) y el rol es una unión cerrada (`executor-types.ts:8`).

**Cada run retiene su paquete de runtime** (`retainAgentRuntime`, `resolveRetainedAgentRuntime`, `agent-runtime-bridge.ts:74`) y `sameRuntimeIdentity` prohíbe reanudar con otro paquete: un Core futuro puede cambiar de motor sin dejar huérfanos los runs antiguos.

**Desktop tiene un segundo motor y toda la semántica de pasos.** `LoopRunManager.run()` (`server/modules/loops/runtime/loop-run-manager.ts:1038`) recorre un `LoopGraph` (`loop-graph.ts:12`: `start | ai-step | shell | decider | condition | end`; un sucesor por nodo, `:234-255`) y aplica reglas que hoy no existen en Core: corte tras dos fallos seguidos (`AI_FAILFAST_THRESHOLD = 2`, `:481`), reintento único tras inactividad (`loop-step-idle.ts`), guardián de no-progreso del decisor (`NO_PROGRESS_LIMIT = 2`, `:1320, 2105-2120`), inyección de historial entre iteraciones (`:468`), continuidad de sesión por iteración, sentinels `VERIFICATION: PASS|FAIL` y `LOOP_BLOCKED:` (`:310, 331`), pausa humana (`awaitHumanDecision`, `:1496-1554`), expansión de `{{cmd:*}}` por proveedor (`loop-command-catalog.ts`, `providers/runtime.ts:147-153`), archivo OpenSpec con el CLI empaquetado (`loop-shell-invocation.ts`), contabilidad por paso (`insertLoopInvocation`, `:590-675`). Los loops se guardan globalmente (`desktop.sqlite`, tabla `loops`) con draft/published, fork, export/import (`loops-router.ts`, `loop-export.ts`) y canvas con ids UUID (`loop-graph-rf.ts:41-47`). El único paso que llega a Core es `operation: 'core-implementation'` (`loop-graph.ts:33`, `loop-executors.ts:263-273`). Al reiniciar, los runs activos se marcan fallidos (`loop-runs-store.ts:553-609`).

**Rails y entrega** son de Desktop y no dependen del motor (`rails-router.ts:564-566, :758`; `rail-isolated-launch.ts`; `rail_pr_deliveries`; review packet en `delivery-evidence.ts`). Core exige `ownership.git === 'host'` (`core-host.ts:53`); Desktop lo garantiza con `SPECRAILS_GIT_AUTO=false` solo si hay manifiesto o `isRailPrDeliveryEnabled()` (`loop-executors.ts:131`).

**Desktop nunca importa Core en proceso** (`agent-runtime-loader.ts:67-73`); habla con él por subproceso (`api`, `capabilities --stdin`, `prompts`, `validate --stdin`, `run|resume`, `status`, `recovery`) y consume JSONL (`agent-runtime-bridge.ts`). Esa frontera se mantiene.

**Deriva del contrato.** `integration-contract.json` declara `workflowVersion: "3"`, `instructionsVersion: "3"` (280-281) frente a `'6'`/`'9'`; `phases` omite `fixer` (260-266); `cliOperations` (227-233) omite verbos. `install-config.test.ts:380` fija `schemaVersion "5.0"`. Pins desfasados: `agent-runtime-package.test.ts:67`, `docs/internals/programmatic-agent-runtime.md:118`.

## 3. Principios del motor v2: qué virtudes de LangGraph se usan y para qué

| Necesidad | Primitiva de LangGraph | Hoy en Core | Motor v2 |
|---|---|---|---|
| Recorrido con ramas, ciclos y decisiones | `addEdge`, `addConditionalEdges` con funciones de enrutado sobre el estado, `Command({goto, update})` para saltos dinámicos | Solo `START → entry` y `Command({goto})` desde un `next` propio | El compilador genera aristas estáticas para flujos lineales, aristas condicionales para decisor/condición/verificación y `Command` solo donde el destino depende de la salida de un agente; `getGraph().drawMermaid()` devuelve el grafo compilado para comprobar en tests que coincide con la definición |
| Fan-out y fan-in | `Send` (map-reduce) y nodos diferidos (`defer: true`) que esperan a todas las ramas | No | Pieza `map` con concurrencia acotada y pieza `join` diferida; ramas con checkpoint propio |
| Reutilización y composición | Subgrafos compilados como nodos, con estado propio o compartido; `Command.PARENT` | No | Pieza `component` (subgrafo definido por el usuario y guardado en Desktop) y pieza `implementation` (implement como subgrafo con `CoreState`), en vez de seis piezas sueltas con reglas de orden |
| Durabilidad y reanudación | Checkpointer `BaseCheckpointSaver`; `durability: 'sync'`; `getState`/`getStateHistory`/`updateState` | `FileCheckpointSaver` propio más ledger en un sobre JSON | Checkpointer SQLite por run (`run.sqlite`), con las tablas del ledger (receipts, invocaciones, uso, presupuesto) **en la misma base y la misma transacción**. El binding lo decide el spike C1: `node:sqlite` sin módulo nativo (disponible sin flag en el Node 22.22.3 que Desktop empaqueta y usa para ejecutar Core) o `better-sqlite3` vía `@langchain/langgraph-checkpoint-sqlite`; `FileCheckpointSaver` extendido solo como reserva |
| Repetir desde un punto | Time travel: `getStateHistory` + `updateState`/bifurcación de thread | Solo para invalidación interna | Verbo `fork --from <nodeId>` y acción "repetir desde aquí" en Desktop, conservando el run original |
| Reintentos transitorios | `retryPolicy` por nodo (`maxAttempts`, backoff, `retryOn`) | Bucle propio de `maxAttempts` | Errores de transporte y de inactividad se reintentan con `retryPolicy`; los reintentos de negocio (corrección tras verificación) son aristas del grafo |
| Humano en el bucle | `interrupt()` + `Command({resume})`; `interruptBefore`/`interruptAfter` | `approval`/`question` | Mismas dos piezas más `gate` (interrupción estática antes de un nodo marcado) y respuesta unificada por `resume` |
| Progreso en tiempo real | `stream()` con `streamMode: ['updates', 'custom']` y `config.writer` para eventos de herramientas y verificación; `streamEvents` para trazas | Callbacks propios `onEvent`/`onSpan` | Un solo flujo de eventos derivado de LangGraph, serializado a JSONL en stdout; los spans salen de `streamEvents` |
| Estado tipado con reducers | `Annotation.Root` con reducers por canal | `CoreState` | Canales genéricos con reducers (`$outputs` por nodo, `$history` acotado, `$vars`, `$usage` acumulado, `$attempts`, `$verified`) más los canales del subgrafo implement |
| Memoria entre runs | `BaseStore` con namespaces | `role-state.ts` por directorio de run | Implementación de `BaseStore` sobre SQLite por proyecto para sesiones de rol reutilizables, comandos de verificación que funcionaron y notas del revisor; etapa tardía |
| Cachear nodos deterministas | `cachePolicy` por nodo | Reutilización propia de verificaciones con hash de entorno | Se evalúa para `check`/`openspec-validate` cuando la entrada no cambia; la reutilización de verificaciones conserva la lógica actual de Core, más estricta |
| Límite de recursión | `recursionLimit` | Calculado desde `maxTransitions` | `maxTransitions` de la definición → `recursionLimit`; `GraphRecursionError` → `blocked` con motivo legible |

Lo que LangGraph **no** trae y sigue siendo código de Core: presupuesto de coste y tokens por run (canal `$usage` con reducer más comprobación en un envoltorio previo a cada nodo), leases entre procesos, receipts de verificación, recuperación explícita de escrituras interrumpidas (un nodo con efecto de escritura que muere a mitad exige `--recover`), honestidad de código de salida y alcanzabilidad de tests (guardrails actuales), sandbox por rol en cada CLI y el protocolo JSONL con Desktop.

## 4. Arquitectura objetivo

**Core** (`src/agent-runtime/engine/` *(propuesto)*): `definition/` (schema JSON, validador Ajv, compilador a `StateGraph`), `state/` (canales y reducers), `pieces/` (una carpeta por pieza: schema de parámetros, efecto, `build`), `checkpoint/` (`SqliteSaver` + tablas del ledger + lease), `runs/` (crear, reanudar, estado, bifurcar, cancelar), `events/` (adaptador `stream` → JSONL), `budget/`, `store/`. Reutiliza sin cambios los ejecutores, `OpenSpecTools`, verificación, guardrails, prompts, política de review, eficiencia y evaluación. El runner actual (`workflow.ts`, `core-host.ts`, `durable-store.ts`, `graph-checkpointer.ts`) se conserva como **motor legado** solo para reanudar runs antiguos y para Desktops antiguos, y se retira en Core 7.

**Desktop**: Loop Builder (editor de definiciones), tabla `loops` (almacén), lanzador (rails, worktrees, contexto congelado), visor (job log, explorer, pausas, "repetir desde aquí"), entrega (`rail_pr_deliveries`, review packet) y contabilidad (filas de `ai_invocations` derivadas de los eventos de Core). `LoopRunManager` deja de recorrer grafos: lanza un run, proyecta eventos, atiende pausas, cancela y liquida. El motor de loops actual se conserva para los loops en formato antiguo hasta su migración (etapa 7).

**Modelo de proceso.** Un proceso de Core por run, vivo durante toda la ejecución, que emite eventos por stdout; stdin sigue `ignore`. Una interrupción humana (`question`, `approval`, `gate`) termina el proceso con exit 2 y el run se reanuda con `resume` desde el checkpoint, como hoy. El steering llega por un buzón de fichero leído en fronteras de intento. Cancelación por SIGTERM con aborto cooperativo (`cli.ts` ya lo hace). No hay pasos ejecutados fuera de Core.

**Almacenamiento por run.** `<backlogRoot>/.specrails/pipeline/<runId>/`: `desktop-context.json` y `desktop-runtime-config.json` (Desktop, `wx`), `desktop-workflow-definition.json` *(propuesto, Desktop, `wx`)*, `run.sqlite` *(propuesto: checkpoints de LangGraph, ledger, receipts, invocaciones, buzón de steering)*, `verification/evidence/*.json`, `state.json` (journal, solo en grafos con `implementation`), `steering-inbox.jsonl` *(propuesto)*. La base SQLite se abre con WAL y permisos 0600, como la de Desktop.

## 5. Contrato Core ⇄ Desktop

### 5.1 Definición JSON *(propuesta)*

`schemas/workflow-definition.schema.json` en Core, vendorizado byte a byte en `server/schemas/` de Desktop (paridad por test, como `agent-runtime.schema.json`):

```
{ schemaVersion: 1, id, version: '<sha256 del contenido sin version>', title,
  journal: 'ledger-only' | 'implementation', change: 'new' | 'existing' | 'none',
  entry, maxTransitions, budget?: { maxCostUsd?, maxTokens?, maxDurationMs? },
  policies?: { failFast?: number, noProgress?: number },
  roles: string[],
  nodes: { [id]: { kind, params, ends: string[], retry?: { maxAttempts, backoffMs, retryOn: string[] } } },
  components?: { [name]: <definición anidada> },
  delivery?: { requiresVerified: boolean } }
```

Los ids de nodo del builder son UUID (`loop-graph-rf.ts:41-47`) y cumplen el patrón de LangGraph; el compilador rechaza `START`/`END`/`next` y colisiones con canales (`workflow.ts:28-29, 58-60`). Desktop resuelve al compilar `{{spec.*}}`, `{{const:*}}` y `{{cmd:*}}` (con el proveedor del lanzamiento); Core resuelve `{{run.*}}` desde `$vars` en cada nodo.

### 5.2 Librería de piezas v1 *(propuesta)*, todas ejecutadas por Core

| Pieza | Parámetros | Compilación y semántica |
|---|---|---|
| `prompt` | `engine {provider, model, effort}`, `text`, `nativeCommand?: {id, args}`, `access: 'read' \| 'write'`, `sentinel?: 'verification' \| 'blocked'`, `captureVars?`, `sessionContinuity`, `idleTimeoutMs?` | El paso de IA libre de hoy: turno del ejecutor de proveedor sin instrucciones de rol ni OpenSpec; `nativeCommand` se renderiza por proveedor (Claude/Gemini `/id args` en `-p`, Codex `$id args`, Kimi `run-skill.mjs --skill`), conocimiento que Core ya tiene en `templates/` y `integration-contract.json`; `sentinel: 'verification'` decide la arista (`pass`/`fail`); `sentinel: 'blocked'` convierte `LOOP_BLOCKED: <motivo>` en una interrupción `question`; la inactividad y los errores de transporte van a `retryPolicy` |
| `role-turn` | `roleId`, `prompt`, `structuredOutput?`, `sessionContinuity` | `createRoleInvoker` con rol declarado (`access`/`artifacts` de C2), OpenSpec según el rol |
| `decider` | `roleId` (lectura), `goal`, `noProgress?` | Turno de rol estructurado `{verdict, reason}` alimentado por `$history`; el guardián de no-progreso compara el fingerprint del candidato (`fingerprintCandidate`, `pipeline-state.ts`) entre visitas y sale por `stalled` |
| `condition` | `expr` sobre `$outputs`, `$vars`, `$verified` | Arista condicional pura |
| `verify` | `commands: 'configured' \| VerificationCommand[]` | `verifyPipeline` con receipt; actualiza `$verified`; aristas `pass`/`fail` |
| `shell` | `argv` o `commandLine`, `repositoryId`, `timeoutMs?`, `captureVars?`, `evidence?` | Comando arbitrario por la maquinaria de verificación (aislamiento de entorno, Windows); con `evidence: true` deja receipt |
| `openspec-validate` / `openspec-archive` | `change` | OpenSpec 1.4.1 fijado por Core (`openspec.ts`), sin depender del CLI global ni del empaquetado de Desktop |
| `approval` / `question` / `gate` | `reason` / `text` / — | `interrupt()`; `gate` = `interruptBefore` sobre el nodo siguiente |
| `map` / `join` | `over: 'tickets' \| 'repositories' \| '$outputs.<id>'`, `concurrency`, `body: <component>` / `reduce: 'collect' \| 'all-ok'` | `Send` por elemento hacia el subgrafo `body`; semáforo de concurrencia (los CLIs son procesos pesados; por defecto 1); `join` diferido agrega |
| `component` | `ref`, `inputs` | Subgrafo compilado desde `components[ref]` o desde otra definición publicada en Desktop y congelada en el run |
| `implementation` | `attempts`, `reviewPolicy`, `approvalBeforeArchive` | Subgrafo con `CoreState` y los seis nodos de `coreNodes(deps)` (`architect → developer → verify → reviewer → archive`, `fixer` en correcciones), `journal: 'implementation'`; se puede envolver con piezas antes y después, y los nodos intermedios del subgrafo son puntos válidos de `fork` |
| `end` | `outcome`, `requiresVerified?` | Termina; fija `completion.ok` y `completion.verified` |

### 5.3 Semántica de los loops actuales expresada con el motor

| Regla actual de Desktop | Expresión en el motor v2 |
|---|---|
| Corte tras dos fallos seguidos de IA (`AI_FAILFAST_THRESHOLD`) | `policies.failFast` → reducer `$consecutiveFailures` y arista condicional a `end(failure)` |
| Reintento único tras inactividad (`loop-step-idle.ts`) | `retryPolicy { maxAttempts: 2, retryOn: ['idle_timeout'] }` en `prompt`, con `sessionContinuity` para reanudar la sesión |
| Guardián de no-progreso (`NO_PROGRESS_LIMIT`) | `decider.noProgress` con fingerprint del candidato en `$candidate` |
| Historial entre iteraciones (`composeHistory`) | Canal `$history` con reducer acotado, consumido por `decider` y `prompt` |
| Continuidad de sesión por iteración | Canal `$sessions[nodeId]` |
| `VERIFICATION: PASS\|FAIL` / `LOOP_BLOCKED:` | `sentinel` del `prompt` → arista / `question` |
| `stopOnFailure`, `failureRecovery`, `requireRunVars` | `ends` a `end(failure)` o a un nodo de reparación con `retry`; `condition` sobre `$vars` |
| `maxIterations`, `timeoutMinutes`, `maxCostUsd` | `maxTransitions` → `recursionLimit`; `budget.maxDurationMs` (el proceso de Core está vivo todo el run); `budget.maxCostUsd` con `$usage` |
| Pausa humana (`awaitHumanDecision`) | `question` / `gate`; respuesta desde el chat del job con `resume --answer` |
| `{{cmd:*}}` por proveedor | Expansión en Desktop al compilar (`text` o `nativeCommand`), render por proveedor en Core |
| `openspec archive -y` empaquetado (`loop-shell-invocation.ts`) | `openspec-archive` con OpenSpec fijado por Core |

### 5.4 CLI, eventos, evidencia

- Verbos: `runtime workflows` (piezas con schemas, `nodeKindsVersion`, built-in legado marcado `deprecated`), `runtime workflows validate --stdin`, `runtime run --context --config --change --definition <file>`, `runtime resume --context [--approve <nodeId>] [--answer <text>] [--recover <nodeId>] [--invalidate <nodeId>]`, `runtime fork --context --from <nodeId> [--state <file>]` *(propuesto)*, `runtime status --context [--compact]`, `runtime signal --context --stdin`, `runtime evidence`, `runtime recovery`, `runtime api`, `runtime evaluate --definition`. `--workflow specrails-implementation` se mantiene para el legado.
- `runtime api`: `engineVersion: 2`, `nodeKinds`, `nodeKindsVersion`, `capabilities.engineV2: 1`, `workflowDefinitions: 1`, `openRoles: 1`, `fanOut: 1`, `fork: 1`, `steeringInbox: 1`, más las actuales. `RUNTIME_API_VERSION` sigue en 1 (todo aditivo).
- Eventos JSONL: los tipos actuales (`workflow-event`, `agent-event`, `verification-output`, `span`, `runtime-efficiency-event`, `runtime-result`) generados desde `stream()`/`streamEvents()`; `workflow-event` gana `branch` (rama de `map`) y `component` (ruta del subgrafo) *(propuestos)*; `runtime-result` gana `workflow`, `completion {ok, reasons, verified}` y `forkOf` *(propuestos)*. Exit 0/2/1 intactos. Salidas acotadas (una línea > 2.000.000 caracteres invalida el protocolo, `agent-runtime-bridge.ts:144-146`).
- Evidencia: `run.sqlite` (checkpoints y ledger), `verification/evidence/*.json`, `state.json` solo con `implementation`. `readRuntimeEvidence` (`delivery-evidence.ts:497-557`) pasa a leer el ledger de `run.sqlite` a través de `runtime status --compact` en vez de `checkpoint.json` (D2); la proyección a `evidence.confidence` (`:436-446`) se conserva para el nodo `reviewer` del subgrafo implement y para `role-turn` con `REVIEW_OUTPUT_SCHEMA`.
- Request congelado: `agent-runtime-request.json` gana `workflow: { id, version, source: 'builtin' | 'definition', definitionHash, engine: 1 | 2 }`; la definición se copia dentro de `run.sqlite`; `resume` recompila desde ahí y compara el hash.

### 5.5 Versionado, compatibilidad y releases

`integration-contract.json` 5.0 → **5.1** en C0 (aditivo; corrección de la deriva). Cada definición lleva su hash como versión; un cambio de comportamiento de una pieza sube `nodeKindsVersion`; los runs congelados siguen con su paquete retenido. `CORE_WORKFLOW_VERSION` sigue en `'6'` para el legado. Desktop nuevo + Core sin `engineV2`: los loops nuevos no se lanzan (mensaje de actualización), los antiguos y los de fábrica siguen por el camino actual. Desktop viejo + Core nuevo: no envía `--definition`; Core ejecuta el legado. Core 7 (etapa 8) retira el legado y sube el contrato a 6.0.

Emparejamiento de releases (cada etapa con release de Core): Core publica con release-please (`npm run ci` incluye `check:package`, que en C1 pasa a comprobar el módulo nativo de SQLite en las tres plataformas); Desktop sube `CORE_BUNDLE_VERSION` (`.github/workflows/desktop-release.yml:48`), regenera `scripts/assemble-bundled-core.lock.json` con `node scripts/assemble-bundled-core.mjs <version>`, actualiza la constante que compara `checkCoreCompat` (`server/core-compat.ts`, `scripts/check-core-compat.ts:60-70`) y ejecuta `check-core-compat` y `check:package`; nunca se marca probado un gate con `source-bundle.json`.

## 6. Responsabilidad por repositorio

**Core**: motor v2 completo (compilador, estado, checkpointer SQLite, streaming, presupuesto, leases, fork, store), todas las piezas, ejecutores, roles abiertos, buzón de steering, evaluación por definición, contrato y una definición de referencia de implement solo para tests. Core no contiene grafos de producto nuevos, no decide entrega ni coste aceptado y no ejecuta código del usuario.

**Desktop**: editor y almacén de definiciones (con `map`, `join`, `component`, `implementation`), compilación e interpolación al lanzar, lanzador (rails, worktrees, contexto), visor (eventos, pasos, ramas, pausas, "repetir desde aquí", steering), entrega y contabilidad, biblioteca de roles, migración de loops antiguos. Desktop no ejecuta pasos de loops nuevos. Todo bloque que toque `server/modules/**` termina con `npm run audit:architecture` y `npm run docs:source-map`.

## 7. Bloques de trabajo Core (C0..C10)

### C0 — Higiene de contrato y fingerprint congelado del legado

- `integration-contract.json:227-233, 260-266, 280-281`: `cliOperations` += `prompts, capabilities, evidence, recovery`; `phases` += `fixer`; `workflowVersion: "6"`, `instructionsVersion: "9"`; `schemaVersion: "5.1"` (línea 2, con `src/installer/phases/install-config.test.ts:380` y `CLAUDE.md:27`); bloques `agentRuntime.engine`, `agentRuntime.nodeKinds` (vacíos hasta C3/C4) y `agentRuntime.builtins: [{ id: 'specrails-implementation', version: '6' }]`.
- `src/agent-runtime/integration-contract.test.ts` *(propuesto)*: compara el contrato con `CORE_WORKFLOW_VERSION`, `ROLE_INSTRUCTIONS_VERSION`, `CORE_NODE_ORDER`, los verbos de `cli.ts` y, desde C4, las piezas.
- Extraer `implementationWorkflowDefinition(deps)` *(propuesto)* de `core-host.ts:140-147`; `__fixtures__/implementation-workflow-fingerprint.json` *(propuesto)* y test en `core-host.test.ts`.
- Correcciones menores: docstring `core-host.ts:69-74`, `RUNTIME_API_VERSION` en `core-host.ts:27`, referencia a `schemas/profile.v1.json` en `scaffold.ts:32` y `docs/agent-runtime.md:73`.
- Tests: `core-host.test.ts`, `cli.test.ts` (`:198`), `legacy-runtime.test.ts`, `install-config.test.ts`, contrato.
- Aceptación: `npm run ci`; fixture v4 reanuda; Desktop (D0) pasa `check-core-compat` contra 6.1.0.

### C1 — Spikes con gate de decisión

Tres comprobaciones cortas, cada una con criterio de salida escrito antes de empezar, cuyo resultado fija el diseño de C3:

1. **Binding SQLite y empaquetado.** Decisión del maintainer (26 de septiembre de 2026): SQLite es el diseño elegido; este spike decide el **binding** y valida el empaquetado. Candidatos: **A** `node:sqlite` (`DatabaseSync`, sin módulo nativo; disponible sin flag desde Node 22.13, y Desktop ejecuta Core con su Node empaquetado 22.22.3, `.github/workflows/desktop-release.yml:26`, `server/core-node-runtime.ts:5-8`; exige subir `engines.node` de Core a ≥ 22.13 y retirar Node 20 de la matriz de CI, e implementar un `BaseCheckpointSaver` de unas 300 líneas con el esquema de tablas del contrato); **B** `@langchain/langgraph-checkpoint-sqlite` sobre `better-sqlite3` (módulo nativo; el ensamblado de Desktop corre `npm ci` con Node 22.22.3 en cada plataforma, así que el binario prebuilt coincide con el ABI, pero `check:package` de ambos repos debe aceptar el `.node` y hay que probar rutas largas en Windows). Criterio de salida para el candidato elegido: en macOS arm64, Windows x64 y Linux x64, un run de 200 nodos con kill -9 en cada frontera reanuda sin pérdida, `PRAGMA journal_mode` devuelve `wal`, permisos 0600, `check:package` de Core y ensamblado de Desktop en verde, `put` medio < 5 ms. Recomendación previa: A si `engines` puede subir; B si hay que conservar Node 20. Si ambos fallan en alguna plataforma, `FileCheckpointSaver` extendido con el ledger en un fichero SQLite separado, documentando la causa. Detalle en las tareas de Core, C1.
2. **Subgrafos con interrupciones y checkpoints.** Un subgrafo con `interrupt()` dentro de un `map` con `Send`: reanudación por rama, `Command.PARENT`, `getStateHistory` a través del subgrafo. Salida: documento de límites reales de LangGraph 1.4 para el compilador.
3. **Streaming como fuente única de eventos.** `stream(['updates', 'custom'])` + `writer` + `streamEvents` frente a los callbacks actuales, midiendo latencia y volumen con un run de implement. Salida: mapa de eventos LangGraph → tipos JSONL actuales.

Aceptación: tres informes en `docs/engine-v2/spikes/*.md` *(propuesto)* con decisión tomada. Dependencias: ninguna. Duración: dos semanas.

### C2 — Roles abiertos: `access`, `artifacts` y `roles`

- `executor-types.ts:8, 85-111, 135-136`: `AgentRequest.access`, `AgentRequest.artifacts`, `AgentRequest.instructions: 'role' | 'none'` y `AgentRequest.nativeCommand?` *(propuestos)*; `validateAgentRequest` acepta ids declarados en `config.roles`; `AgentRole` pasa a `string` con los tres built-ins como constantes.
- Sustituir la derivación por rol en `cli-executor.ts:30, 236, 243`, `kimi-acp.ts:15-16`, `workspace-tools.ts:55-56`, `openspec.ts:64` por `access`; el alcance de `openspec.ts:212-223` por `artifacts`. Los tres roles conservan sus valores implícitos (snapshot de argv intacto).
- `config.ts:6, 85, 108, 196` y `schemas/agent-runtime.schema.json:38-40`: clave aditiva `roles: { [id]: RuntimeAgentConfig & { access, artifacts, prompt?, openspecSkill? } }`; `graph/roles.ts:83` resuelve desde `roles`.
- `openspec.ts:12`, `prompts.ts:398-410`, `openai-executor.ts:87`, `role-routing.ts:18-21`, `core-host.ts:91-95`, `efficiency.ts:8`, `efficiency-summary.ts:105, 126`: leer del descriptor; `compact/prompt-inputs.ts` tolera prompts sin `## Developer summary`.
- Tests: `cli-executor.test.ts` (snapshot; `access: 'read'` con id nuevo; `instructions: 'none'` con `nativeCommand` renderizado por proveedor), `openspec.test.ts` (matriz `artifacts` × operación), `openai-executor.test.ts`, `config.test.ts`, `compact-runtime.test.ts`, `kimi-acp.test.ts`.
- Contrato: `configSchemaVersion` sigue 1; capacidad `openRoles: 1`.
- Dependencias: C0.

### C3 — Núcleo del motor v2

- `src/agent-runtime/engine/definition/`: `schema.ts` (Ajv), `compile.ts` (`compileDefinition(definition, deps) => { graph: CompiledStateGraph, meta }`: aristas estáticas, `addConditionalEdges`, `Command` donde toca, `retryPolicy` por nodo, `interruptBefore` para `gate`, `recursionLimit` desde `maxTransitions`, subgrafos para `component`/`implementation`, `Send` para `map`; rechazo de ids reservados y colisiones; hash de versión) y `mermaid.ts` (test de equivalencia definición ⇄ `getGraph()`).
- `engine/state/`: `CoreDefinitionState` con reducers `$outputs`, `$vars`, `$history` (acotado), `$sessions`, `$usage`, `$attempts`, `$consecutiveFailures`, `$candidate`, `$verified`, `$answers`, `$branches`.
- `engine/checkpoint/`: checkpointer SQLite por run (binding según C1) más las tablas del ledger del contrato (sección 6: `runs`, `steps`, `attempts`, `invocations`, `receipts`, `budget`, `interrupts`, `steering_inbox`, `lease`, `events`) en la misma base; escrituras del ledger en la misma transacción que el checkpoint del nodo; lease en tabla con expiración y heartbeat en vez de `mkdir .lease`.
- `engine/runs/`: `createRun`, `resumeRun` (approve/answer/recover/invalidate), `forkRun` (`updateState` sobre el checkpoint anterior al nodo, nuevo `runId` con `forkOf`), `statusRun`, cancelación cooperativa; recuperación explícita de escrituras interrumpidas conservando la regla actual.
- `engine/budget/`: envoltorio previo a cada nodo que lee `$usage` y `budget`; `context.reportUsage` alimenta el reducer.
- `engine/events/`: adaptador `stream()`/`streamEvents()` → JSONL con los tipos actuales más `branch`/`component`.
- `cli.ts`: `run --definition`, `resume`, `fork`, `status`, `workflows`, `workflows validate --stdin`, `api` con `engineVersion: 2`; el legado sigue detrás de `--workflow specrails-implementation` o cuando no hay `--definition`.
- Tests: `engine/compile.test.ts` (cada forma de arista; mermaid equivalente; hash estable; ciclos con `recursionLimit`), `engine/checkpoint.test.ts` (kill -9 en cada frontera de un grafo de 30 nodos ⇒ `resume` continúa sin repetir; ledger y checkpoint nunca desacoplados), `engine/runs.test.ts` (fork conserva el original; recover exigido tras escritura interrumpida), `engine/events.test.ts`, `cli.test.ts`.
- Aceptación: un grafo de piezas simuladas (`noop` de test) pasa la matriz de robustez de la sección 10 en Linux, macOS y Windows.
- Dependencias: C1, C2.

### C4 — Piezas básicas y Quick SDD

- `engine/pieces/`: `prompt`, `shell`, `openspec-validate`, `openspec-archive`, `condition`, `approval`, `question`, `gate`, `end`; `prompt` sobre los ejecutores existentes con `instructions: 'none'`, `nativeCommand`, `sentinel`, `captureVars`, `idleTimeoutMs` → `retryOn: ['idle_timeout']`.
- Definición de referencia `engine/__fixtures__/quick-sdd.json` *(propuesto)* equivalente a `opsxLifecycleGraph()` de Desktop (`loop-templates.ts:228-255`), con un host de test que simula los CLIs.
- Tests: por pieza; Quick SDD de referencia con éxito, con fallo de validación reparado por reintento del `prompt` de artefactos, con `LOOP_BLOCKED` → `question` → `resume --answer`, y con kill -9 en cada nodo.
- Contrato: `agentRuntime.nodeKinds` refleja las piezas.
- Dependencias: C3.

### C5 — Piezas de agentes y semántica de loops

- `role-turn`, `decider` (con `$history` y `noProgress` sobre `fingerprintCandidate`), `verify`; `policies.failFast` como reducer más arista; `$sessions` para continuidad.
- Definiciones de referencia `engine/__fixtures__/freestyle.json` y `verify-fix.json` *(propuestas)*, equivalentes a `fixLoopGraph` de Desktop.
- Tests de paridad de reglas: dos fallos seguidos ⇒ `end(failure)`; inactividad ⇒ un reintento con sesión; no-progreso ⇒ `stalled`; historial acotado; sentinels.
- Dependencias: C4.

### C6 — Implement como subgrafo y fan-out

- Pieza `implementation`: subgrafo con `CoreState` y `coreNodes(deps)`, `journal: 'implementation'`, `validateCompleted` actual (`core-host.ts:115-139`) como validación de reanudación del subgrafo; `fork` permitido en sus nodos internos.
- Piezas `map`/`join`/`component` sobre `Send` y nodos diferidos, con semáforo de concurrencia compartido por run y checkpoint por rama.
- Definición de referencia `engine/__fixtures__/implementation.json` *(propuesto)* y test de paridad frente al built-in legado sobre el corpus de `evaluation.ts:31-69` (mismos receipts, misma aceptación, mismo número de invocaciones ± reparaciones).
- Tests: `map` de dos tickets con concurrencia 1 y 2; interrupción dentro de una rama; `join` con `all-ok`; `component` anidado dos niveles.
- Dependencias: C5, spike 2 de C1.

### C7 — Store, evaluación y observabilidad

- `engine/store/`: `BaseStore` sobre SQLite por proyecto *(propuesto)* con namespaces `roles/<id>/sessions`, `verification/known-commands`, `review/notes`; las piezas leen y escriben con permisos declarados; borrable desde Desktop.
- `runtime evaluate --definition` sobre las definiciones de referencia (`evaluation-corpus.ts:13-19` ampliado); exportador opcional de trazas OpenTelemetry desde `streamEvents` (Desktop ya inyecta OTEL a los proveedores).
- Dependencias: C6.

### C8 — Steering por buzón

- `steering_inbox` en `run.sqlite`; `runtime signal --context --stdin`; consumo registrado en la misma transacción que el intento; sección `## Operator steering` en `prompt`/`role-turn`.
- Dependencias: C3.

### C9 — Documentación del motor y guía de piezas

`docs/engine-v2/` *(propuesto)*: arquitectura, formato de definición, catálogo de piezas con ejemplos, modelo de fallos y recuperación, guía para añadir una pieza (schema, `build`, tests obligatorios, entrada en el contrato). `docs/agent-runtime.md` pasa a describir el legado como tal. Dependencias: C6.

### C10 — Core 7: retiro del motor legado

Eliminar `workflow.ts`, `core-host.ts` como grafo, `durable-store.ts`, `graph-checkpointer.ts`, `--workflow`, `defaultImplementationEngine`; contrato 6.0; los runs antiguos reanudan con su paquete retenido. Dependencias: etapa 7 de Desktop y telemetría.

## 8. Bloques de trabajo Desktop (D0..D8)

### D0 — Compatibilidad y validadores derivados del catálogo

`agent-runtime-loader.ts:78-117` (parsear `engineVersion`, `nodeKinds`, capacidades; `validateWorkflowDefinition` por `workflows validate --stdin`); `agent-runtime-controls.ts:23, 82` y `agent-runtime-metrics.ts:25, 43, 49, 76, 91` derivados del catálogo con fallback; `server/core-compat.ts`/`scripts/check-core-compat.ts` aceptan 5.1; `agent-runtime-package.test.ts:67`; docs. Tests: los de cada fichero. Dependencias: C0 publicado.

### D1 — Editor de definiciones y lanzador sin ejecución

- `loop-graph.ts:27-34`: nodos con `kind` y `params` para todas las piezas de la sección 5.2; `isDefinitionGraph(graph)`; validación estructural en Desktop y de piezas en Core al publicar (`loops-router.ts` `/loops/:id/publish`), con errores por `nodeId` pintados en el canvas.
- `server/modules/loops/runtime/loop-definition.ts` *(propuesto)*: `compileLoopToDefinition(graph, launch)` (interpolación de `{{spec.*}}`, `{{const:*}}` y `{{cmd:*}}` con el proveedor del lanzamiento → `text` o `nativeCommand`; `maxIterations → maxTransitions`; `timeoutMinutes`/`maxCostUsd → budget`; `decider` → `ends` etiquetados; `stopOnFailure`/`failureRecovery` → `ends`/`retry`; hash). Test de propiedad: misma entrada ⇒ misma definición ⇒ mismo hash.
- `LoopRunManager.run()` (`loop-run-manager.ts:1038`) para grafos con `kind`: congela `desktop-workflow-definition.json` (`wx`) junto a `desktop-context.json` (`core-execution.ts:56-105`, forzando `ownership.git: 'host'` en `:89`), lanza el bridge con `definitionPath` y **no recorre nada**: proyecta eventos, atiende pausas (D3), cancela y liquida. Los grafos sin `kind` siguen por el motor actual sin cambios.
- `agent-runtime-bridge.ts:41-62, 81-111`: `definitionPath`, `AiStepResult.completion`, parseo de `branch`/`component`; rechazo con mensaje de actualización si falta `engineV2`.
- Gate de entrega: `checkCoreWorkflowCompletion` *(propuesto)* en `core-execution.ts`; `rail-isolated-launch.ts` mueve a `on_review` solo con `completion.ok && (completion.verified || !escribe)`; `checkCoreCompletion` queda para el legado.
- Builder (`LoopBuilderPage.tsx`, `loop-graph-rf.ts`): paleta desde `nodeKinds`, inspector por pieza, `component` como nodo que abre un sub-canvas, `map` con `body` y `join`; ocho locales; `docs/running-pipelines.md`, `docs/guide/en/pipeline/5-the-loop-builder.md`.
- Tests: `loop-graph.test.ts`, `loop-definition.test.ts`, `loop-run-manager.test.ts` (grafos con `kind` no entran en el recorrido), `agent-runtime-bridge.test.ts`, `server/core-execution.test.ts`, `loops-router.test.ts`, `rail-isolated-launch.test.ts` (invariante "sin `verified` no hay `on_review`"), tests de cliente.
- Dependencias: D0, C4 publicado.

**D1b — Biblioteca de roles mínima** (tras C2): re-vendorizar `server/schemas/agent-runtime.schema.json` (paridad `agent-runtime-settings.test.ts:192-194`); `agent-runtime-settings.ts:139, 320`, `client/src/features/settings/lib/agent-runtime.ts:4-7` y `AgentRuntimeSettingsSection.tsx` con filas de rol (`access`, `artifacts`, prompt, engine).

### D2 — Pasos, ramas y contabilidad desde los eventos

- Proyección de `workflow-event` a `loop_step`/`loop_step_end` con `nodeId`, `branch`, `component` y `parentNodeId` *(propuestos)* en `LoopStepEventPayload` (`loop-run-manager.ts:397-466`); `status` gana `'paused'` (`:440`); `loop.run_progress` deriva `iteration` de las visitas del `decider`.
- Contabilidad: una fila de `ai_invocations` por intento de pieza con IA, escrita desde los eventos (proveedor y modelo del `runtime-efficiency-event`), `surface = 'loop'`, `loop_run_id`; reparto con `server/util/distribute-int.ts` (sustituye a `splitInt`, `:600-605`); `NULL` para desconocido; `parseProgrammaticUsage` (`agent-runtime-accounting.ts:23-69`) como fallback tras crash; `programmaticUsageAvailability` (`:582-588`) acepta la nueva forma. Test de paridad: suma de filas == `invocationUsage`.
- `delivery-evidence.ts:102-112, 497-557`: `readRuntimeEvidence` lee `runtime status --compact` (ledger) en vez de `checkpoint.json`; `reviewerStepId` *(propuesto)*.
- Cliente: `LoopStepExplorer.tsx` (ramas y componentes anidados), `AgentRuntimeRuns.tsx`/`useRuntimeRuns.ts`, `LogViewer.tsx`, `PipelineProgress`; `docs/internals/loop-step-log-explorer.md`.
- Dependencias: D1.

### D3 — Pausas humanas y "repetir desde aquí"

- Pausas: `pendingQuestion`/`pendingApproval`/`gate` → `awaitHumanDecision` (`loop-run-manager.ts:1496-1554`; `loop_runs.status = 'paused'`, `job.interactive` con `acceptingTurns: true`); respuesta por `POST /:projectId/jobs/:id/messages` (`project-router-jobs.ts:364-384`) → `resume --answer|--approve` desde el lanzador; un solo escritor (`AgentRuntimeControls.resume`, `agent-runtime-controls.ts:285-386`, queda para continuaciones post-terminales).
- "Repetir desde aquí": acción en el explorer sobre cualquier paso terminado → `runtime fork --from <nodeId>` → nuevo run enlazado (`forkOf`) en el mismo worktree, con la misma liquidación.
- Tests: `loop-run-manager.test.ts`, `project-router-jobs.test.ts`, `agent-runtime-controls.test.ts`.
- Dependencias: D2, C3.

### D4 — Reanudación tras reinicio de Desktop

- Migración **64** *(propuesta)*: `run_request_json` en `loop_runs` (`migrations.ts:711-731`): el `LoopRunRequest` sin callbacks (definición compilada, constants, `followUp`, `addenda`, `executionManifest`, `cwd`/`repoDir`, `railIndex`, `ticketCompletionStatus`).
- `reconcileOrphanLoopRuns` (`loop-runs-store.ts:553-609`): un run del motor v2 con `run_request_json` y checkpoint reanudable ⇒ `paused` con motivo `restart`, sin tocar la fila `jobs`; el resto, comportamiento actual.
- Acción `resume` en `project-router-loop-runs.ts` que relanza el bridge con `resume` y re-adjunta la liquidación aislada desde la fila durable de `rail_pr_deliveries` (`reattachIsolatedSettlement` *(propuesto)* en `rail-isolated-launch.ts`; `:1242-1250` deja de aparcar `settlement_interrupted`).
- Tests: `loop-runs-store.test.ts`, `rail-isolated-launch.test.ts`, `server/db.test.ts`.
- Dependencias: D2.

### D5 — Grafos de fábrica en Desktop

- `loop-factory.ts`: `factory:sdd-quick-openspec` como definición (etapa 3, primer grafo de producto sobre el motor v2); `factory:freestyle` (etapa 4); `factory:implement` y `factory:batch` con la pieza `implementation` (etapa 5; batch = todos los tickets del rail, y con `map` por ticket cuando se quiera paralelismo); cuando el Core activo no anuncia `engineV2`, caen al camino actual.
- `loop-templates.ts`: re-expresar `ship-and-green`, `verify-pass`, `ci-watch`, `lint-and-fix` y el resto con piezas; `fixLoopGraph(['{{cmd:implement}}'])` pasa a `implementation` seguido de `verify → decider → prompt(fix)`.
- Tests: `loop-factory.test.ts` (paridad con la definición de referencia de Core), `loop-templates.test.ts`.
- Dependencias: D1 y las piezas de Core de cada etapa.

### D6 — Agents como biblioteca de roles

`profiles-router.ts:456-536` y Agent Studio proyectan `custom-*.md` a `roles.<id>` (prompt, `access`, `artifacts`, engine, `openspecSkill`); los `sr-*` se muestran como built-ins; orquestador y `routing` de perfiles obsoletos (retiro en D8). Tests: `profiles-router.test.ts`, Agent Studio, `loops-router.test.ts`. Dependencias: D1b, C5.

### D7 — Steering y observabilidad

`POST /:projectId/agent-runtime/runs/:runId/steer` → `runtime signal` con el runtime retenido; el composer del job (`InteractiveJobComposer.tsx`) se reutiliza con semántica "entregado en la siguiente frontera de intento" y los recibos de `docs/agent-live-steering.md`; `server/mcp/tools/jobs.ts:43-55` `runtime_steer`; vista de trazas por run desde los spans. Dependencias: C8.

### D8 — Migración de loops antiguos y retiro del motor de Desktop

Compilador de compatibilidad (`ai-step → prompt`, `shell → shell`, `decider → decider`, `condition → condition`, `{{cmd:implement|batch}}` → `implementation`), migración de la tabla `loops`, revalidación en Core, paridad sobre todas las plantillas y factorías; retirada del recorrido de `loop-run-manager.ts`, `rails-router.ts:1257-1260`, `rail-isolated-launch.ts:1897-1952` (`runMergeBack`), `core-execution.ts:139`, `core-completion.ts:60`, `operation: 'core-implementation'`, `SPECRAILS_PROFILE_PATH` (`queue-manager.ts:2475-2577`, `loop-executors.ts:189-201`), perfiles; GC de `.specrails/runtime-packages/<digest>` y `pipeline/<runId>`; contrato 6.0; actualización de `openspec/specs/loop-execution/spec.md:158-166`, `rail-loop-execution/spec.md:101-113` y `docs/internals/companion-rails-as-loops-contract.md`. Dependencias: telemetría y paridad (etapa 7).

## 9. Orden de trabajo

| Etapa | Bloques | Par de releases | Entregable y comprobación para avanzar |
|---|---|---|---|
| 1. Higiene, spikes y roles abiertos | C0 + C1 + C2 + D0 | Core 6.1.0 (contrato 5.1) / Desktop 2.58.0 | Contrato sin deriva; decisión de checkpointer, subgrafos y streaming documentada con evidencia en las tres plataformas; roles abiertos con snapshot de argv intacto; `check-core-compat` y fixture v4 en verde |
| 2. Núcleo del motor v2 | C3 | Core 6.2.0 | Motor con piezas simuladas pasando la matriz de robustez en Linux, macOS y Windows; `fork`, `resume`, `status`, `validate` operativos; sin cambios visibles en Desktop |
| 3. Piezas básicas y Quick SDD | C4 + D1 + D1b + D2 + D5 (Quick SDD) | Core 6.3.0 / Desktop 2.59.0 | El usuario compone y publica grafos con piezas básicas; Quick SDD corre como definición de Desktop sobre el motor v2 con paridad de secuencia; pasos y contabilidad desde eventos |
| 4. Agentes, pausas y reanudación | C5 + D3 + D4 + D5 (Freestyle) | Core 6.4.0 / Desktop 2.6x | `role-turn`, `decider`, `verify` con la semántica de loops expresada en el motor; pausas desde el chat del job; "repetir desde aquí"; reinicio ⇒ `paused` y reanudación sin duplicar |
| 5. Implement y fan-out | C6 + C9 + D5 (Implement, Batch) + D6 | Core 6.5.0 / Desktop 2.6x | Implement y Batch como definiciones de Desktop con paridad de receipts frente al legado; `map`/`join`/`component` en el builder; Agents como biblioteca de roles; documentación del motor |
| 6. Memoria, steering y evaluación | C7 + C8 + D7 | Core 6.6.0 / Desktop 2.6x | Store por proyecto; steering por buzón con el composer reutilizado; evaluación por definición; trazas |
| 7. Telemetría y paridad | — | — | Dos releases de datos: lanzamientos legados a cero; compilador de compatibilidad con paridad sobre todos los grafos guardados y plantillas |
| 8. Retiro de legado | D8 + C10 (Core 7.0 / contrato 6.0) | emparejado obligatorio | Un solo motor, un solo camino de entrega, perfiles retirados, GC |

Cada etapa se entrega sola; la 2 es solo Core y no cambia nada visible. Core puede publicarse antes que Desktop dentro de cada etapa. La batería completa (`npm run typecheck`, `npx vitest run server/modules`, `npm run test --prefix client`, `npm run audit:architecture`, `npm run docs:source-map`, `npm run check-core-compat`; en Core `npm run ci`) se ejecuta sobre el resultado integrado de cada etapa.

Estimación orientativa para un solo maintainer, sin contar releases: etapa 1, tres a cuatro semanas; etapa 2, cinco a seis semanas; etapa 3, cinco a seis semanas; etapa 4, cuatro semanas; etapa 5, cinco a seis semanas; etapa 6, tres semanas; etapa 7, sin desarrollo; etapa 8, tres a cuatro semanas. En total entre seis y ocho meses de trabajo efectivo, con valor visible para el usuario a partir de la etapa 3.

## 10. Matriz de robustez (obligatoria desde C3)

Se ejecuta en CI sobre grafos de piezas simuladas y, desde C4, sobre las definiciones de referencia:

- Kill -9 del proceso de Core en cada frontera de nodo y a mitad de cada nodo de escritura ⇒ `resume` continúa; los nodos de escritura interrumpidos exigen `--recover`; ningún nodo terminado se repite; el ledger y el checkpoint nunca discrepan (consulta cruzada en `run.sqlite`).
- Dos procesos intentando el mismo run ⇒ el segundo falla por lease; un lease caducado por muerte del propietario se recupera con heartbeat expirado.
- Presupuesto de coste, tokens y duración alcanzado antes de cada nodo y dentro de un `map` ⇒ `blocked` con motivo; el uso reportado nunca se pierde en una pausa o fallo.
- `recursionLimit` alcanzado en ciclos ⇒ `blocked` legible; `failFast` y `noProgress` ⇒ `end(failure)`/`stalled`.
- Interrupciones dentro de subgrafos y ramas de `map` ⇒ pausa y reanudación por rama; `fork` desde un nodo interno de `implementation` conserva el run original.
- Reanudación con definición modificada ⇒ rechazo por hash; con paquete de Core distinto ⇒ rechazo por identidad.
- Salidas y `$history` acotados: un nodo que produce 10 MB no rompe el protocolo JSONL.
- Windows: rutas, comillas y kill de árbol de procesos en `prompt`/`shell`; `run.sqlite` con WAL sobre NTFS.
- Cancelación en cada estado (nodo de IA en curso, verificación en curso, pausa, `map` con ramas activas) ⇒ procesos hijos terminados y checkpoint reanudable.
- Paridad con el legado: la definición de referencia de implement produce los mismos receipts y aceptación sobre el corpus de evaluación; Quick SDD y Freestyle de referencia reproducen la secuencia de pasos de sus grafos actuales.

## 11. Riesgos y trampas con mitigación

- **Binding SQLite en el paquete de Core.** Con `better-sqlite3`, empaquetado por plataforma y compatibilidad de ABI con el Node empaquetado de Desktop; con `node:sqlite`, subida de `engines.node` a 22.13 y retirada de Node 20 de la matriz de CI de Core. Mitigación: spike 1 con criterio de salida; `FileCheckpointSaver` extendido como reserva; `check:package` amplía la comprobación a las tres plataformas.
- **Límites reales de LangGraph 1.4 en subgrafos con interrupciones y `Send`.** Mitigación: spike 2 antes de diseñar el compilador; las piezas `map`/`component` llegan en la etapa 5, no antes.
- **Alcance de un solo maintainer.** Seis a ocho meses. Mitigación: etapas independientes con valor desde la 3; el legado sigue funcionando todo el tiempo; ninguna etapa exige reescribir la anterior.
- **Permisos definidos por el usuario.** Un rol con `access: 'write'` o un `prompt` con escritura ejecuta código en el repositorio con el sandbox del developer de cada CLI (`cli-executor.ts:44-72`). Mitigación: `access`/`artifacts` los aplica Core, nunca el prompt; guardrails de Core; los grafos con escritura exigen `verified` para entregar; Desktop marca los nodos con escritura.
- **Paridad de proveedores.** Kimi sin uso ⇒ `estimated`; Gemini `unknown` gateado (`capabilities.ts:17`); solo Claude acepta tope en USD (`cli-executor.ts:205-208`); salida estructurada leniente fuera de Claude/Codex. El snapshot `__fixtures__/claude-architect-invocation.snapshot.json` guarda C2.
- **Fan-out con CLIs pesados.** Coste y límites de cuota. Mitigación: concurrencia por defecto 1, tope configurable, presupuesto compartido por run.
- **Pérdida del composer en mitad de un turno.** Core ejecuta turnos cerrados; el steering entra en fronteras de intento. Mitigación: el composer se conserva con semántica "entregado en el siguiente paso" y recibos; misiones no cambian.
- **Dos formas de invocar proveedores seguirán existiendo.** Desktop conserva sus adaptadores para chat, generación de specs y explorar. Mitigación: la ruta de loops usa solo la de Core; no se intenta unificar en esta iniciativa.
- **Migración de loops antiguos.** Mitigación: no cambian de motor hasta la etapa 8 y solo tras paridad del compilador de compatibilidad.
- **Evolución de las piezas.** `nodeKindsVersion`, runs congelados con paquete retenido, cambios de comportamiento solo con subida de versión.
- **Veredicto negativo confundido con fallo.** Un rechazo es un run `succeeded` con `completion.ok: false`; exit 1 solo para errores de ejecución.
- **Ownership de git.** `SPECRAILS_GIT_AUTO=false` es condicional (`loop-executors.ts:131`); D1 fuerza `host` en todo run del motor v2. Los grafos no deben tocar git aunque un `prompt` pueda hacerlo; la entrega sigue siendo de Desktop.
- **Journal.** `ledger-only` deja `state.json` sin fases; los lectores consultan `workflow.journal` antes de interpretar fases (`inspectPipeline` desde Desktop).
- **Companion.** Sin tipos WS nuevos; los `loop.run_*` y frames `event` siguen; actualizar `docs/internals/companion-rails-as-loops-contract.md`.
- **Superficie de tests.** `loop-run-manager.test.ts`, `rail-isolated-launch.test.ts` y `workflow.test.ts` no se reescriben antes de la etapa 8; la matriz de robustez es nueva.

## 12. Qué NO hacer

- No portar a código imperativo las reglas del motor de loops de Desktop: se expresan con estado, reducers, aristas condicionales y `retryPolicy`.
- No permitir código del usuario ni tipos de nodo definidos por el usuario dentro de Core: solo la librería cerrada de piezas y los componentes compuestos con ellas.
- No ejecutar pasos de loops nuevos en Desktop ni dejar que Desktop decida el sucesor de un nodo.
- No abrir stdin de Core ni un canal bidireccional: interrupciones con exit 2 y `resume`; steering por buzón.
- No portar a Core el transporte de sesión viva de Claude y Codex (steering en mitad de un turno) en esta iniciativa: decisión del maintainer del 26 de septiembre de 2026; las misiones lo conservan en Desktop.
- No cambiar `id`, `ends`, `maxTransitions` ni orden del `specrails-implementation` legado mientras exista (`core-host.ts:79`, `workflow.ts:174-176`); el grafo de fábrica de Desktop es una definición distinta.
- No retirar el motor legado de Core antes de Core 7 ni sin comprobar que los runs antiguos reanudan con su paquete retenido.
- No cambiar `pipeline-state.ts` (fases por tipo de journal): se copia compilado en cada proyecto.
- No importar Core como ESM en proceso: `agent-runtime-loader.ts:67-73` lo evita a propósito.
- No introducir `Team`/`Recipe` como sustantivo de producto: el término es **workflow**/**grafo**, la unidad es **pieza**, los reutilizables son **componentes**, y la sección sigue llamándose **Loops**.
- No aplicar `checkCoreCompletion` a un grafo del motor v2 ni entregar a revisión un grafo con escritura sin `verified`.
- No dejar que Core escriba `ai_invocations`.
- No adoptar la plataforma alojada de LangSmith como dependencia: trazas por OpenTelemetry opcional.
- No retirar QueueManager slash, merge-back, el motor de loops de Desktop ni los perfiles antes de la etapa 8.

## 13. Ideas adicionales

1. Exportar definiciones al repositorio del proyecto como `.specrails/workflows/<id>.json` *(propuesto, ruta reservada de Desktop)*, versionadas con el código; etapa 3.
2. Capacidad MCP por run para `role-turn`/`prompt` (`mintAgentCapability`, `agent-mcp-config.ts:311-360`) con tier observe; etapa 6.
3. `map` sobre repositorios para verificación paralela multi-repo, sustituyendo la concurrencia interna actual de verificación; etapa 5.
4. Persistir `loopId` en el rail para relanzar el mismo grafo; etapa 3.
5. Tarjeta de misión `workflow-launch` (`rail-launch-parser.ts` ⇄ `rail-launch-draft.ts`) que proponga spec + grafo + engine; etapa 6.
6. Galería de componentes compartibles con firma del origen y aviso de permisos de escritura al importar; etapa 5.
7. Transporte de sesión viva de Claude y Codex dentro de Core, para que el steering en loops entre en mitad de un turno como en misiones; fuera de esta iniciativa por decisión del maintainer, candidato a una iniciativa posterior una vez estable el motor v2.

## 14. Decisiones tomadas y preguntas abiertas para el maintainer

1. **Decidido el 26 de septiembre de 2026: sí.** SQLite es el diseño elegido para el checkpointer y el ledger, y el maintainer acepta que Core lleve un módulo nativo si hace falta. El spike 1 de C1 ya no elige entre SQLite y ficheros: decide el binding (`node:sqlite` sin módulo nativo, o `better-sqlite3` con él) y valida el empaquetado con criterio de salida en las tres plataformas; `FileCheckpointSaver` extendido queda solo como reserva si ambos bindings fallan en alguna de ellas.
2. **Decidido el 26 de septiembre de 2026: sí.** El steering en loops entra en fronteras de intento por el buzón (C8, D7). El transporte de sesión viva de Claude y Codex (`providers/live-session.ts` en Desktop) **no se porta a Core en esta iniciativa**; las misiones conservan su steering inmediato sin cambios.
3. ¿Los roles se definen por proyecto o globalmente en Agents? *Suposición: global con override por proyecto; la configuración congelada por run resuelve la mezcla.*
4. ¿Concurrencia por defecto de `map`? *Suposición: 1, configurable hasta 4, con presupuesto compartido.*
5. ¿Se mantiene `SPECRAILS_LOOPS_SECTION=false` y el caso `SPECRAILS_RAIL_DELIVER_PR=0` sin manifiesto? *Suposición: solo hasta la etapa 8; el segundo se corrige en D1.*


### Registro de implementación (2026-09-26)

Estas decisiones son la actualización vigente de las referencias históricas del plan. Los documentos copiados conservan el contenido entregado para trazabilidad; el contrato normativo actualizado está en [`../contracts.md`](../contracts.md).

6. **Identidad auditada:** `package.json` es 6.0.1, `CORE_WORKFLOW_VERSION` es `'7'` y `ROLE_INSTRUCTIONS_VERSION` es `'10'`. C0 corrige el contrato a 7/10 y congela esa identidad. No se restauran 6/9 ni se modifican los runs retenidos.
7. **Primera entrega:** crear y validar estrictamente los cambios OpenSpec emparejados antes de código. Preparar C0, C1 y D0 en ramas/PRs separadas; no declarar terminada la iniciativa. D0 puede desarrollarse como PR emparejada, pero su aceptación de release exige C0 publicado. No publicar releases automáticamente.
8. **CLI completo:** incluir `evaluate` en las operaciones de máquina del contrato desde C0. El catálogo exportado también reconoce `help`, que es presentación y queda excluido de la lista de integración de forma explícita. Esta decisión corrige la omisión de `evaluate` en la lista de tareas C0.
9. **Spikes y CI:** no elegir un binding ni subir Node por anticipado. Conservar las pruebas existentes y añadir evidencia reproducible en macOS arm64, Windows x64 y Linux x64 con Node 22.22.3; los resultados locales no satisfacen por sí solos el gate de C1. Optimizar CI mediante separación de responsabilidad y reutilización de instalación/build cuando sea válido, sin eliminar plataformas, umbrales ni comprobación del paquete publicado.
10. **Capacidades progresivas:** C0 declara motor 1, ningún tipo de pieza y built-in legado 7. `engineV2`, `fanOut`, `openRoles` y `steeringInbox` solo se anuncian cuando realmente estén implementadas. API sigue en 1.
11. **Frontera de arquitectura:** el motor no importa `installer/`; shell usa `cli-process.ts` o utilidades compartidas extraídas preservando las reglas de arquitectura. `pipeline-state.ts` permanece sin nuevas dependencias.
12. **Contrato sobre ejemplos del plan:** `ends` es un mapa etiqueta→destino, eventos usan `nodePath` y `branch`, el límite máximo normativo de concurrencia es 8 con valor por defecto 1, y el buzón durable está en `run.sqlite`. La ruta `steering-inbox.jsonl` del boceto no se añade sin una decisión posterior explícita.
13. **Preguntas previas a C3:** resolver con C1 el acoplamiento real entre checkpoint y ledger, namespaces/fork de subgrafos, streaming tras commit y serialización del escritor de steering; precisar el cálculo inicial de `version`, los canales privados de enrutado y la semántica del receipt de `verify`. No rellenar esas incógnitas con APIs supuestas.
14. **Documentación y alcance final:** actualizar Core, Desktop y Web según funcionalidades realmente entregadas; la documentación pública no presentará el motor v2 como disponible durante C0/C1/D0. C9 y el cierre integrado incluyen la sincronización de los tres repositorios. C10/D8 siguen sujetos a paridad y dos releases de telemetría.
15. **C0, captura antes de extraer:** los fingerprints se calcularon con el serializador y los descriptores de `coreNodes` existentes antes de cambiar código: con tres intentos, normal `8027c61b71888f583f9418d5388df95bcd233b03d224e0209b3327104511bb74` y compacto `89b61af29b684f9dc8b2969b864d89d3dd09bb49c9c6b5fc30e33d04f87d419a`. Las pruebas inspeccionan los nodos reales sin ejecutar proveedores; duplicar sus metadatos en mocks no detectaría una deriva en producción. Se añade `cliPresentationOperations: ["help"]` al contrato para hacer verificable la clasificación de presentación. Se mantiene la extracción pura y el presupuesto de transiciones sin cambios.

## 15. Cómo retomar este plan más adelante

1. Verificar contra `main` de ambos repos: versiones de `@langchain/langgraph` y `@langchain/langgraph-checkpoint` (`package.json:75-77`), `CORE_WORKFLOW_VERSION`, `ROLE_INSTRUCTIONS_VERSION`, `integration-contract.json` (`schemaVersion`, `agentRuntime.engine`, `nodeKinds`, `cliOperations`, `phases`), `SUPPORTED_CORE_MAJORS`, `CORE_BUNDLE_VERSION`, última migración de Desktop (63 al escribir esto).
2. Saber qué bloques están hechos: C0 ⇔ existe `__fixtures__/implementation-workflow-fingerprint.json`; C1 ⇔ existen los tres informes en `docs/engine-v2/spikes/`; C2 ⇔ `AgentRequest` tiene `access`; C3 ⇔ existe `src/agent-runtime/engine/definition/compile.ts` y `runtime api` emite `engineVersion: 2`; C4 ⇔ existe `engine/pieces/prompt`; C5 ⇔ existe `engine/pieces/decider`; C6 ⇔ existen `engine/pieces/implementation` y `map`; C7 ⇔ existe `engine/store/`; C8 ⇔ `cli.ts` acepta `signal`; D0 ⇔ `STEP_IDS` ya no es constante; D1 ⇔ existe `loop-definition.ts` y `LoopRunManager` no recorre grafos con `kind`; D2 ⇔ `ai_invocations` se escriben desde eventos; D3 ⇔ existe la acción "repetir desde aquí"; D4 ⇔ `loop_runs` tiene `run_request_json`; D5 ⇔ `factory:sdd-quick-openspec` es una definición; D6 ⇔ `profiles-router.ts` proyecta `custom-*.md` a `roles`; D7 ⇔ ruta `/steer`; D8 ⇔ `loop-run-manager.ts` sin recorrido nodo a nodo.
3. Leer antes de tocar: `docs/internals/programmatic-agent-runtime.md`, `docs/internals/agent-runtime-framework-evaluation.md`, `docs/internals/loop-step-log-explorer.md`, `docs/internals/interactive-jobs.md`, `docs/internals/safe-pr-review-flow.md`, `docs/agent-live-steering.md`, `specrails-core/docs/agent-runtime.md`, los informes de spikes y este documento.
4. Tests que deben estar en verde antes de empezar cualquier bloque: Core `workflow.test.ts`, `core-host.test.ts`, `cli.test.ts`, `legacy-runtime.test.ts`, `compact-runtime.test.ts`, `install-config.test.ts`; Desktop `loop-run-manager.test.ts`, `loop-graph.test.ts`, `loop-executors.test.ts`, `agent-runtime-bridge.test.ts`, `agent-runtime-controls.test.ts`, `server/core-execution.test.ts`, `rail-isolated-launch.test.ts`, `delivery-evidence.test.ts`, `server/modules/architecture.test.ts`.
5. Si `main` ya introdujo un formato de definición, un checkpointer SQLite, un campo `access` o un compilador con otro nombre, adoptar el nombre real y actualizar este documento; no duplicar mecanismos.
6. Instrucción para iniciar la siguiente fase: crear los cambios OpenSpec `core-agent-engine` emparejados en ambos repos (propuesta, diseño, specs, tareas C0..C10 / D0..D8 y, en Core, un `contracts.md` compartido con el formato de definición, la librería de piezas y el protocolo), validarlos con `openspec validate --strict --json`, y empezar por **C0 + C1 + D0**, dejando la decisión de checkpointer, subgrafos y streaming escrita antes de tocar C3.
