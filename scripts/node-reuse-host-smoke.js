// This harness and the intentionally failing service ZIP exist only in an
// isolated profile. No production download endpoint or system binary is changed.
(async()=>{
  const result={version:'0.8.3',checks:[]};
  const check=(name,pass)=>{result.checks.push({name,pass:Boolean(pass)});if(!pass)throw new Error(name);};
  const request=Zotero.HTTP.request,download=Zotero.HTTP.download;
  const downloads=[];let rejectSystem=false;
  try{
    const env=Components.classes['@mozilla.org/process/environment;1'].getService(Components.interfaces.nsIEnvironment);
    if(Zotero.DataDirectory.dir!==PathUtils.join(base,'data')||env.get('CODEX_HOME')!==PathUtils.join(base,'codex'))throw new Error('isolated profile required');
    const pref='extensions.zotero-codex.',api=Zotero.ZoteroCodex.settings;
    const external=PathUtils.join(base,'external','node');
    const originalInfo=await IOUtils.stat(external);
    Zotero.Prefs.set(pref+'externalNodePath',external,true);
    Zotero.Prefs.set(pref+'preferSystemNode',true,true);
    const manifest=JSON.parse(await IOUtils.readUTF8(PathUtils.join(base,'runtime-manifest.json')));
    const rejected=JSON.parse(await IOUtils.readUTF8(PathUtils.join(base,'rejected-manifest.json')));
    const key=Object.keys(manifest.assets)[0];
    Zotero.HTTP.request=async function(method,url,options){
      if(url.endsWith('/v0.8.3/runtime-manifest.json'))return {status:200,response:rejectSystem?rejected:manifest};
      return request.call(this,method,url,options);
    };
    Zotero.HTTP.download=async function(url,path,options){
      const kind=url.endsWith('/'+manifest.services[key].name)?'service':url.endsWith('/'+manifest.assets[key].name)?'full':null;
      if(!kind)return download.call(this,url,path,options);
      downloads.push(kind);
      const source=kind==='service'&&rejectSystem?'reject-system.zip':manifest[kind==='service'?'services':'assets'][key].name;
      await IOUtils.copy(PathUtils.join(base,source),path);
      options.onProgress((await IOUtils.stat(path)).size);
      return {status:200};
    };
    await api.runtime.ensure();let state=api.runtime.state();
    check('system-node-selected-and-verified',state.ready&&state.nodeSource==='system'&&state.nodePath.endsWith('/external/node'));
    check('only-service-package-downloaded',downloads.join(',')==='service');
    check('service-package-does-not-contain-node',!await IOUtils.exists(PathUtils.join(state.directory,'node')));
    check('service-package-is-smaller',manifest.services[key].size<manifest.assets[key].size);
    await api.runtime.connect();
    const configPath=PathUtils.join(base,'codex','config.toml');
    check('codex-config-uses-detected-node',(await IOUtils.readUTF8(configPath)).includes('/external/node'));
    await api.runtime.ensure();check('healthy-install-needs-no-network',downloads.length===1);
    // Force a new install whose dependency check rejects this external runtime.
    await IOUtils.remove(PathUtils.join(state.directory,'runtime.json'));
    rejectSystem=true;
    await api.runtime.ensure();state=api.runtime.state();
    check('failed-system-runtime-falls-back-to-full-package',downloads.join(',')==='service,service,full'&&state.ready&&state.nodeSource==='bundled');
    check('fallback-updates-owned-codex-config',!(await IOUtils.readUTF8(configPath)).includes('/external/node'));
    const fallback=state.nodePath;
    rejectSystem=false;
    await api.runtime.ensure();state=api.runtime.state();
    check('healthy-system-node-can-be-reused-again',state.nodeSource==='system'&&downloads.length===3);
    check('bundled-node-remains-available-for-fallback',await IOUtils.exists(fallback));
    Zotero.Prefs.set(pref+'preferSystemNode',false,true);
    await api.runtime.ensure();state=api.runtime.state();
    check('manual-bundled-mode-reuses-existing-node-offline',state.nodeSource==='bundled'&&state.nodePath===fallback&&downloads.length===3);
    const afterInfo=await IOUtils.stat(external);
    check('external-node-is-never-modified',originalInfo.size===afterInfo.size&&originalInfo.lastModified===afterInfo.lastModified);
    const report=await api.diagnose();check('zotero-bridge-and-api-remain-ready',report.bridge.ok&&report.nativeAPI.ok);
    Zotero.Prefs.set(pref+'preferSystemNode',true,true);await api.runtime.ensure();
    const win=Zotero.Utilities.Internal.openPreferences('zotero-codex-preferences');
    for(let i=0;i<100&&!win.document.getElementById('zc-node-source');i++)await Zotero.Promise.delay(100);
    await Zotero.Promise.delay(600);
    check('settings-show-verified-node-source',win.document.getElementById('zc-node-source').textContent.includes('复用本机')&&win.document.getElementById('zc-prefer-system').checked);
    const bitmap=await win.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(0,0,win.innerWidth,win.innerHeight),1,'white');
    const canvas=win.document.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));await IOUtils.write(PathUtils.join(base,'node-reuse-preferences.png'),new Uint8Array(await blob.arrayBuffer()));
  }catch(error){result.error=String(error);result.stack=error.stack;}
  finally{Zotero.HTTP.request=request;Zotero.HTTP.download=download;}
  await IOUtils.writeUTF8(PathUtils.join(base,'result.json'),JSON.stringify(result,null,2));
})();
