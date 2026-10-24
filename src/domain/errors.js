export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class SourceFetchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SourceFetchError';
    this.retryable = true;
  }
}

export class TranslationProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranslationProviderError';
    this.retryable = true;
  }
}
