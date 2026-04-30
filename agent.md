# TabExtend Stage Progress (Updated 2026-04-30)

## Stage 1 — Intention Metadata
Status: Stable.

- Group and stack entities support optional `intent` metadata via `ensureIntentMeta`, `clearIntentMeta`, `hasIntentMeta`.
- Fields used: purpose, nextAction, status, type, updatedAt.
- Backward compatibility: entities without `intent` render and behave normally.
- Intention editing is wired for both group and stack with persistence and clear actions.

## Stage 2 — Future Me Notes
Status: Stable.

- Group and stack entities support optional `futureNotes` arrays.
- Notes include id/text/createdAt and optional resolvedAt.
- UI supports add, resolve, and delete actions in a dedicated Future Me modal.
- Compact unresolved-note preview is rendered on group and stack cards.
- Deletion/resolution use snapshot + undo toast flow.

## Stage 3 — Resume Mode
Status: Stable.

- Resume panel is available for groups and stacks.
- Panel summarizes intention, next action, latest unresolved Future Me note, unfinished todos, and key tabs.
- Resume actions include open key tabs, open all tabs, start Pomodoro, add Future Me note, edit intention, and clear next action.
- Resume open timestamps are persisted via `lastOpenedAt` to support continuity health signals.

## Stage 6 — Project Heartbeat (incremental)
Status: Implemented (small/safe slice).

- Added lightweight heartbeat chips on group/stack cards:
  - `No next action` when intention nextAction is missing.
  - `Stale` when neither intention update nor resume-open happened in the last 7 days.
- Integrated into existing card metadata area without altering interaction flows.
- No destructive migrations.

## Risks / Notes

- Staleness currently uses a fixed 7-day threshold and simple timestamp checks.
- Heartbeat is intentionally minimal to avoid UI clutter and preserve performance.
- Stage 7+ should reuse existing heartbeat helpers and avoid introducing competing status models.
