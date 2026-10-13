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
