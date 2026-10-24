# Local Data Backup And Restore Review

## Scope

This slice adds local CLI commands for a portable data backup and a
non-destructive restore. It does not add cloud sync, a public endpoint, an
installer, or an in-place restore command.

## Data Safety

- The backup copies every regular data file in the configured directory,
  including SQLite and EPUB exports. Symbolic links, special files, and the
  reserved manifest filename fail closed.
- Each backed-up data file receives a SHA-256 checksum in a versioned manifest.
- Restore requires the manifest to account for every backup file, verifies
  every file against it, and stages the complete result before an atomic final
  rename.
- Restore rejects existing targets, so it cannot replace the active or prior
  local library. InkTrail commands hold an exclusive destination lock while
  publishing a staged directory.
- Intermediate path components are resolved against the backup root at copy
  time, so symbolic links fail closed.
- InkTrail must be stopped before backup. The current loopback runtime has no
  cross-process lock or SQLite snapshot protocol.

## Validation

Run on 2026-10-24:

```sh
node --test test/storage/local-data-backup.test.js
node --test test/**/*.test.js
git diff --check
```

The focused suite covers full data round-trip recovery, modified-backup
rejection, incomplete-manifest and symbolic-link rejection, existing-target
protection, concurrent destination protection, lock cleanup, and both CLI
entry points. The complete backend suite passed 210 tests and `git diff --check`
passed. Independent review identified and verified repairs for incomplete
manifests, non-atomic publication, nested symbolic links, and every normal
lock cleanup path. Forced process termination can leave an adjacent lock file;
the README documents the safe manual recovery step.
