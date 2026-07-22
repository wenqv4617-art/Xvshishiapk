// db.js - 初始化本地 IndexedDB 数据库
const db = new Dexie("StoryPhoneDatabase");

// 声明表结构 (升级至 Version 15 建立设备数据长期持久化和阅读多段复合索引通道)
db.version(15).stores({
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

  // 总结记录表 (支持分类检索与热词存储)
  summaries: 'id++, sessionId, startRound, endRound, content, keywords, timestamp, category',

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
  html_cards: 'id++, sessionId, timestamp',

  // === Version 11 新增：独立悬浮多状态桌宠存储表 ===
  desktop_pets: 'charId, mode',

  // === Version 13 新增：阅读应用专属物理数据表 ===
  reader_books: 'id++, title, author, summary, coverUrl, isImported, fileType, currentChapterId, collected',
  reader_chapters: 'id++, [bookId+chapterNum], bookId, chapterNum, title, content, summary',
  reader_presets: 'id++, name, prompt',
  reader_tags: 'id++, name',

  // === Version 15 新增：查手机设备数据长期持久化存储表 ===
  check_phone_states: 'sessionId',

  // === Version 16 新增：系统级论坛社交应用专属物理表 ===
  forum_accounts: 'id++, avatar, nickname, username, signature, boundPresetId',
  forum_posts: 'id++, authorId, title, content, media, createdAt, views, likesCount, commentsCount, forwardsCount',
  forum_comments: 'id++, postId, parentCommentId, authorId, content, createdAt, likesCount',
  forum_likes: 'id++, userId, targetId, targetType, createdAt',
  forum_forwards: 'id++, userId, postId, comment, createdAt',
  forum_notifications: 'id++, userId, type, targetId, fromUserId, isRead, createdAt',
  forum_conversations: 'id++, user1Id, user2Id, lastMessageTime',
  forum_messages: 'id++, conversationId, senderId, content, contentType, createdAt',
  forum_follows: 'id++, followerId, followeeId, createdAt',
  forum_presets: 'id++, name, forumName, atmosphere, mountedEntryIds',
  forum_npc_accounts: 'id++, charId, nickname, avatar, postFrequency, postPreference'
});

// === Version 17 新增：系统级群聊、群成员与群投票物理表 ===
db.version(17).stores({
  api_presets: 'id++, name, protocol, url, key, model, temperature',
  archives: 'id++, type, name, avatar, remark, group, persona, parentId', 
  relations: 'id++, fromId, toId, relation',
  sessions: 'id++, userId, charId, customCharName, customCharAvatar, customCharPersona, customUserAvatar, customUserPersona, lastMessageTime, mountedEntryIds, offlineMinWordCount, offlineMaxWordCount, offlineAutoSummaryCount, offlineMountedEntryIds, stickerMountedGroupIds, autoSummaryToggle, autoSummaryInterval, bufferRounds, summarySystemPrompt, coreSelfStatus, coreSelfPurpose, coreSelfChanges, coreRelationship, coreUserInEyes',
  messages: 'id++, sessionId, senderType, senderId, content, contentType, timestamp, isFavorite',
  world_book_entries: 'id++, group, title, content, depth, isActive',
  theaters: 'id++, sessionId, name, scenario, minWordCount, maxWordCount, carryMemory, createdAt',
  offline_messages: 'id++, theaterId, sessionId, isTheater, senderType, content, timestamp, isFavorite',
  status_history: 'id++, sessionId, theaterId, isTheater, timestamp, attire, affection, excitement, thoughts, hiddenCorners',
  sticker_groups: 'id++, name, sortOrder',
  sticker_items: 'id++, groupId, sortOrder, imageUrl, caption',
  summaries: 'id++, sessionId, startRound, endRound, content, keywords, timestamp, category',
  deeptalks: 'id++, sessionId, userId, charId, topic, status, createdAt',
  deeptalk_messages: 'id++, deeptalkId, senderType, timestamp',
  deeptalk_thoughts: 'id++, deeptalkId, sessionId, timestamp',
  deeptalk_presets: 'id++, name',
  moments: 'id++, userId, senderType, senderId, timestamp',
  moment_comments: 'id++, momentId, senderType, senderId, timestamp',
  moment_settings: 'id++, userId',
  html_cards: 'id++, sessionId, timestamp',
  desktop_pets: 'charId, mode',
  reader_books: 'id++, title, author, summary, coverUrl, isImported, fileType, currentChapterId, collected',
  reader_chapters: 'id++, [bookId+chapterNum], bookId, chapterNum, title, content, summary',
  reader_presets: 'id++, name, prompt',
  reader_tags: 'id++, name',
  check_phone_states: 'sessionId',
  forum_accounts: 'id++, avatar, nickname, username, signature, boundPresetId',
  forum_posts: 'id++, authorId, title, content, media, createdAt, views, likesCount, commentsCount, forwardsCount',
  forum_comments: 'id++, postId, parentCommentId, authorId, content, createdAt, likesCount',
  forum_likes: 'id++, userId, targetId, targetType, createdAt',
  forum_forwards: 'id++, userId, postId, comment, createdAt',
  forum_notifications: 'id++, userId, type, targetId, fromUserId, isRead, createdAt',
  forum_conversations: 'id++, user1Id, user2Id, lastMessageTime',
  forum_messages: 'id++, conversationId, senderId, content, contentType, createdAt',
  forum_follows: 'id++, followerId, followeeId, createdAt',
  forum_presets: 'id++, name, forumName, atmosphere, mountedEntryIds',
  forum_npc_accounts: 'id++, charId, nickname, avatar, postFrequency, postPreference',
  
  // 新增群聊控制表组
  groups: 'id++, name, avatar, ownerId, ownerType',
  group_members: 'id++, groupId, memberId, memberType',
  group_polls: 'id++, groupId, messageId'
});

// === Version 18 升级：建立复合索引以解决群成员多态查询 SchemaError 异常 ===
db.version(18).stores({
  api_presets: 'id++, name, protocol, url, key, model, temperature',
  archives: 'id++, type, name, avatar, remark, group, persona, parentId', 
  relations: 'id++, fromId, toId, relation',
  sessions: 'id++, userId, charId, customCharName, customCharAvatar, customCharPersona, customUserAvatar, customUserPersona, lastMessageTime, mountedEntryIds, offlineMinWordCount, offlineMaxWordCount, offlineAutoSummaryCount, offlineMountedEntryIds, stickerMountedGroupIds, autoSummaryToggle, autoSummaryInterval, bufferRounds, summarySystemPrompt, coreSelfStatus, coreSelfPurpose, coreSelfChanges, coreRelationship, coreUserInEyes',
  messages: 'id++, sessionId, senderType, senderId, content, contentType, timestamp, isFavorite',
  world_book_entries: 'id++, group, title, content, depth, isActive',
  theaters: 'id++, sessionId, name, scenario, minWordCount, maxWordCount, carryMemory, createdAt',
  offline_messages: 'id++, theaterId, sessionId, isTheater, senderType, content, timestamp, isFavorite',
  status_history: 'id++, sessionId, theaterId, isTheater, timestamp, attire, affection, excitement, thoughts, hiddenCorners',
  sticker_groups: 'id++, name, sortOrder',
  sticker_items: 'id++, groupId, sortOrder, imageUrl, caption',
  summaries: 'id++, sessionId, startRound, endRound, content, keywords, timestamp, category',
  deeptalks: 'id++, sessionId, userId, charId, topic, status, createdAt',
  deeptalk_messages: 'id++, deeptalkId, senderType, timestamp',
  deeptalk_thoughts: 'id++, deeptalkId, sessionId, timestamp',
  deeptalk_presets: 'id++, name',
  moments: 'id++, userId, senderType, senderId, timestamp',
  moment_comments: 'id++, momentId, senderType, senderId, timestamp',
  moment_settings: 'id++, userId',
  html_cards: 'id++, sessionId, timestamp',
  desktop_pets: 'charId, mode',
  reader_books: 'id++, title, author, summary, coverUrl, isImported, fileType, currentChapterId, collected',
  reader_chapters: 'id++, [bookId+chapterNum], bookId, chapterNum, title, content, summary',
  reader_presets: 'id++, name, prompt',
  reader_tags: 'id++, name',
  check_phone_states: 'sessionId',
  forum_accounts: 'id++, avatar, nickname, username, signature, boundPresetId',
  forum_posts: 'id++, authorId, title, content, media, createdAt, views, likesCount, commentsCount, forwardsCount',
  forum_comments: 'id++, postId, parentCommentId, authorId, content, createdAt, likesCount',
  forum_likes: 'id++, userId, targetId, targetType, createdAt',
  forum_forwards: 'id++, userId, postId, comment, createdAt',
  forum_notifications: 'id++, userId, type, targetId, fromUserId, isRead, createdAt',
  forum_conversations: 'id++, user1Id, user2Id, lastMessageTime',
  forum_messages: 'id++, conversationId, senderId, content, contentType, createdAt',
  forum_follows: 'id++, followerId, followeeId, createdAt',
  forum_presets: 'id++, name, forumName, atmosphere, mountedEntryIds',
  forum_npc_accounts: 'id++, charId, nickname, avatar, postFrequency, postPreference',
  
  groups: 'id++, name, avatar, ownerId, ownerType',
  group_members: 'id++, groupId, memberId, memberType, [groupId+memberId+memberType]',
  group_polls: 'id++, groupId, messageId'
});

// ============================================
// 🎯 新增 Version 20：只写“新增的表”和“改动的表”
// ============================================
db.version(20).stores({
  // 1. 如果你之前有表报错缺少索引，要在这里复写它
  
  // 2. 你新加的情侣空间模块的 4 张表：
  couples_schedules: 'id++, charId, date',
  couples_albums: 'id++, charId, timestamp',
  couples_journals: 'id++, charId',
  couples_whispers: 'id++, charId, timestamp'
});
