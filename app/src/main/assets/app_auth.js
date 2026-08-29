/**
 * app_auth.js - Supabase 账号管理、无感持久化与 2 台设备 Limit-2 FIFO 挤占中枢
 */

// 1. 初始化 Supabase 客户端（关键字段整体加密，文件内不出现明文；
//    运行时由 app_crypto.js 解密；如需更换请用 scripts/urlban-tool.js 或
//    开发者工作台 tools/dev-workbench/index.html 生成新密文替换下方常量）
const SUPABASE_URL = window.xvshishiCrypto ? window.xvshishiCrypto.decrypt("XU1:AZZftICREnl9S4fPuE7awZ3u87ZVtHLMKmG4QJG6GKNIsBjOwYJ5SDj1dy0c") : "";
const SUPABASE_ANON_KEY = window.xvshishiCrypto ? window.xvshishiCrypto.decrypt("XU1:AbeNHLoyp6bsZ5ieZsBFn8Yecp5tzxaoBdsszIgjLlA+pLWuPFlFSf6OKJ5u+p5p0vPt") : "";
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("[auth] 账密字段解密失败：app_crypto.js 未加载或口令不匹配，请检查脚本顺序与密钥配置");
}
const supabaseClient = libSupabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 获取或在当前浏览器本地持久化生成唯一的设备客户端 Token
let myClientToken = localStorage.getItem("story_phone_client_token");
if (!myClientToken) {
  myClientToken = 'device_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
  localStorage.setItem("story_phone_client_token", myClientToken);
}

let activeRealtimeChannel = null;

// 初始化检测：高优先凭证放行（一旦登录过绝不二次弹窗）
async function initAuthCheck() {
  const isLocallyLoggedIn = localStorage.getItem("auth_logged_in") === "true";

  // 1. 优先读取本地登录标记：0毫秒秒开显示主界面，绝不弹出登录遮罩！
  if (isLocallyLoggedIn) {
    hideLoginScreen();
    // 主界面已显示，触发每日自动备份提醒卡片（若已开启）
    if (typeof window.maybeShowDailyBackupPrompt === "function") {
      window.maybeShowDailyBackupPrompt();
    }
  }

  try {
    const { data: { session }, error } = await supabaseClient.auth.getSession();

    if (error || !session) {
      // 只有在确定未登录且不处于离线使用时，才展示登录页
      if (!isLocallyLoggedIn) {
        showLoginScreen();
      }
      return;
    }

    // 确定处于登录状态，刷新本地标记与后台会话
    localStorage.setItem("auth_logged_in", "true");
    hideLoginScreen();

    // 首次登录态确认后也触发一次每日备份提醒（覆盖从登录页登入的场景）
    if (!isLocallyLoggedIn && typeof window.maybeShowDailyBackupPrompt === "function") {
      window.maybeShowDailyBackupPrompt();
    }

    // 后台静默校验设备队列
    verifyDeviceSession(session.user.id);

  } catch(e) {
    console.warn("登录态后台无感静默校验中...", e);
  }
}

// 设备排队与踢出逻辑 (精确 FIFO 队列：设备3登录 -> 踢出最老设备1)
async function verifyDeviceSession(userId) {
  if (!navigator.onLine) {
    return;
  }

  try {
    // 1. 按自增 ID 从小到大（从老到新）拉取该用户的所有在线设备
    const { data: sessions, error } = await supabaseClient
      .from('user_devices')
      .select('id, device_token')
      .eq('user_id', userId)
      .order('id', { ascending: true });

    if (error) throw error;

    // 2. 检测当前设备 token 是否已在库中
    const currentSession = sessions.find(s => s.device_token === myClientToken);

    if (!currentSession) {
      // 插入新设备登记
      const { data: newSess, error: insErr } = await supabaseClient
        .from('user_devices')
        .insert({ user_id: userId, device_token: myClientToken })
        .select()
        .single();

      if (insErr) throw insErr;
      sessions.push(newSess); // 追加到数组最末尾（最新设备）
    }

    // 3. 核心限制队列：如果总设备数 > 2，强剔最早登录的老设备
    if (sessions.length > 2) {
      const oldestSessions = sessions.slice(0, sessions.length - 2); // 截出最老的那批设备
      const idsToDelete = oldestSessions.map(s => s.id);

      await supabaseClient
        .from('user_devices')
        .delete()
        .in('id', idsToDelete);
    }

    // 4. 二次核查：如果自己的设备 ID 正好属于被强剔的最老设备，触发下线
    const { data: finalCheck, error: chkErr } = await supabaseClient
      .from('user_devices')
      .select('id')
      .eq('device_token', myClientToken);

    if (!chkErr && Array.isArray(finalCheck) && finalCheck.length === 0) {
      handleKickOut();
      return;
    }

    // 5. 开启实时监听：一旦属于自己的 user_devices 被后续第3台设备挤掉删除，立刻下线
    subscribeToKickOut(userId);

  } catch (e) {
    console.warn("设备鉴权后台同步中（不影响本地正常使用）:", e);
  }
}

// 订阅数据库删除事件，实现毫秒级“强踢”效果
function subscribeToKickOut(userId) {
  if (activeRealtimeChannel) {
    supabaseClient.removeChannel(activeRealtimeChannel);
  }

  activeRealtimeChannel = supabaseClient
    .channel('public:user_devices')
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'user_devices',
        filter: `user_id=eq.${userId}`
      },
      (payload) => {
        // 被删除的记录属于本设备 Token 时，执行被挤下线
        if (payload.old && payload.old.device_token === myClientToken) {
          handleKickOut();
        }
      }
    )
    .subscribe();
}

// 被强踢下线的行为处理
async function handleKickOut() {
  if (activeRealtimeChannel) {
    supabaseClient.removeChannel(activeRealtimeChannel);
    activeRealtimeChannel = null;
  }
  
  localStorage.removeItem("auth_logged_in");
  localStorage.removeItem("cached_user_password");
  try {
    await supabaseClient.auth.signOut();
  } catch(e) {}

  showCustomAlert("⚠️ 账号异地登录下线通知", "由于您的账号在其他更多的设备上登录（超2台上限），本设备已自动下线。如需使用请重新登录。");
  showLoginScreen();
}

// 登录 UI 遮罩层控制
function showLoginScreen() {
  const overlay = document.getElementById("auth-login-overlay");
  const phone = document.getElementById("phone-container");
  if (overlay) overlay.style.display = "flex";
  if (phone) phone.style.display = "none";
}

function hideLoginScreen() {
  const overlay = document.getElementById("auth-login-overlay");
  const phone = document.getElementById("phone-container");
  if (overlay) overlay.style.display = "none";
  if (phone) phone.style.display = "block";
}

// 用户手动登录动作
async function handleUserLogin(email, password) {
  const btn = document.getElementById("btn-auth-submit");
  btn.disabled = true;
  btn.innerText = "验证中...";

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (error) throw error;

    // 记录永久登录与密码缓存（密码缓存加密后落盘，读取处见 app_settings.js）
    localStorage.setItem("auth_logged_in", "true");
    localStorage.setItem("cached_user_password",
      (window.xvshishiCrypto && window.xvshishiCrypto.encrypt(password)) || password);

    showToast("登录成功！已成功解锁并建立安全神经连接");
    hideLoginScreen();
    // 登录成功后触发每日备份提醒
    if (typeof window.maybeShowDailyBackupPrompt === "function") {
      window.maybeShowDailyBackupPrompt();
    }
    await verifyDeviceSession(data.user.id);

  } catch (e) {
    showCustomAlert("登录失败", e.message || "账号或密码错误");
  } finally {
    btn.disabled = false;
    btn.innerText = "立即登入";
  }
}

// 用户注册动作 (强制校验激活码)
async function handleUserSignUp(email, password, activationCode) {
  if (!activationCode) {
    showCustomAlert("注册被拦截", "注册必须输入系统激活码！");
    return;
  }

  const btn = document.getElementById("btn-auth-submit");
  btn.disabled = true;
  btn.innerText = "注册中...";

  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          invite_code: activationCode
        }
      }
    });

    if (error) throw error;
    showCustomAlert("注册成功", "账号已创建，请直接使用邮箱密码登录。");

  } catch (e) {
    showCustomAlert("注册失败", e.message || "激活码无效、已被使用，或账号密码不合规");
  } finally {
    btn.disabled = false;
    btn.innerText = "立即登入";
  }
}

// 主动心跳轮询检测 (增加容灾断言，只有在确定请求成功且已被库中删除时才触发踢人)
setInterval(async () => {
  if (!navigator.onLine) return;
  if (localStorage.getItem("auth_logged_in") !== "true") return;

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  const { data, error } = await supabaseClient
    .from('user_devices')
    .select('id')
    .eq('device_token', myClientToken);

  // 核心容灾：只有在 error 为 null (确定联网成功) 且 data 为空数组时，才认定为被第 3 台设备踢出
  if (!error && Array.isArray(data) && data.length === 0) {
    handleKickOut();
  }
}, 15000);

// 自注册初始化
document.addEventListener("DOMContentLoaded", () => {
  initAuthCheck();
});