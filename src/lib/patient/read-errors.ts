/** Preserve API status without changing the server's safe, user-facing message. */
export class PatientRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PatientRequestError";
  }
}

export function isTransientReadError(error: unknown): boolean {
  if (error instanceof PatientRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}
