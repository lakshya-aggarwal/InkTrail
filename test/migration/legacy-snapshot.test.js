import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectLegacySnapshot, LegacySnapshotError, readLegacySnapshot } from '../../src/migration/legacy-snapshot.js';

const novelChapterOne = 'https://novelping.com/book/return-of-the-war-god/chapter-1';
const novelChapterTwo = 'https://novelping.com/book/return-of-the-war-god/chapter-2';
const sourceOne = 'https://www.kujiang.com/book/9/100';
const sourceTwo = 'https://www.kujiang.com/book/9/101';

function cacheKey(sourceUrl, id) {
  return `translation:ollama:${sourceUrl}:${id}:model:prompt:memory`;
}

function snapshot() {
  return {
    sourceMap: {
      entries: [
        { novelUrl: novelChapterOne, sourceUrl: sourceOne, nextSourceUrl: sourceTwo },
        { novelUrl: novelChapterTwo, sourceUrl: sourceTwo, previousSourceUrl: sourceOne }
      ]
    },
    translationState: {
      chapters: [
        { sourceUrl: sourceOne, cacheKey: cacheKey(sourceOne, 'one') },
        { sourceUrl: sourceTwo, cacheKey: cacheKey(sourceTwo, 'two') }
      ]
    },
    translationCache: {
      [cacheKey(sourceOne, 'one')]: { paragraphs: [{ source: 'Chinese one', translation: 'English one' }] },
      [cacheKey(sourceTwo, 'two')]: { paragraphs: [{ source: 'Chinese two', translation: 'English two' }] }
    },
    consistencyMemory: {
      terms: [{ source: 'sect junior', translation: 'junior brother' }],
      corrections: [{ from: 'younger brother', to: 'junior brother' }]
    }
  };
}

test('reports a grouped, source-faithful legacy snapshot without exposing chapter text', () => {
  const report = inspectLegacySnapshot(snapshot());

  assert.deepEqual(report, {
    formatVersion: 1,
    novels: [{
      key: 'https://novelping.com/book/return-of-the-war-god',
      sourceBookUrls: ['https://www.kujiang.com/book/9'],
      sourceMappings: 2,
      duplicateSourceMappings: 0,
      orphanSourceLinks: 0,
      translationRows: 2,
      cachedTranslationCandidates: 2,
      completeSourceTextCandidates: 2,
      historicalRevisionCandidates: 2,
      sourceRefetchRequired: 0
    }],
    consistencyMemory: { terms: 1, corrections: 1, requiresNovelAssignment: true },
    issues: [{ code: 'global_memory_requires_novel_assignment', count: 1 }]
  });
  assert.equal(JSON.stringify(report).includes('Chinese one'), false);
  assert.equal(JSON.stringify(report).includes('English one'), false);
});

test('reports migration blockers instead of guessing through bad legacy links or cache data', () => {
  const data = snapshot();
  data.sourceMap.entries.push({ novelUrl: novelChapterOne, sourceUrl: sourceOne, nextSourceUrl: 'https://www.kujiang.com/book/9/999' });
  data.translationState.chapters.push({ sourceUrl: sourceTwo, cacheKey: 'missing' });
  data.translationCache[cacheKey(sourceTwo, 'two')] = { paragraphs: [{ source: '', translation: 'English two' }] };

  const report = inspectLegacySnapshot(data);
  assert.deepEqual(report.novels[0], {
    key: 'https://novelping.com/book/return-of-the-war-god',
    sourceBookUrls: ['https://www.kujiang.com/book/9'],
    sourceMappings: 2,
    duplicateSourceMappings: 1,
    orphanSourceLinks: 1,
    translationRows: 3,
    cachedTranslationCandidates: 2,
    completeSourceTextCandidates: 1,
    historicalRevisionCandidates: 1,
    sourceRefetchRequired: 2
  });
  assert.deepEqual(report.issues, [
    { code: 'duplicate_source_mapping', count: 1 },
    { code: 'global_memory_requires_novel_assignment', count: 1 },
    { code: 'incomplete_cached_source_text', count: 1 },
    { code: 'incomplete_cached_translation', count: 1 },
    { code: 'missing_translation_cache', count: 1 },
    { code: 'orphan_source_link', count: 1 }
  ]);
});

test('rejects unowned rows, unsafe URLs, cache-key mismatches, and normalized navigation duplicates', () => {
  const unowned = snapshot();
  unowned.sourceMap.entries = [];
  const report = inspectLegacySnapshot(unowned);
  assert.deepEqual(report.novels, []);
  assert.equal(report.issues.find(({ code }) => code === 'unassigned_translation_row').count, 2);

  const unsafe = snapshot();
  unsafe.sourceMap.entries = [{
    novelUrl: 'ftp://novelping.com/book/not-a-book/chapter',
    sourceUrl: 'http://www.kujiang.com/book/not-a-number/chapter'
  }];
  assert.equal(inspectLegacySnapshot(unsafe).issues.find(({ code }) => code === 'invalid_source_mapping').count, 1);

  const mismatch = snapshot();
  mismatch.translationState.chapters[0].cacheKey = cacheKey(sourceTwo, 'wrong-source');
  mismatch.translationCache[cacheKey(sourceTwo, 'wrong-source')] = mismatch.translationCache[cacheKey(sourceOne, 'one')];
  const mismatchReport = inspectLegacySnapshot(mismatch);
  assert.equal(mismatchReport.novels[0].historicalRevisionCandidates, 1);
  assert.equal(mismatchReport.novels[0].sourceRefetchRequired, 1);
  assert.equal(mismatchReport.issues.find(({ code }) => code === 'mismatched_translation_cache').count, 1);

  const normalized = snapshot();
  normalized.sourceMap.entries[0].nextSourceUrl = `${sourceTwo}/?ignored=1#fragment`;
  normalized.sourceMap.entries.push({ novelUrl: novelChapterTwo, sourceUrl: `${sourceTwo}/` });
  const normalizedReport = inspectLegacySnapshot(normalized);
  assert.equal(normalizedReport.novels[0].orphanSourceLinks, 0);
  assert.equal(normalizedReport.novels[0].duplicateSourceMappings, 1);
});

test('reads the exact legacy file set and rejects malformed snapshots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'inktrail-legacy-snapshot-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(directory, { recursive: true, force: true })));
  const data = snapshot();
  await Promise.all([
    writeFile(join(directory, 'source-map.json'), JSON.stringify(data.sourceMap)),
    writeFile(join(directory, 'translation-state.json'), JSON.stringify(data.translationState)),
    writeFile(join(directory, 'translation-cache.json'), JSON.stringify(data.translationCache)),
    writeFile(join(directory, 'consistency-memory.json'), JSON.stringify(data.consistencyMemory))
  ]);

  assert.equal((await readLegacySnapshot(directory)).novels[0].translationRows, 2);
  assert.throws(
    () => inspectLegacySnapshot({ ...data, sourceMap: { entries: {} } }),
    (error) => error instanceof LegacySnapshotError && error.message === 'source-map.json entries must be an array.'
  );
});
