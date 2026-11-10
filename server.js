const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { TikTokLiveConnection } = require('tiktok-live-connector');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', connectorVersion: '2.5.0', protocolVersion: 2 });
});

const { classifyConnectionError } = require('./connection-errors');

io.on('connection', (socket) => {
    console.log('Cliente conectado desde la web:', socket.id);

    let tiktokConnection = null;
    let connecting = false;

    function releaseConnection() {
        const previous = tiktokConnection;
        tiktokConnection = null;
        if (previous) Promise.resolve().then(() => previous.disconnect()).catch(() => {});
    }

    socket.on('connect-tiktok', async (data) => {
        if (connecting) return;
        const username = typeof data?.username === 'string'
            ? data.username.trim().replace(/^@/, '') : '';
        
        if (!/^[a-zA-Z0-9._]{1,24}$/.test(username)) {
            socket.emit('status-update', { status: 'error', message: 'Nombre de usuario inválido' });
            return;
        }

        console.log(`Intentando conectar con el Live de: @${username}`);
        
        connecting = true;
        releaseConnection();
        let connection;
        try {
            connection = new TikTokLiveConnection(username, {
                enableExtendedGiftInfo: false,
                processInitialData: true
            });
            tiktokConnection = connection;
        } catch (err) {
            connecting = false;
            const failure = classifyConnectionError(err);
            console.error('TikTok connection failed:', failure.code);
            socket.emit('status-update', { status: 'error', ...failure });
            return;
        }

        const reportFailure = (err) => {
            if (tiktokConnection !== connection) return;
            const failure = classifyConnectionError(err);
            // Never log raw errors: upstream HTTP errors can include credentials.
            console.error('TikTok connection failed:', failure.code);
            socket.emit('status-update', { status: 'error', ...failure });
            releaseConnection();
        };
        connection.on('error', reportFailure);
        connection.on('disconnected', () => {
            if (tiktokConnection !== connection) return;
            socket.emit('status-update', { status: 'disconnected', message: 'Se perdió la conexión con TikTok. Vuelve a conectar.' });
            releaseConnection();
        });

        connection.on('chat', data => {
            if (tiktokConnection !== connection) return;
            socket.emit('chat-event', {
                uniqueId: data.user?.uniqueId,
                nickname: data.user?.nickname,
                comment: data.comment,
                profilePictureUrl: data.user?.profilePicture?.urls?.[0]
            });
        });

        connection.on('gift', data => {
            if (tiktokConnection !== connection) return;
            if (data.giftDetails?.giftType === 1 && !data.repeatEnd) return;

            socket.emit('gift-event', {
                uniqueId: data.user?.uniqueId,
                nickname: data.user?.nickname,
                giftId: data.giftId,
                giftName: data.giftDetails?.giftName || 'Regalo',
                diamondCount: Number(data.giftDetails?.diamondCount || 0) * Number(data.repeatCount || 1),
                repeatCount: data.repeatCount
            });
        });

        connection.on('follow', data => {
            if (tiktokConnection !== connection) return;
            socket.emit('follow-event', {
                uniqueId: data.user?.uniqueId,
                nickname: data.user?.nickname
            });
        });

        connection.on('like', data => {
            if (tiktokConnection !== connection) return;
            socket.emit('like-event', {
                uniqueId: data.user?.uniqueId,
                nickname: data.user?.nickname,
                likeCount: data.likeCount,
                totalLikeCount: data.totalLikeCount
            });
        });

        connection.on('roomUser', data => {
            if (tiktokConnection !== connection) return;
            socket.emit('room-user-event', {
                viewerCount: data.viewerCount
            });
        });

        connection.on('streamEnd', () => {
            if (tiktokConnection !== connection) return;
            console.log('El Live ha finalizado');
            socket.emit('status-update', { status: 'disconnected', message: 'El Live ha finalizado' });
            releaseConnection();
        });

        try {
            const state = await connection.connect();
            if (tiktokConnection === connection && socket.connected) {
                socket.emit('status-update', { status: 'connected', username, roomId: state.roomId });
            } else {
                await connection.disconnect();
            }
        } catch (err) {
            reportFailure(err);
        } finally {
            connecting = false;
        }
    });

    socket.on('disconnect', () => {
        releaseConnection();
        console.log('Cliente web desconectado:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
