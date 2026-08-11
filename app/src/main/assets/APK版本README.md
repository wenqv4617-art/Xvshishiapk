# 叙事诗小手机 开发与安卓 APK 特权架构参考手册 (2026年解耦特权版)

本手册是“叙事诗小手机”系统的核心开发和维护指南。本系统是一个通过 **Android Native Shell (Kotlin) + Core Web View (HTML5)** 混合开发（Hybrid）封装而成的真机级 **Android 原生特权 App**。项目前端采用 **HTML5 + CSS3 + 纯原生 JavaScript** 构建，底层依赖 **Dexie.js (IndexedDB)** 保证数据的事务级持久化，并利用 **Model Context Protocol (MCP)** 硬件级联动协议打破沙箱，实现了真机定位、实时气象、物理马达震动、系统物理闹钟直写、本地歌单后台锁屏放歌、本地大二进制文件极速导入、伴读自愈性文本编码解析以及数据一键本地物理导出等深度系统级特权功能。

---

## 目录
1. **PWA 混合 App 物理目录结构**
2. **核心配置文件及底端 Kotlin 代码全文汇编**
   - 2.1 `.github/workflows/build-apk.yml` (自动云打包)
   - 2.2 `settings.gradle.kts` (多模块注册)
   - 2.3 `build.gradle.kts` (根项目编译)
   - 2.4 `app/build.gradle.kts` (应用模块编译)
   - 2.5 `app/proguard-rules.pro` (混淆保护白名单)
   - 2.6 `app/src/main/AndroidManifest.xml` (系统高特权清单)
   - 2.7 `app/src/main/res/layout/activity_main.xml` (视图布局)
   - 2.8 `app/src/main/java/com/story/phone/MainActivity.kt` (主 Activity 容器)
   - 2.9 `app/src/main/java/com/story/phone/AndroidMcp.kt` (高特权原生接口)
3. **Dexie 数据库设计规范 (Version 12 综合升级版)**
4. **悬浮多状态桌宠与真机系统级交互机制**
   - 4.1 角色跟随与配置隔离 (IndexedDB 状态存储)
   - 4.2 桌宠 9 种多动作状态定义
   - 4.3 自定义对话模式 (台词加权随机)
   - 4.4 实时生成模式 (大模型动作控制)
   - 4.5 真机系统级双击手势与跨进程反向唤醒
5. **JS 独立高精度后台定时发信调度引擎**
   - 5.1 WebView 后台冷冻局限与保活心跳
   - 5.2 独立发信时间片轮询算法
   - 5.3 携带世界书与长 RAG 记忆的高质量后台 Prompt 编译
   - 5.4 联动真机通知与桌面冒泡的气泡可视链
6. **网页/原生避让与防区双生桌宠消减机制**
   - 6.1 “双生桌宠”视觉重叠痛点
   - 6.2 网页 DOM 节点物理级拦截与销毁
7. **长周期记忆、深谈空间与协同组件剖析**
   - 7.1 会话总结与长久记忆库 (`app_summary_memory.js`)
   - 7.2 深度对话剖析空间 (`app_deeptalk.js`)
   - 7.3 HTML 互动舱生成与安全沙盘 (`app_chat_html_widget.js` & `chat_html.css`)
   - 7.4 主线剧情引导引擎 (`app_chat_plot_engine.js`)
   - 7.5 沉浸式旋转专注中枢与伴随音频流（`app_chat_focus.js` & `focus.css`）
   - 7.6 自闭环 AI 伴读书城与多编码自愈引擎（`app_reader.js` & `reader.css`）
8. **无限拓展开发蓝图 (Where & How to Add Features)**

---

## 1. PWA 混合 App 物理目录结构

请确保您本地的仓库目录结构与下方结构保持一致。所有前端网页资产、图标、音频等文件，必须存放在 `app/src/main/assets/` 路径下，以便打包进 APK 资源内部。

```text
(您的项目根目录)
├── .github/
│   └── workflows/
│       └── build-apk.yml           # GitHub Actions 自动云打包配置文件
├── app/
│   ├── src/
│   │   └── main/
│   │       ├── assets/             # 📂 放入当前所有的前端平铺资源文件
│   │       │   ├── index.html
│   │       │   ├── style.css
│   │       │   ├── app_chat.js
│   │       │   ├── app_desktop_pet.js # 🧸 升级版独立多状态悬浮桌宠逻辑
│   │       │   ├── desktop_pet.css    # 🎨 悬浮桌宠与真机仿真气泡样式
│   │       │   ├── app_chat_mcp.js    # MCP 物理联动前端逻辑
│   │       │   ├── app_chat_focus.js  # 专注空间物理控制中枢
│   │       │   ├── focus.css          # 专注简美玻璃磨砂样式
│   │       │   ├── app_reader.js      # 独立自闭环阅读书城应用
│   │       │   ├── reader.css         # 书城多端自适应布局样式
│   │       │   └── (其他所有的前端资源：.js, .css, .json, .png等)
│   │       ├── java/com/story/phone/
│   │       │   ├── MainActivity.kt        # 安卓原生主 Activity 代码
│   │       │   └── AndroidMcp.kt          # 安卓原生高特权接口桥接代码
│   │       ├── res/
│   │       │   ├── drawable/
│   │       │   │   └── ic_launcher.png    # 桌面自定义正方形 PNG 图标
│   │       │   └── layout/
│   │       │       └── activity_main.xml  # 安卓界面 WebView 视图布局
│   │       └── AndroidManifest.xml        # 安卓系统功能清单
│   ├── build.gradle.kts                               # App 编译配置脚本
│   └── proguard-rules.pro                             # 混淆器防剥离规则
├── build.gradle.kts                                   # 根项目编译脚本
└── settings.gradle.kts                                 # 项目根设置
```

---

## 2. 核心配置文件及底端 Kotlin 代码全文汇编

### 2.1 云端自动化签名打包管线：`.github/workflows/build-apk.yml`
```yaml
name: Generate Android APK

on:
  push:
    branches:
      - main
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout Source Code
        uses: actions/checkout@v4

      - name: Set up JDK 17
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '17'

      # 通过锁定并持久化缓存 ~/.android 密钥目录，确保后续编译的所有 APK 共享同一个数字证书，避免真机覆盖安装时的数字证书冲突
      - name: Cache Android Keystore
        uses: actions/cache@v4
        with:
          path: ~/.android
          key: ${{ runner.os }}-android-keystore

      - name: Setup Gradle
        uses: gradle/actions/setup-gradle@v4
        with:
          gradle-version: 8.5 # 自动在云端加载 Gradle 8.5

      - name: Build APK with Gradle
        run: gradle assembleDebug

      - name: Upload APK
        uses: actions/upload-artifact@v4
        with:
          name: StoryPhone-Android-APK
          path: app/build/outputs/apk/debug/app-debug.apk
```

### 2.2 项目根设置：`settings.gradle.kts`
```kotlin
rootProject.name = "StoryPhone"
include(":app")
```

### 2.3 根项目编译脚本：`build.gradle.kts` (根目录级别)
```kotlin
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.2.2")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.22")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}
```

### 2.4 子模块编译配置：`app/build.gradle.kts`
```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.story.phone"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.story.phone"
        minSdk = 26 // 安卓 8.0，保障完美兼容通知监听、硬件马达与无障碍接口
        targetSdk = 34
        versionCode = 3
        versionName = "1.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.webkit:webkit:1.10.0")
}
```

### 2.5 代码混淆白名单规则：`app/proguard-rules.pro`
```proguard
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.story.phone.AndroidMcp { *; }
```

### 2.6 物理系统配置文件：`app/src/main/AndroidManifest.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!-- 申请真机振动、GPS定位、闹钟、通知监听、后台锁屏唤醒、上层悬浮窗等安卓硬件权限 -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.SET_ALARM" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    
    <!-- 读写外部存储权限 (支持高低安卓版本兼容，打通物理存储扫歌与导出) -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />

    <application
        android:allowBackup="false"
        android:icon="@drawable/ic_launcher"
        android:label="叙事诗小手机"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppCompat.Light.NoActionBar"
        android:usesCleartextTraffic="true"
        android:requestLegacyExternalStorage="true">
        
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:screenOrientation="portrait"
            android:configChanges="orientation|screenSize"
            android:theme="@style/Theme.AppCompat.Light.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

    </application>

</manifest>
```

### 2.7 安卓界面 WebView 视图布局：`app/src/main/res/layout/activity_main.xml`
```xml
<?xml version="1.0" encoding="utf-8"?>
<FrameLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent">

    <android.webkit.WebView
        android:id="@+id/webview"
        android:layout_width="match_parent"
        android:layout_height="match_parent" />

</FrameLayout>
```

### 2.8 窗口容器生命周期控制：`app/src/main/java/com/story/phone/MainActivity.kt`
```kotlin
package com.story.phone

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fileUploadCallback: ValueCallback<Array<Uri>>? = null
    private val FILE_CHOOSER_RESULT_CODE = 101
    private val PERMISSIONS_REQUEST_CODE = 102

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        
        webView.webViewClient = object : WebViewClient() {
            @Suppress("DEPRECATION")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return false
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: android.webkit.WebResourceRequest?
            ): Boolean {
                return false
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, true, false)
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                @Suppress("UNCHECKED_CAST")
                (fileUploadCallback as? ValueCallback<Array<Uri>?>)?.onReceiveValue(null)
                fileUploadCallback = filePathCallback

                val intent = fileChooserParams?.createIntent() ?: return false
                try {
                    startActivityForResult(intent, FILE_CHOOSER_RESULT_CODE)
                } catch (e: ActivityNotFoundException) {
                    fileUploadCallback = null
                    return false
                }
                return true
            }
        }

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.geolocationEnabled = true

        // 禁用媒体播放必须物理手势触发的限制，彻底解锁 AI 在后台静默自动播放歌曲的特权！
        settings.mediaPlaybackRequiresUserGesture = false

        // 注入 window.AndroidMCP 原生接口并注册主 Activity 句柄，支持后台双击跨端唤醒
        AndroidMcp.mainActivity = this
        webView.addJavascriptInterface(AndroidMcp(this), "AndroidMCP")

        webView.loadUrl("file:///android_asset/index.html")

        requestAppPermissions()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == FILE_CHOOSER_RESULT_CODE) {
            if (fileUploadCallback == null) return
            val results = WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            
            @Suppress("UNCHECKED_CAST")
            (fileUploadCallback as? ValueCallback<Array<Uri>?>)?.onReceiveValue(results)
            fileUploadCallback = null
        }
    }

    private fun requestAppPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
            permissions.add(Manifest.permission.READ_MEDIA_AUDIO)
        } else {
            @Suppress("DEPRECATION")
            permissions.add(Manifest.permission.READ_EXTERNAL_STORAGE)
            @Suppress("DEPRECATION")
            permissions.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }

        val listToRequest = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (listToRequest.isNotEmpty()) {
            ActivityCompat.requestPermissions(
                this,
                listToRequest.toTypedArray(),
                PERMISSIONS_REQUEST_CODE
            )
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
```

### 2.9 原生特权硬件接口：`app/src/main/java/com/story/phone/AndroidMcp.kt`
```kotlin
package com.story.phone

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.widget.ImageView
import android.widget.TextView
import android.util.Base64
import android.graphics.BitmapFactory
import android.os.Environment
import android.media.MediaPlayer
import android.util.Log
import java.io.File
import java.io.FileWriter
import org.json.JSONArray
import org.json.JSONObject

class AndroidMcp(private val context: Context) {

    companion object {
        private const val TAG = "AndroidMcp"
        var mainActivity: MainActivity? = null
    }

    private var mediaPlayer: MediaPlayer? = null
    private var wakeLock: android.os.PowerManager.WakeLock? = null
    private var bgPollTimer: java.util.Timer? = null
    
    // 悬浮窗原生节点引用
    private var floatPetView: View? = null
    private var petImageView: ImageView? = null
    private var bubbleTextView: TextView? = null
    private var hideBubbleRunnable: Runnable? = null

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

    private fun getWebView(): WebView? {
        return (context as? MainActivity)?.findViewById(R.id.webview)
    }

    // ============================================================
    //  悬浮窗特权检查与系统申请
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

    // ============================================================
    //  真机系统级悬浮复合窗（带 TextView 原生气泡、双击手势、不退焦静默交互）
    // ============================================================

    @JavascriptInterface
    fun showDesktopPet(base64Str: String, sizeDp: Int) {
        Log.d(TAG, "showDesktopPet() called, sizeDp=$sizeDp, base64.length=${base64Str.length}")
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            try {
                val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val density = context.resources.displayMetrics.density
                val sizePx = (sizeDp * density).toInt()

                if (floatPetView == null) {
                    val layout = android.widget.FrameLayout(context)

                    // 1. 动态构建白底圆角描边的系统气泡 TextView
                    val bubble = TextView(context).apply {
                        visibility = View.GONE
                        setTextColor(android.graphics.Color.BLACK)
                        setPadding((12 * density).toInt(), (8 * density).toInt(), (12 * density).toInt(), (8 * density).toInt())
                        textSize = 12f
                        maxWidth = (160 * density).toInt()
                        
                        val shape = android.graphics.drawable.GradientDrawable().apply {
                            setColor(android.graphics.Color.WHITE)
                            cornerRadius = 24f
                            setStroke(2, android.graphics.Color.parseColor("#e2e8f0"))
                        }
                        background = shape
                    }
                    val bubbleParams = android.widget.FrameLayout.LayoutParams(
                        android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                        android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
                    ).apply {
                        gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                        bottomMargin = sizePx + (10 * density).toInt()
                    }
                    layout.addView(bubble, bubbleParams)
                    bubbleTextView = bubble

                    // 2. 动态构建桌宠 ImageView
                    val imageView = ImageView(context).apply {
                        scaleType = ImageView.ScaleType.FIT_CENTER
                    }
                    val petParams = android.widget.FrameLayout.LayoutParams(sizePx, sizePx).apply {
                        gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                    }
                    layout.addView(imageView, petParams)
                    petImageView = imageView

                    val layoutParamsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    } else {
                        @Suppress("DEPRECATION")
                        WindowManager.LayoutParams.TYPE_PHONE
                    }

                    val params = WindowManager.LayoutParams(
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        WindowManager.LayoutParams.WRAP_CONTENT,
                        layoutParamsType,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                        PixelFormat.TRANSLUCENT
                    ).apply {
                        gravity = Gravity.TOP or Gravity.START
                        x = 100
                        y = 500
                    }

                    // 绑定高动态滑动拖动与双击探测
                    bindOverlayTouchListener(layout, params, windowManager)

                    windowManager.addView(layout, params)
                    floatPetView = layout
                } else {
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

                val cleanBase64 = base64Str.substringAfter("base64,")
                val decodedBytes = android.util.Base64.decode(cleanBase64, android.util.Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(decodedBytes, 0, decodedBytes.size)
                petImageView?.setImageBitmap(bitmap)

            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    @JavascriptInterface
    fun showDesktopPetBubble(text: String, durationMs: Long) {
        Log.d(TAG, "showDesktopPetBubble() called, text=$text, durationMs=$durationMs")
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            try {
                if (bubbleTextView == null) return@post
                bubbleTextView?.text = text
                bubbleTextView?.visibility = View.VISIBLE

                hideBubbleRunnable?.let { handler.removeCallbacks(it) }
                val runnable = Runnable {
                    bubbleTextView?.visibility = View.GONE
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
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            try {
                val view = floatPetView ?: return@post
                val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
                val density = context.resources.displayMetrics.density
                val sizePx = (sizeDp * density).toInt()

                petImageView?.layoutParams = petImageView?.layoutParams?.apply {
                    width = sizePx
                    height = sizePx
                }
                bubbleTextView?.layoutParams = (bubbleTextView?.layoutParams as? android.widget.FrameLayout.LayoutParams)?.apply {
                    bottomMargin = sizePx + (10 * density).toInt()
                }

                val params = view.layoutParams as WindowManager.LayoutParams
                windowManager.updateViewLayout(view, params)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    @JavascriptInterface
    fun hideDesktopPet() {
        Log.d(TAG, "hideDesktopPet() called")
        val handler = Handler(Looper.getMainLooper())
        handler.post {
            try {
                if (floatPetView != null) {
                    val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
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

    private fun bindOverlayTouchListener(view: View, params: WindowManager.LayoutParams, windowManager: WindowManager) {
        view.setOnTouchListener(object : View.OnTouchListener {
            private var lastAction: Int = 0
            private var initialX: Int = 0
            private var initialY: Int = 0
            private var initialTouchX: Float = 0f
            private var initialTouchY: Float = 0f
            private var lastClickTime: Long = 0

            override fun onTouch(v: View, event: MotionEvent?): Boolean {
                if (event == null) return false
                when (event.action) {
                    MotionEvent.ACTION_DOWN -> {
                        initialX = params.x
                        initialY = params.y
                        initialTouchX = event.rawX
                        initialTouchY = event.rawY
                        lastAction = event.action
                        return true
                    }
                    MotionEvent.ACTION_UP -> {
                        val diffX = event.rawX - initialTouchX
                        val diffY = event.rawY - initialTouchY
                        
                        if (Math.abs(diffX) < 15 && Math.abs(diffY) < 15) {
                            val clickTime = System.currentTimeMillis()
                            if (clickTime - lastClickTime < 350) {
                                onOverlayDoubleClick() // 双击执行跨进程程序后台安全评价 JS
                            }
                            lastClickTime = clickTime
                        }
                        lastAction = event.action
                        return true
                    }
                    MotionEvent.ACTION_MOVE -> {
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
}
```

---

## 3. Dexie 数据库设计规范 (Version 12 综合升级版)

系统数据库包含 24 张物理表。为了在打通**独立多状态悬浮桌宠**与**自动发信解耦控制**的同时，无缝支撑全新的**“自闭环 AI 伴读书城”**、**“刻度转盘专注时空”**配置，数据库全量对齐至 **Version 12**。

```javascript
db.version(12).stores({
  // 1. 大模型 API 预设表
  api_presets: 'id++, name, protocol, url, key, model, temperature',

  // 2. 档案表 (包含角色、用户、NPC 分区)
  archives: 'id++, type, name, avatar, remark, group, persona, parentId', 

  // 3. 社会关系映射表 (连接 character 与 user)
  relations: 'id++, fromId, toId, relation',

  // 4. 会话配置与偏好设置表 (包含伴随环境音 focusAmbientSounds 数组等隐式扩展属性)
  sessions: 'id++, userId, charId, customCharName, customCharAvatar, customCharPersona, customUserAvatar, customUserPersona, lastMessageTime, mountedEntryIds, offlineMinWordCount, offlineMaxWordCount, offlineAutoSummaryCount, offlineMountedEntryIds, stickerMountedGroupIds, autoSummaryToggle, autoSummaryInterval, bufferRounds, summarySystemPrompt, coreSelfStatus, coreSelfPurpose, coreSelfChanges, coreRelationship, coreUserInEyes',

  // 5. 线上对话消息全纪录表
  messages: 'id++, sessionId, senderType, senderId, content, contentType, timestamp, isBlocked, isFavorite',

  // 6. 世界书词条库
  world_book_entries: 'id++, group, title, content, depth, isActive',

  // 7. 线下剧场实例表
  theaters: 'id++, sessionId, name, scenario, minWordCount, maxWordCount, carryMemory, createdAt',

  // 8. 线下段落卡片流表
  offline_messages: 'id++, theaterId, sessionId, isTheater, senderType, content, timestamp, isFavorite',

  // 9. 窥秘内心状态变化切片历史表
  status_history: 'id++, sessionId, theaterId, isTheater, timestamp, attire, affection, excitement, thoughts, hiddenCorners',

  // 10. 表情包分组表
  sticker_groups: 'id++, name, sortOrder',

  // 11. 表情包单条数据表 (imageUrl 支持 Base64 二进制)
  sticker_items: 'id++, groupId, sortOrder, imageUrl, caption',

  // 12. 阶段性会话总结记录表
  summaries: 'id++, sessionId, startRound, endRound, content, keywords, source, timestamp',

  // 13. 深谈记录主表
  deeptalks: 'id++, sessionId, userId, charId, topic, status, createdAt',

  // 14. 深谈消息内容表
  deeptalk_messages: 'id++, deeptalkId, senderType, timestamp',

  // 15. 思想小宇宙闪念切片表
  deeptalk_thoughts: 'id++, deeptalkId, sessionId, timestamp',

  // 16. 全局深谈附加提示词预设表
  deeptalk_presets: 'id++, name',

  // 17. 朋友圈系统主动态表
  moments: 'id++, userId, senderType, senderId, timestamp',

  // 18. 朋友圈评论与点赞表
  moment_comments: 'id++, momentId, senderType, senderId, timestamp',

  // 19. 朋友圈时间流与巡航控制表
  moment_settings: 'id++, userId',

  // 20. HTML 互动卡片存储表
  html_cards: 'id++, sessionId, timestamp',

  // 21. === 独立悬浮多状态桌宠存储表 ===
  desktop_pets: 'charId, mode',

  // 22. === 阅读书城主书本表 (新增) ===
  reader_books: 'id++, title, author, summary, coverUrl, isImported, fileType, currentChapterId, collected',

  // 23. === 书城定制章节表 (新增) ===
  reader_chapters: 'id++, bookId, chapterNum, [bookId+chapterNum]',

  // 24. === 书籍分类个性标签表 (新增) ===
  reader_tags: 'id++, name',

  // 25. === 智能写书提示词模板预设表 (新增) ===
  reader_presets: 'id++, name, prompt'
});
```

### Version 27 增补表：情侣空间·悄悄话话题会话与归档机制（v3.2 新增）

当前最新结构已迭代至 **Version 27**，主要新增了情侣空间·悄悄话话题会话与归档机制相关表：

```javascript
db.version(27).stores({
  // couples_whispers 增补 topicId / archived 索引（不丢旧数据，仅扩展索引）
  couples_whispers: 'id++, charId, timestamp, topicId, archived',

  // 新增：每个话题会话的元信息
  couples_whisper_topics: 'id++, charId, meId, startTime, endTime, archived, topicTitle'
});
```

**`couples_whisper_topics` 字段说明：** `charId`/`meId`（关联角色与用户）、`startTime`/`endTime`（话题起止时间）、`archived`（0=活动/结束，1=已归档）、`topicTitle`（话题标题）、`initiator`（'user' 或 'char' 发起方）、`summary`（归档时 LLM 生成的话题总结）。

**`couples_whispers` 增补字段：** `topicId`（关联话题 ID）、`archived`（是否已归档）。归档时该话题下所有消息 `archived` 置 1，但仍保留在表中可供历史查看。

---

## 4. 悬浮多状态桌宠与真机系统级交互机制

### 4.1 角色跟随与配置隔离 (IndexedDB 状态存储)
*   **设计原则**：每个角色拥有专属的桌宠动作图组和行为配置。桌宠的状态读取以 IndexedDB 中的 `desktop_pets` 表作为唯一媒介，**彻底弃用 LocalStorage 的 5MB 受限配额**，避免多角色图片 Base64 堆叠引发的溢出崩溃。
*   **激活逻辑**：系统只允许一个桌宠在桌面上处于活跃状态。当开启 A 角色的桌宠时，B 角色桌宠被自动设置为不启用状态；即使在应用内切换至其他角色的聊天页面，**A 角色的真机悬浮窗依然平稳悬浮在系统桌面和 launcher 之上**，实现了彻底的激活态开关隔离。

### 4.2 桌宠 9 种多动作状态定义
系统内置并强制对齐以下 9 种典型的二次元/拟真动作状态：
1. `default` (初始化)：无动作或平稳呼吸。
2. `happy` (开心)：大喜、雀跃状态。
3. `sad` (难过)：失落、低头。
4. `angry` (生气)：赌气、叉腰。
5. `hesitant` (犹豫)：疑惑、歪头。
6. `wash` (洗漱)：刷牙、梳妆。
7. `eat` (吃饭)：吞咽、下午茶。
8. `sleep` (睡觉)：闭眼、吐泡泡。
9. `watch` (看着你)：注视、凝望。

### 4.3 自定义对话模式 (台词加权随机)
在自定义模式下，用户可为 9 种状态分配 `0-100` 的**出现概率权重**，并在每个状态下方配置多行专属台词。桌宠在双击或空闲触发时，会采用高动态随机加权算法选定一种状态切换图片，并随机抓取该状态下的一行台词通过原生 TextView 气泡展现。

### 4.4 实时生成模式 (大模型动作控制)
当设定为实时生成模式，悬浮窗在双击时会展示“思考中...”，并在后台静默对 API 预设发起 completions 请求。大语言模型会扮演当前桌宠的性格背景，并在回复的最后一行强制追加状态标记：
```text
(对白内容...)
[PET_STATE]状态名称
```
大手机前端拦截器捕获该标志后，会瞬时完成文字气泡展现和桌宠图片状态的物理跳转。

### 4.5 真机系统级双击手势与跨进程反向唤醒
*   **手势位移过滤算法**：为了防止手指拖拽悬浮窗时误触发双击，在 Kotlin `bindOverlayTouchListener` 中计算了按下（Down）与抬起（Up）之间的坐标位移差。**只有位移差小于 15px 且两次点击间隔小于 350ms 时**，才确认为双击交互。
*   **不打扰静默执行**：用户在手机系统桌面上双击桌宠时，App 不需要频繁强行蹦到前台（这会造成极不连贯的跳出感）。原生端通过 `evaluateJavascript` **直接在后台静默执行 JS 引擎逻辑**，实现完美的后台放歌、气泡冒泡和 AI 计算交互。

---

## 5. JS 独立高精度后台定时发信调度引擎

### 5.1 WebView 后台冷冻局限与保活心跳
由于 Android OS 深度的省电和隐私策略，当 App 进入后台时，WebView 的 CPU 分配会被严厉降频，甚至使 `setInterval` 定时器彻底处于冻结状态。
*   **特权破沙箱方案**：在后台主动发信开启时，通过 Kotlin 调起 **`McpForegroundService` 前台服务**，并在真机上显示低能耗的“叙事诗保活通知”。这会强行将 App 的优先级提高到前台，阻止 OS 对 WebView 的冷冻，保障 JS 心跳线程即使在息屏、锁屏状态下依然能够精准跳动。

### 5.2 独立发信时间片轮询算法
系统在 JavaScript 端运行一个每 30 秒执行一次的**高精度全局发信调度器（Ticker）**：
```javascript
const lastTrigger = parseInt(localStorage.getItem(`mcp_last_msg_time_${charId}`));
if (Date.now() - lastTrigger >= intervalMinutes * 60 * 1000) { ... }
```
调度器逐个检索配置了自动发信的角色，**各角色发信间隔完全物理分离，互不干扰**（如角色 A 设置 10 分钟，角色 B 设置 2 分钟）。相比之前 Kotlin 层的单一硬编码轮询，该方案完美满足了多角色社交拟真深度要求。

### 5.3 携带世界书与长 RAG 记忆的高质量后台 Prompt 编译
*   **智能编译升级**：之前 Kotlin 直接发送 HTTP 请求无法调用复杂的 JS 数据。重构后的 JS 后台发信引擎，能够**完全读取并调用大手机最核心的 RAG 召回机制、记忆提炼模型与世界书词条挂载**。
*   **指令注入**：调度器在触发自动发信时，会静默拼装深度为 `-490` 的主动开启话题指令，让大模型产生极其自然、富有生活感和思念意味的主动攀谈信息，彻底告别公式化的问候。

### 5.4 联动真机通知与桌面冒泡的气泡可视链
为了给用户提供完全无死角的“自动发信状态可视排查”，系统打通了完整的联动气泡链：
*   **第一步：定时器启动** $\rightarrow$ 当前活跃的桌面桌宠头上会瞬时冒出 `“有人冒泡。”` 的系统气泡，代表 JS 调度已经就绪并正在向 API 发送网络请求，**直观排除了定时器冷冻或失效问题**。
*   **第二步：消息生成并收到** $\rightarrow$ 此时若 App 处于后台，Kotlin 会直接向真机状态栏直推标准的**系统悬浮通知**（如：`A：“你睡了吗？”`），同时桌面桌宠头上的气泡会瞬间切换提示：`“有人来信。”`，构建起流畅而极其逼真的真机扮演闭环。

---

## 6. 网页/原生避让与防区双生桌宠消减机制

### 6.1 “双生桌宠”视觉重叠痛点
在 Hybrid (混合) App 中，如果系统悬浮窗（Native Window）处于显示状态，它会盖在所有应用程序（包括 PWA 自身）的头部。如果此时网页 DOM 也生成了 `#desktop-pet-container` 节点，用户就会在 App 的主界面上**同时看到两个重叠在一起的桌宠**，其中一个不可点击，体验极差。

### 6.2 网页 DOM 节点物理级拦截与销毁
大手机采取了**“彻底拔除网页 DOM”**的消减策略：
*   **入口拦截**：在 `app_desktop_pet.js` 的 `createDomElements` 初始化阶段，进行环境嗅探。若检测到 `window.AndroidMCP` 存在（即运行在真机 APK 壳中），直接 `return`，在物理层面上根本不创建该 HTML 节点。
*   **运行时销毁**：在 `renderPetToDesktop` 执行阶段，增加强防区判定。如发现任何因 WebView 异步延迟导致漏网创建的 DOM 桌宠，执行：
    ```javascript
    const container = document.getElementById("desktop-pet-container");
    if (container) container.remove(); // 强制拔除销毁
    ```
    将所有渲染、手势拖拽、气泡冒泡权限 100% 交予真机系统窗口托管，彻底消除了双生重合的显示故障。

---

## 7. 长周期记忆、深谈空间与协同组件剖析

### 7.1 会话总结与长久记忆库 (`app_summary_memory.js`)
*   **长周期记忆提炼**：通过后台静默扫描，大手机会自动切割对话轮次。在对话达到阈值（如 10 轮）且排除最后 5 轮（保护当前短期语境）后，向大模型发起合成总结。
*   **RAG 模糊检索召回**：提炼出的总结记录（带 Keywords 热词）会持久化在 `summaries` 表中。在主聊天用户输入新消息时，系统会执行 RAG 检索，将匹配到的历史总结平铺成长期记忆并注入 System Prompt 深度 `-600` 位置，赋予角色长周期的稳定记忆力。

### 7.2 深度对话剖析空间 (`app_deeptalk.js`)
*   **内心质询舱**：深谈是独立于主会话的剖析空间，采用优雅的 `scroll-snap` 强吸附卡片排版。用户可以配置“择选”对立执念，在对话中彻底剥离角色的社交面具。
*   **内心闪念拦截**：深谈中 AI 的回复会包含特有的情绪标志：
    ```text
    [THOUGHT]真实的内心剖白和潜意识挣扎[/THOUGHT]
    ```
    前端引擎拦截此标签，将其替换抹除后，将纯净的台词上屏，而把 [THOUGHT] 中的短暂内心潜意识闪念写入 `deeptalk_thoughts`（小宇宙）中永久封存。

### 7.3 HTML 互动舱生成与安全沙盘 (`app_chat_html_widget.js`)
*   **全功能组件生成**：支持根据会话语境，让 AI 编写出高度交互、带样式与完整 JS 交互的单文件 HTML 卡片（如迷你游戏、心率雷达图）。
*   **零写入清洗视图**：支持一键在“原始文本视图”和“清洗后运行视图（Iframe 沙盒）”之间进行零写入双态切换。
*   **代码维修舱**：在主会话下方注入 `#html-repair-overlay` 隔离空间。维修舱可载入 100% 原始代码并在输入时进行防抖实时沙盒渲染。
*   **双视图响应式尺寸约束（v3.2 新增）**：互动舱采用「列表小卡片 + 全屏大卡片预览」双视图模式。`HTML_WIDGET_INSTRUCTION` 提示词明确要求 AI 生成的代码同时适配两种尺寸——列表小卡片（高度 250px，紧凑布局）与大卡片预览（480×880px，充分利用空间），要求使用 Flexbox/Grid + `clamp()`/`vh/vw/%` 相对单位，避免固定像素。
*   **大卡片预览浮层（`openPreview`，v3.2 新增）**：点击卡片「⤢ 预览」按钮，创建 `position:fixed` 全屏浮层（100vw×100vh 深色半透明遮罩），顶部深色标题栏含卡片 ID、指令摘要、刷新/关闭按钮，中部居中 iframe（max-width:480px; max-height:880px）通过 `sandbox="allow-scripts allow-popups allow-forms"` 隔离执行。预览复用 `extractCleanHtml` 清洗态代码，支持刷新按钮、关闭按钮、点击遮罩、ESC 键四种关闭方式。
*   **指令折叠/展开（`togglePrompt`，v3.2 新增）**：渲染卡片时若 `card.prompt.length > 150`，指令文本默认折叠为一行（CSS `-webkit-line-clamp:1` + `text-overflow:ellipsis`），显示「▼ 展开」按钮；点击切换 `data-collapsed` 属性展开/收起，避免长指令撑高卡片破坏布局。

### 7.3b 情侣空间·悄悄话话题会话与归档机制 (`app_chat_couples.js`)（v3.2 新增）
*   **话题会话机制**：悄悄话升级为「话题会话」，双方（user 与 char）均可主动发起/结束话题。AI 在回复中输出 `[WHISPER_TOPIC_START: 话题标题]` / `[WHISPER_TOPIC_END]` 指令（与朋友圈、论坛线上指令风格一致），由 `parseWhisperCommands(text)` 用括号平衡法提取后触发 `startWhisperTopic` / `endWhisperTopic`，用户也可通过 UI 按钮发起。
*   **3 天自动归档 + 手动归档**：`autoArchiveExpiredTopics()` 进入情侣空间时巡检，对所有 `archived !== 1` 且 `startTime` 距今超 3 天的话题调用 `archiveTopic(id, true)` 自动归档；用户可点击「归档」按钮调用 `archiveTopic(id, false)` 手动归档。
*   **归档总结入记忆库**：`archiveTopic` 拉取话题消息 → 调用 `summarizeWhisperTopic` 让 LLM 生成总结 → 写入 `db.summaries`（`category:'relationship'`，`content` 形如 `【情侣空间·悄悄话归档】话题《标题》（我发起/对方发起）：总结`）→ 标记话题和消息 `archived:1`。归档内容进入长期记忆库后可被 RAG 召回，让 char 真正"记住"悄悄话。
*   **对话连贯性修复**：`triggerWhisperReply` 仅保留当前活动话题内的消息历史（按 `topicId` 过滤），并在 prompt 中强调"承接当前话题上下文回复"，解决原先跨话题消息混杂导致 AI"不读用户话"、答非所问的问题。
*   **数据表**：依赖 `db.js` Version 27 的 `couples_whisper_topics`（话题元信息：标题/发起方/起止时间/是否归档/总结）与 `couples_whispers`（增补 `topicId`/`archived` 索引）两张表。

### 7.3c 全局空头像安全渲染修复（v3.2 新增）
*   **问题**：头像为空时显示破损图片，名字区域出现残破「>」字样。根因是 `resolveAvatar` 返回的 SVG 数据 URL 内部属性用双引号，插入 `<img src="data:image/svg+xml;utf8,<svg viewBox="...">">` 时双引号提前闭合 `src` 属性，剩余 SVG 标记（含 `>`）泄漏到 HTML。
*   **修复范围**：统一 `app_archive.js`、`app_reader.js`、`app_deeptalk.js`、`app_world_book.js` 中所有 `resolveAvatar` 函数，SVG 内部属性改用单引号（`viewBox='0 0 100 100'`），`#` 做 URL 编码（`%23`），并新增"人"字默认灰色图标兜底。`app_chat.js` 新增 `avatarFallback(el)` 处理 `<img onerror>` 回退，会话列表头像 `src` 与名字均加 `escapeHtml`。

### 7.4 主线剧情引导引擎 (`app_chat_plot_engine.js`)
*   **最高优先级大纲控制**：剧情引导舱允许用户输入任意故事走向大纲。该大纲会作为高优控制指令，在 System Prompt 的深度 `-480` 原子化拼入模型头部，驱使大模型往特定矛盾冲突或态度演进方向推进。

### 7.5 沉浸式旋转专注中枢与伴随音频流（`app_chat_focus.js` & `focus.css`）
*   **Conic 指针物理旋转仪**：专注时钟摒弃了原生滑条，采用纯 Pointer Tracking 跟踪指针极角，平滑完成 $5\sim120$ 分钟的阻尼感微调，并将 Emojis 彻底重构为精致高透的 SVG 矢量图标。
*   **真机伴随白噪音存储**：导入的 MP3 背景音乐和伴奏通过 Dexie 原生 Blob 直接关联到会话行中，绕过 Android 沙箱本地路径权限阻碍。并在 `visibilitychange: hidden` 切屏发生时直接暂停伴奏并弹出“继续”按钮，切回后实现静默恢复。

### 7.6 自闭环 AI 伴读书城与多编码自愈引擎（`app_reader.js` & `reader.css`）
*   **GBK 乱码自适应检测检测机制**：本地书籍导入置入了乱码字节探测，一旦前导译码发现 UTF-8 替代占位符 `\uFFFD`，立即强制中断并降级回退至 `GBK` 重新加载，实现自愈导入。
*   **多维伴读书评气球 (Paragraph Reviews)**：双击正文段落可让真机悬浮窗绑定的 AI 角色越过沙盒界限，直接对书籍中的文字进行 50 字以内的第一人称暖心/毒舌吐槽评点，通过 TextView 气泡弹性展示。

---

## 8. 无限拓展开发蓝图 (Where & How to Add Features)

### 蓝图 A：新增高特权 Android 系统接口 (如操控真机摄像头拍照)
1. **静态清单声明**：
   在 `AndroidManifest.xml` 中追加物理权限申请：
   ```xml
   <uses-permission android:name="android.permission.CAMERA" />
   ```
2. **Activity 运行时授权申请**：
   在 `MainActivity.kt` 的 `requestAppPermissions` 数组中并入：
   ```kotlin
   Manifest.permission.CAMERA
   ```
3. **编写 Kotlin 桥接方法**：
   在 `AndroidMcp.kt` 中添加高特权 JavaScript 注入方法：
   ```kotlin
   @JavascriptInterface
   fun takeSilentPhoto() {
       // 控制 CameraX 在后台进行无快门声静默拍照并转为 Base64
   }
   ```
4. **前端 JS 驱动与自愈防崩保护**：
   在前端 JS 中通过非空判定进行调用，保障非真机 APK 环境下也能完美兼容防崩：
   ```javascript
   if (window.AndroidMCP && typeof window.AndroidMCP.takeSilentPhoto === 'function') {
       window.AndroidMCP.takeSilentPhoto();
   } else {
       showToast("当前非真机环境，无法使用镜头拍照特权。");
   }
   ```

### 蓝图 B：向 Dexie 中追加新物理表
1. 打开 `db.js`。
2. 将版本号升级（如从 `db.version(12)` 升级至 `db.version(13)`），并在 stores 里定义您的新表索引字段。
3. **防止备份损坏**：任何新增的表，必须手动在 `app_settings.js` 的 `computeStorageUsage()` 记录累加、`exportBackup()` 的导出字段映射、以及 `importBackup()` 还原清空时的事务 RW 锁列表中进行同步声明，否则在进行 PWA 数据大备份还原时会遭遇事务空指针，引发页面假死。
```

## 9. 小程序系统：链接安装 / 应用商店 / MCP 安全桥

「叙事诗小手机」内置微信风格小程序系统（`app_miniprogram.js` + `app_miniprogram_workshop.js`）。自本版起支持 **链接安装**、**应用商店（store.json）批量分发** 与 **权限声明式安全模型**，并打通 **MCP 工具安全调用**（密钥不暴露）。

### 9.1 安装方式

| 方式 | 入口 | 适用场景 |
| :--- | :--- | :--- |
| 上传文件 / 粘贴代码 | 工坊「安装小程序」卡片 | 本地制作、离线安装、调试 |
| **链接安装（推荐分发，统一入口）** | 工坊「安装小程序」卡片 →「链接安装」输入框 | 粘贴 `.js` 直链 **或** 应用商店清单 `store.json`，自动识别、一键安装；商店清单可一次装齐多个应用，重复粘贴同一链接即为「更新」 |

链接安装复用宿主 HTTP 通道：Android 真机优先走 `AndroidMCP.sendNativeHttpRequest`（规避跨域），PWA 回退 `fetch`。

#### 9.1.1 可接受的链接与部署指引

「链接安装」输入框接受两类链接（自动识别）：

1. **小程序 .js 直链**：链接直接返回 JS 文件文本（含 `registerMiniProgram` 调用）。推荐托管：
   - GitHub raw：`https://raw.githubusercontent.com/用户名/仓库名/分支/路径/文件.js`
   - jsDelivr：`https://cdn.jsdelivr.net/gh/用户名/仓库名@分支/路径/文件.js`
   - Gitee raw / Gitee Pages / 任意支持 CORS 的静态托管直链
2. **应用商店清单 store.json**：JSON 文本，格式见 9.2；粘贴后一次性安装全部应用。

硬性要求：以 `https://` 开头；免登录、可匿名 GET、直接返回文件原文；浏览器直连受 CORS 限制（优先 GitHub raw / jsDelivr 等自带 CORS 的服务，或使用 Android 真机原生 HTTP 桥）。

不可用链接：GitHub blob 网页、需登录的网盘分享页、任何返回 HTML 包装的页面、需要鉴权头的私有链接。

部署路径示例（GitHub）：上传 `.js` 到仓库 → 打开文件点 `Raw` 复制 `raw.githubusercontent.com` 链接 → 或改用 jsDelivr 加速域名 → 在工坊「链接安装」粘贴导入。

### 9.2 应用商店清单（store.json）——链接安装的一种输入形态

```json
{
  "type": "miniprogram-store",
  "name": "我的应用商店",
  "description": "一句话介绍",
  "iconSvg": "<svg ...>...</svg>",
  "apps": [
    {
      "id": "mp_store_sms_helper",
      "name": "验证码助手",
      "description": "通过 MCP 短信网关收发验证码",
      "version": "1.0.0",
      "author": "作者",
      "type": "tool",
      "iconSvg": "<svg ...>...</svg>",
      "url": "https://host/apps/sms_helper.js",
      "permissions": ["mcp", "storage", "llm"]
    }
  ]
}
```

- `apps[].url` 可为相对路径（相对 store.json）；`permissions` 覆盖代码自带 manifest。
- `app.id` 建议固定唯一：更新时按 id 覆盖升级，不重复安装。
- 分享方式：把 store.json 链接发给用户，在工坊「链接安装」输入框粘贴即可一次性装齐全部应用；再次粘贴同一链接即为「更新」。商店源记录保存在 `localStorage[miniprogram_store_sources]`（内部数据，无独立 UI）。

### 9.3 权限声明式安全模型（密钥不暴露）

小程序在 manifest 中声明 `permissions` 白名单，宿主按白名单裁剪 API：

| 权限 | 覆盖能力 |
| :--- | :--- |
| `llm` | callLLM / getCharReply（宿主闭包持 key） |
| `api` | getApiConfig（**声明后不含明文 key**） |
| `memory` / `chat` / `archive` / `worldbook` / `network` | 记忆、消息、档案、世界书、关系网读写 |
| `storage` / `files` | 状态持久化、文件读写导出 |
| `share` / `user` | 房间分享、用户信息 |
| `mcp` | 调用 MCP 工具（宿主代理） |
| `*` | 全部授权 |

安全要点：
1. **密钥留在宿主**：声明过权限的小程序调用 `api.getApiConfig()` 只得到 `{url, model, temperature, hasKey}`，拿不到明文 key；未声明权限的旧版小程序保持原行为（向后兼容）。
2. **MCP 由宿主代理**：`api.mcp.listServers()` 不返回服务器 url/headers；`api.mcp.invoke()` 内部走 `mcpClientSystem.callMcpTool`（含 initialize 握手与鉴权），密钥与服务器地址永不进入小程序作用域。
3. **首次运行权限确认**：声明过权限的小程序首次启动弹出权限清单（仿应用商店），用户确认后记录一次。
4. **API 裁剪**：白名单外的 api 方法直接被删除，小程序调用即报错，拿不到任何越权数据。

### 9.4 MCP 安全调用示例（短信验证码应用）

```javascript
registerMiniProgram({
  id: "mp_store_sms_helper",
  name: "验证码助手",
  description: "通过 MCP 短信网关收发验证码",
  version: "1.0.0",
  author: "作者",
  type: "tool",
  iconSvg: "<svg ...>...</svg>",
  permissions: ["mcp", "storage"]
}, function (container, api) {
  container.innerHTML = '<div style="padding:16px;">验证码助手</div>';
  // 调用宿主配置好的 MCP 短信网关
  const result = await api.mcp.invoke("短信网关", "send_code", {
    phone: "138xxxx", code: "123456"
  });
  // result.content 含服务器返回文本
});
```

前置条件：MCP 服务器需先在宿主「MCP 设置」中配置并启用，工具需处于启用状态；服务器/分组总开关关闭时调用抛错，小程序内必须 try/catch。

### 9.5 涉及文件

| 文件 | 变更 |
| :--- | :--- |
| `app_miniprogram.js` | 统一 URL 拉取 `fetchUrlText`；`installFromUrl`（单文件/商店双识别）；`installStore` / `installStoreApp` / `updateStoreApps` / 商店源持久化；`PERM_META` + `applyPermFilter` API 裁剪；`api.mcp` 命名空间；`getApiConfig` 密钥脱敏；`ensurePermApproved` 首次运行权限确认 |
| `app_miniprogram_workshop.js` | 安装卡片统一入口：「上传文件 / 粘贴代码 / 链接安装」（链接自动识别 `.js` 直链或 store.json 商店清单）；已安装列表权限标签与来源标签；WORKSHOP_PROMPT 同步更新（方式 C 链接安装 + 可接受链接规格 + 部署与导入教程 + 权限声明 + api.mcp + store.json 发布规范） |
| `app_miniprogram.css` | 链接输入行、权限标签样式 |


