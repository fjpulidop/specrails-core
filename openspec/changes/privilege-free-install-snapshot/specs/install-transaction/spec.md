## ADDED Requirements

### Requirement: Snapshot never requires filesystem privileges
The install transaction SHALL snapshot its protected surfaces without performing any operation that the target platform may refuse to an ordinary, non-elevated user. Symbolic links and Windows junctions SHALL be recorded by their target path, never recreated, while a snapshot is being taken.

#### Scenario: Protected surface is a Windows junction
- **WHEN** a protected surface is a directory junction and the account holds no symlink-creation privilege
- **THEN** the snapshot records the junction's target path and completes successfully
- **AND** the install proceeds to its work instead of failing before it starts

#### Scenario: Link creation is denied by the platform
- **WHEN** the platform refuses to create a symbolic link of any type during a transaction
- **THEN** the snapshot still completes and the transaction retains the ability to roll back

#### Scenario: Protected surface contains nested links
- **WHEN** a protected directory contains linked children (a workspace provider directory whose subtrees are junctions)
- **THEN** each linked child is recorded by target and each regular file is copied
- **AND** no link is created anywhere under the backup location

### Requirement: Restore reinstates links through the platform-aware primitive
Restoring a snapshotted surface SHALL recreate a recorded link using the same mechanism the installer uses to place links — a directory junction on Windows, a symbolic link elsewhere — and SHALL fall back to copying the target's contents when no link mechanism is available.

#### Scenario: Recorded pointer is restored on Windows
- **WHEN** a transaction rolls back a recorded directory link on Windows
- **THEN** the link is recreated as a junction pointing at its original target

#### Scenario: No link mechanism is available
- **WHEN** every link mechanism fails for a recorded directory link
- **THEN** the restore copies the target's contents into place rather than aborting the rollback
- **AND** the rollback reports success

### Requirement: The versioned framework store is protected without being copied
The transaction SHALL NOT copy the contents of `<frameworkDir>/<version>`, whose materialization already rebuilds from a content stamp and stages through a temporary directory. A version directory the install CREATED SHALL still be removed on rollback; one that already existed SHALL be left exactly as it stands.

#### Scenario: A pre-existing version directory survives a rollback untouched
- **WHEN** an install fails and the framework version directory existed before it began
- **THEN** the rollback neither removes nor overwrites that directory
- **AND** a subsequent install reuses or repairs it through its content stamp

#### Scenario: A version directory the install created is removed
- **WHEN** an install materializes a new framework version and then fails
- **THEN** the rollback removes that version directory

#### Scenario: The pointer is rolled back
- **WHEN** an install repoints `current` at a new version and then fails
- **THEN** `current` is restored to the version it referenced before the install began

#### Scenario: Snapshot cost does not scale with framework size
- **WHEN** a transaction begins on a machine with a fully materialized framework
- **THEN** no copy of the framework version tree is made

### Requirement: Rollback preserves reserved paths
A rollback SHALL remove only installer-owned entries and SHALL leave reserved paths as they stand at failure time, so a user edit made during the install is neither lost nor reverted to a stale backup copy.

#### Scenario: A reserved file edited during the install survives rollback
- **WHEN** a reserved path is created or edited while the install is running and the install then fails
- **THEN** the rollback leaves that path exactly as the user left it

### Requirement: A failed restore surfaces its backup
When a rollback cannot restore a surface, the transaction SHALL retain the backup, record which surfaces failed, and report the retained location in the error it raises.

#### Scenario: Restore fails for one surface
- **WHEN** restoring one protected surface throws
- **THEN** the raised error names the failing surface and the retained backup location
- **AND** the backup directory is not deleted

#### Scenario: Rollback succeeds
- **WHEN** every protected surface is restored
- **THEN** the backup directory is removed
