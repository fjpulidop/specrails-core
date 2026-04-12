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

import { checkbox, select, input, Separator } from '@inquirer/prompts';
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

// ─── Model presets ────────────────────────────────────────────────────────────

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
    `quick_context:`,
    `  product_description: "${cfg.productDescription.replace(/"/g, '\\"')}"`,
    `  target_users: "${cfg.targetUsers.replace(/"/g, '\\"')}"`,
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
    modelDefaults:  'sonnet',
    modelOverrides: {},
    productDescription: '',
    targetUsers:    '',
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
    choices: [
      {
        value:       'full',
        name:        'Full — AI-powered setup (recommended)',
        description: 'After install, run /specrails:enrich to AI-customize all agents for your codebase',
      },
      {
        value:       'quick',
        name:        'Quick — Template-only install',
        description: 'Agents installed with sensible defaults. No AI step required.',
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

  const { defaults: modelDefaults, overrides: modelOverrides } = MODEL_PRESETS[modelPreset];

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

  // ── Step 6: Quick context ───────────────────────────────────────────────────

  clearScreen();
  console.log(`  Provider: ${provider}  |  Tier: ${tier}  |  Agents: ${selectedAgents.length}  |  Preset: ${modelPreset}\n`);
  console.log('  Quick context helps specrails personalize agents for your project.\n');

  const productDescription = await input({
    message: 'Product description (2–3 sentences):',
    validate: (v) => v.trim().length > 0 || 'Please enter a brief product description.',
  });

  const targetUsers = await input({
    message: 'Target users (who will use this product?):',
    validate: (v) => v.trim().length > 0 || 'Please describe your target users.',
  });

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
    productDescription: productDescription.trim(),
    targetUsers:        targetUsers.trim(),
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
