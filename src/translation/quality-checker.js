const CHINESE = /[\u3400-\u9fff]/;

function sourceSegments(originalChinese) {
  if (typeof originalChinese !== 'string') {
    return [];
  }
  return originalChinese.split(/\n\s*\n/).map((segment) => segment.trim()).filter(Boolean);
}

function normalizedProse(value) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

export function checkTranslationQuality({ originalChinese, paragraphs }) {
  const source = sourceSegments(originalChinese);
  const translated = Array.isArray(paragraphs) ? paragraphs : [];
  const findings = [];
  const seen = new Map();

  for (let index = 0; index < translated.length; index += 1) {
    const paragraph = translated[index];
    const number = index + 1;
    if (typeof paragraph !== 'string' || paragraph.trim().length === 0 || /\r|\n/.test(paragraph)) {
      findings.push({ kind: 'malformed_paragraph', details: `paragraph ${number} is empty or contains a line break` });
      continue;
    }
    if (CHINESE.test(paragraph)) {
      findings.push({ kind: 'chinese_leakage', details: `paragraph ${number} contains Chinese characters` });
    }
    const normalized = normalizedProse(paragraph);
    if (seen.has(normalized)) {
      findings.push({ kind: 'repeated_prose', details: `paragraph ${number} repeats paragraph ${seen.get(normalized)}` });
    } else {
      seen.set(normalized, number);
    }
  }

  for (let index = 0; index < source.length; index += 1) {
    if (typeof translated[index] !== 'string' || translated[index].trim().length === 0) {
      findings.push({ kind: 'source_segment_gap', details: `source segment ${index + 1} has no translation` });
    }
  }
  if (translated.length > source.length) {
    findings.push({ kind: 'malformed_paragraph', details: 'translation has more paragraphs than source segments' });
  }
  return findings;
}
