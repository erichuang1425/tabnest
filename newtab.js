/* ═══════════════════════════════════════════════════════════════
   TabExtend — newtab.js (v3)
   ═══════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════
// STATE + UNDO
// ════════════════════════════════════════════════════════════════
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
  const deepClone = o => JSON.parse(JSON.stringify(o));
  return {
    get: () => state,
    async load() {
      const d = await chrome.storage.local.get('te');
      if (d.te) state = { ...state, ...d.te, settings: { ...state.settings, ...(d.te.settings || {}) } };
    },
    persist() { clearTimeout(persistTimer); persistTimer = setTimeout(() => chrome.storage.local.set({ te: state }), 180); },
    persistNow() { clearTimeout(persistTimer); return chrome.storage.local.set({ te: state }); },
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
const favUrl = u => { try { return `https://www.google.com/s2/favicons?domain=${new URL(u).hostname}&sz=32`; } catch { return ''; } };
const dispUrl = u => { try { const x = new URL(u); return x.hostname + (x.pathname.length > 1 ? x.pathname.slice(0, 40) : ''); } catch { return u; } };
const isProto = u => !u || u.startsWith('chrome') || u.startsWith('edge') || u.startsWith('about') || u.startsWith('view-source');
const BLANK_FAV = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23444'/%3E%3C/svg%3E`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const INTENT_STATUS = ['active', 'paused', 'someday', 'done', 'reference'];
const INTENT_TYPE = ['project', 'study', 'research', 'admin', 'life', 'reference', 'other'];
const TAB_ACTION_VERBS = ['read', 'implement', 'compare', 'debug', 'watch', 'buy', 'cite', 'review', 'delete-after-checking', 'other'];
const TAB_ACTION_LABELS = {
  read: 'Read', implement: 'Implement', compare: 'Compare', debug: 'Debug', watch: 'Watch',
  buy: 'Buy', cite: 'Cite', review: 'Review', 'delete-after-checking': 'Delete after checking', other: 'Other'
};

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
function getFutureNotes(entity, { createIfMissing = false } = {}) {
  if (!entity) return [];
  if (!Array.isArray(entity.futureNotes)) {
    if (!createIfMissing) return [];
    entity.futureNotes = [];
  }
  return entity.futureNotes;
}
function getLatestUnresolvedFutureNote(entity) {
  const notes = getFutureNotes(entity).filter(n => !n.resolvedAt);
  notes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return notes[0] || null;
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
function renderFutureNotePreview(entity) {
  const note = getLatestUnresolvedFutureNote(entity);
  if (!note?.text) return '';
  const t = note.text.trim();
  return `<div class="future-preview">Future me: ${esc(t.slice(0, 110))}${t.length > 110 ? '…' : ''}</div>`;
}
function renderHeartbeat(entity) {
  const hb = computeHeartbeat(entity);
  const chips = [];
  const details = [
    hb.lastUpdatedAt ? `Updated: ${new Date(hb.lastUpdatedAt).toLocaleString()}` : 'Updated: unknown',
    hb.lastOpenedAt ? `Opened: ${new Date(hb.lastOpenedAt).toLocaleString()}` : 'Opened: unknown',
    `Tabs: ${hb.tabCount}`,
    `Open todos: ${hb.unfinishedTodoCount}`,
    `Notes: ${hb.noteCount}`,
    `Future notes: ${hb.unresolvedFutureCount}`,
    hb.hasPurpose ? 'Purpose: yes' : 'Purpose: no',
    hb.hasNextAction ? 'Next action: yes' : 'Next action: no'
  ].join(' • ');

  if (!hb.hasNextAction) chips.push(`<span class="hb-chip warn" title="${esc(details)}">No next action</span>`);
  if (hb.unfinishedTodoCount > 0) chips.push(`<span class="hb-chip todo" title="${esc(details)}">${hb.unfinishedTodoCount} to-do${hb.unfinishedTodoCount > 1 ? 's' : ''}</span>`);
  if (hb.isReference) chips.push(`<span class="hb-chip ref" title="${esc(details)}">Reference</span>`);
  if (hb.isStale) chips.push(`<span class="hb-chip stale" title="${esc(details)}">Stale</span>`);
  else if (hb.isActive) chips.push(`<span class="hb-chip ok" title="${esc(details)}">Active</span>`);
  return chips.length ? `<div class="heartbeat-row">${chips.join('')}</div>` : '';
}
function computeHeartbeat(entity) {
  const i = entity?.intent || {};
  const staleDays = Number(State.get().settings?.heartbeatStaleDays) || 14;
  const staleMs = 1000 * 60 * 60 * 24 * staleDays;
  const tabCount = (entity?.items || []).filter(x => x.type === 'tab').length;
  const unfinishedTodoCount = (entity?.items || []).filter(x => x.type === 'todo' && !x.done).length;
  const noteCount = (entity?.items || []).filter(x => x.type === 'note').length;
  const unresolvedFutureCount = getFutureNotes(entity).filter(n => !n.resolvedAt).length;
  const lastUpdatedAt = i.updatedAt || null;
  const lastOpenedAt = entity?.lastOpenedAt || null;
  const lastTouch = Math.max(lastUpdatedAt || 0, lastOpenedAt || 0);
  const isStale = !!(lastTouch && (Date.now() - lastTouch) > staleMs);
  const isActive = !!(lastTouch && !isStale);
  const daysSinceTouch = lastTouch ? Math.floor((Date.now() - lastTouch) / 86400000) : null;
  return {
    lastUpdatedAt,
    lastOpenedAt,
    tabCount,
    unfinishedTodoCount,
    noteCount,
    hasPurpose: !!(i.purpose || '').trim(),
    hasNextAction: !!(i.nextAction || '').trim(),
    unresolvedFutureCount,
    staleDays,
    daysSinceTouch,
    isStale,
    isActive,
    isReference: (i.status || '') === 'reference' || (i.type || '') === 'reference'
  };
}

function collectTriageCandidates() {
  const out = [];
  for (const ws of State.get().workspaces) for (const cat of ws.categories) for (const g of cat.groups) {
    for (const it of g.items || []) collectTriageItem(out, it, { ws, cat, group: g, stack: null });
  }
  return out;
}
function collectTriageItem(out, it, ctx) {
  if (it.type === 'tab') out.push({ item: it, ctx });
  if (it.type === 'stack' && Array.isArray(it.items)) {
    for (const sub of it.items) collectTriageItem(out, sub, { ...ctx, stack: it });
  }
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
  migrate();
  ensureDefault();

  applySettings();
  buildThemeGrid();
  buildEmojiPicker();
  bindStatic();

  renderAll();

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
}

function migrate() {
  const s = State.get();
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

function ensureDefault() {
  const s = State.get();
  if (!s.workspaces.length) {
    const cat = { id: uid(), name:'Quicklinks', groups:[] };
    const cat2 = { id: uid(), name:'Read later', groups:[] };
    cat.groups.push({
      id: uid(), name:'Getting started', symbol:'✨', color:'#6366f1', collapsed:false,
      items: [
        { id: uid(), type:'note', html:'👋 <b>Welcome to TabExtend!</b><br><br>Drag tabs from the left sidebar into any group.<br>Select text for the rich-text toolbar.<br>Right-click anywhere for more options.' },
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
function buildEmojiPicker() {
  const tabs = document.getElementById('ep-tabs');
  if (!tabs) return;
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
  renderEmojiGrid('smileys');
  setTimeout(() => {
    const close = e => { if (!ep.contains(e.target)) { ep.classList.add('hidden'); document.removeEventListener('click', close); emojiPickerCtx = null; } };
    document.addEventListener('click', close);
  }, 50);
  setTimeout(() => document.getElementById('ep-search-input').focus(), 80);
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
function showContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  items.forEach(it => {
    if (it.sep) menu.appendChild(Object.assign(document.createElement('div'), { className: 'cm-sep' }));
    else if (it.label) { const l = document.createElement('div'); l.className = 'cm-label'; l.textContent = it.label; menu.appendChild(l); }
    else {
      const el = document.createElement('div');
      el.className = 'cm-item' + (it.danger ? ' danger' : '');
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
  setTimeout(() => {
    const close = e => { if (!menu.contains(e.target)) { hideContextMenu(); document.removeEventListener('click', close); document.removeEventListener('contextmenu', close); } };
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
function openResumePanel(targetKind, targetId) {
  const entity = getEntityTarget(targetKind, targetId);
  if (!entity) return;
  entity.lastOpenedAt = Date.now();
  State.persist();
  const i = entity.intent || {};
  const futureNote = getLatestUnresolvedFutureNote(entity);
  const tabs = [];
  const collectTabs = (list) => (list || []).forEach(x => { if (x.type === 'tab') tabs.push(x); else if (x.type === 'stack') collectTabs(x.items); });
  collectTabs(entity.items || []);
  const todos = (entity.items || []).filter(x => x.type === 'todo' && !x.done).slice(0, 5);
  const keyTabs = tabs.slice(0, 3);
  document.getElementById('resume-title').textContent = `Resume · ${entity.name || 'Stack'}`;
  const body = document.getElementById('resume-body');
  body.innerHTML = `
    <div class="resume-section">${renderIntentPills(entity) || '<div>No intention yet.</div>'}</div>
    <div class="resume-section">${i.purpose ? `<div><strong>Purpose:</strong> ${esc(i.purpose)}</div>` : ''}${i.nextAction ? `<div><strong>Next action:</strong> ${esc(i.nextAction)}</div>` : '<div><strong>Next action:</strong> none</div>'}</div>
    <div class="resume-section">${futureNote ? `<strong>Future me:</strong> ${esc(futureNote.text)}` : 'No unresolved Future Me note.'}</div>
    <div class="resume-section"><strong>Unfinished todos:</strong>${todos.length ? todos.map(t => `<div>• ${esc(t.text || '(untitled)')}</div>`).join('') : '<div> none</div>'}</div>
    <div class="resume-section"><strong>Key tabs:</strong>${keyTabs.length ? keyTabs.map(t => `<div>• ${esc(t.title || dispUrl(t.url))}</div>`).join('') : '<div> none</div>'}</div>
    <div class="resume-actions">
      <button data-ract="open-key">Open key tabs</button><button data-ract="open-all">Open all tabs</button><button data-ract="pomo">Start Pomodoro</button><button data-ract="future">Add Future Me note</button><button data-ract="intent">Edit intention</button><button data-ract="clear-next">Clear next action</button>
    </div>`;
  body.querySelectorAll('[data-ract]').forEach(btn => btn.onclick = () => {
    const act = btn.dataset.ract;
    if (act === 'open-key') openAllHibernated(keyTabs.map(t => t.url), keyTabs);
    else if (act === 'open-all') openAllHibernated(tabs.map(t => t.url), tabs);
    else if (act === 'pomo') { openPomo(); if (i.nextAction) { getPomo().currentTask = i.nextAction; State.persist(); renderPomo(); } }
    else if (act === 'future') openFutureEditor(targetKind, targetId);
    else if (act === 'intent') openIntentEditor(targetKind, targetId);
    else if (act === 'clear-next') { State.snapshot('Clear next action'); if (entity.intent) entity.intent.nextAction = ''; State.persist(); renderBoard(); openResumePanel(targetKind, targetId); }
  });
  document.getElementById('resume-overlay').classList.remove('hidden');
}
function closeResumePanel() { document.getElementById('resume-overlay').classList.add('hidden'); }

function collectContinuationTargets() {
  const out = [];
  for (const ws of State.get().workspaces || []) {
    for (const cat of ws.categories || []) {
      for (const group of cat.groups || []) {
        out.push({ kind: 'group', entity: group, wsId: ws.id, wsName: ws.name });
        for (const it of group.items || []) {
          if (it.type === 'stack') out.push({ kind: 'stack', entity: it, wsId: ws.id, wsName: ws.name });
        }
      }
    }
  }
  return out;
}
function getNextActionSuggestions() {
  const suggestions = [];
  const usedTargetIds = new Set();
  const activeWsId = State.get().activeWsId;
  const targets = collectContinuationTargets();
  const inActive = targets.filter(t => t.wsId === activeWsId);
  const isInboxGroup = t => t.kind === 'group' && (t.entity.name || '').trim().toLowerCase() === 'inbox';
  const pushSuggestion = (target, s) => {
    if (!s || suggestions.length >= 3) return;
    if (target) {
      if (usedTargetIds.has(target.entity.id)) return;
      usedTargetIds.add(target.entity.id);
    }
    suggestions.push(s);
  };

  const actNext = inActive.find(t => {
    const i = t.entity.intent || {};
    return (i.status || 'active') === 'active' && !!(i.nextAction || '').trim();
  });
  if (actNext) pushSuggestion(actNext, {
    title: `Resume ${actNext.entity.name || 'this project'}`,
    reason: 'It has an active next action, so you can continue without context switching.',
    actionLabel: 'Resume',
    onAction: () => { closeWhatNowPanel(); openResumePanel(actNext.kind, actNext.entity.id); }
  });

  const unresolved = inActive.find(t => !usedTargetIds.has(t.entity.id) && !!getLatestUnresolvedFutureNote(t.entity));
  if (unresolved) pushSuggestion(unresolved, {
    title: `Review note for ${unresolved.entity.name || 'this project'}`,
    reason: 'There is an unresolved Future Me note waiting for you.',
    actionLabel: 'Resume',
    onAction: () => { closeWhatNowPanel(); openResumePanel(unresolved.kind, unresolved.entity.id); }
  });

  const todoTarget = inActive.find(t => !usedTargetIds.has(t.entity.id) && (t.entity.items || []).some(x => x.type === 'todo' && !x.done));
  if (todoTarget) pushSuggestion(todoTarget, {
    title: `Finish a to-do in ${todoTarget.entity.name || 'this project'}`,
    reason: 'You already have unfinished to-dos in your current workspace.',
    actionLabel: 'Resume',
    onAction: () => { closeWhatNowPanel(); openResumePanel(todoTarget.kind, todoTarget.entity.id); }
  });

  const staleTarget = inActive.find(t => {
    if (usedTargetIds.has(t.entity.id)) return false;
    const hb = computeHeartbeat(t.entity);
    return hb.isStale && !hb.isReference && ((t.entity.intent || {}).status || 'active') === 'active';
  });
  if (staleTarget) {
    const days = computeHeartbeat(staleTarget.entity).daysSinceTouch;
    pushSuggestion(staleTarget, {
      title: `Refresh ${staleTarget.entity.name || 'this project'}`,
      reason: days != null ? `It has been quiet for ${days} day${days === 1 ? '' : 's'}.` : 'It has been quiet for a while.',
      actionLabel: 'Edit intention',
      onAction: () => { closeWhatNowPanel(); openIntentEditor(staleTarget.kind, staleTarget.entity.id); }
    });
  }

  const inboxTarget = inActive.find(t => isInboxGroup(t) && (t.entity.items || []).some(x => x.type === 'tab'));
  if (inboxTarget) pushSuggestion(null, {
    title: 'Clean inbox tabs',
    reason: 'Your Inbox has saved tabs that still need sorting.',
    actionLabel: 'Start triage',
    onAction: () => { closeWhatNowPanel(); openTriage(); }
  });

  if (pomoState.running) pushSuggestion(null, {
    title: 'Continue focus session',
    reason: getPomo().currentTask ? `Current task: ${getPomo().currentTask}` : 'A Pomodoro session is already running.',
    actionLabel: 'Open Pomodoro',
    onAction: () => { closeWhatNowPanel(); openPomo(); }
  });

  return suggestions.slice(0, 3);
}
function openWhatNowPanel() {
  const list = getNextActionSuggestions();
  const body = document.getElementById('what-now-body');
  if (!list.length) {
    body.innerHTML = `<div class="what-now-empty">Nothing urgent found.<br>Add a next action to any group or stack to make this smarter.</div>`;
  } else {
    body.innerHTML = `<div class="what-now-list">${list.map((s, i) => `
      <div class="what-now-item">
        <h3>${esc(s.title)}</h3>
        <div class="what-now-reason">${esc(s.reason)}</div>
        <button class="what-now-act" data-idx="${i}">${esc(s.actionLabel)}</button>
      </div>`).join('')}</div>`;
    body.querySelectorAll('.what-now-act').forEach(btn => {
      btn.onclick = () => {
        const s = list[Number(btn.dataset.idx)];
        if (s?.onAction) s.onAction();
      };
    });
  }
  document.getElementById('what-now-overlay').classList.remove('hidden');
}
function closeWhatNowPanel() { document.getElementById('what-now-overlay').classList.add('hidden'); }

let triageQueue = [];
let triageIndex = 0;
function openTriage() {
  triageQueue = collectTriageCandidates();
  triageIndex = 0;
  renderTriage();
  document.getElementById('triage-overlay').classList.remove('hidden');
}
function closeTriage() { document.getElementById('triage-overlay').classList.add('hidden'); }
function currentTriage() { return triageQueue[triageIndex] || null; }
function renderTriage() {
  const body = document.getElementById('triage-body');
  const title = document.getElementById('triage-title');
  const cur = currentTriage();
  if (!cur) {
    title.textContent = 'Tab Triage';
    body.innerHTML = '<div class="triage-empty">All done. No saved tabs left to triage.</div>';
    return;
  }
  const { item, ctx } = cur;
  const loc = `${ctx.group?.name || 'Group'}${ctx.stack ? ` · ${ctx.stack.name || 'Stack'}` : ''}`;
  const verb = item.actionVerb ? `${TAB_ACTION_LABELS[item.actionVerb] || item.actionVerb}${item.actionText ? `: ${item.actionText}` : ''}` : 'None';
  title.textContent = `Tab Triage · ${triageIndex + 1}/${triageQueue.length}`;
  body.innerHTML = `<div class="triage-item"><img class="triage-fav" src="${esc(item.fav || favUrl(item.url) || BLANK_FAV)}" onerror="this.src='${BLANK_FAV}'"><div><div class="triage-title">${esc(item.title || dispUrl(item.url) || 'Untitled')}</div><div class="triage-meta">${esc(dispUrl(item.url) || item.url || '')}</div><div class="triage-meta">Location: ${esc(loc)}</div><div class="triage-meta">Action verb: ${esc(verb)}</div></div></div>`;
}
function triageAdvance() { triageIndex++; renderTriage(); renderBoard(); }

// ════════════════════════════════════════════════════════════════
// MODAL (group create/edit)
// ════════════════════════════════════════════════════════════════
let modalCtx = null;
let intentEditorCtx = null;
let futureEditorCtx = null;
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

  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => $inp.focus(), 50);
}
function selColor(c) {
  document.querySelectorAll('.csw').forEach(x => x.classList.toggle('active', x.dataset.c === c));
}
function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); modalCtx = null; }
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
function getEntityTarget(kind, id) {
  if (kind === 'group') return findGroup(id)?.group || null;
  if (kind === 'stack') {
    const info = findItem(id);
    return info?.item?.type === 'stack' ? info.item : null;
  }
  return null;
}
function openFutureEditor(targetKind, targetId) {
  const entity = getEntityTarget(targetKind, targetId);
  if (!entity) return;
  futureEditorCtx = { targetKind, targetId };
  document.getElementById('future-title').textContent = `Future Me · ${entity.name || 'Stack'}`;
  document.getElementById('future-input').value = '';
  renderFutureList(entity);
  document.getElementById('future-overlay').classList.remove('hidden');
}
function closeFutureEditor() { document.getElementById('future-overlay').classList.add('hidden'); futureEditorCtx = null; }
function renderFutureList(entity) {
  const box = document.getElementById('future-list');
  const notes = [...getFutureNotes(entity)].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8);
  box.innerHTML = notes.length ? '' : '<div class="future-row">No notes yet.</div>';
  notes.forEach(n => {
    const row = document.createElement('div');
    row.className = 'future-row';
    row.innerHTML = `<div>${esc(n.text || '')}</div><div class="future-meta"><span>${new Date(n.createdAt || Date.now()).toLocaleString()}</span><span>${n.resolvedAt ? 'Resolved' : 'Open'}</span></div><div class="future-acts"></div>`;
    const acts = row.querySelector('.future-acts');
    if (!n.resolvedAt) {
      const done = document.createElement('button');
      done.className = 'btn-secondary';
      done.textContent = 'Resolve';
      done.onclick = () => {
        State.snapshot('Resolve future note');
        n.resolvedAt = Date.now();
        State.persist();
        renderFutureList(entity);
        renderBoard();
        toast('Future note resolved', { undo: true });
      };
      acts.appendChild(done);
    }
    const del = document.createElement('button');
    del.className = 'btn-secondary';
    del.textContent = 'Delete';
    del.onclick = () => { State.snapshot('Delete future note'); entity.futureNotes = getFutureNotes(entity).filter(x => x.id !== n.id); State.persist(); renderFutureList(entity); renderBoard(); toast('Future note deleted', { undo: true }); };
    acts.appendChild(del);
    box.appendChild(row);
  });
}
function saveFutureEditor() {
  const entity = futureEditorCtx ? getEntityTarget(futureEditorCtx.targetKind, futureEditorCtx.targetId) : null;
  if (!entity) return closeFutureEditor();
  const text = document.getElementById('future-input').value.trim();
  if (!text) return toast('Write a note first', { danger: true });
  State.snapshot('Add future note');
  getFutureNotes(entity, { createIfMissing: true }).push({ id: uid(), text, createdAt: Date.now() });
  State.persist();
  renderFutureList(entity);
  renderBoard();
  document.getElementById('future-input').value = '';
  toast('Future note added');
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
  $el.innerHTML = '';

  // Clean stale selections
  const validIds = new Set(allOpenTabs.map(t => t.id));
  for (const id of [...selectedTabIds]) if (!validIds.has(id)) selectedTabIds.delete(id);

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
      <img src="${esc(fav)}" alt="" onerror="this.src='${BLANK_FAV}'">
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
        else if (act === 'clear') { selectedTabIds.clear(); updateSelectedBadge(); renderOpenTabs(); }
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
  document.querySelectorAll('#open-tabs .otab').forEach(el => {
    const t = allOpenTabs.find(x => x.id == el.dataset.tid);
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

function renderCategoryTabs() {
  const ws = activeWs(); if (!ws) return;
  const $c = document.getElementById('cat-tabs');
  $c.innerHTML = '';
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
    $c.appendChild(b);
  });
}

function renderBoard() {
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
    <div class="gcol-hd">
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
        ${renderHeartbeat(g)}
        ${renderFutureNotePreview(g)}
      </div>
      <div class="gcol-acts">
        <button class="gcol-btn" data-act="intent" title="Edit intention">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.5a3.6 3.6 0 013.6 3.6c0 2.2-1.5 3.2-3.1 3.8l-.2.1v1.5M6 10.8h.01" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
        </button>
        <button class="gcol-btn" data-act="future" title="Future Me notes">✎</button>
        <button class="gcol-btn" data-act="resume" title="Resume">▶</button>
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
  hd.addEventListener('click', e => {
    if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.gcol-sym-wrap')) return;
    State.snapshot('Toggle collapse');
    g.collapsed = !g.collapsed;
    col.classList.toggle('collapsed');
    State.persist();
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
      { text:'Future Me notes…', icon: cmIcons.edit, action: () => openFutureEditor('group', g.id) },
      { text:'Resume…', icon: cmIcons.open, action: () => openResumePanel('group', g.id) },
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
      else if (act === 'future') openFutureEditor('group', g.id);
      else if (act === 'resume') openResumePanel('group', g.id);
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

  document.addEventListener('mousemove', e => {
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

function renderTabActionPill(it) {
  if (!it || !TAB_ACTION_VERBS.includes(it.actionVerb)) return '';
  const label = TAB_ACTION_LABELS[it.actionVerb] || 'Action';
  const text = (it.actionText || '').trim();
  const short = text ? `${esc(text.slice(0, 56))}${text.length > 56 ? '…' : ''}` : '';
  return `<div class="tab-action-pill" title="${esc(text ? `${label}: ${text}` : label)}">${esc(label)}${short ? `: ${short}` : ''}</div>`;
}

function editTabAction(it) {
  if (!it || it.type !== 'tab') return;
  const options = ['0) Clear action', ...TAB_ACTION_VERBS.map((v, i) => `${i + 1}) ${TAB_ACTION_LABELS[v]}`)].join('\n');
  const seed = TAB_ACTION_VERBS.includes(it.actionVerb) ? String(TAB_ACTION_VERBS.indexOf(it.actionVerb) + 1) : '';
  const pick = prompt(`What do you need to do with this tab?\n\n${options}\n\nChoose a number:`, seed);
  if (pick == null) return;
  const idx = Number(pick.trim());
  if (!Number.isInteger(idx) || idx < 0 || idx > TAB_ACTION_VERBS.length) return toast('Invalid action choice', { danger: true });
  if (idx === 0) {
    State.snapshot('Edit tab action');
    delete it.actionVerb;
    delete it.actionText;
    State.persist();
    renderBoard();
    toast('Tab action cleared');
    return;
  }
  const verb = TAB_ACTION_VERBS[idx - 1];
  const label = TAB_ACTION_LABELS[verb] || 'Action';
  const details = prompt(`Optional details for "${label}" (leave blank for none):`, (it.actionText || '').trim());
  if (details == null) return;
  State.snapshot('Edit tab action');
  it.actionVerb = verb;
  const clean = details.trim();
  if (clean) it.actionText = clean;
  else delete it.actionText;
  State.persist();
  renderBoard();
  toast('Tab action saved');
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
  itemSelMode = true;
  document.body.classList.add('item-sel-mode');
  renderBoard();
  renderItemSelToolbar();
}

function buildTab(it, parentItems, group) {
  const el = document.createElement('div');
  el.className = 'item tab';
  el.dataset.id = it.id;
  if (it.color) el.dataset.color = it.color;
  el.draggable = true;

  const fav = it.fav || favUrl(it.url);
  el.innerHTML = `
    ${renderReminderBadge(it)}
    <div class="item-top">
      <img class="item-fav" src="${esc(fav)}" alt="" onerror="this.src='${BLANK_FAV}'">
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
    <div class="item-url">${esc(dispUrl(it.url))}</div>
    ${renderTabActionPill(it)}`;

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
      { text:'Edit action…', icon: cmIcons.edit, action: () => editTabAction(it) },
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
      <button class="stack-intent-btn" data-act="future" title="Future Me">✎</button>
      <button class="stack-intent-btn" data-act="resume" title="Resume">▶</button>
    </div>
    ${renderIntentPills(it)}
    ${renderHeartbeat(it)}
    ${renderFutureNotePreview(it)}
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
      { text:'Future Me notes…', icon: cmIcons.edit, action: () => openFutureEditor('stack', it.id) },
      { text:'Resume…', icon: cmIcons.open, action: () => openResumePanel('stack', it.id) },
      { text: it.expanded ? 'Collapse' : 'Expand', icon: cmIcons.edit, action: () => { State.snapshot('Toggle'); it.expanded = !it.expanded; State.persist(); renderBoard(); } },
      { sep: true },
      ...commonActs(it)
    ]);
  });
  el.querySelector('.stack-sym').addEventListener('click', e => { e.stopPropagation(); openEmojiPicker({ kind:'stack', id: it.id }, e.currentTarget); });
  el.querySelector('.stack-intent-btn').addEventListener('click', e => { e.stopPropagation(); openIntentEditor('stack', it.id); });
  el.querySelector('[data-act="future"]').addEventListener('click', e => { e.stopPropagation(); openFutureEditor('stack', it.id); });
  el.querySelector('[data-act="resume"]').addEventListener('click', e => { e.stopPropagation(); openResumePanel('stack', it.id); });
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
let itemSelMode = false;
let lastSelectedItemId = null;
function toggleItemSelect(itemId) {
  if (selectedItemIds.has(itemId)) selectedItemIds.delete(itemId);
  else selectedItemIds.add(itemId);
  lastSelectedItemId = itemId;
  itemSelMode = selectedItemIds.size > 0;
  document.body.classList.toggle('item-sel-mode', itemSelMode);
  renderBoard();
  renderItemSelToolbar();
}
function clearItemSelection() {
  selectedItemIds.clear();
  itemSelMode = false;
  document.body.classList.remove('item-sel-mode');
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
  // Show a context-menu-style list of all groups as targets
  const moveIds = (infos || []).map(i => i?.item?.id).filter(Boolean);
  if (!moveIds.length) return;
  const items = [{ label: 'MOVE TO…' }];
  State.get().workspaces.forEach(ws => {
    ws.categories.forEach(cat => {
      cat.groups.forEach(g => {
        items.push({
          text: `${ws.symbol || '🏠'} ${ws.name} / ${cat.name} / ${g.name}`,
          icon: cmIcons.folder || cmIcons.open,
          action: () => {
            State.snapshot(`Move ${moveIds.length} items`);
            // Walk and remove maintaining order
            const moved = [];
            const idSet = new Set(moveIds);
            const orderedIds = [];
            const walk = (list) => { for (const it of list) { if (idSet.has(it.id)) orderedIds.push(it.id); if (it.type === 'stack' && it.items) walk(it.items); } };
            State.get().workspaces.forEach(w => w.categories.forEach(c => c.groups.forEach(gr => walk(gr.items))));
            for (let i = orderedIds.length - 1; i >= 0; i--) {
              const info = findItem(orderedIds[i]);
              if (info) moved.unshift(...info.parent.splice(info.index, 1));
            }
            g.items.push(...moved);
            State.persist();
            clearItemSelection();
            renderBoard();
            toast(`Moved ${moved.length} items`, { undo: true });
          }
        });
      });
    });
  });
  // Position at toolbar
  const bar = document.getElementById('item-sel-toolbar');
  const r = bar ? bar.getBoundingClientRect() : { left: window.innerWidth/2 - 100, top: window.innerHeight/2 };
  showContextMenu(r.left, r.top - 300, items);
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
  document.addEventListener('mouseup', () => setTimeout(maybeShowRtToolbar, 10));
  document.addEventListener('keyup', () => setTimeout(maybeShowRtToolbar, 10));
}

// ════════════════════════════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════════════════════════════
function applySearchFilter() {
  const q = document.getElementById('search-input').value.toLowerCase().trim();
  // Support exact match with quotes
  const isExact = /^".+"$/.test(q);
  const needle = isExact ? q.slice(1, -1) : q;
  document.querySelectorAll('.item').forEach(el => {
    if (!q) { el.classList.remove('hidden'); return; }
    const text = el.textContent.toLowerCase();
    const match = isExact ? text.includes(needle) : needle.split(/\s+/).every(w => text.includes(w));
    el.classList.toggle('hidden', !match);
  });
  document.querySelectorAll('.gcol').forEach(col => {
    const any = col.querySelectorAll('.item:not(.hidden)').length > 0;
    col.style.display = (!q || any) ? '' : 'none';
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
          return `<img src="${esc(f)}" onerror="this.style.visibility='hidden'">`;
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
  let imported = 0;
  function walk(nodes, folderName) {
    const g = { id: uid(), name: folderName || 'Bookmarks', symbol:'🔖', color:'#eab308', collapsed:false, items:[] };
    let has = false;
    for (const n of nodes) {
      if (n.url && !isProto(n.url)) { g.items.push({ id: uid(), type:'tab', title:n.title||n.url, url:n.url, fav:'' }); has = true; imported++; }
      else if (n.children) walk(n.children, n.title);
    }
    if (has) cat.groups.push(g);
  }
  tree.forEach(r => (r.children || []).forEach(c => walk(c.children || [], c.title)));
  State.persist(); renderBoard();
  toast(`Imported ${imported}`, { undo: true });
}
function exportJSON() {
  const blob = new Blob([JSON.stringify(State.get(), null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tabextend-${new Date().toISOString().slice(0,10)}.json`; a.click();
  URL.revokeObjectURL(url);
  toast('Exported');
}
function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d.workspaces) throw new Error('Invalid');
      if (confirm('Replace all current data with imported?')) {
        State.snapshot('Import');
        Object.assign(State.get(), d);
        migrate();
        State.persist();
        applySettings();
        renderAll();
        toast('Imported');
      }
    } catch { toast('Invalid file', { danger: true }); }
  };
  r.readAsText(file);
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
  document.getElementById('subs-overlay').classList.remove('hidden');
  renderSubs();
}
function closeSubsTracker() {
  document.getElementById('subs-overlay').classList.add('hidden');
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
  goals:    { title: 'Goals',    icon: '🎯' }
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
    goals:    'goals-overlay'
  };
  const ovId = overlayMap[toolKey];
  if (ovId) document.getElementById(ovId)?.classList.add('hidden');
  document.body.style.overflow = '';
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
  layer.innerHTML = '';
  const f = getFloating();
  f.forEach(w => layer.appendChild(buildFloatingWidget(w)));
}

function buildFloatingWidget(w) {
  const meta = FLOATING_TOOLS[w.tool] || { title: w.tool, icon: '⚡' };
  const el = document.createElement('div');
  el.className = 'fw-window' + (w.minimized ? ' minimized' : '');
  el.style.left = w.x + 'px';
  el.style.top = w.y + 'px';
  if (!w.minimized) {
    el.style.width = w.w + 'px';
    el.style.height = w.h + 'px';
  }

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
        renderFloatingWidgets();
      } else if (a === 'open') {
        // Open the full tool overlay AND remove from floating
        closeFloating(w.tool);
        if (w.tool === 'pomodoro') openPomo();
        else if (w.tool === 'finance') openFin();
        else if (w.tool === 'habits') openHabits();
        else if (w.tool === 'water') openWater();
        else if (w.tool === 'goals') openGoals();
      }
    };
  });

  // Drag the title bar
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
  });
  const onMove = (e) => {
    if (!dragging) return;
    w.x = Math.max(0, Math.min(window.innerWidth - 60, startLeft + (e.clientX - startX)));
    w.y = Math.max(0, Math.min(window.innerHeight - 30, startTop + (e.clientY - startY)));
    el.style.left = w.x + 'px';
    el.style.top = w.y + 'px';
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('fw-dragging');
    State.persist();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

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
    });
    const onResMove = (e) => {
      if (!resizing) return;
      w.w = Math.max(220, rsw + (e.clientX - rsx));
      w.h = Math.max(120, rsh + (e.clientY - rsy));
      el.style.width = w.w + 'px';
      el.style.height = w.h + 'px';
    };
    const onResUp = () => {
      if (!resizing) return;
      resizing = false;
      State.persist();
      renderFloatingBody(w.tool, body);
    };
    document.addEventListener('mousemove', onResMove);
    document.addEventListener('mouseup', onResUp);
  }

  // Bring to front on click
  el.addEventListener('mousedown', () => {
    el.style.zIndex = 9999;
    document.querySelectorAll('.fw-window').forEach(o => { if (o !== el) o.style.zIndex = 9990; });
  });

  return el;
}

function renderFloatingBody(tool, container) {
  if (tool === 'pomodoro') renderFloatingPomo(container);
  else if (tool === 'finance') renderFloatingFin(container);
  else if (tool === 'habits') renderFloatingHabits(container);
  else if (tool === 'water') renderFloatingWater(container);
  else if (tool === 'goals') renderFloatingGoals(container);
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
  // Update title every second when running
  if (pomoState.running && !c._pomoUpdater) {
    c._pomoUpdater = setInterval(() => {
      if (!document.contains(c)) { clearInterval(c._pomoUpdater); return; }
      renderFloatingBody('pomodoro', c);
    }, 1000);
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
    if (act === 'open-all') openGroupAll(g.id);
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
  itemSelMode = !itemSelMode;
  document.body.classList.toggle('item-sel-mode', itemSelMode);
  if (!itemSelMode) clearItemSelection();
  document.getElementById('select-mode-btn').classList.toggle('active', itemSelMode);
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
  pomoState.mode = 'focus';
  pomoState.remaining = p.settings.focus * 60;
  pomoState.running = false;
  renderPomo();
  syncPomoInputs();
  document.getElementById('pomo-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closePomo() {
  stopPomoTimer();
  document.getElementById('pomo-overlay').classList.add('hidden');
  document.body.style.overflow = '';
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
  document.querySelector('.pomo-ring-fg').style.strokeDashoffset = String(circ * (1 - pct));

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
    document.title = `${m}:${String(s).padStart(2,'0')} · TabExtend`;
  } else {
    document.title = 'New tabExtend';
  }

  renderPomoTasks();
}

function renderPomoTasks() {
  const p = getPomo();
  const $list = document.getElementById('pomo-tasks-list');
  $list.innerHTML = '';
  p.tasks.forEach(t => {
    const el = document.createElement('div');
    el.className = 'pomo-task-item' + (t.done ? ' done' : '');
    el.innerHTML = `
      <div class="pomo-task-check ${t.done ? 'checked':''}"></div>
      <span class="pomo-task-text">${esc(t.text)}</span>
      <button class="pomo-task-del"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>`;
    el.querySelector('.pomo-task-check').onclick = () => {
      t.done = !t.done; State.persist(); renderPomoTasks();
    };
    el.querySelector('.pomo-task-del').onclick = () => {
      const i = p.tasks.indexOf(t); if (i > -1) p.tasks.splice(i, 1);
      State.persist(); renderPomoTasks();
    };
    $list.appendChild(el);
  });
}

function startPomoTimer() {
  if (pomoState.running) return;
  pomoState.running = true;
  pomoTimer = setInterval(() => {
    pomoState.remaining--;
    if (pomoState.remaining <= 0) onPomoFinish();
    renderPomo();
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
let finRange = 'today';

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
  renderFin();
  document.getElementById('fin-overlay').classList.remove('hidden');
}
function closeFin() { document.getElementById('fin-overlay').classList.add('hidden'); }

function finFilteredTxns() {
  const f = getFin();
  const now = new Date();
  let start;
  if (finRange === 'today') {
    start = new Date(now); start.setHours(0,0,0,0);
  } else if (finRange === 'week') {
    start = new Date(now); start.setDate(start.getDate() - 7);
  } else if (finRange === 'month') {
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
  const days = finRange === 'today' ? 1 : finRange === 'week' ? 7 : finRange === 'month' ? new Date().getDate() : Math.max(1, Math.ceil((Date.now() - (f.txns[0] ? new Date(f.txns[f.txns.length-1].date).getTime() : Date.now()))/86400000));
  document.getElementById('fin-avg').textContent = fmt(total / days);
  const top = Object.entries(byCat).sort((a,b) => b[1]-a[1])[0];
  document.getElementById('fin-top').textContent = top ? FIN_CATS.find(c => c.id === top[0])?.icon + ' ' + FIN_CATS.find(c => c.id === top[0])?.label : '—';

  // Categories (ordered by spend)
  const $cats = document.getElementById('fin-cats');
  $cats.innerHTML = '';
  const catEntries = Object.entries(byCat).sort((a,b) => b[1]-a[1]);
  if (!catEntries.length) { $cats.innerHTML = `<div class="fin-empty">No spending recorded in this period.</div>`; }
  else {
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
      $cats.appendChild(row);
    });
  }

  // Transactions
  const $list = document.getElementById('fin-list');
  $list.innerHTML = '';
  if (!txns.length) { $list.innerHTML = `<div class="fin-empty">No transactions. Add one above.</div>`; }
  else {
    txns.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(t => {
      const cat = FIN_CATS.find(c => c.id === t.category) || FIN_CATS[FIN_CATS.length-1];
      const tSym = FIN_CUR_SYM[t.currency] || '$';
      const dec = (t.currency === 'JPY' || t.currency === 'KRW') ? 0 : 2;
      const amtStr = `${tSym}${Number(t.amount).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
      const d = new Date(t.date);
      const dateStr = d.toLocaleDateString('en', { month:'short', day:'numeric' });
      const row = document.createElement('div');
      row.className = 'fin-tx-row';
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
      row.querySelector('.ftx-del').onclick = () => {
        if (!confirm('Delete this transaction?')) return;
        State.snapshot('Delete tx');
        const all = getFin().txns; const i = all.findIndex(x => x.id === t.id);
        if (i > -1) all.splice(i, 1);
        State.persist(); renderFin();
      };
      $list.appendChild(row);
    });
  }

  document.querySelectorAll('.fin-tab').forEach(b => b.classList.toggle('active', b.dataset.range === finRange));
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
  a.href = url; a.download = `tabextend-finance-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
  toast('Exported CSV');
}

function bindFin() {
  document.getElementById('fin-close').onclick = closeFin;
  document.getElementById('fin-overlay').addEventListener('click', e => { if (e.target.id === 'fin-overlay') closeFin(); });
  document.getElementById('fin-q-add').onclick = addFinTxn;
  document.getElementById('fin-q-amt').addEventListener('keydown', e => { if (e.key === 'Enter') addFinTxn(); });
  document.getElementById('fin-q-note').addEventListener('keydown', e => { if (e.key === 'Enter') addFinTxn(); });
  document.querySelectorAll('.fin-tab').forEach(b => b.onclick = () => { finRange = b.dataset.range; renderFin(); });
  document.getElementById('fin-export').onclick = exportFinCSV;
}

// ════════════════════════════════════════════════════════════════
// HABITS
// ════════════════════════════════════════════════════════════════
function getHabits() {
  const s = State.get();
  if (!s.habits) s.habits = [];
  return s.habits;
}

function openHabits() {
  renderHabits();
  document.getElementById('habit-overlay').classList.remove('hidden');
}
function closeHabits() { document.getElementById('habit-overlay').classList.add('hidden'); }

function renderHabits() {
  const habits = getHabits();
  const $list = document.getElementById('habit-list');
  $list.innerHTML = '';
  if (!habits.length) { $list.innerHTML = `<div class="fin-empty">No habits yet. Add one above.</div>`; return; }
  const today = new Date().toISOString().slice(0,10);
  // Build last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0,10));
  }
  habits.forEach(h => {
    const doneSet = new Set(h.dates || []);
    const streak = computeHabitStreak(h);
    const row = document.createElement('div');
    row.className = 'habit-row';
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
    row.querySelector('.hab-toggle').onclick = () => {
      State.snapshot('Habit toggle');
      h.dates = h.dates || [];
      if (doneSet.has(today)) h.dates = h.dates.filter(d => d !== today);
      else h.dates.push(today);
      State.persist(); renderHabits();
    };
    row.querySelector('.hab-del').onclick = () => {
      if (!confirm(`Delete habit "${h.name}"?`)) return;
      State.snapshot('Delete habit');
      const idx = habits.findIndex(x => x.id === h.id);
      if (idx > -1) habits.splice(idx, 1);
      State.persist(); renderHabits();
    };
    $list.appendChild(row);
  });
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
}

// ════════════════════════════════════════════════════════════════
// HYDRATION
// ════════════════════════════════════════════════════════════════
function getWater() {
  const s = State.get();
  if (!s.water) s.water = { goal: 8, days: {}, total: 0 };
  return s.water;
}

function openWater() { renderWater(); document.getElementById('water-overlay').classList.remove('hidden'); }
function closeWater() { document.getElementById('water-overlay').classList.add('hidden'); }

function renderWater() {
  const w = getWater();
  const today = new Date().toISOString().slice(0,10);
  const cnt = w.days[today] || 0;
  document.getElementById('water-val').textContent = `${cnt} / ${w.goal}`;
  const pct = Math.min(1, cnt / w.goal);
  const circ = 2 * Math.PI * 88;
  document.getElementById('water-ring-fg').style.strokeDasharray = String(circ);
  document.getElementById('water-ring-fg').style.strokeDashoffset = String(circ * (1 - pct));

  document.getElementById('water-goal').value = w.goal;
  document.getElementById('water-streak-val').textContent = computeWaterStreak();
  document.getElementById('water-total-val').textContent = w.total || 0;
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
function openBooks() { renderBooks(); document.getElementById('books-overlay').classList.remove('hidden'); }
function closeBooks() { document.getElementById('books-overlay').classList.add('hidden'); }
function renderBooks() {
  const books = getBooks().filter(b => b.status === booksFilter);
  const $list = document.getElementById('books-list');
  $list.innerHTML = '';
  if (!books.length) { $list.innerHTML = `<div class="fin-empty">No books in this shelf yet.</div>`; }
  else {
    books.forEach(b => {
      const row = document.createElement('div');
      row.className = 'book-row';
      row.innerHTML = `
        <div class="bk-info">
          <div class="bk-title">${esc(b.title)}</div>
          <div class="bk-author">${esc(b.author || 'Unknown author')}${b.date ? ' · ' + new Date(b.date).toLocaleDateString('en', { month:'short', year:'numeric' }) : ''}</div>
        </div>
        <div class="bk-actions">
          ${b.status !== 'reading' ? `<button data-act="reading">📖 Reading</button>` : ''}
          ${b.status !== 'finished' ? `<button data-act="finished">✅ Done</button>` : ''}
          ${b.status !== 'want' ? `<button data-act="want">🔖 Wishlist</button>` : ''}
          <button data-act="del" class="danger">Delete</button>
        </div>`;
      row.querySelectorAll('button').forEach(btn => {
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
      $list.appendChild(row);
    });
  }
  document.querySelectorAll('.books-tab').forEach(t => t.classList.toggle('active', t.dataset.st === booksFilter));
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
}

// ════════════════════════════════════════════════════════════════
// GOALS
// ════════════════════════════════════════════════════════════════
function getGoals() {
  const s = State.get();
  if (!s.goals) s.goals = [];
  return s.goals;
}
function openGoals() { renderGoals(); document.getElementById('goals-overlay').classList.remove('hidden'); }
function closeGoals() { document.getElementById('goals-overlay').classList.add('hidden'); }
function renderGoals() {
  const goals = getGoals();
  const $list = document.getElementById('goals-list');
  $list.innerHTML = '';
  if (!goals.length) { $list.innerHTML = `<div class="fin-empty">No goals yet.</div>`; return; }
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
          const all = getGoals(); const i = all.findIndex(x => x.id === g.id);
          if (i > -1) all.splice(i, 1);
        }
        State.persist(); renderGoals();
      };
    });
    $list.appendChild(row);
  });
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
}

// ════════════════════════════════════════════════════════════════
// WORKOUT
// ════════════════════════════════════════════════════════════════
function getWorkouts() {
  const s = State.get();
  if (!s.workouts) s.workouts = [];
  return s.workouts;
}
function openWorkout() { renderWorkout(); document.getElementById('workout-overlay').classList.remove('hidden'); }
function closeWorkout() { document.getElementById('workout-overlay').classList.add('hidden'); }
function renderWorkout() {
  const wos = getWorkouts().slice().sort((a,b) => new Date(b.date) - new Date(a.date));
  // Stats: this week minutes, count, this month
  const now = Date.now();
  const weekMs = 7 * 86400000;
  const monthMs = 30 * 86400000;
  const weekCt = wos.filter(w => now - new Date(w.date).getTime() < weekMs);
  const weekMin = weekCt.reduce((a, w) => a + (Number(w.duration) || 0), 0);
  const monthCt = wos.filter(w => now - new Date(w.date).getTime() < monthMs);
  const streak = computeWorkoutStreak();
  const $stats = document.getElementById('wo-stats');
  $stats.innerHTML = `
    <div class="fin-stat"><div class="fin-stat-lbl">This week</div><div class="fin-stat-val">${weekCt.length}</div></div>
    <div class="fin-stat"><div class="fin-stat-lbl">Minutes</div><div class="fin-stat-val">${weekMin}</div></div>
    <div class="fin-stat"><div class="fin-stat-lbl">Month total</div><div class="fin-stat-val">${monthCt.length}</div></div>
    <div class="fin-stat"><div class="fin-stat-lbl">Streak</div><div class="fin-stat-val">${streak}d</div></div>`;
  const $list = document.getElementById('wo-list');
  $list.innerHTML = '';
  if (!wos.length) { $list.innerHTML = `<div class="fin-empty">No workouts logged yet.</div>`; return; }
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
}

// ════════════════════════════════════════════════════════════════
// ONBOARDING TOUR
// ════════════════════════════════════════════════════════════════
const TOUR_STEPS = [
  {
    target: '#ws-chips-stack',
    title: '👋 Welcome to TabExtend',
    body: 'Your workspace lives here. Each open browser window can become its own workspace — perfect for separating work, study, and personal browsing.'
  },
  {
    target: '#open-tabs',
    title: '📑 Your open tabs',
    body: 'These are the tabs in this window. Click the checkbox to select them, or drag any tab into a group on the right to save it for later.'
  },
  {
    target: '#board',
    title: '🗂️ The workspace',
    body: 'Save tabs into groups. Mix in notes and to-dos. Stack related items together. Right-click anything for more actions.',
    pos: 'left'
  },
  {
    target: '#tools-btn',
    title: '⚡ Productivity tools',
    body: 'Pomodoro timer, finance tracker, habits, hydration, reading log, goals, and more — all built in.'
  },
  {
    target: '#view-mode-btn',
    title: '🔄 Two view modes',
    body: 'Toggle between board (columns) and list view (Notion-style nested rows). Pick whichever fits your brain.'
  },
  {
    target: '#search-btn',
    title: '🔍 You\'re all set',
    body: 'Search anything with Ctrl/⌘+K. Press Esc to close overlays. Right-click for context menus. Have fun!'
  }
];

let tourIndex = 0;

function startTour() {
  tourIndex = 0;
  document.getElementById('tour-overlay').classList.remove('hidden');
  showTourStep();
}
function endTour(skipped) {
  document.getElementById('tour-overlay').classList.add('hidden');
  State.get().settings.tourCompleted = true;
  State.persist();
  if (!skipped) toast('Tour complete!');
}
function showTourStep() {
  const step = TOUR_STEPS[tourIndex];
  if (!step) return endTour(false);

  const target = document.querySelector(step.target);
  const spotlight = document.getElementById('tour-spotlight');
  const bubble = document.getElementById('tour-bubble');

  if (!target) {
    // Skip if target missing
    tourIndex++;
    return showTourStep();
  }

  const r = target.getBoundingClientRect();
  const pad = 6;
  spotlight.style.top = (r.top - pad) + 'px';
  spotlight.style.left = (r.left - pad) + 'px';
  spotlight.style.width = (r.width + pad * 2) + 'px';
  spotlight.style.height = (r.height + pad * 2) + 'px';

  document.getElementById('tour-title').textContent = step.title;
  document.getElementById('tour-body').textContent = step.body;

  // Position bubble - try below, fallback above, fallback right
  const bubbleW = 320, bubbleH = 180;
  let top, left;
  if (step.pos === 'left') {
    left = Math.max(20, r.left - bubbleW - 20);
    top = Math.max(20, r.top + r.height/2 - bubbleH/2);
  } else if (r.bottom + bubbleH + 20 < window.innerHeight) {
    top = r.bottom + 14;
    left = Math.min(window.innerWidth - bubbleW - 20, Math.max(20, r.left + r.width/2 - bubbleW/2));
  } else if (r.top - bubbleH - 14 > 20) {
    top = r.top - bubbleH - 14;
    left = Math.min(window.innerWidth - bubbleW - 20, Math.max(20, r.left + r.width/2 - bubbleW/2));
  } else {
    top = Math.max(20, window.innerHeight/2 - bubbleH/2);
    left = Math.max(20, r.right + 20);
    if (left + bubbleW > window.innerWidth - 20) left = window.innerWidth/2 - bubbleW/2;
  }
  bubble.style.top = top + 'px';
  bubble.style.left = left + 'px';

  // Progress dots
  const $prog = document.getElementById('tour-progress');
  $prog.innerHTML = TOUR_STEPS.map((_, i) => `<div class="tour-dot ${i === tourIndex ? 'active' : ''}"></div>`).join('');

  // Buttons
  document.getElementById('tour-prev').disabled = tourIndex === 0;
  document.getElementById('tour-prev').style.visibility = tourIndex === 0 ? 'hidden' : 'visible';
  document.getElementById('tour-next').textContent = tourIndex === TOUR_STEPS.length - 1 ? 'Done' : 'Next';
}

function bindTour() {
  document.getElementById('tour-skip').onclick = () => endTour(true);
  document.getElementById('tour-prev').onclick = () => { if (tourIndex > 0) { tourIndex--; showTourStep(); } };
  document.getElementById('tour-next').onclick = () => {
    if (tourIndex < TOUR_STEPS.length - 1) { tourIndex++; showTourStep(); }
    else endTour(false);
  };
  // Reposition on resize
  window.addEventListener('resize', () => {
    if (!document.getElementById('tour-overlay').classList.contains('hidden')) showTourStep();
  });
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

  document.getElementById('tab-filter').oninput = applyFilter;
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
  document.getElementById('settings-btn').onclick = () => { document.getElementById('settings-drawer').classList.remove('hidden'); renderArchiveList(); };
  document.getElementById('drawer-x').onclick = () => document.getElementById('settings-drawer').classList.add('hidden');
  document.getElementById('settings-drawer').onclick = e => { if (e.target.id === 'settings-drawer') document.getElementById('settings-drawer').classList.add('hidden'); };
  document.getElementById('search-btn').onclick = () => toggleSearchBar();
  document.getElementById('undo-btn').onclick = performUndo;
  document.getElementById('triage-btn').onclick = openTriage;
  document.getElementById('what-now-btn').onclick = openWhatNowPanel;

  document.getElementById('search-input').oninput = applySearchFilter;
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
  document.getElementById('future-x').onclick = closeFutureEditor;
  document.getElementById('future-cancel').onclick = closeFutureEditor;
  document.getElementById('future-save').onclick = saveFutureEditor;
  document.getElementById('future-overlay').onclick = e => { if (e.target.id === 'future-overlay') closeFutureEditor(); };
  document.getElementById('resume-x').onclick = closeResumePanel;
  document.getElementById('resume-close').onclick = closeResumePanel;
  document.getElementById('resume-overlay').onclick = e => { if (e.target.id === 'resume-overlay') closeResumePanel(); };
  document.getElementById('what-now-x').onclick = closeWhatNowPanel;
  document.getElementById('what-now-close').onclick = closeWhatNowPanel;
  document.getElementById('what-now-overlay').onclick = e => { if (e.target.id === 'what-now-overlay') closeWhatNowPanel(); };
  document.getElementById('triage-x').onclick = closeTriage;
  document.getElementById('triage-overlay').onclick = e => { if (e.target.id === 'triage-overlay') closeTriage(); };
  document.getElementById('triage-skip').onclick = () => triageAdvance();
  document.getElementById('triage-archive').onclick = () => {
    const cur = currentTriage(); if (!cur) return;
    archiveItem(cur.item.id); triageAdvance();
  };
  document.getElementById('triage-reference').onclick = () => {
    const cur = currentTriage(); if (!cur) return;
    State.snapshot('Mark tab as reference');
    cur.item.actionVerb = 'cite';
    if (cur.ctx.group) { const i = ensureIntentMeta(cur.ctx.group); i.status = 'reference'; i.updatedAt = Date.now(); }
    State.persist(); triageAdvance();
  };
  document.getElementById('triage-todo').onclick = () => {
    const cur = currentTriage(); if (!cur) return;
    const info = findItem(cur.item.id); if (!info) { triageAdvance(); return; }
    State.snapshot('Convert tab to todo');
    info.parent.splice(info.index, 1, { id: uid(), type:'todo', text: cur.item.title || dispUrl(cur.item.url), done:false });
    State.persist(); triageAdvance();
  };
  document.getElementById('triage-verb').onclick = () => {
    const cur = currentTriage(); if (!cur) return;
    editTabAction(cur.item); renderTriage();
  };
  document.getElementById('triage-move').onclick = () => {
    const cur = currentTriage(); if (!cur) return;
    const infos = [findItem(cur.item.id)].filter(Boolean);
    if (!infos.length) return;
    openMoveTargetPicker(infos);
    triageAdvance();
  };
  document.getElementById('emoji-trigger').onclick = e => { e.stopPropagation(); openEmojiPicker({ kind:'modal' }, e.currentTarget); };
  document.querySelectorAll('.csw').forEach(c => c.onclick = () => { document.querySelectorAll('.csw').forEach(x => x.classList.remove('active')); c.classList.add('active'); });

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

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) { e.preventDefault(); toggleSearchBar(); }
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); performUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z' && !inField) { e.preventDefault(); performRedo(); }
    else if (e.key === 's' && !inField) { e.preventDefault(); document.getElementById('tab-filter').focus(); }
    else if (e.key === 'Escape') {
      toggleSearchBar(false);
      closeModal();
      document.getElementById('settings-drawer').classList.add('hidden');
      document.getElementById('ws-grid-overlay').classList.add('hidden');
      document.getElementById('ws-list').classList.add('hidden');
      closeTriage();
      const tourEl = document.getElementById('tour-overlay');
      if (tourEl && !tourEl.classList.contains('hidden')) endTour(true);
      const focusEl = document.getElementById('group-focus-overlay');
      if (focusEl && !focusEl.classList.contains('hidden')) closeGroupFocus();
      selectedTabIds.clear(); updateSelectedBadge(); renderOpenTabs();
      if (selectedItemIds.size) clearItemSelection();
      if (document.body.classList.contains('reorder-mode')) {
        document.body.classList.remove('reorder-mode');
        document.getElementById('reorder-mode-btn').classList.remove('active');
      }
      if (itemSelMode) {
        itemSelMode = false;
        document.body.classList.remove('item-sel-mode');
        document.getElementById('select-mode-btn').classList.remove('active');
      }
    }
  });

  bindRtToolbar();
  bindReminderUI();
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
  ['pomodoro:pomo-popout', 'finance:fin-popout', 'habits:habit-popout', 'water:water-popout', 'goals:goals-popout']
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
