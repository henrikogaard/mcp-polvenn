import {
  REQUEST_RETRY_ATTEMPTS,
  REQUEST_RETRY_BASE_DELAY_MS,
  REQUEST_TIMEOUT_MS,
} from "../constants.js";

interface FetchRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  shouldRetry?: (response: Response | null, error: unknown) => boolean;
}

function defaultShouldRetry(response: Response | null, error: unknown): boolean {
  if (response) {
    return response.status === 429 || response.status >= 500;
  }

  return error instanceof Error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeInput(input: string | URL): string {
  return typeof input === "string" ? input : input.toString();
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? REQUEST_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? REQUEST_RETRY_BASE_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response: Response | null = null;

    // A fresh signal per attempt — an aborted signal cannot be reused.
    const attemptInit = init?.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) };

    try {
      response = await fetch(input, attemptInit);
      if (!shouldRetry(response, null) || attempt === retries) {
        return response;
      }
    } catch (error: unknown) {
      lastError = isTimeoutError(error)
        ? new Error(`Request to ${describeInput(input)} timed out after ${timeoutMs}ms`)
        : error;
      if (!shouldRetry(null, error) || attempt === retries) {
        throw lastError;
      }
    }

    await delay(baseDelayMs * 2 ** (attempt - 1));
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}
