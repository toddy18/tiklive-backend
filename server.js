const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const SERVER_STARTED_AT = Date.now();

// Clave de administrador (definir la variable de entorno ADMIN_KEY en el servidor)
const ADMIN_KEY = process.env.ADMIN_KEY || '';

/**
 * Sesiones activas por usuario de TikTok.
 * username -> {
 *   connection, status, message, roomId, connectedAt, lastEventAt,
 *   viewerCount, totalLikes, totalDiamonds, totalFollowers, totalComments,
 *   clients: Set<socketId>
 * }
 */
const sessions = new Map();

const roomName = (username) => `tiktok:${username}`;

function setStatus(session, status, message) {
    session.status = status;
    session.message = message || null;
    session.statusChangedAt = Date.now();
    io.to(roomName(session.username)).emit('status-update', {
        status,
        username: session.username,
        message: session.message
    });
}

function touch(session) {
    session.lastEventAt = Date.now();
}

function destroySession(username) {
    const session = sessions.get(username);
    if (!session) return;
    try { session.connection && session.connection.disconnect(); } catch (e) {}
    sessions.delete(username);
    console.log(`Sesión cerrada para @${username}`);
}

function createSession(username) {
    const session = {
        username,
        connection: null,
        status: 'connecting',
        message: null,
        statusChangedAt: Date.now(),
        roomId: null,
        createdAt: Date.now(),
        connectedAt: null,
        lastEventAt: null,
        viewerCount: 0,
        totalLikes: 0,
        totalDiamonds: 0,
        totalFollowers: 0,
        totalComments: 0,
        clients: new Set()
    };
    sessions.set(username, session);

    const room = roomName(username);
    const connection = new WebcastPushConnection(username, {
        enableExtendedGiftInfo: true,
        requestOptions: {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        }
    });
    session.connection = connection;

    connection.connect().then(state => {
        console.log(`Conectado a @${username} (Room ID: ${state.roomId})`);
        session.roomId = state.roomId;
        session.connectedAt = Date.now();
        touch(session);
        setStatus(session, 'connected');
    }).catch(err => {
        console.error(`Error de conexión @${username}:`, err && err.message ? err.message : err);
        setStatus(session, 'error', 'Error al conectar (¿Está en LIVE?)');
    });

    connection.on('chat', data => {
        touch(session);
        session.totalComments++;
        io.to(room).emit('chat-event', {
            uniqueId: data.uniqueId,
            nickname: data.nickname,
            comment: data.comment
        });
    });

    connection.on('gift', data => {
        if (data.giftType === 1 && data.repeatEnd === 0) return;
        touch(session);
        const diamonds = data.diamondCount * data.repeatCount;
        session.totalDiamonds += diamonds;
        io.to(room).emit('gift-event', {
            uniqueId: data.uniqueId,
            nickname: data.nickname,
            giftName: data.giftName,
            diamondCount: diamonds,
            repeatCount: data.repeatCount
        });
    });

    connection.on('follow', data => {
        touch(session);
        session.totalFollowers++;
        io.to(room).emit('follow-event', { uniqueId: data.uniqueId, nickname: data.nickname });
    });

    connection.on('like', data => {
        touch(session);
        session.totalLikes = data.totalLikeCount;
        io.to(room).emit('like-event', { uniqueId: data.uniqueId, totalLikeCount: data.totalLikeCount });
    });

    connection.on('roomUser', data => {
        touch(session);
        session.viewerCount = data.viewerCount;
        io.to(room).emit('room-user-event', { viewerCount: data.viewerCount });
    });

    connection.on('streamEnd', () => {
        setStatus(session, 'disconnected', 'El Live ha finalizado');
    });

    connection.on('disconnected', () => {
        if (session.status === 'connected') {
            setStatus(session, 'disconnected', 'Conexión con TikTok perdida');
        }
    });

    connection.on('error', err => {
        console.error(`Error en @${username}:`, err && err.info ? err.info : err);
    });

    return session;
}

function leaveCurrentSession(socket) {
    const username = socket.data.username;
    if (!username) return;
    socket.leave(roomName(username));
    socket.data.username = null;
    const session = sessions.get(username);
    if (!session) return;
    session.clients.delete(socket.id);
    // Si nadie más está usando esta conexión, se libera
    if (session.clients.size === 0) destroySession(username);
}

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('connect-tiktok', (data) => {
        const username = String((data && data.username) || '').replace('@', '').trim().toLowerCase();

        if (!username) {
            socket.emit('status-update', { status: 'error', message: 'Usuario inválido' });
            return;
        }

        console.log(`Conectando a @${username}`);

        leaveCurrentSession(socket);

        let session = sessions.get(username);
        // Reintentar si la sesión previa falló o terminó
        if (session && (session.status === 'error' || session.status === 'disconnected')) {
            const clients = session.clients;
            destroySession(username);
            session = null;
            try {
                session = createSession(username);
                clients.forEach(id => session.clients.add(id));
            } catch (e) {
                console.error('Falla:', e);
                socket.emit('status-update', { status: 'error', message: 'Error interno al conectar' });
                return;
            }
        } else if (!session) {
            try {
                session = createSession(username);
            } catch (e) {
                console.error('Falla:', e);
                socket.emit('status-update', { status: 'error', message: 'Error interno al conectar' });
                return;
            }
        }

        socket.join(roomName(username));
        socket.data.username = username;
        session.clients.add(socket.id);

        // Enviar el estado actual al cliente que se acaba de unir
        socket.emit('status-update', { status: session.status, username, message: session.message });
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
        leaveCurrentSession(socket);
    });
});

// ---------- API pública ----------

app.get('/health', (req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round((Date.now() - SERVER_STARTED_AT) / 1000) });
});

// ---------- API de administrador ----------

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
    if (!ADMIN_KEY) {
        return res.status(503).json({ error: 'ADMIN_KEY no está configurada en el servidor' });
    }
    const provided = req.get('x-admin-key') || '';
    if (!provided || !safeEqual(provided, ADMIN_KEY)) {
        return res.status(401).json({ error: 'Clave de administrador inválida' });
    }
    next();
}

app.get('/api/admin/status', requireAdmin, (req, res) => {
    const now = Date.now();
    const list = Array.from(sessions.values()).map(s => ({
        username: s.username,
        status: s.status,
        message: s.message,
        roomId: s.roomId,
        createdAt: s.createdAt,
        connectedAt: s.connectedAt,
        statusChangedAt: s.statusChangedAt,
        lastEventAt: s.lastEventAt,
        viewerCount: s.viewerCount,
        totalLikes: s.totalLikes,
        totalDiamonds: s.totalDiamonds,
        totalFollowers: s.totalFollowers,
        totalComments: s.totalComments,
        clients: s.clients.size
    }));

    res.json({
        server: {
            online: true,
            now,
            startedAt: SERVER_STARTED_AT,
            uptimeSeconds: Math.round((now - SERVER_STARTED_AT) / 1000),
            connectedClients: io.engine.clientsCount
        },
        summary: {
            total: list.length,
            connected: list.filter(s => s.status === 'connected').length,
            connecting: list.filter(s => s.status === 'connecting').length,
            withErrors: list.filter(s => s.status === 'error' || s.status === 'disconnected').length
        },
        sessions: list
    });
});

// Permite al administrador cerrar una conexión concreta
app.post('/api/admin/disconnect/:username', requireAdmin, (req, res) => {
    const username = String(req.params.username || '').replace('@', '').trim().toLowerCase();
    const session = sessions.get(username);
    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
    setStatus(session, 'disconnected', 'Desconectado por el administrador');
    io.in(roomName(username)).socketsLeave(roomName(username));
    destroySession(username);
    res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
    if (!ADMIN_KEY) console.warn('Aviso: ADMIN_KEY no definida, el panel de administrador está deshabilitado.');
});
