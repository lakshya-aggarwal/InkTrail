# Runtime Foundation

`src/app.js` is the HTTP composition boundary. It creates the local HTTP server
and owns route selection, while accepting `databasePath` so later tasks can add
repositories without changing the runtime interface. It also serves the fixed
browser reader assets from `public/` at `/`, `/app.js`, and `/styles.css`; API
requests continue to pass through the existing router unchanged.

`src/server-runtime.js` starts that application on an explicit loopback port.
`src/server.js` supplies the process-level data directory and database path.
Tests use the same application boundary through `test/support/http.js` and an
ephemeral port.

The browser reader consumes the library, reader-chapter, and reading-progress
HTTP routes. Its selected chapter is shareable through `?novel=<id>&chapter=<number>`;
chapter navigation persists the selected number after the next chapter is
available, then moves keyboard focus to the chapter heading and resets scroll.
