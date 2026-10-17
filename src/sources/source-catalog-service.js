import { createHash } from 'node:crypto';
import { ConflictError, ValidationError } from '../domain/errors.js';

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('input must be an object');
  return value;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(`${name} is required`);
  return value.trim();
}

function canonicalEntries(entries) {
  return entries.map(({ ordinal, externalChapterId, sourceUrl, normalizedUrl, sourceTitle }) => ({
    ordinal,
    externalChapterId,
    sourceUrl,
    normalizedUrl,
    sourceTitle
  }));
}

export function catalogContentSha256(entries) {
  return createHash('sha256').update(JSON.stringify(canonicalEntries(entries))).digest('hex');
}

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

export function createSourceCatalogService({ database, repositories, catalogAdapter }) {
  async function discoverCatalogSnapshot(input) {
    const { novelId, bookUrl } = requireObject(input);
    const normalizedNovelId = requireText(novelId, 'novelId');
    const normalizedBookUrl = requireText(bookUrl, 'bookUrl');
    const novel = repositories.novels.getNovel(normalizedNovelId);
    const fetched = await catalogAdapter.fetchCatalog(normalizedBookUrl);
    const entries = canonicalEntries(fetched.entries);
    const contentSha256 = catalogContentSha256(entries);

    return withinTransaction(database, () => {
      const existingSources = repositories.sources.listNovelSourcesForSite({ novelId: normalizedNovelId, site: fetched.site });
      if (existingSources.some((source) => source.normalizedUrl !== fetched.canonicalBookUrl)) {
        throw new ConflictError('novel already has a different Kujiang book source');
      }
      const source = repositories.sources.createOrGetNovelSource({
        novelId: normalizedNovelId,
        site: fetched.site,
        externalNovelId: fetched.externalNovelId,
        sourceUrl: fetched.canonicalBookUrl,
        normalizedUrl: fetched.canonicalBookUrl,
        title: novel.title
      });
      const existing = repositories.catalogs.findSnapshotByIdentity({
        novelId: normalizedNovelId,
        novelSourceId: source.id,
        contentSha256
      });
      if (existing) return { snapshot: existing, created: false };
      return {
        snapshot: repositories.catalogs.createOrGetSnapshotInTransaction({
          novelId: normalizedNovelId,
          novelSourceId: source.id,
          site: fetched.site,
          canonicalBookUrl: fetched.canonicalBookUrl,
          contentSha256,
          entries
        }),
        created: true
      };
    });
  }

  return {
    async fetchCatalogSnapshot(input) {
      return (await discoverCatalogSnapshot(input)).snapshot;
    },

    discoverCatalogSnapshot
  };
}
