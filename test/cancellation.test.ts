import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { installCancellationHandler } from '../src/cancellation.js';

class SignalHost extends EventEmitter {
  readonly exitCodes: number[] = [];
  exit(code?: number): never { this.exitCodes.push(code ?? 0); return undefined as never; }
}

test('SIGINT closes the invocation tab before the CLI exits', async () => {
  const host = new SignalHost();
  let closes = 0;
  const remove = installCancellationHandler(async () => { closes++; }, host as any);

  host.emit('SIGINT');
  await new Promise(resolve => setImmediate(resolve));
  host.emit('SIGTERM');

  assert.equal(closes, 1);
  assert.deepEqual(host.exitCodes, [130]);
  remove();
  assert.equal(host.listenerCount('SIGINT'), 0);
  assert.equal(host.listenerCount('SIGTERM'), 0);
});
