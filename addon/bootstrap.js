var chromeHandle;
var pluginScope;

function install() {}
function uninstall() {}

async function startup({ rootURI }, reason) {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
  const startupService = Components.classes['@mozilla.org/addons/addon-manager-startup;1'].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = startupService.registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [
    ['content', 'zotero-codex', rootURI + 'content/'],
    ['locale', 'zotero-codex', 'en-US', rootURI + 'locale/en-US/'],
  ]);
  pluginScope = { Zotero, Services, IOUtils, PathUtils, Components, rootURI };
  Services.scriptloader.loadSubScript(rootURI + 'content/core.js', pluginScope);
  Services.scriptloader.loadSubScript(rootURI + 'content/mcp-schema.js', pluginScope);
  Services.scriptloader.loadSubScript(rootURI + 'content/runtime-core.js', pluginScope);
  Services.scriptloader.loadSubScript(rootURI + 'content/cache.js', pluginScope);
  Services.scriptloader.loadSubScript(rootURI + 'content/runtime.js', pluginScope);
  Services.scriptloader.loadSubScript(rootURI + 'content/plugin.js', pluginScope);
  await pluginScope.ZoteroCodex.start();
}
function onMainWindowLoad({ window }) { pluginScope?.ZoteroCodex?.prepareWindow(window); }
function onMainWindowUnload({ window }) { pluginScope?.ZoteroCodex?.unloadWindow(window); }
async function shutdown(data, reason) {
  await pluginScope?.ZoteroCodex?.stop();
  chromeHandle?.destruct(); chromeHandle = null; pluginScope = null;
}
