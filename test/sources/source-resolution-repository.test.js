import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, NotFoundError } from '../../src/domain/errors.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceCatalogRepository } from '../../src/sources/source-catalog-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';
import { createSourceResolutionRepository } from '../../src/sources/source-resolution-repository.js';

const now = '2026-10-18T00:00:00.000Z';
const digest = (character) => character.repeat(64);

function repositories() {
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

function sourceInput(novelId, externalNovelId = '9') {
  const sourceUrl = `https://www.kujiang.com/book/${externalNovelId}`;
  return { novelId, site: 'kujiang', externalNovelId, sourceUrl, normalizedUrl: sourceUrl, title: 'War God' };
}

function snapshotInput(novelId, novelSourceId) {
  return {
    novelId,
    novelSourceId,
    site: 'kujiang',
    canonicalBookUrl: 'https://www.kujiang.com/book/9',
    contentSha256: digest('a'),
    entries: [{
      ordinal: 1,
      externalChapterId: '2491',
      sourceUrl: 'https://www.kujiang.com/book/9/2491',
      normalizedUrl: 'https://www.kujiang.com/book/9/2491',
      sourceTitle: 'Shen Guanghai'
    }]
  };
}

function candidate(catalogId = null) {
  return {
    id: 'candidate-a',
    adapter: 'kujiang-catalog-v1',
    site: 'kujiang',
    canonicalSourceIdentity: 'https://www.kujiang.com/book/9',
    contentSha256: digest('a'),
    normalizedMetadataJson: '{"title":"war god"}',
    declaredAliasesJson: '{"titles":["return of the war god"]}',
    catalogEntryOrdinal: 1,
    catalogEntryExternalId: '2491',
    componentScoresJson: '{"chapterNumber":40,"novelTitle":30,"chapterTitle":25}',
    totalScore: 95,
    rank: 1,
    decisionReason: 'accepted',
    catalogId
  };
}

function attemptInput(overrides = {}) {
  return {
    id: 'attempt-a',
    novelId: 'novel-a',
    canonicalNovelPingUrl: 'https://novelping.com/book/return-of-the-war-god/chapter-2491-shen-guanghai',
    evidenceJson: '{"chapterNumber":2491}',
    evidenceHash: digest('e'),
    resolverVersion: 'novelping-kujiang-v1',
    state: 'unresolved',
    errorCode: 'resolution_unverified',
    candidates: [candidate()],
    ...overrides
  };
}

test('persists immutable unresolved evidence without touching sources or catalogs and replays its identity', (t) => {
  const { database, novels, resolutions } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ id: 'novel-a', title: 'InkTrail' });
  const first = resolutions.createOrGetTerminalAttempt(attemptInput({ novelId: novel.id }));
  const replay = resolutions.createOrGetTerminalAttempt(attemptInput({ novelId: novel.id, id: 'attempt-replay' }));

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.attempt.id, first.attempt.id);
  assert.equal(first.candidates[0].catalogId, null);
  assert.equal(database.prepare('select count(*) as count from novel_sources').get().count, 0);
  assert.equal(database.prepare('select count(*) as count from source_catalogs').get().count, 0);
  assert.throws(() => database.prepare("update source_resolution_attempts set error_code = 'changed' where id = 'attempt-a'").run(), /immutable/);
  assert.throws(() => database.prepare("delete from source_resolution_candidates where id = 'candidate-a'").run(), /immutable/);
});

test('atomically persists accepted references only for a matching source catalog and protects ownership', (t) => {
  const { database, novels, sources, catalogs, resolutions } = repositories();
  t.after(() => database.close());
  const first = novels.createNovel({ id: 'novel-a', title: 'First' });
  const second = novels.createNovel({ id: 'novel-b', title: 'Second' });
  const source = sources.createOrGetNovelSource(sourceInput(first.id));
  const snapshot = catalogs.createOrGetSnapshot(snapshotInput(first.id, source.id));
  let created;
  let accepted;
  resolutions.withinTransaction(() => {
    created = resolutions.createOrGetTerminalAttemptInTransaction(attemptInput({
      novelId: first.id,
      state: 'resolved',
      errorCode: undefined,
      selectedCandidateId: 'candidate-a',
      candidates: [candidate(snapshot.catalog.id)]
    }));
    accepted = resolutions.createAcceptedResolutionInTransaction({
      novelId: first.id,
      attemptId: created.attempt.id,
      candidateId: 'candidate-a',
      novelSourceId: source.id,
      catalogId: snapshot.catalog.id,
      catalogEntryId: snapshot.entries[0].id
    });
  });

  assert.equal(accepted.catalogEntryId, snapshot.entries[0].id);
  assert.equal(resolutions.getAcceptedResolution(first.id, created.attempt.id).id, accepted.id);
  assert.throws(() => resolutions.getAttempt(second.id, created.attempt.id), NotFoundError);
  assert.throws(() => resolutions.createAcceptedResolutionInTransaction({
    novelId: second.id,
    attemptId: created.attempt.id,
    candidateId: 'candidate-a',
    novelSourceId: source.id,
    catalogId: snapshot.catalog.id,
    catalogEntryId: snapshot.entries[0].id
  }), NotFoundError);
  assert.throws(() => database.prepare("update novel_source_resolutions set catalog_entry_id = 'changed' where id = ?").run(accepted.id), /immutable/);
});

test('rejects catalog observations outside accepted attempts and source collisions without replacement', (t) => {
  const { database, novels, sources, catalogs, resolutions } = repositories();
  t.after(() => database.close());
  const first = novels.createNovel({ id: 'novel-a', title: 'First' });
  const second = novels.createNovel({ id: 'novel-b', title: 'Second' });
  const source = sources.createOrGetNovelSource(sourceInput(first.id));
  const snapshot = catalogs.createOrGetSnapshot(snapshotInput(first.id, source.id));

  assert.throws(() => resolutions.createOrGetTerminalAttempt(attemptInput({ novelId: first.id, candidates: [candidate(snapshot.catalog.id)] })), /catalog shape/);
  assert.throws(() => resolutions.createOrGetTerminalAttempt(attemptInput({
    novelId: first.id,
    state: 'resolved',
    errorCode: undefined,
    selectedCandidateId: 'candidate-a',
    candidates: [candidate(snapshot.catalog.id)]
  })), /atomic resolution transaction/);
  assert.throws(() => resolutions.withinTransaction(() => resolutions.createOrGetTerminalAttemptInTransaction(attemptInput({
    novelId: first.id,
    state: 'resolved',
    errorCode: undefined,
    selectedCandidateId: 'candidate-a'
  }))), /selected catalog candidate/);
  let created;
  resolutions.withinTransaction(() => {
    created = resolutions.createOrGetTerminalAttemptInTransaction(attemptInput({
      novelId: first.id,
      state: 'resolved',
      errorCode: undefined,
      selectedCandidateId: 'candidate-a',
      candidates: [candidate(snapshot.catalog.id)]
    }));
    resolutions.createAcceptedResolutionInTransaction({
      novelId: first.id,
      attemptId: created.attempt.id,
      candidateId: 'candidate-a',
      novelSourceId: source.id,
      catalogId: snapshot.catalog.id,
      catalogEntryId: snapshot.entries[0].id
    });
  });

  const otherSource = sources.createOrGetNovelSource(sourceInput(first.id, '10'));
  const otherSnapshot = catalogs.createOrGetSnapshot({ ...snapshotInput(first.id, otherSource.id), canonicalBookUrl: 'https://www.kujiang.com/book/10' });
  assert.throws(() => resolutions.withinTransaction(() => {
    const next = resolutions.createOrGetTerminalAttemptInTransaction(attemptInput({
      id: 'attempt-b',
      novelId: first.id,
      canonicalNovelPingUrl: 'https://novelping.com/book/return-of-the-war-god/chapter-2492',
      evidenceHash: digest('f'),
      state: 'resolved',
      errorCode: undefined,
      selectedCandidateId: 'candidate-b',
      candidates: [{ ...candidate(otherSnapshot.catalog.id), id: 'candidate-b', canonicalSourceIdentity: 'https://www.kujiang.com/book/10' }]
    }));
    resolutions.createAcceptedResolutionInTransaction({
      novelId: first.id,
      attemptId: next.attempt.id,
      candidateId: 'candidate-b',
      novelSourceId: otherSource.id,
      catalogId: otherSnapshot.catalog.id,
      catalogEntryId: otherSnapshot.entries[0].id
    });
  }), ConflictError);
  assert.equal(resolutions.listResolutions(first.id).length, 1);
  assert.throws(() => resolutions.getCandidate(second.id, created.attempt.id, 'candidate-a'), NotFoundError);
  assert.throws(() => resolutions.createAcceptedResolutionInTransaction({
    novelId: first.id,
    attemptId: created.attempt.id,
    candidateId: 'candidate-a',
    novelSourceId: otherSource.id,
    catalogId: otherSnapshot.catalog.id,
    catalogEntryId: otherSnapshot.entries[0].id
  }), ConflictError);
});
