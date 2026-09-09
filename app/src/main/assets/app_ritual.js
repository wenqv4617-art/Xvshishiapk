/**
 * app_ritual.js - 仪轨（日程 / 穿着 / 随身物品 / 位置 四维状态 + 特殊情况 + 衣柜）
 * ------------------------------------------------------------
 * 设计取向（参考现代极简日历：Dawn、Clendar、Untitled UI Calendar、iOS 18 日历）：
 *   · 大标题 + 弱化网格线，靠留白与字重分层，而不是靠边框和底色块
 *   · 月历格用「圆点」表示"这天有内容"，选中用实心圆、今天用描边圈
 *   · 四维不直接铺开，而是折叠入口（点开才展开），入口自带图标/摘要/箭头
 *   · 所有弹层都是自制底部抽屉 / 卡片，图标全部通用路径 SVG，无 emoji
 *
 * 数据：
 *   db.ritual_states     每人每天一条：日程[{time,place,content}] / 穿着 / 随身物品[{name,note}] / 位置 / 特殊情况 / 备注
 *   db.ritual_wardrobe   衣柜：每人每类别下的衣物（可选上传图片，否则用内置占位图标）
 * 依赖：window.apiRoutes.resolve('ritual') 取 API 预设；db.archives / db.sessions 取人物。
 */
(function () {
  'use strict';

  var LS_SUBJECT = 'yigui-subject';        // 记住上次看的人： "user:7" / "char:100"
  var LS_EXPAND = 'yigui-expanded';        // 折叠状态
  var LS_WARDROBE_CATS = 'yigui-wardrobe-cats-'; // + subjectKey
  var DEFAULT_CATS = ['上装', '下装', '外套', '鞋', '配饰', '其他'];

  var state = {
    inited: false,
    subject: null,          // {type,id,name,avatar,persona,sessionId}
    subjectList: [],
    viewYear: 0,
    viewMonth: 0,
    selectedDate: '',
    currentState: null,
    loading: false,
    monthIndex: {},
    expanded: { schedule: true, attire: false, belongings: false, location: false, special: false, note: false },
    wardrobe: { open: false, cat: '上装', cats: DEFAULT_CATS.slice(), items: [] }
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
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M3 10h18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shirt: '<path d="M16 3l4 2-2 4-1-.5V21H7V8.5L6 9 4 5l4-2 2 2h4z"/>',
    pants: '<path d="M7 3h10l1 18h-4l-2-9-2 9H6z"/>',
    coat: '<path d="M9 3l3 3 3-3 4 3-2 5v10H7V11L5 6z"/><path d="M12 6v15"/>',
    shoe: '<path d="M3 16h13a5 5 0 0 0 5-2l-2-2-4 1-4-3H5a2 2 0 0 0-2 2z"/><path d="M3 19h18"/>',
    watch: '<circle cx="12" cy="12" r="6"/><path d="M12 10v2.5l1.8 1M9 3h6M9 21h6"/>',
    box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    bag: '<rect x="4" y="7" width="16" height="13" rx="3"/><path d="M9 7V5a3 3 0 0 1 6 0v2M9 12h6"/>',
    pin: '<path d="M12 21s-7-5.2-7-11a7 7 0 1 1 14 0c0 5.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    note: '<path d="M5 3h9l5 5v13H5z"/><path d="M14 3v5h5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    heart: '<path d="M12 20.3l-1.3-1.2C6 14.7 3 12 3 8.7A4.7 4.7 0 0 1 7.7 4c1.6 0 3.1.8 4.3 2.1A5.6 5.6 0 0 1 16.3 4 4.7 4.7 0 0 1 21 8.7c0 3.3-3 6-7.7 10.4z"/>',
    pill: '<path d="M10.5 20.5a5 5 0 0 1-7-7l6-6a5 5 0 0 1 7 7z"/><path d="M8.5 8.5l7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    wardrobe: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M7 8h2M15 8h2"/>'
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
  function timeToMin(t) {
    var m = String(t || '').match(/(\d{1,2})[:：](\d{2})/);
    return m ? (Number(m[1]) * 60 + Number(m[2])) : -1;
  }
  /** 解析 "08:00-10:00" / "08:00" → {from,to} */
  function rangeOf(t) {
    var parts = String(t || '').split(/[-~—–]/);
    var from = timeToMin(parts[0]);
    var to = parts[1] ? timeToMin(parts[1]) : (from >= 0 ? from + 60 : -1);
    return { from: from, to: to };
  }

  // ==================== 人物列表 ====================
  async function loadSubjects() {
    var list = [];
    var meId = myMeId();
    try {
      var me = meId ? await db.archives.get(Number(meId)) : null;
      if (me) list.push({ type: 'user', id: Number(me.id), name: me.name || '我', avatar: me.avatar || '', persona: me.persona || '', meId: meId });
    } catch (e) {}
    try {
      var sess = await db.sessions.where('userId').equals(Number(meId)).toArray();
      for (var i = 0; i < sess.length; i++) {
        var s = sess[i];
        if (s.isGroup === 1) continue;
        var c = await db.archives.get(Number(s.charId));
        if (list.some(function (x) { return x.type === 'char' && x.id === Number(s.charId); })) continue;
        list.push({
          type: 'char', id: Number(s.charId),
          name: s.customCharName || (c && c.name) || '角色',
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

    var el = sheet({ title: '切换人物', icon: ICO.user, body: '<div style="margin:-6px -14px;">' + rows + '</div>' });
    el.querySelectorAll('.yg-sheet-row').forEach(function (r) {
      r.onclick = async function () {
        var k = r.getAttribute('data-k');
        var found = state.subjectList.filter(function (s) { return subjKey(s) === k; })[0];
        closeSheet(el);
        if (found) await setSubject(found);
      };
    });
  }

  async function setSubject(s) {
    state.subject = s;
    try { localStorage.setItem(LS_SUBJECT, subjKey(s)); } catch (e) {}
    try {
      var raw = localStorage.getItem(LS_WARDROBE_CATS + subjKey(s));
      var cats = raw ? JSON.parse(raw) : null;
      state.wardrobe.cats = (Array.isArray(cats) && cats.length) ? cats : DEFAULT_CATS.slice();
    } catch (e) { state.wardrobe.cats = DEFAULT_CATS.slice(); }
    state.wardrobe.cat = state.wardrobe.cats[0];
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
      '<div class="yg-sheet-card" style="width:100%;max-width:440px;max-height:86vh;overflow-y:auto;background:#fff;border-radius:20px 20px 0 0;' +
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
      st.textContent = '@keyframes ygUp{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}@keyframes ygFade{from{opacity:0}to{opacity:1}}@keyframes ygShimmer{from{background-position:200% 0}to{background-position:-200% 0}}';
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
    var startPad = first.getDay();
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

  // ==================== 折叠入口 ====================
  function saveExpanded() {
    try { localStorage.setItem(LS_EXPAND, JSON.stringify(state.expanded)); } catch (e) {}
  }
  function entryHtml(key, icon, title, summary, bodyHtml) {
    var open = !!state.expanded[key];
    return '<div class="yg-entry" style="background:#fff;border:1px solid ' + (open ? '#dbe7f3' : '#eef2f7') + ';border-radius:16px;margin-bottom:10px;overflow:hidden;' +
        'transition:border-color .18s;">' +
      '<div class="yg-entry-head" data-k="' + key + '" style="display:flex;align-items:center;gap:11px;padding:12px 13px;cursor:pointer;user-select:none;">' +
        '<span style="width:34px;height:34px;border-radius:11px;background:' + (open ? 'rgba(30,136,229,0.12)' : 'rgba(30,136,229,0.07)') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#1e88e5;">' + svg(icon, 17, '#1e88e5') + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:13.5px;font-weight:800;color:#1e293b;">' + esc(title) + '</div>' +
          '<div style="font-size:11px;color:#94a3b8;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + summary + '</div>' +
        '</div>' +
        '<span style="display:flex;color:#cbd5e1;flex-shrink:0;transition:transform .2s;' + (open ? 'transform:rotate(180deg);' : '') + '">' + svg(ICO.chevronDown, 16, '#cbd5e1') + '</span>' +
      '</div>' +
      (open ? '<div style="padding:0 13px 13px;">' + bodyHtml + '</div>' : '') +
    '</div>';
  }

  function scheduleHtml(list) {
    if (!list || !list.length) return '<div style="font-size:12px;color:#cbd5e1;padding:2px 0 4px;">今天还没有安排</div>';
    return '<div style="display:flex;flex-direction:column;">' + list.map(function (it, i) {
      var now = new Date();
      var cur = now.getHours() * 60 + now.getMinutes();
      var rg = rangeOf(it.time);
      var isNow = rg.from >= 0 && cur >= rg.from && cur < rg.to;
      return '<div style="display:flex;gap:10px;padding:8px 0;' + (i ? 'border-top:1px dashed #f1f5f9;' : '') + '">' +
        '<div style="flex-shrink:0;width:52px;">' +
          '<div style="font-size:11.5px;font-weight:800;color:' + (isNow ? '#1e88e5' : '#64748b') + ';">' + esc(it.time || '') + '</div>' +
          (isNow ? '<div style="font-size:9px;font-weight:800;color:#fff;background:#1e88e5;border-radius:5px;padding:1px 4px;display:inline-block;margin-top:2px;">此刻</div>' : '') +
        '</div>' +
        '<div style="flex:1;min-width:0;">' +
          (it.place ? '<div style="display:flex;align-items:center;gap:4px;font-size:10.5px;color:#94a3b8;margin-bottom:2px;">' + svg(ICO.pin, 10, '#94a3b8') + esc(it.place) + '</div>' : '') +
          '<div style="font-size:12.5px;color:#334155;line-height:1.6;">' + esc(it.content || '') + '</div>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function skeletonHtml() {
    var bar = '<div style="height:11px;border-radius:6px;background:linear-gradient(90deg,#f1f5f9,#e2e8f0,#f1f5f9);background-size:200% 100%;animation:ygShimmer 1.1s linear infinite;"></div>';
    return '<div style="background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:13px;margin-bottom:10px;">' + bar + '<div style="height:7px;"></div>' + bar + '<div style="height:7px;"></div>' + bar + '</div>' +
      '<div style="background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:13px;margin-bottom:10px;">' + bar + '</div>' +
      '<div style="background:#fff;border:1px solid #eef2f7;border-radius:16px;padding:13px;">' + bar + '</div>';
  }

  /** 兼容旧数据：belongings 可能是字符串 */
  function normalizeBelongings(v) {
    if (Array.isArray(v)) return v.map(function (x) { return typeof x === 'string' ? { name: x, note: '' } : { name: String((x && x.name) || ''), note: String((x && x.note) || '') }; }).filter(function (x) { return x.name; });
    if (typeof v === 'string' && v.trim()) return v.split(/[、,，\n]/).map(function (s) { return { name: s.trim(), note: '' }; }).filter(function (x) { return x.name; });
    return [];
  }
  function normalizeSchedule(v) {
    if (!Array.isArray(v)) return [];
    return v.map(function (it) {
      return { time: String((it && it.time) || ''), place: String((it && it.place) || ''), content: String((it && it.content) || '') };
    }).filter(function (it) { return it.content || it.place; });
  }
  function specialOf(rec) {
    var sp = (rec && rec.special) || {};
    return {
      menstruation: { on: !!(sp.menstruation && sp.menstruation.on), level: (sp.menstruation && sp.menstruation.level) || '', note: (sp.menstruation && sp.menstruation.note) || '' },
      illness: { on: !!(sp.illness && sp.illness.on), name: (sp.illness && sp.illness.name) || '', level: (sp.illness && sp.illness.level) || '', note: (sp.illness && sp.illness.note) || '' }
    };
  }

  // ==================== 当日视图 ====================
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
            '<button id="yg-empty-ai" style="display:flex;align-items:center;gap:6px;padding:10px 16px;border:none;background:#1e88e5;color:#fff;border-radius:11px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;">' + svg(ICO.spark, 13, '#fff') + 'AI 推演</button>' +
            '<button id="yg-empty-manual" style="display:flex;align-items:center;gap:6px;padding:10px 16px;border:1.5px solid #e2e8f0;background:#fff;color:#475569;border-radius:11px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;">' + svg(ICO.edit, 13, '#475569') + '自己写</button>' +
          '</div>' +
        '</div>';
      var b1 = document.getElementById('yg-empty-ai'); if (b1) b1.onclick = function () { generateState(ds); };
      var b2 = document.getElementById('yg-empty-manual'); if (b2) b2.onclick = function () { openEditor(ds); };
      return;
    }

    var schedule = normalizeSchedule(rec.schedule);
    var belongings = normalizeBelongings(rec.belongings);
    var sp = specialOf(rec);
    var srcTag = rec.source === 'ai'
      ? '<span style="font-size:9.5px;font-weight:800;color:#1e88e5;background:rgba(30,136,229,.10);padding:2px 6px;border-radius:6px;">AI 推演</span>'
      : '<span style="font-size:9.5px;font-weight:800;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:6px;">手动填写</span>';

    var specialSummary = [];
    if (sp.menstruation.on) specialSummary.push('生理期' + (sp.menstruation.level ? '·' + sp.menstruation.level : ''));
    if (sp.illness.on) specialSummary.push(sp.illness.name || '身体不适');
    var specialBody =
      '<div style="display:flex;flex-direction:column;gap:12px;">' +
        '<div style="background:#fff5f7;border:1px solid #ffe0e7;border-radius:12px;padding:11px 12px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<span style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;color:#c2415c;">' + svg(ICO.heart, 14, '#c2415c') + '生理期</span>' +
            '<span style="font-size:11px;font-weight:800;color:' + (sp.menstruation.on ? '#c2415c' : '#cbd5e1') + ';">' + (sp.menstruation.on ? '进行中' : '无') + '</span>' +
          '</div>' +
          (sp.menstruation.on ? '<div style="font-size:11.5px;color:#8a5b67;margin-top:6px;line-height:1.6;">' +
            (sp.menstruation.level ? '状态：' + esc(sp.menstruation.level) + '<br>' : '') +
            (sp.menstruation.note ? esc(sp.menstruation.note) : '') + '</div>' : '') +
        '</div>' +
        '<div style="background:#f6f8ff;border:1px solid #e3e9fb;border-radius:12px;padding:11px 12px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<span style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:800;color:#3b5bdb;">' + svg(ICO.pill, 14, '#3b5bdb') + '生病 / 不适</span>' +
            '<span style="font-size:11px;font-weight:800;color:' + (sp.illness.on ? '#3b5bdb' : '#cbd5e1') + ';">' + (sp.illness.on ? '进行中' : '无') + '</span>' +
          '</div>' +
          (sp.illness.on ? '<div style="font-size:11.5px;color:#5a6b96;margin-top:6px;line-height:1.6;">' +
            (sp.illness.name ? '症状：' + esc(sp.illness.name) + '<br>' : '') +
            (sp.illness.level ? '程度：' + esc(sp.illness.level) + '<br>' : '') +
            (sp.illness.note ? esc(sp.illness.note) : '') + '</div>' : '') +
        '</div>' +
        '<button id="yg-special-edit" style="width:100%;padding:11px;border:1.5px solid #e2e8f0;background:#fff;border-radius:11px;font-size:12px;font-weight:800;color:#475569;cursor:pointer;font-family:inherit;">编辑今天的情况</button>' +
      '</div>';

    box.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' + srcTag +
          '<span style="font-size:10.5px;color:#cbd5e1;">' + (rec.updatedAt ? new Date(rec.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '') + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<button id="yg-edit-btn" style="display:flex;align-items:center;gap:4px;padding:6px 10px;border:1.5px solid #e2e8f0;background:#fff;border-radius:9px;font-size:11px;font-weight:700;color:#475569;cursor:pointer;font-family:inherit;">' + svg(ICO.edit, 12, '#475569') + '编辑</button>' +
          '<button id="yg-del-btn" style="display:flex;align-items:center;gap:4px;padding:6px 10px;border:1.5px solid #fecaca;background:#fff;border-radius:9px;font-size:11px;font-weight:700;color:#ef4444;cursor:pointer;font-family:inherit;">' + svg(ICO.trash, 12, '#ef4444') + '删除</button>' +
        '</div>' +
      '</div>' +
      entryHtml('schedule', ICO.clock, '今日日程', schedule.length ? (schedule.length + ' 项 · ' + esc(String(schedule[0].content).slice(0, 18))) : '还没有安排', scheduleHtml(schedule)) +
      entryHtml('attire', ICO.shirt, '穿着', rec.attire ? esc(String(rec.attire).slice(0, 30)) : '未记录',
        (rec.attire ? '<div style="font-size:12.5px;line-height:1.72;color:#334155;margin-bottom:10px;">' + esc(rec.attire) + '</div>' : '<div style="font-size:12px;color:#cbd5e1;margin-bottom:10px;">今天还没记录穿着</div>') +
        '<button id="yg-open-wardrobe" style="display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:10px;border:1.5px solid #e2e8f0;background:#fff;border-radius:11px;font-size:12px;font-weight:800;color:#475569;cursor:pointer;font-family:inherit;">' + svg(ICO.wardrobe, 13, '#475569') + '打开衣柜</button>') +
      entryHtml('belongings', ICO.bag, '随身物品', belongings.length ? (belongings.length + ' 件 · ' + esc(belongings.slice(0, 3).map(function (b) { return b.name; }).join('、'))) : '未记录',
        belongings.length
          ? '<div style="display:flex;flex-direction:column;gap:7px;">' + belongings.map(function (b, i) {
              return '<div class="yg-belong" data-i="' + i + '" style="display:flex;align-items:center;gap:9px;padding:9px 11px;background:#f8fafc;border-radius:11px;cursor:pointer;">' +
                '<span style="display:flex;color:#64748b;flex-shrink:0;">' + svg(ICO.box, 14, '#64748b') + '</span>' +
                '<span style="flex:1;min-width:0;font-size:12.5px;font-weight:700;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(b.name) + '</span>' +
                (b.note ? '<span style="font-size:10px;color:#94a3b8;flex-shrink:0;">详情</span>' : '') +
                '<span style="display:flex;color:#cbd5e1;flex-shrink:0;">' + svg('<path d="M9 18l6-6-6-6"/>', 12, '#cbd5e1') + '</span>' +
              '</div>';
            }).join('') + '</div>'
          : '<div style="font-size:12px;color:#cbd5e1;">今天还没记录随身物品</div>') +
      entryHtml('location', ICO.pin, '当前位置', rec.location ? esc(String(rec.location).slice(0, 30)) : '未记录',
        rec.location ? '<div style="font-size:12.5px;line-height:1.72;color:#334155;">' + esc(rec.location) + '</div>' : '<div style="font-size:12px;color:#cbd5e1;">今天还没记录位置</div>') +
      entryHtml('special', ICO.heart, '今天的情况', specialSummary.length ? specialSummary.join(' · ') : '生理期 / 生病 都可以记在这里', specialBody) +
      (rec.note ? entryHtml('note', ICO.note, '备注', esc(String(rec.note).slice(0, 30)), '<div style="font-size:12.5px;line-height:1.72;color:#334155;">' + esc(rec.note) + '</div>') : '');

    // 折叠交互
    box.querySelectorAll('.yg-entry-head').forEach(function (h) {
      h.onclick = function () {
        var k = h.getAttribute('data-k');
        state.expanded[k] = !state.expanded[k];
        saveExpanded();
        renderDay();
      };
    });
    // 随身物品详情
    box.querySelectorAll('.yg-belong').forEach(function (row) {
      row.onclick = function () {
        var b = belongings[Number(row.getAttribute('data-i'))];
        if (!b) return;
        sheet({
          title: b.name, icon: ICO.box,
          body: '<div style="font-size:12.5px;line-height:1.8;color:#334155;">' +
            (b.note ? esc(b.note) : '<span style="color:#cbd5e1;">这件物品还没有详情，点「编辑」补上吧。</span>') + '</div>'
        });
      };
    });
    var wb = document.getElementById('yg-open-wardrobe');
    if (wb) wb.onclick = function () { openWardrobe(); };
    var spBtn = document.getElementById('yg-special-edit');
    if (spBtn) spBtn.onclick = function () { openSpecialEditor(ds); };
    var eb = document.getElementById('yg-edit-btn'); if (eb) eb.onclick = function () { openEditor(ds); };
    var del = document.getElementById('yg-del-btn');
    if (del) del.onclick = async function () {
      var ok = await confirmCard({ title: '删除这条记录？', message: prettyDate(ds) + ' 的' + state.subject.name + '四维状态会被清除。', danger: true, okText: '删除', icon: ICO.trash });
      if (!ok) return;
      try { await db.ritual_states.delete(rec.id); } catch (e) {}
      toast('已删除');
      await refreshMonth();
      await renderDay();
    };
  }

  // ==================== 特殊情况（生理期 / 生病） ====================
  function openSpecialEditor(ds) {
    var sp = specialOf(state.currentState);
    var row = function (id, label, val, ph) {
      return '<div style="margin-bottom:10px;"><div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">' + label + '</div>' +
        '<input id="' + id + '" value="' + esc(val) + '" placeholder="' + esc(ph) + '" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:9px 11px;font-size:12.5px;color:#334155;font-family:inherit;outline:none;"></div>';
    };
    var el = sheet({
      title: prettyDate(ds) + ' · 今天的情况',
      icon: ICO.heart,
      body:
        '<div style="background:#fff5f7;border:1px solid #ffe0e7;border-radius:14px;padding:12px;margin-bottom:12px;">' +
          '<label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">' +
            '<span style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:800;color:#c2415c;">' + svg(ICO.heart, 15, '#c2415c') + '生理期</span>' +
            '<input type="checkbox" id="yg-sp-men" ' + (sp.menstruation.on ? 'checked' : '') + ' style="width:18px;height:18px;accent-color:#c2415c;">' +
          '</label>' +
          '<div id="yg-sp-men-box" style="display:' + (sp.menstruation.on ? 'block' : 'none') + ';margin-top:10px;">' +
            row('yg-sp-men-level', '状态', sp.menstruation.level, '例如：第二天，量偏多 / 快结束了') +
            row('yg-sp-men-note', '备注', sp.menstruation.note, '例如：腰很酸，只想躺着') +
          '</div>' +
        '</div>' +
        '<div style="background:#f6f8ff;border:1px solid #e3e9fb;border-radius:14px;padding:12px;margin-bottom:12px;">' +
          '<label style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">' +
            '<span style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:800;color:#3b5bdb;">' + svg(ICO.pill, 15, '#3b5bdb') + '生病 / 不适</span>' +
            '<input type="checkbox" id="yg-sp-ill" ' + (sp.illness.on ? 'checked' : '') + ' style="width:18px;height:18px;accent-color:#3b5bdb;">' +
          '</label>' +
          '<div id="yg-sp-ill-box" style="display:' + (sp.illness.on ? 'block' : 'none') + ';margin-top:10px;">' +
            row('yg-sp-ill-name', '症状', sp.illness.name, '例如：感冒发烧 / 胃疼 / 偏头痛') +
            row('yg-sp-ill-level', '程度', sp.illness.level, '例如：低烧 37.8℃ / 疼得直不起腰') +
            row('yg-sp-ill-note', '备注', sp.illness.note, '例如：吃了药，正在休息') +
          '</div>' +
        '</div>' +
        '<button id="yg-sp-save" style="width:100%;padding:12px;border:none;background:#1e88e5;border-radius:12px;font-size:12.5px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;">保存</button>'
    });
    var menCb = el.querySelector('#yg-sp-men'), illCb = el.querySelector('#yg-sp-ill');
    menCb.onchange = function () { el.querySelector('#yg-sp-men-box').style.display = menCb.checked ? 'block' : 'none'; };
    illCb.onchange = function () { el.querySelector('#yg-sp-ill-box').style.display = illCb.checked ? 'block' : 'none'; };
    el.querySelector('#yg-sp-save').onclick = async function () {
      var rec = state.currentState || {
        meId: myMeId(), subjectType: state.subject.type, subjectId: Number(state.subject.id), date: ds,
        schedule: [], attire: '', belongings: [], location: '', note: '', source: 'manual'
      };
      rec.special = {
        menstruation: { on: menCb.checked, level: el.querySelector('#yg-sp-men-level').value.trim().slice(0, 60), note: el.querySelector('#yg-sp-men-note').value.trim().slice(0, 200) },
        illness: { on: illCb.checked, name: el.querySelector('#yg-sp-ill-name').value.trim().slice(0, 60), level: el.querySelector('#yg-sp-ill-level').value.trim().slice(0, 60), note: el.querySelector('#yg-sp-ill-note').value.trim().slice(0, 200) }
      };
      rec.updatedAt = Date.now();
      if (!rec.source) rec.source = 'manual';
      try { await saveState(rec); } catch (e) { await confirmCard({ title: '保存失败', message: e.message }); return; }
      closeSheet(el);
      toast('已保存今天的情况');
      await refreshMonth();
      await renderDay();
    };
  }

  // ==================== 衣柜 ====================
  function catIcon(cat) {
    if (/上装|上衣|T恤|衬衫/.test(cat)) return ICO.shirt;
    if (/下装|裤|裙/.test(cat)) return ICO.pants;
    if (/外套|大衣|夹克/.test(cat)) return ICO.coat;
    if (/鞋/.test(cat)) return ICO.shoe;
    if (/配饰|首饰|表|包/.test(cat)) return ICO.watch;
    return ICO.box;
  }

  async function loadWardrobe() {
    if (!state.subject) return [];
    var rows = [];
    try {
      rows = await db.ritual_wardrobe.where('[subjectType+subjectId+category]')
        .equals([state.subject.type, Number(state.subject.id), state.wardrobe.cat]).toArray();
    } catch (e) {
      try {
        var all = await db.ritual_wardrobe.toArray();
        rows = all.filter(function (r) { return r.subjectType === state.subject.type && Number(r.subjectId) === Number(state.subject.id) && r.category === state.wardrobe.cat; });
      } catch (e2) { rows = []; }
    }
    state.wardrobe.items = rows || [];
    return state.wardrobe.items;
  }

  function openWardrobe() {
    state.wardrobe.open = true;
    var host = document.getElementById('yigui-wardrobe');
    if (!host) return;
    host.style.display = 'block';
    renderWardrobe();
  }
  function closeWardrobe() {
    state.wardrobe.open = false;
    var host = document.getElementById('yigui-wardrobe');
    if (host) host.style.display = 'none';
  }

  async function renderWardrobe() {
    var host = document.getElementById('yigui-wardrobe');
    if (!host || !state.subject) return;
    var s = state.subject;
    var cats = state.wardrobe.cats;
    if (cats.indexOf(state.wardrobe.cat) < 0) state.wardrobe.cat = cats[0];
    var items = await loadWardrobe();

    var tabs = cats.map(function (c) {
      var on = c === state.wardrobe.cat;
      return '<div class="yg-wcat" data-c="' + esc(c) + '" style="flex-shrink:0;padding:7px 13px;border-radius:99px;font-size:12px;font-weight:800;cursor:pointer;' +
        (on ? 'background:#1e88e5;color:#fff;' : 'background:#fff;color:#64748b;border:1px solid #eef2f7;') + '">' + esc(c) + '</div>';
    }).join('') + '<div class="yg-wcat-add" style="flex-shrink:0;padding:7px 12px;border-radius:99px;font-size:12px;font-weight:800;cursor:pointer;background:#fff;color:#1e88e5;border:1px dashed #bcd9f2;">+ 类别</div>';

    var grid = items.length ? items.map(function (it) {
      var img = it.image
        ? '<img src="' + esc(it.image) + '" style="width:100%;height:100%;object-fit:cover;">'
        : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#b9c7d6;">' + svg(catIcon(it.category), 30, '#b9c7d6') + '</div>';
      return '<div class="yg-witem" data-id="' + it.id + '" style="cursor:pointer;">' +
          '<div style="width:100%;aspect-ratio:1/1;border-radius:14px;overflow:hidden;border:1px solid #eef2f7;background:#fff;">' + img + '</div>' +
          '<div style="font-size:11.5px;font-weight:700;color:#334155;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(it.name || '未命名') + '</div>' +
          (it.note ? '<div style="font-size:10px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(String(it.note).slice(0, 16)) + '</div>' : '') +
        '</div>';
    }).join('') : '<div style="grid-column:1 / -1;padding:30px 0;text-align:center;color:#cbd5e1;font-size:12px;">这个类别还没有衣物<br>点右上角 + 添加，或让 AI 批量生成</div>';

    host.innerHTML =
      '<div style="position:absolute;inset:0;background:#f7f8fa;display:flex;flex-direction:column;animation:ygFade .2s ease-out;">' +
        '<header class="win-header" style="padding:10px 14px;background:linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0.55));border-bottom:1px solid rgba(148,163,184,0.22);">' +
          '<button class="btn-icon" id="yg-w-back" style="color:#475569;">' + svg('<path d="M15 18l-6-6 6-6"/>', 20, '#475569') + '</button>' +
          '<h3 style="color:#1e293b;font-size:15px;font-weight:700;letter-spacing:1px;">衣柜 · ' + esc(s.name) + '</h3>' +
          '<div style="display:flex;gap:6px;">' +
            '<button id="yg-w-ai" title="AI 批量生成" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid #eef2f7;background:#fff;border-radius:10px;color:#1e88e5;cursor:pointer;">' + svg(ICO.spark, 15, '#1e88e5') + '</button>' +
            '<button id="yg-w-add" title="添加衣物" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid #eef2f7;background:#fff;border-radius:10px;color:#1e88e5;cursor:pointer;">' + svg(ICO.plus, 15, '#1e88e5') + '</button>' +
          '</div>' +
        '</header>' +
        '<div style="display:flex;gap:8px;padding:12px 14px 4px;overflow-x:auto;">' + tabs + '</div>' +
        '<div style="flex:1;overflow-y:auto;padding:10px 14px 26px;">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">' + grid + '</div>' +
        '</div>' +
      '</div>';

    host.querySelector('#yg-w-back').onclick = closeWardrobe;
    host.querySelector('#yg-w-add').onclick = function () { addWardrobeItem(); };
    host.querySelector('#yg-w-ai').onclick = function () { aiGenerateWardrobe(); };
    host.querySelectorAll('.yg-wcat').forEach(function (t) {
      t.onclick = function () { state.wardrobe.cat = t.getAttribute('data-c'); renderWardrobe(); };
    });
    var addCat = host.querySelector('.yg-wcat-add');
    if (addCat) addCat.onclick = function () { addWardrobeCategory(); };
    host.querySelectorAll('.yg-witem').forEach(function (n) {
      n.onclick = function () {
        var it = state.wardrobe.items.filter(function (x) { return String(x.id) === n.getAttribute('data-id'); })[0];
        if (it) openWardrobeItem(it);
      };
    });
  }

  function addWardrobeCategory() {
    var el = sheet({
      title: '新增类别', icon: ICO.plus,
      body: '<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">类别名称</div>' +
        '<input id="yg-cat-name" placeholder="例如：睡衣 / 运动装 / 香水" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:10px 12px;font-size:13px;font-family:inherit;outline:none;"></div>' +
        '<button id="yg-cat-save" style="width:100%;padding:12px;border:none;background:#1e88e5;border-radius:12px;font-size:12.5px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;">添加</button>'
    });
    el.querySelector('#yg-cat-save').onclick = function () {
      var name = el.querySelector('#yg-cat-name').value.trim();
      if (!name) { toast('请输入类别名称'); return; }
      if (state.wardrobe.cats.indexOf(name) >= 0) { toast('这个类别已存在'); return; }
      state.wardrobe.cats.push(name);
      try { localStorage.setItem(LS_WARDROBE_CATS + subjKey(state.subject), JSON.stringify(state.wardrobe.cats)); } catch (e) {}
      state.wardrobe.cat = name;
      closeSheet(el);
      renderWardrobe();
      toast('已添加类别「' + name + '」');
    };
  }

  function readImageFile(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { toast('图片读取失败'); };
    reader.onload = function (e) {
      var img = new Image();
      img.onerror = function () { toast('图片解析失败'); };
      img.onload = function () {
        try {
          var max = 512;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var ctx = cv.getContext('2d');
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          var isPng = /image\/png/i.test(file.type);
          cb(cv.toDataURL(isPng ? 'image/png' : 'image/jpeg', 0.85));
        } catch (err) { toast('图片处理失败：' + err.message); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function addWardrobeItem() {
    var el = sheet({
      title: '添加衣物 · ' + state.wardrobe.cat, icon: ICO.wardrobe,
      body:
        '<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">名称</div>' +
          '<input id="yg-wi-name" placeholder="例如：米白色针织开衫" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:10px 12px;font-size:13px;font-family:inherit;outline:none;"></div>' +
        '<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">详情（可选）</div>' +
          '<textarea id="yg-wi-note" rows="2" placeholder="例如：羊毛混纺，袖口有点松，她最喜欢这件" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:10px 12px;font-size:12.5px;font-family:inherit;outline:none;resize:vertical;"></textarea></div>' +
        '<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">图片（可选，不上传就用内置图标）</div>' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<div id="yg-wi-preview" style="width:64px;height:64px;border-radius:12px;border:1.5px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#f8fafc;color:#b9c7d6;flex-shrink:0;">' + svg(catIcon(state.wardrobe.cat), 26, '#b9c7d6') + '</div>' +
            '<div style="flex:1;display:flex;flex-direction:column;gap:6px;">' +
              '<button id="yg-wi-pick" style="padding:9px;border:1.5px solid #e2e8f0;background:#fff;border-radius:10px;font-size:12px;font-weight:700;color:#475569;cursor:pointer;font-family:inherit;">选择 PNG 图片</button>' +
              '<button id="yg-wi-clear" style="padding:9px;border:1.5px solid #eef2f7;background:#fff;border-radius:10px;font-size:11.5px;font-weight:700;color:#94a3b8;cursor:pointer;font-family:inherit;">清除图片</button>' +
            '</div>' +
          '</div>' +
          '<input type="file" id="yg-wi-file" accept="image/png,image/*" style="display:none;">' +
        '</div>' +
        '<button id="yg-wi-save" style="width:100%;padding:12px;border:none;background:#1e88e5;border-radius:12px;font-size:12.5px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;">保存</button>'
    });
    var imgData = '';
    var prev = el.querySelector('#yg-wi-preview');
    var fileInput = el.querySelector('#yg-wi-file');
    el.querySelector('#yg-wi-pick').onclick = function () { fileInput.click(); };
    fileInput.onchange = function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      readImageFile(fileInput.files[0], function (dataUrl) {
        imgData = dataUrl;
        prev.innerHTML = '<img src="' + esc(dataUrl) + '" style="width:100%;height:100%;object-fit:cover;">';
        prev.style.borderStyle = 'solid';
        prev.style.borderColor = '#e2e8f0';
      });
    };
    el.querySelector('#yg-wi-clear').onclick = function () {
      imgData = '';
      prev.innerHTML = svg(catIcon(state.wardrobe.cat), 26, '#b9c7d6');
      prev.style.borderStyle = 'dashed';
      prev.style.borderColor = '#cbd5e1';
    };
    el.querySelector('#yg-wi-save').onclick = async function () {
      var name = el.querySelector('#yg-wi-name').value.trim();
      if (!name) { toast('请填写衣物名称'); return; }
      try {
        await db.ritual_wardrobe.add({
          subjectType: state.subject.type, subjectId: Number(state.subject.id),
          category: state.wardrobe.cat, name: name,
          note: el.querySelector('#yg-wi-note').value.trim().slice(0, 300),
          image: imgData, createdAt: Date.now()
        });
      } catch (e) { await confirmCard({ title: '保存失败', message: e.message }); return; }
      closeSheet(el);
      toast('已添加到衣柜');
      renderWardrobe();
    };
  }

  function openWardrobeItem(it) {
    var el = sheet({
      title: it.name || '衣物', icon: catIcon(it.category),
      body:
        (it.image ? '<div style="width:100%;max-height:240px;border-radius:14px;overflow:hidden;margin-bottom:12px;background:#f8fafc;"><img src="' + esc(it.image) + '" style="width:100%;display:block;object-fit:contain;"></div>' : '') +
        '<div style="font-size:10.5px;color:#94a3b8;margin-bottom:8px;">类别：' + esc(it.category || '') + '</div>' +
        '<div style="font-size:12.5px;line-height:1.75;color:#334155;">' + (it.note ? esc(it.note) : '<span style="color:#cbd5e1;">还没有详情</span>') + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:16px;">' +
          '<button id="yg-wi-wear" style="flex:1.2;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border:none;background:#1e88e5;border-radius:12px;font-size:12.5px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;">' + svg(ICO.check, 13, '#fff') + '记入今天穿着</button>' +
          '<button id="yg-wi-del" style="flex:0.8;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border:1.5px solid #fecaca;background:#fff;border-radius:12px;font-size:12.5px;font-weight:800;color:#ef4444;cursor:pointer;font-family:inherit;">' + svg(ICO.trash, 13, '#ef4444') + '删除</button>' +
        '</div>'
    });
    el.querySelector('#yg-wi-wear').onclick = async function () {
      var ds = state.selectedDate || todayStr();
      var rec = state.currentState;
      if (!rec || rec.date !== ds) {
        rec = { meId: myMeId(), subjectType: state.subject.type, subjectId: Number(state.subject.id), date: ds, schedule: [], belongings: [], location: '', note: '', source: 'manual' };
      }
      var cur = String(rec.attire || '').trim();
      if (cur.indexOf(it.name) < 0) rec.attire = cur ? (cur + '、' + it.name) : it.name;
      rec.updatedAt = Date.now();
      try { await saveState(rec); } catch (e) { await confirmCard({ title: '保存失败', message: e.message }); return; }
      closeSheet(el);
      closeWardrobe();
      toast('已记入今天穿着');
      await refreshMonth();
      await renderDay();
    };
    el.querySelector('#yg-wi-del').onclick = async function () {
      var ok = await confirmCard({ title: '删除这件衣物？', message: '「' + (it.name || '') + '」会从衣柜里移除。', danger: true, okText: '删除', icon: ICO.trash });
      if (!ok) return;
      try { await db.ritual_wardrobe.delete(Number(it.id)); } catch (e) {}
      closeSheet(el);
      toast('已删除');
      renderWardrobe();
    };
  }

  async function aiGenerateWardrobe() {
    if (!state.subject) return;
    var s = state.subject;
    var el = sheet({
      title: 'AI 生成衣柜 · ' + s.name, icon: ICO.spark,
      body:
        '<div style="font-size:12px;color:#64748b;line-height:1.7;margin-bottom:12px;">' +
          'AI 会依据人设、关系与最近剧情，为「' + esc(s.name) + '」生成一批符合风格的衣物（不含图片，用内置图标显示）。</div>' +
        '<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">每类生成数量</div>' +
          '<select id="yg-ai-count" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:10px 12px;font-size:13px;font-family:inherit;outline:none;">' +
            '<option value="2">每类 2 件</option><option value="3" selected>每类 3 件</option><option value="4">每类 4 件</option></select></div>' +
        '<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:800;color:#64748b;margin-bottom:5px;">补充要求（可选）</div>' +
          '<textarea id="yg-ai-extra" rows="2" placeholder="例如：偏秋冬、颜色以米白和驼色为主" style="width:100%;box-sizing:border-box;border:1.5px solid #e2e8f0;border-radius:11px;padding:10px 12px;font-size:12.5px;font-family:inherit;outline:none;resize:vertical;"></textarea></div>' +
        '<button id="yg-ai-go" style="width:100%;padding:12px;border:none;background:#1e88e5;border-radius:12px;font-size:12.5px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;">开始生成</button>'
    });
    el.querySelector('#yg-ai-go').onclick = async function () {
      var per = Number(el.querySelector('#yg-ai-count').value) || 3;
      var extra = el.querySelector('#yg-ai-extra').value.trim();
      var btn = el.querySelector('#yg-ai-go');
      btn.disabled = true; btn.textContent = '生成中…';
      try {
        var ctx = await buildPromptContext(s);
        var cats = state.wardrobe.cats;
        var sys = '你是一个服装搭配数据库。你只输出 JSON，不输出任何解释、Markdown 或 emoji。';
        var usr = ctx + '\n\n请为「' + s.name + '」生成一个衣柜清单。\n' +
          '类别固定为这些：' + cats.join('、') + '。每个类别生成 ' + per + ' 件。\n' +
          (extra ? '补充要求：' + extra + '\n' : '') +
          '每件衣物要有：名称（具体到颜色/材质/款式）、一句详情（版型、新旧、有没有故事）。\n' +
          '只输出 JSON：{"items":[{"category":"上装","name":"米白色羊毛针织开衫","note":"袖口有点松，她最喜欢这件"}]}';
        var raw = await callAI(sys, usr);
        var parsed = parseJsonLoose(raw);
        var items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
        if (!items.length) throw new Error('模型没有返回可用的衣柜清单');
        var added = 0;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          var cat = String(it.category || '').trim();
          if (cats.indexOf(cat) < 0) cat = cats[0];
          var name = String(it.name || '').trim();
          if (!name) continue;
          await db.ritual_wardrobe.add({
            subjectType: s.type, subjectId: Number(s.id), category: cat,
            name: name.slice(0, 60), note: String(it.note || '').slice(0, 300),
            image: '', createdAt: Date.now()
          });
          added++;
        }
        closeSheet(el);
        toast('已生成 ' + added + ' 件衣物');
        renderWardrobe();
      } catch (e) {
        btn.disabled = false; btn.textContent = '开始生成';
        await confirmCard({ title: '生成失败', message: (e && e.message) || String(e), icon: ICO.spark });
      }
    };
  }

  // ==================== 生成（API） ====================
  async function buildPromptContext(s) {
    var lines = [];
    lines.push('你要推演的人是：' + s.name + '（' + (s.type === 'user' ? '用户本人' : '角色') + '）');
    if (s.persona) lines.push('人设：' + String(s.persona).slice(0, 1200));
    try {
      if (typeof queryRelationship === 'function' && s.sessionId) {
        var sess = await db.sessions.get(Number(s.sessionId));
        if (sess) {
          var rel = await queryRelationship(Number(sess.userId), Number(sess.charId), sess.customUserName || '我', s.name);
          if (rel) lines.push(rel);
        }
      }
    } catch (e) {}
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
        '{"schedule":[{"time":"07:30-08:10","place":"家里","content":"起床、洗漱、煮了咖啡"}],' +
        '"attire":"今天穿什么（含颜色/材质/配饰，具体）",' +
        '"belongings":[{"name":"手机","note":"屏幕裂了一道，还舍不得换"}],' +
        '"location":"此刻在哪里（具体地点 + 一句环境描写）",' +
        '"special":{"menstruation":{"on":false,"level":"","note":""},"illness":{"on":false,"name":"","level":"","note":""}},' +
        '"note":"一句话心情或小插曲"}\n' +
        '要求：\n' +
        '1) schedule 给 5-7 条，每条必须同时有时间段（HH:MM-HH:MM）、地点、事件三样；内容具体、有生活质感，能体现人设；\n' +
        '2) belongings 给 3-6 件，每件要有 name 和一句 note（这件东西的来历或状态）；\n' +
        '3) attire / location 要具体到能想象出画面，不要空泛；\n' +
        '4) special 里：生理期只有女性角色才可能为 true，若为 true 给出状态与备注；生病同样（没有就都填 false）；\n' +
        '5) 全部用中文，不要 emoji，不要括号动作描写。';
      var raw = await callAI(sys, usr);
      var parsed = parseJsonLoose(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('模型没有返回可解析的 JSON');
      var schedule = Array.isArray(parsed.schedule) ? parsed.schedule.map(function (it) {
        return {
          time: String((it && it.time) || '').slice(0, 16),
          place: String((it && it.place) || '').slice(0, 40),
          content: String((it && it.content) || '').slice(0, 200)
        };
      }).filter(function (it) { return it.content; }).slice(0, 10) : [];
      var belongings = normalizeBelongings(parsed.belongings).slice(0, 10);
      var sp = (parsed.special && typeof parsed.special === 'object') ? parsed.special : {};
      var rec = {
        meId: myMeId(),
        subjectType: s.type, subjectId: Number(s.id), date: ds,
        schedule: schedule,
        attire: String(parsed.attire || '').slice(0, 600),
        belongings: belongings,
        location: String(parsed.location || '').slice(0, 400),
        special: {
          menstruation: { on: !!(sp.menstruation && sp.menstruation.on), level: String((sp.menstruation && sp.menstruation.level) || '').slice(0, 60), note: String((sp.menstruation && sp.menstruation.note) || '').slice(0, 200) },
          illness: { on: !!(sp.illness && sp.illness.on), name: String((sp.illness && sp.illness.name) || '').slice(0, 60), level: String((sp.illness && sp.illness.level) || '').slice(0, 60), note: String((sp.illness && sp.illness.note) || '').slice(0, 200) }
        },
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
    var scheduleText = normalizeSchedule(rec.schedule).map(function (it) {
      return [it.time, it.place, it.content].filter(Boolean).join(' | ');
    }).join('\n');
    var belongingsText = normalizeBelongings(rec.belongings).map(function (b) {
      return b.note ? (b.name + ' | ' + b.note) : b.name;
    }).join('\n');
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
        field('今日日程（一行一条：时间段 | 地点 | 事件）', 'yg-f-schedule', scheduleText, '08:00-09:00 | 家里 | 起床洗漱', 6) +
        field('穿着', 'yg-f-attire', rec.attire || '', '例如：米白色针织衫 + 深色阔腿裤，左手戴银色手表', 2) +
        field('随身物品（一行一件：名称 | 详情）', 'yg-f-belongings', belongingsText, '手机 | 屏幕裂了一道，还舍不得换', 4) +
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
        var parts = l.split('|').map(function (x) { return x.trim(); });
        if (parts.length >= 3) return { time: parts[0], place: parts[1], content: parts.slice(2).join(' ') };
        if (parts.length === 2) return { time: parts[0], place: '', content: parts[1] };
        var m = l.match(/^(\d{1,2}[:：]\d{2}(?:\s*[-~]\s*\d{1,2}[:：]\d{2})?)\s*(.*)$/);
        return m ? { time: m[1].replace('：', ':'), place: '', content: m[2] } : { time: '', place: '', content: l };
      });
      var belongings = q('yg-f-belongings').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
        var p = l.split('|');
        return { name: p[0].trim(), note: p.slice(1).join('|').trim() };
      }).filter(function (b) { return b.name; });
      var rec = {
        meId: myMeId(),
        subjectType: s.type, subjectId: Number(s.id), date: ds,
        schedule: schedule, belongings: belongings,
        attire: q('yg-f-attire').slice(0, 600),
        location: q('yg-f-location').slice(0, 400),
        note: q('yg-f-note').slice(0, 300),
        special: (state.currentState && state.currentState.special) || specialOf(null),
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
  /** 给 app_prompts.js 调用：返回该会话 char 与 user 当天的状态段落（含"此刻正在做什么"） */
  async function buildPromptSegment(sess) {
    try {
      if (!sess) return '';
      var ds = todayStr();
      var out = [];
      var now = new Date();
      var curMin = now.getHours() * 60 + now.getMinutes();
      var nowLabel = pad2(now.getHours()) + ':' + pad2(now.getMinutes());

      var pairs = [
        { type: 'char', id: Number(sess.charId), name: sess.customCharName || '对方', isMe: false },
        { type: 'user', id: Number(sess.userId), name: sess.customUserName || '我', isMe: true }
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
        var schedule = normalizeSchedule(rec.schedule);
        var currentItem = null;
        if (schedule.length) {
          lines.push('  今日日程：' + schedule.map(function (it) {
            return (it.time ? it.time + ' ' : '') + (it.place ? '@' + it.place + ' ' : '') + it.content;
          }).join('；'));
          for (var k = 0; k < schedule.length; k++) {
            var rg = rangeOf(schedule[k].time);
            if (rg.from >= 0 && curMin >= rg.from && curMin < rg.to) { currentItem = schedule[k]; break; }
          }
          if (currentItem) {
            lines.push('  ★ 此刻（' + nowLabel + '）' + (p.isMe ? '你' : p.name) + '正在：' +
              (currentItem.place ? '在' + currentItem.place + '，' : '') + currentItem.content);
          } else if (schedule.length) {
            var next = null;
            for (var n = 0; n < schedule.length; n++) {
              var rg2 = rangeOf(schedule[n].time);
              if (rg2.from >= curMin) { next = schedule[n]; break; }
            }
            if (next) lines.push('  此刻（' + nowLabel + '）尚未进入日程安排，接下来是：' + (next.time ? next.time + ' ' : '') + (next.place ? '@' + next.place + ' ' : '') + next.content);
          }
        }
        if (rec.attire) lines.push('  穿着：' + rec.attire);
        var bl = normalizeBelongings(rec.belongings);
        if (bl.length) lines.push('  随身物品：' + bl.map(function (b) { return b.name + (b.note ? '（' + b.note + '）' : ''); }).join('、'));
        if (rec.location) lines.push('  当前位置：' + rec.location);
        var sp = specialOf(rec);
        if (sp.menstruation.on) lines.push('  生理期：' + [sp.menstruation.level, sp.menstruation.note].filter(Boolean).join('；') + '（请对' + (p.isMe ? '用户' : p.name) + '多加照顾，别安排剧烈活动）');
        if (sp.illness.on) lines.push('  身体不适：' + [sp.illness.name, sp.illness.level, sp.illness.note].filter(Boolean).join('；') + '（回复要体现出状态不佳）');
        if (rec.note) lines.push('  备注：' + rec.note);
        if (lines.length) out.push('【' + p.name + '（' + (p.isMe ? '用户' : '角色') + '）今天的真实状态 · ' + prettyDate(ds) + '】\n' + lines.join('\n'));
      }
      if (!out.length) return '';
      return '以下是你们今天的真实生活状态（由仪轨记录）：\n' + out.join('\n') +
        '\n【铁律】如果对话涉及"你现在在做什么 / 在哪 / 穿着 / 带着什么"，必须以标了 ★ 的此刻状态为准，不能与之矛盾；也不要生硬复述这些条目，自然融入即可。';
    } catch (e) { return ''; }
  }

  // ==================== 初始化 ====================
  async function init() {
    var body = document.getElementById('yigui-body');
    if (!body) return;
    if (!state.inited) {
      state.inited = true;
      try {
        var ex = localStorage.getItem(LS_EXPAND);
        if (ex) state.expanded = Object.assign(state.expanded, JSON.parse(ex) || {});
      } catch (e) {}
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
    openWardrobe: openWardrobe,
    _state: state
  };
  window.initYiguiApp = function () { init(); };
})();
