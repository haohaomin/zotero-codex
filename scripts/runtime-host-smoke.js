// Real Gecko extraction/process/configuration tests in an isolated Zotero profile.
(async () => {
  const result={version:'0.8.3',checks:[]};
  const check=(name,pass)=>{result.checks.push({name,pass:Boolean(pass)});if(!pass)throw new Error(name);};
  const waitFor=async fn=>{for(let i=0;i<900;i++){if(await fn())return;await Zotero.Promise.delay(100);}throw new Error('wait timed out');};
  const request=Zotero.HTTP.request,download=Zotero.HTTP.download;
  let downloads=0, badHash=true;
  try {
    const env=Components.classes['@mozilla.org/process/environment;1'].getService(Components.interfaces.nsIEnvironment);
    if(Zotero.DataDirectory.dir!==PathUtils.join(base,'data')||env.get('CODEX_HOME')!==PathUtils.join(base,'codex')) throw new Error('isolated profile and CODEX_HOME required');
    const configPath=PathUtils.join(base,'codex','config.toml');
    await IOUtils.makeDirectory(PathUtils.parent(configPath),{createAncestors:true});
    await IOUtils.writeUTF8(configPath,'# fixture comment\nmodel="preserve-model"\n[mcp_servers.other]\ncommand="preserve-command"\n');
    const part=JSON.parse(await IOUtils.readUTF8(PathUtils.join(base,'runtime-manifest.json')));
    const key=Object.keys(part.assets)[0],assets=[part.assets[key],part.services[key]];
    Zotero.HTTP.request=async function(method,url,options){
      if(url.endsWith('/v0.8.3/runtime-manifest.json')){
        const manifest=JSON.parse(JSON.stringify(part));if(badHash)for(const group of ['assets','services'])manifest[group][key].sha256='0'.repeat(64);
        return {status:200,response:manifest};
      }
      return request.call(this,method,url,options);
    };
    Zotero.HTTP.download=async function(url,path,options){
      const asset=assets.find(a=>url.endsWith('/'+a.name));
      if(asset){
        downloads++;await IOUtils.copy(PathUtils.join(base,asset.name),path);options.onProgress(asset.size,asset.size);return {status:200};
      }
      return download.call(this,url,path,options);
    };
    const api=Zotero.ZoteroCodex.settings;
    Zotero.Prefs.set('extensions.zotero-codex.preferSystemNode',false,true);
    await api.runtime.ensure().catch(()=>{});
    check('checksum-mismatch-rejected-without-configuration',api.runtime.state().phase==='error'&&!api.runtime.state().ready&&!(await IOUtils.readUTF8(configPath)).includes('mcp_servers.zotero'));
    badHash=false;
    await api.runtime.ensure();
    check('retry-extracts-and-executes-bundled-node',api.runtime.state().ready&&downloads===2);
    check('preparation-does-not-reconfigure-client',!(await IOUtils.readUTF8(configPath)).includes('mcp_servers.zotero'));
    Zotero.Prefs.set('httpServer.localAPI.enabled',false);
    const win=Zotero.Utilities.Internal.openPreferences('zotero-codex-preferences');
    await waitFor(()=>win.document.getElementById('zc-connect'));
    win.document.getElementById('zc-connect').click();
    await waitFor(()=>api.runtime.state().configured);
    const config=await IOUtils.readUTF8(configPath);
    check('one-click-connection-preserves-existing-config',config.includes('preserve-model')&&config.includes('preserve-command')&&config.includes('# fixture comment')&&config.includes('mcp_servers.zotero'));
    check('one-click-enables-native-api-and-sets-managed-paths',api.state().nativeAPIEnabled&&api.state().nodePath.includes('zotero-codex-runtime')&&api.state().serverPath.endsWith('mcp/server.mjs'));
    check('configuration-backup-created',(await IOUtils.getChildren(PathUtils.parent(configPath))).some(p=>p.endsWith('.bak')));
    await api.runtime.ensure();check('already-installed-component-reused-without-network',downloads===2&&api.runtime.state().configured);
    const directory=api.runtime.state().directory;
    await IOUtils.remove(PathUtils.join(directory,'runtime','verify.mjs'));
    await api.runtime.ensure();
    check('damaged-install-repaired-in-fresh-directory',downloads===3&&api.runtime.state().ready&&api.runtime.state().directory!==directory);
    check('managed-configuration-follows-repair',(await IOUtils.readUTF8(configPath)).includes(api.runtime.state().directory));
    await api.runtime.ensure();check('repair-directory-reused',downloads===3);
    const report=await api.diagnose();check('bridge-and-api-still-work',report.bridge.ok&&report.nativeAPI.ok);
    // UI capture is for the isolated test window only.
    await Zotero.Promise.delay(600);
    win.Zotero_Preferences.content.scrollTop=0;
    const bitmap=await win.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(0,0,win.innerWidth,win.innerHeight),1,'white');
    const canvas=win.document.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));await IOUtils.write(PathUtils.join(base,'runtime-preferences.png'),new Uint8Array(await blob.arrayBuffer()));
    result.directory=api.runtime.state().directory;
  }catch(error){result.error=String(error);result.stack=error.stack;}
  finally{Zotero.HTTP.request=request;Zotero.HTTP.download=download;}
  await IOUtils.writeUTF8(PathUtils.join(base,'result.json'),JSON.stringify(result,null,2));
})();
