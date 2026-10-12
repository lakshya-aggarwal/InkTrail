export class SourceFetchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SourceFetchError';
    this.retryable = true;
  }
}
