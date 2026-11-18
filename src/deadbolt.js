#!/usr/bin/env node
// Deadbolt for Claude Code
// Deterministic PreToolUse hook engine. Node stdlib only, no network calls.
// Reads a Claude Code PreToolUse JSON object from stdin and writes a
// Claude Code hook JSON decision to stdout.
// Usage:
//   echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | node src/deadbolt.js
//   echo '{...}' | node src/deadbolt.js --dry-run
//   echo '{...}' | node src/deadbolt.js --explain
//   node src/deadbolt.js --command "rm -rf /" --dry-run
//   node src/deadbolt.js --list-rules
//   node src/deadbolt.js --help
// Logging: set DEADBOLT_LOG to a file path, or pass --log <path>.
// When logging is off, nothing is written to disk. Dry run never logs.

const fs = require('fs');
const path = require('path');

// Rule list. Each rule has an id, a group, a regex, a plain language
// reason, and a safe alternative. Count is checked by --list-rules and
// by the test suite. Keep the total at 90 or more.
const RULES = [
  // Group A: recursive delete of protected paths (18 rules)
  { id: 'A01', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:--no-preserve-root\s+)?\/\s*(?:$|[;&|])/, reason: 'This would delete the root of the filesystem.', alternative: 'Delete one named folder inside the project, for example rm -rf ./tmp, and check the path first with ls.' },
  { id: 'A02', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*~\s*(?:$|[;&|/])/, reason: 'This would delete your home folder.', alternative: 'Delete one named folder inside the project instead, for example rm -rf ./tmp.' },
  { id: 'A03', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$HOME\b/, reason: 'This would delete your home folder.', alternative: 'Delete one named folder inside the project instead, for example rm -rf ./tmp.' },
  { id: 'A04', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*~\//, reason: 'This would delete inside your home folder from the top.', alternative: 'Delete one named folder inside the project instead, for example rm -rf ./tmp.' },
  { id: 'A05', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\.\s*(?:$|[;&|])/, reason: 'This would delete the current folder and everything in it.', alternative: 'Change into the parent folder first, then delete one named folder, for example rm -rf ./old-build.' },
  { id: 'A06', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\.\/\s*(?:$|[;&|])/, reason: 'This would delete the current folder and everything in it.', alternative: 'Delete one named subfolder by name, for example rm -rf ./tmp.' },
  { id: 'A07', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\.\/)?\.git\b/, reason: 'This would delete the git history for this project.', alternative: 'If you need a fresh clone, copy the folder first, then clone again in a new folder.' },
  { id: 'A08', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\.\/)?src\s*(?:$|[;&|/])/, reason: 'This would delete the src folder, which usually holds the project source code.', alternative: 'Delete one file or one subfolder inside src, and commit first so you can restore it.' },
  { id: 'A09', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\$PWD|\$\{PWD\}|\$PROJECT_ROOT|\$\{PROJECT_ROOT\})/, reason: 'This would delete the project root folder.', alternative: 'Delete one named folder inside the project, for example rm -rf ./tmp.' },
  { id: 'A10', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\*\s*(?:$|[;&|])/, reason: 'This would delete every file in the current folder.', alternative: 'List the files first with ls, then delete them by name or by a narrow pattern.' },
  { id: 'A11', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\/\*/, reason: 'This would delete every file from the root of the filesystem.', alternative: 'Delete one named folder inside the project instead.' },
  { id: 'A12', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\/home\b/, reason: 'This would delete the home directory for all users on this machine.', alternative: 'Delete one named folder inside the project instead.' },
  { id: 'A13', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\/(?:Users|home\/[^\s]+)\b/, reason: 'This would delete a user home folder.', alternative: 'Delete one named folder inside the project instead.' },
  { id: 'A14', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*[A-Za-z]:\\(?:\s*(?:$|[;&|])|\\Windows|\\System)/, reason: 'This would delete a Windows drive or system folder.', alternative: 'Delete one named folder inside the project instead.' },
  { id: 'A15', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*--no-preserve-root\b/, reason: 'This removes the safety check that stops rm from deleting the root folder.', alternative: 'Remove the --no-preserve-root flag and delete one named folder instead.' },
  { id: 'A16', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$HOME\//, reason: 'This would delete inside your home folder from the top.', alternative: 'Delete one named folder inside the project instead.' },
  { id: 'A17', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\.\.\/|\.\.\\)/, reason: 'This would delete a parent folder above the project.', alternative: 'Stay inside the project folder and delete one named folder there.' },
  { id: 'A18', group: 'recursive-delete-protected', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\.\/)?(?:\.env|package\.json|tsconfig\.json)\b/, reason: 'This would delete a core project file.', alternative: 'Back the file up first, then edit it instead of deleting it.' },

  // Group B: empty variable delete (6 rules)
  { id: 'B01', group: 'empty-variable-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$[A-Za-z_][A-Za-z0-9_]*(?:\s*(?:$|[;&|])|\s+\S)/, reason: 'The folder name comes from a variable, and if that variable is empty the delete can hit the wrong place.', alternative: 'Set the variable first and print it with echo, or write the folder name out in full.' },
  { id: 'B02', group: 'empty-variable-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*"\$[A-Za-z_][A-Za-z0-9_]*"/, reason: 'The folder name comes from a variable in quotes, and if that variable is empty the delete can hit the wrong place.', alternative: 'Set the variable first and print it with echo, or write the folder name out in full.' },
  { id: 'B03', group: 'empty-variable-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$\{[A-Za-z_][A-Za-z0-9_]*\}/, reason: 'The folder name comes from a variable, and if that variable is empty the delete can hit the wrong place.', alternative: 'Set the variable first and print it with echo, or write the folder name out in full.' },
  { id: 'B04', group: 'empty-variable-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$(?:UNSET|EMPTY|DIR|TARGET|FOLDER|PATH)\b/, reason: 'The folder name comes from a variable that looks empty or unset.', alternative: 'Set the variable first and print it with echo, or write the folder name out in full.' },
  { id: 'B05', group: 'empty-variable-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$\d\b/, reason: 'The folder name comes from a script argument, and if that argument is empty the delete can hit the wrong place.', alternative: 'Check the argument first, or write the folder name out in full.' },
  { id: 'B06', group: 'empty-variable-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$[A-Za-z_][A-Za-z0-9_]*\//, reason: 'The folder path starts with a variable, and if that variable is empty the delete can hit the wrong place.', alternative: 'Set the variable first and print it with echo, or write the folder name out in full.' },

  // Group C: command substitution delete (5 rules)
  { id: 'C01', group: 'command-substitution-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$\([^)]*\)/, reason: 'The folder name comes from running another command, and if that command returns the wrong text the delete can hit the wrong place.', alternative: 'Run the inner command first, check what it prints, then delete by name.' },
  { id: 'C02', group: 'command-substitution-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*`[^`]*`/, reason: 'The folder name comes from running another command in backticks, and if that command returns the wrong text the delete can hit the wrong place.', alternative: 'Run the inner command first, check what it prints, then delete by name.' },
  { id: 'C03', group: 'command-substitution-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$\(\s*pwd\s*\)/, reason: 'This would delete the current working folder.', alternative: 'Delete one named subfolder inside the project instead.' },
  { id: 'C04', group: 'command-substitution-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$\(\s*ls\b[^)]*\)/, reason: 'The delete list comes from ls output, which can include files you did not mean to delete.', alternative: 'List the files first, check them, then delete them by name.' },
  { id: 'C05', group: 'command-substitution-delete', pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\$\(\s*find\b[^)]*\)/, reason: 'The delete list comes from find output, which can include files you did not mean to delete.', alternative: 'Run find first without rm, check the list, then delete by name.' },

  // Group D: git destructive (14 rules)
  { id: 'D01', group: 'git-destructive', pattern: /\bgit\s+push\s+(?:--force\s+|--force\b)[^\n]*\bmain\b/, reason: 'This would force push to main and can erase work other people have pushed.', alternative: 'Push to a feature branch, or use git push --force-with-lease on a branch you own.' },
  { id: 'D02', group: 'git-destructive', pattern: /\bgit\s+push\s+(?:-[a-z]*f\b|--force\b)[^\n]*\bmain\b/, reason: 'This would force push to main and can erase work other people have pushed.', alternative: 'Push to a feature branch, or use git push --force-with-lease on a branch you own.' },
  { id: 'D03', group: 'git-destructive', pattern: /\bgit\s+push\s+(?:--force\s+|--force\b)[^\n]*\bmaster\b/, reason: 'This would force push to master and can erase work other people have pushed.', alternative: 'Push to a feature branch, or use git push --force-with-lease on a branch you own.' },
  { id: 'D04', group: 'git-destructive', pattern: /\bgit\s+push\s+(?:-[a-z]*f\b|--force\b)[^\n]*\bmaster\b/, reason: 'This would force push to master and can erase work other people have pushed.', alternative: 'Push to a feature branch, or use git push --force-with-lease on a branch you own.' },
  { id: 'D05', group: 'git-destructive', pattern: /\bgit\s+push\s+(?:--force\b|-f\b)[^\n]*\b(?:prod|production)\b/, reason: 'This would force push to a production branch and can erase work other people have pushed.', alternative: 'Push to a feature branch and use a pull request for production branches.' },
  { id: 'D06', group: 'git-destructive', pattern: /\bgit\s+push\s+(?:--force\b)[^\n]*\b(?:main|master)\b/, reason: 'This would force push to the main branch and can erase work other people have pushed.', alternative: 'Push to a feature branch, or use git push --force-with-lease on a branch you own.' },
  { id: 'D07', group: 'git-destructive', pattern: /\bgit\s+reset\s+--hard\b/, reason: 'This discards uncommitted work with no way to get it back.', alternative: 'Run git stash first, or commit your work, then reset.' },
  { id: 'D08', group: 'git-destructive', pattern: /\bgit\s+reset\s+--hard\s+origin\/(?:main|master)\b/, reason: 'This discards local work and resets to the remote main branch.', alternative: 'Run git stash first, or commit your work, then reset.' },
  { id: 'D09', group: 'git-destructive', pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*d\b/, reason: 'This deletes untracked files and folders with no way to get them back.', alternative: 'Run git clean -n first to preview the list, then delete by name.' },
  { id: 'D10', group: 'git-destructive', pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*d[a-z]*x\b/, reason: 'This deletes untracked and ignored files and folders with no way to get them back.', alternative: 'Run git clean -n first to preview the list, then delete by name.' },
  { id: 'D11', group: 'git-destructive', pattern: /\bgit\s+branch\s+-D\s+main\b/, reason: 'This force deletes the main branch.', alternative: 'Use git branch -d, which refuses if the branch has work that is not merged.' },
  { id: 'D12', group: 'git-destructive', pattern: /\bgit\s+branch\s+-D\s+master\b/, reason: 'This force deletes the master branch.', alternative: 'Use git branch -d, which refuses if the branch has work that is not merged.' },
  { id: 'D13', group: 'git-destructive', pattern: /\bgit\s+branch\s+--delete\s+--force\s+(?:main|master)\b/, reason: 'This force deletes the main branch.', alternative: 'Use git branch -d, which refuses if the branch has work that is not merged.' },
  { id: 'D14', group: 'git-destructive', pattern: /\bgit\s+branch\s+-D\s+(?:prod|production)\b/, reason: 'This force deletes a production branch.', alternative: 'Use git branch -d, which refuses if the branch has work that is not merged.' },

  // Group E: SQL destructive (12 rules)
  { id: 'E01', group: 'sql-destructive', pattern: /\bDROP\s+DATABASE\b/i, reason: 'This would delete a whole database.', alternative: 'Back the database up first, then drop it by hand in a database tool.' },
  { id: 'E02', group: 'sql-destructive', pattern: /\bDROP\s+TABLE\b/i, reason: 'This would delete a whole table and all its rows.', alternative: 'Back the table up first, then drop it by hand in a database tool.' },
  { id: 'E03', group: 'sql-destructive', pattern: /\bDROP\s+SCHEMA\b/i, reason: 'This would delete a whole schema and everything in it.', alternative: 'Back the schema up first, then drop it by hand in a database tool.' },
  { id: 'E04', group: 'sql-destructive', pattern: /\bDROP\s+INDEX\b/i, reason: 'This would delete a database index, which can slow queries down a lot.', alternative: 'Check which queries use the index first, then drop it by hand.' },
  { id: 'E05', group: 'sql-destructive', pattern: /\bTRUNCATE\s+TABLE\b/i, reason: 'This would delete every row in a table at once.', alternative: 'Back the table up first, then delete rows in small batches with a WHERE clause.' },
  { id: 'E06', group: 'sql-destructive', pattern: /\bTRUNCATE\b/i, reason: 'This would delete every row in a table at once.', alternative: 'Back the table up first, then delete rows in small batches with a WHERE clause.' },
  { id: 'E09', group: 'sql-destructive', pattern: /\bDROP\s+DATABASE\s+IF\s+EXISTS\b/i, reason: 'This would delete a whole database.', alternative: 'Back the database up first, then drop it by hand in a database tool.' },
  { id: 'E10', group: 'sql-destructive', pattern: /\bDROP\s+TABLE\s+IF\s+EXISTS\b/i, reason: 'This would delete a whole table and all its rows.', alternative: 'Back the table up first, then drop it by hand in a database tool.' },
  { id: 'E11', group: 'sql-destructive', pattern: /\bDROP\s+COLUMN\b/i, reason: 'This would delete a column and all the data in it.', alternative: 'Back the table up first, then drop the column by hand.' },
  { id: 'E12', group: 'sql-destructive', pattern: /\bALTER\s+TABLE\b[^;]*\bDROP\b/i, reason: 'This would delete a column or constraint from a table.', alternative: 'Back the table up first, then change it by hand in a database tool.' },
  { id: 'E13', group: 'sql-destructive', pattern: /\bDELETE\s+FROM\b[^;]*\bWHERE\s+1\s*=\s*1\b/i, reason: 'This DELETE has a WHERE clause that matches every row, so it deletes the whole table.', alternative: 'Use a WHERE clause that names the exact rows, and test it with SELECT first.' },
  { id: 'E14', group: 'sql-destructive', pattern: /\bDELETE\s+FROM\b[^;]*\bWHERE\s+true\b/i, reason: 'This DELETE has a WHERE clause that matches every row, so it deletes the whole table.', alternative: 'Use a WHERE clause that names the exact rows, and test it with SELECT first.' },

  // Group F: database reset tools (8 rules)
  { id: 'F01', group: 'db-reset-tools', pattern: /\bprisma\s+migrate\s+reset\b/, reason: 'This wipes the database and reapplies all migrations from scratch.', alternative: 'Use prisma migrate dev for a local change, and back the database up first.' },
  { id: 'F02', group: 'db-reset-tools', pattern: /\bprisma\s+db\s+push\s+--force-reset\b/, reason: 'This wipes the database and pushes the schema from scratch.', alternative: 'Use prisma db push without --force-reset on a copy of the database first.' },
  { id: 'F03', group: 'db-reset-tools', pattern: /\brails\s+db:reset\b/, reason: 'This drops the database, recreates it, and reseeds it, losing all current data.', alternative: 'Use rails db:migrate on a copy of the database first.' },
  { id: 'F04', group: 'db-reset-tools', pattern: /\brails\s+db:migrate:reset\b/, reason: 'This drops the database and reapplies all migrations, losing all current data.', alternative: 'Use rails db:migrate on a copy of the database first.' },
  { id: 'F05', group: 'db-reset-tools', pattern: /\bartisan\s+migrate:fresh\b/, reason: 'This drops all tables and reapplies all migrations, losing all current data.', alternative: 'Use php artisan migrate on a copy of the database first.' },
  { id: 'F06', group: 'db-reset-tools', pattern: /\bartisan\s+migrate:fresh\s+--seed\b/, reason: 'This drops all tables, reapplies all migrations, and reseeds, losing all current data.', alternative: 'Use php artisan migrate on a copy of the database first.' },
  { id: 'F07', group: 'db-reset-tools', pattern: /\bmanage\.py\s+flush\b/, reason: 'This deletes all data from the Django database.', alternative: 'Back the database up first, then flush a copy, not the live database.' },
  { id: 'F08', group: 'db-reset-tools', pattern: /\bnpx\s+prisma\s+migrate\s+reset\b/, reason: 'This wipes the database and reapplies all migrations from scratch.', alternative: 'Use prisma migrate dev for a local change, and back the database up first.' },

  // Group G: pipe to shell (6 rules)
  { id: 'G01', group: 'pipe-to-shell', pattern: /\bcurl\b[^|]*\|\s*sh\b/, reason: 'This downloads a script from the internet and runs it without checking it first.', alternative: 'Download the file, read it, then run it by name.' },
  { id: 'G02', group: 'pipe-to-shell', pattern: /\bcurl\b[^|]*\|\s*bash\b/, reason: 'This downloads a script from the internet and runs it without checking it first.', alternative: 'Download the file, read it, then run it by name.' },
  { id: 'G03', group: 'pipe-to-shell', pattern: /\bwget\b[^|]*\|\s*sh\b/, reason: 'This downloads a script from the internet and runs it without checking it first.', alternative: 'Download the file, read it, then run it by name.' },
  { id: 'G04', group: 'pipe-to-shell', pattern: /\bwget\b[^|]*\|\s*bash\b/, reason: 'This downloads a script from the internet and runs it without checking it first.', alternative: 'Download the file, read it, then run it by name.' },
  { id: 'G05', group: 'pipe-to-shell', pattern: /\bcurl\b[^|]*\|\s*sudo\s+(?:sh|bash)\b/, reason: 'This downloads a script from the internet and runs it as an administrator without checking it first.', alternative: 'Download the file, read it, then run it by name without sudo.' },
  { id: 'G06', group: 'pipe-to-shell', pattern: /\bInvoke-WebRequest\b[^|]*\|\s*Invoke-Expression\b/i, reason: 'This downloads a script from the internet and runs it without checking it first.', alternative: 'Download the file, read it, then run it by name.' },

  // Group H: permissions and disk (10 rules)
  { id: 'H01', group: 'permissions-disk', pattern: /\bchmod\s+-R\s+777\b/, reason: 'This gives everyone full read, write, and run access to a whole folder tree.', alternative: 'Use chmod -R 755 for folders and 644 for files, or set access for one folder only.' },
  { id: 'H02', group: 'permissions-disk', pattern: /\bchmod\s+777\s+-R\b/, reason: 'This gives everyone full read, write, and run access to a whole folder tree.', alternative: 'Use chmod -R 755 for folders and 644 for files, or set access for one folder only.' },
  { id: 'H03', group: 'permissions-disk', pattern: /\bchmod\s+-R\s+777\s+\//, reason: 'This gives everyone full access starting at the root of the filesystem.', alternative: 'Use chmod -R 755 for folders and 644 for files, inside the project only.' },
  { id: 'H04', group: 'permissions-disk', pattern: /\bchmod\s+-R\s+a\+rwx\b/, reason: 'This gives everyone full read, write, and run access to a whole folder tree.', alternative: 'Use chmod -R 755 for folders and 644 for files, or set access for one folder only.' },
  { id: 'H05', group: 'permissions-disk', pattern: /\bmkfs\b/, reason: 'This formats a disk and erases everything on it.', alternative: 'Check the disk name with lsblk or diskutil list first, and format only a disk you mean to erase.' },
  { id: 'H06', group: 'permissions-disk', pattern: /\bmkfs\.(?:ext4|vfat|ntfs|xfs)\b/, reason: 'This formats a disk and erases everything on it.', alternative: 'Check the disk name with lsblk or diskutil list first, and format only a disk you mean to erase.' },
  { id: 'H07', group: 'permissions-disk', pattern: /\bdd\b[^;]*\bof=\/dev\//, reason: 'This writes raw data straight to a disk device and can erase the disk.', alternative: 'Check the device name first, write to a file instead, and double check the of= value.' },
  { id: 'H08', group: 'permissions-disk', pattern: /\bdd\b[^;]*\bof=\/dev\/sda\b/, reason: 'This writes raw data straight to the main disk and can erase the whole system.', alternative: 'Write to a file instead, and double check the of= value.' },
  { id: 'H09', group: 'permissions-disk', pattern: /\bdd\b[^;]*\bof=\/dev\/disk\d*\b/, reason: 'This writes raw data straight to a disk device and can erase the disk.', alternative: 'Check the device name first, write to a file instead, and double check the of= value.' },
  { id: 'H10', group: 'permissions-disk', pattern: /\bdiskpart\b[^;]*\bclean\b/i, reason: 'This erases a disk in Windows diskpart.', alternative: 'Check the disk number with list disk first, and clean only a disk you mean to erase.' },

  // Group I: secret reads (12 rules)
  { id: 'I01', group: 'secret-read', pattern: /(?:^|[\s"'])(?:\.env|.*\/\.env)(?:\s|$|["'])/, reason: 'This reads a .env file, which usually holds secrets and API keys.', alternative: 'Read the .env.example file instead, which should hold only placeholder names.' },
  { id: 'I02', group: 'secret-read', pattern: /\bcat\s+[^\n]*\.env(?!\.(?:example|sample|template))\b/, reason: 'This prints a .env file, which usually holds secrets and API keys.', alternative: 'Print the .env.example file instead, which should hold only placeholder names.' },
  { id: 'I03', group: 'secret-read', pattern: /\.pem\b/, reason: 'This reads a private key file.', alternative: 'Use the key through the tool that needs it, and do not print or copy the key itself.' },
  { id: 'I04', group: 'secret-read', pattern: /\bid_rsa\b/, reason: 'This reads a private SSH key.', alternative: 'Use the key through ssh, and do not print or copy the key itself.' },
  { id: 'I05', group: 'secret-read', pattern: /\bid_ed25519\b/, reason: 'This reads a private SSH key.', alternative: 'Use the key through ssh, and do not print or copy the key itself.' },
  { id: 'I06', group: 'secret-read', pattern: /\.aws\/credentials\b/, reason: 'This reads AWS credentials.', alternative: 'Use the AWS CLI with a named profile, and do not print the credentials file.' },
  { id: 'I07', group: 'secret-read', pattern: /\bcat\s+[^\n]*\.aws\/credentials\b/, reason: 'This prints AWS credentials.', alternative: 'Use the AWS CLI with a named profile, and do not print the credentials file.' },
  { id: 'I08', group: 'secret-read', pattern: /\.env\.(?:local|production|prod)\b/, reason: 'This reads a production .env file, which holds live secrets.', alternative: 'Read the .env.example file instead, which should hold only placeholder names.' },
  { id: 'I09', group: 'secret-read', pattern: /\*\*\/\.env(?!\.(?:example|sample|template))\b/, reason: 'This searches for .env files, which usually hold secrets.', alternative: 'Search for .env.example files instead.' },
  { id: 'I10', group: 'secret-read', pattern: /\.npmrc\b/, reason: 'This reads an npm config file, which can hold an auth token.', alternative: 'Check the token is set in the environment, and do not print the file.' },
  { id: 'I11', group: 'secret-read', pattern: /\.docker\/config\.json\b/, reason: 'This reads Docker config, which can hold registry credentials.', alternative: 'Use docker login with a credential helper, and do not print the file.' },
  { id: 'I12', group: 'secret-read', pattern: /\bcredentials\.json\b/, reason: 'This reads a credentials file.', alternative: 'Use the credential through the tool that needs it, and do not print the file itself.' },

  // Group J: secret writes (12 rules)
  { id: 'J01', group: 'secret-write', pattern: /AKIA[0-9A-Z]{16}/, reason: 'This writes an AWS access key id into a file or command.', alternative: 'Store the key in an environment variable or a secret manager, not in a file.' },
  { id: 'J02', group: 'secret-write', pattern: /sk-ant-[A-Za-z0-9\-_]{10,}/, reason: 'This writes an Anthropic API key into a file or command.', alternative: 'Store the key in an environment variable or a secret manager, not in a file.' },
  { id: 'J03', group: 'secret-write', pattern: /sk-proj-[A-Za-z0-9\-_]{10,}/, reason: 'This writes an OpenAI project API key into a file or command.', alternative: 'Store the key in an environment variable or a secret manager, not in a file.' },
  { id: 'J04', group: 'secret-write', pattern: /ghp_[A-Za-z0-9]{20,}/, reason: 'This writes a GitHub personal access token into a file or command.', alternative: 'Store the token in an environment variable or a secret manager, not in a file.' },
  { id: 'J05', group: 'secret-write', pattern: /github_pat_[A-Za-z0-9_]{20,}/, reason: 'This writes a GitHub fine-grained token into a file or command.', alternative: 'Store the token in an environment variable or a secret manager, not in a file.' },
  { id: 'J06', group: 'secret-write', pattern: /xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]{10,}/, reason: 'This writes a Slack bot token into a file or command.', alternative: 'Store the token in an environment variable or a secret manager, not in a file.' },
  { id: 'J07', group: 'secret-write', pattern: /xoxp-[0-9]+-[0-9]+-[A-Za-z0-9]{10,}/, reason: 'This writes a Slack user token into a file or command.', alternative: 'Store the token in an environment variable or a secret manager, not in a file.' },
  { id: 'J08', group: 'secret-write', pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/, reason: 'This writes a JWT, which can act as a login token, into a file or command.', alternative: 'Store the token in an environment variable or a secret manager, not in a file.' },
  { id: 'J09', group: 'secret-write', pattern: /-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----/, reason: 'This writes a private key into a file or command.', alternative: 'Keep the private key in its own key file with strict permissions, and do not copy it into other files.' },
  { id: 'J10', group: 'secret-write', pattern: /aws_secret_access_key\s*=\s*[A-Za-z0-9\/+=]{20,}/i, reason: 'This writes an AWS secret key into a file or command.', alternative: 'Store the key in an environment variable or a secret manager, not in a file.' },
  { id: 'J11', group: 'secret-write', pattern: /sk-[A-Za-z0-9]{20,}/, reason: 'This writes an API key starting with sk- into a file or command.', alternative: 'Store the key in an environment variable or a secret manager, not in a file.' },
  { id: 'J12', group: 'secret-write', pattern: /(?:api[_-]?key|API_KEY)\s*[:=]\s*["'][A-Za-z0-9\-_]{16,}["']/, reason: 'This writes an API key value into a file or command.', alternative: 'Store the key in an environment variable or a secret manager, not in a file.' },

  // Group K: settings tamper (6 rules)
  { id: 'K01', group: 'settings-tamper', pattern: /\.claude\/settings\.json[\s\S]*"hooks"\s*:\s*null/, reason: 'This would turn off the Deadbolt hooks in the Claude Code settings file.', alternative: 'Edit the settings file by hand if you mean to change hooks, and keep Deadbolt turned on.' },
  { id: 'K02', group: 'settings-tamper', pattern: /\.claude\/settings\.json[\s\S]*"hooks"\s*:\s*\[\s*\]/, reason: 'This would empty the hooks list in the Claude Code settings file.', alternative: 'Edit the settings file by hand if you mean to change hooks, and keep Deadbolt turned on.' },
  { id: 'K03', group: 'settings-tamper', pattern: /\.claude\/settings\.json[\s\S]*"hooks"\s*:\s*\{\s*\}/, reason: 'This would empty the hooks in the Claude Code settings file.', alternative: 'Edit the settings file by hand if you mean to change hooks, and keep Deadbolt turned on.' },
  { id: 'K04', group: 'settings-tamper', pattern: /(?:settings\.json)[\s\S]*hooks[\s\S]*\bdisabled\b/i, reason: 'This would disable hooks in the Claude Code settings file.', alternative: 'Keep hooks enabled, and change one hook at a time by hand if you need to.' },
  { id: 'K05', group: 'settings-tamper', pattern: /\brm\s+[^\n]*\.claude\/settings\.json\b/, reason: 'This would delete the Claude Code settings file, including the Deadbolt hooks.', alternative: 'Edit the settings file by hand instead of deleting it.' },
  { id: 'K06', group: 'settings-tamper', pattern: /\b(?:sed|jq)\b[^\n]*\.claude\/settings\.json[^\n]*\bdel\(\.hooks\)/, reason: 'This would remove the hooks from the Claude Code settings file.', alternative: 'Edit the settings file by hand if you mean to change hooks, and keep Deadbolt turned on.' },

  // Group L: production database connection strings (8 rules)
  { id: 'L01', group: 'prod-db-string', pattern: /postgres(?:ql)?:\/\/[^\s]*prod[^\s]*/i, reason: 'This uses a production Postgres connection string.', alternative: 'Use a local or staging database for this command, and check the connection string first.' },
  { id: 'L02', group: 'prod-db-string', pattern: /DATABASE_URL\s*=\s*[^\s]*prod[^\s]*/i, reason: 'This sets a database URL that points at production.', alternative: 'Use a local or staging database URL for this command.' },
  { id: 'L03', group: 'prod-db-string', pattern: /mysql:\/\/[^\s]*prod[^\s]*/i, reason: 'This uses a production MySQL connection string.', alternative: 'Use a local or staging database for this command, and check the connection string first.' },
  { id: 'L04', group: 'prod-db-string', pattern: /mongodb(?:\+srv)?:\/\/[^\s]*prod[^\s]*/i, reason: 'This uses a production MongoDB connection string.', alternative: 'Use a local or staging database for this command, and check the connection string first.' },
  { id: 'L05', group: 'prod-db-string', pattern: /\bpsql\b[^\n]*prod\b/i, reason: 'This opens a psql session against a production database.', alternative: 'Use a local or staging database for this command.' },
  { id: 'L06', group: 'prod-db-string', pattern: /postgres(?:ql)?:\/\/[^\s]*production[^\s]*/i, reason: 'This uses a production Postgres connection string.', alternative: 'Use a local or staging database for this command, and check the connection string first.' },
  { id: 'L07', group: 'prod-db-string', pattern: /DATABASE_URL\s*=\s*postgres(?:ql)?:\/\/[^\s]*prod[^\s]*/i, reason: 'This sets a database URL that points at production.', alternative: 'Use a local database URL, and check the host before you run it.' },
  { id: 'L08', group: 'prod-db-string', pattern: /\bmysql\b[^\n]*-h\s+[^\s]*prod[^\s]*/i, reason: 'This connects mysql to a production host.', alternative: 'Use a local or staging database host for this command.' }
];

const SAFE_RM_TARGETS = new Set([
  'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage',
  'tmp', 'temp', '__pycache__', '.pytest_cache'
]);

function isSafeRmTarget(target) {
  if (!target) return false;
  const clean = target.replace(/^\.\//, '').replace(/\/+$/, '').replace(/^["']|["']$/g, '');
  if (SAFE_RM_TARGETS.has(clean)) return true;
  const first = clean.split('/')[0];
  if (SAFE_RM_TARGETS.has(first) && !clean.includes('..')) return true;
  return false;
}

function extractNested(text) {
  const found = [];
  if (!text) return found;
  // bash -c '...' , sh -c "...", powershell -Command "..."
  const shellC = /(?:bash|sh|zsh)\s+-c\s+["']([^"']+)["']/g;
  let m;
  while ((m = shellC.exec(text)) !== null) found.push(m[1]);
  const ps = /powershell\s+(?:-Command|-c)\s+["']([^"']+)["']/gi;
  while ((m = ps.exec(text)) !== null) found.push(m[1]);
  // $(...) and backticks, recursively one level deep
  const dollarParen = /\$\(([^)]+)\)/g;
  while ((m = dollarParen.exec(text)) !== null) found.push(m[1]);
  const backtick = /`([^`]+)`/g;
  while ((m = backtick.exec(text)) !== null) found.push(m[1]);
  return found;
}

function splitCommands(text) {
  if (!text) return [];
  // Split on &&, ||, ;, |, and newlines. Quotes are not fully parsed,
  // which is fine for a guardrail: we re-scan the whole text as well.
  return text.split(/&&|\|\||;|\||\n/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function getScanText(input) {
  const tool = input.tool_name || input.tool || '';
  const ti = input.tool_input || input.input || {};
  const parts = [];
  if (typeof ti.command === 'string') parts.push(ti.command);
  if (typeof ti.file_path === 'string') parts.push(ti.file_path);
  if (typeof ti.pattern === 'string') parts.push(ti.pattern);
  if (typeof ti.content === 'string') parts.push(ti.content);
  if (typeof ti.new_string === 'string') parts.push(ti.new_string);
  if (typeof ti.old_string === 'string') parts.push(ti.old_string);
  if (typeof ti.filePath === 'string') parts.push(ti.filePath);
  // For settings tamper detection, the file path plus the content must be
  // scanned together, so join with a space.
  return { tool: tool, text: parts.join(' '), parts: parts, toolInput: ti };
}

function hasDeleteWithoutWhere(text) {
  // Find each DELETE FROM statement and check for a WHERE before the
  // next semicolon or the end of the statement.
  const re = /\bDELETE\s+FROM\s+[^\s;]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rest = text.slice(m.index);
    const end = rest.search(/;/);
    const stmt = end === -1 ? rest : rest.slice(0, end);
    if (!/\bWHERE\b/i.test(stmt)) return true;
  }
  return false;
}

function isRmSafeOnly(text) {
  // True only when every rm in the text targets a safe folder.
  const segments = splitCommands(text);
  let sawRm = false;
  for (const seg of segments) {
    if (!/\brm\b/.test(seg)) continue;
    sawRm = true;
    // Extract tokens after rm flags.
    const after = seg.replace(/^\s*(?:sudo\s+)?rm\s+/, '').replace(/(?:^|\s)-[a-zA-Z]+\s*/g, ' ').trim();
    const tokens = after.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    for (const t of tokens) {
      if (t.startsWith('-')) continue;
      if (!isSafeRmTarget(t)) return false;
    }
  }
  return sawRm;
}

function evaluate(input) {
  const scanned = getScanText(input);
  const tool = scanned.tool;
  const text = scanned.text;
  const fragments = [text];
  for (const part of scanned.parts) {
    for (const n of extractNested(part)) fragments.push(n);
    for (const s of splitCommands(part)) fragments.push(s);
  }
  const allText = fragments.join('\n');

  // Special case: DELETE without WHERE. This needs statement level
  // checking, not a single regex, because DELETE with WHERE is allowed.
  if (hasDeleteWithoutWhere(allText)) {
    return {
      decision: 'deny',
      ruleId: 'E07',
      group: 'sql-destructive',
      reason: 'This DELETE has no WHERE clause, so it would delete every row in the table.',
      alternative: 'Add a WHERE clause that names the exact rows, and test it with SELECT first.'
    };
  }

  const rmSafeOnly = /\brm\b/.test(allText) ? isRmSafeOnly(allText) : false;

  // Special case: git push --force or -f to main, master, prod, or
  // production, in any argument order. Force push to a feature branch
  // is allowed, so check the branch name, not just the force flag.
  if (/\bgit\s+push\b/.test(allText) && /(?:--force(?!\-with\-lease)\b|\s-f(?:\s|$))/.test(allText)) {
    const branchMatch = allText.match(/\bgit\s+push\b[^\n;|&]*/);
    const pushText = branchMatch ? branchMatch[0] : allText;
    if (/\b(?:main|master|prod|production)\b/.test(pushText)) {
      return {
        decision: 'deny',
        ruleId: 'D01',
        group: 'git-destructive',
        reason: 'This would force push to a protected branch and can erase work other people have pushed.',
        alternative: 'Push to a feature branch, or use git push --force-with-lease on a branch you own.'
      };
    }
  }

  const hasPlainForce = /--force(?!\-with\-lease)\b/.test(allText) || /(?:^|\s)-f(?:\s|$)/.test(allText);

  function ruleMatches(rule) {
    if (rule.pattern.test(allText)) return true;
    for (const frag of fragments) {
      // Reset lastIndex for global patterns, then test each fragment
      // on its own so a trailing quote or newline does not hide a
      // protected path such as rm -rf / inside sh -c "...".
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(frag)) return true;
    }
    return false;
  }

  for (const rule of RULES) {
    // --force-with-lease is the safe form, so skip the plain force
    // push rules when it is the only force flag present.
    if ((rule.id === 'D01' || rule.id === 'D02' || rule.id === 'D03' || rule.id === 'D04' || rule.id === 'D05' || rule.id === 'D06') && !hasPlainForce) continue;
    // Skip the generic secret read rule I01 for Write/Edit content that
    // merely mentions .env as a file name in a safe way is handled by
    // the more specific rules below. Keep I01 for Read/Glob/Bash.
    if (ruleMatches(rule)) {
      // Safe allowlist overrides rm rules only.
      if (rule.group === 'recursive-delete-protected' || rule.group === 'empty-variable-delete' || rule.group === 'command-substitution-delete') {
        if (rmSafeOnly) continue;
      }
      // Secret read rules: only apply to Read, Glob, and Bash. A Write
      // that mentions .env in its path is handled by secret write rules
      // if it contains a secret, otherwise it is allowed.
      if (rule.group === 'secret-read') {
        if (tool === 'Write' || tool === 'Edit') {
          // A Write to .env itself is a secret write risk only when it
          // contains a secret value, which the J rules catch. Allow a
          // plain .env write to pass this check.
          if (rule.id === 'I01' || rule.id === 'I08') continue;
        }
        // For Read/Glob, the file path is the scan text. For Bash, cat
        // and similar are caught by I02/I07. I01 is broad, so only use
        // it when the tool is Read or Glob, or when the text is a bare
        // .env path.
        if (rule.id === 'I01') {
          const isReadLike = tool === 'Read' || tool === 'Glob' || tool === 'Bash';
          if (!isReadLike) continue;
        }
      }
      // Secret write rules: apply to Write, Edit, and Bash with a
      // redirect or echo. For Read, a secret pattern in a file path
      // is not a write, so skip J rules for Read/Glob.
      if (rule.group === 'secret-write') {
        if (tool === 'Read' || tool === 'Glob') continue;
      }
      return {
        decision: 'deny',
        ruleId: rule.id,
        group: rule.group,
        reason: rule.reason,
        alternative: rule.alternative
      };
    }
  }

  // Fail closed: rm -rf with an unparseable target.
  if (/\brm\b[^;]*-[a-zA-Z]*r[a-zA-Z]*f\b/i.test(allText) || /\brm\b[^;]*-[a-zA-Z]*f[a-zA-Z]*r\b/i.test(allText)) {
    const segments = splitCommands(allText);
    for (const seg of segments) {
      if (!/\brm\b/.test(seg)) continue;
      if (rmSafeOnly) continue;
      const after = seg.replace(/^\s*(?:sudo\s+)?rm\s+/, '');
      // No target at all, or a target that is a variable, substitution,
      // wildcard, or empty string, is unparseable: deny.
      if (!after.trim() || /\$\{?\s*\}?/.test(after) || /\$\(/.test(after) || /`/.test(after) || /(?:^|\s)\*\s*(?:$|[;&|])/.test(after)) {
        return {
          decision: 'deny',
          ruleId: 'B01',
          group: 'empty-variable-delete',
          reason: 'The rm -rf target cannot be checked, so it is blocked rather than risking the wrong folder.',
          alternative: 'Write the folder name out in full, for example rm -rf ./tmp, and check it with ls first.'
        };
      }
    }
  }

  // Note: there is no generic fallback for the bare word DROP here.
  // DROP DATABASE, DROP TABLE, DROP SCHEMA, DROP INDEX, and DROP
  // COLUMN are all blocked by the E rules above. A bare word drop in
  // ordinary text, such as echo "drop by later", is not a database
  // command and must be allowed.

  return { decision: 'allow', ruleId: null, group: null, reason: null, alternative: null };
}

function hookOutput(result) {
  if (result.decision === 'deny') {
    const reason = result.reason + ' Safe alternative: ' + result.alternative;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow'
    }
  };
}

function appendLog(logPath, entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Logging must never block the hook. Report to stderr only.
    process.stderr.write('Deadbolt: could not write log: ' + err.message + '\n');
  }
}

function printHelp() {
  process.stdout.write(
    'Deadbolt for Claude Code\n' +
    'Usage: node src/deadbolt.js [--dry-run] [--explain] [--log <path>] [--command "<cmd>"] [--list-rules] [--help]\n' +
    'Reads a PreToolUse JSON object from stdin and writes a hook JSON decision to stdout.\n' +
    'Options:\n' +
    '  --dry-run        Evaluate and print the decision without writing to the log.\n' +
    '  --explain        Print a plain language explanation to stderr as well as the JSON.\n' +
    '  --log <path>     Write the decision to this JSONL audit log.\n' +
    '  --command "<cmd>"  Evaluate one Bash command instead of reading stdin.\n' +
    '  --list-rules     Print every rule id and group, then exit.\n' +
    '  --help           Print this help.\n' +
    'Environment:\n' +
    '  DEADBOLT_LOG     Path to the JSONL audit log. Empty means no logging.\n'
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.includes('--list-rules')) {
    for (const r of RULES) process.stdout.write(r.id + ' ' + r.group + '\n');
    process.stdout.write('Total rules: ' + RULES.length + '\n');
    return;
  }

  const dryRun = args.includes('--dry-run');
  const explain = args.includes('--explain');
  let logPath = process.env.DEADBOLT_LOG || null;
  let commandArg = null;
  let inputArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--log' && args[i + 1]) { logPath = args[i + 1]; i++; }
    if (args[i] === '--command' && args[i + 1]) { commandArg = args[i + 1]; i++; }
    if (args[i] === '--input' && args[i + 1]) { inputArg = args[i + 1]; i++; }
    if (args[i] === '--json' && args[i + 1]) { inputArg = args[i + 1]; i++; }
  }
  // A bare non-flag argument is treated as JSON input.
  if (!commandArg && !inputArg) {
    const bare = args.find(function (a) { return !a.startsWith('--'); });
    if (bare) inputArg = bare;
  }

  function handle(rawText) {
    let input = null;
    let parsed = null;
    const raw = (rawText || '').trim();
    if (commandArg) {
      parsed = { tool_name: 'Bash', tool_input: { command: commandArg } };
    } else if (inputArg) {
      try { parsed = JSON.parse(inputArg); } catch (e) { parsed = null; }
    } else if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }

    let result;
    let commandForLog = '';
    let toolForLog = '';
    if (!parsed) {
      // Unparseable input: fail closed only for destructive looking text.
      const looksDestructive = /\brm\s+-[a-z]*r[a-z]*f\b/i.test(raw) || /\bDROP\b/i.test(raw) || /\bTRUNCATE\b/i.test(raw);
      if (looksDestructive) {
        result = {
          decision: 'deny',
          ruleId: 'FALLBACK',
          group: 'fail-closed',
          reason: 'The input could not be read, and it looks destructive, so it is blocked.',
          alternative: 'Run the command by hand after checking it, or fix the hook input so Deadbolt can read it.'
        };
      } else {
        result = { decision: 'allow', ruleId: null, group: null, reason: null, alternative: null };
      }
      commandForLog = raw.slice(0, 500);
      toolForLog = 'unknown';
    } else {
      input = parsed;
      result = evaluate(input);
      const scanned = getScanText(input);
      commandForLog = scanned.text.slice(0, 500);
      toolForLog = scanned.tool || 'unknown';
    }

    const out = hookOutput(result);
    process.stdout.write(JSON.stringify(out) + '\n');

    if (explain || dryRun) {
      if (result.decision === 'deny') {
        process.stderr.write('Deadbolt: BLOCKED [' + (result.ruleId || '') + ' ' + (result.group || '') + '] ' + result.reason + ' Safe alternative: ' + result.alternative + '\n');
      } else {
        process.stderr.write('Deadbolt: ALLOWED\n');
      }
    }

    if (!dryRun && logPath) {
      appendLog(logPath, {
        timestamp: new Date().toISOString(),
        tool: toolForLog,
        command: commandForLog,
        decision: result.decision,
        rule_id: result.ruleId,
        reason: result.reason || ''
      });
    }
  }

  if (commandArg || inputArg) {
    handle('');
    return;
  }

  // Read stdin fully.
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) { data += chunk; });
  process.stdin.on('end', function () { handle(data); });
  // If stdin is a TTY with no data, handle empty input at once.
  if (process.stdin.isTTY) handle('');
}

if (require.main === module) main();

module.exports = { evaluate: evaluate, RULES: RULES, hookOutput: hookOutput, SAFE_RM_TARGETS: SAFE_RM_TARGETS };
