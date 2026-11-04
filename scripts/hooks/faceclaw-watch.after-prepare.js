const { syncEmbed } = require('../../scripts/apple-watch-embed.cjs');

// After prepare, because that's when the iOS project and its pods are finished.
module.exports = function (hookArgs) {
  if (hookArgs.prepareData.platform === 'ios') syncEmbed();
};
