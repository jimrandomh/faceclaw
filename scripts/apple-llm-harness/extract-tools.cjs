// Print the assistant's built-in tool definitions as JSON ([{name, description, parameters}]),
// pulled from the tool files' object literals via the TypeScript AST, with the dynamic
// parts (the app-id enum, NUMBER_ARG) filled in from a fixed list. An approximation of
// what ToolRegistry.listTools() offers with no app windows open.
// Usage: node scripts/apple-llm-harness/extract-tools.cjs > tools.json
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '../..');
const ts = require(path.join(root, 'node_modules/typescript'));

const FILES = ['system-tools', 'timer-tools', 'window-tools', 'navigate-tools', 'roam-tools']
  .map(name => path.join(root, 'app/assistant', `${name}.ts`));
const APP_IDS = fs.readdirSync(path.join(root, 'app/apps'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !['launcher', 'onboarding', 'evenhub'].includes(entry.name))
  .map(entry => entry.name).sort();
const NUMBER_ARG = (noun, listTool) => ({
  type: 'number',
  description: `1-based ${noun} number, as shown by ${listTool}. May be omitted when only one ${noun} exists.`,
});

const out = [];
for (const file of FILES) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2020, true);
  const consts = {};
  src.forEachChild(function collect(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      consts[node.name.getText()] = node.initializer.text;
    }
    node.forEachChild(collect);
  });
  const evaluate = node => {
    const js = ts.transpileModule(`(${node.getText()})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const names = [...Object.keys(consts), 'MAX_TIMER_DURATION_MS', 'appIds', 'installedNote', 'NUMBER_ARG'];
    return Function(...names, `return ${js}`)(...Object.values(consts), 86400000, APP_IDS, '', NUMBER_ARG);
  };
  src.forEachChild(function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = node.properties.map(p => p.name && p.name.getText());
      if (keys.includes('name') && keys.includes('description') && keys.includes('inputSchema')) {
        try {
          const spec = evaluate(node);
          out.push({ name: String(spec.name).replace(/[^a-zA-Z0-9_-]/g, '_'), description: spec.description, parameters: spec.inputSchema });
        } catch (error) {
          console.error(`skipped a tool in ${path.basename(file)}: ${error.message}`);
        }
        return;
      }
    }
    node.forEachChild(visit);
  });
}
process.stdout.write(JSON.stringify(out, null, 1));
