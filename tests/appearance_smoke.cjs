// Start Vite on 127.0.0.1:5179. Uses isolated browser state and synthetic UI data only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.resolve(__dirname,'../tmp/appearance-qa');
fs.mkdirSync(output,{recursive:true});
const origin = process.env.APPEARANCE_TEST_URL || 'http://127.0.0.1:5179';
async function seed(page) {
  await page.evaluate(async()=>{
    const { appStore } = await import('/src/stores/appStore.js');
    const { presenceStore } = await import('/src/stores/presenceStore.js');
    const { chatStore } = await import('/src/stores/chatStore.js');
    const { workspaceStore } = await import('/src/stores/workspaceStore.js');
    const { profileStore } = await import('/src/stores/profileStore.js');
    const people=['林间','北岛','远山','rain'].map((name,i)=>({identity:'qa-'+i,userId:'qa-'+i,displayName:name,avatarColor:['#647aa5','#826ba5','#568e80','#596fac'][i],avatarPreset:'',channelId:'game'}));
    Object.assign(profileStore,{displayName:'rain',userId:'qa-3',avatarPreset:'',avatarUrl:''});
    Object.assign(appStore.connection,{isInLobby:true,isConnected:true,currentChannel:'game',username:'rain'});
    Object.assign(appStore.media,{micOn:true});
    Object.assign(presenceStore,{connected:true,identity:'qa-3',userId:'qa-3',livekitConnected:true,currentVoiceChannelId:'game',voiceMembers:people,speakingIdentities:{'qa-0':true},participants:Object.fromEntries(people.map(p=>[p.identity,p])),channels:[{id:'lobby',displayName:'大厅',isLobby:true,members:[]},{id:'game',displayName:'游戏频道',members:people},{id:'chat',displayName:'闲聊频道',members:[]}]});
    Object.assign(workspaceStore,{supported:true,viewChannel:'game',cards:[{id:'qa-card',game:'饥荒联机版',ownerName:'林间',ownerId:'qa-0',updatedAt:Date.now(),targetChannel:'game',note:'继续昨天的存档，轻松玩，不赶进度。',interests:people.slice(0,3)}]});
    Object.assign(chatStore,{currentChannelId:'game',messages:[
      {id:'qa-msg-1',sender:'林间',senderName:'林间',senderId:'qa-0',content:'今晚继续昨天那个存档？',timestamp:Date.now()-180000,reactions:{}},
      {id:'qa-msg-2',sender:'北岛',senderName:'北岛',senderId:'qa-1',content:'可以，房间已经开好了。\n进来之前记得更新一下模组。',timestamp:Date.now()-120000,reactions:{'👍':['qa-0','qa-2']}},
      {id:'qa-msg-3',sender:'rain',senderName:'rain',senderId:'qa-3',isSelf:true,content:'来了，耳机和麦克风都准备好了。',timestamp:Date.now()-60000,reactions:{}},
    ]});
  });
}
async function geometry(page, label) {
  const result=await page.evaluate(()=>{
    const visible=el=>el.checkVisibility()&&getComputedStyle(el).display!=='none';
    const dock=document.querySelector('.call-dock').getBoundingClientRect();
    const offscreen=[...document.querySelectorAll('.call-actions>button,.call-actions>.dock-control-group>button,.call-tools>button,.call-tools>.dock-control-group>button')].filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.x<0||r.right>innerWidth+1||r.y<dock.y||r.bottom>innerHeight+1}).map(el=>el.textContent.trim());
    return {overflow:document.documentElement.scrollWidth>innerWidth,offscreen};
  });
  assert.equal(result.overflow,false,label+' page overflow');
  assert.deepEqual(result.offscreen,[],label+' toolbar clipping');
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:820},reducedMotion:'reduce'});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.goto(origin);
    await page.locator('.call-dock').waitFor();
    await page.screenshot({path:path.join(output,'welcome.png')});
    await page.getByRole('button',{name:'外观设置',exact:true}).click();
    for(const [id,name] of [['graphite','石墨'],['smoke-glass','烟玻璃'],['midnight-blue','午夜蓝'],['silver','银灰']]) {
      await page.getByRole('button',{name:name+'主题',exact:true}).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'),id);
      await page.screenshot({path:path.join(output,id+'-settings.png')});
    }
    await page.getByRole('button',{name:'烟玻璃主题',exact:true}).click();
    await page.locator('#glass-opacity').fill('74');
    await page.getByRole('button',{name:'紧凑',exact:true}).click();
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'),'smoke-glass');
    assert.equal(await page.locator('html').getAttribute('data-density'),'compact');
    assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--dc-glass-opacity')),'74%');
    await page.evaluate(async()=>{const {setAppearance}=await import('/src/stores/themeStore.js');setAppearance({density:'comfortable',glassOpacity:82});});
    await seed(page);
    for(const id of ['graphite','smoke-glass','midnight-blue','silver']){
      await page.evaluate(async id=>(await import('/src/stores/themeStore.js')).setTheme(id),id);
      await geometry(page,id);
      await page.screenshot({path:path.join(output,id+'-room.png')});
    }
    await page.getByTitle('插入表情').click();
    await page.locator('.emoji-picker').waitFor();
    await page.screenshot({path:path.join(output,'silver-emoji.png')});
    await page.keyboard.press('Escape');
    for(const [width,height] of [[1208,780],[1000,720],[800,600],[480,800]]){
      await page.setViewportSize({width,height});
      await geometry(page,width+'px');
      await page.screenshot({path:path.join(output,'room-'+width+'.png')});
      await page.getByRole('button',{name:'外观设置',exact:true}).click();
      await page.getByRole('button',{name:'石墨主题',exact:true}).click();
      await page.getByRole('button',{name:'银灰主题',exact:true}).click();
      await page.screenshot({path:path.join(output,'settings-'+width+'.png')});
      await page.getByRole('button',{name:'关闭设置',exact:true}).click();
      for(const [name,selector] of [['音频调节','.audio-quick-popup'],['共享画质','.screen-quick-popup']]) {
        await page.getByRole('button',{name,exact:true}).click();
        const rect=await page.locator(selector).boundingBox();
        assert.ok(rect&&rect.x>=0&&rect.y>=0&&rect.x+rect.width<=width+1&&rect.y+rect.height<=height+1,`${width}px ${name} clipped: ${JSON.stringify(rect)}`);
        await page.getByRole('button',{name,exact:true}).click();
        await page.locator('.workspace-brand').click();
      }
    }
    await page.setViewportSize({width:1280,height:820});
    await page.getByRole('button',{name:'音频调节',exact:true}).click();
    await page.locator('.audio-quick-popup').waitFor();
    await page.screenshot({path:path.join(output,'silver-audio-popup.png')});
    assert.deepEqual(errors,[]);
    console.log('Appearance QA passed: four themes, persistence, density, toolbar at 1280/1208/1000/800/480, popovers. Screenshots: '+output);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
