import { NotFoundError, ValidationError } from '../domain/errors.js';

function requireId(value, name) {
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

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('input must be an object');
  }
  return value;
}

function toProgress(row) {
  return {
    novelId: row.novel_id,
    chapterNumber: row.chapter_number,
    updatedAt: row.updated_at
  };
}

export function createProgressRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const chapterExists = database.prepare('select 1 from chapters where novel_id = ? and chapter_number = ?');
  const saveProgress = database.prepare(`
    insert into reading_progress (novel_id, chapter_number, updated_at)
    values (@novelId, @chapterNumber, @updatedAt)
    on conflict(novel_id) do update set chapter_number = excluded.chapter_number, updated_at = excluded.updated_at
  `);
  const progressForNovel = database.prepare('select novel_id, chapter_number, updated_at from reading_progress where novel_id = ?');

  function requireNovel(novelId) {
    const id = requireId(novelId, 'novelId');
    if (!novelExists.get(id)) {
      throw new NotFoundError('novel not found');
    }
    return id;
  }

  return {
    setReadingProgress(input) {
      const { novelId, chapterNumber } = requireObject(input);
      const progress = {
        novelId: requireNovel(novelId),
        chapterNumber: requireChapterNumber(chapterNumber),
        updatedAt: clock().toISOString()
      };
      if (!chapterExists.get(progress.novelId, progress.chapterNumber)) {
        throw new NotFoundError('chapter not found');
      }
      saveProgress.run(progress);
      return progress;
    },

    getReadingProgress(novelId) {
      const row = progressForNovel.get(requireNovel(novelId));
      return row ? toProgress(row) : null;
    }
  };
}
