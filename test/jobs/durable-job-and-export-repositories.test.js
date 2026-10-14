import assert from 'node:assert/strict';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createExportRepository } from '../../src/epub/export-repository.js';
import { createJobRepository } from '../../src/jobs/job-repository.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

function fixture() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-14T00:00:00.000Z');
  return {
    database,
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    sources: createSourceRepository(database, clock),
    jobs: createJobRepository(database, clock),
    exports: createExportRepository(database, clock)
  };
}

function sourceChapter(repositories, novel, chapter, externalId) {
  const source = repositories.sources.createOrGetNovelSource({
    novelId: novel.id,
    site: `fixture-${novel.id}`,
    externalNovelId: novel.id,
    sourceUrl: `https://example.test/${novel.id}`,
    normalizedUrl: `https://example.test/${novel.id}`,
    title: novel.title
  });
  repositories.sources.createChapterSource({
    novelId: novel.id,
    chapterId: chapter.id,
    novelSourceId: source.id,
    site: `fixture-${novel.id}`,
    externalChapterId: externalId,
    sourceUrl: `https://example.test/${novel.id}/${externalId}`,
    normalizedUrl: `https://example.test/${novel.id}/${externalId}`,
    sourceTitle: chapter.title,
    previousSourceUrl: null,
    nextSourceUrl: null,
    fetchedAt: '2026-10-14T00:00:00.000Z',
    contentSha256: externalId.padEnd(64, '0')
  });
}

function seed(repositories) {
  const firstNovel = repositories.novels.createNovel({ title: 'First' });
  const secondNovel = repositories.novels.createNovel({ title: 'Second' });
  const firstChapter = repositories.chapters.recordChapter({ novelId: firstNovel.id, chapterNumber: 1, title: 'One', originalText: 'One' });
  const secondChapter = repositories.chapters.recordChapter({ novelId: firstNovel.id, chapterNumber: 2, title: 'Two', originalText: 'Two' });
  const unsourcedChapter = repositories.chapters.recordChapter({ novelId: firstNovel.id, chapterNumber: 3, title: 'Three', originalText: 'Three' });
  const otherChapter = repositories.chapters.recordChapter({ novelId: secondNovel.id, chapterNumber: 1, title: 'Other', originalText: 'Other' });
  sourceChapter(repositories, firstNovel, firstChapter, 'one');
  sourceChapter(repositories, firstNovel, secondChapter, 'two');
  sourceChapter(repositories, secondNovel, otherChapter, 'other');
  const firstRevision = repositories.chapters.addTranslationRevision({ chapterId: firstChapter.id, translatedText: 'First', provider: 'test', model: 'test' });
  const secondRevision = repositories.chapters.addTranslationRevision({ chapterId: secondChapter.id, translatedText: 'Second', provider: 'test', model: 'test' });
  const otherRevision = repositories.chapters.addTranslationRevision({ chapterId: otherChapter.id, translatedText: 'Other', provider: 'test', model: 'test' });
  return { firstNovel, secondNovel, firstChapter, secondChapter, unsourcedChapter, otherChapter, firstRevision, secondRevision, otherRevision };
}

test('translation jobs canonicalize targets, isolate novels, and enforce lifecycle transitions', (t) => {
  const repositories = fixture();
  t.after(() => repositories.database.close());
  const { firstNovel, secondNovel, firstChapter, otherChapter } = seed(repositories);
  const first = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { startChapterNumber: 1, endChapterNumber: 2 }, idempotencyKey: 'first' });
  const same = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { endChapterNumber: 2, startChapterNumber: 1 }, idempotencyKey: 'first' });
  assert.equal(same.id, first.id);
  assert.throws(() => repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [1] }, idempotencyKey: 'first' }), ConflictError);
  assert.throws(() => repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [1] } }), ConflictError);
  assert.throws(() => repositories.jobs.transitionJob({ novelId: firstNovel.id, jobId: first.id, toState: 'completed' }), ConflictError);
  assert.throws(() => repositories.jobs.transitionJob({ novelId: firstNovel.id, jobId: first.id, toState: 'running' }), ConflictError);
  const claimed = repositories.jobs.claimNextRunnable({ claimToken: 'runner-a' });
  assert.equal(claimed.id, first.id);
  const second = repositories.jobs.createTranslationJob({ novelId: secondNovel.id, target: { chapterNumbers: [1] } });
  assert.notEqual(second.id, first.id);
  assert.throws(() => repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: first.id, chapterId: otherChapter.id }), NotFoundError);
  const attempt = repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: first.id, chapterId: firstChapter.id });
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(repositories.jobs.finishAttempt({ jobId: first.id, attemptId: attempt.id, state: 'retryable_failed', errorCode: 'temporary', errorMessage: 'Try again.' }).state, 'retryable_failed');
  const retry = repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: first.id, chapterId: firstChapter.id });
  assert.equal(retry.attemptNumber, 2);
  assert.equal(repositories.jobs.finishAttempt({ jobId: first.id, attemptId: retry.id, state: 'succeeded' }).state, 'succeeded');
  assert.equal(repositories.jobs.transitionJob({ novelId: firstNovel.id, jobId: first.id, toState: 'paused' }).state, 'paused');
  assert.equal(repositories.jobs.transitionJob({ novelId: firstNovel.id, jobId: first.id, toState: 'queued' }).state, 'queued');
  assert.equal(repositories.jobs.listJobEvents({ novelId: firstNovel.id, jobId: first.id }).map((event) => event.type).includes('claimed'), true);
});

test('EPUB snapshots capture sourced latest revisions in ascending order and stay immutable', (t) => {
  const repositories = fixture();
  t.after(() => repositories.database.close());
  const { firstNovel, firstChapter, firstRevision, secondRevision, unsourcedChapter } = seed(repositories);
  const snapshot = repositories.exports.captureSnapshot({ novelId: firstNovel.id, selection: { startChapterNumber: 1, endChapterNumber: 2 } });
  assert.deepEqual(snapshot.chapters.map((chapter) => [chapter.ordinal, chapter.chapterNumber, chapter.translationRevisionId]), [[1, 1, firstRevision.id], [2, 2, secondRevision.id]]);
  repositories.chapters.addTranslationRevision({ chapterId: firstChapter.id, translatedText: 'Newer', provider: 'test', model: 'test' });
  assert.equal(repositories.exports.getExportSnapshot({ novelId: firstNovel.id, exportId: snapshot.export.id }).chapters[0].translationRevisionId, firstRevision.id);
  assert.throws(() => repositories.exports.captureSnapshot({ novelId: firstNovel.id, selection: { startChapterNumber: 1, endChapterNumber: 4 } }), ConflictError);
  assert.throws(() => repositories.exports.captureSnapshot({ novelId: firstNovel.id, selection: { chapterNumbers: [unsourcedChapter.chapterNumber] } }), ConflictError);
});

test('EPUB metadata only accepts generated safe output names', (t) => {
  const repositories = fixture();
  t.after(() => repositories.database.close());
  const { firstNovel } = seed(repositories);
  const snapshot = repositories.exports.captureSnapshot({ novelId: firstNovel.id, selection: { chapterNumbers: [1] } });
  assert.throws(() => repositories.exports.transitionExport({ novelId: firstNovel.id, exportId: snapshot.export.id, toState: 'building', fileName: '../escape.epub' }), ValidationError);
  repositories.exports.transitionExport({ novelId: firstNovel.id, exportId: snapshot.export.id, toState: 'building' });
  const available = repositories.exports.transitionExport({
    novelId: firstNovel.id,
    exportId: snapshot.export.id,
    toState: 'available',
    fileName: `${snapshot.export.id}.epub`,
    byteSize: 42,
    sha256: 'a'.repeat(64)
  });
  assert.equal(available.state, 'available');
});
