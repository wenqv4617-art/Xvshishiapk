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
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.OnnxTensor
import java.nio.LongBuffer

class AndroidMcp(private val context: Context) {

    companion object {
        private const val TAG = "AndroidMcp"
        var mainActivity: MainActivity? = null
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

    // 物理文件二进制追加流句柄，保障分批流式直写
    private var currentFileOutputStream: java.io.FileOutputStream? = null

    // 1.1 初始化真机物理分片写入流：开辟并锁定目标 ZIP 文件 (清空历史同名备份)
    @JavascriptInterface
    fun startBinaryChunkedSave(fileName: String): Boolean {
        Log.d(TAG, "startBinaryChunkedSave() called, fileName=$fileName")
        return try {
            currentFileOutputStream?.close()
            currentFileOutputStream = null

            val targetFile = File(getDownloadDir(), fileName)
            if (targetFile.exists()) {
                targetFile.delete()
            }
            // 启用 append = true 追加模式
            currentFileOutputStream = java.io.FileOutputStream(targetFile, true)
            true
        } catch (e: Exception) {
            Log.e(TAG, "startBinaryChunkedSave() failed: ${e.message}")
            e.printStackTrace()
            false
        }
    }

    // 1.2 物理追加数据分片：接收 500KB Base64 字符串，将其逆向解码为原始二进制字节流并直写磁盘 [2]
    @JavascriptInterface
    fun appendBinaryChunk(chunkBase64: String): Boolean {
        val outputStream = currentFileOutputStream ?: return false
        return try {
            val decodedBytes = android.util.Base64.decode(chunkBase64, android.util.Base64.DEFAULT)
            outputStream.write(decodedBytes)
            true
        } catch (e: Exception) {
            Log.e(TAG, "appendBinaryChunk() failed: ${e.message}")
            e.printStackTrace()
            false
        }
    }

    // 1.3 物理关闭分片写入流：刷盘固化数据，安全释放文件句柄
    @JavascriptInterface
    fun closeBinaryChunkedSave(): Boolean {
        Log.d(TAG, "closeBinaryChunkedSave() called")
        return try {
            currentFileOutputStream?.flush()
            currentFileOutputStream?.close()
            currentFileOutputStream = null
            true
        } catch (e: Exception) {
            Log.e(TAG, "closeBinaryChunkedSave() failed: ${e.message}")
            e.printStackTrace()
            false
        }
    }

    // 1.4 降级容灾直写：保留作为纯文本备份或单卡片调试导入直写
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
    private var petImageView: android.widget.ImageView? = null
    private var bubbleTextView: android.widget.TextView? = null
    private var hideBubbleRunnable: Runnable? = null

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
    //  桌面悬浮桌宠 (升级版：支持多状态复合控制、真机拖动过滤、双击跨进程反向唤醒、TextView原生冒泡)
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
                
                val density = context.resources.displayMetrics.density
                val sizePx = (sizeDp * density).toInt()

                if (floatPetView == null) {
                    // 创建复合式 FrameLayout 悬浮容器
                    val layout = android.widget.FrameLayout(context)

                    // 1. 创建气泡 TextView，采用圆角白底描边风格
                    val bubble = android.widget.TextView(context).apply {
                        visibility = android.view.View.GONE
                        setTextColor(android.graphics.Color.BLACK)
                        setPadding((12 * density).toInt(), (8 * density).toInt(), (12 * density).toInt(), (8 * density).toInt())
                        textSize = 12f
                        maxWidth = (160 * density).toInt()
                        
                        val shape = android.graphics.drawable.GradientDrawable().apply {
                            setColor(android.graphics.Color.WHITE)
                            cornerRadius = 24f
                            setStroke(2, android.graphics.Color.parseColor("#e2e8f0")) // 浅灰描边
                        }
                        background = shape
                    }
                    val bubbleParams = android.widget.FrameLayout.LayoutParams(
                        android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                        android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
                    ).apply {
                        gravity = android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL
                        bottomMargin = sizePx + (10 * density).toInt() // 居于桌宠上方
                    }
                    layout.addView(bubble, bubbleParams)
                    bubbleTextView = bubble

                    // 2. 创建图片 ImageView
                    val imageView = android.widget.ImageView(context).apply {
                        scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
                    }
                    val petParams = android.widget.FrameLayout.LayoutParams(sizePx, sizePx).apply {
                        gravity = android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL
                    }
                    layout.addView(imageView, petParams)
                    petImageView = imageView

                    val layoutParamsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        android.view.WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    } else {
                        @Suppress("DEPRECATION")
                        android.view.WindowManager.LayoutParams.TYPE_PHONE
                    }

                    val params = android.view.WindowManager.LayoutParams(
                        android.view.WindowManager.LayoutParams.WRAP_CONTENT,
                        android.view.WindowManager.LayoutParams.WRAP_CONTENT,
                        layoutParamsType,
                        android.view.WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or android.view.WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                        android.graphics.PixelFormat.TRANSLUCENT
                    ).apply {
                        gravity = android.view.Gravity.TOP or android.view.Gravity.START
                        x = 100
                        y = 500
                    }

                    // 绑定拖拽滑动与双击判定
                    bindOverlayTouchListener(layout, params, windowManager)

                    windowManager.addView(layout, params)
                    floatPetView = layout
                } else {
                    // 更新现有容器的尺寸约束
                    petImageView?.layoutParams = petImageView?.layoutParams?.apply {
                        width = sizePx
                        height = sizePx
                    }
                    bubbleTextView?.layoutParams = (bubbleTextView?.layoutParams as? android.widget.FrameLayout.LayoutParams)?.apply {
                        bottomMargin = sizePx + (10 * density).toInt()
                    }
                    floatPetView?.let {
                        windowManager.updateViewLayout(it, it.layoutParams)
                    }
                }

                // 载入并解码 Base64 图像
                val cleanBase64 = base64Str.substringAfter("base64,")
                val decodedBytes = android.util.Base64.decode(cleanBase64, android.util.Base64.DEFAULT)
                val bitmap = android.graphics.BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
                petImageView?.setImageBitmap(bitmap)

            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    // 真机物理冒泡接口 [1]
    @JavascriptInterface
    fun showDesktopPetBubble(text: String, durationMs: Long) {
        Log.d(TAG, "showDesktopPetBubble() called, text=$text, durationMs=$durationMs")
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.post {
            try {
                if (bubbleTextView == null) return@post
                bubbleTextView?.text = text
                bubbleTextView?.visibility = android.view.View.VISIBLE

                hideBubbleRunnable?.let { handler.removeCallbacks(it) }
                val runnable = Runnable {
                    bubbleTextView?.visibility = android.view.View.GONE
                }
                hideBubbleRunnable = runnable
                handler.postDelayed(runnable, durationMs)
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

                petImageView?.layoutParams = petImageView?.layoutParams?.apply {
                    width = sizePx
                    height = sizePx
                }
                bubbleTextView?.layoutParams = (bubbleTextView?.layoutParams as? android.widget.FrameLayout.LayoutParams)?.apply {
                    bottomMargin = sizePx + (10 * density).toInt()
                }

                val params = view.layoutParams as android.view.WindowManager.LayoutParams
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
                    petImageView = null
                    bubbleTextView = null
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    // 绑定物理触摸并滤除位移以解析双击
    private fun bindOverlayTouchListener(view: android.view.View, params: android.view.WindowManager.LayoutParams, windowManager: android.view.WindowManager) {
        view.setOnTouchListener(object : android.view.View.OnTouchListener {
            private var lastAction: Int = 0
            private var initialX: Int = 0
            private var initialY: Int = 0
            private var initialTouchX: Float = 0f
            private var initialTouchY: Float = 0f
            private var lastClickTime: Long = 0

            override fun onTouch(v: android.view.View?, event: android.view.MotionEvent?): Boolean {
                if (event == null) return false
                when (event.action) {
                    android.view.MotionEvent.ACTION_DOWN -> {
                        initialX = params.x
                        initialY = params.y
                        initialTouchX = event.rawX
                        initialTouchY = event.rawY
                        lastAction = event.action
                        return true
                    }
                    android.view.MotionEvent.ACTION_UP -> {
                        val diffX = event.rawX - initialTouchX
                        val diffY = event.rawY - initialTouchY
                        
                        // 位移微弱，判定为非拖拽的点击
                        if (Math.abs(diffX) < 15 && Math.abs(diffY) < 15) {
                            val clickTime = System.currentTimeMillis()
                            if (clickTime - lastClickTime < 350) {
                                onOverlayDoubleClick() // 双击执行程序唤醒 [1]
                            }
                            lastClickTime = clickTime
                        }
                        lastAction = event.action
                        return true
                    }
                    android.view.MotionEvent.ACTION_MOVE -> {
                        params.x = initialX + (event.rawX - initialTouchX).toInt()
                        params.y = initialY + (event.rawY - initialTouchY).toInt()
                        try {
                            windowManager.updateViewLayout(view, params)
                        } catch (e: Exception) {}
                        lastAction = event.action
                        return true
                    }
                }
                return false
            }
        })
    }

// 双击真机悬浮窗：直接在后台安全评估 JS，不再强制启动 Activity 调起前台 [1]
    private fun onOverlayDoubleClick() {
        Log.d(TAG, "onOverlayDoubleClick() called, executing JS quietly in background")
        try {
            mainActivity?.runOnUiThread {
                getWebView()?.evaluateJavascript(
                    "javascript:if(window.desktopPetSystem) { window.desktopPetSystem.handleDoubleClickBackground(); }",
                    null
                )
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
    // ============================================================
    //  本地向量模型推理接口 (ONNX Runtime 核心推理与高保真自愈层)
    // ============================================================

    private var ortEnv: ai.onnxruntime.OrtEnvironment? = null
    private var ortSession: ai.onnxruntime.OrtSession? = null
    private var modelFile: File? = null
    private var vocabMap: Map<String, Int>? = null

    @Synchronized
    private fun initOnnxSession() {
        if (ortSession != null) return
        try {
            ortEnv = ai.onnxruntime.OrtEnvironment.getEnvironment()
            
            val cacheModelFile = File(context.cacheDir, "model_quantized.onnx")
            if (!cacheModelFile.exists()) {
                context.assets.open("models/model_quantized.onnx").use { input ->
                    cacheModelFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
            }
            modelFile = cacheModelFile
            ortSession = ortEnv?.createSession(cacheModelFile.absolutePath)
            Log.d(TAG, "ONNX Runtime model successfully loaded from cache path.")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize ONNX session: ${e.message}", e)
        }
    }

    private fun loadVocabIfNeeded() {
        if (vocabMap != null) return
        val map = HashMap<String, Int>()
        try {
            context.assets.open("models/vocab.txt").bufferedReader().useLines { lines ->
                lines.forEachIndexed { index, line ->
                    map[line.trim()] = index
                }
            }
            vocabMap = map
            Log.d(TAG, "Successfully loaded vocabulary from assets: ${map.size} tokens.")
        } catch (e: Exception) {
            Log.d(TAG, "Vocabulary file models/vocab.txt not found in assets, using fallback hash mapping.")
        }
    }

    private fun tokenizeStringToIds(text: String): List<Int> {
        loadVocabIfNeeded()
        val ids = ArrayList<Int>()
        ids.add(101) // [CLS] token
        
        val cleanedText = text.lowercase().replace(Regex("[\\s\\p{Punct}]+"), " ")
        val words = cleanedText.split(" ").filter { it.isNotEmpty() }
        
        val vocab = vocabMap
        if (vocab != null) {
            for (word in words) {
                if (vocab.containsKey(word)) {
                    ids.add(vocab[word]!!)
                } else {
                    var temp = word
                    var foundSub = false
                    while (temp.isNotEmpty()) {
                        if (vocab.containsKey(temp)) {
                            ids.add(vocab[temp]!!)
                            foundSub = true
                            break
                        }
                        temp = temp.substring(0, temp.length - 1)
                    }
                    if (!foundSub) {
                        ids.add(100) // [UNK] token
                    }
                }
            }
        } else {
            for (word in words) {
                val id = (Math.abs(word.hashCode()) % 29000) + 1000
                ids.add(id)
            }
        }
        
        ids.add(102) // [SEP] token
        return ids
    }

    private fun extractFloatsFromNestedArray(array: Any): List<Float> {
        val result = ArrayList<Float>()
        fun recurse(item: Any) {
            if (item is FloatArray) {
                item.forEach { result.add(it) }
            } else if (item is Array<*>) {
                item.forEach { it?.let { recurse(it) } }
            }
        }
        recurse(array)
        return result
    }

    private fun performMeanPoolingAndNormalize(outputValue: Array<*>): List<Float> {
        try {
            val batch = outputValue[0] as Array<*>
            val seqLen = batch.size
            if (seqLen == 0) return emptyList()
            
            val hiddenDim = (batch[0] as FloatArray).size
            val sumVector = FloatArray(hiddenDim)
            
            for (i in 0 until seqLen) {
                val stepFeatures = batch[i] as FloatArray
                for (j in 0 until hiddenDim) {
                    sumVector[j] += stepFeatures[j]
                }
            }
            
            val meanVector = FloatArray(hiddenDim)
            for (j in 0 until hiddenDim) {
                meanVector[j] = sumVector[j] / seqLen
            }
            
            return normalizeVector(meanVector)
        } catch (e: Exception) {
            val raw = extractFloatsFromNestedArray(outputValue)
            if (raw.size >= 384) {
                return normalizeVector(raw.take(384).toFloatArray())
            }
            return raw
        }
    }

    private fun generateDeterministicSemanticVector(text: String): List<Float> {
        val dimensions = 384
        val vector = FloatArray(dimensions)
        
        val cleanedText = text.lowercase().replace(Regex("[\\s\\p{Punct}]+"), " ")
        val words = cleanedText.split(" ").filter { it.isNotEmpty() }
        
        if (words.isEmpty()) {
            val random = java.util.Random(text.hashCode().toLong())
            for (i in 0 until dimensions) {
                vector[i] = random.nextFloat() * 0.01f
            }
            return normalizeVector(vector)
        }

        for (word in words) {
            val random = java.util.Random(word.hashCode().toLong())
            for (i in 0 until dimensions) {
                val projection = (random.nextFloat() * 2.0f - 1.0f)
                vector[i] += projection
            }
        }

        for (i in 0 until text.length - 1) {
            val ngram = text.substring(i, i + 2)
            val random = java.util.Random(ngram.hashCode().toLong())
            for (j in 0 until dimensions) {
                val projection = (random.nextFloat() * 2.0f - 1.0f) * 0.3f
                vector[j] += projection
            }
        }

        return normalizeVector(vector)
    }

    private fun normalizeVector(vector: FloatArray): List<Float> {
        var sumSq = 0.0f
        for (v in vector) {
            sumSq += v * v
        }
        val norm = Math.sqrt(sumSq.toDouble()).toFloat()
        if (norm == 0.0f) {
            return vector.toList()
        }
        return vector.map { it / norm }
    }

    @JavascriptInterface
    fun testOnnxModel(): String {
        return try {
            val assetManager = context.assets
            val inputStream = assetManager.open("models/model_quantized.onnx")
            val size = inputStream.available() / 1024
            inputStream.close()
            "✅ 模型文件存在！大小: $size KB"
        } catch (e: java.io.FileNotFoundException) {
            "❌ 找不到模型文件: ${e.message}。请确保 assets/models/model_quantized.onnx 文件存在！"
        } catch (e: Exception) {
            "❌ 模型无法读取: ${e.message}"
        }
    }

    @JavascriptInterface
    fun getEmbedding(text: String): String {
        Log.d(TAG, "getEmbedding() called with text: ${text.take(50)}")
        if (text.isEmpty()) return "[]"
        
        try {
            if (ortSession == null) {
                initOnnxSession()
            }
            
            val session = ortSession
            val env = ortEnv
            
            if (session != null && env != null) {
                val inputNames = session.inputNames
                val inputs = HashMap<String, ai.onnxruntime.OnnxTensor>()
                
                if (inputNames.size == 1 && session.inputInfo[inputNames.first()]?.info?.toString()?.contains("string", true) == true) {
                    val stringInput = arrayOf(text)
                    val tensor = ai.onnxruntime.OnnxTensor.createTensor(env, stringInput)
                    inputs[inputNames.first()] = tensor
                    
                    session.run(inputs).use { results ->
                        val outputValue = results[0].value
                        if (outputValue is Array<*>) {
                            val floatArray = extractFloatsFromNestedArray(outputValue)
                            return floatArray.toString()
                        }
                    }
                } else {
                    val tokenIds = tokenizeStringToIds(text)
                    val sequenceLength = tokenIds.size
                    
                    val inputIdsArray = LongArray(sequenceLength) { tokenIds[it].toLong() }
                    val attentionMaskArray = LongArray(sequenceLength) { 1L }
                    val tokenTypeIdsArray = LongArray(sequenceLength) { 0L }
                    
                    val shape = longArrayOf(1, sequenceLength.toLong())
                    
                    inputs["input_ids"] = ai.onnxruntime.OnnxTensor.createTensor(env, java.nio.LongBuffer.wrap(inputIdsArray), shape)
                    if (inputNames.contains("attention_mask")) {
                        inputs["attention_mask"] = ai.onnxruntime.OnnxTensor.createTensor(env, java.nio.LongBuffer.wrap(attentionMaskArray), shape)
                    }
                    if (inputNames.contains("token_type_ids")) {
                        inputs["token_type_ids"] = ai.onnxruntime.OnnxTensor.createTensor(env, java.nio.LongBuffer.wrap(tokenTypeIdsArray), shape)
                    }
                    
                    session.run(inputs).use { results ->
                        val outputValue = results[0].value
                        if (outputValue is Array<*>) {
                            val floatArray = extractFloatsFromNestedArray(outputValue)
                            val finalVector = if (results[0].info.toString().contains("seq") || (outputValue.size == 1 && outputValue[0] is Array<*> && (outputValue[0] as Array<*>)[0] is FloatArray)) {
                                performMeanPoolingAndNormalize(outputValue)
                            } else {
                                floatArray
                            }
                            return finalVector.toString()
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "ONNX Runtime inference failed, falling back to deterministic semantic hashing: ${e.message}", e)
        }
        
        val fallbackVector = generateDeterministicSemanticVector(text)
        return fallbackVector.toString()
    }
}
