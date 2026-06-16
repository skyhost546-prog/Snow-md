process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err)
})

process.on('unhandledRejection', (err) => {
  console.error('❌ unhandledRejection:', err)
})

const express = require('express');
const router = express.Router();
const { 
    default: makeWASocket, 
    DisconnectReason, 
    makeCacheableSignalKeyStore, 
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { sms } = require('./smsg');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const mongoose = require('mongoose');

// ============================================================
// 🍃 AUTH STATE MONGODB (sessions persistantes)
// ============================================================
const { useMongoDBAuthState, getRegisteredSessions } = require('./MongoDB.js');

// Schema session status
const SessionSchema = new mongoose.Schema({
    _id:         String,
    number:      String,
    botId:       String,
    phoneNumber: String,
    status:      { type: String, default: 'connected' },
    connectedAt: Date,
    updatedAt:   Date,
    createdAt:   { type: Date, default: Date.now }
}, { strict: false });

const Session = mongoose.models.Session || mongoose.model('Session', SessionSchema);

async function saveSessionToMongo(num, sock) {
    try {
        const botId = sock.user?.id || null;
        const phoneNumber = botId ? botId.split(':')[0] : num;
        await Session.findOneAndUpdate(
            { _id: num },
            { _id: num, number: num, botId, phoneNumber, status: 'connected', connectedAt: new Date(), updatedAt: new Date() },
            { upsert: true, new: true }
        );
        console.log(`[MongoDB] ✅ Session ${num} enregistrée.`);
    } catch (err) {
        console.error(`[MongoDB] ❌ Erreur saveSession(${num}):`, err.message);
    }
}

async function markSessionDisconnected(num) {
    try {
        await Session.findOneAndUpdate({ _id: num }, { status: 'disconnected', updatedAt: new Date() });
    } catch (err) {
        console.error(`[MongoDB] ❌ Erreur markDisconnected(${num}):`, err.message);
    }
}
// ============================================================

const spiderHandler = require('./spider');

function toSmallCaps(text) {
    if (!text) return '';
    const normal = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const small  = "ᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ0123456789";
    return text.toString().split('').map(c => {
        const i = normal.indexOf(c);
        return i !== -1 ? small[i] : c;
    }).join('');
}

// Map: num -> socket actif
const sessions = {};

// Map: num -> { retries, backoffMs }
const reconnectState = {};

const MAX_RETRIES = 5;
const BASE_BACKOFF = 5000;    // 5s
const MAX_BACKOFF  = 120000;  // 2min max

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ============================================================
// CALCUL BACKOFF EXPONENTIEL avec jitter
// ============================================================
function getBackoff(num) {
    const s = reconnectState[num] || { retries: 0, backoffMs: BASE_BACKOFF };
    const jitter = Math.random() * 2000;
    const ms = Math.min(s.backoffMs * Math.pow(2, s.retries), MAX_BACKOFF) + jitter;
    return Math.round(ms);
}

function resetReconnect(num) {
    reconnectState[num] = { retries: 0, backoffMs: BASE_BACKOFF };
}

function incrementReconnect(num) {
    if (!reconnectState[num]) reconnectState[num] = { retries: 0, backoffMs: BASE_BACKOFF };
    reconnectState[num].retries = Math.min(reconnectState[num].retries + 1, MAX_RETRIES);
}

// ============================================================
// ANTI-CALL
// ============================================================
async function setupCallHandlers(sock, num) {
    sock.ev.on('call', async (node) => {
        const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
        const config = spiderHandler.sessionsConfig[botId];
        if (!config || config.anticall !== 'on') return;
        for (let call of node) {
            if (call.status === 'offer') {
                await sock.rejectCall(call.id, call.from);
                const isGroupCall = call.isGroup;
                await sock.sendMessage(call.from, {
                    text: isGroupCall
                        ? `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│ *ɢʀᴏᴜᴘ ᴀɴᴛɪ-ᴄᴀʟʟ*\n│⚠️ *${toSmallCaps("group call rejected")}*\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n> Hello, group calls are strictly prohibited for this bot.`
                        : `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│ *ᴀɴᴛɪ-ᴄᴀʟʟ sʏsᴛᴇᴍ*\n│🚫 *${toSmallCaps("call rejected")}*\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n> Hello @${call.from.split('@')[0]}, private calls are not allowed.`,
                    mentions: [call.from]
                });
            }
        }
    });
}

// ============================================================
// DÉMARRAGE D'UNE SESSION
// ============================================================
async function startIndependentBot(num) {
    // Nettoyage socket mort
    if (sessions[num] && !sessions[num].ws?.isOpen) {
        delete sessions[num];
    }
    if (sessions[num]?.ws?.isOpen) {
        return "ALREADY_CONNECTED";
    }

    // Lock anti-race
    const lockKey = `connecting_${num}`;
    if (global[lockKey]) return "CONNECTION_IN_PROGRESS";
    global[lockKey] = true;

    try {
        // ✅ AUTH STATE DEPUIS MONGODB (pas des fichiers locaux !)
        const { state, saveCreds, removeSession } = await useMongoDBAuthState(num);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            logger: pino({ level: 'fatal' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            printQRInTerminal: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 25000,   // ✅ Keepalive actif
            retryRequestDelayMs: 2000,
        });

        sessions[num] = sock;
        setupCallHandlers(sock, num);
        sock.ev.on('creds.update', saveCreds);

        // ============================================================
        // GESTION CONNEXION / DÉCONNEXION
        // ============================================================
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                resetReconnect(num);
                await saveSessionToMongo(num, sock);

                // Auto-follow canal
                try {
                    const newsletterIds = ['120363408257384131@newsletter'];
                    for (const nid of newsletterIds) {
                        await sock.newsletterFollow(nid);
                        await delay(2000);
                    }
                } catch (e) {}

                // Message de connexion
                try {
                    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    spiderHandler.initSession(botId);
                    const conf = spiderHandler.sessionsConfig[botId];
                    const imagePath = './menu.jpg';
                    const con = `*╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ*\n*│ 𝚂𝙽𝙾𝚆-𝙼𝙳 𝙲𝙾𝙽𝙽𝙴𝙲𝚃𝙴𝙳*\n*│ 🔗 𝚂𝚃𝙰𝚃𝚄𝚂 : 𝙲𝙾𝙽𝙽𝙴𝙲𝚃𝙴𝙳 ✓*\n*│ 🏷️ 𝙿𝚁𝙴𝙵𝙸𝚇 : [ ${conf?.prefix} ]*\n*│  🚀 𝙼𝙾𝙳𝙴 : ${conf?.mode}*\n*╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ*\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝙹𝙾𝙽 𝚂𝙽𝙾𝚆 ᴛᴇᴄʜ*`;
                    await sock.sendMessage(botId, {
                        image: fs.readFileSync(imagePath),
                        caption: con,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: '120363408257384131@newsletter',
                                newsletterName: '𝚂𝙽𝙾𝚆-𝙼𝙳',
                                serverMessageId: 125
                            },
                            externalAdReply: {
                                title: "𝚂𝙽𝙾𝚆-𝙼𝙳 ᴄᴏɴɴᴇᴄᴛᴇᴅ",
                                body: "ʙᴏᴛ ʙʏ 𝙹𝙾𝙽 𝚂𝙽𝙾𝚆 ᴛᴇᴄʜ",
                                thumbnail: fs.readFileSync(imagePath),
                                sourceUrl: "https://whatsapp.com/channel/0029VbCQ9Mh1noz48V9wET2D",
                                mediaType: 1,
                                renderLargerThumbnail: false
                            }
                        }
                    });
                } catch (e) {
                    console.error(`[Session ${num}] Erreur message connexion:`, e.message);
                }
            }

            if (connection === 'close') {
                const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || '';
                console.log(`[Session ${num}] Fermée. Code: ${statusCode} | Raison: ${reason}`);

                await markSessionDisconnected(num);
                delete sessions[num];

                // ✅ Logique déconnexion précise :
                // 401 = loggedOut (bad MAC / session révoquée par l'utilisateur)
                // 428 = connexion remplacée sur un autre appareil
                // 440 = multi-device conflict

                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isBadMAC   = reason.toLowerCase().includes('bad mac') 
                                || reason.toLowerCase().includes('badmac')
                                || statusCode === 401;

                if (isLoggedOut || isBadMAC) {
                    // Session révoquée → supprimer de MongoDB + ne pas reconnecter
                    console.log(`[Session ${num}] ⚠️ Session révoquée (loggedOut/badMAC). Suppression.`);
                    await markSessionDisconnected(num);
                    await removeSession(); // Supprime les clés Auth de MongoDB
                    resetReconnect(num);
                    return;
                }

                // Toute autre déconnexion → reconnecter avec backoff
                incrementReconnect(num);
                const backoff = getBackoff(num);
                console.log(`[Session ${num}] 🔄 Reconnexion dans ${Math.round(backoff/1000)}s...`);
                setTimeout(() => startIndependentBot(num).catch(() => {}), backoff);
            }
        });

        // ============================================================
        // EVENTS GROUPES, MESSAGES, ETC.
        // ============================================================
        sock.ev.on('group-participants.update', async (update) => {
            const { id, participants, action, author } = update;
            const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const config = spiderHandler.sessionsConfig[botId];
            if (!config) return;
            try {
                const metadata = await sock.groupMetadata(id);
                const groupName = metadata.subject;
                const groupDesc = metadata.desc || 'No description';
                const groupOwner = metadata.owner || id.split('-')[0] + '@s.whatsapp.net';
                const creationDate = new Date(metadata.creation * 1000).toLocaleString('en-US', { dateStyle: 'full' });
                let groupLink = 'Unknown';
                try { groupLink = 'https://chat.whatsapp.com/' + await sock.groupInviteCode(id); } catch (e) { groupLink = 'Restricted'; }

                for (let jid of participants) {
                    const userTag = `@${jid.split('@')[0]}`;
                    const authorTag = author ? `@${author.split('@')[0]}` : 'System';

                    if (config.adminevents === 'on') {
                        if (action === 'promote') {
                            await sock.sendMessage(id, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│🪭 *ʙᴏᴛ ɴᴀᴍᴇ 𝚂𝙽𝙾𝚆-𝙼𝙳*\n│👦🏻 *ʙʏ 𝙹𝙾𝙽 𝚂𝙽𝙾𝚆 ᴛᴇᴄʜ*\n│✨ *${toSmallCaps("admin event")}*\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\nUser ${authorTag} has promoted ${userTag}`, mentions: [author, jid].filter(Boolean) });
                        } else if (action === 'demote') {
                            await sock.sendMessage(id, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│🪭 *ʙᴏᴛ ɴᴀᴍᴇ 𝚂𝙽𝙾𝚆-𝙼𝙳*\n│👦🏻 *ʙʏ 𝙹𝙾𝙽 𝚂𝙽𝙾𝚆 ᴛᴇᴄʜ*\n│⚠️ *${toSmallCaps("admin event")}*\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\nUser ${authorTag} has demoted ${userTag}`, mentions: [author, jid].filter(Boolean) });
                        }
                    }

                    if (config.welcome === 'on') {
                        if (action === 'add') {
                            await sock.sendMessage(id, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│🪭 *ʙᴏᴛ ɴᴀᴍᴇ 𝚂𝙽𝙾𝚆-𝙼𝙳*\n│👦🏻 *ʙʏ 𝙹𝙾𝙽 𝚂𝙽𝙾𝚆 ᴛᴇᴄʜ*\n│ 🇱🇷 *${toSmallCaps("welcome")}*\n│ 👋 *${toSmallCaps("hello")}* ${userTag}\n│ 🏰 *${toSmallCaps("name group")}* : ${groupName}\n│ 📅 *${toSmallCaps("created at")}* : ${creationDate}\n│ 👑 *${toSmallCaps("created by")}* : @${groupOwner.split('@')[0]}\n│ 🔗 *${toSmallCaps("link group")}* : ${groupLink}\n│ 📝 *${toSmallCaps("description")}* :\n│ ${groupDesc}\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ`.trim(), mentions: [jid, groupOwner] });
                        } else if (action === 'remove') {
                            await sock.sendMessage(id, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│🪭 *ʙᴏᴛ ɴᴀᴍᴇ 𝚂𝙽𝙾𝚆-𝙼𝙳*\n│👦🏻 *ʙʏ 𝙹𝙾𝙽 𝚂𝙽𝙾𝚆 ᴛᴇᴄʜ*\n│ 🇱🇷 *${toSmallCaps("goodbye")}*\n│ 🚫 *${toSmallCaps("user left")}* : ${userTag}\n│ 🏰 *${toSmallCaps("from")}* : ${groupName}\n│ 📅 *${toSmallCaps("left at")}* : ${new Date().toLocaleString()}\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ`.trim(), mentions: [jid] });
                        }
                    }
                }
            } catch (e) {
                console.error("[You Error] Group Update Logic:", e);
            }
        });

        sock.ev.on('messages.upsert', async (chatUpdate) => {
            const m = chatUpdate.messages[0];
            if (!m || !m.message) return;

            const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const botNumber = sock.user.id.split(':')[0];
            const config = spiderHandler.sessionsConfig[botId];

            // Auto-react newsletter
            const nslett = ["120363408257384131@newsletter"];
            const emojiList = ["❤️", "👍", "🪭", "🍂", "🪻", "💚", "💜", "🍁"];
            if (m.key && nslett.includes(m.key.remoteJid)) {
                try {
                    const serverId = m.newsletterServerId || m.message?.newsletterServerId;
                    if (serverId) {
                        const randomEmoji = emojiList[Math.floor(Math.random() * emojiList.length)];
                        setTimeout(async () => {
                            try { await sock.newsletterReactMessage(m.key.remoteJid, serverId.toString(), randomEmoji); } catch (e) {}
                        }, 3000);
                    }
                } catch (e) {}
            }

            // Auto recording
            if (config && config.autorecording === 'on' && !m.key.fromMe) {
                try {
                    await sock.sendPresenceUpdate('recording', m.key.remoteJid);
                    setTimeout(async () => { try { await sock.sendPresenceUpdate('paused', m.key.remoteJid); } catch (e) {} }, 4000);
                } catch (e) {}
            }

            // Auto typing
            if (config && config.autotyping === 'on' && !m.key.fromMe) {
                try {
                    await sock.sendPresenceUpdate('composing', m.key.remoteJid);
                    setTimeout(async () => { try { await sock.sendPresenceUpdate('paused', m.key.remoteJid); } catch (e) {} }, 5000);
                } catch (e) {}
            }

            // Status auto-view / auto-like
            if (m.key.remoteJid === 'status@broadcast') {
                if (config && config.statusview === 'on') {
                    try {
                        await sock.readMessages([m.key]);
                        if (config.autolikestatus === 'on') {
                            const emojis = config.likestatuemoji || ['🖤', '🍬', '💫', '🎈', '💚'];
                            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                            let retries = parseInt(config.maxtries) || 5;
                            const reactStatus = async (attempt) => {
                                try {
                                    await sock.sendMessage(m.key.remoteJid, { react: { text: randomEmoji, key: m.key } }, { statusJidList: [m.key.participant] });
                                } catch (err) {
                                    if (attempt > 0) { await delay(2000); return reactStatus(attempt - 1); }
                                }
                            };
                            setTimeout(() => reactStatus(retries), 3000);
                        }
                    } catch (e) {}
                }
                return;
            }

            const groupJid = m.key.remoteJid;
            const isGroup = groupJid.endsWith('@g.us');
            const sender = m.key.participant || m.key.remoteJid;

            // Auto-react
            if (config && config.autoreact && config.autoreact !== 'off' && !m.key.fromMe) {
                let shouldReact = config.autoreact === 'all' || (config.autoreact === 'group' && isGroup) || (config.autoreact === 'chat' && !isGroup);
                if (shouldReact) {
                    const emojis = ['🍂', '🪭', '✨', '⚡', '🔥', '💎', '👾', '🌀'];
                    try { await sock.sendMessage(groupJid, { react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: m.key } }); } catch (e) {}
                }
            }

            // Antilink
            const antilinkPath = './antilink.json';
            const warnPath = './warns_antilink.json';
            if (isGroup && fs.existsSync(antilinkPath)) {
                try {
                    const antilinkData = JSON.parse(fs.readFileSync(antilinkPath, 'utf8'));
                    const mode = antilinkData[botNumber] ? antilinkData[botNumber][groupJid] : null;
                    if (mode) {
                        const body = m.message.conversation || m.message.extendedTextMessage?.text || "";
                        const linkPattern = /chat.whatsapp.com\/|https?:\/\//i;
                        if (linkPattern.test(body)) {
                            const groupMetadata = await sock.groupMetadata(groupJid);
                            const admins = groupMetadata.participants.filter(p => p.admin !== null).map(p => p.id);
                            if (admins.includes(sender)) return await spiderHandler.handleMessages(sock, chatUpdate);
                            await sock.sendMessage(groupJid, { delete: m.key });
                            if (mode === 'delete') {
                                await sock.sendMessage(groupJid, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│🚫 *${toSmallCaps("antilink")}* (Mode Delete)\n│ @${sender.split('@')[0]} ${toSmallCaps("les liens sont interdits ici !")}\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ`, mentions: [sender] });
                            } else if (mode === 'kick') {
                                await sock.sendMessage(groupJid, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│ 🚫 *${toSmallCaps("antilink")}* (Mode Kick)\n│ @${sender.split('@')[0]} ${toSmallCaps("pas de pitie. adieu !")}\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ`, mentions: [sender] });
                                await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                            } else if (mode === 'warn') {
                                if (!fs.existsSync(warnPath)) fs.writeFileSync(warnPath, JSON.stringify({}));
                                let warnData = JSON.parse(fs.readFileSync(warnPath, 'utf8'));
                                if (!warnData[groupJid]) warnData[groupJid] = {};
                                warnData[groupJid][sender] = (warnData[groupJid][sender] || 0) + 1;
                                const count = warnData[groupJid][sender];
                                if (count >= 3) {
                                    await sock.sendMessage(groupJid, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│🚫 *${toSmallCaps("antilink warn")}*\n│ @${sender.split('@')[0]} ${toSmallCaps("3 avertissements atteints. expulsion !")}\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ`, mentions: [sender] });
                                    await sock.groupParticipantsUpdate(groupJid, [sender], 'remove');
                                    delete warnData[groupJid][sender];
                                } else {
                                    await sock.sendMessage(groupJid, { text: `╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n│⚠️ *${toSmallCaps("antilink warn")}*\n│ @${sender.split('@')[0]}\n│ *${toSmallCaps("avertissement")}* : ${count}/3\n╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ᕗ\n> ${toSmallCaps("attention, au prochain lien c'est le kick !")}`, mentions: [sender] });
                                }
                                fs.writeFileSync(warnPath, JSON.stringify(warnData, null, 2));
                            }
                            return;
                        }
                    }
                } catch (err) {
                    console.log("[You Error] Antilink Logic:", err);
                }
            }

            await spiderHandler.handleMessages(sock, chatUpdate);
        });

        // ============================================================
        // PAIRING CODE (nouvelle session seulement)
        // ============================================================
        if (!sock.authState.creds.registered) {
            return new Promise((resolve, reject) => {
                setTimeout(async () => {
                    try {
                        if (sock.ws?.isOpen) {
                            let retries = MAX_RETRIES;
                            let code;
                            while (retries > 0) {
                                try {
                                    code = await sock.requestPairingCode(num, "SNOWMDPR");
                                    break;
                                } catch (error) {
                                    retries--;
                                    if (retries === 0) throw new Error("Échec code pairing après tous les essais");
                                    await delay(2000 * (MAX_RETRIES - retries));
                                }
                            }
                            resolve(code);
                        } else {
                            reject(new Error("Connexion fermée"));
                        }
                    } catch (e) {
                        reject(e);
                    }
                }, 3000);
            });
        } else {
            return "ALREADY_CONNECTED";
        }

    } catch (error) {
        console.error(`[Session ${num}] startIndependentBot error:`, error.message);
        delete sessions[num];
        throw error;
    } finally {
        delete global[`connecting_${num}`];
    }
}

// ============================================================
// ROUTE PAIRING
// ============================================================
router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ error: "Numéro manquant" });
    num = num.replace(/[^0-9]/g, '');
    try {
        const pairingCode = await startIndependentBot(num);
        if (pairingCode === "ALREADY_CONNECTED") return res.json({ status: "success", message: "Déjà connecté" });
        if (pairingCode === "CONNECTION_IN_PROGRESS") return res.json({ status: "pending", message: "Connexion en cours..." });
        res.json({ code: pairingCode });
    } catch (err) {
        console.error(`Erreur pairing ${num}:`, err);
        res.status(500).json({ error: "Échec du pairing. Réessayez dans 20s." });
    }
});

// ============================================================
// ✅ RESTAURATION DES SESSIONS AU DÉMARRAGE (depuis MongoDB)
// ============================================================
async function initExistingSessions() {
    console.log("--- 🔄 Restauration des sessions depuis MongoDB ---");
    try {
        const nums = await getRegisteredSessions();
        console.log(`[Init] ${nums.length} session(s) trouvée(s) dans MongoDB.`);
        for (const num of nums) {
            console.log(`[Auto-Start] Relance de ${num}...`);
            startIndependentBot(num).catch(e => console.error(`[Auto-Start Error] ${num}:`, e.message));
            await delay(3000); // Délai entre chaque session pour éviter le flood
        }
    } catch (e) {
        console.error('[Init] Erreur lors de la restauration des sessions:', e.message);
    }
}

// Attendre que MongoDB soit connecté avant d'initialiser les sessions
setTimeout(initExistingSessions, 5000);

function getRegisteredUserCount() {
    return Object.keys(sessions).filter(k => sessions[k]?.ws?.isOpen).length;
}

module.exports = {
    router,
    getRegisteredUserCount
};
