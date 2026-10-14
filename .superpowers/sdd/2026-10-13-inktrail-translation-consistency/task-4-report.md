# Task 4 Report - Local API Contract

## Changed Paths

- `scripts/source-fixture-server.js`
- `src/app.js`
- `src/http/router.js`
- `test/support/http.js`
- `test/http/translation-consistency.test.js`
- `openapi/inktrail.v1.yaml`
- `postman/InkTrail Foundation.postman_collection.json`

## Delivered

- Direct local routes translate an imported source chapter, submit and list
  feedback, verify feedback, and list verified memory scoped to one novel.
- The fixture server and HTTP helper inject a deterministic local translation
  provider, so automated checks do not call Ollama or an external source.
- Translation-provider failures use the stable sanitized 502 envelope and do
  not expose prompts, provider details, or upstream responses.
- OpenAPI and the fixture-only Postman collection describe and exercise the
  new routes.

## Validation

- Focused HTTP contracts: 3 passed.
- Full suite: 70 passed with Node v24.13.0.
- `pnpm exec redocly lint openapi/inktrail.v1.yaml`: valid, with the three
  pre-existing recommended-rule warnings for license metadata and missing 4XX
  responses on read-only health and library-list operations.
- Postman collection JSON validation and `git diff --check` passed.

## Limits

- No UI, jobs, queues, adapters, EPUB work, dependencies, or live provider
  calls were added.

## Fix Round 1 Evidence

- OpenAPI now models approved feedback decisions separately from rejected and
  needs-review decisions. Approval requires verified memory; non-approved
  decisions require only their status.
- The HTTP contract test verifies that `{ "status": "approved" }` returns
  the existing `400 validation_error` envelope with `sourceTerm is required`,
  then confirms that a complete approval still succeeds.
- Fix validation: focused HTTP contracts passed 3 tests, the full suite passed
  70 tests, OpenAPI lint remained valid with the same three existing warnings,
  and `git diff --check` passed.
