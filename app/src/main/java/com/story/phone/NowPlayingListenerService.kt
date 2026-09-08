package com.story.phone

import android.app.Notification
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject

/**
 * 通知监听服务：解析当前正在播放的媒体通知（歌名/歌手/来源 App）。
 * 供 MCP 面板"正在播放"板块读取，并在系统设置中开启"通知使用权"后生效。
 *
 * 兼容说明：
 * - Android 10+ 普通应用无法直接枚举其他应用的媒体会话（MEDIA_CONTENT_CONTROL 为系统权限），
 *   通知使用权（NotificationListenerService）是读取跨应用媒体信息的标准通道。
 * - 网易云/QQ音乐等会填充 EXTRA_TITLE（歌名）/ EXTRA_ARTIST（歌手）；
 *   哔哩哔哩等视频类会以 MediaStyle 通知携带标题，text 兜底解析。
 */
class NowPlayingListenerService : NotificationListenerService() {

    companion object {
        private const val TAG = "NowPlayingListener"

        /** 最近一次解析到的媒体信息（JSON 字符串），供 AndroidMcp 桥接读取 */
        @Volatile
        var currentPlaying: String? = null

        @Volatile
        var lastUpdateTs: Long = 0L

        /** 判断通知是否为媒体通知（携带媒体会话 / TRANSPORT 分类，且带标题） */
        fun isMediaNotification(n: Notification): Boolean {
            return try {
                val extras: Bundle = n.extras
                val hasSession = extras.containsKey(Notification.EXTRA_MEDIA_SESSION)
                val hasTitle = extras.containsKey(Notification.EXTRA_TITLE)
                val isTransport = n.category == Notification.CATEGORY_TRANSPORT
                // 注意：主流媒体 App（网易云/B站等）播放时都跑前台服务(FGS)，不可按 FGS 标志排除；
                // 判断靠"媒体会话 Extra / TRANSPORT 分类 + 标题"（不依赖 Notification.style，兼容性更好）
                (hasSession || isTransport) && hasTitle
            } catch (e: Exception) {
                false
            }
        }

        /** 构建媒体信息 JSON：{packageName, appName, title, artist, album, playing} */
        fun buildJson(n: Notification, packageName: String): String {
            return try {
                val extras: Bundle = n.extras
                val title = extras.getString(Notification.EXTRA_TITLE)?.takeIf { it.isNotBlank() }
                val text = extras.getString(Notification.EXTRA_TEXT)?.takeIf { it.isNotBlank() }
                val resolvedTitle = title ?: text
                // 歌手/专辑：多数媒体 App 把"歌手 · 专辑"放进 EXTRA_TEXT；与标题相同则视为无歌手信息
                val textLine = if (text != null && text != title && text != resolvedTitle) text else null
                JSONObject().apply {
                    put("packageName", packageName)
                    put("appName", appNameOf(packageName))
                    put("title", resolvedTitle ?: "")
                    put("artist", textLine ?: "")
                    put("album", "")
                    put("playing", true)
                }.toString()
            } catch (e: Exception) {
                "{\"ok\":false,\"error\":\"解析失败\"}"
            }
        }

        /** 常见媒体应用名称映射（其余直接返回包名） */
        fun appNameOf(packageName: String): String {
            return when (packageName) {
                "com.netease.cloudmusic" -> "网易云音乐"
                "com.tencent.qqmusic" -> "QQ音乐"
                "com.kugou.android" -> "酷狗音乐"
                "com.kuwo.player" -> "酷我音乐"
                "com.miui.player" -> "小米音乐"
                "com.huawei.music" -> "华为音乐"
                "com.ximalaya.ting.android" -> "喜马拉雅"
                "com.bilibili.app.in" -> "哔哩哔哩"
                "tv.danmaku.bili" -> "哔哩哔哩HD"
                "com.google.android.youtube" -> "YouTube"
                "com.spotify.music" -> "Spotify"
                "com.apple.android.music" -> "Apple Music"
                else -> packageName
            }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        sbn ?: return
        try {
            val n = sbn.notification
            if (isMediaNotification(n)) {
                currentPlaying = buildJson(n, sbn.packageName)
                lastUpdateTs = System.currentTimeMillis()
                Log.d(TAG, "媒体通知更新: $currentPlaying")
            }
        } catch (e: Exception) {
            Log.e(TAG, "解析媒体通知失败: " + e.message)
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        super.onNotificationRemoved(sbn)
        sbn ?: return
        try {
            val n = sbn.notification
            if (isMediaNotification(n)) {
                currentPlaying = null
                lastUpdateTs = System.currentTimeMillis()
                Log.d(TAG, "媒体通知移除，清空正在播放缓存")
            }
        } catch (e: Exception) {}
    }

    /**
     * 监听服务（重新）绑定成功后，立刻快照当前通知栏里的媒体通知。
     * 解决"应用进程在播放开始后才启动/重装后服务未收到新通知"导致缓存为空的问题。
     */
    override fun onListenerConnected() {
        super.onListenerConnected()
        try { snapshotNowPlaying() } catch (e: Exception) { Log.e(TAG, "onListenerConnected 快照失败: " + e.message) }
    }

    /** 主动遍历当前通知，若存在媒体通知则刷新缓存（供重绑/快照触发） */
    fun snapshotNowPlaying() {
        try {
            val list = activeNotifications ?: return
            var newest: StatusBarNotification? = null
            var newestTs = Long.MIN_VALUE
            for (sbn in list) {
                try {
                    val n = sbn.notification
                    if (n != null && isMediaNotification(n) && sbn.postTime > newestTs) {
                        newest = sbn
                        newestTs = sbn.postTime
                    }
                } catch (e: Exception) {}
            }
            if (newest != null) {
                currentPlaying = buildJson(newest.notification, newest.packageName)
                lastUpdateTs = System.currentTimeMillis()
                Log.d(TAG, "快照媒体通知: $currentPlaying")
            }
        } catch (e: Exception) {
            Log.e(TAG, "snapshotNowPlaying 异常: " + e.message)
        }
    }
}
