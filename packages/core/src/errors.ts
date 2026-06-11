/** Thrown when an event cannot be structurally parsed as the expected canary kind. */
export class CanaryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanaryParseError';
  }
}
