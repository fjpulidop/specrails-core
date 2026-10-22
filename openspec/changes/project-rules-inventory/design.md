## Context

`init` already writes per-project files under the artifact root (`.specrails/`), and the runtime reads `.specrails/agent-runtime.json` from there. Free provider turns already exist (the engine's `prompt` piece sends `role: 'prompt'`, `instructions: 'none'` through the executor registry), so a one-shot classification needs no new executor machinery.

## Decisions

1. **Determinism first, model last.** Gates and rule statements are found by code; the model only labels ids it was given. `applyClassification` keeps text and source from the parser, accepts the three statuses only, ignores unknown ids and leaves unanswered rules `unclassified`.
2. **Provider from configuration.** The classifier uses `agents.architect` of `.specrails/agent-runtime.json` (read access, `artifacts: none`, at most 4 turns). No configuration, an invalid one, a failed call or a non-JSON reply all degrade to gates plus `unclassified` rules, with the reason in `classification.status`/`reason`. The command always exits 0 once it wrote the file.
3. **Cache by statement.** A rule id hashes the file and the normalized statement, so moving a line keeps its classification and editing it asks again. `init` runs offline and never spends; it still keeps earlier classifications.
4. **Gates as commands.** Every gate carries the command a host can run from the repository root. A script beats a bare config (an ESLint config with a `lint` script yields only the script). Scripted hooks become `sh <hook>`; CI keeps only check-like `run:` steps of workflows triggered by pull requests or pushes, without shell plumbing or expressions.
5. **Offered, not imposed.** Discovered gates reach the architect's verification proposal only when the host configured none, and the architect keeps those that exercise the change and pass today; Core does not add them to the verification plan on its own, because a failing lint on the base would otherwise turn every run into correction rounds.
6. **Human checks stay advisory.** `humanOnly` rules go to the reviewer's brief (`humanChecks`), never to issues, so the approval gate is unchanged.
7. **Lazy executors.** `project-rules.ts` imports the configuration and executors on demand, so prompt and node readers of `rules.json` stay light and `init` loads the module only through a dynamic import.

## Non-Goals

- Enforcing or implementing `automatable` rules (Desktop turns them into specs).
- Parsing instruction files other than `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md`, or rules inside tables and code fences.
- Classifying during `init`.

## Assumptions

- Gate commands are informative: they are never executed by the inventory itself.
- The repository root of the inventory is the artifact repository the runtime names in `artifactRepositoryId`.

## Risks / Trade-offs

- Heuristic parsing can miss a rule or keep a descriptive sentence; the `source` lets a human check, and `--reclassify` redoes the labels.
- A large instruction set is capped at 200 rules per inventory; CI gates at 20.
