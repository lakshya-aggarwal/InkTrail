import { createHash } from 'node:crypto';
import { SourceFetchError, ValidationError } from '../domain/errors.js';
import { normalizeResolutionText, RESOLVER_VERSION } from './source-resolution-scoring.js';

const SITE = 'novelping';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const HTTP_TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const HTTP_QUOTED_STRING = '"(?:[\\t !#-\\[\\]-~]|\\\\[\\t !-~])*"';
const HTTP_OPTIONAL_WHITESPACE = '[ \\t]*';
const HTML_CONTENT_TYPE = new RegExp(`^${HTTP_OPTIONAL_WHITESPACE}text/html${HTTP_OPTIONAL_WHITESPACE}(?:;${HTTP_OPTIONAL_WHITESPACE}${HTTP_TOKEN}${HTTP_OPTIONAL_WHITESPACE}=${HTTP_OPTIONAL_WHITESPACE}(?:${HTTP_TOKEN}|${HTTP_QUOTED_STRING})${HTTP_OPTIONAL_WHITESPACE})*$`, 'i');

function isHtmlContentType(value) {
  return typeof value === 'string' && HTML_CONTENT_TYPE.test(value);
}

function attributesFrom(source) {
  const attributes = {};
  const pattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    const normalized = key.toLowerCase();
    if (normalized in named) return named[normalized];
    const codePoint = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
  });
}

function textFromHtml(fragment) {
  return decodeEntities(fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function renderedHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
}

function elementContent(html, opening) {
  const tag = opening[1].toLowerCase();
  const contentStart = opening.index + opening[0].length;
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  tags.lastIndex = contentStart;
  let depth = 1;
  for (const candidate of html.matchAll(tags)) {
    if (candidate.index < contentStart) continue;
    if (candidate[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return html.slice(contentStart, candidate.index);
    } else if (!candidate[0].endsWith('/>')) {
      depth += 1;
    }
  }
  return null;
}

function metadataValues(html, dataAttribute) {
  const values = [];
  const openings = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  for (const opening of html.matchAll(openings)) {
    const attributes = attributesFrom(opening[2]);
    if (!(dataAttribute in attributes)) continue;
    const value = opening[1].toLowerCase() === 'meta'
      ? attributes.content
      : attributes[dataAttribute] || elementContent(html, opening);
    values.push(textFromHtml(value ?? ''));
  }
  return values;
}

function requireOneMetadataValue(html, dataAttribute, fieldName) {
  const values = metadataValues(html, dataAttribute);
  if (values.length !== 1 || !values[0]) {
    throw new ValidationError(`NovelPing source HTML has ambiguous or missing ${fieldName}`);
  }
  return values[0];
}

function optionalMetadataValue(html, dataAttribute, fieldName) {
  const values = metadataValues(html, dataAttribute);
  if (values.length === 0) return null;
  if (values.length !== 1 || !values[0]) {
    throw new ValidationError(`NovelPing source HTML has ambiguous ${fieldName}`);
  }
  return values[0];
}

function evidenceHash(evidence) {
  return createHash('sha256').update(JSON.stringify({
    canonicalNovelPingUrl: evidence.canonicalNovelPingUrl,
    novelTitle: evidence.novelTitle,
    author: evidence.author,
    chapterNumber: evidence.chapterNumber,
    chapterTitle: evidence.chapterTitle,
    extractorVersion: evidence.extractorVersion
  })).digest('hex');
}

function readChunk(reader, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => {
      reader.cancel().catch(() => {});
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

async function readHtmlBody(response, maxBodyBytes, signal) {
  const contentLength = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isInteger(contentLength) && contentLength > maxBodyBytes) {
    throw new Error('source response exceeds body limit');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBodyBytes) throw new Error('source response exceeds body limit');
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBodyBytes) {
        await reader.cancel();
        throw new Error('source response exceeds body limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchHtml(fetchClient, canonicalUrl, timeoutMs, maxBodyBytes) {
  let currentUrl = canonicalUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchClient(currentUrl, {
          headers: { accept: 'text/html' },
          redirect: 'manual',
          signal: controller.signal
        });
      } catch (error) {
        throw new SourceFetchError('NovelPing source request failed', { cause: error });
      }
      if (REDIRECT_STATUSES.has(response?.status)) {
        let redirectedUrl = null;
        try {
          redirectedUrl = canonicalizeNovelPingChapterUrl(new URL(response.headers?.get?.('location'), currentUrl).href);
        } catch {
          redirectedUrl = null;
        }
        if (redirectedUrl !== canonicalUrl || redirects === MAX_REDIRECTS) {
          throw new SourceFetchError('NovelPing source redirect was rejected');
        }
        currentUrl = redirectedUrl;
        continue;
      }
      if (!response?.ok) throw new SourceFetchError('NovelPing source returned an unsuccessful response');
      if (!isHtmlContentType(response.headers?.get?.('content-type'))) {
        throw new SourceFetchError('NovelPing source returned non-HTML content');
      }
      try {
        return await readHtmlBody(response, maxBodyBytes, controller.signal);
      } catch (error) {
        throw new SourceFetchError('NovelPing source response could not be read', { cause: error });
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new SourceFetchError('NovelPing source redirect limit was reached');
}

export function canonicalizeNovelPingChapterUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    const path = url.pathname.match(/^\/book\/([a-z0-9]+(?:-[a-z0-9]+)*)\/chapter-([1-9]\d*)(?:-[a-z0-9]+)*$/);
    if (url.protocol !== 'https:' || url.hostname !== 'novelping.com' || /https:\/\/[^/?#]*:/i.test(value) || url.username || url.password || url.search || url.hash || !path) {
      return null;
    }
    return `https://novelping.com/book/${path[1]}/chapter-${path[2]}${url.pathname.slice(`/book/${path[1]}/chapter-${path[2]}`.length)}`;
  } catch {
    return null;
  }
}

export function parseNovelPingEvidenceHtml(html, sourceUrl) {
  const canonicalNovelPingUrl = canonicalizeNovelPingChapterUrl(sourceUrl);
  if (!canonicalNovelPingUrl) throw new ValidationError('unsupported NovelPing chapter URL');
  if (typeof html !== 'string') throw new ValidationError('NovelPing source HTML must be text');

  const visibleHtml = renderedHtml(html);
  const chapterNumberText = requireOneMetadataValue(visibleHtml, 'data-chapter-number', 'chapter number');
  if (!/^[1-9]\d*$/.test(chapterNumberText)) throw new ValidationError('NovelPing source HTML has an invalid chapter number');
  const chapterNumber = Number.parseInt(chapterNumberText, 10);
  const urlChapterNumber = Number.parseInt(canonicalNovelPingUrl.match(/\/chapter-([1-9]\d*)/)?.[1] ?? '', 10);
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber !== urlChapterNumber) {
    throw new ValidationError('NovelPing source HTML chapter number does not match its URL');
  }

  const evidence = {
    canonicalNovelPingUrl,
    novelTitle: normalizeResolutionText(requireOneMetadataValue(visibleHtml, 'data-novel-title', 'novel title')),
    author: null,
    chapterNumber,
    chapterTitle: normalizeResolutionText(requireOneMetadataValue(visibleHtml, 'data-chapter-title', 'chapter title')),
    extractorVersion: RESOLVER_VERSION
  };
  const author = optionalMetadataValue(visibleHtml, 'data-novel-author', 'novel author');
  evidence.author = author === null ? null : normalizeResolutionText(author);
  if (!evidence.novelTitle || !evidence.chapterTitle || (author !== null && !evidence.author)) {
    throw new ValidationError('NovelPing source HTML has invalid normalized metadata');
  }
  return { ...evidence, evidenceHash: evidenceHash(evidence) };
}

export function createNovelPingExtractor({ fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
  return {
    site: SITE,
    supports(sourceUrl) {
      return canonicalizeNovelPingChapterUrl(sourceUrl) !== null;
    },
    async fetchEvidence(sourceUrl) {
      const canonicalNovelPingUrl = canonicalizeNovelPingChapterUrl(sourceUrl);
      if (!canonicalNovelPingUrl) throw new ValidationError('unsupported NovelPing chapter URL');
      try {
        return parseNovelPingEvidenceHtml(await fetchHtml(fetch, canonicalNovelPingUrl, timeoutMs, maxBodyBytes), canonicalNovelPingUrl);
      } catch (error) {
        if (error instanceof SourceFetchError) throw error;
        throw new SourceFetchError('NovelPing source content could not be parsed', { cause: error });
      }
    }
  };
}
