const { buildKotlin, checkAndroidRuntime } = require('../../scripts/kotlin-build.cjs');

module.exports = function (hookArgs) {
  // NativeScript parses hooks with an older JavaScript parser; avoid optional chaining.
  const { platform, release } = hookArgs.prepareData;
  if (platform === 'android') checkAndroidRuntime();
  return buildKotlin(platform, release ? 'release' : 'debug');
};
