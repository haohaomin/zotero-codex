var ZoteroMCPRuntime = (() => {
  const Core = ZoteroMCPRuntimeCore;
  const pref = 'extensions.zotero-codex.';
  let version, connection, root, key, task, connecting, maintenance, disposed = false, cancelDownload;
  let cacheTimer, autoCacheError = '';
  const cacheDay = 24 * 60 * 60 * 1000;
  function cachePolicy() {
    const mb = Zotero.Prefs.get(pref+'autoCacheThresholdMB',true);
    const days = Zotero.Prefs.get(pref+'autoCacheIntervalDays',true);
    return {autoCacheThresholdMB:Number.isInteger(mb) && mb >= 0 && mb <= 102400 ? mb : 100,
      autoCacheIntervalDays:[1,7,30].includes(days) ? days : 1};
  }
  const processes = new Set();
  let status = {phase:'idle', message:'正在检查运行组件…', ready:false, configured:false};
  const state = () => ({...status, busy:Boolean(task || connecting || maintenance), automatic:Zotero.Prefs.get(pref+'autoInstall',true) !== false, preferSystem:Zotero.Prefs.get(pref+'preferSystemNode',true) !== false,
    autoCacheCleanup:Zotero.Prefs.get(pref+'autoCacheCleanup',true) === true,
    ...cachePolicy(), lastAutoCacheCheck:Number(Zotero.Prefs.get(pref+'lastAutoCacheCheck',true)) || 0,
    lastAutoCacheCleanup:Number(Zotero.Prefs.get(pref+'lastAutoCacheCleanup',true)) || 0, autoCacheError});
  const notify = patch => { status = {...status,...patch}; };
  const active = () => { if (disposed) throw new Error('安装已取消'); };
  const file = path => Zotero.File.pathToFile(path);
  const cacheFS = {
    async stat(path) {
      active();
      const entry = file(path);
      if (!entry.exists()) return null;
      if (entry.isSymlink()) return {type:'symlink'};
      return {type:entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', size:entry.isFile() ? entry.fileSize : 0, mtime:entry.lastModifiedTime};
    },
    children:path=>IOUtils.getChildren(path),
    basename:path=>PathUtils.filename(path),
    async remove(path) { active(); file(path).remove(false); },
  };
  function cacheOperation(clean = false, thresholdMB = null) {
    active();
    if (task || connecting || maintenance) return Promise.reject(new Error('运行组件或缓存正在处理，请完成后重试'));
    maintenance = (async()=>{
      if (thresholdMB !== null) {
        const report = await ZoteroMCPCache.inspect(cacheFS,root);
        if (disposed || !state().autoCacheCleanup || report.bytes < thresholdMB * 1048576) return {belowThreshold:true,remaining:report};
      }
      return clean ? ZoteroMCPCache.clean(cacheFS,root) : ZoteroMCPCache.inspect(cacheFS,root);
    })()
      .then(report=>{
        // Paths are internal to the cleaner, never accepted from settings.
        const publicReport = value=>{ const {candidates,...rest}=value; return rest; };
        return clean ? {...report,remaining:publicReport(report.remaining)} : publicReport(report);
      }).finally(()=>{maintenance=null;});
    return maintenance;
  }
  function scheduleCacheCleanup(delay = 60000) {
    cacheTimer?.cancel(); cacheTimer = null;
    if (disposed || !state().autoCacheCleanup) return;
    cacheTimer = Components.classes['@mozilla.org/timer;1'].createInstance(Components.interfaces.nsITimer);
    cacheTimer.initWithCallback(()=>{ cacheTimer = null; void automaticCacheCleanup(); },delay,Components.interfaces.nsITimer.TYPE_ONE_SHOT);
  }
  async function automaticCacheCleanup() {
    if (disposed || !state().autoCacheCleanup) return;
    if (task || connecting || maintenance) { scheduleCacheCleanup(); return; }
    const settings = state(), last = settings.lastAutoCacheCheck || settings.lastAutoCacheCleanup, now = Date.now();
    if (last > 0 && now >= last && now - last < cacheDay * settings.autoCacheIntervalDays) { scheduleCacheCleanup(3600000); return; }
    try {
      const report = await cacheOperation(true,settings.autoCacheThresholdMB);
      if (disposed) return;
      autoCacheError = report.failed || report.remaining.skipped ? '部分缓存未能清理，可手动检查后重试。' : '';
      // String storage avoids the 32-bit integer limit of Firefox preferences.
      Zotero.Prefs.set(pref+'lastAutoCacheCheck',String(Date.now()),true);
      if (!report.belowThreshold) Zotero.Prefs.set(pref+'lastAutoCacheCleanup',String(Date.now()),true);
    } catch (error) { if (!disposed) autoCacheError = error.message || '自动清理失败，可手动重试。'; }
    finally { scheduleCacheCleanup(3600000); }
  }
  function setAutoCacheCleanup(value) {
    Zotero.Prefs.set(pref+'autoCacheCleanup',Boolean(value),true);
    autoCacheError = '';
    scheduleCacheCleanup(1000);
  }
  function setCachePolicy(thresholdMB, intervalDays) {
    if (!Number.isInteger(thresholdMB) || thresholdMB < 0 || thresholdMB > 102400 || ![1,7,30].includes(intervalDays)) throw new Error('请输入 0–102400 的整数 MB，并选择有效周期');
    if (maintenance) throw new Error('缓存正在处理，请完成后再修改');
    Zotero.Prefs.set(pref+'autoCacheThresholdMB',thresholdMB,true);
    Zotero.Prefs.set(pref+'autoCacheIntervalDays',intervalDays,true);
    autoCacheError = '';
    scheduleCacheCleanup(1000);
  }
  const nodePath = directory => PathUtils.join(directory,key.startsWith('win32') ? 'node.exe' : 'node');
  function run(node, args, timeout = 60000) {
    active();
    return new Promise((resolve,reject) => {
      const process = Components.classes['@mozilla.org/process/util;1'].createInstance(Components.interfaces.nsIProcess);
      const win = Zotero.getMainWindow();
      let timer;
      const finish = error => { win.clearTimeout(timer); processes.delete(process); error ? reject(error) : resolve(); };
      try {
        process.init(file(node)); processes.add(process);
        process.runwAsync(args,args.length,{observe(subject,topic) {
          finish(topic === 'process-finished' && process.exitValue === 0 ? null : new Error('运行组件检查失败，请点击重试；若仍失败请查看诊断。'));
        }},false);
        timer = win.setTimeout(()=>{ try { process.kill(); } catch {} finish(new Error('运行组件检查超时，请重试。')); },timeout);
      } catch(error) { finish(error); }
    });
  }
  async function hash(path) {
    const stream = Components.classes['@mozilla.org/network/file-input-stream;1'].createInstance(Components.interfaces.nsIFileInputStream);
    stream.init(file(path),0x01,0,0);
    try {
      const crypto = Components.classes['@mozilla.org/security/hash;1'].createInstance(Components.interfaces.nsICryptoHash);
      crypto.init(crypto.SHA256); crypto.updateFromStream(stream,0xffffffff);
      return Array.from(crypto.finish(false),c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
    } finally { stream.close(); }
  }
  async function extract(archive, directory) {
    const zip = Components.classes['@mozilla.org/libjar/zip-reader;1'].createInstance(Components.interfaces.nsIZipReader);
    zip.open(file(archive));
    try {
      const names = [], paths = new Set();
      const entries = zip.findEntries(null); let total = 0;
      while (entries.hasMore()) {
        const name = entries.getNext(), parts = Core.entry(name), entry = zip.getEntry(name);
        const normalized = parts.join('/').toLowerCase();
        if (paths.has(normalized)) throw new Error('运行包包含重复路径');
        paths.add(normalized);
        total += entry.realSize;
        if (total > 900*1024*1024 || names.length > 25000) throw new Error('运行包大小异常');
        names.push({name,parts,directory:entry.isDirectory});
      }
      for (let i=0;i<names.length;i++) {
        active();
        const entry = names[i], target = PathUtils.join(directory,...entry.parts);
        await IOUtils.makeDirectory(entry.directory ? target : PathUtils.parent(target),{createAncestors:true,permissions:0o700});
        if (!entry.directory) {
          zip.extract(entry.name,file(target));
          if (file(target).isSymlink()) throw new Error('运行包不能包含符号链接');
          await IOUtils.setPermissions(target,0o600);
        }
        if (i % 100 === 0) await Zotero.Promise.delay(0);
      }
    } finally { zip.close(); }
  }
  async function configure(directory, mode) {
    const resultPath = PathUtils.join(root,'configure-'+Services.uuid.generateUUID().toString().replace(/[{}]/g,'')+'.json');
    try {
      let failure;
      try { await run(status.nodePath,[PathUtils.join(directory,'runtime','configure.mjs'),'--node',status.nodePath,'--server',PathUtils.join(directory,'mcp','server.mjs'),'--connection',connection,'--root',root,'--mode',mode,'--result',resultPath]); }
      catch(error) { failure=error; }
      active();
      if (!(await IOUtils.exists(resultPath))) throw failure || new Error('无法配置 Codex');
      const result = JSON.parse(await IOUtils.readUTF8(resultPath));
      if (!result.ok) throw new Error(result.error);
      return result;
    } finally { await IOUtils.remove(resultPath,{ignoreAbsent:true}); }
  }
  async function probe(candidate, source) {
    if (!candidate || !PathUtils.isAbsolute(candidate)) return null;
    const output = PathUtils.join(root,'probe-'+Services.uuid.generateUUID().toString().replace(/[{}]/g,'')+'.json');
    try {
      const executable = file(candidate);
      if (!executable.exists() || !executable.isFile() || !executable.isExecutable()) return null;
      const code = "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({version:process.versions.node,platform:process.platform+'-'+process.arch,path:process.execPath}),{mode:384})";
      await run(candidate,['-e',code,output],5000);
      active();
      const result = JSON.parse(await IOUtils.readUTF8(output));
      if (!Core.compatibleNode(result.version) || result.platform !== key || !PathUtils.isAbsolute(result.path)) return null;
      // Resolve version-manager shims once, so launching Codex doesn't depend on
      // the shell's PATH, a project .nvmrc, or a different working directory.
      return {path:source === 'system' ? result.path : candidate,version:result.version,source};
    } catch { return null; }
    finally { await IOUtils.remove(output,{ignoreAbsent:true}); }
  }
  async function systemNode() {
    if (!state().preferSystem) return null;
    const environment = Components.classes['@mozilla.org/process/environment;1'].getService(Components.interfaces.nsIEnvironment);
    const env = {};
    for (const name of ['PATH','ProgramW6432','ProgramFiles','ProgramFiles(x86)','LOCALAPPDATA','NVM_SYMLINK','NVM_HOME','NVM_DIR','VOLTA_HOME','FNM_MULTISHELL_PATH']) env[name]=environment.get(name);
    const home = Services.dirsvc.get('Home',Components.interfaces.nsIFile).path;
    const candidates = [Zotero.Prefs.get(pref+'externalNodePath',true),Zotero.Prefs.get(pref+'nodePath',true),...Core.candidates(Services.appinfo.OS,env,home,(...parts)=>PathUtils.join(...parts))];
    // GUI apps often don't inherit a shell's nvm PATH. Inspect only its known,
    // bounded installation directory; never source shell profiles or run a shell.
    const nvm = env.NVM_DIR || PathUtils.join(home,'.nvm');
    try {
      const versions = await IOUtils.getChildren(PathUtils.join(nvm,'versions','node'));
      versions.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
      for(const dir of versions.slice(0,20)) candidates.push(PathUtils.join(dir,'bin','node'));
    } catch {}
    for (const candidate of [...new Set(candidates)].slice(0,80)) {
      active();
      if (typeof candidate !== 'string' || candidate.startsWith(root)) continue;
      const result = await probe(candidate,'system');
      if (result) return result;
    }
    return null;
  }
  async function bundledNode(directory) {
    const candidates = [nodePath(directory),Zotero.Prefs.get(pref+'fallbackNodePath',true)];
    const previous = Zotero.Prefs.get(pref+'managedDirectory',true);
    if(previous && PathUtils.parent(previous) === root) candidates.push(nodePath(previous));
    try {
      const directories = (await IOUtils.getChildren(root)).filter(p=>/^\d+\.\d+\.\d+-/.test(PathUtils.filename(p)));
      directories.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
      for(const dir of directories.slice(0,20)) candidates.push(nodePath(dir));
    } catch {}
    for (const candidate of [...new Set(candidates)]) {
      if(typeof candidate !== 'string' || PathUtils.parent(PathUtils.parent(candidate)) !== root) continue;
      const result = await probe(candidate,'bundled');
      if(result) return result;
    }
    return null;
  }
  async function valid(directory, node) {
    if (!node) return false;
    try {
      const meta = JSON.parse(await IOUtils.readUTF8(PathUtils.join(directory,'runtime.json')));
      if (meta.version !== version || meta.platform !== key) return false;
      await run(node.path,[PathUtils.join(directory,'runtime','verify.mjs')]);
      return true;
    } catch { return false; }
  }
  async function download(manifest, directory, kind, candidates) {
    const asset = Core.asset(manifest,version,key,kind);
    const nonce = Services.uuid.generateUUID().toString().replace(/[{}]/g,'');
    const archive = PathUtils.join(root,`.download-${nonce}.zip`), staging = PathUtils.join(root,`.install-${nonce}`);
    try {
      await IOUtils.makeDirectory(staging,{permissions:0o700});
      notify({phase:'downloading',message:kind === 'service' ? '已找到可用 Node.js，只下载服务与依赖…' : '正在准备专用 Node.js 和服务…'});
      await Zotero.HTTP.download(asset.url,archive,{
        timeout:60000,errorDelayMax:0,cancellerReceiver:cancel=>{cancelDownload=cancel;if(disposed)cancel();},
        onProgress:bytes=>{
          if(bytes>asset.size){cancelDownload?.();return;}
          notify({message:`正在下载${kind === 'service' ? '服务与依赖' : '完整运行组件'} ${Math.min(100,Math.floor(bytes/asset.size*100))}%（${Math.ceil(bytes/1048576)} / ${Math.ceil(asset.size/1048576)} MB）`});
        },
      });
      cancelDownload=null;active();
      notify({phase:'verifying',message:'正在校验下载文件…'});
      if((await IOUtils.stat(archive)).size!==asset.size || await hash(archive)!==asset.sha256) throw new Error('运行包校验失败，未安装。请重新下载。');
      active();notify({phase:'installing',message:'正在安装并验证服务运行能力…'});
      await extract(archive,staging);
      if(kind === 'full') {
        await IOUtils.setPermissions(nodePath(staging),0o700);
        candidates=[await probe(nodePath(staging),'bundled')];
      }
      let chosen;
      for(const candidate of candidates) if(await valid(staging,candidate)){chosen=candidate;break;}
      active();
      if(!chosen) {
        if(kind === 'service') return null;
        throw new Error('运行包无法在此电脑运行，原有安装已保留。请重试或查看安装说明。');
      }
      let target=directory;
      if(await IOUtils.exists(target)) target+='-'+nonce;
      await IOUtils.move(staging,target,{noOverwrite:true});
      return {directory:target,node:kind === 'full' ? {...chosen,path:nodePath(target)} : chosen};
    } finally {
      cancelDownload=null;
      await IOUtils.remove(archive,{ignoreAbsent:true});
      await IOUtils.remove(staging,{recursive:true,ignoreAbsent:true});
    }
  }
  async function install() {
    active();key=Core.platform(Services.appinfo.OS,Services.appinfo.XPCOMABI);
    const standardDirectory=PathUtils.join(root,`${version}-${key}`);
    const savedDirectory=Zotero.Prefs.get(pref+'managedDirectory',true);
    const directory=typeof savedDirectory==='string' && PathUtils.parent(savedDirectory)===root &&
      (savedDirectory===standardDirectory || savedDirectory.startsWith(standardDirectory+'-')) ? savedDirectory : standardDirectory;
    notify({phase:'checking',message:'正在检测本机 Node.js 和运行组件…',ready:false});
    await IOUtils.makeDirectory(root,{createAncestors:true,permissions:0o700});
    const system=await systemNode(), bundled=await bundledNode(directory);
    const candidates=[system,bundled].filter(Boolean);
    let installed;
    for(const node of candidates) if(await valid(directory,node)){installed={directory,node};break;}
    if(!installed) {
      active();notify({phase:'downloading',message:'正在获取运行包信息…'});
      let manifest;
      try {
        manifest=(await Zotero.HTTP.request('GET',Core.releaseURL(version,'runtime-manifest.json'),{responseType:'json',timeout:30000})).response;
      } catch { throw new Error('无法获取运行包，请检查网络后重试。若刚更新插件，运行包可能尚未发布。'); }
      active();
      if(candidates.length) installed=await download(manifest,directory,'service',candidates);
      if(!installed) installed=await download(manifest,directory,'full',[]);
    }
    active();
    const {node}=installed;
    Zotero.Prefs.set(pref+'managedDirectory',installed.directory,true);
    Zotero.Prefs.set(pref+'nodePath',node.path,true);
    Zotero.Prefs.set(pref+'serverPath',PathUtils.join(installed.directory,'mcp','server.mjs'),true);
    Zotero.Prefs.set(pref+(node.source==='system' ? 'externalNodePath' : 'fallbackNodePath'),node.path,true);
    const nodeLabel=`${node.source==='system' ? '复用本机' : '使用专用'} Node.js ${node.version}（已验证）`;
    notify({phase:'ready',ready:true,directory:installed.directory,nodePath:node.path,nodeVersion:node.version,nodeSource:node.source,nodeLabel,message:'运行组件已就绪，点击「连接 Codex」完成首次连接。'});
    const result=await configure(installed.directory,'update');
    notify({configured:result.configured});
    if(result.configured) notify({message:result.changed ? '运行组件已更新，请重启 Codex。' : '运行组件已就绪，Codex 已配置。'});
    return installed.directory;
  }
  function ensure() {
    if (maintenance) return Promise.reject(new Error('正在检查或清理缓存，请稍后重试'));
    if (!task) task = install().catch(error=>{
      if (!disposed) notify({phase:'error',message:error.message || '安装失败，请检查网络后重试。'});
      throw error;
    }).finally(()=>{task=null;});
    return task;
  }
  function connect() {
    if (maintenance) return Promise.reject(new Error('正在检查或清理缓存，请稍后重试'));
    if (!connecting) connecting = connectInternal().finally(()=>{connecting=null;});
    return connecting;
  }
  async function connectInternal() {
    try {
      const directory = await ensure();
      const result = await configure(directory,'connect');
      active();
      if (!result.configured) throw new Error('Codex 配置未完成');
      Zotero.Prefs.set('httpServer.localAPI.enabled',true);
      Zotero.Prefs.set(pref+'nodePath',status.nodePath,true);
      Zotero.Prefs.set(pref+'serverPath',PathUtils.join(directory,'mcp','server.mjs'),true);
      notify({configured:true,message:'已连接 Codex，并开启 Zotero 本地 API。请重启 Codex 后使用。'});
    } catch(error) {
      if (!disposed) notify({message:error.message});
      throw error;
    }
  }
  function start(options) {
    version=options.version;connection=options.connection;disposed=false;
    root=PathUtils.join(Services.dirsvc.get('ProfD',Components.interfaces.nsIFile).path,'zotero-codex-runtime');
    if(state().automatic) void ensure().catch(()=>{});
    else notify({phase:'idle',message:'自动准备已关闭，点击「准备组件」可安装运行组件。'});
    scheduleCacheCleanup();
  }
  function setAutomatic(value) {
    Zotero.Prefs.set(pref+'autoInstall',Boolean(value),true);
    if(value) void ensure().catch(()=>{});
  }
  function setPreferSystem(value) {
    Zotero.Prefs.set(pref+'preferSystemNode',Boolean(value),true);
    void (maintenance || connecting || task || Promise.resolve()).catch(()=>{}).then(()=>ensure()).catch(()=>{});
  }
  async function stop() {
    disposed=true;cancelDownload?.();
    cacheTimer?.cancel(); cacheTimer=null;
    for (const process of processes) { try { process.kill(); } catch {} }
    await task?.catch(()=>{});
    await connecting?.catch(()=>{});
    await maintenance?.catch(()=>{});
  }
  return {start,stop,state,ensure,connect,setAutomatic,setPreferSystem,setAutoCacheCleanup,setCachePolicy,inspectCache:()=>cacheOperation(),clearCache:()=>cacheOperation(true)};
})();
