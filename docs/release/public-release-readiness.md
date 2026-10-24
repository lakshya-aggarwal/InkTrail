# Public-release Readiness

InkTrail is ready for local, single-user use: run it on loopback, use a local
Ollama provider, and keep the SQLite database and EPUB exports on the user's
machine. This is not yet a public hosted release.

## Before a Private Desktop Alpha

- Turn the working Tauri development wrapper into an installable, signed
  desktop application with a redistributable Node runtime for each platform.
- Add a first-run path for provider configuration and local data location.
- A checksum-verified, non-destructive local backup and restore command is now
  available. Surface it in the desktop application and verify it in a packaged
  build.
- Exercise the packaged reader, source import, translation, job recovery, and
  EPUB flow on supported desktop platforms.
- Publish a supported-source policy and confirm that each enabled source is
  fetched within its terms, rate limits, and content-rights constraints.

## Before a Public Hosted Release

- Choose a provider model. A hosted service needs user-owned provider keys or a
  metered server-side provider - it must not expose a local Ollama endpoint or
  rely on a ChatGPT subscription as an API.
- Add authentication, per-user authorization, encrypted secret handling, and
  strict separation for novels, translations, feedback, jobs, EPUB files, and
  backups.
- Add operational controls: rate limits, source-fetch quotas, job limits,
  monitoring, safe error reporting, backup/restore drills, and an incident
  response process.
- Publish privacy, data-retention, copyright, and acceptable-use terms. Obtain
  any required source permissions before redistributing fetched or translated
  chapter text.
- Complete a production security review, dependency update policy, accessibility
  audit, performance testing, and release/rollback procedure.

## Release Decision

Do not set a public launch date until the provider and content-rights decisions
are made. Those choices determine the authentication, billing, storage, and
legal work. The next reasonable milestone is a private desktop alpha after the
installer and backup/restore flow are verified.
