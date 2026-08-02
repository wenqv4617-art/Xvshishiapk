/**
 * app_changelog.js - 面向用户的更新日志
 * 专供用户查看每次更新的内容，使用通俗语言描述新增功能、修复的问题和改善的体验。
 */

const CHANGELOG_DATA = [
  {
    version: "v2.4",
    date: "2026-08-02",
    title: "AI 闹钟、音乐中枢与通知升级",
    features: [
      "AI 现在可以自主给你设定闹钟了——跟它说「半小时后叫我」或「明早 8 点喊我起床」，它就会帮你设好闹钟，还会在聊天里告诉你设了多久",
      "闹钟铃声支持自定义：可以从本地音乐或听歌乐库里选一首歌当闹钟铃声，不再只有系统默认提示音",
      "闹钟支持按分钟、小时设置，不用再换算成秒数（比如「2 小时」「30 分钟」都能直接设）",
      "听歌乐库里的歌单和歌曲现在会同步到 MCP 中枢，AI 放歌时可以从乐库里挑",
      "MCP 音乐列表改成手风琴分类样式，本地歌曲和乐库歌单分开折叠显示，更清晰好看",
      "MCP 闹钟模块新增倒计时显示：设了闹钟后会实时显示还剩多久响铃，还能一键取消",
      "设置页新增「更新日志」入口，随时查看每次更新了什么"
    ],
    fixes: [
      "修复了 AI 放歌指令有时显示在聊天气泡里的问题，现在指令会被自动隐藏",
      "修复了 AI 设闹钟失败的问题（之前提示词格式导致 AI 生成了错误的指令）",
      "修复了听歌乐库歌单没有同步到 MCP 中枢的问题",
      "修复了 MCP 歌曲列表条目高度为 0、显示不全的问题"
    ],
    improvements: [
      "通知改成跟微信、QQ 一样的弹出式卡片，会从屏幕顶端弹出来，带振动和声音，不再静默",
      "AI 主动发消息时现在能看到之前聊了什么、隔了多久，不会再重复回复你上一句话",
      "AI 主动发消息时也可以放歌、设闹钟了，而且指令不会显示在气泡里",
      "闹钟到点时如果设了自定义铃声，会自动播放你选的那首歌"
    ]
  },
  {
    version: "v2.3",
    date: "2026-07-30",
    title: "MCP 中枢与后台保活",
    features: [
      "新增 MCP 中枢面板：集中管理设备传感器、本地音乐、闹钟等能力",
      "AI 可以主动播放本地音乐给你听",
      "新增后台保活机制：离开 App 也能收到 AI 的消息通知"
    ],
    improvements: [
      "闹钟和主动发信支持在 App 后台运行时触发"
    ]
  }
];

window.changelogSystem = {
  /**
   * 渲染更新日志到指定容器
   */
  renderChangelog: function(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    let html = '';
    CHANGELOG_DATA.forEach((entry, idx) => {
      const isLatest = idx === 0;
      const badge = isLatest
        ? '<span style="display:inline-block; padding:2px 8px; font-size:10px; font-weight:700; color:#fff; background:linear-gradient(135deg,#6366f1,#8b5cf6); border-radius:10px; margin-left:8px; vertical-align:middle;">最新</span>'
        : '';

      html += `<div style="background:#fff; border:1.5px solid var(--border); border-radius:14px; padding:16px; margin-bottom:14px; ${isLatest ? 'border-color:#6366f1; box-shadow:0 2px 12px rgba(99,102,241,0.12);' : ''}">`;

      // 版本头
      html += `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px dashed var(--border);">`;
      html += `<span style="font-size:16px; font-weight:800; color:var(--text-primary);">${entry.version}</span>`;
      html += `<span style="font-size:12px; color:var(--text-secondary); margin-left:2px;">${entry.date}</span>`;
      html += badge;
      html += `<span style="font-size:13px; color:var(--text-primary); font-weight:600; margin-left:8px;">${entry.title}</span>`;
      html += `</div>`;

      // 新功能
      if (entry.features && entry.features.length > 0) {
        html += `<div style="margin-bottom:12px;">`;
        html += `<div style="font-size:12px; font-weight:700; color:#16a34a; margin-bottom:6px; display:flex; align-items:center; gap:4px;">`;
        html += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20" opacity="0"/><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>`;
        html += `新增功能</div>`;
        html += `<ul style="margin:0; padding-left:18px; list-style:disc;">`;
        entry.features.forEach(f => {
          html += `<li style="font-size:12px; color:var(--text-primary); line-height:1.7; margin-bottom:3px;">${f}</li>`;
        });
        html += `</ul></div>`;
      }

      // 问题修复
      if (entry.fixes && entry.fixes.length > 0) {
        html += `<div style="margin-bottom:12px;">`;
        html += `<div style="font-size:12px; font-weight:700; color:#dc2626; margin-bottom:6px; display:flex; align-items:center; gap:4px;">`;
        html += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
        html += `问题修复</div>`;
        html += `<ul style="margin:0; padding-left:18px; list-style:disc;">`;
        entry.fixes.forEach(f => {
          html += `<li style="font-size:12px; color:var(--text-primary); line-height:1.7; margin-bottom:3px;">${f}</li>`;
        });
        html += `</ul></div>`;
      }

      // 体验优化
      if (entry.improvements && entry.improvements.length > 0) {
        html += `<div style="margin-bottom:0;">`;
        html += `<div style="font-size:12px; font-weight:700; color:#2563eb; margin-bottom:6px; display:flex; align-items:center; gap:4px;">`;
        html += `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;
        html += `体验优化</div>`;
        html += `<ul style="margin:0; padding-left:18px; list-style:disc;">`;
        entry.improvements.forEach(f => {
          html += `<li style="font-size:12px; color:var(--text-primary); line-height:1.7; margin-bottom:3px;">${f}</li>`;
        });
        html += `</ul></div>`;
      }

      html += `</div>`;
    });

    // 底部说明
    html += `<div style="text-align:center; padding:16px 0 8px; font-size:11px; color:var(--text-secondary);">`;
    html += `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:middle; margin-right:4px; opacity:0.5;"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`;
    html += `感谢使用叙事诗小手机，我们会持续迭代优化体验`;
    html += `</div>`;

    container.innerHTML = html;
  },

  /**
   * 初始化更新日志面板（由 openSettingsLv2 调用）
   */
  initChangelogPanel: function() {
    this.renderChangelog("changelog-content");
  }
};
