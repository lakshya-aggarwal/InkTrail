import { createServer } from 'node:http';

export function createApp({ databasePath }) {
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

  return { server, close: () => new Promise((resolve) => server.close(resolve)) };
}
