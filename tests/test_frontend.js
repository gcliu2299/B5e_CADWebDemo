// Test the actual UI sentence splitter without needing a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'script.js'), 'utf8');
const start = script.indexOf('function splitCommands(');
const end = script.indexOf('form.addEventListener(', start);
assert(start >= 0 && end > start, 'splitCommands implementation not found');
const context = vm.createContext({});
vm.runInContext(script.slice(start, end), context);
const split = (text) => Array.from(context.splitCommands(text));
assert.deepEqual(split('Draw a line from (1,2) to (6,2). Create a circle at (3,3).'), [
  'Draw a line from (1,2) to (6,2).', 'Create a circle at (3,3).'
]);
assert.deepEqual(split('Draw a line from (1.5,2.5) to (6,2); then create a point at (3,4)'), [
  'Draw a line from (1.5,2.5) to (6,2)', 'create a point at (3,4)'
]);
assert.deepEqual(split('Create a point at (1,2)\nCreate a circle at (0,0)'), [
  'Create a point at (1,2)', 'Create a circle at (0,0)'
]);
console.log('Frontend command splitting tests passed.');
