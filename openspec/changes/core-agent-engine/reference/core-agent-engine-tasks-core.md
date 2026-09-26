# Motor de agentes en Core (v2): tareas de specrails-core (C0..C10)

Estado: **tareas preparadas; implementación pendiente**. Fecha: 26 de septiembre de 2026. Contrato de referencia: [`core-agent-engine-contracts.md`](core-agent-engine-contracts.md). Plan y etapas: [`core-agent-engine.md`](core-agent-engine.md). Briefing: [`core-agent-engine-implementer-brief.md`](core-agent-engine-implementer-brief.md).

Convenciones de este documento: rutas relativas a la raíz de `specrails-core`; los identificadores existentes se citan con línea sobre Core 6.0.0; los nuevos se marcan *(propuesto)* la primera vez. Cada bloque termina con **Aceptación** (comandos que deben pasar) y **Hecho cuando** (criterio observable). Ningún bloque se da por terminado con tests saltados o umbrales de cobertura rebajados (`vitest.config.ts`).

Comandos base de Core: `npm ci`, `npm run build`, `npm run typecheck`, `npx vitest run <ruta>`, `npm run ci` (typecheck + `test:scripts` + cobertura + `check:package`). Node de desarrollo ≥ 20.19.0 hoy; el spike C1 decide si sube a ≥ 22.13.0 (sección C1).

## C0 — Higiene de contrato y fingerprint congelado del legado

Objetivo: cerrar la deriva del contrato y fijar por test la identidad del grafo implement en código antes de tocar nada.

Tareas:

1. `integration-contract.json`: `schemaVersion` `"5.0"` → `"5.1"` (línea 2); en `agentRuntime`: `cliOperations` = `["api","validate","run","status","resume","prompts","capabilities","evidence","recovery"]` (líneas 227-233); `phases` = `["architect","developer","fixer","verify","reviewer","archive"]` (260-266); `workflowVersion: "6"`, `instructionsVersion: "9"` (280-281); añadir `engine: { "version": 1, "definitionSchema": null, "nodeKindsVersion": 0 }`, `nodeKinds: []`, `builtins: [{ "id": "specrails-implementation", "version": "6", "deprecated": false }]`. Actualizar el pin `expect(contract.schemaVersion).toBe('5.0')` en `src/installer/phases/install-config.test.ts:380` y la mención de `CLAUDE.md:27`.
2. `src/agent-runtime/cli.ts`: exportar `export const RUNTIME_CLI_OPERATIONS = ['api','validate','run','status','resume','prompts','capabilities','evidence','recovery','evaluate','help'] as const` *(propuesto)* y usarlo en el despacho de `runRuntimeCommand` (hoy cadena de `if`, líneas 88-143) para que el test de contrato lo lea sin regex.
3. Crear `src/agent-runtime/integration-contract.test.ts` *(propuesto)*: carga `integration-contract.json` y comprueba `agentRuntime.workflowVersion === CORE_WORKFLOW_VERSION`, `agentRuntime.instructionsVersion === String(ROLE_INSTRUCTIONS_VERSION)`, `agentRuntime.phases` igual a `CORE_NODE_ORDER`, `agentRuntime.cliOperations ⊆ RUNTIME_CLI_OPERATIONS` y que todo verbo de `RUNTIME_CLI_OPERATIONS` salvo `evaluate` y `help` está en el contrato; desde C3, que `agentRuntime.nodeKinds` coincide con `listPieces().map(p => p.kind)` y `agentRuntime.engine.nodeKindsVersion === NODE_KINDS_VERSION`.
4. `src/agent-runtime/workflow.ts`: exportar `export function definitionFingerprint<S>(workflow: WorkflowDefinition<S>): string` *(propuesto)* que devuelva lo que hoy calcula `validateWorkflow` (líneas 67-70) sin lanzar efectos.
5. `src/agent-runtime/core-host.ts`: extraer el literal de `runCoreWorkflow` (líneas 140-147) a `export function implementationWorkflowDefinition(nodes: Record<CoreNodeId, CoreNode>, options: { attempts: number; compactDeveloper: boolean }): WorkflowDefinition<CoreStateType>` *(propuesto)*; `runCoreWorkflow` la usa sin cambiar el resultado. Sustituir el literal `1` de `core-host.ts:27` por `RUNTIME_API_VERSION`; corregir el docstring de `core-host.ts:69-74` ("→ review (→ fixer → verify → review on corrections)er" está mal escrito).
6. Crear `src/agent-runtime/__fixtures__/implementation-workflow-fingerprint.json` *(propuesto)* con `{ "fingerprint": "<valor>", "attempts": 3, "compactDeveloper": false }` y una segunda entrada para `compactDeveloper: true`; test en `core-host.test.ts`: `definitionFingerprint(implementationWorkflowDefinition(fakeNodes, opts))` es igual al fixture para ambas entradas. Los `fakeNodes` solo necesitan `ends`, `effect`, `maxAttempts`, `retrySafe` iguales a los reales (`graph/nodes.ts:103, 237, 252, 265, 375, 425`).
7. Corregir la referencia inexistente a `schemas/profile.v1.json` en `src/installer/phases/scaffold.ts:32` y `docs/agent-runtime.md:73`.

Tests: `src/agent-runtime/integration-contract.test.ts` (nuevo), `core-host.test.ts` (fingerprint), `cli.test.ts` (sin cambio de comportamiento; `cli.test.ts:198` ya asserta `'6'`/`'9'`), `legacy-runtime.test.ts`, `src/installer/phases/install-config.test.ts`.

Aceptación: `npm run ci` en verde; `node bin/specrails-core.mjs runtime api` devuelve `workflowVersions: ['6']` sin cambios.

Hecho cuando: el fixture de fingerprint existe y su test pasa; el contrato no tiene ningún campo que contradiga el código; un cambio accidental en `ends` de cualquier nodo de implement rompe el test.

## C1 — Spikes con gate de decisión

Objetivo: fijar con evidencia las tres decisiones técnicas de las que depende C3. Cada spike produce un informe en `docs/engine-v2/spikes/` *(propuesto)* con: pregunta, criterio de salida escrito antes de empezar, procedimiento, medidas y decisión. Duración total: dos semanas. Ninguna línea de los spikes entra en `src/` salvo como test de referencia bajo `src/agent-runtime/engine/__spikes__/` *(propuesto, excluido de cobertura)*.

### Spike 1 — Binding SQLite y empaquetado (`01-sqlite.md`)

Decisión del maintainer: SQLite es el diseño elegido. El spike decide el **binding**.

Candidatos:

- **A. `node:sqlite`** (`DatabaseSync`, sin módulo nativo). Disponible sin flag desde Node 22.13. Desktop ejecuta Core con su Node empaquetado 22.22.3 (`.github/workflows/desktop-release.yml:26`, `server/core-node-runtime.ts:5-8`). Exige subir `engines.node` de Core a `>=22.13.0` (`package.json` hoy `>=20.19.0`) y retirar Node 20 de la matriz de CI (`.github/workflows/ci.yml:63, 72-97`). Requiere implementar `BaseCheckpointSaver` (unas 300 líneas: `getTuple`, `list`, `put`, `putWrites`, `deleteThread`) con el mismo esquema de tablas que `@langchain/langgraph-checkpoint-sqlite` (contrato, sección 6) y reutilizando `@langchain/langgraph-checkpoint` 1.1.5 para la serialización (`JsonPlusSerializer`).
- **B. `@langchain/langgraph-checkpoint-sqlite`** (usa `better-sqlite3`, módulo nativo). Comprobar la compatibilidad de versión con `@langchain/langgraph` 1.4.14 y `@langchain/langgraph-checkpoint` 1.1.5. Exige que `npm ci` en la máquina de ensamblado descargue el binario prebuilt para el ABI del Node empaquetado (22.x): el ensamblado de Desktop (`scripts/assemble-bundled-core.mjs`, `npm ci` contra el lockfile vendorizado) corre en el release con `node-version: 22.22.3` (`desktop-release.yml:75, 96`), así que el ABI coincide; hay que verificar que `verify-package.mjs`/`check:package` de Core y `check:package` de Desktop aceptan un `.node` binario, y que la instalación en rutas largas de Windows (comentario en `assemble-bundled-core.mjs:123`) sigue funcionando.

Criterio de salida (para el candidato elegido): en macOS arm64, Windows x64 y Linux x64, un run de 200 nodos `noop` con `kill -9` en cada frontera reanuda sin pérdida; `PRAGMA journal_mode` devuelve `wal`; permisos 0600; `check:package` de Core y ensamblado de Desktop en verde; tiempo de `put` medio < 5 ms. Recomendación previa: **A** si `engines` puede subir a 22.13 (Core es solo para Desktop y Desktop empaqueta 22.22.3); **B** si hay que conservar Node 20.

Entregables: informe, prototipo de saver en `__spikes__/sqlite-saver.ts`, decisión sobre `engines.node` y sobre la matriz de CI, y la línea exacta que irá a `package.json`.

### Spike 2 — Subgrafos, `Send`, interrupciones y checkpoints (`02-subgraphs.md`)

Preguntas: ¿un `interrupt()` dentro de un subgrafo compilado como nodo se reanuda con `Command({ resume })` desde el padre? ¿`getStateHistory` recorre checkpoints de subgrafos (`checkpoint_ns`)? ¿`Send` hacia un subgrafo con checkpointer conserva estado por rama y permite reanudar una rama interrumpida? ¿`updateState` sobre un checkpoint interno de subgrafo funciona para `fork`? ¿`defer: true` está disponible en 1.4.14 para el `join`? ¿`retryPolicy` reintenta un nodo cuya excepción es una `AgentExecutionError` con `code` concreto (usar `retryOn` como función)? ¿`subgraphs: true` en `stream` emite los eventos internos con namespace?

Criterio de salida: cada pregunta respondida con un test que pasa en `__spikes__/` y una nota de la API exacta usada; lista de limitaciones que el compilador debe respetar (por ejemplo, profundidad de anidamiento, nombres de namespace, comportamiento de `recursionLimit` en subgrafos).

### Spike 3 — Streaming como fuente de eventos (`03-streaming.md`)

Pregunta: ¿`stream({ streamMode: ['updates', 'custom'], subgraphs: true })` con `config.writer` para eventos de herramientas y `streamEvents` para spans reproduce los eventos JSONL actuales (contrato, sección 8) con la misma garantía de "emitir después de confirmar la transacción"? Medir latencia añadida y volumen en un run de implement con ejecutores fixture (`evaluation.ts:31-69`).

Criterio de salida: mapa evento LangGraph → tipo JSONL, y decisión: adaptador puro sobre streaming, o híbrido con `writer` para eventos de agente y callbacks del ledger para `workflow-event`.

Aceptación C1: tres informes con decisión, tests de spike en verde en las tres plataformas (usar la matriz de CI de Core con un job temporal `engine-spikes`).

Hecho cuando: C3 puede empezar sin ninguna incógnita de API abierta.

## C2 — Roles abiertos: `access`, `artifacts`, `instructions`, `nativeCommand` y `roles`

Objetivo: que un rol sea un dato (id, prompt, permisos, engine) y que el ejecutor acepte un turno sin instrucciones de rol.

Tareas:

1. `src/agent-runtime/executor-types.ts`: `export type AgentRole = string` con `export const BUILTIN_ROLES = ['architect','developer','reviewer'] as const` *(propuesto)*; `AgentEventRole = string`; en `AgentRequest` (líneas 85-111) añadir `access: 'read' | 'write'`, `artifacts: 'none' | 'tasks-checkboxes' | 'all'`, `instructions: 'role' | 'none'` y `nativeCommand?: { id: string; args?: string }` *(propuestos)*; `validateAgentRequest` (135-136): sustituir la comprobación de rol por `^[a-z][a-z0-9-]{0,63}$`, validar `access`/`artifacts`/`instructions` y que `nativeCommand.id` cumple `^[a-z][a-z0-9:_-]{0,63}$` y `args` no contiene `\0`.
2. `src/agent-runtime/cli-executor.ts`: `const readOnly = request.access === 'read'` (línea 30 y usos en 236, 243). Con `request.instructions === 'none'` no se anexa ninguna instrucción de rol ni `--append-system-prompt`. Con `nativeCommand`: Claude y Gemini construyen el prompt `"/<id> <args>"`; Codex `"$<id> <args>"`; Kimi usa el runner de skills (`templates/kimi/specrails/run-skill.mjs`, argumentos del bloque `kimi.cli.workflowArgs` de `integration-contract.json`); un proveedor sin soporte lanza `AgentExecutionError('…', 'native_command_unsupported')`. Snapshot byte a byte del argv de los tres roles built-in intacto (`compact-runtime.test.ts:464-473`, `__fixtures__/claude-architect-invocation.snapshot.json`).
3. `src/agent-runtime/kimi-acp.ts:15-16`, `src/agent-runtime/workspace-tools.ts:55-56`, `src/agent-runtime/openspec.ts:64`: derivar de `access`; `openspec.ts:212-223`: derivar el alcance de escritura de artefactos de `artifacts` (`'all'` = proposal/design/specs/tasks; `'tasks-checkboxes'` = solo casillas de `tasks.md`; `'none'` = nada).
4. `src/agent-runtime/config.ts` (líneas 6, 85, 108, 196) y `schemas/agent-runtime.schema.json` (líneas 38-40): clave aditiva `roles: Record<string, RuntimeAgentConfig & { access; artifacts; prompt?; openspecSkill?: 'openspec-ff-change' | 'openspec-apply-change' | 'openspec-verify-change' }>` *(propuesto)*; `agents` sigue obligatoria con el trío; `rolePrompts` acepta cualquier id declarado en `roles`; `normalizeRuntimeConfig` rellena los descriptores implícitos de los tres built-ins (architect: `read`/`all`/`openspec-ff-change`; developer: `write`/`tasks-checkboxes`/`openspec-apply-change`; reviewer: `read`/`none`/`openspec-verify-change`). Exportar `export function resolveRoleDescriptor(config: RuntimeConfig, roleId: string): RoleDescriptor` *(propuesto)*.
5. `src/agent-runtime/graph/roles.ts:83`: resolver la asignación con `resolveRoleDescriptor`; `src/agent-runtime/prompts.ts:398-410`: `roleInstructions(descriptor, …)` con las ramas actuales para los tres built-ins y una plantilla genérica para roles declarados (`descriptor.prompt`); `src/agent-runtime/openspec.ts:12` (`ROLE_SKILLS`): leer de `descriptor.openspecSkill`; `src/agent-runtime/openai-executor.ts:87`: pipeline compacto por `descriptor.compact ?? (built-in ? pipeline actual : 'free')`; `src/agent-runtime/role-routing.ts:18-21`, `src/agent-runtime/core-host.ts:91-95`, `src/agent-runtime/efficiency.ts:8`, `src/agent-runtime/efficiency-summary.ts:105, 126`: iterar sobre `Object.keys(config.roles ?? {})` unido a `BUILTIN_ROLES` en vez de la unión cerrada.
6. `src/agent-runtime/compact/prompt-inputs.ts:59-80`: tolerar prompts sin `## Developer summary` (devolver secciones vacías, no lanzar).
7. `cli.ts` `api`: `capabilities.openRoles: 1`.

Tests:

- `cli-executor.test.ts`: snapshot intacto para architect/developer/reviewer; `access: 'read'` con `role: 'security-reviewer'` produce en Claude `--tools Read,Grep,Glob --permission-mode plan` (línea 44), en Codex `sandbox_mode="read-only"`, en Gemini `--approval-mode plan`; `instructions: 'none'` no añade texto al prompt; `nativeCommand` renderizado por proveedor con un caso por proveedor; Kimi con `nativeCommand` usa el runner.
- `openspec.test.ts`: matriz `artifacts × operación` (`write_artifact` de `proposal.md` permitido solo con `all`; `write_progress` solo con `tasks-checkboxes` o `all`).
- `config.test.ts`: `roles` válido e inválido (id con mayúsculas, `access` desconocido, rol que colisiona con un built-in con permisos distintos ⇒ error).
- `compact-runtime.test.ts`, `openai-executor.test.ts`, `kimi-acp.test.ts`, `role-routing.test.ts`, `efficiency.test.ts`: casos con un rol declarado.

Aceptación: `npm run ci`; `node dist/agent-runtime/cli.js runtime validate --stdin <<< '{...roles.security-reviewer...}'` devuelve `runtime-config-valid`.

Hecho cuando: un `runtime run` legado con configuración sin `roles` produce exactamente los mismos argv que en 6.0.0, y un rol declarado con `access: 'read'` ejecuta un turno de solo lectura en los cuatro CLIs (fixtures).

## C3 — Núcleo del motor v2

Objetivo: definición JSON → grafo LangGraph durable, con ledger SQLite, eventos, presupuesto, lease, `fork` y CLI, sin ninguna pieza de producto todavía (solo piezas de test).

Estructura *(propuesta)*: `src/agent-runtime/engine/` con `definition/`, `state/`, `pieces/`, `checkpoint/`, `runs/`, `events/`, `budget/`, `index.ts`. El módulo depende de `pipeline/`, del resto de `agent-runtime/` y de LangGraph; nada de `installer/` (`src/architecture.test.ts:34-36`).

Tareas:

1. **Schema y hash.** `engine/definition/schema.ts`: `validateDefinitionShape(input: unknown): DefinitionDocument` con Ajv (ya dependencia) sobre `schemas/workflow-definition.schema.json` (contrato 2.1); errores como `DefinitionError { code: 'definition_invalid'; path; message }`. `engine/definition/hash.ts`: `canonicalJson(value: JsonValue): string` (claves ordenadas, sin espacios, RFC 8785) y `definitionHash(def: Omit<DefinitionDocument,'version'>): string`.
2. **Validación semántica.** `engine/definition/validate.ts`: `validateDefinition(def, registry: PieceRegistry, config: RuntimeConfig): DefinitionError[]` con las diez reglas del contrato 2.2 (`code` por regla: `unknown_node`, `ends_mismatch`, `unreachable_end`, `reserved_id`, `journal_mismatch`, `unverified_success`, `role_unknown`, `map_join_mismatch`, `component_depth`, `component_cycle`) y la validación de `params` de cada pieza con su `paramsSchema` (`piece_params_invalid`).
3. **Estado.** `engine/state/definition-state.ts`: `DefinitionState = Annotation.Root({...})` con los canales y reducers del contrato 3; `historyReducer(maxChars)`; `usageReducer` con semántica nulo-permanece-nulo copiada de `workflow.ts:88-95`.
4. **Piezas (infraestructura).** `engine/pieces/piece.ts`: tipos `PieceDescriptor { kind; executor: 'core'; effect: 'read'|'write'|'derived'; paramsSchema: JSONSchema; outcomes(params): string[]; build(params, deps: EngineDeps): PieceRuntime }`, `PieceRuntime { run(state, ctx: PieceContext): Promise<PieceResult> }`, `PieceResult { outcome; output?; update?; usage?; history?; error?: { code; message } }`, `PieceContext { runId; nodePath; visit; attempt; branch?; signal; vars; reportUsage; interrupt; emitAgentEvent; emitVerificationOutput; semaphore; deps }`. `engine/pieces/registry.ts`: `NODE_KINDS_VERSION = 1`, `listPieces(): PieceDescriptor[]`, `getPiece(kind)`. Piezas de test en `engine/pieces/testing.ts` registradas solo con `registerTestPieces()`: `noop`, `sleep { ms }`, `fail-once { code }`, `write-marker { path }`, `emit-usage { costUsd, tokens }`, `ask { text }` (interrumpe con `question`).
5. **Compilador.** `engine/definition/compile.ts`: `compileDefinition(def, deps): CompiledDefinition { graph: CompiledStateGraph; nodePaths: string[]; outcomesOf(nodePath); mermaid(): string }`. Reglas: nodo → `builder.addNode(nodePath, wrapNode(piece), { retryPolicy: toRetryPolicy(node.retry, piece) })`; `ends` con una sola etiqueta → `addEdge`; varias → `addConditionalEdges(nodePath, state => state.$lastOutcome[nodePath], { label: target ?? END })`; `gate` → `interruptBefore: [target]`; `component`/`implementation` → subgrafo compilado como nodo; `map` → arista condicional que devuelve `Send(bodyNodePath, { ...state, $item })` por elemento y `join` con `defer: true`; `compile({ checkpointer, store, interruptBefore })`; `recursionLimit = def.maxTransitions + 1`. `wrapNode` implementa el envoltorio del contrato 5.2 (presupuesto, cancelación, `{{run.*}}`, ledger, `$candidate`, `$verified`, `$transitions`, `$consecutiveFailures`).
6. **Checkpointer y ledger.** `engine/checkpoint/database.ts`: `openRunDatabase(path: string): RunDatabase` (binding según spike 1; pragmas del contrato 6; `transaction(fn)`). `engine/checkpoint/saver.ts`: `createCheckpointSaver(db): BaseCheckpointSaver` (esquema del contrato 6). `engine/checkpoint/ledger.ts`: `Ledger` con `createRun`, `upsertStep`, `beginAttempt`, `finishAttempt`, `recordInvocation`, `recordReceipt`, `addUsage`, `recordInterrupt`, `resolveInterrupt`, `appendEvent`, `setRunStatus`, `setCompletion`; todas reciben la transacción abierta por el envoltorio de nodo para que checkpoint y ledger se confirmen juntos (el saver escribe con la misma conexión). `engine/checkpoint/lease.ts`: `acquireLease(db, runId, owner): Promise<LeaseHandle>` con heartbeat 15 s, expiración 60 s, `release()`; `LeaseHeldError`.
7. **Runs.** `engine/runs/run.ts`: `createRun(opts: RunOptions)`, `resumeRun(opts & { approve?; answer?; recover?; invalidate? })`, `forkRun(opts & { from: string; state?: Partial<DefinitionState>; newRunId })`, `readStatus(directory, runId)`. `RunOptions { directory; runId; definition; context: PipelineContext; config: RuntimeConfig; registry: ExecutorRegistry; signal; emit(event) }`. Recuperación de escritura interrumpida e invalidación según contrato 5.6-5.7 (portar la lógica de `workflow.ts:232-268` sobre el ledger nuevo).
8. **Presupuesto.** `engine/budget/budget.ts`: `checkBudget(usage, budget, elapsedMs): { ok: true } | { ok: false; reason }` con la semántica de `budgetError` (`workflow.ts:105-110`).
9. **Eventos.** `engine/events/stream-adapter.ts`: según spike 3, convierte los chunks de `graph.stream(..., { streamMode: ['updates','custom'], subgraphs: true })` y `streamEvents` en los eventos del contrato 8 con `sequence` monótono por run; emite `runtime-graph` al inicio. `engine/events/jsonl.ts`: `emitLine(value)` con acotado a 1.000.000 caracteres.
10. **CLI.** `cli.ts`: `workflows`, `workflows validate --stdin`, `run --definition`, `fork`, ampliación de `status`, `resume` para el motor v2 (elige motor por `request.workflow.engine`), `api` con `engineVersion`, `nodeKinds`, `nodeKindsVersion`, `capabilities.engineV2/workflowDefinitions/fanOut/fork`. El request congelado gana `workflow` (contrato 9). Errores fatales con `error: { code, message }`.
11. **Público.** `src/agent-runtime/index.ts`: exportar `compileDefinition`, `validateDefinition`, `definitionHash`, `listPieces`, `NODE_KINDS_VERSION`, `createRun`, `resumeRun`, `forkRun`, `readStatus`.

Tests (todos con piezas de test, sin proveedores):

- `engine/definition/hash.test.ts`: canonicalización (orden de claves, números, unicode); estabilidad; cambio de un parámetro cambia el hash; `version` no participa.
- `engine/definition/validate.test.ts`: un caso por regla del contrato 2.2 y por `code`.
- `engine/definition/compile.test.ts`: lineal, condicional, ciclo acotado por `maxTransitions` (`GraphRecursionError` → `blocked` con `recursion_limit`), `gate`, `component` de dos niveles, `map`+`join` con concurrencia 1 y 3; `mermaid()` contiene todas las aristas de la definición (prueba de equivalencia).
- `engine/checkpoint/saver.test.ts`: `getTuple`/`list`/`put`/`putWrites`/`deleteThread` conformes (reutilizar los tests de conformidad de `@langchain/langgraph-checkpoint` si están publicados; si no, el subconjunto equivalente).
- `engine/checkpoint/ledger.test.ts`: cada método dentro de una transacción; un fallo tras `put` del checkpoint y antes de `finishAttempt` deja la base sin ninguno de los dos (atomicidad).
- `engine/runs/robustness.test.ts` (**matriz de robustez**, plan sección 10): un arnés que lanza `cli.js run` en un proceso hijo con `SPECRAILS_ENGINE_CRASH_AT=<nodePath>:<before|after|during>` *(variable de test propuesta, activa solo si `NODE_ENV=test`)*, lo mata con SIGKILL en ese punto y comprueba `resume`: sin repetición de nodos terminados; `recover_required` en `during` de escritura; `lease_held` con dos procesos; lease expirado recuperado; presupuesto agotado antes de un nodo; `fail_fast`; `fork` conserva el original; `cancelled` por SIGTERM con checkpoint reanudable.
- `engine/events/stream-adapter.test.ts`: `sequence` monótono a través de `resume`; `runtime-graph` primero; acotado de líneas.
- `cli.test.ts`: `workflows validate --stdin` con errores por `nodeId`; `run --definition` + `--workflow` ⇒ `invalid_arguments`; `resume` con `--definition` ⇒ `invalid_arguments`; `fork` con lease vigente ⇒ `lease_held`; hash incorrecto ⇒ `definition_hash_mismatch`.
- `integration-contract.test.ts`: `nodeKinds` del contrato == `listPieces()` (excluyendo piezas de test).

Aceptación: `npm run ci`; la matriz de robustez en verde en Linux, macOS y Windows (job de CI `engine-robustness`); `check:package` incluye el binding elegido.

Hecho cuando: una definición de 30 nodos de test se ejecuta, se interrumpe, se reanuda y se bifurca desde el CLI con solo `run.sqlite` como estado, y Desktop (D0) puede validar definiciones contra este Core.

## C4 — Piezas básicas y Quick SDD de referencia

Objetivo: las piezas que no necesitan roles nuevos, suficientes para Quick SDD.

Tareas:

1. `engine/pieces/prompt/` *(propuesto)*: `prompt.ts` (descriptor y `run`: construye `AgentRequest { role: 'prompt', instructions: 'none', access, nativeCommand?, prompt: text, idleTimeoutMs, timeoutMs, resumeSessionId }`, ejecuta con `deps.registry.execute(engine.provider, …)`, aplica `sentinel.ts` y `capture-vars.ts`, anexa `$history` y steering pendiente cuando `appendSteering`), `sentinel.ts` (regex de `VERIFICATION: PASS|FAIL` y `LOOP_BLOCKED:` portadas de Desktop `loop-run-manager.ts:310` y `execution/runtime/verification-sentinel`), `capture-vars.ts` (regex con límite de 200 caracteres, sin flags `g`/`y`, timeout de evaluación de 50 ms).
2. `engine/pieces/shell/shell.ts`: `argv` directo o `commandLine` por `src/installer/util/exec.ts`; `evidence: true` delega en `verifyPipeline` con un `VerificationCommand` único; captura de salida con `outputCapBytes`; `captureVars`.
3. `engine/pieces/openspec/validate.ts` y `archive.ts`: sobre `resolveOpenSpecCli`/`runOpenSpec` (`openspec.ts:78-98`) y `archive` (`graph/artifacts.ts`).
4. `engine/pieces/condition/expr.ts` (parser recursivo del sub-lenguaje del contrato 4.4, sin `eval`) y `condition.ts`.
5. `engine/pieces/interrupts/`: `approval.ts`, `question.ts`, `gate.ts` (el compilador ya trata `gate` como `interruptBefore`; la pieza solo registra el motivo).
6. `engine/pieces/end/end.ts`: `completion` según contrato 4.12.
7. `engine/__fixtures__/quick-sdd.json` *(propuesto)*: equivalente a `opsxLifecycleGraph()` de Desktop (`server/modules/loops/runtime/loop-templates.ts:228-255`): `prompt(nativeCommand opsx:ff, captureVars changeId) → openspec-validate → prompt(nativeCommand opsx:apply, sentinel verification) → openspec-validate → openspec-archive → end(success)` con `retry.maxAttempts: 2` en el primer `prompt` y `ends.fail` de las validaciones hacia él.
8. `integration-contract.json`: `agentRuntime.nodeKinds` y `engine.nodeKindsVersion` actualizados.

Tests:

- `engine/pieces/prompt/prompt.test.ts`: ejecutor fixture (`ExecutorRegistryOptions.executors`) que devuelve texto con y sin sentinel; `captureVars`; `sessionContinuity` reutiliza `sessionId`; `blocked` produce `pendingQuestion` y la respuesta llega al siguiente intento; `failed` tras agotar `retry`; `nativeCommand` por proveedor con `buildCliInvocation` (snapshots nuevos por proveedor, sin tocar los existentes).
- `engine/pieces/shell/shell.test.ts`: `argv` y `commandLine` en Windows y POSIX (mock de `exec`), `evidence: true` deja receipt, `outputCapBytes`, timeout ⇒ `failed`.
- `engine/pieces/openspec/*.test.ts`: `validate` sobre un cambio de fixture válido e inválido; `archive` idempotente.
- `engine/pieces/condition/expr.test.ts`: gramática completa, errores ⇒ `false` con motivo.
- `engine/quick-sdd.test.ts`: la definición de referencia con ejecutores fixture: éxito; validación fallida reparada por el reintento del `prompt`; `LOOP_BLOCKED` → `question` → `resume --answer`; kill -9 en cada nodo (reutiliza el arnés de C3).

Aceptación: `npm run ci`; `runtime workflows` lista las nueve piezas; `runtime run --definition engine/__fixtures__/quick-sdd.json` con ejecutores fixture termina 0 y `completion.ok: true`.

Hecho cuando: Desktop (D5) puede publicar Quick SDD como definición y su secuencia de pasos coincide con la actual.

## C5 — Piezas de agentes y semántica de loops

Tareas:

1. `engine/pieces/role-turn/role-turn.ts`: sobre `createRoleInvoker` (`graph/roles.ts:58`) con el descriptor de C2; `structuredOutput` ⇒ `invalid` tras la reparación.
2. `engine/pieces/decider/decider.ts`: portar de Desktop `server/modules/loops/runtime/loop-decider.ts` (prompt de sistema, parseo de `continue|stop`, tolerancia) a un turno estructurado; `noProgress` con `fingerprintCandidate` (`pipeline/pipeline-state.ts`) leído de `$candidate`.
3. `engine/pieces/verify/verify.ts`: `verifyPipeline` + `validateVerificationRequest`; `$verified`.
4. Envoltorio de nodo: `policies.failFast` (contador `$consecutiveFailures` sobre piezas `prompt`/`role-turn`/`decider`) y `retry` por defecto de piezas con IA `{ maxAttempts: 2, backoffMs: 5000, retryOn: ['idle_timeout','provider_request_error'] }`.
5. `engine/__fixtures__/freestyle.json` (`prompt(write) → verify → decider ↺ prompt(fix)` como `fixLoopGraph` de Desktop) y `verify-fix.json`.

Tests: `role-turn.test.ts`, `decider.test.ts` (verdicts, no-progreso con dos visitas sin cambio de candidato ⇒ `stop` + `stalled`), `verify.test.ts` (`pass`/`fail`/`failed`, `$verified` puesto a `null` tras una escritura posterior), `policies.test.ts` (dos `failed` seguidos ⇒ `fail_fast`; un éxito intermedio reinicia el contador), `freestyle.test.ts` con el arnés de robustez.

Aceptación: `npm run ci`. Hecho cuando: las reglas de la tabla del contrato 11 tienen cada una un test que las demuestra en el motor v2.

## C6 — Implement como subgrafo, `map`/`join`/`component`

Tareas:

1. `engine/pieces/implementation/implementation.ts`: construye el subgrafo con `CoreState` (`graph/state.ts`) y `coreNodes(deps)` (`graph/nodes.ts:441`) con las aristas actuales; `validateCompleted` de `core-host.ts:115-139` como validación de reanudación; conexión con el padre (contrato 4.11); `journal: 'implementation'` con `initializePipeline`/`transitionPipeline` como hoy.
2. `engine/pieces/map/map.ts`, `join.ts` y `engine/pieces/component/component.ts` según contrato 4.9-4.10; semáforo `engine/runs/semaphore.ts` compartido por run (`policies.concurrency`).
3. `engine/__fixtures__/implementation.json`: definición de referencia equivalente al built-in (solo para tests y evaluación).
4. `runtime evaluate --definition` (C7 lo completa) y `cli.ts` `api`: `capabilities.fanOut: 1`.

Tests: `implementation.test.ts` (paridad con `runCoreWorkflow` sobre el corpus de `evaluation.ts:31-69`: mismos receipts válidos, misma aceptación, mismo número de invocaciones ± reparaciones; `role-turn` extra entre `reviewer` y `archive` en un `component` envolvente; orden inválido rechazado por el compilador), `map.test.ts` (dos tickets, concurrencia 1 y 2, rama interrumpida y reanudada, `join all-ok`/`any-ok`/`collect`), `component.test.ts` (anidamiento a 3 niveles, ciclo detectado, `fork` a nodo interno).

Aceptación: `npm run ci`; matriz de robustez ampliada a ramas y subgrafos. Hecho cuando: Desktop (D5) puede publicar Implement y Batch como definiciones con paridad de receipts frente al legado.

## C7 — Store, evaluación y trazas

Tareas: `engine/store/sqlite-store.ts` (`BaseStore` sobre SQLite por proyecto en `<backlogRoot>/.specrails/engine-store.sqlite` *(propuesto)*, namespaces `roles/<id>/sessions`, `verification/known-commands`, `review/notes`; las piezas declaran `storeAccess: 'none' | 'read' | 'write'`); `runtime evaluate --definition` con las definiciones de referencia añadidas al corpus (`evaluation-corpus.ts:13-19`); exportador OpenTelemetry opcional desde `streamEvents` activado por `SPECRAILS_OTEL_ENDPOINT` *(propuesto)*. Tests: `sqlite-store.test.ts`, `evaluation.test.ts` ampliado, `otel.test.ts` con colector fake. Aceptación: `runtime evaluate --definition engine/__fixtures__/implementation.json` offline devuelve 0.

## C8 — Steering por buzón: `runtime signal`

Tareas: `engine/steering/inbox.ts` (tabla `steering_inbox` del contrato 6; `append`, `pending(runId)`, `markConsumed(ids, attemptId)` en la transacción del intento); `cli.ts` verbo `signal --context --stdin` (≤ 20000 caracteres, sin lease: escritura directa); `prompt`/`role-turn` anexan `## Operator steering` con los pendientes cuando `appendSteering`; `compact/prompt-inputs.ts:59-80` tolera la sección. Tests: consumo idempotente tras `--invalidate` y `fork`; `signal` sobre run inexistente ⇒ `run_not_found`; sección tolerada. Contrato: `cliOperations` += `signal`; `capabilities.steeringInbox: 1`.

## C9 — Documentación del motor

`docs/engine-v2/README.md` (arquitectura y modelo de fallos), `definition-format.md` (copia normativa del contrato 2 con ejemplos completos: Quick SDD, Freestyle, Implement, un `map` por tickets), `pieces.md` (catálogo con `paramsSchema` renderizado), `adding-a-piece.md` (descriptor, `build`, tests obligatorios, entrada en el contrato y en `nodeKindsVersion`), `recovery.md` (lease, `recover`, `invalidate`, `fork`). `docs/agent-runtime.md` describe el legado como tal y enlaza a `docs/engine-v2/`. Aceptación: cada ejemplo de `definition-format.md` pasa `runtime workflows validate --stdin` en un test (`docs-examples.test.ts`).

## C10 — Core 7: retiro del legado

Precondición: Desktop D8 publicado y dos releases de telemetría sin lanzamientos legados (plan, etapa 7).

Tareas: eliminar `src/agent-runtime/workflow.ts`, `core-host.ts` como grafo (conservar `coreRuntimeIdentity`, `RUNTIME_API_VERSION`), `durable-store.ts`, `graph-checkpointer.ts`, `legacy-runtime.test.ts` (los runs antiguos reanudan con su paquete retenido, no con este código); `--workflow` y `defaultImplementationEngine`; `integration-contract.json` `schemaVersion: "6.0"`, `builtins: []`; `package.json` mayor 7. Tests: `cli.test.ts` (`resume` de un request con `engine: 1` ⇒ error `engine_unsupported` con mensaje que indica usar el runtime retenido); `install-config.test.ts` pin `"6.0"`. Aceptación: `npm run ci`; Desktop D8 `check-core-compat` con Core 7.

## Orden dentro de Core y dependencias

`C0 → C1 → C2 → C3 → C4 → C5 → C6 → C7`, con `C8` y `C9` en paralelo desde C4, y `C10` al final. Cada bloque es una PR (o varias pequeñas) con `npm run ci` en verde y el contrato actualizado en el mismo cambio.
