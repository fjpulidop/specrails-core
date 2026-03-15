# Architect Agent Memory

## Memory Files

- [project_specrails_structure.md](project_specrails_structure.md) — repo layout, key files, self-hosting pattern
- [project_implement_pipeline.md](project_implement_pipeline.md) — implement command phase structure and variable conventions
- [setup_flow_and_personas.md](setup_flow_and_personas.md) — /setup phase map, persona system, install.sh→/setup handoff pattern
- [openspec_artifact_conventions.md](openspec_artifact_conventions.md) — OpenSpec artifact format, frontmatter schema, cross-file consistency patterns
- [project_web_manager_pattern.md](project_web_manager_pattern.md) — web-manager-mvp design patterns: self-contained web/ dir, WS protocol, hook integration, single-spawn constraint
- [pattern_static_command_templates.md](pattern_static_command_templates.md) — when to use static vs placeholder-based command templates
- [agent_memory_extension_pattern.md](agent_memory_extension_pattern.md) — shared memory store pattern: write path (producer agent), read path (consumer agent), JSON vs markdown, idempotency, one-file-per-record
- [srm_cli_pattern.md](srm_cli_pattern.md) — srm CLI design: 500ms detection probe, dual-path execution, processId WS filtering, 501 stub pattern, CommonJS output, no external CLI lib
- [web_manager_sqlite_patterns.md](web_manager_sqlite_patterns.md) — SQLite persistence patterns for web-manager: sync driver rationale, db-parameter injection, activeJobRef mutable-ref pattern, stream-json parsing strategy
- [web_manager_queue_patterns.md](web_manager_queue_patterns.md) — job-queueing patterns: QueueManager class rationale, 202 HTTP status, global log buffer decision, tree-kill for process groups
