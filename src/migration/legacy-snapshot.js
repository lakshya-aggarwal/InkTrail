import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LEGACY_FILES = Object.freeze({
  sourceMap: 'source-map.json',
  translationState: 'translation-state.json',
  translationCache: 'translation-cache.json',
  consistencyMemory: 'consistency-memory.json'
});

export class LegacySnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacySnapshotError';
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LegacySnapshotError(`${label} must be a JSON object.`);
  }
  return value;
}

function list(value, label) {
  if (!Array.isArray(value)) {
    throw new LegacySnapshotError(`${label} must be an array.`);
  }
  return value;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function canonicalUrl(value, host, expression) {
  try {
    const url = new URL(value);
    const match = url.protocol === 'https:' && url.hostname === host && !url.port
      ? url.pathname.match(expression)
      : null;
    return match ? { canonical: `https://${host}${url.pathname.replace(/\/$/, '')}`, match } : null;
  } catch {
    return null;
  }
}

function sourceChapterUrl(value) {
  return canonicalUrl(value, 'www.kujiang.com', /^\/book\/([1-9]\d*)\/([1-9]\d*)\/?$/);
}

function sourceBookUrl(value) {
  const chapter = sourceChapterUrl(value);
  return chapter ? `https://www.kujiang.com/book/${chapter.match[1]}` : null;
}

function canonicalSourceBookUrl(value) {
  const book = canonicalUrl(value, 'www.kujiang.com', /^\/book\/([1-9]\d*)\/?$/);
  return book ? book.canonical : null;
}

function legacyNovelUrl(value) {
  const chapter = canonicalUrl(value, 'novelping.com', /^\/book\/([a-z0-9][a-z0-9-]*)\/[^/]+\/?$/i);
  return chapter ? `https://novelping.com/book/${chapter.match[1]}` : null;
}

function cacheKeyMatchesSourceUrl(cacheKey, sourceUrl) {
  return cacheKey.includes(`:${sourceUrl}:`);
}

function cachePayloadStatus(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.paragraphs)) {
    return { sourceText: false, translation: false };
  }
  const sourceText = payload.paragraphs.length > 0 && payload.paragraphs.every((paragraph) => text(paragraph?.source));
  const translation = sourceText && payload.paragraphs.every((paragraph) => text(paragraph?.translation));
  return { sourceText, translation };
}

export function canonicalLegacyKujiangChapterUrl(value) {
  return sourceChapterUrl(value)?.canonical ?? null;
}

export function canonicalLegacyKujiangBookUrl(value) {
  return canonicalSourceBookUrl(value);
}

export function legacyKujiangBookUrlForChapter(value) {
  return sourceBookUrl(value);
}

export function legacyCacheKeyMatchesSourceUrl(cacheKey, sourceUrl) {
  return cacheKeyMatchesSourceUrl(cacheKey, sourceUrl);
}

export function legacyCachePayloadStatus(payload) {
  return cachePayloadStatus(payload);
}

function summaryFor(key) {
  return {
    key,
    sourceBookUrls: new Set(),
    sourceMappingUrls: new Set(),
    duplicateSourceMappings: 0,
    orphanSourceLinks: 0,
    translationRows: 0,
    cachedTranslationCandidates: 0,
    completeSourceTextCandidates: 0,
    historicalRevisionCandidates: 0,
    sourceRefetchRequired: 0
  };
}

function issueCount(issues, code) {
  issues.set(code, (issues.get(code) || 0) + 1);
}

function reportNovel(summary) {
  return {
    key: summary.key,
    sourceBookUrls: [...summary.sourceBookUrls].sort(),
    sourceMappings: summary.sourceMappingUrls.size,
    duplicateSourceMappings: summary.duplicateSourceMappings,
    orphanSourceLinks: summary.orphanSourceLinks,
    translationRows: summary.translationRows,
    cachedTranslationCandidates: summary.cachedTranslationCandidates,
    completeSourceTextCandidates: summary.completeSourceTextCandidates,
    historicalRevisionCandidates: summary.historicalRevisionCandidates,
    sourceRefetchRequired: summary.sourceRefetchRequired
  };
}

export function inspectLegacySnapshot({ sourceMap, translationState, translationCache, consistencyMemory }) {
  const mappings = list(object(sourceMap, 'source-map.json').entries, 'source-map.json entries');
  const translations = list(object(translationState, 'translation-state.json').chapters, 'translation-state.json chapters');
  const cache = object(translationCache, 'translation-cache.json');
  const memory = object(consistencyMemory, 'consistency-memory.json');
  const terms = list(memory.terms, 'consistency-memory.json terms');
  const corrections = list(memory.corrections, 'consistency-memory.json corrections');
  const issues = new Map();
  const summaries = new Map();
  const sourceBookOwners = new Map();
  const sourceUrlOwners = new Map();
  const mappingSourceUrls = new Set();

  function findSummary(key) {
    if (!summaries.has(key)) summaries.set(key, summaryFor(key));
    return summaries.get(key);
  }

  for (const mapping of mappings) {
    const sourceUrl = sourceChapterUrl(text(mapping?.sourceUrl));
    const novelKey = legacyNovelUrl(text(mapping?.novelUrl));
    const bookUrl = sourceUrl ? sourceBookUrl(sourceUrl.canonical) : null;
    if (!sourceUrl || !bookUrl || !novelKey) {
      issueCount(issues, 'invalid_source_mapping');
      continue;
    }
    const owner = sourceBookOwners.get(bookUrl);
    if (owner && owner !== novelKey) {
      issueCount(issues, 'ambiguous_source_book');
      sourceBookOwners.set(bookUrl, null);
    } else if (!sourceBookOwners.has(bookUrl)) {
      sourceBookOwners.set(bookUrl, novelKey);
    }
    const summary = findSummary(novelKey);
    summary.sourceBookUrls.add(bookUrl);
    const sourceOwner = sourceUrlOwners.get(sourceUrl.canonical);
    if (sourceOwner && sourceOwner !== novelKey) {
      issueCount(issues, 'ambiguous_source_chapter');
      sourceUrlOwners.set(sourceUrl.canonical, null);
    } else if (!sourceUrlOwners.has(sourceUrl.canonical)) {
      sourceUrlOwners.set(sourceUrl.canonical, novelKey);
    }
    if (mappingSourceUrls.has(sourceUrl.canonical)) {
      summary.duplicateSourceMappings += 1;
      issueCount(issues, 'duplicate_source_mapping');
    } else {
      mappingSourceUrls.add(sourceUrl.canonical);
      summary.sourceMappingUrls.add(sourceUrl.canonical);
    }
  }

  for (const mapping of mappings) {
    const sourceUrl = sourceChapterUrl(text(mapping?.sourceUrl));
    const novelKey = legacyNovelUrl(text(mapping?.novelUrl));
    if (!sourceUrl || !novelKey) continue;
    const summary = findSummary(novelKey);
    for (const link of [text(mapping.previousSourceUrl), text(mapping.nextSourceUrl)]) {
      const canonicalLink = sourceChapterUrl(link);
      if (link && (!canonicalLink || !mappingSourceUrls.has(canonicalLink.canonical))) {
        summary.orphanSourceLinks += 1;
        issueCount(issues, 'orphan_source_link');
      }
    }
  }

  const referencedCacheKeys = new Set();
  for (const translation of translations) {
    const rawSourceUrl = text(translation?.sourceUrl);
    const sourceUrl = sourceChapterUrl(rawSourceUrl);
    const bookUrl = sourceUrl ? sourceBookUrl(sourceUrl.canonical) : null;
    const owner = sourceUrl ? sourceUrlOwners.get(sourceUrl.canonical) : undefined;
    const key = owner || null;
    if (!key) {
      issueCount(issues, 'unassigned_translation_row');
      continue;
    }
    const summary = findSummary(key);
    summary.translationRows += 1;
    if (bookUrl) summary.sourceBookUrls.add(bookUrl);
    const cacheKey = text(translation?.cacheKey);
    const payload = cacheKey ? cache[cacheKey] : null;
    if (!payload) {
      summary.sourceRefetchRequired += 1;
      issueCount(issues, 'missing_translation_cache');
      continue;
    }
    referencedCacheKeys.add(cacheKey);
    summary.cachedTranslationCandidates += 1;
    if (!cacheKeyMatchesSourceUrl(cacheKey, rawSourceUrl)) {
      summary.sourceRefetchRequired += 1;
      issueCount(issues, 'mismatched_translation_cache');
      continue;
    }
    const status = cachePayloadStatus(payload);
    if (status.sourceText) {
      summary.completeSourceTextCandidates += 1;
    } else {
      summary.sourceRefetchRequired += 1;
      issueCount(issues, 'incomplete_cached_source_text');
    }
    if (status.translation) {
      summary.historicalRevisionCandidates += 1;
    } else {
      issueCount(issues, 'incomplete_cached_translation');
    }
  }

  for (const cacheKey of Object.keys(cache)) {
    if (!referencedCacheKeys.has(cacheKey)) issueCount(issues, 'unreferenced_translation_cache');
  }
  if (terms.length || corrections.length) issueCount(issues, 'global_memory_requires_novel_assignment');

  return {
    formatVersion: 1,
    novels: [...summaries.values()].map(reportNovel).sort((left, right) => left.key.localeCompare(right.key)),
    consistencyMemory: {
      terms: terms.length,
      corrections: corrections.length,
      requiresNovelAssignment: terms.length > 0 || corrections.length > 0
    },
    issues: [...issues].map(([code, count]) => ({ code, count })).sort((left, right) => left.code.localeCompare(right.code))
  };
}

export async function readLegacySnapshotData(directory, { read = readFile } = {}) {
  if (!text(directory)) throw new LegacySnapshotError('A legacy snapshot directory is required.');
  const loaded = await Promise.all(Object.entries(LEGACY_FILES).map(async ([name, file]) => {
    try {
      return [name, JSON.parse(await read(join(directory, file), 'utf8'))];
    } catch (error) {
      throw new LegacySnapshotError(`Unable to read ${file}: ${error.message}`);
    }
  }));
  return Object.fromEntries(loaded);
}

export async function readLegacySnapshot(directory, options) {
  return inspectLegacySnapshot(await readLegacySnapshotData(directory, options));
}
