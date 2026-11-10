const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const { classifyConnectionError } = require('../connection-errors');

test('classifies nested errors without exposing upstream request details', () => {
    assert.equal(classifyConnectionError({ name: 'UserOfflineError' }).code, 'USER_OFFLINE');
    const result = classifyConnectionError({ config: { requestErrs: [{ response: { statusCode: 403 }, message: 'secret-sample' }] } });
    assert.equal(result.code, 'UPSTREAM_ACCESS_DENIED');
    assert.equal(JSON.stringify(result).includes('secret-sample'), false);
    assert.equal(classifyConnectionError({ name: 'SignatureRateLimitError' }).code, 'RATE_LIMITED');
    assert.equal(classifyConnectionError({ name: 'SignAPIError' }).code, 'SIGN_SERVICE_ERROR');
    assert.equal(classifyConnectionError(new Error('unknown')).code, 'CONNECTOR_ERROR');
});

function harness() {
    let onConnection;
    const connections = [];
    const routes = {};
    const app = { use() {}, get(path, fn) { routes[path] = fn; } };
    class Connector extends EventEmitter {
        constructor(username) { super(); this.username = username; connections.push(this); }
        async connect() { return { roomId: '123' }; }
        async disconnect() { this.closed = true; }
    }
    const mocks = {
        express: () => app,
        cors: () => () => {},
        http: { createServer: () => ({ listen() {} }) },
        'socket.io': { Server: class { on(event, fn) { onConnection = fn; } } },
        'tiktok-live-connector': { TikTokLiveConnection: Connector },
        './connection-errors': { classifyConnectionError }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../server'), 'utf8'), {
        require: name => mocks[name], process: { env: {} }, console: { log() {}, error() {} }
    });
    function client() {
        const handlers = {};
        const messages = [];
        onConnection({ connected: true, id: 'test', on(event, fn) { handlers[event] = fn; }, emit(event, data) { messages.push({ event, data }); } });
        return { handlers, messages };
    }
    return { client, connections, routes };
}

test('rejects malformed requests and isolates streams between visitors', async () => {
    const h = harness();
    const a = h.client();
    const b = h.client();
    await a.handlers['connect-tiktok'](null);
    assert.equal(h.connections.length, 0);
    await a.handlers['connect-tiktok']({ username: '@alice' });
    await b.handlers['connect-tiktok']({ username: 'bob' });
    h.connections[0].emit('chat', { user: { uniqueId: 'viewer' }, comment: 'hola' });
    assert.equal(a.messages.at(-1).event, 'chat-event');
    assert.equal(b.messages.some(m => m.event === 'chat-event'), false);
    a.handlers.disconnect();
    await Promise.resolve();
    assert.equal(h.connections[0].closed, true);
    assert.equal(h.connections[1].closed, undefined);
});

test('handles connector errors without crashing and allows retry', async () => {
    const h = harness();
    const a = h.client();
    await a.handlers['connect-tiktok']({ username: 'alice' });
    h.connections[0].emit('error', { name: 'SignAPIError' });
    assert.equal(a.messages.at(-1).data.code, 'SIGN_SERVICE_ERROR');
    await a.handlers['connect-tiktok']({ username: 'alice' });
    assert.equal(a.messages.at(-1).data.status, 'connected');
});

test('installed connector supports the configured constructor', async () => {
    const { TikTokLiveConnection } = require('tiktok-live-connector');
    const connection = new TikTokLiveConnection('testuser', { enableExtendedGiftInfo: false, processInitialData: true });
    assert.equal(typeof connection.connect, 'function');
    await connection.disconnect();
});
