import { randomUUID } from 'node:crypto';
import { NotFoundError, ValidationError } from '../domain/errors.js';

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

function toFinding(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    translationRevisionId: row.translation_revision_id,
    kind: row.kind,
    details: row.details,
    createdAt: row.created_at
  };
}

export function createQualityFindingRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const revisionInNovel = database.prepare(`
    select 1
    from translation_revisions
    join chapters on chapters.id = translation_revisions.chapter_id
    where translation_revisions.id = ? and chapters.novel_id = ?
  `);
  const insertFinding = database.prepare(`
    insert into translation_quality_findings (id, novel_id, translation_revision_id, kind, details, created_at)
    values (@id, @novelId, @translationRevisionId, @kind, @details, @createdAt)
  `);
  const findingsForRevision = database.prepare(`
    select id, novel_id, translation_revision_id, kind, details, created_at
    from translation_quality_findings
    where novel_id = ? and translation_revision_id = ?
    order by created_at, id
  `);

  function requireRevision(novelId, translationRevisionId) {
    const id = requireId(translationRevisionId, 'translationRevisionId');
    if (!revisionInNovel.get(id, novelId)) {
      throw new NotFoundError('translation revision not found');
    }
    return id;
  }

  function requireNovel(novelId) {
    const id = requireId(novelId, 'novelId');
    if (!novelExists.get(id)) {
      throw new NotFoundError('novel not found');
    }
    return id;
  }

  return {
    recordQualityFinding(input) {
      const { novelId, translationRevisionId, kind, details } = requireObject(input);
      const finding = {
        id: randomUUID(),
        novelId: requireNovel(novelId),
        translationRevisionId: null,
        kind: requireText(kind, 'kind').trim(),
        details: requireText(details, 'details').trim(),
        createdAt: clock().toISOString()
      };
      finding.translationRevisionId = requireRevision(finding.novelId, translationRevisionId);
      insertFinding.run(finding);
      return finding;
    },

    listQualityFindings(input) {
      const { novelId, translationRevisionId } = requireObject(input);
      const id = requireNovel(novelId);
      return findingsForRevision.all(id, requireRevision(id, translationRevisionId)).map(toFinding);
    }
  };
}
