/**
 * Wardrobe — outfit manager for SillyTavern that plugs into "Inline Image Generation" (sillyimages).
 *
 * How it connects: the outfit that a character / persona is wearing is written into the sillyimages
 * Character library as managed "appearance items" (ids start with `wardrobe-`). sillyimages already
 * sends those items with every generation, so no patching of sillyimages is needed.
 *   - outfit prompt  -> text appearance item   (goes into the image prompt / descriptions)
 *   - outfit picture -> image appearance item  (goes out as a reference image)
 * What is sent is chosen in the Wardrobe settings: prompt, picture or both.
 */

const MODULE_NAME = 'wardrobe';
const IIG_MODULE = 'inline_image_gen';
const MANAGED_PREFIX = 'wardrobe-';
const PERSONAS_PATHS = ['/scripts/personas.js', '../../../personas.js'];

const DEFAULTS = Object.freeze({
    version: 1,
    sendMode: 'both', // 'prompt' | 'picture' | 'both'
    fallback: true,
    textPrefix: 'Currently wearing: ',
    imageNote: 'Outfit reference: wear exactly the outfit shown in this image.',
    sort: 'recent', // 'recent' | 'name'
    opacity: 100, // panel opacity in percent (30-100)
    folders: [],
    outfits: [],
    worn: { char: {}, user: {} },
});

const ctx = () => SillyTavern.getContext();

// ---------------------------------------------------------------- settings

function getSettings() {
    const c = ctx();
    if (!c.extensionSettings[MODULE_NAME]) {
        c.extensionSettings[MODULE_NAME] = structuredClone(DEFAULTS);
    }
    const s = c.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULTS)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(DEFAULTS[key]);
    }
    if (!s.worn || typeof s.worn !== 'object') s.worn = { char: {}, user: {} };
    s.worn.char = s.worn.char && typeof s.worn.char === 'object' ? s.worn.char : {};
    s.worn.user = s.worn.user && typeof s.worn.user === 'object' ? s.worn.user : {};
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------- helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
}[ch]));

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function toast(kind, message) {
    try {
        if (typeof toastr !== 'undefined' && toastr[kind]) toastr[kind](message, 'Wardrobe');
        else console.log(`[Wardrobe] ${message}`);
    } catch (_e) { /* ignore */ }
}

function normalizeTag(raw) {
    return String(raw || '').toLowerCase().replace(/[,#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function normalizeTags(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const tag = normalizeTag(raw);
        if (tag && !out.includes(tag)) out.push(tag);
    }
    return out;
}

function encodeMediaPath(path) {
    const encoded = String(path || '').split('/').map(encodeURIComponent).join('/');
    return encoded.startsWith('/') ? encoded : `/${encoded}`;
}

function getOutfit(id) {
    return getSettings().outfits.find((o) => o.id === id) || null;
}

// ---------------------------------------------------------------- identity (who is "bot" / "user")

const keys = { char: null, user: null };
let personasModule = null;

async function loadPersonas() {
    if (personasModule) return personasModule;
    for (const path of PERSONAS_PATHS) {
        try {
            personasModule = await import(path);
            return personasModule;
        } catch (_e) { /* try next */ }
    }
    return null;
}

function currentCharKey() {
    try {
        const c = ctx();
        const id = c.characterId;
        if (id === undefined || id === null || Number(id) < 0) return null;
        const ch = c.characters?.[id] || {};
        if (ch.avatar) return `avatar:${ch.avatar}`;
        if (ch.name) return `name:${ch.name}`;
        return `id:${id}`;
    } catch (_e) {
        return null;
    }
}

async function currentUserKey() {
    // Mirrors how sillyimages picks the persona key, so both sides use the same library entry.
    const iig = ctx().extensionSettings?.[IIG_MODULE] || {};
    let avatar = '';
    if (iig.useActiveUserPersonaAvatar) {
        const mod = await loadPersonas();
        avatar = String(mod?.user_avatar || '').trim();
    }
    if (!avatar) avatar = String(iig.userAvatarFile || '').trim();
    return avatar ? `avatar:${avatar}` : 'no-user-avatar';
}

async function refreshKeys() {
    keys.char = currentCharKey();
    keys.user = await currentUserKey();
}

function displayName(kind) {
    try {
        const c = ctx();
        if (kind === 'user') return c.name1 || 'You';
        const id = c.characterId;
        return c.characters?.[id]?.name || c.name2 || 'Character';
    } catch (_e) {
        return kind === 'user' ? 'You' : 'Character';
    }
}

function iigPresent() {
    return !!ctx().extensionSettings?.[IIG_MODULE];
}

// ---------------------------------------------------------------- sync into sillyimages library

function iigBucket(kind) {
    const iig = ctx().extensionSettings?.[IIG_MODULE];
    if (!iig) return null;
    if (!iig.characterReferenceLibrary || typeof iig.characterReferenceLibrary !== 'object') {
        iig.characterReferenceLibrary = { characters: {}, users: {} };
    }
    const lib = iig.characterReferenceLibrary;
    if (!lib.characters || typeof lib.characters !== 'object') lib.characters = {};
    if (!lib.users || typeof lib.users !== 'object') lib.users = {};
    return kind === 'user' ? lib.users : lib.characters;
}

function outfitParts(outfit) {
    const s = getSettings();
    const hasPrompt = !!String(outfit.prompt || '').trim();
    const hasImage = !!outfit.image;
    let prompt = false;
    let image = false;
    if (s.sendMode === 'prompt') {
        prompt = hasPrompt;
        image = !hasPrompt && s.fallback && hasImage;
    } else if (s.sendMode === 'picture') {
        image = hasImage;
        prompt = !hasImage && s.fallback && hasPrompt;
    } else {
        prompt = hasPrompt;
        image = hasImage;
    }
    return { prompt, image };
}

function syncKey(kind, key) {
    if (!key) return;
    const bucket = iigBucket(kind);
    if (!bucket) return;
    const s = getSettings();
    const outfit = getOutfit(s.worn[kind][key]);
    let entry = bucket[key];
    if (!entry && !outfit) return;
    if (!entry) {
        entry = bucket[key] = {
            displayName: '',
            primary: { enabled: true, imagePath: '', description: '' },
            appearanceItems: [],
            generations: [],
        };
    }
    const items = Array.isArray(entry.appearanceItems) ? entry.appearanceItems : [];
    entry.appearanceItems = items.filter((item) => !String(item?.id || '').startsWith(MANAGED_PREFIX));
    if (!outfit) return;
    const parts = outfitParts(outfit);
    if (parts.prompt) {
        entry.appearanceItems.push({
            id: `${MANAGED_PREFIX}text`,
            type: 'text',
            enabled: true,
            imagePath: '',
            description: `${s.textPrefix || ''}${String(outfit.prompt).trim()}`.trim(),
        });
    }
    if (parts.image) {
        entry.appearanceItems.push({
            id: `${MANAGED_PREFIX}image`,
            type: 'image',
            enabled: true,
            imagePath: outfit.image,
            description: String(s.imageNote || '').trim(),
        });
    }
}

function syncAll() {
    const s = getSettings();
    for (const kind of ['char', 'user']) {
        for (const key of Object.keys(s.worn[kind])) syncKey(kind, key);
    }
    save();
}

// ---------------------------------------------------------------- wearing

function wornId(kind) {
    const key = keys[kind];
    return key ? (getSettings().worn[kind][key] || null) : null;
}

function wear(kind, outfitId) {
    const key = keys[kind];
    if (!key) return false;
    getSettings().worn[kind][key] = outfitId;
    syncKey(kind, key);
    save();
    return true;
}

function unwear(kind) {
    const key = keys[kind];
    if (!key) return;
    const s = getSettings();
    delete s.worn[kind][key];
    // Entry may no longer be in worn map, so clean it explicitly.
    const bucket = iigBucket(kind);
    const entry = bucket?.[key];
    if (entry) {
        entry.appearanceItems = (entry.appearanceItems || [])
            .filter((item) => !String(item?.id || '').startsWith(MANAGED_PREFIX));
    }
    save();
}

function toggleWear(kind, outfitId) {
    if (!keys[kind]) {
        toast('warning', kind === 'char' ? 'Open a character chat first.' : 'No active persona found.');
        return;
    }
    if (wornId(kind) === outfitId) unwear(kind);
    else wear(kind, outfitId);
}

function unwearEverywhere(outfitId) {
    const s = getSettings();
    for (const kind of ['char', 'user']) {
        for (const [key, id] of Object.entries(s.worn[kind])) {
            if (id !== outfitId) continue;
            delete s.worn[kind][key];
            const entry = iigBucket(kind)?.[key];
            if (entry) {
                entry.appearanceItems = (entry.appearanceItems || [])
                    .filter((item) => !String(item?.id || '').startsWith(MANAGED_PREFIX));
            }
        }
    }
}

// ---------------------------------------------------------------- images

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Could not read this image'));
        img.src = src;
    });
}

async function fileToDataUrl(file, maxSide = 1024, quality = 0.86) {
    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await loadImage(objectUrl);
        const ratio = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * ratio));
        const h = Math.max(1, Math.round(img.naturalHeight * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL('image/jpeg', quality);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function uploadOutfitImage(dataUrl, hint = 'outfit') {
    const c = ctx();
    const base64 = String(dataUrl).split(',')[1] || '';
    if (!base64) throw new Error('Empty image');
    const safe = String(hint).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 24) || 'outfit';
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        body: JSON.stringify({
            image: base64,
            format: 'jpg',
            ch_name: 'wardrobe',
            filename: `${safe}_${Date.now().toString(36)}`,
        }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `Upload failed (${response.status})`);
    }
    const result = await response.json();
    return encodeMediaPath(result.path);
}

async function deleteOutfitImage(path) {
    try {
        if (!path || path.startsWith('data:')) return;
        const decoded = decodeURIComponent(new URL(path, location.origin).pathname);
        if (!decoded.startsWith('/user/images/wardrobe/')) return;
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ path: decoded }),
        });
    } catch (_e) { /* best effort */ }
}

async function pathToDataUrl(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error('missing');
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ---------------------------------------------------------------- UI state

const ui = {
    open: false,
    q: '',
    folder: 'all', // 'all' | 'none' | folderId
    tags: new Set(),
    manage: false,
    sheet: null, // { id|null, draft, pendingImage }
    lastFocus: null,
};

let overlay = null;

const ICON = {
    close: '<i class="fa-solid fa-xmark"></i>',
    plus: '<i class="fa-solid fa-plus"></i>',
    bot: '<i class="fa-solid fa-robot"></i>',
    user: '<i class="fa-solid fa-user"></i>',
    shirt: '<i class="fa-solid fa-shirt"></i>',
    folder: '<i class="fa-solid fa-folder"></i>',
    pen: '<i class="fa-solid fa-pen"></i>',
    trash: '<i class="fa-solid fa-trash"></i>',
    camera: '<i class="fa-solid fa-camera"></i>',
    image: '<i class="fa-regular fa-image"></i>',
    check: '<i class="fa-solid fa-check"></i>',
    drop: '<i class="fa-solid fa-droplet"></i>',
};

// ---------------------------------------------------------------- UI: panel

function clampOpacity(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(30, Math.round(n))) : 100;
}

function applyOpacity() {
    const value = clampOpacity(getSettings().opacity);
    if (overlay) {
        overlay.style.setProperty('--wd-pct', `${value}%`);
        overlay.style.setProperty('--wd-a', String(value / 100));
        const slider = overlay.querySelector('#wd_opacity');
        const out = overlay.querySelector('#wd_opacity_out');
        if (slider && Number(slider.value) !== value) slider.value = value;
        if (out) out.textContent = `${value}%`;
    }
    const drawer = document.getElementById('wd_set_opacity');
    if (drawer && Number(drawer.value) !== value) drawer.value = value;
    const drawerOut = document.getElementById('wd_set_opacity_out');
    if (drawerOut) drawerOut.textContent = `${value}%`;
}

function setOpacity(value) {
    getSettings().opacity = clampOpacity(value);
    applyOpacity();
    save();
}

function buildOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'wd_overlay';
    overlay.className = 'wd-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="wd-panel" role="dialog" aria-modal="true" aria-label="Wardrobe" tabindex="-1">
            <header class="wd-head">
                <div class="wd-title">
                    <span class="wd-title-mark">${ICON.shirt}</span>
                    <h2>Wardrobe</h2>
                </div>
                <div class="wd-head-actions">
                    <button class="wd-btn wd-btn-accent" data-act="new">${ICON.plus}<span>Outfit</span></button>
                    <button class="wd-icon-btn" data-act="opacity-toggle" aria-label="Panel opacity" aria-expanded="false" aria-controls="wd_opacity_row">${ICON.drop}</button>
                    <button class="wd-icon-btn" data-act="close" aria-label="Close">${ICON.close}</button>
                </div>
            </header>
            <div class="wd-opacity" id="wd_opacity_row" hidden>
                <label for="wd_opacity">Opacity</label>
                <input type="range" id="wd_opacity" min="30" max="100" step="1" value="100">
                <output id="wd_opacity_out" for="wd_opacity">100%</output>
            </div>
            <div class="wd-scroll">
                <div id="wd_notice"></div>
                <section class="wd-rail" id="wd_rail" aria-label="Currently wearing"></section>
                <div class="wd-tools">
                    <label class="wd-search">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" id="wd_search" placeholder="Search outfits, tags, prompts" autocomplete="off">
                    </label>
                    <select id="wd_sort" aria-label="Sort">
                        <option value="recent">Newest</option>
                        <option value="name">A to Z</option>
                    </select>
                </div>
                <nav class="wd-chips" id="wd_folders" aria-label="Folders"></nav>
                <nav class="wd-chips wd-chips-tags" id="wd_tags" aria-label="Tags"></nav>
                <main class="wd-grid" id="wd_grid"></main>
            </div>
        </div>
        <div class="wd-sheet-layer" id="wd_sheet_layer" hidden></div>
        <div class="wd-dialog-layer" id="wd_dialog_layer" hidden></div>
        <input type="file" id="wd_file" accept="image/*" hidden>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', onOverlayClick);
    overlay.addEventListener('keydown', onOverlayKey);
    overlay.querySelector('#wd_search').addEventListener('input', (e) => {
        ui.q = e.target.value;
        renderGrid();
    });
    overlay.querySelector('#wd_sort').addEventListener('change', (e) => {
        getSettings().sort = e.target.value;
        save();
        renderGrid();
    });
    overlay.querySelector('#wd_file').addEventListener('change', onFilePicked);
    overlay.querySelector('#wd_opacity').addEventListener('input', (e) => setOpacity(e.target.value));
    applyOpacity();
    return overlay;
}

async function openPanel() {
    buildOverlay();
    await refreshKeys();
    ui.lastFocus = document.activeElement;
    overlay.hidden = false;
    document.documentElement.classList.add('wd-lock');
    ui.open = true;
    overlay.querySelector('#wd_sort').value = getSettings().sort;
    renderPanel();
    overlay.querySelector('.wd-panel').focus({ preventScroll: true });
}

function closePanel() {
    if (!overlay) return;
    closeSheet(true);
    overlay.hidden = true;
    document.documentElement.classList.remove('wd-lock');
    ui.open = false;
    try { ui.lastFocus?.focus?.({ preventScroll: true }); } catch (_e) { /* ignore */ }
}

function renderPanel() {
    renderNotice();
    renderRail();
    renderFolders();
    renderTags();
    renderGrid();
}

function renderNotice() {
    const el = overlay.querySelector('#wd_notice');
    if (iigPresent()) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
        <div class="wd-notice">
            <b>Inline Image Generation not found.</b>
            Outfits are saved, but nothing is sent to image generation until that extension is installed and enabled.
        </div>`;
}

function slotHtml(kind) {
    const outfit = getOutfit(wornId(kind));
    const label = kind === 'char' ? displayName('char') : displayName('user');
    const icon = kind === 'char' ? ICON.bot : ICON.user;
    const disabled = !keys[kind];
    const thumb = outfit?.image
        ? `<img src="${esc(outfit.image)}" alt="" loading="lazy">`
        : `<span class="wd-slot-ph">${outfit ? ICON.shirt : icon}</span>`;
    const body = outfit
        ? `<span class="wd-slot-name">${esc(outfit.name)}</span>`
        : `<span class="wd-slot-name wd-muted">${disabled ? (kind === 'char' ? 'No character open' : 'No persona') : 'Nothing picked'}</span>`;
    return `
        <div class="wd-slot ${outfit ? 'is-on' : ''}" data-kind="${kind}">
            <button class="wd-slot-main" ${outfit ? `data-act="open" data-id="${esc(outfit.id)}"` : 'disabled'}>
                <span class="wd-slot-thumb">${thumb}</span>
                <span class="wd-slot-text">
                    <span class="wd-slot-who">${icon}<span>${esc(label)}</span></span>
                    ${body}
                </span>
            </button>
            ${outfit ? `<button class="wd-icon-btn wd-slot-off" data-act="unwear" data-kind="${kind}" aria-label="Take off outfit">${ICON.close}</button>` : ''}
        </div>`;
}

function renderRail() {
    overlay.querySelector('#wd_rail').innerHTML = slotHtml('char') + slotHtml('user');
}

function renderFolders() {
    const s = getSettings();
    const count = (pred) => s.outfits.filter(pred).length;
    const chip = (id, label, n, extra = '') => `
        <button class="wd-chip ${ui.folder === id ? 'is-active' : ''}" data-act="folder" data-id="${esc(id)}">
            ${extra}<span>${esc(label)}</span><em>${n}</em>
        </button>`;
    let html = chip('all', 'All', s.outfits.length);
    for (const f of s.folders) {
        const inner = chip(f.id, f.name, count((o) => o.folderId === f.id), ICON.folder);
        html += ui.manage
            ? `<span class="wd-chip-group">${inner}
                <button class="wd-chip-mini" data-act="folder-rename" data-id="${esc(f.id)}" aria-label="Rename folder">${ICON.pen}</button>
                <button class="wd-chip-mini is-danger" data-act="folder-delete" data-id="${esc(f.id)}" aria-label="Delete folder">${ICON.trash}</button>
               </span>`
            : inner;
    }
    const unsorted = count((o) => !o.folderId || !s.folders.some((f) => f.id === o.folderId));
    if (s.folders.length && unsorted) html += chip('none', 'Unsorted', unsorted);
    html += `<button class="wd-chip wd-chip-ghost" data-act="folder-new">${ICON.plus}<span>Folder</span></button>`;
    if (s.folders.length) {
        html += `<button class="wd-chip wd-chip-ghost ${ui.manage ? 'is-active' : ''}" data-act="folder-manage" aria-pressed="${ui.manage}">${ICON.pen}<span>${ui.manage ? 'Done' : 'Edit'}</span></button>`;
    }
    overlay.querySelector('#wd_folders').innerHTML = html;
}

function allTags() {
    const map = new Map();
    for (const o of getSettings().outfits) {
        for (const t of o.tags || []) map.set(t, (map.get(t) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderTags() {
    const tags = allTags();
    for (const t of [...ui.tags]) if (!tags.some(([name]) => name === t)) ui.tags.delete(t);
    const el = overlay.querySelector('#wd_tags');
    el.hidden = tags.length === 0;
    el.innerHTML = tags.map(([name, n]) => `
        <button class="wd-chip wd-chip-tag ${ui.tags.has(name) ? 'is-active' : ''}" data-act="tag" data-tag="${esc(name)}">
            <span>#${esc(name)}</span><em>${n}</em>
        </button>`).join('');
}

function visibleOutfits() {
    const s = getSettings();
    const q = ui.q.trim().toLowerCase();
    const list = s.outfits.filter((o) => {
        if (ui.folder === 'none') {
            if (o.folderId && s.folders.some((f) => f.id === o.folderId)) return false;
        } else if (ui.folder !== 'all' && o.folderId !== ui.folder) return false;
        for (const t of ui.tags) if (!(o.tags || []).includes(t)) return false;
        if (q) {
            const hay = `${o.name} ${o.prompt} ${(o.tags || []).join(' ')}`.toLowerCase();
            if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
        }
        return true;
    });
    if (s.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
}

function cardHtml(o) {
    const onChar = wornId('char') === o.id;
    const onUser = wornId('user') === o.id;
    const media = o.image
        ? `<img src="${esc(o.image)}" alt="" loading="lazy" draggable="false">`
        : `<span class="wd-card-ph">${ICON.shirt}</span>`;
    const tags = (o.tags || []).slice(0, 3).map((t) => `<i>#${esc(t)}</i>`).join('');
    return `
        <div class="wd-card ${onChar || onUser ? 'is-worn' : ''}" role="button" tabindex="0" data-act="open" data-id="${esc(o.id)}">
            <span class="wd-card-hole" aria-hidden="true"></span>
            <div class="wd-card-media">${media}</div>
            <div class="wd-card-body">
                <strong>${esc(o.name)}</strong>
                <span class="wd-card-tags">${tags || '<i class="wd-muted">no tags</i>'}</span>
            </div>
            <div class="wd-quick">
                <button class="wd-quick-btn ${onChar ? 'is-on' : ''}" data-act="toggle" data-kind="char" data-id="${esc(o.id)}" aria-pressed="${onChar}" aria-label="Bot wears this">${ICON.bot}</button>
                <button class="wd-quick-btn ${onUser ? 'is-on' : ''}" data-act="toggle" data-kind="user" data-id="${esc(o.id)}" aria-pressed="${onUser}" aria-label="You wear this">${ICON.user}</button>
            </div>
        </div>`;
}

function renderGrid() {
    const s = getSettings();
    const el = overlay.querySelector('#wd_grid');
    const list = visibleOutfits();
    if (!s.outfits.length) {
        el.innerHTML = `
            <div class="wd-empty">
                <div class="wd-empty-mark">${ICON.shirt}</div>
                <h3>Nothing hanging here yet</h3>
                <p>Add an outfit with a picture, a prompt, or both. Then dress your character or yourself with one tap.</p>
                <button class="wd-btn wd-btn-accent" data-act="new">${ICON.plus}<span>Add first outfit</span></button>
            </div>`;
        return;
    }
    if (!list.length) {
        el.innerHTML = `<div class="wd-empty"><h3>No match</h3><p>Try clearing the search or filters.</p></div>`;
        return;
    }
    el.innerHTML = list.map(cardHtml).join('');
}

// ---------------------------------------------------------------- UI: sheet (edit / equip)

function openSheet(id) {
    const o = id ? getOutfit(id) : null;
    ui.sheet = {
        id: o?.id || null,
        pendingImage: null,
        draft: {
            name: o?.name || '',
            folderId: o?.folderId || '',
            tags: [...(o?.tags || [])],
            prompt: o?.prompt || '',
            image: o?.image || '',
        },
    };
    renderSheet();
    const layer = overlay.querySelector('#wd_sheet_layer');
    layer.hidden = false;
    requestAnimationFrame(() => layer.classList.add('is-in'));
    if (!id) overlay.querySelector('#wd_name')?.focus({ preventScroll: true });
}

function closeSheet(immediate = false) {
    const layer = overlay?.querySelector('#wd_sheet_layer');
    if (!layer || layer.hidden) {
        ui.sheet = null;
        return;
    }
    ui.sheet = null;
    layer.classList.remove('is-in');
    if (immediate) {
        layer.hidden = true;
        layer.innerHTML = '';
        return;
    }
    setTimeout(() => {
        if (!ui.sheet) {
            layer.hidden = true;
            layer.innerHTML = '';
        }
    }, 200);
}

function sheetPreviewSrc() {
    const d = ui.sheet;
    return d.pendingImage || d.draft.image || '';
}

function equipHtml() {
    const sh = ui.sheet;
    const isSaved = !!sh.id;
    const onChar = isSaved && wornId('char') === sh.id;
    const onUser = isSaved && wornId('user') === sh.id;
    const btn = (kind, on, icon, label) => `
        <button class="wd-equip ${on ? 'is-on' : ''}" data-act="sheet-wear" data-kind="${kind}" aria-pressed="${on}" ${keys[kind] ? '' : 'disabled'}>
            ${icon}<span>${esc(label)}</span>${on ? `<b>${ICON.check}</b>` : ''}
        </button>`;
    const both = onChar && onUser;
    return `
        <div class="wd-equip-row" role="group" aria-label="Who wears this outfit">
            ${btn('char', onChar, ICON.bot, displayName('char'))}
            ${btn('user', onUser, ICON.user, displayName('user'))}
            <button class="wd-equip wd-equip-both ${both ? 'is-on' : ''}" data-act="sheet-wear-both" ${keys.char && keys.user ? '' : 'disabled'}>
                ${ICON.shirt}<span>${both ? 'Both' : 'Both'}</span>
            </button>
        </div>`;
}

function sendHint(d) {
    const s = getSettings();
    const p = { prompt: !!d.prompt.trim(), image: !!(d.image || ui.sheet?.pendingImage) };
    const fake = { prompt: d.prompt, image: p.image ? 'x' : '' };
    const eff = outfitParts(fake);
    const modeName = { both: 'prompt and picture', prompt: 'prompt only', picture: 'picture only' }[s.sendMode];
    const sent = [eff.prompt && 'prompt', eff.image && 'picture'].filter(Boolean).join(' + ') || 'nothing yet';
    return `Send mode: ${modeName}. This outfit will send: <b>${sent}</b>.`;
}

function renderSheet() {
    const sh = ui.sheet;
    if (!sh) return;
    const s = getSettings();
    const d = sh.draft;
    const src = sheetPreviewSrc();
    const folderOptions = ['<option value="">Unsorted</option>']
        .concat(s.folders.map((f) => `<option value="${esc(f.id)}" ${f.id === d.folderId ? 'selected' : ''}>${esc(f.name)}</option>`))
        .join('');
    const tagSuggestions = allTags().map(([t]) => `<option value="${esc(t)}"></option>`).join('');
    overlay.querySelector('#wd_sheet_layer').innerHTML = `
        <div class="wd-sheet-scrim" data-act="sheet-close"></div>
        <section class="wd-sheet" role="dialog" aria-modal="true" aria-label="${sh.id ? 'Edit outfit' : 'New outfit'}">
            <div class="wd-sheet-grab" aria-hidden="true"></div>
            <div class="wd-sheet-head">
                <h3>${sh.id ? 'Outfit' : 'New outfit'}</h3>
                <button class="wd-icon-btn" data-act="sheet-close" aria-label="Close">${ICON.close}</button>
            </div>
            <div class="wd-sheet-body">
                <div class="wd-pic ${src ? 'has-img' : ''}">
                    <button class="wd-pic-btn" data-act="pick-image" aria-label="${src ? 'Change picture' : 'Add picture'}">
                        ${src ? `<img src="${esc(src)}" alt="">` : `<span class="wd-pic-empty">${ICON.camera}<span>Add a picture</span></span>`}
                    </button>
                    ${src ? `<div class="wd-pic-actions">
                        <button class="wd-btn wd-btn-soft" data-act="pick-image">${ICON.camera}<span>Change</span></button>
                        <button class="wd-btn wd-btn-soft" data-act="clear-image">${ICON.trash}<span>Remove</span></button>
                    </div>` : ''}
                </div>

                <div class="wd-block">
                    <div class="wd-label">Who wears it</div>
                    <div id="wd_equip">${equipHtml()}</div>
                </div>

                <label class="wd-field">
                    <span class="wd-label">Name</span>
                    <input id="wd_name" type="text" maxlength="60" value="${esc(d.name)}" placeholder="Red evening dress" autocomplete="off">
                </label>

                <label class="wd-field">
                    <span class="wd-label">Outfit prompt</span>
                    <textarea id="wd_prompt" rows="4" placeholder="long red satin dress, thin straps, black heels, silver necklace">${esc(d.prompt)}</textarea>
                </label>
                <p class="wd-hint" id="wd_hint">${sendHint(d)}</p>

                <label class="wd-field">
                    <span class="wd-label">Folder</span>
                    <select id="wd_folder">${folderOptions}</select>
                </label>

                <div class="wd-field">
                    <span class="wd-label">Tags</span>
                    <div class="wd-taginput" id="wd_taginput">
                        ${d.tags.map((t) => `<span class="wd-tag">#${esc(t)}<button data-act="tag-remove" data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${ICON.close}</button></span>`).join('')}
                        <input id="wd_tag" type="text" list="wd_tag_list" placeholder="${d.tags.length ? '' : 'casual, winter, formal'}" autocomplete="off" enterkeyhint="done" aria-label="Add tag">
                        <datalist id="wd_tag_list">${tagSuggestions}</datalist>
                    </div>
                </div>
            </div>
            <div class="wd-sheet-foot">
                ${sh.id ? `<button class="wd-btn wd-btn-danger" data-act="sheet-delete">${ICON.trash}<span>Delete</span></button>` : '<span></span>'}
                <button class="wd-btn wd-btn-accent" data-act="sheet-save">${ICON.check}<span>Save</span></button>
            </div>
        </section>`;
    bindSheetInputs();
}

function bindSheetInputs() {
    const sh = ui.sheet;
    const root = overlay.querySelector('#wd_sheet_layer');
    const hint = () => {
        const el = root.querySelector('#wd_hint');
        if (el) el.innerHTML = sendHint(sh.draft);
    };
    root.querySelector('#wd_name').addEventListener('input', (e) => { sh.draft.name = e.target.value; });
    root.querySelector('#wd_prompt').addEventListener('input', (e) => { sh.draft.prompt = e.target.value; hint(); });
    root.querySelector('#wd_folder').addEventListener('change', (e) => { sh.draft.folderId = e.target.value; });
    const tagInput = root.querySelector('#wd_tag');
    const commitTag = () => {
        const parts = tagInput.value.split(',').map(normalizeTag).filter(Boolean);
        if (!parts.length) { tagInput.value = ''; return; }
        for (const p of parts) if (!sh.draft.tags.includes(p)) sh.draft.tags.push(p);
        tagInput.value = '';
        refreshTagInput();
    };
    tagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commitTag();
        } else if (e.key === 'Backspace' && !tagInput.value && sh.draft.tags.length) {
            sh.draft.tags.pop();
            refreshTagInput();
        }
    });
    tagInput.addEventListener('change', commitTag);
    tagInput.addEventListener('blur', commitTag);
}

function refreshTagInput() {
    const sh = ui.sheet;
    if (!sh) return;
    const box = overlay.querySelector('#wd_taginput');
    const input = overlay.querySelector('#wd_tag');
    const hadFocus = document.activeElement === input;
    box.querySelectorAll('.wd-tag').forEach((n) => n.remove());
    const frag = sh.draft.tags.map((t) => `<span class="wd-tag">#${esc(t)}<button data-act="tag-remove" data-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">${ICON.close}</button></span>`).join('');
    input.insertAdjacentHTML('beforebegin', frag);
    input.placeholder = sh.draft.tags.length ? '' : 'casual, winter, formal';
    if (hadFocus) input.focus({ preventScroll: true });
}

async function commitSheet() {
    const sh = ui.sheet;
    if (!sh) return null;
    const s = getSettings();
    const d = sh.draft;
    const name = d.name.trim() || 'Untitled outfit';
    const tags = normalizeTags(d.tags);
    let image = d.image || '';
    const old = sh.id ? getOutfit(sh.id)?.image || '' : '';

    if (sh.pendingImage) {
        image = await uploadOutfitImage(sh.pendingImage, name);
        sh.pendingImage = null;
        d.image = image;
    }
    if (sh.id) {
        const o = getOutfit(sh.id);
        if (o) {
            Object.assign(o, {
                name, tags, image,
                prompt: d.prompt.trim(),
                folderId: d.folderId || '',
                updatedAt: Date.now(),
            });
        }
    } else {
        const o = {
            id: uid('o'), name, tags, image,
            prompt: d.prompt.trim(),
            folderId: d.folderId || '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        s.outfits.push(o);
        sh.id = o.id;
    }
    d.name = name;
    d.tags = tags;
    if (old && old !== image) await deleteOutfitImage(old);
    syncAll();
    return getOutfit(sh.id);
}

// ---------------------------------------------------------------- UI: dialog (prompt / confirm)

function askDialog({ title, message = '', value = null, ok = 'OK', danger = false }) {
    return new Promise((resolve) => {
        const layer = overlay.querySelector('#wd_dialog_layer');
        layer.hidden = false;
        layer.innerHTML = `
            <div class="wd-dialog-scrim"></div>
            <form class="wd-dialog" role="alertdialog" aria-label="${esc(title)}">
                <h3>${esc(title)}</h3>
                ${message ? `<p>${esc(message)}</p>` : ''}
                ${value !== null ? `<input type="text" id="wd_dialog_input" maxlength="40" value="${esc(value)}" autocomplete="off">` : ''}
                <div class="wd-dialog-actions">
                    <button type="button" class="wd-btn wd-btn-soft" data-d="cancel">Cancel</button>
                    <button type="submit" class="wd-btn ${danger ? 'wd-btn-danger' : 'wd-btn-accent'}">${esc(ok)}</button>
                </div>
            </form>`;
        const form = layer.querySelector('form');
        const input = layer.querySelector('input');
        const done = (result) => {
            layer.hidden = true;
            layer.innerHTML = '';
            resolve(result);
        };
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            done(value !== null ? input.value.trim() : true);
        });
        layer.querySelector('[data-d="cancel"]').addEventListener('click', () => done(null));
        layer.querySelector('.wd-dialog-scrim').addEventListener('click', () => done(null));
        form.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        });
        (input || layer.querySelector('[type="submit"]')).focus();
        input?.select();
    });
}

// ---------------------------------------------------------------- UI: events

function onOverlayKey(e) {
    if (e.key === 'Escape') {
        if (!overlay.querySelector('#wd_dialog_layer').hidden) return;
        e.stopPropagation();
        if (ui.sheet) closeSheet();
        else closePanel();
        return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('wd-card')) {
        e.preventDefault();
        openSheet(e.target.dataset.id);
    }
}

async function onOverlayClick(e) {
    const target = e.target.closest('[data-act]');
    if (!target || !overlay.contains(target)) {
        if (e.target === overlay) closePanel();
        return;
    }
    const act = target.dataset.act;
    const id = target.dataset.id;
    const kind = target.dataset.kind;

    switch (act) {
        case 'close': closePanel(); break;
        case 'opacity-toggle': {
            const row = overlay.querySelector('#wd_opacity_row');
            row.hidden = !row.hidden;
            target.setAttribute('aria-expanded', String(!row.hidden));
            if (!row.hidden) row.querySelector('input').focus({ preventScroll: true });
            break;
        }
        case 'new': openSheet(null); break;
        case 'open': openSheet(id); break;
        case 'toggle':
            e.stopPropagation();
            toggleWear(kind, id);
            renderRail();
            renderGrid();
            break;
        case 'unwear':
            unwear(kind);
            renderRail();
            renderGrid();
            break;
        case 'folder':
            ui.folder = id;
            renderFolders();
            renderGrid();
            break;
        case 'folder-new': {
            const name = await askDialog({ title: 'New folder', value: '', ok: 'Create' });
            if (name) {
                const f = { id: uid('f'), name };
                getSettings().folders.push(f);
                save();
                ui.folder = f.id;
                renderFolders();
                renderGrid();
                if (ui.sheet) renderSheet();
            }
            break;
        }
        case 'folder-manage':
            ui.manage = !ui.manage;
            renderFolders();
            break;
        case 'folder-rename': {
            const f = getSettings().folders.find((x) => x.id === id);
            if (!f) break;
            const name = await askDialog({ title: 'Rename folder', value: f.name, ok: 'Rename' });
            if (name) {
                f.name = name;
                save();
                renderFolders();
            }
            break;
        }
        case 'folder-delete': {
            const s = getSettings();
            const f = s.folders.find((x) => x.id === id);
            if (!f) break;
            const ok = await askDialog({
                title: `Delete folder "${f.name}"?`,
                message: 'Outfits inside are kept and move to Unsorted.',
                ok: 'Delete folder',
                danger: true,
            });
            if (!ok) break;
            s.outfits.forEach((o) => { if (o.folderId === id) o.folderId = ''; });
            s.folders = s.folders.filter((x) => x.id !== id);
            if (ui.folder === id) ui.folder = 'all';
            save();
            renderFolders();
            renderGrid();
            break;
        }
        case 'tag': {
            const t = target.dataset.tag;
            if (ui.tags.has(t)) ui.tags.delete(t);
            else ui.tags.add(t);
            renderTags();
            renderGrid();
            break;
        }

        // ---- sheet
        case 'sheet-close': closeSheet(); break;
        case 'pick-image': overlay.querySelector('#wd_file').click(); break;
        case 'clear-image':
            ui.sheet.pendingImage = null;
            ui.sheet.draft.image = '';
            renderSheet();
            break;
        case 'tag-remove':
            ui.sheet.draft.tags = ui.sheet.draft.tags.filter((t) => t !== target.dataset.tag);
            refreshTagInput();
            break;
        case 'sheet-save':
            await withBusy(target, async () => {
                await commitSheet();
                renderPanel();
                closeSheet();
            });
            break;
        case 'sheet-wear':
            await withBusy(target, async () => {
                const o = await commitSheet();
                if (!o) return;
                toggleWear(kind, o.id);
                renderSheet();
                renderPanel();
            });
            break;
        case 'sheet-wear-both':
            await withBusy(target, async () => {
                const o = await commitSheet();
                if (!o) return;
                const both = wornId('char') === o.id && wornId('user') === o.id;
                if (both) { unwear('char'); unwear('user'); } else { wear('char', o.id); wear('user', o.id); }
                renderSheet();
                renderPanel();
            });
            break;
        case 'sheet-delete': {
            const o = getOutfit(ui.sheet.id);
            if (!o) break;
            const ok = await askDialog({
                title: `Delete "${o.name}"?`,
                message: 'The outfit and its picture are removed. Anyone wearing it will be undressed.',
                ok: 'Delete',
                danger: true,
            });
            if (!ok) break;
            unwearEverywhere(o.id);
            const s = getSettings();
            s.outfits = s.outfits.filter((x) => x.id !== o.id);
            await deleteOutfitImage(o.image);
            syncAll();
            closeSheet();
            renderPanel();
            break;
        }
        default: break;
    }
}

async function withBusy(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('is-busy');
    try {
        await fn();
    } catch (error) {
        console.error('[Wardrobe]', error);
        toast('error', error?.message || 'Something went wrong');
    } finally {
        button.disabled = false;
        button.classList.remove('is-busy');
    }
}

async function onFilePicked(e) {
    const input = e.target;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !ui.sheet) return;
    try {
        ui.sheet.pendingImage = await fileToDataUrl(file);
        renderSheet();
    } catch (error) {
        toast('error', error?.message || 'Could not read this image');
    }
}

// ---------------------------------------------------------------- export / import

async function exportWardrobe() {
    const s = getSettings();
    const outfits = [];
    for (const o of s.outfits) {
        let imageData = '';
        if (o.image) {
            try { imageData = await pathToDataUrl(o.image); } catch (_e) { /* skip missing */ }
        }
        outfits.push({
            name: o.name, prompt: o.prompt, tags: o.tags || [],
            folder: s.folders.find((f) => f.id === o.folderId)?.name || '',
            imageData,
        });
    }
    const payload = { kind: 'wardrobe', version: 1, outfits };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wardrobe.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('success', `Exported ${outfits.length} outfit(s).`);
}

async function importWardrobe(file) {
    let payload;
    try {
        payload = JSON.parse(await file.text());
    } catch (_e) {
        toast('error', 'This file is not valid JSON.');
        return;
    }
    if (payload?.kind !== 'wardrobe' || !Array.isArray(payload.outfits)) {
        toast('error', 'This is not a wardrobe export.');
        return;
    }
    const s = getSettings();
    let added = 0;
    for (const raw of payload.outfits) {
        let folderId = '';
        const folderName = String(raw.folder || '').trim();
        if (folderName) {
            let f = s.folders.find((x) => x.name.toLowerCase() === folderName.toLowerCase());
            if (!f) {
                f = { id: uid('f'), name: folderName };
                s.folders.push(f);
            }
            folderId = f.id;
        }
        let image = '';
        if (raw.imageData && String(raw.imageData).startsWith('data:image/')) {
            try { image = await uploadOutfitImage(raw.imageData, raw.name); } catch (_e) { /* keep text */ }
        }
        s.outfits.push({
            id: uid('o'),
            name: String(raw.name || 'Imported outfit').slice(0, 60),
            prompt: String(raw.prompt || ''),
            tags: normalizeTags(raw.tags),
            folderId, image,
            createdAt: Date.now(), updatedAt: Date.now(),
        });
        added++;
    }
    save();
    toast('success', `Imported ${added} outfit(s).`);
    if (ui.open) renderPanel();
}

// ---------------------------------------------------------------- settings drawer

function buildSettingsDrawer() {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container || document.getElementById('wd_settings_root')) return;
    const s = getSettings();
    const radio = (value, label, hint) => `
        <label class="wd-seg ${s.sendMode === value ? 'is-on' : ''}">
            <input type="radio" name="wd_send_mode" value="${value}" ${s.sendMode === value ? 'checked' : ''}>
            <b>${label}</b><small>${hint}</small>
        </label>`;
    container.insertAdjacentHTML('beforeend', `
        <div id="wd_settings_root" class="inline-drawer wd-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Wardrobe</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="wd-set-status" id="wd_status"></div>
                <button class="wd-btn wd-btn-accent wd-set-open" id="wd_open_btn">${ICON.shirt}<span>Open wardrobe</span></button>

                <div class="wd-set-title">What to send to image generation</div>
                <div class="wd-segs" id="wd_modes">
                    ${radio('prompt', 'Prompt', 'Text only')}
                    ${radio('picture', 'Picture', 'Reference image')}
                    ${radio('both', 'Both', 'Text and image')}
                </div>
                <label class="checkbox_label wd-set-check">
                    <input type="checkbox" id="wd_fallback" ${s.fallback ? 'checked' : ''}>
                    <span>If an outfit lacks the chosen part, send the other one</span>
                </label>

                <label class="wd-set-field">
                    <span>Prompt prefix</span>
                    <input type="text" class="text_pole" id="wd_prefix" value="${esc(s.textPrefix)}">
                </label>
                <label class="wd-set-field">
                    <span>Note sent with the picture</span>
                    <input type="text" class="text_pole" id="wd_imgnote" value="${esc(s.imageNote)}">
                </label>

                <label class="wd-set-field">
                    <span>Panel opacity: <b id="wd_set_opacity_out">${clampOpacity(s.opacity)}%</b></span>
                    <input type="range" id="wd_set_opacity" min="30" max="100" step="1" value="${clampOpacity(s.opacity)}">
                </label>

                <div class="wd-set-title">Chat model macros</div>
                <p class="wd-set-hint">Put <code>{{outfit_char}}</code> or <code>{{outfit_user}}</code> in a card or preset so the chat model knows what is worn and writes matching image prompts.</p>

                <div class="wd-set-row">
                    <button class="wd-btn wd-btn-soft" id="wd_export">Export</button>
                    <button class="wd-btn wd-btn-soft" id="wd_import">Import</button>
                    <input type="file" id="wd_import_file" accept="application/json,.json" hidden>
                </div>
            </div>
        </div>`);

    const root = document.getElementById('wd_settings_root');
    const updateStatus = () => {
        const el = root.querySelector('#wd_status');
        const ok = iigPresent();
        el.className = `wd-set-status ${ok ? 'is-ok' : 'is-bad'}`;
        el.innerHTML = ok
            ? `${ICON.check}<span>Connected to Inline Image Generation</span>`
            : `${ICON.close}<span>Inline Image Generation not detected</span>`;
    };
    updateStatus();
    root.querySelector('.inline-drawer-toggle').addEventListener('click', updateStatus);
    root.querySelector('#wd_open_btn').addEventListener('click', openPanel);
    root.querySelectorAll('input[name="wd_send_mode"]').forEach((input) => {
        input.addEventListener('change', () => {
            getSettings().sendMode = input.value;
            root.querySelectorAll('.wd-seg').forEach((n) => n.classList.toggle('is-on', n.querySelector('input').checked));
            syncAll();
            if (ui.open) renderPanel();
        });
    });
    root.querySelector('#wd_fallback').addEventListener('change', (e) => {
        getSettings().fallback = e.target.checked;
        syncAll();
    });
    root.querySelector('#wd_prefix').addEventListener('input', (e) => {
        getSettings().textPrefix = e.target.value;
        syncAll();
    });
    root.querySelector('#wd_imgnote').addEventListener('input', (e) => {
        getSettings().imageNote = e.target.value;
        syncAll();
    });
    root.querySelector('#wd_set_opacity').addEventListener('input', (e) => setOpacity(e.target.value));
    root.querySelector('#wd_export').addEventListener('click', exportWardrobe);
    const importFile = root.querySelector('#wd_import_file');
    root.querySelector('#wd_import').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
        const file = importFile.files?.[0];
        importFile.value = '';
        if (file) await importWardrobe(file);
    });
}

function addMenuEntry() {
    if (document.getElementById('wd_wand_item')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = 'wd_wand_item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-shirt extensionsMenuExtensionButton"></div><span>Wardrobe</span>';
    item.addEventListener('click', openPanel);
    item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
    });
    menu.appendChild(item);
}

// ---------------------------------------------------------------- macros / events / init

function promptFor(kind) {
    const outfit = getOutfit(wornId(kind));
    return outfit ? String(outfit.prompt || outfit.name || '').trim() : '';
}

function registerMacros() {
    try {
        const c = ctx();
        if (typeof c.registerMacro !== 'function') return;
        c.registerMacro('outfit_char', () => promptFor('char'), 'Wardrobe: outfit prompt currently worn by the character.');
        c.registerMacro('outfit_user', () => promptFor('user'), 'Wardrobe: outfit prompt currently worn by the user persona.');
    } catch (error) {
        console.warn('[Wardrobe] Could not register macros:', error);
    }
}

async function onContextChanged() {
    await refreshKeys();
    syncKey('char', keys.char);
    syncKey('user', keys.user);
    if (ui.open) renderPanel();
}

(function init() {
    getSettings();
    const c = ctx();
    registerMacros();
    c.eventSource.on(c.event_types.APP_READY, async () => {
        buildSettingsDrawer();
        addMenuEntry();
        await refreshKeys();
        syncAll();
        console.log('[Wardrobe] loaded');
    });
    for (const name of ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'USER_AVATAR_CHANGED', 'PERSONA_CHANGED']) {
        const eventName = c.event_types?.[name];
        if (eventName) c.eventSource.on(eventName, () => { onContextChanged(); });
    }
})();
