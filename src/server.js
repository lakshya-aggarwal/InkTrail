import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from './server-runtime.js';

const dataDirectory = process.env.INKTRAIL_DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(dataDirectory, { recursive: true });
const app = await startServer({
  port: Number(process.env.PORT ?? 4277),
  databasePath: join(dataDirectory, 'inktrail.sqlite')
});
process.stdout.write(`INKTRAIL_READY ${app.url}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  process.exit();
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (input) => {
  if (input.trim() === 'INKTRAIL_SHUTDOWN') void close();
});
