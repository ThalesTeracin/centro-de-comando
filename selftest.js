import assert from 'node:assert';
import { TOOLS, validInput, trusted } from './server.js';

const req = (host, origin) => ({ headers: { host, ...(origin && { origin }) } });
assert.ok(trusted(req('127.0.0.1:7777'), 7777));
assert.ok(trusted(req('localhost:7777', 'http://localhost:7777'), 7777));
assert.ok(!trusted(req('127.0.0.1:7777', 'https://evil.com'), 7777), 'CSRF must be blocked');
assert.ok(!trusted(req('evil.com:7777'), 7777), 'DNS rebinding must be blocked');

assert.ok(validInput('powershell', { command: 'dir' }));
assert.ok(!validInput('powershell', {}));
assert.ok(!validInput('write_file', { path: 'x' }));
assert.ok(validInput('browser_read', {}));
assert.ok(!validInput('nope', {}));

assert.match(await TOOLS.powershell.run({ command: 'Write-Output 42' }), /42[\s\S]*\[exit 0\]/);
const shot = await TOOLS.screenshot.run({});
assert.match(shot.text, /Tela real \d+x\d+/);
assert.ok(Buffer.from(shot.image, 'base64').subarray(1, 4).toString() === 'PNG', 'screenshot must be a PNG');
console.log('selftest ok');
