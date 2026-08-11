export type ExitCode = 2 | 3 | 4 | 5 | 6;

export class ImporterError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ImporterError";
  }
}

export const usageError = (message: string) => new ImporterError(message, 2);
export const compatibilityError = (message: string) => new ImporterError(message, 3);
export const safetyError = (message: string) => new ImporterError(message, 4);
export const sourceError = (message: string, details?: unknown) =>
  new ImporterError(message, 5, details);
export const writeError = (message: string, details?: unknown) =>
  new ImporterError(message, 6, details);
