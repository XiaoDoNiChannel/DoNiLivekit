/**
 * 消息富文本渲染器
 * 支持：
 *  - Discord emoji :name: -> 对应 Unicode emoji 或自定义表情
 *  - **粗体** / *斜体* / ~~删除线~~ / `代码` / ```代码块```
 *  - @mention 高亮
 *  - URL 自动链接
 *  - 换行 \n -> <br>
 */

// ─── Discord emoji 映射（常用子集） ───────────────────────────────────────────
const DISCORD_EMOJI_MAP = {
  // 笑脸
  grinning: '😀', grin: '😁', joy: '😂', rofl: '🤣', smile: '😊',
  blush: '😊', wink: '😉', heart_eyes: '😍', kissing: '😗', stuck_out_tongue: '😛',
  thinking: '🤔', neutral_face: '😐', expressionless: '😑', unamused: '😒',
  disappointed: '😞', worried: '😟', angry: '😠', rage: '😡', cry: '😢',
  sob: '😭', fearful: '😨', cold_sweat: '😰', flushed: '😳', dizzy_face: '😵',
  exploding_head: '🤯', sunglasses: '😎', nerd_face: '🤓', money_mouth_face: '🤑',
  zipper_mouth_face: '🤐', shushing_face: '🤫', face_with_raised_eyebrow: '🤨',
  clown_face: '🤡', skull: '💀', ghost: '👻', alien: '👽', robot: '🤖',
  poop: '💩', fire: '🔥', sparkles: '✨', star: '⭐', dizzy: '💫',
  heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
  blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', broken_heart: '💔',
  // 手势
  thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎',
  clap: '👏', wave: '👋', ok_hand: '👌', v: '✌️', raised_hand: '✋',
  fist: '✊', punch: '👊', muscle: '💪', pray: '🙏', point_right: '👉',
  // 游戏/科技
  joystick: '🕹️', video_game: '🎮', computer: '💻', keyboard: '⌨️',
  headphones: '🎧', microphone: '🎤', speaker: '🔊', mute: '🔇',
  // 动物
  cat: '🐱', dog: '🐶', fox_face: '🦊', wolf: '🐺', bear: '🐻',
  panda_face: '🐼', koala: '🐨', tiger: '🐯', lion: '🦁',
  // 食物
  pizza: '🍕', hamburger: '🍔', fries: '🍟', hotdog: '🌭', taco: '🌮',
  sushi: '🍣', bento: '🍱', ramen: '🍜', rice: '🍚', tea: '🍵',
  coffee: '☕', beer: '🍺', wine_glass: '🍷', champagne: '🍾',
  // 符号
  white_check_mark: '✅', x: '❌', warning: '⚠️', no_entry: '⛔',
  information_source: 'ℹ️', question: '❓', exclamation: '❗',
  tada: '🎉', confetti_ball: '🎊', trophy: '🏆', medal: '🥇',
  // 天气
  sunny: '☀️', partly_sunny: '⛅', cloud: '☁️', rain: '🌧️', snowflake: '❄️',
  rainbow: '🌈', thunder: '⛈️', tornado: '🌪️',
  // 杂
  rocket: '🚀', airplane: '✈️', car: '🚗', train: '🚂',
  house: '🏠', office: '🏢', hospital: '🏥', school: '🏫',
  eyes: '👀', brain: '🧠', speech_balloon: '💬', thought_balloon: '💭',
  zzz: '💤', sleep: '😴', sweat_drops: '💦', boom: '💥',
  100: '💯', ok: '🆗', new: '🆕', up: '🆙', free: '🆓',
  egg: '🥚', hatching_chick: '🐣', chick: '🐥', bird: '🐦',
  penguin: '🐧', owl: '🦉', parrot: '🦜',
  salad: '🥗', broccoli: '🥦', carrot: '🥕', corn: '🌽',
  cherry_blossom: '🌸', rose: '🌹', tulip: '🌷', sunflower: '🌻',
  cactus: '🌵', four_leaf_clover: '🍀', seedling: '🌱', earth_asia: '🌏',
};

// ─── 工具 ────────────────────────────────────────────────────────────────────
/** 转义 HTML 特殊字符（防 XSS）。 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanImageUrl(url) {
  return String(url || '').replace(/"/g, '%22').replace(/</g, '').replace(/>/g, '');
}

function getUploadOrigin() {
  if (typeof window === 'undefined') return '';

  const saved = String(window.localStorage?.getItem('lk_server_ip') || '').trim();
  if (saved) {
    try {
      if (/^https?:\/\//i.test(saved)) {
        return new URL(saved).origin;
      }

      const normalized = saved.replace(/^wss?:\/\//i, '').replace(/\/$/, '');
      const [host, port = '5000'] = normalized.split(':');
      if (host) return `http://${host}:${port}`;
    } catch (_) {
      // fall through
    }
  }

  try {
    const { protocol, hostname, port, origin } = window.location;
    if ((protocol === 'http:' || protocol === 'https:') && hostname) {
      // Vite 开发服务通常在 5173，uploads 静态资源在 FastAPI 5000。
      if (port === '5173') return `${protocol}//${hostname}:5000`;
      return origin;
    }
  } catch (_) {
    // ignore
  }

  return '';
}

function sanitizeImageUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';

  // 后端上传图片统一走 /uploads/。在 Vite/Tauri 前端里，相对 /uploads 会指向前端服务，
  // 所以这里解析到 FastAPI 的 origin，避免图片只显示 broken image 图标。
  if (raw.startsWith('/uploads/')) {
    const origin = getUploadOrigin();
    return cleanImageUrl(origin ? `${origin}${raw}` : raw);
  }

  // 兼容未来如果后端返回完整 http(s) URL 的情况。
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return cleanImageUrl(parsed.href);
    }
  } catch (_) {
    // ignore invalid URL
  }

  return '';
}

function buildImageHtml(src, alt = '聊天图片') {
  const safeSrc = sanitizeImageUrl(src);
  if (!safeSrc) return '';
  const safeAlt = escapeHtml(alt || '聊天图片');
  return `<button class="msg-image-wrap" type="button" data-image-src="${safeSrc}" aria-label="查看图片"><img class="msg-chat-image" src="${safeSrc}" alt="${safeAlt}" loading="lazy" decoding="async" data-image-src="${safeSrc}"></button>`;
}

function normalizeMentionRenderOptions(options = []) {
  if (Array.isArray(options)) {
    return {
      names: options.filter(Boolean).map((name) => String(name)),
      users: [],
      selfUserIds: [],
    };
  }

  const users = Array.isArray(options.users) ? options.users : [];
  const names = Array.isArray(options.names) ? options.names : [];
  const selfUserIds = Array.isArray(options.selfUserIds) ? options.selfUserIds : [];

  return {
    names: names.filter(Boolean).map((name) => String(name)),
    users,
    selfUserIds: selfUserIds.map((id) => String(id || '').trim()).filter(Boolean),
  };
}

function mentionUserKeys(user = {}) {
  return [user.id, user.userId, user.identity, user.connectionId]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function resolveMentionUser(id, users = []) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;
  return users.find((user) => mentionUserKeys(user).includes(cleanId)) || null;
}

function buildMentionHtml(id, user, selfUserIds = []) {
  const cleanId = String(id || '').trim();
  const displayName = String(user?.displayName || user?.name || cleanId || '未知用户').trim();
  const isSelf = !!user?.isSelf || selfUserIds.includes(cleanId) || mentionUserKeys(user || {}).some((key) => selfUserIds.includes(key));
  const safeName = escapeHtml(displayName || '未知用户');
  const safeId = escapeHtml(cleanId);
  const cls = isSelf ? 'msg-mention msg-mention-self' : 'msg-mention';
  return `<span class="${cls}" data-mention-id="${safeId}" title="@${safeName}">@${safeName}</span>`;
}

/**
 * 将消息文本渲染为安全的富文本 HTML。
 * @param {string} rawText
 * @param {string[]|object} [mentionOptions] - 当前频道成员昵称，或 { users, names, selfUserIds }，用于高亮/解析 @mention
 * @returns {string} 安全 HTML 字符串
 */
export function renderMessageContent(rawText, mentionOptions = []) {
  if (!rawText) return '';

  const mentionRenderOptions = normalizeMentionRenderOptions(mentionOptions);
  let text = String(rawText);

  // 1. 提取并保护代码块（防止内部被其他规则替换）
  const codeBlocks = [];
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre class="msg-code-block"><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // 2. 提取并保护行内代码
  const inlineCodes = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="msg-inline-code">${escapeHtml(code)}</code>`);
    return `\x00INLINECODE${idx}\x00`;
  });

  // 2.5. 提取并保护标准 mention：<@userId>。
  // 输入框显示 @昵称，发送前会转换为 <@稳定用户ID>，历史消息改名后也能重新解析为当前昵称。
  const mentionBlocks = [];
  text = text.replace(/<@([^>\s]+)>/g, (match, id) => {
    const user = resolveMentionUser(id, mentionRenderOptions.users);
    const html = buildMentionHtml(id, user, mentionRenderOptions.selfUserIds);
    const idx = mentionBlocks.length;
    mentionBlocks.push(html);
    return `\x00MENTIONBLOCK${idx}\x00`;
  });

  // 3. 转义剩余文本（防 XSS）
  text = escapeHtml(text);

  // 3.5. 提取并保护图片消息，避免 URL 自动链接规则污染 img 标签。
  // 发送端使用 ![图片](/uploads/...)；这里只允许 /uploads/ 或 http(s)。
  const imageBlocks = [];
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (match, alt, url) => {
    const html = buildImageHtml(url, alt || '聊天图片');
    if (!html) return match;
    const idx = imageBlocks.length;
    imageBlocks.push(html);
    return `\x00IMAGEBLOCK${idx}\x00`;
  });



  // 兼容旧测试消息：[图片]\n(/uploads/...) 或 [图片](http://...)
  text = text.replace(/\[([^\]]*(?:图片|image)[^\]]*)\]\s*\(([^\s)]+)\)/gi, (match, alt, url) => {
    const html = buildImageHtml(url, alt || '聊天图片');
    if (!html) return match;
    const idx = imageBlocks.length;
    imageBlocks.push(html);
    return `\x00IMAGEBLOCK${idx}\x00`;
  });

  // 兼容旧测试消息：如果历史消息里只是纯图片 URL，也直接渲染为缩略图。
  // 注意这里在 URL 自动链接之前执行，并用占位符保护，避免生成 <a> 后破坏图片。
  const imageUrlPattern = /(^|[\s>])((?:\/uploads\/[^\s<>'"]+|https?:\/\/[^\s<>'"]+)\.(?:png|jpe?g|webp|gif)(?:\?[^\s<>'"]*)?)/gi;
  text = text.replace(imageUrlPattern, (match, prefix, url) => {
    const html = buildImageHtml(url, '聊天图片');
    if (!html) return match;
    const idx = imageBlocks.length;
    imageBlocks.push(html);
    return `${prefix}\x00IMAGEBLOCK${idx}\x00`;
  });

  // 4. Discord emoji :name:
  text = text.replace(/:([a-zA-Z0-9_+\-]+):/g, (match, name) => {
    const emoji = DISCORD_EMOJI_MAP[name] || DISCORD_EMOJI_MAP[name.toLowerCase()];
    if (emoji) return `<span class="msg-emoji" title=":${name}:">${emoji}</span>`;
    return match; // 未知 emoji 原样保留
  });

  // 5. @mention 高亮。
  // 兼容旧纯文本 @昵称；标准 <@id> 已在上面用 mentionBlocks 保护。
  const knownMentionNames = Array.from(new Set(mentionRenderOptions.names || []))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (knownMentionNames.length > 0) {
    const escaped = knownMentionNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(^|[\\s([{（])@(${escaped.join('|')})(?=$|[\\s.,;:!?，。！？、)\\]}）])`, 'g');
    text = text.replace(pattern, '$1<span class="msg-mention">@$2</span>');
  }
  // 未识别的 @mention 也加弱样式，便于手动输入时仍有视觉反馈。
  text = text.replace(/(^|[\s([{（])@([^\s<@]+)/g, (match, prefix, name) => {
    if (match.includes('msg-mention')) return match;
    return `${prefix}<span class="msg-mention-weak">@${escapeHtml(name)}</span>`;
  });

  // 6. URL 自动链接（只匹配 http/https）
  text = text.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a class="msg-link" href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );

  // 7. Markdown 格式（顺序很重要：粗斜体 > 粗体 > 斜体 > 删除线）
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>'); // ***粗斜体***
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');               // **粗体**
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');                           // *斜体*
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');                   // __粗体__
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');                            // _斜体_
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');                         // ~~删除线~~
  text = text.replace(/\|\|(.+?)\|\|/g, '<span class="msg-spoiler">$1</span>'); // ||剧透||

  // 8. 换行
  text = text.replace(/\n/g, '<br>');

  // 9. 还原代码块、行内代码、mention 和图片块
  text = text.replace(/\x00INLINECODE(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  text = text.replace(/\x00MENTIONBLOCK(\d+)\x00/g, (_, i) => mentionBlocks[Number(i)]);
  text = text.replace(/\x00IMAGEBLOCK(\d+)\x00/g, (_, i) => imageBlocks[Number(i)]);


  return text;
}

/** 所有可用的 Discord emoji（用于 emoji 选择器）。 */
export const EMOJI_LIST = Object.entries(DISCORD_EMOJI_MAP).map(([name, char]) => ({
  name,
  char,
  label: `:${name}:`,
}));

/** 快速 reaction emoji 列表（常见表情，用于气泡 hover 菜单）。 */
export const QUICK_REACTIONS = [
  { char: '👍', name: 'thumbsup' },
  { char: '❤️', name: 'heart' },
  { char: '😂', name: 'joy' },
  { char: '😮', name: 'open_mouth' },
  { char: '😢', name: 'cry' },
  { char: '😡', name: 'angry' },
  { char: '🎉', name: 'tada' },
  { char: '🔥', name: 'fire' },
];
