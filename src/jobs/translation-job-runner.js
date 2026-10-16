import { ConflictError } from '../domain/errors.js';

const RETRY_DELAY_MS = 15_000;
const MAX_ATTEMPTS = 4;
export const TRANSLATION_JOB_LEASE_MS = 60_000;

function defaultScheduler() {
  return {
    schedule(delay, callback) {
      return setTimeout(callback, delay);
    },
    cancel(handle) {
      clearTimeout(handle);
    }
  };
}

function retryAt(clock) {
  return new Date(clock().getTime() + RETRY_DELAY_MS).toISOString();
}

function errorDetails(error) {
  if (error?.retryable === true) {
    return { code: 'translation_provider_unavailable', message: 'Translation provider is unavailable.' };
  }
  return {
    code: 'translation_failed',
    message: 'Translation failed.'
  };
}

export function createTranslationJobRunner({ jobs, translationService, epubBuilder = null, clock = () => new Date(), scheduler = defaultScheduler(), concurrency = 2 }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  let started = false;
  let stopping = false;
  let pumping = false;
  let wakePending = false;
  let active = 0;
  const activeProcesses = new Map();
  const activeWork = new Set();
  let timer = null;

  function scheduleWake(at) {
    if (!started || stopping || !at) return;
    const delay = Math.max(0, new Date(at).getTime() - clock().getTime());
    if (timer !== null) scheduler.cancel(timer);
    timer = scheduler.schedule(delay, () => {
      timer = null;
      void wake();
    });
  }

  function recoverStaleClaims() {
    const recovered = jobs.recoverStaleTranslationClaims({
      claimedBefore: new Date(clock().getTime() - TRANSLATION_JOB_LEASE_MS).toISOString()
    });
    if (epubBuilder) {
      for (const job of recovered) {
        if (job.type === 'build_epub') epubBuilder.reset({ novelId: job.novelId, exportId: job.target.exportId });
      }
    }
  }

  async function process(job) {
    let leaseTimer = null;
    let released = false;
    const processKey = `${job.id}:${job.claimToken}`;
    const release = () => {
      if (released) return;
      released = true;
      if (leaseTimer !== null) scheduler.cancel(leaseTimer);
      leaseTimer = null;
      activeProcesses.delete(processKey);
      active -= 1;
      void wake();
    };
    activeProcesses.set(processKey, { novelId: job.novelId, jobId: job.id, type: job.type, release });
    const renewLease = () => {
      if (!started || !jobs.renewTranslationClaim({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken })) return;
      leaseTimer = scheduler.schedule(TRANSLATION_JOB_LEASE_MS / 2, renewLease);
    };
    try {
      leaseTimer = scheduler.schedule(TRANSLATION_JOB_LEASE_MS / 2, renewLease);
      if (job.type === 'build_epub') {
        const attempt = jobs.startAttempt({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken });
        try {
          await epubBuilder.build({
            novelId: job.novelId,
            exportId: job.target.exportId,
            claim: { jobId: job.id, claimToken: job.claimToken },
            shouldContinue: () => {
              const current = jobs.getJob({ novelId: job.novelId, jobId: job.id });
              return current.state === 'running' && current.claimToken === job.claimToken;
            }
          });
          jobs.finishAttempt({ jobId: job.id, attemptId: attempt.id, claimToken: job.claimToken, state: 'succeeded' });
          jobs.transitionJob({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken, toState: 'completed' });
        } catch (error) {
          try {
            jobs.finishAttempt({
              jobId: job.id,
              attemptId: attempt.id,
              claimToken: job.claimToken,
              state: 'paused_after_failure',
              errorCode: 'epub_build_failed',
              errorMessage: 'EPUB export could not be built.'
            });
          } catch (finishError) {
            if (finishError instanceof ConflictError) return;
            throw finishError;
          }
          jobs.transitionJob({
            novelId: job.novelId,
            jobId: job.id,
            claimToken: job.claimToken,
            toState: 'failed',
            errorCode: 'epub_build_failed',
            errorMessage: 'EPUB export could not be built.'
          });
        }
        return;
      }
      while (started && !stopping) {
        const prepared = jobs.prepareTranslationAttempt({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken });
        if (prepared.status === 'completed') {
          jobs.transitionJob({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken, toState: 'completed' });
          return;
        }
        if (prepared.status === 'exhausted') {
          jobs.transitionJob({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken, toState: 'paused', currentChapterId: prepared.chapterId, errorCode: 'RetryExhausted', errorMessage: 'Translation retry limit reached.' });
          return;
        }

        try {
          await translationService.translateChapter({
            novelId: job.novelId,
            chapterNumber: prepared.chapterNumber,
            claim: { jobId: job.id, claimToken: job.claimToken }
          });
          jobs.finishAttempt({ jobId: job.id, attemptId: prepared.attempt.id, claimToken: job.claimToken, state: 'succeeded' });
        } catch (error) {
          const details = errorDetails(error);
          const retryable = error?.retryable === true;
          const exhausted = prepared.attempt.attemptNumber >= MAX_ATTEMPTS;
          const attemptState = retryable && !exhausted ? 'retryable_failed' : 'paused_after_failure';
          try {
            jobs.finishAttempt({
              jobId: job.id,
              attemptId: prepared.attempt.id,
              claimToken: job.claimToken,
              state: attemptState,
              errorCode: details.code,
              errorMessage: details.message
            });
          } catch (finishError) {
            if (finishError instanceof ConflictError) return;
            throw finishError;
          }
          if (retryable && !exhausted) {
            const nextRunAt = retryAt(clock);
            jobs.transitionJob({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken, toState: 'retrying', currentChapterId: prepared.chapterId, nextRunAt, errorCode: details.code, errorMessage: details.message });
            scheduleWake(nextRunAt);
            return;
          }
          jobs.transitionJob({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken, toState: retryable ? 'paused' : 'failed', currentChapterId: prepared.chapterId, errorCode: details.code, errorMessage: details.message });
          return;
        }
      }
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    } finally {
      release();
    }
  }

  async function wake() {
    if (!started || stopping) return;
    if (pumping) {
      wakePending = true;
      return;
    }
    pumping = true;
    try {
      recoverStaleClaims();
      jobs.releaseDueTranslationRetries();
      while (started && !stopping && active < concurrency) {
        const job = jobs.claimNextRunnable({ claimToken: crypto.randomUUID(), type: epubBuilder ? null : 'translate_chapters' });
        if (!job) break;
        active += 1;
        const work = process(job);
        activeWork.add(work);
        void work.catch(() => {}).finally(() => activeWork.delete(work));
      }
      const retryAt = jobs.nextTranslationRetryAt();
      const claimedAt = jobs.nextRunningClaimAt();
      const claimExpiryAt = claimedAt === null ? null : new Date(new Date(claimedAt).getTime() + TRANSLATION_JOB_LEASE_MS).toISOString();
      scheduleWake([retryAt, claimExpiryAt].filter(Boolean).sort()[0] ?? null);
    } finally {
      pumping = false;
      if (wakePending) {
        wakePending = false;
        void wake();
      }
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      stopping = false;
      await wake();
    },

    async stop() {
      stopping = true;
      wakePending = false;
      if (timer !== null) scheduler.cancel(timer);
      timer = null;
      await Promise.allSettled([...activeWork]);
      started = false;
    },

    async wake() {
      await wake();
    },

    pause(input) {
      const job = jobs.getJob(input);
      const paused = jobs.pauseTranslationJob(input);
      if (job.type === 'build_epub') epubBuilder.reset({ novelId: job.novelId, exportId: job.target.exportId });
      for (const process of activeProcesses.values()) {
        if (process.novelId === input.novelId && process.jobId === input.jobId) process.release();
      }
      return paused;
    },

    async resume(input) {
      const job = jobs.getJob(input);
      if (job.state === 'queued') return job;
      const resumed = jobs.transitionJob({ ...input, toState: 'queued' });
      await wake();
      return resumed;
    }
  };
}
