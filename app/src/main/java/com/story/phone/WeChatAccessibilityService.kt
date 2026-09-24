package com.story.phone

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.Random

/**
 * 微信接入无障碍服务
 * ---------------------------------------------------------------------------
 * 职责：只在微信（com.tencent.mm）前台时工作，做两件事
 *   1) 读：把当前会话里「对方发来的新消息」抓成结构化事件，排进收件箱等前端来取。
 *   2) 写：前端把要回的文本排进回信队列，本服务在当前会话里填进输入框并点发送。
 *
 * 安全边界（有意为之，不要放松）：
 *   - 只处理微信包名，其它 App 的界面完全不碰。
 *   - 发送前必须做「会话名校验」：当前打开的会话名与回信目标不一致时一律不发，
 *     宁可不发，也绝不发错人。
 *   - 收件箱、回信队列、去重表都有上限，长时间挂着不会无限涨内存。
 *
 * 不做的事：不碰微信数据库、不伪造消息、不后台静默群发。
 */
class WeChatAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "WeChatA11y"

        /** 微信包名；非此包名的事件直接丢弃 */
        const val WECHAT_PKG = "com.tencent.mm"

        private const val MAX_INBOX = 500
        private const val MAX_SEEN = 1500
        private const val MAX_REPLY_QUEUE = 20

        /** 回信排队后超过这个时间仍未发出的，作废 */
        private const val REPLY_TTL_MS = 90_000L

        @Volatile
        private var instance: WeChatAccessibilityService? = null

        /** 服务是否被系统绑定（即用户是否已在系统设置里开启本服务） */
        fun isRunning(): Boolean = instance != null

        // ---------------- 运行配置（由前端经 AndroidMcp 下发） ----------------

        /** 总开关：关掉后服务仍然连着，但完全不读不写 */
        @Volatile
        var listenEnabled: Boolean = false

        /** 是否允许把回复自动发出去（关掉则只在 App 内回复，不碰微信） */
        @Volatile
        var autoReplyEnabled: Boolean = false

        /** 是否允许自动跳转会话（关闭时：目标会话没打开就不发） */
        @Volatile
        var autoNavigateEnabled: Boolean = true

        /** 只处理这些会话名（空集合 = 不额外限制，由前端按会话过滤） */
        @Volatile
        var allowedConversations: MutableSet<String> = java.util.Collections.synchronizedSet(HashSet<String>())

        @Volatile
        var readCount: Int = 0

        @Volatile
        var sentCount: Int = 0

        // ---------------- 运行时状态 ----------------

        /** 当前打开的微信会话名（不在会话页时为 null） */
        @Volatile
        var currentChatName: String? = null

        /** 最近一次状态说明（诊断用，设置页直接显示） */
        @Volatile
        var lastStatus: String = "服务已连接，等待微信前台"

        @Volatile
        var lastEventTs: Long = 0L

        /**
         * 最近一次「在微信里真的读到了东西」的快照。
         * 为什么需要它：设置面板是从小手机里打开的，而同一时刻活动窗口就是小手机自己 ——
         * 现场再探一次只能得到「当前不是微信」。有了这个缓存，用户切回来看面板时
         * 仍然能看到刚才在微信里到底读到了什么，不必在两个 App 之间来回切。
         */
        @Volatile
        var lastScanTs: Long = 0L

        @Volatile
        var lastScanJson: String = ""

        /** 收件箱：前端按游标轮询取走 */
        private val inbox = ArrayDeque<JSONObject>()

        /** 已见过的事件指纹（防同一条消息重复上报） */
        private val seenFingerprints = LinkedHashSet<String>()

        /** 回信队列（本类内部消费） */
        private val replyQueue = ArrayDeque<ReplyTask>()

        /** 每个会话「最后一条已知消息」的指纹，用于判断哪条是新消息 */
        private val lastKnownInChat = HashMap<String, String>()

        private class ReplyTask(
            val id: String,
            val conversation: String,
            val text: String,
            val enqueuedAt: Long
        ) {
            var attempts: Int = 0
            var lastError: String = ""
        }

        // ---------------- 供 AndroidMcp / 前端调用的接口 ----------------

        /** 取走最多 limit 条新消息，取走即出队（前端游标语义） */
        @Synchronized
        fun drainInbox(limit: Int): JSONArray {
            val arr = JSONArray()
            val n = if (limit <= 0) 0 else limit
            var i = 0
            while (!inbox.isEmpty() && i < n) {
                arr.put(inbox.pollFirst())
                i++
            }
            return arr
        }

        /** 入队一条新消息事件（去重 + 容量控制都在这里） */
        @Synchronized
        private fun pushInbox(evt: JSONObject) {
            val fp = evt.optString("fingerprint")
            if (fp.isNotEmpty()) {
                if (seenFingerprints.contains(fp)) return
                seenFingerprints.add(fp)
                if (seenFingerprints.size > MAX_SEEN) {
                    val it = seenFingerprints.iterator()
                    var drop = seenFingerprints.size - MAX_SEEN
                    while (it.hasNext() && drop > 0) {
                        it.next()
                        it.remove()
                        drop--
                    }
                }
            }
            inbox.addLast(evt)
            while (inbox.size > MAX_INBOX) inbox.pollFirst()
        }

        @Synchronized
        fun peekInboxSize(): Int = inbox.size

        /** 清空收件箱（前端切换绑定 / 清空通道时调用） */
        @Synchronized
        fun clearInbox() {
            inbox.clear()
            lastKnownInChat.clear()
            lastStatus = "收件箱已清空"
        }

        @Synchronized
        fun replyQueueSize(): Int = replyQueue.size

        /** 清空未发出的回信队列 */
        @Synchronized
        fun clearReplies() {
            replyQueue.clear()
            lastStatus = "回信队列已清空"
        }

        @Synchronized
        fun resetStats() {
            readCount = 0
            sentCount = 0
        }

        /**
         * 排一条回信任务。
         * 返回 JSON：{ok, id, error}
         */
        @Synchronized
        fun enqueueReply(conversation: String, text: String): JSONObject {
            val result = JSONObject()
            if (conversation.isBlank()) {
                result.put("ok", false)
                result.put("error", "会话名为空，拒绝发送（避免发错人）")
                return result
            }
            if (text.isBlank()) {
                result.put("ok", false)
                result.put("error", "回复内容为空")
                return result
            }
            if (replyQueue.size >= MAX_REPLY_QUEUE) {
                result.put("ok", false)
                result.put("error", "回信队列已满（$MAX_REPLY_QUEUE 条待发），请稍后再试")
                return result
            }
            val id = "r" + System.currentTimeMillis() + "_" + Random().nextInt(9000)
            replyQueue.addLast(ReplyTask(id, conversation, text, System.currentTimeMillis()))
            result.put("ok", true)
            result.put("id", id)
            result.put("queued", replyQueue.size)
            // 立即尝试一次；此时不满足条件也没关系，后续界面事件会继续推进
            instance?.tryDispatchReplies()
            return result
        }

        /** 当前挂起回信任务快照 */
        @Synchronized
        fun pendingReplies(): JSONArray {
            val arr = JSONArray()
            for (t in replyQueue) {
                arr.put(JSONObject().apply {
                    put("id", t.id)
                    put("conversation", t.conversation)
                    put("text", t.text)
                    put("attempts", t.attempts)
                    put("lastError", t.lastError)
                    put("enqueuedAt", t.enqueuedAt)
                })
            }
            return arr
        }

        /**
         * 界面诊断：把「服务眼里的微信」原样吐出来。
         * 微信版本众多、各家 ROM 的无障碍树也不一致，没有这个就只能靠「没反应」猜。
         * 返回：能否读到会话名 / 消息条数 / 输入框是否可见可编辑 / 发送按钮是否找得到 /
         *       当前前台包名，以及失败时最可能的原因。
         */
        /**
         * 界面诊断：先看「此刻活动窗口是不是微信」，再把「最近一次在微信里读到的快照」一并给出。
         *
         * 为什么必须两段一起给：设置面板本身开在小手机里，用户看面板时活动窗口就是小手机自己，
         * 现场永远只能得到「当前不是微信」。真正有用的信息是刚才在微信里读到了什么 ——
         * 那部分由 rememberScan() 在每次成功扫描时缓存下来。
         */
        fun probeCurrentScreen(): String {
            val obj = JSONObject()
            try {
                obj.put("ok", true)
                val svc = instance
                if (svc == null) {
                    obj.put("running", false)
                    obj.put("hint", "无障碍服务没有连上：请到系统设置 → 无障碍 里打开「叙事诗小手机 · 微信接入」")
                    return obj.toString()
                }
                obj.put("running", true)
                obj.put("configuredListen", listenEnabled)
                obj.put("configuredAutoReply", autoReplyEnabled)
                obj.put("lastStatus", lastStatus)
                obj.put("lastEventTs", lastEventTs)

                // ---- 第一段：此刻的活动窗口 ----
                var fgPkg = ""
                try {
                    val w = svc.windows
                    if (w != null && w.isNotEmpty()) {
                        fgPkg = w[0].root?.packageName?.toString() ?: ""
                    }
                } catch (e: Exception) {
                }
                obj.put("foregroundPackage", fgPkg)

                val root = svc.rootInActiveWindow
                var livePkg = ""
                if (root == null) {
                    obj.put("liveReason", "取不到活动窗口")
                    obj.put("foregroundIsWechat", false)
                } else {
                    try {
                        livePkg = root.packageName?.toString() ?: ""
                    } finally {
                        try { root.recycle() } catch (e: Exception) {}
                    }
                    obj.put("windowPackage", livePkg)
                    if (livePkg != WECHAT_PKG) {
                        obj.put("foregroundIsWechat", false)
                        obj.put("liveReason", "此刻的活动窗口不是微信（是 " +
                            (if (livePkg.isEmpty()) "未知应用" else livePkg) +
                            "）。这是正常的 —— 设置面板开在微信里，活动窗口只会是小手机。" +
                            "下面显示的是最近一次在微信前台时真正读到的内容。")
                    } else {
                        obj.put("foregroundIsWechat", true)
                        obj.put("liveReason", "此刻活动窗口就是微信")
                    }
                }

                // ---- 第二段：最近一次成功快照 ----
                var snap: JSONObject? = null
                if (lastScanJson.isNotEmpty()) {
                    try { snap = JSONObject(lastScanJson) } catch (e: Exception) { snap = null }
                }
                if (lastScanJson.isEmpty()) {
                    obj.put("reason", "还没有在微信里读到过任何东西。请打开微信、进入一个聊天窗口停一会儿，" +
                        "再回来看这里（或在微信里直接看通知/事件流）。")
                } else {
                    obj.put("reason", "最近一次在微信里读到的内容如下（" +
                        (if (lastScanTs > 0) "含时间戳" else "") + "）")
                }
                obj.put("lastScanTs", lastScanTs)
                if (snap != null) {
                    obj.put("chatName", snap.optString("chatName"))
                    obj.put("inputFound", snap.optBoolean("inputFound"))
                    obj.put("inputEditable", snap.optBoolean("inputEditable"))
                    obj.put("sendButtonFound", snap.optBoolean("sendButtonFound"))
                    obj.put("visibleMessageCount", snap.optInt("visibleMessageCount"))
                    obj.put("incomingCount", snap.optInt("incomingCount"))
                    obj.put("systemLineCount", snap.optInt("systemLineCount"))
                    obj.put("preview", snap.optJSONArray("preview") ?: JSONArray())
                    obj.put("lastScanReason", snap.optString("reason"))
                } else {
                    obj.put("visibleMessageCount", 0)
                    obj.put("preview", JSONArray())
                }
            } catch (e: Exception) {
                return "{\"ok\":false,\"error\":\"" + (e.message ?: "诊断异常") + "\"}"
            }
            return obj.toString()
        }

        /** 供 AndroidMcp 查询的状态 JSON */
        fun buildStatusJson(): String {
            return try {
                JSONObject().apply {
                    put("ok", true)
                    put("serviceRunning", isRunning())
                    put("listenEnabled", listenEnabled)
                    put("autoReplyEnabled", autoReplyEnabled)
                    put("autoNavigateEnabled", autoNavigateEnabled)
                    put("currentChatName", currentChatName ?: "")
                    put("lastStatus", lastStatus)
                    put("lastEventTs", lastEventTs)
                    put("inboxSize", peekInboxSize())
                    put("replyQueueSize", replyQueueSize())
                    put("readCount", readCount)
                    put("sentCount", sentCount)
                    put("allowedConversations", JSONArray(allowedConversations.toList()))
                }.toString()
            } catch (e: Exception) {
                "{\"ok\":false,\"error\":\"" + (e.message ?: "状态构建失败") + "\"}"
            }
        }

        /** 手动快照当前界面（设置页「立即读一次」按钮用） */
        fun requestSnapshot() {
            try {
                instance?.scanCurrentScreen(true)
            } catch (e: Exception) {
                Log.e(TAG, "requestSnapshot 失败: " + e.message)
            }
        }
    }

    // =========================================================================
    // 生命周期
    // =========================================================================

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        lastStatus = "服务已连接"
        Log.d(TAG, "无障碍服务已连接")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        lastStatus = "服务已断开"
        Log.d(TAG, "无障碍服务已销毁")
        super.onDestroy()
    }

    override fun onInterrupt() {
        lastStatus = "服务被系统中断"
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        // 硬边界：只处理微信
        if (event.packageName?.toString() != WECHAT_PKG) return
        lastEventTs = System.currentTimeMillis()
        if (!listenEnabled && !autoReplyEnabled) return
        try {
            scanCurrentScreen(false)
        } catch (e: Exception) {
            Log.e(TAG, "扫描界面失败: " + e.message)
        }
    }

    // =========================================================================
    // 读：抓取当前界面上的新消息
    // =========================================================================

    /**
     * 缓存「刚才在微信里读到了什么」。
     * 设置面板只能在小手机里打开，那时活动窗口已经不是微信了，
     * 所以现场重探没有意义 —— 有用的信息必须在这里、在微信真的在前台时存下来。
     */
    private fun rememberScan(root: AccessibilityNodeInfo, chatName: String?, msgs: List<JSONObject>) {
        try {
            val preview = JSONArray()
            for (m in msgs.takeLast(6)) {
                preview.put(JSONObject().apply {
                    put("dir", m.optString("direction"))
                    put("sys", m.optBoolean("systemLine"))
                    put("sender", m.optString("sender"))
                    put("text", m.optString("text").take(60))
                })
            }
            var incoming = 0
            var sysLines = 0
            for (m in msgs) {
                if (m.optString("direction") == "in") incoming++
                if (m.optBoolean("systemLine")) sysLines++
            }
            val input = findChatInput(root)
            lastScanJson = JSONObject().apply {
                put("chatName", chatName ?: "")
                put("inputFound", input != null)
                put("inputEditable", input?.isEditable ?: false)
                put("sendButtonFound", findSendButton(root) != null)
                put("visibleMessageCount", msgs.size)
                put("incomingCount", incoming)
                put("systemLineCount", sysLines)
                put("preview", preview)
                put("reason", when {
                    chatName == null -> "微信在前台，但会话名没识别出来（为防串台会跳过读取）"
                    msgs.isEmpty() -> "微信在前台、会话名读到了，但没读到任何消息气泡（可能是微信屏蔽了无障碍读取）"
                    else -> "正常：能读到这个会话的消息"
                })
            }.toString()
            lastScanTs = System.currentTimeMillis()
        } catch (e: Exception) {
            Log.w(TAG, "缓存扫描快照失败: " + e.message)
        }
    }

    private fun scanCurrentScreen(force: Boolean) {
        val root = rootInActiveWindow
        if (root == null) {
            currentChatName = null
            return
        }
        try {
            // 0) 【硬校验】活动窗口必须是微信。
            //    rootInActiveWindow 返回的是「系统当前认为的活动窗口」：用户切回小手机时它就是小手机自己。
            //    不校验的话会把本应用自己的界面文字当成微信消息读进来 —— 这就是之前误报的根因。
            val pkg = root.packageName?.toString() ?: ""
            if (pkg != WECHAT_PKG) {
                currentChatName = null
                if (force) {
                    lastStatus = "当前活动窗口不是微信（是 " + (if (pkg.isEmpty()) "未知应用" else pkg) + "），已跳过读取"
                }
                // 不在微信前台也可能有回信任务等着（用户切走后回来），尝试推进但内部会再校验会话名
                if (autoReplyEnabled) tryDispatchReplies()
                return
            }

            // 1) 会话页才继续（会话页一定有底部输入框）
            val input = findChatInput(root)
            if (input == null) {
                currentChatName = null
                if (force) lastStatus = "微信在前台，但当前不在会话页（没找到底部输入框）"
                if (autoReplyEnabled) tryDispatchReplies()
                return
            }

            // 2) 会话名
            val name = resolveChatName(root)
            currentChatName = name

            val msgs = collectMessages(root, name)
            rememberScan(root, name, msgs)
            if (msgs.isEmpty()) {
                if (force) lastStatus = if (name != null) "会话「$name」暂无可读消息（可能是微信屏蔽了无障碍读取）" else "未识别到会话名与消息"
                if (autoReplyEnabled) tryDispatchReplies()
                return
            }

            if (name == null) {
                // 名字认不出来就不上报：宁可漏，也不能串台
                lastStatus = "无法识别当前会话名，已跳过本轮读取"
                if (autoReplyEnabled) tryDispatchReplies()
                return
            }

            val lastFp = msgs[msgs.size - 1].optString("fingerprint")
            val known = lastKnownInChat[name]
            if (known == null) {
                // 首次进入该会话：只记基线，不补历史，避免把一屏旧消息全灌进来
                lastKnownInChat[name] = lastFp
                lastStatus = "会话「$name」已建立基线（共读到 ${msgs.size} 条可见消息，不补历史）"
                if (autoReplyEnabled) tryDispatchReplies()
                return
            }
            if (known == lastFp) {
                if (autoReplyEnabled) tryDispatchReplies()
                return
            }

            // 3) 找 known 之后的新消息
            var startIdx = -1
            for (i in msgs.indices.reversed()) {
                if (msgs[i].optString("fingerprint") == known) {
                    startIdx = i
                    break
                }
            }
            val fresh: List<JSONObject> =
                if (startIdx >= 0) msgs.subList(startIdx + 1, msgs.size)
                else listOf(msgs[msgs.size - 1])

            var queued = 0
            val allow = allowedConversations
            for (m in fresh) {
                if (m.optString("direction") != "in") continue   // 只上报对方发来的
                if (m.optBoolean("systemLine")) continue          // 过滤时间戳/拍一拍等
                if (allow.isNotEmpty() && !allow.contains(name)) continue
                m.put("conversation", name)
                m.put("ts", System.currentTimeMillis())
                pushInbox(m)
                queued++
                readCount++
            }
            lastKnownInChat[name] = lastFp
            lastStatus = if (queued > 0) "会话「$name」收到 $queued 条新消息"
            else "会话「$name」有新动静，但不是对方发来的文本消息"

            if (autoReplyEnabled) tryDispatchReplies()
        } catch (e: Exception) {
            Log.e(TAG, "扫描异常: " + e.message)
        }
    }

    /** 会话名识别：取文字区最靠上的短文本（微信会话页标题栏） */
    private fun resolveChatName(root: AccessibilityNodeInfo): String? {
        val candidates = ArrayList<Pair<String, Int>>()  // 文本 -> top
        walk(root) { node ->
            val cls = node.className?.toString() ?: ""
            if (cls.contains("TextView") || cls.contains("EditText")) {
                val t = node.text?.toString()?.trim()
                if (!TextUtils.isEmpty(t)) {
                    val r = Rect()
                    node.getBoundsInScreen(r)
                    if (r.top < 320 && r.width() > 0) {
                        val vid = node.viewIdResourceName ?: ""
                        if (!vid.contains("input") && !vid.contains("edit")) {
                            candidates.add(Pair(t.toString(), r.top))
                        }
                    }
                }
            }
        }
        if (candidates.isEmpty()) return null
        val filtered = candidates.filter { it.first.length in 1..24 && !looksLikeSystemText(it.first) }
        if (filtered.isEmpty()) return null
        return filtered.minByOrNull { it.second }?.first
    }

    /** 收集当前会话里可见的消息气泡 */
    private fun collectMessages(root: AccessibilityNodeInfo, chatName: String?): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val midX = screenWidth / 2

        // 消息容器：优先 RecyclerView/ListView，兜底全树
        val containers = ArrayList<AccessibilityNodeInfo>()
        walk(root) { node ->
            val cls = node.className?.toString() ?: ""
            if (cls.contains("RecyclerView") || cls.contains("ListView")) containers.add(node)
        }
        val scopes: List<AccessibilityNodeInfo> = if (containers.isNotEmpty()) ArrayList(containers) else listOf(root)

        for (scope in scopes) {
            walk(scope) { node ->
                val cls = node.className?.toString() ?: ""
                if (!cls.contains("TextView")) return@walk
                val text = node.text?.toString()?.trim()
                if (text.isNullOrEmpty()) return@walk
                val r = Rect()
                node.getBoundsInScreen(r)
                if (r.width() <= 0 || r.height() <= 0) return@walk
                // 排除顶部标题栏与底部输入栏
                if (r.top < 260) return@walk
                if (r.bottom > screenHeight - 120) return@walk

                val centerX = (r.left + r.right) / 2
                val direction = if (centerX > midX) "out" else "in"
                val systemLine = looksLikeSystemText(text)
                val sender =
                    if (direction == "in") (findSenderNameNear(node, r) ?: (chatName ?: "")) else ""

                out.add(JSONObject().apply {
                    put("text", text)
                    put("direction", direction)
                    put("sender", sender)
                    put("systemLine", systemLine)
                    put("fingerprint", fingerprintOf(direction, text, r.top, r.left))
                    put("top", r.top)
                    put("left", r.left)
                })
            }
            if (out.isNotEmpty()) break
        }
        out.sortBy { it.optInt("top") }
        return out
    }

    /** 取气泡附近的发送者名字：同一个气泡块内、位于本条文本上方的小号文本 */
    private fun findSenderNameNear(node: AccessibilityNodeInfo, nodeRect: Rect): String? {
        try {
            val parent = node.parent ?: return null
            for (i in 0 until parent.childCount) {
                val sib = parent.getChild(i) ?: continue
                if (sib === node) continue
                val t = sib.text?.toString()?.trim() ?: continue
                if (t.isEmpty() || t.length > 16) continue
                val r = Rect()
                sib.getBoundsInScreen(r)
                if (r.top <= nodeRect.top && nodeRect.top - r.bottom < 120) return t
            }
        } catch (e: Exception) {
        }
        return null
    }

    /** 时间戳 / 拍一拍 / 撤回提示等非对话内容 */
    private fun looksLikeSystemText(t: String): Boolean {
        val s = t.trim()
        if (s.isEmpty()) return true
        if (Regex("^(上午|下午|凌晨|中午|晚上)?\\s*\\d{1,2}:\\d{2}$").matches(s)) return true
        if (Regex("^(昨天|前天|星期[一二三四五六日天]|周[一二三四五六日天])(\\s+.*)?$").matches(s)) return true
        if (Regex("^\\d{4}年\\d{1,2}月\\d{1,2}日.*$").matches(s)) return true
        val sysKeywords = listOf(
            "撤回了一条消息", "拍了拍", "以下为新消息", "对方正在输入",
            "消息已发出，但被对方拒收", "开启了朋友验证", "你已添加了",
            "以上是打招呼的内容", "该消息类型暂不支持", "网络异常"
        )
        return sysKeywords.any { s.contains(it) }
    }

    /** 指纹刻意不含当前时间：同一条消息被反复读到时要稳定去重 */
    private fun fingerprintOf(direction: String, text: String, top: Int, left: Int): String {
        return (direction + "|" + top + "|" + left + "|" + text).hashCode().toString()
    }

    // =========================================================================
    // 写：回信派发
    // =========================================================================

    /** 消费回信队列：能发的立刻发，暂时发不了的留在队里等下一次界面事件 */
    private fun tryDispatchReplies() {
        val task = nextValidTask() ?: return
        val root = rootInActiveWindow
        if (root == null) {
            lastStatus = "微信不在前台，回信任务等待中（共 " + replyQueueSize() + " 条）"
            return
        }
        try {
            val input = findChatInput(root)
            if (input == null) {
                lastStatus = "当前不在微信会话页，回信任务等待中（共 " + replyQueueSize() + " 条）"
                return
            }
            val name = resolveChatName(root)
            if (name == null || name != task.conversation) {
                // 会话名对不上 —— 绝不发送
                task.attempts++
                task.lastError = "当前会话「" + (name ?: "未知") + "」与目标「" + task.conversation + "」不一致"
                lastStatus = "回信暂缓：" + task.lastError
                if (autoNavigateEnabled) {
                    val ok = navigateToConversation(task.conversation)
                    lastStatus = if (ok) "正在跳转到「" + task.conversation + "」，到达后自动发送"
                    else "无法自动跳转到「" + task.conversation + "」，请在微信里手动打开该会话"
                }
                return
            }

            if (!setTextInto(input, task.text)) {
                task.attempts++
                task.lastError = "写入输入框失败"
                lastStatus = "回信失败：写入微信输入框无响应（可能是微信版本限制）"
                return
            }

            // 给微信一点时间把文字渲染进输入框再点发送
            Handler(Looper.getMainLooper()).postDelayed(Runnable {
                try {
                    val sendRoot = rootInActiveWindow
                    val sendBtn = if (sendRoot != null) findSendButton(sendRoot) else null
                    if (sendBtn != null && clickNode(sendBtn)) {
                        completeTask(task.id)
                        lastStatus = "已发送回信到「" + task.conversation + "」"
                    } else {
                        task.attempts++
                        task.lastError = "找不到发送按钮"
                        lastStatus = "回信失败：找不到微信的发送按钮"
                    }
                } catch (e: Exception) {
                    lastStatus = "回信失败：" + e.message
                }
            }, 300L)
        } catch (e: Exception) {
            Log.e(TAG, "派发回信异常: " + e.message)
        }
    }

    @Synchronized
    private fun nextValidTask(): ReplyTask? {
        val now = System.currentTimeMillis()
        val it = replyQueue.iterator()
        while (it.hasNext()) {
            val t = it.next()
            if (now - t.enqueuedAt > REPLY_TTL_MS) {
                it.remove()
                Log.w(TAG, "回信任务超时作废: " + t.id)
            }
        }
        return replyQueue.peekFirst()
    }

    @Synchronized
    private fun completeTask(id: String) {
        val it = replyQueue.iterator()
        while (it.hasNext()) {
            if (it.next().id == id) {
                it.remove()
                sentCount++
                return
            }
        }
    }

    /** 微信会话页输入框：可编辑且位于屏幕下半部 */
    private fun findChatInput(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val holder = arrayOfNulls<AccessibilityNodeInfo>(1)
        val screenH = resources.displayMetrics.heightPixels
        walk(root) { node ->
            if (holder[0] != null) return@walk
            val cls = node.className?.toString() ?: ""
            if (!(node.isEditable || cls.contains("EditText"))) return@walk
            val r = Rect()
            node.getBoundsInScreen(r)
            if (r.top > screenH / 2 && r.width() > 0) holder[0] = node
        }
        return holder[0]
    }

    /** 微信发送按钮：屏幕下部文本为「发送」的控件 */
    private fun findSendButton(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val holder = arrayOfNulls<AccessibilityNodeInfo>(1)
        val screenH = resources.displayMetrics.heightPixels
        walk(root) { node ->
            if (holder[0] != null) return@walk
            val t = node.text?.toString()?.trim() ?: return@walk
            if (t != "发送" && t != "Send") return@walk
            val r = Rect()
            node.getBoundsInScreen(r)
            if (r.top > screenH * 0.6) holder[0] = node
        }
        return holder[0]
    }

    /**
     * 往输入框写文本：三级回退
     *   1) ACTION_SET_TEXT（不污染剪贴板）
     *   2) 剪贴板 + ACTION_PASTE（某些微信版本的输入框屏蔽 SET_TEXT）
     *   3) 直接 setText 兜底
     */
    private fun setTextInto(input: AccessibilityNodeInfo, text: String): Boolean {
        // 1) ACTION_SET_TEXT
        try {
            val args = Bundle()
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            if (input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) && verifyInputText(input, text)) return true
        } catch (e: Exception) {
            Log.w(TAG, "SET_TEXT 失败: " + e.message)
        }

        // 2) 剪贴板 + 粘贴
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("storyphone", text))
            input.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            if (input.performAction(AccessibilityNodeInfo.ACTION_PASTE) && verifyInputText(input, text)) return true
        } catch (e: Exception) {
            Log.w(TAG, "PASTE 失败: " + e.message)
        }

        // 3) 直写兜底（成功与否交由调用后的行为判断）
        try {
            input.text = text
            input.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            return true
        } catch (e: Exception) {
            Log.e(TAG, "写入输入框全部失败: " + e.message)
            return false
        }
    }

    /** 校验输入框文本：微信输入框可能是父子两层，两层都看 */
    private fun verifyInputText(input: AccessibilityNodeInfo, text: String): Boolean {
        try {
            val direct = input.text?.toString() ?: ""
            if (direct.contains(text)) return true
            val parent = input.parent ?: return false
            for (i in 0 until parent.childCount) {
                val c = parent.getChild(i) ?: continue
                val t = c.text?.toString() ?: continue
                if (t.contains(text)) return true
            }
        } catch (e: Exception) {
        }
        return false
    }

    private fun clickNode(node: AccessibilityNodeInfo): Boolean {
        var n: AccessibilityNodeInfo? = node
        var depth = 0
        while (n != null && depth < 5) {
            if (n.isClickable && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            n = n.parent
            depth++
        }
        return false
    }

    /**
     * 用微信顶部搜索跳转到指定会话。
     * 只做「打开会话」，打开后由 tryDispatchReplies 复核会话名再决定发不发。
     */
    private fun navigateToConversation(name: String): Boolean {
        return try {
            val root = rootInActiveWindow ?: return false
            if (resolveChatName(root) == name) return true

            val holder = arrayOfNulls<AccessibilityNodeInfo>(1)
            walk(root) { node ->
                if (holder[0] != null) return@walk
                val t = node.text?.toString()?.trim() ?: return@walk
                if (t == "搜索" || t == "Search") holder[0] = node
            }
            val search = holder[0] ?: return false
            if (!clickNode(search)) return false

            val main = Handler(Looper.getMainLooper())
            main.postDelayed(Runnable {
                try {
                    val r2 = rootInActiveWindow
                    val box = if (r2 != null) findSearchInput(r2) else null
                    if (box == null) return@Runnable
                    setTextInto(box, name)
                    main.postDelayed(Runnable {
                        try {
                            val r3 = rootInActiveWindow ?: return@Runnable
                            val hit = arrayOfNulls<AccessibilityNodeInfo>(1)
                            walk(r3) { node ->
                                if (hit[0] != null) return@walk
                                val t = node.text?.toString()?.trim() ?: return@walk
                                if (t == name) hit[0] = node
                            }
                            hit[0]?.let { clickNode(it) }
                        } catch (e: Exception) {
                        }
                    }, 700L)
                } catch (e: Exception) {
                }
            }, 420L)
            true
        } catch (e: Exception) {
            Log.e(TAG, "跳转会话失败: " + e.message)
            false
        }
    }

    private fun findSearchInput(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val holder = arrayOfNulls<AccessibilityNodeInfo>(1)
        val half = resources.displayMetrics.heightPixels / 2
        walk(root) { node ->
            if (holder[0] != null) return@walk
            val cls = node.className?.toString() ?: ""
            if (!(node.isEditable || cls.contains("EditText"))) return@walk
            val r = Rect()
            node.getBoundsInScreen(r)
            if (r.top < half) holder[0] = node
        }
        return holder[0]
    }

    // =========================================================================
    // 工具
    // =========================================================================

    /** 深度优先遍历；不要长期持有回调里的 node 引用 */
    private fun walk(node: AccessibilityNodeInfo?, cb: (AccessibilityNodeInfo) -> Unit) {
        node ?: return
        cb(node)
        val n = node.childCount
        for (i in 0 until n) {
            val child = try {
                node.getChild(i)
            } catch (e: Exception) {
                null
            }
            if (child != null) walk(child, cb)
        }
    }
}
