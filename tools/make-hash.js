#!/usr/bin/env node
'use strict';
// Usage: node tools/make-hash.js
// Prompts for a password (hidden) and prints the value for ADMIN_PASS_HASH.
// Also prints a fresh ADMIN_SESSION_SECRET. Nothing is stored or sent anywhere.
const crypto = require('crypto');
const { hashPassword } = require('../netlify/functions/_lib');

function ask(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode && stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const pw = process.argv[2] || (await ask('Choose admin password (min 12 chars): '));
  if (pw.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }
  const hash = await hashPassword(pw);
  console.log('\nADMIN_PASS_HASH=' + hash);
  console.log('ADMIN_SESSION_SECRET=' + crypto.randomBytes(48).toString('hex'));
  console.log('\nPaste these into Netlify environment variables (mark as secret).');
})();
