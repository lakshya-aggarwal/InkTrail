import { createServer } from 'node:http';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';

export function createApp({ databasePath }) {
  const database = openDatabase({ databasePath });
  try {
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/api/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: {
        code: 'not_found',
        message: 'Route not found',
        retryable: false
      }
    }));
  });

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
