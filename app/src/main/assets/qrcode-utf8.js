//---------------------------------------------------------------------
// UTF-8 支持包装（本文件为项目自写，非上游文件）
//
// 上游 qrcode-generator 默认按 Latin-1 处理字符串，中文等多字节字符会编错。
// 上游为此提供了 stringToBytesFuncs['UTF-8'] 预设，这里在库加载后启用它。
// 用法：
//   var qr = qrcode(0, 'M');          // 0 = 自动选版本，'M' = 纠错等级
//   qr.addData(text, 'Byte');
//   qr.make();
//   qr.getModuleCount() / qr.isDark(r,c)
//---------------------------------------------------------------------
(function () {
  if (typeof qrcode === "function" && qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs["UTF-8"]) {
    qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  }
})();
