# 叙事诗小手机 开发与安卓 APK 特权架构参考手册 (2026年特权版)

本手册是“叙事诗小手机”系统的核心开发和维护指南。本系统是一个通过 **Android Native Shell (Kotlin) + Core Web View (HTML5)** 混合开发（Hybrid）封装而成的真机级 **Android 原生特权 App** [1]。项目前端采用 **HTML5 + CSS3 + 纯原生 JavaScript** 构建，底层依赖 **Dexie.js (IndexedDB)** 保证数据的事务级持久化，并利用 **Model Context Protocol (MCP)** 硬件级联动协议打破沙箱，实现了真机定位、实时气象、物理马达震动、系统物理闹钟直写、本地歌单后台锁屏放歌、数据一键本地物理导出等深度系统级特权功能 [1]。

---

## 目录
1. **PWA 混合 App 物理目录结构**
2. **核心配置文件及底层 Kotlin 代码全文汇编**
   - 2.1 `.github/workflows/build-apk.yml` (自动云打包)
   - 2.2 `settings.gradle.kts` (多模块注册)
   - 2.3 `build.gradle.kts` (根项目编译)
   - 2.4 `app/build.gradle.kts` (应用模块编译)
   - 2.5 `app/proguard-rules.pro` (混淆保护白名单)
   - 2.6 `app/src/main/AndroidManifest.xml` (系统高特权清单)
   - 2.7 `app/src/main/res/layout/activity_main.xml` (视图布局)
   - 2.8 `app/src/main/java/com/story/phone/MainActivity.kt` (主 Activity 容器)
   - 2.9 `app/src/main/java/com/story/phone/AndroidMcp.kt` (高特权原生接口)
3. **MCP (Model Context Protocol / Mobile Control Panel) 深度实现机理**
   - 3.1 提示词总开关与歌单物理扫描 JS 代码 (`app_chat_mcp.js`)
   - 3.2 传感数据向大模型（AI）的 mind 注入
   - 3.3 大模型对物理放歌指令的反向自动化驱使
4. **终极功能拓展技术蓝图（AI窥屏、摄像头控制、后台发邮件）**
5. **新增真机特权权限操作指南 (How to Add Permissions)**

---

## 1. PWA 混合 App 物理目录结构

请确保您本地的仓库目录结构与下方结构完全一致。所有前端网页资产、图标、音频等文件，必须存放在 `app/src/main/assets/` 路径下，以便打包进 APK 资源内部 [2]。

```text
(您的新项目根目录)
├── .github/
│   └── workflows/
│       └── build-apk.yml           # GitHub Actions 自动云打包配置文件
├── app/
│   ├── src/
│   │   └── main/
│   │       ├── assets/             # 📂 放入您当前所有的前端平铺文件 [2]
│   │       │   ├── index.html
│   │       │   ├── style.css
│   │       │   ├── app_chat.js
│   │       │   ├── app_chat_mcp.js # MCP 物理控制与扫歌前端逻辑
│   │       │   └── (其他所有的前端资源：.js, .css, .json, .png等)
│   │       ├── java/com/story/phone/
│   │       │   ├── MainActivity.kt        # 安卓原生主 Activity 代码
│   │       │   └── AndroidMcp.kt          # 安卓原生高特权接口桥接代码
│   │       ├── res/
│   │       │   ├── drawable/
│   │       │   │   └── ic_launcher.png    # 桌面自定义正方形 PNG 图标
│   │       │   └── layout/
│   │       │       └── activity_main.xml  # 安卓界面 WebView 视图布局
│   │       └── AndroidManifest.xml                    # 安卓系统功能清单
│   ├── build.gradle.kts                               # App 编译配置脚本
│   └── proguard-rules.pro                             # 混淆器防剥离规则
├── build.gradle.kts                                   # 根项目编译脚本
└── settings.gradle.kts                                 # 项目根设置
```

---

## 2. 核心配置文件及底层 Kotlin 代码全文汇编

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

      # 核心升级：通过锁定并持久化缓存 ~/.android 密钥目录，确保后续编译的所有 APK 共享同一个数字证书，避免真机覆盖安装时的数字证书冲突
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
        versionCode = 2
        versionName = "1.1.0"
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

    <!-- 申请真机振动、GPS定位、闹钟、通知监听、后台锁屏唤醒等安卓硬件权限 -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.VIBRATE" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.SET_ALARM" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    
    <!-- 新增：申请读写外部存储权限 (支持高低安卓版本兼容，打通物理存储扫歌与导出) -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />

    <!-- 将 allowBackup 显式设为 false，彻底关闭系统云端数据备份，避免卸载重装时还原旧缓存 -->
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
                return false // 确保旧版 API 下 WebView 内部跳转
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: android.webkit.WebResourceRequest?
            ): Boolean {
                return false // 确保新版 API 下 WebView 内部跳转
            }
        }

        // 核心重写：解决真机定位授权与网页 Input File 文件选择器在宿主壳中无响应的问题
        webView.webChromeClient = object : WebChromeClient() {
            // 支持 HTML5 Geolocation 定位授权
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, true, false)
            }

            // 支持 HTML5 <input type="file"> 文件选择器（打通网页导入/导出、图片上传通道）
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                @Suppress("UNCHECKED_CAST")
                (fileUploadCallback as? ValueCallback<Array<Uri>?>)?.onReceiveValue(null)
                fileUploadCallback = filePathCallback

                // 核心修复：通过 Elvis 操作符，在 intent 为空时提前阻断返回，保证编译器类型收拢安全
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
        settings.domStorageEnabled = true // 启用 LocalStorage
        settings.allowFileAccess = true   // 允许访问 assets 内的本地文件
        settings.allowContentAccess = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.geolocationEnabled = true // 允许定位

        // 核心修复：禁用媒体播放必须物理手势触发的限制，彻底解锁 AI 在后台静默自动点播放歌的特权！ [1]
        settings.mediaPlaybackRequiresUserGesture = false

        // 注入 window.AndroidMCP 原生接口
        webView.addJavascriptInterface(AndroidMcp(this), "AndroidMCP")

        // 加载 assets 本地打包的前端页面
        webView.loadUrl("file:///android_asset/index.html")

        // 自动申请 Android 定位与通知的系统级运行时权限
        requestAppPermissions()
    }

    // 处理文件选择器弹窗的回调 (通过安全类型转换绕过严格空指针拦截)
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

    // 申请运行时权限
    private fun requestAppPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        // 动态合并追加存储与媒体音频权限，兼容 Android 13+ 与旧版系统
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
            webView.goBack() // 返回键优先控制 WebView 回退
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
import android.os.Build
import android.os.Environment
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.media.MediaPlayer
import java.io.File
import java.io.FileWriter
import org.json.JSONArray

class AndroidMcp(private val context: Context) {

    private var mediaPlayer: MediaPlayer? = null

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

    // 1. 物理数据导出直写至真机：/Download/Storypoem/ (解决 PWA WebView 下载失灵) [1]
    @JavascriptInterface
    fun saveBackupFile(jsonString: String, fileName: String): Boolean {
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

    // 2. 静默读取真机 /Music/Storypoem 目录下的本地歌单列表 [1]
    @JavascriptInterface
    fun scanLocalMusicFolder(): String {
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

    // 3. Android 原生 MediaPlayer 后台音乐播放器 (解决浏览器同源限制并支持锁屏后台不中断) [1]
    @JavascriptInterface
    fun playNativeMusic(songName: String): Boolean {
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
        try {
            mediaPlayer?.stop()
            mediaPlayer?.release()
            mediaPlayer = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 4. 安卓真机马达物理震动桥接 (支持 12 及以上新版和旧版震动)
    @JavascriptInterface
    fun triggerHardwareVibrator(milliseconds: Long) {
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

    // 5. 调起系统通知监听设置页 (OperitAI同款权限，让未来可以静默查收微信等真实系统通知)
    @JavascriptInterface
    fun requestNotificationPermission() {
        try {
            val intent = Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 6. 调起安卓系统无障碍辅助设置页 (无障碍自动化发信基础)
    @JavascriptInterface
    fun requestAccessibilityPermission() {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // 7. 原生写入真机物理闹钟 (无需 Termux，APK 拥有高特权 Intent 直写)
    @JavascriptInterface
    fun setAndroidSystemAlarm(hour: Int, minute: Int, message: String) {
        try {
            val intent = Intent(android.provider.AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(android.provider.AlarmClock.EXTRA_HOUR, hour)
                putExtra(android.provider.AlarmClock.EXTRA_MINUTES, minute)
                putExtra(android.provider.AlarmClock.EXTRA_MESSAGE, message)
                putExtra(android.provider.AlarmClock.EXTRA_SKIP_UI, true) // 不弹出系统界面，静默设定
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
```

---

## 3. MCP (Model Context Protocol) 深度实现机理

本系统中的 MCP 既是真机的控制面板，也是与大模型进行状态共频的协议通道。

### 3.1 提示词总开关与歌单物理扫描 JS 代码 (`app_chat_mcp.js`)
请确保在您 assets 前端静态目录下，`app_chat_mcp.js` 采用如下实现方式，彻底与 Kotlin 底层打通：

```javascript
/**
 * app_chat_mcp.js - Model Context Protocol & Mobile Control Panel 物理扫歌与原生播放联动中枢 [1]
 */

(function() {
  const mcpSystem = {
    // 自动扫描出的物理歌曲列表 (存放歌曲的真实文件名，如 "song.mp3") [1]
    localPlaylist: [],

    // 开启中枢控制面板
    openPanel: function() {
      if (!activeSessionId) {
        showToast("请先进入一个好友聊天对话！");
        return;
      }
      document.getElementById("chat-mcp-panel").classList.add("active");
      this.refreshScreentimeDisplay();
      
      // 开启面板时自动扫描本地物理歌单并加载设置 [1]
      this.scanAndSyncLocalMusic();
    },

    // 关闭控制面板
    closePanel: function() {
      document.getElementById("chat-mcp-panel").classList.remove("active");
    },

    // 载入并同步 MCP 本地配置
    loadMcpSettings: function() {
      const isMcpEnabled = localStorage.getItem("settings-mcp-prompt-enabled") === "true";
      const toggle = document.getElementById("settings-mcp-prompt-toggle");
      if (toggle) toggle.checked = isMcpEnabled;

      // 回显本地扫描出的物理歌单 [1]
      const listEl = document.getElementById("mcp-playlist-list");
      if (listEl) {
        if (this.localPlaylist.length > 0) {
          listEl.innerHTML = this.localPlaylist.map((s, idx) => `<div style="padding: 4px 6px; margin-bottom: 2px; border-radius:4px; background:rgba(0,0,0,0.03); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;" onclick="mcpSystem.playTrackByIndex(${idx})">#${idx} - ${s}</div>`).join("");
          return;
        }
        listEl.innerHTML = "歌单为空。请用手机文件管理器将 MP3/WAV 歌曲放入本地存储的 /Music/Storypoem/ 目录下，然后重新打开此页面即可自动刷新！";
      }
    },

    // MCP 神经注入开关切换
    togglePrompt: function(toggleEl) {
      localStorage.setItem("settings-mcp-prompt-enabled", toggleEl.checked ? "true" : "false");
      showToast(toggleEl.checked ? "已成功建立神经感知！物理传感器与歌单已同步至 AI。" : "已切断神经数据通道。");
    },

    // 1. 同步地理位置与天气
    syncLocation: function() {
      const geoStatus = document.getElementById("mcp-geo-status");
      const weatherStatus = document.getElementById("mcp-weather-status");
      
      if (!navigator.geolocation) {
        showToast("您的设备浏览器不支持 GPS 地理定位");
        return;
      }

      geoStatus.innerText = "正在向 Android 设备申请高精度定位...";
      showToast("正在读取 GPS 位置...");

      navigator.geolocation.getCurrentPosition(async (position) => {
        const lat = position.coords.latitude.toFixed(4);
        const lon = position.coords.longitude.toFixed(4);
        geoStatus.innerText = `设备实测 GPS (纬度:${lat}, 经度:${lon})`;

        try {
          weatherStatus.innerText = "正在连接 Open-Meteo 气象中枢...";
          const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
          const data = await response.json();
          
          if (data && data.current_weather) {
            const temp = data.current_weather.temperature;
            const code = data.current_weather.weathercode;
            
            const weatherMap = {
              0: "晴朗 (Clear Sky)",
              1: "大部分晴朗", 2: "多云", 3: "阴天",
              45: "雾气", 48: "沉积雾",
              51: "细雨", 53: "中等毛毛雨", 55: "重度毛毛雨",
              61: "微雨", 63: "中雨", 65: "大雨 (Rainy)",
              71: "微雪", 73: "中雪", 75: "大雪",
              80: "阵雨", 81: "中等阵雨", 82: "暴雨",
              95: "雷暴", 96: "雷暴伴有冰雹"
            };

            const weatherDesc = weatherMap[code] || "多云或局部晴";
            const weatherObj = {
              city: `Android GPS定位 (经度:${lon}, 纬度:${lat})`,
              temp: temp,
              weather: weatherDesc
            };

            localStorage.setItem("mcp_loc_weather", JSON.stringify(weatherObj));
            weatherStatus.innerText = `实时室外温度: ${temp}°C | 当前天气: ${weatherDesc}`;
            showToast("环境传感器数据已注入！AI 已同步您的时空认知。");
          } else {
            throw new Error("获取气象协议失败");
          }
        } catch(err) {
          weatherStatus.innerText = "天气查询失败，但定位坐标已成功记录。";
          console.error(err);
        }
      }, (error) => {
        geoStatus.innerText = "定位失败，未获得 Android 浏览器定位权限";
        showToast("GPS 读取失败，请检查浏览器定位权限开关！");
      }, { enableHighAccuracy: true, timeout: 8000 });
    },

    // 2. 物理马达震动
    triggerVibration: function() {
      if (window.AndroidMCP && typeof window.AndroidMCP.triggerHardwareVibrator === 'function') {
        window.AndroidMCP.triggerHardwareVibrator(400); // 原生震动
        showToast("震动信号已发送至 Android 硬件马达");
        return;
      }
      if (navigator.vibrate) {
        navigator.vibrate([200, 100, 200]);
        showToast("H5 震动信号已发送");
      } else {
        showToast("您的设备不支持物理震动 API");
      }
    },

    // 3. 原生物理时钟直写闹钟 [1]
    setAlarm: function() {
      const input = document.getElementById("mcp-timer-input");
      const seconds = parseInt(input.value);
      if (isNaN(seconds) || seconds <= 0) {
        showToast("请输入合法的闹钟倒计时秒数！");
        return;
      }

      const targetDate = new Date(Date.now() + seconds * 1000);
      const hour = targetDate.getHours();
      const minute = targetDate.getMinutes();

      // 物理级直写：绕过沙箱，直接写入手机系统的原生时钟闹钟！ [1]
      if (window.AndroidMCP && typeof window.AndroidMCP.setAndroidSystemAlarm === 'function') {
        window.AndroidMCP.setAndroidSystemAlarm(hour, minute, "叙事诗小手机：神经倒计时闹铃");
        showToast(`已成功写入系统时钟！物理闹钟已设定在 ${hour}:${String(minute).padStart(2, '0')}`);
        this.closePanel();
        return;
      }

      // 降级模拟
      showToast(`模拟闹钟已设定，将在 ${seconds} 秒后提醒`);
      this.closePanel();

      setTimeout(() => {
        if (window.AndroidMCP && typeof window.AndroidMCP.triggerHardwareVibrator === 'function') {
          window.AndroidMCP.triggerHardwareVibrator(600);
        } else if (navigator.vibrate) {
          navigator.vibrate([400, 100, 400, 100, 600]);
        }
        showCustomAlert("⏰ MCP 警报通知", "您设定的倒计时神经闹钟已经唤醒！");
      }, seconds * 1000);
    },

    // 4.1 静默扫描真机 /Music/Storypoem 物理目录并载入 [1]
    scanAndSyncLocalMusic: function() {
      if (window.AndroidMCP && typeof window.AndroidMCP.scanLocalMusicFolder === 'function') {
        try {
          const jsonStr = window.AndroidMCP.scanLocalMusicFolder();
          this.localPlaylist = JSON.parse(jsonStr);

          // 同步歌单名称给 LocalStorage，供大模型提示词读取感知 [1]
          localStorage.setItem("mcp_playlist_titles", jsonStr);

          const titleEl = document.getElementById("mcp-music-title");
          if (titleEl) {
            titleEl.innerText = this.localPlaylist.length > 0 
              ? `已自动装载本地歌曲：${this.localPlaylist.length} 首` 
              : "歌单就绪：尚未在手机 /Music/Storypoem 下放置歌曲";
          }
        } catch(e) {
          console.error("扫描本地物理歌单失败:", e);
        }
      } else {
        // H5 降级提示
        const titles = localStorage.getItem("mcp_playlist_titles");
        if (titles) {
          try { this.localPlaylist = JSON.parse(titles); } catch(e) {}
        }
      }
      this.loadMcpSettings();
    },

    // 4.2 通过原生 MediaPlayer 进行物理音频后台/锁屏播放 (彻底击穿 Origin 拦截) [1]
    playTrackByIndex: function(index) {
      if (this.localPlaylist.length === 0) {
        showToast("本地歌单为空！请先将 MP3 歌曲丢入手机 /Music/Storypoem 目录下");
        return;
      }
      if (index < 0 || index >= this.localPlaylist.length) {
        showToast("指令点播的音乐索引超出界限");
        return;
      }

      const songName = this.localPlaylist[index];
      
      // 核心直连：调用原生 APK 的 Kotlin 媒体引擎，实现完美的后台放歌与锁屏驻留 [1]
      if (window.AndroidMCP && typeof window.AndroidMCP.playNativeMusic === 'function') {
        const success = window.AndroidMCP.playNativeMusic(songName);
        if (success) {
          document.getElementById("mcp-music-title").innerText = `正在物理播放：${songName}`;
          showToast(`已成功唤醒原生播放器后台播放：《${songName}》`);
        } else {
          showToast("真机原生播放音频流失败");
        }
        return;
      }

      showToast("当前环境暂不支持原生物理音频流后台播放，请在 APK 壳中运行。");
    },

    // 按歌名进行模糊匹配播放
    playTrackByTitle: function(title) {
      if (this.localPlaylist.length === 0) return;
      const index = this.localPlaylist.findIndex(s => s.toLowerCase().includes(title.toLowerCase()));
      if (index !== -1) {
        this.playTrackByIndex(index);
      } else {
        showToast(`歌单中未找到包含 "${title}" 的歌曲`);
      }
    },

    stopMusic: function() {
      if (window.AndroidMCP && typeof window.AndroidMCP.stopNativeMusic === 'function') {
        window.AndroidMCP.stopNativeMusic();
        document.getElementById("mcp-music-title").innerText = "音乐播放已暂停";
        showToast("音频播放已暂停");
      }
    },

    // 5. 屏幕扮演时间刷新展现
    refreshScreentimeDisplay: function() {
      const activeSeconds = parseInt(localStorage.getItem("mcp_screen_time_today") || "0");
      const mins = Math.floor(activeSeconds / 60);
      const secs = activeSeconds % 60;
      document.getElementById("mcp-screentime-val").innerText = `${mins} 分钟 ${secs} 秒`;
    }
  };

  // ==========================================
  //  5. 精准统计今日 PWA 屏幕使用时长
  // ==========================================
  let activeSeconds = parseInt(localStorage.getItem("mcp_screen_time_today") || "0");
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      activeSeconds++;
      localStorage.setItem("mcp_screen_time_today", activeSeconds);
    }
  }, 1000);

  // ==========================================
  //  6. 防御性自注册绑定 (自适应 DOMContentLoaded 周期)
  // ==========================================
  function bindMcpTrigger() {
    const btn = document.getElementById("btn-chat-mcp");
    if (btn) {
      btn.onclick = (e) => {
        if (e) e.preventDefault();
        document.getElementById("chat-expand-panel").classList.remove("active");
        mcpSystem.openPanel();
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindMcpTrigger);
  } else {
    bindMcpTrigger();
  }

  window.mcpSystem = mcpSystem;
})();
```

### 3.2 传感数据向大模型（AI）的 mind 注入
在开启中枢神经控制面板顶部的“融入 AI 提示词 (MCP 协议)”开关后，大手机会在 `app_prompts.js` 的编译段落（深度 `-490`）中自动提取 GPS 范围、实时气温和手机内置 `/Music/Storypoem` 下的所有 MP3 文件列表：

```text
【Model Context Protocol (MCP) 真机设备环境参数注入】：
- 物理位置/GPS坐标范围: Android GPS定位 (经度:116.3974, 纬度:39.9087)
- 外部实时气温: 24.5°C
- 外部实时气象: 晴朗 (Clear Sky)
- 当前用户手机内导入的设备本地歌单（共 3 首）：
  * [歌曲索引: 0] - "周杰伦 - 晴天.mp3"
  * [歌曲索引: 1] - "Lo-fi Rain Sound.wav"
  * [歌曲索引: 2] - "疗愈钢琴曲.mp3"

【核心交互指令】：在聊天中，如果你觉得气氛合适，或者在探讨音乐、深夜闲聊等特定语境下，你可以主动挑选上述歌单里的任意一首歌播放给用户听。
若你想控制用户手机自动播放歌单中的某一首音乐，请在你的回复文本最末尾追加以下格式的播放指令（必须单独占一行）：
[PLAY_MUSIC]{"index": 歌曲索引}
```

### 3.3 大模型对物理放歌指令的反向自动化驱使
当 AI 做出放歌判定并在回复尾端输出 `[PLAY_MUSIC]{"index": 0}` 指令时：
1.  前端 **`app_chat.js`** 的回复拦截器会在消息上屏前，瞬时通过正则捕获该指令并将其从文本中物理擦除（保障气泡文本的干净呈现） [1]；
2.  JS 自动在后台向 Java 桥梁发送指令：`window.AndroidMCP.playNativeMusic("周杰伦 - 晴天.mp3")` [1]；
3.  原生 Kotlin 通过 **Android 原生 `MediaPlayer`** 在真机后台中调起播放 [1]；
4.  即使此时您将小手机 App 退回到手机后台、切换到其他应用、或者**将手机屏幕彻底锁屏**，音乐依然会流畅、不间断地持续播放 [1]！

---

## 4. 终极功能拓展技术蓝图 (窥屏/OCR、摄像头控制、后台发信)

当您后期需要继续扩展诸如 **AI 窥屏/截图、操控摄像头、后台静默发邮件** 等深度特权功能时，可遵循以下技术实现路径：

### 4.1 扩展 1：AI 截取真机屏幕并进行视觉分析 (窥屏/OCR)
*   **物理瓶颈**：由于安卓隐私沙箱，网页绝对禁止截图。
*   **特权突破路径**：
    1.  **APK 清单文件声明**：
        在 `AndroidManifest.xml` 中声明媒体投影与前景服务权限：
        `<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"/>`
    2.  **Kotlin 端实现**：
        在 `MainActivity.kt` 中，调用 Android 官方的 **`MediaProjectionManager`** 启动录屏/截图投影服务。用户在首次启动时会弹出“允许录制/投影您的屏幕”的系统级安全提示 [2]。
    3.  **桥接开发**：
        在 `AndroidMcp.kt` 中编写 `@JavascriptInterface fun captureScreen()` 接口。该接口激活后静默调用 `MediaProjection` 快速捕获当前屏幕像素生成 Bitmap，转换成 Base64。
    4.  **MCP 注入**：
        前端 JS 接收到 Base64 截图数据后，将其作为图片多模态参数（如 gpt-4o 的 image 数组）直接喂给 API 接口。这样 AI 就能瞬间具备“看懂您当前手机屏幕正在做什么”的能力！

### 4.2 扩展 2：操控真机摄像头拍照并同步心境 (Camera Controller)
*   **物理瓶颈**：网页拍照必须频繁弹出浏览器摄像头允许提示，容易被系统回收。
*   **特权突破路径**：
    1.  **APK 清单文件声明**：
        `<uses-permission android:name="android.permission.CAMERA" />`
    2.  **Kotlin 桥接开发**：
        引入 Android 官方高效的 **CameraX 依赖库**，在 `AndroidMcp.kt` 中编写：
        ```kotlin
        @JavascriptInterface
        fun takeSilentPhoto() {
            // 在后台隐式绑定 CameraX 的 ImageCapture
            // 绑定后，不弹出预览界面，直接控制前置/后置摄像头静默拍照
            // 拍照完成后将图像存储至 assets 临时目录或转换为 Base64
        }
        ```
    3.  **运行机理**：
        当您和 AI 在闲聊时，您可以点击“同步视界”或者由 AI 做出命令。大手机利用 Kotlin 在毫秒内完成静默拍摄，将照片作为 Context 自动发给 API，让 AI 真正做到“看见您眼前的现实世界和您的神态”。

### 4.3 扩展 3：后台发送真实邮件 (Automated Background Email)
*   **特权突破路径**：
    1.  由于网页没有 SMTP 传输通道，我们直接在 Kotlin 原生端集成 **JavaMail (Jakarta Mail) 依赖库**。
    2.  **Kotlin 桥接开发**：
        在 `AndroidMcp.kt` 中声明发送邮件的子线程方法：
        ```kotlin
        @JavascriptInterface
        fun sendBackgroundEmail(to: String, subject: String, content: String) {
            Thread {
                try {
                    // 配置您的 SMTP 服务器（如 QQ邮箱 / 163 邮箱）
                    val props = System.getProperties().apply {
                        put("mail.smtp.host", "smtp.qq.com")
                        put("mail.smtp.auth", "true")
                        put("mail.smtp.port", "465")
                    }
                    val session = Session.getInstance(props, object: Authenticator() { ... })
                    val message = MimeMessage(session).apply {
                        setFrom(InternetAddress("你的邮箱@qq.com"))
                        addRecipient(Message.RecipientType.TO, InternetAddress(to))
                        setSubject(subject)
                        setText(content)
                    }
                    Transport.send(message)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }.start()
        }
        ```
    3.  **运行机理**：
        AI 在聊天中决定给您发送一封真实的秘密信件，它的指令在后台被前端拦截，调用 `window.AndroidMCP.sendBackgroundEmail` 接口，您的安卓手机就会在后台静默发送一封真实的电子邮件到您的工作邮箱中，打破次元壁！

---

## 5. 新增真机特权权限操作指南 (How to Add Permissions)

当您在后期想要引入类似摄像头或文件读取等高特权新功能时，请严格遵守以下**三段式权限追加规范**：

### 5.1 规范一：系统清单静态声明
打开 `app/src/main/AndroidManifest.xml`，在最外层（`<manifest>` 标签下方）追加相应的权限：
```xml
<!-- 例：追加摄像头与录音权限 -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

### 5.2 规范二：原生 Activity 运行时动态申请
由于 Android 6.0 以上的权限保护机制，仅在 Manifest 中声明是不够的，必须在用户开启 App 时弹出“系统级同意弹窗” [1]。
请打开 `MainActivity.kt`，找到 `requestAppPermissions()` 方法：
把
```kotlin
    private fun requestAppPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
```
替换为 (在这里追加您需要真机向用户动态弹窗申请的权限即可)
```kotlin
    private fun requestAppPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO
        )
```

### 5.3 规范三：自研 H5 UI 提示兜底
在 `app_chat_mcp.js` 中调用高特权 API 时，先进行非空判定（`if (window.AndroidMCP)`）[2]。如果当前运行在普通浏览器或 PWA 环境下：
*   **坚决不允许直接抛出未定义异常，以免导致 JS 引擎崩溃假死 [1]**！
*   通过 `showToast()` 温和地提示用户：“*检测到当前处于普通浏览器环境，无法调用物理马达/时钟直写，请安装并使用叙事诗 APK 特权版。*”保障两套环境下的兼容自愈性 [2]。
