import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTranslationQuality } from '../../src/translation/quality-checker.js';

test('flags Chinese leakage and repeated prose deterministically', () => {
  assert.deepEqual(checkTranslationQuality({
    originalChinese: '第一段。\n\n第二段。\n\n第三段。',
    paragraphs: ['The same prose.', 'The same prose.', 'English 中文']
  }), [
    { kind: 'repeated_prose', details: 'paragraph 2 repeats paragraph 1' },
    { kind: 'chinese_leakage', details: 'paragraph 3 contains Chinese characters' }
  ]);
});

test('flags malformed paragraphs and gaps for source segments without a translation', () => {
  assert.deepEqual(checkTranslationQuality({
    originalChinese: '第一段。\n\n第二段。\n\n第三段。',
    paragraphs: ['A complete paragraph.', '', 'Third line\ncontinued.']
  }), [
    { kind: 'malformed_paragraph', details: 'paragraph 2 is empty or contains a line break' },
    { kind: 'malformed_paragraph', details: 'paragraph 3 is empty or contains a line break' },
    { kind: 'source_segment_gap', details: 'source segment 2 has no translation' }
  ]);
});
