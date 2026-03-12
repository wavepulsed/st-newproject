// Img2Img Reference Generator for SillyTavern
// Version 0.4.1 — Editable Model ID field

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { registerSlashCommand } from "../../../slash-commands.js";

const extensionName = "st-img2img";
const NANO_API_URL = "https://nano-gpt.com/api/v1/images/generations";
const DB_NAME = "img2img_gallery_db";
const DB_VERSION = 2;
const STORE_NAME = "galleries";

// ── IndexedDB ─────────────────────────────────────────────────────────────────

let db = null;

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: "characterName" });
            }
            if (!database.objectStoreNames.contains("image_history")) {
                const historyStore = database.createObjectStore("image_history", {
                    keyPath: "id",
                    autoIncrement: true,
                });
                historyStore.createIndex("characterName", "characterName", { unique: false });
            }
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = (e) => reject(e.target.error);
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
    model: "seedream-v4.5",
    image_size: "1024x1024",
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

// ── Image persistence ─────────────────────────────────────────────────────────

async function fetchImageAsBase64(url) {
    console.log("[Img2Img] Fetching image for local persistence...");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(blob);
    });
}

async function saveToImageHistory(base64, prompt, characterName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("image_history", "readwrite");
        const store = tx.objectStore("image_history");
        const record = {
            base64,
            prompt,
            characterName: characterName || "Unknown",
            timestamp: Date.now(),
        };
        const request = store.add(record);
        request.onsuccess = (e) => {
            console.log("[Img2Img] Image saved to local history. ID:", e.target.result);
            resolve(e.target.result);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

// ── API call ──────────────────────────────────────────────────────────────────

async function generateImage(prompt) {
    const settings = getSettings();

    if (!settings.api_key) {
        throw new Error("No API key set. Please add your NanoGPT key in the extension settings.");
    }

    const charName = getCurrentCharacterName();
    const referenceImages = charName ? await loadGalleryFromDB(charName) : [];

    console.log(`[Img2Img] Generating image for prompt: "${prompt}"`);
    console.log(`[Img2Img] Using ${referenceImages.length} reference image(s)`);
    console.log(`[Img2Img] Model: ${settings.model}`);

    const payload = {
        model: settings.model,
        prompt: prompt,
        n: 1,
        size: settings.image_size,
        response_format: "url",
    };

    if (referenceImages.length === 1) {
        payload.imageDataUrl = referenceImages[0];
    } else if (referenceImages.length > 1) {
        payload.imageDataUrls = referenceImages;
    }

    const response = await fetch(NANO_API_URL, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${settings.api_key}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`NanoGPT API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    console.log("[Img2Img] API response received:", data);

    const imageUrl = data?.data?.[0]?.url;
    if (!imageUrl) {
        throw new Error("API returned no image URL. Full response: " + JSON.stringify(data));
    }

    return imageUrl;
}

// ── Chat injection ────────────────────────────────────────────────────────────

function injectImageIntoChat(imageUrl, prompt) {
    const messageHtml = `<img src="${imageUrl}" alt="${prompt}" style="max-width:100%; border-radius:8px; cursor:pointer;" onclick="window.open('${imageUrl}', '_blank')" title="Click to open full size" /><div class="img2img_prompt_label">🖼️ ${prompt}</div>`;

    // Append directly into the chat as a system message div
    const $msg = $(`
        <div class="mes system_mes img2img_result_msg">
            <div class="mes_block">
                <div class="mes_text">${messageHtml}</div>
            </div>
        </div>
    `);
    $("#chat").append($msg);
    $("#chat").scrollTop($("#chat")[0].scrollHeight);
}

// ── Loading indicator ─────────────────────────────────────────────────────────

function showLoadingMessage() {
    const $loading = $(`
        <div id="img2img_loading" class="img2img_loading_msg">
            ⏳ Generating image, please wait...
        </div>
    `);
    $("#chat").append($loading);
    $("#chat").scrollTop($("#chat")[0].scrollHeight);
}

function hideLoadingMessage() {
    $("#img2img_loading").remove();
}

// ── Main trigger ──────────────────────────────────────────────────────────────

async function handleGenerateCommand(namedArgs, unnamedValue) {
    const prompt = unnamedValue || namedArgs?.value || "";

    if (!prompt.trim()) {
        toastr.warning("Please provide a prompt. Usage: /img2img a girl in a forest");
        return;
    }

    showLoadingMessage();

    try {
        // Step 1 — generate via API
        const remoteUrl = await generateImage(prompt.trim());

        // Step 2 — immediately fetch and persist locally
        const base64 = await fetchImageAsBase64(remoteUrl);
        const charName = getCurrentCharacterName();
        await saveToImageHistory(base64, prompt.trim(), charName);

        // Step 3 — inject into chat using local data, not the expiring URL
        hideLoadingMessage();
        injectImageIntoChat(base64, prompt.trim());

        toastr.success(`Image generated and saved locally.`);
    } catch (err) {
        hideLoadingMessage();
        console.error("[Img2Img] Generation failed:", err);
        toastr.error(`Image generation failed: ${err.message}`);
    }
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
    if (!charName) {
        alert("Please open a character chat before uploading reference images.");
        return;
    }

    const current = await loadGalleryFromDB(charName);

    const readFile = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(file);
    });

    for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
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

            <label style="margin-top:8px;">Model ID</label>
            <input type="text"
                   id="img2img_model"
                   class="text_pole"
                   placeholder="e.g. seedream-v4.5"
                   value="${settings.model}" />
            <small>Check your provider's model list for the exact ID string.</small>

            <label style="margin-top:8px;">Image Size</label>
            <select id="img2img_size" class="text_pole">
                <option value="1024x1024" ${settings.image_size === "1024x1024" ? "selected" : ""}>1024×1024 (Square)</option>
                <option value="1024x768"  ${settings.image_size === "1024x768"  ? "selected" : ""}>1024×768 (Landscape)</option>
                <option value="768x1024"  ${settings.image_size === "768x1024"  ? "selected" : ""}>768×1024 (Portrait)</option>
            </select>

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

            <hr />
            <small>💡 Use <code>/img2img your prompt here</code> in chat to generate.</small>
        </div>
    `;
    $("#extensions_settings").append(html);

    $("#img2img_api_key").on("input", function () {
        getSettings().api_key = $(this).val();
        saveSettingsDebounced();
    });

    $("#img2img_model").on("input", function () {
        getSettings().model = $(this).val();
        saveSettingsDebounced();
    });

    $("#img2img_size").on("change", function () {
        getSettings().image_size = $(this).val();
        saveSettingsDebounced();
    });

    $("#img2img_upload_input").on("change", function () {
        const files = Array.from(this.files);
        this.value = "";
        handleImageUpload(files);
    });

    renderGallery();
}

// ── Events ────────────────────────────────────────────────────────────────────

function registerEvents() {
    eventSource.on(event_types.CHAT_CHANGED, () => renderGallery());
}

// ── Entry point ───────────────────────────────────────────────────────────────

jQuery(async () => {
    await openDatabase();
    loadSettings();
    renderSettingsPanel();
    registerEvents();

    registerSlashCommand(
        "img2img",
        handleGenerateCommand,
        [],
        "Generate an image using your character's reference gallery. Usage: /img2img a girl standing in a forest",
        true,
        true
    );

    console.log("[Img2Img] Extension ready. Use /img2img [prompt] to generate.");
});
