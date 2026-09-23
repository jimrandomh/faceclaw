// NativeScript runs hooks/<event>/*.js, but that directory is also managed by
// @nativescript/hook on package (re)installs and has been observed to lose our
// custom hook. The tracked copy under scripts/hooks/ is the source of truth;
// this restores it on `npm install` and before every build.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const hooks = [
  { source: 'scripts/hooks/faceclaw-kotlin.before-prepare.js', target: 'hooks/before-prepare/faceclaw-kotlin.js' },
];

function installHooks() {
  const restored = [];
  for (const { source, target } of hooks) {
    const from = path.join(root, source);
    const to = path.join(root, target);
    const content = fs.readFileSync(from);
    if (fs.existsSync(to) && fs.readFileSync(to).equals(content)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
    restored.push(target);
  }
  return restored;
}

module.exports = { installHooks };
if (require.main === module) {
  const restored = installHooks();
  if (restored.length) console.log(`[hooks] restored ${restored.join(', ')}`);
}
