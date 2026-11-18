const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installPath = path.join(__dirname, '..', 'src', 'install.js');
const deadboltPath = path.join(__dirname, '..', 'src', 'deadbolt.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deadbolt-install-'));
}
function runInstall(args, cwd) {
  return spawnSync(process.execPath, [installPath].concat(args), { encoding: 'utf8', cwd: cwd || process.cwd() });
}
function settingsPathFor(dir) {
  return path.join(dir, '.claude', 'settings.json');
}

test('installer creates a new settings file in a temp directory', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  const proc = runInstall(['--settings', settings, '--deadbolt', deadboltPath]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(fs.existsSync(settings), 'settings file should exist');
  const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.ok(Array.isArray(parsed.hooks.PreToolUse));
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.ok(parsed.hooks.PreToolUse[0].hooks[0].command.includes('deadbolt.js'));
  assert.ok(proc.stdout.includes('Install complete'));
});

test('installer merges without overwriting existing hooks or settings', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = {
    model: 'sonnet',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hello' }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo done' }] }]
    }
  };
  fs.writeFileSync(settings, JSON.stringify(original, null, 2));
  const proc = runInstall(['--settings', settings, '--deadbolt', deadboltPath]);
  assert.equal(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(parsed.model, 'sonnet', 'existing setting must be kept');
  assert.equal(parsed.hooks.PostToolUse.length, 1, 'other hook events must be kept');
  assert.equal(parsed.hooks.PreToolUse.length, 2, 'existing PreToolUse entry plus Deadbolt');
  assert.ok(parsed.hooks.PreToolUse[0].hooks[0].command.includes('echo hello'));
  assert.ok(parsed.hooks.PreToolUse[1].hooks[0].command.includes('deadbolt.js'));
});

test('installer writes a backup of the original file', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet' }));
  const proc = runInstall(['--settings', settings, '--deadbolt', deadboltPath]);
  assert.equal(proc.status, 0, proc.stderr);
  const files = fs.readdirSync(path.dirname(settings));
  const backups = files.filter(function (f) { return f.startsWith('settings.json.deadbolt-backup-'); });
  assert.equal(backups.length, 1, 'expected one backup file, got: ' + files.join(', '));
  const backup = JSON.parse(fs.readFileSync(path.join(path.dirname(settings), backups[0]), 'utf8'));
  assert.equal(backup.model, 'sonnet');
});

test('installer is idempotent: running twice changes nothing the second time', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  const first = runInstall(['--settings', settings, '--deadbolt', deadboltPath]);
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = fs.readFileSync(settings, 'utf8');
  const second = runInstall(['--settings', settings, '--deadbolt', deadboltPath]);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(second.stdout.includes('already installed'));
  const afterSecond = fs.readFileSync(settings, 'utf8');
  assert.equal(afterSecond, afterFirst, 'second run must not change the file');
});

test('installer --dry-run changes nothing', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet' }));
  const before = fs.readFileSync(settings, 'utf8');
  const proc = runInstall(['--settings', settings, '--deadbolt', deadboltPath, '--dry-run']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(proc.stdout.includes('[dry run]'));
  assert.equal(fs.readFileSync(settings, 'utf8'), before, 'dry run must not change the file');
  const files = fs.readdirSync(path.dirname(settings));
  assert.ok(!files.some(function (f) { return f.includes('deadbolt-backup'); }), 'dry run must not write a backup');
});

test('installer --dry-run on a missing file changes nothing', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  const proc = runInstall(['--settings', settings, '--deadbolt', deadboltPath, '--dry-run']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(!fs.existsSync(settings));
});

test('installer --uninstall removes only the Deadbolt hook', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    model: 'sonnet',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hello' }] }] }
  }));
  const installed = runInstall(['--settings', settings, '--deadbolt', deadboltPath]);
  assert.equal(installed.status, 0, installed.stderr);
  const uninstalled = runInstall(['--settings', settings, '--deadbolt', deadboltPath, '--uninstall']);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  const parsed = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(parsed.model, 'sonnet');
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.ok(parsed.hooks.PreToolUse[0].hooks[0].command.includes('echo hello'));
  assert.ok(!JSON.stringify(parsed).includes('deadbolt.js'));
});

test('installer --uninstall is idempotent when Deadbolt is not installed', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ model: 'sonnet' }));
  const proc = runInstall(['--settings', settings, '--deadbolt', deadboltPath, '--uninstall']);
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(proc.stdout.includes('not installed'));
});

test('installer exits non-zero on invalid JSON and changes nothing', function () {
  const dir = tmpDir();
  const settings = settingsPathFor(dir);
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, '{not valid json');
  const before = fs.readFileSync(settings, 'utf8');
  const proc = runInstall(['--settings', settings, '--deadbolt', deadboltPath]);
  assert.notEqual(proc.status, 0, 'expected a non-zero exit code');
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
});

test('installer rejects --project and --global together', function () {
  const proc = runInstall(['--project', '--global', '--dry-run']);
  assert.notEqual(proc.status, 0);
});

test('installer --project installs into the current folder, not the real home', function () {
  const dir = tmpDir();
  const proc = runInstall(['--project', '--dry-run'], dir);
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(proc.stdout.includes(path.join(dir, '.claude', 'settings.json')));
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'settings.json')));
});
