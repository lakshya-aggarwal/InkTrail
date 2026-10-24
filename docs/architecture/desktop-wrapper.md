# Desktop Wrapper

## Purpose

The first InkTrail desktop build is a Tauri shell around the existing local
Node service. It preserves the current reader, translation, feedback, jobs,
SQLite, and EPUB behavior while proving an installable desktop boundary.

## Runtime Boundary

- Tauri owns the native window, asks the child service for its OS-assigned
  loopback URL, waits for the health endpoint, and requests graceful shutdown
  over the private child-process stdin channel when the application exits. It
  force-stops only after a ten-second graceful-shutdown deadline.
- The staged Node runtime owns the existing InkTrail HTTP application.
- Tauri stores the database and EPUB exports in its application-data directory
  by setting `INKTRAIL_DATA_DIR` for the child process.
- The reader continues to load from the child service over `127.0.0.1`, so its
  existing relative API routes remain unchanged.

## Development Flow

Run `node scripts/prepare-desktop-runtime.js`, then run Cargo against
`desktop/src-tauri/Cargo.toml`. The staged runtime is generated and ignored by
Git. It uses the Node executable that ran the preparation command.

## Release Boundary

This is not yet a distributable public application. A release build needs a
dedicated, redistributable Node runtime for every supported platform, signed
Tauri bundles, icons, first-run configuration, and packaged end-to-end tests.
It must not bundle a developer's private or tool-managed Node executable.
