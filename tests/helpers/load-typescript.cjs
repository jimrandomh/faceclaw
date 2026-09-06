const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute production TypeScript with only the native boundary and clock stubbed.
exports.loader = (globals = {}, mocks = {}) => {
  const cache = new Map();
  function load(file) {
    file = path.resolve(__dirname, '../..', file);
    if (cache.has(file)) return cache.get(file);
    const output = {};
    cache.set(file, output);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(source, {
      exports: output, console, Uint8Array, ...globals,
      require(name) {
        if (name in mocks) return mocks[name];
        if (!name.startsWith('.')) throw new Error(`Unmocked module: ${name}`);
        return load(path.resolve(path.dirname(file), name + '.ts'));
      },
    }, { filename: file });
    return output;
  }
  return load;
};
