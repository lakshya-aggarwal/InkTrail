import { ConflictError, TranslationProviderError } from '../domain/errors.js';
import { checkTranslationQuality } from './quality-checker.js';

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

export function createTranslationService({ database, repositories, provider, qualityChecker = checkTranslationQuality }) {
  return {
    async listModels() {
      if (typeof provider.listModels !== 'function') throw new TranslationProviderError('translation model list is unavailable');
      return { items: await provider.listModels(), defaultModel: provider.model };
    },

    async translateChapter({ novelId, chapterNumber, claim = null, model = undefined }) {
      const chapter = repositories.chapters.getSourcedChapter(novelId, chapterNumber);
      const priorContext = repositories.chapters.listPriorSourcedOriginalTexts(novelId, chapterNumber);
      const verifiedMemory = repositories.memory.listVerifiedMemoryEntries(novelId);
      const translation = await provider.translate({
        originalChinese: chapter.originalText,
        priorContext,
        verifiedMemory,
        ...(model === undefined ? {} : { model })
      });
      const findings = qualityChecker({ originalChinese: chapter.originalText, paragraphs: translation.paragraphs });

      return withinTransaction(database, () => {
        if (claim !== null) {
          if (!repositories.jobs) throw new ConflictError('translation job claim is no longer active');
          repositories.jobs.assertActiveTranslationClaim({
            novelId,
            jobId: claim.jobId,
            claimToken: claim.claimToken,
            chapterId: chapter.id
          });
          const revision = repositories.chapters.listTranslationRevisions(chapter.id).at(-1);
          if (revision) {
            return { status: 'checkpoint_complete', revision, findings: [] };
          }
        }
        const revision = repositories.chapters.addTranslationRevision({
          chapterId: chapter.id,
          translatedText: translation.paragraphs.join('\n\n'),
          provider: provider.provider,
          model: translation.model ?? provider.model
        });
        return {
          revision,
          findings: findings.map((finding) => repositories.findings.recordQualityFinding({
            novelId,
            translationRevisionId: revision.id,
            ...finding
          }))
        };
      });
    }
  };
}
