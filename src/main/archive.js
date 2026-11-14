'use strict';
// Extract .zip / .7z / .rar archives (7-Zip for zip/7z, unrar wasm for rar).
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function sevenZipPath() {
    const p = require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');
    try {
        if (process.platform !== 'win32') fs.chmodSync(p, 0o755);
    } catch {
        // read-only install: hope it is executable already
    }
    return p;
}

function run7z(args) {
    return new Promise((resolve, reject) => {
        execFile(sevenZipPath(), args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error((stderr || stdout || err.message).toString().trim().split('\n').slice(-3).join(' ')));
            else resolve(stdout.toString());
        });
    });
}

async function extractRar(file, target) {
    const { createExtractorFromFile } = require('node-unrar-js');
    const extractor = await createExtractorFromFile({ filepath: file, targetPath: target });
    const { files } = extractor.extract();
    // the iterator must be consumed for files to be written
    for (const f of files) void f;
}

/** Reject entries that would escape the target folder (zip-slip). */
function assertInside(target) {
    const root = fs.realpathSync(target);
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) {
                fs.rmSync(full, { force: true });
                continue;
            }
            const real = fs.realpathSync(full);
            if (!real.startsWith(root)) throw new Error(`Archive entry escapes the folder: ${entry.name}`);
            if (entry.isDirectory()) walk(full);
        }
    };
    walk(root);
}

async function extract(file, target) {
    fs.mkdirSync(target, { recursive: true });
    const ext = path.extname(file).toLowerCase();
    if (ext === '.rar') {
        await extractRar(file, target);
    } else if (['.zip', '.7z', '.tar', '.gz', '.xz'].includes(ext)) {
        await run7z(['x', '-y', `-o${target}`, file]);
    } else {
        throw new Error(`Unsupported archive type: ${ext || 'none'}`);
    }
    assertInside(target);
}

const ARCHIVE_EXTS = ['.zip', '.7z', '.rar'];
const isArchive = (file) => ARCHIVE_EXTS.includes(path.extname(file).toLowerCase());

module.exports = { extract, isArchive, ARCHIVE_EXTS };
