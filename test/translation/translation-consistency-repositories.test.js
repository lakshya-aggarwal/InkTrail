import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createFeedbackRepository } from '../../src/feedback/feedback-repository.js';
import { createMemoryRepository } from '../../src/memory/memory-repository.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createQualityFindingRepository } from '../../src/translation/quality-finding-repository.js';

function repositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-13T00:00:00.000Z');
  return {
    database,
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    findings: createQualityFindingRepository(database, clock),
    memory: createMemoryRepository(database, clock),
    feedback: createFeedbackRepository(database, clock)
  };
}

function seed(repositories) {
  const firstNovel = repositories.novels.createNovel({ title: 'First' });
  const secondNovel = repositories.novels.createNovel({ title: 'Second' });
  const firstChapter = repositories.chapters.recordChapter({ novelId: firstNovel.id, chapterNumber: 1, title: 'One', originalText: 'Chinese one' });
  const secondChapter = repositories.chapters.recordChapter({ novelId: secondNovel.id, chapterNumber: 1, title: 'One', originalText: 'Chinese two' });
  const firstRevision = repositories.chapters.addTranslationRevision({ chapterId: firstChapter.id, translatedText: 'First translation', provider: 'test', model: 'test' });
  const secondRevision = repositories.chapters.addTranslationRevision({ chapterId: secondChapter.id, translatedText: 'Second translation', provider: 'test', model: 'test' });
  return { firstNovel, secondNovel, firstChapter, secondChapter, firstRevision, secondRevision };
}

test('quality findings and verified memory stay within their novel', (t) => {
  const fixture = repositories();
  t.after(() => fixture.database.close());
  const { firstNovel, secondNovel, firstRevision, secondRevision } = seed(fixture);

  const finding = fixture.findings.recordQualityFinding({
    novelId: firstNovel.id,
    translationRevisionId: firstRevision.id,
    kind: 'untranslated_chinese',
    details: 'Chinese remains'
  });
  fixture.memory.saveVerifiedMemoryEntry({
    novelId: firstNovel.id,
    sourceTerm: '师兄',
    preferredRendering: 'senior brother',
    semanticScope: 'sect relationship',
    evidence: 'Chapter 1',
    confidence: 1
  });
  fixture.memory.saveVerifiedMemoryEntry({
    novelId: secondNovel.id,
    sourceTerm: '师兄',
    preferredRendering: 'elder brother',
    semanticScope: 'sect relationship',
    evidence: 'Chapter 1',
    confidence: 0.8
  });

  assert.deepEqual(fixture.findings.listQualityFindings({ novelId: firstNovel.id, translationRevisionId: firstRevision.id }), [finding]);
  assert.deepEqual(fixture.memory.listVerifiedMemoryEntries(firstNovel.id).map(({ preferredRendering }) => preferredRendering), ['senior brother']);
  assert.deepEqual(fixture.memory.listVerifiedMemoryEntries(secondNovel.id).map(({ preferredRendering }) => preferredRendering), ['elder brother']);
  assert.throws(() => fixture.findings.recordQualityFinding({ novelId: firstNovel.id, translationRevisionId: secondRevision.id, kind: 'gap', details: 'gap' }), NotFoundError);
  assert.throws(() => fixture.memory.saveVerifiedMemoryEntry({ novelId: firstNovel.id, sourceTerm: 'term', preferredRendering: 'word', semanticScope: 'scope', evidence: 'evidence', confidence: 2 }), ValidationError);
});

test('feedback reports are chapter-scoped and transition explicitly', (t) => {
  const fixture = repositories();
  t.after(() => fixture.database.close());
  const { firstNovel, secondNovel, firstChapter, secondChapter, firstRevision, secondRevision } = seed(fixture);
  const report = fixture.feedback.submitFeedbackReport({
    novelId: firstNovel.id,
    chapterId: firstChapter.id,
    translationRevisionId: firstRevision.id,
    selectedText: 'First translation',
    sourceContext: 'Chinese one',
    translatedContext: 'First translation',
    proposedCorrection: 'Corrected translation',
    reason: 'Term is inconsistent'
  });

  assert.equal(report.status, 'pending');
  assert.deepEqual(fixture.feedback.listFeedbackReports({ novelId: firstNovel.id, chapterId: firstChapter.id }), [report]);
  assert.deepEqual(fixture.feedback.listFeedbackReports({ novelId: secondNovel.id, chapterId: secondChapter.id }), []);
  assert.throws(() => fixture.feedback.submitFeedbackReport({
    novelId: firstNovel.id,
    chapterId: firstChapter.id,
    translationRevisionId: secondRevision.id,
    selectedText: 'wrong',
    sourceContext: 'wrong',
    translatedContext: 'wrong',
    proposedCorrection: 'wrong',
    reason: 'wrong'
  }), NotFoundError);

  const reviewed = fixture.feedback.updateFeedbackStatus({ novelId: firstNovel.id, reportId: report.id, status: 'needs_review' });
  const approved = fixture.feedback.updateFeedbackStatus({ novelId: firstNovel.id, reportId: report.id, status: 'approved' });
  assert.equal(reviewed.status, 'needs_review');
  assert.equal(approved.status, 'approved');
  assert.throws(() => fixture.feedback.updateFeedbackStatus({ novelId: firstNovel.id, reportId: report.id, status: 'rejected' }), ConflictError);
  assert.throws(() => fixture.feedback.updateFeedbackStatus({ novelId: secondNovel.id, reportId: report.id, status: 'approved' }), NotFoundError);
});

test('feedback status update rejects a stale transition from another connection', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'inktrail-feedback-'));
  const databasePath = join(directory, 'library.sqlite');
  const firstDatabase = openDatabase({ databasePath });
  const secondDatabase = openDatabase({ databasePath });
  t.after(() => {
    firstDatabase.close();
    secondDatabase.close();
    rmSync(directory, { recursive: true, force: true });
  });
  migrate(firstDatabase);
  const clock = () => new Date('2026-10-13T00:00:00.000Z');
  const novels = createNovelRepository(firstDatabase, clock);
  const chapters = createChapterRepository(firstDatabase, clock);
  const feedback = createFeedbackRepository(firstDatabase, clock);
  const novel = novels.createNovel({ title: 'First' });
  const chapter = chapters.recordChapter({ novelId: novel.id, chapterNumber: 1, title: 'One', originalText: 'Chinese' });
  const revision = chapters.addTranslationRevision({ chapterId: chapter.id, translatedText: 'Translation', provider: 'test', model: 'test' });
  const report = feedback.submitFeedbackReport({
    novelId: novel.id,
    chapterId: chapter.id,
    translationRevisionId: revision.id,
    selectedText: 'Translation',
    sourceContext: 'Chinese',
    translatedContext: 'Translation',
    proposedCorrection: 'Correction',
    reason: 'Reason'
  });
  const secondFeedback = createFeedbackRepository(secondDatabase, clock);
  let interleaved = false;
  const staleReadDatabase = {
    prepare(sql) {
      const statement = firstDatabase.prepare(sql);
      if (!sql.includes('from feedback_reports where id = ? and novel_id = ?')) {
        return statement;
      }
      return {
        get(...values) {
          const row = statement.get(...values);
          if (!interleaved) {
            interleaved = true;
            secondFeedback.updateFeedbackStatus({ novelId: novel.id, reportId: report.id, status: 'approved' });
          }
          return row;
        }
      };
    }
  };
  const staleFeedback = createFeedbackRepository(staleReadDatabase, clock);

  assert.throws(() => staleFeedback.updateFeedbackStatus({ novelId: novel.id, reportId: report.id, status: 'rejected' }), ConflictError);
  assert.equal(secondFeedback.listFeedbackReports({ novelId: novel.id, chapterId: chapter.id })[0].status, 'approved');
});
