'use strict';
// Host tests for install / deploy / conflicts / restore, on a fake game folder.
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
    if (req === 'electron') return 'electron';
    return origResolve.call(this, req, ...rest);
};
require.cache.electron = { id: 'electron', filename: 'electron', loaded: true, exports: { shell: { openExternal: async () => {}, openPath: async () => '' } } };

const { Library } = require('../src/main/library');
const sevenZip = require('7zip-bin').path7za;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbzmm-'));
const gameRoot = path.join(tmp, 'PBZ');
const write = (p, c = 'x') => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
};
write(path.join(gameRoot, 'ProjectPBZ', 'Content', 'Paks', 'pakchunk0.pak'), 'ORIGINAL');
write(path.join(gameRoot, 'platform', 'steam', 'PBZ.exe'), 'exe');
write(path.join(gameRoot, 'platform', 'steam', 'version.dll'), 'loader');
write(path.join(gameRoot, 'ProjectPBZ', 'PBZModLoader', 'mods.ini'), '[Loader]\nEnabled=1\n[Mods]\nFooMod=0\nOther=0\n');
write(path.join(gameRoot, 'ProjectPBZ', 'PBZModLoader', 'mods', 'HandMade', 'main.js'), 'hand');

function makeZip(name, files) {
    const src = fs.mkdtempSync(path.join(tmp, 'src-'));
    for (const [rel, content] of Object.entries(files)) write(path.join(src, rel), content);
    const zip = path.join(tmp, name);
    fs.chmodSync(sevenZip, 0o755);
    execFileSync(sevenZip, ['a', '-tzip', zip, '.'], { cwd: src, stdio: 'ignore' });
    return zip;
}

const settings = { gameRoot };
const lib = new Library(path.join(tmp, 'data'), () => settings, () => {});
const inGame = (rel) => path.join(gameRoot, ...rel.split('/'));
const read = (rel) => fs.readFileSync(inGame(rel), 'utf8');

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push(['PASS', name]);
    } catch (e) {
        results.push(['FAIL', name, e.stack]);
    }
}

(async () => {
    let foo, bar;
    await test('install loader mod from zip (wrapper folder)', async () => {
        const zip = makeZip('FooMod-12-1-0-1700000000.zip', { 'FooMod/main.js': 'foo v1', 'FooMod/config.js': 'cfg', 'readme.txt': 'r' });
        const r = await lib.install(zip);
        foo = r.mod;
        assert.equal(read('ProjectPBZ/PBZModLoader/mods/FooMod/main.js'), 'foo v1');
        assert.equal(foo.name, 'FooMod');
        assert.match(read('ProjectPBZ/PBZModLoader/mods.ini'), /FooMod=1/, 'switched on in mods.ini');
        assert.match(read('ProjectPBZ/PBZModLoader/mods.ini'), /Other=0/, 'other switches untouched');
    });

    await test('disable removes files, enable puts them back', async () => {
        await lib.setEnabled(foo.id, false);
        assert.equal(fs.existsSync(inGame('ProjectPBZ/PBZModLoader/mods/FooMod/main.js')), false);
        assert.equal(fs.existsSync(inGame('ProjectPBZ/PBZModLoader/mods/FooMod')), false, 'empty folder pruned');
        await lib.setEnabled(foo.id, true);
        assert.equal(read('ProjectPBZ/PBZModLoader/mods/FooMod/main.js'), 'foo v1');
    });

    await test('overwriting a game file backs it up and restores it', async () => {
        const zip = makeZip('pakfix.zip', { 'PBZ/ProjectPBZ/Content/Paks/pakchunk0.pak': 'MODDED', 'PBZ/platform/wegame/skip.dll': 'w' });
        bar = (await lib.install(zip, { name: 'Pak Fix' })).mod;
        assert.equal(read('ProjectPBZ/Content/Paks/pakchunk0.pak'), 'MODDED');
        assert.equal(fs.existsSync(inGame('platform/wegame/skip.dll')), false, 'other platform skipped');
        await lib.setEnabled(bar.id, false);
        assert.equal(read('ProjectPBZ/Content/Paks/pakchunk0.pak'), 'ORIGINAL');
    });

    await test('conflict: lower in list wins, and the other takes over when it is removed', async () => {
        await lib.setEnabled(bar.id, true);
        const zip = makeZip('pakfix2.zip', { 'ProjectPBZ/Content/Paks/pakchunk0.pak': 'MODDED-2' });
        const baz = (await lib.install(zip, { name: 'Pak Fix 2' })).mod;
        assert.equal(read('ProjectPBZ/Content/Paks/pakchunk0.pak'), 'MODDED-2');
        const listed = lib.list().mods.find((m) => m.id === bar.id);
        assert.equal(listed.overridden, 1);
        assert.equal(listed.conflicts.length, 1);
        // move Pak Fix to the bottom -> it wins
        await lib.reorder([foo.id, baz.id, bar.id]);
        assert.equal(read('ProjectPBZ/Content/Paks/pakchunk0.pak'), 'MODDED');
        await lib.remove(bar.id);
        assert.equal(read('ProjectPBZ/Content/Paks/pakchunk0.pak'), 'MODDED-2');
        await lib.remove(baz.id);
        assert.equal(read('ProjectPBZ/Content/Paks/pakchunk0.pak'), 'ORIGINAL');
    });

    await test('reinstalling the same Nexus mod updates in place and keeps on/off', async () => {
        const z1 = makeZip('n1.zip', { 'Tuning/Scripts/main.lua': 'v1' });
        const a = (await lib.install(z1, { name: 'Tuning', nexus: { modId: 602, fileId: 1 }, version: '1.0' })).mod;
        assert.equal(read('platform/steam/ue4ss/Mods/Tuning/Scripts/main.lua'), 'v1');
        assert.equal(fs.existsSync(inGame('platform/steam/ue4ss/Mods/Tuning/enabled.txt')), true, 'enabled.txt generated');
        await lib.setEnabled(a.id, false);
        const z2 = makeZip('n2.zip', { 'Tuning/Scripts/main.lua': 'v2' });
        const b = (await lib.install(z2, { nexus: { modId: 602, fileId: 2 }, version: '1.1' })).mod;
        assert.equal(b.id, a.id);
        assert.equal(b.enabled, false);
        assert.equal(lib.mods().filter((m) => m.nexus && m.nexus.modId === 602).length, 1);
        await lib.setEnabled(a.id, true);
        assert.equal(read('platform/steam/ue4ss/Mods/Tuning/Scripts/main.lua'), 'v2');
    });

    await test('unmanaged mods are listed and can be taken over', async () => {
        const um = lib.list().unmanaged;
        assert.ok(um.some((u) => u.name === 'HandMade'));
        await lib.adopt('ProjectPBZ/PBZModLoader/mods/HandMade');
        assert.ok(!lib.list().unmanaged.some((u) => u.name === 'HandMade'));
        const m = lib.mods().find((x) => x.name === 'HandMade');
        await lib.setEnabled(m.id, false);
        assert.equal(fs.existsSync(inGame('ProjectPBZ/PBZModLoader/mods/HandMade/main.js')), false);
        await lib.setEnabled(m.id, true);
        assert.equal(read('ProjectPBZ/PBZModLoader/mods/HandMade/main.js'), 'hand');
    });

    await test('incompatible mods are flagged', async () => {
        const souls = path.join(tmp, 'souls');
        write(path.join(souls, 'ProjectPBZ/PBZModLoader/mods/PBZSoulsMode/main.js'), 's');
        await lib.install(souls, { name: 'PBZ Souls Mode', asIs: true });
        const z = makeZip('bpr.zip', { 'ProjectPBZ/PBZModLoader/mods/PBZBossPhaseReset/main.js': 'b' });
        await lib.install(z, { name: 'PBZ Boss Phase Reset', nexus: { modId: 71, fileId: 9 } });
        const s = lib.list().mods.find((m) => m.name === 'PBZ Souls Mode');
        assert.equal(s.incompatible.length, 1);
    });

    await test('purge cleans the game folder, sync restores', async () => {
        await lib.purge();
        assert.equal(fs.existsSync(inGame('ProjectPBZ/PBZModLoader/mods/FooMod')), false);
        assert.equal(read('ProjectPBZ/Content/Paks/pakchunk0.pak'), 'ORIGINAL');
        await lib.sync();
        assert.equal(read('ProjectPBZ/PBZModLoader/mods/FooMod/main.js'), 'foo v1');
    });

    await test('rar/7z: 7z archive installs', async () => {
        const src = fs.mkdtempSync(path.join(tmp, 's7-'));
        write(path.join(src, 'Mod7/zzz_Mod7_P.pak'), 'p');
        const arc = path.join(tmp, 'mod7.7z');
        execFileSync(sevenZip, ['a', arc, '.'], { cwd: src, stdio: 'ignore' });
        await lib.install(arc);
        assert.equal(read('ProjectPBZ/Content/Paks/~mods/zzz_Mod7_P.pak'), 'p');
    });

    let failed = 0;
    for (const r of results) {
        console.log(`${r[0]}  ${r[1]}`);
        if (r[0] === 'FAIL') {
            failed++;
            console.log(r[2]);
        }
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
