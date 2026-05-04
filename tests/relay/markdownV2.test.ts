import { describe, it, expect } from 'vitest';
import { escapeMarkdownV2, needsEscaping } from '../../src/relay/markdownV2.js';

describe('escapeMarkdownV2', () => {
  describe('plain text — special chars', () => {
    it('escapes all 18 MarkdownV2 special chars', () => {
      expect(escapeMarkdownV2('_')).toBe('\\_');
      expect(escapeMarkdownV2('*')).toBe('\\*');
      expect(escapeMarkdownV2('[')).toBe('\\[');
      expect(escapeMarkdownV2(']')).toBe('\\]');
      expect(escapeMarkdownV2('(')).toBe('\\(');
      expect(escapeMarkdownV2(')')).toBe('\\)');
      expect(escapeMarkdownV2('~')).toBe('\\~');
      expect(escapeMarkdownV2('`')).toBe('\\`');
      expect(escapeMarkdownV2('>')).toBe('\\>');
      expect(escapeMarkdownV2('#')).toBe('\\#');
      expect(escapeMarkdownV2('+')).toBe('\\+');
      expect(escapeMarkdownV2('-')).toBe('\\-');
      expect(escapeMarkdownV2('=')).toBe('\\=');
      expect(escapeMarkdownV2('|')).toBe('\\|');
      expect(escapeMarkdownV2('{')).toBe('\\{');
      expect(escapeMarkdownV2('}')).toBe('\\}');
      expect(escapeMarkdownV2('.')).toBe('\\.');
      expect(escapeMarkdownV2('!')).toBe('\\!');
    });

    it('escapes backslash itself', () => {
      expect(escapeMarkdownV2('\\')).toBe('\\\\');
    });

    it('passes through plain text with no special chars unchanged', () => {
      expect(escapeMarkdownV2('Hello world')).toBe('Hello world');
      expect(escapeMarkdownV2('')).toBe('');
    });

    it('escapes multiple special chars in a sentence', () => {
      expect(escapeMarkdownV2('my_var.name')).toBe('my\\_var\\.name');
    });

    it('escapes dashes in identifiers', () => {
      expect(escapeMarkdownV2('reach-myapp')).toBe('reach\\-myapp');
    });

    it('leaves newlines untouched', () => {
      expect(escapeMarkdownV2('line1\nline2')).toBe('line1\nline2');
    });

    it('leaves emojis and non-ASCII untouched', () => {
      expect(escapeMarkdownV2('📎 foo')).toBe('📎 foo');
      expect(escapeMarkdownV2('· middle dot')).toBe('· middle dot');
    });
  });

  describe('inline code spans', () => {
    it('does not escape special chars inside a code span', () => {
      expect(escapeMarkdownV2('`my_var.name`')).toBe('`my_var.name`');
    });

    it('escapes backslash inside a code span', () => {
      expect(escapeMarkdownV2('`foo\\bar`')).toBe('`foo\\\\bar`');
    });

    it('escapes backtick inside a code span', () => {
      expect(escapeMarkdownV2('`foo`bar`')).toBe('`foo`bar\\`');
    });

    it('handles plain text around a code span', () => {
      expect(escapeMarkdownV2('use `my_var` here.')).toBe('use `my_var` here\\.');
    });

    it('handles unclosed inline code span — treats rest as plain text', () => {
      expect(escapeMarkdownV2('open `tick')).toBe('open \\`tick');
    });
  });

  describe('code blocks', () => {
    it('does not escape special chars inside a code block', () => {
      const input = '```\nconst x = a_b.c;\n```';
      const result = escapeMarkdownV2(input);
      expect(result).toBe('```\nconst x = a_b.c;\n```');
    });

    it('escapes backslash inside a code block', () => {
      const input = '```\npath\\to\\file\n```';
      expect(escapeMarkdownV2(input)).toBe('```\npath\\\\to\\\\file\n```');
    });

    it('handles language hint after triple backtick', () => {
      const input = '```typescript\nconst x: number = 1;\n```';
      expect(escapeMarkdownV2(input)).toBe('```typescript\nconst x: number = 1;\n```');
    });

    it('handles plain text before and after a code block', () => {
      const input = 'see below:\n```\ncode here\n```\ndone.';
      expect(escapeMarkdownV2(input)).toBe('see below:\n```\ncode here\n```\ndone\\.');
    });

    it('handles unclosed code block — treats rest as plain text', () => {
      const input = '```\nunclosed';
      expect(escapeMarkdownV2(input)).toBe('\\`\\`\\`\nunclosed');
    });
  });

  describe('mixed content', () => {
    it('handles interleaved plain text and code regions', () => {
      const input = '_italic_ and `code_var` and **bold**.';
      expect(escapeMarkdownV2(input)).toBe('\\_italic\\_ and `code_var` and \\*\\*bold\\*\\*\\.');
    });

    it('handles HUD footer format', () => {
      const footer = '\n\n📎 reach-myapp · claude-opus-4.5';
      expect(escapeMarkdownV2(footer)).toBe('\n\n📎 reach\\-myapp · claude\\-opus\\-4\\.5');
    });

    it('handles empty response placeholder', () => {
      expect(escapeMarkdownV2('_(empty response)_')).toBe('\\_\\(empty response\\)\\_');
    });
  });
});

describe('real-world Copilot output', () => {
  it('handles a chunky multi-line response with code, lists, and headings', () => {
    // Representative of what Copilot CLI actually returns
    const input = [
      '## Code Review Summary',
      '',
      'Your function `process_data` has a few issues:',
      '',
      '1. The `__init__` method uses `**kwargs` — loses type safety.',
      '2. Line 42 calls `os.path.join(path_a, path_b)` — prefer `pathlib.Path`.',
      '3. Return type `-> dict[str, Any]` is incomplete.',
      '',
      '```python',
      'def process_data(input: str) -> dict:',
      '    result = {}',
      '    for item in input.split("|"):',
      '        key, val = item.split("=")',
      '        result[key] = val',
      '    return result',
      '```',
      '',
      'Suggested fixes:',
      '- Replace `**kwargs` with explicit parameters.',
      '- Use `Path(path_a) / path_b` instead of `os.path.join`.',
      '- Annotate return as `dict[str, str]`.',
    ].join('\n');

    const result = escapeMarkdownV2(input);

    // Code block contents must be verbatim — | and = inside code must NOT be escaped
    expect(result).toContain('input.split("|")');
    expect(result).toContain('item.split("=")');
    expect(result).toContain('result[key] = val');

    // Code span contents must be verbatim
    expect(result).toContain('`process_data`');
    expect(result).toContain('`__init__`');
    expect(result).toContain('`**kwargs`');

    // Plain-text heading: ## → \#\# (# is a special char)
    expect(result).toContain('\\#\\# Code Review Summary');

    // Hyphens in list items must be escaped
    expect(result).toContain('\\- Replace');
    expect(result).toContain('\\- Use');
    expect(result).toContain('\\- Annotate');

    // Periods at end of sentences (plain text) must be escaped
    expect(result).toContain('is incomplete\\.');

    // Em dash (—) is NOT in the 18 special chars, must pass through
    expect(result).toContain('— loses type safety');
    expect(result).toContain('— prefer');
  });

  it('handles HUD footer with session name and model containing hyphens', () => {
    // This is appended verbatim by relay.ts before escaping
    const footer = '\n\n📎 reach-myapp · claude-opus-4.5';
    const result = escapeMarkdownV2(footer);
    // Hyphens in session name and model name must be escaped
    expect(result).toBe('\n\n📎 reach\\-myapp · claude\\-opus\\-4\\.5');
  });

  it('handles response with underscores in identifiers across code and plain text', () => {
    const input = [
      'The `my_variable_name` is used in:',
      '',
      '```ts',
      'const my_variable_name = getValue();',
      '```',
      '',
      'Avoid `my_variable_name` in plain _italic_ text.',
    ].join('\n');

    const result = escapeMarkdownV2(input);

    // Inside code span: underscore preserved
    expect(result).toContain('`my_variable_name`');
    // Inside code block: underscore preserved
    expect(result).toContain('const my_variable_name = getValue()');
    // Plain text _italic_: underscores escaped
    expect(result).toContain('\\_italic\\_');
  });
});

describe('needsEscaping', () => {
  it('returns true when string contains special chars', () => {
    expect(needsEscaping('hello_world')).toBe(true);
    expect(needsEscaping('foo.bar')).toBe(true);
    expect(needsEscaping('a-b')).toBe(true);
    expect(needsEscaping('[link]')).toBe(true);
  });

  it('returns false for clean strings', () => {
    expect(needsEscaping('hello world')).toBe(false);
    expect(needsEscaping('')).toBe(false);
    expect(needsEscaping('simple text here')).toBe(false);
  });
});
