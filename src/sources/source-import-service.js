import { createHash } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('input must be an object');
  }
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value.trim();
}

function requireChapterNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError('chapterNumber must be a positive integer');
  }
  return value;
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

export function createSourceImportService({ database, repositories, adapterRegistry, clock }) {
  return {
    async importChapter(input) {
      const { novelId: inputNovelId, sourceUrl: inputSourceUrl, chapterNumber: inputChapterNumber, claim = null } = requireObject(input);
      const novelId = requireText(inputNovelId, 'novelId');
      const sourceUrl = requireText(inputSourceUrl, 'sourceUrl');
      const chapterNumber = requireChapterNumber(inputChapterNumber);
      const sourceClaim = claim === null ? null : {
        jobId: requireText(requireObject(claim).jobId, 'claim.jobId'),
        claimToken: requireText(requireObject(claim).claimToken, 'claim.claimToken'),
        catalogEntryId: requireText(requireObject(claim).catalogEntryId, 'claim.catalogEntryId')
      };
      const adapter = adapterRegistry.getAdapter(sourceUrl);
      if (!adapter) {
        throw new ValidationError('sourceUrl is not supported');
      }

      const novel = repositories.novels.getNovel(novelId);
      const sourceChapter = await adapter.fetchChapter(sourceUrl);
      const originalText = sourceChapter.paragraphs.join('\n\n');
      const contentSha256 = createHash('sha256').update(originalText).digest('hex');

      return withinTransaction(database, () => {
        if (sourceClaim) {
          repositories.jobs.assertActiveSourceImportClaim({ novelId, ...sourceClaim });
        }
        const existingSource = repositories.sources.getChapterSource({
          novelId,
          site: sourceChapter.site,
          normalizedUrl: sourceChapter.normalizedUrl
        });
        if (existingSource) {
          if (existingSource.contentSha256 !== contentSha256) {
            throw new ConflictError('source chapter mapping conflicts with existing provenance');
          }
          let existingChapter;
          try {
            existingChapter = repositories.chapters.getReaderChapter(novelId, chapterNumber);
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
            throw new ConflictError('source chapter mapping conflicts with existing provenance');
          }
          if (existingChapter.id !== existingSource.chapterId) {
            throw new ConflictError('source chapter mapping conflicts with existing provenance');
          }
          return { chapter: existingChapter, source: existingSource, created: false };
        }

        const novelSource = repositories.sources.createOrGetNovelSource({
          novelId,
          site: sourceChapter.site,
          externalNovelId: sourceChapter.externalNovelId,
          sourceUrl: sourceChapter.novelSourceUrl,
          normalizedUrl: sourceChapter.novelSourceUrl,
          title: novel.title
        });
        const chapter = repositories.chapters.recordChapter({
          novelId,
          chapterNumber,
          title: sourceChapter.title,
          originalText,
          sourceUrl: sourceChapter.sourceUrl
        });
        const source = repositories.sources.createChapterSource({
          novelId,
          chapterId: chapter.id,
          novelSourceId: novelSource.id,
          site: sourceChapter.site,
          externalChapterId: sourceChapter.externalChapterId,
          sourceUrl: sourceChapter.sourceUrl,
          normalizedUrl: sourceChapter.normalizedUrl,
          sourceTitle: sourceChapter.title,
          previousSourceUrl: sourceChapter.previousSourceUrl,
          nextSourceUrl: sourceChapter.nextSourceUrl,
          fetchedAt: clock().toISOString(),
          contentSha256
        });
        return { chapter: repositories.chapters.getReaderChapter(novelId, chapterNumber), source, created: true };
      });
    }
  };
}
