import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

function requireObject(value, name = 'input') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function requireSha256(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidationError(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function requireJson(value, name) {
  if (typeof value !== 'string') throw new ValidationError(`${name} must be JSON text`);
  try {
    JSON.parse(value);
  } catch {
    throw new ValidationError(`${name} must be valid JSON`);
  }
  return value;
}

function toAttempt(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    canonicalNovelPingUrl: row.canonical_novelping_url,
    evidenceJson: row.evidence_json,
    evidenceHash: row.evidence_hash,
    resolverVersion: row.resolver_version,
    state: row.state,
    errorCode: row.error_code,
    selectedCandidateId: row.selected_candidate_id,
    createdAt: row.created_at
  };
}

function toCandidate(row) {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    novelId: row.novel_id,
    adapter: row.adapter,
    site: row.site,
    canonicalSourceIdentity: row.canonical_source_identity,
    contentSha256: row.content_sha256,
    normalizedMetadataJson: row.normalized_metadata_json,
    declaredAliasesJson: row.declared_aliases_json,
    catalogEntryOrdinal: row.catalog_entry_ordinal,
    catalogEntryExternalId: row.catalog_entry_external_id,
    componentScoresJson: row.component_scores_json,
    totalScore: row.total_score,
    rank: row.rank,
    decisionReason: row.decision_reason,
    catalogId: row.catalog_id,
    createdAt: row.created_at
  };
}

function toResolution(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    canonicalNovelPingUrl: row.canonical_novelping_url,
    attemptId: row.attempt_id,
    candidateId: row.candidate_id,
    novelSourceId: row.novel_source_id,
    catalogId: row.catalog_id,
    catalogEntryId: row.catalog_entry_id,
    resolverVersion: row.resolver_version,
    acceptedEvidenceHash: row.accepted_evidence_hash,
    createdAt: row.created_at
  };
}

function normalizeCandidate(input, { attemptId, novelId, now }) {
  const value = requireObject(input, 'candidate');
  const totalScore = value.totalScore;
  const rank = value.rank;
  if (!Number.isSafeInteger(totalScore) || totalScore < 0 || totalScore > 100) throw new ValidationError('candidate totalScore must be between 0 and 100');
  if (!Number.isSafeInteger(rank) || rank <= 0) throw new ValidationError('candidate rank must be a positive integer');
  if (!Number.isSafeInteger(value.catalogEntryOrdinal) || value.catalogEntryOrdinal <= 0) {
    throw new ValidationError('candidate catalogEntryOrdinal must be a positive integer');
  }
  return {
    id: value.id ? requireText(value.id, 'candidate id') : randomUUID(),
    attemptId,
    novelId,
    adapter: requireText(value.adapter, 'candidate adapter'),
    site: requireText(value.site, 'candidate site'),
    canonicalSourceIdentity: requireText(value.canonicalSourceIdentity, 'candidate canonicalSourceIdentity'),
    contentSha256: requireSha256(value.contentSha256, 'candidate contentSha256'),
    normalizedMetadataJson: requireJson(value.normalizedMetadataJson, 'candidate normalizedMetadataJson'),
    declaredAliasesJson: requireJson(value.declaredAliasesJson, 'candidate declaredAliasesJson'),
    catalogEntryOrdinal: value.catalogEntryOrdinal,
    catalogEntryExternalId: requireText(value.catalogEntryExternalId, 'candidate catalogEntryExternalId'),
    componentScoresJson: requireJson(value.componentScoresJson, 'candidate componentScoresJson'),
    totalScore,
    rank,
    decisionReason: requireText(value.decisionReason, 'candidate decisionReason'),
    catalogId: value.catalogId === undefined || value.catalogId === null ? null : requireText(value.catalogId, 'candidate catalogId'),
    createdAt: now
  };
}

export function createSourceResolutionRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const attemptByReplay = database.prepare(`select * from source_resolution_attempts
    where novel_id = ? and canonical_novelping_url = ? and evidence_hash = ? and resolver_version = ?
      and state in ('resolved', 'unresolved')`);
  const attemptInNovel = database.prepare('select * from source_resolution_attempts where id = ? and novel_id = ?');
  const candidatesByAttempt = database.prepare('select * from source_resolution_candidates where attempt_id = ? and novel_id = ? order by rank, id');
  const candidateInAttempt = database.prepare('select * from source_resolution_candidates where id = ? and attempt_id = ? and novel_id = ?');
  const resolutionByAttempt = database.prepare('select * from novel_source_resolutions where attempt_id = ? and novel_id = ?');
  const resolutionByNovel = database.prepare('select * from novel_source_resolutions where novel_id = ? order by created_at desc, id desc');
  const insertAttempt = database.prepare(`insert into source_resolution_attempts (
    id, novel_id, canonical_novelping_url, evidence_json, evidence_hash, resolver_version, state, error_code, selected_candidate_id, created_at
  ) values (
    @id, @novelId, @canonicalNovelPingUrl, @evidenceJson, @evidenceHash, @resolverVersion, @state, @errorCode, @selectedCandidateId, @createdAt
  )`);
  const insertCandidate = database.prepare(`insert into source_resolution_candidates (
    id, attempt_id, novel_id, adapter, site, canonical_source_identity, content_sha256, normalized_metadata_json,
    declared_aliases_json, catalog_entry_ordinal, catalog_entry_external_id, component_scores_json, total_score,
    rank, decision_reason, catalog_id, created_at
  ) values (
    @id, @attemptId, @novelId, @adapter, @site, @canonicalSourceIdentity, @contentSha256, @normalizedMetadataJson,
    @declaredAliasesJson, @catalogEntryOrdinal, @catalogEntryExternalId, @componentScoresJson, @totalScore,
    @rank, @decisionReason, @catalogId, @createdAt
  )`);
  const insertResolution = database.prepare(`insert into novel_source_resolutions (
    id, novel_id, canonical_novelping_url, attempt_id, candidate_id, novel_source_id, catalog_id, catalog_entry_id,
    resolver_version, accepted_evidence_hash, created_at
  ) values (
    @id, @novelId, @canonicalNovelPingUrl, @attemptId, @candidateId, @novelSourceId, @catalogId, @catalogEntryId,
    @resolverVersion, @acceptedEvidenceHash, @createdAt
  )`);

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

  function getAttempt(novelId, attemptId) {
    const attempt = attemptInNovel.get(requireText(attemptId, 'attemptId'), requireText(novelId, 'novelId'));
    if (!attempt) throw new NotFoundError('source resolution attempt not found');
    return {
      attempt: toAttempt(attempt),
      candidates: candidatesByAttempt.all(attempt.id, attempt.novel_id).map(toCandidate),
      resolution: resolutionByAttempt.get(attempt.id, attempt.novel_id) ? toResolution(resolutionByAttempt.get(attempt.id, attempt.novel_id)) : null
    };
  }

  function createOrGetTerminalAttemptInTransaction(input) {
    const value = requireObject(input);
    const novelId = requireText(value.novelId, 'novelId');
    const canonicalNovelPingUrl = requireText(value.canonicalNovelPingUrl, 'canonicalNovelPingUrl');
    const evidenceJson = requireJson(value.evidenceJson, 'evidenceJson');
    const evidenceHash = requireSha256(value.evidenceHash, 'evidenceHash');
    const resolverVersion = requireText(value.resolverVersion, 'resolverVersion');
    const state = requireText(value.state, 'state');
    if (!['resolved', 'unresolved', 'failed'].includes(state)) throw new ValidationError('state must be resolved, unresolved, or failed');
    if (!novelExists.get(novelId)) throw new NotFoundError('novel not found');

    const replay = attemptByReplay.get(novelId, canonicalNovelPingUrl, evidenceHash, resolverVersion);
    if (replay) return { ...getAttempt(novelId, replay.id), replayed: true };

    const errorCode = state === 'resolved' ? null : requireText(value.errorCode, 'errorCode');
    const now = clock().toISOString();
    const attemptId = value.id ? requireText(value.id, 'attempt id') : randomUUID();
    const candidates = Array.isArray(value.candidates) ? value.candidates.map((candidate) => normalizeCandidate(candidate, { attemptId, novelId, now })) : [];
    const ranks = new Set();
    const identities = new Set();
    for (const candidate of candidates) {
      if (ranks.has(candidate.rank) || identities.has(candidate.canonicalSourceIdentity)) {
        throw new ValidationError('candidates must have unique ranks and source identities');
      }
      ranks.add(candidate.rank);
      identities.add(candidate.canonicalSourceIdentity);
    }
    const selectedCandidateId = state === 'resolved' ? requireText(value.selectedCandidateId, 'selectedCandidateId') : null;
    if (state === 'resolved') {
      const selected = candidates.find((candidate) => candidate.id === selectedCandidateId);
      if (!selected || !selected.catalogId) throw new ValidationError('resolved attempt requires its selected catalog candidate');
    } else if (value.selectedCandidateId !== undefined && value.selectedCandidateId !== null) {
      throw new ValidationError('nonresolved attempt cannot select a candidate');
    }

    insertAttempt.run({ id: attemptId, novelId, canonicalNovelPingUrl, evidenceJson, evidenceHash, resolverVersion, state, errorCode, selectedCandidateId, createdAt: now });
    for (const candidate of candidates) insertCandidate.run(candidate);
    return { ...getAttempt(novelId, attemptId), replayed: false };
  }

  return {
    findTerminalAttemptByReplay(input) {
      const value = requireObject(input);
      const novelId = requireText(value.novelId, 'novelId');
      const canonicalNovelPingUrl = requireText(value.canonicalNovelPingUrl, 'canonicalNovelPingUrl');
      const evidenceHash = requireSha256(value.evidenceHash, 'evidenceHash');
      const resolverVersion = requireText(value.resolverVersion, 'resolverVersion');
      const replay = attemptByReplay.get(novelId, canonicalNovelPingUrl, evidenceHash, resolverVersion);
      return replay ? { ...getAttempt(novelId, replay.id), replayed: true } : null;
    },

    createOrGetTerminalAttempt(input) {
      if (requireObject(input).state === 'resolved') {
        throw new ValidationError('resolved attempts require an atomic resolution transaction');
      }
      return withinTransaction(() => createOrGetTerminalAttemptInTransaction(input));
    },

    createOrGetTerminalAttemptInTransaction,

    createAcceptedResolutionInTransaction(input) {
      const value = requireObject(input);
      const novelId = requireText(value.novelId, 'novelId');
      const attemptId = requireText(value.attemptId, 'attemptId');
      const candidateId = requireText(value.candidateId, 'candidateId');
      const attempt = attemptInNovel.get(attemptId, novelId);
      if (!attempt) throw new NotFoundError('source resolution attempt not found');
      if (attempt.state !== 'resolved' || attempt.selected_candidate_id !== candidateId) throw new ConflictError('attempt is not an accepted source resolution');
      const existing = resolutionByAttempt.get(attemptId, novelId);
      if (existing) {
        if (existing.candidate_id !== candidateId
          || existing.novel_source_id !== value.novelSourceId
          || existing.catalog_id !== value.catalogId
          || existing.catalog_entry_id !== value.catalogEntryId) {
          throw new ConflictError('accepted source resolution conflicts with existing references');
        }
        return toResolution(existing);
      }
      const now = clock().toISOString();
      const resolution = {
        id: value.id ? requireText(value.id, 'resolution id') : randomUUID(),
        novelId,
        canonicalNovelPingUrl: attempt.canonical_novelping_url,
        attemptId,
        candidateId,
        novelSourceId: requireText(value.novelSourceId, 'novelSourceId'),
        catalogId: requireText(value.catalogId, 'catalogId'),
        catalogEntryId: requireText(value.catalogEntryId, 'catalogEntryId'),
        resolverVersion: attempt.resolver_version,
        acceptedEvidenceHash: attempt.evidence_hash,
        createdAt: now
      };
      try {
        insertResolution.run(resolution);
      } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ERR_SQLITE_ERROR') throw new ConflictError('accepted source resolution conflicts with existing novel source');
        throw error;
      }
      return resolution;
    },

    getAttempt,

    listAttempts(novelId) {
      const id = requireText(novelId, 'novelId');
      if (!novelExists.get(id)) throw new NotFoundError('novel not found');
      return database.prepare('select * from source_resolution_attempts where novel_id = ? order by created_at desc, id desc').all(id).map(toAttempt);
    },

    listResolutions(novelId) {
      const id = requireText(novelId, 'novelId');
      if (!novelExists.get(id)) throw new NotFoundError('novel not found');
      return resolutionByNovel.all(id).map(toResolution);
    },

    getAcceptedResolution(novelId, attemptId) {
      const attempt = getAttempt(novelId, attemptId);
      if (!attempt.resolution) throw new NotFoundError('accepted source resolution not found');
      return attempt.resolution;
    },

    getCandidate(novelId, attemptId, candidateId) {
      const row = candidateInAttempt.get(requireText(candidateId, 'candidateId'), requireText(attemptId, 'attemptId'), requireText(novelId, 'novelId'));
      if (!row) throw new NotFoundError('source resolution candidate not found');
      return toCandidate(row);
    },

    withinTransaction
  };
}
