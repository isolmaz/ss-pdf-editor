#!/usr/bin/env node
/**
 * Focused source-level regressions. No browser, PDF engine, or Vitest is emulated.
 * TypeScript (already a devDependency) only transpiles the actual modules; Node
 * assertions exercise them with explicit storage/engine boundary doubles.
 *
 * Run: node tools/audit/regressions.cjs [--root /path/to/another/checkout]
 * These checks complement, and do not replace, the full build and browser suite.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg < 0 ? path.resolve(__dirname, '../..') : path.resolve(process.argv[rootArg + 1]);
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
};
const compile = (source, fileName) => ts.transpileModule(source, { compilerOptions, fileName }).outputText;

function loader(mocks = {}) {
  const cache = new Map();
  function load(specifier, parent = path.join(ROOT, 'entry.cjs')) {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    const aliases = {
      'pdf-model': 'packages/pdf-model/src',
      'pdf-shared': 'packages/shared/src',
      'pdf-core': 'packages/pdf-core/src',
      'pdf-text-engine': 'packages/pdf-text-engine/src',
    };
    const alias = Object.keys(aliases).find((key) => specifier === key || specifier.startsWith(`${key}/`));
    let base;
    if (alias) base = path.join(ROOT, aliases[alias], specifier.slice(alias.length));
    else if (specifier.startsWith('.') || path.isAbsolute(specifier))
      base = path.resolve(path.dirname(parent), specifier);
    else return require(specifier);
    const filename = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    );
    if (!filename) throw new Error(`Cannot resolve ${specifier} from ${parent}`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = compile(fs.readFileSync(filename, 'utf8'), filename);
    const run = vm.runInThisContext(
      `(function(require,module,exports,__filename,__dirname){\n${source}\n})`,
      { filename },
    );
    run((id) => load(id, filename), module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  return load;
}

const load = loader();
const model = load('pdf-model');
const appNotices = load(path.join(ROOT, 'apps/web/src/notices.ts'));
const recentHandles = load(path.join(ROOT, 'apps/web/src/recent-handles.ts'));
const { ToolError } = load('pdf-shared');
const appPath = path.join(ROOT, 'apps/web/src/App.tsx');
const appSource = ts.createSourceFile(
  appPath,
  fs.readFileSync(appPath, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function callback(name, bindings) {
  let source;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const init = node.initializer;
      if (init && ts.isCallExpression(init)) source = init.arguments[0]?.getText(appSource);
    }
    ts.forEachChild(node, visit);
  }
  visit(appSource);
  if (!source) throw new Error(`Missing callback ${name}`);
  const code = compile(`const result = ${source};`, 'callback.ts');
  return Function(...Object.keys(bindings), `${code}\nreturn result;`)(...Object.values(bindings));
}

const results = [];
// Report detached failures too, including when auditing the original checkout.
const unhandled = [];
const recordUnhandled = (error) => unhandled.push(String(error?.stack ?? error));
process.on('unhandledRejection', recordUnhandled);
async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) });
    console.error(`FAIL ${name}: ${error?.message ?? error}`);
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const documentInput = (extra = {}) => ({
  name: 'sample.pdf',
  bytes: new Uint8Array([1, 2, 3]),
  sha256: 'source-hash',
  pageCount: 1,
  ...extra,
});
function validDraft() {
  return model.draftFor({
    id: 'draft',
    name: 'test.pdf',
    sourceKey: 'src-hash',
    pageCount: 1,
    size: 3,
    dirty: true,
    journal: [],
    now: 1,
  });
}
/**
 * A file handle. `permission` is what `queryPermission` answers (a handle read back from
 * IndexedDB says `prompt`), `asked` what the user answers when asked; without write access
 * the browser refuses to read or write, as Chromium does.
 */
function fakeFile(initial = [1, 2, 3], { permission = 'granted', asked = 'granted' } = {}) {
  let bytes = new Uint8Array(initial);
  const calls = { opened: 0, written: 0, closed: 0, aborted: 0, requests: 0 };
  let state = permission;
  const refuse = () => {
    if (state !== 'granted') throw new DOMException('no access', 'NotAllowedError');
  };
  const file = {
    name: 'selected.pdf',
    async queryPermission() {
      return state;
    },
    async requestPermission() {
      calls.requests += 1;
      state = asked;
      return state;
    },
    async getFile() {
      refuse();
      return new Blob([bytes]);
    },
    async createWritable() {
      refuse();
      calls.opened += 1;
      let pending;
      return {
        async write(value) {
          calls.written += 1;
          pending = value.slice();
        },
        async close() {
          calls.closed += 1;
          bytes = pending;
        },
        async abort() {
          calls.aborted += 1;
        },
      };
    },
  };
  return {
    file,
    calls,
    bytes: () => bytes,
    replace: (value) => {
      bytes = new Uint8Array(value);
    },
  };
}
async function saveHarness({ target, picker, prepare, saveAs = false } = {}) {
  const store = new model.SessionStore();
  const bytes = new Uint8Array([1, 2, 3]);
  // In-place saves start from a document that already has its file; Save As starts from one
  // that does not, which is what makes the picker (and the destination baseline) matter.
  const sourceHandle = saveAs ? undefined : target?.file;
  const tab = store.openDocument(
    documentInput({
      bytes,
      sha256: await model.sha256Hex(bytes),
      ...(sourceHandle === undefined ? {} : { handle: sourceHandle }),
    }),
  );
  store.setOverlays(tab.id, { annotations: ['edit'] }, 'ann.engineEdit');
  const notices = [];
  const downloads = [];
  const saveLock = { current: false };
  const busyRef = { current: false };
  const bindings = {
    store,
    saveLock,
    isBusy: () => busyRef.current,
    ToolError,
    AbortController,
    window: picker ? { showSaveFilePicker: picker } : {},
    cancelRef: { current: null },
    refuseBusy: () => notices.push('busy'),
    showNotice: (value) => notices.push(value),
    clearNotice: () => notices.push(null),
    setBusy: (value) => {
      busyRef.current = value;
    },
    t: (key) => key,
    sha256Hex: model.sha256Hex,
    ensureWriteAccess: recentHandles.ensureWriteAccess,
    downloadFiles: (files) => downloads.push(...files),
    // The save path words its notices with the app's own helpers; binding the real
    // functions keeps the harness honest about what the user would read.
    noticeLine: appNotices.noticeLine,
    verificationNotices: appNotices.verificationNotices,
    prepareOutput: async () => {
      if (prepare) return prepare(store);
      const current = store.active;
      const output = new Uint8Array([4, 5, 6]);
      return {
        tab: current,
        bytes: output,
        outputProtection: { encrypted: false },
        outputHash: await model.sha256Hex(output),
        execution: { steps: [], appliedSteps: [], plan: { incremental: false } },
        verification: { state: 'verified', checks: [], declared: [] },
      };
    },
  };
  return {
    run: callback('saveActive', bindings),
    store,
    tab,
    notices,
    downloads,
    saveLock,
    busyRef,
    bindings,
  };
}

function swHarness({ online = true, cacheFailure = false } = {}) {
  const handlers = new Map();
  const cached = new Map();
  const deleted = [];
  const requests = [];
  const cache = {
    async match(request) {
      return cached.get(typeof request === 'string' ? request : request.url)?.clone();
    },
    async put(request, response) {
      if (cacheFailure) throw new Error('quota');
      cached.set(typeof request === 'string' ? request : request.url, response.clone());
    },
    async keys() {
      return [...cached.keys()].map((url) => ({ url: new URL(url, 'https://local.test').href }));
    },
    async addAll(urls) {
      for (const url of urls) await cache.put(url, await context.fetch(url));
    },
  };
  const context = {
    URL,
    Request,
    Response,
    Headers,
    console,
    self: {
      location: { origin: 'https://local.test' },
      addEventListener: (kind, fn) => handlers.set(kind, fn),
      clients: { claim: async () => {} },
      skipWaiting: async () => {},
    },
    caches: {
      open: async () => cache,
      match: cache.match,
      keys: async () => ['another-app-v1', 'pdf-editor-static-old', 'pdf-editor-static-v1'],
      delete: async (key) => {
        deleted.push(key);
        return true;
      },
    },
    fetch: async (request) => {
      const url = typeof request === 'string' ? request : request.url;
      requests.push(url);
      if (!online) throw new Error('offline');
      // The build's manifest is what the worker reads before it is willing to cache
      // anything: only paths listed there may enter the static cache.
      if (String(url).includes('/offline-manifest.json')) {
        return new Response(
          JSON.stringify({
            version: 'v1',
            capabilities: {
              core: ['/engines/core.js'],
              app: ['/editor/assets/index-1.js', '/editor/assets/pdf-1.js'],
            },
            shell: ['/editor/assets/en-1.js', 'https://remote.test/x.js', '/elsewhere/tr.js'],
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response('network');
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8'), context, {
    filename: 'public/sw.js',
  });
  function dispatch(kind, fields = {}) {
    const lifetimes = [];
    let response;
    handlers.get(kind)({
      ...fields,
      waitUntil: (work) => lifetimes.push(work),
      respondWith: (work) => {
        response = work;
      },
    });
    return { lifetimes, response: () => response };
  }
  return { dispatch, cached, deleted, requests };
}

async function main() {
  await check('Save As writes a newly selected empty file', async () => {
    const target = fakeFile([]);
    const h = await saveHarness({ picker: async () => target.file, saveAs: true });
    assert.equal(await h.run(), true);
    assert.deepEqual([...target.bytes()], [4, 5, 6]);
    assert.equal(h.store.active.source.handle, target.file);
  });
  await check('save keeps external-change conflict protection for the existing file', async () => {
    const target = fakeFile([9]);
    const h = await saveHarness({ target });
    assert.equal(await h.run(), false);
    assert.equal(target.calls.opened, 0);
    assert.equal(h.store.active.dirty, true);
    assert.ok(h.notices.some((notice) => String(notice).includes('conflict')));
  });
  await check(
    'an in-place save over a handle read back from storage asks for write access first',
    async () => {
      const target = fakeFile([1, 2, 3], { permission: 'prompt' });
      const h = await saveHarness({ target });
      assert.equal(await h.run(), true);
      assert.equal(target.calls.requests, 1);
      assert.deepEqual([...target.bytes()], [4, 5, 6]);
      // Granted once, it is not asked again.
      h.store.setOverlays(h.tab.id, { annotations: ['again'] }, 'ann.engineEdit');
      assert.equal(await h.run(), true);
      assert.equal(target.calls.requests, 1);
    },
  );
  await check('a refused write permission writes nothing and says why', async () => {
    const target = fakeFile([1, 2, 3], { permission: 'prompt', asked: 'denied' });
    const h = await saveHarness({ target });
    assert.equal(await h.run(), false);
    assert.equal(target.calls.opened, 0);
    assert.deepEqual([...target.bytes()], [1, 2, 3]);
    assert.equal(h.store.active.dirty, true);
    assert.ok(h.notices.some((notice) => String(notice).includes('error.permission-denied.message')));
  });
  await check(
    'marking a document sensitive, or purging it, forgets the handle that reopens its file',
    async () => {
      for (const name of ['toggleSensitiveSession', 'purgeActiveDocument']) {
        const store = new model.SessionStore();
        const tab = store.openDocument(documentInput());
        const forgotten = [];
        const bindings = {
          activeTab: tab,
          store,
          channel: { runExclusive: (work) => work() },
          draftWrites: { current: Promise.resolve() },
          forgetTabDraft: async () => [],
          deleteRecentHandle: async (id) => {
            forgotten.push(id);
          },
          showNotice: () => {},
          t: (key) => key,
          ToolError,
        };
        await callback(name, bindings)();
        await bindings.draftWrites.current;
        assert.deepEqual(forgotten, [tab.id], name);
      }
    },
  );
  await check('a failed Save As does not attach an unwritten destination', async () => {
    const target = fakeFile([]);
    const h = await saveHarness({ picker: async () => target.file, prepare: async () => null, saveAs: true });
    assert.equal(await h.run(), false);
    assert.equal(h.store.active.source.handle, undefined);
  });
  await check('save lock covers the native picker await', async () => {
    let pick;
    let count = 0;
    const target = fakeFile([]);
    const h = await saveHarness({
      picker: () => {
        count += 1;
        return new Promise((resolve) => {
          pick = resolve;
        });
      },
      saveAs: true,
    });
    const first = h.run();
    await tick();
    assert.equal(h.saveLock.current, true);
    assert.equal(await h.run(), false);
    assert.equal(count, 1);
    pick(target.file);
    await first;
    assert.equal(h.saveLock.current, false);
  });
  await check('save commits the prepared state rather than an obsolete captured state', async () => {
    const h = await saveHarness();
    h.bindings.prepareOutput = async () => {
      h.store.setOverlays(h.tab.id, { annotations: ['newer'] }, 'ann.engineEdit');
      return {
        tab: h.store.active,
        bytes: new Uint8Array([4]),
        outputProtection: { encrypted: false },
        outputHash: 'hash',
        execution: { steps: [], appliedSteps: [], plan: { incremental: false } },
        verification: { state: 'verified', checks: [], declared: [] },
      };
    };
    const save = callback('saveActive', h.bindings);
    assert.equal(await save(), true);
    assert.equal(h.store.active.dirty, false);
    assert.equal(h.store.active.outputs[0].fromWorkingVersion, h.store.active.working.id);
  });
  await check('picker cancellation releases the save lock without writing', async () => {
    const h = await saveHarness({
      picker: async () => {
        throw new DOMException('cancelled', 'AbortError');
      },
      saveAs: true,
    });
    assert.equal(await h.run(), false);
    assert.equal(h.saveLock.current, false);
    assert.equal(h.busyRef.current, false);
    assert.equal(h.downloads.length, 0);
  });

  await check('malformed draft page counts are rejected', () => {
    // The model accepts a non-negative safe integer (`isCount`, shared with `size`, `seq`
    // and `timestamp`); anything that is not a count at all cannot name a document.
    for (const pageCount of [-1, 1.5, NaN, Infinity, '2', null])
      assert.equal(model.parseDraft({ ...validDraft(), pageCount }), null);
  });
  await check('malformed journal entries are rejected rather than shifting the cursor', () => {
    assert.equal(model.parseDraft({ ...validDraft(), journal: [null], journalCursor: 1 }), null);
  });
  await check('out-of-bounds and fractional journal cursors are rejected', () => {
    for (const journalCursor of [-1, 0.5, 1, NaN])
      assert.equal(model.parseDraft({ ...validDraft(), journalCursor }), null);
  });
  await check('valid draft JSON round trip preserves data', () => {
    const draft = validDraft();
    const parsed = model.parseDraft(JSON.parse(JSON.stringify(draft)));
    assert.equal(parsed.id, draft.id);
    assert.equal(parsed.journalCursor, 0);
    assert.equal(parsed.sourceKey, draft.sourceKey);
  });
  await check('draft encoder rejects typed arrays instead of changing their representation', async () => {
    const result = await model.encodeEngineValues([['field', { bytes: new Uint8Array([1, 2]) }]]);
    assert.equal(result.dropped, 1);
    assert.equal(result.entries.length, 0);
  });
  await check('draft encoder does not consume the next entry budget when dropping an entry', async () => {
    const result = await model.encodeEngineValues(
      [
        ['bad', { bitmap: new Blob(['1234']), unsupported: () => {} }],
        ['good', { bitmap: new Blob(['1234']) }],
      ],
      4,
    );
    assert.equal(result.dropped, 1);
    assert.equal(result.entries[0]?.key, 'good');
  });
  await check('draft engine values preserve plain values and Blob payloads', async () => {
    const encoded = await model.encodeEngineValues([
      ['field', { value: 'Merhaba', bitmap: new Blob(['abc'], { type: 'text/plain' }) }],
    ]);
    const decoded = model.decodeEngineValues(encoded);
    assert.equal(decoded[0][1].value, 'Merhaba');
    assert.equal(await decoded[0][1].bitmap.text(), 'abc');
  });
  await check('journal snapshots remain stable after subsequent appends', () => {
    const journal = new model.OperationJournal();
    journal.append({ labelKey: 'first', engine: 'model', op: { kind: 'x', payload: null } });
    const snapshot = journal.toJSON();
    journal.append({ labelKey: 'second', engine: 'model', op: { kind: 'x', payload: null } });
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.cursor, 1);
  });
  await check('branching discards obsolete PDF snapshots before budget eviction', () => {
    const store = new model.SessionStore();
    const tab = store.openDocument(documentInput());
    const apply = () =>
      store.applyOperation({
        tabId: tab.id,
        bytes: new Uint8Array(23 * 1024 * 1024),
        pageCount: 1,
        labelKey: 'ann.engineEdit',
        engine: 'test',
        steps: [],
        overlays: null,
      });
    const first = apply();
    apply();
    apply();
    store.undo(tab.id);
    store.undo(tab.id);
    const replacement = apply();
    assert.deepEqual(
      store.snapshotsFor(tab.id).map((item) => item.id),
      [first.id, replacement.id],
    );
    const result = store.undo(tab.id);
    assert.equal(result.step.kind, 'document');
    assert.equal(result.step.produced.id, first.id);
  });
  await check('overlay edits discard abandoned redo snapshot bytes', () => {
    const store = new model.SessionStore();
    const tab = store.openDocument(documentInput());
    store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([2]),
      pageCount: 1,
      labelKey: 'ann.engineEdit',
      engine: 'test',
      steps: [],
      overlays: null,
    });
    store.undo(tab.id);
    store.setOverlays(tab.id, { annotations: [] }, 'ann.engineEdit');
    assert.equal(store.snapshotsFor(tab.id).length, 0);
  });

  await check('offline hard refresh without a cache produces an HTTP 503 response', async () => {
    const h = swHarness({ online: false });
    const event = h.dispatch('fetch', {
      request: { method: 'GET', url: 'https://local.test/editor/missing.js', cache: 'reload', mode: 'cors' },
    });
    const response = await event.response();
    assert.equal(response.status, 503);
  });
  await check('offline hard refresh preserves cached content and isolation', async () => {
    const h = swHarness({ online: false });
    const url = 'https://local.test/editor/';
    h.cached.set(url, new Response('cached'));
    const event = h.dispatch('fetch', { request: { method: 'GET', url, cache: 'reload', mode: 'navigate' } });
    const response = await event.response();
    assert.equal(await response.text(), 'cached');
    assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  });
  await check('service-worker activation preserves other applications caches', async () => {
    const h = swHarness();
    const event = h.dispatch('activate');
    await Promise.all(event.lifetimes);
    assert.equal(h.deleted.includes('another-app-v1'), false);
    assert.equal(h.deleted.includes('pdf-editor-static-old'), true);
  });
  /** One request/response with the worker, as the page makes it: the reply arrives on the port. */
  async function askWorker(h, data) {
    const messages = [];
    const event = h.dispatch('message', {
      data,
      ports: [{ postMessage: (message) => messages.push(message) }],
    });
    await Promise.all(event.lifetimes);
    await tick();
    return messages[0];
  }
  const fetchedBeyondManifest = (h) =>
    h.requests.filter((url) => !String(url).includes('/offline-manifest.json'));
  await check('offline preparation takes capability names, never a page-supplied URL', async () => {
    const h = swHarness();
    const reply = await askWorker(h, {
      type: 'PREPARE_PACKAGE',
      capabilities: ['app', 'unknown', { bad: true }],
      urls: ['https://remote.test/x.js', '/engines/core.js'],
    });
    // The worker reads the build's manifest first and resolves the names against it: a
    // page-supplied URL, cross-origin or not, must never reach the fetch loop, and a name the
    // manifest does not have asks for nothing.
    assert.deepEqual(fetchedBeyondManifest(h), ['/editor/assets/index-1.js', '/editor/assets/pdf-1.js']);
    assert.equal(reply.count, 2);
  });
  await check('offline preparation without names fills every capability of the manifest', async () => {
    const h = swHarness();
    const reply = await askWorker(h, { type: 'PREPARE_PACKAGE' });
    assert.deepEqual(fetchedBeyondManifest(h), [
      '/engines/core.js',
      '/editor/assets/index-1.js',
      '/editor/assets/pdf-1.js',
    ]);
    assert.equal(reply.count, 3);
  });
  await check(
    'readiness requires every chunk of the editor build until preparation has cached it',
    async () => {
      const h = swHarness();
      const before = await askWorker(h, { type: 'CHECK_READINESS' });
      // A first visit holds the shell and the engines it was handed, not the tool chunks it never
      // opened: saying "ready" there is the failure this capability exists to prevent.
      // The reply was built inside the worker's own realm: compare it as data.
      const plain = (value) => JSON.parse(JSON.stringify(value));
      assert.deepEqual(plain(before.capabilities.app), {
        ready: false,
        missing: ['/editor/assets/index-1.js', '/editor/assets/pdf-1.js'],
      });
      await askWorker(h, { type: 'PREPARE_PACKAGE', capabilities: ['app'] });
      const after = await askWorker(h, { type: 'CHECK_READINESS' });
      assert.deepEqual(plain(after.capabilities.app), { ready: true, missing: [] });
      assert.equal(after.capabilities.core.ready, false);
    },
  );
  await check('service-worker install caches the shell and its catalogues, only from the build', async () => {
    const h = swHarness();
    const event = h.dispatch('install');
    await Promise.all(event.lifetimes);
    // A language is a run-time chunk the HTML crawl never names: without it an offline
    // reload paints raw message keys. Only the manifest's `/editor/assets/` paths are taken.
    assert.ok(h.cached.has('/editor/index.html'));
    assert.ok(h.cached.has('/editor/assets/en-1.js'));
    assert.equal(h.requests.includes('https://remote.test/x.js'), false);
    assert.equal(h.requests.includes('/elsewhere/tr.js'), false);
  });
  await check('message work extends the service-worker lifetime', async () => {
    const h = swHarness();
    const event = h.dispatch('message', { data: { type: 'CHECK_READINESS' }, ports: [] });
    assert.ok(event.lifetimes.length > 0);
    await Promise.all(event.lifetimes);
  });

  async function draftHarness({
    sensitive = false,
    failWrite = false,
    queue = Promise.resolve(),
    gate = null,
    onPutSource = null,
  } = {}) {
    const store = new model.SessionStore();
    const tab = store.openDocument(documentInput());
    store.setOverlays(tab.id, { annotations: ['pending'] }, 'ann.engineEdit');
    if (sensitive) store.setSensitive(tab.id, true);
    const drafts = new Map();
    const sources = new Map();
    const notices = [];
    const writeStarts = [];
    const storage = {
      async putSource(key, bytes) {
        sources.set(key, bytes);
        onPutSource?.(store);
      },
      async deleteSource(key) {
        sources.delete(key);
      },
      async writeDraft(draft) {
        writeStarts.push(draft.id);
        if (gate) await gate;
        if (failWrite) throw new Error('quota');
        drafts.set(draft.id, JSON.parse(JSON.stringify(draft)));
      },
      async deleteDraft(id) {
        drafts.delete(id);
      },
    };
    // The manual save runs the *shared* persistence callback: the harness builds
    // that callback from the same source the app calls, then the `opfsSave` command over it.
    const persistBindings = {
      store,
      tier: 'desktop',
      handleFor: (id) => new Map([[tab.id, { raw: {} }]]).get(id),
      draftStorage: storage,
      persistedSnapshots: { current: new Map() },
      forgetTabDraft: async (id) => {
        drafts.delete(id);
        for (const key of [...sources.keys()]) sources.delete(key);
        return [];
      },
      retainedSnapshotsFor: (candidate) => store.snapshotsFor(candidate.id),
      draftFor: model.draftFor,
      encodeEngineValues: model.encodeEngineValues,
      sourceKeyFor: model.sourceKeyFor,
      workingPageCount: model.workingPageCount,
      ToolError,
    };
    const persistTabDraft = callback('persistTabDraft', persistBindings);
    const bindings = {
      activeTab: store.active,
      store,
      draftWrites: { current: queue },
      persistTabDraft,
      ToolError,
      showNotice: (notice) => notices.push(notice),
      t: (key) => key,
    };
    return {
      run: callback('opfsSave', bindings),
      persist: persistTabDraft,
      persisted: persistBindings.persistedSnapshots,
      writeStarts,
      queue: bindings.draftWrites,
      sources,
      drafts,
      notices,
      store,
      tab,
    };
  }
  await check('manual browser save persists the exact source key referenced by the draft', async () => {
    const h = await draftHarness();
    await h.run();
    const draft = h.drafts.get(h.tab.id);
    assert.ok(draft);
    assert.ok(h.sources.has(draft.sourceKey), `missing source ${draft.sourceKey}`);
    assert.deepEqual([...h.sources.get(draft.sourceKey)], [1, 2, 3]);
  });
  await check('manual browser save respects sensitive-session persistence opt-out', async () => {
    const h = await draftHarness({ sensitive: true });
    await h.run();
    assert.equal(h.drafts.size, 0);
    assert.equal(h.sources.size, 0);
  });
  await check('manual browser save reports storage failures', async () => {
    const h = await draftHarness({ failWrite: true });
    await h.run();
    assert.ok(h.notices.some((notice) => String(notice).includes('write-failed')));
  });
  await check('manual browser save waits for the shared draft-write queue', async () => {
    let release;
    const queue = new Promise((resolve) => {
      release = resolve;
    });
    const h = await draftHarness({ queue });
    const pending = h.run();
    await tick();
    const wroteEarly = h.drafts.size > 0;
    release();
    await pending;
    assert.equal(wroteEarly, false);
    assert.equal(h.drafts.size, 1);
  });

  // The manual-save check above runs the `opfsSave` guard (its captured tab is already
  // sensitive); the shared persistence callback the automatic save uses is driven here.
  await check(
    'persistence refuses a sensitive document and removes what an earlier session stored',
    async () => {
      const h = await draftHarness({ sensitive: true });
      h.drafts.set(h.tab.id, { stale: true });
      h.sources.set('src-earlier', new Uint8Array([1]));
      assert.equal(await h.persist(h.tab.id), 'sensitive');
      assert.equal(h.drafts.size, 0);
      assert.equal(h.sources.size, 0);
      assert.deepEqual(h.writeStarts, [], 'a sensitive document must never reach the vault, even briefly');
    },
  );
  await check(
    'persistence removes the manifest of a document marked sensitive while it was written',
    async () => {
      const h = await draftHarness({ onPutSource: (store) => store.setSensitive(store.active.id, true) });
      assert.equal(await h.persist(h.tab.id), 'sensitive');
      assert.equal(h.drafts.size, 0);
    },
  );
  await check('persistence drops the snapshot blobs the new manifest no longer references', async () => {
    const h = await draftHarness();
    h.sources.set('snapshot-old', new Uint8Array([9]));
    h.persisted.current.set(h.tab.id, ['snapshot-old']);
    assert.equal(await h.persist(h.tab.id), 'written');
    assert.equal(h.sources.has('snapshot-old'), false);
    assert.ok(h.sources.has(h.drafts.get(h.tab.id).sourceKey));
  });
  await check('manual saves queue behind each other, including after one has failed', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = await draftHarness({ gate });
    const first = h.run();
    await tick();
    const second = h.run();
    await tick();
    assert.equal(h.writeStarts.length, 1, 'the second save started before the first finished');
    release();
    await Promise.all([first, second]);
    assert.equal(h.writeStarts.length, 2);
    const failing = await draftHarness({ failWrite: true });
    await failing.run();
    assert.ok(failing.notices.some((notice) => String(notice).includes('write-failed')));
    // The queue's own copy swallowed the failure: the next link must still run.
    await assert.doesNotReject(failing.queue.current);
  });
  await check('draft recovery does not rerun when only the UI language changes', async () => {
    let effect;
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useEffect' &&
        node.arguments[0]?.getText(appSource).includes('const drafts = sortDrafts')
      )
        effect = node.getText(appSource);
      ts.forEachChild(node, visit);
    }
    visit(appSource);
    assert.ok(effect);
    let previous;
    let cleanup;
    let reads = 0;
    const pruned = [];
    const bindings = {
      // The effect forgets the file handles of recent entries that are gone, after the restore.
      loadRecentDocuments: () => [{ id: 'kept' }],
      pruneRecentHandles: async (keep) => {
        pruned.push([...keep]);
      },
      draftStorage: {
        readDraftInventory: async () => {
          reads += 1;
          return { drafts: [], unreadable: [] };
        },
      },
      store: new model.SessionStore(),
      t: () => 'en',
      restoreTranslator: { current: () => 'en' },
      sortDrafts: model.sortDrafts,
      useEffect: (run, dependencies) => {
        if (!previous || dependencies.some((value, index) => value !== previous[index])) {
          cleanup?.();
          previous = dependencies;
          cleanup = run();
        }
      },
    };
    const code = compile(effect, 'effect.ts');
    const render = () => Function(...Object.keys(bindings), code)(...Object.values(bindings));
    render();
    await tick();
    bindings.t = () => 'tr';
    bindings.restoreTranslator.current = bindings.t;
    render();
    await tick();
    cleanup?.();
    assert.equal(reads, 1);
    assert.deepEqual(pruned, [['kept']]);
  });
  await check('a single unreadable OPFS draft does not stop other draft recovery', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const directory = {
      async getDirectoryHandle() {
        return this;
      },
      async *entries() {
        yield ['bad.json'];
        yield ['good.json'];
      },
      async getFileHandle(name) {
        return {
          async getFile() {
            if (name === 'bad.json') throw new Error('unreadable');
            return new Blob([JSON.stringify(validDraft())]);
          },
        };
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { storage: { getDirectory: async () => directory } },
    });
    try {
      const storage = load(path.join(ROOT, 'apps/web/src/drafts.ts')).createOpfsDraftStorage();
      const inventory = await storage.readDraftInventory();
      assert.equal(inventory.drafts.length, 1);
      assert.deepEqual(inventory.unreadable, ['bad.json']);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete globalThis.navigator;
    }
  });
  await check('an OPFS write failure aborts its writable stream', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let aborted = false;
    const directory = {
      async getDirectoryHandle() {
        return this;
      },
      async getFileHandle() {
        return {
          async createWritable() {
            return {
              async write() {
                throw new Error('quota');
              },
              async close() {},
              async abort() {
                aborted = true;
              },
            };
          },
        };
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { storage: { getDirectory: async () => directory } },
    });
    try {
      const storage = load(path.join(ROOT, 'apps/web/src/drafts.ts')).createOpfsDraftStorage();
      await assert.rejects(storage.writeDraft(validDraft()), /quota/);
      assert.equal(aborted, true);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete globalThis.navigator;
    }
  });

  function pdfjsHarness(reason) {
    let opens = 0;
    let destroyed = 0;
    let copied;
    const module = {
      GlobalWorkerOptions: {},
      VerbosityLevel: { WARNINGS: 1 },
      getDocument(options) {
        opens += 1;
        copied = options.data;
        let reject;
        const task = {
          promise: new Promise((resolve, fail) => {
            reject = fail;
            if (reason === undefined) resolve({ numPages: 1, fingerprints: ['fp'] });
          }),
          async destroy() {
            destroyed += 1;
          },
        };
        if (reason !== undefined)
          queueMicrotask(() => {
            const error = Object.assign(new Error('engine error'), {
              name: reason === 'corrupt' ? 'InvalidPDFException' : 'PasswordException',
              code: reason === 'wrong' ? 2 : 1,
            });
            if (reason === 'corrupt') {
              reject(error);
              return;
            }
            // pdf.js settles the loading task through the callback it hands to `onPassword`
            // (`PasswordRequest`): a string is another attempt, an `Error` rejects the load.
            // A double that accepts the value and never settles the task would model the
            // engine wrong and make every password path look like a hang.
            task.onPassword((value) => {
              reject(
                value instanceof Error
                  ? value
                  : Object.assign(new Error('the supplied password was refused'), {
                      name: 'PasswordException',
                      code: 2,
                    }),
              );
            }, error.code);
          });
        return task;
      },
    };
    const fresh = loader({ 'pdfjs-dist': module });
    return {
      open: fresh(path.join(ROOT, 'packages/pdf-core/src/engines/pdfjs-handle.ts')).openWithPdfjs,
      opens: () => opens,
      destroyed: () => destroyed,
      copied: () => copied,
    };
  }
  for (const [reason, code] of [
    ['needed', 'password-required'],
    ['wrong', 'wrong-password'],
  ]) {
    await check(`PDF loading settles ${code} rather than waiting forever`, async () => {
      const h = pdfjsHarness(reason);
      let timer;
      const result = await Promise.race([
        h.open(new Uint8Array([1]), reason === 'wrong' ? { password: 'incorrect' } : {}).then(
          () => 'opened',
          (error) => error.code,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('hung'), 80);
        }),
      ]);
      clearTimeout(timer);
      assert.equal(result, code);
      assert.equal(h.destroyed(), 1);
    });
  }
  await check('failed PDF loading destroys the task and preserves its mapped error', async () => {
    const h = pdfjsHarness('corrupt');
    await assert.rejects(h.open(new Uint8Array([1])), (error) => error.code === 'corrupt-document');
    assert.equal(h.destroyed(), 1);
  });
  await check('aborting during lazy engine loading prevents document creation', async () => {
    const h = pdfjsHarness();
    const controller = new AbortController();
    const pending = h.open(new Uint8Array([1]), { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.code === 'aborted');
    assert.equal(h.opens(), 0);
  });
  await check('successful PDF loading still receives a disposable copy of source bytes', async () => {
    const h = pdfjsHarness();
    const bytes = new Uint8Array([1, 2, 3]);
    const handle = await h.open(bytes);
    assert.equal(handle.pageCount, 1);
    assert.notEqual(h.copied(), bytes);
    assert.deepEqual(h.copied(), bytes);
    await handle.destroy();
  });
  await check('OCR cleanup waits for worker termination to complete', async () => {
    let finish;
    const worker = {
      recognize: async () => ({ data: { blocks: [], confidence: 100 } }),
      terminate: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const fresh = loader({
      '/engines/tesseract/tesseract.esm.min.js': {
        __esModule: true,
        default: { createWorker: async () => worker },
      },
    });
    const engine = fresh(path.join(ROOT, 'packages/pdf-core/src/engines/tesseract.ts'));
    await engine.recognizePage({
      image: new Blob(['test']),
      scale: 1,
      languages: ['eng'],
      quality: 'fast',
      signal: new AbortController().signal,
    });
    let done = false;
    const pending = engine.terminateOcrWorkers().then(() => {
      done = true;
    });
    await tick();
    const returnedEarly = done;
    finish();
    await pending;
    assert.equal(returnedEarly, false);
  });
  await check('service-worker cache-write failures do not discard a network response', async () => {
    const h = swHarness({ cacheFailure: true });
    const event = h.dispatch('fetch', {
      request: { method: 'GET', url: 'https://local.test/editor/main.js', cache: 'default', mode: 'cors' },
    });
    assert.equal(await (await event.response()).text(), 'network');
    await Promise.all(event.lifetimes);
  });

  function preparationHarness(pending = true, options = {}) {
    const {
      output = new Uint8Array([1, 2, 3]),
      signed = false,
      confirm = async () => true,
      facts = 'current',
      forms = [],
    } = options;
    const store = new model.SessionStore();
    const tab = store.openDocument(documentInput());
    store.setOverlays(
      tab.id,
      {
        annotations: [],
        measures: [],
        redactions: pending ? [{ id: 'mark', mark: { pageIndex: 0, x: 0, y: 0, width: 1, height: 1 } }] : [],
      },
      'panel.redaction',
    );
    const handle = { getOutline: async () => [], raw: { getPageLabels: async () => null } };
    let materialized = 0;
    const notices = [];
    const asked = [];
    const confirmations = [];
    const verifyCalls = [];
    const bindings = {
      store,
      handleFor: (id) => new Map([[tab.id, handle]]).get(id),
      ToolError,
      currentFacts: () => (facts === 'current' ? { tabId: tab.id, version: store.active.working.id } : null),
      currentForms: { tabId: tab.id, version: store.active.working.id },
      formFields: forms,
      currentFactsError: () => null,
      showNotice: (notice) => notices.push(notice),
      t: (key) => key,
      pendingOverlays: (tab) => tab.working.overlays,
      editableOverlays: (tab) => tab.working.overlays,
      contextFor: (tab, handle) => ({ tab, handle }),
      materializeBase: async (_context, _options, steps) => {
        materialized += 1;
        steps.push({ id: 'pdfjs.saveDocument', engine: 'pdfjs', note: 'engine save' });
        return output;
      },
      inspectProtection: async () => ({ encrypted: false }),
      hasEngineEdits: () => false,
      planSaveExecution: () => ({ plan: { incremental: false }, steps: [], appliedSteps: [] }),
      // The real decision (`save-plan.ts`): with no signatures it asks for no
      // confirmation, which is the path this regression drives.
      decideSignatureWarning: load(path.join(ROOT, 'apps/web/src/save-plan.ts')).signatureWarning,
      appliedVersionBytes: load(path.join(ROOT, 'apps/web/src/save-plan.ts')).appliedVersionBytes,
      verifySignatures: async (bytes) => {
        asked.push(bytes);
        return signed ? ['sig'] : [];
      },
      confirmSignature: async (signatures, appended) => {
        confirmations.push({ signatures, appended });
        return confirm(store);
      },
      trustStore: { get: () => ({ rootBytes: [] }) },
      verifyForWrite: async (_bytes, verifyOptions) => {
        verifyCalls.push(verifyOptions);
        return { state: 'verified', checks: [], declared: [] };
      },
      sha256Hex: model.sha256Hex,
      workingPageCount: model.workingPageCount,
    };
    return {
      run: callback('prepareOutput', bindings),
      tab,
      store,
      materialized: () => materialized,
      notices,
      asked,
      confirmations,
      verifyCalls,
    };
  }
  await check('Save/Export preparation rejects unapplied redaction marks', async () => {
    const h = preparationHarness();
    // The guard is the whole point: the output path must refuse before it materializes
    // bytes, and it must tell the user why (a silent `null` would hide the refusal).
    assert.equal(await h.run(h.tab.id, new AbortController()), null);
    assert.equal(h.materialized(), 0);
    assert.ok(h.notices.some((notice) => String(notice).includes('pending-redactions')));
  });
  await check('Save/Export preparation still accepts a document without pending redactions', async () => {
    const h = preparationHarness(false);
    assert.ok(await h.run(h.tab.id, new AbortController()));
    assert.equal(h.materialized(), 1);
  });
  await check('Save/Export preparation waits for the document facts instead of materializing', async () => {
    const h = preparationHarness(false, { facts: 'stale' });
    assert.equal(await h.run(h.tab.id, new AbortController()), null);
    assert.equal(h.materialized(), 0);
    assert.ok(h.notices.some((notice) => String(notice).includes('inspection')));
    // Facts for this version but no form inventory yet: the same refusal.
    const noForms = preparationHarness(false, { forms: null });
    assert.equal(await noForms.run(noForms.tab.id, new AbortController()), null);
    assert.equal(noForms.materialized(), 0);
  });
  await check('Save/Export preparation verifies the output against the steps this run executed', async () => {
    const h = preparationHarness(false);
    assert.ok(await h.run(h.tab.id, new AbortController()));
    assert.deepEqual(h.verifyCalls[0].steps, ['pdfjs.saveDocument']);
    assert.equal(h.verifyCalls[0].expectedPageCount, 1);
  });
  await check('Save/Export preparation confirms before rewriting a signed opened file', async () => {
    const declined = preparationHarness(false, {
      signed: true,
      output: new Uint8Array([9, 9, 9]),
      confirm: async () => false,
    });
    assert.equal(await declined.run(declined.tab.id, new AbortController()), null);
    assert.deepEqual(declined.confirmations, [{ signatures: ['sig'], appended: false }]);
    // The signatures were read from the bytes the session opened, not from the output.
    assert.deepEqual([...declined.asked[0]], [1, 2, 3]);
    const accepted = preparationHarness(false, { signed: true, output: new Uint8Array([9, 9, 9]) });
    assert.ok(await accepted.run(accepted.tab.id, new AbortController()));
  });
  await check(
    'Save/Export preparation tells an appended revision from a rewrite, and stays quiet otherwise',
    async () => {
      const appended = preparationHarness(false, { signed: true, output: new Uint8Array([1, 2, 3, 4]) });
      assert.ok(await appended.run(appended.tab.id, new AbortController()));
      assert.deepEqual(appended.confirmations, [{ signatures: ['sig'], appended: true }]);
      const unchanged = preparationHarness(false, { signed: true });
      assert.ok(await unchanged.run(unchanged.tab.id, new AbortController()));
      assert.deepEqual(unchanged.confirmations, []);
      const unsigned = preparationHarness(false, { output: new Uint8Array([9, 9, 9]) });
      assert.ok(await unsigned.run(unsigned.tab.id, new AbortController()));
      assert.deepEqual(unsigned.confirmations, []);
    },
  );
  await check(
    'Save/Export preparation drops a result the document outgrew while the user was asked',
    async () => {
      const h = preparationHarness(false, {
        signed: true,
        output: new Uint8Array([9, 9, 9]),
        confirm: async (store) => {
          store.setOverlays(
            store.active.id,
            { annotations: ['newer'], measures: [], redactions: [] },
            'ann.engineEdit',
          );
          return true;
        },
      });
      assert.equal(await h.run(h.tab.id, new AbortController()), null);
    },
  );
  function discardHarness({ unreadable = false, enumerationFailed = false, shared = false } = {}) {
    const store = new model.SessionStore();
    const tab = store.openDocument(documentInput());
    const sourceKey = model.sourceKeyFor(tab.id, tab.source.sha256);
    const deleted = [];
    const notices = [];
    const inventory = {
      drafts: [
        { ...validDraft(), id: tab.id, sourceKey },
        ...(shared ? [{ ...validDraft(), id: 'other', sourceKey }] : []),
      ],
      unreadable: unreadable ? ['damaged.json'] : [],
      enumerationFailed,
    };
    // `forgetTabDraft` is the app's own cleanup callback: the harness builds it
    // from source, so a discard that stopped consulting the whole inventory would show up
    // here as a delete it must not have made.
    const cleanupBindings = {
      readInventory: async () => inventory,
      persistedSnapshots: { current: new Map([[tab.id, []]]) },
      draftStorage: {
        async deleteDraft() {},
        async deleteSource(key) {
          deleted.push(key);
        },
      },
      planDocumentCleanup: model.planDocumentCleanup,
      keysForDraft: model.keysForDraft,
      openVaultKeys: (excludedTabId) =>
        store
          .getSnapshot()
          .tabs.filter((candidate) => candidate.id !== excludedTabId)
          .map((candidate) => ({
            source: model.sourceKeyFor(candidate.id, candidate.source.sha256),
            snapshots: [],
          })),
      channel: { peerReferences: () => [] },
    };
    const forgetTabDraft = callback('forgetTabDraft', cleanupBindings);
    // The engine values a restored draft waits to hand its viewer (`features/annotations`).
    const pendingEngineValues = new Map([[tab.id, { entries: [], dropped: 0 }]]);
    // The redaction needles a document accumulated (`features/marks/redaction-store.ts`).
    const erasedWords = new Map();
    const bindings = {
      store,
      cancelRef: { current: null },
      dropHandle: () => undefined,
      releaseEngineValues: (id) => pendingEngineValues.delete(id),
      // Closing a document releases the needles it accumulated, so the binding has to
      // exist for the extracted callback to run at all.
      redactedWordsForgotten: (id) => erasedWords.delete(id),
      draftWrites: { current: Promise.resolve() },
      forgetTabDraft,
      ToolError,
      tRef: { current: (key) => key },
      showNotice: (notice) => notices.push(notice),
    };
    return {
      run: callback('discardTab', bindings),
      tab,
      bindings,
      pendingEngineValues,
      erasedWords,
      deleted,
      sourceKey,
      notices,
    };
  }
  for (const scenario of ['unreadable', 'enumerationFailed']) {
    await check(
      `discard does not garbage-collect source bytes when draft inventory is ${scenario}`,
      async () => {
        const h = discardHarness({ [scenario]: true });
        h.run(h.tab.id);
        await h.bindings.draftWrites.current;
        assert.equal(h.deleted.length, 0);
        assert.ok(h.notices.length > 0);
      },
    );
  }
  await check('discard retains a source referenced by another valid draft', async () => {
    const h = discardHarness({ shared: true });
    h.run(h.tab.id);
    await h.bindings.draftWrites.current;
    assert.equal(h.deleted.includes(h.sourceKey), false);
  });
  await check('discard deletes an unreferenced source and clears pending engine values', async () => {
    const h = discardHarness();
    h.run(h.tab.id);
    await h.bindings.draftWrites.current;
    assert.ok(h.deleted.includes(h.sourceKey));
    assert.equal(h.pendingEngineValues.has(h.tab.id), false);
  });
  await check('a failed PDF file write is aborted and leaves the tab dirty', async () => {
    const target = fakeFile();
    target.file.createWritable = async () => ({
      async write() {
        throw new Error('disk full');
      },
      async close() {},
      async abort() {
        target.calls.aborted += 1;
      },
    });
    const h = await saveHarness({ target });
    assert.equal(await h.run(), false);
    assert.equal(target.calls.aborted, 1);
    assert.equal(h.store.active.dirty, true);
    assert.equal(h.store.active.outputs.length, 0);
  });
  await check('edits made after preparation remain dirty after file commit', async () => {
    const target = fakeFile();
    const createWritable = target.file.createWritable;
    const h = await saveHarness({ target });
    target.file.createWritable = async () => {
      const stream = await createWritable();
      const close = stream.close;
      stream.close = async () => {
        h.store.setOverlays(h.tab.id, { annotations: ['newer'] }, 'ann.engineEdit');
        await close();
      };
      return stream;
    };
    assert.equal(await h.run(), true);
    assert.equal(h.store.active.dirty, true);
    assert.notEqual(h.store.active.outputs[0].fromState, h.store.active.working.stateId);
  });
  await check('a failed Save As write does not attach the destination as the document file', async () => {
    const target = fakeFile([]);
    target.file.createWritable = async () => ({
      async write() {
        throw new Error('disk full');
      },
      async close() {},
      async abort() {
        target.calls.aborted += 1;
      },
    });
    const h = await saveHarness({ picker: async () => target.file, saveAs: true });
    assert.equal(await h.run(), false);
    assert.equal(target.calls.aborted, 1);
    assert.equal(h.store.active.source.handle, undefined);
  });
  await check('a save reports what it verified and keeps the fact table with the output', async () => {
    const verification = {
      state: 'verified',
      checks: [{ fact: 'pageOrder', verdict: 'verified' }],
      declared: [],
    };
    const target = fakeFile();
    const h = await saveHarness({
      target,
      prepare: async (store) => ({
        tab: store.active,
        bytes: new Uint8Array([4, 5, 6]),
        outputProtection: { encrypted: false },
        outputHash: await model.sha256Hex(new Uint8Array([4, 5, 6])),
        execution: { steps: [], appliedSteps: [], plan: { incremental: false } },
        verification,
      }),
    });
    assert.equal(await h.run(), true);
    assert.deepEqual(h.store.active.outputs[0].verification, verification);
    const notice = String(h.notices.at(-1));
    assert.ok(notice.includes('save.done'), notice);
    assert.ok(notice.includes('verify.verified'), notice);
  });
  await check(
    'a second save compares the file with what the first save wrote, and still catches outside edits',
    async () => {
      const target = fakeFile();
      const h = await saveHarness({ target });
      assert.equal(await h.run(), true);
      assert.deepEqual([...target.bytes()], [4, 5, 6]);
      assert.equal(await h.run(), true, 'the file this save wrote is not an external change');
      target.replace([7]);
      assert.equal(await h.run(), false);
      assert.deepEqual([...target.bytes()], [7]);
    },
  );
  await check('without a file handle or picker, a save downloads the prepared bytes', async () => {
    const h = await saveHarness({ saveAs: true });
    assert.equal(await h.run(), true);
    assert.equal(h.downloads.length, 1);
    assert.equal(h.downloads[0].name, 'sample.pdf');
    assert.deepEqual([...h.downloads[0].bytes], [4, 5, 6]);
    assert.equal(h.store.active.outputs.length, 1);
  });
  await check('closing the active tab cancels its running save and forgets its redaction terms', async () => {
    const h = discardHarness();
    let aborted = false;
    h.bindings.cancelRef.current = {
      abort: () => {
        aborted = true;
      },
    };
    h.erasedWords.set(h.tab.id, ['secret']);
    h.run(h.tab.id);
    await h.bindings.draftWrites.current;
    assert.equal(aborted, true);
    assert.equal(h.erasedWords.has(h.tab.id), false);
  });
  await check('strict draft validation accepts journal entries generated by real operations and undo', () => {
    const store = new model.SessionStore();
    const tab = store.openDocument(documentInput());
    const produced = store.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array([4]),
      pageCount: 1,
      labelKey: 'ann.engineEdit',
      engine: 'mupdf',
      steps: ['rotate'],
      overlays: null,
    });
    store.setOverlays(tab.id, { annotations: ['a'] }, 'ann.engineEdit');
    store.undo(tab.id);
    const journal = store.active.journal.toJSON();
    const draft = model.draftFor({
      ...validDraft(),
      id: tab.id,
      journal: journal.entries,
      journalCursor: journal.cursor,
      stateId: store.active.working.stateId,
      workingId: produced.id,
      // A `workingId` must name a snapshot the draft actually carries, so the restore path
      // never has to guess which version the tab was left on.
      snapshots: [
        { id: produced.id, key: 'snapshot-real', labelKey: 'ann.engineEdit', pageCount: 1, inputBytes: 1 },
      ],
    });
    const parsed = model.parseDraft(JSON.parse(JSON.stringify(draft)));
    assert.ok(parsed);
    assert.equal(parsed.journal.length, 2);
    assert.equal(parsed.journalCursor, 1);
  });
  function previewResolver() {
    const file = path.join(ROOT, 'tools/preview-dist.mjs');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(
      (node) => ts.isFunctionDeclaration(node) && node.name.text === 'resolveFile',
    );
    assert.ok(declaration);
    return Function(
      'normalize',
      'join',
      'existsSync',
      'statSync',
      'distRoot',
      `${declaration.getText(source)}; return resolveFile;`,
    )(path.normalize, path.join, fs.existsSync, fs.statSync, ROOT);
  }
  await check('preview rejects malformed URL encoding without throwing', () => {
    const resolve = previewResolver();
    assert.equal(resolve('/%E0%A4%A'), null);
    assert.equal(resolve('/%'), null);
  });
  await check('preview still resolves an existing local file', () => {
    assert.equal(previewResolver()('/README.md'), path.join(ROOT, 'README.md'));
  });

  await tick();
  await check('tested asynchronous paths leave no unhandled rejections', () => {
    assert.deepEqual(unhandled, []);
  });
  process.removeListener('unhandledRejection', recordUnhandled);

  const failures = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failures.length}/${results.length} checks passed (Node ${process.version}, TypeScript ${ts.version}).`,
  );
  if (process.env.AUDIT_RESULTS)
    fs.writeFileSync(
      process.env.AUDIT_RESULTS,
      JSON.stringify({ root: ROOT, node: process.version, typescript: ts.version, results }, null, 2),
    );
  process.exitCode = failures.length > 0 ? 1 : 0;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
