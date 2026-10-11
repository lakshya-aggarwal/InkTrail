export class InvalidJsonError extends Error {
  constructor() {
    super('Malformed JSON body');
  }
}

export class UnsupportedMediaTypeError extends Error {
  constructor() {
    super('Expected application/json');
  }
}

export async function readJson(request) {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new UnsupportedMediaTypeError();
  }

  const body = await Array.fromAsync(request).then((chunks) => Buffer.concat(chunks).toString());
  try {
    return JSON.parse(body);
  } catch {
    throw new InvalidJsonError();
  }
}

export function writeJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
