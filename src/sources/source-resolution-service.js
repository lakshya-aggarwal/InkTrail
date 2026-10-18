import { ConflictError, SourceFetchError, ValidationError } from '../domain/errors.js';
import { catalogContentSha256 } from './source-catalog-service.js';
import { RESOLVER_VERSION, scoreResolutionCandidates } from './source-resolution-scoring.js';

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('input must be an object');
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function safeCandidate(candidate, scored) {
  return {
    id: scored.candidateId,
    adapter: 'kujiang-catalog-v1',
    site: candidate.site,
    canonicalSourceIdentity: candidate.canonicalBookUrl,
    contentSha256: catalogContentSha256(candidate.catalog.entries),
    normalizedMetadataJson: JSON.stringify({
      novelTitle: candidate.novelTitle,
      author: candidate.author,
      chapterTitle: candidate.chapterTitle
    }),
    declaredAliasesJson: JSON.stringify({
      novelTitleAliases: candidate.novelTitleAliases,
      authorAliases: candidate.authorAliases,
      chapterTitleAliases: candidate.chapterTitleAliases
    }),
    catalogEntryOrdinal: candidate.entry.ordinal,
    catalogEntryExternalId: candidate.entry.externalChapterId,
    componentScoresJson: JSON.stringify(scored.components),
    totalScore: scored.totalScore,
    rank: scored.rank,
    decisionReason: scored.eligible ? 'accepted' : scored.rejectionCode ?? 'unverified',
    catalogId: null
  };
}

function safeEvidenceJson(evidence) {
  return JSON.stringify({
    canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
    novelTitle: evidence.novelTitle,
    author: evidence.author,
    chapterNumber: evidence.chapterNumber,
    chapterTitle: evidence.chapterTitle,
    extractorVersion: evidence.extractorVersion
  });
}

function sourceIdentityConflict(repositories, novelId, candidate) {
  const existingSources = repositories.sources.listNovelSourcesForSite({ novelId, site: candidate.site });
  if (existingSources.some((source) => source.normalizedUrl !== candidate.canonicalBookUrl)) return true;

  const existingSource = repositories.sources.findNovelSourceByCanonicalUrl({
    site: candidate.site,
    normalizedUrl: candidate.canonicalBookUrl
  });
  if (existingSource && existingSource.novelId !== novelId) return true;

  const accepted = repositories.resolutions.listResolutions(novelId);
  return accepted.length > 0 && (!existingSource || accepted.some((resolution) => resolution.novelSourceId !== existingSource.id));
}

export function createSourceResolutionService({ database, repositories, novelPingExtractor, catalogAdapters }) {
  if (!database || typeof database.exec !== 'function') throw new ValidationError('database is required');
  if (!novelPingExtractor || typeof novelPingExtractor.fetchEvidence !== 'function') throw new ValidationError('novelPingExtractor is required');
  if (!Array.isArray(catalogAdapters) || catalogAdapters.some((adapter) => typeof adapter?.discoverCatalogCandidates !== 'function')) {
    throw new ValidationError('catalogAdapters must provide candidate discovery');
  }

  function persistTerminal(input) {
    return repositories.resolutions.createOrGetTerminalAttempt(input);
  }

  const inFlightResolutions = new Map();

  return {
    async resolveNovelPingChapter(input) {
      const value = requireObject(input);
      const novelId = requireText(value.novelId, 'novelId');
      const novelPingUrl = requireText(value.novelPingUrl, 'novelPingUrl');
      repositories.novels.getNovel(novelId);

      const evidence = await novelPingExtractor.fetchEvidence(novelPingUrl);
      if (evidence.extractorVersion !== RESOLVER_VERSION) throw new ValidationError('NovelPing evidence has an unsupported resolver version');
      const replay = repositories.resolutions.findTerminalAttemptByReplay({
        novelId,
        canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
        evidenceHash: evidence.evidenceHash,
        resolverVersion: evidence.extractorVersion
      });
      if (replay) return replay;

      const replayKey = JSON.stringify([novelId, evidence.canonicalNovelPingUrl, evidence.evidenceHash, evidence.extractorVersion]);
      const inFlight = inFlightResolutions.get(replayKey);
      if (inFlight) return inFlight;

      const resolution = Promise.resolve().then(async () => {
        let candidates;
        try {
          candidates = (await Promise.all(catalogAdapters.map((adapter) => adapter.discoverCatalogCandidates(evidence, evidence.chapterNumber)))).flat();
        } catch (error) {
          return persistTerminal({
            novelId,
            canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
            evidenceJson: safeEvidenceJson(evidence),
            evidenceHash: evidence.evidenceHash,
            resolverVersion: evidence.extractorVersion,
            state: 'failed',
            errorCode: error instanceof SourceFetchError ? 'source_fetch_failed' : 'resolution_failed',
            candidates: []
          });
        }

        const scored = scoreResolutionCandidates(evidence, candidates);
        const observations = scored.candidates.map((score) => safeCandidate(candidates.find((candidate) => candidate.id === score.candidateId), score));
        if (scored.decision !== 'accepted') {
          return persistTerminal({
            novelId,
            canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
            evidenceJson: safeEvidenceJson(evidence),
            evidenceHash: evidence.evidenceHash,
            resolverVersion: evidence.extractorVersion,
            state: 'unresolved',
            errorCode: 'resolution_unverified',
            candidates: observations
          });
        }

        const winnerIndex = candidates.findIndex((candidate) => candidate.id === scored.selectedCandidateId);
        const winner = candidates[winnerIndex];
        if (!winner || sourceIdentityConflict(repositories, novelId, winner)) {
          return persistTerminal({
            novelId,
            canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
            evidenceJson: safeEvidenceJson(evidence),
            evidenceHash: evidence.evidenceHash,
            resolverVersion: evidence.extractorVersion,
            state: 'unresolved',
            errorCode: 'source_ownership_conflict',
            candidates: observations
          });
        }

        try {
          return repositories.resolutions.withinTransaction(() => {
            const transactionReplay = repositories.resolutions.findTerminalAttemptByReplay({
              novelId,
              canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
              evidenceHash: evidence.evidenceHash,
              resolverVersion: evidence.extractorVersion
            });
            if (transactionReplay) return transactionReplay;
            if (sourceIdentityConflict(repositories, novelId, winner)) throw new ConflictError('source ownership conflicts with accepted resolution');

            const source = repositories.sources.createOrGetNovelSource({
              novelId,
              site: winner.site,
              externalNovelId: winner.externalNovelId,
              sourceUrl: winner.canonicalBookUrl,
              normalizedUrl: winner.canonicalBookUrl,
              title: winner.novelTitle
            });
            const snapshot = repositories.catalogs.createOrGetSnapshotInTransaction({
              novelId,
              novelSourceId: source.id,
              site: winner.site,
              canonicalBookUrl: winner.canonicalBookUrl,
              contentSha256: catalogContentSha256(winner.catalog.entries),
              entries: winner.catalog.entries
            });
            const catalogEntry = snapshot.entries.find((entry) => entry.ordinal === winner.entry.ordinal && entry.externalChapterId === winner.entry.externalChapterId);
            if (!catalogEntry) throw new ConflictError('accepted catalog no longer contains the matched chapter');
            const acceptedCandidates = observations.map((candidate) => candidate.id === scored.selectedCandidateId ? { ...candidate, catalogId: snapshot.catalog.id } : candidate);
            const attempt = repositories.resolutions.createOrGetTerminalAttemptInTransaction({
              novelId,
              canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
              evidenceJson: safeEvidenceJson(evidence),
              evidenceHash: evidence.evidenceHash,
              resolverVersion: evidence.extractorVersion,
              state: 'resolved',
              selectedCandidateId: scored.selectedCandidateId,
              candidates: acceptedCandidates
            });
            const resolution = repositories.resolutions.createAcceptedResolutionInTransaction({
              novelId,
              attemptId: attempt.attempt.id,
              candidateId: scored.selectedCandidateId,
              novelSourceId: source.id,
              catalogId: snapshot.catalog.id,
              catalogEntryId: catalogEntry.id
            });
            return { ...attempt, resolution };
          });
        } catch (error) {
          if (error instanceof ConflictError) {
            return persistTerminal({
              novelId,
              canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
              evidenceJson: safeEvidenceJson(evidence),
              evidenceHash: evidence.evidenceHash,
              resolverVersion: evidence.extractorVersion,
              state: 'unresolved',
              errorCode: 'source_ownership_conflict',
              candidates: observations
            });
          }
          return persistTerminal({
            novelId,
            canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
            evidenceJson: safeEvidenceJson(evidence),
            evidenceHash: evidence.evidenceHash,
            resolverVersion: evidence.extractorVersion,
            state: 'failed',
            errorCode: 'resolution_failed',
            candidates: []
          });
        }
      });
      inFlightResolutions.set(replayKey, resolution);
      try {
        return await resolution;
      } finally {
        if (inFlightResolutions.get(replayKey) === resolution) inFlightResolutions.delete(replayKey);
      }
    }
  };
}
