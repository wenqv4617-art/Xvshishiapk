-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.story.phone.AndroidMcp { *; }

# nodejs-mobile：内置 Node 运行时桥接类不可混淆
-keep class com.nodejs.** { *; }
-keepclassmembers class com.nodejs.** { *; }