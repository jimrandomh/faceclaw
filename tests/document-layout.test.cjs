const test = require('node:test');
const assert = require('node:assert/strict');
const { layoutDocument, pageStartLines, visibleLineCount } = require('../.test-build/app/ui/document/document-layout.js');
const { parseMarkdown } = require('../.test-build/app/ui/document/markdown.js');

/** A fixed-pitch fake: every character is `advance` wide. */
function fakeFont(advance, lineHeight, ascent, name) {
  return {
    name,
    fingerprintId: advance,
    atlasKey: null,
    ascent,
    descent: lineHeight - ascent,
    lineHeight,
    measureText: (text) => [...text].length * advance,
    getGlyph: () => ({ dwidthX: advance }),
    hasGlyph: () => true,
    drawText() {},
  };
}

const body = fakeFont(1, 10, 8, 'body');
const bold = fakeFont(2, 10, 8, 'bold');
const h1 = fakeFont(3, 20, 16, 'h1');
const h2 = fakeFont(2, 14, 11, 'h2');
const fontFor = ({ headingLevel, bold: isBold }) => {
  if (headingLevel === 1) return h1;
  if (headingLevel !== undefined) return h2;
  return isBold ? bold : body;
};

const layoutMd = (source, width = 100, reading = true) =>
  layoutDocument(parseMarkdown(source), { width, reading, fontFor });
const lineText = (line) => line.segments.map((segment) => segment.text).join('');
const textLines = (layout) => layout.lines.filter((line) => line.segments.length > 0);

test('headings use their level font and size the line to it', () => {
  const { lines } = layoutMd('# Big\n\n## Mid');
  assert.equal(lines[0].segments[0].font, h1);
  assert.equal(lines[0].height, 22);
  assert.equal(lines[0].ascent, 16);
  assert.equal(lines[2].segments[0].font, h2);
});

test('bold runs use the bold font and measure with it', () => {
  const [line] = layoutMd('ab *cd* ef').lines;
  assert.deepEqual(line.segments.map((segment) => [segment.text, segment.font.name, segment.x]), [
    ['ab ', 'body', 0],
    ['cd', 'bold', 3],
    [' ef', 'body', 7],
  ]);
});

test('a mixed line takes the tallest font and the largest ascent', () => {
  const tall = fakeFont(1, 30, 25, 'tall');
  const { lines } = layoutDocument(
    {
      title: '',
      nodes: [{ id: 'a', kind: 'text', inlines: [{ kind: 'text', text: 'x' }, { kind: 'text', text: 'y', bold: true }], children: [] }],
    },
    { width: 100, reading: true, fontFor: ({ bold: isBold }) => (isBold ? tall : body) },
  );
  assert.equal(lines[0].height, 32);
  assert.equal(lines[0].ascent, 25);
});

test('wrapping accounts for the width of bold runs', () => {
  // Width 60 leaves 50 for text: 46 characters fit, unless 15 of them are double width.
  const a = 'a'.repeat(30);
  const b = 'b'.repeat(15);
  assert.equal(layoutMd(`${a} ${b}`, 60).lines.length, 1);
  const { lines } = layoutMd(`${a} *${b}*`, 60);
  assert.deepEqual(lines.map(lineText), [a, b]);
  assert.equal(lines[1].segments[0].font, bold);
});

test('styled text that wraps stays styled on every line, without trailing spaces', () => {
  const a = 'a'.repeat(30);
  const { lines } = layoutMd(`_${a} ${a}_`, 60);
  assert.deepEqual(lines.map(lineText), [a, a]);
  assert.ok(lines.every((line) => line.segments.every((segment) => segment.underline)));
});

test('links underline; underline survives alongside bold', () => {
  const [line] = layoutMd('[a](u) _b_ **c** d').lines;
  const flags = Object.fromEntries(line.segments.map((segment) => [segment.text.trim(), [segment.underline, segment.bold]]));
  assert.deepEqual(flags.a, [true, false]);
  assert.deepEqual(flags.b, [true, false]);
  assert.deepEqual(flags.c, [false, true]);
  assert.deepEqual(flags.d, [false, false]);
});

test('a hard line break starts a new line, and keeps spans lined up after it', () => {
  const { lines } = layoutMd('one  \n*two* three');
  assert.deepEqual(lines.map(lineText), ['one', 'two three']);
  assert.equal(lines[1].segments[0].font, bold);
  assert.equal(lines[1].segments[0].text, 'two');
});

test('spaced nodes get a gap line owned by no node, and only between blocks', () => {
  const { lines } = layoutMd('a\n\nb');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[1].segments, []);
  assert.notEqual(lines[1].node, lines[0].node);
  assert.notEqual(lines[1].node, lines[2].node);
});

test('a heading gets a bigger gap than a paragraph', () => {
  const para = layoutMd('a\n\nb').lines[1].height;
  const heading = layoutMd('a\n\n# b').lines[1].height;
  assert.ok(heading > para);
});

test('block quotes indent and carry a bar on every line, including gaps within', () => {
  const { lines } = layoutMd('> first\n>\n> second\n\nafter');
  const [first, gap, second, outerGap, after] = lines;
  assert.equal(first.quoteBars.length, 1);
  assert.ok(first.textX > first.quoteBars[0]);
  assert.deepEqual(gap.quoteBars, first.quoteBars);
  assert.deepEqual(second.quoteBars, first.quoteBars);
  assert.deepEqual(outerGap.quoteBars, []);
  assert.deepEqual(after.quoteBars, []);
  assert.equal(after.textX, 0);
});

test('nested quotes stack their bars', () => {
  const { lines } = layoutMd('> > deep');
  assert.equal(lines[0].quoteBars.length, 2);
  assert.ok(lines[0].quoteBars[1] > lines[0].quoteBars[0]);
  assert.ok(lines[0].textX > lines[0].quoteBars[1]);
});

test('list text sits past the marker, and nested items start under the parent text', () => {
  const { lines } = layoutMd('- a\n  - b\n\nplain');
  const [item, nested, , plain] = lines;
  assert.ok(item.textX > item.indentX);
  assert.equal(nested.indentX, item.textX);
  assert.equal(plain.textX, 0);
});

test('a wide ordered marker widens its gutter', () => {
  const short = layoutMd('1. a').lines[0];
  const wide = layoutMd('123456789. a').lines[0];
  assert.equal(short.textX, 16);
  assert.equal(wide.textX, '123456789.'.length + 6);
});

test('only a wrapped node\'s first line is marked first', () => {
  const a = 'a'.repeat(30);
  const { lines } = layoutMd(`- ${a} ${a}\n- b`, 60);
  assert.deepEqual(lines.map((line) => [lineText(line), line.firstOfNode]), [[a, true], [a, false], ['b', true]]);
});

test('code blocks keep line structure and a text inset, and are marked for shading', () => {
  const { lines } = layoutMd('```\n  a\n\nb\n```');
  assert.deepEqual(lines.map(lineText), ['  a', '', 'b']);
  assert.ok(lines.every((line) => line.codeBlock && line.textX === 6));
});

test('rules take a line with no text', () => {
  const { lines } = layoutMd('---');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].node.kind, 'rule');
  assert.deepEqual(lines[0].segments, []);
});

test('reading layout has nothing selectable and no gutter on prose', () => {
  const layout = layoutMd('# t\n\npara');
  assert.deepEqual(layout.selectable, []);
  assert.ok(layout.lines.every((line) => line.selectableIndex === -1 && line.textX === 0));
});

test('outline layout selects every node with text and keeps the marker gutter', () => {
  const root = {
    title: '',
    nodes: [
      { id: 'h', kind: 'heading', level: 1, inlines: [{ kind: 'text', text: 'head' }], children: [] },
      { id: 'empty', kind: 'text', bullet: true, inlines: [], children: [
        { id: 'c', kind: 'text', bullet: true, inlines: [{ kind: 'text', text: 'child' }], children: [] },
      ] },
    ],
  };
  const layout = layoutDocument(root, { width: 100, reading: false, fontFor });
  assert.deepEqual(layout.selectable.map((node) => node.id), ['h', 'c']);
  assert.deepEqual(layout.lines.map((line) => [line.node.id, line.textX]), [['h', 20], ['empty', 20], ['c', 38]]);
});

test('visibleLineCount fits by pixel height and always shows one line', () => {
  const lines = layoutMd('a\nb\nc'.replace(/\n/g, '  \n')).lines; // 12px lines
  assert.equal(visibleLineCount(lines, 0, 24), 2);
  assert.equal(visibleLineCount(lines, 0, 23), 1);
  assert.equal(visibleLineCount(lines, 0, 1), 1);
  assert.equal(visibleLineCount(lines, 2, 100), 1);
});

const hardLines = (count) => Array.from({ length: count }, (_, index) => `line${index}`).join('  \n');

test('a document that fits is one page', () => {
  assert.deepEqual(pageStartLines(layoutMd(hardLines(3)).lines, 100), [0]);
  assert.deepEqual(pageStartLines([], 100), [0]);
});

test('pages overlap by one line and reach the end', () => {
  const { lines } = layoutMd(hardLines(10)); // 12px lines, 3 fit in 36px
  assert.deepEqual(pageStartLines(lines, 36), [0, 2, 4, 6, 8]);
});

test('no page starts on a paragraph gap', () => {
  const { lines } = layoutMd('a\n\nb\n\nc\n\nd\n\ne'); // text 12px, gaps 8px
  const starts = pageStartLines(lines, 32);
  assert.ok(starts.length > 1);
  for (const start of starts) assert.ok(lines[start].segments.length > 0, `page starts on a gap at ${start}`);
});

test('a view too short for one line still makes progress', () => {
  const { lines } = layoutMd(hardLines(3));
  assert.deepEqual(pageStartLines(lines, 1), [0, 1, 2]);
});

test('a trailing gap from an empty quote cannot run past the end', () => {
  const { lines } = layoutMd('a\n\n>');
  assert.deepEqual(lines.map((line) => line.segments.length > 0), [true, false]);
  assert.doesNotThrow(() => pageStartLines(lines, 12));
});

test('the bundled documents lay out without losing any text', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const name of ['README.md', 'ACKNOWLEDGEMENTS.md']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
    const layout = layoutMd(source, 80);
    assert.ok(textLines(layout).length > 5, name);
    const rendered = layout.lines.map(lineText).join(' ');
    // Link and image destinations aren't shown, by design.
    for (const word of source.replace(/\]\([^)]*\)/g, ']').match(/[A-Za-z]{6,}/g)) {
      assert.ok(rendered.includes(word), `${name}: lost "${word}"`);
    }
  }
});
