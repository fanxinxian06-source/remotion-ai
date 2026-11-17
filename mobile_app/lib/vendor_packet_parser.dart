class WearableReading {
  const WearableReading({
    required this.ppg,
    required this.acc,
    required this.gyro,
    required this.mag,
  });

  final double ppg;
  final List<double> acc;
  final List<double> gyro;
  final List<double> mag;
}

class WearablePacket {
  const WearablePacket({this.readings = const [], this.battery});

  final List<WearableReading> readings;
  final int? battery;
}

WearablePacket parseVendorNotification(List<int> data) {
  if (data.length >= 7 &&
      data[0] == 66 &&
      data[1] == 65 &&
      data[2] == 84 &&
      data[3] == 84) {
    return WearablePacket(battery: data[6].clamp(0, 100).toInt());
  }

  const frameLength = 20;
  final readings = <WearableReading>[];
  for (var offset = 0; offset + frameLength <= data.length; offset += frameLength) {
    final ppg = data[offset] | (data[offset + 1] << 8);
    final axes = <double>[];
    for (var axisOffset = 2; axisOffset < frameLength; axisOffset += 2) {
      axes.add(_halfToDouble(data[offset + axisOffset] |
          (data[offset + axisOffset + 1] << 8)));
    }
    if (axes.length != 9 || !ppg.isFinite || axes.any((value) => !value.isFinite)) {
      throw const FormatException('Invalid EmoConnect sensor frame.');
    }
    readings.add(WearableReading(
      ppg: ppg.toDouble(),
      acc: axes.sublist(0, 3),
      gyro: axes.sublist(3, 6),
      mag: axes.sublist(6, 9),
    ));
  }
  return WearablePacket(readings: readings);
}

double _halfToDouble(int bits) {
  final sign = (bits & 0x8000) == 0 ? 1.0 : -1.0;
  final exponent = (bits >> 10) & 0x1f;
  final fraction = bits & 0x03ff;
  if (exponent == 0x1f) {
    throw const FormatException('Non-finite EmoConnect sensor value.');
  }
  if (exponent == 0) {
    return sign * (fraction / 1024.0) * (1 / 16384.0);
  }
  return sign * (1 + fraction / 1024.0) * _powerOfTwo(exponent - 15);
}

double _powerOfTwo(int exponent) {
  return exponent >= 0
      ? (1 << exponent).toDouble()
      : 1 / (1 << -exponent).toDouble();
}
