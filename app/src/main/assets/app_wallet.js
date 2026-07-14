/**
 * app_wallet.js - 叙事诗小手机 微信账务与交易卡片引擎
 */

(function() {
  // ============================================================
  //  1. 微信经典账单与转账/红包 CSS 主动注入（杜绝污染外部样式）
  // ============================================================
  const walletStyle = document.createElement("style");
  walletStyle.textContent = `
    /* 微信钱包卡片排版 */
    .wallet-card-container {
      background: #fcfcfc;
      padding: 24px 20px;
      text-align: center;
      border-bottom: 8px solid #f1f1f1;
    }
    .wallet-card-title {
      font-size: 14px;
      color: #7f7f7f;
      margin-bottom: 8px;
    }
    .wallet-card-balance {
      font-size: 36px;
      font-weight: 700;
      color: #1a1a1a;
      font-family: -apple-system, SF Pro Display, sans-serif;
      margin-bottom: 24px;
    }
    .wallet-action-row {
      display: flex;
      gap: 12px;
      justify-content: center;
    }
    .btn-wallet {
      flex: 1;
      max-width: 140px;
      padding: 10px 0;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      border: none;
      transition: opacity 0.15s;
    }
    .btn-wallet.recharge {
      background-color: #07c160;
      color: #ffffff;
    }
    .btn-wallet.withdraw {
      background-color: #f2f2f2;
      color: #07c160;
      border: 1px solid #e6e6e6;
    }
    .btn-wallet:active {
      opacity: 0.82;
    }

    /* 资金变动明细账本 */
    .ledger-title-bar {
      background: #f7f7f7;
      padding: 10px 16px;
      font-size: 13px;
      color: #7f7f7f;
      font-weight: 600;
      border-bottom: 1px solid #eaeaea;
    }
    .ledger-list {
      display: flex;
      flex-direction: column;
    }
    .ledger-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid #f1f1f1;
      background: #ffffff;
    }
    .ledger-info-col {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ledger-type-text {
      font-size: 14px;
      color: #1a1a1a;
      font-weight: 600;
    }
    .ledger-time-text {
      font-size: 11px;
      color: #b2b2b2;
    }
    .ledger-amount-col {
      font-size: 16px;
      font-weight: 700;
      font-family: -apple-system, sans-serif;
    }
    .ledger-amount-col.income {
      color: #07c160;
    }
    .ledger-amount-col.expense {
      color: #1a1a1a;
    }

    /* 微信对话转账、红包对话气泡样式 */
    .wallet-bubble-card {
      width: 230px;
      border-radius: 8px;
      overflow: hidden;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      user-select: none;
      transition: filter 0.15s;
    }
    .wallet-bubble-card:active {
      filter: brightness(0.92);
    }
    
    /* 微信红包样式 (橙红) */
    .wallet-bubble-card.red-envelope {
      background-color: #fa523c;
    }
    .wallet-bubble-card.red-envelope.opened {
      background-color: #fca799;
      pointer-events: none; /* 核心修复：领完后彻底禁用事件截获 */
      opacity: 0.65;        /* 降级灰度透明 */
    }
    
    /* 微信转账样式 (橙黄) */
    .wallet-bubble-card.transfer {
      background-color: #f89e3a;
    }
    .wallet-bubble-card.transfer.received {
      background-color: #fcd59c;
      pointer-events: none; /* 核心修复：领钱后彻底禁用事件截获，防重复刷钱 */
      opacity: 0.65;        /* 降级灰度透明 */
    }

    .wallet-bubble-body {
      padding: 12px 14px 14px 14px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .wallet-bubble-icon {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: rgba(255,255,255,0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ffffff;
      flex-shrink: 0;
    }
    .wallet-bubble-details {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: hidden;
    }
    .wallet-bubble-title {
      font-size: 14px;
      color: #ffffff;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .wallet-bubble-desc {
      font-size: 11px;
      color: rgba(255,255,255,0.75);
    }
    .wallet-bubble-amount {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
      font-family: -apple-system, sans-serif;
    }
    .wallet-bubble-footer {
      background: rgba(0,0,0,0.03);
      padding: 6px 14px;
      font-size: 9.5px;
      color: rgba(255,255,255,0.65);
      border-top: 1px solid rgba(255,255,255,0.06);
    }
  `;
  document.head.appendChild(walletStyle);

  // ============================================================
  //  2. 钱包与账本数据库核心算法 (LocalStorage 引擎)
  // ============================================================
  const DEFAULT_BALANCE = 88888.00;

  function getBalanceKey() {
    const personaId = localStorage.getItem("active_me_id") || "default";
    return `wallet_balance_v1_${personaId}`;
  }

  function getLedgerKey() {
    const personaId = localStorage.getItem("active_me_id") || "default";
    return `wallet_ledger_v1_${personaId}`;
  }

  function getBalance() {
    const key = getBalanceKey();
    const val = localStorage.getItem(key);
    if (val === null) {
      localStorage.setItem(key, DEFAULT_BALANCE.toFixed(2));
      return DEFAULT_BALANCE;
    }
    return parseFloat(val);
  }

  function setBalance(num) {
    const key = getBalanceKey();
    localStorage.setItem(key, num.toFixed(2));
  }

  function getLedger() {
    const key = getLedgerKey();
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : [];
  }

  function addLedgerEntry(typeText, amount, direction) {
    const ledger = getLedger();
    const entry = {
      id: Date.now() + Math.random().toString(36).substr(2, 4),
      typeText,
      amount: parseFloat(amount),
      direction, // 'income' | 'expense'
      timestamp: Date.now()
    };
    ledger.unshift(entry);
    const key = getLedgerKey();
    localStorage.setItem(key, JSON.stringify(ledger));
    return entry;
  }

  // ============================================================
  //  3. 微信钱包页面动态渲染器
  // ============================================================
  function renderWalletPage(bodyContainer) {
    if (!bodyContainer) return;
    
    const balance = getBalance();
    const ledgerList = getLedger();

    let ledgerHtml = "";
    if (ledgerList.length === 0) {
      ledgerHtml = `<div style="text-align:center;padding:40px 0;color:#b2b2b2;font-size:12px;">暂无资金往来明细</div>`;
    } else {
      ledgerList.forEach(item => {
        const sign = item.direction === 'income' ? '+' : '-';
        const classSign = item.direction === 'income' ? 'income' : 'expense';
        const dateStr = new Date(item.timestamp).toLocaleString();
        ledgerHtml += `
          <div class="ledger-item">
            <div class="ledger-info-col">
              <span class="ledger-type-text">${escapeHtml(item.typeText)}</span>
              <span class="ledger-time-text">${dateStr}</span>
            </div>
            <div class="ledger-amount-col ${classSign}">
              ${sign}${item.amount.toFixed(2)}
            </div>
          </div>
        `;
      });
    }

    bodyContainer.innerHTML = `
      <div class="wallet-card-container">
        <div class="wallet-card-title">零钱余额</div>
        <div class="wallet-card-balance">￥ ${balance.toFixed(2)}</div>
        <div class="wallet-action-row">
          <button class="btn-wallet recharge" onclick="walletSystem.recharge()">充值</button>
          <button class="btn-wallet withdraw" onclick="walletSystem.withdraw()">提现</button>
        </div>
      </div>
      <div class="ledger-title-bar">零钱明细</div>
      <div class="ledger-list">
        ${ledgerHtml}
      </div>
    `;
  }

  // ============================================================
  //  4. 钱包账户操作（充值与提现）
  // ============================================================
  function handleRecharge() {
    showCustomPrompt("请输入要充值的金额（元）", "100.00", (input) => {
      if (input === null || input.trim() === "") return;
      const amount = parseFloat(input);
      if (isNaN(amount) || amount <= 0) {
        showToast("请输入合法的充值金额！");
        return;
      }
      const current = getBalance();
      setBalance(current + amount);
      addLedgerEntry("零钱充值", amount, "income");
      
      const subBody = document.getElementById("me-sub-body");
      const subTitle = document.getElementById("me-sub-title");
      if (subBody && subTitle && subTitle.innerText === "微信钱包") {
        renderWalletPage(subBody);
      }
      showToast(`成功充值：￥ ${amount.toFixed(2)} 元！`);
    });
  }

  function handleWithdraw() {
    showCustomPrompt("请输入要提现的金额（元）", "100.00", (input) => {
      if (input === null || input.trim() === "") return;
      const amount = parseFloat(input);
      if (isNaN(amount) || amount <= 0) {
        showToast("请输入合法的提现金额！");
        return;
      }
      const current = getBalance();
      if (amount > current) {
        showToast("余额不足，无法提现！");
        return;
      }
      setBalance(current - amount);
      addLedgerEntry("零钱提现", amount, "expense");

      const subBody = document.getElementById("me-sub-body");
      const subTitle = document.getElementById("me-sub-title");
      if (subBody && subTitle && subTitle.innerText === "微信钱包") {
        renderWalletPage(subBody);
      }
      showToast(`成功提现：￥ ${amount.toFixed(2)} 元！`);
    });
  }

  // ============================================================
  //  5. 微信自定义微信红包与转账弹窗控制 (取代原生 Prompt)
  // ============================================================
  function closeTxModal() {
    const overlay = document.getElementById("wallet-tx-overlay");
    if (overlay) overlay.classList.remove("active");
    
    // 清空数据以便下次再次录入
    const amountInput = document.getElementById("wallet-tx-amount");
    const remarkInput = document.getElementById("wallet-tx-remark");
    if (amountInput) amountInput.value = "";
    if (remarkInput) remarkInput.value = "";
  }

  async function openTransferModal() {
    if (typeof activeSessionId === 'undefined' || !activeSessionId) {
      alert("请先进入一个好友对话。");
      return;
    }
    const overlay = document.getElementById("wallet-tx-overlay");
    const title = document.getElementById("wallet-tx-title");
    const remarkLabel = document.getElementById("wallet-tx-remark-label");
    const remarkInput = document.getElementById("wallet-tx-remark");
    const submitBtn = document.getElementById("btn-wallet-tx-submit");
    
    if (!overlay) return;

    // 定制为转账专属文本
    title.textContent = "微信转账";
    remarkLabel.textContent = "转账备注";
    remarkInput.placeholder = "转账备注（选填）";

    // 绑定发送事件
    submitBtn.onclick = async () => {
      const amountVal = parseFloat(document.getElementById("wallet-tx-amount").value);
      const remarkVal = remarkInput.value.trim() || "微信转账";

      if (isNaN(amountVal) || amountVal <= 0) {
        showToast("请输入合法的转账金额！");
        return;
      }
      const current = getBalance();
      if (amountVal > current) {
        showToast("转账失败：您的零钱余额不足！");
        return;
      }

      // 扣减并记账
      setBalance(current - amountVal);
      addLedgerEntry("转账（出账）", amountVal, "expense");

      // 组装并写入消息
      const session = await db.sessions.get(Number(activeSessionId));
      const charName = session?.customCharName || "对方";
      const walletData = {
        amount: amountVal,
        status: "pending",
        targetName: charName,
        remark: remarkVal
      };

      const msg = {
        sessionId: Number(activeSessionId),
        senderType: 'user',
        senderId: Number(activeUserPersonaId),
        content: JSON.stringify(walletData),
        contentType: 'transfer',
        timestamp: Date.now()
      };
      msg.id = await db.messages.add(msg);
      if (window.appendMessageToDOM) {
        await window.appendMessageToDOM(msg);
      }
      
      document.getElementById("chat-expand-panel").classList.remove("active");
      closeTxModal();
    };

    overlay.classList.add("active");
  }

  async function openRedEnvelopeModal() {
    if (typeof activeSessionId === 'undefined' || !activeSessionId) {
      alert("请先进入一个好友对话。");
      return;
    }
    const overlay = document.getElementById("wallet-tx-overlay");
    const title = document.getElementById("wallet-tx-title");
    const remarkLabel = document.getElementById("wallet-tx-remark-label");
    const remarkInput = document.getElementById("wallet-tx-remark");
    const submitBtn = document.getElementById("btn-wallet-tx-submit");
    
    if (!overlay) return;

    // 定制为红包专属文本
    title.textContent = "发送红包";
    remarkLabel.textContent = "红包祝福语";
    remarkInput.placeholder = "恭喜发财，大吉大利";

    submitBtn.onclick = async () => {
      const amountVal = parseFloat(document.getElementById("wallet-tx-amount").value);
      const remarkVal = remarkInput.value.trim() || "恭喜发财，大吉大利";

      if (isNaN(amountVal) || amountVal <= 0) {
        showToast("请输入合法的红包金额！");
        return;
      }
      const current = getBalance();
      if (amountVal > current) {
        showToast("红包发送失败：您的零钱余额不足！");
        return;
      }

      setBalance(current - amountVal);
      addLedgerEntry("发送红包", amountVal, "expense");

      const walletData = {
        amount: amountVal,
        status: "pending",
        remark: remarkVal
      };

      const msg = {
        sessionId: Number(activeSessionId),
        senderType: 'user',
        senderId: Number(activeUserPersonaId),
        content: JSON.stringify(walletData),
        contentType: 'red_envelope',
        timestamp: Date.now()
      };
      msg.id = await db.messages.add(msg);
      if (window.appendMessageToDOM) {
        await window.appendMessageToDOM(msg);
      }

      document.getElementById("chat-expand-panel").classList.remove("active");
      closeTxModal();
    };

    overlay.classList.add("active");
  }

  // ============================================================
  //  6. 点击卡片触发资金收取/打开红包（双向拦截与纠偏记账）
  // ============================================================
  async function claimTransfer(msgId) {
    const msg = await db.messages.get(Number(msgId));
    if (!msg) return;
    try {
      const data = JSON.parse(msg.content);
      if (msg.senderType === 'user') {
        if (data.status === 'pending') {
          showToast(`正在等待对方确认收钱...`);
        } else {
          showToast(`对方已确认收下您的转账：￥ ${data.amount.toFixed(2)} 元。`);
        }
        return;
      }

      if (data.status === 'received') {
        showToast("这笔转账您已经收钱，无需重复收取。");
        return;
      }

      // 确认收钱并存盘
      data.status = 'received';
      await db.messages.update(Number(msgId), { content: JSON.stringify(data) });

      // 核心修复：领取对方转账时，账单 Ledger 中必须抓取对方（Char）的名字，而不能错误展现为自己的姓名
      const session = await db.sessions.get(Number(activeSessionId));
      const charName = session ? (session.customCharName || "好友") : "好友";

      const current = getBalance();
      setBalance(current + data.amount);
      addLedgerEntry(`收取[${charName}]转账`, data.amount, "income");

      if (window.renderDialogMessages) {
        await window.renderDialogMessages();
      }
      showToast(`已成功确认收钱：￥ ${data.amount.toFixed(2)} 元！`);
    } catch(e) {
      console.error("确认转账异常:", e);
    }
  }

  async function claimRedEnvelope(msgId) {
    const msg = await db.messages.get(Number(msgId));
    if (!msg) return;
    try {
      const data = JSON.parse(msg.content);
      if (msg.senderType === 'user') {
        if (data.status === 'pending') {
          showToast(`您发给对方的红包正在等待对方拆开中...`);
        } else {
          showToast(`对方已领取了您的红包：￥ ${data.amount.toFixed(2)} 元。`);
        }
        return;
      }

      // 领取 Char 发给 User 的红包
      if (data.status === 'opened') {
        showToast("这个红包您已经拆过了。");
        return;
      }

      data.status = 'opened';
      await db.messages.update(Number(msgId), { content: JSON.stringify(data) });

      // 核心修复：领取对方红包时，账单 Ledger 中必须抓取对方（Char）的名字
      const session = await db.sessions.get(Number(activeSessionId));
      const charName = session ? (session.customCharName || "好友") : "好友";

      const current = getBalance();
      setBalance(current + data.amount);
      addLedgerEntry(`打开[${charName}]的红包`, data.amount, "income");

      if (window.renderDialogMessages) {
        await window.renderDialogMessages();
      }
      showToast(`红包拆开成功！共领取金额 ￥ ${data.amount.toFixed(2)} 元！`);
    } catch(e) {
      console.error("领取红包异常:", e);
    }
  }

  // ============================================================
  //  7. HTML 安全转义工具
  // ============================================================
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
  }

  // ============================================================
  //  8. 挂载全局微信账务系统命名空间
  // ============================================================
  window.walletSystem = {
    getLedger,
    getBalance,
    addLedgerEntry,
    renderWalletPage,
    recharge: handleRecharge,
    withdraw: handleWithdraw,
    createTransfer: openTransferModal,      // 自定义微信小卡片驱动
    createRedEnvelope: openRedEnvelopeModal, // 自定义微信小卡片驱动
    closeTxModal,
    claimTransfer,
    claimRedEnvelope
  };

  // 绑定对话底部扩展面板新增按钮
  document.addEventListener("DOMContentLoaded", () => {
    const btnTransfer = document.getElementById("btn-chat-transfer");
    if (btnTransfer) btnTransfer.onclick = () => walletSystem.createTransfer();

    const btnRedEnvelope = document.getElementById("btn-chat-redenvelope");
    if (btnRedEnvelope) btnRedEnvelope.onclick = () => walletSystem.createRedEnvelope();

    // 预留未启用通话与专注按钮防崩溃绑定
    const btnCall = document.getElementById("btn-chat-call");
    if (btnCall) {
      btnCall.onclick = () => showToast("正在连接加密卫星频段语音通话...");
    }
    const btnFocus = document.getElementById("btn-chat-focus");
    if (btnFocus) {
      btnFocus.onclick = () => showToast("正在开启专注陪伴白噪音空间...");
    }
  });
})();