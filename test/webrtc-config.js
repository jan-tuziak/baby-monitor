const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer } = require('../server/index');

async function check() {
    const nativeFetch = global.fetch;
    const savedEnv = { ...process.env };
    const savedLog = console.log;
    const savedWarn = console.warn;
    const logs = [];
    const { server } = createServer(path.resolve(__dirname, '..'));
    console.log = console.warn = (...args) => logs.push(args.join(' '));

    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const endpoint = `http://127.0.0.1:${server.address().port}/api/webrtc-config`;
        const getConfig = async (transport = 'direct') => {
            const response = await nativeFetch(`${endpoint}?transport=${transport}`);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            const config = await response.json();
            assert.equal(config.transport, transport);
            assert.equal(config.iceCandidatePoolSize, 10);
            assert.equal(config.iceTransportPolicy, undefined);
            assert.equal(JSON.stringify(config).includes('test-api-secret'), false);
            return config;
        };

        let calls = 0;
        global.fetch = async () => { calls++; throw new Error('unexpected Cloudflare request'); };
        delete process.env.CLOUDFLARE_TURN_KEY_ID;
        delete process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
        const fallback = (await getConfig()).iceServers;
        assert.equal(fallback.length, 3);
        assert.ok(fallback.every(server => server.urls.startsWith('stun:')));
        process.env.CLOUDFLARE_TURN_KEY_ID = 'test-key';
        assert.deepEqual((await getConfig()).iceServers, fallback);
        delete process.env.CLOUDFLARE_TURN_KEY_ID;
        process.env.CLOUDFLARE_TURN_KEY_API_TOKEN = 'test-api-secret';
        assert.deepEqual((await getConfig()).iceServers, fallback);
        assert.equal(calls, 0);

        process.env.CLOUDFLARE_TURN_KEY_ID = 'test/key';
        const iceServers = [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
                urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
                username: 'temporary-user', credential: 'temporary-secret'
            }
        ];
        global.fetch = async (url, options) => {
            calls++;
            assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/test%2Fkey/credentials/generate-ice-servers');
            assert.equal(options.method, 'POST');
            assert.equal(options.headers.Authorization, 'Bearer test-api-secret');
            assert.equal(options.headers['Content-Type'], 'application/json');
            assert.deepEqual(JSON.parse(options.body), { ttl: 86400 });
            assert.ok(options.signal instanceof AbortSignal);
            return Response.json({ iceServers, apiToken: 'test-api-secret' }, { status: 201 });
        };
        assert.deepEqual((await getConfig()).iceServers, iceServers);
        assert.equal(calls, 1);
        assert.deepEqual((await getConfig('relay')).iceServers, fallback);
        assert.equal(calls, 1, 'Server Relay must not call Cloudflare');

        for (const fail of [
            async () => new Response('test-api-secret', { status: 401 }),
            async () => { throw new Error('test-api-secret'); },
            async () => { throw new DOMException('test-api-secret', 'TimeoutError'); },
            async () => new Response('test-api-secret'),
            ...[null, {}, { iceServers: {} }, { iceServers: [] }, { iceServers: [null] },
                { iceServers: [{ urls: [] }] }, { iceServers: [{ urls: 'https://example.com' }] },
                { iceServers: [{ urls: 'turn:turn.cloudflare.com:3478' }] }
            ].map(body => async () => Response.json(body))
        ]) {
            global.fetch = fail;
            assert.deepEqual((await getConfig()).iceServers, fallback);
        }
        assert.ok(logs.some(line => line.includes('Using Cloudflare TURN/STUN configuration')));
        assert.ok(logs.some(line => line.includes('Cloudflare TURN unavailable, falling back to default STUN')));
        for (const secret of ['test-api-secret', 'temporary-user', 'temporary-secret']) {
            assert.equal(logs.join('\n').includes(secret), false, 'Logs must not contain secrets');
        }
    } finally {
        global.fetch = nativeFetch;
        console.log = savedLog;
        console.warn = savedWarn;
        process.env = savedEnv;
        await new Promise(resolve => server.close(resolve));
    }
    console.log('WebRTC config check passed');
}

check().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
