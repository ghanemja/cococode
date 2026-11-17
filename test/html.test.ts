import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEntities, extractTitle, htmlToMarkdown, stripTags } from '../src/util/html.ts';

const md = (html: string, base?: string) => htmlToMarkdown(html, base);

describe('htmlToMarkdown: inline and block basics', () => {
  it('converts headings and paragraphs', () => {
    assert.equal(md('<h1>Title</h1><p>First.</p><h3>Sub <em>part</em></h3><p>Second.</p>'), '# Title\n\nFirst.\n\n### Sub *part*\n\nSecond.');
  });

  it('converts emphasis, strong, strike and inline code', () => {
    assert.equal(
      md('<p>a <b>bold</b> <strong>strong</strong> <i>it</i> <em>em</em> <del>gone</del> <code>x = 1</code></p>'),
      'a **bold** **strong** *it* *em* ~~gone~~ `x = 1`',
    );
  });

  it('keeps spacing around inline elements that carry their own whitespace', () => {
    assert.equal(md('<p>one<b> two </b>three</p>'), 'one **two** three');
    assert.equal(md('<p>one <i>two</i>three</p>'), 'one *two*three');
  });

  it('uses a longer fence for inline code containing backticks', () => {
    assert.equal(md('<code>a `b` c</code>'), '``a `b` c``');
  });

  it('does not double up nested identical markers', () => {
    assert.equal(md('<b>a <b>b</b> c</b>'), '**a b** c');
  });

  it('turns <br> into a line break and <hr> into a rule', () => {
    assert.equal(md('<p>one<br>two</p><hr><p>three</p>'), 'one\ntwo\n\n---\n\nthree');
  });

  it('collapses whitespace and blank lines outside pre', () => {
    const out = md('<div>\n\n  <p>  lots   of\n\n   space  </p>\n\n\n\n<div></div><div></div><p>next</p>\n</div>');
    assert.equal(out, 'lots of space\n\nnext');
    assert.ok(!/\n{3,}/.test(out));
  });

  it('decodes named and numeric entities', () => {
    assert.equal(md('<p>&lt;tag&gt; &amp; &quot;q&quot; &copy; &mdash; &#169; &#x1F600; &eacute;&nbsp;&alpha; &#150;</p>'), '<tag> & "q" © — © 😀 é α –');
    assert.equal(decodeEntities('AT&T &unknown; &amp'), 'AT&T &unknown; &amp');
  });
});

describe('htmlToMarkdown: links and images', () => {
  it('resolves relative links against the base URL', () => {
    const base = 'https://example.com/docs/guide/';
    assert.equal(md('<a href="../api?x=1&amp;y=2">API</a>', base), '[API](https://example.com/docs/api?x=1&y=2)');
    assert.equal(md('<a href="/root">Root</a>', base), '[Root](https://example.com/root)');
    assert.equal(md('<a href="https://other.org/a b">Other</a>', base), '[Other](https://other.org/a%20b)');
  });

  it('leaves links as written when there is no base', () => {
    assert.equal(md('<a href="page.html">Page</a>'), '[Page](page.html)');
  });

  it('drops javascript: links and bare anchors but keeps their text', () => {
    assert.equal(md('<p><a href="javascript:void(0)">Click</a> and <a href="#top">top</a> and <a>none</a></p>'), 'Click and top and none');
  });

  it('drops heading permalink anchors', () => {
    assert.equal(md('<h2>Usage<a class="anchor" href="#usage">#</a></h2><h3>API <a href="#api">\u00b6</a></h3>'), '## Usage\n\n### API');
    assert.equal(md('<p>issue <a href="#12">#12</a> and <a href="/c#x">#</a></p>', 'https://e.com'), 'issue #12 and [#](https://e.com/c#x)');
  });

  it('skips links with no text and uses the title when there is one', () => {
    assert.equal(md('<p>a <a href="/x"></a> b</p>'), 'a b');
    assert.equal(md('<a href="/x" title="Go home"></a>', 'https://e.com'), '[Go home](https://e.com/x)');
  });

  it('flattens a link that wraps block content', () => {
    assert.equal(
      md('<a href="/post"><div><h3>Post title</h3><p>Summary text</p></div></a><p>after</p>', 'https://e.com'),
      '[Post title Summary text](https://e.com/post)\n\nafter',
    );
  });

  it('converts images, resolving their source', () => {
    assert.equal(md('<img src="a.png" alt="A picture">', 'https://e.com/dir/'), '![A picture](https://e.com/dir/a.png)');
    assert.equal(md('<img src="data:image/png;base64,AAAA" data-src="/real.png" alt="Lazy">', 'https://e.com'), '![Lazy](https://e.com/real.png)');
    assert.equal(md('<p>x <img src="data:image/png;base64,AAAA" alt="Inline"> y</p>'), 'x Inline y');
    assert.equal(md('<img src="/pixel.gif" width="1" height="1">'), '');
  });

  it('wraps an image in its link', () => {
    assert.equal(md('<a href="/big"><img src="/t.png" alt="Thumb"></a>', 'https://e.com'), '[![Thumb](https://e.com/t.png)](https://e.com/big)');
  });
});

describe('htmlToMarkdown: lists, quotes, code, tables', () => {
  it('converts unordered and ordered lists', () => {
    assert.equal(md('<ul><li>one</li><li>two</li></ul>'), '- one\n- two');
    assert.equal(md('<ol><li>one</li><li>two</li></ol>'), '1. one\n2. two');
    assert.equal(md('<ol start="5"><li>five<li>six</ol>'), '5. five\n6. six');
  });

  it('indents nested lists under their item', () => {
    const out = md('<ul><li>a<ul><li>a1</li><li>a2<ol><li>deep</li></ol></li></ul></li><li>b</li></ul>');
    assert.equal(out, '- a\n  - a1\n  - a2\n    1. deep\n- b');
  });

  it('keeps multi-paragraph items inside the item', () => {
    assert.equal(md('<ul><li><p>first</p><p>second</p></li><li>next</li></ul>'), '- first\n\n  second\n- next');
  });

  it('converts blockquotes, including nested blocks', () => {
    assert.equal(md('<blockquote><p>one</p><p>two</p></blockquote>'), '> one\n>\n> two');
    assert.equal(md('<blockquote>outer<blockquote>inner</blockquote></blockquote>'), '> outer\n>\n> > inner');
  });

  it('fences pre blocks and preserves their whitespace', () => {
    const out = md('<p>before</p><pre><code class="hljs language-python">def f():\n    return 1 &lt; 2\n\n\n# done\n</code></pre><p>after</p>');
    assert.equal(out, 'before\n\n```python\ndef f():\n    return 1 < 2\n\n\n# done\n```\n\nafter');
  });

  it('takes the language from the pre element too, and ignores highlighting spans', () => {
    assert.equal(md('<pre class="lang-js"><span class="k">const</span> a = <span>1</span>;</pre>'), '```js\nconst a = 1;\n```');
    assert.equal(md('<pre>plain</pre>'), '```\nplain\n```');
  });

  it('takes only the code out of a pre that also holds a toolbar', () => {
    const html =
      '<pre class="shiki"><div class="bar">Terminal</div><code class="language-sh"><span class="line">npm install</span>\n' +
      '<span class="line">npm test</span></code><div class="code-toolbar"><span class="code-language">shell</span>' +
      '<button class="copy-button">copy</button></div></pre>';
    assert.equal(md(html), '```sh\nnpm install\nnpm test\n```');
  });

  it('gives each code child of a pre its own fence', () => {
    const html = '<pre><code class="language-cjs">const a = require("a");</code><code class="language-mjs">import a from "a";</code></pre>';
    assert.equal(md(html), '```cjs\nconst a = require("a");\n```\n\n```mjs\nimport a from "a";\n```');
  });

  it('drops copy buttons inside a pre without code children, and adds newlines for per-line blocks', () => {
    assert.equal(md('<pre><button>Copy</button><div>one</div><div>two</div></pre>'), '```\none\ntwo\n```');
  });

  it('uses a longer fence when the code contains backticks', () => {
    assert.equal(md('<pre>```\ninner\n```</pre>'), '````\n```\ninner\n```\n````');
  });

  it('converts tables to pipe tables', () => {
    const out = md(
      '<table><thead><tr><th>Name</th><th>Value</th></tr></thead>' +
        '<tbody><tr><td>a</td><td>1 | 2</td></tr><tr><td><b>b</b></td></tr></tbody></table>',
    );
    assert.equal(out, '| Name | Value |\n| --- | --- |\n| a | 1 \\| 2 |\n| **b** |  |');
  });

  it('handles tables with omitted end tags', () => {
    assert.equal(md('<table><tr><th>A<th>B<tr><td>1<td>2</table>'), '| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('renders single-column and nested layout tables as plain blocks', () => {
    assert.equal(md('<table><tr><td>only</td></tr><tr><td>column</td></tr></table>'), 'only\n\ncolumn');
    const nested = md('<table><tr><td><table><tr><td>a</td><td>b</td></tr></table></td><td>side</td></tr></table>');
    assert.ok(nested.includes('side'));
    assert.ok(nested.includes('| a | b |'));
  });
});

describe('htmlToMarkdown: what gets dropped', () => {
  it('drops script, style, head, comments and other non-content elements', () => {
    const out = md(
      '<html><head><title>T</title><meta charset="utf-8"><style>p{color:red}</style></head><body>' +
        '<script>document.write("<p>no</p>")</script><style>.x{}</style><noscript><p>enable js</p></noscript>' +
        '<svg><text>svg text</text><svg><text>inner</text></svg></svg><iframe src="x">frame</iframe>' +
        '<template><p>tpl</p></template><!-- <p>comment</p> --><p>kept</p></body></html>',
    );
    assert.equal(out, 'kept');
  });

  it('prefers <main> when present', () => {
    const body = 'The main content of this page is long enough to be considered a real article body, not an empty shell.';
    const out = md(`<body><nav><a href="/">Home</a></nav><main><h1>Doc</h1><p>${body}</p></main><footer>Footer</footer></body>`);
    assert.equal(out, `# Doc\n\n${body}`);
  });

  it('prefers <article> when there is no <main>, keeping every top-level article', () => {
    const a = 'First article body with enough words in it to count as content for the page.';
    const b = 'Second article body, also with plenty of words so the selection is not discarded.';
    const out = md(`<div><header>Site</header><article><p>${a}</p></article><aside>Ad</aside><article><p>${b}</p></article></div>`);
    assert.equal(out, `${a}\n\n${b}`);
  });

  it('falls back to the whole page when <main> is an empty shell', () => {
    const out = md('<body><main><div id="app"></div></main><div><p>Server-rendered content lives outside main here.</p></div></body>');
    assert.equal(out, 'Server-rendered content lives outside main here.');
  });
});

describe('htmlToMarkdown: malformed and hostile input', () => {
  it('copes with unclosed and stray tags', () => {
    assert.equal(md('<p>one <b>bold<p>two</p></i></span></div>'), 'one **bold**\n\ntwo');
    assert.equal(md('<ul><li>a<li>b</ul></ul></li>tail'), '- a\n- b\n\ntail');
    assert.equal(md('<h2>Unclosed heading<p>para'), '## Unclosed heading para');
  });

  it('copes with broken attribute quoting', () => {
    assert.equal(md('<p><a href="/x>broken</a> rest</p><p>second</p>', 'https://e.com').includes('second'), true);
    assert.equal(md('<p class=a"b>text</p>'), 'text');
    assert.equal(md('<a title="a > b" href="/y">link</a>', 'https://e.com'), '[link](https://e.com/y)');
  });

  it('treats a lone < as text and survives truncated markup', () => {
    assert.equal(md('<p>1 < 2 and 3 > 2</p>'), '1 < 2 and 3 > 2');
    assert.equal(md('<p>cut off <a href="'), 'cut off');
    assert.equal(md('text <!-- never closed'), 'text');
    assert.equal(md(''), '');
  });

  it('keeps content after an unclosed non-script element and stops at unclosed script', () => {
    assert.equal(md('<p>a</p><svg><p>b</p>'), 'a\n\nb');
    assert.equal(md('<p>a</p><script>var x = "<p>b</p>";'), 'a');
  });

  it('keeps the body when <head> is never closed', () => {
    assert.equal(md('<html><head><title>T</title><body><p>content</p></body></html>'), 'content');
  });

  it('does not overflow the stack on very deep nesting', () => {
    const depth = 200_000;
    assert.equal(md('<div>'.repeat(depth) + 'deep' + '</div>'.repeat(depth)), 'deep');
    assert.ok(md('<b><i>'.repeat(50_000) + 'x').includes('x'));
    assert.ok(md('<blockquote>'.repeat(50_000) + 'q').includes('q'));
    assert.ok(md('<ul><li>'.repeat(50_000) + 'item').includes('item'));
  });

  it('converts a 2 MB document quickly', () => {
    const row = '<tr><td>cell &amp; one</td><td><a href="/p?q=1">link</a></td></tr>';
    const section =
      '<div class="s"><h2>Section</h2><p>Some <b>text</b> with <i>markup</i> and a <a href="/x">link</a>.</p>' +
      `<ul><li>one</li><li>two</li></ul><table>${row.repeat(5)}</table><pre><code>code {\n  here\n}</code></pre></div>\n`;
    const html = `<html><body>${section.repeat(Math.ceil(2_000_000 / section.length))}</body></html>`;
    assert.ok(html.length >= 2_000_000);
    const start = Date.now();
    const out = md(html, 'https://example.com/');
    const elapsed = Date.now() - start;
    assert.ok(out.length > 100_000);
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);
  });

  it('stays fast on pathological repetition', () => {
    const cases = [
      '<head>'.repeat(200_000),
      '<svg>'.repeat(200_000),
      '<a b="'.repeat(200_000),
      '<b>x'.repeat(200_000),
      '<'.repeat(1_000_000),
      '<p>x<br>'.repeat(200_000),
      '<table><tr><td>'.repeat(100_000),
      `<p>${' '.repeat(1_000_000)}x</p>`,
    ];
    for (const html of cases) {
      const start = Date.now();
      md(html);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, `${html.slice(0, 20)}... took ${elapsed}ms`);
    }
  });
});

describe('extractTitle and stripTags', () => {
  it('reads the title element', () => {
    assert.equal(extractTitle('<html><head><title>\n  My &amp; Page \n</title></head></html>'), 'My & Page');
    assert.equal(extractTitle('<TITLE lang="en">Upper</TITLE>'), 'Upper');
  });

  it('falls back to the Open Graph title', () => {
    assert.equal(extractTitle('<head><meta property="og:title" content="OG &quot;Title&quot;"></head>'), 'OG "Title"');
    assert.equal(extractTitle('<head><title></title><meta content="Reversed" property="og:title"></head>'), 'Reversed');
  });

  it('returns undefined when there is no title', () => {
    assert.equal(extractTitle('<p>nothing</p>'), undefined);
    assert.equal(extractTitle(''), undefined);
  });

  it('strips tags to plain text', () => {
    assert.equal(stripTags('  Hello <b>big</b>\n <i>world</i> &amp; more '), 'Hello big world & more');
  });
});
