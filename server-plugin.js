// Img2Img Reference Generator — Server Plugin
// Handles saving generated images to ST's local filesystem

import fs from "node:fs";
import path from "node:path";
import fetch from "node-fetch";

const SAVE_DIR = path.join(process.cwd(), "public", "user", "images");

export async function init(router) {
    // Make sure the save directory exists
    if (!fs.existsSync(SAVE_DIR)) {
        fs.mkdirSync(SAVE_DIR, { recursive: true });
    }

    // Endpoint: POST /api/plugins/img2img/save-image
    router.post("/save-image", async (req, res) => {
        try {
            const { imageUrl, characterName, prompt } = req.body;

            if (!imageUrl) {
                return res.status(400).json({ error: "No imageUrl provided" });
            }

            // Fetch the image from NanoGPT's CDN
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok) {
                throw new Error(`Failed to fetch image: ${imageResponse.status}`);
            }
            const buffer = await imageResponse.arrayBuffer();

            // Build a safe filename: charactername_timestamp.jpg
            const safeName = (characterName || "unknown")
                .replace(/[^a-zA-Z0-9_-]/g, "_")
                .substring(0, 40);
            const filename = `img2img_${safeName}_${Date.now()}.jpg`;
            const filepath = path.join(SAVE_DIR, filename);

            // Write to disk
            fs.writeFileSync(filepath, Buffer.from(buffer));
            console.log(`[Img2Img Server] Image saved: ${filename}`);

            // Return the public path ST can use to serve it
            res.json({
                success: true,
                filename,
                localPath: `/user/images/${filename}`,
            });
        } catch (err) {
            console.error("[Img2Img Server] Save failed:", err);
            res.status(500).json({ error: err.message });
        }
    });
}

export async function exit() {
    // Nothing to clean up
}

export const info = {
    id: "img2img",
    name: "Img2Img Reference Generator",
    description: "Saves generated images to local filesystem for persistence.",
};
