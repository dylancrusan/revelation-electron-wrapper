/*
 * Undo/redo history for the presentation builder.
 *
 * Snapshots the whole in-memory document (stacks + selection + frontmatter)
 * after every settled change, and lets the caller step a cursor back and
 * forth through that list. Subscribes to the existing markDirty() funnel
 * (addDirtyListener) so it covers both direct core-UI mutations and plugin
 * mutations via host.transact() without either of those needing to know
 * history exists.
 */
import { state } from './context.js';
import { markDirty, addDirtyListener } from './app-state.js';
import { selectSlide } from './slides.js';

const HISTORY_LIMIT = 100;
const COMMIT_DEBOUNCE_MS = 700;

let entries = [];
let cursor = -1;
let pendingTimer = null;
let restoring = false; // reentrancy guard: true while applying a snapshot
const listeners = [];

function deepClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function snapshot() {
  return {
    stacks: deepClone(state.stacks),
    selected: { h: state.selected.h, v: state.selected.v },
    frontmatter: state.frontmatter
  };
}

function sameAsTop(snap) {
  const top = entries[cursor];
  if (!top) return false;
  return top.frontmatter === snap.frontmatter &&
    JSON.stringify(top.stacks) === JSON.stringify(snap.stacks);
}

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.warn('historyListener error', e); }
  }
}

function commitPending() {
  pendingTimer = null;
  if (restoring) return;
  const snap = snapshot();
  if (sameAsTop(snap)) return;
  entries = entries.slice(0, cursor + 1); // discard redo tail on new edit
  entries.push(snap);
  if (entries.length > HISTORY_LIMIT) entries.shift();
  cursor = entries.length - 1;
  notify();
}

function flushPending() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    commitPending();
  }
}

function scheduleCommit() {
  if (restoring) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(commitPending, COMMIT_DEBOUNCE_MS);
}

function reset() {
  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  entries = [snapshot()];
  cursor = 0;
  notify();
}

function applyEntry(entry) {
  restoring = true;
  try {
    state.stacks = deepClone(entry.stacks);
    state.frontmatter = entry.frontmatter;
    selectSlide(entry.selected.h, entry.selected.v);
    markDirty();
  } finally {
    restoring = false;
  }
}

function undo() {
  flushPending();
  if (cursor <= 0) return false;
  cursor -= 1;
  applyEntry(entries[cursor]);
  notify();
  return true;
}

function redo() {
  flushPending(); // avoids applying a stale future entry if an edit is still settling
  if (cursor >= entries.length - 1) return false;
  cursor += 1;
  applyEntry(entries[cursor]);
  notify();
  return true;
}

function canUndo() { return cursor > 0; }
function canRedo() { return cursor < entries.length - 1; }
function onHistoryChange(fn) { if (typeof fn === 'function') listeners.push(fn); }

// Keeps the live/tip entry's `selected` following plain slide navigation
// (no content change involved). Without this, that entry's `selected` stays
// frozen at wherever the view happened to be the moment it was recorded —
// for entries[0] specifically, that's always the slide selectSlide(0, 0)
// left it on right before loadPresentation() calls reset(). Undoing back
// past the last real edit to that entry would then snap the view to
// whatever slide that was, regardless of where the user actually navigated
// to before making their first edit. Guarded off while restoring (undo/redo
// already drives its own selectSlide) and while an edit is still debouncing
// (that in-flight edit's own entry hasn't been pushed yet, so the tip still
// represents "before this edit" and shouldn't adopt a later navigation).
function syncSelection(h, v) {
  if (restoring || pendingTimer) return;
  if (cursor !== entries.length - 1) return;
  const top = entries[cursor];
  if (!top) return;
  if (top.selected.h === h && top.selected.v === v) return;
  top.selected = { h, v };
}

addDirtyListener(scheduleCommit);

export { reset, undo, redo, canUndo, canRedo, onHistoryChange, syncSelection };
