var ZoteroCodex = (() => {
  const Core = ZoteroCodexCore;
  const uuid = () => Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
  function groupID(item) {
    const library = Zotero.Libraries.get(item.libraryID);
    return library?.libraryType === 'group' ? Zotero.Groups.getGroupIDFromLibraryID(item.libraryID) : null;
  }
  async function annotationCard(annotation, attachment) {
    if (!attachment?.isAttachment()) throw new Error('无法定位该选区的 PDF 附件');
    const parent = attachment.parentID ? Zotero.Items.get(attachment.parentID) : attachment;
    let image = annotation.image || '';
    const annotationKey = annotation.id || annotation.key;
    if (!image && ['image', 'ink'].includes(annotation.type) && annotationKey) {
      const saved = await Zotero.Items.getByLibraryAndKeyAsync(attachment.libraryID, annotationKey);
      if (saved?.parentID === attachment.id && saved.isAnnotation()) image = (await Zotero.Annotations.toJSON(saved)).image || '';
    }
    if (['image', 'ink'].includes(annotation.type) && !image) throw new Error('区域截图尚未生成，请稍后重新读取选区。');
    const card = {
      id: uuid(), kind: image ? 'pdf-region' : 'pdf-selection', libraryID: attachment.libraryID,
      attachmentKey: attachment.key, title: parent.getField('title') || attachment.getField('title'),
      text: [annotation.text, annotation.comment].filter(Boolean).join('\n'),
      pageLabel: annotation.pageLabel || '', position: annotation.position || null,
      image: image || undefined, capturedAt: new Date().toISOString(),
      sourceURI: Core.sourceURI({ attachmentKey: attachment.key, groupID: groupID(attachment), pageIndex: annotation.position?.pageIndex, annotationKey }),
    };
    if (card.text) try {
      const path = Zotero.Fulltext.getItemCacheFile(attachment).path;
      if (await IOUtils.exists(path)) {
        const info = await IOUtils.stat(path);
        if (info.size < 15 * 1024 * 1024) card.surroundingText = Core.nearbyText(await IOUtils.readUTF8(path), card.text);
      }
    } catch { /* The selection remains useful when the text cache is unavailable. */ }
    return Core.validateCards([card])[0];
  }
  const ID = 'zotero-codex@local';
  const ENDPOINT = '/zotero-codex/mcp';
  const snapshots = new Map(), revisions = new Map(), writes = new Map(), windows = new Map();
  const PREF = 'extensions.zotero-codex.';
  const SETTINGS_ID = 'zotero-codex-preferences';
  let token, connectionPath, paneID, preferencePaneID, listener, annotationObserverID, lastRequestAt = null, clientRuntime = null, queue = Promise.resolve(), running = false;
  const automatic = kind => Zotero.Prefs.get(PREF + kind, true) !== false;
  function clearContext() { snapshots.clear(); }
  function setCapturePreference(kind, enabled) {
    if (!['autoText', 'autoRegion'].includes(kind) || typeof enabled !== 'boolean') throw new Error('无效的捕获设置');
    Zotero.Prefs.set(PREF + kind, enabled, true);
    if (!enabled) for (const [id, entry] of snapshots) if (entry.automatic === kind) snapshots.delete(id);
  }
  function settingsState() {
    return {
      version: Zotero.ZoteroCodex?.version, zoteroVersion: Zotero.version,
      bridgeReady: running && Boolean(Zotero.Server.Endpoints[ENDPOINT]),
      nativeAPIEnabled: Boolean(Zotero.Prefs.get('httpServer.localAPI.enabled')),
      betterNotes: Boolean(Zotero.BetterNotes?.api), lastRequestAt,
      serverVersion: clientRuntime?.version || null,
      autoText: automatic('autoText'), autoRegion: automatic('autoRegion'), snapshotCount: snapshots.size,
      runtime: ZoteroMCPRuntime.state(),
      connectionPath,
      nodePath: Zotero.Prefs.get(PREF + 'nodePath', true) || clientRuntime?.nodePath || 'node',
      serverPath: Zotero.Prefs.get(PREF + 'serverPath', true) || clientRuntime?.serverPath || '',
    };
  }
  async function connectionConfig(customPaths) {
    const paths = customPaths || settingsState();
    let {nodePath, serverPath} = paths;
    for (const value of [nodePath, serverPath]) if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('路径无效');
    nodePath = nodePath.trim(); serverPath = serverPath.trim();
    if (!serverPath || !PathUtils.isAbsolute(serverPath) || !(await IOUtils.exists(serverPath))) throw new Error('请填写已安装的 mcp/server.mjs 的完整路径');
    if ((await IOUtils.stat(serverPath)).type !== 'regular') throw new Error('MCP 服务路径必须是文件');
    if (nodePath !== 'node' && (!PathUtils.isAbsolute(nodePath) || !(await IOUtils.exists(nodePath)))) throw new Error('请填写 Node.js 可执行文件的完整路径，或使用 node');
    if (nodePath !== 'node' && (await IOUtils.stat(nodePath)).type !== 'regular') throw new Error('Node.js 路径必须是可执行文件');
    return JSON.stringify({mcpServers:{zotero:{command:nodePath,args:[serverPath,'--connection-file',connectionPath]}}}, null, 2);
  }
  function revealConnection() {
    const file = Zotero.File.pathToFile(connectionPath);
    try { file.reveal(); } catch { Zotero.launchFile(file.parent); }
  }
  async function diagnose() {
    const base = `http://127.0.0.1:${Zotero.Server.port}`;
    const check = async (method, url, options = {}) => {
      try {
        // Zotero's local server requires this header for its own privileged
        // XHR (which carries a Mozilla User-Agent). Endpoint token checks stay on.
        const response = await Zotero.HTTP.request(method, url, {...options, headers:{'Zotero-Allowed-Request':'true',...options.headers}, timeout:5000, successCodes:false});
        return {ok:response.status === 200, status:response.status};
      }
      catch { return {ok:false, status:null}; }
    };
    const [bridge, nativeAPI] = await Promise.all([
      check('POST', base + ENDPOINT, {headers:{'Content-Type':'application/json',Authorization:'Bearer ' + token}, body:JSON.stringify({name:'zotero_status',arguments:{},source:'preferences-diagnostic'})}),
      check('GET', base + '/api/users/0/items?limit=1'),
    ]);
    let connectionFilePresent = false;
    try { connectionFilePresent = await IOUtils.exists(connectionPath); } catch {}
    const state = settingsState();
    // Deliberately allowlist fields: no paths, credentials, item titles, note
    // content or raw exception strings enter the copyable diagnostic report.
    return {checkedAt:new Date().toISOString(), version:state.version, zoteroVersion:state.zoteroVersion,
      bridge, nativeAPI, connectionFilePresent, nativeAPIEnabled:state.nativeAPIEnabled,
      betterNotes:state.betterNotes, lastRequestAt, serverVersion:state.serverVersion,
      autoText:state.autoText, autoRegion:state.autoRegion, snapshotCount:state.snapshotCount};
  }
  const identity = item => ({ libraryID: item.libraryID, key: item.key });
  const compact = item => ({ ...identity(item), itemID: item.id, type: Zotero.ItemTypes.getName(item.itemTypeID), title: item.isNote() ? item.getNoteTitle() : item.getField('title') });
  function resolve(ref, kind) {
    const item = Zotero.Items.getByLibraryAndKey(ref.libraryID, ref.key);
    if (!item || item.deleted || (kind === 'note' && !item.isNote()) || (kind === 'attachment' && !item.isAttachment())) throw new Error('目标条目不存在、已删除或类型不符');
    return item;
  }
  const readerID = reader => String(reader.tabID || reader._instanceID || reader.itemID);
  function activeReader() {
    const recent = Services.wm.getMostRecentWindow(null);
    const standalone = Zotero.Reader._readers.find(r => r._window === recent && !r.tabID);
    if (standalone) return standalone;
    const win = Zotero.getMainWindow();
    return Zotero.Reader.getByTabID(win?.Zotero_Tabs?.selectedID);
  }
  function beginCapture(reader, annotationKey, automatic) {
    const entry = { capturedAt: new Date().toISOString(), attachmentID: reader.itemID, annotationKey, automatic };
    snapshots.set(readerID(reader), entry);
    return entry;
  }
  async function capture(reader, annotation, automatic) {
    const entry = beginCapture(reader, annotation.id || annotation.key, automatic);
    entry.ready = annotationCard(annotation, Zotero.Items.get(reader.itemID)).then(card => { entry.card = card; }, error => { entry.error = error.message; });
    await entry.ready;
    if (entry.error) throw new Error(entry.error);
    return entry.card;
  }
  function captureRegion(reader, item) {
    // Reserve the snapshot before any I/O so a slow older image cannot replace
    // a newer region or text selection. Never await this from the notifier:
    // Zotero may still need to finish saving/rendering the annotation image.
    const entry = beginCapture(reader, item.key, 'autoRegion');
    entry.ready = (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (!running || snapshots.get(readerID(reader)) !== entry
          || !Zotero.Reader._readers.includes(reader)) return;
        if (item.deleted || !Zotero.Items.get(item.id)) throw new Error('区域批注已删除，请重新框选');
        const annotation = await Zotero.Annotations.toJSON(item);
        if (annotation.image) {
          entry.card = await annotationCard(annotation, Zotero.Items.get(reader.itemID));
          return;
        }
        await Zotero.Promise.delay(250);
      }
      throw new Error('区域截图仍在生成或生成失败，请稍后重新框选；也可读取该页图片');
    })().catch(error => { entry.error = error.message; });
  }
  function onAnnotationChange(event, type, ids, extraData) {
    if (!running || !automatic('autoRegion') || type !== 'item') return;
    if (event !== 'add') return;
    for (const id of ids) {
      try {
        const item = Zotero.Items.get(id);
        if (!item?.isAnnotation() || item.deleted || item.annotationType !== 'image') continue;
        // Reader saves carry their instance ID. Ignore sync/import/batch-created
        // annotations, and never assign another reader's region to the active tab.
        const instanceID = extraData?.[id]?.instanceID;
        if (!instanceID) continue;
        const reader = Zotero.Reader._readers.find(r => r._instanceID === instanceID && r.itemID === item.parentID);
        if (reader) captureRegion(reader, item);
      } catch (error) { Zotero.logError(error); }
    }
  }
  function noteState(note) {
    const api = Zotero.BetterNotes?.api;
    const editor = api?.editor.getEditorInstance(note.id);
    if (editor && api.editor.isMarkdownMode?.(editor)) {
      const text = api.editor.getMarkdownSource(editor);
      if (typeof text !== 'string') throw new Error('Markdown 编辑器尚未就绪');
      return { editor, format: 'markdown', text, lineCount: text.split('\n').length, fingerprint: 'markdown:' + text, range: null, selectedText: '' };
    }
    if (editor) {
      const state = editor._iframeWindow?.wrappedJSObject?._currentEditorInstance?._editorCore?.view?.state;
      if (!state?.doc) throw new Error('当前编辑器版本无法读取即时文档');
      const range = api.editor.getRangeAtCursor(editor);
      return { editor, text: state.doc.textBetween(0, state.doc.content.size, '\n'), lineCount: state.doc.childCount, fingerprint: JSON.stringify(state.doc.toJSON()), range, selectedText: range.from === range.to ? '' : api.editor.getTextBetween(editor, range.from, range.to) };
    }
    const html = note.getNote();
    const doc = Zotero.getMainWindow().document;
    const element = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    // Parse in a detached document. Never insert arbitrary note HTML into a live UI.
    const parsed = new (Zotero.getMainWindow().DOMParser)().parseFromString(html, 'text/html');
    for (const n of parsed.querySelectorAll('p,li,div,br,h1,h2,h3')) n.append('\n');
    element.textContent = parsed.body.textContent;
    return { text: element.textContent, lineCount: element.textContent.split('\n').length, fingerprint: html, range: null, selectedText: '' };
  }
  async function readNote(args) {
    const note = resolve(args.note, 'note');
    if (args.openEditor) {
      if (!Zotero.BetterNotes?.api) throw new Error('请启用 Better Notes');
      if (!Zotero.BetterNotes.api.editor.getEditorInstance(note.id)) await Zotero.BetterNotes.hooks.onOpenNote(note.id, 'tab', {forceTakeover:true});
      let ready = false;
      for (let i = 0; i < 120; i++) {
        const editor = Zotero.BetterNotes.api.editor.getEditorInstance(note.id);
        ready = editor && (Zotero.BetterNotes.api.editor.isMarkdownMode?.(editor)
          ? typeof Zotero.BetterNotes.api.editor.getMarkdownSource(editor) === 'string'
          : Boolean(editor._iframeWindow?.wrappedJSObject?._currentEditorInstance?._editorCore?.view?.state?.doc));
        if (ready) break;
        await Zotero.Promise.delay(50);
      }
      if (!ready) throw new Error('笔记编辑器尚未完成加载，请稍后重试');
    }
    const state = noteState(note);
    const revision = uuid();
    revisions.set(revision, { noteID: note.id, fingerprint: state.fingerprint, range: state.range, live: Boolean(state.editor), at: Date.now() });
    if (revisions.size > 100) revisions.delete(revisions.keys().next().value);
    const offset = args.offset || 0, limit = args.limit || 15000;
    return { note: compact(note), revision, format: state.format || 'richtext', live: Boolean(state.editor), cursor: state.range, selectedText: state.selectedText.slice(0, 30000), text: state.text.slice(offset, offset + limit), offset, totalCharacters: state.text.length, lineCount: state.lineCount, nextOffset: offset + limit < state.text.length ? offset + limit : null, sourceURI: `zotero://note/${groupID(note) || 'u'}/${note.key}/` };
  }
  function editNote(args) {
    const payload = JSON.stringify({ operation: 'edit', ...args });
    if (writes.has(args.requestID)) {
      const previous = writes.get(args.requestID);
      if (previous.payload !== payload) throw new Error('requestID 已用于不同内容');
      if (previous.error) throw new Error(previous.error);
      return { ...previous.result, replayed: true };
    }
    if (writes.size >= 1000) throw new Error('本次运行写入记录已满，请核对笔记后重启 Zotero');
    const note = resolve(args.note, 'note');
    if (!note.isEditable()) throw new Error('此笔记不可编辑');
    const api = Zotero.BetterNotes?.api;
    if (!api) throw new Error('请启用 Better Notes');
    const before = noteState(note), expected = revisions.get(args.revision);
    if (!before.editor) throw new Error('先调用 zotero_read_note，传 openEditor=true 打开笔记后再编辑');
    if (!expected || expected.noteID !== note.id || !expected.live || expected.fingerprint !== before.fingerprint) throw new Error('笔记已变化，请重新 read_note 后再编辑');
    if (before.format === 'markdown') {
      const markdown = Core.editMarkdown(before.text, args.edits);
      return writeMarkdown(args, markdown);
    }
    const view = before.editor._iframeWindow.wrappedJSObject._currentEditorInstance._editorCore.view;
    const lineEdits = args.edits.filter(edit => edit.operation);
    const textEdits = args.edits.filter(edit => !edit.operation);
    if (lineEdits.length && textEdits.length) throw new Error('一次编辑不能混用行补丁和 oldText/newText 格式');
    const transaction = view.state.tr;
    if (lineEdits.length) {
      const lineCount = view.state.doc.childCount;
      Core.validateLineEdits(lineEdits, lineCount);
      const ranges = lineEdits.map((edit, index) => {
        if (edit.startLine > lineCount + (edit.operation === 'insert' ? 1 : 0)) throw new Error(`第 ${edit.startLine} 行超出笔记范围`);
        if (edit.operation !== 'insert' && edit.endLine < edit.startLine) throw new Error('行范围必须满足 startLine <= endLine');
        if (edit.operation === 'insert') return { ...edit, index, from: api.editor.getPositionAtLine(before.editor, edit.startLine - 1, 'start'), to: api.editor.getPositionAtLine(before.editor, edit.startLine - 1, 'start') };
        return { ...edit, index, from: api.editor.getPositionAtLine(before.editor, edit.startLine - 1, 'start'), to: api.editor.getPositionAtLine(before.editor, edit.endLine - 1, 'end') };
      });
      const occupied = ranges.filter(range => range.operation !== 'insert').sort((a, b) => a.from - b.from);
      for (let i = 1; i < occupied.length; i++) if (occupied[i].from < occupied[i - 1].to) throw new Error('行补丁范围重叠，请拆成不重叠的编辑');
      const editorAPI = before.editor._iframeWindow.wrappedJSObject.BetterNotesEditorAPI;
      for (const edit of ranges.sort((a, b) => b.from - a.from || b.index - a.index)) {
        if (edit.operation === 'delete' && transaction.doc.childCount > 1) {
          transaction.delete(edit.from, edit.to);
          continue;
        }
        // ProseMirror documents need one text block. Deleting the only line
        // becomes an empty paragraph instead of leaving an invalid document.
        const html = Core.noteBlocksHTML(edit.operation === 'delete' ? '' : edit.newText);
        const slice = editorAPI.getSliceFromHTML(view.state, html);
        transaction.replace(edit.from, edit.to, slice);
      }
    }
    for (const edit of textEdits) {
      if (/[\r\n]/.test(edit.oldText + edit.newText)) throw new Error('富文本原文替换不支持跨行；请使用行补丁或切换 Markdown 模式');
      const matches = [];
      transaction.doc.descendants((node, pos) => {
        node = Components.utils.waiveXrays(node);
        if (!node.isTextblock) return;
        // Each inline atom occupies one position, including images/citations.
        // The sentinel prevents a text edit from accidentally spanning an atom.
        const text = node.textBetween(0, node.content.size, '', '\uFFFC');
        let offset = text.indexOf(edit.oldText);
        while (offset !== -1) { matches.push({from:pos + 1 + offset,to:pos + 1 + offset + edit.oldText.length}); offset = text.indexOf(edit.oldText, offset + 1); }
        return false;
      });
      if (matches.length !== 1) throw new Error(matches.length ? '原文出现多次，请提供更长且唯一的原文' : '找不到完整原文，或原文跨段落/图片，请重新读取笔记');
      transaction.insertText(edit.newText, matches[0].from, matches[0].to);
    }
    const record = {payload}; writes.set(args.requestID, record);
    try {
      // One transaction preserves surrounding structure and keeps replacements together in editor history.
      view.dispatch(transaction);
      revisions.delete(args.revision);
      record.result = { edited: true, replacements: args.edits.length, note: compact(note), requestID: args.requestID, savedThrough: 'live-editor (Zotero autosave)' };
      return record.result;
    } catch (error) { record.error = '编辑结果可能不完整，请读回核对：' + error.message; throw new Error(record.error); }
  }
  async function writeNote(args) {
    const payload = JSON.stringify(args);
    if (writes.has(args.requestID)) {
      const previous = writes.get(args.requestID);
      if (previous.payload !== payload) throw new Error('requestID 已用于不同内容');
      if (previous.error) throw new Error(previous.error);
      return { ...previous.result, replayed: true };
    }
    // No eviction: duplicates must not silently become new writes during this run.
    if (writes.size >= 1000) throw new Error('本次运行写入记录已满，请核对笔记后重启 Zotero');
    const note = resolve(args.note, 'note');
    if (!note.isEditable()) throw new Error('此笔记不可编辑');
    const api = Zotero.BetterNotes?.api;
    if (!api) throw new Error('请启用 Better Notes');
    const before = noteState(note), expected = revisions.get(args.revision);
    if (before.format === 'markdown') throw new Error('Markdown 模式请使用 edit_note 或 set_note_markdown；write_note 仅支持富文本');
    if (!expected || expected.noteID !== note.id || expected.fingerprint !== before.fingerprint || expected.live !== Boolean(before.editor)) throw new Error('笔记内容或编辑状态已变化，请重新 read_note 后再写入');
    if (args.mode === 'cursor' && (!before.editor || !expected.range || expected.range.from !== before.range.from || expected.range.to !== before.range.to)) throw new Error('笔记光标或选区已变化，请重新 read_note');
    if (args.mode === 'cursor' && before.range.from !== before.range.to) throw new Error('光标插入不替换选中文字，请取消笔记选区后重新 read_note');
    const html = Core.noteHTML(args.text, args.sources || []);
    const record = { payload };
    writes.set(args.requestID, record);
    try {
      if (before.editor) await api.editor.insert(before.editor, html, args.mode === 'cursor' ? expected.range.from : 'end');
      else await api.note.insert(note, html);
      revisions.delete(args.revision);
      record.result = { written: true, note: compact(note), mode: args.mode, requestID: args.requestID, savedThrough: before.editor ? 'live-editor (Zotero autosave)' : 'Better Notes note API' };
      return record.result;
    } catch (error) {
      record.error = '写入失败，结果可能不完整，请读取核对：' + error.message;
      throw new Error(record.error);
    }
  }
  function betterNotes() {
    const bn = Zotero.BetterNotes;
    if (!bn?.api) throw new Error('请启用 Better Notes');
    return bn;
  }
  function checkNoteRevision(args) {
    const note = resolve(args.note, 'note');
    if (!note.isEditable()) throw new Error('此笔记不可编辑');
    const state = noteState(note), expected = revisions.get(args.revision);
    if (!expected || expected.noteID !== note.id || expected.fingerprint !== state.fingerprint || expected.live !== Boolean(state.editor)) throw new Error('笔记内容或编辑模式已变化，请重新 read_note');
    return {note, state};
  }
  async function mutate(operation, args, action) {
    const payload = JSON.stringify({operation, ...args});
    const old = writes.get(args.requestID);
    if (old) {
      if (old.payload !== payload) throw new Error('requestID 已用于不同内容');
      if (old.error) throw new Error(old.error);
      return {...old.result, replayed:true};
    }
    if (writes.size >= 1000) throw new Error('本次运行写入记录已满，请核对笔记后重启 Zotero');
    const record = {payload}; writes.set(args.requestID, record);
    try {
      record.result = await action();
      return record.result;
    } catch (error) {
      record.error = error.message + '；请读回状态核对，不要更换 requestID 盲目重试';
      throw new Error(record.error);
    }
  }
  function writeMarkdown(args, markdown = args.markdown) {
    return mutate(args.edits ? 'edit' : 'set-markdown', args, async () => {
      const {note, state} = checkNoteRevision(args);
      if (state.format !== 'markdown' || !state.editor) throw new Error('请先 set_note_mode 切换到 Markdown 模式，再读取笔记');
      const editorAPI = betterNotes().api.editor;
      if (!editorAPI.setMarkdownSource(state.editor, markdown)) throw new Error('Better Notes 未接受 Markdown 写入');
      if (editorAPI.getMarkdownSource(state.editor) !== markdown) throw new Error('Markdown 写入后读回不一致');
      revisions.delete(args.revision);
      return {edited:true, note:compact(note), requestID:args.requestID, savedThrough:'Better Notes Markdown editor', persistence:'autosave-scheduled', snapshot:await readNote({note:args.note})};
    });
  }
  function setNoteMode(args) {
    return mutate('set-mode', args, async () => {
      const {note} = checkNoteRevision(args);
      const api = betterNotes().api;
      if (!api.editor.toggleMarkdownMode || !api.editor.getMarkdownSource) throw new Error('当前 Better Notes 不支持 Markdown API，请升级插件');
      await readNote({note:args.note,openEditor:true});
      const editor = api.editor.getEditorInstance(note.id);
      const wasMarkdown = Boolean(api.editor.isMarkdownMode(editor));
      if (wasMarkdown && args.mode === 'richtext' && typeof editor.applyIncrementalUpdate !== 'function') throw new Error('当前 Zotero 无法同步富文本视图，请在 Better Notes 界面切换模式');
      if (wasMarkdown !== (args.mode === 'markdown')) await api.editor.toggleMarkdownMode(editor);
      if (Boolean(api.editor.isMarkdownMode(editor)) !== (args.mode === 'markdown')) throw new Error('编辑模式切换失败');
      if (wasMarkdown && args.mode === 'richtext') {
        // Better Notes flushes Markdown to the item, but Zotero's hidden rich
        // editor can still hold its previous document. Use Zotero's incremental
        // external-update API before exposing that editor for further edits.
        const win = editor._iframeWindow.wrappedJSObject;
        const view = win._currentEditorInstance._editorCore.view;
        const html = note.getNote();
        const expectedDoc = win.BetterNotesEditorAPI.getNodeFromHTML(view.state, html);
        const expectedText = expectedDoc.textBetween(0, expectedDoc.content.size, '\n');
        editor.applyIncrementalUpdate({html}, true);
        let ready = false;
        for (let i = 0; i < 80; i++) {
          if (noteState(note).text === expectedText) { ready = true; break; }
          await Zotero.Promise.delay(50);
        }
        if (!ready) throw new Error('富文本视图尚未同步，请重新打开笔记后读取');
      }
      revisions.delete(args.revision);
      return {mode:args.mode, requestID:args.requestID, snapshot:await readNote({note:args.note})};
    });
  }
  const syncRevisions = new Map();
  async function waitSyncIdle() {
    // Better Notes also syncs on item notifications, even when its timer is off.
    for (let i = 0; betterNotes().data?.sync?.lock; i++) {
      if (i >= 50) throw new Error('Better Notes 正在同步或等待冲突处理，请完成后重试');
      await Zotero.Promise.delay(100);
    }
  }
  async function syncState(note) {
    const api = betterNotes().api;
    const enabled = api.sync.isSyncNote(note.id);
    const status = enabled ? api.sync.getSyncStatus(note.id) : null;
    const filePath = status?.path && status?.filename ? PathUtils.join(status.path, status.filename) : null;
    const exists = filePath ? await IOUtils.exists(filePath) : false;
    let raw = null, md = null;
    if (exists) {
      if ((await IOUtils.stat(filePath)).size > 8 * 1024 * 1024) throw new Error('同步文件超过 8 MB，请在 Better Notes 中手动处理');
      raw = await IOUtils.readUTF8(filePath);
      md = api.sync.getMDStatusFromContent(raw);
    }
    const hash = text => Zotero.Utilities.Internal.md5(text, false);
    const noteChanged = enabled && (hash(note.getNote()) !== status.noteMd5 || (md?.meta && Number(md.meta.$version) !== note.version));
    const fileChanged = enabled && exists && hash(md.content) !== status.md5;
    const identityMismatch = Boolean(md?.meta && (Number(md.meta.$libraryID) !== note.libraryID || md.meta.$itemKey !== note.key));
    const conflict = enabled && exists && (identityMismatch || !md?.meta || md.meta.$version < 0 || (noteChanged && fileChanged));
    return {note:compact(note), enabled, editorOpen:Boolean(api.editor.getEditorInstance(note.id)), filePath, fileExists:exists, noteChanged:Boolean(noteChanged), fileChanged:Boolean(fileChanged), conflict:Boolean(conflict), lastSync:status?.lastsync || null,
      fingerprint:JSON.stringify({html:note.getNote(),version:note.version,status,raw})};
  }
  async function getNoteSync(args) {
    await waitSyncIdle();
    const state = await syncState(resolve(args.note, 'note'));
    const syncRevision = uuid();
    syncRevisions.set(syncRevision, {noteID:resolve(args.note, 'note').id, fingerprint:state.fingerprint});
    if (syncRevisions.size > 100) syncRevisions.delete(syncRevisions.keys().next().value);
    const {fingerprint, ...result} = state;
    return {...result, syncRevision};
  }
  function syncNote(args) {
    return mutate('sync-note', args, async () => {
      const note = resolve(args.note, 'note'), bn = betterNotes(), api = bn.api;
      if (!note.isEditable()) throw new Error('此笔记不可编辑');
      if (api.editor.getEditorInstance(note.id) || [...(Zotero.Notes._editorInstances || [])].some(e => e._item?.id === note.id)) throw new Error('请先关闭该笔记的所有编辑器；若文库侧栏仍保留编辑器，请切换到另一篇笔记，再执行文件同步');
      await waitSyncIdle();
      const before = await syncState(note), expected = syncRevisions.get(args.syncRevision);
      if (!expected || expected.noteID !== note.id || expected.fingerprint !== before.fingerprint) throw new Error('笔记或 Markdown 文件已变化，请重新 get_note_sync');
      if (args.action !== 'enable' && args.directory !== undefined) throw new Error('仅 enable 可以指定 directory');
      if (args.action === 'enable') {
        if (before.enabled) throw new Error('笔记已经绑定同步文件，请使用 sync');
        if (!args.directory || !/^(\/|[A-Za-z]:[\\/])/.test(args.directory)) throw new Error('enable 需要绝对目录路径');
        if (await IOUtils.exists(args.directory) && (await IOUtils.stat(args.directory)).type !== 'directory') throw new Error('directory 不是文件夹');
        const filename = await api.sync.getMDFileName(note.id, args.directory);
        if (!filename || /[\\/]/.test(filename) || !/\.md$/i.test(filename)) throw new Error('Better Notes 文件名模板必须生成单个 .md 文件名');
        if (await IOUtils.exists(PathUtils.join(args.directory, filename))) throw new Error('目标 Markdown 文件已存在，拒绝覆盖；请在 Better Notes 同步管理器中建立绑定');
        await api.$export.syncMDBatch(args.directory, [note.id]);
      } else if (args.action === 'disable') {
        api.sync.removeSyncNote(note.id);
      } else {
        if (!before.enabled) throw new Error('笔记未开启文件同步');
        if (!before.fileExists) throw new Error('同步文件不存在，请先检查文件路径');
        if (before.conflict) throw new Error('笔记与 Markdown 文件存在冲突，请在 Better Notes 中处理，MCP 不自动覆盖');
        await bn.hooks.onSyncing([note], {quiet:true,skipActive:false,reason:'codex-mcp'});
      }
      syncRevisions.delete(args.syncRevision);
      const after = await getNoteSync({note:args.note});
      if (args.action === 'disable' ? after.enabled : (!after.enabled || !after.fileExists || after.noteChanged || after.fileChanged || after.conflict)) throw new Error('Better Notes 同步未完成，请检查同步状态或其提示窗口');
      return {action:args.action, requestID:args.requestID, status:after};
    });
  }
  async function getNoteStructure(args) {
    const note = resolve(args.note, 'note'), api = betterNotes().api;
    // Clone the saved HTML so asynchronous parsing sees one consistent snapshot.
    const html = note.getNote();
    const snapshot = {id:note.id,getNote:() => html};
    const lines = await api.note.getLinesInNote(snapshot);
    const tree = await api.note.getNoteTreeFlattened(snapshot, {keepRoot:false,keepLink:true});
    const offset = args.offset || 0, limit = args.limit || 50;
    return {note:compact(note), source:'saved-note', lineCount:lines.length, lines:lines.slice(offset,offset+limit).map((html,index) => ({line:offset+index+1,html:html.slice(0,10000),truncated:html.length>10000})),
      outline:tree.filter(n => n.model.lineIndex >= offset && n.model.lineIndex < offset+limit).map(n => ({id:n.model.id,parentID:n.parent?.model.id ?? null,title:n.model.name,level:n.model.level,startLine:n.model.lineIndex+1,endLine:n.model.endIndex+1,link:n.model.link})),
      nextOffset:offset+limit<lines.length ? offset+limit : null};
  }
  async function getNoteRelations(args) {
    const note = resolve(args.note, 'note'), api = betterNotes().api;
    const links = await api.relation[args.direction === 'inbound' ? 'getNoteLinkInboundRelation' : 'getNoteLinkOutboundRelation'](note.id);
    const offset = args.offset || 0, limit = args.limit || 50;
    return {note:compact(note),source:'Better Notes relation index',direction:args.direction,links:links.slice(offset,offset+limit),total:links.length,nextOffset:offset+limit<links.length ? offset+limit : null};
  }
  async function convertNoteContent(args) {
    const api = betterNotes().api;
    const content = await api.convert[args.from === 'html' ? 'html2md' : 'md2html'](args.content);
    if (typeof content !== 'string' || content.length > 200000) throw new Error('转换结果无效或超过 200000 字符，请缩小输入');
    return {format:args.from === 'html' ? 'markdown' : 'html',content};
  }
  async function context() {
    const win = Zotero.getMainWindow(), tabs = win?.Zotero_Tabs;
    const reader = activeReader();
    const selected = win?.ZoteroPane?.getSelectedItems() || [];
    const openedNotes = [];
    for (const editor of Zotero.Notes._editorInstances || []) if (editor._item?.isNote() && !openedNotes.some(n => n.itemID === editor._item.id)) openedNotes.push(compact(editor._item));
    const tab = tabs?._tabs?.find(t => t.id === tabs.selectedID);
    const attachment = reader && Zotero.Items.get(reader.itemID);
    const pageIndex = reader?._internalReader?._state?.primaryViewState?.pageIndex;
    const snapshot = reader && snapshots.get(readerID(reader));
    return { activeTab: tab ? { id: tab.id, type: tab.type, itemID: tab.data?.itemID } : null, reader: attachment ? { readerID: readerID(reader), attachment: compact(attachment), paper: attachment.parentID ? compact(Zotero.Items.get(attachment.parentID)) : null, pageIndex: Number.isInteger(pageIndex) ? pageIndex : null, pageNumber: Number.isInteger(pageIndex) ? pageIndex + 1 : null, lastSelection: snapshot ? { capturedAt: snapshot.capturedAt, available: Boolean(snapshot.card), error: snapshot.error } : null } : null, selectedItems: selected.slice(0, 50).map(compact), openedNotes };
  }
  async function execute(name, args) {
    ZoteroMCPContract.validateCall(name, args);
    switch (name) {
      case 'zotero_status': return { version: '0.8.2', zoteroVersion: Zotero.version, betterNotes: Boolean(Zotero.BetterNotes?.api), connected: running };
      case 'zotero_get_context': return context();
      case 'zotero_resolve_item': {
        const libraryID = args.groupId ? Zotero.Groups.getLibraryIDFromGroupID(args.groupId) : Zotero.Libraries.userLibraryID;
        if (!libraryID) throw new Error('本机不存在指定文库');
        return { item: compact(resolve({libraryID,key:args.itemKey})) };
      }
      case 'zotero_get_selection': {
        const reader = args.readerID ? Zotero.Reader._readers.find(r => readerID(r) === args.readerID) : activeReader();
        if (!reader) throw new Error('请打开论文阅读器，或提供 get_context 返回的 readerID');
        let entry;
        // A new selection can arrive while an image is being prepared. Return
        // the current snapshot, never the superseded one we first waited for.
        do {
          entry = snapshots.get(readerID(reader));
          if (!entry || entry.attachmentID !== reader.itemID) throw new Error('该阅读器没有选区快照，请在 PDF 中选中文字或用区域批注工具框选');
          await entry.ready;
        } while (snapshots.get(readerID(reader)) !== entry);
        if (entry.error) throw new Error(entry.error);
        if (!entry.card) throw new Error('阅读器已关闭或截图已取消，请重新框选');
        const ageSeconds = Math.round((Date.now() - Date.parse(entry.capturedAt)) / 1000);
        if (ageSeconds > (args.maxAgeSeconds || 1800)) throw new Error('选区快照已过期，请重新选择');
        return { snapshot: true, readerID: readerID(reader), ageSeconds, selection: entry.card };
      }
      case 'zotero_get_annotations': {
        const attachment = resolve(args.attachment, 'attachment');
        let annotations = attachment.getAnnotations();
        if (args.annotationKey) {
          const saved = resolve({ libraryID: attachment.libraryID, key: args.annotationKey });
          if (!saved.isAnnotation() || saved.parentID !== attachment.id) throw new Error('批注不属于指定附件');
          annotations = [saved];
        }
        const offset = args.offset || 0, limit = args.includeImages ? Math.min(args.limit || 3, 3) : args.limit || 20;
        const values = [];
        for (const annotation of annotations.slice(offset, offset + limit)) {
          const value = await Zotero.Annotations.toJSON(annotation);
          if (!args.includeImages) delete value.image;
          if (value.image) Core.validateCards([{image:value.image}]);
          values.push({ ...identity(annotation), type: value.type, text: value.text, comment: value.comment, pageLabel: value.pageLabel, position: value.position, image: value.image, imageAvailable: Boolean(value.image), sourceURI: Core.sourceURI({ attachmentKey: attachment.key, groupID: groupID(attachment), pageIndex: value.position?.pageIndex, annotationKey: annotation.key }) });
        }
        return { annotations: values, total: annotations.length, nextOffset: offset + limit < annotations.length ? offset + limit : null };
      }
      case 'zotero_read_note': return readNote(args);
      case 'zotero_edit_note': return editNote(args);
      case 'zotero_write_note': return writeNote(args);
      case 'zotero_set_note_mode': return setNoteMode(args);
      case 'zotero_set_note_markdown': return writeMarkdown(args);
      case 'zotero_get_note_structure': return getNoteStructure(args);
      case 'zotero_get_note_relations': return getNoteRelations(args);
      case 'zotero_convert_note_content': return convertNoteContent(args);
      case 'zotero_get_note_sync': return getNoteSync(args);
      case 'zotero_sync_note': return syncNote(args);
      default: throw new Error('Unsupported tool');
    }
  }
  function dispatch(name, args) {
    const operation = queue.then(() => { if (!running) throw new Error('插件已关闭'); return execute(name, args); });
    queue = operation.catch(() => {});
    return operation;
  }
  function prepareWindow(win) {
    if (windows.has(win)) return;
    win.document.l10n?.addResourceIds(['zotero-codex.ftl']);
    windows.set(win, true);
  }
  function unloadWindow(win) { win.document.l10n?.removeResourceIds(['zotero-codex.ftl']); windows.delete(win); }
  function renderPanel({ body, item }) {
    body.replaceChildren();
    const doc = body.ownerDocument;
    const make = (tag, text) => { const n = doc.createElementNS('http://www.w3.org/1999/xhtml', tag); n.textContent = text; return n; };
    const panel = make('div', ''); panel.className = 'zc-mcp';
    panel.style.cssText = 'padding:12px;display:grid;gap:10px;font:inherit;line-height:1.6';
    panel.append(make('strong', 'MCP 已就绪 · 0.8.2'), make('div', '在 Codex 中直接提问。可在设置中管理文字选区和区域截图的自动捕获。'));
    const settingsButton = make('button', '打开 MCP 设置');
    settingsButton.addEventListener('click', () => Zotero.Utilities.Internal.openPreferences(SETTINGS_ID));
    panel.append(settingsButton);
    const drop = make('div', '可拖入已有批注；区域自动捕获可在设置中开关');
    drop.style.cssText = 'padding:12px;border:1px dashed var(--fill-secondary,#aaa);border-radius:10px';
    drop.addEventListener('dragover', e => e.preventDefault());
    drop.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      try {
        const values = JSON.parse(e.dataTransfer.getData('zotero/annotation'));
        if (!Array.isArray(values) || values.length !== 1) throw new Error('请一次拖入一条批注');
        const annotation = values[0], attachment = Zotero.Items.get(Number(annotation.attachmentItemID));
        if (!attachment?.isAttachment()) throw new Error('无法确定批注附件');
        const candidates = Zotero.Reader._readers.filter(r => r.itemID === attachment.id);
        const reader = candidates.find(r => r === activeReader()) || (candidates.length === 1 ? candidates[0] : null);
        if (!reader) throw new Error('请先打开并选中该批注对应的 PDF 标签页');
        await capture(reader, annotation);
        drop.textContent = '已保存上下文快照，可在 Codex 中读取';
      } catch (error) { drop.textContent = error.message; }
    });
    panel.append(drop);
    if (item?.isNote()) panel.append(make('div', `当前笔记：${item.getNoteTitle()}。在 Codex 中要求写入即可。`));
    body.append(panel);
  }
  async function start() {
    lastRequestAt = null; clientRuntime = null;
    token = uuid() + uuid();
    connectionPath = Zotero.Prefs.get('extensions.zotero-codex.mcpConnectionFile', true) || PathUtils.join(PathUtils.profileDir, 'zotero-codex-mcp.json');
    await Zotero.Server.init();
    function Endpoint() {}
    Endpoint.prototype = {
      supportedMethods: ['POST'], supportedDataTypes: ['application/json'],
      async init({ headers, data }) {
        if (headers.origin || headers.authorization !== 'Bearer ' + token) return [403, 'application/json', JSON.stringify({ error: 'Forbidden' })];
        try {
          if (!data || typeof data !== 'object' || JSON.stringify(data).length > 100000) throw new Error('Invalid request');
          ZoteroMCPContract.validateCall(data.name, data.arguments || {});
          if (data.source !== 'preferences-diagnostic') {
            lastRequestAt = new Date().toISOString();
            if (data.client && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.client.version) && ['version', 'nodePath', 'serverPath'].every(key => typeof data.client[key] === 'string' && data.client[key].length < 4096 && !/[\r\n\0]/.test(data.client[key]))) {
              clientRuntime = {version:data.client.version,nodePath:data.client.nodePath,serverPath:data.client.serverPath};
            }
          }
          return [200, 'application/json', JSON.stringify(await dispatch(data.name, data.arguments || {}))];
        } catch (error) { return [400, 'application/json', JSON.stringify({ error: error.message })]; }
      },
    };
    Zotero.Server.Endpoints[ENDPOINT] = Endpoint;
    // Create privately before writing any secret; never log the token.
    await IOUtils.writeUTF8(connectionPath, '{}', { mode: 'overwrite', permissions: 0o600 });
    await IOUtils.setPermissions(connectionPath, 0o600);
    await IOUtils.writeUTF8(connectionPath, JSON.stringify({ url: `http://127.0.0.1:${Zotero.Server.port}${ENDPOINT}`, token, version: '0.8.2' }));
    for (const win of Zotero.getMainWindows()) prepareWindow(win);
    paneID = Zotero.ItemPaneManager.registerSection({ paneID: 'zotero-codex-mcp', pluginID: ID,
      header: { l10nID: 'zotero-codex-title', icon: 'chrome://zotero-codex/content/icon.svg', darkIcon: 'chrome://zotero-codex/content/icon-dark.svg' },
      sidenav: { l10nID: 'zotero-codex-tab', icon: 'chrome://zotero-codex/content/icon.svg', darkIcon: 'chrome://zotero-codex/content/icon-dark.svg' },
      onInit: ({body}) => prepareWindow(body.ownerDocument.defaultView),
      onItemChange: ({item, setEnabled}) => { setEnabled(Boolean(item)); return true; }, onRender: renderPanel,
    });
    if (!paneID) throw new Error('无法注册 MCP 状态侧栏');
    listener = event => {
      const annotation = JSON.parse(JSON.stringify(event.params.annotation || {}));
      if (!annotation.text && !annotation.image && !['image', 'ink'].includes(annotation.type)) return;
      const button = event.doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
      button.textContent = automatic('autoText') ? 'MCP 正在保存选区' : '添加到 MCP';
      const save = auto => capture(event.reader, annotation, auto ? 'autoText' : undefined).then(() => { button.textContent = 'MCP 已记录选区'; }, error => { button.textContent = error.message; });
      button.addEventListener('mousedown', e => e.preventDefault());
      button.addEventListener('click', () => { void save(false); }); event.append(button);
      if (automatic('autoText')) void save(true);
    };
    Zotero.Reader.registerEventListener('renderTextSelectionPopup', listener, ID);
    running = true;
    annotationObserverID = Zotero.Notifier.registerObserver({notify:onAnnotationChange}, ['item'], 'zotero-codex-regions');
    Zotero.ZoteroCodex = { version: '0.8.2', dispatch, capture, annotationCard,
      settings: {state:settingsState, setCapturePreference, clearContext, connectionConfig, revealConnection, diagnose, runtime:ZoteroMCPRuntime} };
    preferencePaneID = await Zotero.PreferencePanes.register({
      pluginID:ID, id:SETTINGS_ID, label:'Zotero MCP',
      src:'chrome://zotero-codex/content/preferences.xhtml',
      scripts:['chrome://zotero-codex/content/preferences.js'],
      stylesheets:['chrome://zotero-codex/content/preferences.css'],
      image:'chrome://zotero-codex/content/icon.svg',
      helpURL:'https://github.com/haohaomin/zotero-codex/blob/main/docs/local-setup.md',
    });
    ZoteroMCPRuntime.start({version:Zotero.ZoteroCodex.version,connection:connectionPath});
  }
  async function stop() {
    running = false;
    await ZoteroMCPRuntime.stop();
    if (annotationObserverID !== undefined) Zotero.Notifier.unregisterObserver(annotationObserverID);
    annotationObserverID = undefined;
    await queue;
    delete Zotero.Server.Endpoints[ENDPOINT];
    if (listener) Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', listener);
    if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
    if (preferencePaneID) Zotero.PreferencePanes.unregister(preferencePaneID);
    preferencePaneID = undefined;
    for (const win of windows.keys()) unloadWindow(win);
    snapshots.clear(); revisions.clear(); syncRevisions.clear(); writes.clear();
    if (connectionPath) await IOUtils.remove(connectionPath, {ignoreAbsent: true});
    delete Zotero.ZoteroCodex;
  }
  return { start, stop, prepareWindow, unloadWindow };
})();
