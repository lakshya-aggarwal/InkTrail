import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyCatalogReconciliationManifest } from '../../src/migration/legacy-catalog-reconciliation.js';

const bookUrl = 'https://www.kujiang.com/book/9';
const sourceOne = 'https://www.kujiang.com/book/9/100';
const sourceTwo = 'https://www.kujiang.com/book/9/101';

function cacheKey(sourceUrl, id) {
  return `translation:ollama:${sourceUrl}:${id}:model:prompt:memory`;
}

function data() {
  return {
    catalog: {
      canonicalBookUrl: bookUrl,
      entries: [
        { ordinal: 1, sourceUrl: sourceOne, sourceTitle: '第一章 起程' },
        { ordinal: 2, sourceUrl: sourceTwo, sourceTitle: '第二章 灯火' }
      ]
    },
    translationState: {
      chapters: [
        { sourceUrl: sourceTwo, cacheKey: cacheKey(sourceTwo, 'two') },
        { sourceUrl: sourceOne, cacheKey: cacheKey(sourceOne, 'one') }
      ]
    },
    translationCache: {
      [cacheKey(sourceOne, 'one')]: { paragraphs: [{ source: 'Chinese one', translation: 'English one' }] },
      [cacheKey(sourceTwo, 'two')]: { paragraphs: [{ source: 'Chinese two', translation: 'English two' }] }
    }
  };
}

test('creates an ordered, source-only manifest from exact catalog and legacy source matches', () => {
  const manifest = createLegacyCatalogReconciliationManifest(data());

  assert.deepEqual(manifest, {
    formatVersion: 1,
    source: { site: 'kujiang', bookUrl },
    provenanceReady: true,
    chapters: [
      { ordinal: 1, sourceUrl: sourceOne, sourceTitle: '第一章 起程' },
      { ordinal: 2, sourceUrl: sourceTwo, sourceTitle: '第二章 灯火' }
    ],
    cacheHealth: { rows: 2, completeSourceText: 2, completeTranslations: 2, refetchRequired: 0 },
    issues: []
  });
  assert.equal(JSON.stringify(manifest).includes('Chinese one'), false);
  assert.equal(JSON.stringify(manifest).includes('English one'), false);
});

test('blocks ambiguous or unlisted legacy sources but preserves cache-health evidence', () => {
  const snapshot = data();
  snapshot.translationState.chapters.push({ sourceUrl: sourceOne, cacheKey: cacheKey(sourceOne, 'other') });
  snapshot.translationCache[cacheKey(sourceOne, 'other')] = { paragraphs: [{ source: 'Chinese one', translation: '' }] };
  snapshot.translationState.chapters.push({ sourceUrl: 'https://www.kujiang.com/book/9/102', cacheKey: cacheKey('https://www.kujiang.com/book/9/102', 'three') });

  const manifest = createLegacyCatalogReconciliationManifest(snapshot);

  assert.equal(manifest.provenanceReady, false);
  assert.deepEqual(manifest.chapters.map(({ ordinal }) => ordinal), [1, 2]);
  assert.deepEqual(manifest.cacheHealth, { rows: 2, completeSourceText: 2, completeTranslations: 2, refetchRequired: 0 });
  assert.deepEqual(manifest.issues, [
    { code: 'duplicate_translation_source', count: 1 },
    { code: 'translation_source_missing_from_catalog', count: 1 }
  ]);
});

test('reports but does not let another Kujiang book block the selected catalog', () => {
  const snapshot = data();
  const otherBookSource = 'https://www.kujiang.com/book/10/200';
  snapshot.translationState.chapters.push({ sourceUrl: otherBookSource, cacheKey: cacheKey(otherBookSource, 'other-book') });
  snapshot.translationCache[cacheKey(otherBookSource, 'other-book')] = { paragraphs: [{ source: 'Chinese other', translation: 'English other' }] };

  const manifest = createLegacyCatalogReconciliationManifest(snapshot);

  assert.equal(manifest.provenanceReady, true);
  assert.deepEqual(manifest.chapters.map(({ sourceUrl }) => sourceUrl), [sourceOne, sourceTwo]);
  assert.deepEqual(manifest.issues, [{ code: 'translation_source_outside_catalog_book', count: 1 }]);
});
