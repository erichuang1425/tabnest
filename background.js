/* ═══ TabExtend background.js ═══ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function getState() {
  const d = await chrome.storage.local.get('te');
  return d.te || null;
}
async function setState(s) {
  try {
    await chrome.storage.local.set({ te: s });
  } catch (err) {
    console.error('TabExtend storage write failed:', err);
    if (/quota/i.test(String(err?.message || err))) {
      try {
        chrome.notifications.create('te-storage-quota-' + Date.now(), {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'TabExtend storage full',
          message: 'A background save failed. Open TabExtend to free space.',
          priority: 2
        });
      } catch {}
    }
    // Re-throw so awaiting callers (addToInbox, save-all handler) don't
    // run their success path on a failed write.
    throw err;
  }
}

async function ensureDefault(s) {
  if (!s) {
    s = { workspaces: [], activeWsId: null, archive: [], settings: {} };
  }
  if (!s.workspaces?.length) {
    const cat = { id: uid(), name: 'Quicklinks', groups: [] };
    const inbox = { id: uid(), name: 'Inbox', symbol: '📥', color: '#6366f1', collapsed: false, items: [] };
    cat.groups.push(inbox);
    s.workspaces = [{ id: uid(), name: 'My Workspace', symbol: '🏠', categories: [cat], activeCatId: cat.id }];
    s.activeWsId = s.workspaces[0].id;
  }
  return s;
}

async function addToInbox(item) {
  let s = await getState();
  s = await ensureDefault(s);
  const ws = s.workspaces.find(w => w.id === s.activeWsId) || s.workspaces[0];
  const cat = ws.categories.find(c => c.id === ws.activeCatId) || ws.categories[0];
  let inbox = cat.groups.find(g => g.name === 'Inbox');
  if (!inbox) {
    inbox = { id: uid(), name: 'Inbox', symbol: '📥', color: '#6366f1', collapsed: false, items: [] };
    cat.groups.unshift(inbox);
  }
  if (item.type === 'tab' && inbox.items.find(it => it.type === 'tab' && it.url === item.url)) {
    return false;
  }
  inbox.items.push(item);
  await setState(s);
  return true;
}

function flash(text = '✓', color = '#22c55e') {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1400);
}

// ─── Context Menus ────────────────────────────────────────────────────
// removeAll-then-create is idempotent. Bare create() calls would log
// "duplicate id" errors if onInstalled fires twice (profile sync, certain
// upgrade paths). Also re-registering on onStartup is defense-in-depth for
// rare cases where persisted menu state desyncs from the SW.
const MENU_ITEMS = [
  { id: 'te-save-page',      title: '💾 Save page to TabExtend',  contexts: ['page'] },
  { id: 'te-save-link',      title: '🔗 Save link to TabExtend',  contexts: ['link'] },
  { id: 'te-save-selection', title: '📝 Save selection as note',  contexts: ['selection'] },
  { id: 'te-save-image',     title: '🖼️ Save image',              contexts: ['image'] },
  { id: 'te-sep',            type: 'separator',                   contexts: ['page'] },
  { id: 'te-save-all',       title: '📚 Save all tabs in window', contexts: ['page'] }
];

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENU_ITEMS) chrome.contextMenus.create(m);
  });
}

chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'te-save-page' && tab) {
    const ok = await addToInbox({ id: uid(), type:'tab', title:tab.title||'Untitled', url:tab.url, fav:tab.favIconUrl||'' });
    if (ok) flash();
  } else if (info.menuItemId === 'te-save-link') {
    const ok = await addToInbox({ id: uid(), type:'tab', title: info.selectionText || info.linkUrl, url: info.linkUrl, fav:'' });
    if (ok) flash(); else flash('dup', '#f97316');
  } else if (info.menuItemId === 'te-save-selection') {
    const src = tab?.url ? `\n\n— from ${tab.url}` : '';
    const ok = await addToInbox({ id: uid(), type:'note', html: escapeHtml(info.selectionText) + escapeHtml(src), color:null });
    if (ok) flash(); else flash('dup', '#f97316');
  } else if (info.menuItemId === 'te-save-image') {
    const ok = await addToInbox({ id: uid(), type:'tab', title: 'Image', url: info.srcUrl, fav:'' });
    if (ok) flash(); else flash('dup', '#f97316');
  } else if (info.menuItemId === 'te-save-all' && tab) {
    let s = await getState();
    s = await ensureDefault(s);
    const ws = s.workspaces.find(w => w.id === s.activeWsId) || s.workspaces[0];
    const cat = ws.categories.find(c => c.id === ws.activeCatId) || ws.categories[0];
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const valid = tabs.filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('edge') && !t.url.startsWith('about'));
    const now = new Date();
    cat.groups.push({
      id: uid(), symbol:'💾', color:'#06b6d4', collapsed:false,
      name: `Session ${now.toLocaleDateString('en',{month:'short',day:'numeric'})} ${now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`,
      items: valid.map(t => ({ id: uid(), type:'tab', title:t.title||'Untitled', url:t.url, fav:t.favIconUrl||'' }))
    });
    await setState(s);
    flash(String(valid.length));
  }
});

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Keyboard shortcut: save current tab ──────────────────────────────
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'save-current-tab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    if (tab.url.startsWith('chrome') || tab.url.startsWith('edge') || tab.url.startsWith('about')) return;
    const ok = await addToInbox({ id: uid(), type:'tab', title:tab.title||'Untitled', url:tab.url, fav:tab.favIconUrl||'' });
    if (ok) flash();
    else flash('dup', '#f97316');
  }
});

// ─── Reminder alarms ──────────────────────────────────────────────────
function walkItems(items, id) {
  for (const it of (items || [])) {
    if (it && it.id === id) return it;
    if (it && it.type === 'stack' && it.items) {
      const r = walkItems(it.items, id);
      if (r) return r;
    }
  }
  return null;
}

function findItemById(state, id) {
  if (!state || !state.workspaces) return null;
  for (const ws of state.workspaces) {
    for (const cat of (ws.categories || [])) {
      for (const g of (cat.groups || [])) {
        const item = walkItems(g.items, id);
        if (item) return { item, ws, cat, group: g };
      }
    }
  }
  return null;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    if (alarm.name.startsWith('te-reminder-')) {
      const itemId = alarm.name.slice('te-reminder-'.length);
      const s = await getState();
      if (!s) return;
      const found = findItemById(s, itemId);
      if (!found) return;
      const { item: it } = found;
      const title = it.type === 'tab' ? it.title : (it.type === 'todo' ? 'To-do reminder' : 'Note reminder');
      const msg = it.type === 'tab' ? (it.url || '') : (stripHtml(it.html || it.text || '').slice(0, 120));
      chrome.notifications.create('te-notif-' + itemId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '⏰ ' + title,
        message: msg,
        priority: 2
      });
      if (it.reminder) it.reminder.notified = true;
      await setState(s);
    } else if (alarm.name.startsWith('te-sub-')) {
      const subId = alarm.name.slice('te-sub-'.length);
      const s = await getState();
      if (!s?.subscriptions) return;
      const sub = s.subscriptions.find(x => x.id === subId);
      if (!sub) return;
      const sym = ({ USD:'$', EUR:'€', GBP:'£', TWD:'NT$', JPY:'¥', CNY:'¥', KRW:'₩' })[sub.currency] || '$';
      chrome.notifications.create('te-sub-notif-' + subId, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: '💳 Subscription renewing in 3 days',
        message: `${sub.name} • ${sym}${Number(sub.cost).toFixed(2)} • ${sub.nextBilling}`,
        priority: 2
      });
    }
  } catch (err) {
    console.error('TabExtend alarm failed:', alarm.name, err);
  }
});

function stripHtml(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// Click notification → open TabExtend. Subscription and storage-quota
// notifications previously did nothing on click — now they all open newtab.
const NOTIF_OPEN_PREFIXES = ['te-notif-', 'te-sub-notif-', 'te-storage-quota-'];
chrome.notifications.onClicked.addListener((notifId) => {
  if (!NOTIF_OPEN_PREFIXES.some(p => notifId.startsWith(p))) return;
  chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
  chrome.notifications.clear(notifId);
});
