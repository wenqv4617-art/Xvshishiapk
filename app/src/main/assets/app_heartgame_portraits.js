/**
 * app_heartgame_portraits.js - 心动游戏 · 立绘与背景管理器 (P)
 * ============================================================================
 * 职责：
 *   1. 资产格式支持：Live2D（moc3 / model3.json 模型包）与静态高清 PNG/WebP 立绘、场景背景
 *   2. 多立绘轮换：单角色绑定多套服装 / 形态，可设为「当前主页展示」
 *   3. 热区涂抹划分：可视化掩码编辑画布（头发 / 面部 / 颈部 / 胸腹 / 手部 / 腿部 …）
 *      并绑定各热区的交互等级与好感阶段响应动作库
 *   4. 场景背景管理：自定义背景 + 场景属性标注（雨天 / 卧室 / 校园 / 黄昏 …）
 *   5. 资源池与生命周期：统一 LRU 缓存 + 页面销毁时主动卸载（杜绝内存溢出）
 *
 * 依赖：window.HeartGame.K / .H / .U / .C（app_heartgame_core.js）
 * 工程红线同 core：纯经典脚本 / 无 emoji / 无原生弹窗 / 淡彩配色 / LF
 */
(function () {
  'use strict';

  var HG = window.HeartGame;
  if (!HG) { console.warn('[心动游戏] core 未加载，立绘管理器已跳过'); return; }
  var K = HG.K, H = HG.H, U = HG.U, C = HG.C;

  // ==========================================================================
  //  1. 资源池（LRU）：所有大图 / 模型都经此进出，页面销毁时可整体卸载
  // ==========================================================================

  function AssetPool(limit) {
    this.limit = limit || C.ASSET_POOL_LIMIT || 8;
    this.map = Object.create(null);   // key -> {key, kind, url, bytes, at}
    this.order = [];                  // 最近使用在前
  }

  /** 登记一份资源；超出上限时回收最久未使用的（若是 blob URL 主动 revoke） */
  AssetPool.prototype.acquire = function (key, entry) {
    var rec = this.map[key];
    if (rec) {
      this._promote(key);
      rec.at = Date.now();
      return rec;
    }
    rec = {
      key: key,
      kind: (entry && entry.kind) || 'image',
      url: (entry && entry.url) || '',
      bytes: (entry && entry.bytes) || 0,
      objectUrl: !!(entry && entry.objectUrl),
      at: Date.now()
    };
    this.map[key] = rec;
    this.order.unshift(key);
    this._evict();
    return rec;
  };

  AssetPool.prototype.get = function (key) {
    var rec = this.map[key];
    if (rec) this._promote(key);
    return rec || null;
  };

  AssetPool.prototype._promote = function (key) {
    var i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
    this.order.unshift(key);
  };

  /** 回收：只回收真正的内存占用（blob URL / Live2D 实例），用户数据留在 IndexedDB 不动 */
  AssetPool.prototype.release = function (key) {
    var rec = this.map[key];
    if (!rec) return false;
    if (rec.objectUrl && rec.url) { try { URL.revokeObjectURL(rec.url); } catch (e) {} }
    if (rec.kind === 'live2d' && rec.instance && typeof rec.instance.destroy === 'function') {
      try { rec.instance.destroy(); } catch (e) {}
    }
    delete this.map[key];
    var i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
    return true;
  };

  AssetPool.prototype._evict = function () {
    while (this.order.length > this.limit) {
      var drop = this.order[this.order.length - 1];
      this.release(drop);
    }
  };

  /** 页面销毁：清空全部 */
  AssetPool.prototype.clear = function () {
    var self = this;
    this.order.slice().forEach(function (k) { self.release(k); });
    this.map = Object.create(null);
    this.order = [];
  };

  AssetPool.prototype.stats = function () {
    var bytes = 0, self = this;
    this.order.forEach(function (k) { bytes += (self.map[k] && self.map[k].bytes) || 0; });
    return { count: this.order.length, limit: this.limit, bytes: bytes };
  };

  // ==========================================================================
  //  2. Live2D 运行时加载器
  //     —— 项目本身不内置 Cubism 运行时（体积 / 授权原因），因此这里做成
  //        「可配置 URL 的按需加载 + 静态立绘兜底」：用户给出运行时地址即可启用
  //        Live2D；没有运行时则无缝回落到 2D 立绘 + CSS 物理动效，功能不降级。
  // ==========================================================================

  var Live2DLoader = {
    RUNTIME_KEY: 'hg-live2d-runtime-url',
    SCRIPT_KEY: 'hg-live2d-script-url',
    _loading: null,
    _ready: false,

    runtimeUrl: function () {
      try { return localStorage.getItem(Live2DLoader.RUNTIME_KEY) || ''; } catch (e) { return ''; }
    },
    setRuntimeUrl: function (url) {
      try { localStorage.setItem(Live2DLoader.RUNTIME_KEY, String(url || '')); } catch (e) {}
      Live2DLoader._ready = false;
      Live2DLoader._loading = null;
    },
    scriptUrl: function () {
      try { return localStorage.getItem(Live2DLoader.SCRIPT_KEY) || ''; } catch (e) { return ''; }
    },
    setScriptUrl: function (url) {
      try { localStorage.setItem(Live2DLoader.SCRIPT_KEY, String(url || '')); } catch (e) {}
    },

    /** 是否已具备可用运行时 */
    available: function () {
      if (typeof window.Live2D === 'undefined' && typeof window.PIXI === 'undefined') return false;
      if (typeof window.Live2D !== 'undefined' && window.Live2D) return true;
      return false;
    },

    /**
     * 按需加载运行时脚本（可选）。失败只返回 false，绝不抛错。
     * @returns {Promise<boolean>}
     */
    ensure: function () {
      if (Live2DLoader.available()) { Live2DLoader._ready = true; return Promise.resolve(true); }
      if (Live2DLoader._loading) return Live2DLoader._loading;
      var scriptUrl = Live2DLoader.scriptUrl();
      if (!scriptUrl) return Promise.resolve(false);
      Live2DLoader._loading = new Promise(function (resolve) {
        var s = document.createElement('script');
        var done = false;
        var finish = function (ok) {
          if (done) return; done = true;
          Live2DLoader._ready = !!ok;
          resolve(!!ok);
        };
        s.src = scriptUrl;
        s.async = true;
        s.onload = function () { finish(Live2DLoader.available()); };
        s.onerror = function () { console.warn('[心动游戏] Live2D 运行时加载失败：' + scriptUrl); finish(false); };
        setTimeout(function () { finish(Live2DLoader.available()); }, 12000);
        document.head.appendChild(s);
      });
      return Live2DLoader._loading;
    },

    /**
     * 尝试在容器里创建 Live2D 实例。
     * 兼容两种常见形态：
     *   · Cubism 2 风格：window.Live2D.loadModel + Live2DModelWebGL（pixi-live2d-display 的旧 API）
     *   · 自定义工厂：window.HeartGameLive2DFactory(canvas, modelUrl) 返回 {update, destroy}
     * @returns {Promise<object|null>} 实例或 null（null 表示回落静态立绘）
     */
    mount: function (canvas, modelUrl) {
      return Live2DLoader.ensure().then(function (ok) {
        if (!ok || !modelUrl) return null;
        // ① 用户自带工厂优先
        if (typeof window.HeartGameLive2DFactory === 'function') {
          try {
            var inst = window.HeartGameLive2DFactory(canvas, modelUrl);
            if (inst && typeof inst.update === 'function') return inst;
          } catch (e) { console.warn('[心动游戏] 自定义 Live2D 工厂失败:', e); }
        }
        // ② Cubism 2 官方 API
        try {
          if (window.Live2D && typeof window.Live2D.loadModel === 'function') {
            var model = window.Live2D.loadModel(modelUrl);
            if (!model) return null;
            var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (!gl) return null;
            var glModel = new window.Live2DModelWebGL(canvas);
            glModel.loadModel(model);
            var raf = null, alive = true;
            var start = Date.now();
            var tick = function () {
              if (!alive) return;
              var t = (Date.now() - start) / 1000;
              try {
                glModel.setParamFloat('PARAM_ANGLE_X', 12 * Math.sin(t * 0.5));
                glModel.setParamFloat('PARAM_ANGLE_Y', 6 * Math.sin(t * 0.42));
                glModel.setParamFloat('PARAM_BREATH', 0.5 + 0.5 * Math.sin(t * 1.1));
              } catch (e) {}
              try { glModel.updateParam(); glModel.update(); } catch (e) {}
              raf = requestAnimationFrame(tick);
            };
            tick();
            return {
              kind: 'live2d',
              update: function () { },
              setExpression: function () { },
              destroy: function () {
                alive = false;
                if (raf) cancelAnimationFrame(raf);
                try { glModel.releaseModel && glModel.releaseModel(); } catch (e) {}
              }
            };
          }
        } catch (e) { console.warn('[心动游戏] Cubism 实例创建失败:', e); }
        return null;
      });
    }
  };

  // ==========================================================================
  //  2.5 ZIP 模型包导入（Live2D 最省事的用法）
  //      用户手上通常是「一个 zip 里塞着 moc3 + model3.json + 贴图 + 物理」，
  //      所以这里引入 JSZip，把整包解成内存文件表 → 每个文件生成 blob URL →
  //      把 model3.json 里的相对路径改写成 blob URL → 得到一个可直接加载的模型入口。
  //      JSZip 按需从 CDN 拉（与 dexie 同源 unpkg，已进 SW 缓存），失败不阻塞其它功能。
  // ==========================================================================

  var ZipModel = {
    CDN: 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
    _loading: null,
    _ready: false,

    /** 是否已具备 JSZip */
    available: function () { return typeof window.JSZip !== 'undefined' && !!window.JSZip; },

    /**
     * 按需加载 JSZip（本地没有就从 CDN 拉一次）
     * @returns {Promise<boolean>}
     */
    ensure: function () {
      if (ZipModel.available()) { ZipModel._ready = true; return Promise.resolve(true); }
      if (ZipModel._loading) return ZipModel._loading;
      ZipModel._loading = new Promise(function (resolve) {
        var s = document.createElement('script');
        var done = false;
        var finish = function (ok) {
          if (done) return; done = true;
          ZipModel._ready = !!ok;
          if (!ok) console.warn('[心动游戏] JSZip 加载失败，zip 导入不可用');
          resolve(!!ok);
        };
        s.src = ZipModel.CDN;
        s.async = true;
        s.onload = function () { finish(ZipModel.available()); };
        s.onerror = function () { finish(false); };
        setTimeout(function () { finish(ZipModel.available()); }, 15000);
        (document.head || document.documentElement).appendChild(s);
      });
      return ZipModel._loading;
    },

    /** 取相对路径的目录名（'' 或 'foo/' 或 'a/b/'） */
    _dirOf: function (p) {
      var i = String(p).lastIndexOf('/');
      return i >= 0 ? String(p).slice(0, i + 1) : '';
    },

    /** 归一化 zip 内路径（去 ./、去前导 /） */
    _norm: function (p) {
      return String(p || '').replace(/^\.\//, '').replace(/^\/+/, '');
    },

    /** 以 base 为基准解析相对路径 */
    _resolve: function (base, rel) {
      if (/^(https?:|blob:|data:)/i.test(rel)) return rel;
      var stack = (base + rel).split('/');
      var out = [];
      for (var i = 0; i < stack.length; i++) {
        var seg = stack[i];
        if (seg === '' && i > 0) continue;
        if (seg === '.') continue;
        if (seg === '..') { out.pop(); continue; }
        out.push(seg);
      }
      return out.join('/');
    },

    /** MIME */
    _mime: function (name) {
      var n = String(name).toLowerCase();
      if (/\.json$/.test(n)) return 'application/json';
      if (/\.moc3?$/.test(n)) return 'application/octet-stream';
      if (/\.png$/.test(n)) return 'image/png';
      if (/\.jpe?g$/.test(n)) return 'image/jpeg';
      if (/\.webp$/.test(n)) return 'image/webp';
      if (/\.(mp3|wav|m4a|ogg)$/.test(n)) return 'audio/mpeg';
      return 'application/octet-stream';
    },

    /**
     * 解析一个 zip 模型包
     * @param {File|Blob} file
     * @param {Function} onProgress (stage, detail)
     * @returns {Promise<{ name, jsonPath, entryUrl, fileCount, files:[{path,url,size}], _urls }>}
     */
    parse: async function (file, onProgress) {
      var report = function (s, d) { if (typeof onProgress === 'function') onProgress(s, d); };
      report('loading-lib', '正在准备解压组件…');
      var haveLib = await ZipModel.ensure();
      if (!haveLib) throw new Error('解压组件加载失败（JSZip CDN 不可达），请检查网络后重试');

      report('reading', '正在读取压缩包…');
      var zip = await window.JSZip.loadAsync(file);

      // 收集全部文件
      var entries = [];
      zip.forEach(function (path, entry) {
        if (entry.dir) return;
        var p = ZipModel._norm(path);
        if (!p || /(^|\/)__MACOSX\//.test(p) || /(^|\/)\._/.test(p) || /(^|\/)\.DS_Store$/.test(p)) return;
        entries.push({ path: p, entry: entry });
      });
      if (!entries.length) throw new Error('压缩包里没有找到任何文件');

      report('extracting', '正在解出 ' + entries.length + ' 个文件…');
      var urls = {};      // path -> blobURL
      var files = [];
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var blob = await e.entry.async('blob');
        var typed = new Blob([blob], { type: ZipModel._mime(e.path) });
        var u = URL.createObjectURL(typed);
        urls[e.path] = u;
        files.push({ path: e.path, url: u, size: typed.size });
      }

      // 找模型入口：优先 model3.json，其次任何 .json
      var jsonCandidates = entries.filter(function (e) { return /\.model3\.json$/i.test(e.path); });
      if (!jsonCandidates.length) jsonCandidates = entries.filter(function (e) { return /\.json$/i.test(e.path); });
      // 优先选「同目录下存在 .moc3」的那个 json
      var mocPaths = entries.filter(function (e) { return /\.moc3$/i.test(e.path); }).map(function (e) { return e.path; });
      var jsonEntry = null;
      for (var j = 0; j < jsonCandidates.length; j++) {
        var dir = ZipModel._dirOf(jsonCandidates[j].path);
        if (mocPaths.some(function (m) { return ZipModel._dirOf(m) === dir; })) { jsonEntry = jsonCandidates[j]; break; }
      }
      if (!jsonEntry) jsonEntry = jsonCandidates[0];
      if (!jsonEntry) {
        throw new Error(mocPaths.length
          ? '找到了 moc3 模型文件，但缺少配套的 model3.json（Live2D 需要它来描述模型结构）'
          : '这个压缩包里没有 .moc3 模型文件，可能不是 Live2D 模型包');
      }

      report('rewriting', '正在改写模型内的资源引用…');
      var jsonText = await jsonEntry.entry.async('string');
      var model = null;
      try { model = JSON.parse(jsonText); } catch (e) { model = null; }
      if (!model) throw new Error('model3.json 解析失败（文件可能已损坏）');

      var baseDir = ZipModel._dirOf(jsonEntry.path);
      var selfBase = jsonEntry.path;
      var mapped = 0, missing = [];

      var mapPath = function (rel) {
        if (!rel || typeof rel !== 'string') return rel;
        if (/^(https?:|blob:|data:)/i.test(rel)) return rel;
        var target = ZipModel._resolve(baseDir, ZipModel._norm(rel));
        if (urls[target]) { mapped++; return urls[target]; }
        // 有些包会把路径写成含自身文件名前缀，再试一次去前缀
        var alt = ZipModel._resolve(baseDir, ZipModel._norm(rel.replace(/^[^/]*\.model3\.json\//, '')));
        if (urls[alt]) { mapped++; return urls[alt]; }
        missing.push(rel);
        return rel;
      };

      try {
        if (model.FileReferences) {
          var fr = model.FileReferences;
          if (fr.Moc) fr.Moc = mapPath(fr.Moc);
          if (Array.isArray(fr.Textures)) fr.Textures = fr.Textures.map(mapPath);
          if (Array.isArray(fr.Physics)) fr.Physics = fr.Physics.map(mapPath);
          if (Array.isArray(fr.Pose)) fr.Pose = fr.Pose.map(mapPath);
          if (Array.isArray(fr.Expressions)) {
            fr.Expressions.forEach(function (x) { if (x && x.File) x.File = mapPath(x.File); });
          }
          if (Array.isArray(fr.Motions)) {
            fr.Motions.forEach(function (g) {
              if (g && Array.isArray(g.File)) g.File = mapPath(g.File);
            });
          }
          if (fr.DisplayInfo) fr.DisplayInfo = mapPath(fr.DisplayInfo);
        }
      } catch (e2) {
        console.warn('[心动游戏] 模型引用改写时出错（继续用原始路径）:', e2);
      }

      // 入口模型本身也用 blob URL（避免依赖原 zip 路径）
      var entryBlob = new Blob([JSON.stringify(model)], { type: 'application/json' });
      var entryUrl = URL.createObjectURL(entryBlob);
      urls[selfBase] = entryUrl;

      return {
        name: (model && (model.name || (model.FileReferences && model.FileReferences.Moc))) || file.name.replace(/\.zip$/i, ''),
        jsonPath: jsonEntry.path,
        entryUrl: entryUrl,
        fileCount: files.length,
        mocFound: mocPaths.length > 0,
        mapped: mapped,
        missing: missing,
        files: files,
        urls: urls
      };
    },

    /** 释放一次导入占用的 blob URL（页面销毁或换模型时调用） */
    release: function (record) {
      if (!record || !record.urls) return 0;
      var n = 0;
      Object.keys(record.urls).forEach(function (k) {
        try { URL.revokeObjectURL(record.urls[k]); n++; } catch (e) { }
      });
      return n;
    }
  };

  // ==========================================================================
  //  3. 静态立绘渲染器（Live2D 不可用时的主力：CSS 物理动效 + 热区触控）
  // ==========================================================================

  function SpriteRenderer(opts) {
    this.opts = opts || {};
    this.root = null;
    this.img = null;
    this.overlay = null;
    this.portraitId = null;
    this.hotspots = null;
    this._blinkTimer = null;
    this._hitCount = 0;
  }

  /**
   * 挂载到容器
   * @param {HTMLElement} host
   * @param {object} portrait {id, kind, src}
   * @param {object} cfg { fit:'contain'|'cover', onTouch(key, ev), editable, showOverlay }
   */
  SpriteRenderer.prototype.mount = function (host, portrait, cfg) {
    var o = cfg || {};
    this.teardown();
    this.portraitId = portrait ? portrait.id : null;
    this.hotspots = K.hotspotsOf(this.portraitId);

    var root = H.el('div', { class: 'hg-stage hg-rise' });
    root.style.cssText = 'position:absolute; inset:0; overflow:hidden;';
    this.root = root;

    // 立绘图片层
    var img = H.el('img', { class: 'hg-portrait-img', alt: '' });
    img.style.cssText = 'position:absolute; left:50%; bottom:0; transform:translateX(-50%);'
      + 'width:auto; height:100%; max-width:100%; object-fit:' + (o.fit || 'contain') + ';'
      + 'transform-origin:50% 92%; user-select:none; -webkit-user-drag:none;'
      + 'filter:drop-shadow(0 18px 34px rgba(140,110,140,0.24));';
    if (portrait && portrait.src) img.src = portrait.src;
    // 立绘不存在时给一个优雅的剪影占位（不是破图）
    img.onerror = function () {
      img.style.display = 'none';
      root.insertBefore(Portraits.silhouette(), root.firstChild);
    };
    this.img = img;
    root.appendChild(img);

    // 热区层
    var overlay = H.el('div', { class: 'hg-hotspot-layer' });
    overlay.style.cssText = 'position:absolute; inset:0;';
    this.overlay = overlay;
    root.appendChild(overlay);
    if (o.showOverlay !== false) this.renderHotspots(o);

    host.appendChild(root);
    return root;
  };

  /** 渲染热区（可交互 / 可编辑两种形态） */
  SpriteRenderer.prototype.renderHotspots = function (cfg) {
    var o = cfg || this.opts || {};
    var self = this;
    var overlay = this.overlay;
    if (!overlay) return;
    overlay.innerHTML = '';
    var spots = this.hotspots || {};

    C.HOTSPOTS.forEach(function (spot) {
      var g = spots[spot.key];
      if (!g) return;
      var d = H.el('div', {
        class: 'hg-touch' + (o.editable ? ' hg-touch-edit' : ''),
        'data-key': spot.key,
        title: o.editable ? (spot.name + '（拖动调整位置，滚轮/双指缩放）') : spot.hint
      });
      var w = (g.rx * 2 * 100), hh = (g.ry * 2 * 100);
      d.style.cssText = 'position:absolute; left:' + (g.x * 100) + '%; top:' + (g.y * 100) + '%;'
        + 'width:' + w + '%; height:' + hh + '%;'
        + 'transform:translate(-50%,-50%); border-radius:50%; cursor:pointer;'
        + 'background:' + (o.editable ? 'rgba(217,127,168,0.20)' : 'rgba(255,255,255,0.001)') + ';'
        + 'border:' + (o.editable ? '1.5px dashed rgba(217,127,168,0.85)' : 'none') + ';'
        + 'box-shadow:' + (o.editable && o.selectedKey === spot.key ? '0 0 0 3px rgba(217,127,168,0.35)' : 'none') + ';'
        + 'touch-action:none;';
      if (o.editable) {
        d.innerHTML = '<span style="position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);'
          + 'font-size:10px; font-weight:800; color:#8f5d78; background:rgba(255,255,255,0.86); padding:1px 6px;'
          + 'border-radius:8px; white-space:nowrap;">' + U.esc(spot.name) + '</span>';
        self._bindEdit(d, spot.key);
      } else {
        d.onclick = function (ev) {
          ev.stopPropagation();
          d.classList.add('hg-hit');
          setTimeout(function () { d.classList.remove('hg-hit'); }, 720);
          if (typeof o.onTouch === 'function') o.onTouch(spot.key, ev, spot);
        };
      }
      overlay.appendChild(d);
    });
  };

  /** 编辑模式：拖动 / 缩放热区 */
  SpriteRenderer.prototype._bindEdit = function (node, key) {
    var self = this;
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    var rectOf = function () { return self.overlay.getBoundingClientRect(); };

    node.onpointerdown = function (ev) {
      ev.preventDefault();
      dragging = true;
      try { node.setPointerCapture(ev.pointerId); } catch (e) {}
      var r = rectOf();
      sx = ev.clientX; sy = ev.clientY;
      var g = self.hotspots[key];
      ox = g.x; oy = g.y;
      if (typeof self.opts.onSelect === 'function') self.opts.onSelect(key);
    };
    node.onpointermove = function (ev) {
      if (!dragging) return;
      ev.preventDefault();
      var r = rectOf();
      if (!r.width || !r.height) return;
      var nx = U.clamp(ox + (ev.clientX - sx) / r.width, 0, 1);
      var ny = U.clamp(oy + (ev.clientY - sy) / r.height, 0, 1);
      self.hotspots[key].x = nx;
      self.hotspots[key].y = ny;
      node.style.left = (nx * 100) + '%';
      node.style.top = (ny * 100) + '%';
    };
    var end = function (ev) {
      if (!dragging) return;
      dragging = false;
      try { node.releasePointerCapture(ev.pointerId); } catch (e) {}
      var g = self.hotspots[key];
      K.setHotspot(self.portraitId, key, g);
    };
    node.onpointerup = end;
    node.onpointercancel = end;

    // 滚轮缩放
    node.onwheel = function (ev) {
      ev.preventDefault();
      var g = self.hotspots[key];
      var f = ev.deltaY > 0 ? 0.94 : 1.06;
      g.rx = U.clamp(g.rx * f, 0.02, 0.6);
      g.ry = U.clamp(g.ry * f, 0.02, 0.6);
      node.style.width = (g.rx * 2 * 100) + '%';
      node.style.height = (g.ry * 2 * 100) + '%';
      K.setHotspot(self.portraitId, key, g);
    };
    // 双指缩放（触屏）
    var pinchStart = 0, pinchBase = 0;
    node.ontouchstart = function (ev) {
      if (ev.touches.length === 2) {
        pinchStart = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
        pinchBase = self.hotspots[key].rx;
      }
    };
    node.ontouchmove = function (ev) {
      if (ev.touches.length === 2 && pinchStart > 0) {
        ev.preventDefault();
        var d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX, ev.touches[0].clientY - ev.touches[1].clientY);
        var g = self.hotspots[key];
        var ratio = pinchBase * (d / pinchStart);
        g.rx = U.clamp(ratio, 0.02, 0.6);
        g.ry = U.clamp(ratio * 0.76, 0.02, 0.6);
        node.style.width = (g.rx * 2 * 100) + '%';
        node.style.height = (g.ry * 2 * 100) + '%';
      }
    };
    node.ontouchend = function () { pinchStart = 0; K.setHotspot(self.portraitId, key, self.hotspots[key]); };
  };

  /** 命中动画：物理反馈（呼吸加速 / 轻微摇晃 / 表情切换） */
  SpriteRenderer.prototype.react = function (key, expression) {
    if (!this.img) return;
    var img = this.img;
    img.classList.remove('hg-hit-react');
    // 强制重排以重启动画
    void img.offsetWidth;
    img.classList.add('hg-hit-react');
    setTimeout(function () { img.classList.remove('hg-hit-react'); }, 900);
    // 表情：用滤镜微调模拟（脸红 / 惊讶 / 移开视线）
    var filters = {
      blush: 'drop-shadow(0 18px 34px rgba(140,110,140,0.24)) saturate(1.16) brightness(1.03) hue-rotate(-6deg)',
      surprise: 'drop-shadow(0 18px 34px rgba(140,110,140,0.24)) brightness(1.06) contrast(1.04)',
      away: 'drop-shadow(0 18px 34px rgba(140,110,140,0.24)) saturate(0.94) brightness(0.99)',
      shy: 'drop-shadow(0 18px 34px rgba(140,110,140,0.24)) saturate(1.10) brightness(1.02)'
    };
    if (expression && filters[expression]) {
      img.style.filter = filters[expression];
      setTimeout(function () { img.style.filter = ''; }, 1400);
    }
    this._hitCount++;
  };

  SpriteRenderer.prototype.teardown = function () {
    if (this._blinkTimer) { clearInterval(this._blinkTimer); this._blinkTimer = null; }
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.root = null; this.img = null; this.overlay = null;
  };

  // ==========================================================================
  //  4. 主管理器 P
  // ==========================================================================

  var Portraits = {
    pool: new AssetPool(),
    renderer: null,
    live2d: null,
    _stage: null,

    live2dLoader: Live2DLoader,

    /** 静态立绘缺失时的剪影占位（不是 emoji，也不是破图） */
    silhouette: function () {
      var d = H.el('div');
      d.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center;';
      d.innerHTML = '<svg viewBox="0 0 200 320" width="56%" height="82%" fill="none" stroke="rgba(217,127,168,0.42)"'
        + ' stroke-width="2.2" stroke-linecap="round">'
        + '<path d="M100 26c22 0 36 16 36 38 0 12-4 22-10 29 16 6 27 15 29 30l6 60" />'
        + '<path d="M100 26c-22 0-36 16-36 38 0 12 4 22 10 29-16 6-27 15-29 30l-6 60" />'
        + '<path d="M64 93c0 34 16 58 36 58s36-24 36-58" />'
        + '<path d="M62 186c-10 30-14 66-12 108h100c2-42-2-78-12-108" />'
        + '<circle cx="84" cy="66" r="3.4" fill="rgba(217,127,168,0.42)"/>'
        + '<circle cx="116" cy="66" r="3.4" fill="rgba(217,127,168,0.42)"/>'
        + '<path d="M92 84c4 3 12 3 16 0" />'
        + '</svg>'
        + '<div style="position:absolute; bottom:14%; font-size:11px; color:#c3b0c0; letter-spacing:.16em;">'
        + '尚未上传立绘</div>';
      return d;
    },

    /**
     * 在看板容器里挂载立绘（Live2D 可用则 Live2D，否则静态 + 热区）
     * @param {HTMLElement} host
     * @param {object} cfg { onTouch, editable, onSelect, fit }
     * @returns {Promise<object>} { kind:'live2d'|'sprite', renderer }
     */
    mount: async function (host, cfg) {
      var o = cfg || {};
      Portraits.teardown();
      Portraits._stage = host;
      var portrait = K.currentPortrait();
      if (!portrait) {
        // 没有立绘：直接渲染剪影 + 默认热区，功能仍可用
        var shell = H.el('div');
        shell.style.cssText = 'position:absolute; inset:0;';
        shell.appendChild(Portraits.silhouette());
        var r0 = new SpriteRenderer(o);
        r0.portraitId = 'default';
        r0.hotspots = K.hotspotsOf('default');
        var layer = H.el('div');
        layer.style.cssText = 'position:absolute; inset:0;';
        r0.overlay = layer;
        shell.appendChild(layer);
        r0.root = shell;
        r0.renderHotspots(o);
        host.appendChild(shell);
        Portraits.renderer = r0;
        return { kind: 'sprite', renderer: r0, portrait: null };
      }

      // 资源池登记
      if (portrait.src) {
        Portraits.pool.acquire('portrait:' + portrait.id, { kind: 'image', url: portrait.src });
        K.touchAsset(HG.C.ASSET_PREFIX.portrait + portrait.id);
      }

      // Live2D 路径
      if (portrait.kind === 'live2d' && portrait.modelUrl) {
        var canvas = H.el('canvas');
        canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
        host.appendChild(canvas);
        var inst = await Live2DLoader.mount(canvas, portrait.modelUrl);
        if (inst) {
          Portraits.live2d = inst;
          Portraits.pool.acquire('live2d:' + portrait.id, { kind: 'live2d', url: portrait.modelUrl, instance: inst });
          // Live2D 也要能戳：叠一层热区
          var rl = new SpriteRenderer(o);
          rl.portraitId = portrait.id;
          rl.hotspots = K.hotspotsOf(portrait.id);
          var ovl = H.el('div');
          ovl.style.cssText = 'position:absolute; inset:0;';
          rl.overlay = ovl;
          rl.root = ovl;
          host.appendChild(ovl);
          rl.renderHotspots(o);
          Portraits.renderer = rl;
          return { kind: 'live2d', renderer: rl, portrait: portrait };
        }
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }

      // 静态立绘路径
      var r = new SpriteRenderer(o);
      r.mount(host, portrait, o);
      Portraits.renderer = r;
      return { kind: 'sprite', renderer: r, portrait: portrait };
    },

    /**
     * 触控反应：**优先交给模型生成**（暧昧/细腻的地方必须是 AI 现写，而不是背预设），
     * 生成不可用时才回落到动作库 / 内置分部位文案库。
     * 生成成功的结果会顺手写进动作库，作为该部位该阶段的「已解锁台词」沉淀下来。
     */
    react: async function (key, ctx) {
      var o = ctx || {};
      var portraitId = (K.currentPortrait() || {}).id || 'default';
      var profile = await K.charProfile();
      var tier = K.tier();
      var reverse = K.isReverse();
      var tierIdx = K.tierIndex();

      // ① 首选：让模型基于角色设定 + 当前阶梯现写一句
      //    （戳戳是高频交互，缓存命中同一阶梯时直接复用，避免每次都打接口）
      var cacheKey = portraitId + '|' + key + '|' + tier.key + '|' + (o.mood || K.state.quiet.mood);
      var cached = Portraits._reactCache[cacheKey];
      if (cached && Date.now() - cached.at < 3 * 60 * 1000) {
        return { text: cached.text, source: 'cache', expression: cached.expression || 'blush' };
      }

      var spot = C.HOTSPOTS.filter(function (s) { return s.key === key; })[0] || { name: '身体', hint: '碰了一下' };
      var mood = K.moodOf(o.mood || K.state.quiet.mood);
      var prompt = '你正在扮演「' + profile.name + '」。\n'
        + '角色设定：' + U.cut(profile.persona || '（未填写，按名字气质自行发挥）', 420) + '\n'
        + '当前关系阶段：' + tier.name + '（第 ' + (tierIdx + 1) + '/6 阶）\n'
        + '当前身份：' + (reverse ? 'TA 是被你攻略的看板角色，你是疯狂心动的玩家' : '你是被攻略的一方，TA 是玩家') + '\n'
        + '此刻心情：' + mood.name + '\n'
        + '事件：玩家在看板上碰了你的「' + spot.name + '」（' + spot.hint + '）\n\n'
        + '请输出你对这个动作的**第一反应**：一句 18~38 字的中文短句，包含一个细微的身体反应或表情，'
        + '符合当前阶段该有的距离感（相识阶段克制、眷恋之后可以不掩饰）。\n'
        + '不要写旁白括号，不要写你的名字，不要解释，直接给这一句话。';
      var out = await K.ask(prompt, { temperature: 0.95 });
      if (out) {
        var clean = String(out).replace(/^["「『]|["」』]$/g, '').replace(/\n+/g, ' ').trim();
        if (clean) {
          Portraits._reactCache[cacheKey] = { text: clean, at: Date.now(), expression: 'blush' };
          // 沉淀成该部位该阶段的专属台词（下次即使离线也能用上）
          K.pushHotspotAction(portraitId, key, { text: clean, tier: tier.key });
          return { text: clean, source: 'llm', expression: 'blush' };
        }
      }

      // ② 回落：已解锁的动作库（同部位、同阶梯或更早的）
      var lib = K.hotspotActionsOf(portraitId, key);
      var usable = lib.filter(function (a) {
        return K.tierIndex(a.tier || 'acquaint') <= tierIdx;
      });
      if (usable.length) {
        var pick = usable[Math.floor(Math.random() * usable.length)];
        return { text: pick.text, source: 'library', expression: 'blush' };
      }

      // ③ 最后兜底：内置分部位 × 分阶梯反应库（保证没 API 也有反馈）
      return { text: Portraits.fallbackLine(key, tierIdx, profile.name), source: 'fallback', expression: 'shy' };
    },

    /** 戳戳反应的短时缓存（同一阶梯同一部位 3 分钟内复用，省接口也更稳） */
    _reactCache: {},

    /** 内置反应库：7 部位 × 6 阶梯分档 */
    fallbackLine: function (key, tierIdx, name) {
      var L = {
        hair: [
          '你碰到发梢的一瞬间，TA 微微偏了偏头，没有躲开。',
          'TA 任由你把那缕头发拨到耳后，喉结轻轻动了一下。',
          '被揉乱头发时 TA 皱了皱眉，却还是低着头让你摸。',
          'TA 抓住你的手腕按在发顶：「再摸一会儿也不是不行。」',
          'TA 把下巴搁到你手心里蹭了蹭，像一只终于肯靠过来的猫。',
          '「头发乱了也没关系，」TA 低声说，「你摸的地方我一直留着。」'
        ],
        face: [
          '指尖擦过脸颊，TA 睫毛颤了一下，视线落到别处。',
          'TA 没躲，只是耳尖慢慢红了一点。',
          '被碰到脸颊时 TA 屏住了呼吸，唇角压不住地翘。',
          'TA 顺势把脸贴进你掌心，闭了一下眼。',
          'TA 侧过脸吻了一下你的指节，抬眼看你。',
          '「别停，」TA 把脸埋得更深了些，「就当我贪心。」'
        ],
        neck: [
          '颈侧的触碰让 TA 明显僵了半秒，随后若无其事地咳了一声。',
          'TA 微微仰头让开，声音有点哑：「……手别乱放。」',
          '被碰到脖颈时 TA 抓住了你的手腕，却没有推开。',
          'TA 顺着你的力道偏过头，把颈线交给你。',
          'TA 的呼吸压在喉咙里，低声说了一句听不清的话。',
          '「这里只有你能碰，」TA 按住你的手，「记住了。」'
        ],
        chest: [
          '掌心贴上来的位置太靠前，TA 后退半步，耳根却红了。',
          'TA 没有推开，只是把手覆在你手背上，隔着一层布料。',
          '心跳隔着衣料砸在你掌心里，一下比一下快。',
          'TA 把你的手按得更紧了些：「听清楚了吗。」',
          'TA 低头看着你的手，眼神沉下来又软下去。',
          '「它一直这样，」TA 说，「从你开始出现的那天起。」'
        ],
        arm: [
          '你拉住小臂时 TA 顿住脚步，回头看了你一眼。',
          'TA 没抽手，只是把袖子往下扯了扯。',
          'TA 反手把小臂让给你，像是默认了这种靠近。',
          'TA 顺势把你的手拉进自己臂弯里。',
          'TA 的指腹在你手肘内侧按了按，像在确认什么。',
          '「拉着吧，」TA 把手腕递给你，「反正我也不打算走。」'
        ],
        hand: [
          '指尖刚碰到就被 TA 抽走了，动作快得像被烫到。',
          'TA 顿了一下，还是把手留在了原处。',
          'TA 的手指试探着弯了弯，勾住了你半根指节。',
          'TA 反手扣住你，十指交叠，没有松开的意思。',
          'TA 把你的手翻过来，指腹一寸寸碾过你的掌纹。',
          '「这样扣着，」TA 说，「以后谁都不许先松。」'
        ],
        leg: [
          '膝盖撞在一起的瞬间 TA 往旁边挪了挪，给两个人留了空隙。',
          'TA 没挪，只是把腿并得更紧了些。',
          '隔着衣料的一点温度让 TA 停下了手里的事。',
          'TA 的膝盖轻轻抵着你，像是无意的，也像是不想你走。',
          'TA 的腿侧贴上来，没有移开。',
          '「别动，」TA 低声说，「就保持这样一会儿。」'
        ]
      };
      var arr = L[key] || L.hand;
      var i = U.clamp(Math.round((tierIdx / 5) * (arr.length - 1)), 0, arr.length - 1);
      return arr[i];
    },

    /**
     * 抠出一层热区掩码（SVG 路径），供后台管理里叠加显示 / 导出
     * @returns {string} svg 元素 HTML
     */
    maskSvg: function (portraitId, opts) {
      var o = opts || {};
      var spots = K.hotspotsOf(portraitId);
      var paths = C.HOTSPOTS.map(function (s) {
        var g = spots[s.key];
        if (!g) return '';
        var d = H.SHAPES.ellipse(g.x * 100, g.y * 100, g.rx * 100, g.ry * 100);
        return '<path d="' + d + '" fill="' + (o.fill || 'rgba(217,127,168,0.24)') + '"'
          + ' stroke="' + (o.stroke || 'rgba(217,127,168,0.75)') + '" stroke-width="0.6" data-key="' + s.key + '"/>';
      }).join('');
      return '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute; inset:0; width:100%;'
        + 'height:100%; pointer-events:none;">' + paths + '</svg>';
    },

    // ------------------------------------------------------------------
    //  4.1 立绘管理面板（多立绘轮换 / 上传 / Live2D 模型）
    // ------------------------------------------------------------------

    openManager: function (onChanged) {
      var body = H.el('div');

      function refresh() {
        body.innerHTML = '';
        var cur = K.state.assets.portraits;
        if (!cur.length) {
          body.appendChild(H.empty('还没有上传立绘。上传一张高清立绘，或绑定 Live2D 模型包。', { icon: 'portrait' }));
        }
        cur.forEach(function (p) {
          var isCur = K.state.assets.currentPortraitId === p.id;
          var row = H.listRow({
            icon: p.kind === 'live2d' ? 'sparkle' : 'portrait',
            color: isCur ? '#D97FA8' : '#9FB3D9',
            soft: isCur ? '#FFEBF3' : '#EDF2FB',
            title: p.name,
            subtitle: (p.kind === 'live2d' ? 'Live2D 模型包' : '静态立绘') + ' · ' + (p.tags && p.tags.length ? p.tags.join(' / ') : '未标注'),
            subtitleWrap: true,
            rightNode: (function () {
              var box = H.el('div');
              box.style.cssText = 'display:flex; align-items:center; gap:6px; flex-shrink:0;';
              if (isCur) box.appendChild(H.chip('主页展示', { color: '#D97FA8', soft: '#FFEBF3' }));
              else {
                var setB = H.button('设为当前', { kind: 'soft', pad: '5px 9px', size: 10.5, soft: '#FFEBF3', color: '#B0728F' });
                setB.onclick = function (ev) {
                  ev.stopPropagation();
                  K.setCurrentPortrait(p.id);
                  H.toast('已设为当前主页展示');
                  refresh();
                  if (typeof onChanged === 'function') onChanged();
                };
                box.appendChild(setB);
              }
              var del = H.iconButton('trash', { size: 28, color: '#c2607c' });
              del.onclick = function (ev) {
                ev.stopPropagation();
                H.confirm({
                  title: '删除立绘', icon: 'trash', accent: '#c2607c', soft: '#FFEFF3',
                  message: '确定删除「' + p.name + '」吗？该立绘的热区划分与动作库也会一并清除。',
                  okText: '删除'
                }).then(function (ok) {
                  if (!ok) return;
                  K.removePortrait(p.id);
                  H.toast('已删除');
                  refresh();
                  if (typeof onChanged === 'function') onChanged();
                });
              };
              box.appendChild(del);
              return box;
            })()
          });
          row.onclick = null;
          body.appendChild(row);
        });

        // Live2D 运行时配置
        body.appendChild(H.sectionTitle('Live2D 运行时', { color: '#B79EDC' }));
        body.appendChild((function () {
          var r = H.el('div');
          r.style.cssText = 'background:rgba(255,255,255,0.7); border:1px solid rgba(183,158,220,0.25);'
            + 'border-radius:14px; padding:11px 12px; margin-bottom:10px;';
          r.innerHTML = '<div style="font-size:11px; line-height:1.7; color:#8b8292;">'
            + '项目不内置 Cubism 运行时（体积与授权原因）。填入运行时脚本地址后，'
            + 'Live2D 模型包即可直接驱动；留空则自动使用静态立绘 + CSS 物理动效，功能不受影响。'
            + '</div>';
          var input = H.el('input', { type: 'text', placeholder: '例如 https://your-host/live2d.min.js' });
          input.value = Live2DLoader.scriptUrl();
          input.style.cssText = 'width:100%; box-sizing:border-box; margin-top:9px; border-radius:11px;'
            + 'border:1px solid rgba(183,158,220,0.35); padding:8px 10px; font-size:11.5px; color:#5c4450;'
            + 'background:#fff; outline:none; font-family:inherit;';
          r.appendChild(input);
          var bar = H.el('div');
          bar.style.cssText = 'display:flex; gap:8px; margin-top:9px;';
          var saveB = H.button('保存运行时地址', { kind: 'soft', block: true, soft: '#F3EEFF', color: '#7d63a8' });
          saveB.onclick = function () {
            Live2DLoader.setScriptUrl(input.value.trim());
            H.toast(input.value.trim() ? '已保存，重新进入看板生效' : '已清空，将使用静态立绘');
          };
          var testB = H.button('检测', { kind: 'outline', color: '#7d63a8', border: 'rgba(183,158,220,0.5)', pad: '9px 14px' });
          testB.onclick = async function () {
            testB.textContent = '检测中…';
            var ok = await Live2DLoader.ensure();
            testB.textContent = '检测';
            H.modal({
              title: ok ? '运行时可用' : '运行时不可用',
              icon: ok ? 'check' : 'info',
              accent: ok ? '#7d63a8' : '#9FB3D9',
              message: ok
                ? '检测到 Live2D 全局对象，Live2D 模型包现在可以驱动。'
                : '未检测到 Live2D 全局对象。请确认地址正确、脚本已加载；在此之前使用静态立绘。'
            });
          };
          bar.appendChild(saveB);
          bar.appendChild(testB);
          r.appendChild(bar);
          return r;
        })());

        if (typeof onChanged === 'function') { /* 由调用方决定何时重绘 */ }
      }

      refresh();

      H.sheet({
        title: '立绘管理',
        subtitle: '多套服装 / 形态轮换 · Live2D 与静态立绘混用',
        icon: 'portrait',
        height: '88%',
        content: body,
        buttons: [
          {
            text: '上传静态立绘', icon: 'upload', kind: 'soft', soft: '#FFEBF3', color: '#B0728F',
            keepOpen: true,
            onClick: function () {
              Portraits.pickImage(1400, function (dataUrl) {
                H.prompt({
                  title: '立绘名称', placeholder: '例如：雨夜 · 白衬衫', value: '新立绘'
                }).then(function (name) {
                  if (name === null) return;
                  K.addPortrait({ name: name || '新立绘', kind: 'image', src: dataUrl });
                  H.toast('立绘已上传');
                  refresh();
                  if (typeof onChanged === 'function') onChanged();
                });
              });
            }
          },
          {
            text: '导入模型包 (zip)', icon: 'upload', kind: 'primary', keepOpen: true,
            onClick: function () {
              Portraits.pickZip(async function (file) {
                var sheetBody = H.el('div');
                var stage = H.el('div');
                stage.style.cssText = 'font-size:11.4px; color:#8d8397; line-height:1.9; text-align:center; padding:18px 8px;';
                sheetBody.appendChild(stage);
                var sheetPromise = H.sheet({
                  title: '正在导入模型包',
                  subtitle: file.name,
                  icon: 'sparkle',
                  height: '46%',
                  content: sheetBody,
                  dismissible: false
                });
                var step = function (s, d) { stage.textContent = d || s; };
                try {
                  var parsed = await ZipModel.parse(file, step);
                  // 记录到资源池，页面销毁时统一释放 blob URL
                  Portraits._zipRecords = Portraits._zipRecords || [];
                  Portraits._zipRecords.push(parsed);
                  Portraits.pool.acquire('zip:' + parsed.jsonPath, { kind: 'image', url: parsed.entryUrl });

                  var created = K.addPortrait({
                    name: parsed.name || 'Live2D 模型',
                    kind: 'live2d',
                    modelUrl: parsed.entryUrl,
                    // 注意：src 不存 blob URL —— 那是本次会话的临时地址，
                    // 重启后必然失效；留空让 Live2D 分支自己渲染，失败则回落剪影。
                    src: '',
                    tags: (parsed.mocFound ? [] : ['仅贴图']).concat(['zip 导入'])
                  });
                  H.closeAllLayers();
                  H.toast('模型包已导入（' + parsed.fileCount + ' 个文件）');
                  if (!parsed.mocFound) {
                    H.modal({
                      title: '导入完成，但没找到 moc3',
                      icon: 'info', accent: '#9FB3D9',
                      message: '包里没有 .moc3 模型文件，可能只包含贴图。已按静态立绘处理。'
                    });
                  }
                  refresh();
                  if (typeof onChanged === 'function') onChanged();
                  // 导入即尝试驱动一次，能跑起来就直接看到效果
                  if (parsed.entryUrl) {
                    setTimeout(function () {
                      var cv = document.createElement('canvas');
                      Live2DLoader.mount(cv, parsed.entryUrl).then(function (inst) {
                        if (!inst) {
                          H.modal({
                            title: '模型已导入，但未能驱动',
                            icon: 'info', accent: '#9FB3D9',
                            message: '模型包已存好（' + parsed.fileCount + ' 个文件）。\n'
                              + '要真正跑起来还需要 Live2D 运行时：在本页下方的「Live2D 运行时」里填入运行时脚本地址即可。'
                              + '\n在此之前会以静态立绘 + 物理动效展示。'
                          });
                        }
                      });
                    }, 300);
                  }
                } catch (err) {
                  H.closeAllLayers();
                  H.modal({
                    title: '导入失败',
                    icon: 'info', accent: '#c2607c', soft: '#FFEFF3',
                    message: (err && err.message) ? err.message : String(err)
                  });
                }
              });
            }
          },
          {
            text: '绑定模型地址', icon: 'sparkle', kind: 'outline',
            color: '#7d63a8', border: 'rgba(183,158,220,0.5)',
            keepOpen: true,
            onClick: function () {
              H.prompt({
                title: 'Live2D 模型地址',
                message: '填入 model3.json（或模型包内入口文件）的地址。运行时未配置时会自动回落静态立绘。',
                placeholder: 'https://…/model3.json'
              }).then(function (url) {
                if (!url) return;
                H.prompt({ title: '模型名称', value: 'Live2D 模型' }).then(function (name) {
                  K.addPortrait({ name: name || 'Live2D 模型', kind: 'live2d', modelUrl: url, src: '' });
                  H.toast('模型已绑定');
                  refresh();
                  if (typeof onChanged === 'function') onChanged();
                });
              });
            }
          }
        ]
      });
    },

    // ------------------------------------------------------------------
    //  4.2 热区涂抹划分系统
    // ------------------------------------------------------------------

    openHotspotEditor: function (onChanged) {
      var portrait = K.currentPortrait();
      var portraitId = portrait ? portrait.id : 'default';
      var body = H.el('div');
      var stage = H.el('div');
      stage.style.cssText = 'position:relative; width:100%; height:340px; border-radius:18px; overflow:hidden;'
        + 'background:linear-gradient(160deg,#FDF7FB 0%,#F4F1FA 100%); border:1px solid rgba(216,160,190,0.24);';
      body.appendChild(stage);

      var tip = H.el('div');
      tip.style.cssText = 'font-size:10.8px; line-height:1.72; color:#9a8f9e; margin:9px 2px 11px;';
      tip.innerHTML = '在立绘上直接拖动热区圆心调整位置，滚轮 / 双指缩放调整范围。'
        + '每个部位可单独绑定「交互等级」与「好感阶段响应动作库」。';
      body.appendChild(tip);

      var renderer = new SpriteRenderer({
        editable: true,
        showOverlay: true,
        onTouch: null,
        onSelect: function (key) { renderActionPanel(key); }
      });

      function mountStage() {
        stage.innerHTML = '';
        if (portrait && portrait.src) {
          renderer.mount(stage, portrait, { editable: true, fit: 'contain' });
        } else {
          stage.appendChild(Portraits.silhouette());
          var layer = H.el('div');
          layer.style.cssText = 'position:absolute; inset:0;';
          renderer.portraitId = portraitId;
          renderer.hotspots = K.hotspotsOf(portraitId);
          renderer.overlay = layer;
          renderer.root = layer;
          stage.appendChild(layer);
          renderer.renderHotspots({ editable: true, onSelect: function (key) { renderActionPanel(key); } });
        }
      }

      // 部位动作库面板
      var actionPanel = H.el('div');
      body.appendChild(actionPanel);

      function renderActionPanel(key) {
        actionPanel.innerHTML = '';
        if (!key) { actionPanel.appendChild(H.empty('点击立绘上的任意热区，可编辑它的响应动作库', { icon: 'hand' })); return; }
        var spot = C.HOTSPOTS.filter(function (s) { return s.key === key; })[0];
        var geom = K.hotspotsOf(portraitId)[key];
        actionPanel.appendChild(H.sectionTitle('热区：' + spot.name, { color: '#D97FA8' }));

        var meta = H.el('div');
        meta.style.cssText = 'display:flex; gap:8px; margin-bottom:10px;';
        meta.appendChild(H.chip('交互等级 ' + spot.order, { color: '#7E97C9', soft: '#EDF2FB' }));
        meta.appendChild(H.chip('范围 ' + U.round(geom.rx * 200, 0) + '% × ' + U.round(geom.ry * 200, 0) + '%', { color: '#B79EDC', soft: '#F3EEFF' }));
        actionPanel.appendChild(meta);

        var list = K.hotspotActionsOf(portraitId, key);
        if (!list.length) actionPanel.appendChild(H.empty('这个部位还没有专属动作，戳它时会由模型即时生成。', { icon: 'sparkle' }));
        list.slice(0, 6).forEach(function (a) {
          var row = H.listRow({
            icon: 'msg', color: '#D97FA8', soft: '#FFEBF3',
            title: a.text, subtitleWrap: true,
            subtitle: '阶段：' + K.tierOf(a.tier || 'acquaint').name + ' · ' + U.timeAgo(a.at),
            rightNode: (function () {
              var del = H.iconButton('trash', { size: 26, color: '#c2607c' });
              del.onclick = function (ev) {
                ev.stopPropagation();
                var saved = K.state.assets.hotspotActions[portraitId][key];
                var i = saved.indexOf(a);
                if (i >= 0) saved.splice(i, 1);
                K.save(true);
                renderActionPanel(key);
              };
              return del;
            })()
          });
          actionPanel.appendChild(row);
        });

        var addB = H.button('新增这个部位的动作', { kind: 'soft', block: true, icon: 'plus', soft: '#FFEBF3', color: '#B0728F' });
        addB.onclick = function () {
          H.prompt({
            title: '新增动作文案',
            message: '写下 TA 被碰到「' + spot.name + '」时的专属反应。留空则交给模型即时生成。',
            multiline: true, rows: 3, placeholder: '例如：TA 没有躲开，只是把视线落在了别处。'
          }).then(function (text) {
            if (!text) return;
            K.pushHotspotAction(portraitId, key, { text: text });
            renderActionPanel(key);
            H.toast('已绑定到当前阶段');
          });
        };
        actionPanel.appendChild(addB);

        var resetB = H.button('恢复该部位默认版式', { kind: 'ghost', block: true, icon: 'refresh', color: '#9a8f9e' });
        resetB.onclick = function () {
          var d = C.DEFAULT_HOTSPOTS()[key];
          K.setHotspot(portraitId, key, d);
          renderer.hotspots = K.hotspotsOf(portraitId);
          mountStage();
          renderActionPanel(key);
          H.toast('已恢复默认版式');
        };
        actionPanel.appendChild(resetB);
      }

      mountStage();
      renderActionPanel(null);

      H.sheet({
        title: '热区涂抹划分',
        subtitle: portrait ? portrait.name : '默认版式（尚未上传立绘）',
        icon: 'hand',
        height: '92%',
        content: body,
        buttons: [{
          text: '完成', icon: 'check', kind: 'primary',
          onClick: function () {
            K.save(true);
            H.toast('热区划分已保存');
            if (typeof onChanged === 'function') onChanged();
          }
        }]
      });
    },

    // ------------------------------------------------------------------
    //  4.3 场景背景管理
    // ------------------------------------------------------------------

    openBackgroundManager: function (onChanged) {
      var body = H.el('div');
      var SCENES = ['卧室', '校园', '雨天', '黄昏', '街道', '咖啡店', '海边', '露台', '车内', '自定义'];

      function refresh() {
        body.innerHTML = '';
        var list = K.state.assets.backgrounds;
        if (!list.length) body.appendChild(H.empty('还没有场景背景。上传一张图，并标注它的场景属性。', { icon: 'bg' }));
        list.forEach(function (b) {
          var isCur = K.state.assets.currentBackgroundId === b.id;
          var row = H.listRow({
            title: b.name,
            subtitle: '场景：' + b.scene + (b.tags && b.tags.length ? ' · ' + b.tags.join(' / ') : ''),
            subtitleWrap: true,
            leftNode: (function () {
              var im = H.el('img', { alt: '' });
              im.src = b.src;
              im.style.cssText = 'width:46px; height:34px; border-radius:10px; object-fit:cover; flex-shrink:0;'
                + 'border:1px solid rgba(216,160,190,0.25);';
              return im;
            })(),
            rightNode: (function () {
              var box = H.el('div');
              box.style.cssText = 'display:flex; gap:6px; align-items:center; flex-shrink:0;';
              if (isCur) box.appendChild(H.chip('使用中', { color: '#D97FA8', soft: '#FFEBF3' }));
              else {
                var b1 = H.button('使用', { kind: 'soft', pad: '5px 9px', size: 10.5, soft: '#EDF2FB', color: '#5f7aa8' });
                b1.onclick = function (ev) {
                  ev.stopPropagation();
                  K.setCurrentBackground(b.id);
                  H.toast('已切换场景');
                  refresh();
                  if (typeof onChanged === 'function') onChanged();
                };
                box.appendChild(b1);
              }
              var del = H.iconButton('trash', { size: 26, color: '#c2607c' });
              del.onclick = function (ev) {
                ev.stopPropagation();
                K.removeBackground(b.id);
                refresh();
                if (typeof onChanged === 'function') onChanged();
              };
              box.appendChild(del);
              return box;
            })()
          });
          body.appendChild(row);
        });

        body.appendChild(H.sectionTitle('快捷场景标签', { color: '#7E97C9' }));
        var wrap = H.el('div');
        wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';
        SCENES.forEach(function (s) {
          wrap.appendChild(H.chip(s, { color: '#5f7aa8', soft: '#EDF2FB' }));
        });
        body.appendChild(wrap);
      }

      refresh();

      H.sheet({
        title: '场景背景管理',
        subtitle: '供主页看板与 VN 剧情引擎调用',
        icon: 'bg',
        height: '86%',
        content: body,
        buttons: [{
          text: '上传背景', icon: 'upload', kind: 'primary',
          keepOpen: true,
          onClick: function () {
            Portraits.pickImage(1600, function (dataUrl) {
              H.prompt({ title: '背景名称', value: '新场景' }).then(function (name) {
                if (name === null) return;
                var scene = '自定义';
                H.sheet({
                  title: '场景属性',
                  icon: 'bg',
                  content: (function () {
                    var w = H.el('div');
                    var chips = H.el('div');
                    chips.style.cssText = 'display:flex; flex-wrap:wrap; gap:7px;';
                    SCENES.forEach(function (s) {
                      var chip = H.button(s, { kind: 'soft', pad: '7px 12px', size: 11.5, soft: '#EDF2FB', color: '#5f7aa8' });
                      chip.onclick = function () {
                        scene = s;
                        Array.prototype.forEach.call(chips.children, function (c) { c.style.background = '#EDF2FB'; });
                        chip.style.background = '#D9E6F8';
                      };
                      chips.appendChild(chip);
                    });
                    w.appendChild(chips);
                    return w;
                  })(),
                  buttons: [{
                    text: '保存', kind: 'primary',
                    onClick: function () {
                      K.addBackground({ name: name || '新场景', scene: scene, src: dataUrl });
                      H.toast('背景已添加');
                      refresh();
                      if (typeof onChanged === 'function') onChanged();
                    }
                  }]
                });
              });
            });
          }
        }]
      });
    },

    /** 选图并压缩（复用桌面模块的编码器，PNG 保留透明） */
    pickImage: function (maxPx, cb) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (input.parentNode) input.parentNode.removeChild(input);
        if (!file) return;
        var enc = window.tileEncodeImage;
        if (typeof enc !== 'function') { H.toast('图片编码器不可用'); return; }
        enc(file, maxPx).then(function (out) {
          if (!out) { H.toast('这张图片解析失败：可能是 HEIC 等本机不支持的格式'); return; }
          if (typeof cb === 'function') cb(out);
        });
      };
      input.click();
    },

    /** 选一个 zip 模型包 */
    pickZip: function (cb) {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = '.zip,application/zip,application/x-zip-compressed';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = function () {
        var file = input.files && input.files[0];
        if (input.parentNode) input.parentNode.removeChild(input);
        if (!file) return;
        if (typeof cb === 'function') cb(file);
      };
      input.click();
    },

    // ------------------------------------------------------------------
    //  4.4 后台管理界面（身份与字段注入 / 模式 / 难度 / 记忆格式化）
    // ------------------------------------------------------------------

    openAdmin: async function (onChanged) {
      var char = await K.charProfile();
      var user = await K.userProfile();
      var body = H.el('div');
      var st = K.state;

      // —— 双轨模式开关 ——
      body.appendChild(H.sectionTitle('世界线（双轨模式）', { color: '#D97FA8' }));
      var modeBox = H.el('div');
      modeBox.style.cssText = 'display:flex; gap:9px; margin-bottom:6px;';
      Object.keys(C.MODE).forEach(function (mk) {
        var on = st.mode === mk;
        var card = H.el('div');
        card.style.cssText = 'flex:1; border-radius:16px; padding:12px 12px 13px; cursor:pointer;'
          + 'transition:all .24s cubic-bezier(.22,1,.36,1); box-sizing:border-box;'
          + (on
            ? 'background:linear-gradient(150deg,#FFF1F7,#F6F0FF); border:1.6px solid rgba(217,127,168,0.65);'
              + 'box-shadow:0 9px 24px rgba(217,127,168,0.20);'
            : 'background:rgba(255,255,255,0.7); border:1.4px solid rgba(190,180,195,0.28);');
        card.innerHTML = '<div style="font-size:12.5px; font-weight:800; color:' + (on ? '#B0728F' : '#6f6779') + ';">'
          + C.MODE_LABEL[mk] + '</div>'
          + '<div style="font-size:10.4px; line-height:1.62; color:#9a8f9e; margin-top:5px;">' + C.MODE_DESC[mk] + '</div>';
        card.onclick = function () {
          K.setMode(mk);
          H.toast('已切换到「' + C.MODE_LABEL[mk] + '」');
          if (typeof onChanged === 'function') onChanged(true);
          openAdminRefresh();
        };
        modeBox.appendChild(card);
      });
      body.appendChild(modeBox);

      // —— 攻略难度调节器（攻略模式独占） ——
      if (st.mode === C.MODE.STRATEGY) {
        body.appendChild(H.sectionTitle('心动阻抗（好感增长倍率）', { color: '#B79EDC' }));
        var dbox = H.el('div');
        dbox.style.cssText = 'background:rgba(255,255,255,0.72); border:1px solid rgba(183,158,220,0.24);'
          + 'border-radius:16px; padding:12px; margin-bottom:4px;';
        var dIdx = C.DIFFICULTIES.map(function (d) { return d.key; }).indexOf(st.difficulty);
        var dLabel = H.el('div');
        dLabel.style.cssText = 'display:flex; justify-content:space-between; align-items:baseline; margin-bottom:9px;';
        dLabel.innerHTML = '<span style="font-size:12.5px; font-weight:800; color:#7d63a8;">'
          + C.DIFFICULTIES[Math.max(0, dIdx)].name + '</span>'
          + '<span style="font-size:11px; color:#a99fae;">×' + C.DIFFICULTIES[Math.max(0, dIdx)].mult.toFixed(1) + '</span>';
        dbox.appendChild(dLabel);
        var dDesc = H.el('div');
        dDesc.style.cssText = 'font-size:10.6px; color:#9a8f9e; line-height:1.65; margin-bottom:9px;';
        dDesc.textContent = C.DIFFICULTIES[Math.max(0, dIdx)].desc;
        dbox.appendChild(dDesc);
        var slider = H.slider({
          min: 0, max: C.DIFFICULTIES.length - 1, step: 1, value: Math.max(0, dIdx),
          format: function (v) { return '×' + C.DIFFICULTIES[Number(v)].mult.toFixed(1); },
          onChange: function (v) {
            var d = C.DIFFICULTIES[Number(v)];
            dLabel.innerHTML = '<span style="font-size:12.5px; font-weight:800; color:#7d63a8;">' + d.name + '</span>'
              + '<span style="font-size:11px; color:#a99fae;">×' + d.mult.toFixed(1) + '</span>';
            dDesc.textContent = d.desc;
          }
        });
        dbox.appendChild(slider);
        var applyD = H.button('应用难度', { kind: 'soft', block: true, soft: '#F3EEFF', color: '#7d63a8' });
        applyD.style.marginTop = '10px';
        applyD.onclick = function () {
          var d = C.DIFFICULTIES[slider.getValue()];
          K.setDifficulty(d.key);
          H.toast('心动阻抗已设为「' + d.name + '」');
          if (typeof onChanged === 'function') onChanged(true);
        };
        dbox.appendChild(applyD);
        body.appendChild(dbox);
      } else {
        body.appendChild(H.sectionTitle('User 好感裁定权', { color: '#D97FA8' }));
        body.appendChild((function () {
          var box = H.el('div');
          box.style.cssText = 'background:rgba(255,255,255,0.72); border:1px solid rgba(216,160,190,0.24);'
            + 'border-radius:16px; padding:12px; margin-bottom:4px;';
          box.innerHTML = '<div style="font-size:10.8px; line-height:1.68; color:#9a8f9e; margin-bottom:10px;">'
            + '被攻略模式下，好感由你裁决。TA 会依据这个数值表现出狂喜、患得患失或占有欲。'
            + '</div>';
          var stepper = H.stepper({
            value: U.int(st.verdict.value, 0), step: 1, min: 0, max: 100, color: '#D97FA8',
            onChange: function (v) { st.verdict.value = v; }
          });
          box.appendChild(stepper);
          var quick = H.el('div');
          quick.style.cssText = 'display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;';
          [-5, -1, 1, 5, 10].forEach(function (n) {
            var b = H.button((n > 0 ? '+' : '') + n, {
              kind: 'soft', pad: '5px 11px', size: 11,
              soft: n > 0 ? '#FFEBF3' : '#EDF2FB', color: n > 0 ? '#B0728F' : '#5f7aa8'
            });
            b.onclick = function () {
              K.nudgeVerdict(n);
              stepper.setValue(K.state.verdict.value);
              if (typeof onChanged === 'function') onChanged(true);
            };
            quick.appendChild(b);
          });
          box.appendChild(quick);
          var moodRow = H.el('div');
          moodRow.style.cssText = 'margin-top:12px;';
          moodRow.appendChild(H.sectionTitle('心情指数', { color: '#B79EDC', margin: '0 0 7px' }));
          var moodWrap = H.el('div');
          moodWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';
          C.MOODS.forEach(function (m) {
            var on = st.verdict.mood === m.key;
            var b = H.button(m.name, {
              kind: 'soft', pad: '6px 11px', size: 11,
              soft: on ? m.soft : 'rgba(240,236,244,0.7)', color: on ? m.color : '#9a919f'
            });
            if (on) b.style.boxShadow = '0 0 0 1.4px ' + m.color + '55';
            b.onclick = function () {
              K.setVerdict(K.state.verdict.value, { mood: m.key, note: st.verdict.note });
              H.toast('心情已设为「' + m.name + '」');
              if (typeof onChanged === 'function') onChanged(true);
              openAdminRefresh();
            };
            moodWrap.appendChild(b);
          });
          moodRow.appendChild(moodWrap);
          box.appendChild(moodRow);

          var noteRow = H.el('div');
          noteRow.style.cssText = 'margin-top:11px;';
          var noteInput = H.el('input', { type: 'text', placeholder: '给 TA 的一句裁定备注（会写进剧情上下文）' });
          noteInput.value = st.verdict.note || '';
          noteInput.style.cssText = 'width:100%; box-sizing:border-box; border-radius:11px;'
            + 'border:1px solid rgba(216,160,190,0.32); padding:8px 10px; font-size:11.5px; color:#5c4450;'
            + 'background:#fff; outline:none; font-family:inherit;';
          noteRow.appendChild(noteInput);
          noteRow.appendChild((function () {
            var b = H.button('保存裁定', { kind: 'primary', block: true, icon: 'check' });
            b.style.marginTop = '9px';
            b.onclick = function () {
              K.setVerdict(stepper.getValue(), { note: noteInput.value, mood: st.verdict.mood });
              H.toast('裁定已保存');
              if (typeof onChanged === 'function') onChanged(true);
            };
            return b;
          })());
          box.appendChild(noteRow);
          return box;
        })());
      }

      // —— 身份与字段注入 ——
      body.appendChild(H.sectionTitle('身份与字段注入', { color: '#7E97C9' }));
      function fieldRow(label, value, placeholder, onSave, opts) {
        var o = opts || {};
        var row = H.el('div');
        row.style.cssText = 'margin-bottom:9px;';
        var lab = H.el('div', {}, U.esc(label));
        lab.style.cssText = 'font-size:10.8px; font-weight:700; color:#8b8292; margin:0 2px 5px;';
        row.appendChild(lab);
        var input = o.multiline
          ? H.el('textarea', { rows: o.rows || 3, placeholder: placeholder || '' })
          : H.el('input', { type: 'text', placeholder: placeholder || '' });
        input.value = value || '';
        input.style.cssText = 'width:100%; box-sizing:border-box; border-radius:12px;'
          + 'border:1px solid rgba(148,163,184,0.30); padding:9px 11px; font-size:11.8px; color:#5c4450;'
          + 'background:rgba(255,255,255,0.86); outline:none; font-family:inherit; line-height:1.62; resize:vertical;';
        row.appendChild(input);
        var save = H.button('写入', { kind: 'ghost', pad: '6px 11px', size: 10.8, color: '#5f7aa8', icon: 'save' });
        save.style.cssText += 'margin-top:6px; background:rgba(237,242,251,0.85); border-radius:10px;';
        save.onclick = function () {
          onSave(input.value);
          H.toast('已写入：' + label);
          if (typeof onChanged === 'function') onChanged(true);
        };
        row.appendChild(save);
        return row;
      }

      body.appendChild((function () {
        var w = H.el('div');
        w.appendChild(fieldRow('User 称谓（覆盖）', user.name, '留空则使用档案库名称', function (v) {
          st.overrides.user = st.overrides.user || {};
          st.overrides.user.name = v;
          K.save(true);
        }));
        w.appendChild(fieldRow('User 外观描述', (st.overrides.user && st.overrides.user.appearance) || '', '例如：短发、浅色针织衫、耳后有一颗痣', function (v) {
          st.overrides.user.appearance = v;
          K.save(true);
        }, { multiline: true }));
        w.appendChild(fieldRow('User 性格标签', ((st.overrides.userTags || []).join(' / ')), '例如：嘴硬心软 / 慢热 / 占有欲强（用 / 分隔）', function (v) {
          st.overrides.userTags = String(v || '').split('/').map(function (s) { return s.trim(); }).filter(Boolean);
          K.save(true);
        }));
        w.appendChild(fieldRow('User 好感反应偏好', st.overrides.userReact || '', '例如：被直球告白会炸毛，吃醋时反而黏人', function (v) {
          st.overrides.userReact = v;
          K.save(true);
        }, { multiline: true }));
        return w;
      })());

      body.appendChild(H.divider());

      body.appendChild((function () {
        var w = H.el('div');
        w.appendChild(fieldRow('Char 底层设定字段（覆盖）', char.persona, '留空则使用档案库 persona', function (v) {
          st.overrides.char = st.overrides.char || {};
          st.overrides.char.persona = v;
          K.save(true);
        }, { multiline: true, rows: 4 }));
        w.appendChild(fieldRow('Char 称谓（覆盖）', char.name, '留空则使用档案库名称', function (v) {
          st.overrides.char.name = v;
          K.save(true);
        }));
        return w;
      })());

      // —— 记忆与进度格式化 ——
      body.appendChild(H.sectionTitle('记忆与进度格式化', { color: '#9FB3D9' }));
      body.appendChild((function () {
        var note = H.el('div');
        note.style.cssText = 'font-size:10.6px; line-height:1.7; color:#9a8f9e; margin-bottom:10px;'
          + 'background:rgba(237,242,251,0.7); border:1px solid rgba(159,179,217,0.25); border-radius:13px; padding:10px 12px;';
        note.innerHTML = '以下操作<b>只清除心动游戏自己的数据</b>，'
          + '档案库里的 User 与 Char 原生设定（称谓 / 人设 / 头像）不受任何影响。';
        return note;
      })());
      var SCOPES = [
        { key: 'affinity', name: '好感阶梯', desc: '好感经验、晋阶任务完成表、好感流水' },
        { key: 'story', name: '主线节点', desc: '篇章进度、分支回溯树、剧情内小手机' },
        { key: 'quiet', name: '静室历史', desc: '静室对话流与系统日志' },
        { key: 'quests', name: '任务进度', desc: '每日 / 周常 / 动态委托 / 宝箱' },
        { key: 'shop', name: '商店与钱包', desc: '已购商品、上架商品、代币与代金券' },
        { key: 'gacha', name: '抽卡记录', desc: '卡册、保底计数、抽卡流水' },
        { key: 'bond', name: '羁绊足迹', desc: '时空足迹与重要记忆回廊' }
      ];
      SCOPES.forEach(function (s) {
        var row = H.listRow({
          icon: 'trash', color: '#9FB3D9', soft: '#EDF2FB',
          title: '清除' + s.name,
          subtitle: s.desc, subtitleWrap: true,
          rightNode: H.button('清除', { kind: 'ghost', pad: '5px 10px', size: 10.5, color: '#c2607c' })
        });
        row.onclick = function () {
          H.confirm({
            title: '清除' + s.name + '？',
            icon: 'trash', accent: '#c2607c', soft: '#FFEFF3',
            message: s.desc + '。\n\nUser 原生档案不受影响。此操作不可撤销。',
            okText: '确认清除'
          }).then(function (ok) {
            if (!ok) return;
            K.clearScope(s.key).then(function () {
              H.toast('已清除：' + s.name);
              if (typeof onChanged === 'function') onChanged(true);
            });
          });
        };
        body.appendChild(row);
      });

      var allB = H.button('格式化全部心动游戏数据（保留立绘与背景）', {
        kind: 'danger', block: true, icon: 'trash'
      });
      allB.onclick = function () {
        H.confirm({
          title: '格式化全部数据',
          icon: 'trash', accent: '#c2607c', soft: '#FFEFF3',
          message: '将清空好感、主线、静室、任务、商店、抽卡、羁绊的全部进度。\n'
            + '立绘、背景与 User / Char 原生档案会保留。\n\n此操作不可撤销。',
          okText: '全部清除'
        }).then(function (ok) {
          if (!ok) return;
          K.clearScope('all').then(function () {
            H.toast('已格式化');
            if (typeof onChanged === 'function') onChanged(true);
            openAdminRefresh();
          });
        });
      };
      body.appendChild(allB);

      function openAdminRefresh() {
        // 重新打开以刷新（模式切换后区块结构会变）
        Portraits.openAdmin(onChanged);
      }

      return H.sheet({
        title: '后台管理',
        subtitle: '世界线 · 身份字段 · 记忆格式化',
        icon: 'admin',
        height: '92%',
        content: body
      });
    },

    // ------------------------------------------------------------------
    //  4.5 生命周期
    // ------------------------------------------------------------------

    /** 页面销毁：卸载 Live2D 实例、回收资源池、释放 zip 导入的 blob URL、清理定时器 */
    teardown: function () {
      if (Portraits.live2d && typeof Portraits.live2d.destroy === 'function') {
        try { Portraits.live2d.destroy(); } catch (e) {}
      }
      Portraits.live2d = null;
      if (Portraits.renderer) Portraits.renderer.teardown();
      Portraits.renderer = null;
      // zip 导入产生的 blob URL 必须显式释放，否则整包贴图会一直留在内存里
      (Portraits._zipRecords || []).forEach(function (rec) {
        try { ZipModel.release(rec); } catch (e) {}
      });
      Portraits._zipRecords = [];
      Portraits.pool.clear();
      // 同步内存态的池顺序（避免下次进来引用已卸载资源）
      if (K.state && K.state.assets) K.state.assets.pool = [];
      Portraits._stage = null;
    },

    poolStats: function () { return Portraits.pool.stats(); }
  };

  // 给静态渲染器补上动画样式（命中反馈）
  (function () {
    if (document.getElementById('heartgame-portrait-style')) return;
    var s = document.createElement('style');
    s.id = 'heartgame-portrait-style';
    s.textContent = '@keyframes hg-hit-react{0%{transform:translateX(-50%) scale(1)}'
      + '18%{transform:translateX(-50%) scale(1.028) rotate(-.5deg)}'
      + '42%{transform:translateX(-50%) scale(.992) rotate(.5deg)}'
      + '70%{transform:translateX(-50%) scale(1.012)}'
      + '100%{transform:translateX(-50%) scale(1)}}'
      + '.hg-portrait-img.hg-hit-react{animation:hg-hit-react .82s cubic-bezier(.22,1,.36,1), hg-breathe 4.6s ease-in-out infinite;}'
      + '.hg-touch-edit{touch-action:none;}';
    (document.head || document.documentElement).appendChild(s);
  })();

  HG.Portraits = Portraits;
  HG.AssetPool = AssetPool;
  /** ZIP 模型包导入器（Live2D 最省事的用法：把整包 zip 丢进来） */
  HG.ZipModel = ZipModel;
})();
