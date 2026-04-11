import {
  REQUEST_RETRY_ATTEMPTS,
  REQUEST_RETRY_BASE_DELAY_MS,
} from "../constants.js";

interface FetchRetryOptions {
  retries?: number;
  baseDelayMs?: number;
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

export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? REQUEST_RETRY_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? REQUEST_RETRY_BASE_DELAY_MS;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response: Response | null = null;

    try {
      response = await fetch(input, init);
      if (!shouldRetry(response, null) || attempt === retries) {
        return response;
      }
    } catch (error: unknown) {
      lastError = error;
      if (!shouldRetry(null, error) || attempt === retries) {
        throw error;
      }
    }

    await delay(baseDelayMs * 2 ** (attempt - 1));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Request failed after retries");
}
