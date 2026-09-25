const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const graphics=require('../.test-build/app/graphics/image.js');
const planes=require('../.test-build/app/graphics/plane.js');
const wire=require('../.test-build/app/graphics/presentation-wire.js');
const {encodeShellScene}=require('../.test-build/app/graphics/shell-scene.js');
const {SurfaceCompositor}=require('../.test-build/app/graphics/surface-compositor.js');
function load(file,modules) {
  const context={exports:{},require:name=>{assert.ok(name in modules, name);return modules[name];}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context);
  return context.exports;
}
const font={lineHeight:12,ascent:10,descent:2,measureText:text=>text.length*4,
  drawText:(image,x,y,text,value)=>{for(let i=0;i<text.length;i++) image.fillRect(x+i*4,y+2,2,6,value);}};
const menuCore=load('app/ui/menu-core.ts',{
  '../graphics/image':graphics,'./menu-highlight-motion': require('../.test-build/app/ui/menu-highlight-motion.js'), '../graphics/menu-scroll-list': require('../.test-build/app/graphics/menu-scroll-list.js'), './menu-scroll-motion': require('../.test-build/app/ui/menu-scroll-motion.js'), '../graphics/draw-expression': require('../.test-build/app/graphics/draw-expression.js'),
});
const {MenuLayer}=load('app/ui/menu.ts',{
  '../graphics/image':graphics,'../graphics/textwrap':{},'../graphics/ui-fonts':{getDefaultSmallFont:()=>font},
  '../util/numeric-util':{clamp:(n,a,b)=>Math.max(a,Math.min(b,n))},'./gestures':{},
  './menu-highlight-motion': require('../.test-build/app/ui/menu-highlight-motion.js'), '../graphics/menu-scroll-list': require('../.test-build/app/graphics/menu-scroll-list.js'), './menu-scroll-motion': require('../.test-build/app/ui/menu-scroll-motion.js'), '../graphics/draw-expression': require('../.test-build/app/graphics/draw-expression.js'),
    './metrics':require('../.test-build/app/ui/metrics.js'),'./menu-core':menuCore,
});
const {prepareFrameDraws}=load('app/graphics/glyph-wire.ts',{'./presentation-wire':wire,'../native/texture-atlas':{textureAtlasAvailable:()=>false}});
function menu() {
  const layer=new MenuLayer(null,[{label:'FIRST',onSelect(){}},{label:'SECOND',onSelect(){}}],{x:0,y:0,width:80,minHeight:70,maxHeight:80,squareCorners:true});
  const context={stack:{getBaseSize:()=>({width:80,height:80}),isFocused:()=>true}};
  return {layer,paint:()=>layer.paint(context,()=>new graphics.GrayImage(80,80)),context};
}
test('menu retains the selected text and rounded highlight on the menu plane',async()=>{
  const m=menu(),image=m.paint(),row=image.draws.find(d=>d.presentation);
  assert.equal(row.presentation.depth,0);assert.equal(row.presentation.radius,8);
  assert.ok(row.source.pixels.some(v=>v===255));assert.ok(!image.withDrawsBaked(false).pixels.some(v=>v===255));
  const flat=planes.flattenPlanesWithDraws([{image,x:0,y:0}]);
  const records=wire.presentationRecords(prepareFrameDraws(flat.draws));assert.equal(records.length,1);
  const c=new SurfaceCompositor(80,80);c.configureSurface('app',{x:0,y:0,width:80,height:80,zOrder:0,transparency:'opaque'});
  c.submitSurfaceFrame('app',flat.image.pixels,{x:0,y:0,width:80,height:80},prepareFrameDraws(flat.draws));
  const screen=flat.image.pixels.slice(),preview=c.composite();
  assert.ok(preview.some(v=>v===240));assert.deepEqual(flat.image.pixels,screen);
  await m.layer.handleInput({type:'scroll-down'},m.context);
  const next=m.paint().draws.find(d=>d.presentation);assert.ok(next.y>row.y);assert.equal(next.presentation.depth,0);
});
test('shell menu selection survives serialization and is not baked into its surface',()=>{
  const image=menu().paint(),bytes=encodeShellScene([{image,x:0,y:0,shellKey:7}]);
  assert.equal(new DataView(bytes.buffer).getUint16(14,true),1);
  const c=new SurfaceCompositor(80,80);c.setShellScene(bytes);assert.ok(c.composite().some(v=>v===240));
});
test('later opaque planes occlude a replayed selection without erasing its visible part',()=>{
  const image=menu().paint(),row=image.draws.find(d=>d.presentation),cover=new graphics.GrayImage(10,8,1);
  const flat=planes.flattenPlanesWithDraws([{image,x:0,y:0},{image:cover,x:row.x+10,y:row.y+2}]);
  const records=wire.presentationRecords(prepareFrameDraws(flat.draws));assert.ok(records[0].displayList.calls.some(c => c.op === 2 && c.resource === 65535));
  const c=new SurfaceCompositor(80,80);c.configureSurface('app',{x:0,y:0,width:80,height:80,zOrder:0,transparency:'opaque'});
  c.submitSurfaceFrame('app',flat.image.pixels,{x:0,y:0,width:80,height:80},prepareFrameDraws(flat.draws));
  const preview=c.composite();
  for(let y=row.y+2;y<row.y+10;y++) for(let x=row.x+10;x<row.x+20;x++) assert.equal(preview[y*80+x],0);
  assert.ok(preview.some(v=>v===240));
});

const {LayerStack,noopLayerActions}=load('app/ui/layers.ts',{
  '../graphics/image':graphics,'../graphics/plane':planes,'../native/frame-timings':{spanCurrent:(_name,fn)=>fn()},'./gestures':{},
});
test('context menu surface and selected row both use +4 without changing the app screen',()=>{
  const base=new graphics.GrayImage(100,90,96);
  const stack=new LayerStack({paint:()=>base},noopLayerActions,{width:100,height:90});
  stack.push(new MenuLayer(null,[{label:'FIRST',onSelect(){}}],{x:10,y:8,width:80,minHeight:70,maxHeight:70,depth:4}));
  const frame=planes.flattenPlanesWithDraws(stack.paint());
  assert.deepEqual(frame.image.pixels,base.pixels);
  const records=wire.presentationRecords(prepareFrameDraws(frame.draws));
  assert.deepEqual(records.map(r=>r.depth),[4,4]);assert.equal(records[0].mode,'masked-image');
  const c=new SurfaceCompositor(100,90);c.configureSurface('app',{x:0,y:0,width:100,height:90,zOrder:0,transparency:'opaque'});
  c.submitSurfaceFrame('app',frame.image.pixels,{x:0,y:0,width:100,height:90},prepareFrameDraws(frame.draws));
  const preview=c.composite();
  assert.equal(preview[45*100+10],96); // old left edge has no baked menu
  assert.equal(preview[45*100+13],0); // shifted opaque black interior
  assert.equal(preview[8*100+12],96); // transparent rounded corner
  assert.ok(preview.some(v=>v===240));
  stack.pop();const closed=planes.flattenPlanesWithDraws(stack.paint());
  c.submitSurfaceFrame('app',closed.image.pixels,{x:0,y:0,width:100,height:90},prepareFrameDraws(closed.draws));
  assert.deepEqual(c.composite(),base.pixels);
});
test('system menu bridge shifts its surface and selected row together by +4',()=>{
  const image=menu().paint(),bytes=encodeShellScene([{image,x:8,y:0,shellKey:7,depth:4}]);
  const view=new DataView(bytes.buffer),w=view.getUint16(8,true),h=view.getUint16(10,true);
  assert.equal(view.getInt16(16,true),4);
  assert.equal(wire.readPresentation(bytes,18+w*h).selection.depth,4);
  const c=new SurfaceCompositor(100,80);c.setShellScene(bytes);const preview=c.composite();
  assert.equal(preview[40*100+8],0);assert.equal(preview[40*100+10],80);
});
test('unselected sidebar icons retain -2 depth through shell cropping, including attention badges',()=>{
  const shellScene=require('../.test-build/app/graphics/shell-scene.js');
  const {ShellChromeLayer}=load('app/ui/shell/chrome-layer.ts',{
    '../../graphics/shell-scene':shellScene,'../../graphics/image':graphics,
    '../../graphics/ui-fonts':{getDefaultSmallFont:()=>font,getDefaultMediumFont:()=>font},
    '../../graphics/textwrap':{},'./ambient-cards':{},'../../graphics/battery':{},
    '../../native/notification-icons':{},'../../native/phone-battery':{},'../../util/render-freshness':{},
    '../../graphics/icons':{},'../dashboard-settings':{},'../clock-format':{},'../../graphics/bdffont':{},
    '../layers':{LayerStack},'../menu':{scrollToKeepSelectionVisible:()=>0},'../metrics':{},
    './geometry':{MIN_WINDOW_HEIGHT:280,minWindowTop:()=>0,windowTop:()=>0,SHELL_OPAQUE_BLACK:1,SIDEBAR_WIDTH:64,TOP_BAR_HEIGHT:24},
  });
  const state={selectedIndex:0,focus:'sidebar',windows:[0,1,2].map(n=>({attention:n===1,drawIcon:(image,x,y)=>image.fillRect(x,y,4,4,240)}))};
  const chrome=new ShellChromeLayer(()=>state),image=new graphics.GrayImage(640,480);
  chrome.drawSidebar(image,state);
  assert.deepEqual(Array.from(image.draws.filter(d=>d.presentation),d=>d.presentation.depth),[-2,-2]);
  const crop=shellScene.shellCrop(image,0,0,64,280,1),bytes=encodeShellScene([crop]);
  const c=new SurfaceCompositor(640,480);c.setShellScene(bytes);const preview=c.composite();
  assert.equal(preview[34*640+30],240); // selected icon stays at its original x
  assert.equal(preview[74*640+29],240); // unselected icon moves left by one
  assert.equal(preview[74*640+33],0); // no baked copy at the original right edge
  state.selectedIndex=1;const next=new graphics.GrayImage(640,480);chrome.drawSidebar(next,state);
  assert.equal(next.draws.filter(d=>d.presentation).length,2);
});
