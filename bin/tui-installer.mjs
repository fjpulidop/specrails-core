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

import { select } from '@inquirer/prompts';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// The three core agents are the complete shipped set. Extend an install with
// user-owned custom-* agents declared in a profile (.specrails/profiles/**) —
// the installer never ships or manages non-core agents.
const AGENTS = [
  { id: 'sr-architect', category: 'Architecture', description: 'Architecture design, change specs, implementation planning' },
  { id: 'sr-developer', category: 'Development',  description: 'Full-stack implementation across all layers' },
  { id: 'sr-reviewer',  category: 'Review',       description: 'Code review — correctness, tests, security, performance' },
];

const ALL_AGENT_IDS = AGENTS.map(a => a.id);

// Core agents — the three the installer ships, which the implement pipeline
// depends on. They are the COMPLETE shipped set; any extra specialist comes
// from a user-authored profile (custom-*), never the installer.
const CORE_AGENTS = new Set([
  'sr-architect',
  'sr-developer',
  'sr-reviewer',
]);

// The three core agents ARE the full set; the selection always equals them.
const DEFAULT_SELECTED = new Set([
  ...CORE_AGENTS,
]);

// ─── Model presets ──────────────────────────────────────────────────────────────
// Claude exposes distinct Core-defined cost/quality tiers. Other providers use
// an explicit provider-native default for every named preset; preset names never
// imply that Claude aliases should be copied into another provider's config.

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
    label:       'Max quality — Opus for the architect, Sonnet for the rest',
    defaults:    'sonnet',
    overrides:   { 'sr-architect': 'opus' },
  },
};

// Per-provider default agent model. Keep in sync with install-config.ts and the
// provider renderers.
const PROVIDER_DEFAULT_MODEL = {
  claude: 'sonnet',
  codex:  'gpt-5.5-mini',
  gemini: 'gemini-3.5-flash',
  kimi:   'k3',
};

function resolveProviderModelPreset(provider, preset = 'balanced') {
  if (provider === 'claude') return MODEL_PRESETS[preset];
  return {
    label: `${PROVIDER_DEFAULT_MODEL[provider]} for all agents`,
    defaults: PROVIDER_DEFAULT_MODEL[provider],
    overrides: {},
  };
}

// ─── Provider registry ─────────────────────────────────────────────────────────
// Single source of truth for the AI CLIs the TUI can target. Add a provider here
// and it flows through detection, the --provider flag, and the interactive picker.
const PROVIDERS = [
  { id: 'claude', label: 'Claude Code (recommended)', versionCmd: 'claude --version', installLabel: 'Claude Code', installUrl: 'https://claude.ai/download' },
  { id: 'codex',  label: 'Codex (OpenAI)',            versionCmd: 'codex --version',  installLabel: 'Codex CLI',   installUrl: 'https://developers.openai.com/codex' },
  { id: 'gemini', label: 'Gemini CLI (Google)',       versionCmd: 'gemini --version', installLabel: 'Gemini CLI',  installUrl: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'kimi',   label: 'Kimi Code',                 versionCmd: 'kimi --version',   installLabel: 'Kimi Code',   installUrl: 'https://www.kimi.com/code/docs/en/' },
];
const VALID_PROVIDER_IDS = new Set(PROVIDERS.map(p => p.id));
const providerProbeTimeoutOverride = Number.parseInt(
  process.env.SPECRAILS_PROVIDER_PROBE_TIMEOUT_MS ?? '',
  10,
);
const PROVIDER_PROBE_TIMEOUT_MS =
  Number.isFinite(providerProbeTimeoutOverride) &&
  providerProbeTimeoutOverride >= 100 &&
  providerProbeTimeoutOverride <= 30_000
    ? providerProbeTimeoutOverride
    : 3_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Returns the set of provider ids whose CLI responds to `<bin> --version`.
function detectInstalledProviders() {
  const installed = new Set();
  for (const p of PROVIDERS) {
    try {
      execSync(p.versionCmd, {
        stdio: 'ignore',
        timeout: PROVIDER_PROBE_TIMEOUT_MS,
      });
      installed.add(p.id);
    } catch { /* absent, broken, or hung — do not block the installer */ }
  }
  return installed;
}

// Parse `--provider <id>` or `--provider=<id>` from process.argv. An explicit
// but invalid value is a configuration error, never an invitation to silently
// open a picker and install a different provider.
function parseProviderArg(args = process.argv.slice(2)) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) {
        throw new Error(
          `--provider requires one of: ${[...VALID_PROVIDER_IDS].join(', ')}`,
        );
      }
      const v = args[i + 1].trim().toLowerCase();
      if (!VALID_PROVIDER_IDS.has(v)) {
        throw new Error(
          `unsupported --provider '${args[i + 1]}' (expected: ${[...VALID_PROVIDER_IDS].join(', ')})`,
        );
      }
      return v;
    }
    if (a.startsWith('--provider=')) {
      const v = a.slice('--provider='.length).trim().toLowerCase();
      if (!VALID_PROVIDER_IDS.has(v)) {
        throw new Error(
          `unsupported --provider '${a.slice('--provider='.length)}' ` +
            `(expected: ${[...VALID_PROVIDER_IDS].join(', ')})`,
        );
      }
      return v;
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
    `agents:`,
    `  selected: [${cfg.selectedAgents.join(', ')}]`,
    `  excluded: [${cfg.excludedAgents.join(', ')}]`,
    `models:`,
    `  preset: ${cfg.modelPreset}`,
    `  defaults: { model: ${cfg.modelDefaults} }`,
    `  overrides:${overridesYaml}`,
    '',
  ].join('\n');

  writeFileSync(resolve(specrailsDir, 'install-config.yaml'), yaml, 'utf8');
}

function writeDefaultConfig(specrailsDir, provider) {
  const defaultSelected = [...DEFAULT_SELECTED];
  const defaultExcluded = ALL_AGENT_IDS.filter(id => !DEFAULT_SELECTED.has(id));
  const modelSelection = resolveProviderModelPreset(provider);
  writeInstallConfig(specrailsDir, {
    provider,
    selectedAgents: defaultSelected,
    excludedAgents: defaultExcluded,
    modelPreset:    'balanced',
    modelDefaults:  modelSelection.defaults,
    modelOverrides: modelSelection.overrides,
  });
}

function scaffoldDefaultProfile(specrailsDir, provider) {
  try {
    const scriptDir = fileURLToPath(new URL('..', import.meta.url));
    const templateName = provider === 'kimi' ? 'kimi-default.json' : 'default.json';
    const templatePath = resolve(scriptDir, 'templates/profiles', templateName);
    const profilesDir = resolve(specrailsDir, 'profiles');
    // Provider-bound defaults must coexist in a multi-provider project. Keep
    // the historical filename for Claude and give Kimi its own stable fallback.
    const targetName = provider === 'kimi' ? 'kimi-default.json' : 'project-default.json';
    const targetPath = resolve(profilesDir, targetName);
    if (existsSync(templatePath) && !existsSync(targetPath)) {
      mkdirSync(profilesDir, { recursive: true });
      writeFileSync(targetPath, readFileSync(templatePath));
      console.log(`  ✓ Profile scaffolded at .specrails/profiles/${targetName}`);
    } else if (existsSync(targetPath)) {
      console.log(`  ↷ Profile already exists at .specrails/profiles/${targetName} — skipped`);
    }
  } catch (e) {
    console.warn(`  ⚠  Could not scaffold profile: ${e.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const rawArgs  = process.argv.slice(2);
  const autoYes  = rawArgs.includes('--yes') || rawArgs.includes('-y');
  const withProfiles = rawArgs.includes('--with-profiles');
  const argvProvider = parseProviderArg(rawArgs);
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

  // Auto-yes: write defaults and exit (no TUI needed)
  //
  // Honours an explicit --provider <id> argv flag when present; otherwise
  // picks claude → codex → first-detected. Errors only when none detected.
  if (autoYes) {
    const installed = detectInstalledProviders();
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
        console.error('  ⚠  No supported AI CLI detected on PATH (Claude Code, Codex, Gemini CLI, or Kimi Code).');
        for (const p of PROVIDERS) console.error(`     Install ${p.installLabel}: ${p.installUrl}`);
        console.error('');
        process.exit(1);
      }
    }
    if (withProfiles) scaffoldDefaultProfile(specrailsDir, provider);
    writeDefaultConfig(specrailsDir, provider);
    console.log(`  ✓ Default config written to .specrails/install-config.yaml`);
    console.log(`  ✓ Provider: ${provider}, Agents: ${DEFAULT_SELECTED.size}, Preset: balanced\n`);
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
  if (withProfiles) scaffoldDefaultProfile(specrailsDir, provider);

  // ── Agents: the three core agents are the full shipped set ──────────────────

  clearScreen();
  console.log(`  Provider: ${provider}\n`);
  console.log('  Installing the three core agents: sr-architect, sr-developer, sr-reviewer.');
  console.log('  Add specialists later via a profile (.specrails/profiles/**) with custom-* agents.\n');

  const selectedAgents = [...CORE_AGENTS];
  const excludedAgents = ALL_AGENT_IDS.filter(id => !selectedAgents.includes(id));

  // ── Step 2: Model preset ────────────────────────────────────────────────────

  clearScreen();
  console.log(`  Provider: ${provider}  |  Agents: ${selectedAgents.length}\n`);

  // Claude exposes real model tiers. Other providers retain the same config
  // shape but resolve the preset through their provider-native catalog.
  let modelPreset = 'balanced';
  let {
    defaults: modelDefaults,
    overrides: modelOverrides,
  } = resolveProviderModelPreset(provider, modelPreset);
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
    console.log(`  → Model: ${modelDefaults}  (${provider} provider preset)\n`);
  }

  // ── Write config & exit fullscreen ──────────────────────────────────────────

  exitFullscreen();

  writeInstallConfig(specrailsDir, {
    provider,
    selectedAgents,
    excludedAgents,
    modelPreset,
    modelDefaults,
    modelOverrides,
  });

  console.log(`\n  ✓ Config written to .specrails/install-config.yaml`);
  console.log(`  ✓ Provider: ${provider} | Agents: ${selectedAgents.length} | Preset: ${modelPreset}`);
  console.log(`\n  Agents will be installed with template defaults — no follow-up step required.\n`);
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
