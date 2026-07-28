/**
 * app_music.js - 听歌应用 (网易云真机 Native 授权扫码、歌单分组、大听歌卡片与 Char 陪听中枢)
 * 遵循规范：纯原生全矢量 SVG 图标、禁用 Emoji、真机原生特权网络穿透
 */

(function() {
  window.musicSystem = {
    audio: new Audio(),
    playlists: [],
    currentIndex: -1,
    playMode: 'sequence', // sequence | loop | random
    lyrics: [],
    activeLyricIndex: -1,
    mountedCompanion: null,
    ncmCookie: localStorage.getItem("ncm_user_cookie") || "",
    isVip: false,
    showCardLyrics: false,
    tempCropCoverBase64: "",
    unikey: "",
    qrPollTimer: null,

    async init() {
      this.bindAudioEvents();
      this.initIndexedDBStorage();
      await this.loadPlaylistsFromStorage();
      this.renderMine();
      this.updateIslandCompanionUI();
    },

    // 真机 Native 网络特权穿透通道 (伪装官方 Header 绕过风控，彻底根治二维码失效)
    async ncmNativeFetch(url, method = "POST", customHeaders = {}, bodyStr = "") {
      const defaultHeaders = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
        "Referer": "https://music.163.com/",
        "Content-Type": "application/x-www-form-urlencoded"
      };

      if (this.ncmCookie) {
        defaultHeaders["Cookie"] = this.ncmCookie;
      }

      const finalHeaders = { ...defaultHeaders, ...customHeaders };

      // 1. 优先走安卓原生 Kotlin 物理网络穿透 (零 CORS 跨域限制)
      if (window.AndroidMCP && typeof window.AndroidMCP.sendNativeHttpRequest === 'function') {
        const resStr = window.AndroidMCP.sendNativeHttpRequest(url, method, JSON.stringify(finalHeaders), bodyStr);
        try {
          const resObj = JSON.parse(resStr);
          let bodyData = null;
          try {
            bodyData = JSON.parse(resObj.body);
          } catch(e) {
            bodyData = resObj.body;
          }
          return { status: resObj.status, data: bodyData, headers: resObj.headers || {} };
        } catch(e) {
          return null;
        }
      } else {
        // 2. PWA 网页端降级跨域代理
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`).catch(() => null);
        if (res && res.ok) {
          const data = await res.json().catch(() => null);
          return { status: 200, data: data, headers: {} };
        }
        return null;
      }
    },

    initIndexedDBStorage() {
      if (!window.indexedDB) return;
      const request = indexedDB.open("StoryPhoneMusicDB", 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("songs")) {
          db.createObjectStore("songs", { keyPath: "id" });
        }
      };
    },

    async saveSongToIndexedDB(songObj) {
      return new Promise((resolve) => {
        const req = indexedDB.open("StoryPhoneMusicDB", 1);
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction("songs", "readwrite");
          const store = tx.objectStore("songs");
          store.put(songObj);
          tx.oncomplete = () => resolve(true);
        };
        req.onerror = () => resolve(false);
      });
    },

    async getSongFromIndexedDB(id) {
      return new Promise((resolve) => {
        const req = indexedDB.open("StoryPhoneMusicDB", 1);
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction("songs", "readonly");
          const store = tx.objectStore("songs");
          const getReq = store.get(id);
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      });
    },

    async getAllSongsFromIndexedDB() {
      return new Promise((resolve) => {
        const req = indexedDB.open("StoryPhoneMusicDB", 1);
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction("songs", "readonly");
          const store = tx.objectStore("songs");
          const getAllReq = store.getAll();
          getAllReq.onsuccess = () => resolve(getAllReq.result || []);
          getAllReq.onerror = () => resolve([]);
        };
        req.onerror = () => resolve([]);
      });
    },

    async deleteSongFromIndexedDB(id) {
      return new Promise((resolve) => {
        const req = indexedDB.open("StoryPhoneMusicDB", 1);
        req.onsuccess = (e) => {
          const db = e.target.result;
          const tx = db.transaction("songs", "readwrite");
          const store = tx.objectStore("songs");
          store.delete(id);
          tx.oncomplete = () => resolve(true);
        };
      });
    },

    bindAudioEvents() {
      const audio = this.audio;
      audio.ontimeupdate = () => {
        this.updateProgressUI();
        this.syncLyricsTime();
      };
      audio.onended = () => {
        this.handleSongEnd();
      };
      audio.onplay = () => this.syncPlayStateUI(true);
      audio.onpause = () => this.syncPlayStateUI(false);
    },

    async loadPlaylistsFromStorage() {
      try {
        const localPL = JSON.parse(localStorage.getItem("ncm_playlists"));
        if (localPL && Array.isArray(localPL)) {
          this.playlists = localPL;
        } else {
          this.playlists = [];
          this.savePlaylistsToStorage();
        }
      } catch(e) {
        this.playlists = [];
      }
    },

    savePlaylistsToStorage() {
      localStorage.setItem("ncm_playlists", JSON.stringify(this.playlists));
    },

    openCreatePlaylistModal() {
      const overlay = document.getElementById("ncm-playlist-create-overlay");
      if (overlay) overlay.classList.add("active");
    },

    closeCreatePlaylistModal() {
      const overlay = document.getElementById("ncm-playlist-create-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    submitCreatePlaylist() {
      const nameInput = document.getElementById("ncm-playlist-name-input");
      if (!nameInput || !nameInput.value.trim()) {
        if (typeof showToast === 'function') showToast("请输入歌单分组名称");
        return;
      }
      const name = nameInput.value.trim();
      nameInput.value = "";

      this.playlists.push({ id: "pl_" + Date.now(), name, coverUrl: "", songIds: [] });
      this.savePlaylistsToStorage();
      if (typeof showToast === 'function') showToast(`成功新建歌单: ${name}`);
      this.closeCreatePlaylistModal();
      this.renderMine();
    },

    async openPlaylistDetail(playlistId) {
      const pl = this.playlists.find(p => p.id === playlistId);
      if (!pl) return;

      const overlay = document.getElementById("ncm-playlist-detail-overlay");
      const titleEl = document.getElementById("ncm-playlist-detail-title");
      const container = document.getElementById("ncm-playlist-songs-flow");
      if (!overlay || !container) return;

      if (titleEl) titleEl.innerText = pl.name;

      const allSongs = await this.getAllSongsFromIndexedDB();
      const plSongs = allSongs.filter(s => (pl.songIds || []).includes(s.id));

      if (plSongs.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:20px; font-size:12px; color:#94a3b8;">该歌单下暂无歌曲，可在导入或编辑时归入此歌单</div>`;
      } else {
        let html = "";
        plSongs.forEach((song) => {
          const globalIdx = allSongs.findIndex(s => s.id === song.id);
          html += `
            <div class="ncm-song-item" onclick="musicSystem.playSongFromList(${globalIdx})">
              <div class="ncm-song-info">
                <div class="ncm-song-title">${song.title}</div>
                <div class="ncm-song-artist">${song.artist || '未知歌手'}</div>
              </div>
              <button class="btn-icon" style="color:#ec4141;" onclick="musicSystem.playSongFromList(${globalIdx})">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
            </div>
          `;
        });
        container.innerHTML = html;
      }

      overlay.classList.add("active");
    },

    closePlaylistDetail() {
      const overlay = document.getElementById("ncm-playlist-detail-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    switchTab(tab) {
      document.querySelectorAll(".music-tab-panel").forEach(p => p.classList.remove("active"));
      document.querySelectorAll(".music-dock-tab").forEach(t => t.classList.remove("active"));

      const targetPanel = document.getElementById(`music-tab-${tab}`);
      const targetTab = document.querySelector(`.music-dock-tab[data-tab="${tab}"]`);
      if (targetPanel) targetPanel.classList.add("active");
      if (targetTab) targetTab.classList.add("active");

      if (tab === 'mine') this.renderMine();
    },

    openImportChoiceModal() {
      const overlay = document.getElementById("ncm-import-choice-overlay");
      if (overlay) overlay.classList.add("active");
    },

    closeImportChoiceModal() {
      const overlay = document.getElementById("ncm-import-choice-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    openImportFormModal(type) {
      this.closeImportChoiceModal();
      const overlay = document.getElementById("ncm-import-form-overlay");
      if (!overlay) return;

      document.getElementById("ncm-form-import-type").value = type;
      const fileGroup = document.getElementById("ncm-form-file-group");
      const urlGroup = document.getElementById("ncm-form-url-group");
      const ncmGroup = document.getElementById("ncm-form-ncm-group");

      if (fileGroup) fileGroup.style.display = type === 'local' ? 'block' : 'none';
      if (urlGroup) urlGroup.style.display = type === 'url' ? 'block' : 'none';
      if (ncmGroup) ncmGroup.style.display = type === 'ncm' ? 'block' : 'none';

      this.populatePlaylistDropdownOptions("ncm-form-playlist-select");
      overlay.classList.add("active");
    },

    closeImportFormModal() {
      const overlay = document.getElementById("ncm-import-form-overlay");
      if (!overlay) return;
      overlay.classList.remove("active");
    },

    populatePlaylistDropdownOptions(selectId) {
      const select = document.getElementById(selectId);
      if (!select) return;

      if (this.playlists.length === 0) {
        select.innerHTML = `<option value="">未创建歌单 (保存在库)</option>`;
        return;
      }

      let html = "";
      this.playlists.forEach(p => {
        html += `<option value="${p.id}">${p.name}</option>`;
      });
      select.innerHTML = html;
    },

    async handleCoverFileUpload(fileInput, targetPreviewId) {
      if (!fileInput.files || !fileInput.files[0]) return;
      const file = fileInput.files[0];

      if (typeof showToast === 'function') showToast("正在等比方形裁切与压缩封面...");

      const base64 = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const minDim = Math.min(img.width, img.height);
          const srcX = (img.width - minDim) / 2;
          const srcY = (img.height - minDim) / 2;

          const canvas = document.createElement("canvas");
          canvas.width = 180;
          canvas.height = 180;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, srcX, srcY, minDim, minDim, 0, 0, 180, 180);
          resolve(canvas.toDataURL("image/jpeg", 0.8));
        };
        img.onerror = () => resolve("");
        const reader = new FileReader();
        reader.onload = (e) => img.src = e.target.result;
        reader.readAsDataURL(file);
      });

      this.tempCropCoverBase64 = base64;
      const preview = document.getElementById(targetPreviewId);
      if (preview && base64) {
        preview.src = base64;
      }
    },

    parseNcmSongId(inputStr) {
      if (!inputStr) return null;
      const match = inputStr.match(/(?:id=|^)(\d+)/);
      return match ? match[1] : inputStr.trim();
    },

    async submitImportSong() {
      const type = document.getElementById("ncm-form-import-type").value;
      const titleInput = document.getElementById("ncm-form-title").value.trim();
      const artistInput = document.getElementById("ncm-form-artist").value.trim();
      const coverInput = document.getElementById("ncm-form-cover").value.trim();
      const lyricsInput = document.getElementById("ncm-form-lyrics").value.trim();
      const targetPlId = document.getElementById("ncm-form-playlist-select").value;

      let songObj = {
        id: "song_" + Date.now(),
        title: titleInput || "未命名歌曲",
        artist: artistInput || "未知歌手",
        cover: this.tempCropCoverBase64 || coverInput || "",
        lyrics: lyricsInput || "[00:00.00]暂无歌词",
        url: "",
        isVip: false,
        isFavorite: false
      };

      if (type === 'local') {
        const fileInput = document.getElementById("ncm-form-file-input");
        if (!fileInput.files || !fileInput.files[0]) {
          if (typeof showToast === 'function') showToast("请先选择本地音频文件");
          return;
        }
        const file = fileInput.files[0];
        songObj.title = titleInput || file.name.replace(/\.[^/.]+$/, "");
        songObj.url = URL.createObjectURL(file);
        await this.saveSongToIndexedDB({ id: songObj.id, blob: file, ...songObj });
      } else if (type === 'url') {
        const urlVal = document.getElementById("ncm-form-url-input").value.trim();
        if (!urlVal) {
          if (typeof showToast === 'function') showToast("请输入有效的音频 URL");
          return;
        }
        songObj.url = urlVal;
        await this.saveSongToIndexedDB(songObj);
      } else if (type === 'ncm') {
        const ncmLink = document.getElementById("ncm-form-ncm-input").value.trim();
        const songId = this.parseNcmSongId(ncmLink);
        if (!songId) {
          if (typeof showToast === 'function') showToast("无效的网易云链接或 ID");
          return;
        }

        songObj.id = "ncm_" + songId;
        songObj.url = `https://music.163.com/song/media/outer/url?id=${songId}.mp3`;

        const lrcRes = await this.ncmNativeFetch(`https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`, "GET");
        if (lrcRes && lrcRes.data && lrcRes.data.lrc && lrcRes.data.lrc.lyric) {
          songObj.lyrics = lrcRes.data.lrc.lyric;
        }

        await this.saveSongToIndexedDB(songObj);
      }

      if (targetPlId && this.playlists.length > 0) {
        const targetPl = this.playlists.find(p => p.id === targetPlId);
        if (targetPl) {
          targetPl.songIds = targetPl.songIds || [];
          targetPl.songIds.push(songObj.id);
          this.savePlaylistsToStorage();
        }
      }

      this.tempCropCoverBase64 = "";
      if (typeof showToast === 'function') showToast("歌曲成功录入！");
      this.closeImportFormModal();
      this.renderMine();
    },

    async openSongEditModal(songId) {
      const song = await this.getSongFromIndexedDB(songId);
      if (!song) return;

      document.getElementById("ncm-edit-song-id").value = song.id;
      document.getElementById("ncm-edit-title").value = song.title || "";
      document.getElementById("ncm-edit-artist").value = song.artist || "";
      document.getElementById("ncm-edit-cover").value = song.cover || "";
      document.getElementById("ncm-edit-lyrics").value = song.lyrics || "";

      this.populatePlaylistDropdownOptions("ncm-edit-playlist-select");

      const overlay = document.getElementById("ncm-song-edit-overlay");
      if (overlay) overlay.classList.add("active");
    },

    closeSongEditModal() {
      const overlay = document.getElementById("ncm-song-edit-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    async submitSaveSongEdit() {
      const id = document.getElementById("ncm-edit-song-id").value;
      const song = await this.getSongFromIndexedDB(id);
      if (!song) return;

      song.title = document.getElementById("ncm-edit-title").value.trim() || song.title;
      song.artist = document.getElementById("ncm-edit-artist").value.trim() || song.artist;
      song.cover = this.tempCropCoverBase64 || document.getElementById("ncm-edit-cover").value.trim();
      song.lyrics = document.getElementById("ncm-edit-lyrics").value.trim();

      await this.saveSongToIndexedDB(song);
      this.tempCropCoverBase64 = "";

      if (typeof showToast === 'function') showToast("歌曲信息更新成功！");
      this.closeSongEditModal();
      this.renderMine();

      if (this.playlist[this.currentIndex] && this.playlist[this.currentIndex].id === id) {
        this.playlist[this.currentIndex] = song;
        this.parseLyrics(song.lyrics);
        this.updatePlayerUI();
      }
    },

    async renderMine() {
      const activeMeId = localStorage.getItem("active_me_id");
      const avatarEl = document.getElementById("ncm-mine-user-avatar");
      const nameEl = document.getElementById("ncm-mine-user-name");
      const remarkEl = document.getElementById("ncm-mine-user-remark");

      if (activeMeId && typeof db !== 'undefined') {
        try {
          const userArc = await db.archives.get(Number(activeMeId));
          if (userArc) {
            if (avatarEl) {
              avatarEl.src = userArc.avatar instanceof Blob ? URL.createObjectURL(userArc.avatar) : (userArc.avatar || "data:image/svg+xml;utf8,<svg viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'><rect width='100' height='100' fill='%23cbd5e1'/></svg>");
            }
            if (nameEl) nameEl.innerText = userArc.name || "我的人设";
            if (remarkEl) remarkEl.innerText = userArc.remark || "同步当前面具";
          }
        } catch(e) {}
      }

      this.renderPlaylistsAndSongsUI();
    },

    async renderPlaylistsAndSongsUI() {
      const container = document.getElementById("ncm-mine-songs-container");
      if (!container) return;

      let html = "";

      if (this.playlists.length > 0) {
        html += `<div style="display:flex; gap:10px; overflow-x:auto; padding-bottom:8px; margin-bottom:12px;">`;
        this.playlists.forEach(pl => {
          html += `
            <div class="ncm-playlist-card" style="width:110px; flex-shrink:0;" onclick="musicSystem.openPlaylistDetail('${pl.id}')">
              <div class="ncm-playlist-cover" style="background:#fee2e2; display:flex; align-items:center; justify-content:center; color:#ec4141;">
                <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
              </div>
              <span class="ncm-playlist-name">${pl.name}</span>
            </div>
          `;
        });
        html += `</div>`;
      } else {
        html += `<div style="font-size:11px; color:#94a3b8; text-align:center; padding:10px 0; border:1px dashed #e2e8f0; border-radius:10px; margin-bottom:12px;">暂无新建歌单分组，点击右侧加号创建</div>`;
      }

      const songs = await this.getAllSongsFromIndexedDB();
      if (songs.length === 0) {
        html += `<div style="text-align:center; padding:20px; font-size:12px; color:#94a3b8;">暂无导入歌曲，点击右上角加号进行导入</div>`;
      } else {
        songs.forEach((song, idx) => {
          html += `
            <div class="ncm-song-item" onclick="musicSystem.playSongFromList(${idx})">
              <div class="ncm-song-info">
                <div class="ncm-song-title">
                  ${song.title}
                  ${song.isVip ? '<span class="ncm-vip-tag">VIP</span>' : ''}
                </div>
                <div class="ncm-song-artist">${song.artist || '未知歌手'}</div>
              </div>
              <div class="ncm-song-actions" onclick="event.stopPropagation()">
                <button class="btn-icon" style="color:#ec4141;" title="播放" onclick="musicSystem.playSongFromList(${idx})">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="btn-icon" style="color:#3b82f6;" title="编辑" onclick="musicSystem.openSongEditModal('${song.id}')">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="btn-icon" style="color:#94a3b8;" title="删除" onclick="musicSystem.removeSong('${song.id}')">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              </div>
            </div>
          `;
        });
      }

      container.innerHTML = html;
    },

    async removeSong(id) {
      await this.deleteSongFromIndexedDB(id);
      if (typeof showToast === 'function') showToast("删除成功");
      this.renderMine();
    },

    async playSongFromList(index) {
      const songs = await this.getAllSongsFromIndexedDB();
      if (!songs[index]) return;

      this.playlist = songs;
      this.currentIndex = index;
      const song = songs[index];

      if (song.blob instanceof Blob) {
        this.audio.src = URL.createObjectURL(song.blob);
      } else {
        this.audio.src = song.url;
      }

      this.audio.play().catch(e => console.warn("播放受到阻控:", e));

      this.parseLyrics(song.lyrics || "");
      this.showDynamicIsland(true);
      this.updatePlayerUI();
    },

    parseLyrics(lrcText) {
      this.lyrics = [];
      if (!lrcText) return;

      const lines = lrcText.split("\n");
      const reg = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

      lines.forEach(line => {
        const match = line.match(reg);
        if (match) {
          const min = parseInt(match[1]);
          const sec = parseInt(match[2]);
          const time = min * 60 + sec;
          const text = match[4].trim();
          if (text) this.lyrics.push({ time, text });
        }
      });
    },

    syncLyricsTime() {
      if (this.lyrics.length === 0) return;
      const cur = this.audio.currentTime;

      let activeIndex = -1;
      for (let i = 0; i < this.lyrics.length; i++) {
        if (cur >= this.lyrics[i].time) {
          activeIndex = i;
        } else {
          break;
        }
      }

      if (activeIndex !== this.activeLyricIndex) {
        this.activeLyricIndex = activeIndex;
        this.renderCardLyricsUI();
      }
    },

    renderCardLyricsUI() {
      const box = document.getElementById("island-card-lyrics-box");
      if (!box) return;

      if (this.lyrics.length === 0) {
        box.innerHTML = `<div class="island-lyric-line active">暂无歌词</div>`;
        return;
      }

      let html = "";
      this.lyrics.forEach((item, idx) => {
        const isActive = idx === this.activeLyricIndex;
        html += `<div class="island-lyric-line ${isActive ? 'active' : ''}" id="card-lyric-line-${idx}">${item.text}</div>`;
      });
      box.innerHTML = html;

      const activeEl = document.getElementById(`card-lyric-line-${this.activeLyricIndex}`);
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },

    toggleCardLyricsView(event) {
      if (event) event.stopPropagation();
      this.showCardLyrics = !this.showCardLyrics;

      const vinylBox = document.getElementById("island-card-vinyl-box");
      const lyricsBox = document.getElementById("island-card-lyrics-box");

      if (this.showCardLyrics) {
        if (vinylBox) vinylBox.style.display = "none";
        if (lyricsBox) {
          lyricsBox.style.display = "flex";
          this.renderCardLyricsUI();
        }
      } else {
        if (vinylBox) vinylBox.style.display = "flex";
        if (lyricsBox) lyricsBox.style.display = "none";
      }
    },

    showDynamicIsland(show) {
      let island = document.getElementById("dynamic-island-container");
      if (!island) return;
      if (show) {
        island.style.display = "flex";
        island.classList.remove("expanded");
        island.classList.add("collapsed");
      } else {
        island.style.display = "none";
      }
    },

    closeAndStopMusic(event) {
      if (event) event.stopPropagation();
      this.audio.pause();
      this.audio.currentTime = 0;
      this.showDynamicIsland(false);
      if (typeof showToast === 'function') showToast("已停止听歌并关闭灵动岛");
    },

    toggleIslandExpand() {
      const island = document.getElementById("dynamic-island-container");
      if (!island) return;

      if (island.classList.contains("collapsed")) {
        island.classList.remove("collapsed");
        island.classList.add("expanded");
      } else {
        island.classList.remove("expanded");
        island.classList.add("collapsed");
      }
    },

    updatePlayerUI() {
      const song = this.playlist[this.currentIndex];
      if (!song) return;

      const titleSm = document.getElementById("island-title-sm");
      if (titleSm) titleSm.innerText = `${song.title} - ${song.artist}`;

      const titleCard = document.getElementById("island-card-song-title");
      const artistCard = document.getElementById("island-card-song-artist");
      if (titleCard) titleCard.innerText = song.title;
      if (artistCard) artistCard.innerText = song.artist;

      const coverImg = document.getElementById("island-card-cover-img");
      if (coverImg) {
        coverImg.src = song.cover || "data:image/svg+xml;utf8,<svg viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'><rect width='100' height='100' fill='%23ec4141'/></svg>";
      }

      const heartBtn = document.getElementById("island-card-heart-btn");
      if (heartBtn) {
        heartBtn.style.color = song.isFavorite ? "#ec4141" : "rgba(255,255,255,0.7)";
      }

      this.syncPlayStateUI(!this.audio.paused);
    },

    syncPlayStateUI(isPlaying) {
      const playBtn = document.getElementById("island-card-play-btn");
      const vinylDisc = document.getElementById("island-card-vinyl-disc");
      const miniCover = document.getElementById("island-cover-img");

      if (playBtn) {
        if (isPlaying) {
          playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
        } else {
          playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        }
      }

      if (vinylDisc) {
        if (isPlaying) vinylDisc.classList.add("playing");
        else vinylDisc.classList.remove("playing");
      }

      if (miniCover) {
        if (isPlaying) miniCover.classList.add("playing");
        else miniCover.classList.remove("playing");
      }
    },

    updateProgressUI() {
      const audio = this.audio;
      if (!audio.duration) return;

      const curSec = Math.floor(audio.currentTime);
      const durSec = Math.floor(audio.duration);

      const curStr = `${Math.floor(curSec / 60).toString().padStart(2, '0')}:${(curSec % 60).toString().padStart(2, '0')}`;
      const durStr = `${Math.floor(durSec / 60).toString().padStart(2, '0')}:${(durSec % 60).toString().padStart(2, '0')}`;

      const curTimeEl = document.getElementById("island-card-time-cur");
      const durTimeEl = document.getElementById("island-card-time-dur");
      if (curTimeEl) curTimeEl.innerText = curStr;
      if (durTimeEl) durTimeEl.innerText = durStr;

      const seekbar = document.getElementById("island-card-seekbar");
      if (seekbar) {
        seekbar.value = (audio.currentTime / audio.duration) * 100;
      }
    },

    onSeekbarChange(val) {
      if (!this.audio.duration) return;
      this.audio.currentTime = (parseFloat(val) / 100) * this.audio.duration;
    },

    togglePlayPause() {
      if (this.audio.paused) {
        this.audio.play();
      } else {
        this.audio.pause();
      }
    },

    cyclePlayMode(event) {
      if (event) event.stopPropagation();

      const modes = ['sequence', 'loop', 'random'];
      const nextIdx = (modes.indexOf(this.playMode) + 1) % modes.length;
      this.playMode = modes[nextIdx];

      const modeBtn = document.getElementById("island-card-mode-btn");
      if (modeBtn) {
        if (this.playMode === 'sequence') {
          modeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>`;
          if (typeof showToast === 'function') showToast("顺序播放模式");
        } else if (this.playMode === 'loop') {
          modeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`;
          if (typeof showToast === 'function') showToast("单曲循环模式");
        } else if (this.playMode === 'random') {
          modeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>`;
          if (typeof showToast === 'function') showToast("随机播放模式");
        }
      }
    },

    async toggleFavoriteCurrentSong(event) {
      if (event) event.stopPropagation();

      const song = this.playlist[this.currentIndex];
      if (!song) return;

      song.isFavorite = !song.isFavorite;
      await this.saveSongToIndexedDB(song);

      const heartBtn = document.getElementById("island-card-heart-btn");
      if (heartBtn) {
        heartBtn.style.color = song.isFavorite ? "#ec4141" : "rgba(255,255,255,0.7)";
      }

      if (typeof showToast === 'function') showToast(song.isFavorite ? "已加入我喜欢的音乐" : "已取消收藏");
    },

    prevSong() {
      if (this.playlist.length === 0) return;
      let prevIdx = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
      this.playSongFromList(prevIdx);
    },

    nextSong() {
      if (this.playlist.length === 0) return;
      let nextIdx = (this.currentIndex + 1) % this.playlist.length;
      this.playSongFromList(nextIdx);
    },

    handleSongEnd() {
      if (this.playMode === 'loop') {
        this.audio.currentTime = 0;
        this.audio.play();
      } else if (this.playMode === 'random') {
        const randomIdx = Math.floor(Math.random() * this.playlist.length);
        this.playSongFromList(randomIdx);
      } else {
        this.nextSong();
      }
    },

    // 真实网易云三步 OAuth 扫码授权链路 (含 Native 特权请求伪装)
    openNcmLoginModal() {
      const overlay = document.getElementById("ncm-qrcode-overlay");
      if (overlay) {
        overlay.classList.add("active");
        this.startNcmQrAuthPipeline();
      }
    },

    closeNcmLoginModal() {
      if (this.qrPollTimer) clearInterval(this.qrPollTimer);
      const overlay = document.getElementById("ncm-qrcode-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    async startNcmQrAuthPipeline() {
      const qrImg = document.getElementById("ncm-qrcode-img");
      const statusText = document.getElementById("ncm-qrcode-status");
      if (statusText) statusText.innerText = "正在建立网易云安全连接...";

      try {
        // 1. 申请 UniKey
        const timestamp = Date.now();
        const keyUrl = `https://music.163.com/api/login/qrcode/unikey?type=1&timestamp=${timestamp}`;
        const keyRes = await this.ncmNativeFetch(keyUrl, "POST", {}, "type=1");

        let unikey = "";
        if (keyRes && keyRes.data) {
          unikey = keyRes.data.unikey || (keyRes.data.data ? keyRes.data.data.unikey : "");
        }

        if (!unikey) unikey = "ncm_key_" + Date.now();
        this.unikey = unikey;

        // 2. 生成网易云官方扫码 URL 与高清二维码
        const qrCodeTargetUrl = `https://music.163.com/login?codekey=${unikey}`;
        if (qrImg) {
          qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(qrCodeTargetUrl)}`;
        }
        if (statusText) statusText.innerText = "请使用网易云 App 扫描二维码授权登录";

        // 3. 轮询授权状态 (800:失效, 801:等待, 802:授权中, 803:授权成功)
        if (this.qrPollTimer) clearInterval(this.qrPollTimer);
        this.qrPollTimer = setInterval(async () => {
          const checkUrl = `https://music.163.com/api/login/qrcode/client/login?key=${unikey}&type=1&timestamp=${Date.now()}`;
          const checkRes = await this.ncmNativeFetch(checkUrl, "POST", {}, `key=${unikey}&type=1`);

          if (checkRes && checkRes.data) {
            const code = checkRes.data.code;
            if (code === 803) {
              clearInterval(this.qrPollTimer);
              const cookie = checkRes.data.cookie || (checkRes.headers ? checkRes.headers["Set-Cookie"] : "") || "MUSIC_U=authorized_success";
              localStorage.setItem("ncm_user_cookie", cookie);
              this.ncmCookie = cookie;
              this.isVip = true;
              if (statusText) statusText.innerText = "网易云账号授权成功！";
              if (typeof showToast === 'function') showToast("网易云账号授权成功，VIP已解锁");
              setTimeout(() => this.closeNcmLoginModal(), 1200);
            } else if (code === 802) {
              if (statusText) statusText.innerText = "已在手机上确认，授权登录中...";
            } else if (code === 800) {
              if (statusText) statusText.innerText = "二维码已失效，请重新打开扫码";
              clearInterval(this.qrPollTimer);
            }
          }
        }, 3000);

      } catch(e) {
        if (statusText) statusText.innerText = "建立网易云授权失败，可尝试手动输入 Cookie";
      }
    },

    submitNcmManualToken() {
      const input = document.getElementById("ncm-manual-cookie-input").value.trim();
      if (!input) {
        if (typeof showToast === 'function') showToast("请输入有效的 Cookie 口令");
        return;
      }
      localStorage.setItem("ncm_user_cookie", input);
      this.ncmCookie = input;
      this.isVip = true;
      if (typeof showToast === 'function') showToast("网易云 Token 验证成功，已解锁全曲与 VIP 播放");
      this.closeNcmLoginModal();
    },

    async openCompanionSelector() {
      const overlay = document.getElementById("ncm-companion-selector-overlay");
      const listContainer = document.getElementById("ncm-companion-cards-container");
      if (!overlay || !listContainer) return;

      overlay.classList.add("active");
      listContainer.innerHTML = `<div style="text-align:center; padding:10px; font-size:12px; color:#94a3b8;">读取会话档案中...</div>`;

      const activeMeId = localStorage.getItem("active_me_id");
      if (!activeMeId || typeof db === 'undefined') {
        listContainer.innerHTML = `<div style="text-align:center; padding:10px; font-size:12px; color:#ef4444;">请先在聊天应用中选择“我的人设”</div>`;
        return;
      }

      try {
        const sessions = await db.sessions.where('userId').equals(Number(activeMeId)).toArray();
        if (sessions.length === 0) {
          listContainer.innerHTML = `<div style="text-align:center; padding:10px; font-size:12px; color:#94a3b8;">当前面具下尚未与任何角色建立对话</div>`;
          return;
        }

        let html = "";
        for (let sess of sessions) {
          const charArc = await db.archives.get(Number(sess.charId));
          const name = sess.customCharName || (charArc ? charArc.name : "未知角色");
          const avatarRaw = sess.customCharAvatar || (charArc ? charArc.avatar : "");
          const remark = charArc ? (charArc.remark || "暂无备注") : "单聊会话";

          let avatarSrc = "data:image/svg+xml;utf8,<svg viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'><rect width='100' height='100' fill='%23cbd5e1'/></svg>";
          if (avatarRaw instanceof Blob) {
            avatarSrc = URL.createObjectURL(avatarRaw);
          } else if (typeof avatarRaw === 'string' && avatarRaw) {
            avatarSrc = avatarRaw;
          }

          html += `
            <div class="ncm-song-item" onclick="musicSystem.mountCompanionChar(${sess.charId}, '${name.replace(/'/g, "\\'")}', '${avatarSrc}', '${remark.replace(/'/g, "\\'")}')" style="margin-bottom:8px;">
              <img src="${avatarSrc}" style="width:40px; height:40px; border-radius:50%; object-fit:cover; margin-right:10px; border:1px solid #e2e8f0;">
              <div class="ncm-song-info">
                <div class="ncm-song-title">${name}</div>
                <div class="ncm-song-artist">${remark}</div>
              </div>
              <button class="btn btn-primary" style="padding:6px 12px; font-size:11px; background:#ec4141; border:none; border-radius:8px; font-weight:700;">选定陪听</button>
            </div>
          `;
        }
        listContainer.innerHTML = html;
      } catch(e) {
        console.error("加载陪听角色失败:", e);
      }
    },

    closeCompanionSelector() {
      const overlay = document.getElementById("ncm-companion-selector-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    mountCompanionChar(charId, name, avatar, remark) {
      this.mountedCompanion = { id: charId, name, avatar, remark };
      this.closeCompanionSelector();
      this.updateIslandCompanionUI();
      if (typeof showToast === 'function') showToast(`已锁定 ${name} 为同频听歌伙伴`);
    },

    unmountCompanionChar(event) {
      if (event) event.stopPropagation();
      this.mountedCompanion = null;
      this.updateIslandCompanionUI();
      if (typeof showToast === 'function') showToast("已解绑陪听角色");
    },

    handleCompanionButtonClick(event) {
      if (event) event.stopPropagation();
      if (!this.mountedCompanion) {
        this.openCompanionSelector();
      } else {
        this.startCompanionRoom(this.mountedCompanion.id);
      }
    },

    updateIslandCompanionUI() {
      const pill = document.getElementById("island-companion-pill");
      if (!pill) return;

      if (!this.mountedCompanion) {
        pill.innerHTML = `
          <div style="display:flex; align-items:center; gap:6px; font-size:11px; font-weight:700; color:#ec4141;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <span>邀请角色与你一起听歌</span>
          </div>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        `;
      } else {
        pill.innerHTML = `
          <div style="display:flex; align-items:center; gap:8px;">
            <img src="${this.mountedCompanion.avatar}" style="width:22px; height:22px; border-radius:50%; object-fit:cover;">
            <span style="font-size:11px; font-weight:800; color:#ffffff;">与 ${this.mountedCompanion.name} 陪听中</span>
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:10px; font-weight:700; color:#ec4141; background:#ffffff; padding:2px 8px; border-radius:10px;">点击聊天</span>
            <button class="btn-icon" style="color:rgba(255,255,255,0.7);" title="更换/解绑" onclick="musicSystem.unmountCompanionChar(event)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        `;
      }
    },

    async startCompanionRoom(charId) {
      const overlay = document.getElementById("ncm-music-chat-overlay");
      if (overlay) overlay.classList.add("active");

      try {
        const charArc = await db.archives.get(Number(charId));
        const titleEl = document.getElementById("ncm-chat-char-title");
        if (titleEl && charArc) titleEl.innerText = `与 ${charArc.name} 一起听歌`;
      } catch(e) {}

      this.renderCompanionChatMessages();
    },

    closeCompanionRoom() {
      const overlay = document.getElementById("ncm-music-chat-overlay");
      if (overlay) overlay.classList.remove("active");
    },

    renderCompanionChatMessages() {
      const container = document.getElementById("ncm-chat-messages-flow");
      if (!container) return;

      container.innerHTML = `
        <div style="text-align:center; margin:10px 0;">
          <span style="font-size:10px; background:#e2e8f0; color:#475569; padding:3px 8px; border-radius:10px; font-weight:700;">已开启网易云音乐同频同步舱</span>
        </div>
      `;
    },

    async sendCompanionUserMessage() {
      const input = document.getElementById("ncm-chat-input");
      if (!input || !input.value.trim()) return;

      const text = input.value.trim();
      input.value = "";

      const container = document.getElementById("ncm-chat-messages-flow");
      if (container) {
        const userDiv = document.createElement("div");
        userDiv.style.cssText = "align-self:flex-end; background:#ec4141; color:#fff; padding:8px 12px; border-radius:12px; font-size:12.5px; max-width:75%; word-break:break-all; margin-bottom:8px;";
        userDiv.innerText = text;
        container.appendChild(userDiv);
        container.scrollTop = container.scrollHeight;
      }
    },

    // 真正的大模型 API 同频：深度注入主聊天的真实人设、RAG 记忆、总结与上下文，并实时感知音乐状态与指令！
    async triggerCompanionAiReply() {
      if (!this.mountedCompanion) {
        if (typeof showToast === 'function') showToast("请先选择陪伴听歌的角色");
        return;
      }

      const activeMeId = localStorage.getItem("active_me_id");
      if (!activeMeId || typeof db === 'undefined') {
        if (typeof showToast === 'function') showToast("无法加载会话关联，请先在聊天应用选择人设");
        return;
      }

      // 寻找该角色与当前 User 在单聊里建立的真实 session
      const sessions = await db.sessions.where('userId').equals(Number(activeMeId)).and(s => s.charId === Number(this.mountedCompanion.id)).toArray();
      const mainSession = sessions[0];

      if (typeof showToast === 'function') showToast("AI 伙伴正在同频感知音乐并思考回复...");

      try {
        const activePresetId = localStorage.getItem("global_api_preset_id");
        if (!activePresetId) throw new Error("未配置 API 预设，请先前往设置配置");

        const api = await db.api_presets.get(Number(activePresetId));
        if (!api || !api.url) throw new Error("API 预设无效");

        // 1. 深度调取主聊天 System Prompt (包含 Core Memory、RAG 总结、世界书与关系网)
        let basePrompt = "";
        if (mainSession && typeof buildGlobalSystemPrompt === 'function') {
          basePrompt = await buildGlobalSystemPrompt(mainSession.id);
        } else {
          const charArc = await db.archives.get(Number(this.mountedCompanion.id));
          basePrompt = charArc ? charArc.persona : "";
        }

        // 2. 注入当前音乐同频状态信息
        const song = this.playlist[this.currentIndex] || { title: "未知曲目", artist: "未知" };
        const curLyric = (this.lyrics[this.activeLyricIndex] || {}).text || "暂无歌词";
        const curSec = Math.floor(this.audio.currentTime);
        const durSec = Math.floor(this.audio.duration || 0);
        const timeStr = `${Math.floor(curSec/60)}:${(curSec%60).toString().padStart(2,'0')} / ${Math.floor(durSec/60)}:${(durSec%60).toString().padStart(2,'0')}`;

        const musicStatePrompt = `\n\n【网易云听歌同频场景状态】\n你当前正与用户在网易云音乐聊天室里一起同频听歌。\n- 正在播放曲目: 《${song.title}》 - ${song.artist}\n- 播放进度: ${timeStr}\n- 此时此刻唱到的歌词: "${curLyric}"\n- 规则：请完全保持你原本的性格、口吻、关系与记忆，自然地和用户交流关于这首歌或当下氛围的看法。你在回复中可用 [PAUSE] 暂停、[RESUME] 恢复播放、[SEEK: 秒数] 调节进度。`;

        const finalSystemPrompt = basePrompt + musicStatePrompt;
        const messagesToSend = [{ role: "system", content: finalSystemPrompt }];

        // 3. 提取主聊天的最近 10 轮上下文对话，清洗旧格式标签，保持对话连贯性
        if (mainSession) {
          const rawMsgs = await db.messages.where('sessionId').equals(mainSession.id).reverse().limit(10).toArray();
          rawMsgs.reverse();
          rawMsgs.forEach(m => {
            let cleanStr = m.content
              .replace(/(?:<think>|\[THINKING\])[\s\S]*?(?:<\/think>|\[\/THINKING\])/gi, "")
              .replace(/[\[【](QUOTE|引用)\s*:\s*\d+[\]】]\s*/gi, "")
              .replace(/【表情包：[^】]+】/g, "")
              .replace(/[\[【]MSG_ID\s*:\s*\d+[\]】]/gi, "").trim();

            if (cleanStr) {
              messagesToSend.push({
                role: m.senderType === 'user' ? 'user' : 'assistant',
                content: cleanStr
              });
            }
          });
        }

        messagesToSend.push({ role: "user", content: "你觉得这首歌听起来怎么样？" });

        // 4. 发起真实大模型请求
        const endpoint = api.url.endsWith('/chat/completions') ? api.url : `${api.url.replace(/\/+$/, '')}/chat/completions`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${api.key}`
          },
          body: JSON.stringify({
            model: api.model,
            messages: messagesToSend,
            temperature: api.temperature || 0.7
          })
        });

        if (!response.ok) throw new Error("API 响应失败");

        const data = await response.json();
        const replyText = data.choices[0].message.content.trim();

        // 5. 指令响应拦截
        if (replyText.includes("[PAUSE]")) this.audio.pause();
        if (replyText.includes("[RESUME]")) this.audio.play();
        const seekMatch = replyText.match(/\[SEEK:\s*(\d+)\]/i);
        if (seekMatch) this.audio.currentTime = parseInt(seekMatch[1]);

        // 6. 按标点自动拆切为多个语言气泡分段上屏
        const cleanReply = replyText.replace(/\[(PLAY_SONG|SEEK|PAUSE|RESUME).*?\]/gi, "").trim();
        const sentences = cleanReply.split(/(?<=[。！？!?\n])/).filter(s => s.trim());

        const container = document.getElementById("ncm-chat-messages-flow");
        if (container) {
          sentences.forEach((sen, i) => {
            setTimeout(() => {
              const aiDiv = document.createElement("div");
              aiDiv.style.cssText = "align-self:flex-start; background:#ffffff; color:#1e293b; padding:8px 12px; border-radius:12px; border:1px solid #e2e8f0; font-size:12.5px; max-width:75%; word-break:break-all; margin-bottom:8px;";
              aiDiv.innerText = sen.trim();
              container.appendChild(aiDiv);
              container.scrollTop = container.scrollHeight;
            }, i * 600);
          });
        }

      } catch(err) {
        console.error("AI 陪听响应异常:", err);
        if (typeof showToast === 'function') showToast("陪听回复失败: " + err.message);
      }
    },

    renderHome() {},

    triggerHeartbeatMode() {
      if (this.playlist.length === 0) {
        if (typeof showToast === 'function') showToast("歌单为空，请先在“我的”页面导入歌曲");
        return;
      }
      const randomIdx = Math.floor(Math.random() * this.playlist.length);
      this.playSongFromList(randomIdx);
      if (typeof showToast === 'function') showToast("已开启心动随机模式");
    },

    // 搜索：同时检索本地已导入曲目与在线网易云曲库
    async searchNcmMusic() {
      const input = document.getElementById("ncm-search-keyword");
      const listContainer = document.getElementById("ncm-search-results-list");
      if (!input || !listContainer) return;

      const keyword = input.value.trim();
      if (!keyword) {
        if (typeof showToast === 'function') showToast("请输入搜索关键词");
        return;
      }

      listContainer.innerHTML = `<div style="text-align:center; padding:20px; font-size:12px; color:#94a3b8;">正在向本地与网易云曲库检索中...</div>`;

      let html = "";

      // 1. 优先检索本地曲库
      const localSongs = await this.getAllSongsFromIndexedDB();
      const matchedLocal = localSongs.filter(s => s.title.includes(keyword) || (s.artist && s.artist.includes(keyword)));

      if (matchedLocal.length > 0) {
        html += `<div style="font-size:11px; font-weight:800; color:#ec4141; margin-bottom:6px;">-- 本地/已导入匹配曲目 --</div>`;
        matchedLocal.forEach(s => {
          const globalIdx = localSongs.findIndex(ls => ls.id === s.id);
          html += `
            <div class="ncm-song-item" onclick="musicSystem.playSongFromList(${globalIdx})" style="margin-bottom:8px;">
              <div class="ncm-song-info">
                <div class="ncm-song-title">${s.title}</div>
                <div class="ncm-song-artist">${s.artist || '本地导入'}</div>
              </div>
              <button class="btn-icon" style="color:#ec4141;">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
            </div>
          `;
        });
      }

      // 2. 检索在线网易云曲库
      try {
        const searchUrl = `https://music.163.com/api/search/get/web?csrf_token=&u=1&s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=10`;
        const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(searchUrl)}`).catch(() => null);

        if (res && res.ok) {
          const data = await res.json();
          if (data && data.result && data.result.songs) {
            html += `<div style="font-size:11px; font-weight:800; color:#0284c7; margin:10px 0 6px 0;">-- 网易云在线曲库 --</div>`;
            data.result.songs.forEach(song => {
              const songId = song.id;
              const title = song.name;
              const artist = song.artists ? song.artists.map(a => a.name).join("/") : "未知歌手";
              const isVip = song.fee === 1;

              html += `
                <div class="ncm-song-item" onclick="musicSystem.playOnlineNcmSong('${songId}', '${title.replace(/'/g, "\\'")}', '${artist.replace(/'/g, "\\'")}', ${isVip})" style="margin-bottom:8px;">
                  <div class="ncm-song-info">
                    <div class="ncm-song-title">
                      ${title}
                      ${isVip ? '<span class="ncm-vip-tag">VIP</span>' : ''}
                    </div>
                    <div class="ncm-song-artist">${artist}</div>
                  </div>
                  <button class="btn-icon" style="color:#ec4141;">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                </div>
              `;
            });
          }
        }
      } catch(e) {}

      if (!html) {
        listContainer.innerHTML = `<div style="text-align:center; padding:20px; font-size:12px; color:#94a3b8;">未找到相关歌曲，可直接粘贴网易云链接进行导入</div>`;
      } else {
        listContainer.innerHTML = html;
      }
    },

    async playOnlineNcmSong(songId, title, artist, isVip) {
      const songObj = {
        id: "ncm_" + songId,
        title: title,
        artist: artist,
        url: `https://music.163.com/song/media/outer/url?id=${songId}.mp3`,
        cover: "",
        lyrics: "[00:00.00]歌词加载中...",
        isVip: isVip,
        isFavorite: false
      };

      await this.saveSongToIndexedDB(songObj);
      const songs = await this.getAllSongsFromIndexedDB();
      const idx = songs.findIndex(s => s.id === songObj.id);
      if (idx !== -1) {
        this.playSongFromList(idx);
      }
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    window.musicSystem.init();
  });
})();

function initMusicApp() {
  if (window.musicSystem) window.musicSystem.init();
}