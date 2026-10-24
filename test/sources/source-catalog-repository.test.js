import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceCatalogRepository } from '../../src/sources/source-catalog-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

const now = '2026-10-17T00:00:00.000Z';
const digest = (suffix) => suffix.repeat(64);

function repositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date(now);
  return {
    database,
    novels: createNovelRepository(database, clock),
    sources: createSourceRepository(database, clock),
    catalogs: createSourceCatalogRepository(database, clock)
  };
}

function sourceInput(novelId, externalNovelId = '9') {
  const url = `https://www.kujiang.com/book/${externalNovelId}`;
  return { novelId, site: 'kujiang', externalNovelId, sourceUrl: url, normalizedUrl: url, title: 'Source novel' };
}

function entries() {
  return [
    { ordinal: 1, externalChapterId: '100', sourceUrl: 'https://www.kujiang.com/book/9/100', normalizedUrl: 'https://www.kujiang.com/book/9/100', sourceTitle: 'One' },
    { ordinal: 2, externalChapterId: '101', sourceUrl: 'https://www.kujiang.com/book/9/101', normalizedUrl: 'https://www.kujiang.com/book/9/101', sourceTitle: 'Two' }
  ];
}

function snapshotInput(novelId, novelSourceId, hash = digest('a')) {
  return { novelId, novelSourceId, site: 'kujiang', canonicalBookUrl: 'https://www.kujiang.com/book/9', contentSha256: hash, entries: entries() };
}

test('creates immutable ordered metadata snapshots without chapter side effects', (t) => {
  const { database, novels, sources, catalogs } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });
  const source = sources.createOrGetNovelSource(sourceInput(novel.id));
  const first = catalogs.createOrGetSnapshot(snapshotInput(novel.id, source.id));

  assert.match(first.catalog.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.catalog.createdAt, now);
  assert.deepEqual(first.entries.map(({ ordinal, sourceTitle }) => ({ ordinal, sourceTitle })), [{ ordinal: 1, sourceTitle: 'One' }, { ordinal: 2, sourceTitle: 'Two' }]);
  assert.equal(database.prepare('select count(*) as count from chapters').get().count, 0);
  assert.equal(database.prepare('select count(*) as count from chapter_sources').get().count, 0);
  assert.equal(catalogs.getEntry({ novelId: novel.id, catalogId: first.catalog.id, catalogEntryId: first.entries[0].id }).sourceTitle, 'One');
  assert.throws(() => catalogs.getEntry({ novelId: novel.id, catalogId: first.catalog.id, catalogEntryId: 'missing' }), /source catalog entry not found/);
  assert.throws(() => database.prepare("update source_catalog_entries set source_title = 'Changed' where id = ?").run(first.entries[0].id), /immutable/);
  assert.throws(() => database.prepare('delete from source_catalogs where id = ?').run(first.catalog.id), /immutable/);
});

test('returns the same immutable snapshot for an equivalent source content hash', (t) => {
  const { database, novels, sources, catalogs } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });
  const source = sources.createOrGetNovelSource(sourceInput(novel.id));
  const first = catalogs.createOrGetSnapshot(snapshotInput(novel.id, source.id));
  const again = catalogs.createOrGetSnapshot(snapshotInput(novel.id, source.id));
  const second = catalogs.createOrGetSnapshot(snapshotInput(novel.id, source.id, digest('b')));

  assert.deepEqual(again, first);
  assert.notEqual(second.catalog.id, first.catalog.id);
  assert.equal(catalogs.listSnapshots(novel.id).length, 2);
});

test('rejects cross-novel bindings, URL replacement, unordered entries, and duplicate source URLs', (t) => {
  const { database, novels, sources, catalogs } = repositories();
  t.after(() => database.close());
  const first = novels.createNovel({ title: 'First' });
  const second = novels.createNovel({ title: 'Second' });
  const firstSource = sources.createOrGetNovelSource(sourceInput(first.id));
  const secondSource = sources.createOrGetNovelSource(sourceInput(second.id, '10'));

  assert.throws(() => catalogs.createOrGetSnapshot(snapshotInput(second.id, firstSource.id)), ConflictError);
  assert.throws(() => catalogs.createOrGetSnapshot({ ...snapshotInput(first.id, firstSource.id), canonicalBookUrl: 'https://www.kujiang.com/book/other' }), ConflictError);
  assert.throws(() => catalogs.createOrGetSnapshot({ ...snapshotInput(second.id, secondSource.id), entries: [{ ...entries()[0], ordinal: 2 }] }), ValidationError);
  assert.throws(() => catalogs.createOrGetSnapshot({ ...snapshotInput(first.id, firstSource.id), contentSha256: digest('c'), entries: [entries()[0], { ...entries()[1], sourceUrl: entries()[0].sourceUrl }] }), ValidationError);
  assert.equal(catalogs.listSnapshots(first.id).length, 0);
});
