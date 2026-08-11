package com.story.phone

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * 蓝牙管理模块（MCP 神经中枢的蓝牙子通道）
 *
 * 能力清单：
 * 1. 读取已连接 / 已配对设备（真实系统数据）
 * 2. 经典蓝牙 SPP 串口发送（可真实控制 ESP32 / Arduino / 智能硬件）
 * 3. 经典蓝牙主动连接 / 断开
 * 4. BLE 扫描（名称/地址/RSSI）
 * 5. BLE 特征值写入（可真实控制 BLE 智能设备）
 * 6. 系统蓝牙开关（Android 13+ 系统限制，仅提示）
 * 7. 真实电量读取（BatteryManager）
 *
 * 权限要求（AndroidManifest 已声明）：
 * - API 31+：BLUETOOTH_CONNECT / BLUETOOTH_SCAN
 * - API 30-：BLUETOOTH / BLUETOOTH_ADMIN / ACCESS_FINE_LOCATION(BLE扫描)
 */
class BluetoothMcp(private val context: Context) {

    companion object {
        private const val TAG = "BluetoothMcp"
        /** 经典蓝牙 SPP 串口服务 UUID（ESP32/Arduino/HC-05 等通用） */
        private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private const val ERR_NO_PERMISSION = "{\"ok\":false,\"error\":\"缺少蓝牙权限，请先在系统设置中授权\"}"
    }

    private val bluetoothManager: BluetoothManager? =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter? = bluetoothManager?.adapter

    /** 当前 SPP 串口连接（经典蓝牙） */
    @Volatile private var sppSocket: BluetoothSocket? = null

    /** 当前 BLE GATT 连接 */
    @Volatile private var gatt: BluetoothGatt? = null

    /** 最近一次 BLE 扫描结果（JS 侧轮询拉取） */
    @Volatile private var lastBleScanResults: String? = null

    /** 最近一次 BLE 写入结果 */
    @Volatile private var lastBleWriteResult: String? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    // ---------------------------------------------------------------
    // 权限辅助
    // ---------------------------------------------------------------

    private fun hasConnectPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            context.checkSelfPermission(android.Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun hasScanPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.checkSelfPermission(android.Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
        } else {
            context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    // ---------------------------------------------------------------
    // 1. 读取设备列表（已连接 + 已配对）
    // ---------------------------------------------------------------

    /**
     * 返回 JSON：{"ok":true,"devices":[{name,address,type:"connected"|"paired",profile,profileName,rssi?}...]}
     */
    fun getDevicesJson(): String {
        if (!hasConnectPermission()) return ERR_NO_PERMISSION
        return try {
            val devices = JSONArray()
            val seen = LinkedHashSet<String>()

            // 已连接设备：遍历常用 profile（A2DP 音频 / HEADSET 耳机 / HID 键鼠 / GATT BLE）
            val profiles = intArrayOf(
                BluetoothProfile.A2DP,
                BluetoothProfile.HEADSET,
                BluetoothProfile.HID_DEVICE,
                BluetoothProfile.GATT
            )
            val profileNames = mapOf(
                BluetoothProfile.A2DP to "A2DP 音频",
                BluetoothProfile.HEADSET to "耳机",
                BluetoothProfile.HID_DEVICE to "键鼠",
                BluetoothProfile.GATT to "BLE"
            )
            val connectedProfiles = HashMap<String, MutableList<String>>()
            for (p in profiles) {
                // ★ 关键修复：部分 ROM 未注册某些 Profile 服务时 getConnectedDevices 会抛
                //   IllegalArgumentException("Profile not supported: N")，
                //   必须逐 profile 捕获并跳过，否则整个设备列表读取失败
                try {
                    val connDevices = bluetoothManager?.getConnectedDevices(p) ?: emptyList()
                    for (d in connDevices) {
                        if (seen.add(d.address)) {
                            devices.put(deviceToJson(d, "connected", profileNames[p] ?: "未知", true))
                        }
                        // 记录该地址已连接的 profile
                        connectedProfiles.getOrPut(d.address) { mutableListOf() }.add(profileNames[p] ?: "")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Profile ${profileNames[p] ?: p} 查询被跳过: ${e.message}")
                }
            }
            // 为已连接设备补充多 profile 标注（如既是耳机又是媒体音频）
            for (i in 0 until devices.length()) {
                val obj = devices.getJSONObject(i)
                val addr = obj.optString("address")
                val profs = connectedProfiles[addr]
                if (profs != null && profs.size > 1) {
                    obj.put("profileName", profs.joinToString("/"))
                }
            }

            // 已配对设备（未连接）
            val bonded = adapter?.bondedDevices ?: emptySet()
            for (d in bonded) {
                if (seen.add(d.address)) {
                    devices.put(deviceToJson(d, "paired", "", false))
                }
            }

            val result = JSONObject()
            result.put("ok", true)
            result.put("connectedCount", devices.length())
            result.put("devices", devices)
            result.toString()
        } catch (e: Exception) {
            Log.e(TAG, "读取设备列表失败: ${e.message}")
            "{\"ok\":false,\"error\":${JSONObject.quote(e.message ?: "读取失败")}}"
        }
    }

    private fun deviceToJson(device: BluetoothDevice, type: String, profileName: String, isConnected: Boolean): JSONObject {
        return JSONObject().apply {
            put("name", device.name ?: "未知设备")
            put("address", device.address)
            put("type", type)
            put("profileName", profileName)
            put("isConnected", isConnected)
        }
    }

    // ---------------------------------------------------------------
    // 2. 经典蓝牙 SPP 串口发送（真实控制）
    // ---------------------------------------------------------------

    /**
     * 向指定地址的经典蓝牙设备发送文本/二进制数据（SPP 串口）。
     * 首次发送会自动建立连接并保持（keepOpen），连续控制无需反复连接。
     * 阻塞 IO 在后台线程执行，立即返回"已启动"。
     */
    fun sendSppData(deviceAddress: String, data: String): Boolean {
        if (!hasConnectPermission()) return false
        val adapter = adapter ?: return false
        return try {
            val device = adapter.getRemoteDevice(deviceAddress)
            Thread {
                try {
                    if (sppSocket == null || !sppSocket!!.isConnected) {
                        val socket = device.createRfcommSocketToServiceRecord(SPP_UUID)
                        socket.connect()
                        sppSocket = socket
                        Log.d(TAG, "SPP 已连接: ${device.name ?: deviceAddress}")
                    }
                    val out = sppSocket!!.outputStream
                    out.write(data.toByteArray(Charsets.UTF_8))
                    out.flush()
                    Log.d(TAG, "SPP 数据已发送: ${data.take(80)}")
                } catch (e: Exception) {
                    Log.e(TAG, "SPP 发送失败: ${e.message}")
                    try { sppSocket?.close() } catch (_: Exception) {}
                    sppSocket = null
                }
            }.start()
            true
        } catch (e: Exception) {
            Log.e(TAG, "SPP 发送启动失败: ${e.message}")
            false
        }
    }

    fun disconnectSpp(): Boolean {
        return try {
            sppSocket?.close()
            sppSocket = null
            true
        } catch (e: Exception) {
            Log.e(TAG, "SPP 断开失败: ${e.message}")
            false
        }
    }

    fun isSppConnected(): Boolean = sppSocket?.isConnected == true

    // ---------------------------------------------------------------
    // 3. BLE 扫描
    // ---------------------------------------------------------------

    /**
     * 启动 BLE 扫描（timeoutMs 后自动停止），扫描结果存缓存供 getBleScanResults 拉取。
     * 返回：{"ok":true,"scanning":true,"timeoutMs":N}
     */
    fun scanBleDevices(timeoutMs: Long): String {
        if (!hasScanPermission()) return ERR_NO_PERMISSION
        return try {
            val scanner = adapter?.bluetoothLeScanner
                ?: return "{\"ok\":false,\"error\":\"设备不支持 BLE 扫描\"}"
            val results = JSONArray()
            val seen = HashSet<String>()
            val callback = object : android.bluetooth.le.ScanCallback() {
                override fun onScanResult(callbackType: Int, result: android.bluetooth.le.ScanResult) {
                    val dev = result.device
                    if (dev != null && seen.add(dev.address)) {
                        try {
                            results.put(JSONObject().apply {
                                put("name", dev.name ?: result.scanRecord?.deviceName ?: "未知设备")
                                put("address", dev.address)
                                put("rssi", result.rssi)
                            })
                        } catch (e: Exception) {}
                    }
                }

                override fun onScanFailed(errorCode: Int) {
                    Log.e(TAG, "BLE 扫描失败, errorCode=$errorCode")
                }
            }
            scanner.startScan(callback)
            mainHandler.postDelayed({
                try { scanner.stopScan(callback) } catch (e: Exception) {}
                lastBleScanResults = try {
                    val obj = JSONObject()
                    obj.put("ok", true)
                    obj.put("devices", results)
                    obj.toString()
                } catch (e: Exception) {
                    "{\"ok\":false,\"error\":\"扫描结果解析失败\"}"
                }
            }, timeoutMs)
            "{\"ok\":true,\"scanning\":true,\"timeoutMs\":$timeoutMs}"
        } catch (e: Exception) {
            "{\"ok\":false,\"error\":${JSONObject.quote(e.message ?: "扫描失败")}}"
        }
    }

    fun getBleScanResults(): String = lastBleScanResults ?: "{\"ok\":false,\"error\":\"尚未执行过 BLE 扫描\"}"

    // ---------------------------------------------------------------
    // 4. BLE 特征值写入（真实控制 BLE 设备）
    // ---------------------------------------------------------------

    /**
     * 连接指定 BLE 设备并写入特征值。
     * dataHex：支持 "AABB11" / "AA BB 11" / "0xAA,0xBB" / 普通文本（自动按 UTF-8 编码）
     */
    fun bleConnectAndWrite(deviceAddress: String, serviceUuid: String, charUuid: String, dataHex: String): String {
        if (!hasConnectPermission()) return ERR_NO_PERMISSION
        return try {
            val device = adapter?.getRemoteDevice(deviceAddress)
                ?: return "{\"ok\":false,\"error\":\"设备不存在\"}"
            val serviceU = UUID.fromString(serviceUuid)
            val charU = UUID.fromString(charUuid)
            val value = parseWriteData(dataHex)

            // 断开旧连接
            try { gatt?.disconnect(); gatt?.close() } catch (e: Exception) {}
            gatt = device.connectGatt(context, false, object : BluetoothGattCallback() {
                override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        Log.d(TAG, "BLE 已连接: $deviceAddress")
                        g.discoverServices()
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        try { g.close() } catch (e: Exception) {}
                        if (gatt === g) gatt = null
                    }
                }

                override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        lastBleWriteResult = "{\"ok\":false,\"error\":\"服务发现失败 status=$status\"}"
                        try { g.disconnect(); g.close() } catch (e: Exception) {}
                        return
                    }
                    val service = g.getService(serviceU)
                    val char = service?.getCharacteristic(charU)
                    if (char == null) {
                        lastBleWriteResult = "{\"ok\":false,\"error\":\"未找到特征值 $serviceUuid/$charUuid\"}"
                        try { g.disconnect(); g.close() } catch (e: Exception) {}
                        return
                    }
                    writeChar(g, char, value)
                }

                override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
                    lastBleWriteResult = if (status == BluetoothGatt.GATT_SUCCESS) {
                        "{\"ok\":true,\"bytes\":${value.size}}"
                    } else {
                        "{\"ok\":false,\"error\":\"写入失败 status=$status\"}"
                    }
                    try { g.disconnect(); g.close() } catch (e: Exception) {}
                    if (gatt === g) gatt = null
                }
            })
            "{\"ok\":true,\"connecting\":true}"
        } catch (e: Exception) {
            "{\"ok\":false,\"error\":${JSONObject.quote(e.message ?: "BLE 写入失败")}}"
        }
    }

    private fun writeChar(g: BluetoothGatt, char: BluetoothGattCharacteristic, value: ByteArray) {
        if (Build.VERSION.SDK_INT >= 33) {
            g.writeCharacteristic(char, value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)
        } else {
            @Suppress("DEPRECATION")
            char.value = value
            @Suppress("DEPRECATION")
            g.writeCharacteristic(char)
        }
    }

    fun getBleWriteResult(): String = lastBleWriteResult ?: "{\"ok\":false,\"error\":\"尚无写入记录\"}"

    private fun parseWriteData(raw: String): ByteArray {
        val trimmed = raw.trim()
        // 形如 "AA BB" / "0xAA,0xBB" / "AABB11" 视为十六进制
        val cleaned = trimmed.replace("0x", "").replace(",", "").replace(" ", "")
        if (cleaned.matches(Regex("[0-9a-fA-F]+")) && cleaned.length % 2 == 0 && cleaned.isNotEmpty()) {
            return cleaned.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        }
        // 否则按 UTF-8 文本发送
        return trimmed.toByteArray(Charsets.UTF_8)
    }

    // ---------------------------------------------------------------
    // 5. 系统蓝牙开关（Android 13+ 受限）
    // ---------------------------------------------------------------

    fun setBluetoothEnabled(on: Boolean): String {
        val adapter = adapter ?: return "{\"ok\":false,\"error\":\"设备不支持蓝牙\"}"
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Android 13+ 禁止普通应用直接开关系统蓝牙
                return "{\"ok\":false,\"error\":\"Android 13+ 系统安全限制：请在系统设置中手动开关蓝牙，或授予本应用'附近设备'权限后由用户确认\"}"
            }
            @Suppress("DEPRECATION")
            val ok = if (on) adapter.enable() else adapter.disable()
            "{\"ok\":$ok}"
        } catch (e: Exception) {
            "{\"ok\":false,\"error\":${JSONObject.quote(e.message ?: "开关失败")}}"
        }
    }

    fun isBluetoothEnabled(): Boolean {
        return try { adapter?.isEnabled == true } catch (e: Exception) { false }
    }

    // ---------------------------------------------------------------
    // 6. 真实电量读取
    // ---------------------------------------------------------------

    /** 返回 {"ok":true,"level":87,"charging":true,"status":"充电中"} */
    fun getBatteryStatusJson(): String {
        return try {
            val level: Int
            var status: Int = -1
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val bm = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
                level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
                status = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_STATUS)
            } else {
                val intent = context.registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
                val raw = intent?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
                val scale = intent?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, 100) ?: 100
                level = if (scale > 0) (raw * 100 / scale) else -1
                status = intent?.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1) ?: -1
            }
            val charging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                status == android.os.BatteryManager.BATTERY_STATUS_FULL
            val statusText = when (status) {
                android.os.BatteryManager.BATTERY_STATUS_CHARGING -> "充电中"
                android.os.BatteryManager.BATTERY_STATUS_FULL -> "已充满"
                android.os.BatteryManager.BATTERY_STATUS_DISCHARGING -> "使用中"
                else -> "未充电"
            }
            val obj = JSONObject()
            obj.put("ok", true)
            obj.put("level", level)
            obj.put("charging", charging)
            obj.put("status", statusText)
            obj.toString()
        } catch (e: Exception) {
            Log.e(TAG, "读取电量失败: ${e.message}")
            "{\"ok\":false,\"error\":${JSONObject.quote(e.message ?: "电量读取失败")}}"
        }
    }

    // 确保进程退出前释放资源
    fun onDestroy() {
        try {
            sppSocket?.close()
        } catch (e: Exception) {}
        sppSocket = null
        try {
            gatt?.disconnect()
            gatt?.close()
        } catch (e: Exception) {}
        gatt = null
    }
}
