# TabNest

<p>
  <a href="./manifest.json">
    <img src="https://img.shields.io/badge/version-v3.0.0-4f46e5?style=flat-square" alt="version v3.0.0"/>
  </a>
  <a href="./manifest.json">
    <img src="https://img.shields.io/badge/Manifest-MV3-0f766e?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3"/>
  </a>
  <a href="./RELEASE_NOTES.md">
    <img src="https://img.shields.io/badge/releases-notes-111827?style=flat-square" alt="release notes"/>
  </a>
  <img src="https://img.shields.io/badge/storage-local--first-2563eb?style=flat-square" alt="local-first storage"/>
  <img src="https://img.shields.io/badge/host%20permissions-none-16a34a?style=flat-square" alt="no host permissions"/>
  <img src="https://img.shields.io/badge/build-no%20build%20step-f97316?style=flat-square" alt="no build step"/>
</p>

**A private visual workspace for browser tabs, notes, todos, stacks, reminders, and small personal tracking tools.**

TabNest replaces the Chromium new tab page with a local-first command center for the browser sessions you want to keep. Save tabs, arrange them into workspaces, mix them with notes and todos, search with operators, reopen them later, and hibernate saved pages so your browser stays lighter until you need the context again.

<p align="center">
  <img src="./icons/icon128.png" alt="TabNest icon" width="120"/>
</p>

<p align="center">
  <samp>
    <a href="#features">Features</a> &middot;
    <a href="#tags">Tags</a> &middot;
    <a href="#install">Install</a> &middot;
    <a href="#releases">Releases</a> &middot;
    <a href="#privacy">Privacy</a> &middot;
    <a href="#development">Development</a>
  </samp>
</p>

---

## Overview

Modern browser sessions can turn into a pile of research links, articles, half-written thoughts, tasks, and reminders. TabNest gives that mess a calmer home:

- **Save context** from the current tab, the whole window, bookmarks, or the browser context menu.
- **Organize visually** with workspaces, categories, groups, nested stacks, colors, board/list/focus/canvas views, and drag-and-drop.
- **Think in one place** by mixing tabs, notes, todos, reminders, and lightweight trackers instead of scattering them across apps.
- **Find things again** with plain text search, quoted phrases, negative filters, and structured operators.
- **Keep data private** in `chrome.storage.local`; no host permissions and no page-content reading.

## Features

| Area | What TabNest Does |
| --- | --- |
| Workspaces | Multiple named workspaces, category tabs, window binding, group focus, archive, and undo/redo. |
| Saved items | Tabs, notes, todos, recursive stacks, color labels, reminders, batch selection, and card actions. |
| Views | Board, list, focused group, and free-positioned canvas layouts for different planning styles. |
| Search | Operators for `type:`, `color:`, `domain:`, `url:`, `in:`, `is:`, `has:reminder`, and `reminder:`. Prefix any term with `-` to exclude it. |
| Hibernation | Saved tabs can open through a lightweight suspended page and load only when activated. |
| Popup | Quick-save the current tab, save all open tabs, and review open tabs from the extension action. |
| Tools | Pomodoro, finance diary, subscriptions, habits, hydration, reading tracker, goals, and workouts. |
| Portability | Versioned export/import flow with preview before restore. |

Example search:

```text
type:tab in:work domain:github.com "pull request" -is:done
```

## Tags

<p>
  <img src="https://img.shields.io/badge/browser--extension-111827?style=flat-square" alt="browser-extension"/>
  <img src="https://img.shields.io/badge/chrome--extension-111827?style=flat-square" alt="chrome-extension"/>
  <img src="https://img.shields.io/badge/manifest--v3-111827?style=flat-square" alt="manifest-v3"/>
  <img src="https://img.shields.io/badge/tab--manager-111827?style=flat-square" alt="tab-manager"/>
  <img src="https://img.shields.io/badge/local--first-111827?style=flat-square" alt="local-first"/>
  <img src="https://img.shields.io/badge/vanilla--javascript-111827?style=flat-square" alt="vanilla-javascript"/>
</p>

Suggested GitHub topics for the repository:

```text
browser-extension
chrome-extension
manifest-v3
tab-manager
new-tab
productivity
workspace
local-first
privacy-first
vanilla-javascript
notes
todos
reminders
tab-hibernation
```

## Install

1. Clone or download this repository.
2. Open `chrome://extensions/` or `edge://extensions/`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder.
6. Open a new tab to launch TabNest.

After editing files, reload the extension from the browser extensions page.

## Releases

### Latest: `v3.0.0`

TabNest `v3.0.0` is the current local developer release.

Included in this release:

- New-tab workspace with board, list, group focus, and canvas views.
- Workspaces, categories, groups, nested stacks, color coding, and drag-and-drop organization.
- Saved tabs, notes, todos, reminders, archive search, undo/redo, and batch actions.
- Advanced search operators for item type, color, todo state, tab domain, URL, containing group or stack, reminder state, quoted phrases, and negative filters.
- Hibernated tab opening through `suspended.html`.
- Popup quick-save flow for the current tab or all open tabs.
- Built-in Pomodoro, finance, subscriptions, habits, hydration, reading, goals, and workout tools.
- Versioned import/export support with preview.
- Local-first privacy posture with no host permissions.

Full release notes are tracked in [RELEASE_NOTES.md](./RELEASE_NOTES.md).

For a GitHub release, create tag `v3.0.0` and attach a zipped extension package after running the validation checks below.

## Privacy

TabNest is built around a local-first data model:

- Stored URLs, titles, notes, todos, reminders, and tool data live in `chrome.storage.local`.
- The extension does not request host permissions.
- The extension does not read page content.
- Browser permissions are limited to tab workflows, storage, context menus, bookmarks import, alarms, and notifications.

| Permission | Why It Is Used |
| --- | --- |
| `tabs` | Save, reopen, focus, and close tabs for workspace flows. |
| `storage` | Persist local workspace and tool data. |
| `contextMenus` | Save pages, links, selections, and images from the browser context menu. |
| `bookmarks` | Import bookmarks into workspaces. |
| `alarms` | Schedule reminders and subscription alerts. |
| `notifications` | Show reminder and storage notifications. |

## Development

TabNest is a vanilla Manifest V3 extension. There is no bundler, package manager, or build command required.

```text
tabnest/
|-- manifest.json        # MV3 manifest, permissions, commands, icons
|-- background.js        # Service worker for menus, alarms, notifications, saves
|-- newtab.html          # Main workspace shell
|-- newtab.css           # Themes, layout, components, tools, responsive styling
|-- newtab.js            # Main app state, rendering, search, tools
|-- popup.html           # Toolbar popup shell
|-- popup.css            # Popup styling
|-- popup.js             # Quick-save and popup tab-list behavior
|-- suspended.html       # Hibernated-tab placeholder
|-- suspended.js         # Resume logic for hibernated tabs
|-- emoji-data.js        # Emoji picker data
|-- icons/               # Extension icons
|-- DESIGN.md            # Product and visual-design notes
|-- RELEASE_NOTES.md     # Release history
`-- .github/workflows/   # CI validation
```

Run the same checks used by CI:

```powershell
node --check newtab.js
node --check background.js
node --check popup.js
node --check suspended.js
node --check emoji-data.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

## Roadmap

- Capture polished product screenshots for the README and browser-store listing.
- Add UI smoke tests for critical save, search, move, and restore flows.
- Expand import/export migration coverage.
- Explore optional encrypted sync while preserving local-first defaults.
- Continue improving keyboard workflows, accessibility, and high-contrast support.

## License

MIT
