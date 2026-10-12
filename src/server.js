import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './server-runtime.js';

const dataDirectory = process.env.INKTRAIL_DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(dataDirectory, { recursive: true });
await startServer({
  port: Number(process.env.PORT ?? 4277),
  databasePath: join(dataDirectory, 'inktrail.sqlite')
});
