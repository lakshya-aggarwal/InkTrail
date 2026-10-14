import { ConflictError, NotFoundError, SourceFetchError, TranslationProviderError, ValidationError } from '../domain/errors.js';
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
  if (error instanceof SourceFetchError) {
    writeJson(response, 502, errorBody('source_fetch_failed', 'Source chapter could not be fetched', true));
    return;
  }
  if (error instanceof TranslationProviderError) {
    writeJson(response, 502, errorBody('translation_provider_failed', 'Translation provider could not complete the request', true));
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

async function readObject(request) {
  const input = await readJson(request);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('input must be an object');
  }
  return input;
}

function chapterResourceId(error, novelId, chapterNumber) {
  return error instanceof NotFoundError && error.message === 'novel not found' ? novelId : chapterNumber;
}

function feedbackResourceId(error, novelId, reportId) {
  return error instanceof NotFoundError && error.message === 'novel not found' ? novelId : reportId;
}

export function createRouter({ libraryService, translationService, feedbackVerificationService, repositories }) {
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

    const sourceChapterCollectionMatch = /^\/api\/v1\/novels\/([^/]+)\/source-chapters$/.exec(pathname);
    if (method === 'POST' && sourceChapterCollectionMatch) {
      const novelId = decodePathParameter(response, sourceChapterCollectionMatch[1]);
      if (novelId === undefined) return;
      await handle(response, novelId, async () => {
        const { created, sourceChapter } = await libraryService.importSourceChapter(novelId, await readJson(request));
        writeJson(response, created ? 201 : 200, sourceChapter);
      });
      return;
    }

    const chapterMatch = /^\/api\/v1\/novels\/([^/]+)\/chapters\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && chapterMatch) {
      const novelId = decodePathParameter(response, chapterMatch[1]);
      if (novelId === undefined) return;
      const chapterNumber = decodePathParameter(response, chapterMatch[2]);
      if (chapterNumber === undefined) return;
      await handle(response, (error) => chapterResourceId(error, novelId, chapterNumber), async () => writeJson(response, 200, libraryService.getReaderChapter(novelId, chapterNumber)));
      return;
    }

    const translationMatch = /^\/api\/v1\/novels\/([^/]+)\/chapters\/([^/]+)\/translations$/.exec(pathname);
    if (method === 'POST' && translationMatch) {
      const novelId = decodePathParameter(response, translationMatch[1]);
      if (novelId === undefined) return;
      const chapterNumber = decodePathParameter(response, translationMatch[2]);
      if (chapterNumber === undefined) return;
      await handle(response, (error) => chapterResourceId(error, novelId, chapterNumber), async () => {
        writeJson(response, 201, await translationService.translateChapter({ novelId, chapterNumber: Number(chapterNumber) }));
      });
      return;
    }

    const feedbackCollectionMatch = /^\/api\/v1\/novels\/([^/]+)\/chapters\/([^/]+)\/feedback$/.exec(pathname);
    if (feedbackCollectionMatch) {
      const novelId = decodePathParameter(response, feedbackCollectionMatch[1]);
      if (novelId === undefined) return;
      const chapterNumber = decodePathParameter(response, feedbackCollectionMatch[2]);
      if (chapterNumber === undefined) return;
      if (method === 'GET') {
        await handle(response, (error) => chapterResourceId(error, novelId, chapterNumber), async () => {
          const chapter = libraryService.getReaderChapter(novelId, chapterNumber);
          writeJson(response, 200, { items: repositories.feedback.listFeedbackReports({ novelId, chapterId: chapter.id }) });
        });
        return;
      }
      if (method === 'POST') {
        await handle(response, (error) => chapterResourceId(error, novelId, chapterNumber), async () => {
          const chapter = libraryService.getReaderChapter(novelId, chapterNumber);
          writeJson(response, 201, repositories.feedback.submitFeedbackReport({ ...await readObject(request), novelId, chapterId: chapter.id }));
        });
        return;
      }
    }

    const feedbackDecisionMatch = /^\/api\/v1\/novels\/([^/]+)\/feedback\/([^/]+)$/.exec(pathname);
    if (method === 'PATCH' && feedbackDecisionMatch) {
      const novelId = decodePathParameter(response, feedbackDecisionMatch[1]);
      if (novelId === undefined) return;
      const reportId = decodePathParameter(response, feedbackDecisionMatch[2]);
      if (reportId === undefined) return;
      await handle(response, (error) => feedbackResourceId(error, novelId, reportId), async () => {
        writeJson(response, 200, feedbackVerificationService.verifyFeedback({ ...await readObject(request), novelId, reportId }));
      });
      return;
    }

    const memoryMatch = /^\/api\/v1\/novels\/([^/]+)\/verified-memory$/.exec(pathname);
    if (method === 'GET' && memoryMatch) {
      const novelId = decodePathParameter(response, memoryMatch[1]);
      if (novelId === undefined) return;
      await handle(response, novelId, async () => writeJson(response, 200, { items: repositories.memory.listVerifiedMemoryEntries(novelId) }));
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
