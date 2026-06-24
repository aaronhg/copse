// Shape of the claude-agent factory — constructed without ever invoking `claude`
// (we assert which stages exist per options; running a stage would shell out to the CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeAgent } from '../src/agents/claude.js';

test('makeClaudeAgent: plan/judge always; next only with stopCondition; report only with reportFormat', () => {
  const base = makeClaudeAgent({ goal: 'verify the buy flow' });
  assert.equal(typeof base.plan, 'function');
  assert.equal(typeof base.judge, 'function');
  assert.equal(base.next, undefined, 'no next without stopCondition');
  assert.equal(base.report, undefined, 'no report without reportFormat');

  const full = makeClaudeAgent({ goal: 'g', stopCondition: 'stop when done', reportFormat: 'markdown' });
  assert.equal(typeof full.next, 'function');
  assert.equal(typeof full.report, 'function');

  // usage() tracks cumulative cost/tokens; zero before any claude -p call
  assert.equal(typeof full.usage, 'function');
  assert.deepEqual(full.usage(), { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
});
