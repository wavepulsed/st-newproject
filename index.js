// Img2Img Reference Generator for SillyTavern
// Version 0.9.1 — Dynamic size dropdown, custom size support

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChatDebounced, addOneMessage } from "../../../../script.js";
import { registerSlashCommand } from "../../../slash-commands.js";
import { saveBase64AsFile } from "../../../../scripts/utils.js";

const extensionName = "st-img2img";
const NANO_API_URL = "https://nano-gpt.com/api/v1/images/generations";
const DB_NAME = "img2img_gallery_db";
const DB_VERSION = 3;
const STORE_NAME = "galleries";

// ── Size map per model ────────────────────────────────────────────────────────
// Add entries here as new models are supported.
// Falls back to DEFAULT_SIZES for any model not listed.

const MODEL_SIZES = {
    "seedream-v4.5": [
        { value: "1920x1920", label: "1092x1092 — Min Square" },
        { value: "2048x2048", label: "2048×2048 — Default Square (2K)" },
        { value: "2496x1664", label: "2496×1664 — Min Landscape (3:2)" },
        { value: "1664x2496", label: "1664×2496 — Min Portrait (2:3)" },
        { value: "3072x2048", label: "3072×2048 — Hi-res Landscape (3:2)" },
        { value: "2048x3072", label: "2048×3072 — Hi-res Portrait (2:3)" },
        { value: "4096x2304", label: "4096×2304 — Max Landscape (16:9)" },
        { value: "2304x4096", label: "2304×4096 — Max Portrait (9:16)" },
        { value: "4096x4096", label: "4096×4096 — Max Square (4K)" },
        { value: "custom",    label: "Custom…" },
    ],
};

const DEFAULT_SIZES = [
    { value: "1024x1024", label: "1024×1024" },
    { value: "custom",    label: "Custom…" },
];

// ── IndexedDB (reference image gallery only) ──────────────────────────────────

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
    image_size: "2048x2048",
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

// ── Size dropdown ─────────────────────────────────────────────────────────────

function updateSizeDropdown(modelId) {
    const sizes = MODEL_SIZES[modelId] || DEFAULT_SIZES;
    const $sizeSelect = $("#img2img_size");
    const currentSize = getSettings().image_size;

    $sizeSelect.empty();
    sizes.forEach(s => {
        const selected = s.value === currentSize ? "selected" : "";
        $sizeSelect.append(`<option value="${s.value}" ${selected}>${s.label}</option>`);
    });

    // If saved size isn't valid for this model, reset to first non-custom option
    const validMatch = sizes.find(s => s.value === currentSize);
    if (!validMatch) {
        const firstReal = sizes.find(s => s.value !== "custom") || sizes[0];
        getSettings().image_size = firstReal.value;
        saveSettingsDebounced();
        $sizeSelect.val(firstReal.value);
    }

    toggleCustomSizeInputs($sizeSelect.val() === "custom");
}

function toggleCustomSizeInputs(show) {
    $("#img2img_custom_size").toggle(show);
}

function validateAndSaveCustomSize() {
    const w = parseInt($("#img2img_custom_w").val());
    const h = parseInt($("#img2img_custom_h").val());

    if (!w || !h) return;

    // Seedream on NanoGPT: each dimension must be 1024–4096px
    if (w < 1024 || w > 4096) {
        toastr.warning(`Width must be between 1024 and 4096 pixels (got ${w}).`);
        return;
    }
    if (h < 1024 || h > 4096) {
        toastr.warning(`Height must be between 1024 and 4096 pixels (got ${h}).`);
        return;
    }

    getSettings().image_size = `${w}x${h}`;
    saveSettingsDebounced();
    toastr.success(`Custom size set: ${w}×${h}`);
}

// ── Image fetch + save to ST filesystem ──────────────────────────────────────

async function fetchAndSaveImage(remoteUrl, characterName) {
    console.log("[Img2Img] Fetching image from CDN...");

    const response = await fetch(remoteUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

    const blob = await response.blob();
    const mimeType = blob.type || "image/jpeg";
    const ext = mimeType.split("/")[1] || "jpg";

    const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });

    const fileName = `img2img_${Date.now()}`;
    const localUrl = await saveBase64AsFile(base64, characterName || "img2img", fileName, ext);

    console.log("[Img2Img] Image saved to ST filesystem:", localUrl);
    return localUrl;
}

// ── Chat injection ────────────────────────────────────────────────────────────

async function injectImageIntoChat(localPath, prompt) {
    const context = getContext();

    const message = {
        name: context.name2 || "Img2Img",
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: "",
        swipes: [""],
        swipe_id: 0,
        swipe_info: [{
            send_date: new Date().toISOString(),
            gen_started: null,
            gen_finished: null,
            extra: { img2img: true },
        }],
        extra: {
            isSmallSys: false,
            img2img: true,
            image: localPath,
            title: prompt,
        },
    };

    context.chat.push(message);
    const messageIndex = context.chat.length - 1;
    await addOneMessage(message, { type: "normal", insertAt: messageIndex });

    await saveChatDebounced();
    $("#chat").scrollTop($("#chat")[0].scrollHeight);
}

// ── Loading indicator ─────────────────────────────────────────────────────────

function showLoadingMessage() {
    $("#chat").append(`<div id="img2img_loading" class="img2img_loading_msg">⏳ Generating image, please wait...</div>`);
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

    console.log(`[Img2Img] Generating — prompt: "${prompt}", model: ${settings.model}, size: ${settings.image_size}, refs: ${referenceImages.length}`);

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
        const remoteUrl = await generateImage(prompt.trim());
        const localPath = await fetchAndSaveImage(remoteUrl, charName);

        hideLoadingMessage();
        await injectImageIntoChat(localPath, prompt.trim());

        toastr.success("Image generated and saved to ST gallery.");
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
        console.log("[Img2Img] Added reference image:", file.name);
    }

    await saveGalleryToDB(charName, current);
    console.log("[Img2Img] Reference gallery saved. Total:", current.length);
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

            <label style="margin-top:10px;">Model ID</label>
            <input type="text"
                   id="img2img_model"
                   class="text_pole"
                   placeholder="e.g. seedream-v4.5"
                   value="${settings.model}" />
            <small>Enter your model's exact API ID. Find it at <a href="https://nano-gpt.com/models" target="_blank">nano-gpt.com/models</a>.</small>

            <label style="margin-top:10px;">Image Size</label>
            <select id="img2img_size" class="text_pole"></select>
            <div id="img2img_custom_size" style="display:none; margin-top:6px;">
                <div style="display:flex; gap:8px; align-items:flex-end;">
                    <div style="flex:1;">
                        <label style="font-size:0.85em; display:block; margin-bottom:2px;">Width (px)</label>
                        <input type="number" id="img2img_custom_w" class="text_pole"
                               placeholder="e.g. 2048" min="1024" max="4096" />
                        <small>1024–4096</small>
                    </div>
                    <span style="font-size:1.3em; padding-bottom:18px;">×</span>
                    <div style="flex:1;">
                        <label style="font-size:0.85em; display:block; margin-bottom:2px;">Height (px)</label>
                        <input type="number" id="img2img_custom_h" class="text_pole"
                               placeholder="e.g. 3072" min="1024" max="4096" />
                        <small>1024–4096</small>
                    </div>
                </div>
                <small style="margin-top:4px; display:block; color:#aaa;">Tab or click away to apply.</small>
            </div>

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
            <small>ℹ️ Seedream 4.5 supports up to 10 reference images. Check your model's docs for its specific limit.</small>
            <br/>
            <small>💡 Use <code>/img2img your prompt here</code> in chat to generate.</small>
        </div>
    `;
    $("#extensions_settings").append(html);

    // ── API key ──
    $("#img2img_api_key").on("input", function () {
        getSettings().api_key = $(this).val();
        saveSettingsDebounced();
    });

    // ── Model ID ──
    $("#img2img_model").on("input", function () {
        const modelId = $(this).val().trim();
        getSettings().model = modelId;
        saveSettingsDebounced();
        updateSizeDropdown(modelId);
    });

    // ── Size select ──
    $("#img2img_size").on("change", function () {
        const val = $(this).val();
        toggleCustomSizeInputs(val === "custom");
        if (val !== "custom") {
            getSettings().image_size = val;
            saveSettingsDebounced();
        }
    });

    // ── Custom size inputs — save on blur ──
    $("#img2img_custom_w, #img2img_custom_h").on("change", validateAndSaveCustomSize);

    // ── File upload ──
    $("#img2img_upload_input").on("change", function () {
        const files = Array.from(this.files);
        this.value = "";
        handleImageUpload(files);
    });

    updateSizeDropdown(settings.model);
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

    registerSlashCommand(
        "img2img",
        handleGenerateCommand,
        [],
        "Generate an image using your character's reference gallery. Usage: /img2img a girl standing in a forest",
        true,
        true
    );

    console.log("[Img2Img] Extension ready (v0.9.1). Use /img2img [prompt] to generate.");
});
