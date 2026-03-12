// Img2Img Reference Generator for SillyTavern
// Version 0.12.0 — Direct NanoGPT chat for auto-prompt (no ST context bleed)

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, saveChatDebounced, addOneMessage } from "../../../../script.js";
import { registerSlashCommand } from "../../../slash-commands.js";
import { saveBase64AsFile } from "../../../../scripts/utils.js";

const extensionName = "st-img2img";
const NANO_API_URL  = "https://nano-gpt.com/api/v1/images/generations";
const NANO_CHAT_URL = "https://nano-gpt.com/api/v1/chat/completions";
const DB_NAME = "img2img_gallery_db";
const DB_VERSION = 4;
const STORE_NAME = "galleries";
const DEFAULT_SET = "Default";

const DEFAULT_AUTO_PROMPT_TEMPLATE =
`You are an image prompt generator. Your entire output must be a single image generation prompt — nothing else.

Rules:
- Do NOT use any character names. Describe every person purely by their physical appearance: hair colour and style, eye colour, build, clothing, expression, and pose.
- Any characters not covered by uploaded reference images must be described in full visual detail.
- Describe the environment: location, lighting, time of day, atmosphere, mood.
- Include composition feel where relevant: close-up, wide shot, dynamic angle, etc.
- No narration, no dialogue, no explanation, no preamble, no sign-off.
- Output the prompt only. One paragraph. No bullet points.`;

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
                if (migrated > 0) {
                    console.log(`[Img2Img] Migrated ${migrated} record(s) to v4 schema.`);
                }
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
                // Ensure prefix/suffix fields exist on old records
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
        if (record.char_prefix && record.char_prefix.trim()) {
            return record.char_prefix.trim();
        }
    }
    return getSettings().global_prefix.trim();
}

async function getEffectiveSuffix(charName) {
    if (charName) {
        const record = await loadRecordFromDB(charName);
        if (record.char_suffix && record.char_suffix.trim()) {
            return record.char_suffix.trim();
        }
    }
    return getSettings().global_suffix.trim();
}

function assemblePrompt(corePrompt, prefix, suffix) {
    return [prefix, corePrompt, suffix]
        .map(s => s.trim())
        .filter(Boolean)
        .join(", ");
}

// Strip common AI preamble patterns from auto-generated prompts
function stripPreamble(text) {
    return text
        .replace(/^(here(?:'s| is)(?: your| the| an?)?(?: image)?(?: generation)?(?: prompt)?[:\-–—]*\s*)/i, "")
        .replace(/^(image(?: generation)? prompt[:\-–—]*\s*)/i, "")
        .replace(/^(prompt[:\-–—]*\s*)/i, "")
        .replace(/^["']|["']$/g, "")  // strip wrapping quotes
        .trim();
}

// ── Auto-prompt from chat context ─────────────────────────────────────────────

function buildChatContext(numMessages) {
    const context = getContext();
    const chat = context?.chat || [];

    // Filter out:
    //   - our own injected image messages
    //   - slash command invocations (user messages starting with /)
    //   - empty messages
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
        const text = (m.mes || "").trim();
        return `${speaker}: ${text}`;
    });

    console.log(`[Img2Img] Auto-prompt context (${recent.length} messages):\n` + lines.join("\n---\n"));

    return lines.join("\n");
}

async function generateAutoPrompt() {
    const settings = getSettings();
    const template  = settings.auto_prompt_template || DEFAULT_AUTO_PROMPT_TEMPLATE;
    const chatModel = settings.auto_prompt_model    || "gpt-4o-mini";
    const numMsgs   = settings.auto_prompt_context_messages ?? 10;

    if (!settings.api_key) {
        throw new Error("No API key set — cannot generate auto-prompt.");
    }

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
            body: JSON.stringify({
                model: chatModel,
                messages,
                max_tokens: 400,
                temperature: 0.4,
            }),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`NanoGPT chat API error ${response.status}: ${err}`);
        }

        const data = await response.json();
        const raw  = data?.choices?.[0]?.message?.content;

        if (!raw || !raw.trim()) {
            throw new Error("Empty response from chat model.");
        }

        return stripPreamble(raw);
    } catch (err) {
        throw new Error(`Auto-prompt failed: ${err.message}`);
    }
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function showPromptModal(initialPrompt, onConfirm) {
    // Remove any existing modal first
    $("#img2img_modal_overlay").remove();

    const $overlay = $(`
        <div id="img2img_modal_overlay">
            <div id="img2img_modal">
                <div id="img2img_modal_header">
                    <span>🖼️ Edit Image Prompt</span>
                    <button id="img2img_modal_close" title="Cancel">✕</button>
                </div>
                <textarea id="img2img_modal_prompt" rows="5">${initialPrompt}</textarea>
                <div id="img2img_modal_footer">
                    <button id="img2img_modal_cancel" class="menu_button">Cancel</button>
                    <button id="img2img_modal_generate" class="menu_button menu_button_primary">Generate</button>
                </div>
            </div>
        </div>
    `);

    $("body").append($overlay);

    // Focus and select all text for quick editing
    const $textarea = $("#img2img_modal_prompt");
    $textarea.focus().select();

    const closeModal = () => $("#img2img_modal_overlay").remove();

    $("#img2img_modal_close, #img2img_modal_cancel").on("click", closeModal);

    $("#img2img_modal_overlay").on("click", function (e) {
        if ($(e.target).is("#img2img_modal_overlay")) closeModal();
    });

    $("#img2img_modal_generate").on("click", () => {
        const prompt = $textarea.val().trim();
        if (!prompt) {
            toastr.warning("Prompt cannot be empty.");
            return;
        }
        closeModal();
        onConfirm(prompt);
    });

    // Ctrl+Enter to generate
    $textarea.on("keydown", (e) => {
        if (e.ctrlKey && e.key === "Enter") {
            $("#img2img_modal_generate").trigger("click");
        }
    });
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

// ── Image fetch + save ────────────────────────────────────────────────────────

async function fetchAndSaveImage(remoteUrl, characterName) {
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

async function generateImage(finalPrompt) {
    const settings = getSettings();

    if (!settings.api_key) {
        throw new Error("No API key set. Please add your NanoGPT key in the extension settings.");
    }

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

// ── Main command handler ──────────────────────────────────────────────────────

async function handleGenerateCommand(namedArgs, unnamedValue) {
    const manualPrompt = (unnamedValue || namedArgs?.value || "").trim();
    const settings = getSettings();

    if (manualPrompt) {
        // Manual prompt provided — use it directly
        await runGeneration(manualPrompt);
        return;
    }

    // No prompt — use auto-prompt from chat context
    let autoPrompt;
    try {
        autoPrompt = await generateAutoPrompt();
    } catch (err) {
        toastr.error(err.message);
        return;
    }

    if (settings.auto_prompt_preview) {
        // Show modal for editing before generating
        showPromptModal(autoPrompt, (editedPrompt) => {
            runGeneration(editedPrompt);
        });
    } else {
        // Fire immediately
        await runGeneration(autoPrompt);
    }
}

// ── Gallery UI ────────────────────────────────────────────────────────────────

async function renderGallery() {
    const charName = getCurrentCharacterName();
    const $container = $("#img2img_gallery_container");
    $container.empty();

    if (!charName) {
        $container.append(`<p class="img2img_muted">No character selected — open a chat first.</p>`);
        return;
    }

    const record = await loadRecordFromDB(charName);
    const setNames = Object.keys(record.sets);
    const activeSet = record.activeSet;

    // ── Per-character prefix/suffix ──
    $container.append(`<label class="img2img_section_label">Character Overrides <small style="font-weight:normal; color:#aaa;">(leave blank to use global)</small></label>`);

    const $overrides = $(`<div class="img2img_overrides"></div>`);
    $overrides.append(`
        <label style="font-size:0.85em;">Prompt Prefix</label>
        <input type="text" id="img2img_char_prefix" class="text_pole"
               placeholder="Overrides global prefix for ${charName}"
               value="${record.char_prefix || ""}" />
        <label style="font-size:0.85em; margin-top:6px;">Prompt Suffix</label>
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

    // ── Set selector row ──
    $container.append(`<label class="img2img_section_label">Sets</label>`);
    const $setRow = $(`<div class="img2img_set_row" style="display:flex; flex-direction:row; align-items:center; gap:6px; flex-wrap:wrap;"></div>`);

    const $setSelect = $(`<select class="text_pole img2img_set_select" style="flex:1;"></select>`);
    setNames.forEach(name => {
        const selected = name === activeSet ? "selected" : "";
        $setSelect.append(`<option value="${name}" ${selected}>${name} (${record.sets[name].length})</option>`);
    });

    const $newBtn    = $(`<button class="menu_button img2img_icon_btn" title="New set">＋</button>`);
    const $renameBtn = $(`<button class="menu_button img2img_icon_btn" title="Rename set">✏️</button>`);
    const $deleteBtn = $(`<button class="menu_button img2img_icon_btn" title="Delete set" ${setNames.length <= 1 ? "disabled" : ""}>🗑️</button>`);

    $setRow.append($setSelect, $newBtn, $renameBtn, $deleteBtn);
    $container.append($setRow);

    // ── Image count + thumbnails ──
    const imgCount = record.sets[activeSet]?.length || 0;
    $container.append(`<small class="img2img_muted" style="display:block; margin:4px 0;">${imgCount} image${imgCount !== 1 ? "s" : ""} in this set.</small>`);

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

    // ── Set controls ──
    $setSelect.on("change", async function () {
        const rec = await loadRecordFromDB(charName);
        rec.activeSet = $(this).val();
        await saveRecordToDB(rec);
        renderGallery();
    });

    $newBtn.on("click", async () => {
        const name = prompt_input("Name for new set:", "New Set");
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        const rec = await loadRecordFromDB(charName);
        if (rec.sets[trimmed]) { toastr.warning(`A set named "${trimmed}" already exists.`); return; }
        rec.sets[trimmed] = [];
        rec.activeSet = trimmed;
        await saveRecordToDB(rec);
        toastr.success(`Set "${trimmed}" created.`);
        renderGallery();
    });

    $renameBtn.on("click", async () => {
        const rec = await loadRecordFromDB(charName);
        const oldName = rec.activeSet;
        const newName = prompt_input("Rename set:", oldName);
        if (!newName || !newName.trim() || newName.trim() === oldName) return;
        const trimmed = newName.trim();
        if (rec.sets[trimmed]) { toastr.warning(`A set named "${trimmed}" already exists.`); return; }
        rec.sets[trimmed] = rec.sets[oldName];
        delete rec.sets[oldName];
        rec.activeSet = trimmed;
        await saveRecordToDB(rec);
        toastr.success(`Set renamed to "${trimmed}".`);
        renderGallery();
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
    });
}

function prompt_input(message, defaultValue) {
    return window.prompt(message, defaultValue);
}

// ── File upload ───────────────────────────────────────────────────────────────

async function handleImageUpload(files) {
    const charName = getCurrentCharacterName();
    if (!charName) {
        alert("Please open a character chat before uploading reference images.");
        return;
    }

    const record = await loadRecordFromDB(charName);
    const activeSet = record.activeSet;

    const readFile = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    for (const file of files) {
        if (!file.type.startsWith("image/")) continue;
        const dataUrl = await readFile(file);
        record.sets[activeSet].push(dataUrl);
    }

    await saveRecordToDB(record);
    console.log(`[Img2Img] Set "${activeSet}" saved. Total: ${record.sets[activeSet].length}`);
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
            <small>Find model IDs at <a href="https://nano-gpt.com/models" target="_blank">nano-gpt.com/models</a>.</small>

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

            <label>Global Prompt Prefix</label>
            <input type="text"
                   id="img2img_global_prefix"
                   class="text_pole"
                   placeholder="e.g. Change nothing about the character's appearance."
                   value="${settings.global_prefix}" />
            <small>Prepended to every generation. Per-character prefix overrides this when set.</small>

            <label style="margin-top:10px;">Global Prompt Suffix</label>
            <input type="text"
                   id="img2img_global_suffix"
                   class="text_pole"
                   placeholder="e.g. anime style, high quality, detailed"
                   value="${settings.global_suffix}" />
            <small>Appended to every generation. Per-character suffix overrides this when set.</small>

            <hr />

            <label>Auto-Prompt Chat Model</label>
            <input type="text"
                   id="img2img_auto_model"
                   class="text_pole"
                   placeholder="e.g. gpt-4o-mini, claude-haiku-4-5-20251001"
                   value="${settings.auto_prompt_model}" />
            <small>The model used <em>only</em> for generating the image prompt — separate from your main chat model. Uses your NanoGPT key. A fast, cheap model like gpt-4o-mini works well here.</small>

            <label style="margin-top:10px;">Context Messages</label>
            <input type="number"
                   id="img2img_auto_context"
                   class="text_pole"
                   min="1" max="50"
                   value="${settings.auto_prompt_context_messages}" />
            <small>How many recent chat messages to send as scene context. 6–12 is usually enough.</small>

            <label style="margin-top:10px;">Auto-Prompt Template</label>
            <textarea id="img2img_auto_template"
                      class="text_pole"
                      rows="6"
                      placeholder="System instruction for the auto-prompt model."
            >${settings.auto_prompt_template}</textarea>
            <small>Sent as the system prompt to your auto-prompt model. It receives this + the last N chat messages as context.</small>

            <div style="display:flex; align-items:center; gap:8px; margin-top:10px;">
                <input type="checkbox"
                       id="img2img_auto_preview"
                       ${settings.auto_prompt_preview ? "checked" : ""} />
                <label for="img2img_auto_preview" style="margin:0; cursor:pointer;">
                    Preview &amp; edit prompt before generating
                </label>
            </div>
            <small>When checked, /img2img with no prompt shows an editable popup before generating. Ctrl+Enter to confirm.</small>

            <hr />

            <div id="img2img_gallery_container"></div>

            <label class="img2img_upload_btn" for="img2img_upload_input" style="margin-top:8px;">
                ＋ Upload to Active Set
                <input type="file"
                       id="img2img_upload_input"
                       accept="image/*"
                       multiple
                       style="display:none;" />
            </label>

            <hr />
            <small>ℹ️ Seedream 4.5 supports up to 10 reference images. Check your model's docs for its specific limit.</small>
            <br/>
            <small>💡 <code>/img2img your prompt</code> — manual prompt &nbsp;|&nbsp; <code>/img2img</code> — auto-generate from scene</small>
        </div>
    `;
    $("#extensions_settings").append(html);

    $("#img2img_api_key").on("input", function () {
        getSettings().api_key = $(this).val();
        saveSettingsDebounced();
    });

    $("#img2img_model").on("input", function () {
        const modelId = $(this).val().trim();
        getSettings().model = modelId;
        saveSettingsDebounced();
        updateSizeDropdown(modelId);
    });

    $("#img2img_size").on("change", function () {
        const val = $(this).val();
        toggleCustomSizeInputs(val === "custom");
        if (val !== "custom") {
            getSettings().image_size = val;
            saveSettingsDebounced();
        }
    });

    $("#img2img_custom_w, #img2img_custom_h").on("change", validateAndSaveCustomSize);

    $("#img2img_global_prefix").on("input", function () {
        getSettings().global_prefix = $(this).val();
        saveSettingsDebounced();
    });

    $("#img2img_global_suffix").on("input", function () {
        getSettings().global_suffix = $(this).val();
        saveSettingsDebounced();
    });

    $("#img2img_auto_model").on("input", function () {
        getSettings().auto_prompt_model = $(this).val().trim();
        saveSettingsDebounced();
    });

    $("#img2img_auto_context").on("change", function () {
        const val = parseInt($(this).val());
        if (val >= 1 && val <= 50) {
            getSettings().auto_prompt_context_messages = val;
            saveSettingsDebounced();
        }
    });

    $("#img2img_auto_template").on("input", function () {
        getSettings().auto_prompt_template = $(this).val();
        saveSettingsDebounced();
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
        "Generate an image. With a prompt: /img2img girl in a forest. Without: /img2img auto-generates from the current scene.",
        true,
        true
    );

    console.log("[Img2Img] Extension ready (v0.12.1). /img2img [prompt] or /img2img for auto-prompt.");
});
