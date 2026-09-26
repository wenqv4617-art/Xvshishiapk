package com.story.phone

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * 原生 iLink 长轮询（收消息）。
 *
 * 为什么要有这个文件
 * ------------------
 * 原先收消息的循环跑在 WebView 的 JS 里（setTimeout 链）。两个问题：
 *
 * 1) Blink 用「View 是否 attach 到窗口」判断页面可见性。后台中枢 WebView 即使挂了
 *    1×1 悬浮窗，一旦窗口被系统回收/隐藏，5 分钟后 intensive throttling 生效，
 *    定时器最小间隔被强制放大到 60 秒 —— 长轮询周期断崖式拉长，服务端判定掉线。
 * 2) WebView 进程可能被回收、Activity 可能被销毁，JS 循环随之中断。
 *
 * 现在把「收」这条线整个搬到原生线程：只要进程活着（前台服务保活），长轮询就不断，
 * 与网页是否被节流、是否还存在无关。收到的消息先落在原生队列里，网页有空时再拉走。
 * 这样就实现了外部专家建议的「原生当离线消息中心，网页只当消费端」。
 *
 * 设计要点
 * --------
 * · 严格串行：任何时刻只有一条 getupdates 在飞，且客户端超时（60s）远大于服务端
 *   hold（约 35s）；超时后强制冷却 6 秒再重发，绝不制造「服务端同时持有两条」。 
 * · 游标由原生独占持有并持久化（前端只在首次启动时把旧游标交进来）。
 * · 消息队列带自增 id 与 ack：网页拉取 → 处理 → ack；没 ack 的消息会再次被拉到
 *   （至少一次投递）。网页侧另有按 msgId 的原子认领，两者叠加即不会重复处理。
 * · 换账号（token 变了）时清空游标与队列，避免跨账号复用服务端游标。
 */
object IlinkPoller {

    private const val TAG = "IlinkPoller"
    private const val PREF = "ilink_native_poller"

    private const val KEY_TOKEN = "token"
    private const val KEY_BASEURL = "baseurl"
    private const val KEY_CURSOR = "cursor"
    private const val KEY_QUEUE = "queue"
    private const val KEY_ACK = "ack"
    private const val KEY_WANTED = "wanted"

    private const val FIXED_HOST = "https://ilinkai.weixin.qq.com"
    private const val CHANNEL_VERSION = "2.4.6"
    private const val BOT_AGENT = "story-phone/1.0 (cordis)"

    /** 必须显著大于服务端 hold（约 35s），否则客户端超时重发会与服务端未结束的请求重叠 */
    private const val LONGPOLL_TIMEOUT_MS = 60000
    private const val CONNECT_TIMEOUT_MS = 15000

    /** 客户端超时后的冷却：给服务端收尾时间，杜绝两条并发长轮询 */
    private const val TIMEOUT_COOLDOWN_MS = 6000L

    private const val BACKOFF_SHORT_MS = 2000L
    private const val BACKOFF_LONG_MS = 30000L
    private const val BACKOFF_FAIL_THRESHOLD = 3

    /** 队列上限：超出丢最旧的（正常情况网页会很快拉走） */
    private const val MAX_QUEUE = 200

    private const val IDLE_GAP_MS = 300L

    /** 普通业务请求（回消息 / 取 typing ticket）的超时；长轮询另有 60s 的超时 */
    private const val NORMAL_TIMEOUT_MS = 15000

    /** 长轮询期间持有的短时唤醒锁：网络 IO 期间 CPU 必须醒着，否则 Doze 下会半途断流 */
    private const val POLL_WAKELOCK_MS = 90_000L

    /** 网页「消费端」多久没来拉过队列就算它已经不工作了（被冻结/被回收） */
    const val WEB_CONSUMER_STALE_MS = 45_000L

    @Volatile private var running = false
    @Volatile private var wantRun = false
    private var worker: Thread? = null

    @Volatile var lastError: String = ""
        private set
    @Volatile var lastPollAt: Long = 0L
        private set
    @Volatile var lastStaleHint: String = ""
        private set

    private val lock = Any()
    private var queue = ArrayList<String>()   // 每项：{"id":n,"payload":{...}} 的 JSON 字符串
    private var ackId = 0L
    private var seq = 0L
    private var loaded = false

    /**
     * 网页消费端的活跃度。
     *
     * 用途：判断「该由谁来回消息」。
     *   · 网页活着（前台页或后台中枢的 JS 每 4 秒来拉一次）→ 由网页生成回复（有角色卡、
     *     世界书、RAG 记忆，质量高）；
     *   · 网页已经 [WEB_CONSUMER_STALE_MS] 没来拉过 → 认定它被冻结/被回收，改由原生兜底
     *     生成并发送（质量略低，但「至少能回」）。
     *
     * 这两个时间戳都由 JS 侧的 fetchPending() 刷新，进程重启后归零即视为「网页不在」。
     */
    @Volatile private var lastWebPullAt: Long = 0L
    @Volatile private var lastWebBusyAt: Long = 0L   // 网页正在生成回复（busy 心跳）
    @Volatile private var lastInboundAt: Long = 0L   // 最近一次收到用户消息的时间

    /** 长轮询期间的短时唤醒锁，避免 Doze 下 CPU 休眠导致长连接半途断掉 */
    private var pollWakeLock: android.os.PowerManager.WakeLock? = null

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    private fun ensureLoaded(sp: SharedPreferences) {
        if (loaded) return
        loaded = true
        try {
            ackId = sp.getLong(KEY_ACK, 0L)
            val arr = JSONArray(sp.getString(KEY_QUEUE, "[]") ?: "[]")
            for (i in 0 until arr.length()) {
                val s = arr.optString(i, "")
                if (s.isEmpty()) continue
                queue.add(s)
                val id = JSONObject(s).optLong("id", 0L)
                if (id > seq) seq = id
            }
        } catch (e: Exception) {
            Log.w(TAG, "恢复队列失败: ${e.message}")
        }
    }

    private fun persistQueueLocked(sp: SharedPreferences) {
        try {
            val arr = JSONArray()
            for (s in queue) arr.put(s)
            sp.edit().putString(KEY_QUEUE, arr.toString()).putLong(KEY_ACK, ackId).apply()
        } catch (e: Exception) {
            Log.w(TAG, "保存队列失败: ${e.message}")
        }
    }

    // =========================================================================
    // 对外接口（由 AndroidMcp 转发给 JS）
    // =========================================================================

    /**
     * 启动（或确认已在运行的）原生长轮询。
     * token 变化视为换账号：清空游标与队列。
     */
    fun start(ctx: Context, token: String, baseUrl: String, cursor: String): String {
        try {
            val sp = prefs(ctx)
            val oldToken = sp.getString(KEY_TOKEN, "") ?: ""
            synchronized(lock) {
                ensureLoaded(sp)
                if (oldToken != token) {
                    queue.clear()
                    ackId = 0L
                    seq = 0L
                    sp.edit().putString(KEY_CURSOR, "").putLong(KEY_ACK, 0L)
                        .putString(KEY_QUEUE, "[]").apply()
                }
            }
            sp.edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_BASEURL, baseUrl)
                .putBoolean(KEY_WANTED, true)
                .apply()
            // 原生没有游标时才采用前端交进来的（之后游标由原生独占推进）
            if ((sp.getString(KEY_CURSOR, "") ?: "").isEmpty() && cursor.isNotEmpty()) {
                sp.edit().putString(KEY_CURSOR, cursor).apply()
            }
            wantRun = true
            ensureWorker()
            // ★ 用户开启了接收 → 武装保活看门狗：进程万一被 ROM 清掉，靠闹钟链复活。
            //   这一步是「离开 App 后还能收到/回微信」的前提，必须在这里同步打开。
            try { KeepAliveGuard.arm(ctx.applicationContext, "ilinkStart") } catch (e: Exception) { }
            return status(ctx)
        } catch (e: Exception) {
            return JSONObject().apply {
                put("ok", false)
                put("error", e.message ?: e.toString())
            }.toString()
        }
    }

    fun stop(ctx: Context) {
        wantRun = false
        try {
            prefs(ctx).edit().putBoolean(KEY_WANTED, false).apply()
        } catch (e: Exception) { }
        // ★ 用户主动停止接收 → 解除看门狗，否则闹钟会一直把服务拉回来，用户以为关不掉
        try { KeepAliveGuard.disarm(ctx.applicationContext, "ilinkStop") } catch (e: Exception) { }
        notifyJs("stopped")
    }

    /** 进程/服务重启后，如果用户此前开着接收，就自动恢复轮询 */
    fun resumeIfWanted(ctx: Context) {
        try {
            val sp = prefs(ctx)
            if (!sp.getBoolean(KEY_WANTED, false)) return
            if ((sp.getString(KEY_TOKEN, "") ?: "").isEmpty()) return
            wantRun = true
            ensureWorker()
            Log.d(TAG, "按上次状态恢复原生长轮询")
        } catch (e: Exception) {
            Log.w(TAG, "恢复轮询失败: ${e.message}")
        }
    }

    /**
     * 用户是否开着「接收微信消息」。
     * 这是保活看门狗与前台服务的唯一开关依据：只要为 true，进程就该被反复救活。
     */
    fun isWanted(ctx: Context): Boolean {
        return try {
            val sp = prefs(ctx)
            sp.getBoolean(KEY_WANTED, false) &&
                (sp.getString(KEY_TOKEN, "") ?: "").isNotEmpty()
        } catch (e: Exception) {
            false
        }
    }

    /**
     * 取所有尚未 ack 的消息，返回 JSON 数组字符串。
     *
     * ⚠ 这个方法会刷新「网页消费端心跳」—— 它只应该由 JS 侧调用。
     *   原生自己读队列请用 [pendingSnapshot]，否则原生一读就变成「网页还活着」。
     */
    fun fetchPending(ctx: Context): String {
        // 网页来拉队列 = 它的 JS 还活着。这个时间戳是「谁负责回消息」的判据。
        lastWebPullAt = System.currentTimeMillis()
        return pendingSnapshot(ctx)
    }

    /**
     * 只读地取一份未 ack 的消息快照，**不触碰**网页心跳。
     * 供原生兜底回信（NativeReplyFallback）读取待处理消息。
     */
    fun pendingSnapshot(ctx: Context): String {
        try {
            val sp = prefs(ctx)
            synchronized(lock) {
                ensureLoaded(sp)
                val arr = JSONArray()
                for (s in queue) {
                    val o = JSONObject(s)
                    if (o.optLong("id", 0L) > ackId) arr.put(o)
                }
                return arr.toString()
            }
        } catch (e: Exception) {
            return "[]"
        }
    }

    /**
     * 网页上报「我正在处理这条消息 / 正在生成回复」。
     * 兜底逻辑据此避让：网页已经在干了就绝不插手，免得同一条消息回两遍。
     */
    fun webBusy() {
        lastWebBusyAt = System.currentTimeMillis()
    }

    /**
     * 网页消费端当前是否活着（每 4 秒拉一次队列）。
     * 45 秒没有任何动静 = 判定它已被 Blink 冻结或被系统回收。
     */
    fun isWebConsumerAlive(): Boolean {
        val t = lastWebPullAt
        if (t <= 0L) return false
        return System.currentTimeMillis() - t < WEB_CONSUMER_STALE_MS
    }

    /** 网页是否正在生成回复（含正在打字上报） */
    private fun isWebBusy(): Boolean {
        val t = maxOf(lastWebBusyAt, lastWebPullAt)
        if (t <= 0L) return false
        return System.currentTimeMillis() - t < WEB_CONSUMER_STALE_MS
    }

    private fun markInbound() {
        lastInboundAt = System.currentTimeMillis()
    }

    fun lastInboundAt(): Long = lastInboundAt

    /** 确认已处理到 id（含）为止 */
    fun ack(ctx: Context, id: Long) {
        try {
            val sp = prefs(ctx)
            synchronized(lock) {
                ensureLoaded(sp)
                if (id > ackId) ackId = id
                val keep = ArrayList<String>()
                for (s in queue) {
                    if (JSONObject(s).optLong("id", 0L) > ackId) keep.add(s)
                }
                queue = keep
                persistQueueLocked(sp)
            }
        } catch (e: Exception) {
            Log.w(TAG, "ack 失败: ${e.message}")
        }
    }

    fun status(ctx: Context?): String {
        var pending = -1
        var hasCursor = false
        if (ctx != null) {
            val sp = prefs(ctx)
            synchronized(lock) {
                ensureLoaded(sp)
                pending = queue.count { JSONObject(it).optLong("id", 0L) > ackId }
                hasCursor = (sp.getString(KEY_CURSOR, "") ?: "").isNotEmpty()
            }
        }
        return JSONObject().apply {
            put("ok", true)
            put("running", running)
            put("wantRun", wantRun)
            put("lastPollAt", lastPollAt)
            put("lastError", lastError)
            put("stale", lastStaleHint)
            put("pending", pending)
            put("hasCursor", hasCursor)
        }.toString()
    }

    // =========================================================================
    // 工作线程
    // =========================================================================

    @Synchronized
    private fun ensureWorker() {
        if (running) return
        running = true
        lastStaleHint = ""
        val t = Thread { loop() }
        t.name = "ilink-native-poller"
        t.isDaemon = true
        worker = t
        t.start()
    }

    private class PollResult(
        val ok: Boolean,
        val timedOut: Boolean,
        val stale: Boolean,
        val error: String,
        val cursor: String,
        val messages: List<String>
    )

    private fun loop() {
        Log.d(TAG, "原生轮询线程启动")
        var fails = 0
        try {
            while (wantRun) {
                val ctx = AndroidMcp.appContext ?: break
                val sp = prefs(ctx)
                val token = sp.getString(KEY_TOKEN, "") ?: ""
                if (token.isEmpty()) {
                    sleepQuiet(3000)
                    continue
                }
                var base = sp.getString(KEY_BASEURL, "") ?: ""
                if (base.isEmpty()) base = FIXED_HOST
                val cursor = sp.getString(KEY_CURSOR, "") ?: ""

                // 长轮询要跨几十秒，Doze 下 CPU 可能休眠导致连接半途断掉 —— 短时唤醒锁覆盖这一轮
                acquirePollWakeLock(ctx)
                val r = poll(base, token, cursor)
                lastPollAt = System.currentTimeMillis()

                if (r.timedOut) {
                    // 客户端超时：绝不立刻重发，否则与服务端尚未结束的 hold 重叠
                    lastError = ""
                    sleepQuiet(TIMEOUT_COOLDOWN_MS)
                    continue
                }
                if (r.stale) {
                    lastStaleHint = r.error
                    lastError = r.error
                    wantRun = false
                    sp.edit().putBoolean(KEY_WANTED, false).apply()
                    notifyJs("stale")
                    break
                }
                if (!r.ok) {
                    fails++
                    lastError = r.error
                    val wait = if (fails >= BACKOFF_FAIL_THRESHOLD) {
                        fails = 0
                        BACKOFF_LONG_MS
                    } else {
                        BACKOFF_SHORT_MS
                    }
                    notifyJs("error")
                    sleepQuiet(wait)
                    continue
                }

                fails = 0
                lastError = ""
                if (r.cursor.isNotEmpty()) {
                    sp.edit().putString(KEY_CURSOR, r.cursor).apply()
                }
                if (r.messages.isNotEmpty()) {
                    enqueue(ctx, r.messages)
                    markInbound()
                    notifyJs("message")
                    // ★ 兜底回信：网页消费端如果已经不在了（被冻结/被回收），
                    //   原生长轮询这边直接把回复生成+发送接过来，不再干等网页。
                    //   网页活着时它会在 4 秒内拉走消息并自行回复，这里什么都不做。
                    try { NativeReplyFallback.onInbound(ctx, r.messages.size) } catch (e: Exception) {
                        Log.w(TAG, "兜底回信启动失败: ${e.message}")
                    }
                }
                sleepQuiet(IDLE_GAP_MS)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "轮询线程异常退出: ${t.message}")
        } finally {
            running = false
            // 线程收尾时务必放掉唤醒锁，否则会一直占着 CPU 不让系统休眠（费电）
            try {
                if (pollWakeLock?.isHeld == true) pollWakeLock?.release()
            } catch (e: Exception) { }
            Log.d(TAG, "原生轮询线程结束")
        }
    }

    private fun sleepQuiet(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            wantRun = false
        }
    }

    private fun enqueue(ctx: Context, msgs: List<String>) {
        val sp = prefs(ctx)
        synchronized(lock) {
            ensureLoaded(sp)
            for (m in msgs) {
                seq += 1
                val item = JSONObject().apply {
                    put("id", seq)
                    put("payload", JSONObject(m))
                }
                queue.add(item.toString())
            }
            while (queue.size > MAX_QUEUE) queue.removeAt(0)
            persistQueueLocked(sp)
        }
    }

    private fun readAll(s: InputStream?): String {
        if (s == null) return ""
        return try {
            BufferedReader(InputStreamReader(s, Charsets.UTF_8)).use { it.readText() }
        } catch (e: Exception) {
            ""
        }
    }

    /** 与 app_ilink_client.js 的 makeUin() 等价：随机 31 位整数 → 8 字节小端 → base64 */
    private fun makeUin(): String {
        val v = java.util.Random().nextInt(Int.MAX_VALUE)
        val bytes = ByteArray(8)
        var x = v.toLong()
        for (i in 0 until 8) {
            bytes[i] = (x and 0xFFL).toByte()
            x = x shr 8
        }
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun poll(base: String, token: String, cursor: String): PollResult {
        var conn: HttpURLConnection? = null
        try {
            val url = URL(base.trimEnd('/') + "/ilink/bot/getupdates")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = LONGPOLL_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("AuthorizationType", "ilink_bot_token")
                setRequestProperty("X-WECHAT-UIN", makeUin())
                setRequestProperty("iLink-App-Id", "bot")
                setRequestProperty("iLink-App-ClientVersion", "132102")
                setRequestProperty("Authorization", "Bearer $token")
            }

            val body = JSONObject().apply {
                put("base_info", JSONObject().apply {
                    put("channel_version", CHANNEL_VERSION)
                    put("bot_agent", BOT_AGENT)
                })
                put("get_updates_buf", cursor)
            }.toString()
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }

            val status = conn.responseCode
            if (status < 200 || status >= 300) {
                val err = readAll(conn.errorStream).take(200)
                return PollResult(false, false, false, "收消息失败：HTTP $status $err", "", emptyList())
            }

            val text = readAll(conn.inputStream)
            val j = JSONObject(text)

            val ret = if (j.has("ret")) j.optInt("ret", 0) else 0
            val ec = if (j.has("errcode")) j.optInt("errcode", 0) else 0
            if (ret != 0 || ec != 0) {
                val stale = (ret == -14 || ec == -14)
                val errmsg = j.optString("errmsg", "")
                val err = if (stale) {
                    "登录态已失效，请重新扫码登录"
                } else if (errmsg.isNotEmpty()) {
                    "收消息失败：$errmsg"
                } else {
                    "收消息失败：ret=$ret errcode=$ec"
                }
                return PollResult(false, false, stale, err, "", emptyList())
            }

            val newCursor = j.optString("get_updates_buf", "")
            val out = ArrayList<String>()
            val msgs = j.optJSONArray("msgs")
            if (msgs != null) {
                for (i in 0 until msgs.length()) {
                    val m = msgs.optJSONObject(i) ?: continue
                    // 只处理用户发来的文本（1 = USER）
                    if (m.optInt("message_type", -1) != 1) continue
                    val sb = StringBuilder()
                    val items = m.optJSONArray("item_list")
                    if (items != null) {
                        for (k in 0 until items.length()) {
                            val it = items.optJSONObject(k) ?: continue
                            if (it.optInt("type", -1) != 1) continue
                            val ti = it.optJSONObject("text_item") ?: continue
                            val t = ti.optString("text", "")
                            if (t.isEmpty()) continue
                            if (sb.isNotEmpty()) sb.append("\n")
                            sb.append(t)
                        }
                    }
                    if (sb.isEmpty()) continue
                    out.add(JSONObject().apply {
                        put("fromUserId", m.optString("from_user_id", ""))
                        put("text", sb.toString())
                        put("contextToken", m.optString("context_token", ""))
                        put("msgId", if (m.has("message_id")) m.optString("message_id", "") else "")
                    }.toString())
                }
            }
            return PollResult(true, false, false, "", newCursor, out)
        } catch (e: java.net.SocketTimeoutException) {
            // 含读超时（服务端 hold 未在 60s 内结束）；按「超时」处理，走冷却而非报错
            return PollResult(false, true, false, "", "", emptyList())
        } catch (e: Exception) {
            return PollResult(false, false, false, "收消息失败：" + (e.message ?: e.toString()), "", emptyList())
        } finally {
            try {
                conn?.disconnect()
            } catch (e: Exception) { }
        }
    }

    private fun notifyJs(what: String) {
        try {
            AndroidMcp.notifyWebViewPending(what)
        } catch (e: Exception) {
            Log.w(TAG, "通知网页失败: ${e.message}")
        }
    }

    // =========================================================================
    // 原生发送（不依赖 WebView）
    //
    // 为什么原生也要能发：WebView 一旦被冻结/回收，网页里的 sendToWechat 就永远跑不到，
    // 表现就是「微信只进不出」。原生兜底回信必须有自己的一条发送通道。
    // 协议与 app_ilink_client.js 的 sendMessage 完全一致（字段名/头/成功判定）。
    // =========================================================================

    /** 发送结果：ok / stale(token 失效，需重新扫码) / error */
    class SendResult(val ok: Boolean, val stale: Boolean, val error: String)

    private fun tokenOf(ctx: Context): String =
        try { prefs(ctx).getString(KEY_TOKEN, "") ?: "" } catch (e: Exception) { "" }

    private fun baseOf(ctx: Context): String {
        val b = try { prefs(ctx).getString(KEY_BASEURL, "") ?: "" } catch (e: Exception) { "" }
        return if (b.isEmpty()) FIXED_HOST else b
    }

    /** 当前 iLink 接入地址（供原生兜底回信复用） */
    fun baseUrl(ctx: Context): String = baseOf(ctx)

    /** 当前 bot token（供原生兜底回信复用） */
    fun botToken(ctx: Context): String = tokenOf(ctx)

    /** 与 poll() 相同的头集合，用于所有已登录业务接口 */
    private fun authHeaders(conn: HttpURLConnection, token: String) {
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("AuthorizationType", "ilink_bot_token")
        conn.setRequestProperty("X-WECHAT-UIN", makeUin())
        conn.setRequestProperty("iLink-App-Id", "bot")
        conn.setRequestProperty("iLink-App-ClientVersion", "132102")
        conn.setRequestProperty("Authorization", "Bearer $token")
    }

    private fun baseInfo(): JSONObject = JSONObject().apply {
        put("channel_version", CHANNEL_VERSION)
        put("bot_agent", BOT_AGENT)
    }

    /**
     * 原生发送一条文本。
     * 必须校验业务返回码 —— HTTP 200 不代表投递成功（与网页侧同一套判定）。
     */
    fun sendText(ctx: Context, userId: String, text: String, contextToken: String): SendResult {
        if (userId.isEmpty()) return SendResult(false, false, "缺少接收方")
        if (text.isEmpty()) return SendResult(false, false, "内容为空")
        val token = tokenOf(ctx)
        if (token.isEmpty()) return SendResult(false, false, "未登录")
        if (contextToken.isEmpty()) return SendResult(false, false, "缺少 context_token，无法回消息")

        var conn: HttpURLConnection? = null
        try {
            val url = URL(baseOf(ctx).trimEnd('/') + "/ilink/bot/sendmessage")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = NORMAL_TIMEOUT_MS
                doOutput = true
            }
            authHeaders(conn, token)
            val payload = JSONObject().apply {
                put("msg", JSONObject().apply {
                    put("from_user_id", "")
                    put("to_user_id", userId)
                    put("client_id", "story-phone-native-" + java.util.UUID.randomUUID().toString().replace("-", "").take(16))
                    put("message_type", 2)
                    put("message_state", 2)
                    put("context_token", contextToken)
                    put("item_list", JSONArray().put(JSONObject().apply {
                        put("type", 1)
                        put("text_item", JSONObject().apply { put("text", text) })
                    }))
                })
                put("base_info", baseInfo())
            }
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }

            val status = conn.responseCode
            val bodyText = if (status in 200..299) readAll(conn.inputStream) else readAll(conn.errorStream)
            if (status !in 200..299) {
                return SendResult(false, false, "发送失败：HTTP $status " + bodyText.take(160))
            }
            val j = try { JSONObject(bodyText) } catch (e: Exception) { JSONObject() }
            val ret = if (j.has("ret")) j.optInt("ret", 0) else 0
            val ec = if (j.has("errcode")) j.optInt("errcode", 0) else 0
            if (ret != 0 || ec != 0) {
                val stale = (ret == -14 || ec == -14)
                val errmsg = j.optString("errmsg", "")
                val err = if (stale) "登录态已失效，请重新扫码登录"
                else if (errmsg.isNotEmpty()) "发送失败：$errmsg"
                else "发送失败：ret=$ret errcode=$ec"
                return SendResult(false, stale, err)
            }
            return SendResult(true, false, "")
        } catch (e: Exception) {
            return SendResult(false, false, "发送失败：" + (e.message ?: e.toString()))
        } finally {
            try { conn?.disconnect() } catch (e: Exception) { }
        }
    }

    /** 取 typing_ticket（仅用于「正在输入」，失败不影响正文） */
    fun getConfig(ctx: Context, userId: String, contextToken: String): String {
        val token = tokenOf(ctx)
        if (token.isEmpty()) return ""
        var conn: HttpURLConnection? = null
        try {
            val url = URL(baseOf(ctx).trimEnd('/') + "/ilink/bot/getconfig")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = NORMAL_TIMEOUT_MS
                doOutput = true
            }
            authHeaders(conn, token)
            val payload = JSONObject().apply {
                put("ilink_user_id", userId)
                put("context_token", contextToken)
                put("base_info", baseInfo())
            }
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            if (conn.responseCode !in 200..299) return ""
            val j = JSONObject(readAll(conn.inputStream))
            val ret = if (j.has("ret")) j.optInt("ret", 0) else 0
            val ec = if (j.has("errcode")) j.optInt("errcode", 0) else 0
            if (ret != 0 || ec != 0) return ""
            return j.optString("typing_ticket", "")
        } catch (e: Exception) {
            return ""
        } finally {
            try { conn?.disconnect() } catch (e: Exception) { }
        }
    }

    /** 发送「正在输入」状态；status: 1=开始 2=结束 */
    fun sendTyping(ctx: Context, userId: String, ticket: String, status: Int): Boolean {
        if (ticket.isEmpty()) return false
        val token = tokenOf(ctx)
        if (token.isEmpty()) return false
        var conn: HttpURLConnection? = null
        try {
            val url = URL(baseOf(ctx).trimEnd('/') + "/ilink/bot/sendtyping")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = NORMAL_TIMEOUT_MS
                doOutput = true
            }
            authHeaders(conn, token)
            val payload = JSONObject().apply {
                put("ilink_user_id", userId)
                put("typing_ticket", ticket)
                put("status", status)
                put("base_info", baseInfo())
            }
            conn.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            return conn.responseCode in 200..299
        } catch (e: Exception) {
            return false
        } finally {
            try { conn?.disconnect() } catch (e: Exception) { }
        }
    }

    // =========================================================================
    // 长轮询期间的短时唤醒锁
    // =========================================================================

    private fun acquirePollWakeLock(ctx: Context) {
        try {
            if (pollWakeLock?.isHeld == true) {
                // 续期：释放后重新拿，等价于「再保 90 秒」
                try { pollWakeLock?.release() } catch (e: Exception) { }
            }
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            pollWakeLock = pm.newWakeLock(
                android.os.PowerManager.PARTIAL_WAKE_LOCK,
                "StoryPhone::IlinkLongPoll"
            ).apply {
                setReferenceCounted(false)
                acquire(POLL_WAKELOCK_MS)
            }
        } catch (e: Exception) {
            Log.w(TAG, "获取轮询唤醒锁失败: ${e.message}")
        }
    }

    /** 供诊断面板展示：长轮询唤醒锁现在是否持有 */
    fun isPollWakeLockHeld(): Boolean = try { pollWakeLock?.isHeld == true } catch (e: Exception) { false }
}
