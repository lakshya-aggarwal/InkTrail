import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';

function repositories() {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-11T00:00:00.000Z');
  return {
    database,
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock)
  };
}

test('translation revisions append instead of overwriting prior text', (t) => {
  const { database, novels, chapters } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });
  const chapter = chapters.recordChapter({ novelId: novel.id, chapterNumber: 1, title: 'Arrival', originalText: 'Chinese', sourceUrl: null });

  chapters.addTranslationRevision({ chapterId: chapter.id, translatedText: 'First', provider: 'test', model: 'test' });
  chapters.addTranslationRevision({ chapterId: chapter.id, translatedText: 'Second', provider: 'test', model: 'test' });

  assert.equal(chapters.getReaderChapter(novel.id, 1).translatedText, 'Second');
  assert.deepEqual(chapters.listTranslationRevisions(chapter.id).map(({ translatedText }) => translatedText), ['First', 'Second']);
});

test('reader chapters stay within their novel and use stored chapter order', (t) => {
  const { database, novels, chapters } = repositories();
  t.after(() => database.close());
  const first = novels.createNovel({ title: 'First' });
  const second = novels.createNovel({ title: 'Second' });
  chapters.recordChapter({ novelId: first.id, chapterNumber: 1, title: 'One', originalText: 'One' });
  chapters.recordChapter({ novelId: first.id, chapterNumber: 3, title: 'Three', originalText: 'Three' });
  chapters.recordChapter({ novelId: first.id, chapterNumber: 8, title: 'Eight', originalText: 'Eight' });
  chapters.recordChapter({ novelId: second.id, chapterNumber: 3, title: 'Other', originalText: 'Other' });

  const readerChapter = chapters.getReaderChapter(first.id, 3);
  assert.equal(readerChapter.title, 'Three');
  assert.equal(readerChapter.previousChapterNumber, 1);
  assert.equal(readerChapter.nextChapterNumber, 8);
});

test('validates chapter inputs and prevents duplicate chapter numbers per novel', (t) => {
  const { database, novels, chapters } = repositories();
  t.after(() => database.close());
  const novel = novels.createNovel({ title: 'Ink Trail' });
  const input = { novelId: novel.id, chapterNumber: 1, title: 'One', originalText: 'Original' };

  chapters.recordChapter(input);
  assert.throws(() => chapters.recordChapter(input), ConflictError);
  assert.throws(() => chapters.recordChapter({ ...input, chapterNumber: 0 }), ValidationError);
  assert.throws(() => chapters.addTranslationRevision({ chapterId: 'missing', translatedText: 'Text', provider: 'test', model: 'test' }), NotFoundError);
});
