import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { parseFetchUrl, slicePage, webFetchTool } from '../src/tools/webfetch.ts';
import { filterResults, formatResults, parseDuckDuckGoHtml, webSearchTool } from '../src/tools/websearch.ts';
import type { Settings } from '../src/config/settings.ts';
import { makeContext, tempProject } from './helpers.ts';

const LONG_LINES = Array.from({ length: 400 }, (_, i) => `line ${i} of the long document`).join('\n');

const DDG_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>node streams at DuckDuckGo</title></head>
<body>
<div class="serp__results">
<div id="links" class="results">

  <div class="result results_links results_links_deep result--ad">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;ad_provider=bingv7aa">Sponsored: Learn Node Fast</a>
      </h2>
      <a class="result__snippet" href="https://duckduckgo.com/y.js?ad_domain=ads.example">An advert that must be skipped.</a>
    </div>
  </div>

  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fstream.html&amp;rut=3a5f0d1c">Stream | <b>Node</b>.js v22 Documentation</a>
      </h2>
      <div class="result__extras">
        <div class="result__extras__url">
          <span class="result__icon"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fstream.html&amp;rut=3a5f0d1c"><img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/nodejs.org.ico" /></a></span>
          <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fstream.html&amp;rut=3a5f0d1c">nodejs.org/api/stream.html</a>
        </div>
      </div>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fstream.html&amp;rut=3a5f0d1c">A <b>stream</b> is an abstract interface for working with streaming data in <b>Node</b>.js. There are many stream objects &amp; helpers.</a>
      <div class="clear"></div>
    </div>
  </div>

  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen%2DUS%2Fdocs%2FWeb%2FAPI%2FStreams_API%3Fa%3D1%26b%3D2&amp;rut=77aa">Streams API - Web APIs | MDN</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fen%2DUS%2Fdocs%2FWeb%2FAPI%2FStreams_API&amp;rut=77aa">The Streams API allows JavaScript to programmatically access
        streams of data received over the network.</a>
      <div class="clear"></div>
    </div>
  </div>

  <div class="result results_links results_links_deep web-result ">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblog.example.com%2Fnode%2Dstreams&amp;rut=9f">Understanding Streams &#x27;The Easy Way&#x27;</a>
      </h2>
      <div class="clear"></div>
    </div>
  </div>

  <div class="nav-link">
    <form action="/html/" method="post"><input type="submit" class="btn btn--alt" value="Next" /></form>
  </div>
</div>
</div>
</body>
</html>`;

const SEARX_RESULTS = {
  query: 'q',
  results: [
    { title: 'SearX <b>One</b>', url: 'https://one.example.org/a', content: 'First &amp; best' },
    { title: 'SearX Two', url: 'https://docs.two.example.com/b', content: 'Second' },
    { title: 'Bad scheme', url: 'ftp://nope.example.com/c', content: 'skipped' },
    { title: 'SearX Three', url: 'https://www.three.example.net/c', content: '' },
  ],
};

let server: http.Server;
let base: string;
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push({ url: req.url ?? '', headers: req.headers });
    const send = (status: number, type: string | undefined, body: string | Buffer) => {
      res.writeHead(status, type ? { 'content-type': type } : {});
      res.end(body);
    };
    switch (url.pathname) {
      case '/page':
        return send(
          200,
          'text/html; charset=utf-8',
          '<html><head><title>Test &amp; Page</title><script>var no = 1;</script></head><body><nav>Skip me</nav>' +
            '<main><h1>Hello</h1><p>This page has a <a href="/other">relative link</a> and enough text to count as the main content of the page.</p></main></body></html>',
        );
      case '/json':
        return send(200, 'application/json', '{"a":1,"b":[true,null]}');
      case '/text':
        return send(200, 'text/plain', 'just plain text\nsecond line');
      case '/long':
        return send(200, 'text/plain', LONG_LINES);
      case '/latin1':
        return send(200, 'text/html; charset=iso-8859-1', Buffer.from('<p>caf\xe9</p>', 'latin1'));
      case '/redirect':
        res.writeHead(302, { location: '/text' });
        return res.end();
      case '/missing':
        return send(404, 'text/html', '<h1>Not here</h1>');
      case '/binary':
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': '2048' });
        return res.end(Buffer.alloc(2048));
      case '/untyped-binary':
        return send(200, undefined, Buffer.from([0, 1, 2, 3, 0, 255, 0, 9]));
      case '/untyped-html':
        return send(200, undefined, '<!DOCTYPE html><html><body><p>sniffed</p></body></html>');
      case '/slow':
        return; // never answers
      case '/huge':
        return send(200, 'text/plain', Buffer.alloc(6 * 1024 * 1024, 'a'));
      case '/ddg/':
        return send(200, 'text/html', url.searchParams.get('q')?.includes('nothing') ? '<html><body>No results.</body></html>' : DDG_FIXTURE);
      case '/ddg-blocked/':
        return send(202, 'text/html', '<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></body></html>');
      case '/searx/search':
        return send(200, 'application/json', JSON.stringify(SEARX_RESULTS));
      case '/searx-html/search':
        return send(200, 'text/html', '<html>not json</html>');
      default:
        return send(500, 'text/plain', 'unexpected path');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function ctx(settings: Settings = {}) {
  return makeContext(tempProject(), settings);
}

describe('parseFetchUrl', () => {
  it('accepts http and https URLs', () => {
    assert.equal((parseFetchUrl('https://example.com/a?b=1') as URL).href, 'https://example.com/a?b=1');
    assert.equal((parseFetchUrl(' http://example.com ') as URL).href, 'http://example.com/');
  });

  it('upgrades bare domains to https, and local addresses to http', () => {
    assert.equal((parseFetchUrl('example.com/docs') as URL).href, 'https://example.com/docs');
    assert.equal((parseFetchUrl('//example.com/x') as URL).href, 'https://example.com/x');
    assert.equal((parseFetchUrl('example.com:8443/x') as URL).href, 'https://example.com:8443/x');
    assert.equal((parseFetchUrl('localhost:3000/api') as URL).href, 'http://localhost:3000/api');
    assert.equal((parseFetchUrl('127.0.0.1:8080') as URL).href, 'http://127.0.0.1:8080/');
    assert.equal((parseFetchUrl('192.168.1.20/admin') as URL).href, 'http://192.168.1.20/admin');
  });

  it('rejects other schemes and junk', () => {
    for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/plain,hi', 'mailto:a@b.c', '', '   ']) {
      assert.equal(typeof parseFetchUrl(bad), 'string', bad);
    }
    assert.equal(typeof parseFetchUrl(undefined), 'string');
  });
});

describe('slicePage', () => {
  const page = { url: 'https://e.com/', title: 'T', text: 'abcdefghij'.repeat(10) };

  it('returns everything with a short header when it fits', () => {
    const s = slicePage(page, 0, 1000);
    assert.equal(s.truncated, false);
    assert.equal(s.content, `URL: https://e.com/\nTitle: T\nLength: 100 characters\n\n${page.text}`);
  });

  it('truncates and tells the model how to continue', () => {
    const s = slicePage(page, 0, 30);
    assert.deepEqual([s.start, s.end, s.total, s.truncated], [0, 30, 100, true]);
    assert.ok(s.content.includes('Showing characters 0-30. More follows: call WebFetch again with start_index=30.'));
    assert.ok(s.content.endsWith(page.text.slice(0, 30)));
  });

  it('continues from start_index to the end', () => {
    const s = slicePage(page, 90, 30);
    assert.deepEqual([s.start, s.end, s.truncated], [90, 100, false]);
    assert.ok(s.content.includes('Showing characters 90-100 (end of content).'));
    assert.ok(s.content.endsWith(page.text.slice(90)));
  });

  it('prefers to cut at a nearby line boundary, and pages are contiguous', () => {
    const text = `${'x'.repeat(95)}\n${'y'.repeat(50)}`;
    const first = slicePage({ url: 'u', text }, 0, 100);
    assert.equal(first.end, 96);
    const second = slicePage({ url: 'u', text }, first.end, 100);
    assert.ok(second.content.endsWith('y'.repeat(50)));
  });

  it('handles odd arguments', () => {
    assert.ok(slicePage(page, 500, 10).content.includes('start_index 100 is past the end'));
    assert.equal(slicePage(page, -5, 10).start, 0);
    assert.equal(slicePage(page, Number.NaN, Number.NaN).truncated, false);
    assert.equal(slicePage({ url: 'u', requestedUrl: 'v', text: '' }).content, 'URL: u\nRedirected from: v\nLength: 0 characters');
  });
});

describe('WebFetch', () => {
  it('describes itself for the permission system', () => {
    const c = ctx();
    assert.equal(webFetchTool.name, 'WebFetch');
    assert.equal(webFetchTool.isReadOnly({ url: 'x' }), true);
    assert.deepEqual(webFetchTool.permission!({ url: 'https://docs.example.com/a/b?c=1' }, c), {
      tool: 'WebFetch',
      kind: 'web',
      target: 'domain:docs.example.com',
      description: 'Fetch https://docs.example.com/a/b?c=1',
    });
    assert.equal(webFetchTool.permission!({ url: 'example.com' }, c)?.target, 'domain:example.com');
    assert.equal(webFetchTool.permission!({ url: 'file:///etc/passwd' }, c), null);
    assert.equal(webFetchTool.label!({ url: 'https://e.com/x' }, c), 'https://e.com/x');
  });

  it('converts an HTML page to Markdown with a header', async () => {
    const r = await webFetchTool.execute({ url: `${base}/page` }, ctx());
    assert.ok(!r.isError);
    assert.ok(r.content.startsWith(`URL: ${base}/page\nTitle: Test & Page\nLength: `));
    assert.ok(r.content.includes('# Hello'));
    assert.ok(r.content.includes(`[relative link](${base}/other)`));
    assert.ok(!r.content.includes('Skip me'));
    assert.ok(!r.content.includes('var no'));
    assert.match(r.summary ?? '', /^Fetched \d+ characters from 127\.0\.0\.1$/);
  });

  it('sends a browser-like user agent', async () => {
    seen.length = 0;
    await webFetchTool.execute({ url: `${base}/text` }, ctx());
    assert.equal(seen.at(-1)?.headers['user-agent'], 'Mozilla/5.0 (compatible; cococode)');
  });

  it('pretty-prints JSON and passes plain text through', async () => {
    const json = await webFetchTool.execute({ url: `${base}/json` }, ctx());
    assert.ok(json.content.endsWith('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}'));
    const text = await webFetchTool.execute({ url: `${base}/text` }, ctx());
    assert.ok(text.content.endsWith('just plain text\nsecond line'));
    assert.ok(!text.content.includes('Title:'));
  });

  it('honours the charset of the response', async () => {
    const r = await webFetchTool.execute({ url: `${base}/latin1` }, ctx());
    assert.ok(r.content.endsWith('café'));
  });

  it('follows redirects and reports the final URL', async () => {
    const r = await webFetchTool.execute({ url: `${base}/redirect` }, ctx());
    assert.ok(!r.isError);
    assert.ok(r.content.startsWith(`URL: ${base}/text\nRedirected from: ${base}/redirect\n`));
    assert.ok(r.content.endsWith('second line'));
  });

  it('pages through long content with start_index', async () => {
    const c = ctx();
    let start = 0;
    let assembled = '';
    for (let i = 0; i < 50; i++) {
      const r = await webFetchTool.execute({ url: `${base}/long`, max_length: 1500, start_index: start }, c);
      assert.ok(!r.isError);
      const [header, ...rest] = r.content.split('\n\n');
      assembled += rest.join('\n\n');
      const next = /start_index=(\d+)/.exec(header!);
      if (!next) break;
      // Each page ends on a line boundary; put back the newline the tool trimmed.
      assembled += '\n';
      start = Number(next[1]);
    }
    assert.equal(assembled, LONG_LINES);
  });

  it('uses settings.maxToolOutputChars as the default page size', async () => {
    const r = await webFetchTool.execute({ url: `${base}/long` }, ctx({ maxToolOutputChars: 500 }));
    assert.match(r.content, /Showing characters 0-\d+\. More follows/);
    assert.ok(r.content.length < 800);
  });

  it('reports HTTP errors as error results', async () => {
    const r = await webFetchTool.execute({ url: `${base}/missing` }, ctx());
    assert.equal(r.isError, true);
    assert.equal(r.content, `HTTP 404 Not Found fetching ${base}/missing`);
  });

  it('describes binary content instead of returning it', async () => {
    const typed = await webFetchTool.execute({ url: `${base}/binary` }, ctx());
    assert.ok(!typed.isError);
    assert.equal(typed.content, `URL: ${base}/binary\nThis is image/png content, 2.0 KB, not text, so it is not shown.`);
    const untyped = await webFetchTool.execute({ url: `${base}/untyped-binary` }, ctx());
    assert.match(untyped.content, /This is binary content \(8 B\)/);
  });

  it('stops downloading at 5 MB and says so', async () => {
    const r = await webFetchTool.execute({ url: `${base}/huge`, max_length: 50 }, ctx());
    assert.ok(!r.isError);
    assert.ok(r.content.includes(`Length: ${5 * 1024 * 1024} characters`));
    assert.ok(r.content.includes('Note: the download was cut off at 5.0 MB.'));
    assert.ok(r.content.endsWith('a'.repeat(50)));
  });

  it('sniffs HTML when the server sends no content type', async () => {
    const r = await webFetchTool.execute({ url: `${base}/untyped-html` }, ctx());
    assert.ok(r.content.endsWith('sniffed'));
  });

  it('rejects unsupported URLs without a request', async () => {
    seen.length = 0;
    const r = await webFetchTool.execute({ url: 'file:///etc/passwd' }, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content, /Only http and https/);
    assert.equal(seen.length, 0);
  });

  it('reports connection failures as error results', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const r = await webFetchTool.execute({ url: `http://127.0.0.1:${port}/` }, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content, /^Could not fetch http:\/\/127\.0\.0\.1:\d+\/: .*ECONNREFUSED/);
  });

  it('stops when the session is interrupted', async () => {
    const controller = new AbortController();
    const c = { ...ctx(), signal: controller.signal };
    const pending = webFetchTool.execute({ url: `${base}/slow` }, c);
    setTimeout(() => controller.abort(), 50);
    const r = await pending;
    assert.equal(r.isError, true);
    assert.match(r.content, /interrupted/);
  });
});

describe('parseDuckDuckGoHtml', () => {
  const results = parseDuckDuckGoHtml(DDG_FIXTURE);

  it('extracts title, real URL and snippet for each organic result', () => {
    assert.equal(results.length, 3);
    assert.deepEqual(results[0], {
      title: 'Stream | Node.js v22 Documentation',
      url: 'https://nodejs.org/api/stream.html',
      snippet: 'A stream is an abstract interface for working with streaming data in Node.js. There are many stream objects & helpers.',
    });
  });

  it('decodes the redirect target, including its own query string', () => {
    assert.equal(results[1]!.url, 'https://developer.mozilla.org/en-US/docs/Web/API/Streams_API?a=1&b=2');
    assert.equal(results[1]!.snippet, 'The Streams API allows JavaScript to programmatically access streams of data received over the network.');
  });

  it('tolerates a result without a snippet and decodes entities in titles', () => {
    assert.deepEqual(results[2], { title: "Understanding Streams 'The Easy Way'", url: 'https://blog.example.com/node-streams', snippet: '' });
  });

  it('skips adverts', () => {
    assert.ok(results.every((r) => !r.title.includes('Sponsored')));
  });

  it('returns nothing for a page without results', () => {
    assert.deepEqual(parseDuckDuckGoHtml('<html><body>No results.</body></html>'), []);
    assert.deepEqual(parseDuckDuckGoHtml(''), []);
  });
});

describe('filterResults and formatResults', () => {
  const results = [
    { title: 'A', url: 'https://docs.example.com/a', snippet: 'sa' },
    { title: 'B', url: 'https://www.other.org/b', snippet: '' },
    { title: 'C', url: 'https://notexample.com/c', snippet: 'sc' },
  ];

  it('keeps only allowed domains, matching subdomains but not lookalikes', () => {
    assert.deepEqual(filterResults(results, ['example.com']).map((r) => r.title), ['A']);
    assert.deepEqual(filterResults(results, ['https://www.other.org/path', 'EXAMPLE.com']).map((r) => r.title), ['A', 'B']);
  });

  it('drops blocked domains', () => {
    assert.deepEqual(filterResults(results, undefined, ['other.org']).map((r) => r.title), ['A', 'C']);
    assert.deepEqual(filterResults(results, ['example.com', 'other.org'], ['docs.example.com']).map((r) => r.title), ['B']);
  });

  it('passes everything through without filters', () => {
    assert.equal(filterResults(results).length, 3);
    assert.equal(filterResults(results, [], []).length, 3);
  });

  it('formats a numbered Markdown list', () => {
    assert.equal(
      formatResults('my query', results.slice(0, 2)),
      'Search results for "my query":\n\n1. [A](https://docs.example.com/a)\n   sa\n\n2. [B](https://www.other.org/b)',
    );
    assert.equal(formatResults('zzz', []), 'No results found for "zzz".');
  });
});

describe('WebSearch', () => {
  it('describes itself for the permission system', () => {
    const c = ctx();
    assert.equal(webSearchTool.name, 'WebSearch');
    assert.equal(webSearchTool.isReadOnly({ query: 'x' }), true);
    assert.deepEqual(webSearchTool.permission!({ query: 'node streams' }, c), {
      tool: 'WebSearch',
      kind: 'web',
      description: 'Search the web for "node streams"',
    });
    assert.equal(webSearchTool.label!({ query: 'node streams' }, c), 'node streams');
  });

  it('searches DuckDuckGo through the configured endpoint', async () => {
    seen.length = 0;
    const r = await webSearchTool.execute({ query: 'node streams' }, ctx({ webSearch: { url: `${base}/ddg/` } }));
    assert.ok(!r.isError);
    assert.equal(seen.at(-1)?.url, '/ddg/?q=node+streams');
    assert.ok(r.content.startsWith('Search results for "node streams":\n\n1. [Stream | Node.js v22 Documentation](https://nodejs.org/api/stream.html)\n   A stream is'));
    assert.ok(r.content.includes('3. [Understanding Streams'));
    assert.equal(r.summary, 'Found 3 results');
  });

  it('limits the number of results', async () => {
    const r = await webSearchTool.execute({ query: 'node streams', max_results: 1 }, ctx({ webSearch: { url: `${base}/ddg/` } }));
    assert.ok(r.content.includes('1. ['));
    assert.ok(!r.content.includes('2. ['));
    assert.equal(r.summary, 'Found 1 result');
  });

  it('applies domain filters to the query and to the results', async () => {
    seen.length = 0;
    const settings = { webSearch: { url: `${base}/ddg/` } };
    const allowed = await webSearchTool.execute({ query: 'streams', allowed_domains: ['mozilla.org'] }, ctx(settings));
    assert.equal(new URL(seen.at(-1)!.url, base).searchParams.get('q'), 'streams site:mozilla.org');
    assert.ok(allowed.content.includes('developer.mozilla.org'));
    assert.ok(!allowed.content.includes('nodejs.org'));

    const blocked = await webSearchTool.execute({ query: 'streams', blocked_domains: ['nodejs.org', 'example.com'] }, ctx(settings));
    assert.equal(new URL(seen.at(-1)!.url, base).searchParams.get('q'), 'streams -site:nodejs.org -site:example.com');
    assert.ok(!blocked.content.includes('nodejs.org'));
    assert.ok(!blocked.content.includes('blog.example.com'));
    assert.equal(blocked.summary, 'Found 1 result');
  });

  it('treats no results as a normal answer', async () => {
    const r = await webSearchTool.execute({ query: 'nothing here' }, ctx({ webSearch: { url: `${base}/ddg/` } }));
    assert.ok(!r.isError);
    assert.equal(r.content, 'No results found for "nothing here".');
    assert.equal(r.summary, 'No results');
  });

  it('explains a bot check instead of claiming there are no results', async () => {
    const r = await webSearchTool.execute({ query: 'x' }, ctx({ webSearch: { url: `${base}/ddg-blocked/` } }));
    assert.equal(r.isError, true);
    assert.match(r.content, /refused the request/);
  });

  it('searches a SearXNG instance', async () => {
    seen.length = 0;
    const r = await webSearchTool.execute({ query: 'q words' }, ctx({ webSearch: { provider: 'searxng', url: `${base}/searx` } }));
    assert.ok(!r.isError);
    assert.equal(seen.at(-1)?.url, '/searx/search?q=q+words&format=json');
    assert.equal(
      r.content,
      'Search results for "q words":\n\n1. [SearX One](https://one.example.org/a)\n   First & best\n\n' +
        '2. [SearX Two](https://docs.two.example.com/b)\n   Second\n\n3. [SearX Three](https://www.three.example.net/c)',
    );
  });

  it('accepts a SearXNG URL that already ends in /search', async () => {
    const r = await webSearchTool.execute({ query: 'q' }, ctx({ webSearch: { provider: 'searxng', url: `${base}/searx/search` } }));
    assert.equal(r.summary, 'Found 3 results');
  });

  it('reports configuration and server problems clearly', async () => {
    const noUrl = await webSearchTool.execute({ query: 'q' }, ctx({ webSearch: { provider: 'searxng' } }));
    assert.equal(noUrl.isError, true);
    assert.match(noUrl.content, /settings\.webSearch\.url/);

    const notJson = await webSearchTool.execute({ query: 'q' }, ctx({ webSearch: { provider: 'searxng', url: `${base}/searx-html` } }));
    assert.equal(notJson.isError, true);
    assert.match(notJson.content, /did not return JSON/);

    const serverError = await webSearchTool.execute({ query: 'q' }, ctx({ webSearch: { url: `${base}/boom/` } }));
    assert.equal(serverError.isError, true);
    assert.match(serverError.content, /HTTP 500/);

    const empty = await webSearchTool.execute({ query: '   ' }, ctx());
    assert.equal(empty.isError, true);
  });
});
