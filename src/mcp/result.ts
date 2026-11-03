/**
 * Small helpers for building MCP tool results (docs/PLAN.md §7 common rules):
 * every success carries `structuredContent` plus a concise Markdown summary in
 * `content[0].text`; every failure is `isError: true` with a sentence the agent
 * can act on. Error text is always passed through the GitHub token redactor.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redactGithubToken } from '../auth/github-token.js';
import { stripUnsafe } from '../core/sanitize.js';

export function okResult(text: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: redactGithubToken(text) }],
    structuredContent: structured,
  };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: redactGithubToken(message) }] };
}

/** A safe, token-free message for an unexpected exception. */
export function errorMessage(err: unknown): string {
  return redactGithubToken(err instanceof Error ? err.message : String(err));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line without control or invisible characters, `|` escaped, so a value fits one Markdown table cell. */
export function mdCell(text: string): string {
  return stripUnsafe(text).replace(/\|/g, '\\|');
}
