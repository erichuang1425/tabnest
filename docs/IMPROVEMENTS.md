# Tabento — Improvements Plan

Status: proposal / living document. Created: 2026-07-02.

**Progress.** Phase 0 (the Spine) has landed: a hash router (`Router`, §2.1), a
layout registry (`LAYOUTS` / `renderBoardView`, §2.2), a reminder aggregator
(`collectReminders`, §2.3), and `createdAt` stamping on new items behind schema
4 — all additive, no user-visible change beyond a deep-linkable board.
Phase 1 (Group Pages, §4.1) has landed: the group-focus modal overlay is now a
first-class routed page (`openGroupPage` / `renderGroupPage`) at
`#/ws/<id>/group/<id>`, with a Workspace › Category › Group breadcrumb, real
back/forward + reload, and an optional rich-text description (`group.readme`,
additive). Selecting a category/workspace transparently exits the page.

This document plans a set of **major** features for Tabento: spatial, animated, design-forward
interfaces and the systems work needed to make them cohere. Every proposal here is grounded in
the current codebase (vanilla JS, MV3, no build step, local-first, no host permissions) and
respects the visual signature laid out in [`DESIGN.md`](../DESIGN.md).

> **Design intent.** The value of these features lives in execution quality — designing motion,
> spatial layout, and a coherent navigation feel inside a hand-written vanilla-JS app with zero
> framework, then keeping it consistent across 13 themes and light/dark. A timeline that *feels*
> alive, an explorer that *feels* like a filesystem, a calendar that reads at a glance. That is
> the work this plan optimizes for.

---

## 1. Where Tabento is today (baseline)

Understanding the constraints is what makes the plan buildable, not aspirational.

**Data model** (`newtab.js`):

```
State
└─ workspaces[]        { id, name, symbol, categories[], activeCatId }
   └─ categories[]     { id, name, groups[] }
      └─ groups[]      { id, name, symbol, color, collapsed, items[] }
         └─ items[]    tab | note | todo | stack
                       tab:   { id, type:'tab', title, url, fav, color?, reminder? }
                       todo:  { id, type:'todo', text, done, color?, reminder? }
                       note:  { id, type:'note', html, color?, reminder? }
                       stack: { id, type:'stack', name, symbol, color, expanded, items[] }
```

**Views.** `settings.viewMode ∈ {board, list, canvas}`. `renderBoard()` (newtab.js:1785) is
the single dispatch point — it early-returns to `renderListView()` / `renderCanvasView()`.
`cycleViewMode()` (:4976) rotates through the three. The active mode is mirrored onto
`document.body.dataset.viewMode` so CSS can react.

**Group focus.** `openGroupFocus(gId)` (:4065) builds a full-screen **overlay** (not a route)
showing one group as a wide column. There is no URL/history, no per-link detail surface, no
deep-linking.

**Reminders.** Only **items** carry `reminder = { at, notified }`. `setReminder()` (:803)
writes the field and schedules a `te-reminder-<itemId>` alarm; background.js:165 fires the
notification. There is no aggregation, no calendar, no reminders on groups/categories, and no
recurrence.

**Navigation.** A single top bar (`#topbar`, newtab.html:87) with workspace title, category
tabs, and a cluster of icon buttons. No breadcrumb, no back/forward, no command palette,
no router.

**Non-negotiable constraints** (from README/DESIGN): no build step, vanilla JS/CSS/HTML,
`chrome.storage.local` only, no host permissions, no page-content reading, theme-driven via
CSS custom properties, and a distinct "bento" visual signature.

---

## 2. Foundations first (the spine everything hangs on)

The big features share three missing primitives. Building these first turns each subsequent
feature from a rewrite into an addition.

### 2.1 A hash router + navigation stack

Introduce a tiny client-side router keyed off `location.hash` so every meaningful surface has
a URL: the board, a group page, the calendar, a specific layout.

```
#/ws/<wsId>/cat/<catId>                     → board (default)
#/ws/<wsId>/cat/<catId>?view=explorer       → alternate layout of the same content
#/ws/<wsId>/group/<groupId>                 → dedicated group page (§4)
#/ws/<wsId>/group/<groupId>/item/<itemId>   → link detail pane open (§4.2)
#/ws/<wsId>/calendar                         → calendar (§5)
```

- A `router.js`-style module (kept inline or as a new file listed in `newtab.html`) parses the
  hash into a `Route` object and calls the matching render function.
- Back/forward and browser history "just work" because we use `history.pushState` + `hashchange`.
- Deep links survive reload (state is in the URL) and are shareable within the same profile.
- `renderBoard()` becomes one route handler among several; `cycleViewMode()` is replaced by an
  explicit **layout switcher** (§3) that updates the query string, not a hidden setting.

This is the single most leveraged change: group pages, the calendar, and alternate layouts all
become routes instead of overlays.

### 2.2 A view/layout registry

Replace the hard-coded `if (viewMode==='list') …` chain (newtab.js:1787-1789) with a registry:

```js
const LAYOUTS = {
  board:    { label:'Bento board', icon:…, render: renderBoard },
  list:     { label:'List',        icon:…, render: renderListView },
  canvas:   { label:'Canvas',      icon:…, render: renderCanvasView },
  explorer: { label:'Explorer',    icon:…, render: renderExplorerView },   // §3.1
  timeline: { label:'Timeline',    icon:…, render: renderTimelineView },   // §3.2
  gallery:  { label:'Gallery',     icon:…, render: renderGalleryView },    // §3.3
  graph:    { label:'Graph',       icon:…, render: renderGraphView },      // §3.4
};
```

Every layout consumes the **same** category → groups → items data and the **same** search
filter, so search operators, drag-and-drop, selection, and reminders keep working across all of
them for free. Adding a layout is registering an entry, never touching the data model.

### 2.3 A reminder aggregation service

Today reminders are discoverable only by walking items during render. Add a pure function that
sweeps the whole tree and returns a normalized list — the calendar (§5), a reminders inbox, and
the `has:reminder`/`reminder:` search operators all read from it:

```js
// Returns [{ at, notified, source:'item'|'group'|'category', refId, wsId, title, color, recur? }]
function collectReminders({ scope = 'all', filter } = {}) { … }
```

This also unlocks putting reminders on **groups and categories** (§6), because the aggregator is
the one place that has to know all the shapes.

---

## 3. Major feature A — a real layout engine (beyond bento)

Bento board, list, and canvas stay as-is. We add layouts that are genuinely different *modes of
thinking about the same links*, switchable from a **layout menu** in the top bar (replacing the
3-way cycle button). Each is a pure renderer over the active category.

### 3.1 File-Explorer layout (Miller columns)

A macOS-Finder / column-browser view of the hierarchy.

- **Column 1:** categories. **Column 2:** groups in the selected category. **Column 3:** items
  (and, for a stack, its children as a further column). Selecting an item opens the **detail
  pane** (§4.2) in the rightmost column.
- Keyboard-first: arrow keys move focus, `→` descends, `←` ascends, `Enter` opens. This is the
  power-user navigation the app currently lacks.
- Breadcrumb bar at the top reflects the selection path and is itself the §2.1 route.
- Bento signature is preserved: each column reuses the `.gcol` compartment framing and gradient
  top-accent so it reads as Tabento, not Finder.

*Why it matters:* getting column-browser focus/scroll/selection to feel native in vanilla JS —
the "snap to reveal the next column," the retained selection per column, the keyboard model — is
pure interaction-craft work.

### 3.2 Timeline layout (animated, chronological)

Lay items out along time, using `reminder.at` when present and item creation order otherwise
(we add a lightweight `createdAt` on new items; existing items fall back to array order).

- A horizontal (or vertical) time axis with items as cards pinned to their moment; a **playhead**
  marks "now," overdue reminders sit to its left with a warm persimmon flag, upcoming to its right.
- **Animated entrance:** cards stagger-in along the axis on load and on filter change using CSS
  transitions + `IntersectionObserver` (no animation library, respects
  `prefers-reduced-motion`). Scrubbing the axis smoothly pans; zoom changes the time granularity
  (day → week → month) with a spring-eased transform.
- Doubles as a "what's coming up" view when filtered to `has:reminder`.

*Why it matters:* the whole value is motion design and time-scale legibility — easing curves,
staggering, the playhead, reduced-motion fallbacks — done tastefully with zero dependencies.

### 3.3 Gallery layout (masonry)

A content-first masonry grid (the safe, functional pattern noted in DESIGN §3, distinct from
Refern's chrome). Favicon/color-tile "covers" for tabs, note previews for notes. Great for
visual scanning of a large group. CSS columns / grid `masonry` with a JS fallback.

### 3.4 Graph / relationship layout (stretch)

The relationship view flagged in DESIGN §3. Nodes = items, edges = shared group/stack/domain.
Force-directed with a tiny hand-rolled simulation (or static radial rings by group). Marked
stretch because it is the most speculative; the router/registry make it drop-in later.

**Per-layout persistence.** The chosen layout is stored per category (`category.layout`) so a
"reading list" category can default to Gallery while a "projects" category defaults to Explorer —
the layout becomes part of how each space is meant to be used.

---

## 4. Major feature B — Group Pages with rich link content

Promote a group from a modal overlay (`openGroupFocus`) to a **first-class page** with its own
route (`#/ws/…/group/<id>`), so a group becomes a place you manage, not a popup you glance at.

### 4.1 The group page shell

- Full-width page with a **header**: group symbol, editable name, item count, a description/README
  field (rich text reusing the existing note editor), and the group's own reminders (§6).
- The group's items rendered in **any layout** from §3 (a group page has its own layout switcher —
  view your reading list as a gallery, your task group as a timeline).
- A **back** affordance and breadcrumb (`Workspace › Category › Group`) wired to real history, so
  browser back returns to the board scroll position.
- Replaces `openGroupFocus`'s overlay; the existing "Focus mode" context-menu action (:1933) and
  the `focus` group-action (:1974, :4757) now navigate to the route instead of opening the overlay.

### 4.2 Per-link detail pane + custom content

Each link (and note/todo) gains an optional detail surface, opened from the explorer's rightmost
column or a card's "expand" affordance, addressable at `…/item/<itemId>`.

New optional fields on items (all additive, all migration-safe — absent = today's behavior):

```js
item.notes      // rich HTML annotation ("why I saved this", quotes, next step)
item.tags       // string[] — feeds a new tag: search operator
item.customFields// [{ label, value }] — arbitrary key/values (e.g. "Author", "Due", "Rating")
item.checklist  // [{ text, done }] — a mini sub-todo list attached to any link
item.cover      // { color } | { emoji } — a chosen tile look (no host access; user-picked only)
item.createdAt  // ms — enables Timeline (§3.2) and reminder sort
item.reminder   // (existing) — now editable inline in the pane
```

- The pane is a right-docked panel (board/gallery/timeline) or the last Miller column (explorer),
  so it never navigates away from context.
- Everything stays local, no host permissions: covers are user-chosen color/emoji, never scraped
  page images.

### 4.3 Migrations

Bump the stored data version and add a forward migration that leaves items untouched (new fields
are optional). Import/export envelope (already versioned per README) carries the new fields; older
exports import unchanged. No destructive changes.

---

## 5. Major feature C — the unified Calendar

A calendar surface that aggregates **every** reminder across the workspace — from links, groups,
and categories (§6) — with the full filter/search vocabulary layered on top.

### 5.1 Views

- **Month grid** (default), **Week/agenda**, and a compact **Upcoming list** (the "reminders
  inbox"). Toggle between them; state lives in the route (`#/ws/…/calendar?cal=month`).
- Each day cell shows reminder dots colored by their source item/group color (reuse existing
  color tokens). Click a dot → open the item detail pane (§4.2) *in place*, or jump to its group
  page.
- Overdue reminders surface in a persistent "Past due" rail, matching the `rem-badge.past`
  treatment already in `renderReminderBadge` (:2149).

### 5.2 Filters (the differentiator)

The calendar reads from `collectReminders()` (§2.3) and accepts the **same filter language** as
the board search bar:

```
in:work color:red type:tab            → only red tab-reminders inside the "work" group
-in:archive has:reminder               → everything with a reminder except archived
category:reading                       → reminders from the "reading" category and its groups
```

So the calendar is not a separate feature silo — it is the search engine projected onto a time
axis. Existing operators (`type:`, `color:`, `in:`, `domain:`, negation) work unchanged because
they already parse against item metadata.

### 5.3 Creating/editing reminders from the calendar

- Drag a reminder dot to another day to reschedule (rewrites `reminder.at`, re-creates the alarm).
- Click an empty day to attach a reminder to an existing item via a quick picker.
- All writes go through the existing `setReminder`/`clearReminder` path (:803/:813) so alarm
  scheduling and `notified` bookkeeping stay correct.

### 5.4 Entry point & nav

A calendar icon-button in `#topbar` (next to the layout switcher) and a keyboard shortcut. The
calendar is a **route**, so it deep-links and back/forward works.

---

## 6. Supporting feature — reminders on groups & categories + recurrence

To make the calendar meaningful beyond single links:

- **Group reminders:** `group.reminders = [{ at, notified, label, recur? }]` — e.g. "review this
  reading list every Friday." Scheduled as `te-greminder-<groupId>-<n>` alarms; background.js
  gains a matching prefix branch alongside the existing `te-reminder-` / `te-sub-` handlers (:165).
- **Category reminders:** same shape at the category level for broad routines.
- **Recurrence:** optional `recur = { every:'day'|'week'|'month', interval, until? }`. On fire,
  the alarm handler computes the next occurrence and re-arms — the one piece that touches
  background.js meaningfully. Non-recurring reminders behave exactly as today.
- The aggregator (§2.3) and calendar (§5) treat all three sources uniformly.

---

## 7. Navigation, cohesion & polish (ties it together)

The user asked for navigation "compatible with the current overall layout." Concretely:

- **Layout switcher** — a single dropdown in `#topbar` replacing the 3-way `#view-mode-btn`
  cycle, listing every registered layout (§2.2) with icons; the current 3-icon swap
  (setViewMode, :4961) folds into it.
- **Breadcrumb bar** — appears under `#topbar` on group pages and the calendar, mirrors the
  active route, each crumb clickable.
- **Command palette** (`Cmd/Ctrl-K` upgrade) — the existing search shortcut grows a command
  mode: jump to a workspace/category/group, switch layout, open calendar, "new reminder,"
  toggle theme. Vanilla, filters the same way search already does.
- **Consistent motion language** — shared easing/duration CSS custom properties
  (`--ease-spring`, `--dur-move`) used by the timeline, layout transitions, and pane slide-ins,
  all gated behind `prefers-reduced-motion`. This is what makes the additions feel like one
  product rather than four bolt-ons.
- **Theme fidelity** — every new surface uses existing theme tokens and the `--brand-grad`
  through-line (DESIGN §3), verified across all 13 themes and light/dark.

---

## 8. Supporting feature — a calmer, progressive onboarding (not all at once)

**Today.** Tabento fires a **9-step spotlight tour up front on first run** (`TOUR_STEPS`,
newtab.js:6483; `startTour`/`showTourStep`, gated by `settings.tourCompleted`). It marches
through workspaces → open tabs → board → categories → tools → view mode → search in one
sitting. Two problems, both of which the features in this plan make worse if left alone:

- **Overwhelming / all at once.** Nine modal steps before the user has done anything is a wall
  of text about surfaces they have no context for yet — and adding Group Pages, new layouts, and
  the calendar would push it to a dozen-plus steps.
- **Laggy.** Each step recomputes `getBoundingClientRect` and writes `top`/`left` on the
  spotlight and bubble (newtab.js:6579-6615), which triggers layout on every transition; there is
  **no resize/scroll reposition handler**, so the spotlight drifts off its target if the window
  changes. Animating layout properties (not `transform`) is the classic source of jank.

The fix is to **shrink the upfront tour and move the rest to just-in-time**, so users learn each
surface the moment they first touch it — one small hint at a time, never a queue.

### 8.1 Three tiers, never stacked

1. **A 15-second welcome (≤3 cards).** Reduce the upfront `TOUR_STEPS` to the essentials only:
   *what Tabento is → save your first tab → where things live.* Everything else graduates to a
   contextual hint. Skippable in one click; never shown twice (`settings.onboarding.welcomeSeen`).
2. **Just-in-time coach-marks.** A single small hint appears the **first time** a user reaches a
   surface — the first empty board, the first time the tools menu opens, the first group page
   (§4), the first layout switch (§3), the first calendar open (§5). Each fires **at most once**
   (persisted in `settings.onboarding.hintsSeen[key]`) and only when **no other coach-mark is
   visible**, with a short cooldown so two milestones can't fire back-to-back. This is how the new
   features onboard themselves *without* growing the upfront tour.
3. **A "Getting started" checklist (learn by doing).** A small, collapsible, **dismissible** card
   (corner-docked, non-blocking) with 4-5 real actions — *Save a tab · Create a group · Set a
   reminder · Try another layout · Open the calendar.* Items tick off when the user actually does
   them (event-driven, wired to the existing `setReminder`, group-create, `setViewMode` paths),
   so it teaches through action, not prose. Auto-hides when complete or dismissed.

### 8.2 Performance & feel (the "not laggy" part)

- **One reusable coach-mark element**, repositioned — never rebuilt per step (the current tour
  already reuses `#tour-bubble`; extend that discipline to the JIT hints).
- **Composite-only motion:** animate `transform`/`opacity`, not `top`/`left`, for the spotlight
  and bubble glide, so transitions stay on the compositor.
- **rAF-throttled reposition on `resize` and `scroll`** (the gap in the current tour) with the
  target rect cached between frames, so the spotlight tracks its target without layout thrash.
- **Defer to after first paint/layout settle** so onboarding never competes with initial render.
- **`prefers-reduced-motion` honored** end to end (instant swaps, no glide) — same guard as the
  rest of this plan (§7).

### 8.3 Control & data model

- New `settings.onboarding = { welcomeSeen, hintsSeen:{}, checklist:{…}, disabled }`. A
  non-destructive migration maps the existing `settings.tourCompleted` → `onboarding.welcomeSeen`
  so returning users are **not** re-onboarded.
- **Settings toggles:** "Replay welcome," "Reset hints," and "Turn off tips" — so power users can
  silence everything and newcomers can replay. Keeps the existing "Settings → Show tour" entry.
- Every hint is dismissible; dismissing a hint marks it seen. Nothing is ever forced twice.

*Why it matters:* the value is entirely in restraint and feel — deciding *what not to say up
front*, sequencing hints so they never pile up, and making the spotlight track smoothly under
resize with zero jank. That is taste-and-motion work, done in vanilla JS with no tour library.

---

## 9. Phasing

Each phase is independently shippable and leaves the app fully working.

| Phase | Scope | Unlocks |
|---|---|---|
| **0 — Spine** ✅ | Hash router (§2.1), layout registry (§2.2), reminder aggregator (§2.3), `createdAt` on new items | Everything below; no user-visible change beyond deep-linkable board |
| **1 — Group Pages** ✅ | §4.1 group route + shell, migrate `openGroupFocus` to it, breadcrumb + back/forward | Groups become manageable pages |
| **2 — Link content** | §4.2 detail pane, additive item fields, `tag:` operator, migration | Rich per-link context |
| **3 — Explorer + Timeline** | §3.1, §3.2, layout switcher (§7), per-category layout persistence | The headline new layouts |
| **4 — Calendar** | §5 month/week/agenda, filter integration, drag-to-reschedule | Unified reminders surface |
| **5 — Reminders everywhere** | §6 group/category reminders + recurrence, background.js alarm branches | Calendar becomes truly complete |
| **6 — Stretch layouts + palette** | §3.3 Gallery, §3.4 Graph, command palette (§7) | Breadth & polish |

**Onboarding (§8)** is deliberately **not a single phase** — it ships in two low-risk slices:
the tour-shrink + JIT framework + checklist can land early (right after Phase 0, since it stands
alone and improves first-run immediately), and each later phase (1, 3, 4) adds its own one-shot
just-in-time hint as it ships, instead of ever re-inflating the upfront tour.

---

## 10. Risks & guardrails

- **Performance at scale.** Timeline/graph over large workspaces need virtualization; render only
  what's near the viewport (`IntersectionObserver`). The board's cached node list pattern
  (newtab.js:89) is the precedent to extend.
- **No-host-permissions integrity.** No feature here scrapes page content. Covers are user-picked
  color/emoji; timelines use local `createdAt`; the calendar reads local reminders only. This is a
  hard constraint and a marketing asset (DESIGN §4) — the plan keeps it intact.
- **Migration safety.** Every new field is optional; absence reproduces today's behavior. Bump the
  version, add a non-destructive forward migration, keep import of old envelopes working.
- **No build step.** All of this is achievable in vanilla JS/CSS/HTML; new modules are added as
  plain `<script>`s in `newtab.html`. No bundler, no framework.
- **Scope discipline.** Graph view and force simulation are explicitly stretch; the router and
  registry ensure they can arrive later without rework.

---

## 11. Success criteria

- A group opens as a **shareable, back/forward-navigable page**, not a modal.
- Any link can carry **notes, tags, custom fields, a checklist, and a reminder**, with today's
  bare links still valid.
- Users can view the same content as **bento, list, canvas, explorer, timeline, and gallery**, and
  the choice persists per category.
- A **calendar** shows every reminder from links, groups, and categories, filterable with the
  existing search operators, with drag-to-reschedule.
- Navigation (layout switcher, breadcrumbs, command palette, motion) feels like **one coherent
  product** across all 13 themes and light/dark, with `prefers-reduced-motion` honored throughout.
- First-run onboarding is **short and progressive**: a ≤3-card welcome, then one just-in-time
  hint per surface (shown at most once, never stacked), plus a dismissible learn-by-doing
  checklist — no nine-step upfront wall, no spotlight jank on resize, and returning users are
  never re-onboarded.
