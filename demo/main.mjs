/** Drives the worker with a hand-written LSP conversation — no editor involved. */
const WORKSPACE = '/home/web_user/workspace';
const MAIN_URI = `file://${WORKSPACE}/main.cpp`;
const MAIN = `${WORKSPACE}/main.cpp`;
const code = document.getElementById('code');
const statusEl = document.getElementById('status');
const diagsEl = document.getElementById('diags');
const logEl = document.getElementById('log');
const runBtn = document.getElementById('run');

// ?variant=asyncify forces the non-JSPI payload (useful when both are built).
const variant = new URLSearchParams(location.search).get('variant');
const workerUrl = new URL('./worker.mjs', import.meta.url);
if (variant) workerUrl.searchParams.set('variant', variant);
const worker = new Worker(workerUrl, { type: 'module' });
let nextId = 1;
let ready = false;
const pending = new Map();

function log(text) {
  logEl.textContent += `${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(html) {
  statusEl.innerHTML = html;
}

function send(method, params) {
  const id = nextId++;
  worker.postMessage({ type: 'lsp', message: { jsonrpc: '2.0', id, method, params } });
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method, params) {
  worker.postMessage({ type: 'lsp', message: { jsonrpc: '2.0', method, params } });
}

function renderDiagnostics(items) {
  diagsEl.replaceChildren();
  if (items.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<em>no diagnostics</em>';
    diagsEl.append(li);
    return;
  }
  for (const diagnostic of items) {
    const li = document.createElement('li');
    const severity = ['', 'error', 'warning', 'note'][diagnostic.severity] ?? 'error';
    li.className = severity;
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    li.innerHTML = `<em>${escapeHtml(MAIN)}:${line}:${column}</em><br>${escapeHtml(diagnostic.message)}`;
    diagsEl.append(li);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
}

worker.addEventListener('message', async (event) => {
  const message = event.data;
  switch (message.type) {
    case 'status':
      setStatus(escapeHtml(message.text));
      break;
    case 'log':
      log(message.text);
      break;
    case 'ready':
      ready = true;
      setStatus(`clangd ready (<b>${message.variant}</b>)`);
      runBtn.disabled = false;
      break;
    case 'lsp': {
      const payload = message.message;
      if (typeof payload.id === 'number' && pending.has(payload.id)) {
        pending.get(payload.id)(payload);
        pending.delete(payload.id);
      } else if (payload.method === 'textDocument/publishDiagnostics' && payload.params.uri === MAIN_URI) {
        renderDiagnostics(payload.params.diagnostics ?? []);
      }
      break;
    }
    case 'error':
      setStatus(`failed: ${escapeHtml(message.message)}`);
      log(message.message);
      break;
    case 'exit':
      ready = false;
      setStatus(`clangd exited (${message.code ?? '?'})`);
      break;
    default:
      break;
  }
});

async function start() {
  runBtn.disabled = true;
  setStatus('starting clangd…');
  const started = performance.now();
  worker.postMessage({
    type: 'init',
    files: [{ path: MAIN, content: code.value }],
    flags: ['-isystem/usr/include/wasm32-wasi/c++/v1', '-isystem/usr/include', '-isystem/usr/include/wasm32-wasi']
  });
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (ready) {
        clearInterval(timer);
        resolve();
      }
    }, 30);
  });
  log(`boot: ${Math.round(performance.now() - started)} ms`);

  const init = await send('initialize', {
    processId: null,
    rootUri: `file://${WORKSPACE}`,
    capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } }
  });
  log(`server: ${init.result?.serverInfo?.name ?? 'clangd'} ${init.result?.serverInfo?.version ?? ''}`);
  notify('initialized', {});
}

async function analyze() {
  runBtn.disabled = true;
  if (!ready) await start();
  const started = performance.now();
  notify('textDocument/didOpen', {
    textDocument: { uri: MAIN_URI, languageId: 'cpp', version: 1, text: code.value }
  });
  // wait for the first publishDiagnostics for this file
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 30000);
    const check = setInterval(() => {
      if (diagsEl.childElementCount > 0 && !diagsEl.textContent.startsWith('nothing yet')) {
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
  });
  log(`first diagnostics: ${Math.round(performance.now() - started)} ms`);
  runBtn.disabled = false;
}

runBtn.addEventListener('click', () => {
  analyze().catch((error) => setStatus(`failed: ${escapeHtml(error?.message ?? error)}`));
});
