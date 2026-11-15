// Build/preview from a temporary copy so personal App IDs never change the
// checked-in manifest, even if Zeus is interrupted. Only dist/ is copied back.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const [command, ...rawArgs] = process.argv.slice(2);
const args = [], idFlag = rawArgs.indexOf('--app-id');
let appId = process.env.FACECLAW_ZEPP_APP_ID || '';
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--app-id') { appId = rawArgs[++i] || ''; continue; }
  if (rawArgs[i].startsWith('--app-id=')) { appId = rawArgs[i].slice(9); continue; }
  args.push(rawArgs[i]);
}
if (!['build', 'preview', 'bridge'].includes(command) || (idFlag >= 0 && !appId)) {
  console.error('Usage: npm run build|preview|bridge -- --app-id YOUR_APP_ID'); process.exit(1);
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
if (appId && (!/^\d+$/.test(appId) || Number(appId) <= 0 || Number(appId) > 2147483647 || Number(appId) === 99999999)) {
  console.error('Use the numeric App ID registered at https://console.zepp.com/.'); process.exit(1);
}
if (appId) config.app.appId = Number(appId);
if (command !== 'build' && config.app.appId === 99999999) {
  console.error('Register Faceclaw Remote at https://console.zepp.com/ first.');
  console.error('Then use --app-id YOUR_APP_ID or FACECLAW_ZEPP_APP_ID. See ../zepp-install.md.'); process.exit(1);
}
if (!fs.existsSync(path.join(root, 'node_modules/@zeppos/zeus-cli'))) {
  console.error('Install dependencies first: npm ci'); process.exit(1);
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-zepp-'));
for (const entry of ['app.js', 'package.json', 'page', 'app-side', 'setting', 'lib', 'assets']) fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
fs.writeFileSync(path.join(stage, 'app.json'), JSON.stringify(config, null, 2) + '\n');
fs.symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
console.log('Packaging Faceclaw Remote for Amazfit Balance with App ID ' + config.app.appId + '.');
if (config.app.appId === 99999999) console.log('This placeholder build is for verification only. Supply your App ID to install.');
const child = spawn(process.execPath, [path.join(root, 'tools/zeus.cjs'), command, ...args], { cwd: stage, stdio: 'inherit' });
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const dist = path.join(stage, 'dist');
  if (fs.existsSync(dist)) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.cpSync(dist, path.join(root, 'dist'), { recursive: true });
    console.log('Watch artifacts: ' + path.join(root, 'dist'));
  }
  fs.rmSync(stage, { recursive: true, force: true });
}
child.on('error', error => { console.error(error.message); cleanup(); process.exitCode = 1; });
child.on('exit', (code, signal) => { cleanup(); process.exitCode = signal ? 1 : code === null ? 1 : code; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
