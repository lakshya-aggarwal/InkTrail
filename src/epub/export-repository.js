import { randomUUID } from 'node:crypto';
import { canonicalizeChapterTarget } from '../jobs/job-repository.js';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

const exportStates = new Set(['queued', 'building', 'available', 'failed']);
const exportTransitions = {
  queued: new Set(['building', 'failed']),
  building: new Set(['queued', 'available', 'failed']),
  available: new Set(),
  failed: new Set()
};

function requireObject(value, name = 'input') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value;
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function requireSafeText(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) throw new ValidationError(`${name} is invalid`);
  return value.trim();
}

function requireSha256(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidationError('sha256 must be a lowercase SHA-256 digest');
  return value;
}

function requireByteSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError('byteSize must be a non-negative integer');
  return value;
}

function generatedFileName(exportId) {
  return `${exportId}.epub`;
}

function toExport(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    jobId: row.job_id,
    state: row.state,
    selection: JSON.parse(row.selection_json),
    snapshotAt: row.snapshot_at,
    fileName: row.file_name,
    byteSize: row.byte_size,
    sha256: row.sha256,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function toExportChapter(row) {
  return {
    exportId: row.export_id,
    chapterId: row.chapter_id,
    translationRevisionId: row.translation_revision_id,
    chapterNumber: row.chapter_number,
    title: row.title,
    sourceUrl: row.source_url,
    ordinal: row.ordinal,
    translatedText: row.translated_text
  };
}

export function createExportRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const exportInNovel = database.prepare('select * from epub_exports where id = ? and novel_id = ?');
  const buildJobInNovel = database.prepare("select 1 from jobs where id = ? and novel_id = ? and type = 'build_epub'");
  const buildJobForExport = database.prepare("select 1 from jobs where id = ? and novel_id = ? and type = 'build_epub' and json_extract(target_json, '$.exportId') = ?");
  const activeBuildClaim = database.prepare("select 1 from jobs where id = ? and novel_id = ? and type = 'build_epub' and state = 'running' and claim_token = ? and json_extract(target_json, '$.exportId') = ?");
  const insertExport = database.prepare(`
    insert into epub_exports (
      id, novel_id, job_id, state, selection_json, snapshot_at, file_name, byte_size,
      sha256, last_error_code, last_error_message, created_at, updated_at, completed_at
    ) values (
      @id, @novelId, @jobId, @state, @selectionJson, @snapshotAt, @fileName, null,
      null, null, null, @createdAt, @updatedAt, null
    )
  `);
  const insertExportChapter = database.prepare(`
    insert into epub_export_chapters (
      export_id, chapter_id, translation_revision_id, chapter_number, title, source_url, ordinal
    ) values (@exportId, @chapterId, @translationRevisionId, @chapterNumber, @title, @sourceUrl, @ordinal)
  `);
  const updateExport = database.prepare(`
    update epub_exports
    set state = @state, byte_size = @byteSize, sha256 = @sha256,
      last_error_code = @lastErrorCode, last_error_message = @lastErrorMessage,
      updated_at = @updatedAt, completed_at = @completedAt
    where id = @id and novel_id = @novelId and state = @fromState
  `);
  const attachExportJob = database.prepare(`
    update epub_exports set job_id = ?, updated_at = ?
    where id = ? and novel_id = ? and job_id is null
  `);
  const snapshots = database.prepare(`
    select epub_export_chapters.*, translation_revisions.translated_text
    from epub_export_chapters
    join translation_revisions on translation_revisions.id = epub_export_chapters.translation_revision_id
    where epub_export_chapters.export_id = ?
    order by epub_export_chapters.ordinal
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

  function selectedRows(novelId, normalized) {
    const numbers = normalized.chapterNumbers ?? Array.from(
      { length: normalized.endChapterNumber - normalized.startChapterNumber + 1 },
      (_, index) => normalized.startChapterNumber + index
    );
    const rows = database.prepare(`
      select chapters.id as chapter_id, chapters.chapter_number, chapters.title,
        (select source_url from chapter_sources where chapter_id = chapters.id order by created_at, id limit 1) as source_url,
        (select id from translation_revisions where chapter_id = chapters.id order by revision desc, id desc limit 1) as translation_revision_id
      from chapters
      where chapters.novel_id = ? and chapters.chapter_number in (${numbers.map(() => '?').join(', ')})
      order by chapters.chapter_number
    `).all(novelId, ...numbers);
    if (rows.length !== numbers.length || rows.some((row, index) => row.chapter_number !== numbers[index])) {
      throw new ConflictError('chapter selection has missing chapter numbers');
    }
    if (rows.some((row) => row.source_url === null || row.translation_revision_id === null)) {
      throw new ConflictError('chapter selection requires sourced chapters with translations');
    }
    return rows;
  }

  function captureSnapshot(input, transaction = withinTransaction) {
      const { novelId, selection, jobId = null } = requireObject(input);
      const id = requireNovel(novelId);
      const normalized = canonicalizeChapterTarget(selection);
      const normalizedJobId = jobId === null || jobId === undefined ? null : requireId(jobId, 'jobId');
      if (normalizedJobId && !buildJobInNovel.get(normalizedJobId, id)) throw new ConflictError('EPUB job does not belong to novel');
      return transaction(() => {
        const rows = selectedRows(id, normalized);
        const now = clock().toISOString();
        const exportId = randomUUID();
        const snapshot = {
          id: exportId,
          novelId: id,
          jobId: normalizedJobId,
          state: 'queued',
          selectionJson: normalized.targetJson,
          snapshotAt: now,
          fileName: generatedFileName(exportId),
          createdAt: now,
          updatedAt: now
        };
        insertExport.run(snapshot);
        rows.forEach((row, index) => insertExportChapter.run({
          exportId,
          chapterId: row.chapter_id,
          translationRevisionId: row.translation_revision_id,
          chapterNumber: row.chapter_number,
          title: row.title,
          sourceUrl: row.source_url,
          ordinal: index + 1
        }));
        return {
          export: toExport(exportInNovel.get(exportId, id)),
          chapters: snapshots.all(exportId).map(toExportChapter)
        };
      });
  }

  return {
    captureSnapshot(input) {
      return captureSnapshot(input);
    },

    captureSnapshotInTransaction(input) {
      return captureSnapshot(input, (action) => action());
    },

    attachBuildJobInTransaction(input) {
      const { novelId, exportId, jobId } = requireObject(input);
      const id = requireNovel(novelId);
      const normalizedExportId = requireId(exportId, 'exportId');
      const normalizedJobId = requireId(jobId, 'jobId');
      const existing = exportInNovel.get(normalizedExportId, id);
      if (!existing) throw new NotFoundError('EPUB export not found');
      if (!buildJobForExport.get(normalizedJobId, id, normalizedExportId)) throw new ConflictError('EPUB job does not match export');
      if (existing.job_id !== null && existing.job_id !== normalizedJobId) throw new ConflictError('EPUB export is already linked to a different job');
      if (existing.job_id === null && attachExportJob.run(normalizedJobId, clock().toISOString(), normalizedExportId, id).changes === 0) {
        throw new ConflictError('EPUB export job link is stale');
      }
      return toExport(exportInNovel.get(normalizedExportId, id));
    },

    getExportSnapshot(input) {
      const { novelId, exportId } = requireObject(input);
      const row = exportInNovel.get(requireId(exportId, 'exportId'), requireNovel(novelId));
      if (!row) throw new NotFoundError('EPUB export not found');
      return { export: toExport(row), chapters: snapshots.all(row.id).map(toExportChapter) };
    },

    listExports(novelId) {
      const id = requireNovel(novelId);
      return database.prepare('select * from epub_exports where novel_id = ? order by created_at desc, id desc').all(id).map(toExport);
    },

    transitionExport(input) {
      const { novelId, exportId, toState, byteSize = null, sha256 = null, fileName = null, errorCode = null, errorMessage = null, jobClaim = null } = requireObject(input);
      const id = requireNovel(novelId);
      if (!exportStates.has(toState)) throw new ValidationError('EPUB export state is invalid');
      return withinTransaction(() => {
        const existing = exportInNovel.get(requireId(exportId, 'exportId'), id);
        if (!existing) throw new NotFoundError('EPUB export not found');
        if (jobClaim !== null) {
          const claim = requireObject(jobClaim, 'jobClaim');
          if (!activeBuildClaim.get(requireId(claim.jobId, 'jobClaim.jobId'), id, requireId(claim.claimToken, 'jobClaim.claimToken'), existing.id)) {
            throw new ConflictError('EPUB job claim is no longer active');
          }
        }
        if (!exportTransitions[existing.state].has(toState)) throw new ConflictError('EPUB export state transition is not allowed');
        if (fileName !== null && fileName !== generatedFileName(existing.id)) throw new ValidationError('fileName must be the generated export name');
        if (toState === 'available' && (byteSize === null || sha256 === null)) throw new ValidationError('available EPUB export requires byteSize and sha256');
        if (toState !== 'available' && (byteSize !== null || sha256 !== null)) throw new ValidationError('only available EPUB exports record file metadata');
        const now = clock().toISOString();
        const updated = {
          id: existing.id,
          novelId: id,
          fromState: existing.state,
          state: toState,
          byteSize: byteSize === null ? null : requireByteSize(byteSize),
          sha256: sha256 === null ? null : requireSha256(sha256),
          lastErrorCode: requireSafeText(errorCode, 'errorCode'),
          lastErrorMessage: requireSafeText(errorMessage, 'errorMessage'),
          updatedAt: now,
          completedAt: toState === 'available' || toState === 'failed' ? now : null
        };
        if (updateExport.run(updated).changes === 0) throw new ConflictError('EPUB export state transition is stale');
        return toExport(exportInNovel.get(existing.id, id));
      });
    }
  };
}
