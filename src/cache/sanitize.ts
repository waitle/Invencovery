/**
 * Upload sanitizer for the shared remote cache (docs/PLAN.md §9.4 rule 3).
 *
 * `sanitize(entry)` decides what, if anything, of a cache entry may leave the
 * machine. It returns a new entry that is safe to upload, or `undefined` when
 * the entry must not be uploaded at all.
 *
 * It works on the entry alone: by the time an entry reaches here the URL is
 * already gone (`url_redacted` is blank and the key is a hash), so decisions
 * are made from `source` and the shape of the JSON body. Rules:
 * - only `SHAREABLE_SOURCES`; `librariesio` (key-bound data policy) and unknown
 *   sources are never uploaded;
 * - only status 200 (valid JSON, at most `MAX_SHARE_BODY_BYTES`) and 404
 *   (body forced to `null`);
 * - `github_repo` search results: items that are not provably public
 *   (`private === false`, `visibility` absent or `public`) are removed and
 *   `total_count` is reduced accordingly;
 * - `github_repo` repo details: uploaded only when provably public;
 * - other `github_repo` bodies (releases, contributors, ...) carry no
 *   visibility information, so they are not uploaded;
 * - `github_code` results: uploaded only when every hit's repository is
 *   provably public;
 * - a body containing something shaped like a GitHub token is never uploaded;
 * - only `etag` and `last_modified` survive from the response headers.
 *
 * Pure: no I/O, never throws, and it is idempotent, so applying it both in the
 * client and again in the server is harmless.
 */
import type { CacheEntry } from '../types.js';

/** Sources whose responses may be shared (`librariesio` is deliberately absent). */
export const SHAREABLE_SOURCES: readonly string[] = [
  'github_repo',
  'github_code',
  'npm',
  'pypi',
  'mcp_registry',
  'hf_models',
  'depsdev',
];

/** Largest response body (UTF-8 bytes) that is uploaded. */
export const MAX_SHARE_BODY_BYTES = 1_000_000;

const MAX_VALIDATOR_LENGTH = 512;
// ghp_/gho_/ghu_/ghs_/ghr_ tokens and github_pat_ fine-grained PATs.
const TOKEN_PATTERN = /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True only when the object positively says it is a public repository. */
function isPublicRepo(value: unknown): boolean {
  if (!isRecord(value) || value.private !== false) return false;
  return value.visibility === undefined || value.visibility === 'public';
}

function sanitizeGithubRepoBody(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined; // arrays (contributors) carry no visibility
  if (Array.isArray(data.items)) {
    const kept = data.items.filter(isPublicRepo);
    const out: JsonObject = { ...data, items: kept };
    if (typeof data.total_count === 'number') {
      out.total_count = Math.max(0, data.total_count - (data.items.length - kept.length));
    }
    return JSON.stringify(out);
  }
  if (typeof data.full_name === 'string') {
    return isPublicRepo(data) ? JSON.stringify(data) : undefined;
  }
  return undefined;
}

function sanitizeGithubCodeBody(data: unknown): string | undefined {
  if (!isRecord(data) || !Array.isArray(data.items)) return undefined;
  for (const item of data.items) {
    if (!isRecord(item) || !isPublicRepo(item.repository)) return undefined;
  }
  return JSON.stringify(data);
}

/** Returns an entry that is safe to upload, or `undefined` when it must stay local. */
export function sanitize(entry: CacheEntry): CacheEntry | undefined {
  try {
    if (!SHAREABLE_SOURCES.includes(entry.source)) return undefined;
    if (entry.status !== 200 && entry.status !== 404) return undefined;
    if (typeof entry.body !== 'string') return undefined;
    if (!Number.isFinite(entry.fetched_at) || !Number.isFinite(entry.expires_at)) return undefined;

    let body: string;
    if (entry.status === 404) {
      body = 'null';
    } else {
      if (Buffer.byteLength(entry.body) > MAX_SHARE_BODY_BYTES) return undefined;
      if (TOKEN_PATTERN.test(entry.body)) return undefined;
      let data: unknown;
      try {
        data = JSON.parse(entry.body);
      } catch {
        return undefined;
      }
      let cleaned: string | undefined = entry.body;
      if (entry.source === 'github_repo') cleaned = sanitizeGithubRepoBody(data);
      else if (entry.source === 'github_code') cleaned = sanitizeGithubCodeBody(data);
      if (cleaned === undefined || Buffer.byteLength(cleaned) > MAX_SHARE_BODY_BYTES) return undefined;
      body = cleaned;
    }

    const out: CacheEntry = {
      key: entry.key,
      url_redacted: '',
      source: entry.source,
      status: entry.status,
      body,
      fetched_at: entry.fetched_at,
      expires_at: entry.expires_at,
      provenance: entry.provenance,
    };
    if (typeof entry.etag === 'string' && entry.etag !== '' && entry.etag.length <= MAX_VALIDATOR_LENGTH) {
      out.etag = entry.etag;
    }
    if (
      typeof entry.last_modified === 'string' &&
      entry.last_modified !== '' &&
      entry.last_modified.length <= MAX_VALIDATOR_LENGTH
    ) {
      out.last_modified = entry.last_modified;
    }
    return out;
  } catch {
    return undefined;
  }
}
