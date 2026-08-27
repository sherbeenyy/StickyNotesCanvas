import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// utils.jsx is a browser-global script (no module exports). Same loading trick
// as folders.test.mjs: run it in a vm sandbox with light shims and read the
// pure helpers back off the shimmed `window`.
const dir = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(dir, '..', 'utils.jsx'), 'utf8');
const sandbox = { React: {}, window: {}, document: {}, navigator: {}, console, Math, JSON, Date };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const {
  normalizeReminder, reminderTick, reminderNotifyPayload,
  REMINDER_MAX_MINUTES,
} = sandbox.window;

// Values built inside the vm belong to another realm, which strict deepEqual
// rejects. Round-trip through JSON to get host-realm plain values.
const plain = (x) => JSON.parse(JSON.stringify(x));

const MIN = 60000;
// One note with a five-minute reminder, the shape everything below schedules.
const noteWith = (r, over = {}) => ({ id: 'n1', title: 'Groceries', body: 'milk', reminder: r, ...over });
const every5 = () => [noteWith({ everyMinutes: 5, enabled: true })];

/* ---------------- normalizeReminder ---------------- */

test('normalize rejects everything that is not a usable reminder', () => {
  for (const bad of [null, undefined, 0, 'x', [], {}, {everyMinutes: 0}, {everyMinutes: -5},
                     {everyMinutes: 'abc'}, {everyMinutes: NaN}, {everyMinutes: Infinity}]) {
    assert.equal(normalizeReminder(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('normalize keeps a valid interval and defaults enabled to true', () => {
  assert.deepEqual(plain(normalizeReminder({ everyMinutes: 5 })), { everyMinutes: 5, enabled: true });
});

test('normalize honours an explicit enabled:false', () => {
  assert.equal(normalizeReminder({ everyMinutes: 5, enabled: false }).enabled, false);
});

test('normalize rounds a fractional interval and clamps at one week', () => {
  assert.equal(normalizeReminder({ everyMinutes: 5.4 }).everyMinutes, 5);
  assert.equal(normalizeReminder({ everyMinutes: 999999 }).everyMinutes, REMINDER_MAX_MINUTES);
});

test('normalize accepts the numeric string the dialog input produces', () => {
  assert.equal(normalizeReminder({ everyMinutes: '30' }).everyMinutes, 30);
});

/* ---------------- reminderTick: anchoring ---------------- */

test('the first tick anchors without firing — no burst on app start', () => {
  const { next, due } = reminderTick(every5(), {}, 1000);
  assert.deepEqual(plain(due), []);
  assert.deepEqual(plain(next), { n1: { everyMinutes: 5, at: 1000 + 5 * MIN } });
});

test('a tick before the due time fires nothing and preserves the entry', () => {
  const first = reminderTick(every5(), {}, 1000);
  const second = reminderTick(every5(), first.next, 1000 + 5 * MIN - 1);
  assert.deepEqual(plain(second.due), []);
  assert.equal(second.next.n1, first.next.n1, 'entry should be carried over untouched');
});

/* ---------------- reminderTick: firing ---------------- */

test('a tick at the due time fires once and re-anchors a full period ahead', () => {
  const first = reminderTick(every5(), {}, 1000);
  const now = 1000 + 5 * MIN;
  const second = reminderTick(every5(), first.next, now);
  assert.deepEqual(plain(second.due), ['n1']);
  assert.deepEqual(plain(second.next), { n1: { everyMinutes: 5, at: now + 5 * MIN } });
});

test('a three-hour gap fires ONCE, not once per elapsed period', () => {
  const first = reminderTick(every5(), {}, 1000);
  const now = 1000 + 3 * 60 * MIN;
  const second = reminderTick(every5(), first.next, now);
  assert.deepEqual(plain(second.due), ['n1'], 'a suspended machine must not produce a backlog');
  assert.equal(second.next.n1.at, now + 5 * MIN, 're-anchored from now, not from the missed time');
});

test('two due notes both fire in one tick', () => {
  const notes = [noteWith({ everyMinutes: 5, enabled: true }),
                 noteWith({ everyMinutes: 5, enabled: true }, { id: 'n2' })];
  const first = reminderTick(notes, {}, 1000);
  const second = reminderTick(notes, first.next, 1000 + 5 * MIN);
  assert.deepEqual(plain(second.due).sort(), ['n1', 'n2']);
});

/* ---------------- reminderTick: changing the interval ---------------- */

test('changing the interval re-anchors instead of firing', () => {
  const first = reminderTick(every5(), {}, 1000);
  const now = 1000 + 5 * MIN;   // would have been due at the old interval
  const changed = [noteWith({ everyMinutes: 30, enabled: true })];
  const second = reminderTick(changed, first.next, now);
  assert.deepEqual(plain(second.due), [], 'a saved interval change must not fire immediately');
  assert.equal(second.next.n1.at, now + 30 * MIN);
});

/* ---------------- reminderTick: the cleanup contract ---------------- */

test('a deleted note drops out of the schedule', () => {
  const first = reminderTick(every5(), {}, 1000);
  const second = reminderTick([], first.next, 1000 + 5 * MIN);
  assert.deepEqual(plain(second.next), {});
  assert.deepEqual(plain(second.due), []);
});

test('a switched-off reminder drops out and never fires', () => {
  const first = reminderTick(every5(), {}, 1000);
  const off = [noteWith({ everyMinutes: 5, enabled: false })];
  const second = reminderTick(off, first.next, 1000 + 5 * MIN);
  assert.deepEqual(plain(second.next), {});
  assert.deepEqual(plain(second.due), []);
});

test('a removed reminder field drops out and never fires', () => {
  const first = reminderTick(every5(), {}, 1000);
  const second = reminderTick([noteWith(undefined)], first.next, 1000 + 5 * MIN);
  assert.deepEqual(plain(second.next), {});
  assert.deepEqual(plain(second.due), []);
});

test('re-enabling after a switch-off starts a fresh cycle rather than firing', () => {
  let s = reminderTick(every5(), {}, 1000).next;
  s = reminderTick([noteWith({ everyMinutes: 5, enabled: false })], s, 2000).next;
  const back = reminderTick(every5(), s, 3000);
  assert.deepEqual(plain(back.due), []);
  assert.equal(back.next.n1.at, 3000 + 5 * MIN);
});

test('notes with no reminder, and junk entries, are ignored', () => {
  const { next, due } = reminderTick(
    [{ id: 'a' }, { id: '' , reminder: {everyMinutes:5}}, null, noteWith({ everyMinutes: 0 })], {}, 1000);
  assert.deepEqual(plain(next), {});
  assert.deepEqual(plain(due), []);
});

test('a null notes array is tolerated', () => {
  assert.deepEqual(plain(reminderTick(null, {}, 1000)), { next: {}, due: [] });
});

/* ---------------- reminderNotifyPayload ---------------- */

test('payload strips markdown syntax down to what the reader would see', () => {
  const p = reminderNotifyPayload({
    id: 'n1', title: 'Groceries',
    body: '# Weekend run\n- **Sourdough** from Arnaud\n- _olive oil_',
  });
  assert.equal(p.noteId, 'n1');
  assert.equal(p.title, 'Groceries');
  assert.equal(p.body, 'Weekend run\nSourdough from Arnaud\nolive oil');
});

test('payload collapses blank-line runs', () => {
  assert.equal(reminderNotifyPayload({ id: 'n1', body: 'a\n\n\n\nb' }).body, 'a\nb');
});

test('payload falls back to a title for an untitled note', () => {
  assert.equal(reminderNotifyPayload({ id: 'n1', title: '   ', body: 'x' }).title, 'Sticky note');
  assert.equal(reminderNotifyPayload({ id: 'n1' }).title, 'Sticky note');
});

test('payload truncates a long body with an ellipsis', () => {
  const p = reminderNotifyPayload({ id: 'n1', body: 'x'.repeat(500) });
  assert.ok(p.body.length <= 180, `body was ${p.body.length} chars`);
  assert.ok(p.body.endsWith('…'));
});

test('payload never leaks a sticky-image reference into the notification', () => {
  const p = reminderNotifyPayload({ id: 'n1', body: 'see ![shot](sticky-image://0123456789abcdef.png)' });
  assert.ok(!p.body.includes('sticky-image://'), `got: ${p.body}`);
});

test('payload survives a missing or non-string body', () => {
  assert.equal(reminderNotifyPayload({ id: 'n1' }).body, '');
  assert.equal(reminderNotifyPayload({ id: 'n1', body: 42 }).body, '');
});
