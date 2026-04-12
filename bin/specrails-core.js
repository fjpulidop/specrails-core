#!/usr/bin/env node

const { spawnSync } = require("child_process");
const { resolve } = require("path");

const ROOT = resolve(__dirname, "..");
const COMMANDS = {
  init: "install.sh",
  update: "update.sh",
  doctor: "bin/doctor.sh",
  "perf-check": "bin/perf-check.sh",
  enrich: null,
  version: null,
};

const args = process.argv.slice(2);
const subcommand = args[0];

// ─── Global --version / -V flag ──────────────────────────────────────────────

if (args.includes("--version") || args.includes("-V")) {
  const pkg = require(resolve(ROOT, "package.json"));
  console.log(`specrails-core v${pkg.version}`);
  process.exit(0);
}

if (!subcommand) {
  console.log(`specrails-core — Agent Workflow System for Claude Code

Usage:
  specrails-core init       [--root-dir <path>] [--yes|-y]   Install into a repository
  specrails-core update     [--only <component>]             Update an existing installation
  specrails-core doctor                                      Run health checks
  specrails-core perf-check [--files <list>]                 Performance regression check (CI)
  specrails-core enrich     [--from-config <path>]           Run /specrails:enrich via Claude CLI
  specrails-core version                                     Show installed version

Flags for init:
  --root-dir <path>   Target repository path (default: current directory)
  --yes | -y          Non-interactive; use defaults, skip TUI
  --provider <value>  Force provider: claude or codex
  --no-direct         Skip TUI; use the legacy interactive bash installer
  --from-config       Skip TUI; use existing .specrails/install-config.yaml

Global flags:
  --version | -V    Show installed version

More info: https://github.com/fjpulidop/specrails-core`);
  process.exit(0);
}

if (!(subcommand in COMMANDS)) {
  console.error(`Unknown command: ${subcommand}\n`);
  console.error("Available commands: init, update, doctor, perf-check, enrich, version");
  process.exit(1);
}

const script = COMMANDS[subcommand];

// Allowlisted flags per subcommand
const ALLOWED_FLAGS = {
  init: ["--root-dir", "--yes", "-y", "--provider", "--no-direct", "--from-config", "--quick", "--hub-json", "--agent-teams"],
  update: ["--only"],
  doctor: [],
  "perf-check": ["--files", "--context"],
  enrich: ["--from-config", "--quick"],
  version: [],
};

const subargs = args.slice(1);
const allowed = ALLOWED_FLAGS[subcommand] ?? [];

for (const arg of subargs) {
  if (arg.startsWith("-") && !allowed.includes(arg)) {
    console.error(`Unknown flag: ${arg}`);
    process.exit(1);
  }
}

// ─── version subcommand ──────────────────────────────────────────────────────

if (subcommand === "version") {
  const pkg = require(resolve(ROOT, "package.json"));
  console.log(`specrails-core v${pkg.version}`);
  process.exit(0);
}

// ─── enrich subcommand ───────────────────────────────────────────────────────
// Launches `claude --command "/specrails:enrich [flags]"` so the AI-powered
// enrichment runs inside Claude Code with full model access.

if (subcommand === "enrich") {
  const enrichFlags = subargs.join(" ");
  const claudeCmd = `/specrails:enrich${enrichFlags ? " " + enrichFlags : ""}`;
  const claudeResult = spawnSync("claude", ["--command", claudeCmd, "--dangerously-skip-permissions"], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  if (claudeResult.error) {
    console.error(
      "\nFailed to launch Claude CLI for enrich:",
      claudeResult.error.message,
      "\nEnsure Claude Code is installed: npm install -g @anthropic-ai/claude-code\n"
    );
    process.exit(1);
  }

  process.exit(claudeResult.status ?? (claudeResult.error ? 1 : 0));
}

// ─── Direct mode (TUI) for `init` ─────────────────────────────────────────────
//
// Default behaviour: run the Node.js TUI to collect agent/model configuration,
// write .specrails/install-config.yaml, then hand off to install.sh.
//
// Opt-out with: --no-direct   (legacy interactive bash installer)
//               --from-config (config already on disk; skip TUI)
//               --yes / -y    (write default config, no prompts)

const isInit       = subcommand === "init";
const hasNoTui     = subargs.includes("--no-direct") || subargs.includes("--from-config");
const autoYes      = subargs.includes("--yes") || subargs.includes("-y");
const useTui       = isInit && !hasNoTui;

if (useTui) {
  // Resolve the target directory for the TUI
  const rootDirIdx = subargs.indexOf("--root-dir");
  const rootDir    = rootDirIdx >= 0 ? resolve(subargs[rootDirIdx + 1]) : process.cwd();

  // Build TUI args: pass rootDir + --yes if set
  const tuiArgs = [resolve(ROOT, "bin/tui-installer.mjs"), rootDir];
  if (autoYes) tuiArgs.push("--yes");

  const tuiResult = spawnSync("node", tuiArgs, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  if (tuiResult.error) {
    // @inquirer/prompts not installed (e.g. during development without npm install)
    console.error(
      "\nFailed to launch TUI installer:",
      tuiResult.error.message,
      "\nRun: npm install   or use --no-direct for the legacy installer.\n"
    );
    process.exit(1);
  }

  if (tuiResult.status !== 0) {
    process.exit(tuiResult.status ?? 1);
  }

  // TUI succeeded — run install.sh with --from-config so it reads provider/
  // agent_teams from install-config.yaml rather than prompting interactively.
  const installArgs = subargs
    .filter(a => a !== "--no-direct") // strip internal flags
    .concat(["--yes", "--from-config"]);

  const result = spawnSync("bash", [resolve(ROOT, script), ...installArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  process.exit(result.status ?? (result.error ? 1 : 0));
}

// ─── Legacy / non-TUI path ────────────────────────────────────────────────────

// Strip only --no-direct (internal flag) before passing args to the shell script
const cleanArgs = subargs.filter(a => a !== "--no-direct");

const result = spawnSync("bash", [resolve(ROOT, script), ...cleanArgs], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? (result.error ? 1 : 0));
