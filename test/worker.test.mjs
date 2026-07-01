import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

async function loadWorker() {
  const source = await readFile(new URL('../functions/[[path]].js', import.meta.url), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function renderHtml(env = {}) {
  const worker = await loadWorker();
  const response = await worker.default.fetch(new Request('https://gateway.example/blog?p=1'), env);
  assert.equal(response.status, 200);
  return response.text();
}

function extractMainScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const script = scripts.find(content => content.includes('async function runTests()'));
  assert.ok(script, 'main client script should be present');
  return script;
}

function createClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach(name => values.add(name)),
    remove: (...names) => names.forEach(name => values.delete(name)),
    toggle: (name, force) => {
      const shouldAdd = force ?? !values.has(name);
      if (shouldAdd) values.add(name);
      else values.delete(name);
      return shouldAdd;
    },
    contains: name => values.has(name),
  };
}

function createClientHarness() {
  let now = 0;
  let nextTimerId = 1;
  const timers = [];
  const callbacks = {};
  const elements = new Map();
  const redirects = [];

  class Element {
    constructor(id = '') {
      this.id = id;
      this.children = [];
      this.classList = createClassList();
      this.style = {};
      this.textContent = '';
      this.innerHTML = '';
      this.offsetHeight = 120;
      this.complete = true;
      this.naturalWidth = 1;
    }

    appendChild(child) {
      this.children.push(child);
      if (child.id) elements.set(child.id, child);
      for (const match of child.innerHTML.matchAll(/id="([^"]+)"/g)) {
        elements.set(match[1], new Element(match[1]));
      }
      return child;
    }

    addEventListener() {}
  }

  const body = new Element('body');
  elements.set('urlList', new Element('urlList'));
  elements.set('container', new Element('container'));
  elements.set('logoWrapper', new Element('logoWrapper'));
  elements.set('logo', new Element('logo'));
  elements.set('subtitle', new Element('subtitle'));
  elements.set('summaryLabel', new Element('summaryLabel'));
  elements.set('summaryBadge', new Element('summaryBadge'));

  function setTimeoutFake(fn, delay = 0) {
    const id = nextTimerId++;
    timers.push({ id, time: now + delay, fn, cleared: false });
    return id;
  }

  function clearTimeoutFake(id) {
    const timer = timers.find(item => item.id === id);
    if (timer) timer.cleared = true;
  }

  async function advance(ms) {
    async function flushMicrotasks() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    const target = now + ms;
    while (true) {
      timers.sort((a, b) => a.time - b.time);
      const timer = timers.find(item => !item.cleared && item.time <= target);
      if (!timer) break;
      timer.cleared = true;
      now = timer.time;
      timer.fn();
      await flushMicrotasks();
    }
    now = target;
    await flushMicrotasks();
  }

  const context = {
    AbortController,
    URL,
    console,
    performance: { now: () => now },
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0' }),
    document: {
      body,
      createElement: () => new Element(),
      getElementById: id => {
        if (!elements.has(id)) elements.set(id, new Element(id));
        return elements.get(id);
      },
      querySelector: selector => {
        if (selector === '.container') return elements.get('container');
        if (selector === '.logo-wrapper') return elements.get('logoWrapper');
        if (selector === '.logo') return elements.get('logo');
        if (selector === '.subtitle') return elements.get('subtitle');
        if (selector === '.summary-label') return elements.get('summaryLabel');
        if (selector === '.summary-badge') return elements.get('summaryBadge');
        return new Element(selector);
      },
    },
    window: {
      innerHeight: 800,
      visualViewport: null,
      matchMedia: () => ({ matches: false }),
      addEventListener: (event, callback) => {
        callbacks[event] = callback;
      },
      location: {
        replace: url => redirects.push(url),
      },
    },
    fetch: (url, options = {}) => {
      if (String(url).startsWith('https://fast.example')) {
        return new Promise(resolve => setTimeoutFake(() => resolve({ ok: true }), 50));
      }

      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };

  return { context, callbacks, redirects, advance };
}

test('worker renders the gateway page when env is omitted', async () => {
  const worker = await loadWorker();
  const response = await worker.default.fetch(new Request('https://gateway.example/'));

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /id="urlList"/);
});

test('client redirects after the first usable route without waiting for slow routes to time out', async () => {
  const html = await renderHtml({
    URL: 'https://fast.example#Fast\nhttps://slow.example#Slow',
    BEIAN: '',
  });
  const script = extractMainScript(html);
  const harness = createClientHarness();

  vm.runInNewContext(script, harness.context);
  harness.callbacks.DOMContentLoaded();
  await harness.advance(250);

  assert.deepEqual(harness.redirects, ['https://fast.example/blog?p=1']);
});
