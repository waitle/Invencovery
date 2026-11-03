/**
 * Local `node:http` server for tests (HTTP client, cache server, remote cache).
 * Binds 127.0.0.1 on an ephemeral port and records every request.
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type TestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void | Promise<void>;

export interface TestServer {
  /** `http://127.0.0.1:<port>` without a trailing slash. */
  url: string;
  port: number;
  /** Every request received, in arrival order. */
  requests: RecordedRequest[];
  /** Replaces the handler; the previous one is discarded. */
  setHandler(handler: TestHandler): void;
  close(): Promise<void>;
}

/** Writes a JSON response. `Content-Length` is set so clients can reuse the connection. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

const notFoundHandler: TestHandler = (_req, res) => {
  sendJson(res, 404, { error: 'not found' });
};

export async function startTestServer(handler: TestHandler = notFoundHandler): Promise<TestServer> {
  let current = handler;
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body,
      });
      Promise.resolve(current(req, res, body)).catch((err: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
        else res.destroy();
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    setHandler(h) {
      current = h;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
