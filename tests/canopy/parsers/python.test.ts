import { describe, it, expect } from 'bun:test';
import { pythonParser } from '@myco/canopy/parsers/python';

function input(content: string, path = 'sample.py') {
  return { path, content, sizeBytes: Buffer.byteLength(content), lineCount: content.split(/\r?\n/).length };
}

describe('pythonParser', () => {
  it('extracts module docstring as topComment', () => {
    const out = pythonParser(input(`"""Top of module.\n\nMore details.\n"""\n\nimport os\n`));
    expect(out.language).toBe('python');
    expect(out.topComment).toContain('Top of module');
  });

  it('skips shebang and encoding cookie before docstring', () => {
    const out = pythonParser(input(`#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\n"""The actual docstring."""\n`));
    expect(out.topComment).toBe('The actual docstring.');
  });

  it('returns null topComment when there is no docstring', () => {
    const out = pythonParser(input(`import os\n\ndef foo(): pass\n`));
    expect(out.topComment).toBeNull();
  });

  it('extracts top-level def and class names', () => {
    const out = pythonParser(input(`
def alpha():
    pass

class Beta:
    def gamma(self): pass

async def delta(): pass
`));
    expect(out.exports.sort()).toEqual(['Beta', 'alpha', 'delta']);
  });

  it('extracts imports for both forms', () => {
    const out = pythonParser(input(`
import os
import sys, json
from collections import OrderedDict
from .relative import thing
`));
    expect(out.imports).toContain('os');
    expect(out.imports).toContain('sys');
    expect(out.imports).toContain('json');
    expect(out.imports).toContain('collections');
    expect(out.imports).toContain('.relative');
  });

  it('does not include nested defs as exports', () => {
    const out = pythonParser(input(`
def outer():
    def inner(): pass
`));
    expect(out.exports).toEqual(['outer']);
  });
});
