/**
 * Context Gauge Sidecar Backend for Antigravity 2.0.
 * Strictly read-only: reads local transcript.jsonl files under <appData>/brain/
 * and serves exact token telemetry + Studio Dashboard UI in the auxiliary pane.
 */
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';
import { cleanChatTitle, parseSteps } from './parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
};

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function statOf(p) {
  try {
    const st = statSync(p);
    return { size: st.size, mtime: st.mtimeMs, ino: st.ino };
  } catch {
    return { size: -1, mtime: 0, ino: 0 };
  }
}

/**
 * Compute a lightweight version stamp for the UI assets on disk so open
 * side-pane iframes automatically reload whenever a new version is deployed.
 */
function currentUiVersion() {
  const files = ['index.html', 'styles.css', 'app.js'];
  return files
    .map((f) => {
      const s = statOf(join(__dirname, f));
      return `${Math.floor(s.mtime)}:${s.size}`;
    })
    .join('|');
}

/**
 * Locate Antigravity appData dir(s) containing brain/.
 */
function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
  }
  const envAppData = process.env.ANTIGRAVITY_APP_DATA_DIR;
  if (envAppData && existsSync(join(envAppData, 'brain'))) {
    return [envAppData];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, 'brain')));
}

function transcriptPathFor(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    const p = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------- Incremental transcript reader ----------
// Reads only the bytes appended since the last poll, JSON-parses only the new
// lines, and keeps the parsed step objects per conversation. A truncated or
// replaced file (smaller size or new inode) triggers a clean full re-read.
const convCache = new Map(); // path -> { ino, offset, steps, pendingStep, etag, data }
const CONV_CACHE_MAX = 20;

function readAppendedSteps(path, c, size) {
  if (size <= c.offset) return;
  const len = size - c.offset;
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  const fd = openSync(path, 'r');
  try {
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, c.offset + got);
      if (n <= 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  if (got === 0) return;

  // Only consume up to the last newline, in bytes, so a half-written line or
  // a split UTF-8 character is never parsed; it is re-read on the next poll.
  const lastNL = buf.lastIndexOf(0x0a, got - 1);
  if (lastNL >= 0) {
    const text = buf.toString('utf-8', 0, lastNL + 1);
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        c.steps.push(JSON.parse(s));
      } catch {
        // Skip a corrupt line (same behavior as the old full parse).
      }
    }
    c.offset += lastNL + 1;
  }

  // A complete final line with no trailing newline yet: use it now, but do
  // not consume it, so it is read again (and kept) once its newline lands.
  c.pendingStep = null;
  const rest = buf.toString('utf-8', lastNL + 1, got).trim();
  if (rest) {
    try {
      c.pendingStep = JSON.parse(rest);
    } catch {
      // Still being written.
    }
  }
}

function readParsedConversation(convId) {
  const path = transcriptPathFor(convId);
  if (!path) {
    return { found: false, etag: `missing:${convId}`, data: null };
  }
  const st = statOf(path);
  if (st.size < 0) {
    convCache.delete(path);
    return { found: false, etag: `missing:${convId}`, data: null };
  }
  const etag = `${convId}:${st.mtime}:${st.size}:${st.ino}`;

  let c = convCache.get(path);
  if (c && c.etag === etag) {
    convCache.delete(path); // LRU bump
    convCache.set(path, c);
    return { found: true, etag, data: c.data };
  }
  if (!c || c.ino !== st.ino || st.size < c.offset) {
    c = { ino: st.ino, offset: 0, steps: [], pendingStep: null, etag: '', data: null };
  }

  try {
    readAppendedSteps(path, c, st.size);
  } catch {
    return { found: false, etag: `err:${convId}`, data: null };
  }

  const steps = c.pendingStep ? c.steps.concat([c.pendingStep]) : c.steps;
  c.data = parseSteps(steps, convId);
  c.etag = etag;

  convCache.delete(path);
  convCache.set(path, c);
  while (convCache.size > CONV_CACHE_MAX) {
    convCache.delete(convCache.keys().next().value);
  }
  return { found: true, etag, data: c.data };
}

const titleCache = new Map();

function fetchTitle(convId) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const args = [...(exe ? ['agentapi'] : []), 'get-conversation-metadata', convId];
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf-8', timeout: 4000 }, (err, stdout) => {
      if (err) return resolve('');
      try {
        const md = JSON.parse(stdout || '{}');
        const cm =
          md?.response?.conversationMetadata ||
          md?.response?.conversation_metadata ||
          md?.conversationMetadata ||
          md?.conversation ||
          md;
        const meta = cm?.metadata || cm;
        const raw =
          meta?.title ||
          meta?.summary ||
          meta?.name ||
          cm?.title ||
          cm?.summary ||
          md?.title ||
          md?.summary ||
          md?.name ||
          '';
        resolve(cleanChatTitle(raw));
      } catch {
        resolve('');
      }
    });
  });
}

function startTitleFetch(convId) {
  const p = fetchTitle(convId).then((t) => {
    const clean = cleanChatTitle(t) || '';
    titleCache.set(convId, { title: clean, ts: Date.now() });
    return clean;
  });
  titleCache.set(convId, p);
  return p;
}

function getConversationTitle(convId, fallback) {
  const cleanFallback = cleanChatTitle(fallback) || fallback;
  const cached = titleCache.get(convId);
  if (cached && typeof cached === 'object' && !(cached instanceof Promise)) {
    if (cached.title) return cached.title;
    if (Date.now() - cached.ts < 15_000) return cleanFallback;
  }
  if (!(cached instanceof Promise) && convId && ID_RE.test(convId)) {
    startTitleFetch(convId);
  }
  return cleanFallback;
}

async function resolveConversationTitle(convId, fallback, waitMs = 350) {
  const cleanFallback = cleanChatTitle(fallback) || fallback;
  if (!convId || !ID_RE.test(convId)) return cleanFallback;
  const cached = titleCache.get(convId);
  if (cached && typeof cached === 'object' && !(cached instanceof Promise)) {
    if (cached.title) return cached.title;
    if (Date.now() - cached.ts < 15_000) return cleanFallback;
  }
  const p = cached instanceof Promise ? cached : startTitleFetch(convId);
  const fetched = await Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(''), waitMs)),
  ]);
  return fetched || cleanFallback;
}

let sessionsCache = { ts: 0, list: [] };

function listRecentSessions(limit = 15) {
  const now = Date.now();
  if (now - sessionsCache.ts < 3000 && sessionsCache.list.length) {
    return sessionsCache.list.slice(0, limit);
  }
  const entries = [];
  for (const appData of findAppDataDirs()) {
    const brainDir = join(appData, 'brain');
    for (const id of safeReaddir(brainDir)) {
      if (!ID_RE.test(id)) continue;
      const p = join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      const st = statOf(p);
      if (st.size <= 0) continue;
      entries.push({ id, path: p, mtime: st.mtime, size: st.size });
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const top = entries.slice(0, limit).map((e) => {
    const parsed = readParsedConversation(e.id);
    const d = parsed.data;
    const title = getConversationTitle(e.id, d?.titleFallback || e.id.slice(0, 8));
    return {
      conversationId: e.id,
      title,
      model: d?.model?.displayName || 'Model not reported yet',
      contextTokens: d?.current?.exactContextTokens || 0,
      contextLimit: d?.model?.contextLimit || 256_000,
      baseTokens: d?.current?.firstTurnBaseTokens || 0,
      mtime: e.mtime,
    };
  });
  sessionsCache = { ts: now, list: top };
  return top;
}

// ---------------------------------------------------------------------------
// Sidecar HTTP routes
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => {
  const v = encodeURIComponent(currentUiVersion());
  const html = readFileSync(join(__dirname, 'index.html'), 'utf-8')
    .replace(/href="\/styles\.css(?:\?[^"]*)?"/, `href="/styles.css?v=${v}"`)
    .replace(/src="\/app\.js(?:\?[^"]*)?"/, `src="/app.js?v=${v}"`);
  return new Response(html, {
    contentType: 'text/html; charset=utf-8',
    headers: NO_CACHE_HEADERS,
  });
});

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(__dirname, file), 'utf-8'), {
        contentType,
        headers: NO_CACHE_HEADERS,
      }),
    'GET',
  );
}

function estimateAgentsMd(workspaceUri) {
  let wsSize = 0;
  let globalSize = 0;
  let wsPath = '';
  if (typeof workspaceUri === 'string' && workspaceUri.startsWith('file://')) {
    try {
      wsPath = fileURLToPath(workspaceUri);
    } catch {
      wsPath = '';
    }
  }
  if (!wsPath) {
    return { found: false, tokensEst: 0 };
  }
  const wsAgents = statOf(join(wsPath, 'AGENTS.md'));
  if (wsAgents.size > 0) wsSize = wsAgents.size;
  const globalAgents = statOf(join(homedir(), '.gemini', 'config', 'rules', 'AGENTS.md'));
  if (globalAgents.size > 0) globalSize = globalAgents.size;
  const totalBytes = wsSize + globalSize;
  if (totalBytes <= 0) {
    return { found: false, tokensEst: 0 };
  }
  return {
    found: true,
    workspaceFound: wsSize > 0,
    tokensEst: Math.ceil(totalBytes / 4),
  };
}

app.api('/api/context', async (data) => {
  const uiVersion = currentUiVersion();
  const conv = (typeof data.conversationId === 'string' && data.conversationId.trim()) || app.config.conversationId || '';
  const workspaceUri = typeof data.workspaceUri === 'string' ? data.workspaceUri.trim() : '';
  if (!conv || !ID_RE.test(conv)) {
    return { found: false, conversationId: null, etag: 'none', uiVersion, title: '', data: null };
  }
  const res = readParsedConversation(conv);
  const fallbackTitle = res.data?.titleFallback || `Chat ${conv.slice(0, 6)}`;
  const title = await resolveConversationTitle(conv, fallbackTitle, 350);
  if (!res.found || !res.data) {
    return { found: false, conversationId: conv, etag: `${res.etag}|${title}`, uiVersion, title, data: null };
  }
  const agentsMd = estimateAgentsMd(workspaceUri);
  const fullEtag = `${res.etag}|${title}|${agentsMd.tokensEst}`;
  if (data.etag && data.etag === fullEtag) {
    return { found: true, conversationId: conv, unchanged: true, etag: fullEtag, uiVersion, title };
  }
  return {
    found: true,
    conversationId: conv,
    etag: fullEtag,
    uiVersion,
    title,
    agentsMd,
    data: res.data,
  };
}, 'GET');

app.api('/api/sessions', () => {
  return { sessions: listRecentSessions(15) };
}, 'GET');

console.log(`[context_monitor] app data dirs: ${findAppDataDirs().join(', ') || '(none yet)'}`);

const BACKEND_FILES = ['main.mjs', 'parser.mjs'];
function backendVersionSig() {
  return BACKEND_FILES.map((f) => {
    const s = statOf(join(__dirname, f));
    return `${Math.floor(s.mtime)}:${s.size}`;
  }).join('|');
}
const initialBackendSig = backendVersionSig();
const watchTimer = setInterval(() => {
  if (backendVersionSig() !== initialBackendSig) {
    console.log('[context_monitor] backend updated on disk; exiting for supervisor restart');
    process.exit(0);
  }
}, 2000);
watchTimer.unref();

app.run();
