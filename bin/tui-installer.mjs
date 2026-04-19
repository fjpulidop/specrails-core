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

// Core agents are always installed and cannot be deselected.
// The implementation pipeline (implement / batch-implement) depends on them.
const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
  'sr-merge-resolver',
]);

const DEFAULT_SELECTED = new Set([
  ...CORE_AGENTS,
  'sr-test-writer',
  'sr-product-manager',
]);

// ─── Model presets (provider-aware) ───────────────────────────────────────────
//
// Each preset resolves to a DIFFERENT concrete model per provider. The UI label
// is provider-agnostic so Codex users don't see "Sonnet"/"Opus" in the menu.
// The resolved preset is written to install-config.yaml with the concrete model
// id for the active provider — never a short alias like `sonnet`.
//
// Taxonomy (must stay in sync with specrails-hub):
//
//   CLAUDE:
//     balanced: claude-sonnet-4-6            (default)
//     budget:   claude-haiku-4-5-20251001
//     max:      claude-sonnet-4-6            (non-special agents)
//     max architect/pm: claude-opus-4-7
//
//   CODEX (GPT-5.x lineup — https://developers.openai.com/codex/models):
//     balanced: gpt-5.4
//     budget:   gpt-5.4-mini
//     max:      gpt-5.4                      (non-special agents)
//     max architect/pm: gpt-5.3-codex

const MODEL_PRESETS = {
  balanced: {
    label: 'Balanced (recommended) — mid-tier model for all agents',
    perProvider: {
      claude: { defaults: 'claude-sonnet-4-6',          overrides: {} },
      codex:  { defaults: 'gpt-5.4',                    overrides: {} },
    },
  },
  budget: {
    label: 'Budget — small/fast model for all agents (cheaper, faster)',
    perProvider: {
      claude: { defaults: 'claude-haiku-4-5-20251001', overrides: {} },
      codex:  { defaults: 'gpt-5.4-mini',               overrides: {} },
    },
  },
  max: {
    label: 'Max quality — top model for architect + PM, mid-tier for the rest',
    perProvider: {
      claude: {
        defaults:  'claude-sonnet-4-6',
        overrides: { 'sr-architect': 'claude-opus-4-7', 'sr-product-manager': 'claude-opus-4-7' },
      },
      codex: {
        defaults:  'gpt-5.4',
        overrides: { 'sr-architect': 'gpt-5.3-codex', 'sr-product-manager': 'gpt-5.3-codex' },
      },
    },
  },
};

/**
 * Resolve a preset key to concrete `{ defaults, overrides }` for a given provider.
 * Exported-style helper so install.sh / enrich.md can mirror identical logic.
 */
function resolvePreset(presetKey, provider) {
  const preset = MODEL_PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown preset: ${presetKey}`);
  const per = preset.perProvider[provider] || preset.perProvider.claude;
  return { defaults: per.defaults, overrides: { ...per.overrides } };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectProvider() {
  let hasClaude = false;
  let hasCodex  = false;
  try { execSync('claude --version', { stdio: 'ignore' }); hasClaude = true; } catch { /* not installed */ }
  try { execSync('codex --version',  { stdio: 'ignore' }); hasCodex  = true; } catch { /* not installed */ }
  return { hasClaude, hasCodex };
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
  const { defaults, overrides } = resolvePreset('balanced', provider);
  writeInstallConfig(specrailsDir, {
    provider,
    tier:           'full',
    selectedAgents: defaultSelected,
    excludedAgents: defaultExcluded,
    modelPreset:    'balanced',
    modelDefaults:  defaults,
    modelOverrides: overrides,
    agentTeams:     false,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const rawArgs  = process.argv.slice(2);
  const autoYes  = rawArgs.includes('--yes') || rawArgs.includes('-y');
  const rootArg  = rawArgs.find(a => !a.startsWith('-'));
  const inputDir = rootArg ? resolve(rootArg) : process.cwd();
  const rootDir  = detectGitRoot(inputDir);

  const specrailsDir = resolve(rootDir, '.specrails');

  // Auto-yes: write defaults and exit (no TUI needed)
  if (autoYes) {
    const { hasClaude, hasCodex } = detectProvider();
    const provider = hasCodex && !hasClaude ? 'codex' : 'claude';
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

  const { hasClaude, hasCodex } = detectProvider();
  let provider;

  if (hasClaude && hasCodex) {
    provider = await select({
      message: 'Which AI provider will you use?',
      choices: [
        { value: 'claude', name: 'Claude Code (recommended)' },
        { value: 'codex',  name: 'Codex' },
      ],
    });
  } else if (hasCodex) {
    provider = 'codex';
    console.log('  → Provider: codex (auto-detected)\n');
  } else {
    provider = 'claude';
    if (hasClaude) {
      console.log('  → Provider: claude (auto-detected)\n');
    } else {
      console.log('  → Provider: claude (default — claude CLI not found, install it at claude.ai/download)\n');
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
    validate: (selected) => selected.length > 0 || 'Select at least one agent.',
  });

  // Core agents are always included regardless of checkbox state
  const selectedAgents = [...new Set([...CORE_AGENTS, ...userSelected])];
  const excludedAgents = ALL_AGENT_IDS.filter(id => !selectedAgents.includes(id));

  // ── Step 4: Model preset ────────────────────────────────────────────────────

  clearScreen();
  console.log(`  Provider: ${provider}  |  Tier: ${tier}  |  Agents: ${selectedAgents.length}/${ALL_AGENT_IDS.length}\n`);

  const modelPreset = await select({
    message: 'Model configuration:',
    choices: Object.entries(MODEL_PRESETS).map(([key, val]) => ({
      value:       key,
      name:        `${key.padEnd(10)} ${val.label}`,
    })),
  });

  const { defaults: modelDefaults, overrides: modelOverrides } = resolvePreset(modelPreset, provider);

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
  console.log(`  ✓ Provider: ${provider} | Tier: ${tier} | Agents: ${selectedAgents.length}/${ALL_AGENT_IDS.length} | Preset: ${modelPreset} | Model: ${modelDefaults}`);
  if (provider === 'claude' && agentTeams) {
    console.log(`  ✓ Agent Teams: enabled (requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)`);
  }
  if (tier === 'full') {
    const invocation = provider === 'codex' ? '$enrich' : '/specrails:enrich --from-config';
    console.log(`\n  Next: run ${invocation} inside ${provider} to AI-customize your agents.\n`);
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
