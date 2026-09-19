const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('./fixtures/pinball-worker.cjs');

function lane(h, index) {
  h.w.ballX = h.ROLLOVERS[index].x;
  h.w.ballY = h.ROLLOVERS[index].y;
  h.checkRollovers(h.w);
  h.w.ballY = 60;
  h.checkRollovers(h.w);
}

function target(h, index) {
  const t = h.TARGETS[index];
  h.w.ballX = t.x + (index < 3 ? 7 : -7);
  h.w.ballY = t.y;
  h.w.ballVx = index < 3 ? -50 : 50;
  h.checkTargets(h.w);
}

test('skill shot awards only the marked first lane; rollovers debounce and raise multiplier to 5x', () => {
  const h = worker();
  h.launchBall(h.w);
  lane(h, 0);
  assert.equal(h.w.score, 800);
  lane(h, 0);
  assert.equal(h.w.score, 800);
  lane(h, 1); lane(h, 2);
  assert.equal(h.w.score, 1400);
  assert.equal(h.w.multiplier, 2);
  for (let round = 0; round < 6; round++) for (let i = 0; i < 3; i++) lane(h, i);
  assert.equal(h.w.multiplier, 5);
  const missed = worker();
  missed.launchBall(missed.w);
  lane(missed, 1); lane(missed, 0);
  assert.equal(missed.w.score, 100);
});

test('six distinct drop targets light a repeatable, escalating center jackpot', () => {
  const h = worker();
  h.launchBall(h.w);
  for (let i = 0; i < 6; i++) { target(h, i); target(h, i); }
  assert.equal(h.w.score, 1900);
  assert.ok(h.w.targetsDown.every(Boolean));
  h.w.ballX = 121; h.w.ballY = 110;
  h.collideBumpers(h.w);
  assert.equal(h.w.score, 4000);
  assert.equal(h.w.jackpots, 1);
  assert.ok(h.w.targetsDown.every((value) => !value));
  for (let i = 0; i < 6; i++) target(h, i);
  h.w.ballX = 121; h.w.ballY = 110;
  h.collideBumpers(h.w);
  assert.equal(h.w.score, 9000);
  assert.equal(h.w.jackpots, 2);
});

test('ball saver preserves objectives once, then a drain pays multiplied bonus and resets the ball', () => {
  const h = worker();
  h.launchBall(h.w);
  target(h, 0);
  h.w.multiplier = 3;
  h.ballDrained(h.w);
  assert.equal(h.w.ballsLeft, 3);
  assert.equal(h.w.ballState, 'ready');
  assert.equal(h.w.targetsDown[0], true);
  h.launchBall(h.w);
  assert.equal(h.w.ballSaveRemaining, 0);
  assert.equal(h.w.skillShotRemaining, 0);
  h.ballDrained(h.w);
  assert.equal(h.w.ballsLeft, 2);
  assert.equal(h.w.lastBonus, 300);
  assert.equal(h.w.score, 450);
  assert.equal(h.highScore(), 450);
  assert.equal(h.w.multiplier, 1);
  assert.equal(h.w.skillLane, 1);
  assert.ok(h.w.targetsDown.every((value) => !value));
  h.launchBall(h.w);
  assert.equal(h.w.ballSaveRemaining, 8);
});

test('pause, background, screen-off and menus preserve gameplay timers', () => {
  for (const suspend of [
    (h) => h.input('double-click'),
    (h) => h.input('short-then-long-press'),
    (h) => h.message({ type: 'foreground', windowId: 'test', foreground: false, focused: false }),
    (h) => h.message({ type: 'screen', on: false }),
  ]) {
    const h = worker(); h.launchBall(h.w); suspend(h);
    h.elapse(60); h.tick(h.w);
    assert.equal(h.w.ballSaveRemaining, 8);
    assert.equal(h.w.skillShotRemaining, 8);
  }
});

test('expired saver drains normally; final bonus is included in game over and restart keeps high score', () => {
  const h = worker();
  for (let i = 0; i < 3; i++) {
    h.launchBall(h.w); target(h, 0);
    h.w.ballSaveRemaining = 0;
    h.ballDrained(h.w);
  }
  assert.equal(h.w.phase, 'game-over');
  assert.equal(h.w.score, 750);
  assert.equal(h.w.lastBonus, 100);
  h.resetGame(h.w);
  assert.equal(h.w.score, 0);
  assert.equal(h.w.ballsLeft, 3);
  assert.equal(h.w.lastBonus, 0);
  assert.equal(h.w.highScore, 750);
});

test('live simulation consumes skill and save time; wall-clock pauses do not', () => {
  const h = worker(); h.launchBall(h.w);
  h.advance(0.25);
  assert.ok(Math.abs(h.w.ballSaveRemaining - 7.75) < 0.001);
  assert.ok(Math.abs(h.w.skillShotRemaining - 7.75) < 0.001);
  h.input('double-click'); h.elapse(90); h.input('click');
  h.advance(0.25);
  assert.ok(Math.abs(h.w.ballSaveRemaining - 7.5) < 0.001);
  assert.ok(Math.abs(h.w.skillShotRemaining - 7.5) < 0.001);
  h.w.skillShotRemaining = 0;
  lane(h, 0);
  assert.equal(h.w.score, 50);
});

test('production physics stays finite and within the table at every launch power', () => {
  for (let power = 1; power <= 5; power++) {
    const h = worker(); h.w.launchPower = power; h.launchBall(h.w);
    let enteredPlayfield = false;
    for (let step = 0; step < 120 * 30 && h.w.ballState === 'live'; step++) {
      if (h.w.ballVy > 0 && h.w.ballY > 195) for (const f of h.w.flippers) h.flip(h.w, f);
      h.advance(1 / 120);
      assert.ok(Number.isFinite(h.w.ballX) && Number.isFinite(h.w.ballY));
      assert.ok(h.w.ballX >= 9 && h.w.ballX <= 261);
      if (h.w.ballX < 226) enteredPlayfield = true;
    }
    assert.ok(enteredPlayfield, `power ${power} enters playfield`);
  }
});

test('ready, live jackpot, paused and game-over frames render at the glasses viewport size', () => {
  const h = worker();
  for (const phase of ['playing', 'paused', 'game-over']) {
    h.w.phase = phase;
    for (const lit of [false, true]) {
      h.w.targetsDown.fill(lit);
      const image = h.paintContent(h.w);
      assert.equal(image.width, 576);
      assert.equal(image.height, 260);
      assert.ok(image.withDrawsBaked().pixels.some((p) => p > 0));
    }
  }
});
