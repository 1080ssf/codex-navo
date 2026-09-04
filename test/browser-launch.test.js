'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('official login Chrome uses an allocated fixed debugging port', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /function reserveLoopbackPort\(\)/);
  assert.match(server, /const requestedPort = existingPort \|\| await reserveLoopbackPort\(\)/);
  assert.match(server, /`--remote-debugging-port=\$\{requestedPort\}`/);
  assert.doesNotMatch(server, /['"]--remote-debugging-port=0['"]/);
});

test('background account inspection is truly headless and cleans failed or orphaned Chrome', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /async function recoverAccountChromeSession\(browserDir\)/);
  assert.match(server, /findAccountChromeProcess\(browserDir\)/);
  assert.match(server, /'--headless=new'/);
  assert.doesNotMatch(server, /--window-position=-32000,-32000/);
  assert.match(server, /stopProtocolBrowser\(\{ processPid: launchedProfile\?\.pid \|\| processPid, browserDir \}\)/);
  assert.match(server, /if \(!browserLeaseActive\) browser = \{ \.\.\.recovered, browserDir \}/);
});
