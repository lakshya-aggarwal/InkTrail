import assert from 'node:assert/strict';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, TranslationProviderError } from '../../src/domain/errors.js';
import { createFeedbackRepository } from '../../src/feedback/feedback-repository.js';
import { createFeedbackVerificationService } from '../../src/feedback/feedback-verification-service.js';
import { createJobRepository } from '../../src/jobs/job-repository.js';
import { createMemoryRepository } from '../../src/memory/memory-repository.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';
import { createQualityFindingRepository } from '../../src/translation/quality-finding-repository.js';
import { createTranslationService } from '../../src/translation/translation-service.js';

function fixture() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-13T00:00:00.000Z');
  const repositories = {
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    sources: createSourceRepository(database, clock),
    findings: createQualityFindingRepository(database, clock),
    memory: createMemoryRepository(database, clock),
    jobs: createJobRepository(database, clock),
    feedback: createFeedbackRepository(database, clock)
  };
  return { database, repositories };
}

function sourceChapter(repositories, novel, chapter, externalChapterId) {
  const source = repositories.sources.createOrGetNovelSource({
    novelId: novel.id,
    site: 'fixture',
    externalNovelId: novel.id,
    sourceUrl: `https://fixture.test/novels/${novel.id}`,
    normalizedUrl: `https://fixture.test/novels/${novel.id}`,
    title: novel.title
  });
  repositories.sources.createChapterSource({
    novelId: novel.id,
    chapterId: chapter.id,
    novelSourceId: source.id,
    site: 'fixture',
    externalChapterId,
    sourceUrl: `https://fixture.test/chapters/${externalChapterId}`,
    normalizedUrl: `https://fixture.test/chapters/${externalChapterId}`,
    sourceTitle: chapter.title,
    previousSourceUrl: null,
    nextSourceUrl: null,
    fetchedAt: '2026-10-13T00:00:00.000Z',
    contentSha256: externalChapterId
  });
}

function seededChapter(repositories, novel, chapterNumber, originalText = '第一段。\n\n第二段。') {
  const chapter = repositories.chapters.recordChapter({
    novelId: novel.id,
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    originalText
  });
  sourceChapter(repositories, novel, chapter, `${novel.id}-${chapterNumber}`);
  return chapter;
}

function provider(paragraphs) {
  return {
    provider: 'fake',
    model: 'fake-model',
    async translate(input) {
      return { paragraphs, input };
    }
  };
}

function feedbackReport(repositories, novel, chapter, {
  translatedText = 'Original translation',
  selectedText = translatedText,
  proposedCorrection = 'Corrected translation'
} = {}) {
  const revision = repositories.chapters.addTranslationRevision({
    chapterId: chapter.id,
    translatedText,
    provider: 'fake',
    model: 'fake-model'
  });
  return repositories.feedback.submitFeedbackReport({
    novelId: novel.id,
    chapterId: chapter.id,
    translationRevisionId: revision.id,
    selectedText,
    sourceContext: '第一段。',
    translatedContext: translatedText,
    proposedCorrection,
    reason: 'Verified terminology'
  });
}

test('translates sourced chapters with bounded prior context and verified novel memory', async (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const otherNovel = repositories.novels.createNovel({ title: 'Second' });
  seededChapter(repositories, novel, 1, 'Earlier source text 1');
  seededChapter(repositories, novel, 2, 'Earlier source text 2');
  seededChapter(repositories, novel, 3, 'Earlier source text 3');
  seededChapter(repositories, novel, 4, 'Earlier source text 4');
  const chapter = seededChapter(repositories, novel, 5);
  repositories.memory.saveVerifiedMemoryEntry({ novelId: novel.id, sourceTerm: '师兄', preferredRendering: 'senior brother', semanticScope: 'ranks', evidence: 'verified', confidence: 1 });
  repositories.memory.saveVerifiedMemoryEntry({ novelId: otherNovel.id, sourceTerm: '师兄', preferredRendering: 'elder brother', semanticScope: 'ranks', evidence: 'other novel', confidence: 1 });
  let request;
  const translationProvider = provider(['First paragraph.', 'Second paragraph.']);
  const translate = createTranslationService({ database, repositories, provider: {
    ...translationProvider,
    async translate(input) {
      request = input;
      return translationProvider.translate(input);
    }
  } });

  const result = await translate.translateChapter({ novelId: novel.id, chapterNumber: 5 });

  assert.equal(result.revision.revision, 1);
  assert.equal(result.revision.translatedText, 'First paragraph.\n\nSecond paragraph.');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(request.priorContext, ['Earlier source text 2', 'Earlier source text 3', 'Earlier source text 4']);
  assert.deepEqual(request.verifiedMemory.map(({ preferredRendering }) => preferredRendering), ['senior brother']);
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id), [result.revision]);
});

test('records the model captured by a durable translation request', async (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Model capture' });
  const chapter = seededChapter(repositories, novel, 1);
  const translate = createTranslationService({
    database,
    repositories,
    provider: {
      provider: 'ollama',
      model: 'qwen3:30b',
      async translate({ model }) {
        return { paragraphs: ['Model-specific translation.'], model };
      }
    }
  });

  const result = await translate.translateChapter({ novelId: novel.id, chapterNumber: 1, model: 'qwen3:8b' });

  assert.equal(result.revision.model, 'qwen3:8b');
  assert.equal(repositories.chapters.listTranslationRevisions(chapter.id).at(-1).model, 'qwen3:8b');
});

test('skips a claim-bound translation when a direct translation already completed its checkpoint', async (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'Claim checkpoint' });
  const chapter = seededChapter(repositories, novel, 1);
  const job = repositories.jobs.createTranslationJob({ novelId: novel.id, target: { chapterNumbers: [1] }, priority: 0 });
  const claim = repositories.jobs.claimNextRunnable({ claimToken: 'claim-token', type: 'translate_chapters' });
  repositories.jobs.prepareTranslationAttempt({ novelId: novel.id, jobId: job.id, claimToken: claim.claimToken });
  const translate = createTranslationService({
    database,
    repositories,
    provider: provider(['Translation.']),
    qualityChecker: () => [{ kind: 'forced_check', details: 'Forced quality check.' }]
  });

  const direct = await translate.translateChapter({ novelId: novel.id, chapterNumber: 1 });
  const skipped = await translate.translateChapter({
    novelId: novel.id,
    chapterNumber: 1,
    claim: { jobId: job.id, claimToken: claim.claimToken }
  });
  const anotherDirect = await translate.translateChapter({ novelId: novel.id, chapterNumber: 1 });

  assert.equal(skipped.status, 'checkpoint_complete');
  assert.deepEqual(skipped.revision, direct.revision);
  assert.deepEqual(skipped.findings, []);
  assert.deepEqual(
    repositories.chapters.listTranslationRevisions(chapter.id).map(({ revision }) => revision),
    [1, 2]
  );
  assert.equal(anotherDirect.revision.revision, 2);
  assert.equal(database.prepare('select count(*) as count from translation_quality_findings').get().count, 2);
});

test('preserves a provider error without persisting a partial revision', async (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const chapter = seededChapter(repositories, novel, 1);
  const failure = new TranslationProviderError('provider unavailable');
  const translate = createTranslationService({
    database,
    repositories,
    provider: { provider: 'fake', model: 'fake-model', async translate() { throw failure; } }
  });

  await assert.rejects(() => translate.translateChapter({ novelId: novel.id, chapterNumber: 1 }), (error) => error === failure);
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id), []);
  assert.equal(database.prepare('select count(*) as count from translation_quality_findings').get().count, 0);
});

test('persists quality findings with the translation revision', async (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  seededChapter(repositories, novel, 1);
  const translate = createTranslationService({ database, repositories, provider: provider(['Leaked 中文.', 'Repeated prose.', 'Repeated prose.']) });

  const result = await translate.translateChapter({ novelId: novel.id, chapterNumber: 1 });

  assert.deepEqual(result.findings.map(({ kind }) => kind).sort(), ['chinese_leakage', 'malformed_paragraph', 'repeated_prose']);
  assert.deepEqual(
    repositories.findings.listQualityFindings({ novelId: novel.id, translationRevisionId: result.revision.id }).map(({ kind }) => kind).sort(),
    ['chinese_leakage', 'malformed_paragraph', 'repeated_prose']
  );
});

test('rejects feedback without changing translation history or memory', (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const chapter = seededChapter(repositories, novel, 1);
  const report = feedbackReport(repositories, novel, chapter);
  const verify = createFeedbackVerificationService({ database, repositories });

  const result = verify.verifyFeedback({ novelId: novel.id, reportId: report.id, status: 'rejected' });

  assert.equal(result.report.status, 'rejected');
  assert.equal(result.revision, null);
  assert.equal(result.memory, null);
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText), ['Original translation']);
  assert.deepEqual(repositories.memory.listVerifiedMemoryEntries(novel.id), []);
});

test('marks feedback for review without changing translation history or memory', (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const chapter = seededChapter(repositories, novel, 1);
  const report = feedbackReport(repositories, novel, chapter);
  const verify = createFeedbackVerificationService({ database, repositories });

  const result = verify.verifyFeedback({ novelId: novel.id, reportId: report.id, status: 'needs_review' });

  assert.equal(result.report.status, 'needs_review');
  assert.equal(result.revision, null);
  assert.equal(result.memory, null);
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText), ['Original translation']);
  assert.deepEqual(repositories.memory.listVerifiedMemoryEntries(novel.id), []);
});

test('approval accepts full-chapter feedback and updates only the feedback novel memory', (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const otherNovel = repositories.novels.createNovel({ title: 'Second' });
  const chapter = seededChapter(repositories, novel, 1);
  const report = feedbackReport(repositories, novel, chapter);
  repositories.memory.saveVerifiedMemoryEntry({ novelId: novel.id, sourceTerm: '师兄', preferredRendering: 'old rendering', semanticScope: 'ranks', evidence: 'old', confidence: 0.5 });
  repositories.memory.saveVerifiedMemoryEntry({ novelId: otherNovel.id, sourceTerm: '师兄', preferredRendering: 'other rendering', semanticScope: 'ranks', evidence: 'other', confidence: 1 });
  const verify = createFeedbackVerificationService({ database, repositories });

  const result = verify.verifyFeedback({
    novelId: novel.id,
    reportId: report.id,
    status: 'approved',
    memory: { sourceTerm: '师兄', preferredRendering: 'senior brother', semanticScope: 'ranks', evidence: 'feedback report', confidence: 1 }
  });

  assert.equal(result.report.status, 'approved');
  assert.equal(result.revision.translatedText, 'Corrected translation');
  assert.equal(result.revision.revision, 2);
  assert.equal(result.memory.preferredRendering, 'senior brother');
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText), ['Original translation', 'Corrected translation']);
  assert.deepEqual(repositories.memory.listVerifiedMemoryEntries(otherNovel.id).map(({ preferredRendering }) => preferredRendering), ['other rendering']);
});

test('approval replaces a selected passage while preserving surrounding translated paragraphs', (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const chapter = seededChapter(repositories, novel, 1);
  const report = feedbackReport(repositories, novel, chapter, {
    translatedText: 'Opening paragraph.\n\nSelected paragraph.\n\nClosing paragraph.',
    selectedText: 'Selected paragraph.',
    proposedCorrection: 'Corrected paragraph.'
  });
  const verify = createFeedbackVerificationService({ database, repositories });

  const result = verify.verifyFeedback({
    novelId: novel.id,
    reportId: report.id,
    status: 'approved',
    memory: { sourceTerm: '师兄', preferredRendering: 'senior brother', semanticScope: 'ranks', evidence: 'feedback report', confidence: 1 }
  });

  assert.equal(result.revision.translatedText, 'Opening paragraph.\n\nCorrected paragraph.\n\nClosing paragraph.');
  assert.equal(repositories.chapters.getReaderChapter(novel.id, 1).translatedText, result.revision.translatedText);
  assert.deepEqual(
    repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText),
    ['Opening paragraph.\n\nSelected paragraph.\n\nClosing paragraph.', 'Opening paragraph.\n\nCorrected paragraph.\n\nClosing paragraph.']
  );
});

test('approval rejects feedback without a unique selected passage', (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const missingChapter = seededChapter(repositories, novel, 1);
  const ambiguousChapter = seededChapter(repositories, novel, 2);
  const overlappingChapter = seededChapter(repositories, novel, 3);
  const missingReport = feedbackReport(repositories, novel, missingChapter, {
    translatedText: 'Opening paragraph.\n\nClosing paragraph.',
    selectedText: 'Absent paragraph.'
  });
  const ambiguousReport = feedbackReport(repositories, novel, ambiguousChapter, {
    translatedText: 'Repeated paragraph.\n\nRepeated paragraph.',
    selectedText: 'Repeated paragraph.',
    proposedCorrection: 'Corrected paragraph.'
  });
  const overlappingReport = feedbackReport(repositories, novel, overlappingChapter, {
    translatedText: 'banana',
    selectedText: 'ana',
    proposedCorrection: 'x'
  });
  const verify = createFeedbackVerificationService({ database, repositories });
  const memory = { sourceTerm: '师兄', preferredRendering: 'senior brother', semanticScope: 'ranks', evidence: 'feedback report', confidence: 1 };

  assert.throws(() => verify.verifyFeedback({ novelId: novel.id, reportId: missingReport.id, status: 'approved', memory }), /does not match/);
  assert.throws(() => verify.verifyFeedback({ novelId: novel.id, reportId: ambiguousReport.id, status: 'approved', memory }), /ambiguous/);
  assert.throws(() => verify.verifyFeedback({ novelId: novel.id, reportId: overlappingReport.id, status: 'approved', memory }), /ambiguous/);
  assert.equal(repositories.feedback.listFeedbackReports({ novelId: novel.id, chapterId: missingChapter.id })[0].status, 'pending');
  assert.equal(repositories.feedback.listFeedbackReports({ novelId: novel.id, chapterId: ambiguousChapter.id })[0].status, 'pending');
  assert.equal(repositories.feedback.listFeedbackReports({ novelId: novel.id, chapterId: overlappingChapter.id })[0].status, 'pending');
  assert.deepEqual(repositories.chapters.listTranslationRevisions(missingChapter.id).map(({ translatedText }) => translatedText), ['Opening paragraph.\n\nClosing paragraph.']);
  assert.deepEqual(repositories.chapters.listTranslationRevisions(ambiguousChapter.id).map(({ translatedText }) => translatedText), ['Repeated paragraph.\n\nRepeated paragraph.']);
  assert.deepEqual(repositories.chapters.listTranslationRevisions(overlappingChapter.id).map(({ translatedText }) => translatedText), ['banana']);
  assert.deepEqual(repositories.memory.listVerifiedMemoryEntries(novel.id), []);
});

test('rejects approval for feedback targeting a stale translation revision', (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const chapter = seededChapter(repositories, novel, 1);
  const report = feedbackReport(repositories, novel, chapter);
  repositories.chapters.addTranslationRevision({
    chapterId: chapter.id,
    translatedText: 'Current translation',
    provider: 'fake',
    model: 'fake-model'
  });
  const verify = createFeedbackVerificationService({ database, repositories });

  assert.throws(
    () => verify.verifyFeedback({
      novelId: novel.id,
      reportId: report.id,
      status: 'approved',
      memory: { sourceTerm: '师兄', preferredRendering: 'senior brother', semanticScope: 'ranks', evidence: 'feedback report', confidence: 1 }
    }),
    ConflictError
  );
  assert.equal(repositories.feedback.listFeedbackReports({ novelId: novel.id, chapterId: chapter.id })[0].status, 'pending');
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText), ['Original translation', 'Current translation']);
  assert.equal(repositories.chapters.getReaderChapter(novel.id, 1).translatedText, 'Current translation');
  assert.deepEqual(repositories.memory.listVerifiedMemoryEntries(novel.id), []);
});

test('approval rolls back when verified memory cannot be stored', (t) => {
  const { database, repositories } = fixture();
  t.after(() => database.close());
  const novel = repositories.novels.createNovel({ title: 'First' });
  const chapter = seededChapter(repositories, novel, 1);
  const report = feedbackReport(repositories, novel, chapter);
  const verify = createFeedbackVerificationService({ database, repositories });

  assert.throws(
    () => verify.verifyFeedback({ novelId: novel.id, reportId: report.id, status: 'approved', memory: { sourceTerm: '' } }),
    /sourceTerm is required/
  );
  assert.equal(repositories.feedback.listFeedbackReports({ novelId: novel.id, chapterId: chapter.id })[0].status, 'pending');
  assert.deepEqual(repositories.chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText), ['Original translation']);
});
