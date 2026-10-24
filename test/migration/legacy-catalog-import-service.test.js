import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createChapterRepository } from '../../src/chapters/chapter-repository.js';
import { openDatabase } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { createLegacyCatalogImportService } from '../../src/migration/legacy-catalog-import-service.js';
import { LegacySnapshotError } from '../../src/migration/legacy-snapshot.js';
import { createNovelRepository } from '../../src/novels/novel-repository.js';
import { createSourceRepository } from '../../src/sources/source-repository.js';

const bookUrl = 'https://www.kujiang.com/book/9';
const sourceOne = 'https://www.kujiang.com/book/9/100';
const sourceTwo = 'https://www.kujiang.com/book/9/101';
const execFile = promisify(execFileCallback);

function cacheKey(sourceUrl, id) {
  return `translation:ollama:${sourceUrl}:${id}:model:prompt:memory`;
}

function fixture(t) {
  const database = openDatabase({ databasePath: ':memory:' });
  migrate(database);
  const clock = () => new Date('2026-10-24T00:00:00.000Z');
  const repositories = {
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    sources: createSourceRepository(database, clock)
  };
  t.after(() => database.close());
  return { database, repositories, service: createLegacyCatalogImportService({ database, repositories, clock }) };
}

function input() {
  return {
    title: 'Legacy War God',
    manifest: {
      formatVersion: 1,
      source: { site: 'kujiang', bookUrl },
      provenanceReady: true,
      chapters: [
        { ordinal: 1, sourceUrl: sourceOne, sourceTitle: '第一章 起程' },
        { ordinal: 2, sourceUrl: sourceTwo, sourceTitle: '第二章 灯火' }
      ]
    },
    translationState: {
      chapters: [
        { sourceUrl: sourceOne, cacheKey: cacheKey(sourceOne, 'one'), updatedAt: '2026-10-01T00:00:00.000Z' },
        { sourceUrl: sourceTwo, cacheKey: cacheKey(sourceTwo, 'two'), updatedAt: '2026-10-02T00:00:00.000Z' }
      ]
    },
    translationCache: {
      [cacheKey(sourceOne, 'one')]: { paragraphs: [{ source: 'Chinese one', translation: 'English one' }] },
      [cacheKey(sourceTwo, 'two')]: { paragraphs: [{ source: 'Chinese two', translation: 'English two' }] }
    }
  };
}

test('imports an ordered source novel and its historical revisions in one transaction', (t) => {
  const { database, repositories, service } = fixture(t);
  const result = service.importManifest(input());

  assert.equal(result.novel.title, 'Legacy War God');
  assert.equal(result.novel.sourceUrl, bookUrl);
  assert.deepEqual({ sourceBookUrl: result.sourceBookUrl, createdNovel: result.createdNovel, importedChapters: result.importedChapters, existingChapters: result.existingChapters }, {
    sourceBookUrl: bookUrl, createdNovel: true, importedChapters: 2, existingChapters: 0
  });
  assert.equal(JSON.stringify(result).includes('Chinese one'), false);
  assert.deepEqual(repositories.chapters.getReaderChapter(result.novel.id, 1), {
    id: repositories.chapters.getReaderChapter(result.novel.id, 1).id,
    novelId: result.novel.id,
    chapterNumber: 1,
    title: '第一章 起程',
    originalText: 'Chinese one',
    sourceUrl: sourceOne,
    hasSourceProvenance: true,
    createdAt: '2026-10-24T00:00:00.000Z',
    translationRevisionId: repositories.chapters.getReaderChapter(result.novel.id, 1).translationRevisionId,
    translatedText: 'English one',
    provider: 'legacy-cache',
    model: 'legacy-cache',
    revision: 1,
    previousChapterNumber: null,
    nextChapterNumber: 2
  });
  assert.equal(database.prepare('select count(*) as count from chapter_sources').get().count, 2);
  assert.equal(database.prepare('select count(*) as count from translation_revisions').get().count, 2);
});

test('is idempotent and appends only new manifest chapters to the same source novel', (t) => {
  const { database, service } = fixture(t);
  const first = service.importManifest(input());
  const second = service.importManifest(input());
  const expanded = input();
  const sourceThree = 'https://www.kujiang.com/book/9/102';
  expanded.manifest.chapters.push({ ordinal: 3, sourceUrl: sourceThree, sourceTitle: '第三章 归途' });
  expanded.translationState.chapters.push({ sourceUrl: sourceThree, cacheKey: cacheKey(sourceThree, 'three') });
  expanded.translationCache[cacheKey(sourceThree, 'three')] = { paragraphs: [{ source: 'Chinese three', translation: 'English three' }] };
  const third = service.importManifest(expanded);

  assert.equal(second.novel.id, first.novel.id);
  assert.deepEqual({ createdNovel: second.createdNovel, importedChapters: second.importedChapters, existingChapters: second.existingChapters }, { createdNovel: false, importedChapters: 0, existingChapters: 2 });
  assert.deepEqual({ createdNovel: third.createdNovel, importedChapters: third.importedChapters, existingChapters: third.existingChapters }, { createdNovel: false, importedChapters: 1, existingChapters: 2 });
  assert.equal(database.prepare('select count(*) as count from novels').get().count, 1);
  assert.equal(database.prepare('select count(*) as count from chapters').get().count, 3);
});

test('rejects incomplete cache before creating a partial novel', (t) => {
  const { database, service } = fixture(t);
  const invalid = input();
  invalid.translationCache[cacheKey(sourceTwo, 'two')] = { paragraphs: [{ source: 'Chinese two', translation: '' }] };

  assert.throws(() => service.importManifest(invalid), LegacySnapshotError);
  assert.equal(database.prepare('select count(*) as count from novels').get().count, 0);
  assert.equal(database.prepare('select count(*) as count from chapters').get().count, 0);
});

test('rejects an unapproved or unsupported manifest before creating a novel', (t) => {
  const { database, service } = fixture(t);
  const invalid = input();
  invalid.manifest.provenanceReady = false;
  assert.throws(() => service.importManifest(invalid), LegacySnapshotError);
  invalid.manifest.provenanceReady = true;
  invalid.manifest.formatVersion = 2;
  assert.throws(() => service.importManifest(invalid), LegacySnapshotError);
  assert.equal(database.prepare('select count(*) as count from novels').get().count, 0);
});

test('rejects a cache row whose raw source URL is not the canonical manifest URL', (t) => {
  const { database, service } = fixture(t);
  const invalid = input();
  const rawSourceUrl = `${sourceOne}?untrusted=1`;
  const rawCacheKey = cacheKey(rawSourceUrl, 'raw');
  invalid.translationState.chapters[0] = { sourceUrl: rawSourceUrl, cacheKey: rawCacheKey };
  delete invalid.translationCache[cacheKey(sourceOne, 'one')];
  invalid.translationCache[rawCacheKey] = { paragraphs: [{ source: 'Chinese one', translation: 'English one' }] };

  assert.throws(() => service.importManifest(invalid), LegacySnapshotError);
  assert.equal(database.prepare('select count(*) as count from novels').get().count, 0);
});

test('imports through the CLI with its reviewed manifest and legacy files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inktrail-legacy-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = input();
  await Promise.all([
    writeFile(join(directory, 'source-map.json'), JSON.stringify({ entries: [] })),
    writeFile(join(directory, 'translation-state.json'), JSON.stringify(payload.translationState)),
    writeFile(join(directory, 'translation-cache.json'), JSON.stringify(payload.translationCache)),
    writeFile(join(directory, 'consistency-memory.json'), JSON.stringify({ terms: [], corrections: [] })),
    writeFile(join(directory, 'manifest.json'), JSON.stringify(payload.manifest))
  ]);

  const databasePath = join(directory, 'inktrail.sqlite');
  const { stdout } = await execFile(process.execPath, [
    new URL('../../scripts/import-legacy-catalog.js', import.meta.url).pathname,
    databasePath,
    directory,
    join(directory, 'manifest.json'),
    payload.title
  ]);
  const result = JSON.parse(stdout);
  const databaseBytes = await readFile(databasePath);

  assert.deepEqual({ sourceBookUrl: result.sourceBookUrl, importedChapters: result.importedChapters }, { sourceBookUrl: bookUrl, importedChapters: 2 });
  assert.ok(databaseBytes.length > 0);
});
