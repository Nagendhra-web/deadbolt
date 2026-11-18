#!/usr/bin/env node
// Deadbolt installer. Node stdlib only, no network calls.
// Usage:
//   node src/install.js [--project] [--global] [--dry-run] [--uninstall]
//   node src/install.js --project --dry-run
// Test helpers (used by the test suite, not needed in normal use):
//   node src/install.js --settings <path> --deadbolt <path>
// The installer never overwrites existing settings without a backup,
// never deletes anything, and never removes hooks that are not Deadbolt.
// It merges the Deadbolt PreToolUse hook into settings.json and leaves
// every other setting untouched. Running it twice changes nothing the
// second time.

const fs = require('fs');
const os = require('os');
const path = require('path');

function printHelp() {
  process.stdout.write(
    'Deadbolt installer\n' +
    'Usage: node src/install.js [--project] [--global] [--dry-run] [--uninstall]\n' +
    '  --project    Install into .claude/settings.json in the current folder.\n' +
    '  --global     Install into ~/.claude/settings.json (the default).\n' +
    '  --dry-run    Show what would change, without writing anything.\n' +
    '  --uninstall  Remove only the Deadbolt hook, keep everything else.\n' +
    '  --help       Print this help.\n'
  );
}

function timestampForBackup() {
  const d = new Date();
  function pad(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function deadboltCommand(deadboltPath) {
  // Quote both parts so paths with spaces work on Windows, macOS, Linux.
  const nodeExe = process.execPath;
  return '"' + nodeExe + '" "' + deadboltPath + '"';
}

function isDeadboltHook(hook) {
  if (!hook || typeof hook.command !== 'string') return false;
  return hook.command.indexOf('deadbolt.js') !== -1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const dryRun = args.includes('--dry-run');
  const uninstall = args.includes('--uninstall');
  const wantProject = args.includes('--project');
  const wantGlobal = args.includes('--global');

  let settingsOverride = null;
  let deadboltOverride = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings' && args[i + 1]) { settingsOverride = args[i + 1]; i++; }
    if (args[i] === '--deadbolt' && args[i + 1]) { deadboltOverride = args[i + 1]; i++; }
    if (args[i] === '--project-dir' && args[i + 1]) { settingsOverride = path.join(args[i + 1], '.claude', 'settings.json'); i++; }
  }
  if (wantProject && wantGlobal) {
    process.stderr.write('Deadbolt installer: choose --project or --global, not both.\n');
    return 2;
  }

  const deadboltPath = deadboltOverride
    ? path.resolve(deadboltOverride)
    : path.resolve(__dirname, 'deadbolt.js');

  if (!fs.existsSync(deadboltPath)) {
    process.stderr.write('Deadbolt installer: deadbolt.js not found at ' + deadboltPath + '\n');
    return 1;
  }

  let settingsPath;
  if (settingsOverride) {
    settingsPath = path.resolve(settingsOverride);
  } else if (wantProject) {
    settingsPath = path.join(process.cwd(), '.claude', 'settings.json');
  } else {
    // Default is global.
    settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  }

  const scope = wantProject ? 'project' : (settingsOverride ? 'custom' : 'global');
  process.stdout.write('Deadbolt installer\n');
  process.stdout.write('Platform: ' + os.platform() + ' (' + os.arch() + ')\n');
  process.stdout.write('Scope: ' + scope + '\n');
  process.stdout.write('Settings file: ' + settingsPath + '\n');
  process.stdout.write('Deadbolt hook: ' + deadboltPath + '\n');

  let existing = null;
  let existed = fs.existsSync(settingsPath);
  if (existed) {
    let raw;
    try {
      raw = fs.readFileSync(settingsPath, 'utf8');
    } catch (err) {
      process.stderr.write('Deadbolt installer: could not read settings file: ' + err.message + '\n');
      return 1;
    }
    if (raw.trim() === '') {
      existing = {};
    } else {
      try {
        existing = JSON.parse(raw);
      } catch (err) {
        process.stderr.write('Deadbolt installer: settings file is not valid JSON: ' + err.message + '\n');
        process.stderr.write('Deadbolt installer: fix the JSON by hand, or move the file aside, then run the installer again. Nothing was changed.\n');
        return 1;
      }
    }
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      process.stderr.write('Deadbolt installer: settings file must contain a JSON object at the top level. Nothing was changed.\n');
      return 1;
    }
  } else {
    existing = {};
  }

  // Deep copy so we never mutate the parsed object in place before backup.
  const next = JSON.parse(JSON.stringify(existing));
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) {
    next.hooks = {};
  }
  if (!Array.isArray(next.hooks.PreToolUse)) {
    next.hooks.PreToolUse = [];
  }

  const command = deadboltCommand(deadboltPath);
  let changed = false;
  let action = '';

  if (uninstall) {
    const before = next.hooks.PreToolUse.length;
    next.hooks.PreToolUse = next.hooks.PreToolUse.filter(function (entry) {
      if (!entry || !Array.isArray(entry.hooks)) return true;
      const kept = entry.hooks.filter(function (h) { return !isDeadboltHook(h); });
      // Keep the entry if it still has hooks, or if it had no Deadbolt hook.
      if (kept.length === entry.hooks.length) return true;
      if (kept.length === 0) return false;
      entry.hooks = kept;
      return true;
    });
    // Also handle the flat form: hooks.PreToolUse entries that are
    // themselves command hooks.
    const removed = before - next.hooks.PreToolUse.length;
    if (removed > 0 || before !== next.hooks.PreToolUse.length) {
      changed = true;
      action = 'Removed Deadbolt hook from PreToolUse.';
    } else {
      // Check the nested case where an entry was kept but trimmed.
      const stillHas = next.hooks.PreToolUse.some(function (e) {
        return e && Array.isArray(e.hooks) && e.hooks.some(isDeadboltHook);
      });
      const hadBefore = existing.hooks && Array.isArray(existing.hooks.PreToolUse) && existing.hooks.PreToolUse.some(function (e) {
        return e && Array.isArray(e.hooks) && e.hooks.some(isDeadboltHook);
      });
      if (hadBefore && !stillHas) {
        changed = true;
        action = 'Removed Deadbolt hook from PreToolUse.';
      } else {
        action = 'Deadbolt hook was not installed. Nothing to remove.';
      }
    }
    if (!changed) {
      process.stdout.write(action + '\n');
      process.stdout.write('No changes made.\n');
      return 0;
    }
  } else {
    const alreadyInstalled = next.hooks.PreToolUse.some(function (entry) {
      return entry && Array.isArray(entry.hooks) && entry.hooks.some(function (h) {
        return h && typeof h.command === 'string' && h.command.indexOf('deadbolt.js') !== -1;
      });
    });
    if (alreadyInstalled) {
      process.stdout.write('Deadbolt is already installed. No changes made.\n');
      process.stdout.write('Existing hooks and settings were left untouched.\n');
      return 0;
    }
    next.hooks.PreToolUse.push({
      matcher: '*',
      hooks: [{ type: 'command', command: command }]
    });
    changed = true;
    action = existed
      ? 'Added Deadbolt PreToolUse hook to the existing settings file.'
      : 'Created a new settings file with the Deadbolt PreToolUse hook.';
  }

  if (dryRun) {
    process.stdout.write('[dry run] ' + action + '\n');
    if (existed) {
      process.stdout.write('[dry run] A backup would be written to settings.json.deadbolt-backup-' + timestampForBackup() + '\n');
    } else {
      process.stdout.write('[dry run] No backup is needed because the settings file does not exist yet.\n');
    }
    process.stdout.write('[dry run] Existing hooks and settings would be kept. No files were changed.\n');
    process.stdout.write('Hook command that would be added: ' + command + '\n');
    return 0;
  }

  // Write the backup first, before changing anything.
  if (existed) {
    const backupPath = settingsPath + '.deadbolt-backup-' + timestampForBackup();
    try {
      fs.copyFileSync(settingsPath, backupPath);
      process.stdout.write('Backup written to: ' + backupPath + '\n');
    } catch (err) {
      process.stderr.write('Deadbolt installer: could not write backup: ' + err.message + '. Nothing was changed.\n');
      return 1;
    }
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write('Deadbolt installer: could not write settings file: ' + err.message + '\n');
    return 1;
  }

  process.stdout.write(action + '\n');
  process.stdout.write('Settings file updated: ' + settingsPath + '\n');
  if (uninstall) {
    process.stdout.write('Uninstall complete. Your other hooks and settings were kept.\n');
  } else {
    process.stdout.write('Install complete. Your existing hooks and settings were kept.\n');
    process.stdout.write('Test it with: echo \'{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}\' | node "' + deadboltPath + '" --dry-run\n');
  }
  return 0;
}

let code = 0;
try {
  code = main();
} catch (err) {
  process.stderr.write('Deadbolt installer: ' + err.message + '\n');
  code = 1;
}
process.exitCode = code;
