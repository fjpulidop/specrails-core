import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { integrity, isMain, npm, run, validatePackFiles } from './release-utils.mjs'

export function isolatedEnvironment(home) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SPECRAILS_|NODE_OPTIONS$|NODE_PATH$|NODE_AUTH_TOKEN$|NPM_TOKEN$|GIT_)/i.test(key)))
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), SPECRAILS_REGISTRY_HOME: path.join(home, 'registry'), npm_config_userconfig: path.join(home, '.npmrc'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }
}
export function verifyPackage(root, outputDir) {
  mkdirSync(outputDir, { recursive: true })
  const temp = mkdtempSync(path.join(os.tmpdir(), 'specrails package smoke '))
  try {
    const home = path.join(temp, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, '.npmrc'), '')
    const env = isolatedEnvironment(home)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    const sha = run('git', ['-C', root, 'rev-parse', 'HEAD'])
    const [pack] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', outputDir], { cwd: root, env }))
    validatePackFiles(pack.files)
    assert.equal(pack.name, pkg.name)
    assert.equal(pack.version, pkg.version)
    const tarball = path.join(outputDir, pack.filename)
    const bytes = readFileSync(tarball)
    assert.equal(pack.integrity, integrity(bytes))
    // This is the npm consumer path. Scripts are disabled and HOME/registry are
    // isolated; no init/update command, provider CLI, OpenSpec fetch or model runs.
    const prefix = path.join(temp, 'consumer')
    npm(['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], { cwd: temp, env })
    const installed = path.join(prefix, 'node_modules', 'specrails-core')
    const cli = path.join(installed, 'dist', 'installer', 'cli.js')
    for (const entry of [cli, path.join(installed, 'bin', 'specrails-core.mjs')]) {
      assert.match(run(process.execPath, [entry, '--version'], { cwd: temp, env }), new RegExp(`(^|\\s)v?${pkg.version.replaceAll('.', '\\.')}($|\\s)`))
    }
    const contract = JSON.parse(readFileSync(path.join(installed, 'integration-contract.json'), 'utf8'))
    const runtimeEntry = path.join(installed, 'dist', 'agent-runtime', 'index.js')
    assert.ok(existsSync(runtimeEntry), 'Programmatic runtime must ship in the package')
    const alias = path.join(temp, 'core-alias')
    symlinkSync(installed, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(JSON.parse(run(process.execPath, [path.join(alias, 'dist/agent-runtime/cli.js'), 'api'], { cwd: temp, env })).type, 'runtime-api', 'CLI entry must work through a directory alias')
    assert.ok(existsSync(path.join(installed, 'dist', 'agent-runtime', 'index.d.ts')), 'Programmatic types must ship')
    run(process.execPath, ['--input-type=module', '-e',
      'import {pathToFileURL} from "node:url"; const runtime=await import(pathToFileURL(process.argv[1]).href); if(runtime.RUNTIME_API_VERSION!==1)throw Error("Incompatible runtime"); const schema=runtime.Annotation.Root({notes:runtime.Annotation({reducer:(a,b)=>[...a,...b],default:()=>[]})}); const state=await runtime.runWorkflow({directory:process.argv[2],runId:"package-agent-smoke",input:null,workflow:{id:"package-smoke",version:"1",schema,entry:"verify",nodes:{verify:{ends:[],run:async()=>({status:"succeeded",update:{notes:["checked"]},usage:{costUsd:0,inputTokens:0,outputTokens:0}})}}}}); if(state.status!=="succeeded"||state.steps.verify.update.notes[0]!=="checked")throw Error("Workflow failed");',
      runtimeEntry, path.join(temp, 'agent-smoke')], { cwd: temp, env })
    assert.equal(contract.execution?.schemaVersion, 1)
    assert.equal(contract.execution?.runtime, '.specrails/runtime/pipeline.mjs')
    const providers = ['claude', 'codex', 'gemini', 'kimi']
    const framework = path.join(temp, 'framework')
    const code = path.join(temp, 'source repo')
    mkdirSync(code, { recursive: true })
    run('git', ['init', code], { env })
    for (const provider of providers) {
      assert.ok(contract.providers[provider])
      run(process.execPath, [cli, 'install-framework', '--framework-dir', framework, '--provider', provider, '--version', pkg.version, '--no-swap'], { cwd: temp, env })
    }
    run(process.execPath, [cli, 'swap-current', '--framework-dir', framework, '--version', pkg.version, '--providers', providers.join(',')], { cwd: temp, env })
    for (const provider of providers) {
      const workspace = path.join(temp, `${provider} workspace`)
      run(process.execPath, [cli, 'assemble', '--workspace', workspace, '--framework-dir', framework, '--provider', provider, '--version', pkg.version, '--code-root', code], { cwd: temp, env })
      const runtime = path.join(workspace, contract.execution.runtime)
      assert.ok(existsSync(runtime), `${provider}: managed runtime must be shipped and assembled`)
      const context = { schemaVersion: 1, runId: `package-${provider}`, backlogRoot: workspace, artifactRoot: code, artifactRepositoryId: 'primary', repositories: [{ id: 'primary', name: 'Source', path: code }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [{ id: 17, title: 'Package smoke', description: 'Frozen isolated scope', repositoryIds: ['primary'] }] }
      const contextFile = path.join(temp, `${provider}-context.json`)
      writeFileSync(contextFile, JSON.stringify(context))
      run(process.execPath, [runtime, 'init', '--context', contextFile, '--change', 'package-smoke'], { cwd: code, env })
      const status = JSON.parse(run(process.execPath, [runtime, 'status', '--context', contextFile], { cwd: code, env }))
      assert.equal(status.schemaVersion, 1)
      assert.equal(status.runId, context.runId)
      assert.equal(status.phases.architect.status, 'pending')
      assert.equal(status.context.specs[0].title, context.specs[0].title)
      assert.equal(status.verification.valid, false, 'An unimplemented package smoke must never report a passing receipt')
      // Verify the installed standalone module with a persisted multi-file harness.
      run(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url'; import fs from 'node:fs';
        const pipeline = await import(pathToFileURL(process.argv[1]).href);
        const plans = await import(pathToFileURL(process.argv[2]).href);
        const context = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
        plans.initializeVerificationPlan(context, [], []);
        const plan = plans.addDeveloperChecks(context, [{ kind:'harness', key:'package-check', label:'Installed harness', repositoryId:'primary', command:process.execPath, args:[], entrypoint:'check.cjs', files:[{path:'check.cjs',content:'require("./helper.cjs"); console.log("installed harness passed")'}, {path:'helper.cjs',content:'require("node:assert/strict").equal(2+2,4)'}] }]);
        plans.bindPlan(context, plan);
        const receipt = await pipeline.verifyPipeline(context, {kind:'full', planHash:plan.planHash, commands:plans.expandedPlanCommands(context, plan)});
        if (!receipt.valid) throw Error('Installed harness failed');
        const list = pipeline.readVerificationEvidence(context);
        if (!list.available || list.items[0].sources.length !== 2) throw Error('Installed source discovery failed');
        const source = pipeline.readVerificationEvidence(context,{id:list.items[0].id,section:'source',sourceId:list.items[0].sources[1].id});
        if (!source.available || !source.text) throw Error('Installed evidence read failed');
      `, path.join(path.dirname(runtime), 'pipeline-state.mjs'), path.join(installed, 'dist/agent-runtime/verification-plan.js'), contextFile], { cwd: code, env })
    }
    const manifest = { schemaVersion: 1, name: pkg.name, version: pkg.version, sha, filename: pack.filename, integrity: pack.integrity }
    writeFileSync(path.join(outputDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    console.log(`Verified ${pack.filename}: two CLI entries, four provider assemblies and four frozen runtime journals`)
    return manifest
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
if (isMain(import.meta.url)) {
  try {
    const output = process.argv[2] || mkdtempSync(path.join(os.tmpdir(), 'specrails-core-package-check-'))
    verifyPackage(process.cwd(), path.resolve(output))
    console.log(`Verified artifact retained at ${path.resolve(output)}`)
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
}
