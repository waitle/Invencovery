import { describe, expect, it } from 'vitest';
import {
  EXPORT_MARKER_MD,
  escapeMd,
  reduceEvents,
  renderMarkdown,
  renderNotices,
  safeUrl,
  stripUnsafe,
} from '../../../src/core/ledger.js';
import type { Decision, LedgerEvent, ProjectInfo } from '../../../src/types.js';

const AT = '2026-10-01T00:00:00.000Z';
const ch = (...cps: number[]): string => cps.map((cp) => String.fromCodePoint(cp)).join('');

/** Control, zero-width, bidi and tag characters that must never reach an export. */
const HIDDEN = ch(
  0x0000, 0x0007, 0x001b, 0x007f, 0x0085, 0x009f, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0xe0041, 0xe007f,
);
const hiddenChars = [...HIDDEN];

function ev(type: string, payload: unknown): LedgerEvent {
  return { v: 1, type, at: AT, [type.split('.')[0] as string]: payload } as unknown as LedgerEvent;
}

function decision(over: Partial<Decision>): Decision {
  return {
    id: 'dec_1',
    component_id: 'c1',
    decision: 'adopt',
    ref: 'npm:lib',
    rationale: 'ok',
    alternatives: [],
    evidence_ids: [],
    decided_at: AT,
    decided_by: 'agent',
    ...over,
  };
}

const INJECTED_LINK = '[x](javascript:alert(1))';
const INJECTED_HTML = '<img src=x onerror=1>';
const INJECTED_HEADING = 'line one\n# fake heading\n- fake bullet';

const project: ProjectInfo = {
  name: `Proj ${INJECTED_LINK}`,
  summary: `${INJECTED_HTML} ${HIDDEN} ${INJECTED_HEADING}`,
  license: 'MIT',
  distribution: 'application',
  ecosystems: ['npm', '[e](javascript:1)' as ProjectInfo['ecosystems'][number]],
};

const state = reduceEvents([
  { v: 1, type: 'project.set', at: AT, project },
  ev('component.upsert', {
    id: 'c1',
    name: `Comp ${INJECTED_LINK} ${INJECTED_HTML}`,
    description: 'd',
    keywords: ['k'],
    status: 'pending',
  }),
  ev('component.upsert', { id: 'c2', name: `Und ${INJECTED_HEADING}${HIDDEN}`, description: 'd', keywords: ['k'], status: 'pending' }),
  ev(
    'decision.add',
    decision({
      version: `1.0${HIDDEN}\n# v`,
      rationale: `${INJECTED_LINK} ${INJECTED_HTML}\n# fake heading\n| a | b |\n${HIDDEN}`,
      alternatives: [{ ref: 'github:o/alt', why_not: `${INJECTED_LINK}\n## injected` }],
      override: { reason: `${INJECTED_HTML}\n### injected override` },
      attribution: {
        source_url: 'javascript:alert(1)',
        license: `MIT\n# lic ${HIDDEN}`,
        copyright: `(c) <script>alert(1)</script>\n# copyright ${HIDDEN}`,
        revision: `abc\n# rev`,
        files: [`src/a.ts\n# file`, INJECTED_LINK],
      },
    }),
  ),
]);

function lines(text: string): string[] {
  return text.split('\n');
}

describe('stripUnsafe / escapeMd', () => {
  it('removes control, zero-width, bidi and tag characters and folds line breaks', () => {
    const out = stripUnsafe(`a${HIDDEN}b\r\nc\td${ch(0x2028)}e`);
    for (const c of hiddenChars) expect(out).not.toContain(c);
    expect(out).toBe('a b c d e'); // U+0085 and U+2028 are line separators, folded to a space
  });

  it('neutralises Markdown and HTML syntax', () => {
    expect(escapeMd(INJECTED_LINK)).toBe('\\[x\\]\\(javascript:alert\\(1\\)\\)');
    expect(escapeMd(INJECTED_HTML)).toBe('&lt;img src=x onerror=1&gt;');
    expect(escapeMd('a|b `c` *d* _e_ # f')).toBe('a\\|b \\`c\\` \\*d\\* \\_e\\_ \\# f');
    expect(escapeMd('back\\slash')).toBe('back\\\\slash');
    expect(escapeMd('&lt;b&gt; and R&D')).toBe('&amp;lt;b&amp;gt; and R&D');
  });

  it('leaves ordinary text, including Korean, alone', () => {
    expect(escapeMd('Mature renderer, v1.2.3 -- 한글 설명')).toBe('Mature renderer, v1.2.3 -- 한글 설명');
  });
});

describe('safeUrl', () => {
  it('passes http(s) URLs through in normalised form', () => {
    expect(safeUrl('https://github.com/o/r')).toBe('https://github.com/o/r');
    expect(safeUrl('HTTP://Example.COM/a b')).toBe('http://example.com/a%20b');
    expect(safeUrl('https://x.test/(a)[b]|c')).toBe('https://x.test/%28a%29%5Bb%5D%7Cc');
    expect(safeUrl('https://x.test/<script>')).not.toMatch(/[<>]/);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>1</script>',
    'vbscript:x',
    'file:///etc/passwd',
    'ftp://x.test/a',
    '//evil.test/x',
    'not a url',
    'mcp:io.github/x',
  ])('turns %s into inert code', (u) => {
    const out = safeUrl(u);
    expect(out.startsWith('`')).toBe(true);
    expect(out.endsWith('`')).toBe(true);
  });

  it('strips hidden characters before judging the scheme', () => {
    expect(safeUrl(`java${ch(0x200b)}script:alert(1)`)).toBe('`javascript:alert(1)`');
    expect(safeUrl(`${ch(0x202e)}https://x.test/`)).toBe('https://x.test/');
  });
});

describe('rendered exports are injection-safe', () => {
  const md = renderMarkdown(state);
  const notices = renderNotices(state);

  it.each([
    ['markdown', md],
    ['notices', notices],
  ])('%s: no hidden characters', (_n, out) => {
    for (const c of hiddenChars) expect(out).not.toContain(c);
  });

  it.each([
    ['markdown', md],
    ['notices', notices],
  ])('%s: no live link, raw HTML, or injected block', (_n, out) => {
    expect(out).not.toMatch(/\]\(javascript:/i);
    expect(out).not.toMatch(/<(img|script)/i);
    expect(out).not.toMatch(/^#+ (fake|injected|lic|copyright|rev|file|v)/im);
    expect(out).not.toMatch(/^- fake bullet/m);
    expect(out).toContain('&lt;');
  });

  it('markdown starts with the export marker and only our own headings appear', () => {
    expect(lines(md)[0]).toBe(EXPORT_MARKER_MD);
    const headings = lines(md).filter((l) => l.startsWith('#'));
    expect(headings).toEqual(['# Reuse Report', '## Decisions', '## Undecided components', '## Alternatives considered', '### Comp \\[x\\]\\(javascript:alert\\(1\\)\\) &lt;img src=x onerror=1&gt;', '## Cross-cutting checks', '## Overrides']);
  });

  it('markdown: the decision stays a single table row with the expected cell count', () => {
    const rows = lines(md).filter((l) => l.startsWith('| Comp \\['));
    expect(rows, md).toHaveLength(1);
    // 7 columns => 8 unescaped pipes
    expect(rows[0]?.split(/(?<!\\)\|/)).toHaveLength(9);
  });

  it('notices: starts with the marker, only our headings, javascript: URL is inert code', () => {
    expect(lines(notices)[0]).toBe(EXPORT_MARKER_MD);
    const headings = lines(notices).filter((l) => l.startsWith('#'));
    expect(headings).toEqual(['# Third-Party Notices (draft)', '## lib']);
    expect(lines(notices)).toContain('- URL: `javascript:alert(1)`');
    expect(notices).toContain('- Files: src/a.ts \\# file, \\[x\\]\\(javascript:alert\\(1\\)\\)');
  });

  it('a clean ledger still renders https URLs as plain autolinkable text', () => {
    const clean = reduceEvents([
      ev('component.upsert', { id: 'a', name: 'A', description: 'd', keywords: ['k'], status: 'pending' }),
      ev('decision.add', decision({ component_id: 'a', attribution: { source_url: 'https://github.com/o/r', license: 'MIT' } })),
    ]);
    expect(renderNotices(clean)).toContain('- URL: https://github.com/o/r\n');
  });
});
