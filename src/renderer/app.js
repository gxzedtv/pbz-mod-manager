'use strict';
/* global pbz */

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n || 0));
const fmtSize = (kb) => (kb > 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`);
const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const icon = {
    grip: '<svg viewBox="0 0 10 16"><circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.5-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.5-7 10-7 10z"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14"/></svg>',
    ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
};
const NO_IMAGE = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#242934"/><path d="M160 58l7 32 32 7-32 7-7 32-7-32-32-7 32-7z" fill="#6f5a31"/></svg>');

const state = {
    view: 'library',
    library: { mods: [], unmanaged: [], gameRoot: null },
    game: { valid: false },
    settings: {},
    nexusUser: null,
    store: { sort: 'trending', term: '', page: 0, pageSize: 24, items: [], loading: false, error: null, total: null },
    downloads: [],
    bundled: [],
    updates: [],
    filter: '',
};

function toast(text, level = 'info', action) {
    const el = document.createElement('div');
    el.className = `toast ${level}`;
    el.innerHTML = `<span>${esc(text)}</span>`;
    if (action) {
        const b = document.createElement('button');
        b.className = 'btn btn-small btn-primary';
        b.textContent = action.label;
        b.onclick = () => {
            action.run();
            el.remove();
        };
        el.append(b);
    }
    $('#toasts').append(el);
    setTimeout(() => el.remove(), action ? 15000 : level === 'error' ? 8000 : 4500);
}

function confirmBox(title, text, okLabel = 'OK', danger = false) {
    const d = $('#confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.className = danger ? 'btn btn-danger-text' : 'btn btn-primary';
    d.showModal();
    return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

async function attempt(fn, okText) {
    try {
        const r = await fn();
        if (okText) toast(okText, 'ok');
        return r;
    } catch (e) {
        toast(e.message, 'error');
        return undefined;
    }
}

let statusTimer;
function setStatus(text) {
    const s = $('#statusbar');
    s.textContent = text || '';
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { s.textContent = ''; }, 4000);
}

// ---------- navigation ----------
function navigate(view) {
    state.view = view;
    for (const b of $$('.nav-item')) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
    for (const v of $$('.view')) v.hidden = v.id !== `view-${view}`;
    closeDrawer();
    $('.main').scrollTop = 0;
    if (view === 'store' && !state.store.items.length && !state.store.loading) loadStore();
    if (view === 'settings') renderSettings();
    if (view === 'downloads') renderDownloads();
}

// ---------- drawer ----------
function openDrawer(html) {
    $('#drawer-body').innerHTML = html;
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').hidden = false;
    $('#drawer').scrollTop = 0;
}
function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').hidden = true;
}

// ---------- game / rail ----------
async function refreshGame() {
    state.game = (await attempt(() => pbz.game.info())) || { valid: false };
    const g = state.game;
    const el = $('#game-status');
    if (g.valid) {
        const fw = g.frameworks || {};
        const loaders = [fw.pbzModLoader?.installed && 'PBZModLoader', fw.modsMenu?.installed && 'Mods Menu', fw.ue4ss?.installed && 'UE4SS'].filter(Boolean);
        el.innerHTML = `<strong><span class="dot ok"></span>Game found</strong>${esc(g.platform === 'wegame' ? 'WeGame' : 'Steam')} · ${loaders.length ? esc(loaders.join(', ')) : 'no script loader yet'}`;
    } else {
        el.innerHTML = '<strong><span class="dot warn"></span>Game not set</strong>Pick the game folder in Settings';
    }
    $('#play').disabled = !g.valid;
}

// ---------- library ----------
async function refreshLibrary() {
    const lib = await attempt(() => pbz.library.list());
    if (lib) state.library = lib;
    state.bundled = (await attempt(() => pbz.library.bundled())) || [];
    renderLibrary();
}

function renderLibrary() {
    const { mods, unmanaged } = state.library;
    const enabled = mods.filter((m) => m.enabled).length;
    $('#count-library').textContent = mods.length ? String(mods.length) : '';
    $('#library-lede').textContent = mods.length
        ? `${enabled} of ${mods.length} mods on. Drag to set priority: lower in the list wins when two mods change the same file.`
        : 'Mods installed through this manager.';

    // setup banner
    const banner = $('#setup-banner');
    if (!state.game.valid) {
        banner.innerHTML = `<div class="banner warn"><div><h3>Set the game folder</h3><p>The manager needs to know where Phantom Blade Zero is installed before it can install mods.</p></div><button class="btn btn-primary" data-act="go-settings">Find the game</button></div>`;
    } else if (!state.game.frameworks?.pbzModLoader?.installed && !state.game.frameworks?.modsMenu?.installed) {
        banner.innerHTML = `<div class="banner"><div><h3>Install a script loader</h3><p>Most gameplay mods, including PBZ Souls Mode, need PBZModLoader. Get it from the Nexus store, or drop its zip here.</p></div><button class="btn btn-primary" data-act="open-nexus" data-mod="113">Get PBZModLoader</button></div>`;
    } else if (mods.some((m) => m.enabled)) {
        banner.innerHTML = `<div class="banner"><div><h3>Not seeing your mods in game?</h3><p>Run a quick check of the loader and the game folder. It reads the loader's log from your last launch.</p></div><button class="btn" data-act="diagnose">Check my setup</button></div>`;
    } else banner.innerHTML = '';

    // featured bundled mods
    const feat = $('#featured');
    feat.innerHTML = state.bundled
        .filter((b) => !b.installed)
        .map((b) => `<div class="featured">
            <div>
                <h3>${esc(b.name)}</h3>
                <p>${esc(b.summary)}</p>
                <div class="feature-points">${(b.points || []).map((p) => `<span>${esc(p)}</span>`).join('')}</div>
            </div>
            <button class="btn btn-primary" data-act="install-bundled" data-id="${esc(b.id)}">Install</button>
        </div>`)
        .join('');

    // list
    const list = $('#mod-list');
    const q = state.filter.trim().toLowerCase();
    const shown = mods.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.author || '').toLowerCase().includes(q));
    if (!mods.length) {
        list.innerHTML = `<div class="empty"><h3>No mods yet</h3><p>Drop a mod archive anywhere on this window, import one from disk, or find mods in the Nexus store.</p><button class="btn btn-primary" data-act="go-store">Browse the Nexus store</button></div>`;
    } else if (!shown.length) {
        list.innerHTML = `<div class="empty"><p>No installed mod matches “${esc(state.filter)}”.</p></div>`;
    } else {
        list.innerHTML = shown.map(modRow).join('');
    }

    // unmanaged
    const um = $('#unmanaged');
    um.innerHTML = unmanaged.length
        ? `<h3 class="section-title">Found in the game folder</h3>
           <p class="hint">Installed by hand, not by this manager. Take them over to switch them on and off here.</p>
           <div class="unmanaged-box">${unmanaged.map((u) => `<div class="unmanaged-row"><div><strong>${esc(u.name)}</strong> <span class="tag">${esc(u.label)}</span></div><button class="btn btn-small" data-act="adopt" data-rel="${esc(u.rel)}">Manage here</button></div>`).join('')}</div>`
        : '';
}

function modRow(m) {
    const tags = [];
    for (const k of m.kindLabels || []) tags.push(`<span class="tag">${esc(k)}</span>`);
    if (m.incompatible?.length) tags.push(`<span class="tag bad" title="${esc(m.incompatible[0].reason)}">Clashes with ${esc(m.incompatible[0].name)}</span>`);
    else if (m.overridden) tags.push(`<span class="tag warn" title="Another mod lower in the list replaces these files">${m.overridden} file(s) overridden</span>`);
    else if (m.conflicts?.length) tags.push(`<span class="tag warn">Shares files with ${esc(m.conflicts[0].name)}</span>`);
    const upd = state.updates.find((u) => u.id === m.id);
    if (upd) tags.push(`<span class="tag good">Update ${esc(upd.latest)}</span>`);
    const initial = esc((m.name || '?').trim()[0] || '?');
    const thumb = m.picture ? `style="background-image:url('${esc(m.picture)}')"` : '';
    return `<div class="mod-row ${m.enabled ? '' : 'disabled'}" role="listitem" draggable="true" data-id="${esc(m.id)}">
        <div class="grip" title="Drag to change priority">${icon.grip}</div>
        <div class="mod-thumb" ${thumb}>${m.picture ? '' : initial}</div>
        <div class="mod-title">
            <div class="mod-name">${esc(m.name)}</div>
            <div class="mod-meta">${m.version ? `<span>v${esc(m.version)}</span>` : ''}${m.author ? `<span>${esc(m.author)}</span>` : ''}${tags.join('')}</div>
        </div>
        <div class="mod-actions">
            <button class="icon-btn" title="Open folder" data-act="open-folder" data-id="${esc(m.id)}">${icon.folder}</button>
            <button class="icon-btn" title="Uninstall" data-act="remove" data-id="${esc(m.id)}">${icon.trash}</button>
        </div>
        <button class="seal" role="switch" aria-checked="${m.enabled}" aria-label="${m.enabled ? 'Disable' : 'Enable'} ${esc(m.name)}" data-act="toggle" data-id="${esc(m.id)}"><span class="stamp">${icon.check}</span></button>
    </div>`;
}

async function showModDetails(id) {
    const m = state.library.mods.find((x) => x.id === id);
    if (!m) return;
    const files = (await attempt(() => pbz.library.files(id))) || [];
    const notes = [
        ...(m.incompatible || []).map((c) => `<div class="note bad">${esc(c.reason)} (${esc(c.name)} is also on.)</div>`),
        ...(m.conflicts || []).map((c) => `<div class="note">Shares ${c.files} file(s) with ${esc(c.name)}. The one lower in the list wins.</div>`),
        ...(m.warnings || []).map((w) => `<div class="note">${esc(w)}</div>`),
    ].join('');
    openDrawer(`
        ${m.picture ? `<div class="drawer-hero" style="background-image:url('${esc(m.picture)}')"></div>` : '<div class="drawer-hero drawer-hero-empty"></div>'}
        <div class="drawer-content">
            <h2>${esc(m.name)}</h2>
            <div class="drawer-meta">${m.version ? `<span>v${esc(m.version)}</span>` : ''}${m.author ? `<span>by ${esc(m.author)}</span>` : ''}<span>${m.enabled ? 'On' : 'Off'}</span></div>
            ${m.summary ? `<p class="description">${esc(m.summary)}</p>` : ''}
            <div class="drawer-actions">
                <button class="btn btn-primary" data-act="toggle" data-id="${esc(m.id)}">${m.enabled ? 'Disable' : 'Enable'}</button>
                <button class="btn" data-act="open-folder" data-id="${esc(m.id)}">Open folder</button>
                ${m.nexus?.modId ? `<button class="btn" data-act="open-nexus" data-mod="${m.nexus.modId}">View on Nexus</button>` : ''}
                <button class="btn btn-quiet btn-danger-text" data-act="remove" data-id="${esc(m.id)}">Uninstall</button>
            </div>
            ${notes}
            <dl class="kv">
                <dt>Type</dt><dd>${esc((m.kindLabels || []).join(', ') || 'Unknown')}</dd>
                <dt>Installed</dt><dd>${esc(fmtDate(m.installedAt))}</dd>
                <dt>Source</dt><dd>${esc({ nexus: 'Nexus Mods', import: 'Imported file', bundled: 'Included with the manager', adopted: 'Taken over from the game folder' }[m.source] || m.source)}</dd>
                <dt>Priority</dt><dd>${m.priority + 1} of ${state.library.mods.length}</dd>
            </dl>
            <h3>Files in the game folder (${files.length})</h3>
            <div class="file-paths">${esc(files.join('\n'))}</div>
        </div>`);
}

// drag to reorder
let dragId = null;
function setupDrag() {
    const list = $('#mod-list');
    list.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.mod-row');
        if (!row) return;
        dragId = row.dataset.id;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-pbz-mod', dragId);
    });
    list.addEventListener('dragend', () => {
        dragId = null;
        $$('.mod-row').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    list.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        const row = e.target.closest('.mod-row');
        $$('.mod-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
        if (!row || row.dataset.id === dragId) return;
        const r = row.getBoundingClientRect();
        row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    list.addEventListener('drop', async (e) => {
        if (!dragId) return;
        e.preventDefault();
        e.stopPropagation();
        const row = e.target.closest('.mod-row');
        const ids = state.library.mods.map((m) => m.id).filter((id) => id !== dragId);
        if (row && row.dataset.id !== dragId) {
            const r = row.getBoundingClientRect();
            const idx = ids.indexOf(row.dataset.id) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
            ids.splice(idx, 0, dragId);
        } else ids.push(dragId);
        await attempt(() => pbz.library.reorder(ids));
        refreshLibrary();
    });
}

// drop files from the OS to install
function setupFileDrop() {
    let depth = 0;
    const hint = $('#drop-hint');
    const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => {
        if (!isFiles(e)) return;
        depth++;
        hint.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
        if (!isFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) hint.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
        if (isFiles(e)) e.preventDefault();
    });
    window.addEventListener('drop', async (e) => {
        if (!isFiles(e)) return;
        e.preventDefault();
        depth = 0;
        hint.hidden = true;
        const paths = [...e.dataTransfer.files].map((f) => pbz.library.pathForFile(f)).filter(Boolean);
        await importPaths(paths);
    });
}

async function importPaths(paths, opts = {}) {
    if (!paths.length) return;
    if (!state.game.valid) {
        toast('Set the game folder first (Settings).', 'error');
        return;
    }
    navigate('library');
    for (const p of paths) {
        const name = p.split(/[\\/]/).pop();
        setStatus(`Installing ${name}…`);
        try {
            const r = await pbz.library.import(p, opts);
            toast(`Installed ${r.mod.name}`, 'ok');
            for (const w of r.warnings || []) toast(w, 'warn');
        } catch (e) {
            if (e.code === 'NO_LAYOUT' || /Could not tell/.test(e.message)) {
                const ok = await confirmBox('Where does this mod go?', `${name}: ${e.message}\n\nInstall it as-is, copying its files straight into the game folder?`, 'Install as-is');
                if (ok) await attempt(() => pbz.library.import(p, { ...opts, asIs: true }), `Installed ${name}`);
            } else toast(`${name}: ${e.message}`, 'error');
        }
    }
    setStatus('');
    refreshLibrary();
    refreshGame();
}

// ---------- store ----------
const ESSENTIALS = [
    { id: 113, name: 'PBZModLoader', note: 'Script loader most gameplay mods need', fw: 'pbzModLoader' },
    { id: 149, name: 'Mods Menu', note: 'In-game settings tab and a second script loader', fw: 'modsMenu' },
];

function renderEssentials() {
    const fw = state.game.frameworks || {};
    const missing = ESSENTIALS.filter((e) => !fw[e.fw]?.installed);
    $('#essentials').innerHTML = state.store.term || !missing.length
        ? ''
        : missing.map((e) => `<div class="essential"><div><strong>${esc(e.name)}</strong><small>${esc(e.note)}</small></div><button class="btn btn-small" data-act="open-nexus" data-mod="${e.id}">View</button></div>`).join('');
}

async function loadStore() {
    const s = state.store;
    s.loading = true;
    s.error = null;
    renderStore();
    try {
        const r = await pbz.nexus.browse({ sort: s.sort, term: s.term, page: s.page, pageSize: s.pageSize });
        s.items = r.items;
        s.total = r.total;
        s.offline = !!r.offline;
    } catch (e) {
        s.items = [];
        s.error = e.message;
    }
    s.loading = false;
    renderStore();
}

function installedNexusIds() {
    return new Set(state.library.mods.filter((m) => m.nexus?.modId).map((m) => Number(m.nexus.modId)));
}

function renderStore() {
    renderEssentials();
    const s = state.store;
    const grid = $('#store-grid');
    for (const b of $$('#store-sorts button')) b.setAttribute('aria-selected', String(b.dataset.sort === s.sort));
    $('#store-lede').textContent = s.offline ? 'Showing saved results: Nexus Mods could not be reached.' : 'Mods for Phantom Blade Zero on Nexus Mods.';
    renderAccount();
    if (s.loading) {
        grid.innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
        $('#store-pager').innerHTML = '';
        return;
    }
    if (s.error) {
        grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Nexus Mods did not answer</h3><p>${esc(s.error)}</p><p>Check your internet connection. Adding your API key in Settings also enables a backup way to load the store.</p><button class="btn btn-primary" data-act="store-retry">Try again</button></div>`;
        return;
    }
    if (!s.items.length) {
        grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><p>No mods found${s.term ? ` for “${esc(s.term)}”` : ''}.</p></div>`;
        $('#store-pager').innerHTML = '';
        return;
    }
    const mine = installedNexusIds();
    grid.innerHTML = s.items.map((m) => `
        <button class="tile" data-act="store-open" data-mod="${m.modId}">
            <div class="tile-imgwrap">
                <img class="tile-img" loading="lazy" src="${esc(m.thumb || NO_IMAGE)}" alt="">
                ${mine.has(m.modId) ? '<span class="tag good tile-installed">Installed</span>' : ''}
            </div>
            <div class="tile-body">
                <div class="tile-name">${esc(m.name)}</div>
                ${m.author ? `<div class="tile-author">by ${esc(m.author)}</div>` : ''}
                <div class="tile-summary">${esc(m.summary)}</div>
                <div class="tile-stats"><span title="Endorsements">${icon.heart}${fmtNum(m.endorsements)}</span><span title="Downloads">${icon.down}${fmtNum(m.downloads)}</span></div>
            </div>
        </button>`).join('');
    const more = s.total != null ? (s.page + 1) * s.pageSize < s.total : s.items.length >= s.pageSize;
    $('#store-pager').innerHTML = `
        <button class="btn" data-act="page" data-dir="-1" ${s.page === 0 ? 'disabled' : ''}>Previous</button>
        <span>Page ${s.page + 1}${s.total ? ` of ${Math.max(1, Math.ceil(s.total / s.pageSize))}` : ''}</span>
        <button class="btn" data-act="page" data-dir="1" ${more ? '' : 'disabled'}>Next</button>`;
}

function renderAccount() {
    const u = state.nexusUser;
    $('#nexus-account').innerHTML = u
        ? `<span class="tag ${u.premium ? 'good' : ''}">${esc(u.name)}${u.premium ? ' · Premium' : ''}</span>`
        : `<button class="btn" data-act="go-settings">Add Nexus API key</button>`;
}

// Minimal, safe BBCode → HTML for Nexus descriptions.
function bbcode(src) {
    let s = String(src || '').replace(/<br\s*\/?>/gi, '\n');
    s = esc(s);
    const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u.replace(/"/g, '%22') : null);
    const rules = [
        [/\[b\]([\s\S]*?)\[\/b\]/gi, '<strong>$1</strong>'],
        [/\[i\]([\s\S]*?)\[\/i\]/gi, '<em>$1</em>'],
        [/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>'],
        [/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>'],
        [/\[center\]([\s\S]*?)\[\/center\]/gi, '<div style="text-align:center">$1</div>'],
        [/\[right\]([\s\S]*?)\[\/right\]/gi, '<div style="text-align:right">$1</div>'],
        [/\[heading\]([\s\S]*?)\[\/heading\]/gi, '<h3>$1</h3>'],
        [/\[size=["']?([1-7])["']?\]([\s\S]*?)\[\/size\]/gi, (_m, n, t) => (Number(n) >= 5 ? `<h3>${t}</h3>` : `<span>${t}</span>`)],
        [/\[size=[^\]]*\]([\s\S]*?)\[\/size\]/gi, '$1'],
        [/\[color=[^\]]*\]([\s\S]*?)\[\/color\]/gi, '$1'],
        [/\[font=[^\]]*\]([\s\S]*?)\[\/font\]/gi, '$1'],
        [/\[quote[^\]]*\]([\s\S]*?)\[\/quote\]/gi, '<blockquote>$1</blockquote>'],
        [/\[spoiler[^\]]*\]([\s\S]*?)\[\/spoiler\]/gi, '<details class="spoiler"><summary>Spoiler</summary>$1</details>'],
        [/\[code\]([\s\S]*?)\[\/code\]/gi, '<code>$1</code>'],
        [/\[line\]/gi, '<hr>'],
        [/\[img[^\]]*\]([\s\S]*?)\[\/img\]/gi, (_m, u) => (safeUrl(u.trim()) ? `<img src="${safeUrl(u.trim())}" alt="" loading="lazy">` : '')],
        [/\[url=["']?([^\]"']+)["']?\]([\s\S]*?)\[\/url\]/gi, (_m, u, t) => (safeUrl(u) ? `<a href="#" data-href="${safeUrl(u)}">${t}</a>` : t)],
        [/\[url\]([\s\S]*?)\[\/url\]/gi, (_m, u) => (safeUrl(u) ? `<a href="#" data-href="${safeUrl(u)}">${u}</a>` : u)],
        [/\[youtube\]([\s\S]*?)\[\/youtube\]/gi, (_m, id) => `<a href="#" data-href="https://www.youtube.com/watch?v=${encodeURIComponent(id.trim())}">Video on YouTube</a>`],
        [/\[list=?[^\]]*\]/gi, '<ul>'],
        [/\[\/list\]/gi, '</ul>'],
        [/\[\*\]/g, '<li>'],
        [/\[\/?(left|justify|indent|table|tr|td|th|ol)\]/gi, ''],
    ];
    for (let pass = 0; pass < 3; pass++) for (const [re, rep] of rules) s = s.replace(re, rep);
    return s.replace(/\n/g, '<br>');
}

async function showStoreMod(modId) {
    const tile = state.store.items.find((m) => m.modId === Number(modId)) || { modId, name: `Mod ${modId}`, picture: '' };
    const renderShell = (info, filesHtml) => {
        const m = { ...tile, ...(info || {}) };
        const installed = state.library.mods.find((x) => Number(x.nexus?.modId) === Number(modId));
        openDrawer(`
            ${m.picture || m.thumb ? `<div class="drawer-hero" style="background-image:url('${esc(m.picture || m.thumb)}')"></div>` : '<div class="drawer-hero drawer-hero-empty"></div>'}
            <div class="drawer-content">
                <h2>${esc(m.name)}</h2>
                <div class="drawer-meta">${m.author ? `<span>by ${esc(m.author)}</span>` : ''}${m.version ? `<span>v${esc(m.version)}</span>` : ''}<span>${fmtNum(m.endorsements)} endorsements</span><span>${fmtNum(m.downloads)} downloads</span>${m.updatedAt ? `<span>Updated ${esc(fmtDate(m.updatedAt))}</span>` : ''}</div>
                <div class="drawer-actions">
                    <button class="btn" data-act="open-nexus" data-mod="${m.modId}">${icon.ext.replace('<svg', '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"')} Open on Nexus</button>
                    ${installed ? `<span class="tag good">Installed${installed.version ? ` v${esc(installed.version)}` : ''}</span>` : ''}
                </div>
                <h3>Files</h3>
                ${filesHtml}
                <h3>About this mod</h3>
                <div class="description">${info && info.description ? bbcode(info.description) : esc(m.summary || '')}</div>
            </div>`);
    };
    renderShell(null, '<div class="skeleton" style="height:70px"></div>');
    let info = null;
    try {
        info = await pbz.nexus.mod(modId);
    } catch { /* show tile data */ }
    let filesHtml;
    if (!state.settings.hasApiKey) {
        filesHtml = `<div class="note">Add your Nexus API key in Settings to see and install this mod's files from here. <button class="btn btn-small" data-act="go-settings">Open Settings</button></div>`;
    } else {
        try {
            const files = await pbz.nexus.files(modId);
            const premium = !!state.nexusUser?.premium;
            filesHtml = files.length
                ? `<div class="file-list">${files.map((f) => `
                    <div class="file">
                        <div>
                            <div class="file-name">${esc(f.name)}</div>
                            <div class="file-meta"><span>${esc(f.category.replace('_', ' ').toLowerCase())}</span>${f.version ? `<span>v${esc(f.version)}</span>` : ''}<span>${fmtSize(f.sizeKb)}</span>${f.uploadedAt ? `<span>${esc(fmtDate(f.uploadedAt))}</span>` : ''}</div>
                            ${f.description ? `<div class="file-desc">${bbcode(f.description)}</div>` : ''}
                        </div>
                        <button class="btn ${f.category === 'MAIN' ? 'btn-primary' : ''}" data-act="nexus-install" data-mod="${modId}" data-file="${f.fileId}" data-version="${esc(f.version)}" data-name="${esc(m_name(info, tile))}" title="${premium ? 'Download and install' : 'Opens Nexus: click “Mod Manager Download” there'}">${premium ? 'Install' : 'Install via Nexus'}</button>
                    </div>`).join('')}</div>
                    ${premium ? '' : '<p class="hint">Free account: “Install via Nexus” opens the file on Nexus. Click <em>Mod Manager Download</em> there and the manager installs it. If a file has no such button, download it manually; the manager offers to install it when it lands in your Downloads folder.</p>'}`
                : '<p class="hint">This mod has no files.</p>';
        } catch (e) {
            filesHtml = `<div class="note bad">${esc(e.message)}</div>`;
        }
    }
    if ($('#drawer').classList.contains('open')) renderShell(info, filesHtml);
}
const m_name = (info, tile) => (info && info.name) || tile.name;

// ---------- downloads ----------
function renderDownloads() {
    const list = $('#download-list');
    const active = state.downloads.filter((d) => !['done', 'error', 'cancelled'].includes(d.state)).length;
    $('#count-downloads').textContent = active ? String(active) : '';
    if (state.view !== 'downloads') return;
    if (!state.downloads.length) {
        list.innerHTML = `<div class="empty"><h3>Nothing downloading</h3><p>Install a mod from the Nexus store, or click “Mod Manager Download” on a Nexus mod page.</p></div>`;
        return;
    }
    list.innerHTML = state.downloads.slice().reverse().map((d) => {
        const pct = d.total ? Math.round((d.got / d.total) * 100) : 0;
        const label = { starting: 'Getting link…', downloading: d.total ? `${pct}% · ${fmtSize(d.got / 1024)} of ${fmtSize(d.total / 1024)}` : `${fmtSize(d.got / 1024)}`, installing: 'Installing…', done: 'Installed', error: d.error, cancelled: 'Cancelled' }[d.state];
        const running = ['starting', 'downloading', 'installing'].includes(d.state);
        return `<div class="download">
            <div><strong>${esc(d.name)}</strong><div class="file-meta"><span class="${d.state === 'error' ? 'btn-danger-text' : ''}">${esc(label)}</span></div></div>
            <div>${d.state === 'downloading' || d.state === 'starting' ? `<button class="btn btn-small" data-act="dl-cancel" data-id="${d.id}">Cancel</button>` : d.state === 'done' ? '<span class="tag good">Done</span>' : ''}</div>
            ${running ? `<div class="bar ${d.state === 'downloading' && d.total ? '' : 'indeterminate'}"><i style="width:${pct}%"></i></div>` : ''}
        </div>`;
    }).join('');
}

// ---------- diagnostics ----------
let lastReport = '';
async function runDiagnose() {
    openDrawer('<div class="drawer-hero drawer-hero-empty"></div><div class="drawer-content"><h2>Checking your setup…</h2><div class="skeleton" style="height:220px"></div></div>');
    const r = await attempt(() => pbz.game.diagnose());
    if (!r) return closeDrawer();
    const mark = { ok: '✓', warn: '!', fail: '×' };
    const info = await pbz.app.info().catch(() => ({}));
    lastReport = [
        `PBZ Mod Manager ${info.version || ''} diagnostic`,
        `Result: ${r.summary}`,
        `Entry DLLs: ${(r.entries || []).join(', ') || 'none'} | platform: ${r.platform || '?'}`,
        `Mods on: ${state.library.mods.filter((m) => m.enabled).map((m) => m.name).join(', ') || 'none'}`,
        '',
        ...r.checks.map((c) => `[${c.status.toUpperCase()}] ${c.title}${c.detail ? `\n    ${c.detail.replace(/\n/g, '\n    ')}` : ''}${c.fix ? `\n    Fix: ${c.fix}` : ''}`),
        '',
        '--- newest loader.log (last 80 lines) ---',
        r.log || '(no log)',
    ].join('\n');
    openDrawer(`
        <div class="drawer-hero drawer-hero-empty"></div>
        <div class="drawer-content">
            <h2>Setup check</h2>
            <p class="diag-summary">${esc(r.summary)}</p>
            <div class="drawer-actions">
                <button class="btn btn-primary" data-act="copy-report">Copy report</button>
                <button class="btn" data-act="diagnose">Check again</button>
                <button class="btn" data-act="redeploy">Re-apply all mods</button>
                <button class="btn btn-quiet" data-act="open-logs">Open loader logs</button>
            </div>
            <div class="diag-list">${r.checks.map((c) => `
                <div class="diag ${c.status}">
                    <span class="diag-icon">${mark[c.status]}</span>
                    <div>
                        <div class="diag-title">${esc(c.title)}</div>
                        ${c.detail ? `<div class="diag-detail">${esc(c.detail)}</div>` : ''}
                        ${c.fix ? `<div class="diag-fix">${esc(c.fix)}</div>` : ''}
                    </div>
                </div>`).join('')}</div>
            ${r.log ? `<h3>Newest loader log</h3><div class="file-paths">${esc(r.log)}</div>` : ''}
        </div>`);
}

// ---------- settings ----------
async function renderSettings() {
    state.settings = (await attempt(() => pbz.settings.get())) || state.settings;
    const s = state.settings;
    $('#game-path').value = s.gameRoot || '';
    $('#set-watch').checked = !!s.watchDownloads;
    $('#set-adult').checked = !!s.showAdult;
    $('#set-nxm').checked = !!s.handleNxm;
    $('#api-key').value = '';
    $('#api-key').placeholder = s.hasApiKey ? 'Key saved (paste a new one to replace it)' : 'Personal API key';
    const fw = state.game.frameworks;
    $('#frameworks').innerHTML = fw
        ? [
            ['PBZModLoader', fw.pbzModLoader.installed, fw.pbzModLoader.version ? `v${fw.pbzModLoader.version} via ${fw.pbzModLoader.entry || '?'}` : fw.pbzModLoader.entry || ''],
            ['Mods Menu', fw.modsMenu.installed, ''],
            ['UE4SS', fw.ue4ss.installed, ''],
            ['ReShade', fw.reshade.installed, ''],
        ].map(([n, ok, d]) => `<div class="fw"><strong><span class="dot ${ok ? 'ok' : ''}"></span>${esc(n)}</strong>${ok ? esc(d || 'Installed') : 'Not installed'}</div>`).join('')
        : '';
    const u = state.nexusUser;
    $('#account-status').innerHTML = u
        ? `Signed in as <strong>${esc(u.name)}</strong> · ${u.premium ? 'Premium: direct downloads on' : 'Free account: installs go through the website button'} <button class="btn btn-small btn-quiet btn-danger-text" data-act="clear-key">Remove key</button>`
        : s.hasApiKey ? 'Key saved, but Nexus did not confirm it yet.' : 'No key saved.';
    const info = await attempt(() => pbz.app.info());
    if (info) $('#about').textContent = `PBZ Mod Manager ${info.version}. Mods are kept in the manager's library and copied into the game when switched on, so turning a mod off restores the original files. Not affiliated with S-GAME or Nexus Mods.`;
}

async function setGame(dir) {
    const info = await attempt(() => pbz.game.set(dir));
    if (info) {
        toast('Game folder set', 'ok');
        await refreshGame();
        await refreshLibrary();
        renderSettings();
    }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-href]');
    if (link) {
        e.preventDefault();
        attempt(() => pbz.open(link.dataset.href));
        return;
    }
    const t = e.target.closest('[data-act]');
    if (!t) {
        const row = e.target.closest('.mod-row');
        if (row) showModDetails(row.dataset.id);
        return;
    }
    e.stopPropagation();
    const id = t.dataset.id;
    switch (t.dataset.act) {
        case 'toggle': {
            const m = state.library.mods.find((x) => x.id === id);
            if (!m) return;
            t.disabled = true;
            const r = await attempt(() => pbz.library.enable(id, !m.enabled));
            await refreshLibrary();
            if (r !== undefined && $('#drawer').classList.contains('open')) showModDetails(id);
            const now = state.library.mods.find((x) => x.id === id);
            if (now && now.enabled && now.incompatible?.length) toast(`${now.name}: ${now.incompatible[0].reason}`, 'warn');
            break;
        }
        case 'remove': {
            const m = state.library.mods.find((x) => x.id === id);
            if (m && (await confirmBox(`Uninstall ${m.name}?`, 'Its files are removed from the game folder and from the library. Original game files it replaced are restored.', 'Uninstall', true))) {
                await attempt(() => pbz.library.remove(id), `Uninstalled ${m.name}`);
                closeDrawer();
                refreshLibrary();
            }
            break;
        }
        case 'open-folder':
            attempt(() => pbz.library.openFolder(id));
            break;
        case 'adopt':
            await attempt(() => pbz.library.adopt(t.dataset.rel), 'Now managed here');
            refreshLibrary();
            break;
        case 'install-bundled':
            if (!state.game.valid) return toast('Set the game folder first (Settings).', 'error');
            t.disabled = true;
            await attempt(() => pbz.library.installBundled(id), 'Installed');
            refreshLibrary();
            refreshGame();
            break;
        case 'go-settings':
            navigate('settings');
            break;
        case 'go-store':
            navigate('store');
            break;
        case 'open-nexus':
            attempt(() => pbz.open(`https://www.nexusmods.com/phantombladezero/mods/${t.dataset.mod}`));
            break;
        case 'store-open':
            showStoreMod(Number(t.dataset.mod));
            break;
        case 'store-retry':
            loadStore();
            break;
        case 'page':
            state.store.page = Math.max(0, state.store.page + Number(t.dataset.dir));
            $('.main').scrollTop = 0;
            loadStore();
            break;
        case 'nexus-install': {
            if (!state.game.valid) return toast('Set the game folder first (Settings).', 'error');
            const r = await attempt(() => pbz.nexus.install(Number(t.dataset.mod), Number(t.dataset.file), { version: t.dataset.version, name: t.dataset.name }));
            if (r?.handedOff) toast('Nexus opened in your browser. Click “Mod Manager Download” there to install.', 'info');
            else if (r?.started) {
                toast('Downloading…', 'info');
                renderDownloads();
            }
            break;
        }
        case 'dl-cancel':
            attempt(() => pbz.downloads.cancel(id));
            break;
        case 'redeploy': {
            const r = await attempt(() => pbz.library.sync());
            if (r) toast(r.ok ? 'All mods re-applied' : `Some files could not be updated: ${r.errors[0]}`, r.ok ? 'ok' : 'error');
            runDiagnose();
            break;
        }
        case 'open-logs':
            attempt(() => pbz.game.logs());
            break;
        case 'diagnose':
            runDiagnose();
            break;
        case 'copy-report':
            if (lastReport) attempt(() => pbz.copy(lastReport), 'Report copied. Paste it into the chat.');
            break;
        case 'clear-key':
            await attempt(() => pbz.nexus.clearKey(), 'Key removed');
            state.nexusUser = null;
            renderSettings();
            break;
        default:
    }
});

for (const b of $$('.nav-item')) b.addEventListener('click', () => navigate(b.dataset.view));
$('#drawer-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
});
$('#play').addEventListener('click', () => attempt(() => pbz.game.launch()));
$('#btn-import').addEventListener('click', async () => importPaths((await attempt(() => pbz.library.pickImport())) || []));
$('#btn-import-folder').addEventListener('click', async () => {
    const dir = await attempt(() => pbz.library.pickFolder());
    if (dir) importPaths([dir]);
});
$('#library-search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderLibrary();
});
$('#btn-enable-all').addEventListener('click', async () => {
    await attempt(() => pbz.library.enableAll(true));
    refreshLibrary();
});
$('#btn-disable-all').addEventListener('click', async () => {
    await attempt(() => pbz.library.enableAll(false));
    refreshLibrary();
});
$('#btn-check-updates').addEventListener('click', async () => {
    if (!state.settings.hasApiKey) return toast('Add your Nexus API key in Settings to check for updates.', 'warn');
    setStatus('Checking Nexus for updates…');
    state.updates = (await attempt(() => pbz.nexus.checkUpdates())) || [];
    setStatus('');
    toast(state.updates.length ? `${state.updates.length} update(s) available` : 'Everything is up to date', state.updates.length ? 'info' : 'ok');
    renderLibrary();
});
$('#store-search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.store.term = $('#store-search').value.trim();
    state.store.page = 0;
    loadStore();
});
$('#store-search').addEventListener('search', () => {
    if (!$('#store-search').value && state.store.term) {
        state.store.term = '';
        state.store.page = 0;
        loadStore();
    }
});
for (const b of $$('#store-sorts button')) {
    b.addEventListener('click', () => {
        state.store.sort = b.dataset.sort;
        state.store.page = 0;
        loadStore();
    });
}
$('#btn-clear-downloads').addEventListener('click', () => attempt(() => pbz.downloads.clear()));

// settings events
$('#btn-browse').addEventListener('click', async () => {
    const dir = await attempt(() => pbz.game.browse());
    if (dir) setGame(dir);
});
$('#btn-detect').addEventListener('click', async () => {
    const found = (await attempt(() => pbz.game.detect())) || [];
    const box = $('#detect-results');
    if (!found.length) {
        box.innerHTML = '<p class="hint">Could not find the game automatically. Use Browse and pick the folder that holds ProjectPBZ.</p>';
        return;
    }
    if (found.length === 1) {
        box.innerHTML = '';
        return setGame(found[0].path);
    }
    box.innerHTML = found.map((f) => `<div class="detect-item"><span>${esc(f.path)} <span class="tag">${esc(f.source)}</span></span><button class="btn btn-small" data-path="${esc(f.path)}">Use this</button></div>`).join('');
    for (const b of $$('button[data-path]', box)) b.addEventListener('click', () => setGame(b.dataset.path));
});
$('#btn-open-game').addEventListener('click', () => attempt(() => pbz.game.open()));
$('#btn-open-logs').addEventListener('click', () => attempt(() => pbz.game.logs()));
$('#btn-redeploy').addEventListener('click', async () => {
    const r = await attempt(() => pbz.library.sync());
    if (r) toast(r.ok ? 'All mods re-applied' : `Some files could not be updated: ${r.errors[0]}`, r.ok ? 'ok' : 'error');
});
$('#btn-purge').addEventListener('click', async () => {
    if (await confirmBox('Remove all mods from the game?', 'Every file this manager installed is removed and replaced game files are restored. Your library and on/off choices are kept; use “Re-apply all mods” to put them back.', 'Remove from game', true)) {
        await attempt(() => pbz.library.purge(), 'Game folder is clean');
        refreshLibrary();
    }
});
$('#btn-save-key').addEventListener('click', async () => {
    const key = $('#api-key').value.trim();
    if (!key) return toast('Paste your API key first.', 'warn');
    const r = await attempt(() => pbz.nexus.validate(key));
    if (r && r.user) {
        state.nexusUser = r.user;
        toast(`Signed in as ${r.user.name}`, 'ok');
    }
    renderSettings();
    renderAccount();
});
$('#btn-get-key').addEventListener('click', () => attempt(() => pbz.open('https://www.nexusmods.com/settings/api-keys')));
$('#set-watch').addEventListener('change', (e) => attempt(() => pbz.settings.set({ watchDownloads: e.target.checked })));
$('#set-adult').addEventListener('change', (e) => {
    attempt(() => pbz.settings.set({ showAdult: e.target.checked }));
    state.store.items = [];
});
$('#set-nxm').addEventListener('change', (e) => attempt(() => pbz.settings.set({ handleNxm: e.target.checked })));

// main-process events
pbz.on.toast((t) => toast(t.text, t.level));
pbz.on.status((s) => setStatus(s.text));
pbz.on.navigate((v) => navigate(v));
pbz.on.libraryChanged(() => refreshLibrary());
pbz.on.nexusUser((u) => {
    state.nexusUser = u;
    renderAccount();
});
pbz.on.downloads((list) => {
    state.downloads = list;
    renderDownloads();
});
pbz.on.foundDownload((f) => toast(`New download: ${f.name}`, 'info', { label: 'Install', run: () => importPaths([f.path]) }));

// broken thumbnails fall back to the placeholder (no inline handlers: CSP)
document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.src !== NO_IMAGE) img.src = NO_IMAGE;
}, true);

// ---------- start ----------
(async function start() {
    setupDrag();
    setupFileDrop();
    state.settings = (await attempt(() => pbz.settings.get())) || {};
    const status = await attempt(() => pbz.nexus.status());
    state.nexusUser = status?.user || null;
    await refreshGame();
    await refreshLibrary();
    state.downloads = (await attempt(() => pbz.downloads.list())) || [];
    renderDownloads();
    if (!state.game.valid) navigate('settings');
})();
