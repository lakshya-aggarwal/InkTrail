import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { InvalidJsonError, readJson, UnsupportedMediaTypeError, writeJson } from './json.js';

function errorBody(code, message, retryable, resourceId) {
  return {
    error: {
      code,
      message,
      retryable,
      ...(resourceId === undefined ? {} : { resourceId })
    }
  };
}

function routeError(response, error, resourceId) {
  if (error instanceof UnsupportedMediaTypeError) {
    writeJson(response, 415, errorBody('unsupported_media_type', error.message, false));
    return;
  }
  if (error instanceof InvalidJsonError) {
    writeJson(response, 400, errorBody('invalid_json', error.message, false));
    return;
  }
  if (error instanceof ValidationError) {
    writeJson(response, 400, errorBody('validation_error', error.message, false));
    return;
  }
  if (error instanceof NotFoundError) {
    writeJson(response, 404, errorBody('not_found', error.message, false, resourceId));
    return;
  }
  if (error instanceof ConflictError) {
    writeJson(response, 409, errorBody('conflict', error.message, false));
    return;
  }
  writeJson(response, 500, errorBody('internal_error', 'Internal server error', true));
}

function decodePathParameter(response, value) {
  try {
    return decodeURIComponent(value);
  } catch {
    writeJson(response, 400, errorBody('validation_error', 'Malformed URL path parameter', false));
    return undefined;
  }
}

async function handle(response, resourceId, action) {
  try {
    await action();
  } catch (error) {
    routeError(response, error, typeof resourceId === 'function' ? resourceId(error) : resourceId);
  }
}

export function createRouter(libraryService) {
  return async function router(request, response) {
    const { method } = request;
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');

    if (method === 'GET' && pathname === '/api/v1/health') {
      writeJson(response, 200, { status: 'ok' });
      return;
    }
    if (method === 'GET' && pathname === '/api/v1/novels') {
      await handle(response, undefined, async () => writeJson(response, 200, { items: libraryService.listNovels() }));
      return;
    }
    if (method === 'POST' && pathname === '/api/v1/novels') {
      await handle(response, undefined, async () => writeJson(response, 201, libraryService.createNovel(await readJson(request))));
      return;
    }

    const novelMatch = /^\/api\/v1\/novels\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && novelMatch) {
      const novelId = decodePathParameter(response, novelMatch[1]);
      if (novelId === undefined) return;
      await handle(response, novelId, async () => writeJson(response, 200, libraryService.getNovel(novelId)));
      return;
    }

    const chapterCollectionMatch = /^\/api\/v1\/novels\/([^/]+)\/chapters$/.exec(pathname);
    if (method === 'POST' && chapterCollectionMatch) {
      const novelId = decodePathParameter(response, chapterCollectionMatch[1]);
      if (novelId === undefined) return;
      await handle(response, novelId, async () => writeJson(response, 201, libraryService.recordChapter(novelId, await readJson(request))));
      return;
    }

    const chapterMatch = /^\/api\/v1\/novels\/([^/]+)\/chapters\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && chapterMatch) {
      const novelId = decodePathParameter(response, chapterMatch[1]);
      if (novelId === undefined) return;
      const chapterNumber = decodePathParameter(response, chapterMatch[2]);
      if (chapterNumber === undefined) return;
      await handle(response, (error) => error instanceof NotFoundError && error.message === 'novel not found' ? novelId : chapterNumber, async () => writeJson(response, 200, libraryService.getReaderChapter(novelId, chapterNumber)));
      return;
    }

    const progressMatch = /^\/api\/v1\/novels\/([^/]+)\/reading-progress$/.exec(pathname);
    if (method === 'PATCH' && progressMatch) {
      const novelId = decodePathParameter(response, progressMatch[1]);
      if (novelId === undefined) return;
      await handle(response, novelId, async () => writeJson(response, 200, {
        readingProgress: libraryService.setReadingProgress(novelId, await readJson(request))
      }));
      return;
    }

    writeJson(response, 404, errorBody('not_found', 'Route not found', false));
  };
}
