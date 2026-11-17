import 'package:flutter_test/flutter_test.dart';
import 'package:smartfactory_guard_mobile/vendor_packet_parser.dart';

void main() {
  test('parses vendor PPG and 9-axis half-float frames', () {
    final data = List<int>.filled(20, 0);
    data[0] = 0x34;
    data[1] = 0x12;
    for (final offset in [2, 8, 14]) {
      data[offset] = 0x00;
      data[offset + 1] = 0x3c; // 1.0
    }
    for (final offset in [4, 10, 16]) {
      data[offset] = 0x00;
      data[offset + 1] = 0xc0; // -2.0
    }
    for (final offset in [6, 12, 18]) {
      data[offset] = 0x00;
      data[offset + 1] = 0x42; // 3.0
    }

    final packet = parseVendorNotification(data);
    expect(packet.readings, hasLength(1));
    expect(packet.readings.single.ppg, 0x1234);
    expect(packet.readings.single.acc, [1, -2, 3]);
    expect(packet.readings.single.gyro, [1, -2, 3]);
    expect(packet.readings.single.mag, [1, -2, 3]);
  });

  test('parses battery packets and ignores incomplete sensor tails', () {
    final battery = parseVendorNotification([66, 65, 84, 84, 0, 0, 105]);
    expect(battery.battery, 100);
    expect(battery.readings, isEmpty);
    expect(parseVendorNotification([1, 2, 3]).readings, isEmpty);
  });

  test('rejects non-finite values in vendor sensor data', () {
    final data = List<int>.filled(20, 0);
    data[3] = 0x7c; // IEEE-754 half-float infinity
    expect(() => parseVendorNotification(data), throwsFormatException);
  });
}
