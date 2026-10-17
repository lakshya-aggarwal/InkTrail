import { createHash, randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

const jobTypes = new Set(['translate_chapters', 'build_epub', 'source_import_catalog']);
const jobStates = new Set(['queued', 'running', 'retrying', 'paused', 'failed', 'completed']);
const attemptStates = new Set(['started', 'succeeded', 'retryable_failed', 'paused_after_failure', 'abandoned_on_recovery']);
const eventTypes = new Set(['job_created', 'claimed', 'chapter_started', 'chapter_completed', 'catalog_entry_started', 'catalog_entry_completed', 'retry_scheduled', 'paused', 'resumed', 'recovered', 'failed', 'completed']);
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

export function canonicalizeSourceCatalogTarget(value) {
  const target = requireObject(value, 'target');
  if (Object.keys(target).length !== 1 || !Object.hasOwn(target, 'catalogId')) throw new ValidationError('target must contain only catalogId');
  const catalogId = requireId(target.catalogId, 'catalogId');
  const targetJson = JSON.stringify({ catalogId });
  return { catalogId, targetJson, targetHash: hash(targetJson) };
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
    currentCatalogEntryId: row.current_catalog_entry_id,
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
    catalogEntryId: row.catalog_entry_id,
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
    catalogEntryId: row.catalog_entry_id,
    type: row.type,
    message: row.message,
    details: JSON.parse(row.details_json),
    createdAt: row.created_at
  };
}

function safeDetails(value) {
  const details = requireObject(value ?? {}, 'details');
  for (const [key, item] of Object.entries(details)) {
    if (!['chapterId', 'catalogEntryId', 'attemptId', 'exportId', 'completedCount', 'remainingCount', 'attemptNumber'].includes(key)) {
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
  const catalogInNovel = database.prepare('select 1 from source_catalogs where id = ? and novel_id = ?');
  const catalogEntryInNovel = database.prepare('select * from source_catalog_entries where id = ? and novel_id = ?');
  const jobById = database.prepare('select * from jobs where id = ?');
  const jobInNovel = database.prepare('select * from jobs where id = ? and novel_id = ?');
  const jobByIdempotencyKey = database.prepare('select * from jobs where novel_id = ? and type = ? and idempotency_key = ?');
  const activeJobByTarget = database.prepare("select * from jobs where novel_id = ? and type = ? and target_hash = ? and state in ('queued', 'running', 'retrying')");
  const sourcedChapterCountForRange = database.prepare(`
    select count(*) as count
    from chapters
    where novel_id = ? and chapter_number between ? and ?
      and exists (select 1 from chapter_sources where chapter_sources.chapter_id = chapters.id)
  `);
  const sourcedChapterCountForNumbers = database.prepare(`
    select count(*) as count
    from chapters
    where novel_id = ?
      and exists (select 1 from chapter_sources where chapter_sources.chapter_id = chapters.id)
      and chapter_number in (select value from json_each(?, '$.chapterNumbers'))
  `);
  const insertJob = database.prepare(`
    insert into jobs (
      id, novel_id, type, target_json, target_hash, idempotency_key, state, priority,
      next_run_at, claimed_at, claim_token, current_chapter_id, current_catalog_entry_id, last_error_code,
      last_error_message, created_at, updated_at, completed_at
    ) values (
      @id, @novelId, @type, @targetJson, @targetHash, @idempotencyKey, @state, @priority,
      null, null, null, null, null, null, null, @createdAt, @updatedAt, null
    )
  `);
  const insertEvent = database.prepare(`
    insert into job_events (id, job_id, novel_id, chapter_id, catalog_entry_id, type, message, details_json, created_at)
    values (@id, @jobId, @novelId, @chapterId, @catalogEntryId, @type, @message, @detailsJson, @createdAt)
  `);
  const runnableJob = database.prepare(`
    select * from jobs
    where ((? is null and (? = 1 or type <> 'source_import_catalog')) or type = ?)
      and state = 'queued' and (next_run_at is null or next_run_at <= ?)
      and (type <> 'translate_chapters' or not exists (
        select 1 from jobs as active_translation
        where active_translation.novel_id = jobs.novel_id
          and active_translation.type = 'translate_chapters'
          and active_translation.state in ('running', 'retrying')
      ))
      and (type <> 'translate_chapters' or not exists (
        select 1 from jobs as earlier_translation
        where earlier_translation.novel_id = jobs.novel_id
          and earlier_translation.type = 'translate_chapters'
          and earlier_translation.state = 'queued'
          and (
            select min(target_chapter.chapter_number)
            from chapters as target_chapter
            where target_chapter.novel_id = earlier_translation.novel_id
              and exists (select 1 from chapter_sources where chapter_sources.chapter_id = target_chapter.id)
              and not exists (select 1 from translation_revisions where translation_revisions.chapter_id = target_chapter.id)
              and (
                exists (
                  select 1 from json_each(earlier_translation.target_json, '$.chapterNumbers')
                  where value = target_chapter.chapter_number
                )
                or (
                  json_extract(earlier_translation.target_json, '$.chapterNumbers') is null
                  and target_chapter.chapter_number between json_extract(earlier_translation.target_json, '$.startChapterNumber') and json_extract(earlier_translation.target_json, '$.endChapterNumber')
                )
              )
          ) < (
            select min(target_chapter.chapter_number)
            from chapters as target_chapter
            where target_chapter.novel_id = jobs.novel_id
              and exists (select 1 from chapter_sources where chapter_sources.chapter_id = target_chapter.id)
              and not exists (select 1 from translation_revisions where translation_revisions.chapter_id = target_chapter.id)
              and (
                exists (
                  select 1 from json_each(jobs.target_json, '$.chapterNumbers')
                  where value = target_chapter.chapter_number
                )
                or (
                  json_extract(jobs.target_json, '$.chapterNumbers') is null
                  and target_chapter.chapter_number between json_extract(jobs.target_json, '$.startChapterNumber') and json_extract(jobs.target_json, '$.endChapterNumber')
                )
              )
          )
      ))
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
      current_chapter_id = @currentChapterId, current_catalog_entry_id = @currentCatalogEntryId, last_error_code = @lastErrorCode,
      last_error_message = @lastErrorMessage, updated_at = @updatedAt, completed_at = @completedAt
    where id = @id and novel_id = @novelId and state = @fromState
      and (@expectedClaimToken is null or claim_token = @expectedClaimToken)
  `);
  const attemptById = database.prepare('select * from job_attempts where id = ? and job_id = ?');
  const nextAttempt = database.prepare('select coalesce(max(attempt_number), 0) + 1 as attempt_number from job_attempts where job_id = ? and chapter_id is ? and catalog_entry_id is ?');
  const insertAttempt = database.prepare(`
    insert into job_attempts (id, job_id, novel_id, chapter_id, catalog_entry_id, attempt_number, state, started_at, finished_at, error_code, error_message, claim_token)
    values (@id, @jobId, @novelId, @chapterId, @catalogEntryId, @attemptNumber, 'started', @startedAt, null, null, null, @claimToken)
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
  const nextUncompletedCatalogEntry = database.prepare(`
    select entries.*
    from source_catalog_entries as entries
    join source_catalogs as catalogs on catalogs.id = entries.catalog_id
    where entries.catalog_id = ?
      and entries.novel_id = ?
      and not (
        exists (
          select 1 from chapter_sources
          where chapter_sources.novel_id = entries.novel_id
            and chapter_sources.novel_source_id = catalogs.novel_source_id
            and chapter_sources.normalized_url = entries.normalized_url
        )
        and exists (
          select 1 from job_events
          where job_events.catalog_entry_id = entries.id
            and job_events.type = 'catalog_entry_completed'
        )
      )
    order by entries.ordinal
    limit 1
  `);
  const catalogEntryMapping = database.prepare(`
    select chapter_sources.chapter_id
    from source_catalog_entries as entries
    join source_catalogs as catalogs on catalogs.id = entries.catalog_id
    join chapter_sources on chapter_sources.novel_id = entries.novel_id
      and chapter_sources.novel_source_id = catalogs.novel_source_id
      and chapter_sources.normalized_url = entries.normalized_url
    where entries.id = ? and entries.novel_id = ? and entries.catalog_id = ? and chapter_sources.chapter_id = ?
  `);
  const completedCatalogEntryEvent = database.prepare("select 1 from job_events where job_id = ? and catalog_entry_id = ? and type = 'catalog_entry_completed' limit 1");
  const setCheckpoint = database.prepare(`
    update jobs set current_chapter_id = ?, updated_at = ?
    where id = ? and novel_id = ? and state = 'running' and claim_token = ?
  `);
  const clearCheckpoint = database.prepare(`
    update jobs set current_chapter_id = null, updated_at = ?
    where id = ? and novel_id = ? and state = 'running' and claim_token = ?
  `);
  const setCatalogEntryCheckpoint = database.prepare(`
    update jobs set current_catalog_entry_id = ?, updated_at = ?
    where id = ? and novel_id = ? and state = 'running' and claim_token = ?
  `);
  const staleRunningJobs = database.prepare(`
    select * from jobs
    where state = 'running'
      and (type in ('translate_chapters', 'build_epub') or (? = 1 and type = 'source_import_catalog'))
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
    where (type = 'translate_chapters' or (? = 1 and type = 'source_import_catalog'))
      and state = 'retrying' and next_run_at <= ?
    order by priority desc, created_at, id
  `);
  const releaseRetry = database.prepare(`
    update jobs set state = 'queued', next_run_at = null, updated_at = ?
    where id = ? and state = 'retrying' and next_run_at <= ?
  `);
  const nextRetry = database.prepare("select min(next_run_at) as next_run_at from jobs where (type = 'translate_chapters' or (? = 1 and type = 'source_import_catalog')) and state = 'retrying'");
  const nextRunningClaim = database.prepare("select min(claimed_at) as claimed_at from jobs where (type in ('translate_chapters', 'build_epub') or (? = 1 and type = 'source_import_catalog')) and state = 'running' and claimed_at is not null");
  const activeTranslationClaim = database.prepare(`
    select 1 from jobs
    where id = ? and novel_id = ? and type = 'translate_chapters'
      and state = 'running' and claim_token = ? and current_chapter_id = ?
  `);
  const activeSourceImportClaim = database.prepare(`
    select 1 from jobs
    where id = ? and novel_id = ? and type = 'source_import_catalog'
      and state = 'running' and claim_token = ? and current_catalog_entry_id = ?
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
    const catalogEntryId = input.catalogEntryId ?? null;
    if (catalogEntryId !== null) {
      const entry = catalogEntryInNovel.get(requireId(catalogEntryId, 'catalogEntryId'), job.novel_id);
      if (!entry || job.type !== 'source_import_catalog' || entry.catalog_id !== JSON.parse(job.target_json).catalogId) {
        throw new NotFoundError('catalog entry not found');
      }
    }
    const event = {
      id: randomUUID(),
      jobId: job.id,
      novelId: job.novel_id,
      chapterId,
      catalogEntryId,
      type,
      message,
      detailsJson: safeDetails(input.details),
      createdAt: clock().toISOString()
    };
    insertEvent.run(event);
    return event;
  }

  function createJob(input, transaction = withinTransaction) {
    const { novelId, type, target, idempotencyKey = null, priority = 0 } = requireObject(input);
    const normalizedNovelId = requireNovel(novelId);
    if (!jobTypes.has(type)) throw new ValidationError('job type is invalid');
    if (!Number.isSafeInteger(priority)) throw new ValidationError('priority must be an integer');
    const normalizedTarget = type === 'translate_chapters'
      ? canonicalizeChapterTarget(target)
      : type === 'build_epub'
        ? (() => {
          const exportId = requireId(requireObject(target, 'target').exportId, 'exportId');
          const targetJson = JSON.stringify({ exportId });
          return { targetJson, targetHash: hash(targetJson), exportId };
        })()
        : canonicalizeSourceCatalogTarget(target);
    const normalizedKey = idempotencyKey === null || idempotencyKey === undefined ? null : requireId(idempotencyKey, 'idempotencyKey');

    return transaction(() => {
      if (type === 'build_epub' && !exportInNovel.get(normalizedTarget.exportId, normalizedNovelId)) {
        throw new NotFoundError('EPUB export not found');
      }
      if (type === 'source_import_catalog' && !catalogInNovel.get(normalizedTarget.catalogId, normalizedNovelId)) {
        throw new NotFoundError('source catalog not found');
      }
      if (type === 'translate_chapters') {
        const expectedCount = normalizedTarget.chapterNumbers?.length
          ?? normalizedTarget.endChapterNumber - normalizedTarget.startChapterNumber + 1;
        const sourcedCount = normalizedTarget.chapterNumbers
          ? sourcedChapterCountForNumbers.get(normalizedNovelId, normalizedTarget.targetJson).count
          : sourcedChapterCountForRange.get(normalizedNovelId, normalizedTarget.startChapterNumber, normalizedTarget.endChapterNumber).count;
        if (sourcedCount !== expectedCount) throw new ConflictError('translation target must contain only imported source chapters');
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

    createBuildEpubJobInTransaction(input) {
      return createJob({ ...requireObject(input), type: 'build_epub' }, (action) => action());
    },

    createSourceImportCatalogJob(input) {
      return createJob({ ...requireObject(input), type: 'source_import_catalog' });
    },

    nextSourceImportCatalogEntry(input) {
      const { novelId, jobId } = requireObject(input);
      const id = requireNovel(novelId);
      const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
      if (!job) throw new NotFoundError('job not found');
      if (job.type !== 'source_import_catalog') throw new ConflictError('job is not a source import');
      const entry = nextUncompletedCatalogEntry.get(JSON.parse(job.target_json).catalogId, id);
      return entry ? {
        id: entry.id,
        catalogId: entry.catalog_id,
        novelId: entry.novel_id,
        ordinal: entry.ordinal,
        externalChapterId: entry.external_chapter_id,
        sourceUrl: entry.source_url,
        normalizedUrl: entry.normalized_url,
        sourceTitle: entry.source_title
      } : null;
    },

    markSourceImportCatalogEntryCompleted(input) {
      const { novelId, jobId, catalogEntryId, chapterId, claimToken } = requireObject(input);
      const id = requireNovel(novelId);
      const entryId = requireId(catalogEntryId, 'catalogEntryId');
      const sourceChapterId = requireId(chapterId, 'chapterId');
      const token = requireId(claimToken, 'claimToken');
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.type !== 'source_import_catalog' || job.state !== 'running' || job.claim_token !== token) {
          throw new ConflictError('source import job claim is no longer active');
        }
        const catalogId = JSON.parse(job.target_json).catalogId;
        if (!catalogEntryMapping.get(entryId, id, catalogId, sourceChapterId)) {
          throw new ConflictError('catalog entry has not been imported');
        }
        if (completedCatalogEntryEvent.get(job.id, entryId)) return false;
        appendEvent(job, {
          type: 'catalog_entry_completed',
          message: 'Catalog entry completed.',
          catalogEntryId: entryId,
          details: { catalogEntryId: entryId }
        });
        return true;
      });
    },

    completeSourceImportAttempt(input) {
      const { novelId, jobId, attemptId, catalogEntryId, chapterId, claimToken } = requireObject(input);
      const id = requireNovel(novelId);
      const entryId = requireId(catalogEntryId, 'catalogEntryId');
      const sourceChapterId = requireId(chapterId, 'chapterId');
      const token = requireId(claimToken, 'claimToken');
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.type !== 'source_import_catalog' || job.state !== 'running' || job.claim_token !== token) {
          throw new ConflictError('source import job claim is no longer active');
        }
        const attempt = attemptById.get(requireId(attemptId, 'attemptId'), job.id);
        if (!attempt || attempt.claim_token !== token || attempt.catalog_entry_id !== entryId) {
          throw new ConflictError('source import attempt is no longer active');
        }
        const catalogId = JSON.parse(job.target_json).catalogId;
        if (!catalogEntryMapping.get(entryId, id, catalogId, sourceChapterId)) {
          throw new ConflictError('catalog entry has not been imported');
        }
        const finishedAt = clock().toISOString();
        if (finishAttempt.run({ id: attempt.id, jobId: job.id, claimToken: token, state: 'succeeded', finishedAt, errorCode: null, errorMessage: null }).changes === 0) {
          throw new ConflictError('source import attempt is no longer active');
        }
        if (!completedCatalogEntryEvent.get(job.id, entryId)) {
          appendEvent(job, {
            type: 'catalog_entry_completed',
            message: 'Catalog entry completed.',
            catalogEntryId: entryId,
            details: { catalogEntryId: entryId, attemptNumber: attempt.attempt_number }
          });
        }
        if (nextUncompletedCatalogEntry.get(catalogId, id)) return { completed: false };
        const completed = {
          id: job.id,
          novelId: id,
          fromState: 'running',
          state: 'completed',
          expectedClaimToken: token,
          nextRunAt: null,
          claimedAt: null,
          claimToken: null,
          currentChapterId: null,
          currentCatalogEntryId: entryId,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: finishedAt,
          completedAt: finishedAt
        };
        if (updateJob.run(completed).changes === 0) throw new ConflictError('source import job claim is no longer active');
        appendEvent(jobById.get(job.id), { type: 'completed', message: 'Job completed.', catalogEntryId: entryId, details: { catalogEntryId: entryId } });
        return { completed: true };
      });
    },

    failSourceImportAttempt(input) {
      const { novelId, jobId, attemptId, catalogEntryId, claimToken, retry, terminalState = 'failed', nextRunAt = null, errorCode, errorMessage } = requireObject(input);
      const id = requireNovel(novelId);
      const entryId = requireId(catalogEntryId, 'catalogEntryId');
      const token = requireId(claimToken, 'claimToken');
      if (typeof retry !== 'boolean') throw new ValidationError('retry must be a boolean');
      if (!retry && !['paused', 'failed'].includes(terminalState)) throw new ValidationError('terminalState is invalid');
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.type !== 'source_import_catalog' || job.state !== 'running' || job.claim_token !== token) {
          throw new ConflictError('source import job claim is no longer active');
        }
        const attempt = attemptById.get(requireId(attemptId, 'attemptId'), job.id);
        if (!attempt || attempt.claim_token !== token || attempt.catalog_entry_id !== entryId) {
          throw new ConflictError('source import attempt is no longer active');
        }
        const now = clock().toISOString();
        if (finishAttempt.run({
          id: attempt.id,
          jobId: job.id,
          claimToken: token,
          state: retry ? 'retryable_failed' : 'paused_after_failure',
          finishedAt: now,
          errorCode: requireOptionalText(errorCode, 'errorCode'),
          errorMessage: requireOptionalText(errorMessage, 'errorMessage')
        }).changes === 0) throw new ConflictError('source import attempt is no longer active');
        const state = retry ? 'retrying' : terminalState;
        const updated = {
          id: job.id,
          novelId: id,
          fromState: 'running',
          state,
          expectedClaimToken: token,
          nextRunAt: retry ? requireId(nextRunAt, 'nextRunAt') : null,
          claimedAt: null,
          claimToken: null,
          currentChapterId: null,
          currentCatalogEntryId: entryId,
          lastErrorCode: requireOptionalText(errorCode, 'errorCode'),
          lastErrorMessage: requireOptionalText(errorMessage, 'errorMessage'),
          updatedAt: now,
          completedAt: state === 'failed' ? now : null
        };
        if (updateJob.run(updated).changes === 0) throw new ConflictError('source import job claim is no longer active');
        appendEvent(jobById.get(job.id), {
          type: state === 'retrying' ? 'retry_scheduled' : state === 'paused' ? 'paused' : 'failed',
          message: state === 'retrying' ? 'Job retrying.' : state === 'paused' ? 'Job paused.' : 'Job failed.',
          catalogEntryId: entryId,
          details: { catalogEntryId: entryId, attemptNumber: attempt.attempt_number }
        });
        return toJob(jobById.get(job.id));
      });
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
      const { claimToken: inputClaimToken, type = null, includeSourceImports = false } = requireObject(input);
      const claimToken = requireId(inputClaimToken, 'claimToken');
      if (type !== null && !jobTypes.has(type)) throw new ValidationError('job type is invalid');
      if (typeof includeSourceImports !== 'boolean') throw new ValidationError('includeSourceImports must be a boolean');
      return withinTransaction(() => {
        const now = clock().toISOString();
        const candidate = runnableJob.get(type, includeSourceImports ? 1 : 0, type, now);
        if (!candidate) return null;
        if (claimJob.run(now, claimToken, now, candidate.id, now).changes === 0) return null;
        const claimed = jobById.get(candidate.id);
        appendEvent(claimed, { type: 'claimed', message: 'Job claimed.', details: {} });
        return toJob(claimed);
      });
    },

    transitionJob(input) {
      const { novelId, jobId, toState, nextRunAt = null, currentChapterId = null, currentCatalogEntryId = null, errorCode = null, errorMessage = null, claimToken = null } = requireObject(input);
      const id = requireNovel(novelId);
      const expectedClaimToken = claimToken === null ? null : requireId(claimToken, 'claimToken');
      if (!jobStates.has(toState)) throw new ValidationError('job state is invalid');
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (!transitions[job.state].has(toState)) throw new ConflictError('job state transition is not allowed');
        const chapterId = currentChapterId === null ? job.current_chapter_id : requireId(currentChapterId, 'currentChapterId');
        if (chapterId !== null && !chapterInNovel.get(chapterId, id)) throw new NotFoundError('chapter not found');
        const catalogEntryId = currentCatalogEntryId === null ? job.current_catalog_entry_id : requireId(currentCatalogEntryId, 'currentCatalogEntryId');
        if (catalogEntryId !== null) {
          const entry = catalogEntryInNovel.get(catalogEntryId, id);
          if (!entry || job.type !== 'source_import_catalog' || entry.catalog_id !== JSON.parse(job.target_json).catalogId) throw new NotFoundError('catalog entry not found');
        }
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
          currentCatalogEntryId: catalogEntryId,
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
        appendEvent(transitioned, { type: eventType, message: `Job ${toState}.`, chapterId, catalogEntryId, details: catalogEntryId ? { catalogEntryId } : chapterId ? { chapterId } : {} });
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
      const { novelId, jobId, chapterId = null, catalogEntryId = null, claimToken } = requireObject(input);
      const id = requireNovel(novelId);
      const token = requireId(claimToken, 'claimToken');
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.state !== 'running') throw new ConflictError('job is not running');
        if (!job.claim_token || job.claim_token !== token) throw new ConflictError('job claim is no longer active');
        if (job.type === 'translate_chapters' && chapterId === null) throw new ValidationError('chapterId is required for translation attempts');
        if (job.type === 'build_epub' && chapterId !== null) throw new ValidationError('chapterId is not allowed for EPUB attempts');
        if (job.type === 'source_import_catalog' && (catalogEntryId === null || chapterId !== null)) throw new ValidationError('source import attempts require only catalogEntryId');
        if (job.type !== 'source_import_catalog' && catalogEntryId !== null) throw new ValidationError('catalogEntryId is only allowed for source import attempts');
        const normalizedChapterId = chapterId === null ? null : requireId(chapterId, 'chapterId');
        const normalizedCatalogEntryId = catalogEntryId === null ? null : requireId(catalogEntryId, 'catalogEntryId');
        const chapter = normalizedChapterId === null ? null : chapterByIdInNovel.get(normalizedChapterId, id);
        if (normalizedChapterId && !chapter) throw new NotFoundError('chapter not found');
        if (job.type === 'translate_chapters' && !targetIncludesChapter(job, chapter.chapter_number)) {
          throw new ConflictError('chapter is not in the job target');
        }
        if (job.type === 'build_epub' && !exportInNovel.get(JSON.parse(job.target_json).exportId, id)) {
          throw new ConflictError('EPUB job target is not available');
        }
        if (job.type === 'source_import_catalog') {
          const entry = catalogEntryInNovel.get(normalizedCatalogEntryId, id);
          if (!entry || entry.catalog_id !== JSON.parse(job.target_json).catalogId) throw new ConflictError('catalog entry is not in the job target');
        }
        const attempt = {
          id: randomUUID(),
          jobId: job.id,
          novelId: id,
          chapterId: normalizedChapterId,
          catalogEntryId: normalizedCatalogEntryId,
          attemptNumber: nextAttempt.get(job.id, normalizedChapterId, normalizedCatalogEntryId).attempt_number,
          startedAt: clock().toISOString(),
          claimToken: token
        };
        if (normalizedCatalogEntryId !== null && setCatalogEntryCheckpoint.run(normalizedCatalogEntryId, clock().toISOString(), job.id, id, token).changes === 0) {
          throw new ConflictError('source import job claim is no longer active');
        }
        insertAttempt.run(attempt);
        appendEvent(job, { type: normalizedCatalogEntryId ? 'catalog_entry_started' : 'chapter_started', message: 'Checkpoint started.', chapterId: normalizedChapterId, catalogEntryId: normalizedCatalogEntryId, details: normalizedCatalogEntryId ? { catalogEntryId: normalizedCatalogEntryId, attemptNumber: attempt.attemptNumber } : normalizedChapterId ? { chapterId: normalizedChapterId, attemptNumber: attempt.attemptNumber } : { attemptNumber: attempt.attemptNumber } });
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

    assertActiveSourceImportClaim(input) {
      const { novelId, jobId, claimToken, catalogEntryId } = requireObject(input);
      const id = requireNovel(novelId);
      if (!activeSourceImportClaim.get(requireId(jobId, 'jobId'), id, requireId(claimToken, 'claimToken'), requireId(catalogEntryId, 'catalogEntryId'))) {
        throw new ConflictError('source import job claim is no longer active');
      }
    },

    recoverStaleTranslationClaims(input) {
      const { claimedBefore, includeSourceImports = false } = requireObject(input);
      const cutoff = requireId(claimedBefore, 'claimedBefore');
      if (typeof includeSourceImports !== 'boolean') throw new ValidationError('includeSourceImports must be a boolean');
      return withinTransaction(() => {
        const now = clock().toISOString();
        return staleRunningJobs.all(includeSourceImports ? 1 : 0, cutoff).flatMap((job) => {
          abandonStartedAttempts.run(now, job.id);
          const state = job.next_run_at === null ? 'queued' : 'retrying';
          if (recoverJob.run(state, now, job.id).changes === 0) return [];
          const recovered = jobById.get(job.id);
          appendEvent(recovered, { type: 'recovered', message: 'Stale job claim recovered.', details: {} });
          return [toJob(recovered)];
        });
      });
    },

    pauseTranslationJob(input) {
      const { novelId, jobId } = requireObject(input);
      const id = requireNovel(novelId);
      return withinTransaction(() => {
        const job = jobInNovel.get(requireId(jobId, 'jobId'), id);
        if (!job) throw new NotFoundError('job not found');
        if (job.state === 'paused') return toJob(job);
        if (!transitions[job.state].has('paused')) throw new ConflictError('job state transition is not allowed');
        const now = clock().toISOString();
        if (job.state === 'running') {
          abandonStartedAttempts.run(now, job.id);
        }
        const updated = {
          id: job.id,
          novelId: id,
          fromState: job.state,
          state: 'paused',
          expectedClaimToken: null,
          nextRunAt: null,
          claimedAt: null,
          claimToken: null,
          currentChapterId: job.current_chapter_id,
          currentCatalogEntryId: job.current_catalog_entry_id,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now,
          completedAt: null
        };
        if (updateJob.run(updated).changes === 0) throw new ConflictError('job state transition is stale');
        const paused = jobInNovel.get(job.id, id);
        appendEvent(paused, {
          type: 'paused',
          message: 'Job paused.',
          chapterId: job.current_chapter_id,
          catalogEntryId: job.current_catalog_entry_id,
          details: job.current_catalog_entry_id ? { catalogEntryId: job.current_catalog_entry_id } : job.current_chapter_id ? { chapterId: job.current_chapter_id } : {}
        });
        return toJob(paused);
      });
    },

    releaseDueTranslationRetries(input = {}) {
      const { includeSourceImports = false } = requireObject(input);
      if (typeof includeSourceImports !== 'boolean') throw new ValidationError('includeSourceImports must be a boolean');
      return withinTransaction(() => {
        const now = clock().toISOString();
        return dueRetries.all(includeSourceImports ? 1 : 0, now).flatMap((job) => {
          if (releaseRetry.run(now, job.id, now).changes === 0) return [];
          return [toJob(jobById.get(job.id))];
        });
      });
    },

    nextTranslationRetryAt(input = {}) {
      const { includeSourceImports = false } = requireObject(input);
      if (typeof includeSourceImports !== 'boolean') throw new ValidationError('includeSourceImports must be a boolean');
      return nextRetry.get(includeSourceImports ? 1 : 0).next_run_at;
    },

    nextRunningClaimAt(input = {}) {
      const { includeSourceImports = false } = requireObject(input);
      if (typeof includeSourceImports !== 'boolean') throw new ValidationError('includeSourceImports must be a boolean');
      return nextRunningClaim.get(includeSourceImports ? 1 : 0).claimed_at;
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
        if (state === 'succeeded' && !attempt.catalog_entry_id) {
          appendEvent(job, {
            type: attempt.catalog_entry_id ? 'catalog_entry_completed' : 'chapter_completed',
            message: 'Checkpoint completed.',
            chapterId: attempt.chapter_id,
            catalogEntryId: attempt.catalog_entry_id,
            details: attempt.catalog_entry_id ? { catalogEntryId: attempt.catalog_entry_id, attemptNumber: attempt.attempt_number } : attempt.chapter_id ? { chapterId: attempt.chapter_id, attemptNumber: attempt.attempt_number } : { attemptNumber: attempt.attempt_number }
          });
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
