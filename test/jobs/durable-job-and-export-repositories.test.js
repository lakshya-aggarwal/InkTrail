import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createExportRepository } from '../../src/epub/export-repository.js';
import { createJobRepository } from '../../src/jobs/job-repository.js';
import { createJobService } from '../../src/jobs/job-service.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

function fixture(databasePath = ':memory:') {
  const database = openDatabase({ databasePath });
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
  const { firstNovel, secondNovel, firstChapter, unsourcedChapter, otherChapter } = seed(repositories);
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
  assert.throws(() => repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: first.id, chapterId: otherChapter.id, claimToken: claimed.claimToken }), NotFoundError);
  assert.throws(() => repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: first.id, chapterId: unsourcedChapter.id, claimToken: claimed.claimToken }), ConflictError);
  const attempt = repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: first.id, chapterId: firstChapter.id, claimToken: claimed.claimToken });
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(repositories.jobs.finishAttempt({ jobId: first.id, attemptId: attempt.id, claimToken: claimed.claimToken, state: 'retryable_failed', errorCode: 'temporary', errorMessage: 'Try again.' }).state, 'retryable_failed');
  const retry = repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: first.id, chapterId: firstChapter.id, claimToken: claimed.claimToken });
  assert.equal(retry.attemptNumber, 2);
  assert.equal(repositories.jobs.finishAttempt({ jobId: first.id, attemptId: retry.id, claimToken: claimed.claimToken, state: 'succeeded' }).state, 'succeeded');
  assert.equal(repositories.jobs.transitionJob({ novelId: firstNovel.id, jobId: first.id, toState: 'paused' }).state, 'paused');
  assert.equal(repositories.jobs.transitionJob({ novelId: firstNovel.id, jobId: first.id, toState: 'queued' }).state, 'queued');
  assert.equal(repositories.jobs.listJobEvents({ novelId: firstNovel.id, jobId: first.id }).map((event) => event.type).includes('claimed'), true);
});

test('job checkpoints, targets, and claims reject stale or foreign work', (t) => {
  const repositories = fixture();
  t.after(() => repositories.database.close());
  const { firstNovel, secondNovel, firstChapter, secondChapter, otherChapter } = seed(repositories);
  const rangeJob = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { startChapterNumber: 1, endChapterNumber: 1 } });

  assert.throws(() => repositories.database.prepare('update jobs set current_chapter_id = ? where id = ?').run(otherChapter.id, rangeJob.id), /job checkpoint must belong to job novel/);
  repositories.database.prepare('update jobs set current_chapter_id = ? where id = ?').run(firstChapter.id, rangeJob.id);
  assert.equal(repositories.jobs.getJob({ novelId: firstNovel.id, jobId: rangeJob.id }).currentChapterId, firstChapter.id);
  assert.throws(() => repositories.database.prepare('update chapters set novel_id = ? where id = ?').run(secondNovel.id, firstChapter.id), /chapter novel cannot change while job checkpoint exists/);
  const claimedRange = repositories.jobs.claimNextRunnable({ claimToken: 'range-claim' });
  assert.equal(claimedRange.id, rangeJob.id);
  assert.throws(() => repositories.database.prepare(`
    insert into job_attempts (id, job_id, novel_id, chapter_id, attempt_number, state, started_at, claim_token)
    values ('outside-range', ?, ?, ?, 1, 'started', '2026-10-14T00:00:00.000Z', ?)
  `).run(rangeJob.id, firstNovel.id, secondChapter.id, claimedRange.claimToken), /job attempt must match its job target/);
  assert.throws(() => repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: rangeJob.id, chapterId: secondChapter.id, claimToken: claimedRange.claimToken }), ConflictError);
  const attempt = repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: rangeJob.id, chapterId: firstChapter.id, claimToken: claimedRange.claimToken });
  repositories.jobs.transitionJob({ novelId: firstNovel.id, jobId: rangeJob.id, toState: 'paused' });
  assert.throws(() => repositories.jobs.finishAttempt({ jobId: rangeJob.id, attemptId: attempt.id, claimToken: claimedRange.claimToken, state: 'succeeded' }), ConflictError);
  assert.throws(() => repositories.database.prepare("update job_attempts set state = 'succeeded', finished_at = ? where id = ?").run('2026-10-14T00:00:00.000Z', attempt.id), /only the active job claim may finalize/);

  const explicitJob = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [2] } });
  const claimedExplicit = repositories.jobs.claimNextRunnable({ claimToken: 'explicit-claim' });
  assert.equal(claimedExplicit.id, explicitJob.id);
  assert.throws(() => repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: explicitJob.id, chapterId: firstChapter.id, claimToken: claimedExplicit.claimToken }), ConflictError);
});

test('build EPUB jobs require an existing export owned by their novel', (t) => {
  const repositories = fixture();
  t.after(() => repositories.database.close());
  const { firstNovel, secondNovel } = seed(repositories);
  const firstExport = repositories.exports.captureSnapshot({ novelId: firstNovel.id, selection: { chapterNumbers: [1] } }).export;
  const secondExport = repositories.exports.captureSnapshot({ novelId: secondNovel.id, selection: { chapterNumbers: [1] } }).export;

  assert.throws(() => repositories.jobs.createBuildEpubJob({ novelId: firstNovel.id, target: { exportId: 'missing-export' } }), NotFoundError);
  assert.throws(() => repositories.jobs.createBuildEpubJob({ novelId: firstNovel.id, target: { exportId: secondExport.id } }), NotFoundError);
  assert.throws(() => repositories.database.prepare(`
    insert into jobs (id, novel_id, type, target_json, target_hash, state, priority, created_at, updated_at)
    values ('foreign-export-job', ?, 'build_epub', ?, 'hash', 'queued', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z')
  `).run(firstNovel.id, JSON.stringify({ exportId: secondExport.id })), /EPUB job target must be an export owned by job novel/);
  const job = repositories.jobs.createBuildEpubJob({ novelId: firstNovel.id, target: { exportId: firstExport.id } });
  const claimed = repositories.jobs.claimNextRunnable({ claimToken: 'epub-claim' });
  assert.equal(claimed.id, job.id);
  const attempt = repositories.jobs.startAttempt({ novelId: firstNovel.id, jobId: job.id, claimToken: claimed.claimToken });
  assert.equal(repositories.jobs.finishAttempt({ jobId: job.id, attemptId: attempt.id, claimToken: claimed.claimToken, state: 'succeeded' }).state, 'succeeded');
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

test('EPUB snapshot and build job commit together and deduplicate inside the transaction', async (t) => {
  const repositories = fixture();
  t.after(() => repositories.database.close());
  const { firstNovel } = seed(repositories);
  const runner = { async wake() {} };
  const failingJobs = {
    ...repositories.jobs,
    createBuildEpubJobInTransaction() {
      throw new Error('simulated job write failure');
    }
  };
  const failingService = createJobService({ database: repositories.database, jobs: failingJobs, exports: repositories.exports, runner });

  await assert.rejects(
    failingService.createEpubExport({ novelId: firstNovel.id, selection: { chapterNumbers: [1] } }),
    /simulated job write failure/
  );
  assert.equal(repositories.database.prepare('select count(*) as count from epub_exports').get().count, 0);

  const firstService = createJobService({ database: repositories.database, jobs: repositories.jobs, exports: repositories.exports, runner });
  const secondService = createJobService({ database: repositories.database, jobs: repositories.jobs, exports: repositories.exports, runner });
  const [first, second] = await Promise.all([
    firstService.createEpubExport({ novelId: firstNovel.id, selection: { chapterNumbers: [1] } }),
    secondService.createEpubExport({ novelId: firstNovel.id, selection: { chapterNumbers: [1] } })
  ]);

  assert.equal(first.created || second.created, true);
  assert.equal(first.created && second.created, false);
  assert.equal(first.export.id, second.export.id);
  assert.equal(first.export.jobId, first.job.id);
  assert.equal(repositories.database.prepare('select count(*) as count from epub_exports').get().count, 1);
  assert.equal(repositories.database.prepare("select count(*) as count from jobs where type = 'build_epub'").get().count, 1);
});

test('a second SQLite connection retries a locked EPUB create and returns the committed export', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inktrail-export-lock-'));
  const databasePath = join(directory, 'inktrail.sqlite');
  const first = fixture(databasePath);
  const second = fixture(databasePath);
  t.after(async () => {
    first.database.close();
    second.database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { firstNovel } = seed(first);
  const runner = { async wake() {} };
  const secondService = createJobService({ database: second.database, jobs: second.jobs, exports: second.exports, runner });

  first.database.exec('begin immediate');
  const snapshot = first.exports.captureSnapshotInTransaction({ novelId: firstNovel.id, selection: { chapterNumbers: [1] } });
  const job = first.jobs.createBuildEpubJobInTransaction({ novelId: firstNovel.id, target: { exportId: snapshot.export.id } });
  first.exports.attachBuildJobInTransaction({ novelId: firstNovel.id, exportId: snapshot.export.id, jobId: job.id });
  setTimeout(() => first.database.exec('commit'), 1);

  const duplicate = await secondService.createEpubExport({ novelId: firstNovel.id, selection: { chapterNumbers: [1] } });

  assert.equal(duplicate.created, false);
  assert.equal(duplicate.export.id, snapshot.export.id);
  assert.equal(duplicate.job.id, job.id);
  assert.equal(second.database.prepare('select count(*) as count from epub_exports').get().count, 1);
  assert.equal(second.database.prepare("select count(*) as count from jobs where type = 'build_epub'").get().count, 1);
});
