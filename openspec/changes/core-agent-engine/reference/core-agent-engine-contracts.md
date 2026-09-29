# Motor de agentes en Core (v2): contrato técnico compartido

Estado: **contrato preparado; implementación pendiente**. Fecha: 26 de septiembre de 2026. Acompaña a [`core-agent-engine.md`](core-agent-engine.md) (plan) y a las listas de tareas de [Core](core-agent-engine-tasks-core.md) y [Desktop](core-agent-engine-tasks-desktop.md). El [briefing para el implementador](core-agent-engine-implementer-brief.md) explica cómo usar estos documentos.

Reglas de lectura:

- Este documento es la **fuente única** de nombres, formatos, tablas, verbos, eventos y códigos. Si el plan y este documento discrepan, gana este documento; si este documento y el código discrepan, se corrige el código o se actualiza aquí en el mismo commit.
- Los identificadores existentes en el código se citan con su ruta (repo-relativa) y, cuando ayuda, con línea sobre la base Core 6.0.0 / Desktop 2.57.0. Los identificadores nuevos se marcan como *(propuesto)* la primera vez.
- "Core" es `specrails-core`; "Desktop" es `specrails-desktop`. Todo lo que Desktop escribe para Core va con `flag: 'wx'` y modo 0600, igual que hoy `desktop-context.json` (`server/core-execution.ts:95-100`).

## 1. Vocabulario

| Término | Significado |
|---|---|
| **Definición** | Documento JSON que describe un grafo ejecutable (sección 2). La crea Desktop (o el usuario a través de Desktop) y la ejecuta Core. |
| **Pieza** (`kind`) | Tipo de nodo que Core sabe ejecutar. Librería cerrada (sección 4). |
| **Componente** | Definición anidada reutilizable, compilada como subgrafo (`kind: 'component'`). |
| **Run** | Una ejecución de una definición: un `runId`, un directorio `pipeline/<runId>/`, un `run.sqlite`. |
| **Visita / intento** | Una visita es una ejecución de un nodo dentro de un recorrido (los ciclos producen varias); un intento es una ejecución física de una visita (los reintentos producen varios). |
| **Ledger** | Tablas de Core en `run.sqlite` con la verdad de intentos, invocaciones, receipts, uso y presupuesto. El checkpoint de LangGraph guarda el estado del grafo; el ledger, la evidencia. Se escriben en la misma transacción. |
| **Host** | Desktop: quien lanza, observa, pausa, reanuda, cancela y entrega. |
| **Legado** | El runner actual de Core (`src/agent-runtime/workflow.ts`, `core-host.ts`, `durable-store.ts`, `graph-checkpointer.ts`) y el grafo `specrails-implementation` v6 en código. Se conserva hasta Core 7 para reanudar runs antiguos y para Desktops antiguos. |

## 2. Formato de definición

### 2.1 Schema

Fichero `schemas/workflow-definition.schema.json` *(propuesto)* en Core, exportado en `package.json` `exports` como `./schemas/workflow-definition.schema.json`, y vendorizado byte a byte en `server/schemas/workflow-definition.schema.json` *(propuesto)* de Desktop con un test de paridad igual al de `agent-runtime.schema.json` (`server/modules/agent-runtime/runtime/agent-runtime-settings.test.ts:192-194`).

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://specrails.dev/schemas/workflow-definition/1",
  "type": "object", "additionalProperties": false,
  "required": ["schemaVersion", "id", "version", "title", "journal", "change", "entry", "maxTransitions", "roles", "nodes"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "id":      { "type": "string", "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" },
    "version": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "title":   { "type": "string", "minLength": 1, "maxLength": 120 },
    "journal": { "enum": ["ledger-only", "implementation"] },
    "change":  { "enum": ["new", "existing", "none"] },
    "entry":   { "$ref": "#/$defs/nodeId" },
    "maxTransitions": { "type": "integer", "minimum": 1, "maximum": 10000 },
    "budget": { "type": "object", "additionalProperties": false, "properties": {
      "maxCostUsd": { "type": "number", "exclusiveMinimum": 0 },
      "maxTokens": { "type": "integer", "minimum": 1 },
      "maxDurationMs": { "type": "integer", "minimum": 1000 } } },
    "policies": { "type": "object", "additionalProperties": false, "properties": {
      "failFast": { "type": "integer", "minimum": 1, "maximum": 10, "default": 2 },
      "noProgress": { "type": "integer", "minimum": 1, "maximum": 10, "default": 2 },
      "historyMaxChars": { "type": "integer", "minimum": 200, "maximum": 20000, "default": 1500 },
      "concurrency": { "type": "integer", "minimum": 1, "maximum": 8, "default": 1 } } },
    "roles": { "type": "array", "items": { "$ref": "#/$defs/roleId" }, "uniqueItems": true },
    "nodes": { "type": "object", "minProperties": 1,
      "propertyNames": { "$ref": "#/$defs/nodeId" },
      "additionalProperties": { "$ref": "#/$defs/node" } },
    "components": { "type": "object",
      "propertyNames": { "pattern": "^[a-z0-9][a-z0-9-]{0,63}$" },
      "additionalProperties": { "$ref": "#/$defs/componentBody" } },
    "delivery": { "type": "object", "additionalProperties": false, "properties": {
      "requiresVerified": { "type": "boolean" } } }
  },
  "$defs": {
    "nodeId": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$",
      "not": { "enum": ["START", "END", "__start__", "__end__", "next"] } },
    "roleId": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,63}$" },
    "engine": { "type": "object", "additionalProperties": false, "required": ["provider"], "properties": {
      "provider": { "type": "string" }, "model": { "type": "string" }, "effort": { "type": "string" },
      "thinking": { "enum": ["on", "off"] } } },
    "retry": { "type": "object", "additionalProperties": false, "properties": {
      "maxAttempts": { "type": "integer", "minimum": 1, "maximum": 10 },
      "backoffMs": { "type": "integer", "minimum": 0, "maximum": 600000 },
      "retryOn": { "type": "array", "items": { "enum": ["idle_timeout", "timeout", "provider_request_error", "session_not_found", "invalid_structured_output"] } } } },
    "ends": { "type": "object", "propertyNames": { "pattern": "^[a-z][a-z0-9-]{0,31}$" },
      "additionalProperties": { "oneOf": [ { "$ref": "#/$defs/nodeId" }, { "type": "null" } ] } },
    "node": { "type": "object", "additionalProperties": false, "required": ["kind", "params", "ends"], "properties": {
      "kind": { "enum": ["prompt", "role-turn", "decider", "condition", "verify", "shell",
                          "openspec-validate", "openspec-archive", "approval", "question", "gate",
                          "map", "join", "component", "implementation", "end"] },
      "params": { "type": "object" },
      "ends": { "$ref": "#/$defs/ends" },
      "retry": { "$ref": "#/$defs/retry" },
      "label": { "type": "string", "maxLength": 80 } } },
    "componentBody": { "type": "object", "additionalProperties": false, "required": ["entry", "nodes"], "properties": {
      "entry": { "$ref": "#/$defs/nodeId" },
      "maxTransitions": { "type": "integer", "minimum": 1, "maximum": 10000 },
      "inputs": { "type": "array", "items": { "type": "string" } },
      "outputs": { "type": "array", "items": { "type": "string" } },
      "nodes": { "type": "object", "minProperties": 1, "propertyNames": { "$ref": "#/$defs/nodeId" }, "additionalProperties": { "$ref": "#/$defs/node" } } } }
  }
}
```

Los `params` de cada pieza se validan con el sub-schema de esa pieza (sección 4), publicado por `runtime workflows` como `paramsSchema`. El schema anterior deja `params` abierto a propósito: la validación de piezas la hace Core con el registro, no el schema estático.

### 2.2 Reglas semánticas que valida el compilador (no expresables en el schema)

1. Todo `nodeId` referenciado en `entry` y en cualquier `ends` existe en `nodes` (o en el `componentBody` correspondiente).
2. Cada pieza declara sus **etiquetas de salida** (sección 4). `ends` debe contener exactamente esas etiquetas, ni más ni menos; `null` significa fin del grafo con el resultado de esa etiqueta (`success` si la etiqueta es `next`, `pass`, `stop`, `ok`; `failure` si es `fail`, `failed`, `blocked`).
3. Existe al menos un camino desde `entry` a un `end` o a un `ends: null`.
4. Ningún `nodeId` empieza por `$` (reservado a canales de estado, sección 3) ni coincide con un nombre de canal.
5. `journal: 'implementation'` exige exactamente un nodo `implementation` y `change: 'new' | 'existing'`. `journal: 'ledger-only'` prohíbe `implementation`.
6. Si algún nodo tiene efecto de escritura (sección 4), todo `end` con `outcome: 'success'` debe llevar `requiresVerified: true` **o** la definición debe declarar `delivery.requiresVerified: false` explícitamente (el host decide entonces no entregar a revisión).
7. `roles` incluye todos los `roleId` usados por `role-turn` y `decider`; el host los resuelve contra `config.roles`/`config.agents` antes de lanzar y Core lo comprueba en preflight.
8. `map.params.body` referencia un componente existente; `join` solo puede ser destino de un `map` y viceversa.
9. `component` no puede anidar más de 3 niveles ni referenciarse a sí mismo (directa o indirectamente).
10. `maxTransitions` de la definición acota el grafo completo, incluidas visitas dentro de componentes y ramas.

### 2.3 Versión y hash

`version` = SHA-256 hex de la serialización canónica de la definición **sin** el campo `version`. Canónica: claves ordenadas lexicográficamente en todos los niveles, sin espacios, números en la forma más corta de JavaScript, cadenas en UTF-8 con escapes JSON mínimos (equivalente a RFC 8785). Implementación en `src/agent-runtime/engine/definition/hash.ts` *(propuesto)*, exportada y reutilizada por Desktop a través de `runtime workflows validate --stdin`, que devuelve el hash calculado; Desktop **no** reimplementa el hash, lo pide a Core.

Una definición con `version` distinta del hash calculado se rechaza (`definition_hash_mismatch`).

### 2.4 Interpolación

- Desktop resuelve al compilar: `{{spec.*}}` (`interpolateSpec`, `server/modules/loops/runtime/loop-graph.ts`), `{{const:*}}` (`resolveConstants`) y `{{cmd:*}}` (`expandCommands`, `loop-command-catalog.ts:381`, con el proveedor del `engine` del nodo). El resultado de `{{cmd:X}}` es `params.text` cuando X es una plantilla destilada, o `params.nativeCommand` cuando X es un comando nativo del proveedor (`/specrails:...`, `/opsx:...`, `$skill`).
- Core resuelve en cada nodo, antes de ejecutarlo, los tokens `{{run.<name>}}` sobre `$vars` (sección 3). Un token sin valor hace fallar el nodo con `run_var_missing` antes de invocar nada.
- Ningún otro token se interpreta. Un `{{` literal se escribe `{{{{`.

## 3. Estado del run

Canales de `CoreDefinitionState` *(propuesto, `src/agent-runtime/engine/state/definition-state.ts`)*, todos JSON plano:

| Canal | Tipo | Reducer | Quién escribe |
|---|---|---|---|
| `$outputs` | `Record<nodeId, JsonValue>` | mezcla por `nodeId` (reemplaza la salida del nodo) | toda pieza al terminar |
| `$vars` | `Record<string, string>` | mezcla por clave | `prompt`/`shell` con `captureVars`; `condition` no escribe |
| `$history` | `Array<{ nodeId, at, kind, summary }>` | añade y recorta por el final hasta `policies.historyMaxChars` (recorte por entradas completas) | `prompt`, `role-turn`, `decider`, `verify`, `shell` |
| `$sessions` | `Record<nodeId, { provider, sessionId, identity }>` | mezcla | `prompt`, `role-turn`, `decider` |
| `$usage` | `{ costUsd, inputTokens, outputTokens, knownCostUsd, knownTokens }` | suma con semántica nulo-permanece-nulo (igual que `accountUsage` en `workflow.ts:88-95`) | toda pieza con IA |
| `$attempts` | `Record<nodeId, number>` | incrementa | motor |
| `$consecutiveFailures` | `number` | reemplaza | motor (0 tras éxito, +1 tras fallo de pieza con IA) |
| `$candidate` | `{ hash, atTransition }` | reemplaza | motor tras cada pieza con efecto de escritura, con `fingerprintCandidate` |
| `$verified` | `{ receiptId, candidateHash, atTransition } \| null` | reemplaza | `verify`; el motor lo pone a `null` tras una escritura posterior |
| `$answers` | `string[]` | añade | `question` al reanudar |
| `$branches` | `Record<mapNodeId, { total, done, results: JsonValue[] }>` | mezcla por `mapNodeId`, `results` añade | `map`/`join` |
| `$transitions` | `number` | incrementa | motor |

El subgrafo `implementation` usa `CoreState` (`src/agent-runtime/graph/state.ts:52-72`) como estado propio; el compilador conecta entrada (`change`, contexto) y salida (`$outputs[nodeId] = { completion, review, archived }`).

## 4. Piezas

Cada pieza declara: `kind`, `executor: 'core'`, `paramsSchema`, `effect: 'read' | 'write' | 'derived'` (`derived` = el efecto lo fija `roles[roleId].access` o `params.access`), etiquetas de salida (`outcomes`), y qué canales lee y escribe. `runtime workflows` publica exactamente esta tabla como JSON.

### 4.1 `prompt`

Turno libre a un proveedor, sin instrucciones de rol ni OpenSpec. Sustituye al `ai-step` de Desktop.

```
params: { engine: Engine, text?: string, nativeCommand?: { id: string, args?: string },
          access: 'read' | 'write', sentinel?: 'verification' | 'blocked' | 'none' (default none),
          captureVars?: Array<{ name: string, pattern: string, group?: number }>,
          sessionContinuity: 'run' | 'none' (default run), idleTimeoutMs?: integer, timeoutMs?: integer,
          appendHistory?: boolean (default true), appendSteering?: boolean (default true) }
outcomes: sentinel none → ['next', 'failed']; 'verification' → ['pass', 'fail', 'failed']; 'blocked' → ['next', 'blocked', 'failed']
effect: params.access
```

Semántica:

- Se ejecuta con `ExecutorRegistry.execute(engine.provider, request)` (`src/agent-runtime/executors.ts:29-37`) con `AgentRequest.instructions: 'none'` y `AgentRequest.access = params.access` *(campos propuestos, ver tareas C2)*. `text` o `nativeCommand` es obligatorio (exactamente uno). `nativeCommand` se renderiza por proveedor: Claude y Gemini `"/<id> <args>"` como prompt en `-p`; Codex `"$<id> <args>"` como prompt; Kimi con el runner de skills que Core ya gestiona (`templates/kimi/specrails/run-skill.mjs`, `integration-contract.json` bloque `kimi.cli.workflowArgs`). Un proveedor que no soporte el comando falla con `native_command_unsupported`.
- `sessionContinuity: 'run'` reutiliza `$sessions[nodeId]` si la identidad (proveedor, modelo, `ROLE_INSTRUCTIONS_VERSION`, hash de `text`/`nativeCommand`) coincide, como `graph/roles.ts:83-90`.
- `sentinel: 'verification'`: la última aparición de `VERIFICATION: PASS` o `VERIFICATION: FAIL` en el texto decide `pass`/`fail`; sin sentinel ⇒ `fail` con `reasons: ['missing_sentinel']` (misma regla que `execution/runtime/verification-sentinel` de Desktop). `sentinel: 'blocked'`: una línea `LOOP_BLOCKED: <motivo>` (`loop-run-manager.ts:310`) produce una interrupción `question` con ese motivo; la respuesta se añade a `$answers` y se anexa al siguiente intento del mismo nodo.
- `captureVars`: cada patrón (regex JavaScript sin flags peligrosos, ≤ 200 caracteres) se aplica al texto; el grupo capturado (por defecto 1) se guarda en `$vars[name]`. Sin coincidencia no falla; el consumidor fallará con `run_var_missing` si lo necesita.
- `failed` (etiqueta) solo por error de ejecución tras agotar `retry`; un resultado con texto vacío o `is_error` del proveedor es `failed`.
- Escribe `$outputs[nodeId] = { text (acotado a 32000 caracteres), sessionId?, sentinel?, vars? }`, `$history`, `$sessions`, `$usage`.

### 4.2 `role-turn`

```
params: { roleId: RoleId, prompt: string, structuredOutput?: JSONSchema, sessionContinuity: 'run' | 'none' }
outcomes: structuredOutput ausente → ['next', 'failed']; presente → ['next', 'invalid', 'failed']
effect: derived (roles[roleId].access)
```

Turno con `createRoleInvoker` (`graph/roles.ts:58`): instrucciones de rol (`prompts.ts:398-413`), OpenSpec si el rol declara `openspecSkill`, obligaciones de aceptación, paquete de contexto de repositorio, una reparación en sesión si `structuredOutput` no se cumple; tras la reparación fallida ⇒ `invalid`. Escribe `$outputs[nodeId] = { text, structured? }`, `$history`, `$sessions`, `$usage`.

### 4.3 `decider`

```
params: { roleId: RoleId (access read), goal: string, noProgress?: integer }
outcomes: ['continue', 'stop', 'failed']
effect: read
```

Prompt de sistema y parseo portados de `server/modules/loops/runtime/loop-decider.ts`; salida estructurada `{ verdict: 'continue' | 'stop', reason: string }`; recibe `$history` completo (acotado) y `goal`. Si `noProgress` (o `policies.noProgress`) visitas consecutivas terminan en `continue` con el mismo `$candidate.hash`, el motor fuerza `stop` con `$outputs[nodeId].stalled = true` y `completion.reasons += 'no_progress'`; la definición decide con `ends.stop` adónde va. Escribe `$outputs[nodeId] = { verdict, reason, stalled? }`, `$history`, `$usage`.

### 4.4 `condition`

```
params: { expr: string }
outcomes: ['true', 'false']
effect: read
```

`expr` es una expresión del sub-lenguaje de Core *(propuesto, `engine/pieces/condition/expr.ts`)*: operandos `$outputs.<nodeId>.<ruta>`, `$vars.<name>`, `$verified`, `$attempts.<nodeId>`, literales; operadores `== != < <= > >= && || !`, `exists(x)`, `matches(x, /re/)`. Sin funciones definidas por el usuario, sin acceso a nada fuera del estado. Un error de evaluación es `false` con `completion.reasons += 'condition_error:<nodeId>'`.

### 4.5 `verify`

```
params: { commands: 'configured' | VerificationCommand[], unverified?: boolean, maxConcurrency?: integer }
outcomes: ['pass', 'fail', 'failed']
effect: write
```

`VerificationCommand` es el tipo de `src/pipeline/pipeline-state.ts:31-41`. `'configured'` usa `config.verification`. Ejecuta `verifyPipeline` (`pipeline-state.ts:886`) con receipt `full` cuando cubre todos los repositorios y `scoped` en otro caso; valida antes con `validateVerificationRequest` (`:984`). `pass` ⇔ `receipt.valid`. Escribe `$verified = { receiptId, candidateHash, atTransition }` en `pass`; `$outputs[nodeId] = { receiptId, valid, reason?, commands: [{ repositoryId, command, exitCode }] }`. `failed` solo por error de infraestructura (no por comandos que fallan).

### 4.6 `shell`

```
params: { argv?: string[], commandLine?: string, repositoryId: string, cwd?: string, env?: Record<string,string>,
          timeoutMs?: integer (default 600000), captureVars?: Array<{ name, pattern, group? }>, evidence?: boolean (default false),
          outputCapBytes?: integer (default 262144) }
outcomes: ['ok', 'fail', 'failed']
effect: write
```

Exactamente uno de `argv` o `commandLine`. `argv` se ejecuta directamente; `commandLine` a través del shell de la plataforma con la utilidad de Core (`src/installer/util/exec.ts` para comillas de Windows). `ok` ⇔ exit 0; `fail` ⇔ exit distinto de 0; `failed` ⇔ no se pudo lanzar o superó `timeoutMs`. Con `evidence: true` se ejecuta como un `VerificationCommand` único a través de `verifyPipeline` y deja receipt (sin tocar `$verified`). Escribe `$outputs[nodeId] = { exitCode, stdout (acotado), stderr (acotado), vars? }`, `$vars`, `$history`.

### 4.7 `openspec-validate` y `openspec-archive`

```
openspec-validate: params { change: string }  outcomes ['pass', 'fail', 'failed']  effect read
openspec-archive:  params { change: string }  outcomes ['next', 'failed']         effect write
```

Usan OpenSpec 1.4.1 fijado por Core (`resolveOpenSpecCli`, `runOpenSpec`, `src/agent-runtime/openspec.ts:78-98`), nunca el CLI global. `openspec-validate` ejecuta `validate <change> --strict --json`; `openspec-archive` reutiliza `archive` de `graph/artifacts.ts`. `change` admite `{{run.changeId}}`.

### 4.8 `approval`, `question`, `gate`

```
approval: params { reason: string }   outcomes ['next']   effect read   → context.interrupt({ kind: 'approval', reason })
question: params { text: string }     outcomes ['next']   effect read   → context.interrupt({ kind: 'question', question })
gate:     params { reason: string }   outcomes ['next']   effect read   → interruptBefore del nodo destino de 'next'
```

La respuesta llega con `runtime resume --approve <nodeId>` o `--answer <text>`; `$answers` recibe la respuesta de `question`. `runtime status` expone `pendingApproval`/`pendingQuestion` con `stepId` como hoy (`cli.ts:34-45`).

### 4.9 `map` y `join`

```
map:  params { over: 'tickets' | 'repositories' | { outputsOf: nodeId, path: string }, body: componentName, concurrency?: integer }
      outcomes ['next']   effect derived (el del body)
join: params { reduce: 'collect' | 'all-ok' | 'any-ok' }
      outcomes ['next', 'fail']   effect read
```

El compilador genera una arista condicional con `Send(bodyNodeName, itemState)` por elemento hacia el subgrafo `body`, y un nodo `join` con `defer: true`. `concurrency` (o `policies.concurrency`) se aplica con un semáforo del run compartido por todas las piezas con IA. Cada rama recibe `$item = { index, value }` como entrada del componente y devuelve `$outputs` del componente; `join` escribe `$branches[mapNodeId]` y `$outputs[joinNodeId] = { total, ok, failed, results }`. `all-ok`: `next` si todas las ramas terminaron en éxito, si no `fail`; `any-ok`: `next` si alguna; `collect`: siempre `next`. `over: 'tickets'` itera `context.specs`; `over: 'repositories'` itera `context.repositories`.

### 4.10 `component`

```
params: { ref: componentName, inputs?: Record<string, string> }
outcomes: los declarados por el componente en `outputs` (por defecto ['next', 'failed'])
effect: derived (el máximo de sus nodos)
```

Subgrafo compilado con estado `CoreDefinitionState` propio; `inputs` mapea canales o literales del padre a `$vars` del hijo; el componente termina por un `end` cuyo `outcome` selecciona la etiqueta de salida. Interrupciones dentro del componente se propagan al padre (`Command.PARENT`); `fork` puede apuntar a nodos internos con la ruta `<componentNodeId>/<innerNodeId>`.

### 4.11 `implementation`

```
params: { attempts?: integer (default config.limits.maxAttempts ?? 3), approvalBeforeArchive?: boolean, reviewPolicy?: { minScore?, aspects? } }
outcomes: ['next', 'rejected', 'failed']
effect: write
```

Subgrafo con `CoreState` y los seis nodos de `coreNodes(deps)` (`graph/nodes.ts:441`), aristas exactamente como hoy (`architect → developer → verify → reviewer → archive`, `fixer` desde `verify`/`reviewer` en correcciones, `nodes.ts:103, 237, 252, 265, 375, 425`), `journal: 'implementation'` (transiciones de `state.json` como hoy). `next` ⇔ archivado; `rejected` ⇔ agotados los intentos con revisión rechazada o verificación fallida; `failed` ⇔ error de ejecución. Escribe `$outputs[nodeId] = { completion: PipelineCompletion, review: ReviewRecord | null, archived: ArchiveRecord | null }` y `$verified` desde el receipt del subgrafo. Es la única pieza que toca `state.json`.

### 4.12 `end`

```
params: { outcome: 'success' | 'failure', requiresVerified?: boolean, reason?: string }
outcomes: []   effect read
```

Termina el run: `completion.ok = outcome === 'success'`; `completion.verified = $verified !== null && $verified.candidateHash === $candidate.hash`; si `requiresVerified` y no está verificado, `completion.ok = false` con `reasons += 'unverified'`. Un `ends: null` en otra pieza equivale a un `end` implícito con el `outcome` de la etiqueta (sección 2.2, regla 2).

## 5. Semántica de ejecución

1. **Compilación**: `compileDefinition(def, deps)` valida schema, reglas 2.2, roles y `paramsSchema` de cada nodo; construye el `StateGraph`: `addNode(id, wrapper(piece), { retryPolicy })`, aristas estáticas para `next` único, `addConditionalEdges(id, router, { label: target | END })` para varias etiquetas, `Send` para `map`, subgrafos para `component`/`implementation`, `interruptBefore` para `gate`; `compile({ checkpointer, store })`; `recursionLimit = maxTransitions + 1`.
2. **Envoltorio de nodo**: antes de ejecutar comprueba presupuesto (`$usage` frente a `budget`) ⇒ `blocked` con `budget_exhausted`; comprueba cancelación; resuelve `{{run.*}}`; registra el intento en el ledger (`attempts`); ejecuta la pieza; escribe salida, `$history`, `$usage`; actualiza `$candidate` tras efecto de escritura; pone `$verified = null` si hubo escritura después de un `verify`; incrementa `$transitions`; persiste ledger y checkpoint en la misma transacción.
3. **Reintentos**: `retryPolicy` de LangGraph por nodo con `retry` del nodo (por defecto `{ maxAttempts: 2, backoffMs: 5000, retryOn: ['idle_timeout', 'provider_request_error'] }` para piezas con IA; `maxAttempts: 1` para el resto). Los errores se clasifican por `AgentExecutionError.code` (`src/agent-runtime/executor-types.ts:129-134`). Los reintentos de negocio son aristas.
4. **Fallos consecutivos**: cada etiqueta `failed` de una pieza con IA incrementa `$consecutiveFailures`; al alcanzar `policies.failFast` el motor fuerza el fin con `status: 'failed'`, `reasons += 'fail_fast'`.
5. **Interrupciones**: `approval`/`question`/`gate` pausan; el proceso termina con exit 2 y `runtime-result.status = 'paused'`. `resume` continúa con `Command({ resume })`.
6. **Escritura interrumpida**: un nodo con efecto de escritura cuyo intento está en `running` al reanudar exige `--recover <nodeId>`; sin él, `status: 'blocked'` con `recover_required` (regla actual de `workflow.ts:232-245`).
7. **Invalidación**: `--invalidate <nodeId>` bifurca al checkpoint anterior a ese nodo y borra las salidas posteriores; se conserva la semántica actual (`workflow.ts:253-268`).
8. **Fork**: `runtime fork --from <nodeId> [--state <file>]` crea un run nuevo (`runId` nuevo, `forkOf` = original) a partir del checkpoint anterior a `<nodeId>` del original, aplicando opcionalmente `--state` (JSON con canales `$vars`/`$outputs` a sobrescribir) mediante `updateState`; el original no se modifica.
9. **Cancelación**: SIGTERM ⇒ `AbortSignal` a la pieza en curso (los ejecutores ya lo aceptan), estado `cancelled`, checkpoint reanudable.
10. **Fin**: `runtime-result` con `status ∈ succeeded | failed | blocked | paused | cancelled`, `completion`, `usage`, `invocationUsage` (uso de esta invocación, como hoy `cli.ts:81-87`).

## 6. Almacenamiento: `run.sqlite`

Ruta: `<backlogRoot>/.specrails/pipeline/<runId>/run.sqlite` *(propuesto)*. Apertura con `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;` y permisos 0600 (directorio 0700, como hoy `cli.ts:170`). Un único proceso escritor por run (tabla `lease`). Binding SQLite según el spike C1: preferente `node:sqlite` (`DatabaseSync`, disponible sin flag en el Node 22.22.3 que Desktop empaqueta, `.github/workflows/desktop-release.yml:26`), alternativa `better-sqlite3` vía `@langchain/langgraph-checkpoint-sqlite`.

Tablas del checkpointer (mismo esquema que `@langchain/langgraph-checkpoint-sqlite`, para poder intercambiar el binding): `checkpoints(thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint BLOB, metadata BLOB, PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id))`, `writes(thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value BLOB, PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, idx))`.

Tablas del ledger *(propuestas)*:

```sql
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, definition_hash TEXT NOT NULL, definition_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('definition','builtin')), engine_version INTEGER NOT NULL,
  runtime_identity_json TEXT NOT NULL, status TEXT NOT NULL, fork_of TEXT, completion_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE steps (
  run_id TEXT NOT NULL REFERENCES runs(run_id), node_path TEXT NOT NULL, kind TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, last_attempt_id TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, node_path));
CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), node_path TEXT NOT NULL,
  visit INTEGER NOT NULL, attempt INTEGER NOT NULL, branch TEXT, status TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, error_code TEXT, error_message TEXT,
  outcome TEXT, output_json TEXT, usage_json TEXT);
CREATE TABLE invocations (
  invocation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  node_path TEXT NOT NULL, role TEXT, provider TEXT NOT NULL, model TEXT, kind TEXT, status TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, tool_calls INTEGER, usage_json TEXT NOT NULL,
  prompt_bytes INTEGER, context_bytes INTEGER);
CREATE TABLE receipts (
  receipt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), node_path TEXT NOT NULL,
  attempt_id TEXT NOT NULL, kind TEXT NOT NULL, valid INTEGER NOT NULL, candidate_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE budget (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id), max_cost_usd REAL, max_tokens INTEGER, max_duration_ms INTEGER,
  known_cost_usd REAL NOT NULL DEFAULT 0, known_tokens INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0);
CREATE TABLE interrupts (
  run_id TEXT NOT NULL REFERENCES runs(run_id), node_path TEXT NOT NULL, kind TEXT NOT NULL,
  requested_at TEXT NOT NULL, payload_json TEXT NOT NULL, resolved_at TEXT, resolution_json TEXT,
  PRIMARY KEY (run_id, node_path, requested_at));
CREATE TABLE steering_inbox (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), at TEXT NOT NULL, sender TEXT NOT NULL,
  text TEXT NOT NULL, consumed_attempt_id TEXT, consumed_at TEXT);
CREATE TABLE lease (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id), owner TEXT NOT NULL, acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id), type TEXT NOT NULL,
  at TEXT NOT NULL, payload_json TEXT NOT NULL);
```

`node_path` es `nodeId` o `<componentNodeId>/<innerNodeId>` (hasta 3 niveles). El lease se renueva cada 15 s y expira a los 60 s; `resume` sobre un lease vigente falla con `lease_held`; sobre uno expirado lo toma y registra `lease_recovered` en `events`.

`state.json` (journal) solo existe cuando hay `implementation`, con el formato actual de `pipeline-state.ts` (sin cambios).

## 7. CLI

Entrada: `node <core>/dist/agent-runtime/cli.js <verbo> [flags]` con `parseArgs` (`src/shared/args.ts`: `--flag value`, `--flag=value`, booleanos). Salida: una línea JSON por evento en stdout; nada más en stdout. Errores fatales: una única línea `{"type":"runtime-result","status":"failed","error":{"code":"<código>","message":"<texto>"}}` y exit 1 (hoy el error es solo `error: string`, `cli.ts:200`; el objeto es aditivo y el legado conserva la cadena en `message`).

| Verbo | Flags | Salida | Exit |
|---|---|---|---|
| `api` | — | `runtime-api` (sección 9) | 0 |
| `workflows` | — | `runtime-workflows { nodeKinds: PieceDescriptor[], nodeKindsVersion, builtins: [{ id, version, deprecated }] }` | 0 |
| `workflows validate` | `--stdin` (definición JSON) | `runtime-definition-validated { ok: true, version, graph: { nodes, edges } }` o `{ ok: false, errors: [{ code, nodeId?, path?, message }] }` | 0 si `ok`, 1 si no |
| `run` | `--context <file> --config <file> --change <slug> --definition <file>`; legado: `--workflow specrails-implementation` sin `--definition` | eventos + `runtime-result` | 0 / 2 / 1 |
| `resume` | `--context <file> [--approve <nodeId>] [--answer <text>] [--recover <nodePath>] [--invalidate <nodePath>]` | eventos + `runtime-result` | 0 / 2 / 1 |
| `fork` | `--context <file> --from <nodePath> [--state <file>] --run-id <newRunId>` | `runtime-forked { runId, forkOf, fromNodePath }` | 0 / 1 |
| `status` | `--context <file> [--compact]` | `runtime-status` (sección 8.7) | 0 |
| `signal` | `--context <file> --stdin` (texto ≤ 20000) | `runtime-signal-accepted { id }` | 0 / 1 |
| `evidence`, `recovery`, `capabilities`, `prompts`, `validate`, `evaluate` | como hoy (`cli.ts:88-143`); `evaluate` gana `--definition` | como hoy | como hoy |

Reglas: `run` con `--definition` y `--workflow` a la vez ⇒ `invalid_arguments`. `resume` no acepta `--definition` ni `--config` (usa el request congelado). `fork` exige que el run original no tenga lease vigente. `--answer` y `--approve` son excluyentes con `--recover`/`--invalidate` en la misma invocación.

Códigos de salida: 0 `succeeded`; 2 `paused`; 1 `failed`, `blocked`, `cancelled` o error fatal (igual que hoy, `cli.ts:194`).

### 7.1 Catálogo de códigos de error

`invalid_arguments`, `definition_invalid` (con `errors[]`), `definition_hash_mismatch`, `piece_unknown`, `piece_params_invalid`, `role_unknown`, `run_exists`, `run_not_found`, `lease_held`, `recover_required`, `answer_required`, `approval_required`, `resume_incompatible` (definición, config o identidad distintas), `engine_unsupported` (Desktop pide v2 a un Core sin motor), `provider_capability_unsupported`, `native_command_unsupported`, `run_var_missing`, `budget_exhausted`, `recursion_limit`, `fail_fast`, `no_progress`, `idle_timeout`, `timeout`, `provider_request_error`, `session_not_found`, `invalid_structured_output`, `aborted`, `internal`.

## 8. Eventos JSONL

Todos los eventos llevan `type`. Tamaño máximo por línea: 1.000.000 caracteres (la mitad del límite del bridge, `agent-runtime-bridge.ts:144`); las cadenas se acotan antes de serializar.

### 8.1 `runtime-graph` *(nuevo)*

Una vez al inicio de `run` y `resume`: `{ type: 'runtime-graph', runId, definitionHash, workflowId, nodes: [{ path, kind, label }], edges: [{ from, label, to }], mermaid }`. Desktop lo persiste como `loop_graph` para el explorer.

### 8.2 `workflow-event`

`{ type: 'workflow-event', event: WorkflowEvent }` con `WorkflowEvent` como hoy (`workflow-types.ts:127-146`: `id, sequence, runId, traceId, spanId?, type, timestamp, stepId?, attemptId?, usage?, message?`) más los campos aditivos `nodePath`, `kind`, `branch?`, `outcome?`, `visit`, `attempt`. Tipos: los actuales (`workflow_started|resumed|invalidated|succeeded|failed|blocked|paused|cancelled`, `step_started|succeeded|failed|blocked|paused|interrupted`) más `step_retrying`, `branch_started`, `branch_finished`, `workflow_forked`.

### 8.3 `agent-event`

Como hoy: `{ type: 'agent-event', role, event: AgentEvent }` (`executor-types.ts:66-79`: `kind: text|tool-start|tool-end|usage|session`), más `nodePath` y `branch?`. Para `prompt`, `role` es `'prompt'`; para `decider`, `'decider'`.

### 8.4 `verification-output`

Como hoy: `{ type: 'verification-output', text }` más `nodePath`.

### 8.5 `span`

Como hoy (`WorkflowSpan`, `workflow-types.ts:148-160`) más `nodePath`, `branch?`, `kind`.

### 8.6 `runtime-efficiency-event`

Como hoy (`cli.ts:186`), con `nodePath`. Es la fuente del proveedor y modelo por intento para la contabilidad de Desktop (`ProviderInvocation`, `efficiency-types.ts:7-26`).

### 8.7 `runtime-status` y `runtime-result`

`runtime-status` compacto: `{ type: 'runtime-status', engineVersion, state: { runId, traceId, status, nextNodePath, updatedAt, error?, pendingApproval?, pendingQuestion?, usage, steps: Record<nodePath, { kind, status, visits }>, recentFailures[] }, workflow: { id, version, source }, completion: { ok, reasons, verified } | null, forkOf?, metrics }`. El legado conserva su forma actual (`cli.ts:34-45`).

`runtime-result`: `{ type: 'runtime-result', runId, traceId, status, nextNodePath, error?, pendingApproval?, pendingQuestion?, usage, invocationUsage, completion, workflow, forkOf?, metrics, efficiencySummary }`.

### 8.8 Orden y garantías

Los eventos de un run tienen `sequence` estrictamente creciente por `runId` (también a través de `resume`); las ramas de `map` entrelazan eventos pero cada rama lleva `branch`. Un evento se emite **después** de confirmarse la transacción que lo produce (misma regla que `commit` en `workflow.ts:186-199`). Desktop puede reconstruir `loop_step`/`loop_step_end` solo con `workflow-event` (`step_started` → `loop_step`, `step_succeeded|failed|blocked|interrupted` → `loop_step_end`).

## 9. Ficheros congelados por run y `runtime api`

| Fichero | Escribe | Contenido |
|---|---|---|
| `desktop-context.json` | Desktop (`server/core-execution.ts:56-105`) | `CoreContext` actual: `runId, backlogRoot, backlogPath, artifactRoot, artifactRepositoryId, repositories[], ownership, specs[]`. Para el motor v2 Desktop fija siempre `ownership.git: 'host'`. |
| `desktop-runtime-config.json` | Desktop (`agent-runtime-bridge.ts:110-118`) | `RuntimeConfig` efectiva (`executor-types.ts:51-66`) con `roles` (C2). |
| `desktop-runtime-host.json`, `desktop-runtime-selection.json` | Desktop | Como hoy (`agent-runtime-bridge.ts:31-40, 96-100`). |
| `desktop-workflow-definition.json` *(propuesto)* | Desktop | La definición compilada (sección 2), con `version` calculada por Core en la validación previa al lanzamiento. |
| `agent-runtime-request.json` | Core (`cli.ts:158-177`) | `{ change, config, runtimeIdentity, workflow: { id, version, source, definitionHash, engine } }` *(campo `workflow` propuesto)*. |

`runtime api` devuelve: `{ type: 'runtime-api', apiVersion: 1, coreVersion, runtimeIdentity, workflowVersions: ['6'], engineVersion: 2, nodeKindsVersion, nodeKinds: string[], capabilities: { ...las ocho actuales (cli.ts:119), engineV2: 1, workflowDefinitions: 1, openRoles: 1, fanOut: 1, fork: 1, steeringInbox: 1 }, guardrails }`. `integration-contract.json` añade `agentRuntime.engine: { version: 2, definitionSchema: 'schemas/workflow-definition.schema.json', nodeKindsVersion }`, `agentRuntime.nodeKinds: string[]`, `agentRuntime.builtins: [{ id: 'specrails-implementation', version: '6', deprecated: boolean }]`, corrige `workflowVersion: "6"`, `instructionsVersion: "9"`, `phases` con `fixer` y `cliOperations` completos; `schemaVersion` pasa a `"5.1"`.

## 10. Compatibilidad

| Desktop | Core | Comportamiento |
|---|---|---|
| ≥ 2.58 (D0) | 6.0.x (sin `engineV2`) | Loops con `kind` no se lanzan: error `engine_unsupported` con mensaje de actualización en la UI; loops antiguos y de fábrica por el camino actual (`core-implementation`). |
| ≥ 2.59 (D1) | ≥ 6.3 (`engineV2`) | Loops con `kind` por el motor v2; loops antiguos por el motor de Desktop hasta su migración (D8). |
| ≤ 2.57 | ≥ 6.1 | Sin `--definition`; Core ejecuta el legado como hoy. |
| cualquiera | 7.x | Solo motor v2; los runs antiguos reanudan con su paquete retenido (`resolveRetainedAgentRuntime`). Desktop ≤ 2.57 no es compatible con Core 7 (`SUPPORTED_CORE_MAJORS` lo excluye hasta D8). |

Runs guardados: el request congelado dice `engine: 1 | 2`; `resume` elige el motor por ese campo y comprueba `sameRuntimeIdentity` como hoy.

## 11. Correspondencia con el motor de loops actual de Desktop

Constantes actuales en `server/modules/loops/runtime/`: `AI_STEP_TIMEOUT_MS = 15 min`, `DECIDER_TIMEOUT_MS = 3 min`, `SHELL_TIMEOUT_MS = 10 min`, `SHELL_OUTPUT_CAP = 256 KiB`, `DEFAULT_INACTIVITY_TIMEOUT_MS = 30 min` (`loop-executors.ts:45-51`), `AI_FAILFAST_THRESHOLD = 2` (`loop-run-manager.ts:481`), `NO_PROGRESS_LIMIT = 2` (`:1320`), `HISTORY_MAX_CHARS = 1500` (`:468`), `FACTORY_MAX_ITERATIONS = 12` (`loop-factory.ts:47`).

| Comportamiento actual | Motor v2 |
|---|---|
| `ai-step` (prompt libre al CLI del proveedor con `{{cmd:*}}`) | `prompt` con `text`/`nativeCommand` expandidos por Desktop; `timeoutMs` 15 min; `idleTimeoutMs` 30 min |
| `shell` | `shell` con `commandLine`, `timeoutMs` 10 min, `outputCapBytes` 256 KiB |
| `decider` | `decider`; `iteration` de Desktop = visitas del decisor |
| `condition` (join AND/OR) | `condition` con `expr` sobre `$outputs`/`$vars` |
| `operation: 'core-implementation'` | `implementation` |
| `stopOnFailure` | `ends.failed/fail → null` (fin con `failure`) o hacia un nodo de reparación |
| `failureRecovery { target, maxRetries: 1, artifactOnly }` | `retry.maxAttempts: 2` en el propio nodo, o `ends.fail → <target>` con un `condition` sobre `$attempts` que corta tras la segunda visita |
| `requireVerificationPass` / `{{cmd:verify}}` | `prompt` con `sentinel: 'verification'` o, preferido, `verify` con receipt |
| `requireRunVars: ['changeId']` | `condition` `exists($vars.changeId)` antes del nodo, o fallo natural `run_var_missing` |
| `maxIterations` | `maxTransitions` (visitas totales; una iteración de un ciclo de N nodos consume N transiciones: el compilador de Desktop multiplica `maxIterations` por el número de nodos del ciclo más el margen de reintentos) |
| `timeoutMinutes` | `budget.maxDurationMs` (el proceso de Core vive todo el run) |
| `maxCostUsd` | `budget.maxCostUsd` |
| Pausa humana (`awaitHumanDecision`, `LOOP_BLOCKED`) | `prompt.sentinel: 'blocked'` → `question`; `decider` con `verdict` ambiguo → `question` |
| Historial entre iteraciones | `$history` con `historyMaxChars` 1500 |
| Continuidad de sesión | `$sessions` con `sessionContinuity: 'run'` |
| Fail-fast, stall, no-progreso | `policies.failFast`, `retry.retryOn: ['idle_timeout']`, `decider.noProgress` |
| `loop_graph`, `loop_step`, `loop_step_end` | `runtime-graph`, `workflow-event step_started`, `workflow-event step_*` terminal |
| `ai_invocations` por paso | filas derivadas de `runtime-efficiency-event` + `workflow-event` (una por intento con IA) |
