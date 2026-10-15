import { createHash, randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

const jobTypes = new Set(['translate_chapters', 'build_epub']);
const jobStates = new Set(['queued', 'running', 'retrying', 'paused', 'failed', 'completed']);
const attemptStates = new Set(['started', 'succeeded', 'retryable_failed', 'paused_after_failure', 'abandoned_on_recovery']);
const eventTypes = new Set(['job_created', 'claimed', 'chapter_started', 'chapter_completed', 'retry_scheduled', 'paused', 'resumed', 'recovered', 'failed', 'completed']);
const transitions = {
  queued: new Set(['paused']),
  running: new Set(['retrying', 'paused', 'failed', 'completed']),
  retrying: new Set(['queued', 'paused']),
  paused: new Set(['queued']),
  failed: new Set(),
  completed: new Set()
};

function requireObject(value, name = 'input') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value;
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function requireChapterNumber(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError(`${name} must be a positive integer`);
  return value;
}

function requireOptionalText(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) throw new ValidationError(`${name} is invalid`);
  return value.trim();
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalizeChapterTarget(value) {
  const target = requireObject(value, 'target');
  const keys = Object.keys(target).sort();
  if (keys.join(',') === 'endChapterNumber,startChapterNumber') {
    const startChapterNumber = requireChapterNumber(target.startChapterNumber, 'startChapterNumber');
    const endChapterNumber = requireChapterNumber(target.endChapterNumber, 'endChapterNumber');
    if (startChapterNumber > endChapterNumber) throw new ValidationError('chapter range is invalid');
    const targetJson = JSON.stringify({ startChapterNumber, endChapterNumber });
    return { targetJson, targetHash: hash(targetJson), chapterNumbers: null, startChapterNumber, endChapterNumber };
  }
  if (keys.length === 1 && keys[0] === 'chapterNumbers' && Array.isArray(target.chapterNumbers) && target.chapterNumbers.length > 0) {
    const chapterNumbers = target.chapterNumbers.map((number) => requireChapterNumber(number, 'chapterNumbers'));
    if (chapterNumbers.some((number, index) => index > 0 && number <= chapterNumbers[index - 1])) {
      throw new ValidationError('chapterNumbers must be strictly ascending and unique');
    }
    const targetJson = JSON.stringify({ chapterNumbers });
    return { targetJson, targetHash: hash(targetJson), chapterNumbers, startChapterNumber: null, endChapterNumber: null };
  }
  throw new ValidationError('target must be a chapter range or chapterNumbers');
}

function toJob(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    type: row.type,
    target: JSON.parse(row.target_json),
    targetHash: row.target_hash,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    priority: row.priority,
    nextRunAt: row.next_run_at,
    claimedAt: row.claimed_at,
    claimToken: row.claim_token,
    currentChapterId: row.current_chapter_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function toAttempt(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    attemptNumber: row.attempt_number,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    errorMessage: row.error_message
  };
}

function toEvent(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    type: row.type,
    message: row.message,
    details: JSON.parse(row.details_json),
    createdAt: row.created_at
  };
}

function safeDetails(value) {
  const details = requireObject(value ?? {}, 'details');
  for (const [key, item] of Object.entries(details)) {
    if (!['chapterId', 'attemptId', 'exportId', 'completedCount', 'remainingCount', 'attemptNumber'].includes(key)) {
      throw new ValidationError('event details contain an unsupported field');
    }
    if (key.endsWith('Id') && (typeof item !== 'string' || item.trim().length === 0)) throw new ValidationError('event details contain an invalid id');
    if (key.endsWith('Count') || key === 'attemptNumber') requireChapterNumber(item, key);
  }
  return JSON.stringify(details);
}

function targetIncludesChapter(job, chapterNumber) {
  const target = JSON.parse(job.target_json);
  return Array.isArray(target.chapterNumbers)
    ? target.chapterNumbers.includes(chapterNumber)
    : chapterNumber >= target.startChapterNumber && chapterNumber <= target.endChapterNumber;
}

export function createJobRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const chapterInNovel = database.prepare('select 1 from chapters where id = ? and novel_id = ?');
  const chapterByIdInNovel = database.prepare('select chapter_number from chapters where id = ? and novel_id = ?');
  const exportInNovel = database.prepare('select 1 from epub_exports where id = ? and novel_id = ?');
  const jobById = database.prepare('select * from jobs where id = ?');
  const jobInNovel = database.prepare('select * from jobs where id = ? and novel_id = ?');
  const jobByIdempotencyKey = database.prepare('select * from jobs where novel_id = ? and type = ? and idempotency_key = ?');
  const activeJobByTarget = database.prepare("select * from jobs where novel_id = ? and type = ? and target_hash = ? and state in ('queued', 'running', 'retrying')");
  const insertJob = database.prepare(`
    insert into jobs (
      id, novel_id, type, target_json, target_hash, idempotency_key, state, priority,
      next_run_at, claimed_at, claim_token, current_chapter_id, last_error_code,
      last_error_message, created_at, updated_at, completed_at
    ) values (
      @id, @novelId, @type, @targetJson, @targetHash, @idempotencyKey, @state, @priority,
      null, null, null, null, null, null, @createdAt, @updatedAt, null
    )
  `);
  const insertEvent = database.prepare(`
    insert into job_events (id, job_id, novel_id, chapter_id, type, message, details_json, created_at)
    values (@id, @jobId, @novelId, @chapterId, @type, @message, @detailsJson, @createdAt)
  `);
  const runnableJob = database.prepare(`
    select * from jobs
    where state = 'queued' and (next_run_at is null or next_run_at <= ?)
    order by priority desc, created_at, id
    limit 1
  `);
  const runnableJobByType = database.prepare(`
    select * from jobs
    where type = ? and state = 'queued' and (next_run_at is null or next_run_at <= ?)
    order by priority desc, created_at, id
    limit 1
  `);
  const claimJob = database.prepare(`
    update jobs set state = 'running', claimed_at = ?, claim_token = ?, updated_at = ?
    where id = ? and state = 'queued' and (next_run_at is null or next_run_at <= ?)
  `);
  const updateJob = database.prepare(`
    update jobs
    set state = @state, next_run_at = @nextRunAt, claimed_at = @claimedAt, claim_token = @claimToken,
      current_chapter_id = @currentChapterId, last_error_code = @lastErrorCode,
      last_error_message = @lastErrorMessage, updated_at = @updatedAt, completed_at = @completedAt
    where id = @id and novel_id = @novelId and state = @fromState
      and (@expectedClaimToken is null or claim_token = @expectedClaimToken)
  `);
  const attemptById = database.prepare('select * from job_attempts where id = ? and job_id = ?');
  const nextAttempt = database.prepare('select coalesce(max(attempt_number), 0) + 1 as attempt_number from job_attempts where job_id = ? and chapter_id is ?');
  const insertAttempt = database.prepare(`
    insert into job_attempts (id, job_id, novel_id, chapter_id, attempt_number, state, started_at, finished_at, error_code, error_message, claim_token)
    values (@id, @jobId, @novelId, @chapterId, @attemptNumber, 'started', @startedAt, null, null, null, @claimToken)
  `);
  const finishAttempt = database.prepare(`
    update job_attempts set state = @state, finished_at = @finishedAt, error_code = @errorCode, error_message = @errorMessage
    where id = @id and job_id = @jobId and state = 'started' and claim_token = @claimToken
  `);
  const attemptsForJob = database.prepare('select * from job_attempts where job_id = ? order by started_at, attempt_number, id');
  const eventsForJob = database.prepare('select * from job_events where job_id = ? order by created_at, id');
  const sourcedUntranslatedChapters = database.prepare(`
    select chapters.id, chapters.chapter_number
    from chapters
    where chapters.novel_id = ?
      and exists (select 1 from chapter_sources where chapter_sources.chapter_id = chapters.id)
      and not exists (select 1 from translation_revisions where translation_revisions.chapter_id = chapters.id)
    order by chapters.chapter_number
  `);
  const revisionExists = database.prepare('select 1 from translation_revisions where chapter_id = ? limit 1');
  const completedEventExists = database.prepare("select 1 from job_events where job_id = ? and chapter_id = ? and type = 'chapter_completed' limit 1");
  const setCheckpoint = database.prepare(`
    update jobs set current_chapter_id = ?, updated_at = ?
    where id = ? and novel_id = ? and state = 'running' and claim_token = ?
  `);
  const clearCheckpoint = database.prepare(`
    update jobs set current_chapter_id = null, updated_at = ?
    where id = ? and novel_id = ? and state = 'running' and claim_token = ?
  `);
  const staleRunningJobs = database.prepare(`
    select * from jobs
    where type = 'translate_chapters' and state = 'running'
      and (claimed_at is null or claimed_at <= ?)
  `);
  const renewClaim = database.prepare(`
    update jobs set claimed_at = ?, updated_at = ?
    where id = ? and novel_id = ? and state = 'running' and claim_token = ?
  `);
  const abandonStartedAttempts = database.prepare(`
    update job_attempts set state = 'abandoned_on_recovery', finished_at = ?
    where job_id = ? and state = 'started'
  `);
  const recoverJob = database.prepare(`
    update jobs set state = ?, claimed_at = null, claim_token = null, updated_at = ?
    where id = ? and state = 'running'
  `);
  const dueRetries = database.prepare(`
    select * from jobs
    where type = 'translate_chapters' and state = 'retrying' and next_run_at <= ?
    order by priority desc, created_at, id
  `);
  const releaseRetry = database.prepare(`
    update jobs set state = 'queued', next_run_at = null, updated_at = ?
    where id = ? and state = 'retrying' and next_run_at <= ?
  `);
  const nextRetry = database.prepare("select min(next_run_at) as next_run_at from jobs where type = 'translate_chapters' and state = 'retrying'");
  const activeTranslationClaim = database.prepare(`
    select 1 from jobs
    where id = ? and novel_id = ? and type = 'translate_chapters'
      and state = 'running' and claim_token = ? and current_chapter_id = ?
  `);

  function withinTransaction(action) {
    database.exec('begin immediate');
    try {
      const result = action();
      database.exec('commit');
      return result;
    } catch (error) {
      database.exec('rollback');
      throw error;
    }
  }

  function requireNovel(novelId) {
    const id = requireId(novelId, 'novelId');
    if (!novelExists.get(id)) throw new NotFoundError('novel not found');
    return id;
  }

  function appendEvent(job, input) {
    const type = requireId(input.type, 'event type');
    if (!eventTypes.has(type)) throw new ValidationError('event type is invalid');
    const message = requireOptionalText(input.message, 'event message');
    if (!message) throw new ValidationError('event message is required');
    const chapterId = input.chapterId ?? null;
    if (chapterId !== null && !chapterInNovel.get(requireId(chapterId, 'chapterId'), job.novel_id)) throw new NotFoundError('chapter not found');
    const event = {
      id: randomUUID(),
      jobId: job.id,
      novelId: job.novel_id,
      chapterId,
      type,
      message,
      detailsJson: safeDetails(input.details),
      createdAt: clock().toISOString()
    };
    insertEvent.run(event);
    return event;
  }

  function createJob(input) {
    const { novelId, type, target, idempotencyKey = null, priority = 0 } = requireObject(input);
    const normalizedNovelId = requireNovel(novelId);
    if (!jobTypes.has(type)) throw new ValidationError('job type is invalid');
    if (!Number.isSafeInteger(priority)) throw new ValidationError('priority must be an integer');
    const normalizedTarget = type === 'translate_chapters'
      ? canonicalizeChapterTarget(target)
      : (() => {
          const exportId = requireId(requireObject(target, 'target').exportId, 'exportId');
          const targetJson = JSON.stringify({ exportId });
          return { targetJson, targetHash: hash(targetJson), exportId };
        })();
    const normalizedKey = idempotencyKey === null || idempotencyKey === undefined ? null : requireId(idempotencyKey, 'idempotencyKey');

    return withinTransaction(() => {
      if (type === 'build_epub' && !exportInNovel.get(normalizedTarget.exportId, normalizedNovelId)) {
        throw new NotFoundError('EPUB export not found');
      }
      if (normalizedKey) {
        const existing = jobByIdempotencyKey.get(normalizedNovelId, type, normalizedKey);
        if (existing) {
          if (existing.target_hash !== normalizedTarget.targetHash) throw new ConflictError('idempotency key was already used for a different job');
          return toJob(existing);
        }
      } else {
        const existing = activeJobByTarget.get(normalizedNovelId, type, normalizedTarget.targetHash);
        if (existing) return toJob(existing);
      }
      const now = clock().toISOString();
      const job = {
        id: randomUUID(),
        novelId: normalizedNovelId,
        type,
        targetJson: normalizedTarget.targetJson,
        targetHash: normalizedTarget.targetHash,
        idempotencyKey: normalizedKey,
        state: 'queued',
        priority,
        createdAt: now,
        updatedAt: now
      };
      try {
        insertJob.run(job);
      } catch (error) {
        if (error.code === 'ERR_SQLITE_ERROR' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new ConflictError('an active translation job already exists for novel');
        throw error;
      }
      appendEvent({ id: job.id, novel_id: job.novelId }, { type: 'job_created', message: 'Job queued.', details: {} });
      return toJob(jobById.get(job.id));
    });
  }

  return {
    createTranslationJob(input) {
      return createJob({ ...requireObject(input), type: 'translate_chapters' });
    },

    createBuildEpubJob(input) {
      return createJob({ ...requireObject(input), type: 'build_epub' });
    },

    getJob(input) {
      const { novelId, jobId } = requireObject(input);
      const job = jobInNovel.get(requireId(jobId, 'jobId'), requireNovel(novelId));
      if (!job) throw new NotFoundError('job not found');
      return toJob(job);
    },

    listJobs(novelId) {
      const id = requireNovel(novelId);
      return database.prepare('select * from jobs where novel_id = ? order by created_at desc, id desc').all(id).map(toJob);
    },

    claimNextRunnable(input) {
      const { claimToken: inputClaimToken, type = null } = requireObject(input);
      const claimToken = requireId(inputClaimToken, 'claimToken');
      if (type !== null && !jobTypes.has(type)) throw new ValidationError('job type is invalid');
      return withinTransaction(() => {
        const now = clock().toISOString();
        const candidate = type === null ? runnableJob.get(now) : runnableJobByType.get(type, now);
        if (!candidate) return null;
        if (claimJob.run(now, claimToken, now, candidate.id, now).changes === 0) return null;
        const claimed = jobById.get(candidate.id);
        appendEvent(claimed, { type: 'claimed', message: 'Job claimed.', details: {} });
        return toJob(claimed);
      });
    },

    transitionJob(input) {
      const { novelId, jobId, toState, nextRunAt = null, currentChapterId = null, errorCode = null, errorMessage = null, claimToken = null } = requireObject(input);
      const id = requireNovel(novelId);
      const expectedClaimToken = claimToken === null ? null : requireId(claimToken, 'claimToken');
      if (!jobStates.has(toState)) throw new ValidationError('job state is invalid');
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (!transitions[job.state].has(toState)) throw new ConflictError('job state transition is not allowed');
        const chapterId = currentChapterId === null ? job.current_chapter_id : requireId(currentChapterId, 'currentChapterId');
        if (chapterId !== null && !chapterInNovel.get(chapterId, id)) throw new NotFoundError('chapter not found');
        const now = clock().toISOString();
        const updated = {
          id: job.id,
          novelId: id,
          fromState: job.state,
          state: toState,
          expectedClaimToken,
          nextRunAt: nextRunAt === null ? null : requireId(nextRunAt, 'nextRunAt'),
          claimedAt: toState === 'running' ? job.claimed_at : null,
          claimToken: toState === 'running' ? job.claim_token : null,
          currentChapterId: chapterId,
          lastErrorCode: requireOptionalText(errorCode, 'errorCode'),
          lastErrorMessage: requireOptionalText(errorMessage, 'errorMessage'),
          updatedAt: now,
          completedAt: toState === 'completed' || toState === 'failed' ? now : null
        };
        if (updateJob.run(updated).changes === 0) throw new ConflictError('job state transition is stale');
        const transitioned = jobInNovel.get(job.id, id);
        const eventType = {
          retrying: 'retry_scheduled',
          paused: 'paused',
          failed: 'failed',
          completed: 'completed'
        }[toState] ?? (job.state === 'paused' ? 'resumed' : 'recovered');
        appendEvent(transitioned, { type: eventType, message: `Job ${toState}.`, chapterId, details: chapterId ? { chapterId } : {} });
        return toJob(transitioned);
      });
    },

    appendJobEvent(input) {
      const { novelId, jobId, ...event } = requireObject(input);
      const job = jobInNovel.get(requireId(jobId, 'jobId'), requireNovel(novelId));
      if (!job) throw new NotFoundError('job not found');
      return appendEvent(job, event);
    },

    startAttempt(input) {
      const { novelId, jobId, chapterId = null } = requireObject(input);
      const id = requireNovel(novelId);
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.state !== 'running') throw new ConflictError('job is not running');
        if (!job.claim_token) throw new ConflictError('job claim is not active');
        if (job.type === 'translate_chapters' && chapterId === null) throw new ValidationError('chapterId is required for translation attempts');
        if (job.type === 'build_epub' && chapterId !== null) throw new ValidationError('chapterId is not allowed for EPUB attempts');
        const normalizedChapterId = chapterId === null ? null : requireId(chapterId, 'chapterId');
        const chapter = normalizedChapterId === null ? null : chapterByIdInNovel.get(normalizedChapterId, id);
        if (normalizedChapterId && !chapter) throw new NotFoundError('chapter not found');
        if (job.type === 'translate_chapters' && !targetIncludesChapter(job, chapter.chapter_number)) {
          throw new ConflictError('chapter is not in the job target');
        }
        if (job.type === 'build_epub' && !exportInNovel.get(JSON.parse(job.target_json).exportId, id)) {
          throw new ConflictError('EPUB job target is not available');
        }
        const attempt = {
          id: randomUUID(),
          jobId: job.id,
          novelId: id,
          chapterId: normalizedChapterId,
          attemptNumber: nextAttempt.get(job.id, normalizedChapterId).attempt_number,
          startedAt: clock().toISOString(),
          claimToken: job.claim_token
        };
        insertAttempt.run(attempt);
        appendEvent(job, { type: 'chapter_started', message: 'Checkpoint started.', chapterId: normalizedChapterId, details: normalizedChapterId ? { chapterId: normalizedChapterId, attemptNumber: attempt.attemptNumber } : { attemptNumber: attempt.attemptNumber } });
        return toAttempt(attemptById.get(attempt.id, job.id));
      });
    },

    prepareTranslationAttempt(input) {
      const { novelId, jobId, claimToken } = requireObject(input);
      const id = requireNovel(novelId);
      const token = requireId(claimToken, 'claimToken');
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.type !== 'translate_chapters' || job.state !== 'running' || job.claim_token !== token) {
          throw new ConflictError('translation job claim is no longer active');
        }

        if (job.current_chapter_id && revisionExists.get(job.current_chapter_id)) {
          if (!completedEventExists.get(job.id, job.current_chapter_id)) {
            appendEvent(job, {
              type: 'chapter_completed',
              message: 'Recovered completed checkpoint.',
              chapterId: job.current_chapter_id,
              details: { chapterId: job.current_chapter_id }
            });
          }
          if (clearCheckpoint.run(clock().toISOString(), job.id, id, token).changes === 0) {
            throw new ConflictError('translation job claim is no longer active');
          }
        }

        const refreshed = jobInNovel.get(job.id, id);
        const chapter = sourcedUntranslatedChapters.all(id).find((candidate) => targetIncludesChapter(refreshed, candidate.chapter_number));
        if (!chapter) return { status: 'completed' };

        const nextAttemptNumber = nextAttempt.get(refreshed.id, chapter.id).attempt_number;
        if (nextAttemptNumber > 4) return { status: 'exhausted', chapterId: chapter.id, chapterNumber: chapter.chapter_number };
        if (setCheckpoint.run(chapter.id, clock().toISOString(), refreshed.id, id, token).changes === 0) {
          throw new ConflictError('translation job claim is no longer active');
        }
        const attempt = {
          id: randomUUID(),
          jobId: refreshed.id,
          novelId: id,
          chapterId: chapter.id,
          attemptNumber: nextAttemptNumber,
          startedAt: clock().toISOString(),
          claimToken: token
        };
        insertAttempt.run(attempt);
        appendEvent(refreshed, {
          type: 'chapter_started',
          message: 'Checkpoint started.',
          chapterId: chapter.id,
          details: { chapterId: chapter.id, attemptNumber: attempt.attemptNumber }
        });
        return {
          status: 'started',
          chapterId: chapter.id,
          chapterNumber: chapter.chapter_number,
          attempt: toAttempt(attemptById.get(attempt.id, refreshed.id))
        };
      });
    },

    renewTranslationClaim(input) {
      const { novelId, jobId, claimToken } = requireObject(input);
      const id = requireNovel(novelId);
      return renewClaim.run(clock().toISOString(), clock().toISOString(), requireId(jobId, 'jobId'), id, requireId(claimToken, 'claimToken')).changes === 1;
    },

    assertActiveTranslationClaim(input) {
      const { novelId, jobId, claimToken, chapterId } = requireObject(input);
      const id = requireNovel(novelId);
      if (!activeTranslationClaim.get(requireId(jobId, 'jobId'), id, requireId(claimToken, 'claimToken'), requireId(chapterId, 'chapterId'))) {
        throw new ConflictError('translation job claim is no longer active');
      }
    },

    recoverStaleTranslationClaims(input) {
      const { claimedBefore } = requireObject(input);
      const cutoff = requireId(claimedBefore, 'claimedBefore');
      return withinTransaction(() => {
        const now = clock().toISOString();
        return staleRunningJobs.all(cutoff).flatMap((job) => {
          abandonStartedAttempts.run(now, job.id);
          const state = job.next_run_at === null ? 'queued' : 'retrying';
          if (recoverJob.run(state, now, job.id).changes === 0) return [];
          const recovered = jobById.get(job.id);
          appendEvent(recovered, { type: 'recovered', message: 'Stale job claim recovered.', details: {} });
          return [toJob(recovered)];
        });
      });
    },

    abandonPausedTranslationAttempts(input) {
      const { novelId, jobId } = requireObject(input);
      const id = requireNovel(novelId);
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.type !== 'translate_chapters' || job.state !== 'paused') return 0;
        return abandonStartedAttempts.run(clock().toISOString(), job.id).changes;
      });
    },

    releaseDueTranslationRetries() {
      return withinTransaction(() => {
        const now = clock().toISOString();
        return dueRetries.all(now).flatMap((job) => {
          if (releaseRetry.run(now, job.id, now).changes === 0) return [];
          return [toJob(jobById.get(job.id))];
        });
      });
    },

    nextTranslationRetryAt() {
      return nextRetry.get().next_run_at;
    },

    finishAttempt(input) {
      const { jobId, attemptId, claimToken, state, errorCode = null, errorMessage = null } = requireObject(input);
      if (!attemptStates.has(state) || state === 'started') throw new ValidationError('attempt state is invalid');
      return withinTransaction(() => {
        const job = jobById.get(requireId(jobId, 'jobId'));
        if (!job) throw new NotFoundError('job not found');
        const normalizedClaimToken = requireId(claimToken, 'claimToken');
        if (job.state !== 'running' || job.claim_token !== normalizedClaimToken) throw new ConflictError('job claim is no longer active');
        const attempt = attemptById.get(requireId(attemptId, 'attemptId'), job.id);
        if (!attempt) throw new NotFoundError('job attempt not found');
        if (attempt.claim_token !== normalizedClaimToken) throw new ConflictError('job attempt belongs to a different claim');
        const finishedAt = clock().toISOString();
        if (finishAttempt.run({ id: attempt.id, jobId: job.id, claimToken: normalizedClaimToken, state, finishedAt, errorCode: requireOptionalText(errorCode, 'errorCode'), errorMessage: requireOptionalText(errorMessage, 'errorMessage') }).changes === 0) {
          throw new ConflictError('job attempt is no longer active');
        }
        if (state === 'succeeded') {
          appendEvent(job, { type: 'chapter_completed', message: 'Checkpoint completed.', chapterId: attempt.chapter_id, details: attempt.chapter_id ? { chapterId: attempt.chapter_id, attemptNumber: attempt.attempt_number } : { attemptNumber: attempt.attempt_number } });
        }
        return toAttempt(attemptById.get(attempt.id, job.id));
      });
    },

    listJobAttempts(input) {
      const job = jobInNovel.get(requireId(requireObject(input).jobId, 'jobId'), requireNovel(input.novelId));
      if (!job) throw new NotFoundError('job not found');
      return attemptsForJob.all(job.id).map(toAttempt);
    },

    listJobEvents(input) {
      const job = jobInNovel.get(requireId(requireObject(input).jobId, 'jobId'), requireNovel(input.novelId));
      if (!job) throw new NotFoundError('job not found');
      return eventsForJob.all(job.id).map(toEvent);
    }
  };
}
