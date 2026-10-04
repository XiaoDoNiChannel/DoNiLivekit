// Isolated browser transport fixture. No real messages, media or accounts are used.
// Run Vite on 127.0.0.1:5183; PLAYWRIGHT_MODULE may point to the bundled package.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = process.env.OVERLAY_TEST_URL || 'http://127.0.0.1:5183';
const output = path.resolve(__dirname, '../tmp/overlay-team-qa');
fs.mkdirSync(output, { recursive: true });
async function seed(page) {
  await page.addInitScript(() => {
    const listeners = new Map();
    const status = { version: 1, visible: true, interactive: true, shortcutsReady: true, preferences: { opacity: .94, layout: 'compact', toggleShortcut: 'Ctrl+Alt+Shift+O', editShortcut: 'Ctrl+Alt+O' } };
    const snapshot = { session: 'session1', channel: '周末游戏频道', connected: true, reconnecting: false, micOn: true, screenOn: false, appAudioOn: true, theme: 'smoke-glass', networkWarning: false,
      panel: { chatChannelId: 'chat-a', chatChannel: '队伍聊天', chatConnected: true, unread: 2, mentions: 1, memberCount: 3, micLevel: 35, rttMs: 42, lossPercent: 0.2, jitterMs: 3.1, diagnosticsAt: Date.now(), availability: 'ready', issues: [],
        members: [{ identity: 'me', volumeIdentity: 'me', name: '自己', self: true, micOn: true, micVolume: 100 }, { identity: 'friend', volumeIdentity: 'friend', name: '北岛', self: false, micOn: true, micVolume: 85, audio: true, audioVolume: 60 }],
        messages: [{ id: '1', sender: '林间', content: '房间开好了，大家进来吧。', timestamp: Date.now() - 60000, status: 'sent' }, { id: '2', sender: '北岛', content: '房间号：846291\n这局结束后休息五分钟。', timestamp: Date.now(), status: 'sent' }],
        events: [{ id: 1, text: '北岛 加入频道', timestamp: Date.now() - 50000 }, { id: 2, text: '林间 开始共享程序音频', timestamp: Date.now() }], shares: [] } };
    let sequence = 1;
    const packet = () => ({ sequence, fresh: true, snapshot: structuredClone(snapshot) });
    const emit = (name, payload) => listeners.get(name)?.({ payload });
    window.__fixture = { status, snapshot, calls: [], fail: false, hold: false,
      publish() { sequence++; emit('overlay-snapshot', packet()); },
      setStatus(values) { Object.assign(status, values); status.version++; emit('overlay-status', structuredClone(status)); },
      stale() { emit('overlay-snapshot', { ...packet(), fresh: false }); },
    };
    window.__TAURI__ = { event: { listen: async (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); } }, core: { invoke: async (name, args) => {
      window.__fixture.calls.push({ name, args });
      if (name === 'overlay_read') return { status: structuredClone(status), packet: packet() };
      if (name === 'overlay_preferences') { Object.assign(status.preferences, args); window.__fixture.setStatus({}); return structuredClone(status); }
      if (name === 'overlay_control') { window.__fixture.setStatus({ interactive: args.action !== 'game', visible: args.action !== 'hide' }); return structuredClone(status); }
      if (name === 'overlay_action') {
        if (window.__fixture.fail) throw Error('发送失败，请重试');
        if (window.__fixture.hold) await new Promise(resolve => { window.__fixture.resolve = resolve; });
        const request = args.request;
        if (request.kind === 'chat') snapshot.panel.messages.push({ id: String(Date.now()), sender: '你', self: true, status: 'sending', content: request.content, timestamp: Date.now() });
        if (request.kind === 'read') { snapshot.panel.unread = 0; snapshot.panel.mentions = 0; }
        if (request.kind === 'volume') snapshot.panel.members.find(row => row.volumeIdentity === request.identity)[request.source === 'mic' ? 'micVolume' : 'audioVolume'] = request.value;
        window.__fixture.publish(); return;
      }
      if (name === 'overlay_mic') { snapshot.micOn = args.enabled; window.__fixture.publish(); return; }
    } }, window: { getCurrentWindow: () => ({ startResizeDragging: async () => {} }) } };
  });
}
async function refresh(page) { await page.evaluate(() => { window.__fixture.snapshot.panel.diagnosticsAt = Date.now(); window.__fixture.publish(); }); }
async function geometry(page, label) {
  const errors = await page.evaluate(() => {
    const root = document.querySelector('.status-overlay');
    const rect = root.getBoundingClientRect();
    return { horizontal: root.scrollWidth > root.clientWidth + 1,
      vertical: root.scrollHeight > root.clientHeight + 1,
      clipped: [...document.querySelectorAll('button, textarea')].filter(el => el.checkVisibility()).filter(el => { const r = el.getBoundingClientRect(); return r.x < rect.x || r.right > rect.right + 1 || r.top < rect.top || r.bottom > rect.bottom + 1; }).map(el => el.getAttribute('aria-label') || el.textContent) };
  });
  if (errors.horizontal || errors.vertical || errors.clipped.length) await page.screenshot({ path: path.join(output, 'layout-failure.png') });
  assert.equal(errors.horizontal, false, label + ' horizontal overflow');
  assert.equal(errors.vertical, false, label + ' outer scroll');
  assert.deepEqual(errors.clipped, [], label + ' clipped controls');
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 184 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await seed(page); await page.goto(origin + '/overlay.html');
    await page.getByRole('button', { name: '切换展开布局' }).waitFor();
    await geometry(page, 'compact'); await page.screenshot({ path: path.join(output, 'compact.png') });
    await page.setViewportSize({ width: 260, height: 140 }); await geometry(page, 'compact minimum');
    await page.getByRole('button', { name: '切换展开布局' }).click(); await page.setViewportSize({ width: 400, height: 500 });
    await geometry(page, 'chat'); await page.screenshot({ path: path.join(output, 'messages.png') });
    const textbox = page.getByRole('textbox', { name: '队伍消息' });
    await textbox.fill('你好');
    await textbox.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    assert.equal(await page.evaluate(() => window.__fixture.calls.filter(row => row.name === 'overlay_action').length), 0, 'IME must not send');
    await page.evaluate(() => { window.__fixture.fail = true; });
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('alert').waitFor(); assert.equal(await textbox.inputValue(), '你好');
    await page.evaluate(() => { window.__fixture.fail = false; });
    await textbox.press('Enter'); await page.waitForFunction(() => document.querySelector('textarea').value === '');
    assert.equal(await page.locator('.overlay-chat-message.self p').textContent(), '你好');
    await textbox.fill('频道 A 草稿');
    await page.evaluate(() => { window.__fixture.snapshot.panel.chatChannelId = 'chat-b'; window.__fixture.publish(); });
    await page.waitForFunction(() => document.querySelector('textarea').value === ''); await textbox.fill('频道 B 草稿');
    await page.evaluate(() => { window.__fixture.snapshot.panel.chatChannelId = 'chat-a'; window.__fixture.publish(); });
    await page.waitForFunction(() => document.querySelector('textarea').value === '频道 A 草稿');
    await page.getByRole('button', { name: '全部已读' }).click();
    assert.equal(await page.locator('.overlay-unread').textContent(), '未读 0');
    await page.evaluate(() => {
      const f = window.__fixture;
      f.snapshot.panel.messages = Array.from({ length: 30 }, (_, i) => ({ id: 'long-' + i, sender: '队友', content: '历史消息 ' + i, timestamp: Date.now(), status: 'sent' }));
      f.publish();
    });
    await page.locator('.overlay-chat-message').nth(29).waitFor();
    await page.locator('.overlay-messages').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await refresh(page);
    await page.evaluate(() => { const f = window.__fixture; f.snapshot.panel.messages.push({ id: 'new', sender: '队友', content: '<img src=x onerror=alert(1)>', timestamp: Date.now(), status: 'sent' }); f.publish(); });
    await page.getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor();
    assert.equal(await page.locator('.overlay-messages').evaluate(el => el.scrollTop), 0, 'new packets must not pull the reader to the bottom');
    assert.equal(await page.locator('.overlay-messages img').count(), 0, 'message text must never become HTML');
    await textbox.fill('等待发送的消息');
    await page.evaluate(() => { window.__fixture.hold = true; });
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(() => typeof window.__fixture.resolve === 'function');
    await page.evaluate(() => { const f = window.__fixture; f.snapshot.panel.chatChannelId = 'chat-b'; f.publish(); f.resolve(); f.hold = false; });
    await page.waitForFunction(() => !document.querySelector('textarea').disabled);
    assert.equal(await textbox.inputValue(), '频道 B 草稿', 'old completion must not clear the new channel draft');
    await page.evaluate(() => { window.__fixture.snapshot.panel.chatChannelId = 'chat-a'; window.__fixture.publish(); });
    for (const [name, filename] of [['动态', 'events'], ['语音', 'voice'], ['状态', 'status']]) {
      await refresh(page); await page.getByRole('button', { name, exact: true }).click(); await geometry(page, name);
      await page.screenshot({ path: path.join(output, filename + '.png') });
      await page.setViewportSize({ width: 340, height: 360 }); await geometry(page, name + ' minimum');
      await page.setViewportSize({ width: 400, height: 500 });
    }
    await page.getByRole('button', { name: '语音', exact: true }).click();
    await page.getByRole('slider', { name: '北岛的语音音量' }).fill('125');
    await page.getByRole('slider', { name: '北岛的语音音量' }).dispatchEvent('change');
    assert.equal(await page.evaluate(() => window.__fixture.snapshot.panel.members[1].micVolume), 125);
    await page.getByRole('button', { name: '状态', exact: true }).click();
    await page.evaluate(() => { const f = window.__fixture; f.snapshot.panel.rttMs = null; f.snapshot.theme = 'silver'; f.publish(); });
    assert.equal(await page.locator('.overlay-metrics dd').first().textContent(), '—');
    await page.screenshot({ path: path.join(output, 'status-silver.png') });
    await page.evaluate(() => window.__fixture.stale());
    assert.equal(await page.locator('.overlay-mic').isDisabled(), true);
    assert.equal(await page.locator('.overlay-metrics dd').first().textContent(), '—');
    await page.getByRole('button', { name: '消息', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
    await refresh(page); await page.setViewportSize({ width: 340, height: 360 }); await geometry(page, 'chat minimum');
    await page.getByRole('button', { name: '锁定并穿透' }).click();
    assert.equal(await textbox.isDisabled(), true); assert.equal(await page.locator('.overlay-mic').isDisabled(), true);
    await page.screenshot({ path: path.join(output, 'passthrough.png') });
    assert.deepEqual(errors, []); console.log('Overlay team UI smoke passed: layouts, tabs, chat/IME/drafts, volume, stale state, passthrough.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
