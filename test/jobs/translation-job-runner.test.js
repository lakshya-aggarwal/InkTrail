import assert from 'node:assert/strict';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { TranslationProviderError } from '../../src/domain/errors.js';
import { createJobRepository } from '../../src/jobs/job-repository.js';
import { createTranslationJobRunner } from '../../src/jobs/translation-job-runner.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

function createClock() {
  let now = new Date('2026-10-15T00:00:00.000Z');
  return {
    now: () => new Date(now),
    advance(milliseconds) {
      now = new Date(now.getTime() + milliseconds);
    }
  };
}

function createScheduler(clock) {
  let nextId = 1;
  const tasks = new Map();
  return {
    schedule(delay, callback) {
      const id = nextId++;
      tasks.set(id, { dueAt: clock.now().getTime() + delay, callback });
      return id;
    },
    cancel(id) {
      tasks.delete(id);
    },
    async advance(milliseconds) {
      clock.advance(milliseconds);
      for (const [id, task] of [...tasks]) {
        if (task.dueAt <= clock.now().getTime()) {
          tasks.delete(id);
          task.callback();
        }
      }
      await settle();
    }
  };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function fixture() {
  const clock = createClock();
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const repositories = {
    novels: createNovelRepository(database, clock.now),
    chapters: createChapterRepository(database, clock.now),
    sources: createSourceRepository(database, clock.now),
    jobs: createJobRepository(database, clock.now)
  };
  return { clock, database, repositories };
}

function seededChapter(repositories, novel, chapterNumber) {
  const chapter = repositories.chapters.recordChapter({
    novelId: novel.id,
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    originalText: `Original ${chapterNumber}`
  });
  const source = repositories.sources.createOrGetNovelSource({
    novelId: novel.id,
    site: `fixture-${novel.id}`,
    externalNovelId: novel.id,
    sourceUrl: `https://fixture.test/${novel.id}`,
    normalizedUrl: `https://fixture.test/${novel.id}`,
    title: novel.title
  });
  repositories.sources.createChapterSource({
    novelId: novel.id,
    chapterId: chapter.id,
    novelSourceId: source.id,
    site: `fixture-${novel.id}`,
    externalChapterId: `${novel.id}-${chapterNumber}`,
    sourceUrl: `https://fixture.test/${novel.id}/${chapterNumber}`,
    normalizedUrl: `https://fixture.test/${novel.id}/${chapterNumber}`,
    sourceTitle: chapter.title,
    previousSourceUrl: null,
    nextSourceUrl: null,
    fetchedAt: '2026-10-15T00:00:00.000Z',
    contentSha256: `${novel.id}${chapterNumber}`.padEnd(64, '0')
  });
  return chapter;
}

function createTranslationService(repositories, behavior = async () => {}) {
  const calls = [];
  return {
    calls,
    async translateChapter(input) {
      calls.push(input);
      await behavior(input, calls.length);
      const chapter = repositories.chapters.getSourcedChapter(input.novelId, input.chapterNumber);
      repositories.chapters.addTranslationRevision({
        chapterId: chapter.id,
        translatedText: `Translated ${input.chapterNumber}`,
        provider: 'fake',
        model: 'fake'
      });
    }
  };
}

function createRunner({ repositories, clock, translationService, concurrency = 2 }) {
  return createTranslationJobRunner({
    jobs: repositories.jobs,
    translationService,
    clock: clock.now,
    scheduler: createScheduler(clock),
    concurrency
  });
}

test('serializes selected chapters for one novel in ascending order', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Serial' });
  seededChapter(repositories, novel, 2);
  seededChapter(repositories, novel, 1);
  repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1, 2] }, priority: 0 });
  let active = 0;
  let peak = 0;
  const translationService = createTranslationService(repositories, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  });
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();

  assert.deepEqual(translationService.calls.map(({ chapterNumber }) => chapterNumber), [1, 2]);
  assert.equal(peak, 1);
  assert.equal(repositories.jobs.listJobs(novel.id)[0].state, 'completed');
  runner.stop();
});

test('runs independent novels concurrently up to the global limit', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const first = repositories.novels.createNovel({ title: 'First' });
  const second = repositories.novels.createNovel({ title: 'Second' });
  seededChapter(repositories, first, 1);
  seededChapter(repositories, second, 1);
  repositories.jobs.createTranslationJob({ novelId: first.id, target: { chapterNumbers: [1] }, priority: 0 });
  repositories.jobs.createTranslationJob({ novelId: second.id, target: { chapterNumbers: [1] }, priority: 0 });
  const releases = [];
  const translationService = createTranslationService(repositories, () => new Promise((resolve) => releases.push(resolve)));
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();
  assert.equal(translationService.calls.length, 2);
  releases.forEach((release) => release());
  await settle();

  assert.deepEqual(repositories.jobs.listJobs(first.id).map(({ state }) => state), ['completed']);
  assert.deepEqual(repositories.jobs.listJobs(second.id).map(({ state }) => state), ['completed']);
  runner.stop();
});

test('retries at exactly fifteen-second intervals and pauses after four failures', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Retries' });
  seededChapter(repositories, novel, 1);
  repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const translationService = createTranslationService(repositories, async () => { throw new TranslationProviderError('offline'); });
  const scheduler = createScheduler(clock);
  const runner = createTranslationJobRunner({ jobs: repositories.jobs, translationService, clock: clock.now, scheduler });

  await runner.start();
  await settle();
  assert.equal(repositories.jobs.listJobs(novel.id)[0].nextRunAt, '2026-10-15T00:00:15.000Z');
  await scheduler.advance(14_999);
  assert.equal(translationService.calls.length, 1);
  for (let index = 0; index < 3; index += 1) {
    await scheduler.advance(1);
    if (index < 2) await scheduler.advance(15_000);
  }
  await settle();

  const job = repositories.jobs.listJobs(novel.id)[0];
  assert.equal(translationService.calls.length, 4);
  assert.equal(job.state, 'paused');
  assert.equal(job.nextRunAt, null);
  assert.deepEqual(repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id }).map(({ state }) => state), [
    'retryable_failed', 'retryable_failed', 'retryable_failed', 'paused_after_failure'
  ]);
  runner.stop();
});

test('does not translate while paused and resumes a queued checkpoint', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Pause' });
  seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const translationService = createTranslationService(repositories);
  const runner = createRunner({ repositories, clock, translationService });

  runner.pause({ novelId: novel.id, jobId: job.id });
  await runner.start();
  await settle();
  assert.equal(translationService.calls.length, 0);
  await runner.resume({ novelId: novel.id, jobId: job.id });
  await settle();

  assert.equal(translationService.calls.length, 1);
  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'completed');
  runner.stop();
});

test('recovers stale running claims without duplicating a completed checkpoint', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Recovery' });
  const chapter = seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const claim = repositories.jobs.claimNextRunnable({ claimToken: 'stale-claim', type: 'translate_chapters' });
  repositories.jobs.prepareTranslationAttempt({ novelId: novel.id, jobId: job.id, claimToken: claim.claimToken });
  repositories.chapters.addTranslationRevision({ chapterId: chapter.id, translatedText: 'Already translated', provider: 'fake', model: 'fake' });
  const translationService = createTranslationService(repositories);
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();

  assert.equal(translationService.calls.length, 0);
  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'completed');
  assert.deepEqual(repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id }).map(({ state }) => state), ['abandoned_on_recovery']);
  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 1);
  runner.stop();
});
