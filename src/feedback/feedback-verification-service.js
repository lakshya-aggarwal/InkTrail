import { ConflictError } from '../domain/errors.js';

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

export function createFeedbackVerificationService({ database, repositories }) {
  return {
    verifyFeedback({ novelId, reportId, status, memory }) {
      return withinTransaction(database, () => {
        const submittedReport = repositories.feedback.getFeedbackReport({ novelId, reportId });
        if (status === 'approved') {
          const latestRevision = repositories.chapters.listTranslationRevisions(submittedReport.chapterId).at(-1);
          if (submittedReport.translationRevisionId !== latestRevision.id) {
            throw new ConflictError('feedback report targets a stale translation revision');
          }
        }
        const report = repositories.feedback.updateFeedbackStatus({ novelId, reportId, status });
        if (status !== 'approved') {
          return { report, revision: null, memory: null };
        }

        const revision = repositories.chapters.addTranslationRevision({
          chapterId: report.chapterId,
          translatedText: report.proposedCorrection,
          provider: 'feedback',
          model: 'verified'
        });
        const verifiedMemory = repositories.memory.saveVerifiedMemoryEntry({ ...memory, novelId });
        return { report, revision, memory: verifiedMemory };
      });
    }
  };
}
