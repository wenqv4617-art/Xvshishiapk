package com.story.phone

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * 原生上下文快照（OfflineBrain）—— 「网页不在时，原生也能接着聊」的上下文来源。
 *
 * 为什么需要它
 * ------------
 * 完整的回复质量依赖网页侧那一大套：角色卡、世界书、RAG 向量记忆、上下文管理器、
 * 时间流逝折算……这些逻辑全部由 app_chat.js 的 buildSystemPrompt() 拼装，原生无法复刻，
 * 也不该复刻（一旦复刻就会和网页版两套提示词慢慢分叉）。
 *
 * 所以这里换个思路：**不重建，而是照抄**。
 *   · 网页每次真正要请求大模型之前，都会拿到一份已经完全拼好的 `messagesToSend`
 *     （system 提示词 + 历史轮次 + 世界书插入 + 时间提示……）；
 *   · 我们让网页把这份「成品」按会话缓存到原生（app_context_snapshot.json）；
 *   · 网页被系统冻结/回收时，原生直接拿这份成品 + 新来的那条微信消息，原样发给
 *     同一个 API，就能得到与网页同源的回复 —— 质量几乎不掉。
 *
 * 写入策略：临时文件 + 原子改名，避免进程在写一半时被杀导致快照损坏。
 */
object OfflineBrain {

    private const val TAG = "OfflineBrain"
    private const val FILE_NAME = "app_context_snapshot.json"
    private const val TMP_NAME = "app_context_snapshot.json.tmp"

    /** 快照里最多保留多少条历史消息（太多会让原生请求体积失控） */
    private const val MAX_HISTORY = 60

    private fun file(ctx: Context): File = File(ctx.applicationContext.filesDir, FILE_NAME)
    private fun tmpFile(ctx: Context): File = File(ctx.applicationContext.filesDir, TMP_NAME)

    /**
     * 网页保存请求快照。参数都是「已经拼好的成品」：
     *   messagesJson —— 与网页即将发给大模型的 messages 数组完全一致（JSON 字符串）
     *   apiJson      —— {url, key, model, temperature}，与大模型网关配置一致
     */
    fun saveSnapshot(
        ctx: Context,
        sessionId: Long,
        messagesJson: String,
        apiJson: String,
        charName: String,
        userName: String
    ): Boolean {
        return try {
            // 分两步解析，出错时能一眼看出是哪一段脏了（网页传入的 JSON 有可能被截断）
            val messages = try {
                JSONArray(messagesJson)
            } catch (e: Exception) {
                Log.w(TAG, "messages 不是合法 JSON 数组，放弃本次快照")
                return false
            }
            val api = try {
                JSONObject(if (apiJson.isBlank()) "{}" else apiJson)
            } catch (e: Exception) {
                JSONObject()
            }
            // 只保留 system + 最近 MAX_HISTORY 条，避免快照无限膨胀
            val trimmed = JSONArray()
            var systemKept = 0
            val start = if (messages.length() > MAX_HISTORY + 4) messages.length() - MAX_HISTORY else 0
            for (i in 0 until messages.length()) {
                val m = messages.optJSONObject(i) ?: continue
                val isSystem = m.optString("role", "") == "system"
                if (isSystem && systemKept < 4) {
                    systemKept++
                } else if (i < start) {
                    continue
                }
                trimmed.put(m)
            }
            val root = JSONObject().apply {
                put("v", 1)
                put("at", System.currentTimeMillis())
                put("sessionId", sessionId)
                put("charName", charName)
                put("userName", userName)
                put("messages", trimmed)
                put("api", api)
            }
            writeAtomic(ctx, root.toString())
            Log.d(TAG, "快照已保存：会话 $sessionId，${trimmed.length()} 条上下文")
            true
        } catch (e: Exception) {
            Log.w(TAG, "保存快照失败: ${e.message}")
            false
        }
    }

    private fun writeAtomic(ctx: Context, text: String) {
        val tmp = tmpFile(ctx)
        val dst = file(ctx)
        tmp.outputStream().use { os: OutputStream ->
            os.write(text.toByteArray(Charsets.UTF_8))
            os.flush()
        }
        if (dst.exists()) dst.delete()
        if (!tmp.renameTo(dst)) {
            // 改名失败（个别 ROM 的文件系统行为）退化为直接复制
            tmp.copyTo(dst, overwrite = true)
            tmp.delete()
        }
    }

    fun loadSnapshot(ctx: Context): JSONObject? {
        return try {
            val f = file(ctx)
            if (!f.exists() || f.length() == 0L) return null
            JSONObject(f.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            Log.w(TAG, "读取快照失败: ${e.message}")
            null
        }
    }

    fun clear(ctx: Context) {
        try {
            file(ctx).delete()
            tmpFile(ctx).delete()
        } catch (e: Exception) { }
    }

    /** 快照是否新鲜（默认 6 小时内有效；太老的上下文拿来回复反而会答非所问） */
    fun isFresh(snap: JSONObject?, ttlMs: Long = 6L * 3600_000L): Boolean {
        if (snap == null) return false
        val at = snap.optLong("at", 0L)
        if (at <= 0L) return false
        return System.currentTimeMillis() - at < ttlMs
    }

    fun ageMs(snap: JSONObject?): Long {
        if (snap == null) return -1L
        val at = snap.optLong("at", 0L)
        if (at <= 0L) return -1L
        return System.currentTimeMillis() - at
    }

    // =========================================================================
    // 大模型调用（OpenAI 兼容 /chat/completions，流式与非流式都支持）
    // =========================================================================

    private const val CONNECT_TIMEOUT_MS = 15000
    private const val READ_TIMEOUT_MS = 120000

    class LlmResult(val ok: Boolean, val text: String, val error: String)

    /**
     * 用快照里那份 API 配置 + 成品 messages 调一次大模型，返回助手回复正文。
     *
     * messagesJson 由调用方给出（快照里的上下文 + 本次新消息）。
     * 优先走流式（很多网关对长上下文非流式会超时），拿不到流式再退回非流式。
     */
    fun callLlm(api: JSONObject, messagesJson: String): LlmResult {
        val rawUrl = api.optString("url", "")
        val key = api.optString("key", "")
        val model = api.optString("model", "")
        if (rawUrl.isBlank() || model.isBlank()) {
            return LlmResult(false, "", "快照里没有可用的 API 配置")
        }
        val endpoint = if (rawUrl.trimEnd('/').endsWith("/chat/completions")) {
            rawUrl.trimEnd('/')
        } else {
            rawUrl.trimEnd('/') + "/chat/completions"
        }
        val temp = if (api.has("temperature")) api.optDouble("temperature", 0.8) else 0.8

        // 先试流式
        val streamed = tryCall(endpoint, key, model, temp, messagesJson, stream = true)
        if (streamed.ok && streamed.text.isNotBlank()) return streamed

        // 流式失败或空回复：退回非流式再来一次
        val plain = tryCall(endpoint, key, model, temp, messagesJson, stream = false)
        if (plain.ok && plain.text.isNotBlank()) return plain
        // 两个都失败：把更有信息量的那个错误抛出去
        return if (!streamed.ok) streamed else plain
    }

    private fun tryCall(
        endpoint: String,
        key: String,
        model: String,
        temperature: Double,
        messagesJson: String,
        stream: Boolean
    ): LlmResult {
        var conn: HttpURLConnection? = null
        try {
            conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", if (stream) "text/event-stream, application/json, */*" else "application/json, */*")
                if (key.isNotEmpty()) setRequestProperty("Authorization", "Bearer $key")
            }
            val body = JSONObject().apply {
                put("model", model)
                put("messages", JSONArray(messagesJson))
                put("temperature", temperature)
                put("stream", stream)
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val status = conn.responseCode
            if (status !in 200..299) {
                val err = readAll(conn.errorStream).take(300)
                return LlmResult(false, "", "HTTP $status $err")
            }
            return if (stream) parseSse(conn.inputStream) else parsePlain(conn.inputStream)
        } catch (e: Exception) {
            return LlmResult(false, "", e.message ?: e.toString())
        } finally {
            try { conn?.disconnect() } catch (e: Exception) { }
        }
    }

    private fun readAll(s: InputStream?): String {
        if (s == null) return ""
        return try { s.bufferedReader(Charsets.UTF_8).use { it.readText() } } catch (e: Exception) { "" }
    }

    /** 非流式：直接取 choices[0].message.content（含 reasoning_content 兜底） */
    private fun parsePlain(s: InputStream?): LlmResult {
        val text = readAll(s)
        if (text.isBlank()) return LlmResult(false, "", "空响应")
        return try {
            val j = JSONObject(text)
            val msg = j.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")
            val content = msg?.optString("content", "") ?: ""
            val reasoning = msg?.optString("reasoning_content", "") ?: ""
            val out = if (content.isNotBlank()) content else reasoning
            if (out.isBlank()) LlmResult(false, "", "模型没有返回正文") else LlmResult(true, out, "")
        } catch (e: Exception) {
            LlmResult(false, "", "响应解析失败: ${e.message}")
        }
    }

    /**
     * 流式：逐行读 SSE，累积 delta.content / delta.reasoning_content，
     * 与网页侧 fetchStreamOrJson 的解析口径保持一致（thinking 还原成 <think> 块）。
     */
    private fun parseSse(s: InputStream?): LlmResult {
        if (s == null) return LlmResult(false, "", "空响应流")
        val content = StringBuilder()
        val reasoning = StringBuilder()
        try {
            s.bufferedReader(Charsets.UTF_8).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    val t = line.trim()
                    if (t.isEmpty() || t.startsWith(":")) continue
                    if (!t.startsWith("data:")) continue
                    val data = t.removePrefix("data:").trim()
                    if (data == "[DONE]") break
                    try {
                        val j = JSONObject(data)
                        val delta = j.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("delta")
                        if (delta != null) {
                            val c = delta.optString("content", "")
                            val r = delta.optString("reasoning_content", "")
                                .ifEmpty { delta.optString("thinking", "") }
                            if (c.isNotEmpty()) content.append(c)
                            if (r.isNotEmpty()) reasoning.append(r)
                        }
                    } catch (e: Exception) {
                        // 单个坏 chunk 不该中断整条流
                    }
                }
            }
        } catch (e: Exception) {
            if (content.isEmpty() && reasoning.isEmpty()) {
                return LlmResult(false, "", "流式读取失败: ${e.message}")
            }
        }
        val c = content.toString()
        val r = reasoning.toString()
        val out = when {
            c.isNotBlank() && r.isNotBlank() && !c.contains("<think>") -> "<think>\n${r.trim()}\n</think>\n$c"
            c.isNotBlank() -> c
            else -> r
        }
        return if (out.isBlank()) LlmResult(false, "", "模型没有返回正文") else LlmResult(true, out, "")
    }
}
