# InkTrail Foundation And Reader Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local, persisted multi-novel library and approved reader shell that later source, translation, job, and EPUB modules plug into.

**Architecture:** A dependency-light Node 24 application serves the web UI and resource-oriented local API. Node's built-in SQLite driver stores novels, ordered chapters, append-only translation revisions, and reading progress through focused repositories. The browser uses a small vanilla JavaScript client so the reader layout stays direct, portable, and easy to inspect.

**Tech Stack:** Node.js 24.19.0 or later, native `node:http`, native `node:sqlite`, ECMAScript modules, `node:test`, Playwright, static HTML/CSS/JavaScript, OpenAPI 3.1, Postman Collection v2.1.

**Spec:** [InkTrail multi-novel design](../../specs/2026-10-11-inktrail-multi-novel-design.md)

## Scope

This is Plan 1 of the InkTrail delivery sequence. It delivers a working local
library and reader with persisted data and an API contract. It does not fetch
external web pages, call Ollama, run background jobs, maintain translation
memory, import legacy JSON, or generate EPUB files. Those are separate plans
because their failure modes and test fixtures are independent from this
foundation.

## File Structure

```text
package.json                               scripts and tool versions
src/server.js                              process startup and graceful close
src/server-runtime.js                      listening server helper
src/app.js                                 HTTP application composition
src/http/json.js                           JSON parsing and response helpers
src/http/router.js                         route matching and API error shape
src/db/database.js                         SQLite open, pragma, and transaction helper
src/db/migrate.js                          ordered migration runner
src/db/migrations/001-library.sql          foundational local schema
src/novels/novel-repository.js             validated novel persistence
src/chapters/chapter-repository.js          ordered chapters and translation revisions
src/reading/progress-repository.js          last-read chapter persistence
src/services/library-service.js             domain operations used by HTTP routes
public/index.html                          application shell
public/app.js                              library, reader, and keyboard interactions
public/styles.css                          approved cozy reader design
playwright.config.js                       local browser-test server configuration
openapi/inktrail.v1.yaml                   foundation HTTP contract
postman/InkTrail Foundation.postman_collection.json
test/db/migrate.test.js                    migration and constraint tests
test/novels/novel-repository.test.js       novel persistence tests
test/chapters/chapter-repository.test.js   chapter and revision tests
test/reading/progress-repository.test.js   progress tests
test/http/app.test.js                      API contract tests
test/e2e/reader.spec.js                    browser workflow and layout tests
docs/architecture/foundation.md            implementation boundary record
docs/reviews/2026-10-11-foundation-review.md
```

## Global Constraints

- Keep the legacy repository `/Users/lakshya/Documents/Books/WebNovels` unchanged.
- Use SQLite through Node's built-in `node:sqlite`; do not add a native SQLite package.
- Keep every persisted record scoped by `novel_id` where the record represents novel content.
- Store current and historical English translations as revisions; never overwrite prior text.
- Use ASCII in source, documentation, UI copy, and commit messages unless source text requires otherwise.
- Do not create a manual `CHANGELOG.md`.
- Use `GET`, `POST`, and `PATCH` only as defined by the OpenAPI contract in this plan.
- Keep the reader accessible with semantic controls, visible focus, and keyboard navigation.
- Run desktop and mobile browser checks before accepting the slice.

## Review Focus

- Two novels with identical chapter numbers must remain independent; test this in `chapter-repository.test.js`.
- A malformed or duplicate chapter request must fail without changing existing text; test this in `app.test.js`.
- A newly created translation revision must leave the preceding revision readable in storage; test this in `chapter-repository.test.js`.
- Arrow keys must not navigate chapters while a text input has focus; test this in `reader.spec.js`.
- A narrow mobile viewport must keep chapter navigation, report control, and text within the viewport; test this in `reader.spec.js` with a screenshot assertion.

---

### Task 1: Establish The Local Runtime And Test Harness

**Files:**
- Create: `package.json`
- Create: `src/server.js`
- Create: `src/server-runtime.js`
- Create: `src/app.js`
- Create: `playwright.config.js`
- Create: `test/support/http.js`
- Create: `test/http/health.test.js`
- Create: `docs/architecture/foundation.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `createApp({ databasePath }): { server, close }` from `src/app.js`.
- Produces: `startServer({ port, databasePath }): Promise<{ server, close, url }>` from `src/server-runtime.js`.
- Produces: `startTestApp(options): Promise<{ request, close }>` from `test/support/http.js`.
- Produces: `GET /api/v1/health` with `{ "status": "ok" }`.

- [ ] **Step 1: Create the package scripts and verify the runtime supports native SQLite**

```json
{
  "name": "inktrail",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.19.0" },
  "scripts": {
    "dev": "node --watch src/server.js",
    "start": "node src/server.js",
    "test": "node --test",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@redocly/cli": "^1.30.0"
  }
}
```

Run: `node -e "console.log(Boolean(require('node:sqlite').DatabaseSync))"`

Expected: `true`.

- [ ] **Step 2: Write the failing health test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from '../support/http.js';

test('GET /api/v1/health returns an ok status', async () => {
  const app = await startTestApp();
  const response = await app.request('/api/v1/health');

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  await app.close();
});
```

- [ ] **Step 3: Run the health test to verify it fails**

Run: `node --test test/http/health.test.js`

Expected: FAIL because `src/app.js` does not exist.

- [ ] **Step 4: Implement the smallest HTTP composition boundary**

```js
// src/app.js
import { createServer } from 'node:http';

export function createApp({ databasePath }) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'Route not found', retryable: false } }));
  });

  return { server, close: () => new Promise((resolve) => server.close(resolve)) };
}
```

Add an app test helper that starts the server on port `0`, exposes `request`,
and closes the server after each test:

```js
// test/support/http.js
import { once } from 'node:events';
import { createApp } from '../../src/app.js';

export async function startTestApp({ databasePath = ':memory:' } = {}) {
  const app = createApp({ databasePath });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    request: (path, options) => fetch(`${baseUrl}${path}`, options),
    close: app.close
  };
}
```

Keep `databasePath` in the application signature even though Task 1 does not
open it yet.

Add `src/server.js` so every process uses one explicit data directory and port:

```js
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './server-runtime.js';

const dataDirectory = process.env.INKTRAIL_DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(dataDirectory, { recursive: true });
await startServer({
  port: Number(process.env.PORT ?? 4177),
  databasePath: join(dataDirectory, 'inktrail.sqlite')
});
```

Put the `startServer` implementation in `src/server-runtime.js`, update the
file structure accordingly, and add `.test-data/` to `.gitignore:

```js
// src/server-runtime.js
import { once } from 'node:events';
import { createApp } from './app.js';

export async function startServer({ port, databasePath }) {
  const app = createApp({ databasePath });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  return { ...app, url: `http://127.0.0.1:${address.port}` };
}
```

```js
// playwright.config.js
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  use: { baseURL: 'http://127.0.0.1:4177' },
  webServer: {
    command: 'PORT=4177 INKTRAIL_DATA_DIR=.test-data node src/server.js',
    url: 'http://127.0.0.1:4177/api/v1/health',
    reuseExistingServer: false
  }
});
```

- [ ] **Step 5: Run the unit suite and document the boundary**

Run: `node --test`

Expected: PASS.

Write `docs/architecture/foundation.md` explaining that `src/app.js` composes
HTTP dependencies while repositories are introduced in later tasks. Add
`data/` and Playwright output directories to `.gitignore` if absent.

- [ ] **Step 6: Commit the runtime baseline**

```bash
git add package.json src test docs/architecture/foundation.md .gitignore
git commit -m "feat: add InkTrail runtime baseline"
```

### Task 2: Add Versioned SQLite Library Storage

**Files:**
- Create: `src/db/database.js`
- Create: `src/db/migrate.js`
- Create: `src/db/migrations/001-library.sql`
- Create: `test/db/migrate.test.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces: `openDatabase({ databasePath }): DatabaseSync` from `src/db/database.js`.
- Produces: `migrate(database): void` from `src/db/migrate.js`.
- Consumes: `databasePath` supplied to `createApp`.

- [ ] **Step 1: Write migration tests for required tables and constraints**

```js
test('migration creates novel, chapter, revision, and progress tables', () => {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const names = database.prepare("select name from sqlite_master where type = 'table'").all().map(({ name }) => name);

  assert.deepEqual(names.sort(), ['chapters', 'novels', 'reading_progress', 'schema_migrations', 'translation_revisions']);
});

test('a chapter number is unique only within its novel', () => {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-b', 'B', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
  const insertChapter = database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)');
  insertChapter.run('chapter-a', 'novel-a', 1, 'One', '2026-10-11T00:00:00.000Z');
  insertChapter.run('chapter-b', 'novel-b', 1, 'One', '2026-10-11T00:00:00.000Z');

  assert.equal(database.prepare('select count(*) as count from chapters where chapter_number = 1').get().count, 2);
});
```

- [ ] **Step 2: Run migration tests to verify they fail**

Run: `node --test test/db/migrate.test.js`

Expected: FAIL because `openDatabase` and `migrate` do not exist.

- [ ] **Step 3: Implement connection setup and the first migration**

```sql
create table schema_migrations (
  version integer primary key,
  applied_at text not null
);

create table novels (
  id text primary key,
  title text not null,
  source_url text,
  created_at text not null,
  updated_at text not null
);

create table chapters (
  id text primary key,
  novel_id text not null references novels(id) on delete restrict,
  chapter_number integer not null check (chapter_number > 0),
  title text not null,
  original_text text,
  source_url text,
  created_at text not null,
  unique (novel_id, chapter_number)
);

create table translation_revisions (
  id text primary key,
  chapter_id text not null references chapters(id) on delete restrict,
  revision integer not null check (revision > 0),
  translated_text text not null,
  provider text not null,
  model text not null,
  created_at text not null,
  unique (chapter_id, revision)
);

create table reading_progress (
  novel_id text primary key references novels(id) on delete restrict,
  chapter_number integer not null check (chapter_number > 0),
  updated_at text not null
);
```

Use `DatabaseSync`, enable foreign keys with `pragma foreign_keys = on`, and
apply each numbered SQL file inside a transaction. Record the migration version
only after the SQL succeeds.

- [ ] **Step 4: Run migration tests to verify they pass**

Run: `node --test test/db/migrate.test.js`

Expected: PASS.

- [ ] **Step 5: Commit SQLite storage**

```bash
git add src/db test/db src/app.js
git commit -m "feat: add versioned library storage"
```

### Task 3: Implement Novel, Chapter, Revision, And Progress Repositories

**Files:**
- Create: `src/novels/novel-repository.js`
- Create: `src/chapters/chapter-repository.js`
- Create: `src/reading/progress-repository.js`
- Create: `test/novels/novel-repository.test.js`
- Create: `test/chapters/chapter-repository.test.js`
- Create: `test/reading/progress-repository.test.js`

**Interfaces:**
- Produces: `createNovel(input)`, `listNovels()`, and `getNovel(novelId)`.
- Produces: `recordChapter(input)`, `addTranslationRevision(input)`, and `getReaderChapter(novelId, chapterNumber)`.
- Produces: `setReadingProgress(input)` and `getReadingProgress(novelId)`.
- Input shape for `recordChapter`: `{ novelId, chapterNumber, title, originalText, sourceUrl }`.
- Input shape for `addTranslationRevision`: `{ chapterId, translatedText, provider, model }`.

- [ ] **Step 1: Write failing repository tests**

```js
test('translation revisions append instead of overwriting prior text', () => {
  const chapter = repositories.chapters.recordChapter({ novelId, chapterNumber: 1, title: 'Arrival', originalText: 'Chinese', sourceUrl: null });
  repositories.chapters.addTranslationRevision({ chapterId: chapter.id, translatedText: 'First', provider: 'test', model: 'test' });
  repositories.chapters.addTranslationRevision({ chapterId: chapter.id, translatedText: 'Second', provider: 'test', model: 'test' });

  assert.equal(repositories.chapters.getReaderChapter(novelId, 1).translatedText, 'Second');
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText), ['First', 'Second']);
});

test('progress for one novel cannot change another novel', () => {
  const first = repositories.novels.createNovel({ title: 'First' });
  const second = repositories.novels.createNovel({ title: 'Second' });
  repositories.progress.setReadingProgress({ novelId: first.id, chapterNumber: 4 });
  repositories.progress.setReadingProgress({ novelId: second.id, chapterNumber: 9 });

  assert.equal(repositories.progress.getReadingProgress(first.id).chapterNumber, 4);
  assert.equal(repositories.progress.getReadingProgress(second.id).chapterNumber, 9);
});
```

- [ ] **Step 2: Run repository tests to verify they fail**

Run: `node --test test/novels test/chapters test/reading`

Expected: FAIL because repository modules do not exist.

- [ ] **Step 3: Implement validation and persistence with stable identifiers**

```js
export function createNovelRepository(database, clock) {
  return {
    createNovel({ title, sourceUrl = null }) {
      if (typeof title !== 'string' || title.trim().length === 0) throw new ValidationError('title is required');
      if (sourceUrl !== null && !URL.canParse(sourceUrl)) throw new ValidationError('sourceUrl must be an absolute URL');
      const now = clock().toISOString();
      const novel = { id: crypto.randomUUID(), title: title.trim(), sourceUrl, createdAt: now, updatedAt: now };
      database.prepare(`
        insert into novels (id, title, source_url, created_at, updated_at)
        values (@id, @title, @sourceUrl, @createdAt, @updatedAt)
      `).run(novel);
      return novel;
    }
  };
}
```

Each repository must validate at the trust boundary, return camelCase records,
and preserve all historical revisions. `getReaderChapter` returns the current
revision plus `previousChapterNumber` and `nextChapterNumber` derived from
stored chapter order.

- [ ] **Step 4: Run repository tests to verify they pass**

Run: `node --test test/novels test/chapters test/reading`

Expected: PASS.

- [ ] **Step 5: Commit repository behavior**

```bash
git add src/novels src/chapters src/reading test/novels test/chapters test/reading
git commit -m "feat: persist novels and reading revisions"
```

### Task 4: Publish The Foundation HTTP Contract And Routes

**Files:**
- Create: `src/http/json.js`
- Create: `src/http/router.js`
- Create: `src/services/library-service.js`
- Create: `openapi/inktrail.v1.yaml`
- Create: `postman/InkTrail Foundation.postman_collection.json`
- Create: `test/http/app.test.js`
- Modify: `src/app.js`

**Interfaces:**
- Produces: `createLibraryService(repositories)` with `createNovel`, `listNovels`, `recordChapter`, `getReaderChapter`, and `setReadingProgress` methods.
- Produces: a stable JSON error shape: `{ error: { code, message, retryable, resourceId? } }`.
- Produces: the following routes:
  - `GET /api/v1/health`
  - `GET /api/v1/novels`
  - `POST /api/v1/novels`
  - `GET /api/v1/novels/{novelId}`
  - `POST /api/v1/novels/{novelId}/chapters`
  - `GET /api/v1/novels/{novelId}/chapters/{chapterNumber}`
  - `PATCH /api/v1/novels/{novelId}/reading-progress`

- [ ] **Step 1: Add failing API contract tests**

```js
test('POST /api/v1/novels creates a novel and GET lists it', async () => {
  const created = await requestJson(app, 'POST', '/api/v1/novels', { title: 'Return of the War God', sourceUrl: 'https://example.test/book/war-god' });
  assert.equal(created.status, 201);

  const listed = await requestJson(app, 'GET', '/api/v1/novels');
  assert.deepEqual(listed.body.items.map(({ id, title }) => ({ id, title })), [{ id: created.body.id, title: 'Return of the War God' }]);
});

test('a duplicate chapter request returns conflict without replacing the original', async () => {
  const novel = await requestJson(app, 'POST', '/api/v1/novels', { title: 'Return of the War God' });
  const first = await requestJson(app, 'POST', `/api/v1/novels/${novel.body.id}/chapters`, { chapterNumber: 1, title: 'Arrival', originalText: 'Original Chinese' });
  const duplicate = await requestJson(app, 'POST', `/api/v1/novels/${novel.body.id}/chapters`, { chapterNumber: 1, title: 'Replacement', originalText: 'Replacement text' });
  const stored = await requestJson(app, 'GET', `/api/v1/novels/${novel.body.id}/chapters/1`);

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 409);
  assert.equal(stored.body.originalText, 'Original Chinese');
});
```

Use this test helper in the same file:

```js
async function requestJson(app, method, path, body) {
  const response = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
```

Create a fresh `app` with `startTestApp()` in `beforeEach` and close it in
`afterEach` so tests cannot share SQLite state:

```js
import { afterEach, beforeEach, test } from 'node:test';
import { startTestApp } from '../support/http.js';

let app;
beforeEach(async () => { app = await startTestApp(); });
afterEach(async () => { await app.close(); });
```

- [ ] **Step 2: Run API tests to verify they fail**

Run: `node --test test/http/app.test.js`

Expected: FAIL because the library routes are not registered.

- [ ] **Step 3: Implement routes, body parsing, and contract artifacts**

```yaml
post:
  operationId: createNovel
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required: [title]
          properties:
            title: { type: string, minLength: 1 }
            sourceUrl: { type: string, format: uri }
  responses:
    '201': { description: Novel created }
    '400': { $ref: '#/components/responses/ValidationError' }
```

Use `POST` only for resource creation and `PATCH` only for reading progress.
Reject non-JSON request bodies with `415`; reject malformed JSON with `400`;
return `404` for missing novel or chapter identifiers; return `409` for duplicate
chapter numbers. Mirror each endpoint in the local Postman collection with the
same JSON examples. Do not push Postman artifacts to a cloud workspace.

- [ ] **Step 4: Run API tests and validate the OpenAPI document**

Run: `node --test test/http`

Expected: PASS.

Run: `pnpm exec @redocly/cli lint openapi/inktrail.v1.yaml`

Expected: PASS with no contract errors.

- [ ] **Step 5: Commit the API slice**

```bash
git add src/http src/services src/app.js openapi postman test/http package.json pnpm-lock.yaml
git commit -m "feat: add library API contract"
```

### Task 5: Build The Library And Approved Reader Interface

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`
- Create: `public/styles.css`
- Create: `test/e2e/reader.spec.js`
- Modify: `src/app.js`
- Modify: `docs/architecture/foundation.md`

**Interfaces:**
- Consumes: the library and reader routes from Task 4.
- Produces: a `/` browser experience with a library, novel creation form,
  centered reader, reader-state URL query `?novel=<id>&chapter=<number>`, and
  keyboard chapter navigation.

- [ ] **Step 1: Write failing browser tests for library and reading behavior**

```js
async function seedNovelWithChapters(request, { chapterNumbers }) {
  const novel = await request.post('/api/v1/novels', { data: { title: 'Seeded novel' } });
  const novelBody = await novel.json();
  for (const chapterNumber of chapterNumbers) {
    await request.post(`/api/v1/novels/${novelBody.id}/chapters`, {
      data: { chapterNumber, title: `Chapter ${chapterNumber} title`, originalText: `Chapter ${chapterNumber} text` }
    });
  }
  return novelBody.id;
}

async function readProgress(request, novelId) {
  const response = await request.get(`/api/v1/novels/${novelId}`);
  return (await response.json()).readingProgress.chapterNumber;
}

test('reader navigation updates chapter, scroll position, and reading progress', async ({ page }) => {
  const novelId = await seedNovelWithChapters(page.request, { chapterNumbers: [1, 2] });
  await page.goto(`/?novel=${novelId}&chapter=1`);
  await page.getByRole('button', { name: 'Next chapter' }).click();

  await expect(page.getByRole('heading', { name: 'Chapter 2 title' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(() => readProgress(page.request, novelId)).toBe(2);
});

test('arrow keys do not navigate while the novel title input has focus', async ({ page }) => {
  await page.goto('/');
  const initialUrl = page.url();
  await page.getByLabel('Novel title').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(initialUrl);
});
```

- [ ] **Step 2: Run browser tests to verify they fail**

Run: `pnpm exec playwright test test/e2e/reader.spec.js`

Expected: FAIL because static assets and reader controls do not exist.

- [ ] **Step 3: Implement the accessible reader shell**

```html
<main>
  <aside aria-label="Your shelf" id="library"></aside>
  <section aria-labelledby="chapter-title" id="reader">
    <nav aria-label="Chapter navigation">
      <button type="button" data-direction="previous" aria-label="Previous chapter">Previous</button>
      <button type="button" data-direction="next" aria-label="Next chapter">Next</button>
    </nav>
    <p id="chapter-number"></p>
    <h1 id="chapter-title"></h1>
    <article id="chapter-text"></article>
    <nav aria-label="Chapter navigation at end of chapter">
      <button type="button" data-direction="previous" aria-label="Previous chapter">Previous</button>
      <button type="button" data-direction="next" aria-label="Next chapter">Next</button>
    </nav>
  </section>
</main>
```

Serve `/` and assets with content types from `src/app.js`. Use event delegation
for the two navigation areas. Only handle ArrowLeft and ArrowRight when the
event target is not an input, textarea, select, or content-editable element.
On successful navigation, change the query string, fetch the next chapter,
persist reading progress, move focus to the chapter heading, and call
`window.scrollTo({ top: 0, behavior: 'instant' })`.

Use the approved paper, ink, moss, and restrained clay palette. Keep controls
flat, familiar, and keyboard-visible. Desktop shows the shelf beside the reader;
mobile collapses the shelf above the reader without hiding navigation controls.

- [ ] **Step 4: Run browser tests and inspect both viewports**

Run: `pnpm exec playwright test test/e2e/reader.spec.js --project=chromium`

Expected: PASS.

Capture and inspect screenshots at `1440x1000` and `390x844`. Confirm that
chapter controls do not overlap prose, text remains within the viewport, the
bottom navigation is visible after a long chapter, and focus remains visible.

- [ ] **Step 5: Commit the reader slice**

```bash
git add public src/app.js test/e2e docs/architecture/foundation.md package.json pnpm-lock.yaml
git commit -m "feat: add multi-novel reader shell"
```

### Task 6: Complete The Foundation Review And Prepare The Next Plan Boundary

**Files:**
- Create: `docs/reviews/2026-10-11-foundation-review.md`
- Modify: `README.md`
- Modify: `docs/roadmap/roadmap.md`

**Interfaces:**
- Consumes: all prior foundation tests and the local API contract.
- Produces: reproducible validation evidence and a documented boundary for the
  source-resolution and translation plan.

- [ ] **Step 1: Run the complete test and contract suite**

Run: `pnpm test`

Expected: PASS.

Run: `pnpm exec playwright test`

Expected: PASS.

Run: `pnpm exec @redocly/cli lint openapi/inktrail.v1.yaml`

Expected: PASS.

- [ ] **Step 2: Exercise persistence across a process restart**

Run: `INKTRAIL_DATA_DIR=$(mktemp -d) pnpm start`

Expected: The server starts with one SQLite file under the temporary directory.

Create a novel and two chapters through the API, stop the server, restart it
with the same `INKTRAIL_DATA_DIR`, then verify the library and progress remain.

- [ ] **Step 3: Record the review evidence**

Write `docs/reviews/2026-10-11-foundation-review.md` with the exact commands,
pass results, screenshot viewport results, known constraints, and a statement
that no legacy repository files changed. Update the README and roadmap to mark
the foundation as complete only after every listed command passes.

- [ ] **Step 4: Commit the reviewed foundation**

```bash
git add README.md docs/reviews docs/roadmap
git commit -m "docs: record foundation validation"
```

## Follow-On Plan Boundaries

The next implementation plan starts at the stable interfaces introduced here:

1. Source resolution and chapter extraction: add `novel_sources` and
   `chapter_sources`, migrate one adapter with fixture-based parsing, and route
   discovered chapters through `recordChapter`.
2. Chinese translation and consistency: add provider, quality, feedback, and
   memory modules that append `translation_revisions` rather than altering the
   reader contract.
3. Durable jobs and EPUB: add job and export schema migrations, then connect
   source and translation stages to persisted retries, prefetch, pause/resume,
   recovery, and ordered EPUB snapshots.
4. Additional adapters and legacy import: migrate source sites one at a time and
   build the opt-in, read-only JSON importer with duplicate review reporting.

## Plan Self-Review

- Spec coverage: the multi-novel local library, SQLite isolation, append-only
  translation revisions, API contract, approved reader layout, keyboard
  navigation, persistence, documentation, and validation are implemented here.
  Source fetching, Ollama, consistency memory, jobs, EPUB, other adapters, and
  legacy import are intentionally delegated to the explicitly named follow-on
  plans because they are independent subsystems.
- Placeholder scan: no unowned implementation placeholders or generic test
  instructions remain.
- Type consistency: `createApp`, repository methods, `createLibraryService`,
  route paths, and browser data flow use the same `novelId`, `chapterNumber`,
  and revision terminology throughout.
- Review focus: all five listed user-risk conditions have a named owning test
  file and test scenario.
