const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let tiktokConnection = null;

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    socket.on('connect-tiktok', (data) => {
        const username = data.username.replace('@', '').trim();
        
        if (!username) {
            socket.emit('status-update', { status: 'error', message: 'Usuario inválido' });
            return;
        }

        console.log(`Conectando a @${username}`);
        
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
        }

        try {
            tiktokConnection = new WebcastPushConnection(username, {
                enableExtendedGiftInfo: true,
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                    }
                }
            });

            tiktokConnection.connect().then(state => {
                console.log(`Conectado a @${username} (Room ID: ${state.roomId})`);
                io.emit('status-update', { status: 'connected', username: username });
            }).catch(err => {
                console.error('Error de conexión:', err);
                io.emit('status-update', { status: 'error', message: 'Error al conectar (¿Está en LIVE?)' });
            });

            tiktokConnection.on('chat', data => {
                io.emit('chat-event', {
                    uniqueId: data.uniqueId,
                    nickname: data.nickname,
                    comment: data.comment
                });
            });

            tiktokConnection.on('gift', data => {
                if (data.giftType === 1 && data.repeatEnd === 0) return;
                io.emit('gift-event', {
                    uniqueId: data.uniqueId,
                    nickname: data.nickname,
                    giftName: data.giftName,
                    diamondCount: data.diamondCount * data.repeatCount,
                    repeatCount: data.repeatCount
                });
            });

            tiktokConnection.on('follow', data => {
                io.emit('follow-event', { uniqueId: data.uniqueId, nickname: data.nickname });
            });

            tiktokConnection.on('like', data => {
                io.emit('like-event', { uniqueId: data.uniqueId, totalLikeCount: data.totalLikeCount });
            });

            tiktokConnection.on('roomUser', data => {
                io.emit('room-user-event', { viewerCount: data.viewerCount });
            });

            tiktokConnection.on('streamEnd', () => {
                io.emit('status-update', { status: 'disconnected', message: 'El Live ha finalizado' });
            });

        } catch (e) {
            console.error('Falla:', e);
        }
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
});
