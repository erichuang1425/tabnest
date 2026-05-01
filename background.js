/* ═══ TabExtend background.js ═══ */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const i18n = (key, fallback = '') => chrome.i18n.getMessage(key) || fallback || key;


async function getState() {
  const d = await chrome.storage.local.get('te');
  return d.te || null;
}
const setState = s => chrome.storage.local.set({ te: s });

async function ensureDefault(s) {
  if (!s) {
    s = { workspaces: [], activeWsId: null, archive: [], settings: {} };
  }
  if (!s.workspaces?.length) {
    const cat = { id: uid(), name: i18n('defaultQuicklinks','Quicklinks'), groups: [] };
    const inbox = { id: uid(), name: i18n('defaultInbox','Inbox'), symbol: '📥', color: '#6366f1', collapsed: false, items: [] };
    cat.groups.push(inbox);
    s.workspaces = [{ id: uid(), name: i18n('defaultWorkspace','My Workspace'), symbol: '🏠', categories: [cat], activeCatId: cat.id }];
    s.activeWsId = s.workspaces[0].id;
  }
  return s;
}

async function addToInbox(item) {
  let s = await getState();
  s = await ensureDefault(s);
  const ws = s.workspaces.find(w => w.id === s.activeWsId) || s.workspaces[0];
  const cat = ws.categories.find(c => c.id === ws.activeCatId) || ws.categories[0];
  let inbox = cat.groups.find(g => g.name === i18n('defaultInbox','Inbox'));
  if (!inbox) {
    inbox = { id: uid(), name: i18n('defaultInbox','Inbox'), symbol: '📥', color: '#6366f1', collapsed: false, items: [] };
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
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'te-save-page',     title: i18n('menuSavePage','💾 Save page to TabExtend'),        contexts: ['page'] });
  chrome.contextMenus.create({ id: 'te-save-link',     title: i18n('menuSaveLink','🔗 Save link to TabExtend'),        contexts: ['link'] });
  chrome.contextMenus.create({ id: 'te-save-selection',title: i18n('menuSaveSelection','📝 Save selection as note'),        contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'te-save-image',    title: i18n('menuSaveImage','🖼️ Save image'),                    contexts: ['image'] });
  chrome.contextMenus.create({ id: 'te-sep', type: 'separator', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'te-save-all',      title: i18n('menuSaveAll','📚 Save all tabs in window'),       contexts: ['page'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'te-save-page' && tab) {
    const ok = await addToInbox({ id: uid(), type:'tab', title:tab.title||'Untitled', url:tab.url, fav:tab.favIconUrl||'' });
    if (ok) flash();
  } else if (info.menuItemId === 'te-save-link') {
    await addToInbox({ id: uid(), type:'tab', title: info.selectionText || info.linkUrl, url: info.linkUrl, fav:'' });
    flash();
  } else if (info.menuItemId === 'te-save-selection') {
    const src = tab?.url ? `\n\n— from ${tab.url}` : '';
    await addToInbox({ id: uid(), type:'note', html: escapeHtml(info.selectionText) + escapeHtml(src), color:null });
    flash();
  } else if (info.menuItemId === 'te-save-image') {
    await addToInbox({ id: uid(), type:'tab', title: 'Image', url: info.srcUrl, fav:'' });
    flash();
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
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('te-reminder-')) {
    const itemId = alarm.name.slice('te-reminder-'.length);
    const s = await getState();
    if (!s) return;
    let found = null;
    outer:
    for (const ws of s.workspaces) {
      for (const cat of ws.categories) {
        for (const g of cat.groups) {
          const deep = (items) => {
            for (const it of items) {
              if (it.id === itemId) { found = { it, ws, cat, g }; return true; }
              if (it.type === 'stack' && it.items) if (deep(it.items)) return true;
            }
          };
          if (deep(g.items)) break outer;
        }
      }
    }
    if (!found) return;
    const { it } = found;
    const title = it.type === 'tab' ? it.title : (it.type === 'todo' ? i18n('notifTodoReminder','To-do reminder') : i18n('notifNoteReminder','Note reminder'));
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
      title: i18n('notifSubRenewing','💳 Subscription renewing in 3 days'),
      message: `${sub.name} • ${sym}${Number(sub.cost).toFixed(2)} • ${sub.nextBilling}`,
      priority: 2
    });
  }
});

function stripHtml(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// Click notification → open TabExtend
chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('te-notif-')) return;
  chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
  chrome.notifications.clear(notifId);
});
