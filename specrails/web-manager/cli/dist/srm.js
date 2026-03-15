#!/usr/bin/env node
"use strict";
/**
 * srm — specrails CLI bridge
 *
 * Routes commands to the web-manager when running, or falls back to invoking
 * claude directly when the web-manager is not reachable.
 *
 * Usage:
 *   srm implement #42           → /sr:implement #42 (via web-manager or direct)
 *   srm "any raw prompt"        → raw prompt (no /sr: prefix)
 *   srm --status                → print web-manager state
 *   srm --jobs                  → print job history table
 *   srm --port 5000 <command>   → use port 5000 instead of 4200
 *   srm --help                  → print usage and exit 0
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
exports.detectWebManager = detectWebManager;
exports.formatDuration = formatDuration;
exports.formatTokens = formatTokens;
exports.printSummary = printSummary;
const http_1 = __importDefault(require("http"));
const child_process_1 = require("child_process");
const readline_1 = require("readline");
const ws_1 = __importDefault(require("ws"));
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_PORT = 4200;
const DETECTION_TIMEOUT_MS = 500;
const KNOWN_VERBS = new Set([
    'implement',
    'batch-implement',
    'why',
    'product-backlog',
    'update-product-driven-backlog',
    'refactor-recommender',
    'health-check',
    'compat-check',
]);
const EXIT_PATTERN = /\[process exited with code (\d+)/;
// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const isTTY = process.stdout.isTTY === true;
function ansi(code, text) {
    if (!isTTY)
        return text;
    return `\x1b[${code}m${text}\x1b[0m`;
}
const dim = (t) => ansi('2', t);
const red = (t) => ansi('31', t);
const bold = (t) => ansi('1', t);
const dimCyan = (t) => ansi('2;36', t);
function srmPrefix() {
    return dim('[srm]');
}
function srmLog(msg) {
    process.stdout.write(`${srmPrefix()} ${msg}\n`);
}
function srmError(msg) {
    process.stderr.write(`${srmPrefix()} ${red(`error: ${msg}`)}\n`);
}
function srmWarn(msg) {
    process.stderr.write(`${srmPrefix()} ${dim(`warning: ${msg}`)}\n`);
}
function parseArgs(argv) {
    // argv is process.argv.slice(2)
    let port = DEFAULT_PORT;
    const args = [...argv];
    // Extract --port <n> from any position
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && i + 1 < args.length) {
            const parsed = parseInt(args[i + 1], 10);
            if (!isNaN(parsed)) {
                port = parsed;
            }
            args.splice(i, 2);
            i--;
        }
    }
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return { mode: 'help' };
    }
    if (args[0] === '--status') {
        return { mode: 'status', port };
    }
    if (args[0] === '--jobs') {
        return { mode: 'jobs', port };
    }
    const first = args[0];
    // Slash-prefixed command: pass through unchanged
    if (first.startsWith('/')) {
        const resolved = args.join(' ');
        return { mode: 'raw', resolved, port };
    }
    // Known verb: inject /sr: prefix
    if (KNOWN_VERBS.has(first)) {
        const resolved = `/sr:${args.join(' ')}`;
        return { mode: 'command', resolved, port };
    }
    // Unknown first token: treat as raw prompt
    const resolved = args.join(' ');
    return { mode: 'raw', resolved, port };
}
function printHelp() {
    process.stdout.write(`
${bold('srm')} — specrails CLI bridge

${bold('Usage:')}
  srm implement #42                Run a known specrails verb (prepends /sr:)
  srm batch-implement #40 #41      Known verbs: ${[...KNOWN_VERBS].join(', ')}
  srm "any raw prompt"             Pass a raw prompt directly to claude
  srm --status                     Print web-manager status and exit
  srm --jobs                       Print recent job history and exit
  srm --port <n>                   Override default port (${DEFAULT_PORT})
  srm --help                       Show this help text

${bold('Execution paths:')}
  Web-manager running → POST /api/spawn + stream logs via WebSocket
  Web-manager not running → spawn claude directly with stream-json output
`.trimStart());
}
function detectWebManager(port) {
    const baseUrl = `http://127.0.0.1:${port}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            req.destroy();
            resolve({ running: false, baseUrl });
        }, DETECTION_TIMEOUT_MS);
        const req = http_1.default.get(`${baseUrl}/api/state`, { timeout: DETECTION_TIMEOUT_MS }, (res) => {
            clearTimeout(timer);
            res.resume(); // drain the response
            if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ running: true, baseUrl });
            }
            else {
                resolve({ running: false, baseUrl });
            }
        });
        req.on('error', () => {
            clearTimeout(timer);
            resolve({ running: false, baseUrl });
        });
        req.on('timeout', () => {
            req.destroy();
            clearTimeout(timer);
            resolve({ running: false, baseUrl });
        });
    });
}
// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const req = http_1.default.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
    });
}
function httpPost(url, payload) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
        };
        const req = http_1.default.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}
// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
}
// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------
function formatTokens(n) {
    return new Intl.NumberFormat('en-US', { useGrouping: true })
        .format(n)
        .replace(/,/g, ' ');
}
function printSummary(data) {
    const doneLabel = isTTY ? bold('[srm] done') : '[srm] done';
    const durationPart = `duration: ${formatDuration(data.durationMs)}`;
    const costPart = data.costUsd != null ? `  cost: $${data.costUsd.toFixed(2)}` : '';
    const tokenPart = data.totalTokens != null ? `  tokens: ${formatTokens(data.totalTokens)}` : '';
    const exitPart = `  exit: ${data.exitCode}`;
    process.stdout.write(`${doneLabel}  ${durationPart}${costPart}${tokenPart}${exitPart}\n`);
}
async function runViaWebManager(command, baseUrl) {
    // Spawn the job
    let spawnRes;
    try {
        spawnRes = await httpPost(`${baseUrl}/api/spawn`, { command });
    }
    catch (err) {
        srmError('failed to connect to web-manager');
        return 1;
    }
    if (spawnRes.status === 409) {
        srmError('web-manager is busy (another job is running)');
        return 1;
    }
    if (spawnRes.status >= 400) {
        let errMsg = `spawn failed with HTTP ${spawnRes.status}`;
        try {
            const parsed = JSON.parse(spawnRes.body);
            if (parsed.error)
                errMsg = parsed.error;
        }
        catch { /* use default */ }
        srmError(errMsg);
        return 1;
    }
    let processId;
    try {
        const parsed = JSON.parse(spawnRes.body);
        // Server returns jobId; processId is the legacy field name used in LogMessage
        processId = (parsed.jobId ?? parsed.processId) ?? '';
        if (!processId)
            throw new Error('missing jobId');
    }
    catch {
        srmError('invalid response from /api/spawn');
        return 1;
    }
    const startTime = Date.now();
    // Connect WebSocket and stream logs
    const wsUrl = baseUrl.replace(/^http/, 'ws');
    let exitCode = 1;
    let resolved = false;
    await new Promise((resolve) => {
        const ws = new ws_1.default(wsUrl);
        ws.on('message', (data) => {
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
                return;
            }
            if (msg.type === 'init') {
                // Replay only log lines from our processId
                const initMsg = msg;
                for (const logLine of initMsg.logBuffer) {
                    if (logLine.processId === processId) {
                        handleLogLine(logLine);
                    }
                }
                return;
            }
            if (msg.type === 'log') {
                const logMsg = msg;
                if (logMsg.processId !== processId)
                    return;
                handleLogLine(logMsg);
                return;
            }
            if (msg.type === 'phase') {
                const phaseMsg = msg;
                process.stdout.write(`  ${dimCyan(`→ [${phaseMsg.phase}] ${phaseMsg.state}`)}\n`);
                return;
            }
        });
        function handleLogLine(logMsg) {
            if (resolved)
                return;
            // Check for exit signal
            const match = EXIT_PATTERN.exec(logMsg.line);
            if (match) {
                exitCode = parseInt(match[1], 10);
                resolved = true;
                ws.close();
                resolve();
                return;
            }
            // Print to appropriate stream, preserving ANSI
            if (logMsg.source === 'stderr') {
                process.stderr.write(`${logMsg.line}\n`);
            }
            else {
                process.stdout.write(`${logMsg.line}\n`);
            }
        }
        ws.on('close', () => {
            if (!resolved) {
                srmWarn('lost connection to web-manager');
                resolved = true;
                resolve();
            }
        });
        ws.on('error', (err) => {
            if (!resolved) {
                srmWarn(`WebSocket error: ${err.message}`);
                resolved = true;
                resolve();
            }
        });
    });
    const durationMs = Date.now() - startTime;
    // Fetch job metadata for cost/tokens
    let costUsd;
    let totalTokens;
    try {
        const jobRes = await httpGet(`${baseUrl}/api/jobs/${processId}`);
        if (jobRes.status === 200) {
            const parsed = JSON.parse(jobRes.body);
            if (parsed.job) {
                if (parsed.job.total_cost_usd != null)
                    costUsd = parsed.job.total_cost_usd;
                const tokensIn = parsed.job.tokens_in ?? 0;
                const tokensOut = parsed.job.tokens_out ?? 0;
                if (parsed.job.tokens_in != null || parsed.job.tokens_out != null) {
                    totalTokens = tokensIn + tokensOut;
                }
                // Prefer server-side duration when available
                if (parsed.job.duration_ms != null) {
                    printSummary({ durationMs: parsed.job.duration_ms, costUsd, totalTokens, exitCode });
                    return exitCode;
                }
            }
        }
    }
    catch { /* fall through to duration-only summary */ }
    printSummary({ durationMs, costUsd, totalTokens, exitCode });
    return exitCode;
}
async function runDirect(command) {
    const startTime = Date.now();
    const args = [
        '--dangerously-skip-permissions',
        '-p',
        ...command.trim().split(/\s+/),
        '--output-format', 'stream-json',
        '--verbose',
    ];
    let child;
    try {
        child = (0, child_process_1.spawn)('claude', args, {
            env: process.env,
            shell: false,
        });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT') {
            srmError('claude binary not found');
        }
        else {
            srmError(`failed to spawn claude: ${err.message}`);
        }
        return 1;
    }
    let resultData;
    // Stderr: pass through unchanged
    child.stderr?.pipe(process.stderr);
    // Stdout: parse NDJSON line by line
    const rl = (0, readline_1.createInterface)({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
        if (!line.trim())
            return;
        let parsed = null;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            // Non-JSON line: print as-is
            process.stdout.write(`${line}\n`);
            return;
        }
        if (parsed.type === 'text') {
            const content = parsed.content ?? '';
            if (content)
                process.stdout.write(`${content}\n`);
        }
        else if (parsed.type === 'result') {
            resultData = parsed;
        }
        // All other types: silently ignore
    });
    const exitCode = await new Promise((resolve) => {
        child.on('close', (code) => {
            resolve(code ?? 1);
        });
        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                srmError('claude binary not found');
            }
            else {
                srmError(`claude process error: ${err.message}`);
            }
            resolve(1);
        });
    });
    const durationMs = Date.now() - startTime;
    let costUsd;
    let totalTokens;
    if (resultData) {
        if (resultData.cost_usd != null)
            costUsd = resultData.cost_usd;
        const tokensIn = resultData.input_tokens ?? 0;
        const tokensOut = resultData.output_tokens ?? 0;
        if (resultData.input_tokens != null || resultData.output_tokens != null) {
            totalTokens = tokensIn + tokensOut;
        }
    }
    printSummary({ durationMs, costUsd, totalTokens, exitCode });
    return exitCode;
}
// ---------------------------------------------------------------------------
// --status handler
// ---------------------------------------------------------------------------
async function handleStatus(port) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const detection = await detectWebManager(port);
    if (!detection.running) {
        process.stdout.write(`web-manager: not running (${baseUrl})\n`);
        return 1;
    }
    try {
        const res = await httpGet(`${baseUrl}/api/state`);
        if (res.status !== 200) {
            process.stdout.write(`web-manager: not running (${baseUrl})\n`);
            return 1;
        }
        const state = JSON.parse(res.body);
        const version = state.version ? `  (v${state.version})` : '';
        process.stdout.write(`web-manager: running${version}\n`);
        process.stdout.write(`project:     ${state.projectName ?? 'unknown'}\n`);
        process.stdout.write(`busy:        ${state.busy ? 'true' : 'false'}\n`);
        if (state.phases) {
            const phaseStr = Object.entries(state.phases)
                .map(([phase, st]) => `${phase}=${st}`)
                .join('  ');
            process.stdout.write(`phases:      ${phaseStr}\n`);
        }
        return 0;
    }
    catch {
        process.stdout.write(`web-manager: not running (${baseUrl})\n`);
        return 1;
    }
}
function formatJobDuration(ms) {
    if (ms == null)
        return '-';
    return formatDuration(ms);
}
function formatJobStarted(isoStr) {
    try {
        const d = new Date(isoStr);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hour = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        return `${year}-${month}-${day} ${hour}:${min}`;
    }
    catch {
        return isoStr.slice(0, 16);
    }
}
async function handleJobs(port) {
    const baseUrl = `http://127.0.0.1:${port}`;
    const detection = await detectWebManager(port);
    if (!detection.running) {
        srmError(`web-manager is not running (${baseUrl})`);
        return 1;
    }
    let res;
    try {
        res = await httpGet(`${baseUrl}/api/jobs`);
    }
    catch {
        srmError('failed to fetch job list');
        return 1;
    }
    if (res.status === 501 || res.status === 404) {
        srmLog('jobs history requires web-manager with SQLite persistence (#57)');
        return 1;
    }
    if (res.status !== 200) {
        srmError(`unexpected response from /api/jobs: HTTP ${res.status}`);
        return 1;
    }
    let data;
    try {
        data = JSON.parse(res.body);
    }
    catch {
        srmError('invalid response from /api/jobs');
        return 1;
    }
    if (!data.jobs || data.jobs.length === 0) {
        srmLog('no jobs recorded yet');
        return 0;
    }
    // Column widths
    const idW = 8;
    const cmdW = 30;
    const startW = 18;
    const durW = 8;
    const exitW = 4;
    const header = [
        'ID'.padEnd(idW),
        'COMMAND'.padEnd(cmdW),
        'STARTED'.padEnd(startW),
        'DURATION'.padEnd(durW),
        'EXIT'.padEnd(exitW),
    ].join('  ');
    process.stdout.write(`${bold(header)}\n`);
    for (const job of data.jobs) {
        const idCell = job.id.slice(0, idW).padEnd(idW);
        const cmdCell = job.command.slice(0, cmdW).padEnd(cmdW);
        const startCell = formatJobStarted(job.started_at).padEnd(startW);
        const durCell = formatJobDuration(job.duration_ms).padEnd(durW);
        const exitCell = (job.exit_code ?? '-').toString().padEnd(exitW);
        process.stdout.write(`${idCell}  ${cmdCell}  ${startCell}  ${durCell}  ${exitCell}\n`);
    }
    return 0;
}
// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function main() {
    const argv = process.argv.slice(2);
    const parsed = parseArgs(argv);
    if (parsed.mode === 'help') {
        printHelp();
        process.exit(0);
    }
    if (parsed.mode === 'status') {
        const code = await handleStatus(parsed.port);
        process.exit(code);
    }
    if (parsed.mode === 'jobs') {
        const code = await handleJobs(parsed.port);
        process.exit(code);
    }
    // Command or raw: resolve command string
    const command = parsed.resolved;
    const port = parsed.port;
    srmLog(`running: ${command}`);
    const detection = await detectWebManager(port);
    let exitCode;
    if (detection.running) {
        srmLog(`routing via web-manager at ${detection.baseUrl}`);
        exitCode = await runViaWebManager(command, detection.baseUrl);
    }
    else {
        srmLog('web-manager not running — invoking claude directly');
        exitCode = await runDirect(command);
    }
    process.exit(exitCode);
}
// Only run main() when this file is executed directly (not when imported in tests)
if (require.main === module) {
    main().catch((err) => {
        srmError(err.message ?? String(err));
        process.exit(1);
    });
}
