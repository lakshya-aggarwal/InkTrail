import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';

function repositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  return {
    database,
    novels: createNovelRepository(database, () => new Date('2026-10-11T00:00:00.000Z'))
  };
}

test('creates and lists camelCase novel records', (t) => {
  const { database, novels } = repositories();
  t.after(() => database.close());

  const novel = novels.createNovel({ title: '  Ink Trail  ', sourceUrl: 'https://example.test/ink-trail' });

  assert.deepEqual(novels.getNovel(novel.id), novel);
  assert.deepEqual(novels.listNovels(), [novel]);
});

test('validates novel inputs and reports absent novels', (t) => {
  const { database, novels } = repositories();
  t.after(() => database.close());

  assert.throws(() => novels.createNovel({ title: ' ' }), ValidationError);
  assert.throws(() => novels.createNovel({ title: 'Ink Trail', sourceUrl: 'not a URL' }), ValidationError);
  assert.throws(() => novels.getNovel('missing'), NotFoundError);
});
