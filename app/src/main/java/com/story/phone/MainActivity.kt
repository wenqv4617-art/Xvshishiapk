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
import com.story.phone.R

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

        // 重写 WebChromeClient 解决定位授权与网页 File 文件选择器失灵问题
        webView.webChromeClient = object : WebChromeClient() {
            // 支持 HTML5 Geolocation 定位授权
            override fun onGeolocationPermissionsShowPrompt(
                origin: String?,
                callback: GeolocationPermissions.Callback?
            ) {
                callback?.invoke(origin, true, false)
            }

            // 支持 HTML5 <input type="file"> 文件选择器
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                @Suppress("UNCHECKED_CAST")
                (fileUploadCallback as? ValueCallback<Array<Uri>?>)?.onReceiveValue(null)
                fileUploadCallback = filePathCallback

                // 【修复点】：如果 createIntent 返回 null，直接 return false，彻底解决报错！
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
        
        // 解锁 AI 在后台静默自动点播放歌
        settings.mediaPlaybackRequiresUserGesture = false

        // 注入 window.AndroidMCP 原生接口
        webView.addJavascriptInterface(AndroidMcp(this), "AndroidMCP")

        // 加载 assets 本地打包的前端页面
        webView.loadUrl("file:///android_asset/index.html")

        // 自动申请 Android 定位与通知的系统级运行时权限
        requestAppPermissions()
    }

    // 处理文件选择器弹窗的回调 
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

class McpForegroundService : android.app.Service() {
    private val CHANNEL_ID = "mcp_foreground_service_channel"

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = android.app.PendingIntent.getActivity(
            this, 0, notificationIntent,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            } else {
                android.app.PendingIntent.FLAG_UPDATE_CURRENT
            }
        )

        val notification = androidx.core.app.NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("叙事诗前台守护中")
            .setContentText("系统不休眠、歌单播放与后台发信功能保护中")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(pendingIntent)
            .build()

        startForeground(1005, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): android.os.IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val serviceChannel = android.app.NotificationChannel(
                CHANNEL_ID,
                "叙事诗后台守护通道",
                android.app.NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(android.app.NotificationManager::class.java)
            manager?.createNotificationChannel(serviceChannel)
        }
    }
}
