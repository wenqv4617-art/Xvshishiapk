/**
 * app_ritual.js - 仪轨（日程 / 穿着 / 随身物品 / 位置 四维状态）
 * ------------------------------------------------------------
 * 设计取向（参考现代极简日历：Dawn、Clendar、Untitled UI Calendar、iOS 18 日历）：
 *   · 大标题 + 弱化网格线，靠留白与字重分层，而不是靠边框和底色块
 *   · 月历格用「圆点」表示"这天有内容"，选中用实心圆、今天用描边圈
 *   · 下方是当天的 Agenda（四维卡片），信息密度低、可点开看全文
 *   · 所有弹层都是自制底部抽屉 / 卡片，图标全部通用路径 SVG，无 emoji
 *
 * 数据：db.ritual_states（每人每天一条，四维 + 备注），char 由 API 推演，user 可自建或推演。
 * 依赖：window.apiRoutes.resolve('ritual') 取 API 预设；db.archives / db.sessions 取人物。
 */
(function () {
  'use strict';

  var LS_SUBJECT = 'yigui-subject';   // 记住上次看的人： "user:7" / "char:100"
  var LS_VIEW = 'yigui-view-mode';    // month | week（预留）

  var state = {
    inited: false,
    subject: null,          // {type,id,name,avatar,persona,sessionId}
    subjectList: [],        // [{type,id,name,avatar,persona,sessionId}]
    viewYear: 0,
    viewMonth: 0,           // 0-11
    selectedDate: '',       // YYYY-MM-DD
    currentState: null,     // 当前选中日的 ritual_states 记录
    loading: false,
    monthIndex: {}          // date -> true（该月哪些天有内容）
  };

  // ==================== 通用小工具 ====================
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function svg(path, size, color) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="' + (color || 'currentColor') +
      '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  var ICO = {
    chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
    chevronRight: '<path d="M9 18l6-6-6-6"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>',
    shirt: '<path d="M16 3l4 2-2 4-1-.5V21H7V8.5L6 9 4 5l4-2 2 2h4z"/>',
    bag: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2M9 12h6"/>',
    pin: '<path d="M12 21s-7-5.2-7-11a7 7 0 1 1 14 0c0 5.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    note: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
  };

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return dateStr(new Date()); }
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  function weekOf(ds) { try { return WEEK[new Date(ds + 'T00:00:00').getDay()]; } catch (e) { return ''; } }
  function prettyDate(ds) {
    var p = String(ds).split('-');
    return p[1] ? (Number(p[1]) + '月' + Number(p[2]) + '日') : ds;
  }
  function myMeId() {
    var v = parseInt(localStorage.getItem('active_me_id'), 10);
    return isNaN(v) ? 0 : v;
  }
  function subjKey(s) { return s ? (s.type + ':' + s.id) : ''; }

  function toast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
    else console.log('[仪轨]', msg);
  }

  // ==================== 人物列表 ====================
  async function loadSubjects() {
    var list = [];
    var meId = myMeId();
    // 当前 user 人设置顶
    try {
      var me = meId ? await db.archives.get(Number(meId)) : null;
      if (me) {
        list.push({ type: 'user', id: Number(me.id), name: me.name || '我', avatar: me.avatar || '', persona: me.persona || '', meId: meId });
      }
    } catch (e) {}
    // 已建立单聊的角色
    try {
      var sess = await db.sessions.where('userId').equals(Number(meId)).toArray();
      for (var i = 0; i < sess.length; i++) {
        var s = sess[i];
        if (s.isGroup === 1) continue;
        var c = await db.archives.get(Number(s.charId));
        var name = s.customCharName || (c && c.name) || '角色';
        if (list.some(function (x) { return x.type === 'char' && x.id === Number(s.charId); })) continue;
        list.push({
          type: 'char', id: Number(s.charId), name: name,
          avatar: s.customCharAvatar || (c && c.avatar) || '',
          persona: s.customCharPersona || (c && c.persona) || '',
          sessionId: s.id, meId: meId
        });
      }
    } catch (e) {}
    state.subjectList = list;
    return list;
  }

  function resolveAvatarUrl(av, name) {
    try { if (typeof resolveAvatar === 'function') return resolveAvatar(av, name); } catch (e) {}
    if (typeof av === 'string' && av) return av;
    var ch = String(name || '?').slice(0, 1);
    return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#e2e8f0"/><text x="50" y="64" font-size="44" text-anchor="middle" fill="#94a3b8" font-family="sans-serif">' + ch + '</text></svg>');
  }

  async function pickSubject() {
    var list = state.subjectList.length ? state.subjectList : await loadSubjects();
    if (!list.length) { toast('还没有可用的人物，先去聊天里建一个单聊吧'); return; }
    var last = localStorage.getItem(LS_SUBJECT) || '';
    var rows = list.map(function (s) {
      var k = subjKey(s);
      var active = last === k;
      return '<div class="yg-sheet-row" data-k="' + k + '" style="display:flex;align-items:center;gap:11px;padding:11px 14px;cursor:pointer;' +
        (active ? 'background:rgba(30,136,229,0.06);' : '') + '">' +
        '<img src="' + esc(resolveAvatarUrl(s.avatar, s.name)) + '" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:13.5px;font-weight:700;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(s.name) +
            (s.type === 'user' ? '<span style="margin-left:6px;font-size:9.5px;font-weight:700;color:#1e88e5;background:rgba(30,136,229,0.10);padding:1px 6px;border-radius:5px;">我</span>' : '') +
          '</div>' +
          '<div style="font-size:10.5px;color:#94a3b8;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
            esc(String(s.persona || '').replace(/\s+/g, ' ').slice(0, 30) || '暂无设定') + '</div>' +
        '</div>' +
        (active ? '<span style="display:flex;color:#1e88e5;flex-shrink:0;">' + svg(ICO.check, 16, '#1e88e5') + '</span>' : '') +
      '</div>';
    }).join('');

    var el = sheet({
      title: '切换人物',
      icon: ICO.user,
      body: '<div style="margin:-6px -14px;">' + rows + '</div>'
    });
    el.querySelectorAll('.yg-sheet-row').forEach(function (r) {
      r.onclick = async function () {
        var k = r.getAttribute('data-k');
        var found = state.subjectList.filter(function (s) { return subjKey(s) === k; })[0];
        closeSheet(el);
        if (found) { await setSubject(found); }
      };
    });
  }

  async function setSubject(s) {
    state.subject = s;
    try { localStorage.setItem(LS_SUBJECT, subjKey(s)); } catch (e) {}
    renderHeader();
    await refreshMonth();
    await renderDay();
  }

  // ==================== 底部抽屉 / 卡片（自制，无原生弹窗） ====================
  function sheet(opts) {
    var el = document.createElement('div');
    el.className = 'yg-sheet-mask';
    el.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:100700;display:flex;align-items:flex-end;justify-content:center;' +
      'background:rgba(15,23,42,0.42);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);';
    el.innerHTML =
      '<div class="yg-sheet-card" style="width:100%;max-width:440px;max-height:84vh;overflow-y:auto;background:#fff;border-radius:20px 20px 0 0;' +
        'padding:16px 14px 26px;box-sizing:border-box;animation:ygUp .22s cubic-bezier(.2,.8,.25,1);">' +
        '<div style="width:36px;height:4px;border-radius:99px;background:#e2e8f0;margin:0 auto 14px;"></div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:0 2px;margin-bottom:12px;">' +
          '<span style="display:flex;color:#1e88e5;">' + svg(opts.icon || ICO.note, 17, '#1e88e5') + '</span>' +
          '<div style="flex:1;font-size:15px;font-weight:800;color:#1e293b;">' + esc(opts.title || '') + '</div>' +
          '<button class="yg-sheet-close" style="border:none;background:#f1f5f9;border-radius:9px;padding:6px 9px;color:#64748b;cursor:pointer;display:flex;">' +
            svg(ICO.close, 13, '#64748b') + '</button>' +
        '</div>' +
        '<div class="yg-sheet-body">' + (opts.body || '') + '</div>' +
      '</div>';
    if (!document.getElementById('ygAnimKey')) {
      var st = document.createElement('style');
      st.id = 'ygAnimKey';
      st.textContent = '@keyframes ygUp{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}@keyframes ygFade{from{opacity:0}to{opacity:1}}';
      document.head.appendChild(st);
    }
    document.body.appendChild(el);
    el.querySelector('.yg-sheet-close').onclick = function () { closeSheet(el); };
    el.onclick = function (e) { if (e.target === el) closeSheet(el); };
    return el;
  }
  function closeSheet(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

  function confirmCard(opts) {
    return new Promise(function (resolve) {
      var el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:100800;display:flex;align-items:center;justify-content:center;' +
        'padding:24px;box-sizing:border-box;background:rgba(15,23,42,0.46);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);';
      el.innerHTML =
        '<div style="width:100%;max-width:320px;background:#fff;border-radius:20px;padding:20px;box-sizing:border-box;box-shadow:0 24px 60px rgba(15,23,42,0.28);animation:ygFade .18s ease-out;">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
            '<span style="display:flex;color:' + (opts.danger ? '#ef4444' : '#1e88e5') + ';">' + svg(opts.icon || ICO.spark, 18, opts.danger ? '#ef4444' : '#1e88e5') + '</span>' +
            '<div style="font-size:15px;font-weight:800;color:#1e293b;">' + esc(opts.title || '') + '</div>' +
          '</div>' +
          '<div style="font-size:12.5px;line-height:1.7;color:#475569;white-space:pre-wrap;">' + esc(opts.message || '') + '</div>' +
          '<div style="display:flex;gap:8px;margin-top:18px;">' +
            '<button data-v="0" style="flex:1;padding:11px;border-radius:12px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;">取消</button>' +
            '<button data-v="1" style="flex:1;padding:11px;border-radius:12px;border:none;font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;' +
              (opts.danger ? 'background:#ef4444;color:#fff;' : 'background:#1e88e5;color:#fff;') + '">' + esc(opts.okText || '确定') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(el);
      el.querySelectorAll('button[data-v]').forEach(function (b) {
        b.onclick = function () { el.remove(); resolve(b.getAttribute('data-v') === '1'); };
      });
      el.onclick = function (e) { if (e.target === el) { el.remove(); resolve(false); } };
    });
  }

  // ==================== 头部 / 月份导航 ====================
  function renderHeader() {
    var chip = document.getElementById('yigui-subject-chip');
    if (!chip || !state.subject) return;
    var s = state.subject;
    chip.innerHTML =
      '<img src="' + esc(resolveAvatarUrl(s.avatar, s.name)) + '" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;">' +
      '<span style="font-size:12.5px;font-weight:700;color:#1e293b;max-width:84px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(s.name) + '</span>' +
      '<span style="display:flex;color:#94a3b8;flex-shrink:0;">' + svg(ICO.chevronDown, 13, '#94a3b8') + '</span>';
  }

  function renderMonthBar() {
    var now = new Date();
    var isCur = state.viewYear === now.getFullYear() && state.viewMonth === now.getMonth();
    var el = document.getElementById('yigui-month-title');
    if (el) el.innerHTML = state.viewYear + '年' + (state.viewMonth + 1) + '月' +
      (isCur ? '' : '<span id="yigui-back-today" style="margin-left:8px;font-size:11px;font-weight:700;color:#1e88e5;cursor:pointer;vertical-align:middle;">回到今天</span>');
    var back = document.getElementById('yigui-back-today');
    if (back) back.onclick = function () { state.selectedDate = todayStr(); var d = new Date(); state.viewYear = d.getFullYear(); state.viewMonth = d.getMonth(); refreshMonth().then(renderDay); };
  }

  // ==================== 月历 ====================
  async function refreshMonth() {
    var first = new Date(state.viewYear, state.viewMonth, 1);
    var last = new Date(state.viewYear, state.viewMonth + 1, 0);
    var from = dateStr(first), to = dateStr(last);
    state.monthIndex = {};
    if (state.subject) {
      try {
        var rows = await db.ritual_states
          .where('[subjectType+subjectId+date]')
          .between([state.subject.type, Number(state.subject.id), from], [state.subject.type, Number(state.subject.id), to], true, true)
          .toArray();
        rows.forEach(function (r) { state.monthIndex[r.date] = true; });
      } catch (e) {
        try {
          var all = await db.ritual_states.toArray();
          all.forEach(function (r) {
            if (r.subjectType === state.subject.type && Number(r.subjectId) === Number(state.subject.id) && r.date >= from && r.date <= to) state.monthIndex[r.date] = true;
          });
        } catch (e2) {}
      }
    }
    renderMonthBar();
    renderGrid();
  }

  function renderGrid() {
    var grid = document.getElementById('yigui-grid');
    if (!grid) return;
    var first = new Date(state.viewYear, state.viewMonth, 1);
    var startPad = first.getDay();                    // 周日开头
    var daysInMonth = new Date(state.viewYear, state.viewMonth + 1, 0).getDate();
    var prevMonthDays = new Date(state.viewYear, state.viewMonth, 0).getDate();
    var today = todayStr();
    var cells = [];
    var total = Math.ceil((startPad + daysInMonth) / 7) * 7;
    for (var i = 0; i < total; i++) {
      var dayNum, ds, outside = false;
      if (i < startPad) {
        dayNum = prevMonthDays - startPad + i + 1; outside = true;
        ds = dateStr(new Date(state.viewYear, state.viewMonth - 1, dayNum));
      } else if (i >= startPad + daysInMonth) {
        dayNum = i - startPad - daysInMonth + 1; outside = true;
        ds = dateStr(new Date(state.viewYear, state.viewMonth + 1, dayNum));
      } else {
        dayNum = i - startPad + 1;
        ds = dateStr(new Date(state.viewYear, state.viewMonth, dayNum));
      }
      var isToday = ds === today;
      var isSel = ds === state.selectedDate;
      var hasData = !!state.monthIndex[ds];
      var bg = isSel ? '#1e88e5' : 'transparent';
      var color = isSel ? '#fff' : (outside ? '#cbd5e1' : (isToday ? '#1e88e5' : '#334155'));
      var weight = (isSel || isToday) ? 800 : 600;
      var ring = isToday && !isSel ? 'box-shadow:inset 0 0 0 1.5px rgba(30,136,229,0.45);' : '';
      cells.push(
        '<div class="yg-cell" data-d="' + ds + '" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:46px;cursor:pointer;">' +
          '<div style="width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
            'background:' + bg + ';' + ring + 'font-size:13px;font-weight:' + weight + ';color:' + color + ';transition:background .15s;">' + dayNum + '</div>' +
          '<div style="height:4px;display:flex;align-items:center;">' +
            (hasData ? '<span style="width:4px;height:4px;border-radius:50%;background:' + (isSel ? '#93c5fd' : '#1e88e5') + ';display:block;"></span>' : '') +
          '</div>' +
        '</div>'
      );
    }
    var head = WEEK.map(function (w) {
      return '<div style="text-align:center;font-size:10.5px;font-weight:700;color:#94a3b8;padding-bottom:6px;">' + w + '</div>';
    }).join('');
    grid.innerHTML =
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);">' + head + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(7,1fr);">' + cells.join('') + '</div>';
    grid.querySelectorAll('.yg-cell').forEach(function (c) {
      c.onclick = function () {
        state.selectedDate = c.getAttribute('data-d');
        renderGrid();
        renderDay();
      };
    });
  }

  // ==================== 当日四维 ====================
  function cardHtml(icon, label, bodyHtml, hint) {
    return '<div class="yg-card" style="background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:12px 13px;box-sizing:border-box;">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:7px;">' +
        '<span style="display:flex;color:#1e88e5;">' + svg(icon, 14, '#1e88e5') + '</span>' +
        '<span style="font-size:11.5px;font-weight:800;color:#64748b;letter-spacing:.4px;">' + esc(label) + '</span>' +
      '</div>' +
      '<div style="font-size:12.5px;line-height:1.72;color:#334155;word-break:break-word;">' + bodyHtml + '</div>' +
      (hint ? '<div style="font-size:10.5px;color:#cbd5e1;margin-top:6px;">' + esc(hint) + '</div>' : '') +
    '</div>';
  }

  function scheduleHtml(list) {
    if (!list || !list.length) return '<span style="color:#cbd5e1;">今天还没有安排</span>';
    return list.map(function (it) {
      return '<div style="display:flex;gap:8px;margin-bottom:5px;">' +
        '<span style="flex-shrink:0;font-size:11px;font-weight:800;color:#1e88e5;min-width:44px;">' + esc(it.time || '') + '</span>' +
        '<span style="flex:1;min-width:0;">' + esc(it.content || '') + '</span></div>';
    }).join('');
  }

  function skeletonHtml() {
    var bar = '<div style="height:11px;border-radius:6px;background:linear-gradient(90deg,#f1f5f9,#e2e8f0,#f1f5f9);background-size:200% 100%;animation:ygShimmer 1.1s linear infinite;"></div>';
    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
      '<div style="grid-column:1 / -1;background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:13px;">' + bar + '<div style="height:6px;"></div>' + bar + '<div style="height:6px;"></div>' + bar + '</div>' +
      '<div style="background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:13px;">' + bar + '<div style="height:6px;"></div>' + bar + '</div>' +
      '<div style="background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:13px;">' + bar + '<div style="height:6px;"></div>' + bar + '</div>' +
    '</div>';
  }

  async function renderDay() {
    var box = document.getElementById('yigui-day');
    if (!box) return;
    var ds = state.selectedDate || todayStr();
    var headEl = document.getElementById('yigui-day-title');
    var isUser = state.subject && state.subject.type === 'user';
    var actionLabel = isUser ? '编辑' : '推演';
    var actionIcon = isUser ? ICO.edit : ICO.spark;
    if (headEl) {
      headEl.innerHTML =
        '<div style="display:flex;align-items:baseline;gap:7px;">' +
          '<span style="font-size:16px;font-weight:800;color:#1e293b;">' + prettyDate(ds) + '</span>' +
          '<span style="font-size:11.5px;color:#94a3b8;font-weight:600;">星期' + weekOf(ds) + '</span>' +
          (ds === todayStr() ? '<span style="font-size:9.5px;font-weight:800;color:#1e88e5;background:rgba(30,136,229,.10);padding:2px 6px;border-radius:6px;">今天</span>' : '') +
        '</div>' +
        '<button id="yigui-day-action" style="display:flex;align-items:center;gap:5px;padding:7px 11px;border:1.5px solid #e2e8f0;background:#fff;border-radius:10px;font-size:11.5px;font-weight:800;color:#475569;cursor:pointer;font-family:inherit;">' +
          svg(actionIcon, 13, '#475569') + actionLabel + '</button>';
      var btn = document.getElementById('yigui-day-action');
      if (btn) btn.onclick = function () { if (isUser) openEditor(ds); else generateState(ds); };
    }

    if (!state.subject) { box.innerHTML = '<div style="padding:24px 0;text-align:center;color:#94a3b8;font-size:12px;">请先选择人物</div>'; return; }
    if (state.loading) { box.innerHTML = skeletonHtml(); return; }

    var rec = null;
    try {
      var rows = await db.ritual_states
        .where('[subjectType+subjectId+date]')
        .equals([state.subject.type, Number(state.subject.id), ds]).toArray();
      rec = rows && rows[0];
    } catch (e) {
      try {
        var all = await db.ritual_states.toArray();
        rec = all.filter(function (r) { return r.subjectType === state.subject.type && Number(r.subjectId) === Number(state.subject.id) && r.date === ds; })[0];
      } catch (e2) {}
    }
    state.currentState = rec || null;

    if (!rec) {
      box.innerHTML =
        '<div style="background:#fff;border:1px dashed #e2e8f0;border-radius:16px;padding:26px 18px;text-align:center;">' +
          '<div style="display:flex;justify-content:center;color:#cbd5e1;margin-bottom:10px;">' + svg(ICO.calendar, 30, '#cbd5e1') + '</div>' +
          '<div style="font-size:12.5px;color:#94a3b8;line-height:1.7;margin-bottom:14px;">' +
            (isUser ? '这一天还没有记录。<br>可以自己写，也可以让 AI 按人设推演。' : '这一天还没有' + esc(state.subject.name) + '的状态记录。<br>让 AI 依据人设与剧情推演一下？') +
          '</div>' +
          '<div style="display:flex;gap:8px;justify-content:center;">' +
            '<button id="yg-empty-ai" style="display:flex;align-items:center;gap:6px;padding:10px 16px;border:none;background:#1e88e5;color:#fff;border-radius:11px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;">' +
              svg(ICO.spark, 13, '#fff') + 'AI 推演</button>' +
            '<button id="yg-empty-manual" style="display:flex;align-items:center;gap:6px;padding:10px 16px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;border-radius:11px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;">' +
              svg(ICO.edit, 13, '#475569') + '自己写</button>' +
          '</div>' +
        '</div>';
      var b1 = document.getElementById('yg-empty-ai'); if (b1) b1.onclick = function () { generateState(ds); };
      var b2 = document.getElementById('yg-empty-manual'); if (b2) b2.onclick = function () { openEditor(ds); };
      return;
    }

    var srcTag = rec.source === 'ai'
      ? '<span style="font-size:9.5px;font-weight:800;color:#1e88e5;background:rgba(30,136,229,.10);padding:2px 6px;border-radius:6px;">AI 推演</span>'
      : '<span style="font-size:9.5px;font-weight:800;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:6px;">手动填写</span>';
    box.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' + srcTag +
          '<span style="font-size:10.5px;color:#cbd5e1;">' + (rec.updatedAt ? new Date(rec.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '') + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button id="yg-edit-btn" style="display:flex;align-items:center;gap:4px;padding:6px 10px;border:1.5px solid #e2e8f0;background:#fff;border-radius:9px;font-size:11px;font-weight:700;color:#475569;cursor:pointer;font-family:inherit;">' + svg(ICO.edit, 12, '#475569') + '编辑</button>' +
          '<button id="yg-del-btn" style="display:flex;align-items:center;gap:4px;padding:6px 10px;border:1.5px solid #fecaca;background:#fff;border-radius:9px;font-size:11px;font-weight:700;color:#ef4444;cursor:pointer;font-family:inherit;">' + svg(ICO.trash, 12, '#ef4444') + '删除</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
        '<div style="grid-column:1 / -1;">' + cardHtml(ICO.clock, '今日日程', scheduleHtml(rec.schedule)) + '</div>' +
        cardHtml(ICO.shirt, '穿着', rec.attire ? esc(rec.attire) : '<span style="color:#cbd5e1;">未记录</span>') +
        cardHtml(ICO.bag, '随身物品', rec.belongings ? esc(rec.belongings) : '<span style="color:#cbd5e1;">未记录</span>') +
        '<div style="grid-column:1 / -1;">' + cardHtml(ICO.pin, '当前位置', rec.location ? esc(rec.location) : '<span style="color:#cbd5e1;">未记录</span>') + '</div>' +
        (rec.note ? '<div style="grid-column:1 / -1;">' + cardHtml(ICO.note, '备注', esc(rec.note)) + '</div>' : '') +
      '</div>';
    var eb = document.getElementById('yg-edit-btn'); if (eb) eb.onclick = function () { openEditor(ds); };
    var db2 = document.getElementById('yg-del-btn');
    if (db2) db2.onclick = async function () {
      var ok = await confirmCard({ title: '删除这条记录？', message: prettyDate(ds) + ' 的' + state.subject.name + '四维状态会被清除。', danger: true, okText: '删除', icon: ICO.trash });
      if (!ok) return;
      try { await db.ritual_states.delete(rec.id); } catch (e) {}
      toast('已删除');
      await refreshMonth();
      await renderDay();
    };
  }

  // ==================== 生成（API） ====================
  async function buildPromptContext(s) {
    var lines = [];
    lines.push('你要推演的人是：' + s.name + '（' + (s.type === 'user' ? '用户本人' : '角色') + '）');
    if (s.persona) lines.push('人设：' + String(s.persona).slice(0, 1200));
    // 关系
    try {
      if (typeof queryRelationship === 'function' && s.sessionId) {
        var sess = await db.sessions.get(Number(s.sessionId));
        if (sess) {
          var rel = await queryRelationship(Number(sess.userId), Number(sess.charId), sess.customUserName || '我', s.name);
          if (rel) lines.push(rel);
        }
      }
    } catch (e) {}
    // 最近对话 + 总结 + 核心记忆
    if (s.sessionId) {
      try {
        var msgs = await db.messages.where('sessionId').equals(Number(s.sessionId)).reverse().limit(12).toArray();
        msgs.reverse();
        if (msgs.length) {
          lines.push('最近的对话（越靠后越新）：');
          msgs.forEach(function (m) {
            var who = m.senderType === 'user' ? '我' : (m.senderType === 'char' ? s.name : '系统');
            var c = m.contentType === 'image' ? '[图片]' : (m.contentType === 'voice' ? '[语音]' : String(m.content || ''));
            lines.push('- ' + who + '：' + String(c).slice(0, 120));
          });
        }
      } catch (e) {}
      try {
        var sum = await db.summaries.where('sessionId').equals(Number(s.sessionId)).reverse().first();
        if (sum && sum.content) lines.push('最近的剧情总结：' + String(sum.content).slice(0, 600));
      } catch (e) {}
      try {
        var sess2 = await db.sessions.get(Number(s.sessionId));
        if (sess2) {
          var core = [];
          if (sess2.coreSelfStatus) core.push('我的现状：' + sess2.coreSelfStatus);
          if (sess2.coreRelationship) core.push('我们的关系：' + sess2.coreRelationship);
          if (sess2.coreUserInEyes) core.push('我眼中的对方：' + sess2.coreUserInEyes);
          if (core.length) lines.push('核心记忆：\n' + core.join('\n'));
        }
      } catch (e) {}
    }
    return lines.join('\n');
  }

  async function callAI(systemPrompt, userPrompt) {
    var api = null;
    if (window.apiRoutes && typeof window.apiRoutes.resolve === 'function') api = await window.apiRoutes.resolve('ritual');
    if (!api) throw new Error('未配置 API 预设（设置 - API 协议设置）');
    var body = {
      model: api.model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.85
    };
    var res;
    try {
      res = await fetch(String(api.url).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api.key },
        body: JSON.stringify(body)
      });
    } catch (netErr) {
      try { if (typeof window.fwTrackError === 'function') window.fwTrackError(netErr); } catch (e) {}
      throw netErr;
    }
    if (!res.ok) throw new Error('API HTTP ' + res.status);
    var j = await res.json();
    try { if (j && j.usage && typeof window.fwTrackUsage === 'function') window.fwTrackUsage(j.usage, body.model); } catch (e) {}
    return String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
  }

  function parseJsonLoose(text) {
    var s = String(text || '').replace(/```json/gi, '```').trim();
    var fence = s.match(/```([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    try { return JSON.parse(s); } catch (e) {}
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e2) {} }
    return null;
  }

  async function generateState(ds) {
    if (state.loading) return;
    var s = state.subject;
    if (!s) return;
    state.loading = true;
    await renderDay();
    try {
      var ctx = await buildPromptContext(s);
      var dateCn = prettyDate(ds) + '（星期' + weekOf(ds) + '）';
      var sys = '你是一个生活状态推演器。你只输出 JSON，不输出任何解释、Markdown 或 emoji。';
      var usr = ctx + '\n\n今天是 ' + dateCn + '。\n' +
        '请推演' + s.name + '这一天的真实生活状态，必须严格符合上面的人设、关系与最近的剧情走向。\n' +
        '只输出这个 JSON：\n' +
        '{"schedule":[{"time":"07:30","content":"起床、洗漱" }],"attire":"今天穿什么（含颜色/材质/配饰，具体）","belongings":"随身带了什么（3-6 样，具体）","location":"此刻在哪里（具体地点 + 一句环境描写）","note":"一句话心情或小插曲"}\n' +
        '要求：\n' +
        '1) schedule 给 5-7 条，时间从早到晚，内容具体、有生活质感，能体现人设；\n' +
        '2) attire / belongings / location 要具体到能想象出画面，不要空泛；\n' +
        '3) 全部用中文，不要 emoji，不要括号动作描写。';
      var raw = await callAI(sys, usr);
      var parsed = parseJsonLoose(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('模型没有返回可解析的 JSON');
      var schedule = Array.isArray(parsed.schedule) ? parsed.schedule.map(function (it) {
        return { time: String((it && it.time) || '').slice(0, 12), content: String((it && it.content) || '').slice(0, 200) };
      }).filter(function (it) { return it.content; }).slice(0, 10) : [];
      var rec = {
        meId: myMeId(),
        subjectType: s.type,
        subjectId: Number(s.id),
        date: ds,
        schedule: schedule,
        attire: String(parsed.attire || '').slice(0, 600),
        belongings: String(parsed.belongings || '').slice(0, 600),
        location: String(parsed.location || '').slice(0, 400),
        note: String(parsed.note || '').slice(0, 300),
        source: 'ai',
        updatedAt: Date.now()
      };
      await saveState(rec);
      toast(s.name + ' 的 ' + prettyDate(ds) + ' 已推演');
    } catch (e) {
      console.warn('[仪轨] 推演失败:', e);
      await confirmCard({ title: '推演失败', message: (e && e.message) || String(e), icon: ICO.spark });
    } finally {
      state.loading = false;
      await refreshMonth();
      await renderDay();
    }
  }

  async function saveState(rec) {
    var rows = [];
    try {
      rows = await db.ritual_states.where('[subjectType+subjectId+date]').equals([rec.subjectType, Number(rec.subjectId), rec.date]).toArray();
    } catch (e) {
      try {
        var all = await db.ritual_states.toArray();
        rows = all.filter(function (r) { return r.subjectType === rec.subjectType && Number(r.subjectId) === Number(rec.subjectId) && r.date === rec.date; });
      } catch (e2) {}
    }
    if (rows && rows.length) {
      rec.id = rows[0].id;
      await db.ritual_states.put(rec);
    } else {
      await db.ritual_states.add(rec);
    }
  }

  // ==================== 手动编辑 ====================
  function openEditor(ds) {
    var s = state.subject;
    if (!s) return;
    var rec = state.currentState || {};
    var scheduleText = (rec.schedule || []).map(function (it) { return (it.time || '') + ' ' + (it.content || ''); }).join('\n');
    var field = function (label, id, val, ph, rows) {
      return '<div style="margin-bottom:12px;">' +
        '<div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">' + label + '</div>' +
        (rows
          ? '<textarea id="' + id + '" rows="' + rows + '" placeholder="' + esc(ph) + '" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:9px 11px;font-size:12.5px;line-height:1.6;color:#334155;resize:vertical;font-family:inherit;outline:none;">' + esc(val) + '</textarea>'
          : '<input id="' + id + '" value="' + esc(val) + '" placeholder="' + esc(ph) + '" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:9px 11px;font-size:12.5px;color:#334155;font-family:inherit;outline:none;">') +
      '</div>';
    };
    var el = sheet({
      title: prettyDate(ds) + ' · ' + s.name,
      icon: ICO.edit,
      body:
        field('今日日程（一行一条，格式：时间 内容）', 'yg-f-schedule', scheduleText, '08:00 起床洗漱', 5) +
        field('穿着', 'yg-f-attire', rec.attire || '', '例如：米白色针织衫 + 深色阔腿裤，左手戴银色手表', 2) +
        field('随身物品', 'yg-f-belongings', rec.belongings || '', '例如：手机、钥匙、帆布包、一盒薄荷糖', 2) +
        field('当前位置', 'yg-f-location', rec.location || '', '例如：公司 12 楼靠窗的工位，窗外在下小雨', 2) +
        field('备注 / 心情', 'yg-f-note', rec.note || '', '可选', 2) +
        '<div style="display:flex;gap:8px;margin-top:6px;">' +
          '<button id="yg-f-ai" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border:1.5px solid #e2e8f0;background:#fff;border-radius:12px;font-size:12.5px;font-weight:800;color:#475569;cursor:pointer;font-family:inherit;">' + svg(ICO.spark, 14, '#475569') + '让 AI 重写</button>' +
          '<button id="yg-f-save" style="flex:1.2;padding:12px;border:none;background:#1e88e5;border-radius:12px;font-size:12.5px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;">保存</button>' +
        '</div>'
    });
    var q = function (id) { var e = el.querySelector('#' + id); return e ? e.value.trim() : ''; };
    el.querySelector('#yg-f-save').onclick = async function () {
      var lines = q('yg-f-schedule').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      var schedule = lines.map(function (l) {
        var m = l.match(/^(\d{1,2}[:：]\d{2})\s*(.*)$/);
        return m ? { time: m[1].replace('：', ':'), content: m[2] } : { time: '', content: l };
      });
      var rec = {
        meId: myMeId(),
        subjectType: s.type, subjectId: Number(s.id), date: ds,
        schedule: schedule,
        attire: q('yg-f-attire').slice(0, 600),
        belongings: q('yg-f-belongings').slice(0, 600),
        location: q('yg-f-location').slice(0, 400),
        note: q('yg-f-note').slice(0, 300),
        source: 'manual', updatedAt: Date.now()
      };
      if (state.currentState && state.currentState.id) rec.id = state.currentState.id;
      try { await saveState(rec); } catch (e) { await confirmCard({ title: '保存失败', message: e.message }); return; }
      closeSheet(el);
      toast('已保存');
      await refreshMonth();
      await renderDay();
    };
    el.querySelector('#yg-f-ai').onclick = function () { closeSheet(el); generateState(ds); };
  }

  // ==================== 对话上下文注入 ====================
  /** 给 app_prompts.js 调用：返回该会话 char 与 user 当天的四维状态段落 */
  async function buildPromptSegment(sess) {
    try {
      if (!sess) return '';
      var ds = todayStr();
      var out = [];
      var pairs = [
        { type: 'char', id: Number(sess.charId), name: sess.customCharName || '对方' },
        { type: 'user', id: Number(sess.userId), name: sess.customUserName || '我' }
      ];
      for (var i = 0; i < pairs.length; i++) {
        var p = pairs[i];
        var rows = [];
        try {
          rows = await db.ritual_states.where('[subjectType+subjectId+date]').equals([p.type, Number(p.id), ds]).toArray();
        } catch (e) {
          try {
            var all = await db.ritual_states.toArray();
            rows = all.filter(function (r) { return r.subjectType === p.type && Number(r.subjectId) === Number(p.id) && r.date === ds; });
          } catch (e2) {}
        }
        var rec = rows && rows[0];
        if (!rec) continue;
        var lines = [];
        if (rec.schedule && rec.schedule.length) {
          lines.push('  今日日程：' + rec.schedule.map(function (it) { return (it.time ? it.time + ' ' : '') + it.content; }).join('；'));
        }
        if (rec.attire) lines.push('  穿着：' + rec.attire);
        if (rec.belongings) lines.push('  随身物品：' + rec.belongings);
        if (rec.location) lines.push('  当前位置：' + rec.location);
        if (rec.note) lines.push('  备注：' + rec.note);
        if (lines.length) out.push('【' + p.name + '（' + (p.type === 'user' ? '用户' : '角色') + '）今天的四维状态 · ' + prettyDate(ds) + '】\n' + lines.join('\n'));
      }
      if (!out.length) return '';
      return '以下是你们今天的真实生活状态（由仪轨记录，请在对话中自然体现，不要生硬复述）：\n' + out.join('\n');
    } catch (e) { return ''; }
  }

  // ==================== 初始化 ====================
  async function init() {
    var body = document.getElementById('yigui-body');
    if (!body) return;
    if (!state.inited) {
      state.inited = true;
      var now = new Date();
      state.viewYear = now.getFullYear();
      state.viewMonth = now.getMonth();
      state.selectedDate = todayStr();
      var chip = document.getElementById('yigui-subject-chip');
      if (chip) chip.onclick = pickSubject;
      var closeBtn = document.getElementById('yigui-close-btn');
      if (closeBtn) closeBtn.onclick = function () { if (typeof closeApp === 'function') closeApp('yigui'); };
      var prev = document.getElementById('yigui-prev-month');
      var next = document.getElementById('yigui-next-month');
      if (prev) prev.onclick = function () {
        state.viewMonth--; if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
        refreshMonth();
      };
      if (next) next.onclick = function () {
        state.viewMonth++; if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
        refreshMonth();
      };
    }
    await loadSubjects();
    // 恢复上次看的人；没有就用当前 user 人设
    var want = localStorage.getItem(LS_SUBJECT) || '';
    var pick = state.subjectList.filter(function (s) { return subjKey(s) === want; })[0]
      || state.subjectList.filter(function (s) { return s.type === 'user'; })[0]
      || state.subjectList[0];
    if (pick) { await setSubject(pick); }
    else {
      renderHeader();
      await refreshMonth();
      await renderDay();
    }
  }

  window.ritualSystem = {
    init: init,
    buildPromptSegment: buildPromptSegment,
    generate: generateState,
    _state: state
  };
  window.initYiguiApp = function () { init(); };
})();
