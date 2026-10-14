import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('input must be an object');
  }
  return value;
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

function requireChapterNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError('chapterNumber must be a positive integer');
  }
  return value;
}

function sourceUrl(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !URL.canParse(value)) {
    throw new ValidationError('sourceUrl must be an absolute URL');
  }
  return value;
}

function toChapter(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterNumber: row.chapter_number,
    title: row.title,
    originalText: row.original_text,
    sourceUrl: row.source_url,
    createdAt: row.created_at
  };
}

function toRevision(row) {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    revision: row.revision,
    translatedText: row.translated_text,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at
  };
}

export function createChapterRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const chapterByNovelAndNumber = database.prepare(`
    select id, novel_id, chapter_number, title, original_text, source_url, created_at
    from chapters where novel_id = ? and chapter_number = ?
  `);
  const sourcedChapterByNovelAndNumber = database.prepare(`
    select chapters.id, chapters.novel_id, chapters.chapter_number, chapters.title,
      chapters.original_text, chapters.source_url, chapters.created_at
    from chapters
    where chapters.novel_id = ? and chapters.chapter_number = ?
      and exists (select 1 from chapter_sources where chapter_sources.chapter_id = chapters.id)
  `);
  const priorSourcedOriginalTexts = database.prepare(`
    select original_text
    from (
      select chapters.original_text, chapters.chapter_number
      from chapters
      where chapters.novel_id = ? and chapters.chapter_number < ?
        and exists (select 1 from chapter_sources where chapter_sources.chapter_id = chapters.id)
      order by chapters.chapter_number desc
      limit 3
    )
    order by chapter_number
  `);
  const chapterById = database.prepare('select 1 from chapters where id = ?');
  const insertChapter = database.prepare(`
    insert into chapters (id, novel_id, chapter_number, title, original_text, source_url, created_at)
    values (@id, @novelId, @chapterNumber, @title, @originalText, @sourceUrl, @createdAt)
  `);
  const nextRevision = database.prepare('select coalesce(max(revision), 0) + 1 as revision from translation_revisions where chapter_id = ?');
  const insertRevision = database.prepare(`
    insert into translation_revisions (id, chapter_id, revision, translated_text, provider, model, created_at)
    values (@id, @chapterId, @revision, @translatedText, @provider, @model, @createdAt)
  `);
  const revisionsForChapter = database.prepare(`
    select id, chapter_id, revision, translated_text, provider, model, created_at
    from translation_revisions where chapter_id = ? order by revision
  `);
  const latestRevision = database.prepare(`
    select id, chapter_id, revision, translated_text, provider, model, created_at
    from translation_revisions where chapter_id = ? order by revision desc limit 1
  `);
  const previousChapter = database.prepare('select chapter_number from chapters where novel_id = ? and chapter_number < ? order by chapter_number desc limit 1');
  const nextChapter = database.prepare('select chapter_number from chapters where novel_id = ? and chapter_number > ? order by chapter_number limit 1');

  function getSourcedChapter(novelId, chapterNumber) {
    const id = requireId(novelId, 'novelId');
    const number = requireChapterNumber(chapterNumber);
    if (!novelExists.get(id)) {
      throw new NotFoundError('novel not found');
    }
    const chapter = sourcedChapterByNovelAndNumber.get(id, number);
    if (!chapter) {
      throw new NotFoundError('sourced chapter not found');
    }
    return toChapter(chapter);
  }

  return {
    recordChapter(input) {
      const { novelId, chapterNumber, title, originalText, sourceUrl: inputSourceUrl } = requireObject(input);
      requireId(novelId, 'novelId');
      requireChapterNumber(chapterNumber);
      requireText(title, 'title');
      requireText(originalText, 'originalText');
      const normalizedSourceUrl = sourceUrl(inputSourceUrl);

      if (!novelExists.get(novelId)) {
        throw new NotFoundError('novel not found');
      }
      if (chapterByNovelAndNumber.get(novelId, chapterNumber)) {
        throw new ConflictError('chapter number already exists for novel');
      }

      const chapter = {
        id: randomUUID(),
        novelId,
        chapterNumber,
        title: title.trim(),
        originalText,
        sourceUrl: normalizedSourceUrl,
        createdAt: clock().toISOString()
      };
      insertChapter.run(chapter);
      return chapter;
    },

    addTranslationRevision(input) {
      const { chapterId, translatedText, provider, model } = requireObject(input);
      requireId(chapterId, 'chapterId');
      requireText(translatedText, 'translatedText');
      requireText(provider, 'provider');
      requireText(model, 'model');

      if (!chapterById.get(chapterId)) {
        throw new NotFoundError('chapter not found');
      }

      const revision = {
        id: randomUUID(),
        chapterId,
        revision: nextRevision.get(chapterId).revision,
        translatedText,
        provider: provider.trim(),
        model: model.trim(),
        createdAt: clock().toISOString()
      };
      insertRevision.run(revision);
      return revision;
    },

    listTranslationRevisions(chapterId) {
      const id = requireId(chapterId, 'chapterId');
      if (!chapterById.get(id)) {
        throw new NotFoundError('chapter not found');
      }
      return revisionsForChapter.all(id).map(toRevision);
    },

    getReaderChapter(novelId, chapterNumber) {
      const id = requireId(novelId, 'novelId');
      const number = requireChapterNumber(chapterNumber);
      if (!novelExists.get(id)) {
        throw new NotFoundError('novel not found');
      }

      const chapter = chapterByNovelAndNumber.get(id, number);
      if (!chapter) {
        throw new NotFoundError('chapter not found');
      }
      const revision = latestRevision.get(chapter.id);
      const previous = previousChapter.get(id, number);
      const next = nextChapter.get(id, number);
      return {
        ...toChapter(chapter),
        translationRevisionId: revision?.id ?? null,
        translatedText: revision?.translated_text ?? null,
        provider: revision?.provider ?? null,
        model: revision?.model ?? null,
        revision: revision?.revision ?? null,
        previousChapterNumber: previous?.chapter_number ?? null,
        nextChapterNumber: next?.chapter_number ?? null
      };
    },

    getSourcedChapter,

    listPriorSourcedOriginalTexts(novelId, chapterNumber) {
      const chapter = getSourcedChapter(novelId, chapterNumber);
      return priorSourcedOriginalTexts.all(chapter.novelId, chapter.chapterNumber).map(({ original_text }) => original_text);
    }
  };
}
