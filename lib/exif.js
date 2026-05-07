const fs = require('fs')
const path = require('path')
const webp = require('node-webpmux')

async function addExif(buffer, packname, author) {
    const img = new webp.Image()
    const json = { 
        "sticker-pack-id": `snow-md-${Date.now()}`, 
        "sticker-pack-name": packname || "𝚂𝙽𝙾𝚆-𝙼𝙳", 
        "sticker-pack-publisher": author || "𝙹𝙾𝙽-𝚂𝙽𝙾𝚆-𝚃𝙴𝙲𝙷", 
        "emojis": ["🚀", "🔥", "👾"] 
    }
    
    // Header EXIF standard pour WebP
    const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
    const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8")
    const exif = Buffer.concat([exifAttr, jsonBuff])
    exif.writeUIntLE(jsonBuff.length, 14, 4)
    
    await img.load(buffer)
    img.exif = exif
    return await img.save(null)
}

module.exports = { addExif }
