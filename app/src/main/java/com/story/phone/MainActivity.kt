package com.story.phone

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                return false // 确保 WebView 内部跳转，不调起外部浏览器
            }
        }

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true // 启用 LocalStorage 以便存储 RAG 气象和屏幕时长等
        settings.allowFileAccess = true   // 允许访问 assets 内的本地文件
        settings.allowContentAccess = true
        settings.databaseEnabled = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true

        // 注入 window.AndroidMCP 原生接口
        webView.addJavascriptInterface(AndroidMcp(this), "AndroidMCP")

        // 加载 assets 本地打包的前端页面
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack() // 返回键优先控制 WebView 回退
        } else {
            super.onBackPressed()
        }
    }
}