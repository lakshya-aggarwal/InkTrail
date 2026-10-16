import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';

function requireObject(value, name = 'input') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${name} must be an object`);
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function requireSha256(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidationError('contentSha256 must be a lowercase SHA-256 digest');
  return value;
}

function toCatalog(row) {
  return {
    id: row.id,
    novelId: row.novel_id,
    novelSourceId: row.novel_source_id,
    site: row.site,
    canonicalBookUrl: row.canonical_book_url,
    contentSha256: row.content_sha256,
    entryCount: row.entry_count,
    createdAt: row.created_at
  };
}

function toEntry(row) {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    novelId: row.novel_id,
    ordinal: row.ordinal,
    externalChapterId: row.external_chapter_id,
    sourceUrl: row.source_url,
    normalizedUrl: row.normalized_url,
    sourceTitle: row.source_title,
    createdAt: row.created_at
  };
}

function normalizeEntries(value) {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError('entries must contain at least one entry');
  const sourceUrls = new Set();
  const normalizedUrls = new Set();
  return value.map((entry, index) => {
    const input = requireObject(entry, 'entry');
    const ordinal = input.ordinal;
    if (!Number.isSafeInteger(ordinal) || ordinal !== index + 1) {
      throw new ValidationError('entries must have strictly ascending positive ordinals');
    }
    const normalized = {
      ordinal,
      externalChapterId: requireText(input.externalChapterId, 'externalChapterId'),
      sourceUrl: requireText(input.sourceUrl, 'sourceUrl'),
      normalizedUrl: requireText(input.normalizedUrl, 'normalizedUrl'),
      sourceTitle: requireText(input.sourceTitle, 'sourceTitle')
    };
    if (sourceUrls.has(normalized.sourceUrl) || normalizedUrls.has(normalized.normalizedUrl)) {
      throw new ValidationError('entries must have unique source URLs');
    }
    sourceUrls.add(normalized.sourceUrl);
    normalizedUrls.add(normalized.normalizedUrl);
    return normalized;
  });
}

export function createSourceCatalogRepository(database, clock) {
  const novelExists = database.prepare('select 1 from novels where id = ?');
  const novelSource = database.prepare('select * from novel_sources where id = ?');
  const catalogByIdentity = database.prepare('select * from source_catalogs where novel_source_id = ? and content_sha256 = ?');
  const catalogInNovel = database.prepare('select * from source_catalogs where id = ? and novel_id = ?');
  const entryInCatalog = database.prepare('select * from source_catalog_entries where id = ? and catalog_id = ? and novel_id = ?');
  const entriesForCatalog = database.prepare('select * from source_catalog_entries where catalog_id = ? order by ordinal');
  const insertCatalog = database.prepare(`
    insert into source_catalogs (
      id, novel_id, novel_source_id, site, canonical_book_url, content_sha256, entry_count, created_at
    ) values (
      @id, @novelId, @novelSourceId, @site, @canonicalBookUrl, @contentSha256, @entryCount, @createdAt
    )
  `);
  const insertEntry = database.prepare(`
    insert into source_catalog_entries (
      id, catalog_id, novel_id, ordinal, external_chapter_id, source_url, normalized_url, source_title, created_at
    ) values (
      @id, @catalogId, @novelId, @ordinal, @externalChapterId, @sourceUrl, @normalizedUrl, @sourceTitle, @createdAt
    )
  `);

  function withinTransaction(action) {
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

  function getSnapshot(novelId, catalogId) {
    const catalog = catalogInNovel.get(requireText(catalogId, 'catalogId'), requireText(novelId, 'novelId'));
    if (!catalog) throw new NotFoundError('source catalog not found');
    return { catalog: toCatalog(catalog), entries: entriesForCatalog.all(catalog.id).map(toEntry) };
  }

  function createOrGetSnapshotInTransaction(input) {
    const { novelId, novelSourceId, site, canonicalBookUrl, contentSha256, entries } = requireObject(input);
    const normalizedNovelId = requireText(novelId, 'novelId');
    const normalizedSourceId = requireText(novelSourceId, 'novelSourceId');
    const normalizedSite = requireText(site, 'site');
    const normalizedBookUrl = requireText(canonicalBookUrl, 'canonicalBookUrl');
    const normalizedHash = requireSha256(contentSha256);
    const normalizedEntries = normalizeEntries(entries);
    if (!novelExists.get(normalizedNovelId)) throw new NotFoundError('novel not found');

    const source = novelSource.get(normalizedSourceId);
    if (!source || source.novel_id !== normalizedNovelId || source.site !== normalizedSite || source.normalized_url !== normalizedBookUrl) {
      throw new ConflictError('source catalog must use the novel canonical book source');
    }
    const existing = catalogByIdentity.get(normalizedSourceId, normalizedHash);
    if (existing) return getSnapshot(normalizedNovelId, existing.id);

    const now = clock().toISOString();
    const catalog = {
      id: randomUUID(),
      novelId: normalizedNovelId,
      novelSourceId: normalizedSourceId,
      site: normalizedSite,
      canonicalBookUrl: normalizedBookUrl,
      contentSha256: normalizedHash,
      entryCount: normalizedEntries.length,
      createdAt: now
    };
    insertCatalog.run(catalog);
    for (const entry of normalizedEntries) {
      insertEntry.run({ id: randomUUID(), catalogId: catalog.id, novelId: catalog.novelId, ...entry, createdAt: now });
    }
    return getSnapshot(normalizedNovelId, catalog.id);
  }

  return {
    createOrGetSnapshot(input) {
      return withinTransaction(() => createOrGetSnapshotInTransaction(input));
    },

    createOrGetSnapshotInTransaction,

    getSnapshot,

    getEntry(input) {
      const { novelId, catalogId, catalogEntryId } = requireObject(input);
      const row = entryInCatalog.get(requireText(catalogEntryId, 'catalogEntryId'), requireText(catalogId, 'catalogId'), requireText(novelId, 'novelId'));
      if (!row) throw new NotFoundError('source catalog entry not found');
      return toEntry(row);
    },

    listSnapshots(novelId) {
      const id = requireText(novelId, 'novelId');
      if (!novelExists.get(id)) throw new NotFoundError('novel not found');
      return database.prepare('select * from source_catalogs where novel_id = ? order by created_at desc, id desc').all(id).map(toCatalog);
    }
  };
}
