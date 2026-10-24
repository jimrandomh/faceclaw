const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const { TranslationModel } = loader()('app/apps/translate/translation-model.ts');
const { buildTranslateUserMessage } = loader()('app/prompts.ts');

// One character per pixel, so wrapping is predictable.
const measure = text => text.length;
// Values built inside the loader's sandbox have its prototypes; compare as plain data.
const plain = value => JSON.parse(JSON.stringify(value));

function settingsHarness({ main = 'onboard', setUp = [] } = {}) {
  class Setting {
    constructor(options) { Object.assign(this, options); this.value = options.defaultValue; }
    get() { return this.value; }
    set(value) { this.value = value; return value; }
    displayValue(value = this.get()) { return this.formatValue ? this.formatValue(value) : String(value); }
  }
  const labels = { elevenlabs: 'ElevenLabs', whisper: 'OpenAI (Whisper)', soniox: 'Soniox', 'whisper-server': 'Whisper server' };
  const available = new Set(setUp);
  return loader({}, {
    '../../ui/dashboard-settings': {
      ConfigSettingEnum: Setting,
      ConfigSettingBoolean: Setting,
      voiceProviderSetting: {
        get: () => main,
        isDisabled: provider => !available.has(provider),
        displayValue: provider => labels[provider] ?? provider,
      },
    },
  })('app/apps/translate/translate-settings.ts');
}

test('finals become segments; finals arriving mid-translation merge into one pending segment', () => {
  const model = new TranslationModel();
  model.accept({ text: 'Hola, ¿qué', isFinal: false });
  assert.equal(model.live, 'Hola, ¿qué');
  model.accept({ text: 'Hola, ¿qué tal?', isFinal: true });
  assert.equal(model.live, '');
  const first = model.nextJob();
  assert.equal(first.segment.source, 'Hola, ¿qué tal?');
  assert.deepEqual(plain(first.context), []);
  assert.equal(model.nextJob(), null, 'one request at a time');

  model.accept({ text: 'Muy bien.', isFinal: true });
  model.accept({ text: '', isFinal: true }); // an empty final with no partial adds nothing
  model.accept({ text: 'Gracias.', isFinal: true });
  assert.equal(model.segments.length, 2);
  assert.equal(model.segments[1].source, 'Muy bien. Gracias.');

  model.progress(first.segment, 'Hi, how');
  assert.equal(first.segment.translation, 'Hi, how');
  model.complete(first.segment, 'Hi, how are you?');
  const second = model.nextJob();
  assert.equal(second.segment.source, 'Muy bien. Gracias.');
  assert.deepEqual(plain(second.context), [{ source: 'Hola, ¿qué tal?', translation: 'Hi, how are you?' }]);
  model.complete(second.segment, 'Very well. Thanks.');
  assert.equal(model.nextJob(), null);
});

test('an empty final keeps the live partial it replaces', () => {
  const model = new TranslationModel();
  model.accept({ text: 'Bonjour', isFinal: false });
  model.accept({ text: '', isFinal: true });
  assert.equal(model.segments[0].source, 'Bonjour');
});

test('context skips failed and dropped turns and stays bounded', () => {
  const model = new TranslationModel();
  const translate = (source, translation) => {
    model.accept({ text: source, isFinal: true });
    const job = model.nextJob();
    if (translation === null) model.fail(job.segment);
    else model.complete(job.segment, translation);
  };
  translate('uno', 'one');
  translate('ruido', null);
  translate('mmm', '');
  for (let i = 0; i < 6; i++) translate(`frase ${i}`, `sentence ${i}`);
  model.accept({ text: 'último', isFinal: true });
  const { context } = model.nextJob();
  assert.equal(context.length, 4);
  assert.deepEqual(plain(context.at(-1)), { source: 'frase 5', translation: 'sentence 5' });
  assert.ok(context.every(turn => turn.translation));

  const long = new TranslationModel();
  for (let i = 0; i < 3; i++) {
    long.accept({ text: 'x'.repeat(500), isFinal: true });
    long.complete(long.nextJob().segment, 'y'.repeat(500));
  }
  long.accept({ text: 'next', isFinal: true });
  assert.equal(long.nextJob().context.length, 1, 'the newest turn is kept even when it alone is over the cap');
});

test('display lines: translations bright, originals dim until translated or when shown, live dimmest', () => {
  const model = new TranslationModel();
  model.accept({ text: 'Guten Morgen', isFinal: true });
  model.complete(model.nextJob().segment, 'Good morning');
  model.accept({ text: 'Wie geht es?', isFinal: true });
  const asking = model.nextJob().segment;
  model.accept({ text: 'Danke', isFinal: false });
  assert.deepEqual(plain(model.lines(measure, 100, false)), [
    { text: 'Good morning', gray: 230 },
    { text: 'Wie geht es?', gray: 120 },
    { text: 'Danke', gray: 90 },
  ]);
  model.progress(asking, 'How are');
  assert.deepEqual(plain(model.lines(measure, 100, false).map(line => line.text)), ['Good morning', 'How are', 'Danke']);
  assert.deepEqual(plain(model.lines(measure, 100, true).map(line => line.gray)), [120, 230, 120, 230, 90]);
  assert.deepEqual(plain(model.lines(measure, 7, false).slice(0, 2)), [{ text: 'Good', gray: 230 }, { text: 'morning', gray: 230 }]);

  // A failed segment keeps its original on screen.
  model.fail(asking);
  assert.deepEqual(plain(model.lines(measure, 100, false)[1]), { text: 'Wie geht es?', gray: 120 });

  // A finished, empty translation is noise: hidden unless originals are shown.
  model.accept({ text: 'mmm', isFinal: true });
  model.complete(model.nextJob().segment, '');
  assert.equal(model.lines(measure, 100, false).some(line => line.text === 'mmm'), false);
  assert.equal(model.lines(measure, 100, true).some(line => line.text === 'mmm'), true);
});

test('saved text pairs each original with its translation', () => {
  const model = new TranslationModel();
  for (const [source, translation] of [['Ciao', 'Hello'], ['Okay.', 'Okay.'], ['boh', null]]) {
    model.accept({ text: source, isFinal: true });
    const job = model.nextJob();
    if (translation === null) model.fail(job.segment);
    else model.complete(job.segment, translation);
  }
  assert.equal(model.savedText(), 'Ciao\n→ Hello\n\nOkay.\n\nboh\n→ (not translated)');
});

test('the user message carries earlier turns as context, then the speech', () => {
  assert.equal(buildTranslateUserMessage('Hola', []), 'Translate this speech into English:\n<speech>Hola</speech>');
  const message = buildTranslateUserMessage('¿Y tú?', [{ source: 'Bien', translation: 'Fine' }]);
  assert.match(message, /context only/);
  assert.match(message, /<speech>Bien<\/speech>\n<english>Fine<\/english>\n\nTranslate this speech/);
  assert.ok(message.endsWith('<speech>¿Y tú?</speech>'));
});

test('Auto picks the main provider when it is multilingual, else the first one set up', () => {
  let settings = settingsHarness({ main: 'soniox', setUp: ['elevenlabs', 'soniox'] });
  assert.equal(settings.resolveTranslateProvider(), 'soniox');
  assert.equal(settings.translateProviderSetting.displayValue('auto'), 'Auto (Soniox)');

  settings = settingsHarness({ main: 'onboard', setUp: ['soniox', 'whisper'] });
  assert.equal(settings.resolveTranslateProvider(), 'whisper');
  // The main provider counts only when it is set up.
  settings = settingsHarness({ main: 'elevenlabs', setUp: ['soniox'] });
  assert.equal(settings.resolveTranslateProvider(), 'soniox');

  settings = settingsHarness({ main: 'onboard', setUp: [] });
  assert.equal(settings.resolveTranslateProvider(), null);
  assert.equal(settings.translateProviderSetting.displayValue('auto'), 'Auto (none set up)');
});

test('an explicit provider is used only while it is set up, and on-device ones are never offered', () => {
  const settings = settingsHarness({ main: 'soniox', setUp: ['soniox', 'whisper-server'] });
  assert.equal(settings.resolveTranslateProvider('whisper-server'), 'whisper-server');
  assert.equal(settings.resolveTranslateProvider('elevenlabs'), null);
  assert.equal(settings.translateProviderSetting.isDisabled('elevenlabs'), true);
  assert.equal(settings.translateProviderSetting.isDisabled('auto'), false);
  assert.deepEqual(plain(settings.translateProviderSetting.values), ['auto', 'elevenlabs', 'whisper', 'soniox', 'whisper-server']);
});
