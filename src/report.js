#!/usr/bin/env node
// Deadbolt report. Node stdlib only, no network calls.
// Reads the Deadbolt audit log (JSONL, one decision per line) and
// prints a plain text summary.
// Usage:
//   node src/report.js [--log <path>] [--json]
//   DEADBOLT_LOG=/path/to/deadbolt.log node src/report.js
// Default log location, in order: DEADBOLT_LOG, then
// ~/.claude/deadbolt.log if it exists, then .claude/deadbolt.log
// if it exists. Pass --log to choose a file directly.

const fs = require('fs');
const os = require('os');
const path = require('path');

function printHelp() {
  process.stdout.write(
    'Deadbolt report\n' +
    'Usage: node src/report.js [--log <path>] [--json]\n' +
    '  --log <path>  Read this audit log file instead of the default.\n' +
    '  --json        Print the summary as JSON instead of plain text.\n' +
    '  --help        Print this help.\n'
  );
}

function defaultLogPath() {
  if (process.env.DEADBOLT_LOG) return process.env.DEADBOLT_LOG;
  const globalLog = path.join(os.homedir(), '.claude', 'deadbolt.log');
  if (fs.existsSync(globalLog)) return globalLog;
  const projectLog = path.join(process.cwd(), '.claude', 'deadbolt.log');
  if (fs.existsSync(projectLog)) return projectLog;
  return globalLog;
}

function summarize(lines) {
  const summary = {
    total: 0,
    allowed: 0,
    blocked: 0,
    malformed: 0,
    blocksByRule: {},
    blocksByTool: {},
    topBlockedCommands: [],
    lastBlocks: []
  };
  const commandCounts = new Map();
  const blocks = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (e) {
      summary.malformed += 1;
      continue;
    }
    summary.total += 1;
    const decision = entry.decision || 'unknown';
    if (decision === 'deny' || decision === 'blocked') {
      summary.blocked += 1;
      const rule = entry.rule_id || entry.ruleId || 'unknown';
      summary.blocksByRule[rule] = (summary.blocksByRule[rule] || 0) + 1;
      const tool = entry.tool || 'unknown';
      summary.blocksByTool[tool] = (summary.blocksByTool[tool] || 0) + 1;
      const cmd = (entry.command || '').toString();
      if (cmd) commandCounts.set(cmd, (commandCounts.get(cmd) || 0) + 1);
      blocks.push(entry);
    } else if (decision === 'allow') {
      summary.allowed += 1;
    }
  }
  summary.topBlockedCommands = Array.from(commandCounts.entries())
    .map(function (pair) { return { command: pair[0], count: pair[1] }; })
    .sort(function (a, b) { return b.count - a.count; })
    .slice(0, 10);
  summary.lastBlocks = blocks.slice(-10).reverse();
  return summary;
}

function printText(summary, logPath) {
  process.stdout.write('Deadbolt report\n');
  process.stdout.write('Log file: ' + logPath + '\n');
  process.stdout.write('\n');
  process.stdout.write('Total decisions: ' + summary.total + '\n');
  process.stdout.write('Allowed: ' + summary.allowed + '\n');
  process.stdout.write('Blocked: ' + summary.blocked + '\n');
  if (summary.malformed) process.stdout.write('Malformed lines skipped: ' + summary.malformed + '\n');
  process.stdout.write('\n');
  process.stdout.write('Blocks by rule:\n');
  const ruleIds = Object.keys(summary.blocksByRule).sort(function (a, b) {
    return summary.blocksByRule[b] - summary.blocksByRule[a];
  });
  if (ruleIds.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const id of ruleIds) {
      process.stdout.write('  ' + id + ': ' + summary.blocksByRule[id] + '\n');
    }
  }
  process.stdout.write('\n');
  process.stdout.write('Top blocked commands:\n');
  if (summary.topBlockedCommands.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const item of summary.topBlockedCommands) {
      process.stdout.write('  ' + item.count + 'x  ' + item.command + '\n');
    }
  }
  process.stdout.write('\n');
  process.stdout.write('Last 10 blocks:\n');
  if (summary.lastBlocks.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const entry of summary.lastBlocks) {
      const when = entry.timestamp || '';
      const tool = entry.tool || '';
      const rule = entry.rule_id || entry.ruleId || '';
      const cmd = entry.command || '';
      const reason = entry.reason || '';
      process.stdout.write('  ' + when + ' [' + rule + '] ' + tool + ': ' + cmd + '\n');
      if (reason) process.stdout.write('    ' + reason + '\n');
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const asJson = args.includes('--json');
  let logPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log' && args[i + 1]) { logPath = args[i + 1]; i++; }
  }
  if (!logPath) logPath = defaultLogPath();

  if (!fs.existsSync(logPath)) {
    if (asJson) {
      process.stdout.write(JSON.stringify({ log: logPath, total: 0, allowed: 0, blocked: 0, malformed: 0, blocksByRule: {}, blocksByTool: {}, topBlockedCommands: [], lastBlocks: [] }, null, 2) + '\n');
    } else {
      process.stdout.write('Deadbolt report\n');
      process.stdout.write('Log file: ' + logPath + '\n');
      process.stdout.write('No decisions logged yet.\n');
      process.stdout.write('Run Claude Code with Deadbolt installed, or set DEADBOLT_LOG to your log file, then run this report again.\n');
    }
    return 0;
  }

  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    process.stderr.write('Deadbolt report: could not read log file: ' + err.message + '\n');
    return 1;
  }
  const lines = raw.split('\n');
  const summary = summarize(lines);
  summary.log = logPath;
  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    printText(summary, logPath);
  }
  return 0;
}

let code = 0;
try {
  code = main();
} catch (err) {
  process.stderr.write('Deadbolt report: ' + err.message + '\n');
  code = 1;
}
process.exitCode = code;
module.exports = { summarize: summarize };
