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
    console.log('Cliente conectado desde la web:', socket.id);

    socket.on('connect-tiktok', (data) => {
        const username = data.username.replace('@', '').trim();
        
        if (!username) {
            socket.emit('status-update', { status: 'error', message: 'Nombre de usuario inválido' });
            return;
        }

        console.log(`Intentando conectar con el Live de: @${username}`);
        
        if (tiktokConnection) {
            tiktokConnection.disconnect();
        }

        tiktokConnection = new WebcastPushConnection(username);

        tiktokConnection.connect().then(state => {
            console.log(`Conectado exitosamente al Live de @${username} (Room ID: ${state.roomId})`);
            io.emit('status-update', { status: 'connected', username: username, roomId: state.roomId });
        }).catch(err => {
            console.error('Error al conectar con TikTok:', err);
            socket.emit('status-update', { status: 'error', message: err.message || 'No se pudo conectar' });
        });

        tiktokConnection.on('chat', data => {
            io.emit('chat-event', {
                uniqueId: data.uniqueId,
                nickname: data.nickname,
                comment: data.comment,
                profilePictureUrl: data.profilePictureUrl,
                userBadges: data.userBadges,
                donorLevel: parseDonorLevel(data.userBadges),
                fanLevel: parseFanLevel(data.userBadges)
            });
        });

        tiktokConnection.on('gift', data => {
            if (data.giftType === 1 && data.repeatEnd === 0) return;

            io.emit('gift-event', {
                uniqueId: data.uniqueId,
                nickname: data.nickname,
                giftId: data.giftId,
                giftName: data.giftName,
                diamondCount: data.diamondCount * data.repeatCount,
                repeatCount: data.repeatCount,
                giftPictureUrl: data.giftDetails?.giftImage?.giftPictureUrl || ''
            });
        });

        tiktokConnection.on('follow', data => {
            io.emit('follow-event', {
                uniqueId: data.uniqueId,
                nickname: data.nickname
            });
        });

        tiktokConnection.on('like', data => {
            io.emit('like-event', {
                uniqueId: data.uniqueId,
                nickname: data.nickname,
                likeCount: data.likeCount,
                totalLikeCount: data.totalLikeCount
            });
        });

        tiktokConnection.on('roomUser', data => {
            io.emit('room-user-event', {
                viewerCount: data.viewerCount
            });
        });

        tiktokConnection.on('streamEnd', () => {
            console.log('El Live ha finalizado');
            io.emit('status-update', { status: 'disconnected', message: 'El Live ha finalizado' });
        });
    });

    socket.on('disconnect', () => {
        console.log('Cliente web desconectado:', socket.id);
    });
});

function parseDonorLevel(badges) {
    if (!badges) return 0;
    const donorBadge = badges.find(b => b.badgeSceneType === 10 || b.type?.includes('privilege'));
    return donorBadge ? (donorBadge.level || 0) : 0;
}

function parseFanLevel(badges) {
    if (!badges) return 0;
    const fanBadge = badges.find(b => b.badgeSceneType === 8 || b.type?.includes('subscriber'));
    return fanBadge ? (fanBadge.level || 0) : 0;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
