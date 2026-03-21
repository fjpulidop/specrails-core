# Análisis de Viabilidad: Compatibilidad de SpecRails con OpenAI Codex

**Fecha**: 2026-03-21
**Autor**: CTO (f68f30eb) — via SPEA-503
**Estado**: Final — Listo para revisión del board

---

## Resumen Ejecutivo

**Veredicto: SÍ, es viable — y más sencillo de lo que parece.**

Claude Code y Codex han convergido arquitectónicamente de forma significativa durante 2025–2026. Comparten el mismo formato de Skills (OpenAI adoptó la spec de Anthropic en diciembre 2025), ambos soportan MCP como mecanismo de extensión, ambos usan ficheros Markdown jerárquicos como instrucciones de agente (`AGENTS.md` vs `CLAUDE.md`), y ambos soportan subagentes y ejecución paralela.

El camino de menor resistencia para dar soporte a Codex **no requiere reescribir specrails-core** — requiere refactorizar los comandos `/sr:*` de slash commands Claude Code-only a Skills (formato ya compatible con ambas plataformas), y añadir una capa de abstracción mínima en el instalador.

| Dimensión | Valoración |
|-----------|-----------|
| **Viabilidad técnica** | Alta |
| **Esfuerzo estimado (Approach A — Full Dual-CLI)** | 350–450 horas |
| **Esfuerzo estimado (Approach B — Skills-First, recomendado)** | 150–200 horas |
| **Riesgo técnico** | Medio-bajo |
| **Impacto estratégico** | Alto |

---

## 1. Qué es OpenAI Codex (2026)

Codex es el agente de ingeniería de software cloud-native de OpenAI, lanzado en mayo 2025. **No es el modelo de autocompletado de 2021** — es un agente autónomo equivalente a Claude Code.

### Superficies disponibles

| Superficie | Descripción |
|-----------|-------------|
| **Codex Cloud** (`chatgpt.com/codex`) | Agente web async, integrado con GitHub |
| **Codex CLI** (`@openai/codex`) | Terminal agent local, open source (Rust, Apache-2.0) |
| **Codex SDK** (`@openai/codex-sdk`) | TypeScript SDK para integración programática |
| **MCP Server** (`codex mcp-server`) | Expone Codex como servidor MCP |
| **GitHub Action** | CI/CD integración native |

### Invocación

```bash
# Instalación
npm i -g @openai/codex

# Interactivo (TUI)
codex

# No-interactivo / scripted
codex exec "fix all TypeScript errors in src/"

# Como MCP server
codex mcp-server
```

### Modelo subyacente

Basado en `codex-1` (variante de `o3` fine-tuned para ingeniería de software). API disponible como `codex-mini-latest` a $1.50/1M input tokens.

---

## 2. Convergencia Arquitectónica: Claude Code vs Codex

Esta es la finding más importante de la investigación.

| Dimensión | Codex | Claude Code | Compatibilidad |
|-----------|-------|------------|----------------|
| **Instrucciones de agente** | `AGENTS.md` (Markdown) | `CLAUDE.md` (Markdown) | ✅ Formato idéntico, distinto nombre |
| **Skills** | `SKILL.md` (mismo formato) | `SKILL.md` | ✅ **100% compatible — formato compartido** |
| **MCP** | First-class (cliente + servidor) | First-class | ✅ Interoperable |
| **Subagentes** | `spawn_agent`, `wait_agent`, etc. | `Agent` tool | ✅ Mismo concepto, distinta API |
| **Scope jerárquico** | Walk root → CWD | Walk root → CWD | ✅ Idéntico comportamiento |
| **Ejecución paralela** | Nativo (cloud worktrees + subagentes) | Subagentes + `isolation: worktree` | ✅ Ambos soportan |
| **Permisos** | `config.toml` + Starlark rules | `settings.json` JSON | ⚠️ Formatos distintos, conceptos análogos |
| **Definición de agentes** | TOML en `.codex/agents/` | Markdown en `.claude/agents/` | ⚠️ Formatos distintos |
| **Slash commands** | Sistema (30+ built-in, no user-definable) | User-definable + built-in | ❌ Modelo distinto |
| **Namespace de dirs** | `.codex/` | `.claude/` | ⚠️ Conflicto directo |
| **Config format** | TOML | JSON | ⚠️ Formatos distintos |
| **Memory** | Experimental (SQLite + MEMORY.md) | File-based | ⚠️ Distinto nivel de madurez |

### El hallazgo clave: Skills son el puente

OpenAI adoptó en diciembre 2025 el **mismo formato `SKILL.md`** que publicó Anthropic. Esto significa que:

> **Todos los Skills de specrails (`/sr:implement`, `/opsx:ff`, etc.) son compatible con Codex sin cambios de formato.**

La implicación práctica: si specrails migra sus comandos de workflow de "slash commands Claude Code-only" a "Skills" (lo que en gran medida ya está ocurriendo), esos Skills funcionan en ambas plataformas.

---

## 3. Análisis de Puntos de Acoplamiento

### 3.1 Acoplamiento Alto (Cambios necesarios)

#### A. Directorio `.claude/` — Namespace conflict

**Estado actual**: Todo specrails-core produce outputs en `.claude/` (agents, commands, rules, settings, memory). Codex usa `.codex/`.

**Solución**: Abstracción de paths en el instalador. Detectar qué CLI está instalado y generar en el directorio correcto. O soportar ambos simultáneamente (algunos proyectos usan ambas CLIs).

**Esfuerzo**: Medio — ~2-3 días. Afecta install.sh y todos los templates que hardcodean `.claude/`.

#### B. Comandos Slash vs Skills

**Estado actual**: Los comandos `/sr:*` son slash commands Claude Code-only, definidos como markdown en `.claude/commands/sr/`. Codex no permite slash commands user-definables.

**Solución (crítica)**: Los Skills ya son el mecanismo correcto. specrails ya tiene muchos `/sr:*` implementados como Skills (el `.claude/skills/` directory). La migración es convertir los comandos restantes a formato Skill.

```markdown
# Antes: .claude/commands/sr/implement.md (Claude Code-only)
# Después: .claude/skills/sr-implement/SKILL.md (compatible con ambos)
```

**Esfuerzo**: Medio-alto — ~5-8 días. Es trabajo de plantillas, no lógica nueva.

#### C. Detección de CLI en install.sh

**Estado actual**: El instalador hace `command -v claude` y falla si no está.

**Solución**: Detectar ambas CLIs y configurar el instalador según qué esté disponible:

```bash
if command -v claude &> /dev/null; then
    CLI_PROVIDER="claude"
elif command -v codex &> /dev/null; then
    CLI_PROVIDER="codex"
else
    fail "Ninguna CLI encontrada. Instala Claude Code o Codex."
    exit 1
fi
```

**Esfuerzo**: Bajo — ~1 día.

### 3.2 Acoplamiento Medio (Abstracción necesaria)

#### D. Configuración de permisos

**Estado actual**: `settings.json` con JSON (Claude Code-specific).

**Codex equivalente**: `config.toml` + Starlark rules en `.codex/rules/`.

**Solución**: El instalador genera el fichero correcto según `$CLI_PROVIDER`.

**Esfuerzo**: Bajo-medio — ~2 días.

#### E. Definición de agentes

**Estado actual**: Agents como Markdown con YAML frontmatter en `.claude/agents/sr-*.md`.

**Codex equivalente**: TOML en `.codex/agents/` con campos explícitos.

**Codex agent TOML equivalente**:
```toml
# .codex/agents/sr-architect.toml
name = "sr-architect"
description = "Software architect agent for designing implementation plans."
model = "codex-mini-latest"
```

**Solución**: Generar ambos formatos o detectar CLI y generar el correcto.

**Esfuerzo**: Medio — ~3-4 días.

#### F. Variables de entorno Claude Code-specific

**Estado actual**: El comando `/sr:implement` detecta `CLAUDE_CODE_ENTRYPOINT` y `CLAUDE_CODE_REMOTE`.

**Solución**: Abstracción — detectar environment vars de ambas CLIs o usar las propias del runner.

**Esfuerzo**: Bajo — ~1 día.

### 3.3 Acoplamiento Bajo (Funciona sin cambios)

| Componente | Por qué funciona | Notas |
|------------|-----------------|-------|
| **AGENTS.md / CLAUDE.md** | Formato Markdown idéntico | Solo hay que renombrar o soportar ambos |
| **Skills** | Formato 100% compartido | **Zero cambios necesarios** |
| **Backlog integration** | Usa `gh` CLI estándar | Sin dependencia de Claude Code |
| **OpenSpec CLI** | CLI-agnostic | Sin cambios |
| **Git operations** | Standard git | Sin cambios |
| **MCP server** | Ambas CLIs soportan MCP | Interoperable |
| **Personas (VPC)** | Markdown puro | Sin cambios |

---

## 4. Implicaciones para specrails-hub

specrails-hub se comunica con specrails-core vía `integration-contract.json`. El contrato define `cli.initArgs` y `cli.updateArgs` que hub usa para invocar la CLI.

**Cambios necesarios en hub**:

1. **Detección de CLI**: Hub debe detectar qué CLI está disponible en el entorno del usuario:
   ```typescript
   // En lugar de: execa('claude', ['..'])
   const cli = await detectCLI(); // returns 'claude' | 'codex' | null
   await execa(cli, args);
   ```

2. **Integration contract versionado**: Añadir `provider` field al contrato:
   ```json
   {
     "schemaVersion": "2.0",
     "provider": "claude | codex | auto",
     "cli": {
       "claude": { "initArgs": ["init", "--yes"] },
       "codex": { "initArgs": ["exec", "specrails-core init --yes"] }
     }
   }
   ```

3. **UI**: Mostrar qué CLI está activa en el dashboard de Hub.

**Esfuerzo en Hub**: Medio — ~3-5 días.

---

## 5. Enfoques de Implementación

### Approach A: Full Dual-CLI Support

**Descripción**: specrails-core genera configuraciones para ambas CLIs. El instalador detecta cuál está activa y genera los ficheros correctos. Soporte completo de todos los features en ambas plataformas.

**Esfuerzo estimado**:
| Área | Esfuerzo |
|------|----------|
| install.sh provider detection | 1 día |
| Directory abstraction (`.claude/` vs `.codex/`) | 3 días |
| Permisos / config (settings.json vs config.toml) | 2 días |
| Agent definitions (Markdown vs TOML) | 4 días |
| Skills migration (commands → Skills) | 8 días |
| Hub integration (contract + detection) | 5 días |
| Testing y QA | 10 días |
| **Total** | **~33 días (~5-6 semanas)** |

**Pros**: Feature parity completa. Usuarios eligen libremente.
**Contras**: Doble superficie de mantenimiento. Codex memory system menos maduro.

### Approach B: Skills-First (Recomendado)

**Descripción**: Refactorizar los comandos `/sr:*` como Skills (ya compatibles con ambas plataformas). El core de workflow no depende de la CLI — funciona igual en Claude Code y Codex. La integración de agentes se hace vía Skills y MCP.

**Por qué es el approach correcto**:
- Skills son el mínimo común denominador entre CLIs
- specrails ya está parcialmente en Skills format
- La dirección de la industria converge hacia Skills + MCP como estándares
- El MCP server planificado (SPEA-499 et al.) amplifica este approach

**Esfuerzo estimado**:
| Área | Esfuerzo |
|------|----------|
| install.sh detection | 1 día |
| Skills migration completa | 8 días |
| Directory detection/abstraction | 3 días |
| Hub detection layer | 3 días |
| Testing | 5 días |
| **Total** | **~20 días (~3-4 semanas)** |

**Pros**: 40% menos esfuerzo. Mejora la arquitectura globalmente. Prepara el terreno para más CLIs en el futuro. Alineado con MCP roadmap.
**Contras**: No todos los features de agentes complejos (worktree isolation) disponibles en Codex inmediatamente.

---

## 6. Riesgos y Mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|-----------|
| Codex CLI menos maduro que Claude Code | Alta | Medio | Lanzar Codex como beta/experimental inicialmente |
| Windows support experimental en Codex | Alta | Bajo | Documentar limitación |
| Codex memory system poco maduro | Alta | Bajo | Usar patterns file-based (MEMORY.md) en ambas |
| API de subagentes distinta | Media | Alto | Abstraer en Skills para no depender de tool-calling nativo |
| Double mantenimiento de templates | Media | Medio | Approach B minimiza esto |
| Fragmentación de usuarios | Baja | Medio | UX clara en /setup para elegir provider |

---

## 7. Análisis Estratégico

### Por qué hacer esto

1. **Mercado más amplio**: Hay usuarios comprometidos con el ecosistema OpenAI que no usarán Claude Code. Dar soporte a Codex multiplica el TAM potencial.

2. **Posición de independencia**: specrails se posiciona como "el framework product-driven agnóstico de LLM CLI", no como "el framework de Claude Code". Esto es más defensible.

3. **Skills como standard**: Con ambas plataformas usando el mismo formato de Skills, specrails se beneficia de ser el que más y mejores Skills tiene. Es una ventaja competitiva.

4. **MCP amplifica**: El MCP server planificado (SPEA-499 et al.) hace que specrails sea accesible desde cualquier cliente MCP — Cursor, Windsurf, VS Code, Codex, Claude. El Approach B (Skills-First) está directamente alineado con esta visión.

### El riesgo de NO hacerlo

Hay señales claras de que Codex está ganando tracción rápidamente (open source CLI, integración nativa GitHub, disponible en todos los planes ChatGPT). Si specrails no da soporte a Codex en 6-12 meses, queda encadenado al crecimiento de Claude Code exclusivamente.

---

## 8. Recomendación

**Proceder con Approach B (Skills-First) como Phase 1, con roadmap hacia Approach A.**

### Fase 1 — Skills-First (Q2 2026, ~3-4 semanas)
- Migrar comandos `/sr:*` a Skills format
- Añadir detección de CLI en install.sh
- Soporte de `.codex/` directory como alternativa a `.claude/`
- Hub detection layer
- **Resultado**: specrails funciona en Codex con los Skills principales

### Fase 2 — Agent Definitions (Q3 2026, ~2-3 semanas)
- Generación de agent TOML para Codex
- Configuración de permisos (`config.toml` + Starlark)
- Testing de integración completo

### Fase 3 — Feature Parity (Q4 2026, ongoing)
- Worktree isolation en Codex (si Codex CLI madura esto)
- Memory system adaptado
- Documentación completa para usuarios de Codex

---

## 9. Próximos Pasos Concretos

Si el board aprueba proceder:

1. **Crear epic SPEA-Codex-Support** en specrails-core project
2. **Asignar al Tech Lead (specrails-core)** el diseño técnico detallado de la abstracción de provider
3. **Crear subtareas**:
   - Skills migration completa (`/sr:*` → Skills format)
   - install.sh provider detection
   - Hub detection layer
   - Integration testing con Codex CLI
4. **Actualizar integration-contract.json** para soportar multi-provider

---

## Apéndice A: Comparativa de Comandos Equivalentes

| specrails (actual) | Claude Code invocation | Codex invocation |
|-------------------|----------------------|-----------------|
| `/sr:implement` | Slash command | Skill (mismo `SKILL.md`) |
| `/sr:product-backlog` | Slash command | Skill |
| `/opsx:ff` | Slash command | Skill |
| `/setup` | Slash command | `codex exec "run setup"` |
| Agent `sr-architect` | `.claude/agents/sr-architect.md` | `.codex/agents/sr-architect.toml` |
| Permissions | `.claude/settings.json` | `.codex/config.toml` |

## Apéndice B: Formato AGENTS.md vs CLAUDE.md

Los ficheros son **funcionalmente idénticos**. La única diferencia es el nombre del fichero:

- Claude Code carga: `CLAUDE.md` (o `.claude/CLAUDE.md`)
- Codex carga: `AGENTS.md` (o `AGENTS.override.md`)

**Solución trivial**: specrails puede generar ambos ficheros apuntando al mismo contenido, o el instalador genera el nombre correcto según el provider detectado.

## Apéndice C: Recursos de Referencia

- [Introducing Codex — OpenAI](https://openai.com/index/introducing-codex/)
- [AGENTS.md Custom Instructions — Codex Docs](https://developers.openai.com/codex/guides/agents-md)
- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference)
- [Skills — Codex Docs](https://developers.openai.com/codex/skills)
- [Subagents — Codex Docs](https://developers.openai.com/codex/subagents)
- [Configuration Reference — Codex](https://developers.openai.com/codex/config-reference)
- [openai/codex on GitHub](https://github.com/openai/codex)
- [OpenAI are quietly adopting skills — Simon Willison](https://simonwillison.net/2025/Dec/12/openai-skills/)
- Análisis de acoplamiento interno: revisión de 23 puntos de acoplamiento en specrails-core (SPEA-503)
- Análisis MCP feasibility: `docs/research/mcp-feasibility-analysis.md`
