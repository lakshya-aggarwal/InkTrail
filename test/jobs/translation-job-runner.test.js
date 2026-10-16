import assert from 'node:assert/strict';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, TranslationProviderError } from '../../src/domain/errors.js';
import { createJobRepository } from '../../src/jobs/job-repository.js';
import { createTranslationJobRunner, TRANSLATION_JOB_LEASE_MS } from '../../src/jobs/translation-job-runner.js';
import { createExportRepository } from '../../src/epub/export-repository.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';
import { createMemoryRepository } from '../../src/memory/memory-repository.js';
import { createQualityFindingRepository } from '../../src/translation/quality-finding-repository.js';
import { createTranslationService as createSharedTranslationService } from '../../src/translation/translation-service.js';

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
    memory: createMemoryRepository(database, clock.now),
    findings: createQualityFindingRepository(database, clock.now),
    jobs: createJobRepository(database, clock.now),
    exports: createExportRepository(database, clock.now)
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

test('startup recovery resets a recovered EPUB snapshot before claiming work', async () => {
  const clock = createClock();
  const resets = [];
  const jobs = {
    recoverStaleTranslationClaims() {
      return [{ id: 'build-job', novelId: 'novel', type: 'build_epub', target: { exportId: 'export' } }];
    },
    releaseDueTranslationRetries() {},
    claimNextRunnable() {
      return null;
    },
    nextTranslationRetryAt() {
      return null;
    },
    nextRunningClaimAt() {
      return null;
    }
  };
  const runner = createTranslationJobRunner({
    jobs,
    translationService: { async translateChapter() {} },
    epubBuilder: { reset(input) { resets.push(input); } },
    clock: clock.now,
    scheduler: createScheduler(clock)
  });

  await runner.start();

  assert.deepEqual(resets, [{ novelId: 'novel', exportId: 'export' }]);
});

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

test('claims the lowest anomalous same-novel chapter before priority while another novel progresses', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const firstNovel = repositories.novels.createNovel({ title: 'First' });
  const secondNovel = repositories.novels.createNovel({ title: 'Second' });
  seededChapter(repositories, firstNovel, 1);
  seededChapter(repositories, firstNovel, 2);
  seededChapter(repositories, secondNovel, 1);
  database.exec('drop index one_active_translation_job_per_novel');
  const secondJob = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [2] }, priority: 100 });
  clock.advance(1);
  const firstJob = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  repositories.jobs.createTranslationJob({ novelId: secondNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const releases = [];
  const translationService = createTranslationService(repositories, (input) => new Promise((resolve) => releases.push({ input, resolve })));
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();

  assert.deepEqual(
    translationService.calls
      .filter(({ novelId }) => novelId === firstNovel.id)
      .map(({ chapterNumber }) => chapterNumber),
    [1]
  );
  assert.deepEqual(
    translationService.calls
      .filter(({ novelId }) => novelId === secondNovel.id)
      .map(({ chapterNumber }) => chapterNumber),
    [1]
  );

  releases.find(({ input }) => input.novelId === firstNovel.id).resolve();
  await settle();
  assert.deepEqual(
    translationService.calls
      .filter(({ novelId }) => novelId === firstNovel.id)
      .map(({ chapterNumber }) => chapterNumber),
    [1, 2]
  );

  for (const release of releases) release.resolve();
  await settle();
  assert.deepEqual(
    repositories.jobs.listJobs(firstNovel.id).map(({ id, state }) => [id, state]).sort(),
    [[firstJob.id, 'completed'], [secondJob.id, 'completed']].sort()
  );
  runner.stop();
});

test('claims the next unresolved sparse target chapter before a competing job while another novel progresses', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const firstNovel = repositories.novels.createNovel({ title: 'Sparse targets' });
  const secondNovel = repositories.novels.createNovel({ title: 'Other novel' });
  const firstChapter = seededChapter(repositories, firstNovel, 1);
  seededChapter(repositories, firstNovel, 2);
  seededChapter(repositories, firstNovel, 3);
  seededChapter(repositories, secondNovel, 1);
  repositories.chapters.addTranslationRevision({
    chapterId: firstChapter.id,
    translatedText: 'Already translated',
    provider: 'fake',
    model: 'fake'
  });
  database.exec('drop index one_active_translation_job_per_novel');
  const sparseJob = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [1, 3] }, priority: 100 });
  clock.advance(1);
  const middleJob = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [2] }, priority: 0 });
  repositories.jobs.createTranslationJob({ novelId: secondNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const releases = [];
  const translationService = createTranslationService(repositories, (input) => new Promise((resolve) => releases.push({ input, resolve })));
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();

  assert.deepEqual(
    translationService.calls
      .filter(({ novelId }) => novelId === firstNovel.id)
      .map(({ chapterNumber }) => chapterNumber),
    [2]
  );
  assert.deepEqual(
    translationService.calls
      .filter(({ novelId }) => novelId === secondNovel.id)
      .map(({ chapterNumber }) => chapterNumber),
    [1]
  );

  releases.find(({ input }) => input.novelId === firstNovel.id).resolve();
  await settle();

  assert.deepEqual(
    translationService.calls
      .filter(({ novelId }) => novelId === firstNovel.id)
      .map(({ chapterNumber }) => chapterNumber),
    [2, 3]
  );

  for (const release of releases) release.resolve();
  await settle();
  assert.deepEqual(
    repositories.jobs.listJobs(firstNovel.id).map(({ id, state }) => [id, state]).sort(),
    [[sparseJob.id, 'completed'], [middleJob.id, 'completed']].sort()
  );
  runner.stop();
});

test('keeps a retrying chapter ahead of anomalous queued work for its novel', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const firstNovel = repositories.novels.createNovel({ title: 'Retry order' });
  const secondNovel = repositories.novels.createNovel({ title: 'Other novel' });
  seededChapter(repositories, firstNovel, 1);
  seededChapter(repositories, firstNovel, 2);
  seededChapter(repositories, secondNovel, 1);
  database.exec('drop index one_active_translation_job_per_novel');
  repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  clock.advance(1);
  repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [2] }, priority: 0 });
  repositories.jobs.createTranslationJob({ novelId: secondNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  let retried = false;
  const translationService = createTranslationService(repositories, async ({ novelId, chapterNumber }) => {
    if (novelId === firstNovel.id && chapterNumber === 1 && !retried) {
      retried = true;
      throw new TranslationProviderError('offline');
    }
  });
  const scheduler = createScheduler(clock);
  const runner = createTranslationJobRunner({ jobs: repositories.jobs, translationService, clock: clock.now, scheduler });

  await runner.start();
  await settle();

  assert.deepEqual(translationService.calls.map(({ novelId, chapterNumber }) => [novelId, chapterNumber]), [
    [firstNovel.id, 1],
    [secondNovel.id, 1]
  ]);
  assert.equal(repositories.jobs.listJobs(firstNovel.id).find(({ state }) => state === 'retrying').currentChapterId !== null, true);

  await scheduler.advance(15_000);
  await settle();

  assert.deepEqual(
    translationService.calls
      .filter(({ novelId }) => novelId === firstNovel.id)
      .map(({ chapterNumber }) => chapterNumber),
    [1, 1, 2]
  );
  runner.stop();
});

test('a second live runner does not reclaim an unexpired claim or duplicate its revision', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Lease' });
  const chapter = seededChapter(repositories, novel, 1);
  repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  let release;
  const translationService = createTranslationService(repositories, () => new Promise((resolve) => { release = resolve; }));
  const first = createRunner({ repositories, clock, translationService });
  const second = createRunner({ repositories, clock, translationService });

  await first.start();
  await settle();
  await second.start();
  await settle();

  assert.equal(translationService.calls.length, 1);
  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 0);
  release();
  await settle();

  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 1);
  assert.equal(repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: repositories.jobs.listJobs(novel.id)[0].id }).length, 1);
  first.stop();
  second.stop();
});

test('reclaims a startup lease at expiry without an unrelated wake', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Lease expiry recovery' });
  seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  repositories.jobs.claimNextRunnable({ claimToken: 'prior-process', type: 'translate_chapters' });
  clock.advance(10_000);
  const scheduler = createScheduler(clock);
  const translationService = createTranslationService(repositories);
  const runner = createTranslationJobRunner({ jobs: repositories.jobs, translationService, clock: clock.now, scheduler });

  await runner.start();
  await settle();
  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'running');
  assert.equal(translationService.calls.length, 0);

  await scheduler.advance(TRANSLATION_JOB_LEASE_MS - 10_000 + 1);
  await settle();

  const recovered = repositories.jobs.getJob({ novelId: novel.id, jobId: job.id });
  assert.equal(recovered.state, 'completed');
  assert.equal(translationService.calls.length, 1);
  await runner.stop();
});

test('stop drains a claimed translation before relinquishing the runner', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Graceful shutdown' });
  seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] } });
  let releaseTranslation;
  const translationService = createTranslationService(repositories, () => new Promise((resolve) => {
    releaseTranslation = resolve;
  }));
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();
  assert.equal(translationService.calls.length, 1);

  let stopped = false;
  const stopping = runner.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseTranslation();
  await stopping;

  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'running');
  assert.equal(repositories.chapters.getReaderChapter(novel.id, 1).revision, 1);
});

test('stop drains the active chapter without starting the next chapter', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Bounded graceful shutdown' });
  seededChapter(repositories, novel, 1);
  seededChapter(repositories, novel, 2);
  repositories.jobs.createTranslationJob({ novelId: novel.id, target: { startChapterNumber: 1, endChapterNumber: 2 } });
  let releaseTranslation;
  const translationService = createTranslationService(repositories, (_input, callCount) => {
    if (callCount === 1) return new Promise((resolve) => { releaseTranslation = resolve; });
  });
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();
  assert.equal(translationService.calls.length, 1);

  const stopping = runner.stop();
  await new Promise((resolve) => setImmediate(resolve));
  releaseTranslation();
  await stopping;

  assert.equal(translationService.calls.length, 1);
  assert.equal(repositories.chapters.getReaderChapter(novel.id, 1).revision, 1);
  assert.equal(repositories.chapters.getReaderChapter(novel.id, 2).translatedText, null);
});

test('a stale EPUB worker cannot start an attempt under a replacement claim', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'EPUB claim handoff' });
  const chapter = seededChapter(repositories, novel, 1);
  repositories.chapters.addTranslationRevision({ chapterId: chapter.id, translatedText: 'Translated chapter.', provider: 'fixture', model: 'fixture' });
  const snapshot = repositories.exports.captureSnapshot({ novelId: novel.id, selection: { chapterNumbers: [1] } });
  const job = repositories.jobs.createBuildEpubJob({ novelId: novel.id, target: { exportId: snapshot.export.id } });
  let handedOff = false;
  const jobs = {
    ...repositories.jobs,
    startAttempt(input) {
      if (!handedOff) {
        handedOff = true;
        repositories.jobs.pauseTranslationJob({ novelId: novel.id, jobId: job.id });
        repositories.jobs.transitionJob({ novelId: novel.id, jobId: job.id, toState: 'queued' });
        repositories.jobs.claimNextRunnable({ claimToken: 'replacement-claim', type: 'build_epub' });
      }
      return repositories.jobs.startAttempt(input);
    }
  };
  const runner = createTranslationJobRunner({
    jobs,
    translationService: { async translateChapter() {} },
    epubBuilder: { async build() { throw new Error('stale worker reached builder'); }, reset() {} },
    clock: clock.now,
    scheduler: createScheduler(clock)
  });

  await runner.start();
  await settle();

  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).claimToken, 'replacement-claim');
  assert.deepEqual(repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id }), []);
  await runner.stop();
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

test('pauses an in-flight translation without leaving a started attempt and resumes safely', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'In-flight pause' });
  const chapter = seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const releases = [];
  const translationService = createSharedTranslationService({
    database,
    repositories,
    provider: {
      provider: 'fake',
      model: 'fake',
      async translate() {
        return new Promise((resolve) => releases.push(() => resolve({ paragraphs: ['Translated 1'] })));
      }
    },
    qualityChecker: () => []
  });
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();
  assert.equal(releases.length, 1);

  runner.pause({ novelId: novel.id, jobId: job.id });
  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'paused');
  assert.deepEqual(
    repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id }).map(({ state }) => state),
    ['abandoned_on_recovery']
  );
  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 0);

  releases.shift()();
  await settle();
  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'paused');
  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 0);
  assert.equal(repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id }).some(({ state }) => state === 'started'), false);

  await runner.resume({ novelId: novel.id, jobId: job.id });
  await settle();
  assert.equal(releases.length, 1);
  releases.shift()();
  await settle();

  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'completed');
  assert.deepEqual(
    repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id }).map(({ state }) => state),
    ['abandoned_on_recovery', 'succeeded']
  );
  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 1);
  runner.stop();
});

test('releases capacity after pausing an in-flight provider call without double-releasing on late completion', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const firstNovel = repositories.novels.createNovel({ title: 'Blocked' });
  const secondNovel = repositories.novels.createNovel({ title: 'Available' });
  const thirdNovel = repositories.novels.createNovel({ title: 'Capacity check one' });
  const fourthNovel = repositories.novels.createNovel({ title: 'Capacity check two' });
  const firstChapter = seededChapter(repositories, firstNovel, 1);
  const secondChapter = seededChapter(repositories, secondNovel, 1);
  seededChapter(repositories, thirdNovel, 1);
  seededChapter(repositories, fourthNovel, 1);
  const firstJob = repositories.jobs.createTranslationJob({ novelId: firstNovel.id, target: { chapterNumbers: [1] }, priority: 1 });
  const secondJob = repositories.jobs.createTranslationJob({ novelId: secondNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  let providerCalls = 0;
  let releaseFirst;
  const translationService = createSharedTranslationService({
    database,
    repositories,
    provider: {
      provider: 'fake',
      model: 'fake',
      async translate() {
        providerCalls += 1;
        if (providerCalls === 1) return new Promise((resolve) => { releaseFirst = () => resolve({ paragraphs: ['Late first'] }); });
        if (providerCalls === 2) return { paragraphs: ['Second completed'] };
        return new Promise(() => {});
      }
    },
    qualityChecker: () => []
  });
  const runner = createRunner({ repositories, clock, translationService, concurrency: 1 });

  await runner.start();
  await settle();
  assert.equal(providerCalls, 1);

  runner.pause({ novelId: firstNovel.id, jobId: firstJob.id });
  await settle();
  assert.equal(providerCalls, 2);
  assert.equal(repositories.jobs.getJob({ novelId: secondNovel.id, jobId: secondJob.id }).state, 'completed');
  assert.equal(repositories.chapters.listTranslationRevisions(secondChapter.id).length, 1);

  releaseFirst();
  await settle();
  assert.equal(repositories.jobs.getJob({ novelId: firstNovel.id, jobId: firstJob.id }).state, 'paused');
  assert.equal(repositories.chapters.listTranslationRevisions(firstChapter.id).length, 0);

  repositories.jobs.createTranslationJob({ novelId: thirdNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  repositories.jobs.createTranslationJob({ novelId: fourthNovel.id, target: { chapterNumbers: [1] }, priority: 0 });
  await runner.wake();
  await settle();
  assert.equal(providerCalls, 3);
  runner.stop();
});

test('persists only stable safe failure metadata', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Redaction' });
  seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const secret = 'prompt fragment /Users/lakshya/private payload';
  const translationService = createTranslationService(repositories, async () => {
    const error = new Error(secret);
    error.name = secret;
    error.retryable = true;
    throw error;
  });
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();

  const attempt = repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id })[0];
  const stored = repositories.jobs.getJob({ novelId: novel.id, jobId: job.id });
  assert.deepEqual([attempt.errorCode, attempt.errorMessage], ['translation_provider_unavailable', 'Translation provider is unavailable.']);
  assert.deepEqual([stored.lastErrorCode, stored.lastErrorMessage], ['translation_provider_unavailable', 'Translation provider is unavailable.']);
  assert.equal(JSON.stringify({ attempt, stored }).includes(secret), false);
  runner.stop();
});

test('an expired worker cannot overwrite a reclaimer claim or its job state', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Claim transition' });
  seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const scheduler = createScheduler(clock);
  const providerFailure = new TranslationProviderError('offline');
  const translationService = createTranslationService(repositories, async () => { throw providerFailure; });
  let secondRunner;
  let reclaimerState;
  const secondRunnerJobs = {
    ...repositories.jobs,
    prepareTranslationAttempt(input) {
      reclaimerState = repositories.jobs.getJob({ novelId: input.novelId, jobId: input.jobId });
      throw new ConflictError('hold reclaimed worker');
    }
  };
  const firstRunnerJobs = {
    ...repositories.jobs,
    finishAttempt(input) {
      const attempt = repositories.jobs.finishAttempt(input);
      clock.advance(TRANSLATION_JOB_LEASE_MS);
      secondRunner = createTranslationJobRunner({
        jobs: secondRunnerJobs,
        translationService,
        clock: clock.now,
        scheduler: createScheduler(clock)
      });
      void secondRunner.start();
      return attempt;
    }
  };
  const firstRunner = createTranslationJobRunner({ jobs: firstRunnerJobs, translationService, clock: clock.now, scheduler });

  await firstRunner.start();
  await settle();

  const after = repositories.jobs.getJob({ novelId: novel.id, jobId: job.id });
  assert.deepEqual(
    {
      state: after.state,
      currentChapterId: after.currentChapterId,
      lastErrorCode: after.lastErrorCode,
      lastErrorMessage: after.lastErrorMessage,
      claimToken: after.claimToken
    },
    {
      state: reclaimerState.state,
      currentChapterId: reclaimerState.currentChapterId,
      lastErrorCode: reclaimerState.lastErrorCode,
      lastErrorMessage: reclaimerState.lastErrorMessage,
      claimToken: reclaimerState.claimToken
    }
  );
  assert.equal(after.claimToken === null, false);
  firstRunner.stop();
  secondRunner.stop();
});

test('only the current claim can append a translation after a stale provider call returns', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Claimed translation' });
  const chapter = seededChapter(repositories, novel, 1);
  repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const releases = [];
  const translationService = createSharedTranslationService({
    database,
    repositories,
    provider: {
      provider: 'fake',
      model: 'fake',
      async translate() {
        return new Promise((resolve) => releases.push(() => resolve({ paragraphs: ['Translated.'] })));
      }
    },
    qualityChecker: () => [{ kind: 'forced_check', details: 'Forced quality check.' }]
  });
  const first = createRunner({ repositories, clock, translationService });
  const second = createRunner({ repositories, clock, translationService });

  await first.start();
  await settle();
  clock.advance(TRANSLATION_JOB_LEASE_MS);
  await second.start();
  await settle();
  assert.equal(releases.length, 2);

  releases[0]();
  await settle();
  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 0);
  assert.equal(database.prepare('select count(*) as count from translation_quality_findings').get().count, 0);
  assert.deepEqual(repositories.memory.listVerifiedMemoryEntries(novel.id), []);
  releases[1]();
  await settle();

  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).length, 1);
  assert.equal(database.prepare('select count(*) as count from translation_quality_findings').get().count, 1);
  assert.equal(repositories.jobs.listJobs(novel.id)[0].state, 'completed');
  first.stop();
  second.stop();
});

test('completes a job checkpoint without replacing a direct translation that finishes during provider wait', async (t) => {
  const { clock, database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Direct wins' });
  const chapter = seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const releases = [];
  const translationService = createSharedTranslationService({
    database,
    repositories,
    provider: {
      provider: 'fake',
      model: 'fake',
      async translate() {
        return new Promise((resolve) => releases.push(resolve));
      }
    },
    qualityChecker: () => [{ kind: 'forced_check', details: 'Forced quality check.' }]
  });
  const runner = createRunner({ repositories, clock, translationService });

  await runner.start();
  await settle();
  assert.equal(releases.length, 1);
  const direct = translationService.translateChapter({ novelId: novel.id, chapterNumber: 1 });
  await settle();
  assert.equal(releases.length, 2);

  releases[1]({ paragraphs: ['Direct translation.'] });
  const directResult = await direct;
  releases[0]({ paragraphs: ['Job translation.'] });
  await settle();

  assert.deepEqual(
    repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText),
    ['Direct translation.']
  );
  assert.equal(database.prepare('select count(*) as count from translation_quality_findings').get().count, 1);
  assert.equal(repositories.jobs.getJob({ novelId: novel.id, jobId: job.id }).state, 'completed');
  assert.deepEqual(
    repositories.jobs.listJobAttempts({ novelId: novel.id, jobId: job.id }).map(({ state }) => state),
    ['succeeded']
  );
  assert.equal(directResult.revision.translatedText, 'Direct translation.');
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
  clock.advance(TRANSLATION_JOB_LEASE_MS);
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
