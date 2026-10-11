# Runtime Foundation

`src/app.js` is the HTTP composition boundary. It creates the local HTTP server
and owns route selection, while accepting `databasePath` so later tasks can add
repositories without changing the runtime interface.

`src/server-runtime.js` starts that application on an explicit loopback port.
`src/server.js` supplies the process-level data directory and database path.
Tests use the same application boundary through `test/support/http.js` and an
ephemeral port.

Task 1 intentionally has no database connection, repository, migration, or
reader UI. Those dependencies are introduced by later tasks and remain scoped
to their novel records when persistence begins.
