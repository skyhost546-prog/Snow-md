require('dotenv').config();
const express = require('express');
const app = express();
const __path = process.cwd();
const bodyParser = require("body-parser");
const mongoose = require('mongoose');
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

require('events').EventEmitter.defaultMaxListeners = 500;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// ============================================================
// ✅ CONNEXION MONGODB EN PREMIER, puis démarrage du serveur
// ============================================================
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
    console.error('❌ MONGODB_URI manquant dans les variables d\'environnement !');
    process.exit(1);
}

mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 10,
})
.then(() => {
    console.log('✅ MongoDB connecté avec succès.');

    // Import APRÈS connexion MongoDB
    const spiderIndex = require('./index.js');

    app.use('/code', spiderIndex.router);

    app.use('/pair', (req, res) => {
        res.sendFile(__path + '/pair.html');
    });

    app.use('/', (req, res) => {
        res.sendFile(__path + '/main.html');
    });

    app.listen(PORT, HOST, () => {
        console.log(`\n🚀 Serveur démarré sur http://localhost:${PORT}`);
    });
})
.catch(err => {
    console.error('❌ Erreur connexion MongoDB:', err.message);
    process.exit(1);
});

// Reconnexion automatique MongoDB si la connexion tombe
mongoose.connection.on('disconnected', () => {
    console.warn('⚠️ MongoDB déconnecté. Tentative de reconnexion...');
});

mongoose.connection.on('reconnected', () => {
    console.log('✅ MongoDB reconnecté.');
});

module.exports = app;
