#!/usr/bin/env node

const { execSync } = require("child_process");
const { resolve } = require("path");

const ROOT = resolve(__dirname, "..");
const COMMANDS = {
  init: "install.sh",
  update: "update.sh",
};

const args = process.argv.slice(2);
const subcommand = args[0];

if (!subcommand) {
  console.log(`specrails-core — Agent Workflow System for Claude Code

Usage:
  specrails-core init   [--root-dir <path>]     Install into a repository
  specrails-core update [--only <component>]    Update an existing installation

More info: https://github.com/fjpulidop/specrails-core`);
  process.exit(0);
}

const script = COMMANDS[subcommand];

if (!script) {
  console.error(`Unknown command: ${subcommand}\n`);
  console.error("Available commands: init, update");
  process.exit(1);
}

const forwarded = args.slice(1).join(" ");
const cmd = `bash "${resolve(ROOT, script)}" ${forwarded}`.trim();

try {
  execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
} catch (err) {
  process.exit(err.status || 1);
}
