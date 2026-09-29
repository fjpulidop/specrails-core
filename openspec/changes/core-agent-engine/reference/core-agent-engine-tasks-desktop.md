# Motor de agentes en Core (v2): tareas de specrails-desktop (D0..D8)

Estado: **tareas preparadas; implementación pendiente**. Fecha: 26 de septiembre de 2026. Contrato de referencia: [`core-agent-engine-contracts.md`](core-agent-engine-contracts.md). Plan y etapas: [`core-agent-engine.md`](core-agent-engine.md). Tareas de Core: [`core-agent-engine-tasks-core.md`](core-agent-engine-tasks-core.md). Briefing: [`core-agent-engine-implementer-brief.md`](core-agent-engine-implementer-brief.md).

Convenciones: rutas relativas a la raíz de `specrails-desktop`; identificadores existentes con línea sobre Desktop 2.57.0; nuevos marcados *(propuesto)*. Reglas fijas de este repositorio que aplican a todos los bloques (ver `AGENTS.md`): las migraciones se añaden al final de `server/db/migrations.ts` y nunca se renumeran (la última es la **63**); todo fichero nuevo o movido bajo `server/modules/**` se registra en `server/modules/boundaries.json` mediante el script de auditoría y se refleja con `npm run docs:source-map`; el tipado incluye locales e imports sin uso (`npm run typecheck`); las cadenas visibles llevan clave en los ocho locales de `client/src/i18n/` con su test de paridad; los umbrales de cobertura (`vitest.config.ts`, `client/vitest.config.ts`) no se rebajan.

Comandos base: raíz `npm ci`, cliente `npm ci --prefix client`; `npm run typecheck`; `npx vitest run <ruta>`; `npm run test --prefix client -- <ruta>`; `npm run audit:architecture`; `npm run docs:source-map`; `npm run check-core-compat`; `npm run ci` completo antes de cerrar una etapa. Para probar contra un Core de desarrollo: `SPECRAILS_CORE_RUNTIME_PATH=<core>/dist/agent-runtime/index.js` (`docs/internals/programmatic-agent-runtime.md`).

## D0 — Compatibilidad y validadores derivados del catálogo

Precondición: Core C0 publicado (contrato 5.1).

Tareas:

1. `server/modules/agent-runtime/runtime/agent-runtime-loader.ts:78-117`: ampliar `RuntimeApi` con `engineVersion?: number`, `nodeKinds?: string[]`, `nodeKindsVersion?: number`, `builtins?: Array<{ id; version; deprecated }>` y las capacidades `engineV2`, `workflowDefinitions`, `openRoles`, `fanOut`, `fork`, `steeringInbox` (todas opcionales; validación de forma como la actual de `workflowVersions`). Añadir al módulo devuelto `validateWorkflowDefinition(input: unknown): { ok: true; version: string; graph } | { ok: false; errors }` que invoca `workflows validate --stdin` con el mismo `invoke` que `validateRuntimeConfig` (línea 96-105) y lanza `Error('Installed Core does not support workflow definitions…')` si falta `workflowDefinitions`.
2. `server/modules/agent-runtime/runtime/agent-runtime-controls.ts:23, 82`: `STEP_IDS` deja de ser constante: `stepIdsFor(status)` *(propuesto)* devuelve `Object.keys(status.state.steps)` cuando el estado es del motor v2 y la lista actual en otro caso; `validateRuntimeResumeInput` acepta `nodePath` con `/`.
3. `server/modules/agent-runtime/runtime/agent-runtime-metrics.ts:25, 43, 49, 76, 91`: `PHASES` y el límite de tres roles validan contra los `steps`/`roles` del run; sin catálogo, comportamiento actual.
4. `server/core-compat.ts` y `scripts/check-core-compat.ts:60-70`: constante esperada del contrato → `5.1`; `DESKTOP_KNOWN_COMMANDS` sin cambios; los bloques `engine`, `nodeKinds` y `builtins` son informativos.
5. `server/modules/agent-runtime/runtime/agent-runtime-package.test.ts:67`: `workflowVersions: ['6']`. `docs/internals/programmatic-agent-runtime.md:110, 112, 118`: fixer en fases, caché por digest, pin 6.x.

Tests: `agent-runtime-loader.test.ts` (API con y sin campos nuevos; `validateWorkflowDefinition` propaga `errors`), `agent-runtime-controls.test.ts` (resumen con `steps` no estándar), `agent-runtime-metrics.test.ts`, `agent-runtime-package.test.ts`, `server/core-compat.test.ts`.

Aceptación: `npm run check-core-compat` con Core 6.1.0; `npm run typecheck`; `npx vitest run server/modules/agent-runtime`.

Hecho cuando: un `runtime status` del motor v2 con seis pasos de nombres arbitrarios no es rechazado por controles ni métricas, y Desktop puede pedir a Core la validación de una definición.

## D1 — Editor de definiciones, compilador y lanzador sin ejecución

Precondición: Core C4 publicado (`engineV2`, piezas básicas). Desktop no ejecuta ningún paso de los grafos nuevos.

Tareas:

1. **Modelo.** `server/modules/loops/runtime/loop-graph.ts:12-35`: `LoopNodeType` gana `'core'`; `LoopNode.data` gana `kind?: CoreNodeKind` (los `kind` del contrato 4) y `params?: Record<string, unknown>`; exportar `isDefinitionGraph(graph): boolean` *(propuesto)* (⇔ algún nodo `type === 'core'`) y `assertDefinitionGraph(graph)` (un grafo no mezcla nodos `core` con los tipos antiguos `ai-step`/`shell`/`decider`/`condition`). `validateLoopGraph` valida estructura (`start`, `end`, aristas, etiquetas de salida por pieza leídas del catálogo) y delega parámetros a Core en publicación. Las aristas de un nodo `core` llevan `label` *(propuesto, análogo a `branch`)* con la etiqueta de salida. Espejo en `client/src/features/loops/lib/loops-api.ts` (tipos) y `loop-validate.ts`.
2. **Catálogo en Desktop.** `server/modules/agent-runtime/runtime/agent-runtime-settings-router.ts` (ruta `/agent-runtime/capabilities` existente): incluir `nodeKinds` con `paramsSchema`, `outcomes`, `effect`, `executor` tal como los devuelve `runtime workflows` (nuevo método `listWorkflows()` en el loader). El cliente lee la paleta de ahí.
3. **Compilador.** `server/modules/loops/runtime/loop-definition.ts` *(propuesto)*: `compileLoopToDefinition(graph: LoopGraph, launch: { spec?, constants, provider, model, effort, roles, changeId? }): DefinitionDocument`: interpola `{{spec.*}}` (`interpolateSpec`), `{{const:*}}` (`resolveConstants`) y `{{cmd:*}}` (`expandCommands` con el proveedor del `engine` del nodo, `loop-command-catalog.ts:381`; los comandos nativos se emiten como `params.nativeCommand`); `config.maxIterations → maxTransitions` (= iteraciones × nodos del ciclo mayor + 2 × nodos con `retry`), `timeoutMinutes → budget.maxDurationMs`, `maxCostUsd → budget.maxCostUsd`; aristas etiquetadas → `ends`; `end.outcome`; `delivery.requiresVerified` = existe algún nodo con efecto de escritura; `version` se rellena con el valor devuelto por `validateWorkflowDefinition`. Función pura y determinista (test de propiedad: misma entrada ⇒ misma salida ⇒ mismo hash).
4. **Publicación.** `server/modules/loops/runtime/loops-router.ts` (`POST /loops/:id/publish`): para grafos de definición, compila con un lanzamiento de muestra (`spec` vacío, proveedor primario) y llama a `validateWorkflowDefinition`; si `ok: false`, responde 400 `{ errors: [{ code, nodeId, path, message }] }`; el cliente pinta los errores en el canvas. Sin Core compatible ⇒ 409 `engine_unsupported` con texto de actualización.
5. **Lanzador.** `server/modules/loops/runtime/loop-run-manager.ts:1038` (`run`): si `isDefinitionGraph(req.graph)`, delegar en `runDefinitionLoop(req)` *(propuesto, en `server/modules/loops/runtime/loop-definition-run.ts`)* y no entrar en el recorrido actual. `runDefinitionLoop`: crea la fila `loop_runs` y `jobs` como hoy, emite `loop_graph` a partir de `runtime-graph`, congela `desktop-workflow-definition.json` (`wx`, junto a `desktop-context.json` producido por `prepareCoreExecution`, `server/core-execution.ts:56-105`, forzando `ownership.git: 'host'` en la línea 89 para todo run v2), lanza `runAgentRuntimeInvocation` con `definitionPath`, proyecta eventos (D2), atiende pausas (D3), cancela (`treeKillSafe` del hijo) y liquida con el mismo `onLoopRunFinished`/outbox terminal (`loop-runs-store.ts:142-232`). No hay `runAiStep`, `runShell` ni `runDecider` en este camino.
6. **Bridge.** `server/modules/agent-runtime/runtime/agent-runtime-bridge.ts:41-62, 81-111`: opción `definitionPath?: string` ⇒ `--definition`; parseo de `runtime-graph`, `completion`, `forkOf` y de los campos aditivos de `workflow-event`; `AiStepResult` gana `completion?: { ok; reasons; verified }` y `graph?` *(propuestos)*; si el Core activo no anuncia `engineV2`, rechazar antes de lanzar con `Error('El Core instalado no admite grafos del motor v2; actualiza Core')`.
7. **Gate de entrega.** `server/core-execution.ts`: `checkCoreWorkflowCompletion(contextPath, cwd, env, runId): CoreCompletionCheck` *(propuesto)*: `runtime status --compact` ⇒ `valid` ⇔ `state.status === 'succeeded' && completion.ok && (completion.verified || !escribe)`. `server/modules/delivery/runtime/rail-isolated-launch.ts`: la liquidación aislada usa este gate para los runs v2 y `checkCoreCompletion` (`core-execution.ts:137-181`) solo para el legado; `completion.ok: false` es un run correcto con veredicto negativo (`implementation_failed` en la entrega, sin `failed` en el job).
8. **Builder.** `client/src/features/loops/pages/LoopBuilderPage.tsx` y `client/src/features/loops/lib/loop-graph-rf.ts`: paleta con dos grupos, "Core" (piezas con IA, verificación, OpenSpec, control) y "Desktop" oculto para grafos nuevos (los tipos antiguos solo se muestran al editar un grafo antiguo); inspector por pieza generado desde `paramsSchema` (campos `string`, `integer`, `boolean`, `enum`, `object` plano) con editores dedicados para `engine` (proveedor/modelo/esfuerzo del proyecto), `roleId` (biblioteca de roles, D1b), `text` (editor de prompt con los `{{cmd:*}}` actuales), `nativeCommand`, `captureVars`, `ends` (handles por etiqueta, como hoy `branch` del decisor); `component` abre un sub-canvas; `map` con selector de `body`; indicador por nodo de efecto de escritura. Nuevas claves en los ocho locales de `client/src/i18n/`.
9. **Documentación de usuario.** `docs/running-pipelines.md` y `docs/guide/en/pipeline/5-the-loop-builder.md`: sección "Grafos ejecutados por Core" con un ejemplo de Quick SDD.

Tests: `loop-graph.test.ts` (grafos mixtos rechazados; etiquetas de salida; `isDefinitionGraph`), `loop-definition.test.ts` *(propuesto)* (interpolación, `maxTransitions`, `nativeCommand`, determinismo), `loops-router.test.ts` (publicación con errores por nodo; 409 sin Core), `loop-definition-run.test.ts` *(propuesto)* (con un bridge falso: fila `loop_runs`, `loop_graph`, congelado `wx`, cancelación, liquidación), `loop-run-manager.test.ts` (los grafos sin `type: 'core'` no cambian de comportamiento: la suite actual pasa sin tocar), `agent-runtime-bridge.test.ts`, `server/core-execution.test.ts` (`ownership.git` siempre `host` en v2; gate v2), `rail-isolated-launch.test.ts` (invariante: `completion.ok` sin `verified` en grafo con escritura ⇒ no `on_review`), cliente: `loop-validate.test.ts`, tests del inspector, paridad i18n.

Aceptación: `npm run typecheck`; `npx vitest run server/modules/loops server/modules/agent-runtime server/modules/delivery`; `npm run test --prefix client -- src/features/loops`; `npm run audit:architecture`; `npm run docs:source-map`.

Hecho cuando: un grafo de piezas básicas se compone, publica y lanza desde un rail, Core lo ejecuta y el job muestra `loop_graph` y los eventos, sin que Desktop ejecute ningún paso.

**D1b — Biblioteca de roles mínima** (precondición: Core C2). Re-vendorizar `server/schemas/agent-runtime.schema.json` (paridad `agent-runtime-settings.test.ts:192-194`); `agent-runtime-settings.ts:139, 320` y `client/src/features/settings/lib/agent-runtime.ts:4-7` renderizan `roles` además del trío; los chequeos espejo de `config.ts` (`agent-runtime-settings.ts:168-212`) aceptan `roles` con `access`/`artifacts`; `AgentRuntimeSettingsSection.tsx` gana filas de rol (id, prompt, `access`, `artifacts`, engine) con validación de id `^[a-z][a-z0-9-]{0,63}$`. Tests: `agent-runtime-settings.test.ts`, paridad de schema, i18n.

## D2 — Pasos, ramas y contabilidad desde los eventos

Precondición: D1.

Tareas:

1. `server/modules/loops/runtime/loop-definition-run.ts`: proyección de eventos. `runtime-graph` → `loop_graph` (`LoopGraphEventPayload`, `loop-run-manager.ts:456-466`, con el grafo del loop y el `mermaid`); `workflow-event step_started` → `loop_step` con `kind` = pieza, `nodeId` = `nodePath`, `iteration` = visitas del `decider` (o 1), `attempt`, `branch?`, `component?` *(campos aditivos en `LoopStepEventPayload`, líneas 397-431)*; `step_succeeded|failed|blocked|interrupted|paused` → `loop_step_end` con `status` (`ok`, `failed`, `stalled` si `error_code === 'idle_timeout'`, `paused` *(nuevo)*), `outcome` *(nuevo)*, `exitCode` para `shell`; `agent-event` y `verification-output` → líneas de log como hoy en el bridge (`agent-runtime-bridge.ts:148-170`); `loop.run_progress` con `iteration` y `activeNode`.
2. Contabilidad: por cada `runtime-efficiency-event` con `status` final (o `workflow-event step_*` terminal con `usage`) insertar una fila en `ai_invocations` (`surface = 'loop'`, `loop_run_id`, `provider`/`model` del evento, tokens y coste con `NULL` para desconocido, `duration_ms`, `num_turns` = `toolCalls`), dentro de la transacción de `completeLoopStepRecovery` (`loop-run-manager.ts:1407-1418`) reutilizada para el camino v2; sustituir `splitInt` (`:600-605`) por `server/util/distribute-int.ts`. `programmaticUsageAvailability` (`:582-588`) acepta filas por pieza (ya no hay fila agregada `agent-runtime` en runs v2). `parseProgrammaticUsage` (`agent-runtime-accounting.ts:23-69`) sigue como fallback si el proceso muere sin eventos terminales.
3. `server/modules/delivery/runtime/delivery-evidence.ts:102-112, 497-557`: `readRuntimeEvidence` acepta la forma v2: lee `runtime status --compact` (o directamente `run.sqlite` no: siempre por CLI) y toma `review` del `$outputs` del nodo `reviewer` (subgrafo `implementation`) o del `reviewerStepId` *(propuesto)* declarado en el `EvidenceHarvestUnit`; conserva la proyección a `evidence.confidence` (`:436-446`).
4. Cliente: `client/src/features/loops/components/loop-log/LoopStepExplorer.tsx` (ramas y componentes anidados, ejecutor y efecto por paso), `loop-log-model.ts`, `narration-model.ts`; `client/src/features/jobs/...` `LogViewer.tsx` y `PipelineProgress` toleran ids de paso arbitrarios; `AgentRuntimeRuns.tsx`/`useRuntimeRuns.ts` muestran `completion`. `docs/internals/loop-step-log-explorer.md` actualizado.

Tests: `loop-definition-run.test.ts` (proyección completa a partir de un JSONL grabado de Core; `seq` monótono), `agent-runtime-accounting.test.ts`, `loop-runs-store.test.ts` (sin doble conteo tras reinicio), `delivery-evidence.test.ts` (evidencia v2 con y sin `reviewerStepId`), tests del explorer y del narrador; test de paridad: suma de filas `ai_invocations` del run == `invocationUsage` del `runtime-result`.

Aceptación: suites de `server/modules/loops`, `server/modules/delivery`, `server/modules/agent-runtime`, cliente `src/features/loops` y `src/features/jobs`.

Hecho cuando: un run v2 muestra cada nodo como paso con su uso y `spending` cuadra con Core.

## D3 — Pausas humanas y "repetir desde aquí"

Precondición: D2; Core C3 (`fork`).

Tareas:

1. `loop-definition-run.ts`: `runtime-result` con `status: 'paused'` y `pendingQuestion`/`pendingApproval` ⇒ `awaitHumanDecision` (`loop-run-manager.ts:1496-1554`): `loop_runs.status = 'paused'`, `job.interactive` con `acceptingTurns: true`, `loop_step_end.status = 'paused'`. La respuesta por `POST /:projectId/jobs/:id/messages` (`server/project-router-jobs.ts:364-384` → `sendInteractiveTurn`, `loop-run-manager.ts:941-946`) relanza el bridge con `resume` + `answer` (pregunta) o `approve` (aprobación) y sigue proyectando. Un solo escritor: `AgentRuntimeControls.resume` (`agent-runtime-controls.ts:285-386`) sigue reservado a continuaciones tras el fin del loop.
2. "Repetir desde aquí": acción en `LoopStepExplorer` sobre un paso terminado ⇒ `POST /:projectId/loop-runs/:runId/fork { fromNodePath }` *(propuesto, en `server/project-router-loop-runs.ts`)* ⇒ `runtime fork` con nuevo `runId`, nueva fila `loop_runs` con `fork_of` *(columna en la migración de D4)*, mismo worktree y misma liquidación; el run original queda intacto.
3. Cancelación durante una pausa: `POST /:projectId/loop-runs/:runId/cancel` marca `stopped` sin relanzar Core.

Tests: `loop-definition-run.test.ts` (pausa → respuesta → reanudación; aprobación; cancelación en pausa), `project-router-jobs.test.ts`, `project-router-loop-runs.test.ts` (fork), tests del explorer.

Hecho cuando: una `question` de un grafo se responde desde el chat del job y el run continúa; "repetir desde aquí" crea un run enlazado sin tocar el original.

## D4 — Reanudación tras reinicio de Desktop

Precondición: D2.

Tareas:

1. Migración **64** *(propuesta)* en `server/db/migrations.ts` (después de la 63): `ALTER TABLE loop_runs ADD COLUMN run_request_json TEXT`, `ADD COLUMN engine_version INTEGER`, `ADD COLUMN fork_of TEXT`. `run_request_json` guarda el `LoopRunRequest` (`loop-run-manager.ts:258-316`) sin callbacks: `loopId`, `loopName`, `graph`, `projectId`, `cwd`, `repoDir`, `executionManifest`, `railIndex`, `repositoryId`, `ticketId`, `spec`, `ticketCompletionStatus`, `deferTerminalOutcome`, `constants`, `provider`, `model`, `effort`, `isolation`, `followUp`, `addenda`, `deciderEngine`, `profileName`, más `definitionPath`.
2. `server/modules/loops/runtime/loop-runs-store.ts:553-609` (`reconcileOrphanLoopRuns`): una fila con `engine_version = 2` y `run_request_json` cuyo `runtime status --compact` indique estado reanudable (`paused`, `running` con lease expirado, o interrupción pendiente) ⇒ `status = 'paused'`, `final_outcome = NULL`, motivo `restart` en `loop_terminal_recovery` no encolado y fila `jobs` intacta; el resto, comportamiento actual.
3. Acción `POST /:projectId/loop-runs/:runId/resume` *(propuesto)* que reconstruye el request desde `run_request_json`, re-adjunta la liquidación aislada desde la fila durable de `rail_pr_deliveries` (`worktree_ids`, `run_ids`, `spec_snapshot`) mediante `reattachIsolatedSettlement(ctx, deliveryId, runId)` *(propuesto en `server/modules/delivery/runtime/rail-isolated-launch.ts`)*, y relanza el bridge con `resume` (añadiendo `--recover <nodePath>` si la UI lo pidió tras una escritura interrumpida). `rail-isolated-launch.ts:1242-1250` deja de aparcar `settlement_interrupted` cuando el run está `paused` por reinicio.
4. UI: en la tarjeta del job, botón "Reanudar" con la lista de `recoverableSteps` cuando Core exige `recover`.

Tests: `server/db.test.ts` (migración append-only), `loop-runs-store.test.ts` (reconciliación v2 frente a legado), `loop-definition-run.test.ts` (reinicio simulado en cada estado: entre nodos, durante un nodo de lectura, durante uno de escritura, en pausa), `rail-isolated-launch.test.ts` (re-adjunto), `project-router-loop-runs.test.ts`.

Hecho cuando: matar Desktop en cualquier momento de un run v2 y reiniciar deja el loop `paused`, y reanudar termina en `on_review` sin duplicar `ai_invocations`.

## D5 — Grafos de fábrica en Desktop

Precondiciones por grafo: Quick SDD tras C4; Freestyle tras C5; Implement y Batch tras C6.

Tareas:

1. `server/modules/loops/runtime/loop-factory.ts`: `factory:sdd-quick-openspec` pasa a un `LoopGraph` de nodos `core` equivalente a `engine/__fixtures__/quick-sdd.json` de Core (misma secuencia: `prompt(opsx:ff) → openspec-validate → prompt(opsx:apply, sentinel) → openspec-validate → openspec-archive → end`); `factory:freestyle` = `prompt(write, {{cmd:freestyle}}) → verify → decider ↺ prompt({{cmd:fix}})`; `factory:implement` = `implementation → end(success, requiresVerified)`; `factory:batch` = igual con todos los tickets del rail en el contexto (como hoy, `dominantTicketScope` 'all'), opcionalmente `map` por ticket con `concurrency` configurable. Los ids `factory:*`, los alias (`factory:revision`, `factory:openspec`, `loop-factory.ts:79-80, 112-115`) y `factoryLoopMode` no cambian. Cuando el Core activo no anuncia `engineV2`, `getFactoryLoop` devuelve las versiones actuales (`coreImplementationGraph`, `opsxLifecycleGraph`, `fixLoopGraph`).
2. `server/modules/loops/runtime/loop-templates.ts`: `ship-and-green`, `verify-pass`, `ci-watch`, `lint-and-fix`, `type-safe`, `coverage-climb`, `build-fix`, `deploy-check` re-expresados con piezas; `fixLoopGraph(['{{cmd:implement}}'], …)` pasa a `implementation` seguido de `verify → decider → prompt(fix)`. Las plantillas antiguas se conservan bajo `loop-templates-ported.ts` hasta D8.
3. `docs/running-pipelines.md`: tabla de built-ins actualizada.

Tests: `loop-factory.test.ts` (compilación de cada fábrica pasa `validateWorkflowDefinition`; paridad de Implement frente al legado sobre el fixture de Core C6 ejecutado a través del bridge con ejecutores fixture; fallback sin `engineV2`), `loop-templates.test.ts`.

Hecho cuando: los cuatro grafos de fábrica son definiciones y su comportamiento observable (secuencia de pasos, receipts, entrega) coincide con el actual.

## D6 — Agents como biblioteca de roles

Precondición: D1b; Core C5.

Tareas: `server/profiles-router.ts:456-536` y `client/src/features/agents/components/AgentStudio.tsx`: cada `custom-*.md` se proyecta a `roles.<id>` de `agent-runtime.json` (id derivado del nombre sin el prefijo `custom-`; prompt = cuerpo; frontmatter `access`, `artifacts`, `engine`, `openspecSkill`); los `sr-*` se muestran como los tres roles built-in (solo lectura); orquestador y `routing` de perfiles marcados obsoletos en la UI (retiro en D8); el selector de `roleId` del builder (D1) lee esta biblioteca por `/agent-runtime/config`. Tests: `profiles-router.test.ts`, tests del Agent Studio, `loops-router.test.ts`. Hecho cuando: un agente creado en Agent Studio con `access: 'read'` aparece como rol en el builder y su turno corre en Core con el argv de solo lectura (verificado con el snapshot de Core C2).

## D7 — Steering y observabilidad

Precondición: Core C8.

Tareas: `server/modules/agent-runtime/runtime/agent-runtime-controls-router.ts:24-80`: `POST /:projectId/agent-runtime/runs/:runId/steer { text }` ⇒ `runtime signal --stdin` con el runtime **retenido** del run (`resolveRetainedAgentRuntime`); el composer del job (`client/src/features/jobs/components/InteractiveJobComposer.tsx`) se reutiliza para runs v2 con semántica "entregado en la siguiente frontera de intento" y los recibos de `docs/agent-live-steering.md` (enviado ⇒ aceptado por `signal`; leído ⇒ `consumed_attempt_id` visible en `runtime status`); `server/mcp/tools/jobs.ts:43-55`: acción `runtime_steer`; vista de trazas por run desde los `span` (`docs/internals/mission-rail-cards.md` para la tarjeta). Tests: `agent-runtime-controls.test.ts`, MCP tools, cliente composer.

## D8 — Migración de loops antiguos y retiro del motor de Desktop

Precondición: etapa 7 del plan (dos releases con contador de lanzamientos legados a cero) y paridad demostrada.

Tareas:

1. Contador *(propuesto)*: `analytics` registra `rail.job_started` con comando `/specrails:` o `$implement` (QueueManager slash) y llamadas a `runMergeBack`; se expone en la página de analítica.
2. `server/modules/loops/runtime/loop-compat.ts` *(propuesto)*: `upgradeLegacyGraph(graph): LoopGraph` (`ai-step → core prompt` con el texto y `sentinel` según `requireVerificationPass`; `shell → core shell`; `decider → core decider`; `condition → core condition`; `operation: 'core-implementation'` o `{{cmd:implement|batch}}` → `core implementation`; `failureRecovery`/`stopOnFailure`/`requireRunVars` según la tabla del contrato 11). Migración de la tabla `loops` (base global `desktop-db.ts`): nueva migración que reescribe `graph` con la versión actualizada guardando el original en `graph_legacy` *(columna propuesta)*; los loops publicados se revalidan contra Core y los que no pasan quedan en `draft` con el error.
3. Retirar el recorrido nodo a nodo de `loop-run-manager.ts` (`runAiStep`, `runShell`, `runDecider`, `planInteractiveAiStep`, `_runInteractiveAiStep`, `awaitHumanDecision` para pasos, fail-fast, stall, no-progreso, historial), `loop-executors.ts` salvo el bridge, `rails-router.ts:1257-1260` (QueueManager slash), `rail-isolated-launch.ts:1897-1952` (`runMergeBack`), la rama `pipeline.mjs status` en `core-execution.ts:139` y `core-completion.ts:60`, `operation: 'core-implementation'`, `SPECRAILS_PROFILE_PATH` (`queue-manager.ts:2475-2577`, `loop-executors.ts:189-201`), perfiles y orquestador (`docs/internals/profiles.md` reescrito), `loop-templates-ported.ts`.
4. Recolección de basura de `.specrails/runtime-packages/<digest>` y `pipeline/<runId>` de runs asentados o descartados, con retención configurable, en `agent-runtime-package.ts`.
5. `server/core-package.ts:5`: `SUPPORTED_CORE_MAJORS = [6, 7]`; `check-core-compat` con contrato 6.0; `openspec/specs/loop-execution/spec.md:158-166`, `rail-loop-execution/spec.md:101-113` y `docs/internals/companion-rails-as-loops-contract.md` actualizados.

Tests: `loop-compat.test.ts` (paridad del compilador de compatibilidad sobre todos los grafos de `loop-templates.ts`, `loop-templates-ported.ts` y `loop-factory.ts`: la definición resultante pasa `validateWorkflowDefinition` y su secuencia de pasos con ejecutores fixture coincide con la del motor de Desktop grabada antes del retiro), `desktop-db.test.ts` (migración), `rails-router.test.ts`, `rail-isolated-launch.test.ts`, `profiles-router.test.ts`, `agent-runtime-package.test.ts`.

Hecho cuando: `loop-run-manager.ts` no ejecuta pasos; todos los loops guardados ejecutan por el motor v2; `npm run ci` en verde con la cobertura intacta.

## Orden dentro de Desktop y dependencias

`D0 → D1 (+D1b) → D2 → D3 → D4 → D5 (progresivo) → D6 → D7 → D8`. D2, D3 y D4 no requieren release de Core. Cada bloque es una PR (o varias pequeñas) con `npm run typecheck`, las suites afectadas, `npm run audit:architecture` y `npm run docs:source-map` en verde; al cerrar cada etapa del plan, `npm run ci` completo.
