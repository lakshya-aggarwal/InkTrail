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

function applyCorrection(latestTranslation, report) {
  const firstMatch = latestTranslation.indexOf(report.selectedText);
  if (firstMatch === -1) {
    throw new ConflictError('feedback selected text does not match the latest translation');
  }
  if (latestTranslation.indexOf(report.selectedText, firstMatch + report.selectedText.length) !== -1) {
    throw new ConflictError('feedback selected text is ambiguous in the latest translation');
  }
  return `${latestTranslation.slice(0, firstMatch)}${report.proposedCorrection}${latestTranslation.slice(firstMatch + report.selectedText.length)}`;
}

export function createFeedbackVerificationService({ database, repositories }) {
  return {
    verifyFeedback({ novelId, reportId, status, memory }) {
      return withinTransaction(database, () => {
        const submittedReport = repositories.feedback.getFeedbackReport({ novelId, reportId });
        let correctedTranslation = null;
        if (status === 'approved') {
          const latestRevision = repositories.chapters.listTranslationRevisions(submittedReport.chapterId).at(-1);
          if (submittedReport.translationRevisionId !== latestRevision.id) {
            throw new ConflictError('feedback report targets a stale translation revision');
          }
          correctedTranslation = applyCorrection(latestRevision.translatedText, submittedReport);
        }
        const report = repositories.feedback.updateFeedbackStatus({ novelId, reportId, status });
        if (status !== 'approved') {
          return { report, revision: null, memory: null };
        }

        const revision = repositories.chapters.addTranslationRevision({
          chapterId: report.chapterId,
          translatedText: correctedTranslation,
          provider: 'feedback',
          model: 'verified'
        });
        const verifiedMemory = repositories.memory.saveVerifiedMemoryEntry({ ...memory, novelId });
        return { report, revision, memory: verifiedMemory };
      });
    }
  };
}
