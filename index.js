// Img2Img Reference Generator for SillyTavern
// Version 0.13.2 — FAB drag click fix, set reordering

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChatDebounced, addOneMessage } from "../../../../script.js";
import { registerSlashCommand } from "../../../slash-commands.js";
import { saveBase64AsFile } from "../../../../scripts/utils.js";

const extensionName = "st-img2img";
const NANO_API_URL  = "https://nano-gpt.com/api/v1/images/generations";
const NANO_CHAT_URL = "https://nano-gpt.com/api/v1/chat/completions";
const DB_NAME    = "img2img_gallery_db";
const DB_VERSION = 4;
const STORE_NAME = "galleries";
const DEFAULT_SET = "Default";

const DEFAULT_AUTO_PROMPT_TEMPLATE =
`You are an image generation prompt writer. Your entire output is a single descriptive paragraph — the prompt itself, ready to send to an image model. No preamble, no explanation, no sign-off.

The scene involves characters whose reference images have already been provided to the image model. For those characters, do NOT describe their base appearance or clothing — the references cover that. Instead, describe only what the scene is doing to them: their pose, body language, expression, gaze, and any scene-driven modifications to their appearance (wet hair, torn fabric, dramatic shadow across their face, dust on their clothes, etc.).

Any characters NOT covered by reference images must be described in full physical detail: build, skin tone, hair, eyes, clothing, everything.

For every prompt, also describe:
- The environment and background: location, architecture, objects, depth
- Lighting: source, direction, quality, and colour temperature (e.g. warm golden hour, cold moonlight, harsh neon, flickering candlelight)
- Atmosphere: time of day, weather, season, and the emotional tone of the scene
- Composition: framing and camera feel (e.g. close-up, wide establishing shot, low angle, over-the-shoulder)
- Colour palette: dominant tones and contrast
- Action or energy: what is happening, is there movement, tension, stillness?

Write the prompt now. One paragraph. No bullet points. No character names.`;

// ── Default widget icon (SVG — concentric lens rings + sparkle) ───────────────

const DEFAULT_WIDGET_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><defs><radialGradient id="i2ig" cx="38%" cy="32%" r="68%"><stop offset="0%" stop-color="#9b72e8"/><stop offset="100%" stop-color="#140b2e"/></radialGradient></defs><circle cx="28" cy="28" r="28" fill="url(#i2ig)"/><circle cx="28" cy="28" r="17" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/><circle cx="28" cy="28" r="11" fill="none" stroke="rgba(255,255,255,0.38)" stroke-width="1.5"/><circle cx="28" cy="28" r="5" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="1.5"/><circle cx="28" cy="28" r="2" fill="rgba(255,255,255,0.95)"/><path d="M40 14 L41.2 17.8 L45 19 L41.2 20.2 L40 24 L38.8 20.2 L35 19 L38.8 17.8 Z" fill="white" opacity="0.88"/><circle cx="44" cy="26" r="1.2" fill="white" opacity="0.55"/><circle cx="42" cy="11" r="1" fill="white" opacity="0.45"/></svg>`;

// ── Size map per model ────────────────────────────────────────────────────────

const MODEL_SIZES = {
    "seedream-v4.5": [
        { value: "1920x1920", label: "1920×1920 — Min Square" },
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

// ── IndexedDB ─────────────────────────────────────────────────────────────────
// Schema: { characterName, sets, activeSet, char_prefix, char_suffix }

let db = null;
let _fabDragJustOccurred = false;  // suppresses FAB click after drag

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: "characterName" });
            }
        };
        request.onsuccess = async (e) => {
            db = e.target.result;
            await migrateV3toV4();
            resolve(db);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function migrateV3toV4() {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = (e) => {
            const records = e.target.result || [];
            let migrated = 0;
            for (const record of records) {
                if (record.images && !record.sets) {
                    store.put({
                        characterName: record.characterName,
                        sets: { [DEFAULT_SET]: record.images },
                        activeSet: DEFAULT_SET,
                        char_prefix: "",
                        char_suffix: "",
                    });
                    migrated++;
                }
            }
            tx.oncomplete = () => {
                if (migrated > 0) console.log(`[Img2Img] Migrated ${migrated} record(s) to v4 schema.`);
                resolve();
            };
        };
        req.onerror = () => resolve();
    });
}

function loadRecordFromDB(characterName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(characterName);
        request.onsuccess = (e) => {
            const result = e.target.result;
            if (result) {
                result.char_prefix = result.char_prefix ?? "";
                result.char_suffix = result.char_suffix ?? "";
                resolve(result);
            } else {
                resolve({
                    characterName,
                    sets: { [DEFAULT_SET]: [] },
                    activeSet: DEFAULT_SET,
                    char_prefix: "",
                    char_suffix: "",
                });
            }
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

function saveRecordToDB(record) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(record);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

async function loadActiveSetImages(characterName) {
    const record = await loadRecordFromDB(characterName);
    return record.sets[record.activeSet] || [];
}

// ── Settings ──────────────────────────────────────────────────────────────────

const defaultSettings = {
    api_key: "",
    model: "seedream-v4.5",
    image_size: "2048x2048",
    global_prefix: "",
    global_suffix: "",
    auto_prompt_template: DEFAULT_AUTO_PROMPT_TEMPLATE,
    auto_prompt_preview: true,
    auto_prompt_model: "gpt-4o-mini",
    auto_prompt_context_messages: 10,
    widget_icon: null,
    widget_position: { bottom: 80, right: 20 },
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

// ── Prompt assembly ───────────────────────────────────────────────────────────

async function getEffectivePrefix(charName) {
    if (charName) {
        const record = await loadRecordFromDB(charName);
        if (record.char_prefix && record.char_prefix.trim()) return record.char_prefix.trim();
    }
    return getSettings().global_prefix.trim();
}

async function getEffectiveSuffix(charName) {
    if (charName) {
        const record = await loadRecordFromDB(charName);
        if (record.char_suffix && record.char_suffix.trim()) return record.char_suffix.trim();
    }
    return getSettings().global_suffix.trim();
}

function assemblePrompt(corePrompt, prefix, suffix) {
    return [prefix, corePrompt, suffix].map(s => s.trim()).filter(Boolean).join(", ");
}

function stripPreamble(text) {
    return text
        .replace(/^(here(?:'s| is)(?: your| the| an?)?(?: image)?(?: generation)?(?: prompt)?[:\-\u2013\u2014]*\s*)/i, "")
        .replace(/^(image(?: generation)? prompt[:\-\u2013\u2014]*\s*)/i, "")
        .replace(/^(prompt[:\-\u2013\u2014]*\s*)/i, "")
        .replace(/^["']|["']$/g, "")
        .trim();
}

// ── Auto-prompt from chat context ─────────────────────────────────────────────

function buildChatContext(numMessages) {
    const context = getContext();
    const chat = context?.chat || [];

    const usable = chat.filter(m => {
        if (m.extra?.img2img) return false;
        const text = (m.mes || "").trim();
        if (!text) return false;
        if (m.is_user && text.startsWith("/")) return false;
        return true;
    });

    const recent = usable.slice(-numMessages);
    if (recent.length === 0) return "(No recent messages available.)";

    const lines = recent.map(m => {
        const speaker = m.is_user ? "User" : (m.name || "Character");
        return `${speaker}: ${(m.mes || "").trim()}`;
    });

    console.log(`[Img2Img] Auto-prompt context (${recent.length} messages):\n` + lines.join("\n---\n"));
    return lines.join("\n");
}

async function generateAutoPrompt() {
    const settings   = getSettings();
    const template   = settings.auto_prompt_template || DEFAULT_AUTO_PROMPT_TEMPLATE;
    const chatModel  = settings.auto_prompt_model    || "gpt-4o-mini";
    const numMsgs    = settings.auto_prompt_context_messages ?? 10;

    if (!settings.api_key) throw new Error("No API key set — cannot generate auto-prompt.");

    toastr.info("Generating scene description…", "", { timeOut: 3000 });

    const chatContext = buildChatContext(numMsgs);
    const messages = [
        { role: "system", content: template },
        { role: "user",   content: `Here are the last ${numMsgs} messages from the current scene:\n\n${chatContext}\n\nWrite the image generation prompt now.` },
    ];

    try {
        const response = await fetch(NANO_CHAT_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${settings.api_key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: chatModel, messages, max_tokens: 400, temperature: 0.4 }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`NanoGPT chat API error ${response.status}: ${err}`);
        }

        const data = await response.json();
        const raw  = data?.choices?.[0]?.message?.content;
        if (!raw?.trim()) throw new Error("Empty response from chat model.");
        return stripPreamble(raw);
    } catch (err) {
        throw new Error(`Auto-prompt failed: ${err.message}`);
    }
}

// ── Size helpers ──────────────────────────────────────────────────────────────

function getSizesForModel(modelId) {
    return MODEL_SIZES[modelId] || DEFAULT_SIZES;
}

function updateSizeDropdown(modelId) {
    const sizes = getSizesForModel(modelId);
    const $sizeSelect = $("#img2img_size");
    const currentSize = getSettings().image_size;

    $sizeSelect.empty();
    sizes.forEach(s => {
        const selected = s.value === currentSize ? "selected" : "";
        $sizeSelect.append(`<option value="${s.value}" ${selected}>${s.label}</option>`);
    });

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
    if (w < 1024 || w > 4096) { toastr.warning(`Width must be between 1024 and 4096 pixels (got ${w}).`); return; }
    if (h < 1024 || h > 4096) { toastr.warning(`Height must be between 1024 and 4096 pixels (got ${h}).`); return; }
    getSettings().image_size = `${w}x${h}`;
    saveSettingsDebounced();
    toastr.success(`Custom size set: ${w}×${h}`);
}

// ── Image fetch + save ────────────────────────────────────────────────────────

async function fetchAndSaveImage(remoteUrl, characterName) {
    const response = await fetch(remoteUrl);
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

    const blob = await response.blob();
    const mimeType = blob.type || "image/jpeg";
    const ext = mimeType.split("/")[1] || "jpg";

    const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = (e) => resolve(e.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });

    const fileName = `img2img_${Date.now()}`;
    const localUrl = await saveBase64AsFile(base64, characterName || "img2img", fileName, ext);
    console.log("[Img2Img] Image saved:", localUrl);
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
        swipe_info: [{ send_date: new Date().toISOString(), gen_started: null, gen_finished: null, extra: { img2img: true } }],
        extra: { isSmallSys: false, img2img: true, image: localPath, title: prompt },
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

// ── Image generation API ──────────────────────────────────────────────────────

async function generateImage(finalPrompt) {
    const settings = getSettings();
    if (!settings.api_key) throw new Error("No API key set. Please add your NanoGPT key in the extension settings.");

    const charName = getCurrentCharacterName();
    const referenceImages = charName ? await loadActiveSetImages(charName) : [];

    console.log(`[Img2Img] Generating — model: ${settings.model}, size: ${settings.image_size}, refs: ${referenceImages.length}`);
    console.log(`[Img2Img] Final prompt: "${finalPrompt}"`);

    const payload = {
        model: settings.model,
        prompt: finalPrompt,
        n: 1,
        size: settings.image_size,
        response_format: "url",
    };

    if (referenceImages.length === 1)      payload.imageDataUrl  = referenceImages[0];
    else if (referenceImages.length > 1)   payload.imageDataUrls = referenceImages;

    const response = await fetch(NANO_API_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${settings.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`NanoGPT API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const imageUrl = data?.data?.[0]?.url;
    if (!imageUrl) throw new Error("No image URL in response: " + JSON.stringify(data));
    return imageUrl;
}

// ── Core generate pipeline ────────────────────────────────────────────────────

async function runGeneration(corePrompt) {
    showLoadingMessage();
    try {
        const charName = getCurrentCharacterName();
        const prefix = await getEffectivePrefix(charName);
        const suffix = await getEffectiveSuffix(charName);
        const finalPrompt = assemblePrompt(corePrompt, prefix, suffix);

        const remoteUrl = await generateImage(finalPrompt);
        const localPath = await fetchAndSaveImage(remoteUrl, charName);

        hideLoadingMessage();
        await injectImageIntoChat(localPath, finalPrompt);
        toastr.success("Image generated and saved to gallery.");
    } catch (err) {
        hideLoadingMessage();
        console.error("[Img2Img] Generation failed:", err);
        toastr.error(`Generation failed: ${err.message}`);
    }
}

// ── Slash command handler ─────────────────────────────────────────────────────

async function handleGenerateCommand(namedArgs, unnamedValue) {
    const manualPrompt = (unnamedValue || namedArgs?.value || "").trim();
    const settings = getSettings();

    if (manualPrompt) {
        if (settings.auto_prompt_preview) {
            openWidget();
            $("#img2img_widget_prompt").val(manualPrompt).focus();
        } else {
            await runGeneration(manualPrompt);
        }
        return;
    }

    if (settings.auto_prompt_preview) {
        openWidget();
        const $btn = $("#img2img_widget_autofill");
        $btn.prop("disabled", true).text("…");
        try {
            const prompt = await generateAutoPrompt();
            $("#img2img_widget_prompt").val(prompt).focus();
        } catch (err) {
            toastr.error(err.message);
        } finally {
            $btn.prop("disabled", false).text("↺  Auto-fill");
        }
    } else {
        try {
            const autoPrompt = await generateAutoPrompt();
            await runGeneration(autoPrompt);
        } catch (err) {
            toastr.error(err.message);
        }
    }
}

// ── Floating widget ───────────────────────────────────────────────────────────

function getWidgetIconSrc() {
    const custom = getSettings().widget_icon;
    if (custom) return custom;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DEFAULT_WIDGET_ICON_SVG)}`;
}

function injectWidgetStyles() {
    if ($("#img2img_widget_styles").length) return;
    $("head").append(`<style id="img2img_widget_styles">
        #img2img_widget_container {
            position: fixed;
            z-index: 9999;
            user-select: none;
        }
        #img2img_widget_fab {
            width: 56px; height: 56px;
            border-radius: 50%;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(0,0,0,0.65), 0 0 0 2px rgba(155,114,232,0.28);
            overflow: hidden;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
            background: #140b2e;
            border: none; padding: 0; display: block;
        }
        #img2img_widget_fab:hover {
            transform: scale(1.07);
            box-shadow: 0 6px 26px rgba(0,0,0,0.75), 0 0 0 3px rgba(155,114,232,0.48);
        }
        #img2img_widget_fab img {
            width: 100%; height: 100%;
            display: block; pointer-events: none;
            border-radius: 50%;
        }
        #img2img_widget_panel {
            position: absolute; bottom: 68px; right: 0;
            width: 310px;
            background: var(--SmartThemeBlurTintColor, #1c1b2e);
            border: 1px solid rgba(155,114,232,0.22);
            border-radius: 14px;
            box-shadow: 0 10px 36px rgba(0,0,0,0.72);
            overflow: hidden;
            animation: img2img_fadein 0.14s ease;
        }
        @keyframes img2img_fadein {
            from { opacity: 0; transform: translateY(6px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0)   scale(1); }
        }
        #img2img_widget_handle {
            display: flex; align-items: center; justify-content: space-between;
            padding: 9px 12px 8px;
            background: rgba(155,114,232,0.09);
            cursor: grab;
            border-bottom: 1px solid rgba(255,255,255,0.055);
        }
        #img2img_widget_handle.dragging { cursor: grabbing; }
        #img2img_widget_title {
            font-size: 0.73em; font-weight: 700;
            letter-spacing: 0.1em; text-transform: uppercase;
            color: rgba(255,255,255,0.48);
        }
        #img2img_widget_close {
            background: none; border: none;
            color: rgba(255,255,255,0.3); cursor: pointer;
            font-size: 0.95em; line-height: 1; padding: 0;
            transition: color 0.1s;
        }
        #img2img_widget_close:hover { color: rgba(255,255,255,0.85); }
        #img2img_widget_body {
            padding: 10px 12px 6px;
            display: flex; flex-direction: column; gap: 7px;
        }
        #img2img_widget_char_bar {
            font-size: 0.71em;
            color: rgba(255,255,255,0.28);
            text-align: center;
        }
        .img2img_widget_row {
            display: flex; align-items: center; gap: 5px;
        }
        .img2img_widget_label {
            font-size: 0.71em; color: rgba(255,255,255,0.38);
            min-width: 30px; flex-shrink: 0;
        }
        .img2img_widget_select {
            flex: 1; font-size: 0.79em;
            padding: 4px 6px;
            background: rgba(255,255,255,0.055);
            border: 1px solid rgba(255,255,255,0.09);
            border-radius: 6px; color: inherit; cursor: pointer;
            min-width: 0;
        }
        .img2img_widget_select:focus { outline: none; border-color: rgba(155,114,232,0.45); }
        .img2img_wgt_iconbtn {
            padding: 2px 5px; font-size: 0.77em;
            line-height: 1.4;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 5px; cursor: pointer; color: inherit;
            opacity: 0.65; transition: opacity 0.1s, background 0.1s;
            flex-shrink: 0;
        }
        .img2img_wgt_iconbtn:hover { opacity: 1; background: rgba(255,255,255,0.12); }
        .img2img_wgt_iconbtn:disabled { opacity: 0.25; pointer-events: none; }
        #img2img_widget_prompt {
            width: 100%; resize: none; min-height: 96px; box-sizing: border-box;
            font-size: 0.81em; padding: 8px;
            background: rgba(0,0,0,0.22);
            border: 1px solid rgba(255,255,255,0.075);
            border-radius: 7px; color: inherit;
            box-sizing: border-box; font-family: inherit; line-height: 1.5;
        }
        #img2img_widget_prompt:focus {
            border-color: rgba(155,114,232,0.45); outline: none;
        }
        #img2img_widget_resize_grip {
            width: 100%; height: 7px; cursor: ns-resize;
            display: flex; align-items: center; justify-content: center;
            margin-top: -1px; margin-bottom: 2px; flex-shrink: 0;
            opacity: 0.35; transition: opacity 0.15s;
            user-select: none;
        }
        #img2img_widget_resize_grip:hover { opacity: 0.75; }
        #img2img_widget_resize_grip svg { pointer-events: none; }
        .img2img_widget_buttons { display: flex; gap: 6px; }
        #img2img_widget_autofill {
            flex: 1; font-size: 0.79em; padding: 6px 4px;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 7px; cursor: pointer; color: inherit;
            transition: background 0.1s;
        }
        #img2img_widget_autofill:hover  { background: rgba(255,255,255,0.1); }
        #img2img_widget_autofill:disabled { opacity: 0.4; pointer-events: none; }
        #img2img_widget_generate {
            flex: 1.6; font-size: 0.79em; padding: 6px 4px;
            background: rgba(155,114,232,0.2);
            border: 1px solid rgba(155,114,232,0.38);
            border-radius: 7px; cursor: pointer; color: inherit;
            transition: background 0.1s;
        }
        #img2img_widget_generate:hover    { background: rgba(155,114,232,0.36); }
        #img2img_widget_generate:disabled { opacity: 0.4; pointer-events: none; }
        #img2img_widget_footer {
            padding: 5px 12px 8px;
            border-top: 1px solid rgba(255,255,255,0.045);
            text-align: right;
        }
        #img2img_widget_change_icon {
            font-size: 0.67em; color: rgba(255,255,255,0.18);
            cursor: pointer; background: none; border: none; padding: 0;
            transition: color 0.15s;
        }
        #img2img_widget_change_icon:hover { color: rgba(255,255,255,0.55); }
    </style>`);
}

function createFloatingWidget() {
    $("#img2img_widget_container").remove();
    injectWidgetStyles();

    const settings = getSettings();
    const pos = settings.widget_position || { bottom: 80, right: 20 };
    const iconSrc = getWidgetIconSrc();

    const $container = $(`<div id="img2img_widget_container"></div>`);
    $container.css({ bottom: pos.bottom + "px", right: pos.right + "px" });

    const $fab = $(`
        <button id="img2img_widget_fab" title="Img2Img — click to open">
            <img id="img2img_widget_icon_img" src="${iconSrc}" alt="Img2Img" />
        </button>
    `);

    const $panel = $(`
        <div id="img2img_widget_panel" style="display:none;">
            <div id="img2img_widget_handle">
                <span id="img2img_widget_title">✦ Img2Img</span>
                <button id="img2img_widget_close" title="Close">✕</button>
            </div>
            <div id="img2img_widget_body">
                <div id="img2img_widget_char_bar">No character selected</div>

                <div class="img2img_widget_row">
                    <span class="img2img_widget_label">Set</span>
                    <select id="img2img_widget_set" class="img2img_widget_select"></select>
                    <button class="img2img_wgt_iconbtn" id="img2img_wgt_manage_sets" title="Manage sets">⚙ Manage</button>
                </div>

                <div class="img2img_widget_row">
                    <span class="img2img_widget_label">Size</span>
                    <select id="img2img_widget_size" class="img2img_widget_select"></select>
                </div>

                <textarea id="img2img_widget_prompt"
                          placeholder="Type a prompt, or click Auto-fill…"></textarea>
                <div id="img2img_widget_resize_grip">
                    <svg width="36" height="4" viewBox="0 0 36 4"><rect y="0" width="36" height="1.5" rx="1" fill="white"/><rect y="2.5" width="36" height="1.5" rx="1" fill="white"/></svg>
                </div>

                <div class="img2img_widget_buttons">
                    <button id="img2img_widget_autofill"  title="Generate prompt from current scene">↺  Auto-fill</button>
                    <button id="img2img_widget_generate"  title="Generate image (Ctrl+Enter)">▶  Generate</button>
                </div>
            </div>
            <div id="img2img_widget_footer">
                <button id="img2img_widget_change_icon" title="Upload a custom widget icon">Change icon</button>
                <input type="file" id="img2img_widget_icon_upload" accept="image/*" style="display:none;" />
            </div>
        </div>
    `);

    $container.append($panel).append($fab);
    $("body").append($container);

    // ── FAB: toggle panel ──
    $fab.on("click", toggleWidget);

    // ── Close ──
    $("#img2img_widget_close").on("click", closeWidget);

    // ── Auto-fill ──
    $("#img2img_widget_autofill").on("click", async () => {
        const $btn = $("#img2img_widget_autofill");
        $btn.prop("disabled", true).text("…");
        try {
            const prompt = await generateAutoPrompt();
            $("#img2img_widget_prompt").val(prompt).focus().select();
        } catch (err) {
            toastr.error(err.message);
        } finally {
            $btn.prop("disabled", false).text("↺  Auto-fill");
        }
    });

    // ── Generate ──
    $("#img2img_widget_generate").on("click", widgetGenerate);
    $("#img2img_widget_prompt").on("keydown", (e) => {
        if (e.ctrlKey && e.key === "Enter") widgetGenerate();
    });

    // ── Set dropdown ──
    $("#img2img_widget_set").on("change", async function () {
        const charName = getCurrentCharacterName();
        if (!charName) return;
        const rec = await loadRecordFromDB(charName);
        rec.activeSet = $(this).val();
        await saveRecordToDB(rec);
        refreshWidgetState();
        renderGallery();
    });

    // ── Size dropdown ──
    $("#img2img_widget_size").on("change", function () {
        const val = $(this).val();
        if (val !== "custom") {
            getSettings().image_size = val;
            saveSettingsDebounced();
            $("#img2img_size").val(val); // keep settings panel in sync
        }
    });

    // ── Set management modal ──
    $("#img2img_wgt_manage_sets").on("click", () => {
        openSetManager();
    });

    // ── Icon customization ──
    $("#img2img_widget_change_icon").on("click", () => {
        $("#img2img_widget_icon_upload").trigger("click");
    });

    $("#img2img_widget_icon_upload").on("change", function () {
        const file = this.files[0];
        if (!file) return;
        this.value = "";
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            getSettings().widget_icon = dataUrl;
            saveSettingsDebounced();
            $("#img2img_widget_icon_img").attr("src", dataUrl);
            toastr.success("Widget icon updated.");
        };
        reader.readAsDataURL(file);
    });

    // ── Drag ──
    initWidgetDrag($container, $("#img2img_widget_handle"), $fab);

    // ── Textarea resize ──
    initTextareaResize($container, $("#img2img_widget_resize_grip"), $("#img2img_widget_prompt"));

    // ── Initial state ──
    refreshWidgetState();
}

async function refreshWidgetState() {
    const charName = getCurrentCharacterName();
    const settings = getSettings();

    $("#img2img_widget_char_bar").text(
        charName ? `Character: ${charName}` : "No character selected"
    );

    // Set dropdown
    const $setSelect = $("#img2img_widget_set");
    $setSelect.empty();

    if (charName) {
        const record = await loadRecordFromDB(charName);
        const setNames = Object.keys(record.sets);
        setNames.forEach(name => {
            const selected = name === record.activeSet ? "selected" : "";
            $setSelect.append(`<option value="${name}" ${selected}>${name} (${record.sets[name].length})</option>`);
        });
    } else {
        $setSelect.append(`<option disabled>— no character —</option>`);
    }

    // Size dropdown (exclude "custom" — handled in settings panel)
    const $sizeSelect = $("#img2img_widget_size");
    $sizeSelect.empty();
    const sizes = getSizesForModel(settings.model);
    sizes.filter(s => s.value !== "custom").forEach(s => {
        const selected = s.value === settings.image_size ? "selected" : "";
        $sizeSelect.append(`<option value="${s.value}" ${selected}>${s.label}</option>`);
    });
    if (!$sizeSelect.val()) {
        const first = sizes.find(s => s.value !== "custom");
        if (first) $sizeSelect.val(first.value);
    }
}

function toggleWidget() {
    if (_fabDragJustOccurred) { _fabDragJustOccurred = false; return; }
    const $panel = $("#img2img_widget_panel");
    if ($panel.is(":visible")) closeWidget();
    else openWidget();
}

function openWidget() {
    $("#img2img_widget_panel").show();
    refreshWidgetState();
}

function closeWidget() {
    $("#img2img_widget_panel").hide();
}

async function widgetGenerate() {
    const prompt = $("#img2img_widget_prompt").val().trim();
    if (!prompt) { toastr.warning("Enter a prompt first, or click Auto-fill."); return; }

    const $btn = $("#img2img_widget_generate");
    $btn.prop("disabled", true).text("…");
    try {
        await runGeneration(prompt);
    } finally {
        $btn.prop("disabled", false).text("▶  Generate");
    }
}

function initTextareaResize($container, $grip, $textarea) {
    let resizing  = false;
    let startY, startH, startBottom;

    $grip.on("mousedown", (e) => {
        resizing    = true;
        startY      = e.clientY;
        startH      = $textarea.outerHeight();
        startBottom = parseInt($container.css("bottom")) || 80;
        e.preventDefault();
        e.stopPropagation(); // don't trigger widget drag
    });

    $(document).on("mousemove.img2img_resize", (e) => {
        if (!resizing) return;
        const delta  = e.clientY - startY;
        const newH   = Math.max(60, startH + delta);
        const newBottom = Math.max(0, startBottom - delta);
        $textarea.css("min-height", newH + "px").css("height", newH + "px");
        $container.css("bottom", newBottom + "px");
    });

    $(document).on("mouseup.img2img_resize", () => {
        if (!resizing) return;
        resizing = false;
        getSettings().widget_position = {
            right:  parseInt($container.css("right"))  || 20,
            bottom: parseInt($container.css("bottom")) || 80,
        };
        saveSettingsDebounced();
    });
}

function initWidgetDrag($container, $handle, $fab) {
    let dragging  = false;
    let didDrag   = false;
    let startX, startY, startRight, startBottom;

    function beginDrag(e) {
        dragging  = true;
        didDrag   = false;
        startX      = e.clientX;
        startY      = e.clientY;
        startRight  = parseInt($container.css("right"))  || 20;
        startBottom = parseInt($container.css("bottom")) || 80;
        $handle.addClass("dragging");
        e.preventDefault();
    }

    // Drag from handle (skip close button)
    $handle.on("mousedown", (e) => {
        if ($(e.target).is("button")) return;
        beginDrag(e);
    });

    // Drag from FAB — but still allow a clean click to toggle
    $fab.on("mousedown", (e) => {
        beginDrag(e);
    });

    $(document).on("mousemove.img2img_drag", (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag = true;
        const newRight  = Math.max(0, startRight  - dx);
        const newBottom = Math.max(0, startBottom - dy);
        $container.css({ right: newRight + "px", bottom: newBottom + "px" });
    });

    $(document).on("mouseup.img2img_drag", () => {
        if (!dragging) return;
        dragging = false;
        $handle.removeClass("dragging");
        if (didDrag) {
            getSettings().widget_position = {
                right:  parseInt($container.css("right"))  || 20,
                bottom: parseInt($container.css("bottom")) || 80,
            };
            saveSettingsDebounced();
            _fabDragJustOccurred = true;
        }
    });


}


// ── Set reorder helper ────────────────────────────────────────────────────────

async function moveSet(charName, setName, direction) {
    const rec   = await loadRecordFromDB(charName);
    const keys  = Object.keys(rec.sets);
    const idx   = keys.indexOf(setName);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= keys.length) return;

    // Swap
    [keys[idx], keys[newIdx]] = [keys[newIdx], keys[idx]];

    // Rebuild sets object in new order
    const reordered = {};
    keys.forEach(k => { reordered[k] = rec.sets[k]; });
    rec.sets = reordered;

    await saveRecordToDB(rec);
    refreshWidgetState();
    renderGallery();
}

// ── Set Manager modal ────────────────────────────────────────────────────────

function openSetManager() {
    const charName = getCurrentCharacterName();
    if (!charName) { toastr.warning("Open a character chat first."); return; }

    // Inject styles once
    if (!$("#img2img_setmgr_styles").length) {
        $("head").append(`<style id="img2img_setmgr_styles">
            #img2img_setmgr_overlay {
                position: fixed; inset: 0; z-index: 10000;
                background: rgba(0,0,0,0.62);
                display: flex; align-items: center; justify-content: center;
            }
            #img2img_setmgr_modal {
                width: 480px; max-width: 95vw; max-height: 88vh;
                display: flex; flex-direction: column;
                background: var(--SmartThemeBlurTintColor, #1c1b2e);
                border: 1px solid rgba(155,114,232,0.22);
                border-radius: 16px;
                box-shadow: 0 18px 54px rgba(0,0,0,0.80);
                animation: img2img_fadein 0.14s ease;
                overflow: hidden;
            }
            #img2img_setmgr_header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 14px 18px 12px;
                background: rgba(155,114,232,0.08);
                border-bottom: 1px solid rgba(255,255,255,0.055);
                flex-shrink: 0;
            }
            #img2img_setmgr_title {
                font-size: 0.88em; font-weight: 700;
                letter-spacing: 0.06em;
            }
            #img2img_setmgr_charname {
                font-size: 0.72em; color: rgba(155,114,232,0.75);
                margin-top: 1px;
            }
            #img2img_setmgr_close {
                background: none; border: none;
                color: rgba(255,255,255,0.3); cursor: pointer;
                font-size: 1.05em; padding: 0; line-height: 1;
                transition: color 0.12s;
            }
            #img2img_setmgr_close:hover { color: rgba(255,255,255,0.85); }
            #img2img_setmgr_body {
                overflow-y: auto; padding: 14px 18px;
                flex: 1; display: flex; flex-direction: column; gap: 14px;
            }
            .img2img_setmgr_section { display: flex; flex-direction: column; gap: 6px; }
            .img2img_setmgr_section_label {
                font-size: 0.7em; font-weight: 700;
                text-transform: uppercase; letter-spacing: 0.1em;
                color: rgba(255,255,255,0.3);
            }
            #img2img_setmgr_list {
                display: flex; flex-direction: column; gap: 4px;
            }
            .img2img_setmgr_set_row {
                display: flex; align-items: center; gap: 7px;
                padding: 7px 10px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.06);
                background: rgba(255,255,255,0.03);
                cursor: pointer;
                transition: background 0.1s, border-color 0.1s;
            }
            .img2img_setmgr_set_row:hover { background: rgba(255,255,255,0.07); }
            .img2img_setmgr_set_row.active {
                border-color: rgba(155,114,232,0.42);
                background: rgba(155,114,232,0.08);
            }
            .img2img_setmgr_set_name {
                flex: 1; font-size: 0.84em; font-weight: 600;
            }
            .img2img_setmgr_set_count {
                font-size: 0.72em; color: rgba(255,255,255,0.3);
            }
            .img2img_setmgr_set_btns { display: flex; gap: 4px; }
            .img2img_setmgr_set_btn {
                padding: 2px 7px; font-size: 0.74em;
                background: rgba(255,255,255,0.06);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 5px; cursor: pointer; color: inherit;
                opacity: 0.55; transition: opacity 0.1s, background 0.1s;
            }
            .img2img_setmgr_set_btn:hover { opacity: 1; background: rgba(255,255,255,0.12); }
            .img2img_setmgr_set_btn.danger:hover { background: rgba(220,60,60,0.22); border-color: rgba(220,60,60,0.35); opacity: 1; }
            #img2img_setmgr_new_row {
                display: flex; gap: 7px;
            }
            #img2img_setmgr_new_input {
                flex: 1; padding: 6px 10px; font-size: 0.82em;
                background: rgba(0,0,0,0.22);
                border: 1px solid rgba(255,255,255,0.09);
                border-radius: 7px; color: inherit; font-family: inherit;
            }
            #img2img_setmgr_new_input:focus {
                border-color: rgba(155,114,232,0.45); outline: none;
            }
            #img2img_setmgr_new_btn {
                padding: 6px 14px; font-size: 0.82em;
                background: rgba(155,114,232,0.18);
                border: 1px solid rgba(155,114,232,0.32);
                border-radius: 7px; cursor: pointer; color: inherit;
                transition: background 0.1s;
            }
            #img2img_setmgr_new_btn:hover { background: rgba(155,114,232,0.32); }
            #img2img_setmgr_thumbs {
                display: flex; flex-wrap: wrap; gap: 7px;
                min-height: 48px;
            }
            .img2img_setmgr_thumb {
                position: relative; width: 72px; height: 72px;
                border-radius: 7px; overflow: hidden;
                border: 1px solid rgba(255,255,255,0.08);
                flex-shrink: 0;
            }
            .img2img_setmgr_thumb img {
                width: 100%; height: 100%; object-fit: cover; display: block;
            }
            .img2img_setmgr_thumb_del {
                position: absolute; top: 2px; right: 2px;
                width: 18px; height: 18px; border-radius: 50%;
                background: rgba(0,0,0,0.65); border: none;
                color: rgba(255,255,255,0.7); font-size: 0.65em;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                opacity: 0; transition: opacity 0.15s;
            }
            .img2img_setmgr_thumb:hover .img2img_setmgr_thumb_del { opacity: 1; }
            #img2img_setmgr_upload_btn {
                width: 72px; height: 72px; border-radius: 7px;
                border: 1.5px dashed rgba(155,114,232,0.35);
                background: rgba(155,114,232,0.06);
                color: rgba(155,114,232,0.6); font-size: 1.5em;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
                flex-shrink: 0; transition: background 0.12s, border-color 0.12s;
            }
            #img2img_setmgr_upload_btn:hover {
                background: rgba(155,114,232,0.14); border-color: rgba(155,114,232,0.6);
            }
            #img2img_setmgr_empty {
                font-size: 0.78em; color: rgba(255,255,255,0.25);
                padding: 4px 0;
            }
        </style>`);
    }

    async function renderSetMgr() {
        const rec = await loadRecordFromDB(charName);
        const setNames = Object.keys(rec.sets);

        // Set list
        const $list = $("#img2img_setmgr_list").empty();
        setNames.forEach((name, idx) => {
            const isActive = name === rec.activeSet;
            const count = rec.sets[name].length;
            const $row = $(`
                <div class="img2img_setmgr_set_row${isActive ? " active" : ""}" data-set="${name}">
                    <span class="img2img_setmgr_set_name">${name}</span>
                    <span class="img2img_setmgr_set_count">${count} image${count !== 1 ? "s" : ""}</span>
                    <div class="img2img_setmgr_set_btns">
                        <button class="img2img_setmgr_set_btn move-up-btn"   data-set="${name}" title="Move up"   ${idx === 0 ? "disabled" : ""}>▲</button>
                        <button class="img2img_setmgr_set_btn move-down-btn" data-set="${name}" title="Move down" ${idx === setNames.length - 1 ? "disabled" : ""}>▼</button>
                        <button class="img2img_setmgr_set_btn rename-btn"    data-set="${name}" title="Rename">✏️</button>
                        <button class="img2img_setmgr_set_btn danger delete-btn" data-set="${name}"
                                title="Delete" ${setNames.length <= 1 ? "disabled" : ""}>🗑️</button>
                    </div>
                </div>
            `);

            $row.on("click", async (e) => {
                if ($(e.target).is("button")) return;
                const r = await loadRecordFromDB(charName);
                r.activeSet = name;
                await saveRecordToDB(r);
                refreshWidgetState();
                renderGallery();
                renderSetMgr();
            });

            $row.find(".move-up-btn").on("click", async (e) => {
                e.stopPropagation();
                await moveSet(charName, name, -1);
                renderSetMgr();
            });

            $row.find(".move-down-btn").on("click", async (e) => {
                e.stopPropagation();
                await moveSet(charName, name, 1);
                renderSetMgr();
            });

            $row.find(".rename-btn").on("click", async () => {
                const newName = prompt_input("Rename set:", name);
                if (!newName?.trim() || newName.trim() === name) return;
                const trimmed = newName.trim();
                const r = await loadRecordFromDB(charName);
                if (r.sets[trimmed]) { toastr.warning(`"${trimmed}" already exists.`); return; }
                r.sets[trimmed] = r.sets[name];
                delete r.sets[name];
                if (r.activeSet === name) r.activeSet = trimmed;
                await saveRecordToDB(r);
                toastr.success(`Renamed to "${trimmed}".`);
                refreshWidgetState();
                renderGallery();
                renderSetMgr();
            });

            $row.find(".delete-btn").on("click", async () => {
                if (setNames.length <= 1) return;
                const r = await loadRecordFromDB(charName);
                if (!confirm(`Delete set "${name}" and all ${r.sets[name].length} image(s)?`)) return;
                delete r.sets[name];
                if (r.activeSet === name) r.activeSet = Object.keys(r.sets)[0];
                await saveRecordToDB(r);
                toastr.success(`Set "${name}" deleted.`);
                refreshWidgetState();
                renderGallery();
                renderSetMgr();
            });

            $list.append($row);
        });

        // Thumbnails for active set
        const $thumbs = $("#img2img_setmgr_thumbs").empty();
        const images = rec.sets[rec.activeSet] || [];

        if (images.length === 0) {
            $thumbs.append(`<span id="img2img_setmgr_empty">No images yet — upload some!</span>`);
        } else {
            images.forEach((dataUrl, idx) => {
                const $thumb = $(`
                    <div class="img2img_setmgr_thumb">
                        <img src="${dataUrl}" />
                        <button class="img2img_setmgr_thumb_del" data-idx="${idx}" title="Remove">✕</button>
                    </div>
                `);
                $thumb.find(".img2img_setmgr_thumb_del").on("click", async () => {
                    const r = await loadRecordFromDB(charName);
                    r.sets[r.activeSet].splice(idx, 1);
                    await saveRecordToDB(r);
                    renderGallery();
                    renderSetMgr();
                });
                $thumbs.append($thumb);
            });
        }

        // Upload button
        const $uploadBtn = $(`<button id="img2img_setmgr_upload_btn" title="Upload images">＋</button>`);
        $uploadBtn.on("click", () => $("#img2img_setmgr_file_input").trigger("click"));
        $thumbs.append($uploadBtn);

        // Active set label
        $("#img2img_setmgr_active_label").text(`Images in "${rec.activeSet}"`);
    }

    // Build modal DOM
    $("#img2img_setmgr_overlay").remove();
    const $overlay = $(`
        <div id="img2img_setmgr_overlay">
            <div id="img2img_setmgr_modal">
                <div id="img2img_setmgr_header">
                    <div>
                        <div id="img2img_setmgr_title">Reference Sets</div>
                        <div id="img2img_setmgr_charname">${charName}</div>
                    </div>
                    <button id="img2img_setmgr_close">✕</button>
                </div>
                <div id="img2img_setmgr_body">
                    <div class="img2img_setmgr_section">
                        <div class="img2img_setmgr_section_label">Sets — click a row to activate</div>
                        <div id="img2img_setmgr_list"></div>
                        <div id="img2img_setmgr_new_row">
                            <input type="text" id="img2img_setmgr_new_input" placeholder="New set name…" />
                            <button id="img2img_setmgr_new_btn">＋ Create</button>
                        </div>
                    </div>
                    <div class="img2img_setmgr_section">
                        <div class="img2img_setmgr_section_label" id="img2img_setmgr_active_label">Images</div>
                        <div id="img2img_setmgr_thumbs"></div>
                        <input type="file" id="img2img_setmgr_file_input" accept="image/*" multiple style="display:none;" />
                    </div>
                </div>
            </div>
        </div>
    `);

    $("body").append($overlay);

    // Close
    const close = () => $("#img2img_setmgr_overlay").remove();
    $("#img2img_setmgr_close").on("click", close);
    $("#img2img_setmgr_overlay").on("click", (e) => {
        if ($(e.target).is("#img2img_setmgr_overlay")) close();
    });

    // Create new set
    async function createNewSet() {
        const name = $("#img2img_setmgr_new_input").val().trim();
        if (!name) return;
        const rec = await loadRecordFromDB(charName);
        if (rec.sets[name]) { toastr.warning(`"${name}" already exists.`); return; }
        rec.sets[name] = [];
        rec.activeSet  = name;
        await saveRecordToDB(rec);
        $("#img2img_setmgr_new_input").val("");
        toastr.success(`Set "${name}" created.`);
        refreshWidgetState();
        renderGallery();
        renderSetMgr();
    }

    $("#img2img_setmgr_new_btn").on("click", createNewSet);
    $("#img2img_setmgr_new_input").on("keydown", (e) => {
        if (e.key === "Enter") createNewSet();
    });

    // File upload
    $("#img2img_setmgr_file_input").on("change", async function () {
        const files = Array.from(this.files);
        this.value = "";
        if (!files.length) return;
        const rec = await loadRecordFromDB(charName);
        const readFile = (file) => new Promise((res, rej) => {
            const r = new FileReader();
            r.onload  = (e) => res(e.target.result);
            r.onerror = rej;
            r.readAsDataURL(file);
        });
        for (const file of files) {
            if (!file.type.startsWith("image/")) continue;
            rec.sets[rec.activeSet].push(await readFile(file));
        }
        await saveRecordToDB(rec);
        renderGallery();
        renderSetMgr();
    });

    renderSetMgr();
}

// ── Gallery UI (settings panel) ───────────────────────────────────────────────

async function renderGallery() {
    const charName = getCurrentCharacterName();
    const $container = $("#img2img_gallery_container");
    $container.empty();

    if (!charName) {
        $container.append(`<p class="img2img_muted">No character selected — open a chat first.</p>`);
        return;
    }

    const record   = await loadRecordFromDB(charName);
    const setNames = Object.keys(record.sets);
    const activeSet = record.activeSet;

    // Per-character prefix/suffix
    $container.append(`<label class="img2img_section_label">Character Overrides <small style="font-weight:normal;color:#aaa;">(leave blank to use global)</small></label>`);
    const $overrides = $(`<div class="img2img_overrides"></div>`);
    $overrides.append(`
        <label style="font-size:.85em;">Prompt Prefix</label>
        <input type="text" id="img2img_char_prefix" class="text_pole"
               placeholder="Overrides global prefix for ${charName}"
               value="${record.char_prefix || ""}" />
        <label style="font-size:.85em;margin-top:6px;">Prompt Suffix</label>
        <input type="text" id="img2img_char_suffix" class="text_pole"
               placeholder="Overrides global suffix for ${charName}"
               value="${record.char_suffix || ""}" />
    `);
    $container.append($overrides);

    $("#img2img_char_prefix").on("input", async function () {
        const rec = await loadRecordFromDB(charName);
        rec.char_prefix = $(this).val();
        await saveRecordToDB(rec);
    });

    $("#img2img_char_suffix").on("input", async function () {
        const rec = await loadRecordFromDB(charName);
        rec.char_suffix = $(this).val();
        await saveRecordToDB(rec);
    });

    $container.append(`<hr style="margin:10px 0;"/>`);

    // Set selector
    $container.append(`<label class="img2img_section_label">Sets</label>`);
    const $setRow = $(`<div class="img2img_set_row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;"></div>`);
    const $setSelect = $(`<select class="text_pole img2img_set_select" style="flex:1;"></select>`);
    setNames.forEach(name => {
        const selected = name === activeSet ? "selected" : "";
        $setSelect.append(`<option value="${name}" ${selected}>${name} (${record.sets[name].length})</option>`);
    });
    const $upBtn     = $(`<button class="menu_button img2img_icon_btn" title="Move set up"   ${setNames.indexOf(activeSet) === 0 ? "disabled" : ""}>▲</button>`);
    const $downBtn   = $(`<button class="menu_button img2img_icon_btn" title="Move set down" ${setNames.indexOf(activeSet) === setNames.length - 1 ? "disabled" : ""}>▼</button>`);
    const $newBtn    = $(`<button class="menu_button img2img_icon_btn" title="New set">＋</button>`);
    const $renameBtn = $(`<button class="menu_button img2img_icon_btn" title="Rename set">✏️</button>`);
    const $deleteBtn = $(`<button class="menu_button img2img_icon_btn" title="Delete set" ${setNames.length <= 1 ? "disabled" : ""}>🗑️</button>`);
    $setRow.append($setSelect, $upBtn, $downBtn, $newBtn, $renameBtn, $deleteBtn);
    $container.append($setRow);

    // Image count + thumbnails
    const imgCount = record.sets[activeSet]?.length || 0;
    $container.append(`<small class="img2img_muted" style="display:block;margin:4px 0;">${imgCount} image${imgCount !== 1 ? "s" : ""} in this set.</small>`);

    const $gallery = $(`<div id="img2img_gallery"></div>`);
    $container.append($gallery);

    if (imgCount === 0) {
        $gallery.append(`<p class="img2img_empty">No images yet. Upload some below!</p>`);
    } else {
        record.sets[activeSet].forEach((dataUrl, index) => {
            const $thumb = $(`
                <div class="img2img_thumb">
                    <img src="${dataUrl}" title="Image ${index + 1}" />
                    <button class="img2img_delete_btn" data-index="${index}" title="Remove">✕</button>
                </div>
            `);
            $gallery.append($thumb);
        });
        $gallery.find(".img2img_delete_btn").on("click", async function () {
            const index = parseInt($(this).data("index"));
            const rec = await loadRecordFromDB(charName);
            rec.sets[rec.activeSet].splice(index, 1);
            await saveRecordToDB(rec);
            renderGallery();
        });
    }

    // Set controls
    $setSelect.on("change", async function () {
        const rec = await loadRecordFromDB(charName);
        rec.activeSet = $(this).val();
        await saveRecordToDB(rec);
        renderGallery();
        refreshWidgetState();
    });

    $upBtn.on("click", async () => {
        await moveSet(charName, activeSet, -1);
        renderGallery();
    });

    $downBtn.on("click", async () => {
        await moveSet(charName, activeSet, 1);
        renderGallery();
    });

    $newBtn.on("click", async () => {
        const name = prompt_input("Name for new set:", "New Set");
        if (!name?.trim()) return;
        const trimmed = name.trim();
        const rec = await loadRecordFromDB(charName);
        if (rec.sets[trimmed]) { toastr.warning(`A set named "${trimmed}" already exists.`); return; }
        rec.sets[trimmed] = [];
        rec.activeSet = trimmed;
        await saveRecordToDB(rec);
        toastr.success(`Set "${trimmed}" created.`);
        renderGallery();
        refreshWidgetState();
    });

    $renameBtn.on("click", async () => {
        const rec = await loadRecordFromDB(charName);
        const oldName = rec.activeSet;
        const newName = prompt_input("Rename set:", oldName);
        if (!newName?.trim() || newName.trim() === oldName) return;
        const trimmed = newName.trim();
        if (rec.sets[trimmed]) { toastr.warning(`A set named "${trimmed}" already exists.`); return; }
        rec.sets[trimmed] = rec.sets[oldName];
        delete rec.sets[oldName];
        rec.activeSet = trimmed;
        await saveRecordToDB(rec);
        toastr.success(`Set renamed to "${trimmed}".`);
        renderGallery();
        refreshWidgetState();
    });

    $deleteBtn.on("click", async () => {
        const rec = await loadRecordFromDB(charName);
        if (Object.keys(rec.sets).length <= 1) return;
        const toDelete = rec.activeSet;
        if (!confirm(`Delete set "${toDelete}" and all its images?`)) return;
        delete rec.sets[toDelete];
        rec.activeSet = Object.keys(rec.sets)[0];
        await saveRecordToDB(rec);
        toastr.success(`Set "${toDelete}" deleted.`);
        renderGallery();
        refreshWidgetState();
    });
}

function prompt_input(message, defaultValue) {
    return window.prompt(message, defaultValue);
}

// ── File upload ───────────────────────────────────────────────────────────────

async function handleImageUpload(files) {
    const charName = getCurrentCharacterName();
    if (!charName) { alert("Please open a character chat before uploading reference images."); return; }

    const record = await loadRecordFromDB(charName);
    const activeSet = record.activeSet;

    const readFile = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        record.sets[activeSet].push(await readFile(file));
    }

    await saveRecordToDB(record);
    console.log(`[Img2Img] Set "${activeSet}" saved. Total: ${record.sets[activeSet].length}`);
    renderGallery();
    refreshWidgetState();
}

// ── Settings panel ────────────────────────────────────────────────────────────

function renderSettingsPanel() {
    const settings = getSettings();
    const html = `
        <div id="img2img_settings">
            <h4>🖼️ Img2Img Reference Generator</h4>

            <label>NanoGPT API Key</label>
            <input type="password" id="img2img_api_key" class="text_pole"
                   placeholder="Paste your NanoGPT API key here" value="${settings.api_key}" />
            <small>Your key is stored locally and never shared.</small>

            <label style="margin-top:10px;">Model ID</label>
            <input type="text" id="img2img_model" class="text_pole"
                   placeholder="e.g. seedream-v4.5" value="${settings.model}" />
            <small>Find model IDs at <a href="https://nano-gpt.com/models" target="_blank">nano-gpt.com/models</a>.</small>

            <label style="margin-top:10px;">Image Size</label>
            <select id="img2img_size" class="text_pole"></select>
            <div id="img2img_custom_size" style="display:none;margin-top:6px;">
                <div style="display:flex;gap:8px;align-items:flex-end;">
                    <div style="flex:1;">
                        <label style="font-size:.85em;display:block;margin-bottom:2px;">Width (px)</label>
                        <input type="number" id="img2img_custom_w" class="text_pole" placeholder="e.g. 2048" min="1024" max="4096" />
                        <small>1024–4096</small>
                    </div>
                    <span style="font-size:1.3em;padding-bottom:18px;">×</span>
                    <div style="flex:1;">
                        <label style="font-size:.85em;display:block;margin-bottom:2px;">Height (px)</label>
                        <input type="number" id="img2img_custom_h" class="text_pole" placeholder="e.g. 3072" min="1024" max="4096" />
                        <small>1024–4096</small>
                    </div>
                </div>
                <small style="margin-top:4px;display:block;color:#aaa;">Tab or click away to apply.</small>
            </div>

            <hr />

            <label>Global Prompt Prefix</label>
            <input type="text" id="img2img_global_prefix" class="text_pole"
                   placeholder="e.g. Preserve all character details exactly as shown in the reference images."
                   value="${settings.global_prefix}" />
            <small>Prepended to every generation prompt sent to the image model. Per-character prefix overrides this when set.</small>

            <label style="margin-top:10px;">Global Prompt Suffix</label>
            <input type="text" id="img2img_global_suffix" class="text_pole"
                   placeholder="e.g. anime style, highly detailed, cinematic lighting"
                   value="${settings.global_suffix}" />
            <small>Appended to every generation prompt. Per-character suffix overrides this when set.</small>

            <hr />

            <label>Auto-Prompt Chat Model</label>
            <input type="text" id="img2img_auto_model" class="text_pole"
                   placeholder="e.g. gpt-4o-mini"
                   value="${settings.auto_prompt_model}" />
            <small>Model used to generate the image prompt from chat context. A fast, cheap model works well here.</small>

            <label style="margin-top:10px;">Context Messages</label>
            <input type="number" id="img2img_auto_context" class="text_pole"
                   min="1" max="50" value="${settings.auto_prompt_context_messages}" />
            <small>How many recent chat messages to include as scene context. 6–12 is usually enough.</small>

            <label style="margin-top:10px;">Auto-Prompt Template</label>
            <textarea id="img2img_auto_template" class="text_pole" rows="8"
                      placeholder="System instruction for the auto-prompt model."
            >${settings.auto_prompt_template}</textarea>
            <small>Sent as the system prompt when auto-generating from scene. The result fills the widget prompt box.</small>

            <div style="display:flex;align-items:center;gap:8px;margin-top:10px;">
                <input type="checkbox" id="img2img_auto_preview" ${settings.auto_prompt_preview ? "checked" : ""} />
                <label for="img2img_auto_preview" style="margin:0;cursor:pointer;">
                    Preview &amp; edit prompt before generating
                </label>
            </div>
            <small>When checked, /img2img with no prompt opens the widget with the auto-generated prompt pre-filled for editing. Ctrl+Enter to generate.</small>

            <hr />

            <div id="img2img_gallery_container"></div>

            <label class="img2img_upload_btn" for="img2img_upload_input" style="margin-top:8px;">
                ＋ Upload to Active Set
                <input type="file" id="img2img_upload_input" accept="image/*" multiple style="display:none;" />
            </label>

            <hr />
            <small>ℹ️ Seedream 4.5 supports up to 10 reference images per generation.</small><br/>
            <small>💡 <code>/img2img your prompt</code> — manual &nbsp;|&nbsp; <code>/img2img</code> — auto from scene &nbsp;|&nbsp; or use the floating widget.</small>
        </div>
    `;
    $("#extensions_settings").append(html);

    $("#img2img_api_key").on("input",    function () { getSettings().api_key        = $(this).val();        saveSettingsDebounced(); });
    $("#img2img_global_prefix").on("input", function () { getSettings().global_prefix  = $(this).val();        saveSettingsDebounced(); });
    $("#img2img_global_suffix").on("input", function () { getSettings().global_suffix  = $(this).val();        saveSettingsDebounced(); });
    $("#img2img_auto_model").on("input",    function () { getSettings().auto_prompt_model = $(this).val().trim(); saveSettingsDebounced(); });
    $("#img2img_auto_template").on("input", function () { getSettings().auto_prompt_template = $(this).val();   saveSettingsDebounced(); });

    $("#img2img_model").on("input", function () {
        const modelId = $(this).val().trim();
        getSettings().model = modelId;
        saveSettingsDebounced();
        updateSizeDropdown(modelId);
        refreshWidgetState();
    });

    $("#img2img_size").on("change", function () {
        const val = $(this).val();
        toggleCustomSizeInputs(val === "custom");
        if (val !== "custom") {
            getSettings().image_size = val;
            saveSettingsDebounced();
            refreshWidgetState();
        }
    });

    $("#img2img_custom_w, #img2img_custom_h").on("change", validateAndSaveCustomSize);

    $("#img2img_auto_context").on("change", function () {
        const val = parseInt($(this).val());
        if (val >= 1 && val <= 50) { getSettings().auto_prompt_context_messages = val; saveSettingsDebounced(); }
    });

    $("#img2img_auto_preview").on("change", function () {
        getSettings().auto_prompt_preview = $(this).is(":checked");
        saveSettingsDebounced();
    });

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
        refreshWidgetState();
    });
}

// ── Entry point ───────────────────────────────────────────────────────────────

jQuery(async () => {
    await openDatabase();
    loadSettings();
    renderSettingsPanel();
    createFloatingWidget();
    registerEvents();

    registerSlashCommand(
        "img2img",
        handleGenerateCommand,
        [],
        "Generate an image. /img2img [prompt] for manual, /img2img alone for auto-prompt from scene.",
        true,
        true
    );

    console.log("[Img2Img] Extension ready (v0.13.2). Floating widget active.");
});
