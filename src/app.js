import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createChapterRepository } from './chapters/chapter-repository.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { createFeedbackRepository } from './feedback/feedback-repository.js';
import { createFeedbackVerificationService } from './feedback/feedback-verification-service.js';
import { createEpubBuilder, writeEpubArchive } from './epub/epub-builder.js';
import { createExportRepository } from './epub/export-repository.js';
import { createExportRoot } from './epub/export-root.js';
import { createRouter } from './http/router.js';
import { createJobRepository } from './jobs/job-repository.js';
import { createJobService } from './jobs/job-service.js';
import { createTranslationJobRunner } from './jobs/translation-job-runner.js';
import { createMemoryRepository } from './memory/memory-repository.js';
import { createNovelRepository } from './novels/novel-repository.js';
import { createProgressRepository } from './reading/progress-repository.js';
import { createLibraryService } from './services/library-service.js';
import { createAdapterRegistry } from './sources/adapter-registry.js';
import { createKujiangAdapter } from './sources/kujiang-adapter.js';
import { createSourceImportService } from './sources/source-import-service.js';
import { createSourceRepository } from './sources/source-repository.js';
import { createOllamaTranslationProvider } from './translation/ollama-translation-provider.js';
import { createQualityFindingRepository } from './translation/quality-finding-repository.js';
import { createTranslationService } from './translation/translation-service.js';

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

export async function createApp({ databasePath, exportRoot = join(dirname(databasePath), 'exports'), fetch = globalThis.fetch, translationProvider = createOllamaTranslationProvider({ fetch }), writeEpubArchive: archiveWriter = writeEpubArchive }) {
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
    sources: createSourceRepository(database, clock),
    findings: createQualityFindingRepository(database, clock),
    memory: createMemoryRepository(database, clock),
    feedback: createFeedbackRepository(database, clock),
    jobs: createJobRepository(database, clock),
    exports: createExportRepository(database, clock)
  };
  const exports = createExportRoot({ exportRoot });
  try {
    await exports.recoverTemporaryFiles();
  } catch (error) {
    database.close();
    throw error;
  }
  const sourceImportService = createSourceImportService({
    database,
    repositories,
    adapterRegistry: createAdapterRegistry([createKujiangAdapter({ fetch })]),
    clock
  });
  const translationService = createTranslationService({ database, repositories, provider: translationProvider });
  const epubBuilder = createEpubBuilder({ exports: repositories.exports, exportRoot: exports, writeArchive: archiveWriter });
  const runner = createTranslationJobRunner({
    jobs: repositories.jobs,
    translationService,
    epubBuilder,
    clock
  });
  await runner.start();
  const router = createRouter({
    libraryService: createLibraryService(repositories, sourceImportService),
    translationService,
    feedbackVerificationService: createFeedbackVerificationService({ database, repositories }),
    jobService: createJobService({ database, jobs: repositories.jobs, exports: repositories.exports, runner }),
    epubBuilder,
    repositories
  });
  const server = createServer(async (request, response) => {
    if (await serveBrowserAsset(request, response)) return;
    await router(request, response);
  });
  let closePromise = null;

  return {
    server,
    sourceImportService,
    runner,
    close: () => {
      if (closePromise !== null) return closePromise;
      closePromise = (async () => {
        let serverError = null;
        try {
          await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        } catch (error) {
          serverError = error;
        }
        await runner.stop();
        database.close();
        if (serverError) throw serverError;
      })();
      return closePromise;
    }
  };
}
