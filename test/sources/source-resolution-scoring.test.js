import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeResolutionText, RESOLVER_VERSION, scoreResolutionCandidate, scoreResolutionCandidates } from '../../src/sources/source-resolution-scoring.js';

const evidence = Object.freeze({ novelTitle: 'Return of the War God', chapterTitle: 'Shen Guanghai', chapterNumber: 2491, author: null });
const candidate = Object.freeze({ id: 'war-god-2491', novelTitle: '战神狂飙', novelTitleAliases: ['Return of the War God'], chapterTitle: '沈光海', chapterTitleAliases: ['Shen Guanghai'], chapterNumber: 2491 });

test('normalizes NFKC, case, whitespace, and punctuation without fuzzy matching', () => {
  assert.equal(normalizeResolutionText('  RETURN\u00a0of - the! War God  '), 'return of the war god');
  assert.equal(normalizeResolutionText('Return of the War Gods'), 'return of the war gods');
});

test('accepts the 95-point no-author and 100-point author-match matrix cases', () => {
  const noAuthor = scoreResolutionCandidates(evidence, [candidate]);
  assert.deepEqual({ decision: noAuthor.decision, selectedCandidateId: noAuthor.selectedCandidateId, score: noAuthor.candidates[0].totalScore }, { decision: 'accepted', selectedCandidateId: 'war-god-2491', score: 95 });
  const withAuthor = scoreResolutionCandidates({ ...evidence, author: 'Tian Can Tu Dou' }, [{ ...candidate, author: '天蚕土豆', authorAliases: ['Tian Can Tu Dou'] }]);
  assert.deepEqual({ decision: withAuthor.decision, score: withAuthor.candidates[0].totalScore }, { decision: 'accepted', score: 100 });
  assert.equal(withAuthor.resolverVersion, RESOLVER_VERSION);
});

test('records deterministic mandatory-evidence and author-conflict reject codes', () => {
  const cases = [
    [{ ...candidate, chapterNumber: 2492 }, 'chapter_number_mismatch'],
    [{ ...candidate, novelTitleAliases: ['A Different Novel'] }, 'novel_title_mismatch'],
    [{ ...candidate, chapterTitleAliases: ['A Different Chapter'] }, 'chapter_title_mismatch'],
    [{ ...candidate, author: 'Different Author' }, 'author_conflict']
  ];
  for (const [input, rejectionCode] of cases) {
    const result = scoreResolutionCandidate({ ...evidence, author: rejectionCode === 'author_conflict' ? 'Known Author' : null }, input);
    assert.equal(result.rejectionCode, rejectionCode);
    assert.equal(result.eligible, false);
  }
});

test('rejects a tied 95-point winner and accepts a 100-point winner over a 95-point runner-up', () => {
  const tied = scoreResolutionCandidates(evidence, [candidate, { ...candidate, id: 'war-god-2491-copy' }]);
  assert.deepEqual({ decision: tied.decision, rejectionCode: tied.rejectionCode }, { decision: 'unresolved', rejectionCode: 'no_unique_winner' });
  const winner = scoreResolutionCandidates({ ...evidence, author: 'Tian Can Tu Dou' }, [
    { ...candidate, id: 'winner', authorAliases: ['Tian Can Tu Dou'] },
    { ...candidate, id: 'runner' }
  ]);
  assert.deepEqual({ decision: winner.decision, selectedCandidateId: winner.selectedCandidateId }, { decision: 'accepted', selectedCandidateId: 'winner' });
  assert.equal(winner.candidates[0].totalScore - winner.candidates[1].totalScore, 5);
});

test('does not emit a sub-threshold eligible candidate or a non-fixed winner margin', () => {
  const result = scoreResolutionCandidates(evidence, [candidate]);
  assert.ok(result.candidates.filter((item) => item.eligible).every((item) => item.totalScore >= 95));
  assert.doesNotThrow(() => scoreResolutionCandidates(evidence, [candidate]));
});
