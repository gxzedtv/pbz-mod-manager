'use strict';
// Mod library: staged copies of every mod, plus deployment into the game.
//
// Each mod's files live in <library>/mods/<id>/files/ laid out relative to the
// game root. Enabling/disabling recomputes which files should be in the game
// (higher priority wins on conflicts) and applies only the difference.
// Game or user files that a mod overwrites are backed up and restored.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./store');
const { extract, isArchive } = require('./archive');
const { analyse, analyseAsIs, listFiles, KIND_LABELS } = require('./layout');
const game = require('./game');

// Mods known to clash with each other (same feature done two ways).
const INCOMPATIBLE = [
    {
        names: ['PBZSoulsMode', 'PBZBossPhaseReset', 'Bellbound', 'SoulsBlade0', 'Souls Blade', 'BellReturn', 'Phantom Souls'],
        nexus: [71, 73, 280],
        reason: 'Several mods change enemy respawns / boss phases. Use only one of them.',
    },
];

const rel2abs = (root, rel) => path.join(root, ...rel.split('/'));

function newId(name) {
    const slug = String(name || 'mod').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mod';
    return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
}

function cleanName(file) {
    let n = path.basename(file).replace(/\.(zip|7z|rar)$/i, '');
    n = n.replace(/-\d+-[\d-]+$/, ''); // Nexus "Name-123-1-0-1699999999"
    n = n.replace(/[_]+/g, ' ').trim();
    return n || 'Mod';
}

async function fileSize(p) {
    try {
        return (await fsp.stat(p)).size;
    } catch {
        return -1;
    }
}

async function pruneEmptyDirs(root, rels) {
    const dirs = new Set();
    for (const r of rels) {
        let d = path.dirname(rel2abs(root, r));
        while (d.startsWith(root) && d !== root) {
            dirs.add(d);
            d = path.dirname(d);
        }
    }
    const sorted = [...dirs].sort((a, b) => b.length - a.length);
    for (const d of sorted) {
        try {
            if ((await fsp.readdir(d)).length === 0) await fsp.rmdir(d);
        } catch {
            // not empty or gone
        }
    }
}

class Library {
    constructor(dataDir, getSettings, emit) {
        this.dir = path.join(dataDir, 'library');
        this.modsDir = path.join(this.dir, 'mods');
        this.backupDir = path.join(this.dir, 'backups');
        this.tmpDir = path.join(this.dir, 'tmp');
        fs.mkdirSync(this.modsDir, { recursive: true });
        this.db = new JsonStore(path.join(this.dir, 'library.json'), { mods: [], deployed: {}, backups: {}, gameRoot: null });
        this.getSettings = getSettings;
        this.emit = emit || (() => {});
        this.busy = Promise.resolve();
        this.migrate();
    }

    /** Clean up entries made by 1.0.0, which copied loader extras into the game. */
    migrate() {
        const junk = /^platform\/[^/]+\/(备用入口\/|PBZModLoader-Install\.cmd$)/;
        let changed = false;
        const mods = this.mods().map((m) => {
            const files = m.files.filter((f) => !junk.test(f));
            if (files.length === m.files.length) return m;
            changed = true;
            for (const f of m.files.filter((x) => junk.test(x))) {
                try { fs.rmSync(rel2abs(this.stagedRoot(m.id), f), { force: true }); } catch { /* ignore */ }
            }
            return { ...m, files, kinds: (m.kinds || []).filter((k) => k !== 'native' || files.some((f) => /^platform\//.test(f))) };
        });
        if (changed) {
            this.saveMods(mods);
            this.needsSync = true;
        }
    }

    /** Serialise all mutating operations. */
    queue(fn) {
        const next = this.busy.then(fn, fn);
        this.busy = next.catch(() => {});
        return next;
    }

    gameRoot() {
        const root = this.getSettings().gameRoot;
        return root && game.isGameRoot(root) ? root : null;
    }

    mods() {
        return this.db.get('mods');
    }

    find(id) {
        return this.mods().find((m) => m.id === id);
    }

    saveMods(mods) {
        this.db.set('mods', mods);
    }

    stagedRoot(id) {
        return path.join(this.modsDir, id, 'files');
    }

    // ---------- listing ----------

    list() {
        const deployed = this.db.get('deployed');
        const owners = {};
        for (const [rel, rec] of Object.entries(deployed)) owners[rel] = rec.modId;
        const mods = this.mods().map((m, index) => {
            const overridden = m.enabled ? m.files.filter((f) => owners[f] && owners[f] !== m.id).length : 0;
            return {
                ...m,
                files: undefined,
                fileCount: m.files.length,
                priority: index,
                kindLabels: (m.kinds || []).map((k) => KIND_LABELS[k] || k),
                overridden,
                conflicts: this.conflictsFor(m),
                incompatible: this.incompatibleWith(m),
            };
        });
        return { mods, gameRoot: this.gameRoot(), unmanaged: this.unmanaged() };
    }

    conflictsFor(mod) {
        if (!mod.enabled) return [];
        const mine = new Set(mod.files);
        const out = [];
        for (const other of this.mods()) {
            if (other.id === mod.id || !other.enabled) continue;
            const shared = other.files.filter((f) => mine.has(f) && !/enabled\.txt$/i.test(f));
            if (shared.length) out.push({ id: other.id, name: other.name, files: shared.length });
        }
        return out;
    }

    incompatibleWith(mod) {
        if (!mod.enabled) return [];
        const matches = (m, rule) => {
            const hay = [m.name, ...(m.loaderModIds || [])].join(' ').toLowerCase().replace(/[\s_-]+/g, '');
            return (m.nexus && rule.nexus.includes(Number(m.nexus.modId))) || rule.names.some((n) => hay.includes(n.toLowerCase().replace(/[\s_-]+/g, '')));
        };
        const out = [];
        for (const rule of INCOMPATIBLE) {
            if (!matches(mod, rule)) continue;
            for (const other of this.mods()) {
                if (other.id !== mod.id && other.enabled && matches(other, rule)) out.push({ id: other.id, name: other.name, reason: rule.reason });
            }
        }
        return out;
    }

    /** Mods present in the game folder that this manager did not install. */
    unmanaged() {
        const root = this.gameRoot();
        if (!root) return [];
        const deployed = this.db.get('deployed');
        const owned = (rel) => Object.keys(deployed).some((k) => k === rel || k.startsWith(`${rel}/`));
        const out = [];
        const scan = (relDir, kind, filter) => {
            const abs = rel2abs(root, relDir);
            let entries = [];
            try {
                entries = fs.readdirSync(abs, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                if (!filter(e)) continue;
                const rel = `${relDir}/${e.name}`;
                if (owned(rel)) continue;
                out.push({ rel, name: e.name, kind, label: KIND_LABELS[kind] });
            }
        };
        const plat = game.platformName(root);
        scan('ProjectPBZ/PBZModLoader/mods', 'loader', (e) => e.isDirectory());
        scan('ProjectPBZ/Content/JavaScript/PBZModsMenu/Mods', 'modsmenu', (e) => e.isDirectory() && !e.name.startsWith('_'));
        scan('ProjectPBZ/Content/Paks/~mods', 'pak', (e) => e.isFile() && /\.pak$/i.test(e.name));
        scan(`platform/${plat}/ue4ss/Mods`, 'ue4ss', (e) => e.isDirectory() && !['shared', 'Keybinds', 'ConsoleCommandsMod', 'ConsoleEnablerMod', 'BPModLoaderMod', 'BPML_GenericFunctions', 'CheatManagerEnablerMod', 'LineTraceMod', 'SplitScreenMod', 'jsbLuaProfilerMod'].includes(e.name));
        return out;
    }

    // ---------- install ----------

    /**
     * Install from an archive or folder.
     * @param {string} source path to .zip/.7z/.rar or a folder
     * @param {{name?: string, version?: string, author?: string, nexus?: object, picture?: string, summary?: string, asIs?: boolean, enable?: boolean, bundled?: boolean}} meta
     */
    install(source, meta = {}) {
        return this.queue(async () => {
            const root = this.gameRoot();
            const platform = root ? game.platformName(root) : 'steam';
            let work = source;
            let tmp = null;
            if (isArchive(source)) {
                tmp = path.join(this.tmpDir, crypto.randomBytes(6).toString('hex'));
                this.emit('status', { text: `Extracting ${path.basename(source)}…` });
                await extract(source, tmp);
                work = tmp;
            } else if (!fs.statSync(source).isDirectory()) {
                // single loose file (e.g. a .pak or .dll)
                tmp = path.join(this.tmpDir, crypto.randomBytes(6).toString('hex'));
                await fsp.mkdir(tmp, { recursive: true });
                await fsp.copyFile(source, path.join(tmp, path.basename(source)));
                work = tmp;
            }
            try {
                const name = meta.name || cleanName(source);
                const plan = meta.asIs ? analyseAsIs(work) : analyse(work, { platform, fallbackName: name });
                if (plan.files.length === 0 && plan.generated.length === 0) {
                    const err = new Error(plan.warnings.join(' ') || 'Nothing to install.');
                    err.code = 'NO_LAYOUT';
                    throw err;
                }

                // Update an existing entry for the same Nexus mod or name.
                const mods = this.mods();
                let existing = null;
                if (meta.nexus && meta.nexus.modId) existing = mods.find((m) => m.nexus && Number(m.nexus.modId) === Number(meta.nexus.modId));
                if (!existing && meta.bundled) existing = mods.find((m) => m.bundled === meta.bundled);
                if (!existing && meta.replaceId) existing = mods.find((m) => m.id === meta.replaceId);

                const id = existing ? existing.id : newId(name);
                const staged = this.stagedRoot(id);
                await fsp.rm(staged, { recursive: true, force: true });
                await fsp.mkdir(staged, { recursive: true });
                for (const f of plan.files) {
                    const dest = rel2abs(staged, f.to);
                    await fsp.mkdir(path.dirname(dest), { recursive: true });
                    await fsp.copyFile(rel2abs(work, f.from), dest);
                }
                for (const g of plan.generated) {
                    const dest = rel2abs(staged, g.to);
                    await fsp.mkdir(path.dirname(dest), { recursive: true });
                    await fsp.writeFile(dest, g.content);
                }
                const files = listFiles(staged);
                const entry = {
                    id,
                    name: existing && !meta.name ? existing.name : name,
                    version: meta.version || (existing && existing.version) || '',
                    author: meta.author || (existing && existing.author) || '',
                    summary: meta.summary || (existing && existing.summary) || '',
                    picture: meta.picture || (existing && existing.picture) || '',
                    nexus: meta.nexus || (existing && existing.nexus) || null,
                    bundled: meta.bundled || (existing && existing.bundled) || null,
                    kinds: plan.kinds,
                    loaderModIds: plan.loaderModIds,
                    ue4ssMods: plan.ue4ssMods,
                    warnings: plan.warnings,
                    files,
                    enabled: existing ? existing.enabled : meta.enable !== false,
                    installedAt: existing ? existing.installedAt : new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    source: meta.nexus ? 'nexus' : meta.bundled ? 'bundled' : 'import',
                };
                if (existing) mods[mods.indexOf(existing)] = entry;
                else mods.push(entry);
                this.saveMods(mods);
                await this.syncNow();
                return { ok: true, mod: { ...entry, files: undefined, fileCount: files.length }, warnings: plan.warnings };
            } finally {
                if (tmp) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
            }
        });
    }

    /** Take over a mod that was installed by hand. */
    adopt(rel) {
        return this.queue(async () => {
            const root = this.gameRoot();
            if (!root) throw new Error('Set the game folder first.');
            const abs = rel2abs(root, rel);
            const stat = await fsp.stat(abs);
            const name = path.basename(rel).replace(/\.pak$/i, '');
            const id = newId(name);
            const staged = this.stagedRoot(id);
            const relFiles = [];
            if (stat.isDirectory()) {
                for (const f of listFiles(abs)) relFiles.push(`${rel}/${f}`);
            } else {
                relFiles.push(rel);
                // IoStore companions
                for (const extn of ['.utoc', '.ucas', '.sig']) {
                    const companion = rel.replace(/\.pak$/i, extn);
                    if (fs.existsSync(rel2abs(root, companion))) relFiles.push(companion);
                }
            }
            const deployed = this.db.get('deployed');
            for (const r of relFiles) {
                const dest = rel2abs(staged, r);
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                await fsp.copyFile(rel2abs(root, r), dest);
                deployed[r] = { modId: id, size: await fileSize(rel2abs(root, r)) };
            }
            const kind = rel.includes('/PBZModLoader/') ? 'loader' : rel.includes('PBZModsMenu') ? 'modsmenu' : rel.includes('/ue4ss/') ? 'ue4ss' : 'pak';
            const mods = this.mods();
            mods.push({
                id, name, version: '', author: '', summary: '', picture: '', nexus: null, bundled: null,
                kinds: [kind], loaderModIds: kind === 'loader' ? [path.basename(rel)] : [], ue4ssMods: kind === 'ue4ss' ? [path.basename(rel)] : [],
                warnings: [], files: relFiles, enabled: true,
                installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), source: 'adopted',
            });
            this.db.patch({ mods, deployed });
            return { ok: true };
        });
    }

    // ---------- state changes ----------

    setEnabled(id, enabled) {
        return this.queue(async () => {
            const mods = this.mods();
            const m = mods.find((x) => x.id === id);
            if (!m) throw new Error('Mod not found');
            m.enabled = !!enabled;
            this.saveMods(mods);
            await this.syncNow();
            return { ok: true };
        });
    }

    setAllEnabled(enabled) {
        return this.queue(async () => {
            const mods = this.mods().map((m) => ({ ...m, enabled: !!enabled }));
            this.saveMods(mods);
            await this.syncNow();
            return { ok: true };
        });
    }

    reorder(ids) {
        return this.queue(async () => {
            const byId = new Map(this.mods().map((m) => [m.id, m]));
            const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
            for (const m of byId.values()) if (!ordered.includes(m)) ordered.push(m);
            this.saveMods(ordered);
            await this.syncNow();
            return { ok: true };
        });
    }

    rename(id, name) {
        const mods = this.mods();
        const m = mods.find((x) => x.id === id);
        if (m && name) {
            m.name = String(name).slice(0, 120);
            this.saveMods(mods);
        }
        return { ok: true };
    }

    remove(id) {
        return this.queue(async () => {
            this.saveMods(this.mods().filter((m) => m.id !== id));
            await this.syncNow();
            await fsp.rm(path.join(this.modsDir, id), { recursive: true, force: true });
            return { ok: true };
        });
    }

    /** Remove every managed file from the game and restore backups. */
    purge() {
        return this.queue(async () => {
            const mods = this.mods();
            const saved = mods.map((m) => m.enabled);
            mods.forEach((m) => { m.enabled = false; });
            this.saveMods(mods);
            await this.syncNow();
            mods.forEach((m, i) => { m.enabled = saved[i]; });
            this.saveMods(mods);
            return { ok: true };
        });
    }

    sync() {
        return this.queue(() => this.syncNow());
    }

    // ---------- deployment ----------

    async syncNow() {
        const root = this.gameRoot();
        if (!root) return { ok: false, error: 'Game folder not set' };

        // If the game folder changed, forget the old deployment record.
        if (this.db.get('gameRoot') !== root) this.db.patch({ gameRoot: root, deployed: {}, backups: {} });

        const desired = new Map(); // rel -> modId (later = higher priority)
        for (const m of this.mods()) {
            if (!m.enabled) continue;
            for (const f of m.files) desired.set(f, m.id);
        }
        const deployed = { ...this.db.get('deployed') };
        const backups = { ...this.db.get('backups') };
        const errors = [];
        const removed = [];

        // Remove files no longer wanted (or now owned by another mod).
        for (const [rel, rec] of Object.entries(deployed)) {
            const want = desired.get(rel);
            if (want === rec.modId) continue;
            const abs = rel2abs(root, rel);
            try {
                await fsp.rm(abs, { force: true });
                delete deployed[rel];
                removed.push(rel);
                if (!want && backups[rel]) {
                    const bak = rel2abs(this.backupDir, rel);
                    await fsp.mkdir(path.dirname(abs), { recursive: true });
                    await fsp.rename(bak, abs).catch(async () => {
                        await fsp.copyFile(bak, abs);
                        await fsp.rm(bak, { force: true });
                    });
                    delete backups[rel];
                }
            } catch (e) {
                errors.push(`${rel}: ${e.code === 'EBUSY' || e.code === 'EPERM' ? 'file in use (close the game)' : e.message}`);
            }
        }

        // Copy wanted files.
        let copied = 0;
        const total = desired.size;
        let n = 0;
        for (const [rel, modId] of desired) {
            n++;
            const src = rel2abs(this.stagedRoot(modId), rel);
            const abs = rel2abs(root, rel);
            const rec = deployed[rel];
            const srcSize = await fileSize(src);
            if (rec && rec.modId === modId && (await fileSize(abs)) === srcSize && rec.size === srcSize) continue;
            try {
                if (!rec && fs.existsSync(abs) && !backups[rel]) {
                    // an original game / user file: keep it safe
                    const bak = rel2abs(this.backupDir, rel);
                    await fsp.mkdir(path.dirname(bak), { recursive: true });
                    await fsp.copyFile(abs, bak);
                    backups[rel] = true;
                }
                await fsp.mkdir(path.dirname(abs), { recursive: true });
                await fsp.copyFile(src, abs);
                deployed[rel] = { modId, size: srcSize };
                copied++;
                if (copied % 25 === 0) this.emit('status', { text: `Deploying ${n}/${total}…` });
            } catch (e) {
                errors.push(`${rel}: ${e.code === 'EBUSY' || e.code === 'EPERM' ? 'file in use (close the game)' : e.message}`);
            }
        }

        this.db.patch({ deployed, backups });
        await pruneEmptyDirs(root, removed);
        await this.fixLoaderSwitches(root);
        this.emit('library-changed', {});
        if (errors.length) this.emit('status', { text: `Some files could not be updated (${errors.length}).`, level: 'warn' });
        return { ok: errors.length === 0, copied, removed: removed.length, errors };
    }

    /**
     * Script loaders keep their own on/off lists. Make sure enabled mods are
     * not switched off there (e.g. "MyMod=0" left from an earlier manual edit).
     */
    async fixLoaderSwitches(root) {
        const enabledIds = new Set();
        for (const m of this.mods()) if (m.enabled) for (const id of m.loaderModIds || []) enabledIds.add(id);
        if (enabledIds.size === 0) return;
        const files = [
            path.join(root, 'ProjectPBZ', 'PBZModLoader', 'mods.ini'),
            path.join(root, 'ProjectPBZ', 'Content', 'Paks', '~mods', 'PBZModsMenuLoader.txt'),
        ];
        for (const file of files) {
            let text;
            try {
                text = await fsp.readFile(file, 'utf8');
            } catch {
                continue;
            }
            let changed = false;
            const out = text.replace(/^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)0(\s*)$/gm, (line, a, id, eq, tail) => {
                if (!enabledIds.has(id)) return line;
                changed = true;
                return `${a}${id}${eq}1${tail}`;
            });
            if (changed) await fsp.writeFile(file, out);
        }
    }

    /** Where a mod's files are in the game folder (for "Open folder"). */
    modFolder(id) {
        const m = this.find(id);
        const root = this.gameRoot();
        if (!m || !root || !m.files.length) return root;
        const dirs = m.files.map((f) => f.split('/').slice(0, -1));
        let common = dirs[0];
        for (const d of dirs) {
            let i = 0;
            while (i < common.length && i < d.length && common[i] === d[i]) i++;
            common = common.slice(0, i);
        }
        return rel2abs(root, common.join('/') || '.');
    }

    modFiles(id) {
        const m = this.find(id);
        return m ? m.files : [];
    }
}

module.exports = { Library };
