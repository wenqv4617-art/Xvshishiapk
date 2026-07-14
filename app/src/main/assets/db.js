// db.js - 初始化本地 IndexedDB 数据库
const db = new Dexie("StoryPhoneDatabase");

// 声明表结构 (升级至 Version 10 增加 HTML 互动卡片存储系统)
db.version(10).stores({
  api_presets: 'id++, name, protocol, url, key, model, temperature',
  archives: 'id++, type, name, avatar, remark, group, persona, parentId', 
  relations: 'id++, fromId, toId, relation',
  sessions: 'id++, userId, charId, customCharName, customCharAvatar, customCharPersona, customUserAvatar, customUserPersona, lastMessageTime, mountedEntryIds, offlineMinWordCount, offlineMaxWordCount, offlineAutoSummaryCount, offlineMountedEntryIds, stickerMountedGroupIds, autoSummaryToggle, autoSummaryInterval, bufferRounds, summarySystemPrompt, coreSelfStatus, coreSelfPurpose, coreSelfChanges, coreRelationship, coreUserInEyes',
  messages: 'id++, sessionId, senderType, senderId, content, contentType, timestamp, isFavorite',
  world_book_entries: 'id++, group, title, content, depth, isActive',

  // 线下独立剧场模块与线下长卡片式会话
  theaters: 'id++, sessionId, name, scenario, minWordCount, maxWordCount, carryMemory, createdAt',
  offline_messages: 'id++, theaterId, sessionId, isTheater, senderType, content, timestamp, isFavorite',

  // 角色心声状态历史记录
  status_history: 'id++, sessionId, theaterId, isTheater, timestamp, attire, affection, excitement, thoughts, hiddenCorners',

  // 表情包分组与条目
  sticker_groups: 'id++, name, sortOrder',
  sticker_items: 'id++, groupId, sortOrder, imageUrl, caption',

  // 总结记录表 (支持会话、轮次索引定位与热词存储)
  summaries: 'id++, sessionId, startRound, endRound, content, keywords, timestamp',

  // 深谈主记录表 (支持面具/我的人设隔离、状态控制与时间索引)
  deeptalks: 'id++, sessionId, userId, charId, topic, status, createdAt',

  // 深谈具体对话卡片记录表
  deeptalk_messages: 'id++, deeptalkId, senderType, timestamp',

  // 角色在深谈中产生的微弱闪念 (小宇宙) 记录表
  deeptalk_thoughts: 'id++, deeptalkId, sessionId, timestamp',

  // 全局深谈附加提示词预设表
  deeptalk_presets: 'id++, name',

  // === Version 9 新增：朋友圈系统专属数据表 ===
  moments: 'id++, userId, senderType, senderId, timestamp',
  moment_comments: 'id++, momentId, senderType, senderId, timestamp',
  moment_settings: 'id++, userId',

  // === Version 10 新增：HTML 互动卡片存储表 ===
  html_cards: 'id++, sessionId, timestamp'
});