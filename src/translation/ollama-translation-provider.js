import { TranslationProviderError } from '../domain/errors.js';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
const MODEL = 'qwen3:30b';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_SOURCE_CHARS = 64_000;
const MAX_SOURCE_SEGMENTS = 500;
const MAX_CONTEXT_ITEMS = 3;
const MAX_CONTEXT_CHARS = 6_000;
const MAX_MEMORY_ENTRIES = 50;
const MAX_MEMORY_FIELD_CHARS = 500;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RESPONSE_PARAGRAPHS = 500;
const MAX_RESPONSE_PARAGRAPH_CHARS = 16_000;
const MAX_MODEL_NAME_CHARS = 255;
const MAX_MODELS = 500;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const translationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['paragraphs'],
  properties: {
    paragraphs: {
      type: 'array',
      maxItems: MAX_RESPONSE_PARAGRAPHS,
      items: { type: 'string', maxLength: MAX_RESPONSE_PARAGRAPH_CHARS }
    }
  }
};

function fail(message) {
  throw new TranslationProviderError(message);
}

function requireText(value, name, limit) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) {
    fail(`${name} is invalid`);
  }
  return value.trim();
}

function optionalText(value, name, limit) {
  if (value === undefined || value === null) {
    return null;
  }
  return requireText(value, name, limit);
}

function requireArray(value, name) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${name} is invalid`);
  }
  return value;
}

function endpointUrl(endpoint, pathname) {
  if (typeof endpoint !== 'string' || endpoint.trim() !== endpoint) {
    fail('Ollama endpoint is invalid');
  }
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      fail('Ollama endpoint must be a loopback HTTP URL');
    }
    return new URL(pathname, url).href;
  } catch (error) {
    if (error instanceof TranslationProviderError) {
      throw error;
    }
    fail('Ollama endpoint is invalid');
  }
}

function modelName(value) {
  const model = requireText(value, 'Ollama model', MAX_MODEL_NAME_CHARS);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) fail('Ollama model is invalid');
  return model;
}

function parseModels(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    fail('Ollama model list is invalid');
  }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.models) || payload.models.length > MAX_MODELS) {
    fail('Ollama model list is invalid');
  }
  const models = payload.models.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail('Ollama model list is invalid');
    }
    return modelName(item.name);
  });
  if (new Set(models).size !== models.length) fail('Ollama model list is invalid');
  return models.sort((left, right) => left.localeCompare(right));
}

function timeoutValue(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail('Ollama timeout is invalid');
  }
  return timeoutMs;
}

function normalizeContext(value) {
  return requireArray(value, 'priorContext')
    .slice(-MAX_CONTEXT_ITEMS)
    .map((item) => requireText(item, 'priorContext item', MAX_CONTEXT_CHARS));
}

function normalizeMemory(value) {
  return requireArray(value, 'verifiedMemory')
    .slice(0, MAX_MEMORY_ENTRIES)
    .map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        fail('verifiedMemory entry is invalid');
      }
      return {
        sourceTerm: requireText(entry.sourceTerm, 'memory sourceTerm', MAX_MEMORY_FIELD_CHARS),
        preferredRendering: requireText(entry.preferredRendering, 'memory preferredRendering', MAX_MEMORY_FIELD_CHARS),
        semanticScope: optionalText(entry.semanticScope, 'memory semanticScope', MAX_MEMORY_FIELD_CHARS)
      };
    });
}

export function shapeTranslationContext(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('translation input is invalid');
  }
  return {
    originalChinese: requireText(input.originalChinese, 'originalChinese', MAX_SOURCE_CHARS),
    priorContext: normalizeContext(input.priorContext),
    verifiedMemory: normalizeMemory(input.verifiedMemory)
  };
}

export function buildTranslationPrompt(input) {
  const { originalChinese, priorContext, verifiedMemory } = shapeTranslationContext(input);
  const sourceSegments = originalChinese.split(/\n\s*\n/).map((segment) => segment.trim()).filter(Boolean);
  if (sourceSegments.length === 0 || sourceSegments.length > MAX_SOURCE_SEGMENTS) {
    fail('originalChinese is invalid');
  }
  return [
    'Translate the Chinese webnovel source into fluent English prose.',
    'Preserve plot details, names, cultivation terms, and source paragraph boundaries.',
    'Return exactly one English paragraph for every numbered source segment.',
    'Use verified novel memory exactly when its source term appears.',
    'Do not leave Chinese characters in the English translation.',
    '',
    'Verified novel memory:',
    verifiedMemory.length === 0 ? '(none)' : verifiedMemory.map((entry) => `- ${entry.sourceTerm}: ${entry.preferredRendering}${entry.semanticScope ? ` (${entry.semanticScope})` : ''}`).join('\n'),
    '',
    'Prior context:',
    priorContext.length === 0 ? '(none)' : priorContext.map((item, index) => `${index + 1}. ${item}`).join('\n\n'),
    '',
    'Source segments:',
    sourceSegments.map((segment, index) => `${index + 1}. ${segment}`).join('\n\n')
  ].join('\n');
}

function readChunk(reader, signal) {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
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

async function readResponseBody(response, signal) {
  const contentLength = Number.parseInt(response.headers?.get?.('content-length') ?? '', 10);
  if (Number.isInteger(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    fail('Ollama translation response exceeded the limit');
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      fail('Ollama translation response exceeded the limit');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await readChunk(reader, signal);
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('Ollama translation response exceeded the limit');
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

function parseTranslationResponse(body) {
  let payload;
  let translation;
  try {
    payload = JSON.parse(body);
    translation = JSON.parse(payload.response);
  } catch {
    fail('Ollama translation response is invalid');
  }
  if (payload === null || typeof payload !== 'object' || typeof payload.response !== 'string' || translation === null || typeof translation !== 'object' || Array.isArray(translation) || !Array.isArray(translation.paragraphs) || translation.paragraphs.length > MAX_RESPONSE_PARAGRAPHS || Object.keys(translation).some((key) => key !== 'paragraphs') || translation.paragraphs.some((paragraph) => typeof paragraph !== 'string' || paragraph.trim().length === 0 || paragraph.length > MAX_RESPONSE_PARAGRAPH_CHARS)) {
    fail('Ollama translation response is invalid');
  }
  return { paragraphs: translation.paragraphs.map((paragraph) => paragraph.trim()) };
}

export function createOllamaTranslationProvider({ fetch = globalThis.fetch, endpoint = DEFAULT_ENDPOINT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetch !== 'function') {
    fail('Ollama fetch client is invalid');
  }
  const url = endpointUrl(endpoint, '/api/generate');
  const modelListUrl = endpointUrl(endpoint, '/api/tags');
  const timeout = timeoutValue(timeoutMs);

  return {
    provider: 'ollama',
    model: MODEL,
    async listModels() {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        let response;
        try {
          response = await fetch(modelListUrl, { redirect: 'error', signal: controller.signal });
        } catch {
          fail(controller.signal.aborted ? 'Ollama model list timed out' : 'Ollama model list request failed');
        }
        if (!response?.ok) fail('Ollama model list request was unsuccessful');
        return parseModels(await readResponseBody(response, controller.signal));
      } catch (error) {
        if (error instanceof TranslationProviderError) throw error;
        fail(controller.signal.aborted ? 'Ollama model list timed out' : 'Ollama model list is invalid');
      } finally {
        clearTimeout(timeoutId);
      }
    },
    async translate(input) {
      const model = input?.model === undefined ? MODEL : modelName(input.model);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      try {
        let response;
        try {
          response = await fetch(url, {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              prompt: buildTranslationPrompt(input),
              stream: false,
              think: false,
              format: translationSchema,
              options: { temperature: 0.2, num_ctx: 32_768 }
            })
          });
        } catch {
          fail(controller.signal.aborted ? 'Ollama translation timed out' : 'Ollama translation request failed');
        }
        if (!response?.ok) {
          fail('Ollama translation request was unsuccessful');
        }
        try {
          return { ...parseTranslationResponse(await readResponseBody(response, controller.signal)), model };
        } catch (error) {
          if (error instanceof TranslationProviderError) {
            throw error;
          }
          fail(controller.signal.aborted ? 'Ollama translation timed out' : 'Ollama translation response is invalid');
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  };
}
