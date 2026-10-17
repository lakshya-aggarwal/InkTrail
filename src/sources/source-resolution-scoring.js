import { ValidationError } from '../domain/errors.js';

export const RESOLVER_VERSION = 'novelping-kujiang-v1';
const WEIGHTS = Object.freeze({ chapterNumber: 40, novelTitle: 30, chapterTitle: 25, author: 5 });
const ACCEPTANCE_THRESHOLD = 95;
const UNIQUE_WINNER_MARGIN = 5;

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError(`${name} must be a positive integer`);
  return value;
}

function normalizedAliases(primary, aliases, name) {
  const values = [primary, ...(aliases ?? [])];
  if (!Array.isArray(aliases ?? [])) throw new ValidationError(`${name} aliases must be an array`);
  const normalized = [...new Set(values.map(normalizeResolutionText).filter(Boolean))];
  if (normalized.length === 0) throw new ValidationError(`${name} is required`);
  return normalized;
}

function optionalNormalizedAliases(primary, aliases, name) {
  if (aliases !== undefined && !Array.isArray(aliases)) throw new ValidationError(`${name} aliases must be an array`);
  const values = [primary ?? '', ...(aliases ?? [])].map(normalizeResolutionText).filter(Boolean);
  return [...new Set(values)];
}

function component(evidenceValue, candidateValues, points) {
  const matched = candidateValues.includes(evidenceValue);
  return { evidenceValue, candidateValues, matched, points: matched ? points : 0 };
}

function candidateKey(candidate, index) {
  return typeof candidate.id === 'string' && candidate.id ? candidate.id : String(index);
}

export function normalizeResolutionText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function scoreResolutionCandidate(evidence, candidate, index = 0) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) throw new ValidationError('evidence must be an object');
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) throw new ValidationError('candidate must be an object');
  const chapterNumber = requirePositiveInteger(evidence.chapterNumber, 'evidence chapterNumber');
  const candidateChapterNumber = requirePositiveInteger(candidate.chapterNumber, 'candidate chapterNumber');
  const novelTitle = normalizeResolutionText(evidence.novelTitle);
  const chapterTitle = normalizeResolutionText(evidence.chapterTitle);
  if (!novelTitle || !chapterTitle) throw new ValidationError('evidence title fields are required');

  const components = {
    chapterNumber: {
      evidenceValue: chapterNumber,
      candidateValue: candidateChapterNumber,
      matched: chapterNumber === candidateChapterNumber,
      points: chapterNumber === candidateChapterNumber ? WEIGHTS.chapterNumber : 0
    },
    novelTitle: component(novelTitle, normalizedAliases(candidate.novelTitle, candidate.novelTitleAliases, 'candidate novelTitle'), WEIGHTS.novelTitle),
    chapterTitle: component(chapterTitle, normalizedAliases(candidate.chapterTitle, candidate.chapterTitleAliases, 'candidate chapterTitle'), WEIGHTS.chapterTitle)
  };
  const evidenceAuthor = evidence.author === null || evidence.author === undefined ? null : normalizeResolutionText(evidence.author);
  const candidateAuthors = optionalNormalizedAliases(candidate.author, candidate.authorAliases, 'candidate author');
  const authorComparable = Boolean(evidenceAuthor && candidateAuthors.length);
  const authorMatched = authorComparable && candidateAuthors.includes(evidenceAuthor);
  components.author = {
    evidenceValue: evidenceAuthor,
    candidateValues: candidateAuthors,
    comparable: authorComparable,
    matched: authorMatched,
    points: authorMatched ? WEIGHTS.author : 0
  };

  let rejectionCode = null;
  if (!components.chapterNumber.matched) rejectionCode = 'chapter_number_mismatch';
  else if (!components.novelTitle.matched) rejectionCode = 'novel_title_mismatch';
  else if (!components.chapterTitle.matched) rejectionCode = 'chapter_title_mismatch';
  else if (authorComparable && !authorMatched) rejectionCode = 'author_conflict';

  const totalScore = Object.values(components).reduce((total, entry) => total + entry.points, 0);
  const mandatoryMatched = components.chapterNumber.matched && components.novelTitle.matched && components.chapterTitle.matched;
  if (mandatoryMatched && !rejectionCode && totalScore < ACCEPTANCE_THRESHOLD) {
    throw new Error('fixed resolver scoring produced a score below the acceptance threshold');
  }
  return {
    candidateId: candidateKey(candidate, index),
    components,
    totalScore,
    eligible: rejectionCode === null && totalScore >= ACCEPTANCE_THRESHOLD,
    rejectionCode
  };
}

export function scoreResolutionCandidates(evidence, candidates) {
  if (!Array.isArray(candidates)) throw new ValidationError('candidates must be an array');
  const ranked = candidates
    .map((candidate, index) => scoreResolutionCandidate(evidence, candidate, index))
    .sort((left, right) => right.totalScore - left.totalScore || left.candidateId.localeCompare(right.candidateId))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const eligible = ranked.filter((candidate) => candidate.eligible);
  if (eligible.length === 0) return { resolverVersion: RESOLVER_VERSION, candidates: ranked, decision: 'unresolved', rejectionCode: 'no_eligible_candidate', selectedCandidateId: null };

  const [winner, runnerUp] = eligible;
  if (runnerUp) {
    const margin = winner.totalScore - runnerUp.totalScore;
    if (margin > 0 && margin < UNIQUE_WINNER_MARGIN) {
      throw new Error('fixed resolver scoring produced an impossible winner margin');
    }
    if (margin < UNIQUE_WINNER_MARGIN) {
      return { resolverVersion: RESOLVER_VERSION, candidates: ranked, decision: 'unresolved', rejectionCode: 'no_unique_winner', selectedCandidateId: null };
    }
  }
  return { resolverVersion: RESOLVER_VERSION, candidates: ranked, decision: 'accepted', rejectionCode: null, selectedCandidateId: winner.candidateId };
}
