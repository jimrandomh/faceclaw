const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function load(file,imports={}) {
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module,exports:module.exports,require:name=>{assert.ok(name in imports,name);return imports[name];},console,setTimeout,clearTimeout});
 return module.exports;
}
function harness() {
 const image=load('app/graphics/image.ts',{'./bdffont':{},'./textwrap':{}}),plane=load('app/graphics/plane.ts',{'./image':image});
 const layers=load('app/ui/layers.ts',{'../graphics/image':image,'../graphics/plane':plane,'../native/frame-timings':{spanCurrent:(_label,run)=>run()},'./gestures':{}});
 const {ExtensionLayer}=load('app/ui/shell/extension-layer.ts',{'../../graphics/image':image,'./geometry':{appViewportRect:()=>({x:0,y:0,width:4,height:2})}});
 const shellImports={};for(const statement of ts.createSourceFile('shell.ts',fs.readFileSync('app/ui/shell/shell.ts','utf8'),ts.ScriptTarget.Latest).statements)if(ts.isImportDeclaration(statement))shellImports[statement.moduleSpecifier.text]={};
 Object.assign(shellImports,{'../layers':layers,'./chrome-layer':{ShellChromeLayer:class{}},'../menu':{MenuLayer:class{}},'../../graphics/image':image,'../../graphics/plane':plane});
 const {shell}=load('app/ui/shell/shell.ts',shellImports);
 const source=new image.GrayImage(4,2,220),base={paint:()=>source,handleInput(){}};
 const stack=new layers.LayerStack(base,layers.noopLayerActions,{width:4,height:2});shell.stack=stack;shell.screenOn=true;
 return {shell,stack,source,ExtensionLayer,overlay:dimUnderneath=>({dimUnderneath,paint:(_ctx,below)=>below(),handleInput(){}})};
}
test('pending opaque extension preserves host pixels, then conceals the underlay only after a frame',()=>{
 const h=harness(),overlay=new h.ExtensionLayer(()=>{},()=>{},()=>{},'medium',true);
 h.stack.push(overlay);const pending=h.shell.paintSurface();
 assert.equal(h.stack.baseDim(),1);assert.equal(h.shell.underlayDim(),1);
 assert.ok(Array.from(pending[0].image.pixels).every(value=>value===220));
 overlay.setFrame(new Uint8Array(8).fill(1),4,2);
 const painted=h.shell.paintSurface();assert.equal(h.stack.baseDim(),0);assert.equal(h.shell.underlayDim(),0);
 assert.ok(Array.from(painted[0].image.pixels).every(value=>value===1));assert.ok(Array.from(h.source.pixels).every(value=>value===220));
 h.stack.removeLayer(overlay);h.shell.paintSurface();assert.equal(h.stack.baseDim(),1);assert.equal(h.shell.underlayDim(),1);
});
test('zero concealment survives newer transparent overlays without changing false or omitted dim behavior',()=>{
 for(const dim of [false,undefined]) {const h=harness();h.stack.push(h.overlay(dim));h.shell.paintSurface();assert.equal(h.stack.baseDim(),1);assert.equal(h.shell.underlayDim(),1);}
 const h=harness(),conceal=h.overlay(0);h.stack.push(conceal);h.stack.push(h.overlay(false));h.shell.paintSurface();assert.equal(h.shell.underlayDim(),0);
 h.stack.pop();h.shell.paintSurface();assert.equal(h.shell.underlayDim(),0);
 h.stack.pop();h.shell.paintSurface();assert.equal(h.shell.underlayDim(),1);
});
test('partial dimming composes and replacement layers retain the no-underlay shell default',()=>{
 const h=harness();h.stack.push(h.overlay(0.5));h.stack.push(h.overlay(0.5));h.shell.paintSurface();assert.equal(h.stack.baseDim(),0.25);assert.equal(h.shell.underlayDim(),0.25);
 h.stack.push({paint:()=>h.source,handleInput(){}});h.shell.paintSurface();assert.equal(h.stack.baseDim(),false);assert.equal(h.shell.underlayDim(),1);
});

test('arrival surface ignores the centered app band and reader restores that band',()=>{
 const image=load('app/graphics/image.ts',{'./bdffont':{},'./textwrap':{}});
 const {ExtensionLayer}=load('app/ui/shell/extension-layer.ts',{'../../graphics/image':image,'./geometry':{appViewportRect:()=>({x:1,y:3,width:4,height:2})}});
 const layer=new ExtensionLayer(()=>{},()=>{},()=>{},'medium',false,true);
 const below=()=>new image.GrayImage(6,7,0);
 layer.paint({},below);layer.setFrame(new Uint8Array(8).fill(190),4,2);
 let frame=layer.paint({},below);assert.equal(frame.pixels[1],190);assert.equal(frame.pixels[3*6+1],0);
 layer.alignTop=false;frame=layer.paint({},below);assert.equal(frame.pixels[1],0);assert.equal(frame.pixels[3*6+1],190);
});
