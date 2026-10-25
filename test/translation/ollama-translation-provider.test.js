import assert from 'node:assert/strict';
import test from 'node:test';
import { TranslationProviderError } from '../../src/domain/errors.js';
import {
  buildTranslationPrompt,
  createOllamaTranslationProvider,
  shapeTranslationContext
} from '../../src/translation/ollama-translation-provider.js';

const input = {
  originalChinese: '夜色落在城墙上。\n\n他看见了归来的路。',
  priorContext: ['first', 'second', 'third', 'latest'],
  verifiedMemory: [{ sourceTerm: '师兄', preferredRendering: 'senior brother', semanticScope: 'sect ranks' }]
};

function response(paragraphs) {
  return new Response(JSON.stringify({ response: JSON.stringify({ paragraphs }) }), {
    headers: { 'content-type': 'application/json' }
  });
}

test('shapes bounded context and builds a deterministic prompt from verified novel memory', () => {
  assert.deepEqual(shapeTranslationContext(input).priorContext, ['second', 'third', 'latest']);
  const prompt = buildTranslationPrompt(input);

  assert.match(prompt, /师兄: senior brother \(sect ranks\)/);
  assert.doesNotMatch(prompt, /first/);
  assert.match(prompt, /1\. 夜色落在城墙上。/);
  assert.match(prompt, /2\. 他看见了归来的路。/);
});

test('uses a bounded structured Ollama request and returns only translated paragraphs', async () => {
  const calls = [];
  const provider = createOllamaTranslationProvider({
    endpoint: 'http://127.0.0.1:11434',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return response(['Night fell over the city wall.', 'He saw the road home.']);
    }
  });

  assert.deepEqual(await provider.translate(input), { paragraphs: ['Night fell over the city wall.', 'He saw the road home.'], model: 'qwen3:30b' });
  assert.equal(provider.provider, 'ollama');
  assert.equal(provider.model, 'qwen3:30b');
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/generate');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['format', 'model', 'options', 'prompt', 'stream', 'think']);
  assert.equal(body.model, 'qwen3:30b');
  assert.equal(body.stream, false);
  assert.equal(body.format.additionalProperties, false);
  assert.deepEqual(body.options, { temperature: 0.2 });
});

test('lists installed Ollama models and captures a selected model for its translation', async () => {
  const calls = [];
  const provider = createOllamaTranslationProvider({
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3:30b', size: 1 }, { name: 'qwen3:8b' }] }));
      return response(['Night fell over the city wall.', 'He saw the road home.']);
    }
  });

  assert.deepEqual(await provider.listModels(), ['qwen3:30b', 'qwen3:8b']);
  const translation = await provider.translate({ ...input, model: 'qwen3:8b' });

  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[1].options.body).model, 'qwen3:8b');
  assert.equal(translation.model, 'qwen3:8b');
});

test('rejects redirects before the loopback request can leave Ollama', async () => {
  let request;
  const provider = createOllamaTranslationProvider({
    fetch: async (url, options) => {
      request = { url, options };
      throw new TypeError('redirect rejected');
    }
  });

  await assert.rejects(
    () => provider.translate(input),
    (error) => error instanceof TranslationProviderError && error.message === 'Ollama translation request failed'
  );
  assert.equal(request.url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(request.options.redirect, 'error');
});

test('rejects non-loopback endpoints and maps bad model responses to typed errors without leaking content', async () => {
  assert.throws(() => createOllamaTranslationProvider({ endpoint: 'https://example.com' }), TranslationProviderError);
  const provider = createOllamaTranslationProvider({
    fetch: async () => new Response(JSON.stringify({ response: 'model internal secret' }), { headers: { 'content-type': 'application/json' } })
  });

  await assert.rejects(
    () => provider.translate(input),
    (error) => error instanceof TranslationProviderError && !error.message.includes('secret')
  );
});

test('maps aborted requests to a typed timeout error', async () => {
  const provider = createOllamaTranslationProvider({
    timeoutMs: 1,
    fetch: async (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
  });

  await assert.rejects(() => provider.translate(input), (error) => error instanceof TranslationProviderError && error.message === 'Ollama translation timed out');
});
