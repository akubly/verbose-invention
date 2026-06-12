import { describe, it, expect } from 'vitest';
import { formatForTransport } from '../../../src/channel/teams/formatting.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand: verify output contains a substring. */
function expectContains(input: string, fragment: string): void {
  expect(formatForTransport(input)).toContain(fragment);
}

// ---------------------------------------------------------------------------
// Edge cases — empty / trivial
// ---------------------------------------------------------------------------

describe('formatForTransport — empty / trivial', () => {
  it('returns empty string for empty input', () => {
    expect(formatForTransport('')).toBe('');
  });

  it('returns plain text unchanged (no special chars)', () => {
    expect(formatForTransport('Hello world')).toBe('Hello world');
  });

  it('normalises CRLF to LF before processing', () => {
    const result = formatForTransport('line1\r\nline2');
    expect(result).toBe('line1<br>line2');
  });
});

// ---------------------------------------------------------------------------
// HTML escaping — plain text segments
// ---------------------------------------------------------------------------

describe('formatForTransport — HTML escaping in plain text', () => {
  it('escapes & in plain text', () => {
    expect(formatForTransport('AT&T')).toBe('AT&amp;T');
  });

  it('escapes < in plain text', () => {
    expect(formatForTransport('a < b')).toBe('a &lt; b');
  });

  it('escapes > in plain text', () => {
    expect(formatForTransport('a > b')).toBe('a &gt; b');
  });

  it('escapes angle-bracket-looking content that is not HTML', () => {
    expect(formatForTransport('<not-html>')).toBe('&lt;not-html&gt;');
  });

  it('escapes a script injection attempt', () => {
    const out = formatForTransport('<script>alert("xss")</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes multiple HTML special chars in one string', () => {
    expect(formatForTransport('x < y && y > z')).toBe('x &lt; y &amp;&amp; y &gt; z');
  });

  it('leaves unicode / emoji untouched', () => {
    expect(formatForTransport('Hello 🎉 world')).toBe('Hello 🎉 world');
  });

  it('leaves non-ASCII unicode untouched', () => {
    expect(formatForTransport('café naïve résumé')).toBe('café naïve résumé');
  });

  it('handles a long message without truncation', () => {
    const long = 'A'.repeat(5000);
    expect(formatForTransport(long)).toBe(long);
  });
});

// ---------------------------------------------------------------------------
// Inline code
// ---------------------------------------------------------------------------

describe('formatForTransport — inline code', () => {
  it('wraps inline code in <code>', () => {
    expect(formatForTransport('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('HTML-escapes content inside inline code', () => {
    expect(formatForTransport('`a < b`')).toBe('<code>a &lt; b</code>');
  });

  it('HTML-escapes & inside inline code', () => {
    expect(formatForTransport('`x && y`')).toBe('<code>x &amp;&amp; y</code>');
  });

  it('does not apply markdown formatting inside inline code', () => {
    expect(formatForTransport('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('handles inline code at start of string', () => {
    expect(formatForTransport('`code` then text')).toBe('<code>code</code> then text');
  });

  it('handles inline code at end of string', () => {
    expect(formatForTransport('text then `code`')).toBe('text then <code>code</code>');
  });
});

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

describe('formatForTransport — fenced code blocks', () => {
  it('wraps a plain code fence in <pre><code>', () => {
    const input = '```\nconst x = 1;\n```';
    expect(formatForTransport(input)).toBe('<pre><code>const x = 1;</code></pre>');
  });

  it('wraps a language-tagged fence in <pre><code> (lang ignored)', () => {
    const input = '```typescript\nconst x: number = 1;\n```';
    expect(formatForTransport(input)).toBe('<pre><code>const x: number = 1;</code></pre>');
  });

  it('HTML-escapes < > & inside a code fence', () => {
    const input = '```\na < b && c > d\n```';
    expect(formatForTransport(input)).toBe('<pre><code>a &lt; b &amp;&amp; c &gt; d</code></pre>');
  });

  it('preserves multi-line content inside a fence', () => {
    const input = '```\nline one\nline two\n```';
    expect(formatForTransport(input)).toBe('<pre><code>line one\nline two</code></pre>');
  });

  it('does not apply markdown formatting inside a fence', () => {
    const input = '```\n**not bold** `not code`\n```';
    expect(formatForTransport(input)).toBe('<pre><code>**not bold** `not code`</code></pre>');
  });

  it('handles text before and after a fence', () => {
    const input = 'intro\n```\ncode\n```\noutro';
    const out = formatForTransport(input);
    expect(out).toContain('intro');
    expect(out).toContain('<pre><code>code</code></pre>');
    expect(out).toContain('outro');
  });

  it('handles multiple code fences', () => {
    const input = '```\nfirst\n```\nmiddle\n```\nsecond\n```';
    const out = formatForTransport(input);
    expect(out).toContain('<pre><code>first</code></pre>');
    expect(out).toContain('<pre><code>second</code></pre>');
    expect(out).toContain('middle');
  });

  it('preserves HTML-special chars in a JS code fence', () => {
    const input = '```js\nif (a && b) { return a < b ? a : b; }\n```';
    expectContains(input, 'a &amp;&amp; b');
    expectContains(input, 'a &lt; b');
  });
});

// ---------------------------------------------------------------------------
// Bold
// ---------------------------------------------------------------------------

describe('formatForTransport — bold', () => {
  it('converts **text** to <b>text</b>', () => {
    expect(formatForTransport('**bold**')).toBe('<b>bold</b>');
  });

  it('converts __text__ to <b>text</b>', () => {
    expect(formatForTransport('__bold__')).toBe('<b>bold</b>');
  });

  it('handles bold mid-sentence', () => {
    expect(formatForTransport('This is **important** text')).toBe('This is <b>important</b> text');
  });

  it('HTML-escapes plain text around bold', () => {
    expect(formatForTransport('x < **bold** > y')).toBe('x &lt; <b>bold</b> &gt; y');
  });

  it('handles multiple bold spans on one line', () => {
    expect(formatForTransport('**a** and **b**')).toBe('<b>a</b> and <b>b</b>');
  });
});

// ---------------------------------------------------------------------------
// Italic
// ---------------------------------------------------------------------------

describe('formatForTransport — italic', () => {
  it('converts *text* to <i>text</i>', () => {
    expect(formatForTransport('*italic*')).toBe('<i>italic</i>');
  });

  it('converts _text_ to <i>text</i>', () => {
    expect(formatForTransport('_italic_')).toBe('<i>italic</i>');
  });

  it('handles italic mid-sentence', () => {
    expect(formatForTransport('This is *important* text')).toBe('This is <i>important</i> text');
  });

  it('handles multiple italic spans on one line', () => {
    expect(formatForTransport('*a* and *b*')).toBe('<i>a</i> and <i>b</i>');
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('formatForTransport — links', () => {
  it('converts [text](url) to <a href="url">text</a>', () => {
    expect(formatForTransport('[GitHub](https://github.com)')).toBe(
      '<a href="https://github.com">GitHub</a>',
    );
  });

  it('escapes & in link URL to &amp;', () => {
    expect(formatForTransport('[page](https://example.com?a=1&b=2)')).toBe(
      '<a href="https://example.com?a=1&amp;b=2">page</a>',
    );
  });

  it('escapes " in link URL to &quot;', () => {
    expect(formatForTransport('[x](http://example.com/path"q)')).toContain('&quot;');
  });

  it('escapes < > in link URL', () => {
    const out = formatForTransport('[x](http://example.com/<path>)');
    expect(out).toContain('&lt;');
    expect(out).toContain('&gt;');
  });

  it('processes inline formatting inside link text', () => {
    expect(formatForTransport('[**bold link**](https://example.com)')).toBe(
      '<a href="https://example.com"><b>bold link</b></a>',
    );
  });

  it('HTML-escapes < in link text', () => {
    const out = formatForTransport('[a < b](https://example.com)');
    expect(out).toContain('&lt;');
  });
});

// ---------------------------------------------------------------------------
// Line breaks
// ---------------------------------------------------------------------------

describe('formatForTransport — line breaks', () => {
  it('joins two consecutive non-blank lines with <br>', () => {
    expect(formatForTransport('line1\nline2')).toBe('line1<br>line2');
  });

  it('converts a blank line to a <br> separator', () => {
    const out = formatForTransport('para1\n\npara2');
    // blank line becomes its own <br> block between the two paragraphs
    expect(out).toBe('para1<br><br>para2');
  });

  it('handles three consecutive lines', () => {
    expect(formatForTransport('a\nb\nc')).toBe('a<br>b<br>c');
  });
});

// ---------------------------------------------------------------------------
// Unordered lists
// ---------------------------------------------------------------------------

describe('formatForTransport — unordered lists', () => {
  it('wraps "- items" in <ul><li>...', () => {
    const input = '- alpha\n- beta\n- gamma';
    const out = formatForTransport(input);
    expect(out).toBe('<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>');
  });

  it('also accepts * as the list marker', () => {
    const input = '* one\n* two';
    expect(formatForTransport(input)).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('applies inline formatting inside list items', () => {
    const input = '- **bold item**\n- `code item`';
    const out = formatForTransport(input);
    expect(out).toContain('<li><b>bold item</b></li>');
    expect(out).toContain('<li><code>code item</code></li>');
  });

  it('HTML-escapes special chars inside list items', () => {
    const input = '- a < b\n- x & y';
    const out = formatForTransport(input);
    expect(out).toContain('<li>a &lt; b</li>');
    expect(out).toContain('<li>x &amp; y</li>');
  });
});

// ---------------------------------------------------------------------------
// Ordered lists
// ---------------------------------------------------------------------------

describe('formatForTransport — ordered lists', () => {
  it('wraps "N. items" in <ol><li>...', () => {
    const input = '1. first\n2. second\n3. third';
    const out = formatForTransport(input);
    expect(out).toBe('<ol><li>first</li><li>second</li><li>third</li></ol>');
  });

  it('applies inline formatting inside ordered list items', () => {
    const input = '1. **step one**\n2. `step two`';
    const out = formatForTransport(input);
    expect(out).toContain('<li><b>step one</b></li>');
    expect(out).toContain('<li><code>step two</code></li>');
  });
});

// ---------------------------------------------------------------------------
// Nested / mixed inline formatting
// ---------------------------------------------------------------------------

describe('formatForTransport — nested and mixed inline', () => {
  it('handles bold containing italic', () => {
    expect(formatForTransport('**outer *inner* end**')).toBe(
      '<b>outer <i>inner</i> end</b>',
    );
  });

  it('handles italic containing inline code', () => {
    // Inline code takes highest precedence inside processInline
    const out = formatForTransport('*see `code` here*');
    expect(out).toBe('<i>see <code>code</code> here</i>');
  });

  it('handles bold and italic on the same line', () => {
    const out = formatForTransport('**bold** and *italic*');
    expect(out).toBe('<b>bold</b> and <i>italic</i>');
  });

  it('handles inline code and link on the same line', () => {
    const out = formatForTransport('run `npm install` and see [docs](https://example.com)');
    expect(out).toContain('<code>npm install</code>');
    expect(out).toContain('<a href="https://example.com">docs</a>');
  });
});

// ---------------------------------------------------------------------------
// Link scheme allowlist (XSS prevention — Finding B)
// ---------------------------------------------------------------------------

describe('formatForTransport — link scheme allowlist (XSS prevention)', () => {
  it('allows http: links', () => {
    expect(formatForTransport('[link](http://example.com)')).toBe(
      '<a href="http://example.com">link</a>',
    );
  });

  it('allows https: links', () => {
    expect(formatForTransport('[link](https://example.com)')).toBe(
      '<a href="https://example.com">link</a>',
    );
  });

  it('allows mailto: links', () => {
    expect(formatForTransport('[email](mailto:user@example.com)')).toBe(
      '<a href="mailto:user@example.com">email</a>',
    );
  });

  it('allows tel: links', () => {
    expect(formatForTransport('[call](tel:+15551234567)')).toBe(
      '<a href="tel:+15551234567">call</a>',
    );
  });

  it('blocks javascript: scheme — renders link text only', () => {
    const out = formatForTransport('[x](javascript:alert)');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<a ');
    expect(out).toBe('x');
  });

  it('blocks JAVASCRIPT: (uppercase) scheme', () => {
    const out = formatForTransport('[x](JAVASCRIPT:alert)');
    expect(out).not.toContain('JAVASCRIPT:');
    expect(out).not.toContain('<a ');
    expect(out).toBe('x');
  });

  it('blocks javascript: with leading space bypass', () => {
    const out = formatForTransport('[x]( javascript:alert)');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<a ');
    expect(out).toBe('x');
  });

  it('blocks data: scheme', () => {
    const out = formatForTransport('[x](data:text/html,payload)');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('<a ');
    expect(out).toBe('x');
  });

  it('blocks vbscript: scheme', () => {
    const out = formatForTransport('[x](vbscript:msgbox)');
    expect(out).not.toContain('vbscript:');
    expect(out).not.toContain('<a ');
    expect(out).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Italic word-boundary guard (Finding C)
// ---------------------------------------------------------------------------

describe('formatForTransport — italic word-boundary guard', () => {
  it('leaves snake_case_var unchanged', () => {
    expect(formatForTransport('snake_case_var')).toBe('snake_case_var');
  });

  it('leaves TEAMS_CLIENT_ID unchanged', () => {
    expect(formatForTransport('TEAMS_CLIENT_ID')).toBe('TEAMS_CLIENT_ID');
  });

  it('leaves a_b_c unchanged', () => {
    expect(formatForTransport('a_b_c')).toBe('a_b_c');
  });

  it('italicizes standalone _italic_ word', () => {
    expect(formatForTransport('_italic_ word')).toBe('<i>italic</i> word');
  });

  it('italicizes _italic_ at start of string', () => {
    expect(formatForTransport('_italic_')).toBe('<i>italic</i>');
  });

  it('italicizes standalone *italic* word', () => {
    expect(formatForTransport('*italic* word')).toBe('<i>italic</i> word');
  });

  it('bold **text** still works (unaffected)', () => {
    expect(formatForTransport('**bold**')).toBe('<b>bold</b>');
  });

  it('bold __text__ still works (unaffected)', () => {
    expect(formatForTransport('__bold__')).toBe('<b>bold</b>');
  });

  it('bold mid-sentence still works with surrounding word chars', () => {
    expect(formatForTransport('pre**bold**post')).toBe('pre<b>bold</b>post');
  });

  it('italic preceded/followed by non-word chars still italicizes', () => {
    expect(formatForTransport('(_italic_)')).toBe('(<i>italic</i>)');
  });
});

describe('formatForTransport — realistic full messages', () => {
  it('converts a message with heading-like bold, paragraph, and code', () => {
    const input = [
      '**Summary**',
      '',
      'Run the following command:',
      '',
      '```bash',
      'npm run build',
      '```',
      '',
      'Then check the output.',
    ].join('\n');

    const out = formatForTransport(input);
    expect(out).toContain('<b>Summary</b>');
    expect(out).toContain('<pre><code>npm run build</code></pre>');
    expect(out).toContain('Then check the output.');
  });

  it('converts a message with a list and inline formatting', () => {
    const input = [
      'Steps to follow:',
      '',
      '1. Install with `npm install`',
      '2. Build with `npm run build`',
      '3. See [docs](https://example.com)',
    ].join('\n');

    const out = formatForTransport(input);
    expect(out).toContain('Steps to follow:');
    expect(out).toContain('<ol>');
    expect(out).toContain('<li>Install with <code>npm install</code></li>');
    expect(out).toContain('<li>See <a href="https://example.com">docs</a></li>');
  });

  it('handles a message with text containing angle brackets (not HTML)', () => {
    const input = 'The type is `Array<string>` and value < 10 or > 100.';
    const out = formatForTransport(input);
    // The `Array<string>` is inside inline code — content escaped
    expect(out).toContain('<code>Array&lt;string&gt;</code>');
    // Plain text < and > escaped
    expect(out).toContain('value &lt; 10');
    expect(out).toContain('&gt; 100');
  });

  it('handles a message with mixed code fence, list, and escape chars', () => {
    const input = [
      'Use the `&&` operator:',
      '',
      '```js',
      'if (a && b) { return true; }',
      '```',
      '',
      'Options:',
      '- **fast**: O(1)',
      '- **slow**: O(n)',
    ].join('\n');

    const out = formatForTransport(input);
    expect(out).toContain('<code>&amp;&amp;</code>');
    expect(out).toContain('a &amp;&amp; b');
    expect(out).toContain('<li><b>fast</b>: O(1)</li>');
  });

  it('handles a long message (>5000 chars) without truncation', () => {
    const repeat = 'This is a sentence with **bold** and `code`. ';
    const input = repeat.repeat(120); // ~5400 chars
    const out = formatForTransport(input);
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('<code>code</code>');
    // Nothing should be truncated — count occurrences
    const boldCount = (out.match(/<b>bold<\/b>/g) ?? []).length;
    expect(boldCount).toBe(120);
  });
});
