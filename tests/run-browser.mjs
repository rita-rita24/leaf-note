#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const mode = process.argv[2] || 'all';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.join(repoRoot, 'LeafNote.html');
const appUrl = `${pathToFileURL(appPath).href}?test=1`;
const maskingerPath = path.join(repoRoot, 'Maskinger.html');
const maskingerUrl = `${pathToFileURL(maskingerPath).href}?test=1`;
const indexPath = path.join(repoRoot, 'index.html');
const indexUrl = `${pathToFileURL(indexPath).href}?test=1`;

const validModes = new Set(['all', 'unit', 'integration', 'coverage']);
if (!validModes.has(mode)) {
  console.error(`Unknown test mode: ${mode}`);
  process.exit(1);
}

async function fileExists(file) {
  if (!file) return false;
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error('Chrome/Chromium executable not found. Set CHROME_BIN to the browser path.');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function requestJson(port, pathName, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForDevTools(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await requestJson(port, '/json/version');
    } catch (e) {
      lastError = e;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('Timed out waiting for Chrome DevTools');
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => this._onMessage(event));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  _onMessage(event) {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending.resolve(msg.result || {});
      return;
    }
    if (msg.method && this.eventWaiters.has(msg.method)) {
      const waiters = this.eventWaiters.get(msg.method);
      this.eventWaiters.delete(msg.method);
      waiters.forEach((resolve) => resolve(msg.params || {}));
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(payload);
    });
  }

  waitForEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const wrapped = (params) => {
        clearTimeout(timeout);
        resolve(params);
      };
      const waiters = this.eventWaiters.get(method) || [];
      waiters.push(wrapped);
      this.eventWaiters.set(method, waiters);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch (_) {}
  }
}

async function launchBrowser() {
  const chromeBin = await findChrome();
  const port = await getFreePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'leafnote-test-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-sync',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    'about:blank'
  ];
  const proc = spawn(chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('exit', (code, signal) => {
    if (code && code !== 0) console.error(`Chrome exited with ${code || signal}: ${stderr}`);
  });
  await waitForDevTools(port);
  return { proc, port, userDataDir };
}

function isProcessExited(proc) {
  return !proc || proc.exitCode !== null || proc.signalCode !== null;
}

function waitForProcessExit(proc, timeoutMs = 5000) {
  if (isProcessExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    proc.once('exit', onExit);
    if (isProcessExited(proc)) finish(true);
  });
}

async function stopBrowser(browser) {
  const proc = browser?.proc;
  if (!proc || isProcessExited(proc)) return;
  try {
    proc.kill('SIGTERM');
  } catch (_) {}
  const stopped = await waitForProcessExit(proc, 5000);
  if (!stopped && !isProcessExited(proc)) {
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
    await waitForProcessExit(proc, 5000);
  }
}

async function openPage(port, {
  url = appUrl,
  readyExpression = 'window.__LeafNoteTest && window.__LeafNoteTest.isReady()',
  collectCoverage = false
} = {}) {
  const target = await requestJson(port, `/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  if (collectCoverage) {
    await client.send('Debugger.enable');
    await client.send('Profiler.enable');
    await client.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  }
  await client.send('Page.navigate', { url });
  await waitForReady(client, readyExpression);
  return client;
}

async function waitForReady(client, readyExpression, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const ready = await evaluate(client, readyExpression);
      if (ready) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('LeafNote test API did not become ready');
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(text);
  }
  return result.result?.value;
}

function js(fn) {
  return `(${fn.toString()})()`;
}

function jsWithArgs(fn, ...args) {
  return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`;
}

const unitTests = [
  {
    name: 'normalization preserves export revisions when the system clock moves back',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const exported = JSON.parse(JSON.stringify(api.createInitialState()));
        const future = Date.now() + 86400000;
        exported.lastModifiedAt = 100;
        exported.exportedAt = future;
        exported.exportRevision = future + 10;
        const normalized = api.normalizeStateShape(exported).state;
        api.setState(normalized);
        api.getState().pages[api.getState().currentPageId].title = 'After clock rollback';
        api.saveState({ skipUndo: true });
        const edited = JSON.parse(JSON.stringify(api.getState()));
        const chosen = api.chooseStartupState(exported, edited, null);
        const invalid = api.normalizeStateShape({ ...exported, lastModifiedAt: Infinity, exportedAt: 'invalid', exportRevision: 42 }).state;
        return {
          normalizedRevision: normalized.lastModifiedAt,
          exportRevision: exported.exportRevision,
          editIsNewer: api.getStateRevision(edited) > api.getStateRevision(exported),
          chosenTitle: chosen.pages[chosen.currentPageId].title,
          invalidRevision: invalid.lastModifiedAt
        };
      }));
      assert.equal(result.normalizedRevision, result.exportRevision);
      assert.equal(result.editIsNewer, true);
      assert.equal(result.chosenTitle, 'After clock rollback');
      assert.equal(result.invalidRevision, 42);
    }
  },
  {
    name: 'sanitizeHTML strips dangerous HTML while keeping safe inline markup',
    run: async (page) => {
      const value = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        return api.sanitizeHTML('<p onclick="x"><a href="javascript:alert(1)" style="color:red">bad</a><script>evil()</script><span data-x="1">ok</span><span data-ln-color="red">red</span><span data-ln-color="bad">bad color</span><a href="https://example.com/a">link</a></p>');
      }));
      assert.equal(value.includes('script'), false);
      assert.equal(value.includes('onclick'), false);
      assert.equal(value.includes('javascript:'), false);
      assert.equal(value.includes('style='), false);
      assert.equal(value.includes('data-x'), false);
      assert.match(value, /<span>ok<\/span>/);
      assert.match(value, /<span data-ln-color="red">red<\/span>/);
      assert.match(value, /<span>bad color<\/span>/);
      assert.match(value, /href="https:\/\/example\.com\/a"/);
      assert.match(value, /rel="noopener noreferrer"/);
    }
  },
  {
    name: 'sanitizeHTML handles deeply nested HTML without recursive traversal',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        let html = 'Leaf';
        for (let i = 0; i < 1800; i++) html = `<section onclick="x()"><span data-ln-color="red">${html}</span></section>`;
        const sanitized = api.sanitizeHTML(html);
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('text', html)];
        api.setState(s);
        return {
          sanitizedHasText: sanitized.includes('Leaf'),
          sanitizedHasOnclick: sanitized.includes('onclick'),
          stateHasText: api.getState().pages[api.getState().currentPageId].blocks[0].content.includes('Leaf')
        };
      }));
      assert.equal(result.sanitizedHasText, true);
      assert.equal(result.sanitizedHasOnclick, false);
      assert.equal(result.stateHasText, true);
    }
  },
  {
    name: 'state normalization caps oversized single text fields before render',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const textMax = api.internals.TEXT_FIELD_MAX_CHARS;
        const richMax = api.internals.RICH_HTML_FIELD_MAX_BYTES;
        const rawMax = api.internals.RAW_TEXT_BLOCK_MAX_BYTES;
        const richTooLarge = 'r'.repeat(richMax + 1);
        const rawTooLarge = 'w'.repeat(rawMax + 1);
        const rawState = {
          currentPageId: 'p1',
          rootPages: ['p1'],
          workspaceName: 'workspace',
          pages: {
            p1: {
              id: 'p1',
              title: 't'.repeat(textMax + 1),
              icon: 'i'.repeat(textMax + 1),
              iconType: 'emoji',
              hasIcon: true,
              parentId: null,
              children: [],
              blocks: [
                api.blk('text', richTooLarge),
                api.blk('code', rawTooLarge, { language: 'J'.repeat(textMax + 1) }),
                api.blk('table', '', { rows: 1, cols: 1, cells: [[richTooLarge]], hasHeaderRow: false, hasHeaderCol: false }),
                api.blk('image', '', { url: `https://example.com/${'a'.repeat(textMax + 1)}.png` })
              ],
              createdAt: 1,
              updatedAt: 1
            }
          }
        };
        const normalized = api.normalizeStateShape(rawState);
        api.setState(rawState);
        api.renderAll();
        const state = api.getState();
        const blocks = state.pages.p1.blocks;
        return {
          textMax,
          richMax,
          rawMax,
          lossyRepair: normalized.lossyRepair,
          trimmedTextFields: normalized.repair.trimmedTextFields,
          titleLength: state.pages.p1.title.length,
          iconLength: state.pages.p1.icon.length,
          richLength: blocks[0].content.length,
          rawLength: blocks[1].content.length,
          languageLength: blocks[1].language.length,
          cellLength: blocks[2].cells[0][0].length,
          imageUrl: blocks[3].url,
          exactTitleLength: api.internals.truncatePlainTextField('x'.repeat(textMax)).length,
          sanitizedHugeLength: api.sanitizeHTML('z'.repeat(richMax + 1)).length,
          renderedTextLength: document.querySelector('[data-block-id]').textContent.length
        };
      }));
      assert.equal(result.lossyRepair, true);
      assert.ok(result.trimmedTextFields >= 4);
      assert.equal(result.titleLength, result.textMax);
      assert.equal(result.iconLength, result.textMax);
      assert.equal(result.richLength, result.richMax);
      assert.equal(result.rawLength, result.rawMax);
      assert.equal(result.languageLength, result.textMax);
      assert.equal(result.cellLength, result.richMax);
      assert.equal(result.imageUrl, '');
      assert.equal(result.exactTitleLength, result.textMax);
      assert.equal(result.sanitizedHugeLength, result.richMax);
      assert.equal(result.renderedTextLength, result.richMax);
    }
  },
  {
    name: 'markdown inline conversion preserves safe marks and rejects unsafe links',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const html = api.markdownToHtmlInline('**Bold** *Em* `Code` ~~Gone~~ ==Mark== <u>Under</u> <span color="red">Red</span> [ok](https://example.com/a) [bad](javascript:alert(1)) <mailto:test@example.com>');
        const mediaHtml = api.markdownToHtmlInline('![Alt safe](https://example.com/i.png) and [^safe]');
        const markdown = api.htmlToMarkdownInline('<b>Bold</b><i>Em</i><code>Code</code><s>Gone</s><mark>Mark</mark><span data-ln-color="red">Red</span><a href="https://example.com/a">ok</a>');
        return { html, mediaHtml, markdown };
      }));
      assert.match(result.html, /<b>Bold<\/b>/);
      assert.match(result.html, /<i>Em<\/i>/);
      assert.match(result.html, /<code>Code<\/code>/);
      assert.match(result.html, /<s>Gone<\/s>/);
      assert.match(result.html, /<mark>Mark<\/mark>/);
      assert.match(result.html, /<span data-ln-color="red">Red<\/span>/);
      assert.match(result.html, /href="https:\/\/example\.com\/a"/);
      assert.equal(result.html.includes('javascript:'), false);
      assert.equal(result.html.includes('href="javascript:'), false);
      assert.match(result.mediaHtml, /Alt safe/);
      assert.match(result.mediaHtml, /<sup>\[\^safe\]<\/sup>/);
      assert.match(result.markdown, /\*\*Bold\*\*/);
      assert.match(result.markdown, /\*Em\*/);
      assert.match(result.markdown, /`Code`/);
      assert.match(result.markdown, /~~Gone~~/);
      assert.match(result.markdown, /==Mark==/);
      assert.match(result.markdown, /<span color="red">Red<\/span>/);
      assert.match(result.markdown, /\[ok\]\(https:\/\/example\.com\/a\)/);
    }
  },
  {
    name: 'markdown inline conversion escapes delimiter collisions',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const linkHref = 'https://example.com/a path/(v1)?q=1#hash';
        const markdown = api.htmlToMarkdownInline(
          '<code>`one``two`</code> ' +
          `<a href="${linkHref}">A ] [ B \\ C</a>`
        );
        const html = api.markdownToHtmlInline(markdown);
        const holder = document.createElement('div');
        holder.innerHTML = html;
        return {
          markdown,
          codeText: holder.querySelector('code')?.textContent || '',
          linkText: holder.querySelector('a')?.textContent || '',
          linkHref: holder.querySelector('a')?.getAttribute('href') || ''
        };
      }));
      assert.equal(result.markdown.includes('``` `one``two` ```'), true);
      assert.equal(result.markdown.includes('[A \\] \\[ B \\\\ C](<https://example.com/a path/(v1)?q=1#hash>)'), true);
      assert.equal(result.codeText, '`one``two`');
      assert.equal(result.linkText, 'A ] [ B \\ C');
      assert.equal(result.linkHref, 'https://example.com/a path/(v1)?q=1#hash');
    }
  },
  {
    name: 'htmlToMarkdownInline falls back to plain text for overly deep DOM',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        let html = 'Deep leaf';
        for (let i = 0; i < api.internals.HTML_TO_MARKDOWN_MAX_DOM_DEPTH + 20; i++) {
          html = `<b>${html}</b>`;
        }
        return {
          markdown: api.htmlToMarkdownInline(html),
          normal: api.htmlToMarkdownInline('<b>Bold</b><a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>')
        };
      }));
      assert.equal(result.markdown, 'Deep leaf');
      assert.match(result.normal, /\*\*Bold\*\*/);
      assert.match(result.normal, /bad/);
      assert.equal(result.normal.includes('javascript:'), false);
      assert.match(result.normal, /\[ok\]\(https:\/\/example\.com\)/);
    }
  },
  {
    name: 'markdown parser covers rich block structures and exports stable markdown',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const defaultTable = api.blk('table', '');
        const markdown = [
          '# Heading',
          '',
          '- [x] Task',
          '  - Child item',
          '',
          '| Name | Count |',
          '| :--- | ---: |',
          '| Alpha | 2 |',
          '',
          '```js',
          'console.log("x")',
          '```',
          '',
          'sequenceDiagram',
          '  participant A as Alice',
          '  A->>B: Hello',
          '',
          '![Alt text](https://example.com/image.png)',
          '',
          'A [safe](https://example.com) and [unsafe](javascript:alert(1)) link'
        ].join('\n');
        const blocks = api.parseMarkdownToBlocks(markdown);
        const exported = api.blocksToMarkdown(blocks);
        return {
          types: blocks.map((block) => block.type),
          todoChecked: blocks.find((block) => block.type === 'todo')?.checked,
          todoChildren: blocks.find((block) => block.type === 'todo')?.children?.map((block) => block.type) || [],
          table: blocks.find((block) => block.type === 'table'),
          mermaid: blocks.find((block) => block.type === 'mermaid')?.content || '',
          image: blocks.find((block) => block.type === 'image'),
          linkHtml: blocks[blocks.length - 1]?.content || '',
          exported,
          defaultTableShape: {
            rows: defaultTable.rows,
            cols: defaultTable.cols,
            cells: defaultTable.cells.map((row) => row.length)
          }
        };
      }));
      assert.deepEqual(result.types, ['h1', 'todo', 'table', 'code', 'mermaid', 'image', 'text']);
      assert.equal(result.todoChecked, true);
      assert.deepEqual(result.todoChildren, ['bullet']);
      assert.equal(result.table.cols, 2);
      assert.equal(result.table.alignments[0], 'left');
      assert.equal(result.table.alignments[1], 'right');
      assert.match(result.mermaid, /sequenceDiagram/);
      assert.equal(result.image.url, 'https://example.com/image.png');
      assert.equal(result.linkHtml.includes('javascript:'), false);
      assert.match(result.exported, /# Heading/);
      assert.match(result.exported, /- \[x\] Task/);
      assert.match(result.exported, /\| Alpha \| 2 \|/);
      assert.match(result.exported, /```js/);
      assert.match(result.exported, /!\[Alt text\]\(https:\/\/example\.com\/image\.png\)/);
      assert.deepEqual(result.defaultTableShape, { rows: 3, cols: 3, cells: [3, 3, 3] });
    }
  },
  {
    name: 'markdown serialization shares nested byte budgets and avoids fence collisions',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const byteLength = (value) => new TextEncoder().encode(value).length;
        const nestedBlocks = [
          api.blk('bullet', 'Parent', {
            children: [
              api.blk('text', 'Child alpha'),
              api.blk('code', 'nested\n```', { language: 'markdown' })
            ]
          })
        ];
        const nestedMarkdown = api.blocksToMarkdown(nestedBlocks);
        let exactOk = false;
        let overLimitCode = '';
        try {
          exactOk = api.blocksToMarkdown(nestedBlocks, { maxBytes: byteLength(nestedMarkdown) }) === nestedMarkdown;
          api.blocksToMarkdown(nestedBlocks, { maxBytes: byteLength(nestedMarkdown) - 1 });
        } catch (err) {
          overLimitCode = err.code || err.message;
        }

        const codeContent = [
          'alpha',
          '```',
          'inside four',
          '````',
          '~~~',
          'omega'
        ].join('\n');
        const mermaidContent = [
          'flowchart TD',
          'A-->B',
          '```',
          '~~~~',
          '~~~'
        ].join('\n');
        const fencedMarkdown = api.blocksToMarkdown([
          api.blk('code', codeContent, { language: 'markdown' }),
          api.blk('mermaid', mermaidContent)
        ]);
        const parsed = api.parseMarkdownToBlocks(fencedMarkdown);
        const fenceStarts = fencedMarkdown.split('\n\n').map((block) => block.split('\n')[0]);
        return {
          exactOk,
          overLimitCode,
          fenceStarts,
          parsedTypes: parsed.map((block) => block.type),
          parsedCodeContent: parsed[0]?.content || '',
          parsedMermaidContent: parsed[1]?.content || ''
        };
      }));
      assert.equal(result.exactOk, true);
      assert.equal(result.overLimitCode, 'MARKDOWN_SIZE_LIMIT');
      assert.notEqual(result.fenceStarts[0], '```markdown');
      assert.notEqual(result.fenceStarts[1], '```mermaid');
      assert.deepEqual(result.parsedTypes, ['code', 'mermaid']);
      assert.equal(result.parsedCodeContent, ['alpha', '```', 'inside four', '````', '~~~', 'omega'].join('\n'));
      assert.equal(result.parsedMermaidContent, ['flowchart TD', 'A-->B', '```', '~~~~', '~~~'].join('\n'));
    }
  },
  {
    name: 'markdown serialization preserves escaped text markers and image captions',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const textContent = [
          '# literal heading',
          '- literal item',
          '1. literal ordered',
          '> literal quote',
          '![literal](https://example.com/not-image.png)',
          '| a | b |',
          '| --- | --- |',
          '```',
          '&lt;section&gt;literal&lt;/section&gt;',
          '---'
        ].join('\n');
        const imageCaption = 'Alt [x] \\ y ] z';
        const markdown = api.blocksToMarkdown([
          api.blk('text', textContent),
          api.blk('image', '', { url: 'https://example.com/i(1).png', caption: imageCaption })
        ]);
        const parsed = api.parseMarkdownToBlocks(markdown);
        const textHolder = document.createElement('div');
        textHolder.innerHTML = parsed[0]?.content || '';
        const captionHolder = document.createElement('div');
        captionHolder.innerHTML = parsed[1]?.caption || '';
        return {
          markdown,
          parsedTypes: parsed.map((block) => block.type),
          parsedText: textHolder.textContent,
          imageUrl: parsed[1]?.url || '',
          imageCaption: captionHolder.textContent
        };
      }));
      assert.match(result.markdown, /\\# literal heading/);
      assert.match(result.markdown, /\\- literal item/);
      assert.match(result.markdown, /1\\. literal ordered/);
      assert.equal(result.markdown.includes('\\!\\[literal\\]'), true);
      assert.match(result.markdown, /\\\| a \\\| b \\\|/);
      assert.equal(result.markdown.includes('![Alt \\[x\\] \\\\ y \\] z](<https://example.com/i(1).png>)'), true);
      assert.deepEqual(result.parsedTypes, ['text', 'image']);
      assert.equal(result.parsedText, [
        '# literal heading',
        '- literal item',
        '1. literal ordered',
        '> literal quote',
        '![literal](https://example.com/not-image.png)',
        '| a | b |',
        '| --- | --- |',
        '```',
        '<section>literal</section>',
        '---'
      ].join('\n'));
      assert.equal(result.imageUrl, 'https://example.com/i(1).png');
      assert.equal(result.imageCaption, 'Alt [x] \\ y ] z');
    }
  },
  {
    name: 'markdown export round-trips inline literal markers without accidental formatting',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const literalText = [
          'Literal **bold** _em_ ~~del~~ ==mark==',
          '[label](https://example.com)',
          '&lt;https://example.com&gt;',
          '^footnote'
        ].join(' ');
        const markdown = api.blocksToMarkdown([
          api.blk('text', literalText),
          api.blk('text', [
            'Real <b>bold **literal**</b>',
            '<mark>mark ==literal==</mark>',
            '<a href="https://example.com/path">link [label](x)</a>'
          ].join(' '))
        ]);
        const parsed = api.parseMarkdownToBlocks(markdown);
        const holders = parsed.map((block) => {
          const holder = document.createElement('div');
          holder.innerHTML = block.content || '';
          return {
            html: holder.innerHTML,
            text: holder.textContent || '',
            boldCount: holder.querySelectorAll('b').length,
            markCount: holder.querySelectorAll('mark').length,
            linkCount: holder.querySelectorAll('a').length,
            linkHref: holder.querySelector('a')?.getAttribute('href') || ''
          };
        });
        return { markdown, holders };
      }));
      assert.match(result.markdown, /\\\*\\\*bold\\\*\\\*/);
      assert.match(result.markdown, /\\\[label\\\]\\\(https:\/\/example\.com\\\)/);
      assert.match(result.holders[0].text, /Literal \*\*bold\*\* _em_ ~~del~~ ==mark==/);
      assert.match(result.holders[0].text, /\[label\]\(https:\/\/example\.com\)/);
      assert.match(result.holders[0].text, /<https:\/\/example\.com>/);
      assert.equal(result.holders[0].boldCount, 0);
      assert.equal(result.holders[0].markCount, 0);
      assert.equal(result.holders[0].linkCount, 0);
      assert.equal(result.holders[1].boldCount, 1);
      assert.equal(result.holders[1].markCount, 1);
      assert.equal(result.holders[1].linkCount, 1);
      assert.equal(result.holders[1].linkHref, 'https://example.com/path');
      assert.match(result.holders[1].text, /bold \*\*literal\*\*/);
      assert.match(result.holders[1].text, /mark ==literal==/);
      assert.match(result.holders[1].text, /link \[label\]\(x\)/);
    }
  },
  {
    name: 'markdown page title export is single-line and preserves trailing hashes',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.title = 'Alpha\nBeta ###';
        current.blocks = [api.blk('text', 'Body')];
        api.setState(s);

        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        const originalClick = HTMLAnchorElement.prototype.click;
        let capturedBlob = null;
        let downloadName = '';
        try {
          URL.createObjectURL = (blob) => {
            capturedBlob = blob;
            return 'blob:leafnote-title-test';
          };
          URL.revokeObjectURL = () => {};
          HTMLAnchorElement.prototype.click = function click() {
            downloadName = this.download || '';
          };
          api.internals.exportPageAsMarkdown(current.id);
          const markdown = capturedBlob ? await capturedBlob.text() : '';
          const parsed = api.parseMarkdownToBlocks(markdown);
          const titleHolder = document.createElement('div');
          titleHolder.innerHTML = parsed[0]?.content || '';
          return {
            firstLine: markdown.split('\n')[0],
            downloadName,
            parsedTypes: parsed.map((block) => block.type),
            parsedTitle: titleHolder.textContent || '',
            markdown
          };
        } finally {
          URL.createObjectURL = originalCreateObjectURL;
          URL.revokeObjectURL = originalRevokeObjectURL;
          HTMLAnchorElement.prototype.click = originalClick;
        }
      }));
      assert.equal(result.firstLine, '# Alpha Beta \\#\\#\\#');
      assert.match(result.downloadName, /^Alpha Beta ###\.md$/);
      assert.deepEqual(result.parsedTypes, ['h1', 'text']);
      assert.equal(result.parsedTitle, 'Alpha Beta ###');
      assert.match(result.markdown, /\n\nBody$/);
    }
  },
  {
    name: 'markdown export imports files, toggle headings, rich table cells, rich captions, math, and preserved blanks',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const blocks = [
          api.blk('file', '', {
            fileName: 'report [final].txt',
            fileType: 'text/plain',
            fileSize: 2,
            fileDataUrl: 'data:text/plain;base64,SGk='
          }),
          api.blk('toggle_h2', 'Title<br>Line', {
            expanded: false,
            children: [
              api.blk('text', 'Child **literal**'),
              api.blk('math', 'x^2 + y^2')
            ]
          }),
          api.blk('table', '', {
            rows: 2,
            cols: 2,
            hasHeaderRow: true,
            hasHeaderCol: false,
            cells: [
              ['<b>Head</b>', '<a href="https://example.com">Link</a>'],
              ['<code>a|b</code>', '<mark>Mark</mark>']
            ]
          }),
          api.blk('image', '', {
            url: 'https://example.com/pic.png',
            caption: 'Cap <b>bold</b> <a href="https://example.com/c">link</a> <code>x</code> <mark>mark</mark>'
          }),
          api.blk('h2', 'Head<br>Break'),
          api.blk('bullet', 'Item<br>Break'),
          api.blk('todo', 'Todo<br>Break'),
          api.blk('code', 'a\n\n\nb', { language: 'plaintext' })
        ];
        const markdown = api.blocksToMarkdown(blocks);
        const parsed = api.parseMarkdownToBlocks(markdown);
        const textOf = (html) => {
          const holder = document.createElement('div');
          holder.innerHTML = html || '';
          return holder.textContent || '';
        };
        const table = parsed.find((block) => block.type === 'table');
        const image = parsed.find((block) => block.type === 'image');
        const captionHolder = document.createElement('div');
        captionHolder.innerHTML = image?.caption || '';
        const latexFence = api.parseMarkdownToBlocks('```latex\nx^2\n```')[0];
        return {
          markdown,
          types: parsed.map((block) => block.type),
          file: parsed.find((block) => block.type === 'file'),
          toggle: parsed.find((block) => block.type === 'toggle_h2'),
          tableCells: table?.cells || [],
          imageCaptionHtml: captionHolder.innerHTML,
          imageCaptionText: captionHolder.textContent || '',
          headingText: textOf(parsed.find((block) => block.type === 'h2')?.content),
          bulletText: textOf(parsed.find((block) => block.type === 'bullet')?.content),
          todoText: textOf(parsed.find((block) => block.type === 'todo')?.content),
          codeContent: parsed.find((block) => block.type === 'code')?.content || '',
          latexFenceType: latexFence?.type || ''
        };
      }));
      assert.match(result.markdown, /::: leafnote-toggle-h2 closed/);
      assert.match(result.markdown, /\| `a\\\|b` \| ==Mark== \|/);
      assert.deepEqual(result.types, ['file', 'toggle_h2', 'table', 'image', 'h2', 'bullet', 'todo', 'code']);
      assert.equal(result.file.fileName, 'report [final].txt');
      assert.equal(result.file.fileDataUrl, 'data:text/plain;base64,SGk=');
      assert.equal(result.toggle.expanded, false);
      assert.equal(result.toggle.children.length, 2);
      assert.deepEqual(result.toggle.children.map((block) => block.type), ['text', 'math']);
      assert.equal(result.toggle.children[1].content, 'x^2 + y^2');
      assert.match(result.tableCells[0][0], /<b>Head<\/b>/);
      assert.match(result.tableCells[0][1], /href="https:\/\/example\.com"/);
      assert.match(result.tableCells[1][0], /<code>a\|b<\/code>/);
      assert.match(result.tableCells[1][1], /<mark>Mark<\/mark>/);
      assert.match(result.imageCaptionHtml, /<b>bold<\/b>/);
      assert.match(result.imageCaptionHtml, /href="https:\/\/example\.com\/c"/);
      assert.match(result.imageCaptionHtml, /<code>x<\/code>/);
      assert.match(result.imageCaptionHtml, /<mark>mark<\/mark>/);
      assert.equal(result.imageCaptionText, 'Cap bold link x mark');
      assert.equal(result.headingText, 'Head Break');
      assert.equal(result.bulletText, 'Item Break');
      assert.equal(result.todoText, 'Todo Break');
      assert.equal(result.codeContent, 'a\n\n\nb');
      assert.equal(result.latexFenceType, 'code');
    }
  },
  {
    name: 'markdown compatibility blocks serialize while native structures parse to dedicated blocks',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const decision = api.blk('decision', 'Ship <b>now</b>', {
          governanceStatus: 'accepted',
          governanceOwner: 'Team',
          governanceDate: '2026-05-22'
        });
        const requirement = api.blk('requirement', 'Must be fast', {
          governancePriority: 'should',
          governanceStatus: 'approved',
          governanceOwner: 'PM'
        });
        const question = api.blk('open_question', 'Which API?', {
          governanceStatus: 'answered',
          governanceOwner: 'Ops',
          governanceDue: '2026-06-01'
        });
        const risk = api.blk('risk', 'Mitigate <i>later</i>', {
          governanceSeverity: 'high',
          governanceLikelihood: 'low',
          governanceOwner: 'QA',
          governanceMitigation: 'Rollback'
        });
        const apiSpec = api.blk('api_spec', '', {
          specTitle: 'Create user',
          method: 'POST',
          endpoint: '/users',
          summary: 'Creates a user',
          requestBody: '{"email":"a@example.com"}',
          responseBody: '{"id":"1"}',
          errors: '409 duplicate'
        });
        const db = api.blk('db_table', '', {
          tableName: 'users',
          tablePurpose: 'Stores accounts',
          columns: [{ name: 'email', type: 'text', key: 'UK', nullable: 'No', description: 'login|address' }]
        });
        const screen = api.blk('screen_spec', '', {
          screenName: 'Signup',
          route: '/signup',
          audience: 'Visitor',
          goal: 'Create account',
          components: 'Form',
          states: 'Error'
        });
        const testCase = api.blk('test_case', '', {
          caseId: 'TC-1',
          status: 'Ready',
          scenario: 'Signup succeeds',
          precondition: 'Visitor',
          steps: '1. Submit',
          expected: 'Account created'
        });
        const markdown = api.blocksToMarkdown([
          api.blk('quote', 'Line <b>one</b>\nLine two'),
          api.blk('callout', 'Heads up'),
          api.blk('math', 'x^2'),
          api.blk('html', '<section>Raw</section>'),
          api.blk('raw_markdown', '{% include card %}'),
          api.blk('footnote', 'First line\nSecond line', { label: 'alpha' }),
          api.blk('link_reference', '', { label: 'docs', refUrl: 'https://example.com/docs', refTitle: 'Docs' }),
          api.blk('definition_list', '', { definitions: [{ term: 'Term <b>A</b>', definition: 'Definition <i>B</i>' }] }),
          decision,
          requirement,
          question,
          risk,
          apiSpec,
          db,
          screen,
          testCase,
          api.blk('file', '', { fileName: 'report [final].txt', fileDataUrl: 'data:text/plain;base64,SGk=' })
        ]);
        const parsed = api.parseMarkdownToBlocks([
          '::: warning',
          'Take care',
          ':::',
          '',
          '> [!DECISION]',
          '> Status: accepted',
          '> Owner: Team',
          '>',
          '> Choose path',
          '',
          '> [!DB_TABLE]',
          '> Table: users',
          '> Purpose: Store users',
          '>',
          '> | Name | Type | Key | Nullable | Description |',
          '> | --- | --- | --- | --- | --- |',
          '> | id | uuid | PK | No | primary id |',
          '',
          '[^note]: Footnote body',
          '    continuation',
          '',
          '[docs]: https://example.com "Docs"',
          '',
          'Term',
          ': Definition',
          '',
          '{% raw %}',
          'template',
          '',
          'flowchart LR',
          'A-->B',
          '',
          '# Boundary'
        ].join('\n'));
        const parsedRisk = api.internals._parseRiskMarkdownBody([
          'Severity: high',
          'Likelihood: low',
          'Owner: QA',
          'Mitigation: Rollback',
          '',
          'Actual risk'
        ].join('\n'));
        return {
          decoded: api.internals.decodeHTMLText('&lt;safe&gt;'),
          markdown,
          parsedTypes: parsed.map((block) => block.type),
          parsedCalloutEmoji: parsed[0]?.emoji || '',
          parsedDecisionStatus: parsed[1]?.governanceStatus || '',
          parsedDecisionOwner: parsed[1]?.governanceOwner || '',
          parsedDbTableName: parsed[2]?.tableName || '',
          parsedDbColumns: parsed[2]?.columns || [],
          parsedRiskType: parsedRisk.type,
          parsedRiskContent: parsedRisk.content,
          hardBoundary: api.internals._mdIsMermaidHardBoundary('# Boundary'),
          mermaidKind: api.internals._mdMermaidKind('flowchart LR')
        };
      }));
      assert.equal(result.decoded, '<safe>');
      assert.match(result.markdown, /^> Line \*\*one\*\*/m);
      assert.match(result.markdown, /> \[!DECISION\]/);
      assert.match(result.markdown, /> Status: accepted/);
      assert.match(result.markdown, /> \[!REQUIREMENT\]/);
      assert.match(result.markdown, /> \[!OPEN_QUESTION\]/);
      assert.match(result.markdown, /> \[!API_SPEC\]/);
      assert.match(result.markdown, /> \| email \| text \| UK \| No \| login\\\|address \|/);
      assert.match(result.markdown, /\[\^alpha\]: First line\n    Second line/);
      assert.match(result.markdown, /\[docs\]: https:\/\/example\.com\/docs "Docs"/);
      assert.match(result.markdown, /\[report \\\[final\\\]\.txt\]\(data:text\/plain;base64,SGk=\)/);
      assert.deepEqual(result.parsedTypes, ['callout', 'decision', 'db_table', 'text', 'text', 'text', 'text', 'mermaid', 'h1']);
      assert.equal(result.parsedCalloutEmoji, '⚠️');
      assert.equal(result.parsedDecisionStatus, 'accepted');
      assert.equal(result.parsedDecisionOwner, 'Team');
      assert.equal(result.parsedDbTableName, 'users');
      assert.deepEqual(result.parsedDbColumns, [{ name: 'id', type: 'uuid', key: 'PK', nullable: 'No', description: 'primary id' }]);
      assert.equal(result.parsedRiskType, 'risk');
      assert.match(result.parsedRiskContent, /Actual risk/);
      assert.equal(result.hardBoundary, true);
      assert.equal(result.mermaidKind, 'flowchart');
    }
  },
  {
    name: 'governance and spec markdown helpers parse metadata and serialize fields',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const decision = api.internals._parseGovernanceMarkdownBody('decision', [
          'Status: accepted',
          'Owner: Platform',
          'Date: 2026-05-22',
          '',
          'Ship **the** change'
        ].join('\n'));
        const db = api.internals._parseSpecMarkdownBody('db_table', [
          'Table: users',
          'Purpose: Store account records',
          '',
          '| Name | Type | Key | Nullable | Description |',
          '| --- | --- | --- | --- | --- |',
          '| id | uuid | PK | No | primary id |',
          '| email | text | UK | No | login address |'
        ].join('\n'));
        const testCase = api.internals._parseSpecMarkdownBody('test_case', [
          'ID: TC-001',
          'Status: Ready',
          'Scenario: Login',
          'Precondition: account exists',
          '  user is active',
          'Steps: 1. Open login',
          'Expected: session starts'
        ].join('\n'));
        return {
          decision,
          decisionMarkdown: api.blockToMarkdown(decision),
          db,
          dbMarkdown: api.blockToMarkdown(db),
          testCase,
          testCaseMarkdown: api.blockToMarkdown(testCase)
        };
      }));
      assert.equal(result.decision.type, 'decision');
      assert.equal(result.decision.governanceStatus, 'accepted');
      assert.equal(result.decision.governanceOwner, 'Platform');
      assert.match(result.decision.content, /<b>the<\/b>/);
      assert.match(result.decisionMarkdown, /> \[!DECISION\]/);
      assert.match(result.decisionMarkdown, /> Status: accepted/);
      assert.equal(result.db.type, 'db_table');
      assert.equal(result.db.tableName, 'users');
      assert.equal(result.db.columns.length, 2);
      assert.equal(result.db.columns[0].key, 'PK');
      assert.match(result.dbMarkdown, /> \| id \| uuid \| PK \| No \| primary id \|/);
      assert.equal(result.testCase.type, 'test_case');
      assert.equal(result.testCase.status, 'Ready');
      assert.match(result.testCase.precondition, /user is active/);
      assert.match(result.testCaseMarkdown, /> \[!TEST_CASE\]/);
    }
  },
  {
    name: 'DB spec columns are capped during normalization and helper additions',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const max = api.internals.SPEC_COLUMNS_MAX_ROWS;
        const rows = Array.from({ length: max + 5 }, (_, i) => ({
          name: `col_${i}`,
          type: 'text',
          key: i === 0 ? 'PK' : '',
          nullable: 'Yes',
          description: 'desc'
        }));
        const capped = api.blk('db_table', '', { columns: rows });
        const below = api.blk('db_table', '', { columns: rows.slice(0, max - 1) });
        const addedBelow = api.internals._addSpecColumn(below);
        const addedAtMax = api.internals._addSpecColumn(capped);
        const markdownRows = Array.from({ length: max + 5 }, (_, i) => `| c${i} | text |  | No | d |`);
        const parsed = api.internals._parseSpecMarkdownBody('db_table', [
          '| Name | Type | Key | Nullable | Description |',
          '| --- | --- | --- | --- | --- |',
          ...markdownRows
        ].join('\n'));
        return {
          max,
          cappedLength: capped.columns.length,
          cappedLastName: capped.columns.at(-1).name,
          belowLength: below.columns.length,
          addedBelow,
          addedAtMax,
          parsedLength: parsed.columns.length
        };
      }));
      assert.equal(result.max, 200);
      assert.equal(result.cappedLength, result.max);
      assert.equal(result.cappedLastName, 'col_199');
      assert.equal(result.addedBelow, true);
      assert.equal(result.belowLength, result.max);
      assert.equal(result.addedAtMax, false);
      assert.equal(result.parsedLength, result.max);
    }
  },
  {
    name: 'state normalization preserves native governance and spec block shapes',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('decision', 'Ship <b>now</b><script>bad()</script>', {
            governanceStatus: 'accepted',
            governanceOwner: 'Team\u0000',
            governanceDate: '2026-05-22'
          }),
          api.blk('requirement', 'Must <i>be fast</i>', {
            governancePriority: 'should',
            governanceStatus: 'approved',
            governanceOwner: 'PM'
          }),
          api.blk('open_question', 'Which API?', {
            governanceStatus: 'answered',
            governanceOwner: 'Ops',
            governanceDue: '2026-06-01'
          }),
          api.blk('api_spec', 'Legacy API notes', {
            specTitle: 'Create user',
            method: 'POST',
            endpoint: '/users',
            summary: 'Creates accounts'
          }),
          api.blk('db_table', '', {
            tableName: 'users',
            tablePurpose: 'Stores accounts',
            columns: [{ name: 'email', type: 'text', key: 'UK', nullable: 'No', description: 'login|address' }]
          }),
          api.blk('screen_spec', '', {
            screenName: 'Signup',
            route: '/signup',
            audience: 'Visitor',
            goal: 'Create account'
          }),
          api.blk('test_case', '', {
            caseId: 'TC-1',
            status: 'Ready',
            scenario: 'Signup succeeds',
            expected: 'Account created'
          })
        ];
        const normalizedResult = api.normalizeStateShape(s);
        api.sanitizeStateInPlace(normalizedResult.state);
        const blocks = normalizedResult.state.pages[normalizedResult.state.currentPageId].blocks;
        return {
          types: blocks.map((block) => block.type),
          decisionOwner: blocks[0].governanceOwner,
          decisionContent: blocks[0].content,
          requirementPriority: blocks[1].governancePriority,
          questionDue: blocks[2].governanceDue,
          apiMethod: blocks[3].method,
          apiTitle: blocks[3].specTitle,
          dbTableName: blocks[4].tableName,
          dbColumns: blocks[4].columns,
          screenRoute: blocks[5].route,
          testStatus: blocks[6].status
        };
      }));
      assert.deepEqual(result.types, ['decision', 'requirement', 'open_question', 'api_spec', 'db_table', 'screen_spec', 'test_case']);
      assert.equal(result.decisionOwner, 'Team');
      assert.match(result.decisionContent, /<b>now<\/b>/);
      assert.equal(result.decisionContent.includes('script'), false);
      assert.equal(result.requirementPriority, 'should');
      assert.equal(result.questionDue, '2026-06-01');
      assert.equal(result.apiMethod, 'POST');
      assert.equal(result.apiTitle, 'Create user');
      assert.equal(result.dbTableName, 'users');
      assert.deepEqual(result.dbColumns, [{ name: 'email', type: 'text', key: 'UK', nullable: 'No', description: 'login|address' }]);
      assert.equal(result.screenRoute, '/signup');
      assert.equal(result.testStatus, 'Ready');
    }
  },
  {
    name: 'state normalization repairs corrupt pages and sanitizes persisted content',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const raw = {
          currentPageId: 'missing',
          rootPages: ['root', 'ghost', 'root'],
          workspaceName: 'Doc\u0000Name',
          uiLanguage: 'zz',
          trashAutoPurgeDays: '90',
          trashLastAutoPurge: { count: 2, days: 42, at: 123 },
          themeCustom: {
            accent: 'url(https://example.com/bad.png)',
            accentDark: '#AABBCC',
            pageWidth: 'calc(100vw * 999)',
            fontFamily: 'bad-font'
          },
          pages: {
            root: {
              id: 'root',
              title: 'Root\u0001<script>x</script>',
              icon: 'sticky_note_2',
              iconType: 'material',
              parentId: null,
              children: ['child', 'ghost'],
              blocks: [
                { id: 'b1', type: 'text', content: '<img src=x onerror=1><b onclick="x">Safe</b>', children: [{ id: 'b2', type: 'text', content: '<script>x</script>Child' }] },
                { id: 'b3', type: 'table', rows: 1, cols: 2, cells: [['<span style="color:red">A</span>', '<iframe>bad</iframe>B']] },
                { id: 'b4', type: 'image', url: 'javascript:alert(1)', caption: '<a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>' },
                { id: 'b5', type: 'file', fileName: 'a\u0000/b.txt', fileType: 'text/plain x', fileSize: -10, fileDataUrl: 'not-data' },
                { id: 'b6', type: 'h5', content: 'Legacy heading' }
              ],
              createdAt: 10,
              updatedAt: 20
            },
            child: {
              id: 'child',
              title: 'Child',
              parentId: 'root',
              children: [],
              blocks: [],
              createdAt: 30,
              updatedAt: 40
            }
          }
        };
        const normalized = api.normalizeStateShape(raw);
        api.sanitizeStateInPlace(normalized.state);
        const state = normalized.state;
        api.setState(raw);
        api.internals.applyThemeCustom();
        const lightAccent = document.documentElement.style.getPropertyValue('--accent');
        api.getState().darkMode = true;
        api.internals.applyThemeCustom();
        const darkAccent = document.documentElement.style.getPropertyValue('--accent');
        document.documentElement.style.removeProperty('--accent');
        document.documentElement.style.removeProperty('--ln-primary');
        const root = state.pages.root;
        const tableBlock = root.blocks.find((block) => block.type === 'table');
        const imageBlock = root.blocks.find((block) => block.type === 'image');
        const fileBlock = root.blocks.find((block) => block.type === 'file');
        const legacyBlock = root.blocks.find((block) => /Legacy heading/.test(block.content || ''));
        return {
          repaired: normalized.repaired,
          currentPageId: state.currentPageId,
          rootPages: state.rootPages,
          childParent: state.pages.child.parentId,
          uiLanguage: state.uiLanguage,
          trashAutoPurgeDays: state.trashAutoPurgeDays,
          trashLastAutoPurge: state.trashLastAutoPurge,
          title: root.title,
          contents: root.blocks.map((block) => block.content),
          tableCells: tableBlock?.cells || [],
          imageUrl: imageBlock?.url || '',
          caption: imageBlock?.caption || '',
          file: fileBlock,
          legacy: legacyBlock,
          themeCustom: state.themeCustom,
          normalizedTheme: api.internals.normalizeThemeCustom({
            accent: '#DDEEFF',
            accentDark: 'not-a-color',
            pageWidth: 'wide',
            fontFamily: 'code'
          }),
          lightAccent,
          darkAccent
        };
      }));
      assert.equal(result.repaired, true);
      assert.equal(result.currentPageId, 'root');
      assert.deepEqual(result.rootPages, ['root']);
      assert.equal(result.childParent, 'root');
      assert.equal(result.uiLanguage, 'en');
      assert.equal(result.trashAutoPurgeDays, 90);
      assert.equal(result.trashLastAutoPurge.days, 0);
      assert.equal(result.title.includes('\u0001'), false);
      assert.equal(result.contents[0].includes('<img'), false);
      assert.equal(result.contents[0].includes('onclick'), false);
      assert.equal(result.contents[1].includes('script'), false);
      assert.equal(result.tableCells[0][0].includes('style='), false);
      assert.equal(result.tableCells[0][1].includes('iframe'), false);
      assert.equal(result.imageUrl, '');
      assert.equal(result.caption.includes('javascript:'), false);
      assert.match(result.caption, /href="https:\/\/example\.com"/);
      assert.equal(result.file.fileName.includes('\u0000'), false);
      assert.equal(result.file.fileSize, 0);
      assert.equal(result.file.fileDataUrl, '');
      assert.equal(result.legacy.type, 'text');
      assert.match(result.legacy.content, /Legacy heading/);
      assert.deepEqual(result.themeCustom, { accentDark: '#aabbcc' });
      assert.deepEqual(result.normalizedTheme, { accent: '#ddeeff', pageWidth: 'wide', fontFamily: 'code' });
      assert.equal(result.lightAccent, '');
      assert.equal(result.darkAccent, '#aabbcc');
    }
  },
  {
    name: 'state normalization clamps table size and repairs duplicate block ids',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const makeCells = (rows, cols) => Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, c) => `${r}:${c}`)
        );
        const raw = {
          currentPageId: 'root',
          rootPages: ['root'],
          pages: {
            root: {
              id: 'root',
              title: 'Root',
              parentId: null,
              children: [],
              blocks: [
                { id: 'dup', type: 'text', content: 'first' },
                {
                  id: 'dup',
                  type: 'toggle',
                  content: 'second',
                  expanded: true,
                  children: [{ id: 'dup', type: 'text', content: 'child' }]
                },
                {
                  id: 'table',
                  type: 'table',
                  rows: 101,
                  cols: 101,
                  cells: makeCells(101, 101),
                  alignments: Array.from({ length: 101 }, () => 'left')
                }
              ],
              createdAt: 1,
              updatedAt: 1
            }
          }
        };
        const normalized = api.normalizeStateShape(raw);
        const blocks = normalized.state.pages.root.blocks;
        const collectIds = (list, target) => list.forEach((block) => {
          target.push(block.id);
          if (Array.isArray(block.children)) collectIds(block.children, target);
        });
        const ids = [];
        collectIds(blocks, ids);
        const table = blocks[2];
        const fullTable = api.blk('table', '', { rows: 100, cols: 100, cells: makeCells(100, 100) });
        const almostFull = api.blk('table', '', { rows: 99, cols: 100, cells: makeCells(99, 100) });
        const addAtLimit = api.internals._addTableRow(fullTable);
        const addBeforeLimit = api.internals._addTableRow(almostFull);
        const imported = api.parseMarkdownToBlocks('- parent\n  - child\n- sibling');
        const importedIds = [];
        collectIds(imported, importedIds);
        const source = api.blk('toggle', 'src', { children: [api.blk('text', 'child')] });
        const sourceIds = [source.id, source.children[0].id];
        const regenerated = api.internals.regenBlockIds(JSON.parse(JSON.stringify(source)));
        const regeneratedIds = [regenerated.id, regenerated.children[0].id];
        const parsedTable = api.parseMarkdownToBlocks([
          '| A | B |',
          '| --- | --- |',
          '| 1 | 2 |'
        ].join('\n'))[0];
        return {
          repaired: normalized.repaired,
          ids,
          uniqueCount: new Set(ids).size,
          firstId: blocks[0].id,
          tableRows: table.rows,
          tableCols: table.cols,
          tableCellRows: table.cells.length,
          tableCellCols: table.cells[0].length,
          tableAlignments: table.alignments.length,
          addAtLimit,
          addBeforeLimit,
          almostFullRows: almostFull.rows,
          importedIds,
          sourceIds,
          regeneratedIds,
          parsedTableRows: parsedTable.rows,
          parsedTableCols: parsedTable.cols
        };
      }));
      assert.equal(result.repaired, true);
      assert.equal(result.firstId, 'dup');
      assert.equal(result.uniqueCount, result.ids.length);
      assert.equal(result.tableRows, 100);
      assert.equal(result.tableCols, 100);
      assert.equal(result.tableCellRows, 100);
      assert.equal(result.tableCellCols, 100);
      assert.equal(result.tableAlignments, 100);
      assert.equal(result.addAtLimit, false);
      assert.equal(result.addBeforeLimit, true);
      assert.equal(result.almostFullRows, 100);
      assert.equal(new Set(result.importedIds).size, result.importedIds.length);
      assert.equal(new Set(result.regeneratedIds).size, result.regeneratedIds.length);
      assert.notDeepEqual(result.regeneratedIds, result.sourceIds);
      assert.equal(result.parsedTableRows, 2);
      assert.equal(result.parsedTableCols, 2);
    }
  },
  {
    name: 'state normalization caps deeply nested block children',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const makeDeepBlock = (depth) => {
          const root = { id: 'deep-0', type: 'toggle', content: 'root', expanded: true, children: [] };
          let current = root;
          for (let i = 1; i <= depth; i++) {
            const child = { id: `deep-${i}`, type: 'toggle', content: `level ${i}`, expanded: true, children: [] };
            current.children = [child];
            current = child;
          }
          return root;
        };
        const raw = {
          currentPageId: 'root',
          rootPages: ['root'],
          pages: {
            root: {
              id: 'root',
              title: 'Root',
              parentId: null,
              children: [],
              blocks: [makeDeepBlock(api.internals.BLOCK_MAX_DEPTH + 20)],
              createdAt: 1,
              updatedAt: 1
            }
          }
        };
        const normalized = api.normalizeStateShape(raw);
        api.setState(raw);
        api.renderAll();
        const pageState = api.getState().pages.root;
        let maxDepth = 0;
        const walk = (blocks, depth = 0) => {
          maxDepth = Math.max(maxDepth, depth);
          blocks.forEach((block) => {
            if (Array.isArray(block.children) && block.children.length) walk(block.children, depth + 1);
          });
        };
        walk(pageState.blocks);
        return {
          repaired: normalized.repaired,
          maxDepth,
          renderedBlocks: document.querySelectorAll('#blocks .block').length,
          searchText: api.internals.flattenTextFromBlocks(pageState.blocks),
          markdownLength: api.blocksToMarkdown(pageState.blocks).length
        };
      }));
      assert.equal(result.repaired, true);
      assert.ok(result.maxDepth <= 32);
      assert.ok(result.renderedBlocks >= 1);
      assert.match(result.searchText, /root/);
      assert.ok(result.markdownLength > 0);
    }
  },
  {
    name: 'page hierarchy depth is capped and page lifecycle helpers avoid recursion',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const max = api.internals.PAGE_MAX_DEPTH;
        const makeChainState = (depth) => {
          const pages = {};
          for (let i = 0; i <= depth; i++) {
            const id = `p-${i}`;
            const parentId = i > 0 ? `p-${i - 1}` : null;
            pages[id] = {
              id,
              title: `Page ${i}`,
              icon: '',
              iconType: 'emoji',
              hasIcon: false,
              parentId,
              children: i < depth ? [`p-${i + 1}`] : [],
              blocks: [api.blk('text', `Body ${i}`)],
              createdAt: i + 1,
              updatedAt: i + 1
            };
          }
          return { currentPageId: 'p-0', rootPages: ['p-0'], pages };
        };
        const parentDepth = (state, id) => {
          let depth = 0;
          let page = state.pages[id];
          const seen = new Set();
          while (page && page.parentId) {
            if (seen.has(page.id)) return Infinity;
            seen.add(page.id);
            page = state.pages[page.parentId];
            if (page) depth++;
          }
          return depth;
        };
        const normalized = api.normalizeStateShape(makeChainState(max + 20));
        api.setState(makeChainState(max + 20));
        api.renderAll();
        const normalizedState = api.getState();

        const draft = api.createInitialState();
        const root = draft.pages[draft.currentPageId];
        root.title = 'Runtime Root';
        root.children = [];
        const runtimeIds = [root.id];
        let parentId = root.id;
        for (let i = 1; i <= 600; i++) {
          const id = `runtime-${i}`;
          draft.pages[parentId].children = [id];
          draft.pages[id] = {
            id,
            title: `Runtime ${i}`,
            icon: '',
            iconType: 'emoji',
            hasIcon: false,
            parentId,
            children: [],
            blocks: [api.blk('text', `Runtime ${i}`)],
            createdAt: i,
            updatedAt: i
          };
          runtimeIds.push(id);
          parentId = id;
        }
        api.setState(draft);
        const duplicate = api.internals.duplicatePage(root.id);
        const duplicateIds = api.internals._collectPageSubtreeIds(duplicate.id);
        const duplicateMaxDepth = Math.max(...duplicateIds.map((id) => api.internals._getPageDepth(id)));
        api.deletePage(root.id);
        const deletedCount = runtimeIds.filter((id) => api.getState().pages[id]?.deletedAt).length;
        api.restorePage(root.id);
        const restoredCount = runtimeIds.filter((id) => api.getState().pages[id] && !api.getState().pages[id].deletedAt).length;
        api.purgePage(root.id);
        return {
          max,
          normalizedRepaired: normalized.repaired,
          normalizedMaxDepth: Math.max(...Object.keys(normalized.state.pages).map((id) => parentDepth(normalized.state, id))),
          normalizedRootCount: normalized.state.rootPages.length,
          renderedItems: document.querySelectorAll('.page-item').length,
          runtimeCount: runtimeIds.length,
          duplicateCount: duplicateIds.length,
          duplicateMaxDepth,
          deletedCount,
          restoredCount,
          originalGone: runtimeIds.every((id) => !api.getState().pages[id]),
          currentExists: !!api.getState().pages[api.getState().currentPageId]
        };
      }));
      assert.equal(result.normalizedRepaired, true);
      assert.ok(result.normalizedMaxDepth <= result.max);
      assert.ok(result.normalizedRootCount > 1);
      assert.ok(result.renderedItems >= 1);
      assert.ok(result.duplicateCount <= result.max + 1);
      assert.ok(result.duplicateMaxDepth <= result.max);
      assert.equal(result.deletedCount, result.runtimeCount);
      assert.equal(result.restoredCount, result.runtimeCount);
      assert.equal(result.originalGone, true);
      assert.equal(result.currentExists, true);
    }
  },
  {
    name: 'state normalization caps saved page count and repairs page references',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const max = api.internals.PAGE_MAX_COUNT;
        const pages = {
          parent: {
            id: 'parent',
            title: 'Parent',
            parentId: null,
            children: ['current'],
            blocks: [api.blk('text', 'parent')],
            createdAt: 1,
            updatedAt: 1
          },
          current: {
            id: 'current',
            title: 'Current',
            parentId: 'parent',
            children: ['descendant'],
            blocks: [api.blk('text', 'current')],
            createdAt: 2,
            updatedAt: 2
          },
          descendant: {
            id: 'descendant',
            title: 'Descendant',
            parentId: 'current',
            children: [],
            blocks: [api.blk('text', 'descendant')],
            createdAt: 3,
            updatedAt: 3
          },
          'root-first': {
            id: 'root-first',
            title: 'Root first',
            parentId: null,
            children: [],
            blocks: [api.blk('text', 'root first')],
            createdAt: 4,
            updatedAt: 4
          },
          newest: {
            id: 'newest',
            title: 'Newest',
            parentId: null,
            children: [],
            blocks: [api.blk('text', 'newest')],
            createdAt: 5,
            updatedAt: 100000
          }
        };
        for (let i = 0; i < max + 20; i++) {
          pages[`old-${i}`] = {
            id: `old-${i}`,
            title: `Old ${i}`,
            parentId: null,
            children: [],
            blocks: [api.blk('text', `old ${i}`)],
            createdAt: 10 + i,
            updatedAt: 10 + i
          };
        }
        const raw = {
          currentPageId: 'current',
          rootPages: ['parent', 'root-first'],
          pages
        };
        const normalized = api.normalizeStateShape(raw);
        api.setState(raw);
        api.renderAll();
        const state = api.getState();
        const pageIds = Object.keys(state.pages);
        const referencesValid = Object.values(state.pages).every((p) => (
          (!p.parentId || !!state.pages[p.parentId]) &&
          p.children.every((id) => !!state.pages[id] && state.pages[id].parentId === p.id)
        ));
        return {
          max,
          normalizedLossy: normalized.lossyRepair,
          trimmedPages: normalized.repair.trimmedPages,
          pageCount: pageIds.length,
          currentPageId: state.currentPageId,
          keptParent: !!state.pages.parent,
          keptCurrent: !!state.pages.current,
          keptDescendant: !!state.pages.descendant,
          keptRootFirst: !!state.pages['root-first'],
          keptNewest: !!state.pages.newest,
          referencesValid,
          renderedItems: document.querySelectorAll('.page-item').length
        };
      }));
      assert.equal(result.normalizedLossy, true);
      assert.ok(result.trimmedPages > 0);
      assert.equal(result.pageCount, result.max);
      assert.equal(result.currentPageId, 'current');
      assert.equal(result.keptParent, true);
      assert.equal(result.keptCurrent, true);
      assert.equal(result.keptDescendant, true);
      assert.equal(result.keptRootFirst, true);
      assert.equal(result.keptNewest, true);
      assert.equal(result.referencesValid, true);
      assert.ok(result.renderedItems <= result.max);
    }
  },
  {
    name: 'state normalization caps saved block count per page and keeps rendering bounded',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const max = api.internals.BLOCK_MAX_COUNT_PER_PAGE;
        const mixedRoot = api.blk('toggle', 'mixed root', {
          expanded: true,
          children: Array.from({ length: 20 }, (_, i) => api.blk('text', `child ${i}`))
        });
        const rawBlocks = [
          mixedRoot,
          ...Array.from({ length: max + 20 }, (_, i) => api.blk('text', `top ${i}`))
        ];
        const raw = {
          currentPageId: 'root',
          rootPages: ['root'],
          pages: {
            root: {
              id: 'root',
              title: 'Root',
              parentId: null,
              children: [],
              blocks: rawBlocks,
              createdAt: 1,
              updatedAt: 1
            }
          }
        };
        const normalized = api.normalizeStateShape(raw);
        api.setState(raw);
        api.renderAll();
        const blocks = api.getState().pages.root.blocks;
        return {
          max,
          normalizedLossy: normalized.lossyRepair,
          trimmedBlocks: normalized.repair.trimmedBlocks,
          trimmedPageIds: normalized.repair.blockTrimmedPageIds,
          blockCount: api.internals._countBlocksDeep(blocks),
          firstType: blocks[0].type,
          childCount: blocks[0].children.length,
          hasDroppedTail: blocks.some((block) => block.content === `top ${max + 19}`),
          renderedBlocks: document.querySelectorAll('#blocks .block').length,
          searchText: api.internals.flattenTextFromBlocks(blocks),
          markdownLength: api.blocksToMarkdown(blocks).length
        };
      }));
      assert.equal(result.normalizedLossy, true);
      assert.ok(result.trimmedBlocks > 0);
      assert.deepEqual(result.trimmedPageIds, ['root']);
      assert.equal(result.blockCount, result.max);
      assert.equal(result.firstType, 'toggle');
      assert.equal(result.childCount, 20);
      assert.equal(result.hasDroppedTail, false);
      assert.ok(result.renderedBlocks <= result.max);
      assert.match(result.searchText, /mixed root/);
      assert.ok(result.markdownLength > 0);
    }
  },
  {
    name: 'runtime page creation and duplication respect the page capacity',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const max = api.internals.PAGE_MAX_COUNT;
        const s = api.createInitialState();
        const rootId = s.currentPageId;
        for (let i = 1; i < max; i++) {
          const id = `limit-page-${i}`;
          s.pages[id] = {
            id,
            title: `Limit ${i}`,
            icon: '',
            iconType: 'emoji',
            hasIcon: false,
            parentId: null,
            children: [],
            blocks: [api.blk('text', `Page ${i}`)],
            createdAt: i,
            updatedAt: i
          };
          s.rootPages.push(id);
        }
        api.setState(s);
        api.renderAll();
        const beforeCount = Object.keys(api.getState().pages).length;
        const createResult = api.createPage(null);
        await delay();
        const createAlert = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]')?.click();
        await delay();
        const duplicateResult = api.internals.duplicatePage(rootId);
        await delay();
        const duplicateAlert = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]')?.click();
        return {
          max,
          beforeCount,
          afterCount: Object.keys(api.getState().pages).length,
          canCreate: api.internals.canCreatePage(1),
          assertSilent: api.internals.assertPageCapacity(1, { notify: false }),
          createResult,
          duplicateResult,
          addDisabled: document.querySelector('#new-page-btn').disabled,
          shelfAddDisabled: document.querySelector('#private-add-btn').disabled,
          createAlert,
          duplicateAlert
        };
      }));
      assert.equal(result.beforeCount, result.max);
      assert.equal(result.afterCount, result.max);
      assert.equal(result.canCreate, false);
      assert.equal(result.assertSilent, false);
      assert.equal(result.createResult, null);
      assert.equal(result.duplicateResult, null);
      assert.equal(result.addDisabled, true);
      assert.equal(result.shelfAddDisabled, true);
      assert.match(result.createAlert, /1000|ページ|pages/i);
      assert.match(result.duplicateAlert, /1000|ページ|pages/i);
    }
  },
  {
    name: 'last live page trash move keeps a live current page at page capacity',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const max = api.internals.PAGE_MAX_COUNT;
        const makePage = (id, { deleted = false, title = id } = {}) => ({
          id,
          title,
          icon: '',
          iconType: 'emoji',
          hasIcon: false,
          parentId: null,
          children: [],
          blocks: [api.blk('text', title)],
          createdAt: 1,
          updatedAt: 1,
          ...(deleted ? { deletedAt: 1, prevParentId: null } : {})
        });
        const makeState = (trashCount, liveIds) => {
          const pages = {};
          for (let i = 0; i < trashCount; i++) pages[`trash-${i}`] = makePage(`trash-${i}`, { deleted: true });
          liveIds.forEach((id) => { pages[id] = makePage(id, { title: `Live ${id}` }); });
          return {
            currentPageId: liveIds[0],
            rootPages: liveIds.slice(),
            pages
          };
        };
        const closeDialog = async () => {
          await delay();
          const ok = document.querySelector('#dialog-box [data-ok]');
          if (ok) ok.click();
          await delay();
        };

        api.setState(makeState(max - 1, ['live-full']));
        api.renderAll();
        const blockedCanMove = api.internals.canMovePageToTrash('live-full');
        const blockedMoved = api.deletePage('live-full');
        await delay();
        const blockedDialog = document.querySelector('#dialog-box')?.textContent || '';
        await closeDialog();
        const blockedState = api.getState();

        api.setState(makeState(max - 2, ['live-space']));
        api.renderAll();
        const replacementMoved = api.deletePage('live-space');
        await delay();
        const replacementState = api.getState();
        const replacementCurrent = replacementState.pages[replacementState.currentPageId];

        api.setState(makeState(max - 2, ['live-a', 'live-b']));
        api.renderAll();
        const siblingMoved = api.deletePage('live-a');
        await delay();
        const siblingState = api.getState();

        return {
          blockedCanMove,
          blockedMoved,
          blockedDialog,
          blockedCurrent: blockedState.currentPageId,
          blockedDeleted: !!blockedState.pages['live-full'].deletedAt,
          blockedCount: Object.keys(blockedState.pages).length,
          replacementMoved,
          replacementOldDeleted: !!replacementState.pages['live-space'].deletedAt,
          replacementCurrentId: replacementState.currentPageId,
          replacementCurrentDeleted: !!replacementCurrent.deletedAt,
          replacementCount: Object.keys(replacementState.pages).length,
          siblingMoved,
          siblingCurrent: siblingState.currentPageId,
          siblingOldDeleted: !!siblingState.pages['live-a'].deletedAt,
          siblingCurrentDeleted: !!siblingState.pages[siblingState.currentPageId].deletedAt,
          siblingCount: Object.keys(siblingState.pages).length
        };
      }));
      assert.equal(result.blockedCanMove, false);
      assert.equal(result.blockedMoved, false);
      assert.match(result.blockedDialog, /last live|最後の通常ページ|1000|上限/i);
      assert.equal(result.blockedCurrent, 'live-full');
      assert.equal(result.blockedDeleted, false);
      assert.equal(result.blockedCount, result.replacementCount);
      assert.equal(result.replacementMoved, true);
      assert.equal(result.replacementOldDeleted, true);
      assert.notEqual(result.replacementCurrentId, 'live-space');
      assert.equal(result.replacementCurrentDeleted, false);
      assert.equal(result.replacementCount, 1000);
      assert.equal(result.siblingMoved, true);
      assert.equal(result.siblingCurrent, 'live-b');
      assert.equal(result.siblingOldDeleted, true);
      assert.equal(result.siblingCurrentDeleted, false);
      assert.equal(result.siblingCount, 1000);
    }
  },
  {
    name: 'runtime block insertion helpers respect the per-page block capacity',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const max = api.internals.BLOCK_MAX_COUNT_PER_PAGE;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('toggle', 'Full toggle', { expanded: true, children: [] }),
          ...Array.from({ length: max - 1 }, (_, i) => api.blk('text', `Block ${i}`))
        ];
        api.setState(s);
        api.renderAll();
        const pageState = api.getState().pages[api.getState().currentPageId];
        const beforeCount = api.internals.countBlocksForPage(pageState);
        const inserted = api.internals.insertBlockAfter(api.blk('text', 'Extra'), pageState.blocks.at(-1).id, pageState.blocks);
        await delay();
        const insertAlert = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]')?.click();
        await delay();
        const childInserted = api.internals._insertToggleChildBlock(pageState.blocks[0], api.blk('text', 'Child'), 0);
        await delay();
        const childAlert = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]')?.click();
        return {
          max,
          beforeCount,
          afterCount: api.internals.countBlocksForPage(pageState),
          canInsertOne: api.internals.canInsertBlocks(pageState, 1),
          assertSilent: api.internals.assertBlockCapacity(pageState, 1, { notify: false }),
          inserted,
          childInserted,
          childCount: pageState.blocks[0].children.length,
          insertAlert,
          childAlert
        };
      }));
      assert.equal(result.beforeCount, result.max);
      assert.equal(result.afterCount, result.max);
      assert.equal(result.canInsertOne, false);
      assert.equal(result.assertSilent, false);
      assert.equal(result.inserted, false);
      assert.equal(result.childInserted, false);
      assert.equal(result.childCount, 0);
      assert.match(result.insertAlert, /1000|ブロック|blocks/i);
      assert.match(result.childAlert, /1000|ブロック|blocks/i);
    }
  },
  {
    name: 'startup lossy repair snapshot is not persisted before user changes',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const key = api.internals.STATE_STORAGE_KEY;
        const sentinel = JSON.stringify({ sentinel: true });
        const s = api.createInitialState();
        const page = s.pages[s.currentPageId];
        page.title = 'Lossy snapshot';
        localStorage.setItem(key, sentinel);
        api.setState(s);
        api.internals._markStartupLossyRepairSnapshot(JSON.stringify(api.getState()));
        api.internals.flushStateToLocalStorageSync();
        const afterUnchangedFlush = localStorage.getItem(key);
        page.title = 'Changed after warning';
        api.internals.flushStateToLocalStorageSync();
        const afterChangedFlush = localStorage.getItem(key);
        api.internals._clearStartupLossyRepairSnapshot();
        return {
          unchangedSkipped: afterUnchangedFlush === sentinel,
          changedSaved: JSON.parse(afterChangedFlush).pages[page.id].title === 'Changed after warning'
        };
      }));
      assert.equal(result.unchangedSkipped, true);
      assert.equal(result.changedSaved, true);
    }
  },
  {
    name: 'image safety policy accepts only raster image sources',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalFetch = window.fetch;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('image', '', { url: 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E' }),
          api.blk('image', '', { url: 'https://example.com/vector.svg' }),
          api.blk('image', '', { url: 'http://127.0.0.1/private.png' }),
          api.blk('image', '', { url: 'https://example.com/photo.png?token=1' }),
          api.blk('image', '', { url: 'data:image/webp;base64,AAAA' })
        ];
        api.setState(s);
        let remoteSvg = '';
        try {
          window.fetch = async () => new Response(new Blob(['<svg></svg>'], { type: 'image/svg+xml' }), { status: 200 });
          await api.internals.fetchRemoteImageBlob('https://example.com/vector.svg');
        } catch (e) {
          remoteSvg = e.message;
        } finally {
          window.fetch = originalFetch;
        }
        return {
          urls: api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.url),
          fileChecks: {
            svgByType: api.internals._isImageFile(new File(['x'], 'safe.png', { type: 'image/svg+xml' })),
            svgByName: api.internals._isImageFile(new File(['x'], 'bad.svg')),
            pngByType: api.internals._isImageFile(new File(['x'], 'bad.bin', { type: 'image/png' })),
            pngByName: api.internals._isImageFile(new File(['x'], 'ok.png'))
          },
          remoteSvg
        };
      }));
      assert.deepEqual(result.urls, ['', '', '', 'https://example.com/photo.png?token=1', 'data:image/webp;base64,AAAA']);
      assert.deepEqual(result.fileChecks, {
        svgByType: false,
        svgByName: false,
        pngByType: true,
        pngByName: true
      });
      assert.match(result.remoteSvg, /PNG|JPEG|GIF|WebP|AVIF|BMP/);
    }
  },
  {
    name: 'network image URL policy rejects private and IPv4-mapped local targets',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const urls = [
          'http://127.0.0.1/private.png',
          'http://localhost/private.png',
          'http://192.168.0.1/camera.png',
          'http://[::1]/loop.png',
          'http://[::ffff:127.0.0.1]/loop.png',
          'http://[::ffff:7f00:1]/loop.png',
          'http://[::ffff:c0a8:1]/router.png',
          'http://[::ffff:808:808]/public.png',
          'https://example.com/public.png'
        ];
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = urls.map((url) => api.blk('image', '', { url }));
        api.setState(s);
        api.renderAll();
        return {
          privateChecks: urls.map((url) => api.internals.isPrivateNetworkUrl(url)),
          normalized: urls.map((url) => api.internals.normalizeImageUrl(url)),
          stateUrls: api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.url),
          imgSrcs: Array.from(document.querySelectorAll('.image-wrap img')).map((img) => img.getAttribute('src') || img.src)
        };
      }));
      assert.deepEqual(result.privateChecks, [true, true, true, true, true, true, true, false, false]);
      assert.deepEqual(result.normalized.slice(0, 7), ['', '', '', '', '', '', '']);
      assert.equal(result.normalized[7], 'http://[::ffff:808:808]/public.png');
      assert.equal(result.normalized[8], 'https://example.com/public.png');
      assert.deepEqual(result.stateUrls.slice(0, 7), ['', '', '', '', '', '', '']);
      assert.equal(result.imgSrcs.length, 2);
      assert.equal(result.imgSrcs.some((src) => /127\.0\.0\.1|localhost|192\.168|::1|c0a8/i.test(src)), false);
    }
  },
  {
    name: 'state normalization breaks cyclic page parent links',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const raw = {
          currentPageId: 'a',
          rootPages: [],
          pages: {
            a: {
              id: 'a',
              title: 'A',
              parentId: 'b',
              children: ['b'],
              blocks: [api.blk('text', 'A')],
              createdAt: 1,
              updatedAt: 1
            },
            b: {
              id: 'b',
              title: 'B',
              parentId: 'a',
              children: ['a'],
              blocks: [api.blk('text', 'B')],
              createdAt: 2,
              updatedAt: 2
            }
          }
        };
        const normalized = api.normalizeStateShape(raw);
        const state = normalized.state;
        const hasParentCycle = (id) => {
          const seen = new Set();
          let page = state.pages[id];
          while (page && page.parentId) {
            if (seen.has(page.id)) return true;
            seen.add(page.id);
            page = state.pages[page.parentId];
          }
          return false;
        };
        api.setState(raw);
        api.renderAll();
        return {
          repaired: normalized.repaired,
          rootPages: state.rootPages,
          parentIds: Object.fromEntries(Object.values(state.pages).map((p) => [p.id, p.parentId || null])),
          children: Object.fromEntries(Object.values(state.pages).map((p) => [p.id, p.children.slice()])),
          hasParentCycle: Object.keys(state.pages).some(hasParentCycle),
          childrenAligned: Object.values(state.pages).every((p) =>
            p.children.every((cid) => state.pages[cid] && state.pages[cid].parentId === p.id)
          ),
          renderedItems: document.querySelectorAll('.page-item').length
        };
      }));
      assert.equal(result.repaired, true);
      assert.equal(result.hasParentCycle, false);
      assert.equal(result.childrenAligned, true);
      assert.ok(result.rootPages.length >= 1);
      assert.ok(result.renderedItems >= 1);
    }
  },
  {
    name: 'startup revision chooses the newest persisted state source',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const setRevision = (state, revision) => {
          state.lastModifiedAt = revision;
          Object.values(state.pages).forEach((page) => {
            page.createdAt = revision;
            page.updatedAt = revision;
            delete page.deletedAt;
          });
          return state;
        };
        const fallback = api.createInitialState();
        fallback.workspaceName = 'fallback';
        setRevision(fallback, 1);
        const embedded = api.createInitialState();
        embedded.workspaceName = 'embedded';
        setRevision(embedded, 100);
        const loaded = api.createInitialState();
        loaded.workspaceName = 'loaded';
        loaded.documentId = embedded.documentId;
        setRevision(loaded, 200);
        const newerLoaded = api.chooseStartupState(embedded, loaded, fallback).workspaceName;
        setRevision(loaded, 50);
        const newerEmbedded = api.chooseStartupState(embedded, loaded, fallback).workspaceName;
        const fallbackOnly = api.chooseStartupState(null, null, fallback).workspaceName;
        return {
          newerLoaded,
          newerEmbedded,
          fallbackOnly,
          revision: api.getStateRevision({ lastModifiedAt: 1, exportedAt: 5, pages: { p: { updatedAt: 3, deletedAt: 7 } } })
        };
      }));
      assert.equal(result.newerLoaded, 'loaded');
      assert.equal(result.newerEmbedded, 'embedded');
      assert.equal(result.fallbackOnly, 'fallback');
      assert.equal(result.revision, 7);
    }
  },
  {
    name: 'file helper functions normalize names, sizes, data URLs, and reset blocks',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const textBlob = api._dataUrlToBlob('data:text/plain;base64,SGVsbG8=');
        const plainBlob = api._dataUrlToBlob('data:text/plain,Hi%20there');
        let invalid = '';
        try {
          api._dataUrlToBlob('https://example.com/file.txt');
        } catch (e) {
          invalid = e.message;
        }
        let oversized = '';
        try {
          api._dataUrlToBlob('data:text/plain;base64,QUJD', { maxBytes: 2 });
        } catch (e) {
          oversized = e.message;
        }
        const normalizedSmallFile = api.internals._normalizeFileDataUrl('data:text/plain;base64,QUI=', 2);
        const normalizedLargeFile = api.internals._normalizeFileDataUrl('data:text/plain;base64,QUJD', 2);
        const normalizedSmallImage = api.internals.normalizeImageUrl('data:image/png;base64,QUI=', 2);
        const normalizedLargeImage = api.internals.normalizeImageUrl('data:image/png;base64,QUJD', 2);
        const imageBlock = api.internals._resetBlockToImage({ type: 'text', content: 'old', children: [api.blk('text', 'child')] });
        const fileBlock = api._resetBlockToFile({ type: 'text', content: 'old', children: [api.blk('text', 'child')] });
        return {
          safeName: api._safeDownloadFileName('a/b:c*?.txt\u0000'),
          emptyName: api._safeDownloadFileName(''),
          sizeSmall: api._formatFileSize(999),
          sizeMedium: api._formatFileSize(1536),
          meta: api._formatFileMeta({ fileName: 'report.pdf', fileType: '', fileSize: 2048 }),
          textBlobType: textBlob.type,
          textBlobText: await textBlob.text(),
          plainBlobText: await plainBlob.text(),
          invalid,
          oversized,
          normalizedSmallFile,
          normalizedLargeFile,
          normalizedSmallImage,
          normalizedLargeImage,
          estimatedBytes: api.internals._estimateDataUrlDecodedBytes('data:text/plain;base64,QUJD'),
          imageBlock,
          fileBlock
        };
      }));
      assert.equal(result.safeName, 'a_b_c__.txt');
      assert.equal(result.emptyName, 'attachment');
      assert.equal(result.sizeSmall, '999 B');
      assert.equal(result.sizeMedium, '1.5 KB');
      assert.equal(result.meta, 'PDF · 2.0 KB');
      assert.equal(result.textBlobType, 'text/plain');
      assert.equal(result.textBlobText, 'Hello');
      assert.equal(result.plainBlobText, 'Hi there');
      assert.match(result.invalid, /Invalid file data/);
      assert.match(result.oversized, /too large/);
      assert.match(result.normalizedSmallFile, /^data:text\/plain;base64,/);
      assert.equal(result.normalizedLargeFile, '');
      assert.match(result.normalizedSmallImage, /^data:image\/png;base64,/);
      assert.equal(result.normalizedLargeImage, '');
      assert.equal(result.estimatedBytes, 3);
      assert.equal(result.imageBlock.type, 'image');
      assert.equal(result.imageBlock.children.length, 0);
      assert.equal(result.fileBlock.type, 'file');
      assert.equal(result.fileBlock.fileDataUrl, '');
    }
  },
  {
    name: 'local embedded data total helpers estimate, warn, and trim excess data URLs',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('image', '', { url: 'data:image/png;base64,QUJD' }),
          api.blk('file', '', { fileDataUrl: 'data:text/plain;base64,REU=', fileSize: 2 })
        ];
        api.setState(s);
        const beforeTotal = api.internals._estimateLocalEmbeddedDataTotalBytes(api.getState());
        const removed = api.internals._enforceLocalEmbeddedDataTotalLimit(api.getState(), { maxBytes: 3 });
        const afterBlocks = api.getState().pages[api.getState().currentPageId].blocks;

        const tooLargePromise = api.internals._confirmLocalEmbeddedDataAllowance(
          api.internals.LOCAL_EMBEDDED_DATA_TOTAL_MAX_BYTES + 1
        );
        await delay();
        const tooLargeText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]').click();
        const tooLargeAllowed = await tooLargePromise;

        return {
          beforeTotal,
          removed,
          imageUrl: afterBlocks[0].url,
          fileDataUrl: afterBlocks[1].fileDataUrl,
          fileSize: afterBlocks[1].fileSize,
          tooLargeText,
          tooLargeAllowed
        };
      }));
      assert.equal(result.beforeTotal, 5);
      assert.equal(result.removed, 1);
      assert.match(result.imageUrl, /^data:image\/png/);
      assert.equal(result.fileDataUrl, '');
      assert.equal(result.fileSize, 0);
      assert.equal(result.tooLargeAllowed, false);
      assert.match(result.tooLargeText, /100 MB|100MB/);
    }
  },
  {
    name: 'local image and attachment size limits warn and reject before FileReader',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
        const imageBoundary = await api.internals._confirmLocalFileRead(
          { size: api.internals.IMAGE_WARN_BYTES },
          api.internals.IMAGE_WARN_BYTES,
          'dialog.largeFileMessage'
        );

        const imageWarnPromise = api.internals._confirmLocalFileRead(
          { size: api.internals.IMAGE_WARN_BYTES + 1 },
          api.internals.IMAGE_WARN_BYTES,
          'dialog.largeFileMessage'
        );
        await delay();
        const imageWarnText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-cancel]').click();
        const imageWarn = await imageWarnPromise;

        const attachmentWarnPromise = api.internals._confirmLocalFileRead(
          { size: api.internals.ATTACHMENT_WARN_BYTES + 1 },
          api.internals.ATTACHMENT_WARN_BYTES,
          'dialog.largeAttachmentMessage'
        );
        await delay();
        const attachmentWarnText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]').click();
        const attachmentWarn = await attachmentWarnPromise;

        const tooLargePromise = api.internals._confirmLocalFileRead(
          { size: api.internals.LOCAL_FILE_MAX_BYTES + 1 },
          api.internals.IMAGE_WARN_BYTES,
          'dialog.largeFileMessage'
        );
        await delay();
        const tooLargeText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]').click();
        const tooLarge = await tooLargePromise;

        return {
          imageBoundary,
          imageWarn,
          imageWarnText,
          attachmentWarn,
          attachmentWarnText,
          tooLarge,
          tooLargeText
        };
      }));
      assert.equal(result.imageBoundary, true);
      assert.equal(result.imageWarn, false);
      assert.match(result.imageWarnText, /25 MB|25MB/);
      assert.equal(result.attachmentWarn, true);
      assert.match(result.attachmentWarnText, /50 MB|50MB/);
      assert.equal(result.tooLarge, false);
      assert.match(result.tooLargeText, /100 MB|100MB/);
    }
  },
  {
    name: 'mermaid previews render supported diagram families and fallback outlines',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const sources = [
          'flowchart TD\nA[Start] --> B{Choice}\nB --> C[Done]',
          'sequenceDiagram\nparticipant A as Alice\nA->>B: Hello\nNote over A,B: shared',
          'erDiagram\nCUSTOMER ||--o{ ORDER : places\nCUSTOMER {\nstring id\nstring name\n}',
          'gantt\ntitle Build\ndateFormat YYYY-MM-DD\nsection Work\nTask one :a1, 2026-01-01, 3d\nTask two :after a1, 2d',
          'stateDiagram-v2\n[*] --> Idle\nIdle --> Done: finish\nDone --> [*]',
          'pie title Pets\n"Dogs" : 42\n"Cats" : 28',
          'gantt\nsection Work\nHuge task : 999999999999999999999999999999d',
          'gantt\nsection Work\nHuge range : 2026-01-01, 9999-12-31',
          'not a diagram at all'
        ];
        return sources.map((source) => {
          const target = document.createElement('div');
          api.internals.renderMermaidDiagramPreview(target, source);
          return {
            svg: !!target.querySelector('svg'),
            fallback: !!target.querySelector('.mermaid-preview-fallback'),
            text: target.textContent
          };
        });
      }));
      assert.equal(result[0].svg, true);
      assert.equal(result[1].svg, true);
      assert.equal(result[2].svg, true);
      assert.equal(result[3].svg, true);
      assert.equal(result[4].svg, true);
      assert.equal(result[5].svg, true);
      assert.equal(result[6].fallback, true);
      assert.match(result[6].text, /Huge task/);
      assert.equal(result[7].fallback, true);
      assert.match(result[7].text, /Huge range/);
      assert.equal(result[8].fallback, true);
      assert.match(result[8].text, /not a diagram/);
    }
  },
  {
    name: 'mermaid previews fall back for oversized sources and excessive elements',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const render = (source) => {
          const target = document.createElement('div');
          api.internals.renderMermaidDiagramPreview(target, source);
          return {
            svg: !!target.querySelector('svg'),
            fallback: !!target.querySelector('.mermaid-preview-fallback'),
            text: target.textContent,
            elements: target.querySelectorAll('svg *').length
          };
        };
        const hugeFlow = [
          'flowchart TD',
          ...Array.from({ length: api.internals.MERMAID_MAX_NODES + 1 }, (_, i) => `N${i}[Node ${i}]`)
        ].join('\n');
        const hugeSequence = [
          'sequenceDiagram',
          'participant A',
          'participant B',
          ...Array.from({ length: api.internals.MERMAID_MAX_EDGES + 1 }, (_, i) => `A->>B: Message ${i}`)
        ].join('\n');
        const hugeGantt = [
          'gantt',
          'dateFormat YYYY-MM-DD',
          ...Array.from({ length: api.internals.MERMAID_MAX_GANTT_TASKS + 1 }, (_, i) => `Task ${i} : 2026-01-01, 1d`)
        ].join('\n');
        const tooManyLines = [
          'pie title Too many lines',
          ...Array.from({ length: api.internals.MERMAID_MAX_LINES + 1 }, (_, i) => `"Slice ${i}" : 1`)
        ].join('\n');
        const tooManyBytes = `flowchart TD\nA[${'x'.repeat(api.internals.MERMAID_SOURCE_MAX_BYTES + 1)}]`;
        return {
          hugeFlow: render(hugeFlow),
          hugeSequence: render(hugeSequence),
          hugeGantt: render(hugeGantt),
          tooManyLines: render(tooManyLines),
          tooManyBytes: render(tooManyBytes),
          stats: api.internals._mermaidSourceStats('flowchart TD\nA-->B')
        };
      }));
      assert.equal(result.hugeFlow.svg, false);
      assert.equal(result.hugeFlow.fallback, true);
      assert.match(result.hugeFlow.text, /Node 200/);
      assert.equal(result.hugeSequence.svg, false);
      assert.equal(result.hugeSequence.fallback, true);
      assert.equal(result.hugeGantt.svg, false);
      assert.equal(result.hugeGantt.fallback, true);
      assert.equal(result.tooManyLines.svg, false);
      assert.equal(result.tooManyLines.fallback, true);
      assert.equal(result.tooManyBytes.svg, false);
      assert.equal(result.tooManyBytes.fallback, true);
      assert.ok(result.tooManyBytes.text.length <= 4010);
      assert.equal(result.stats.lines, 2);
    }
  },
  {
    name: 'trash auto purge days are normalized and negative values do not purge',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const page = s.pages[s.currentPageId];
        const trashed = api.blk('text', 'trash');
        const trashPage = {
          id: 'trash-page',
          title: 'trash',
          icon: '',
          iconType: 'emoji',
          hasIcon: false,
          parentId: null,
          blocks: [trashed],
          children: [],
          createdAt: Date.now() - 1000000,
          updatedAt: Date.now() - 1000000,
          deletedAt: Date.now() - 1000000
        };
        s.pages[trashPage.id] = trashPage;
        s.rootPages = [page.id];
        s.trashAutoPurgeDays = -7;
        api.setState(s);
        const before = Object.keys(api.getState().pages).length;
        const purged = api.autoPurgeTrash();
        return {
          before,
          after: Object.keys(api.getState().pages).length,
          purged,
          days: api.getState().trashAutoPurgeDays,
          normalized: [
            api.internals.normalizeTrashAutoPurgeDays(7),
            api.internals.normalizeTrashAutoPurgeDays(42),
            api.internals.normalizeTrashAutoPurgeDays(-1)
          ]
        };
      }));
      assert.equal(result.days, 0);
      assert.equal(result.purged, 0);
      assert.equal(result.before, result.after);
      assert.deepEqual(result.normalized, [7, 0, 0]);
    }
  },
  {
    name: 'startup locale and trash purge helpers mutate nested persisted data safely',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const welcome = s.pages[s.currentPageId];
        api.internals._applyInitialWelcomePageLocale(welcome, 'ja');

        const trashRoot = api.createPage(null, { title: 'Expired root' });
        const trashChild = api.createPage(trashRoot.id, { title: 'Expired child' });
        const trashRootTwo = api.createPage(null, { title: 'Expired root two' });
        const old = Date.now() - 8 * 86400 * 1000;
        trashRoot.deletedAt = old;
        trashChild.deletedAt = old;
        trashRootTwo.deletedAt = old - 1000;
        s.pages[trashRoot.id] = trashRoot;
        s.pages[trashChild.id] = trashChild;
        s.pages[trashRootTwo.id] = trashRootTwo;
        s.rootPages = [welcome.id];
        s.trashAutoPurgeDays = 7;
        s.pages[welcome.id].blocks.push(api.blk('definition_list', '', {
          definitions: [{ term: '<img src=x onerror=bad()>Term', definition: '<b onclick=x>Def</b>' }]
        }));
        api.setState(s);
        api.sanitizeStateInPlace(api.getState());
        const sanitizedDefinition = api.getState().pages[welcome.id].blocks.at(-1).content;
        const beforeCount = Object.keys(api.getState().pages).length;
        const purged = api.autoPurgeTrash();
        return {
          welcomeTitle: welcome.title,
          welcomeIcon: welcome.icon,
          sanitizedDefinition,
          beforeCount,
          afterCount: Object.keys(api.getState().pages).length,
          purged,
          hasTrashRoot: !!api.getState().pages[trashRoot.id],
          hasTrashChild: !!api.getState().pages[trashChild.id],
          hasTrashRootTwo: !!api.getState().pages[trashRootTwo.id],
          lastAutoPurge: api.getState().trashLastAutoPurge,
          formattedAutoPurge: api.internals.formatAutoPurgeTimestamp(Date.UTC(2026, 4, 22, 3, 4))
        };
      }));
      assert.match(result.welcomeTitle, /LeafNote/);
      assert.equal(result.welcomeIcon, '👋');
      assert.equal(result.sanitizedDefinition.includes('onerror'), false);
      assert.equal(result.sanitizedDefinition.includes('onclick'), false);
      assert.ok(result.beforeCount > result.afterCount, JSON.stringify(result));
      assert.equal(result.purged, 2);
      assert.equal(result.hasTrashRoot, false);
      assert.equal(result.hasTrashChild, false);
      assert.equal(result.hasTrashRootTwo, false);
      assert.equal(result.lastAutoPurge.count, 2);
      assert.equal(result.lastAutoPurge.days, 7);
      assert.match(result.formattedAutoPurge, /2026\/05\/22/);
    }
  },
  {
    name: 'save fallback status appears when IndexedDB save fails',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        s.pages[s.currentPageId].title = 'Fallback Save';
        api.setState(s);
        const originalOpen = indexedDB.open;
        const originalSetTimeout = window.setTimeout;
        try {
          Object.defineProperty(indexedDB, 'open', {
            configurable: true,
            value: () => {
              const req = {};
              originalSetTimeout(() => {
                req.error = new Error('blocked');
                if (typeof req.onerror === 'function') req.onerror();
              }, 0);
              return req;
            }
          });
          window.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, Math.min(Number(ms) || 0, 5), ...args);
          await api._doSave();
          const status = document.querySelector('#save-status');
          const visibleText = status.textContent;
          const visible = !status.hidden;
          await delay(30);
          return {
            visible,
            visibleText,
            hiddenAfterTimer: status.hidden,
            savedFallback: !!localStorage.getItem('leafnote-markdown-native-v1')
          };
        } finally {
          Object.defineProperty(indexedDB, 'open', { configurable: true, value: originalOpen });
          window.setTimeout = originalSetTimeout;
        }
      }));
      assert.equal(result.visible, true);
      assert.match(result.visibleText, /IndexedDB|localStorage|保存/);
      assert.equal(result.hiddenAfterTimer, true);
      assert.equal(result.savedFallback, true);
    }
  },
  {
    name: 'async saves discard stale snapshots after a delayed database open',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalOpen = indexedDB.open;
        let firstRequest;
        try {
          const s = api.createInitialState();
          s.workspaceName = 'Old Save';
          api.setState(s);
          Object.defineProperty(indexedDB, 'open', {
            configurable: true,
            value: (...args) => {
              if (!firstRequest) { firstRequest = {}; return firstRequest; }
              return originalOpen.apply(indexedDB, args);
            }
          });
          const first = api._doSave();
          while (!firstRequest) await new Promise((resolve) => setTimeout(resolve, 1));
          api.getState().workspaceName = 'New Save';
          api.saveState();
          const second = api._doSave();
          const realRequest = originalOpen.call(indexedDB, 'LeafNoteMarkdownNativeDB', 1);
          await new Promise((resolve, reject) => {
            realRequest.onsuccess = resolve;
            realRequest.onerror = reject;
          });
          firstRequest.result = realRequest.result;
          firstRequest.onsuccess();
          const firstResult = await first;
          const secondResult = await second;
          const saved = await api.loadStateAsync();
          return { firstResult, secondResult, savedName: saved.workspaceName };
        } finally {
          Object.defineProperty(indexedDB, 'open', { configurable: true, value: originalOpen });
        }
      }));
      assert.equal(result.firstResult, false);
      assert.equal(result.secondResult, true);
      assert.equal(result.savedName, 'New Save');
    }
  },
  {
    name: 'FileReader failure paths reject image, attachment, and export conversions',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const OriginalFileReader = window.FileReader;
        class FailingFileReader {
          constructor() {
            this.error = new Error('reader failed');
            this.result = null;
          }
          readAsDataURL() {
            setTimeout(() => {
              if (typeof this.onerror === 'function') this.onerror();
            }, 0);
          }
        }
        window.FileReader = FailingFileReader;
        try {
          const image = await api.internals._readImageFileAsDataUrl(new File(['x'], 'x.png', { type: 'image/png' }))
            .then(() => 'resolved', (err) => err.message);
          const attachment = await api.internals._readAttachmentFileAsDataUrl(new File(['x'], 'x.txt', { type: 'text/plain' }))
            .then(() => 'resolved', (err) => err.message);
          const blob = await api.internals.blobToDataUrl(new Blob(['x'], { type: 'image/png' }))
            .then(() => 'resolved', (err) => err.message);
          return { image, attachment, blob };
        } finally {
          window.FileReader = OriginalFileReader;
        }
      }));
      assert.match(result.image, /reader failed|failed/i);
      assert.match(result.attachment, /reader failed|failed/i);
      assert.match(result.blob, /reader failed|failed/i);
    }
  },
  {
    name: 'loadStateAsync tolerates IndexedDB open and read request failures',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalOpen = indexedDB.open;
        try {
          const localState = api.createInitialState();
          localState.workspaceName = 'Local fallback';
          localStorage.setItem('leafnote-markdown-native-v1', JSON.stringify(localState));

          Object.defineProperty(indexedDB, 'open', {
            configurable: true,
            value: () => {
              const openReq = {};
              setTimeout(() => {
                openReq.result = {
                  transaction: () => ({
                    objectStore: () => ({
                      get: () => {
                        const getReq = {};
                        setTimeout(() => {
                          getReq.error = new Error('read failed');
                          if (typeof getReq.onerror === 'function') getReq.onerror();
                        }, 0);
                        return getReq;
                      }
                    })
                  })
                };
                if (typeof openReq.onsuccess === 'function') openReq.onsuccess();
              }, 0);
              return openReq;
            }
          });
          const readFailure = await api.loadStateAsync();
          await delay();

          Object.defineProperty(indexedDB, 'open', {
            configurable: true,
            value: () => {
              const openReq = {};
              setTimeout(() => {
                openReq.error = new Error('open failed');
                if (typeof openReq.onerror === 'function') openReq.onerror();
              }, 0);
              return openReq;
            }
          });
          const openFailure = await api.loadStateAsync();
          return {
            readFailureName: readFailure?.workspaceName || '',
            openFailureName: openFailure?.workspaceName || ''
          };
        } finally {
          Object.defineProperty(indexedDB, 'open', { configurable: true, value: originalOpen });
        }
      }));
      assert.equal(result.readFailureName, 'Local fallback');
      assert.equal(result.openFailureName, 'Local fallback');
    }
  },
  {
    name: 'remote image export inlines successes and reports failures',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalFetch = window.fetch;
        const state = api.createInitialState();
        const page = state.pages[state.currentPageId];
        page.blocks = [
          api.blk('image', '', { url: 'https://example.com/ok.png', caption: 'ok' }),
          api.blk('toggle', 'Parent', { children: [
            api.blk('image', '', { url: 'https://example.com/fail.png', caption: 'fail' }),
            api.blk('image', '', { url: 'data:image/png;base64,AAAA', caption: 'data' })
          ] })
        ];
        try {
          window.fetch = async (url) => {
            if (String(url).includes('/ok.png')) {
              return new Response(new Blob(['image-bytes'], { type: 'image/png' }), { status: 200 });
            }
            return new Response('not found', { status: 404 });
          };
          const inlineResult = await api.internals.inlineRemoteImagesForExport(state);
          return {
            inlineResult,
            okUrl: page.blocks[0].url,
            failUrl: page.blocks[1].children[0].url,
            dataUrl: page.blocks[1].children[1].url
          };
        } finally {
          window.fetch = originalFetch;
        }
      }));
      assert.equal(result.inlineResult.total, 2);
      assert.equal(result.inlineResult.converted, 1);
      assert.equal(result.inlineResult.failed.length, 1);
      assert.match(result.inlineResult.failed[0].reason, /HTTP 404/);
      assert.match(result.okUrl, /^data:image\/png;base64,/);
      assert.equal(result.failUrl, 'https://example.com/fail.png');
      assert.equal(result.dataUrl, 'data:image/png;base64,AAAA');
    }
  },
  {
    name: 'remote image export refuses private and local network fetch targets',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalFetch = window.fetch;
        const state = api.createInitialState();
        const current = state.pages[state.currentPageId];
        const urls = [
          'http://127.0.0.1/private.png',
          'http://localhost/private.png',
          'http://169.254.169.254/latest.png',
          'http://192.168.1.20/camera.png',
          'http://[::1]/loop.png',
          'http://[::ffff:127.0.0.1]/mapped-loop.png',
          'http://[::ffff:a00:1]/mapped-private.png',
          'http://[::ffff:c0a8:1]/mapped-router.png',
          'http://[::ffff:808:808]/mapped-public.png',
          'https://example.com/public.png'
        ];
        current.blocks = urls.map((url) => api.blk('image', '', { url, caption: url }));
        const fetched = [];
        try {
          window.fetch = async (url) => {
            fetched.push(String(url));
            return new Response(new Blob(['image-bytes'], { type: 'image/png' }), { status: 200 });
          };
          const inlineResult = await api.internals.inlineRemoteImagesForExport(state);
          return {
            inlineResult,
            fetched,
            urls: current.blocks.map((block) => block.url),
            privateChecks: urls.map((url) => api.internals.isPrivateNetworkUrl(url))
          };
        } finally {
          window.fetch = originalFetch;
        }
      }));
      assert.deepEqual(result.fetched, [
        'http://[::ffff:808:808]/mapped-public.png',
        'https://example.com/public.png'
      ]);
      assert.deepEqual(result.privateChecks, [true, true, true, true, true, true, true, true, false, false]);
      assert.equal(result.inlineResult.converted, 2);
      assert.equal(result.inlineResult.failed.length, 8);
      assert.equal(
        result.inlineResult.failed.every((item) => /private|local network/i.test(item.reason)),
        true
      );
      assert.deepEqual(result.urls.slice(0, 8), [
        'http://127.0.0.1/private.png',
        'http://localhost/private.png',
        'http://169.254.169.254/latest.png',
        'http://192.168.1.20/camera.png',
        'http://[::1]/loop.png',
        'http://[::ffff:127.0.0.1]/mapped-loop.png',
        'http://[::ffff:a00:1]/mapped-private.png',
        'http://[::ffff:c0a8:1]/mapped-router.png'
      ]);
      assert.match(result.urls[8], /^data:image\/png;base64,/);
      assert.match(result.urls[9], /^data:image\/png;base64,/);
    }
  },
  {
    name: 'remote image export enforces total embedded data cap and redirect target safety',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalFetch = window.fetch;
        const makeState = () => {
          const s = api.createInitialState();
          const current = s.pages[s.currentPageId];
          current.blocks = [
            api.blk('image', '', { url: 'data:image/png;base64,QUJD', caption: 'local' }),
            api.blk('image', '', { url: 'https://example.com/too-much.png', caption: 'remote' })
          ];
          return { s, current };
        };
        const fetched = [];
        const out = {};
        try {
          window.fetch = async (url) => {
            fetched.push(String(url));
            if (String(url).includes('/redirect-private.png')) {
              return new Response('', {
                status: 302,
                headers: { location: 'http://127.0.0.1/private.png' }
              });
            }
            if (String(url).includes('/redirect-public.png')) {
              return new Response('', {
                status: 302,
                headers: { location: '/final-public.png' }
              });
            }
            if (String(url).includes('/loop')) {
              return new Response('', {
                status: 302,
                headers: { location: '/loop-next.png' }
              });
            }
            return new Response(new Blob(['wxyz'], { type: 'image/png' }), { status: 200 });
          };

          const over = makeState();
          out.over = await api.internals.inlineRemoteImagesForExport(over.s, { maxEmbeddedBytes: 6 });
          out.overRemoteUrl = over.current.blocks[1].url;

          const exact = makeState();
          out.exact = await api.internals.inlineRemoteImagesForExport(exact.s, { maxEmbeddedBytes: 7 });
          out.exactRemoteUrl = exact.current.blocks[1].url;

          const redirectState = api.createInitialState();
          const current = redirectState.pages[redirectState.currentPageId];
          current.blocks = [
            api.blk('image', '', { url: 'https://example.com/redirect-private.png' }),
            api.blk('image', '', { url: 'https://example.com/redirect-public.png' })
          ];
          out.redirect = await api.internals.inlineRemoteImagesForExport(redirectState);
          out.redirectUrls = current.blocks.map((block) => block.url);
          try {
            await api.internals.fetchPublicRemoteImageResponse('https://example.com/loop-a.png', { maxRedirects: 1 });
          } catch (e) {
            out.loopMessage = e.message;
          }
          out.fetched = fetched;
          return out;
        } finally {
          window.fetch = originalFetch;
        }
      }));
      assert.equal(result.over.converted, 0);
      assert.equal(result.over.failed.length, 1);
      assert.match(result.over.failed[0].reason, /embedded local files exceed/);
      assert.equal(result.overRemoteUrl, 'https://example.com/too-much.png');
      assert.equal(result.exact.converted, 1);
      assert.match(result.exactRemoteUrl, /^data:image\/png;base64,/);
      assert.equal(result.redirect.converted, 1);
      assert.equal(result.redirect.failed.length, 1);
      assert.match(result.redirect.failed[0].reason, /private|local network/i);
      assert.equal(result.redirectUrls[0], 'https://example.com/redirect-private.png');
      assert.match(result.redirectUrls[1], /^data:image\/png;base64,/);
      assert.match(result.loopMessage, /redirect limit exceeded/);
      assert.deepEqual(result.fetched, [
        'https://example.com/too-much.png',
        'https://example.com/too-much.png',
        'https://example.com/redirect-private.png',
        'https://example.com/redirect-public.png',
        'https://example.com/final-public.png',
        'https://example.com/loop-a.png',
        'https://example.com/loop-next.png'
      ]);
    }
  },
  {
    name: 'remote image export limits inline fetch count and leaves skipped links intact',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalFetch = window.fetch;
        const max = api.internals.REMOTE_IMAGE_INLINE_MAX_COUNT;
        const state = api.createInitialState();
        const current = state.pages[state.currentPageId];
        current.blocks = Array.from({ length: max + 2 }, (_, i) =>
          api.blk('image', '', { url: `https://example.com/${i}.png`, caption: `Image ${i}` })
        );
        const fetched = [];
        try {
          window.fetch = async (url) => {
            fetched.push(String(url));
            return new Response(new Blob([String(url)], { type: 'image/png' }), { status: 200 });
          };
          const inlineResult = await api.internals.inlineRemoteImagesForExport(state, { limit: max });
          return {
            inlineResult,
            fetchedCount: fetched.length,
            firstUrl: current.blocks[0].url,
            lastFetchedUrl: current.blocks[max - 1].url,
            firstSkippedUrl: current.blocks[max].url,
            lastSkippedUrl: current.blocks[max + 1].url
          };
        } finally {
          window.fetch = originalFetch;
        }
      }));
      assert.equal(result.inlineResult.total, result.inlineResult.converted + result.inlineResult.skipped);
      assert.equal(result.inlineResult.converted, result.inlineResult.total - 2);
      assert.equal(result.inlineResult.skipped, 2);
      assert.equal(result.inlineResult.limited, true);
      assert.equal(result.fetchedCount, result.inlineResult.converted);
      assert.match(result.firstUrl, /^data:image\/png;base64,/);
      assert.match(result.lastFetchedUrl, /^data:image\/png;base64,/);
      assert.match(result.firstSkippedUrl, /^https:\/\/example\.com\/\d+\.png$/);
      assert.match(result.lastSkippedUrl, /^https:\/\/example\.com\/\d+\.png$/);
    }
  },
  {
    name: 'remote image fetch rejects oversized and timed-out images',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalFetch = window.fetch;
        const out = {};
        try {
          window.fetch = async () => new Response(new Blob(['x'], { type: 'image/png' }), {
            headers: { 'content-length': '2' }
          });
          try {
            await api.internals.fetchRemoteImageBlob('https://example.com/image.png', { maxBytes: 1 });
          } catch (e) {
            out.oversize = e.message;
          }
          window.fetch = (_url, opts) => new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
          try {
            await api.internals.fetchRemoteImageBlob('https://example.com/slow.png', { timeoutMs: 10 });
          } catch (e) {
            out.timeout = e.message;
          }
        } finally {
          window.fetch = originalFetch;
        }
        return out;
      }));
      assert.match(result.oversize, /larger than/);
      assert.match(result.timeout, /timed out/);
    }
  },
  {
    name: 'remote image response streams are capped while reading',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const max = api.internals.REMOTE_IMAGE_MAX_BYTES;
        const makeResponse = (chunks, headers = {}) => {
          let index = 0;
          let reads = 0;
          let cancelReason = '';
          const stream = new ReadableStream({
            pull(controller) {
              reads++;
              if (index < chunks.length) controller.enqueue(chunks[index++]);
              else controller.close();
            },
            cancel(reason) {
              cancelReason = String(reason || '');
            }
          });
          return {
            response: new Response(stream, { headers: { 'content-type': 'image/png', ...headers } }),
            stats: () => ({ reads, cancelReason })
          };
        };

        const exact = makeResponse([new Uint8Array(max)]);
        const exactBlob = await api.internals.readResponseBlobWithLimit(exact.response, { maxBytes: max });

        const oversized = makeResponse([new Uint8Array(max), new Uint8Array(1)]);
        const controller = new AbortController();
        let oversizedMessage = '';
        try {
          await api.internals.readResponseBlobWithLimit(oversized.response, {
            maxBytes: max,
            signal: controller.signal,
            abort: () => controller.abort()
          });
        } catch (e) {
          oversizedMessage = e.message;
        }

        let contentLengthBodyRead = false;
        const contentLength = {
          headers: new Headers({ 'content-type': 'image/png', 'content-length': String(max + 1) }),
          body: {
            getReader() {
              contentLengthBodyRead = true;
              throw new Error('body should not be read');
            }
          },
          async blob() {
            contentLengthBodyRead = true;
            return new Blob([new Uint8Array(1)], { type: 'image/png' });
          }
        };
        let contentLengthMessage = '';
        try {
          await api.internals.readResponseBlobWithLimit(contentLength, { maxBytes: max });
        } catch (e) {
          contentLengthMessage = e.message;
        }

        return {
          max,
          exactSize: exactBlob.size,
          exactReads: exact.stats().reads,
          oversizedMessage,
          oversizedStats: oversized.stats(),
          aborted: controller.signal.aborted,
          contentLengthMessage,
          contentLengthBodyRead
        };
      }));
      assert.equal(result.exactSize, result.max);
      assert.ok(result.exactReads >= 1);
      assert.match(result.oversizedMessage, /larger than/);
      assert.match(result.oversizedStats.cancelReason, /larger than/);
      assert.equal(result.aborted, true);
      assert.match(result.contentLengthMessage, /larger than/);
      assert.equal(result.contentLengthBodyRead, false);
    }
  },
  {
    name: 'self HTML export source fetch validates body, size, and timeout before adoption',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalFetch = window.fetch;
        const validHtml = [
          '<!DOCTYPE html><html><body>',
          '<button id="export-btn"></button>',
          '<div id="blocks"></div>',
          '<script id="embedded-state" type="application/json">{}</script>',
          '<script>function renderEditor(){ return "LeafNote"; }</script>',
          '</body></html>'
        ].join('');
        const max = 32;
        const out = {};
        try {
          window.fetch = async () => new Response(validHtml, {
            status: 200,
            headers: {
              'content-type': 'text/html',
              'content-length': String(new Blob([validHtml]).size)
            }
          });
          out.valid = await api.internals.fetchSelfHtmlForExport('https://example.com/LeafNote.html', {
            timeoutMs: 100,
            maxBytes: validHtml.length + 64
          });

          window.fetch = async () => new Response('<!DOCTYPE html><html><body>login</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' }
          });
          try {
            await api.internals.fetchSelfHtmlForExport('https://example.com/login', { timeoutMs: 100, maxBytes: 1024 });
          } catch (e) {
            out.login = e.message;
          }
          const fallback = await api.internals.getSourceHtmlForExport();
          out.fallbackHasApp = fallback.includes('id="export-btn"') && fallback.includes('id="embedded-state"');
          out.fallbackHasLogin = fallback.includes('<body>login</body>');

          let contentLengthBodyRead = false;
          const contentLengthResponse = {
            headers: new Headers({ 'content-length': String(max + 1) }),
            body: {
              getReader() {
                contentLengthBodyRead = true;
                throw new Error('body should not be read');
              }
            },
            async text() {
              contentLengthBodyRead = true;
              return '';
            }
          };
          try {
            await api.internals.readResponseTextWithLimit(contentLengthResponse, { maxBytes: max });
          } catch (e) {
            out.contentLength = e.message;
          }
          out.contentLengthBodyRead = contentLengthBodyRead;

          let cancelReason = '';
          const streamResponse = new Response(new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(max + 1));
            },
            cancel(reason) {
              cancelReason = String(reason || '');
            }
          }));
          try {
            await api.internals.readResponseTextWithLimit(streamResponse, { maxBytes: max });
          } catch (e) {
            out.stream = e.message;
          }
          out.cancelReason = cancelReason;

          window.fetch = (_url, opts) => new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
          try {
            await api.internals.fetchSelfHtmlForExport('https://example.com/slow', { timeoutMs: 10, maxBytes: 1024 });
          } catch (e) {
            out.timeout = e.message;
          }

          return out;
        } finally {
          window.fetch = originalFetch;
        }
      }));
      assert.equal(result.valid.includes('embedded-state'), true);
      assert.match(result.login, /not LeafNote/i);
      assert.equal(result.fallbackHasApp, true);
      assert.equal(result.fallbackHasLogin, false);
      assert.match(result.contentLength, /larger than/);
      assert.equal(result.contentLengthBodyRead, false);
      assert.match(result.stream, /larger than/);
      assert.match(result.cancelReason, /larger than/);
      assert.match(result.timeout, /timed out/);
    }
  },
  {
    name: 'search helpers cap result count and body scan budgets',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const titlePages = Array.from({ length: api.internals.SEARCH_MAX_RESULTS + 5 }, (_, i) => ({
          id: `title-${i}`,
          title: `needle title ${i}`,
          blocks: [api.blk('text', 'body')]
        }));
        const titleSearch = api.internals.collectSearchMatches('needle', titlePages);
        const bodyPages = Array.from({ length: api.internals.SEARCH_MAX_SCANNED_PAGES + 5 }, (_, i) => ({
          id: `body-${i}`,
          title: `Body ${i}`,
          blocks: [api.blk('text', i === 3 ? 'needle body' : 'plain body')]
        }));
        const bodySearch = api.internals.collectSearchMatches('needle', bodyPages);
        const absentSearch = api.internals.collectSearchMatches('absent', bodyPages);
        const budgetBlocks = Array.from({ length: api.internals.SEARCH_MAX_SCANNED_BLOCKS + 1 }, (_, i) => api.blk('text', `Block ${i}`));
        const limitedFlatten = api.internals.flattenTextFromBlocksWithinBudget(budgetBlocks, api.internals.SEARCH_MAX_SCANNED_BLOCKS);
        return {
          titleCount: titleSearch.pageMatches.length,
          titleLimited: titleSearch.limited,
          bodyCount: bodySearch.pageMatches.length,
          bodyLimited: bodySearch.limited,
          absentCount: absentSearch.pageMatches.length,
          absentLimited: absentSearch.limited,
          absentScannedPages: absentSearch.scannedPages,
          flattenedScannedBlocks: limitedFlatten.scannedBlocks,
          flattenedExhausted: limitedFlatten.exhausted
        };
      }));
      assert.equal(result.titleCount, 50);
      assert.equal(result.titleLimited, true);
      assert.equal(result.bodyCount, 1);
      assert.equal(result.bodyLimited, true);
      assert.equal(result.absentCount, 0);
      assert.equal(result.absentLimited, true);
      assert.equal(result.absentScannedPages, 300);
      assert.equal(result.flattenedScannedBlocks, 3000);
      assert.equal(result.flattenedExhausted, true);
    }
  },
  {
    name: 'search helpers include rich text display text, tables, captions, files, and definitions',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const blocks = [
          api.blk('text', 'Tom &amp; Jerry<br>Line Break'),
          api.blk('table', '', {
            rows: 1,
            cols: 2,
            hasHeaderRow: false,
            cells: [['<b>needle-cell &amp; value</b>', 'plain']]
          }),
          api.blk('image', '', {
            url: 'https://example.com/pic.png',
            caption: '<a href="https://example.com">needle-caption</a>'
          }),
          api.blk('file', '', {
            fileName: 'needle-file.pdf',
            fileType: 'application/pdf',
            fileSize: 12,
            fileDataUrl: 'data:application/pdf;base64,SGk='
          }),
          api.blk('definition_list', '', {
            definitions: [{ term: '<b>needle-term</b>', definition: 'needle-definition<br>next' }]
          }),
          api.blk('toggle', 'Parent', {
            children: [api.blk('text', 'nested-needle')]
          })
        ];
        const pages = [{ id: 'p', title: 'Page', blocks }];
        const flat = api.internals.flattenTextFromBlocks(blocks);
        const budget = api.internals.flattenTextFromBlocksWithinBudget(blocks, 20);
        return {
          flat,
          budget,
          tableMatchCount: api.internals.collectSearchMatches('needle-cell', pages).pageMatches.length,
          captionMatchCount: api.internals.collectSearchMatches('needle-caption', pages).pageMatches.length,
          fileMatchCount: api.internals.collectSearchMatches('needle-file', pages).pageMatches.length,
          definitionMatchCount: api.internals.collectSearchMatches('needle-definition next', pages).pageMatches.length,
          nestedMatchCount: api.internals.collectSearchMatches('nested-needle', pages).pageMatches.length
        };
      }));
      assert.match(result.flat, /Tom & Jerry Line Break/);
      assert.match(result.flat, /needle-cell & value/);
      assert.match(result.flat, /needle-caption/);
      assert.match(result.flat, /needle-file\.pdf/);
      assert.match(result.flat, /application\/pdf/);
      assert.match(result.flat, /12 B/);
      assert.match(result.flat, /needle-term/);
      assert.match(result.flat, /needle-definition next/);
      assert.match(result.budget.text, /nested-needle/);
      assert.equal(result.budget.exhausted, false);
      assert.equal(result.tableMatchCount, 1);
      assert.equal(result.captionMatchCount, 1);
      assert.equal(result.fileMatchCount, 1);
      assert.equal(result.definitionMatchCount, 1);
      assert.equal(result.nestedMatchCount, 1);
    }
  },
  {
    name: 'state payload parsing enforces UTF-8 byte limits before JSON.parse and keeps IndexedDB fallback',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const exact = JSON.stringify({ value: 'ok' });
        const exactBytes = new Blob([exact]).size;
        let oversizedCode = '';
        let invalidName = '';
        try {
          api.internals._parseStatePayloadWithLimit(exact + 'x', exactBytes);
        } catch (error) {
          oversizedCode = error.code || '';
        }
        try {
          api.internals._parseStatePayloadWithLimit('{broken', 64);
        } catch (error) {
          invalidName = error.name || '';
        }

        const s = api.createInitialState();
        s.workspaceName = 'IndexedDB payload fallback';
        api.setState(s);
        await api._doSave({ force: true });
        localStorage.setItem(api.internals.STATE_STORAGE_KEY, 'x'.repeat(65));
        const loaded = await api.loadStateAsync({ maxPayloadBytes: 64 });

        return {
          maxBytes: api.internals.STATE_PAYLOAD_MAX_BYTES,
          exactAllowed: !api.internals._statePayloadLimitViolation(exact, exactBytes),
          oneByteOverRejected: api.internals._statePayloadLimitViolation(exact + 'x', exactBytes),
          unicodeExactAllowed: !api.internals._statePayloadLimitViolation('éé', 4),
          unicodeOverRejected: api.internals._statePayloadLimitViolation('éé', 3),
          parsedValue: api.internals._parseStatePayloadWithLimit(exact, exactBytes).value,
          oversizedCode,
          invalidName,
          loadedName: loaded?.workspaceName || ''
        };
      }));
      assert.ok(result.maxBytes >= 100 * 1024 * 1024);
      assert.equal(result.exactAllowed, true);
      assert.equal(result.oneByteOverRejected, true);
      assert.equal(result.unicodeExactAllowed, true);
      assert.equal(result.unicodeOverRejected, true);
      assert.equal(result.parsedValue, 'ok');
      assert.equal(result.oversizedCode, 'STATE_PAYLOAD_TOO_LARGE');
      assert.equal(result.invalidName, 'SyntaxError');
      assert.equal(result.loadedName, 'IndexedDB payload fallback');
    }
  },
  {
    name: 'state payload save guards reject oversized snapshots before storage writes',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        s.workspaceName = 'payload-exact-boundary';
        api.setState(s);
        const exactSnapshot = JSON.stringify(api.getState());
        const exactBytes = new Blob([exactSnapshot]).size;
        const exactSaved = await api._doSave({ force: true, maxPayloadBytes: exactBytes });
        const persistedExact = JSON.parse(localStorage.getItem(api.internals.STATE_STORAGE_KEY) || '{}');

        const oversized = api.getState();
        oversized.workspaceName = 'payload-over-boundary';
        api.setState(oversized);
        const oversizedSnapshot = JSON.stringify(api.getState());
        const oversizedMaxBytes = new Blob([oversizedSnapshot]).size - 1;
        const oversizedSaved = await api._doSave({ force: true, maxPayloadBytes: oversizedMaxBytes });
        const afterAsyncAttempt = JSON.parse(localStorage.getItem(api.internals.STATE_STORAGE_KEY) || '{}');

        api.internals.flushStateToLocalStorageSync({ maxPayloadBytes: oversizedMaxBytes });
        const afterSyncAttempt = JSON.parse(localStorage.getItem(api.internals.STATE_STORAGE_KEY) || '{}');
        const status = document.getElementById('save-status')?.textContent || '';

        return {
          exactSaved,
          persistedExactName: persistedExact.workspaceName,
          oversizedSaved,
          afterAsyncName: afterAsyncAttempt.workspaceName,
          afterSyncName: afterSyncAttempt.workspaceName,
          status,
          statusHidden: document.getElementById('save-status')?.hidden ?? true
        };
      }));
      assert.equal(result.exactSaved, true);
      assert.equal(result.persistedExactName, 'payload-exact-boundary');
      assert.equal(result.oversizedSaved, false);
      assert.equal(result.afterAsyncName, 'payload-exact-boundary');
      assert.equal(result.afterSyncName, 'payload-exact-boundary');
      assert.match(result.status, /Saved data is over/);
      assert.equal(result.statusHidden, false);
    }
  },
  {
    name: 'undo history skips oversized snapshots and trims total bytes',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        api.setState(api.createInitialState());
        const maxSnapshot = api.internals.UNDO_MAX_SNAPSHOT_BYTES;
        const maxTotal = api.internals.UNDO_MAX_TOTAL_BYTES;
        const smallPushed = api.internals._pushUndoStackSnapshot('small');
        const afterSmall = api.internals._historyStackInfo();
        const oversizedPushed = api.internals._pushUndoStackSnapshot('x'.repeat(maxSnapshot + 1));
        const afterOversized = api.internals._historyStackInfo();
        api.setState(api.createInitialState());
        const chunkSize = maxSnapshot - 1024;
        const attempts = Math.floor(maxTotal / chunkSize) + 2;
        const pushed = [];
        for (let i = 0; i < attempts; i++) {
          pushed.push(api.internals._pushUndoStackSnapshot(`${i}:` + 'y'.repeat(chunkSize - 8)));
        }
        const afterTotal = api.internals._historyStackInfo();
        return {
          smallPushed,
          afterSmall,
          oversizedPushed,
          afterOversized,
          pushed,
          afterTotal,
          maxTotal
        };
      }));
      assert.equal(result.smallPushed, true);
      assert.equal(result.afterSmall.undoCount, 1);
      assert.equal(result.oversizedPushed, false);
      assert.equal(result.afterOversized.undoCount, 1);
      assert.equal(result.pushed.every(Boolean), true);
      assert.ok(result.afterTotal.undoBytes <= result.maxTotal);
      assert.ok(result.afterTotal.undoCount < result.pushed.length);
    }
  },
  {
    name: 'index embedded LeafNote source matches LeafNote.html',
    run: async () => {
      const [appSource, indexSource] = await Promise.all([
        readFile(appPath, 'utf8'),
        readFile(indexPath, 'utf8')
      ]);
      const sourceTags = indexSource.match(/<script id="leafnote-source" type="application\/json">/g) || [];
      assert.equal(sourceTags.length, 1, 'index.html must contain exactly one #leafnote-source script');
      const match = /<script id="leafnote-source" type="application\/json">([\s\S]*?)<\/script>/.exec(indexSource);
      assert.ok(match, 'index.html is missing #leafnote-source');
      assert.equal(match[1].includes('<'), false, '#leafnote-source must escape literal < characters');
      const embeddedSource = JSON.parse(match[1]);
      if (embeddedSource !== appSource) {
        let firstDiff = 0;
        const max = Math.min(embeddedSource.length, appSource.length);
        while (firstDiff < max && embeddedSource[firstDiff] === appSource[firstDiff]) firstDiff++;
        assert.fail(`index leafnote-source differs from LeafNote.html at offset ${firstDiff}; embedded=${embeddedSource.length} bytes, app=${appSource.length} bytes`);
      }
      const sourceEnd = indexSource.indexOf('</script>', match.index);
      const afterSource = indexSource.slice(sourceEnd + '</script>'.length);
      assert.equal(afterSource.includes('const blockSelectorById'), false);
      assert.equal(afterSource.includes('function parseMarkdownToBlocks'), false);
      assert.equal((afterSource.match(/document\.addEventListener\("click"/g) || []).length, 1);
    }
  }
];

const maskingerUnitTests = [
  {
    name: 'Maskinger masks repeated secrets deterministically and restores with current tab mappings',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const openAiKey = 'sk-' + 'A'.repeat(24);
        const githubToken = 'ghp_' + 'B'.repeat(24);
        const jwt = 'eyJ' + 'a'.repeat(10) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
        const input = [
          `Authorization: Bearer ${openAiKey}`,
          `github=${githubToken}`,
          `jwt=${jwt}`,
          'email: alice@example.com',
          'url=https://secret.example.com/path?token=abc',
          'phone: 03-1234-5678',
          '住所: 東京都千代田区丸の内1-1-1',
          `repeat: Bearer ${openAiKey}`
        ].join('\n');
        const masked = api.mask(input);
        const restored = api.restore(masked.text);
        const repeated = masked.text.match(/MASK_SECRET_\d{4,}/g) || [];
        const mappings = api.mappings();
        return {
          mode: masked.mode,
          maskedText: masked.text,
          restored,
          mappings,
          repeatedSecretPlaceholders: repeated
        };
      }));
      assert.equal(result.mode, 'TEXT');
      assert.equal(result.restored.text.includes('alice@example.com'), true);
      assert.equal(result.restored.text.includes('東京都千代田区丸の内1-1-1'), true);
      assert.equal(result.restored.text.includes('MASK_SECRET_'), false);
      assert.ok(result.restored.restored >= result.mappings.length - 1);
      assert.equal(result.restored.unresolved, 0);
      assert.equal(result.maskedText.includes('alice@example.com'), false);
      assert.equal(result.maskedText.includes('sk-'), false);
      assert.equal(result.maskedText.includes('secret.example.com'), false);
      assert.equal(result.maskedText.includes('03-1234-5678'), false);
      assert.match(result.maskedText, /Authorization: Bearer MASK_SECRET_\d{4,}/);
      assert.match(result.maskedText, /MASK_EMAIL_\d{4,}/);
      assert.match(result.maskedText, /MASK_ADDRESS_\d{4,}/);
      assert.ok(result.repeatedSecretPlaceholders.length >= 2);
      assert.equal(
        new Set(result.repeatedSecretPlaceholders).size < result.repeatedSecretPlaceholders.length,
        true
      );
      assert.equal(result.mappings.some((item) => /^MASK_/.test(item._original)), false);
    }
  },
  {
    name: 'Maskinger SQL mode masks identifiers and values while preserving SQL structure',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const sql = [
          'SELECT users.email, orders.total',
          'FROM billing.users',
          'JOIN orders ON orders.user_id = users.id',
          "WHERE users.email = 'alice@example.com' AND orders.total > 100",
          '<if test="tenantId != null">AND tenant_id = #{tenantId}</if>'
        ].join('\n');
        const masked = api.mask(sql);
        const restored = api.restore(masked.text);
        return {
          mode: masked.mode,
          maskedText: masked.text,
          restored,
          mappings: api.mappings()
        };
      }));
      assert.equal(result.mode, 'SQL');
      assert.match(result.maskedText, /^SELECT /);
      assert.match(result.maskedText, /\bFROM\b/);
      assert.match(result.maskedText, /<if test="tenantId != null">/);
      assert.equal(result.maskedText.includes('alice@example.com'), false);
      assert.equal(result.maskedText.includes('billing.users'), false);
      assert.match(result.maskedText, /MASK_SQL_(COL|TABLE|VALUE|PARAM)_\d{4,}/);
      assert.equal(result.restored.text.includes('alice@example.com'), true);
      assert.equal(result.restored.text.includes('billing.users'), true);
      assert.equal(result.restored.unresolved, 0);
      assert.ok(result.mappings.length >= 4);
    }
  },
  {
    name: 'Maskinger broad sensitive corpus masks and restores without raw leakage',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const rawValues = [
          'AKIA1234567890ABCDEF',
          'AIza' + 'D'.repeat(24),
          'xoxb-12345678901234567890',
          'sk_live_1234567890abcdef',
          'postgres://user:pass@db.example.com:5432/app',
          'mongodb+srv://user:pass@cluster.example.com/app',
          '123e4567-e89b-12d3-a456-426614174000',
          '123-45-6789',
          '4111 1111 1111 1111',
          '100-0001',
          '192.168.10.20',
          'aa:bb:cc:dd:ee:ff',
          'JP12ABCDEF1234567890',
          '山田太郎',
          '株式会社テスト',
          '東京都千代田区丸の内1-1-1'
        ];
        const input = [
          `aws=${rawValues[0]}`,
          `api_key=${rawValues[1]}`,
          `slack=${rawValues[2]}`,
          `stripe=${rawValues[3]}`,
          `database=${rawValues[4]}`,
          `mongo=${rawValues[5]}`,
          `uuid=${rawValues[6]}`,
          `ssn=${rawValues[7]}`,
          `card=${rawValues[8]}`,
          `postal=${rawValues[9]}`,
          `ip=${rawValues[10]}`,
          `mac=${rawValues[11]}`,
          `account=${rawValues[12]}`,
          `氏名: ${rawValues[13]}`,
          `会社名: ${rawValues[14]}`,
          `住所: ${rawValues[15]}`
        ].join('\n');
        const masked = api.mask(input);
        const restored = api.restore(masked.text);
        const mappings = api.mappings();
        return {
          mode: masked.mode,
          maskedText: masked.text,
          restored,
          mappings,
          leakedValues: rawValues.filter((value) => masked.text.includes(value)),
          missingRestoredValues: rawValues.filter((value) => !restored.text.includes(value)),
          placeholderOriginals: mappings.filter((item) => /^MASK_/.test(item._original))
        };
      }));
      assert.equal(result.mode, 'TEXT');
      assert.deepEqual(result.leakedValues, []);
      assert.deepEqual(result.missingRestoredValues, []);
      assert.deepEqual(result.placeholderOriginals, []);
      assert.equal(result.restored.unresolved, 0);
      assert.match(result.maskedText, /MASK_SECRET_\d{4,}/);
      assert.match(result.maskedText, /MASK_CARD_\d{4,}/);
      assert.match(result.maskedText, /MASK_MAC_\d{4,}/);
      assert.match(result.maskedText, /MASK_ADDRESS_\d{4,}/);
      assert.ok(result.mappings.length >= 12);
    }
  },
  {
    name: 'Maskinger limit helpers enforce input and mapping boundaries',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const limits = api.limits();
        const exactBytes = 'a'.repeat(limits.inputMaxBytes);
        const overBytes = `${exactBytes}a`;
        const exactLines = Array.from({ length: limits.inputMaxLines }, () => 'x').join('\n');
        const overLines = `${exactLines}\nx`;
        const exactOriginal = 'x'.repeat(limits.mappingOriginalMaxBytes);
        const overOriginal = `${exactOriginal}x`;
        const exactOriginalResult = api.mask(`password=${exactOriginal}`);
        const exactOriginalMappingCount = api.mappings().length;
        api.clear();
        const overOriginalResult = api.mask(`password=${overOriginal}`);
        const overOriginalMappingCount = api.mappings().length;
        return {
          exactBytesViolation: api.validateInput(exactBytes),
          overBytesViolation: api.validateInput(overBytes),
          exactLinesViolation: api.validateInput(exactLines),
          overLinesViolation: api.validateInput(overLines),
          exactOriginalRejected: Boolean(exactOriginalResult.rejected),
          exactOriginalMappingCount,
          overOriginalRejected: Boolean(overOriginalResult.rejected),
          overOriginalCode: overOriginalResult.violation?.code,
          overOriginalMappingCount
        };
      }));
      assert.equal(result.exactBytesViolation, null);
      assert.equal(result.overBytesViolation.code, 'input_bytes');
      assert.equal(result.exactLinesViolation, null);
      assert.equal(result.overLinesViolation.code, 'input_lines');
      assert.equal(result.exactOriginalRejected, false);
      assert.equal(result.exactOriginalMappingCount, 1);
      assert.equal(result.overOriginalRejected, true);
      assert.equal(result.overOriginalCode, 'mapping_original_bytes');
      assert.equal(result.overOriginalMappingCount, 0);
    }
  }
];

const maskingerIntegrationTests = [
  {
    name: 'Maskinger UI persists mappings in sessionStorage and restores after reload',
    run: async (page) => {
      const first = await evaluate(page, js(() => {
        window.__MaskingerTest.clear();
        const secret = 'sk-' + 'C'.repeat(24);
        const source = document.querySelector('#source-input');
        source.value = `token=${secret}\nemail=alice@example.com`;
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const masked = document.querySelector('#masked-output').value;
        const mappingText = document.querySelector('#mapping-body').textContent;
        const stored = sessionStorage.getItem('maskinger.activeMappings.v2');
        return {
          masked,
          mappingText,
          storedLength: stored ? stored.length : 0,
          mappingCount: window.__MaskingerTest.mappings().length
        };
      }));
      assert.match(first.masked, /MASK_SECRET_\d{4,}/);
      assert.match(first.masked, /MASK_EMAIL_\d{4,}/);
      assert.equal(first.masked.includes('alice@example.com'), false);
      assert.equal(first.mappingText.includes('alice@example.com'), true);
      assert.ok(first.storedLength > 20);
      assert.equal(first.mappingCount, 2);

      await page.send('Page.reload', { ignoreCache: true });
      await waitForReady(page, '!!window.__MaskingerTest && !!document.querySelector("#source-input")');

      const second = await evaluate(page, jsWithArgs((masked) => {
        const restore = document.querySelector('#restore-input');
        restore.value = masked;
        restore.dispatchEvent(new Event('input', { bubbles: true }));
        const restored = document.querySelector('#restore-output').value;
        document.querySelector('#clear-all-btn').click();
        return {
          restored,
          afterClearStored: sessionStorage.getItem('maskinger.activeMappings.v2'),
          afterClearMasked: document.querySelector('#masked-output').value,
          afterClearMappings: window.__MaskingerTest.mappings().length
        };
      }, first.masked));
      assert.equal(second.restored.includes('alice@example.com'), true);
      assert.equal(second.restored.includes('token=sk-'), true);
      assert.equal(second.restored.includes('MASK_'), false);
      assert.equal(second.afterClearStored, null);
      assert.equal(second.afterClearMasked, '');
      assert.equal(second.afterClearMappings, 0);
    }
  },
  {
    name: 'Maskinger rejected oversized source and restore inputs keep previous UI state',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const limits = api.limits();
        const source = document.querySelector('#source-input');
        const maskedOutput = document.querySelector('#masked-output');
        const restoreInput = document.querySelector('#restore-input');
        const restoreOutput = document.querySelector('#restore-output');
        const toast = document.querySelector('#toast');

        source.value = 'email=accepted@example.com';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const accepted = {
          source: source.value,
          masked: maskedOutput.value,
          mappings: api.mappings()
        };

        source.value = 'a'.repeat(limits.inputMaxBytes + 1);
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const afterByteReject = {
          sourceLength: source.value.length,
          source: source.value,
          masked: maskedOutput.value,
          mappings: api.mappings(),
          toast: toast.textContent
        };

        source.value = Array.from({ length: limits.inputMaxLines + 1 }, () => 'x').join('\n');
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const afterLineReject = {
          source: source.value,
          masked: maskedOutput.value,
          mappings: api.mappings(),
          toast: toast.textContent
        };

        restoreInput.value = 'MASK_EMAIL_0001';
        restoreInput.dispatchEvent(new Event('input', { bubbles: true }));
        const restoreAccepted = {
          input: restoreInput.value,
          output: restoreOutput.value
        };

        restoreInput.value = 'b'.repeat(limits.inputMaxBytes + 1);
        restoreInput.dispatchEvent(new Event('input', { bubbles: true }));
        const restoreRejected = {
          input: restoreInput.value,
          output: restoreOutput.value,
          toast: toast.textContent
        };

        return { accepted, afterByteReject, afterLineReject, restoreAccepted, restoreRejected };
      }));
      assert.match(result.accepted.masked, /MASK_EMAIL_0001/);
      assert.equal(result.accepted.mappings.length, 1);
      assert.equal(result.afterByteReject.source, result.accepted.source);
      assert.equal(result.afterByteReject.masked, result.accepted.masked);
      assert.deepEqual(result.afterByteReject.mappings, result.accepted.mappings);
      assert.match(result.afterByteReject.toast, /マスク前の入力/);
      assert.equal(result.afterLineReject.source, result.accepted.source);
      assert.equal(result.afterLineReject.masked, result.accepted.masked);
      assert.deepEqual(result.afterLineReject.mappings, result.accepted.mappings);
      assert.match(result.afterLineReject.toast, /5000行/);
      assert.equal(result.restoreAccepted.output, 'accepted@example.com');
      assert.equal(result.restoreRejected.input, result.restoreAccepted.input);
      assert.equal(result.restoreRejected.output, result.restoreAccepted.output);
      assert.match(result.restoreRejected.toast, /復元前の入力/);
    }
  },
  {
    name: 'Maskinger ignores stale placeholder mappings and restores nested legacy placeholders after reload',
    run: async (page) => {
      await evaluate(page, js(() => {
        const legacyMappings = [
          { _placeholder: 'MASK_SECRET_0001', _type: 'SECRET', _original: 'legacy-secret-value' },
          { _placeholder: 'MASK_SECRET_0002', _type: 'SECRET', _original: 'MASK_SECRET_0001' },
          { _placeholder: 'MASK_SECRET_0003', _type: 'SECRET', _original: 'duplicate-a' },
          { _placeholder: 'MASK_SECRET_0003', _type: 'SECRET', _original: 'duplicate-b' },
          { _placeholder: 'MASK_URL_0001', _type: 'URL', _original: 'https://legacy.example.com/callback?token=MASK_SECRET_0001' },
          { _placeholder: 'MASK_EMAIL_0099', _type: 'EMAIL', _original: 'legacy@example.com' },
          { _placeholder: 'not-a-mask', _type: 'EMAIL', _original: 'invalid@example.com' }
        ];
        sessionStorage.setItem('maskinger.activeMappings.v2', JSON.stringify(legacyMappings));
      }));
      await page.send('Page.reload', { ignoreCache: true });
      await waitForReady(page, '!!window.__MaskingerTest && !!document.querySelector("#source-input")');

      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        const beforeMappings = api.mappings();
        const restored = api.restore('url=MASK_URL_0001\nmail=MASK_EMAIL_0099').text;
        const maskedNew = api.mask('email=new@example.com');
        return {
          beforeMappings,
          restored,
          maskedNew: maskedNew.text,
          afterMappings: api.mappings()
        };
      }));
      assert.equal(result.restored.includes('https://legacy.example.com/callback?token=legacy-secret-value'), true);
      assert.equal(result.restored.includes('MASK_SECRET_'), false);
      assert.equal(result.restored.includes('legacy@example.com'), true);
      assert.equal(result.beforeMappings.some((item) => /^MASK_/.test(item._original)), false);
      assert.equal(
        result.beforeMappings.filter((item) => item._placeholder === 'MASK_SECRET_0003').length,
        1
      );
      assert.equal(result.beforeMappings.some((item) => item._placeholder === 'not-a-mask'), false);
      assert.match(result.maskedNew, /MASK_EMAIL_0100/);
      assert.equal(result.afterMappings.some((item) => item._original === 'new@example.com'), true);
    }
  },
  {
    name: 'Maskinger mapping cap rejects new placeholders and caps rendered rows',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const limits = api.limits();
        const mappings = Array.from({ length: limits.maxMappings }, (_, index) => {
          const number = String(index + 1).padStart(4, '0');
          return {
            _placeholder: `MASK_EMAIL_${number}`,
            _type: 'EMAIL',
            _original: `user${index}@example.com`
          };
        });
        const replaceResult = api.replaceMappings(mappings);
        const source = document.querySelector('#source-input');
        const maskedOutput = document.querySelector('#masked-output');
        const toast = document.querySelector('#toast');

        source.value = 'email=user0@example.com';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const accepted = {
          source: source.value,
          masked: maskedOutput.value,
          mappingCount: api.mappings().length
        };

        source.value = 'email=new-cap@example.com';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const rows = Array.from(document.querySelectorAll('#mapping-body tr'));
        return {
          limits,
          replaceResult,
          accepted,
          rejected: {
            source: source.value,
            masked: maskedOutput.value,
            mappingCount: api.mappings().length,
            toast: toast.textContent
          },
          renderedRows: rows.length,
          renderedSummary: rows.at(-1)?.textContent || ''
        };
      }));
      assert.equal(result.replaceResult.loaded, result.limits.maxMappings);
      assert.equal(result.accepted.masked, 'email=MASK_EMAIL_0001');
      assert.equal(result.accepted.mappingCount, result.limits.maxMappings);
      assert.equal(result.rejected.source, result.accepted.source);
      assert.equal(result.rejected.masked, result.accepted.masked);
      assert.equal(result.rejected.mappingCount, result.limits.maxMappings);
      assert.match(result.rejected.toast, /対応表は1000件まで/);
      assert.equal(result.renderedRows, result.limits.mappingRenderMaxRows + 1);
      assert.match(result.renderedSummary, /表示を省略/);
    }
  },
  {
    name: 'Maskinger normalizes oversized persisted mappings on reload',
    run: async (page) => {
      await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const limits = api.limits();
        const persisted = [
          { _placeholder: 'MASK_SECRET_0001', _type: 'SECRET', _original: 'x'.repeat(limits.mappingOriginalMaxBytes + 1) },
          { _placeholder: 'not-a-mask', _type: 'EMAIL', _original: 'invalid@example.com' }
        ];
        for (let index = 0; index < limits.maxMappings + 25; index += 1) {
          const number = String(index + 1).padStart(4, '0');
          persisted.push({
            _placeholder: `MASK_EMAIL_${number}`,
            _type: 'EMAIL',
            _original: `persisted${index}@example.com`
          });
        }
        sessionStorage.setItem('maskinger.activeMappings.v2', JSON.stringify(persisted));
      }));
      await page.send('Page.reload', { ignoreCache: true });
      await waitForReady(page, '!!window.__MaskingerTest && !!document.querySelector("#source-input")');

      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        const limits = api.limits();
        const mappings = api.mappings();
        const rows = Array.from(document.querySelectorAll('#mapping-body tr'));
        const stored = JSON.parse(sessionStorage.getItem('maskinger.activeMappings.v2'));
        return {
          limits,
          mappingCount: mappings.length,
          hasOversizedOriginal: mappings.some((item) => item._original.length > limits.mappingOriginalMaxBytes),
          hasInvalidPlaceholder: mappings.some((item) => item._placeholder === 'not-a-mask'),
          firstPlaceholder: mappings[0]?._placeholder,
          storedCount: stored.length,
          renderedRows: rows.length,
          renderedSummary: rows.at(-1)?.textContent || '',
          toast: document.querySelector('#toast').textContent
        };
      }));
      assert.equal(result.mappingCount, result.limits.maxMappings);
      assert.equal(result.hasOversizedOriginal, false);
      assert.equal(result.hasInvalidPlaceholder, false);
      assert.equal(result.firstPlaceholder, 'MASK_EMAIL_0001');
      assert.equal(result.storedCount, result.limits.maxMappings);
      assert.equal(result.renderedRows, result.limits.mappingRenderMaxRows + 1);
      assert.match(result.renderedSummary, /表示を省略/);
      assert.match(result.toast, /安全な上限/);
    }
  },
  {
    name: 'Maskinger rejects mapping creation when serialized storage would exceed cap',
    run: async (page) => {
      const first = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const limits = api.limits();
        const storageKey = 'maskinger.activeMappings.v2';
        const bytesOf = (value) => new TextEncoder().encode(String(value ?? '')).length;
        const serializedBytes = (items) => bytesOf(JSON.stringify(items));
        const mappingFor = (index, original) => ({
          _placeholder: `MASK_EMAIL_${String(index + 1).padStart(4, '0')}`,
          _type: 'EMAIL',
          _original: original
        });
        const uniqueOriginal = (index, byteLength) => {
          const prefix = `value-${index}-`;
          if (byteLength <= prefix.length) return prefix.slice(0, byteLength).padEnd(byteLength, 'x');
          return prefix + 'x'.repeat(byteLength - prefix.length);
        };
        const buildExactMappings = (targetBytes) => {
          const mappings = [mappingFor(0, 'accepted@example.com')];
          while (mappings.length < limits.maxMappings) {
            const index = mappings.length;
            const candidate = [...mappings, mappingFor(index, '')];
            const remaining = targetBytes - serializedBytes(candidate);
            if (remaining < 0) throw new Error('Unable to build exact mapping storage fixture');
            if (remaining <= limits.mappingOriginalMaxBytes) {
              candidate[candidate.length - 1]._original = uniqueOriginal(index, remaining);
              if (serializedBytes(candidate) !== targetBytes) {
                throw new Error('Exact mapping storage fixture byte length mismatch');
              }
              return candidate;
            }
            candidate[candidate.length - 1]._original = uniqueOriginal(index, limits.mappingOriginalMaxBytes);
            mappings.push(candidate[candidate.length - 1]);
          }
          throw new Error('Unable to fit exact mapping storage fixture within mapping count cap');
        };

        const exactMappings = buildExactMappings(limits.storageMaxBytes);
        const replaceResult = api.replaceMappings(exactMappings);
        const storedBefore = sessionStorage.getItem(storageKey);
        const source = document.querySelector('#source-input');
        const maskedOutput = document.querySelector('#masked-output');
        const toast = document.querySelector('#toast');

        source.value = 'email=accepted@example.com';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const accepted = {
          source: source.value,
          masked: maskedOutput.value,
          mappingCount: api.mappings().length,
          storedBytes: bytesOf(sessionStorage.getItem(storageKey))
        };

        source.value = 'email=new-overflow@example.com';
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const mappingsAfterReject = api.mappings();
        const storedAfterReject = sessionStorage.getItem(storageKey);

        return {
          storageMaxBytes: limits.storageMaxBytes,
          exactCount: exactMappings.length,
          exactBytes: serializedBytes(exactMappings),
          replaceResult,
          storedBeforeBytes: bytesOf(storedBefore),
          accepted,
          rejected: {
            source: source.value,
            masked: maskedOutput.value,
            mappingCount: mappingsAfterReject.length,
            storedBytes: bytesOf(storedAfterReject),
            storageSame: storedAfterReject === storedBefore,
            mappingsSame: JSON.stringify(mappingsAfterReject) === storedBefore,
            toast: toast.textContent
          }
        };
      }));
      assert.equal(first.exactBytes, first.storageMaxBytes);
      assert.equal(first.storedBeforeBytes, first.storageMaxBytes);
      assert.equal(first.replaceResult.loaded, first.exactCount);
      assert.match(first.accepted.masked, /email=MASK_EMAIL_0001/);
      assert.equal(first.accepted.mappingCount, first.exactCount);
      assert.equal(first.accepted.storedBytes, first.storageMaxBytes);
      assert.equal(first.rejected.source, first.accepted.source);
      assert.equal(first.rejected.masked, first.accepted.masked);
      assert.equal(first.rejected.mappingCount, first.exactCount);
      assert.equal(first.rejected.storedBytes, first.storageMaxBytes);
      assert.equal(first.rejected.storageSame, true);
      assert.equal(first.rejected.mappingsSame, true);
      assert.match(first.rejected.toast, /保存容量|2 MiB/);

      await page.send('Page.reload', { ignoreCache: true });
      await waitForReady(page, '!!window.__MaskingerTest && !!document.querySelector("#source-input")');

      const second = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        const storageKey = 'maskinger.activeMappings.v2';
        const bytesOf = (value) => new TextEncoder().encode(String(value ?? '')).length;
        return {
          mappingCount: api.mappings().length,
          restored: api.restore('MASK_EMAIL_0001').text,
          storedBytes: bytesOf(sessionStorage.getItem(storageKey)),
          storageMaxBytes: api.limits().storageMaxBytes
        };
      }));
      assert.equal(second.mappingCount, first.exactCount);
      assert.equal(second.restored, 'accepted@example.com');
      assert.equal(second.storedBytes, second.storageMaxBytes);
    }
  },
  {
    name: 'Maskinger keeps in-memory mappings consistent when sessionStorage save fails',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__MaskingerTest;
        api.clear();
        const originalSetItem = Storage.prototype.setItem;
        Object.defineProperty(Storage.prototype, 'setItem', {
          configurable: true,
          value(key, value) {
            if (key === 'maskinger.activeMappings.v2') {
              throw new DOMException('Quota exceeded', 'QuotaExceededError');
            }
            return originalSetItem.call(this, key, value);
          }
        });
        try {
          const source = document.querySelector('#source-input');
          source.value = `token=${'sk-' + 'D'.repeat(24)}`;
          source.dispatchEvent(new Event('input', { bubbles: true }));
          const masked = document.querySelector('#masked-output').value;
          const mappings = api.mappings();
          return {
            masked,
            mappingCount: mappings.length,
            stored: sessionStorage.getItem('maskinger.activeMappings.v2'),
            restored: api.restore(masked).text,
            toast: document.querySelector('#toast').textContent
          };
        } finally {
          Object.defineProperty(Storage.prototype, 'setItem', {
            configurable: true,
            value: originalSetItem
          });
        }
      }));
      assert.match(result.masked, /MASK_SECRET_0001/);
      assert.equal(result.mappingCount, 1);
      assert.equal(result.stored, null);
      assert.equal(result.restored, 'token=sk-DDDDDDDDDDDDDDDDDDDDDDDD');
      assert.match(result.toast, /対応表の保存に失敗/);
    }
  },
  {
    name: 'Maskinger mapping table escapes hostile originals and confines narrow viewport overflow',
    run: async (page) => {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 320,
        height: 640,
        deviceScaleFactor: 1,
        mobile: true
      });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      try {
        const result = await evaluate(page, js(() => {
          window.__MaskingerTest.clear();
          const source = document.querySelector('#source-input');
          source.value = [
            'secret=<img src=x onerror=alert(1)',
            'card=4111 1111 1111 1111'
          ].join('\n');
          source.dispatchEvent(new Event('input', { bubbles: true }));
          const originalCells = Array.from(document.querySelectorAll('.original-cell'));
          const mappingScroll = document.querySelector('.mapping-body');
          const textareaRects = Array.from(document.querySelectorAll('textarea')).map((node) => {
            const rect = node.getBoundingClientRect();
            return { id: node.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          });
          return {
            bodyOverflow: document.body.scrollWidth - window.innerWidth,
            documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
            mappingScrollContainsOverflow: mappingScroll.scrollWidth > mappingScroll.clientWidth,
            mappingScrollWithinViewport: (() => {
              const rect = mappingScroll.getBoundingClientRect();
              return rect.left >= -1 && rect.right <= window.innerWidth + 1;
            })(),
            originalInnerHTML: originalCells.map((cell) => cell.innerHTML),
            originalText: originalCells.map((cell) => cell.textContent),
            xss: window.__maskingerXss || 0,
            textareaOffscreen: textareaRects.filter((rect) => rect.left < -1 || rect.right > window.innerWidth + 1)
          };
        }));
        assert.ok(result.bodyOverflow <= 1, `Maskinger body overflowed by ${result.bodyOverflow}px`);
        assert.ok(result.documentOverflow <= 1, `Maskinger document overflowed by ${result.documentOverflow}px`);
        assert.equal(result.mappingScrollContainsOverflow, true);
        assert.equal(result.mappingScrollWithinViewport, true);
        assert.equal(result.originalInnerHTML.some((html) => html.includes('<script') || html.includes('<img')), false);
        assert.equal(
          result.originalText.some((text) => text.includes('<img')),
          true
        );
        assert.equal(result.xss, 0);
        assert.deepEqual(result.textareaOffscreen, []);
      } finally {
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.send('Emulation.clearDeviceMetricsOverride');
      }
    }
  },
  {
    name: 'Maskinger copy fallback reports execCommand false and throw as failure',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const originalExecCommand = document.execCommand;
        const originalClipboard = navigator.clipboard;
        const originalIsSecureContext = window.isSecureContext;
        const calls = [];
        const delay = () => new Promise((resolve) => setTimeout(resolve, 30));
        const button = document.querySelector('#copy-masked-btn');
        const output = document.querySelector('#masked-output');
        output.value = 'MASK_SECRET_0001';

        const clickWithExec = async (execHandler) => {
          document.execCommand = (command) => {
            calls.push(command);
            return execHandler(command);
          };
          button.click();
          await delay();
          const snapshot = {
            label: button.textContent,
            calls: [...calls]
          };
          calls.length = 0;
          return snapshot;
        };

        try {
          try {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: null });
          } catch (_) {}
          try {
            Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
          } catch (_) {}

          const success = await clickWithExec(() => true);
          const falseFailure = await clickWithExec(() => false);
          const throwFailure = await clickWithExec(() => {
            throw new Error('copy failed');
          });

          return { success, falseFailure, throwFailure };
        } finally {
          document.execCommand = originalExecCommand;
          try {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
          } catch (_) {}
          try {
            Object.defineProperty(window, 'isSecureContext', { configurable: true, value: originalIsSecureContext });
          } catch (_) {}
        }
      }));
      assert.deepEqual(result.success.calls, ['copy']);
      assert.match(result.success.label, /コピーしました/);
      assert.deepEqual(result.falseFailure.calls, ['copy']);
      assert.match(result.falseFailure.label, /コピー失敗/);
      assert.deepEqual(result.throwFailure.calls, ['copy']);
      assert.match(result.throwFailure.label, /コピー失敗/);
    }
  }
];

const indexIntegrationTests = [
  {
    name: 'index download and setup instructions fit phone, tablet and desktop widths',
    run: async (page) => {
      try {
        for (const width of [320, 768, 1280]) {
          await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
          const result = await evaluate(page, js(() => {
            const button = document.querySelector('[data-download-source]').getBoundingClientRect();
            const steps = document.querySelector('.lp-start').getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth > window.innerWidth,
              buttonFits: button.left >= 0 && button.right <= window.innerWidth,
              stepsFit: steps.left >= 0 && steps.right <= window.innerWidth
            };
          }));
          assert.equal(result.overflow, false, `page overflows at ${width}px`);
          assert.equal(result.buttonFits, true, `download button clipped at ${width}px`);
          assert.equal(result.stepsFit, true, `setup instructions clipped at ${width}px`);
        }
      } finally {
        await page.send('Emulation.clearDeviceMetricsOverride');
      }
    }
  },
  {
    name: 'index download packages the current app and recovers from download failures',
    run: async (page) => {
      const expectedSource = await readFile(appPath, 'utf8');
      const result = await evaluate(page, js(async () => {
        const button = document.querySelector('[data-download-source]');
        const originalCreate = URL.createObjectURL;
        const originalClick = HTMLAnchorElement.prototype.click;
        let blob;
        let download;
        let connected;
        try {
          URL.createObjectURL = (value) => { blob = value; return 'blob:leafnote-test'; };
          HTMLAnchorElement.prototype.click = function() {
            download = this.download;
            connected = this.isConnected;
          };
          button.click();
          const success = {
            source: await blob.text(),
            mime: blob.type,
            download,
            connected,
            remainingLinks: document.querySelectorAll('a[download]').length,
            message: document.querySelector('[data-copy-toast]').textContent
          };
          URL.createObjectURL = () => { throw new Error('unavailable'); };
          button.click();
          return {
            success,
            enabled: !button.disabled,
            failure: document.querySelector('[data-copy-toast]').textContent,
            openHref: document.querySelector('.lp-actions a').getAttribute('href'),
            backupHelp: document.querySelector('.lp-start').textContent
          };
        } finally {
          URL.createObjectURL = originalCreate;
          HTMLAnchorElement.prototype.click = originalClick;
        }
      }));
      assert.equal(result.success.source, expectedSource);
      assert.equal(result.success.mime, 'text/html;charset=utf-8');
      assert.equal(result.success.download, 'LeafNote.html');
      assert.equal(result.success.connected, true);
      assert.equal(result.success.remainingLinks, 0);
      assert.match(result.success.message, /Download started/);
      assert.equal(result.enabled, true);
      assert.match(result.failure, /could not start/);
      assert.equal(result.openHref, './LeafNote.html');
      assert.match(result.backupHelp, /not updated automatically/);
    }
  },
  {
    name: 'index failed copy removes its temporary field and restores focus',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const button = document.querySelector('[data-copy-source]');
        const originalClipboard = navigator.clipboard;
        const originalExec = document.execCommand;
        try {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: null });
          document.execCommand = () => { throw new Error('copy unavailable'); };
          button.focus();
          button.click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            fields: document.querySelectorAll('textarea').length,
            focused: document.activeElement === button,
            enabled: !button.disabled,
            busy: button.getAttribute('aria-busy'),
            message: document.querySelector('[data-copy-toast]').textContent
          };
        } finally {
          document.execCommand = originalExec;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
        }
      }));
      assert.equal(result.fields, 0);
      assert.equal(result.focused, true);
      assert.equal(result.enabled, true);
      assert.equal(result.busy, null);
      assert.match(result.message, /failed/);
    }
  },
  {
    name: 'index copy source reports success and failure without stuck busy state',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const button = document.querySelector('[data-copy-source]');
        const toast = document.querySelector('[data-copy-toast]');
        const source = JSON.parse(document.querySelector('#leafnote-source').textContent);
        const originalExecCommand = document.execCommand;
        const originalClipboard = navigator.clipboard;
        const originalIsSecureContext = window.isSecureContext;
        const calls = [];
        const waitUntil = async (predicate) => {
          for (let i = 0; i < 40; i += 1) {
            if (predicate()) return true;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return false;
        };
        let execResult = true;
        try {
          try {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: null });
          } catch (_) {}
          try {
            Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
          } catch (_) {}
          document.execCommand = (command) => {
            calls.push(command);
            return execResult;
          };

          button.click();
          const successSettled = await waitUntil(() => !button.disabled && toast.textContent.includes('copied'));
          const afterSuccess = {
            settled: successSettled,
            text: toast.textContent,
            disabled: button.disabled,
            busy: button.getAttribute('aria-busy'),
            calls: [...calls]
          };

          calls.length = 0;
          execResult = false;
          button.click();
          const failureSettled = await waitUntil(() => !button.disabled && toast.textContent.includes('failed'));
          const afterFailure = {
            settled: failureSettled,
            text: toast.textContent,
            disabled: button.disabled,
            busy: button.getAttribute('aria-busy'),
            calls: [...calls]
          };

          return {
            indexReady: window.__LeafNoteIndexReady === true,
            sourceElementCount: document.querySelectorAll('#leafnote-source').length,
            bodyTextHasLeak: document.body.innerText.includes('const blockSelectorById')
              || document.body.innerText.includes('function parseMarkdownToBlocks'),
            sourceHasLeafNote: source.includes('<title>LeafNote</title>'),
            afterSuccess,
            afterFailure
          };
        } finally {
          document.execCommand = originalExecCommand;
          try {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
          } catch (_) {}
          try {
            Object.defineProperty(window, 'isSecureContext', { configurable: true, value: originalIsSecureContext });
          } catch (_) {}
        }
      }));
      assert.equal(result.indexReady, true);
      assert.equal(result.sourceElementCount, 1);
      assert.equal(result.bodyTextHasLeak, false);
      assert.equal(result.sourceHasLeafNote, true);
      assert.equal(result.afterSuccess.settled, true);
      assert.equal(result.afterSuccess.disabled, false);
      assert.equal(result.afterSuccess.busy, null);
      assert.deepEqual(result.afterSuccess.calls, ['copy']);
      assert.match(result.afterSuccess.text, /copied/i);
      assert.equal(result.afterFailure.settled, true);
      assert.equal(result.afterFailure.disabled, false);
      assert.equal(result.afterFailure.busy, null);
      assert.deepEqual(result.afterFailure.calls, ['copy']);
      assert.match(result.afterFailure.text, /failed/i);
    }
  }
];

const integrationTests = [
  {
    name: 'mobile sidebar hides inaccessible controls and returns to the note after navigation',
    run: async (page) => {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      let result;
      try {
        result = await evaluate(page, js(async () => {
          const api = window.__LeafNoteTest;
          const delay = () => new Promise((resolve) => setTimeout(resolve, 80));
          api.setState(api.createInitialState());
          api.renderAll();
          await delay();
          api.internals.syncSidebarViewportMode();
          const sidebar = document.querySelector('#sidebar');
          const opener = document.querySelector('#sidebar-open');
          const main = document.querySelector('.main');
          const backdrop = document.querySelector('#sidebar-backdrop');
          opener.focus();
          document.querySelector('#search-btn').focus();
          const collapsed = {
            inert: sidebar.inert,
            hidden: sidebar.getAttribute('aria-hidden'),
            hiddenControlsRejectFocus: document.activeElement === opener
          };
          opener.click();
          const expanded = {
            inert: sidebar.inert,
            mainInert: main.inert,
            backdropVisible: !backdrop.hidden,
            focus: document.activeElement.id,
            ariaExpanded: opener.getAttribute('aria-expanded')
          };
          document.querySelector('#new-page-btn').click();
          await delay();
          const afterNavigation = {
            collapsed: sidebar.classList.contains('collapsed'),
            mainInert: main.inert,
            backdropHidden: backdrop.hidden,
            editingNote: !!document.activeElement.closest('#blocks')
          };
          opener.focus(); opener.click();
          const sidebarItems = api.internals.getFocusableElements(sidebar);
          sidebarItems.at(-1).focus();
          const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
          document.activeElement.dispatchEvent(tab);
          const tabContained = tab.defaultPrevented && document.activeElement === sidebarItems[0];
          backdrop.click();
          const backdropClosed = sidebar.inert && document.activeElement === opener;
          opener.click();
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          return { collapsed, expanded, afterNavigation, tabContained, backdropClosed, escapeClosed: sidebar.inert && !main.inert };
        }));
      } finally {
        await page.send('Emulation.clearDeviceMetricsOverride');
        await evaluate(page, js(async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          window.__LeafNoteTest.internals.syncSidebarViewportMode();
        }));
      }
      assert.deepEqual(result.collapsed, { inert: true, hidden: 'true', hiddenControlsRejectFocus: true });
      assert.deepEqual(result.expanded, { inert: false, mainInert: true, backdropVisible: true, focus: 'sidebar-toggle', ariaExpanded: 'true' });
      assert.deepEqual(result.afterNavigation, { collapsed: true, mainInert: false, backdropHidden: true, editingNote: true });
      assert.equal(result.tabContained, true);
      assert.equal(result.backdropClosed, true);
      assert.equal(result.escapeClosed, true);
    }
  },
  {
    name: 'settings preserve keyboard focus and nested dialogs isolate background controls',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 80));
        api.setState(api.createInitialState());
        api.renderAll();
        const settings = document.querySelector('#settings-btn');
        settings.focus(); settings.click();
        await delay();
        const theme = document.querySelector('#theme-customizer-overlay');
        const app = document.querySelector('.app');
        const preserved = [];
        for (const selector of ['.theme-swatch:nth-child(2)', '[data-focus-key="width-wide"]', '[data-focus-key="font-rounded"]']) {
          const control = document.querySelector(selector);
          control.focus();
          const key = control.dataset.focusKey;
          control.click();
          preserved.push(document.activeElement.dataset.focusKey === key && document.activeElement.getAttribute('aria-pressed') === 'true');
        }
        const language = document.querySelector('#ui-language-select');
        language.focus(); language.value = 'ja';
        language.dispatchEvent(new Event('change', { bubbles: true }));
        const languageFocus = document.activeElement.id === 'ui-language-select';
        document.querySelector('#page-title').focus();
        const backgroundRejectsFocus = app.inert && theme.contains(document.activeElement);
        document.activeElement.blur();
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        document.body.dispatchEvent(tab);
        const tabRecovered = tab.defaultPrevented && theme.contains(document.activeElement);
        const confirmPromise = api.internals.showConfirm('Nested confirmation');
        await delay();
        const nestedIsolated = theme.inert && app.inert && document.querySelector('#dialog-overlay').contains(document.activeElement);
        document.querySelector('#dialog-box [data-cancel]').click();
        await confirmPromise;
        const restoredToTheme = !theme.inert && app.inert && theme.contains(document.activeElement);
        document.querySelector('#theme-done-btn').click();
        const restoredToSettings = !app.inert && document.activeElement === settings;
        api.internals.setUiLanguage('en');
        return { preserved, languageFocus, backgroundRejectsFocus, tabRecovered, nestedIsolated, restoredToTheme, restoredToSettings };
      }));
      assert.deepEqual(result.preserved, [true, true, true]);
      for (const [key, value] of Object.entries(result)) if (key !== 'preserved') assert.equal(value, true, key);
    }
  },
  {
    name: 'visible import and help controls work without keyboard shortcuts',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        api.setState(api.createInitialState());
        api.renderAll();
        const originalClick = HTMLInputElement.prototype.click;
        let importDone;
        let pickerOpened = false;
        try {
          HTMLInputElement.prototype.click = function () {
            if (this.type !== 'file') return originalClick.call(this);
            pickerOpened = true;
            Object.defineProperty(this, 'files', { configurable: true, value: [new File(['# Imported note\n\nPortable body'], 'notes.md', { type: 'text/markdown' })] });
            importDone = this.onchange();
          };
          const importButton = document.querySelector('#import-markdown-btn');
          importButton.click();
          await importDone;
          const current = api.getState().pages[api.getState().currentPageId];
          const help = document.querySelector('#shortcuts-btn');
          help.focus(); help.click();
          await new Promise((resolve) => setTimeout(resolve, 80));
          const helpOpened = !document.querySelector('#shortcuts-overlay').hidden;
          document.querySelector('#shortcuts-close-btn').click();
          const helpClosed = document.querySelector('#shortcuts-overlay').hidden && document.activeElement === help;
          document.querySelector('#search-btn').click();
          document.querySelector('#search-close-btn').click();
          document.querySelector('#trash-btn').click();
          document.querySelector('#trash-close-btn').click();
          return {
            pickerOpened,
            importVisible: importButton.offsetParent !== null,
            title: current.title,
            body: current.blocks[0].content,
            helpOpened,
            helpClosed,
            allClosed: document.querySelector('#search-overlay').hidden && document.querySelector('#trash-overlay').hidden && !document.querySelector('.app').inert
          };
        } finally {
          HTMLInputElement.prototype.click = originalClick;
        }
      }));
      assert.equal(result.pickerOpened, true);
      assert.equal(result.importVisible, true);
      assert.equal(result.title, 'Imported note');
      assert.equal(result.body, 'Portable body');
      assert.equal(result.helpOpened, true);
      assert.equal(result.helpClosed, true);
      assert.equal(result.allClosed, true);
    }
  },
  {
    name: 'single text field limits sync interactive DOM edits and page creation',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const textMax = api.internals.TEXT_FIELD_MAX_CHARS;
        const richMax = api.internals.RICH_HTML_FIELD_MAX_BYTES;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('text', '')];
        api.setState(s);
        api.renderAll();

        const created = api.createPage(null, {
          title: 'c'.repeat(textMax + 1),
          icon: 'i'.repeat(textMax + 1)
        });

        const title = document.querySelector('#page-title');
        title.textContent = 't'.repeat(textMax + 1);
        title.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 't' }));
        const currentPage = api.getState().pages[api.getState().currentPageId];

        const content = document.querySelector('[data-block-id]');
        content.textContent = 'r'.repeat(richMax + 1);
        content.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'r' }));
        const block = api.getState().pages[api.getState().currentPageId].blocks[0];

        return {
          textMax,
          richMax,
          createdTitleLength: created.title.length,
          createdIconLength: created.icon.length,
          titleStateLength: currentPage.title.length,
          titleDomLength: title.textContent.length,
          blockStateLength: block.content.length,
          blockDomTextLength: content.textContent.length,
          blockDomHtmlLength: content.innerHTML.length
        };
      }));
      assert.equal(result.createdTitleLength, result.textMax);
      assert.equal(result.createdIconLength, result.textMax);
      assert.equal(result.titleStateLength, result.textMax);
      assert.equal(result.titleDomLength, result.textMax);
      assert.equal(result.blockStateLength, result.richMax);
      assert.equal(result.blockDomTextLength, result.richMax);
      assert.equal(result.blockDomHtmlLength, result.richMax);
    }
  },
  {
    name: 'HTML-only paste into a block is sanitized and saved',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const page = s.pages[s.currentPageId];
        page.blocks = [api.blk('text', '')];
        api.setState(s);
        api.renderAll();
        const target = document.querySelector('[data-block-id]');
        target.focus();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const data = new DataTransfer();
        data.setData('text/html', '<img src=x onerror="window.__bad=1"><b onclick="x()">Safe</b><script>bad()</script>');
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: data });
        target.dispatchEvent(event);
        const block = api.getState().pages[api.getState().currentPageId].blocks[0];
        return {
          prevented: event.defaultPrevented,
          dom: target.innerHTML,
          saved: block.content,
          bad: window.__bad || 0
        };
      }));
      assert.equal(result.prevented, true);
      assert.equal(result.bad, 0);
      assert.equal(result.dom.includes('<img'), false);
      assert.equal(result.dom.includes('script'), false);
      assert.equal(result.dom.includes('onclick'), false);
      assert.match(result.saved, /<b>Safe<\/b>/);
    }
  },
  {
    name: 'raw text blocks converted to rich blocks render literal HTML safely',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('code', '<img src=x onerror="window.__rawConvertBug=1">\n<b>literal</b>', { language: 'html' }),
          api.blk('html', '<script>window.__rawConvertBug=2</script><b onclick="x()">literal</b>')
        ];
        api.setState(s);
        api.renderAll();
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        api.internals.convertBlockType(blocks[0], 'text');
        api.internals.convertBlockType(blocks[1], 'toggle');
        const richBlocks = Array.from(document.querySelectorAll('[data-block-id]'));
        return {
          saved: blocks.map((block) => block.content),
          rendered: richBlocks.map((node) => node.innerHTML),
          imageCount: document.querySelectorAll('[data-block-id] img').length,
          boldCount: document.querySelectorAll('[data-block-id] b').length,
          bad: window.__rawConvertBug || 0
        };
      }));
      assert.equal(result.bad, 0);
      assert.equal(result.imageCount, 0);
      assert.equal(result.boldCount, 0);
      assert.match(result.saved[0], /&lt;img/);
      assert.match(result.saved[0], /&lt;b&gt;literal&lt;\/b&gt;/);
      assert.match(result.saved[1], /&lt;script&gt;window\.__rawConvertBug=2&lt;\/script&gt;/);
      assert.equal(result.rendered.some((html) => html.includes('<img')), false);
      assert.equal(result.rendered.some((html) => html.includes('<script')), false);
    }
  },
  {
    name: 'block type conversion preserves hidden payloads, content, and children visibly',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const imageDataUrl = 'data:image/png;base64,QUJD';
        const fileDataUrl = 'data:text/plain;base64,SGk=';
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        const toggle = api.blk('toggle', 'Parent content', {
          expanded: true,
          children: [api.blk('text', 'Child content')]
        });
        const table = api.blk('table', '', {
          rows: 2,
          cols: 2,
          hasHeaderRow: true,
          hasHeaderCol: false,
          cells: [
            ['<b>H</b>', 'B'],
            ['C', 'D']
          ]
        });
        const file = api.blk('file', '', {
          fileName: 'report.txt',
          fileType: 'text/plain',
          fileSize: 2,
          fileDataUrl
        });
        const text = api.blk('text', 'Keep <b>text</b>');
        const image = api.blk('image', '', {
          url: imageDataUrl,
          caption: 'Cap <b>bold</b>'
        });
        current.blocks = [toggle, table, file, text, image];
        api.setState(s);
        api.renderAll();

        const byId = (id) => api.getState().pages[api.getState().currentPageId].blocks.find((block) => block.id === id);
        api.internals.convertBlockType(byId(toggle.id), 'image');
        api.internals.convertBlockType(byId(table.id), 'text');
        api.internals.convertBlockType(byId(file.id), 'code');
        api.internals.convertBlockType(byId(text.id), 'table');
        api.internals.convertBlockType(byId(image.id), 'text');

        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        const plainText = (html) => {
          const holder = document.createElement('div');
          holder.innerHTML = html || '';
          return holder.textContent || '';
        };
        const simplified = blocks.map((block) => ({
          id: block.id,
          type: block.type,
          contentText: plainText(block.content),
          url: block.url || '',
          fileName: block.fileName || '',
          fileDataUrl: block.fileDataUrl || '',
          childCount: Array.isArray(block.children) ? block.children.length : 0,
          hasCells: Array.isArray(block.cells)
        }));
        const normalized = api.normalizeStateShape({
          currentPageId: 'root',
          rootPages: ['root'],
          pages: {
            root: {
              id: 'root',
              title: 'Root',
              parentId: null,
              children: [],
              createdAt: 1,
              updatedAt: 1,
              blocks: [
                api.blk('text', 'hidden image url', { url: imageDataUrl, caption: 'hidden' }),
                api.blk('text', 'hidden file data', { fileName: 'hidden.txt', fileDataUrl })
              ]
            }
          }
        }).state.pages.root.blocks;
        const enforceState = {
          pages: {
            root: {
              blocks: [
                api.blk('text', 'hidden image url', { url: imageDataUrl }),
                api.blk('file', '', { fileName: 'ok.txt', fileDataUrl, fileSize: 2 })
              ]
            }
          }
        };
        const removed = api.internals._enforceLocalEmbeddedDataTotalLimit(enforceState, { maxBytes: 2 });
        return {
          simplified,
          markdown: api.blocksToMarkdown(blocks),
          normalized,
          removed,
          enforcedHiddenUrl: enforceState.pages.root.blocks[0].url,
          enforcedFileDataUrl: enforceState.pages.root.blocks[1].fileDataUrl
        };
      }));
      assert.deepEqual(result.simplified.map((block) => block.type), [
        'image',
        'text',
        'text',
        'text',
        'text',
        'code',
        'file',
        'table',
        'text',
        'text',
        'image'
      ]);
      assert.equal(result.simplified[0].childCount, 0);
      assert.equal(result.simplified[1].contentText, 'Parent content');
      assert.equal(result.simplified[2].contentText, 'Child content');
      assert.equal(result.simplified[3].contentText, '');
      assert.match(result.simplified[4].contentText, /\| \*\*H\*\* \| B \|/);
      assert.equal(result.simplified[5].contentText, '');
      assert.equal(result.simplified[6].fileName, 'report.txt');
      assert.equal(result.simplified[6].fileDataUrl, 'data:text/plain;base64,SGk=');
      assert.equal(result.simplified[7].hasCells, true);
      assert.equal(result.simplified[8].contentText, 'Keep text');
      assert.equal(result.simplified[9].url, '');
      assert.equal(result.simplified[10].url, 'data:image/png;base64,QUJD');
      assert.match(result.markdown, /Parent content/);
      assert.match(result.markdown, /Child content/);
      assert.match(result.markdown, /\\\| \\\*\\\*H\\\*\\\* \\\| B \\\|/);
      assert.match(result.markdown, /\[report\.txt\]\(data:text\/plain;base64,SGk=\)/);
      assert.match(result.markdown, /!\[Cap \*\*bold\*\*\]\(data:image\/png;base64,QUJD\)/);
      assert.equal(result.normalized[0].url, '');
      assert.equal(result.normalized[0].caption, '');
      assert.equal(result.normalized[1].fileDataUrl, '');
      assert.equal(result.normalized[1].fileName, '');
      assert.equal(result.removed, 1);
      assert.equal(result.enforcedHiddenUrl, '');
      assert.equal(result.enforcedFileDataUrl, 'data:text/plain;base64,SGk=');
    }
  },
  {
    name: 'block type conversion preserves dedicated metadata visibly and clears hidden fields',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        const decision = api.blk('decision', 'Ship <b>now</b>', {
          governanceStatus: 'accepted',
          governanceOwner: 'Team',
          governanceDate: '2026-05-22'
        });
        const db = api.blk('db_table', '', {
          tableName: 'users',
          tablePurpose: 'Stores accounts',
          columns: [{ name: 'email', type: 'text', key: 'UK', nullable: 'No', description: 'login|address' }]
        });
        current.blocks = [decision, db];
        api.setState(s);
        api.renderAll();

        const byId = (id) => api.getState().pages[api.getState().currentPageId].blocks.find((block) => block.id === id);
        api.internals.convertBlockType(byId(decision.id), 'text');
        api.internals.convertBlockType(byId(db.id), 'image');

        const plainText = (html) => {
          const holder = document.createElement('div');
          holder.innerHTML = html || '';
          return holder.textContent || '';
        };
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        const convertedDecision = byId(decision.id);
        const convertedDb = byId(db.id);
        const hiddenPayloadCount = blocks.filter((block) => (
          block.governanceStatus ||
          block.governanceOwner ||
          block.governanceDate ||
          block.tableName ||
          block.tablePurpose ||
          (Array.isArray(block.columns) && block.columns.length)
        )).length;
        return {
          types: blocks.map((block) => block.type),
          visibleTexts: blocks.map((block) => plainText(block.content)),
          convertedDecisionOwner: convertedDecision.governanceOwner || '',
          convertedDecisionStatus: convertedDecision.governanceStatus || '',
          convertedDbTableName: convertedDb.tableName || '',
          convertedDbColumns: convertedDb.columns,
          hiddenPayloadCount
        };
      }));
      assert.deepEqual(result.types, ['text', 'text', 'image', 'text']);
      assert.equal(result.visibleTexts[0], 'Ship now');
      assert.match(result.visibleTexts[1], /\[!DECISION\]/);
      assert.match(result.visibleTexts[1], /Owner: Team/);
      assert.match(result.visibleTexts[3], /\[!DB_TABLE\]/);
      assert.match(result.visibleTexts[3], /Table: users/);
      assert.match(result.visibleTexts[3], /email \| text \| UK \| No \| login\\\|address/);
      assert.equal(result.convertedDecisionOwner, '');
      assert.equal(result.convertedDecisionStatus, '');
      assert.equal(result.convertedDbTableName, '');
      assert.equal(result.convertedDbColumns, null);
      assert.equal(result.hiddenPayloadCount, 0);
    }
  },
  {
    name: 'table cells and image captions use the sanitized paste path',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const page = s.pages[s.currentPageId];
        page.blocks = [
          api.blk('table', '', { rows: 1, cols: 1, cells: [['']], hasHeaderRow: false, hasHeaderCol: false }),
          api.blk('image', '', { url: 'data:image/png;base64,iVBORw0KGgo=', caption: '' })
        ];
        api.setState(s);
        api.renderAll();
        const paste = (target, html) => {
          target.focus();
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          const data = new DataTransfer();
          data.setData('text/html', html);
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const cell = document.querySelector('.simple-table td');
        const caption = document.querySelector('.image-caption');
        const cellPrevented = paste(cell, '<span onclick="x()" style="color:red">Cell</span><iframe>bad</iframe>');
        const captionPrevented = paste(caption, '<a href="javascript:alert(1)">bad</a><a href="https://example.com">ok</a>');
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          cellPrevented,
          captionPrevented,
          cellDom: cell.innerHTML,
          captionDom: caption.innerHTML,
          cellSaved: blocks[0].cells[0][0],
          captionSaved: blocks[1].caption
        };
      }));
      assert.equal(result.cellPrevented, true);
      assert.equal(result.captionPrevented, true);
      assert.equal(result.cellDom.includes('onclick'), false);
      assert.equal(result.cellDom.includes('style='), false);
      assert.equal(result.cellDom.includes('iframe'), false);
      assert.equal(result.cellSaved.includes('onclick'), false);
      assert.equal(result.cellSaved.includes('style='), false);
      assert.equal(result.cellSaved.includes('iframe'), false);
      assert.equal(result.cellDom.replace(/<[^>]*>/g, ''), 'Cell');
      assert.equal(result.cellSaved.replace(/<[^>]*>/g, ''), 'Cell');
      assert.equal(result.captionDom.includes('javascript:'), false);
      assert.equal(result.captionSaved.includes('javascript:'), false);
      assert.match(result.captionSaved, /href="https:\/\/example\.com"/);
    }
  },
  {
    name: 'markdown paste replaces an empty block with parsed native blocks',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const page = s.pages[s.currentPageId];
        page.blocks = [api.blk('text', '')];
        api.setState(s);
        api.renderAll();
        const target = document.querySelector('[data-block-id]');
        target.focus();
        const data = new DataTransfer();
        data.setData('text/plain', [
          '# Pasted Heading',
          '',
          '- [x] Done',
          '  - Child',
          '',
          '| A | B |',
          '| --- | --- |',
          '| <script>x</script>One | Two |',
          '',
          '![Unsafe](javascript:alert(1))',
          '',
          '[bad](javascript:alert(1)) and [ok](https://example.com)'
        ].join('\n'));
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: data });
        target.dispatchEvent(event);
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          prevented: event.defaultPrevented,
          types: blocks.map((block) => block.type),
          firstContent: blocks[0].content,
          todoChecked: blocks[1].checked,
          childTypes: blocks[1].children.map((block) => block.type),
          tableCell: blocks[2].cells[0][0],
          imageUrl: blocks[3].url,
          linkContent: blocks[4].content,
          domTypes: Array.from(document.querySelectorAll('#blocks .block')).map((block) => block.dataset.type)
        };
      }));
      assert.equal(result.prevented, true);
      assert.deepEqual(result.types, ['h1', 'todo', 'table', 'image', 'text']);
      assert.match(result.firstContent, /Pasted Heading/);
      assert.equal(result.todoChecked, true);
      assert.deepEqual(result.childTypes, ['bullet']);
      assert.equal(result.tableCell.includes('script'), false);
      assert.equal(result.imageUrl, '');
      assert.equal(result.linkContent.includes('javascript:'), false);
      assert.match(result.linkContent, /href="https:\/\/example\.com"/);
      assert.ok(result.domTypes.includes('table'));
    }
  },
  {
    name: 'plain JSON and tag-like paste stay inline instead of Markdown blocks',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const page = s.pages[s.currentPageId];
        page.blocks = [api.blk('text', 'Start-')];
        api.setState(s);
        api.renderAll();
        const pasteText = (text, mime = 'text/plain') => {
          const target = document.querySelector('[data-block-id]');
          target.focus();
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          const data = new DataTransfer();
          data.setData(mime, text);
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const tagPrevented = pasteText('#tag');
        const jsonPrevented = pasteText('{"a":1}');
        const inlineBoldPrevented = pasteText('**bold**');
        const inlineLinkPrevented = pasteText('[link](https://example.com)');
        const explicitMarkdownPrevented = pasteText('**explicit**', 'text/markdown');
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          tagPrevented,
          jsonPrevented,
          inlineBoldPrevented,
          inlineLinkPrevented,
          explicitMarkdownPrevented,
          blockCount: blocks.length,
          content: blocks[0].content,
          domText: document.querySelector('[data-block-id]').textContent,
          explicitContent: blocks[1]?.content || '',
          detection: {
            json: api.internals.looksLikeMarkdown('{"a":1}'),
            tag: api.internals.looksLikeMarkdown('#tag'),
            percent: api.internals.looksLikeMarkdown('%memo'),
            heading: api.internals.looksLikeMarkdown('# Heading'),
            list: api.internals.looksLikeMarkdown('- item'),
            table: api.internals.looksLikeMarkdown('| A | B |\n| --- | --- |'),
            inlineBlock: api.internals.looksLikeMarkdownBlockPaste('**bold**'),
            inlineOnly: api.internals.looksLikeMarkdownInlineOnly('**bold**')
          }
        };
      }));
      assert.equal(result.tagPrevented, true);
      assert.equal(result.jsonPrevented, true);
      assert.equal(result.inlineBoldPrevented, true);
      assert.equal(result.inlineLinkPrevented, true);
      assert.equal(result.explicitMarkdownPrevented, true);
      assert.equal(result.blockCount, 2);
      assert.equal(result.content, 'Start-#tag{"a":1}**bold**[link](https://example.com)');
      assert.equal(result.domText, 'Start-#tag{"a":1}**bold**[link](https://example.com)');
      assert.match(result.explicitContent, /<b>explicit<\/b>/);
      assert.deepEqual(result.detection, {
        json: false,
        tag: false,
        percent: false,
        heading: true,
        list: true,
        table: true,
        inlineBlock: false,
        inlineOnly: true
      });
    }
  },
  {
    name: 'plain multiline paste splits sanitized text into sibling blocks',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const page = s.pages[s.currentPageId];
        page.blocks = [api.blk('text', 'Start-')];
        api.setState(s);
        api.renderAll();
        const target = document.querySelector('[data-block-id]');
        target.focus();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const data = new DataTransfer();
        data.setData('text/plain', 'One\u0000\nTwo\nThree');
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: data });
        target.dispatchEvent(event);
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          prevented: event.defaultPrevented,
          contents: blocks.map((block) => block.content),
          domText: Array.from(document.querySelectorAll('[data-block-id]')).map((node) => node.textContent)
        };
      }));
      assert.equal(result.prevented, true);
      assert.deepEqual(result.contents, ['Start-One', 'Two', 'Three']);
      assert.deepEqual(result.domText, ['Start-One', 'Two', 'Three']);
      assert.equal(result.contents.join('').includes('\u0000'), false);
    }
  },
  {
    name: 'clipboard paste limits warn and reject oversized generated content',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
        const reset = () => {
          const s = api.createInitialState();
          const current = s.pages[s.currentPageId];
          current.blocks = [api.blk('text', '')];
          api.setState(s);
          api.renderAll();
          const target = document.querySelector('[data-block-id]');
          target.focus();
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return target;
        };
        const paste = async (target, type, value) => {
          const data = new DataTransfer();
          data.setData(type, value);
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data });
          target.dispatchEvent(event);
          await delay();
          return event.defaultPrevented;
        };
        const dialogText = () => document.querySelector('#dialog-box')?.textContent || '';
        const closeDialog = async (selector = '[data-ok]') => {
          document.querySelector(`#dialog-box ${selector}`).click();
          await delay();
        };

        let target = reset();
        const markdown = Array.from({ length: api.internals.CLIPBOARD_PASTE_MAX_BLOCKS + 1 }, (_, i) => `# Heading ${i}`).join('\n');
        const markdownPrevented = await paste(target, 'text/plain', markdown);
        const markdownDialog = dialogText();
        await closeDialog();
        const markdownBlockCount = api.getState().pages[api.getState().currentPageId].blocks.length;

        target = reset();
        const plain = Array.from({ length: api.internals.CLIPBOARD_PASTE_MAX_BLOCKS + 1 }, (_, i) => `Line ${i}`).join('\n');
        const plainPrevented = await paste(target, 'text/plain', plain);
        const plainDialog = dialogText();
        await closeDialog();
        const plainBlockCount = api.getState().pages[api.getState().currentPageId].blocks.length;

        target = reset();
        const htmlPrevented = await paste(target, 'text/html', `<b>Huge</b>${'x'.repeat(api.internals.CLIPBOARD_PASTE_MAX_BYTES + 1)}`);
        const htmlDialog = dialogText();
        await closeDialog();
        const htmlContent = api.getState().pages[api.getState().currentPageId].blocks[0].content;

        target = reset();
        const warnPrevented = await paste(target, 'text/plain', 'w'.repeat(api.internals.CLIPBOARD_PASTE_WARN_BYTES + 1));
        const warnDialog = dialogText();
        await closeDialog('[data-cancel]');
        const warnContent = api.getState().pages[api.getState().currentPageId].blocks[0].content;

        return {
          markdownPrevented,
          markdownDialog,
          markdownBlockCount,
          plainPrevented,
          plainDialog,
          plainBlockCount,
          htmlPrevented,
          htmlDialog,
          htmlContent,
          warnPrevented,
          warnDialog,
          warnContent
        };
      }));
      assert.equal(result.markdownPrevented, true);
      assert.match(result.markdownDialog, /500/);
      assert.equal(result.markdownBlockCount, 1);
      assert.equal(result.plainPrevented, true);
      assert.match(result.plainDialog, /500/);
      assert.equal(result.plainBlockCount, 1);
      assert.equal(result.htmlPrevented, true);
      assert.match(result.htmlDialog, /1\.0 MB|1 MB|1MB/);
      assert.equal(result.htmlContent, '');
      assert.equal(result.warnPrevented, true);
      assert.match(result.warnDialog, /256 KB|256KB/);
      assert.equal(result.warnContent, '');
    }
  },
  {
    name: 'raw and code paste limits reject oversized plain text without mutating state',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const max = api.internals.RAW_TEXT_BLOCK_MAX_BYTES;
        const setSelectionEnd = (target) => {
          target.focus();
          if (typeof target.setSelectionRange === 'function') {
            target.setSelectionRange(target.value.length, target.value.length);
            return;
          }
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        };
        const pasteText = async (target, text, dialogSelector = '[data-ok]') => {
          setSelectionEnd(target);
          const data = new DataTransfer();
          data.setData('text/plain', text);
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data });
          target.dispatchEvent(event);
          await delay();
          const dialogText = document.querySelector('#dialog-box')?.textContent || '';
          const button = document.querySelector(`#dialog-box ${dialogSelector}`);
          if (button) {
            button.click();
            await delay(80);
          }
          return { prevented: event.defaultPrevented, dialogText };
        };

        let s = api.createInitialState();
        let current = s.pages[s.currentPageId];
        current.blocks = [api.blk('code', '', { language: 'plain text' })];
        api.setState(s);
        api.renderAll();
        const code = document.querySelector('.code-block-content code');
        const exactPaste = await pasteText(code, 'a'.repeat(max));
        const exactLength = api.getState().pages[api.getState().currentPageId].blocks[0].content.length;

        s = api.createInitialState();
        current = s.pages[s.currentPageId];
        current.blocks = [api.blk('html', 'Original')];
        api.setState(s);
        api.renderAll();
        const raw = document.querySelector('.raw-block-textarea');
        const overPaste = await pasteText(raw, 'b'.repeat(max + 1));
        const overBlock = api.getState().pages[api.getState().currentPageId].blocks[0];

        s = api.createInitialState();
        current = s.pages[s.currentPageId];
        current.blocks = [api.blk('mermaid', 'Original')];
        api.setState(s);
        api.renderAll();
        const rawLines = document.querySelector('.raw-block-textarea');
        const tooManyLines = Array.from({ length: api.internals.CLIPBOARD_PASTE_MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
        const linePaste = await pasteText(rawLines, tooManyLines);
        const lineBlock = api.getState().pages[api.getState().currentPageId].blocks[0];

        return {
          max,
          exactPaste,
          exactLength,
          overPaste,
          overContent: overBlock.content,
          overDom: raw.value,
          linePaste,
          lineContent: lineBlock.content,
          lineDom: rawLines.value
        };
      }));
      assert.equal(result.exactPaste.prevented, true);
      assert.match(result.exactPaste.dialogText, /256 KB|256KB/);
      assert.equal(result.exactLength, result.max);
      assert.equal(result.overPaste.prevented, true);
      assert.match(result.overPaste.dialogText, /1\.0 MB|1 MB|1MB/);
      assert.equal(result.overContent, 'Original');
      assert.equal(result.overDom, 'Original');
      assert.equal(result.linePaste.prevented, true);
      assert.match(result.linePaste.dialogText, /2000/);
      assert.equal(result.lineContent, 'Original');
      assert.equal(result.lineDom, 'Original');
    }
  },
  {
    name: 'markdown paste rejects excessive generated table cells without mutating state',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const makeTable = (rows, cols) => {
          const header = `| ${Array.from({ length: cols }, (_, i) => `c${i}`).join(' | ')} |`;
          const align = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
          const row = `| ${Array.from({ length: cols }, () => 'v').join(' | ')} |`;
          return [header, align, ...Array.from({ length: rows - 1 }, () => row)].join('\n');
        };
        const exactTable = makeTable(100, 100);
        const extraTable = makeTable(2, 2);
        const exactBlocks = api.parseMarkdownToBlocks(exactTable);
        api.internals._confirmClipboardPasteWithinLimits(
          { text: exactTable },
          {
            tableCellCount: api.internals._countTableCellsDeep(exactBlocks, api.internals.MARKDOWN_IMPORT_MAX_TABLE_CELLS),
            skipByteWarning: true
          }
        );

        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('text', '')];
        api.setState(s);
        api.renderAll();
        const target = document.querySelector('[data-block-id]');
        target.focus();
        const data = new DataTransfer();
        data.setData('text/plain', `${exactTable}\n\n${extraTable}`);
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: data });
        target.dispatchEvent(event);
        await delay();
        const dialogText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          exactCellCount: api.internals._countTableCellsDeep(exactBlocks),
          prevented: event.defaultPrevented,
          dialogText,
          blockCount: blocks.length,
          firstType: blocks[0].type,
          firstContent: blocks[0].content
        };
      }));
      assert.equal(result.exactCellCount, 10000);
      assert.equal(result.prevented, true);
      assert.match(result.dialogText, /10000|セル|cells/i);
      assert.equal(result.blockCount, 1);
      assert.equal(result.firstType, 'text');
      assert.equal(result.firstContent, '');
    }
  },
  {
    name: 'page title paste stores plain text only',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        api.setState(s);
        api.renderAll();
        const title = document.querySelector('#page-title');
        title.textContent = '';
        title.focus();
        const data = new DataTransfer();
        data.setData('text/html', '<b onclick="x()">Title</b><script>bad()</script><span> Ok</span>');
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: data });
        title.dispatchEvent(event);
        const current = api.getState().pages[api.getState().currentPageId];
        return {
          prevented: event.defaultPrevented,
          dom: title.innerHTML,
          saved: current.title
        };
      }));
      assert.equal(result.prevented, true);
      assert.equal(result.dom.includes('<'), false);
      assert.equal(result.saved, 'Title Ok');
    }
  },
  {
    name: 'keyboard editing converts headings, inserts blocks, and removes empty siblings',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('text', '')];
        api.setState(s);
        api.renderAll();
        let content = document.querySelector('[data-block-id]');
        content.textContent = '# Heading';
        content.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '# Heading' }));
        await delay();
        const afterConvert = api.getState().pages[api.getState().currentPageId].blocks.map((block) => ({ type: block.type, content: block.content }));
        content = document.querySelector('[data-block-id]');
        content.focus();
        const range = document.createRange();
        range.selectNodeContents(content);
        range.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        content.dispatchEvent(enterEvent);
        await delay();
        let blocks = api.getState().pages[api.getState().currentPageId].blocks;
        const afterEnter = blocks.map((block) => ({ type: block.type, content: block.content }));
        const second = document.querySelectorAll('[data-block-id]')[1];
        second.focus();
        const backspaceRange = document.createRange();
        backspaceRange.setStart(second, 0);
        backspaceRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(backspaceRange);
        const backspaceEvent = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
        second.dispatchEvent(backspaceEvent);
        await delay();
        blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          afterConvert,
          enterPrevented: enterEvent.defaultPrevented,
          afterEnter,
          backspacePrevented: backspaceEvent.defaultPrevented,
          finalBlocks: blocks.map((block) => ({ type: block.type, content: block.content })),
          focusedText: document.activeElement?.textContent || ''
        };
      }));
      assert.deepEqual(result.afterConvert, [{ type: 'h1', content: 'Heading' }]);
      assert.equal(result.enterPrevented, true);
      assert.deepEqual(result.afterEnter, [{ type: 'h1', content: 'Heading' }, { type: 'text', content: '' }]);
      assert.equal(result.backspacePrevented, true);
      assert.deepEqual(result.finalBlocks, [{ type: 'h1', content: 'Heading' }]);
      assert.equal(result.focusedText, 'Heading');
    }
  },
  {
    name: 'page lifecycle operations delete, restore, purge, and keep navigation valid',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const root = s.pages[s.currentPageId];
        root.title = 'Root';
        const child = api.createPage(root.id, { title: 'Child' });
        child.blocks = [api.blk('text', 'Child body')];
        api.setState(s);
        api.renderAll();
        api.switchPage(child.id);
        api.deletePage(root.id);
        const afterDelete = {
          rootDeleted: !!api.getState().pages[root.id].deletedAt,
          childDeleted: !!api.getState().pages[child.id].deletedAt,
          currentLive: !api.internals.isPageDeleted(api.getState().currentPageId),
          roots: api.getState().rootPages.slice()
        };
        api.restorePage(root.id);
        const afterRestore = {
          rootDeleted: !!api.getState().pages[root.id].deletedAt,
          childDeleted: !!api.getState().pages[child.id].deletedAt,
          rootPages: api.getState().rootPages.slice(),
          childParent: api.getState().pages[child.id].parentId
        };
        api.deletePage(child.id);
        api.purgePage(child.id);
        const afterPurge = {
          childExists: !!api.getState().pages[child.id],
          rootChildren: api.getState().pages[root.id].children.slice()
        };
        api.renderAll();
        return {
          afterDelete,
          afterRestore,
          afterPurge,
          sidebarTitles: Array.from(document.querySelectorAll('.page-item-title')).map((node) => node.textContent)
        };
      }));
      assert.equal(result.afterDelete.rootDeleted, true);
      assert.equal(result.afterDelete.childDeleted, true);
      assert.equal(result.afterDelete.currentLive, true);
      assert.equal(result.afterDelete.roots.includes(result.afterRestore.childParent), false);
      assert.equal(result.afterRestore.rootDeleted, false);
      assert.equal(result.afterRestore.childDeleted, false);
      assert.ok(result.afterRestore.rootPages.includes(result.afterRestore.childParent));
      assert.equal(result.afterPurge.childExists, false);
      assert.deepEqual(result.afterPurge.rootChildren, []);
      assert.ok(result.sidebarTitles.includes('Root'));
    }
  },
  {
    name: 'dialogs resolve alert, confirm, prompt, and save document flows',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
        const alertPromise = api.internals.showAlert('Notice <unsafe>', { title: 'Alert Title', okText: 'OK' });
        await delay();
        const alertText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]').click();
        const alertResult = await alertPromise;
        const confirmPromise = api.internals.showConfirm('Continue?', { okText: 'Yes', cancelText: 'No', danger: true });
        await delay();
        document.querySelector('#dialog-box [data-cancel]').click();
        const confirmResult = await confirmPromise;
        const promptPromise = api.internals.showPrompt('Name?', { defaultValue: 'Old', placeholder: 'New' });
        await delay();
        const input = document.querySelector('#dialog-box .dialog-input');
        input.value = 'New Name';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        const promptResult = await promptPromise;
        api.internals.setDocumentName('Existing');
        const savePromise = api.internals.showSaveDocumentDialog();
        await delay();
        const saveInput = document.querySelector('#dialog-box .dialog-input');
        saveInput.value = 'Saved Document';
        document.querySelector('#dialog-box [data-ok]').click();
        const saveResult = await savePromise;
        return {
          alertText,
          alertResult,
          confirmResult,
          promptResult,
          saveResult,
          hidden: document.querySelector('#dialog-overlay').hidden
        };
      }));
      assert.equal(result.alertText.includes('<unsafe>'), true);
      assert.equal(result.alertText.includes('&lt;unsafe&gt;'), false);
      assert.equal(result.alertResult, true);
      assert.equal(result.confirmResult, false);
      assert.equal(result.promptResult, 'New Name');
      assert.equal(result.saveResult, 'Saved Document');
      assert.equal(result.hidden, true);
    }
  },
  {
    name: 'overlapping dialogs settle the replaced resolver before showing the next dialog',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const withTimeout = (promise) => Promise.race([
          promise.then((value) => ({ settled: true, value })),
          delay(120).then(() => ({ settled: false, value: '__timeout__' }))
        ]);

        const firstConfirm = api.internals.showConfirm('First confirm');
        await delay();
        const secondConfirm = api.internals.showConfirm('Second confirm');
        const firstAfterReplace = await withTimeout(firstConfirm);
        const visibleText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]').click();
        const secondAfterOk = await withTimeout(secondConfirm);
        await delay();

        const firstPrompt = api.internals.showPrompt('First prompt');
        await delay();
        const alert = api.internals.showAlert('Replacement alert');
        const promptAfterReplace = await withTimeout(firstPrompt);
        document.querySelector('#dialog-box [data-ok]').click();
        const alertAfterOk = await withTimeout(alert);

        return {
          firstAfterReplace,
          visibleText,
          secondAfterOk,
          promptAfterReplace,
          alertAfterOk,
          hidden: document.querySelector('#dialog-overlay').hidden
        };
      }));
      assert.deepEqual(result.firstAfterReplace, { settled: true, value: null });
      assert.match(result.visibleText, /Second confirm/);
      assert.deepEqual(result.secondAfterOk, { settled: true, value: true });
      assert.deepEqual(result.promptAfterReplace, { settled: true, value: null });
      assert.deepEqual(result.alertAfterOk, { settled: true, value: true });
      assert.equal(result.hidden, true);
    }
  },
  {
    name: 'search modal finds content, opens matches, and creates missing pages',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const root = s.pages[s.currentPageId];
        root.title = 'Root';
        root.blocks = [api.blk('text', 'alpha body')];
        const child = api.createPage(null, { title: 'Needle Page' });
        child.blocks = [api.blk('text', 'needle body')];
        api.setState(s);
        api.renderAll();
        document.querySelector('#search-btn').click();
        await delay();
        const input = document.querySelector('#search-input');
        input.value = 'needle';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(api.internals.SEARCH_INPUT_DEBOUNCE_MS + 60);
        const initialItems = Array.from(document.querySelectorAll('#search-results .search-item')).map((node) => node.textContent);
        document.querySelector('#search-results .search-item').click();
        await delay();
        const openedTitle = api.getState().pages[api.getState().currentPageId].title;
        document.querySelector('#search-btn').click();
        await delay();
        const createInput = document.querySelector('#search-input');
        createInput.value = 'Brand New Note';
        createInput.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(api.internals.SEARCH_INPUT_DEBOUNCE_MS + 60);
        const createItem = Array.from(document.querySelectorAll('#search-results .search-item')).at(-1);
        createItem.click();
        await delay();
        const createdTitle = api.getState().pages[api.getState().currentPageId].title;
        return {
          initialItems,
          openedTitle,
          createdTitle,
          hidden: document.querySelector('#search-overlay').hidden,
          pageCount: Object.keys(api.getState().pages).length
        };
      }));
      assert.ok(result.initialItems.some((text) => text.includes('Needle Page')));
      assert.equal(result.openedTitle, 'Needle Page');
      assert.equal(result.createdTitle, 'Brand New Note');
      assert.equal(result.hidden, true);
      assert.equal(result.pageCount, 3);
    }
  },
  {
    name: 'trash modal retention, restore, and confirmed purge flows work through the UI',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 30));
        const s = api.createInitialState();
        const root = s.pages[s.currentPageId];
        root.title = 'Root';
        const trash = api.createPage(null, { title: 'Trash Target' });
        api.setState(s);
        api.deletePage(trash.id);
        api.internals.openTrashModal();
        await delay();
        const retention = document.querySelector('#trash-retention-select');
        retention.value = '7';
        retention.dispatchEvent(new Event('change', { bubbles: true }));
        await delay();
        const beforeRestore = document.querySelector('#trash-body').textContent;
        document.querySelector('.trash-action-btn').click();
        await delay();
        const afterRestore = {
          restored: !api.getState().pages[trash.id].deletedAt,
          retention: api.getState().trashAutoPurgeDays
        };
        api.deletePage(trash.id);
        api.internals.renderTrashModal();
        await delay();
        document.querySelector('.trash-action-btn.danger').click();
        await delay();
        const confirmVisible = !document.querySelector('#dialog-overlay').hidden;
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();
        return {
          beforeRestore,
          afterRestore,
          confirmVisible,
          existsAfterPurge: !!api.getState().pages[trash.id],
          trashHidden: document.querySelector('#trash-overlay').hidden
        };
      }));
      assert.match(result.beforeRestore, /Trash Target/);
      assert.equal(result.afterRestore.restored, true);
      assert.equal(result.afterRestore.retention, 7);
      assert.equal(result.confirmVisible, true);
      assert.equal(result.existsAfterPurge, false);
      assert.equal(result.trashHidden, false);
    }
  },
  {
    name: 'theme and shortcuts modals render controls and update theme state',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 30));
        const s = api.createInitialState();
        api.setState(s);
        api.renderAll();
        api.internals.openThemeCustomizer();
        await delay();
        const themeOverlayOpen = !document.querySelector('#theme-customizer-overlay').hidden;
        const widthButtons = Array.from(document.querySelectorAll('#theme-body .theme-radio'));
        const fullButton = widthButtons.find((button) => /full/i.test(button.textContent));
        if (fullButton) fullButton.click();
        await delay();
        const pageWidth = api.getState().themeCustom.pageWidth;
        api.internals.closeThemeCustomizer();
        api.internals.openShortcutsModal();
        await delay();
        const shortcutsOpen = !document.querySelector('#shortcuts-overlay').hidden;
        const shortcutRows = document.querySelectorAll('#shortcuts-body .shortcuts-row').length;
        api.internals.closeShortcutsModal();
        return {
          themeOverlayOpen,
          pageWidth,
          shortcutsOpen,
          shortcutRows,
          shortcutsHidden: document.querySelector('#shortcuts-overlay').hidden
        };
      }));
      assert.equal(result.themeOverlayOpen, true);
      assert.equal(result.pageWidth, 'full');
      assert.equal(result.shortcutsOpen, true);
      assert.ok(result.shortcutRows > 5);
      assert.equal(result.shortcutsHidden, true);
    }
  },
  {
    name: 'app chrome keyboard paths run through sidebar, search, shortcuts, theme, and dialogs',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const root = s.pages[s.currentPageId];
        root.title = 'Root Chrome';
        root.blocks = [api.blk('text', 'root body')];
        const child = api.createPage(root.id, { title: 'Child Chrome' });
        child.blocks = [api.blk('text', 'child body')];
        const other = api.createPage(null, { title: 'Other Chrome' });
        other.blocks = [api.blk('text', 'other body')];
        const trash = api.createPage(null, { title: 'Trash Chrome' });
        api.createPage(trash.id, { title: 'Trash Child Chrome' });
        api.setState(s);
        api.deletePage(trash.id);
        const liveOther = api.getState().pages[other.id];
        liveOther.blocks.push(
          api.blk('definition_list', '', { definitions: [{ term: 'Search Term', definition: 'Search Definition' }] }),
          api.blk('decision', 'Search decision', { governanceOwner: 'Search Owner' }),
          api.blk('db_table', '', {
            tableName: 'search_table',
            tablePurpose: 'Search purpose',
            columns: [{ name: 'search_col', type: 'text', key: 'IDX', nullable: 'Yes', description: 'Search column' }]
          })
        );
        api.renderAll();

        const saveCancelPromise = api.internals.showSaveDocumentDialog();
        await delay();
        document.querySelector('#dialog-box [data-cancel]').click();
        const saveCancelResult = await saveCancelPromise;

        const saveEnterPromise = api.internals.showSaveDocumentDialog();
        await delay();
        const saveInput = document.querySelector('#dialog-box .dialog-input');
        saveInput.value = 'Keyboard Save';
        const saveEnterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        saveInput.dispatchEvent(saveEnterEvent);
        const saveEnterResult = await saveEnterPromise;

        const promptOverlayPromise = api.internals.showPrompt('Close from overlay');
        await delay();
        const overlayMouse = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        document.querySelector('#dialog-overlay').dispatchEvent(overlayMouse);
        const promptOverlayResult = await promptOverlayPromise;

        const promptEscapePromise = api.internals.showPrompt('Close from escape');
        await delay();
        const promptInput = document.querySelector('#dialog-box .dialog-input');
        const promptEscapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        promptInput.dispatchEvent(promptEscapeEvent);
        const promptEscapeResult = await promptEscapePromise;

        let rootItem = Array.from(document.querySelectorAll('.page-item'))
          .find((item) => item.textContent.includes('Root Chrome'));
        rootItem.querySelector('.page-item-chevron').click();
        await delay();
        const expandedCount = document.querySelectorAll('.page-item').length;
        const childItem = Array.from(document.querySelectorAll('.page-item'))
          .find((item) => item.textContent.includes('Child Chrome'));
        const childEnterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        childItem.dispatchEvent(childEnterEvent);
        await delay();
        const openedByKeyboard = api.getState().pages[api.getState().currentPageId].title;
        rootItem = Array.from(document.querySelectorAll('.page-item'))
          .find((item) => item.textContent.includes('Root Chrome'));
        rootItem.click();
        await delay();
        const openedByClick = api.getState().pages[api.getState().currentPageId].title;
        rootItem = Array.from(document.querySelectorAll('.page-item'))
          .find((item) => item.textContent.includes('Root Chrome'));
        rootItem.querySelectorAll('.page-item-action')[1].click();
        await delay();
        const childCreatedBySidebar = api.getState().pages[api.getState().currentPageId].parentId === root.id;
        api.switchPage(root.id);
        await delay();

        rootItem = Array.from(document.querySelectorAll('.page-item'))
          .find((item) => item.textContent.includes('Root Chrome'));
        rootItem.querySelector('.page-item-action').click();
        await delay();
        const contextItems = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        contextItems[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        contextItems[0].click();
        await delay(80);
        const renameFocused = document.activeElement?.id === 'page-title';

        rootItem = Array.from(document.querySelectorAll('.page-item'))
          .find((item) => item.textContent.includes('Root Chrome'));
        rootItem.querySelector('.page-item-action').click();
        await delay();
        let markdownBlobType = '';
        let markdownRevoked = '';
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = (blob) => { markdownBlobType = blob.type; return 'blob:markdown'; };
        URL.revokeObjectURL = (url) => { markdownRevoked = url; };
        Array.from(document.querySelectorAll('#context-menu .ctx-item'))
          .find((item) => /Markdown/i.test(item.textContent)).click();
        await delay();
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;

        document.querySelector('#search-btn').click();
        await delay();
        let search = document.querySelector('#search-input');
        search.value = 'Other Chrome';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(api.internals.SEARCH_INPUT_DEBOUNCE_MS + 60);
        const firstSearchItem = document.querySelector('#search-results .search-item');
        firstSearchItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const searchEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        search.dispatchEvent(searchEnter);
        await delay();
        const searchOpened = api.getState().pages[api.getState().currentPageId].title;

        document.querySelector('#search-btn').click();
        await delay();
        search = document.querySelector('#search-input');
        search.value = 'Keyboard Created';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(api.internals.SEARCH_INPUT_DEBOUNCE_MS + 60);
        const createSearchItem = Array.from(document.querySelectorAll('#search-results .search-item')).at(-1);
        createSearchItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const searchDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        search.dispatchEvent(searchDown);
        const searchUp = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
        search.dispatchEvent(searchUp);
        const createEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        search.dispatchEvent(createEnter);
        await delay();
        const searchCreated = api.getState().pages[api.getState().currentPageId].title;

        document.querySelector('#search-btn').click();
        await delay();
        document.querySelector('#search-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await delay();
        const searchClosedByOverlay = document.querySelector('#search-overlay').hidden;

        const clickShortcut = async (pattern) => {
          api.internals.openShortcutsModal();
          await delay();
          const row = Array.from(document.querySelectorAll('#shortcuts-body .shortcuts-row.clickable'))
            .find((item) => pattern.test(item.textContent));
          if (!row) throw new Error(`Shortcut row not found: ${pattern}`);
          row.click();
          await delay(100);
          return row.textContent;
        };

        await clickShortcut(/Customize theme/i);
        const themeOpenedFromShortcut = !document.querySelector('#theme-customizer-overlay').hidden;
        const color = document.querySelector('#theme-body .theme-color-picker');
        color.value = '#123456';
        color.dispatchEvent(new Event('input', { bubbles: true }));
        color.dispatchEvent(new Event('change', { bubbles: true }));
        const fontButtons = Array.from(document.querySelectorAll('#theme-body .theme-radio'));
        fontButtons.at(-1).click();
        await delay();
        api.internals.closeThemeCustomizer();

        await clickShortcut(/Toggle dark mode/i);
        const darkAfterShortcut = api.getState().darkMode;
        await clickShortcut(/Open\/close sidebar/i);
        const sidebarCollapsedFromShortcut = document.querySelector('#sidebar').classList.contains('collapsed');
        document.querySelector('#sidebar-open').click();
        await delay();
        const sidebarReopened = !document.querySelector('#sidebar').classList.contains('collapsed');

        const resizer = document.querySelector('#sidebar-resizer');
        const resizeStart = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 260 });
        resizer.dispatchEvent(resizeStart);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 320 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await delay();
        const sidebarWidth = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
        const sidebarMinWidth = api.internals.applySidebarWidth(100);
        const sidebarMinCss = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim();
        api.internals.applySidebarWidth(260);

        const originalInputClick = HTMLInputElement.prototype.click;
        let inputClickCount = 0;
        HTMLInputElement.prototype.click = function () { inputClickCount++; };
        await clickShortcut(/Import Markdown file/i);
        HTMLInputElement.prototype.click = originalInputClick;

        let shortcutMarkdownBlobType = '';
        URL.createObjectURL = (blob) => { shortcutMarkdownBlobType = blob.type; return 'blob:shortcut-markdown'; };
        URL.revokeObjectURL = () => {};
        await clickShortcut(/Export current note as Markdown/i);
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;

        await clickShortcut(/^Save/i);
        const saveDialogFromShortcut = !document.querySelector('#dialog-overlay').hidden;
        document.querySelector('#dialog-box [data-cancel]').click();
        await delay();

        await clickShortcut(/Open trash/i);
        const trashOpenedFromShortcut = !document.querySelector('#trash-overlay').hidden;
        document.querySelector('#trash-empty-btn').click();
        await delay();
        const emptyConfirmOpen = !document.querySelector('#dialog-overlay').hidden;
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();
        const trashRemoved = !api.getState().pages[trash.id];
        api.internals.closeOverlay(document.querySelector('#trash-overlay'));

        await clickShortcut(/Create new note/i);
        const shortcutNewNoteTitle = api.getState().pages[api.getState().currentPageId].title;

        const docName = document.querySelector('#document-name');
        docName.textContent = 'Workspace Chrome';
        docName.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Workspace Chrome' }));
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        const pasteData = new DataTransfer();
        pasteData.setData('text/plain', ' Pasted Name ');
        Object.defineProperty(paste, 'clipboardData', { value: pasteData });
        docName.dispatchEvent(paste);
        const docEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        docName.dispatchEvent(docEnter);
        docName.textContent = '';
        docName.dispatchEvent(new Event('blur', { bubbles: true }));
        document.dispatchEvent(new Event('visibilitychange'));

        return {
          saveCancelResult,
          saveEnterResult,
          saveEnterPrevented: saveEnterEvent.defaultPrevented,
          promptOverlayResult,
          promptEscapeResult,
          promptEscapePrevented: promptEscapeEvent.defaultPrevented,
          expandedCount,
          childEnterPrevented: childEnterEvent.defaultPrevented,
          openedByKeyboard,
          openedByClick,
          childCreatedBySidebar,
          renameFocused,
          markdownBlobType,
          markdownRevoked,
          searchDownPrevented: searchDown.defaultPrevented,
          searchUpPrevented: searchUp.defaultPrevented,
          searchEnterPrevented: searchEnter.defaultPrevented,
          searchOpened,
          createEnterPrevented: createEnter.defaultPrevented,
          searchCreated,
          searchClosedByOverlay,
          themeOpenedFromShortcut,
          accent: api.getState().themeCustom.accent,
          fontFamily: api.getState().themeCustom.fontFamily,
          darkAfterShortcut,
          sidebarCollapsedFromShortcut,
          sidebarReopened,
          resizeStartPrevented: resizeStart.defaultPrevented,
          sidebarWidth,
          sidebarMinWidth,
          sidebarMinCss,
          inputClickCount,
          shortcutMarkdownBlobType,
          saveDialogFromShortcut,
          trashOpenedFromShortcut,
          emptyConfirmOpen,
          trashRemoved,
          shortcutNewNoteTitle,
          workspaceName: api.getState().workspaceName,
          docEnterPrevented: docEnter.defaultPrevented,
          docNameText: docName.textContent
        };
      }));
      assert.equal(result.saveCancelResult, null);
      assert.equal(result.saveEnterResult, 'Keyboard Save');
      assert.equal(result.saveEnterPrevented, true);
      assert.equal(result.promptOverlayResult, null);
      assert.equal(result.promptEscapeResult, null);
      assert.equal(result.promptEscapePrevented, true);
      assert.ok(result.expandedCount >= 2);
      assert.equal(result.childEnterPrevented, true);
      assert.equal(result.openedByKeyboard, 'Child Chrome');
      assert.equal(result.openedByClick, 'Root Chrome');
      assert.equal(result.childCreatedBySidebar, true);
      assert.equal(result.renameFocused, true);
      assert.equal(result.markdownBlobType, 'text/markdown;charset=utf-8');
      assert.equal(result.markdownRevoked, 'blob:markdown');
      assert.equal(result.searchDownPrevented, true);
      assert.equal(result.searchUpPrevented, true);
      assert.equal(result.searchEnterPrevented, true);
      assert.equal(result.searchOpened, 'Other Chrome');
      assert.equal(result.createEnterPrevented, true);
      assert.equal(result.searchCreated, 'Keyboard Created');
      assert.equal(result.searchClosedByOverlay, true);
      assert.equal(result.themeOpenedFromShortcut, true);
      assert.equal(result.accent, '#123456');
      assert.equal(result.fontFamily, 'code');
      assert.equal(result.darkAfterShortcut, true);
      assert.equal(result.sidebarCollapsedFromShortcut, true);
      assert.equal(result.sidebarReopened, true);
      assert.equal(result.resizeStartPrevented, true);
      assert.equal(result.sidebarWidth, '260px');
      assert.equal(result.sidebarMinWidth, 180);
      assert.equal(result.sidebarMinCss, '180px');
      assert.equal(result.inputClickCount, 1);
      assert.equal(result.shortcutMarkdownBlobType, 'text/markdown;charset=utf-8');
      assert.equal(result.saveDialogFromShortcut, true);
      assert.equal(result.trashOpenedFromShortcut, true);
      assert.equal(result.emptyConfirmOpen, true);
      assert.equal(result.trashRemoved, true);
      assert.equal(result.shortcutNewNoteTitle, '');
      assert.match(result.workspaceName, /Workspace Chrome|Pasted Name|LeafNote/);
      assert.equal(result.docEnterPrevented, true);
      assert.ok(result.docNameText.length > 0);
    }
  },
  {
    name: 'storage save and load round-trip the current state',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        s.workspaceName = 'Storage Document';
        const current = s.pages[s.currentPageId];
        current.title = 'Storage Page';
        current.blocks = [api.blk('text', 'persisted body')];
        api.setState(s);
        api.saveState();
        await api._doSave();
        api.flushPendingSaveOnLifecycle();
        const loaded = await api.loadStateAsync();
        const storageKeys = Object.keys(localStorage).filter((key) => key.includes('leafnote'));
        const localSnapshots = storageKeys.map((key) => JSON.parse(localStorage.getItem(key) || '{}'));
        return {
          loadedName: loaded.workspaceName,
          loadedTitle: loaded.pages[loaded.currentPageId].title,
          loadedBody: loaded.pages[loaded.currentPageId].blocks[0].content,
          localNames: localSnapshots.map((snapshot) => snapshot.workspaceName).filter(Boolean),
          storageKeys
        };
      }));
      assert.equal(result.loadedName, 'Storage Document');
      assert.equal(result.loadedTitle, 'Storage Page');
      assert.equal(result.loadedBody, 'persisted body');
      assert.ok(result.localNames.includes('Storage Document'));
      assert.ok(result.storageKeys.length >= 1);
    }
  },
  {
    name: 'markdown and attachment downloads create safe object URLs and revoke them',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        s.workspaceName = 'Download Document';
        const current = s.pages[s.currentPageId];
        current.title = 'Download/Page';
        current.blocks = [api.blk('h2', 'Section'), api.blk('text', '<b>Body</b>')];
        api.setState(s);
        api.renderAll();

        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        const originalClick = HTMLAnchorElement.prototype.click;
        const created = [];
        const revoked = [];
        const clicks = [];
        try {
          URL.createObjectURL = (blob) => {
            const url = `blob:test-${created.length}`;
            created.push({ url, blob });
            return url;
          };
          URL.revokeObjectURL = (url) => { revoked.push(url); };
          HTMLAnchorElement.prototype.click = function click() {
            clicks.push({ download: this.download, href: this.href });
          };
          api.internals.exportPageAsMarkdown(current.id);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const markdown = await created[0].blob.text();
          await api.internals.downloadFileBlock({
            type: 'file',
            fileName: 'unsafe/name?.txt',
            fileDataUrl: 'data:text/plain;base64,SGVsbG8=',
            fileSize: 5,
            fileType: 'text/plain'
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
          const attachmentText = await created[1].blob.text();
          return { clicks, revoked, markdown, attachmentText };
        } finally {
          URL.createObjectURL = originalCreate;
          URL.revokeObjectURL = originalRevoke;
          HTMLAnchorElement.prototype.click = originalClick;
        }
      }));
      assert.equal(result.clicks.length, 2);
      assert.equal(result.clicks[0].download, 'Download_Page.md');
      assert.equal(result.clicks[0].href, 'blob:test-0');
      assert.match(result.markdown, /^# Download\/Page/);
      assert.match(result.markdown, /## Section/);
      assert.match(result.markdown, /\*\*Body\*\*/);
      assert.equal(result.clicks[1].download, 'unsafe_name_.txt');
      assert.equal(result.attachmentText, 'Hello');
      assert.deepEqual(result.revoked, ['blob:test-0', 'blob:test-1']);
    }
  },
  {
    name: 'file and image helpers read files and replace or insert blocks',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('text', ''),
          api.blk('text', 'occupied'),
          api.blk('image', '', { url: '', caption: '' }),
          api.blk('file', '')
        ];
        api.setState(s);
        api.renderAll();
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        const imageFile = new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', { type: 'image/png' });
        const textFile = new File(['hello'], 'note.txt', { type: 'text/plain' });
        const replacedImage = await api.internals._insertImageBlockFromFile(imageFile, blocks[0]);
        const insertedFile = await api.internals._insertFileBlockFromFile(textFile, blocks[1], { position: 'after' });
        const latest = api.getState().pages[api.getState().currentPageId].blocks;
        const existingImage = latest.find((block) => block.type === 'image' && !block.url);
        const loadedImage = await api.internals.loadImageFromFile(imageFile, existingImage);
        const existingFile = latest.find((block) => block.type === 'file' && !block.fileDataUrl);
        const loadedFile = await api.internals.loadFileFromFile(textFile, existingFile);
        return {
          replacedImage,
          insertedFile,
          loadedImage,
          loadedFile,
          types: api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.type),
          imageUrls: api.getState().pages[api.getState().currentPageId].blocks.filter((block) => block.type === 'image').map((block) => block.url),
          files: api.getState().pages[api.getState().currentPageId].blocks.filter((block) => block.type === 'file').map((block) => ({
            name: block.fileName,
            type: block.fileType,
            size: block.fileSize,
            dataUrl: block.fileDataUrl
          }))
        };
      }));
      assert.equal(result.replacedImage, true);
      assert.equal(result.insertedFile, true);
      assert.equal(result.loadedImage, true);
      assert.equal(result.loadedFile, true);
      assert.deepEqual(result.types, ['image', 'text', 'file', 'image', 'file']);
      assert.ok(result.imageUrls.every((url) => /^data:image\/png;base64,/.test(url)));
      assert.deepEqual(result.files.map((file) => file.name), ['note.txt', 'note.txt']);
      assert.ok(result.files.every((file) => file.type === 'text/plain' && file.size === 5 && /^data:text\/plain;base64,/.test(file.dataUrl)));
    }
  },
  {
    name: 'rich block controls update code, todo, toggle, toc, and raw previews',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 30));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('toc', ''),
          api.blk('h2', 'Heading'),
          api.blk('todo', 'Task', { checked: false }),
          api.blk('toggle', 'Details', { expanded: false, children: [api.blk('text', 'Hidden child')] }),
          api.blk('code', 'const x = 1;', { language: 'javascript', wrap: false }),
          api.blk('html', '<script>bad()</script><b>Safe</b>')
        ];
        api.setState(s);
        api.renderAll();
        document.querySelector('.todo-checkbox').click();
        document.querySelector('.toggle-chevron').click();
        const lang = document.querySelector('.code-lang-selector');
        const langMouse = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        lang.dispatchEvent(langMouse);
        const langClick = new MouseEvent('click', { bubbles: true, cancelable: true });
        lang.dispatchEvent(langClick);
        lang.value = 'python';
        lang.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('.code-wrap-btn').click();
        await delay();
        const code = document.querySelector('.code-block-content code');
        code.textContent = 'print("x")';
        code.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'print("x")' }));
        await delay();
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          tocCount: document.querySelector('.toc-block-count').textContent,
          todoChecked: blocks[2].checked,
          toggleExpanded: blocks[3].expanded,
          toggleChildVisible: !!document.querySelector('.toggle-children [data-block-id]'),
          langMouseStopped: langMouse.cancelBubble,
          langClickStopped: langClick.cancelBubble,
          codeLanguage: blocks[4].language,
          codeWrap: blocks[4].wrap,
          codeContent: blocks[4].content,
          htmlPreview: document.querySelector('.html-preview').innerHTML
        };
      }));
      assert.equal(result.tocCount, '1');
      assert.equal(result.todoChecked, true);
      assert.equal(result.toggleExpanded, true);
      assert.equal(result.toggleChildVisible, true);
      assert.equal(result.codeLanguage, 'python');
      assert.equal(result.codeWrap, true);
      assert.equal(result.codeContent, 'print("x")');
      assert.equal(result.htmlPreview.includes('script'), false);
      assert.match(result.htmlPreview, /<b>Safe<\/b>/);
    }
  },
  {
    name: 'rare block renderers and media drop zones respond through DOM events',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        api.setState(s);
        const state = api.getState();
        const current = state.pages[state.currentPageId];
        const imageUrl = api.blk('image', '', { url: '', caption: '' });
        const imageDrop = api.blk('image', '', { url: '', caption: '' });
        const fileDrop = api.blk('file', '');
        const fileCard = api.blk('file', '', {
          fileName: 'note.txt',
          fileType: 'text/plain',
          fileSize: 2,
          fileDataUrl: 'data:text/plain;base64,SGk='
        });
        const imageCard = api.blk('image', '', {
          url: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=',
          caption: 'Old caption'
        });
        current.blocks = [
          api.blk('toc', ''),
          api.blk('h2', 'Target Heading'),
          api.blk('divider', ''),
          api.blk('code', 'copy me', { language: 'javascript', wrap: false }),
          api.blk('html', '<b>Initial</b>'),
          api.blk('math', 'x=1'),
          api.blk('mermaid', 'stateDiagram-v2\n[*] --> Ready'),
          api.blk('footnote', 'old body', { label: 'old' }),
          api.blk('link_reference', '', { label: 'oldref', refUrl: 'https://old.example', refTitle: 'Old' }),
          api.blk('definition_list', '', { definitions: [{ term: 'Old term', definition: 'Old def' }] }),
          api.blk('requirement', 'Initial requirement', { governancePriority: 'must', governanceStatus: 'draft' }),
          api.blk('open_question', 'Initial question', { governanceStatus: 'open' }),
          api.blk('api_spec', '', { specTitle: 'Old API', method: 'GET', endpoint: '/old' }),
          api.blk('screen_spec', '', { screenName: 'Old screen', route: '/old' }),
          api.blk('test_case', '', { caseId: 'TC-old', status: 'Draft', scenario: 'Old case' }),
          imageUrl,
          imageDrop,
          fileDrop,
          fileCard,
          imageCard
        ];
        api.renderAll();

        document.querySelector('.toc-link').click();
        await delay();
        const activeHeadingText = document.activeElement?.textContent || '';

        const htmlInput = Array.from(document.querySelectorAll('.raw-block-textarea'))
          .find((input) => input.getAttribute('aria-label') === 'HTML');
        htmlInput.value = '<img src=x onerror=bad()><b>Updated</b>';
        htmlInput.dispatchEvent(new Event('input', { bubbles: true }));

        const footnoteLabel = document.querySelector('.raw-block-label-input');
        footnoteLabel.value = 'new-note';
        footnoteLabel.dispatchEvent(new Event('input', { bubbles: true }));
        const footnoteBody = Array.from(document.querySelectorAll('.raw-block-textarea'))
          .find((input) => input.getAttribute('aria-label')?.includes('body') || input.getAttribute('aria-label')?.includes('Body'));
        footnoteBody.value = 'new body';
        footnoteBody.dispatchEvent(new Event('input', { bubbles: true }));

        const linkFields = Array.from(document.querySelectorAll('.raw-block-field-input'));
        linkFields[0].value = 'docs';
        linkFields[0].dispatchEvent(new Event('input', { bubbles: true }));
        linkFields[1].value = 'https://example.com/docs';
        linkFields[1].dispatchEvent(new Event('input', { bubbles: true }));
        linkFields[2].value = 'Docs';
        linkFields[2].dispatchEvent(new Event('input', { bubbles: true }));

        const term = document.querySelector('.definition-list dt');
        const def = document.querySelector('.definition-list dd');
        term.innerHTML = '<b>Term</b>';
        term.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Term' }));
        def.innerHTML = '<i>Definition</i>';
        def.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Definition' }));
        const pasteRich = (target, html) => {
          const data = new DataTransfer();
          data.setData('text/html', html);
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const termPastePrevented = pasteRich(term, '<span onclick=x>Clean term</span>');
        const defPastePrevented = pasteRich(def, '<a href="javascript:bad()">bad</a><b>Clean def</b>');

        const reqPriority = document.querySelector('[aria-label="Requirement Priority"]');
        reqPriority.value = 'should';
        reqPriority.dispatchEvent(new Event('change', { bubbles: true }));
        const questionDue = document.querySelector('[aria-label="Open Question Due"]');
        questionDue.value = '2026-07-01';
        questionDue.dispatchEvent(new Event('input', { bubbles: true }));
        const method = document.querySelector('[aria-label="API Spec Method"]');
        method.value = 'PATCH';
        method.dispatchEvent(new Event('change', { bubbles: true }));
        const endpoint = document.querySelector('[aria-label="API Spec Endpoint"]');
        endpoint.value = '/new';
        endpoint.dispatchEvent(new Event('input', { bubbles: true }));
        const screenRoute = document.querySelector('[aria-label="Screen Spec Route"]');
        screenRoute.value = '/screen';
        screenRoute.dispatchEvent(new Event('input', { bubbles: true }));
        const testStatus = document.querySelector('[aria-label="Test Case Status"]');
        testStatus.value = 'Passed';
        testStatus.dispatchEvent(new Event('change', { bubbles: true }));

        let copiedText = '';
        const originalClipboard = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (text) => { copiedText = text; } }
        });
        document.querySelector('.code-copy-btn').click();
        await delay();
        const codeCopiedLabel = document.querySelector('.code-copy-btn').textContent;
        const codeInner = document.querySelector('.code-block-content code');
        codeInner.focus();
        const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        codeInner.dispatchEvent(tabEvent);

        let inputClickCount = 0;
        const originalInputClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () { inputClickCount++; };
        document.querySelectorAll('.image-empty .image-action-btn[data-act="file"]')[0].click();
        await delay();
        document.querySelector('.file-empty').click();
        const fileKey = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        document.querySelector('.file-empty').dispatchEvent(fileKey);
        document.querySelector('.image-replace-btn').click();
        await delay();
        document.querySelector('#context-menu .ctx-item').click();
        await delay();
        document.querySelectorAll('.file-card .file-action-btn')[1].click();
        await delay();
        HTMLInputElement.prototype.click = originalInputClick;

        document.querySelectorAll('.image-empty .image-action-btn[data-act="url"]')[0].click();
        await delay();
        document.querySelector('#dialog-box .dialog-input').value = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();

        const dragFile = (target, file) => {
          const dt = new DataTransfer();
          dt.items.add(file);
          const over = new Event('dragover', { bubbles: true, cancelable: true });
          Object.defineProperty(over, 'dataTransfer', { value: dt });
          target.dispatchEvent(over);
          const active = target.classList.contains('drag-active');
          const leave = new Event('dragleave', { bubbles: true, cancelable: true });
          Object.defineProperty(leave, 'dataTransfer', { value: dt });
          target.dispatchEvent(leave);
          const drop = new Event('drop', { bubbles: true, cancelable: true });
          Object.defineProperty(drop, 'dataTransfer', { value: dt });
          target.dispatchEvent(drop);
          return { active, overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented };
        };
        const imageDropNode = document.querySelectorAll('.image-empty')[0];
        const imageDropResult = dragFile(imageDropNode, new File(['gif'], 'tiny.gif', { type: 'image/gif' }));
        await delay(120);
        const fileDropNode = document.querySelector('.file-empty');
        const fileDropResult = dragFile(fileDropNode, new File(['hello'], 'hello.txt', { type: 'text/plain' }));
        await delay(120);

        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        let createdBlobType = '';
        let revokedUrl = '';
        URL.createObjectURL = (blob) => { createdBlobType = blob.type; return 'blob:test-download'; };
        URL.revokeObjectURL = (url) => { revokedUrl = url; };
        document.querySelector('.file-card .file-action-btn').click();
        await delay();
        URL.createObjectURL = originalCreate;
        URL.revokeObjectURL = originalRevoke;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });

        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          activeHeadingText,
          htmlSaved: blocks[4].content,
          htmlPreview: document.querySelector('.html-preview').innerHTML,
          footnote: { label: blocks[7].label, content: blocks[7].content },
          linkRef: { label: blocks[8].label, url: blocks[8].refUrl, title: blocks[8].refTitle },
          definition: blocks[9].definitions[0],
          termPastePrevented,
          defPastePrevented,
          requirementPriority: blocks[10].governancePriority,
          questionDue: blocks[11].governanceDue,
          apiMethod: blocks[12].method,
          apiEndpoint: blocks[12].endpoint,
          screenRoute: blocks[13].route,
          testStatus: blocks[14].status,
          copiedText,
          codeCopiedLabel,
          tabPrevented: tabEvent.defaultPrevented,
          inputClickCount,
          imageUrl: blocks[15].url,
          imageDropUrl: blocks[16].url,
          fileDropName: blocks[17].fileName,
          imageDropResult,
          fileDropResult,
          fileKeyPrevented: fileKey.defaultPrevented,
          createdBlobType,
          revokedUrl
        };
      }));
      assert.match(result.activeHeadingText, /Target Heading/);
      assert.equal(result.htmlSaved.includes('onerror'), true);
      assert.equal(result.htmlPreview.includes('onerror'), false);
      assert.match(result.htmlPreview, /<b>Updated<\/b>/);
      assert.deepEqual(result.footnote, { label: 'new-note', content: 'new body' });
      assert.deepEqual(result.linkRef, { label: 'docs', url: 'https://example.com/docs', title: 'Docs' });
      assert.match(result.definition.term, /<b>Term<\/b>/);
      assert.match(result.definition.definition, /Definition|Clean def/);
      assert.equal(result.termPastePrevented, true);
      assert.equal(result.defPastePrevented, true);
      assert.equal(result.requirementPriority, 'should');
      assert.equal(result.questionDue, '2026-07-01');
      assert.equal(result.apiMethod, 'PATCH');
      assert.equal(result.apiEndpoint, '/new');
      assert.equal(result.screenRoute, '/screen');
      assert.equal(result.testStatus, 'Passed');
      assert.equal(result.copiedText, 'copy me');
      assert.match(result.codeCopiedLabel, /Copied|コピー/);
      assert.equal(result.tabPrevented, true);
      assert.ok(result.inputClickCount >= 4);
      assert.match(result.imageUrl, /^data:image\/gif;base64,/);
      assert.match(result.imageDropUrl, /^data:image\/gif;base64,/);
      assert.equal(result.fileDropName, 'hello.txt');
      assert.equal(result.imageDropResult.active, true);
      assert.equal(result.imageDropResult.overPrevented, true);
      assert.equal(result.imageDropResult.dropPrevented, true);
      assert.equal(result.fileDropResult.active, true);
      assert.equal(result.fileDropResult.overPrevented, true);
      assert.equal(result.fileDropResult.dropPrevented, true);
      assert.equal(result.fileKeyPrevented, true);
      assert.equal(result.createdBlobType, 'text/plain');
      assert.equal(result.revokedUrl, 'blob:test-download');
    }
  },
  {
    name: 'slash menu, block context menu, and icon picker drive real UI actions',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 40));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.title = 'Menu Page';
        current.blocks = [api.blk('text', '')];
        api.setState(s);
        api.renderAll();
        let content = document.querySelector('[data-block-id]');
        content.textContent = '/table';
        content.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/table' }));
        await delay();
        const menuOpened = !document.querySelector('#context-menu').hidden;
        const tableItem = Array.from(document.querySelectorAll('#context-menu .ctx-item'))
          .find((item) => (item.getAttribute('aria-label') || '').toLowerCase() === 'table'
            || (item.textContent.includes('Table') && !item.textContent.toLowerCase().includes('contents')));
        if (!tableItem) throw new Error('Table menu item not found');
        tableItem.click();
        await delay();
        const afterSlash = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.type);
        document.querySelector('.block-drag').click();
        await delay();
        const contextItems = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        contextItems[0].click();
        await delay();
        const afterDuplicate = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.type);
        document.querySelector('#note-icon').click();
        await delay();
        document.querySelectorAll('#icon-picker .icon-picker-tab')[1].click();
        await delay();
        const search = document.querySelector('#icon-picker .icon-picker-search');
        search.value = 'home';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await delay();
        const iconButton = Array.from(document.querySelectorAll('#icon-picker .icon-picker-item')).find((button) => button.title === 'home');
        iconButton.click();
        await delay();
        const currentPage = api.getState().pages[api.getState().currentPageId];
        return {
          menuOpened,
          afterSlash,
          afterDuplicate,
          icon: currentPage.icon,
          iconType: currentPage.iconType,
          iconPickerHidden: document.querySelector('#icon-picker').hidden,
          sidebarIconText: document.querySelector('.page-item-icon').textContent
        };
      }));
      assert.equal(result.menuOpened, true);
      assert.deepEqual(result.afterSlash, ['table']);
      assert.deepEqual(result.afterDuplicate, ['table', 'table']);
      assert.equal(result.icon, 'home');
      assert.equal(result.iconType, 'material');
      assert.equal(result.iconPickerHidden, true);
      assert.match(result.sidebarIconText, /home/);
    }
  },
  {
    name: 'block drag, slash keyboard, inline toolbar, and icon picker edge controls work',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.title = 'Block Events';
        current.icon = '📄';
        current.iconType = 'emoji';
        current.hasIcon = true;
        current.blocks = [
          api.blk('text', 'Alpha text'),
          api.blk('toggle', 'Parent toggle', { children: [api.blk('text', 'Nested child')] }),
          api.blk('toggle', 'Empty toggle', { expanded: true, children: [] }),
          api.blk('callout', 'Callout body', { hasIcon: true, emoji: '💡', emojiType: 'emoji' }),
          api.blk('image', '', { url: '', caption: '' }),
          api.blk('image', '', { url: '', caption: '' }),
          api.blk('text', '')
        ];
        api.setState(s);
        api.renderAll();

        const title = document.querySelector('#page-title');
        title.focus();
        const titleKey = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        title.dispatchEvent(titleKey);
        await delay();
        const titleMovedFocus = document.activeElement?.dataset?.blockId === current.blocks[0].id;

        const firstContent = document.querySelector('[data-block-id]');
        firstContent.focus();
        const range = document.createRange();
        range.selectNodeContents(firstContent);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        await delay(80);
        const toolbarVisible = !document.querySelector('#inline-toolbar').hidden;
        const toolbarOrder = Array.from(document.querySelectorAll('#inline-toolbar .inline-btn'))
          .map((button) => button.dataset.cmd || (button.matches('[data-color-toggle]') ? 'color' : ''));
        const toolbarTooltips = Array.from(document.querySelectorAll('#inline-toolbar .inline-btn'))
          .map((button) => button.getAttribute('data-tooltip') || '');
        const bold = document.querySelector('#inline-toolbar [data-cmd="bold"]');
        const toolbarMouse = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        bold.dispatchEvent(toolbarMouse);
        bold.click();
        await delay();
        let openedLink = null;
        const originalOpen = window.open;
        try {
          window.open = (href, target, features) => {
            openedLink = { href, target, features };
            return null;
          };
          firstContent.innerHTML = '<a href="https://example.com/path">Alpha link</a>';
          const linkClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
          firstContent.querySelector('a').dispatchEvent(linkClick);
          openedLink = openedLink ? { ...openedLink, defaultPrevented: linkClick.defaultPrevented } : null;
        } finally {
          window.open = originalOpen;
        }

        const createdInputs = [];
        const originalCreateElement = document.createElement.bind(document);
        document.createElement = function (name, ...args) {
          const el = originalCreateElement(name, ...args);
          if (String(name).toLowerCase() === 'input') createdInputs.push(el);
          return el;
        };
        const imageEmptyClick = document.querySelectorAll('.image-empty')[0];
        const tinyGifBytes = Uint8Array.from(atob('R0lGODlhAQABAAAAACwAAAAAAQABAAA='), (ch) => ch.charCodeAt(0));
        imageEmptyClick.click();
        const clickImageInput = createdInputs.at(-1);
        Object.defineProperty(clickImageInput, 'files', { configurable: true, value: [new File([tinyGifBytes], 'clicked.gif', { type: 'image/gif' })] });
        clickImageInput.onchange();
        await delay(120);
        const imageEmpty = document.querySelector('.image-empty');
        const imageEmptyKey = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        imageEmpty.dispatchEvent(imageEmptyKey);
        const imageInput = createdInputs.at(-1);
        Object.defineProperty(imageInput, 'files', { configurable: true, value: [new File([tinyGifBytes], 'picked.gif', { type: 'image/gif' })] });
        imageInput.onchange();
        await delay(120);
        document.createElement = originalCreateElement;
        const clickedImageUrl = api.getState().pages[api.getState().currentPageId].blocks
          .filter((block) => block.type === 'image')[0]?.url || '';

        const emptyHintBefore = document.querySelectorAll('.toggle-empty-hint').length;
        document.querySelector('.toggle-empty-hint').click();
        await delay(120);
        const emptyHintAddedChild = api.getState().pages[api.getState().currentPageId].blocks
          .find((block) => block.content === 'Empty toggle')?.children.length || 0;
        const parentToggleBlock = api.getState().pages[api.getState().currentPageId].blocks
          .find((block) => block.content === 'Parent toggle');
        parentToggleBlock.expanded = false;
        api.renderAll();
        api.internals.focusHeadingFromTOC(parentToggleBlock.children[0].id);
        await delay(120);
        const nestedPathExpanded = parentToggleBlock.expanded;
        const toggleContent = document.querySelector(`.block[data-id="${parentToggleBlock.id}"] .toggle-header .block-content`);
        toggleContent.textContent = 'Parent edited';
        toggleContent.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Parent edited' }));
        const toggleKey = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        toggleContent.dispatchEvent(toggleKey);
        const togglePasteData = new DataTransfer();
        togglePasteData.setData('text/plain', 'Toggle paste');
        const togglePaste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(togglePaste, 'clipboardData', { value: togglePasteData });
        toggleContent.dispatchEvent(togglePaste);
        const toggleEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        toggleContent.dispatchEvent(toggleEnter);
        await delay();

        const calloutEmoji = document.querySelector('.callout-emoji');
        calloutEmoji.click();
        await delay();
        document.querySelectorAll('#icon-picker .icon-picker-tab')[1].click();
        await delay();
        document.querySelector('#icon-picker .icon-picker-random').click();
        await delay();
        const calloutAfterMaterialRandom = api.getState().pages[api.getState().currentPageId].blocks
          .find((block) => block.type === 'callout');
        document.querySelector('.callout-emoji').click();
        await delay();
        Array.from(document.querySelectorAll('#icon-picker .icon-picker-random'))
          .find((button) => /Remove|削除/.test(button.textContent)).click();
        await delay();
        const calloutIconRemoved = api.getState().pages[api.getState().currentPageId].blocks
          .find((block) => block.type === 'callout')?.hasIcon === false;

        const emptyEditable = Array.from(document.querySelectorAll('[data-block-id]'))
          .find((node) => !node.textContent.trim());
        emptyEditable.focus();
        emptyEditable.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await delay();
        const emptyEditableFocused = document.activeElement === emptyEditable;

        document.querySelector('.block-gutter-btn:not(.block-drag)').click();
        await delay();
        Array.from(document.querySelectorAll('#context-menu .ctx-item'))
          .find((item) => (item.getAttribute('aria-label') || '').toLowerCase() === 'text').click();
        await delay(120);
        const addButtonInserted = api.getState().pages[api.getState().currentPageId].blocks.length;

        document.querySelector('#note-icon').click();
        await delay();
        document.querySelector('#icon-picker .icon-picker-tab').click();
        await delay();
        document.querySelector('#icon-picker .icon-picker-random').click();
        await delay();
        const randomizedIcon = api.getState().pages[api.getState().currentPageId].icon;
        document.querySelector('#note-icon').click();
        await delay();
        Array.from(document.querySelectorAll('#icon-picker .icon-picker-random'))
          .find((button) => /Remove|削除/.test(button.textContent)).click();
        await delay();
        const removedIcon = api.getState().pages[api.getState().currentPageId].hasIcon === false;
        document.querySelector('#add-icon-btn').click();
        await delay();
        const firstEmoji = document.querySelector('#icon-picker .icon-picker-item.emoji');
        firstEmoji.click();
        await delay();
        const pickedEmoji = api.getState().pages[api.getState().currentPageId].icon;

        document.querySelector('#sidebar-toggle').click();
        await delay();
        const sidebarCollapsed = document.querySelector('#sidebar').classList.contains('collapsed');
        document.querySelector('#sidebar-open').click();
        await delay();
        const pagesBeforePrivateAdd = Object.keys(api.getState().pages).length;
        document.querySelector('#private-add-btn').click();
        await delay();
        const privateAddCreated = Object.keys(api.getState().pages).length === pagesBeforePrivateAdd + 1;

        api.switchPage(current.id);
        await delay();
        let blocks = Array.from(document.querySelectorAll('#blocks > .block'));
        const toggleBlock = blocks.find((block) => block.dataset.type === 'toggle');
        toggleBlock.querySelector('.block-drag').click();
        await delay();
        Array.from(document.querySelectorAll('#context-menu .ctx-item'))[0].click();
        await delay(100);
        const duplicatedToggle = api.getState().pages[current.id].blocks
          .filter((block) => block.type === 'toggle').length;

        blocks = Array.from(document.querySelectorAll('#blocks > .block'));
        blocks[0].querySelector('.block-drag').click();
        await delay();
        const quoteItem = Array.from(document.querySelectorAll('#context-menu .ctx-item'))
          .find((item) => (item.getAttribute('aria-label') || '').toLowerCase() === 'quote');
        quoteItem.click();
        await delay(100);
        const convertedType = api.getState().pages[current.id].blocks[0].type;

        blocks = Array.from(document.querySelectorAll('#blocks > .block'));
        blocks.find((block) => block.dataset.type === 'image').querySelector('.block-drag').click();
        await delay();
        Array.from(document.querySelectorAll('#context-menu .ctx-item'))
          .find((item) => item.classList.contains('danger')).click();
        await delay(100);
        const afterContextDeleteCount = api.getState().pages[current.id].blocks.length;

        const slashBlock = api.getState().pages[current.id].blocks.find((block) => block.type === 'text');
        const slashContent = document.querySelector(`[data-block-id="${slashBlock.id}"]`);
        slashContent.focus();
        slashContent.textContent = '/t';
        slashContent.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/t' }));
        await delay();
        const slashEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        slashContent.dispatchEvent(slashEscape);
        await delay();
        slashContent.textContent = '/quote';
        slashContent.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/quote' }));
        await delay();
        const slashDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        slashContent.dispatchEvent(slashDown);
        const slashUp = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
        slashContent.dispatchEvent(slashUp);
        const slashEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        slashContent.dispatchEvent(slashEnter);
        await delay(120);
        const slashConvertedType = api.getState().pages[current.id].blocks.find((block) => block.id === slashBlock.id)?.type;

        const s2 = api.createInitialState();
        const page2 = s2.pages[s2.currentPageId];
        page2.title = 'Drag Page';
        page2.blocks = [api.blk('text', 'One'), api.blk('text', 'Two'), api.blk('text', 'Three')];
        api.setState(s2);
        api.renderAll();
        blocks = Array.from(document.querySelectorAll('#blocks > .block'));
        const dragData = new DataTransfer();
        const dragStart = new Event('dragstart', { bubbles: true, cancelable: true });
        Object.defineProperty(dragStart, 'dataTransfer', { value: dragData });
        blocks[0].querySelector('.block-drag').dispatchEvent(dragStart);
        const targetRect = blocks[2].getBoundingClientRect();
        const dragOver = new Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(dragOver, 'dataTransfer', { value: dragData });
        Object.defineProperty(dragOver, 'clientY', { value: targetRect.bottom + 1 });
        blocks[2].dispatchEvent(dragOver);
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: dragData });
        Object.defineProperty(drop, 'clientY', { value: targetRect.bottom + 1 });
        blocks[2].dispatchEvent(drop);
        const dragEnd = new Event('dragend', { bubbles: true, cancelable: true });
        blocks[0].querySelector('.block-drag').dispatchEvent(dragEnd);
        await delay(120);
        const reordered = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.content);

        blocks = Array.from(document.querySelectorAll('#blocks > .block'));
        api.internals.BlockSelection.selectBlock(api.getState().pages[api.getState().currentPageId].blocks[0].id);
        api.internals.BlockSelection.unselectBlock(api.getState().pages[api.getState().currentPageId].blocks[0].id);
        const railContentRect = blocks[0].querySelector('[data-block-id]').getBoundingClientRect();
        const railDown = new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: railContentRect.left - 8,
          clientY: railContentRect.top + 4
        });
        blocks[0].dispatchEvent(railDown);
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const editor = document.querySelector('#editor-scroll');
        const firstRect = blocks[0].getBoundingClientRect();
        const lastRect = blocks.at(-1).getBoundingClientRect();
        const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: firstRect.top + 2 });
        editor.dispatchEvent(mouseDown);
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: window.innerWidth - 20, clientY: lastRect.bottom + 2 }));
        await delay(80);
        const selectedDuringDrag = api.internals.BlockSelection.getSelectedIds().length;
        window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: window.innerWidth - 20, clientY: window.innerHeight - 1 }));
        await delay(80);
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await delay();
        const selectedAfterClear = api.internals.BlockSelection.getSelectedIds().length;

        return {
          titlePrevented: titleKey.defaultPrevented,
          titleMovedFocus,
          toolbarVisible,
          toolbarOrder,
          toolbarTooltips,
          toolbarMousePrevented: toolbarMouse.defaultPrevented,
          openedLink,
          firstContentHtml: api.getState().pages[api.getState().currentPageId].blocks[0]?.content || '',
          imageEmptyKeyPrevented: imageEmptyKey.defaultPrevented,
          clickedImageUrl,
          emptyHintBefore,
          emptyHintAddedChild,
          nestedPathExpanded,
          toggleKeyPrevented: toggleKey.defaultPrevented,
          togglePastePrevented: togglePaste.defaultPrevented,
          toggleEnterPrevented: toggleEnter.defaultPrevented,
          calloutMaterialIcon: calloutAfterMaterialRandom?.emojiType,
          calloutIconRemoved,
          emptyEditableFocused,
          addButtonInserted,
          randomizedIcon: Boolean(randomizedIcon),
          removedIcon,
          pickedEmoji,
          sidebarCollapsed,
          privateAddCreated,
          duplicatedToggle,
          convertedType,
          afterContextDeleteCount,
          slashDownPrevented: slashDown.defaultPrevented,
          slashUpPrevented: slashUp.defaultPrevented,
          slashEnterPrevented: slashEnter.defaultPrevented,
          slashEscapePrevented: slashEscape.defaultPrevented,
          slashConvertedType,
          dragOverPrevented: dragOver.defaultPrevented,
          dropPrevented: drop.defaultPrevented,
          reordered,
          railDownPrevented: railDown.defaultPrevented,
          mouseDownPrevented: mouseDown.defaultPrevented,
          selectedDuringDrag,
          selectedAfterClear
        };
      }));
      assert.equal(result.titlePrevented, true);
      assert.equal(result.titleMovedFocus, true);
      assert.equal(result.toolbarVisible, true);
      assert.deepEqual(result.toolbarOrder, ['bold', 'italic', 'underline', 'strikeThrough', 'code', 'color', 'createLink']);
      assert.equal(result.toolbarTooltips.length, 7);
      assert.equal(result.toolbarTooltips.every(Boolean), true);
      assert.equal(result.toolbarMousePrevented, true);
      assert.deepEqual(result.openedLink, {
        href: 'https://example.com/path',
        target: '_blank',
        features: 'noopener,noreferrer',
        defaultPrevented: true
      });
      assert.equal(result.imageEmptyKeyPrevented, true);
      assert.match(result.clickedImageUrl, /^data:image\/gif;base64,/);
      assert.equal(result.emptyHintBefore, 1);
      assert.equal(result.emptyHintAddedChild, 1);
      assert.equal(result.nestedPathExpanded, true);
      assert.equal(result.togglePastePrevented, true);
      assert.equal(result.toggleEnterPrevented, true);
      assert.equal(result.calloutMaterialIcon, 'material');
      assert.equal(result.calloutIconRemoved, true);
      assert.equal(result.emptyEditableFocused, true);
      assert.ok(result.addButtonInserted >= 8);
      assert.equal(result.randomizedIcon, true);
      assert.equal(result.removedIcon, true);
      assert.ok(result.pickedEmoji.length > 0);
      assert.equal(result.sidebarCollapsed, true);
      assert.equal(result.privateAddCreated, true);
      assert.ok(result.duplicatedToggle >= 2);
      assert.equal(result.convertedType, 'quote');
      assert.ok(result.afterContextDeleteCount >= 3);
      assert.equal(result.slashDownPrevented, true);
      assert.equal(result.slashUpPrevented, true);
      assert.equal(result.slashEnterPrevented, true);
      assert.equal(result.slashEscapePrevented, true);
      assert.equal(result.slashConvertedType, 'quote');
      assert.equal(result.dragOverPrevented, true);
      assert.equal(result.dropPrevented, true);
      assert.deepEqual(result.reordered, ['Two', 'Three', 'One']);
      assert.equal(result.railDownPrevented, true);
      assert.equal(result.mouseDownPrevented, true);
      assert.ok(result.selectedDuringDrag >= 2);
      assert.equal(result.selectedAfterClear, 0);
    }
  },
  {
    name: 'max-depth toggles do not create hidden child blocks',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const makeToggleChain = (depth) => {
          const root = api.blk('toggle', 'level 0', { expanded: true, children: [] });
          let current = root;
          for (let i = 1; i <= depth; i++) {
            const child = api.blk('toggle', `level ${i}`, { expanded: true, children: [] });
            current.children = [child];
            current = child;
          }
          return { root, leaf: current };
        };

        const maxChain = makeToggleChain(api.internals.BLOCK_MAX_DEPTH);
        const s = api.createInitialState();
        s.pages[s.currentPageId].blocks = [maxChain.root];
        api.setState(s);
        api.renderAll();
        const maxHintCount = document.querySelectorAll('.toggle-empty-hint').length;
        const maxContent = document.querySelector(`[data-block-id="${maxChain.leaf.id}"]`);
        maxContent.focus();
        const enterAtMax = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        maxContent.dispatchEvent(enterAtMax);
        await delay();
        const findParent = (root, childId) => {
          const stack = [root];
          while (stack.length) {
            const block = stack.pop();
            if (!block || !Array.isArray(block.children)) continue;
            if (block.children.some((child) => child.id === childId)) return block;
            block.children.forEach((child) => stack.push(child));
          }
          return null;
        };
        const parentOfMax = findParent(api.getState().pages[api.getState().currentPageId].blocks[0], maxChain.leaf.id);
        const maxLeafAfterEnter = parentOfMax.children.find((block) => block.id === maxChain.leaf.id);
        const maxSiblingCount = parentOfMax.children.length;

        const belowChain = makeToggleChain(api.internals.BLOCK_MAX_DEPTH - 1);
        const s2 = api.createInitialState();
        s2.pages[s2.currentPageId].blocks = [belowChain.root];
        api.setState(s2);
        api.renderAll();
        const belowHintCount = document.querySelectorAll('.toggle-empty-hint').length;
        document.querySelector('.toggle-empty-hint').click();
        await delay();
        return {
          maxHintCount,
          enterAtMaxPrevented: enterAtMax.defaultPrevented,
          maxLeafChildCount: maxLeafAfterEnter.children.length,
          maxSiblingCount,
          belowHintCount,
          belowLeafChildCount: belowChain.leaf.children.length
        };
      }));
      assert.equal(result.maxHintCount, 0);
      assert.equal(result.enterAtMaxPrevented, true);
      assert.equal(result.maxLeafChildCount, 0);
      assert.equal(result.maxSiblingCount, 2);
      assert.equal(result.belowHintCount, 1);
      assert.equal(result.belowLeafChildCount, 1);
    }
  },
  {
    name: 'table controls and keyboard navigation resize table blocks',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 30));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('table', '', {
          rows: 1,
          cols: 1,
          cells: [['A']],
          hasHeaderRow: false,
          hasHeaderCol: false
        })];
        api.setState(s);
        api.renderAll();
        let buttons = Array.from(document.querySelectorAll('.table-ctl-btn'));
        buttons[0].click();
        await delay();
        buttons = Array.from(document.querySelectorAll('.table-ctl-btn'));
        buttons[1].click();
        await delay();
        buttons = Array.from(document.querySelectorAll('.table-ctl-btn'));
        buttons[4].click();
        await delay();
        buttons = Array.from(document.querySelectorAll('.table-ctl-btn'));
        buttons[5].click();
        await delay();
        let tableBlock = api.getState().pages[api.getState().currentPageId].blocks[0];
        const afterAdds = {
          rows: tableBlock.rows,
          cols: tableBlock.cols,
          hasHeaderRow: tableBlock.hasHeaderRow,
          hasHeaderCol: tableBlock.hasHeaderCol,
          cellCount: document.querySelectorAll('.simple-table th, .simple-table td').length
        };
        const lastCell = Array.from(document.querySelectorAll('.simple-table th, .simple-table td')).at(-1);
        lastCell.focus();
        lastCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        await delay();
        tableBlock = api.getState().pages[api.getState().currentPageId].blocks[0];
        const afterTab = { rows: tableBlock.rows, cols: tableBlock.cols };
        buttons = Array.from(document.querySelectorAll('.table-ctl-btn'));
        buttons[2].click();
        await delay();
        buttons = Array.from(document.querySelectorAll('.table-ctl-btn'));
        buttons[3].click();
        await delay();
        tableBlock = api.getState().pages[api.getState().currentPageId].blocks[0];
        return {
          afterAdds,
          afterTab,
          afterRemoves: {
            rows: tableBlock.rows,
            cols: tableBlock.cols,
            cells: tableBlock.cells
          }
        };
      }));
      assert.deepEqual(result.afterAdds, {
        rows: 2,
        cols: 2,
        hasHeaderRow: true,
        hasHeaderCol: true,
        cellCount: 4
      });
      assert.deepEqual(result.afterTab, { rows: 3, cols: 2 });
      assert.equal(result.afterRemoves.rows, 2);
      assert.equal(result.afterRemoves.cols, 1);
      assert.equal(result.afterRemoves.cells.length, 2);
      assert.ok(result.afterRemoves.cells.every((row) => row.length === 1));
    }
  },
  {
    name: 'page context menu creates children, duplicates trees, and confirms trash moves',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 40));
        const s = api.createInitialState();
        const root = s.pages[s.currentPageId];
        root.title = 'Root Menu';
        root.blocks = [api.blk('toggle', 'Parent', { children: [api.blk('text', 'Nested')] })];
        api.setState(s);
        api.renderAll();
        const anchor = document.querySelector('.page-item-action');
        api.internals.showPageContextMenu({ target: anchor }, root.id);
        await delay();
        let items = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        items[1].click();
        await delay();
        const childId = api.getState().currentPageId;
        const childParent = api.getState().pages[childId].parentId;
        api.internals.showPageContextMenu({ target: anchor }, root.id);
        await delay();
        items = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        items[2].click();
        await delay();
        const duplicated = Object.values(api.getState().pages).find((page) => page.title.includes('Root Menu') && page.id !== root.id && !page.deletedAt);
        api.internals.showPageContextMenu({ target: anchor }, childId);
        await delay();
        items = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        items.find((item) => item.classList.contains('danger')).click();
        await delay();
        const confirmOpen = !document.querySelector('#dialog-overlay').hidden;
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();
        const state = api.getState();
        return {
          childParent,
          duplicateTitle: duplicated?.title || '',
          duplicateBlockTypes: duplicated?.blocks?.map((block) => block.type) || [],
          duplicateChildTypes: duplicated?.blocks?.[0]?.children?.map((block) => block.type) || [],
          confirmOpen,
          childDeleted: !!state.pages[childId].deletedAt,
          sidebarTitles: Array.from(document.querySelectorAll('.page-item-title')).map((node) => node.textContent)
        };
      }));
      assert.equal(result.childParent.length > 0, true);
      assert.match(result.duplicateTitle, /Root Menu/);
      assert.deepEqual(result.duplicateBlockTypes, ['toggle']);
      assert.deepEqual(result.duplicateChildTypes, ['text']);
      assert.equal(result.confirmOpen, true);
      assert.equal(result.childDeleted, true);
      assert.ok(result.sidebarTitles.some((title) => title.includes('Root Menu')));
    }
  },
  {
    name: 'global undo and redo restore block edits through the app history stack',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.title = 'History';
        current.blocks = [api.blk('text', 'Before')];
        api.setState(s);
        api.renderAll();
        const content = document.querySelector('[data-block-id]');
        content.focus();
        content.textContent = 'After';
        content.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'After' }));
        await delay(700);
        const afterEdit = api.getState().pages[api.getState().currentPageId].blocks[0].content;
        const undoEvent = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(undoEvent);
        await delay(80);
        const afterUndo = api.getState().pages[api.getState().currentPageId].blocks[0].content;
        const redoEvent = new KeyboardEvent('keydown', { key: 'Z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(redoEvent);
        await delay(80);
        const afterRedo = api.getState().pages[api.getState().currentPageId].blocks[0].content;
        return {
          afterEdit,
          afterUndo,
          afterRedo,
          undoPrevented: undoEvent.defaultPrevented,
          redoPrevented: redoEvent.defaultPrevented,
          focusedText: document.activeElement?.textContent || ''
        };
      }));
      assert.equal(result.afterEdit, 'After');
      assert.equal(result.afterUndo, 'Before');
      assert.equal(result.afterRedo, 'After');
      assert.equal(result.undoPrevented, true);
      assert.equal(result.redoPrevented, true);
      assert.equal(result.focusedText, 'After');
    }
  },
  {
    name: 'block selection copy and cut preserve markdown and mutate state safely',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('h2', 'Selected Heading'),
          api.blk('todo', 'Selected Task', { checked: true }),
          api.blk('text', 'Keep me')
        ];
        api.setState(s);
        api.renderAll();
        const [heading, todo] = api.getState().pages[api.getState().currentPageId].blocks;
        const selection = api.internals.BlockSelection;
        selection.clear();
        selection.selectBlock(heading.id);
        selection.selectBlock(todo.id);
        const copyData = new DataTransfer();
        const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copyEvent, 'clipboardData', { value: copyData });
        document.dispatchEvent(copyEvent);
        const cutData = new DataTransfer();
        const cutEvent = new Event('cut', { bubbles: true, cancelable: true });
        Object.defineProperty(cutEvent, 'clipboardData', { value: cutData });
        document.dispatchEvent(cutEvent);
        const remaining = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          copyPrevented: copyEvent.defaultPrevented,
          cutPrevented: cutEvent.defaultPrevented,
          copyPlain: copyData.getData('text/plain'),
          copyMarkdown: copyData.getData('text/markdown'),
          copyHtml: copyData.getData('text/html'),
          cutPlain: cutData.getData('text/plain'),
          remainingTypes: remaining.map((block) => block.type),
          remainingContent: remaining.map((block) => block.content),
          hasSelection: selection.hasSelection()
        };
      }));
      assert.equal(result.copyPrevented, true);
      assert.equal(result.cutPrevented, true);
      assert.match(result.copyPlain, /## Selected Heading/);
      assert.match(result.copyPlain, /- \[x\] Selected Task/);
      assert.equal(result.copyMarkdown, result.copyPlain);
      assert.match(result.copyHtml, /data-leafnote-markdown=/);
      assert.equal(result.cutPlain, result.copyPlain);
      assert.deepEqual(result.remainingTypes, ['text']);
      assert.deepEqual(result.remainingContent, ['Keep me']);
      assert.equal(result.hasSelection, false);
    }
  },
  {
    name: 'block selection copy and cut preserve fenced code payloads',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const codeContent = ['alpha', '```', 'inside four', '````', '~~~', 'omega'].join('\n');
        const mermaidContent = ['flowchart TD', 'A-->B', '```', '~~~~', '~~~'].join('\n');
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('code', codeContent, { language: 'markdown' }),
          api.blk('mermaid', mermaidContent),
          api.blk('text', 'Keep fenced payload')
        ];
        api.setState(s);
        api.renderAll();
        const selection = api.internals.BlockSelection;
        const [code, mermaid] = api.getState().pages[api.getState().currentPageId].blocks;
        selection.clear();
        selection.selectBlock(code.id);
        selection.selectBlock(mermaid.id);

        const copyData = new DataTransfer();
        const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copyEvent, 'clipboardData', { value: copyData });
        document.dispatchEvent(copyEvent);

        const cutData = new DataTransfer();
        const cutEvent = new Event('cut', { bubbles: true, cancelable: true });
        Object.defineProperty(cutEvent, 'clipboardData', { value: cutData });
        document.dispatchEvent(cutEvent);

        const copyPlain = copyData.getData('text/plain');
        const cutPlain = cutData.getData('text/plain');
        const parsedCopy = api.parseMarkdownToBlocks(copyPlain);
        const parsedCut = api.parseMarkdownToBlocks(cutPlain);
        const remaining = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          copyPrevented: copyEvent.defaultPrevented,
          cutPrevented: cutEvent.defaultPrevented,
          copyFenceStarts: copyPlain.split('\n\n').map((block) => block.split('\n')[0]),
          cutMatchesCopy: cutPlain === copyPlain,
          parsedCopyTypes: parsedCopy.map((block) => block.type),
          parsedCutTypes: parsedCut.map((block) => block.type),
          parsedCopyCode: parsedCopy[0]?.content || '',
          parsedCopyMermaid: parsedCopy[1]?.content || '',
          parsedCutCode: parsedCut[0]?.content || '',
          parsedCutMermaid: parsedCut[1]?.content || '',
          remainingTypes: remaining.map((block) => block.type),
          remainingContent: remaining.map((block) => block.content)
        };
      }));
      assert.equal(result.copyPrevented, true);
      assert.equal(result.cutPrevented, true);
      assert.notEqual(result.copyFenceStarts[0], '```markdown');
      assert.notEqual(result.copyFenceStarts[1], '```mermaid');
      assert.equal(result.cutMatchesCopy, true);
      assert.deepEqual(result.parsedCopyTypes, ['code', 'mermaid']);
      assert.deepEqual(result.parsedCutTypes, ['code', 'mermaid']);
      assert.equal(result.parsedCopyCode, ['alpha', '```', 'inside four', '````', '~~~', 'omega'].join('\n'));
      assert.equal(result.parsedCopyMermaid, ['flowchart TD', 'A-->B', '```', '~~~~', '~~~'].join('\n'));
      assert.equal(result.parsedCutCode, result.parsedCopyCode);
      assert.equal(result.parsedCutMermaid, result.parsedCopyMermaid);
      assert.deepEqual(result.remainingTypes, ['text']);
      assert.deepEqual(result.remainingContent, ['Keep fenced payload']);
    }
  },
  {
    name: 'block selection copy and cut preserve markdown delimiter literals',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const textContent = [
          '# copied as text',
          '- copied bullet literal',
          '![copied](https://example.com/no.png)',
          '| copied | table |',
          '| --- | --- |',
          '```'
        ].join('\n');
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('text', textContent),
          api.blk('image', '', { url: 'https://example.com/copy(1).png', caption: 'Copy [caption] \\ tail ]' }),
          api.blk('text', 'Keep delimiter payload')
        ];
        api.setState(s);
        api.renderAll();
        const selection = api.internals.BlockSelection;
        const [textBlock, imageBlock] = api.getState().pages[api.getState().currentPageId].blocks;
        selection.clear();
        selection.selectBlock(textBlock.id);
        selection.selectBlock(imageBlock.id);

        const copyData = new DataTransfer();
        const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copyEvent, 'clipboardData', { value: copyData });
        document.dispatchEvent(copyEvent);

        const cutData = new DataTransfer();
        const cutEvent = new Event('cut', { bubbles: true, cancelable: true });
        Object.defineProperty(cutEvent, 'clipboardData', { value: cutData });
        document.dispatchEvent(cutEvent);

        const copyPlain = copyData.getData('text/plain');
        const cutPlain = cutData.getData('text/plain');
        const parsedCopy = api.parseMarkdownToBlocks(copyPlain);
        const textHolder = document.createElement('div');
        textHolder.innerHTML = parsedCopy[0]?.content || '';
        const captionHolder = document.createElement('div');
        captionHolder.innerHTML = parsedCopy[1]?.caption || '';
        const remaining = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          copyPrevented: copyEvent.defaultPrevented,
          cutPrevented: cutEvent.defaultPrevented,
          cutMatchesCopy: cutPlain === copyPlain,
          copyPlain,
          parsedTypes: parsedCopy.map((block) => block.type),
          parsedText: textHolder.textContent,
          parsedImageUrl: parsedCopy[1]?.url || '',
          parsedCaption: captionHolder.textContent,
          remainingTypes: remaining.map((block) => block.type),
          remainingContent: remaining.map((block) => block.content)
        };
      }));
      assert.equal(result.copyPrevented, true);
      assert.equal(result.cutPrevented, true);
      assert.equal(result.cutMatchesCopy, true);
      assert.match(result.copyPlain, /\\# copied as text/);
      assert.equal(result.copyPlain.includes('\\!\\[copied\\]\\(https://example.com/no.png\\)'), true);
      assert.match(result.copyPlain, /\\\| copied \\\| table \\\|/);
      assert.deepEqual(result.parsedTypes, ['text', 'image']);
      assert.equal(result.parsedText, [
        '# copied as text',
        '- copied bullet literal',
        '![copied](https://example.com/no.png)',
        '| copied | table |',
        '| --- | --- |',
        '```'
      ].join('\n'));
      assert.equal(result.parsedImageUrl, 'https://example.com/copy(1).png');
      assert.equal(result.parsedCaption, 'Copy [caption] \\ tail ]');
      assert.deepEqual(result.remainingTypes, ['text']);
      assert.deepEqual(result.remainingContent, ['Keep delimiter payload']);
    }
  },
  {
    name: 'block selection clipboard event failures do not delete selected blocks',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('h2', 'Clipboard Fail A'),
          api.blk('todo', 'Clipboard Fail B', { checked: true }),
          api.blk('text', 'Keep after failed cut')
        ];
        api.setState(s);
        api.renderAll();
        const selection = api.internals.BlockSelection;
        const selectFirstTwo = () => {
          const blocks = api.getState().pages[api.getState().currentPageId].blocks;
          selection.clear();
          selection.selectBlock(blocks[0].id);
          selection.selectBlock(blocks[1].id);
        };
        const failingClipboard = {
          setData() {
            throw new Error('clipboard denied');
          },
          getData() {
            return '';
          }
        };
        const closeDialog = async () => {
          await delay();
          const ok = document.querySelector('#dialog-box [data-ok]');
          if (ok) ok.click();
          await delay();
        };

        selectFirstTwo();
        const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copyEvent, 'clipboardData', { value: failingClipboard });
        document.dispatchEvent(copyEvent);
        await delay();
        const copyDialog = document.querySelector('#dialog-box')?.textContent || '';
        await closeDialog();

        selectFirstTwo();
        const cutEvent = new Event('cut', { bubbles: true, cancelable: true });
        Object.defineProperty(cutEvent, 'clipboardData', { value: failingClipboard });
        document.dispatchEvent(cutEvent);
        await delay();
        const cutDialog = document.querySelector('#dialog-box')?.textContent || '';
        await closeDialog();

        const remaining = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          copyPrevented: copyEvent.defaultPrevented,
          cutPrevented: cutEvent.defaultPrevented,
          copyDialog,
          cutDialog,
          remainingTypes: remaining.map((block) => block.type),
          remainingContent: remaining.map((block) => block.content),
          hasSelection: selection.hasSelection()
        };
      }));
      assert.equal(result.copyPrevented, true);
      assert.equal(result.cutPrevented, true);
      assert.match(result.copyDialog, /clipboard|クリップボード/i);
      assert.match(result.cutDialog, /clipboard|クリップボード/i);
      assert.deepEqual(result.remainingTypes, ['h2', 'todo', 'text']);
      assert.deepEqual(result.remainingContent, ['Clipboard Fail A', 'Clipboard Fail B', 'Keep after failed cut']);
      assert.equal(result.hasSelection, true);
    }
  },
  {
    name: 'markdown export and selection clipboard limits reject oversized payloads safely',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
        const dialogText = () => document.querySelector('#dialog-box')?.textContent || '';
        const closeDialog = async () => {
          await delay();
          const ok = document.querySelector('#dialog-box [data-ok]');
          if (ok) ok.click();
          await delay();
        };

        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.title = 'Huge Markdown';
        const rawChunk = 'x'.repeat(api.internals.RAW_TEXT_BLOCK_MAX_BYTES);
        current.blocks = Array.from({ length: 6 }, () => api.blk('raw_markdown', rawChunk));
        api.setState(s);

        const originalCreate = URL.createObjectURL;
        const created = [];
        try {
          URL.createObjectURL = (blob) => {
            created.push(blob);
            return 'blob:oversized-markdown';
          };
          api.internals.exportPageAsMarkdown(current.id);
          await delay();
          const exportDialog = dialogText();
          await closeDialog();

          const nestedExportState = api.createInitialState();
          const nestedExportPage = nestedExportState.pages[nestedExportState.currentPageId];
          nestedExportPage.title = 'Huge Nested Markdown';
          const nestedExportChunk = 'n'.repeat(Math.floor(api.internals.MARKDOWN_EXPORT_MAX_BYTES / 6));
          nestedExportPage.blocks = [
            api.blk('bullet', 'Nested export parent', {
              children: Array.from({ length: 6 }, () => api.blk('code', nestedExportChunk, { language: 'javascript' }))
            })
          ];
          api.setState(nestedExportState);
          api.internals.exportPageAsMarkdown(nestedExportPage.id);
          await delay();
          const nestedExportDialog = dialogText();
          await closeDialog();

          const s2 = api.createInitialState();
          const page2 = s2.pages[s2.currentPageId];
          const encodedHuge = '%'.repeat(Math.floor(api.internals.CLIPBOARD_COPY_MAX_BYTES / 2));
          page2.blocks = [
            api.blk('text', encodedHuge),
            api.blk('text', 'Keep clipboard limit')
          ];
          api.setState(s2);
          api.renderAll();
          const selection = api.internals.BlockSelection;
          selection.clear();
          selection.selectBlock(api.getState().pages[api.getState().currentPageId].blocks[0].id);

          const copyData = new DataTransfer();
          const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
          Object.defineProperty(copyEvent, 'clipboardData', { value: copyData });
          document.dispatchEvent(copyEvent);
          await delay();
          const copyDialog = dialogText();
          await closeDialog();

          selection.clear();
          selection.selectBlock(api.getState().pages[api.getState().currentPageId].blocks[0].id);
          const cutData = new DataTransfer();
          const cutEvent = new Event('cut', { bubbles: true, cancelable: true });
          Object.defineProperty(cutEvent, 'clipboardData', { value: cutData });
          document.dispatchEvent(cutEvent);
          await delay();
          const cutDialog = dialogText();
          await closeDialog();

          const flatRemaining = api.getState().pages[api.getState().currentPageId].blocks;

          const s3 = api.createInitialState();
          const page3 = s3.pages[s3.currentPageId];
          const nestedClipboardChunk = 'c'.repeat(Math.floor(api.internals.CLIPBOARD_COPY_MAX_BYTES * 0.6));
          page3.blocks = [
            api.blk('bullet', 'Nested clipboard parent', {
              children: [
                api.blk('code', nestedClipboardChunk, { language: 'javascript' }),
                api.blk('code', nestedClipboardChunk, { language: 'javascript' })
              ]
            }),
            api.blk('text', 'Keep nested clipboard limit')
          ];
          api.setState(s3);
          api.renderAll();
          selection.clear();
          selection.selectBlock(api.getState().pages[api.getState().currentPageId].blocks[0].id);
          const nestedCopyData = new DataTransfer();
          const nestedCopyEvent = new Event('copy', { bubbles: true, cancelable: true });
          Object.defineProperty(nestedCopyEvent, 'clipboardData', { value: nestedCopyData });
          document.dispatchEvent(nestedCopyEvent);
          await delay();
          const nestedCopyDialog = dialogText();
          await closeDialog();

          selection.clear();
          selection.selectBlock(api.getState().pages[api.getState().currentPageId].blocks[0].id);
          const nestedCutData = new DataTransfer();
          const nestedCutEvent = new Event('cut', { bubbles: true, cancelable: true });
          Object.defineProperty(nestedCutEvent, 'clipboardData', { value: nestedCutData });
          document.dispatchEvent(nestedCutEvent);
          await delay();
          const nestedCutDialog = dialogText();
          await closeDialog();

          const nestedRemaining = api.getState().pages[api.getState().currentPageId].blocks;
          return {
            createdCount: created.length,
            exportDialog,
            nestedExportDialog,
            copyPrevented: copyEvent.defaultPrevented,
            copyDialog,
            copyPlainLength: copyData.getData('text/plain').length,
            cutPrevented: cutEvent.defaultPrevented,
            cutDialog,
            cutPlainLength: cutData.getData('text/plain').length,
            nestedCopyPrevented: nestedCopyEvent.defaultPrevented,
            nestedCopyDialog,
            nestedCopyPlainLength: nestedCopyData.getData('text/plain').length,
            nestedCutPrevented: nestedCutEvent.defaultPrevented,
            nestedCutDialog,
            nestedCutPlainLength: nestedCutData.getData('text/plain').length,
            flatRemainingCount: flatRemaining.length,
            flatFirstRemainingLength: flatRemaining[0].content.length,
            flatSecondRemainingContent: flatRemaining[1].content,
            nestedRemainingCount: nestedRemaining.length,
            nestedFirstRemainingContent: nestedRemaining[0].content,
            nestedSecondRemainingContent: nestedRemaining[1].content,
            clipboardPayloadLength: api.internals._clipboardMarkdownPayloadByteLength(encodedHuge)
          };
        } finally {
          URL.createObjectURL = originalCreate;
        }
      }));
      assert.equal(result.createdCount, 0);
      assert.match(result.exportDialog, /5\.0 MB|5 MB|5MB/);
      assert.match(result.nestedExportDialog, /5\.0 MB|5 MB|5MB/);
      assert.equal(result.copyPrevented, true);
      assert.match(result.copyDialog, /1\.0 MB|1 MB|1MB/);
      assert.equal(result.copyPlainLength, 0);
      assert.equal(result.cutPrevented, true);
      assert.match(result.cutDialog, /1\.0 MB|1 MB|1MB/);
      assert.equal(result.cutPlainLength, 0);
      assert.equal(result.nestedCopyPrevented, true);
      assert.match(result.nestedCopyDialog, /1\.0 MB|1 MB|1MB/);
      assert.equal(result.nestedCopyPlainLength, 0);
      assert.equal(result.nestedCutPrevented, true);
      assert.match(result.nestedCutDialog, /1\.0 MB|1 MB|1MB/);
      assert.equal(result.nestedCutPlainLength, 0);
      assert.equal(result.flatRemainingCount, 2);
      assert.ok(result.flatFirstRemainingLength > 0);
      assert.equal(result.flatSecondRemainingContent, 'Keep clipboard limit');
      assert.equal(result.nestedRemainingCount, 2);
      assert.equal(result.nestedFirstRemainingContent, 'Nested clipboard parent');
      assert.equal(result.nestedSecondRemainingContent, 'Keep nested clipboard limit');
      assert.ok(result.clipboardPayloadLength > 1024 * 1024);
    }
  },
  {
    name: 'inline formatting and links fall back safely when execCommand is unavailable',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalExecCommand = document.execCommand;
        const selectText = (node, start, end) => {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, end);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        };
        const textNodeContaining = (root, text) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.nodeValue.includes(text)) return node;
          }
          return null;
        };
        const clickToolbar = (command) => {
          const button = document.querySelector(`#inline-toolbar [data-cmd="${command}"]`);
          button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          button.click();
        };
        try {
          const s = api.createInitialState();
          const current = s.pages[s.currentPageId];
          current.blocks = [api.blk('text', 'Format me')];
          api.setState(s);
          api.renderAll();
          const content = document.querySelector('[data-block-id]');
          content.focus();

          document.execCommand = () => false;
          selectText(content.firstChild, 0, 6);
          const boldKey = new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true });
          content.dispatchEvent(boldKey);
          await delay();
          const afterBold = current.blocks[0].content;

          const meText = textNodeContaining(content, 'me');
          const meStart = meText.nodeValue.indexOf('me');
          selectText(meText, meStart, meStart + 2);
          clickToolbar('italic');
          await delay();
          const afterItalic = current.blocks[0].content;

          const italicText = textNodeContaining(content, 'me');
          selectText(italicText, 0, italicText.nodeValue.length);
          document.execCommand = () => { throw new Error('format unsupported'); };
          clickToolbar('createLink');
          await delay();
          const linkInput = document.querySelector('#dialog-box .dialog-input');
          linkInput.value = 'example.com/docs';
          document.querySelector('#dialog-box [data-ok]').click();
          await delay(80);
          const linkedState = current.blocks[0].content;

          const anchor = content.querySelector('a');
          const anchorText = textNodeContaining(anchor, 'me');
          selectText(anchorText, 0, anchorText.nodeValue.length);
          document.execCommand = undefined;
          clickToolbar('createLink');
          await delay();
          const unlinkInput = document.querySelector('#dialog-box .dialog-input');
          unlinkInput.value = '';
          document.querySelector('#dialog-box [data-ok]').click();
          await delay(80);
          const unlinkedState = current.blocks[0].content;

          document.execCommand = () => false;
          const endRange = document.createRange();
          endRange.selectNodeContents(content);
          endRange.collapse(false);
          getSelection().removeAllRanges();
          getSelection().addRange(endRange);
          const beforeFailedCollapsed = current.blocks[0].content;
          const collapsedKey = new KeyboardEvent('keydown', { key: 'b', metaKey: true, bubbles: true, cancelable: true });
          content.dispatchEvent(collapsedKey);
          await delay();
          const failureDialog = document.querySelector('#dialog-box')?.textContent || '';
          const afterFailedCollapsed = current.blocks[0].content;
          document.querySelector('#dialog-box [data-ok]')?.click();
          await delay();

          return {
            boldPrevented: boldKey.defaultPrevented,
            collapsedPrevented: collapsedKey.defaultPrevented,
            afterBold,
            afterItalic,
            linkedState,
            unlinkedState,
            failureDialog,
            beforeFailedCollapsed,
            afterFailedCollapsed
          };
        } finally {
          document.execCommand = originalExecCommand;
        }
      }));
      assert.equal(result.boldPrevented, true);
      assert.equal(result.collapsedPrevented, true);
      assert.match(result.afterBold, /<strong>Format<\/strong>/);
      assert.match(result.afterItalic, /<em>me<\/em>/);
      assert.match(result.linkedState, /<a href="https:\/\/example\.com\/docs"/);
      assert.equal(result.unlinkedState.includes('<a '), false);
      assert.match(result.failureDialog, /format|装飾/i);
      assert.equal(result.afterFailedCollapsed, result.beforeFailedCollapsed);
    }
  },
  {
    name: 'paste and code Tab use Range insertion when execCommand fails',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalExecCommand = document.execCommand;
        const setCaretEnd = (target) => {
          target.focus();
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        };
        const paste = (target, values) => {
          const data = new DataTransfer();
          Object.entries(values).forEach(([type, value]) => data.setData(type, value));
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        try {
          const s = api.createInitialState();
          const current = s.pages[s.currentPageId];
          current.title = 'Page';
          current.workspaceName = 'ignored';
          s.workspaceName = 'Doc';
          current.blocks = [
            api.blk('text', 'Hello'),
            api.blk('code', 'let x = 1;', { language: 'javascript' })
          ];
          api.setState(s);
          api.renderAll();

          document.execCommand = () => false;
          let content = document.querySelector('[data-block-id]');
          setCaretEnd(content);
          const plainPrevented = paste(content, { 'text/plain': ' world' });
          await delay();

          setCaretEnd(content);
          const htmlPrevented = paste(content, { 'text/html': '<b> safe</b><script>window.__pasteXss=1</script>' });
          await delay();
          const richState = current.blocks[0].content;

          setCaretEnd(content);
          const multilinePrevented = paste(content, { 'text/plain': ' one\nsecond' });
          await delay(80);

          document.execCommand = undefined;
          const title = document.querySelector('#page-title');
          setCaretEnd(title);
          const titlePrevented = paste(title, { 'text/plain': ' Title' });
          const documentName = document.querySelector('#document-name');
          setCaretEnd(documentName);
          const documentNamePrevented = paste(documentName, { 'text/plain': ' Name' });
          await delay();

          document.execCommand = () => { throw new Error('insertText unsupported'); };
          const code = document.querySelector('.code-block-content code');
          setCaretEnd(code);
          const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
          code.dispatchEvent(tab);
          await delay();

          const blocks = api.getState().pages[api.getState().currentPageId].blocks;
          return {
            plainPrevented,
            htmlPrevented,
            multilinePrevented,
            titlePrevented,
            documentNamePrevented,
            tabPrevented: tab.defaultPrevented,
            richState,
            blockTypes: blocks.map((block) => block.type),
            blockText: blocks.map((block) => block.content),
            title: api.getState().pages[api.getState().currentPageId].title,
            documentName: api.getState().workspaceName,
            pasteXss: window.__pasteXss || 0
          };
        } finally {
          document.execCommand = originalExecCommand;
        }
      }));
      assert.equal(result.plainPrevented, true);
      assert.equal(result.htmlPrevented, true);
      assert.equal(result.multilinePrevented, true);
      assert.equal(result.titlePrevented, true);
      assert.equal(result.documentNamePrevented, true);
      assert.equal(result.tabPrevented, true);
      assert.match(result.richState, /Hello world/);
      assert.match(result.richState, /safe/);
      assert.equal(result.richState.includes('<script'), false);
      assert.deepEqual(result.blockTypes, ['text', 'text', 'code']);
      assert.match(result.blockText[0], /Hello world.*safe.*one/);
      assert.equal(result.blockText[1], 'second');
      assert.equal(result.blockText[2], 'let x = 1;  ');
      assert.equal(result.title, 'Page Title');
      assert.equal(result.documentName, 'Doc Name');
      assert.equal(result.pasteXss, 0);
    }
  },
  {
    name: 'keyboard block copy and cut survive throwing or missing execCommand',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalExecCommand = document.execCommand;
        const originalClipboard = navigator.clipboard;
        const writes = [];
        const makeState = () => {
          const s = api.createInitialState();
          const current = s.pages[s.currentPageId];
          current.blocks = [api.blk('text', 'Clipboard target'), api.blk('text', 'Keep me')];
          api.setState(s);
          api.renderAll();
          return current;
        };
        try {
          const current = makeState();
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (text) => writes.push(text) }
          });
          document.execCommand = () => { throw new Error('unsupported'); };
          api.internals.BlockSelection.selectBlock(current.blocks[0].id);
          const copyKey = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
          document.dispatchEvent(copyKey);
          await delay();
          const afterCopy = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.content);

          document.execCommand = undefined;
          const cutKey = new KeyboardEvent('keydown', { key: 'x', metaKey: true, bubbles: true, cancelable: true });
          document.dispatchEvent(cutKey);
          await delay();
          const afterMissingCut = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.content);

          const failedCurrent = makeState();
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async () => { throw new Error('denied'); } }
          });
          document.execCommand = undefined;
          api.internals.BlockSelection.selectBlock(failedCurrent.blocks[0].id);
          const failedCutKey = new KeyboardEvent('keydown', { key: 'x', metaKey: true, bubbles: true, cancelable: true });
          document.dispatchEvent(failedCutKey);
          await delay();
          const failureDialog = document.querySelector('#dialog-box')?.textContent || '';
          const afterFailedCut = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.content);
          document.querySelector('#dialog-box [data-ok]')?.click();
          await delay();

          return {
            copyPrevented: copyKey.defaultPrevented,
            cutPrevented: cutKey.defaultPrevented,
            failedCutPrevented: failedCutKey.defaultPrevented,
            writes,
            afterCopy,
            afterMissingCut,
            afterFailedCut,
            failureDialog
          };
        } finally {
          document.execCommand = originalExecCommand;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
        }
      }));
      assert.equal(result.copyPrevented, true);
      assert.equal(result.cutPrevented, true);
      assert.equal(result.failedCutPrevented, true);
      assert.equal(result.writes.length, 2);
      assert.match(result.writes.join('\n'), /Clipboard target/);
      assert.deepEqual(result.afterCopy, ['Clipboard target', 'Keep me']);
      assert.deepEqual(result.afterMissingCut, ['Keep me']);
      assert.deepEqual(result.afterFailedCut, ['Clipboard target', 'Keep me']);
      assert.match(result.failureDialog, /not removed|削除していません|clipboard|クリップボード/i);
    }
  },
  {
    name: 'keyboard cut fallback deletes selected blocks only after clipboard write succeeds',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [
          api.blk('h2', 'Fallback Cut A'),
          api.blk('todo', 'Fallback Cut B', { checked: true }),
          api.blk('text', 'Keep fallback')
        ];
        api.setState(s);
        api.renderAll();

        const originalExecCommand = document.execCommand;
        const originalClipboard = navigator.clipboard;
        const writes = [];
        document.execCommand = () => false;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text) => {
              writes.push(text);
            }
          }
        });
        try {
          const blocks = api.getState().pages[api.getState().currentPageId].blocks;
          const selection = api.internals.BlockSelection;
          selection.clear();
          selection.selectBlock(blocks[0].id);
          selection.selectBlock(blocks[1].id);
          const cutKey = new KeyboardEvent('keydown', { key: 'x', metaKey: true, bubbles: true, cancelable: true });
          document.dispatchEvent(cutKey);
          await delay();
          const remaining = api.getState().pages[api.getState().currentPageId].blocks;
          return {
            prevented: cutKey.defaultPrevented,
            writes,
            remainingTypes: remaining.map((block) => block.type),
            remainingContent: remaining.map((block) => block.content),
            hasSelection: selection.hasSelection()
          };
        } finally {
          document.execCommand = originalExecCommand;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
        }
      }));
      assert.equal(result.prevented, true);
      assert.equal(result.writes.length, 1);
      assert.match(result.writes[0], /## Fallback Cut A/);
      assert.match(result.writes[0], /- \[x\] Fallback Cut B/);
      assert.deepEqual(result.remainingTypes, ['text']);
      assert.deepEqual(result.remainingContent, ['Keep fallback']);
      assert.equal(result.hasSelection, false);
    }
  },
  {
    name: 'code block copy falls back and reports failure without throwing',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('code', 'console.log("copy fallback");', { language: 'javascript' })];
        api.setState(s);
        api.renderAll();

        const originalExecCommand = document.execCommand;
        const originalClipboard = navigator.clipboard;
        const execCalls = [];
        const closeDialog = async () => {
          await delay();
          const ok = document.querySelector('#dialog-box [data-ok]');
          if (ok) ok.click();
          await delay();
        };
        try {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: () => Promise.reject(new Error('denied'))
            }
          });
          document.execCommand = (command) => {
            execCalls.push({
              command,
              activeTag: document.activeElement?.tagName || '',
              activeValue: document.activeElement?.value || ''
            });
            return true;
          };
          document.querySelector('.code-copy-btn').click();
          await delay(80);
          const afterFallback = {
            text: document.querySelector('.code-copy-btn').textContent,
            disabled: document.querySelector('.code-copy-btn').disabled,
            execCalls: [...execCalls],
            dialogOpen: !document.querySelector('#dialog-overlay').hidden
          };

          api.renderAll();
          execCalls.length = 0;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: null });
          document.execCommand = (command) => {
            execCalls.push({ command });
            return false;
          };
          document.querySelector('.code-copy-btn').click();
          await delay(80);
          const failureDialog = document.querySelector('#dialog-box')?.textContent || '';
          const disabledWhileDialog = document.querySelector('.code-copy-btn').disabled;
          await closeDialog();
          const afterFailure = {
            text: document.querySelector('.code-copy-btn').textContent,
            disabled: document.querySelector('.code-copy-btn').disabled,
            execCalls: [...execCalls],
            failureDialog,
            disabledWhileDialog
          };

          return { afterFallback, afterFailure };
        } finally {
          document.execCommand = originalExecCommand;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
        }
      }));
      assert.match(result.afterFallback.text, /Copied|コピー済み/);
      assert.equal(result.afterFallback.disabled, true);
      assert.equal(result.afterFallback.dialogOpen, false);
      assert.deepEqual(result.afterFallback.execCalls.map((call) => call.command), ['copy']);
      assert.equal(result.afterFallback.execCalls[0].activeTag, 'TEXTAREA');
      assert.equal(result.afterFallback.execCalls[0].activeValue, 'console.log("copy fallback");');
      assert.match(result.afterFailure.failureDialog, /code block|コードブロック|clipboard|クリップボード/i);
      assert.equal(result.afterFailure.disabledWhileDialog, true);
      assert.equal(result.afterFailure.disabled, false);
      assert.match(result.afterFailure.text, /Copy|コピー/);
      assert.deepEqual(result.afterFailure.execCalls.map((call) => call.command), ['copy']);
    }
  },
  {
    name: 'markdown import creates a new sanitized page from a selected file',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const originalCreateElement = document.createElement.bind(document);
        let fileInput = null;
        document.createElement = function patchedCreateElement(tagName, options) {
          const element = originalCreateElement(tagName, options);
          if (String(tagName).toLowerCase() === 'input') {
            fileInput = element;
            element.click = () => {};
          }
          return element;
        };
        try {
          const s = api.createInitialState();
          api.setState(s);
          api.renderAll();
          api.internals.importMarkdownAsNewPage();
          const file = new File([
            [
              '# Imported <script>bad</script> Page',
              '',
              '## Section',
              '',
              '- [x] Done',
              '',
              '<script>alert(1)</script>',
              '',
              '![Bad scheme](javascript:alert(1))',
              '',
              '![SVG data](data:image/svg+xml,%3Csvg%3E%3C/svg%3E)',
              '',
              '![SVG remote](https://example.com/vector.svg)',
              '',
              '![Raster remote](https://example.com/image.png?token=1)',
              '',
              '[bad](javascript:alert(1)) [ok](https://example.com)'
            ].join('\n')
          ], 'Imported.md', { type: 'text/markdown' });
          Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
          await fileInput.onchange();
          const state = api.getState();
          const imported = state.pages[state.currentPageId];
          return {
            title: imported.title,
            titleDom: document.querySelector('#page-title').innerHTML,
            types: imported.blocks.map((block) => block.type),
            contents: imported.blocks.map((block) => block.content),
            imageUrls: imported.blocks.filter((block) => block.type === 'image').map((block) => block.url),
            pageCount: Object.keys(state.pages).length
          };
        } finally {
          document.createElement = originalCreateElement;
        }
      }));
      assert.equal(result.title, 'Imported <script>bad</script> Page');
      assert.equal(result.titleDom.includes('<script>'), false);
      assert.match(result.titleDom, /&lt;script&gt;bad&lt;\/script&gt;/);
      assert.deepEqual(result.types, ['h2', 'todo', 'html', 'image', 'image', 'image', 'image', 'text']);
      assert.match(result.contents[0], /Section/);
      assert.equal(result.contents[2].includes('script'), true);
      assert.deepEqual(result.imageUrls, ['', '', '', 'https://example.com/image.png?token=1']);
      assert.equal(result.contents[7].includes('javascript:'), false);
      assert.match(result.contents[7], /href="https:\/\/example\.com"/);
      assert.equal(result.pageCount, 2);
    }
  },
  {
    name: 'markdown import rejects oversized files and reports read errors',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalCreateElement = document.createElement.bind(document);
        let fileInput = null;
        document.createElement = function patchedCreateElement(tagName, options) {
          const element = originalCreateElement(tagName, options);
          if (String(tagName).toLowerCase() === 'input') {
            fileInput = element;
            element.click = () => {};
          }
          return element;
        };
        try {
          const s = api.createInitialState();
          api.setState(s);
          api.renderAll();
          const beforeCount = Object.keys(api.getState().pages).length;

          api.internals.importMarkdownAsNewPage();
          const largeFile = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'too-large.md', { type: 'text/markdown' });
          Object.defineProperty(fileInput, 'files', { value: [largeFile], configurable: true });
          const largePromise = fileInput.onchange();
          await delay();
          const largeAlert = document.querySelector('#dialog-box').textContent;
          document.querySelector('#dialog-box [data-ok]').click();
          await largePromise;

          api.internals.importMarkdownAsNewPage();
          const failingFile = {
            name: 'broken.md',
            size: 10,
            text: async () => { throw new Error('read failed'); }
          };
          Object.defineProperty(fileInput, 'files', { value: [failingFile], configurable: true });
          const readPromise = fileInput.onchange();
          await delay();
          const readAlert = document.querySelector('#dialog-box').textContent;
          document.querySelector('#dialog-box [data-ok]').click();
          await readPromise;

          return {
            beforeCount,
            afterCount: Object.keys(api.getState().pages).length,
            largeAlert,
            readAlert,
            currentTitle: api.getState().pages[api.getState().currentPageId].title
          };
        } finally {
          document.createElement = originalCreateElement;
        }
      }));
      assert.equal(result.afterCount, result.beforeCount);
      assert.match(result.largeAlert, /Markdown|2 MB|2\.0 MB|以下/);
      assert.match(result.readAlert, /read|読み込み|失敗/i);
      assert.notEqual(result.currentTitle, 'too-large');
      assert.notEqual(result.currentTitle, 'broken');
    }
  },
  {
    name: 'markdown import enforces line, block, and table cell limits before creating pages',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalCreateElement = document.createElement.bind(document);
        let fileInput = null;
        document.createElement = function patchedCreateElement(tagName, options) {
          const element = originalCreateElement(tagName, options);
          if (String(tagName).toLowerCase() === 'input') {
            fileInput = element;
            element.click = () => {};
          }
          return element;
        };
        const importText = async (text, name = 'import.md') => {
          api.internals.importMarkdownAsNewPage();
          const file = new File([text], name, { type: 'text/markdown' });
          Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
          const promise = fileInput.onchange();
          await delay();
          let alertText = '';
          const overlay = document.querySelector('#dialog-overlay');
          if (overlay && !overlay.hidden) {
            alertText = document.querySelector('#dialog-box').textContent;
            document.querySelector('#dialog-box [data-ok]').click();
          }
          await promise;
          return alertText;
        };
        try {
          const s = api.createInitialState();
          api.setState(s);
          api.renderAll();
          const beforeCount = Object.keys(api.getState().pages).length;
          const headings = (count) => Array.from({ length: count }, (_, i) => `## H${i}`).join('\n');
          const successAlert = await importText(`# Within limit\n\n${headings(api.internals.MARKDOWN_IMPORT_MAX_BLOCKS)}`, 'within.md');
          const afterSuccessState = api.getState();
          const afterSuccessCount = Object.keys(afterSuccessState.pages).length;
          const successBlocks = afterSuccessState.pages[afterSuccessState.currentPageId].blocks.length;
          const blockAlert = await importText(`# Too many\n\n${headings(api.internals.MARKDOWN_IMPORT_MAX_BLOCKS + 1)}`, 'too-many-blocks.md');
          const lineAlert = await importText(Array.from({ length: api.internals.MARKDOWN_IMPORT_MAX_LINES + 1 }, () => 'line').join('\n'), 'too-many-lines.md');
          const header = `| ${Array.from({ length: 10 }, (_, i) => `c${i}`).join(' | ')} |`;
          const align = `| ${Array.from({ length: 10 }, () => '---').join(' | ')} |`;
          const row = `| ${Array.from({ length: 10 }, () => 'v').join(' | ')} |`;
          const table = [header, align, ...Array.from({ length: 9 }, () => row)].join('\n');
          const tableAlert = await importText(Array.from({ length: 101 }, () => table).join('\n\n'), 'too-many-table-cells.md');
          return {
            beforeCount,
            afterSuccessCount,
            afterFinalCount: Object.keys(api.getState().pages).length,
            successAlert,
            successBlocks,
            blockAlert,
            lineAlert,
            tableAlert
          };
        } finally {
          document.createElement = originalCreateElement;
        }
      }));
      assert.equal(result.afterSuccessCount, result.beforeCount + 1);
      assert.equal(result.afterFinalCount, result.afterSuccessCount);
      assert.equal(result.successAlert, '');
      assert.equal(result.successBlocks, 1000);
      assert.match(result.blockAlert, /1000|ブロック|blocks/i);
      assert.match(result.lineAlert, /5000|行|lines/i);
      assert.match(result.tableAlert, /10000|セル|cells/i);
    }
  },
  {
    name: 'markdown import refuses to create a page at the page capacity',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const max = api.internals.PAGE_MAX_COUNT;
        const originalCreateElement = document.createElement.bind(document);
        const createdInputs = [];
        document.createElement = function patchedCreateElement(tagName, options) {
          const element = originalCreateElement(tagName, options);
          if (String(tagName).toLowerCase() === 'input') {
            createdInputs.push(element);
            element.click = () => {};
          }
          return element;
        };
        try {
          const s = api.createInitialState();
          for (let i = 1; i < max; i++) {
            const id = `import-limit-${i}`;
            s.pages[id] = {
              id,
              title: `Import limit ${i}`,
              icon: '',
              iconType: 'emoji',
              hasIcon: false,
              parentId: null,
              children: [],
              blocks: [api.blk('text', `Page ${i}`)],
              createdAt: i,
              updatedAt: i
            };
            s.rootPages.push(id);
          }
          api.setState(s);
          api.renderAll();
          createdInputs.length = 0;
          api.internals.importMarkdownAsNewPage();
          await delay();
          const alertText = document.querySelector('#dialog-box').textContent;
          document.querySelector('#dialog-box [data-ok]')?.click();
          return {
            pageCount: Object.keys(api.getState().pages).length,
            inputCount: createdInputs.length,
            alertText
          };
        } finally {
          document.createElement = originalCreateElement;
        }
      }));
      assert.equal(result.pageCount, 1000);
      assert.equal(result.inputCount, 0);
      assert.match(result.alertText, /1000|ページ|pages/i);
    }
  },
  {
    name: 'self-contained HTML export embeds sanitized state and revokes object URLs',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        s.workspaceName = 'Export Source';
        const current = s.pages[s.currentPageId];
        current.title = 'Export Page';
        current.blocks = [
          api.blk('text', 'Body &lt;/script&gt; marker'),
          api.blk('code', "const end = '</script>';\nconst spaced = '</script >';\nconst newline = '</script\n>';", { language: 'javascript' }),
          api.blk('image', '', { url: 'https://example.com/image.png', caption: 'Remote' })
        ];
        api.setState(s);
        api.renderAll();
        const originalFetch = window.fetch;
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        const originalClick = HTMLAnchorElement.prototype.click;
        const created = [];
        const revoked = [];
        const clicks = [];
        try {
          window.fetch = async (url) => {
            const text = String(url);
            if (text.includes('image.png')) {
              return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
            }
            return new Response('<!DOCTYPE html><html><body><script id="embedded-state" type="application/json">{}</script></body></html>', { status: 200 });
          };
          URL.createObjectURL = (blob) => {
            const url = `blob:export-${created.length}`;
            created.push({ url, blob });
            return url;
          };
          URL.revokeObjectURL = (url) => { revoked.push(url); };
          HTMLAnchorElement.prototype.click = function click() {
            clicks.push({ href: this.href, download: this.download, connected: document.body.contains(this) });
          };
          document.querySelector('#export-btn').click();
          await delay();
          const input = document.querySelector('#dialog-box .dialog-input');
          input.value = 'Unsafe/Export:Name';
          document.querySelector('#dialog-box [data-ok]').click();
          await delay(120);
          const html = await created[0].blob.text();
          const match = /<script id="embedded-state" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
          const embeddedPayload = match[1];
          const embeddedState = JSON.parse(embeddedPayload);
          return {
            clicks,
            revoked,
            html,
            embeddedPayload,
            embeddedName: embeddedState.workspaceName,
            embeddedContent: embeddedState.pages[embeddedState.currentPageId].blocks[0].content,
            embeddedCode: embeddedState.pages[embeddedState.currentPageId].blocks[1].content,
            imageUrl: embeddedState.pages[embeddedState.currentPageId].blocks[2].url
          };
        } finally {
          window.fetch = originalFetch;
          URL.createObjectURL = originalCreate;
          URL.revokeObjectURL = originalRevoke;
          HTMLAnchorElement.prototype.click = originalClick;
        }
      }));
      assert.equal(result.clicks.length, 1);
      assert.equal(result.clicks[0].connected, true);
      assert.match(result.clicks[0].download, /^Unsafe_Export_Name-\d{4}-\d{2}-\d{2}\.html$/);
      assert.deepEqual(result.revoked, ['blob:export-0']);
      assert.equal(result.embeddedName, 'Unsafe/Export:Name');
      assert.equal(result.embeddedContent, 'Body &lt;/script&gt; marker');
      assert.equal(result.embeddedCode, "const end = '</script>';\nconst spaced = '</script >';\nconst newline = '</script\n>';");
      assert.match(result.imageUrl, /^data:image\/png;base64,/);
      assert.match(result.html, /<script id="embedded-state"/);
      assert.equal(result.html.includes("const end = '</script>';"), false);
      assert.equal(result.embeddedPayload.includes('<'), false);
      assert.equal(result.html.includes("const spaced = '</script >';"), false);
      assert.equal(result.html.includes("const newline = '</script\n>';"), false);
    }
  },
  {
    name: 'self-contained HTML export aborts cleanly when remote image failures are cancelled',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('image', '', { url: 'https://example.com/missing.png', caption: 'Missing' })];
        api.setState(s);
        api.renderAll();
        const originalFetch = window.fetch;
        const originalCreate = URL.createObjectURL;
        const created = [];
        try {
          window.fetch = async (url) => {
            if (String(url).includes('missing.png')) return new Response('missing', { status: 404 });
            return new Response('<!DOCTYPE html><html><body><script id="embedded-state" type="application/json">{}</script></body></html>', { status: 200 });
          };
          URL.createObjectURL = (blob) => {
            created.push(blob);
            return `blob:cancel-${created.length}`;
          };
          document.querySelector('#export-btn').click();
          await delay();
          document.querySelector('#dialog-box [data-ok]').click();
          await delay(80);
          const confirmText = document.querySelector('#dialog-box').textContent;
          const confirmOpen = !document.querySelector('#dialog-overlay').hidden;
          document.querySelector('#dialog-box [data-cancel]').click();
          await delay(80);
          return {
            confirmOpen,
            confirmText,
            createdCount: created.length,
            dialogHidden: document.querySelector('#dialog-overlay').hidden
          };
        } finally {
          window.fetch = originalFetch;
          URL.createObjectURL = originalCreate;
        }
      }));
      assert.equal(result.confirmOpen, true);
      assert.match(result.confirmText, /1/);
      assert.equal(result.createdCount, 0);
      assert.equal(result.dialogHidden, true);
    }
  },
  {
    name: 'self-contained HTML export can keep excessive remote image links without fetching them',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = Array.from({ length: api.internals.REMOTE_IMAGE_INLINE_MAX_COUNT + 1 }, (_, i) =>
          api.blk('image', '', { url: `https://example.com/remote-${i}.png`, caption: `Remote ${i}` })
        );
        api.setState(s);
        api.renderAll();
        const originalFetch = window.fetch;
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        const originalClick = HTMLAnchorElement.prototype.click;
        const imageFetches = [];
        const created = [];
        try {
          window.fetch = async (url) => {
            const text = String(url);
            if (/remote-\d+\.png/.test(text)) {
              imageFetches.push(text);
              return new Response(new Blob(['png'], { type: 'image/png' }), { status: 200 });
            }
            return new Response('<!DOCTYPE html><html><body><script id="embedded-state" type="application/json">{}</script></body></html>', { status: 200 });
          };
          URL.createObjectURL = (blob) => {
            created.push(blob);
            return `blob:remote-limit-${created.length}`;
          };
          URL.revokeObjectURL = () => {};
          HTMLAnchorElement.prototype.click = function click() {};
          document.querySelector('#export-btn').click();
          await delay();
          document.querySelector('#dialog-box [data-ok]').click();
          await delay(80);
          const limitDialogText = document.querySelector('#dialog-box').textContent;
          document.querySelector('#dialog-box [data-cancel]').click();
          await delay(120);
          const html = await created[0].text();
          const embeddedPayload = /<script id="embedded-state" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
          const embeddedState = JSON.parse(embeddedPayload);
          return {
            limitDialogText,
            imageFetchCount: imageFetches.length,
            createdCount: created.length,
            firstUrl: embeddedState.pages[embeddedState.currentPageId].blocks[0].url,
            lastUrl: embeddedState.pages[embeddedState.currentPageId].blocks.at(-1).url
          };
        } finally {
          window.fetch = originalFetch;
          URL.createObjectURL = originalCreate;
          URL.revokeObjectURL = originalRevoke;
          HTMLAnchorElement.prototype.click = originalClick;
        }
      }));
      assert.match(result.limitDialogText, /50|外部画像|external images/i);
      assert.equal(result.imageFetchCount, 0);
      assert.equal(result.createdCount, 1);
      assert.match(result.firstUrl, /^https:\/\/example\.com\/remote-0\.png$/);
      assert.match(result.lastUrl, /^https:\/\/example\.com\/remote-\d+\.png$/);
    }
  },
  {
    name: 'large image and attachment confirmations can be cancelled without mutating blocks',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('text', ''), api.blk('text', '')];
        api.setState(s);
        api.renderAll();
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        const bigImageBytes = new Uint8Array(api.internals.IMAGE_WARN_BYTES + 1);
        const bigImage = new File([bigImageBytes], 'big.png', { type: 'image/png' });
        const imagePromise = api.internals._insertImageBlockFromFile(bigImage, blocks[0]);
        await delay();
        const imageConfirmText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-cancel]').click();
        const imageResult = await imagePromise;
        const bigFileBytes = new Uint8Array(api.internals.ATTACHMENT_WARN_BYTES + 1);
        const bigFile = new File([bigFileBytes], 'big.bin', { type: 'application/octet-stream' });
        const filePromise = api.internals._insertFileBlockFromFile(bigFile, blocks[1]);
        await delay();
        const fileConfirmText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-cancel]').click();
        const fileResult = await filePromise;
        const finalBlocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          imageResult,
          fileResult,
          imageConfirmText,
          fileConfirmText,
          types: finalBlocks.map((block) => block.type),
          urls: finalBlocks.map((block) => block.url || ''),
          fileDataUrls: finalBlocks.map((block) => block.fileDataUrl || ''),
          dialogHidden: document.querySelector('#dialog-overlay').hidden
        };
      }));
      assert.equal(result.imageResult, false);
      assert.equal(result.fileResult, false);
      assert.match(result.imageConfirmText, /25 MB|large|大き/);
      assert.match(result.fileConfirmText, /50 MB|large|大き/);
      assert.deepEqual(result.types, ['text', 'text']);
      assert.deepEqual(result.urls, ['', '']);
      assert.deepEqual(result.fileDataUrls, ['', '']);
      assert.equal(result.dialogHidden, true);
    }
  },
  {
    name: 'invalid attachment downloads show an alert and do not create object URLs',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const originalCreate = URL.createObjectURL;
        let createCalls = 0;
        try {
          URL.createObjectURL = () => {
            createCalls++;
            return 'blob:invalid-download';
          };
          const downloadPromise = api.internals.downloadFileBlock({
            type: 'file',
            fileName: 'bad.txt',
            fileDataUrl: 'https://example.com/not-data',
            fileType: 'text/plain',
            fileSize: 10
          });
          await delay();
          const alertText = document.querySelector('#dialog-box').textContent;
          const open = !document.querySelector('#dialog-overlay').hidden;
          document.querySelector('#dialog-box [data-ok]').click();
          await downloadPromise;
          await delay();
          return {
            createCalls,
            alertText,
            open,
            hidden: document.querySelector('#dialog-overlay').hidden
          };
        } finally {
          URL.createObjectURL = originalCreate;
        }
      }));
      assert.equal(result.createCalls, 0);
      assert.equal(result.open, true);
      assert.match(result.alertText, /download|ダウンロード|failed|失敗/i);
      assert.equal(result.hidden, true);
    }
  },
  {
    name: 'image URL picker supports cancel and accept flows through the prompt UI',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('image', '', { url: '', caption: '' })];
        api.setState(s);
        api.renderAll();
        const acceptedUrl = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
        const block = api.getState().pages[api.getState().currentPageId].blocks[0];
        api.internals.openImagePicker(block);
        await delay();
        let items = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        items[1].click();
        await delay();
        const cancelOpen = !document.querySelector('#dialog-overlay').hidden;
        document.querySelector('#dialog-box [data-cancel]').click();
        await delay();
        const afterCancel = block.url;

        api.internals.openImagePicker(block);
        await delay();
        items = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        items[1].click();
        await delay();
        const invalidInput = document.querySelector('#dialog-box .dialog-input');
        invalidInput.value = 'javascript:alert(1)';
        document.querySelector('#dialog-box [data-ok]').click();
        await delay(80);
        const invalidOpen = !document.querySelector('#dialog-overlay').hidden;
        const invalidMessage = document.querySelector('#dialog-box').textContent;
        const afterInvalid = block.url;
        const imageAfterInvalid = document.querySelector('.image-wrap img')?.getAttribute('src') || '';
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();

        api.internals.openImagePicker(block);
        await delay();
        items = Array.from(document.querySelectorAll('#context-menu .ctx-item'));
        items[1].click();
        await delay();
        const input = document.querySelector('#dialog-box .dialog-input');
        input.value = acceptedUrl;
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();
        return {
          cancelOpen,
          afterCancel,
          invalidOpen,
          invalidMessage,
          afterInvalid,
          imageAfterInvalid,
          afterAccept: block.url,
          stateUrl: api.getState().pages[api.getState().currentPageId].blocks[0].url,
          imageSrc: document.querySelector('.image-wrap img')?.getAttribute('src') || '',
          acceptedUrl,
          contextHidden: document.querySelector('#context-menu').hidden,
          dialogHidden: document.querySelector('#dialog-overlay').hidden
        };
      }));
      assert.equal(result.cancelOpen, true);
      assert.equal(result.afterCancel, '');
      assert.equal(result.invalidOpen, true);
      assert.match(result.invalidMessage, /http\(s\)|data:image|URL/);
      assert.equal(result.afterInvalid, '');
      assert.equal(result.imageAfterInvalid, '');
      assert.equal(result.afterAccept, result.acceptedUrl);
      assert.equal(result.stateUrl, result.acceptedUrl);
      assert.equal(result.imageSrc, result.acceptedUrl);
      assert.equal(result.contextHidden, true);
      assert.equal(result.dialogHidden, true);
    }
  },
  {
    name: 'image and file picker onchange handlers load selected files',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('image', '', { url: '', caption: '' }), api.blk('file', '')];
        api.setState(s);
        api.renderAll();
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        const createdInputs = [];
        const originalCreateElement = document.createElement.bind(document);
        document.createElement = function (name, ...args) {
          const el = originalCreateElement(name, ...args);
          if (String(name).toLowerCase() === 'input') createdInputs.push(el);
          return el;
        };
        try {
          const tinyGifBytes = Uint8Array.from(atob('R0lGODlhAQABAAAAACwAAAAAAQABAAA='), (ch) => ch.charCodeAt(0));
          api.internals.openImagePicker(blocks[0]);
          await delay();
          document.querySelector('#context-menu .ctx-item').click();
          const imageInput = createdInputs.at(-1);
          Object.defineProperty(imageInput, 'files', { configurable: true, value: [new File([tinyGifBytes], 'picker.gif', { type: 'image/gif' })] });
          imageInput.onchange();
          await delay(120);
          api.internals.openFilePicker(blocks[1]);
          const fileInput = createdInputs.at(-1);
          Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['hello'], 'picker.txt', { type: 'text/plain' })] });
          fileInput.onchange();
          await delay(120);
          return {
            imageUrl: blocks[0].url,
            fileName: blocks[1].fileName,
            fileDataUrl: blocks[1].fileDataUrl,
            createdInputCount: createdInputs.length
          };
        } finally {
          document.createElement = originalCreateElement;
        }
      }));
      assert.match(result.imageUrl, /^data:image\/gif;base64,/);
      assert.equal(result.fileName, 'picker.txt');
      assert.match(result.fileDataUrl, /^data:text\/plain;base64,/);
      assert.equal(result.createdInputCount, 2);
    }
  },
  {
    name: 'governance and spec block controls sanitize and persist field edits',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const governanceErrors = [];
        const onGovernanceError = (event) => {
          governanceErrors.push(event.message || event.error?.message || String(event.error || 'error'));
        };
        window.addEventListener('error', onGovernanceError);
        const s = api.createInitialState();
        api.setState(s);
        const state = api.getState();
        const current = state.pages[state.currentPageId];
        current.blocks = [
          Object.assign(api.blk('decision', 'Initial'), {
            governanceStatus: 'proposed',
            governanceOwner: '',
            governanceDate: ''
          }),
          Object.assign(api.blk('db_table', ''), api.internals._createSpecBlockDefaults('db_table'))
        ];
        api.renderAll();
        const decision = current.blocks[0];
        const db = current.blocks[1];
        const status = document.querySelector('[aria-label="Decision Status"]');
        status.value = 'accepted';
        status.dispatchEvent(new Event('change', { bubbles: true }));
        const owner = document.querySelector('[aria-label="Decision Owner"]');
        owner.value = 'Team\u0000<script>';
        owner.dispatchEvent(new Event('input', { bubbles: true }));
        const date = document.querySelector('[aria-label="Decision Date"]');
        date.value = '2026-05-22';
        date.dispatchEvent(new Event('input', { bubbles: true }));
        const content = document.querySelector('.governance-content');
        content.innerHTML = '<b onclick="x()">Safe</b><script>bad()</script>';
        content.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Safe' }));
        const governanceKey = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
        content.dispatchEvent(governanceKey);
        await delay();
        const governancePasteData = new DataTransfer();
        governancePasteData.setData('text/html', '<i onclick=x>Pasted</i><script>bad()</script>');
        const governancePaste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(governancePaste, 'clipboardData', { value: governancePasteData });
        content.dispatchEvent(governancePaste);
        document.querySelector('[aria-label="DB Table Table"]').value = 'users\u0000';
        document.querySelector('[aria-label="DB Table Table"]').dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[aria-label="DB Table Purpose"]').value = 'Stores users\u0000';
        document.querySelector('[aria-label="DB Table Purpose"]').dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.spec-column-add').click();
        await delay();
        const name = document.querySelector('[aria-label="DB column 2 name"]');
        name.value = 'email\u0000';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        const key = document.querySelector('[aria-label="DB column 2 key"]');
        key.value = 'UK';
        key.dispatchEvent(new Event('change', { bubbles: true }));
        const nullable = document.querySelector('[aria-label="DB column 2 nullable"]');
        nullable.value = 'Yes';
        nullable.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('.spec-column-remove:not([disabled])').click();
        await delay();
        window.removeEventListener('error', onGovernanceError);
        return {
          decision: {
            status: decision.governanceStatus,
            owner: decision.governanceOwner,
            date: decision.governanceDate,
            content: decision.content
          },
          db: {
            tableName: db.tableName,
            tablePurpose: db.tablePurpose,
            columns: db.columns
          },
          renderedBlocks: Array.from(document.querySelectorAll('#blocks .block')).map((block) => block.dataset.type)
          ,
          governancePastePrevented: governancePaste.defaultPrevented,
          governanceErrors
        };
      }));
      assert.deepEqual(result.renderedBlocks, ['decision', 'db_table']);
      assert.equal(result.decision.status, 'accepted');
      assert.equal(result.decision.owner, 'Team<script>');
      assert.equal(result.decision.owner.includes('\u0000'), false);
      assert.equal(result.decision.date, '2026-05-22');
      assert.equal(result.decision.content.includes('onclick'), false);
      assert.equal(result.decision.content.includes('script'), false);
      assert.match(result.decision.content, /Safe|Pasted/);
      assert.equal(result.governancePastePrevented, true);
      assert.deepEqual(result.governanceErrors, []);
      assert.equal(result.db.tableName, 'users');
      assert.equal(result.db.tablePurpose, 'Stores users');
      assert.equal(result.db.columns.length, 1);
      assert.equal(result.db.columns[0].name, 'email');
      assert.equal(result.db.columns[0].key, 'UK');
      assert.equal(result.db.columns[0].nullable, 'Yes');
    }
  },
  {
    name: 'editing shortcuts and paste refuse to exceed the per-page block capacity',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const max = api.internals.BLOCK_MAX_COUNT_PER_PAGE;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = Array.from({ length: max }, (_, i) => api.blk('text', `Block ${i}`));
        api.setState(s);
        api.renderAll();
        const content = document.querySelector('.block-content');
        content.focus();
        const beforeCount = api.internals.countBlocksForPage(api.getState().pages[api.getState().currentPageId]);
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        content.dispatchEvent(enter);
        await delay();
        const enterAlert = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]')?.click();
        await delay();

        const pasteData = new DataTransfer();
        pasteData.setData('text/plain', 'first\nsecond');
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: pasteData });
        content.dispatchEvent(paste);
        await delay();
        const pasteAlert = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]')?.click();
        await delay();

        return {
          beforeCount,
          afterCount: api.internals.countBlocksForPage(api.getState().pages[api.getState().currentPageId]),
          enterPrevented: enter.defaultPrevented,
          pastePrevented: paste.defaultPrevented,
          enterAlert,
          pasteAlert
        };
      }));
      assert.equal(result.beforeCount, 1000);
      assert.equal(result.afterCount, 1000);
      assert.equal(result.enterPrevented, true);
      assert.equal(result.pastePrevented, true);
      assert.match(result.enterAlert, /1000|ブロック|blocks/i);
      assert.match(result.pasteAlert, /1000|ブロック|blocks/i);
    }
  },
  {
    name: 'block drag moves refuse to exceed the nested block depth limit',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const makeChain = (leafDepth) => {
          let child = api.blk('text', 'Target');
          child.id = 'target';
          for (let depth = leafDepth - 1; depth >= 0; depth--) {
            const parent = api.blk('toggle', `Level ${depth}`, { expanded: true, children: [child] });
            parent.id = `chain-${depth}`;
            child = parent;
          }
          return child;
        };
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        const source = api.blk('toggle', 'Source', { expanded: true, children: [api.blk('text', 'Nested child')] });
        source.id = 'source';
        source.children[0].id = 'source-child';
        const leaf = api.blk('text', 'Leaf');
        leaf.id = 'leaf';
        current.blocks = [source, leaf, makeChain(api.internals.BLOCK_MAX_DEPTH)];
        api.setState(s);

        const canReject = api.internals.canMoveBlockWithinDepthLimit('source', 'target', 'after');
        const beforeRootIds = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.id);
        const rejected = api.internals.moveBlock('source', 'target', 'after');
        await delay();
        const alertText = document.querySelector('#dialog-box').textContent;
        document.querySelector('#dialog-box [data-ok]').click();
        await delay();
        const afterRejectRootIds = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.id);
        const canAllow = api.internals.canMoveBlockWithinDepthLimit('leaf', 'target', 'after');
        const allowed = api.internals.moveBlock('leaf', 'target', 'after');
        const leafAtDepth = (() => {
          const walk = (blocks, depth = 0) => {
            for (const block of blocks || []) {
              if (block.id === 'leaf') return depth;
              const childDepth = walk(block.children, depth + 1);
              if (childDepth != null) return childDepth;
            }
            return null;
          };
          return walk(api.getState().pages[api.getState().currentPageId].blocks);
        })();
        return {
          canReject,
          rejected,
          beforeRootIds,
          afterRejectRootIds,
          alertText,
          canAllow,
          allowed,
          leafAtDepth,
          sourceStillRoot: api.getState().pages[api.getState().currentPageId].blocks.some((block) => block.id === 'source')
        };
      }));
      assert.equal(result.canReject, false);
      assert.equal(result.rejected, false);
      assert.deepEqual(result.afterRejectRootIds, result.beforeRootIds);
      assert.match(result.alertText, /32|階層|levels/i);
      assert.equal(result.canAllow, true);
      assert.equal(result.allowed, true);
      assert.equal(result.leafAtDepth, 32);
      assert.equal(result.sourceStillRoot, true);
    }
  },
  {
    name: 'DB spec columns add button is disabled at the row cap',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const max = api.internals.SPEC_COLUMNS_MAX_ROWS;
        const s = api.createInitialState();
        api.setState(s);
        const current = api.getState().pages[api.getState().currentPageId];
        const rows = Array.from({ length: max }, (_, i) => ({ name: `col_${i}`, type: 'text', key: '', nullable: 'No', description: '' }));
        current.blocks = [api.blk('db_table', '', { columns: rows })];
        api.renderAll();
        const block = api.getState().pages[api.getState().currentPageId].blocks[0];
        const addAtMax = document.querySelector('.spec-column-add');
        const disabledAtMax = addAtMax.disabled;
        addAtMax.click();
        await delay();
        const lengthAfterDisabledClick = block.columns.length;
        block.columns.pop();
        api.renderAll();
        const addBelowMax = document.querySelector('.spec-column-add');
        const disabledBelowMax = addBelowMax.disabled;
        addBelowMax.click();
        await delay();
        return {
          max,
          disabledAtMax,
          lengthAfterDisabledClick,
          disabledBelowMax,
          lengthAfterEnabledClick: block.columns.length
        };
      }));
      assert.equal(result.disabledAtMax, true);
      assert.equal(result.lengthAfterDisabledClick, result.max);
      assert.equal(result.disabledBelowMax, false);
      assert.equal(result.lengthAfterEnabledClick, result.max);
    }
  },
  {
    name: 'global selection shortcuts select, delete, and escape-select blocks',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.blocks = [api.blk('text', 'One'), api.blk('text', 'Two'), api.blk('text', 'Three')];
        api.setState(s);
        api.renderAll();
        const selection = api.internals.BlockSelection;
        const firstEditable = document.querySelector('[data-block-id]');
        firstEditable.focus();
        const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.dispatchEvent(escapeEvent);
        const afterEscape = selection.getSelectedIds().slice();
        const selectAllEvent = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(selectAllEvent);
        await delay();
        const afterSelectAll = selection.getSelectedIds().slice();
        const deleteEvent = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
        document.dispatchEvent(deleteEvent);
        await delay();
        const blocks = api.getState().pages[api.getState().currentPageId].blocks;
        return {
          escapePrevented: escapeEvent.defaultPrevented,
          selectAllPrevented: selectAllEvent.defaultPrevented,
          deletePrevented: deleteEvent.defaultPrevented,
          afterEscapeCount: afterEscape.length,
          afterSelectAllCount: afterSelectAll.length,
          blockTypes: blocks.map((block) => block.type),
          blockContents: blocks.map((block) => block.content),
          hasSelection: selection.hasSelection()
        };
      }));
      assert.equal(result.escapePrevented, true);
      assert.equal(result.selectAllPrevented, true);
      assert.equal(result.deletePrevented, true);
      assert.equal(result.afterEscapeCount, 1);
      assert.equal(result.afterSelectAllCount, 3);
      assert.deepEqual(result.blockTypes, ['text']);
      assert.deepEqual(result.blockContents, ['']);
      assert.equal(result.hasSelection, false);
    }
  },
  {
    name: 'shortcut commands, search ranking, merge backspace, and clipboard fallbacks execute',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

        let s = api.createInitialState();
        const root = s.pages[s.currentPageId];
        root.title = 'Body Match';
        root.blocks = [api.blk('text', 'rank-token body')];
        const titleMatch = api.createPage(null, { title: 'rank-token title' });
        titleMatch.blocks = [api.blk('text', 'plain')];
        const bodyMatch = api.createPage(null, { title: 'Other body' });
        bodyMatch.blocks = [api.blk('text', 'rank-token body two')];
        api.setState(s);
        api.renderAll();
        document.querySelector('#search-btn').click();
        await delay();
        const search = document.querySelector('#search-input');
        search.value = 'rank-token';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(api.internals.SEARCH_INPUT_DEBOUNCE_MS + 60);
        const rankedTitles = Array.from(document.querySelectorAll('#search-results .search-item-title'))
          .slice(0, 3)
          .map((node) => node.textContent);
        document.querySelector('#search-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await delay();

        s = api.createInitialState();
        api.setState(s);
        api.renderAll();
        const clickShortcutRow = async (matcher, index = 0) => {
          api.internals.openShortcutsModal();
          await delay();
          const rows = Array.from(document.querySelectorAll('#shortcuts-body .shortcuts-row.clickable'))
            .filter((row) => matcher.test(row.textContent));
          if (!rows[index]) throw new Error(`Shortcut row not found: ${matcher}`);
          rows[index].click();
          await delay();
        };
        await clickShortcutRow(/Open note search/i);
        const shortcutSearchOpen = !document.querySelector('#search-overlay').hidden;
        document.querySelector('#search-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        await delay();
        await clickShortcutRow(/^Undo/i);
        await clickShortcutRow(/^Redo/i, 0);
        await clickShortcutRow(/^Redo/i, 1);

        s = api.createInitialState();
        const mergePage = s.pages[s.currentPageId];
        mergePage.blocks = [api.blk('text', 'Hello '), api.blk('text', 'World')];
        api.setState(s);
        api.renderAll();
        const second = document.querySelectorAll('[data-block-id]')[1];
        second.focus();
        const range = document.createRange();
        range.setStart(second.firstChild || second, 0);
        range.collapse(true);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const backspace = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
        second.dispatchEvent(backspace);
        await delay(120);
        const mergedBlocks = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.content);

        s = api.createInitialState();
        const clipPage = s.pages[s.currentPageId];
        clipPage.blocks = [api.blk('text', 'Clip A'), api.blk('text', 'Clip B')];
        api.setState(s);
        api.renderAll();
        const originalExecCommand = document.execCommand;
        const originalClipboard = navigator.clipboard;
        const writes = [];
        const closeDialogIfOpen = async () => {
          await delay();
          const ok = document.querySelector('#dialog-box [data-ok]');
          if (ok) ok.click();
          await delay();
        };
        document.execCommand = () => false;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (text) => {
              writes.push(text);
              return Promise.reject(new Error('clipboard denied'));
            }
          }
        });
        try {
          api.internals.BlockSelection.selectVisibleTopLevelBlocks();
          const copyKey = new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true, cancelable: true });
          document.dispatchEvent(copyKey);
          await closeDialogIfOpen();
          api.internals.BlockSelection.selectVisibleTopLevelBlocks();
          const cutKey = new KeyboardEvent('keydown', { key: 'x', metaKey: true, bubbles: true, cancelable: true });
          document.dispatchEvent(cutKey);
          await closeDialogIfOpen();
          const remaining = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.content);
          return {
            rankedTitles,
            shortcutSearchOpen,
            backspacePrevented: backspace.defaultPrevented,
            mergedBlocks,
            copyPrevented: copyKey.defaultPrevented,
            cutPrevented: cutKey.defaultPrevented,
            writes,
            remaining
          };
        } finally {
          document.execCommand = originalExecCommand;
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
        }
      }));
      assert.match(result.rankedTitles[0], /rank-token title/);
      assert.equal(result.shortcutSearchOpen, true);
      assert.equal(result.backspacePrevented, true);
      assert.deepEqual(result.mergedBlocks, ['Hello World']);
      assert.equal(result.copyPrevented, true);
      assert.equal(result.cutPrevented, true);
      assert.ok(result.writes.length >= 2);
      assert.match(result.writes.join('\n'), /Clip A/);
      assert.deepEqual(result.remaining, ['Clip A', 'Clip B']);
    }
  },
  {
    name: 'tampered block ids with selector-breaking characters remain operable',
    run: async (page) => {
      const result = await evaluate(page, js(() => {
        const api = window.__LeafNoteTest;
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        const textId = 'bad"] [data-block-id="missing';
        const tableId = 'table"] .simple-table tr, body';
        const textBlock = api.blk('text', 'Unsafe selector id');
        textBlock.id = textId;
        const tableBlock = api.blk('table', '', {
          rows: 1,
          cols: 1,
          cells: [['cell']],
          hasHeaderRow: false,
          hasHeaderCol: false
        });
        tableBlock.id = tableId;
        current.blocks = [textBlock, tableBlock];
        api.setState(s);
        api.renderAll();

        const editable = document.querySelector(api.internals.blockEditableSelectorById(textId));
        const tableCell = document.querySelector('.simple-table td');
        const selection = api.internals.BlockSelection;
        selection.clear();
        selection.selectBlock(textId);
        const selected = document.querySelector(api.internals.blockSelectorById(textId))?.classList.contains('selected') || false;
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        tableCell.dispatchEvent(tab);
        const updatedTable = api.getState().pages[api.getState().currentPageId].blocks[1];
        selection.clear();
        return {
          editableFound: !!editable,
          selected,
          tabPrevented: tab.defaultPrevented,
          rows: updatedTable.rows,
          cols: updatedTable.cols,
          escapedTextSelector: api.internals.blockEditableSelectorById(textId),
          escapedTableSelector: api.internals.blockSelectorById(tableId)
        };
      }));
      assert.equal(result.editableFound, true);
      assert.equal(result.selected, true);
      assert.equal(result.tabPrevented, true);
      assert.deepEqual({ rows: result.rows, cols: result.cols }, { rows: 2, cols: 1 });
      assert.match(result.escapedTextSelector, /bad/);
      assert.match(result.escapedTableSelector, /table/);
    }
  },
  {
    name: 'IME composition keyCode 229 does not submit dialogs or split editing targets',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const composingKey = (key) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
          Object.defineProperty(event, 'keyCode', { configurable: true, get: () => 229 });
          Object.defineProperty(event, 'which', { configurable: true, get: () => 229 });
          return event;
        };

        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.title = 'IME Page';
        current.blocks = [api.blk('text', '日本語入力中')];
        api.setState(s);
        api.renderAll();

        const content = document.querySelector('[data-block-id]');
        content.focus();
        const composingEnter = composingKey('Enter');
        content.dispatchEvent(composingEnter);
        await delay();
        const blockContentsAfterComposingEnter = api.getState().pages[api.getState().currentPageId].blocks.map((block) => block.content);

        const title = document.querySelector('#page-title');
        title.focus();
        const titleEnter = composingKey('Enter');
        title.dispatchEvent(titleEnter);
        await delay();
        const titleStillFocused = document.activeElement === title;

        const documentName = document.querySelector('#document-name');
        documentName.focus();
        const documentNameEnter = composingKey('Enter');
        documentName.dispatchEvent(documentNameEnter);
        await delay();
        const documentNameStillFocused = document.activeElement === documentName;

        const promptPromise = api.internals.showPrompt('IME escape should not close');
        let promptSettled = false;
        promptPromise.then(() => { promptSettled = true; });
        await delay(80);
        const promptInput = document.querySelector('#dialog-box .dialog-input');
        const promptEscape = composingKey('Escape');
        promptInput.dispatchEvent(promptEscape);
        await delay();
        const dialogOpenAfterComposingEscape = !document.querySelector('#dialog-overlay').hidden;
        const promptSettledAfterComposingEscape = promptSettled;
        promptInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        const promptResult = await promptPromise;

        document.querySelector('#search-btn').click();
        await delay();
        const search = document.querySelector('#search-input');
        search.value = 'IME Search Page';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        await delay(api.internals.SEARCH_INPUT_DEBOUNCE_MS + 60);
        const searchEnter = composingKey('Enter');
        search.dispatchEvent(searchEnter);
        await delay();
        const searchStillOpen = !document.querySelector('#search-overlay').hidden;
        api.internals.closeOverlay(document.querySelector('#search-overlay'));

        return {
          helperRecognizes229: api.internals.isIMEComposingEvent(composingKey('Enter')),
          blockContentsAfterComposingEnter,
          composingEnterPrevented: composingEnter.defaultPrevented,
          titleEnterPrevented: titleEnter.defaultPrevented,
          titleStillFocused,
          documentNameEnterPrevented: documentNameEnter.defaultPrevented,
          documentNameStillFocused,
          promptEscapePrevented: promptEscape.defaultPrevented,
          dialogOpenAfterComposingEscape,
          promptSettledAfterComposingEscape,
          promptResult,
          searchEnterPrevented: searchEnter.defaultPrevented,
          searchStillOpen,
          currentTitle: api.getState().pages[api.getState().currentPageId].title
        };
      }));
      assert.equal(result.helperRecognizes229, true);
      assert.deepEqual(result.blockContentsAfterComposingEnter, ['日本語入力中']);
      assert.equal(result.composingEnterPrevented, false);
      assert.equal(result.titleEnterPrevented, false);
      assert.equal(result.titleStillFocused, true);
      assert.equal(result.documentNameEnterPrevented, false);
      assert.equal(result.documentNameStillFocused, true);
      assert.equal(result.promptEscapePrevented, false);
      assert.equal(result.dialogOpenAfterComposingEscape, true);
      assert.equal(result.promptSettledAfterComposingEscape, false);
      assert.equal(result.promptResult, null);
      assert.equal(result.searchEnterPrevented, false);
      assert.equal(result.searchStillOpen, true);
      assert.equal(result.currentTitle, 'IME Page');
    }
  },
  {
    name: 'critical LeafNote layout stays inside mobile tablet and desktop viewports',
    run: async (page) => {
      const viewports = [
        { name: '320x568', width: 320, height: 568, mobile: true },
        { name: '375x667', width: 375, height: 667, mobile: true },
        { name: '390x520-low', width: 390, height: 520, mobile: true },
        { name: '390x844', width: 390, height: 844, mobile: true },
        { name: '430x932', width: 430, height: 932, mobile: true },
        { name: '768x1024', width: 768, height: 1024, mobile: false },
        { name: '1024x768', width: 1024, height: 768, mobile: false },
        { name: '1280x720', width: 1280, height: 720, mobile: false }
      ];
      const results = [];
      try {
        for (const viewport of viewports) {
          await page.send('Emulation.setDeviceMetricsOverride', {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: viewport.mobile
          });
          await page.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
          results.push(await evaluate(page, jsWithArgs(async (viewport) => {
            const api = window.__LeafNoteTest;
            const delay = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
            const longJa = '長い日本語タイトル'.repeat(12);
            const longWord = 'Supercalifragilisticexpialidocious'.repeat(5);
            const s = api.createInitialState();
            s.workspaceName = `${longJa}${longWord}`;
            const current = s.pages[s.currentPageId];
            current.title = `${longJa}${longWord}`;
            current.blocks = [
              api.blk('text', `${longJa} ${longWord}`),
              api.blk('code', `const longWord = "${longWord}";`, { language: 'javascript', wrap: false }),
              api.blk('table', '', {
                rows: 2,
                cols: 3,
                cells: [[longWord, longJa, 'ok'], ['1', '2', '3']],
                hasHeaderRow: false,
                hasHeaderCol: false
              }),
              api.blk('image', '', { url: '', caption: longJa })
            ];
            api.setState(s);
            api.renderAll();
            await delay();

            const rectOffscreen = (selector) => {
              const node = document.querySelector(selector);
              if (!node || node.hidden) return null;
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden') return null;
              const rect = node.getBoundingClientRect();
              return {
                selector,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
                horizontalOffscreen: rect.left < -1 || rect.right > window.innerWidth + 1,
                verticalOffscreen: rect.top < -1 || rect.bottom > window.innerHeight + 1,
                offscreen: rect.left < -1 || rect.right > window.innerWidth + 1 || rect.top < -1 || rect.bottom > window.innerHeight + 1
              };
            };
            const measureModal = async (open, close, selector) => {
              await open();
              await delay(80);
              const measurement = rectOffscreen(selector);
              await close();
              await delay();
              return measurement;
            };

            const chromeRects = ['.app', '#editor-scroll', '#page-title', '#page-meta', '#blocks']
              .map(rectOffscreen)
              .filter(Boolean);
            const searchModal = await measureModal(
              async () => { document.querySelector('#search-btn').click(); },
              async () => { api.internals.closeOverlay(document.querySelector('#search-overlay')); },
              '#search-modal'
            );
            const themeModal = await measureModal(
              async () => { api.internals.openThemeCustomizer(); },
              async () => { api.internals.closeThemeCustomizer(); },
              '#theme-modal'
            );
            const trashModal = await measureModal(
              async () => { api.internals.openTrashModal(); },
              async () => { api.internals.closeOverlay(document.querySelector('#trash-overlay')); },
              '#trash-modal'
            );
            const promptPromise = api.internals.showPrompt('Viewport check');
            await delay(80);
            const dialogBox = rectOffscreen('#dialog-box');
            document.querySelector('#dialog-box [data-cancel]').click();
            await promptPromise;

            const tableWrapper = document.querySelector('.table-wrapper');
            const tableOverflowContained = tableWrapper ? tableWrapper.scrollWidth > tableWrapper.clientWidth : false;
            const modalRects = [searchModal, themeModal, trashModal, dialogBox].filter(Boolean);
            return {
              viewport,
              documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
              bodyOverflow: document.body.scrollWidth - window.innerWidth,
              offscreenChrome: chromeRects.filter((item) => item.horizontalOffscreen),
              offscreenModals: modalRects.filter((item) => item.offscreen),
              modalRects,
              tableOverflowContained,
              tableWrapperWithinViewport: (() => {
                if (!tableWrapper) return false;
                const rect = tableWrapper.getBoundingClientRect();
                return rect.left >= -1 && rect.right <= window.innerWidth + 1;
              })(),
              pageMetaOpacity: Number(getComputedStyle(document.querySelector('#page-meta')).opacity),
              blockGutterOpacity: Number(getComputedStyle(document.querySelector('.block-gutter')).opacity)
            };
          }, viewport)));
        }
      } finally {
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.send('Emulation.clearDeviceMetricsOverride');
      }

      for (const result of results) {
        assert.ok(result.documentOverflow <= 1, `${result.viewport.name} document overflowed by ${result.documentOverflow}px`);
        assert.ok(result.bodyOverflow <= 1, `${result.viewport.name} body overflowed by ${result.bodyOverflow}px`);
        assert.deepEqual(result.offscreenChrome, [], `${result.viewport.name} chrome outside viewport`);
        assert.deepEqual(result.offscreenModals, [], `${result.viewport.name} modal outside viewport`);
        assert.equal(result.tableWrapperWithinViewport, true, `${result.viewport.name} table wrapper escaped viewport`);
        if (result.viewport.mobile) {
          assert.ok(result.pageMetaOpacity >= 0.99, `${result.viewport.name} meta buttons must be visible on touch/mobile`);
          assert.ok(result.blockGutterOpacity >= 0.99, `${result.viewport.name} block gutter must be visible on touch/mobile`);
        }
      }
    }
  },
  {
    name: 'language selection and theme reset update live UI without touching page content',
    run: async (page) => {
      const result = await evaluate(page, js(async () => {
        const api = window.__LeafNoteTest;
        const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
        const s = api.createInitialState();
        const current = s.pages[s.currentPageId];
        current.title = 'Language Page';
        current.blocks = [api.blk('text', 'Body')];
        api.setState(s);
        api.renderAll();
        api.internals.openThemeCustomizer();
        await delay();
        const lang = document.querySelector('#ui-language-select');
        lang.value = 'ja';
        lang.dispatchEvent(new Event('change', { bubbles: true }));
        await delay(80);
        const jaTitle = document.querySelector('#theme-title').textContent;
        const jaTrash = document.querySelector('#trash-btn').textContent;
        document.querySelector('.theme-swatch').click();
        await delay();
        const accentBeforeReset = getComputedStyle(document.documentElement).getPropertyValue('--ln-primary').trim();
        document.querySelector('#theme-reset-btn').click();
        await delay();
        const confirmOpen = !document.querySelector('#dialog-overlay').hidden;
        document.querySelector('#dialog-box [data-ok]').click();
        await delay(80);
        return {
          uiLanguage: api.getState().uiLanguage,
          jaTitle,
          jaTrash,
          accentBeforeReset,
          themeCustomKeys: Object.keys(api.getState().themeCustom || {}),
          currentTitle: api.getState().pages[api.getState().currentPageId].title,
          currentBody: api.getState().pages[api.getState().currentPageId].blocks[0].content,
          themeHidden: document.querySelector('#theme-customizer-overlay').hidden,
          confirmOpen
        };
      }));
      assert.equal(result.uiLanguage, 'ja');
      assert.match(result.jaTitle, /テーマ|表示/);
      assert.match(result.jaTrash, /ゴミ箱/);
      assert.ok(result.accentBeforeReset.length > 0);
      assert.deepEqual(result.themeCustomKeys, []);
      assert.equal(result.currentTitle, 'Language Page');
      assert.equal(result.currentBody, 'Body');
      assert.equal(result.themeHidden, true);
      assert.equal(result.confirmOpen, true);
    }
  }
];

async function runTestGroup(page, tests) {
  for (const test of tests) {
    await test.run(page);
    console.log(`ok - ${test.name}`);
  }
}

async function reportCoverage(page) {
  const result = await page.send('Profiler.takePreciseCoverage');
  await page.send('Profiler.stopPreciseCoverage');
  const entries = result.result.filter((entry) => entry.url.includes('LeafNote.html'));
  let total = 0;
  let used = 0;
  const uncovered = [];
  for (const entry of entries) {
    let scriptSource = '';
    let lineStarts = [];
    if (process.env.COVERAGE_DETAIL === '1') {
      try {
        scriptSource = (await page.send('Debugger.getScriptSource', { scriptId: entry.scriptId })).scriptSource || '';
        lineStarts = [0];
        for (let i = 0; i < scriptSource.length; i++) {
          if (scriptSource.charCodeAt(i) === 10) lineStarts.push(i + 1);
        }
      } catch (_) {}
    }
    for (const fn of entry.functions) {
      total++;
      if (fn.ranges.some((range) => range.count > 0)) {
        used++;
      } else if (scriptSource) {
        const offset = fn.ranges[0]?.startOffset || 0;
        let lineIndex = 0;
        let low = 0;
        let high = lineStarts.length - 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (lineStarts[mid] <= offset) {
            lineIndex = mid;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        const lineStart = lineStarts[lineIndex] || 0;
        const nextLineStart = lineStarts[lineIndex + 1] || scriptSource.length;
        const snippet = scriptSource.slice(lineStart, nextLineStart).trim().replace(/\s+/g, ' ');
        uncovered.push({
          line: lineIndex + 1,
          column: offset - lineStart + 1,
          name: fn.functionName || '(anonymous)',
          snippet
        });
      }
    }
  }
  const pct = total ? ((used / total) * 100).toFixed(1) : '0.0';
  console.log(`coverage - LeafNote.html functions: ${used}/${total} (${pct}%)`);
  if (process.env.COVERAGE_DETAIL === '1') {
    uncovered
      .sort((a, b) => a.line - b.line || a.column - b.column)
      .forEach((fn) => {
        console.log(`uncovered - ${fn.line}:${fn.column} ${fn.name} :: ${fn.snippet}`);
      });
  }
}

// Storage tests use real tabs on fresh local origins so they cannot touch a
// user's file:// document or inherit state from the editor fixture tests.
async function runStorageReliabilityTests(browser) {
  const source = await readFile(appPath, 'utf8');
  const fixtures = [];
  const pages = [];
  const fixture = async () => {
    const context = { embedded: null };
    const server = http.createServer((req, res) => {
      const embedded = context.embedded && req.url.startsWith('/export.html')
        ? JSON.stringify(context.embedded).replace(/</g, '\\u003c') : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(source.replace('<script id="embedded-state" type="application/json"></script>',
        `<script id="embedded-state" type="application/json">${embedded}</script>`));
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    context.url = `http://127.0.0.1:${server.address().port}`;
    fixtures.push(server);
    return context;
  };
  const tab = async (context, file = 'LeafNote.html') => {
    const page = await openPage(browser.port, { url: `${context.url}/${file}?test=1` });
    pages.push(page);
    return page;
  };
  const seed = (page) => evaluate(page, js(async () => {
    const api = window.__LeafNoteTest;
    const state = api.createInitialState();
    state.pages[state.currentPageId].blocks = [api.blk('text', 'original')];
    api.setState(state);
    return api._doSave({ force: true });
  }));
  try {
    for (const storageMode of ['IndexedDB', 'localStorage fallback', 'mixed stores']) {
      const context = await fixture();
      const first = await tab(context);
      assert.equal(await seed(first), true);
      const second = await tab(context);
      if (storageMode !== 'IndexedDB') {
        const fallbackTabs = storageMode === 'mixed stores' ? [second] : [first, second];
        await Promise.all(fallbackTabs.map((page) => evaluate(page, js(() => {
          indexedDB.open = () => { throw new Error('IndexedDB disabled for fallback test'); };
          return true;
        }))));
      }
      const results = await Promise.all([first, second].map((page, index) => evaluate(page, jsWithArgs(async (content) => {
        const api = window.__LeafNoteTest;
        const state = api.getState();
        state.pages[state.currentPageId].blocks[0].content = content;
        api.saveState();
        return api._doSave({ force: true });
      }, `tab-${index + 1}`))));
      assert.equal(results.filter(Boolean).length, 1, JSON.stringify({ storageMode, results }));
      const winnerIndex = results.indexOf(true);
      const winner = [first, second][winnerIndex];
      const loser = [first, second][1 - winnerIndex];
      const persistedBefore = await evaluate(winner, js(async () => {
        const s = await window.__LeafNoteTest.loadStateAsync();
        return s.pages[s.currentPageId].blocks[0].content;
      }));
      const protectedState = await evaluate(loser, js(async () => {
        const api = window.__LeafNoteTest;
        api.flushPendingSaveOnLifecycle();
        const forcedSave = await api._doSave({ force: true });
        clearSaveStatus();
        const beforeUnload = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(beforeUnload);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const s = api.getState();
        const stored = await api.loadStateAsync();
        return {
          forcedSave,
          content: s.pages[s.currentPageId].blocks[0].content,
          stored: stored.pages[stored.currentPageId].blocks[0].content,
          status: document.querySelector('#save-status').textContent,
          statusHidden: document.querySelector('#save-status').hidden,
          closePrevented: beforeUnload.defaultPrevented
        };
      }));
      assert.equal(persistedBefore, `tab-${winnerIndex + 1}`);
      assert.equal(protectedState.stored, persistedBefore);
      assert.equal(protectedState.content, `tab-${2 - winnerIndex}`);
      assert.equal(protectedState.forcedSave, false);
      assert.equal(protectedState.statusHidden, false);
      assert.equal(protectedState.closePrevented, true);
      assert.match(protectedState.status, /HTML/);
      console.log(`ok - competing tabs preserve both edits and block stale lifecycle saves (${storageMode})`);
    }

    const errorContext = await fixture();
    const errorPage = await tab(errorContext);
    assert.equal(await seed(errorPage), true);
    const storageErrors = await evaluate(errorPage, js(async () => {
      const api = window.__LeafNoteTest;
      const originalOpen = indexedDB.open;
      const stored = JSON.parse(JSON.stringify(api.getState()));
      const results = [];
      try {
        for (const failure of ['read', 'abort', 'put']) {
          let closed = 0;
          indexedDB.open = () => {
            const request = {};
            setTimeout(() => {
              request.result = {
                close() { closed++; },
                transaction() {
                  const tx = {
                    abort() { setTimeout(() => tx.onabort?.(), 0); },
                    objectStore() {
                      return {
                        get() {
                          const read = {};
                          setTimeout(() => {
                            if (failure === 'read') {
                              read.error = new Error('read failed');
                              read.onerror?.();
                              tx.abort();
                            } else {
                              read.result = stored;
                              read.onsuccess?.();
                            }
                          }, 0);
                          return read;
                        },
                        put() {
                          if (failure === 'put') throw new DOMException('clone failed', 'DataCloneError');
                          tx.abort();
                        }
                      };
                    }
                  };
                  return tx;
                }
              };
              request.onsuccess();
            }, 0);
            return request;
          };
          api.getState().workspaceName = `failure-${failure}`;
          api.saveState();
          const saved = await Promise.race([
            api._doSave({ force: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${failure} save did not settle`)), 1500))
          ]);
          results.push({ failure, saved, closed, name: JSON.parse(localStorage.getItem('leafnote-markdown-native-v1')).workspaceName });
        }
      } finally { indexedDB.open = originalOpen; }
      return results;
    }));
    for (const result of storageErrors) {
      assert.equal(result.saved, true, result.failure);
      assert.equal(result.closed, 1, result.failure);
      assert.equal(result.name, `failure-${result.failure}`);
    }
    console.log('ok - IndexedDB read errors, aborts, and synchronous put failures close connections and reach fallback');

    const context = await fixture();
    const historyPage = await tab(context);
    assert.equal(await seed(historyPage), true);
    const history = await evaluate(historyPage, js(async () => {
      const api = window.__LeafNoteTest;
      const s = api.getState();
      s.pages[s.currentPageId].blocks[0].content = 'edited';
      api.saveState();
      await api._doSave();
      const embedded = JSON.parse(JSON.stringify(api.getState()));
      embedded.exportedAt = api.getStateRevision(embedded);
      undo();
      const dirtyImmediatelyAfterUndo = _hasUnsavedState();
      await api._doSave({ force: true });
      const undone = await api.loadStateAsync();
      redo();
      await api._doSave({ force: true });
      const redone = await api.loadStateAsync();
      undo();
      await api._doSave({ force: true });
      return {
        embedded,
        dirtyImmediatelyAfterUndo,
        undoRevision: api.getStateRevision(undone),
        redoRevision: api.getStateRevision(redone),
        editedRevision: api.getStateRevision(embedded),
        undoBody: undone.pages[undone.currentPageId].blocks[0].content,
        redoBody: redone.pages[redone.currentPageId].blocks[0].content,
        chosenBody: api.chooseStartupState(embedded, undone, null).pages[undone.currentPageId].blocks[0].content
      };
    }));
    assert.equal(history.dirtyImmediatelyAfterUndo, true);
    assert.equal(history.undoBody, 'original');
    assert.equal(history.redoBody, 'edited');
    assert.equal(history.chosenBody, 'original');
    assert.ok(history.undoRevision > history.editedRevision);
    assert.ok(history.redoRevision > history.undoRevision);
    context.embedded = history.embedded;
    const restored = await tab(context, 'export.html');
    assert.equal(await evaluate(restored, js(() => {
      const s = window.__LeafNoteTest.getState();
      return s.pages[s.currentPageId].blocks[0].content;
    })), 'original');
    console.log('ok - undo and redo stay dirty until saved and outrank exported snapshots after reopening');

    const differentContext = await fixture();
    const savedDocument = await tab(differentContext);
    assert.equal(await seed(savedDocument), true);
    differentContext.embedded = await evaluate(savedDocument, js(() => {
      const s = window.__LeafNoteTest.createInitialState();
      s.workspaceName = 'Independent export';
      s.lastModifiedAt = 1;
      Object.values(s.pages).forEach((p) => { p.createdAt = 1; p.updatedAt = 1; });
      s.pages[s.currentPageId].blocks = [window.__LeafNoteTest.blk('text', 'independent body')];
      return s;
    }));
    const imported = await tab(differentContext, 'export.html');
    const independent = await evaluate(imported, js(async () => {
      const api = window.__LeafNoteTest;
      const state = api.getState();
      const saved = await api._doSave({ force: true });
      const stored = await api.loadStateAsync();
      let blob;
      const originalCreate = URL.createObjectURL;
      const originalClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = (value) => { blob = value; return 'blob:test-conflict-export'; };
      HTMLAnchorElement.prototype.click = () => {};
      try {
        document.querySelector('#export-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        document.querySelector('#dialog-box [data-ok]').click();
        for (let i = 0; i < 100 && !blob; i++) await new Promise((resolve) => setTimeout(resolve, 20));
        const html = blob ? await blob.text() : '';
        const exported = html.match(/<script id="embedded-state"[^>]*>([\s\S]*?)<\/script>/);
        const exportedState = exported ? JSON.parse(exported[1]) : null;
        return {
          saved,
          visibleName: state.workspaceName,
          storedBody: stored.pages[stored.currentPageId].blocks[0].content,
          exportedBody: exportedState?.pages[exportedState.currentPageId].blocks[0].content,
          statusHidden: document.querySelector('#save-status').hidden
        };
      } finally {
        URL.createObjectURL = originalCreate;
        HTMLAnchorElement.prototype.click = originalClick;
      }
    }));
    assert.equal(independent.saved, false);
    assert.equal(independent.visibleName, 'Independent export');
    assert.equal(independent.storedBody, 'original');
    assert.equal(independent.exportedBody, 'independent body');
    assert.equal(independent.statusHidden, false);
    console.log('ok - an unrelated exported document opens its own content without replacing browser storage and can still export');
  } finally {
    pages.forEach((page) => page.close());
    await Promise.all(fixtures.map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  }
}

async function main() {
  const collectCoverage = mode === 'coverage';
  const browser = await launchBrowser();
  let page = null;
  let maskingerPage = null;
  let indexPage = null;
  try {
    page = await openPage(browser.port, { collectCoverage });
    const runLeafNoteUnit = mode === 'unit' || mode === 'all' || mode === 'coverage';
    const runLeafNoteIntegration = mode === 'integration' || mode === 'all' || mode === 'coverage';
    const runMaskingerUnit = runLeafNoteUnit;
    const runMaskingerIntegration = runLeafNoteIntegration;
    const runIndexIntegration = runLeafNoteIntegration;

    if (runLeafNoteUnit) await runTestGroup(page, unitTests);
    if (runLeafNoteIntegration) await runTestGroup(page, integrationTests);
    if (collectCoverage) await reportCoverage(page);
    if (runLeafNoteIntegration) await runStorageReliabilityTests(browser);

    if (runMaskingerUnit || runMaskingerIntegration) {
      maskingerPage = await openPage(browser.port, {
        url: maskingerUrl,
        readyExpression: '!!window.__MaskingerTest && !!document.querySelector("#source-input")'
      });
      if (runMaskingerUnit) await runTestGroup(maskingerPage, maskingerUnitTests);
      if (runMaskingerIntegration) await runTestGroup(maskingerPage, maskingerIntegrationTests);
    }

    if (runIndexIntegration) {
      indexPage = await openPage(browser.port, {
        url: indexUrl,
        readyExpression: 'window.__LeafNoteIndexReady === true'
      });
      await runTestGroup(indexPage, indexIntegrationTests);
    }
  } finally {
    indexPage?.close();
    maskingerPage?.close();
    page?.close();
    await stopBrowser(browser);
    await rm(browser.userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
}

main().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
