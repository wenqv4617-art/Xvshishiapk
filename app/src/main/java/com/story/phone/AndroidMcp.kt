package com.story.phone

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.media.MediaPlayer
import android.util.Log
import java.io.File
import java.io.FileWriter
import org.json.JSONArray
import org.json.JSONObject

class AndroidMcp(private val context: Context) {

    companion object {
        private const val TAG = "AndroidMcp"
    }

    private var mediaPlayer: MediaPlayer? = null
    private var wakeLock: android.os.PowerManager.WakeLock? = null

    @JavascriptInterface
    fun toggleBackgroundWakeLock(enabled: Boolean) {
        Log.d(TAG, "toggleBackgroundWakeLock() called, enabled=$enabled")
        try {
            val serviceIntent = Intent(context, McpForegroundService::class.java)
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            if (enabled) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
                if (wakeLock == null) {
                    wakeLock = powerManager.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "StoryPhone::BackgroundWakeLock")
                }
                if (wakeLock?.isHeld == false) {
                    wakeLock?.acquire()
                }
            } else {
                context.stopService(serviceIntent)
                if (wakeLock?.isHeld == true) {
                    wakeLock?.release()
                }
                wakeLock = null
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @JavascriptInterface
    fun showSystemNotification(title: String, message: String) {
        Log.d(TAG, "showSystemNotification() called, title=$title, message=${message.take(50)}...")
        try {
            val channelId = "story_phone_bg_channel"
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                var channel = notificationManager.getNotificationChannel(channelId)
                if (channel == null) {
                    channel = android.app.NotificationChannel(channelId, "叙事诗后台通知", android.app.NotificationManager.IMPORTANCE_HIGH).apply {
                        description = "用于接收后台聊天消息通知"
                    }
                    notificationManager.createNotificationChannel(channel)
                }
            }

            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            }
            val pendingIntent = android.app.PendingIntent.getActivity(
                context, 0, intent,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                } else {
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT
                }
            )

            val notification = androidx.core.app.NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .build()

            notificationManager.notify(System.currentTimeMillis().toInt(), notification)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 初始化时自动创建本地物理存储文件夹：/Download/Storypoem 与 /Music/Storypoem
    init {
        try {
            getDownloadDir()
            getMusicDir()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun getDownloadDir(): File {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Storypoem")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun getMusicDir(): File {
        val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC), "Storypoem")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    // 1. 物理数据导出直写至真机：/Download/Storypoem/
    @JavascriptInterface
    fun saveBackupFile(jsonString: String, fileName: String): Boolean {
        Log.d(TAG, "saveBackupFile() called, fileName=$fileName, data.length=${jsonString.length}")
        return try {
            val targetFile = File(getDownloadDir(), fileName)
            val writer = FileWriter(targetFile)
            writer.write(jsonString)
            writer.close()
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    // 2. 静默读取真机 /Music/Storypoem 目录下的本地歌单列表
    @JavascriptInterface
    fun scanLocalMusicFolder(): String {
        Log.d(TAG, "scanLocalMusicFolder() called")
        val jsonArray = JSONArray()
        try {
            val musicDir = getMusicDir()
            val files = musicDir.listFiles { _, name ->
                name.endsWith(".mp3", true) || name.endsWith(".wav", true) || name.endsWith(".m4a", true)
            }
            files?.forEach { file ->
                jsonArray.put(file.name)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
        return jsonArray.toString()
    }

    // 3. Android 原生 MediaPlayer 后台音乐播放器
    @JavascriptInterface
    fun playNativeMusic(songName: String): Boolean {
        Log.d(TAG, "playNativeMusic() called, songName=$songName")
        return try {
            val musicFile = File(getMusicDir(), songName)
            if (!musicFile.exists()) return false

            mediaPlayer?.release()
            mediaPlayer = MediaPlayer().apply {
                setDataSource(musicFile.absolutePath)
                isLooping = true
                prepare()
                start()
            }
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    @JavascriptInterface
    fun pauseNativeMusic() {
        Log.d(TAG, "pauseNativeMusic() called")
        try {
            if (mediaPlayer?.isPlaying == true) {
                mediaPlayer?.pause()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @JavascriptInterface
    fun stopNativeMusic() {
        Log.d(TAG, "stopNativeMusic() called")
        try {
            mediaPlayer?.stop()
            mediaPlayer?.release()
            mediaPlayer = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 4. 安卓真机马达物理震动桥接
    @JavascriptInterface
    fun triggerHardwareVibrator(milliseconds: Long) {
        Log.d(TAG, "triggerHardwareVibrator() called, milliseconds=$milliseconds")
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vibratorManager.defaultVibrator.vibrate(VibrationEffect.createOneShot(milliseconds, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                vibrator.vibrate(VibrationEffect.createOneShot(milliseconds, VibrationEffect.DEFAULT_AMPLITUDE))
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 5. 调起系统通知监听设置页
    @JavascriptInterface
    fun requestNotificationPermission() {
        Log.d(TAG, "requestNotificationPermission() called")
        try {
            val intent = Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 6. 调起安卓系统无障碍辅助设置页
    @JavascriptInterface
    fun requestAccessibilityPermission() {
        Log.d(TAG, "requestAccessibilityPermission() called")
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 7. 原生写入真机物理闹钟
    @JavascriptInterface
    fun setAndroidSystemAlarm(hour: Int, minute: Int, message: String) {
        Log.d(TAG, "setAndroidSystemAlarm() called, hour=$hour, minute=$minute, message=$message")
        try {
            val intent = Intent(android.provider.AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(android.provider.AlarmClock.EXTRA_HOUR, hour)
                putExtra(android.provider.AlarmClock.EXTRA_MINUTES, minute)
                putExtra(android.provider.AlarmClock.EXTRA_MESSAGE, message)
                putExtra(android.provider.AlarmClock.EXTRA_SKIP_UI, true)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun getWebView(): android.webkit.WebView? {
        return (context as? MainActivity)?.findViewById(R.id.webview)
    }

    private var bgPollTimer: java.util.Timer? = null
    private var floatPetView: android.view.View? = null

    // ============================================================
    //  后台主动发信 — Kotlin 层直接发 HTTP 请求（绕过 WebView 冻结）
    // ============================================================

    // 存储前端注册的 API 配置
    private var bgApiUrl: String = ""
    private var bgApiKey: String = ""
    private var bgApiModel: String = ""

    // 待发送消息队列（线程安全）
    private val pendingMessages = mutableListOf<String>()
    private var bgSendInProgress = false

    // 后台发信结果暂存
    private var lastBgResultJson: String? = null

    /**
     * 前端注册 API 配置到 Kotlin 层（由 toggleActiveMessage 调用）
     */
    @JavascriptInterface
    fun registerBgApiConfig(url: String, key: String, model: String, temperature: Double) {
        Log.d(TAG, "registerBgApiConfig() called, url=$url, key=${key.take(8)}..., model=$model, temperature=$temperature")
        try {
            bgApiUrl = url
            bgApiKey = key
            bgApiModel = model
            Log.d(TAG, "registerBgApiConfig() success, bgApiUrl=$bgApiUrl, bgApiModel=$bgApiModel")
        } catch (e: Exception) {
            Log.e(TAG, "registerBgApiConfig() error: ${e.message}", e)
            e.printStackTrace()
        }
    }

    /**
     * 前端推送一条待发送消息到 Kotlin 队列
     */
    @JavascriptInterface
    fun pushBgMessage(message: String) {
        Log.d(TAG, "pushBgMessage() called, message=${message.take(50)}...")
        synchronized(pendingMessages) {
            pendingMessages.add(message)
            Log.d(TAG, "pushBgMessage() success, pending count=${pendingMessages.size}")
        }
    }

    /**
     * 前端查询待发送队列长度
     */
    @JavascriptInterface
    fun getBgPendingCount(): Int {
        synchronized(pendingMessages) {
            val count = pendingMessages.size
            Log.d(TAG, "getBgPendingCount() called, returning $count")
            return count
        }
    }

    /**
     * 前端消费（拉取）后台发信结果，返回后自动清空
     */
    @JavascriptInterface
    fun pollBgResult(): String? {
        val result = lastBgResultJson
        lastBgResultJson = null
        Log.d(TAG, "pollBgResult() called, returning=${result?.take(80)}...")
        return result
    }

    /**
     * 启动后台轮询发信（定时器在 Kotlin 层直接发 HTTP，不依赖 WebView）
     */
    @JavascriptInterface
    fun startBackgroundPolling(intervalMinutes: Int) {
        Log.d(TAG, "startBackgroundPolling() called, intervalMinutes=$intervalMinutes")
        try {
            stopBackgroundPolling()
            bgPollTimer = java.util.Timer().apply {
                scheduleAtFixedRate(object : java.util.TimerTask() {
                    override fun run() {
                        // 如果没有待发消息或正在发送，跳过本轮
                        val message: String
                        synchronized(pendingMessages) {
                            if (pendingMessages.isEmpty() || bgSendInProgress) return
                            message = pendingMessages.removeFirst()
                            bgSendInProgress = true
                        }

                        try {
                            // 检查 API 配置是否已注册
                            val apiUrl = bgApiUrl
                            val apiKey = bgApiKey
                            val apiModel = bgApiModel
                            if (apiUrl.isEmpty() || apiKey.isEmpty()) {
                                storeBgResult(400, "{\"error\":\"API 配置未注册，请先在 MCP 面板开启后台主动发信\"}")
                                return
                            }

                            // 构造请求体：兼容 OpenAI 格式
                            val requestBody = JSONObject().apply {
                                put("model", apiModel)
                                put("messages", JSONArray().apply {
                                    put(JSONObject().apply {
                                        put("role", "user")
                                        put("content", message)
                                    })
                                })
                                put("stream", false)
                            }

                            // Kotlin 层直接用 HttpURLConnection 发请求
                            val conn = java.net.URL(apiUrl).openConnection() as java.net.HttpURLConnection
                            try {
                                conn.requestMethod = "POST"
                                conn.setRequestProperty("Content-Type", "application/json")
                                conn.setRequestProperty("Authorization", "Bearer $apiKey")
                                conn.doOutput = true
                                conn.connectTimeout = 15000
                                conn.readTimeout = 60000

                                conn.outputStream.use { os ->
                                    os.write(requestBody.toString().toByteArray(Charsets.UTF_8))
                                }

                                val responseCode = conn.responseCode
                                val responseBody = if (responseCode in 200..299) {
                                    conn.inputStream.bufferedReader(Charsets.UTF_8).readText()
                                } else {
                                    val errorBody = conn.errorStream?.bufferedReader(Charsets.UTF_8)?.readText() ?: ""
                                    "{\"error\":\"HTTP $responseCode\",\"body\":${JSONObject.quote(errorBody)}}"
                                }

                                storeBgResult(responseCode, responseBody)
                            } finally {
                                conn.disconnect()
                            }
                        } catch (e: Exception) {
                            storeBgResult(0, "{\"error\":${JSONObject.quote(e.message ?: e.toString())}}")
                            e.printStackTrace()
                        } finally {
                            synchronized(pendingMessages) {
                                bgSendInProgress = false
                            }
                        }
                    }
                }, intervalMinutes * 60 * 1000L, intervalMinutes * 60 * 1000L)
            }
            // 存入标记供前端拉取
            storeBgResult(0, "{\"info\":\"background_polling_started\",\"interval_minutes\":$intervalMinutes}")
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @JavascriptInterface
    fun stopBackgroundPolling() {
        Log.d(TAG, "stopBackgroundPolling() called")
        try {
            bgPollTimer?.cancel()
            bgPollTimer = null
            synchronized(pendingMessages) {
                bgSendInProgress = false
            }
            storeBgResult(0, "{\"info\":\"background_polling_stopped\"}")
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun storeBgResult(code: Int, bodyJson: String) {
        lastBgResultJson = JSONObject().apply {
            put("code", code)
            put("body", bodyJson)
            put("timestamp", System.currentTimeMillis())
        }.toString()
    }

    // ============================================================
    //  桌面悬浮桌宠
    // ============================================================

    @JavascriptInterface
    fun checkOverlayPermission(): Boolean {
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Settings.canDrawOverlays(context)
        } else {
            true
        }
        Log.d(TAG, "checkOverlayPermission() called, returning $result")
        return result
    }

    @JavascriptInterface
    fun requestOverlayPermission() {
        Log.d(TAG, "requestOverlayPermission() called")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                data = android.net.Uri.parse("package:${context.packageName}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        }
    }

    @JavascriptInterface
    fun showDesktopPet(base64Str: String, sizeDp: Int) {
        Log.d(TAG, "showDesktopPet() called, sizeDp=$sizeDp, base64.length=${base64Str.length}")
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.post {
            try {
                val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
                
                if (floatPetView != null) {
                    try {
                        windowManager.removeView(floatPetView)
                    } catch (e: Exception) {}
                    floatPetView = null
                }

                val imageView = android.widget.ImageView(context)
                imageView.scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                
                val cleanBase64 = base64Str.substringAfter("base64,")
                val decodedBytes = android.util.Base64.decode(cleanBase64, android.util.Base64.DEFAULT)
                val bitmap = android.graphics.BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
                imageView.setImageBitmap(bitmap)

                val layoutParamsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                } else {
                    @Suppress("DEPRECATION")
                    android.view.WindowManager.LayoutParams.TYPE_PHONE
                }

                val density = context.resources.displayMetrics.density
                val sizePx = (sizeDp * density).toInt()

                val params = android.view.WindowManager.LayoutParams(
                    sizePx,
                    sizePx,
                    layoutParamsType,
                    android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    android.graphics.PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = android.view.Gravity.TOP or android.view.Gravity.START
                    x = 100
                    y = 100
                }

                imageView.setOnTouchListener(object : android.view.View.OnTouchListener {
                    private var initialX = 0
                    private var initialY = 0
                    private var initialTouchX = 0f
                    private var initialTouchY = 0f

                    override fun onTouch(v: android.view.View?, event: android.view.MotionEvent?): Boolean {
                        if (event == null) return false
                        when (event.action) {
                            android.view.MotionEvent.ACTION_DOWN -> {
                                initialX = params.x
                                initialY = params.y
                                initialTouchX = event.rawX
                                initialTouchY = event.rawY
                                return true
                            }
                            android.view.MotionEvent.ACTION_MOVE -> {
                                params.x = initialX + (event.rawX - initialTouchX).toInt()
                                params.y = initialY + (event.rawY - initialTouchY).toInt()
                                try {
                                    windowManager.updateViewLayout(imageView, params)
                                } catch (e: Exception) {}
                                return true
                            }
                        }
                        return false
                    }
                })

                windowManager.addView(imageView, params)
                floatPetView = imageView
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    @JavascriptInterface
    fun updateDesktopPetSize(sizeDp: Int) {
        Log.d(TAG, "updateDesktopPetSize() called, sizeDp=$sizeDp")
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.post {
            try {
                val view = floatPetView ?: return@post
                val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
                val density = context.resources.displayMetrics.density
                val sizePx = (sizeDp * density).toInt()

                val params = view.layoutParams as android.view.WindowManager.LayoutParams
                params.width = sizePx
                params.height = sizePx
                windowManager.updateViewLayout(view, params)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    @JavascriptInterface
    fun hideDesktopPet() {
        Log.d(TAG, "hideDesktopPet() called")
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.post {
            try {
                if (floatPetView != null) {
                    val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
                    windowManager.removeView(floatPetView)
                    floatPetView = null
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }
}
