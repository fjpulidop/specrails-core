#!/usr/bin/env node
/**
 * specrails TUI installer — Phase 1
 * Interactive agent selection + model configuration using @inquirer/prompts.
 * Writes .specrails/install-config.yaml to the target repo directory.
 *
 * Usage: node bin/tui-installer.mjs [rootDir] [--yes]
 *   rootDir  - target repo directory (default: cwd)
 *   --yes    - skip TUI, write defaults immediately
 */

import { checkbox, select, Separator } from '@inquirer/prompts';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// ─── Alternate screen buffer (fullscreen mode) ──────────────────────────────

function enterFullscreen() {
  process.stdout.write('\x1b[?1049h'); // switch to alternate screen buffer
  process.stdout.write('\x1b[H');      // move cursor to top-left
}

function exitFullscreen() {
  process.stdout.write('\x1b[?1049l'); // restore original screen buffer
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor to top
}

// ─── Agent registry ───────────────────────────────────────────────────────────

const AGENTS = [
  // Architecture
  { id: 'sr-architect',          category: 'Architecture', description: 'Architecture design, change specs, implementation planning' },
  // Development
  { id: 'sr-developer',          category: 'Development',  description: 'Full-stack implementation across all layers' },
  { id: 'sr-frontend-developer', category: 'Development',  description: 'Frontend implementation (React, Vue, Angular, etc.)' },
  { id: 'sr-backend-developer',  category: 'Development',  description: 'Backend specialization (APIs, databases, services)' },
  // Review
  { id: 'sr-reviewer',           category: 'Review',       description: 'General code review — the final quality gate' },
  { id: 'sr-frontend-reviewer',  category: 'Review',       description: 'Frontend review (UI, accessibility, performance)' },
  { id: 'sr-backend-reviewer',   category: 'Review',       description: 'Backend review (APIs, security, scalability)' },
  { id: 'sr-security-reviewer',  category: 'Review',       description: 'Security analysis — OWASP, vulnerabilities, hardening' },
  { id: 'sr-performance-reviewer', category: 'Review',     description: 'Performance analysis — profiling, bottlenecks, optimization' },
  // Product
  { id: 'sr-product-manager',    category: 'Product',      description: 'Product discovery, VPC personas, backlog management' },
  { id: 'sr-product-analyst',    category: 'Product',      description: 'Backlog analysis, spec gap analysis, reporting' },
  // Utilities
  { id: 'sr-test-writer',        category: 'Utilities',    description: 'Comprehensive test generation (unit, integration, E2E)' },
  { id: 'sr-doc-sync',           category: 'Utilities',    description: 'Documentation sync — keeps docs aligned with code' },
  { id: 'sr-merge-resolver',     category: 'Utilities',    description: 'Merge conflict resolution with context awareness' },
];

const ALL_AGENT_IDS = AGENTS.map(a => a.id);

// Core agents — the three that every install requires. The implement
// pipeline depends on exactly these three. All other agents (including
// sr-merge-resolver) are optional add-ons selected by the user.
const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
]);

// Only the three CORE agents are pre-selected. Optional agents (sr-merge-resolver,
// product manager, test writer, layer specialists, reviewers, utilities) are
// opt-in so the default install is as lean as possible. Users can add optional
// agents via `/specrails:enrich` or by re-running init.
const DEFAULT_SELECTED = new Set([
  ...CORE_AGENTS,
]);

// ─── Model presets (Claude only — see PROVIDER_DEFAULT_MODEL) ────────────────────
// Claude has real cost/quality tiers (sonnet/haiku/opus). Codex and gemini are
// single-model in the scaffold (it hardcodes the per-agent model and ignores the
// install-config preset), so these presets apply to Claude only.

const MODEL_PRESETS = {
  balanced: {
    label:       'Balanced (recommended) — Sonnet for all agents',
    defaults:    'sonnet',
    overrides:   {},
  },
  budget: {
    label:       'Budget — Haiku for all agents (3× cheaper, faster)',
    defaults:    'haiku',
    overrides:   {},
  },
  max: {
    label:       'Max quality — Opus for architect + PM, Sonnet for rest',
    defaults:    'sonnet',
    overrides:   { 'sr-architect': 'opus', 'sr-product-manager': 'opus' },
  },
};

// Per-provider default agent model. For codex/gemini the scaffold hardcodes this
// (the install-config model is advisory), so the TUI writes the provider's real
// model instead of a Claude-flavoured preset. Keep in sync with scaffold.ts
// (GEMINI_DEFAULT_MODEL / the codex config.toml model).
const PROVIDER_DEFAULT_MODEL = {
  claude: 'sonnet',
  codex:  'gpt-5.5-mini',
  gemini: 'gemini-3.5-flash',
};

// ─── Provider registry ─────────────────────────────────────────────────────────
// Single source of truth for the AI CLIs the TUI can target. Add a provider here
// and it flows through detection, the --provider flag, and the interactive picker.
const PROVIDERS = [
  { id: 'claude', label: 'Claude Code (recommended)', versionCmd: 'claude --version', installLabel: 'Claude Code', installUrl: 'https://claude.ai/download' },
  { id: 'codex',  label: 'Codex (OpenAI)',            versionCmd: 'codex --version',  installLabel: 'Codex CLI',   installUrl: 'https://developers.openai.com/codex' },
  { id: 'gemini', label: 'Gemini CLI (Google)',       versionCmd: 'gemini --version', installLabel: 'Gemini CLI',  installUrl: 'https://github.com/google-gemini/gemini-cli' },
];
const VALID_PROVIDER_IDS = new Set(PROVIDERS.map(p => p.id));

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns the set of provider ids whose CLI responds to `<bin> --version`.
function detectInstalledProviders() {
  const installed = new Set();
  for (const p of PROVIDERS) {
    try { execSync(p.versionCmd, { stdio: 'ignore' }); installed.add(p.id); } catch { /* not installed */ }
  }
  return installed;
}

// Parse `--provider <id>` or `--provider=<id>` from process.argv. Returns a valid
// provider id or null (unknown values warn-then-null so the TUI falls back to the
// interactive picker).
function parseProviderArg() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider' && args[i + 1]) {
      const v = args[i + 1].trim().toLowerCase();
      return VALID_PROVIDER_IDS.has(v) ? v : null;
    }
    if (a.startsWith('--provider=')) {
      const v = a.slice('--provider='.length).trim().toLowerCase();
      return VALID_PROVIDER_IDS.has(v) ? v : null;
    }
  }
  return null;
}

function detectGitRoot(dir) {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return dir;
  }
}

function buildCheckboxChoices() {
  const choices = [];
  let currentCategory = null;
  for (const agent of AGENTS) {
    if (agent.category !== currentCategory) {
      if (currentCategory !== null) choices.push(new Separator(''));
      choices.push(new Separator(`── ${agent.category} ${'─'.repeat(Math.max(0, 46 - agent.category.length))}`));
      currentCategory = agent.category;
    }
    const isCore = CORE_AGENTS.has(agent.id);
    choices.push({
      value:   agent.id,
      name:    `${agent.id.padEnd(28)} ${agent.description}${isCore ? ' (core)' : ''}`,
      checked: DEFAULT_SELECTED.has(agent.id),
      disabled: isCore ? 'core — always installed' : false,
    });
  }
  return choices;
}

function writeInstallConfig(specrailsDir, cfg) {
  if (!existsSync(specrailsDir)) mkdirSync(specrailsDir, { recursive: true });

  const overridesEntries = Object.entries(cfg.modelOverrides);
  const overridesYaml   = overridesEntries.length > 0
    ? '\n' + overridesEntries.map(([k, v]) => `    ${k}: ${v}`).join('\n')
    : ' {}';

  const yaml = [
    '# specrails install config — generated by TUI installer',
    '# Re-run: npx specrails-core@latest init  to regenerate',
    `version: 1`,
    `provider: ${cfg.provider}`,
    `tier: ${cfg.tier}`,
    `agents:`,
    `  selected: [${cfg.selectedAgents.join(', ')}]`,
    `  excluded: [${cfg.excludedAgents.join(', ')}]`,
    `models:`,
    `  preset: ${cfg.modelPreset}`,
    `  defaults: { model: ${cfg.modelDefaults} }`,
    `  overrides:${overridesYaml}`,
    `agent_teams: ${cfg.agentTeams}`,
    '',
  ].join('\n');

  writeFileSync(resolve(specrailsDir, 'install-config.yaml'), yaml, 'utf8');
}

function writeDefaultConfig(specrailsDir, provider) {
  const defaultSelected = [...DEFAULT_SELECTED];
  const defaultExcluded = ALL_AGENT_IDS.filter(id => !DEFAULT_SELECTED.has(id));
  writeInstallConfig(specrailsDir, {
    provider,
    tier:           'full',
    selectedAgents: defaultSelected,
    excludedAgents: defaultExcluded,
    modelPreset:    'balanced',
    modelDefaults:  PROVIDER_DEFAULT_MODEL[provider] ?? 'sonnet',
    modelOverrides: {},
    agentTeams:     false,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const rawArgs  = process.argv.slice(2);
  const autoYes  = rawArgs.includes('--yes') || rawArgs.includes('-y');
  const withProfiles = rawArgs.includes('--with-profiles');
  // First positional arg (skipping flag values that follow `--provider`,
  // `--root-dir`, etc.) is the target directory.
  const FLAGS_WITH_VALUES = new Set(['--provider', '--root-dir', '--from-config']);
  let rootArg;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a.startsWith('-')) {
      if (FLAGS_WITH_VALUES.has(a)) i++; // skip its value
      continue;
    }
    rootArg = a;
    break;
  }
  const inputDir = rootArg ? resolve(rootArg) : process.cwd();
  // Use inputDir directly — matches the Node CLI step that reads back
  // install-config.yaml from `<inputDir>/.specrails/`. We deliberately do
  // NOT walk up to a git root here: if the user wants the install to land
  // at a git ancestor, they can pass `--root-dir <path>` explicitly, and
  // the Node CLI will honour the same path. Otherwise TUI + Node CLI must
  // agree on the same directory or the config gets stranded.
  const rootDir = inputDir;

  const specrailsDir = resolve(rootDir, '.specrails');

  // Optional: scaffold .specrails/profiles/project-default.json from the shipped template.
  // Off by default to keep standalone installs zero-noise.
  if (withProfiles) {
    try {
      const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const scriptDir = new URL('..', import.meta.url).pathname;
      const templatePath = resolve(scriptDir, 'templates/profiles/default.json');
      const profilesDir = resolve(specrailsDir, 'profiles');
      const targetPath = resolve(profilesDir, 'project-default.json');
      if (existsSync(templatePath) && !existsSync(targetPath)) {
        mkdirSync(profilesDir, { recursive: true });
        writeFileSync(targetPath, readFileSync(templatePath));
        console.log(`  ✓ Profile scaffolded at .specrails/profiles/project-default.json`);
      } else if (existsSync(targetPath)) {
        console.log(`  ↷ Profile already exists at .specrails/profiles/project-default.json — skipped`);
      }
    } catch (e) {
      console.warn(`  ⚠  Could not scaffold profile: ${e.message}`);
    }
  }

  // Auto-yes: write defaults and exit (no TUI needed)
  //
  // Honours an explicit --provider <id> argv flag when present; otherwise
  // picks claude → codex → first-detected. Errors only when none detected.
  if (autoYes) {
    const installed = detectInstalledProviders();
    const argvProvider = parseProviderArg();
    let provider;
    if (argvProvider) {
      if (!installed.has(argvProvider)) {
        const p = PROVIDERS.find(x => x.id === argvProvider);
        console.error('');
        console.error(`  ⚠  --provider ${argvProvider} requested but ${p.installLabel} is not installed.`);
        console.error(`     Install: ${p.installUrl}`);
        console.error('');
        process.exit(1);
      }
      provider = argvProvider;
    } else {
      // No flag: pick the first installed provider in registry order.
      provider = PROVIDERS.find(p => installed.has(p.id))?.id;
      if (!provider) {
        console.error('');
        console.error('  ⚠  No supported AI CLI detected on PATH (Claude Code, Codex, or Gemini CLI).');
        for (const p of PROVIDERS) console.error(`     Install ${p.installLabel}: ${p.installUrl}`);
        console.error('');
        process.exit(1);
      }
    }
    writeDefaultConfig(specrailsDir, provider);
    console.log(`  ✓ Default config written to .specrails/install-config.yaml`);
    console.log(`  ✓ Provider: ${provider}, Tier: full, Agents: ${DEFAULT_SELECTED.size}/${ALL_AGENT_IDS.length}, Preset: balanced\n`);
    return;
  }

  // ── Enter fullscreen ────────────────────────────────────────────────────────

  enterFullscreen();

  // Ensure we exit fullscreen on any exit path
  const _exitFs = () => exitFullscreen();
  process.on('exit', _exitFs);

  const cols = process.stdout.columns || 80;
  const banner = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║           specrails — Agent Workflow Installer              ║',
    '║       Configure your AI agent workflow system               ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    `  Target: ${rootDir}`,
    `  ${'─'.repeat(Math.min(cols - 4, 60))}`,
    '',
  ];
  console.log(banner.join('\n'));

  // ── Step 1: Provider ────────────────────────────────────────────────────────

  const installed = detectInstalledProviders();
  const argvProvider = parseProviderArg();
  let provider;

  if (argvProvider) {
    if (!installed.has(argvProvider)) {
      exitFullscreen();
      const p = PROVIDERS.find(x => x.id === argvProvider);
      console.error(`\n  ⚠  --provider ${argvProvider} requested but ${p.installLabel} is not installed.\n     Install: ${p.installUrl}\n`);
      process.exit(1);
    }
    provider = argvProvider;
    console.log(`  → Provider: ${provider} (from --provider flag)\n`);
  } else {
    const detected = PROVIDERS.filter(p => installed.has(p.id));
    if (detected.length > 1) {
      provider = await select({
        message: 'Which AI provider will you use?',
        choices: detected.map(p => ({ value: p.id, name: p.label })),
      });
    } else if (detected.length === 1) {
      provider = detected[0].id;
      console.log(`  → Provider: ${provider} (auto-detected)\n`);
    } else {
      // None detected — still offer the full list (a CLI may work despite a
      // failed --version probe, e.g. a PATH quirk).
      provider = await select({
        message: 'No AI CLI detected on PATH — which will you use?',
        choices: PROVIDERS.map(p => ({ value: p.id, name: p.label })),
      });
    }
  }

  // ── Step 2: Installation tier ───────────────────────────────────────────────

  clearScreen();
  console.log(`  Provider: ${provider}\n`);

  const tier = await select({
    message: 'Installation tier:',
    default: 'quick',
    choices: [
      {
        value:       'quick',
        name:        'Quick — Ready to use immediately (recommended)',
        description: 'Agents installed with sensible defaults. No AI step required.',
      },
      {
        value:       'full',
        name:        'Full — AI-powered setup',
        description: 'After install, run /specrails:enrich to AI-customize all agents for your codebase',
      },
    ],
  });

  // ── Step 3: Agent selection ─────────────────────────────────────────────────

  clearScreen();
  console.log(`  Provider: ${provider}  |  Tier: ${tier}\n`);
  console.log('  Select agents to install.  Space = toggle,  a = all/none,  Enter = confirm.\n');

  // Use most of the terminal height for agent list (reserve 6 lines for header/footer)
  const termRows = process.stdout.rows || 24;
  const agentPageSize = Math.max(10, termRows - 6);

  const userSelected = await checkbox({
    message: 'Agents to install:',
    choices: buildCheckboxChoices(),
    pageSize: agentPageSize,
    // Core agents are installed unconditionally (disabled rows above), so an
    // empty optional selection is valid — means "only core, nothing extra".
  });

  // Core agents are always included regardless of checkbox state
  const selectedAgents = [...new Set([...CORE_AGENTS, ...userSelected])];
  const excludedAgents = ALL_AGENT_IDS.filter(id => !selectedAgents.includes(id));

  // ── Step 4: Model preset ────────────────────────────────────────────────────

  clearScreen();
  console.log(`  Provider: ${provider}  |  Tier: ${tier}  |  Agents: ${selectedAgents.length}/${ALL_AGENT_IDS.length}\n`);

  // Claude exposes real model tiers; codex/gemini are single-model in the scaffold,
  // so skip the (Claude-flavoured) preset picker for them and use the fixed model.
  let modelPreset = 'balanced';
  let modelDefaults = PROVIDER_DEFAULT_MODEL[provider] ?? 'sonnet';
  let modelOverrides = {};
  if (provider === 'claude') {
    modelPreset = await select({
      message: 'Model configuration:',
      choices: Object.entries(MODEL_PRESETS).map(([key, val]) => ({
        value:       key,
        name:        `${key.padEnd(10)} ${val.label}`,
      })),
    });
    ({ defaults: modelDefaults, overrides: modelOverrides } = MODEL_PRESETS[modelPreset]);
  } else {
    console.log(`  → Model: ${modelDefaults}  (${provider} uses one model for all agents)\n`);
  }

  // ── Step 5: Agent Teams (Claude only) ──────────────────────────────────────

  clearScreen();
  console.log(`  Provider: ${provider}  |  Tier: ${tier}  |  Agents: ${selectedAgents.length}  |  Preset: ${modelPreset}\n`);

  let agentTeams = false;
  if (provider === 'claude') {
    agentTeams = await select({
      message: 'Install Agent Teams commands? (experimental)',
      choices: [
        { value: false, name: 'No  — standard single-agent workflow (recommended)' },
        { value: true,  name: 'Yes — /specrails:team-review and :team-debug  (requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)' },
      ],
    });
  }

  // ── Write config & exit fullscreen ──────────────────────────────────────────

  exitFullscreen();

  writeInstallConfig(specrailsDir, {
    provider,
    tier,
    selectedAgents,
    excludedAgents,
    modelPreset,
    modelDefaults,
    modelOverrides,
    agentTeams,
  });

  console.log(`\n  ✓ Config written to .specrails/install-config.yaml`);
  console.log(`  ✓ Provider: ${provider} | Tier: ${tier} | Agents: ${selectedAgents.length}/${ALL_AGENT_IDS.length} | Preset: ${modelPreset}`);
  if (tier === 'full') {
    console.log(`\n  Next: run /specrails:enrich --from-config inside ${provider} to AI-customize your agents.\n`);
  } else {
    console.log(`\n  Agents will be installed with template defaults.\n`);
  }
}

run().catch(err => {
  exitFullscreen();
  // Graceful Ctrl+C handling
  if (err.name === 'ExitPromptError' || (err.message && err.message.includes('User force closed'))) {
    console.error('\n  Installation cancelled by user.\n');
    process.exit(130);
  }
  console.error('\n  TUI error:', err.message);
  process.exit(1);
});
