require('dotenv').config();
const mongoose = require('mongoose');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const AuthSchema = new mongoose.Schema({
    _id: String,
    data: String
}, { strict: false });

const Auth = mongoose.models.Auth || mongoose.model('Auth', AuthSchema);

/**
 * useMongoDBAuthState - PER SESSION
 * Chaque session (num) a ses propres clés isolées dans MongoDB.
 * Les sessions survivent aux redéploiements.
 */
async function useMongoDBAuthState(sessionId) {
    const prefix = `session_${sessionId}`;

    const writeData = async (data, key) => {
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await Auth.findOneAndUpdate(
            { _id: `${prefix}:${key}` },
            { data: serialized },
            { upsert: true, new: true }
        );
    };

    const readData = async (key) => {
        try {
            const doc = await Auth.findById(`${prefix}:${key}`);
            if (!doc || !doc.data) return null;
            return JSON.parse(doc.data, BufferJSON.reviver);
        } catch {
            return null;
        }
    };

    const removeData = async (key) => {
        try {
            await Auth.deleteOne({ _id: `${prefix}:${key}` });
        } catch {}
    };

    const removeSession = async () => {
        try {
            await Auth.deleteMany({ _id: { $regex: `^${prefix}:` } });
            console.log(`[MongoDB] 🗑️ Session ${sessionId} supprimée de MongoDB.`);
        } catch (e) {
            console.error(`[MongoDB] ❌ Erreur suppression session ${sessionId}:`, e.message);
        }
    };

    // Charge ou initialise les creds
    const storedCreds = await readData('creds');
    const creds = storedCreds || initAuthCreds();

    if (!storedCreds) {
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            const val = await readData(`${type}-${id}`);
                            if (val) data[id] = val;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    await Promise.all(
                        Object.entries(data).flatMap(([type, ids]) =>
                            Object.entries(ids).map(([id, val]) =>
                                val
                                    ? writeData(val, `${type}-${id}`)
                                    : removeData(`${type}-${id}`)
                            )
                        )
                    );
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        },
        removeSession
    };
}

/**
 * Retourne la liste des sessions enregistrées dans MongoDB
 */
async function getRegisteredSessions() {
    try {
        const docs = await Auth.find({ _id: /^session_.*:creds$/ });
        return docs.map(d => {
            const match = d._id.match(/^session_(.+):creds$/);
            return match ? match[1] : null;
        }).filter(Boolean);
    } catch (e) {
        console.error('[MongoDB] ❌ Erreur getRegisteredSessions:', e.message);
        return [];
    }
}

module.exports = { useMongoDBAuthState, getRegisteredSessions };
