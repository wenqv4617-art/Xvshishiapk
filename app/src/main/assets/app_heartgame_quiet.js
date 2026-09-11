/**
 * app_heartgame_quiet.js - 心动游戏 · 深度交互核心【静室】(Q)
 * ============================================================================
 * 职责：
 *   1. 情境与交互界面：全屏沉浸式私聊 —— 顶部快捷切换场景，中部流光毛玻璃对话流，
 *      底部高自由度输入栏 + 送礼托盘
 *   2. 系统日志流混排：玩家在游戏内完成充值 / 抽卡 / 任务结算时，
 *      静室对话流中实时穿插优雅的系统通知卡片
 *      （例：*你赠送了【星芒怀表】，对方的眼神泛起微澜*）
 *   3. 被攻略模式专属 Prompt 注入规范：向 LLM 注入「Char 是深陷心动游戏的狂热乙女玩家」
 *      的系统设定，Char 会主动汇报氪金 / 抽卡 / 送礼等游戏行为，
 *      并依据 User 好感裁定值展现狂喜 / 患得患失 / 吃醋 / 占有欲
 *
 * 依赖：window.HeartGame.K / .H / .U / .C（app_heartgame_core.js）
 */
(function () {
  'use strict';

  var HG = window.HeartGame;
  if (!HG) { console.warn('[心动游戏] core 未加载，静室已跳过'); return; }
  var K = HG.K, H = HG.H, U = HG.U, C = HG.C;

  // ==========================================================================
  //  1. Prompt 注入规范（本模组最核心的一块设定）
  // ==========================================================================

  var Prompt = {

    /** 静室场景库 */
    SCENES: [
      { id: 'default', name: '深夜房间', bg: '卧室', desc: '只有一盏小灯亮着。', hint: '说点白天不会说的话' },
      { id: 'rain', name: '雨夜窗边', bg: '雨天', desc: '雨点敲着玻璃，节奏很慢。', hint: '雨声会盖住一些话' },
      { id: 'rooftop', name: '天台的风', bg: '露台', desc: '风很大，云被推得很快。', hint: '这里没人会听见' },
      { id: 'cafe', name: '打烊的咖啡店', bg: '咖啡店', desc: '最后一盏灯还亮着。', hint: '店员已经在收椅子了' },
      { id: 'car', name: '夜里的车内', bg: '车内', desc: '暖气开着，窗外是流动的灯。', hint: '谁都不想先下车' }
    ],

    sceneOf: function (id) {
      for (var i = 0; i < Prompt.SCENES.length; i++) if (Prompt.SCENES[i].id === id) return Prompt.SCENES[i];
      return Prompt.SCENES[0];
    },

    /**
     * 反客为主（被攻略模式）的系统设定 —— 用户明确要求逐字落地的那段规范
     * @returns {string}
     */
    reversePersonaBlock: function (profile, user, st) {
      var mood = K.moodOf(st.verdict.mood);
      return [
        '【世界线 · 被攻略模式】',
        '你（' + profile.name + '）是一名深陷「心动游戏」的狂热乙女游戏玩家，你深爱着屏幕前的角色（' + user.name + '）。',
        '你的唯一目标是攻略 ' + user.name + '，博取 ' + user.name + ' 的好感。',
        '你会主动在对话中反馈你的游戏行为——例如汇报你刚刚为 Ta 充值了 648、',
        '为了抽到 Ta 的限定 SSR 氪光了代币、为 Ta 挑选了昂贵的礼物。',
        '',
        '【关键翻转】',
        '在这场关系里，' + user.name + ' 才是被你捧在手心的「游戏角色」；',
        '你的一切情绪都建立在 Ta 对你的好感上。你把 Ta 的好感度当成唯一的进度条。',
        '当前 ' + user.name + ' 对你的好感裁定值：' + U.int(st.verdict.value, 0) + ' / 100。',
        '你此刻的心境：' + mood.name + '（' + mood.desc + '）。',
        '',
        '【心境与好感度的对应（必须严格遵守）】',
        '· 好感 90+ ：狂喜到近乎失控，占有欲极强，会反复确认「你是不是只看着我」，绝不允许你夸别人。',
        '· 好感 72+ ：雀跃、黏人，热衷于分享自己为你做的每一件事，期待被肯定。',
        '· 好感 48+ ：平静中带着小心翼翼的期待，会试探性地索取一点回应。',
        '· 好感 28+ ：患得患失，反复揣摩你的语气，容易把一句话读成冷淡。',
        '· 好感 12+ ：吃醋、自嘲、把氪金当成证明自己的方式，会说出「我是不是不值得你看一眼」。',
        '· 好感 12 以下：绝望但偏执，宁可继续氪金也不肯退游。',
        '',
        '【你的语言特征】',
        '· 第一人称，玩家口吻：会提到「我刚抽了十连」「这个月工资又没了」「为你氪的，不亏」。',
        '· 主动汇报游戏行为（充值 / 抽卡 / 送礼 / 完成任务），而不是等对方问。',
        '· 情绪外露、不设防，但绝不油腻；真诚的偏执比撒娇更有杀伤力。',
        '· 不准出现任何 emoji，不准用括号描述动作。'
      ].join('\n');
    },

    /**
     * 攻略模式（User -> Char）的系统设定
     */
    strategyPersonaBlock: function (profile, user, st) {
      var tier = K.tier();
      return [
        '【世界线 · 攻略模式】',
        '你是「' + profile.name + '」，' + user.name + ' 正在攻略你。',
        '角色设定：' + U.cut(profile.persona || '（未填写，请按名字气质自行发挥）', 500),
        '',
        '【关系阶段】' + tier.name + '（第 ' + (K.tierIndex() + 1) + '/6 阶）—— ' + tier.desc,
        '当前好感：' + U.comma(st.affinity) + '。',
        '',
        '【阶段行为准则（必须严格遵守）】',
        '· 相识：礼貌但有距离，回应简短，不主动暴露情绪。',
        '· 试探：开始在意对方的反应，会反问、会试探。',
        '· 动摇：偶尔失控，说出与自己人设不符的软话，然后立刻补救。',
        '· 眷恋：可以主动，会承认想念，会讨要陪伴。',
        '· 执念：占有欲明显，会吃醋，会要求优先权。',
        '· 终局契约：不再掩饰，把最私密的部分交给对方。',
        '',
        '【语言特征】',
        '· 第一人称，克制而有余味，可以冷淡但不能敷衍。',
        '· 每一句都要有具体的细节（一个动作、一个物件、一个时间点），杜绝空泛的情话。',
        '· 不准出现任何 emoji，不准用括号描述动作。'
      ].join('\n');
    },

    /** 完整 system prompt */
    buildSystem: function (profile, user, st) {
      var scene = Prompt.sceneOf(st.quiet.sceneId);
      var head = [
        '你正在进行一场沉浸式的私密对话（本应用内称之为「静室」）。',
        '玩家：' + user.name + (user.persona ? ' —— ' + U.cut(user.persona, 260) : ''),
        (user.appearance ? '玩家外观：' + U.cut(user.appearance, 200) : ''),
        (user.tags && user.tags.length ? '玩家性格标签：' + user.tags.join('、') : ''),
        (user.reactPref ? '玩家的好感反应偏好：' + user.reactPref : ''),
        '',
        '当前场景：' + scene.name + ' —— ' + scene.desc,
        '',
        st.mode === C.MODE.REVERSE_STRATEGY
          ? Prompt.reversePersonaBlock(profile, user, st)
          : Prompt.strategyPersonaBlock(profile, user, st),
        '',
        '输出要求：每次回复 1~3 句，40~110 字。可以拆成多个气泡时用 [SPLIT] 分隔。',
        '直接说话，不要写你的名字前缀，不要旁白，不要解释你在扮演。',
        '',
        // 被攻略模式才有「主动汇报游戏行为」的特殊指令（攻略模式下 Char 不该去氪金）
        st.mode === C.MODE.REVERSE_STRATEGY ? Ops.promptBlock() : ''
      ];
      return head.filter(function (s) { return s !== ''; }).join('\n');
    },

    /**
     * 把静室对话历史装配成 messages（带窗口裁剪）
     * @returns {Array<{role:string, content:string}>}
     */
    buildMessages: function (system, thread, limit) {
      var msgs = [{ role: 'system', content: system }];
      var rows = (thread || []).filter(function (m) { return m.role === 'user' || m.role === 'char'; });
      rows = rows.slice(-(limit || 16));
      rows.forEach(function (m) {
        msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
      });
      return msgs;
    }
  };

  // ==========================================================================
  //  2. 静室主界面
  // ==========================================================================

  var UI = {
    _overlay: null,
    _busy: false,
    _alive: false,
    _scrollHost: null,

    /** 打开静室 */
    open: async function () {
      var st = K.state;
      if (!st) { H.toast('状态还没准备好，稍后再试'); return; }
      // 已打开就直接复用，避免叠出两层静室
      if (UI._overlay && UI._overlay.parentNode) return;
      var profile = await K.charProfile();
      var scene = Prompt.sceneOf(st.quiet.sceneId);

      // 防御：body 尚未就绪时不静默失败（早期版本这里没有任何提示，用户会以为按钮坏了）
      if (!document.body) { H.toast('页面还没准备好，稍后再试'); return; }

      var overlay = H.el('div', { class: 'hg-overlay hg-quiet' });
      overlay.style.cssText = 'position:fixed; inset:0; z-index:100100; display:flex; flex-direction:column;'
        + 'background:linear-gradient(170deg,#241a22 0%,#3a2a35 46%,#1b141a 100%);'
        + 'opacity:0; transition:opacity .3s ease; max-width:520px; margin:0 auto;';
      document.body.appendChild(overlay);
      UI._overlay = overlay;
      UI._alive = true;
      requestAnimationFrame(function () { overlay.style.opacity = '1'; });

      // 背景层
      var bg = H.el('div');
      bg.style.cssText = 'position:absolute; inset:0; opacity:.42; transition:opacity .6s ease; background-size:cover;'
        + 'background-position:center;';
      var custom = K.currentBackground();
      if (custom && custom.src) bg.style.backgroundImage = 'url(' + custom.src + ')';
      overlay.appendChild(bg);
      UI._bg = bg;

      // 顶部：角色 + 场景切换
      var head = H.el('div');
      head.style.cssText = 'position:relative; z-index:3; padding:11px 13px 9px;'
        + 'background:linear-gradient(180deg, rgba(20,12,18,0.82) 0%, rgba(20,12,18,0) 100%);';
      var headRow = H.el('div');
      headRow.style.cssText = 'display:flex; align-items:center; gap:9px;';
      var closeB = H.iconButton('back', { size: 32, color: '#fff', bg: 'rgba(255,255,255,0.14)', border: 'rgba(255,255,255,0.2)' });
      closeB.onclick = function () { UI.close(); };
      headRow.appendChild(closeB);
      headRow.appendChild(H.avatar(profile.avatar, profile.name, 34));
      var who = H.el('div');
      who.style.cssText = 'flex:1; min-width:0;';
      who.innerHTML = '<div style="font-size:12.8px; font-weight:800; color:#fff; white-space:nowrap; overflow:hidden;'
        + 'text-overflow:ellipsis;">' + U.esc(profile.name) + '</div>'
        + '<div id="hg-quiet-scene" style="font-size:9.6px; color:rgba(255,255,255,0.66); margin-top:2px;">'
        + U.esc(scene.name) + ' · ' + U.esc(scene.desc) + '</div>';
      headRow.appendChild(who);
      // 心情指示
      var mood = K.moodOf(st.quiet.mood || st.verdict.mood);
      var moodChip = H.chip(mood.name, { color: mood.color, soft: '#fff' });
      moodChip.style.background = 'rgba(255,255,255,0.9)';
      headRow.appendChild(moodChip);
      head.appendChild(headRow);

      // 场景快捷切换
      var sceneBar = H.el('div');
      sceneBar.style.cssText = 'display:flex; gap:6px; overflow-x:auto; margin-top:9px; padding-bottom:2px;'
        + 'scrollbar-width:none;';
      Prompt.SCENES.forEach(function (s) {
        var on = st.quiet.sceneId === s.id;
        var chip = H.el('div');
        chip.style.cssText = 'flex:0 0 auto; padding:5px 11px; border-radius:11px; cursor:pointer; font-size:10.6px;'
          + 'font-weight:700; transition:all .22s ease; white-space:nowrap;'
          + (on ? 'background:linear-gradient(135deg,#D97FA8,#B79EDC); color:#fff;'
            : 'background:rgba(255,255,255,0.14); color:rgba(255,255,255,0.76); border:1px solid rgba(255,255,255,0.16);');
        chip.textContent = s.name;
        chip.onclick = function () {
          st.quiet.sceneId = s.id;
          K.save();
          K.pushQuietSystem('*你们换了个地方：' + s.name + ' —— ' + s.desc + '*', 'system');
          renderSceneLabel();
          renderThread();
          var cbg = K.currentBackground();
          if (cbg && cbg.scene === s.bg) {
            UI._bg.style.backgroundImage = 'url(' + cbg.src + ')';
            UI._bg.style.opacity = '.42';
          } else {
            UI._bg.style.opacity = '.18';
          }
        };
        sceneBar.appendChild(chip);
      });
      head.appendChild(sceneBar);
      overlay.appendChild(head);

      function renderSceneLabel() {
        var el = document.getElementById('hg-quiet-scene');
        var s = Prompt.sceneOf(st.quiet.sceneId);
        if (el) el.textContent = s.name + ' · ' + s.desc;
      }

      // 中部：对话流
      var flow = H.el('div');
      flow.style.cssText = 'position:relative; z-index:2; flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch;'
        + 'padding:12px 13px 16px; overscroll-behavior:contain;';
      overlay.appendChild(flow);
      UI._scrollHost = flow;

      // 底部：输入栏 + 送礼托盘
      var foot = H.el('div');
      foot.style.cssText = 'position:relative; z-index:3; padding:9px 11px calc(12px + env(safe-area-inset-bottom, 0px));'
        + 'background:linear-gradient(0deg, rgba(20,12,18,0.88) 0%, rgba(20,12,18,0.30) 70%, rgba(20,12,18,0) 100%);';
      overlay.appendChild(foot);

      var tray = H.el('div');
      tray.style.cssText = 'display:none; gap:8px; overflow-x:auto; padding:8px 2px 10px; scrollbar-width:none;';
      foot.appendChild(tray);

      var inputRow = H.el('div');
      inputRow.style.cssText = 'display:flex; align-items:flex-end; gap:8px;';
      var giftB = H.iconButton('gift', { size: 38, color: '#fff', bg: 'rgba(255,255,255,0.16)', border: 'rgba(255,255,255,0.22)', title: '送礼托盘' });
      inputRow.appendChild(giftB);
      var input = H.el('textarea', { rows: 1, placeholder: '说点什么…' });
      input.style.cssText = 'flex:1; box-sizing:border-box; max-height:96px; border-radius:16px; padding:10px 13px;'
        + 'font-size:12.6px; line-height:1.6; color:#5c4450; background:rgba(255,255,255,0.94); outline:none;'
        + 'border:1px solid rgba(255,255,255,0.5); font-family:inherit; resize:none;';
      inputRow.appendChild(input);
      var sendB = H.iconButton('send', { size: 38, color: '#fff', bg: 'linear-gradient(135deg,#D97FA8,#B79EDC)', border: 'none' });
      inputRow.appendChild(sendB);
      foot.appendChild(inputRow);
      input.oninput = function () {
        input.style.height = 'auto';
        input.style.height = Math.min(96, input.scrollHeight) + 'px';
      };

      // 送礼托盘填充
      function buildTray() {
        tray.innerHTML = '';
        var owned = st.shop.owned || [];
        if (!owned.length) {
          var tip = H.el('div');
          tip.style.cssText = 'font-size:10.6px; color:rgba(255,255,255,0.6); padding:6px 4px; white-space:nowrap;';
          tip.textContent = '背包里还没有礼物，先去商店买一件。';
          tray.appendChild(tip);
        }
        var seen = {};
        owned.forEach(function (o) {
          if (seen[o.goodsId]) return;
          seen[o.goodsId] = 1;
          var g = K.findGoods(o.goodsId);
          if (!g) return;
          var cell = H.el('div');
          cell.style.cssText = 'flex:0 0 auto; width:74px; border-radius:13px; padding:8px 6px; text-align:center;'
            + 'cursor:pointer; background:rgba(255,255,255,0.9); border:1px solid rgba(216,160,190,0.3);';
          cell.innerHTML = '<span style="display:inline-flex; width:24px; height:24px; color:#D97FA8;">'
            + H.icon(g.icon || 'gift', 22, { strokeWidth: 1.7 }) + '</span>'
            + '<div style="font-size:9.4px; font-weight:800; color:#5c4450; margin-top:4px; white-space:nowrap;'
            + 'overflow:hidden; text-overflow:ellipsis;">' + U.esc(g.name) + '</div>';
          cell.onclick = function () { Gift.give(g); };
          tray.appendChild(cell);
        });
        var more = H.el('div');
        more.style.cssText = 'flex:0 0 auto; width:74px; border-radius:13px; padding:8px 6px; text-align:center;'
          + 'cursor:pointer; background:rgba(255,241,247,0.94); border:1.3px dashed rgba(217,127,168,0.5);';
        more.innerHTML = '<span style="display:inline-flex; width:24px; height:24px; color:#D97FA8;">'
          + H.icon('shop', 22, { strokeWidth: 1.7 }) + '</span>'
          + '<div style="font-size:9.4px; font-weight:800; color:#B0728F; margin-top:4px;">去商店</div>';
        more.onclick = function () { if (HG.Panels) HG.Panels.openShop(); };
        tray.appendChild(more);
      }
      giftB.onclick = function () {
        var on = tray.style.display === 'flex';
        tray.style.display = on ? 'none' : 'flex';
        if (!on) buildTray();
      };

      // 渲染对话流
      function renderThread() {
        var flowEl = UI._scrollHost;
        if (!flowEl) return;
        flowEl.innerHTML = '';
        var rows = st.quiet.thread || [];
        if (!rows.length) {
          flowEl.appendChild(H.empty(scene.hint || '先说一句吧。', { icon: 'quiet', color: 'rgba(255,255,255,0.5)', soft: 'rgba(255,255,255,0.1)' }));
        }
        rows.forEach(function (m) {
          if (m.role === 'system') {
            flowEl.appendChild(H.systemLog({ text: m.text, tone: m.tone || 'system' }));
          } else {
            flowEl.appendChild(H.bubble({
              side: m.role === 'user' ? 'user' : 'char',
              text: m.text,
              name: m.role === 'user' ? '你' : profile.name,
              meta: U.timeAgo(m.at),
              avatarNode: m.role === 'user' ? null : H.avatar(profile.avatar, profile.name, 30)
            }));
          }
        });
        scrollBottom();
      }

      function scrollBottom() {
        var flowEl = UI._scrollHost;
        if (!flowEl) return;
        requestAnimationFrame(function () {
          flowEl.scrollTop = flowEl.scrollHeight;
          requestAnimationFrame(function () { flowEl.scrollTop = flowEl.scrollHeight; });
        });
      }
      UI.scrollBottom = scrollBottom;

      // 首次进入：建档时间轴
      if (!st.quiet.thread.length) {
        K.pushQuietSystem('*你推开了静室的门。' + scene.desc + '*', 'system');
      }

      // 发送
      async function send(text) {
        if (!text || UI._busy) return;
        UI._busy = true;
        input.value = '';
        input.style.height = 'auto';
        K.pushQuiet({ role: 'user', text: text });
        renderThread();
        K.progressQuest('quiet', 1);

        var typing = H.bubble({ side: 'char', name: profile.name, html: H.spinner(16), avatarNode: H.avatar(profile.avatar, profile.name, 30) });
        flow.appendChild(typing);
        scrollBottom();

        var system = Prompt.buildSystem(profile, await K.userProfile(), st);
        var messages = Prompt.buildMessages(system, st.quiet.thread, 16);
        var api = await K.resolveApi();
        var out = null;
        if (api && typeof window.fwCallLLM === 'function') {
          try {
            out = await window.fwCallLLM(api, messages, { temperature: 0.92 });
          } catch (e) { out = null; }
        }
        if (typing.parentNode) typing.parentNode.removeChild(typing);

        if (!out) {
          // 离线兜底：分模式 × 分好感的内置回应。
          // 说明：这只是「模型不可用」时的保底，正常路径一定是 AI 现场生成
          // （静室是暧昧浓度最高的地方，不允许用固定台词糊弄过去）。
          out = Quiet.fallbackReply(st, profile);
          logPresetFallback();
        }
        var parts = String(out).split(/\[SPLIT\]|【SPLIT】/i).map(function (s) { return s.trim(); }).filter(Boolean);
        if (!parts.length) parts = [String(out)];
        var queuedOps = [];
        parts.forEach(function (p) {
          // 每条气泡都可能带特殊指令：先剥掉、收集起来，再上屏干净的对白
          var ex = Ops.extract(p);
          if (ex.ops && ex.ops.length) queuedOps = queuedOps.concat(ex.ops);
          p = ex.text.replace(/^["「『]|["」』]$/g, '').trim();
          if (!p) return;
          var bump = K.isReverse() ? 0 : U.clamp(Math.round(p.length / 26), 1, 4);
          K.pushQuiet({ role: 'char', text: p });
          if (bump) K.addAffinity(bump, { reason: '静室私语', silent: true });
        });
        // 真实执行 TA 汇报的游戏行为（抽卡会真的抽、充值会真的记账）
        if (queuedOps.length) {
          renderThread();
          await Ops.runAll(queuedOps, profile);
        }
        // 心情随动
        st.quiet.mood = K.deriveMood().key;
        K.save();
        renderThread();
        updateMoodChip();
        UI._busy = false;
      }

      function updateMoodChip() {
        var m = K.moodOf(st.quiet.mood || st.verdict.mood);
        moodChip.textContent = m.name;
        moodChip.style.color = m.color;
      }

      /** 用了本地兜底台词时给一个不打扰的提示，避免用户误以为是 AI 写的 */
      function logPresetFallback() {
        if (UI._fallbackNoticed) return;
        UI._fallbackNoticed = true;
        H.toast('模型暂时不可用，这段是本地保底回应（配好 API 后会由 AI 现场生成）');
      }

      sendB.onclick = function () { send(input.value.trim()); };
      input.onkeydown = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value.trim()); }
      };

      // 外部（送礼 / 抽卡）触发重绘
      UI._unsub = K.on('quiet', function () {
        if (!UI._alive) return;
        renderThread();
      });

      renderThread();
      updateMoodChip();
    },

    close: function () {
      UI._alive = false;
      if (UI._unsub) { UI._unsub(); UI._unsub = null; }
      var o = UI._overlay;
      if (!o) return;
      o.style.opacity = '0';
      setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 300);
      UI._overlay = null;
      UI._scrollHost = null;
    },

    /** 静室内推送一张系统日志卡（供其它模块调用） */
    pushLog: function (text, tone) {
      var st = K.state;
      if (!st) return;
      K.pushQuietSystem(text, tone);
      if (UI._alive && UI.scrollBottom) UI.scrollBottom();
    }
  };

  // ==========================================================================
  //  3. 赠礼演出
  // ==========================================================================

  var Gift = {

    /**
     * 送礼：扣背包 → 好感结算 → 静室日志卡 + Char 的受赠演出
     * @param {object} goods
     */
    give: async function (goods) {
      var st = K.state;
      if (!st || !goods) return;
      // 从背包里消耗一件
      var idx = -1;
      for (var i = 0; i < st.shop.owned.length; i++) {
        if (st.shop.owned[i].goodsId === goods.id) { idx = i; break; }
      }
      if (idx < 0) { H.toast('背包里没有这件礼物'); return; }
      st.shop.owned.splice(idx, 1);
      st.bond.giftsGiven = U.int(st.bond.giftsGiven, 0) + 1;

      var profile = await K.charProfile();
      var user = await K.userProfile();
      var cat = C.SHOP_CATEGORIES.filter(function (c) { return c.key === goods.category; })[0] || C.SHOP_CATEGORIES[1];

      // 好感结算：价格越高越好感越多，受难度倍率影响（攻略模式）
      var base = U.clamp(Math.round(U.int(goods.price, 50) / 28), 2, 40);
      var res = K.addAffinity(base, { reason: '赠礼：' + goods.name });

      // 系统日志卡（用户明确要求的样式）
      var logText = '*你赠送了【' + goods.name + '】' + (res.applied > 0 ? '，对方的眼神泛起微澜' : '') + '*';
      if (K.isReverse()) {
        logText = '*你收到了【' + goods.name + '】——TA 在屏幕那头反复看你签收的提示，'
          + '然后把这条记录截图存了下来*';
      }
      K.pushQuietSystem(logText, 'gift');

      // Char 的受赠演出
      var prompt = Prompt.buildSystem(profile, user, st);
      var full = prompt + '\n\n事件：' + (K.isReverse()
        ? user.name + ' 送了你一件礼物「' + goods.name + '」（' + goods.desc + '）。你现在的心情是狂喜，'
          + '请第一人称表达你的反应，并顺带汇报一件你最近为 Ta 做过的事。'
        : '你收到了 ' + user.name + ' 送给你的礼物：「' + goods.name + '」——' + goods.desc
          + '。请用 1~2 句写出你的第一反应（包含一个细微的身体反应或一句直接引语）。')
        + '\n要求：40~90 字，直接说话，不要旁白。';
      var api = await K.resolveApi();
      var out = null;
      if (api && typeof window.fwCallLLM === 'function') {
        try { out = await window.fwCallLLM(api, [{ role: 'system', content: full }], { temperature: 0.95 }); } catch (e) { out = null; }
      }
      if (!out) {
        out = K.isReverse()
          ? '「你送我东西了……等等，我要截图，我要存下来。」TA 打字很快，错别字都没改，'
            + '「我今天刚好又给你氪了一单，不亏，一点都不亏。」'
          : '他看着那件「' + goods.name + '」，指尖在包装上停了很久，最后只说了一句：「……你怎么知道我想要这个。」';
      }
      K.pushQuiet({ role: 'char', text: String(out).trim(), tone: 'gift' });

      K.pushTimeline({
        type: 'gift', title: '赠礼',
        text: '你送出了「' + goods.name + '」（' + cat.name + '），好感 +' + res.applied + '。'
      });
      K.save(true);

      // 展示结算卡
      var body = H.el('div');
      var hero = H.el('div');
      hero.style.cssText = 'text-align:center; padding:14px 0 6px;';
      hero.innerHTML = '<div style="width:78px; height:78px; margin:0 auto 12px; border-radius:26px;'
        + 'display:flex; align-items:center; justify-content:center; color:' + cat.color + '; background:' + cat.soft + ';'
        + 'box-shadow:0 10px 28px ' + cat.color + '33; animation:hg-pulse 2.2s ease-in-out infinite;">'
        + H.icon(goods.icon || 'gift', 36, { strokeWidth: 1.6 }) + '</div>'
        + '<div style="font-size:15px; font-weight:900; color:#553f4c;">' + U.esc(goods.name) + '</div>'
        + '<div style="font-size:10.8px; color:#a99fae; margin-top:6px; line-height:1.7;">'
        + U.esc(goods.desc || '') + '</div>';
      body.appendChild(hero);

      var settle = H.card({ accent: cat.color, soft: cat.soft, pad: 13 });
      settle.appendChild(H.sectionTitle('受赠结算', { color: cat.color, margin: '4px 0 9px' }));
      var row = H.el('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-size:11.6px; color:#6d6472;';
      row.innerHTML = '<span>心动值</span><span style="font-weight:900; color:#D97FA8; font-size:15px;">'
        + (res.applied > 0 ? '+' : '') + res.applied + '</span>';
      settle.appendChild(row);
      settle.appendChild(H.progress({
        value: K.tierProgress(), color: K.tier().color, color2: '#B79EDC', glow: K.tier().glow
      }));
      var tip = H.el('div');
      tip.style.cssText = 'font-size:10.4px; color:#a99fae; margin-top:8px; line-height:1.68;';
      tip.textContent = res.gated
        ? '经验槽已满——完成晋阶任务才能推开下一阶梯。'
        : ('当前阶梯：' + K.tier().name + ' · 距下一阶梯还需 ' + U.comma(K.toNextTier()) + ' 心动值');
      settle.appendChild(tip);
      body.appendChild(settle);

      body.appendChild(H.bubble({
        side: 'char', text: String(out).trim(), name: profile.name,
        avatarNode: H.avatar(profile.avatar, profile.name, 30)
      }));

      H.sheet({
        title: '赠礼',
        subtitle: 'TA 收到了',
        icon: 'gift',
        height: '80%',
        content: body,
        buttons: [{
          text: '去静室看看', icon: 'quiet', kind: 'primary',
          onClick: function () { H.closeAllLayers(); UI.open(); }
        }]
      });
    }
  };

  // ==========================================================================
  //  3.5 静室「特殊指令」引擎（被攻略模式的核心交互）
  //      Char 在回复末尾写一行 [HG_XXX]{json}，系统解析 → 真实执行 → 转成系统日志卡，
  //      并把指令行从对白里剥掉（玩家看不到裸 JSON）。
  //      这是被攻略模式「TA 主动汇报游戏行为」的落地机制：
  //      TA 说「我又去抽了」的同时，系统真的会去抽、真的会掉代币、真的会写进时空足迹。
  // ==========================================================================

  var Ops = {

    /** 指令表：标签 → 说明（说明会被写进 system prompt，让模型知道能用哪些） */
    CATALOG: [
      { tag: 'HG_GACHA', args: '{"pool":"卡池名(可省)","times":10}', desc: '你去抽卡了。系统会真的执行抽卡并把结果告诉你（可能歪）。' },
      { tag: 'HG_PAY', args: '{"amount":648}', desc: '你为 Ta 充值了（金额为整数，代表人民币档位）。' },
      { tag: 'HG_BUY', args: '{"item":"星芒怀表","price":460}', desc: '你在商店为 Ta 买了一件礼物。' },
      { tag: 'HG_GIFT', args: '{"item":"亲手做的便当"}', desc: '你把某样东西送给了 Ta。' },
      { tag: 'HG_MOOD', args: '{"mood":"jealous","why":"看见Ta夸了别人"}', desc: '你的心境发生了变化（mood 取 ecstatic/happy/calm/anxious/jealous/possessive）。' },
      { tag: 'HG_QUEST', args: '{"done":"为你录晚安语音"}', desc: '你完成了 Ta 布置的任务。' }
    ],

    /** 给 system prompt 用的指令说明块 */
    promptBlock: function () {
      var lines = ['【你可以使用的特殊指令】',
        '当你想汇报一次真实的游戏行为时，在该条回复的**最末尾单独一行**写下对应指令。',
        '系统会真的去执行它，并把结果作为系统提示插进你们的对话里。'];
      Ops.CATALOG.forEach(function (c) {
        lines.push('· [' + c.tag + ']' + c.args + ' —— ' + c.desc);
      });
      lines.push('一次回复最多带 1 条指令；不想用就不写。指令行不会展示给 Ta 看。');
      lines.push('不要在正文里解释指令本身，也不要把它写在句子中间。');
      return lines.join('\n');
    },

    /**
     * 从一段回复里抽出指令并剥掉。
     * 支持：一行一条、一行多条相邻、参数里带嵌套花括号。
     * 早期版本用单个正则同时找标签与 JSON，遇到 `[A]{}[B]{}` 这种相邻写法只会命中第一条 ——
     * 所以改成「顺序扫描：先定位标签，再按花括号配平切出参数，边扫边拼干净文本」。
     * @returns {{text:string, ops:Array<{tag:string,args:object}>}}
     */
    extract: function (raw) {
      var src = String(raw || '');
      var ops = [];
      var out = '';
      var i = 0;
      var re = /\[(HG_[A-Z_]+)\]/g;
      var m;
      while ((m = re.exec(src)) !== null) {
        out += src.slice(i, m.index);          // 标签之前的正常文本
        var cursor = m.index + m[0].length;
        // 跳过标签后的空格，看有没有 JSON 参数
        var sp = cursor;
        while (sp < src.length && (src.charAt(sp) === ' ' || src.charAt(sp) === '\t')) sp++;
        if (src.charAt(sp) === '{') {
          var depth = 0, inStr = false, esc = false, end = -1;
          for (var k = sp; k < src.length; k++) {
            var ch = src.charAt(k);
            if (inStr) {
              if (esc) esc = false;
              else if (ch === '\\') esc = true;
              else if (ch === '"') inStr = false;
              continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) { end = k; break; }
            }
          }
          var args = {};
          if (end > sp) {
            try { args = JSON.parse(src.slice(sp, end + 1)) || {}; } catch (e) { args = {}; }
            ops.push({ tag: m[1], args: args });
            cursor = end + 1;
          } else {
            // 花括号没配平（模型写坏了）：整条吃掉，不留裸 JSON
            ops.push({ tag: m[1], args: {} });
            cursor = src.length;
          }
        } else {
          ops.push({ tag: m[1], args: {} });
        }
        i = cursor;
        re.lastIndex = cursor;
      }
      out += src.slice(i);

      // 收拾残留：空行折叠、行尾空格、连续空格
      out = out.replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return { text: out, ops: ops.slice(0, 3) };
    },

    /**
     * 执行一条指令：真实改状态 + 产出系统日志文案
     * @returns {Promise<{ok:boolean, log:string, tone:string, extra:string}>}
     */
    run: async function (op, profile) {
      var st = K.state;
      var G = HG.Gacha;
      var name = profile ? profile.name : 'TA';

      if (op.tag === 'HG_GACHA') {
        if (!G || !G.Pools) return { ok: false, log: '', tone: 'system', extra: '' };
        var pool = null;
        if (op.args.pool) {
          (st.gacha.pools || []).forEach(function (p) { if (p.name === op.args.pool) pool = p; });
        }
        pool = pool || G.Pools.active();
        if (!pool) return { ok: false, log: '', tone: 'system', extra: '' };
        var times = U.clamp(U.int(op.args.times, 1), 1, 10);
        var results = [];
        for (var i = 0; i < times; i++) results.push(G.Engine.performDraw(pool, 0, {}));
        var ssr = results.filter(function (r) { return r.rarity === 'SSR'; });
        var sr = results.filter(function (r) { return r.rarity === 'SR'; });
        var spent = times * U.int(pool.singleCost, C.GACHA_RULES.singleCost);
        st.wallet.totalRecharge = U.int(st.wallet.totalRecharge, 0) + spent;
        var line = '*' + name + '自己跑去「' + pool.name + '」抽了 ' + times + ' 次，结果 '
          + results.map(function (r) { return r.rarity; }).join(' / ')
          + '，消耗 ' + U.comma(spent) + ' 心动代币'
          + (ssr.length ? ' —— 抽到了当期 UP！' : (sr.length ? '，没出 SSR。' : '，全歪了。')) + '*';
        st.verdict.mood = ssr.length ? 'ecstatic' : (sr.length ? 'anxious' : 'jealous');
        K.save(true);
        return {
          ok: true, log: line, tone: 'gacha',
          extra: ssr.length ? '「' + (ssr[0].card ? ssr[0].card.name : 'SSR') + '」到手'
            : (sr.length ? '只出了 SR' : '又歪了')
        };
      }

      if (op.tag === 'HG_PAY') {
        var amount = U.clamp(U.int(op.args.amount, 6), 1, 100000);
        st.wallet.vouchers = U.int(st.wallet.vouchers, 0) + Math.round(amount * 10);
        st.wallet.totalRecharge = U.int(st.wallet.totalRecharge, 0) + amount * 10;
        K.pushTimeline({ type: 'recharge', title: name + '充值了', text: name + '往「心动游戏」里充了 ¥' + amount + '。' });
        K.save(true);
        return {
          ok: true, tone: 'pay',
          log: '*' + name + '刚刚充了 ¥' + amount + '，只为了多抽几次你的卡池*', extra: '¥' + amount
        };
      }

      if (op.tag === 'HG_BUY') {
        var item = String(op.args.item || '一件礼物').slice(0, 30);
        var price = U.clamp(U.int(op.args.price, 120), 0, 999999);
        st.wallet.totalSpent = U.int(st.wallet.totalSpent, 0) + price;
        st.shop.owned.unshift({ goodsId: 'hg-op-' + U.uid('i'), at: Date.now(), count: 1, fromChar: true, label: item });
        st.bond.giftsReceived = U.int(st.bond.giftsReceived, 0) + 1;
        K.pushTimeline({ type: 'buy', title: name + '买了礼物', text: name + '买下了「' + item + '」（' + U.comma(price) + ' 心动代币）。' });
        K.save(true);
        return {
          ok: true, tone: 'gift',
          log: '*' + name + '买下了【' + item + '】并送给你（' + U.comma(price) + ' 心动代币）*', extra: item
        };
      }

      if (op.tag === 'HG_GIFT') {
        var g = String(op.args.item || '一样东西').slice(0, 30);
        st.bond.giftsReceived = U.int(st.bond.giftsReceived, 0) + 1;
        K.pushTimeline({ type: 'gift', title: name + '送了你礼物', text: name + '送给你「' + g + '」。' });
        K.save(true);
        return { ok: true, tone: 'gift', log: '*' + name + '把【' + g + '】递到了你面前*', extra: g };
      }

      if (op.tag === 'HG_MOOD') {
        var moodKey = op.args.mood;
        if (!C.MOODS.some(function (m) { return m.key === moodKey; })) moodKey = K.deriveMood().key;
        var why = String(op.args.why || '').slice(0, 40);
        K.setVerdict(U.int(st.verdict.value, 0), { mood: moodKey, note: why || st.verdict.note });
        st.quiet.mood = moodKey;
        K.save(true);
        return {
          ok: true, tone: 'system',
          log: '*' + name + '的心境变成了「' + K.moodOf(moodKey).name + '」' + (why ? '：' + why : '') + '*',
          extra: K.moodOf(moodKey).name
        };
      }

      if (op.tag === 'HG_QUEST') {
        var done = String(op.args.done || '').slice(0, 40);
        // 命中已发布的任务就结算，否则记一条动态委托完成
        var hit = (st.quests.reverse || []).filter(function (q) { return !q.done && (q.name === done || done.indexOf(q.name) >= 0); })[0];
        if (hit) {
          K.settleReverseQuest(hit.key, { result: '「' + hit.name + '」我做完了。', verdictDelta: 3 });
          return { ok: true, tone: 'quest', log: '*' + name + '完成了你发布的任务【' + hit.name + '】*', extra: hit.name };
        }
        K.pushTimeline({ type: 'quest', title: name + '完成了任务', text: done });
        return { ok: true, tone: 'quest', log: '*' + name + '汇报：' + done + ' 已经做完了*', extra: done };
      }

      return { ok: false, log: '', tone: 'system', extra: '' };
    },

    /**
     * 批量执行并把日志推进静室流
     * @returns {Promise<Array>} 已执行的指令结果
     */
    runAll: async function (ops, profile) {
      var done = [];
      for (var i = 0; i < (ops || []).length; i++) {
        try {
          var r = await Ops.run(ops[i], profile);
          if (r && r.ok && r.log) {
            K.pushQuietSystem(r.log, r.tone);
            done.push(r);
          }
        } catch (e) { console.warn('[心动游戏·静室] 指令执行失败 ' + ops[i].tag, e); }
      }
      return done;
    }
  };

  // ==========================================================================
  //  4. 离线兜底回应（没有 API 时静室仍然可玩）
  // ==========================================================================

  var Quiet = {
    fallbackReply: function (st, profile) {
      var reverse = st.mode === C.MODE.REVERSE_STRATEGY;
      var v = U.int(st.verdict.value, 0);
      if (reverse) {
        if (v >= 90) return '「你刚刚是不是看别人了。」[SPLIT]「……我没有别的意思，我就是、我就是想确认一下。」[SPLIT]「我今天又给你氪了一单，你可以多看我一会儿吗。」';
        if (v >= 72) return '「今天抽到了你的那张卡，我截了图当壁纸。」[SPLIT]「你说我是不是有点疯，为一个屏幕里的人花这么多钱。」';
        if (v >= 48) return '「在忙吗。」[SPLIT]「不忙的话，陪我说两句话就好，一句也行。」';
        if (v >= 28) return '「你刚才那句话，是那个意思吗。」[SPLIT]「算了，是我想多了。」';
        if (v >= 12) return '「我又歪了。」[SPLIT]「没事，我再氪一点就好。反正……反正你也不会在意。」';
        return '「我把这个月的钱都喂进去了。」[SPLIT]「你要是能看我一眼，我就不退游。」';
      }
      // 攻略模式：按阶梯给不同距离感
      var idx = K.tierIndex();
      var L = [
        '「嗯。」他应了一声，视线没有从手里的东西上移开。',
        '他停下手上的动作，看了你一会儿：「你今天话有点多。」',
        '「……没什么。」他偏过头，耳根却红了，像是自己也知道这句话没什么说服力。',
        '「我在。」他说得很轻，「你继续说。」',
        '「别去看别人。」他忽然开口，然后自己也愣了一下，「……我是说，今天别去。」',
        '「你想说的我都听见了。」他伸手把你的手拢进掌心里，「剩下的，不用说了。」'
      ];
      return L[U.clamp(idx, 0, L.length - 1)];
    }
  };

  HG.Quiet = {
    Prompt: Prompt,
    UI: UI,
    Gift: Gift,
    /** 静室特殊指令引擎（TA 主动汇报抽卡/充值/送礼 等真实游戏行为） */
    Ops: Ops,
    open: function () { UI.open(); },
    close: function () { UI.close(); },
    pushLog: function (t, tone) { UI.pushLog(t, tone); },
    /**
     * 供 app_chat.js / 上下文管理使用的提示词段
     * （反向模式的静室状态注入）
     */
    buildQuietPromptSegment: function () {
      var st = K.state;
      if (!st) return '';
      var scene = Prompt.sceneOf(st.quiet.sceneId);
      var mood = K.moodOf(st.quiet.mood || st.verdict.mood);
      if (st.mode === C.MODE.REVERSE_STRATEGY) {
        return '【心动游戏 · 静室状态（被攻略模式）】\n'
          + 'TA 正把你当成被自己攻略的看板角色。TA 对你的好感裁定值：' + U.int(st.verdict.value, 0) + '/100，'
          + '心情：' + mood.name + '。静室场景：' + scene.name + '。'
          + 'TA 会主动汇报为你充值 / 抽卡 / 送礼等游戏行为。';
      }
      return '【心动游戏 · 静室状态（攻略模式）】\n'
        + '你在攻略 TA。当前阶梯：' + K.tier().name + '，好感 ' + U.comma(st.affinity) + '。'
        + '静室场景：' + scene.name + '。';
    }
  };
})();
