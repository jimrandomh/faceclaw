const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown } = require('../.test-build/app/ui/document/markdown.js');

const nodes = (source) => parseMarkdown(source).nodes;
/** The inlines of a one-paragraph document. */
const inlines = (source) => nodes(source)[0].inlines;
const text = (node) => node.inlines.map((inline) => inline.text).join('');
/** A node's shape without its generated id, recursively. */
const shape = (node) => {
  const { id: _id, children, ...rest } = node;
  return { ...rest, children: children.map(shape) };
};

test('ATX headings carry their level, and closing hashes are dropped', () => {
  const [one, three, six] = nodes('# One\n### Three ###\n###### Six');
  assert.deepEqual([one.kind, one.level, text(one)], ['heading', 1, 'One']);
  assert.deepEqual([three.level, text(three)], [3, 'Three']);
  assert.deepEqual([six.level, text(six)], [6, 'Six']);
});

test('a hash without a space, or seven of them, is not a heading', () => {
  assert.equal(nodes('#hashtag')[0].kind, 'text');
  assert.equal(nodes('####### seven')[0].kind, 'text');
});

test('setext underlines make headings out of the preceding paragraph', () => {
  const [one, two] = nodes('Acknowledgements\n================\n\nWrapped\ntitle\n---');
  assert.deepEqual([one.kind, one.level, text(one)], ['heading', 1, 'Acknowledgements']);
  assert.deepEqual([two.kind, two.level, text(two)], ['heading', 2, 'Wrapped title']);
});

test('paragraphs reflow soft breaks, and split on blank lines', () => {
  const paragraphs = nodes('one\n  two\n\nthree');
  assert.equal(paragraphs.length, 2);
  assert.equal(text(paragraphs[0]), 'one two');
  assert.equal(text(paragraphs[1]), 'three');
});

test('two trailing spaces or a backslash force a line break', () => {
  assert.equal(text(nodes('one  \ntwo\\\nthree')[0]), 'one\ntwo\nthree');
});

test('*x* and **x** are bold; _x_ and __x__ are underlined', () => {
  assert.deepEqual(inlines('a *b* c'), [
    { kind: 'text', text: 'a ' },
    { kind: 'text', text: 'b', bold: true },
    { kind: 'text', text: ' c' },
  ]);
  assert.deepEqual(inlines('**b**'), [{ kind: 'text', text: 'b', bold: true }]);
  assert.deepEqual(inlines('***b***'), [{ kind: 'text', text: 'b', bold: true }]);
  assert.deepEqual(inlines('_u_'), [{ kind: 'text', text: 'u', underline: true }]);
  assert.deepEqual(inlines('__u__'), [{ kind: 'text', text: 'u', underline: true }]);
});

test('bold and underline nest', () => {
  assert.deepEqual(inlines('_a **b** c_'), [
    { kind: 'text', text: 'a ', underline: true },
    { kind: 'text', text: 'b', underline: true, bold: true },
    { kind: 'text', text: ' c', underline: true },
  ]);
});

test('intraword underscores and spaced asterisks stay literal', () => {
  for (const literal of ['snake_case_name', '2 * 3 * 4', 'a_b and c_d', 'not a list*']) {
    assert.deepEqual(inlines(literal), [{ kind: 'text', text: literal }]);
  }
});

test('non-Latin letters count as word characters for the flanking rules', () => {
  for (const literal of ['\u0441\u043D\u0435\u0439\u043A_\u043A\u0435\u0439\u0441_\u0441\u043B\u043E\u0432\u043E', '\u65E5\u672C_\u8A9E_\u6587']) {
    assert.deepEqual(inlines(literal), [{ kind: 'text', text: literal }]);
  }
  assert.deepEqual(inlines('_\u0442\u0435\u043A\u0441\u0442_'), [{ kind: 'text', text: '\u0442\u0435\u043A\u0441\u0442', underline: true }]);
});

test('emphasis works against punctuation, symbols and emoji', () => {
  assert.deepEqual(inlines('(_x_)').map((part) => [part.text, !!part.underline]), [['(', false], ['x', true], [')', false]]);
  assert.deepEqual(inlines('**"q"**'), [{ kind: 'text', text: '"q"', bold: true }]);
  assert.deepEqual(inlines('*\u{1F600}*'), [{ kind: 'text', text: '\u{1F600}', bold: true }]);
  assert.deepEqual(inlines('**\u2014**'), [{ kind: 'text', text: '\u2014', bold: true }]);
});

test('asterisks can emphasize within a word, unlike underscores', () => {
  assert.deepEqual(inlines('un*frigging*believable').map((inline) => !!inline.bold), [false, true, false]);
});

test('unmatched delimiters stay literal', () => {
  assert.deepEqual(inlines('**bold'), [{ kind: 'text', text: '**bold' }]);
  assert.deepEqual(inlines('_under'), [{ kind: 'text', text: '_under' }]);
  assert.deepEqual(inlines('***x**'), [
    { kind: 'text', text: '*' },
    { kind: 'text', text: 'x', bold: true },
  ]);
});

test('the rule of 3 keeps an inner run from closing an outer one', () => {
  const parts = inlines('*foo**bar**baz*');
  assert.equal(parts.map((part) => part.text).join(''), 'foobarbaz');
  assert.ok(parts.every((part) => part.bold));
});

test('backslash escapes suppress markup', () => {
  assert.deepEqual(inlines('\\*not bold\\* \\_nor\\_ \\[this](x)'), [
    { kind: 'text', text: '*not bold* _nor_ [this](x)' },
  ]);
  assert.deepEqual(inlines('a\\b'), [{ kind: 'text', text: 'a\\b' }]);
});

test('code spans keep their contents literal', () => {
  assert.deepEqual(inlines('see `a*b*c_d` now'), [
    { kind: 'text', text: 'see ' },
    { kind: 'code', text: 'a*b*c_d' },
    { kind: 'text', text: ' now' },
  ]);
  assert.deepEqual(inlines('`` a`b ``'), [{ kind: 'code', text: 'a`b' }]);
  assert.deepEqual(inlines('`unclosed *b*').map((part) => part.text), ['`unclosed ', 'b']);
});

test('inline links show their text and keep their target', () => {
  assert.deepEqual(inlines('[iOS dev](notes/ios.md "Title")'), [
    { kind: 'link', text: 'iOS dev', target: 'notes/ios.md', external: true },
  ]);
  assert.equal(inlines('[wiki](https://en.wikipedia.org/wiki/G_(x))')[0].target, 'https://en.wikipedia.org/wiki/G_(x)');
  assert.equal(inlines('[spaced](<a b.md>)')[0].target, 'a b.md');
});

test('link text can be styled, and styling can wrap a link', () => {
  assert.deepEqual(inlines('[**b** c](u)'), [
    { kind: 'link', text: 'b', target: 'u', external: true, bold: true },
    { kind: 'link', text: ' c', target: 'u', external: true },
  ]);
  assert.deepEqual(inlines('**[x](u)**'), [{ kind: 'link', text: 'x', target: 'u', external: true, bold: true }]);
});

test('reference links resolve in all three forms, and definitions disappear', () => {
  const doc = nodes('[a][ref] [ref][] [Ref]\n\n[ref]: https://x.org "T"');
  assert.equal(doc.length, 1);
  const links = doc[0].inlines.filter((inline) => inline.kind === 'link');
  assert.deepEqual(links.map((link) => [link.text, link.target]), [
    ['a', 'https://x.org'],
    ['ref', 'https://x.org'],
    ['Ref', 'https://x.org'],
  ]);
});

test('a bracket that is not a link stays literal', () => {
  assert.deepEqual(inlines('[not a link] and [x](broken'), [{ kind: 'text', text: '[not a link] and [x](broken' }]);
});

test('reference definitions inside code fences are left alone', () => {
  assert.equal(nodes('```\n[a]: b\n```')[0].codeText, '[a]: b');
});

test('autolinks drop their brackets; other angle brackets are literal', () => {
  assert.deepEqual(inlines('<https://a.org/b>'), [
    { kind: 'link', text: 'https://a.org/b', target: 'https://a.org/b', external: true },
  ]);
  assert.equal(inlines('James <i@am.guru>')[1].text, 'i@am.guru');
  assert.deepEqual(inlines('faceclaw-<version>.apk'), [{ kind: 'text', text: 'faceclaw-<version>.apk' }]);
});

test('bare URLs link, leaving sentence punctuation outside', () => {
  const parts = inlines('See https://a.org/b_c_d/, then (www.x.org).');
  assert.deepEqual(parts.map((part) => [part.kind, part.text]), [
    ['text', 'See '],
    ['link', 'https://a.org/b_c_d/'],
    ['text', ', then ('],
    ['link', 'www.x.org'],
    ['text', ').'],
  ]);
  assert.deepEqual(inlines('xhttp://a.org'), [{ kind: 'text', text: 'xhttp://a.org' }]);
});

test('images become a text placeholder with their alt text', () => {
  assert.deepEqual(inlines('![App launcher](a.png)'), [{ kind: 'text', text: '[Image: App launcher]' }]);
  assert.deepEqual(inlines('![](a.png)'), [{ kind: 'text', text: '[Image]' }]);
  assert.deepEqual(inlines('[![Build](b.svg)](https://ci)'), [
    { kind: 'link', text: '[Image: Build]', target: 'https://ci', external: true },
  ]);
});

test('block quotes nest their contents, including lists and lazy continuations', () => {
  const [quote] = nodes('> # Title\n> para\nlazy\n>\n> - item\n>\n> > deeper');
  assert.equal(quote.kind, 'quote');
  assert.deepEqual(quote.children.map((child) => child.kind), ['heading', 'text', 'text', 'quote']);
  assert.equal(text(quote.children[1]), 'para lazy');
  assert.ok(quote.children[2].bullet);
  assert.equal(text(quote.children[3].children[0]), 'deeper');
});

test('a blank line ends a block quote', () => {
  assert.deepEqual(nodes('> a\n\nb').map((node) => node.kind), ['quote', 'text']);
});

test('bullet lists are tight items, with wrapped lines joined', () => {
  const items = nodes(' * **A voice assistant** that\n   wakes up\n * Second');
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === 'text' && item.bullet));
  assert.equal(text(items[0]), 'A voice assistant that wakes up');
  assert.ok(items[0].inlines[0].bold);
  assert.ok(!items[1].spaced);
});

test('ordered lists number from their start, whatever the source says', () => {
  const items = nodes('3. a\n1. b\n1. c');
  assert.deepEqual(items.map((item) => item.marker), ['3.', '4.', '5.']);
  assert.ok(items.every((item) => !item.bullet));
});

test('a different marker starts a new list', () => {
  const items = nodes('- a\n* b');
  assert.equal(items.length, 2);
  assert.ok(items[1].spaced);
});

test('blank lines between items make a list loose', () => {
  const items = nodes('1. a\n\n2. b\n3. c');
  assert.deepEqual(items.map((item) => !!item.spaced), [false, true, true]);
});

test('nested blocks become children, with tight nested lists unspaced', () => {
  const [item] = nodes('- parent\n  - child\n    - grandchild\n\n  second para\n\n      code');
  assert.equal(text(item), 'parent');
  assert.deepEqual(item.children.map((child) => child.kind), ['text', 'text', 'code']);
  assert.ok(!item.children[0].spaced);
  assert.equal(text(item.children[0].children[0]), 'grandchild');
  assert.ok(item.children[1].spaced);
  assert.equal(item.children[2].codeText, 'code');
});

test('task list items become todos', () => {
  const items = nodes('- [ ] open\n- [x] done\n- [X] also done\n- [nope] plain');
  assert.deepEqual(items.map((item) => [item.kind, !!item.checked, text(item)]), [
    ['todo', false, 'open'],
    ['todo', true, 'done'],
    ['todo', true, 'also done'],
    ['text', false, '[nope] plain'],
  ]);
});

test('a number starting a wrapped line does not interrupt a paragraph', () => {
  assert.equal(nodes('The year was\n1986. A great year').length, 1);
  assert.equal(nodes('Steps:\n1. first').length, 2);
});

test('fenced code keeps its contents verbatim and closes on a matching fence', () => {
  const [code, after] = nodes('~~~~js\n# not a heading\n~~~\n  *x*\n~~~~\nafter');
  assert.equal(code.kind, 'code');
  assert.equal(code.codeText, '# not a heading\n~~~\n  *x*');
  assert.equal(text(after), 'after');
});

test('an unclosed fence runs to the end of its container', () => {
  assert.equal(nodes('```\nabc\n\ndef')[0].codeText, 'abc\n\ndef');
});

test('indented code needs a blank line before it, and trims trailing blanks', () => {
  assert.equal(nodes('para\n    continued').length, 1);
  const [para, code] = nodes('para\n\n    a\n\n    b\n\n');
  assert.equal(text(para), 'para');
  assert.equal(code.codeText, 'a\n\nb');
});

test('thematic breaks are rules, except under a paragraph where --- is a heading', () => {
  assert.deepEqual(nodes('---').map((node) => node.kind), ['rule']);
  assert.deepEqual(nodes('a\n\n* * *\n\n___').map((node) => node.kind), ['text', 'rule', 'rule']);
  assert.deepEqual(nodes('a\n- - -').map((node) => node.kind), ['text', 'rule']);
});

test('tables become one row per line, with a bold header and parsed cells', () => {
  const rows = nodes('| Provider | URL |\n| --- | :-: |\n| Venice | `https://v.ai` |\n| a\\|b | c |\n\nafter');
  assert.deepEqual(rows.map(text), ['Provider | URL', 'Venice | https://v.ai', 'a|b | c', 'after']);
  assert.ok(rows[0].inlines.every((inline) => inline.bold));
  assert.ok(!rows[1].inlines.some((inline) => inline.bold));
  assert.equal(rows[1].inlines[2].kind, 'code');
  assert.deepEqual(rows.map((row) => !!row.spaced), [false, false, false, true]);
});

test('a table can follow a paragraph directly; a lone pipe is just text', () => {
  assert.equal(nodes('intro\na | b\n--|--\n1 | 2').length, 3);
  assert.equal(nodes('a | b\nc | d').length, 1);
});

test('only blocks after the first in their container are spaced', () => {
  const doc = nodes('# a\n\nb\n\n> c\n>\n> d');
  assert.deepEqual(doc.map((node) => !!node.spaced), [false, true, true]);
  assert.deepEqual(doc[2].children.map((node) => !!node.spaced), [false, true]);
});

test('line endings, tabs and a byte order mark are normalized', () => {
  assert.equal(text(nodes('﻿# Title\r\n')[0]), 'Title');
  assert.equal(nodes('```\r\n\ta\r\n```')[0].codeText, '    a');
  assert.equal(nodes('a\rb').length, 1);
});

test('empty input and empty blocks produce no surprises', () => {
  assert.deepEqual(nodes(''), []);
  assert.deepEqual(nodes('\n  \n'), []);
  assert.equal(nodes('#')[0].kind, 'heading');
  assert.deepEqual(shape(nodes('>')[0]), { kind: 'quote', inlines: [], children: [] });
  assert.deepEqual(shape(nodes('-')[0]), { kind: 'text', bullet: true, inlines: [], children: [] });
});

test('node ids are unique across the document', () => {
  const ids = [];
  const visit = (node) => {
    ids.push(node.id);
    node.children.forEach(visit);
  };
  nodes('# a\n\n> b\n\n- c\n  - d\n\n```\ne\n```').forEach(visit);
  assert.equal(new Set(ids).size, ids.length);
});

test('the title passes through to the document root', () => {
  assert.equal(parseMarkdown('x', 'README').title, 'README');
});

test('pathological input finishes promptly', () => {
  const started = Date.now();
  nodes(`${'['.repeat(2000)}\n\n${'*a'.repeat(2000)}\n\n${'`'.repeat(2000)} x\n\n${'> '.repeat(200)}deep`);
  assert.ok(Date.now() - started < 2000, 'took too long');
});
