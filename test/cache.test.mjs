import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import Cache from '../addon/content/cache.js';
const uuid='12345678-1234-1234-1234-123456789abc';
const old=new Date(Date.now()-48*3600000);
const adapter={
  async stat(path) { try {const s=await fs.lstat(path);return {type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':s.isFile()?'file':'other',size:s.size,mtime:s.mtimeMs};}catch(e){if(e.code==='ENOENT')return null;throw e;} },
  children:async path=>(await fs.readdir(path)).map(n=>join(path,n)),basename,
  async remove(path){const s=await fs.lstat(path);if(s.isDirectory())await fs.rmdir(path);else await fs.unlink(path);},
};
async function fixture(t){const root=await fs.mkdtemp(join(tmpdir(),'zotero-cache-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function write(root,name,text='cache',aged=true){const p=join(root,name);await fs.writeFile(p,text);if(aged)await fs.utimes(p,old,old);return p;}
test('cleanup removes only old owned scratch files and preserves runtimes, backups and recent files',async t=>{
 const root=await fixture(t);
 const archive=await write(root,`.download-${uuid}.zip`);
 const probe=await write(root,`probe-${uuid}.json`);
 const stage=join(root,`.install-${uuid}`);await fs.mkdir(stage);await write(stage,'part');await fs.utimes(stage,old,old);
 const keep=[await write(root,`configure-${uuid}.json`,'recent',false),await write(root,'.download-unknown.zip'),await write(root,'config.toml.before-zotero-123.bak'),await write(root,'zotero-codex-mcp.json')];
 const runtime=join(root,'0.7.0-darwin-arm64');await fs.mkdir(runtime);keep.push(await write(runtime,'node'));
 const report=await Cache.inspect(adapter,root);
 assert.equal(report.count,3);assert.equal(report.bytes,15);assert.equal(report.retainedBytes,5);assert.equal(report.recentCount,1);
 const cleaned=await Cache.clean(adapter,root);
 assert.equal(cleaned.removed,3);assert.equal(cleaned.freedBytes,15);assert.equal(cleaned.failed,0);assert.equal(cleaned.remaining.count,0);
 for(const p of keep)assert.ok(await fs.stat(p));
 for(const p of [archive,probe,stage])assert.equal(await adapter.stat(p),null);
});
test('recent descendants protect an entire staging tree',async t=>{
 const root=await fixture(t), stage=join(root,`.install-${uuid}`);await fs.mkdir(stage);
 await write(stage,'old');await write(stage,'active','new',false);await fs.utimes(stage,old,old);
 const r=await Cache.clean(adapter,root);assert.equal(r.removed,0);assert.equal(r.remaining.recentCount,1);assert.equal((await fs.readdir(stage)).length,2);
});
test('symlinks including root and nested links are never traversed',async t=>{
 const root=await fixture(t), outside=await fixture(t);const sentinel=await write(outside,'note.html');
 await fs.symlink(outside,join(root,`.install-${uuid}`));
 await fs.symlink(sentinel,join(root,`probe-${uuid}.json`));
 assert.equal((await Cache.clean(adapter,root)).remaining.skipped,2);assert.equal(await fs.readFile(sentinel,'utf8'),'cache');
 await assert.rejects(()=>Cache.inspect(adapter,join(root,`.install-${uuid}`)),/普通目录/);
 await fs.unlink(join(root,`.install-${uuid}`));await fs.mkdir(join(root,`.install-${uuid}`));
 await fs.symlink(outside,join(root,`.install-${uuid}`,'nested'));await fs.utimes(join(root,`.install-${uuid}`),old,old);
 assert.equal((await Cache.clean(adapter,root)).removed,0);
});
test('partial deletion counts actual freed bytes and can be retried',async t=>{
 const root=await fixture(t);await write(root,`probe-${uuid}.json`);const denied=await write(root,`configure-${uuid}.json`);
 const r=await Cache.clean({...adapter,remove:async p=>{if(p===denied)throw new Error('denied');await adapter.remove(p);}},root);
 assert.equal(r.removed,1);assert.equal(r.failed,1);assert.equal(r.freedBytes,5);assert.equal(r.remaining.count,1);
 assert.equal((await Cache.clean(adapter,root)).removed,1);
});
test('changed candidate and new contents are preserved during cleanup',async t=>{
 const root=await fixture(t),path=await write(root,`probe-${uuid}.json`);let reads=0;
 const r=await Cache.clean({...adapter,stat:async p=>{if(p===path&&++reads===2)await fs.writeFile(p,'in use');return adapter.stat(p);}},root);
 assert.equal(r.removed,0);assert.equal(r.failed,1);assert.equal(await fs.readFile(path,'utf8'),'in use');
});
test('missing cache directory is empty and cleanup does not create it',async t=>{
 const root=join(await fixture(t),'missing');assert.equal((await Cache.inspect(adapter,root)).bytes,0);assert.equal((await Cache.clean(adapter,root)).removed,0);assert.equal(await adapter.stat(root),null);
});
test('runtime blocks prepare/connect/other cleanup for the whole maintenance operation',async()=>{
 let release;const pending=new Promise(r=>{release=r;});
 const context=vm.createContext({ZoteroMCPRuntimeCore:{},ZoteroMCPCache:{inspect:()=>pending},
  Zotero:{Prefs:{get:()=>false},File:{pathToFile:()=>{}}},PathUtils:{join},Services:{dirsvc:{get:()=>({path:'/profile'})}},Components:{interfaces:{nsIFile:{}}}});
 vm.runInContext(await fs.readFile(new URL('../addon/content/runtime.js',import.meta.url),'utf8'),context);
 const runtime=context.ZoteroMCPRuntime;runtime.start({version:'0.8.3',connection:'/connection'});
 const scan=runtime.inspectCache();assert.equal(runtime.state().busy,true);
 await assert.rejects(()=>runtime.ensure(),/缓存/);await assert.rejects(()=>runtime.connect(),/缓存/);await assert.rejects(()=>runtime.clearCache(),/正在处理/);
 release({count:0,candidates:[]});assert.equal((await scan).candidates,undefined);assert.equal(runtime.state().busy,false);
});

async function autoRuntime({enabled=false,last=0,clean=async()=>({remaining:{skipped:0},failed:0}),inspect=async()=>({bytes:104857600,candidates:[]})}={}) {
 const prefs=new Map([['autoInstall',false],['autoCacheCleanup',enabled],['lastAutoCacheCleanup',String(last)]]);
 const timers=[];
 const context=vm.createContext({ZoteroMCPRuntimeCore:{},ZoteroMCPCache:{clean,inspect},
  Zotero:{Prefs:{get:key=>prefs.get(key.replace('extensions.zotero-codex.','')),set:(key,value)=>prefs.set(key.replace('extensions.zotero-codex.',''),value)},File:{pathToFile:()=>{}}},
  PathUtils:{join},Services:{dirsvc:{get:()=>({path:'/profile'})}},
  Components:{interfaces:{nsIFile:{},nsITimer:{TYPE_ONE_SHOT:0}},classes:{'@mozilla.org/timer;1':{createInstance:()=>({cancel(){this.cancelled=true;},initWithCallback(callback,delay){this.callback=callback;this.delay=delay;timers.push(this);}})}}}});
 vm.runInContext(await fs.readFile(new URL('../addon/content/runtime.js',import.meta.url),'utf8'),context);
 const runtime=context.ZoteroMCPRuntime;runtime.start({version:'0.8.3',connection:'/connection'});
 return {runtime,prefs,timers,async fire(){const timer=timers.at(-1);assert.ok(!timer.cancelled);timer.callback();await new Promise(r=>setImmediate(r));}};
}
test('automatic cleanup defaults off, persists toggle, runs same cleaner and records timestamp',async()=>{
 let calls=0;const h=await autoRuntime({clean:async()=>{calls++;return {remaining:{skipped:0},failed:0};}});
 assert.equal(h.timers.length,0);assert.equal(h.runtime.state().autoCacheCleanup,false);
 h.runtime.setAutoCacheCleanup(true);assert.equal(h.prefs.get('autoCacheCleanup'),true);assert.equal(h.timers.at(-1).delay,1000);
 await h.fire();assert.equal(calls,1);assert.ok(h.runtime.state().lastAutoCacheCleanup>0);assert.equal(typeof h.prefs.get('lastAutoCacheCleanup'),'string');
 await h.fire();assert.equal(calls,1);
 h.runtime.setAutoCacheCleanup(false);assert.equal(h.timers.at(-1).cancelled,true);assert.equal(h.prefs.get('autoCacheCleanup'),false);
});
test('restart respects persisted daily interval and shutdown cancels scheduling',async()=>{
 let calls=0;const h=await autoRuntime({enabled:true,last:Date.now(),clean:async()=>{calls++;}});
 assert.equal(h.timers.at(-1).delay,60000);await h.fire();assert.equal(calls,0);
 await h.runtime.stop();assert.equal(h.timers.at(-1).cancelled,true);
});
test('automatic cleanup defers while manual maintenance is active',async()=>{
 let release,calls=0;const h=await autoRuntime({enabled:true,inspect:()=>new Promise(r=>{release=r;}),clean:async()=>{calls++;return {remaining:{skipped:0},failed:0};}});
 const pending=h.runtime.inspectCache();await h.fire();assert.equal(calls,0);assert.equal(h.timers.at(-1).delay,60000);
 release({bytes:104857600,candidates:[]});await pending;await h.fire();release({bytes:104857600,candidates:[]});await new Promise(r=>setImmediate(r));assert.equal(calls,1);await h.runtime.stop();
});
test('automatic failure stays local, retries later and does not claim a successful timestamp',async()=>{
 const h=await autoRuntime({enabled:true,clean:async()=>{throw new Error('Cannot read cache');}});
 await h.fire();assert.equal(h.runtime.state().autoCacheError,'Cannot read cache');assert.equal(h.runtime.state().lastAutoCacheCleanup,0);assert.equal(h.timers.at(-1).delay,3600000);await h.runtime.stop();
});
test('disabling during automatic cleanup allows completion without scheduling another run',async()=>{
 let release;const h=await autoRuntime({enabled:true,clean:()=>new Promise(r=>{release=r;})});
 await h.fire();h.runtime.setAutoCacheCleanup(false);release({remaining:{skipped:0},failed:0});await new Promise(r=>setImmediate(r));
 assert.equal(h.runtime.state().autoCacheCleanup,false);assert.equal(h.timers.length,1);assert.equal(h.runtime.state().busy,false);
});
test('threshold counts eligible cache only, boundary is inclusive, checks below threshold are persisted',async()=>{
 let calls=0,scans=0,bytes=104857599;
 const h=await autoRuntime({enabled:true,inspect:async()=>{scans++;return {bytes,retainedBytes:999999999,recentCount:5,skipped:0,candidates:[]};},clean:async()=>{calls++;return {remaining:{skipped:0},failed:0};}});
 await h.fire();assert.equal(calls,0);assert.ok(h.runtime.state().lastAutoCacheCheck>0);assert.equal(h.runtime.state().lastAutoCacheCleanup,0);
 await h.fire();assert.equal(scans,1);
 h.prefs.set('lastAutoCacheCheck',String(Date.now()-2*86400000));bytes=104857600;
 await h.fire();assert.equal(calls,1);await h.runtime.stop();
});
test('all cycle options wait until due, invalid policies never replace saved values',async()=>{
 for(const days of [1,7,30]) {
  let scans=0;const h=await autoRuntime({enabled:true,inspect:async()=>{scans++;return {bytes:0,skipped:0,candidates:[]};}});
  h.runtime.setCachePolicy(100,days);
  h.prefs.set('lastAutoCacheCheck',String(Date.now()-(days*86400000-3600000)));
  await h.fire();assert.equal(scans,0);
  h.prefs.set('lastAutoCacheCheck',String(Date.now()-(days*86400000+1000)));
  await h.fire();assert.equal(scans,1);
  for(const pair of [[-1,1],[1.5,7],[NaN,1],[102401,1],[1,2]])assert.throws(()=>h.runtime.setCachePolicy(...pair));
  assert.equal(h.runtime.state().autoCacheIntervalDays,days);await h.runtime.stop();
 }
});
test('zero threshold allows scheduled cleanup of tiny caches and locks maintenance through inspection',async()=>{
 let release,calls=0;const h=await autoRuntime({enabled:true,inspect:()=>new Promise(r=>{release=r;}),clean:async()=>{calls++;return {remaining:{skipped:0},failed:0};}});
 h.runtime.setCachePolicy(0,7);await h.fire();
 await assert.rejects(()=>h.runtime.clearCache(),/正在处理/);assert.throws(()=>h.runtime.setCachePolicy(100,1),/正在处理/);
 release({bytes:3,candidates:[]});await new Promise(r=>setImmediate(r));assert.equal(calls,1);await h.runtime.stop();
});
test('disabling during threshold scan cancels deletion',async()=>{
 let release,calls=0;const h=await autoRuntime({enabled:true,inspect:()=>new Promise(r=>{release=r;}),clean:async()=>{calls++;}});
 await h.fire();h.runtime.setAutoCacheCleanup(false);release({bytes:999999999,skipped:0,candidates:[]});await new Promise(r=>setImmediate(r));
 assert.equal(calls,0);assert.equal(h.runtime.state().lastAutoCacheCleanup,0);assert.equal(h.runtime.state().busy,false);
});
