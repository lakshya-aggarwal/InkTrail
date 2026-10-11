import { createServer } from 'node:http';
import { createChapterRepository } from './chapters/chapter-repository.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { createRouter } from './http/router.js';
import { createNovelRepository } from './novels/novel-repository.js';
import { createProgressRepository } from './reading/progress-repository.js';
import { createLibraryService } from './services/library-service.js';

export function createApp({ databasePath }) {
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
    progress: createProgressRepository(database, clock)
  };
  const server = createServer(createRouter(createLibraryService(repositories)));

  return {
    server,
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
