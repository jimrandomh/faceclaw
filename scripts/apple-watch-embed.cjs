// Ties the Apple Watch app (apple-watch/) to the iOS build. WatchConnectivity
// only links the two apps when the phone app's bundle carries the watch app in
// Watch/, so a phone build that wants a working watch must embed it.
//
// Embedding is opt-in (FACECLAW_EMBED_WATCH=1 in build_paths.sh): signing the
// result needs a provisioning profile for the watch app, which can't be made
// for a team with no watch registered, so it would break everyone else's builds.
//
//   node scripts/apple-watch-embed.cjs config   Write apple-watch/Local.xcconfig.
//   node scripts/apple-watch-embed.cjs sync     Make platforms/ios match the setting.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pbxproj = path.join(root, 'platforms/ios/faceclaw.xcodeproj/project.pbxproj');
// The CLI drops `-sdk iphoneos` from xcodebuild, which would otherwise force
// the watch target onto the iOS SDK, only if this directory exists. Its own watch
// support (the legacy two-target layout) stays inert without a `watchextension`.
const cliWatchMarker = path.join(root, 'App_Resources/iOS/watchapp');

function embedEnabled() {
  return process.env.FACECLAW_EMBED_WATCH === '1';
}

/** Xcode's own builds of the watch project read this too, so they sign the same way. */
function writeLocalConfig() {
  const version = /FACECLAW_VERSION = "(.*)"/.exec(fs.readFileSync(path.join(root, 'app/version.ts'), 'utf8'))[1];
  const lines = [
    `FACECLAW_IOS_BUNDLE_ID = ${process.env.IOS_BUNDLE_ID || 'com.faceclaw.app'}`,
    // An embedded watch app has to carry the phone app's version.
    `MARKETING_VERSION = ${version}`,
  ];
  if (process.env.IOS_TEAM_ID) lines.push(`DEVELOPMENT_TEAM = ${process.env.IOS_TEAM_ID}`);
  fs.writeFileSync(path.join(root, 'apple-watch/Local.xcconfig'), `${lines.join('\n')}\n`);
}

function syncEmbed() {
  const enabled = embedEnabled();
  if (enabled) writeLocalConfig();
  // Without the setting there's normally nothing to undo, and no need for Ruby.
  const embedded = fs.existsSync(pbxproj) && fs.readFileSync(pbxproj, 'utf8').includes('Embed Watch Content');
  if (enabled !== embedded && fs.existsSync(pbxproj)) {
    execFileSync('ruby', [path.join(__dirname, 'embed-apple-watch.rb'), enabled ? 'embed' : 'remove'], { cwd: root, stdio: 'inherit' });
  }
  // Last: a project that still embeds the watch app can't build without this.
  if (enabled) {
    fs.mkdirSync(cliWatchMarker, { recursive: true });
  } else {
    fs.rmSync(cliWatchMarker, { recursive: true, force: true });
    // Xcode leaves what it copied in earlier builds, which would still embed the old app.
    const buildDir = path.join(root, 'platforms/ios/build');
    for (const config of fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : []) {
      fs.rmSync(path.join(buildDir, config, 'faceclaw.app/Watch'), { recursive: true, force: true });
    }
  }
}

module.exports = { embedEnabled, syncEmbed, writeLocalConfig };

if (require.main === module) {
  const command = process.argv[2];
  if (command === 'config') writeLocalConfig();
  else if (command === 'sync') syncEmbed();
  else {
    console.error('usage: apple-watch-embed.cjs config|sync');
    process.exit(2);
  }
}
