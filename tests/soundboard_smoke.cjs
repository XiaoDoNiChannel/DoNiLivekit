// Run with Vite on 127.0.0.1:5173 and PLAYWRIGHT_MODULE pointing to Playwright.
// Uses only an isolated local LiveKit server; never joins the user's channels.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'tmp', 'soundboard-qa'); fs.mkdirSync(output, { recursive: true });
const names = ['打你吗的打', '哦选择', '哦选择加速', '太tm白痴了', '我退役了我不打了', '再一再而不再三', '嘴巴为什么要念这一句', 'addbdg'];
const clips = names.map((name, i) => ({ id: `seed-${i + 1}.mp3`, name }));
const secret = 'isolated-soundboard-test-secret-2026';
function token(identity, room) {
  const now = Math.floor(Date.now() / 1000);
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = enc({ alg: 'HS256', typ: 'JWT' }) + '.' + enc({ iss: 'soundboardtest', sub: identity, nbf: now - 5, exp: now + 600, video: { room, roomJoin: true, canPublish: true, canSubscribe: true } });
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}
(async () => {
  const config = `port: 17880\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: 17881\n  udp_port: 17882\n  use_external_ip: false\nkeys:\n  soundboardtest: ${secret}\n`;
  const server = spawn(path.join(root, 'livekit-server.exe'), ['--config-body', config, '--node-ip', '127.0.0.1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stderr.on('data', data => { log = (log + data).slice(-12000); });
  server.stdout.on('data', data => { log = (log + data).slice(-12000); });
  let browser, receiverBrowser;
  try {
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) throw new Error(`Test server exited: ${log}`);
      try { await fetch('http://127.0.0.1:17880'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    receiverBrowser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    const rxPage = await receiverBrowser.newPage();
    await rxPage.goto(process.env.SOUNDBOARD_TEST_URL || 'http://127.0.0.1:5173/');
    const page = await browser.newPage({ viewport: { width: 1360, height: 960 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.exposeFunction('__sbInvoke', async (cmd, args) => {
      if (cmd === 'soundboard_list') return clips;
      if (cmd === 'soundboard_read') return fs.readFileSync(path.join(root, 'src-tauri/resources/soundboard', args.id.match(/\d+/)[0] + '.mp3')).toString('base64');
      if (cmd === 'soundboard_bind') return;
      throw new Error(`Unexpected command ${cmd}`);
    });
    await page.route('**/src/features/soundboard.js*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace('export function createSoundboardFeature(', 'function makeSoundboardFeature(')
        + '\nexport function createSoundboardFeature(options) { window.__sbFeature = makeSoundboardFeature({ ...options, available: true, invoke: window.__sbInvoke, listen: async()=>()=>{}, getRoom: ()=>window.__sbRoom, canSend: ()=>window.__sbMic && window.__sbRoom?.state === "connected" }); return window.__sbFeature; }';
      await route.fulfill({ response, body });
    });
    await page.route('**/api/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto(process.env.SOUNDBOARD_TEST_URL || 'http://127.0.0.1:5173/');
    await page.locator('.call-dock').waitFor();
    const report = await page.evaluate(async () => {
      await window.__sbFeature.start();
      const { soundboardStore } = await import('/src/stores/soundboardStore.js');
      window.__sbState = soundboardStore;
      return soundboardStore.items.map(c => ({ name: c.name, duration: c.duration, attenuation: c.attenuation, error: c.error }));
    });
    assert.equal(report.length, 8); assert.ok(report.every(c => c.duration > 0 && !c.error));
    await page.getByRole('button', { name: '一键喊话', exact: true }).click();
    await page.locator('.soundboard-dialog[open]').waitFor();
    await page.locator('#sb-master').fill('35');
    assert.equal(await page.evaluate(() => window.__sbState.volume), 35);
    await page.locator('#sb-master').fill('60');
    for (const [width, height] of [[1360, 960], [800, 600], [480, 800]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, `panel-${width}.png`) });
    }
    await rxPage.evaluate(async receiver => {
      const { LivekitClient: LK } = await import('/src/shared/livekit.js');
      const { createShareSubscriptions } = await import('/src/features/shareSubscriptions.js');
      window.__LK = LK;
      const receiveRoom = new LK.Room();
      const store = { shares: [], notices: [], watchingId: '' };
      window.__receiveSoundboard = true;
      const shares = createShareSubscriptions({ store, allowSoundboard: () => window.__receiveSoundboard });
      window.__testShares = shares; shares.attach(receiveRoom);
      receiveRoom.on(LK.RoomEvent.TrackPublished, (pub, peer) => shares.discover(pub, peer));
      const ctx = new AudioContext(); await ctx.resume();
      window.__meterContext = ctx; window.__peak = 0; window.__rms = 0;
      receiveRoom.on(LK.RoomEvent.TrackSubscribed, (track, pub, peer) => {
        if (!shares.allowTrack(pub, peer)) return;
        const node = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
        const analyser = ctx.createAnalyser(), mute = ctx.createGain(); mute.gain.value = 0;
        node.connect(analyser); analyser.connect(mute); mute.connect(ctx.destination);
        window.__analyser = analyser; window.__rxName = pub.trackName;
        const element = track.attach(); element.muted = true; document.body.appendChild(element); void element.play();
      });
      window.__meterTimer = setInterval(() => {
        if (!window.__analyser) return;
        const samples = new Float32Array(window.__analyser.fftSize); window.__analyser.getFloatTimeDomainData(samples);
        window.__rms = Math.sqrt(samples.reduce((a,b) => a + b*b, 0) / samples.length);
        window.__peak = Math.max(window.__peak, window.__rms);
        if (window.__rms < .0001) window.__quietSince ??= performance.now();
        else window.__quietSince = null;
      }, 20);
      await receiveRoom.connect('ws://127.0.0.1:17880', receiver, { autoSubscribe: false });
      window.__receiver = receiveRoom;
    }, token('receiver', 'soundboard-qa'));
    await page.evaluate(async sender => {
      const { LivekitClient: LK } = await import('/src/shared/livekit.js'); window.__LK = LK;
      const sendRoom = new LK.Room(); await sendRoom.connect('ws://127.0.0.1:17880', sender);
      window.__sbRoom = sendRoom; window.__sbMic = true;
      await window.__sbFeature.prepare();
    }, token('sender', 'soundboard-qa'));
    await rxPage.waitForFunction(() => window.__rxName === 'soundboard');
    await page.evaluate(() => window.__sbFeature.play('seed-6.mp3', true));
    await page.waitForTimeout(800);
    assert.ok(await rxPage.evaluate(() => window.__peak < .0001));
    await page.evaluate(() => window.__sbFeature.stop());
    await page.evaluate(() => window.__sbFeature.play('seed-6.mp3'));
    await rxPage.waitForFunction(() => window.__peak > .005, null, { timeout: 8000 });
    const receivedPeak = await rxPage.evaluate(() => window.__peak);
    await page.evaluate(() => window.__sbFeature.stop());
    await rxPage.evaluate(() => { window.__quietSince = null; });
    await rxPage.waitForFunction(() => window.__quietSince && performance.now() - window.__quietSince > 500);
    await rxPage.evaluate(() => { window.__peak = 0; });
    await page.evaluate(() => window.__sbFeature.play('seed-6.mp3', true));
    await page.waitForTimeout(600);
    assert.ok(await rxPage.evaluate(() => window.__peak < .0001), 'preview leaked to the other participant');
    await page.evaluate(() => window.__sbFeature.stop());
    await rxPage.evaluate(() => { window.__receiveSoundboard = false; window.__testShares.syncSoundboards(); });
    await rxPage.waitForFunction(() => [...window.__receiver.remoteParticipants.values()][0]?.audioTrackPublications.values().next().value?.isSubscribed === false);
    await rxPage.evaluate(() => { window.__receiveSoundboard = true; window.__testShares.syncSoundboards(); });
    await rxPage.waitForFunction(() => [...window.__receiver.remoteParticipants.values()][0]?.audioTrackPublications.values().next().value?.isSubscribed === true);
    await rxPage.evaluate(() => { window.__peak = 0; });
    await page.evaluate(async token => {
      await window.__sbFeature.reset(); await window.__sbRoom.disconnect();
      window.__sbRoom = new window.__LK.Room();
      await window.__sbRoom.connect('ws://127.0.0.1:17880', token);
      await window.__sbFeature.prepare();
      await window.__sbFeature.play('seed-6.mp3');
    }, token('sender', 'soundboard-qa'));
    await rxPage.waitForFunction(() => window.__peak > .005);
    await page.evaluate(async () => { await window.__sbFeature.reset(); await window.__sbRoom.disconnect(); });
    await rxPage.evaluate(async () => { await window.__receiver.disconnect(); clearInterval(window.__meterTimer); await window.__meterContext.close(); });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ clips: report, receivedPeak, checks: ['all files decoded', 'UI volume', 'responsive layouts', 'real LiveKit audio received', 'stop silences', 'preview isolated', 'unsubscribe/resubscribe', 'full disconnect and republish'], errors }, null, 2));
    console.log(JSON.stringify({ clips: report, receivedPeak, errors }, null, 2));
  } finally { await browser?.close(); await receiverBrowser?.close(); server.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
