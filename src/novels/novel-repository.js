import { randomUUID } from 'node:crypto';
import { NotFoundError, ValidationError } from '../domain/errors.js';

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

function sourceUrl(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !URL.canParse(value)) {
    throw new ValidationError('sourceUrl must be an absolute URL');
  }
  return value;
}

function toNovel(row) {
  return {
    id: row.id,
    title: row.title,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createNovelRepository(database, clock) {
  const insertNovel = database.prepare(`
    insert into novels (id, title, source_url, created_at, updated_at)
    values (@id, @title, @sourceUrl, @createdAt, @updatedAt)
  `);
  const listNovelRows = database.prepare('select id, title, source_url, created_at, updated_at from novels order by created_at, id');
  const getNovelRow = database.prepare('select id, title, source_url, created_at, updated_at from novels where id = ?');

  return {
    createNovel(input) {
      const { title, sourceUrl: inputSourceUrl } = requireObject(input);
      if (typeof title !== 'string' || title.trim().length === 0) {
        throw new ValidationError('title is required');
      }

      const now = clock().toISOString();
      const novel = {
        id: randomUUID(),
        title: title.trim(),
        sourceUrl: sourceUrl(inputSourceUrl),
        createdAt: now,
        updatedAt: now
      };
      insertNovel.run(novel);
      return novel;
    },

    listNovels() {
      return listNovelRows.all().map(toNovel);
    },

    getNovel(novelId) {
      const row = getNovelRow.get(requireId(novelId, 'novelId'));
      if (!row) {
        throw new NotFoundError('novel not found');
      }
      return toNovel(row);
    }
  };
}
