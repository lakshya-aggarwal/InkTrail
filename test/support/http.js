import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

export async function startTestApp({ databasePath = ':memory:', fetch: sourceFetch, translationProvider = fixtureTranslationProvider, writeEpubArchive, resolverCandidateIdentities, novelPingExtractor } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'inktrail-http-'));
  const app = await createApp({ databasePath, exportRoot: join(directory, 'exports'), fetch: sourceFetch, translationProvider, writeEpubArchive, resolverCandidateIdentities, novelPingExtractor });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    request: (path, options) => globalThis.fetch(`${baseUrl}${path}`, options),
    close: async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}
