# Definition format and reference workflows

Definitions declare `schemaVersion`, `id`, `title`, `journal`, `change`, `entry`, `maxTransitions`, `roles` and a `nodes` map. Each node declares `kind`, closed `params` and its complete outcome-to-target `ends` map. Components provide reusable scoped bodies; policies bound concurrency, history, no-progress and consecutive failures. Budget caps apply across descendants and physical attempts.

Drafts omit `version`. Publish through `specrails-core runtime workflows validate --stdin --config runtime-config.json`; use `--structural` only to defer role resolution during editing. The result contains the normalized definition and its canonical SHA-256 version. Changing any definition content requires republishing. An existing version must match the supplied content; do not hand-edit hashes.

The examples below are exact regression fixtures. The `fixture` provider is a test dependency, not a production provider. To run an AI example, remove its version, choose a configured provider and role bindings, validate again, then pass the returned definition to `runtime run --context context.json --config runtime-config.json --definition published.json`. Core rejects incompatible scope or roles before inference. The question and condition examples need no provider call.

## Freestyle

```json
{
  "schemaVersion": 1,
  "id": "freestyle",
  "title": "Freestyle",
  "journal": "ledger-only",
  "change": "none",
  "entry": "work",
  "maxTransitions": 100,
  "roles": [],
  "nodes": {
    "work": {
      "kind": "prompt",
      "params": {
        "engine": {
          "provider": "fixture"
        },
        "text": "Inspect the project and report your findings.",
        "access": "read"
      },
      "ends": {
        "next": "done",
        "failed": "failed"
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
  },
  "version": "cf93567154b74e166a95e67fb2f05e1b671f15eba3ac497d7bad6344498c1748"
}
```

## Quick Sdd

```json
{
  "schemaVersion": 1,
  "id": "quick-sdd",
  "title": "Quick Sdd",
  "journal": "ledger-only",
  "change": "new",
  "entry": "work",
  "maxTransitions": 100,
  "roles": [],
  "nodes": {
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
        "access": "write"
      },
      "ends": {
        "next": "validate",
        "failed": "failed"
      }
    },
    "validate": {
      "kind": "openspec-validate",
      "params": {
        "change": "{{run.changeId}}"
      },
      "ends": {
        "pass": "apply",
        "fail": "failed",
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
        "access": "write"
      },
      "ends": {
        "next": "check",
        "failed": "failed"
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
    }
  },
  "version": "7753bfa668f2ccabfcea83c1fbe52fe40883788e8a288ef57cd4ca168ed71c8b"
}
```

## Verify Fix

```json
{
  "schemaVersion": 1,
  "id": "verify-fix",
  "title": "Verify Fix",
  "journal": "ledger-only",
  "change": "none",
  "entry": "verify",
  "maxTransitions": 100,
  "roles": [
    "developer"
  ],
  "nodes": {
    "verify": {
      "kind": "verify",
      "params": {
        "commands": "configured"
      },
      "ends": {
        "pass": "done",
        "fail": "fix",
        "failed": "failed"
      }
    },
    "fix": {
      "kind": "role-turn",
      "params": {
        "roleId": "developer",
        "prompt": "Repair the actual verification failures, preserving the accepted scope."
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
    }
  },
  "version": "470a81ee0ecd22e41b4bacbe3c48fe9e05a48799c15f4b77cc36443d177a281e"
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
