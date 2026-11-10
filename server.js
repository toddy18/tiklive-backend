const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const TikTokLive = require('tiktok-live-connector');

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
    console.log('Cliente web conectado:', socket.id);

    socket.on('connect-tiktok', (data) => {
        const username = data.username.replace('@', '').trim();
        
        if (!username) {
            socket.emit('status-update', { status: 'error', message: 'Usuario inválido' });
            return;
        }

        console.log(`Conectando al Live de: @${username}`);
        
        if (tiktokConnection) {
            try { tiktokConnection.disconnect(); } catch (e) {}
        }

        try {
            // Obtener el constructor correctamente desde el paquete de zerodytrash
            const ConnectionConstructor = TikTokLive.WebcastPushConnection || TikTokLive.default || TikTokLive;
            
            tiktokConnection = new ConnectionConstructor(username, {
                enableExtendedGiftInfo: true,
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        'Origin': 'https://www.tiktok.com',
                        'Referer': 'https://www.tiktok.com/'
                    }
                }
            });

            tiktokConnection.connect().then(state => {
                console.log(`Conectado exitosamente a @${username} (Room ID: ${state.roomId})`);
                io.emit('status-update', { status: 'connected', username: username });
            }).catch(err => {
                console.error('Error al conectar:', err);
                io.emit('status-update', { status: 'error', message: 'Error al conectar (¿El usuario está en LIVE?)' });
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
                io.emit('like-event', { totalLikeCount: data.totalLikeCount });
            });

            tiktokConnection.on('roomUser', data => {
                io.emit('room-user-event', { viewerCount: data.viewerCount });
            });

            tiktokConnection.on('streamEnd', () => {
                io.emit('status-update', { status: 'disconnected', message: 'El Live ha finalizado' });
            });

        } catch (e) {
            console.error('Error crítico al instanciar:', e);
            socket.emit('status-update', { status: 'error', message: 'Falla interna de conexión' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
