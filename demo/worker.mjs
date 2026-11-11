/**
 * Minimal clangd worker: owns the wasm module, pipes LSP in and out.
 *
 * The page talks to this worker with:
 *   { type: 'init', files: [{path, content}], flags: string[] }
 *   { type: 'lsp',  message: <JSON-RPC object> }
 *   { type: 'sync', files }                       // rewrite the in-memory FS
 * and receives:
 *   { type: 'status' | 'log' | 'lsp' | 'ready' | 'exit' | 'error', ... }
 */
const params = new URL(import.meta.url).searchParams;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let runtime = null;
let variant = null;

// ---------------------------------------------------------------- stdin pipe
const pendingFrames = [];
let currentChars = [];
let wakeStdin = () => {};

function stdin() {
  if (currentChars.length === 0) {
    if (pendingFrames.length === 0) return null;
    currentChars = [...encoder.encode(pendingFrames.shift()), null];
  }
  const value = currentChars.shift();
  return value === undefined ? null : value;
}

async function stdinReady() {
  if (pendingFrames.length > 0) return;
  await new Promise((resolve) => {
    wakeStdin = resolve;
  });
}

/** Queue one JSON-RPC message as three chunks (header, blank line, body).
 *
 * The chunking is not cosmetic: the suspended stdin read returns to the event
 * loop between chunks, which is what lets clangd see a complete message while
 * the next one is still being queued. Non-ASCII characters are escaped so the
 * character count equals the byte count and `Content-Length` stays correct. */
function enqueueFrame(message) {
  const json = JSON.stringify(message).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`
  );
  pendingFrames.push(`Content-Length: ${json.length}\r\n`, '\r\n', json);
  const wake = wakeStdin;
  wakeStdin = () => {};
  wake();
}

// --------------------------------------------------------------- stdout pipe
let outBuffer = '';
let errBuffer = '';

function stdout(chunk) {
  outBuffer += typeof chunk === 'number' ? String.fromCharCode(chunk) : String(chunk);
  for (;;) {
    const headerEnd = outBuffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      if (outBuffer.length > 65536) outBuffer = '';
      return;
    }
    const match = /content-length:\s*(\d+)/i.exec(outBuffer.slice(0, headerEnd));
    if (!match) {
      outBuffer = outBuffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    if (outBuffer.length < headerEnd + 4 + length) return;
    const body = outBuffer.slice(headerEnd + 4, headerEnd + 4 + length);
    outBuffer = outBuffer.slice(headerEnd + 4 + length);
    try {
      post({ type: 'lsp', message: JSON.parse(decoder.decode(Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff))) });
    } catch {
      /* partial or malformed message: drop it */
    }
  }
}

function stderr(chunk) {
  errBuffer += typeof chunk === 'number' ? String.fromCharCode(chunk) : String(chunk);
  for (;;) {
    const nl = errBuffer.indexOf('\n');
    if (nl < 0) break;
    const line = errBuffer.slice(0, nl).replace(/\r$/, '');
    errBuffer = errBuffer.slice(nl + 1);
    if (line) post({ type: 'log', text: line });
  }
  if (errBuffer.length > 8192) errBuffer = '';
}

// ------------------------------------------------------------------- helpers
function post(message) {
  self.postMessage(message);
}

function writeFiles(files) {
  if (!runtime || !Array.isArray(files)) return;
  for (const file of files) {
    const path = file?.path;
    if (typeof path !== 'string' || !path.startsWith('/')) continue;
    const dir = path.slice(0, path.lastIndexOf('/'));
    try {
      runtime.FS.mkdirTree(dir);
      runtime.FS.writeFile(path, file.content ?? '');
    } catch (error) {
      console.error('[worker] writeFile failed', path, error);
    }
  }
}

// ---------------------------------------------------------------------- boot
async function loadFactory(name) {
  const url = new URL(`../public/wasm/${name}/clangd.js`, import.meta.url).href;
  const module = await import(url);
  return module.default;
}

async function pickFactory() {
  const forced = params.get('variant');
  const canJspi =
    typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
  const order = forced ? [forced] : canJspi ? ['jspi', 'asyncify'] : ['asyncify'];
  for (const name of order) {
    try {
      const factory = await loadFactory(name);
      variant = name;
      return factory;
    } catch (error) {
      console.warn(`[worker] ${name} payload unavailable`, error);
    }
  }
  throw new Error('no clangd payload found under public/wasm (run scripts/build.sh)');
}

async function boot({ files, flags }) {
  const factory = await pickFactory();
  post({ type: 'status', text: `loading clangd 21 (${variant})…` });

  runtime = await factory({
    thisProgram: '/usr/bin/clangd',
    locateFile: (path) =>
      path.endsWith('.wasm')
        ? new URL(`../public/wasm/${variant}/${path}`, import.meta.url).href
        : new URL(path, import.meta.url).href,
    stdin,
    stdinReady,
    stdout,
    stderr,
    print: (text) => post({ type: 'log', text }),
    printErr: (text) => post({ type: 'log', text }),
    onExit: (code) => post({ type: 'exit', code }),
    onAbort: (what) => post({ type: 'error', message: String(what) })
  });

  writeFiles(files);
  const config = { CompileFlags: { Add: flags ?? [] } };
  try {
    runtime.FS.mkdirTree('/home/web_user');
  } catch {
    /* already there */
  }
  runtime.FS.writeFile('/home/web_user/.clangd', JSON.stringify(config));

  // callMain() suspends at clangd's first stdin read (JSPI) or returns after the
  // first Asyncify unwind, so this is where the LSP loop is ready to talk.
  runtime.callMain([]);
  post({ type: 'ready', variant });
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'init':
      boot(message).catch((error) => post({ type: 'error', message: String(error?.stack ?? error) }));
      break;
    case 'lsp':
      enqueueFrame(message.message);
      break;
    case 'sync':
      writeFiles(message.files);
      break;
    default:
      break;
  }
});
