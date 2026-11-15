// Zeus 1.9.3's bundled helper needs an alias for a project-local install.
const path = require('node:path');
const root = path.dirname(require.resolve('@zeppos/zeus-cli/package.json'));
require('module-alias').addAlias('zeppos-app-utils', path.join(root, 'private-modules/zeppos-app-utils'));
require(path.join(root, 'bin/main.js'));
