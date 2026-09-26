# Extending the engine

Definitions compose the reviewed registry; they cannot load arbitrary plugins or JavaScript expressions. A new piece is a code change to Core, reviewed and shipped with the package.

1. Define a closed parameter schema, all outcomes, effect, AI requirement and store access in the piece descriptor. Keep validation free of provider and project-store initialization.
2. Implement the piece against narrow injected dependencies. Use the execution context's attempt identity, cancellation signal, progress and interruption operations. Return bounded structured output and an outcome declared by the descriptor.
3. Register the descriptor in both the validation and execution catalogs. Composite pieces need compiler integration rather than calling a graph from an ordinary piece executor.
4. Route inference through the durable invocation port. Preserve provider-reported null usage, reserve shared budget before work and commit the response memo with accounting. Do not implement independent retries around a billed call.
5. Leave effect admission, leases, receipt invalidation and terminal events with their existing owners. Never hold a parent permit while waiting for a child that needs it.
6. Test validation rejection, success, interruption, retry classification, cancellation and durable reopen with the actual compiler and saver. Add installed-package tests when public exports or resource loading change.
7. Update the catalog version when its compatibility contract changes, regenerate the descriptor reference and validate complete documentation definitions. Update the paired Desktop catalog adapter and authoring UI.

The public SDK is `specrails-core/agent-runtime/engine`; the packaged schema is `specrails-core/schemas/workflow-definition.schema.json`. Use the reviewed public exports rather than importing private adapters from `dist`. Providers continue to use the existing executor strategies, and custom roles declare source access, artifact access and optional OpenSpec binding explicitly.
