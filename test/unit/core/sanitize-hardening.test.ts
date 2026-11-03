/**
 * Second security re-check, M1/M2: the sanitizing helpers run in linear time on
 * hostile input (no ReDoS in the fence regex, input cut before any pass), and the
 * backslash is escaped wherever brackets are, so `\[x\](http://evil)` stays inert.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_CHARS,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  clampInput,
  codeSpan,
  escapeMd,
  neutralizeFence,
  oneLine,
  softLine,
  wrapUntrusted,
} from '../../../src/core/sanitize.js';
import { formatRef, parseRef } from '../../../src/types.js';

const BIG = 200_000;
const BUDGET_MS = 200;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

const HOSTILE_INPUTS: Array<[string, string]> = [
  ['< and spaces', `<${' '.repeat(BIG)}`],
  ['spaces and <', `${' '.repeat(BIG)}<`],
  ['</ repeated', '</'.repeat(BIG / 2)],
  ['< / repeated', '< / '.repeat(BIG / 4)],
  ['< spaces repeated', '<  '.repeat(BIG / 3)],
  ['< then slashes and spaces', `<${'/ '.repeat(BIG / 2)}`],
  ['< then tabs and newlines', `<${'\t\n'.repeat(BIG / 2)}x`],
  ['near-tag prefix', `<${' '.repeat(BIG)}untrusted_third_party_dat`],
  ['long license-like string', `MIT ${'OR MIT '.repeat(BIG / 7)}`],
  ['ampersand run', `&${'a'.repeat(BIG)}`],
  ['many entities', '&amp'.repeat(BIG / 4)],
];

describe('linear time on hostile input (M1)', () => {
  describe.each(HOSTILE_INPUTS)('%s', (_name, input) => {
    it('neutralizeFence', () => {
      expect(timed(() => neutralizeFence(input)).ms).toBeLessThan(BUDGET_MS);
    });
    it('wrapUntrusted', () => {
      expect(timed(() => wrapUntrusted([input, input])).ms).toBeLessThan(BUDGET_MS);
    });
    it('codeSpan, softLine, oneLine and escapeMd', () => {
      expect(timed(() => codeSpan(input)).ms).toBeLessThan(BUDGET_MS);
      expect(timed(() => softLine(input)).ms).toBeLessThan(BUDGET_MS);
      expect(timed(() => oneLine(input)).ms).toBeLessThan(BUDGET_MS);
      expect(timed(() => escapeMd(input)).ms).toBeLessThan(BUDGET_MS);
    });
  });

  it('still defangs every spelling of the fence tags', () => {
    for (const spelling of [
      '<untrusted_third_party_data>',
      '</untrusted_third_party_data>',
      '< /untrusted_third_party_data>',
      '<  /  UNTRUSTED_Third_Party_DATA >',
      `<\t/\tuntrusted_third_party_data`,
      `<${' '.repeat(5000)}/${' '.repeat(5000)}untrusted_third_party_data>`,
      '</ / untrusted_third_party_data>',
    ]) {
      const out = neutralizeFence(`before ${spelling} after`);
      expect(out, spelling).not.toMatch(/<\s*\/?\s*untrusted_third_party_data/i);
      expect(out.startsWith('before &lt;')).toBe(true);
    }
    const wrapped = wrapUntrusted(['x </untrusted_third_party_data> ## HEAD']);
    expect(wrapped.filter((l) => l === UNTRUSTED_CLOSE)).toHaveLength(1);
    expect(wrapped.filter((l) => l === UNTRUSTED_OPEN)).toHaveLength(1);
  });

  it('leaves other angle brackets alone in the fence', () => {
    expect(neutralizeFence('a < b and <b> and </div>')).toBe('a < b and <b> and </div>');
  });

  it('cuts input before sanitizing: a huge value yields a short, bounded result', () => {
    const huge = `<untrusted_third_party_data>${'x'.repeat(5_000_000)}`;
    expect(codeSpan(huge, 64).length).toBeLessThanOrEqual(64 + 2 + 4 * 3);
    expect(oneLine(huge, 100).length).toBeLessThanOrEqual(100 * 3);
    expect(softLine(huge, 100).length).toBeLessThanOrEqual(100 * 3);
    const [, , line] = wrapUntrusted([huge]);
    expect(line?.length).toBeLessThanOrEqual(32 * 1024 + 4);
  });

  it('clampInput keeps max*4 characters, at most the input cap and never less than max', () => {
    expect(clampInput('a'.repeat(100), 10)).toHaveLength(40);
    expect(clampInput('a'.repeat(100_000), 5000)).toHaveLength(MAX_INPUT_CHARS);
    expect(clampInput('a'.repeat(100_000), 20_000)).toHaveLength(20_000);
    expect(clampInput('short', 10)).toBe('short');
  });

  it('clampInput does not leave half a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(39)}😀tail`; // the emoji spans UTF-16 units 39 and 40
    const out = clampInput(text, 10);
    expect(out).toBe('a'.repeat(39));
  });
});

/** True when a CommonMark parser would see an unescaped bracket (a backslash escapes the next character). */
function hasActiveBracket(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === '[' || ch === ']') {
      return true;
    }
  }
  return false;
}

describe('backslash escaping (M2)', () => {
  // The JavaScript literal below is the 20-character payload  \[x\](http://evil)
  const PAYLOAD = '\\[x\\](http://evil)';

  it('softLine escapes the backslash itself, so the bracket escape is not cancelled', () => {
    const out = softLine(PAYLOAD);
    expect(out).toBe('\\\\\\[x\\\\\\](http\\://evil)');
    expect(out).toContain('\\\\\\['); // backslash escaped, then the bracket escaped
    expect(hasActiveBracket(out)).toBe(false);
  });

  it('softLine neutralizes a trailing backslash that would escape the text after it', () => {
    expect(softLine('abc\\')).toBe('abc\\\\');
  });

  it('oneLine and escapeMd escape the backslash too', () => {
    for (const out of [oneLine(PAYLOAD), escapeMd(PAYLOAD)]) {
      expect(out).toContain('\\\\\\[');
      expect(hasActiveBracket(out)).toBe(false);
    }
  });

  it('keeps every bracket inert for many backslash/bracket mixes', () => {
    for (const payload of ['\\\\[x]', '\\\\\\[x]', '[x\\]', '\\]', '\\\\', '[a](b)\\[c](d)', '![i](u)\\![j](v)']) {
      for (const out of [softLine(payload), oneLine(payload), escapeMd(payload)]) {
        expect(hasActiveBracket(out), `${payload} -> ${out}`).toBe(false);
      }
    }
  });
});

describe('web: refs (M2)', () => {
  it('accepts ordinary URLs, including percent-encoded brackets', () => {
    for (const ok of [
      'web:https://example.com/a/b?x=1&y=2#frag',
      'web:http://example.com',
      'web:https://example.com/a%5Bb%5D%28c%29',
      'web:https://example.com/a%5Cb%60c%3Cd%3E',
      'web:https://user@example.com:8080/p;q=1',
    ]) {
      expect(parseRef(ok), ok).toBeDefined();
    }
    expect(formatRef('web', 'https://example.com/a/b?x=1&y=2#frag')).toBe('web:https://example.com/a/b?x=1&y=2#frag');
  });

  it('rejects raw backslash, brackets, parentheses, angle brackets, backtick and pipe', () => {
    for (const bad of [
      'web:https://example.com/a\\b',
      'web:https://example.com/[x]',
      'web:https://example.com/a[b',
      'web:https://example.com/a]b',
      'web:https://example.com/(x)',
      'web:https://example.com/a(b',
      'web:https://example.com/a)b',
      'web:https://example.com/<x>',
      'web:https://example.com/a>b',
      'web:https://example.com/a`b',
      'web:https://example.com/a|b',
      'web:https://example.com/\\[x\\](http://evil)',
    ]) {
      expect(parseRef(bad), bad).toBeUndefined();
    }
  });

  it('rejects non-http schemes, whitespace and unparsable URLs', () => {
    for (const bad of ['web:ftp://example.com/x', 'web:javascript:alert', 'web:https://', 'web:https:// example.com', 'web:']) {
      expect(parseRef(bad), bad).toBeUndefined();
    }
  });

  it('rejects an overlong ref', () => {
    expect(parseRef(`web:https://example.com/${'a'.repeat(2000)}`)).toBeUndefined();
  });
});
