package com.story.phone

import android.content.Context
import android.util.Log
import com.nodejs.NodeJS

/**
 * 内置 Node.js 运行时启动器（nodejs-mobile）
 *
 * 作用：在 App 进程内直接启动网易云音乐 API 服务（http://localhost:3000），
 *       WebView 前端无需外接 Termux / 局域网服务即可完成网易云登录与歌单同步。
 *
 * 生命周期：Node 线程随 App 进程存活；进程由 McpForegroundService（前台服务）
 *           保活，因此前台服务运行时 API 一直可用。
 */
object NodeRunner {
    private const val TAG = "NodeRunner"
    private const val ASSETS_PATH = "/nodejs-project/"

    @Volatile
    private var started = false

    /** 幂等启动：任意位置调用都只会真正启动一次 */
    @Synchronized
    fun ensureStarted(context: Context) {
        if (started) return
        started = true
        try {
            val nodeJS = NodeJS(context.applicationContext, ASSETS_PATH, emptyArray())
            nodeJS.start(object : NodeJS.StartUpCallback {
                override fun onSuccess() {
                    Log.d(TAG, "Node 运行时启动成功，正在拉起内置网易云 API...")
                    try {
                        // 执行 assets/nodejs-project/index.js
                        nodeJS.runScript("require('./index.js')", null)
                        Log.d(TAG, "内置网易云 API 已运行: http://localhost:3000")
                    } catch (e: Exception) {
                        Log.e(TAG, "启动内置 API 失败: ${e.message}")
                        e.printStackTrace()
                    }
                }

                override fun onError(error: Throwable?) {
                    Log.e(TAG, "Node 运行时启动错误: ${error?.message}")
                    error?.printStackTrace()
                }
            })
        } catch (e: Exception) {
            Log.e(TAG, "NodeJS 初始化失败: ${e.message}")
            e.printStackTrace()
        }
    }
}
