import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { runCliProcess } from '../../cli-process.js'
import { EngineError } from '../contracts.js'

export class PersistenceError extends EngineError {
  constructor(code: string, message: string) { super(code, message); this.name = 'PersistenceError' }
}

const aclScript = String.raw`$ErrorActionPreference='Stop'; $target=$env:SPECRAILS_PRIVATE_PATH;
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent();
$isFile=[System.IO.File]::Exists($target);
$acl=if($isFile){New-Object System.Security.AccessControl.FileSecurity}else{New-Object System.Security.AccessControl.DirectorySecurity};
$acl.SetOwner($identity.User); $acl.SetAccessRuleProtection($true,$false);
$inherit=if($isFile){[System.Security.AccessControl.InheritanceFlags]::None}else{[System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'};
foreach($sid in @($identity.User,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
 $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$inherit,[System.Security.AccessControl.PropagationFlags]::None,'Allow')))
}; Set-Acl -LiteralPath $target -AclObject $acl;
$actual=Get-Acl -LiteralPath $target;
if($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value -or !$actual.AreAccessRulesProtected){throw 'Private directory owner/protection mismatch'};
foreach($entry in $actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
 if($entry.IdentityReference.Value -notin @($identity.User.Value,'S-1-5-18') -or $entry.AccessControlType -ne 'Allow'){throw 'Private directory grants broad access'}
}`

async function setPrivateWindowsAcl(target: string, cwd: string): Promise<void> {
  const env = { ...process.env, SPECRAILS_PRIVATE_PATH: target }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete (env as NodeJS.ProcessEnv)[key]
  const result = await runCliProcess({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')] },
    { cwd, timeoutMs: 30_000, env })
  if (result.exitCode !== 0) throw new PersistenceError('private_storage_unavailable', `Cannot protect engine storage: ${result.stderr.slice(0, 2000)}`)
}

/** This directory belongs to one run. Never apply this to the user's repository root. */
export async function ensurePrivateDirectory(directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink()) throw new PersistenceError('unsafe_storage_path', 'A engine storage directory cannot be a symbolic link')
  const resolved = realpathSync(directory)
  if (process.platform === 'win32') {
    await setPrivateWindowsAcl(resolved, resolved)
  } else chmodSync(resolved, 0o700)
  return resolved
}

/** Storage adapters use this before opening SQLite; reads never alter permissions. */
export async function privateSqlitePath(filename: string, options: { create?: boolean; readOnly?: boolean } = {}): Promise<string> {
  const absolute = path.resolve(filename)
  if (!options.create && !existsSync(absolute)) throw new PersistenceError('run_not_found', 'Engine database does not exist')
  if (options.create && existsSync(absolute)) throw new PersistenceError('run_exists', 'Engine database already exists')
  if (options.readOnly && options.create) throw new EngineError('invalid_arguments', 'Read-only mode cannot create a database')
  const parentPath = path.dirname(absolute)
  if (options.readOnly && lstatSync(parentPath).isSymbolicLink()) throw new PersistenceError('unsafe_storage_path', 'An engine storage directory cannot be a symbolic link')
  const parent = options.readOnly ? realpathSync(parentPath) : await ensurePrivateDirectory(parentPath)
  const target = path.join(parent, path.basename(absolute))
  if (existsSync(target)) {
    const info = lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new PersistenceError('unsafe_storage_path', 'Engine database must be a regular unlinked file')
  }
  if (options.create) {
    const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
    closeSync(fd)
  }
  if (!options.readOnly) {
    if (process.platform !== 'win32') chmodSync(target, 0o600)
    else await setPrivateWindowsAcl(target, parent)
  }
  return target
}
