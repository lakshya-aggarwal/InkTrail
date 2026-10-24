import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('input must be an object');
  }
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value.trim();
}

function optionalText(value, name) {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, name);
}

function toNovelSource(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    site: row.site,
    externalNovelId: row.external_novel_id,
    sourceUrl: row.source_url,
    normalizedUrl: row.normalized_url,
    title: row.title,
    selectedAt: row.selected_at,
    createdAt: row.created_at
  };
}

function toChapterSource(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterId: row.chapter_id,
    novelSourceId: row.novel_source_id,
    site: row.site,
    externalChapterId: row.external_chapter_id,
    sourceUrl: row.source_url,
    normalizedUrl: row.normalized_url,
    sourceTitle: row.source_title,
    previousSourceUrl: row.previous_source_url,
    nextSourceUrl: row.next_source_url,
    fetchedAt: row.fetched_at,
    contentSha256: row.content_sha256,
    createdAt: row.created_at
  };
}

export function createSourceRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const novelSourceById = database.prepare('select * from novel_sources where id = ?');
  const novelSourceByIdentity = database.prepare('select * from novel_sources where novel_id = ? and site = ? and external_novel_id = ?');
  const novelSourcesByNovelAndSite = database.prepare('select * from novel_sources where novel_id = ? and site = ? order by created_at, id');
  const novelSourceByCanonicalUrl = database.prepare('select * from novel_sources where site = ? and normalized_url = ?');
  const insertNovelSource = database.prepare(`
    insert into novel_sources (id, novel_id, site, external_novel_id, source_url, normalized_url, title, selected_at, created_at)
    values (@id, @novelId, @site, @externalNovelId, @sourceUrl, @normalizedUrl, @title, @selectedAt, @createdAt)
  `);
  const chapterByNovel = database.prepare('select 1 from chapters where id = ? and novel_id = ?');
  const chapterSourceByCanonicalUrl = database.prepare('select * from chapter_sources where site = ? and normalized_url = ?');
  const chapterSourceByChapterAndSite = database.prepare('select * from chapter_sources where chapter_id = ? and site = ?');
  const chapterSourceByExternalIdentity = database.prepare('select * from chapter_sources where site = ? and external_chapter_id = ?');
  const chapterSourceForNovelByCanonicalUrl = database.prepare('select * from chapter_sources where novel_id = ? and site = ? and normalized_url = ?');
  const insertChapterSource = database.prepare(`
    insert into chapter_sources (
      id, novel_id, chapter_id, novel_source_id, site, external_chapter_id,
      source_url, normalized_url, source_title, previous_source_url,
      next_source_url, fetched_at, content_sha256, created_at
    ) values (
      @id, @novelId, @chapterId, @novelSourceId, @site, @externalChapterId,
      @sourceUrl, @normalizedUrl, @sourceTitle, @previousSourceUrl,
      @nextSourceUrl, @fetchedAt, @contentSha256, @createdAt
    )
  `);

  return {
    createOrGetNovelSource(input) {
      const { novelId, site, externalNovelId, sourceUrl, normalizedUrl, title } = requireObject(input);
      const novelSource = {
        novelId: requireText(novelId, 'novelId'),
        site: requireText(site, 'site'),
        externalNovelId: requireText(externalNovelId, 'externalNovelId'),
        sourceUrl: requireText(sourceUrl, 'sourceUrl'),
        normalizedUrl: requireText(normalizedUrl, 'normalizedUrl'),
        title: optionalText(title, 'title')
      };
      if (!novelExists.get(novelSource.novelId)) {
        throw new NotFoundError('novel not found');
      }

      const atCanonicalUrl = novelSourceByCanonicalUrl.get(novelSource.site, novelSource.normalizedUrl);
      if (atCanonicalUrl) {
        if (atCanonicalUrl.novel_id !== novelSource.novelId || atCanonicalUrl.external_novel_id !== novelSource.externalNovelId) {
          throw new ConflictError('source novel already belongs to another novel');
        }
        return toNovelSource(atCanonicalUrl);
      }

      const atIdentity = novelSourceByIdentity.get(novelSource.novelId, novelSource.site, novelSource.externalNovelId);
      if (atIdentity) {
        throw new ConflictError('source novel identity already has a different canonical URL');
      }

      const now = clock().toISOString();
      const created = { id: randomUUID(), ...novelSource, selectedAt: now, createdAt: now };
      insertNovelSource.run(created);
      return created;
    },

    listNovelSourcesForSite(input) {
      const { novelId, site } = requireObject(input);
      const normalizedNovelId = requireText(novelId, 'novelId');
      if (!novelExists.get(normalizedNovelId)) throw new NotFoundError('novel not found');
      return novelSourcesByNovelAndSite.all(normalizedNovelId, requireText(site, 'site')).map(toNovelSource);
    },

    findNovelSourceByCanonicalUrl(input) {
      const { site, normalizedUrl } = requireObject(input);
      const row = novelSourceByCanonicalUrl.get(requireText(site, 'site'), requireText(normalizedUrl, 'normalizedUrl'));
      return row ? toNovelSource(row) : null;
    },

    createChapterSource(input) {
      const {
        novelId, chapterId, novelSourceId, site, externalChapterId, sourceUrl,
        normalizedUrl, sourceTitle, previousSourceUrl, nextSourceUrl, fetchedAt,
        contentSha256
      } = requireObject(input);
      const chapterSource = {
        novelId: requireText(novelId, 'novelId'),
        chapterId: requireText(chapterId, 'chapterId'),
        novelSourceId: requireText(novelSourceId, 'novelSourceId'),
        site: requireText(site, 'site'),
        externalChapterId: requireText(externalChapterId, 'externalChapterId'),
        sourceUrl: requireText(sourceUrl, 'sourceUrl'),
        normalizedUrl: requireText(normalizedUrl, 'normalizedUrl'),
        sourceTitle: requireText(sourceTitle, 'sourceTitle'),
        previousSourceUrl: optionalText(previousSourceUrl, 'previousSourceUrl'),
        nextSourceUrl: optionalText(nextSourceUrl, 'nextSourceUrl'),
        fetchedAt: requireText(fetchedAt, 'fetchedAt'),
        contentSha256: requireText(contentSha256, 'contentSha256')
      };
      const atCanonicalUrl = chapterSourceByCanonicalUrl.get(chapterSource.site, chapterSource.normalizedUrl);
      if (atCanonicalUrl) {
        if (atCanonicalUrl.novel_id !== chapterSource.novelId || atCanonicalUrl.chapter_id !== chapterSource.chapterId || atCanonicalUrl.content_sha256 !== chapterSource.contentSha256) {
          throw new ConflictError('source chapter mapping conflicts with existing provenance');
        }
        return toChapterSource(atCanonicalUrl);
      }

      if (!chapterByNovel.get(chapterSource.chapterId, chapterSource.novelId)) {
        throw new ConflictError('chapter does not belong to novel');
      }
      const novelSource = novelSourceById.get(chapterSource.novelSourceId);
      if (!novelSource || novelSource.novel_id !== chapterSource.novelId) {
        throw new ConflictError('source novel does not belong to novel');
      }
      if (chapterSourceByChapterAndSite.get(chapterSource.chapterId, chapterSource.site) || chapterSourceByExternalIdentity.get(chapterSource.site, chapterSource.externalChapterId)) {
        throw new ConflictError('source chapter mapping already exists');
      }

      const created = { id: randomUUID(), ...chapterSource, createdAt: clock().toISOString() };
      insertChapterSource.run(created);
      return created;
    },

    getChapterSource(input) {
      const { novelId, site, normalizedUrl } = requireObject(input);
      const row = chapterSourceForNovelByCanonicalUrl.get(
        requireText(novelId, 'novelId'),
        requireText(site, 'site'),
        requireText(normalizedUrl, 'normalizedUrl')
      );
      return row ? toChapterSource(row) : null;
    }
  };
}
