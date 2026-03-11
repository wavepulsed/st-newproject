// Img2Img Reference Generator for SillyTavern
// Version 0.1.0 — Skeleton / Step 1

import { extension_settings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "st-img2img";
const defaultSettings = {
    api_key: "",
    model: "seedream-4-5",
};

// Load or initialise settings
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(
        extension_settings[extensionName],
        { ...defaultSettings, ...extension_settings[extensionName] }
    );
}

// Build the settings panel HTML
function renderSettingsPanel() {
    const html = `
        <div id="img2img_settings">
            <h4>🖼️ Img2Img Reference Generator</h4>
            <label>NanoGPT API Key</label>
            <input type="password"
                   id="img2img_api_key"
                   class="text_pole"
                   placeholder="Paste your NanoGPT API key here"
                   value="${extension_settings[extensionName].api_key}" />
            <small>Your key is stored locally and never shared.</small>
        </div>
    `;
    $("#extensions_settings").append(html);

    // Save key when user types it in
    $("#img2img_api_key").on("input", function () {
        extension_settings[extensionName].api_key = $(this).val();
        saveSettingsDebounced();
    });
}

// Entry point — runs when ST loads the extension
jQuery(async () => {
    loadSettings();
    renderSettingsPanel();
    console.log("[Img2Img] Extension loaded successfully.");
});
