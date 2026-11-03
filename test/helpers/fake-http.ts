/**
 * In-memory `HttpClient` for adapter and tool tests. Maps URLs to canned
 * `HttpResult`s and records every call. No network, no cache layer.
 */
import type { HttpClient, HttpRequestOptions, HttpResult } from '../../src/types.js';

export type FakeResponse<T = unknown> =
  | Partial<HttpResult<T>>
  | ((url: string, opts: HttpRequestOptions) => Partial<HttpResult<T>> | Promise<Partial<HttpResult<T>>>);

export type UrlMatcher = string | RegExp | ((url: string) => boolean);

export interface FakeCall {
  url: string;
  opts: HttpRequestOptions;
}

/** 200 response carrying `data`. `extra` overrides any HttpResult field (headers, provenance, ...). */
export function ok<T>(data: T, extra: Partial<HttpResult<T>> = {}): Partial<HttpResult<T>> {
  return { status: 200, data, ...extra };
}

/** 404 response (negative-cache style: no body). */
export function notFound(): Partial<HttpResult> {
  return { status: 404, data: null };
}

/** Failed request: `status` defaults to 0 for network-level errors, 429 for rate_limited. */
export function failure(
  error: NonNullable<HttpResult['error']>,
  extra: Partial<HttpResult> = {},
): Partial<HttpResult> {
  const status = error === 'rate_limited' ? 429 : error === 'http' ? 500 : 0;
  return { status, data: null, error, ...extra };
}

export class FakeHttpClient implements HttpClient {
  readonly calls: FakeCall[] = [];
  private readonly routes: { match: UrlMatcher; response: FakeResponse }[] = [];

  /**
   * `routes` maps exact URL strings to responses. Unmatched URLs throw, so a
   * test never silently depends on a URL it did not declare.
   */
  constructor(
    routes: Record<string, FakeResponse> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const [url, response] of Object.entries(routes)) this.set(url, response);
  }

  /** Adds a route. When several routes match a URL, the most recently added one wins. */
  set(match: UrlMatcher, response: FakeResponse): this {
    this.routes.push({ match, response });
    return this;
  }

  /** URLs requested so far, in order. */
  get urls(): string[] {
    return this.calls.map((c) => c.url);
  }

  reset(): void {
    this.calls.length = 0;
  }

  async getJson<T = unknown>(url: string, opts: HttpRequestOptions): Promise<HttpResult<T>> {
    this.calls.push({ url, opts });
    const route = this.routes.findLast((r) => matches(r.match, url));
    if (!route) throw new Error(`FakeHttpClient: no route for ${url}`);
    const partial =
      typeof route.response === 'function' ? await route.response(url, opts) : route.response;
    return {
      status: 200,
      data: null,
      headers: {},
      provenance: 'live',
      fetched_at: this.now().toISOString(),
      ...partial,
    } as HttpResult<T>;
  }
}

function matches(m: UrlMatcher, url: string): boolean {
  if (typeof m === 'string') return m === url;
  if (m instanceof RegExp) return m.test(url);
  return m(url);
}
