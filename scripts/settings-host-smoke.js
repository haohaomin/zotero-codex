// Packaged only into an isolated test profile by prepare-host-smoke.py.
(async () => {
  const result = {version:'0.8.1', stage:'preferences', checks:[]};
  const check = (name, pass) => { result.checks.push({name,pass:Boolean(pass)}); if (!pass) throw new Error(name); };
  const waitFor = async fn => { for (let i=0;i<150;i++) { if (await fn()) return; await Zotero.Promise.delay(100); } throw new Error('wait timed out'); };
  try {
    if (Zotero.DataDirectory.dir !== PathUtils.join(base,'data')) throw new Error('isolated profile required');
    await Zotero.Promise.delay(2000);
    const plugin = Zotero.ZoteroCodex, settings = plugin.settings;
    const id = 'zotero-codex-preferences';
    check('registered-native-preference-pane', Zotero.PreferencePanes.pluginPanes.some(p=>p.id===id && p.rawLabel==='Zotero MCP'));
    const win = Zotero.Utilities.Internal.openPreferences(id);
    await waitFor(()=>win.document.getElementById('zc-version')?.textContent.includes('0.8.1'));
    const el = suffix=>win.document.getElementById('zc-'+suffix);
    const ui = win.Zotero_Preferences.getScope(id).ZoteroMCPPreferences;
    check('pane-loads-with-status-and-defaults', el('bridge').textContent==='已就绪' && el('auto-text').checked && el('auto-region').checked);
    check('advanced-paths-hidden-until-requested', !el('connection-details').open && !el('developer-mode').checked && el('developer-fields').hidden);
    check('advanced-section-collapsed-by-default', !el('advanced').open);
    check('idle-runtime-is-not-shown-as-checking', el('runtime-badge').textContent==='待准备' && !el('node-source').textContent.includes('正在'));
    check('prepare-precedes-connect', el('install').nextElementSibling===el('connect'));
    check('idle-prompts-preparation-and-blocks-connection', el('install').textContent==='准备组件' && !el('install').disabled && el('install').classList.contains('zc-primary') && el('connect').disabled);
    const runtimeState=settings.runtime.state;
    try {
      for(const [phase,ready,configured,label,tone] of [
        ['downloading',false,false,'准备中','idle'],
        ['ready',true,false,'组件已就绪','ready'],
        ['ready',true,true,'Codex 已配置','ready'],
        ['error',false,false,'需要处理','error'],
      ]) {
        settings.runtime.state=()=>({...runtimeState(),phase,ready,configured});ui.refreshRuntime();
        check('runtime-badge-'+phase+'-'+configured,el('runtime-badge').textContent===label&&el('runtime-badge').dataset.tone===tone);
        check('runtime-actions-'+phase+'-'+configured,
          el('install').textContent===(phase==='downloading'?'准备中…':phase==='error'?'重试':'重新检查组件') &&
          el('install').disabled===(phase==='downloading') && el('connect').disabled===(phase!=='ready') &&
          el('connect').classList.contains('zc-primary')===(phase==='ready'));
      }
    } finally {settings.runtime.state=runtimeState;ui.refreshRuntime();}
    const originalConnect=settings.runtime.connect, originalEnsure=settings.runtime.ensure;
    let release, calls=0;
    try {
      settings.runtime.state=()=>({...runtimeState(),phase:'ready',ready:true,configured:false});
      settings.runtime.connect=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
      ui.refreshRuntime();el('connect').click();ui.refreshRuntime();el('connect').click();
      check('refresh-keeps-both-actions-locked-during-connect',calls===1 && el('connect').disabled && el('install').disabled && el('connect').textContent==='连接中…');
      release();await waitFor(()=>!ui.pendingActions.has('connect'));
      check('connect-completion-restores-actions',!el('connect').disabled&&!el('install').disabled);
      let failed=false;
      settings.runtime.state=()=>({...runtimeState(),phase:failed?'error':'idle',ready:false});
      settings.runtime.ensure=async()=>{failed=true;throw new Error('准备失败测试');};
      ui.refreshRuntime();el('install').click();await waitFor(()=>!ui.pendingActions.has('install'));
      check('failed-preparation-finally-keeps-connect-disabled',el('connect').disabled&&!el('install').disabled&&el('install').textContent==='重试');
    } finally {
      settings.runtime.connect=originalConnect;settings.runtime.ensure=originalEnsure;settings.runtime.state=runtimeState;
      ui.refreshRuntime();
    }
    const toggle = (suffix, value) => { el(suffix).checked=value; el(suffix).dispatchEvent(new win.Event('change',{bubbles:true})); };
    toggle('auto-text',false);toggle('auto-region',false);
    check('ui-toggles-write-persistent-preferences', !settings.state().autoText && !settings.state().autoRegion && Zotero.Prefs.get('extensions.zotero-codex.autoRegion',true)===false);
    const paper = new Zotero.Item('journalArticle');paper.setField('title','Settings fixture');await paper.saveTx();
    const attachment = await Zotero.Attachments.importFromFile({file:PathUtils.join(base,'sample.pdf'),parentItemID:paper.id});
    const reader = await Zotero.Reader.open(attachment.id);await reader._initPromise;
    const selection = {text:'Settings text selection',pageLabel:'1',position:{pageIndex:0,rects:[[10,10,80,30]]}};
    let button;
    const select = ()=>Zotero.Reader._dispatchEvent({type:'renderTextSelectionPopup',reader,doc:win.document,params:{annotation:selection},append:b=>{button=b;}});
    select();await Zotero.Promise.delay(100);
    check('disabled-text-capture-keeps-manual-button', settings.state().snapshotCount===0 && button.textContent==='添加到 MCP');
    button.click();await waitFor(()=>settings.state().snapshotCount===1);
    check('manual-text-capture-works-when-auto-disabled', (await plugin.dispatch('zotero_get_selection',{readerID:String(reader.tabID)})).selection.text===selection.text);
    el('clear').click();await waitFor(()=>settings.state().snapshotCount===0);
    check('clear-context-button', el('feedback').textContent.includes('已清除'));
    toggle('auto-text',true);select();await waitFor(()=>settings.state().snapshotCount===1);
    toggle('auto-text',false);
    check('disabling-clears-existing-auto-text', settings.state().snapshotCount===0);
    toggle('auto-text',true);toggle('auto-region',true);
    const lastRequest = settings.state().lastRequestAt;
    const report = await ui.check();
    result.diagnostics = report;
    check('real-loopback-diagnostics-pass', report.bridge.ok && report.nativeAPI.ok && report.connectionFilePresent);
    check('diagnostics-do-not-claim-client-connected', settings.state().lastRequestAt===lastRequest);
    Zotero.Prefs.set('httpServer.localAPI.enabled',false);
    const disabledReport=await ui.check();
    check('disabled-api-reported-separately', disabledReport.bridge.ok && disabledReport.nativeAPI.status===403 && el('native').textContent.includes('未开启'));
    Zotero.Prefs.set('httpServer.localAPI.enabled',true);
    const config = JSON.parse(await IOUtils.readUTF8(PathUtils.join(base,'connection.json')));
    await Zotero.HTTP.request('POST',config.url,{headers:{'Zotero-Allowed-Request':'true','Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify({name:'zotero_status',arguments:{},client:{version:'0.8.1',nodePath:'node',serverPath:PathUtils.join(base,'fixture-server.mjs')}})});
    await IOUtils.writeUTF8(PathUtils.join(base,'fixture-server.mjs'),'// Synthetic service path for configuration copy test');
    ui.refresh();
    check('authenticated-client-runtime-detected', settings.state().lastRequestAt && el('server-path').value.endsWith('fixture-server.mjs') && el('server-version').textContent==='0.8.1');
    // Test the clipboard action without changing the real user's clipboard.
    const copy = Zotero.Utilities.Internal.copyTextToClipboard;
    let copied;
    Zotero.Utilities.Internal.copyTextToClipboard=text=>{copied=text;};
    try {
      el('copy-config').click();await waitFor(()=>Boolean(copied));
      const value=JSON.parse(copied);
      check('copy-config-button-with-real-paths', value.mcpServers.zotero.args[0]===PathUtils.join(base,'fixture-server.mjs') && !copied.includes(config.token));
      toggle('developer-mode',true);
      check('developer-mode-explains-export-only', !el('developer-fields').hidden && el('developer-fields').textContent.includes('不会修改') && el('copy-config').textContent==='复制自定义 MCP 配置');
      const customPath=PathUtils.join(base,'custom-server.mjs');
      await IOUtils.writeUTF8(customPath,'// Synthetic custom service');
      el('server-path').value=customPath;
      copied=null;el('copy-config').click();await waitFor(()=>Boolean(copied));
      check('custom-export-does-not-change-automatic-paths', JSON.parse(copied).mcpServers.zotero.args[0]===customPath && settings.state().serverPath===value.mcpServers.zotero.args[0] && el('server-detail').textContent===value.mcpServers.zotero.args[0]);
      el('server-path').value=PathUtils.join(base,'missing-server.mjs');
      el('config-feedback').textContent='';copied=null;el('copy-config').click();await waitFor(()=>Boolean(el('config-feedback').textContent));
      check('invalid-custom-path-reports-error-next-to-export', !copied && el('config-feedback').textContent.includes('完整路径'));
      toggle('developer-mode',false);
      copied=null;el('copy-config').click();await waitFor(()=>Boolean(copied));
      check('disabling-developer-mode-restores-automatic-export', el('developer-fields').hidden && el('server-path').value===value.mcpServers.zotero.args[0] && JSON.parse(copied).mcpServers.zotero.args[0]===value.mcpServers.zotero.args[0]);
      copied=null;el('copy-diagnostics').click();await waitFor(()=>Boolean(copied));
      check('copy-diagnostics-is-redacted', JSON.parse(copied).bridge.ok && !copied.includes(config.token) && !copied.includes(base) && !copied.includes('Settings fixture'));
    } finally { Zotero.Utilities.Internal.copyTextToClipboard=copy; }
    win.focus();await win.Zotero_Preferences.navigateToPane(id);
    await Zotero.Promise.delay(300);
    const rect=el('settings').getBoundingClientRect();
    result.layout={width:rect.width,height:rect.height,scrollWidth:el('settings').scrollWidth,windowWidth:win.innerWidth,windowHeight:win.innerHeight};
    // Render both parts of the isolated preferences pane for visual verification.
    try {
      for (const [name,target] of [['preferences',null],['preferences-reading','reading-title'],['preferences-bottom','client-title'],['preferences-developer','advanced'],['preferences-narrow',null]]) {
        if(name==='preferences-developer'){el('advanced').open=true;el('connection-details').open=true;toggle('developer-mode',true);}
        if(name==='preferences-narrow'){
          el('settings').style.width='360px';
          ui.feedback('较长的状态提示应该在刷新按钮右边自动换行，不会超出设置页。');
          check('narrow-layout-does-not-overflow', el('settings').scrollWidth<=362);
        }
        if(target) el(target).scrollIntoView({block:'start'});
        else win.Zotero_Preferences.content.scrollTop=0;
        await Zotero.Promise.delay(100);
        const bitmap=await win.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(0,0,win.innerWidth,win.innerHeight),1,'white');
        const canvas=win.document.createElementNS('http://www.w3.org/1999/xhtml','canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        await IOUtils.write(PathUtils.join(base,name+'.png'),new Uint8Array(await blob.arrayBuffer()));
      }
      el('settings').style.width='';
      win.Zotero_Preferences.content.scrollTop=0;
      result.screenshot=true;
    } catch { result.screenshot=false; }
    await IOUtils.writeUTF8(PathUtils.join(base,'settings-layout.json'),JSON.stringify({width:rect.width,height:rect.height,windowWidth:win.innerWidth,windowHeight:win.innerHeight}));
    check('native-pane-visible-without-horizontal-overflow', rect.width>300 && el('settings').scrollWidth <= Math.ceil(rect.width)+2);
  } catch(error) { result.error=String(error);result.stack=error.stack; }
  await IOUtils.writeUTF8(PathUtils.join(base,'result.json'),JSON.stringify(result,null,2));
})();
