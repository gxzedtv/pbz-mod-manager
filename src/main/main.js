'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeTheme, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { JsonStore } = require('./store');
const { Library } = require('./library');
const { Nexus, GAME, SITE } = require('./nexus');
const game = require('./game');
const { isArchive } = require('./archive');
const { diagnose } = require('./diagnose');

const VERSION = app.getVersion();
let win = null;
let pendingNxm = [];

// ---------- single instance + nxm:// links ----------
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (_e, argv) => {
        const link = argv.find((a) => a.startsWith('nxm://'));
        if (link) handleNxm(link);
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}
app.on('open-url', (event, url) => {
    event.preventDefault();
    handleNxm(url);
});

// ---------- state ----------
if (process.env.PBZMM_DATA) app.setPath('userData', process.env.PBZMM_DATA);
const dataDir = app.getPath('userData');
const settings = new JsonStore(path.join(dataDir, 'settings.json'), {
    gameRoot: null,
    apiKeyEnc: null,
    apiKeyPlain: null,
    watchDownloads: true,
    downloadsDir: app.getPath('downloads'),
    showAdult: false,
    handleNxm: true,
    seenWelcome: false,
});

function getKey() {
    const enc = settings.get('apiKeyEnc');
    if (enc && safeStorage.isEncryptionAvailable()) {
        try {
            return safeStorage.decryptString(Buffer.from(enc, 'base64'));
        } catch {
            return null;
        }
    }
    return settings.get('apiKeyPlain') || null;
}

function setKey(key) {
    if (!key) {
        settings.patch({ apiKeyEnc: null, apiKeyPlain: null });
        return;
    }
    if (safeStorage.isEncryptionAvailable()) settings.patch({ apiKeyEnc: safeStorage.encryptString(key).toString('base64'), apiKeyPlain: null });
    else settings.patch({ apiKeyPlain: key, apiKeyEnc: null });
}

const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const library = new Library(dataDir, () => settings.data, send);
const nexus = new Nexus({ getKey, version: VERSION, cacheDir: path.join(dataDir, 'cache') });
const downloadsDir = path.join(dataDir, 'downloads');

// ---------- downloads ----------
const downloads = new Map(); // id -> record
let dlSeq = 0;

function publishDownloads() {
    send('downloads', [...downloads.values()].map(({ abort, ...d }) => d));
}

async function downloadAndInstall({ modId, fileId, nxm, meta }) {
    const id = `dl${++dlSeq}`;
    const controller = new AbortController();
    const rec = { id, modId, fileId, name: meta?.name || `Mod ${modId}`, fileName: meta?.fileName || '', state: 'starting', got: 0, total: 0, error: null, abort: controller };
    downloads.set(id, rec);
    publishDownloads();
    try {
        const url = await nexus.downloadLink(modId, fileId, nxm);
        rec.state = 'downloading';
        publishDownloads();
        const file = await nexus.download(url, downloadsDir, (got, total) => {
            rec.got = got;
            rec.total = total;
            publishDownloads();
        }, controller.signal);
        rec.state = 'installing';
        publishDownloads();
        let info = meta && meta.modInfo;
        if (!info) {
            try {
                info = await nexus.mod(modId);
            } catch {
                info = null;
            }
        }
        const result = await library.install(file, {
            name: info ? info.name : rec.name,
            version: (meta && meta.version) || (info && info.version) || '',
            author: info ? info.author : '',
            summary: info ? info.summary : '',
            picture: info ? info.thumb || info.picture : '',
            nexus: { modId: Number(modId), fileId: Number(fileId), fileName: path.basename(file), version: (meta && meta.version) || (info && info.version) || '' },
        });
        rec.state = 'done';
        rec.warnings = result.warnings;
        publishDownloads();
        send('toast', { text: `Installed ${result.mod.name}`, level: 'ok' });
        fs.rm(file, { force: true }, () => {});
    } catch (e) {
        rec.state = controller.signal.aborted ? 'cancelled' : 'error';
        rec.error = e.message;
        publishDownloads();
        if (!controller.signal.aborted) send('toast', { text: `${rec.name}: ${e.message}`, level: 'error' });
    }
}

function handleNxm(url) {
    if (!app.isReady() || !win) {
        pendingNxm.push(url);
        return;
    }
    const link = Nexus.parseNxm(url);
    if (!link) return send('toast', { text: 'Unrecognised nxm link', level: 'error' });
    if (link.game !== GAME) return send('toast', { text: `That link is for another game (${link.game}).`, level: 'error' });
    if (!getKey()) {
        send('toast', { text: 'Add your Nexus API key in Settings, then click the download button again.', level: 'error' });
        send('navigate', 'settings');
        return;
    }
    send('navigate', 'downloads');
    downloadAndInstall({ modId: link.modId, fileId: link.fileId, nxm: link, meta: {} });
}

// ---------- Downloads-folder watcher ----------
let watcher = null;
const seenFiles = new Set();
function startWatcher() {
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    if (!settings.get('watchDownloads')) return;
    const dir = settings.get('downloadsDir');
    try {
        for (const f of fs.readdirSync(dir)) seenFiles.add(f);
        watcher = fs.watch(dir, (_ev, name) => {
            if (!name || seenFiles.has(name) || !isArchive(name)) return;
            const full = path.join(dir, name);
            // wait until the browser has finished writing it
            let lastSize = -1;
            const check = setInterval(() => {
                fs.stat(full, (err, st) => {
                    if (err) return;
                    if (st.size > 0 && st.size === lastSize) {
                        clearInterval(check);
                        if (seenFiles.has(name)) return;
                        seenFiles.add(name);
                        if (/(-\d+){2,}/.test(name) || /pbz|phantom|blade/i.test(name)) send('found-download', { path: full, name });
                    }
                    lastSize = st.size;
                });
            }, 1500);
            setTimeout(() => clearInterval(check), 10 * 60 * 1000);
        });
    } catch {
        // folder missing
    }
}

// ---------- bundled mods ----------
function bundledDir() {
    return app.isPackaged ? path.join(process.resourcesPath, 'bundled') : path.join(__dirname, '..', '..', 'bundled');
}

function bundledMods() {
    const dir = bundledDir();
    try {
        return fs.readdirSync(dir)
            .filter((d) => fs.existsSync(path.join(dir, d, 'mod.json')))
            .map((d) => ({ ...JSON.parse(fs.readFileSync(path.join(dir, d, 'mod.json'), 'utf8')), dir: path.join(dir, d) }));
    } catch {
        return [];
    }
}

// ---------- IPC ----------
function handle(channel, fn) {
    ipcMain.handle(channel, async (_e, ...args) => {
        try {
            return { ok: true, value: await fn(...args) };
        } catch (e) {
            return { ok: false, error: e.message || String(e), code: e.code, status: e.status };
        }
    });
}

handle('app:info', () => ({ version: VERSION, platform: process.platform, nexusGame: GAME, nexusSite: SITE }));
handle('settings:get', () => ({ ...settings.data, apiKeyEnc: undefined, apiKeyPlain: undefined, hasApiKey: !!getKey() }));
handle('settings:set', (values) => {
    const allowed = ['watchDownloads', 'downloadsDir', 'showAdult', 'handleNxm', 'seenWelcome'];
    const patch = {};
    for (const k of allowed) if (k in values) patch[k] = values[k];
    settings.patch(patch);
    if ('watchDownloads' in patch || 'downloadsDir' in patch) startWatcher();
    if ('handleNxm' in patch) registerNxm();
    return true;
});

handle('game:detect', () => game.detectGame());
handle('game:info', () => (settings.get('gameRoot') ? game.gameInfo(settings.get('gameRoot')) : { valid: false, path: null }));
handle('game:set', async (dir) => {
    const root = game.normaliseGameRoot(dir);
    if (!root) throw new Error('That folder does not contain the game (no ProjectPBZ folder found).');
    settings.set('gameRoot', root);
    await library.sync();
    return game.gameInfo(root);
});
handle('game:browse', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Select the Phantom Blade Zero folder (the one with ProjectPBZ)', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
});
handle('game:launch', () => {
    const root = settings.get('gameRoot');
    if (!root) throw new Error('Set the game folder first.');
    return game.launch(root);
});
handle('game:open', (sub) => {
    const root = settings.get('gameRoot');
    if (!root) throw new Error('Set the game folder first.');
    return shell.openPath(sub ? path.join(root, sub) : root);
});
handle('game:diagnose', () => diagnose(settings.get('gameRoot'), library.mods(), library.db.get('deployed')));
handle('clipboard:write', (text) => {
    clipboard.writeText(String(text || ''));
    return true;
});
handle('game:logs', () => {
    const root = settings.get('gameRoot');
    const ev = root && path.join(root, 'ProjectPBZ', 'PBZModLoader', 'evidence');
    if (ev && fs.existsSync(ev)) return shell.openPath(ev);
    return shell.openPath(root || app.getPath('home'));
});

handle('library:list', () => library.list());
handle('library:enable', (id, on) => library.setEnabled(id, on));
handle('library:enableAll', (on) => library.setAllEnabled(on));
handle('library:reorder', (ids) => library.reorder(ids));
handle('library:remove', (id) => library.remove(id));
handle('library:rename', (id, name) => library.rename(id, name));
handle('library:purge', () => library.purge());
handle('library:sync', () => library.sync());
handle('library:adopt', (rel) => library.adopt(rel));
handle('library:files', (id) => library.modFiles(id));
handle('library:openFolder', (id) => shell.openPath(library.modFolder(id)));
handle('library:pickImport', async () => {
    const r = await dialog.showOpenDialog(win, {
        title: 'Import mods',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Mod archives', extensions: ['zip', '7z', 'rar', 'pak', 'dll'] }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? [] : r.filePaths;
});
handle('library:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import a mod folder', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
});
handle('library:import', (file, opts) => library.install(file, opts || {}));
handle('library:bundled', () => bundledMods().map(({ dir, ...m }) => ({ ...m, installed: library.mods().some((x) => x.bundled === m.id) })));
handle('library:installBundled', async (id) => {
    const m = bundledMods().find((b) => b.id === id);
    if (!m) throw new Error('Bundled mod not found');
    return library.install(path.join(m.dir, 'files'), { name: m.name, version: m.version, author: m.author, summary: m.summary, bundled: m.id, asIs: true });
});

handle('nexus:validate', async (key) => {
    if (key !== undefined) setKey(String(key || '').trim());
    if (!getKey()) return { user: null };
    return nexus.validate();
});
handle('nexus:clearKey', () => {
    setKey(null);
    nexus.user = null;
    return true;
});
handle('nexus:status', () => ({ user: nexus.user, limits: nexus.limits, hasKey: !!getKey() }));
handle('nexus:browse', (opts) => {
    if (process.env.PBZMM_FAKE_NEXUS) return require('../../test/fake-nexus.cjs').browse(opts);
    return nexus.browse({ ...opts, showAdult: settings.get('showAdult') });
});
handle('nexus:mod', (id) => nexus.mod(id));
handle('nexus:files', (id) => nexus.files(id));
handle('nexus:install', async (modId, fileId, meta) => {
    if (!nexus.user) await nexus.validate().catch(() => {});
    if (!nexus.user || !nexus.user.premium) {
        // free account: hand over to the website's Mod Manager Download button
        await shell.openExternal(`${SITE}/${GAME}/mods/${modId}?tab=files&file_id=${fileId}&nmm=1`);
        return { handedOff: true };
    }
    downloadAndInstall({ modId, fileId, meta });
    return { started: true };
});
handle('nexus:checkUpdates', async () => {
    const out = [];
    for (const m of library.mods()) {
        if (!m.nexus || !m.nexus.modId) continue;
        try {
            const info = await nexus.mod(m.nexus.modId);
            if (info.version && m.version && info.version !== m.version) out.push({ id: m.id, name: m.name, current: m.version, latest: info.version, modId: m.nexus.modId });
        } catch { /* skip */ }
    }
    return out;
});
handle('downloads:list', () => [...downloads.values()].map(({ abort, ...d }) => d));
handle('downloads:cancel', (id) => {
    const d = downloads.get(id);
    if (d && d.abort) d.abort.abort();
    return true;
});
handle('downloads:clear', () => {
    for (const [id, d] of downloads) if (['done', 'error', 'cancelled'].includes(d.state)) downloads.delete(id);
    publishDownloads();
    return true;
});
handle('shell:open', (url) => {
    if (/^https:\/\/[^\s]+$/i.test(String(url))) return shell.openExternal(String(url));
    throw new Error('Only web links can be opened.');
});

// ---------- window ----------
function registerNxm() {
    if (!settings.get('handleNxm')) {
        app.removeAsDefaultProtocolClient('nxm');
        return;
    }
    if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient('nxm', process.execPath, [path.resolve(process.argv[1])]);
    else app.setAsDefaultProtocolClient('nxm');
}

function createWindow() {
    nativeTheme.themeSource = 'dark';
    win = new BrowserWindow({
        width: 1320,
        height: 840,
        minWidth: 980,
        minHeight: 640,
        backgroundColor: '#0d0d10',
        title: 'PBZ Mod Manager',
        icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.webContents.on('did-finish-load', () => {
        const queued = pendingNxm.concat(process.argv.filter((a) => a.startsWith('nxm://')));
        pendingNxm = [];
        for (const l of queued) handleNxm(l);
        if (process.env.PBZMM_SHOT) screenshots(process.env.PBZMM_SHOT);
    });
}

// Developer aid: PBZMM_SHOT=<dir> saves screenshots of each view and quits.
async function screenshots(dir) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    fs.mkdirSync(dir, { recursive: true });
    const steps = (process.env.PBZMM_STEPS || 'library,store,settings').split(',');
    await wait(2500);
    for (const step of steps) {
        const [view, extra] = step.split(':');
        await win.webContents.executeJavaScript(`document.querySelector('[data-view="${view}"]').click()`);
        await wait(1200);
        if (extra === 'diag') {
            await win.webContents.executeJavaScript(`document.querySelector('.view:not([hidden]) [data-act="diagnose"]')?.click()`);
            await wait(1800);
        }
        if (extra === 'drawer') {
            await win.webContents.executeJavaScript(`document.querySelector('.view:not([hidden]) .mod-row, .view:not([hidden]) .tile')?.click()`);
            await wait(1500);
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `${step.replace(':', '-')}.png`), img.toPNG());
    }
    app.quit();
}

app.whenReady().then(async () => {
    // First run: auto-detect the game.
    if (!settings.get('gameRoot')) {
        const found = game.detectGame();
        if (found.length === 1) settings.set('gameRoot', found[0].path);
    }
    registerNxm();
    startWatcher();
    if (library.needsSync) library.sync().catch(() => {});
    // Keep bundled mods up to date: reinstall when the manager ships a newer copy.
    for (const b of bundledMods()) {
        const installed = library.mods().find((m) => m.bundled === b.id);
        if (installed && installed.version !== b.version) {
            library.install(path.join(b.dir, 'files'), { name: b.name, version: b.version, author: b.author, summary: b.summary, bundled: b.id, asIs: true })
                .then(() => send('toast', { text: `${b.name} updated to ${b.version}`, level: 'ok' }))
                .catch(() => {});
        }
    }
    createWindow();
    if (getKey()) nexus.validate().then(() => send('nexus-user', nexus.user)).catch(() => {});
});

app.on('window-all-closed', () => app.quit());
