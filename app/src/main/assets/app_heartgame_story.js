/**
 * app_heartgame_story.js - 心动游戏 · 沉浸式互动剧情引擎 (S)
 * ============================================================================
 * 职责：
 *   1. 视听演播架构：背景图层 + 立绘图层（Live2D 表情/动作实时驱动）
 *      + 乙游定制半透明磨砂叙事窗；角色对白用带微缩印记与个性化色调的气泡边框
 *   2. 剧情中途小手机：剧情进程中可动态呼出手机界面，承载
 *      剧情内短讯（SMS）/ 假朋友圈互动 / 剧情内电话接入
 *   3. 双向剧情驱动：
 *      · 攻略模式 —— 系统/Char 出题，User 选二/三分支，并保留底层自定义行为输入框
 *        （用户键入自由动作，AI 动态推演 Char 反应）
 *      · 反向模式 —— 主线节点停顿时由 User 设定 2~3 个抉择项并附带属性奖惩
 *        （如 [选项A: 顺从 +好感5] [选项B: 拒绝 -好感2]），Char 基于性格模型自主选择
 *   4. 多主线会话管理：并行开启多个篇章 + 存档点（Save/Load）+ 分支树回溯
 *
 * 依赖：window.HeartGame.K / .H / .U / .C（app_heartgame_core.js）
 *      可选：window.HeartGame.Portraits（立绘渲染）
 */
(function () {
  'use strict';

  var HG = window.HeartGame;

  // ==========================================================================
  //  0. 剧本分镜（纯函数，可在 Node 里直接单测）
  //     用户要求：「对话框过于复杂了，我们要透明化，字体缩小一些，并且做好段落切分，
  //                基本一句话一个分镜，角色说话要单独分镜。」
  // ==========================================================================

  var Script = {
    /** 一句话的结束标点（保留标点，切在标点之后） */
    SENT_END: /[。！？!?…；;]+["'」』”’）)]*/g,

    /**
     * 把一段原文切成"分镜"。
     * 规则：
     *   1. 「…」/ “… ” 里的内容 = 角色台词（单独一个分镜，带说话人）
     *   2. 其余 = 旁白
     *   3. 旁白与台词都再按句末标点切，**一句话一个分镜**
     *   4. 太短的碎句（<=2 字）并进上一句；过长的句子（>60 字）按逗号再切一刀
     * @returns {Array<{kind:'narration'|'speech', text:string}>}
     */
    splitSegments: function (text) {
      var raw = String(text == null ? '' : text).replace(/\r/g, '');
      if (!raw.trim()) return [];
      var out = [];

      var pushNarration = function (s) {
        var t = String(s).trim();
        if (!t) return;
        Script._sentences(t).forEach(function (one) {
          var prev = out[out.length - 1];
          if (prev && prev.kind === 'narration' && one.length <= 2) {
            prev.text += one;              // 「……。」这种碎句并进上一句
          } else {
            out.push({ kind: 'narration', text: one });
          }
        });
      };
      var pushSpeech = function (s) {
        var t = String(s).trim();
        if (!t) return;
        Script._sentences(t).forEach(function (one) {
          out.push({ kind: 'speech', text: one });
        });
      };

      // 先按行处理，再在行内挑出台词
      raw.split('\n').forEach(function (line) {
        var src = line.trim();
        if (!src) return;
        // 「…」或 “…” 交替匹配
        var re = /[「“]([^」”]*)[」”]/g;
        var last = 0, m;
        while ((m = re.exec(src)) !== null) {
          if (m.index > last) pushNarration(src.slice(last, m.index));
          pushSpeech(m[1]);
          last = re.lastIndex;
        }
        if (last < src.length) pushNarration(src.slice(last));
      });

      return out.length ? out : [{ kind: 'narration', text: raw.trim() }];
    },

    /** 把一段旁白按句末标点切成若干句（过长再按逗号补一刀） */
    _sentences: function (t) {
      var parts = [];
      var buf = '';
      for (var i = 0; i < t.length; i++) {
        buf += t[i];
        if ('。！？!?…'.indexOf(t[i]) >= 0) {
          // 把连续的标点一起吃进来
          while (i + 1 < t.length && '。！？!?…；;'.indexOf(t[i + 1]) >= 0) { buf += t[++i]; }
          parts.push(buf.trim());
          buf = '';
        }
      }
      if (buf.trim()) parts.push(buf.trim());

      var out = [];
      parts.forEach(function (p) {
        if (p.length <= 60) { out.push(p); return; }
        // 太长：按逗号再切，每段尽量不超过 34 字
        var acc = '';
        p.split('，').forEach(function (chunk, idx, arr) {
          acc += chunk + (idx < arr.length - 1 ? '，' : '');
          if (acc.length >= 34) { out.push(acc.trim()); acc = ''; }
        });
        if (acc.trim()) out.push(acc.trim());
      });
      return out.filter(function (s) { return s.length > 0; });
    },

    /** 这一段是不是"小手机"剧情（需要用户在手机里回应） */
    isPhoneKind: function (kind) {
      return kind === 'sms' || kind === 'call' || kind === 'moment';
    }
  };
  if (!HG) { console.warn('[心动游戏] core 未加载，剧情引擎已跳过'); return; }
  var K = HG.K, H = HG.H, U = HG.U, C = HG.C;

  // ==========================================================================
  //  1. 数据层：篇章 / 节点 / 分支树 / 存档点
  // ==========================================================================

  var Arc = {

    byId: function (id) {
      var list = (K.state && K.state.story.arcs) || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    },

    /** 当前篇章 */
    active: function () {
      return Arc.byId(K.state && K.state.story.activeArcId) || ((K.state.story.arcs || [])[0] || null);
    },

    setActive: function (id) {
      var st = K.state;
      if (!st || !Arc.byId(id)) return false;
      st.story.activeArcId = id;
      K.save();
      return true;
    },

    remove: function (id) {
      var st = K.state;
      if (!st) return false;
      st.story.arcs = st.story.arcs.filter(function (a) { return a.id !== id; });
      if (st.story.activeArcId === id) st.story.activeArcId = st.story.arcs.length ? st.story.arcs[0].id : null;
      K.save();
      return true;
    },

    /** 建一个空篇章（骨架，节点由生成器填充） */
    create: function (cfg) {
      var st = K.state;
      if (!st) return null;
      var arc = {
        id: U.uid('arc'),
        title: cfg.title || '未命名篇章',
        synopsis: cfg.synopsis || '',
        theme: cfg.theme || '',
        sceneId: cfg.sceneId || null,
        nodes: cfg.nodes || [],
        nodeIndex: 0,
        status: 'playing',              // playing | finished
        createdAt: Date.now(),
        updatedAt: Date.now(),
        saves: [],                      // 存档点
        tier: st.tierKey,
        mode: st.mode
      };
      st.story.arcs.unshift(arc);
      if (!st.story.activeArcId) st.story.activeArcId = arc.id;
      K.pushTimeline({
        type: 'story', title: '篇章开启',
        text: '「' + arc.title + '」开始了。'
      });
      K.save(true);
      K.emit('story', { arc: arc });
      return arc;
    },

    /** 当前节点 */
    node: function (arc) {
      var a = arc || Arc.active();
      if (!a || !a.nodes.length) return null;
      return a.nodes[U.clamp(U.int(a.nodeIndex, 0), 0, a.nodes.length - 1)] || null;
    },

    /** 推进到下一节点 */
    advance: function (arc) {
      var a = arc || Arc.active();
      if (!a) return null;
      if (a.nodeIndex >= a.nodes.length - 1) {
        a.status = 'finished';
        K.pushTimeline({ type: 'story', title: '篇章完结', text: '「' + a.title + '」走到了它的结尾。' });
        K.save(true);
        return null;
      }
      a.nodeIndex = U.int(a.nodeIndex, 0) + 1;
      a.updatedAt = Date.now();
      K.save();
      return Arc.node(a);
    },

    /** 记录一次选择（用于分支树回溯） */
    recordChoice: function (arc, node, choice) {
      var st = K.state;
      if (!st || !arc) return null;
      var row = {
        id: U.uid('br'),
        arcId: arc.id,
        arcTitle: arc.title,
        nodeId: node ? node.id : null,
        nodeTitle: node ? (node.title || '') : '',
        choiceId: choice ? choice.id : null,
        choiceText: choice ? choice.text : '',
        verdictDelta: choice ? U.int(choice.verdictDelta, 0) : 0,
        affinityDelta: choice ? U.int(choice.affinityDelta, 0) : 0,
        at: Date.now(),
        index: U.int(arc.nodeIndex, 0)
      };
      st.story.branches.push(row);
      if (st.story.branches.length > 300) st.story.branches = st.story.branches.slice(-300);
      K.save();
      K.emit('branch', row);
      return row;
    },

    /** 存档点：完整快照当前篇章 + 关键数值 */
    save: function (arc, label) {
      var a = arc || Arc.active();
      var st = K.state;
      if (!a || !st) return null;
      var snap = {
        id: U.uid('save'),
        label: label || ('存档 · ' + (a.nodes[U.int(a.nodeIndex, 0)] || {}).title || ('进度 ' + a.nodeIndex)),
        at: Date.now(),
        nodeIndex: U.int(a.nodeIndex, 0),
        arcTitle: a.title,
        tierKey: st.tierKey,
        affinity: st.affinity,
        verdict: U.plain(st.verdict),
        wallet: U.plain(st.wallet),
        nodes: U.plain(a.nodes) || [],
        status: a.status
      };
      a.saves.unshift(snap);
      if (a.saves.length > 12) a.saves.length = 12;
      K.pushTimeline({ type: 'save', title: '存档点', text: '在「' + a.title + '」的第 ' + (snap.nodeIndex + 1) + ' 个节点留下存档。' });
      K.save(true);
      return snap;
    },

    /** 读档：回到存档点 */
    load: function (arc, saveId) {
      var a = arc || Arc.active();
      var st = K.state;
      if (!a || !st) return false;
      var snap = (a.saves || []).filter(function (x) { return x.id === saveId; })[0];
      if (!snap) return false;
      a.nodes = snap.nodes || a.nodes;
      a.nodeIndex = U.int(snap.nodeIndex, 0);
      a.status = snap.status || 'playing';
      st.tierKey = snap.tierKey || st.tierKey;
      st.affinity = U.int(snap.affinity, st.affinity);
      if (snap.verdict) st.verdict = snap.verdict;
      if (snap.wallet) st.wallet = snap.wallet;
      K.pushTimeline({ type: 'load', title: '读档', text: '回到「' + a.title + '」的存档点：' + snap.label });
      K.save(true);
      return true;
    },

    /** 回溯：把某个历史选择重新展开（分支树回溯） */
    rewindTo: function (branchId) {
      var st = K.state;
      if (!st) return false;
      var row = (st.story.branches || []).filter(function (b) { return b.id === branchId; })[0];
      if (!row) return false;
      var a = Arc.byId(row.arcId);
      if (!a) return false;
      a.nodeIndex = U.clamp(U.int(row.index, 0), 0, Math.max(0, a.nodes.length - 1));
      a.status = 'playing';
      st.story.activeArcId = a.id;
      // 分支树中该点之后的记录作废（保留一次提示）
      K.pushTimeline({
        type: 'rewind', title: '分支回溯',
        text: '回到「' + a.title + '」的选择点：' + U.cut(row.choiceText, 30)
      });
      K.save(true);
      return true;
    }
  };

  // ==========================================================================
  //  2. 生成器：AI 出题（攻略模式）/ AI 推演（自由行动）/ AI 裁决（反向模式）
  // ==========================================================================

  var Gen = {

    /** 系统提示：把角色设定、当前阶段、模式讲清楚 */
    baseSystem: async function (extra) {
      var profile = await K.charProfile();
      var user = await K.userProfile();
      var st = K.state;
      var tier = K.tier();
      var reverse = K.isReverse();
      var mood = K.moodOf(st.quiet.mood);
      var lines = [];
      lines.push('你在为一款女性向恋爱手游撰写互动剧情。');
      lines.push('玩家（User）：' + user.name + (user.persona ? ' —— ' + U.cut(user.persona, 240) : ''));
      lines.push('角色（Char）：' + profile.name + ' —— ' + U.cut(profile.persona || '（未填写，按名字气质发挥）', 420));
      lines.push('当前关系阶段：' + tier.name + '（第 ' + (K.tierIndex() + 1) + '/6 阶）');
      if (reverse) {
        lines.push('世界线：被攻略模式。屏幕前的 User 是「游戏角色 / 看板角色」，Char 才是狂热玩家，Char 深爱着 User，'
          + '一切行为都以博取 User 的好感为目的。当前 User 对 Char 的好感裁定值：'
          + U.int(st.verdict.value, 0) + '/100，Char 的心情：' + mood.name + '。');
      } else {
        lines.push('世界线：攻略模式。屏幕前的 User 是玩家，Char 是攻略目标。');
      }
      if (extra) lines.push(extra);
      lines.push('要求：中文，乙游质感，克制而有余味，不写任何 emoji，不用括号旁白腔。');
      return lines.join('\n');
    },

    /** 生成一个新篇章（含 5~8 个节点） */
    generateArc: async function (theme) {
      var profile = await K.charProfile();
      var t = theme || '一场没有预告的重逢';
      var prompt = await Gen.baseSystem(
        '请为下面的主题生成一个可玩的主线篇章，共 6 个节点。\n'
        + '主题：' + t + '\n\n'
        + '严格只返回 JSON，结构如下：\n'
        + '{\n'
        + '  "title": "篇章名（6~10 字）",\n'
        + '  "synopsis": "一句话梗概",\n'
        + '  "nodes": [\n'
        + '    {\n'
        + '      "kind": "narration" | "dialogue" | "sms" | "call" | "moment",\n'
        + '      "title": "节点小标题（4~8 字）",\n'
        + '      "scene": "场景描述，一句话（用于背景与氛围）",\n'
        + '      "bg": "场景关键词，例如 雨天 / 卧室 / 校园 / 黄昏",\n'
        + '      "speaker": "char" | "narration" | "user",\n'
        + '      "text": "正文。dialogue 节点写 "char" 的对白（60~140 字，可含一句直接引语）；narration 写旁白（40~90 字）",\n'
        + '      "emotion": "calm" | "blush" | "surprise" | "away" | "shy",\n'
        + '      "options": [\n'
        + '        { "text": "选项文字（12~24 字）", "affinityDelta": 5, "verdictDelta": 0,\n'
        + '          "result": "选择后 Char 的反应，50~100 字" }\n'
        + '      ]\n'
        + '    }\n'
        + '  ]\n'
        + '}\n\n'
        + '规则：\n'
        + '· 前 2 个节点铺陈氛围（可含 narration / dialogue）。\n'
        + '· 中间节点必须给出 2~3 个 options（"options" 至少 2 个），且不同选项的 affinityDelta 要有差异（可为负）。\n'
        + '· 最后一个节点收束情绪，options 可以为空数组。\n'
        + '· sms / call / moment 三种节点是「剧情中途小手机」内容：\n'
        + '  sms = 一条短讯（text 写成短讯内容，speaker 写 char）；\n'
        + '  call = 一通电话（text 写来电时说的话）；\n'
        + '  moment = 一条朋友圈（text 写发的内容）。\n'
        + '· 整个篇章至少包含 1 个 sms 或 call 节点。'
      );
      var obj = await K.askJSON(prompt, null, { temperature: 0.95, maxTokens: 2400 });
      if (!obj || !Array.isArray(obj.nodes) || !obj.nodes.length) {
        obj = Gen.offlineArc(t, profile.name);
      }
      return Arc.create({
        title: obj.title || t,
        synopsis: obj.synopsis || '',
        theme: t,
        nodes: Gen.normalizeNodes(obj.nodes),
        sceneId: null
      });
    },

    /** 规范化节点结构（AI 输出经常缺字段） */
    normalizeNodes: function (nodes) {
      return (nodes || []).map(function (n, i) {
        var options = (n.options || []).map(function (o, j) {
          return {
            id: o.id || ('opt' + i + '_' + j),
            text: String(o.text || ('选项 ' + (j + 1))),
            affinityDelta: U.int(o.affinityDelta, 0),
            verdictDelta: U.int(o.verdictDelta, 0),
            result: String(o.result || ''),
            consequence: o.consequence || null
          };
        });
        return {
          id: n.id || U.uid('node'),
          kind: ['narration', 'dialogue', 'sms', 'call', 'moment'].indexOf(n.kind) >= 0 ? n.kind : 'dialogue',
          title: String(n.title || ('第 ' + (i + 1) + ' 幕')),
          scene: String(n.scene || ''),
          bg: String(n.bg || ''),
          speaker: n.speaker === 'user' ? 'user' : (n.speaker === 'narration' ? 'narration' : 'char'),
          text: String(n.text || ''),
          emotion: n.emotion || 'calm',
          options: options,
          resolved: null
        };
      });
    },

    /** 离线兜底篇章 */
    offlineArc: function (theme, charName) {
      var nodes = [
        {
          kind: 'narration', title: '雨落下来', speaker: 'narration', bg: '雨天',
          scene: '傍晚的街口，雨来得比预报更早。',
          text: '雨点砸在便利店门口的塑料棚上，声音密得像有人在耳边小声说话。你没带伞，站在屋檐下数着路灯。',
          options: []
        },
        {
          kind: 'dialogue', title: '伞沿', speaker: 'char', bg: '雨天', emotion: 'calm',
          scene: '一把黑伞从侧面撑过来，伞骨微微偏向你这一侧。',
          text: '「你怎么在这儿。」' + charName + '的语气听不出情绪，伞却整个往你那边倾了过去，自己半边肩膀露在雨里。',
          options: [
            { text: '把伞推回去，让他也遮到', affinityDelta: 6, verdictDelta: 2, result: charName + '愣了一下，没接话，只是把伞柄往你手里塞了塞，自己往你身侧又靠近了半步。' },
            { text: '什么都不说，站得离他近一点', affinityDelta: 4, verdictDelta: 1, result: '他察觉到了，肩膀几不可察地放松下来。雨声很大，两个人谁都没开口。' },
            { text: '赌气说不用你管', affinityDelta: -3, verdictDelta: -1, result: '他把伞收回去了半寸，又停住，最后只是低声说：「……随你。」但那把伞始终没有真正收起来。' }
          ]
        },
        {
          kind: 'sms', title: '迟到的短讯', speaker: 'char', bg: '卧室', emotion: 'shy',
          scene: '深夜，你回到家，手机在口袋里震了一下。',
          text: '「到家了没。」\n隔了十几秒，又一条：「伞放你那儿了，明天记得还我。」',
          options: []
        },
        {
          kind: 'dialogue', title: '还不还', speaker: 'char', bg: '校园', emotion: 'blush',
          scene: '第二天的走廊尽头，他靠在窗边等你。',
          text: '「伞呢。」他伸手，掌心朝上。他明明可以直接拿走，却非要你先递过去——像是想借着这个动作，多确认一次什么。',
          options: [
            { text: '把伞递过去，指尖故意碰一下', affinityDelta: 7, verdictDelta: 2, result: '他手指缩了一下，那把伞差点掉在地上。他低头去捡，耳根红得很明显。' },
            { text: '说伞丢了，看他什么反应', affinityDelta: 2, verdictDelta: 0, result: '他盯了你三秒，然后说：「那我再去买一把，明天还给你。」——他没打算让这件事结束。' }
          ]
        },
        {
          kind: 'call', title: '凌晨的来电', speaker: 'char', bg: '卧室', emotion: 'surprise',
          scene: '凌晨一点多，屏幕亮起来，是他的名字。',
          text: '「……吵醒你了？」他的声音比平时低，「没什么事，就是突然想确认一下，你还在。」',
          options: [
            { text: '说我在，一直都在', affinityDelta: 9, verdictDelta: 3, result: '电话那头安静了很久，久到你以为他挂了。然后他轻轻「嗯」了一声，那声音有点发颤。' },
            { text: '问他是不是睡不着', affinityDelta: 5, verdictDelta: 1, result: '「嗯。」他承认得很干脆，「想你想得睡不着。」说完自己先笑了，笑声里没什么底气。' }
          ]
        },
        {
          kind: 'dialogue', title: '说出那句话', speaker: 'char', bg: '黄昏', emotion: 'calm',
          scene: '天台上，风把云吹得很开，夕阳落在两个人的肩上。',
          text: '他站在你面前，手里还攥着那把伞，像是攥了很久。他说：「我想过很多次要怎么开口——后来发现，都不用。」',
          options: [
            { text: '安静地听他说完', affinityDelta: 12, verdictDelta: 4, result: '「我喜欢你。」他说得很慢，一个字一个字，像是怕你没听清，又怕自己反悔。' },
            { text: '先一步把话说完', affinityDelta: 12, verdictDelta: 5, result: '你开口的瞬间他愣住了，然后笑了出来，肩膀终于松下来：「……被你抢先了。」' }
          ]
        }
      ];
      return { title: theme + ' · 初见篇', synopsis: '一场没有预告的雨，和一把一直偏向你的伞。', nodes: nodes };
    },

    /**
     * 自由行动推演（攻略模式的底层自定义输入框）
     * @param {object} node
     * @param {string} action 用户键入的自由动作
     * @returns {Promise<{text:string, affinityDelta:number, verdictDelta:number}>}
     */
    freeAction: async function (node, action) {
      var prompt = await Gen.baseSystem(
        '现在玩家没有从给定选项里选，而是自己写了一个动作：\n「' + action + '」\n\n'
        + '当前场景：' + (node ? (node.scene || '') : '') + '\n'
        + '当前节点正文：' + (node ? U.cut(node.text, 200) : '') + '\n\n'
        + '请推演这个动作之后发生了什么。严格只返回 JSON：\n'
        + '{"text":"Char 的反应与场面变化，70~140 字，要有具体的身体反应或一句话直接引语",'
        + '"affinityDelta": 一个 -8 到 +12 之间的整数,'
        + '"verdictDelta": 一个 -4 到 +5 之间的整数,'
        + '"emotion":"calm|blush|surprise|away|shy"}'
      );
      var obj = await K.askJSON(prompt, null, { temperature: 0.95 });
      if (!obj || !obj.text) {
        return {
          text: '你做了这个动作。' + '空气安静了一瞬——他没有立刻回应，只是把视线落在你身上，久到你自己都开始不确定。',
          affinityDelta: 3, verdictDelta: 1, emotion: 'calm'
        };
      }
      return {
        text: String(obj.text),
        affinityDelta: U.clamp(U.int(obj.affinityDelta, 3), -8, 12),
        verdictDelta: U.clamp(U.int(obj.verdictDelta, 1), -4, 5),
        emotion: obj.emotion || 'calm'
      };
    },

    /**
     * 反向模式：User 设定抉择与奖惩，Char 基于性格模型自主选择
     * @returns {Promise<{choiceIndex:number, reason:string, text:string}>}
     */
    charDecide: async function (node) {
      var profile = await K.charProfile();
      var st = K.state;
      var opts = (node && node.options) || [];
      var listText = opts.map(function (o, i) {
        return (i + 1) + '. ' + o.text
          + '（好感 ' + (o.affinityDelta >= 0 ? '+' : '') + o.affinityDelta
          + ' / 裁定 ' + (o.verdictDelta >= 0 ? '+' : '') + o.verdictDelta + '）';
      }).join('\n');
      var prompt = await Gen.baseSystem(
        '现在轮到你（' + profile.name + '）做选择。你是玩家，你深爱着屏幕里的『' + (await K.userProfile()).name + '』。\n'
        + '当前 User 对你的好感裁定值：' + U.int(st.verdict.value, 0) + '/100。\n'
        + '当前心情：' + K.moodOf(st.verdict.mood).name + '。\n\n'
        + '局面：' + (node ? U.cut(node.text, 220) : '') + '\n\n'
        + '你面前有这些选项：\n' + listText + '\n\n'
        + '请严格依据你的性格模型与当前心境做出真实选择——不要总选最讨好的那个。'
        + '好感越高你越敢任性，好感越低你越小心翼翼。\n'
        + '严格只返回 JSON：\n'
        + '{"choiceIndex": 1, "reason":"你为什么会这么选，20~40 字，第一人称内心独白",'
        + '"emotion":"calm|blush|surprise|away|shy"}'
      );
      var obj = await K.askJSON(prompt, null, { temperature: 0.9 });
      var idx = obj ? U.clamp(U.int(obj.choiceIndex, 1) - 1, 0, Math.max(0, opts.length - 1)) : Math.floor(Math.random() * Math.max(1, opts.length));
      return {
        choiceIndex: idx,
        reason: (obj && obj.reason) || '……我想这么选。',
        emotion: (obj && obj.emotion) || 'calm'
      };
    },

    /** 把一段剧情摘要写进主记忆（让主聊天能召回） */
    persistMemory: async function (arc, node) {
      var sessId = await K.resolveSessionId();
      if (!sessId || !arc) return false;
      var content = '【心动游戏·' + arc.title + '】'
        + (node ? '（' + (node.title || '') + '）' : '')
        + (K.isReverse() ? '［被攻略模式］' : '［攻略模式］')
        + '：' + U.cut(node ? (node.text || node.scene || '') : (arc.synopsis || ''), 180);
      return K.writeMainMemory(sessId, content, ['心动游戏', '主线', arc.title]);
    }
  };

  // ==========================================================================
  //  3. 剧情中途小手机（SMS / 假朋友圈 / 电话接入）
  // ==========================================================================

  var SubPhone = {

    /** 把节点里的 sms / moment / call 落库 */
    capture: function (node, arc) {
      var st = K.state;
      if (!st || !node) return null;
      var phone = st.story.phone;
      var at = Date.now();
      if (node.kind === 'sms') {
        var row = { id: U.uid('sms'), text: node.text || '', from: 'char', at: at, arcId: arc ? arc.id : null, read: false };
        phone.sms.unshift(row);
        if (phone.sms.length > 120) phone.sms.length = 120;
        K.save();
        return { kind: 'sms', row: row };
      }
      if (node.kind === 'moment') {
        var m = {
          id: U.uid('mom'), text: node.text || '', at: at, arcId: arc ? arc.id : null,
          likes: [], comments: []
        };
        phone.moments.unshift(m);
        if (phone.moments.length > 60) phone.moments.length = 60;
        K.save();
        return { kind: 'moment', row: m };
      }
      if (node.kind === 'call') {
        var c = { id: U.uid('call'), text: node.text || '', at: at, arcId: arc ? arc.id : null, duration: 0 };
        phone.calls.unshift(c);
        if (phone.calls.length > 60) phone.calls.length = 60;
        K.save();
        return { kind: 'call', row: c };
      }
      return null;
    },

    /**
     * 在剧情里给出「在手机里回一句」的界面（v1.5.39）
     * 用户：「当提示有小手机剧情时，需要 user 真的能用小手机回复，或者在小手机里选择回复，
     *        这样才沉浸感。」
     * 做法参考乙女游戏：不是弹一个普通对话框，而是把**手机本体**呈现在剧情里 ——
     * 上面是 TA 发来的那条消息，下面是回复候选 + 自己打一句。
     */
    buildReplyOptions: function (node, host, onPick) {
      var wrap = H.el('div');
      wrap.style.cssText = 'border-radius:18px; padding:11px 11px 12px; margin-bottom:4px;'
        + 'background:linear-gradient(165deg,#2c2130,#463247 62%,#2c2130);'
        + 'box-shadow:0 10px 26px rgba(40,24,38,0.42), inset 0 1px 0 rgba(255,255,255,0.10);';
      var notch = H.el('div');
      notch.style.cssText = 'width:44px;height:4px;border-radius:3px;background:rgba(255,255,255,0.22);margin:0 auto 8px;';
      wrap.appendChild(notch);

      var screen = H.el('div');
      screen.style.cssText = 'border-radius:13px; padding:10px 11px; background:rgba(255,255,255,0.95);';
      var from = node.kind === 'call' ? '正在通话' : (node.kind === 'moment' ? 'TA 的动态' : '刚刚');
      screen.innerHTML = '<div style="font-size:9.4px; color:#a99fae; margin-bottom:5px;">' + U.esc(from) + '</div>'
        + '<div style="font-size:12px; line-height:1.7; color:#4a4050; white-space:pre-wrap;">'
        + U.esc(node.text || '') + '</div>';
      wrap.appendChild(screen);

      var tip = H.el('div');
      tip.style.cssText = 'font-size:9.6px; color:rgba(255,255,255,0.72); margin:9px 2px 6px;';
      tip.textContent = node.kind === 'call' ? '接起来，说点什么：' : '回一句：';
      wrap.appendChild(tip);

      SubPhone.replyCandidates(node).forEach(function (text) {
        var b = H.el('button', { type: 'button' });
        b.style.cssText = 'display:block; width:100%; text-align:left; box-sizing:border-box;'
          + 'margin-bottom:6px; padding:9px 11px; border-radius:12px; font-size:11.6px; line-height:1.55;'
          + 'cursor:pointer; border:1px solid rgba(240,196,216,0.45); background:rgba(255,255,255,0.96); color:#4a4050;';
        b.textContent = text;
        b.onclick = function () { onPick(text); };
        wrap.appendChild(b);
      });

      var row = H.el('div');
      row.style.cssText = 'display:flex; gap:7px;';
      var input = H.el('input', { type: 'text', placeholder: '自己打一句回过去…' });
      input.style.cssText = 'flex:1; box-sizing:border-box; border-radius:12px; border:1px solid rgba(240,196,216,0.4);'
        + 'padding:9px 11px; font-size:11.8px; color:#3a3040; background:#fff; outline:none; font-family:inherit;';
      row.appendChild(input);
      var send = H.iconButton('send', { size: 36, color: '#fff', bg: 'linear-gradient(135deg,#D97FA8,#B79EDC)', border: 'none' });
      send.onclick = function () {
        var t = input.value.trim();
        if (!t) { H.toast('先打一句'); return; }
        onPick(t);
      };
      input.onkeydown = function (e) { if (e.key === 'Enter') send.onclick(); };
      row.appendChild(send);
      wrap.appendChild(row);

      host.appendChild(wrap);
      setTimeout(function () { try { input.focus(); } catch (e) { } }, 120);
    },

    /**
     * 回复候选（纯函数，可单测）
     * 优先用节点自带的 options；没有就给几条符合手机语境的通用候选。
     */
    replyCandidates: function (node) {
      var opts = (node && node.options) || [];
      var fromNode = opts.map(function (o) { return String((o && o.text) || '').trim(); }).filter(Boolean);
      if (fromNode.length) return fromNode.slice(0, 4);
      var kind = node && node.kind;
      if (kind === 'call') return ['接起来，先不出声', '「喂？」', '「你怎么突然打过来。」'];
      if (kind === 'moment') return ['点了个赞', '在下面回一句', '私聊 TA'];
      return ['「在。」', '「怎么了？」', '「我马上过去。」', '先不回，等 TA 再说'];
    },

    /** 把用户的回复也记进小手机的短讯流（这样之后翻手机能看到自己说过的话） */
    pushUserReply: function (text, node, arc) {
      var st = K.state;
      if (!st || !text) return null;
      var phone = st.story.phone;
      var bucket = (node && node.kind === 'call') ? phone.calls
        : (node && node.kind === 'moment') ? phone.moments : phone.sms;
      var row = {
        id: U.uid('me'), text: String(text), from: 'user', at: Date.now(),
        arcId: arc ? arc.id : null, read: true
      };
      bucket.unshift(row);
      if (bucket.length > 120) bucket.length = 120;
      K.save();
      return row;
    },

    /** 小手机界面 */
    open: async function (arc) {      var st = K.state;
      var profile = await K.charProfile();
      var user = await K.userProfile();
      var body = H.el('div');
      var tab = 'sms';

      // 手机外壳
      var phone = H.el('div');
      phone.style.cssText = 'position:relative; border-radius:26px; padding:12px 10px 14px;'
        + 'background:linear-gradient(165deg,#2c2130,#4a3344 60%,#2c2130);'
        + 'box-shadow:0 18px 44px rgba(60,40,58,0.35), inset 0 1px 0 rgba(255,255,255,0.12);';
      var notch = H.el('div');
      notch.style.cssText = 'width:52px; height:4px; border-radius:3px; background:rgba(255,255,255,0.24);'
        + 'margin:0 auto 10px;';
      phone.appendChild(notch);
      var screen = H.el('div');
      screen.style.cssText = 'border-radius:18px; overflow:hidden; background:linear-gradient(170deg,#fffaff,#f6f2fb);'
        + 'min-height:400px; display:flex; flex-direction:column;';
      phone.appendChild(screen);
      body.appendChild(phone);

      var head = H.el('div');
      head.style.cssText = 'padding:11px 13px 9px; background:linear-gradient(180deg,rgba(255,241,247,0.95),rgba(255,255,255,0.6));'
        + 'border-bottom:1px solid rgba(216,160,190,0.18);';
      head.innerHTML = '<div style="font-size:12.5px; font-weight:800; color:#5c4450;">' + U.esc(profile.name) + ' 的手机</div>'
        + '<div style="font-size:9.6px; color:#a99fae; margin-top:2px;">剧情进程中的即时通讯</div>';
      screen.appendChild(head);

      var tabs = H.el('div');
      tabs.style.cssText = 'padding:9px 11px 4px;';
      screen.appendChild(tabs);

      var list = H.el('div');
      list.style.cssText = 'flex:1; overflow-y:auto; padding:8px 12px 14px;';
      screen.appendChild(list);

      function renderTabs() {
        tabs.innerHTML = '';
        tabs.appendChild(H.tabs([
          { key: 'sms', label: '短讯', icon: 'msg', badge: st.story.phone.sms.length || '' },
          { key: 'moment', label: '朋友圈', icon: 'camera', badge: st.story.phone.moments.length || '' },
          { key: 'call', label: '通话', icon: 'call', badge: st.story.phone.calls.length || '' }
        ], tab, function (k) { tab = k; renderTabs(); renderList(); }));
      }

      function renderList() {
        list.innerHTML = '';
        var rows = st.story.phone[tab === 'sms' ? 'sms' : (tab === 'moment' ? 'moments' : 'calls')] || [];
        if (!rows.length) {
          list.appendChild(H.empty(tab === 'sms' ? '还没有剧情短讯。' : (tab === 'moment' ? '还没有剧情朋友圈。' : '还没有剧情来电。'),
            { icon: tab === 'call' ? 'call' : 'phone' }));
          return;
        }
        rows.forEach(function (r) {
          if (tab === 'sms') {
            list.appendChild(H.bubble({
              side: 'char',
              text: r.text,
              name: profile.name,
              meta: U.timeAgo(r.at),
              avatarNode: H.avatar(profile.avatar, profile.name, 30)
            }));
          } else if (tab === 'moment') {
            var card = H.card({ accent: '#7E97C9', soft: '#EDF2FB', pad: 12 });
            card.style.marginBottom = '10px';
            var headRow = H.el('div');
            headRow.style.cssText = 'display:flex; align-items:center; gap:9px; margin:4px 0 9px;';
            headRow.appendChild(H.avatar(profile.avatar, profile.name, 34));
            var who = H.el('div');
            who.innerHTML = '<div style="font-size:11.6px; font-weight:800; color:#5c4450;">' + U.esc(profile.name) + '</div>'
              + '<div style="font-size:9.4px; color:#a99fae;">' + U.timeAgo(r.at) + '</div>';
            headRow.appendChild(who);
            card.appendChild(headRow);
            var txt = H.el('div', {}, U.esc(r.text));
            txt.style.cssText = 'font-size:12px; line-height:1.78; color:#5c4450; white-space:pre-wrap;';
            card.appendChild(txt);
            // 假点赞 / 假评论
            var acts = H.el('div');
            acts.style.cssText = 'display:flex; gap:9px; margin-top:10px; align-items:center;';
            var likeB = H.button('点赞 ' + ((r.likes || []).length || ''), {
              kind: 'soft', pad: '5px 10px', size: 10.4, icon: 'heart', soft: '#FFEBF3', color: '#B0728F'
            });
            likeB.onclick = function () {
              r.likes = r.likes || [];
              var mine = r.likes.indexOf('me');
              if (mine >= 0) r.likes.splice(mine, 1); else r.likes.push('me');
              K.save();
              renderList();
            };
            acts.appendChild(likeB);
            var cmtB = H.button('让 TA 评论', {
              kind: 'soft', pad: '5px 10px', size: 10.4, icon: 'msg', soft: '#EDF2FB', color: '#5f7aa8'
            });
            cmtB.onclick = async function () {
              var prompt = await Gen.baseSystem(
                '你在扮演 ' + profile.name + '。你刚发了一条朋友圈：\n「' + r.text + '」\n\n'
                + '玩家 ' + user.name + ' 点了赞。请写一条你自己在评论区追加的回复，'
                + '20~40 字，第一人称，符合当前关系阶段与心情，不要写旁白。'
              );
              var out = await K.ask(prompt, { temperature: 0.95 });
              if (!out) { H.toast('模型不可用'); return; }
              r.comments = r.comments || [];
              r.comments.push({ by: profile.name, text: out.replace(/\n+/g, ' ').trim(), at: Date.now() });
              K.save();
              renderList();
            };
            acts.appendChild(cmtB);
            card.appendChild(acts);
            (r.comments || []).forEach(function (c) {
              var cm = H.el('div');
              cm.style.cssText = 'margin-top:9px; padding:8px 10px; border-radius:11px; background:rgba(237,242,251,0.8);'
                + 'font-size:11px; line-height:1.7; color:#5f6b82;';
              cm.innerHTML = '<b style="color:#4A7DBF;">' + U.esc(c.by) + '</b>：' + U.esc(c.text);
              card.appendChild(cm);
            });
            list.appendChild(card);
          } else {
            var call = H.listRow({
              icon: 'call', color: '#D97FA8', soft: '#FFEBF3',
              title: '来电 · ' + U.timeAgo(r.at),
              subtitle: r.text,
              subtitleWrap: true
            });
            call.onclick = function () { SubPhone.playCall(r, profile); };
            list.appendChild(call);
          }
        });
      }

      renderTabs();
      renderList();

      H.sheet({
        title: '剧情小手机',
        subtitle: arc ? arc.title : '当前篇章',
        icon: 'phone',
        height: '92%',
        content: body
      });
    },

    /** 电话接入演出 */
    playCall: function (call, profile) {
      var body = H.el('div');
      var ring = H.el('div');
      ring.style.cssText = 'text-align:center; padding:20px 0 10px;';
      ring.innerHTML = '<div style="width:84px; height:84px; margin:0 auto 14px; border-radius:50%;'
        + 'background:linear-gradient(150deg,#FFEBF3,#F3EEFF); display:flex; align-items:center; justify-content:center;'
        + 'color:#D97FA8; box-shadow:0 0 0 8px rgba(217,127,168,0.12); animation:hg-pulse 1.6s ease-in-out infinite;">'
        + H.icon('call', 34, { strokeWidth: 1.7 }) + '</div>'
        + '<div style="font-size:14.5px; font-weight:800; color:#553f4c;">' + U.esc(profile.name) + '</div>'
        + '<div style="font-size:10.6px; color:#a99fae; margin-top:5px;">通话中 · ' + U.timeAgo(call.at) + '</div>';
      body.appendChild(ring);

      var voice = H.el('div');
      voice.style.cssText = 'margin-top:10px; padding:14px; border-radius:16px; font-size:12.6px; line-height:1.86;'
        + 'color:#5c4450; background:linear-gradient(150deg,rgba(255,255,255,0.96),rgba(255,246,250,0.9));'
        + 'border:1px solid rgba(216,160,190,0.24); white-space:pre-wrap;';
      voice.textContent = '「' + (call.text || '……') + '」';
      body.appendChild(voice);

      var tip = H.el('div');
      tip.style.cssText = 'font-size:10.4px; color:#a99fae; text-align:center; margin-top:14px;';
      tip.textContent = '你可以继续在剧情里回应这通电话。';
      body.appendChild(tip);

      H.confirm({
        title: '剧情来电',
        icon: 'call', accent: '#D97FA8', soft: '#FFEBF3',
        message: (profile.name + '：' + (call.text || '')).slice(0, 160),
        okText: '接起来', cancelText: '稍后'
      }).then(function (ok) {
        if (!ok) return;
        H.sheet({
          title: '通话中', subtitle: profile.name, icon: 'call',
          height: '60%', content: body,
          buttons: [{ text: '挂断', kind: 'outline', color: '#8f6a80' }]
        });
      });
    }
  };

  // ==========================================================================
  //  4. 演出层：VN 舞台
  // ==========================================================================

  var Stage = {
    _current: null,
    _bgLayer: null,
    _portraitHost: null,

    /** 开场：把舞台铺到容器里 */
    mount: function (host) {
      host.innerHTML = '';
      var stage = H.el('div', { class: 'hg-vn-stage hg-rise' });
      stage.style.cssText = 'position:absolute; inset:0; overflow:hidden;';

      var bg = H.el('div');
      bg.style.cssText = 'position:absolute; inset:0; background:linear-gradient(170deg,#2c2130 0%,#4a3344 46%,#1f1720 100%);'
        + 'transition:background-image .6s ease, opacity .6s ease;';
      stage.appendChild(bg);
      Stage._bgLayer = bg;

      // 氛围蒙版
      var veil = H.el('div');
      veil.style.cssText = 'position:absolute; inset:0; pointer-events:none;'
        + 'background:radial-gradient(circle at 50% 34%, rgba(255,255,255,0.13) 0%, rgba(0,0,0,0.42) 78%);';
      stage.appendChild(veil);

      // 立绘层
      var portraitHost = H.el('div');
      portraitHost.style.cssText = 'position:absolute; left:0; right:0; bottom:118px; top:8%;';
      stage.appendChild(portraitHost);
      Stage._portraitHost = portraitHost;

      host.appendChild(stage);
      Stage._current = stage;
      return stage;
    },

    /** 设置背景（用户自定义图 > 内置场景插画 > 关键词渐变） */
    setBackground: async function (bgKey) {
      var layer = Stage._bgLayer;
      if (!layer) return;
      var custom = K.currentBackground();
      var picked = (K.state && K.state.assets) ? K.state.assets.currentBackgroundId : null;

      // ① 用户自己上传并选中的背景优先（内置素材不算「用户指定」，否则会把剧情场景顶掉）
      if (picked && custom && custom.src && !custom.builtin) {
        layer.style.backgroundImage = 'url(' + custom.src + ')';
        layer.style.backgroundSize = 'cover';
        layer.style.backgroundPosition = 'center';
        return;
      }

      // ② 内置场景插画：按节点 bg 关键词映射（以前这里完全没接入这三张图）
      var art = STAGE_SCENE_ART[bgKey];
      if (art) {
        layer.style.backgroundImage = 'url(' + art + ')';
        layer.style.backgroundSize = 'cover';
        layer.style.backgroundPosition = 'center';
        return;
      }

      // ③ 兜底：关键词渐变
      var GRADS = {
        '雨天': 'linear-gradient(170deg,#3a4553 0%,#55606e 50%,#2b333d 100%)',
        '卧室': 'linear-gradient(170deg,#3b2f3d 0%,#6b5566 50%,#2a2130 100%)',
        '校园': 'linear-gradient(170deg,#48586b 0%,#7d8fa3 52%,#2f3a47 100%)',
        '黄昏': 'linear-gradient(170deg,#6b4436 0%,#c98a63 46%,#3a2733 100%)',
        '街道': 'linear-gradient(170deg,#33323f 0%,#5c5a72 50%,#221f2b 100%)',
        '咖啡店': 'linear-gradient(170deg,#4a3a2f 0%,#8a6d55 50%,#2e241d 100%)',
        '海边': 'linear-gradient(170deg,#2f4a5c 0%,#6fa2b8 46%,#20313d 100%)',
        '露台': 'linear-gradient(170deg,#2c2a45 0%,#5d5786 50%,#1d1b2e 100%)',
        '车内': 'linear-gradient(170deg,#25232c 0%,#454257 52%,#17161d 100%)'
      };
      layer.style.backgroundImage = GRADS[bgKey] || GRADS['卧室'];
    },

    /** 立绘：切换表情 / 动作 */
    setEmotion: async function (emotion) {
      var host = Stage._portraitHost;
      if (!host) return;
      if (!host._renderer) {
        if (HG.Portraits) {
          var res = await HG.Portraits.mount(host, { onTouch: null });
          host._renderer = res;
        }
      }
      var r = host._renderer;
      if (r && r.renderer && r.renderer.react) {
        r.renderer.react('face', emotion);
      }
    }
  };

  // ==========================================================================
  //  5. 主界面：篇章选择 / 剧情播放 / 分支树
  // ==========================================================================

  /**
   * 内置场景插画（v1.5.35）
   * 以前 VN 舞台只认「9 个关键词渐变」，这三张真正的场景图从来没被用上。
   * 现在按节点 bg 关键词映射过去：有图用图、没图回落渐变。
   */
  var STAGE_SCENE_ART = {
    '卧室': 'images/heartgame/stage/bg-night.png',
    '深夜': 'images/heartgame/stage/bg-night.png',
    '房间': 'images/heartgame/stage/bg-night.png',
    '咖啡店': 'images/heartgame/stage/bg-night.png',
    '雨天': 'images/heartgame/stage/bg-rain.png',
    '雨夜': 'images/heartgame/stage/bg-rain.png',
    '街道': 'images/heartgame/stage/bg-rain.png',
    '车内': 'images/heartgame/stage/bg-rain.png',
    '黄昏': 'images/heartgame/stage/bg-dusk.png',
    '露台': 'images/heartgame/stage/bg-dusk.png',
    '天台': 'images/heartgame/stage/bg-dusk.png',
    '校园': 'images/heartgame/stage/bg-dusk.png',
    '海边': 'images/heartgame/stage/bg-dusk.png'
  };

  /**
   * 退出主线后把主页立绘重新挂上（v1.5.35）
   * 主线与主页**共用同一个 Portraits 单例**：进主线时 Stage.mount() 已经销毁了主页的
   * renderer 与资源池，退出时如果没人复挂，回到看板就只剩一片空舞台。
   * 只在心动游戏窗口仍然打开时复挂 —— 否则就是「关应用时反而把界面重新画出来」。
   */
  function remountLobbyPortrait() {
    try {
      var win = document.getElementById('win-heartgame');
      if (!win || !win.classList.contains('active')) return;
      if (window.heartGameApp && typeof window.heartGameApp.render === 'function') {
        window.heartGameApp.render();
      }
    } catch (e) { }
  }

  var UI = {
    _arc: null,
    _busy: false,

    /** 篇章列表 */
    openArcList: async function () {
      var st = K.state;
      var body = H.el('div');
      var arcs = st.story.arcs || [];

      var intro = H.el('div');
      intro.style.cssText = 'font-size:10.8px; line-height:1.72; color:#8b8292; background:rgba(255,241,247,0.8);'
        + 'border:1px solid rgba(217,127,168,0.22); border-radius:13px; padding:11px 12px; margin-bottom:12px;';
      intro.innerHTML = K.isReverse()
        ? '当前是<b>被攻略模式</b>：主线节点停顿时由你设定 2~3 个抉择项并附带属性奖惩，'
          + '<b>TA 会基于自己的性格模型自主选择</b>，把故事推向 TA 想要的方向。'
        : '当前是<b>攻略模式</b>：系统与 TA 出题，你选分支；也可以直接在输入框里写任何你想做的动作，由模型即时推演 TA 的反应。';
      body.appendChild(intro);

      if (!arcs.length) {
        body.appendChild(H.empty('还没有开启任何篇章。让 AI 按你们的角色设定写一个开局。', { icon: 'book' }));
      }

      arcs.forEach(function (a) {
        var node = a.nodes[U.clamp(U.int(a.nodeIndex, 0), 0, Math.max(0, a.nodes.length - 1))] || null;
        var pct = a.nodes.length ? U.pct(U.int(a.nodeIndex, 0) + 1, a.nodes.length) : 0;
        var row = H.listRow({
          icon: 'book',
          color: a.status === 'finished' ? '#9FB3D9' : '#D97FA8',
          soft: a.status === 'finished' ? '#EDF2FB' : '#FFEBF3',
          title: a.title,
          subtitle: (a.status === 'finished' ? '已完结 · ' : '进行中 · ')
            + (a.nodes.length + ' 个节点') + (node ? ' · ' + node.title : '')
            + ' · ' + U.round(pct, 0) + '%',
          subtitleWrap: true,
          rightNode: (function () {
            var box = H.el('div');
            box.style.cssText = 'display:flex; gap:6px; align-items:center; flex-shrink:0;';
            var go = H.button(a.status === 'finished' ? '重看' : '继续', {
              kind: 'soft', pad: '5px 11px', size: 10.6, soft: '#FFEBF3', color: '#B0728F'
            });
            go.onclick = function (ev) {
              ev.stopPropagation();
              Arc.setActive(a.id);
              UI.play(a);
            };
            box.appendChild(go);
            // 从头回看：不动进度地重看一遍（用户要的"可以多次回看播放"）
            if (U.int(a.nodeIndex, 0) > 0) {
              var replay = H.button('从头回看', {
                kind: 'soft', pad: '5px 10px', size: 10.6, soft: '#EDF2FB', color: '#5f7aa8'
              });
              replay.onclick = function (ev) {
                ev.stopPropagation();
                Arc.setActive(a.id);
                UI.play(a, { replay: true });
              };
              box.appendChild(replay);
            }
            var tree = H.iconButton('branch', { size: 26, color: '#B79EDC', title: '分支树' });
            tree.onclick = function (ev) { ev.stopPropagation(); UI.openBranchTree(a); };
            box.appendChild(tree);
            var del = H.iconButton('trash', { size: 26, color: '#c2607c' });
            del.onclick = function (ev) {
              ev.stopPropagation();
              H.confirm({
                title: '删除篇章', icon: 'trash', accent: '#c2607c', soft: '#FFEFF3',
                message: '删除「' + a.title + '」？该篇章的所有节点与存档点都会消失。',
                okText: '删除'
              }).then(function (ok) {
                if (!ok) return;
                Arc.remove(a.id);
                UI.openArcList();
              });
            };
            box.appendChild(del);
            return box;
          })()
        });
        body.appendChild(row);
      });

      var themeBox = H.el('div');
      themeBox.style.cssText = 'margin-top:12px;';
      var input = H.el('input', { type: 'text', placeholder: '新篇章主题，例如：分开三年后他突然出现在你楼下' });
      input.style.cssText = 'width:100%; box-sizing:border-box; border-radius:12px; border:1px solid rgba(216,160,190,0.32);'
        + 'padding:9px 11px; font-size:12px; color:#5c4450; background:#fff; outline:none; font-family:inherit;';
      themeBox.appendChild(input);
      var quick = H.el('div');
      quick.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;';
      ['一场没有预告的重逢', '被困在同一间民宿', '他替你挡了一次酒', '身份暴露的那一夜'].forEach(function (t) {
        var b = H.button(t, { kind: 'soft', pad: '5px 10px', size: 10.4, soft: '#FFEBF3', color: '#B0728F' });
        b.onclick = function () { input.value = t; };
        quick.appendChild(b);
      });
      themeBox.appendChild(quick);
      body.appendChild(themeBox);

      H.sheet({
        title: '主线剧情',
        subtitle: '多篇章并行 · 存档点 · 分支回溯',
        icon: 'book',
        height: '90%',
        slot: 'story',
        content: body,
        buttons: [{
          text: 'AI 写一个新篇章', icon: 'sparkle', kind: 'primary', keepOpen: true,
          onClick: async function () {
            var theme = input.value.trim() || '一场没有预告的重逢';
            H.toast('正在为你们写一个开局…');
            var arc = await Gen.generateArc(theme);
            if (!arc) { H.toast('篇章生成失败'); return; }
            H.closeAllLayers();
            UI.play(arc);
          }
        }]
      });
    },

    /** 播放一个篇章（opts.replay = true 表示"从头回看"，结束时回到原来的进度） */
    play: async function (arc, opts) {
      var a = arc || Arc.active();
      if (!a) { UI.openArcList(); return; }
      UI._arc = a;
      var replay = !!(opts && opts.replay);
      // 演出期间挂起看板重绘：看板一旦重绘就会 teardown 掉共用的 Portraits 单例，
      // 主线立绘会当场消失（用户反馈的"主线里立绘时不时消失"）
      if (window.heartGameApp && typeof window.heartGameApp.setSuspended === 'function') {
        window.heartGameApp.setSuspended(true);
      }
      // 回看：先把进度记下来，退出时还原（用户要的"可以多次回看播放"）
      var replayFrom = replay ? U.int(a.nodeIndex, 0) : null;
      if (replay) {
        a.nodeIndex = 0;
        a._replayDepth = U.int(a._replayDepth, 0) + 1;
      }

      var st = K.state;
      var host = H.el('div');
      host.style.cssText = 'position:relative; width:100%; height:100%; min-height:74vh;';

      // 浮层：自定义行为输入（挂 body，避免被裁）
      var overlay = H.el('div');
      overlay.style.cssText = 'position:fixed; inset:0; z-index:100100; padding:0; box-sizing:border-box;'
        + 'background:#1b1319; opacity:0; transition:opacity .3s ease;';
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.style.opacity = '1'; });

      var inner = H.el('div');
      inner.style.cssText = 'position:relative; width:100%; height:100%; max-width:520px; margin:0 auto;';
      overlay.appendChild(inner);
      inner.appendChild(host);

      Stage.mount(host);

      // 顶部条
      var topbar = H.el('div');
      topbar.style.cssText = 'position:absolute; left:0; right:0; top:0; z-index:6; padding:11px 13px;'
        + 'display:flex; align-items:center; gap:9px;'
        + 'background:linear-gradient(180deg, rgba(20,12,18,0.72) 0%, rgba(20,12,18,0) 100%);';
      var closeB = H.iconButton('close', { size: 32, color: '#fff', bg: 'rgba(255,255,255,0.16)', border: 'rgba(255,255,255,0.22)' });
      closeB.onclick = function () { exit(); };
      topbar.appendChild(closeB);
      var topTitle = H.el('div');
      topTitle.style.cssText = 'flex:1; min-width:0;';
      topTitle.innerHTML = '<div style="font-size:12.5px; font-weight:800; color:#fff; white-space:nowrap;'
        + 'overflow:hidden; text-overflow:ellipsis;">' + U.esc(a.title) + '</div>'
        + '<div id="hg-vn-progress" style="font-size:9.6px; color:rgba(255,255,255,0.66); margin-top:2px;"></div>';
      topbar.appendChild(topTitle);
      var phoneB = H.iconButton('phone', { size: 32, color: '#fff', bg: 'rgba(255,255,255,0.16)', border: 'rgba(255,255,255,0.22)', title: '剧情小手机' });
      phoneB.onclick = function () { SubPhone.open(a); };
      topbar.appendChild(phoneB);
      var treeB = H.iconButton('branch', { size: 32, color: '#fff', bg: 'rgba(255,255,255,0.16)', border: 'rgba(255,255,255,0.22)', title: '分支树' });
      treeB.onclick = function () { UI.openBranchTree(a); };
      topbar.appendChild(treeB);
      var saveB = H.iconButton('save', { size: 32, color: '#fff', bg: 'rgba(255,255,255,0.16)', border: 'rgba(255,255,255,0.22)', title: '存档点' });
      saveB.onclick = function () {
        var snap = Arc.save(a);
        H.toast(snap ? '已保存：' + snap.label : '保存失败');
      };
      topbar.appendChild(saveB);
      inner.appendChild(topbar);

      // 叙事窗（v1.5.39 重做：**透明化**、字更小，只显示当前这一个分镜）
      // 用户：「对话框过于复杂了，我们要透明化，字体缩小一些，并且做好段落切分，
      //        基本一句话一个分镜，角色说话要单独分镜。」
      // 所以这里不再是一张白卡片，而是"文字直接落在画面上 + 一层柔和的可读性衬底"。
      var win = H.el('div');
      win.style.cssText = 'position:absolute; left:0; right:0; bottom:0; z-index:5; padding:0 14px 16px;';
      var winCard = H.el('div');
      winCard.style.cssText = 'position:relative; padding:34px 4px 6px; box-sizing:border-box;'
        + 'background:linear-gradient(180deg, rgba(18,12,20,0) 0%, rgba(18,12,20,0.30) 38%,'
        + ' rgba(18,12,20,0.46) 100%);'
        + 'border-radius:18px; cursor:pointer;';
      win.appendChild(winCard);
      // 推进提示（右下角的小三角）
      var nextHint = H.el('div');
      nextHint.style.cssText = 'position:absolute; right:8px; bottom:4px; font-size:10px;'
        + 'color:rgba(255,255,255,0.62); letter-spacing:.08em; pointer-events:none;';
      nextHint.textContent = '轻触继续';
      winCard.appendChild(nextHint);
      inner.appendChild(win);

      var body = H.el('div');
      var optsHost = H.el('div');
      optsHost.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-top:11px;';

      var exit = function () {
        if (exit._closed) return;      // 关闭按钮与 closeAllLayers 可能同时来，防重入
        exit._closed = true;
        overlay.style.opacity = '0';
        // 回看模式：把进度还原回进来之前，存档点/分支不会因为"重看一遍"被改乱
        if (replay && replayFrom !== null) {
          a.nodeIndex = replayFrom;
          K.save();
        }
        // 自建浮层从登记表里摘掉，避免留下死引用
        if (HG.H && HG.H.forgetLayer) { try { HG.H.forgetLayer(overlay); } catch (e) { } }
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          if (HG.Portraits) { try { HG.Portraits.teardown(); } catch (e) { } }
          // 恢复看板重绘：挂起期间的请求会被合并成这一次
          if (window.heartGameApp && typeof window.heartGameApp.setSuspended === 'function') {
            window.heartGameApp.setSuspended(false);
          }
          // 复挂主页立绘：不做这一步，"从主线返回后看板立绘消失"就会一直复现
          remountLobbyPortrait();
        }, 300);
      };

      // 这个 overlay 是**自建**的（不走 H._layer），必须登记进浮层体系：
      // 否则 H.closeAllLayers() 根本关不掉它 —— 用户反馈的「有些弹窗不会自己关闭」里，
      // 主线就是最典型的一个。
      if (HG.H && HG.H.registerLayer) HG.H.registerLayer(overlay, function () { exit(); }, 'story-play');

      // 当前节点的分镜（一句话一个）与游标
      var segs = [];
      var segIdx = 0;
      var curNode = null;
      var curProfile = null;

      /**
       * 点击叙事窗：**先把分镜走完，再推进剧情**。
       * 这正是用户要的"一句话一个分镜"——一句话一次轻触，节奏由玩家自己控制。
       */
      winCard.onclick = function (e) {
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea')) return;
        if (winCard._hasOptions) return;
        if (segIdx < segs.length - 1) { segIdx++; paintSegment(); return; }
        advanceFlow();
      };

      /** 画当前这一个分镜：旁白与台词分开呈现（角色说话单独分镜） */
      function paintSegment() {
        body.innerHTML = '';
        var seg = segs[segIdx];
        if (!seg) return;
        var isSpeech = seg.kind === 'speech';
        var box = H.el('div');
        box.style.cssText = isSpeech
          ? 'font-size:13.2px; line-height:1.72; color:#fff; font-weight:600;'
          : 'font-size:12.1px; line-height:1.76; color:rgba(255,255,255,0.90);';
        // 透明化之后靠文字投影保证可读性（不再压一张白卡片）
        box.style.textShadow = '0 1px 8px rgba(0,0,0,0.55), 0 2px 18px rgba(0,0,0,0.42)';
        if (isSpeech) {
          var who = H.el('div');
          who.style.cssText = 'font-size:10px; font-weight:800; letter-spacing:.18em; color:#F2C7DA; margin-bottom:5px;';
          who.textContent = (curProfile && curProfile.name) || 'TA';
          box.appendChild(who);
        }
        var txt = H.el('div');
        txt.style.cssText = 'white-space:pre-wrap;';
        txt.textContent = seg.text;
        box.appendChild(txt);
        body.appendChild(box);
        nextHint.textContent = (segIdx < segs.length - 1) ? ('轻触继续 · ' + (segIdx + 1) + '/' + segs.length) : '';
      }

      /** 分镜走完之后：有选项就先出选项，否则推进到下一个节点 */
      function advanceFlow() {
        var node = curNode;
        if (node && !winCard._optionsShown && !winCard._hasOptions
          && a.nodeIndex < a.nodes.length - 1 && (node.options || []).length) {
          showOptions(node);
          return;
        }
        var next = Arc.advance(a);
        if (!next) {
          finishArc(a, inner, body, optsHost, winCard, exit);
          return;
        }
        renderNode();
      }

      // ------------------------------------------------------------------
      // 节点渲染
      // ------------------------------------------------------------------
      async function renderNode() {
        var node = Arc.node(a);
        if (!node) { finishArc(a, inner, body, optsHost, winCard, exit); return; }
        curNode = node;
        var profile = await K.charProfile();
        curProfile = profile;
        await K.userProfile();

        var prog = document.getElementById('hg-vn-progress');
        if (prog) prog.textContent = (node.title || '') + ' · ' + (U.int(a.nodeIndex, 0) + 1) + ' / ' + a.nodes.length;

        Stage.setBackground(node.bg);
        Stage.setEmotion(node.emotion);
        // 剧情小手机内容自动落库
        if (Script.isPhoneKind(node.kind)) {
          SubPhone.capture(node, a);
          H.toast(node.kind === 'sms' ? '手机震了一下…' : (node.kind === 'call' ? '有电话打进来' : 'TA 发了朋友圈'));
        }

        winCard._hasOptions = false;
        winCard._optionsShown = false;
        body.innerHTML = '';
        optsHost.innerHTML = '';

        // 拆分成「一句话一个分镜」；「…」里的角色台词单独成镜
        segs = Script.splitSegments(node.text);
        if (!segs.length) segs = [{ kind: 'narration', text: '' }];
        segIdx = 0;

        if (node.title) {
          var t = H.el('div');
          t.style.cssText = 'font-size:10px; letter-spacing:.2em; color:#F2C7DA; font-weight:800; margin-bottom:7px;'
            + 'text-shadow:0 1px 8px rgba(0,0,0,0.6);';
          t.textContent = node.title;
          body.appendChild(t);
        }
        paintSegment();
      }

      /**
       * 出选项（分镜全部走完之后）
       * 攻略模式：系统分支 + **永远可用的自由输入**（用户要的"选项可以自己写"）；
       * 被攻略模式：User 设定的抉择交给 Char 自主选择。
       */
      function showOptions(node) {
        winCard._optionsShown = true;
        winCard._hasOptions = true;
        optsHost.innerHTML = '';
        nextHint.textContent = '';
        if (K.isReverse()) {
          // 反向模式：User 已设定的抉择，交给 Char 自主选择
          var hint = H.el('div');
          hint.style.cssText = 'font-size:10.4px; color:rgba(255,255,255,0.78); text-align:center; margin-bottom:7px;'
            + 'text-shadow:0 1px 8px rgba(0,0,0,0.5);';
          hint.textContent = '以下抉择由你设定，TA 会依自己的性格做出选择';
          optsHost.appendChild(hint);
          (node.options || []).forEach(function (o) {
            var rowEl = H.el('div');
            rowEl.style.cssText = 'border-radius:14px; padding:10px 12px; box-sizing:border-box;'
              + 'background:rgba(28,20,30,0.52); border:1.2px dashed rgba(240,196,216,0.5);';
            rowEl.innerHTML = '<div style="font-size:12px; color:#fff; line-height:1.6;">' + U.esc(o.text) + '</div>'
              + '<div style="display:flex; gap:6px; margin-top:6px;">'
              + '<span style="font-size:9.6px; font-weight:800; color:#F2C7DA;">'
              + '好感 ' + (o.affinityDelta >= 0 ? '+' : '') + o.affinityDelta + '</span>'
              + '<span style="font-size:9.6px; font-weight:800; color:#C9B6EE;">'
              + '裁定 ' + (o.verdictDelta >= 0 ? '+' : '') + o.verdictDelta + '</span>'
              + '</div>';
            optsHost.appendChild(rowEl);
          });
          var decideB = H.button('让 TA 做选择', { kind: 'primary', block: true, icon: 'dice', color: '#B79EDC', color2: '#D97FA8' });
          decideB.onclick = function () { UI.resolveReverseChoice(a, node, body, optsHost, winCard); };
          optsHost.appendChild(decideB);
        } else {
          // 小手机剧情：**只出手机回复界面**，不再把同一批 options 又渲染成普通分支按钮
          // （用户 2026-09-11：小手机分支会和原本的剧情分支重复，删掉一个）
          var phoneNode = Script.isPhoneKind(node.kind);
          if (phoneNode) {
            SubPhone.buildReplyOptions(node, optsHost, function (text) {
              SubPhone.pushUserReply(text, node, a);
              UI.resolveFreeAction(a, node, text, body, optsHost, winCard);
            }, { hideCandidates: (node.options || []).length > 0 ? false : false });
          } else {
            (node.options || []).forEach(function (o) {
              var b = H.button(o.text, {
                kind: 'soft', block: true, color: '#8f6a80', soft: 'rgba(255,241,247,0.94)',
                pad: '11px 13px', size: 12
              });
              b.style.textAlign = 'left';
              b.style.justifyContent = 'flex-start';
              b.onclick = function () { UI.resolveChoice(a, node, o, body, optsHost, winCard); };
              optsHost.appendChild(b);
            });
          }

          // 自由行动输入框：**总是出现**（用户要的"选项由自己输入"）
          var freeWrap = H.el('div');
          freeWrap.style.cssText = 'display:flex; gap:7px; margin-top:4px;';
          var freeInput = H.el('input', { type: 'text', placeholder: '或者，自己写一个动作 / 一句话…' });
          freeInput.style.cssText = 'flex:1; box-sizing:border-box; border-radius:12px; border:1px solid rgba(240,196,216,0.42);'
            + 'padding:9px 11px; font-size:11.8px; color:#3a3040; background:rgba(255,255,255,0.94); outline:none;'
            + 'font-family:inherit;';
          freeWrap.appendChild(freeInput);
          var freeB = H.iconButton('send', { size: 36, color: '#fff', bg: 'linear-gradient(135deg,#D97FA8,#B79EDC)', border: 'none' });
          freeB.onclick = function () {
            var act = freeInput.value.trim();
            if (!act) { H.toast('先写点什么'); return; }
            UI.resolveFreeAction(a, node, act, body, optsHost, winCard);
          };
          freeInput.onkeydown = function (e) { if (e.key === 'Enter') freeB.onclick(); };
          freeWrap.appendChild(freeB);
          optsHost.appendChild(freeWrap);
        }
      }


      winCard.appendChild(body);
      winCard.appendChild(optsHost);
      renderNode();
    },

    /** 攻略模式：选分支 */
    resolveChoice: async function (arc, node, option, body, optsHost, winCard) {
      if (UI._busy) return;
      UI._busy = true;
      optsHost.innerHTML = '';
      optsHost.appendChild(H.loading('TA 正在回应…'));

      Arc.recordChoice(arc, node, option);
      var res = K.addAffinity(option.affinityDelta || 0, { reason: '剧情选择：' + U.cut(option.text, 16) });
      if (option.verdictDelta) K.nudgeVerdict(option.verdictDelta, { note: '剧情选择' });

      var text = option.result;
      if (!text) {
        var prompt = await Gen.baseSystem(
          '当前场景：' + (node.scene || '') + '\n节点正文：' + U.cut(node.text, 200) + '\n\n'
          + '玩家刚刚选择了：「' + option.text + '」\n\n'
          + '请写这个选择之后发生了什么，70~130 字，要有具体的身体反应或一句直接引语。不要旁白腔。'
        );
        text = await K.ask(prompt, { temperature: 0.95 });
        if (!text) text = '你做了这个选择。空气安静了一瞬，随后是他没有完全藏住的一点反应。';
      }
      text = String(text).replace(/^["「『]|["」』]$/g, '').trim();

      node.resolved = { choiceId: option.id, text: text, at: Date.now() };
      optsHost.innerHTML = '';

      // 飘字
      if (res.applied) {
        H.floatText((res.applied > 0 ? '+' : '') + res.applied + ' 心动', {
          host: winCard, x: '50%', y: '16%', color: res.applied > 0 ? '#D97FA8' : '#7E97C9'
        });
      }
      winCard._hasOptions = false;

      // 结算气泡
      var card = H.el('div');
      card.style.cssText = 'border-radius:15px; padding:11px 12px; font-size:12.2px; line-height:1.82;'
        + 'color:#5c4450; background:linear-gradient(150deg,rgba(255,255,255,0.98),rgba(255,246,250,0.9));'
        + 'border:1px solid rgba(216,160,190,0.24); white-space:pre-wrap;';
      card.textContent = text;
      body.appendChild(card);

      if (res.gated) {
        UI.offerGate(arc, body, optsHost, winCard, res);
      } else if (res.tierUp) {
        UI.announceTier(body);
      }

      // 记忆回流
      Gen.persistMemory(arc, node).catch(function () { });
      UI._busy = false;
    },

    /** 攻略模式：自由行动推演 */
    resolveFreeAction: async function (arc, node, action, body, optsHost, winCard) {
      if (UI._busy) return;
      UI._busy = true;
      optsHost.innerHTML = '';
      optsHost.appendChild(H.loading('正在推演你的动作…'));

      var out = await Gen.freeAction(node, action);
      optsHost.innerHTML = '';
      winCard._hasOptions = false;

      var res = K.addAffinity(out.affinityDelta, { reason: '自由行动：' + U.cut(action, 16) });
      if (out.verdictDelta) K.nudgeVerdict(out.verdictDelta, { note: '自由行动' });
      Arc.recordChoice(arc, node, { id: 'free', text: action, affinityDelta: out.affinityDelta });

      var mine = H.bubble({ side: 'user', text: action, name: '你' });
      body.appendChild(mine);

      if (res.applied) {
        H.floatText((res.applied > 0 ? '+' : '') + res.applied + ' 心动', {
          host: winCard, x: '50%', y: '18%', color: res.applied > 0 ? '#D97FA8' : '#7E97C9'
        });
      }
      var profile = await K.charProfile();
      body.appendChild(H.bubble({
        side: 'char', text: out.text, name: profile.name,
        avatarNode: H.avatar(profile.avatar, profile.name, 30)
      }));
      Stage.setEmotion(out.emotion);

      if (res.gated) UI.offerGate(arc, body, optsHost, winCard, res);
      else if (res.tierUp) UI.announceTier(body);

      Gen.persistMemory(arc, node).catch(function () { });
      UI._busy = false;
    },

    /** 反向模式：Char 自主选择 */
    resolveReverseChoice: async function (arc, node, body, optsHost, winCard) {
      if (UI._busy) return;
      UI._busy = true;
      optsHost.innerHTML = '';
      optsHost.appendChild(H.loading('TA 正在做决定…'));

      var decided = await Gen.charDecide(node);
      var profile = await K.charProfile();
      var chosen = (node.options || [])[decided.choiceIndex];

      winCard._hasOptions = false;
      optsHost.innerHTML = '';
      Arc.recordChoice(arc, node, chosen || { id: 'auto', text: '（未选）' });

      // 结算：Char 的选择影响 User 对 Char 的裁定 + 好感
      if (chosen) {
        K.nudgeVerdict(chosen.verdictDelta || 0, { note: 'TA 的自主选择' });
        K.addAffinity(chosen.affinityDelta || 0, { reason: 'TA 的选择：' + U.cut(chosen.text, 14) });
      }

      var pickBox = H.el('div');
      pickBox.style.cssText = 'border-radius:15px; padding:11px 12px; margin-bottom:9px;'
        + 'background:linear-gradient(150deg,#F3EEFF,#FFEBF3); border:1.3px solid rgba(183,158,220,0.4);';
      pickBox.innerHTML = '<div style="font-size:10px; letter-spacing:.14em; color:#7d63a8; font-weight:800;'
        + 'margin-bottom:6px;">TA 的选择</div>'
        + '<div style="font-size:12.2px; color:#553f4c; line-height:1.7;">'
        + U.esc(chosen ? chosen.text : '（TA 沉默了）') + '</div>'
        + (decided.reason ? '<div style="font-size:10.6px; color:#8b8292; margin-top:8px; line-height:1.7;'
          + 'font-style:italic;">内心独白：' + U.esc(decided.reason) + '</div>' : '');
      body.appendChild(pickBox);

      var text = chosen && chosen.result ? chosen.result : '';
      if (!text) {
        var prompt = await Gen.baseSystem(
          '你在扮演 ' + profile.name + '（玩家视角）。\n'
          + '局面前提：' + U.cut(node.text, 200) + '\n'
          + '你刚刚选择了：「' + (chosen ? chosen.text : '沉默') + '」\n'
          + '你的内心独白：' + decided.reason + '\n\n'
          + '请写你做出这个选择之后的场面与你说出口的话，70~130 字，第一人称，'
          + '带一点玩家特有的情绪（讨好 / 逞强 / 破防 / 占有欲）。不要旁白腔。'
        );
        text = await K.ask(prompt, { temperature: 0.95 });
        if (!text) text = '他做了这个选择，然后看着你，等你给一个反应。';
      }
      body.appendChild(H.bubble({
        side: 'char', text: String(text).trim(), name: profile.name,
        avatarNode: H.avatar(profile.avatar, profile.name, 30)
      }));
      Stage.setEmotion(decided.emotion);

      Gen.persistMemory(arc, node).catch(function () { });
      UI._busy = false;
    },

    /** 晋阶任务：满槽时解锁下一阶梯 */
    offerGate: function (arc, body, optsHost, winCard, res) {
      var tier = K.tier();
      var card = H.el('div');
      card.style.cssText = 'margin-top:11px; border-radius:16px; padding:13px; text-align:center;'
        + 'background:linear-gradient(150deg,#FFF1F7,#F3EEFF); border:1.4px solid rgba(217,127,168,0.45);'
        + 'box-shadow:0 10px 26px rgba(217,127,168,0.18);';
      card.innerHTML = '<div style="font-size:12.5px; font-weight:900; color:#B0728F;">'
        + '「' + tier.name + '」的经验槽已经满了</div>'
        + '<div style="font-size:10.8px; color:#9a8f9e; margin-top:6px; line-height:1.7;">'
        + '完成一次晋阶任务，就能推开下一阶梯的门。</div>';
      var b = H.button('完成晋阶任务', { kind: 'primary', block: true, icon: 'key' });
      b.style.marginTop = '11px';
      b.onclick = async function () {
        var prompt = await Gen.baseSystem(
          '当前关系阶段是「' + tier.name + '」，经验槽已满，需要一次「晋阶任务」来推进关系。\n'
          + '请设计一个简短有力、只属于你们两人的晋阶任务（20~40 字），'
          + '要求是一个具体动作或一次坦白，而不是抽象的承诺。\n'
          + '直接输出任务描述，不要任何其它内容。'
        );
        var task = await K.ask(prompt, { temperature: 0.95 });
        if (!task) task = '当面把「我在意你」这四个字说清楚，不许用玩笑带过。';
        var ok = await H.confirm({
          title: '晋阶任务',
          icon: 'key', accent: '#B79EDC', soft: '#F3EEFF',
          message: String(task).trim() + '\n\n完成它，关系会推进到下一阶梯。',
          okText: '我完成了'
        });
        if (!ok) return;
        K.completeGate(tier.key);
        var t2 = K.tier();
        H.modal({
          title: '阶梯推进',
          icon: 'sparkle', accent: t2.color, soft: '#FFEBF3',
          message: '你们的关系进入了「' + t2.name + '」。\n\n' + t2.desc
        });
        UI.announceTier(body);
      };
      card.appendChild(b);
      body.appendChild(card);
    },

    announceTier: function (body) {
      var tier = K.tier();
      var banner = H.el('div');
      banner.style.cssText = 'margin-top:11px; border-radius:16px; padding:13px; text-align:center;'
        + 'background:linear-gradient(150deg,' + tier.color + '22, rgba(255,255,255,0.9));'
        + 'border:1.4px solid ' + tier.color + '66; animation:hg-rise .5s cubic-bezier(.22,1,.36,1) both;';
      banner.innerHTML = '<div style="font-size:12.5px; font-weight:900; color:' + tier.color + ';">'
        + '阶梯推进 · ' + tier.name + '</div>'
        + '<div style="font-size:10.8px; color:#9a8f9e; margin-top:6px; line-height:1.7;">' + tier.desc + '</div>';
      body.appendChild(banner);
    },

    /** 篇章收束 */
    finishArc: function (arc, inner, body, optsHost, winCard, exitFn) {
      winCard._hasOptions = false;
      body.innerHTML = '';
      optsHost.innerHTML = '';
      var tier = K.tier();
      var box = H.el('div');
      box.style.cssText = 'text-align:center; padding:8px 4px 2px;';
      box.innerHTML = '<div style="font-size:13px; font-weight:900; color:#B0728F; margin-bottom:8px;">'
        + '「' + U.esc(arc.title) + '」完结</div>'
        + '<div style="font-size:10.8px; color:#9a8f9e; line-height:1.76;">'
        + (arc.synopsis ? U.esc(arc.synopsis) + '<br>' : '')
        + '当前阶段：' + tier.name + ' · 好感 ' + U.comma(K.state.affinity) + '</div>';
      body.appendChild(box);

      var b1 = H.button('把这段写进记忆回廊', { kind: 'primary', block: true, icon: 'heart' });
      b1.style.marginTop = '12px';
      b1.onclick = function () {
        var quotes = (arc.nodes || []).slice(-3).map(function (n) { return U.cut(n.text, 60); });
        K.addMemory({
          title: arc.title,
          summary: arc.synopsis || ('一段走到了结尾的剧情 · ' + arc.nodes.length + ' 个节点'),
          quotes: quotes,
          source: 'story',
          tags: ['主线', tier.name]
        });
        H.toast('已存入记忆回廊');
        Gen.persistMemory(arc, null).catch(function () { });
      };
      body.appendChild(b1);

      var b2 = H.button('返回篇章列表', { kind: 'soft', block: true, icon: 'book', soft: '#F3EEFF', color: '#7d63a8' });
      b2.style.marginTop = '8px';
      b2.onclick = function () { exitFn(); setTimeout(function () { UI.openArcList(); }, 320); };
      body.appendChild(b2);
    },

    /** 分支树可视化 + 回溯 */
    openBranchTree: function (arc) {
      var a = arc || Arc.active();
      var st = K.state;
      var body = H.el('div');
      if (!a) { body.appendChild(H.empty('先开启一个篇章', { icon: 'branch' })); return H.sheet({ title: '分支树', content: body }); }

      var mine = (st.story.branches || []).filter(function (b) { return b.arcId === a.id; });
      var info = H.el('div');
      info.style.cssText = 'font-size:10.8px; color:#8b8292; line-height:1.72; margin-bottom:12px;'
        + 'background:rgba(255,255,255,0.72); border-radius:13px; padding:11px 12px;';
      info.innerHTML = '「' + U.esc(a.title) + '」共 ' + a.nodes.length + ' 个节点，'
        + '当前停在第 ' + (U.int(a.nodeIndex, 0) + 1) + ' 个。<br>'
        + '已记录 ' + mine.length + ' 次选择，' + (a.saves || []).length + ' 个存档点。';
      body.appendChild(info);

      // 节点主干
      body.appendChild(H.sectionTitle('节点主干', { color: '#D97FA8' }));
      var rail = H.el('div');
      rail.style.cssText = 'position:relative; padding-left:20px; margin-bottom:14px;';
      var line = H.el('div');
      line.style.cssText = 'position:absolute; left:6px; top:6px; bottom:6px; width:2px;'
        + 'background:linear-gradient(180deg,#D97FA8,#B79EDC);border-radius:2px; opacity:.35;';
      rail.appendChild(line);
      (a.nodes || []).forEach(function (n, i) {
        var here = i === U.int(a.nodeIndex, 0);
        var past = i < U.int(a.nodeIndex, 0);
        var dot = H.el('div');
        dot.style.cssText = 'position:relative; margin-bottom:9px; padding:8px 11px; border-radius:12px;'
          + 'cursor:pointer; transition:all .2s ease;'
          + (here ? 'background:linear-gradient(135deg,#FFF1F7,#F3EEFF); border:1.3px solid rgba(217,127,168,0.6);'
            : 'background:rgba(255,255,255,0.66); border:1px solid rgba(190,180,195,0.22);')
          + (past ? ' opacity:.72;' : '');
        dot.innerHTML = '<div style="display:flex; align-items:center; gap:6px;">'
          + '<span style="font-size:9.6px; font-weight:900; color:' + (here ? '#D97FA8' : '#a99fae') + ';">'
          + ('0' + (i + 1)).slice(-2) + '</span>'
          + '<span style="font-size:11.4px; font-weight:700; color:#5c4450;">' + U.esc(n.title) + '</span>'
          + (here ? '<span style="font-size:9px; font-weight:900; color:#fff; background:#D97FA8;'
            + 'padding:1px 6px; border-radius:7px; margin-left:auto;">当前</span>' : '')
          + '</div>'
          + '<div style="font-size:10px; color:#a99fae; margin-top:3px; white-space:nowrap; overflow:hidden;'
          + 'text-overflow:ellipsis;">' + U.esc(U.cut(n.text, 34)) + '</div>';
        dot.onclick = function () {
          a.nodeIndex = i;
          a.status = 'playing';
          K.save(true);
          H.toast('已回到节点：' + n.title);
        };
        rail.appendChild(dot);
      });
      body.appendChild(rail);

      // 选择记录
      body.appendChild(H.sectionTitle('选择记录（点任意一条回溯）', { color: '#B79EDC' }));
      if (!mine.length) body.appendChild(H.empty('还没有记录到选择。', { icon: 'branch' }));
      mine.slice().reverse().forEach(function (b) {
        var row = H.listRow({
          icon: 'branch', color: '#B79EDC', soft: '#F3EEFF',
          title: b.choiceText || '（自由行动）',
          subtitle: (b.nodeTitle || '') + ' · 好感 ' + (b.affinityDelta >= 0 ? '+' : '') + b.affinityDelta
            + (b.verdictDelta ? ' · 裁定 ' + (b.verdictDelta >= 0 ? '+' : '') + b.verdictDelta : '')
            + ' · ' + U.timeAgo(b.at),
          subtitleWrap: true,
          rightNode: H.button('回溯', { kind: 'soft', pad: '5px 10px', size: 10.4, soft: '#F3EEFF', color: '#7d63a8' })
        });
        row.onclick = function () {
          if (!Arc.rewindTo(b.id)) { H.toast('回溯失败'); return; }
          H.toast('已回溯到该选择点');
          H.closeAllLayers();
          UI.play(Arc.byId(b.arcId));
        };
        body.appendChild(row);
      });

      // 存档点
      body.appendChild(H.sectionTitle('存档点', { color: '#7E97C9' }));
      var saveNow = H.button('存一个新档', { kind: 'primary', block: true, icon: 'save' });
      saveNow.onclick = function () {
        var snap = Arc.save(a);
        H.toast(snap ? '已存档：' + snap.label : '存档失败');
        H.closeAllLayers();
        UI.openBranchTree(a);
      };
      body.appendChild(saveNow);
      (a.saves || []).forEach(function (s) {
        var row = H.listRow({
          icon: 'save', color: '#7E97C9', soft: '#EDF2FB',
          title: s.label,
          subtitle: '节点 ' + (U.int(s.nodeIndex, 0) + 1) + ' · 好感 ' + U.comma(s.affinity) + ' · ' + U.timeFull(s.at),
          subtitleWrap: true,
          rightNode: H.button('读取', { kind: 'soft', pad: '5px 10px', size: 10.4, soft: '#EDF2FB', color: '#5f7aa8' })
        });
        row.onclick = function () {
          if (!Arc.load(a, s.id)) { H.toast('读档失败'); return; }
          H.toast('已回到存档点');
          H.closeAllLayers();
          UI.play(a);
        };
        body.appendChild(row);
      });

      H.sheet({
        title: '分支树与存档',
        subtitle: a.title,
        icon: 'branch',
        height: '92%',
        slot: 'story-tree',
        content: body,
        buttons: [{
          text: '回到这一章', icon: 'play', kind: 'primary',
          onClick: function () { H.closeAllLayers(); UI.play(a); }
        }]
      });
    }
  };

  HG.Story = {
    Arc: Arc,
    Gen: Gen,
    SubPhone: SubPhone,
    Stage: Stage,
    UI: UI,
    Script: Script,
    open: function () { UI.openArcList(); }
  };
})();
