// Img2Img Reference Generator for SillyTavern
// Version 0.2.0 — Gallery System

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const extensionName = "st-img2img";
const defaultSettings = {
    api_key: "",
    model: "seedream-4-5",
    galleries: {}, // { "CharacterName": [ "data:image/png;base64,..." ] }
};

// ── Settings helpers ──────────────────────────────────────────────────────────

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    extension_settings[extensionName] = {
        ...defaultSettings,
        ...extension_settings[extensionName],
    };
    // Make sure galleries key always exists
    extension_settings[extensionName].galleries =
        extension_settings[extensionName].galleries || {};
}

function getSettings() {
    return extension_settings[extensionName];
}

// ── Character helpers ─────────────────────────────────────────────────────────

function getCurrentCharacterName() {
    const context = getContext();
    return context?.name2 || null;
}

function getGalleryForCharacter(name) {
    return getSettings().galleries[name] || [];
}

function saveGalleryForCharacter(name, images) {
    getSettings().galleries[name] = images;
    saveSettingsDebounced();
}

// ── Gallery UI ────────────────────────────────────────────────────────────────

function renderGallery() {
    const charName = getCurrentCharacterName();
    const $gallery = $("#img2img_gallery");
    const $label = $("#img2img_gallery_label");

    $gallery.empty();

    if (!charName) {
        $label.text("No character selected — open a chat first.");
        return;
    }

    $label.text(`Reference images for: ${charName}`);
    const images = getGalleryForCharacter(charName);

    if (images.length === 0) {
        $gallery.append(`<p class="img2img_empty">No reference images yet. Upload some below!</p>`);
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

    // Delete button handler
    $(".img2img_delete_btn").on("click", function () {
        const index = parseInt($(this).data("index"));
        const updated = getGalleryForCharacter(charName);
        updated.splice(index, 1);
        saveGalleryForCharacter(charName, updated);
        renderGallery();
    });
}

// ── File upload ───────────────────────────────────────────────────────────────

function handleImageUpload(files) {
    const charName = getCurrentCharacterName();
    if (!charName) {
        alert("Please open a character chat before uploading reference images.");
        return;
    }

    const current = getGalleryForCharacter(charName);
    let loaded = 0;

    Array.from(files).forEach((file) => {
        if (!file.type.startsWith("image/")) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            current.push(e.target.result);
            loaded++;
            if (loaded === files.length) {
                saveGalleryForCharacter(charName, current);
                renderGallery();
            }
        };
        reader.readAsDataURL(file);
    });
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

    // API key save
    $("#img2img_api_key").on("input", function () {
        getSettings().api_key = $(this).val();
        saveSettingsDebounced();
    });

    // File picker
    $("#img2img_upload_input").on("change", function () {
        handleImageUpload(this.files);
        this.value = ""; // reset so same file can be re-added
    });

    renderGallery();
}

// ── Event listeners ───────────────────────────────────────────────────────────

// Re-render gallery whenever the user switches character/chat
function registerEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderGallery();
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────

jQuery(async () => {
    loadSettings();
    renderSettingsPanel();
    registerEvents();
    console.log("[Img2Img] Extension loaded — gallery system active.");
});
