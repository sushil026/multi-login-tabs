import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripTestHook } from '../scripts/build.mjs';

const hooked = (body) => `before();\n// @test-hook:start (x)\n${body}\n// @test-hook:end\nafter();\n`;

test('removes everything between the markers and keeps the rest', () => {
  const out = stripTestHook(hooked('globalThis.mlx = { simulateRestart() {} };'));
  assert.equal(out, 'before();\nafter();\n');
});

test('refuses a file without markers, with a duplicate marker, or with them reversed', () => {
  assert.throws(() => stripTestHook('globalThis.mlx = {};'), /exactly one/);
  assert.throws(() => stripTestHook(`${hooked('a')}${hooked('b')}`), /exactly one/);
  assert.throws(() => stripTestHook('// @test-hook:end\nx\n// @test-hook:start\n'), /wrong order/);
});

test('refuses when the hook is still referenced outside the markers', () => {
  assert.throws(() => stripTestHook(`${hooked('a')}globalThis.mlx.engine;\n`), /still present/);
});

test('handles Windows line endings', () => {
  const out = stripTestHook(hooked('globalThis.mlx = 1;').replaceAll('\n', '\r\n'));
  assert.equal(out, 'before();\r\nafter();\r\n');
});
