import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROMPT_NAME,
  SERVER_INSTRUCTIONS,
  TOOL_NAMES,
  UNTRUSTED_DATA_WARNING,
  buildWorkflowPrompt,
  createServer,
  loadWorkflowBody,
  stripFrontmatter,
  toolModuleFrom,
} from '../../../src/mcp/server.js';
import type { ToolModule } from '../../../src/types.js';
import { cleanupTmpDirs } from '../../helpers/tmp.js';
import { makeCtx } from './_t20-helpers.js';

let client: Client | undefined;
let server: McpServer | undefined;
afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
  cleanupTmpDirs();
});

async function start(opts: Parameters<typeof createServer>[1] = {}) {
  const { ctx } = makeCtx();
  server = createServer(ctx, opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe('createServer', () => {
  it('lists the eight tools, each with input and output schemas', async () => {
    const c = await start();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.inputSchema, t.name).toBeDefined();
      expect(t.outputSchema, t.name).toBeDefined();
    }
  });

  it('lists the reuse_first_workflow prompt and returns the SKILL.md body', async () => {
    const c = await start();
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual([PROMPT_NAME]);

    const plain = await c.getPrompt({ name: PROMPT_NAME });
    const text = (plain.messages[0]?.content as { text: string }).text;
    expect(text).not.toMatch(/^---/);
    expect(text).not.toContain('description: >-');
    expect(text).toContain('rw_status');
    expect(text.trimEnd().endsWith('skills/recyclewheel/reference/.')).toBe(true);

    const withTask = await c.getPrompt({ name: PROMPT_NAME, arguments: { task: 'build a markdown to pdf CLI' } });
    const t2 = (withTask.messages[0]?.content as { text: string }).text;
    expect(t2).toContain('Apply this workflow to: build a markdown to pdf CLI');
    expect(t2.indexOf('Apply this workflow to')).toBeLessThan(t2.indexOf('reference documents'));
  });

  it('skips the prompt and warns when SKILL.md is unavailable', async () => {
    const warnings: string[] = [];
    const c = await start({ workflowBody: null, warn: (m) => warnings.push(m) });
    expect(c.getServerCapabilities()?.prompts).toBeUndefined();
    expect(warnings.join(' ')).toContain('SKILL.md');
  });

  it('registers only the modules it is given', async () => {
    const tool: ToolModule = {
      name: 'rw_x',
      register: (s) => {
        s.registerTool('rw_x', { description: 'x' }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      },
    };
    const c = await start({ tools: [tool], workflowBody: 'body' });
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['rw_x']);
  });
});

describe('workflow helpers', () => {
  it('strips frontmatter (LF and CRLF) and keeps bodies without it', () => {
    expect(stripFrontmatter('---\nname: a\ndescription: >-\n  x\n---\n\n# Title\nbody\n')).toBe('# Title\nbody');
    expect(stripFrontmatter('---\r\nname: a\r\n---\r\n# T')).toBe('# T');
    expect(stripFrontmatter('# no frontmatter')).toBe('# no frontmatter');
  });

  it('loads the body relative to the module URL, trying each layout', () => {
    const seen: string[] = [];
    const body = loadWorkflowBody('file:///repo/src/mcp/server.ts', (url) => {
      seen.push(url.href);
      if (url.href === 'file:///repo/skills/recyclewheel/SKILL.md') return '---\nname: x\n---\nhello';
      throw new Error('ENOENT');
    });
    expect(body).toBe('hello');
    expect(seen).toEqual(['file:///repo/src/skills/recyclewheel/SKILL.md', 'file:///repo/skills/recyclewheel/SKILL.md']);
    expect(loadWorkflowBody('file:///x/dist/cli.js', () => { throw new Error('ENOENT'); })).toBeUndefined();
  });

  it('puts the reference note last, after the optional task', () => {
    const text = buildWorkflowPrompt('BODY', '  do x  ');
    expect(text).toBe(
      `BODY\n\n${UNTRUSTED_DATA_WARNING}\n\nApply this workflow to: do x\n\nThe reference documents (scoring, license-matrix, manual-mode) live in the repository at skills/recyclewheel/reference/.`,
    );
    expect(buildWorkflowPrompt('BODY')).not.toContain('Apply this workflow');
  });
});

describe('toolModuleFrom', () => {
  const register = () => undefined;
  it('accepts a named ToolModule export, a default export, or a register function', () => {
    const mod = { name: 'rw_a', register };
    expect(toolModuleFrom({ aTool: mod }, 'rw_a', 'a.ts')).toBe(mod);
    expect(toolModuleFrom({ default: mod }, 'rw_a', 'a.ts')).toBe(mod);
    expect(toolModuleFrom({ registerATool: register }, 'rw_a', 'a.ts').name).toBe('rw_a');
  });
  it('throws a clear error when nothing matches', () => {
    expect(() => toolModuleFrom({ x: 1 }, 'rw_a', 'src/mcp/tools/a.ts')).toThrow(/src\/mcp\/tools\/a\.ts must export/);
  });
});

describe('untrusted third-party data guidance', () => {
  it('sends server instructions that name the fence and the trust rules', async () => {
    const c = await start();
    const instructions = c.getInstructions() ?? '';
    expect(instructions).toContain(UNTRUSTED_DATA_WARNING);
    expect(instructions).toContain('<untrusted_third_party_data>');
    expect(instructions).toContain('rw_decide');
    expect(instructions).toContain('write_to');
    expect(instructions).toContain('rw_status'); // the original guidance is still there
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it('puts the same warning in the reuse_first_workflow prompt, before the reference note', async () => {
    const c = await start();
    const withTask = await c.getPrompt({ name: PROMPT_NAME, arguments: { task: 'x' } });
    const text = (withTask.messages[0]?.content as { text: string }).text;
    expect(text).toContain(UNTRUSTED_DATA_WARNING);
    expect(text.indexOf(UNTRUSTED_DATA_WARNING)).toBeLessThan(text.indexOf('Apply this workflow to'));
    expect(text.trimEnd().endsWith('skills/recyclewheel/reference/.')).toBe(true);
  });
});
