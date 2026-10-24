# Desktop Wrapper Review

## Scope

This slice adds a Tauri development wrapper that stages and supervises the
existing InkTrail Node service. It does not rewrite the service in Rust, add a
public distribution, add cloud sync, or change reader routes and behavior.

## Runtime Safety

- The child service binds an OS-assigned `127.0.0.1` port and reports its URL
  directly to Tauri before the wrapper checks health and constructs the reader
  window.
- SQLite and EPUB files live under the Tauri application-data directory via
  `INKTRAIL_DATA_DIR`, separate from the source checkout.
- The child service is stopped through a private stdin shutdown command on a
  normal Tauri exit. A ten-second deadline prevents a stalled close from
  blocking the desktop process indefinitely.
- The staged runtime is generated, ignored by Git, and uses the Node executable
  that performed the preparation command. It is for local development only.

## Validation

Run on 2026-10-25:

```sh
node scripts/prepare-desktop-runtime.js
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib
cargo check --manifest-path desktop/src-tauri/Cargo.toml
cargo run --manifest-path desktop/src-tauri/Cargo.toml
node --test test/**/*.test.js
```

The Rust format, native lifecycle, and compile checks passed. The Node suite
passed 212 tests. A live wrapper launch started a healthy local service on an
ephemeral loopback port, then its verified parent and child processes stopped
cleanly. The native inspector did not expose the unbundled debug window by
application name, so no pixel screenshot was available from that surface.

Independent review was clean after the shutdown supervisor gained a regression
test for a termination-resistant child.

## Release Boundary

Before a private installer build, add a redistributable Node runtime per
platform, bundle icons, code sign the application, add first-run settings, and
exercise the packaged app end-to-end.
