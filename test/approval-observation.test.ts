import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalApprovalObservationWriter } from '../src/approval-observation.js';

const jobId = '01234567-89ab-4def-8123-456789abcdef';
const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/sR8AAAAASUVORK5CYII=';

test('approval screenshots are written only to an owner-private per-Job directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'chatgpt-shot-observations-'));
  try {
    const writer = new LocalApprovalObservationWriter(jobId, root);
    assert.equal(writer.write({ frame: 'before_click', png: onePixelPng }), 'approval-001-before-click.png');
    assert.equal(writer.write({ frame: 'after_click', png: onePixelPng }), 'approval-002-after-click.png');
    const nextPollWriter = new LocalApprovalObservationWriter(jobId, root);
    assert.equal(nextPollWriter.write({ frame: 'before_click', png: onePixelPng }), 'approval-003-before-click.png');
    assert.equal(nextPollWriter.write({ frame: 'after_click', png: onePixelPng }), 'approval-004-after-click.png');
    const directory = join(root, jobId);
    const first = join(directory, 'approval-001-before-click.png');
    assert.deepEqual(readdirSync(directory).sort(), [
      'approval-001-before-click.png',
      'approval-002-after-click.png',
      'approval-003-before-click.png',
      'approval-004-after-click.png',
    ]);
    assert.equal(readFileSync(first).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(first).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approval screenshot writer rejects invalid ids and non-PNG content', () => {
  const root = mkdtempSync(join(tmpdir(), 'chatgpt-shot-observations-'));
  try {
    assert.throws(() => new LocalApprovalObservationWriter('../unsafe', root), /Invalid approval observation Job ID/);
    const writer = new LocalApprovalObservationWriter(jobId, root);
    assert.equal(writer.write({ frame: 'before_click', png: 'not a PNG' }), undefined);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
