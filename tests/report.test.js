const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { summarize } = require('../src/report.js');

const reportPath = path.join(__dirname, '..', 'src', 'report.js');

function fixtureLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadbolt-report-'));
  const log = path.join(dir, 'deadbolt.log');
  const lines = [
    { timestamp: '2026-11-18T10:00:00.000Z', tool: 'Bash', command: 'rm -rf /', decision: 'deny', rule_id: 'A01', reason: 'This would delete the root of the filesystem.' },
    { timestamp: '2026-11-18T10:01:00.000Z', tool: 'Bash', command: 'rm -rf /', decision: 'deny', rule_id: 'A01', reason: 'This would delete the root of the filesystem.' },
    { timestamp: '2026-11-18T10:02:00.000Z', tool: 'Bash', command: 'git reset --hard', decision: 'deny', rule_id: 'D07', reason: 'This discards uncommitted work.' },
    { timestamp: '2026-11-18T10:03:00.000Z', tool: 'Bash', command: 'ls -la', decision: 'allow', rule_id: null, reason: '' },
    { timestamp: '2026-11-18T10:04:00.000Z', tool: 'Read', command: '.env', decision: 'deny', rule_id: 'I01', reason: 'This reads a .env file.' },
    { timestamp: '2026-11-18T10:05:00.000Z', tool: 'Bash', command: 'npm test', decision: 'allow', rule_id: null, reason: '' }
  ];
  fs.writeFileSync(log, lines.map(function (l) { return JSON.stringify(l); }).join('\n') + '\n');
  return log;
}

test('summarize counts total, allowed, and blocked', function () {
  const log = fixtureLog();
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  const summary = summarize(lines);
  assert.equal(summary.total, 6);
  assert.equal(summary.allowed, 2);
  assert.equal(summary.blocked, 4);
});

test('summarize groups blocks by rule', function () {
  const log = fixtureLog();
  const summary = summarize(fs.readFileSync(log, 'utf8').split('\n'));
  assert.equal(summary.blocksByRule.A01, 2);
  assert.equal(summary.blocksByRule.D07, 1);
  assert.equal(summary.blocksByRule.I01, 1);
});

test('summarize ranks top blocked commands', function () {
  const log = fixtureLog();
  const summary = summarize(fs.readFileSync(log, 'utf8').split('\n'));
  assert.equal(summary.topBlockedCommands[0].command, 'rm -rf /');
  assert.equal(summary.topBlockedCommands[0].count, 2);
});

test('summarize keeps the last 10 blocks, most recent first', function () {
  const log = fixtureLog();
  const summary = summarize(fs.readFileSync(log, 'utf8').split('\n'));
  assert.equal(summary.lastBlocks.length, 4);
  assert.equal(summary.lastBlocks[0].command, '.env');
  assert.equal(summary.lastBlocks[3].command, 'rm -rf /');
});

test('summarize skips malformed lines and counts them', function () {
  const summary = summarize(['{not json', '{"decision":"allow"}', '']);
  assert.equal(summary.total, 1);
  assert.equal(summary.malformed, 1);
  assert.equal(summary.allowed, 1);
});

test('report CLI prints a plain text summary for a fixture log', function () {
  const log = fixtureLog();
  const proc = spawnSync(process.execPath, [reportPath, '--log', log], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(proc.stdout.includes('Total decisions: 6'));
  assert.ok(proc.stdout.includes('Blocked: 4'));
  assert.ok(proc.stdout.includes('A01: 2'));
  assert.ok(proc.stdout.includes('rm -rf /'));
  assert.ok(proc.stdout.includes('Last 10 blocks:'));
});

test('report CLI --json prints a JSON summary', function () {
  const log = fixtureLog();
  const proc = spawnSync(process.execPath, [reportPath, '--log', log, '--json'], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.total, 6);
  assert.equal(parsed.blocked, 4);
  assert.equal(parsed.blocksByRule.A01, 2);
});

test('report CLI on a missing log prints a friendly message and exits 0', function () {
  const missing = path.join(os.tmpdir(), 'deadbolt-no-such-log-' + Date.now() + '.log');
  const proc = spawnSync(process.execPath, [reportPath, '--log', missing], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(proc.stdout.includes('No decisions logged yet.'));
});

test('report CLI on an empty log prints zero decisions', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadbolt-report-empty-'));
  const log = path.join(dir, 'deadbolt.log');
  fs.writeFileSync(log, '');
  const proc = spawnSync(process.execPath, [reportPath, '--log', log], { encoding: 'utf8' });
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(proc.stdout.includes('Total decisions: 0'));
});
