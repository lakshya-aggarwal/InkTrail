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

function requireConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError('confidence must be between 0 and 1');
  }
  return value;
}

function toMemoryEntry(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    sourceTerm: row.source_term,
    preferredRendering: row.preferred_rendering,
    semanticScope: row.semantic_scope,
    evidence: row.evidence,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createMemoryRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const upsertMemoryEntry = database.prepare(`
    insert into memory_entries (
      id, novel_id, source_term, preferred_rendering, semantic_scope, evidence, confidence, created_at, updated_at
    ) values (
      @id, @novelId, @sourceTerm, @preferredRendering, @semanticScope, @evidence, @confidence, @createdAt, @updatedAt
    ) on conflict(novel_id, source_term, semantic_scope) do update set
      preferred_rendering = excluded.preferred_rendering,
      evidence = excluded.evidence,
      confidence = excluded.confidence,
      updated_at = excluded.updated_at
  `);
  const memoryEntry = database.prepare(`
    select id, novel_id, source_term, preferred_rendering, semantic_scope, evidence, confidence, created_at, updated_at
    from memory_entries where novel_id = ? and source_term = ? and semantic_scope = ?
  `);
  const entriesForNovel = database.prepare(`
    select id, novel_id, source_term, preferred_rendering, semantic_scope, evidence, confidence, created_at, updated_at
    from memory_entries where novel_id = ? order by source_term, semantic_scope
  `);

  function requireNovel(novelId) {
    const id = requireId(novelId, 'novelId');
    if (!novelExists.get(id)) {
      throw new NotFoundError('novel not found');
    }
    return id;
  }

  return {
    saveVerifiedMemoryEntry(input) {
      const { novelId, sourceTerm, preferredRendering, semanticScope, evidence, confidence } = requireObject(input);
      const now = clock().toISOString();
      const entry = {
        id: randomUUID(),
        novelId: requireNovel(novelId),
        sourceTerm: requireText(sourceTerm, 'sourceTerm').trim(),
        preferredRendering: requireText(preferredRendering, 'preferredRendering').trim(),
        semanticScope: requireText(semanticScope, 'semanticScope').trim(),
        evidence: requireText(evidence, 'evidence').trim(),
        confidence: requireConfidence(confidence),
        createdAt: now,
        updatedAt: now
      };
      upsertMemoryEntry.run(entry);
      return toMemoryEntry(memoryEntry.get(entry.novelId, entry.sourceTerm, entry.semanticScope));
    },

    listVerifiedMemoryEntries(novelId) {
      return entriesForNovel.all(requireNovel(novelId)).map(toMemoryEntry);
    }
  };
}
