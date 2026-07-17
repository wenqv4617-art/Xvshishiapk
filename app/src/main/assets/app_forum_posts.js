/**
 * app_forum_posts.js - 主页帖子流、帖子详情、评论渲染、发帖表单与 NPC 自发巡航发帖任务
 */

let forumHomeSubTab = 'recommend';
let activePostDetailId = null;
let activeParentCommentId = 0;
let forumNpcCruiseTimer = null;

function forumSwitchHomeSubTab(tab) {
  forumHomeSubTab = tab;
  const subTabs = document.querySelectorAll("#forum-tab-home .sub-tab");
  subTabs.forEach(t => t.classList.remove("active"));
  
  const subTabMap = { follow: "关注", recommend: "推荐", nearby: "附近" };
  subTabs.forEach(t => {
    if (t.innerText === subTabMap[tab]) t.classList.add("active");
  });

  forumLoadPostsFeed();
}

async function forumLoadPostsFeed() {
  const container = document.getElementById("forum-posts-list");
  if (!container) return;
  
  if (typeof forumInitPullToRefresh === "function") {
    forumInitPullToRefresh();
  }

  let posts = await db.forum_posts.toArray();
  posts.sort((a,b) => b.createdAt - a.createdAt);

  // 反向 Timeline 隔离：找出归属于【其他账户】的 NPC，将其发帖隐藏；公共网民及当前账户的 NPC 帖子予以全面共享 [4]
  const otherNpcs = (await db.forum_npc_accounts.toArray())
    .filter(n => n.userId && Number(n.userId) !== Number(forumActiveAccountId))
    .map(n => n.id);

  posts = posts.filter(p => !otherNpcs.includes(Number(p.authorId)));

  if (forumHomeSubTab === 'follow') {
    const followeeIds = (await db.forum_follows.where('followerId').equals(forumActiveAccountId).toArray()).map(f => f.followeeId);
    posts = posts.filter(p => followeeIds.includes(p.authorId));
  } else if (forumHomeSubTab === 'nearby') {
    posts = posts.filter((_, idx) => idx % 2 === 0);
  }

  if (posts.length === 0) {
    container.innerHTML = `<p style="text-align:center; color:#64748b; font-size:12px; padding:40px 0;">该频道暂无帖子动态</p>`;
    return;
  }

  // 物理检查当前登录 User 是否真实点赞过这些动态 [1]
  const myLikes = (await db.forum_likes.toArray()).filter(l => Number(l.userId) === Number(forumActiveAccountId) && l.targetType === 'post');

  // 使用内存片段拼装，规避返回时的瞬间闪动 [2]
  const fragment = document.createDocumentFragment();

  for (let p of posts) {
    let authorName = "匿名旅人";
    let authorUsername = "unknown";
    let authorAvatar = "";

    const isSelf = Number(p.authorId) === Number(forumActiveAccountId);
    if (isSelf) {
      const acc = await db.forum_accounts.get(forumActiveAccountId);
      if (acc) {
        authorName = acc.nickname;
        authorUsername = acc.username;
        authorAvatar = acc.avatar || forumGenerateColorfulAvatar(acc.nickname);
      }
    } else {
      const npc = await db.forum_npc_accounts.get(p.authorId);
      if (npc) {
        authorName = npc.nickname;
        authorUsername = `npc_${npc.id}`;
        authorAvatar = npc.avatar || forumGenerateColorfulAvatar(npc.nickname);
      } else {
        // 容灾读取：若非自己也非 NPC，可能为其他分身账户，通过 forum_accounts 兜底渲染 [1]
        const otherAcc = await db.forum_accounts.get(Number(p.authorId));
        if (otherAcc) {
          authorName = otherAcc.nickname;
          authorUsername = otherAcc.username;
          authorAvatar = otherAcc.avatar || forumGenerateColorfulAvatar(otherAcc.nickname);
        }
      }
    }

    const card = document.createElement("div");
    card.className = "forum-post-card";
    
    let mediaHtml = "";
    if (p.media) {
      mediaHtml = `
        <div class="forum-post-media-placeholder" onclick="showToast('画面描述：' + this.innerText)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
          <span>${escapeHtml(p.media)}</span>
        </div>
      `;
    }

    const isLikedByMe = myLikes.some(l => l.targetId === p.id);
    const timeStr = new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    card.innerHTML = `
      <div class="forum-card-header" onclick="forumPushLayer('profile-view', ${p.authorId})">
        <img src="${authorAvatar}" class="avatar-sm" style="object-fit:cover;">
        <div class="forum-author-meta">
          <div class="forum-author-name-row">
            <span class="forum-author-nickname">${escapeHtml(authorName)}</span>
            <svg class="forum-cert-icon" viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          </div>
          <span class="forum-author-username">@${escapeHtml(authorUsername)}</span>
        </div>
      </div>
      <h4 class="forum-post-title">${escapeHtml(p.title)}</h4>
      <div class="forum-post-body">${escapeHtml(p.content)}</div>
      ${mediaHtml}
      <div class="forum-card-footer">
        <span>${timeStr} · ${p.views || 0} 查看</span>
      </div>
      <div class="forum-interactive-bar">
        <div class="forum-action-group">
          <button class="forum-action-btn" onclick="forumPushLayer('post-detail', ${p.id})">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18zM18 14H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
            <span>${p.commentsCount || 0}</span>
          </button>
          <button class="forum-action-btn ${isLikedByMe ? 'active' : ''}" onclick="forumToggleLike(${p.id}, this)">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <span>${p.likesCount || 0}</span>
          </button>
        </div>
        <button class="forum-star-btn" onclick="forumTriggerAIInteractions(${p.id}, this)">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
          <span>生成互动</span>
        </button>
      </div>
    `;
    fragment.appendChild(card);
  }

  // 同步替换，彻底抹除白屏闪动
  container.innerHTML = "";
  container.appendChild(fragment);
}

// 补齐被意外遗漏的点赞控制器并绑定全局作用域，确保 100% 点击上屏与 liked 物理库同步 [1]
async function forumToggleLike(postId, btn) {
  const isLiked = btn.classList.contains("active");
  const post = await db.forum_posts.get(postId);
  if (!post) return;

  if (isLiked) {
    btn.classList.remove("active");
    const newCount = Math.max(0, (post.likesCount || 0) - 1);
    await db.forum_posts.update(postId, { likesCount: newCount });
    btn.querySelector("span").innerText = newCount;

    // 级联删除真实的 liked 点赞历史记录
    const likeRecord = (await db.forum_likes.toArray()).find(l => Number(l.userId) === Number(forumActiveAccountId) && l.targetId === postId && l.targetType === 'post');
    if (likeRecord) {
      await db.forum_likes.delete(likeRecord.id);
    }
  } else {
    btn.classList.add("active");
    const newCount = (post.likesCount || 0) + 1;
    await db.forum_posts.update(postId, { likesCount: newCount });
    btn.querySelector("span").innerText = newCount;

    // 添加真实的 liked 点赞历史记录 [1]
    await db.forum_likes.add({
      userId: Number(forumActiveAccountId),
      targetId: postId,
      targetType: 'post',
      createdAt: Date.now()
    });
  }
}

// 显式挂载到全局作用域
window.forumToggleLike = forumToggleLike;

async function forumInitPostDetailPage(postId) {
  activePostDetailId = postId;
  activeParentCommentId = 0;

  const post = await db.forum_posts.get(postId);
  if (!post) return;

  const detailBox = document.getElementById("forum-post-detail-content");
  const commentsBox = document.getElementById("forum-comments-list");
  const inputEl = document.getElementById("forum-comment-input");
  const submitBtn = document.getElementById("forum-comment-submit-btn");

  if (!detailBox || !commentsBox) return;

  let authorName = "匿名成员";
  let authorAvatar = "";
  let authorUsername = "user";

  const isSelf = Number(post.authorId) === Number(forumActiveAccountId);
  if (isSelf) {
    const acc = await db.forum_accounts.get(forumActiveAccountId);
    if (acc) {
      authorName = acc.nickname;
      authorAvatar = acc.avatar || forumGenerateColorfulAvatar(acc.nickname);
      authorUsername = acc.username;
    }
  } else {
    const npc = await db.forum_npc_accounts.get(post.authorId);
    if (npc) {
      authorName = npc.nickname;
      authorAvatar = npc.avatar || forumGenerateColorfulAvatar(npc.nickname);
      authorUsername = `npc_${npc.id}`;
    }
  }

  let mediaHtml = "";
  if (post.media) {
    mediaHtml = `
      <div class="forum-post-media-placeholder" style="margin-top:10px;">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
        <span>${escapeHtml(post.media)}</span>
      </div>
    `;
  }

  detailBox.innerHTML = `
    <div class="forum-post-card" style="box-shadow:none; border-radius:12px;">
      <div class="forum-card-header">
        <img src="${authorAvatar || 'data:image/svg+xml;utf8,<svg viewBox=\'0 0 24 24\' xmlns=\'http://www.w3.org/2000/svg\'><circle cx=\'12\' cy=\'12\' r=\'12\' fill=\'%23cbd5e1\'/></svg>'}" class="avatar-sm">
        <div class="forum-author-meta">
          <div class="forum-author-name-row">
            <span class="forum-author-nickname">${escapeHtml(authorName)}</span>
          </div>
          <span class="forum-author-username">@${escapeHtml(authorUsername)}</span>
        </div>
      </div>
      <h4 class="forum-post-title" style="font-size:16px;">${escapeHtml(post.title)}</h4>
      <div class="forum-post-body" style="font-size:14.5px;">${escapeHtml(post.content)}</div>
      ${mediaHtml}
      
      <!-- 帖子详情页互动底栏 (对齐主页，加入点赞跟评与AI互动) -->
      <div class="forum-interactive-bar" style="border-bottom:none; margin-bottom:0;">
        <div class="forum-action-group">
          <button class="forum-action-btn" onclick="forumSetCommentReplyTarget(0, '${escapeHtml(authorName)}')">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M21.99 4c0-1.1-.89-2-1.99-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4-.01-18zM18 14H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
            <span id="forum-detail-comments-count">${post.commentsCount || 0}</span>
          </button>
          <button class="forum-action-btn" onclick="forumToggleLike(${post.id}, this)">
            <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <span>${post.likesCount || 0}</span>
          </button>
        </div>
        <button class="forum-star-btn" onclick="forumTriggerAIInteractions(${post.id}, this)">
          <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>
          <span>生成互动</span>
        </button>
      </div>
    </div>
  `;

  await forumLoadCommentsTree();

  if (submitBtn && inputEl) {
    submitBtn.onclick = async () => {
      const text = inputEl.value.trim();
      if (!text) return;

      await db.forum_comments.add({
        postId: postId,
        parentCommentId: activeParentCommentId,
        authorId: forumActiveAccountId,
        content: text,
        createdAt: Date.now(),
        likesCount: 0
      });

      const currentPost = await db.forum_posts.get(postId);
      await db.forum_posts.update(postId, { commentsCount: (currentPost.commentsCount || 0) + 1 });

      inputEl.value = "";
      activeParentCommentId = 0;
      inputEl.placeholder = "发布你的回复...";
      await forumLoadCommentsTree();
    };
  }
}

async function forumLoadCommentsTree() {
  const box = document.getElementById("forum-comments-list");
  if (!box) return;
  box.innerHTML = "";

  const allComments = await db.forum_comments.where('postId').equals(activePostDetailId).toArray();
  allComments.sort((a,b) => a.createdAt - a.createdAt);

  const fragment = document.createDocumentFragment();
  
  async function renderNode(parentId, depth = 0) {
    const layerComments = allComments.filter(c => c.parentCommentId === parentId);
    for (let c of layerComments) {
      let cName = "匿名";
      let cAvatar = "";

      // 基于 Number(c.authorId) === Number(forumActiveAccountId) 隔离用户评论身份，解决评论区 ID 碰撞 [1]
      const isSelf = Number(c.authorId) === Number(forumActiveAccountId);
      if (isSelf) {
        const acc = await db.forum_accounts.get(forumActiveAccountId);
        if (acc) {
          cName = acc.nickname;
          cAvatar = acc.avatar || forumGenerateColorfulAvatar(acc.nickname);
        }
      } else {
        const npc = await db.forum_npc_accounts.get(c.authorId);
        if (npc) {
          cName = npc.nickname;
          cAvatar = npc.avatar || forumGenerateColorfulAvatar(npc.nickname);
        } else {
          // 容灾兜底：支持其他玩家分身评论的无感解析
          const otherAcc = await db.forum_accounts.get(c.authorId);
          if (otherAcc) {
            cName = otherAcc.nickname;
            cAvatar = otherAcc.avatar || forumGenerateColorfulAvatar(otherAcc.nickname);
          }
        }
      }

      const nodeDiv = document.createElement("div");
      nodeDiv.className = "forum-comment-node";
      nodeDiv.style.marginLeft = `${Math.min(4, depth) * 16}px`;

      nodeDiv.innerHTML = `
        <div style="display:flex; gap:10px; align-items:flex-start;">
          <img src="${cAvatar}" style="width:28px; height:28px; border-radius:50%; object-fit:cover;">
          <div style="flex:1; display:flex; flex-direction:column; gap:4px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:12px; font-weight:700; color:#334155;">${escapeHtml(cName)}</span>
              <span style="font-size:10px; color:#94a3b8;">${new Date(c.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
            </div>
            <p style="font-size:12.5px; color:#1e293b; margin:0; line-height:1.4;">${escapeHtml(c.content)}</p>
            <div style="display:flex; gap:16px; margin-top:4px;">
              <button class="forum-action-btn" onclick="forumSetCommentReplyTarget(${c.id}, '${escapeHtml(cName)}')">
                <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 10 1.6 12.5 5.1C21.5 15 17.5 10 10 9z"/></svg>
                <span>回复</span>
              </button>
            </div>
          </div>
        </div>
      `;
      fragment.appendChild(nodeDiv);
      await renderNode(c.id, depth + 1);
    }
  }

  await renderNode(0);
  box.appendChild(fragment);
}

function forumSetCommentReplyTarget(commentId, nickname) {
  activeParentCommentId = commentId;
  const inputEl = document.getElementById("forum-comment-input");
  if (inputEl) {
    inputEl.placeholder = `回复 @${nickname}:`;
    inputEl.focus();
  }
}

// === 11. AI 模拟性格互动评赞 (高度网感活人对线重构) ===
async function forumTriggerAIInteractions(postId, btn) {
  btn.disabled = true;
  const origText = btn.innerText;
  btn.innerText = "提炼中...";

  try {
    const post = await db.forum_posts.get(postId);
    const systemPrompt = await buildForumSystemPrompt(forumActiveAccountId);

    // 实时读取目前已在论坛中引入的全部 NPC 身份及档案馆原始角色底料
    const npcs = await db.forum_npc_accounts.toArray();
    let npcsPersonaText = "";
    for (let n of npcs) {
      let char = null;
      if (n.charId) char = await db.archives.get(n.charId);
      npcsPersonaText += `\n- 角色「${n.nickname}」人设设定及心流背景: ${char ? char.persona : n.postPreference}`;
    }

    const userPrompt = `请针对以下发表的动态内容，生成 10 条极其真实、活人感拉满、带有丰富互联网网络黑话和情绪互动的跟帖。
帖子标题：${post.title}
帖子内容：${post.content}

【角色真实人设底料参考】：
在生成跟帖人时，请务必参考社区内这几位引入角色的真实人设背景。如果生成了以下对应角色的昵称跟帖，必须100%严格遵守其性格底牌，绝对不准OOC（脱离人设）：
${npcsPersonaText}

你需要分饰不同的活人身份在评论区展开精彩接梗、站队、吐槽或相互抬杠。
请以标准 JSON 数组返回，不要包含 Markdown 语法标识符：
[
  { "type": "like" },
  { "type": "comment", "nickname": "角色昵称", "content": "充满性格和流行流行词的犀利评论、接梗或发疯吐槽" },
  { "type": "nested_reply", "parent_nickname": "被回复人昵称", "content": "针对上述评论的互怼、拆台或接龙回复" }
]`;

    const aiRes = await forumCallAI(systemPrompt, userPrompt);
    let list = [];
    try {
      list = JSON.parse(aiRes);
    } catch(err) {
      list = JSON.parse(aiRes.replace(/,\s*([\]}])/g, '$1'));
    }

    const currentUser = await db.forum_accounts.get(forumActiveAccountId);
    const userNick = currentUser ? currentUser.nickname : "";

    let appendedComments = 0;
    let likesGenerated = 0;

    for (let item of list) {
      // 安全主权防御拦截：禁止评论区出现用 User 昵称伪冒的跟评回复 [1]
      if (userNick && item.nickname === userNick) {
        console.log(`[主权防火墙] 拦截到评论混淆，已放弃生成 User 伪冒跟评`);
        continue;
      }

      const npcs = await db.forum_npc_accounts.toArray();
      let matchedNpc = npcs[Math.floor(Math.random() * npcs.length)];
      if (item.nickname) {
        const found = npcs.find(n => n.nickname === item.nickname);
        if (found) matchedNpc = found;
      }

      if (!matchedNpc) continue;

      if (item.type === "like") {
        likesGenerated++;
        // 增加点赞历史通知
        await db.forum_notifications.add({
          userId: post.authorId,
          type: "like",
          targetId: postId,
          fromUserId: matchedNpc.id,
          isRead: 0,
          createdAt: Date.now()
        });
      } else if (item.type === "comment") {
        const comId = await db.forum_comments.add({
          postId: postId,
          parentCommentId: 0,
          authorId: matchedNpc.id,
          content: item.content,
          createdAt: Date.now() + Math.random() * 2000,
          likesCount: 0
        });
        appendedComments++;

        // 增加评论通知
        await db.forum_notifications.add({
          userId: post.authorId,
          type: "comment",
          targetId: postId,
          fromUserId: matchedNpc.id,
          isRead: 0,
          createdAt: Date.now()
        });
      } else if (item.type === "nested_reply") {
        const existing = await db.forum_comments.where('postId').equals(postId).toArray();
        const parentId = existing.length > 0 ? existing[Math.floor(Math.random() * existing.length)].id : 0;
        await db.forum_comments.add({
          postId: postId,
          parentCommentId: parentId,
          authorId: matchedNpc.id,
          content: item.content,
          createdAt: Date.now() + Math.random() * 3000,
          likesCount: 0
        });
        appendedComments++;
      }
    }

    const updatedPost = await db.forum_posts.get(postId);
    await db.forum_posts.update(postId, {
      likesCount: (updatedPost.likesCount || 0) + likesGenerated,
      commentsCount: (updatedPost.commentsCount || 0) + appendedComments
    });

    showToast(`成功唤醒 ${likesGenerated}次喜欢与 ${appendedComments}条新评论反馈`);
    forumRefreshTabFeed();

    if (activePostDetailId === postId) {
      await forumInitPostDetailPage(postId);
    }

  } catch(e) {
    console.error(e);
    showToast("同步互动反馈失败，请检查模型连接");
  } finally {
    btn.disabled = false;
    btn.innerText = origText;
  }
}

// === 12. 发帖表单（增加标题字段输入栏，彻底解决覆写覆盖问题） ===
function forumGetNewPostTemplate() {
  return `
    <header class="win-header">
      <button class="btn-icon" onclick="forumPopLayer()">
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
      <h3>发送动态</h3>
      <button class="btn btn-primary" onclick="forumPublishPost()" style="padding: 6px 14px;">发布</button>
    </header>
    <div class="win-body" style="padding: 16px; overflow-y: auto;">
      <div class="form-group">
        <label>动态标题</label>
        <input type="text" id="forum-new-post-title" placeholder="请输入动态标题" style="width:100%; border:1px solid #e2e8f0; border-radius:8px; padding:10px; box-sizing:border-box;">
      </div>
      <div class="form-group">
        <label>动态内容</label>
        <textarea id="forum-new-post-content" placeholder="分享此刻想法..." rows="5" style="width:100%; border:1px solid #e2e8f0; border-radius:8px; padding:10px; resize:none; box-sizing:border-box;"></textarea>
      </div>
      <div class="form-group">
        <label>附加画面描述 (自适应生成灰色白描图卡)</label>
        <input type="text" id="forum-new-post-media" placeholder="例如：一个站在废弃桥头看落日的侧影">
      </div>
      <div class="form-group">
        <label>提及关注的人 (@角色)</label>
        <div id="forum-new-post-at-list" style="display:flex; flex-direction:column; gap:6px; max-height: 120px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px; padding:8px;"></div>
      </div>
    </div>
  `;
}

async function forumInitNewPostPage() {
  const atList = document.getElementById("forum-new-post-at-list");
  if (!atList) return;
  atList.innerHTML = "";

  const follows = await db.forum_follows.where('followerId').equals(forumActiveAccountId).toArray();
  for (let f of follows) {
    const npc = await db.forum_npc_accounts.get(f.followeeId);
    if (npc) {
      const div = document.createElement("div");
      div.style.cssText = "display:flex; align-items:center; gap:8px;";
      div.innerHTML = `
        <input type="checkbox" class="forum-at-checkbox" value="@${npc.nickname}">
        <span style="font-size:12.5px;">${npc.nickname}</span>
      `;
      atList.appendChild(div);
    }
  }
}

async function forumPublishPost() {
  const titleEl = document.getElementById("forum-new-post-title");
  const contentEl = document.getElementById("forum-new-post-content");
  const mediaEl = document.getElementById("forum-new-post-media");
  if (!contentEl) return;

  const content = contentEl.value.trim();
  const title = titleEl ? titleEl.value.trim() : "";
  const media = mediaEl ? mediaEl.value.trim() : "";

  if (!content) {
    showToast("动态内容不能为空");
    return;
  }

  let finalContent = content;
  const checkboxes = document.querySelectorAll(".forum-at-checkbox:checked");
  checkboxes.forEach(cb => {
    finalContent += ` ${cb.value}`;
  });

  await db.forum_posts.add({
    authorId: forumActiveAccountId,
    title: title || "日常随笔",
    content: finalContent,
    media: media,
    createdAt: Date.now(),
    views: 1,
    likesCount: 0,
    commentsCount: 0,
    forwardsCount: 0
  });

  showToast("发布成功");
  forumPopLayer();
  forumLoadPostsFeed();
}

// === 13. NPC 自动发动态巡航定时任务 (已废弃并彻底禁用后台巡航) ===
function forumStartNpcCruiseTimer() {
  if (forumNpcCruiseTimer) clearInterval(forumNpcCruiseTimer);
  // 定时器彻底静默，规避后台胡乱发帖现象
}

async function forumNpcAutoPublishPost(npc) {
  try {
    const char = npc.charId ? await db.archives.get(npc.charId) : null;
    // 独立轻量系统设定，不再传递玩家 ActiveAccountId 干扰，彻底切断玩家账户信息的污染
    const systemPrompt = `你当前扮演名为“匿名随笔论坛”的环境，你将要以匿名 NPC 账户发帖。`;

    const userPrompt = `【当前发帖的匿名NPC小号账户】：
- 论坛昵称：${npc.nickname}
- 用户名：@npc_${npc.id}
- 官方原始设定（绝对不准脱离人设/绝不准OOC）：${char ? char.persona : "暂无"}

【注意：不要混淆正在浏览论坛网页的当前用户，不要提及、掺杂任何浏览者的信息】
请严格以此角色的官方人设、心理状态和独特口纹为最高本源视角，撰写一条完全符合其目前思想现状的匿名论坛帖子，绝对不准出现任何脱离其角色卡定位的发言。
【输出格式控制】：请直接且仅返回以下格式的 JSON，不要包含 Markdown 标识符：
{ "title": "具有精神张力的爆点标题", "content": "充满该NPC原设独特口吻、克制纠葛且符合设定的正文文本", "mediaDescription": "灰色白描插图描述(20字内)" }`;

    const aiRes = await forumCallAI(systemPrompt, userPrompt);
    const parsed = JSON.parse(aiRes);

    await db.forum_posts.add({
      authorId: npc.id,
      title: parsed.title || "寂静自白",
      content: parsed.content || "终究没能逃脱既定的循环...",
      media: parsed.mediaDescription || "",
      createdAt: Date.now(),
      views: Math.floor(Math.random() * 40) + 5,
      likesCount: 0,
      commentsCount: 0,
      forwardsCount: 0
    });

    console.log(`[刷新触发] NPC 角色小号「${npc.nickname}」根据刷新概率成功发帖。`);
    
    const activeTab = document.querySelector("#win-forum .forum-tabs .tab-item.active")?.getAttribute("data-forum-tab");
    if (activeTab === "home") {
      forumLoadPostsFeed();
    }

  } catch(e) {
    console.error("NPC自动发帖失败:", e);
  }
}

// === 14. 极简无依赖原生触控下拉刷新机制 (真实互联网批量自生成与嵌套讨论树) ===
let forumRefreshStartY = 0;
let forumRefreshCurrentY = 0;
let forumIsRefreshing = false;
let forumIsPulling = false;

function forumInitPullToRefresh() {
  const feed = document.getElementById("forum-posts-list");
  if (!feed) return;

  let indicator = document.getElementById("forum-pull-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "forum-pull-indicator";
    indicator.style.cssText = "text-align: center; height: 0px; overflow: hidden; transition: height 0.2s ease, opacity 0.2s ease; font-size: 11px; color: #64748b; font-weight: 700; background-color: #f1f5f9; display: flex; align-items: center; justify-content: center; width: 100%; box-sizing: border-box; flex-shrink: 0; opacity: 0;";
    indicator.innerHTML = `
      <svg class="forum-refresh-spinner" viewBox="0 0 24 24" width="16" height="16" style="margin-right: 6px; animation: forum-spin 1s linear infinite;"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.58 20 12c0-4.42-3.58-8-8-8zm-6 8c0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.42 4 12c0 4.42 3.58 8 8 8v-3l4 4-4-4v3c-3.31 0-6-2.69-6-6z"/></svg>
      <span id="forum-pull-indicator-text">下拉可以刷新</span>
    `;
    feed.parentNode.insertBefore(indicator, feed);

    if (!document.getElementById("forum-refresh-spin-style")) {
      const style = document.createElement("style");
      style.id = "forum-refresh-spin-style";
      style.textContent = `
        @keyframes forum-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  // 挂载 Touch 触控阻力下拉手势
  feed.ontouchstart = (e) => {
    if (feed.scrollTop === 0 && !forumIsRefreshing) {
      forumRefreshStartY = e.touches[0].clientY;
      forumRefreshCurrentY = forumRefreshStartY; // 强行重置，对齐极小位移以杜绝点击误触
      forumIsPulling = true;
      indicator.style.transition = "none";
    }
  };

  feed.ontouchmove = (e) => {
    if (!forumIsPulling || forumIsRefreshing) return;
    forumRefreshCurrentY = e.touches[0].clientY;
    const diff = forumRefreshCurrentY - forumRefreshStartY;

    if (diff > 0) {
      const height = Math.min(60, diff * 0.45); // 引入阻力系数
      indicator.style.height = height + "px";
      indicator.style.opacity = (height / 60);
      
      const textEl = document.getElementById("forum-pull-indicator-text");
      if (height >= 45) {
        if (textEl) textEl.innerText = "释放立即刷新";
      } else {
        if (textEl) textEl.innerText = "下拉可以刷新";
      }
    }
  };

  feed.ontouchend = async () => {
    if (!forumIsPulling || forumIsRefreshing) return;
    forumIsPulling = false;
    
    const diff = forumRefreshCurrentY - forumRefreshStartY;
    const textEl = document.getElementById("forum-pull-indicator-text");
    const spinner = indicator.querySelector(".forum-refresh-spinner");

    if (diff * 0.45 >= 45) {
      forumIsRefreshing = true;
      indicator.style.transition = "height 0.2s ease, opacity 0.2s ease";
      indicator.style.height = "40px";
      if (textEl) textEl.innerText = "正在推演时空动态...";
      if (spinner) spinner.style.display = "block";

      try {
        const systemPrompt = await buildForumSystemPrompt(forumActiveAccountId);
        
        // 1. 只轮询归属于当前登录账户的 NPC 分身，达成高拟真发帖过滤 (通过 toArray 内存过滤绕过 Dexie 索引校验，根治 SchemaError)
        const activeNpcs = (await db.forum_npc_accounts.toArray()).filter(n => Number(n.userId) === Number(forumActiveAccountId));
        for (let n of activeNpcs) {
          const prob = Number(n.postProbability || 0);
          if (prob > 0 && Math.random() * 100 < prob) {
            await forumNpcAutoPublishPost(n);
          }
        }

        // 2. 批量产生 5-7 篇真实外部网络吃瓜动态
        const userPrompt = `
请在目前的社交社区中，批量产生 5 到 7 篇极度真实、有血有肉、有生活烟火气和强网感的社区动态帖子。
这些动态的发帖者可以来自于档案中已存的核心角色（由你代入其设定的口吻），也可以是【全新随机自动虚构的各色活跃网民分身】（请为其指派符合网络文化的昵称与无@英文账号，如社畜打工人、发疯少女、乐子键盘侠、吃瓜闲人等）。
帖子类型要丰富：包含避坑排雷、发疯吐槽、宿命讨论、日常分享等。

为了制造极具链式活人感的社交反应网络，请为这 5 到 7 篇帖子中的【每一篇动态】，自发附加 4 到 6 条其他虚构用户相互吃瓜、抬杠对线、玩梗评论的互动跟帖和嵌套评论链。

请必须且只能返回如下格式的标准 JSON 数组，严禁带有 Markdown \`\`\`json 块修饰：
[
  {
    "authorType": "background_npc", 
    "nickname": "虚构NPC昵称",
    "username": "user_abc",
    "title": "符合网络爆点、有张力的标题",
    "content": "口语化、热梗齐飞、网感充沛、带有很多真实网络语气和常见表情(如😭,😅,💀,🥹,👀)的正文内容",
    "media": "虚线配图描述(如果有)",
    "comments": [
      {
        "nickname": "回帖人A",
        "content": "极其生动、甚至有点阴阳怪气或疯狂玩梗的回帖"
      },
      {
        "nickname": "回帖人B",
        "content": "跟帖吐槽、吃瓜或看戏对线"
      }
    ]
  }
]`;

        const aiRes = await forumCallAI(systemPrompt, userPrompt);
        let batchList = [];
        try {
          batchList = JSON.parse(aiRes);
        } catch(err) {
          batchList = JSON.parse(aiRes.replace(/,\s*([\]}])/g, '$1'));
        }

        const currentUser = await db.forum_accounts.get(forumActiveAccountId);
        const userNick = currentUser ? currentUser.nickname : "";

        // 依次将这些讨论链落库
        for (let postData of batchList) {
          // 安全主权防御拦截：如果发帖人的昵称和当前 User 昵称完全一致，说明大模型产生幻觉混淆，物理拦截不落库 [1]
          if (userNick && postData.nickname === userNick) {
            console.log(`[主权防火墙] 拦截到大模型幻觉：放弃生成 User 伪冒贴：「${postData.title}」`);
            continue;
          }

          let npc = await db.forum_npc_accounts.where('nickname').equals(postData.nickname).first();
          if (!npc) {
            const colorfulAvatarUrl = forumGenerateColorfulAvatar(postData.nickname);
            const newId = await db.forum_npc_accounts.add({
              charId: 0, // 世界背景NPC
              nickname: postData.nickname,
              avatar: colorfulAvatarUrl,
              postProbability: 0, // 外部背景网民不参与内部概率设定
              postPreference: "网络围观路人"
            });
            npc = await db.forum_npc_accounts.get(newId);
          }

          const newPostId = await db.forum_posts.add({
            authorId: npc.id,
            title: postData.title || "吐槽日记",
            content: postData.content || "今天又被世界创到了...",
            media: postData.media || "",
            createdAt: Date.now() - Math.random() * 60000,
            views: Math.floor(Math.random() * 200) + 15,
            likesCount: Math.floor(Math.random() * 30),
            commentsCount: postData.comments ? postData.comments.length : 0,
            forwardsCount: 0
          });

          // 自动级联入库讨论树
          if (postData.comments && Array.isArray(postData.comments)) {
            for (let c of postData.comments) {
              let cNpc = await db.forum_npc_accounts.where('nickname').equals(c.nickname).first();
              if (!cNpc) {
                const colorfulAvatarUrl = forumGenerateColorfulAvatar(c.nickname);
                const cid = await db.forum_npc_accounts.add({
                  charId: 0,
                  nickname: c.nickname,
                  avatar: colorfulAvatarUrl,
                  postProbability: 0,
                  postPreference: "跟帖对线客"
                });
                cNpc = await db.forum_npc_accounts.get(cid);
              }

              await db.forum_comments.add({
                postId: newPostId,
                parentCommentId: 0,
                authorId: cNpc.id,
                content: c.content,
                createdAt: Date.now() - Math.random() * 40000,
                likesCount: 0
              });
            }
          }
        }

        // 重新加载 Feed 动态视图
        await forumLoadPostsFeed();

      } catch (err) {
        console.error("批量网络动态更新推演失败:", err);
      }

      setTimeout(() => {
        indicator.style.height = "0px";
        indicator.style.opacity = "0";
        forumIsRefreshing = false;
        showToast("动态已全部更新");
      }, 800);
    } else {
      indicator.style.transition = "height 0.2s ease, opacity 0.2s ease";
      indicator.style.height = "0px";
      indicator.style.opacity = "0";
    }
  };
}