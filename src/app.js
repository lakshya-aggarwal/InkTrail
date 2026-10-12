import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createChapterRepository } from './chapters/chapter-repository.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { createRouter } from './http/router.js';
import { createNovelRepository } from './novels/novel-repository.js';
import { createProgressRepository } from './reading/progress-repository.js';
import { createLibraryService } from './services/library-service.js';
import { createAdapterRegistry } from './sources/adapter-registry.js';
import { createKujiangAdapter } from './sources/kujiang-adapter.js';
import { createSourceImportService } from './sources/source-import-service.js';
import { createSourceRepository } from './sources/source-repository.js';

const browserAssets = new Map([
  ['/', { path: new URL('../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/app.js', { path: new URL('../public/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { path: new URL('../public/styles.css', import.meta.url), type: 'text/css; charset=utf-8' }]
]);

async function serveBrowserAsset(request, response) {
  if (request.method !== 'GET') return false;
  const asset = browserAssets.get(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (!asset) return false;
  response.writeHead(200, { 'content-type': asset.type });
  response.end(await readFile(asset.path));
  return true;
}

export function createApp({ databasePath, fetch = globalThis.fetch }) {
  const database = openDatabase({ databasePath });
  try {
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  const clock = () => new Date();
  const repositories = {
    novels: createNovelRepository(database, clock),
    chapters: createChapterRepository(database, clock),
    progress: createProgressRepository(database, clock),
    sources: createSourceRepository(database, clock)
  };
  const sourceImportService = createSourceImportService({
    database,
    repositories,
    adapterRegistry: createAdapterRegistry([createKujiangAdapter({ fetch })]),
    clock
  });
  const router = createRouter(createLibraryService(repositories));
  const server = createServer(async (request, response) => {
    if (await serveBrowserAsset(request, response)) return;
    await router(request, response);
  });

  return {
    server,
    sourceImportService,
    close: () => new Promise((resolve, reject) => server.close((error) => {
      database.close();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }))
  };
}
