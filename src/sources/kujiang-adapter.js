import { SourceFetchError } from './source-errors.js';

const SITE = 'kujiang';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

function attributesFrom(source) {
  const attributes = {};
  const pattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function classes(attributes) {
  return new Set((attributes.class ?? '').split(/\s+/).filter(Boolean));
}

function matchingElement(html, predicate) {
  const openings = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  for (const opening of html.matchAll(openings)) {
    const tag = opening[1].toLowerCase();
    const attributes = attributesFrom(opening[2]);
    if (!predicate(tag, attributes)) {
      continue;
    }

    const contentStart = opening.index + opening[0].length;
    const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    tags.lastIndex = contentStart;
    let depth = 1;
    for (const candidate of html.matchAll(tags)) {
      if (candidate.index < contentStart) {
        continue;
      }
      if (candidate[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) {
          return { attributes, content: html.slice(contentStart, candidate.index) };
        }
      } else if (!candidate[0].endsWith('/>')) {
        depth += 1;
      }
    }
  }
  return null;
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    const normalized = key.toLowerCase();
    if (normalized in named) {
      return named[normalized];
    }
    const codePoint = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      return entity;
    }
    return String.fromCodePoint(codePoint);
  });
}

function textFromHtml(fragment) {
  return decodeEntities(fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(?:p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function canonicalNavigationUrl(value, baseUrl) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return canonicalizeKujiangUrl(new URL(value, baseUrl).href);
  } catch {
    return null;
  }
}

function navigationUrl(content, relationship, baseUrl) {
  const anchors = /<a\b([^>]*)>/gi;
  for (const anchor of content.matchAll(anchors)) {
    const attributes = attributesFrom(anchor[1]);
    if (attributes.rel?.toLowerCase() === relationship) {
      return canonicalNavigationUrl(attributes.href, baseUrl);
    }
  }
  return null;
}

function chapterIds(normalizedUrl) {
  const path = new URL(normalizedUrl).pathname.match(/^\/book\/([1-9]\d*)\/([1-9]\d*)$/);
  return { externalNovelId: path[1], externalChapterId: path[2] };
}

function chapterContentElement(html) {
  return matchingElement(html, (tag, attributes) => (
    (tag === 'article' || tag === 'div') && (
      'data-chapter-content' in attributes ||
      attributes.id === 'chapterContent' ||
      classes(attributes).has('article-content')
    )
  ));
}

function chapterTitleElement(html) {
  return matchingElement(html, (tag, attributes) => tag === 'h1' && (
    'data-chapter-title' in attributes ||
    classes(attributes).has('chapter-title') ||
    classes(attributes).has('article-title')
  ));
}

function chapterNavigationElement(html) {
  return matchingElement(html, (tag, attributes) => tag === 'nav' && (
    'data-chapter-navigation' in attributes || attributes.id === 'chapter-navigation'
  ));
}

function isChineseStoryParagraph(paragraph) {
  return /[\u3400-\u9fff]/.test(paragraph) && !/(?:本章未完|上一章|下一章|返回目录|加入书架|章节错误|手机阅读|点击.*(?:下一页|阅读))/.test(paragraph);
}

export function canonicalizeKujiangUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || !/^https:\/\/www\.kujiang\.com(?:[/?#]|$)/.test(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    const path = url.pathname.match(/^\/book\/([1-9]\d*)\/([1-9]\d*)$/);
    if (url.protocol !== 'https:' || url.hostname !== 'www.kujiang.com' || url.port || !path) {
      return null;
    }
    return `https://www.kujiang.com/book/${path[1]}/${path[2]}`;
  } catch {
    return null;
  }
}

export function parseKujiangChapterHtml(html, sourceUrl) {
  const normalizedUrl = canonicalizeKujiangUrl(sourceUrl);
  if (!normalizedUrl) {
    throw new Error('unsupported Kujiang chapter URL');
  }
  if (typeof html !== 'string') {
    throw new Error('source HTML must be text');
  }

  const content = chapterContentElement(html);
  const title = chapterTitleElement(html);
  if (!content || !title) {
    throw new Error('source HTML is missing chapter content or title');
  }
  const sourceTitle = textFromHtml(title.content);
  if (!sourceTitle) {
    throw new Error('source HTML is missing a chapter title');
  }
  const paragraphs = textFromHtml(content.content).split('\n').filter(isChineseStoryParagraph);
  if (paragraphs.length === 0) {
    throw new Error('source HTML has no Chinese story paragraphs');
  }
  const navigation = chapterNavigationElement(html);
  const ids = chapterIds(normalizedUrl);

  return {
    site: SITE,
    ...ids,
    sourceUrl: normalizedUrl,
    normalizedUrl,
    title: sourceTitle,
    paragraphs,
    previousSourceUrl: navigation ? navigationUrl(navigation.content, 'prev', normalizedUrl) : null,
    nextSourceUrl: navigation ? navigationUrl(navigation.content, 'next', normalizedUrl) : null
  };
}

async function readHtmlBody(response, maxBodyBytes) {
  const contentLength = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isInteger(contentLength) && contentLength > maxBodyBytes) {
    throw new Error('source response exceeds body limit');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
      throw new Error('source response exceeds body limit');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
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

async function fetchHtml(fetchClient, normalizedUrl, timeoutMs, maxBodyBytes) {
  let currentUrl = normalizedUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchClient(currentUrl, {
        headers: { accept: 'text/html' },
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (error) {
      throw new SourceFetchError('Kujiang source request failed', { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (REDIRECT_STATUSES.has(response?.status)) {
      const redirectedUrl = canonicalNavigationUrl(response.headers?.get?.('location'), currentUrl);
      if (!redirectedUrl || redirects === MAX_REDIRECTS) {
        throw new SourceFetchError('Kujiang source redirect was rejected');
      }
      currentUrl = redirectedUrl;
      continue;
    }
    if (!response?.ok) {
      throw new SourceFetchError('Kujiang source returned an unsuccessful response');
    }
    if (!response.headers?.get?.('content-type')?.toLowerCase().includes('text/html')) {
      throw new SourceFetchError('Kujiang source returned non-HTML content');
    }
    try {
      return await readHtmlBody(response, maxBodyBytes);
    } catch (error) {
      throw new SourceFetchError('Kujiang source response could not be read', { cause: error });
    }
  }
  throw new SourceFetchError('Kujiang source redirect limit was reached');
}

export function createKujiangAdapter({ fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES }) {
  return {
    site: SITE,
    supports(sourceUrl) {
      return canonicalizeKujiangUrl(sourceUrl) !== null;
    },
    async fetchChapter(sourceUrl) {
      const normalizedUrl = canonicalizeKujiangUrl(sourceUrl);
      if (!normalizedUrl) {
        throw new Error('unsupported Kujiang chapter URL');
      }
      try {
        return parseKujiangChapterHtml(await fetchHtml(fetch, normalizedUrl, timeoutMs, maxBodyBytes), normalizedUrl);
      } catch (error) {
        if (error instanceof SourceFetchError) {
          throw error;
        }
        throw new SourceFetchError('Kujiang source content could not be parsed', { cause: error });
      }
    }
  };
}
