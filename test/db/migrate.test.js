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
    'feedback_reports',
    'memory_entries',
    'novel_sources',
    'novels',
    'reading_progress',
    'schema_migrations',
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

  assert.equal(database.prepare('select count(*) as count from schema_migrations').get().count, 6);
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
