import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceIdentityRepository } from '../../src/sources/source-identity-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

function createRepositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-20T00:00:00.000Z');
  return {
    database,
    novels: createNovelRepository(database, clock),
    identities: createSourceIdentityRepository(database, clock),
    sources: createSourceRepository(database, clock)
  };
}

function identity(bookId, title = `小说 ${bookId}`) {
  return {
    bookUrl: `https://www.kujiang.com/book/${bookId}`,
    novelTitle: title,
    novelTitleAliases: [`novel ${bookId}`],
    author: '作者',
    authorAliases: ['author'],
    chapterTitleAliases: { '101': ['chapter one'] }
  };
}

test('stores normalized, novel-scoped Kujiang identities and returns adapter-safe candidates', (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Reader novel' });

  const created = repositories.identities.create({ novelId: novel.id, ...identity(9) });

  assert.equal(created.canonicalBookUrl, 'https://www.kujiang.com/book/9');
  assert.deepEqual(repositories.identities.listCandidateIdentities(novel.id), [{
    bookUrl: 'https://www.kujiang.com/book/9',
    novelTitle: '小说 9',
    novelTitleAliases: ['novel 9'],
    author: '作者',
    authorAliases: ['author'],
    chapterTitleAliases: { '101': ['chapter one'] }
  }]);
});

test('rejects malformed identities, a fifth identity, and a Kujiang identity owned by another novel', (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Reader novel' });
  const other = repositories.novels.createNovel({ title: 'Other novel' });

  assert.throws(() => repositories.identities.create({ novelId: novel.id, ...identity(9), chapterTitleAliases: { bad: ['chapter one'] } }), ValidationError);
  repositories.identities.create({ novelId: novel.id, ...identity(9) });
  assert.throws(() => repositories.identities.create({ novelId: other.id, ...identity(9) }), ConflictError);
  repositories.sources.createOrGetNovelSource({
    novelId: other.id,
    site: 'kujiang',
    externalNovelId: '14',
    sourceUrl: 'https://www.kujiang.com/book/14',
    normalizedUrl: 'https://www.kujiang.com/book/14',
    title: 'Other source'
  });
  assert.throws(() => repositories.identities.create({ novelId: novel.id, ...identity(14) }), ConflictError);
  for (const bookId of [10, 11, 12]) repositories.identities.create({ novelId: novel.id, ...identity(bookId) });
  assert.throws(() => repositories.identities.create({ novelId: novel.id, ...identity(13) }), /at most 4 source identities/);
});

test('deletes only within the requested novel and preserves foreign identities', (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Reader novel' });
  const other = repositories.novels.createNovel({ title: 'Other novel' });
  const created = repositories.identities.create({ novelId: novel.id, ...identity(9) });

  assert.throws(() => repositories.identities.remove({ novelId: other.id, identityId: created.id }), NotFoundError);
  repositories.identities.remove({ novelId: novel.id, identityId: created.id });
  assert.deepEqual(repositories.identities.list(novel.id), []);
});
