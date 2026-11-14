'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) {
        const e = new Error(r.error);
        e.code = r.code;
        e.status = r.status;
        throw e;
    }
    return r.value;
}

const on = (channel) => (fn) => {
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('pbz', {
    app: { info: () => call('app:info') },
    settings: { get: () => call('settings:get'), set: (v) => call('settings:set', v) },
    game: {
        detect: () => call('game:detect'),
        info: () => call('game:info'),
        set: (dir) => call('game:set', dir),
        browse: () => call('game:browse'),
        launch: () => call('game:launch'),
        open: (sub) => call('game:open', sub),
        logs: () => call('game:logs'),
        diagnose: () => call('game:diagnose'),
    },
    library: {
        list: () => call('library:list'),
        enable: (id, on) => call('library:enable', id, on),
        enableAll: (on) => call('library:enableAll', on),
        reorder: (ids) => call('library:reorder', ids),
        remove: (id) => call('library:remove', id),
        rename: (id, name) => call('library:rename', id, name),
        purge: () => call('library:purge'),
        sync: () => call('library:sync'),
        adopt: (rel) => call('library:adopt', rel),
        files: (id) => call('library:files', id),
        openFolder: (id) => call('library:openFolder', id),
        pickImport: () => call('library:pickImport'),
        pickFolder: () => call('library:pickFolder'),
        import: (file, opts) => call('library:import', file, opts),
        bundled: () => call('library:bundled'),
        installBundled: (id) => call('library:installBundled', id),
        pathForFile: (file) => webUtils.getPathForFile(file),
    },
    nexus: {
        validate: (key) => call('nexus:validate', key),
        clearKey: () => call('nexus:clearKey'),
        status: () => call('nexus:status'),
        browse: (opts) => call('nexus:browse', opts),
        mod: (id) => call('nexus:mod', id),
        files: (id) => call('nexus:files', id),
        install: (modId, fileId, meta) => call('nexus:install', modId, fileId, meta),
        checkUpdates: () => call('nexus:checkUpdates'),
    },
    downloads: {
        list: () => call('downloads:list'),
        cancel: (id) => call('downloads:cancel', id),
        clear: () => call('downloads:clear'),
    },
    open: (url) => call('shell:open', url),
    copy: (text) => call('clipboard:write', text),
    on: {
        status: on('status'),
        toast: on('toast'),
        downloads: on('downloads'),
        libraryChanged: on('library-changed'),
        navigate: on('navigate'),
        foundDownload: on('found-download'),
        nexusUser: on('nexus-user'),
    },
});
