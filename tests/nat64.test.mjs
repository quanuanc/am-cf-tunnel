import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Execute the deployed source with only Cloudflare's socket API and DNS replaced.
const source = readFileSync(new URL('../_worker_nat64.js', import.meta.url), 'utf8')
    .replace("import { connect } from 'cloudflare:sockets';", '')
    .replace('export default {', 'const worker = {');
const load = (connect, fetch) => new Function('connect', 'fetch', source + `
return { handleTPOut, createRemoteSocketWrapper, resolveDomainToRouteX, convertToRouteX, resolveConfig };
`)(connect, fetch);
const noop = () => {};
const config = {
    paddr: 'proxy.example', pnum: 443, pDomain: [], p64Domain: [], p64: false,
    p64Prefix: '2602:fc59:b0:64::', s5Enable: false,
    tcpDirectConcurrency: 1, tcpProxyConcurrency: 1, tcpConnectTimeout: 15,
    nat64DnsTimeout: 15,
};
const dns = async () => ({ ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: '104.16.1.2' }] }) });
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
async function until(predicate) {
    for (let i = 0; i < 250; i++) { if (predicate()) return; await tick(); }
    assert.fail('Timed out waiting for stream completion');
}
function socket(mode, writes) {
    let controller, ended = false;
    const end = () => { if (!ended) { ended = true; controller.close(); } };
    return {
        opened: mode === 'reject' ? Promise.reject(new Error('blocked IP')) : mode === 'timeout' ? new Promise(noop) : Promise.resolve(),
        closed: mode === 'reject' ? Promise.reject(new Error('socket closed')) : Promise.resolve(),
        readable: new ReadableStream({ start(c) { controller = c; } }),
        writable: new WritableStream({ write(bytes) {
            writes.push([...bytes]);
            if (mode === 'write-error') throw new Error('write failed');
            if (mode === 'empty') end();
            if (mode === 'empty-after-upload' && writes.length === 2) end();
            if (mode === 'response-then-error') {
                controller.enqueue(new Uint8Array([42]));
                setTimeout(() => { if (!ended) { ended = true; controller.error(new Error('read failed')); } }, 5);
            }
            if (mode === 'success') { controller.enqueue(new Uint8Array([42])); end(); }
            if (mode === 'second-frame' && writes.length === 2) { controller.enqueue(new Uint8Array([42])); end(); }
        } }),
        close: end,
    };
}
async function scenario(modes, { target = 'site.example', secondFrame = false } = {}) {
    const calls = [], writes = [];
    const api = load(({ hostname, port }) => {
        calls.push({ hostname, port });
        const mode = modes[calls.length - 1];
        if (!mode || mode === 'throw') throw new Error('dial failed');
        const sent = []; writes.push(sent);
        return socket(mode, sent);
    }, dns);
    const received = [];
    const pipe = { readyState: 1, send(bytes) { received.push([...bytes]); }, close() { this.readyState = 3; } };
    const wrapper = api.createRemoteSocketWrapper(noop, () => pipe.close());
    await api.handleTPOut(wrapper, target, 8443, new Uint8Array([1, 2]), pipe, new Uint8Array([0, 0]), noop, 2, config);
    if (secondFrame) wrapper.write(new Uint8Array([3, 4]));
    await until(() => pipe.readyState === 3);
    return { calls, writes, received, wrapper };
}
for (const mode of ['throw', 'reject', 'timeout', 'write-error', 'empty']) {
    test(`direct ${mode} falls back to NAT64 with P64=false`, async () => {
        const result = await scenario([mode, 'success']);
        assert.equal(result.calls.length, 2);
        assert.match(result.calls[1].hostname, /^\[2602:fc59:b0:64:0:0:6810:0102\]$/);
        assert.equal(result.calls[1].port, 8443);
        assert.deepEqual(result.writes.at(-1), [[1, 2]]);
        assert.deepEqual(result.received, [[0, 0, 42]]);
    });
}
test('direct success never invokes NAT64', async () => {
    assert.equal((await scenario(['success'])).calls.length, 1);
});
test('NAT64 failure uses proxy last', async () => {
    const result = await scenario(['reject', 'reject', 'success']);
    assert.deepEqual(result.calls.at(-1), { hostname: 'proxy.example', port: 443 });
});
test('all routes failing close the client', async () => {
    const result = await scenario(['reject', 'reject', 'reject']);
    assert.equal(result.calls.length, 3);
    assert.equal(result.wrapper.closed, true);
    assert.equal(result.received.length, 0);
});
test('later WebSocket frames can upload during NAT64 fallback', async () => {
    const result = await scenario(['reject', 'second-frame'], { secondFrame: true });
    assert.deepEqual(result.writes.at(-1), [[1, 2], [3, 4]]);
    assert.deepEqual(result.received, [[0, 0, 42]]);
});
test('IPv4 literals skip DNS and IPv6 literals fail clearly', async () => {
    const api = load(noop, () => { throw new Error('DNS must not be called'); });
    assert.equal(await api.resolveDomainToRouteX('104.16.1.2', config), '[2602:fc59:b0:64:0:0:6810:0102]');
    await assert.rejects(api.resolveDomainToRouteX('2001:db8::1', config), /requires an IPv4/);
    await assert.rejects(api.resolveDomainToRouteX('999.1.1.1', config), /Invalid IPv4/);
});
test('DNS errors and timeouts are bounded', async () => {
    const bad = load(noop, async () => ({ ok: true, json: async () => ({ Status: 3 }) }));
    await assert.rejects(bad.resolveDomainToRouteX('bad.example', config), /DNS query failed/);
    const slow = load(noop, (_, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    await assert.rejects(slow.resolveDomainToRouteX('slow.example', config), /aborted/);
});
test('valid /96 prefixes accepted and invalid prefixes rejected', () => {
    const api = load(noop, dns);
    assert.equal(api.convertToRouteX('192.0.2.1', { p64Prefix: '64:ff9b::/96' }), '[64:ff9b:0:0:0:0:c000:0201]');
    for (const prefix of ['64:ff9b::/64', 'not-ip::', '64:ff9b::1/96']) {
        assert.throws(() => api.convertToRouteX('192.0.2.1', { p64Prefix: prefix }));
    }
});

test('never replays a connection after receiving a response', async () => {
    const result = await scenario(['response-then-error', 'success']);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.received, [[0, 0, 42]]);
});
test('never replays a partial upload onto a new connection', async () => {
    const result = await scenario(['empty-after-upload', 'success'], { secondFrame: true });
    assert.equal(result.calls.length, 1);
    assert.match(result.wrapper.lastError.message, /Cannot retry/);
});
test('existing KV and custom domain resolve without additional settings', async () => {
    const api = load(noop, dns);
    const resolved = await api.resolveConfig(new Request('https://trip.0x8.site/'), {}, {
        kv_id: '00000000-0000-4000-8000-000000000000', kv_pDomain: [], kv_p64Domain: [],
    });
    assert.deepEqual(resolved.pDomain, []);
    assert.deepEqual(resolved.p64Domain, []);
    assert.equal(resolved.nat64DnsTimeout, 3000);
    assert.equal(resolved.p64, false);
});
