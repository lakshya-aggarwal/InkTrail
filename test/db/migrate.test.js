import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';

test('migration creates library and source provenance tables', () => {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const names = database.prepare("select name from sqlite_master where type = 'table'").all().map(({ name }) => name);

  assert.deepEqual(names.sort(), [
    'chapter_sources',
    'chapters',
    'epub_export_chapters',
    'epub_exports',
    'feedback_reports',
    'job_attempts',
    'job_events',
    'jobs',
    'memory_entries',
    'novel_source_resolutions',
    'novel_sources',
    'novels',
    'reading_progress',
    'schema_migrations',
    'source_catalog_entries',
    'source_catalogs',
    'source_resolution_attempts',
    'source_resolution_candidates',
    'translation_quality_findings',
    'translation_revisions'
  ]);
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

test('migrations are recorded once and source foreign keys are enforced', () => {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  migrate(database);

  assert.equal(database.prepare('select count(*) as count from schema_migrations').get().count, 12);
  assert.throws(() => database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'missing-novel', 1, 'One', '2026-10-11T00:00:00.000Z'));
  assert.throws(() => database.prepare(`
    insert into novel_sources (id, novel_id, site, external_novel_id, source_url, normalized_url, selected_at, created_at)
    values ('source-a', 'missing-novel', 'kujiang', '9', 'https://www.kujiang.com/book/9', 'https://www.kujiang.com/book/9', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')
  `).run());
  assert.throws(() => database.prepare(`
    insert into chapter_sources (id, novel_id, chapter_id, novel_source_id, site, external_chapter_id, source_url, normalized_url, source_title, fetched_at, content_sha256, created_at)
    values ('chapter-source-a', 'missing-novel', 'missing-chapter', 'missing-source', 'kujiang', '906595', 'https://www.kujiang.com/book/9/906595', 'https://www.kujiang.com/book/9/906595', 'One', '2026-10-12T00:00:00.000Z', 'hash-a', '2026-10-12T00:00:00.000Z')
  `).run());
});

test('additive migration preserves existing translation revisions', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  database.exec(readFileSync(new URL('../../src/db/migrations/001-library.sql', import.meta.url), 'utf8'));
  database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(1, '2026-10-11T00:00:00.000Z');
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'novel-a', 1, 'One', '2026-10-11T00:00:00.000Z');
  database.prepare('insert into translation_revisions (id, chapter_id, revision, translated_text, provider, model, created_at) values (?, ?, ?, ?, ?, ?, ?)').run('revision-a', 'chapter-a', 1, 'First', 'test', 'test', '2026-10-11T00:00:00.000Z');

  migrate(database);

  assert.equal(database.prepare('select translated_text from translation_revisions where id = ?').get('revision-a').translated_text, 'First');
  assert.equal(database.prepare("select count(*) as count from sqlite_master where type = 'table' and name in ('translation_quality_findings', 'memory_entries', 'feedback_reports')").get().count, 3);
});

test('ownership triggers reject direct cross-novel translation records', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  migrate(database);
  const now = '2026-10-13T00:00:00.000Z';
  const insertNovel = database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)');
  const insertChapter = database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)');
  const insertRevision = database.prepare('insert into translation_revisions (id, chapter_id, revision, translated_text, provider, model, created_at) values (?, ?, ?, ?, ?, ?, ?)');
  insertNovel.run('novel-a', 'A', now, now);
  insertNovel.run('novel-b', 'B', now, now);
  insertChapter.run('chapter-a', 'novel-a', 1, 'One', now);
  insertChapter.run('chapter-b', 'novel-b', 2, 'Two', now);
  insertRevision.run('revision-a', 'chapter-a', 1, 'A', 'test', 'test', now);
  insertRevision.run('revision-b', 'chapter-b', 1, 'B', 'test', 'test', now);

  assert.throws(() => database.prepare(`
    insert into translation_quality_findings (id, novel_id, translation_revision_id, kind, details, created_at)
    values ('finding-a', 'novel-a', 'revision-b', 'gap', 'gap', ?)
  `).run(now));
  assert.throws(() => database.prepare(`
    insert into feedback_reports (
      id, novel_id, chapter_id, translation_revision_id, selected_text, source_context, translated_context,
      proposed_correction, reason, status, created_at, updated_at
    ) values ('feedback-a', 'novel-a', 'chapter-a', 'revision-b', 'text', 'source', 'translation', 'correction', 'reason', 'pending', ?, ?)
  `).run(now, now));
  database.prepare(`
    insert into translation_quality_findings (id, novel_id, translation_revision_id, kind, details, created_at)
    values ('finding-b', 'novel-a', 'revision-a', 'gap', 'gap', ?)
  `).run(now);
  assert.throws(() => database.prepare("update translation_revisions set chapter_id = 'chapter-b' where id = 'revision-a'").run(), /translation revision chapter cannot change/);
  database.prepare(`
    insert into feedback_reports (
      id, novel_id, chapter_id, translation_revision_id, selected_text, source_context, translated_context,
      proposed_correction, reason, status, created_at, updated_at
    ) values ('feedback-b', 'novel-a', 'chapter-a', 'revision-a', 'text', 'source', 'translation', 'correction', 'reason', 'pending', ?, ?)
  `).run(now, now);
  assert.throws(() => database.prepare("update chapters set novel_id = 'novel-b' where id = 'chapter-a'").run(), /chapter novel cannot change/);
  assert.equal(database.prepare("select novel_id from chapters where id = 'chapter-a'").get().novel_id, 'novel-a');
  assert.equal(database.prepare("select chapter_id from translation_revisions where id = 'revision-a'").get().chapter_id, 'chapter-a');
});

test('version 4 databases with invalid ownership require repair before migration 5', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-13T00:00:00.000Z';
  for (const [version, name] of [[1, '001-library.sql'], [2, '002-sources.sql'], [3, '003-normalize-kujiang-novel-source-urls.sql'], [4, '004-translation-consistency.sql']]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-b', 'B', now, now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'novel-a', 1, 'One', now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-b', 'novel-b', 1, 'One', now);
  database.prepare('insert into translation_revisions (id, chapter_id, revision, translated_text, provider, model, created_at) values (?, ?, ?, ?, ?, ?, ?)').run('revision-b', 'chapter-b', 1, 'B', 'test', 'test', now);
  database.prepare(`
    insert into translation_quality_findings (id, novel_id, translation_revision_id, kind, details, created_at)
    values ('finding-a', 'novel-a', 'revision-b', 'gap', 'gap', ?)
  `).run(now);
  database.prepare(`
    insert into feedback_reports (
      id, novel_id, chapter_id, translation_revision_id, selected_text, source_context, translated_context,
      proposed_correction, reason, status, created_at, updated_at
    ) values ('feedback-a', 'novel-a', 'chapter-a', 'revision-b', 'text', 'source', 'translation', 'correction', 'reason', 'pending', ?, ?)
  `).run(now, now);

  assert.throws(() => migrate(database), /repair required: cross-novel translation consistency records/);
  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 5').get().count, 0);
});

test('version 8 databases with invalid job checkpoints require repair before migration 9', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-15T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'],
    [2, '002-sources.sql'],
    [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'],
    [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'],
    [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  const insertNovel = database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)');
  insertNovel.run('novel-a', 'A', now, now);
  insertNovel.run('novel-b', 'B', now, now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'novel-a', 1, 'One', now);
  database.prepare(`
    insert into jobs (id, novel_id, type, target_json, target_hash, idempotency_key, state, priority, current_chapter_id, created_at, updated_at)
    values ('job-a', 'novel-a', 'translate_chapters', '{"chapterNumbers":[1]}', 'hash-a', 'key-a', 'queued', 0, 'chapter-a', ?, ?)
  `).run(now, now);
  database.prepare("update chapters set novel_id = 'novel-b' where id = 'chapter-a'").run();

  assert.throws(() => migrate(database), /repair required: cross-novel job checkpoints/);
  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 9').get().count, 0);
});

test('version 8 databases with valid job checkpoints upgrade through migration 10', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-15T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'],
    [2, '002-sources.sql'],
    [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'],
    [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'],
    [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'novel-a', 1, 'One', now);
  database.prepare(`
    insert into jobs (id, novel_id, type, target_json, target_hash, idempotency_key, state, priority, current_chapter_id, created_at, updated_at)
    values ('job-a', 'novel-a', 'translate_chapters', '{"chapterNumbers":[1]}', 'hash-a', 'key-a', 'queued', 0, 'chapter-a', ?, ?)
  `).run(now, now);

  migrate(database);

  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 10').get().count, 1);
  assert.equal(database.prepare("select novel_id from chapters where id = 'chapter-a'").get().novel_id, 'novel-a');
});

test('version 9 databases retain valid durable job attempts through migration 10', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-17T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'],
    [2, '002-sources.sql'],
    [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'],
    [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'],
    [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql'],
    [9, '009-guard-job-checkpoint-chapter-ownership.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'novel-a', 1, 'One', now);
  database.prepare(`
    insert into jobs (id, novel_id, type, target_json, target_hash, state, priority, claimed_at, claim_token, current_chapter_id, created_at, updated_at)
    values ('job-a', 'novel-a', 'translate_chapters', '{"chapterNumbers":[1]}', 'hash-a', 'running', 0, ?, 'claim-a', 'chapter-a', ?, ?)
  `).run(now, now, now);
  database.prepare(`
    insert into job_attempts (id, job_id, novel_id, chapter_id, attempt_number, state, started_at, claim_token)
    values ('attempt-a', 'job-a', 'novel-a', 'chapter-a', 1, 'started', ?, 'claim-a')
  `).run(now);

  migrate(database);

  assert.equal(database.prepare('select count(*) as count from jobs where id = ?').get('job-a').count, 1);
  assert.equal(database.prepare('select count(*) as count from job_attempts where id = ?').get('attempt-a').count, 1);
  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 10').get().count, 1);
});

test('version 10 databases with malformed durable attempts require repair before migration 11', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-17T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'], [2, '002-sources.sql'], [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'], [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'], [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql'], [9, '009-guard-job-checkpoint-chapter-ownership.sql'],
    [10, '010-kujiang-source-catalogs.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare(`insert into jobs (id, novel_id, type, target_json, target_hash, state, priority, claimed_at, claim_token, created_at, updated_at)
    values ('job-a', 'novel-a', 'translate_chapters', '{"chapterNumbers":[1]}', 'hash-a', 'running', 0, ?, 'claim-a', ?, ?)`)
    .run(now, now, now);
  database.exec('drop trigger job_attempts_ownership_on_insert; drop trigger job_attempts_target_on_insert;');
  database.prepare(`insert into job_attempts (id, job_id, novel_id, chapter_id, attempt_number, state, started_at, claim_token)
    values ('attempt-a', 'job-a', 'novel-a', null, 1, 'started', ?, 'claim-a')`).run(now);

  assert.throws(() => migrate(database), /repair required: invalid durable job records/);
  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 11').get().count, 0);
});

test('version 10 databases with an EPUB chapter checkpoint require repair before migration 11', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-17T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'], [2, '002-sources.sql'], [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'], [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'], [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql'], [9, '009-guard-job-checkpoint-chapter-ownership.sql'],
    [10, '010-kujiang-source-catalogs.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'novel-a', 1, 'One', now);
  database.prepare(`insert into epub_exports (id, novel_id, state, selection_json, snapshot_at, file_name, created_at, updated_at)
    values ('export-a', 'novel-a', 'queued', '{"chapterNumbers":[1]}', ?, 'export-a.epub', ?, ?)`).run(now, now, now);
  database.prepare(`insert into jobs (id, novel_id, type, target_json, target_hash, state, priority, current_chapter_id, created_at, updated_at)
    values ('job-a', 'novel-a', 'build_epub', '{"exportId":"export-a"}', 'hash-a', 'queued', 0, 'chapter-a', ?, ?)`).run(now, now);

  assert.throws(() => migrate(database), /repair required: invalid durable job records/);
  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 11').get().count, 0);
});

test('version 10 databases preserve existing EPUB job references through migration 11', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-17T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'], [2, '002-sources.sql'], [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'], [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'], [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql'], [9, '009-guard-job-checkpoint-chapter-ownership.sql'],
    [10, '010-kujiang-source-catalogs.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare(`insert into epub_exports (id, novel_id, job_id, state, selection_json, snapshot_at, file_name, created_at, updated_at)
    values ('export-a', 'novel-a', null, 'queued', '{"chapterNumbers":[1]}', ?, 'export-a.epub', ?, ?)`).run(now, now, now);
  database.prepare(`insert into jobs (id, novel_id, type, target_json, target_hash, state, priority, created_at, updated_at)
    values ('job-a', 'novel-a', 'build_epub', '{"exportId":"export-a"}', 'hash-a', 'queued', 0, ?, ?)`).run(now, now);
  database.prepare("update epub_exports set job_id = 'job-a' where id = 'export-a'").run();

  migrate(database);

  assert.equal(database.prepare("select job_id from epub_exports where id = 'export-a'").get().job_id, 'job-a');
  assert.equal(database.prepare("select type from jobs where id = 'job-a'").get().type, 'build_epub');
});

test('version 11 databases with invalid source catalog ownership require repair before migration 12', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-18T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'], [2, '002-sources.sql'], [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'], [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'], [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql'], [9, '009-guard-job-checkpoint-chapter-ownership.sql'],
    [10, '010-kujiang-source-catalogs.sql'], [11, '011-durable-source-import-jobs.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-b', 'B', now, now);
  database.prepare(`insert into novel_sources (id, novel_id, site, external_novel_id, source_url, normalized_url, selected_at, created_at)
    values ('source-a', 'novel-a', 'kujiang', '9', 'https://www.kujiang.com/book/9', 'https://www.kujiang.com/book/9', ?, ?)`).run(now, now);
  database.prepare(`insert into source_catalogs (id, novel_id, novel_source_id, site, canonical_book_url, content_sha256, entry_count, created_at)
    values ('catalog-a', 'novel-a', 'source-a', 'kujiang', 'https://www.kujiang.com/book/9', ?, 1, ?)`).run('a'.repeat(64), now);
  database.exec('drop trigger source_catalogs_immutable_on_update');
  database.prepare("update source_catalogs set novel_id = 'novel-b' where id = 'catalog-a'").run();

  assert.throws(() => migrate(database), /repair required: invalid source resolution ownership/);
  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 12').get().count, 0);
});

test('version 11 databases retain valid source catalogs through migration 12', (t) => {
  const database = openDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const now = '2026-10-18T00:00:00.000Z';
  for (const [version, name] of [
    [1, '001-library.sql'], [2, '002-sources.sql'], [3, '003-normalize-kujiang-novel-source-urls.sql'],
    [4, '004-translation-consistency.sql'], [5, '005-enforce-translation-consistency-ownership.sql'],
    [6, '006-guard-translation-consistency-parent-ownership.sql'], [7, '007-durable-jobs-and-epub.sql'],
    [8, '008-guard-job-targets-and-claims.sql'], [9, '009-guard-job-checkpoint-chapter-ownership.sql'],
    [10, '010-kujiang-source-catalogs.sql'], [11, '011-durable-source-import-jobs.sql']
  ]) {
    database.exec(readFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), 'utf8'));
    database.prepare('insert into schema_migrations (version, applied_at) values (?, ?)').run(version, now);
  }
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare(`insert into novel_sources (id, novel_id, site, external_novel_id, source_url, normalized_url, selected_at, created_at)
    values ('source-a', 'novel-a', 'kujiang', '9', 'https://www.kujiang.com/book/9', 'https://www.kujiang.com/book/9', ?, ?)`).run(now, now);
  database.prepare(`insert into source_catalogs (id, novel_id, novel_source_id, site, canonical_book_url, content_sha256, entry_count, created_at)
    values ('catalog-a', 'novel-a', 'source-a', 'kujiang', 'https://www.kujiang.com/book/9', ?, 1, ?)`).run('a'.repeat(64), now);

  migrate(database);

  assert.equal(database.prepare('select count(*) as count from schema_migrations where version = 12').get().count, 1);
  assert.equal(database.prepare("select novel_source_id from source_catalogs where id = 'catalog-a'").get().novel_source_id, 'source-a');
});

test('source site identities are unique', () => {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const now = '2026-10-12T00:00:00.000Z';
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-a', 'A', now, now);
  database.prepare('insert into novels (id, title, created_at, updated_at) values (?, ?, ?, ?)').run('novel-b', 'B', now, now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'novel-a', 1, 'One', now);
  database.prepare(`
    insert into novel_sources (id, novel_id, site, external_novel_id, source_url, normalized_url, selected_at, created_at)
    values ('source-a', 'novel-a', 'kujiang', '9', 'https://www.kujiang.com/book/9', 'https://www.kujiang.com/book/9', ?, ?)
  `).run(now, now);
  assert.throws(() => database.prepare(`
    insert into novel_sources (id, novel_id, site, external_novel_id, source_url, normalized_url, selected_at, created_at)
    values ('source-b', 'novel-a', 'kujiang', '9', 'https://www.kujiang.com/book/9/other', 'https://www.kujiang.com/book/9/other', ?, ?)
  `).run(now, now));
  database.prepare(`
    insert into chapter_sources (id, novel_id, chapter_id, novel_source_id, site, external_chapter_id, source_url, normalized_url, source_title, fetched_at, content_sha256, created_at)
    values ('chapter-source-a', 'novel-a', 'chapter-a', 'source-a', 'kujiang', '906595', 'https://www.kujiang.com/book/9/906595', 'https://www.kujiang.com/book/9/906595', 'One', ?, 'hash-a', ?)
  `).run(now, now);
  database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-b', 'novel-b', 1, 'One', now);
  database.prepare(`
    insert into novel_sources (id, novel_id, site, external_novel_id, source_url, normalized_url, selected_at, created_at)
    values ('source-b', 'novel-b', 'kujiang', '10', 'https://www.kujiang.com/book/10', 'https://www.kujiang.com/book/10', ?, ?)
  `).run(now, now);
  assert.throws(() => database.prepare(`
    insert into chapter_sources (id, novel_id, chapter_id, novel_source_id, site, external_chapter_id, source_url, normalized_url, source_title, fetched_at, content_sha256, created_at)
    values ('chapter-source-b', 'novel-b', 'chapter-b', 'source-b', 'kujiang', '906595', 'https://www.kujiang.com/book/10/906595', 'https://www.kujiang.com/book/10/906595', 'One', ?, 'hash-a', ?)
  `).run(now, now));
});

test('migration acquires an immediate transaction before schema work', () => {
  const commands = [];
  const database = {
    exec(sql) {
      commands.push(sql);
      if (sql.startsWith('create table schema_migrations')) {
        throw new Error('migration failed');
      }
    },
    prepare() {
      return { get: () => undefined };
    }
  };

  assert.throws(() => migrate(database), /migration failed/);
  assert.equal(commands[0], 'begin immediate');
  assert.equal(commands.at(-1), 'rollback');
});
