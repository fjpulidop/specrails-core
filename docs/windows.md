# Windows support

specrails-core runs natively on Windows 10 (1809+) and Windows 11, on both x64 and ARM64 (via the built-in x64 emulation layer). There is **no dependency on `bash`, `python3`, or any POSIX-only tooling** — the installer is pure Node.

## Requirements

- **Windows 10 1809+** or **Windows 11** (x64 or ARM64)
- **Node.js ≥ 20** — install from [nodejs.org](https://nodejs.org/)
- **git ≥ 2.25** — install from [git-scm.com](https://git-scm.com/)
- **Claude Code** (`claude.cmd`) — install from [claude.ai/download](https://claude.ai/download)

`npm install -g @anthropic-ai/claude-code` installs the Claude CLI as `claude.cmd` into your global npm bin (`%APPDATA%\npm\`). Make sure that directory is on your PATH so `where claude` resolves it.

## Install

From PowerShell or cmd.exe:

```powershell
cd C:\path\to\your\project
npx specrails-core@latest init
```

The installer:
- probes PATH with `where` (instead of the POSIX `which`),
- spawns `.cmd` shims (`claude.cmd`, `npm.cmd`, `gh.cmd`) with `shell: true` — required by Node.js since CVE-2024-27980,
- writes all files with LF line endings regardless of `core.autocrlf` to keep the bundled templates portable.

## PowerShell execution policy

If `npm` errors with `npm.ps1 cannot be loaded because running scripts is disabled on this system`, relax the policy for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

`RemoteSigned` is the MSFT-recommended minimum for dev tooling.

## Known limitations

- **PATH refresh after installing new tools.** Windows GUI shells (Explorer, launcher-started apps) do not re-read PATH until logout/login. If you install `claude.cmd` and launch specrails-hub immediately, the hub's sidecar may not see it. Restart the app after changes to the Env Vars dialog, or launch from a fresh PowerShell.
- **CRLF checkouts.** If you clone specrails-core with `core.autocrlf=true`, the repo's `.gitattributes` forces LF on every text file at checkout so the Node installer writes byte-identical artefacts across platforms. Running `git add --renormalize .` once after cloning fixes any pre-existing CRLF contamination.
- **ARM64.** The x64 Node binary runs under Windows 11's native x64 emulation. All native dependencies we use (`better-sqlite3`, `node-pty`, etc.) resolve to their x64 prebuilts; performance hit is ~10-20% vs native ARM64 but fully functional.

## CI

The specrails-core GitHub Actions workflow runs the vitest suite on `windows-latest` in a matrix with `ubuntu-latest` and `macos-latest`, on Node 20 and Node 22. Any PR that regresses Windows behaviour fails CI immediately.

## Reporting Windows-specific bugs

[GitHub Issues](https://github.com/fjpulidop/specrails-core/issues). Include:
- Windows version (`winver`)
- Node version (`node --version`)
- Full output of `npx specrails-core doctor` (run inside the affected project)
