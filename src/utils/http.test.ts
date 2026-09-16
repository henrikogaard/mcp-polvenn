import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./http.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchWithRetry", () => {
  it("retries a 500 response and succeeds on the second attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.com/api", undefined, {
      retries: 3,
      baseDelayMs: 1,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));

    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.com/api", undefined, {
      retries: 3,
      baseDelayMs: 1,
    });

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes a per-attempt abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));

    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry("https://example.com/api", { method: "GET" }, { timeoutMs: 5_000 });

    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("respects a caller-provided signal instead of attaching its own", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    const controller = new AbortController();

    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry("https://example.com/api", { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("times out hung requests with a clear error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // A real fetch rejects when its signal aborts; mirror that.
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason ?? new Error("aborted"));
            });
          }),
      ),
    );

    await expect(
      fetchWithRetry("https://example.com/hung", undefined, {
        retries: 1,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timed out after 25ms/);
  });
});
