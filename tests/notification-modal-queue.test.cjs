const test = require("node:test");
const assert = require("node:assert/strict");

const { NotificationModalQueue } = require("../.test-build/app/ui/shell/notification-modal-queue.js");

/** A host that records opened modals (one handle object each) and sleeps. */
function makeHost(unavailable = new Set()) {
  const host = {
    opened: [],
    sleeps: 0,
    open(notificationKey) {
      const modal = { notificationKey };
      host.opened.push(modal);
      return modal;
    },
    isAvailable: (notificationKey) => !unavailable.has(notificationKey),
    sleep() { host.sleeps++; },
  };
  return host;
}

test("only one modal is open; later notifications wait and open as each closes", () => {
  const host = makeHost();
  const queue = new NotificationModalQueue(host);
  queue.post("a", false);
  queue.post("b", false);
  queue.post("c", false);
  assert.deepEqual(host.opened.map((modal) => modal.notificationKey), ["a"]);
  assert.deepEqual(queue.queuedKeys(), ["b", "c"]);
  queue.closed(host.opened[0]);
  assert.deepEqual(host.opened.map((modal) => modal.notificationKey), ["a", "b"]);
  queue.closed(host.opened[1]);
  queue.closed(host.opened[2]);
  assert.deepEqual(host.opened.map((modal) => modal.notificationKey), ["a", "b", "c"]);
  assert.equal(host.sleeps, 0);
  // With nothing open, the next notification opens at once.
  queue.post("d", false);
  assert.equal(host.opened.length, 4);
});

test("reposts of the open or a queued notification are not duplicated", () => {
  const host = makeHost();
  const queue = new NotificationModalQueue(host);
  queue.post("a", false);
  queue.post("a", false);
  queue.post("b", false);
  queue.post("b", false);
  assert.equal(host.opened.length, 1);
  assert.deepEqual(queue.queuedKeys(), ["b"]);
});

test("queued notifications that went away are skipped", () => {
  const unavailable = new Set(["b"]);
  const host = makeHost(unavailable);
  const queue = new NotificationModalQueue(host);
  queue.post("a", false);
  queue.post("b", false);
  queue.post("c", false);
  queue.closed(host.opened[0]);
  assert.deepEqual(host.opened.map((modal) => modal.notificationKey), ["a", "c"]);
});

test("a screen woken by a notification sleeps again once the last modal closes", () => {
  const host = makeHost();
  const queue = new NotificationModalQueue(host);
  queue.post("a", true);
  queue.post("b", false);
  queue.closed(host.opened[0]);
  assert.equal(host.sleeps, 0, "the next notification opens instead of sleeping");
  queue.closed(host.opened[1]);
  assert.equal(host.sleeps, 1);
  // A modal opened with the screen already on doesn't sleep when closed.
  queue.post("c", false);
  queue.closed(host.opened[2]);
  assert.equal(host.sleeps, 1);
});

test("sleep drops the queue; another removal opens the next without sleeping", () => {
  const host = makeHost();
  const queue = new NotificationModalQueue(host);
  queue.post("a", true);
  queue.post("b", false);
  queue.removed(host.opened[0], false);
  assert.deepEqual(queue.queuedKeys(), []);
  assert.equal(host.opened.length, 1);
  queue.post("c", false);
  queue.post("d", false);
  queue.removed(host.opened[1], true);
  assert.deepEqual(host.opened.map((modal) => modal.notificationKey), ["a", "c", "d"]);
  assert.equal(host.sleeps, 0);
});

test("the removal reported after a close is ignored, as are stale modals", () => {
  const host = makeHost();
  const queue = new NotificationModalQueue(host);
  queue.post("a", false);
  queue.post("b", false);
  const first = host.opened[0];
  queue.closed(first);
  queue.removed(first, true);
  queue.closed(first);
  assert.deepEqual(host.opened.map((modal) => modal.notificationKey), ["a", "b"]);
  assert.deepEqual(queue.queuedKeys(), []);
});

test("a withdrawn notification leaves the queue; the open one is handed back to close", () => {
  const host = makeHost();
  const queue = new NotificationModalQueue(host);
  queue.post("a", true);
  queue.post("b", false);
  queue.post("c", false);
  assert.equal(queue.withdrawn("b"), null);
  assert.deepEqual(queue.queuedKeys(), ["c"]);
  assert.equal(queue.withdrawn("unknown"), null);
  const open = queue.withdrawn("a");
  assert.equal(open, host.opened[0]);
  // The host closes it, which moves on to the next as a user close would.
  queue.closed(open);
  assert.deepEqual(host.opened.map((modal) => modal.notificationKey), ["a", "c"]);
  queue.closed(queue.withdrawn("c"));
  assert.equal(host.sleeps, 1, "the screen the withdrawn notification woke sleeps again");
});
