var ZoteroMCPPreferences = {
  initialized: false,
  get api() {
    if (!Zotero.ZoteroCodex?.settings) throw new Error('插件已关闭，请重新启用后打开设置');
    return Zotero.ZoteroCodex.settings;
  },
  el(id) { return document.getElementById('zc-' + id); },
  feedback(message) { this.el('feedback').textContent = message; },
  bind(id, action) {
    this.el(id).addEventListener('click', async () => {
      const button = this.el(id); button.disabled = true;
      try { await action(); } catch (error) {
        if (id === 'copy-config') this.el('config-feedback').textContent = error.message;
        else this.feedback(error.message);
      }
      finally { button.disabled = false; }
    });
  },
  init() {
    if (this.initialized) return;
    this.initialized = true;
    for (const [id, key] of [['auto-text','autoText'], ['auto-region','autoRegion']]) {
      this.el(id).addEventListener('change', () => {
        try { this.api.setCapturePreference(key, this.el(id).checked); this.refresh(); this.feedback('设置已保存，立即生效'); }
        catch (error) { this.feedback(error.message); }
      });
    }
    this.el('developer-mode').checked = false;
    this.el('developer-mode').addEventListener('change', () => {
      const custom = this.el('developer-mode').checked;
      this.el('developer-fields').hidden = !custom;
      this.el('copy-config').textContent = custom ? '复制自定义 MCP 配置' : '复制 MCP 配置';
      this.el('config-feedback').textContent = '';
      this.refresh(true);
    });
    this.el('prefer-system').addEventListener('change', () => {
      this.api.runtime.setPreferSystem(this.el('prefer-system').checked); this.refreshRuntime();
    });
    this.el('auto-install').addEventListener('change', () => {
      this.api.runtime.setAutomatic(this.el('auto-install').checked); this.refresh();
    });
    this.bind('install', async () => { await this.api.runtime.ensure(); this.refresh(true); });
    this.bind('connect', async () => {
      await this.api.runtime.connect(); this.refresh(true); this.feedback('配置已保存，请重启 Codex');
    });
    this.runtimeTimer = window.setInterval(() => this.refreshRuntime(), 500);
    window.addEventListener('unload', () => window.clearInterval(this.runtimeTimer), {once:true});
    this.bind('refresh', () => { this.refresh(); this.feedback('状态已刷新'); });
    this.bind('clear', () => { this.api.clearContext(); this.refresh(); this.feedback('已清除所有阅读器的 MCP 选区快照'); });
    this.bind('copy-config', async () => {
      const custom = this.el('developer-mode').checked;
      const paths = custom ? {nodePath:this.el('node-path').value,serverPath:this.el('server-path').value} : undefined;
      Zotero.Utilities.Internal.copyTextToClipboard(await this.api.connectionConfig(paths));
      this.el('config-feedback').textContent = custom ? '自定义配置已复制；请在目标客户端添加，现有连接未修改。' : 'MCP 配置已复制；请在目标客户端添加，不包含访问令牌。';
    });
    this.bind('reveal', () => this.api.revealConnection());
    this.bind('check', () => this.check());
    this.bind('copy-diagnostics', async () => {
      const report = await this.check();
      Zotero.Utilities.Internal.copyTextToClipboard(JSON.stringify(report, null, 2));
      this.feedback('诊断信息已复制，不含令牌、路径或论文笔记内容');
    });
    const repo = 'https://github.com/renhao12356578/zotero-codex';
    for (const [id, url] of [['help',repo + '/blob/main/docs/local-setup.md'], ['github',repo], ['releases',repo + '/releases/latest']]) {
      this.bind(id, () => Zotero.launchURL(url));
    }
    this.refresh(true);
  },
  refreshRuntime() {
    try {
      const state = this.api.runtime.state();
      // Avoid repeatedly announcing an unchanged status to screen readers.
      if (this.el('runtime-status').textContent !== state.message) this.el('runtime-status').textContent = state.message;
      this.el('auto-install').checked = state.automatic;
      this.el('prefer-system').checked = state.preferSystem;
      const busy = ['checking','downloading','verifying','installing'].includes(state.phase);
      this.el('node-source').textContent = state.nodeLabel || (busy ? '正在准备运行环境…' : '运行环境将在准备组件后显示');
      const badge = this.el('runtime-badge');
      badge.textContent = state.phase === 'error' ? '需要处理' : busy ? '准备中' : state.ready ? (state.configured ? 'Codex 已配置' : '组件已就绪') : '待准备';
      badge.dataset.tone = state.phase === 'error' ? 'error' : state.ready && !busy ? 'ready' : 'idle';
      this.el('runtime-label').textContent = state.nodeLabel || '尚未就绪';
      this.el('runtime-version').textContent = state.ready ? this.api.state().version : '尚未就绪';
      const paths = this.api.state();
      this.el('node-detail').textContent = paths.nodePath || '尚未确定';
      this.el('server-detail').textContent = paths.serverPath || '尚未准备，请点击「准备 / 重试」';
    } catch { /* Pane can outlive a disabled plugin. */ }
  },
  refresh(fillPaths = false) {
    if (!this.initialized) return;
    this.refreshRuntime();
    try {
      const state = this.api.state();
      const values = {
        version:state.version + ' · Zotero ' + state.zoteroVersion,
        bridge:state.bridgeReady ? '已就绪' : '未就绪',
        native:state.nativeAPIEnabled ? '已开启' : '未开启，请前往「高级」设置',
        notes:state.betterNotes ? '可用' : '未启用，笔记协作功能受限',
        'last-request':state.lastRequestAt ? new Date(state.lastRequestAt).toLocaleString() : '本次启动后尚无客户端请求',
        'server-version':state.serverVersion ? state.serverVersion + (state.serverVersion === state.version ? '' : '（与插件版本不同，请更新并重新加载 MCP）') : '尚未识别',
        'context-count':`已保存 ${state.snapshotCount} 个阅读器快照`,
      };
      for (const [id, text] of Object.entries(values)) this.el(id).textContent = text;
      this.el('auto-text').checked = state.autoText;
      this.el('auto-region').checked = state.autoRegion;
      if (fillPaths || !this.el('developer-mode').checked) {
        this.el('node-path').value = state.nodePath;
        this.el('server-path').value = state.serverPath;
      }
    } catch (error) { this.feedback(error.message); }
  },
  async check() {
    this.el('diagnostics').textContent = '正在检查本机连接…';
    const report = await this.api.diagnose();
    const describe = check => check.ok ? '正常' : check.status ? `失败（HTTP ${check.status}）` : '无法连接';
    this.el('diagnostics').textContent = `本地桥接：${describe(report.bridge)}；Zotero API：${describe(report.nativeAPI)}；连接文件：${report.connectionFilePresent ? '存在' : '缺失'}。这项检查不验证 Codex 客户端是否已配置。`;
    this.refresh();
    return report;
  },
};
