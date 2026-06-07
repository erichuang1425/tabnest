/* TabNest popup.js */
const $ = id => document.getElementById(id);
const esc = s => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const favUrl = u => { try { return `https://www.google.com/s2/favicons?domain=${new URL(u).hostname}&sz=32`; } catch { return ''; } };
const dispUrl = u => { try { return new URL(u).hostname; } catch { return u; } };
const isProto = u => !u || u.startsWith('chrome') || u.startsWith('edge') || u.startsWith('about');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

let all = [], state = null, pendingTab = null;

async function loadState() {
  const d = await chrome.storage.local.get('te');
  state = d.te || null;
}
async function load() {
  await loadState();
  const [cur, tabs] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.tabs.query({ currentWindow: true })
  ]);
  const curId = cur[0]?.id;
  all = tabs.filter(t => !isProto(t.url));
  $('qs-count').textContent = all.length;
  render(curId);
}

function render(activeId) {
  $('ptabs').innerHTML = '';
  if (!all.length) { $('ptabs').innerHTML = `<div style="padding:24px;text-align:center;color:var(--text3);font-size:12px;">No saveable tabs</div>`; return; }
  all.forEach(t => {
    const row = document.createElement('div');
    row.className = 'pti' + (t.id === activeId ? ' active-tab' : '');
    const fav = t.favIconUrl || favUrl(t.url);
    row.innerHTML = `
      <img src="${esc(fav)}" alt="" onerror="this.style.visibility='hidden'">
      <div class="pti-info">
        <div class="pti-title">${esc(t.title || t.url)}</div>
        <div class="pti-url">${esc(dispUrl(t.url))}</div>
      </div>
      <button class="pti-save" title="Save…">Save</button>`;
    row.onclick = e => {
      if (e.target.closest('.pti-save')) { openSavePicker(t); return; }
      chrome.tabs.update(t.id, { active: true });
      window.close();
    };
    $('ptabs').appendChild(row);
  });
}

function openSavePicker(tab) {
  pendingTab = tab;
  const stg = $('stg-list'); stg.innerHTML = '';
  if (!state?.workspaces?.length) { stg.innerHTML = '<div style="padding:16px;color:var(--text3);font-size:12px;">No workspaces yet. Open the full workspace to get started.</div>'; }
  else {
    state.workspaces.forEach(ws => {
      ws.categories.forEach(cat => {
        const lbl = document.createElement('div');
        lbl.className = 'stg-cat-lbl';
        lbl.textContent = `${ws.symbol || '🏠'} ${ws.name} — ${cat.name}`;
        stg.appendChild(lbl);
        if (!cat.groups.length) {
          const em = document.createElement('div');
          em.style.cssText = 'padding:6px 14px;font-size:11px;color:var(--text3);';
          em.textContent = 'No groups yet.';
          stg.appendChild(em);
        }
        cat.groups.forEach(g => {
          const row = document.createElement('div');
          row.className = 'stg-row';
          row.innerHTML = `<span class="sym">${esc(g.symbol || '📁')}</span><span class="nm">${esc(g.name)}</span><span class="cnt">${g.items.length}</span>`;
          row.onclick = () => doSave(ws, cat, g, tab);
          stg.appendChild(row);
        });
      });
    });
  }
  $('main-section').classList.add('hidden');
  $('save-to-section').classList.remove('hidden');
}
$('stg-back').onclick = () => { $('save-to-section').classList.add('hidden'); $('main-section').classList.remove('hidden'); pendingTab = null; };

async function doSave(ws, cat, g, t) {
  if (g.items.find(it => it.type === 'tab' && it.url === t.url)) {
    $('stg-list').innerHTML = `<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px;">Already saved in this group.</div>`;
    return;
  }
  g.items.push({ id: uid(), type:'tab', title: t.title || 'Untitled', url: t.url, fav: t.favIconUrl || '' });
  await chrome.storage.local.set({ te: state });
  if (state.settings?.closeTabOnSave !== false) {
    try { await chrome.tabs.remove(t.id); } catch {}
  }
  // visual feedback then close
  const row = [...document.querySelectorAll('.stg-row')].find(r => r.querySelector('.nm')?.textContent === g.name);
  if (row) { row.style.background = 'var(--green)'; row.querySelector('.nm').textContent = 'Saved!'; }
  setTimeout(() => window.close(), 400);
}

$('ps').oninput = () => {
  const q = $('ps').value.toLowerCase();
  $('ptabs').querySelectorAll('.pti').forEach((el, i) => {
    const t = all[i]; if (!t) return;
    const m = !q || (t.title||'').toLowerCase().includes(q) || (t.url||'').toLowerCase().includes(q);
    el.classList.toggle('hidden', !m);
  });
};

$('open-full').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') }); window.close(); };
$('qs-current').onclick = async () => {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (t && !isProto(t.url)) openSavePicker(t);
};
$('qs-all').onclick = async () => {
  if (!state?.workspaces?.length) return;
  const ws = state.workspaces.find(w => w.id === state.activeWsId) || state.workspaces[0];
  const cat = ws.categories.find(c => c.id === ws.activeCatId) || ws.categories[0];
  if (!cat) return;
  const now = new Date();
  cat.groups.push({
    id: uid(), symbol:'💾', color:'#06b6d4', collapsed:false,
    name:`Session ${now.toLocaleDateString('en',{month:'short',day:'numeric'})} ${now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`,
    items: all.map(t => ({ id: uid(), type:'tab', title:t.title||'Untitled', url:t.url, fav:t.favIconUrl||'' }))
  });
  await chrome.storage.local.set({ te: state });
  if (state.settings?.closeTabOnSave !== false) {
    const others = all.slice(1);
    for (const t of others) { try { await chrome.tabs.remove(t.id); } catch {} }
  }
  $('qs-all').textContent = '✓ Saved!';
  $('qs-all').style.background = 'var(--green)';
  $('qs-all').style.color = 'white';
  setTimeout(() => window.close(), 600);
};

load();
