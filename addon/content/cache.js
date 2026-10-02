/* Only abandoned installer scratch files belong to this cache. Installed
 * runtimes can be referenced by arbitrary MCP clients and are never removed. */
var ZoteroMCPCache = (() => {
  const age = 24 * 60 * 60 * 1000;
  const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
  const scratch = new RegExp(`^(?:\\.download-${uuid}\\.zip|\\.install-${uuid}|(?:probe|configure)-${uuid}\\.json)$`, 'i');
  const runtime = /^\d+\.\d+\.\d+-(?:darwin-(?:arm64|x64)|win32-x64|linux-(?:arm64|x64))(?:-[a-f0-9-]+)?$/;
  async function inspect(fs, root, now = Date.now()) {
    const report = {count:0, bytes:0, retainedBytes:0, recentCount:0, skipped:0, candidates:[]};
    const rootInfo = await fs.stat(root);
    if (!rootInfo) return report;
    if (rootInfo.type !== 'directory') throw new Error('缓存目录不是普通目录，已停止检查');
    let visited = 0;
    async function walk(path, depth = 0) {
      if (++visited > 100000 || depth > 64) throw new Error('扫描范围过大');
      const info = await fs.stat(path);
      if (!info || !['file','directory'].includes(info.type)) throw new Error('文件不可安全读取');
      let bytes = info.type === 'file' ? info.size : 0, recent = info.mtime > now - age;
      if (info.type === 'directory') for (const child of await fs.children(path)) {
        const nested = await walk(child, depth + 1);
        bytes += nested.bytes; recent ||= nested.recent;
      }
      return {bytes, recent};
    }
    for (const path of await fs.children(root)) {
      const name = fs.basename(path);
      if (!scratch.test(name) && !runtime.test(name)) continue;
      try {
        const entry = await walk(path);
        if (runtime.test(name)) report.retainedBytes += entry.bytes;
        else if (entry.recent) report.recentCount++;
        else { report.count++; report.bytes += entry.bytes; report.candidates.push(path); }
      } catch { report.skipped++; }
    }
    return report;
  }
  async function clean(fs, root, now = Date.now()) {
    const before = await inspect(fs, root, now);
    const result = {removed:0, freedBytes:0, failed:0};
    let visited = 0;
    // Recheck every entry and its ancestors. Never recursively remove a path:
    // a changed tree or newly added file must stop removal, not broaden it.
    async function remove(path, parents) {
      if (++visited > 100000 || parents.length > 65) throw new Error('清理范围过大');
      for (const parent of parents) if ((await fs.stat(parent))?.type !== 'directory') throw new Error('目录已变化');
      const info = await fs.stat(path);
      if (!info || !['file','directory'].includes(info.type) || info.mtime > now - age) throw new Error('缓存已变化');
      if (info.type === 'directory') {
        for (const child of await fs.children(path)) await remove(child, [...parents, path]);
        for (const parent of [...parents, path]) if ((await fs.stat(parent))?.type !== 'directory') throw new Error('目录已变化');
      } else {
        const current = await fs.stat(path);
        if (current?.type !== 'file' || current.size !== info.size || current.mtime !== info.mtime) throw new Error('缓存已变化');
      }
      await fs.remove(path); // Empty directories only; do not follow links.
      result.freedBytes += info.type === 'file' ? info.size : 0;
    }
    for (const path of before.candidates) {
      try { await remove(path, [root]); result.removed++; }
      catch { result.failed++; }
    }
    return {...result, remaining:await inspect(fs, root, now)};
  }
  return {inspect, clean};
})();
if (typeof module !== 'undefined') module.exports = ZoteroMCPCache;
