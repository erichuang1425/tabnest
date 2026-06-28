# TabNest — Layout & Differentiation Brief

Status: living document · Last updated: 2026-06-28 · Branch: `claude/unmerged-prs-app-dev-3xeijl`

This brief captures the design direction for TabNest's layout refresh and — importantly —
how we take *inspiration* from **Refern** and **TabExtend** while staying clearly distinct,
so the product is defensible and free to grow into a profitable business.

> TL;DR — Borrow the **functional patterns** that are common to the whole category (they're not
> protectable), but ship a **visual signature of our own** that reads differently from both
> reference products. Keep a written record (this file) that the design was independently
> created. That combination is what keeps us "inspired, not sued."

---

## 1. The two references

### Refern (`refern.app`) — the video
A desktop **reference / moodboard manager** for creatives. Distinctive traits:
- Image-first **masonry gallery** of saved references.
- Spatial **Canvas** + **Graph** views for arranging references.
- AI **auto-tagging** (reads/describes images), **color-based search**, 14 search operators.
- Local-first, **one-time $30** license (no subscription). Import from Eagle / PureRef / Allusion.
- Dark, gallery-like, content-over-chrome aesthetic.

### TabExtend — the photo
A **tab manager / workspace**. Distinctive traits visible in their marketing shot:
- Light, airy, **pastel** aesthetic with a colorful gradient hero.
- A left **rail of circular site/favicon icons** ("Quicklinks").
- **Top horizontal pill-tabs** (Today / Read later / Tools), active tab a solid blue pill.
- **Kanban columns** of cards that mix tabs + to-dos + notes; yellow sticky-note styling.
- Tagline "Tab management made easy."

### Where TabNest already sits
TabNest is functionally close to TabExtend (sidebar + category tabs + kanban columns of mixed
tab/note/todo cards + a free-positioning canvas). That overlap is **fine on the merits** — these
are generic category patterns — but it means our *visual* identity has to carry the
differentiation. That is the core of this brief.

---

## 2. Legal posture (plain-English, not legal advice)

Four buckets matter. Get a real IP attorney before any paid launch; this is our working model.

| Risk | What's protected | Our stance |
|---|---|---|
| **Copyright** | Their *code*, icons, illustrations, marketing copy, exact gradients/art. | Independently written (vanilla JS, our own SVG icons). Never copy their CSS, assets, or taglines. |
| **Trade dress** | The *distinctive, non-functional* total look-and-feel that identifies the source. | Differentiate the signature elements (palette, tab treatment, card styling, motifs). Keep only the *functional* patterns. |
| **Trademark** | Their names/logos ("Refern", "TabExtend"). | Don't use their names/marks anywhere. "Tab" is descriptive in this category (Toby, Tabby, Workona, Tab Manager all coexist), so "TabNest" is acceptably distinct — but never imitate their wordmark/logo. |
| **Patents** | Specific claimed inventions. | None known to read on basic kanban/canvas/tag UI. Re-check before launch. |

### The key distinction: functional vs. distinctive
Trade dress does **not** protect features that are functional or standard to the category.
Kanban columns, a left sidebar, drag-and-drop, top tabs, a canvas view, search, tagging —
these appear across Trello, Notion, Linear, Toby, Workona, Eagle, PureRef. Using them is safe.

What we must make our *own* (the non-functional, source-identifying signature):

**Avoid imitating (TabExtend):**
- ❌ A left rail of circular favicon "quicklink" bubbles as the primary nav motif.
- ❌ Pastel-light board with yellow sticky-note cards as the signature palette.
- ❌ Solid-pill active top tabs in their blue.
- ❌ Their copy ("Tab management made easy") or icon set.

**Avoid imitating (Refern):**
- ❌ Their exact dark gallery masonry styling / image-card chrome.
- ❌ Their marketing copy, AI-tagging wording, or icon set.

**Our signature instead (see §3).**

---

## 3. Our visual signature — "Aurora"

A deliberately distinct identity that is **neither** TabExtend's pastel-light favicon-rail
**nor** Refern's dark image gallery.

- **Palette — "ink + aurora":** a deep blue-black base (`#0a0c14`) rather than TabExtend's white
  or Refern's neutral gallery grey. Signature accent is a **teal → violet gradient**
  (`--brand-grad`), unlike TabExtend's flat blue or Refern's content-neutral chrome.
- **Category tabs — underline indicator, not solid pills.** The active category is marked with a
  thin gradient **underline** (Linear/Vercel-style), a clear, deliberate divergence from
  TabExtend's solid blue pill. This is structural CSS, so it holds across every theme.
- **Cohesive accent gradient** (`--brand-grad`, derived from each theme's own accents) on the
  active tab, primary buttons, and active workspace chip (gradient left accent bar) — a
  recognizable through-line that is ours, not borrowed.
- **Sidebar = workspaces + live open-tabs list**, not a favicon bubble rail. Already different
  from TabExtend by construction; we lean into it.
- **Themes stay first-class.** Aurora is the new default, but the existing 12 themes remain, so
  users who want light/Nord/Dracula keep them. Identity travels through *structure*
  (tab underline, gradient through-line), not just colors.

### Borrowed *ideas* (functional, safe) worth pursuing next
- From Refern: the **Canvas** view (we already have one) and a future **relationship/graph**
  view; ~~tag-based + **color search**~~ → **color search shipped** (`color:red` operator
  in the search bar). Refern's "14 search operators" trait → **search operators expanded**:
  `type:tab|note|todo|stack` (by kind), `is:done` / `is:open` (todo state),
  `domain:`/`site:` + `url:` (tab hostname / URL substring), `in:` (scope by the name of
  a containing group/stack), and `has:reminder` / `reminder:past|soon|future` (by reminder
  state) now join `color:`, and any operator or word can be **negated**
  with a leading `-` to exclude matches. They combine freely (e.g.
  `type:tab in:work domain:github.com "pull request" -is:done`). All derived from local
  item metadata / structure — no host access. Note: **link previews / thumbnails** would require reading
  page content, which conflicts with our no-host-permissions / private-by-default positioning
  — deferred unless we can derive previews without host access.
- From TabExtend: mixing **tabs + notes + todos** in one column (we already do this);
  per-window workspaces (we already do this).

None of those *ideas* are protectable; our distinct execution is what matters.

---

## 4. Monetization — free now, profitable later

Per direction, the extension is **free for now**. A defensible path to revenue when we're ready:

1. **Free core** — workspaces, board/list/canvas, save & organize tabs, notes/todos, themes,
   local hibernation. Generous on purpose; drives installs and word-of-mouth.
2. **Pro (subscription)** — encrypted **cross-device sync & backup**, unlimited workspaces,
   the productivity tools suite (Pomodoro/Finance/Habits/…), AI auto-tagging & smart search,
   shared/team workspaces. Sync is the natural recurring-value anchor.
3. **One-time "Local Pro" option** — for the subscription-averse (Refern's $30 model proves
   demand): unlock all *local* Pro features with a single payment; sync stays subscription.

Positioning that is ours: **"Your browser, organized — private by default, yours forever."**
Local-first + privacy (no host permissions; we never read page content) is a genuine
differentiator we can market honestly.

---

## 5. Pre-launch checklist (before charging money)
- [ ] IP counsel review of name, store listing, and UI screenshots vs. TabExtend/Refern.
- [ ] Trademark search + (optionally) register the chosen name/logo.
- [ ] Confirm no copied assets/copy; all icons and strings are original.
- [ ] Store listing avoids competitor names and their taglines.
- [ ] Privacy policy reflects local-first / no-host-permissions reality.

---

## 6. Changelog
- **2026-06-21** — Initial brief. Introduced **Aurora** signature theme (new default),
  **underline** category-tab treatment (diverges from TabExtend pills), and a cohesive
  `--brand-grad` through-line. Documented legal posture and a free-now → profitable-later plan.
- **2026-06-21** — Completed the `--brand-grad` through-line onto the **active workspace chip**
  (gradient left accent bar). Shipped **color search** (`color:red`, `color:red,blue`) in the
  board search bar — the first of the §3 "borrowed ideas" roadmap items.
- **2026-06-21** — Expanded the **search operators** (toward Refern's "14 operators" trait):
  `type:tab|note|todo|stack` (by kind, with synonyms like `link`/`task`/`group`) and
  `is:done` / `is:open` (todo completion state). Operators compose with each other and with
  free/quoted text, and stay privacy-safe (derived purely from local item metadata). Ancestor
  stacks are kept visible when a nested item matches, so operator searches surface items inside
  stacks too. Quoted phrases are tokenized before operators so they compose (`type:todo
  "due today"`), and list-view stack headers (`.lv-stack`) are filtered too, not just board/canvas.
- **2026-06-23** — Added the **`domain:`/`site:`** and **`url:`** search operators (toward
  Refern's "14 operators"): filter tabs by hostname (`domain:github.com`, alias `site:`) or by
  full-URL substring (`url:/issues`). Comma-lists OR together; both compose with the existing
  `color:`/`type:`/`is:` operators and free/quoted text. URLs are read from the locally stored
  item metadata (exposed as `data-host`/`data-url` on tab nodes) — still no host access. Only
  tab items carry a URL, so these operators exclude notes/todos/stacks, and archive results are
  suppressed when they're active (consistent with the other metadata operators).
- **2026-06-23** — Added the **`in:`** scope operator (toward Refern's "14 operators"):
  filter by the name of a containing group or stack (`in:work`, `in:research`), so you can
  narrow results to a location instead of just matching text/metadata on the item itself.
  Works in both board and list views (reads group/stack names from `.gcol-name`/`.stack-name`
  and `.lv-group-name`/`.lv-stack-name`), walks ancestors only (a node isn't "in" itself),
  comma-lists OR together, and composes with every existing operator and free/quoted text
  (e.g. `type:tab in:work domain:github.com`). Derived purely from local structure — no host
  access — and archive results are suppressed while it's active, like the other operators.
- **2026-06-23** — Added **negation** to the search syntax (toward Refern's "14 operators"):
  prefix any operator or word with `-` to **exclude** matches — `-type:todo`,
  `-domain:github.com`, `-color:red`, `-in:work`, `-is:done`, or `-"quoted phrase"`. An item is
  hidden if it matches *any* active negative term (OR across negatives), so negatives compose
  with each other and with all positive operators/text (e.g. `type:tab -domain:github.com`).
  A negative that can't apply to a kind leaves it visible (e.g. `-domain:` never hides a
  note/todo). Negative structured operators suppress archive results like the positive ones;
  negative *text* needles instead just filter out matching archive entries. Still no host
  access — purely local metadata/structure.
- **2026-06-28** — Added the **`has:reminder`** and **`reminder:`** search operators (toward
  Refern's "14 operators"): `has:reminder` surfaces every item that has a reminder set, and
  `reminder:past|soon|future` (aliases `rem:`/`due:`, plus synonyms `overdue`/`today`/`later`,
  and `reminder:any` for "any state") narrows by reminder state — `past` = overdue,
  `soon` = due within 24h, `future` = further out. State is bucketed by the same
  `reminderBucket()` helper that styles the reminder badge, so search and the badge always
  agree — and the bucket is recomputed at *filter* time (not cached at DOM-build time) so a
  reminder crossing the overdue/24h threshold while the page stays open is reflected
  immediately. Reminders can be set on any kind (tabs, notes, todos **and** stacks), so all
  of them now render a reminder badge (stacks use an inline header variant) and all are
  matched by the operators, keeping search ⇄ UI consistent. Comma-lists OR together
  (`reminder:past,soon`), negation works (`-has:reminder`, `-reminder:future`), archive
  results are suppressed while it's active like the other metadata operators, and it composes
  with every existing operator and free/quoted text (e.g. `type:tab has:reminder -is:done`).
  Derived purely from the locally stored `it.reminder` timestamp — still no host access.
