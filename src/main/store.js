'use strict';
// Tiny JSON file store with atomic writes.
const fs = require('node:fs');
const path = require('node:path');

class JsonStore {
    constructor(file, defaults) {
        this.file = file;
        this.defaults = defaults;
        this.data = { ...defaults };
        try {
            const raw = fs.readFileSync(file, 'utf8');
            this.data = { ...defaults, ...JSON.parse(raw) };
        } catch {
            // first run or unreadable file: keep defaults
        }
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
    }

    patch(values) {
        Object.assign(this.data, values);
        this.save();
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
    }
}

module.exports = { JsonStore };
