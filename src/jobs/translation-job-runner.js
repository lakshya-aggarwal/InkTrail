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

export function createTranslationJobRunner({ jobs, translationService, clock = () => new Date(), scheduler = defaultScheduler(), concurrency = 2 }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError('concurrency must be a positive integer');
  let started = false;
  let pumping = false;
  let active = 0;
  let timer = null;

  function scheduleWake(at) {
    if (!started || !at) return;
    const delay = Math.max(0, new Date(at).getTime() - clock().getTime());
    if (timer !== null) scheduler.cancel(timer);
    timer = scheduler.schedule(delay, () => {
      timer = null;
      void wake();
    });
  }

  async function process(job) {
    let leaseTimer = null;
    const renewLease = () => {
      if (!started || !jobs.renewTranslationClaim({ novelId: job.novelId, jobId: job.id, claimToken: job.claimToken })) return;
      leaseTimer = scheduler.schedule(TRANSLATION_JOB_LEASE_MS / 2, renewLease);
    };
    try {
      leaseTimer = scheduler.schedule(TRANSLATION_JOB_LEASE_MS / 2, renewLease);
      while (started) {
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
      if (leaseTimer !== null) scheduler.cancel(leaseTimer);
      active -= 1;
      void wake();
    }
  }

  async function wake() {
    if (!started || pumping) return;
    pumping = true;
    try {
      jobs.releaseDueTranslationRetries();
      while (started && active < concurrency) {
        const job = jobs.claimNextRunnable({ claimToken: crypto.randomUUID(), type: 'translate_chapters' });
        if (!job) break;
        active += 1;
        void process(job);
      }
      scheduleWake(jobs.nextTranslationRetryAt());
    } finally {
      pumping = false;
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      jobs.recoverStaleTranslationClaims({
        claimedBefore: new Date(clock().getTime() - TRANSLATION_JOB_LEASE_MS).toISOString()
      });
      await wake();
    },

    stop() {
      started = false;
      if (timer !== null) scheduler.cancel(timer);
      timer = null;
    },

    async wake() {
      await wake();
    },

    pause(input) {
      const job = jobs.getJob(input);
      if (job.state === 'paused') return job;
      const paused = jobs.transitionJob({ ...input, toState: 'paused' });
      jobs.abandonPausedTranslationAttempts(input);
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
