import {
  LegacySnapshotError,
  canonicalLegacyKujiangBookUrl,
  canonicalLegacyKujiangChapterUrl,
  legacyCacheKeyMatchesSourceUrl,
  legacyCachePayloadStatus,
  legacyKujiangBookUrlForChapter
} from './legacy-snapshot.js';

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LegacySnapshotError(`${label} must be a JSON object.`);
  }
  return value;
}

function list(value, label) {
  if (!Array.isArray(value)) throw new LegacySnapshotError(`${label} must be an array.`);
  return value;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function issueCount(issues, code) {
  issues.set(code, (issues.get(code) || 0) + 1);
}

function reportIssues(issues) {
  return [...issues].map(([code, count]) => ({ code, count })).sort((left, right) => left.code.localeCompare(right.code));
}

export function createLegacyCatalogReconciliationManifest({ translationState, translationCache, catalog }) {
  const translations = list(object(translationState, 'translation-state.json').chapters, 'translation-state.json chapters');
  const cache = object(translationCache, 'translation-cache.json');
  const sourceCatalog = object(catalog, 'catalog');
  const bookUrl = canonicalLegacyKujiangBookUrl(text(sourceCatalog.canonicalBookUrl));
  if (!bookUrl) throw new LegacySnapshotError('catalog canonicalBookUrl must be a canonical Kujiang book URL.');
  const entries = list(sourceCatalog.entries, 'catalog entries');
  if (entries.length === 0) throw new LegacySnapshotError('catalog entries must not be empty.');

  const issues = new Map();
  const catalogBySourceUrl = new Map();
  const catalogOrdinals = new Set();
  for (const entry of entries) {
    const sourceUrl = canonicalLegacyKujiangChapterUrl(text(entry?.sourceUrl));
    const ordinal = entry?.ordinal;
    const sourceTitle = text(entry?.sourceTitle);
    if (!sourceUrl || legacyKujiangBookUrlForChapter(sourceUrl) !== bookUrl || !Number.isSafeInteger(ordinal) || ordinal < 1 || !sourceTitle) {
      issueCount(issues, 'invalid_catalog_entry');
      continue;
    }
    if (catalogBySourceUrl.has(sourceUrl)) {
      issueCount(issues, 'duplicate_catalog_source_url');
      continue;
    }
    if (catalogOrdinals.has(ordinal)) {
      issueCount(issues, 'duplicate_catalog_ordinal');
      continue;
    }
    catalogBySourceUrl.set(sourceUrl, { ordinal, sourceUrl, sourceTitle });
    catalogOrdinals.add(ordinal);
  }

  const seenSources = new Set();
  const chapters = [];
  const cacheHealth = { rows: 0, completeSourceText: 0, completeTranslations: 0, refetchRequired: 0 };
  for (const translation of translations) {
    const rawSourceUrl = text(translation?.sourceUrl);
    const sourceUrl = canonicalLegacyKujiangChapterUrl(rawSourceUrl);
    if (!sourceUrl || legacyKujiangBookUrlForChapter(sourceUrl) !== bookUrl) {
      issueCount(issues, 'translation_source_outside_catalog_book');
      continue;
    }
    const entry = catalogBySourceUrl.get(sourceUrl);
    if (!entry) {
      issueCount(issues, 'translation_source_missing_from_catalog');
      continue;
    }
    if (seenSources.has(sourceUrl)) {
      issueCount(issues, 'duplicate_translation_source');
      continue;
    }
    seenSources.add(sourceUrl);
    chapters.push(entry);
    cacheHealth.rows += 1;
    const cacheKey = text(translation?.cacheKey);
    const payload = cacheKey ? cache[cacheKey] : null;
    if (!payload || !cacheKey || !legacyCacheKeyMatchesSourceUrl(cacheKey, rawSourceUrl)) {
      cacheHealth.refetchRequired += 1;
      issueCount(issues, !payload ? 'missing_translation_cache' : 'mismatched_translation_cache');
      continue;
    }
    const status = legacyCachePayloadStatus(payload);
    if (status.sourceText) cacheHealth.completeSourceText += 1;
    else {
      cacheHealth.refetchRequired += 1;
      issueCount(issues, 'incomplete_cached_source_text');
    }
    if (status.translation) cacheHealth.completeTranslations += 1;
    else issueCount(issues, 'incomplete_cached_translation');
  }

  const blockingCodes = new Set([
    'invalid_catalog_entry',
    'duplicate_catalog_source_url',
    'duplicate_catalog_ordinal',
    'translation_source_missing_from_catalog',
    'duplicate_translation_source'
  ]);
  return {
    formatVersion: 1,
    source: { site: 'kujiang', bookUrl },
    provenanceReady: ![...issues.keys()].some((code) => blockingCodes.has(code)),
    chapters: chapters.sort((left, right) => left.ordinal - right.ordinal),
    cacheHealth,
    issues: reportIssues(issues)
  };
}
