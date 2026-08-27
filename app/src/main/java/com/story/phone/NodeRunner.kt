package com.story.phone

import android.content.Context
import android.util.Log

/**
 * NodeRunner 已退役：当前版本不再默认内置或启动 nodejs-mobile。
 * 保留同名对象仅为避免旧代码引用时报错；实际不执行任何逻辑。
 */
object NodeRunner {
    private const val TAG = "NodeRunner"

    @Synchronized
    fun ensureStarted(context: Context) {
        Log.d(TAG, "NodeRunner disabled: embedded node runtime removed from default build")
    }
}