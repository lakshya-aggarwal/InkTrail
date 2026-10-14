import { once } from 'node:events';
import { createApp } from '../../src/app.js';

const fixtureTranslationProvider = {
  provider: 'fixture',
  model: 'fixture-model',
  async translate({ originalChinese }) {
    return {
      paragraphs: originalChinese
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((_, index) => `Fixture translation ${index + 1}.`)
    };
  }
};

export async function startTestApp({ databasePath = ':memory:', fetch: sourceFetch, translationProvider = fixtureTranslationProvider } = {}) {
  const app = createApp({ databasePath, fetch: sourceFetch, translationProvider });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    request: (path, options) => globalThis.fetch(`${baseUrl}${path}`, options),
    close: app.close
  };
}
