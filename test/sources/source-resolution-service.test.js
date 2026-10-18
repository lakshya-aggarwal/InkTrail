import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceCatalogRepository } from '../../src/sources/source-catalog-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';
import { createSourceResolutionRepository } from '../../src/sources/source-resolution-repository.js';
import { createSourceResolutionService } from '../../src/sources/source-resolution-service.js';

const now = '2026-10-18T00:00:00.000Z';
const chapterUrl = 'https://novelping.com/book/return-of-the-war-god/chapter-2-lamp-fire';
const evidence = Object.freeze({
  canonicalNovelPingUrl: chapterUrl,
  novelTitle: 'return of the war god',
  author: null,
  chapterNumber: 2,
  chapterTitle: 'lamp fire',
  extractorVersion: 'novelping-kujiang-v1',
  evidenceHash: createHash('sha256').update('evidence').digest('hex')
});

function createRepositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date(now);
  return {
    database,
    novels: createNovelRepository(database, clock),
    sources: createSourceRepository(database, clock),
    catalogs: createSourceCatalogRepository(database, clock),
    resolutions: createSourceResolutionRepository(database, clock)
  };
}

function candidate() {
  const canonicalBookUrl = 'https://www.kujiang.com/book/9';
  const entry = {
    ordinal: 2,
    externalChapterId: '101',
    sourceUrl: `${canonicalBookUrl}/101`,
    normalizedUrl: `${canonicalBookUrl}/101`,
    sourceTitle: '第二章 灯火'
  };
  return {
    id: canonicalBookUrl,
    site: 'kujiang',
    canonicalBookUrl,
    externalNovelId: '9',
    novelTitle: '战神狂飙',
    novelTitleAliases: ['return of the war god'],
    author: null,
    authorAliases: [],
    chapterNumber: 2,
    chapterTitle: entry.sourceTitle,
    chapterTitleAliases: ['lamp fire'],
    catalog: {
      site: 'kujiang',
      canonicalBookUrl,
      externalNovelId: '9',
      entries: [{
        ordinal: 1,
        externalChapterId: '100',
        sourceUrl: `${canonicalBookUrl}/100`,
        normalizedUrl: `${canonicalBookUrl}/100`,
        sourceTitle: '第一章 起程'
      }, entry]
    },
    entry
  };
}

function createService(repositories, discoverCatalogCandidates) {
  return createSourceResolutionService({
    database: repositories.database,
    repositories,
    novelPingExtractor: { async fetchEvidence() { return evidence; } },
    catalogAdapters: [{ discoverCatalogCandidates }]
  });
}

function count(database, table) {
  return database.prepare(`select count(*) as count from ${table}`).get().count;
}

test('accepts a winner by atomically creating its source, catalog, attempt, and resolution', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Reader novel' });
  const service = createService(repositories, async () => [candidate()]);

  const result = await service.resolveNovelPingChapter({ novelId: novel.id, novelPingUrl: chapterUrl });

  assert.equal(result.replayed, false);
  assert.equal(result.attempt.state, 'resolved');
  assert.equal(result.resolution.catalogEntryId.length > 0, true);
  assert.equal(count(repositories.database, 'novel_sources'), 1);
  assert.equal(count(repositories.database, 'source_catalogs'), 1);
  assert.equal(count(repositories.database, 'source_resolution_attempts'), 1);
  assert.equal(count(repositories.database, 'novel_source_resolutions'), 1);
});

test('persists an unresolved decision without creating a source or catalog', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Reader novel' });
  const service = createService(repositories, async () => []);

  const result = await service.resolveNovelPingChapter({ novelId: novel.id, novelPingUrl: chapterUrl });

  assert.equal(result.attempt.state, 'unresolved');
  assert.equal(result.attempt.errorCode, 'resolution_unverified');
  assert.equal(count(repositories.database, 'novel_sources'), 0);
  assert.equal(count(repositories.database, 'source_catalogs'), 0);
});

test('replays terminal evidence without a duplicate candidate-provider call', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Reader novel' });
  let providerCalls = 0;
  const service = createService(repositories, async () => {
    providerCalls += 1;
    return [];
  });

  const first = await service.resolveNovelPingChapter({ novelId: novel.id, novelPingUrl: chapterUrl });
  const replay = await service.resolveNovelPingChapter({ novelId: novel.id, novelPingUrl: chapterUrl });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attempt.id, first.attempt.id);
  assert.equal(providerCalls, 1);
  assert.equal(count(repositories.database, 'source_resolution_attempts'), 1);
});

test('records ownership collisions without replacing the existing source', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const owner = repositories.novels.createNovel({ title: 'Owner novel' });
  const requesting = repositories.novels.createNovel({ title: 'Requesting novel' });
  const input = candidate();
  repositories.sources.createOrGetNovelSource({
    novelId: owner.id,
    site: input.site,
    externalNovelId: input.externalNovelId,
    sourceUrl: input.canonicalBookUrl,
    normalizedUrl: input.canonicalBookUrl,
    title: input.novelTitle
  });
  const service = createService(repositories, async () => [input]);

  const result = await service.resolveNovelPingChapter({ novelId: requesting.id, novelPingUrl: chapterUrl });

  assert.equal(result.attempt.state, 'unresolved');
  assert.equal(result.attempt.errorCode, 'source_ownership_conflict');
  assert.equal(count(repositories.database, 'novel_sources'), 1);
  assert.equal(count(repositories.database, 'source_catalogs'), 0);
});

test('rolls back source and catalog writes when the accepted transaction fails', async (t) => {
  const repositories = createRepositories();
  t.after(() => repositories.database.close());
  const novel = repositories.novels.createNovel({ title: 'Reader novel' });
  const failingRepositories = {
    ...repositories,
    catalogs: {
      ...repositories.catalogs,
      createOrGetSnapshotInTransaction() {
        throw new Error('forced transaction failure');
      }
    }
  };
  const service = createService(failingRepositories, async () => [candidate()]);

  const result = await service.resolveNovelPingChapter({ novelId: novel.id, novelPingUrl: chapterUrl });

  assert.equal(result.attempt.state, 'failed');
  assert.equal(result.attempt.errorCode, 'resolution_failed');
  assert.equal(count(repositories.database, 'novel_sources'), 0);
  assert.equal(count(repositories.database, 'source_catalogs'), 0);
  assert.equal(count(repositories.database, 'source_resolution_attempts'), 1);
});
