/**
 * app_auth.js - Supabase 账号管理、多设备登录限制（限2台）与踢人逻辑中枢
 */

// 1. 初始化 Supabase 客户端 (这里把 supabase 改为了 supabaseClient，防止重名)
const SUPABASE_URL = "https://itqigfuhxaqglnergizc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_el5tQonGZp4ymQunND3Cqw_WSs5h8Bg";
const supabaseClient = libSupabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 获取或在当前浏览器本地持久化生成唯一的设备客户端 Token
let myClientToken = localStorage.getItem("story_phone_client_token");
if (!myClientToken) {
  myClientToken = 'device_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
  localStorage.setItem("story_phone_client_token", myClientToken);
}

let activeRealtimeChannel = null;

// 初始化检测：验证登录态及设备合法性
async function initAuthCheck() {
  const { data: { session }, error } = await supabaseClient.auth.getSession();

  if (error || !session) {
    showLoginScreen();
    return;
  }

  // 已登录，执行设备数量校验及实时通道监听
  await verifyDeviceSession(session.user.id);
}

// 设备排队与踢出逻辑 (FIFO 队列)
async function verifyDeviceSession(userId) {
  if (!navigator.onLine) {
    // 离线状态下放行本地缓存登录，不执行在线排队
    hideLoginScreen();
    return;
  }

  try {
    // 1. 获取当前用户在所有设备上的活跃会话，按时间从新到老排序
    const { data: sessions, error } = await supabaseClient
      .from('user_devices')
      .select('id, device_token')
      .eq('user_id', userId)
      .order('last_seen', { ascending: false });

    if (error) throw error;

    // 2. 检测当前设备是否已注册在此列表中
    const currentSession = sessions.find(s => s.device_token === myClientToken);

    if (!currentSession) {
      // 当前设备不在列表中，说明是新设备登录，将其插入到数据库中
      const { data: newSess, error: insErr } = await supabaseClient
        .from('user_devices')
        .insert({ user_id: userId, device_token: myClientToken })
        .select()
        .single();

      if (insErr) throw insErr;
      
      // 将新会话插到数组最前面
      sessions.unshift(newSess);
    }

    // 3. 核心限制队列：如果活跃设备数大于 2 台，踢出最老的设备
    if (sessions.length > 2) {
      const oldestSessions = sessions.slice(2); // 截取索引 2 往后的所有老会话
      const idsToDelete = oldestSessions.map(s => s.id);

      await supabaseClient
        .from('user_devices')
        .delete()
        .in('id', idsToDelete);
    }

    // 4. 双重防漏：再次检测自己是否被踢
    const { data: finalCheck } = await supabaseClient
      .from('user_devices')
      .select('id')
      .eq('device_token', myClientToken);

    if (!finalCheck || finalCheck.length === 0) {
      handleKickOut();
      return;
    }

    // 5. 开启实时监听：一旦属于自己的 user_devices 被其他设备抢占并删除，立刻在桌面上踢出
    subscribeToKickOut(userId);
    
    hideLoginScreen();

  } catch (e) {
    console.error("设备鉴权同步失败:", e);
    showToast("身份同步失败，请重新登录");
    showLoginScreen();
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
        // 如果被删除的会话 device_token 是我自己，执行强踢
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
  
  localStorage.removeItem("cached_user_password");
  await supabaseClient.auth.signOut();
  showCustomAlert("⚠️ 强制下线通知", "由于您的账号在其他更多的设备/浏览器上登录，本设备已被强制踢下线。");
  showLoginScreen();
}

// 登录 UI 遮罩层控制
function showLoginScreen() {
  document.getElementById("auth-login-overlay").style.display = "flex";
}

function hideLoginScreen() {
  document.getElementById("auth-login-overlay").style.display = "none";
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

    // 临时本地缓存，方便在设置中查看密码
    localStorage.setItem("cached_user_password", password);

    showToast("登录成功！正在建立安全神经连接...");
    await verifyDeviceSession(data.user.id);

  } catch (e) {
    showCustomAlert("登录失败", e.message || "账号或密码错误");
  } finally {
    btn.disabled = false;
    btn.innerText = "立即登入";
  }
}

// 用户注册动作 (强制校验激活码) - 修正版
async function handleUserSignUp(email, password, activationCode) {
  if (!activationCode) {
    showCustomAlert("注册被拦截", "注册必须输入一次性系统激活码！");
    return;
  }

  const btn = document.getElementById("btn-auth-submit");
  btn.disabled = true;
  btn.innerText = "注册中...";

  try {
    // 核心修正：激活码必须套在 options.data 里面传过去！
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

// 每 15 秒执行一次主动心跳检测，防止由于网络波动导致 Realtime 断开漏踢
setInterval(async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;

  const { data, error } = await supabaseClient
    .from('user_devices')
    .select('id')
    .eq('device_token', myClientToken);

  if (error || !data || data.length === 0) {
    handleKickOut();
  }
}, 15000);

// 自注册初始化
document.addEventListener("DOMContentLoaded", () => {
  initAuthCheck();
});