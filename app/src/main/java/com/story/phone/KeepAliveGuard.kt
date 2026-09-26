package com.story.phone

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.util.Log

/**
 * 保活看门狗（KeepAliveGuard）—— 解决「离开 App 后进程被国产 ROM 清掉」。
 *
 * 为什么需要它
 * ------------
 * 前台服务能挡住系统的正常内存回收，但挡不住两件事：
 *   1) 用户在最近任务里划掉卡片 —— 有些 ROM 会顺手把整个进程「强停」；
 *   2) 小米/华为/OPPO/vivo/荣耀的后台清理策略，在息屏一段时间后按省电策略清进程。
 * 进程一死，IlinkPoller 的长轮询线程跟着消失，微信侧就再也收不到也发不出消息。
 *
 * 本类用「闹钟链」把进程重新拉起来：
 *   · AlarmManager.setAndAllowWhileIdle —— Doze 深度睡眠下系统仍会唤醒 CPU 执行；
 *   · 每次触发都重新排下一次（自续期），只要用户没关掉微信接入，这条链就不断；
 *   · 触发时先检查前台服务是否真的活着，不活就立刻 startForegroundService 拉起来；
 *   · 服务活着但原生长轮询线程掉了（被 ROM 冻结过 / 异常退出），也要一并重启。
 *
 * 为什么不做「每分钟唤醒」
 * ----------------------
 * Doze 下 setAndAllowWhileIdle 有系统级频率限制（最短约 9 分钟一次），排得再密也会被
 * 系统压回 ~9 分钟。所以本类不去和系统较劲，而是：
 *   · 正常态（进程活着、长轮询在跑）：唤醒间隔直接给到 [INTERVAL_ARMED_MS]，只是「体检」；
 *   · 进程根本不在了：间隔缩短到 [INTERVAL_DEAD_MS]，靠系统允许的最快频率反复尝试复活。
 * 真正的收消息实时性由 IlinkPoller 的长轮询负责，闹钟只负责「别让进程死透」。
 */
object KeepAliveGuard {

    private const val TAG = "KeepAliveGuard"
    private const val PREF = "keep_alive_guard"

    private const val KEY_ARMED = "armed"          // 兼容旧字段：是否曾经武装过
    private const val KEY_ALARM_AT = "alarm_at"    // 下一次闹钟时间，供诊断面板展示
    private const val KEY_REVIVE_COUNT = "revive_count"
    private const val KEY_LAST_WAKE_AT = "last_wake_at"

    /**
     * 需要保活的「理由」集合（逗号分隔），例如 `ilink,pet`。
     *
     * 为什么用集合而不是一个布尔：微信接入、桌宠主动发信、应用内闹钟都会要求保活，
     * 但它们开关是独立的。任何一个关掉时都不能把闹钟链停掉 —— 只有全部关闭才解除，
     * 否则「关掉微信接入」会顺手把桌宠的主动发信也弄死。
     */
    private const val KEY_REASONS = "reasons"

    const val REASON_ILINK = "ilink"   // 微信 ClawBot 收发
    const val REASON_PET = "pet"       // 桌面桌宠主动发信
    const val REASON_ALARM = "alarm"   // 应用内定时闹钟

    private const val REQUEST_CODE = 9992
    private const val ACTION_TICK = "com.story.phone.ACTION_KEEPALIVE_TICK"

    /**
     * 紧急复活闹钟的 action 与 requestCode。
     *
     * 什么时候用：用户在最近任务里划掉卡片时。此刻进程已经离开前台，
     * **直接在 onTaskRemoved 里 startForegroundService 会被 Android 12+ 拒绝**
     * （ForegroundServiceStartNotAllowedException），所以那一步只能静默失败。
     * 正确做法是设一个 1~2 秒后的闹钟：闹钟触发属于系统豁免，届时再启动前台服务
     * 就是合法的 —— 这是划卡片后唯一还来得及的自救窗口。
     */
    private const val ACTION_REVIVE_NOW = "com.story.phone.ACTION_KEEPALIVE_REVIVE_NOW"
    private const val REQUEST_CODE_REVIVE = 9993

    /** 划卡片后多久尝试复活（太短系统可能还没把进程标记为可调度） */
    private const val REVIVE_DELAY_MS = 1500L

    /** 进程活着时的心跳间隔：只做体检，别费电 */
    private const val INTERVAL_ARMED_MS = 15L * 60_000L

    /** 进程已经不在（闹钟把我们叫醒）时的间隔：用系统允许的最快频率反复复活 */
    private const val INTERVAL_DEAD_MS = 9L * 60_000L

    /** 前台服务刚被拉起、还在 onStartCommand 途中的宽限期内的重复触发忽略窗口 */
    private const val REVIVE_DEBOUNCE_MS = 20_000L

    @Volatile private var lastReviveAt = 0L

    private fun prefs(ctx: Context) =
        ctx.applicationContext.getSharedPreferences(PREF, Context.MODE_PRIVATE)

    // =========================================================================
    // 开关
    // =========================================================================

    /**
     * 设置/清除某一个「保活理由」。
     *
     * 这是各功能与看门狗之间唯一的开关通道：
     *   · 微信接入开启 → setReason(REASON_ILINK, true)
     *   · 微信接入关闭 → setReason(REASON_ILINK, false)
     *   · 桌宠主动发信开启/关闭 → setReason(REASON_PET, ...)
     * 只要还有任意一个理由为真，闹钟链就继续跑；全部为假才真正解除。
     */
    fun setReason(ctx: Context, reason: String, wanted: Boolean) {
        try {
            val app = ctx.applicationContext
            val sp = prefs(app)
            val cur = reasonsOf(app).toMutableSet()
            val changed = if (wanted) cur.add(reason) else cur.remove(reason)
            if (!changed) return
            sp.edit().putString(KEY_REASONS, cur.joinToString(",")).apply()
            Log.d(TAG, "保活理由变更：${if (wanted) "+" else "-"}$reason → [${cur.joinToString(",")}]")

            if (cur.isEmpty()) {
                disarmInternal(app, "no-reason")
            } else {
                arm(app, "reason:$reason")
            }
        } catch (e: Exception) {
            Log.e(TAG, "设置保活理由失败: ${e.message}")
        }
    }

    private fun reasonsOf(ctx: Context): Set<String> {
        val raw = try { prefs(ctx).getString(KEY_REASONS, "") ?: "" } catch (e: Exception) { "" }
        if (raw.isBlank()) return emptySet()
        return raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }.toSet()
    }

    fun reasons(ctx: Context): Set<String> = reasonsOf(ctx)

    /** 是否还有任何功能要求保活 */
    fun hasAnyReason(ctx: Context): Boolean = reasonsOf(ctx).isNotEmpty()

    /**
     * 武装看门狗：用户开启了需要后台存活的功能（微信接入 / 桌宠发信 / 闹钟）时调用。
     * 幂等，重复调用只会把下一次闹钟往后推。
     */
    fun arm(ctx: Context, reason: String) {
        try {
            val sp = prefs(ctx)
            sp.edit().putBoolean(KEY_ARMED, true).apply()
            schedule(ctx, INTERVAL_ARMED_MS)
            Log.d(TAG, "看门狗已武装（$reason），下次体检 ${INTERVAL_ARMED_MS / 60000} 分钟后")
            // 立刻做一次自检并拉起服务：用户刚打开功能时通常服务已经在了，
            // 但从后台被复活的情况下未必。
            ensureServiceRunning(ctx, "arm:$reason")
        } catch (e: Exception) {
            Log.e(TAG, "武装看门狗失败: ${e.message}")
        }
    }

    /** 解除武装：没有任何功能需要保活了（用户全部关掉） */
    fun disarm(ctx: Context, reason: String) {
        disarmInternal(ctx.applicationContext, reason)
    }

    private fun disarmInternal(app: Context, reason: String) {
        try {
            prefs(app).edit()
                .putBoolean(KEY_ARMED, false)
                .putString(KEY_REASONS, "")
                .putLong(KEY_ALARM_AT, 0L)
                .apply()
            cancelAlarm(app)
            Log.d(TAG, "看门狗已解除（$reason）")
        } catch (e: Exception) {
            Log.e(TAG, "解除看门狗失败: ${e.message}")
        }
    }

    /**
     * 兼容旧调用点：微信接入专用。
     * 等价于 setReason(REASON_ILINK, ...)，保留是为了不破坏既有调用。
     */
    fun isArmed(ctx: Context): Boolean = hasAnyReason(ctx)

    // =========================================================================
    // 闹钟调度（自续期链）
    // =========================================================================

    private fun pendingIntent(ctx: Context): PendingIntent? {
        val intent = Intent(ctx, KeepAliveReceiver::class.java).apply { action = ACTION_TICK }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE, intent, flags)
    }

    private fun schedule(ctx: Context, intervalMs: Long) {
        try {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = pendingIntent(ctx) ?: return
            val triggerAt = System.currentTimeMillis() + intervalMs
            // setAndAllowWhileIdle：Doze 下仍能唤醒 CPU，且不需要 SCHEDULE_EXACT_ALARM
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            prefs(ctx).edit().putLong(KEY_ALARM_AT, triggerAt).apply()
        } catch (e: Exception) {
            Log.e(TAG, "排下一次闹钟失败: ${e.message}")
        }
    }

    /**
     * 划掉最近任务卡片后的紧急自救：设一个 1.5 秒后的闹钟把自己叫回来。
     *
     * 为什么不能直接 startForegroundService：Android 12+ 明确禁止"应用因用户划掉卡片
     * 离开前台后，再从后台启动前台服务"，会抛 ForegroundServiceStartNotAllowedException。
     * 而 AlarmManager 触发的广播是系统豁免路径 —— 先设闹钟，再由闹钟去启动服务。
     *
     * 这里用 set() 而不是 setAndAllowWhileIdle()：我们要的是"尽快"，Doze 那一套
     * 白名单节流反而会把它推迟；1.5 秒的短延时也不受后台启动限制约束。
     */
    fun armEmergencyRevive(ctx: Context, reason: String) {
        try {
            val app = ctx.applicationContext
            prefs(app).edit().putBoolean(KEY_ARMED, true).apply()
            val am = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val intent = Intent(app, KeepAliveReceiver::class.java).apply { action = ACTION_REVIVE_NOW }
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
            val pi = PendingIntent.getBroadcast(app, REQUEST_CODE_REVIVE, intent, flags)
            am.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + REVIVE_DELAY_MS, pi)
            Log.w(TAG, "已排紧急复活闹钟（$reason），${REVIVE_DELAY_MS}ms 后尝试把服务拉回来")
        } catch (e: Exception) {
            Log.e(TAG, "排紧急复活闹钟失败（$reason）: ${e.message}")
        }
    }

    /** 紧急复活闹钟到点：立刻复活服务，并把常规体检链也续上 */
    fun onEmergencyRevive(ctx: Context) {
        val app = ctx.applicationContext
        try {
            // 强制绕过 20 秒防抖：这一刻我们就是被系统叫回来干这件事的
            lastReviveAt = 0L
            val revived = ensureServiceRunning(app, "emergencyRevive")
            IlinkPoller.resumeIfWanted(app)
            KeepAliveGuard.schedule(app, INTERVAL_ARMED_MS)
            Log.w(TAG, "紧急复活完成：revived=$revived")
        } catch (e: Exception) {
            Log.e(TAG, "紧急复活失败: ${e.message}")
            try { schedule(app, INTERVAL_DEAD_MS) } catch (e2: Exception) { }
        }
    }

    private fun cancelAlarm(ctx: Context) {
        try {
            val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = pendingIntent(ctx) ?: return
            am.cancel(pi)
        } catch (e: Exception) {
            Log.w(TAG, "取消闹钟失败: ${e.message}")
        }
    }

    /** 闹钟到点：体检 → 复活 → 续期 */
    fun onTick(ctx: Context) {
        val app = ctx.applicationContext
        try {
            prefs(app).edit().putLong(KEY_LAST_WAKE_AT, System.currentTimeMillis()).apply()

            // 判据是「还有没有任何功能需要保活」。微信接入与桌宠发信是两套独立开关，
            // 用理由集合表示，避免关掉其中一个把另一个也停了。
            if (!hasAnyReason(app)) {
                Log.d(TAG, "体检：已无任何保活理由，停止闹钟链")
                disarmInternal(app, "tick:no-reason")
                return
            }

            // 1) 前台服务是否活着？不活就拉起来（这一步就是「进程被清后自动复活」）
            val revived = ensureServiceRunning(app, "tick")

            // 2) 服务活着但长轮询线程掉了？一并重启（桌宠的主动发信扫描挂在同一进程上）
            if (!revived) {
                try { IlinkPoller.resumeIfWanted(app) } catch (e: Exception) { }
            }

            // 3) 续期：进程已经不在了（本次是被闹钟叫醒的）用短间隔，否则用长间隔
            val interval = if (revived) INTERVAL_DEAD_MS else INTERVAL_ARMED_MS
            schedule(app, interval)
            Log.d(TAG, "体检完成：revived=$revived reasons=[${reasonsOf(app).joinToString(",")}] " +
                "下次 ${interval / 60000} 分钟后")
        } catch (e: Exception) {
            Log.e(TAG, "体检异常: ${e.message}")
            // 出任何意外都要保证链不断，否则一次异常就永久失联
            try { schedule(app, INTERVAL_DEAD_MS) } catch (e2: Exception) { }
        }
    }

    // =========================================================================
    // 服务复活
    // =========================================================================

    /**
     * 确保前台服务在跑。返回 true 表示「本次调用真的把它拉起来了」。
     * 判断依据是 McpForegroundService.isAlive（onCreate/onDestroy 维护的进程内标志）。
     */
    fun ensureServiceRunning(ctx: Context, reason: String): Boolean {
        val app = ctx.applicationContext
        if (McpForegroundService.isAlive) return false
        val now = System.currentTimeMillis()
        if (now - lastReviveAt < REVIVE_DEBOUNCE_MS) return false
        lastReviveAt = now
        return try {
            val intent = Intent(app, McpForegroundService::class.java).apply {
                action = McpForegroundService.ACTION_KEEPALIVE_REVIVE
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(intent)
            } else {
                app.startService(intent)
            }
            prefs(app).edit()
                .putLong(KEY_REVIVE_COUNT, prefs(app).getLong(KEY_REVIVE_COUNT, 0L) + 1L)
                .apply()
            Log.w(TAG, "前台服务未在运行，已尝试拉起（$reason）")
            true
        } catch (e: Exception) {
            // Android 12+ 在「后台启动前台服务」受限时会抛 ForegroundServiceStartNotAllowedException。
            // 闹钟触发的场景属于系统豁免范围，但个别 ROM 仍会拒绝 —— 记下来，等下次闹钟再试。
            Log.e(TAG, "拉起前台服务失败（$reason）: ${e.message}")
            false
        }
    }

    // =========================================================================
    // 电池优化白名单（国产 ROM 的关键一步）
    // =========================================================================

    fun isIgnoringBatteryOptimizations(ctx: Context): Boolean {
        return try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(ctx.packageName)
        } catch (e: Exception) {
            // 老系统没有这个 API，视为不需要
            true
        }
    }

    /**
     * 申请加入电池优化白名单（会弹系统对话框，用户点「允许」即可）。
     * 只在国内 ROM 上真正影响存活率，但这个对话框在原生 Android 上也有意义。
     */
    fun requestIgnoreBatteryOptimizations(ctx: Context): Boolean {
        return try {
            if (isIgnoringBatteryOptimizations(ctx)) return true
            @SuppressLint("BatteryLife")
            val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = android.net.Uri.parse("package:" + ctx.packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            true
        } catch (e: Exception) {
            // 有些 ROM 没有这个 Activity，退回「电池优化设置页」
            return try {
                val intent = Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                ctx.startActivity(intent)
                true
            } catch (e2: Exception) {
                Log.e(TAG, "打开电池优化设置失败: ${e2.message}")
                false
            }
        }
    }

    /** 打开本应用的系统详情页：国产 ROM 的「自启动/后台运行」开关通常藏在这里 */
    fun openAppDetailSettings(ctx: Context): Boolean {
        return try {
            val intent = Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = android.net.Uri.parse("package:" + ctx.packageName)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(intent)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** 当前品牌，用于在诊断面板上给出「去哪个设置页开自启动」的具体指引 */
    fun brandHint(): String {
        val brand = (Build.BRAND ?: "").lowercase()
        val manufacturer = (Build.MANUFACTURER ?: "").lowercase()
        val s = if (brand.isNotEmpty()) brand else manufacturer
        return when {
            s.contains("xiaomi") || s.contains("redmi") || s.contains("poco") ->
                "小米/红米：设置 → 应用设置 → 应用管理 → 叙事诗小手机 → 省电策略「无限制」，并打开「自启动」"
            s.contains("huawei") || s.contains("honor") ->
                "华为/荣耀：设置 → 应用 → 应用启动管理 → 叙事诗小手机改为「手动管理」并勾选全部三项"
            s.contains("oppo") || s.contains("realme") || s.contains("oneplus") ->
                "OPPO/一加/真我：设置 → 电池 → 应用耗电管理 → 叙事诗小手机 → 允许「后台运行」与「自启动」"
            s.contains("vivo") || s.contains("iqoo") ->
                "vivo/iQOO：设置 → 电池 → 后台高耗电 → 允许叙事诗小手机；并在 i 管家 → 自启动里打开"
            s.contains("meizu") ->
                "魅族：设置 → 应用管理 → 权限管理 → 后台管理 → 允许后台运行"
            s.contains("samsung") ->
                "三星：设置 → 电池 → 后台使用限制 → 从「休眠应用」中移除叙事诗小手机"
            else ->
                "在系统设置 → 电池 → 应用耗电管理中，把叙事诗小手机设为「无限制/允许后台运行」，并允许自启动"
        }
    }

    // =========================================================================
    // 诊断
    // =========================================================================

    fun statusJson(ctx: Context): String {
        val sp = prefs(ctx)
        val alarmAt = sp.getLong(KEY_ALARM_AT, 0L)
        val now = System.currentTimeMillis()
        return try {
            org.json.JSONObject().apply {
                put("armed", sp.getBoolean(KEY_ARMED, false))
                put("reasons", org.json.JSONArray(reasonsOf(ctx).toList()))
                put("serviceAlive", McpForegroundService.isAlive)
                put("alarmAt", alarmAt)
                put("alarmInMs", if (alarmAt > now) alarmAt - now else -1L)
                put("reviveCount", sp.getLong(KEY_REVIVE_COUNT, 0L))
                put("lastWakeAt", sp.getLong(KEY_LAST_WAKE_AT, 0L))
                put("ignoringBattery", isIgnoringBatteryOptimizations(ctx))
                put("brand", Build.BRAND ?: "")
                put("brandHint", brandHint())
                put("wakeLockHeld", AndroidMcp.isWakeLockHeld())
                put("pollWakeLockHeld", IlinkPoller.isPollWakeLockHeld())
            }.toString()
        } catch (e: Exception) {
            "{}"
        }
    }
}

/**
 * 看门狗闹钟接收器。系统在 Doze 下唤醒 CPU 后调用，跑在 :main 进程里 ——
 * 如果此时进程已经被清掉，这一步就会把进程重新拉起来（这是本机制的关键）。
 */
class KeepAliveReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        try {
            val app = context.applicationContext
            when (intent?.action) {
                "com.story.phone.ACTION_KEEPALIVE_REVIVE_NOW" -> KeepAliveGuard.onEmergencyRevive(app)
                else -> KeepAliveGuard.onTick(app)
            }
        } catch (e: Exception) {
            Log.e("KeepAliveReceiver", "体检失败: ${e.message}")
        }
    }
}
