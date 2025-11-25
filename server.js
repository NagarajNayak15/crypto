const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- STATE ---
// In a real DHT, this would be distributed. Here, we simulate it in memory.
let dhtStore = {}; 
// Format: { shareId: { data: 'hex...', expiresAt: timestamp } }

// --- DHT ENDPOINTS ---

// 1. Store a Key Share (Called by Sender)
app.post('/dht/store', (req, res) => {
    const { shareId, shareData, ttlSeconds } = req.body;
    
    const expiresAt = Date.now() + (ttlSeconds * 1000);
    
    dhtStore[shareId] = {
        data: shareData,
        expiresAt: expiresAt
    };

    console.log(`[DHT] Stored share ${shareId.substring(0,8)}... TTL: ${ttlSeconds}s`);
    
    // Notify the DHT Dashboard (React) to update the table
    io.emit('dht_update', getPublicStore());
    
    res.json({ success: true });
});

// 2. Retrieve a Key Share (Called by Receiver)
app.get('/dht/retrieve/:shareId', (req, res) => {
    const { shareId } = req.params;
    const share = dhtStore[shareId];

    if (!share) {
        return res.status(404).json({ error: "Share not found or expired" });
    }

    if (Date.now() > share.expiresAt) {
        delete dhtStore[shareId]; // Cleanup lazy
        return res.status(410).json({ error: "Share expired" });
    }

    res.json({ shareData: share.data });
});

// --- CLIENT MESSAGING ENDPOINTS ---

// 3. Receive Message (Called by Sender, executes on Receiver's machine)
// We use a simple long-polling or event emission mechanism for the receiver UI
app.post('/client/receive', (req, res) => {
    const { incompleteCiphertext, shareIds, dhtIp } = req.body;
    console.log(`[Client] Received encrypted package.`);
    
    // Push this message to the React Frontend connected to this specific node
    io.emit('incoming_message', { incompleteCiphertext, shareIds, dhtIp });
    
    res.json({ success: true });
});

// --- CLEANUP LOOP ---
setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [key, val] of Object.entries(dhtStore)) {
        if (now > val.expiresAt) {
            delete dhtStore[key];
            changed = true;
            console.log(`[DHT] Share ${key.substring(0,8)}... expired and self-destructed.`);
        }
    }
    if (changed) io.emit('dht_update', getPublicStore());
}, 1000);

function getPublicStore() {
    // Return store data without the actual secrets for the dashboard
    return Object.entries(dhtStore).map(([id, val]) => ({
        id,
        expiresAt: val.expiresAt,
        dataHash: '***SECRET***' 
    }));
}

// Start Server
// Allow PORT to be set via env or command line for multiple devices
const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});