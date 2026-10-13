import { once } from 'node:events';
import { createApp } from '../../src/app.js';

export async function startTestApp({ databasePath = ':memory:', fetch: sourceFetch } = {}) {
  const app = createApp({ databasePath, fetch: sourceFetch });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    request: (path, options) => globalThis.fetch(`${baseUrl}${path}`, options),
    close: app.close
  };
}
