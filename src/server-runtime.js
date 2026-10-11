import { once } from 'node:events';
import { createApp } from './app.js';

export async function startServer({ port, databasePath }) {
  const app = createApp({ databasePath });
  app.server.listen(port, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();

  return { ...app, url: `http://127.0.0.1:${address.port}` };
}
