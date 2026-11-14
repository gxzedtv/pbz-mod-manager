'use strict';
// Nexus Mods client: v2 GraphQL for browsing/search, v1 REST for files and
// download links. Downloads need a personal API key; direct downloads from
// the API need Nexus Premium, otherwise the "Mod Manager Download" button on
// the website hands us a one-time key through an nxm:// link.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const GAME = 'phantombladezero';
const REST = 'https://api.nexusmods.com/v1';
const GQL = 'https://api.nexusmods.com/v2/graphql';
const SITE = 'https://www.nexusmods.com';
const APP_NAME = 'PBZ Mod Manager';

const SORTS = {
    trending: 'downloads',
    endorsed: 'endorsements',
    downloads: 'downloads',
    latest: 'createdAt',
    updated: 'updatedAt',
};

class NexusError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

class Nexus {
    constructor({ getKey, version, cacheDir }) {
        this.getKey = getKey;
        this.version = version;
        this.cacheDir = cacheDir;
        this.cache = new Map();
        this.gqlStyle = null; // remembered working query shape
        this.limits = null;
        this.user = null;
    }

    headers(extra = {}) {
        const h = {
            Accept: 'application/json',
            'Application-Name': APP_NAME,
            'Application-Version': this.version,
            'User-Agent': `${APP_NAME}/${this.version} (${process.platform}; Electron)`,
            ...extra,
        };
        const key = this.getKey();
        if (key) h.apikey = key;
        return h;
    }

    readLimits(res) {
        const d = res.headers.get('x-rl-daily-remaining');
        const hr = res.headers.get('x-rl-hourly-remaining');
        if (d !== null || hr !== null) this.limits = { daily: Number(d), hourly: Number(hr) };
    }

    async rest(pathname, { cacheMs = 0 } = {}) {
        if (!this.getKey()) throw new NexusError('Add your Nexus API key in Settings to use this.', 401);
        const url = `${REST}${pathname}`;
        const hit = this.cache.get(url);
        if (cacheMs && hit && Date.now() - hit.t < cacheMs) return hit.v;
        const res = await fetch(url, { headers: this.headers() });
        this.readLimits(res);
        if (!res.ok) {
            let msg = `Nexus said ${res.status}`;
            try {
                const body = await res.json();
                if (body && body.message) msg = body.message;
            } catch { /* not json */ }
            if (res.status === 401) msg = 'Your Nexus API key was rejected. Check it in Settings.';
            if (res.status === 403 && /premium/i.test(msg)) msg = 'Direct downloads need Nexus Premium. Use the "Mod Manager Download" button on the website instead.';
            if (res.status === 429) msg = 'Nexus rate limit reached. Try again in a while.';
            throw new NexusError(msg, res.status);
        }
        const v = await res.json();
        if (cacheMs) this.cache.set(url, { t: Date.now(), v });
        return v;
    }

    async graphql(query, variables) {
        const res = await fetch(GQL, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ query, variables }),
        });
        this.readLimits(res);
        const body = await res.json().catch(() => null);
        if (!res.ok || !body) throw new NexusError(`Nexus GraphQL ${res.status}`, res.status);
        if (body.errors && body.errors.length) throw new NexusError(body.errors.map((e) => e.message).join('; '), 400);
        return body.data;
    }

    async validate() {
        const u = await this.rest('/users/validate.json');
        this.user = { name: u.name, premium: !!u.is_premium, supporter: !!u.is_supporter, avatar: u.profile_url, id: u.user_id };
        return { user: this.user, limits: this.limits };
    }

    // ---------- browsing ----------

    /** Query shapes, newest schema first. The first that works is kept. */
    gqlVariants(sortField, term, offset, count, modId) {
        const fullFields = 'modId name summary version author uploader { name } pictureUrl thumbnailUrl endorsements downloads createdAt updatedAt modCategory { name } adultContent';
        const minFields = 'modId name summary version author pictureUrl thumbnailUrl endorsements downloads updatedAt';
        const nameFilter = term ? `*${term.replace(/[*"\\]/g, ' ').trim()}*` : null;
        // Only declare variables that are used (GraphQL rejects unused ones).
        const decl = ['$game: String!', '$offset: Int', '$count: Int'];
        const vars = { game: GAME, offset, count };
        if (nameFilter) { decl.push('$name: String'); vars.name = nameFilter; }
        if (modId) { decl.push('$mid: Int'); vars.mid = Number(modId); }
        const head = `query(${decl.join(', ')})`;
        const shapes = [
            // A: array filters + array sort (website style), full fields
            { key: 'A', field: 'gameDomainName', arr: true, fields: fullFields, total: true },
            // B: object filters, minimal fields
            { key: 'B', field: 'gameDomainName', arr: false, fields: minFields, total: true },
            // C: older "gameDomain" filter name
            { key: 'C', field: 'gameDomain', arr: false, fields: minFields, total: false },
        ];
        const list = shapes.map((sh) => {
            const w = (x) => (sh.arr ? `[${x}]` : x);
            const filters = [`${sh.field}: ${w('{ value: $game, op: EQUALS }')}`];
            if (nameFilter) filters.push(`name: ${w('{ value: $name, op: WILDCARD }')}`);
            if (modId) filters.push(`modId: ${w('{ value: $mid, op: EQUALS }')}`);
            const sort = w(`{ ${sortField}: { direction: DESC } }`);
            const query = `${head} { mods(offset: $offset, count: $count, filter: { ${filters.join(', ')} }, sort: ${sort}) { ${sh.total ? 'totalCount ' : ''}nodes { ${sh.fields} } } }`;
            return { key: sh.key, query, vars };
        });
        if (this.gqlStyle) list.sort((a, b) => (a.key === this.gqlStyle ? -1 : b.key === this.gqlStyle ? 1 : 0));
        return list;
    }

    normalise(n) {
        const author = typeof n.author === 'string' ? n.author : n.author && n.author.name;
        return {
            modId: Number(n.modId ?? n.mod_id),
            name: n.name || `Mod ${n.modId ?? n.mod_id}`,
            summary: n.summary || '',
            version: n.version || '',
            author: author || (n.uploader && n.uploader.name) || n.uploaded_by || '',
            picture: n.pictureUrl || n.picture_url || '',
            thumb: n.thumbnailUrl || n.pictureUrl || n.picture_url || '',
            endorsements: Number(n.endorsements ?? n.endorsement_count ?? 0),
            downloads: Number(n.downloads ?? n.mod_downloads ?? 0),
            updatedAt: n.updatedAt || (n.updated_timestamp ? new Date(n.updated_timestamp * 1000).toISOString() : ''),
            createdAt: n.createdAt || (n.created_timestamp ? new Date(n.created_timestamp * 1000).toISOString() : ''),
            category: (n.modCategory && n.modCategory.name) || '',
            adult: !!(n.adultContent ?? n.contains_adult_content),
            url: `${SITE}/${GAME}/mods/${n.modId ?? n.mod_id}`,
        };
    }

    async browse({ sort = 'trending', term = '', page = 0, pageSize = 24, showAdult = false } = {}) {
        const cacheKey = `browse:${sort}:${term}:${page}:${pageSize}`;
        const hit = this.cache.get(cacheKey);
        if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.v;

        const sortField = SORTS[sort] || 'downloads';
        const errors = [];
        for (const v of this.gqlVariants(sortField, term, page * pageSize, pageSize)) {
            try {
                const data = await this.graphql(v.query, v.vars);
                const nodes = (data.mods && data.mods.nodes) || [];
                this.gqlStyle = v.key;
                let items = nodes.map((n) => this.normalise(n));
                if (!showAdult) items = items.filter((i) => !i.adult);
                const out = { items, total: data.mods.totalCount ?? null, source: 'graphql' };
                this.cache.set(cacheKey, { t: Date.now(), v: out });
                this.writeDiskCache(cacheKey, out);
                return out;
            } catch (e) {
                errors.push(`${v.key}: ${e.message}`);
            }
        }
        // REST fallback (needs an API key; no search)
        if (this.getKey() && !term) {
            try {
                const feed = sort === 'latest' ? 'latest_added' : sort === 'updated' ? 'latest_updated' : 'trending';
                const list = await this.rest(`/games/${GAME}/mods/${feed}.json`, { cacheMs: 5 * 60 * 1000 });
                let items = list.filter((m) => m.status === 'published' || !m.status).map((n) => this.normalise(n));
                if (!showAdult) items = items.filter((i) => !i.adult);
                return { items, total: items.length, source: 'rest' };
            } catch (e) {
                errors.push(`REST: ${e.message}`);
            }
        }
        const cached = this.readDiskCache(cacheKey);
        if (cached) return { ...cached, offline: true };
        throw new NexusError(`Could not reach Nexus Mods. ${errors.slice(-1)[0] || ''}`.trim(), 503);
    }

    async mod(modId) {
        if (this.getKey()) {
            const m = await this.rest(`/games/${GAME}/mods/${modId}.json`, { cacheMs: 5 * 60 * 1000 });
            return { ...this.normalise(m), description: m.description || '', available: m.available !== false, status: m.status };
        }
        // No key: GraphQL for the basics
        for (const v of this.gqlVariants('downloads', '', 0, 1, Number(modId))) {
            try {
                const data = await this.graphql(v.query, v.vars);
                const n = data.mods && data.mods.nodes && data.mods.nodes[0];
                if (n) return { ...this.normalise(n), description: '', available: true };
            } catch { /* next */ }
        }
        throw new NexusError('Mod details unavailable.', 404);
    }

    async files(modId) {
        const r = await this.rest(`/games/${GAME}/mods/${modId}/files.json`, { cacheMs: 2 * 60 * 1000 });
        const order = { MAIN: 0, UPDATE: 1, OPTIONAL: 2, MISCELLANEOUS: 3, OLD_VERSION: 4, ARCHIVED: 5 };
        return (r.files || [])
            .map((f) => ({
                fileId: f.file_id,
                name: f.name,
                fileName: f.file_name,
                version: f.version || f.mod_version || '',
                category: f.category_name || 'MAIN',
                sizeKb: f.size_kb || f.size || 0,
                uploadedAt: f.uploaded_timestamp ? new Date(f.uploaded_timestamp * 1000).toISOString() : '',
                description: f.description || '',
                primary: !!f.is_primary,
                url: `${SITE}/${GAME}/mods/${modId}?tab=files&file_id=${f.file_id}`,
            }))
            .filter((f) => f.category !== 'ARCHIVED' && f.category !== 'DELETED')
            .sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || (b.uploadedAt > a.uploadedAt ? 1 : -1));
    }

    /** Download link: premium (no key/expires) or from an nxm:// link. */
    async downloadLink(modId, fileId, nxm) {
        const q = nxm && nxm.key ? `?key=${encodeURIComponent(nxm.key)}&expires=${encodeURIComponent(nxm.expires)}` : '';
        const links = await this.rest(`/games/${GAME}/mods/${modId}/files/${fileId}/download_link.json${q}`);
        if (!Array.isArray(links) || !links.length) throw new NexusError('Nexus gave no download link.', 404);
        return links[0].URI;
    }

    async download(url, dir, onProgress, signal) {
        await fsp.mkdir(dir, { recursive: true });
        const res = await fetch(url, { headers: { 'User-Agent': `${APP_NAME}/${this.version}` }, signal });
        if (!res.ok || !res.body) throw new NexusError(`Download failed (${res.status})`, res.status);
        let name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download.zip');
        const cd = res.headers.get('content-disposition');
        const m = cd && /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        if (m) name = decodeURIComponent(m[1]);
        name = name.replace(/[<>:"/\\|?*]+/g, '_');
        const dest = path.join(dir, name);
        const total = Number(res.headers.get('content-length')) || 0;
        const out = fs.createWriteStream(dest);
        let got = 0;
        let last = 0;
        try {
            for await (const chunk of res.body) {
                got += chunk.length;
                if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
                const t = Date.now();
                if (t - last > 200) {
                    last = t;
                    onProgress && onProgress(got, total);
                }
            }
        } finally {
            await new Promise((r) => out.end(r));
        }
        onProgress && onProgress(got, total || got);
        return dest;
    }

    static parseNxm(url) {
        // nxm://phantombladezero/mods/71/files/123?key=...&expires=...&user_id=...
        const u = new URL(url);
        if (u.protocol !== 'nxm:') return null;
        const parts = (u.hostname + u.pathname).split('/').filter(Boolean);
        const i = parts.indexOf('mods');
        const j = parts.indexOf('files');
        if (i < 0 || j < 0) return null;
        return {
            game: parts[0].toLowerCase(),
            modId: Number(parts[i + 1]),
            fileId: Number(parts[j + 1]),
            key: u.searchParams.get('key'),
            expires: u.searchParams.get('expires'),
        };
    }

    // ---------- offline cache ----------
    diskCacheFile(key) {
        return path.join(this.cacheDir, `${Buffer.from(key).toString('base64url')}.json`);
    }

    writeDiskCache(key, value) {
        try {
            fs.mkdirSync(this.cacheDir, { recursive: true });
            fs.writeFileSync(this.diskCacheFile(key), JSON.stringify(value));
        } catch { /* ignore */ }
    }

    readDiskCache(key) {
        try {
            return JSON.parse(fs.readFileSync(this.diskCacheFile(key), 'utf8'));
        } catch {
            return null;
        }
    }
}

module.exports = { Nexus, NexusError, GAME, SITE };
