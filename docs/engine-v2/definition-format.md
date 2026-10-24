# Definition format and reference workflows

Definitions declare `schemaVersion`, `id`, `title`, `journal`, `change`, `entry`, `maxTransitions`, `roles` and a `nodes` map. Each node declares `kind`, closed `params` and its complete outcome-to-target `ends` map. Components provide reusable scoped bodies; policies bound concurrency, history, no-progress and consecutive failures. Budget caps apply across descendants and physical attempts.

Drafts omit `version`. Publish through `specrails-core runtime workflows validate --stdin --config runtime-config.json`; use `--structural` only to defer role resolution during editing. The result contains the normalized definition and its canonical SHA-256 version. Changing any definition content requires republishing. An existing version must match the supplied content; do not hand-edit hashes.

The examples below are exact regression fixtures. The `fixture` provider is a test dependency, not a production provider. To run an AI example, remove its version, choose a configured provider and role bindings, validate again, then pass the returned definition to `runtime run --context context.json --config runtime-config.json --definition published.json`. Core rejects incompatible scope or roles before inference. The question and condition examples need no provider call.

## Freestyle

The legacy fix loop: write, host verification, then a read-only `loop-decider` decision. A failed check or a continue verdict goes to `fix`; the decider's no-progress limit and `failFast` bound the loop, and success requires verified host evidence. Loops decide with a custom read-only role because the built-in reviewer is an OpenSpec verification role.

```json
{
  "schemaVersion": 1,
  "id": "freestyle",
  "title": "Freestyle",
  "journal": "ledger-only",
  "change": "none",
  "entry": "implement",
  "maxTransitions": 100,
  "roles": [
    "loop-decider"
  ],
  "policies": {
    "failFast": 2,
    "noProgress": 2
  },
  "nodes": {
    "implement": {
      "kind": "prompt",
      "params": {
        "access": "write",
        "engine": {
          "provider": "fixture"
        },
        "sentinel": "blocked",
        "text": "Implement the requested change and report what you changed."
      },
      "ends": {
        "blocked": "failed",
        "failed": "failed",
        "next": "verify"
      }
    },
    "verify": {
      "kind": "verify",
      "params": {
        "commands": "configured"
      },
      "ends": {
        "fail": "fix",
        "failed": "failed",
        "pass": "decide"
      }
    },
    "decide": {
      "kind": "decider",
      "params": {
        "goal": "Stop only when the host checks pass and every acceptance criterion is implemented.",
        "noProgress": 2,
        "roleId": "loop-decider"
      },
      "ends": {
        "continue": "fix",
        "failed": "failed",
        "stop": "done"
      }
    },
    "fix": {
      "kind": "prompt",
      "params": {
        "access": "write",
        "engine": {
          "provider": "fixture"
        },
        "sentinel": "blocked",
        "text": "Repair the reported failures and the remaining acceptance criteria."
      },
      "ends": {
        "blocked": "failed",
        "failed": "failed",
        "next": "verify"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success",
        "requiresVerified": true
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    }
  },
  "version": "f209b867e47af660e14d57bf967d4d542ec5de8c3316f1ee5770314807a09cbb"
}
```

## Quick Sdd

An invalid first preparation gets exactly one repair: `init` sets `artifactRepairs` to 0, and a failed `validate` passes through `repair-guard`/`repair-count` back to `work` once. A second invalid preparation ends in `failed` without another provider call.

```json
{
  "schemaVersion": 1,
  "id": "quick-sdd",
  "title": "Quick Sdd",
  "journal": "ledger-only",
  "change": "new",
  "entry": "init",
  "maxTransitions": 100,
  "roles": [],
  "nodes": {
    "init": {
      "kind": "assign",
      "params": {
        "set": {
          "artifactRepairs": 0
        }
      },
      "ends": {
        "next": "work",
        "failed": "failed"
      }
    },
    "work": {
      "kind": "prompt",
      "params": {
        "engine": {
          "provider": "fixture"
        },
        "nativeCommand": {
          "id": "opsx:ff",
          "args": "{{run.changeId}}"
        },
        "access": "write",
        "sentinel": "blocked"
      },
      "ends": {
        "next": "validate",
        "failed": "failed",
        "blocked": "failed"
      }
    },
    "validate": {
      "kind": "openspec-validate",
      "params": {
        "change": "{{run.changeId}}"
      },
      "ends": {
        "pass": "apply",
        "fail": "repair-guard",
        "failed": "failed"
      }
    },
    "apply": {
      "kind": "prompt",
      "params": {
        "engine": {
          "provider": "fixture"
        },
        "nativeCommand": {
          "id": "opsx:apply",
          "args": "{{run.changeId}}"
        },
        "access": "write",
        "sentinel": "blocked"
      },
      "ends": {
        "next": "check",
        "failed": "failed",
        "blocked": "failed"
      }
    },
    "check": {
      "kind": "verify",
      "params": {
        "commands": "configured"
      },
      "ends": {
        "pass": "archive",
        "fail": "failed",
        "failed": "failed"
      }
    },
    "archive": {
      "kind": "openspec-archive",
      "params": {
        "change": "{{run.changeId}}"
      },
      "ends": {
        "next": "verify",
        "failed": "failed"
      }
    },
    "verify": {
      "kind": "verify",
      "params": {
        "commands": "configured"
      },
      "ends": {
        "pass": "done",
        "fail": "failed",
        "failed": "failed"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success",
        "requiresVerified": true
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    },
    "repair-guard": {
      "kind": "condition",
      "params": {
        "expr": "$vars.artifactRepairs < 1"
      },
      "ends": {
        "true": "repair-count",
        "false": "failed"
      }
    },
    "repair-count": {
      "kind": "assign",
      "params": {
        "increment": {
          "artifactRepairs": 1
        }
      },
      "ends": {
        "next": "work",
        "failed": "failed"
      }
    }
  },
  "version": "a6bd20e682ad6b47f8a9c09379512e26afe3dfdd78b3c40703e355de7e5eb804"
}
```

## Flow Spec

Flow's handoff: the code already exists in a worktree reserved at `repositories[].baseSha`. `derive-change` runs the `deriver` engine role to write the OpenSpec change for that diff, checks coverage, completed tasks, strict validation and the archive preflight, and loops back once with its repair note on `fail`. `verify` binds the deriver's verification proposals through `additionalCommandsFrom`, the built-in reviewer judges the change with the `derivation.json` coverage report (each unexplained file is an issue), and only an approved review reaches `openspec-archive` and the final verification. A reviewer rejection or a failing `check` is not a dead end: it records its findings in `latestFindings` and starts a bounded correction round (`correctionLimit: 2`). `fix` is a `role-turn` of the built-in `developer` with `stance: "fixer"` (write access, the FIXER instructions and the configured fixer engine) that fixes the named defects and adds the tests the findings ask for, tagged `[spec:<capability>/<requirement-slug>]`, without editing `openspec/`. `fix-progress` continues only when the fixer changed the candidate (`$outputs.fix.candidateHash` differs from the hash `check` last verified); `derive` then runs again with `feedback: "{{run.latestFindings}}"` and updates the existing change in place, followed by `check` and a new review. When the fixer changes nothing or the budget is spent, the run ends at `changes-requested`, a failure whose reason names the number of correction rounds and the latest findings. The host writes the bounded conversation summary to `.specrails/pipeline/<runId>/flow-summary.md`; without it the deriver works from the diff alone.

```json
{
  "schemaVersion": 1,
  "id": "flow-spec",
  "title": "Flow Spec",
  "journal": "ledger-only",
  "change": "new",
  "entry": "init",
  "maxTransitions": 100,
  "roles": [
    "deriver",
    "developer",
    "reviewer"
  ],
  "nodes": {
    "init": {
      "kind": "assign",
      "params": {
        "set": {
          "derivationRepairs": 0,
          "correctionRounds": 0,
          "correctionLimit": 2,
          "latestFindings": ""
        }
      },
      "ends": {
        "next": "derive",
        "failed": "failed"
      }
    },
    "derive": {
      "kind": "derive-change",
      "params": {
        "change": "{{run.changeId}}",
        "summaryPath": "flow-summary.md",
        "feedback": "{{run.latestFindings}}"
      },
      "ends": {
        "pass": "check",
        "fail": "repair-guard"
      }
    },
    "repair-guard": {
      "kind": "condition",
      "params": {
        "expr": "$vars.derivationRepairs < 1"
      },
      "ends": {
        "true": "repair-count",
        "false": "failed"
      }
    },
    "repair-count": {
      "kind": "assign",
      "params": {
        "increment": {
          "derivationRepairs": 1
        }
      },
      "ends": {
        "next": "derive",
        "failed": "failed"
      }
    },
    "check": {
      "kind": "verify",
      "params": {
        "commands": "configured",
        "additionalCommandsFrom": "derive"
      },
      "ends": {
        "pass": "review",
        "fail": "check-findings",
        "failed": "failed"
      }
    },
    "check-findings": {
      "kind": "assign",
      "params": {
        "set": {
          "latestFindings": "Host verification failed for the current candidate: {{outputs.check}}"
        }
      },
      "ends": {
        "next": "correction-budget",
        "failed": "failed"
      }
    },
    "review": {
      "kind": "role-turn",
      "params": {
        "roleId": "reviewer",
        "prompt": "Review the derived OpenSpec change against the code that already exists, the verification evidence and the derivation coverage report.",
        "structuredOutput": {
          "type": "object",
          "required": [
            "approved",
            "issues"
          ],
          "properties": {
            "approved": {
              "type": "boolean"
            },
            "issues": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        }
      },
      "ends": {
        "next": "review-policy",
        "invalid": "failed",
        "failed": "failed"
      }
    },
    "review-policy": {
      "kind": "condition",
      "params": {
        "expr": "$outputs.review.structured.approved == true"
      },
      "ends": {
        "true": "archive",
        "false": "review-findings"
      }
    },
    "review-findings": {
      "kind": "assign",
      "params": {
        "set": {
          "latestFindings": "{{outputs.review.structured}}"
        }
      },
      "ends": {
        "next": "correction-budget",
        "failed": "failed"
      }
    },
    "correction-budget": {
      "kind": "condition",
      "params": {
        "expr": "$vars.correctionRounds < $vars.correctionLimit"
      },
      "ends": {
        "true": "begin-correction",
        "false": "changes-requested"
      }
    },
    "begin-correction": {
      "kind": "assign",
      "params": {
        "increment": {
          "correctionRounds": 1
        },
        "set": {
          "derivationRepairs": 0
        }
      },
      "ends": {
        "next": "fix",
        "failed": "failed"
      }
    },
    "fix": {
      "kind": "role-turn",
      "params": {
        "roleId": "developer",
        "stance": "fixer",
        "prompt": "Correct the code Flow built for change {{run.changeId}} so the findings below are resolved. Fix every defect they name. Add or extend the tests they ask for (new test files are allowed for that) and tag each test that demonstrates an ADDED or MODIFIED requirement with [spec:<capability>/<requirement-slug>]. Never expand the scope beyond the findings. Never edit openspec/: Core re-derives the OpenSpec change from the code after this turn. Revert code only when a finding says it is unrequested AND it contradicts a stated Non-Goal. Return summary and incomplete.\n\nFindings:\n{{run.latestFindings}}",
        "structuredOutput": {
          "type": "object",
          "required": [
            "summary",
            "incomplete"
          ],
          "properties": {
            "summary": {
              "type": "string"
            },
            "incomplete": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          }
        },
        "sessionContinuity": "none"
      },
      "ends": {
        "next": "fix-progress",
        "invalid": "failed",
        "failed": "failed"
      }
    },
    "fix-progress": {
      "kind": "condition",
      "params": {
        "expr": "exists($outputs.fix.candidateHash) && $outputs.fix.candidateHash != null && $outputs.fix.candidateHash != $outputs.check.candidateHash"
      },
      "ends": {
        "true": "derive",
        "false": "changes-requested"
      }
    },
    "archive": {
      "kind": "openspec-archive",
      "params": {
        "change": "{{run.changeId}}",
        "requiresVerified": true
      },
      "ends": {
        "next": "verify",
        "failed": "failed"
      }
    },
    "verify": {
      "kind": "verify",
      "params": {
        "commands": "configured",
        "additionalCommandsFrom": "derive"
      },
      "ends": {
        "pass": "done",
        "fail": "failed",
        "failed": "failed"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success",
        "requiresVerified": true
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    },
    "changes-requested": {
      "kind": "end",
      "params": {
        "outcome": "failure",
        "reason": "Flow → Spec: the reviewer requested changes that {{run.correctionRounds}} correction round(s) did not resolve. Latest findings: {{run.latestFindings}}"
      },
      "ends": {}
    }
  },
  "version": "4434e9a51f42e2d93762c7d3539c00f3f2102c064e107c636f6bb261221b5b44"
}
```

## Verify Fix

Runs the configured host checks and repairs real failures with a write prompt, at most twice (`init`, `repair-guard`, `repair-count`), instead of cycling until `maxTransitions`.

```json
{
  "schemaVersion": 1,
  "id": "verify-fix",
  "title": "Verify Fix",
  "journal": "ledger-only",
  "change": "none",
  "entry": "init",
  "maxTransitions": 100,
  "roles": [],
  "nodes": {
    "init": {
      "kind": "assign",
      "params": {
        "set": {
          "repairs": 0
        }
      },
      "ends": {
        "next": "verify",
        "failed": "failed"
      }
    },
    "verify": {
      "kind": "verify",
      "params": {
        "commands": "configured"
      },
      "ends": {
        "pass": "done",
        "fail": "repair-guard",
        "failed": "failed"
      }
    },
    "repair-guard": {
      "kind": "condition",
      "params": {
        "expr": "$vars.repairs < 2"
      },
      "ends": {
        "true": "repair-count",
        "false": "failed"
      }
    },
    "repair-count": {
      "kind": "assign",
      "params": {
        "increment": {
          "repairs": 1
        }
      },
      "ends": {
        "next": "fix",
        "failed": "failed"
      }
    },
    "fix": {
      "kind": "prompt",
      "params": {
        "engine": {
          "provider": "fixture"
        },
        "text": "Repair the actual verification failures, preserving the accepted scope.",
        "access": "write",
        "sentinel": "blocked"
      },
      "ends": {
        "next": "verify",
        "failed": "failed",
        "blocked": "failed"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success",
        "requiresVerified": true
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    }
  },
  "version": "0dbb75de1c191af62c0d5ac7a69abeac66089b5449834a33ec0458fed87a1476"
}
```

## Verified implementation

```json
{
  "schemaVersion": 1,
  "id": "implementation",
  "title": "Verified implementation",
  "journal": "implementation",
  "change": "new",
  "entry": "implement",
  "maxTransitions": 100,
  "roles": [
    "architect",
    "developer",
    "reviewer"
  ],
  "nodes": {
    "implement": {
      "kind": "implementation",
      "params": {
        "approvalBeforeArchive": false
      },
      "ends": {
        "next": "done",
        "rejected": "failed",
        "failed": "failed"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success",
        "requiresVerified": true
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    }
  },
  "version": "e1aea44e144c42fe39ab782e9ce2df6e2253163ee3a1e503a966c2d99aaf45c4"
}
```

## Implementation inside a component

```json
{
  "schemaVersion": 1,
  "id": "implementation-component",
  "title": "Implementation inside a component",
  "journal": "implementation",
  "change": "new",
  "entry": "work",
  "maxTransitions": 100,
  "roles": [
    "architect",
    "developer",
    "reviewer"
  ],
  "nodes": {
    "work": {
      "kind": "component",
      "params": {
        "ref": "work"
      },
      "ends": {
        "next": "verify",
        "failed": "failed"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success",
        "requiresVerified": true
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    },
    "verify": {
      "kind": "verify",
      "params": {
        "commands": "configured"
      },
      "ends": {
        "pass": "done",
        "fail": "failed",
        "failed": "failed"
      }
    }
  },
  "components": {
    "work": {
      "entry": "implement",
      "nodes": {
        "implement": {
          "kind": "implementation",
          "params": {
            "approvalBeforeArchive": false
          },
          "ends": {
            "next": "done",
            "rejected": "failed",
            "failed": "failed"
          }
        },
        "done": {
          "kind": "end",
          "params": {
            "outcome": "success",
            "exit": "next"
          },
          "ends": {}
        },
        "failed": {
          "kind": "end",
          "params": {
            "outcome": "failure",
            "exit": "failed"
          },
          "ends": {}
        }
      }
    }
  },
  "delivery": {
    "requiresVerified": true
  },
  "version": "3ebd003720588211080fe8515e19def7fd7516ff165765162d360839ca015e53"
}
```

## Batch Implementation

```json
{
  "schemaVersion": 1,
  "id": "batch-implementation",
  "title": "Batch Implementation",
  "journal": "implementation",
  "change": "new",
  "entry": "work",
  "maxTransitions": 100,
  "roles": [
    "architect",
    "developer",
    "reviewer"
  ],
  "nodes": {
    "work": {
      "kind": "map",
      "params": {
        "over": "tickets",
        "body": "implementation",
        "concurrency": 2
      },
      "ends": {
        "next": "join"
      }
    },
    "join": {
      "kind": "join",
      "params": {
        "reduce": "all-ok"
      },
      "ends": {
        "next": "verify",
        "fail": "failed"
      }
    },
    "verify": {
      "kind": "verify",
      "params": {
        "commands": "configured"
      },
      "ends": {
        "pass": "done",
        "fail": "failed",
        "failed": "failed"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success",
        "requiresVerified": true
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    }
  },
  "components": {
    "implementation": {
      "entry": "implement",
      "nodes": {
        "implement": {
          "kind": "implementation",
          "params": {
            "approvalBeforeArchive": false
          },
          "ends": {
            "next": "done",
            "rejected": "failed",
            "failed": "failed"
          }
        },
        "done": {
          "kind": "end",
          "params": {
            "outcome": "success",
            "exit": "next"
          },
          "ends": {}
        },
        "failed": {
          "kind": "end",
          "params": {
            "outcome": "failure",
            "exit": "failed"
          },
          "ends": {}
        }
      }
    }
  },
  "delivery": {
    "requiresVerified": true
  },
  "version": "e558d771a4b840478fcee22fb3079e56ba8be7ee188008d937547240aeed46f5"
}
```

## Question and explicit continuation

```json
{
  "change": "none",
  "entry": "check",
  "id": "acceptance-question-flow",
  "journal": "ledger-only",
  "maxTransitions": 20,
  "nodes": {
    "ask": {
      "ends": {
        "next": "done"
      },
      "kind": "question",
      "params": {
        "text": "Continue to completion?"
      }
    },
    "check": {
      "ends": {
        "false": "stopped",
        "true": "ask"
      },
      "kind": "condition",
      "params": {
        "expr": "$vars.stop != true"
      }
    },
    "done": {
      "ends": {},
      "kind": "end",
      "params": {
        "outcome": "success"
      }
    },
    "stopped": {
      "ends": {},
      "kind": "end",
      "params": {
        "outcome": "failure",
        "reason": "stopped_by_fork_patch"
      }
    }
  },
  "roles": [],
  "schemaVersion": 1,
  "title": "Acceptance question flow",
  "version": "5532e3e78215b0a3eeccb1425f02ccd075020972cbefb1f5f800766aa2200e55"
}
```

## Minimal provider-free draft

```json
{
  "schemaVersion": 1,
  "id": "condition-only",
  "title": "Read-only condition",
  "journal": "ledger-only",
  "change": "none",
  "entry": "check",
  "maxTransitions": 5,
  "roles": [],
  "nodes": {
    "check": {
      "kind": "condition",
      "params": {
        "expr": "true"
      },
      "ends": {
        "true": "done",
        "false": "failed"
      }
    },
    "done": {
      "kind": "end",
      "params": {
        "outcome": "success"
      },
      "ends": {}
    },
    "failed": {
      "kind": "end",
      "params": {
        "outcome": "failure"
      },
      "ends": {}
    }
  }
}
```

A decider reaching `noProgress` emits `failed` with `no_progress`, preserving the
model's `continue` verdict in its output. Route that outcome to a failure end or
an explicit repair path. It never takes `stop`: an unchanged candidate is not
proof that the goal is complete. Any repair path remains subject to the run's
transition, budget and verification limits.
