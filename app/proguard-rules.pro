-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.story.phone.AndroidMcp { *; }

# nodejs-mobile：内置 Node 运行时桥接类不可混淆
-keep class com.nodejs.** { *; }
-keepclassmembers class com.nodejs.** { *; }

# 正在播放监听服务（Manifest 声明的 NotificationListenerService，防混淆/裁剪）
-keep class com.story.phone.NowPlayingListenerService { *; }

# 注：原「微信接入无障碍服务」已弃置并删除，相关 keep 规则一并移除。
#     现行微信接入走 App 内直连 iLink，不需要任何 Service 反射注册。
