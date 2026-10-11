import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';

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

test('migration is recorded once and foreign keys are enforced', () => {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  migrate(database);

  assert.equal(database.prepare('select count(*) as count from schema_migrations').get().count, 1);
  assert.throws(() => database.prepare('insert into chapters (id, novel_id, chapter_number, title, created_at) values (?, ?, ?, ?, ?)').run('chapter-a', 'missing-novel', 1, 'One', '2026-10-11T00:00:00.000Z'));
});
