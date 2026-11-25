/**
 * Wardrobe — outfit manager for SillyTavern. It works with any image generator.
 *
 * The outfit a character / persona / NPC wears in a chat (stored per chat) is offered through:
 *   - chat-model injection (the model writes the outfit into the image prompt)
 *   - SillyTavern's built-in Image Generation (sd_prompt_processing event)
 *   - the sillyimages character library (managed "appearance items", ids start with `wardrobe-`)
 *   - an opt-in catch-all hook on outgoing image requests of any extension
 *   - window.WardrobeAPI, the `wardrobe_changed` event, macros and slash commands
 *
 * Auto outfits pick from a pool by what the recent messages are about (lorebook-style tag triggers).
 */

const MODULE_NAME = 'wardrobe';
const IIG_MODULE = 'inline_image_gen';
const EXT_PROMPT_KEY = 'wardrobe_outfits';
const CHAT_KEY = 'wardrobe'; // chat_metadata key: what is worn in THIS chat
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
    novelaiLibraryText: false, // direct NovelAI: also add outfit as an extra `|` character prompt (off: chat model writes it)
    libraryAdapter: true, // write the outfit into the sillyimages character library
    sdHook: true, // add the outfit to SillyTavern's built-in Image Generation prompt
    fetchHook: false, // catch-all: add the outfit to outgoing image-generation requests of ANY extension
    hookTarget: 'char', // which outfit(s) the catch-all adds: char | user | both
    hookPatterns: '/api/sd/\n/api/novelai/\n/generate-image\n/images/generations\n/sdapi/v1/txt2img\n/sdapi/v1/img2img',
    injectChat: true, // also tell the chat model what is worn, so it writes the outfit into the image prompt
    auto: {
        enabled: false, // auto outfits: pick from a pool by what the scene is about (like a lorebook)
        scanDepth: 3, // how many recent messages are read
        fallback: 'keep', // nothing matches: 'keep' the current outfit | 'default' (tag "default") | 'off' (undress)
        tagKeywords: {}, // extra trigger words per tag: { home: 'flat, my place, /regex/' }
        pools: {}, // { 'char:<key>': [outfitId], 'user:<key>': [outfitId] }
        npcs: [], // [{ id, name, aliases, pool: [outfitId] }]
    },
    folders: [],
    outfits: [],
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
    return s;
}

function save() {
    ctx().saveSettingsDebounced();
}

// ---------------------------------------------------------------- helpers

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
}[ch]));

const SELF_BASE = new URL('./', import.meta.url).href;
const diagErrors = [];
globalThis.__sillywardrobeLoads = (globalThis.__sillywardrobeLoads || 0) + 1;

function recordError(source, message) {
    diagErrors.push(`${new Date().toTimeString().slice(0, 8)} ${source}: ${message}`);
    if (diagErrors.length > 30) diagErrors.shift();
}

window.addEventListener('error', (e) => {
    if (String(e.filename || '').startsWith(SELF_BASE)) {
        recordError('window.error', `${e.message} (${String(e.filename).replace(SELF_BASE, '')}:${e.lineno}:${e.colno})`);
    }
});
window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (String(r?.stack || '').includes(SELF_BASE)) recordError('unhandled promise', r?.message || String(r));
});

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function toast(kind, message) {
    if (kind === 'error') recordError('toast', message);
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

// ---- per-chat worn state (lives in chat_metadata, so every chat has its own outfits)

function chatOpen() {
    try { return !!ctx().chatId; } catch (_e) { return false; }
}

function chatState(create = false) {
    const md = ctx().chatMetadata;
    if (!md || typeof md !== 'object' || !chatOpen()) return null;
    let st = md[CHAT_KEY];
    if (!st || typeof st !== 'object') {
        if (!create) return null;
        st = md[CHAT_KEY] = { char: null, user: null };
    }
    if (!Object.hasOwn(st, 'char')) st.char = null;
    if (!Object.hasOwn(st, 'user')) st.user = null;
    return st;
}

function saveChat() {
    const c = ctx();
    try {
        if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
        else if (typeof c.saveMetadata === 'function') c.saveMetadata();
    } catch (e) { recordError('saveMetadata', e?.message || String(e)); }
}

function stripManaged(entry) {
    if (!entry || !Array.isArray(entry.appearanceItems)) return;
    entry.appearanceItems = entry.appearanceItems.filter((item) => !String(item?.id || '').startsWith(MANAGED_PREFIX));
}

function syncKey(kind, key) {
    if (!key) return;
    const bucket = iigBucket(kind);
    if (!bucket) return;
    const s = getSettings();
    if (s.libraryAdapter === false) { stripManaged(bucket[key]); return; }
    const outfit = getOutfit(chatState()?.[kind]);
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
    stripManaged(entry);
    if (!Array.isArray(entry.appearanceItems)) entry.appearanceItems = [];
    if (!outfit) return;
    const parts = outfitParts(outfit);
    // Direct NovelAI turns library descriptions into extra "| ..." character prompts (and ignores pictures),
    // which does not attach to the scene's own characters. So there the chat model writes the outfit
    // (see updateInjection) and the library text is opt-in.
    const naiDirect = ctx().extensionSettings?.[IIG_MODULE]?.apiType === 'novelai';
    if (naiDirect) parts.image = false;
    if (naiDirect && !s.novelaiLibraryText) parts.prompt = false;
    if (parts.prompt) {
        entry.appearanceItems.push({
            id: `${MANAGED_PREFIX}text`,
            type: 'text',
            enabled: true,
            imagePath: '',
            description: `${naiDirect ? '' : (s.textPrefix || '')}${String(outfit.prompt).trim()}`.trim(),
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

// The sillyimages library is global (per character / persona), so on every chat switch the managed
// wardrobe items are cleared everywhere and only the open chat's outfits are written back in.
function syncAll() {
    for (const kind of ['char', 'user']) {
        const bucket = iigBucket(kind);
        if (!bucket) continue;
        for (const entry of Object.values(bucket)) stripManaged(entry);
    }
    for (const kind of ['char', 'user']) syncKey(kind, keys[kind]);
    updateInjection();
    save();
}


// Chat-model injection: independent of the sillyimages library. The image prompt is written by the chat
// model (the "prompt" / per-character prompts in the image tag), so telling it what is worn per chat
// puts the outfit into the picture prompt for every provider, including text-only ones like NovelAI.
function buildInjection() {
    const s = getSettings();
    if (!s.injectChat || !chatOpen()) return '';
    const lines = [];
    for (const kind of ['char', 'user']) {
        const outfit = getOutfit(wornId(kind));
        const text = outfit ? String(outfit.prompt || outfit.name || '').trim() : '';
        if (text) lines.push(`${displayName(kind)} is currently wearing: ${text}`);
    }
    for (const n of presentNpcOutfits()) lines.push(`${n.name} is currently wearing: ${n.prompt}`);
    if (!lines.length) return '';
    return `[Current outfits. ${lines.join('. ')}. When you write an image prompt (including per-character prompts), describe exactly this clothing for the matching character, using the same wording style as the rest of the prompt. Change it only if the story changes what they wear.]`;
}

function updateInjection() {
    try {
        const c = ctx();
        if (typeof c.setExtensionPrompt !== 'function') return;
        const pos = c.extension_prompt_types?.IN_CHAT ?? 1;
        const role = c.extension_prompt_roles?.SYSTEM ?? 0;
        c.setExtensionPrompt(EXT_PROMPT_KEY, buildInjection(), pos, 1, false, role);
    } catch (e) { recordError('inject', e?.message || String(e)); }
    notifyChange();
}

// ---------------------------------------------------------------- wearing

function wornId(kind) {
    const id = chatState()?.[kind] || null;
    return id && getOutfit(id) ? id : null;
}

// A manual change while auto mode is active pins that subject in this chat until "Resume auto" is pressed.
function pinIfAuto(kind, opts) {
    if (opts?.auto || !autoActive() || !hasPool(kind)) return;
    const st = chatState(true);
    if (st) {
        st.pins = st.pins && typeof st.pins === 'object' ? st.pins : {};
        st.pins[kind] = true;
    }
}

function wear(kind, outfitId, opts = {}) {
    const key = keys[kind];
    if (!key || !chatOpen()) return false;
    const st = chatState(true);
    if (!st) return false;
    st[kind] = outfitId;
    pinIfAuto(kind, opts);
    saveChat();
    syncKey(kind, key);
    updateInjection();
    save();
    return true;
}

function unwear(kind, opts = {}) {
    const st = chatState();
    if (st) st[kind] = null;
    pinIfAuto(kind, opts);
    if (st) saveChat();
    syncKey(kind, keys[kind]);
    updateInjection();
    save();
}

function toggleWear(kind, outfitId) {
    if (!keys[kind] || !chatOpen()) {
        toast('warning', 'Open a chat first.');
        return;
    }
    if (wornId(kind) === outfitId) unwear(kind);
    else wear(kind, outfitId);
}

// Only the open chat can be touched here; other chats drop a deleted outfit on their own
// (wornId ignores ids that no longer exist).
function unwearEverywhere(outfitId) {
    const st = chatState();
    if (!st) return;
    let changed = false;
    for (const kind of ['char', 'user']) {
        if (st[kind] === outfitId) { st[kind] = null; changed = true; }
    }
    for (const [npcId, id] of Object.entries(st.npcs || {})) {
        if (id === outfitId) { delete st.npcs[npcId]; changed = true; }
    }
    if (changed) { saveChat(); updateInjection(); }
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

function syncViewport() {
    if (!overlay) return;
    const vv = window.visualViewport;
    if (!vv) return;
    overlay.style.setProperty('--wd-vv-top', `${Math.max(0, Math.round(vv.offsetTop))}px`);
    overlay.style.setProperty('--wd-vv-h', `${Math.round(vv.height)}px`);
}

let viewportBound = false;
function bindViewport() {
    const vv = window.visualViewport;
    if (viewportBound || !vv) return;
    viewportBound = true;
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    window.addEventListener('orientationchange', () => setTimeout(syncViewport, 250));
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
    overlay.querySelector('#wd_sheet_layer').addEventListener('input', onAutoField);
    overlay.querySelector('#wd_sheet_layer').addEventListener('change', onAutoField);
    overlay.querySelector('#wd_opacity').addEventListener('input', (e) => setOpacity(e.target.value));
    applyOpacity();
    return overlay;
}

async function openPanel() {
    buildOverlay();
    await refreshKeys();
    ui.lastFocus = document.activeElement;
    overlay.hidden = false;
    bindViewport();
    syncViewport();
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

function anyOutputOn() {
    const s = getSettings();
    return !!(s.injectChat || s.sdHook || s.fetchHook || (s.libraryAdapter !== false && iigPresent()));
}

function renderNotice() {
    const el = overlay.querySelector('#wd_notice');
    if (anyOutputOn()) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
        <div class="wd-notice">
            <b>No output is switched on.</b>
            Outfits are saved, but nothing is sent anywhere. Turn a route on under Extensions → Wardrobe.
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

function autoBarHtml() {
    const a = autoCfg();
    const st = chatState();
    const state = !a.enabled ? 'Off' : (st?.autoOff ? 'Paused here' : 'On');
    let html = `<button class="wd-chip ${autoActive() ? 'is-active' : ''}" data-act="auto-open"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Auto outfits</span><em>${state}</em></button>`;
    if (autoActive()) {
        for (const kind of ['char', 'user']) {
            if (st?.pins?.[kind]) {
                html += `<button class="wd-chip wd-chip-ghost" data-act="auto-resume" data-kind="${kind}"><span>Resume auto for ${esc(displayName(kind))}</span></button>`;
            }
        }
    }
    return `<div class="wd-autobar">${html}</div>`;
}

function renderRail() {
    overlay.querySelector('#wd_rail').innerHTML = slotHtml('char') + slotHtml('user') + autoBarHtml();
}

// ---------------------------------------------------------------- UI: auto sheet

function openAutoSheet() {
    ui.sheet = { auto: true };
    renderAutoSheet();
    const layer = overlay.querySelector('#wd_sheet_layer');
    layer.hidden = false;
    requestAnimationFrame(() => layer.classList.add('is-in'));
}

function poolChipsHtml(subject) {
    const ref = poolRef(subject);
    const chosen = new Set(ref.get());
    const outfits = [...getSettings().outfits].sort((x, y) => String(x.name).localeCompare(String(y.name)));
    if (!outfits.length) return '<p class="wd-hint">Add some outfits first.</p>';
    const cards = outfits.map((o) => {
        const on = chosen.has(o.id);
        const media = o.image
            ? `<img src="${esc(o.image)}" alt="" loading="lazy" draggable="false">`
            : `<span class="wd-card-ph">${ICON.shirt}</span>`;
        const tags = (o.tags || []).slice(0, 3).map((x) => `#${esc(x)}`).join(' ');
        return `
        <button class="wd-pcard ${on ? 'is-on' : ''}" data-act="auto-pool" data-subject="${esc(subject)}" data-id="${esc(o.id)}" aria-pressed="${on}" aria-label="${esc(o.name)}">
            <span class="wd-pcard-media">${media}<span class="wd-pcard-check" aria-hidden="true">${ICON.check}</span></span>
            <strong>${esc(o.name)}</strong>
            <small>${tags || 'no tags'}</small>
        </button>`;
    }).join('');
    return `<div class="wd-pool-grid">${cards}</div>
        <div class="wd-pool-tools">
            <button class="wd-btn wd-btn-soft" data-act="auto-pool-all" data-subject="${esc(subject)}"><span>All</span></button>
            <button class="wd-btn wd-btn-soft" data-act="auto-pool-none" data-subject="${esc(subject)}"><span>None</span></button>
        </div>`;
}

function renderAutoSheet() {
    if (!ui.sheet?.auto) return;
    const a = autoCfg();
    const st = chatState();
    const subjectBlock = (subject, label, icon) => {
        const ref = poolRef(subject);
        return `<div class="wd-block">
            <div class="wd-label">${icon} ${esc(label)}</div>
            ${ref.ok ? poolChipsHtml(subject) : '<p class="wd-hint">Open a chat first.</p>'}
        </div>`;
    };
    const npcs = a.npcs.map((n) => `
        <div class="wd-npc">
            <div class="wd-npc-head">
                <input type="text" data-npc="${esc(n.id)}" data-npcf="name" value="${esc(n.name)}" placeholder="NPC name" maxlength="40" autocomplete="off">
                <button class="wd-icon-btn" data-act="auto-npc-del" data-id="${esc(n.id)}" aria-label="Remove NPC">${ICON.trash}</button>
            </div>
            <input type="text" data-npc="${esc(n.id)}" data-npcf="aliases" value="${esc(n.aliases || '')}" placeholder="Other names, nicknames (comma separated)" maxlength="120" autocomplete="off">
            ${poolChipsHtml(`npc:${n.id}`)}
        </div>`).join('');
    const poolTags = new Set();
    const pools = [poolRef('char').get(), poolRef('user').get(), ...a.npcs.map((n) => n.pool || [])];
    for (const pool of pools) for (const id of pool) for (const tag of getOutfit(id)?.tags || []) poolTags.add(tag);
    const kwRows = [...poolTags].sort().map((tag) => {
        const builtIn = tagKeywordList(tag).filter((k) => k !== tag).slice(0, 5).join(', ');
        return `<label class="wd-field">
            <span class="wd-label">#${esc(tag)} <small class="wd-muted">${builtIn ? `built in: ${esc(builtIn)}…` : 'only the tag itself'}</small></span>
            <input type="text" data-kw="${esc(tag)}" value="${esc(a.tagKeywords[tag] || '')}" placeholder="extra trigger words, or /regex/" autocomplete="off">
        </label>`;
    }).join('');
    overlay.querySelector('#wd_sheet_layer').innerHTML = `
        <div class="wd-sheet-scrim" data-act="sheet-close"></div>
        <section class="wd-sheet" role="dialog" aria-modal="true" aria-label="Auto outfits">
            <div class="wd-sheet-grab" aria-hidden="true"></div>
            <div class="wd-sheet-head">
                <h3>Auto outfits</h3>
                <button class="wd-icon-btn" data-act="sheet-close" aria-label="Close">${ICON.close}</button>
            </div>
            <div class="wd-sheet-body">
                <div class="wd-block">
                    <div class="wd-pool">
                        <button class="wd-chip ${a.enabled ? 'is-active' : ''}" data-act="auto-master" aria-pressed="${a.enabled}"><span>Auto mode</span><em>${a.enabled ? 'On' : 'Off'}</em></button>
                        <button class="wd-chip ${st?.autoOff ? '' : 'is-active'}" data-act="auto-chat" aria-pressed="${!st?.autoOff}"><span>This chat</span><em>${st?.autoOff ? 'Paused' : 'Active'}</em></button>
                    </div>
                    <p class="wd-hint">Like a lorebook: each outfit's tags are trigger words. The recent messages are read, and the best match from the pool below is worn. Wearing something by hand pins it until you press "Resume auto".</p>
                </div>

                <div class="wd-block">
                    <label class="wd-field">
                        <span class="wd-label">Messages to read</span>
                        <input id="wd_auto_depth" type="number" min="1" max="12" value="${a.scanDepth}">
                    </label>
                    <label class="wd-field">
                        <span class="wd-label">When nothing matches</span>
                        <select id="wd_auto_fallback">
                            <option value="keep" ${a.fallback === 'keep' ? 'selected' : ''}>Keep the current outfit</option>
                            <option value="default" ${a.fallback === 'default' ? 'selected' : ''}>Wear the outfit tagged "default"</option>
                            <option value="off" ${a.fallback === 'off' ? 'selected' : ''}>Take the outfit off</option>
                        </select>
                    </label>
                </div>

                ${subjectBlock('char', `${displayName('char')} pool`, ICON.bot)}
                ${subjectBlock('user', `${displayName('user')} pool`, ICON.user)}

                <div class="wd-block">
                    <div class="wd-label">NPCs (found by name in the messages)</div>
                    ${npcs || '<p class="wd-hint">No NPCs yet.</p>'}
                    <button class="wd-btn wd-btn-soft" data-act="auto-npc-add">${ICON.plus}<span>Add NPC</span></button>
                </div>

                <div class="wd-block">
                    <div class="wd-label">Trigger words per tag</div>
                    ${kwRows || '<p class="wd-hint">Pick outfits for a pool above and their tags show up here. Add words like "my place" or a /regex/ to make a tag fire more often.</p>'}
                </div>

                <div class="wd-block">
                    <button class="wd-btn wd-btn-soft" data-act="auto-preview"><span>What would be worn right now?</span></button>
                    <pre class="wd-auto-preview" id="wd_auto_preview" hidden></pre>
                </div>
            </div>
        </section>`;
}

function autoRefresh() {
    autoEvaluate();
    if (ui.sheet?.auto) renderAutoSheet();
    if (overlay && ui.open) { renderRail(); renderGrid(); }
}

function onAutoField(e) {
    if (!ui.sheet?.auto) return;
    const el = e.target;
    const a = autoCfg();
    if (el.id === 'wd_auto_depth') {
        a.scanDepth = Math.min(12, Math.max(1, Math.round(Number(el.value)) || 3));
        save();
    } else if (el.id === 'wd_auto_fallback') {
        a.fallback = el.value;
        save();
    } else if (el.dataset.kw !== undefined) {
        a.tagKeywords[el.dataset.kw] = el.value;
        save();
    } else if (el.dataset.npcf) {
        const npc = a.npcs.find((n) => n.id === el.dataset.npc);
        if (npc) { npc[el.dataset.npcf] = el.value; save(); }
    } else {
        return;
    }
    if (e.type === 'change') { autoEvaluate(); renderRail(); }
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
    // Only auto-focus with a real pointer: on phones this would pop up the keyboard and shrink the page.
    if (!id && window.matchMedia?.('(pointer: fine)').matches) {
        overlay.querySelector('#wd_name')?.focus({ preventScroll: true });
    }
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
    try {
        await onOverlayClickInner(e);
    } catch (error) {
        console.error('[Wardrobe]', error);
        recordError('click handler', error?.stack || String(error));
        toast('error', `Wardrobe error: ${error?.message || error}`);
    }
}

async function onOverlayClickInner(e) {
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
        case 'auto-open': openAutoSheet(); break;
        case 'auto-master': {
            const a = autoCfg();
            a.enabled = !a.enabled;
            save();
            updateInjection();
            autoRefresh();
            break;
        }
        case 'auto-chat': {
            const st = chatState(true);
            if (st) { st.autoOff = !st.autoOff; saveChat(); }
            updateInjection();
            autoRefresh();
            break;
        }
        case 'auto-resume': {
            const st = chatState();
            if (st?.pins) { delete st.pins[kind]; saveChat(); }
            autoRefresh();
            break;
        }
        case 'auto-pool': {
            const ref = poolRef(target.dataset.subject);
            if (!ref.ok) break;
            const list = new Set(ref.get());
            if (list.has(id)) list.delete(id); else list.add(id);
            ref.set([...list]);
            save();
            autoRefresh();
            break;
        }
        case 'auto-pool-all':
        case 'auto-pool-none': {
            const ref = poolRef(target.dataset.subject);
            if (!ref.ok) break;
            ref.set(act === 'auto-pool-all' ? getSettings().outfits.map((o) => o.id) : []);
            save();
            autoRefresh();
            break;
        }
        case 'auto-npc-add': {
            const name = await askDialog({ title: 'New NPC', message: 'The name that appears in the chat. Wardrobe looks for it in the recent messages.', value: '', ok: 'Add' });
            if (!name) break;
            autoCfg().npcs.push({ id: uid('n'), name, aliases: '', pool: [] });
            save();
            renderAutoSheet();
            break;
        }
        case 'auto-npc-del': {
            const a = autoCfg();
            a.npcs = a.npcs.filter((n) => n.id !== id);
            const st = chatState();
            if (st?.npcs) { delete st.npcs[id]; saveChat(); }
            save();
            autoRefresh();
            break;
        }
        case 'auto-preview': {
            const box = overlay.querySelector('#wd_auto_preview');
            if (box) { box.textContent = autoPreview(); box.hidden = false; }
            break;
        }
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

// ---------------------------------------------------------------- diagnostics

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alphaOf(color) {
    const c = String(color || '');
    const slash = c.match(/\/\s*([\d.]+%?)\s*\)/);
    if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
    const rgba = c.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
    if (rgba) return parseFloat(rgba[1]);
    return 1;
}

function describeEl(el) {
    if (!el) return 'nothing';
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

async function runDiagnostics() {
    const out = [];
    const ok = (l, d = '') => out.push(`[OK]   ${l}${d ? ` — ${d}` : ''}`);
    const bad = (l, d = '') => out.push(`[FAIL] ${l}${d ? ` — ${d}` : ''}`);
    const warn = (l, d = '') => out.push(`[WARN] ${l}${d ? ` — ${d}` : ''}`);
    const info = (l, d = '') => out.push(`[i]    ${l}${d ? ` — ${d}` : ''}`);
    const section = (t) => out.push('', `== ${t} ==`);

    out.push('Wardrobe diagnostics', new Date().toString());

    section('Environment');
    try {
        info('Browser', navigator.userAgent);
        info('Viewport', `${innerWidth}x${innerHeight} @${devicePixelRatio}x` + (window.visualViewport ? ` (visual ${Math.round(visualViewport.width)}x${Math.round(visualViewport.height)})` : ''));
        const c = ctx();
        info('SillyTavern', String(c.version || SillyTavern.version || 'version not exposed'));
        info('Extension folder', SELF_BASE);
        const tests = {
            'color-mix': ['color', 'color-mix(in srgb, red 50%, blue)'],
            'relative color': ['color', 'rgb(from red r g b / 1)'],
            '100dvh': ['height', '100dvh'],
            'clip-path': ['clip-path', 'polygon(0 0, 100% 0, 100% 100%)'],
            'backdrop-filter': ['backdrop-filter', 'blur(1px)'],
        };
        for (const [name, [prop, val]] of Object.entries(tests)) {
            (CSS.supports(prop, val) ? ok : warn)(`CSS ${name}`, CSS.supports(prop, val) ? 'supported' : 'not supported');
        }
        const probe = document.createElement('i');
        probe.className = 'fa-solid fa-shirt';
        document.body.appendChild(probe);
        const ff = getComputedStyle(probe).fontFamily;
        probe.remove();
        (/awesome/i.test(ff) ? ok : warn)('Icon font', ff);
        const root = getComputedStyle(document.documentElement);
        for (const v of ['--SmartThemeBlurTintColor', '--SmartThemeBodyColor', '--SmartThemeQuoteColor']) {
            const val = root.getPropertyValue(v).trim() || '(not set)';
            info(v, `${val}${v === '--SmartThemeBlurTintColor' && alphaOf(val) < 1 ? '  <- translucent theme color' : ''}`);
        }
    } catch (e) { bad('Environment check crashed', e.message); }

    section('Loading / conflicts');
    try {
        const loads = globalThis.__sillywardrobeLoads || 0;
        (loads > 1 ? bad : ok)('Script loaded', `${loads} time(s)${loads > 1 ? ' — two copies of Wardrobe are running' : ''}`);
        for (const id of ['wd_overlay', 'wd_settings_root', 'wd_wand_item']) {
            const n = document.querySelectorAll(`[id="${id}"]`).length;
            (n > 1 ? bad : ok)(`Element #${id}`, `${n} found`);
        }
        const tags = [...document.querySelectorAll('script[src], link[rel="stylesheet"][href]')]
            .map((n) => n.src || n.href)
            .filter((u) => /wardrobe/i.test(u));
        info('Wardrobe-like files loaded', tags.length ? tags.map((u) => u.replace(location.origin, '')).join(' | ') : 'none found');
        if (new Set(tags.map((u) => u.split('/').slice(0, -1).join('/'))).size > 1) {
            warn('Several Wardrobe-style extensions are installed', 'they can share ids and CSS; keep only one enabled');
        }
        info('globalThis.sn3kWardrobe', globalThis.sn3kWardrobe ? 'present' : 'absent');
    } catch (e) { bad('Conflict check crashed', e.message); }

    section('Data');
    try {
        const s = getSettings();
        await refreshKeys();
        info('Outfits / folders', `${s.outfits.length} / ${s.folders.length}`);
        info('Send mode', `${s.sendMode}, fallback ${s.fallback}, opacity ${s.opacity}%`);
        (iigPresent() ? ok : warn)('sillyimages settings', iigPresent() ? 'found' : 'not found');
        info('Character key', String(keys.char));
        info('Persona key', String(keys.user));
        info('Worn (this char / persona)', `${wornId('char') || '-'} / ${wornId('user') || '-'}`);
        info('Chat open', String(chatOpen()));
        info('Outputs', `chat-model injection: ${getSettings().injectChat} | ST Image Generation hook: ${getSettings().sdHook} | sillyimages library: ${getSettings().libraryAdapter !== false} | catch-all: ${getSettings().fetchHook} (${getSettings().hookTarget})`);
        info('Auto outfits', `${autoActive() ? 'active' : 'inactive'} (master ${autoCfg().enabled}, chat paused ${!!chatState()?.autoOff}); pools: ${Object.keys(autoCfg().pools).length}, NPCs: ${autoCfg().npcs.length}`);
        info('Auto preview', autoPreview().replace(/\n/g, ' | '));
        info('Public API', typeof window.WardrobeAPI === 'object' ? 'window.WardrobeAPI ready' : 'missing');
        {
            const iig = ctx().extensionSettings?.[IIG_MODULE] || {};
            info('sillyimages apiType', String(iig.apiType));
            info('sillyimages sendRefDescriptions', String(iig.sendRefDescriptions));
            info('sillyimages NovelAI descriptions mode', String(iig.novelaiCharacterDescriptionsMode));
            info('sillyimages Naistera descriptions mode', String(iig.naisteraCharacterDescriptionsMode));
            if (iig.apiType === 'novelai') info('Outfit route on direct NovelAI', 'chat model writes it (library text only if the NovelAI checkbox is on)');
        }
        info('Worn state stored in this chat', JSON.stringify(chatState() || null));
        info('Chat-model injection', buildInjection() || '(nothing — no outfit worn, setting off, or no chat)');
        for (const kind of ['char', 'user']) {
            const entry = iigBucket(kind)?.[keys[kind]];
            const items = (entry?.appearanceItems || []).filter((i) => String(i?.id || '').startsWith(MANAGED_PREFIX));
            info(`sillyimages library entry (${kind})`, entry
                ? (items.length ? items.map((i) => `${i.type}: ${(i.description || i.imagePath || '').slice(0, 80)}`).join(' | ') : 'entry exists, no wardrobe items')
                : 'no entry for this key');
        }
        const odd = s.outfits.filter((o) => !o || !o.id || typeof o.name !== 'string' || !Array.isArray(o.tags));
        (odd.length ? bad : ok)('Outfit records valid', odd.length ? `${odd.length} malformed (missing id / name / tags array)` : 'all fine');
        const dup = s.outfits.length - new Set(s.outfits.map((o) => o?.id)).size;
        (dup ? bad : ok)('Outfit ids unique', dup ? `${dup} duplicate id(s)` : 'yes');
    } catch (e) { bad('Data check crashed', e.message); }

    section('Panel self-test (opens the panel briefly)');
    const wasOpen = ui.open;
    let testId = null;
    try {
        await openPanel();
        await sleep(80);
        const cs = getComputedStyle(overlay);
        info('Overlay', `display ${cs.display}, position ${cs.position}, z-index ${cs.zIndex}`);
        const panel = overlay.querySelector('.wd-panel');
        const pr = panel.getBoundingClientRect();
        (pr.width > 50 && pr.height > 50 ? ok : bad)('Panel size', `${Math.round(pr.width)}x${Math.round(pr.height)}`);
        const pa = alphaOf(getComputedStyle(panel).backgroundColor);
        info('Panel background alpha', `${pa} (setting ${getSettings().opacity}%)`);

        const btn = overlay.querySelector('.wd-head [data-act="new"]');
        const br = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
        (hit && btn.contains(hit) ? ok : bad)('+Outfit button reachable', hit && btn.contains(hit) ? 'tap lands on it' : `covered by ${describeEl(hit)}`);

        btn.click();
        await sleep(700);
        const vv = window.visualViewport;
        info('Viewport now', `inner ${innerWidth}x${innerHeight}, client ${document.documentElement.clientWidth}x${document.documentElement.clientHeight}` + (vv ? `, visual ${Math.round(vv.width)}x${Math.round(vv.height)} offsetTop ${Math.round(vv.offsetTop)}` : '') + `, scrollY ${Math.round(scrollY)}`);
        const orc = overlay.getBoundingClientRect();
        info('Overlay rect', `y ${Math.round(orc.top)} to ${Math.round(orc.bottom)}`);
        const lrc = overlay.querySelector('#wd_sheet_layer')?.getBoundingClientRect();
        if (lrc) info('Sheet layer rect', `y ${Math.round(lrc.top)} to ${Math.round(lrc.bottom)}`);
        (ui.sheet ? ok : bad)('+Outfit opens editor state', ui.sheet ? 'yes' : 'ui.sheet is empty after click');
        const sheet = overlay.querySelector('.wd-sheet');
        if (!sheet) {
            bad('Editor sheet element', 'not rendered');
        } else {
            const sc = getComputedStyle(sheet);
            const sr = sheet.getBoundingClientRect();
            (sr.width > 50 && sr.height > 50 ? ok : bad)('Sheet size', `${Math.round(sr.width)}x${Math.round(sr.height)} at (${Math.round(sr.x)},${Math.round(sr.y)})`);
            (sc.opacity === '1' ? ok : bad)('Sheet opacity', sc.opacity);
            (sc.visibility === 'visible' ? ok : bad)('Sheet visibility', sc.visibility);
            const sa = alphaOf(sc.backgroundColor);
            (sa >= 0.99 ? ok : bad)('Sheet background', `alpha ${sa}`);
            const inside = (x, y) => { const e = document.elementFromPoint(x, y); return e && sheet.contains(e) ? null : describeEl(e); };
            const bx = sr.x + sr.width / 2;
            const cover = inside(bx, sr.y + Math.min(60, sr.height / 2));
            (cover ? bad : ok)('Sheet on top', cover ? `covered by ${cover}` : 'nothing above it');
            const nameEl = overlay.querySelector('#wd_name');
            const nr = nameEl.getBoundingClientRect();
            const nameCover = inside(nr.x + nr.width / 2, nr.y + nr.height / 2);
            (nr.height > 0 && !nameCover ? ok : bad)('Name field reachable', nameCover ? `covered by ${nameCover}` : `${Math.round(nr.width)}x${Math.round(nr.height)}`);
            const saveBtn = overlay.querySelector('[data-act="sheet-save"]');
            const svr = saveBtn.getBoundingClientRect();
            const inView = svr.bottom <= innerHeight + 1 && svr.top >= 0;
            (inView ? ok : bad)('Save button on screen', `y ${Math.round(svr.top)}-${Math.round(svr.bottom)} of ${innerHeight}`);
        }

        ui.sheet.draft.name = '__wardrobe_diag__';
        ui.sheet.draft.prompt = 'diagnostic test';
        const created = await commitSheet();
        testId = created?.id || null;
        (testId && getOutfit(testId) ? ok : bad)('Create outfit (save)', testId ? 'saved' : 'nothing was saved');
        closeSheet(true);
        if (testId) {
            openSheet(testId);
            await sleep(100);
            (ui.sheet?.id === testId && ui.sheet.draft.name === '__wardrobe_diag__' ? ok : bad)('Open existing outfit', ui.sheet ? `draft "${ui.sheet.draft.name}"` : 'editor did not open');
            if (ui.sheet) {
                ui.sheet.draft.name = '__wardrobe_diag_edited__';
                await commitSheet();
                (getOutfit(testId)?.name === '__wardrobe_diag_edited__' ? ok : bad)('Edit outfit (save)', getOutfit(testId)?.name || 'missing');
            }
        }
    } catch (e) {
        bad('Panel self-test crashed', e?.stack || String(e));
    } finally {
        try {
            const s = getSettings();
            s.outfits = s.outfits.filter((o) => !String(o?.name || '').startsWith('__wardrobe_diag'));
            unwearEverywhere(testId);
            syncAll();
            closeSheet(true);
            if (!wasOpen) closePanel(); else renderPanel();
        } catch (e) { bad('Cleanup failed', e.message); }
    }

    section('Recent errors');
    if (diagErrors.length) diagErrors.forEach((line) => out.push(line)); else out.push('none recorded');

    const fails = out.filter((l) => l.startsWith('[FAIL]')).length;
    out.splice(2, 0, fails ? `RESULT: ${fails} check(s) failed` : 'RESULT: all checks passed');
    return out.join('\n');
}

function showDiagnosticsReport(text) {
    document.getElementById('wd_diag')?.remove();
    const el = document.createElement('div');
    el.id = 'wd_diag';
    el.className = 'wd-diag';
    el.innerHTML = `
        <div class="wd-diag-card" role="dialog" aria-label="Wardrobe diagnostics">
            <div class="wd-diag-head"><b>Wardrobe diagnostics</b></div>
            <textarea readonly spellcheck="false"></textarea>
            <div class="wd-diag-actions">
                <button data-diag="copy">Copy report</button>
                <button data-diag="close">Close</button>
            </div>
        </div>`;
    const area = el.querySelector('textarea');
    area.value = text;
    el.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-diag]')?.dataset.diag;
        if (act === 'close' || e.target === el) {
            el.remove();
        } else if (act === 'copy') {
            try {
                await navigator.clipboard.writeText(area.value);
                toast('success', 'Report copied.');
            } catch (_e) {
                area.focus();
                area.select();
                try { document.execCommand('copy'); toast('success', 'Report copied.'); } catch (_e2) { toast('info', 'Press and hold the text to copy it.'); }
            }
        }
    });
    document.body.appendChild(el);
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
              <div class="wd-set-inner">
                <div class="wd-set-status" id="wd_status"></div>
                <button class="wd-btn wd-btn-accent wd-set-open" id="wd_open_btn">${ICON.shirt}<span>Open wardrobe</span></button>

                <div class="wd-set-title">sillyimages library: what to send</div>
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

                <label class="checkbox_label wd-set-check">
                    <input type="checkbox" id="wd_inject" ${s.injectChat ? 'checked' : ''}>
                    <span>Tell the chat model what is worn (so it writes the outfit into the image prompt)</span>
                </label>

                <label class="checkbox_label wd-set-check">
                    <input type="checkbox" id="wd_nai_lib" ${s.novelaiLibraryText ? 'checked' : ''}>
                    <span>Direct NovelAI: also send the outfit as an extra character prompt (usually leave off)</span>
                </label>

                <div class="wd-set-title">Other image generators</div>
                <label class="checkbox_label wd-set-check">
                    <input type="checkbox" id="wd_lib" ${s.libraryAdapter !== false ? 'checked' : ''}>
                    <span>sillyimages: write the outfit into its character library</span>
                </label>
                <label class="checkbox_label wd-set-check">
                    <input type="checkbox" id="wd_sdhook" ${s.sdHook ? 'checked' : ''}>
                    <span>SillyTavern Image Generation: add the outfit to its prompt</span>
                </label>
                <label class="checkbox_label wd-set-check">
                    <input type="checkbox" id="wd_fetch" ${s.fetchHook ? 'checked' : ''}>
                    <span>Catch-all: add the outfit to image requests of any extension (advanced)</span>
                </label>
                <div class="wd-set-row">
                    <label for="wd_hooktarget">Catch-all adds</label>
                    <select class="text_pole" id="wd_hooktarget">
                        <option value="char" ${s.hookTarget === 'char' ? 'selected' : ''}>Character outfit</option>
                        <option value="user" ${s.hookTarget === 'user' ? 'selected' : ''}>Persona outfit</option>
                        <option value="both" ${s.hookTarget === 'both' ? 'selected' : ''}>Both</option>
                        <option value="all" ${s.hookTarget === 'all' ? 'selected' : ''}>Everyone in the scene (incl. NPCs)</option>
                    </select>
                </div>
                <div class="wd-set-row" style="flex-direction:column">
                    <label for="wd_hookpatterns">Catch-all URL patterns (one per line)</label>
                    <textarea class="text_pole" id="wd_hookpatterns" rows="4">${esc(s.hookPatterns)}</textarea>
                </div>
                <p class="wd-set-hint">The catch-all only touches POST requests to a matching URL and only the <code>prompt</code>, <code>input</code> and <code>base_caption</code> fields. Other extensions can read the outfit from <code>window.WardrobeAPI</code>, the <code>wardrobe_changed</code> event, <code>{{outfit_char}}</code> / <code>{{outfit_user}}</code> / <code>{{outfit_both}}</code>, or <code>/outfit-get</code>.</p>

                <div class="wd-set-title">Chat model macros</div>
                <p class="wd-set-hint">The checkbox above already does this automatically. Use <code>{{outfit_char}}</code> / <code>{{outfit_user}}</code> only if you want to place the outfit text yourself, and then turn the checkbox off to avoid sending it twice.</p>

                <div class="wd-set-title">Diagnostics</div>
                <p class="wd-set-hint">If something does not work, run this and send me the report.</p>
                <button class="wd-btn wd-btn-soft wd-set-open" id="wd_diag_btn">Run diagnostics</button>

                <div class="wd-set-row">
                    <button class="wd-btn wd-btn-soft" id="wd_export">Export</button>
                    <button class="wd-btn wd-btn-soft" id="wd_import">Import</button>
                    <input type="file" id="wd_import_file" accept="application/json,.json" hidden>
                </div>
              </div>
            </div>
        </div>`);

    const root = document.getElementById('wd_settings_root');
    const updateStatus = () => {
        const el = root.querySelector('#wd_status');
        const s = getSettings();
        const routes = [];
        if (s.injectChat) routes.push('chat model');
        if (s.sdHook) routes.push('ST Image Generation');
        if (s.libraryAdapter !== false && iigPresent()) routes.push('sillyimages');
        if (s.fetchHook) routes.push('catch-all');
        const ok = routes.length > 0;
        el.className = `wd-set-status ${ok ? 'is-ok' : 'is-bad'}`;
        el.innerHTML = ok
            ? `${ICON.check}<span>Sending outfits to: ${esc(routes.join(', '))}</span>`
            : `${ICON.close}<span>No output is switched on</span>`;
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
    root.querySelector('#wd_inject').addEventListener('change', (e) => {
        getSettings().injectChat = e.target.checked;
        updateInjection();
        save();
        updateStatus();
        if (ui.open && overlay) renderNotice();
    });
    root.querySelector('#wd_nai_lib').addEventListener('change', (e) => {
        getSettings().novelaiLibraryText = e.target.checked;
        syncAll();
    });
    root.querySelector('#wd_lib').addEventListener('change', (e) => {
        getSettings().libraryAdapter = e.target.checked;
        syncAll();
        updateStatus();
        if (ui.open && overlay) renderNotice();
    });
    root.querySelector('#wd_sdhook').addEventListener('change', (e) => {
        getSettings().sdHook = e.target.checked;
        save();
        updateStatus();
        if (ui.open && overlay) renderNotice();
    });
    root.querySelector('#wd_fetch').addEventListener('change', (e) => {
        getSettings().fetchHook = e.target.checked;
        save();
        updateStatus();
        if (ui.open && overlay) renderNotice();
    });
    root.querySelector('#wd_hooktarget').addEventListener('change', (e) => {
        getSettings().hookTarget = e.target.value;
        save();
    });
    root.querySelector('#wd_hookpatterns').addEventListener('input', (e) => {
        getSettings().hookPatterns = e.target.value;
        save();
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
    root.querySelector('#wd_diag_btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const label = btn.textContent;
        btn.textContent = 'Running…';
        try {
            showDiagnosticsReport(await runDiagnostics());
        } catch (error) {
            showDiagnosticsReport(`Diagnostics crashed:\n${error?.stack || error}\n\nRecent errors:\n${diagErrors.join('\n')}`);
        } finally {
            btn.disabled = false;
            btn.textContent = label;
        }
    });
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

// ---------------------------------------------------------------- auto outfits (lorebook-style)
// Every outfit's tags act like lorebook keys. The recent messages are scanned; a tag "fires" when one of its
// trigger words appears (built-in synonyms + your own words / /regex/). The best-scoring outfit from the
// subject's pool is worn. Nothing fires -> the current outfit stays (default), so a scene change is needed to swap.

const TAG_KEYWORDS = {
    home: 'home, house, apartment, flat, bedroom, living room, couch, sofa, kitchen, indoors, дом, дома, квартира, спальня, кухня, гостиная, диван',
    sleep: 'sleep, asleep, bed, bedtime, nap, yawn, pillow, сон, спать, постель, подушка, зевать',
    night: 'night, evening, midnight, moonlight, late, dusk, ночь, ночью, вечер, вечером, полночь, луна',
    morning: 'morning, sunrise, dawn, wake up, breakfast, утро, утром, рассвет, завтрак',
    winter: 'winter, snow, snowing, cold, frost, freezing, blizzard, icy, зима, снег, мороз, холод, метель',
    summer: 'summer, hot, heat, sunny, sunshine, sweltering, лето, жара, жарко, солнце',
    spring: 'spring, bloom, blossom, весна, цветение',
    autumn: 'autumn, fall, leaves, foliage, осень, листья, листопад',
    rain: 'rain, rainy, drizzle, storm, umbrella, soaked, дождь, ливень, гроза, зонт, промокнуть',
    beach: 'beach, sea, ocean, shore, sand, waves, seaside, coast, пляж, море, океан, песок',
    swim: 'pool, swim, swimming, lake, diving, бассейн, плавать, озеро, купаться',
    gym: 'gym, workout, exercise, training, jog, running, yoga, fitness, sport, спортзал, тренировка, бег, йога, спорт',
    work: 'work, office, meeting, desk, boss, colleague, job, shift, офис, работа, совещание, начальник, коллега',
    school: 'school, class, classroom, lecture, university, campus, teacher, student, homework, школа, урок, университет, лекция, учитель',
    formal: 'formal, gala, ball, wedding, ceremony, banquet, opera, black tie, свадьба, бал, церемония, банкет, торжество',
    party: 'party, club, nightclub, dance, dancing, bar, drinks, festival, вечеринка, клуб, танцы, бар, фестиваль',
    date: 'date, restaurant, dinner, romantic, candlelight, свидание, ресторан, ужин, романтика',
    casual: 'casual, walk, shopping, mall, cafe, coffee, park, street, прогулка, магазин, кафе, кофе, парк, улица',
    outdoors: 'outdoors, forest, hike, hiking, camping, mountain, trail, woods, field, лес, поход, горы, кемпинг, поле',
    travel: 'travel, trip, airport, flight, train, road trip, hotel, luggage, путешествие, поездка, аэропорт, поезд, отель, чемодан',
    bath: 'bath, shower, bathroom, spa, sauna, towel, ванна, душ, баня, сауна, полотенце',
    fight: 'fight, battle, combat, sword, quest, dungeon, war, armor, бой, битва, меч, подземелье, война, доспехи',
    holiday: 'christmas, xmas, new year, holiday, halloween, рождество, новый год, праздник, хэллоуин',
    cooking: 'cook, cooking, bake, baking, apron, готовить, готовка, выпечка, фартук',
};

// Tag names that map onto a built-in set.
const TAG_ALIASES = {
    fall: 'autumn', sport: 'gym', workout: 'gym', office: 'work', pajamas: 'sleep', sleepwear: 'sleep', nightwear: 'sleep',
    lounge: 'home', indoor: 'home', indoors: 'home', cozy: 'home', swimwear: 'beach+swim', swimsuit: 'beach+swim', bikini: 'beach+swim', swim: 'swim+beach', evening: 'night',
    uniform: 'school', formalwear: 'formal', cold: 'winter', warm: 'summer', rainy: 'rain', xmas: 'holiday', christmas: 'holiday',
    holidays: 'holiday', club: 'party', clubbing: 'party', hiking: 'outdoors', adventure: 'fight', battle: 'fight', combat: 'fight',
    // Russian tag names
    дом: 'home', дома: 'home', сон: 'sleep', ночь: 'night', утро: 'morning', зима: 'winter', лето: 'summer', весна: 'spring',
    осень: 'autumn', дождь: 'rain', пляж: 'beach', спорт: 'gym', работа: 'work', школа: 'school', праздник: 'holiday',
    вечеринка: 'party', свидание: 'date', путешествие: 'travel', прогулка: 'casual', бой: 'fight',
};

const matcherCache = new Map();

function autoCfg() {
    const s = getSettings();
    if (!s.auto || typeof s.auto !== 'object') s.auto = structuredClone(DEFAULTS.auto);
    const a = s.auto;
    if (typeof a.enabled !== 'boolean') a.enabled = false;
    a.scanDepth = Math.min(12, Math.max(1, Math.round(Number(a.scanDepth)) || 3));
    if (!['keep', 'default', 'off'].includes(a.fallback)) a.fallback = 'keep';
    if (!a.tagKeywords || typeof a.tagKeywords !== 'object') a.tagKeywords = {};
    if (!a.pools || typeof a.pools !== 'object') a.pools = {};
    if (!Array.isArray(a.npcs)) a.npcs = [];
    return a;
}

function splitList(text) {
    return String(text || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
}

function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "winter" matches winter / winters / etc.; Cyrillic words allow a short ending (дом -> дома, домой).
// A keyword written as /regex/flags is used as is.
function kwToRegex(kw) {
    const raw = String(kw || '').trim();
    if (!raw) return null;
    try {
        const m = raw.match(/^\/(.+)\/([a-z]*)$/i);
        if (m) return new RegExp(m[1], m[2].replace(/[gy]/g, '') || 'i');
        const body = raw.split(/\s+/).map(escapeRe).join('\\s+');
        const tail = /[\u0400-\u04FF]/.test(raw) ? '[\\p{L}]{0,3}' : '(?:s|es|ed|ing|ly|er)?';
        return new RegExp(`(?<![\\p{L}\\p{N}])${body}${tail}(?![\\p{L}\\p{N}])`, 'iu');
    } catch (_e) {
        return null;
    }
}

// An alias may point at several built-in sets joined with "+" (swimsuit -> beach+swim).
function tagKeywordList(tag) {
    const sets = String(TAG_ALIASES[tag] || tag).split('+');
    const extra = autoCfg().tagKeywords?.[tag] || '';
    return [...new Set([tag, ...sets.flatMap((name) => splitList(TAG_KEYWORDS[name])), ...splitList(extra)])];
}

function tagMatchers(tag) {
    const list = tagKeywordList(tag);
    const cacheKey = `${tag}|${list.join(',')}`;
    if (!matcherCache.has(cacheKey)) matcherCache.set(cacheKey, list.map(kwToRegex).filter(Boolean));
    return matcherCache.get(cacheKey);
}

function cleanSceneText(text) {
    return String(text || '').replace(/<[^>]*>/g, ' ').replace(/[*_`~]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Newest message first.
function sceneWindow() {
    const chat = Array.isArray(ctx().chat) ? ctx().chat : [];
    const depth = autoCfg().scanDepth;
    const out = [];
    for (let i = chat.length - 1; i >= 0 && out.length < depth; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        out.push(cleanSceneText(m.mes));
    }
    return out;
}

// A tag fires with weight 1 for the newest message, less for older ones.
function tagWeight(tag, win) {
    const matchers = tagMatchers(tag);
    let w = 0;
    win.forEach((txt, i) => {
        if (matchers.some((r) => r.test(txt))) w += Math.pow(0.7, i);
    });
    return w;
}

function pickOutfit(poolIds, win, currentId) {
    const a = autoCfg();
    const outfits = poolIds.map(getOutfit).filter(Boolean);
    const scored = outfits.map((o) => {
        const hits = (o.tags || []).filter((tag) => tagWeight(tag, win) > 0);
        const score = (o.tags || []).reduce((sum, tag) => sum + tagWeight(tag, win), 0);
        return { o, score, hits };
    });
    const best = Math.max(0, ...scored.map((x) => x.score));
    if (best > 0) {
        const top = scored.filter((x) => x.score >= best - 1e-9);
        const pick = top.find((x) => x.o.id === currentId) || top[Math.floor(Math.random() * top.length)];
        return { id: pick.o.id, hits: pick.hits, score: pick.score };
    }
    if (a.fallback === 'off') return { id: null, hits: [], score: 0 };
    if (a.fallback === 'default') {
        const def = outfits.find((o) => (o.tags || []).includes('default')) || outfits.find((o) => !(o.tags || []).length);
        if (def) return { id: def.id, hits: [], score: 0 };
    }
    return { keep: true, hits: [], score: 0 };
}

function npcPresent(npc, win) {
    const names = [npc.name, ...splitList(npc.aliases)];
    const regs = names.map(kwToRegex).filter(Boolean);
    return !!regs.length && win.some((txt) => regs.some((r) => r.test(txt)));
}

function poolRef(subject) {
    const a = autoCfg();
    if (subject === 'char' || subject === 'user') {
        const k = `${subject}:${keys[subject]}`;
        return { ok: !!keys[subject], get: () => a.pools[k] || [], set: (v) => { a.pools[k] = v; } };
    }
    const npc = a.npcs.find((n) => n.id === String(subject).replace(/^npc:/, ''));
    return { ok: !!npc, get: () => npc?.pool || [], set: (v) => { if (npc) npc.pool = v; } };
}

function hasPool(kind) {
    return poolRef(kind).get().length > 0;
}

function autoActive() {
    try {
        if (!autoCfg().enabled || !chatOpen()) return false;
        return !chatState()?.autoOff;
    } catch (_e) {
        return false;
    }
}

function presentNpcOutfits() {
    if (!autoActive()) return [];
    const st = chatState();
    const win = sceneWindow();
    const out = [];
    for (const npc of autoCfg().npcs) {
        if (!npc.name || !npcPresent(npc, win)) continue;
        const o = getOutfit(st?.npcs?.[npc.id]);
        const prompt = o ? String(o.prompt || o.name || '').trim() : '';
        if (prompt) out.push({ id: npc.id, name: npc.name, outfit: o.name || '', prompt });
    }
    return out;
}

function autoEvaluate() {
    if (!autoActive()) return false;
    const a = autoCfg();
    const win = sceneWindow();
    const st = chatState(true);
    if (!st) return false;
    let changed = false;
    for (const kind of ['char', 'user']) {
        if (!keys[kind] || st.pins?.[kind]) continue;
        const pool = poolRef(kind).get();
        if (!pool.length) continue;
        const pick = pickOutfit(pool, win, wornId(kind));
        if (pick.keep || (pick.id || null) === wornId(kind)) continue;
        if (pick.id) wear(kind, pick.id, { auto: true });
        else unwear(kind, { auto: true });
        changed = true;
    }
    for (const npc of a.npcs) {
        if (!npc.name || !npc.pool?.length || !npcPresent(npc, win)) continue;
        st.npcs = st.npcs && typeof st.npcs === 'object' ? st.npcs : {};
        const current = getOutfit(st.npcs[npc.id])?.id || null;
        const pick = pickOutfit(npc.pool, win, current);
        if (pick.keep || (pick.id || null) === current) continue;
        if (pick.id) st.npcs[npc.id] = pick.id;
        else delete st.npcs[npc.id];
        changed = true;
    }
    if (changed) saveChat();
    updateInjection();
    return changed;
}

// Human-readable "what would be picked right now", for the Auto sheet and the diagnostics.
function autoPreview() {
    const a = autoCfg();
    const win = sceneWindow();
    const st = chatState();
    const lines = [`Scanning ${win.length} message(s). Fallback: ${a.fallback}.`];
    const describe = (label, pool, currentId) => {
        if (!pool.length) { lines.push(`${label}: no pool selected.`); return; }
        const pick = pickOutfit(pool, win, currentId);
        const name = pick.keep ? `(keeps ${getOutfit(currentId)?.name || 'nothing'})` : (getOutfit(pick.id)?.name || 'nothing');
        lines.push(`${label}: ${name}${pick.hits?.length ? ` [${pick.hits.map((h) => `#${h}`).join(' ')}]` : ''}`);
    };
    for (const kind of ['char', 'user']) {
        const tag = st?.pins?.[kind] ? ' (pinned by hand)' : '';
        describe(`${displayName(kind)}${tag}`, poolRef(kind).get(), wornId(kind));
    }
    for (const npc of a.npcs) {
        if (!npcPresent(npc, win)) { lines.push(`${npc.name || 'NPC'}: not mentioned in the scanned messages.`); continue; }
        describe(npc.name, npc.pool || [], st?.npcs?.[npc.id]);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------- universal outputs
// Wardrobe does not depend on one image extension. The worn outfit (per chat) is offered through:
//  1. chat-model injection  (any extension whose prompt is written by the chat model)
//  2. SillyTavern's built-in Image Generation (sd_prompt_processing event)
//  3. sillyimages library adapter (see syncKey)
//  4. catch-all request hook (opt-in): adds the outfit to outgoing image requests of any extension
//  5. public API: window.WardrobeAPI, the 'wardrobe_changed' event, macros and slash commands

function outfitText(target) {
    const parts = [];
    if (target === 'char' || target === 'both' || target === 'all') parts.push(promptFor('char'));
    if (target === 'user' || target === 'both' || target === 'all') parts.push(promptFor('user'));
    if (target === 'all') for (const n of presentNpcOutfits()) parts.push(n.prompt);
    return parts.filter(Boolean).join(', ');
}

function addTo(text, add) {
    const base = String(text || '');
    if (!add || base.includes(add)) return base;
    const trimmed = base.replace(/[,\s]+$/, '');
    return trimmed ? `${trimmed}, ${add}` : add;
}

// ST built-in Image Generation: generationType numbers follow its generationMode enum
// (0 char, 1 user, 2 scenario, 3 raw last, 4 now, 5 face, 6 free, 7 background, 8/9/10 multimodal).
function onSdPrompt(data) {
    try {
        if (!getSettings().sdHook || !data || typeof data.prompt !== 'string') return;
        const mode = data.generationType;
        if ([5, 6, 7, 10].includes(mode)) return;
        const target = ({ 0: 'char', 8: 'char', 1: 'user', 9: 'user' })[mode] || 'both';
        const add = outfitText(target);
        if (add) data.prompt = addTo(data.prompt, add);
    } catch (e) { recordError('sdHook', e?.message || String(e)); }
}

const HOOK_FIELDS = new Set(['prompt', 'input', 'base_caption']);

function patchBody(node, add) {
    let changed = false;
    if (Array.isArray(node)) {
        for (const item of node) if (patchBody(item, add)) changed = true;
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (HOOK_FIELDS.has(k) && typeof v === 'string') {
                const next = addTo(v, add);
                if (next !== v) { node[k] = next; changed = true; }
            } else if (v && typeof v === 'object' && patchBody(v, add)) {
                changed = true;
            }
        }
    }
    return changed;
}

function installFetchHook() {
    if (window.__wdFetchHooked || typeof window.fetch !== 'function') return;
    window.__wdFetchHooked = true;
    const original = window.fetch;
    window.fetch = function wardrobeFetch(input, init) {
        try {
            const s = getSettings();
            if (s.fetchHook && init && typeof init.body === 'string'
                && String(init.method || 'GET').toUpperCase() === 'POST'
                && init.body.trimStart().startsWith('{')) {
                const url = typeof input === 'string' ? input : String(input?.url || input || '');
                const patterns = String(s.hookPatterns || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
                if (patterns.some((pattern) => url.includes(pattern))) {
                    const add = outfitText(s.hookTarget);
                    if (add) {
                        const json = JSON.parse(init.body);
                        if (patchBody(json, add)) init = { ...init, body: JSON.stringify(json) };
                    }
                }
            }
        } catch (e) { recordError('fetchHook', e?.message || String(e)); }
        return original.call(window, input, init);
    };
}

// Public API for other extensions.
const changeListeners = new Set();

function describeWorn(kind) {
    const o = getOutfit(wornId(kind));
    return o ? { id: o.id, name: o.name || '', prompt: o.prompt || '', image: o.image || '' } : null;
}

function snapshot() {
    return {
        chatOpen: chatOpen(),
        char: describeWorn('char'),
        user: describeWorn('user'),
        npcs: presentNpcOutfits(), // NPCs detected in the recent messages: [{ id, name, outfit, prompt }]
        text: { char: outfitText('char'), user: outfitText('user'), both: outfitText('both'), all: outfitText('all') },
    };
}

function notifyChange() {
    const snap = snapshot();
    for (const fn of changeListeners) {
        try { fn(snap); } catch (_e) { /* listener errors must not break Wardrobe */ }
    }
    try { ctx().eventSource.emit('wardrobe_changed', snap); } catch (_e) { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent('wardrobe:changed', { detail: snap })); } catch (_e) { /* ignore */ }
}

function exposeApi() {
    window.WardrobeAPI = Object.freeze({
        version: '1.3.0',
        getAll: snapshot,
        getWorn: describeWorn, // 'char' | 'user' -> { id, name, prompt, image } | null
        getPrompt: (kind = 'char') => outfitText(kind === 'user' || kind === 'both' ? kind : 'char'),
        onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
    });
}

function addCommand(name, callback, help) {
    const c = ctx();
    try {
        if (c.SlashCommandParser && c.SlashCommand) {
            const args = c.SlashCommandArgument?.fromProps
                ? [c.SlashCommandArgument.fromProps({ description: 'char | user | both [outfit name]', typeList: [c.ARGUMENT_TYPE?.STRING], isRequired: false })]
                : [];
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name, callback: async (_named, value) => callback(String(value || '')), helpString: help, unnamedArgumentList: args, returns: 'string',
            }));
        } else if (typeof c.registerSlashCommand === 'function') {
            c.registerSlashCommand(name, (_named, value) => callback(String(value || '')), [], help, true, true);
        }
    } catch (e) { console.warn(`[Wardrobe] Could not register /${name}:`, e); }
}

function registerCommands() {
    addCommand('outfit-get', (v) => {
        const k = v.trim().toLowerCase();
        return outfitText(k === 'user' || k === 'both' ? k : 'char');
    }, 'Wardrobe: returns the outfit prompt worn in this chat (char, user or both).');
    addCommand('outfit-wear', (v) => {
        const [kind, ...rest] = v.trim().split(/\s+/);
        const name = rest.join(' ').toLowerCase();
        if (!['char', 'user'].includes(kind) || !name) return '';
        const outfit = getSettings().outfits.find((o) => String(o.name || '').toLowerCase() === name);
        if (!outfit || !wear(kind, outfit.id)) return '';
        if (ui.open) renderPanel();
        return outfit.name;
    }, 'Wardrobe: /outfit-wear char|user <outfit name> puts an outfit on in this chat.');
    addCommand('outfit-auto', (v) => {
        const arg = v.trim().toLowerCase();
        const st = chatState(true);
        if (st && (arg === 'on' || arg === 'off')) { st.autoOff = arg === 'off'; saveChat(); updateInjection(); }
        if (arg === 'now') autoEvaluate();
        else if (arg === 'preview') return autoPreview();
        if (ui.open && overlay) renderRail();
        return autoActive() ? 'auto on' : 'auto off';
    }, 'Wardrobe: /outfit-auto on|off|now|preview controls auto outfits in this chat (Auto mode must also be switched on in the panel).');
    addCommand('outfit-off', (v) => {
        const kind = v.trim().toLowerCase();
        for (const k of ['char', 'user']) if (!kind || kind === 'both' || kind === k) unwear(k);
        if (ui.open) renderPanel();
        return '';
    }, 'Wardrobe: /outfit-off [char|user] takes the outfit off in this chat.');
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
        c.registerMacro('outfit_both', () => outfitText('both'), 'Wardrobe: outfit prompts worn by the character and the user persona.');
        c.registerMacro('outfit_user', () => promptFor('user'), 'Wardrobe: outfit prompt currently worn by the user persona.');
    } catch (error) {
        console.warn('[Wardrobe] Could not register macros:', error);
    }
}

async function onContextChanged() {
    await refreshKeys();
    syncAll();
    autoEvaluate();
    if (ui.open) renderPanel();
}

(function init() {
    getSettings();
    const c = ctx();
    registerMacros();
    exposeApi();
    installFetchHook();
    c.eventSource.on(c.event_types?.SD_PROMPT_PROCESSING || 'sd_prompt_processing', onSdPrompt);
    c.eventSource.on(c.event_types.APP_READY, async () => {
        registerCommands();
        buildSettingsDrawer();
        addMenuEntry();
        await refreshKeys();
        syncAll();
        console.log('[Wardrobe] loaded');
    });
    for (const name of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_EDITED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
        const eventName = c.event_types?.[name];
        if (eventName) c.eventSource.on(eventName, () => { autoEvaluate(); if (ui.open && overlay) renderRail(); });
    }
    // Read the scene right before the chat model is prompted, so the outfit note is current.
    c.eventSource.on(c.event_types?.GENERATION_STARTED || 'generation_started', (_type, _params, dryRun) => {
        if (!dryRun) autoEvaluate();
    });
    for (const name of ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'USER_AVATAR_CHANGED', 'PERSONA_CHANGED']) {
        const eventName = c.event_types?.[name];
        if (eventName) c.eventSource.on(eventName, () => { onContextChanged(); });
    }
})();
