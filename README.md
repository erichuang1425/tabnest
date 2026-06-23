# TabNest

A visual tab manager + productivity workspace for Edge / Chrome. Organize tabs, notes, and to-dos in one place — with built-in tools for tracking habits, finances, reading, and more.

## What it does

Replaces your new tab page with a workspace where you can:

- **Save & organize browser tabs** into groups, stacks, and categories — across multiple workspaces, one per browser window
- **Mix tabs with notes & to-dos** in the same group (rich text, slash commands, checkboxes)
- **Track productivity** with built-in tools: Pomodoro timer, Finance Diary, Subscriptions, Habits, Hydration, Reading log, Goals, Workouts
- **Hibernate** opened tabs to use near-zero memory until you actually click them

## Install (developer mode)

1. Clone or download this repository
2. Open `edge://extensions/` (or `chrome://extensions/`)
3. Toggle **Developer mode** in the top right
4. Click **Load unpacked** and select this folder
5. Open a new tab — TabNest takes over

## File structure

```
tabnest/
├── manifest.json        # MV3 manifest, permissions, commands
├── background.js        # Service worker: context menus, alarms, hotkeys
├── newtab.html          # Main workspace view
├── newtab.css           # All styling (12 themes, 8 fonts, 3 sizes)
├── newtab.js            # Main app logic (~3600 lines)
├── popup.html/css/js    # Toolbar popup for quick saves
├── suspended.html       # Lightweight hibernated-tab placeholder
├── emoji-data.js        # ~300 emojis with search keywords
└── icons/               # 16/48/128px extension icons
```

## Architecture

Single-page app, vanilla JS, no build step. State lives in `chrome.storage.local` keyed under `te`:

```
te = {
  workspaces: [{
    id, name, symbol, windowId?,        // workspace (optionally bound to browser window)
    activeCatId,
    categories: [{
      id, name,
      groups: [{
        id, name, symbol, color, collapsed,
        items: [
          { type: 'tab',   url, title, fav, color?, reminder? },
          { type: 'note',  html, color?, reminder? },
          { type: 'todo',  text, done, color?, reminder? },
          { type: 'stack', name, symbol, color, expanded, items: [...recursively] }
        ]
      }]
    }]
  }],
  activeWsId,
  archive: [{ kind: 'item'|'group', data, at }],
  recentEmoji: [...],
  columnWidths: { [groupId]: pixels },
  settings: { theme, size, font, width, hibernate, autoSwitchWorkspace, ... },

  // Tool data
  pomo: { settings, stats, tasks, currentTask },
  fin: { txns: [...], settings },
  subscriptions: [...],
  subSettings: { defaultCurrency },
  habits: [{ id, name, icon, dates: [...] }],
  water: { goal, days: { yyyy-mm-dd: count }, total },
  books: [{ id, title, author, status, date }],
  goals: [{ id, name, due, progress, created }],
  workouts: [{ id, name, duration, note, date }]
}
```

### Undo system

Every destructive action calls `State.snapshot(label)` before mutation. Up to 50 snapshots kept in memory. `Cmd/Ctrl+Z` to undo, `Cmd/Ctrl+Shift+Z` to redo. Toast notifications include an undo button.

### Hibernated tabs

Opening a tab with hibernation enabled creates a tab pointing to `chrome-extension://{id}/suspended.html#url=...&title=...&fav=...`. The suspended page shows the title + favicon and only loads the real URL when the user clicks. Sidesteps the `chrome.tabs.discard()` race condition that was leaving tabs at `about:blank`.

### Drag & drop

Three drag kinds, dispatched via the global `drag` object:
- `tab` — single open tab from sidebar → save into a group/stack
- `tabs-multi` — multiple selected open tabs → batch save
- `item` — saved item being moved between groups/stacks

Drop zones live on every group's `.gcol-cards` div and every stack's `.stack-items` div. Stacks auto-expand 500ms after drag-over. `stopPropagation` on drop handlers prevents nested zones from double-handling.

### Multi-select

Two independent selection systems:
- **Open tabs** (left sidebar): checkbox per row + Ctrl/Cmd-click + Shift-click range. State in `selectedTabIds: Set`.
- **Saved items** (board cards): hover-revealed checkbox on each item. State in `selectedItemIds: Set`. Floating toolbar at bottom for batch open / move / archive / stack.

### Windows-as-workspaces

`chrome.windows.onFocusChanged` fires when you switch browser windows. If `autoSwitchWorkspace` is on, the bound workspace activates automatically. Workspaces store `windowId` to track the binding. Closed windows clear their `windowId` on next render. The chip stack in the sidebar shows one chip per open window with a green pulsing dot.

### Tools

Each tool is opened from the Tools Hub (⚡ icon in topbar). All tool state is persisted under top-level `state.{tool}` keys. Each has its own `open*()`, `close*()`, `render*()`, and `bind*()` functions. Pattern is consistent — easy to add new tools.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read/create/close tabs for the saved-tabs feature |
| `storage` | Persist workspace data |
| `contextMenus` | Right-click "Save page to TabNest" |
| `bookmarks` | "Import bookmarks" feature |
| `alarms` | Reminders + subscription renewal alerts |
| `notifications` | Show reminder/alarm toasts in OS |

No host permissions — the extension does not read web page content.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Search across all saved items. Supports operators: `color:red` / `color:red,blue` (by color), `type:tab\|note\|todo\|stack` (by kind), `is:done` / `is:open` (todo state), `domain:github.com` / `site:` (tab hostname), `url:/issues` (tab URL substring), `in:work` (containing group/stack name). Prefix any operator or word with `-` to **exclude** matches (`-type:todo`, `-domain:github.com`, `-"in progress"`). Comma-lists OR together (`domain:github.com,gitlab.com`). Combine freely with words and `"quoted phrases"`, e.g. `type:tab in:work domain:github.com "pull request" -is:done`. |
| `Cmd/Ctrl + Shift + S` | Save current tab to Inbox |
| `Cmd/Ctrl + Shift + E` | Open extension popup |
| `Cmd/Ctrl + Z / Shift+Z` | Undo / Redo |
| `S` | Focus tab filter in sidebar |
| `M` | Move focused item (or current selection) to another group or stack |
| `?` | Show keyboard cheatsheet |
| `Esc` | Close overlays, clear selections |
| `/todo` `/done` | Convert note → todo, mark done |
| `/red` `/green` `/blue` `/yellow` `/orange` | Set item color |

## Themes

**Aurora** (default — TabNest's signature ink + teal→violet identity), Dark, Light, Dracula, Nord, Rosé Pine, Tokyo Night, Solarized Dark/Light, Gruvbox, Catppuccin, Sepia, Mono. Switchable in Settings → Appearance or via topbar theme button (cycles through).

See [`DESIGN.md`](DESIGN.md) for the layout direction and how TabNest stays visually distinct from similar products.

## v3 features (latest)

**Hibernation finally fixed.** The actual bug was MV3's Content Security Policy: inline `<script>` in extension pages is silently blocked. The previous `suspended.html` had inline JavaScript, so the visibility-change listener never registered. Moved the script to external `suspended.js` (referenced via `<script src=>`). Now it works as designed: tab created in background → page sets title and favicon → script attaches `visibilitychange` listener → when user clicks the tab in the tab strip, `location.replace(realUrl)` runs.

**Stack reordering bug fixed.** `isDescendantOf` now skips the dragged stack itself when walking the target list, so reordering a stack within its parent group no longer triggers "cannot drop a stack into itself."

**Group focus mode.** Click the expand icon on any group header to open a single group as a full-page view with much larger cards.

**2D group resize.** Drag the corner handle (bottom-right of any group) to resize both width AND height. Per-group sizes persist in `state.columnSizes`.

**Move groups between categories.** Right-click any group header → "Move to category" submenu shows other categories + "New category…" to create one on the spot.

**Free-positioning canvas view.** Third view mode in the cycle (board → list → canvas → board). Groups become absolute-positioned cards on a dotted-grid background you can drag anywhere. Per-group positions stored in `cat.canvasPositions[gid] = {x, y}`.

**Floating tool widgets.** Pop out Pomodoro, Finance, Habits, Hydration, or Goals as small draggable mini-windows that float on top of the main board so you can keep them visible while working. Each has minimize/restore, resize, and "open full" buttons. State persists in `state.floating[]`.

**Onboarding tour.** Six-step spotlight overlay walks new users through workspace chips → open tabs → board → tools → view modes → search. Auto-runs on first launch. Replayable from Settings → Behavior → "Show tour again."

**Redesigned topbar icons.** Unified 16×16 viewBox, 1.5–1.6px stroke, proper rounded line caps.

## Known limitations / TODO

- The MV3 service worker may be idle-evicted in low-memory states, so reminders and subscription alerts can fire late (Chromium-side limitation).

## Development notes for Claude Code

- No build step. Edit files, reload extension at `edge://extensions/`.
- `node -c file.js` to syntax-check JS files locally.
- The codebase is intentionally vanilla JS / no React. State updates trigger full re-renders via `renderAll()` or scoped `render*()` calls. This is fast enough for the data sizes we see.
- `attachItemSelection`, `attachItemDrag`, `makeGroupDropZone` are the key cross-cutting helpers.
- Adding a new tool: add HTML overlay → CSS for `.{tool}-overlay` → JS `getX()/openX()/closeX()/renderX()/bindX()` → register in Tools Hub buttons + `bindStatic`.

## License

MIT (use, modify, redistribute freely).
