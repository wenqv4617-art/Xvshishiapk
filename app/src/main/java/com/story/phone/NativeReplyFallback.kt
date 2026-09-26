package com.story.phone

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 原生兜底回信（NativeReplyFallback）—— 「网页被冻结/被回收时，谁来替它回消息」。
 *
 * 背景（真机现象）
 * --------------
 * 收消息早就搬到原生长轮询了，但**生成回复**那一步还在 WebView 里
 * （app_wechat_bridge.handleIncoming → generateReplyForSession → sendToWechat）。
 * 只要 WebView 被 Blink 冻结、渲染进程被回收，或者整个进程被国产 ROM 清掉再被
 * 看门狗拉起来（此时活动 WebView 可能还没重建好），这条链就断在「只进不出」上：
 * 微信里能发进来，却永远等不到回信。
 *
 * 本类的职责就是堵住这个缺口：
 *   1. 原生长轮询收到消息后，先看网页消费端还在不在（IlinkPoller.isWebConsumerAlive）；
 *   2. 网页在 → 什么都不做（网页那边的回复质量更高，不抢）；
 *   3. 网页不在 → 等 [GRACE_MS] 再确认一次（给 WebView 一个被唤醒的机会），
 *      仍然不在就由原生接管：拿 OfflineBrain 里那份「网页拼好的成品上下文」+ 新消息
 *      调同一个大模型，用 IlinkPoller 的原生发送通道发回去。
 *
 * 防重复：原生决定接手的那一刻，先调用 AndroidMcp.claimIncomingMessage 把这条消息
 * 认领掉。网页后来醒过来时，claimIncomingMessage 会返回 false，它就自动跳过了 ——
 * 于是「同一条微信消息被回两遍」不会发生。
 *
 * 失败重试：LLM 接口偶发 5xx 是常态，这里最多重试 [MAX_ATTEMPTS] 次；
 * 全部失败就记一笔错误留给诊断面板，不做无限重试（免得把接口限流打死）。
 */
object NativeReplyFallback {

    private const val TAG = "NativeReplyFallback"
    private const val PREF = "native_reply_fallback"

    private const val KEY_HOURLY = "hourly_sent"      // 本小时已由原生发出的条数（JSON: {ts:[...]})
    private const val KEY_LAST_ERROR = "last_error"
    private const val KEY_SENT_TOTAL = "sent_total"
    private const val KEY_LAST_SENT_AT = "last_sent_at"

    /**
     * 原生兜底「补录队列」文件名。
     *
     * 原生发出回复的那一刻，WebView 通常是死的（不然也轮不到兜底），所以没法当场把这两条
     * 消息注入聊天库。这里先在原生侧落一份记录，等网页下次活过来时主动来取、落库、再确认删除。
     * 不这样做的话，用户回到 App 会看不到「我不在的时候它们聊了什么」。
     */
    private const val LOG_FILE = "ilink_native_reply_log.json"
    private const val LOG_MAX = 100

    /** 确认网页确实不在之前，先等这么久（网页每 4 秒拉一次队列，6 秒足够它表态） */
    private const val GRACE_MS = 6000L

    private const val MAX_ATTEMPTS = 2
    private const val RETRY_DELAY_MS = 3000L

    /** 原生兜底的每小时上限，防止接口被打爆 */
    private const val HOURLY_LIMIT = 20

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ilink-native-reply").apply { isDaemon = true }
    }

    /** 同一时刻只允许一个兜底任务在跑，避免两条消息并发生成 */
    private val busy = AtomicBoolean(false)

    @Volatile var lastError: String = ""
        private set

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    fun sentTotal(ctx: Context): Long = prefs(ctx).getLong(KEY_SENT_TOTAL, 0L)
    fun lastSentAt(ctx: Context): Long = prefs(ctx).getLong(KEY_LAST_SENT_AT, 0L)
    fun reportError(ctx: Context): String = prefs(ctx).getString(KEY_LAST_ERROR, "") ?: ""

    /** 本小时还能发几条（诊断面板用） */
    fun hourlyRemaining(ctx: Context): Int {
        val now = System.currentTimeMillis()
        val recent = loadHourly(ctx).filter { now - it < 3600_000L }
        return (HOURLY_LIMIT - recent.size).coerceAtLeast(0)
    }

    private fun loadHourly(ctx: Context): List<Long> {
        return try {
            val arr = JSONArray(prefs(ctx).getString(KEY_HOURLY, "[]") ?: "[]")
            val out = ArrayList<Long>(arr.length())
            for (i in 0 until arr.length()) out.add(arr.optLong(i, 0L))
            out
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun noteHourly(ctx: Context) {
        val now = System.currentTimeMillis()
        val recent = loadHourly(ctx).filter { now - it < 3600_000L } + now
        val arr = JSONArray()
        recent.forEach { arr.put(it) }
        prefs(ctx).edit()
            .putString(KEY_HOURLY, arr.toString())
            .putLong(KEY_SENT_TOTAL, prefs(ctx).getLong(KEY_SENT_TOTAL, 0L) + 1L)
            .putLong(KEY_LAST_SENT_AT, now)
            .apply()
    }

    // =========================================================================
    // 入口：原生长轮询收到消息后调用
    // =========================================================================

    /**
     * 收到 [count] 条新消息后判断要不要兜底。
     * 这个方法必须立刻返回（它在长轮询线程上被调用），真正的活儿丢到单线程池里干。
     */
    fun onInbound(ctx: Context, count: Int) {
        if (count <= 0) return
        val app = ctx.applicationContext
        // 网页活着 → 它有更完整的角色卡/世界书/记忆，交还给它，原生不插手
        if (IlinkPoller.isWebConsumerAlive()) return
        if (busy.get()) return
        if (hourlyRemaining(app) <= 0) {
            Log.w(TAG, "原生兜底本小时额度已用完，不再回信")
            return
        }
        if (!busy.compareAndSet(false, true)) return
        try {
            executor.execute { runFallback(app) }
        } catch (e: Exception) {
            busy.set(false)
            Log.e(TAG, "提交兜底任务失败: ${e.message}")
        }
    }

    private fun runFallback(ctx: Context) {
        try {
            // 宽限：网页可能只是刚好被节流了一下，等几秒它会自己把消息拉走
            Thread.sleep(GRACE_MS)
            if (IlinkPoller.isWebConsumerAlive()) {
                Log.d(TAG, "宽限期内网页恢复，取消本次兜底")
                return
            }

            val pending = pendingMessages(ctx)
            if (pending.isEmpty()) return

            val snap = OfflineBrain.loadSnapshot(ctx)
            if (snap == null || !OfflineBrain.isFresh(snap)) {
                recordError(ctx, "没有可用的原生上下文快照（网页从未保存过对话快照），无法兜底回信")
                Log.w(TAG, "快照缺失或过期，跳过兜底")
                return
            }

            for (msg in pending) {
                // 注意：这里只能用 IlinkPoller 的心跳判断，不能再去读一次队列
                //（读队列会刷新心跳，等于自己骗自己「网页还活着」）
                if (IlinkPoller.isWebConsumerAlive()) break
                if (hourlyRemaining(ctx) <= 0) break
                handleOne(ctx, snap, msg)
            }
        } catch (e: Exception) {
            Log.e(TAG, "兜底任务异常: ${e.message}")
            recordError(ctx, e.message ?: e.toString())
        } finally {
            busy.set(false)
        }
    }

    private class PendingMsg(
        val fromUserId: String,
        val text: String,
        val contextToken: String,
        val msgId: String
    )

    /**
     * 读原生队列里未 ack 的消息。
     * 用 pendingSnapshot 而不是 fetchPending —— 后者会刷新「网页心跳」，原生自己读会让
     * 兜底逻辑误判网页还活着，从而永远不接管。
     */
    private fun pendingMessages(ctx: Context): List<PendingMsg> {
        val out = ArrayList<PendingMsg>()
        try {
            val raw = IlinkPoller.pendingSnapshot(ctx)
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                val p = item.optJSONObject("payload") ?: continue
                val text = p.optString("text", "")
                val from = p.optString("fromUserId", "")
                if (from.isEmpty() || text.isEmpty()) continue
                out.add(PendingMsg(from, text, p.optString("contextToken", ""), p.optString("msgId", "")))
            }
        } catch (e: Exception) {
            Log.w(TAG, "读取待回消息失败: ${e.message}")
        }
        return out
    }

    private fun handleOne(ctx: Context, snap: JSONObject, msg: PendingMsg) {
        // ★ 认领：网页之后醒来时会因为认领失败而跳过，避免同一条消息回两遍
        val claimed = try {
            AndroidMcp.getInstance(ctx).claimIncomingMessage(msg.fromUserId, msg.msgId)
        } catch (e: Exception) {
            true
        }
        if (!claimed) {
            Log.d(TAG, "消息已被网页认领，原生跳过")
            return
        }

        val api = snap.optJSONObject("api") ?: JSONObject()
        val charName = snap.optString("charName", "角色")
        val messages = buildMessages(snap, msg)

        // 「正在输入」是体验细节，失败无所谓
        val ticket = try { IlinkPoller.getConfig(ctx, msg.fromUserId, msg.contextToken) } catch (e: Exception) { "" }

        var lastErr = ""
        for (attempt in 1..MAX_ATTEMPTS) {
            try {
                if (ticket.isNotEmpty()) IlinkPoller.sendTyping(ctx, msg.fromUserId, ticket, 1)
                val r = OfflineBrain.callLlm(api, messages.toString())
                if (!r.ok) {
                    lastErr = r.error
                    Log.w(TAG, "兜底生成失败（第 $attempt 次）：${r.error}")
                    if (attempt < MAX_ATTEMPTS) Thread.sleep(RETRY_DELAY_MS)
                    continue
                }
                val text = cleanOutbound(r.text)
                if (text.isBlank()) {
                    lastErr = "模型没有产出可发送的正文"
                    continue
                }
                val sent = IlinkPoller.sendText(ctx, msg.fromUserId, text, msg.contextToken)
                if (!sent.ok) {
                    lastErr = sent.error
                    Log.w(TAG, "原生发送失败：${sent.error}")
                    if (sent.stale) {
                        // token 失效：立刻停掉整条链路，等用户重新扫码
                        recordError(ctx, "登录态已失效，请重新扫码登录")
                        try { IlinkPoller.stop(ctx) } catch (e: Exception) { }
                        return
                    }
                    continue
                }
                noteHourly(ctx)
                lastError = ""
                prefs(ctx).edit().putString(KEY_LAST_ERROR, "").apply()
                Log.d(TAG, "原生兜底已回信给 ${charName}：${text.take(40)}")
                // 顺手把这条入站消息写进 App 的聊天库，用户回到 App 时能看到完整对话
                pushIntoAppChat(ctx, snap.optLong("sessionId", 0L), msg.text, text)
                return
            } catch (e: Exception) {
                lastErr = e.message ?: e.toString()
                if (attempt < MAX_ATTEMPTS) Thread.sleep(RETRY_DELAY_MS)
            } finally {
                if (ticket.isNotEmpty()) try { IlinkPoller.sendTyping(ctx, msg.fromUserId, ticket, 2) } catch (e: Exception) { }
            }
        }
        recordError(ctx, lastErr)
    }

    /**
     * 把快照里的成品上下文 + 本条新消息拼成最终请求。
     *
     * 注意：快照是「上一次网页请求时」的上下文，里面**没有**这条刚到的新消息，
     * 所以必须把它作为最后一条 user 追加进去，否则模型看不到用户刚说了什么。
     */
    private fun buildMessages(snap: JSONObject, msg: PendingMsg): JSONArray {
        val out = JSONArray()
        val base = snap.optJSONArray("messages")
        if (base != null) {
            for (i in 0 until base.length()) {
                val m = base.optJSONObject(i) ?: continue
                out.put(JSONObject().apply {
                    put("role", m.optString("role", "user"))
                    put("content", m.optString("content", ""))
                })
            }
        }
        out.put(JSONObject().apply {
            put("role", "user")
            put("content", msg.text)
        })
        return out
    }

    // =========================================================================
    // 入 App 聊天库：让用户回到 App 时能看到这段时间的对话
    // =========================================================================

    /**
     * 原生发出去的这条回复，网页是不知道的（它当时被冻结着）。
     * 这里做两件事：
     *   1) 记进原生补录队列（网页下次活过来时主动来取，保证不丢）；
     *   2) 顺手尝试直接注入一次 JS —— WebView 恰好还活着的话就能立刻上屏。
     */
    private fun pushIntoAppChat(ctx: Context, sessionId: Long, userText: String, replyText: String) {
        val entryId = appendToLog(ctx, sessionId, userText, replyText)
        if (sessionId <= 0L) return
        try {
            val wv = AndroidMcp.getEffectiveWebView() ?: return
            val payload = JSONObject().apply {
                put("id", entryId)
                put("sessionId", sessionId)
                put("userText", userText)
                put("replyText", replyText)
                put("at", System.currentTimeMillis())
            }.toString()
            val b64 = android.util.Base64.encodeToString(
                payload.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP
            )
            wv.post {
                try {
                    wv.evaluateJavascript(
                        "javascript:try{if(window.wechatBridge&&window.wechatBridge.onNativeReplied)" +
                            "{window.wechatBridge.onNativeReplied('" + b64 + "');}}catch(e){}",
                        null
                    )
                } catch (e: Exception) { }
            }
        } catch (e: Exception) { }
    }

    // ---------- 原生补录队列 ----------

    private fun logFile(ctx: Context) = java.io.File(ctx.applicationContext.filesDir, LOG_FILE)

    private fun readLog(ctx: Context): JSONArray {
        return try {
            val f = logFile(ctx)
            if (!f.exists() || f.length() == 0L) JSONArray() else JSONArray(f.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            JSONArray()
        }
    }

    private fun writeLog(ctx: Context, arr: JSONArray) {
        try {
            val f = logFile(ctx)
            val tmp = java.io.File(ctx.applicationContext.filesDir, "$LOG_FILE.tmp")
            tmp.writeText(arr.toString(), Charsets.UTF_8)
            if (f.exists()) f.delete()
            if (!tmp.renameTo(f)) {
                tmp.copyTo(f, overwrite = true)
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "写入补录队列失败: ${e.message}")
        }
    }

    private fun appendToLog(ctx: Context, sessionId: Long, userText: String, replyText: String): Long {
        return try {
            synchronized(this) {
                val arr = readLog(ctx)
                val id = System.currentTimeMillis()
                arr.put(JSONObject().apply {
                    put("id", id)
                    put("sessionId", sessionId)
                    put("userText", userText)
                    put("replyText", replyText)
                    put("at", id)
                })
                // 只留最近 LOG_MAX 条（旧条目没人来取说明网页长期不在，留着也没意义）
                val trimmed = JSONArray()
                val start = if (arr.length() > LOG_MAX) arr.length() - LOG_MAX else 0
                for (i in start until arr.length()) trimmed.put(arr.optJSONObject(i))
                writeLog(ctx, trimmed)
                id
            }
        } catch (e: Exception) {
            -1L
        }
    }

    /** 供网页取走补录记录（返回 JSON 数组字符串） */
    fun fetchLog(ctx: Context): String {
        return try {
            synchronized(this) { readLog(ctx).toString() }
        } catch (e: Exception) {
            "[]"
        }
    }

    /** 网页落库完成后按 id 确认删除 */
    fun ackLog(ctx: Context, id: Long) {
        if (id <= 0L) return
        try {
            synchronized(this) {
                val arr = readLog(ctx)
                val keep = JSONArray()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    if (o.optLong("id", 0L) != id) keep.put(o)
                }
                writeLog(ctx, keep)
            }
        } catch (e: Exception) { }
    }

    fun logCount(ctx: Context): Int = try { readLog(ctx).length() } catch (e: Exception) { 0 }

    // =========================================================================
    // 出站清洗（与 app_wechat_bridge.cleanOutbound 同口径，保证发到微信的是干净人话）
    // =========================================================================

    fun cleanOutbound(raw: String?): String {
        if (raw.isNullOrEmpty()) return ""
        var t = raw
        t = t.replace(Regex("<think>[\\s\\S]*?</think>", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("</?think>", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("[\\[【]STATUS[\\]】][\\s\\S]*$", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("[\\[【]TRANSLATE[\\]】][\\s\\S]*?[\\[【]/TRANSLATE[\\]】]", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("[\\[【]TRANSLATE[\\]】][\\s\\S]*$", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("[\\[【](QUOTE|引用)\\s*[:：]\\s*\\d+[\\]】]\\s*", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("[\\[【](AUTO_CALL|CHECK_PHONE|SPLIT)\\s*[:：]?[^\\]】]*[\\]】]", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("[\\[【]表情包[:：][^\\]】]*[\\]】]"), "")
        t = t.replace(Regex("[\\[【]SPLIT[\\]】]", RegexOption.IGNORE_CASE), "")
        t = t.replace(Regex("__TR\\d+__"), "")
        // 残留的孤立 JSON 片段兜底（只删明显 JSON 形状的，不误删对白）
        t = t.replace(Regex("\\[\\s*\"[^\"\\n]{1,40}\"\\s*:[^\\]\\n]{0,400}\\]"), "")
        t = t.replace(Regex("\\{\\s*\"[^\"\\n]{1,40}\"\\s*:[^}\\n]{0,600}\\}"), "")
        t = t.replace(Regex("(^|\\n)\\s*[}\\]]\\s*(\\n|$)"), "$1$2")
        t = t.replace(Regex("<[^>\\n]{1,80}>"), "")
        t = t.replace(Regex("```[\\s\\S]*?```"), "")
        t = t.replace(Regex("[ \\t]+"), " ")
        t = t.replace(Regex("\\n{3,}"), "\n\n")
        return t.trim()
    }

    private fun recordError(ctx: Context, msg: String) {
        lastError = msg
        try {
            prefs(ctx).edit().putString(KEY_LAST_ERROR, msg).apply()
        } catch (e: Exception) { }
    }

    // =========================================================================
    // 诊断
    // =========================================================================

    fun statusJson(ctx: Context): String {
        return try {
            val snap = OfflineBrain.loadSnapshot(ctx)
            JSONObject().apply {
                put("webConsumerAlive", IlinkPoller.isWebConsumerAlive())
                put("hasSnapshot", snap != null)
                put("snapshotAgeMs", OfflineBrain.ageMs(snap))
                put("snapshotSessionId", snap?.optLong("sessionId", 0L) ?: 0L)
                put("snapshotApiModel", snap?.optJSONObject("api")?.optString("model", "") ?: "")
                put("busy", busy.get())
                put("sentTotal", sentTotal(ctx))
                put("lastSentAt", lastSentAt(ctx))
                put("hourlyRemaining", hourlyRemaining(ctx))
                put("pendingLog", logCount(ctx))
                put("lastError", reportError(ctx))
            }.toString()
        } catch (e: Exception) {
            "{}"
        }
    }
}
