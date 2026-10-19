import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { normalizeKujiangCandidateIdentity } from './kujiang-adapter.js';

const SITE = 'kujiang';
const MAX_IDENTITIES_PER_NOVEL = 4;

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('input must be an object');
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function toIdentity(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    site: row.site,
    canonicalBookUrl: row.canonical_book_url,
    novelTitle: row.novel_title,
    novelTitleAliases: JSON.parse(row.novel_title_aliases_json),
    author: row.author,
    authorAliases: JSON.parse(row.author_aliases_json),
    chapterTitleAliases: JSON.parse(row.chapter_title_aliases_json),
    createdAt: row.created_at
  };
}

function normalizedIdentity(input) {
  const value = requireObject(input);
  const identity = normalizeKujiangCandidateIdentity(value);
  return {
    canonicalBookUrl: identity.canonicalBookUrl,
    novelTitle: identity.novelTitle,
    novelTitleAliases: identity.novelTitleAliases,
    author: identity.author,
    authorAliases: identity.authorAliases,
    chapterTitleAliases: identity.chapterTitleAliases
  };
}

export function createSourceIdentityRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const listByNovel = database.prepare('select * from source_identities where novel_id = ? order by created_at, id');
  const byCanonicalBookUrl = database.prepare('select * from source_identities where canonical_book_url = ?');
  const sourceByCanonicalBookUrl = database.prepare('select novel_id from novel_sources where site = ? and normalized_url = ?');
  const byIdInNovel = database.prepare('select * from source_identities where id = ? and novel_id = ?');
  const countByNovel = database.prepare('select count(*) as count from source_identities where novel_id = ?');
  const insert = database.prepare(`
    insert into source_identities (
      id, novel_id, site, canonical_book_url, novel_title, novel_title_aliases_json,
      author, author_aliases_json, chapter_title_aliases_json, created_at
    ) values (
      @id, @novelId, @site, @canonicalBookUrl, @novelTitle, @novelTitleAliasesJson,
      @author, @authorAliasesJson, @chapterTitleAliasesJson, @createdAt
    )
  `);
  const remove = database.prepare('delete from source_identities where id = ? and novel_id = ?');

  function requireNovel(novelId) {
    const id = requireText(novelId, 'novelId');
    if (!novelExists.get(id)) throw new NotFoundError('novel not found');
    return id;
  }

  function list(novelId) {
    return listByNovel.all(requireNovel(novelId)).map(toIdentity);
  }

  return {
    list,

    listCandidateIdentities(novelId) {
      return list(novelId).map(({ canonicalBookUrl, novelTitle, novelTitleAliases, author, authorAliases, chapterTitleAliases }) => ({
        bookUrl: canonicalBookUrl,
        novelTitle,
        novelTitleAliases,
        author,
        authorAliases,
        chapterTitleAliases
      }));
    },

    create(input) {
      const value = requireObject(input);
      const novelId = requireNovel(value.novelId);
      const identity = normalizedIdentity(value);
      const existing = byCanonicalBookUrl.get(identity.canonicalBookUrl);
      if (existing) {
        if (existing.novel_id !== novelId) throw new ConflictError('source identity already belongs to another novel');
        throw new ConflictError('source identity already exists for novel');
      }
      const sourceOwner = sourceByCanonicalBookUrl.get(SITE, identity.canonicalBookUrl);
      if (sourceOwner && sourceOwner.novel_id !== novelId) {
        throw new ConflictError('source identity already belongs to another novel');
      }
      if (countByNovel.get(novelId).count >= MAX_IDENTITIES_PER_NOVEL) {
        throw new ValidationError(`a novel may have at most ${MAX_IDENTITIES_PER_NOVEL} source identities`);
      }
      const created = {
        id: randomUUID(),
        novelId,
        site: SITE,
        canonicalBookUrl: identity.canonicalBookUrl,
        novelTitle: identity.novelTitle,
        author: identity.author,
        novelTitleAliasesJson: JSON.stringify(identity.novelTitleAliases),
        authorAliasesJson: JSON.stringify(identity.authorAliases),
        chapterTitleAliasesJson: JSON.stringify(identity.chapterTitleAliases),
        createdAt: clock().toISOString()
      };
      try {
        insert.run(created);
      } catch (error) {
        if (error?.message?.includes('source identity limit reached')) {
          throw new ValidationError(`a novel may have at most ${MAX_IDENTITIES_PER_NOVEL} source identities`);
        }
        if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.message?.includes('source_identities.canonical_book_url')) {
          const raced = byCanonicalBookUrl.get(identity.canonicalBookUrl);
          if (raced?.novel_id !== novelId) throw new ConflictError('source identity already belongs to another novel');
          throw new ConflictError('source identity already exists for novel');
        }
        throw error;
      }
      return toIdentity(byIdInNovel.get(created.id, novelId));
    },

    remove({ novelId, identityId }) {
      const normalizedNovelId = requireNovel(novelId);
      const normalizedIdentityId = requireText(identityId, 'identityId');
      if (!byIdInNovel.get(normalizedIdentityId, normalizedNovelId)) throw new NotFoundError('source identity not found');
      remove.run(normalizedIdentityId, normalizedNovelId);
    }
  };
}
