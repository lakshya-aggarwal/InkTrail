### Task 4 Report: Source-Chapter API Contract

#### Changed Paths

- `src/app.js` composes the reviewed source import service into the library service.
- `src/services/library-service.js` binds the path novel ID to source import input and exposes created status.
- `src/http/router.js` adds `POST /api/v1/novels/{novelId}/source-chapters` and maps `SourceFetchError` to the stable retryable `502` response without upstream text.
- `src/sources/source-import-service.js` reports whether import created new records so the route can return `201` or idempotent `200`.
- `test/http/app.test.js`, `test/support/http.js`, and `test/sources/source-import-service.test.js` cover injected fixture import, idempotency, JSON media, validation, missing/unsupported/conflicting sources, and sanitized fetch failure behavior.
- `openapi/inktrail.v1.yaml` documents the route, request/response schemas, and `502` source fetch response.
- `postman/InkTrail Foundation.postman_collection.json` adds source import requests for success, validation, unsupported source, missing novel, conflict, and fetch failure.

#### Validation

- `pnpm exec node --test test/http/app.test.js` - 11 passed.
- `pnpm test` - 44 passed.
- `pnpm exec playwright test` - 8 passed across desktop and mobile Chromium.
- `pnpm exec redocly lint openapi/inktrail.v1.yaml` - valid, with three pre-existing recommended-rule warnings for API license and missing `4xx` responses on health/list operations.
- `git diff --check` - passed.

#### Limitations

- Tests use an injected local HTML fixture only. No live source request, new adapter, job, translation, or UI behavior was added.
- Validation used the available Node `v24.13.0`; `package.json` declares `>=24.19.0`.
