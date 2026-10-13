import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

const feedbackTransitions = {
  pending: new Set(['approved', 'rejected', 'needs_review']),
  needs_review: new Set(['approved', 'rejected']),
  approved: new Set(),
  rejected: new Set()
};

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('input must be an object');
  }
  return value;
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

function requireStatus(value) {
  if (!Object.hasOwn(feedbackTransitions, value)) {
    throw new ValidationError('status is invalid');
  }
  return value;
}

function toFeedbackReport(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    translationRevisionId: row.translation_revision_id,
    selectedText: row.selected_text,
    sourceContext: row.source_context,
    translatedContext: row.translated_context,
    proposedCorrection: row.proposed_correction,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createFeedbackRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const chapterInNovel = database.prepare('select 1 from chapters where id = ? and novel_id = ?');
  const revisionInChapter = database.prepare('select 1 from translation_revisions where id = ? and chapter_id = ?');
  const insertReport = database.prepare(`
    insert into feedback_reports (
      id, novel_id, chapter_id, translation_revision_id, selected_text, source_context, translated_context,
      proposed_correction, reason, status, created_at, updated_at
    ) values (
      @id, @novelId, @chapterId, @translationRevisionId, @selectedText, @sourceContext, @translatedContext,
      @proposedCorrection, @reason, @status, @createdAt, @updatedAt
    )
  `);
  const reportsForChapter = database.prepare(`
    select id, novel_id, chapter_id, translation_revision_id, selected_text, source_context, translated_context,
      proposed_correction, reason, status, created_at, updated_at
    from feedback_reports where novel_id = ? and chapter_id = ? order by created_at, id
  `);
  const reportInNovel = database.prepare(`
    select id, novel_id, chapter_id, translation_revision_id, selected_text, source_context, translated_context,
      proposed_correction, reason, status, created_at, updated_at
    from feedback_reports where id = ? and novel_id = ?
  `);
  const updateStatus = database.prepare('update feedback_reports set status = ?, updated_at = ? where id = ?');

  function requireNovel(novelId) {
    const id = requireId(novelId, 'novelId');
    if (!novelExists.get(id)) {
      throw new NotFoundError('novel not found');
    }
    return id;
  }

  function requireChapter(novelId, chapterId) {
    const id = requireId(chapterId, 'chapterId');
    if (!chapterInNovel.get(id, novelId)) {
      throw new NotFoundError('chapter not found');
    }
    return id;
  }

  function requireRevision(chapterId, translationRevisionId) {
    const id = requireId(translationRevisionId, 'translationRevisionId');
    if (!revisionInChapter.get(id, chapterId)) {
      throw new NotFoundError('translation revision not found');
    }
    return id;
  }

  return {
    submitFeedbackReport(input) {
      const {
        novelId, chapterId, translationRevisionId, selectedText, sourceContext, translatedContext, proposedCorrection, reason
      } = requireObject(input);
      const now = clock().toISOString();
      const report = {
        id: randomUUID(),
        novelId: requireNovel(novelId),
        chapterId: null,
        translationRevisionId: null,
        selectedText: requireText(selectedText, 'selectedText').trim(),
        sourceContext: requireText(sourceContext, 'sourceContext').trim(),
        translatedContext: requireText(translatedContext, 'translatedContext').trim(),
        proposedCorrection: requireText(proposedCorrection, 'proposedCorrection').trim(),
        reason: requireText(reason, 'reason').trim(),
        status: 'pending',
        createdAt: now,
        updatedAt: now
      };
      report.chapterId = requireChapter(report.novelId, chapterId);
      report.translationRevisionId = requireRevision(report.chapterId, translationRevisionId);
      insertReport.run(report);
      return report;
    },

    listFeedbackReports(input) {
      const { novelId, chapterId } = requireObject(input);
      const id = requireNovel(novelId);
      return reportsForChapter.all(id, requireChapter(id, chapterId)).map(toFeedbackReport);
    },

    updateFeedbackStatus(input) {
      const { novelId, reportId, status } = requireObject(input);
      const id = requireNovel(novelId);
      const report = reportInNovel.get(requireId(reportId, 'reportId'), id);
      if (!report) {
        throw new NotFoundError('feedback report not found');
      }
      const nextStatus = requireStatus(status);
      if (!feedbackTransitions[report.status].has(nextStatus)) {
        throw new ConflictError('feedback status transition is not allowed');
      }
      const updatedAt = clock().toISOString();
      updateStatus.run(nextStatus, updatedAt, report.id);
      return toFeedbackReport({ ...report, status: nextStatus, updated_at: updatedAt });
    }
  };
}
