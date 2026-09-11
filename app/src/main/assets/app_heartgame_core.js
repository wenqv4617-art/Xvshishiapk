/**
 * app_heartgame_core.js - 心动游戏 · 内核（状态中枢 K + 自绘 UI 组件库 H）
 * ============================================================================
 * 本文件是「心动游戏」模组的地基，不渲染任何业务页面，只提供两样东西：
 *
 *   window.HeartGame  = { VERSION, K, H, C, U }
 *     K —— 状态中枢（双轨模式 / 阶梯好感 / 钱包 / 任务 / 商店 / 羁绊 / 抽卡 / 静室 / 记忆）
 *     H —— 自绘 UI 组件库（玻璃卡片、抽屉、选项卡、进度条、模态、气泡、SVG 图标）
 *     C —— 常量表（模式 / 阶梯 / 稀有度 / 热区 / 商品分类 / 心情）
 *     U —— 通用工具（数值、日期、文本、JSON、洗牌、LRU）
 *
 * 工程红线（全模组适用）：
 *   · 纯经典脚本：无 import / require / TS / JSX；顶层只挂到 window.HeartGame
 *   · 无 emoji：所有图标一律内联 SVG 路径（H.icon）
 *   · 无原生 alert / confirm / prompt：一律 H.sheet / H.confirm / H.modal / H.toast
 *   · 淡彩配色：心动粉莓 #FFEBF3/#D97FA8 + 雾蓝 #EDF2FB/#7E97C9，禁米黄/棕橙/莫兰迪灰
 *   · 读写 IndexedDB 一律带超时兜底（file:// 下 Dexie 的 Promise 会永久挂起）
 */
(function () {
  'use strict';

  // ==========================================================================
  //  0. 常量表 C
  // ==========================================================================

  /** 双轨模式 */
  var MODE = {
    STRATEGY: 'STRATEGY',                    // 攻略模式：User -> Char
    REVERSE_STRATEGY: 'REVERSE_STRATEGY'     // 逆向被攻略模式：Char -> User
  };

  var MODE_LABEL = {
    STRATEGY: '攻略模式',
    REVERSE_STRATEGY: '被攻略模式'
  };

  var MODE_DESC = {
    STRATEGY: '你是玩家，TA 是攻略目标。好感由剧情与礼物阶梯上升。',
    REVERSE_STRATEGY: 'TA 是玩家，你是被攻略的看板角色。TA 会主动氪金、抽卡、送礼。'
  };

  /** 阶梯式好感度（参考《恋与深空》分层经验槽） */
  var AFFINITY_TIERS = [
    { key: 'acquaint', name: '相识', min: 0,   max: 999,  color: '#9FB3D9', glow: 'rgba(159,179,217,0.45)', desc: '你们还只是彼此手机里的一个名字。' },
    { key: 'probe',    name: '试探', min: 1000, max: 2499, color: '#8FB8DE', glow: 'rgba(143,184,222,0.45)', desc: '开始在意对方回复的速度。' },
    { key: 'waver',    name: '动摇', min: 2500, max: 4499, color: '#B79EDC', glow: 'rgba(183,158,220,0.45)', desc: '心跳会在某个瞬间失控。' },
    { key: 'yearn',    name: '眷恋', min: 4500, max: 6999, color: '#D97FA8', glow: 'rgba(217,127,168,0.45)', desc: '分开半天就开始想念。' },
    { key: 'obsess',   name: '执念', min: 7000, max: 9999, color: '#C96A97', glow: 'rgba(201,106,151,0.55)', desc: '关于你的事，TA 一件都不想错过。' },
    { key: 'covenant', name: '终局契约', min: 10000, max: 99999, color: '#A85C86', glow: 'rgba(168,92,134,0.6)', desc: '从此以后，只此一人。' }
  ];

  /** 攻略难度：心动阻抗（好感增长倍率） */
  var DIFFICULTIES = [
    { key: 'insta',  name: '一见倾心', mult: 2.0, desc: '心动毫无抵抗，好感飞快上涨。' },
    { key: 'easy',   name: '情窦初开', mult: 1.5, desc: '略带羞涩，但很快会沦陷。' },
    { key: 'normal', name: '若即若离', mult: 1.0, desc: '标准节奏，需要耐心经营。' },
    { key: 'hard',   name: '冷若冰霜', mult: 0.7, desc: '嘴上不饶人，好感涨得慢。' },
    { key: 'noble',  name: '高岭之花', mult: 0.5, desc: '极难攻陷，每一步都要走得漂亮。' }
  ];

  /** 卡面稀有度 */
  var RARITY = {
    R:   { key: 'R',   name: 'R',   weight: 78, stars: 1, color: '#9FB3D9', glow: 'rgba(159,179,217,0.5)',  label: '记忆' },
    SR:  { key: 'SR',  name: 'SR',  weight: 18, stars: 2, color: '#B79EDC', glow: 'rgba(183,158,220,0.55)', label: '铭心' },
    SSR: { key: 'SSR', name: 'SSR', weight: 4,  stars: 3, color: '#D97FA8', glow: 'rgba(217,127,168,0.65)', label: '心动' }
  };

  /** 商业乙游标准保底：软保底从第 N 抽开始提升 SSR 概率，第 M 抽必出 */
  var GACHA_RULES = {
    ssrBase: 0.04,          // 基础 SSR 概率（反向模式可被卡池覆盖）
    srBase: 0.18,           // 基础 SR 概率
    softPityStart: 50,      // 第 50 抽起进入软保底
    hardPity: 80,           // 第 80 抽必出 SSR
    ssrPityStep: 0.06,      // 软保底每抽提升 6% SSR 概率
    guaranteeOn: 160,       // 大保底：160 抽内必得当期 UP
    singleCost: 160,        // 单抽消耗心动代币
    tenCost: 1600,          // 十连消耗（等效单抽价，无折扣但必出 SR+ 保底）
    tenMinRarity: 'SR'      // 十连保底稀有度
  };

  /** Live2D / 立绘身体热区（序号对应 PortraitManager 的掩码层） */
  var HOTSPOTS = [
    { key: 'hair',     name: '头发', hint: '随手拨乱 TA 的发顶', order: 1 },
    { key: 'face',     name: '脸颊', hint: '指尖擦过脸颊', order: 2 },
    { key: 'neck',     name: '脖颈', hint: '轻轻碰了碰颈侧', order: 3 },
    { key: 'chest',    name: '胸腹', hint: '掌心贴在胸口附近', order: 4 },
    { key: 'arm',      name: '手臂', hint: '拉住 TA 的小臂', order: 5 },
    { key: 'hand',     name: '双手', hint: '扣住 TA 的手指', order: 6 },
    { key: 'leg',      name: '下肢', hint: '膝盖不小心碰到一起', order: 7 }
  ];

  /** 商店分类 */
  var SHOP_CATEGORIES = [
    { key: 'wear',    name: '服饰', color: '#B79EDC', soft: '#F3EEFF' },
    { key: 'accessory', name: '饰品', color: '#D97FA8', soft: '#FFEBF3' },
    { key: 'consumable', name: '消耗品', color: '#7E97C9', soft: '#EDF2FB' },
    { key: 'letter',  name: '手写信物', color: '#8FB8DE', soft: '#EAF3FF' },
    { key: 'privilege', name: '亲密特权', color: '#C96A97', soft: '#FDEBF3' }
  ];

  /** 心情指数（反向模式：User 给 Char 设定 / Char 自身状态） */
  var MOODS = [
    { key: 'ecstatic', name: '狂喜',   color: '#D97FA8', soft: '#FFEBF3', icon: 'sparkle' },
    { key: 'happy',    name: '雀跃',   color: '#E39BC0', soft: '#FDEDF4', icon: 'smile' },
    { key: 'calm',     name: '平静',   color: '#9FB3D9', soft: '#EDF2FB', icon: 'cloud' },
    { key: 'anxious',  name: '患得患失', color: '#B79EDC', soft: '#F3EEFF', icon: 'wave' },
    { key: 'jealous',  name: '吃醋',   color: '#C96A97', soft: '#FDEBF3', icon: 'flame' },
    { key: 'possessive', name: '占有欲', color: '#A85C86', soft: '#FBE9F2', icon: 'lock' }
  ];

  /** 静室系统日志卡的语义色调 */
  var LOG_TONES = {
    gift:    { color: '#D97FA8', soft: '#FFEBF3', icon: 'gift' },
    gacha:   { color: '#B79EDC', soft: '#F3EEFF', icon: 'cards' },
    pay:     { color: '#8FB8DE', soft: '#EAF3FF', icon: 'wallet' },
    quest:   { color: '#7E97C9', soft: '#EDF2FB', icon: 'check' },
    story:   { color: '#C96A97', soft: '#FDEBF3', icon: 'book' },
    system:  { color: '#9FB3D9', soft: '#EDF2FB', icon: 'info' },
    touch:   { color: '#E39BC0', soft: '#FDEDF4', icon: 'hand' }
  };

  /** 每日 / 周常基础任务定义（动态衍生任务由 LLM 生成，不在此表） */
  var BASE_QUESTS = [
    { key: 'signin',   scope: 'daily', name: '今日签到',       target: 1,    desc: '打开心动游戏并签到一次',       reward: 60 },
    { key: 'online',   scope: 'daily', name: '在线相伴',       target: 900,  desc: '停留在心动游戏内 15 分钟',     reward: 90 },
    { key: 'gift',     scope: 'daily', name: '心意赠礼',       target: 1,    desc: '送给 TA 一件商店礼物',         reward: 120 },
    { key: 'touch',    scope: 'daily', name: '戳戳互动',       target: 5,    desc: '在看板上戳 TA 五次',           reward: 70 },
    { key: 'quiet',    scope: 'daily', name: '静室私语',       target: 6,    desc: '在静室与 TA 交换六句话',       reward: 110 },
    { key: 'story',    scope: 'weekly', name: '主线推进',      target: 2,    desc: '推进两个主线剧情节点',         reward: 320 },
    { key: 'gacha',    scope: 'weekly', name: '命运十连',      target: 10,   desc: '累计抽卡十次',                 reward: 400 },
    { key: 'quest',    scope: 'weekly', name: '委托达人',      target: 5,    desc: '完成五个每日委托',             reward: 380 }
  ];

  /** 阶梯宝箱：进度条上的阶段奖励节点 */
  var CHEST_NODES = [
    { pct: 20,  tokens: 120, draws: 0, label: '心动代币 ×120' },
    { pct: 50,  tokens: 260, draws: 1, label: '抽卡券 ×1' },
    { pct: 75,  tokens: 420, draws: 1, label: '心动代币 ×420 + 抽卡券 ×1' },
    { pct: 100, tokens: 800, draws: 3, label: '心动代币 ×800 + 抽卡券 ×3' }
  ];

  /** 立绘资源池的 LRU 上限（张）。超出后淘汰最久未使用的非当前立绘。 */
  var ASSET_POOL_LIMIT = 8;

  /** 立绘 / 背景资源键前缀（都落在 db.assets 表） */
  var ASSET_PREFIX = {
    portrait: 'hg-portrait-',
    background: 'hg-bg-',
    card: 'hg-card-',
    avatar: 'hg-avatar-',
    mask: 'hg-mask-',
    live2d: 'hg-live2d-'
  };

  var VERSION = '1.0.0';

  // ==========================================================================
  //  1. 通用工具 U
  // ==========================================================================

  var U = {
    /** 数值夹取 */
    clamp: function (n, lo, hi) {
      n = Number(n);
      if (isNaN(n)) n = lo;
      return n < lo ? lo : (n > hi ? hi : n);
    },
    /** 安全整数（坏数据兜底） */
    int: function (n, def) {
      var v = parseInt(n, 10);
      return isNaN(v) ? (def === undefined ? 0 : def) : v;
    },
    /** 保留 n 位小数（去掉多余的 0） */
    round: function (n, d) {
      var p = Math.pow(10, d === undefined ? 1 : d);
      return Math.round(Number(n) * p) / p;
    },
    /** HTML 转义（所有插入 innerHTML 的用户/AI 文本都必须过这一层） */
    esc: function (s) {
      if (s === null || s === undefined) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
    /** 千分位 */
    comma: function (n) {
      var s = String(U.int(n, 0));
      return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    },
    /** 大数缩写：12345 -> 1.2w */
    short: function (n) {
      n = U.int(n, 0);
      if (n >= 100000000) return U.round(n / 100000000, 2) + '亿';
      if (n >= 10000) return U.round(n / 10000, 2) + 'w';
      return String(n);
    },
    /** 本地日期键 YYYY-M-D（跟 couples 一致，不补零，便于人读） */
    dayKey: function (ts) {
      var d = ts ? new Date(ts) : new Date();
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    },
    /** 本周起始（周一）时间戳 */
    weekStart: function (ts) {
      var d = ts ? new Date(ts) : new Date();
      d.setHours(0, 0, 0, 0);
      var day = d.getDay();               // 0=周日
      var diff = (day === 0 ? 6 : day - 1);
      return d.getTime() - diff * 86400000;
    },
    /** 友好时间：刚刚 / 5 分钟前 / 今天 14:20 / 9月10日 14:20 */
    timeAgo: function (ts) {
      if (!ts) return '';
      var now = Date.now();
      var diff = now - ts;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
      var d = new Date(ts);
      var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
      if (U.dayKey(ts) === U.dayKey(now)) return '今天 ' + hm;
      var y = new Date(now).getFullYear();
      if (d.getFullYear() === y) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    },
    /** 日期时间全量：2026年9月10日 14:20 */
    timeFull: function (ts) {
      if (!ts) return '';
      var d = new Date(ts);
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 '
        + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    },
    /** UUID-ish 短 id */
    uid: function (prefix) {
      return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    },
    /** 数组洗牌（不改原数组） */
    shuffled: function (arr) {
      var a = (arr || []).slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },
    /** 稳定哈希（用于角色配色） */
    hash: function (s) {
      var h = 0, str = String(s || '');
      for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
      return Math.abs(h);
    },
    /** 从 AI 回复里抠 JSON（容忍 ```json 包裹与前后废话） */
    parseJSON: function (text, fallback) {
      if (!text) return fallback;
      var s = String(text).replace(/```json/gi, '```');
      var fenced = s.match(/```([\s\S]*?)```/);
      if (fenced) s = fenced[1];
      var first = s.indexOf('{');
      var last = s.lastIndexOf('}');
      if (first >= 0 && last > first) s = s.slice(first, last + 1);
      try {
        var obj = JSON.parse(s);
        return (obj && typeof obj === 'object') ? obj : fallback;
      } catch (e) { return fallback; }
    },
    /** 昵称首字（头像兜底） */
    initial: function (name) {
      var s = String(name || '').trim();
      return s ? s.charAt(0) : '心';
    },
    /** 压缩文本到 n 字 */
    cut: function (s, n) {
      s = String(s || '');
      return s.length > n ? s.slice(0, n) + '…' : s;
    },
    /** 去重 */
    uniq: function (arr) {
      var seen = {}, out = [];
      (arr || []).forEach(function (x) {
        var k = String(x);
        if (!seen[k]) { seen[k] = 1; out.push(x); }
      });
      return out;
    },
    /** 按字段分组 */
    groupBy: function (arr, fn) {
      var out = {};
      (arr || []).forEach(function (x) {
        var k = String(fn(x));
        (out[k] = out[k] || []).push(x);
      });
      return out;
    },
    /** 求百分比（0 分母安全） */
    pct: function (a, b) {
      b = Number(b) || 0;
      if (b <= 0) return 0;
      return U.clamp((Number(a) || 0) / b * 100, 0, 100);
    },
    /** 线性插值 */
    lerp: function (a, b, t) { return a + (b - a) * t; },
    /** 缓动 */
    easeOut: function (t) { return 1 - Math.pow(1 - t, 3); },
    /** 简易定时器注册（页面销毁时统一清理，防内存泄漏） */
    timers: [],
    setTimeout: function (fn, ms) {
      var id = setTimeout(fn, ms);
      U.timers.push(id);
      return id;
    },
    clearTimers: function () {
      U.timers.forEach(function (id) { clearTimeout(id); });
      U.timers = [];
    },
    /** JS 里没有结构化克隆的顾虑，但我们要避免把 live 数据塞进 JSON —— 这里只克隆纯数据 */
    plain: function (o) {
      if (!o || typeof o !== 'object') return o;
      try { return JSON.parse(JSON.stringify(o)); } catch (e) { return null; }
    }
  };

  // ==========================================================================
  //  2. 自绘 UI 组件库 H
  // ==========================================================================

  /** 图标：全部为内联 SVG 路径，禁止 emoji */
  var ICONS = {
    heart:      '<path d="M12 20.5s-7.5-4.6-7.5-9.6A4.4 4.4 0 0 1 12 8.2a4.4 4.4 0 0 1 7.5 2.7c0 5-7.5 9.6-7.5 9.6z"/>',
    task:       '<path d="M9 11l2.2 2.2L15.5 9"/><rect x="4" y="4" width="16" height="16" rx="4"/>',
    shop:       '<path d="M4 8h16l-1 11.2A2 2 0 0 1 17 21H7a2 2 0 0 1-2-1.8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
    bond:       '<path d="M12 20.5C8 17.6 4 14.4 4 10.6A4.1 4.1 0 0 1 12 8a4.1 4.1 0 0 1 8 2.6c0 3.8-4 7-8 9.9z"/><path d="M12 8V4"/>',
    book:       '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5"/>',
    cards:      '<rect x="4" y="6" width="12" height="15" rx="2.5"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3H18a2 2 0 0 1 2 2v12a1.5 1.5 0 0 1-1.5 1.5H16"/>',
    exit:       '<path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20H15"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>',
    admin:      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z"/>',
    portrait:   '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M3 17l4.5-4.5L12 17l3-3 6 6"/>',
    quiet:      '<path d="M21 12a8.5 8.5 0 0 1-12.3 7.6L4 21l1.4-4.5A8.5 8.5 0 1 1 21 12z"/>',
    bg:         '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M21 15l-5-5-6 6"/>',
    close:      '<path d="M6 6l12 12M18 6L6 18"/>',
    back:       '<path d="M15 18l-6-6 6-6"/>',
    next:       '<path d="M9 18l6-6-6-6"/>',
    down:       '<path d="M6 9l6 6 6-6"/>',
    up:         '<path d="M18 15l-6-6-6 6"/>',
    plus:       '<path d="M12 5v14M5 12h14"/>',
    minus:      '<path d="M5 12h14"/>',
    check:      '<path d="M5 12.5l4.5 4.5L19 7"/>',
    gift:       '<rect x="3" y="8" width="18" height="13" rx="2.5"/><path d="M3 12h18M12 8v13"/><path d="M12 8S10.5 3.5 8 3.5A2.5 2.5 0 0 0 8 8"/><path d="M12 8s1.5-4.5 4-4.5A2.5 2.5 0 0 1 16 8"/>',
    sparkle:    '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    flame:      '<path d="M12 22c3.9 0 6.5-2.6 6.5-6.2 0-4.4-4.4-6.3-4.4-10.3 0-.9-1.1-1.3-1.7-.6C9.7 8 8 9.3 8 11.5c0 .9.4 1.7 1 2.3-1.7.3-3 1.7-3 3.6C6 20 8.5 22 12 22z"/>',
    lock:       '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
    smile:      '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.6 2 4 2 4-2 4-2"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    cloud:      '<path d="M7 18h9.5A3.5 3.5 0 0 0 17 11a5 5 0 0 0-9.6-1.3A3.5 3.5 0 0 0 7 18z"/>',
    wave:       '<path d="M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/><path d="M3 17c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>',
    wallet:     '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18"/><circle cx="17" cy="14" r="1.2"/>',
    info:       '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    hand:       '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V4.8a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.6a6.4 6.4 0 0 1-5.2-2.7L3.6 15.4a1.6 1.6 0 0 1 2.5-2L8 15.2"/>',
    send:       '<path d="M4 12l16-8-6.5 16L11 13z"/><path d="M11 13l9-9"/>',
    trash:      '<path d="M4 7h16"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M6 7l1 12.2A1.8 1.8 0 0 0 8.8 21h6.4A1.8 1.8 0 0 0 17 19.2L18 7"/>',
    edit:       '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    upload:     '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 17v1.5A2.5 2.5 0 0 0 6.5 21h11A2.5 2.5 0 0 0 20 18.5V17"/>',
    phone:      '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10.5 18.5h3"/>',
    msg:        '<path d="M21 11.5a8 8 0 0 1-11.6 7.1L4 20.5l1.9-5.2A8 8 0 1 1 21 11.5z"/>',
    call:       '<path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5z"/>',
    camera:     '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1-2h6.6l1 2h1.2A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.2"/>',
    mask:       '<path d="M4 6h16v6a8 8 0 0 1-16 0z"/><path d="M9 10.5h.01M15 10.5h.01"/><path d="M9.5 14.5c1.5 1.2 3.5 1.2 5 0"/>',
    star:       '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.5 9.7l5.9-.8z"/>',
    clock:      '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
    die:        '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 9h.01M15 9h.01M9 15h.01M15 15h.01M12 12h.01"/>',
    target:     '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
    chart:      '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-4M12.5 16V8M17 16v-6"/>',
    key:        '<circle cx="8" cy="13" r="4"/><path d="M11 11l9-9"/><path d="M17 5l2 2"/><path d="M14.5 7.5l2 2"/>',
    eye:        '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.6"/>',
    refresh:    '<path d="M20 11a8 8 0 0 0-13.7-5.3L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 13.7 5.3L20 16"/><path d="M20 20v-4h-4"/>',
    play:       '<path d="M7 5.5l12 6.5-12 6.5z"/>',
    save:       '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v6h7V4"/><path d="M8 14h8v6H8z"/>',
    branch:     '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5v3a2 2 0 0 0 2 2h1M18 8.5v3a2 2 0 0 1-2 2h-1"/>',
    dice:       '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.2"/><circle cx="15.5" cy="8.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="8.5" cy="15.5" r="1.2"/><circle cx="15.5" cy="15.5" r="1.2"/>'
  };

  var SHAPES = {
    /** 圆角矩形 */
    rect: function (x, y, w, h, r) {
      r = Math.min(r || 0, w / 2, h / 2);
      return 'M' + (x + r) + ' ' + y + 'h' + (w - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r
        + 'v' + (h - 2 * r) + 'a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r + 'h' + (-(w - 2 * r))
        + 'a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + (-r) + 'v' + (-(h - 2 * r))
        + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + (-r) + 'z';
    },
    /** 正圆 */
    circle: function (cx, cy, r) {
      return 'M' + (cx - r) + ' ' + cy + 'a' + r + ' ' + r + ' 0 1 0 ' + (2 * r) + ' 0'
        + 'a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0z';
    },
    /** 椭圆热区（立绘掩码用） */
    ellipse: function (cx, cy, rx, ry) {
      return 'M' + (cx - rx) + ' ' + cy + 'a' + rx + ' ' + ry + ' 0 1 0 ' + (2 * rx) + ' 0'
        + 'a' + rx + ' ' + ry + ' 0 1 0 ' + (-2 * rx) + ' 0z';
    }
  };

  var H = {
    ICONS: ICONS,
    SHAPES: SHAPES,

    /** 生成图标 SVG 字符串 */
    icon: function (name, size, opts) {
      var body = ICONS[name] || ICONS.info;
      var o = opts || {};
      var sw = o.strokeWidth || 1.75;
      var color = o.color || 'currentColor';
      var fill = o.fill || 'none';
      var vbox = o.viewBox || '0 0 24 24';
      return '<svg viewBox="' + vbox + '" width="' + (size || 20) + '" height="' + (size || 20)
        + '" fill="' + fill + '" stroke="' + color + '" stroke-width="' + sw
        + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
    },

    /** 生成一个 <svg> 元素（热区掩码、图形用） */
    svg: function (viewBox, inner, attrs) {
      var el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('viewBox', viewBox || '0 0 100 100');
      el.setAttribute('preserveAspectRatio', 'none');
      Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      if (inner) el.innerHTML = inner;
      return el;
    },

    esc: U.esc,

    /** 创建元素 */
    el: function (tag, attrs, html) {
      var el = document.createElement(tag);
      if (attrs) {
        Object.keys(attrs).forEach(function (k) {
          if (k === 'style' && typeof attrs[k] === 'object') {
            Object.keys(attrs[k]).forEach(function (p) { el.style[p] = attrs[k][p]; });
          } else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
            el[k] = attrs[k];
          } else if (k === 'class' || k === 'className') {
            el.className = attrs[k];
          } else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) {
            el.setAttribute(k, attrs[k]);
          }
        });
      }
      if (html !== undefined && html !== null) el.innerHTML = html;
      return el;
    },

    /** 淡彩玻璃卡片 */
    card: function (opts) {
      var o = opts || {};
      var accent = o.accent || '#D97FA8';
      var soft = o.soft || '#FFEBF3';
      var d = H.el('div', { class: 'hg-glass-card ' + (o.class || '') });
      d.style.cssText = [
        'position:relative',
        'border-radius:' + (o.radius || 18) + 'px',
        'background:linear-gradient(150deg, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.72) 100%)',
        'border:1px solid ' + (o.border || 'rgba(216,160,190,0.28)'),
        'box-shadow:0 10px 30px rgba(150,120,150,0.10), inset 0 1px 0 rgba(255,255,255,0.9)',
        'backdrop-filter:blur(14px)',
        '-webkit-backdrop-filter:blur(14px)',
        'padding:' + (o.pad === undefined ? '14px' : o.pad) + (typeof o.pad === 'number' || o.pad === undefined ? 'px' : ''),
        'box-sizing:border-box'
      ].join(';') + ';';
      if (o.html) d.innerHTML = o.html;
      if (o.accentBar !== false) {
        var bar = H.el('div');
        bar.style.cssText = 'position:absolute; left:14px; top:12px; width:34px; height:3px; border-radius:3px;'
          + 'background:linear-gradient(90deg,' + accent + ', ' + soft + '); opacity:.85;';
        d.appendChild(bar);
      }
      return d;
    },

    /** 流光金属边框卡（用于 SSR / 重点入口） */
    glossyFrame: function (opts) {
      var o = opts || {};
      var color = o.color || '#D97FA8';
      var d = H.el('div');
      d.style.cssText = 'position:relative; border-radius:' + (o.radius || 20) + 'px; padding:1.6px;'
        + 'background:linear-gradient(135deg,' + color + ' 0%, rgba(255,255,255,0.95) 38%, ' + color + ' 62%, rgba(255,255,255,0.9) 100%);'
        + 'box-shadow:0 8px 26px ' + (o.glow || 'rgba(217,127,168,0.35)') + ';';
      var inner = H.el('div');
      inner.style.cssText = 'position:relative; border-radius:' + ((o.radius || 20) - 1) + 'px; overflow:hidden;'
        + 'background:linear-gradient(160deg, rgba(255,255,255,0.97), rgba(255,246,250,0.9));';
      d.appendChild(inner);
      if (o.html) inner.innerHTML = o.html;
      d._inner = inner;
      return d;
    },

    /** 一行标题（左侧色条 + 标题 + 右侧挂件） */
    sectionTitle: function (text, opts) {
      var o = opts || {};
      var wrap = H.el('div', { class: 'hg-section-title' });
      wrap.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:8px; margin:'
        + (o.margin === undefined ? '14px 2px 8px' : o.margin) + ';';
      var left = H.el('div');
      left.style.cssText = 'display:flex; align-items:center; gap:7px; min-width:0;';
      var bar = H.el('span');
      bar.style.cssText = 'width:3px; height:13px; border-radius:2px; flex-shrink:0; background:'
        + (o.color || '#D97FA8') + ';';
      left.appendChild(bar);
      var t = H.el('span', {}, U.esc(text));
      t.style.cssText = 'font-size:13.5px; font-weight:800; letter-spacing:.03em; color:'
        + (o.textColor || '#5c4450') + '; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      left.appendChild(t);
      wrap.appendChild(left);
      if (o.right) {
        var r = H.el('span');
        r.style.cssText = 'font-size:10.5px; color:#a9a1b0; flex-shrink:0; display:flex; align-items:center; gap:3px;';
        if (typeof o.right === 'string') r.innerHTML = o.right; else r.appendChild(o.right);
        wrap.appendChild(r);
      }
      return wrap;
    },

    /** 淡彩胶囊标签 */
    chip: function (text, opts) {
      var o = opts || {};
      var c = H.el('span', {}, U.esc(text));
      c.style.cssText = 'display:inline-flex; align-items:center; gap:4px; padding:2.5px 8px; border-radius:999px;'
        + 'font-size:10px; font-weight:700; letter-spacing:.02em; white-space:nowrap;'
        + 'color:' + (o.color || '#D97FA8') + '; background:' + (o.soft || '#FFEBF3') + ';'
        + (o.border ? 'border:1px solid ' + o.border + ';' : '');
      return c;
    },

    /** 按钮 */
    button: function (text, opts) {
      var o = opts || {};
      var b = H.el('button', { class: 'hg-btn ' + (o.class || ''), type: 'button' });
      var kind = o.kind || 'primary';
      var base = 'display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;'
        + 'border-radius:' + (o.radius || 12) + 'px; font-weight:700; letter-spacing:.02em;'
        + 'transition:transform .16s ease, box-shadow .22s ease, background .22s ease;'
        + 'padding:' + (o.pad || '9px 14px') + '; font-size:' + (o.size || 12.5) + 'px; box-sizing:border-box;'
        + (o.block ? 'width:100%;' : '');
      if (kind === 'primary') {
        base += 'border:none; color:#fff; background:linear-gradient(135deg,'
          + (o.color || '#D97FA8') + ', ' + (o.color2 || '#B79EDC') + ');'
          + 'box-shadow:0 6px 18px ' + (o.glow || 'rgba(217,127,168,0.32)') + ';';
      } else if (kind === 'soft') {
        base += 'border:none; color:' + (o.color || '#8f6a80') + '; background:' + (o.soft || '#FFEBF3') + ';';
      } else if (kind === 'outline') {
        base += 'border:1px solid ' + (o.border || 'rgba(216,160,190,0.45)') + '; color:'
          + (o.color || '#D97FA8') + '; background:rgba(255,255,255,0.7);';
      } else if (kind === 'ghost') {
        base += 'border:none; color:' + (o.color || '#9a8f9e') + '; background:transparent;';
      } else if (kind === 'danger') {
        base += 'border:1px solid rgba(214,120,140,0.35); color:#c2607c; background:rgba(255,240,244,0.85);';
      }
      b.style.cssText = base;
      b.innerHTML = (o.icon ? H.icon(o.icon, o.iconSize || 15, { strokeWidth: 2 }) : '') + (text ? '<span>' + U.esc(text) + '</span>' : '');
      b.onpointerdown = function () { b.style.transform = 'scale(0.955)'; };
      b.onpointerup = function () { b.style.transform = ''; };
      b.onpointerleave = function () { b.style.transform = ''; };
      if (o.disabled) { b.disabled = true; b.style.opacity = '0.45'; b.style.cursor = 'not-allowed'; }
      return b;
    },

    /** 图标按钮（圆形，44 热区） */
    iconButton: function (iconName, opts) {
      var o = opts || {};
      var b = H.el('button', { class: 'hg-icon-btn', type: 'button' });
      b.style.cssText = 'width:' + (o.size || 34) + 'px; height:' + (o.size || 34) + 'px; border-radius:50%;'
        + 'display:flex; align-items:center; justify-content:center; cursor:pointer; padding:0; flex-shrink:0;'
        + 'border:1px solid ' + (o.border || 'rgba(216,160,190,0.30)') + ';'
        + 'background:' + (o.bg || 'rgba(255,255,255,0.72)') + '; color:' + (o.color || '#8f6a80') + ';'
        + 'backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);'
        + 'transition:transform .16s ease, background .2s ease;';
      b.innerHTML = H.icon(iconName, o.iconSize || 17, { strokeWidth: o.strokeWidth || 2 });
      b.onpointerdown = function () { b.style.transform = 'scale(0.9)'; };
      b.onpointerup = function () { b.style.transform = ''; };
      b.onpointerleave = function () { b.style.transform = ''; };
      if (o.title) b.title = o.title;
      return b;
    },

    /** 进度条（支持阶梯节点标记） */
    progress: function (opts) {
      var o = opts || {};
      var value = U.clamp(o.value || 0, 0, 100);
      var wrap = H.el('div', { class: 'hg-progress' });
      wrap.style.cssText = 'position:relative; width:100%; height:' + (o.height || 9) + 'px; border-radius:999px;'
        + 'background:' + (o.track || 'rgba(216,190,210,0.22)') + '; overflow:visible;';
      var fill = H.el('div');
      fill.style.cssText = 'position:absolute; left:0; top:0; bottom:0; width:' + value + '%; border-radius:999px;'
        + 'background:linear-gradient(90deg,' + (o.color || '#D97FA8') + ', ' + (o.color2 || '#B79EDC') + ');'
        + 'box-shadow:0 0 12px ' + (o.glow || 'rgba(217,127,168,0.45)') + '; transition:width .5s cubic-bezier(.22,1,.36,1);';
      wrap.appendChild(fill);
      (o.nodes || []).forEach(function (n) {
        var dot = H.el('span');
        var on = value >= n.pct;
        dot.style.cssText = 'position:absolute; top:50%; left:' + n.pct + '%; transform:translate(-50%,-50%);'
          + 'width:9px; height:9px; border-radius:50%; transition:all .3s ease;'
          + (on
            ? 'background:' + (o.color || '#D97FA8') + '; box-shadow:0 0 8px ' + (o.glow || 'rgba(217,127,168,0.6)') + ';'
            : 'background:#fff; border:1.5px solid rgba(190,170,195,0.5);');
        wrap.appendChild(dot);
      });
      return wrap;
    },

    /** 分隔线 */
    divider: function (opts) {
      var o = opts || {};
      var d = H.el('div');
      d.style.cssText = 'height:1px; margin:' + (o.margin || '12px 0') + '; background:linear-gradient(90deg,'
        + 'rgba(216,160,190,0), rgba(216,160,190,0.35), rgba(216,160,190,0));';
      return d;
    },

    /** 空态 */
    empty: function (text, opts) {
      var o = opts || {};
      var d = H.el('div');
      d.style.cssText = 'padding:26px 16px; display:flex; flex-direction:column; align-items:center; gap:8px;'
        + 'color:#b3aab8; font-size:11.5px; text-align:center; line-height:1.7;';
      d.innerHTML = '<span style="width:34px; height:34px; border-radius:50%; display:flex; align-items:center;'
        + 'justify-content:center; background:' + (o.soft || '#F6F1F6') + '; color:' + (o.color || '#c3b6c6') + ';">'
        + H.icon(o.icon || 'info', 17, { strokeWidth: 1.8 }) + '</span>'
        + '<span>' + U.esc(text) + '</span>';
      return d;
    },

    /** 加载态 */
    loading: function (text) {
      var d = H.el('div', { class: 'hg-loading' });
      d.style.cssText = 'padding:22px; display:flex; flex-direction:column; align-items:center; gap:10px;'
        + 'color:#a99fae; font-size:11.5px;';
      d.innerHTML = H.spinner(26) + '<span>' + U.esc(text || '正在悄悄准备…') + '</span>';
      return d;
    },

    /** 旋转加载环 */
    spinner: function (size) {
      var s = size || 22;
      return '<span class="hg-spin" style="width:' + s + 'px; height:' + s + 'px; border-radius:50%;'
        + 'border:2px solid rgba(217,127,168,0.22); border-top-color:#D97FA8; display:inline-block;"></span>';
    },

    /** 头像（带首字兜底） */
    avatar: function (src, name, size) {
      var s = size || 40;
      var img = H.el('img', { class: 'hg-avatar', alt: '' });
      img.style.cssText = 'width:' + s + 'px; height:' + s + 'px; border-radius:50%; object-fit:cover; flex-shrink:0;'
        + 'background:#FFEBF3; border:1.5px solid rgba(255,255,255,0.9); box-shadow:0 3px 10px rgba(150,120,150,0.18);';
      var fallback = function () {
        img.onerror = null;
        img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
          "<svg viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'>"
          + "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>"
          + "<stop offset='0' stop-color='#FFEBF3'/><stop offset='1' stop-color='#EDF2FB'/></linearGradient></defs>"
          + "<circle cx='50' cy='50' r='50' fill='url(#g)'/>"
          + "<text x='50' y='66' font-size='44' text-anchor='middle' fill='#B0728F' font-family='sans-serif' font-weight='700'>"
          + U.initial(name) + '</text></svg>'
        );
      };
      if (src) { img.onerror = fallback; img.src = src; } else { fallback(); }
      return img;
    },

    // ------------------------------------------------------------------
    //  浮层体系：全部挂在 document.body，避免被 .app-window 的 overflow 裁剪
    // ------------------------------------------------------------------

    _layers: [],

    /** 构建一个浮层容器 */
    _layer: function (opts) {
      var o = opts || {};
      var overlay = H.el('div', { class: 'hg-overlay ' + (o.class || '') });
      overlay.style.cssText = 'position:fixed; inset:0; z-index:' + (o.z || 100200) + ';'
        + 'display:flex; ' + (o.align || 'align-items:flex-end;') + ' justify-content:center;'
        + 'background:' + (o.dim || 'rgba(70,50,66,0.34)') + ';'
        + 'backdrop-filter:blur(7px); -webkit-backdrop-filter:blur(7px);'
        + 'opacity:0; transition:opacity .26s ease; padding:' + (o.pad || '0') + ';';
      H._layers.push(overlay);
      return overlay;
    },

    _show: function (overlay) {
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.style.opacity = '1'; });
    },

    _hide: function (overlay, cb) {
      overlay.style.opacity = '0';
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        var i = H._layers.indexOf(overlay);
        if (i >= 0) H._layers.splice(i, 1);
        if (typeof cb === 'function') cb();
      }, 240);
    },

    /** 关闭全部浮层（页面退出时调用，防残留） */
    closeAllLayers: function () {
      H._layers.slice().forEach(function (l) {
        if (l.parentNode) l.parentNode.removeChild(l);
      });
      H._layers = [];
    },

    /**
     * 抽屉 / 底部卡片面板
     * @param {object} opts { title, subtitle, icon, accent, content(Node), buttons:[{text,kind,onClick}],
     *                        height, full, onClose, dismissible }
     * @returns {Promise<any>} 关闭时 resolve(任意值 / undefined)
     */
    sheet: function (opts) {
      var o = opts || {};
      var accent = o.accent || '#D97FA8';
      var settle = null;
      var done = false;
      var promise = new Promise(function (res) { settle = res; });

      // z-index 必须高于 #app-window-container（项目里是 9999）——
      // 否则抽屉会被**不透明的应用窗口整个盖住**：动作明明执行成功、DOM 里也有面板，
      // 但用户什么都看不见，表现就是「点了没反应」。这是本轮真正的主因。
      var overlay = H._layer({ z: o.z || 100200, align: o.full ? 'align-items:stretch;' : 'align-items:flex-end;' });
      var panel = H.el('div', { class: 'hg-sheet' });
      var maxH = o.height || (o.full ? '100%' : '86%');
      panel.style.cssText = 'position:relative; width:100%; max-width:' + (o.maxWidth || '520px') + ';'
        + 'max-height:' + maxH + '; display:flex; flex-direction:column; box-sizing:border-box;'
        + 'border-radius:' + (o.full ? '0' : '24px 24px 0 0') + ';'
        + 'background:linear-gradient(170deg, rgba(255,255,255,0.985) 0%, rgba(255,248,252,0.96) 55%, rgba(248,246,255,0.97) 100%);'
        + 'box-shadow:0 -14px 44px rgba(120,90,120,0.20);'
        + 'transform:translateY(28px); opacity:.6;'
        + 'transition:transform .34s cubic-bezier(.22,1,.36,1), opacity .3s ease;'
        + 'padding-top:6px;';
      // 说明：抽屉面板刻意不使用生成式「面板底图」——
      // 玻璃元件是白的，白底图非抠即留边，而纯 CSS 渐变+毛玻璃在浅色底上完全干净。

      // 顶部拖拽条
      var handle = H.el('div');
      handle.style.cssText = 'width:38px; height:4px; border-radius:3px; margin:6px auto 2px; flex-shrink:0;'
        + 'background:linear-gradient(90deg, rgba(217,127,168,0.45), rgba(183,158,220,0.45));';
      panel.appendChild(handle);

      if (o.title) {
        var head = H.el('div');
        head.style.cssText = 'display:flex; align-items:center; gap:9px; padding:8px 16px 10px; flex-shrink:0;';
        var ic = H.el('span');
        ic.style.cssText = 'width:30px; height:30px; border-radius:10px; display:flex; align-items:center;'
          + 'justify-content:center; flex-shrink:0; background:' + (o.soft || '#FFEBF3') + '; color:' + accent + ';';
        ic.innerHTML = H.icon(o.icon || 'heart', 16, { strokeWidth: 1.9 });
        head.appendChild(ic);
        var tt = H.el('div');
        tt.style.cssText = 'flex:1; min-width:0;';
        tt.innerHTML = '<div style="font-size:14.5px; font-weight:800; color:#553f4c; letter-spacing:.02em;">'
          + U.esc(o.title) + '</div>'
          + (o.subtitle ? '<div style="font-size:10.5px; color:#a99fae; margin-top:2px;">' + U.esc(o.subtitle) + '</div>' : '');
        head.appendChild(tt);
        var xb = H.iconButton('close', { size: 30, color: '#a99fae', title: '关闭' });
        xb.onclick = function () { finish(undefined); };
        head.appendChild(xb);
        panel.appendChild(head);
        var line = H.el('div');
        line.style.cssText = 'height:1px; margin:0 14px; background:linear-gradient(90deg, rgba(216,160,190,0),'
          + 'rgba(216,160,190,0.30), rgba(216,160,190,0));';
        panel.appendChild(line);
      }

      var content = H.el('div', { class: 'hg-sheet-body' });
      content.style.cssText = 'flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:14px 16px 18px;'
        + 'overscroll-behavior:contain;';
      if (o.content) content.appendChild(o.content);
      panel.appendChild(content);

      var buttons = o.buttons || [];
      if (buttons.length) {
        var bar = H.el('div');
        bar.style.cssText = 'display:flex; gap:9px; padding:11px 16px calc(14px + env(safe-area-inset-bottom, 0px));'
          + 'border-top:1px solid rgba(216,160,190,0.18); background:rgba(255,255,255,0.72); flex-shrink:0;';
        buttons.forEach(function (cfg) {
          var b = H.button(cfg.text, {
            kind: cfg.kind || 'primary', block: true, icon: cfg.icon,
            color: cfg.color, color2: cfg.color2, soft: cfg.soft, glow: cfg.glow
          });
          b.onclick = function () {
            if (typeof cfg.onClick === 'function') {
              var r = cfg.onClick(api);
              if (r === false) return;
            }
            if (cfg.keepOpen !== true) finish(cfg.value === undefined ? cfg.text : cfg.value);
          };
          bar.appendChild(b);
        });
        panel.appendChild(bar);
      }

      overlay.appendChild(panel);

      function finish(val) {
        if (done) return;
        done = true;
        panel.style.transform = 'translateY(28px)';
        panel.style.opacity = '.4';
        H._hide(overlay, function () {
          if (typeof o.onClose === 'function') { try { o.onClose(val); } catch (e) {} }
          settle(val);
        });
      }

      if (o.dismissible !== false) {
        overlay.onclick = function (e) { if (e.target === overlay) finish(undefined); };
      }

      H._show(overlay);
      requestAnimationFrame(function () {
        panel.style.transform = 'translateY(0)';
        panel.style.opacity = '1';
      });

      var api = {
        panel: panel,
        body: content,
        close: finish,
        setTitle: function (t) {
          var tEl = panel.querySelector('div[style*="font-size:14.5px"]');
          if (tEl) tEl.textContent = t;
        },
        /** 把当前内容替换为新的内容节点 */
        replace: function (node) {
          content.innerHTML = '';
          content.appendChild(node);
        },
        /** 在底部追加一段内容 */
        append: function (node) { content.appendChild(node); },
        /** 滚动到某个元素 */
        scrollTo: function (node) {
          if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      };
      return promise;
    },

    /**
     * 拟真确认卡（替代原生 confirm）
     * @returns {Promise<boolean>}
     */
    confirm: function (opts) {
      var o = (typeof opts === 'string') ? { message: opts } : (opts || {});
      var accent = o.accent || '#D97FA8';
      var settle, done = false;
      var promise = new Promise(function (res) { settle = res; });
      var overlay = H._layer({ z: o.z || 100400, align: 'align-items:center;', pad: '22px' });
      var card = H.el('div', { class: 'hg-modal' });
      card.style.cssText = 'width:100%; max-width:330px; border-radius:24px; overflow:hidden; text-align:center;'
        + 'background:linear-gradient(165deg, rgba(255,255,255,0.99), rgba(255,247,251,0.97));'
        + 'box-shadow:0 22px 60px rgba(110,80,110,0.26); padding:24px 20px 18px; box-sizing:border-box;'
        + 'transform:scale(.92); opacity:0; transition:transform .3s cubic-bezier(.22,1,.36,1), opacity .26s ease;';
      // 同样刻意不用生成式弹窗底图（原因同抽屉面板）
      var halo = H.el('div');
      halo.style.cssText = 'width:56px; height:56px; margin:0 auto 12px; border-radius:20px; display:flex;'
        + 'align-items:center; justify-content:center; color:' + accent + '; background:'
        + (o.soft || '#FFEBF3') + '; box-shadow:0 10px 26px ' + (o.glow || 'rgba(217,127,168,0.28)') + ';';
      halo.innerHTML = H.icon(o.icon || 'heart', 26, { strokeWidth: 1.8 });
      card.appendChild(halo);
      if (o.title) {
        var t = H.el('div', {}, U.esc(o.title));
        t.style.cssText = 'font-size:15.5px; font-weight:800; color:#553f4c; letter-spacing:.02em;';
        card.appendChild(t);
      }
      var msg = H.el('div');
      msg.style.cssText = 'font-size:12px; line-height:1.78; color:#8b8292; margin-top:' + (o.title ? '8px' : '2px') + ';'
        + 'white-space:pre-wrap; word-break:break-word;';
      msg.textContent = o.message || '';
      card.appendChild(msg);
      var bar = H.el('div');
      bar.style.cssText = 'display:flex; gap:9px; margin-top:20px;';
      var cancel = H.button(o.cancelText || '再想想', { kind: 'ghost', block: true, color: '#a99fae' });
      cancel.style.background = 'rgba(240,235,242,0.7)';
      cancel.style.borderRadius = '13px';
      var okb = H.button(o.okText || '确定', {
        kind: 'primary', block: true, color: o.okColor || accent, color2: o.okColor2 || '#B79EDC'
      });
      okb.style.borderRadius = '13px';
      cancel.onclick = function () { finish(false); };
      okb.onclick = function () { finish(true); };
      bar.appendChild(cancel);
      bar.appendChild(okb);
      card.appendChild(bar);
      overlay.appendChild(card);

      function finish(v) {
        if (done) return;
        done = true;
        card.style.transform = 'scale(.94)';
        card.style.opacity = '0';
        H._hide(overlay, function () { settle(v); });
      }
      overlay.onclick = function (e) { if (e.target === overlay) finish(false); };

      H._show(overlay);
      requestAnimationFrame(function () { card.style.transform = 'scale(1)'; card.style.opacity = '1'; });
      return promise;
    },

    /**
     * 拟真提示卡（替代原生 alert）
     * @returns {Promise<void>}
     */
    modal: function (opts) {
      var o = (typeof opts === 'string') ? { message: opts } : (opts || {});
      return H.confirm({
        title: o.title, message: o.message, icon: o.icon, accent: o.accent, soft: o.soft, glow: o.glow,
        okText: o.okText || '知道了', cancelText: o.cancelText || null, z: o.z
      }).then(function () { });
    },

    /**
     * 输入卡（替代原生 prompt）
     * @returns {Promise<string|null>}
     */
    prompt: function (opts) {
      var o = opts || {};
      var accent = o.accent || '#D97FA8';
      var settle, done = false;
      var promise = new Promise(function (res) { settle = res; });
      var overlay = H._layer({ z: 100400, align: 'align-items:center;', pad: '18px' });
      var card = H.el('div');
      card.style.cssText = 'width:100%; max-width:' + (o.maxWidth || '340px') + '; border-radius:22px;'
        + 'background:linear-gradient(165deg, rgba(255,255,255,0.99), rgba(255,248,252,0.97));'
        + 'box-shadow:0 22px 60px rgba(110,80,110,0.26); padding:20px 18px 16px; box-sizing:border-box;'
        + 'transform:scale(.94); opacity:0; transition:transform .3s cubic-bezier(.22,1,.36,1), opacity .26s ease;';
      if (o.title) {
        var t = H.el('div', {}, U.esc(o.title));
        t.style.cssText = 'font-size:14.5px; font-weight:800; color:#553f4c; margin-bottom:4px;';
        card.appendChild(t);
      }
      if (o.message) {
        var m = H.el('div', {}, U.esc(o.message));
        m.style.cssText = 'font-size:11.5px; line-height:1.7; color:#948a9c; margin-bottom:10px;';
        card.appendChild(m);
      }
      var input;
      if (o.multiline) {
        input = H.el('textarea', { rows: o.rows || 4, placeholder: o.placeholder || '' });
      } else {
        input = H.el('input', { type: o.type || 'text', placeholder: o.placeholder || '' });
      }
      input.value = o.value || '';
      input.style.cssText = 'width:100%; box-sizing:border-box; border-radius:13px; border:1px solid rgba(216,160,190,0.35);'
        + 'background:rgba(255,255,255,0.86); padding:10px 12px; font-size:12.5px; color:#5c4450; outline:none;'
        + 'font-family:inherit; line-height:1.6; resize:vertical;';
      input.onfocus = function () { input.style.borderColor = accent; input.style.boxShadow = '0 0 0 3px rgba(217,127,168,0.14)'; };
      input.onblur = function () { input.style.borderColor = 'rgba(216,160,190,0.35)'; input.style.boxShadow = 'none'; };
      card.appendChild(input);
      var bar = H.el('div');
      bar.style.cssText = 'display:flex; gap:9px; margin-top:14px;';
      var cancel = H.button(o.cancelText || '取消', { kind: 'ghost', block: true, color: '#a99fae' });
      cancel.style.background = 'rgba(240,235,242,0.7)';
      cancel.style.borderRadius = '13px';
      var okb = H.button(o.okText || '确定', { kind: 'primary', block: true, color: accent, color2: o.color2 || '#B79EDC' });
      okb.style.borderRadius = '13px';
      cancel.onclick = function () { finish(null); };
      okb.onclick = function () { finish(input.value); };
      if (o.multiline) {
        input.onkeydown = function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(input.value); };
      } else {
        input.onkeydown = function (e) { if (e.key === 'Enter') finish(input.value); };
      }
      bar.appendChild(cancel);
      bar.appendChild(okb);
      card.appendChild(bar);
      overlay.appendChild(card);

      function finish(v) {
        if (done) return;
        done = true;
        card.style.transform = 'scale(.95)';
        card.style.opacity = '0';
        H._hide(overlay, function () { settle(v); });
      }
      overlay.onclick = function (e) { if (e.target === overlay) finish(null); };
      H._show(overlay);
      requestAnimationFrame(function () {
        card.style.transform = 'scale(1)'; card.style.opacity = '1';
        setTimeout(function () { try { input.focus(); } catch (e) {} }, 120);
      });
      return promise;
    },

    /**
     * 选项卡条
     * @param {Array} items [{key,label,icon,badge}]
     * @param {string} activeKey
     * @param {Function} onChange(key)
     */
    tabs: function (items, activeKey, onChange) {
      var wrap = H.el('div', { class: 'hg-tabs' });
      wrap.style.cssText = 'display:flex; gap:6px; padding:4px; border-radius:14px; overflow-x:auto;'
        + 'background:rgba(240,236,244,0.66); scrollbar-width:none; -ms-overflow-style:none;';
      (items || []).forEach(function (it) {
        var on = it.key === activeKey;
        var b = H.el('button', { type: 'button', class: 'hg-tab' });
        b.style.cssText = 'flex:1 0 auto; min-width:56px; padding:7px 10px; border-radius:11px; cursor:pointer;'
          + 'font-size:11.5px; font-weight:700; white-space:nowrap; border:none; display:flex; align-items:center;'
          + 'justify-content:center; gap:4px; transition:all .22s ease;'
          + (on
            ? 'background:linear-gradient(135deg,#fff,#FFF3F8); color:#B0728F; box-shadow:0 3px 10px rgba(180,140,170,0.20);'
            : 'background:transparent; color:#9a919f;');
        b.innerHTML = (it.icon ? H.icon(it.icon, 13, { strokeWidth: 2 }) : '') + '<span>' + U.esc(it.label) + '</span>'
          + (it.badge ? '<span style="font-size:9px; padding:0 4px; border-radius:6px; background:#FFEBF3; color:#D97FA8;">'
            + U.esc(it.badge) + '</span>' : '');
        b.onclick = function () { if (typeof onChange === 'function') onChange(it.key); };
        wrap.appendChild(b);
      });
      return wrap;
    },

    /** 单行列表项（图标 + 标题 + 副标题 + 右侧箭头/挂件） */
    listRow: function (opts) {
      var o = opts || {};
      var row = H.el('div', { class: 'hg-list-row' });
      row.style.cssText = 'display:flex; align-items:center; gap:11px; padding:11px 12px; border-radius:15px;'
        + 'background:' + (o.bg || 'rgba(255,255,255,0.72)') + '; border:1px solid '
        + (o.border || 'rgba(216,160,190,0.18)') + '; cursor:' + (o.onClick ? 'pointer' : 'default') + ';'
        + 'transition:transform .16s ease, background .2s ease; margin-bottom:8px;';
      if (o.icon) {
        var ic = H.el('span');
        ic.style.cssText = 'width:34px; height:34px; border-radius:12px; flex-shrink:0; display:flex;'
          + 'align-items:center; justify-content:center; color:' + (o.color || '#D97FA8') + '; background:'
          + (o.soft || '#FFEBF3') + ';';
        ic.innerHTML = H.icon(o.icon, 17, { strokeWidth: 1.9 });
        row.appendChild(ic);
      }
      if (o.leftNode) row.appendChild(o.leftNode);
      var mid = H.el('div');
      mid.style.cssText = 'flex:1; min-width:0;';
      mid.innerHTML = '<div style="font-size:12.5px; font-weight:700; color:#5c4450; white-space:nowrap;'
        + 'overflow:hidden; text-overflow:ellipsis;">' + U.esc(o.title || '') + '</div>'
        + (o.subtitle ? '<div style="font-size:10.5px; color:#a99fae; margin-top:2px; line-height:1.5;'
          + (o.subtitleWrap ? '' : 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;') + '">'
          + U.esc(o.subtitle) + '</div>' : '');
      row.appendChild(mid);
      if (o.rightNode) row.appendChild(o.rightNode);
      else if (o.right) {
        var r = H.el('div', {}, o.right);
        r.style.cssText = 'font-size:11px; color:#a99fae; flex-shrink:0; display:flex; align-items:center; gap:5px;';
        row.appendChild(r);
      } else if (o.onClick) {
        row.appendChild(H.iconButton('next', { size: 26, color: '#c3b6c6' }));
      }
      if (o.onClick) {
        row.onclick = o.onClick;
        row.onpointerdown = function () { row.style.transform = 'scale(0.985)'; };
        row.onpointerup = function () { row.style.transform = ''; };
        row.onpointerleave = function () { row.style.transform = ''; };
      }
      return row;
    },

    /** 数值调整器（− 值 +），反向模式裁定好感用 */
    stepper: function (opts) {
      var o = opts || {};
      var wrap = H.el('div');
      wrap.style.cssText = 'display:flex; align-items:center; gap:8px;';
      var val = H.el('div');
      val.style.cssText = 'min-width:64px; text-align:center; font-size:15px; font-weight:800; color:'
        + (o.color || '#D97FA8') + '; letter-spacing:.01em;';
      var cur = U.int(o.value, 0);

      function render() {
        val.textContent = (o.format ? o.format(cur) : String(cur));
        if (typeof o.onChange === 'function') o.onChange(cur);
      }
      var minus = H.iconButton('minus', { size: 30, color: o.color || '#D97FA8' });
      var plus = H.iconButton('plus', { size: 30, color: o.color || '#D97FA8' });
      minus.onclick = function () { cur = U.clamp(cur - (o.step || 1), o.min === undefined ? 0 : o.min, o.max === undefined ? 100 : o.max); render(); };
      plus.onclick = function () { cur = U.clamp(cur + (o.step || 1), o.min === undefined ? 0 : o.min, o.max === undefined ? 100 : o.max); render(); };
      wrap.appendChild(minus);
      wrap.appendChild(val);
      wrap.appendChild(plus);
      render();
      wrap.getValue = function () { return cur; };
      wrap.setValue = function (v) { cur = U.int(v, 0); render(); };
      return wrap;
    },

    /** 开关 */
    toggle: function (on, onChange, opts) {
      var o = opts || {};
      var wrap = H.el('div');
      wrap.style.cssText = 'width:46px; height:26px; border-radius:999px; position:relative; cursor:pointer;'
        + 'transition:background .24s ease; flex-shrink:0; background:'
        + (on ? (o.color || '#D97FA8') : 'rgba(190,180,195,0.42)') + ';';
      var knob = H.el('div');
      knob.style.cssText = 'position:absolute; top:3px; left:' + (on ? '23px' : '3px') + '; width:20px; height:20px;'
        + 'border-radius:50%; background:#fff; box-shadow:0 2px 6px rgba(120,90,120,0.25); transition:left .26s cubic-bezier(.22,1,.36,1);';
      wrap.appendChild(knob);
      var state = !!on;
      wrap.onclick = function () {
        state = !state;
        wrap.style.background = state ? (o.color || '#D97FA8') : 'rgba(190,180,195,0.42)';
        knob.style.left = state ? '23px' : '3px';
        if (typeof onChange === 'function') onChange(state);
      };
      wrap.getValue = function () { return state; };
      return wrap;
    },

    /** 滑块（难度调节） */
    slider: function (opts) {
      var o = opts || {};
      var wrap = H.el('div');
      wrap.style.cssText = 'display:flex; align-items:center; gap:10px;';
      var input = H.el('input', { type: 'range', min: o.min === undefined ? 0 : o.min, max: o.max === undefined ? 100 : o.max, step: o.step || 1 });
      input.value = o.value === undefined ? 50 : o.value;
      input.style.cssText = 'flex:1; -webkit-appearance:none; appearance:none; height:6px; border-radius:999px;'
        + 'background:linear-gradient(90deg,' + (o.color || '#D97FA8') + ' 0%, ' + (o.color2 || '#B79EDC') + ' 100%); outline:none;';
      var label = H.el('div');
      label.style.cssText = 'min-width:56px; text-align:right; font-size:11.5px; font-weight:800; color:#8f6a80;';
      label.textContent = (o.format ? o.format(input.value) : input.value);
      input.oninput = function () {
        label.textContent = (o.format ? o.format(input.value) : input.value);
        if (typeof o.onChange === 'function') o.onChange(input.value);
      };
      wrap.appendChild(input);
      wrap.appendChild(label);
      wrap.getValue = function () { return Number(input.value); };
      return wrap;
    },

    /** 气泡（静室对话用） */
    bubble: function (opts) {
      var o = opts || {};
      var isUser = o.side === 'user';
      var wrap = H.el('div', { class: 'hg-bubble-row' });
      wrap.style.cssText = 'display:flex; gap:8px; margin-bottom:12px; align-items:' + (o.alignTop === false ? 'center' : 'flex-end')
        + '; flex-direction:' + (isUser ? 'row-reverse' : 'row') + ';';
      if (o.avatarNode) wrap.appendChild(o.avatarNode);
      var col = H.el('div');
      col.style.cssText = 'max-width:76%; min-width:0; display:flex; flex-direction:column;'
        + 'align-items:' + (isUser ? 'flex-end' : 'flex-start') + ';';
      if (o.name) {
        var nm = H.el('div');
        nm.style.cssText = 'font-size:9.5px; color:' + (o.nameColor || '#b0a5b4') + '; margin:0 4px 3px;'
          + 'display:flex; align-items:center; gap:3px;';
        nm.textContent = o.name;
        col.appendChild(nm);
      }
      var b = H.el('div', { class: 'hg-bubble' });
      var accent = o.accent || '#D97FA8';
      b.style.cssText = 'position:relative; padding:10px 13px; font-size:12.8px; line-height:1.78;'
        + 'word-break:break-word; white-space:pre-wrap; box-sizing:border-box;'
        + 'border-radius:' + (isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px') + ';'
        + (isUser
          ? 'background:linear-gradient(135deg,' + accent + ' 0%, ' + (o.color2 || '#B79EDC') + ' 100%); color:#fff;'
            + 'box-shadow:0 6px 18px ' + (o.glow || 'rgba(217,127,168,0.30)') + ';'
          : 'background:linear-gradient(150deg, rgba(255,255,255,0.97), rgba(255,250,253,0.9)); color:#5c4450;'
            + 'border:1px solid rgba(216,160,190,0.24); box-shadow:0 6px 18px rgba(150,120,150,0.10);');
      if (o.html !== undefined) b.innerHTML = o.html; else b.textContent = o.text || '';
      col.appendChild(b);
      if (o.meta) {
        var mt = H.el('div');
        mt.style.cssText = 'font-size:9px; color:#bcb2be; margin:4px 4px 0;';
        mt.textContent = o.meta;
        col.appendChild(mt);
      }
      wrap.appendChild(col);
      return wrap;
    },

    /** 系统通知卡（静室日志流混排） */
    systemLog: function (opts) {
      var o = opts || {};
      var tone = LOG_TONES[o.tone] || LOG_TONES.system;
      var wrap = H.el('div', { class: 'hg-syslog' });
      wrap.style.cssText = 'display:flex; align-items:flex-start; gap:8px; margin:12px auto; max-width:88%;'
        + 'padding:9px 12px; border-radius:14px; background:linear-gradient(135deg,' + tone.soft + 'CC, rgba(255,255,255,0.75));'
        + 'border:1px solid ' + tone.color + '33; box-shadow:0 4px 14px rgba(150,120,150,0.08);';
      var ic = H.el('span');
      ic.style.cssText = 'flex-shrink:0; width:20px; height:20px; border-radius:50%; display:flex; align-items:center;'
        + 'justify-content:center; background:' + tone.color + '22; color:' + tone.color + '; margin-top:1px;';
      ic.innerHTML = H.icon(tone.icon, 12, { strokeWidth: 2 });
      wrap.appendChild(ic);
      var txt = H.el('div');
      txt.style.cssText = 'flex:1; font-size:11.2px; line-height:1.65; color:#6d6472; font-style:italic;';
      txt.innerHTML = o.html !== undefined ? o.html : U.esc(o.text || '');
      wrap.appendChild(txt);
      return wrap;
    },

    /** 稀有度徽记 */
    rarityBadge: function (rarity) {
      var r = RARITY[rarity] || RARITY.R;
      var b = H.el('span');
      b.style.cssText = 'display:inline-flex; align-items:center; gap:3px; padding:2px 7px; border-radius:8px;'
        + 'font-size:9.5px; font-weight:900; letter-spacing:.06em; color:#fff; background:linear-gradient(135deg,'
        + r.color + ', ' + r.color + 'CC); box-shadow:0 3px 9px ' + r.glow + ';';
      b.textContent = r.name;
      return b;
    },

    /** 星标（稀有度星星） */
    stars: function (n, opts) {
      var o = opts || {};
      var wrap = H.el('span');
      wrap.style.cssText = 'display:inline-flex; gap:2px;';
      for (var i = 0; i < n; i++) {
        var s = H.el('span');
        s.style.cssText = 'width:11px; height:11px; color:' + (o.color || '#E8B84B') + '; display:inline-flex;';
        s.innerHTML = H.icon('star', 11, { fill: o.color || '#E8B84B', strokeWidth: 0.5 });
        wrap.appendChild(s);
      }
      return wrap;
    },

    /** 弹幕式飘字（好感 +5 之类） */
    floatText: function (text, opts) {
      var o = opts || {};
      var host = o.host || document.body;
      var el = H.el('div');
      el.style.cssText = 'position:absolute; left:' + (o.x || '50%') + '; top:' + (o.y || '50%') + ';'
        + 'transform:translate(-50%,-50%); pointer-events:none; z-index:100500; font-size:14px; font-weight:900;'
        + 'color:' + (o.color || '#D97FA8') + '; text-shadow:0 2px 10px rgba(255,255,255,0.95);'
        + 'animation:hg-float-up 1.5s cubic-bezier(.22,1,.36,1) forwards; white-space:nowrap;';
      el.textContent = text;
      host.appendChild(el);
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1600);
    },

    /** toast（复用项目全局；不存在时自绘） */
    toast: function (msg) {
      if (typeof window.showToast === 'function') { window.showToast(msg); return; }
      var t = H.el('div');
      t.style.cssText = 'position:fixed; left:50%; bottom:88px; transform:translateX(-50%); z-index:100500;'
        + 'padding:10px 16px; border-radius:14px; background:rgba(70,50,66,0.86); color:#fff;'
        + 'font-size:12px; max-width:78%; text-align:center; line-height:1.6; backdrop-filter:blur(8px);';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
    }
  };

  // ==========================================================================
  //  2.5 皮肤资源 A —— 生成式 UI 素材（美术工具产出）的渐进增强层
  //      · 每张素材都有「存在即启用 / 缺失即回落」的语义：
  //        图片加载失败（未打包 / 离线 / 名字改过）就自动退回内联 SVG 与纯 CSS，
  //        因此不依赖任何一张图，功能与观感都不会塌。
  //      · 目录统一：assets/images/heartgame/<group>/<id>.png
  // ==========================================================================

  var SKIN_BASE = 'images/heartgame/';

  var Skin = {
    BASE: SKIN_BASE,
    /** 已确认可用的素材集合（key -> url），避免重复探测 */
    _known: Object.create(null),
    _failed: Object.create(null),
    _probing: Object.create(null),

    /** 素材地址 */
    url: function (group, id) {
      return SKIN_BASE + group + '/' + id + '.png';
    },

    /** 同步判断：这张素材是否已经探测成功过 */
    has: function (group, id) {
      return !!Skin._known[group + '/' + id];
    },

    /** 取已确认的地址（没有则 null） */
    get: function (group, id) {
      return Skin._known[group + '/' + id] || null;
    },

    /**
     * 异步探测一张素材是否存在
     * @returns {Promise<string|null>}
     */
    probe: function (group, id) {
      var key = group + '/' + id;
      if (Skin._known[key]) return Promise.resolve(Skin._known[key]);
      if (Skin._failed[key]) return Promise.resolve(null);
      if (Skin._probing[key]) return Skin._probing[key];
      var url = Skin.url(group, id);
      Skin._probing[key] = new Promise(function (resolve) {
        if (typeof Image !== 'function') { Skin._failed[key] = 1; resolve(null); return; }
        var img = new Image();
        var done = false;
        var finish = function (okUrl) {
          if (done) return; done = true;
          delete Skin._probing[key];
          if (okUrl) Skin._known[key] = okUrl; else Skin._failed[key] = 1;
          resolve(okUrl);
        };
        img.onload = function () { finish(url); };
        img.onerror = function () { finish(null); };
        setTimeout(function () { finish(null); }, 6000);
        img.src = url;
      });
      return Skin._probing[key];
    },

    /** 批量探测，返回「组 -> {id: url}」 */
    probeAll: function (list) {
      return Promise.all((list || []).map(function (it) {
        return Skin.probe(it[0], it[1]).then(function (u) { return u ? { g: it[0], i: it[1], url: u } : null; });
      })).then(function (rows) {
        var out = {};
        rows.filter(Boolean).forEach(function (r) {
          out[r.g] = out[r.g] || {};
          out[r.g][r.i] = r.url;
        });
        return out;
      });
    },

    /**
     * 图标元素：有生成素材就用素材，否则用内联 SVG
     * @param {string} group
     * @param {string} id
     * @param {string} svgName  H.ICONS 里的名字（回落用）
     * @param {object} opts     { size }
     */
    iconEl: function (group, id, svgName, opts) {
      var o = opts || {};
      var size = o.size || 20;
      var url = Skin.get(group, id);
      if (url) {
        var img = H.el('img', { alt: '', 'data-skin': group + '/' + id });
        img.src = url;
        img.style.cssText = 'width:' + size + 'px; height:' + size + 'px; object-fit:contain; display:block;'
          + 'filter:drop-shadow(0 2px 6px rgba(217,127,168,0.30));';
        return img;
      }
      return H.icon(svgName, size, { strokeWidth: o.strokeWidth || 1.8 });
    },

    /**
     * 背景图（面板 / 弹窗底衬）：有素材就铺图，否则保持原有渐变
     * 注意：只设置 background-image，颜色与圆角仍由 CSS 决定，
     *       所以素材缺失时观感与现在完全一致。
     */
    applyBg: function (elm, group, id, opts) {
      if (!elm) return false;
      var o = opts || {};
      var url = Skin.get(group, id);
      if (!url) return false;
      elm.style.backgroundImage = 'url(' + url + ')';
      elm.style.backgroundSize = o.size || '100% 100%';
      elm.style.backgroundRepeat = 'no-repeat';
      elm.style.backgroundPosition = o.position || 'center';
      if (o.blend) elm.style.backgroundBlendMode = o.blend;
      return true;
    },

    /** 统计（排障用） */
    stats: function () {
      return { known: Object.keys(Skin._known).length, failed: Object.keys(Skin._failed).length };
    }
  };

  // ==========================================================================
  //  3. 状态中枢 K
  // ==========================================================================

  /**
   * 默认状态骨架。所有数值都经过 U.int/U.clamp 收敛，坏数据不会把界面打崩。
   */
  function blankState(charId, meId) {
    return {
      version: VERSION,
      charId: U.int(charId, 0),
      meId: U.int(meId, 0),
      mode: MODE.STRATEGY,
      difficulty: 'normal',

      // —— 好感阶梯 ——
      affinity: 0,            // 当前档位内经验
      tierKey: 'acquaint',    // 当前阶梯
      gateDone: {},           // 晋阶任务完成表 {tierKey: true}
      peakAffinity: 0,        // 历史最高（用于阶梯回退保护）

      // —— 反向模式：User 对 Char 的裁定 ——
      verdict: {
        value: 0,             // 0-100 好感裁定值
        mood: 'calm',
        note: ''
      },

      // —— 经济 ——
      wallet: {
        tokens: 0,            // 心动代币（日常/剧情产出）
        vouchers: 0,          // 仿制代金券（充值流水表现层）
        draws: 3,             // 抽卡券
        totalRecharge: 0,     // 累计充值（表现层假数据）
        totalSpent: 0
      },

      // —— 任务 ——
      quests: {
        base: {},             // {questKey: {progress, done, claimed, resetAt}}
        dynamic: [],          // LLM 衍生的专属委托
        reverse: [],          // 反向模式：User 发布给 Char 的任务
        chest: { claimed: {}, cycle: 1 },  // 阶梯宝箱
        weekStart: 0,
        dayKey: ''
      },

      // —— 商店 ——
      shop: {
        owned: [],            // [{goodsId, at, count}]
        listed: [],           // 反向模式：User 上架的自制道具
        /** Char 自动采购记录（反向模式） */
        purchases: []
      },

      // —— 羁绊 ——
      bond: {
        timeline: [],         // 时空足迹
        memories: [],         // 重要记忆回廊
        giftsGiven: 0,
        giftsReceived: 0,
        firstMeetAt: 0,
        anniversaries: []
      },

      // —— 抽卡 ——
      gacha: {
        pools: [],            // User 自建 / 系统生成的卡池
        activePoolId: null,
        owned: [],            // 已获得卡面
        pity: {},             // {poolId: {sinceSsr, softCount, guarantee, total}}
        history: []           // 抽卡流水（最近 200 条）
      },

      // —— 静室 ——
      quiet: {
        sceneId: 'default',
        thread: [],           // [{id, role:'user'|'char'|'system', text, at, tone}]
        mood: 'calm',
        lastActiveAt: 0
      },

      // —— 主线 / 剧情 ——
      story: {
        arcs: [],             // [{id, title, chapters:[...], currentNodeId, status}]
        activeArcId: null,
        branches: [],         // 分支回溯树
        phone: {              // 剧情中途小手机
          sms: [],
          moments: [],
          calls: []
        }
      },

      // —— 立绘与背景 ——
      assets: {
        portraits: [],        // [{id, name, kind:'live2d'|'image', src, tags, current}]
        backgrounds: [],      // [{id, name, scene, src, tags}]
        currentPortraitId: null,
        currentBackgroundId: null,
        hotspots: {},         // {portraitId: {hair:{x,y,rx,ry}, ...}}
        hotspotActions: {},   // {portraitId: {hair:[{text, at}]}}
        pool: []              // LRU 资源池 key 列表
      },

      // —— 统计与其它 ——
      stats: {
        touches: 0,
        sessions: 0,
        createdAt: Date.now(),
        totalOnlineSec: 0
      },
      /** 后台管理里 User / Char 的字段覆盖（不污染档案库） */
      overrides: { user: {}, char: {} },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  var K = {
    MODE: MODE,
    blank: blankState,

    charId: null,
    meId: null,
    state: null,

    /** 抽屉表的内存形态：一个 index 只放一个 state（当前 char+me） */
    _sessionRow: null,
    _memCache: null,
    _lru: [],
    _dirty: false,
    _saveTimer: null,
    /**
     * state 实例代际号。每当 K.state 被整体替换（clearScope('all') / 重新 bind）
     * 就 +1；防抖保存闭包里记住当时的代际，写盘前对不上就直接放弃。
     * 否则一个 400ms 前排队的 flush 会把「已经被换掉的旧 state」写回存储。
     */
    _gen: 0,

    /** 惰性拿到 db（file:// / 测试环境可能没有） */
    db: function () {
      try { return (typeof db !== 'undefined' && db) ? db : null; } catch (e) { return null; }
    },

    /** 带超时的 Dexie 调用，避免 Promise 永久挂起 */
    _withTimeout: function (p, ms, fallback) {
      return new Promise(function (resolve) {
        var done = false;
        var t = setTimeout(function () {
          if (done) return; done = true;
          resolve(fallback);
        }, ms || 4000);
        Promise.resolve(p).then(function (v) {
          if (done) return; done = true;
          clearTimeout(t);
          resolve(v);
        }).catch(function () {
          if (done) return; done = true;
          clearTimeout(t);
          resolve(fallback);
        });
      });
    },

    /** 表是否可用 */
    _table: function (name) {
      var d = K.db();
      if (!d) return null;
      try { return d[name] ? d.table(name) : null; } catch (e) { return null; }
    },

    /**
     * 读取兜底：把任意异步读取包进「软超时」。
     * 底层存储（IndexedDB / Dexie）在异常环境下可能整体挂起，
     * 只要有一处 await 永远不落，整条渲染链就会断在半路 ——
     * 所以 UI 层读数据一律走这里，超时就用 fallback 继续往下渲染。
     * @param {Function} fn 返回 Promise 的读取动作
     * @param {number} ms 软超时
     * @param {*} fallback 超时/异常时的替代值
     */
    readGuarded: function (fn, ms, fallback) {
      var timeout = new Promise(function (resolve) {
        setTimeout(function () { resolve(fallback); }, ms || 6000);
      });
      var run;
      try { run = Promise.resolve(fn()); } catch (e) { run = Promise.resolve(fallback); }
      return Promise.race([run.catch(function () { return fallback; }), timeout]);
    },

    /**
     * 绑定关系：解析当前 char / me，载入或初始化 state
     * @param {object} opts { charId, meId, sessionId }
     * @returns {Promise<object>} state
     */
    bind: async function (opts) {
      var o = opts || {};
      var meId = o.meId || K.resolveMeId();
      var charId = o.charId || K.resolveCharId();
      K.meId = U.int(meId, 0) || null;
      K.charId = U.int(charId, 0) || null;
      K.sessionId = o.sessionId || null;
      K.state = await K.load(K.charId, K.meId);
      return K.state;
    },

    /** 当前 User（面具）id：与项目全局 activeUserPersonaId 同源 */
    resolveMeId: function () {
      try {
        if (typeof activeUserPersonaId !== 'undefined' && activeUserPersonaId) return Number(activeUserPersonaId);
      } catch (e) {}
      try {
        var v = localStorage.getItem('active_me_id');
        if (v && v !== 'null' && v !== 'undefined') return Number(v);
      } catch (e) {}
      return null;
    },

    /** 当前 Char id：优先会话，其次桌面桌宠，最后第一个角色档案 */
    resolveCharId: function () {
      try {
        if (typeof activeSessionId !== 'undefined' && activeSessionId) return K._charOfSessionSync(activeSessionId);
      } catch (e) {}
      return null;
    },

    _charOfSessionSync: function (sid) {
      // sessions 是异步表，这里只能同步读缓存；解析走 async 版本
      if (K._sessCache && K._sessCache[sid]) return K._sessCache[sid];
      return null;
    },

    /** 完整异步解析 charId（应用打开时调一次） */
    resolveCharIdAsync: async function (sessionId) {
      var d = K.db();
      var sid = sessionId;
      try {
        if (!sid && typeof activeSessionId !== 'undefined' && activeSessionId) sid = activeSessionId;
      } catch (e) {}
      if (d && sid) {
        var sess = await K._withTimeout(d.sessions.get(Number(sid)), 3000, null);
        if (sess && sess.isGroup !== 1 && sess.charId) {
          K._sessCache = K._sessCache || {};
          K._sessCache[Number(sid)] = Number(sess.charId);
          return Number(sess.charId);
        }
      }
      // 桌宠
      try {
        var petRaw = localStorage.getItem('desktop-pet-char-id');
        if (petRaw && Number(petRaw)) return Number(petRaw);
      } catch (e) {}
      // 兜底：档案库里第一个非面具角色
      if (d) {
        var chars = await K._withTimeout(d.archives.where('type').equals('character').toArray(), 3500, null);
        if (!chars) chars = await K._withTimeout(d.archives.toArray(), 3500, []);
        var pick = (chars || []).filter(function (c) { return c && (c.type === 'character' || !c.type); })[0];
        if (pick) return Number(pick.id);
      }
      return null;
    },

    /** state 的存储键：内存 + localStorage 双通道（IndexedDB 可选） */
    _stateKey: function (charId, meId) {
      return 'hg_state_' + U.int(meId, 0) + '_' + U.int(charId, 0);
    },

    /** 读取：IndexedDB（heartgame_state）→ localStorage → 全新 */
    load: async function (charId, meId) {
      var key = K._stateKey(charId, meId);
      var d = K.db();
      var raw = null;
      if (d) {
        // 复用既有 db.assets 表（'key, updatedAt'）存放本模组的整份存档。
        // 刻意不新建 Dexie 表：新增表会牵动 app_settings.js 的
        // computeStorageUsage / clearAllAppData / exportBackup / importBackup 四处，
        // 漏一处就会让「备份导出 / 导入」事务死锁。透明字段 + assets 表零副作用。
        var tbl = K._table('assets');
        if (tbl) {
          var row = await K._withTimeout(tbl.get(key), 3500, null);
          if (row && row.data && typeof row.data === 'object') raw = row.data;
        }
      }
      if (!raw) {
        try {
          var ls = localStorage.getItem(key);
          if (ls) raw = JSON.parse(ls);
        } catch (e) { raw = null; }
      }
      var st = K.normalize(raw, charId, meId);
      K._cancelPendingSave();      // 换 state：作废上一个 state 排队的写盘
      K._sessionRow = key;
      K._memCache = st;
      return st;
    },

    /** 补齐缺失字段（旧存档升级路径） */
    normalize: function (raw, charId, meId) {
      var base = blankState(charId, meId);
      if (!raw || typeof raw !== 'object') return base;
      var merge = function (target, src) {
        Object.keys(src || {}).forEach(function (k) {
          var sv = src[k];
          // undefined / null 一律视为「缺失」，保留默认值。
          // （早期版本把 null 当成对象递归下去，结果把 wallet 这类默认结构洗成空对象）
          if (sv === undefined || sv === null) return;
          if (Array.isArray(sv)) { target[k] = sv; return; }
          if (typeof sv === 'object') {
            if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
            merge(target[k], sv);
          } else {
            target[k] = sv;
          }
        });
        return target;
      };
      var out = merge(base, raw);
      out.charId = U.int(charId, out.charId);
      out.meId = U.int(meId, out.meId);
      out.affinity = Math.max(0, U.int(out.affinity, 0));
      out.peakAffinity = Math.max(out.affinity, U.int(out.peakAffinity, 0));
      if (!MODE[out.mode]) out.mode = MODE.STRATEGY;
      if (!AFFINITY_TIERS.some(function (t) { return t.key === out.tierKey; })) out.tierKey = 'acquaint';
      out.version = VERSION;
      return out;
    },

    /** 保存：防抖 400ms，双通道写 */
    save: function (immediate) {
      if (!K._sessionRow || !K.state) return Promise.resolve(false);
      K.state.updatedAt = Date.now();
      K._dirty = true;
      if (K._saveTimer) { clearTimeout(K._saveTimer); K._saveTimer = null; }
      if (!immediate) {
        var myGen = K._gen;
        return new Promise(function (resolve) {
          K._saveTimer = setTimeout(function () {
            K._saveTimer = null;
            if (myGen !== K._gen) { resolve(false); return; }   // state 已换代，丢弃这次写盘
            resolve(K.flush());
          }, 400);
        });
      }
      return K.flush();
    },

    /** 丢弃排队中的防抖保存（state 即将被替换时调用） */
    _cancelPendingSave: function () {
      if (K._saveTimer) { clearTimeout(K._saveTimer); K._saveTimer = null; }
      K._gen++;
    },

    /** 真写盘 */
    flush: function () {
      if (!K._sessionRow || !K.state) return Promise.resolve(false);
      var key = K._sessionRow;
      var payload = U.plain(K.state) || {};
      var d = K.db();
      var tbl = d ? K._table('assets') : null;
      // localStorage 先写（同步、必然可用），IndexedDB 异步补
      var lsOk = false;
      try {
        localStorage.setItem(key, JSON.stringify(payload));
        lsOk = true;
      } catch (e) {
        // 超限：只保留结构与关键数值，丢掉历史噪声
        try {
          var slim = U.plain(payload);
          slim.quiet.thread = (slim.quiet.thread || []).slice(-40);
          slim.gacha.history = (slim.gacha.history || []).slice(-40);
          slim.bond.timeline = (slim.bond.timeline || []).slice(-80);
          slim.story.branches = [];
          localStorage.setItem(key, JSON.stringify(slim));
          lsOk = true;
        } catch (e2) { lsOk = false; }
      }
      K._dirty = false;
      if (!tbl) return Promise.resolve(lsOk);
      // 复用 assets 表：行结构 { key, data: <state 对象>, updatedAt }
      return K._withTimeout(tbl.put({ key: key, data: payload, updatedAt: Date.now() }), 4000, false)
        .then(function () { return true; });
    },

    // ------------------------------------------------------------------
    //  3.1 好感度：阶梯经验
    // ------------------------------------------------------------------

    /** 当前难度对象 */
    difficulty: function () {
      var key = K.state ? K.state.difficulty : 'normal';
      for (var i = 0; i < DIFFICULTIES.length; i++) if (DIFFICULTIES[i].key === key) return DIFFICULTIES[i];
      return DIFFICULTIES[2];
    },

    /** 当前阶梯对象 */
    tier: function () {
      var key = K.state ? K.state.tierKey : 'acquaint';
      for (var i = 0; i < AFFINITY_TIERS.length; i++) if (AFFINITY_TIERS[i].key === key) return AFFINITY_TIERS[i];
      return AFFINITY_TIERS[0];
    },

    tierOf: function (key) {
      for (var i = 0; i < AFFINITY_TIERS.length; i++) if (AFFINITY_TIERS[i].key === key) return AFFINITY_TIERS[i];
      return AFFINITY_TIERS[0];
    },

    tierIndex: function (key) {
      key = key || (K.state && K.state.tierKey);
      for (var i = 0; i < AFFINITY_TIERS.length; i++) if (AFFINITY_TIERS[i].key === key) return i;
      return 0;
    },

    /** 阶梯内的进度（0-100） */
    tierProgress: function () {
      var t = K.tier();
      var a = K.state ? K.state.affinity : 0;
      var span = t.max - t.min + 1;
      return U.clamp((a - t.min) / span * 100, 0, 100);
    },

    /** 距离下一阶梯还差多少经验；已满级返回 0 */
    toNextTier: function () {
      var t = K.tier();
      var a = K.state ? K.state.affinity : 0;
      var idx = K.tierIndex(t.key);
      if (idx >= AFFINITY_TIERS.length - 1) return 0;
      return Math.max(0, t.max + 1 - a);
    },

    /**
     * 是否卡在晋阶任务上。
     * 注意用 >= 比较：经验被夹在本阶上限（= tier.max）时就已经是「满槽待晋阶」，
     * 只有 > 判定会让夹取后的状态永远显示为「未满」。
     */
    isGated: function () {
      var t = K.tier();
      var idx = K.tierIndex(t.key);
      if (idx >= AFFINITY_TIERS.length - 1) return false;
      var a = K.state ? K.state.affinity : 0;
      return a >= t.max && !K.state.gateDone[t.key];
    },

    /**
     * 好感变动（唯一入口）
     * @param {number} delta 原始变动值（正负）
     * @param {object} opts { reason, source, silent, force }
     * @returns {object} { applied, before, after, tierUp, tierDown, gated }
     */
    addAffinity: function (delta, opts) {
      var o = opts || {};
      var st = K.state;
      if (!st) return { applied: 0 };
      var before = st.affinity;
      var d = Number(delta) || 0;

      // 攻略模式：受难度倍率影响；反向模式：User 裁定，不受倍率
      var mult = (st.mode === MODE.STRATEGY) ? K.difficulty().mult : 1.0;
      if (o.raw !== true) d = d * mult;
      var applied = Math.round(d);

      var idxBefore = K.tierIndex(st.tierKey);
      var after = Math.max(0, before + applied);

      // 阶梯判定：先算目标阶梯，满槽且未完成晋阶任务时把经验**夹回本阶上限**
      // （早期版本这里漏了夹取，导致 gated 状态下 affinity 会溢出到下一阶区间，
      //   表现上就是「经验条显示越界、isGated() 失效」）
      var tier = K.tierOf(st.tierKey);
      var tierUp = false;
      var gated = false;
      if (after >= tier.max) {
        var nextIdx = idxBefore + 1;
        if (nextIdx < AFFINITY_TIERS.length) {
          if (st.gateDone[st.tierKey] || o.force) {
            st.affinity = after;
            st.tierKey = AFFINITY_TIERS[nextIdx].key;
            tierUp = true;
          } else {
            st.affinity = tier.max;   // 锁在满槽，等待晋阶任务
            gated = true;
          }
        } else {
          st.affinity = tier.max;     // 已是最高阶，不再溢出
        }
      } else {
        st.affinity = after;
      }

      st.peakAffinity = Math.max(st.peakAffinity || 0, st.affinity);

      // 回退保护：已达成过的阶梯不会被一次负向变动打回去（除非显式 allowDown）
      if (st.affinity < tier.min && idxBefore > 0 && o.allowDown) {
        st.tierKey = AFFINITY_TIERS[idxBefore - 1].key;
      }

      var st2 = K.state;
      K.logAffinity(applied, o.reason || '', before, st2.affinity);
      if (!o.silent) {
        K.emit('affinity', {
          delta: applied, before: before, after: st2.affinity,
          tier: st2.tierKey, tierUp: tierUp, gated: gated, reason: o.reason || ''
        });
      }
      K.save();
      return { applied: applied, before: before, after: st2.affinity, tierUp: tierUp, gated: gated };
    },

    /**
     * 完成晋阶任务，解锁阶梯。
     * 「标记完成」与「推进阶梯」是两件事：
     *   · 若该阶梯已标记过（例如面板提前打过勾），这里仍要负责把阶梯推上去；
     *   · 否则只标记，等下一条经验把槽顶满时才推进。
     * 早期版本在「已标记」时直接 return，导致玩家提前点过勾后阶梯永远卡住。
     */
    completeGate: function (tierKey) {
      var st = K.state;
      if (!st) return false;
      var key = tierKey || st.tierKey;
      var first = !st.gateDone[key];
      st.gateDone[key] = true;

      var idx = K.tierIndex(key);
      var t = K.tierOf(key);
      var advanced = false;
      if (idx < AFFINITY_TIERS.length - 1 && st.affinity >= t.max) {
        st.tierKey = AFFINITY_TIERS[idx + 1].key;
        // 溢出到下一阶的经验按下一阶起点承接，避免凭空跳级
        st.affinity = Math.max(st.affinity, AFFINITY_TIERS[idx + 1].min);
        advanced = true;
      }
      K.pushTimeline({ type: 'gate', title: '阶梯晋阶', text: '晋阶任务完成：「' + t.name + '」的门被推开了。' });
      K.save(true);
      K.emit('tier', { tier: st.tierKey, gate: key });
      return first || advanced;
    },

    /** 反向模式：User 直接裁定对 Char 的好感 */
    setVerdict: function (value, opts) {
      var o = opts || {};
      var st = K.state;
      if (!st) return;
      st.verdict.value = U.clamp(value, 0, 100);
      if (o.mood) st.verdict.mood = o.mood;
      if (o.note !== undefined) st.verdict.note = String(o.note || '');
      K.pushTimeline({
        type: 'verdict',
        title: '心意裁定',
        text: '你把对 TA 的好感裁定为 ' + st.verdict.value + ' / 100'
          + (o.mood ? '，心情指数：' + K.moodOf(o.mood).name : '') + '。'
      });
      K.save();
      K.emit('verdict', { value: st.verdict.value, mood: st.verdict.mood });
    },

    /** 微调裁定值 */
    nudgeVerdict: function (delta, opts) {
      var st = K.state;
      if (!st) return;
      var v = U.clamp(U.int(st.verdict.value, 0) + U.int(delta, 0), 0, 100);
      K.setVerdict(v, { note: (opts && opts.note) || st.verdict.note, mood: opts && opts.mood });
      return v;
    },

    moodOf: function (key) {
      for (var i = 0; i < MOODS.length; i++) if (MOODS[i].key === key) return MOODS[i];
      return MOODS[2];
    },

    /** 好感联动的心情推导：反向模式下由裁定值 + 波动推导 Char 的心情 */
    deriveMood: function () {
      var st = K.state;
      if (!st) return K.moodOf('calm');
      var v = U.int(st.verdict.value, 0);
      var last = st.quiet.thread.filter(function (m) { return m.role !== 'system'; }).slice(-1)[0];
      var recentTouch = st.stats.touches;
      if (v >= 90) return K.moodOf(recentTouch % 3 === 0 ? 'possessive' : 'ecstatic');
      if (v >= 72) return K.moodOf('happy');
      if (v >= 48) return K.moodOf('calm');
      if (v >= 28) return K.moodOf('anxious');
      if (v >= 12) return K.moodOf(recentTouch % 2 === 0 ? 'jealous' : 'anxious');
      return K.moodOf('anxious');
    },

    // ------------------------------------------------------------------
    //  3.2 事件总线（模组内部，用于刷新视图）
    // ------------------------------------------------------------------

    _listeners: {},
    on: function (evt, fn) {
      (K._listeners[evt] = K._listeners[evt] || []).push(fn);
      return function () {
        var a = K._listeners[evt] || [];
        var i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    },
    emit: function (evt, payload) {
      (K._listeners[evt] || []).forEach(function (fn) {
        try { fn(payload); } catch (e) { console.warn('[心动游戏] 监听器异常 ' + evt, e); }
      });
      (K._listeners['*'] || []).forEach(function (fn) {
        try { fn(evt, payload); } catch (e) {}
      });
    },

    // ------------------------------------------------------------------
    //  3.3 钱包
    // ------------------------------------------------------------------

    /** 变更代币 / 代金券；amount 为负即消费。返回是否成功。 */
    spend: function (kind, amount, reason) {
      var st = K.state;
      if (!st) return false;
      var n = Math.abs(U.int(amount, 0));
      if (kind === 'tokens') {
        if (st.wallet.tokens < n) return false;
        st.wallet.tokens -= n;
      } else if (kind === 'vouchers') {
        if (st.wallet.vouchers < n) return false;
        st.wallet.vouchers -= n;
      } else if (kind === 'draws') {
        if (st.wallet.draws < n) return false;
        st.wallet.draws -= n;
      } else return false;
      st.wallet.totalSpent = U.int(st.wallet.totalSpent, 0) + n;
      K.save();
      K.emit('wallet', { kind: kind, delta: -n, reason: reason || '' });
      return true;
    },

    earn: function (kind, amount, reason) {
      var st = K.state;
      if (!st) return 0;
      var n = Math.max(0, U.int(amount, 0));
      if (kind === 'tokens') st.wallet.tokens += n;
      else if (kind === 'vouchers') st.wallet.vouchers += n;
      else if (kind === 'draws') st.wallet.draws += n;
      else return 0;
      K.save();
      K.emit('wallet', { kind: kind, delta: n, reason: reason || '' });
      return n;
    },

    /** 外接「钱宝」充值通道（纯表现层模拟，不接真实支付） */
    recharge: function (voucherAmount) {
      var st = K.state;
      if (!st) return;
      var n = Math.max(0, U.int(voucherAmount, 0));
      st.wallet.vouchers += n;
      st.wallet.totalRecharge = U.int(st.wallet.totalRecharge, 0) + n;
      K.pushTimeline({ type: 'recharge', title: '钱宝充值', text: '通过钱宝通道充值 ' + n + ' 份仿制代金券。' });
      K.save();
      K.emit('wallet', { kind: 'vouchers', delta: n, reason: 'recharge' });
      return n;
    },

    /** 兑换：1 代金券 = rate 代币 */
    exchangeVoucher: function (vouchers, rate) {
      var st = K.state;
      if (!st) return false;
      var r = U.int(rate, 100) || 100;
      if (!K.spend('vouchers', vouchers, 'exchange')) return false;
      K.earn('tokens', U.int(vouchers, 0) * r, 'exchange');
      return true;
    },

    // ------------------------------------------------------------------
    //  3.4 任务
    // ------------------------------------------------------------------

    /** 任务周期键 */
    _periodKey: function (scope) {
      if (scope === 'weekly') return 'w' + U.weekStart();
      return 'd' + U.dayKey();
    },

    /** 滚动任务周期（新的一天 / 新的一周自动重置并累计「已完成」计数） */
    rollQuests: function () {
      var st = K.state;
      if (!st) return;
      var today = U.dayKey();
      var wk = U.weekStart();
      var changed = false;
      if (st.quests.dayKey !== today) {
        st.quests.dayKey = today;
        changed = true;
      }
      if (st.quests.weekStart !== wk) {
        st.quests.weekStart = wk;
        changed = true;
      }
      BASE_QUESTS.forEach(function (q) {
        var rec = st.quests.base[q.key];
        var pk = K._periodKey(q.scope);
        if (!rec || rec.period !== pk) {
          var prevDone = rec && rec.done;
          st.quests.base[q.key] = {
            progress: 0, done: false, claimed: false, period: pk,
            // 周常「委托达人」需要统计本周完成的每日数
            streak: q.key === 'quest' ? 0 : (rec ? rec.streak : 0),
            lastDone: prevDone ? Date.now() : (rec && rec.lastDone)
          };
          changed = true;
        }
      });
      if (changed) K.save();
    },

    /** 任务进度 +1（或 +n） */
    progressQuest: function (key, amount, scope) {
      var st = K.state;
      if (!st) return null;
      K.rollQuests();
      var rec = st.quests.base[key];
      if (!rec) {
        // 动态委托的进度走 dynamic 数组
        var dyn = st.quests.dynamic.filter(function (q) { return q.key === key; })[0];
        if (dyn) {
          dyn.progress = U.int(dyn.progress, 0) + U.int(amount, 1);
          dyn.done = dyn.progress >= U.int(dyn.target, 1);
          K.save();
          K.emit('quest', { key: key, dynamic: true, done: dyn.done, progress: dyn.progress });
          return dyn;
        }
        return null;
      }
      var def = BASE_QUESTS.filter(function (q) { return q.key === key; })[0];
      if (!def) return rec;
      rec.progress = U.int(rec.progress, 0) + U.int(amount, 1);
      var wasDone = rec.done;
      rec.done = rec.progress >= def.target;
      if (rec.done && !wasDone) {
        rec.claimedAt = null;
        // 周常委托计数
        if (scope === 'daily' || def.scope === 'daily') {
          var qrec = st.quests.base['quest'];
          if (qrec) qrec.streak = U.int(qrec.streak, 0) + 1;
        }
      }
      K.save();
      K.emit('quest', { key: key, dynamic: false, done: rec.done, progress: rec.progress });
      return rec;
    },

    /** 领取任务奖励 */
    claimQuest: function (key) {
      var st = K.state;
      if (!st) return false;
      K.rollQuests();
      var rec = st.quests.base[key];
      if (!rec || !rec.done || rec.claimed) return false;
      var def = BASE_QUESTS.filter(function (q) { return q.key === key; })[0];
      rec.claimed = true;
      if (def) K.earn('tokens', def.reward, 'quest:' + key);
      K.pushTimeline({ type: 'quest', title: '委托结算', text: '完成每日委托「' + (def ? def.name : key) + '」。' });
      K.save();
      K.emit('quest', { key: key, claimed: true });
      return true;
    },

    /** 整体完成度（阶梯宝箱进度条 = 全任务完成度平均值） */
    questCompletion: function () {
      var st = K.state;
      if (!st) return 0;
      K.rollQuests();
      var total = 0, sum = 0;
      BASE_QUESTS.forEach(function (q) {
        total++;
        var rec = st.quests.base[q.key];
        var p = rec ? U.clamp(U.int(rec.progress, 0) / (U.int(q.target, 1) || 1) * 100, 0, 100) : 0;
        sum += p;
      });
      st.quests.dynamic.forEach(function (q) {
        total++;
        sum += U.clamp(U.int(q.progress, 0) / (U.int(q.target, 1) || 1) * 100, 0, 100);
      });
      return total ? sum / total : 0;
    },

    /** 宝箱可领取节点 */
    chestReady: function () {
      var st = K.state;
      if (!st) return [];
      var pct = K.questCompletion();
      return CHEST_NODES.filter(function (n) {
        return pct >= n.pct && !st.quests.chest.claimed[n.pct + '_' + st.quests.chest.cycle];
      });
    },

    claimChest: function (pct) {
      var st = K.state;
      if (!st) return false;
      var node = CHEST_NODES.filter(function (n) { return n.pct === Number(pct); })[0];
      if (!node) return false;
      var ck = node.pct + '_' + st.quests.chest.cycle;
      if (st.quests.chest.claimed[ck]) return false;
      st.quests.chest.claimed[ck] = true;
      if (node.tokens) K.earn('tokens', node.tokens, 'chest');
      if (node.draws) K.earn('draws', node.draws, 'chest');
      if (node.pct === 100) st.quests.chest.cycle = U.int(st.quests.chest.cycle, 1) + 1;
      K.pushTimeline({ type: 'chest', title: '阶段宝箱', text: '领取进度 ' + node.pct + '% 阶段奖励：' + node.label });
      K.save();
      K.emit('chest', { pct: node.pct });
      return true;
    },

    /**
     * 写入动态衍生任务
     * 攻略模式：Char 抛出专属日常委托；反向模式：User 发布任务给 Char
     */
    addDynamicQuest: function (quest) {
      var st = K.state;
      if (!st) return null;
      var q = {
        key: quest.key || U.uid('dq'),
        name: quest.name || '未命名委托',
        desc: quest.desc || '',
        target: U.int(quest.target, 1),
        progress: U.int(quest.progress, 0),
        reward: U.int(quest.reward, 80),
        side: quest.side || (st.mode === MODE.STRATEGY ? 'char' : 'user'),
        byChar: quest.side !== 'user',
        createdAt: Date.now(),
        done: false,
        meta: quest.meta || null
      };
      if (q.side === 'user') st.quests.reverse.unshift(q);
      else st.quests.dynamic.unshift(q);
      if (st.quests.dynamic.length > 12) st.quests.dynamic.length = 12;
      if (st.quests.reverse.length > 12) st.quests.reverse.length = 12;
      K.save();
      K.emit('quest', { key: q.key, created: true });
      return q;
    },

    /** Char「完成」User 发布的任务（反向模式结算） */
    settleReverseQuest: function (key, opts) {
      var o = opts || {};
      var st = K.state;
      if (!st) return null;
      var q = st.quests.reverse.filter(function (x) { return x.key === key; })[0];
      if (!q) return null;
      q.done = true;
      q.settledAt = Date.now();
      q.result = o.result || 'TA 说：我做到了。';
      var reward = U.int(q.reward, 80);
      // User 给予 Char 虚拟奖励 → 转化为 User 对 Char 的裁定加成
      K.nudgeVerdict(o.verdictDelta === undefined ? 3 : o.verdictDelta, { note: '任务结算：' + q.name });
      K.pushTimeline({ type: 'quest', title: '任务结算', text: '「' + q.name + '」已由 TA 完成' + (q.result ? '：' + q.result : '') + '。' });
      K.earn('tokens', Math.round(reward * 0.5), 'reverse-quest');
      K.save();
      K.emit('quest', { key: key, settled: true });
      return q;
    },

    /** 删除动态任务 */
    removeDynamicQuest: function (key, side) {
      var st = K.state;
      if (!st) return false;
      var list = (side === 'user') ? st.quests.reverse : st.quests.dynamic;
      var i = -1;
      for (var k = 0; k < list.length; k++) if (list[k].key === key) { i = k; break; }
      if (i < 0) return false;
      list.splice(i, 1);
      K.save();
      return true;
    },

    // ------------------------------------------------------------------
    //  3.5 商店 / 经济
    // ------------------------------------------------------------------

    /** Char 侧的内置商品目录（可被 overrides 覆盖 / 扩展） */
    catalog: function () {
      var st = K.state;
      var custom = (st && st.overrides && st.overrides.shopItems) || null;
      if (Array.isArray(custom) && custom.length) return custom.slice();
      return defaultGoods();
    },

    /** 反向模式：User 上架自制道具 */
    listGoods: function (item) {
      var st = K.state;
      if (!st) return null;
      var it = {
        id: item.id || U.uid('goods'),
        name: String(item.name || '').trim() || '无名之物',
        desc: String(item.desc || '').trim(),
        price: Math.max(0, U.int(item.price, 10)),
        category: item.category || 'letter',
        icon: item.icon || 'gift',
        custom: true,
        createdAt: Date.now(),
        stock: U.int(item.stock, -1)
      };
      st.shop.listed.unshift(it);
      K.pushTimeline({ type: 'shop', title: '上架商品', text: '你把「' + it.name + '」摆上了私享杂货商的货架，售价 ' + it.price + ' 心动代币。' });
      K.save();
      K.emit('shop', { listed: it });
      return it;
    },

    unlistGoods: function (id) {
      var st = K.state;
      if (!st) return false;
      var before = st.shop.listed.length;
      st.shop.listed = st.shop.listed.filter(function (x) { return x.id !== id; });
      K.save();
      return st.shop.listed.length !== before;
    },

    /** 找到商品（内置 + 上架） */
    findGoods: function (id) {
      var all = K.catalog().concat(K.state ? K.state.shop.listed : []);
      for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
      return null;
    },

    /** 购买商品（攻略模式：User 买给 Char） */
    buyGoods: function (id, opts) {
      var o = opts || {};
      var st = K.state;
      if (!st) return { ok: false, msg: '状态未就绪' };
      var g = K.findGoods(id);
      if (!g) return { ok: false, msg: '找不到这件商品' };
      var price = Math.max(0, U.int(g.price, 0));
      if (st.wallet.tokens < price) return { ok: false, msg: '心动代币不足，还差 ' + (price - st.wallet.tokens) };
      st.wallet.tokens -= price;
      st.wallet.totalSpent = U.int(st.wallet.totalSpent, 0) + price;
      if (o.gift !== false) {
        st.shop.owned.unshift({ goodsId: g.id, at: Date.now(), count: 1 });
        K.pushTimeline({ type: 'gift', title: '赠礼', text: '你买下了「' + g.name + '」。' });
      }
      K.progressQuest('gift', 1);
      K.save();
      K.emit('shop', { bought: g, gifted: o.gift !== false });
      return { ok: true, goods: g, cost: price };
    },

    /**
     * 反向模式：Char 自动采购 User 上架的商品回送
     * @returns {object|null} 采购记录
     */
    charAutoPurchase: function (poolId) {
      var st = K.state;
      if (!st) return null;
      var shelf = st.shop.listed.slice();
      if (!shelf.length) return null;
      // 好感越高越舍得花钱
      var v = U.int(st.verdict.value, 0);
      var budget = 60 + v * 12 + Math.floor(Math.random() * 120);
      var affordable = shelf.filter(function (x) { return U.int(x.price, 0) <= budget; });
      var pick = (affordable.length ? U.shuffled(affordable) : U.shuffled(shelf))[0];
      var rec = {
        id: U.uid('buy'),
        goodsId: pick.id,
        name: pick.name,
        price: U.int(pick.price, 0),
        at: Date.now(),
        line: pick.price <= budget
          ? 'TA 毫不犹豫地拍下了「' + pick.name + '」'
          : 'TA 犹豫了很久，还是把「' + pick.name + '」放进了购物车'
      };
      st.shop.purchases.unshift(rec);
      if (st.shop.purchases.length > 60) st.shop.purchases.length = 60;
      st.bond.giftsReceived = U.int(st.bond.giftsReceived, 0) + 1;
      st.wallet.vouchers += Math.round(U.int(pick.price, 0) * 0.1); // 平台抽成表现层
      K.pushTimeline({ type: 'buy', title: 'TA 采购了你的商品', text: rec.line + '（' + rec.price + ' 心动代币）' });
      K.save();
      K.emit('shop', { purchase: rec });
      return rec;
    },

    // ------------------------------------------------------------------
    //  3.6 羁绊 / 时间轴 / 记忆回廊
    // ------------------------------------------------------------------

    pushTimeline: function (evt) {
      var st = K.state;
      if (!st) return null;
      var row = {
        id: U.uid('tl'),
        type: evt.type || 'system',
        title: evt.title || '',
        text: evt.text || '',
        at: evt.at || Date.now(),
        meta: evt.meta || null
      };
      st.bond.timeline.unshift(row);
      if (st.bond.timeline.length > 400) st.bond.timeline.length = 400;
      if (!st.bond.firstMeetAt && evt.type === 'meet') st.bond.firstMeetAt = row.at;
      K.save();
      K.emit('timeline', row);
      return row;
    },

    addMemory: function (mem) {
      var st = K.state;
      if (!st) return null;
      var row = {
        id: U.uid('mem'),
        title: String(mem.title || '未命名回忆'),
        summary: String(mem.summary || ''),
        quotes: Array.isArray(mem.quotes) ? mem.quotes.slice(0, 6) : [],
        source: mem.source || 'quiet',
        tier: mem.tier || (st.tierKey),
        at: mem.at || Date.now(),
        cover: mem.cover || null,
        tags: Array.isArray(mem.tags) ? mem.tags : []
      };
      st.bond.memories.unshift(row);
      if (st.bond.memories.length > 200) st.bond.memories.length = 200;
      K.save();
      K.emit('memory', row);
      return row;
    },

    removeMemory: function (id) {
      var st = K.state;
      if (!st) return false;
      var before = st.bond.memories.length;
      st.bond.memories = st.bond.memories.filter(function (x) { return x.id !== id; });
      K.save();
      return st.bond.memories.length !== before;
    },

    /** 好感变动流水（只留最近 120 条，供羁绊面板溯源） */
    logAffinity: function (delta, reason, before, after) {
      var st = K.state;
      if (!st || !delta) return;
      st.bond.affinityLog = st.bond.affinityLog || [];
      st.bond.affinityLog.unshift({ d: delta, r: reason || '', b: before, a: after, t: Date.now() });
      if (st.bond.affinityLog.length > 120) st.bond.affinityLog.length = 120;
    },

    // ------------------------------------------------------------------
    //  3.7 静室
    // ------------------------------------------------------------------

    pushQuiet: function (msg) {
      var st = K.state;
      if (!st) return null;
      var row = {
        id: U.uid('q'),
        role: msg.role || 'char',
        text: String(msg.text || ''),
        tone: msg.tone || null,
        at: msg.at || Date.now(),
        meta: msg.meta || null
      };
      st.quiet.thread.push(row);
      if (st.quiet.thread.length > 300) st.quiet.thread = st.quiet.thread.slice(-300);
      st.quiet.lastActiveAt = row.at;
      K.save();
      K.emit('quiet', row);
      return row;
    },

    /** 静室系统日志卡（与对话流混排） */
    pushQuietSystem: function (text, tone) {
      return K.pushQuiet({ role: 'system', text: text, tone: tone || 'system' });
    },

    clearQuiet: function () {
      var st = K.state;
      if (!st) return;
      st.quiet.thread = [];
      K.save(true);
    },

    // ------------------------------------------------------------------
    //  3.8 立绘 / 背景资源池（LRU）
    // ------------------------------------------------------------------

    /** 触碰 LRU：把 key 提到最前 */
    touchAsset: function (key) {
      var st = K.state;
      if (!st) return;
      var pool = st.assets.pool || (st.assets.pool = []);
      var i = pool.indexOf(key);
      if (i >= 0) pool.splice(i, 1);
      pool.unshift(key);
      // 淘汰超限的（只删内存缓存，不删用户数据）
      while (pool.length > ASSET_POOL_LIMIT) {
        var drop = pool.pop();
        if (drop && typeof window.tileAssetClearCache === 'function') window.tileAssetClearCache(drop);
      }
      K.save();
    },

    /** 立绘列表操作 */
    addPortrait: function (p) {
      var st = K.state;
      if (!st) return null;
      var row = {
        id: p.id || U.uid('pt'),
        name: String(p.name || '未命名立绘'),
        kind: p.kind === 'live2d' ? 'live2d' : 'image',
        src: p.src || '',
        modelUrl: p.modelUrl || '',
        tags: Array.isArray(p.tags) ? p.tags : [],
        current: false,
        createdAt: Date.now()
      };
      st.assets.portraits.push(row);
      if (!st.assets.currentPortraitId) K.setCurrentPortrait(row.id);
      K.save();
      K.emit('portrait', row);
      return row;
    },

    removePortrait: function (id) {
      var st = K.state;
      if (!st) return false;
      st.assets.portraits = st.assets.portraits.filter(function (x) { return x.id !== id; });
      delete st.assets.hotspots[id];
      delete st.assets.hotspotActions[id];
      if (st.assets.currentPortraitId === id) {
        st.assets.currentPortraitId = st.assets.portraits.length ? st.assets.portraits[0].id : null;
      }
      K.save();
      K.emit('portrait', { removed: id });
      return true;
    },

    setCurrentPortrait: function (id) {
      var st = K.state;
      if (!st) return false;
      st.assets.portraits.forEach(function (p) { p.current = (p.id === id); });
      st.assets.currentPortraitId = id;
      K.save();
      K.emit('portrait', { current: id });
      return true;
    },

    currentPortrait: function () {
      var st = K.state;
      if (!st) return null;
      var id = st.assets.currentPortraitId;
      var list = st.assets.portraits;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return list[0] || null;
    },

    addBackground: function (b) {
      var st = K.state;
      if (!st) return null;
      var row = {
        id: b.id || U.uid('bg'),
        name: String(b.name || '未命名场景'),
        scene: b.scene || '室内',
        src: b.src || '',
        tags: Array.isArray(b.tags) ? b.tags : [],
        createdAt: Date.now()
      };
      st.assets.backgrounds.push(row);
      if (!st.assets.currentBackgroundId) st.assets.currentBackgroundId = row.id;
      K.save();
      K.emit('background', row);
      return row;
    },

    removeBackground: function (id) {
      var st = K.state;
      if (!st) return false;
      st.assets.backgrounds = st.assets.backgrounds.filter(function (x) { return x.id !== id; });
      if (st.assets.currentBackgroundId === id) {
        st.assets.currentBackgroundId = st.assets.backgrounds.length ? st.assets.backgrounds[0].id : null;
      }
      K.save();
      return true;
    },

    setCurrentBackground: function (id) {
      var st = K.state;
      if (!st) return false;
      st.assets.currentBackgroundId = id;
      K.save();
      K.emit('background', { current: id });
      return true;
    },

    currentBackground: function () {
      var st = K.state;
      if (!st) return null;
      var id = st.assets.currentBackgroundId;
      var list = st.assets.backgrounds;
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return list[0] || null;
    },

    /**
     * 热区几何：保存过的部位用保存值，**缺失的部位补默认版式**。
     * 这样在可视化编辑器里只调过一个部位时，其余部位依然可以戳
     * （早期版本只返回已保存的子集，导致掩码导出只剩一条路径、其余热区失效）。
     */
    hotspotsOf: function (portraitId) {
      var st = K.state;
      var base = DEFAULT_HOTSPOTS();
      var saved = (st && st.assets && st.assets.hotspots && st.assets.hotspots[portraitId]) || null;
      if (!saved) return base;
      Object.keys(base).forEach(function (k) {
        var g = saved[k];
        if (g && typeof g.x === 'number') {
          base[k] = {
            x: U.clamp(g.x, 0, 1), y: U.clamp(g.y, 0, 1),
            rx: U.clamp(g.rx, 0.01, 0.6), ry: U.clamp(g.ry, 0.01, 0.6)
          };
        }
      });
      return base;
    },

    setHotspot: function (portraitId, key, geom) {
      var st = K.state;
      if (!st) return;
      st.assets.hotspots[portraitId] = st.assets.hotspots[portraitId] || {};
      st.assets.hotspots[portraitId][key] = {
        x: U.clamp(geom.x, 0, 1), y: U.clamp(geom.y, 0, 1),
        rx: U.clamp(geom.rx, 0.01, 0.6), ry: U.clamp(geom.ry, 0.01, 0.6)
      };
      K.save();
      K.emit('hotspot', { portraitId: portraitId, key: key });
    },

    /** 热区动作库：记录每个部位被戳时的专属反应 */
    pushHotspotAction: function (portraitId, key, action) {
      var st = K.state;
      if (!st) return null;
      st.assets.hotspotActions[portraitId] = st.assets.hotspotActions[portraitId] || {};
      var list = st.assets.hotspotActions[portraitId][key] = st.assets.hotspotActions[portraitId][key] || [];
      var row = { text: String(action.text || ''), at: Date.now(), tier: action.tier || st.tierKey, affinity: U.int(action.affinity, 0) };
      list.unshift(row);
      if (list.length > 30) list.length = 30;
      K.save();
      return row;
    },

    hotspotActionsOf: function (portraitId, key) {
      var st = K.state;
      var byP = (st && st.assets.hotspotActions && st.assets.hotspotActions[portraitId]) || {};
      return byP[key] || [];
    },

    // ------------------------------------------------------------------
    //  3.9 记忆回流：把心动游戏的关键节点写进 db.summaries，让主聊天能召回
    // ------------------------------------------------------------------

    /**
     * 写入主记忆（db.summaries）。sessionId 由调用方给（通常是当前单聊会话）。
     * category 统一用 'heartgame'，便于主聊天的记忆召回按类过滤。
     * 注意 keywords 必须是 JSON 字符串（与 app_chat_couples.js / app_chat.js 的写入约定一致）。
     */
    writeMainMemory: async function (sessionId, content, keywords) {
      var d = K.db();
      if (!d || !sessionId) return false;
      var tbl = K._table('summaries');
      if (!tbl) return false;
      var row = {
        sessionId: Number(sessionId),
        startRound: 0,
        endRound: 0,
        content: String(content || ''),
        category: 'heartgame',
        keywords: JSON.stringify(Array.isArray(keywords) ? keywords : []),
        timestamp: Date.now(),
        source: 'heartgame',
        vector: null
      };
      var ok = await K._withTimeout(tbl.add(row), 4000, false);
      return ok !== false;
    },

    /** 把时间轴里最近的节点汇总成一段可被主聊天读到的记忆 */
    buildMemoryDigest: function (limit) {
      var st = K.state;
      if (!st) return '';
      var rows = (st.bond.timeline || []).slice(0, limit || 6);
      if (!rows.length) return '';
      var lines = rows.map(function (r) { return '· ' + (r.title ? r.title + '：' : '') + r.text; });
      return '【心动游戏近况】\n' + lines.join('\n');
    },

    // ------------------------------------------------------------------
    //  3.10 后台管理：记忆与进度格式化
    // ------------------------------------------------------------------

    /** 清除指定范围（严格保护 User 原生档案：只动心动游戏自己的数据） */
    clearScope: async function (scope) {
      var st = K.state;
      if (!st) return false;
      if (scope === 'affinity') {
        st.affinity = 0; st.tierKey = 'acquaint'; st.gateDone = {}; st.peakAffinity = 0;
        st.bond.affinityLog = [];
      } else if (scope === 'story') {
        st.story.arcs = []; st.story.activeArcId = null; st.story.branches = [];
        st.story.phone = { sms: [], moments: [], calls: [] };
      } else if (scope === 'quiet') {
        st.quiet.thread = [];
      } else if (scope === 'quests') {
        st.quests = blankState().quests;
      } else if (scope === 'shop') {
        st.shop = blankState().shop;
      } else if (scope === 'gacha') {
        st.gacha = blankState().gacha;
      } else if (scope === 'bond') {
        st.bond.timeline = []; st.bond.memories = [];
      } else if (scope === 'wallet') {
        st.wallet = blankState().wallet;
      } else if (scope === 'all') {
        var keepAssets = st.assets;
        var fresh = blankState(st.charId, st.meId);
        fresh.assets = keepAssets;
        fresh.mode = st.mode;
        fresh.difficulty = st.difficulty;
        fresh.overrides = st.overrides;
        // 丢掉上一次的防抖保存：它属于旧 state，放任它触发会把旧数据写回
        K._cancelPendingSave();
        K.state = fresh;
      } else {
        return false;
      }
      K.save(true);
      K.emit('cleared', { scope: scope });
      return true;
    },

    // ------------------------------------------------------------------
    //  3.11 LLM 适配（统一走 apiRoutes + fwCallLLM）
    // ------------------------------------------------------------------

    api: null,

    resolveApi: async function () {
      try {
        if (window.apiRoutes && typeof window.apiRoutes.resolve === 'function') {
          var api = await window.apiRoutes.resolve('heartgame');
          if (api) { K.api = api; return api; }
        }
      } catch (e) { /* 回落全局 */ }
      return K.api || null;
    },

    /**
     * 统一的模型调用：失败/未配置都返回 null，绝不抛到 UI 层
     * @param {string} prompt
     * @param {object} opts { temperature, system, maxTokens }
     * @returns {Promise<string|null>}
     */
    ask: async function (prompt, opts) {
      var o = opts || {};
      var api = await K.resolveApi();
      if (!api) return null;
      if (typeof window.fwCallLLM !== 'function') return null;
      var messages = [];
      if (o.system) messages.push({ role: 'system', content: o.system });
      messages.push({ role: 'user', content: String(prompt || '') });
      try {
        var out = await window.fwCallLLM(api, messages, {
          temperature: o.temperature === undefined ? 0.85 : o.temperature,
          maxTokens: o.maxTokens
        });
        return (out === undefined || out === null) ? null : String(out);
      } catch (e) {
        console.warn('[心动游戏] 模型调用失败:', e);
        return null;
      }
    },

    /** 问 JSON：自动抠出对象，失败返回 fallback */
    askJSON: async function (prompt, fallback, opts) {
      var out = await K.ask(prompt, opts);
      if (!out) return fallback;
      var obj = U.parseJSON(out, null);
      return obj || fallback;
    },

    // ------------------------------------------------------------------
    //  3.12 角色 / User 资料读取
    // ------------------------------------------------------------------

    /** 读取 Char 档案（含后台覆盖字段） */
    charProfile: async function () {
      var d = K.db();
      var st = K.state;
      var row = null;
      if (d && K.charId && K._table('archives')) row = await K._withTimeout(d.archives.get(Number(K.charId)), 3000, null);
      var ov = (st && st.overrides && st.overrides.char) || {};
      return {
        id: K.charId,
        name: ov.name || (row && row.name) || 'TA',
        avatar: ov.avatar || (row && row.avatar) || '',
        persona: ov.persona || (row && row.persona) || '',
        remark: ov.remark || (row && row.remark) || '',
        raw: row || null
      };
    },

    /** 读取 User 面具档案 */
    userProfile: async function () {
      var d = K.db();
      var st = K.state;
      var row = null;
      if (d && K.meId && K._table('archives')) row = await K._withTimeout(d.archives.get(Number(K.meId)), 3000, null);
      var ov = (st && st.overrides && st.overrides.user) || {};
      return {
        id: K.meId,
        name: ov.name || (row && row.name) || '你',
        avatar: ov.avatar || (row && row.avatar) || '',
        persona: ov.persona || (row && row.persona) || '',
        tags: (st && st.overrides && st.overrides.userTags) || [],
        reactPref: (st && st.overrides && st.overrides.userReact) || '',
        raw: row || null
      };
    },

    /** 角色库列表（切换器用） */
    listCharacters: async function () {
      var d = K.db();
      if (!d || !K._table('archives')) return [];
      var all = await K._withTimeout(d.archives.toArray(), 4000, []);
      return (all || []).filter(function (a) {
        return a && (a.type === 'character' || !a.type);
      });
    },

    /** 全部面具 */
    listPersonas: async function () {
      var d = K.db();
      if (!d || !K._table('archives')) return [];
      var all = await K._withTimeout(d.archives.toArray(), 4000, []);
      return (all || []).filter(function (a) { return a && a.type === 'user'; });
    },

    /** 当前单聊会话 id（写记忆回流用） */
    resolveSessionId: async function () {
      var d = K.db();
      try {
        if (typeof activeSessionId !== 'undefined' && activeSessionId) {
          var s = d ? await K._withTimeout(d.sessions.get(Number(activeSessionId)), 2500, null) : null;
          if (s && s.isGroup !== 1) return Number(activeSessionId);
        }
      } catch (e) {}
      if (!d || !K.charId || !K.meId) return null;
      var sess = await K._withTimeout(
        d.sessions.where('userId').equals(Number(K.meId)).toArray(), 3500, []
      );
      var hit = (sess || []).filter(function (s) {
        return s && s.isGroup !== 1 && Number(s.charId) === Number(K.charId);
      })[0];
      return hit ? Number(hit.id) : null;
    },

    // ------------------------------------------------------------------
    //  3.13 模式切换
    // ------------------------------------------------------------------

    setMode: function (mode) {
      var st = K.state;
      if (!st || !MODE[mode]) return false;
      if (st.mode === mode) return false;
      st.mode = mode;
      K.pushTimeline({
        type: 'mode',
        title: '世界线切换',
        text: mode === MODE.STRATEGY
          ? '切换到「攻略模式」：这一次，由你来靠近 TA。'
          : '切换到「被攻略模式」：TA 端起了手机，屏幕里是你。'
      });
      K.save(true);
      K.emit('mode', mode);
      return true;
    },

    setDifficulty: function (key) {
      var st = K.state;
      if (!st) return false;
      if (!DIFFICULTIES.some(function (d) { return d.key === key; })) return false;
      st.difficulty = key;
      K.save();
      K.emit('difficulty', key);
      return true;
    },

    /** 当前是否反向模式 */
    isReverse: function () {
      return !!(K.state && K.state.mode === MODE.REVERSE_STRATEGY);
    }
  };

  // ==========================================================================
  //  4. 内置商品目录（Char 侧商店）
  // ==========================================================================

  /** 内置商品目录（Char 侧商店）。用函数返回新数组，避免调用方改到共享引用。 */
  function defaultGoods() {
    return [
      { id: 'g-scarf',    name: '雾蓝羊绒围巾',   desc: '浅雾蓝的羊绒，围上去会让人想低头闻一下。',      price: 180,  category: 'wear',      icon: 'gift' },
      { id: 'g-ring',     name: '细银誓约戒',     desc: '内圈可以刻字，但刻什么要你自己想。',            price: 520,  category: 'accessory', icon: 'star' },
      { id: 'g-watch',    name: '星芒怀表',       desc: '打开时会有一小段光落进掌心。',                  price: 460,  category: 'accessory', icon: 'clock' },
      { id: 'g-tie',      name: '深灰暗纹领带',   desc: '你替他挑的领带，他大概会天天戴。',              price: 240,  category: 'wear',      icon: 'gift' },
      { id: 'g-coffee',   name: '深夜手冲咖啡',   desc: '凌晨三点还醒着的人，需要这一杯。',              price: 60,   category: 'consumable', icon: 'smile' },
      { id: 'g-cake',     name: '草莓奶油蛋糕',   desc: '甜到有点过分，但他不会拒绝。',                  price: 88,   category: 'consumable', icon: 'heart' },
      { id: 'g-letter',   name: '火漆手写信',     desc: '信纸上会留一枚暗红色的火漆。',                  price: 150,  category: 'letter',    icon: 'book' },
      { id: 'g-perfume',  name: '雨后雪松香',     desc: '像他刚从雨里走进来那一刻的味道。',              price: 320,  category: 'accessory', icon: 'sparkle' },
      { id: 'g-cover',    name: '整夜的肩靠',     desc: '特权：让他枕着你的肩睡一整夜。',                price: 880,  category: 'privilege', icon: 'bond' },
      { id: 'g-dance',    name: '月光下的一支舞', desc: '特权：无人的露台上，只有你们两个人。',          price: 999,  category: 'privilege', icon: 'sparkle' }
    ];
  }

  /** 标准热区版式（相对立绘画布 0-1） */
  function DEFAULT_HOTSPOTS() {
    return {
      hair:  { x: 0.50, y: 0.10, rx: 0.19, ry: 0.11 },
      face:  { x: 0.50, y: 0.22, rx: 0.12, ry: 0.08 },
      neck:  { x: 0.50, y: 0.33, rx: 0.08, ry: 0.05 },
      chest: { x: 0.50, y: 0.46, rx: 0.17, ry: 0.11 },
      arm:   { x: 0.26, y: 0.52, rx: 0.10, ry: 0.14 },
      hand:  { x: 0.74, y: 0.62, rx: 0.09, ry: 0.07 },
      leg:   { x: 0.50, y: 0.82, rx: 0.18, ry: 0.14 }
    };
  }

  // ==========================================================================
  //  5. 导出
  // ==========================================================================

  var HeartGame = {
    VERSION: VERSION,
    K: K,
    H: H,
    U: U,
    Skin: Skin,
    /**
     * 本模组用到的生成式素材清单（Skin.probeAll 的入参；缺哪张就回落哪张）。
     *
     * 注意：这里**只登记真的存在、且真的需要**的素材。曾经登记过一批「UI 框框 / 按钮玻璃底」，
     * 后来全部撤掉了，原因（留给后续不要再犯）：
     *   1) 生成模型只会输出不透明图（白底），而玻璃元件本身就是白色的 ——
     *      按亮度抠白必然把元件自己的高光一起抠掉，抠完比不抠更脏（实测过）；
     *   2) 不抠就只能靠 multiply 混色，在浅色底上等于没效果，白边照旧可见；
     *   3) 纯 CSS 的玻璃拟态在浅色底上无色差、无白边、体积极小，观感反而更干净。
     * 所以：**UI 装饰一律用 CSS / 内联 SVG，生成式素材只用来做「插画类」内容**
     * （立绘、场景背景、卡池主视觉）——那才是模型真正擅长的东西。
     */
    SKIN_MANIFEST: [
      // 插画类（这些是生成式素材的正确用途）
      ['gacha', 'entry'],        // 抽卡入口：星盘法阵徽记（已抠白）
      ['gacha', 'banner'],        // 卡池主视觉
      ['portrait', 'default'],    // 内置默认立绘（黑发黑眸韩系厚涂，已抠白）
      ['stage', 'bg-night'],      // 场景：深夜房间（2.5D 厚涂）
      ['stage', 'bg-rain'],       // 场景：雨夜窗边（2.5D 厚涂）
      ['stage', 'bg-dusk']        // 场景：黄昏天台（2.5D 厚涂）
    ],
    C: {
      MODE: MODE,
      MODE_LABEL: MODE_LABEL,
      MODE_DESC: MODE_DESC,
      AFFINITY_TIERS: AFFINITY_TIERS,
      DIFFICULTIES: DIFFICULTIES,
      RARITY: RARITY,
      GACHA_RULES: GACHA_RULES,
      HOTSPOTS: HOTSPOTS,
      SHOP_CATEGORIES: SHOP_CATEGORIES,
      MOODS: MOODS,
      LOG_TONES: LOG_TONES,
      BASE_QUESTS: BASE_QUESTS,
      CHEST_NODES: CHEST_NODES,
      ASSET_PREFIX: ASSET_PREFIX,
      ASSET_POOL_LIMIT: ASSET_POOL_LIMIT,
      DEFAULT_GOODS: defaultGoods,
      defaultGoods: defaultGoods,
      DEFAULT_HOTSPOTS: DEFAULT_HOTSPOTS
    }
  };

  window.HeartGame = HeartGame;

  // 内置样式（动画关键帧 / 滚动条 / 玻璃质感），只注入一次
  (function injectStyle() {
    if (document.getElementById('heartgame-core-style')) return;
    var css = ''
      + '@keyframes hg-float-up{0%{opacity:0;transform:translate(-50%,-30%) scale(.86)}18%{opacity:1;'
      + 'transform:translate(-50%,-56%) scale(1.06)}100%{opacity:0;transform:translate(-50%,-150%) scale(.96)}}'
      + '@keyframes hg-breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-6px) scale(1.012)}}'
      + '@keyframes hg-shimmer{0%{background-position:-160% 0}100%{background-position:260% 0}}'
      + '@keyframes hg-pulse{0%,100%{opacity:.55;transform:scale(.94)}50%{opacity:1;transform:scale(1.06)}}'
      + '@keyframes hg-spin{to{transform:rotate(360deg)}}'
      + '@keyframes hg-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.08)}}'
      + '@keyframes hg-sway{0%,100%{transform:rotate(-.5deg)}50%{transform:rotate(.5deg)}}'
      + '@keyframes hg-rise{0%{opacity:0;transform:translateY(14px)}100%{opacity:1;transform:translateY(0)}}'
      + '.hg-spin{animation:hg-spin .9s linear infinite}'
      + '.hg-rise{animation:hg-rise .42s cubic-bezier(.22,1,.36,1) both}'
      + '.hg-breathe{animation:hg-breathe 4.6s ease-in-out infinite}'
      + '.hg-shimmer{background-image:linear-gradient(100deg,transparent 20%,rgba(255,255,255,.72) 50%,'
      + 'transparent 80%);background-size:200% 100%;animation:hg-shimmer 2.8s ease-in-out infinite}'
      + '.hg-overlay *,.hg-overlay *::before,.hg-overlay *::after{box-sizing:border-box}'
      + '.hg-sheet-body::-webkit-scrollbar{width:5px}'
      + '.hg-sheet-body::-webkit-scrollbar-thumb{background:rgba(217,127,168,.32);border-radius:99px}'
      + '.hg-sheet-body::-webkit-scrollbar-track{background:transparent}'
      + '.hg-tabs::-webkit-scrollbar{display:none}'
      + '.hg-touch{position:absolute;border-radius:50%;transform:translate(-50%,-50%);cursor:pointer;'
      + 'transition:box-shadow .25s ease,background .25s ease}'
      + '.hg-touch:hover{box-shadow:0 0 0 2px rgba(255,255,255,.7),0 0 22px rgba(217,127,168,.55)}'
      + '.hg-touch.hg-hit{animation:hg-pulse .7s ease}'
      + '.hg-portrait-img{animation:hg-breathe 4.6s ease-in-out infinite;transform-origin:50% 92%}'
      + '.hg-portrait-img.hg-sway{animation:hg-breathe 4.6s ease-in-out infinite, hg-sway 6.4s ease-in-out infinite}'
      + '.hg-btn:disabled{filter:grayscale(.3)}'
      + '.hg-glass-card::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;'
      + 'background:linear-gradient(120deg,transparent 42%,rgba(255,255,255,.42) 50%,transparent 58%);'
      + 'opacity:.55;mix-blend-mode:screen}';
    var s = document.createElement('style');
    s.id = 'heartgame-core-style';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  })();

})();
