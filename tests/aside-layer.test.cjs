const test = require('node:test');
const assert = require('node:assert/strict');
const { createAsideHarness } = require('./helpers/aside-harness.cjs');

const SPEECH = 'We should probably run the budget past Priya before the board meets on the tenth of the month.';
const CUE = 'KIND: recall\nCUE: Board meets the 10th, per Priya\nMORE: She said it moved because of the audit.\nSCORE: 8';

/** Listening, with a check in flight about SPEECH. */
function checking(options) {
  const h = createAsideHarness(options);
  h.createLayer();
  h.say(SPEECH);
  h.tick(20_000);
  assert.equal(h.requests.length, 1);
  return h;
}

/** Listening, with a cue on screen. */
function cueUp(options) {
  const h = checking(options);
  h.tick(2_000);
  h.reply(CUE);
  assert.equal(h.host.announced.length, 1);
  return h;
}

test('the first launch explains itself before the mic starts, once', () => {
  const h = createAsideHarness();
  h.createLayer({ noticeSeen: false });
  assert.equal(h.host.started, 0, 'no mic until acknowledged');
  assert.match(h.screen(), /transcribes everyone in earshot/);
  assert.match(h.screen(), /consent/);
  h.say('Overheard before starting.');
  h.tap();
  assert.equal(h.host.started, 1);
  assert.equal(h.settings.asideNoticeSeenSetting.get(), true);
  assert.doesNotMatch(h.screen(), /Overheard/);

  h.layer.onRemoved();
  h.createLayer({ noticeSeen: true });
  assert.equal(h.host.started, 2, 'later launches go straight to listening');
});

test('with no model it says what to do, and a tap checks again', () => {
  const h = createAsideHarness({ model: null });
  h.model = null;
  h.createLayer();
  assert.equal(h.host.started, 0);
  assert.match(h.screen(), /needs a language model/);
  h.tap();
  assert.equal(h.host.started, 0);
  h.model = { provider: 'anthropic', model: 'test-model', apiKey: 'key' };
  h.tap();
  assert.equal(h.host.started, 1);
});

test('the idle screen says what will happen, until speech arrives', () => {
  const h = createAsideHarness();
  h.createLayer();
  assert.match(h.screen(), /Tap to ask/);
  h.say('Hello there.', false);
  assert.doesNotMatch(h.screen(), /Tap to ask/);
  assert.match(h.screen(), /Hello there/);

  const quiet = createAsideHarness();
  quiet.settings.asideCaptionsSetting.set('off');
  quiet.createLayer();
  const before = quiet.renders;
  quiet.say('Hello there.', false);
  assert.equal(quiet.renders, before + 1, 'captions off still repaints once, to clear the hint');
  assert.doesNotMatch(quiet.screen(), /Tap to ask/);
  quiet.say('Hello there again.', false);
  assert.equal(quiet.renders, before + 1);
});

test('speech reaches the model on the pacing, and most replies change nothing', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say('Too short.');
  h.tick(20_000);
  assert.equal(h.requests.length, 0, 'no trigger, no model call');
  h.say(SPEECH);
  h.tick();
  assert.equal(h.requests.length, 1);
  const prompt = h.lastPrompt();
  assert.match(prompt, /<just_said>[\s\S]*board meets[\s\S]*<\/just_said>/);
  assert.match(prompt, /Bar for this session: high/);
  h.reply('NONE');
  assert.equal(h.host.announced.length, 0);
  assert.doesNotMatch(h.screen(), /RECALL/);
});

test('a cue shows with its kind and a hint, a tap opens its detail, another dismisses it', () => {
  const h = cueUp();
  let screen = h.screen();
  assert.match(screen, /RECALL · tap for more/);
  assert.match(screen, /Board meets the 10th, per Priya/);
  assert.doesNotMatch(screen, /audit/);
  assert.match(screen, /budget past Priya/, 'captions stay under a collapsed cue');
  h.tap();
  screen = h.screen();
  assert.match(screen, /because of the audit/);
  assert.doesNotMatch(screen, /tap for more/);
  assert.doesNotMatch(screen, /budget past Priya/, 'captions make way for the detail');
  assert.equal(h.requests.length, 1, 'a tap on a cue is not a request');
  h.tap();
  assert.doesNotMatch(h.screen(), /Board meets/);
  assert.equal(h.requests.length, 1);
});

test('a cue fades after its duration, into the history', () => {
  const h = cueUp();
  h.tick(14_000);
  assert.match(h.screen(), /Board meets/);
  h.tick(1_500);
  assert.doesNotMatch(h.screen(), /Board meets/);
  h.input('scroll-up');
  assert.match(h.screen(), /Cue 1 of 1/);
  assert.match(h.screen(), /Board meets/);
  assert.match(h.screen(), /because of the audit/);
  h.input('scroll-down');
  assert.doesNotMatch(h.screen(), /Board meets/);
});

test('a score under the bar shows nothing', () => {
  const h = checking();
  h.reply('KIND: explain\nCUE: Budgets exist\nSCORE: 3');
  assert.equal(h.host.announced.length, 0);
  assert.doesNotMatch(h.screen(), /Budgets exist/);
});

test('On request never asks by itself, and a tap always does', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.settings.asideFrequencySetting.set('on-request');
  h.say(SPEECH);
  h.tick(120_000);
  assert.equal(h.requests.length, 0);
  h.tap();
  assert.equal(h.requests.length, 1);
  assert.match(h.screen(), /Thinking/);
  assert.match(h.lastPrompt(), /tapped to ask for help/);
  h.tap();
  assert.equal(h.requests.length, 1, 'a second tap while thinking does not start another');
  h.reply(CUE);
  assert.match(h.screen(), /Board meets/);
  assert.match(h.screen(), /because of the audit/, 'what was asked for opens with its detail');
});

test('a tap with nothing heard or nothing to say gets an answer rather than silence', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.tap();
  assert.equal(h.requests.length, 0);
  assert.match(h.screen(), /Nothing heard yet/);
  h.say('Hello there.');
  h.tick(6_000);
  assert.doesNotMatch(h.screen(), /Nothing heard yet/, 'the notice fades');
  h.tap();
  h.reply('NONE');
  assert.match(h.screen(), /Nothing useful to add/);
});

test('a tap interrupts a check in flight rather than waiting for it', () => {
  const h = checking();
  h.tap();
  assert.equal(h.cancelled, 1);
  assert.equal(h.requests.length, 2);
  h.requests[0].onDone({ text: 'KIND: answer\nCUE: Stale\nSCORE: 9', content: [], stopReason: 'end_turn' });
  assert.doesNotMatch(h.screen(), /Stale/);
  h.reply(CUE);
  assert.match(h.screen(), /Board meets/);
});

test('text aimed at the window is a question, answered in context', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.layer.receiveText('What is a quark?');
  assert.match(h.lastPrompt(), /<question>What is a quark\?<\/question>/);
  h.reply('KIND: answer\nCUE: A fundamental particle\nSCORE: 9');
  assert.match(h.screen(), /A fundamental particle/);
});

test('model failures show in the header, keep the speech, and clear on success', () => {
  const h = checking();
  h.lastRequest().onError('network down');
  assert.match(h.screen(), /Model error: network down/);
  h.tick(10_000);
  assert.equal(h.requests.length, 1, 'backing off');
  h.tick(30_000);
  assert.equal(h.requests.length, 2);
  assert.match(h.lastPrompt(), /<just_said>[\s\S]*board meets/, 'the speech was not lost');
  h.reply('NONE');
  assert.doesNotMatch(h.screen(), /Model error/);
});

test('a stuck request is abandoned and reported', () => {
  const h = checking();
  h.tick(46_000);
  assert.equal(h.cancelled, 1);
  assert.match(h.screen(), /Model error: timed out/);
});

test('a refusal is just silence', () => {
  const h = checking();
  h.lastRequest().onDone({ text: 'KIND: answer\nCUE: Refused\nSCORE: 9', content: [], stopReason: 'refusal' });
  assert.equal(h.host.announced.length, 0);
  assert.doesNotMatch(h.screen(), /Model error/);
});

test('pause stops the mic and asking, and a tap resumes', () => {
  const h = checking();
  h.pick('Pause');
  assert.equal(h.host.stopped, 1);
  assert.equal(h.cancelled, 1, 'the check in flight is dropped');
  assert.match(h.screen(), /Paused/);
  h.tick(3_000);
  h.say('Someone else still using the mic. '.repeat(10));
  h.tick(120_000);
  assert.equal(h.requests.length, 1);
  assert.doesNotMatch(h.screen(), /Someone else/);
  assert.ok(h.menu().includes('Resume'));
  h.tap();
  assert.equal(h.host.started, 2);
  assert.doesNotMatch(h.screen(), /Paused/);
  assert.ok(h.menu().includes('Pause'));
});

test('End and recap stops the mic, waits for the last words, and streams the recap', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say('We agreed to cut the travel budget', false);
  h.pick('End and recap');
  assert.equal(h.host.stopped, 1);
  assert.match(h.screen(), /Finishing the transcript/);
  assert.equal(h.requests.length, 0);
  h.say('We agreed to cut the travel budget by ten percent.');
  h.runTimers();
  assert.equal(h.requests.length, 1);
  assert.match(h.lastPrompt(), /by ten percent/);
  assert.match(h.screen(), /Writing recap/);
  h.lastRequest().onTextDelta('', 'TITLE: Budget\nSUMMARY\nTravel is');
  assert.match(h.screen(), /Budget\n\nSummary\nTravel is/);
  h.reply('TITLE: Budget\nSUMMARY\nTravel is down.\nACTION ITEMS\n- Priya: send the sheet');
  assert.match(h.screen(), /Budget\n\nSummary\nTravel is down\.\n\nAction items\n- Priya: send the sheet/);
  assert.deepEqual([...h.saved], [], 'nothing written without asking');
});

test('a recap of nothing makes no request', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.pick('End and recap');
  h.runTimers();
  assert.equal(h.requests.length, 0);
  assert.match(h.screen(), /nothing to recap/);
});

test('a failed recap keeps the transcript and retries on a tap', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say(SPEECH);
  h.pick('End and recap');
  h.runTimers();
  h.lastRequest().onError('overloaded');
  assert.match(h.screen(), /Recap failed/);
  assert.match(h.screen(), /overloaded/);
  h.tap();
  h.runTimers();
  assert.equal(h.requests.length, 2);
  h.reply('TITLE: Second try\nSUMMARY\nFine.');
  assert.match(h.screen(), /Second try/);
});

test('resuming continues the session, and a later recap covers all of it', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say('First part of the talk.');
  h.pick('End and recap');
  h.runTimers();
  h.reply('TITLE: One\nSUMMARY\nFirst.');
  h.pick('Resume');
  assert.equal(h.host.started, 2);
  assert.doesNotMatch(h.screen(), /Recap/);
  h.tick(5_000);
  h.say('Second part of the talk.');
  h.pick('End and recap');
  h.runTimers();
  assert.equal(h.requests.length, 2);
  assert.match(h.lastPrompt(), /First part[\s\S]*Second part/);
});

test('reopening an unchanged recap costs no second request', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say(SPEECH);
  h.pick('End and recap');
  h.runTimers();
  h.reply('TITLE: One\nSUMMARY\nFirst.');
  assert.equal(h.requests.length, 1);
  h.pick('Transcript');
  assert.match(h.screen(), /budget past Priya/);
  h.pick('End and recap');
  h.runTimers();
  assert.equal(h.requests.length, 1);
  assert.match(h.screen(), /One/);
});

test('Save writes the recap, cues and transcript together', () => {
  const h = cueUp();
  h.pick('End and recap');
  h.runTimers();
  h.reply('TITLE: Budget\nSUMMARY\nDone.');
  h.pick('Save');
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].filename, 'aside-2026-11-07-090000.md');
  const { text } = h.saved[0];
  assert.match(text, /^# Budget\n\n## Summary\n\nDone\.\n\n## Cues\n\n- \d\d:\d\d Recall: Board meets the 10th, per Priya\n  She said it moved/);
  assert.match(text, /## Transcript\n\nWe should probably/);
  assert.match(h.screen(), /Saved aside-/);
});

test('Save with nothing heard says so, and writes nothing', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.pick('Save');
  assert.equal(h.saved.length, 0);
  assert.match(h.screen(), /Nothing to save yet/);
});

test('Save automatically writes when a recap finishes and when the window closes', () => {
  const h = createAsideHarness();
  h.settings.asideAutoSaveSetting.set(true);
  h.createLayer();
  h.say(SPEECH);
  h.pick('End and recap');
  h.runTimers();
  h.reply('TITLE: Budget\nSUMMARY\nDone.');
  assert.equal(h.saved.length, 1);
  h.layer.onRemoved();
  assert.equal(h.saved.length, 2);
  h.layer.onRemoved();
  assert.equal(h.saved.length, 2, 'closing twice does nothing more');
});

test('closing without Save automatically writes nothing and stops everything', () => {
  const h = checking();
  h.layer.onRemoved();
  assert.equal(h.saved.length, 0);
  assert.equal(h.cancelled, 1);
  assert.equal(h.voice.transcript.size, 0);
  assert.equal(h.voice.status.size, 0);
});

test('Not useful dismisses the cue and steers later checks away from it', () => {
  const h = cueUp();
  assert.ok(h.menu().includes('Not useful'));
  h.pick('Not useful');
  assert.doesNotMatch(h.screen(), /Board meets/);
  assert.deepEqual([...h.settings.notUsefulCues()], ['Board meets the 10th, per Priya']);
  assert.ok(!h.menu().includes('Not useful'), 'only offered with a cue up');
  h.tick(120_000);
  h.say(SPEECH);
  h.tick();
  assert.match(h.lastPrompt(), /not useful[\s\S]*- Board meets the 10th, per Priya/);
  h.reply('KIND: recall\nCUE: Board meets the 10th per Priya\nSCORE: 9');
  assert.equal(h.host.announced.length, 1, 'and it stays away even if the model offers it again');
});

test('the Not useful list is bounded and survives a bad store', () => {
  const h = createAsideHarness();
  for (let index = 0; index < 40; index++) h.settings.addNotUsefulCue(`cue ${index}`);
  const cues = h.settings.notUsefulCues();
  assert.equal(cues.length, 30);
  assert.equal(cues[29], 'cue 39');
  h.settings.clearNotUsefulCues();
  assert.equal(h.settings.notUsefulCues().length, 0);
});

test('a cue that woke the display puts it back to sleep, unless the wearer touched something', () => {
  const quiet = checking();
  quiet.host.wokeDisplay = true;
  quiet.tick(2_000);
  quiet.reply(CUE);
  quiet.tick(16_000);
  assert.equal(quiet.host.slept, 1);

  const touched = checking();
  touched.host.wokeDisplay = true;
  touched.tick(2_000);
  touched.reply(CUE);
  touched.tap();
  touched.tick(120_000);
  assert.equal(touched.host.slept, 0, 'they are using it');

  const alreadyOn = cueUp();
  alreadyOn.tick(16_000);
  assert.equal(alreadyOn.host.slept, 0, 'it was on already');
});

test('the display stays on for a cue or a recap being written, and otherwise follows the setting', () => {
  const h = cueUp();
  assert.equal(h.layer.wantsScreenOn(), true);
  h.tick(16_000);
  assert.equal(h.layer.wantsScreenOn(), false);
  h.settings.asideKeepDisplayOnSetting.set(true);
  assert.equal(h.layer.wantsScreenOn(), true);
  h.pick('Pause');
  assert.equal(h.layer.wantsScreenOn(), false, 'paused, Keep display on no longer applies');
  h.pick('End and recap');
  assert.equal(h.layer.wantsScreenOn(), true);
});

test('repaints follow what is on screen: captions off and hidden windows skip speech', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say('First words.');
  let before = h.renders;
  h.say('Caption update.', false);
  assert.equal(h.renders, before + 1);

  h.settings.asideCaptionsSetting.set('off');
  before = h.renders;
  h.say('Not painted, so no frame.', false);
  // (The first speech still repaints with captions off, to clear the idle hint.)
  assert.equal(h.renders, before);
  assert.doesNotMatch(h.screen(), /Not painted/);

  h.settings.asideCaptionsSetting.set('last');
  h.visible = false;
  before = h.renders;
  h.say('Off screen.', false);
  assert.equal(h.renders, before);
  h.layer.refresh();
  assert.equal(h.renders, before + 1, 'caught up when the window comes on screen');
});

test('Full captions fill the window, Last lines keeps to three, and all stay inside it', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say(Array.from({ length: 400 }, (_, index) => `word${index}`).join(' '));
  const captions = () => h.paint().texts.filter((entry) => entry.gray !== 200 && entry.y > 30);
  assert.equal(captions().length, 3);
  h.settings.asideCaptionsSetting.set('full');
  const full = captions();
  assert.ok(full.length >= 10, `${full.length} lines`);
  assert.ok(full.every((entry) => entry.y + 12 <= 260), 'nothing past the bottom');
  assert.match(full[full.length - 1].text, /word399/, 'the newest words show');
});

test('the transcript view scrolls the whole conversation, and a tap returns', () => {
  const h = createAsideHarness();
  h.createLayer();
  for (let index = 0; index < 60; index++) h.say(`Sentence number ${index} of the conversation goes here for a while.\n`);
  h.pick('Transcript');
  assert.match(h.screen(), /Transcript/);
  assert.match(h.screen(), /Sentence number 59/, 'starts at the newest');
  for (let index = 0; index < 40; index++) h.input('scroll-up');
  assert.match(h.screen(), /Sentence number 0 /);
  h.tap();
  assert.doesNotMatch(h.screen(), /Sentence number 0 /);
});

test('a recap opens at its top, even while it streams past the window', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.say(SPEECH);
  h.pick('End and recap');
  h.runTimers();
  const items = Array.from({ length: 40 }, (_, index) => `- Point ${index}`).join('\n');
  h.lastRequest().onTextDelta('', `TITLE: Long one\nKEY POINTS\n${items}`);
  assert.match(h.screen(), /Long one/);
  h.reply(`TITLE: Long one\nKEY POINTS\n${items}`);
  assert.match(h.screen(), /Long one/);
  assert.doesNotMatch(h.screen(), /Point 39/);
  for (let index = 0; index < 20; index++) h.input('scroll-down');
  assert.match(h.screen(), /Point 39/);
});

test('a cue arriving in the transcript view is announced, and a tap shows it', () => {
  const h = createAsideHarness();
  h.createLayer();
  h.pick('Transcript');
  h.say(SPEECH);
  h.tick(20_000);
  h.tick(2_000);
  h.reply(CUE);
  assert.match(h.screen(), /New cue/);
  h.tap();
  assert.match(h.screen(), /Board meets/);
});

test('the menu fits what can be done right now', () => {
  const h = createAsideHarness();
  h.createLayer({ noticeSeen: false });
  assert.deepEqual([...h.menu()], ['Aside settings']);
  h.tap();
  assert.deepEqual([...h.menu()], ['End and recap', 'Pause', 'Transcript', 'Prep notes', 'Save', 'Aside settings']);
  h.say(SPEECH);
  h.pick('End and recap');
  h.runTimers();
  h.reply('TITLE: Budget\nSUMMARY\nDone.');
  assert.deepEqual([...h.menu()], ['Resume', 'Transcript', 'Prep notes', 'Save', 'Aside settings']);
  h.pick('Transcript');
  assert.deepEqual([...h.menu()], ['End and recap', 'Resume', 'Back to cues', 'Recap', 'Prep notes', 'Save', 'Aside settings']);
});

test('prep notes and what the wearer knows reach both prompts', () => {
  const h = createAsideHarness();
  h.settings.asideAboutSetting.set('A chemist.');
  h.settings.asidePrepNotesSetting.set('Budget talk with Priya.');
  h.createLayer();
  h.say(SPEECH);
  h.tick(20_000);
  assert.match(h.lastPrompt(), /<about_wearer>\nA chemist\./);
  assert.match(h.lastPrompt(), /<prep_notes>\nBudget talk with Priya\./);
  h.reply('NONE');
  h.pick('End and recap');
  h.runTimers();
  assert.match(h.lastPrompt(), /<about_wearer>\nA chemist\./);
  assert.match(h.lastPrompt(), /<prep_notes>\nBudget talk with Priya\./);
});

test('on-phone models get less context and a longer timeout', () => {
  const h = createAsideHarness({ model: { provider: 'local', model: 'qwen', apiKey: '' } });
  h.createLayer();
  for (let index = 0; index < 200; index++) h.say(`Sentence number ${index} of the conversation goes here for a while.`);
  h.tick(70_000);
  h.reply('NONE');
  for (let index = 200; index < 230; index++) h.say(`Sentence number ${index} of the conversation goes here for a while.`);
  h.tick(70_000);
  const earlier = /<earlier>\n([\s\S]*)\n<\/earlier>/.exec(h.lastPrompt())[1];
  assert.ok(earlier.length <= 3_010, `${earlier.length} chars`);
  h.tick(60_000);
  assert.equal(h.cancelled, 0, 'still within the on-phone timeout');
});
