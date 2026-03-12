// Img2Img Reference Generator for SillyTavern
// Version 0.6.0 — Proper persistence via chatMetadata + IndexedDB

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { registerSlashCommand } from "../../../slash-commands.js";

const extensionName = "st-img2img";
const NANO_API_URL = "https://nano-gpt.com/api/v1/images/generations";
const DB_NAME = "img2img_gallery_db";
const DB_VERSION = 3;
const STORE_NAME = "galleries";
const HISTORY_STORE = "image_history";

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
            if (!database.objectStoreNames.contains(HISTORY_STORE)) {
                const store = database.createObjectStore(HISTORY_STORE, {
                    keyPath: "id",
                    autoIncrement: true,
                });
                store.createIndex("characterName", "characterName", { unique: false });
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

function saveImageToDB(base64, prompt, characterName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE, "readwrite");
        const store = tx.objectStore(HISTORY_STORE);
        const request = store.add({
            base64,
            prompt,
            characterName: characterName || "Unknown",
            timestamp: Date.now(),
        });
        request.onsuccess = (e) => resolve(e.target.result); // returns the auto-increment ID
        request.onerror = (e) => reject(e.target.error);
    });
}

function loadImageFromDB(id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(HISTORY_STORE, "readonly");
        const store = tx.objectStore(HISTORY_STORE);
        const request = store.get(id);
        request.onsuccess = (e) => resolve(e.target.result || null);
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

// ── Image fetch + persist ─────────────────────────────────────────────────────

async function fetchAndStoreImage(remoteUrl, prompt, characterName) {
    console.log("[Img2Img] Fetching image for local persistence...");
    const response = await fetch(remoteUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
    const blob = await response.blob();

    const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });

    const id = await saveImageToDB(base64, prompt, characterName);
    console.log("[Img2Img] Image stored in IndexedDB with ID:", id);
    return { base64, id };
}

// ── Chat injection ────────────────────────────────────────────────────────────

function injectImageIntoChat(base64, prompt, imageId) {
    // Build the message with a data attribute storing the IndexedDB ID
    // so we can restore it after page refresh
    const $msg = $(`
        <div class="mes system_mes img2img_result_msg" data-img2img-id="${imageId}">
            <div class="mes_block">
                <div class="mes_text">
                    <img src="${base64}"
                         alt="${prompt}"
                         class="img2img_generated"
                         style="max-width:100%; border-radius:8px; cursor:pointer;"
                         title="Click to open full size" />
                    <div class="img2img_prompt_label">🖼️ ${prompt}</div>
                </div>
            </div>
        </div>
    `);

    // Full-size viewer via Blob URL (works in Chrome PWA, no blank tab)
    $msg.find("img").on("click", function () {
        const src = this.src;
        // Convert base64 to blob and open as object URL
        fetch(src)
            .then(r => r.blob())
            .then(blob => {
                const url = URL.createObjectURL(blob);
                window.open(url, "_blank");
            });
    });

    $("#chat").append($msg);
    $("#chat").scrollTop($("#chat")[0].scrollHeight);

    // Save the image ID into chatMetadata so we can restore after refresh
    persistImageIdToChat(imageId, prompt);
}

function persistImageIdToChat(imageId, prompt) {
    try {
        const context = getContext();
        if (!context?.chatMetadata) return;
        if (!context.chatMetadata.img2img_images) {
            context.chatMetadata.img2img_images = [];
        }
        context.chatMetadata.img2img_images.push({ imageId, prompt, timestamp: Date.now() });
        context.saveMetadata();
        console.log("[Img2Img] Image ID saved to chatMetadata:", imageId);
    } catch (err) {
        console.warn("[Img2Img] Could not save to chatMetadata:", err);
    }
}

// ── Chat restore on load ──────────────────────────────────────────────────────

async function restoreImagesInChat() {
    try {
        const context = getContext();
        const stored = context?.chatMetadata?.img2img_images;
        if (!stored || stored.length === 0) return;

        console.log(`[Img2Img] Restoring ${stored.length} image(s) from chatMetadata...`);

        // Remove any existing restored messages to avoid duplicates
        $(".img2img_result_msg").remove();

        for (const entry of stored) {
            const record = await loadImageFromDB(entry.imageId);
            if (!record) {
                console.warn("[Img2Img] Image ID not found in IndexedDB:", entry.imageId);
                continue;
            }

            const $msg = $(`
                <div class="mes system_mes img2img_result_msg" data-img2img-id="${entry.imageId}">
                    <div class="mes_block">
                        <div class="mes_text">
                            <img src="${record.base64}"
                                 alt="${entry.prompt}"
                                 class="img2img_generated"
                                 style="max-width:100%; border-radius:8px; cursor:pointer;"
                                 title="Click to open full size" />
                            <div class="img2img_prompt_label">🖼️ ${entry.prompt}</div>
                        </div>
                    </div>
                </div>
            `);

            $msg.find("img").on("click", function () {
                fetch(this.src)
                    .then(r => r.blob())
                    .then(blob => window.open(URL.createObjectURL(blob), "_blank"));
            });

            $("#chat").append($msg);
        }

        $("#chat").scrollTop($("#chat")[0].scrollHeight);
        console.log("[Img2Img] Restore complete.");
    } catch (err) {
        console.warn("[Img2Img] Restore failed:", err);
    }
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

// ── API call ──────────────────────────────────────────────────────────────────

async function generateImage(prompt) {
    const settings = getSettings();

    if (!settings.api_key) {
        throw new Error("No API key set. Please add your NanoGPT key in the extension settings.");
    }

    const charName = getCurrentCharacterName();
    const referenceImages = charName ? await loadGalleryFromDB(charName) : [];

    console.log(`[Img2Img] Generating — prompt: "${prompt}", model: ${settings.model}, refs: ${referenceImages.length}`);

    const payload = {
        model: settings.model,
        prompt,
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
        const err = await response.text();
        throw new Error(`NanoGPT API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    console.log("[Img2Img] API response:", data);

    const imageUrl = data?.data?.[0]?.url;
    if (!imageUrl) throw new Error("No image URL in response: " + JSON.stringify(data));

    return imageUrl;
}

// ── Main command handler ──────────────────────────────────────────────────────

async function handleGenerateCommand(namedArgs, unnamedValue) {
    const prompt = unnamedValue || namedArgs?.value || "";

    if (!prompt.trim()) {
        toastr.warning("Please provide a prompt. Usage: /img2img a girl in a forest");
        return;
    }

    showLoadingMessage();

    try {
        const charName = getCurrentCharacterName();

        // 1. Generate via API
        const remoteUrl = await generateImage(prompt.trim());

        // 2. Fetch and store locally in IndexedDB
        const { base64, id } = await fetchAndStoreImage(remoteUrl, prompt.trim(), charName);

        // 3. Inject into chat using local base64
        hideLoadingMessage();
        injectImageIntoChat(base64, prompt.trim(), id);

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
        reader.onerror = reject;
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
            <small>ℹ️ Seedream 4.5 supports up to 10 reference images. Check your model's documentation for its specific limit.</small>
            <br/>
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
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderGallery();
        // Small delay to let ST finish rendering the chat before we restore
        setTimeout(restoreImagesInChat, 500);
    });
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

    // Restore any images from the current chat on initial load
    setTimeout(restoreImagesInChat, 1000);

    console.log("[Img2Img] Extension ready. Use /img2img [prompt] to generate.");
});
