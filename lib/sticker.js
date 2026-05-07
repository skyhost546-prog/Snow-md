const fs = require("fs");
const { tmpdir } = require("os");
const crypto = require("crypto");
const path = require("path");

let webp = null;
let ffmpeg = null;
let ffmpegPathSet = false;

async function ensureTools() {
    if (!webp) {
        webp = require('node-webpmux');
    }
    if (!ffmpeg) {
        ffmpeg = require('fluent-ffmpeg');
    }
    if (!ffmpegPathSet) {
        try {
            const installer = require('@ffmpeg-installer/ffmpeg');
            const p = installer.path;
            if (p) ffmpeg.setFfmpegPath(p);
        } catch (e) { 
            // FFmpeg est peut-être déjà dans le PATH du système
        }
        ffmpegPathSet = true;
    }
}

class StickerBuilder {
    constructor() {
        this.tmp = tmpdir();
    }

    _tmp(ext) {
        return path.join(this.tmp, `${crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.${ext}`);
    }

    async toSticker(type, media, exif = null) {
        await ensureTools();
        const ext = type === "image" ? "jpg" : "mp4";
        const input = this._tmp(ext);
        const output = this._tmp("webp");

        fs.writeFileSync(input, media);

        await new Promise((resolve, reject) => {
            ffmpeg(input)
                .on("error", reject)
                .on("end", () => resolve(true))
                .addOutputOptions(
                    ext === "jpg"
                        ? ["-vcodec", "libwebp", "-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320,fps=15"]
                        : ["-vcodec", "libwebp", "-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320,fps=15", "-loop", "0", "-ss", "00:00:00", "-t", "00:00:05", "-preset", "default", "-an", "-vsync", "0"]
                )
                .toFormat("webp")
                .save(output);
        });

        const buffer = fs.readFileSync(output);
        fs.unlinkSync(input);
        fs.unlinkSync(output);

        return exif ? await this.addExif(buffer, exif) : buffer;
    }

    async circleImage(media) {
        await ensureTools();
        const input = this._tmp("png");
        const output = this._tmp("png");
        fs.writeFileSync(input, media);

        await new Promise((resolve, reject) => {
            ffmpeg(input)
                .on("error", reject)
                .on("end", () => resolve(true))
                .addOutputOptions(["-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320,format=rgba,geq='if((X-W/2)^2+(Y-H/2)^2>(min(W,H)/2)^2,0,255)':128:128:128"])
                .toFormat("png")
                .save(output);
        });

        const buffer = fs.readFileSync(output);
        fs.unlinkSync(input);
        fs.unlinkSync(output);
        return buffer;
    }

    async toCircleSticker(media, exif = null) {
        const circled = await this.circleImage(media);
        return await this.toSticker("image", circled, exif);
    }

    async addExif(webpSticker, info) {
        await ensureTools();
        const img = new webp.Image();
        const { packname, author } = info;

        const json = {
            "sticker-pack-id": crypto.randomBytes(16).toString('hex'),
            "sticker-pack-name": packname || "",
            "sticker-pack-publisher": author || "",
            emojis: ["🕷️"],
        };

        const exifAttr = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
        const jsonBuffer = Buffer.from(JSON.stringify(json), "utf8");
        const exif = Buffer.concat([exifAttr, jsonBuffer]);
        exif.writeUIntLE(jsonBuffer.length, 14, 4);

        await img.load(webpSticker);
        img.exif = exif;
        return await img.save(null);
    }
}

// On exporte l'instance pour require
module.exports = new StickerBuilder();
