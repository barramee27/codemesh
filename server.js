require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const runRoutes = require('./routes/run');
const terminalRoutes = require('./routes/terminal');
const adminRoutes = require('./routes/admin');
const setupCollaboration = require('./sockets/collaboration');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    perMessageDeflate: {
        zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
        threshold: 1024
    },
    maxHttpBufferSize: 10 * 1024 * 1024, // 10MB for large code sync
    // ─── Tuned connection settings ───
    pingInterval: 10000,   // Check connection every 10s (was 25s default)
    pingTimeout: 5000,     // Disconnect if no pong in 5s (was 20s default)
    connectTimeout: 10000  // 10s to complete handshake
});

// ─── Middleware ───
app.set('trust proxy', 1);  // Required for rate limit behind Railway/nginx
app.use(compression());  // Gzip all HTTP responses
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Static files with cache headers (1 day for assets)
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
    etag: true
}));

// ─── Rate limiting on API routes ───
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute window
    max: 100,              // 100 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' }
});
app.use('/api', apiLimiter);

// ─── API Routes ───
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/run', runRoutes);
app.use('/api/terminal', terminalRoutes);
app.use('/api/admin', adminRoutes);

// SPA fallback
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// ─── Connect to MongoDB and start server ───
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/codemesh';

mongoose.connect(MONGO_URI)
    .then(() => {
        console.log('✓ MongoDB connected');
        const { saveAllSessions } = setupCollaboration(io);
        server.listen(PORT, () => {
            console.log(`✓ CodeMesh server running on http://localhost:${PORT}`);
        });

        // ─── Graceful shutdown: save all sessions before exit ───
        const gracefulShutdown = async (signal) => {
            console.log(`\n${signal} received. Saving all active sessions...`);
            try {
                await saveAllSessions();
                console.log('✓ All sessions saved');
            } catch (err) {
                console.error('✗ Error saving sessions:', err.message);
            }
            await mongoose.connection.close();
            console.log('✓ MongoDB connection closed');
            process.exit(0);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    })
    .catch(err => {
        console.error('✗ MongoDB connection error:', err.message);
        process.exit(1);
    });
