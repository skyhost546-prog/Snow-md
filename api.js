const express = require('express');
const app = express();
const __path = process.cwd();
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

require('events').EventEmitter.defaultMaxListeners = 500;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Health check - doit être en premier
app.get('/health', (req, res) => res.status(200).send('OK'));

// Import après les middlewares
const spiderIndex = require('./index.js');

app.use('/code', spiderIndex.router);

app.use('/pair', (req, res) => {
    res.sendFile(__path + '/pair.html');
});

app.use('/', (req, res) => {
    res.sendFile(__path + '/main.html');
});

app.listen(PORT, HOST, () => {
    console.log(`\nDon't Forget To Give Star 🌟🌟🌟🌟\n\nServer running on http://localhost:${PORT}`);
});

module.exports = app;
