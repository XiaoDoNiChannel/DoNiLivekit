import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeThemeId, normalizeAppearance } from '../src/shared/themes.js';
import { createWindowAppearance } from '../src/features/windowAppearance.js';

test('saved legacy themes retain their closest palette; unknown themes use smoke glass', () => {
  for (const [old, next] of Object.entries({ 'doni-dark':'graphite', 'glass-dark':'smoke-glass', 'midnight-purple':'midnight-blue', 'soft-graphite':'graphite', silver:'silver' })) {
    assert.equal(normalizeThemeId(old), next);
  }
  assert.equal(normalizeThemeId(null), 'smoke-glass');
  assert.equal(normalizeThemeId('removed-theme'), 'smoke-glass');
});
test('invalid saved appearance cannot inject CSS or make surfaces unreadable', () => {
  assert.deepEqual(normalizeAppearance(), { glassOpacity:82, density:'comfortable' });
  assert.deepEqual(normalizeAppearance({ glassOpacity:'invalid', density:'other' }), { glassOpacity:82, density:'comfortable' });
  assert.equal(normalizeAppearance({ glassOpacity:0 }).glassOpacity, 65);
  assert.equal(normalizeAppearance({ glassOpacity:200 }).glassOpacity, 100);
  assert.deepEqual(normalizeAppearance({ glassOpacity:75, density:'compact' }), { glassOpacity:75, density:'compact' });
});
test('native theme updates finish in selection order and recover after a rejected call', async () => {
  const seen = [];
  let release;
  const update = createWindowAppearance(async theme => {
    if (theme === 'dark') await new Promise(resolve => { release = resolve; });
    seen.push(theme);
    if (theme === 'failure') throw new Error('unavailable');
  });
  const dark = update('dark');
  const light = update('light');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, []);
  release(); await Promise.all([dark, light]);
  assert.deepEqual(seen, ['dark', 'light']);
  await assert.rejects(update('failure'));
  await update('light');
  assert.equal(seen.at(-1), 'light');
});
