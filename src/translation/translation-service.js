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
    async translateChapter({ novelId, chapterNumber }) {
      const chapter = repositories.chapters.getSourcedChapter(novelId, chapterNumber);
      const priorContext = repositories.chapters.listPriorSourcedOriginalTexts(novelId, chapterNumber);
      const verifiedMemory = repositories.memory.listVerifiedMemoryEntries(novelId);
      const translation = await provider.translate({
        originalChinese: chapter.originalText,
        priorContext,
        verifiedMemory
      });
      const findings = qualityChecker({ originalChinese: chapter.originalText, paragraphs: translation.paragraphs });

      return withinTransaction(database, () => {
        const revision = repositories.chapters.addTranslationRevision({
          chapterId: chapter.id,
          translatedText: translation.paragraphs.join('\n\n'),
          provider: provider.provider,
          model: provider.model
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
