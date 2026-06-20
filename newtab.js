/* ═══════════════════════════════════════════════════════════════
   TabNest — newtab.js (v3)
   ═══════════════════════════════════════════════════════════════ */

// Schema version of the in-storage state. Bump when state shape changes,
// then add a forward-migration branch in migrate(). Older builds reading
// data stamped with a higher value get a blocking "newer data" guard.
const CURRENT_SCHEMA = 3;

// ════════════════════════════════════════════════════════════════
// STATE + UNDO
// ════════════════════════════════════════════════════════════════
let loadedSchema = 0;
const State = (() => {
  let state = {
    workspaces: [], activeWsId: null, archive: [], recentEmoji: [],
    columnWidths: {},
    settings: {
      theme:'dark', size:'normal', font:'dm', width:'normal',
      closeTabOnSave:true, hibernate:true, showUrls:true,
      animate:true, confirmDelete:true, sidebarCollapsed:false,
      blurPrivacy:false, windowSync:false
    }
  };
  let history = [], future = [];
  let persistTimer = null;
  // structuredClone is ~3× faster than JSON round-tripping and handles
  // Dates/Maps/etc. Falls back to JSON for ancient browsers.
  const deepClone = typeof structuredClone === 'function'
    ? (o => structuredClone(o))
    : (o => JSON.parse(JSON.stringify(o)));
  return {
    get: () => state,
    async load() {
      const d = await chrome.storage.local.get('te');
      if (d.te) {
        loadedSchema = Number(d.te.schema) || 0;
        state = { ...state, ...d.te, settings: { ...state.settings, ...(d.te.settings || {}) } };
      }
    },
    persist() {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        chrome.storage.local.set({ te: state })
          .then(() => { try { refreshStorageUsage(); } catch {} })
          .catch(err => handleStorageError(err));
      }, 180);
    },
    persistNow() {
      clearTimeout(persistTimer);
      const p = chrome.storage.local.set({ te: state });
      p.then(() => { try { refreshStorageUsage(); } catch {} })
       .catch(err => handleStorageError(err));
      return p;
    },
    snapshot(label) {
      history.push({ label, data: deepClone(state) });
      if (history.length > 50) history.shift();
      future.length = 0;
    },
    undo() { if (!history.length) return null; future.push({ data: deepClone(state) }); const p = history.pop(); state = p.data; this.persistNow(); return p.label; },
    redo() { if (!future.length) return null; history.push({ label:'redo', data: deepClone(state) }); const n = future.pop(); state = n.data; this.persistNow(); return 'redo'; },
    canUndo: () => history.length > 0,
    canRedo: () => future.length > 0
  };
})();

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const _favCache = new Map();
const favUrl = u => {
  if (!u) return '';
  try {
    const host = new URL(u).hostname;
    let v = _favCache.get(host);
    if (v === undefined) { v = `https://www.google.com/s2/favicons?domain=${host}&sz=32`; _favCache.set(host, v); }
    return v;
  } catch { return ''; }
};
const dispUrl = u => { try { const x = new URL(u); return x.hostname + (x.pathname.length > 1 ? x.pathname.slice(0, 40) : ''); } catch { return u; } };
const isProto = u => !u || u.startsWith('chrome') || u.startsWith('edge') || u.startsWith('about') || u.startsWith('view-source');
const BLANK_FAV = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23444'/%3E%3C/svg%3E`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// Coalesce multiple calls per frame into one rAF-scheduled invocation.
const rafThrottle = fn => { let q = null, lastArgs; return (...a) => { lastArgs = a; if (q != null) return; q = requestAnimationFrame(() => { q = null; fn(...lastArgs); }); }; };
// Cached node list for the board; invalidated whenever renderBoard runs.
let _itemNodeCache = null;
const invalidateItemCache = () => { _itemNodeCache = null; };
const getItemNodes = () => { if (!_itemNodeCache) _itemNodeCache = document.querySelectorAll('.item'); return _itemNodeCache; };
const INTENT_STATUS = ['active', 'paused', 'someday', 'done', 'reference'];
const INTENT_TYPE = ['project', 'study', 'research', 'admin', 'life', 'reference', 'other'];

function sanitizeHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

function fmtTimeRelative(ts) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  if (abs < 60000) return diff > 0 ? 'soon' : 'now';
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  if (mins < 60) return diff > 0 ? `in ${mins}m` : `${mins}m ago`;
  if (hours < 24) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
  return diff > 0 ? `in ${days}d` : `${days}d ago`;
}

function hasIntentMeta(entity) {
  if (!entity || !entity.intent) return false;
  const i = entity.intent;
  return !!(i.purpose || i.nextAction || i.status || i.type);
}
function ensureIntentMeta(entity) {
  if (!entity) return null;
  if (!entity.intent) entity.intent = {};
  if (!INTENT_STATUS.includes(entity.intent.status)) entity.intent.status = 'active';
  if (!INTENT_TYPE.includes(entity.intent.type)) entity.intent.type = 'other';
  return entity.intent;
}
function clearIntentMeta(entity) {
  if (entity?.intent) delete entity.intent;
}
function renderIntentPills(entity) {
  if (!hasIntentMeta(entity)) return '';
  const i = ensureIntentMeta(entity);
  const next = (i.nextAction || '').trim();
  return `
    <div class="intent-meta">
      <span class="intent-pill status status-${esc(i.status)}">${esc(i.status)}</span>
      <span class="intent-pill type">${esc(i.type)}</span>
      ${next ? `<span class="intent-next">Next: ${esc(next.slice(0, 72))}${next.length > 72 ? '…' : ''}</span>` : ''}
    </div>`;
}

const activeWs = () => State.get().workspaces.find(w => w.id === State.get().activeWsId);
const activeCat = () => { const ws = activeWs(); return ws ? (ws.categories.find(c => c.id === ws.activeCatId) || ws.categories[0]) : null; };

function findGroup(gId) {
  for (const ws of State.get().workspaces)
    for (const cat of ws.categories) {
      const g = cat.groups.find(x => x.id === gId);
      if (g) return { ws, cat, group: g };
    }
  return null;
}
function findItemInList(list, itemId, ctx) {
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (it.id === itemId) return { ...ctx, item: it, parent: list, index: i };
    if (it.type === 'stack' && it.items) {
      const sub = findItemInList(it.items, itemId, { ...ctx, stack: it });
      if (sub) return sub;
    }
  }
  return null;
}
function findItem(itemId) {
  for (const ws of State.get().workspaces)
    for (const cat of ws.categories)
      for (const g of cat.groups) {
        const r = findItemInList(g.items, itemId, { ws, cat, group: g });
        if (r) return r;
      }
  return null;
}

// ════════════════════════════════════════════════════════════════
// INIT / MIGRATE
// ════════════════════════════════════════════════════════════════
async function init() {
  await State.load();

  if (loadedSchema > CURRENT_SCHEMA) {
    // Older build opening newer data — refuse to clobber until the user
    // explicitly acknowledges (or updates the extension).
    applySettings();
    bindSchemaMismatchOverlay();
    showSchemaMismatch(loadedSchema);
    document.body.classList.remove('app-loading');
    document.body.classList.add('app-ready');
    return;
  }

  initAfterLoad();
}

function initAfterLoad() {
  migrate();
  ensureDefault();

  applySettings();
  buildThemeGrid();
  buildEmojiPicker();
  bindStatic();

  renderAll();

  // Reveal the app once the first frame paints (avoids any layout flash).
  requestAnimationFrame(() => {
    document.body.classList.remove('app-loading');
    document.body.classList.add('app-ready');
  });

  // Defer non-critical init to idle time so first paint isn't blocked.
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 0));
  idle(() => {
    refreshStorageUsage();
    refreshOpenTabs();
    chrome.tabs.onCreated.addListener(refreshOpenTabs);
    chrome.tabs.onRemoved.addListener(refreshOpenTabs);
    chrome.tabs.onUpdated.addListener(debounce(refreshOpenTabs, 250));
    chrome.tabs.onActivated.addListener(refreshOpenTabs);
    try {
      chrome.windows.onCreated.addListener(() => { refreshOpenTabs(); renderHeader(); });
      chrome.windows.onRemoved.addListener(() => { refreshOpenTabs(); renderHeader(); });
      chrome.windows.onFocusChanged.addListener(async (wid) => {
        if (wid === chrome.windows.WINDOW_ID_NONE) return;
        if (State.get().settings.autoSwitchWorkspace) {
          const match = State.get().workspaces.find(ws => ws.windowId === wid);
          if (match && match.id !== State.get().activeWsId) {
            State.get().activeWsId = match.id;
            State.persist();
            renderAll();
          }
        }
        refreshOpenTabs();
      });
    } catch {}

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (State.get().settings.theme === 'auto') applySettings();
    });
  });
}

function migrate() {
  const s = State.get();
  const from = Number(s.schema) || 0;

  if (from < 3) {
    // Legacy / unstamped data → schema 3. Covers the original release shape
    // (workspaces had .groups, notes had .text) plus all post-v3.0 additive
    // defaults the renderer assumes.
    (s.workspaces || []).forEach(ws => {
      if (!ws.categories) {
        ws.categories = [{ id: uid(), name: 'Quicklinks', groups: ws.groups || [] }];
        delete ws.groups;
      }
      if (!ws.activeCatId && ws.categories.length) ws.activeCatId = ws.categories[0].id;
      ws.categories.forEach(cat => {
        (cat.groups = cat.groups || []).forEach(g => {
          g.items = (g.items || []).map(it => {
            if (it.type === 'note' && it.text != null && it.html == null) { it.html = esc(it.text); delete it.text; }
            return it;
          });
          g.symbol = g.symbol || '📁';
          g.color = g.color || '#6366f1';
        });
      });
      ws.symbol = ws.symbol || '🏠';
    });
    if (!s.archive) s.archive = [];
    if (!s.recentEmoji) s.recentEmoji = [];
    if (!s.columnWidths) s.columnWidths = {};
  }

  s.schema = CURRENT_SCHEMA;
}

// ════════════════════════════════════════════════════════════════
// STORAGE QUOTA + ERROR HANDLING
// ════════════════════════════════════════════════════════════════
const STORAGE_QUOTA = (chrome.storage?.local?.QUOTA_BYTES) || 10485760;
const STORAGE_WARN_PCT = 0.80;
const STORAGE_FULL_PCT = 0.95;
let _storageWarned = false;
let _storageFullShown = false;
const _formatBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

async function storageUsage() {
  try {
    const used = await chrome.storage.local.getBytesInUse(null);
    const quota = STORAGE_QUOTA;
    return { used, quota, pct: quota ? used / quota : 0 };
  } catch {
    return null;
  }
}

async function refreshStorageUsage() {
  const u = await storageUsage();
  const bar = document.getElementById('storage-bar-fill');
  const txt = document.getElementById('storage-bar-text');
  if (!bar || !txt || !u) return;
  const pctNum = Math.round(u.pct * 100);
  bar.style.width = Math.min(100, pctNum) + '%';
  bar.classList.toggle('warn', u.pct >= STORAGE_WARN_PCT && u.pct < STORAGE_FULL_PCT);
  bar.classList.toggle('full', u.pct >= STORAGE_FULL_PCT);
  txt.textContent = `Storage · ${_formatBytes(u.used)} of ${_formatBytes(u.quota)} (${pctNum}%)`;

  if (u.pct < STORAGE_WARN_PCT) {
    _storageWarned = false;
  } else if (u.pct >= STORAGE_WARN_PCT && u.pct < STORAGE_FULL_PCT && !_storageWarned) {
    _storageWarned = true;
    try { toast(`Storage is ${pctNum}% full — consider exporting and pruning the archive.`, { duration: 5000 }); } catch {}
  }
}

function handleStorageError(err) {
  const msg = String(err?.message || err || '');
  const quotaHit = /quota|QUOTA/i.test(msg);
  if (quotaHit) {
    showStorageFull(msg);
  } else {
    try { toast('Storage error: ' + msg, { danger: true, duration: 5000 }); } catch {}
  }
}

function showStorageFull(msg) {
  if (_storageFullShown) return;
  _storageFullShown = true;
  const overlay = document.getElementById('quota-overlay');
  if (!overlay) {
    try { toast('Storage full: ' + msg, { danger: true, duration: 6000 }); } catch {}
    return;
  }
  const detail = document.getElementById('quota-detail');
  if (detail) {
    storageUsage().then(u => {
      detail.textContent = u
        ? `Using ${_formatBytes(u.used)} of ${_formatBytes(u.quota)} (${Math.round(u.pct * 100)}%).`
        : 'Storage limit reached.';
    });
  }
  rememberOpener(overlay);
  overlay.classList.remove('hidden');
  setTimeout(() => focusFirstIn(overlay), 50);
}

function closeStorageFull() {
  const overlay = document.getElementById('quota-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  restoreOpener(overlay);
  _storageFullShown = false;
}

function bindQuotaOverlay() {
  const overlay = document.getElementById('quota-overlay');
  if (!overlay) return;
  overlay.addEventListener('keydown', e => trapTabKey(e, overlay));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeStorageFull(); });
  const x = document.getElementById('quota-x');
  if (x) x.onclick = closeStorageFull;
  const dismiss = document.getElementById('quota-dismiss');
  if (dismiss) dismiss.onclick = closeStorageFull;
  const exp = document.getElementById('quota-export');
  if (exp) exp.onclick = () => { exportJSON(); };
  const arch = document.getElementById('quota-archive');
  if (arch) arch.onclick = () => {
    closeStorageFull();
    document.querySelector('#drawer-tabs .dt[data-tab="archive"]')?.click();
    document.getElementById('settings-drawer')?.classList.remove('hidden');
  };
}

// ════════════════════════════════════════════════════════════════
// SCHEMA-MISMATCH OVERLAY (older build opening newer data)
// ════════════════════════════════════════════════════════════════
function showSchemaMismatch(found) {
  const overlay = document.getElementById('schema-overlay');
  if (!overlay) {
    alert(`This data was created by a newer version (schema ${found}). Update the extension before opening.`);
    return;
  }
  const det = document.getElementById('schema-detail');
  if (det) det.textContent = `Found schema ${found}; this build understands up to ${CURRENT_SCHEMA}.`;
  overlay.classList.remove('hidden');
  setTimeout(() => focusFirstIn(overlay), 50);
}

function bindSchemaMismatchOverlay() {
  const overlay = document.getElementById('schema-overlay');
  if (!overlay) return;
  overlay.addEventListener('keydown', e => trapTabKey(e, overlay));
  const exp = document.getElementById('schema-export');
  if (exp) exp.onclick = () => { exportJSON(); };
  const cont = document.getElementById('schema-continue');
  const ack = document.getElementById('schema-ack');
  if (cont && ack) {
    cont.disabled = true;
    ack.addEventListener('change', () => { cont.disabled = !ack.checked; });
    cont.onclick = () => {
      overlay.classList.add('hidden');
      initAfterLoad();
    };
  }
}

// ════════════════════════════════════════════════════════════════
// KEYBOARD: CHEATSHEET + BOARD ARROW NAV
// ════════════════════════════════════════════════════════════════
function openCheatsheet() {
  const overlay = document.getElementById('cheatsheet-overlay');
  if (!overlay) return;
  rememberOpener(overlay);
  overlay.classList.remove('hidden');
  setTimeout(() => focusFirstIn(overlay), 50);
}

function closeCheatsheet() {
  const overlay = document.getElementById('cheatsheet-overlay');
  if (!overlay) return;
  overlay.classList.add('hidden');
  restoreOpener(overlay);
}

function bindCheatsheetOverlay() {
  const overlay = document.getElementById('cheatsheet-overlay');
  if (!overlay) return;
  overlay.addEventListener('keydown', e => trapTabKey(e, overlay));
  overlay.addEventListener('click', e => { if (e.target === overlay) closeCheatsheet(); });
  const x = document.getElementById('cheatsheet-x');
  if (x) x.onclick = closeCheatsheet;
  const close = document.getElementById('cheatsheet-close');
  if (close) close.onclick = closeCheatsheet;
}

function focusItem(id) {
  if (!id) return;
  const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  el.focus();
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function bindBoardArrowNav() {
  const board = document.getElementById('board');
  if (!board) return;
  board.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const item = e.target.closest && e.target.closest('.item');
    if (!item || !board.contains(item)) return;
    // Ignore arrows when focus is inside an editable child (e.g. note editor).
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
      if (ae !== item) return;
    }
    const siblings = Array.from(item.parentElement?.querySelectorAll(':scope > .item') || []);
    const idx = siblings.indexOf(item);
    if (idx < 0) return;
    e.preventDefault();
    const nextIdx = e.key === 'ArrowDown'
      ? (idx + 1) % siblings.length
      : (idx - 1 + siblings.length) % siblings.length;
    const target = siblings[nextIdx];
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '0');
    target.focus();
  });
  board.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const item = e.target.closest && e.target.closest('.item');
    if (!item || e.target !== item) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (item.classList.contains('tab')) {
      const open = item.querySelector('[data-act="open"]');
      if (open) { e.preventDefault(); open.click(); }
    } else if (item.classList.contains('todo')) {
      const chk = item.querySelector('input[type="checkbox"]');
      if (chk) { e.preventDefault(); chk.click(); }
    } else if (item.classList.contains('stack')) {
      const hd = item.querySelector('.stack-hd') || item;
      e.preventDefault(); hd.click();
    }
  });
  // 'm' on a focused item opens the move-target picker. Falls back to the
  // current multi-selection if one is active.
  board.addEventListener('keydown', e => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const item = e.target.closest && e.target.closest('.item');
    if (!item || e.target !== item) return;
    e.preventDefault();
    let infos;
    if (selectedItemIds.size) {
      infos = getSelectedItemsInfo();
    } else {
      const info = findItem(item.dataset.id);
      if (!info) return;
      infos = [info];
    }
    if (infos.length) openMoveTargetPicker(infos);
  });
}

function ensureDefault() {
  const s = State.get();
  if (!s.workspaces.length) {
    const cat = { id: uid(), name:'Quicklinks', groups:[] };
    const cat2 = { id: uid(), name:'Read later', groups:[] };
    cat.groups.push({
      id: uid(), name:'Getting started', symbol:'✨', color:'#6366f1', collapsed:false,
      items: [
        { id: uid(), type:'note', html:'👋 <b>Welcome to TabNest!</b><br><br>Drag tabs from the left sidebar into any group.<br>Select text for the rich-text toolbar.<br>Right-click anywhere for more options.' },
        { id: uid(), type:'todo', text:'Try dragging a tab here', done:false },
        { id: uid(), type:'todo', text:'Right-click a group for context menu', done:false },
        { id: uid(), type:'todo', text:'Press Cmd/Ctrl + K to search', done:false }
      ]
    });
    s.workspaces = [{ id: uid(), name:'My Workspace', symbol:'🏠', categories:[cat, cat2], activeCatId: cat.id }];
    s.activeWsId = s.workspaces[0].id;
  }
  if (!s.activeWsId || !s.workspaces.find(w => w.id === s.activeWsId)) s.activeWsId = s.workspaces[0].id;
}

// ════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════
const THEMES = [
  { id:'dark',             label:'Dark',             colors:['#0b0b10','#6366f1','#9b9bb4'] },
  { id:'light',            label:'Light',            colors:['#f4f4f7','#4f46e5','#52525e'] },
  { id:'dracula',          label:'Dracula',          colors:['#282a36','#bd93f9','#50fa7b'] },
  { id:'nord',             label:'Nord',             colors:['#2e3440','#88c0d0','#a3be8c'] },
  { id:'rose-pine',        label:'Rosé Pine',        colors:['#191724','#eb6f92','#9ccfd8'] },
  { id:'tokyo-night',      label:'Tokyo Night',      colors:['#1a1b26','#7aa2f7','#bb9af7'] },
  { id:'solarized-dark',   label:'Solar. Dark',      colors:['#002b36','#268bd2','#2aa198'] },
  { id:'solarized-light',  label:'Solar. Light',     colors:['#fdf6e3','#268bd2','#859900'] },
  { id:'gruvbox',          label:'Gruvbox',          colors:['#282828','#fabd2f','#b8bb26'] },
  { id:'catppuccin',       label:'Catppuccin',       colors:['#1e1e2e','#cba6f7','#f5c2e7'] },
  { id:'sepia',            label:'Sepia',            colors:['#f4ecd8','#8b4513','#5c7a2a'] },
  { id:'mono',             label:'Mono',             colors:['#0a0a0a','#ffffff','#a0a0a0'] },
];

function buildThemeGrid() {
  const grid = document.getElementById('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  THEMES.forEach(t => {
    const card = document.createElement('div');
    card.className = 'theme-card';
    card.dataset.theme = t.id;
    card.innerHTML = `
      <div class="th-preview">
        <div class="tp1" style="background:${t.colors[0]}"></div>
        <div class="tp2" style="background:${t.colors[1]}"></div>
        <div class="tp3" style="background:${t.colors[2]}"></div>
      </div>
      <div class="th-name">${t.label}</div>`;
    card.onclick = () => {
      State.get().settings.theme = t.id;
      applySettings();
      State.persist();
    };
    grid.appendChild(card);
  });
}

function applySettings() {
  const s = State.get().settings;
  let theme = s.theme;
  if (theme === 'auto') theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.body.dataset.theme = theme;
  document.body.dataset.size = s.size;
  document.body.dataset.font = s.font;
  document.body.dataset.width = s.width || 'normal';
  document.body.dataset.showUrls = s.showUrls ? 'on' : 'off';
  document.body.dataset.anim = s.animate ? 'on' : 'off';
  document.body.classList.toggle('blur-privacy', !!s.blurPrivacy);

  // Mirror for the inline pre-init script in newtab.html — read on next launch
  // before paint to eliminate theme flash.
  try {
    localStorage.setItem('te_settings_mirror', JSON.stringify({
      theme: s.theme, size: s.size, font: s.font,
      width: s.width || 'normal', anim: s.animate ? 'on' : 'off'
    }));
  } catch {}

  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.toggle('collapsed', !!s.sidebarCollapsed);

  document.querySelectorAll('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.theme === s.theme));
  ['seg-size','seg-width','seg-font'].forEach(id => {
    const key = id === 'seg-size' ? 'size' : id === 'seg-width' ? 'width' : 'font';
    document.querySelectorAll(`#${id} button`).forEach(b => b.classList.toggle('active', b.dataset.val === s[key]));
  });
  const togs = [['tog-close','closeTabOnSave'],['tog-hibernate','hibernate'],['tog-urls','showUrls'],['tog-anim','animate'],['tog-confirm','confirmDelete'],['tog-blur','blurPrivacy'],['tog-autoswitch','autoSwitchWorkspace']];
  togs.forEach(([id, key]) => { const el = document.getElementById(id); if (el) el.checked = !!s[key]; });
}

// ════════════════════════════════════════════════════════════════
// FOCUS MANAGEMENT (overlays + keyboard activation)
// ════════════════════════════════════════════════════════════════
const _overlayOpeners = new WeakMap();
function rememberOpener(el) {
  const opener = document.activeElement;
  if (opener && opener !== document.body) _overlayOpeners.set(el, opener);
}
function restoreOpener(el) {
  const opener = _overlayOpeners.get(el);
  if (opener && typeof opener.focus === 'function') {
    try { opener.focus(); } catch {}
  }
  _overlayOpeners.delete(el);
}
function focusFirstIn(el) {
  if (!el) return;
  const focusable = el.querySelector('input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
  if (focusable) { try { focusable.focus(); } catch {} }
}
function trapTabKey(e, container) {
  if (e.key !== 'Tab' || !container || container.classList.contains('hidden')) return;
  const items = container.querySelectorAll('input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])');
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (active === last || !container.contains(active))) { e.preventDefault(); first.focus(); }
}

// Ref-counted body-scroll lock. Nested overlays open/close independently
// without stepping on each other.
let _scrollLockCount = 0;
function lockBodyScroll() {
  if (_scrollLockCount++ === 0) document.body.style.overflow = 'hidden';
}
function unlockBodyScroll() {
  if (_scrollLockCount > 0 && --_scrollLockCount === 0) document.body.style.overflow = '';
}
function resetBodyScrollLock() {
  _scrollLockCount = 0;
  document.body.style.overflow = '';
}
function enableKeyboardClick(el) {
  if (!el || el.dataset.kbReady === '1') return;
  if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
  el.dataset.kbReady = '1';
}

// ════════════════════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════════════════════
let toastTimer;
function toast(msg, opts = {}) {
  const t = document.getElementById('toast');
  const m = document.getElementById('toast-msg');
  const u = document.getElementById('toast-undo');
  m.textContent = msg;
  t.classList.remove('hidden', 'danger');
  if (opts.danger) t.classList.add('danger');
  if (opts.undo) { u.classList.remove('hidden'); u.onclick = () => { performUndo(); t.classList.add('hidden'); }; }
  else u.classList.add('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), opts.duration || 3000);
}
function performUndo() { const l = State.undo(); if (l) { renderAll(); toast(`Undid: ${l}`); } }
function performRedo() { const l = State.redo(); if (l) { renderAll(); toast(`Redid`); } }

// ════════════════════════════════════════════════════════════════
// TABS (hibernated opens via suspended.html)
// ════════════════════════════════════════════════════════════════
// Instead of chrome.tabs.discard() (which races with Edge's built-in
// sleeping-tabs feature and can leave tabs at about:blank), we open
// a lightweight extension page that shows the title/favicon and only
// loads the real URL when the user clicks. This is the pattern used
// by The Great Suspender and Tablerone.

function buildSuspendedUrl({ url, title, fav }) {
  // Use hash/fragment so the real URL isn't sent as a query param over the wire
  const params = new URLSearchParams();
  if (url)   params.set('url', url);
  if (title) params.set('title', title);
  if (fav)   params.set('fav', fav);
  return chrome.runtime.getURL('suspended.html') + '#' + params.toString();
}

/**
 * Open a single tab. Single clicks are NEVER hibernated — the user
 * clicked it because they want to see it now.
 */
async function openTabMaybeHibernated(url, { focus = true } = {}) {
  if (focus) {
    return chrome.tabs.create({ url, active: true });
  }
  return openTabSuspended({ url });
}

/**
 * Open a hibernated tab. Uses the extension's suspended.html page so the
 * tab shows the correct title + favicon using near-zero memory. Clicking
 * the tab (which activates it) loads the real URL via JavaScript redirect.
 */
async function openTabSuspended({ url, title, fav }) {
  const hibernate = State.get().settings.hibernate;
  if (!hibernate) {
    return chrome.tabs.create({ url, active: false });
  }
  // Look up title/favicon from our saved item if not provided
  if (!title || !fav) {
    for (const ws of State.get().workspaces) {
      for (const cat of ws.categories) {
        for (const g of cat.groups) {
          const found = findInItemsByUrl(g.items, url);
          if (found) {
            title = title || found.title;
            fav = fav || found.fav;
            break;
          }
        }
      }
    }
  }
  // Derive a fav fallback
  if (!fav) {
    try { fav = `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`; } catch {}
  }
  const suspendedUrl = buildSuspendedUrl({ url, title, fav });
  return chrome.tabs.create({ url: suspendedUrl, active: false });
}

function findInItemsByUrl(items, url) {
  for (const it of items) {
    if (it.type === 'tab' && it.url === url) return it;
    if (it.type === 'stack' && it.items) {
      const f = findInItemsByUrl(it.items, url);
      if (f) return f;
    }
  }
  return null;
}

/**
 * Open many tabs at once, all suspended. Staggered slightly so the
 * browser tab strip animates in smoothly.
 */
async function openAllHibernated(urls, items) {
  // Build a lookup from URL to {title, fav}
  const meta = {};
  if (items) items.forEach(it => { if (it.type === 'tab') meta[it.url] = { title: it.title, fav: it.fav }; });
  const hibernate = State.get().settings.hibernate;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      if (i > 0) await new Promise(r => setTimeout(r, 50));
      if (hibernate) {
        const m = meta[url] || {};
        chrome.tabs.create({
          url: buildSuspendedUrl({ url, title: m.title, fav: m.fav }),
          active: false
        }).catch(() => {});
      } else {
        chrome.tabs.create({ url, active: false }).catch(() => {});
      }
    } catch {}
  }
}

// ════════════════════════════════════════════════════════════════
// REMINDERS
// ════════════════════════════════════════════════════════════════
let reminderCtx = null;
function openReminderPicker(itemId) {
  reminderCtx = { itemId };
  const info = findItem(itemId);
  const dt = document.getElementById('rm-datetime');
  const d = new Date();
  d.setHours(d.getHours() + 1); d.setMinutes(0);
  dt.value = d.toISOString().slice(0, 16);
  if (info?.item?.reminder) {
    const existing = new Date(info.item.reminder.at);
    dt.value = new Date(existing.getTime() - existing.getTimezoneOffset()*60000).toISOString().slice(0, 16);
  }
  document.getElementById('reminder-overlay').classList.remove('hidden');
}
function closeReminderPicker() {
  document.getElementById('reminder-overlay').classList.add('hidden');
  reminderCtx = null;
}
async function setReminder(itemId, ts) {
  const info = findItem(itemId);
  if (!info) return;
  State.snapshot('Set reminder');
  info.item.reminder = { at: ts, notified: false };
  try { await chrome.alarms.create('te-reminder-' + itemId, { when: ts }); } catch {}
  State.persist();
  renderBoard();
  toast('Reminder set');
}
async function clearReminder(itemId) {
  const info = findItem(itemId);
  if (!info) return;
  State.snapshot('Clear reminder');
  delete info.item.reminder;
  try { await chrome.alarms.clear('te-reminder-' + itemId); } catch {}
  State.persist();
  renderBoard();
  toast('Reminder cleared');
}

// ════════════════════════════════════════════════════════════════
// EMOJI PICKER
// ════════════════════════════════════════════════════════════════
let emojiPickerCtx = null;
let _emojiDataPromise = null;
let _emojiPickerBuilt = false;
// emoji-data.js is ~17KB and only needed when the picker opens. Defer to
// keep first-paint fast.
function loadEmojiData() {
  if (typeof EMOJI_DATA !== 'undefined') return Promise.resolve();
  if (_emojiDataPromise) return _emojiDataPromise;
  _emojiDataPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'emoji-data.js';
    s.onload = () => resolve();
    s.onerror = () => { _emojiDataPromise = null; reject(new Error('emoji-data load failed')); };
    document.head.appendChild(s);
  });
  return _emojiDataPromise;
}
function buildEmojiPicker() {
  if (typeof EMOJI_DATA === 'undefined') return; // deferred; will be built on first open
  if (_emojiPickerBuilt) return;
  const tabs = document.getElementById('ep-tabs');
  if (!tabs) return;
  _emojiPickerBuilt = true;
  tabs.innerHTML = '';
  EMOJI_DATA.categories.forEach((cat, i) => {
    const b = document.createElement('button');
    b.className = 'ep-tab' + (i === 1 ? ' active' : '');
    b.textContent = cat.label.split(' ')[0];
    b.title = cat.label;
    b.onclick = () => {
      document.querySelectorAll('.ep-tab').forEach(t => t.classList.remove('active'));
      b.classList.add('active');
      document.getElementById('ep-search-input').value = '';
      renderEmojiGrid(cat.id);
    };
    tabs.appendChild(b);
  });
  renderEmojiGrid('smileys');
}
function renderEmojiGrid(catId, search) {
  const grid = document.getElementById('ep-grid');
  grid.innerHTML = '';
  let emojis = [];
  if (search) {
    const q = search.toLowerCase();
    EMOJI_DATA.categories.forEach(c => { if (c.id !== 'recent') c.emojis.forEach(e => { if (e.k.includes(q)) emojis.push(e); }); });
  } else {
    const cat = EMOJI_DATA.categories.find(c => c.id === catId);
    if (cat) emojis = catId === 'recent' ? State.get().recentEmoji.map(e => ({ e, k:'' })) : cat.emojis;
  }
  if (!emojis.length) { grid.innerHTML = `<div class="ep-empty">No emojis</div>`; return; }
  emojis.slice(0, 200).forEach(em => {
    const b = document.createElement('button');
    b.className = 'ep-item'; b.textContent = em.e; b.title = em.k || '';
    b.onclick = () => selectEmoji(em.e);
    grid.appendChild(b);
  });
}
function openEmojiPicker(target, anchor) {
  emojiPickerCtx = { target, anchor };
  const ep = document.getElementById('emoji-picker');
  ep.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  let left = r.left, top = r.bottom + 6;
  if (left + 340 > window.innerWidth) left = window.innerWidth - 350;
  if (top + 340 > window.innerHeight) top = r.top - 346;
  ep.style.left = left + 'px'; ep.style.top = top + 'px';
  document.getElementById('ep-search-input').value = '';
  const grid = document.getElementById('ep-grid');
  // Show placeholder while emoji-data.js loads (first open only).
  if (typeof EMOJI_DATA === 'undefined') {
    if (grid) grid.innerHTML = `<div class="ep-empty">Loading…</div>`;
  }
  loadEmojiData()
    .then(() => { buildEmojiPicker(); renderEmojiGrid('smileys'); })
    .catch(() => { if (grid) grid.innerHTML = `<div class="ep-empty">Failed to load emojis</div>`; });
  setTimeout(() => {
    const close = e => { if (!ep.contains(e.target)) { ep.classList.add('hidden'); document.removeEventListener('click', close); emojiPickerCtx = null; } };
    document.addEventListener('click', close);
  }, 50);
  setTimeout(() => document.getElementById('ep-search-input')?.focus(), 80);
}
function selectEmoji(e) {
  if (!emojiPickerCtx) return;
  const { target } = emojiPickerCtx;
  const recent = State.get().recentEmoji;
  const idx = recent.indexOf(e);
  if (idx > -1) recent.splice(idx, 1);
  recent.unshift(e);
  if (recent.length > 24) recent.length = 24;
  EMOJI_DATA.categories[0].emojis = recent.map(x => ({ e: x, k: '' }));

  if (target.kind === 'modal') {
    document.getElementById('emoji-trigger-val').textContent = e;
  } else if (target.kind === 'sub-modal') {
    document.getElementById('sub-icon-val').textContent = e;
  } else if (target.kind === 'habit-icon') {
    document.getElementById('habit-new-icon-val').textContent = e;
  } else if (target.kind === 'group') {
    const info = findGroup(target.id);
    if (info) { State.snapshot('Change symbol'); info.group.symbol = e; State.persist(); renderBoard(); }
  } else if (target.kind === 'workspace') {
    const ws = State.get().workspaces.find(w => w.id === target.id);
    if (ws) { State.snapshot('Change symbol'); ws.symbol = e; State.persist(); renderAll(); }
  } else if (target.kind === 'stack') {
    const info = findItem(target.id);
    if (info) { State.snapshot('Change symbol'); info.item.symbol = e; State.persist(); renderBoard(); }
  }
  State.persist();
  document.getElementById('emoji-picker').classList.add('hidden');
  emojiPickerCtx = null;
}

// ════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ════════════════════════════════════════════════════════════════
function showContextMenu(x, y, items, opts) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  items.forEach(it => {
    if (it.sep) menu.appendChild(Object.assign(document.createElement('div'), { className: 'cm-sep' }));
    else if (it.label) { const l = document.createElement('div'); l.className = 'cm-label'; l.textContent = it.label; menu.appendChild(l); }
    else {
      const el = document.createElement('div');
      el.className = 'cm-item' + (it.danger ? ' danger' : '');
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'menuitem');
      el.innerHTML = `${it.icon || ''}<span>${esc(it.text)}</span>${it.sub ? `<span class="cm-sub">${esc(it.sub)}</span>` : ''}`;
      el.onclick = ev => { ev.stopPropagation(); hideContextMenu(); it.action && it.action(); };
      menu.appendChild(el);
    }
  });
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 300;
  let mx = x, my = y;
  if (x + mw > window.innerWidth) mx = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight) my = window.innerHeight - mh - 8;
  menu.style.left = mx + 'px'; menu.style.top = my + 'px';
  const menuOpener = document.activeElement;
  const menuKey = e => {
    if (menu.classList.contains('hidden')) return;
    const entries = [...menu.querySelectorAll('.cm-item')];
    if (!entries.length) return;
    const cur = entries.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); entries[(cur + 1 + entries.length) % entries.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); entries[(cur - 1 + entries.length) % entries.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); entries[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); entries[entries.length - 1].focus(); }
    else if (e.key === 'Enter' || e.key === ' ') {
      if (cur >= 0) { e.preventDefault(); entries[cur].click(); }
    } else if (e.key === 'Escape') {
      e.preventDefault(); hideContextMenu();
      if (menuOpener && menuOpener.focus) menuOpener.focus();
    }
  };
  menu.addEventListener('keydown', menuKey);
  setTimeout(() => {
    if (opts && opts.focusFirst) {
      const first = menu.querySelector('.cm-item');
      if (first) first.focus();
    }
    const close = e => { if (!menu.contains(e.target)) { hideContextMenu(); document.removeEventListener('click', close); document.removeEventListener('contextmenu', close); menu.removeEventListener('keydown', menuKey); } };
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
  }, 50);
}
function hideContextMenu() { document.getElementById('context-menu').classList.add('hidden'); }

const cmIcons = {
  edit: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L4 10l-2.5.5L2 8l6.5-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  delete: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V1.5h3V3M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  archive: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="2" width="9" height="2" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 4v6h7V4M5 7h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  copy: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>',
  open: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5H2a1 1 0 00-1 1v6.5A1 1 0 002 11h6.5a1 1 0 001-1V8M7 1h4m0 0v4M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  color: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2"/></svg>',
  symbol: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 6h3M6 4.5v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  clock: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 3v3l2 1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  stack: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3l4-2 4 2-4 2-4-2zM2 6l4 2 4-2M2 9l4 2 4-2" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  move: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8M4 4l-2 2 2 2M8 4l2 2-2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ════════════════════════════════════════════════════════════════
// ARCHIVE
// ════════════════════════════════════════════════════════════════
function archiveItem(itemId) {
  const info = findItem(itemId);
  if (!info) return;
  State.snapshot('Archive item');
  const [removed] = info.parent.splice(info.index, 1);
  State.get().archive.unshift({ kind:'item', data: removed, groupName: info.group.name, at: Date.now() });
  if (State.get().archive.length > 200) State.get().archive.pop();
  State.persist();
  renderBoard();
  renderArchiveList();
  toast('Archived', { undo: true });
}
function archiveGroup(gId) {
  const info = findGroup(gId);
  if (!info) return;
  State.snapshot('Archive group');
  const idx = info.cat.groups.findIndex(g => g.id === gId);
  const [removed] = info.cat.groups.splice(idx, 1);
  State.get().archive.unshift({ kind:'group', data: removed, catName: info.cat.name, at: Date.now() });
  State.persist();
  renderBoard();
  renderArchiveList();
  toast('Group archived', { undo: true });
}
function restoreArchive(idx) {
  const s = State.get();
  const entry = s.archive[idx];
  if (!entry) return;
  State.snapshot('Restore');
  s.archive.splice(idx, 1);
  const cat = activeCat();
  if (entry.kind === 'item') {
    let inbox = cat.groups.find(g => g.name === 'Inbox');
    if (!inbox) { inbox = { id: uid(), name:'Inbox', symbol:'📥', color:'#6366f1', collapsed:false, items:[] }; cat.groups.unshift(inbox); }
    inbox.items.push(entry.data);
  } else {
    cat.groups.push(entry.data);
  }
  State.persist();
  renderBoard();
  renderArchiveList();
  toast('Restored');
}
function permDelete(idx) {
  State.snapshot('Perm delete');
  State.get().archive.splice(idx, 1);
  State.persist();
  renderArchiveList();
}

// ════════════════════════════════════════════════════════════════
// CRUD
// ════════════════════════════════════════════════════════════════
function createGroup({ name, symbol, color }) {
  const cat = activeCat(); if (!cat) return;
  State.snapshot('Create group');
  cat.groups.push({ id: uid(), name: name || 'New Group', symbol: symbol || '📁', color: color || '#6366f1', collapsed: false, items: [] });
  State.persist(); renderBoard();
}
function deleteGroup(gId, skipConfirm) {
  const info = findGroup(gId);
  if (!info) return;
  if (!skipConfirm && State.get().settings.confirmDelete && !confirm(`Delete "${info.group.name}"? (It will be archived)`)) return;
  archiveGroup(gId);
}
function duplicateGroup(gId) {
  const info = findGroup(gId);
  if (!info) return;
  State.snapshot('Duplicate group');
  const copy = JSON.parse(JSON.stringify(info.group));
  copy.id = uid(); copy.name = info.group.name + ' (copy)';
  const reassign = (items) => items.forEach(it => {
    it.id = uid();
    if (it.type === 'stack' && it.items) reassign(it.items);
  });
  reassign(copy.items);
  const idx = info.cat.groups.findIndex(x => x.id === gId);
  info.cat.groups.splice(idx + 1, 0, copy);
  State.persist(); renderBoard();
}

function moveGroupToCategory(gId, catId) {
  const info = findGroup(gId);
  if (!info) return;
  const ws = activeWs();
  const targetCat = ws.categories.find(c => c.id === catId);
  if (!targetCat) return;
  State.snapshot('Move group to category');
  const idx = info.cat.groups.findIndex(g => g.id === gId);
  const [g] = info.cat.groups.splice(idx, 1);
  targetCat.groups.push(g);
  State.persist();
  renderAll();
  toast(`Moved to ${targetCat.name}`, { undo: true });
}

function moveGroupToNewCategory(gId) {
  const name = prompt('New category name:', '');
  if (!name || !name.trim()) return;
  const ws = activeWs(); if (!ws) return;
  State.snapshot('New category + move');
  const newCat = { id: uid(), name: name.trim(), groups: [] };
  ws.categories.push(newCat);
  const info = findGroup(gId);
  if (info) {
    const idx = info.cat.groups.findIndex(g => g.id === gId);
    const [g] = info.cat.groups.splice(idx, 1);
    newCat.groups.push(g);
  }
  State.persist();
  renderAll();
  toast(`Moved to "${name.trim()}"`, { undo: true });
}
function openGroupAll(gId) {
  const info = findGroup(gId);
  if (!info) return;
  const items = [];
  const collect = (list) => { list.forEach(it => { if (it.type === 'tab') items.push(it); else if (it.type === 'stack') collect(it.items || []); }); };
  collect(info.group.items);
  if (!items.length) return toast('No tabs to open');
  const urls = items.map(it => it.url);
  openAllHibernated(urls, items);
  toast(`Opened ${urls.length} tabs`);
}

// ════════════════════════════════════════════════════════════════
// MODAL (group create/edit)
// ════════════════════════════════════════════════════════════════
let modalCtx = null;
let intentEditorCtx = null;
function openModal(kind, ctx) {
  modalCtx = { kind, ctx };
  const $t = document.getElementById('modal-title');
  const $ok = document.getElementById('modal-ok');
  const $inp = document.getElementById('modal-input');
  const $cLbl = document.getElementById('lbl-color');
  const $sLbl = document.getElementById('lbl-symbol');
  const $cRow = document.getElementById('color-row');
  const $sym = document.getElementById('emoji-trigger-val');
  const emTrig = document.getElementById('emoji-trigger');

  const showColor = true, showSym = true;
  $cLbl.style.display = showColor ? '' : 'none';
  $cRow.style.display = showColor ? '' : 'none';
  $sLbl.style.display = showSym ? '' : 'none';
  emTrig.style.display = showSym ? '' : 'none';

  if (kind === 'new-group') { $t.textContent = 'New Group'; $ok.textContent = 'Create'; $inp.value = ''; $sym.textContent = '📁'; selColor('#6366f1'); }
  else if (kind === 'edit-group') { $t.textContent = 'Edit Group'; $ok.textContent = 'Save'; $inp.value = ctx.name; $sym.textContent = ctx.symbol || '📁'; selColor(ctx.color || '#6366f1'); }
  else if (kind === 'new-ws') { $t.textContent = 'New Workspace'; $ok.textContent = 'Create'; $inp.value = ''; $sym.textContent = '🏠'; $cLbl.style.display = 'none'; $cRow.style.display = 'none'; }
  else if (kind === 'new-cat') { $t.textContent = 'New Category'; $ok.textContent = 'Create'; $inp.value = ''; $sLbl.style.display = 'none'; emTrig.style.display = 'none'; $cLbl.style.display = 'none'; $cRow.style.display = 'none'; }
  else if (kind === 'new-stack') { $t.textContent = 'New Stack'; $ok.textContent = 'Create'; $inp.value = ''; $sym.textContent = '📚'; selColor('#6366f1'); }

  const overlay = document.getElementById('modal-overlay');
  rememberOpener(overlay);
  overlay.classList.remove('hidden');
  setTimeout(() => $inp.focus(), 50);
}
function selColor(c) {
  document.querySelectorAll('.csw').forEach(x => x.classList.toggle('active', x.dataset.c === c));
}
function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('hidden');
  restoreOpener(overlay);
  modalCtx = null;
}
function openIntentEditor(targetKind, targetId) {
  let entity = null;
  let title = 'Edit Intention';
  if (targetKind === 'group') {
    const info = findGroup(targetId);
    if (!info) return;
    entity = info.group;
    title = `Intention · ${info.group.name}`;
  } else if (targetKind === 'stack') {
    const info = findItem(targetId);
    if (!info || info.item.type !== 'stack') return;
    entity = info.item;
    title = `Intention · ${info.item.name || 'Stack'}`;
  }
  intentEditorCtx = { targetKind, targetId };
  const intent = entity.intent || {};
  document.getElementById('intent-title').textContent = title;
  document.getElementById('intent-purpose').value = intent.purpose || '';
  document.getElementById('intent-next-action').value = intent.nextAction || '';
  document.getElementById('intent-status').value = intent.status || 'active';
  document.getElementById('intent-type').value = intent.type || 'other';
  document.getElementById('intent-overlay').classList.remove('hidden');
}
function closeIntentEditor() {
  document.getElementById('intent-overlay').classList.add('hidden');
  intentEditorCtx = null;
}
function getIntentTarget(ctx = intentEditorCtx) {
  if (!ctx) return null;
  if (ctx.targetKind === 'group') return findGroup(ctx.targetId)?.group || null;
  if (ctx.targetKind === 'stack') {
    const info = findItem(ctx.targetId);
    if (info?.item?.type === 'stack') return info.item;
  }
  return null;
}
function saveIntentEditor() {
  const entity = getIntentTarget();
  if (!entity) return closeIntentEditor();
  const purpose = document.getElementById('intent-purpose').value.trim();
  const nextAction = document.getElementById('intent-next-action').value.trim();
  const status = document.getElementById('intent-status').value;
  const type = document.getElementById('intent-type').value;
  State.snapshot('Edit intention');
  if (!purpose && !nextAction && status === 'active' && type === 'other') clearIntentMeta(entity);
  else {
    const i = ensureIntentMeta(entity);
    i.purpose = purpose;
    i.nextAction = nextAction;
    i.status = INTENT_STATUS.includes(status) ? status : 'active';
    i.type = INTENT_TYPE.includes(type) ? type : 'other';
    i.updatedAt = Date.now();
  }
  State.persist();
  renderBoard();
  closeIntentEditor();
  toast('Intention saved');
}
function clearIntentEditor() {
  const entity = getIntentTarget();
  if (!entity) return closeIntentEditor();
  State.snapshot('Clear intention');
  clearIntentMeta(entity);
  State.persist();
  renderBoard();
  closeIntentEditor();
  toast('Intention cleared', { undo: true });
}
function confirmModal() {
  if (!modalCtx) return;
  const name = document.getElementById('modal-input').value.trim();
  const sym = document.getElementById('emoji-trigger-val').textContent || '📁';
  const cEl = document.querySelector('.csw.active');
  const color = cEl ? cEl.dataset.c : '#6366f1';
  const { kind, ctx } = modalCtx;

  if (kind === 'new-group') createGroup({ name: name || 'New Group', symbol: sym, color });
  else if (kind === 'edit-group') {
    State.snapshot('Edit group');
    ctx.name = name || ctx.name; ctx.symbol = sym; ctx.color = color;
    State.persist(); renderBoard();
  } else if (kind === 'new-ws') {
    State.snapshot('New workspace');
    const ws = { id: uid(), name: name || 'New Workspace', symbol: sym, categories: [{ id: uid(), name:'Quicklinks', groups:[] }] };
    ws.activeCatId = ws.categories[0].id;
    State.get().workspaces.push(ws);
    State.get().activeWsId = ws.id;
    State.persist(); renderAll();
  } else if (kind === 'new-cat') {
    State.snapshot('New category');
    const ws = activeWs();
    const nc = { id: uid(), name: name || 'New Category', groups: [] };
    ws.categories.push(nc);
    ws.activeCatId = nc.id;
    State.persist(); renderAll();
  } else if (kind === 'new-stack') {
    State.snapshot('New stack');
    if (ctx && ctx.groupId) {
      const info = findGroup(ctx.groupId);
      if (info) {
        info.group.items.push({ id: uid(), type:'stack', name: name || 'New Stack', symbol: sym, color, expanded: true, items: [] });
        State.persist(); renderBoard();
      }
    }
  }
  closeModal();
}

// ════════════════════════════════════════════════════════════════
// OPEN-TABS SIDEBAR + Multi-select + Window grouping
// ════════════════════════════════════════════════════════════════
let allOpenTabs = [];
let currentActiveTabId = null;
let selectedTabIds = new Set();
let lastClickedTabId = null;

async function refreshOpenTabs() {
  try {
    const [activeArr, all] = await Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.tabs.query({ currentWindow: true })  // Current window only for sidebar
    ]);
    allOpenTabs = all.filter(t => !isProto(t.url));
    currentActiveTabId = activeArr[0]?.id;
    document.getElementById('open-count').textContent = allOpenTabs.length;
    renderOpenTabs();
  } catch (e) { console.warn('refreshOpenTabs', e); }
}

function renderOpenTabs() {
  const $el = document.getElementById('open-tabs');
  const scrollPos = $el.scrollTop;
  $el.innerHTML = '';

  // Clean stale selections
  const validIds = new Set(allOpenTabs.map(t => t.id));
  for (const id of [...selectedTabIds]) if (!validIds.has(id)) selectedTabIds.delete(id);
  // Drop the shift-range anchor once nothing is selected so the next
  // shift-click starts a fresh range instead of spanning from a stale tab.
  if (!selectedTabIds.size) lastClickedTabId = null;

  if (!allOpenTabs.length) {
    $el.innerHTML = `<div class="otab-empty">No saveable tabs in this window.</div>`;
    return;
  }

  allOpenTabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'otab';
    el.dataset.tid = t.id;
    if (t.id === currentActiveTabId) el.classList.add('active-tab');
    if (selectedTabIds.has(t.id)) el.classList.add('selected');
    el.draggable = true;
    el.title = t.title || t.url;
    const fav = t.favIconUrl || favUrl(t.url);
    el.innerHTML = `
      <span class="otab-check" aria-label="Select"></span>
      <img src="${esc(fav)}" alt="" loading="lazy" decoding="async" onerror="this.src='${BLANK_FAV}'">
      <span class="otab-title">${esc(t.title || t.url)}</span>`;

    // Checkbox area click — toggles selection without switching tab
    el.querySelector('.otab-check').addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedTabIds.has(t.id)) selectedTabIds.delete(t.id);
      else selectedTabIds.add(t.id);
      lastClickedTabId = t.id;
      updateSelectedBadge();
      renderOpenTabs();
    });

    el.addEventListener('click', (e) => {
      // Ignore clicks that happen to be on the check
      if (e.target.closest('.otab-check')) return;

      if (e.shiftKey && lastClickedTabId != null) {
        const aI = allOpenTabs.findIndex(x => x.id === lastClickedTabId);
        const bI = allOpenTabs.findIndex(x => x.id === t.id);
        if (aI > -1 && bI > -1) {
          const [lo, hi] = aI < bI ? [aI, bI] : [bI, aI];
          for (let k = lo; k <= hi; k++) selectedTabIds.add(allOpenTabs[k].id);
        }
        lastClickedTabId = t.id;
        updateSelectedBadge();
        renderOpenTabs();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (selectedTabIds.has(t.id)) selectedTabIds.delete(t.id);
        else selectedTabIds.add(t.id);
        lastClickedTabId = t.id;
        updateSelectedBadge();
        renderOpenTabs();
        return;
      }
      // In selection mode: click to add/toggle, not switch
      if (selectedTabIds.size > 0) {
        if (selectedTabIds.has(t.id)) selectedTabIds.delete(t.id);
        else selectedTabIds.add(t.id);
        lastClickedTabId = t.id;
        updateSelectedBadge();
        renderOpenTabs();
        return;
      }
      // Plain click → switch tab
      chrome.tabs.update(t.id, { active: true }).catch(()=>{});
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const batch = selectedTabIds.has(t.id) && selectedTabIds.size > 1;
      showContextMenu(e.pageX, e.pageY, [
        { text:'Switch to tab', icon: cmIcons.open, action: () => chrome.tabs.update(t.id, { active: true }) },
        { text: selectedTabIds.has(t.id) ? 'Deselect' : 'Select', icon: cmIcons.edit, action: () => { if (selectedTabIds.has(t.id)) selectedTabIds.delete(t.id); else selectedTabIds.add(t.id); lastClickedTabId = t.id; updateSelectedBadge(); renderOpenTabs(); } },
        batch ? { text:`Save ${selectedTabIds.size} selected as new group`, icon: cmIcons.stack, action: () => saveSelectedAsGroup() } : null,
        { sep: true },
        { text: batch ? `Save ${selectedTabIds.size} tabs to Inbox` : 'Save to Inbox', icon: cmIcons.archive, action: () => batch ? saveSelectedToInbox() : saveTabToInbox(t) },
        { text: batch ? `Close ${selectedTabIds.size} tabs` : 'Close tab', icon: cmIcons.delete, danger:true, action: () => { if (batch) { for (const id of selectedTabIds) chrome.tabs.remove(id).catch(()=>{}); selectedTabIds.clear(); updateSelectedBadge(); } else chrome.tabs.remove(t.id); } }
      ].filter(Boolean));
    });

    // ── DRAG ── Promote to multi-drag if the dragged tab is selected
    el.addEventListener('dragstart', (e) => {
      let inBatch = selectedTabIds.has(t.id) && selectedTabIds.size > 1;
      // If user starts dragging an unselected tab while a batch exists, keep it single
      if (inBatch) {
        const tabs = allOpenTabs.filter(x => selectedTabIds.has(x.id));
        drag = { kind: 'tabs-multi', data: tabs.map(x => ({ tabId: x.id, title: x.title, url: x.url, fav: x.favIconUrl })) };
        // Mark all selected tabs as dragging visually
        document.querySelectorAll('.otab.selected').forEach(x => x.classList.add('dragging'));
        // Custom drag image showing count
        try {
          const ghost = document.createElement('div');
          ghost.className = 'multi-drag-ghost';
          ghost.textContent = `${tabs.length} tabs`;
          document.body.appendChild(ghost);
          ghost.style.position = 'absolute';
          ghost.style.left = '-9999px';
          e.dataTransfer.setDragImage(ghost, 40, 15);
          setTimeout(() => ghost.remove(), 0);
        } catch {}
      } else {
        drag = { kind:'tab', data: { tabId:t.id, title:t.title, url:t.url, fav:t.favIconUrl } };
        el.classList.add('dragging');
      }
      e.dataTransfer.effectAllowed = 'copyMove';
      try { e.dataTransfer.setData('text/plain', t.url); } catch {}
    });
    el.addEventListener('dragend', () => {
      document.querySelectorAll('.otab.dragging').forEach(x => x.classList.remove('dragging'));
      document.querySelectorAll('.dragover, .drop-target').forEach(x => { x.classList.remove('dragover'); x.classList.remove('drop-target'); });
      document.querySelectorAll('.drag-ghost').forEach(x => x.remove());
      drag = null;
    });

    $el.appendChild(el);
  });
  applyFilter();
  $el.scrollTop = scrollPos;
}
function updateSelectedBadge() {
  const b = document.getElementById('selected-badge');
  if (selectedTabIds.size) {
    b.innerHTML = `
      <span class="sel-count">${selectedTabIds.size}</span>
      <span class="sel-lbl">selected</span>
      <button class="sel-act" data-act="save" title="Save as group">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2h7l2 2v7H2V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      </button>
      <button class="sel-act" data-act="inbox" title="Save to Inbox">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1v7m0 0l-2-2m2 2l2-2M2 8v2h8V8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="sel-act" data-act="clear" title="Clear selection">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>`;
    b.classList.remove('hidden');
    b.querySelectorAll('.sel-act').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'save') saveSelectedAsGroup();
        else if (act === 'inbox') saveSelectedToInbox();
        else if (act === 'clear') { selectedTabIds.clear(); lastClickedTabId = null; updateSelectedBadge(); renderOpenTabs(); }
      };
    });
  } else {
    b.classList.add('hidden');
  }
}

async function saveSelectedToInbox() {
  const tabs = allOpenTabs.filter(t => selectedTabIds.has(t.id));
  if (!tabs.length) return;
  const cat = activeCat(); if (!cat) return;
  let inbox = cat.groups.find(g => g.name === 'Inbox');
  if (!inbox) { inbox = { id: uid(), name:'Inbox', symbol:'📥', color:'#6366f1', collapsed:false, items:[] }; cat.groups.unshift(inbox); }
  State.snapshot(`Save ${tabs.length} to inbox`);
  let added = 0;
  for (const t of tabs) {
    if (inbox.items.find(it => it.type === 'tab' && it.url === t.url)) continue;
    inbox.items.push({ id: uid(), type:'tab', title: t.title||'Untitled', url: t.url, fav: t.favIconUrl||'' });
    added++;
  }
  if (State.get().settings.closeTabOnSave) { for (const t of tabs) { try { await chrome.tabs.remove(t.id); } catch {} } }
  selectedTabIds.clear();
  State.persist(); renderBoard(); updateSelectedBadge();
  toast(`Saved ${added} to Inbox`, { undo: true });
}
function applyFilter() {
  const q = document.getElementById('tab-filter').value.toLowerCase().trim();
  // Build id→tab map once instead of O(n²) find() per row.
  const byId = new Map();
  for (const t of allOpenTabs) byId.set(String(t.id), t);
  document.querySelectorAll('#open-tabs .otab').forEach(el => {
    const t = byId.get(el.dataset.tid);
    if (!t) return;
    const match = !q || (t.title||'').toLowerCase().includes(q) || (t.url||'').toLowerCase().includes(q);
    el.classList.toggle('hidden', !match);
  });
}

async function saveTabToInbox(t) {
  const cat = activeCat();
  let inbox = cat.groups.find(g => g.name === 'Inbox');
  if (!inbox) { inbox = { id: uid(), name:'Inbox', symbol:'📥', color:'#6366f1', collapsed:false, items:[] }; cat.groups.unshift(inbox); }
  if (inbox.items.find(it => it.type === 'tab' && it.url === t.url)) { toast('Already saved', { danger: true }); return; }
  State.snapshot('Save to inbox');
  inbox.items.push({ id: uid(), type:'tab', title: t.title||'Untitled', url: t.url, fav: t.favIconUrl||'' });
  if (State.get().settings.closeTabOnSave) { try { await chrome.tabs.remove(t.id); } catch {} }
  State.persist(); renderBoard(); toast('Saved to Inbox', { undo: true });
}
async function saveSelectedAsGroup() {
  const tabs = allOpenTabs.filter(t => selectedTabIds.has(t.id));
  if (!tabs.length) return;
  const cat = activeCat();
  State.snapshot(`Save ${tabs.length} tabs`);
  const now = new Date();
  const g = {
    id: uid(), symbol:'📂', color:'#6366f1', collapsed:false,
    name: `${tabs.length} tabs ${now.toLocaleDateString('en',{month:'short',day:'numeric'})}`,
    items: tabs.map(t => ({ id: uid(), type:'tab', title:t.title||'Untitled', url:t.url, fav:t.favIconUrl||'' }))
  };
  cat.groups.push(g);
  if (State.get().settings.closeTabOnSave) { for (const t of tabs) { try { await chrome.tabs.remove(t.id); } catch {} } }
  selectedTabIds.clear();
  State.persist(); renderBoard(); updateSelectedBadge();
  toast(`Saved ${tabs.length} tabs`, { undo: true });
}

async function saveAllTabs() {
  const cat = activeCat(); if (!cat) return;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const valid = tabs.filter(t => !isProto(t.url));
  if (!valid.length) return toast('No tabs to save');
  State.snapshot('Save all tabs');
  const now = new Date();
  cat.groups.push({
    id: uid(), symbol:'💾', color:'#06b6d4', collapsed:false,
    name:`Session ${now.toLocaleDateString('en',{month:'short',day:'numeric'})} ${now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`,
    items: valid.map(t => ({ id: uid(), type:'tab', title:t.title||'Untitled', url:t.url, fav:t.favIconUrl||'' }))
  });
  if (State.get().settings.closeTabOnSave) {
    const others = valid.slice(1);
    for (const t of others) { try { await chrome.tabs.remove(t.id); } catch {} }
  }
  State.persist(); renderBoard(); toast(`Saved ${valid.length} tabs`, { undo: true });
}

// ════════════════════════════════════════════════════════════════
// RENDER (diff-based for items)
// ════════════════════════════════════════════════════════════════
function renderAll() { renderHeader(); renderWsList(); renderCategoryTabs(); renderBoard(); }

async function renderHeader() {
  const ws = activeWs(); if (!ws) return;
  const titleSym = document.getElementById('ws-title-sym');
  if (titleSym) titleSym.textContent = ws.symbol || '🏠';
  const titleNm = document.getElementById('ws-title-name');
  if (titleNm) titleNm.textContent = ws.name;
  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) undoBtn.classList.toggle('disabled', !State.canUndo());
  await renderWsChips();
}

// ─── Workspace chips (one per open browser window) ───
async function renderWsChips() {
  const $stack = document.getElementById('ws-chips-stack');
  if (!$stack) return;
  const s = State.get();

  let windows = [];
  try { windows = await chrome.windows.getAll({ populate: false }); } catch {}

  if (s.settings.windowSync !== false) {
    for (const w of windows) {
      const boundWs = s.workspaces.find(ws => ws.windowId === w.id);
      if (!boundWs) {
        const orphan = s.workspaces.find(ws => !ws.windowId);
        if (orphan && !s.workspaces.some(x => x.windowId === w.id)) orphan.windowId = w.id;
      }
    }
    const openIds = new Set(windows.map(w => w.id));
    s.workspaces.forEach(ws => { if (ws.windowId && !openIds.has(ws.windowId)) delete ws.windowId; });
    try {
      const cur = await chrome.windows.getCurrent();
      if (s.settings.autoSwitchWorkspace) {
        const match = s.workspaces.find(ws => ws.windowId === cur.id);
        if (match && match.id !== s.activeWsId) s.activeWsId = match.id;
      }
    } catch {}
  }

  $stack.innerHTML = '';
  const liveWorkspaces = s.workspaces.filter(ws => ws.windowId && windows.some(w => w.id === ws.windowId));
  liveWorkspaces.forEach(ws => $stack.appendChild(buildWsChip(ws, { live: true })));

  // If the active workspace is NOT bound to any window (saved/dormant), show it as active chip too
  const activeW = activeWs();
  if (activeW && !liveWorkspaces.some(x => x.id === activeW.id)) {
    $stack.appendChild(buildWsChip(activeW, { live: false }));
  }

  const otherCount = s.workspaces.length - liveWorkspaces.length - (activeW && !liveWorkspaces.some(x => x.id === activeW.id) ? 1 : 0);
  if (otherCount > 0) {
    const more = document.createElement('button');
    more.className = 'ws-chip ws-chip-more';
    more.title = `${otherCount} saved workspace${otherCount > 1 ? 's' : ''}`;
    more.innerHTML = `<span>+${otherCount}</span>`;
    more.onclick = () => openWsGrid();
    $stack.appendChild(more);
  }
}

function buildWsChip(ws, { live }) {
  const chip = document.createElement('button');
  chip.className = 'ws-chip' + (ws.id === State.get().activeWsId ? ' active' : '') + (live ? ' live' : '');
  chip.dataset.wsid = ws.id;
  chip.title = ws.name + (live ? ' · live window' : '');
  chip.innerHTML = `
    <span class="ws-chip-sym">${esc(ws.symbol || '🏠')}</span>
    ${live ? '<span class="ws-chip-live-dot"></span>' : ''}`;
  chip.onclick = async () => {
    State.get().activeWsId = ws.id;
    State.persist();
    renderAll();
    if (ws.windowId) { try { await chrome.windows.update(ws.windowId, { focused: true }); } catch {} }
  };
  chip.oncontextmenu = e => {
    e.preventDefault();
    const items = [
      { text:'Rename', icon: cmIcons.edit, action: () => { const n = prompt('Rename:', ws.name); if (n) { State.snapshot('Rename ws'); ws.name = n; State.persist(); renderAll(); } } },
      { text:'Change symbol…', icon: cmIcons.symbol, action: () => openEmojiPicker({ kind:'workspace', id: ws.id }, chip) },
      { sep: true }
    ];
    if (ws.windowId) items.push({ text:'Unbind from window', icon: cmIcons.move, action: () => { State.snapshot('Unbind'); delete ws.windowId; State.persist(); renderAll(); } });
    if (State.get().workspaces.length > 1) items.push({ text:'Delete workspace', icon: cmIcons.delete, danger: true, action: () => { if (confirm(`Delete "${ws.name}"?`)) { State.snapshot('Delete ws'); State.get().workspaces = State.get().workspaces.filter(x => x.id !== ws.id); if (State.get().activeWsId === ws.id) State.get().activeWsId = State.get().workspaces[0].id; State.persist(); renderAll(); } } });
    showContextMenu(e.pageX, e.pageY, items);
  };
  return chip;
}

function renderWsList() {
  const $l = document.getElementById('ws-list');
  $l.innerHTML = '';
  const s = State.get();
  s.workspaces.forEach(ws => {
    const el = document.createElement('div');
    el.className = 'ws-item' + (ws.id === s.activeWsId ? ' active' : '');
    el.innerHTML = `<span class="sym">${esc(ws.symbol||'🏠')}</span><span class="name">${esc(ws.name)}</span>`;
    el.onclick = () => { State.get().activeWsId = ws.id; $l.classList.add('hidden'); State.persist(); renderAll(); };
    $l.appendChild(el);
  });
}

let _catTabsInitialized = false;
function renderCategoryTabs() {
  const ws = activeWs(); if (!ws) return;
  const $c = document.getElementById('cat-tabs');
  // Preserve keyboard focus across re-renders (otherwise arrow-key nav resets focus to body).
  const refocusActive = $c.contains(document.activeElement) && document.activeElement.classList?.contains('cat-tab');
  $c.innerHTML = '';
  const frag = document.createDocumentFragment();
  ws.categories.forEach(cat => {
    const b = document.createElement('button');
    b.className = 'cat-tab' + (cat.id === ws.activeCatId ? ' active' : '');
    b.dataset.cid = cat.id;
    b.textContent = cat.name;
    b.onclick = () => { ws.activeCatId = cat.id; State.persist(); renderCategoryTabs(); renderBoard(); };
    b.ondblclick = () => {
      const nn = prompt('Rename category:', cat.name);
      if (nn && nn.trim()) { State.snapshot('Rename cat'); cat.name = nn.trim(); State.persist(); renderCategoryTabs(); }
    };
    b.oncontextmenu = e => {
      e.preventDefault();
      showContextMenu(e.pageX, e.pageY, [
        { text:'Rename', icon: cmIcons.edit, action: () => { const nn = prompt('Rename category:', cat.name); if (nn && nn.trim()) { State.snapshot('Rename cat'); cat.name = nn.trim(); State.persist(); renderCategoryTabs(); } } },
        ws.categories.length > 1 ? { text:'Delete', icon: cmIcons.delete, danger: true, action: () => { if (confirm(`Delete "${cat.name}"?`)) { State.snapshot('Delete cat'); ws.categories = ws.categories.filter(c => c.id !== cat.id); if (ws.activeCatId === cat.id) ws.activeCatId = ws.categories[0].id; State.persist(); renderAll(); } } } : null
      ].filter(Boolean));
    };

    // Drag reorder
    b.draggable = true;
    b.ondragstart = e => {
      drag = { kind:'cat', srcId: cat.id };
      b.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    };
    b.ondragend = () => { b.classList.remove('dragging'); document.querySelectorAll('.cat-tab').forEach(x => { x.classList.remove('drop-before'); x.classList.remove('drop-after'); }); drag = null; };
    b.ondragover = e => {
      if (drag?.kind === 'cat' && drag.srcId !== cat.id) {
        e.preventDefault();
        const r = b.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        document.querySelectorAll('.cat-tab').forEach(x => { x.classList.remove('drop-before'); x.classList.remove('drop-after'); });
        b.classList.add(after ? 'drop-after' : 'drop-before');
      }
    };
    b.ondrop = e => {
      if (drag?.kind === 'cat' && drag.srcId !== cat.id) {
        e.preventDefault();
        const r = b.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        State.snapshot('Reorder cat');
        const srcIdx = ws.categories.findIndex(c => c.id === drag.srcId);
        const [src] = ws.categories.splice(srcIdx, 1);
        let tgtIdx = ws.categories.findIndex(c => c.id === cat.id);
        if (after) tgtIdx++;
        ws.categories.splice(tgtIdx, 0, src);
        State.persist(); renderCategoryTabs();
      }
    };
    frag.appendChild(b);
  });
  $c.appendChild(frag);
  // Scroll the active tab into view; first render snaps without animation.
  const activeBtn = $c.querySelector('.cat-tab.active');
  if (activeBtn) {
    if (_catTabsInitialized) activeBtn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    else activeBtn.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'auto' });
    if (refocusActive) { try { activeBtn.focus({ preventScroll: true }); } catch { activeBtn.focus(); } }
  }
  _catTabsInitialized = true;
  updateCatScrollState();
}

function updateCatScrollState() {
  const $c = document.getElementById('cat-tabs');
  const $w = document.getElementById('cat-tabs-wrap');
  if (!$c || !$w) return;
  const max = $c.scrollWidth - $c.clientWidth;
  const left = $c.scrollLeft;
  // 2px tolerance for sub-pixel rounding.
  $w.classList.toggle('can-scroll-left', left > 2);
  $w.classList.toggle('can-scroll-right', left < max - 2);
}

function bindCatScroll() {
  const $c = document.getElementById('cat-tabs');
  const $w = document.getElementById('cat-tabs-wrap');
  if (!$c || !$w) return;
  const STEP = 160;
  const left = document.getElementById('cat-scroll-left');
  const right = document.getElementById('cat-scroll-right');
  if (left) left.addEventListener('click', () => $c.scrollBy({ left: -STEP, behavior: 'smooth' }));
  if (right) right.addEventListener('click', () => $c.scrollBy({ left: STEP, behavior: 'smooth' }));
  $c.addEventListener('scroll', rafThrottle(updateCatScrollState), { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(rafThrottle(updateCatScrollState));
    ro.observe($c);
    ro.observe($w);
  } else {
    window.addEventListener('resize', rafThrottle(updateCatScrollState));
  }
  // Keyboard navigation between categories when a .cat-tab has focus.
  $c.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tab = e.target.closest('.cat-tab');
    if (!tab) return;
    e.preventDefault(); e.stopPropagation();
    const all = Array.from($c.querySelectorAll('.cat-tab'));
    const idx = all.indexOf(tab);
    if (idx < 0) return;
    const nextIdx = e.key === 'ArrowLeft' ? Math.max(0, idx - 1) : Math.min(all.length - 1, idx + 1);
    const next = all[nextIdx];
    if (next && next !== tab) { next.focus(); next.click(); }
  });
  updateCatScrollState();
}

function renderBoard() {
  invalidateItemCache();
  if (getViewMode() === 'list') return renderListView();
  if (getViewMode() === 'canvas') return renderCanvasView();
  const $b = document.getElementById('board');
  $b.classList.remove('list-mode', 'canvas-mode');
  $b.innerHTML = '';
  const cat = activeCat(); if (!cat) return;

  if (!cat.groups.length) {
    const em = document.createElement('div');
    em.className = 'board-empty';
    em.innerHTML = `
      <svg class="illus" width="64" height="64" viewBox="0 0 64 64" fill="none">
        <rect x="4" y="4" width="26" height="26" rx="6" stroke="currentColor" stroke-width="2"/>
        <rect x="34" y="4" width="26" height="26" rx="6" stroke="currentColor" stroke-width="2"/>
        <rect x="4" y="34" width="26" height="26" rx="6" stroke="currentColor" stroke-width="2"/>
        <rect x="34" y="34" width="26" height="26" rx="6" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/>
      </svg>
      <p>No groups yet in <strong>${esc(cat.name)}</strong>.<br>Drag a tab from the sidebar to create one.</p>`;
    $b.appendChild(em);
  }

  cat.groups.forEach(g => $b.appendChild(buildGroupCol(g)));

  // Add group placeholder
  const add = document.createElement('div');
  add.className = 'add-col-btn';
  add.innerHTML = `<svg width="15" height="15" viewBox="0 0 15 15"><path d="M7.5 2v11M2 7.5h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Add Group`;
  add.onclick = () => openModal('new-group');
  add.ondragover = e => { if (drag?.kind === 'tab' || drag?.kind === 'tabs-multi') { e.preventDefault(); add.style.borderColor = 'var(--accent)'; add.style.color = 'var(--accent)'; } };
  add.ondragleave = () => { add.style.borderColor = ''; add.style.color = ''; };
  add.ondrop = async e => {
    e.preventDefault();
    add.style.borderColor = ''; add.style.color = '';
    if (drag?.kind === 'tab') {
      const name = drag.data.title?.slice(0, 30) || 'New Group';
      State.snapshot('Create from tab');
      cat.groups.push({ id: uid(), name, symbol:'📁', color:'#6366f1', collapsed: false, items: [] });
      await handleTabDropIntoGroup(drag.data, cat.groups[cat.groups.length - 1]);
    } else if (drag?.kind === 'tabs-multi') {
      State.snapshot('Create from tabs');
      const g = { id: uid(), name: `${drag.data.length} tabs`, symbol:'📂', color:'#6366f1', collapsed:false, items:[] };
      cat.groups.push(g);
      for (const t of drag.data) await handleTabDropIntoGroup(t, g);
    }
  };
  $b.appendChild(add);
  applySearchFilter();
}

function buildGroupCol(g) {
  const col = document.createElement('div');
  col.className = 'gcol' + (g.collapsed ? ' collapsed' : '');
  col.dataset.gid = g.id;
  col.style.setProperty('--gcol-tint', g.color);

  // Todo counter
  const todos = g.items.filter(it => it.type === 'todo');
  const done = todos.filter(it => it.done).length;
  const todoStr = todos.length ? `<span class="todo-count${done === todos.length ? ' all-done' : ''}">${done}/${todos.length}</span>` : '';

  const itemCnt = g.items.length;
  col.innerHTML = `
    <div class="gcol-hd" role="button" tabindex="0" aria-expanded="${!g.collapsed}" aria-label="Group ${esc(g.name)}">
      <div class="gcol-sym-wrap" style="background:${esc(g.color)}22">
        <span>${esc(g.symbol || '📁')}</span>
      </div>
      <div class="gcol-info">
        <input class="gcol-name" value="${esc(g.name)}" spellcheck="false">
        <div class="gcol-meta">
          <span class="chev"><svg width="8" height="8" viewBox="0 0 8 8"><path d="M2 3l2 2 2-2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg></span>
          <span>${itemCnt} ${itemCnt === 1 ? 'item' : 'items'}</span>
          ${todoStr}
        </div>
        ${renderIntentPills(g)}
      </div>
      <div class="gcol-acts">
        <button class="gcol-btn" data-act="intent" title="Edit intention">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.5a3.6 3.6 0 013.6 3.6c0 2.2-1.5 3.2-3.1 3.8l-.2.1v1.5M6 10.8h.01" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
        <button class="gcol-btn focus" data-act="focus" title="Expand to full page">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 4V2h2M10 4V2H8M2 8v2h2M10 8v2H8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="gcol-btn go" data-act="open-all" title="Open all">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5H2a1 1 0 00-1 1v6.5A1 1 0 002 11h6.5a1 1 0 001-1V8M7 1h4m0 0v4M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="gcol-btn" data-act="dup" title="Duplicate">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><rect x="3.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>
        </button>
        <button class="gcol-btn danger" data-act="del" title="Delete">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V1.5h3V3M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="gcol-scroll-wrap">
      <div class="gcol-cards"></div>
    </div>
    <div class="gcol-ft">
      <button data-act="add-tab">
        <svg width="10" height="10" viewBox="0 0 11 11"><path d="M5.5 1v9M1 5.5h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Current tab
      </button>
      <button data-act="add-note">
        <svg width="10" height="10" viewBox="0 0 11 11" fill="none"><path d="M2 1.5h5l2 2V9a0.5 0.5 0 01-.5.5H2a0.5 0.5 0 01-.5-.5V2a0.5 0.5 0 01.5-.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        Note
      </button>
      <button data-act="add-todo">
        <svg width="10" height="10" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 5.5l1.5 1.5 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        To-do
      </button>
      <button data-act="add-stack">
        <svg width="10" height="10" viewBox="0 0 11 11" fill="none"><path d="M2 3l3.5-1.5L9 3 5.5 4.5 2 3zM2 5.5L5.5 7 9 5.5M2 8L5.5 9.5 9 8" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
        Stack
      </button>
    </div>
    <div class="gcol-resize"></div>
    <div class="gcol-resize-corner" title="Resize"></div>
  `;

  // Header
  const hd = col.querySelector('.gcol-hd');
  const toggleCollapse = () => {
    State.snapshot('Toggle collapse');
    g.collapsed = !g.collapsed;
    col.classList.toggle('collapsed');
    hd.setAttribute('aria-expanded', String(!g.collapsed));
    State.persist();
  };
  hd.addEventListener('click', e => {
    if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.gcol-sym-wrap')) return;
    toggleCollapse();
  });
  hd.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === hd) { e.preventDefault(); toggleCollapse(); }
  });
  // Right-click on group
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    const ws = activeWs();
    const otherCats = ws ? ws.categories.filter(c => c.id !== ws.activeCatId) : [];
    const items = [
      { text:'Edit group…', icon: cmIcons.edit, action: () => openModal('edit-group', g) },
      { text:'Change symbol…', icon: cmIcons.symbol, action: () => openEmojiPicker({ kind:'group', id: g.id }, hd.querySelector('.gcol-sym-wrap')) },
      { text:'Edit intention…', icon: cmIcons.edit, action: () => openIntentEditor('group', g.id) },
      { text: g.collapsed ? 'Expand' : 'Collapse', icon: cmIcons.edit, action: () => { State.snapshot('Toggle'); g.collapsed = !g.collapsed; State.persist(); renderBoard(); } },
      { sep: true },
      { text:'Open all', icon: cmIcons.open, action: () => openGroupAll(g.id) },
      { text:'Focus mode', icon: cmIcons.expand || cmIcons.open, action: () => openGroupFocus(g.id) },
      { text:'Duplicate', icon: cmIcons.copy, action: () => duplicateGroup(g.id) },
      { text:'Add new stack…', icon: cmIcons.stack, action: () => openModal('new-stack', { groupId: g.id }) },
    ];
    if (otherCats.length) {
      items.push({ sep: true });
      items.push({ label: 'MOVE TO CATEGORY' });
      otherCats.forEach(c => {
        items.push({ text: c.name, icon: cmIcons.move, action: () => moveGroupToCategory(g.id, c.id) });
      });
      items.push({ text: '+ New category…', icon: cmIcons.move, action: () => moveGroupToNewCategory(g.id) });
    }
    items.push({ sep: true });
    items.push({ text:'Archive', icon: cmIcons.archive, action: () => archiveGroup(g.id) });
    items.push({ text:'Delete', icon: cmIcons.delete, danger:true, action: () => deleteGroup(g.id) });
    showContextMenu(e.pageX, e.pageY, items);
  });

  // Symbol
  col.querySelector('.gcol-sym-wrap').addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPicker({ kind:'group', id: g.id }, e.currentTarget);
  });

  // Rename
  const nm = col.querySelector('.gcol-name');
  nm.addEventListener('click', e => e.stopPropagation());
  nm.addEventListener('blur', () => {
    const v = nm.value.trim() || g.name;
    if (v !== g.name) { State.snapshot('Rename'); g.name = v; State.persist(); }
  });
  nm.addEventListener('keydown', e => { if (e.key === 'Enter') nm.blur(); if (e.key === 'Escape') { nm.value = g.name; nm.blur(); } });

  // Action buttons
  col.querySelectorAll('.gcol-acts .gcol-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'del') deleteGroup(g.id);
      else if (act === 'dup') duplicateGroup(g.id);
      else if (act === 'open-all') openGroupAll(g.id);
      else if (act === 'focus') openGroupFocus(g.id);
      else if (act === 'intent') openIntentEditor('group', g.id);
    });
  });

  // Add-buttons
  col.querySelectorAll('.gcol-ft button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      if (act === 'add-tab') {
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (t && !isProto(t.url)) {
          if (g.items.find(it => it.type === 'tab' && it.url === t.url)) return toast('Already saved');
          State.snapshot('Add current tab');
          g.items.push({ id: uid(), type:'tab', title:t.title||'Untitled', url:t.url, fav:t.favIconUrl||'' });
          if (State.get().settings.closeTabOnSave) try { await chrome.tabs.remove(t.id); } catch {}
          State.persist(); renderBoard(); toast('Tab saved', { undo: true });
        }
      } else if (act === 'add-note') {
        State.snapshot('Add note');
        const n = { id: uid(), type:'note', html:'' };
        g.items.push(n); State.persist(); renderBoard();
        setTimeout(() => { const el = document.querySelector(`[data-id="${n.id}"] .note-text`); if (el) el.focus(); }, 30);
      } else if (act === 'add-todo') {
        State.snapshot('Add todo');
        const t = { id: uid(), type:'todo', text:'', done:false };
        g.items.push(t); State.persist(); renderBoard();
        setTimeout(() => { const el = document.querySelector(`[data-id="${t.id}"] .todo-text`); if (el) el.focus(); }, 30);
      } else if (act === 'add-stack') openModal('new-stack', { groupId: g.id });
    });
  });

  // Items
  const cardsEl = col.querySelector('.gcol-cards');
  const scrollWrap = col.querySelector('.gcol-scroll-wrap');
  g.items.forEach(it => cardsEl.appendChild(buildItem(it, g.items, g)));
  makeGroupDropZone(cardsEl, col, g, g.items);

  // Scroll fade indicators
  const updateFade = () => {
    if (!scrollWrap) return;
    const atTop = cardsEl.scrollTop > 4;
    const atBot = cardsEl.scrollHeight - cardsEl.scrollTop - cardsEl.clientHeight > 4;
    scrollWrap.classList.toggle('scroll-top', atTop);
    scrollWrap.classList.toggle('scroll-bot', atBot);
  };
  cardsEl.addEventListener('scroll', updateFade, { passive: true });
  requestAnimationFrame(updateFade);

  // Column reorder (drag group header)
  col.addEventListener('dragstart', e => {
    if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.item') || e.target.closest('.gcol-resize')) return;
    drag = { kind:'group', srcId: g.id };
    col.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  col.addEventListener('dragend', () => { col.classList.remove('dragging'); document.querySelectorAll('.gcol').forEach(x => { x.classList.remove('drop-before'); x.classList.remove('drop-after'); }); drag = null; });
  col.addEventListener('dragover', e => {
    if (drag?.kind === 'group' && drag.srcId !== g.id) {
      e.preventDefault();
      const r = col.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      document.querySelectorAll('.gcol').forEach(x => { x.classList.remove('drop-before'); x.classList.remove('drop-after'); });
      col.classList.add(after ? 'drop-after' : 'drop-before');
    }
  });
  col.addEventListener('drop', e => {
    if (drag?.kind === 'group' && drag.srcId !== g.id) {
      e.preventDefault();
      const cat = activeCat();
      const r = col.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      State.snapshot('Reorder groups');
      const srcIdx = cat.groups.findIndex(x => x.id === drag.srcId);
      const [src] = cat.groups.splice(srcIdx, 1);
      let tgtIdx = cat.groups.findIndex(x => x.id === g.id);
      if (after) tgtIdx++;
      cat.groups.splice(tgtIdx, 0, src);
      State.persist(); renderBoard();
    }
  });
  col.draggable = true;

  // Apply saved size
  const savedSize = (State.get().columnSizes || State.get().columnWidths || {})[g.id];
  if (savedSize) {
    if (typeof savedSize === 'number') col.style.width = savedSize + 'px';
    else {
      if (savedSize.w) col.style.width = savedSize.w + 'px';
      if (savedSize.h) {
        const cards = col.querySelector('.gcol-cards');
        if (cards) { cards.style.maxHeight = savedSize.h + 'px'; cards.style.height = savedSize.h + 'px'; }
      }
    }
  }

  // Resize handles (corner = both axes)
  const resizerH = col.querySelector('.gcol-resize');
  const resizerCorner = col.querySelector('.gcol-resize-corner');
  let resizing = null; // 'h' | 'corner' | null
  let startX = 0, startY = 0, startW = 0, startH = 0;
  const cardsEl2 = col.querySelector('.gcol-cards');

  function beginResize(mode, e) {
    resizing = mode;
    startX = e.clientX; startY = e.clientY;
    startW = col.offsetWidth;
    startH = cardsEl2 ? cardsEl2.offsetHeight : 0;
    document.body.classList.add('resizing');
    e.preventDefault();
  }
  resizerH.addEventListener('mousedown', e => beginResize('h', e));
  if (resizerCorner) resizerCorner.addEventListener('mousedown', e => beginResize('corner', e));

  const onMove = rafThrottle(e => {
    if (!resizing) return;
    if (resizing === 'h' || resizing === 'corner') {
      const w = Math.max(200, Math.min(900, startW + (e.clientX - startX)));
      col.style.width = w + 'px';
    }
    if ((resizing === 'corner') && cardsEl2) {
      const h = Math.max(120, Math.min(window.innerHeight - 200, startH + (e.clientY - startY)));
      cardsEl2.style.maxHeight = h + 'px';
      cardsEl2.style.height = h + 'px';
    }
  });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    document.body.classList.remove('resizing');
    if (!State.get().columnSizes) State.get().columnSizes = {};
    State.get().columnSizes[g.id] = {
      w: col.offsetWidth,
      h: cardsEl2 ? cardsEl2.offsetHeight : null
    };
    State.persist();
    resizing = null;
  });

  return col;
}

// ════════════════════════════════════════════════════════════════
// ITEMS
// ════════════════════════════════════════════════════════════════
function buildItem(it, parentItems, group) {
  let el;
  if (it.type === 'note') el = buildNote(it, parentItems, group);
  else if (it.type === 'todo') el = buildTodo(it, parentItems, group);
  else if (it.type === 'stack') el = buildStack(it, parentItems, group);
  else el = buildTab(it, parentItems, group);
  attachItemSelection(el, it);
  return el;
}

function commonActs(it, extra = []) {
  const acts = [
    { text:'Edit color', icon: cmIcons.color, action: () => showColorMenu(null, it) },
    { text:'Set reminder…', icon: cmIcons.clock, action: () => openReminderPicker(it.id) },
    ...(it.reminder ? [{ text:'Clear reminder', icon: cmIcons.clock, action: () => clearReminder(it.id) }] : []),
    ...extra,
    { sep: true },
    { text:'Archive', icon: cmIcons.archive, action: () => archiveItem(it.id) },
    { text:'Delete permanently', icon: cmIcons.delete, danger: true, action: () => {
      if (!State.get().settings.confirmDelete || confirm('Delete permanently?')) {
        State.snapshot('Delete');
        const info = findItem(it.id);
        if (info) info.parent.splice(info.index, 1);
        State.persist(); renderBoard();
      }
    } }
  ];
  return acts;
}

function renderReminderBadge(it) {
  if (!it.reminder?.at) return '';
  const past = it.reminder.at < Date.now();
  const cls = past ? 'past' : (it.reminder.at - Date.now() < 86400000 ? '' : 'future');
  return `<span class="rem-badge ${cls}"><svg width="8" height="8" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M6 3v3l2 1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>${fmtTimeRelative(it.reminder.at)}</span>`;
}

function attachItemSelection(el, it) {
  const chk = document.createElement('span');
  chk.className = 'item-check';
  chk.setAttribute('aria-label', 'Select');
  if (selectedItemIds.has(it.id)) { chk.classList.add('checked'); el.classList.add('item-selected'); }
  chk.addEventListener('click', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    toggleItemSelect(it.id);
  });
  // Place inside item-top (flex row with fav + title) for tabs/notes/todos
  // For stacks, place inside stack-hd
  const target = el.querySelector('.item-top') || el.querySelector('.stack-hd') || el;
  target.insertBefore(chk, target.firstChild);

  // Whole-item click toggles selection when in selection mode
  el.addEventListener('click', (ev) => {
    if (!itemSelMode) return;
    // Don't capture clicks on the checkbox itself or buttons
    if (ev.target.closest('.item-check') || ev.target.closest('button')) return;
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.shiftKey) selectRangeTo(it.id);
    else toggleItemSelect(it.id);
  }, true);  // capture phase to beat link openers
}

// Range selection within the same parent list
function selectRangeTo(itemId) {
  if (!lastSelectedItemId) { toggleItemSelect(itemId); lastSelectedItemId = itemId; return; }
  const a = findItem(lastSelectedItemId), b = findItem(itemId);
  if (!a || !b || a.parent !== b.parent) { toggleItemSelect(itemId); lastSelectedItemId = itemId; return; }
  const [lo, hi] = a.index < b.index ? [a.index, b.index] : [b.index, a.index];
  for (let i = lo; i <= hi; i++) selectedItemIds.add(a.parent[i].id);
  lastSelectedItemId = itemId;
  syncItemSelMode();
  renderBoard();
  renderItemSelToolbar();
}

function buildTab(it, parentItems, group) {
  const el = document.createElement('div');
  el.className = 'item tab';
  el.dataset.id = it.id;
  el.tabIndex = 0;
  if (it.color) el.dataset.color = it.color;
  el.draggable = true;

  const fav = it.fav || favUrl(it.url);
  el.innerHTML = `
    ${renderReminderBadge(it)}
    <div class="item-top">
      <img class="item-fav" src="${esc(fav)}" alt="" loading="lazy" decoding="async" onerror="this.src='${BLANK_FAV}'">
      <span class="item-title">${esc(it.title)}</span>
      <div class="item-acts">
        <button class="item-btn" data-act="open" title="Open in new tab">
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M4 2.5H2a1 1 0 00-1 1v6.5A1 1 0 002 11h6.5a1 1 0 001-1V8M7 1h4m0 0v4M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button class="item-btn danger" data-act="del" title="Archive">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
    <div class="item-url">${esc(dispUrl(it.url))}</div>`;

  el.querySelector('.item-title').addEventListener('click', () => openTabMaybeHibernated(it.url, { focus: true }));
  el.querySelectorAll('.item-btn').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'open') openTabMaybeHibernated(it.url);
      else if (act === 'del') archiveItem(it.id);
    });
  });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.pageX, e.pageY, [
      { text:'Open (focused)', icon: cmIcons.open, action: () => openTabMaybeHibernated(it.url, { focus: true }) },
      { text:'Open in background', icon: cmIcons.open, action: () => openTabMaybeHibernated(it.url, { focus: false }) },
      { text:'Copy URL', icon: cmIcons.copy, action: () => { navigator.clipboard.writeText(it.url); toast('URL copied'); } },
      { text:'Edit title…', icon: cmIcons.edit, action: () => { const n = prompt('Title:', it.title); if (n) { State.snapshot('Rename tab'); it.title = n; State.persist(); renderBoard(); } } },
      ...commonActs(it)
    ]);
  });
  attachItemDrag(el, it, parentItems, group);
  return el;
}

function buildNote(it, parentItems, group) {
  const el = document.createElement('div');
  el.className = 'item note';
  el.dataset.id = it.id;
  el.tabIndex = 0;
  if (it.color) el.dataset.color = it.color;
  el.draggable = true;

  const html = sanitizeHtml(it.html || '');
  el.innerHTML = `
    ${renderReminderBadge(it)}
    <div class="item-top" style="align-items:flex-start;">
      <div class="note-text" contenteditable="true" spellcheck="false">${html}</div>
      <div class="item-acts">
        <button class="item-btn danger" data-act="del" title="Archive">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>`;

  const txt = el.querySelector('.note-text');
  let savedHtml = html;
  txt.addEventListener('blur', () => {
    const plainT = txt.textContent.trim();
    // Slash commands
    if (plainT === '/todo' || plainT === '/t') {
      State.snapshot('Convert to todo');
      const info = findItem(it.id);
      if (info) info.parent[info.index] = { id: it.id, type:'todo', text:'', done:false, color: it.color || null };
      State.persist(); renderBoard(); return;
    }
    if (/^\/(red|orange|yellow|green|blue)$/i.test(plainT)) {
      State.snapshot('Color');
      it.color = plainT.slice(1).toLowerCase();
      it.html = '';
      State.persist(); renderBoard(); return;
    }
    if (/^\/clear$/i.test(plainT)) { State.snapshot('Clear color'); delete it.color; it.html = ''; State.persist(); renderBoard(); return; }

    const newHtml = sanitizeHtml(txt.innerHTML);
    if (newHtml !== savedHtml) {
      State.snapshot('Edit note');
      it.html = autoLinkify(newHtml);
      savedHtml = it.html;
      State.persist();
    }
  });
  txt.addEventListener('keydown', e => {
    if (e.key === 'Escape') txt.blur();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); document.execCommand('bold'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); document.execCommand('italic'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'u') { e.preventDefault(); document.execCommand('underline'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); rtCreateLink(); }
  });

  el.querySelector('.item-btn.danger').addEventListener('click', e => { e.stopPropagation(); archiveItem(it.id); });
  el.addEventListener('contextmenu', e => {
    if (window.getSelection().toString()) return;
    e.preventDefault();
    showContextMenu(e.pageX, e.pageY, [
      { text:'Edit', icon: cmIcons.edit, action: () => txt.focus() },
      ...commonActs(it)
    ]);
  });
  attachItemDrag(el, it, parentItems, group);
  return el;
}

function autoLinkify(html) {
  // Only if not already linked
  const urlRe = /(?<!href=")(?<!>)(https?:\/\/[^\s<>"']+)/gi;
  return html.replace(urlRe, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function buildTodo(it, parentItems, group) {
  const el = document.createElement('div');
  el.className = 'item todo' + (it.done ? ' done' : '');
  el.dataset.id = it.id;
  el.tabIndex = 0;
  if (it.color) el.dataset.color = it.color;
  el.draggable = true;

  el.innerHTML = `
    ${renderReminderBadge(it)}
    <div class="todo-check ${it.done ? 'checked' : ''}"></div>
    <div class="todo-text" contenteditable="true" spellcheck="false">${esc(it.text)}</div>
    <div class="item-acts-vert">
      <button class="item-btn danger" data-act="del" title="Archive">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      </button>
    </div>`;

  el.querySelector('.todo-check').addEventListener('click', e => {
    e.stopPropagation();
    State.snapshot('Toggle todo');
    it.done = !it.done;
    State.persist(); renderBoard();
  });
  const txt = el.querySelector('.todo-text');
  txt.addEventListener('blur', () => {
    const v = txt.textContent.trim();
    if (v === '/done') { State.snapshot('Mark done'); it.done = true; State.persist(); renderBoard(); return; }
    if (/^\/(red|orange|yellow|green|blue)$/i.test(v)) { State.snapshot('Color'); it.color = v.slice(1).toLowerCase(); it.text = ''; State.persist(); renderBoard(); return; }
    if (v !== it.text) { State.snapshot('Edit todo'); it.text = txt.textContent; State.persist(); }
  });
  txt.addEventListener('keydown', e => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); txt.blur(); } });

  el.querySelector('.item-btn.danger').addEventListener('click', e => { e.stopPropagation(); archiveItem(it.id); });
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.pageX, e.pageY, [
      { text: it.done ? 'Mark not done' : 'Mark done', icon: cmIcons.edit, action: () => { State.snapshot('Toggle'); it.done = !it.done; State.persist(); renderBoard(); } },
      ...commonActs(it)
    ]);
  });
  attachItemDrag(el, it, parentItems, group);
  return el;
}

function buildStack(it, parentItems, group) {
  const el = document.createElement('div');
  el.className = 'item stack' + (it.expanded ? ' expanded' : '');
  el.dataset.id = it.id;
  el.tabIndex = 0;
  if (it.color) el.dataset.color = it.color;
  el.draggable = true;

  const cnt = (it.items || []).length;
  el.innerHTML = `
    <div class="stack-hd">
      <span class="stack-chev"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 4l2 2 2-2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg></span>
      <span class="stack-sym">${esc(it.symbol || '📚')}</span>
      <input class="stack-name" value="${esc(it.name || 'Stack')}" spellcheck="false">
      <span class="stack-cnt">${cnt}</span>
      <button class="stack-intent-btn" title="Edit intention">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1.5a3.6 3.6 0 013.6 3.6c0 2.2-1.5 3.2-3.1 3.8l-.2.1v1.5M6 10.8h.01" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>
    </div>
    ${renderIntentPills(it)}
    <div class="stack-items"></div>`;

  const hd = el.querySelector('.stack-hd');
  hd.addEventListener('click', e => {
    if (e.target.closest('input') || e.target.closest('.stack-sym')) return;
    State.snapshot('Toggle stack');
    it.expanded = !it.expanded;
    el.classList.toggle('expanded');
    State.persist();
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.pageX, e.pageY, [
      { text:'Rename stack', icon: cmIcons.edit, action: () => { const n = prompt('Name:', it.name); if (n) { State.snapshot('Rename stack'); it.name = n; State.persist(); renderBoard(); } } },
      { text:'Change symbol…', icon: cmIcons.symbol, action: () => openEmojiPicker({ kind:'stack', id: it.id }, hd.querySelector('.stack-sym')) },
      { text:'Edit intention…', icon: cmIcons.edit, action: () => openIntentEditor('stack', it.id) },
      { text: it.expanded ? 'Collapse' : 'Expand', icon: cmIcons.edit, action: () => { State.snapshot('Toggle'); it.expanded = !it.expanded; State.persist(); renderBoard(); } },
      { sep: true },
      ...commonActs(it)
    ]);
  });
  el.querySelector('.stack-sym').addEventListener('click', e => { e.stopPropagation(); openEmojiPicker({ kind:'stack', id: it.id }, e.currentTarget); });
  el.querySelector('.stack-intent-btn').addEventListener('click', e => { e.stopPropagation(); openIntentEditor('stack', it.id); });
  const nm = el.querySelector('.stack-name');
  nm.addEventListener('click', e => e.stopPropagation());
  nm.addEventListener('blur', () => { if (nm.value.trim() && nm.value.trim() !== it.name) { State.snapshot('Rename stack'); it.name = nm.value.trim(); State.persist(); } });
  nm.addEventListener('keydown', e => { if (e.key === 'Enter') nm.blur(); });

  const inner = el.querySelector('.stack-items');
  (it.items || []).forEach(sub => inner.appendChild(buildItem(sub, it.items, group)));
  makeGroupDropZone(inner, el, group, it.items);

  // Auto-expand stack when dragging over its header
  let expandTimer = null;
  hd.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    hd.classList.add('drop-target');
    if (!it.expanded && !expandTimer) {
      expandTimer = setTimeout(() => {
        it.expanded = true;
        el.classList.add('expanded');
        expandTimer = null;
      }, 500);
    }
  });
  hd.addEventListener('dragleave', (e) => {
    if (!hd.contains(e.relatedTarget)) {
      hd.classList.remove('drop-target');
      if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
    }
  });
  hd.addEventListener('drop', async (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    hd.classList.remove('drop-target');
    if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
    // Expand and drop at end of stack
    it.expanded = true;
    if (drag.kind === 'tab') await handleTabDropIntoList(drag.data, it.items, it.items.length);
    else if (drag.kind === 'tabs-multi') {
      State.snapshot(`Save ${drag.data.length} tabs`);
      let added = 0;
      for (const t of drag.data) {
        if (it.items.find(x => x.type === 'tab' && x.url === t.url)) continue;
        it.items.push({ id: uid(), type:'tab', title: t.title||'Untitled', url: t.url, fav: t.fav||'' });
        added++;
      }
      if (State.get().settings.closeTabOnSave) { for (const t of drag.data) { if (t.tabId) { try { await chrome.tabs.remove(t.tabId); } catch {} } } }
      selectedTabIds.clear();
      State.persist(); renderBoard(); updateSelectedBadge();
      toast(`Saved ${added} tabs to stack`, { undo: true });
    } else if (drag.kind === 'item') {
      const info = findItem(drag.id);
      if (!info) return;
      if (info.item.type === 'stack' && isDescendantOf(it.items, info.item)) { toast('Cannot nest stack in itself', { danger: true }); return; }
      if (info.item.id === it.id) return;
      State.snapshot('Move to stack');
      const [moved] = info.parent.splice(info.index, 1);
      it.items.push(moved);
      State.persist(); renderBoard();
    }
  });

  attachItemDrag(el, it, parentItems, group);
  return el;
}

// ════════════════════════════════════════════════════════════════
// COLOR MENU
// ════════════════════════════════════════════════════════════════
function showColorMenu(anchor, item) {
  document.querySelectorAll('.color-menu').forEach(x => x.remove());
  const menu = document.createElement('div');
  menu.className = 'color-menu';
  ['none','red','orange','yellow','green','blue'].forEach(c => {
    const d = document.createElement('div');
    d.className = 'cdot';
    d.dataset.c = c;
    d.onclick = e => {
      e.stopPropagation();
      State.snapshot('Color');
      item.color = c === 'none' ? null : c;
      State.persist(); renderBoard();
      menu.remove();
    };
    menu.appendChild(d);
  });
  document.body.appendChild(menu);
  const r = (anchor || document.querySelector(`[data-id="${item.id}"]`)).getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - 200) + 'px';
  setTimeout(() => {
    const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 50);
}

// ════════════════════════════════════════════════════════════════
// DRAG & DROP
// ════════════════════════════════════════════════════════════════
let drag = null;

// ─── Item selection (for groups/stacks batch actions) ───
let selectedItemIds = new Set();
let itemSelMode = false;       // derived: explicit mode on, OR something is selected
let explicitSelMode = false;   // sticky mode toggled via the select-mode button
let lastSelectedItemId = null;
// Single source of truth: keep the derived flag, the body class, and the
// toolbar button's active state in lockstep. Previously these were mutated in
// several places independently, so deselecting the last item (or toggling the
// button) could leave the flag and the button visually out of sync.
function syncItemSelMode() {
  itemSelMode = explicitSelMode || selectedItemIds.size > 0;
  document.body.classList.toggle('item-sel-mode', itemSelMode);
  document.getElementById('select-mode-btn')?.classList.toggle('active', itemSelMode);
}
function toggleItemSelect(itemId) {
  if (selectedItemIds.has(itemId)) selectedItemIds.delete(itemId);
  else selectedItemIds.add(itemId);
  // Keep the shift-range anchor on the clicked item, but drop it when the
  // selection is now empty — otherwise a later shift-click (while explicit
  // mode keeps the mode active) would span a range from a stale anchor.
  lastSelectedItemId = selectedItemIds.size ? itemId : null;
  syncItemSelMode();
  renderBoard();
  renderItemSelToolbar();
}
function clearItemSelection() {
  selectedItemIds.clear();
  explicitSelMode = false;
  lastSelectedItemId = null;
  syncItemSelMode();
  renderBoard();
  renderItemSelToolbar();
}

function renderItemSelToolbar() {
  let bar = document.getElementById('item-sel-toolbar');
  if (!selectedItemIds.size) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'item-sel-toolbar';
    document.body.appendChild(bar);
  }
  const count = selectedItemIds.size;
  bar.innerHTML = `
    <span class="isl-count">${count}</span>
    <span class="isl-lbl">selected</span>
    <div class="isl-sep"></div>
    <button data-act="open" title="Open all tabs">
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none"><path d="M4 2.5H2a1 1 0 00-1 1v6.5A1 1 0 002 11h6.5a1 1 0 001-1V8M7 1h4m0 0v4M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Open
    </button>
    <button data-act="move" title="Move to group">
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none"><path d="M6 2v8M2 6h8M4 4l-2 2 2 2M8 4l2 2-2 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Move
    </button>
    <button data-act="stack" title="Group into stack">
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none"><path d="M2 3l4-2 4 2-4 2-4-2zM2 6l4 2 4-2M2 9l4 2 4-2" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
      Stack
    </button>
    <button data-act="archive" title="Archive">
      <svg width="13" height="13" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="2" width="9" height="2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 4v6h7V4M5 7h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      Archive
    </button>
    <button data-act="clear" title="Clear selection (Esc)">
      <svg width="11" height="11" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    </button>`;
  bar.querySelectorAll('button').forEach(b => {
    b.onclick = () => runBatchAction(b.dataset.act);
  });
}

function getSelectedItemsInfo() {
  const out = [];
  for (const id of selectedItemIds) {
    const info = findItem(id);
    if (info) out.push(info);
  }
  return out;
}

function runBatchAction(act) {
  const infos = getSelectedItemsInfo();
  if (!infos.length) return;
  if (act === 'clear') { clearItemSelection(); return; }
  if (act === 'open') {
    const urls = [];
    infos.forEach(i => {
      if (i.item.type === 'tab') urls.push(i.item.url);
    });
    if (!urls.length) return toast('No tabs in selection');
    openAllHibernated(urls, infos.map(i => i.item));
    toast(`Opened ${urls.length} tabs`);
    return;
  }
  if (act === 'archive') {
    State.snapshot(`Archive ${infos.length} items`);
    // Sort by descending index within parent list to delete safely
    const ids = [...selectedItemIds];
    ids.forEach(id => {
      const info = findItem(id);
      if (info) {
        const [removed] = info.parent.splice(info.index, 1);
        State.get().archive.unshift({ kind:'item', data: removed, groupName: info.group.name, at: Date.now() });
      }
    });
    if (State.get().archive.length > 200) State.get().archive.length = 200;
    State.persist();
    clearItemSelection();
    toast(`Archived ${infos.length} items`, { undo: true });
    return;
  }
  if (act === 'move') {
    openMoveTargetPicker(infos);
    return;
  }
  if (act === 'stack') {
    if (infos.length < 2) return toast('Select at least 2 items');
    // Stack at the location of the first selected item's group
    const first = infos[0];
    State.snapshot(`Stack ${infos.length} items`);
    const moved = [];
    // Collect in original order within same group
    const ids = new Set(selectedItemIds);
    // Remove each in descending order by index to keep indices stable, collect in original order
    const orderedIds = [];
    const seen = new Set();
    // Walk in doc order
    const walk = (list) => {
      for (const it of list) {
        if (ids.has(it.id)) orderedIds.push(it.id);
        if (it.type === 'stack' && it.items) walk(it.items);
      }
    };
    State.get().workspaces.forEach(ws => ws.categories.forEach(cat => cat.groups.forEach(g => walk(g.items))));
    // Remove in reverse order so splicing stays safe
    for (let i = orderedIds.length - 1; i >= 0; i--) {
      const info = findItem(orderedIds[i]);
      if (info) moved.unshift(...info.parent.splice(info.index, 1));
    }
    const stack = {
      id: uid(), type:'stack',
      name: prompt('Stack name:', 'New stack') || 'New stack',
      symbol: '📚', color: '#6366f1', expanded: true,
      items: moved
    };
    // Insert at first item's original position within first.group
    first.group.items.unshift(stack);
    State.persist();
    clearItemSelection();
    toast(`Stacked ${moved.length} items`, { undo: true });
    return;
  }
}

function openMoveTargetPicker(infos) {
  if (!infos || !infos.length) return;
  const ids = infos.map(i => i.item.id);
  const sourceGroups = new Set(infos.map(i => i.group));
  const noun = ids.length === 1 ? 'item' : 'items';
  const items = [{ label: `MOVE ${ids.length} ${noun.toUpperCase()} TO…` }];
  State.get().workspaces.forEach(ws => {
    ws.categories.forEach(cat => {
      cat.groups.forEach(g => {
        if (sourceGroups.has(g)) return; // hide source as a destination
        items.push({
          text: `${ws.symbol || '🏠'} ${ws.name} / ${cat.name} / ${g.name}`,
          icon: cmIcons.folder || cmIcons.open,
          action: () => {
            State.snapshot(`Move ${ids.length} ${noun}`);
            // Walk in doc order to preserve relative order; splice in reverse
            // so indices stay stable.
            const idSet = new Set(ids);
            const orderedIds = [];
            const walk = list => { for (const it of list) { if (idSet.has(it.id)) orderedIds.push(it.id); if (it.type === 'stack' && it.items) walk(it.items); } };
            State.get().workspaces.forEach(w => w.categories.forEach(c => c.groups.forEach(gr => walk(gr.items))));
            const moved = [];
            for (let i = orderedIds.length - 1; i >= 0; i--) {
              const info = findItem(orderedIds[i]);
              if (info) moved.unshift(...info.parent.splice(info.index, 1));
            }
            g.items.push(...moved);
            State.persist();
            const focusId = moved[0]?.id;
            clearItemSelection(); // also re-renders the board
            if (focusId) requestAnimationFrame(() => focusItem(focusId));
            toast(`Moved ${moved.length} ${moved.length === 1 ? 'item' : 'items'}`, { undo: true });
          }
        });
      });
    });
  });
  // Anchor: above the multi-select toolbar if present; otherwise next to the
  // focused item card; otherwise centered near the top.
  let x, y;
  const bar = document.getElementById('item-sel-toolbar');
  if (bar) {
    const r = bar.getBoundingClientRect();
    x = r.left; y = r.top - 300;
  } else {
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('item')) {
      const r = ae.getBoundingClientRect();
      x = r.right + 8; y = r.top;
    } else {
      x = window.innerWidth / 2 - 150; y = 80;
    }
  }
  showContextMenu(x, y, items, { focusFirst: true });
}

function attachItemDrag(el, it, parentItems, group) {
  el.addEventListener('dragstart', e => {
    e.stopPropagation();
    drag = { kind:'item', id: it.id, srcList: parentItems };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', it.url || ''); } catch {}
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.dragover, .drop-target').forEach(x => { x.classList.remove('dragover'); x.classList.remove('drop-target'); });
    document.querySelectorAll('.drag-ghost').forEach(x => x.remove());
    drag = null;
  });
}

function makeGroupDropZone(cardsEl, colEl, g, targetList) {
  let lastOverY = 0;
  let lastGhostIdx = -1;

  function computeInsertIdx(clientY) {
    const children = [...cardsEl.querySelectorAll(':scope > .item:not(.dragging)')];
    for (let i = 0; i < children.length; i++) {
      const r = children[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return children.length;
  }

  function updateGhost(clientY) {
    const idx = computeInsertIdx(clientY);
    if (idx === lastGhostIdx) return;
    lastGhostIdx = idx;
    // Remove existing ghost only from THIS zone
    cardsEl.querySelectorAll(':scope > .drag-ghost').forEach(x => x.remove());
    const children = [...cardsEl.querySelectorAll(':scope > .item:not(.dragging)')];
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    if (idx >= children.length) cardsEl.appendChild(ghost);
    else cardsEl.insertBefore(ghost, children[idx]);
  }

  cardsEl.addEventListener('dragover', e => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    cardsEl.classList.add('dragover');
    if (colEl) colEl.classList.add('drop-target');
    // Throttle - only update when Y changed by >4px
    if (Math.abs(e.clientY - lastOverY) < 4) return;
    lastOverY = e.clientY;
    updateGhost(e.clientY);
  });

  cardsEl.addEventListener('dragleave', e => {
    // Only clear if we truly left this zone (not entered a child)
    if (cardsEl.contains(e.relatedTarget)) return;
    cardsEl.classList.remove('dragover');
    if (colEl) colEl.classList.remove('drop-target');
    cardsEl.querySelectorAll(':scope > .drag-ghost').forEach(x => x.remove());
    lastGhostIdx = -1;
  });

  cardsEl.addEventListener('drop', async e => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    cardsEl.classList.remove('dragover');
    if (colEl) colEl.classList.remove('drop-target');

    const insertIdx = computeInsertIdx(e.clientY);
    cardsEl.querySelectorAll(':scope > .drag-ghost').forEach(x => x.remove());
    lastGhostIdx = -1;

    if (drag.kind === 'tab') {
      await handleTabDropIntoList(drag.data, targetList, insertIdx);
    } else if (drag.kind === 'tabs-multi') {
      State.snapshot(`Save ${drag.data.length} tabs`);
      let idx = insertIdx;
      let added = 0;
      for (const t of drag.data) {
        if (targetList.find(it => it.type === 'tab' && it.url === t.url)) continue;
        const item = { id: uid(), type:'tab', title: t.title||'Untitled', url: t.url, fav: t.fav||'' };
        if (idx >= targetList.length) targetList.push(item);
        else targetList.splice(idx, 0, item);
        idx++; added++;
      }
      if (State.get().settings.closeTabOnSave) { for (const t of drag.data) { if (t.tabId) { try { await chrome.tabs.remove(t.tabId); } catch {} } } }
      selectedTabIds.clear();
      State.persist(); renderBoard(); updateSelectedBadge();
      toast(`Saved ${added} tabs`, { undo: true });
    } else if (drag.kind === 'item') {
      const info = findItem(drag.id);
      if (!info) return;
      // Prevent dropping a stack into itself or its descendants
      if (info.item.type === 'stack' && isDescendantOf(targetList, info.item)) {
        toast('Cannot drop a stack into itself', { danger: true });
        return;
      }
      State.snapshot('Move item');
      const srcList = info.parent;
      const srcIdx = info.index;
      const [moved] = srcList.splice(srcIdx, 1);
      let ii = insertIdx;
      if (srcList === targetList && ii > srcIdx) ii--;
      if (ii >= targetList.length) targetList.push(moved);
      else targetList.splice(ii, 0, moved);
      State.persist(); renderBoard();
    }
  });
}

// Returns true if `list` is *inside* stackItem (i.e. dropping into it would
// create a cycle). When walking, skip stackItem itself - finding stackItem
// in its own parent list means the user is reordering it within its parent,
// which is allowed.
function isDescendantOf(list, stackItem) {
  if (list === stackItem.items) return true;
  for (const it of list) {
    if (it === stackItem) continue;  // skip the dragged stack itself
    if (it.type === 'stack' && it.items && isDescendantOf(it.items, stackItem)) return true;
  }
  return false;
}

async function handleTabDropIntoList(tabObj, list, insertIdx, { snapshot = true } = {}) {
  if (list.find(it => it.type === 'tab' && it.url === tabObj.url)) {
    if (State.get().settings.closeTabOnSave && tabObj.tabId) { try { await chrome.tabs.remove(tabObj.tabId); } catch {} }
    toast('Already saved', { danger: true });
    return;
  }
  if (snapshot) State.snapshot('Save tab');
  const item = { id: uid(), type:'tab', title: tabObj.title||'Untitled', url: tabObj.url, fav: tabObj.fav||'' };
  if (insertIdx == null || insertIdx >= list.length) list.push(item);
  else list.splice(insertIdx, 0, item);
  if (State.get().settings.closeTabOnSave && tabObj.tabId) { try { await chrome.tabs.remove(tabObj.tabId); } catch {} }
  State.persist(); renderBoard();
  if (snapshot) toast('Tab saved', { undo: true });
}
async function handleTabDropIntoGroup(tabObj, group) {
  return handleTabDropIntoList(tabObj, group.items);
}

// ════════════════════════════════════════════════════════════════
// RICH TEXT TOOLBAR
// ════════════════════════════════════════════════════════════════
function maybeShowRtToolbar() {
  const tb = document.getElementById('rt-toolbar');
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { tb.classList.add('hidden'); return; }
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const note = (node.nodeType === 3 ? node.parentElement : node).closest?.('.note-text');
  if (!note) { tb.classList.add('hidden'); return; }
  const rect = range.getBoundingClientRect();
  tb.classList.remove('hidden');
  let top = rect.top - tb.offsetHeight - 8;
  let left = rect.left + rect.width / 2 - tb.offsetWidth / 2;
  if (top < 10) top = rect.bottom + 8;
  if (left < 10) left = 10;
  if (left + tb.offsetWidth > window.innerWidth - 10) left = window.innerWidth - tb.offsetWidth - 10;
  tb.style.top = top + 'px';
  tb.style.left = left + 'px';
}

function rtCreateLink() {
  const url = prompt('Link URL:', 'https://');
  if (url) document.execCommand('createLink', false, url);
}

function bindRtToolbar() {
  const tb = document.getElementById('rt-toolbar');
  tb.querySelectorAll('button').forEach(b => {
    b.onmousedown = e => e.preventDefault(); // preserve selection
    b.onclick = e => {
      e.preventDefault();
      const cmd = b.dataset.cmd;
      if (cmd === 'bold') document.execCommand('bold');
      else if (cmd === 'italic') document.execCommand('italic');
      else if (cmd === 'underline') document.execCommand('underline');
      else if (cmd === 'strike') document.execCommand('strikeThrough');
      else if (cmd === 'h') document.execCommand('formatBlock', false, '<h3>');
      else if (cmd === 'ul') document.execCommand('insertUnorderedList');
      else if (cmd === 'link') rtCreateLink();
      else if (cmd === 'color-red') document.execCommand('foreColor', false, '#ef4444');
      else if (cmd === 'color-green') document.execCommand('foreColor', false, '#22c55e');
      else if (cmd === 'color-yellow') document.execCommand('foreColor', false, '#eab308');
      else if (cmd === 'color-clear') document.execCommand('removeFormat');
    };
  });
  document.addEventListener('selectionchange', debounce(maybeShowRtToolbar, 50));
  const rtToolbarTick = rafThrottle(maybeShowRtToolbar);
  document.addEventListener('mouseup', rtToolbarTick);
  document.addEventListener('keyup', rtToolbarTick);
}

// ════════════════════════════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════════════════════════════
function applySearchFilter() {
  const q = document.getElementById('search-input').value.toLowerCase().trim();
  // Support exact match with quotes
  const isExact = /^".+"$/.test(q);
  const needle = isExact ? q.slice(1, -1) : q;
  const tokens = !isExact && q ? needle.split(/\s+/) : null;
  getItemNodes().forEach(el => {
    if (!q) { el.classList.remove('hidden'); return; }
    const text = el.textContent.toLowerCase();
    const match = isExact ? text.includes(needle) : tokens.every(w => text.includes(w));
    el.classList.toggle('hidden', !match);
  });
  document.querySelectorAll('.gcol').forEach(col => {
    const any = col.querySelectorAll('.item:not(.hidden)').length > 0;
    col.style.display = (!q || any) ? '' : 'none';
  });
  renderArchiveSearchResults(q, needle, isExact);
}
// Build a normalized search blob for an archive entry (group or item).
// Memoized in a WeakMap so we don't strip HTML on every keystroke.
const _archiveBlobCache = new WeakMap();
function archiveEntryText(entry) {
  const cached = _archiveBlobCache.get(entry);
  if (cached !== undefined) return cached;
  const parts = [];
  const pushItem = it => {
    if (!it) return;
    if (it.title) parts.push(it.title);
    if (it.url) parts.push(it.url);
    if (it.text) parts.push(it.text);
    if (it.html) parts.push(it.html.replace(/<[^>]+>/g, ' '));
    if (it.name) parts.push(it.name);
    if (it.type === 'stack' && Array.isArray(it.items)) it.items.forEach(pushItem);
  };
  if (entry.kind === 'group') {
    parts.push(entry.data.name || '');
    (entry.data.items || []).forEach(pushItem);
  } else {
    pushItem(entry.data);
  }
  const blob = parts.join(' ').toLowerCase();
  _archiveBlobCache.set(entry, blob);
  return blob;
}
function renderArchiveSearchResults(q, needle, isExact) {
  const $r = document.getElementById('search-archive-results');
  if (!$r) return;
  if (!q) { $r.classList.add('hidden'); $r.innerHTML = ''; return; }
  const arr = State.get().archive || [];
  const matches = [];
  arr.forEach((e, i) => {
    const text = archiveEntryText(e);
    const hit = isExact ? text.includes(needle) : needle.split(/\s+/).every(w => text.includes(w));
    if (hit) matches.push({ entry: e, idx: i });
  });
  if (!matches.length) { $r.classList.add('hidden'); $r.innerHTML = ''; return; }
  const cap = 20;
  const shown = matches.slice(0, cap);
  const overflow = matches.length - shown.length;
  const head = `<div class="sar-hd">From archive · ${matches.length} result${matches.length === 1 ? '' : 's'}${overflow ? ` (showing ${shown.length})` : ''}</div>`;
  const rows = shown.map(({ entry, idx }) => {
    const name = entry.kind === 'group'
      ? (entry.data.name || 'Group')
      : (entry.data.title || (entry.data.html ? entry.data.html.replace(/<[^>]+>/g, ' ').slice(0, 60) : entry.data.text) || 'Item');
    const icon = entry.kind === 'group' ? '📁' : (entry.data.type === 'note' ? '📝' : entry.data.type === 'todo' ? '✓' : '🔗');
    return `<div class="ar-entry sar-row" data-idx="${idx}">
      <span>${icon}</span>
      <span class="ar-t">${esc(name)}</span>
      <span class="ar-d">${esc(fmtTimeRelative(entry.at))}</span>
      <button class="sar-view" title="Open in archive"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 6h7M6 3l3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="restore" title="Restore"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3 5.5L5.5 3l2.5 2.5M5.5 3v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>`;
  }).join('');
  $r.innerHTML = head + rows;
  $r.classList.remove('hidden');
  $r.querySelectorAll('.sar-row').forEach(row => {
    const idx = +row.dataset.idx;
    row.querySelector('.restore').onclick = () => {
      restoreArchive(idx);
      toggleSearchBar(false);
    };
    row.querySelector('.sar-view').onclick = () => {
      toggleSearchBar(false);
      document.querySelector('#drawer-tabs .dt[data-tab="archive"]')?.click();
      document.getElementById('settings-drawer')?.classList.remove('hidden');
    };
  });
}
function toggleSearchBar(force) {
  const bar = document.getElementById('search-bar');
  const hide = force === false || !bar.classList.contains('hidden');
  if (hide) { bar.classList.add('hidden'); document.getElementById('search-input').value = ''; applySearchFilter(); }
  else { bar.classList.remove('hidden'); setTimeout(() => document.getElementById('search-input').focus(), 40); }
}

// ════════════════════════════════════════════════════════════════
// WORKSPACE GRID
// ════════════════════════════════════════════════════════════════
async function openWsGrid() {
  const s = State.get();
  const g = document.getElementById('wsg-grid');
  g.innerHTML = '';
  s.workspaces.forEach(ws => {
    const count = ws.categories.reduce((a, c) => a + c.groups.reduce((b, gp) => b + gp.items.length, 0), 0);
    const card = document.createElement('div');
    card.className = 'wsg-card' + (ws.id === s.activeWsId ? ' active' : '');
    card.innerHTML = `
      ${s.workspaces.length > 1 ? `<button class="del" title="Delete"><svg width="10" height="10" viewBox="0 0 11 11"><path d="M1.5 1.5l8 8M9.5 1.5l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>` : ''}
      <span class="sym">${esc(ws.symbol||'🏠')}</span>
      <div class="nm">${esc(ws.name)}</div>
      <div class="cnt">${count} items</div>`;
    card.onclick = e => {
      if (e.target.closest('.del')) {
        if (confirm(`Delete "${ws.name}"?`)) {
          State.snapshot('Delete workspace');
          s.workspaces = s.workspaces.filter(w => w.id !== ws.id);
          if (s.activeWsId === ws.id) s.activeWsId = s.workspaces[0].id;
          State.persist(); renderAll(); openWsGrid();
        }
        return;
      }
      s.activeWsId = ws.id;
      State.persist(); renderAll();
      document.getElementById('ws-grid-overlay').classList.add('hidden');
    };
    card.oncontextmenu = e => {
      e.preventDefault();
      showContextMenu(e.pageX, e.pageY, [
        { text:'Rename', icon: cmIcons.edit, action: () => { const n = prompt('Rename workspace:', ws.name); if (n) { State.snapshot('Rename ws'); ws.name = n; State.persist(); openWsGrid(); renderAll(); } } },
        { text:'Change symbol…', icon: cmIcons.symbol, action: () => openEmojiPicker({ kind:'workspace', id: ws.id }, card.querySelector('.sym')) }
      ]);
    };
    g.appendChild(card);
  });

  // ── Browser windows as quick-save sources ──
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    const winsPanel = document.getElementById('wsg-windows');
    if (winsPanel) {
      winsPanel.innerHTML = '';
      const currentWin = await chrome.windows.getCurrent();
      wins.forEach((w, i) => {
        const tabs = (w.tabs || []).filter(t => !isProto(t.url));
        if (!tabs.length) return;
        const card = document.createElement('div');
        card.className = 'wsg-win-card';
        const isCur = w.id === currentWin.id;
        // Mini stack of favicons
        const favs = tabs.slice(0, 5).map(t => {
          const f = t.favIconUrl || favUrl(t.url);
          return `<img src="${esc(f)}" loading="lazy" decoding="async" onerror="this.style.visibility='hidden'">`;
        }).join('');
        card.innerHTML = `
          <div class="wsg-win-label">
            <span class="wg-dot"></span>
            <span>${isCur ? '★ This window' : `Window ${i + 1}`}</span>
            <span class="wsg-win-cnt">${tabs.length} tabs</span>
          </div>
          <div class="wsg-win-favs">${favs}</div>
          <button class="wsg-win-save">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 2h7l2 2v7H2V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
            Save as workspace
          </button>`;
        card.querySelector('.wsg-win-save').onclick = () => {
          document.getElementById('ws-grid-overlay').classList.add('hidden');
          saveWindowAsWorkspace(w);
        };
        // Card click: focus that window
        card.onclick = (e) => {
          if (e.target.closest('.wsg-win-save')) return;
          chrome.windows.update(w.id, { focused: true }).catch(()=>{});
        };
        winsPanel.appendChild(card);
      });
    }
  } catch {}

  document.getElementById('ws-grid-overlay').classList.remove('hidden');
}

async function saveWindowAsWorkspace(win) {
  const tabs = (win.tabs || []).filter(t => !isProto(t.url));
  if (!tabs.length) return toast('No saveable tabs');
  State.snapshot('Save window as workspace');
  const ws = {
    id: uid(), name: `Window ${new Date().toLocaleDateString('en',{month:'short',day:'numeric'})}`, symbol:'🪟',
    categories: [{ id: uid(), name:'Quicklinks', groups: [{
      id: uid(), name:'Tabs', symbol:'📁', color:'#06b6d4', collapsed:false,
      items: tabs.map(t => ({ id: uid(), type:'tab', title:t.title||'Untitled', url:t.url, fav:t.favIconUrl||'' }))
    }] }]
  };
  ws.activeCatId = ws.categories[0].id;
  State.get().workspaces.push(ws);
  State.get().activeWsId = ws.id;
  State.persist();
  renderAll();
  toast(`Saved window as workspace`, { undo: true });
}

// ════════════════════════════════════════════════════════════════
// ARCHIVE LIST
// ════════════════════════════════════════════════════════════════
function renderArchiveList() {
  const $l = document.getElementById('archive-list');
  if (!$l) return;
  const arr = State.get().archive;
  $l.innerHTML = '';
  if (!arr.length) { $l.innerHTML = `<div class="ar-empty">Archive is empty.</div>`; return; }
  arr.forEach((e, i) => {
    const el = document.createElement('div');
    el.className = 'ar-entry';
    const name = e.kind === 'group' ? (e.data.name || 'Group') : (e.data.title || (e.data.html ? e.data.html.slice(0, 60) : e.data.text) || 'Item');
    el.innerHTML = `
      <span>${e.kind === 'group' ? '📁' : (e.data.type === 'note' ? '📝' : e.data.type === 'todo' ? '✓' : '🔗')}</span>
      <span class="ar-t">${esc(name)}</span>
      <span class="ar-d">${fmtTimeRelative(e.at)}</span>
      <button class="restore" title="Restore"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3 5.5L5.5 3l2.5 2.5M5.5 3v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="del" title="Delete permanently"><svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 3h7M4.5 3V1.5h2V3M3 3v6.5a0.5 0.5 0 00.5.5h4a0.5 0.5 0 00.5-.5V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></button>`;
    el.querySelector('.restore').onclick = () => restoreArchive(i);
    el.querySelector('.del').onclick = () => { if (confirm('Permanently delete?')) permDelete(i); };
    $l.appendChild(el);
  });
}

// ════════════════════════════════════════════════════════════════
// BOOKMARKS / EXPORT / IMPORT
// ════════════════════════════════════════════════════════════════
async function importBookmarks() {
  if (!chrome.bookmarks) return toast('Bookmarks API unavailable', { danger:true });
  const tree = await chrome.bookmarks.getTree();
  const cat = activeCat(); if (!cat) return;
  State.snapshot('Import bookmarks');
  const MAX_BOOKMARK_DEPTH = 50;
  let imported = 0;
  let skipped = 0;
  function walk(nodes, folderName, depth) {
    if (depth >= MAX_BOOKMARK_DEPTH) { skipped++; return; }
    const g = { id: uid(), name: folderName || 'Bookmarks', symbol:'🔖', color:'#eab308', collapsed:false, items:[] };
    let has = false;
    for (const n of nodes) {
      if (n.url && !isProto(n.url)) { g.items.push({ id: uid(), type:'tab', title:n.title||n.url, url:n.url, fav:'' }); has = true; imported++; }
      else if (n.children) walk(n.children, n.title, depth + 1);
    }
    if (has) cat.groups.push(g);
  }
  tree.forEach(r => (r.children || []).forEach(c => walk(c.children || [], c.title, 0)));
  State.persist(); renderBoard();
  const suffix = skipped ? ` · ${skipped} folder${skipped === 1 ? '' : 's'} too deep` : '';
  toast(`Imported ${imported}${suffix}`, { undo: true });
}
function countState(s) {
  let workspaces = 0, categories = 0, groups = 0, items = 0;
  const countItems = (list) => {
    for (const it of (list || [])) {
      items++;
      if (it && it.type === 'stack') countItems(it.items);
    }
  };
  for (const ws of (s.workspaces || [])) {
    workspaces++;
    for (const cat of (ws.categories || [])) {
      categories++;
      for (const g of (cat.groups || [])) {
        groups++;
        countItems(g.items);
      }
    }
  }
  return { workspaces, categories, groups, items, archived: (s.archive || []).length };
}

function pluralize(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function exportJSON() {
  const data = State.get();
  const counts = countState(data);
  const payload = {
    app: 'tabnest',
    schema: CURRENT_SCHEMA,
    exportedAt: new Date().toISOString(),
    counts,
    data
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const wsTag = counts.workspaces ? `-${counts.workspaces}ws` : '';
  a.href = url;
  a.download = `tabnest${wsTag}-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported · ${pluralize(counts.workspaces, 'workspace')} · ${pluralize(counts.items, 'item')}`);
}

let importCtx = null;

function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    let parsed;
    try { parsed = JSON.parse(r.result); }
    catch (e) {
      const m = (e && e.message || '').match(/position (\d+)/i);
      const where = m ? ` (position ${m[1]})` : '';
      toast(`Invalid JSON${where}`, { danger: true, duration: 5000 });
      return;
    }
    let data, schema, exportedAt;
    if (parsed && (parsed.app === 'tabnest' || parsed.app === 'tabextend') && parsed.data && typeof parsed.data === 'object') {
      data = parsed.data;
      schema = parsed.schema;
      exportedAt = parsed.exportedAt;
    } else if (parsed && Array.isArray(parsed.workspaces)) {
      data = parsed;
      schema = 'legacy';
    } else {
      toast('Invalid file: missing workspaces field', { danger: true, duration: 5000 });
      return;
    }
    if (!Array.isArray(data.workspaces)) {
      toast('Invalid file: workspaces is not an array', { danger: true, duration: 5000 });
      return;
    }
    const counts = countState(data);
    importCtx = { data, counts, filename: file.name, exportedAt, schema };
    openImportPreview();
  };
  r.onerror = () => toast('Could not read file', { danger: true, duration: 5000 });
  r.readAsText(file);
}

function openImportPreview() {
  if (!importCtx) return;
  const { counts, filename, exportedAt, schema } = importCtx;
  document.getElementById('import-filename').textContent = filename || '—';
  document.getElementById('import-date').textContent = exportedAt
    ? new Date(exportedAt).toLocaleString()
    : 'Unknown';
  document.getElementById('import-schema').textContent =
    schema === 'legacy' ? 'Legacy' : (schema != null ? String(schema) : '—');
  const cells = [
    ['workspaces', 'Workspaces'],
    ['categories', 'Categories'],
    ['groups', 'Groups'],
    ['items', 'Items'],
    ['archived', 'Archived']
  ];
  const c = document.getElementById('import-counts');
  c.textContent = '';
  cells.forEach(([k, lbl]) => {
    const el = document.createElement('div');
    el.className = 'import-count';
    const num = document.createElement('div');
    num.className = 'import-count-num';
    num.textContent = String(counts[k] ?? 0);
    const lblEl = document.createElement('div');
    lblEl.className = 'import-count-lbl';
    lblEl.textContent = lbl;
    el.append(num, lblEl);
    c.append(el);
  });
  const replaceRadio = document.querySelector('input[name="import-mode"][value="replace"]');
  if (replaceRadio) replaceRadio.checked = true;
  const overlay = document.getElementById('import-overlay');
  rememberOpener(overlay);
  overlay.classList.remove('hidden');
  setTimeout(() => focusFirstIn(overlay), 50);
}

function closeImportPreview() {
  const overlay = document.getElementById('import-overlay');
  overlay.classList.add('hidden');
  restoreOpener(overlay);
  importCtx = null;
  const inp = document.getElementById('import-file');
  if (inp) inp.value = '';
}

function applyImportReplace(data) {
  State.snapshot('Import');
  const s = State.get();
  const mergedSettings = { ...s.settings, ...(data.settings || {}) };
  Object.assign(s, data);
  s.settings = mergedSettings;
  migrate();
  State.persist();
  applySettings();
  renderAll();
  const c = countState(s);
  toast(`Imported · ${pluralize(c.workspaces, 'workspace')} · ${pluralize(c.items, 'item')}`, { undo: true });
}

function applyImportMerge(data) {
  const s = State.get();
  const before = countState(s);
  State.snapshot('Merge import');
  const existingWsIds = new Set(s.workspaces.map(w => w.id));
  let addedWs = 0;
  for (const ws of (data.workspaces || [])) {
    const incoming = JSON.parse(JSON.stringify(ws));
    if (existingWsIds.has(incoming.id)) incoming.id = uid();
    delete incoming.windowId;
    s.workspaces.push(incoming);
    existingWsIds.add(incoming.id);
    addedWs++;
  }
  s.archive = s.archive || [];
  const existingArchiveIds = new Set(s.archive.map(a => a && a.id).filter(Boolean));
  for (const a of (data.archive || [])) {
    if (a && a.id && !existingArchiveIds.has(a.id)) {
      s.archive.push(JSON.parse(JSON.stringify(a)));
      existingArchiveIds.add(a.id);
    }
  }
  if (Array.isArray(data.recentEmoji)) {
    s.recentEmoji = s.recentEmoji || [];
    const seen = new Set(s.recentEmoji);
    for (const e of data.recentEmoji) if (!seen.has(e)) { s.recentEmoji.push(e); seen.add(e); }
  }
  if (data.columnWidths && typeof data.columnWidths === 'object') {
    s.columnWidths = { ...(s.columnWidths || {}), ...data.columnWidths };
  }
  migrate();
  State.persist();
  renderAll();
  const after = countState(s);
  const addedItems = after.items - before.items;
  toast(`Merged · +${pluralize(addedWs, 'workspace')} · +${pluralize(addedItems, 'item')}`, { undo: true });
}

function bindImportUI() {
  const overlay = document.getElementById('import-overlay');
  if (!overlay) return;
  document.getElementById('import-x').onclick = closeImportPreview;
  document.getElementById('import-cancel').onclick = closeImportPreview;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeImportPreview(); });
  overlay.addEventListener('keydown', e => trapTabKey(e, overlay));
  document.getElementById('import-confirm').onclick = () => {
    if (!importCtx) { closeImportPreview(); return; }
    const mode = document.querySelector('input[name="import-mode"]:checked')?.value || 'replace';
    const { data } = importCtx;
    closeImportPreview();
    if (mode === 'merge') applyImportMerge(data);
    else applyImportReplace(data);
  };
}

// ════════════════════════════════════════════════════════════════
// PASTE LINKS IMPORT
// ════════════════════════════════════════════════════════════════
function parsePastedLinks(text) {
  return [...new Set(
    text.split('\n').map(l => l.trim()).filter(l => {
      try { const u = new URL(l); return ['http:', 'https:'].includes(u.protocol); }
      catch { return false; }
    })
  )];
}

function openPasteOverlay() {
  const overlay = document.getElementById('paste-overlay');
  const area = document.getElementById('paste-area');
  const dest = document.getElementById('paste-dest');
  const btn = document.getElementById('paste-go');
  const preview = document.getElementById('paste-preview');
  const nameInput = document.getElementById('paste-group-name');

  area.value = '';
  btn.disabled = true;
  btn.textContent = 'Import 0 links';
  preview.textContent = '';
  nameInput.classList.add('hidden');
  nameInput.value = '';

  dest.innerHTML = '';
  const cat = activeCat();
  if (cat) {
    cat.groups.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent = (g.symbol ? g.symbol + ' ' : '') + g.name;
      dest.appendChild(opt);
    });
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New group';
  dest.appendChild(newOpt);

  overlay.classList.remove('hidden');
  setTimeout(() => area.focus(), 50);
}

function closePasteOverlay() {
  document.getElementById('paste-overlay').classList.add('hidden');
}

function applyPasteImport() {
  const urls = parsePastedLinks(document.getElementById('paste-area').value);
  if (!urls.length) return;
  const destId = document.getElementById('paste-dest').value;
  const cat = activeCat();
  if (!cat) return;

  State.snapshot('Paste links');

  let targetGroup;
  if (destId === '__new__') {
    const name = document.getElementById('paste-group-name').value.trim() || 'Pasted links';
    targetGroup = { id: uid(), name, symbol: '📋', color: '#6366f1', collapsed: false, items: [] };
    cat.groups.push(targetGroup);
  } else {
    targetGroup = cat.groups.find(g => g.id === destId);
    if (!targetGroup) return;
  }

  for (const url of urls) {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    targetGroup.items.push({
      id: uid(), type: 'tab', url,
      title: host || url, fav: favUrl(url)
    });
  }

  State.persist();
  renderBoard();
  closePasteOverlay();
  toast(`Imported ${urls.length} link${urls.length === 1 ? '' : 's'}`, { undo: true });
}

function bindPasteImportUI() {
  const overlay = document.getElementById('paste-overlay');
  if (!overlay) return;
  const area = document.getElementById('paste-area');
  const btn = document.getElementById('paste-go');
  const dest = document.getElementById('paste-dest');
  const nameInput = document.getElementById('paste-group-name');

  document.getElementById('paste-x').onclick = closePasteOverlay;
  document.getElementById('paste-cancel').onclick = closePasteOverlay;
  overlay.addEventListener('click', e => { if (e.target === overlay) closePasteOverlay(); });
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closePasteOverlay(); e.stopPropagation(); }
    trapTabKey(e, overlay);
  });

  area.addEventListener('input', () => {
    const urls = parsePastedLinks(area.value);
    const n = urls.length;
    btn.disabled = n === 0;
    btn.textContent = `Import ${n} link${n === 1 ? '' : 's'}`;
    document.getElementById('paste-preview').textContent = n ? `${n} valid URL${n === 1 ? '' : 's'} detected` : '';
  });

  dest.addEventListener('change', () => {
    nameInput.classList.toggle('hidden', dest.value !== '__new__');
    if (dest.value === '__new__') nameInput.focus();
  });

  btn.onclick = applyPasteImport;

  document.getElementById('paste-import-btn').onclick = openPasteOverlay;
}

// ════════════════════════════════════════════════════════════════
// REMINDER UI bind
// ════════════════════════════════════════════════════════════════
function bindReminderUI() {
  document.getElementById('rm-x').onclick = closeReminderPicker;
  document.getElementById('rm-clear').onclick = () => { if (reminderCtx) clearReminder(reminderCtx.itemId); closeReminderPicker(); };
  document.getElementById('rm-save').onclick = () => {
    if (!reminderCtx) return;
    const dt = document.getElementById('rm-datetime').value;
    if (!dt) return;
    const ts = new Date(dt).getTime();
    if (ts < Date.now()) { toast('Time is in the past', { danger: true }); return; }
    setReminder(reminderCtx.itemId, ts);
    closeReminderPicker();
  };
  document.querySelectorAll('.rm-quick button').forEach(b => {
    b.onclick = () => {
      const offset = +b.dataset.offset;
      if (!reminderCtx) return;
      setReminder(reminderCtx.itemId, Date.now() + offset);
      closeReminderPicker();
    };
  });
  document.getElementById('reminder-overlay').addEventListener('click', e => { if (e.target === document.getElementById('reminder-overlay')) closeReminderPicker(); });
}

// ════════════════════════════════════════════════════════════════
// SUBSCRIPTION TRACKER
// ════════════════════════════════════════════════════════════════
const CURRENCY_SYMBOL = { USD:'$', EUR:'€', GBP:'£', TWD:'NT$', JPY:'¥', CNY:'¥', KRW:'₩' };
// Very rough static FX for aggregation when mixed currencies
const FX_TO_USD = { USD:1, EUR:1.09, GBP:1.28, TWD:0.031, JPY:0.0067, CNY:0.14, KRW:0.00074 };
const SUB_CAT_META = {
  entertainment:{ icon:'🎬', label:'Entertainment' },
  productivity: { icon:'💼', label:'Productivity' },
  cloud:        { icon:'☁️', label:'Cloud & Hosting' },
  dev:          { icon:'💻', label:'Developer tools' },
  ai:           { icon:'🤖', label:'AI' },
  music:        { icon:'🎵', label:'Music' },
  news:         { icon:'📰', label:'News' },
  fitness:      { icon:'💪', label:'Fitness' },
  utilities:    { icon:'🔌', label:'Utilities' },
  other:        { icon:'📦', label:'Other' }
};

let subEditingId = null;
let subFilter = 'all';

function getSubs() {
  const s = State.get();
  if (!s.subscriptions) s.subscriptions = [];
  if (!s.subSettings) s.subSettings = { defaultCurrency: 'USD' };
  return s.subscriptions;
}

function subMonthlyCostUSD(sub) {
  if (sub.paused) return 0;
  const base = Number(sub.cost || 0) * (FX_TO_USD[sub.currency] || 1);
  const p = sub.period || 'monthly';
  if (p === 'weekly') return base * 52 / 12;
  if (p === 'yearly') return base / 12;
  if (p === 'quarterly') return base / 3;
  if (p === 'oneoff') return 0;
  return base; // monthly
}

function formatMoney(val, currency = 'USD') {
  const sym = CURRENCY_SYMBOL[currency] || '$';
  const n = Math.abs(val);
  const decimals = (currency === 'JPY' || currency === 'KRW') ? 0 : 2;
  return `${val < 0 ? '-' : ''}${sym}${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00');
  const today = new Date();
  today.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}

function openSubsTracker() {
  const ov = document.getElementById('subs-overlay');
  rememberOpener(ov);
  ov.classList.remove('hidden');
  renderSubs();
  lockBodyScroll();
  focusFirstIn(ov);
}
function closeSubsTracker() {
  const ov = document.getElementById('subs-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}

function renderSubs() {
  const subs = getSubs();
  const list = document.getElementById('subs-list');
  const empty = document.getElementById('subs-empty');
  const mainCur = State.get().subSettings?.defaultCurrency || 'USD';
  document.getElementById('subs-currency').value = mainCur;

  // Filter
  let filtered = subs;
  if (subFilter === 'monthly') filtered = subs.filter(s => !s.paused && (s.period === 'monthly' || s.period === 'weekly' || s.period === 'quarterly'));
  else if (subFilter === 'yearly') filtered = subs.filter(s => !s.paused && s.period === 'yearly');
  else if (subFilter === 'paused') filtered = subs.filter(s => s.paused);
  else filtered = subs;

  // Sort: active first, then by days-until ascending
  filtered = [...filtered].sort((a, b) => {
    if (a.paused !== b.paused) return a.paused ? 1 : -1;
    const ad = daysUntil(a.nextBilling) ?? 9999;
    const bd = daysUntil(b.nextBilling) ?? 9999;
    return ad - bd;
  });

  // Stats (on ALL subs, not filtered)
  const monthlyUSD = subs.reduce((a, s) => a + subMonthlyCostUSD(s), 0);
  const annualUSD = monthlyUSD * 12;
  const active = subs.filter(s => !s.paused).length;

  // Upcoming in 7 days
  let upcoming = 0;
  subs.forEach(s => {
    if (s.paused) return;
    const d = daysUntil(s.nextBilling);
    if (d != null && d >= 0 && d <= 7) upcoming += Number(s.cost || 0) * (FX_TO_USD[s.currency] || 1);
  });

  // Convert to display currency
  const toDisp = v => v / (FX_TO_USD[mainCur] || 1);
  document.getElementById('subs-monthly').textContent = formatMoney(toDisp(monthlyUSD), mainCur);
  document.getElementById('subs-annual').textContent = formatMoney(toDisp(annualUSD), mainCur);
  document.getElementById('subs-count').textContent = active;
  document.getElementById('subs-upcoming').textContent = formatMoney(toDisp(upcoming), mainCur);

  // Filter chips
  document.querySelectorAll('.subs-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === subFilter));

  list.innerHTML = '';
  if (!filtered.length) {
    empty.classList.remove('hidden');
    list.style.display = 'none';
    return;
  }
  empty.classList.add('hidden');
  list.style.display = '';

  filtered.forEach(sub => {
    const row = document.createElement('div');
    row.className = 'sub-row' + (sub.paused ? ' paused' : '');
    row.style.setProperty('--sub-tint', sub.color || '#6366f1');
    row.style.setProperty('--sub-tint-bg', (sub.color || '#6366f1') + '22');
    const days = daysUntil(sub.nextBilling);
    const catMeta = SUB_CAT_META[sub.category] || SUB_CAT_META.other;
    let nextLabel = '—';
    let nextClass = '';
    if (sub.paused) { nextLabel = 'Paused'; nextClass = 'paused'; }
    else if (days != null) {
      if (days < 0) { nextLabel = `Overdue ${-days}d`; nextClass = 'due'; }
      else if (days === 0) { nextLabel = 'Today'; nextClass = 'due'; }
      else if (days === 1) { nextLabel = 'Tomorrow'; nextClass = 'soon'; }
      else if (days <= 3) { nextLabel = `In ${days} days`; nextClass = 'soon'; }
      else if (days <= 30) { nextLabel = `In ${days} days`; }
      else { const d = new Date(sub.nextBilling); nextLabel = d.toLocaleDateString('en',{month:'short',day:'numeric'}); }
    }
    const period = sub.period || 'monthly';
    const periodLabel = period === 'monthly' ? '/mo' : period === 'yearly' ? '/yr' : period === 'weekly' ? '/wk' : period === 'quarterly' ? '/qtr' : '';

    row.innerHTML = `
      <div class="sub-icon-box">${esc(sub.icon || catMeta.icon)}</div>
      <div class="sub-info">
        <div class="sub-name-row">
          <span class="sub-name">${esc(sub.name || 'Untitled')}</span>
          <span class="sub-cat-badge">${catMeta.icon} ${catMeta.label}</span>
        </div>
        <div class="sub-meta">
          <span class="sub-meta-next ${nextClass}">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="2.5" width="9" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M4 1v2M8 1v2M1.5 5h9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            ${esc(nextLabel)}
          </span>
          ${sub.notes ? `<span title="${esc(sub.notes)}">📝</span>` : ''}
          ${sub.url ? `<span title="${esc(sub.url)}">🔗</span>` : ''}
        </div>
      </div>
      <div class="sub-cost">
        <div class="sub-cost-val">${formatMoney(sub.cost || 0, sub.currency || 'USD')}</div>
        <div class="sub-cost-period">${esc(periodLabel)}</div>
      </div>
      <div class="sub-actions">
        <button class="sub-action-btn" data-act="pause" title="${sub.paused ? 'Resume' : 'Pause'}">
          ${sub.paused
            ? '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3 2l6 3.5L3 9V2z" fill="currentColor"/></svg>'
            : '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="3" y="2" width="2" height="7" fill="currentColor"/><rect x="6" y="2" width="2" height="7" fill="currentColor"/></svg>'}
        </button>
        ${sub.url ? `<button class="sub-action-btn" data-act="open" title="Open website"><svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M4 2.5H2a1 1 0 00-1 1v6.5A1 1 0 002 11h6.5a1 1 0 001-1V8M7 1h4m0 0v4M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ''}
        <button class="sub-action-btn" data-act="edit" title="Edit"><svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.5l2 2L4 10l-2.5.5L2 8l6.5-6.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
        <button class="sub-action-btn danger" data-act="del" title="Delete"><svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V1.5h3V3M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>`;

    row.addEventListener('click', e => {
      const act = e.target.closest('.sub-action-btn')?.dataset.act;
      if (act === 'pause') { State.snapshot('Pause sub'); sub.paused = !sub.paused; State.persist(); renderSubs(); return; }
      if (act === 'open') { chrome.tabs.create({ url: sub.url }); return; }
      if (act === 'del') { if (confirm(`Delete "${sub.name}"?`)) { State.snapshot('Delete sub'); const subs = getSubs(); const i = subs.findIndex(x => x.id === sub.id); if (i > -1) subs.splice(i, 1); State.persist(); renderSubs(); } return; }
      // default → edit
      openSubForm(sub);
    });
    list.appendChild(row);
  });
}

function openSubForm(existing) {
  subEditingId = existing?.id || null;
  document.getElementById('sub-form-title').textContent = existing ? 'Edit subscription' : 'New subscription';
  document.getElementById('sub-name').value = existing?.name || '';
  document.getElementById('sub-cost').value = existing?.cost || '';
  document.getElementById('sub-cur').value = existing?.currency || (State.get().subSettings?.defaultCurrency || 'USD');
  document.getElementById('sub-period').value = existing?.period || 'monthly';
  document.getElementById('sub-next').value = existing?.nextBilling || nextMonthStr();
  document.getElementById('sub-cat').value = existing?.category || 'entertainment';
  document.getElementById('sub-url').value = existing?.url || '';
  document.getElementById('sub-notes').value = existing?.notes || '';
  document.getElementById('sub-remind').checked = existing?.remind !== false;
  document.getElementById('sub-paused').checked = !!existing?.paused;
  document.getElementById('sub-icon-val').textContent = existing?.icon || SUB_CAT_META[existing?.category || 'entertainment'].icon;
  document.querySelectorAll('#sub-color-row .csw').forEach(c => c.classList.toggle('active', c.dataset.c === (existing?.color || '#6366f1')));
  document.getElementById('sub-form-delete').style.display = existing ? '' : 'none';
  document.getElementById('sub-form').classList.remove('hidden');
  setTimeout(() => document.getElementById('sub-name').focus(), 40);
}
function closeSubForm() { document.getElementById('sub-form').classList.add('hidden'); subEditingId = null; }
function nextMonthStr() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

async function saveSubForm() {
  const name = document.getElementById('sub-name').value.trim();
  if (!name) { toast('Name is required', { danger: true }); return; }
  const cost = parseFloat(document.getElementById('sub-cost').value) || 0;
  const currency = document.getElementById('sub-cur').value;
  const period = document.getElementById('sub-period').value;
  const nextBilling = document.getElementById('sub-next').value;
  const category = document.getElementById('sub-cat').value;
  const url = document.getElementById('sub-url').value.trim();
  const notes = document.getElementById('sub-notes').value.trim();
  const remind = document.getElementById('sub-remind').checked;
  const paused = document.getElementById('sub-paused').checked;
  const icon = document.getElementById('sub-icon-val').textContent;
  const color = document.querySelector('#sub-color-row .csw.active')?.dataset.c || '#6366f1';

  State.snapshot(subEditingId ? 'Edit sub' : 'Add sub');
  const subs = getSubs();
  let sub;
  if (subEditingId) {
    sub = subs.find(x => x.id === subEditingId);
    if (!sub) return;
    Object.assign(sub, { name, cost, currency, period, nextBilling, category, url, notes, remind, paused, icon, color });
  } else {
    sub = { id: uid(), name, cost, currency, period, nextBilling, category, url, notes, remind, paused, icon, color };
    subs.push(sub);
  }
  // Set alarm for reminder
  try {
    await chrome.alarms.clear('te-sub-' + sub.id);
    if (!paused && remind && nextBilling) {
      const d = new Date(nextBilling + 'T09:00');
      d.setDate(d.getDate() - 3);
      if (d.getTime() > Date.now()) await chrome.alarms.create('te-sub-' + sub.id, { when: d.getTime() });
    }
  } catch {}
  State.persist();
  closeSubForm();
  renderSubs();
}

function deleteSubForm() {
  if (!subEditingId) return;
  if (!confirm('Delete this subscription?')) return;
  State.snapshot('Delete sub');
  const subs = getSubs();
  const i = subs.findIndex(x => x.id === subEditingId);
  if (i > -1) subs.splice(i, 1);
  try { chrome.alarms.clear('te-sub-' + subEditingId); } catch {}
  State.persist();
  closeSubForm();
  renderSubs();
}

function bindSubs() {
  // Subscriptions are now opened from the Tools Hub (see bindToolsHub)
  document.getElementById('subs-close').onclick = closeSubsTracker;
  document.getElementById('subs-overlay').addEventListener('click', e => {
    if (e.target.id === 'subs-overlay') closeSubsTracker();
  });
  document.getElementById('subs-add-btn').onclick = () => openSubForm(null);
  document.getElementById('subs-empty-add').onclick = () => openSubForm(null);
  document.getElementById('subs-currency').onchange = e => {
    const s = State.get();
    if (!s.subSettings) s.subSettings = {};
    s.subSettings.defaultCurrency = e.target.value;
    State.persist(); renderSubs();
  };
  document.querySelectorAll('.subs-chip').forEach(c => {
    c.onclick = () => { subFilter = c.dataset.filter; renderSubs(); };
  });
  // Form
  document.getElementById('sub-form-x').onclick = closeSubForm;
  document.getElementById('sub-form-cancel').onclick = closeSubForm;
  document.getElementById('sub-form-save').onclick = saveSubForm;
  document.getElementById('sub-form-delete').onclick = deleteSubForm;
  document.getElementById('sub-form').addEventListener('click', e => {
    if (e.target.id === 'sub-form') closeSubForm();
  });
  document.getElementById('sub-icon-trigger').onclick = (e) => {
    e.stopPropagation();
    openEmojiPicker({ kind: 'sub-modal' }, e.currentTarget);
  };
  // Color row in sub form
  document.querySelectorAll('#sub-color-row .csw').forEach(c => {
    c.onclick = () => {
      document.querySelectorAll('#sub-color-row .csw').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
    };
    c.setAttribute('aria-label', 'Color ' + (c.dataset.c || ''));
    enableKeyboardClick(c);
  });
  // Auto-icon when category changes (only if not manually set)
  document.getElementById('sub-cat').onchange = e => {
    if (!subEditingId) {
      document.getElementById('sub-icon-val').textContent = SUB_CAT_META[e.target.value].icon;
    }
  };
}

// ════════════════════════════════════════════════════════════════
// GROUP FOCUS MODE - expand single group into full-page view
// ════════════════════════════════════════════════════════════════
let focusedGroupId = null;
function openGroupFocus(gId) {
  const info = findGroup(gId);
  if (!info) return;
  focusedGroupId = gId;
  let overlay = document.getElementById('group-focus-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'group-focus-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="gf-bar">
      <button class="gf-back" id="gf-back">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Back
      </button>
      <div class="gf-title">
        <span class="gf-sym">${esc(info.group.symbol || '📁')}</span>
        <span class="gf-name">${esc(info.group.name)}</span>
        <span class="gf-cnt">${info.group.items.length} items</span>
      </div>
      <button class="gf-close" id="gf-close">
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="gf-canvas" id="gf-canvas"></div>`;
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  const canvas = overlay.querySelector('#gf-canvas');
  // Build a mega column for this group only
  const col = buildGroupCol(info.group);
  col.classList.add('gcol-focused');
  // Override sizing
  col.style.width = 'min(900px, 100%)';
  const cards = col.querySelector('.gcol-cards');
  if (cards) {
    cards.style.maxHeight = 'calc(100vh - 180px)';
    cards.style.height = 'auto';
  }
  canvas.appendChild(col);

  overlay.querySelector('#gf-back').onclick = closeGroupFocus;
  overlay.querySelector('#gf-close').onclick = closeGroupFocus;
}
function closeGroupFocus() {
  const overlay = document.getElementById('group-focus-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.style.overflow = '';
  focusedGroupId = null;
  renderBoard();
}
// ════════════════════════════════════════════════════════════════
// FLOATING TOOL WIDGETS - pop tools out as draggable mini windows
// ════════════════════════════════════════════════════════════════
const FLOATING_TOOLS = {
  pomodoro: { title: 'Pomodoro', icon: '🍅' },
  finance:  { title: 'Finance',  icon: '💰' },
  habits:   { title: 'Habits',   icon: '🔁' },
  water:    { title: 'Water',    icon: '💧' },
  goals:    { title: 'Goals',    icon: '🎯' },
  subs:     { title: 'Subs',     icon: '💳' },
  books:    { title: 'Reading',  icon: '📚' },
  workout:  { title: 'Workout',  icon: '💪' }
};

function getFloating() {
  const s = State.get();
  if (!s.floating) s.floating = [];
  return s.floating;
}

function popOutTool(toolKey) {
  const f = getFloating();
  if (f.find(x => x.tool === toolKey)) {
    toast('Already floating');
    return;
  }
  f.push({
    tool: toolKey,
    x: 100 + f.length * 30,
    y: 100 + f.length * 30,
    w: 280,
    h: 200,
    minimized: false
  });
  // Close the source overlay
  const overlayMap = {
    pomodoro: 'pomo-overlay',
    finance:  'fin-overlay',
    habits:   'habit-overlay',
    water:    'water-overlay',
    goals:    'goals-overlay',
    subs:     'subs-overlay',
    books:    'books-overlay',
    workout:  'workout-overlay'
  };
  const ovId = overlayMap[toolKey];
  const ovEl = ovId ? document.getElementById(ovId) : null;
  if (ovEl && !ovEl.classList.contains('hidden')) {
    ovEl.classList.add('hidden');
    unlockBodyScroll();
  }
  State.persist();
  renderFloatingWidgets();
}

function closeFloating(toolKey) {
  const f = getFloating();
  const i = f.findIndex(x => x.tool === toolKey);
  if (i > -1) f.splice(i, 1);
  State.persist();
  renderFloatingWidgets();
}

function renderFloatingWidgets() {
  let layer = document.getElementById('floating-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'floating-layer';
    document.body.appendChild(layer);
  }
  const wanted = new Map(getFloating().map(w => [w.tool, w]));
  // Tear down widgets that are no longer in state. Leaving the rest alone
  // (instead of rebuilding everything) avoids the entrance animation
  // flickering on every open/close, and prevents global drag listeners
  // from being re-registered on widgets that didn't change.
  layer.querySelectorAll('.fw-window').forEach(el => {
    const tool = el.dataset.tool;
    if (!wanted.has(tool)) {
      if (el._abort) try { el._abort.abort(); } catch {}
      const body = el.querySelector('.fw-body');
      if (body && body._pomoUpdater) { clearInterval(body._pomoUpdater); body._pomoUpdater = null; }
      el.remove();
    } else {
      // Sync existing widget's position from state in case it changed.
      const w = wanted.get(tool);
      if (el.style.left !== w.x + 'px') el.style.left = w.x + 'px';
      if (el.style.top !== w.y + 'px') el.style.top = w.y + 'px';
      wanted.delete(tool);
    }
  });
  // Mount only newly added widgets — these animate in fresh.
  wanted.forEach(w => layer.appendChild(buildFloatingWidget(w)));
}

function buildFloatingWidget(w) {
  const meta = FLOATING_TOOLS[w.tool] || { title: w.tool, icon: '⚡' };
  const el = document.createElement('div');
  el.className = 'fw-window' + (w.minimized ? ' minimized' : '');
  el.dataset.tool = w.tool;
  el.style.left = w.x + 'px';
  el.style.top = w.y + 'px';
  if (!w.minimized) {
    el.style.width = w.w + 'px';
    el.style.height = w.h + 'px';
  }

  // Per-widget AbortController so global drag/resize listeners get cleaned
  // up when the widget is torn down (prevents listener-leak induced lag).
  const ac = new AbortController();
  el._abort = ac;
  const sig = ac.signal;

  el.innerHTML = `
    <div class="fw-titlebar">
      <span class="fw-icon">${meta.icon}</span>
      <span class="fw-title">${esc(meta.title)}</span>
      <div class="fw-actions">
        <button class="fw-btn" data-act="min" title="${w.minimized ? 'Restore' : 'Minimize'}">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="${w.minimized ? 'M2 4h6v2H2z' : 'M2 7h6'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>
        </button>
        <button class="fw-btn" data-act="open" title="Open full">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1.5H2A.5.5 0 001.5 2v1M7 1.5h1A.5.5 0 018.5 2v1M3 8.5H2A.5.5 0 011.5 8V7M7 8.5h1A.5.5 0 008.5 8V7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        </button>
        <button class="fw-btn fw-close" data-act="close" title="Close">
          <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      </div>
    </div>
    <div class="fw-body" id="fw-body-${w.tool}"></div>
    <div class="fw-resize"></div>`;

  // Render compact tool view
  const body = el.querySelector('.fw-body');
  if (!w.minimized) renderFloatingBody(w.tool, body);

  // Buttons
  el.querySelectorAll('.fw-btn').forEach(b => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const a = b.dataset.act;
      if (a === 'close') closeFloating(w.tool);
      else if (a === 'min') {
        w.minimized = !w.minimized;
        State.persist();
        toggleFloatingMinimize(el, w);
      } else if (a === 'open') {
        // Open the full tool overlay AND remove from floating
        closeFloating(w.tool);
        if (w.tool === 'pomodoro') openPomo();
        else if (w.tool === 'finance') openFin();
        else if (w.tool === 'habits') openHabits();
        else if (w.tool === 'water') openWater();
        else if (w.tool === 'goals') openGoals();
        else if (w.tool === 'subs') openSubsTracker();
        else if (w.tool === 'books') openBooks();
        else if (w.tool === 'workout') openWorkout();
      }
    };
  });

  // Drag the title bar — rAF throttled to keep at 60fps and avoid jank
  // even when several widgets are open.
  const tb = el.querySelector('.fw-titlebar');
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  tb.addEventListener('mousedown', (e) => {
    if (e.target.closest('.fw-actions')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startLeft = w.x; startTop = w.y;
    el.classList.add('fw-dragging');
    el.style.zIndex = 9999;
    e.preventDefault();
  }, { signal: sig });
  const onMove = rafThrottle((e) => {
    if (!dragging) return;
    w.x = Math.max(0, Math.min(window.innerWidth - 60, startLeft + (e.clientX - startX)));
    w.y = Math.max(0, Math.min(window.innerHeight - 30, startTop + (e.clientY - startY)));
    el.style.left = w.x + 'px';
    el.style.top = w.y + 'px';
  });
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('fw-dragging');
    State.persist();
  };
  document.addEventListener('mousemove', onMove, { signal: sig });
  document.addEventListener('mouseup', onUp, { signal: sig });

  // Resize
  const resizer = el.querySelector('.fw-resize');
  if (resizer && !w.minimized) {
    let resizing = false, rsx = 0, rsy = 0, rsw = 0, rsh = 0;
    resizer.addEventListener('mousedown', (e) => {
      resizing = true;
      rsx = e.clientX; rsy = e.clientY;
      rsw = w.w; rsh = w.h;
      e.stopPropagation();
      e.preventDefault();
    }, { signal: sig });
    const onResMove = rafThrottle((e) => {
      if (!resizing) return;
      w.w = Math.max(220, rsw + (e.clientX - rsx));
      w.h = Math.max(120, rsh + (e.clientY - rsy));
      el.style.width = w.w + 'px';
      el.style.height = w.h + 'px';
    });
    const onResUp = () => {
      if (!resizing) return;
      resizing = false;
      State.persist();
      renderFloatingBody(w.tool, body);
    };
    document.addEventListener('mousemove', onResMove, { signal: sig });
    document.addEventListener('mouseup', onResUp, { signal: sig });
  }

  // Bring to front on click
  el.addEventListener('mousedown', () => {
    el.style.zIndex = 9999;
    document.querySelectorAll('.fw-window').forEach(o => { if (o !== el) o.style.zIndex = 9990; });
  }, { signal: sig });

  return el;
}

// In-place minimize/restore avoids the full rebuild that re-runs the
// fwIn entrance animation across every widget (which is what made
// the popouts flicker on toggle).
function toggleFloatingMinimize(el, w) {
  if (w.minimized) {
    el.classList.add('minimized');
    el.style.width = '';
    el.style.height = '';
  } else {
    el.classList.remove('minimized');
    el.style.width = w.w + 'px';
    el.style.height = w.h + 'px';
    const body = el.querySelector('.fw-body');
    if (body) renderFloatingBody(w.tool, body);
  }
  const minBtn = el.querySelector('.fw-btn[data-act="min"]');
  if (minBtn) {
    minBtn.title = w.minimized ? 'Restore' : 'Minimize';
    minBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10"><path d="${w.minimized ? 'M2 4h6v2H2z' : 'M2 7h6'}" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>`;
  }
}

function renderFloatingBody(tool, container) {
  if (tool === 'pomodoro') renderFloatingPomo(container);
  else if (tool === 'finance') renderFloatingFin(container);
  else if (tool === 'habits') renderFloatingHabits(container);
  else if (tool === 'water') renderFloatingWater(container);
  else if (tool === 'goals') renderFloatingGoals(container);
  else if (tool === 'subs') renderFloatingSubs(container);
  else if (tool === 'books') renderFloatingBooks(container);
  else if (tool === 'workout') renderFloatingWorkout(container);
}

function renderFloatingBooks(c) {
  const books = getBooks();
  const reading = books.filter(b => b.status === 'reading').length;
  const finishedYr = books.filter(b => {
    if (b.status !== 'finished' || !b.date) return false;
    return new Date(b.date).getFullYear() === new Date().getFullYear();
  }).length;
  const goal = getBooksCfg().yearlyGoal || 12;
  c.innerHTML = `
    <div class="fw-fin">
      <div class="fw-fin-stat">
        <div class="fw-fin-lbl">Currently reading</div>
        <div class="fw-fin-val">${reading}</div>
        <div class="fw-fin-sub">${finishedYr}/${goal} done this year</div>
      </div>
      <button class="fw-quickadd-btn" data-a="add">📖 Open shelves</button>
    </div>`;
  c.querySelector('[data-a=add]').onclick = () => { closeFloating('books'); openBooks(); };
}

function renderFloatingWorkout(c) {
  const wos = getWorkouts();
  const now = Date.now();
  const weekMs = 7 * 86400000;
  const weekCt = wos.filter(w => now - new Date(w.date).getTime() < weekMs);
  const weekMin = weekCt.reduce((a, w) => a + (Number(w.duration) || 0), 0);
  c.innerHTML = `
    <div class="fw-fin">
      <div class="fw-fin-stat">
        <div class="fw-fin-lbl">This week</div>
        <div class="fw-fin-val">${weekCt.length} · ${weekMin}m</div>
        <div class="fw-fin-sub">🔥 ${computeWorkoutStreak()} day streak</div>
      </div>
      <button class="fw-quickadd-btn" data-a="add">+ Log workout</button>
    </div>`;
  c.querySelector('[data-a=add]').onclick = () => { closeFloating('workout'); openWorkout(); };
}

function renderFloatingPomo(c) {
  const p = getPomo();
  const total = (pomoState.mode === 'focus' ? p.settings.focus : pomoState.mode === 'short' ? p.settings.short : p.settings.long) * 60;
  const remaining = pomoState.remaining || total;
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  c.innerHTML = `
    <div class="fw-pomo">
      <div class="fw-pomo-time">${m}:${String(s).padStart(2,'0')}</div>
      <div class="fw-pomo-mode">${pomoState.mode}</div>
      <div class="fw-pomo-ctrls">
        <button class="fw-mini-btn" data-a="reset"><svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M10 4.5a4 4 0 10-1 5m1-5V2m0 2.5h-2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="fw-mini-btn primary" data-a="toggle">${pomoState.running ? '⏸' : '▶'}</button>
        <button class="fw-mini-btn" data-a="skip"><svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 3l5 3-5 3V3zM9 3v6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>`;
  c.querySelectorAll('.fw-mini-btn').forEach(b => b.onclick = () => {
    const a = b.dataset.a;
    if (a === 'toggle') (pomoState.running ? pausePomoTimer() : startPomoTimer());
    else if (a === 'reset') resetPomo();
    else if (a === 'skip') onPomoFinish();
    setTimeout(() => renderFloatingBody('pomodoro', c), 50);
  });
  // Tick: only update the time text — full re-render only on state changes.
  if (pomoState.running && !c._pomoUpdater) {
    c._pomoUpdater = setInterval(() => {
      if (!document.contains(c)) { clearInterval(c._pomoUpdater); c._pomoUpdater = null; return; }
      const timeEl = c.querySelector('.fw-pomo-time');
      if (!timeEl) { clearInterval(c._pomoUpdater); c._pomoUpdater = null; return; }
      const mm = Math.floor(pomoState.remaining / 60);
      const ss = pomoState.remaining % 60;
      timeEl.textContent = `${mm}:${String(ss).padStart(2,'0')}`;
    }, 1000);
  } else if (!pomoState.running && c._pomoUpdater) {
    clearInterval(c._pomoUpdater);
    c._pomoUpdater = null;
  }
}

function renderFloatingFin(c) {
  const f = getFin();
  const cur = f.settings?.defaultCurrency || 'TWD';
  const sym = ({ USD:'$', EUR:'€', GBP:'£', TWD:'NT$', JPY:'¥', CNY:'¥', KRW:'₩' })[cur] || '$';
  const today = new Date().toISOString().slice(0, 10);
  const todayTxns = (f.txns || []).filter(t => (t.date || '').slice(0, 10) === today);
  const FX = { USD:1, EUR:1.09, GBP:1.28, TWD:0.031, JPY:0.0067, CNY:0.14, KRW:0.00074 };
  const totalToday = todayTxns.reduce((a, t) => a + Number(t.amount) * (FX[t.currency] || 1) / (FX[cur] || 1), 0);
  c.innerHTML = `
    <div class="fw-fin">
      <div class="fw-fin-stat">
        <div class="fw-fin-lbl">Today</div>
        <div class="fw-fin-val">${sym}${totalToday.toFixed(cur === 'JPY' || cur === 'KRW' ? 0 : 2)}</div>
        <div class="fw-fin-sub">${todayTxns.length} transactions</div>
      </div>
      <button class="fw-quickadd-btn" data-a="add">+ Quick log</button>
    </div>`;
  c.querySelector('[data-a=add]').onclick = () => { closeFloating('finance'); openFin(); };
}

function renderFloatingHabits(c) {
  const habits = getHabits();
  const today = new Date().toISOString().slice(0, 10);
  if (!habits.length) {
    c.innerHTML = `<div class="fw-empty">No habits yet</div>`;
    return;
  }
  c.innerHTML = `<div class="fw-habits">${habits.slice(0, 6).map(h => {
    const done = (h.dates || []).includes(today);
    return `<div class="fw-habit-row" data-id="${h.id}">
      <span class="fw-habit-icon">${esc(h.icon || '✅')}</span>
      <span class="fw-habit-name">${esc(h.name)}</span>
      <button class="fw-habit-toggle ${done ? 'done' : ''}" data-id="${h.id}">${done ? '✓' : ' '}</button>
    </div>`;
  }).join('')}</div>`;
  c.querySelectorAll('.fw-habit-toggle').forEach(btn => btn.onclick = () => {
    const h = habits.find(x => x.id === btn.dataset.id);
    if (!h) return;
    State.snapshot('Habit toggle');
    h.dates = h.dates || [];
    if (h.dates.includes(today)) h.dates = h.dates.filter(d => d !== today);
    else h.dates.push(today);
    State.persist();
    renderFloatingHabits(c);
  });
}

function renderFloatingWater(c) {
  const w = getWater();
  const today = new Date().toISOString().slice(0, 10);
  const cnt = w.days[today] || 0;
  const pct = Math.min(100, (cnt / w.goal) * 100);
  c.innerHTML = `
    <div class="fw-water">
      <div class="fw-water-bar"><div class="fw-water-fill" style="width:${pct}%"></div></div>
      <div class="fw-water-stat">${cnt} / ${w.goal} glasses</div>
      <div class="fw-water-ctrls">
        <button class="fw-mini-btn" data-a="-">−</button>
        <button class="fw-mini-btn primary" data-a="+">+ Glass</button>
      </div>
    </div>`;
  c.querySelectorAll('.fw-mini-btn').forEach(b => b.onclick = () => {
    State.snapshot('water');
    const w = getWater();
    if (b.dataset.a === '+') { w.days[today] = (w.days[today] || 0) + 1; w.total = (w.total || 0) + 1; }
    else { w.days[today] = Math.max(0, (w.days[today] || 0) - 1); w.total = Math.max(0, (w.total || 0) - 1); }
    State.persist();
    renderFloatingWater(c);
  });
}

function renderFloatingGoals(c) {
  const goals = getGoals();
  if (!goals.length) {
    c.innerHTML = `<div class="fw-empty">No goals yet</div>`;
    return;
  }
  c.innerHTML = `<div class="fw-goals">${goals.slice(0, 5).map(g => `
    <div class="fw-goal-row">
      <div class="fw-goal-name">${esc(g.name)}</div>
      <div class="fw-goal-bar"><div class="fw-goal-fill" style="width:${g.progress || 0}%"></div></div>
      <span class="fw-goal-pct">${g.progress || 0}%</span>
    </div>`).join('')}</div>`;
}

function renderFloatingSubs(c) {
  const subs = getSubs();
  if (!subs.length) {
    c.innerHTML = `<div class="fw-empty">No subscriptions yet</div>`;
    return;
  }
  const mainCur = State.get().subSettings?.defaultCurrency || 'USD';
  const monthlyUSD = subs.reduce((a, s) => a + subMonthlyCostUSD(s), 0);
  const monthly = monthlyUSD / (FX_TO_USD[mainCur] || 1);
  // Upcoming in 7 days (by next billing date)
  const upcoming = subs.filter(s => {
    if (s.paused) return false;
    const d = daysUntil(s.nextBilling);
    return d != null && d >= 0 && d <= 7;
  }).sort((a, b) => (daysUntil(a.nextBilling) ?? 9999) - (daysUntil(b.nextBilling) ?? 9999)).slice(0, 4);
  c.innerHTML = `
    <div class="fw-subs">
      <div class="fw-subs-stat">
        <div class="fw-subs-lbl">Monthly</div>
        <div class="fw-subs-val">${formatMoney(monthly, mainCur)}</div>
      </div>
      ${upcoming.length ? `<div class="fw-subs-up">${upcoming.map(s => `
        <div class="fw-subs-row">
          <span class="fw-subs-name">${esc(s.name)}</span>
          <span class="fw-subs-days">${(daysUntil(s.nextBilling) || 0)}d</span>
        </div>`).join('')}</div>` : `<div class="fw-empty">No upcoming bills</div>`}
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// CANVAS VIEW (free positioning, idea-board style)
// ════════════════════════════════════════════════════════════════
function getCanvasPositions() {
  const cat = activeCat();
  if (!cat) return {};
  if (!cat.canvasPositions) cat.canvasPositions = {};
  return cat.canvasPositions;
}

function renderCanvasView() {
  const $b = document.getElementById('board');
  $b.innerHTML = '';
  $b.classList.remove('list-mode');
  $b.classList.add('canvas-mode');
  const cat = activeCat(); if (!cat) return;

  if (!cat.groups.length) {
    $b.innerHTML = `<div class="board-empty"><p>No groups in <strong>${esc(cat.name)}</strong>.<br>Add a group, then drag it anywhere on the canvas.</p></div>`;
    return;
  }

  // Canvas wrapper - large scrollable area
  const wrap = document.createElement('div');
  wrap.className = 'cv-canvas';
  $b.appendChild(wrap);

  // Auto-layout for groups without saved positions
  const positions = getCanvasPositions();
  let nextX = 30, nextY = 30, rowH = 0;
  cat.groups.forEach((g, i) => {
    if (!positions[g.id]) {
      // Auto-place in a flow grid
      positions[g.id] = { x: nextX, y: nextY };
      nextX += 320;
      if (nextX > 960) { nextX = 30; nextY += 380; }
    }
  });

  cat.groups.forEach(g => {
    const pos = positions[g.id] || { x: 30, y: 30 };
    const col = buildGroupCol(g);
    col.classList.add('cv-group');
    col.style.left = (pos.x || 0) + 'px';
    col.style.top = (pos.y || 0) + 'px';
    if (!col.style.width) col.style.width = '290px';

    // Make the header a drag handle
    const hd = col.querySelector('.gcol-hd');
    if (hd) {
      let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
      hd.addEventListener('mousedown', (e) => {
        // Don't drag when clicking buttons or symbol or input
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.gcol-sym-wrap')) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        startLeft = parseFloat(col.style.left) || 0;
        startTop = parseFloat(col.style.top) || 0;
        col.classList.add('cv-dragging');
        e.preventDefault();
      });
      const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const newX = Math.max(0, startLeft + dx);
        const newY = Math.max(0, startTop + dy);
        col.style.left = newX + 'px';
        col.style.top = newY + 'px';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        col.classList.remove('cv-dragging');
        positions[g.id] = {
          x: parseFloat(col.style.left) || 0,
          y: parseFloat(col.style.top) || 0
        };
        State.persist();
        // Update wrap min-size to fit content
        sizeCanvas(wrap, cat.groups, positions);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      // Cleanup when re-rendering
      col._cvCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
    }

    wrap.appendChild(col);
  });

  sizeCanvas(wrap, cat.groups, positions);
  applySearchFilter();
}

function sizeCanvas(wrap, groups, positions) {
  let maxX = 0, maxY = 0;
  for (const g of groups) {
    const p = positions[g.id] || { x: 0, y: 0 };
    const el = wrap.querySelector(`.gcol[data-gid="${g.id}"]`);
    const w = el ? el.offsetWidth : 290;
    const h = el ? el.offsetHeight : 300;
    maxX = Math.max(maxX, p.x + w + 100);
    maxY = Math.max(maxY, p.y + h + 100);
  }
  wrap.style.minWidth = maxX + 'px';
  wrap.style.minHeight = maxY + 'px';
}

function renderListView() {
  const $b = document.getElementById('board');
  $b.innerHTML = '';
  $b.classList.add('list-mode');
  const cat = activeCat(); if (!cat) return;

  if (!cat.groups.length) {
    $b.innerHTML = `<div class="board-empty"><p>No groups yet in <strong>${esc(cat.name)}</strong>.</p></div>`;
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'lv-wrap';
  cat.groups.forEach(g => wrap.appendChild(buildLvGroup(g)));

  const add = document.createElement('button');
  add.className = 'lv-add-row';
  add.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13"><path d="M6.5 2v9M2 6.5h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg> New group`;
  add.onclick = () => openModal('new-group');
  wrap.appendChild(add);

  $b.appendChild(wrap);
  applySearchFilter();
}

function buildLvGroup(g) {
  const wrap = document.createElement('div');
  wrap.className = 'lv-group' + (g.collapsed ? ' collapsed' : '');
  wrap.dataset.gid = g.id;
  wrap.style.setProperty('--gcol-tint', g.color);

  const todoStat = (() => {
    const todos = g.items.filter(it => it.type === 'todo');
    if (!todos.length) return '';
    const done = todos.filter(t => t.done).length;
    return `<span class="lv-todo-cnt${done === todos.length ? ' all-done' : ''}">${done}/${todos.length}</span>`;
  })();

  const hd = document.createElement('div');
  hd.className = 'lv-group-hd';
  hd.innerHTML = `
    <span class="lv-chev"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M3.5 2.5l3 2.5-3 2.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <span class="lv-group-sym">${esc(g.symbol || '📁')}</span>
    <span class="lv-group-name">${esc(g.name)}</span>
    <span class="lv-group-cnt">${g.items.length}</span>
    ${todoStat}
    <div class="lv-group-acts">
      <button class="lv-act-btn" data-act="focus" title="Expand to full page"><svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 4V2h2M10 4V2H8M2 8v2h2M10 8v2H8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="lv-act-btn" data-act="open-all" title="Open all"><svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M4 2.5H2a1 1 0 00-1 1v6.5A1 1 0 002 11h6.5a1 1 0 001-1V8M7 1h4m0 0v4M11 1L5.5 6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="lv-act-btn" data-act="add-tab" title="Add current tab"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      <button class="lv-act-btn" data-act="more" title="More"><svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><circle cx="3" cy="6" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="9" cy="6" r="1"/></svg></button>
    </div>`;

  hd.addEventListener('click', e => {
    if (e.target.closest('.lv-group-acts') || e.target.closest('.lv-group-name[contenteditable="true"]') || e.target.closest('.lv-group-sym')) return;
    State.snapshot('Toggle');
    g.collapsed = !g.collapsed;
    wrap.classList.toggle('collapsed');
    State.persist();
  });
  hd.querySelector('.lv-group-name').addEventListener('dblclick', (e) => {
    const el = e.currentTarget;
    el.contentEditable = 'true';
    el.focus();
    el.addEventListener('blur', () => {
      el.contentEditable = 'false';
      const v = el.textContent.trim() || g.name;
      if (v !== g.name) { State.snapshot('Rename'); g.name = v; State.persist(); }
    }, { once: true });
    el.addEventListener('keydown', (kev) => { if (kev.key === 'Enter') { kev.preventDefault(); el.blur(); } if (kev.key === 'Escape') { el.textContent = g.name; el.blur(); } });
  });
  hd.querySelector('.lv-group-sym').addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPicker({ kind:'group', id: g.id }, e.currentTarget);
  });
  hd.querySelectorAll('.lv-act-btn').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'focus') openGroupFocus(g.id);
    else if (act === 'open-all') openGroupAll(g.id);
    else if (act === 'add-tab') {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (t && !isProto(t.url)) {
        if (g.items.find(it => it.type === 'tab' && it.url === t.url)) return toast('Already saved');
        State.snapshot('Add tab');
        g.items.push({ id: uid(), type:'tab', title:t.title||'Untitled', url:t.url, fav:t.favIconUrl||'' });
        if (State.get().settings.closeTabOnSave) try { await chrome.tabs.remove(t.id); } catch {}
        State.persist(); renderBoard();
      }
    }
    else if (act === 'more') showContextMenu(e.pageX, e.pageY, [
      { text:'Edit group…', icon: cmIcons.edit, action: () => openModal('edit-group', g) },
      { text:'Duplicate', icon: cmIcons.copy, action: () => duplicateGroup(g.id) },
      { text:'Add stack', icon: cmIcons.stack, action: () => openModal('new-stack', { groupId: g.id }) },
      { sep: true },
      { text:'Archive group', icon: cmIcons.archive, action: () => archiveGroup(g.id) },
      { text:'Delete', icon: cmIcons.delete, danger: true, action: () => deleteGroup(g.id) }
    ]);
  }));
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.pageX, e.pageY, [
      { text:'Edit group…', icon: cmIcons.edit, action: () => openModal('edit-group', g) },
      { text:'Open all', icon: cmIcons.open, action: () => openGroupAll(g.id) },
      { text:'Duplicate', icon: cmIcons.copy, action: () => duplicateGroup(g.id) },
      { text:'Archive', icon: cmIcons.archive, action: () => archiveGroup(g.id) },
      { text:'Delete', icon: cmIcons.delete, danger: true, action: () => deleteGroup(g.id) }
    ]);
  });
  wrap.appendChild(hd);

  const children = document.createElement('div');
  children.className = 'lv-children';
  g.items.forEach(it => children.appendChild(buildLvItem(it, g.items, g, 1)));
  wrap.appendChild(children);
  makeGroupDropZone(children, wrap, g, g.items);

  if (document.body.classList.contains('reorder-mode')) {
    wrap.draggable = true;
    wrap.addEventListener('dragstart', (e) => {
      drag = { kind:'group', srcId: g.id };
      wrap.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });
    wrap.addEventListener('dragend', () => { wrap.classList.remove('dragging'); document.querySelectorAll('.lv-group').forEach(x => { x.classList.remove('drop-before'); x.classList.remove('drop-after'); }); drag = null; });
    wrap.addEventListener('dragover', e => {
      if (drag?.kind === 'group' && drag.srcId !== g.id) {
        e.preventDefault();
        const r = wrap.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        document.querySelectorAll('.lv-group').forEach(x => { x.classList.remove('drop-before'); x.classList.remove('drop-after'); });
        wrap.classList.add(after ? 'drop-after' : 'drop-before');
      }
    });
    wrap.addEventListener('drop', e => {
      if (drag?.kind === 'group' && drag.srcId !== g.id) {
        e.preventDefault();
        const cat = activeCat();
        const r = wrap.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        State.snapshot('Reorder groups');
        const srcIdx = cat.groups.findIndex(x => x.id === drag.srcId);
        const [src] = cat.groups.splice(srcIdx, 1);
        let tgtIdx = cat.groups.findIndex(x => x.id === g.id);
        if (after) tgtIdx++;
        cat.groups.splice(tgtIdx, 0, src);
        State.persist(); renderBoard();
      }
    });
  }
  return wrap;
}

function buildLvItem(it, parentItems, group, depth) {
  if (it.type === 'stack') return buildLvStack(it, parentItems, group, depth);
  const inner = buildItem(it, parentItems, group);
  inner.classList.add('lv-item-inner');
  const row = document.createElement('div');
  row.className = 'lv-row';
  row.style.paddingLeft = (16 + depth * 18) + 'px';
  row.appendChild(inner);
  return row;
}

function buildLvStack(it, parentItems, group, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'lv-stack' + (it.expanded ? ' expanded' : '');
  wrap.dataset.id = it.id;

  const hd = document.createElement('div');
  hd.className = 'lv-stack-hd';
  hd.style.paddingLeft = (16 + depth * 18) + 'px';
  const cnt = (it.items || []).length;
  hd.innerHTML = `
    <span class="lv-chev"><svg width="9" height="9" viewBox="0 0 10 10"><path d="M3.5 2.5l3 2.5-3 2.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <span class="lv-stack-sym">${esc(it.symbol || '📚')}</span>
    <span class="lv-stack-name">${esc(it.name || 'Stack')}</span>
    <span class="lv-stack-cnt">${cnt}</span>`;
  hd.addEventListener('click', e => {
    if (e.target.closest('.lv-stack-sym') || e.target.closest('.item-check')) return;
    State.snapshot('Toggle stack');
    it.expanded = !it.expanded;
    wrap.classList.toggle('expanded');
    State.persist();
  });
  hd.querySelector('.lv-stack-sym').addEventListener('click', (e) => {
    e.stopPropagation();
    openEmojiPicker({ kind:'stack', id: it.id }, e.currentTarget);
  });
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    showContextMenu(e.pageX, e.pageY, [
      { text:'Rename', icon: cmIcons.edit, action: () => { const n = prompt('Name:', it.name); if (n) { State.snapshot('Rename'); it.name = n; State.persist(); renderBoard(); } } },
      { text:'Archive', icon: cmIcons.archive, action: () => archiveItem(it.id) }
    ]);
  });
  wrap.appendChild(hd);

  // Selection checkbox for stack
  const stackChk = document.createElement('span');
  stackChk.className = 'item-check';
  if (selectedItemIds.has(it.id)) stackChk.classList.add('checked');
  stackChk.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); toggleItemSelect(it.id); });
  hd.insertBefore(stackChk, hd.firstChild.nextSibling);

  const inner = document.createElement('div');
  inner.className = 'lv-stack-children';
  (it.items || []).forEach(sub => inner.appendChild(buildLvItem(sub, it.items, group, depth + 1)));
  wrap.appendChild(inner);
  makeGroupDropZone(inner, wrap, group, it.items);

  // Drag stack itself (move to other group)
  wrap.draggable = true;
  wrap.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    drag = { kind:'item', id: it.id, srcList: parentItems };
    wrap.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  wrap.addEventListener('dragend', () => {
    wrap.classList.remove('dragging');
    document.querySelectorAll('.dragover, .drop-target').forEach(x => { x.classList.remove('dragover'); x.classList.remove('drop-target'); });
    document.querySelectorAll('.drag-ghost').forEach(x => x.remove());
    drag = null;
  });

  // Auto-expand on hover-drag
  let expandTimer = null;
  hd.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    hd.classList.add('drop-target');
    if (!it.expanded && !expandTimer) {
      expandTimer = setTimeout(() => { it.expanded = true; wrap.classList.add('expanded'); expandTimer = null; }, 500);
    }
  });
  hd.addEventListener('dragleave', (e) => {
    if (!hd.contains(e.relatedTarget)) {
      hd.classList.remove('drop-target');
      if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
    }
  });
  hd.addEventListener('drop', async (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    hd.classList.remove('drop-target');
    if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
    it.expanded = true;
    wrap.classList.add('expanded');
    if (drag.kind === 'tab') await handleTabDropIntoList(drag.data, it.items, it.items.length);
    else if (drag.kind === 'tabs-multi') {
      State.snapshot(`Save ${drag.data.length} tabs`);
      for (const t of drag.data) {
        if (it.items.find(x => x.type === 'tab' && x.url === t.url)) continue;
        it.items.push({ id: uid(), type:'tab', title: t.title||'Untitled', url: t.url, fav: t.fav||'' });
      }
      if (State.get().settings.closeTabOnSave) for (const t of drag.data) if (t.tabId) { try { await chrome.tabs.remove(t.tabId); } catch {} }
      selectedTabIds.clear();
      State.persist(); renderBoard(); updateSelectedBadge();
    } else if (drag.kind === 'item') {
      const info = findItem(drag.id);
      if (!info) return;
      if (info.item.type === 'stack' && isDescendantOf(it.items, info.item)) { toast('Cannot nest stack in itself', { danger: true }); return; }
      if (info.item.id === it.id) return;
      State.snapshot('Move to stack');
      const [moved] = info.parent.splice(info.index, 1);
      it.items.push(moved);
      State.persist(); renderBoard();
    }
  });

  return wrap;
}

// ════════════════════════════════════════════════════════════════
// VIEW MODES (board / list) + selection / reorder mode toggles
// ════════════════════════════════════════════════════════════════
function getViewMode() { return State.get().settings.viewMode || 'board'; }
function setViewMode(mode) {
  State.get().settings.viewMode = mode;
  document.body.dataset.viewMode = mode;
  // Show appropriate icon in the toggle button
  const iBoard = document.getElementById('view-mode-icon-board');
  const iList = document.getElementById('view-mode-icon-list');
  const iCanvas = document.getElementById('view-mode-icon-canvas');
  if (iBoard) iBoard.style.display = mode === 'list' ? '' : 'none';
  if (iList) iList.style.display = mode === 'canvas' ? '' : 'none';
  if (iCanvas) iCanvas.style.display = mode === 'board' ? '' : 'none';
  const btn = document.getElementById('view-mode-btn');
  if (btn) btn.title = mode === 'board' ? 'Switch to list view' : mode === 'list' ? 'Switch to canvas view' : 'Switch to board view';
  State.persist();
  renderBoard();
}
function cycleViewMode() {
  const cur = getViewMode();
  setViewMode(cur === 'board' ? 'list' : cur === 'list' ? 'canvas' : 'board');
}

function toggleSelectMode() {
  // The button is "active" whenever the mode is on — whether it was entered
  // explicitly or implicitly by selecting items via checkboxes. A click on an
  // active button must turn everything off in one go, so treat the current
  // itemSelMode (not just explicitSelMode) as the off transition.
  if (itemSelMode) { clearItemSelection(); return; }
  explicitSelMode = true;
  syncItemSelMode();
  renderBoard();
}

function toggleReorderMode() {
  const on = document.body.classList.toggle('reorder-mode');
  document.getElementById('reorder-mode-btn').classList.toggle('active', on);
  if (on) toast('Reorder mode on — drag to rearrange. Esc to exit.');
}

// ── Drag auto-scroll: when dragging near the top/bottom of any scrollable area, scroll it ──
let autoScrollRaf = null;
function setupDragAutoScroll() {
  document.addEventListener('dragover', (e) => {
    if (!drag) return;
    if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
    const targets = document.querySelectorAll('#open-tabs, .gcol-cards, .stack-items, #board, #fin-list');
    let scrolled = false;
    targets.forEach(zone => {
      const r = zone.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right) return;
      if (e.clientY < r.top - 40 || e.clientY > r.bottom + 40) return;
      const edgeT = Math.max(0, r.top + 40 - e.clientY);
      const edgeB = Math.max(0, e.clientY - (r.bottom - 40));
      if (edgeT > 0) { zone.scrollTop -= Math.min(20, edgeT * 0.5); scrolled = true; }
      else if (edgeB > 0) { zone.scrollTop += Math.min(20, edgeB * 0.5); scrolled = true; }
    });
    // Horizontal auto-scroll for #board (the main canvas)
    const board = document.getElementById('board');
    if (board) {
      const r = board.getBoundingClientRect();
      const edgeL = Math.max(0, r.left + 60 - e.clientX);
      const edgeR = Math.max(0, e.clientX - (r.right - 60));
      if (edgeL > 0) { board.scrollLeft -= Math.min(25, edgeL * 0.4); scrolled = true; }
      else if (edgeR > 0) { board.scrollLeft += Math.min(25, edgeR * 0.4); scrolled = true; }
    }
  }, true);
}
function openToolsHub() { document.getElementById('tools-hub').classList.remove('hidden'); }
function closeToolsHub() { document.getElementById('tools-hub').classList.add('hidden'); }
function bindToolsHub() {
  document.getElementById('tools-btn').onclick = openToolsHub;
  document.getElementById('hub-close').onclick = closeToolsHub;
  document.getElementById('tools-hub').addEventListener('click', e => { if (e.target.id === 'tools-hub') closeToolsHub(); });
  document.querySelectorAll('.hub-card').forEach(c => {
    c.onclick = () => {
      const t = c.dataset.tool;
      closeToolsHub();
      if (t === 'pomodoro') openPomo();
      else if (t === 'finance') openFin();
      else if (t === 'subs') openSubsTracker();
      else if (t === 'habits') openHabits();
      else if (t === 'water') openWater();
      else if (t === 'books') openBooks();
      else if (t === 'goals') openGoals();
      else if (t === 'workout') openWorkout();
    };
  });
}

// ════════════════════════════════════════════════════════════════
// POMODORO
// ════════════════════════════════════════════════════════════════
const POMO_DEFAULT = { focus: 25, short: 5, long: 15, autoStart: false, sound: true, longEvery: 4 };
let pomoTimer = null;
let pomoState = { mode:'focus', remaining:0, running:false, session:0 };

function getPomo() {
  const s = State.get();
  if (!s.pomo) s.pomo = { settings: { ...POMO_DEFAULT }, stats: { total:0, perDay:{}, streak:0, lastDay:'' }, tasks: [] };
  if (!s.pomo.tasks) s.pomo.tasks = [];
  return s.pomo;
}

function openPomo() {
  const p = getPomo();
  // Preserve any in-progress (or paused) session so popping the overlay back
  // open doesn't snap a running timer back to a fresh focus block.
  if (!pomoState.remaining) {
    pomoState.mode = 'focus';
    pomoState.remaining = p.settings.focus * 60;
    pomoState.running = false;
  }
  const ov = document.getElementById('pomo-overlay');
  rememberOpener(ov);
  renderPomo();
  syncPomoInputs();
  ov.classList.remove('hidden');
  lockBodyScroll();
  focusFirstIn(ov);
}
function closePomo() {
  stopPomoTimer();
  const ov = document.getElementById('pomo-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}

function syncPomoInputs() {
  const p = getPomo();
  document.getElementById('pomo-dur-focus').value = p.settings.focus;
  document.getElementById('pomo-dur-short').value = p.settings.short;
  document.getElementById('pomo-dur-long').value = p.settings.long;
  document.getElementById('pomo-auto').checked = p.settings.autoStart;
  document.getElementById('pomo-sound').checked = p.settings.sound;
  document.getElementById('pomo-task').value = p.currentTask || '';
}

function renderPomo() {
  const ov = document.getElementById('pomo-overlay');
  ov.classList.remove('mode-focus','mode-short','mode-long');
  ov.classList.add('mode-' + pomoState.mode);

  const p = getPomo();
  const total = (pomoState.mode === 'focus' ? p.settings.focus : pomoState.mode === 'short' ? p.settings.short : p.settings.long) * 60;
  const pct = total ? pomoState.remaining / total : 0;
  const circ = 2 * Math.PI * 144;
  if (!_pomoRingEl) _pomoRingEl = document.querySelector('.pomo-ring-fg');
  if (_pomoRingEl) _pomoRingEl.style.strokeDashoffset = String(circ * (1 - pct));

  const m = Math.floor(pomoState.remaining / 60);
  const s = pomoState.remaining % 60;
  document.getElementById('pomo-time').textContent = `${m}:${String(s).padStart(2, '0')}`;

  const phase = pomoState.mode === 'focus' ? (pomoState.running ? 'Focusing…' : p.currentTask ? `Ready: ${p.currentTask}` : 'Ready to focus') :
                pomoState.mode === 'short' ? (pomoState.running ? 'Short break' : 'Ready for a break') :
                (pomoState.running ? 'Long break' : 'Well done — take a longer break');
  document.getElementById('pomo-phase').textContent = phase;

  // Update mode buttons
  document.querySelectorAll('.pomo-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === pomoState.mode));

  // Start btn label/icon
  const startLabel = document.getElementById('pomo-start-label');
  const startIcon = document.getElementById('pomo-start-icon');
  if (pomoState.running) {
    startLabel.textContent = 'Pause';
    startIcon.innerHTML = '<rect x="5" y="3" width="4" height="14" fill="currentColor" rx="1"/><rect x="11" y="3" width="4" height="14" fill="currentColor" rx="1"/>';
  } else {
    startLabel.textContent = pomoState.remaining !== total ? 'Resume' : 'Start';
    startIcon.innerHTML = '<path d="M5 3l12 7-12 7V3z" fill="currentColor"/>';
  }

  // Stats
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('pomo-today-count').textContent = p.stats.perDay[today] || 0;
  document.getElementById('pomo-total-count').textContent = p.stats.total || 0;
  document.getElementById('pomo-streak').textContent = p.stats.streak || 0;

  // Title indicator
  if (pomoState.running) {
    document.title = `${m}:${String(s).padStart(2,'0')} · TabNest`;
  } else {
    document.title = 'New Tab';
  }

  renderPomoTasks();
}

function renderPomoTasks() {
  const p = getPomo();
  const $list = document.getElementById('pomo-tasks-list');
  $list.innerHTML = '';
  const frag = document.createDocumentFragment();
  p.tasks.forEach(t => {
    const el = document.createElement('div');
    el.className = 'pomo-task-item' + (t.done ? ' done' : '');
    el.dataset.taskId = t.id;
    el.innerHTML = `
      <div class="pomo-task-check ${t.done ? 'checked':''}"></div>
      <span class="pomo-task-text">${esc(t.text)}</span>
      <button class="pomo-task-del"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>`;
    frag.appendChild(el);
  });
  $list.appendChild(frag);
}

// Cached pomo nodes set on first openPomo() — avoids per-tick querySelector.
let _pomoRingEl = null, _pomoTimeEl = null, _pomoLastTitle = '';
// Per-second updates for an active Pomodoro session. Only mutates the
// ring, time text, and document title — anything else (mode, phase,
// stats, tasks) needs an explicit renderPomo() call from a state change.
function tickPomo() {
  const p = getPomo();
  const total = (pomoState.mode === 'focus' ? p.settings.focus : pomoState.mode === 'short' ? p.settings.short : p.settings.long) * 60;
  const pct = total ? pomoState.remaining / total : 0;
  if (!_pomoRingEl) _pomoRingEl = document.querySelector('.pomo-ring-fg');
  if (_pomoRingEl) _pomoRingEl.style.strokeDashoffset = String(2 * Math.PI * 144 * (1 - pct));
  const m = Math.floor(pomoState.remaining / 60);
  const s = pomoState.remaining % 60;
  const timeText = `${m}:${String(s).padStart(2, '0')}`;
  if (!_pomoTimeEl) _pomoTimeEl = document.getElementById('pomo-time');
  if (_pomoTimeEl) _pomoTimeEl.textContent = timeText;
  // document.title writes are surprisingly expensive — only change when needed.
  const nextTitle = pomoState.running ? `${timeText} · TabNest` : 'New Tab';
  if (nextTitle !== _pomoLastTitle) { document.title = nextTitle; _pomoLastTitle = nextTitle; }
}
function startPomoTimer() {
  if (pomoState.running) return;
  pomoState.running = true;
  pomoTimer = setInterval(() => {
    pomoState.remaining--;
    if (pomoState.remaining <= 0) { onPomoFinish(); return; }
    tickPomo();
  }, 1000);
  renderPomo();
}
function pausePomoTimer() {
  pomoState.running = false;
  if (pomoTimer) clearInterval(pomoTimer);
  pomoTimer = null;
  renderPomo();
}
function stopPomoTimer() {
  if (pomoTimer) clearInterval(pomoTimer);
  pomoTimer = null;
  pomoState.running = false;
}
function setPomoMode(mode) {
  stopPomoTimer();
  const p = getPomo();
  pomoState.mode = mode;
  pomoState.remaining = (mode === 'focus' ? p.settings.focus : mode === 'short' ? p.settings.short : p.settings.long) * 60;
  renderPomo();
}
function resetPomo() {
  stopPomoTimer();
  const p = getPomo();
  pomoState.remaining = (pomoState.mode === 'focus' ? p.settings.focus : pomoState.mode === 'short' ? p.settings.short : p.settings.long) * 60;
  renderPomo();
}

function onPomoFinish() {
  stopPomoTimer();
  const p = getPomo();
  if (pomoState.mode === 'focus') {
    // Increment stats
    const today = new Date().toISOString().slice(0,10);
    p.stats.total = (p.stats.total || 0) + 1;
    p.stats.perDay = p.stats.perDay || {};
    p.stats.perDay[today] = (p.stats.perDay[today] || 0) + 1;
    // Streak
    if (p.stats.lastDay !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
      p.stats.streak = p.stats.lastDay === yesterday ? (p.stats.streak || 0) + 1 : 1;
      p.stats.lastDay = today;
    }
    pomoState.session++;
    State.persist();
    if (p.settings.sound) playBeep();
    // Next: long break every N, otherwise short
    const nextMode = (pomoState.session % p.settings.longEvery === 0) ? 'long' : 'short';
    setPomoMode(nextMode);
    if (p.settings.autoStart) startPomoTimer();
    try {
      new Notification('Focus session complete!', { body: 'Time for a break.', icon: chrome.runtime.getURL('icons/icon128.png') });
    } catch {}
  } else {
    // Break finished → back to focus
    setPomoMode('focus');
    if (p.settings.sound) playBeep();
    if (p.settings.autoStart) startPomoTimer();
    try {
      new Notification('Break over', { body: 'Ready to focus?', icon: chrome.runtime.getURL('icons/icon128.png') });
    } catch {}
  }
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.type = 'sine'; o.frequency.value = 880;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
    o.start(); o.stop(ctx.currentTime + 0.6);
  } catch {}
}

function bindPomo() {
  document.getElementById('pomo-close').onclick = closePomo;
  document.getElementById('pomo-start').onclick = () => (pomoState.running ? pausePomoTimer() : startPomoTimer());
  document.getElementById('pomo-reset').onclick = resetPomo;
  document.getElementById('pomo-skip').onclick = onPomoFinish;
  document.querySelectorAll('.pomo-mode-btn').forEach(b => b.onclick = () => setPomoMode(b.dataset.mode));

  const p = getPomo();
  ['focus','short','long'].forEach(k => {
    const el = document.getElementById(`pomo-dur-${k}`);
    el.addEventListener('change', () => {
      const v = parseInt(el.value, 10);
      if (v > 0) { p.settings[k] = v; State.persist(); resetPomo(); }
    });
  });
  document.getElementById('pomo-auto').addEventListener('change', e => { p.settings.autoStart = e.target.checked; State.persist(); });
  document.getElementById('pomo-sound').addEventListener('change', e => { p.settings.sound = e.target.checked; State.persist(); });
  document.getElementById('pomo-task').addEventListener('input', e => { p.currentTask = e.target.value; State.persist(); });

  document.getElementById('pomo-new-task').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      if (v) { p.tasks.push({ id: uid(), text: v, done: false }); e.target.value = ''; State.persist(); renderPomoTasks(); }
    }
  });

  // Delegate task check/delete clicks (renderPomoTasks no longer binds per-row).
  document.getElementById('pomo-tasks-list').addEventListener('click', e => {
    const item = e.target.closest('.pomo-task-item');
    if (!item) return;
    const id = item.dataset.taskId;
    const tasks = getPomo().tasks;
    const idx = tasks.findIndex(x => x.id === id);
    if (idx < 0) return;
    if (e.target.closest('.pomo-task-check')) {
      tasks[idx].done = !tasks[idx].done;
      State.persist(); renderPomoTasks();
    } else if (e.target.closest('.pomo-task-del')) {
      tasks.splice(idx, 1);
      State.persist(); renderPomoTasks();
    }
  });

  // Request notification permission on first open
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════
// FINANCE DIARY
// ════════════════════════════════════════════════════════════════
const FIN_CATS = [
  { id:'food',      icon:'🍜', label:'Food & Drinks', color:'#f97316' },
  { id:'groceries', icon:'🛒', label:'Groceries',      color:'#84cc16' },
  { id:'transport', icon:'🚃', label:'Transport',      color:'#3b82f6' },
  { id:'shopping',  icon:'🛍️', label:'Shopping',       color:'#ec4899' },
  { id:'entertain', icon:'🎬', label:'Entertainment',  color:'#a855f7' },
  { id:'bills',     icon:'💡', label:'Bills',          color:'#eab308' },
  { id:'health',    icon:'🏥', label:'Health',         color:'#ef4444' },
  { id:'education', icon:'📚', label:'Education',      color:'#06b6d4' },
  { id:'travel',    icon:'✈️', label:'Travel',         color:'#10b981' },
  { id:'other',     icon:'📦', label:'Other',          color:'#64748b' },
];
const FIN_CUR_SYM = { USD:'$', EUR:'€', GBP:'£', TWD:'NT$', JPY:'¥', CNY:'¥', KRW:'₩' };
function getFinRange() {
  return getFin().settings.range || 'today';
}
function setFinRange(r) {
  const f = getFin();
  if (!f.settings) f.settings = {};
  f.settings.range = r;
  State.persist();
}

function getFin() {
  const s = State.get();
  if (!s.fin) s.fin = { txns: [], settings: { defaultCurrency: 'TWD' } };
  return s.fin;
}

function openFin() {
  const f = getFin();
  // Populate category select
  const $cat = document.getElementById('fin-q-cat');
  $cat.innerHTML = FIN_CATS.map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');
  document.getElementById('fin-q-cur').value = f.settings.defaultCurrency || 'TWD';
  const ov = document.getElementById('fin-overlay');
  rememberOpener(ov);
  renderFin();
  ov.classList.remove('hidden');
  lockBodyScroll();
  focusFirstIn(ov);
}
function closeFin() {
  const ov = document.getElementById('fin-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}

function finFilteredTxns() {
  const f = getFin();
  const now = new Date();
  const r = getFinRange();
  let start;
  if (r === 'today') {
    start = new Date(now); start.setHours(0,0,0,0);
  } else if (r === 'week') {
    start = new Date(now); start.setDate(start.getDate() - 7);
  } else if (r === 'month') {
    start = new Date(now); start.setDate(1); start.setHours(0,0,0,0);
  } else {
    start = new Date(0);
  }
  return f.txns.filter(t => new Date(t.date).getTime() >= start.getTime());
}

function renderFin() {
  const f = getFin();
  const txns = finFilteredTxns();
  const cur = f.settings.defaultCurrency || 'TWD';
  const sym = FIN_CUR_SYM[cur] || '$';

  // Convert everything to default currency
  const FX = { USD:1, EUR:1.09, GBP:1.28, TWD:0.031, JPY:0.0067, CNY:0.14, KRW:0.00074 };
  const toDefault = (amt, c) => amt * (FX[c] || 1) / (FX[cur] || 1);

  let total = 0;
  const byCat = {};
  txns.forEach(t => {
    const v = toDefault(Number(t.amount)||0, t.currency || 'USD');
    total += v;
    byCat[t.category] = (byCat[t.category] || 0) + v;
  });

  // Stats
  const fmt = v => {
    const dec = (cur === 'JPY' || cur === 'KRW') ? 0 : 2;
    return `${sym}${v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
  };
  document.getElementById('fin-spent').textContent = fmt(total);
  document.getElementById('fin-count').textContent = txns.length;
  const _r = getFinRange();
  // For 'all' range, span = days from the oldest tx (txns are insertion-ordered).
  const days = _r === 'today' ? 1 : _r === 'week' ? 7 : _r === 'month' ? new Date().getDate() : Math.max(1, Math.ceil((Date.now() - (f.txns[0] ? new Date(f.txns[0].date).getTime() : Date.now()))/86400000));
  document.getElementById('fin-avg').textContent = fmt(total / days);
  const top = Object.entries(byCat).sort((a,b) => b[1]-a[1])[0];
  document.getElementById('fin-top').textContent = top ? FIN_CATS.find(c => c.id === top[0])?.icon + ' ' + FIN_CATS.find(c => c.id === top[0])?.label : '—';

  // Categories (ordered by spend)
  const $cats = document.getElementById('fin-cats');
  $cats.innerHTML = '';
  const catEntries = Object.entries(byCat).sort((a,b) => b[1]-a[1]);
  if (!catEntries.length) { $cats.innerHTML = `<div class="fin-empty">No spending recorded in this period.</div>`; }
  else {
    const frag = document.createDocumentFragment();
    catEntries.forEach(([catId, val]) => {
      const cat = FIN_CATS.find(c => c.id === catId) || FIN_CATS[FIN_CATS.length-1];
      const pct = total ? (val / total * 100) : 0;
      const row = document.createElement('div');
      row.className = 'fin-cat-row';
      row.style.setProperty('--cat-tint', cat.color);
      row.innerHTML = `
        <span class="fci-icon">${cat.icon}</span>
        <div class="fci-info">
          <div class="fci-name">${esc(cat.label)}</div>
          <div class="fci-bar"><div class="fci-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        </div>
        <div>
          <div class="fci-val">${fmt(val)}</div>
          <div class="fci-pct">${pct.toFixed(0)}%</div>
        </div>`;
      frag.appendChild(row);
    });
    $cats.appendChild(frag);
  }

  // Transactions — delegate clicks via bindFin's single listener on #fin-list.
  const $list = document.getElementById('fin-list');
  $list.innerHTML = '';
  if (!txns.length) { $list.innerHTML = `<div class="fin-empty">No transactions. Add one above.</div>`; }
  else {
    const frag = document.createDocumentFragment();
    txns.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(t => {
      const cat = FIN_CATS.find(c => c.id === t.category) || FIN_CATS[FIN_CATS.length-1];
      const tSym = FIN_CUR_SYM[t.currency] || '$';
      const dec = (t.currency === 'JPY' || t.currency === 'KRW') ? 0 : 2;
      const amtStr = `${tSym}${Number(t.amount).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
      const d = new Date(t.date);
      const dateStr = d.toLocaleDateString('en', { month:'short', day:'numeric' });
      const row = document.createElement('div');
      row.className = 'fin-tx-row';
      row.dataset.txId = t.id;
      row.innerHTML = `
        <span class="ftx-icon">${cat.icon}</span>
        <div class="ftx-info">
          <div class="ftx-note">${esc(t.note || cat.label)}</div>
          <div class="ftx-meta">${esc(cat.label)} · ${dateStr}</div>
        </div>
        <div class="ftx-amt">${amtStr}</div>
        <button class="ftx-del" title="Delete">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V1.5h3V3M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>`;
      frag.appendChild(row);
    });
    $list.appendChild(frag);
  }

  const _activeRange = getFinRange();
  document.querySelectorAll('.fin-tab').forEach(b => b.classList.toggle('active', b.dataset.range === _activeRange));
  renderFinSidebar(byCat, total, fmt);
}

function renderFinSidebar(byCat, total, fmt) {
  const f = getFin();
  // Donut (conic-gradient) using top categories
  const $donut = document.getElementById('fin-donut');
  const $legend = document.getElementById('fin-donut-legend');
  if ($donut && $legend) {
    const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    if (!total || !entries.length) {
      $donut.style.background = 'conic-gradient(var(--bg3) 0 360deg)';
      $legend.innerHTML = '<div style="font:11px var(--font);color:var(--text3);text-align:center;">No spending yet</div>';
    } else {
      let acc = 0;
      const stops = [];
      const legendRows = [];
      // Top 5 categories + Other bucket
      const top = entries.slice(0, 5);
      const otherSum = entries.slice(5).reduce((a, [, v]) => a + v, 0);
      top.forEach(([cid, val]) => {
        const cat = FIN_CATS.find(c => c.id === cid) || FIN_CATS[FIN_CATS.length - 1];
        const start = (acc / total) * 360;
        acc += val;
        const end = (acc / total) * 360;
        stops.push(`${cat.color} ${start}deg ${end}deg`);
        const pct = (val / total * 100).toFixed(0);
        legendRows.push(`<div class="row"><span class="swatch" style="background:${cat.color}"></span><span>${cat.icon} ${esc(cat.label)}</span><span class="pct">${pct}%</span></div>`);
      });
      if (otherSum > 0.001) {
        const start = (acc / total) * 360;
        acc += otherSum;
        const end = (acc / total) * 360;
        stops.push(`var(--text3) ${start}deg ${end}deg`);
        const pct = (otherSum / total * 100).toFixed(0);
        legendRows.push(`<div class="row"><span class="swatch" style="background:var(--text3)"></span><span>… other</span><span class="pct">${pct}%</span></div>`);
      }
      $donut.style.background = `conic-gradient(${stops.join(', ')})`;
      $legend.innerHTML = legendRows.join('');
    }
  }
  // Donut center & period label
  const $dt = document.getElementById('fin-donut-total');
  if ($dt) $dt.textContent = fmt(total).replace(/\.00$/, '');
  const $dp = document.getElementById('fin-donut-period');
  if ($dp) {
    const r = getFinRange();
    $dp.textContent = r === 'today' ? 'Today' : r === 'week' ? 'This week' : r === 'month' ? 'This month' : 'All time';
  }
  // 7-day sparkline (based on ALL transactions, not the filtered range, so it always shows the trend)
  const now = new Date(); now.setHours(0,0,0,0);
  const cur = f.settings.defaultCurrency || 'TWD';
  const FX = { USD:1, EUR:1.09, GBP:1.28, TWD:0.031, JPY:0.0067, CNY:0.14, KRW:0.00074 };
  const toDefault = (amt, c) => amt * (FX[c] || 1) / (FX[cur] || 1);
  const buckets = new Array(7).fill(0);
  f.txns.forEach(t => {
    const d = new Date(t.date); d.setHours(0,0,0,0);
    const ago = Math.round((now - d) / 86400000);
    if (ago >= 0 && ago < 7) buckets[6 - ago] += toDefault(Number(t.amount) || 0, t.currency || 'USD');
  });
  const max = Math.max(...buckets, 0.001);
  const $line = document.getElementById('fin-spark-line');
  const $fill = document.getElementById('fin-spark-fill');
  if ($line && $fill) {
    const w = 200, h = 44, pad = 2;
    const xs = buckets.map((_, i) => pad + (w - 2 * pad) * (i / 6));
    const ys = buckets.map(v => pad + (h - 2 * pad) * (1 - v / max));
    const linePath = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
    const fillPath = `${linePath} L${xs[6].toFixed(1)},${h - pad} L${xs[0].toFixed(1)},${h - pad} Z`;
    $line.setAttribute('d', linePath);
    $fill.setAttribute('d', fillPath);
  }
  const $sparkLbl = document.getElementById('fin-spark-lbl');
  if ($sparkLbl) {
    const sum7 = buckets.reduce((a, b) => a + b, 0);
    $sparkLbl.textContent = `${fmt(sum7)} · 7 days`;
  }
  // Settings inputs
  const $cur = document.getElementById('fin-default-cur');
  if ($cur && $cur !== document.activeElement) $cur.value = f.settings.defaultCurrency || 'TWD';
  const $bud = document.getElementById('fin-budget');
  if ($bud && $bud !== document.activeElement) $bud.value = f.settings.monthlyBudget || 0;
}

function addFinTxn() {
  const amt = parseFloat(document.getElementById('fin-q-amt').value);
  if (!amt || amt <= 0) return toast('Enter a valid amount', { danger:true });
  const category = document.getElementById('fin-q-cat').value;
  const currency = document.getElementById('fin-q-cur').value;
  const note = document.getElementById('fin-q-note').value.trim();
  State.snapshot('Add expense');
  const f = getFin();
  f.settings.defaultCurrency = currency; // remember last-used
  f.txns.push({ id: uid(), amount: amt, currency, category, note, date: new Date().toISOString() });
  State.persist();
  document.getElementById('fin-q-amt').value = '';
  document.getElementById('fin-q-note').value = '';
  renderFin();
  toast(`Logged ${FIN_CUR_SYM[currency] || ''}${amt}`, { undo: true });
}

function exportFinCSV() {
  const f = getFin();
  if (!f.txns.length) return toast('Nothing to export');
  const rows = [['Date','Amount','Currency','Category','Note']];
  f.txns.forEach(t => {
    const cat = FIN_CATS.find(c => c.id === t.category);
    rows.push([new Date(t.date).toISOString().slice(0,10), t.amount, t.currency, cat ? cat.label : t.category, t.note || '']);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tabnest-finance-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
  toast('Exported CSV');
}

function bindFin() {
  document.getElementById('fin-close').onclick = closeFin;
  document.getElementById('fin-overlay').addEventListener('click', e => { if (e.target.id === 'fin-overlay') closeFin(); });
  document.getElementById('fin-q-add').onclick = addFinTxn;
  document.getElementById('fin-q-amt').addEventListener('keydown', e => { if (e.key === 'Enter') addFinTxn(); });
  document.getElementById('fin-q-note').addEventListener('keydown', e => { if (e.key === 'Enter') addFinTxn(); });
  document.querySelectorAll('.fin-tab').forEach(b => b.onclick = () => { setFinRange(b.dataset.range); renderFin(); });
  document.getElementById('fin-export').onclick = exportFinCSV;
  // Delegate tx delete clicks once, not per-row on every render.
  document.getElementById('fin-list').addEventListener('click', e => {
    const delBtn = e.target.closest('.ftx-del');
    if (!delBtn) return;
    const row = delBtn.closest('.fin-tx-row');
    const id = row?.dataset.txId;
    if (!id) return;
    if (!confirm('Delete this transaction?')) return;
    State.snapshot('Delete tx');
    const all = getFin().txns; const i = all.findIndex(x => x.id === id);
    if (i > -1) all.splice(i, 1);
    State.persist(); renderFin();
  });
  // Sidebar settings
  const $cur = document.getElementById('fin-default-cur');
  if ($cur) $cur.addEventListener('change', () => {
    const f = getFin(); f.settings.defaultCurrency = $cur.value;
    const $qc = document.getElementById('fin-q-cur');
    if ($qc) $qc.value = $cur.value;
    State.persist(); renderFin();
  });
  const $bud = document.getElementById('fin-budget');
  if ($bud) $bud.addEventListener('change', () => {
    const v = Math.max(0, parseFloat($bud.value) || 0);
    getFin().settings.monthlyBudget = v;
    State.persist();
  });
}

// ════════════════════════════════════════════════════════════════
// HABITS
// ════════════════════════════════════════════════════════════════
function getHabits() {
  const s = State.get();
  if (!s.habits) s.habits = [];
  return s.habits;
}
function getHabitsCfg() {
  const s = State.get();
  if (!s.habitsCfg) s.habitsCfg = { weeklyTarget: 7, selectedId: null };
  return s.habitsCfg;
}

function openHabits() {
  const ov = document.getElementById('habit-overlay');
  rememberOpener(ov);
  renderHabits();
  ov.classList.remove('hidden');
  lockBodyScroll();
  focusFirstIn(ov);
}
function closeHabits() {
  const ov = document.getElementById('habit-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}

function renderHabits() {
  const habits = getHabits();
  const cfg = getHabitsCfg();
  const $list = document.getElementById('habit-list');
  if (!$list) return;
  const today = new Date().toISOString().slice(0,10);
  if (!habits.length) {
    $list.innerHTML = `<div class="fin-empty">No habits yet. Add one above.</div>`;
  } else {
    // Build last 7 days
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0,10));
    }
    const frag = document.createDocumentFragment();
    habits.forEach(h => {
      const doneSet = new Set(h.dates || []);
      const streak = computeHabitStreak(h);
      const row = document.createElement('div');
      row.className = 'habit-row';
      row.dataset.habitId = h.id;
      row.innerHTML = `
        <div class="hab-icon">${esc(h.icon || '✅')}</div>
        <div class="hab-info">
          <div class="hab-name">${esc(h.name)}</div>
          <div class="hab-streak">🔥 ${streak} day streak · Last 7 days</div>
        </div>
        <div class="hab-grid">
          ${days.map(d => `<div class="hab-cell ${doneSet.has(d) ? 'done':''} ${d === today ? 'today':''}" title="${d}"></div>`).join('')}
        </div>
        <button class="hab-toggle ${doneSet.has(today) ? 'done':''}">${doneSet.has(today) ? '✓ Done' : 'Mark done'}</button>
        <button class="hab-del" title="Delete"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V1.5h3V3M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
      frag.appendChild(row);
    });
    $list.innerHTML = '';
    $list.appendChild(frag);
  }
  renderHabitsSidebar();
}

function renderHabitsSidebar() {
  const habits = getHabits();
  const cfg = getHabitsCfg();
  // Stats
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== String(v)) {
      el.textContent = v;
      el.classList.remove('tool-num-pop');
      void el.offsetWidth;
      el.classList.add('tool-num-pop');
    }
  };
  let bestStreak = 0, totalChecks = 0, perfectDays = 0;
  habits.forEach(h => {
    const set = new Set(h.dates || []);
    totalChecks += set.size;
    // Compute longest streak by scanning sorted unique dates
    const sorted = [...set].sort();
    let cur = 0, best = 0, prev = null;
    sorted.forEach(d => {
      const dt = new Date(d);
      if (prev && (dt - prev) === 86400000) cur++;
      else cur = 1;
      best = Math.max(best, cur);
      prev = dt;
    });
    if (best > bestStreak) bestStreak = best;
  });
  // Perfect days = days in last 7 where ALL habits are checked
  if (habits.length) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0,10);
      if (habits.every(h => (h.dates || []).includes(key))) perfectDays++;
    }
  }
  setVal('hab-total', habits.length);
  setVal('hab-best', bestStreak);
  setVal('hab-perfect', perfectDays);
  setVal('hab-checks', totalChecks);

  // Heatmap select options
  const $sel = document.getElementById('hab-hm-select');
  if ($sel) {
    if (!habits.length) {
      $sel.innerHTML = '<option>No habits</option>';
    } else {
      let selectedId = cfg.selectedId && habits.find(h => h.id === cfg.selectedId) ? cfg.selectedId : habits[0].id;
      cfg.selectedId = selectedId;
      $sel.innerHTML = habits.map(h => `<option value="${esc(h.id)}" ${h.id === selectedId ? 'selected':''}>${esc(h.icon || '✅')} ${esc(h.name)}</option>`).join('');
    }
  }

  // 12-week heatmap (84 days, organized as 12 columns × 7 rows)
  const $hm = document.getElementById('hab-heatmap');
  if ($hm) {
    const selected = habits.find(h => h.id === cfg.selectedId) || habits[0];
    const doneSet = new Set((selected && selected.dates) || []);
    const today = new Date(); today.setHours(0,0,0,0);
    const dow = today.getDay(); // Sunday=0
    // End column is current week. Go back 11 weeks.
    const cols = [];
    for (let c = 11; c >= 0; c--) {
      const colCells = [];
      for (let r = 0; r < 7; r++) {
        const offset = c * 7 + (6 - r); // newest row at bottom-right? actually want chronological
        // Simpler: start = (84 - 1) - (c*7 + r)  in days ago
        const daysAgo = (11 - c) * 7 + (6 - r);
        // Wait, want most recent at bottom right. Let's compute date.
        const d = new Date(today);
        d.setDate(d.getDate() - daysAgo);
        const key = d.toISOString().slice(0,10);
        const isFuture = d > today;
        colCells.push(`<div class="hab-hm-cell ${doneSet.has(key) ? 'done':''} ${isFuture?'future':''}" title="${key}"></div>`);
      }
      cols.push(`<div class="hab-hm-col">${colCells.join('')}</div>`);
    }
    $hm.innerHTML = cols.join('');
  }

  // Settings input value
  const $wt = document.getElementById('hab-weekly-target');
  if ($wt && $wt !== document.activeElement) $wt.value = cfg.weeklyTarget;
}

function computeHabitStreak(h) {
  const doneSet = new Set(h.dates || []);
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    if (doneSet.has(key)) streak++;
    else if (i > 0) break; // Allow today not-yet-done
  }
  return streak;
}

function bindHabits() {
  document.getElementById('habit-close').onclick = closeHabits;
  document.getElementById('habit-overlay').addEventListener('click', e => { if (e.target.id === 'habit-overlay') closeHabits(); });
  document.getElementById('habit-add-btn').onclick = () => {
    const name = document.getElementById('habit-new-name').value.trim();
    if (!name) return toast('Enter a name', { danger: true });
    const icon = document.getElementById('habit-new-icon-val').textContent || '✅';
    State.snapshot('Add habit');
    getHabits().push({ id: uid(), name, icon, dates: [] });
    State.persist();
    document.getElementById('habit-new-name').value = '';
    renderHabits();
  };
  document.getElementById('habit-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('habit-add-btn').click(); });
  document.getElementById('habit-new-icon').onclick = (e) => {
    e.stopPropagation();
    openEmojiPicker({ kind: 'habit-icon' }, e.currentTarget);
  };
  // Delegate toggle/delete clicks once, not per-row on every render.
  document.getElementById('habit-list').addEventListener('click', e => {
    const row = e.target.closest('.habit-row');
    if (!row) return;
    const id = row.dataset.habitId;
    const habits = getHabits();
    const h = habits.find(x => x.id === id);
    if (!h) return;
    if (e.target.closest('.hab-toggle')) {
      State.snapshot('Habit toggle');
      const today = new Date().toISOString().slice(0,10);
      h.dates = h.dates || [];
      const idx = h.dates.indexOf(today);
      if (idx > -1) h.dates.splice(idx, 1); else h.dates.push(today);
      State.persist(); renderHabits();
    } else if (e.target.closest('.hab-del')) {
      if (!confirm(`Delete habit "${h.name}"?`)) return;
      State.snapshot('Delete habit');
      const idx = habits.findIndex(x => x.id === id);
      if (idx > -1) habits.splice(idx, 1);
      State.persist(); renderHabits();
    }
  });
  // Sidebar: heatmap habit selector
  const $sel = document.getElementById('hab-hm-select');
  if ($sel) $sel.addEventListener('change', () => {
    getHabitsCfg().selectedId = $sel.value;
    State.persist();
    renderHabitsSidebar();
  });
  // Sidebar: weekly target
  const $wt = document.getElementById('hab-weekly-target');
  if ($wt) $wt.addEventListener('change', () => {
    const v = Math.max(1, Math.min(7, parseInt($wt.value, 10) || 7));
    getHabitsCfg().weeklyTarget = v;
    $wt.value = v;
    State.persist();
  });
}

// ════════════════════════════════════════════════════════════════
// HYDRATION
// ════════════════════════════════════════════════════════════════
function getWater() {
  const s = State.get();
  if (!s.water) s.water = { goal: 8, days: {}, total: 0 };
  if (!s.water.glassSize) s.water.glassSize = 250;
  if (!s.water.unit) s.water.unit = 'ml';
  return s.water;
}

function openWater() {
  const ov = document.getElementById('water-overlay');
  rememberOpener(ov);
  renderWater();
  ov.classList.remove('hidden');
  lockBodyScroll();
  focusFirstIn(ov);
}
function closeWater() {
  const ov = document.getElementById('water-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}

function renderWater() {
  const w = getWater();
  const today = new Date().toISOString().slice(0,10);
  const cnt = w.days[today] || 0;
  const $val = document.getElementById('water-val');
  if ($val) $val.textContent = `${cnt} / ${w.goal}`;
  const pct = Math.min(1, cnt / w.goal);
  const circ = 2 * Math.PI * 88;
  const $fg = document.getElementById('water-ring-fg');
  if ($fg) { $fg.style.strokeDasharray = String(circ); $fg.style.strokeDashoffset = String(circ * (1 - pct)); }
  // Label includes total volume if glass-size set
  const $lbl = document.getElementById('water-lbl');
  if ($lbl) {
    const vol = cnt * w.glassSize;
    const volStr = w.unit === 'oz' ? `${(vol / 29.5735).toFixed(1)} oz` : `${vol} ml`;
    $lbl.textContent = `glasses today · ${volStr}`;
  }
  renderWaterSidebar();
}

function renderWaterSidebar() {
  const w = getWater();
  const today = new Date(); today.setHours(0,0,0,0);
  // Build last 7 days, oldest first
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    days.push({ key: d.toISOString().slice(0,10), label: d.toLocaleDateString('en', { weekday: 'narrow' }), count: w.days[d.toISOString().slice(0,10)] || 0 });
  }
  // Bars
  const $bars = document.getElementById('water-week');
  const $dayLbls = document.getElementById('water-week-days');
  if ($bars) {
    const max = Math.max(w.goal, ...days.map(d => d.count));
    $bars.innerHTML = days.map(d => {
      const pct = max ? d.count / max : 0;
      const h = Math.max(4, Math.round(pct * 80));
      return `<div class="water-week-bar ${d.count ? '' : 'empty'}" style="height:${h}px" title="${d.key}: ${d.count} glasses"><span class="ct">${d.count || ''}</span></div>`;
    }).join('');
  }
  if ($dayLbls) {
    $dayLbls.innerHTML = days.map(d => `<div class="water-week-day" style="flex:1">${d.label}</div>`).join('');
  }
  // Stats
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== String(v)) {
      el.textContent = v;
      el.classList.remove('tool-num-pop');
      void el.offsetWidth;
      el.classList.add('tool-num-pop');
    }
  };
  const weekTotal = days.reduce((a, d) => a + d.count, 0);
  const weekAvg = (weekTotal / 7).toFixed(1).replace(/\.0$/, '');
  const best = days.reduce((m, d) => Math.max(m, d.count), 0);
  setVal('water-streak-val', computeWaterStreak());
  setVal('water-total-val', w.total || 0);
  setVal('water-week-avg', weekAvg);
  setVal('water-best', best);
  // Settings inputs
  const $goal = document.getElementById('water-goal');
  if ($goal && $goal !== document.activeElement) $goal.value = w.goal;
  const $gs = document.getElementById('water-glass-size');
  if ($gs && $gs !== document.activeElement) $gs.value = w.glassSize;
  document.querySelectorAll('#water-unit-seg button').forEach(b => b.classList.toggle('active', b.dataset.unit === w.unit));
}
function computeWaterStreak() {
  const w = getWater();
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    const c = w.days[key] || 0;
    if (c >= w.goal) streak++;
    else if (i > 0) break;
  }
  return streak;
}
function bindWater() {
  document.getElementById('water-close').onclick = closeWater;
  document.getElementById('water-overlay').addEventListener('click', e => { if (e.target.id === 'water-overlay') closeWater(); });
  const today = () => new Date().toISOString().slice(0,10);
  document.getElementById('water-plus').onclick = () => {
    State.snapshot('+water');
    const w = getWater();
    w.days[today()] = (w.days[today()] || 0) + 1;
    w.total = (w.total || 0) + 1;
    State.persist(); renderWater();
  };
  document.getElementById('water-minus').onclick = () => {
    State.snapshot('-water');
    const w = getWater();
    w.days[today()] = Math.max(0, (w.days[today()] || 0) - 1);
    w.total = Math.max(0, (w.total || 0) - 1);
    State.persist(); renderWater();
  };
  document.getElementById('water-reset').onclick = () => {
    if (!confirm('Reset today\'s count?')) return;
    const w = getWater();
    const t = today();
    const cnt = w.days[t] || 0;
    w.total = Math.max(0, (w.total || 0) - cnt);
    w.days[t] = 0;
    State.persist(); renderWater();
  };
  document.getElementById('water-goal').addEventListener('change', e => {
    const v = parseInt(e.target.value);
    if (v >= 1 && v <= 20) { getWater().goal = v; State.persist(); renderWater(); }
  });
  const $gs = document.getElementById('water-glass-size');
  if ($gs) $gs.addEventListener('change', () => {
    const v = Math.max(50, Math.min(1000, parseInt($gs.value, 10) || 250));
    getWater().glassSize = v; $gs.value = v;
    State.persist(); renderWater();
  });
  document.querySelectorAll('#water-unit-seg button').forEach(b => {
    b.addEventListener('click', () => {
      getWater().unit = b.dataset.unit;
      State.persist(); renderWater();
    });
  });
}

// ════════════════════════════════════════════════════════════════
// READING / BOOKS
// ════════════════════════════════════════════════════════════════
let booksFilter = 'reading';
function getBooks() {
  const s = State.get();
  if (!s.books) s.books = [];
  return s.books;
}
function getBooksCfg() {
  const s = State.get();
  if (!s.booksCfg) s.booksCfg = { yearlyGoal: 12 };
  return s.booksCfg;
}
function openBooks() {
  const ov = document.getElementById('books-overlay');
  rememberOpener(ov);
  renderBooks();
  ov.classList.remove('hidden');
  lockBodyScroll();
  focusFirstIn(ov);
}
function closeBooks() {
  const ov = document.getElementById('books-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}
function renderBooks() {
  const books = getBooks().filter(b => b.status === booksFilter);
  const $list = document.getElementById('books-list');
  if (!$list) return;
  $list.innerHTML = '';
  if (!books.length) {
    $list.innerHTML = `<div class="fin-empty">No books in this shelf yet.</div>`;
  } else {
    const grid = document.createElement('div');
    grid.className = 'bk-grid';
    books.forEach(b => {
      const card = document.createElement('div');
      card.className = 'bk-card';
      card.innerHTML = `
        <div class="bk-title">${esc(b.title)}</div>
        <div class="bk-author">${esc(b.author || 'Unknown author')}${b.date && b.status === 'finished' ? ' · ' + new Date(b.date).toLocaleDateString('en', { month:'short', year:'numeric' }) : ''}</div>
        <div class="bk-actions">
          ${b.status !== 'reading' ? `<button data-act="reading">📖 Reading</button>` : ''}
          ${b.status !== 'finished' ? `<button data-act="finished">✅ Done</button>` : ''}
          ${b.status !== 'want' ? `<button data-act="want">🔖 Wishlist</button>` : ''}
          <button data-act="del" class="danger">Delete</button>
        </div>`;
      card.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => {
          const act = btn.dataset.act;
          if (act === 'del') {
            if (!confirm('Delete this book?')) return;
            State.snapshot('Delete book');
            const all = getBooks(); const i = all.findIndex(x => x.id === b.id);
            if (i > -1) all.splice(i, 1);
          } else {
            State.snapshot('Status');
            b.status = act;
            if (act === 'finished') b.date = new Date().toISOString();
          }
          State.persist(); renderBooks();
        };
      });
      grid.appendChild(card);
    });
    $list.appendChild(grid);
  }
  document.querySelectorAll('.books-tab').forEach(t => t.classList.toggle('active', t.dataset.st === booksFilter));
  renderBooksSidebar();
}
function renderBooksSidebar() {
  const books = getBooks();
  const cfg = getBooksCfg();
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== String(v)) {
      el.textContent = v;
      el.classList.remove('tool-num-pop');
      void el.offsetWidth;
      el.classList.add('tool-num-pop');
    }
  };
  // Shelf counts
  setVal('bk-reading-ct',  books.filter(b => b.status === 'reading').length);
  setVal('bk-finished-ct', books.filter(b => b.status === 'finished').length);
  setVal('bk-want-ct',     books.filter(b => b.status === 'want').length);
  // This month finished
  const now = new Date();
  const moStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthCt = books.filter(b => b.status === 'finished' && b.date && new Date(b.date) >= moStart).length;
  setVal('bk-mo-ct', monthCt);
  // Yearly goal ring
  const yrStart = new Date(now.getFullYear(), 0, 1);
  const yrCt = books.filter(b => b.status === 'finished' && b.date && new Date(b.date) >= yrStart).length;
  const goal = Math.max(1, cfg.yearlyGoal || 12);
  const pct = Math.min(1, yrCt / goal);
  const $ring = document.getElementById('bk-goal-ring-fg');
  if ($ring) {
    const circ = 2 * Math.PI * 56;
    $ring.style.strokeDasharray = String(circ);
    $ring.style.strokeDashoffset = String(circ * (1 - pct));
  }
  setVal('bk-goal-n', `${yrCt}/${goal}`);
  const $d = document.getElementById('bk-goal-d');
  if ($d) $d.textContent = `${now.getFullYear()} reading goal`;
  const $inp = document.getElementById('bk-goal-input');
  if ($inp && $inp !== document.activeElement) $inp.value = cfg.yearlyGoal;
}
function bindBooks() {
  document.getElementById('books-close').onclick = closeBooks;
  document.getElementById('books-overlay').addEventListener('click', e => { if (e.target.id === 'books-overlay') closeBooks(); });
  document.querySelectorAll('.books-tab').forEach(t => t.onclick = () => { booksFilter = t.dataset.st; renderBooks(); });
  document.getElementById('book-add').onclick = () => {
    const title = document.getElementById('book-title').value.trim();
    const author = document.getElementById('book-author').value.trim();
    if (!title) return toast('Enter a title', { danger: true });
    State.snapshot('Add book');
    getBooks().push({ id: uid(), title, author, status: booksFilter, date: new Date().toISOString() });
    State.persist();
    document.getElementById('book-title').value = '';
    document.getElementById('book-author').value = '';
    renderBooks();
  };
  document.getElementById('book-title').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('book-add').click(); });
  document.getElementById('book-author').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('book-add').click(); });
  const $g = document.getElementById('bk-goal-input');
  if ($g) $g.addEventListener('change', () => {
    const v = Math.max(0, Math.min(999, parseInt($g.value, 10) || 0));
    getBooksCfg().yearlyGoal = v; $g.value = v;
    State.persist(); renderBooksSidebar();
  });
}

// ════════════════════════════════════════════════════════════════
// GOALS
// ════════════════════════════════════════════════════════════════
function getGoals() {
  const s = State.get();
  if (!s.goals) s.goals = [];
  return s.goals;
}
function getGoalsCfg() {
  const s = State.get();
  if (!s.goalsCfg) s.goalsCfg = { sort: 'due', showDone: true };
  return s.goalsCfg;
}
function openGoals() {
  const ov = document.getElementById('goals-overlay');
  rememberOpener(ov);
  renderGoals();
  ov.classList.remove('hidden');
  lockBodyScroll();
  focusFirstIn(ov);
}
function closeGoals() {
  const ov = document.getElementById('goals-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}
function renderGoals() {
  const all = getGoals();
  const cfg = getGoalsCfg();
  let goals = all.slice();
  if (!cfg.showDone) goals = goals.filter(g => (g.progress || 0) < 100);
  if (cfg.sort === 'due') goals.sort((a, b) => {
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due) - new Date(b.due);
  });
  else if (cfg.sort === 'progress') goals.sort((a, b) => (b.progress || 0) - (a.progress || 0));
  else if (cfg.sort === 'created') goals.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
  const $list = document.getElementById('goals-list');
  if (!$list) return;
  $list.innerHTML = '';
  if (!goals.length) {
    $list.innerHTML = `<div class="fin-empty">No goals yet.</div>`;
  } else {
    goals.forEach(g => {
      const progress = Math.max(0, Math.min(100, g.progress || 0));
      const daysLeft = g.due ? Math.round((new Date(g.due) - Date.now()) / 86400000) : null;
      let dueCls = '', dueTxt = '';
      if (daysLeft != null) {
        if (daysLeft < 0) { dueCls = 'overdue'; dueTxt = `${-daysLeft}d overdue`; }
        else if (daysLeft <= 7) { dueCls = 'soon'; dueTxt = `${daysLeft}d left`; }
        else { dueTxt = new Date(g.due).toLocaleDateString('en', { month:'short', day:'numeric', year:'numeric' }); }
      }
      const row = document.createElement('div');
      row.className = 'goal-row';
      row.innerHTML = `
        <div class="goal-row-top">
          <span class="goal-name">${esc(g.name)}</span>
          ${dueTxt ? `<span class="goal-due ${dueCls}">${dueTxt}</span>` : ''}
        </div>
        <div class="goal-bar" title="Click to set progress"><div class="goal-bar-fill" style="width:${progress}%"></div></div>
        <div class="goal-meta">
          <span>${progress}% complete</span>
          <div class="goal-actions">
            <button data-act="-">−10%</button>
            <button data-act="+">+10%</button>
            <button data-act="100">Done</button>
            <button data-act="del" class="danger">✕</button>
          </div>
        </div>`;
      row.querySelector('.goal-bar').onclick = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const pct = Math.max(0, Math.min(100, Math.round((e.clientX - r.left) / r.width * 100)));
        State.snapshot('Goal progress');
        g.progress = pct; State.persist(); renderGoals();
      };
      row.querySelectorAll('.goal-actions button').forEach(btn => {
        btn.onclick = () => {
          const act = btn.dataset.act;
          State.snapshot('Goal');
          if (act === '+') g.progress = Math.min(100, (g.progress || 0) + 10);
          else if (act === '-') g.progress = Math.max(0, (g.progress || 0) - 10);
          else if (act === '100') g.progress = 100;
          else if (act === 'del') {
            if (!confirm('Delete this goal?')) return;
            const arr = getGoals(); const i = arr.findIndex(x => x.id === g.id);
            if (i > -1) arr.splice(i, 1);
          }
          State.persist(); renderGoals();
        };
      });
      $list.appendChild(row);
    });
  }
  renderGoalsSidebar();
}
function renderGoalsSidebar() {
  const goals = getGoals();
  const cfg = getGoalsCfg();
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.textContent !== String(v)) {
      el.textContent = v;
      el.classList.remove('tool-num-pop');
      void el.offsetWidth;
      el.classList.add('tool-num-pop');
    }
  };
  const active = goals.filter(g => (g.progress || 0) < 100);
  const done   = goals.filter(g => (g.progress || 0) >= 100);
  const overdue = active.filter(g => g.due && new Date(g.due) < Date.now());
  const avg = goals.length ? Math.round(goals.reduce((a, g) => a + (g.progress || 0), 0) / goals.length) : 0;
  setVal('go-active', active.length);
  setVal('go-done', done.length);
  setVal('go-overdue', overdue.length);
  setVal('go-avg', avg + '%');
  const $sort = document.getElementById('go-sort');
  if ($sort && $sort !== document.activeElement) $sort.value = cfg.sort;
  document.querySelectorAll('#go-show-done-seg button').forEach(b => b.classList.toggle('active', String(cfg.showDone ? 1 : 0) === b.dataset.v));
}
function bindGoals() {
  document.getElementById('goals-close').onclick = closeGoals;
  document.getElementById('goals-overlay').addEventListener('click', e => { if (e.target.id === 'goals-overlay') closeGoals(); });
  document.getElementById('goal-add').onclick = () => {
    const name = document.getElementById('goal-name').value.trim();
    const due = document.getElementById('goal-due').value;
    if (!name) return toast('Enter a goal', { danger: true });
    State.snapshot('Add goal');
    getGoals().push({ id: uid(), name, due, progress: 0, created: new Date().toISOString() });
    State.persist();
    document.getElementById('goal-name').value = '';
    document.getElementById('goal-due').value = '';
    renderGoals();
  };
  document.getElementById('goal-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('goal-add').click(); });
  const $sort = document.getElementById('go-sort');
  if ($sort) $sort.addEventListener('change', () => {
    getGoalsCfg().sort = $sort.value;
    State.persist(); renderGoals();
  });
  document.querySelectorAll('#go-show-done-seg button').forEach(b => {
    b.addEventListener('click', () => {
      getGoalsCfg().showDone = b.dataset.v === '1';
      State.persist(); renderGoals();
    });
  });
}

// ════════════════════════════════════════════════════════════════
// WORKOUT
// ════════════════════════════════════════════════════════════════
const WO_TYPES_DEFAULT = ['Run', 'Strength', 'Yoga', 'Cycling', 'Swim', 'Walk', 'HIIT', 'Stretch'];
function getWorkouts() {
  const s = State.get();
  if (!s.workouts) s.workouts = [];
  return s.workouts;
}
function getWorkoutCfg() {
  const s = State.get();
  if (!s.workoutCfg) s.workoutCfg = { weeklyMin: 150, types: WO_TYPES_DEFAULT.slice() };
  if (!s.workoutCfg.types) s.workoutCfg.types = WO_TYPES_DEFAULT.slice();
  return s.workoutCfg;
}
function openWorkout() {
  const ov = document.getElementById('workout-overlay');
  rememberOpener(ov);
  renderWorkout();
  ov.classList.remove('hidden');
  lockBodyScroll();
  focusFirstIn(ov);
}
function closeWorkout() {
  const ov = document.getElementById('workout-overlay');
  ov.classList.add('hidden');
  unlockBodyScroll();
  restoreOpener(ov);
}
function renderWorkout() {
  const wos = getWorkouts().slice().sort((a,b) => new Date(b.date) - new Date(a.date));
  const $list = document.getElementById('wo-list');
  if (!$list) return;
  $list.innerHTML = '';
  if (!wos.length) {
    $list.innerHTML = `<div class="fin-empty">No workouts logged yet.</div>`;
  } else {
    wos.forEach(w => {
      const d = new Date(w.date);
      const row = document.createElement('div');
      row.className = 'wo-row';
      row.innerHTML = `
        <div class="wo-icon">💪</div>
        <div class="wo-info">
          <div class="wo-name">${esc(w.name)}</div>
          <div class="wo-meta">${d.toLocaleDateString('en', { weekday:'short', month:'short', day:'numeric' })} · ${w.duration || '?'} min${w.note ? ' · ' + esc(w.note) : ''}</div>
        </div>
        <button class="wo-del"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V1.5h3V3M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
      row.querySelector('.wo-del').onclick = () => {
        if (!confirm('Delete this workout?')) return;
        State.snapshot('Delete workout');
        const all = getWorkouts(); const i = all.findIndex(x => x.id === w.id);
        if (i > -1) all.splice(i, 1);
        State.persist(); renderWorkout();
      };
      $list.appendChild(row);
    });
  }
  renderWorkoutSidebar();
}
function renderWorkoutSidebar() {
  const wos = getWorkouts();
  const cfg = getWorkoutCfg();
  const now = Date.now();
  const weekMs = 7 * 86400000;
  const monthMs = 30 * 86400000;
  const weekCt = wos.filter(w => now - new Date(w.date).getTime() < weekMs);
  const weekMin = weekCt.reduce((a, w) => a + (Number(w.duration) || 0), 0);
  const monthCt = wos.filter(w => now - new Date(w.date).getTime() < monthMs);
  const streak = computeWorkoutStreak();
  const goalPct = cfg.weeklyMin ? Math.min(100, Math.round(weekMin / cfg.weeklyMin * 100)) : 0;
  const $stats = document.getElementById('wo-stats');
  if ($stats) {
    $stats.innerHTML = `
      <div class="tool-mini-stat"><div class="lbl">This week</div><div class="val">${weekCt.length}</div></div>
      <div class="tool-mini-stat"><div class="lbl">Minutes</div><div class="val">${weekMin}</div></div>
      <div class="tool-mini-stat"><div class="lbl">Month total</div><div class="val">${monthCt.length}</div></div>
      <div class="tool-mini-stat"><div class="lbl">Streak</div><div class="val">${streak}d</div></div>
      <div class="tool-mini-stat" style="grid-column:1/-1"><div class="lbl">Weekly goal</div><div class="val">${goalPct}%</div></div>`;
  }
  // 30-day heatmap (10 columns × 3 rows)
  const $hm = document.getElementById('wo-heatmap');
  if ($hm) {
    const today = new Date(); today.setHours(0,0,0,0);
    const todayKey = today.toISOString().slice(0,10);
    const daySet = new Set(wos.map(w => new Date(w.date).toISOString().slice(0,10)));
    const cells = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0,10);
      cells.push(`<div class="wo-hm-cell ${daySet.has(key) ? 'done':''} ${key === todayKey ? 'today':''}" title="${key}"></div>`);
    }
    $hm.innerHTML = cells.join('');
  }
  // Workout type chips
  const $types = document.getElementById('wo-types');
  if ($types) {
    $types.innerHTML = cfg.types.map(t => `<button class="wo-type-chip" data-t="${esc(t)}">${esc(t)}</button>`).join('');
    $types.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        const $n = document.getElementById('wo-name');
        if ($n) { $n.value = b.dataset.t; $n.focus(); }
      };
    });
  }
  // Settings input
  const $wm = document.getElementById('wo-weekly-min');
  if ($wm && $wm !== document.activeElement) $wm.value = cfg.weeklyMin;
}
function computeWorkoutStreak() {
  const wos = getWorkouts();
  const daySet = new Set(wos.map(w => new Date(w.date).toISOString().slice(0,10)));
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0,10);
    if (daySet.has(key)) streak++;
    else if (i > 0) break;
  }
  return streak;
}
function bindWorkout() {
  document.getElementById('workout-close').onclick = closeWorkout;
  document.getElementById('workout-overlay').addEventListener('click', e => { if (e.target.id === 'workout-overlay') closeWorkout(); });
  document.getElementById('wo-add').onclick = () => {
    const name = document.getElementById('wo-name').value.trim();
    const duration = parseInt(document.getElementById('wo-dur').value, 10);
    const note = document.getElementById('wo-note').value.trim();
    if (!name) return toast('Enter a workout name', { danger: true });
    State.snapshot('Add workout');
    getWorkouts().push({ id: uid(), name, duration, note, date: new Date().toISOString() });
    State.persist();
    document.getElementById('wo-name').value = '';
    document.getElementById('wo-dur').value = '';
    document.getElementById('wo-note').value = '';
    renderWorkout();
  };
  document.getElementById('wo-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('wo-add').click(); });
  const $wm = document.getElementById('wo-weekly-min');
  if ($wm) $wm.addEventListener('change', () => {
    const v = Math.max(0, Math.min(2000, parseInt($wm.value, 10) || 0));
    getWorkoutCfg().weeklyMin = v; $wm.value = v;
    State.persist(); renderWorkoutSidebar();
  });
}

// ════════════════════════════════════════════════════════════════
// ONBOARDING TOUR
// ════════════════════════════════════════════════════════════════
// Step shape:
//   { target: '#sel'|null, title, body, pos?: 'left'|'right'|'above'|'below',
//     center?: bool — render a centered card with no spotlight (welcome/finish) }
const TOUR_STEPS = [
  {
    center: true,
    title: '👋 Welcome to TabNest',
    body: 'A calmer place for your tabs. In about 30 seconds you\'ll know how to save, organise, and find anything again. Use ← / → to step through, or Esc to skip.'
  },
  {
    target: '#ws-chips-stack',
    title: '🏠 Workspaces',
    body: 'Group your work into separate spaces — Work, Study, Side project. Each one keeps its own tabs, notes, and tools. Switch between them by clicking a chip.'
  },
  {
    target: '#open-tabs',
    title: '📑 Your open tabs',
    body: 'Every tab in this window shows up here. Drag one onto the board to save it for later, or use the checkbox to grab several at once.'
  },
  {
    target: '#board',
    title: '🗂️ The board',
    body: 'Drop tabs into groups, mix in notes, jot down to-dos. Right-click anything for more actions, and drag to reorder.',
    pos: 'left'
  },
  {
    target: '#cat-tabs-wrap',
    title: '📂 Categories',
    body: 'Cut a workspace into themed sections — Reading, Tasks, Inspiration. Tabs land in the active category by default.'
  },
  {
    target: '#tools-btn',
    title: '⚡ Productivity tools',
    body: 'Pomodoro, finance diary, habits, hydration, goals, reading log and more — pop any of them out as a floating widget while you work.'
  },
  {
    target: '#view-mode-btn',
    title: '🔄 Switch how it looks',
    body: 'Toggle between board columns, a Notion-style list, and a freeform canvas. Pick whichever fits the mood.'
  },
  {
    target: '#search-btn',
    title: '🔍 Find anything',
    body: 'Ctrl/⌘ + K searches every tab, note, and archive across all workspaces. Esc closes overlays, and ? opens the full shortcut sheet.'
  },
  {
    center: true,
    title: '🎉 You\'re ready',
    body: 'That\'s the lot. You can replay this any time from Settings → Show tour. Now go make something happen.'
  }
];

let tourIndex = 0;

function startTour() {
  tourIndex = 0;
  document.getElementById('tour-overlay').classList.remove('hidden');
  // Entrance animation runs once on tour mount; subsequent steps glide
  // (no fresh fade) so the content swap doesn't read as a flicker.
  const b = document.getElementById('tour-bubble');
  b.classList.remove('tour-bubble-in');
  void b.offsetWidth;
  b.classList.add('tour-bubble-in');
  showTourStep();
}
function endTour(skipped) {
  document.getElementById('tour-overlay').classList.add('hidden');
  State.get().settings.tourCompleted = true;
  State.persist();
  if (!skipped) toast('You\'re all set');
}
function showTourStep() {
  const step = TOUR_STEPS[tourIndex];
  if (!step) return endTour(false);

  const spotlight = document.getElementById('tour-spotlight');
  const bubble = document.getElementById('tour-bubble');

  // Centered intro/finish steps: no spotlight, bubble in the middle.
  if (step.center || !step.target) {
    spotlight.classList.add('tour-spotlight-off');
    bubble.classList.add('center');
    // Center based on measured size so the wider centered card stays middled.
    requestAnimationFrame(() => {
      const bw = bubble.offsetWidth || 420;
      const bh = bubble.offsetHeight || 220;
      bubble.style.top = Math.max(20, (window.innerHeight - bh) / 2) + 'px';
      bubble.style.left = Math.max(20, (window.innerWidth - bw) / 2) + 'px';
    });
  } else {
    const target = document.querySelector(step.target);
    if (!target) {
      // Skip silently if target missing in this view
      tourIndex++;
      return showTourStep();
    }
    spotlight.classList.remove('tour-spotlight-off');
    bubble.classList.remove('center');

    const r = target.getBoundingClientRect();
    const pad = 6;
    spotlight.style.top = (r.top - pad) + 'px';
    spotlight.style.left = (r.left - pad) + 'px';
    spotlight.style.width = (r.width + pad * 2) + 'px';
    spotlight.style.height = (r.height + pad * 2) + 'px';

    // Position bubble: respect pos hint, otherwise auto-fit below/above/side.
    const bubbleW = 340, bubbleH = 200, gap = 16;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top, left;
    const clampLeft = x => Math.min(vw - bubbleW - 20, Math.max(20, x));
    const clampTop = y => Math.min(vh - bubbleH - 20, Math.max(20, y));
    const fitBelow = r.bottom + bubbleH + gap < vh;
    const fitAbove = r.top - bubbleH - gap > 20;
    const fitRight = r.right + bubbleW + gap < vw;
    const fitLeft  = r.left  - bubbleW - gap > 20;
    const place = step.pos
      || (fitBelow ? 'below' : fitAbove ? 'above' : fitRight ? 'right' : fitLeft ? 'left' : 'center');
    if (place === 'left') {
      left = clampLeft(r.left - bubbleW - gap);
      top = clampTop(r.top + r.height/2 - bubbleH/2);
    } else if (place === 'right') {
      left = clampLeft(r.right + gap);
      top = clampTop(r.top + r.height/2 - bubbleH/2);
    } else if (place === 'above') {
      top = clampTop(r.top - bubbleH - gap);
      left = clampLeft(r.left + r.width/2 - bubbleW/2);
    } else if (place === 'center') {
      top = (vh - bubbleH) / 2;
      left = (vw - bubbleW) / 2;
    } else {
      top = clampTop(r.bottom + gap);
      left = clampLeft(r.left + r.width/2 - bubbleW/2);
    }
    bubble.style.top = top + 'px';
    bubble.style.left = left + 'px';
  }

  document.getElementById('tour-title').textContent = step.title;
  document.getElementById('tour-body').textContent = step.body;

  // Progress dots
  const $prog = document.getElementById('tour-progress');
  $prog.innerHTML = TOUR_STEPS.map((_, i) => `<div class="tour-dot ${i === tourIndex ? 'active' : ''}"></div>`).join('');
  $prog.querySelectorAll('.tour-dot').forEach((d, i) => {
    d.title = `Step ${i + 1} of ${TOUR_STEPS.length}`;
    d.style.cursor = 'pointer';
    d.onclick = () => { tourIndex = i; showTourStep(); };
  });

  // Step counter
  const $count = document.getElementById('tour-count');
  if ($count) $count.textContent = `${tourIndex + 1} / ${TOUR_STEPS.length}`;

  // Buttons
  const $prev = document.getElementById('tour-prev');
  const $next = document.getElementById('tour-next');
  $prev.disabled = tourIndex === 0;
  $prev.style.visibility = tourIndex === 0 ? 'hidden' : 'visible';
  $next.textContent = tourIndex === TOUR_STEPS.length - 1 ? 'Finish' : 'Next';
  // Auto-focus the primary action so Enter advances.
  $next.focus({ preventScroll: true });
}

function bindTour() {
  document.getElementById('tour-skip').onclick = () => endTour(true);
  document.getElementById('tour-prev').onclick = () => { if (tourIndex > 0) { tourIndex--; showTourStep(); } };
  document.getElementById('tour-next').onclick = () => {
    if (tourIndex < TOUR_STEPS.length - 1) { tourIndex++; showTourStep(); }
    else endTour(false);
  };
  // Keyboard nav while the tour is visible — arrows step through,
  // Enter/Space advances, Esc is already handled by the global key handler.
  document.addEventListener('keydown', e => {
    const ov = document.getElementById('tour-overlay');
    if (!ov || ov.classList.contains('hidden')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      if (tourIndex < TOUR_STEPS.length - 1) { tourIndex++; showTourStep(); }
      else endTour(false);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (tourIndex > 0) { tourIndex--; showTourStep(); }
    }
  });
  // Reposition on resize — rAF-throttled so dragging the window doesn't
  // recompute layout dozens of times per second.
  window.addEventListener('resize', rafThrottle(() => {
    if (!document.getElementById('tour-overlay').classList.contains('hidden')) showTourStep();
  }));
}

// ════════════════════════════════════════════════════════════════
// BIND STATIC UI
// ════════════════════════════════════════════════════════════════
function bindStatic() {
  document.getElementById('ws-menu-btn').onclick = openWsGrid;
  document.getElementById('wsg-close').onclick = () => document.getElementById('ws-grid-overlay').classList.add('hidden');
  document.getElementById('ws-grid-overlay').onclick = e => { if (e.target.id === 'ws-grid-overlay') document.getElementById('ws-grid-overlay').classList.add('hidden'); };
  document.getElementById('wsg-add').onclick = () => { document.getElementById('ws-grid-overlay').classList.add('hidden'); openModal('new-ws'); };
  document.getElementById('add-ws-btn').onclick = () => openModal('new-ws');
  document.getElementById('sidebar-toggle').onclick = () => { State.get().settings.sidebarCollapsed = !State.get().settings.sidebarCollapsed; applySettings(); State.persist(); };
  document.getElementById('add-cat-btn').onclick = () => openModal('new-cat');

  const _debouncedApplyFilter = debounce(applyFilter, 80);
  document.getElementById('tab-filter').oninput = _debouncedApplyFilter;
  document.getElementById('tab-filter').onkeydown = e => { if (e.key === 'Escape') { e.target.value = ''; applyFilter(); e.target.blur(); } };

  document.getElementById('theme-btn').onclick = () => {
    const cycle = ['dark','light','dracula','nord','rose-pine','tokyo-night','solarized-dark','solarized-light','gruvbox','catppuccin','sepia','mono'];
    const i = cycle.indexOf(State.get().settings.theme);
    State.get().settings.theme = cycle[(i + 1) % cycle.length];
    applySettings();
    State.persist();
    const t = THEMES.find(x => x.id === State.get().settings.theme);
    toast(`Theme: ${t?.label || State.get().settings.theme}`);
  };
  document.getElementById('save-session-btn').onclick = saveAllTabs;
  const _drawer = document.getElementById('settings-drawer');
  const _openDrawer = () => { rememberOpener(_drawer); _drawer.classList.remove('hidden'); renderArchiveList(); setTimeout(() => focusFirstIn(_drawer), 50); };
  const _closeDrawer = () => { _drawer.classList.add('hidden'); restoreOpener(_drawer); };
  document.getElementById('settings-btn').onclick = _openDrawer;
  document.getElementById('drawer-x').onclick = _closeDrawer;
  _drawer.onclick = e => { if (e.target.id === 'settings-drawer') _closeDrawer(); };
  _drawer.addEventListener('keydown', e => trapTabKey(e, _drawer));
  document.getElementById('modal-overlay').addEventListener('keydown', e => trapTabKey(e, document.getElementById('modal-overlay')));
  document.getElementById('search-btn').onclick = () => toggleSearchBar();
  document.getElementById('undo-btn').onclick = performUndo;

  document.getElementById('search-input').oninput = debounce(applySearchFilter, 90);
  document.getElementById('search-input').onkeydown = e => { if (e.key === 'Escape') toggleSearchBar(false); };

  // Modal
  document.getElementById('modal-x').onclick = closeModal;
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-ok').onclick = confirmModal;
  document.getElementById('modal-overlay').onclick = e => { if (e.target.id === 'modal-overlay') closeModal(); };
  document.getElementById('modal-input').onkeydown = e => { if (e.key === 'Enter') confirmModal(); if (e.key === 'Escape') closeModal(); };
  document.getElementById('intent-x').onclick = closeIntentEditor;
  document.getElementById('intent-cancel').onclick = closeIntentEditor;
  document.getElementById('intent-save').onclick = saveIntentEditor;
  document.getElementById('intent-clear').onclick = clearIntentEditor;
  document.getElementById('intent-overlay').onclick = e => { if (e.target.id === 'intent-overlay') closeIntentEditor(); };
  document.getElementById('emoji-trigger').onclick = e => { e.stopPropagation(); openEmojiPicker({ kind:'modal' }, e.currentTarget); };
  document.querySelectorAll('.csw').forEach(c => {
    c.onclick = () => { document.querySelectorAll('.csw').forEach(x => x.classList.remove('active')); c.classList.add('active'); };
    c.setAttribute('aria-label', 'Color ' + (c.dataset.c || ''));
    enableKeyboardClick(c);
  });

  // Emoji picker search
  document.getElementById('ep-search-input').oninput = e => renderEmojiGrid(null, e.target.value);

  // Drawer tabs
  document.querySelectorAll('.dt').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.dt').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      ['appearance','behavior','archive','data'].forEach(t => {
        document.getElementById('dp-' + t).classList.toggle('hidden', t !== b.dataset.tab);
      });
      if (b.dataset.tab === 'archive') renderArchiveList();
      if (b.dataset.tab === 'data') refreshStorageUsage();
    };
  });

  // Settings controls
  document.querySelectorAll('#seg-size button').forEach(b => b.onclick = () => { State.get().settings.size = b.dataset.val; applySettings(); State.persist(); });
  document.querySelectorAll('#seg-width button').forEach(b => b.onclick = () => { State.get().settings.width = b.dataset.val; applySettings(); State.persist(); });
  document.querySelectorAll('#seg-font button').forEach(b => b.onclick = () => { State.get().settings.font = b.dataset.val; applySettings(); State.persist(); });
  document.getElementById('tog-close').onchange = e => { State.get().settings.closeTabOnSave = e.target.checked; State.persist(); };
  document.getElementById('tog-hibernate').onchange = e => { State.get().settings.hibernate = e.target.checked; State.persist(); };
  document.getElementById('tog-urls').onchange = e => { State.get().settings.showUrls = e.target.checked; applySettings(); State.persist(); };
  document.getElementById('tog-anim').onchange = e => { State.get().settings.animate = e.target.checked; applySettings(); State.persist(); };
  document.getElementById('tog-confirm').onchange = e => { State.get().settings.confirmDelete = e.target.checked; State.persist(); };
  document.getElementById('tog-blur').onchange = e => { State.get().settings.blurPrivacy = e.target.checked; applySettings(); State.persist(); };
  document.getElementById('tog-autoswitch').onchange = e => { State.get().settings.autoSwitchWorkspace = e.target.checked; State.persist(); renderHeader(); };

  document.getElementById('export-btn').onclick = exportJSON;
  document.getElementById('import-file').onchange = e => { if (e.target.files[0]) importJSON(e.target.files[0]); };
  document.getElementById('bookmarks-btn').onclick = importBookmarks;

  // Global keys
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const editable = document.activeElement?.isContentEditable;
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || editable;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !inField) { e.preventDefault(); toggleSearchBar(); }
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); performUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); performRedo(); }
    else if (e.key === 's' && !inField) { e.preventDefault(); document.getElementById('tab-filter').focus(); }
    else if (e.key === '?' && !inField && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openCheatsheet(); }
    else if (e.key === 'Escape') {
      toggleSearchBar(false);
      closeModal();
      const _d = document.getElementById('settings-drawer');
      if (!_d.classList.contains('hidden')) { _d.classList.add('hidden'); restoreOpener(_d); }
      document.getElementById('ws-grid-overlay').classList.add('hidden');
      document.getElementById('ws-list').classList.add('hidden');
      document.getElementById('emoji-picker')?.classList.add('hidden');
      // Tool overlays — route through dedicated close fns so scroll-lock,
      // snapshot, and opener-restore semantics stay correct.
      const _toolCloses = [
        ['pomo-overlay',    closePomo],
        ['fin-overlay',     closeFin],
        ['habit-overlay',   closeHabits],
        ['water-overlay',   closeWater],
        ['books-overlay',   closeBooks],
        ['goals-overlay',   closeGoals],
        ['workout-overlay', closeWorkout],
        ['subs-overlay',    closeSubsTracker],
        ['tools-hub',       closeToolsHub]
      ];
      for (const [id, fn] of _toolCloses) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) { fn(); break; }
      }
      const _imp = document.getElementById('import-overlay');
      if (_imp && !_imp.classList.contains('hidden')) closeImportPreview();
      const _cs = document.getElementById('cheatsheet-overlay');
      if (_cs && !_cs.classList.contains('hidden')) closeCheatsheet();
      const _qf = document.getElementById('quota-overlay');
      if (_qf && !_qf.classList.contains('hidden')) closeStorageFull();
      const tourEl = document.getElementById('tour-overlay');
      if (tourEl && !tourEl.classList.contains('hidden')) endTour(true);
      const focusEl = document.getElementById('group-focus-overlay');
      if (focusEl && !focusEl.classList.contains('hidden')) closeGroupFocus();
      if (selectedTabIds.size) { selectedTabIds.clear(); lastClickedTabId = null; updateSelectedBadge(); renderOpenTabs(); }
      // clearItemSelection() resets the selection, the sticky mode, the body
      // class, and the button — so it covers an empty-but-active select mode too.
      if (itemSelMode || selectedItemIds.size) clearItemSelection();
      if (document.body.classList.contains('reorder-mode')) {
        document.body.classList.remove('reorder-mode');
        document.getElementById('reorder-mode-btn').classList.remove('active');
      }
    }
  });

  bindRtToolbar();
  bindReminderUI();
  bindImportUI();
  bindPasteImportUI();
  bindQuotaOverlay();
  bindCheatsheetOverlay();
  bindBoardArrowNav();
  bindCatScroll();
  bindSubs();
  bindToolsHub();
  bindPomo();
  bindFin();
  bindHabits();
  bindWater();
  bindBooks();
  bindGoals();
  bindWorkout();

  // View modes + selection mode + reorder mode
  document.getElementById('view-mode-btn').onclick = cycleViewMode;
  document.getElementById('select-mode-btn').onclick = toggleSelectMode;
  document.getElementById('reorder-mode-btn').onclick = toggleReorderMode;

  // Apply saved view mode on boot
  setViewMode(getViewMode());

  // Drag auto-scroll
  setupDragAutoScroll();

  // Onboarding tour
  bindTour();
  if (!State.get().settings.tourCompleted) {
    setTimeout(startTour, 600);
  }
  document.getElementById('show-tour-btn').onclick = () => {
    document.getElementById('settings-drawer').classList.add('hidden');
    setTimeout(startTour, 200);
  };

  // Floating tool widgets - pop-out buttons
  ['pomodoro:pomo-popout', 'finance:fin-popout', 'habits:habit-popout', 'water:water-popout', 'goals:goals-popout', 'subs:subs-popout', 'books:books-popout', 'workout:workout-popout']
    .forEach(p => {
      const [tool, btnId] = p.split(':');
      const btn = document.getElementById(btnId);
      if (btn) btn.onclick = () => popOutTool(tool);
    });

  // Restore any floating widgets from previous session
  renderFloatingWidgets();
}

// ════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════
init();
