/**
 * The renderer that embeds the compiled bundles into Dart string
 * constants. It has no other test, and both scripts that use it — the one
 * that writes the templates and the one CI verifies them with — render the
 * same way: a renderer that corrupts the JS corrupts it identically in
 * both places, so `npm run verify` agrees with it and the published
 * package ships a worker that differs from the built one.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — a plain .mjs build script, deliberately untyped.
import { renderDartAsset } from '../../../../scripts/asset-utils.mjs';

const render = (js: string): string =>
  (
    renderDartAsset as (
      a: { input: string; constName: string; description: string },
      js: string,
    ) => string
  )({ input: 'dist/sw.js', constName: 'swTemplate', description: 'd' }, js);

/** The Dart literal the renderer produced, without the declaration. */
function literalOf(dart: string): string {
  const start = dart.indexOf('const String swTemplate = ');
  expect(start).toBeGreaterThan(-1);
  const body = dart.slice(start + 'const String swTemplate = '.length);
  const end = body.lastIndexOf(';');
  return body.slice(0, end);
}

/**
 * Evaluate a Dart string literal the way the analyzer would, for the
 * subset this renderer emits: raw triple-quoted literals, double-quoted
 * literals and implicit concatenation between them.
 *
 * Deliberately strict — an input it cannot read is a renderer that wrote
 * something other than what it promises, and the test should say so.
 */
function evalDartLiteral(literal: string): string {
  let rest = literal.trim();
  let out = '';
  while (rest.length > 0) {
    if (rest.startsWith("r'''")) {
      const end = rest.indexOf("'''", 4);
      expect(end, `unterminated raw literal in ${literal}`).toBeGreaterThan(-1);
      let body = rest.slice(4, end);
      // Dart drops a newline that immediately follows the opening quotes.
      if (body.startsWith('\n')) body = body.slice(1);
      out += body;
      rest = rest.slice(end + 3).trimStart();
    } else if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      expect(end, `unterminated literal in ${literal}`).toBeGreaterThan(-1);
      const body = rest.slice(1, end);
      // Nothing that needs unescaping may appear in these pieces: they
      // exist only to carry quotes.
      expect(body).not.toMatch(/[\\$]/);
      out += body;
      rest = rest.slice(end + 1).trimStart();
    } else if (rest.startsWith("''")) {
      out += '';
      rest = rest.slice(2).trimStart();
    } else {
      throw new Error(`unexpected literal syntax: ${rest.slice(0, 40)}`);
    }
  }
  return out;
}

describe('renderDartAsset', () => {
  it.each([
    ['ordinary minified JS', '(function(){var a=1;})();'],
    ['backslashes and dollars', 'var re=/a\\/b\\\\$/g;var t=`$x`;'],
    ['the injection placeholder', 'var c="__INJECT_SW_CONFIG__";'],
    ['a newline-terminated bundle', 'var a=1;\n'],
    ['a triple quote', "var s=\"'''\";"],
    ['two triple quotes', "a'''b'''c"],
    ['a trailing single quote', "var s='x'"],
    ['a leading single quote', "'use strict';var a=1;"],
    ['four quotes in a row', "a''''b"],
    ['nothing but quotes', "'''"],
    ['one quote', "'"],
    ['an empty bundle', ''],
    ['CRLF line endings', 'var a=1;\r\nvar b=2;\r\n'],
    ['a unicode line separator', 'var s="  ";'],
  ])('round-trips %s', (_what, js) => {
    expect(evalDartLiteral(literalOf(render(js)))).toBe(js);
  });

  it('never leaves a bare quote against the closing delimiter', () => {
    // `r'''…x''''` does not compile: the fourth quote is stray.
    const dart = render("var s='x'");
    expect(dart).not.toMatch(/''''/);
  });

  it('keeps the generated header and the doc comment', () => {
    const dart = render('var a=1;');
    expect(dart).toContain('// GENERATED FILE - DO NOT EDIT');
    expect(dart).toContain('// Source: dist/sw.js');
    expect(dart).toContain('/// d');
    expect(dart.endsWith(';\n')).toBe(true);
  });
});
