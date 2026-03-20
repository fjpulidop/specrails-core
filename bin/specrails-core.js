#!/usr/bin/env node

const { spawnSync } = require("child_process");
const { resolve } = require("path");

const ROOT = resolve(__dirname, "..");
const COMMANDS = {
  init: "install.sh",
  update: "update.sh",
  doctor: "bin/doctor.sh",
};

const args = process.argv.slice(2);
const subcommand = args[0];

if (!subcommand) {
  console.log(`specrails-core — Agent Workflow System for Claude Code

Usage:
  specrails-core init   [--root-dir <path>]     Install into a repository
  specrails-core update [--only <component>]    Update an existing installation
  specrails-core doctor                         Run health checks

More info: https://github.com/fjpulidop/specrails-core`);
  process.exit(0);
}

const script = COMMANDS[subcommand];

if (!script) {
  console.error(`Unknown command: ${subcommand}\n`);
  console.error("Available commands: init, update, doctor");
  process.exit(1);
}

const result = spawnSync("bash", [resolve(ROOT, script), ...args.slice(1)], {
  stdio: "inherit",
  cwd: process.cwd(),
});

process.exit(result.status ?? (result.error ? 1 : 0));
