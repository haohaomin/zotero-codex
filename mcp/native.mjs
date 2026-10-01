// Upstream source runs behind a standard in-process MCP connection; the
// fulltext pagination extension is recorded as a small vendored source patch.
// See vendor/zotero-native-mcp/UPSTREAM.json and THIRD_PARTY_NOTICES.md.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ZoteroLocalClient } from '../vendor/zotero-native-mcp/build/client.js';
import { loadConfig } from '../vendor/zotero-native-mcp/build/config.js';
import { registerItemTools } from '../vendor/zotero-native-mcp/build/tools/items.js';
import { registerAttachmentTools } from '../vendor/zotero-native-mcp/build/tools/attachments.js';
import { registerCollectionTools } from '../vendor/zotero-native-mcp/build/tools/collections.js';
import { registerDiscoveryTools } from '../vendor/zotero-native-mcp/build/tools/discovery.js';
import { registerSystemTools } from '../vendor/zotero-native-mcp/build/tools/system.js';

// Persisted JSON must not overwrite an active editor's unsaved document.
// New notes and metadata updates continue to use the upstream implementation.
export class NativeClient extends ZoteroLocalClient {
  async request(options) {
    if (['PATCH', 'PUT', 'POST'].includes(options.method)) {
      const entries = Array.isArray(options.body) ? options.body : [options.body];
      if (entries.some(entry => entry && Object.hasOwn(entry, 'note') &&
          (entry.key || /\/items\/[A-Z0-9]{8}$/.test(options.path)))) {
        throw new Error('编辑已有笔记请使用 zotero_read_note(openEditor=true) → zotero_edit_note，避免覆盖未保存内容；新建笔记可用 zotero_create_items。');
      }
    }
    return super.request(options);
  }
}

export async function createNativeBridge(overrides = {}) {
  const config = { ...loadConfig(), appName: 'Zotero Codex MCP', ...overrides };
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Native Zotero API must use a loopback HTTP address');
  const host = new NativeClient(config);
  const server = new McpServer({ name: 'zotero-native-mcp-vendored', version: '1.0.1' });
  registerSystemTools(server, host);
  registerCollectionTools(server, host);
  registerItemTools(server, host);
  registerAttachmentTools(server, host);
  registerDiscoveryTools(server, host);
  const client = new Client({ name: 'zotero-codex-native-adapter', version: '0.8.2' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const original = (await client.listTools()).tools;
  const tools = structuredClone(original);
  tools.find(t => t.name === 'zotero_update_item').description += ' Existing note-body updates (fields.note) are handled by zotero_read_note(openEditor=true) and zotero_edit_note so unsaved editor content is not overwritten. Use zotero_resolve_item to map itemKey/groupId to local libraryID/key.';
  const names = new Set(original.map(tool => tool.name));
  return {
    tools,
    async call(name, args) {
      if (!names.has(name)) throw new Error('Unknown native tool: ' + name);
      return client.callTool({ name, arguments: args }, undefined, { timeout: 310000 });
    },
    async close() { await client.close(); await server.close(); },
  };
}
