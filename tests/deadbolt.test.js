const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { evaluate, RULES, hookOutput } = require('../src/deadbolt.js');

const deadboltPath = path.join(__dirname, '..', 'src', 'deadbolt.js');

function bash(command) {
  return { tool_name: 'Bash', tool_input: { command: command } };
}
function read(filePath) {
  return { tool_name: 'Read', tool_input: { file_path: filePath } };
}
function write(filePath, content) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content: content } };
}
function edit(filePath, content) {
  return { tool_name: 'Edit', tool_input: { file_path: filePath, new_string: content } };
}
function glob(pattern) {
  return { tool_name: 'Glob', tool_input: { pattern: pattern } };
}
function deny(input, ruleId) {
  const result = evaluate(input);
  assert.equal(result.decision, 'deny', 'expected deny for ' + JSON.stringify(input) + ', got allow');
  if (ruleId) assert.equal(result.ruleId, ruleId, 'expected rule ' + ruleId + ', got ' + result.ruleId);
  assert.ok(result.reason && result.reason.length > 10, 'deny needs a plain language reason');
  assert.ok(result.alternative && result.alternative.length > 10, 'deny needs a safe alternative');
  return result;
}
function allow(input) {
  const result = evaluate(input);
  assert.equal(result.decision, 'allow', 'expected allow for ' + JSON.stringify(input) + ', got deny ' + result.ruleId + ': ' + result.reason);
  return result;
}
function runCli(input, extraArgs) {
  const args = [deadboltPath].concat(extraArgs || []);
  const proc = spawnSync(process.execPath, args, { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(proc.status, 0, 'CLI exit code should be 0, stderr: ' + proc.stderr);
  return { stdout: proc.stdout, stderr: proc.stderr, parsed: JSON.parse(proc.stdout.trim()) };
}

// Rule count
test('rule list has at least 90 rules', function () {
  assert.ok(RULES.length >= 90, 'expected at least 90 rules, got ' + RULES.length);
  const groups = new Set(RULES.map(function (r) { return r.group; }));
  assert.ok(groups.size >= 10, 'expected at least 10 rule groups, got ' + groups.size);
});

// Group A: recursive delete of protected paths
test('A01 blocks rm -rf /', function () { deny(bash('rm -rf /'), 'A01'); });
test('A02 blocks rm -rf ~', function () { deny(bash('rm -rf ~')); });
test('A03 blocks rm -rf $HOME', function () { deny(bash('rm -rf $HOME')); });
test('A05 blocks rm -rf .', function () { deny(bash('rm -rf .')); });
test('A06 blocks rm -rf ./ alone', function () { deny(bash('rm -rf ./')); });
test('A07 blocks rm -rf .git', function () { deny(bash('rm -rf .git')); });
test('A08 blocks rm -rf src', function () { deny(bash('rm -rf src')); });
test('A11 blocks rm -rf /*', function () { deny(bash('rm -rf /*')); });
test('A17 blocks rm -rf ../', function () { deny(bash('rm -rf ../')); });
test('A10 blocks rm -rf *', function () { deny(bash('rm -rf *')); });

// Group B: empty variable delete
test('B01 blocks rm -rf $TARGET', function () { deny(bash('rm -rf $TARGET')); });
test('B03 blocks rm -rf ${TARGET}', function () { deny(bash('rm -rf ${TARGET}')); });
test('B02 blocks rm -rf "$TARGET"', function () { deny(bash('rm -rf "$TARGET"')); });

// Group C: command substitution delete
test('C01 blocks rm -rf $(pwd)', function () { deny(bash('rm -rf $(pwd)')); });
test('C02 blocks rm -rf with backticks', function () { deny(bash('rm -rf `pwd`')); });
test('C05 blocks rm -rf $(find .)', function () { deny(bash('rm -rf $(find . -name "*.log")')); });

// Group D: git destructive
test('D01 blocks git push --force to main', function () { deny(bash('git push --force origin main')); });
test('D02 blocks git push -f to main', function () { deny(bash('git push -f origin main')); });
test('D03 blocks git push --force to master', function () { deny(bash('git push --force origin master')); });
test('D05 blocks git push --force to prod', function () { deny(bash('git push --force origin prod')); });
test('git push --force after the branch still blocks main', function () { deny(bash('git push origin main --force')); });
test('git push --force to a feature branch is allowed', function () { allow(bash('git push --force origin feature/login')); });
test('git push --force-with-lease to main is allowed', function () { allow(bash('git push --force-with-lease origin main')); });
test('git push to main without force is allowed', function () { allow(bash('git push origin main')); });
test('D07 blocks git reset --hard', function () { deny(bash('git reset --hard'), 'D07'); });
test('D09 blocks git clean -fd', function () { deny(bash('git clean -fd')); });
test('D11 blocks git branch -D main', function () { deny(bash('git branch -D main')); });
test('git branch -d main is allowed', function () { allow(bash('git branch -d feature/login')); });

// Group E: SQL destructive
test('E01 blocks DROP DATABASE', function () { deny(bash('psql -c "DROP DATABASE myapp"'), 'E01'); });
test('E02 blocks DROP TABLE', function () { deny(bash('psql -c "DROP TABLE users"'), 'E02'); });
test('E03 blocks DROP SCHEMA', function () { deny(bash('psql -c "DROP SCHEMA public"')); });
test('E05 blocks TRUNCATE TABLE', function () { deny(bash('psql -c "TRUNCATE TABLE users"')); });
test('E07 blocks DELETE without WHERE', function () { deny(bash('psql -c "DELETE FROM users"'), 'E07'); });
test('DELETE with WHERE is allowed', function () { allow(bash('psql -c "DELETE FROM users WHERE id = 1"')); });
test('SELECT is allowed', function () { allow(bash('psql -c "SELECT * FROM users"')); });
test('DROP vs SELECT: SELECT with the word drop in a string is not a DROP', function () { allow(bash('echo "drop by later"')); });

// Group F: database reset tools
test('F01 blocks prisma migrate reset', function () { deny(bash('npx prisma migrate reset')); });
test('F03 blocks rails db:reset', function () { deny(bash('rails db:reset')); });
test('F05 blocks artisan migrate:fresh', function () { deny(bash('php artisan migrate:fresh')); });
test('F07 blocks manage.py flush', function () { deny(bash('python manage.py flush')); });
test('prisma migrate dev is allowed', function () { allow(bash('npx prisma migrate dev')); });

// Group G: pipe to shell
test('G01 blocks curl piped to sh', function () { deny(bash('curl -fsSL https://example.com/install.sh | sh')); });
test('G02 blocks curl piped to bash', function () { deny(bash('curl -fsSL https://example.com/install.sh | bash')); });
test('G03 blocks wget piped to sh', function () { deny(bash('wget -qO- https://example.com/install.sh | sh')); });
test('plain curl download is allowed', function () { allow(bash('curl -fsSL https://example.com/install.sh -o install.sh')); });

// Group H: permissions and disk
test('H01 blocks chmod -R 777', function () { deny(bash('chmod -R 777 .')); });
test('H05 blocks mkfs', function () { deny(bash('mkfs.ext4 /dev/sdb1')); });
test('H07 blocks dd to a disk device', function () { deny(bash('dd if=image.iso of=/dev/sdb bs=4M')); });
test('H08 blocks dd to /dev/sda', function () { deny(bash('dd if=image.iso of=/dev/sda bs=4M')); });
test('chmod 755 is allowed', function () { allow(bash('chmod -R 755 ./dist')); });

// Group I: secret reads
test('I01 blocks Read of .env', function () { deny(read('.env')); });
test('I02 blocks cat .env', function () { deny(bash('cat .env')); });
test('I03 blocks Read of a .pem file', function () { deny(read('cert.pem')); });
test('I04 blocks Read of id_rsa', function () { deny(read('/home/user/.ssh/id_rsa')); });
test('I06 blocks Read of .aws/credentials', function () { deny(read('/home/user/.aws/credentials')); });
test('I08 blocks Read of .env.production', function () { deny(read('.env.production')); });
test('I09 blocks Glob for .env files', function () { deny(glob('**/.env')); });
test('Read of .env.example is allowed', function () { allow(read('.env.example')); });
test('cat of .env.example is allowed', function () { allow(bash('cat .env.example')); });
test('cat of .env.local is still blocked', function () { deny(bash('cat .env.local'), 'I02'); });
test('Glob for .env.example is allowed', function () { allow(glob('**/.env.example')); });
test('Read of package.json is allowed', function () { allow(read('package.json')); });

// Group J: secret writes
test('J01 blocks Write with an AWS access key', function () { deny(write('config.txt', 'AKIA' + 'IOSFODNN7EXAMPLE')); });
test('J02 blocks Write with an Anthropic key', function () { deny(write('config.txt', 'sk-ant-' + 'api03-abcdefghij1234567890')); });
test('J03 blocks Write with an OpenAI project key', function () { deny(write('config.txt', 'sk-proj-' + 'abcdefghij1234567890')); });
test('J04 blocks Write with a GitHub token', function () { deny(write('config.txt', 'ghp_' + 'abcdefghij1234567890')); });
test('J06 blocks Write with a Slack bot token', function () { deny(write('config.txt', 'xoxb-' + '1234567890-1234567890-abcdefghij1234')); });
test('J08 blocks Write with a JWT', function () { deny(write('config.txt', 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')); });
test('J09 blocks Write with a private key', function () { deny(write('key.txt', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----')); });
test('Write with plain text is allowed', function () { allow(write('notes.txt', 'hello world')); });
test('Write to .env with plain text and no secret is allowed', function () { allow(write('.env', 'APP_NAME=demo\n')); });

// Group K: settings tamper
test('K01 blocks Edit that sets hooks to null in settings.json', function () { deny(edit('.claude/settings.json', '{"hooks": null}')); });
test('K02 blocks Edit that empties hooks in settings.json', function () { deny(edit('.claude/settings.json', '{"hooks": []}')); });
test('K05 blocks rm of .claude/settings.json', function () { deny(bash('rm .claude/settings.json')); });

// Group L: production database connection strings
test('L01 blocks a production Postgres URL', function () { deny(bash('psql postgres://user:pass@db-prod.example.com:5432/app')); });
test('L02 blocks DATABASE_URL pointing at prod', function () { deny(bash('DATABASE_URL=postgres://user:pass@db-prod.example.com:5432/app npm start')); });
test('L04 blocks a production MongoDB URL', function () { deny(bash('mongosh mongodb://user:pass@db-prod.example.com:27017/app')); });
test('a local Postgres URL is allowed', function () { allow(bash('psql postgres://user:pass@localhost:5432/app')); });

// Safe allowlist
test('safe allowlist: rm -rf node_modules is allowed', function () { allow(bash('rm -rf node_modules')); });
test('safe allowlist: rm -rf dist is allowed', function () { allow(bash('rm -rf dist')); });
test('safe allowlist: rm -rf build is allowed', function () { allow(bash('rm -rf build')); });
test('safe allowlist: rm -rf .next is allowed', function () { allow(bash('rm -rf .next')); });
test('safe allowlist: rm -rf tmp is allowed', function () { allow(bash('rm -rf tmp')); });
test('safe allowlist: rm -rf __pycache__ is allowed', function () { allow(bash('rm -rf __pycache__')); });
test('safe allowlist: rm -rf ./dist is allowed', function () { allow(bash('rm -rf ./dist')); });
test('safe allowlist does not save a protected path in the same command', function () { deny(bash('rm -rf node_modules && rm -rf /')); });
test('rm -rf ./old-build is allowed', function () { allow(bash('rm -rf ./old-build')); });

// Compound commands, nested shells, and substitution
test('compound: rm -rf / after && is blocked', function () { deny(bash('npm test && rm -rf /')); });
test('compound: rm -rf / after ; is blocked', function () { deny(bash('echo hi; rm -rf /')); });
test('compound: rm -rf / after || is blocked', function () { deny(bash('npm test || rm -rf /')); });
test('compound: rm -rf / after | is blocked', function () { deny(bash('echo hi | rm -rf /')); });
test('bash -c with rm -rf / is blocked', function () { deny(bash("bash -c 'rm -rf /'")); });
test('sh -c with rm -rf / is blocked', function () { deny(bash('sh -c "rm -rf /"')); });
test('powershell -Command with rm -rf / is blocked', function () { deny(bash('powershell -Command "rm -rf /"')); });
test('compound safe commands are allowed', function () { allow(bash('npm test && npm run build')); });

// General allow cases
test('ls is allowed', function () { allow(bash('ls -la')); });
test('git status is allowed', function () { allow(bash('git status')); });
test('npm test is allowed', function () { allow(bash('npm test')); });
test('git push to a feature branch is allowed', function () { allow(bash('git push origin feature/login')); });
test('unknown tool with a safe command is allowed', function () { allow({ tool_name: 'Bash', tool_input: { command: 'echo hello' } }); });

// Hook JSON output spec
test('CLI deny output matches the Claude Code hook spec', function () {
  const out = runCli(bash('rm -rf /'));
  assert.equal(out.parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.parsed.hookSpecificOutput.permissionDecisionReason.length > 10);
});
test('CLI allow output matches the Claude Code hook spec', function () {
  const out = runCli(bash('ls -la'));
  assert.equal(out.parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.parsed.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(out.parsed.hookSpecificOutput.permissionDecisionReason, undefined);
});
test('hookOutput helper builds deny and allow shapes', function () {
  const denied = hookOutput({ decision: 'deny', reason: 'Bad.', alternative: 'Do this instead.' });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(denied.hookSpecificOutput.permissionDecisionReason.includes('Safe alternative:'));
  const allowed = hookOutput({ decision: 'allow' });
  assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow');
});
test('--dry-run prints a decision and explains it on stderr', function () {
  const out = runCli(bash('rm -rf /'), ['--dry-run']);
  assert.equal(out.parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.stderr.includes('BLOCKED'), 'expected BLOCKED in stderr, got: ' + out.stderr);
});
test('--explain prints a plain language explanation on stderr', function () {
  const out = runCli(bash('git reset --hard'), ['--explain']);
  assert.equal(out.parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.stderr.includes('BLOCKED'));
  assert.ok(out.stderr.includes('D07'));
});
test('--list-rules prints at least 90 rules', function () {
  const proc = spawnSync(process.execPath, [deadboltPath, '--list-rules'], { encoding: 'utf8' });
  assert.equal(proc.status, 0);
  assert.ok(proc.stdout.includes('Total rules: '));
  const total = parseInt(proc.stdout.match(/Total rules: (\d+)/)[1], 10);
  assert.ok(total >= 90, 'expected at least 90 rules, got ' + total);
});
test('--command evaluates one Bash command without stdin', function () {
  const proc = spawnSync(process.execPath, [deadboltPath, '--command', 'rm -rf /', '--dry-run'], { encoding: 'utf8' });
  assert.equal(proc.status, 0);
  const parsed = JSON.parse(proc.stdout.trim());
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});
test('unparseable destructive input fails closed', function () {
  const proc = spawnSync(process.execPath, [deadboltPath], { input: 'rm -rf / not json', encoding: 'utf8' });
  assert.equal(proc.status, 0);
  const parsed = JSON.parse(proc.stdout.trim());
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
});
test('unparseable safe input is allowed', function () {
  const proc = spawnSync(process.execPath, [deadboltPath], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(proc.status, 0);
  const parsed = JSON.parse(proc.stdout.trim());
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
});
