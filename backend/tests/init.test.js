const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

test('Check that environment variables and package dependencies are defined', () => {
  assert.ok(fs.existsSync('.env') || fs.existsSync('.env.example'), '.env or .env.example should exist');
  assert.ok(fs.existsSync('package.json'), 'package.json file should exist');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(pkg.dependencies.express, 'express should be in dependencies');
  assert.ok(pkg.dependencies['better-sqlite3'], 'better-sqlite3 should be in dependencies');
  assert.ok(pkg.dependencies.dotenv, 'dotenv should be in dependencies');
});
