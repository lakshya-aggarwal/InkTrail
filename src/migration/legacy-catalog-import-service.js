import { createHash } from 'node:crypto';
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

function requireText(value, label) {
  const normalized = text(value);
  if (!normalized) throw new LegacySnapshotError(`${label} is required.`);
  return normalized;
}

function withinTransaction(database, action) {
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

function externalChapterId(sourceUrl) {
  return new URL(sourceUrl).pathname.split('/').at(-1);
}

function manifestChapters(manifest) {
  if (manifest?.formatVersion !== 1) {
    throw new LegacySnapshotError('manifest formatVersion must be 1.');
  }
  const source = object(manifest, 'manifest').source;
  const bookUrl = canonicalLegacyKujiangBookUrl(text(source?.bookUrl));
  if (source?.site !== 'kujiang' || !bookUrl) {
    throw new LegacySnapshotError('manifest must identify one canonical Kujiang source book.');
  }
  if (manifest.provenanceReady !== true) {
    throw new LegacySnapshotError('manifest provenanceReady must be true before import.');
  }
  const sourceUrls = new Set();
  const ordinals = new Set();
  const chapters = list(manifest.chapters, 'manifest chapters').map((entry) => {
    const sourceUrl = canonicalLegacyKujiangChapterUrl(text(entry?.sourceUrl));
    const ordinal = entry?.ordinal;
    const sourceTitle = text(entry?.sourceTitle);
    if (!sourceUrl || sourceUrl !== entry.sourceUrl || legacyKujiangBookUrlForChapter(sourceUrl) !== bookUrl || !Number.isSafeInteger(ordinal) || ordinal < 1 || !sourceTitle) {
      throw new LegacySnapshotError('manifest contains an invalid chapter entry.');
    }
    if (sourceUrls.has(sourceUrl) || ordinals.has(ordinal)) {
      throw new LegacySnapshotError('manifest contains duplicate source URLs or chapter ordinals.');
    }
    sourceUrls.add(sourceUrl);
    ordinals.add(ordinal);
    return { ordinal, sourceUrl, sourceTitle };
  });
  if (chapters.length === 0) throw new LegacySnapshotError('manifest must contain at least one chapter.');
  return { bookUrl, chapters: chapters.sort((left, right) => left.ordinal - right.ordinal) };
}

function cachedChapterInputs({ translationState, translationCache, manifest }) {
  const { bookUrl, chapters } = manifestChapters(manifest);
  const state = list(object(translationState, 'translation-state.json').chapters, 'translation-state.json chapters');
  const cache = object(translationCache, 'translation-cache.json');
  const requestedSources = new Set(chapters.map(({ sourceUrl }) => sourceUrl));
  const bySourceUrl = new Map();

  for (const row of state) {
    const rawSourceUrl = text(row?.sourceUrl);
    const sourceUrl = canonicalLegacyKujiangChapterUrl(rawSourceUrl);
    if (!sourceUrl || legacyKujiangBookUrlForChapter(sourceUrl) !== bookUrl || !requestedSources.has(sourceUrl)) continue;
    if (rawSourceUrl !== sourceUrl) {
      throw new LegacySnapshotError('legacy state source URLs must be canonical before import.');
    }
    if (bySourceUrl.has(sourceUrl)) throw new LegacySnapshotError('legacy state contains duplicate selected source URLs.');
    const cacheKey = text(row.cacheKey);
    const payload = cacheKey ? cache[cacheKey] : null;
    if (!payload || !legacyCacheKeyMatchesSourceUrl(cacheKey, rawSourceUrl)) {
      throw new LegacySnapshotError('legacy cache is missing or does not match a selected source URL.');
    }
    if (!legacyCachePayloadStatus(payload).translation) {
      throw new LegacySnapshotError('legacy cache must contain complete source text and translation for every selected chapter.');
    }
    bySourceUrl.set(sourceUrl, { payload, fetchedAt: text(row.updatedAt) });
  }

  return {
    bookUrl,
    chapters: chapters.map((chapter) => {
      const cached = bySourceUrl.get(chapter.sourceUrl);
      if (!cached) throw new LegacySnapshotError('legacy state is missing a selected manifest chapter.');
      const originalText = cached.payload.paragraphs.map(({ source }) => source.trim()).join('\n\n');
      const translatedText = cached.payload.paragraphs.map(({ translation }) => translation.trim()).join('\n\n');
      return {
        ...chapter,
        externalChapterId: externalChapterId(chapter.sourceUrl),
        originalText,
        translatedText,
        contentSha256: createHash('sha256').update(originalText).digest('hex'),
        fetchedAt: cached.fetchedAt
      };
    })
  };
}

export function createLegacyCatalogImportService({ database, repositories, clock }) {
  return {
    importManifest(input) {
      const payload = object(input, 'input');
      const title = requireText(payload.title, 'title');
      const prepared = cachedChapterInputs(payload);

      return withinTransaction(database, () => {
        let novelSource = repositories.sources.findNovelSourceByCanonicalUrl({ site: 'kujiang', normalizedUrl: prepared.bookUrl });
        let novel;
        let createdNovel = false;
        if (novelSource) {
          novel = repositories.novels.getNovel(novelSource.novelId);
        } else {
          novel = repositories.novels.createNovel({ title, sourceUrl: prepared.bookUrl });
          novelSource = repositories.sources.createOrGetNovelSource({
            novelId: novel.id,
            site: 'kujiang',
            externalNovelId: prepared.bookUrl.split('/').at(-1),
            sourceUrl: prepared.bookUrl,
            normalizedUrl: prepared.bookUrl,
            title
          });
          createdNovel = true;
        }

        let importedChapters = 0;
        let existingChapters = 0;
        for (const chapter of prepared.chapters) {
          const existingSource = repositories.sources.getChapterSource({
            novelId: novel.id,
            site: 'kujiang',
            normalizedUrl: chapter.sourceUrl
          });
          if (existingSource) {
            const existingChapter = repositories.chapters.getReaderChapter(novel.id, chapter.ordinal);
            if (existingChapter.id !== existingSource.chapterId || existingSource.contentSha256 !== chapter.contentSha256 || existingChapter.sourceUrl !== chapter.sourceUrl) {
              throw new LegacySnapshotError('existing source provenance conflicts with the legacy manifest.');
            }
            existingChapters += 1;
            continue;
          }

          const createdChapter = repositories.chapters.recordChapter({
            novelId: novel.id,
            chapterNumber: chapter.ordinal,
            title: chapter.sourceTitle,
            originalText: chapter.originalText,
            sourceUrl: chapter.sourceUrl
          });
          repositories.sources.createChapterSource({
            novelId: novel.id,
            chapterId: createdChapter.id,
            novelSourceId: novelSource.id,
            site: 'kujiang',
            externalChapterId: chapter.externalChapterId,
            sourceUrl: chapter.sourceUrl,
            normalizedUrl: chapter.sourceUrl,
            sourceTitle: chapter.sourceTitle,
            previousSourceUrl: null,
            nextSourceUrl: null,
            fetchedAt: chapter.fetchedAt ?? clock().toISOString(),
            contentSha256: chapter.contentSha256
          });
          repositories.chapters.addTranslationRevision({
            chapterId: createdChapter.id,
            translatedText: chapter.translatedText,
            provider: 'legacy-cache',
            model: 'legacy-cache'
          });
          importedChapters += 1;
        }

        return {
          novel,
          sourceBookUrl: prepared.bookUrl,
          createdNovel,
          importedChapters,
          existingChapters
        };
      });
    }
  };
}
