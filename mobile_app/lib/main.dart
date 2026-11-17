import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_reactive_ble/flutter_reactive_ble.dart';
import 'package:newert_vitaltrack/src/processing.dart';
import 'package:permission_handler/permission_handler.dart';

import 'vendor_packet_parser.dart';

const relayBaseUrl = String.fromEnvironment('RELAY_BASE_URL');

void main() {
  runApp(const SmartFactoryGuardApp());
}

class SmartFactoryGuardApp extends StatelessWidget {
  const SmartFactoryGuardApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ReMotion-K 手表',
      theme: ThemeData(colorSchemeSeed: Colors.teal, useMaterial3: true),
      home: const WearableHomePage(),
    );
  }
}

class WearableHomePage extends StatefulWidget {
  const WearableHomePage({super.key});

  @override
  State<WearableHomePage> createState() => _WearableHomePageState();
}

class _WearableHomePageState extends State<WearableHomePage> {
  final _ble = FlutterReactiveBle();
  final _baseUrlController = TextEditingController(text: relayBaseUrl);
  final _pairingCodeController = TextEditingController();
  final _devices = <String, DiscoveredDevice>{};
  final _ppg = <double>[];
  final _acc = <List<double>>[];
  final _gyro = <List<double>>[];
  final _mag = <List<double>>[];
  double? _latestPpg;
  List<double>? _latestAcc;
  List<double>? _latestGyro;
  List<double>? _latestMag;

  StreamSubscription<DiscoveredDevice>? _scanSubscription;
  StreamSubscription<ConnectionStateUpdate>? _connectionSubscription;
  StreamSubscription<List<int>>? _dataSubscription;
  Timer? _flushTimer;
  Uri? _relayBaseUri;
  String? _accessToken;
  String? _error;
  String _status = '尚未连接设备。';
  DiscoveredDevice? _device;
  int? _battery;
  bool _isScanning = false;
  bool _isConnected = false;
  bool _isMeasuring = false;
  bool _disconnecting = false;
  Future<void>? _flushOperation;

  Uuid get _uartServiceId => Uuid.parse(NewertUUID().uartServiceUuid);
  Uuid get _ppgServiceId => Uuid.parse(NewertUUID().ppgServiceUuid);
  Uuid get _batteryServiceId => Uuid.parse(NewertUUID().battServiceUuid);
  Uuid get _ppgCharacteristicId =>
      Uuid.parse(NewertUUID().readPPGCharacteristicUuid);
  Uuid get _uartWriteCharacteristicId =>
      Uuid.parse(NewertUUID().writeUartCharacteristicUuid);

  @override
  void dispose() {
    _flushTimer?.cancel();
    unawaited(_scanSubscription?.cancel());
    unawaited(_dataSubscription?.cancel());
    unawaited(_connectionSubscription?.cancel());
    _baseUrlController.dispose();
    _pairingCodeController.dispose();
    super.dispose();
  }

  Uri _validatedBaseUri() {
    final uri = Uri.tryParse(_baseUrlController.text.trim());
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.path.isNotEmpty && uri.path != '/' ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw const FormatException(
        '请输入 HTTPS 服务地址，例如 https://safety.example.com',
      );
    }
    return uri;
  }

  Future<void> _signIn() async {
    setState(() => _error = null);
    try {
      _relayBaseUri = _validatedBaseUri();
      final result = await _postJson('/api/session', {
        'pairingCode': _pairingCodeController.text,
      }, includeAuth: false);
      final token = result['accessToken'];
      if (token is! String || token.isEmpty) {
        throw const FormatException('服务未返回有效登录会话。');
      }
      _pairingCodeController.clear();
      if (!mounted) return;
      setState(() {
        _accessToken = token;
      });
    } catch (error) {
      _showError('登录失败：$error');
    }
  }

  Future<Map<String, dynamic>> _postJson(
    String path,
    Map<String, Object?> body, {
    bool includeAuth = true,
  }) async {
    final baseUri = _relayBaseUri;
    if (baseUri == null) throw StateError('请先登录数据服务。');
    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 10);
    try {
      final request = await client.postUrl(baseUri.resolve(path));
      request.headers.contentType = ContentType.json;
      if (includeAuth) {
        final token = _accessToken;
        if (token == null) throw StateError('登录会话已结束。');
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      }
      request.write(jsonEncode(body));
      final response = await request.close().timeout(
        const Duration(seconds: 15),
      );
      final responseBody = await utf8.decoder.bind(response).join();
      final decoded = responseBody.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(responseBody) as Map<String, dynamic>;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw HttpException(
          decoded['error'] is String
              ? decoded['error'] as String
              : '服务请求失败（HTTP ${response.statusCode}）。',
        );
      }
      return decoded;
    } finally {
      client.close(force: true);
    }
  }

  Future<bool> _requestBluetoothPermissions() async {
    if (!Platform.isAndroid) {
      _showError('此客户端目前仅提供 Android 支持。');
      return false;
    }
    final android = await DeviceInfoPlugin().androidInfo;
    final permissions = android.version.sdkInt >= 31
        ? [Permission.bluetoothScan, Permission.bluetoothConnect]
        : [Permission.locationWhenInUse];
    final result = await permissions.request();
    if (result.values.any((status) => !status.isGranted)) {
      _showError('蓝牙权限未获准，无法搜索设备。');
      return false;
    }
    return true;
  }

  Future<void> _startScan() async {
    if (_isScanning) return;
    if (!await _requestBluetoothPermissions()) return;
    if (_ble.status != BleStatus.ready) {
      _showError('手机蓝牙不可用或未开启。');
      return;
    }

    await _scanSubscription?.cancel();
    setState(() {
      _error = null;
      _devices.clear();
      _isScanning = true;
      _status = '正在搜索 EmoConnect…';
    });
    unawaited(_reportStatus('scanning'));
    try {
      _scanSubscription = _ble
          .scanForDevices(
            withServices: [_uartServiceId, _ppgServiceId, _batteryServiceId],
            scanMode: ScanMode.lowLatency,
          )
          .listen(
            (device) {
              if (!mounted) return;
              setState(() => _devices[device.id] = device);
            },
            onError: (Object error) {
              if (!mounted) return;
              setState(() {
                _isScanning = false;
                _status = '搜索已停止。';
                _error = '蓝牙搜索失败：$error';
              });
              unawaited(_reportStatus('error', message: 'BLE scan failed.'));
            },
          );
    } catch (error) {
      _showError('无法开始蓝牙搜索：$error');
      unawaited(_reportStatus('error', message: 'BLE scan failed.'));
    }
  }

  Future<void> _stopScan() async {
    await _scanSubscription?.cancel();
    _scanSubscription = null;
    if (!mounted) return;
    setState(() {
      _isScanning = false;
      _status = '已停止搜索。';
    });
    unawaited(_reportStatus('disconnected'));
  }

  Future<void> _connect(DiscoveredDevice device) async {
    await _scanSubscription?.cancel();
    setState(() {
      _isScanning = false;
      _error = null;
      _device = device;
      _status = '正在连接 ${_displayName(device)}…';
    });
    unawaited(_reportStatus('connecting', deviceName: _displayName(device)));

    await _connectionSubscription?.cancel();
    _connectionSubscription = _ble
        .connectToDevice(
          id: device.id,
          connectionTimeout: const Duration(seconds: 15),
        )
        .listen(
          (update) {
            if (update.connectionState == DeviceConnectionState.connected) {
              unawaited(_onConnected(device));
            } else if (update.connectionState ==
                    DeviceConnectionState.disconnected &&
                !_disconnecting) {
              unawaited(_onDisconnected());
            }
          },
          onError: (Object error) {
            if (!mounted) return;
            setState(() {
              _isConnected = false;
              _isMeasuring = false;
              _status = '连接失败。';
              _error = 'BLE 连接失败：$error';
            });
            unawaited(
              _reportStatus(
                'error',
                deviceName: _displayName(device),
                message: 'BLE connection failed.',
              ),
            );
          },
        );
  }

  Future<void> _onConnected(DiscoveredDevice device) async {
    try {
      final services = await _ble.getDiscoveredServices(device.id);
      final hasPpgService = services.any(
        (service) => service.id == _ppgServiceId,
      );
      final hasPpgCharacteristic = services.any(
        (service) =>
            service.id == _ppgServiceId &&
            service.characteristics.any(
              (characteristic) => characteristic.id == _ppgCharacteristicId,
            ),
      );
      if (!hasPpgService || !hasPpgCharacteristic) {
        throw StateError('已连接设备未提供 SDK 示例所需的 PPG 数据通道。');
      }

      final characteristic = QualifiedCharacteristic(
        serviceId: _ppgServiceId,
        characteristicId: _ppgCharacteristicId,
        deviceId: device.id,
      );
      await _dataSubscription?.cancel();
      _dataSubscription = _ble
          .subscribeToCharacteristic(characteristic)
          .listen(
            _handleNotification,
            onError: (Object error) {
              _showError('设备数据订阅失败：$error');
              unawaited(
                _reportStatus(
                  'error',
                  deviceName: _displayName(device),
                  message: 'Sensor stream failed.',
                ),
              );
            },
          );

      if (!mounted) return;
      setState(() {
        _isConnected = true;
        _device = device;
        _status = '已连接 ${_displayName(device)}。点击“开始采集”后读取传感器数据。';
      });
      unawaited(_reportStatus('connected', deviceName: _displayName(device)));
    } catch (error) {
      _showError('设备服务初始化失败：$error');
      unawaited(
        _reportStatus(
          'error',
          deviceName: _displayName(device),
          message: 'Device service initialization failed.',
        ),
      );
      await _disconnect();
    }
  }

  void _handleNotification(List<int> data) {
    try {
      final packet = parseVendorNotification(data);
      if (packet.battery != null && mounted) {
        setState(() => _battery = packet.battery);
      }
      if (!_isMeasuring) return;
      for (final reading in packet.readings) {
        _latestPpg = reading.ppg;
        _latestAcc = reading.acc;
        _latestGyro = reading.gyro;
        _latestMag = reading.mag;
        if (_accessToken != null) {
          _ppg.add(reading.ppg);
          _acc.add(reading.acc);
          _gyro.add(reading.gyro);
          _mag.add(reading.mag);
        }
      }
    } on FormatException catch (error) {
      _showError('设备返回了无效数据：$error');
    }
  }

  Future<void> _startMeasurement() async {
    if (!_isConnected || _device == null || _isMeasuring) return;
    try {
      await _writeCommand(CMD.ON_1V8);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await _writeCommand(CMD.START_PPG);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      await _writeCommand(CMD.SETUP_DATA);
      _ppg.clear();
      _acc.clear();
      _gyro.clear();
      _mag.clear();
      _flushTimer?.cancel();
      _flushTimer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
        unawaited(_flushSensorBatch());
      });
      setState(() {
        _isMeasuring = true;
        _status = _accessToken == null
            ? '正在采集；数据仅显示在此手机上。'
            : '正在采集 PPG 和 9 轴 IMU，并转发到已登录的数据服务。';
      });
      unawaited(_reportStatus('measuring', deviceName: _displayName(_device!)));
    } catch (error) {
      _showError('无法开始设备采集：$error');
      unawaited(_reportStatus('error', message: 'Measurement start failed.'));
    }
  }

  Future<void> _stopMeasurement() async {
    _flushTimer?.cancel();
    _flushTimer = null;
    final wasMeasuring = _isMeasuring;
    if (mounted) {
      setState(() {
        _isMeasuring = false;
        if (wasMeasuring) _status = '采集已停止。';
      });
    }
    if (wasMeasuring) {
      try {
        await _writeCommand(CMD.STOP_PPG);
      } catch (error) {
        _showError('停止设备采集失败：$error');
      }
      await _flushSensorBatch();
    }
  }

  Future<void> _writeCommand(String command) async {
    final device = _device;
    if (device == null) throw StateError('未连接设备。');
    final characteristic = QualifiedCharacteristic(
      serviceId: _uartServiceId,
      characteristicId: _uartWriteCharacteristicId,
      deviceId: device.id,
    );
    await _ble.writeCharacteristicWithResponse(
      characteristic,
      value: ascii.encode(command),
    );
  }

  Future<void> _flushSensorBatch() async {
    if (_accessToken == null) return;
    final inFlight = _flushOperation;
    if (inFlight != null) await inFlight;
    if (_ppg.isEmpty && _acc.isEmpty && _gyro.isEmpty && _mag.isEmpty) return;
    final operation = _sendSensorBatch();
    _flushOperation = operation;
    try {
      await operation;
    } finally {
      if (identical(_flushOperation, operation)) _flushOperation = null;
    }
  }

  Future<void> _sendSensorBatch() async {
    final ppg = List<double>.of(_ppg);
    final acc = List<List<double>>.of(_acc);
    final gyro = List<List<double>>.of(_gyro);
    final mag = List<List<double>>.of(_mag);
    _ppg.clear();
    _acc.clear();
    _gyro.clear();
    _mag.clear();
    final payload = <String, Object?>{
      'timestamp': DateTime.now().toUtc().toIso8601String(),
      'deviceName': _device == null ? 'EmoConnect' : _displayName(_device!),
      if (ppg.isNotEmpty) 'ppg': ppg,
      if (acc.isNotEmpty) 'acc': acc,
      if (gyro.isNotEmpty) 'gyro': gyro,
      if (mag.isNotEmpty) 'mag': mag,
      if (_battery != null) 'battery': _battery,
    };
    try {
      await _postJson('/api/watch/sample', payload);
      if (mounted && _error?.startsWith('数据转发失败：') == true) {
        setState(() {
          _error = null;
          _status = '设备数据已实时转发到安全看板。';
        });
      }
    } catch (error) {
      _showError('数据转发失败：$error');
    }
  }

  Future<void> _reportStatus(
    String state, {
    String? deviceName,
    String? message,
  }) async {
    if (_accessToken == null) return;
    try {
      await _postJson('/api/watch/status', {
        'state': state,
        if (deviceName != null) 'deviceName': deviceName,
        if (message != null) 'message': message,
      });
    } catch (error) {
      _showError('状态同步失败：$error');
    }
  }

  Future<void> _disconnect() async {
    _disconnecting = true;
    await _stopMeasurement();
    await _scanSubscription?.cancel();
    _scanSubscription = null;
    await _dataSubscription?.cancel();
    _dataSubscription = null;
    await _connectionSubscription?.cancel();
    _connectionSubscription = null;
    _device = null;
    _battery = null;
    _latestPpg = null;
    _latestAcc = null;
    _latestGyro = null;
    _latestMag = null;
    if (mounted) {
      setState(() {
        _isConnected = false;
        _isScanning = false;
        _isMeasuring = false;
        _status = '设备已断开。';
      });
    }
    await _reportStatus('disconnected');
    _disconnecting = false;
  }

  Future<void> _onDisconnected() async {
    _flushTimer?.cancel();
    _flushTimer = null;
    _isMeasuring = false;
    await _flushSensorBatch();
    await _dataSubscription?.cancel();
    _dataSubscription = null;
    if (!mounted) return;
    setState(() {
      _isConnected = false;
      _isMeasuring = false;
      _device = null;
      _battery = null;
      _latestPpg = null;
      _latestAcc = null;
      _latestGyro = null;
      _latestMag = null;
      _status = 'EmoConnect 已断开。';
    });
    unawaited(_reportStatus('disconnected'));
  }

  Future<void> _signOut() async {
    final token = _accessToken;
    if (token != null) {
      try {
        await _postJson('/api/session/revoke', {});
      } catch (error) {
        _showError('退出登录时撤销会话失败：$error');
      }
    }
    if (!mounted) return;
    setState(() {
      _accessToken = null;
      _ppg.clear();
      _acc.clear();
      _gyro.clear();
      _mag.clear();
      if (_isMeasuring) _status = '正在采集；数据仅显示在此手机上。';
    });
  }

  void _showError(String message) {
    if (!mounted) return;
    setState(() => _error = _error == null ? message : '$_error\n$message');
  }

  String _displayName(DiscoveredDevice device) =>
      device.name.isEmpty ? 'EmoConnect 设备' : device.name;

  String _formatVector(List<double>? values) => values == null
      ? '等待采集'
      : values.map((value) => value.toStringAsFixed(2)).join(', ');

  Widget _buildRelaySettings() {
    final isSignedIn = _accessToken != null;
    return Card(
      child: ExpansionTile(
        leading: Icon(isSignedIn ? Icons.cloud_done : Icons.cloud_outlined),
        title: Text(isSignedIn ? '数据中继已登录' : '可选：转发数据到 HTTPS 中继'),
        subtitle: Text(
          isSignedIn ? _relayBaseUri?.host ?? '' : '不登录也能连接手表并在手机本地查看',
        ),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        children: isSignedIn
            ? [
                const Text('采集数据会发送至此中继服务。退出登录后，采集数据只显示在本机。'),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: _signOut,
                  icon: const Icon(Icons.logout),
                  label: const Text('退出中继'),
                ),
              ]
            : [
                const Align(
                  alignment: Alignment.centerLeft,
                  child: Text('仅在你配置并授权数据服务后才需要登录。配对码只用于建立短期会话，不会保存到磁盘。'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _baseUrlController,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'HTTPS 数据服务地址',
                    hintText: 'https://safety.example.com',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _pairingCodeController,
                  obscureText: true,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: '配对码',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton(onPressed: _signIn, child: const Text('登录数据中继')),
              ],
      ),
    );
  }

  Widget _buildDeviceTab() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Card(
          child: ListTile(
            leading: Icon(
              _isMeasuring
                  ? Icons.sensors
                  : _isConnected
                  ? Icons.watch
                  : Icons.bluetooth_searching,
              color: _isConnected ? Colors.teal : null,
            ),
            title: Text(
              _device == null ? 'DPF eMoConnect' : _displayName(_device!),
            ),
            subtitle: Text(_status),
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Card(
            color: Theme.of(context).colorScheme.errorContainer,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(_error!),
            ),
          ),
        ],
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('手表传感器数据', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                if (_battery != null) Text('设备电量：$_battery%'),
                Text('PPG 原始值：${_latestPpg?.toStringAsFixed(0) ?? '等待采集'}'),
                Text('加速度 XYZ：${_formatVector(_latestAcc)}'),
                Text('角速度 XYZ：${_formatVector(_latestGyro)}'),
                Text('磁场 XYZ：${_formatVector(_latestMag)}'),
                const SizedBox(height: 8),
                const Text(
                  '点击开始采集后读取原始传感器数据；公开 SDK 示例不提供计算心率。数据默认只显示在手机上，不代表医疗诊断。',
                  style: TextStyle(fontSize: 12),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        if (!_isConnected) ...[
          FilledButton.icon(
            onPressed: _isScanning ? null : _startScan,
            icon: const Icon(Icons.bluetooth_searching),
            label: Text(_isScanning ? '正在搜索…' : '搜索 EmoConnect'),
          ),
          if (_isScanning)
            OutlinedButton(onPressed: _stopScan, child: const Text('停止搜索')),
        ] else ...[
          FilledButton(
            onPressed: _isMeasuring ? _stopMeasurement : _startMeasurement,
            child: Text(_isMeasuring ? '停止采集' : '开始采集'),
          ),
          OutlinedButton(onPressed: _disconnect, child: const Text('断开设备')),
        ],
        if (_devices.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text('附近设备', style: Theme.of(context).textTheme.titleMedium),
          for (final device in _devices.values)
            Card(
              child: ListTile(
                leading: const Icon(Icons.watch),
                title: Text(_displayName(device)),
                subtitle: Text('信号强度 ${device.rssi} dBm'),
                trailing: const Icon(Icons.chevron_right),
                onTap: _isConnected ? null : () => _connect(device),
              ),
            ),
        ],
        const SizedBox(height: 12),
        _buildRelaySettings(),
        const SizedBox(height: 8),
        const Text(
          '本应用是手机端配套程序，按 Newert 公开 Flutter SDK 示例连接 DPF eMoConnect；尚未在你的手表上完成实机验证。标准 BLE 心率连接与本 eMoConnect 方案不同。',
          style: TextStyle(fontSize: 12),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('ReMotion-K 手表')),
      body: _buildDeviceTab(),
    );
  }
}
