'use strict';
// Work out where the files of an extracted mod belong in the game folder.
// Output paths are relative to the game root (the folder holding ProjectPBZ).
const fs = require('node:fs');
const path = require('node:path');

const JUNK = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini']);
const DOC_EXT = new Set(['.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.url', '.html', '.htm', '.rtf', '.docx']);
const PAK_EXT = new Set(['.pak', '.utoc', '.ucas', '.sig']);

/** All files under dir as forward-slash relative paths. */
function listFiles(dir) {
    const out = [];
    const walk = (abs, rel) => {
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
            if (JUNK.has(entry.name)) continue;
            const r = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(abs, entry.name), r);
            else if (entry.isFile()) out.push(r);
        }
    };
    walk(dir, '');
    return out;
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const ext = (p) => path.extname(p).toLowerCase();
const lower = (p) => p.toLowerCase();

function safeFolderName(name) {
    return String(name || 'Mod').replace(/[^A-Za-z0-9_-]+/g, '') || 'Mod';
}

/**
 * @param {string} dir extracted folder
 * @param {{platform?: string, fallbackName?: string}} opts
 * @returns {{kinds: string[], files: {from: string, to: string}[], generated: {to: string, content: string}[], warnings: string[], loaderModIds: string[], ue4ssMods: string[]}}
 */
function analyse(dir, opts = {}) {
    const platform = opts.platform || 'steam';
    const otherPlatform = platform === 'steam' ? 'wegame' : 'steam';
    const all = listFiles(dir);
    const files = [];
    const generated = [];
    const warnings = [];
    const kinds = new Set();
    const loaderModIds = new Set();
    const ue4ssMods = new Set();
    const assigned = new Set();
    const take = (from, to) => {
        if (assigned.has(from)) return;
        assigned.add(from);
        files.push({ from, to });
    };

    if (all.length === 0) return { kinds: [], files, generated, warnings: ['The archive is empty.'], loaderModIds: [], ue4ssMods: [] };

    // 1) Game-root layout: some folder holds ProjectPBZ/ and/or platform/.
    const rootPrefixes = new Set();
    for (const f of all) {
        const parts = f.split('/');
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = lower(parts[i]);
            if (seg === 'projectpbz' || (seg === 'platform' && ['steam', 'wegame'].includes(lower(parts[i + 1] || '')))) {
                rootPrefixes.add(parts.slice(0, i).join('/'));
                break;
            }
        }
    }
    if (rootPrefixes.size > 0) {
        // shallowest prefix wins
        const prefix = [...rootPrefixes].sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)[0];
        const pre = prefix ? `${prefix}/` : '';
        for (const f of all) {
            if (pre && !f.startsWith(pre)) continue;
            const rel = f.slice(pre.length);
            const first = lower(rel.split('/')[0]);
            if (first === 'projectpbz') {
                take(f, 'ProjectPBZ' + rel.slice('ProjectPBZ'.length));
                kinds.add('game');
                const m = /^projectpbz\/pbzmodloader\/mods\/([^/]+)\//i.exec(rel);
                if (m) loaderModIds.add(m[1]);
                const mm = /^projectpbz\/content\/javascript\/pbzmodsmenu\/mods\/([^/]+)\//i.exec(rel);
                if (mm) kinds.add('modsmenu');
                if (/^projectpbz\/content\/paks\//i.test(rel)) kinds.add('pak');
            } else if (first === 'platform') {
                const plat = lower(rel.split('/')[1] || '');
                if (plat === otherPlatform) {
                    assigned.add(f); // other store's copy: skip
                    continue;
                }
                take(f, 'platform' + rel.slice('platform'.length));
                kinds.add('game');
                if (/\/ue4ss\/mods\/[^/]+\//i.test(rel)) {
                    kinds.add('ue4ss');
                    const m = /\/ue4ss\/mods\/([^/]+)\//i.exec(rel);
                    if (m) ue4ssMods.add(m[1]);
                }
            }
        }
        if (/projectpbz\/pbzmodloader\/mods\//i.test(all.join('\n'))) kinds.add('loader');
    }

    const rest = all.filter((f) => !assigned.has(f));

    // 2) UE4SS mod folders: <Name>/Scripts/main.lua, <Name>/enabled.txt, <Name>/dlls/main.dll
    const ue4ssDirs = new Set();
    for (const f of rest) {
        const l = lower(f);
        for (const marker of ['scripts/main.lua', 'dlls/main.dll']) {
            if (l === marker || l.endsWith(`/${marker}`)) ue4ssDirs.add(f.slice(0, f.length - marker.length).replace(/\/$/, ''));
        }
    }
    for (const d of ue4ssDirs) {
        const name = d ? base(d) : safeFolderName(opts.fallbackName);
        const pre = d ? `${d}/` : '';
        let hasEnabled = false;
        for (const f of rest) {
            if (pre && !f.startsWith(pre)) continue;
            if (!pre && !f.includes('/') && DOC_EXT.has(ext(f))) continue;
            const rel = f.slice(pre.length);
            if (lower(rel) === 'enabled.txt') hasEnabled = true;
            take(f, `platform/${platform}/ue4ss/Mods/${name}/${rel}`);
        }
        if (!hasEnabled) generated.push({ to: `platform/${platform}/ue4ss/Mods/${name}/enabled.txt`, content: '' });
        ue4ssMods.add(name);
        kinds.add('ue4ss');
    }

    // 3) Script mods: a folder with main.js / main.ts
    const rest2 = all.filter((f) => !assigned.has(f));
    const jsDirs = new Set();
    for (const f of rest2) {
        if (/^main\.(js|ts)$/i.test(base(f))) jsDirs.add(dirOf(f));
    }
    // keep only the outermost main.js folders
    const outer = [...jsDirs].filter((d) => ![...jsDirs].some((o) => o !== d && (o === '' || d.startsWith(`${o}/`))));
    for (const d of outer) {
        const inMenu = /pbzmodsmenu\/mods$/i.test(dirOf(d));
        const name = d ? base(d) : safeFolderName(opts.fallbackName);
        const pre = d ? `${d}/` : '';
        const target = inMenu
            ? `ProjectPBZ/Content/JavaScript/PBZModsMenu/Mods/${name}`
            : `ProjectPBZ/PBZModLoader/mods/${name}`;
        for (const f of rest2) {
            if (pre && !f.startsWith(pre)) continue;
            if (!pre && DOC_EXT.has(ext(f)) && !f.includes('/')) continue;
            take(f, `${target}/${f.slice(pre.length)}`);
        }
        if (inMenu) kinds.add('modsmenu');
        else {
            kinds.add('loader');
            loaderModIds.add(name);
        }
    }

    // 4) PAK / IoStore files
    for (const f of all) {
        if (assigned.has(f) || !PAK_EXT.has(ext(f))) continue;
        take(f, `ProjectPBZ/Content/Paks/~mods/${base(f)}`);
        kinds.add('pak');
    }

    // 5) Native files (ReShade, DLL plugins, config): next to PBZ.exe
    // Files outside a game-root layout (installers, "alternative entry" DLL
    // folders, extras) are never auto-placed: the author's layout is the plan.
    const ALT_DIR = /(^|\/)(备用入口|alternative[^/]*|optional[^/]*|extras?|alt)\//i;
    const rest3 = all.filter((f) => !assigned.has(f) && !ALT_DIR.test(f) && !/\.(cmd|bat|ps1|exe)$/i.test(f));
    const nativeHint = rootPrefixes.size === 0 && rest3.some((f) => ['.dll', '.asi', '.fx', '.fxh', '.ini', '.addon', '.addon64'].includes(ext(f)));
    if (nativeHint) {
        // strip a single wrapper folder if everything shares it
        const tops = new Set(rest3.map((f) => f.split('/')[0]));
        const wrapper = tops.size === 1 && rest3.every((f) => f.includes('/')) ? `${[...tops][0]}/` : '';
        for (const f of rest3) {
            const rel = f.slice(wrapper.length);
            if (!rel.includes('/') && DOC_EXT.has(ext(rel))) continue;
            take(f, `platform/${platform}/${rel}`);
        }
        kinds.add('native');
        warnings.push('Some files go next to PBZ.exe. Check the mod page if it needs a specific place.');
    }

    const leftovers = all.filter((f) => !assigned.has(f) && !DOC_EXT.has(ext(f)) && !ALT_DIR.test(f) && !/\.(cmd|bat|ps1)$/i.test(f));
    if (files.length === 0) warnings.push('Could not tell where this mod goes. Use "Install as-is" if it should be copied straight into the game folder.');
    else if (leftovers.length) warnings.push(`${leftovers.length} file(s) were not placed: ${leftovers.slice(0, 3).join(', ')}${leftovers.length > 3 ? '…' : ''}`);

    return { kinds: [...kinds], files, generated, warnings, loaderModIds: [...loaderModIds], ue4ssMods: [...ue4ssMods] };
}

/** Copy everything 1:1 into the game root (manual override). */
function analyseAsIs(dir) {
    const files = listFiles(dir).filter((f) => !(DOC_EXT.has(ext(f)) && !f.includes('/'))).map((f) => ({ from: f, to: f }));
    return { kinds: ['game'], files, generated: [], warnings: ['Installed as-is into the game folder.'], loaderModIds: [], ue4ssMods: [] };
}

const KIND_LABELS = {
    loader: 'Script (PBZModLoader)',
    modsmenu: 'Script (Mods Menu)',
    pak: 'PAK',
    ue4ss: 'UE4SS',
    native: 'Native / DLL',
    game: 'Game files',
};

module.exports = { analyse, analyseAsIs, listFiles, KIND_LABELS, safeFolderName };
