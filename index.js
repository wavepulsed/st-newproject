// Img2Img Reference Generator for SillyTavern
// Version 0.3.0 — IndexedDB Gallery Storage

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "st-img2img";
const DB_NAME = "img2img_gallery_db";
const DB_VERSION = 1;
const STORE_NAME = "galleries";

// ── IndexedDB setup ───────────────────────────────────────────────────────────

let db = null;

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: "characterName" });
            }
        };

        request.onsuccess = (e) => {
            db = e.target.result;
            console.log("[Img2Img] IndexedDB opened successfully.");
            resolve(db);
        };

        request.onerror = (e) => {
            console.error("[Img2Img] IndexedDB error:", e.target.error);
            reject(e.target.error);
        };
    });
}

function saveGalleryToDB(characterName, images) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.put({ characterName, images });
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function loadGalleryFromDB(characterName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(characterName);
        request.onsuccess = (e) => resolve(e.target.result?.images || []);
        request.onerror = (e) => reject(e.target.error);
    });
}

// ── Settings ──────────────────────────────────────────────────────────────────

const defaultSettings = {
    api_key: "",
    model: "seedream-4-5",
};

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    extension_settings[extensionName] = {
        ...defaultSettings,
        ...extension_settings[extensionName],
    };
}

function getSettings() {
    return extension_settings[extensionName];
}

// ── Character helpers ─────────────────────────────────────────────────────────

function getCurrentCharacterName() {
    const context = getContext();
    return context?.name2 || null;
}

// ── Gallery UI ────────────────────────────────────────────────────────────────

async function renderGallery() {
    const charName = getCurrentCharacterName();
    const $gallery = $("#img2img_gallery");
    const $label = $("#img2img_gallery_label");

    $gallery.empty();

    if (!charName) {
        $label.text("No character selected — open a chat first.");
        return;
    }

    $label.text(`Reference images for: ${charName}`);

    const images = await loadGalleryFromDB(charName);
    console.log(`[Img2Img] Rendering gallery for "${charName}" — ${images.length} image(s)`);

    if (images.length === 0) {
        $gallery.append(`<p class="img2img_empty">No reference images yet. Upload some below!</p>`);
        return;
    }

    images.forEach((dataUrl, index) => {
        const $thumb = $(`
            <div class="img2img_thumb">
                <img src="${dataUrl}" title="Reference image ${index + 1}" />
                <button class="img2img_delete_btn" data-index="${index}" title="Remove">✕</button>
            </div>
        `);
        $gallery.append($thumb);
    });

    $(".img2img_delete_btn").on("click", async function () {
        const index = parseInt($(this).data("index"));
        const images = await loadGalleryFromDB(charName);
        images.splice(index, 1);
        await saveGalleryToDB(charName, images);
        renderGallery();
    });
}

// ── File upload ───────────────────────────────────────────────────────────────

async function handleImageUpload(files) {
    const charName = getCurrentCharacterName();
    console.log("[Img2Img] Upload triggered. Character:", charName);

    if (!charName) {
        alert("Please open a character chat before uploading reference images.");
        return;
    }

    const current = await loadGalleryFromDB(charName);
    console.log("[Img2Img] Existing images in gallery:", current.length);

    const readFile = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(file);
    });

    for (const file of files) {
        if (!file.type.startsWith("image/")) {
            console.log("[Img2Img] Skipped non-image:", file.name);
            continue;
        }
        const dataUrl = await readFile(file);
        current.push(dataUrl);
        console.log("[Img2Img] Added:", file.name);
    }

    await saveGalleryToDB(charName, current);
    console.log("[Img2Img] Gallery saved. Total images:", current.length);
    renderGallery();
}

// ── Settings panel ────────────────────────────────────────────────────────────

function renderSettingsPanel() {
    const settings = getSettings();
    const html = `
        <div id="img2img_settings">
            <h4>🖼️ Img2Img Reference Generator</h4>

            <label>NanoGPT API Key</label>
            <input type="password"
                   id="img2img_api_key"
                   class="text_pole"
                   placeholder="Paste your NanoGPT API key here"
                   value="${settings.api_key}" />
            <small>Your key is stored locally and never shared.</small>

            <hr />

            <div id="img2img_gallery_label" class="img2img_section_label">
                Open a chat to manage reference images.
            </div>
            <div id="img2img_gallery"></div>

            <label class="img2img_upload_btn" for="img2img_upload_input">
                ＋ Upload Reference Images
                <input type="file"
                       id="img2img_upload_input"
                       accept="image/*"
                       multiple
                       style="display:none;" />
            </label>
        </div>
    `;
    $("#extensions_settings").append(html);

    $("#img2img_api_key").on("input", function () {
        getSettings().api_key = $(this).val();
        saveSettingsDebounced();
    });

    $("#img2img_upload_input").on("change", function () {
    const files = Array.from(this.files); // copy immediately before anything else
    this.value = "";
    handleImageUpload(files);
});

    renderGallery();
}

// ── Events ────────────────────────────────────────────────────────────────────

function registerEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderGallery();
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────

jQuery(async () => {
    await openDatabase();
    loadSettings();
    renderSettingsPanel();
    registerEvents();
    console.log("[Img2Img] Extension ready.");
});
