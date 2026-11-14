'use strict';
// Find and inspect the Phantom Blade Zero installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { shell } = require('electron');

const GAME_DIR_NAMES = ['PBZ', 'Phantom Blade Zero', 'PhantomBladeZero'];

function exists(p) {
    try {
        fs.accessSync(p);
        return true;
    } catch {
        return false;
    }
}

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** A game root is the folder that holds ProjectPBZ. */
function isGameRoot(dir) {
    return !!dir && isDir(path.join(dir, 'ProjectPBZ'));
}

/** Accept the root, ProjectPBZ itself, or the folder with PBZ.exe. */
function normaliseGameRoot(dir) {
    if (!dir) return null;
    let current = path.resolve(dir);
    for (let i = 0; i < 4; i++) {
        if (isGameRoot(current)) return current;
        if (path.basename(current) === 'ProjectPBZ' && isDir(current)) return path.dirname(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

/** Parse Steam's libraryfolders.vdf just enough to get library paths. */
function steamLibraries(steamRoot) {
    const libs = new Set([steamRoot]);
    const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
    try {
        const text = fs.readFileSync(vdf, 'utf8');
        const re = /"path"\s+"([^"]+)"/g;
        let m;
        while ((m = re.exec(text))) libs.add(m[1].replace(/\\\\/g, '\\'));
    } catch {
        // no vdf
    }
    return [...libs];
}

function steamRoots() {
    const roots = [];
    const home = os.homedir();
    if (process.platform === 'win32') {
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        roots.push(path.join(pf86, 'Steam'), path.join(pf, 'Steam'));
        for (const letter of 'CDEFGHIJ') {
            roots.push(`${letter}:\\Steam`, `${letter}:\\SteamLibrary`, `${letter}:\\Games\\Steam`, `${letter}:\\Program Files (x86)\\Steam`);
        }
    } else if (process.platform === 'darwin') {
        roots.push(path.join(home, 'Library', 'Application Support', 'Steam'));
        // Windows Steam inside CrossOver / Whisky bottles
        const bottleHomes = [
            path.join(home, 'Library', 'Application Support', 'CrossOver', 'Bottles'),
            path.join(home, 'Library', 'Containers', 'com.isaacmarovitz.Whisky', 'Bottles'),
        ];
        for (const bottles of bottleHomes) {
            try {
                for (const b of fs.readdirSync(bottles)) {
                    roots.push(path.join(bottles, b, 'drive_c', 'Program Files (x86)', 'Steam'));
                    roots.push(path.join(bottles, b, 'drive_c', 'Program Files', 'Steam'));
                }
            } catch {
                // no bottles
            }
        }
    } else {
        roots.push(path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'));
    }
    return roots.filter(isDir);
}

/** Look for the game in all Steam libraries and common folders. */
function detectGame() {
    const found = [];
    const add = (p, source) => {
        const root = normaliseGameRoot(p);
        if (root && !found.some((f) => f.path === root)) found.push({ path: root, source });
    };
    for (const steam of steamRoots()) {
        for (const lib of steamLibraries(steam)) {
            for (const name of GAME_DIR_NAMES) add(path.join(lib, 'steamapps', 'common', name), 'Steam');
        }
    }
    if (process.platform === 'win32') {
        for (const letter of 'CDEFGHIJ') {
            for (const name of GAME_DIR_NAMES) {
                add(`${letter}:\\WeGameApps\\${name}`, 'WeGame');
                add(`${letter}:\\Games\\${name}`, 'Folder');
            }
        }
    }
    return found;
}

/** Folder that holds PBZ.exe (platform/steam or platform/wegame). */
function exeDir(root) {
    for (const p of ['steam', 'wegame']) {
        const dir = path.join(root, 'platform', p);
        if (isDir(dir)) return dir;
    }
    return path.join(root, 'platform', 'steam');
}

function platformName(root) {
    return path.basename(exeDir(root));
}

/** Steam app id from the appmanifest that installs this folder. */
function steamAppId(root) {
    const common = path.dirname(root);
    const steamapps = path.dirname(common);
    try {
        for (const f of fs.readdirSync(steamapps)) {
            if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
            const text = fs.readFileSync(path.join(steamapps, f), 'utf8');
            const dir = /"installdir"\s+"([^"]+)"/.exec(text);
            if (dir && dir[1].toLowerCase() === path.basename(root).toLowerCase()) {
                const id = /"appid"\s+"(\d+)"/.exec(text);
                if (id) return id[1];
            }
        }
    } catch {
        // not a Steam layout
    }
    return null;
}

function readText(p) {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return null;
    }
}

/** What frameworks are installed: loaders the other mods depend on. */
function frameworks(root) {
    const exe = exeDir(root);
    const pz = path.join(root, 'ProjectPBZ');
    const loaderDir = path.join(pz, 'PBZModLoader');
    const loaderDll = ['version.dll', 'hid.dll', 'winmm.dll', 'dsound.dll', 'dxgi.dll'].find((d) => exists(path.join(exe, d)));
    const loaderVersion = (() => {
        const ini = readText(path.join(loaderDir, 'mods.ini'));
        const m = ini && /^\s*Version\s*=\s*(.+)$/im.exec(ini);
        return m ? m[1].trim() : null;
    })();
    return {
        pbzModLoader: {
            installed: isDir(loaderDir) && exists(path.join(pz, 'Content', 'JavaScript', 'PBZModLoader')),
            entry: loaderDll || null,
            version: loaderVersion,
            nexusId: 113,
        },
        modsMenu: {
            installed: isDir(path.join(pz, 'Content', 'JavaScript', 'PBZModsMenu')),
            nexusId: 149,
        },
        ue4ss: {
            installed: isDir(path.join(exe, 'ue4ss')) || exists(path.join(exe, 'UE4SS.dll')),
        },
        reshade: {
            installed: exists(path.join(exe, 'ReShade.ini')),
        },
    };
}

function gameInfo(root) {
    if (!isGameRoot(root)) return { valid: false, path: root };
    const exe = exeDir(root);
    return {
        valid: true,
        path: root,
        exeDir: exe,
        exe: exists(path.join(exe, 'PBZ.exe')) ? path.join(exe, 'PBZ.exe') : null,
        platform: platformName(root),
        steamAppId: steamAppId(root),
        frameworks: frameworks(root),
    };
}

async function launch(root) {
    const id = steamAppId(root);
    if (id) {
        await shell.openExternal(`steam://rungameid/${id}`);
        return { ok: true, via: 'steam' };
    }
    const exe = path.join(exeDir(root), 'PBZ.exe');
    if (exists(exe) && process.platform === 'win32') {
        const err = await shell.openPath(exe);
        return err ? { ok: false, error: err } : { ok: true, via: 'exe' };
    }
    return { ok: false, error: 'Start the game from Steam (no Steam app id or PBZ.exe found).' };
}

module.exports = { detectGame, normaliseGameRoot, isGameRoot, gameInfo, exeDir, platformName, launch };
