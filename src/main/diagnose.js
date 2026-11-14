'use strict';
// "Why aren't my mods working?" — checks the game folder and reads the
// newest PBZModLoader log, then explains the result in plain language.
const fs = require('node:fs');
const path = require('node:path');
const game = require('./game');

const PROXIES = ['version.dll', 'hid.dll', 'winmm.dll', 'dsound.dll', 'dxgi.dll'];

function exists(p) {
    try {
        fs.accessSync(p);
        return true;
    } catch {
        return false;
    }
}

function read(p) {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return null;
    }
}

function newestRun(evidenceDir) {
    let runs = [];
    try {
        runs = fs.readdirSync(evidenceDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => {
                const dir = path.join(evidenceDir, d.name);
                let mtime = 0;
                try {
                    mtime = fs.statSync(dir).mtimeMs;
                } catch { /* ignore */ }
                return { name: d.name, dir, mtime };
            })
            .sort((a, b) => b.mtime - a.mtime);
    } catch {
        return null;
    }
    for (const run of runs) {
        let logs = [];
        try {
            logs = fs.readdirSync(run.dir).filter((f) => /^loader(\.\d+)?\.log$/i.test(f)).sort();
        } catch { /* ignore */ }
        if (logs.length) {
            const text = logs.map((f) => read(path.join(run.dir, f)) || '').join('\n');
            return { ...run, text, count: runs.length };
        }
    }
    return runs.length ? { ...runs[0], text: '', count: runs.length } : null;
}

/**
 * @param {string} root game root
 * @param {object[]} mods library entries
 * @param {object} deployed deployment record { rel: {modId,size} }
 */
function diagnose(root, mods, deployed) {
    const checks = [];
    const add = (status, title, detail, fix) => checks.push({ status, title, detail: detail || '', fix: fix || '' });

    if (!root || !game.isGameRoot(root)) {
        add('fail', 'Game folder not set', 'The manager does not know where the game is.', 'Settings › Find automatically, or Browse to the folder that holds ProjectPBZ.');
        return { checks, log: '', summary: checks[0].title };
    }
    const info = game.gameInfo(root);
    const exeDir = info.exeDir;
    const pz = path.join(root, 'ProjectPBZ');

    // 1. Right folder?
    if (info.exe) add('ok', 'Game folder', `${root}\nPBZ.exe found in platform\\${info.platform}.`);
    else add('fail', 'PBZ.exe not found', `No PBZ.exe in ${exeDir}.`, 'Pick the folder Steam actually launches: Steam › Phantom Blade Zero › Manage › Browse local files.');
    if (!info.steamAppId && info.platform === 'steam') {
        add('warn', 'Steam does not seem to own this folder', 'No Steam app manifest points at this folder, so this may be a copy or an old install.', 'Make sure this is the folder Steam opens with Manage › Browse local files.');
    }

    // 2. Loader entry DLLs next to PBZ.exe
    const entries = PROXIES.filter((d) => exists(path.join(exeDir, d)));
    const loaderFiles = {
        bootstrap: exists(path.join(pz, 'Content', 'JavaScript', 'PBZModLoader', 'bootstrap.js')),
        manager: exists(path.join(pz, 'Content', 'JavaScript', 'PBZModLoader', 'manager.js')),
        ini: exists(path.join(pz, 'PBZModLoader', 'mods.ini')),
        tsc: exists(path.join(pz, 'PBZModLoader', 'compiler', 'tsc.exe')),
    };
    const loaderPresent = loaderFiles.bootstrap || loaderFiles.ini;
    if (!loaderPresent) {
        add('fail', 'PBZModLoader is not installed', 'Script mods (including PBZ Souls Mode) need it.', 'Install PBZModLoader (Nexus mod 113) through the manager.');
    } else if (!entries.length) {
        add('fail', 'Loader DLL missing next to PBZ.exe', `PBZModLoader's files are there, but no version.dll (or other entry DLL) is in ${exeDir}. Without it the game never starts the loader. Antivirus often deletes this file.`, 'Allow the file in Windows Security › Protection history, then click "Re-apply all mods". Or reinstall PBZModLoader.');
    } else if (entries.length > 1) {
        add('warn', 'More than one entry DLL', `Found ${entries.join(', ')} next to PBZ.exe. PBZModLoader must use exactly one. Others may belong to ReShade or another mod.`, 'Keep version.dll for PBZModLoader; remove extra copies of its alternative DLLs.');
    } else {
        add('ok', 'Loader DLL in place', `${entries[0]} next to PBZ.exe.`);
    }
    if (loaderPresent && (!loaderFiles.bootstrap || !loaderFiles.manager || !loaderFiles.ini)) {
        add('fail', 'PBZModLoader is incomplete', `Missing: ${[!loaderFiles.bootstrap && 'bootstrap.js', !loaderFiles.manager && 'manager.js', !loaderFiles.ini && 'mods.ini'].filter(Boolean).join(', ')}.`, 'Reinstall PBZModLoader.');
    }
    if (loaderPresent && !loaderFiles.tsc) {
        add('warn', 'TypeScript compiler missing', 'Mods shipped as main.ts will not load (main.js mods are fine).', 'Reinstall PBZModLoader from its full main file.');
    }

    // 3. mods.ini switches
    const ini = read(path.join(pz, 'PBZModLoader', 'mods.ini')) || '';
    if (/^\s*Enabled\s*=\s*0\s*$/im.test(ini.split(/^\s*\[Mods\]/im)[0] || '')) {
        add('fail', 'Loader switched off', 'mods.ini has Enabled=0 under [Loader].', 'Set Enabled=1 in ProjectPBZ\\PBZModLoader\\mods.ini.');
    }
    const offIds = [...(ini.split(/^\s*\[Mods\]/im)[1] || '').matchAll(/^\s*([A-Za-z0-9_-]+)\s*=\s*0\s*$/gm)].map((m) => m[1]);

    // 4. Managed files actually in the game folder
    const missing = Object.keys(deployed || {}).filter((rel) => !exists(path.join(root, ...rel.split('/'))));
    if (missing.length) {
        add('fail', `${missing.length} mod file(s) missing from the game folder`, missing.slice(0, 6).join('\n') + (missing.length > 6 ? '\n…' : ''), 'Click "Re-apply all mods". If DLLs keep disappearing, allow them in your antivirus.');
    }

    // 5. Script mods present and not switched off
    const enabledLoaderMods = mods.filter((m) => m.enabled).flatMap((m) => (m.loaderModIds || []).map((id) => ({ id, name: m.name })));
    for (const m of enabledLoaderMods) {
        const dir = path.join(pz, 'PBZModLoader', 'mods', m.id);
        if (!exists(path.join(dir, 'main.js')) && !exists(path.join(dir, 'main.ts'))) {
            add('fail', `${m.name}: not in the game`, `No main.js in ProjectPBZ\\PBZModLoader\\mods\\${m.id}.`, 'Click "Re-apply all mods".');
        } else if (offIds.includes(m.id)) {
            add('fail', `${m.name}: switched off in mods.ini`, `${m.id}=0 under [Mods].`, 'Remove that line or set it to 1.');
        }
    }

    // 6. Did the loader run, and what did it say?
    const run = newestRun(path.join(pz, 'PBZModLoader', 'evidence'));
    let logTail = '';
    if (loaderPresent && entries.length) {
        if (!run) {
            add('fail', 'The loader has never run', 'There is no log in ProjectPBZ\\PBZModLoader\\evidence, so the game did not load the entry DLL.', 'Start the game from Steam (not a shortcut to another exe), check antivirus, and make sure this is the folder Steam launches. Then run this check again.');
        } else {
            const text = run.text;
            const when = new Date(run.mtime);
            logTail = text.split(/\r?\n/).slice(-80).join('\n');
            add('ok', 'The loader ran', `Last run: ${when.toLocaleString()} (${run.name}).`);
            const skipped = /MODs skipped: (.+?); original game continues/.exec(text);
            if (/MODs disabled by Loader\.Enabled=0/.test(text)) add('fail', 'Loader switched off', 'The log says Loader.Enabled=0.', 'Set Enabled=1 in mods.ini.');
            if (skipped) {
                add('fail', 'The loader skipped all mods', `The loader says: "${skipped[1]}". This usually means a game update the loader does not support yet.`, 'Update PBZModLoader to the newest version on Nexus (mod 113). If it is already newest, wait for a loader update.');
            }
            for (const m of text.matchAll(/MOD (\S+) skipped: (.+)/g)) add('fail', `Mod ${m[1]} failed to start`, m[2].trim(), 'Check that mod\'s page for a newer version or requirements.');
            const rejected = [...text.matchAll(/script (?:bytes|text) rejected: (.+)/g)].map((m) => m[1]);
            if (rejected.length) add('warn', 'Some script files were rejected', rejected.slice(0, 5).join('\n'), 'Reinstall the mod; the files may be damaged or edited.');
            if (!skipped && !/native hooks installed/.test(text)) add('warn', 'Loader did not finish starting', 'The log does not show "native hooks installed".', 'Send the log below to the mod author or to me.');
            const started = new Set([...text.matchAll(/\[PBZMOD\]\s+(\S+)/g)].map((m) => m[1]));
            for (const m of enabledLoaderMods) {
                if (started.has(m.id)) add('ok', `${m.name} is running`, 'It wrote to the loader log.');
            }
            const errors = text.split(/\r?\n/).filter((l) => /\bERROR\b|Error:|TypeError|ReferenceError|failed/.test(l)).slice(-8);
            if (errors.length) add('warn', 'Errors in the log', errors.join('\n'));
        }
    }

    const worst = checks.find((c) => c.status === 'fail') || checks.find((c) => c.status === 'warn');
    return {
        checks,
        log: logTail,
        summary: worst ? worst.title : 'Everything looks right',
        entries,
        platform: info.platform,
    };
}

module.exports = { diagnose };
