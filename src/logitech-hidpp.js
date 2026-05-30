const REPORT = Object.freeze({
  SHORT: 0x10,
  LONG: 0x11,
  VERY_LONG: 0x12,
});

const REPORT_LENGTH = Object.freeze({
  [REPORT.SHORT]: 7,
  [REPORT.LONG]: 20,
  [REPORT.VERY_LONG]: 64,
});

const PARAM_LENGTH = Object.freeze({
  [REPORT.SHORT]: 3,
  [REPORT.LONG]: 16,
  [REPORT.VERY_LONG]: 60,
});

const HIDPP10_ERROR = 0x8f;
const HIDPP20_ERROR = 0xff;

const FEATURE = Object.freeze({
  ROOT: 0x0000,
  FEATURE_SET: 0x0001,
  DEVICE_INFO: 0x0003,
  BATTERY_LEVEL_STATUS: 0x1000,
  ADJUSTABLE_DPI: 0x2201,
  ADJUSTABLE_DPI_ADVANCED: 0x2202,
  ADJUSTABLE_REPORT_RATE: 0x8060,
  ONBOARD_PROFILES: 0x8100,
});

const FEATURE_NAMES = new Map([
  [0x0000, "Root"],
  [0x0001, "Feature set"],
  [0x0003, "Device/Firmware info"],
  [0x1000, "Battery level status"],
  [0x2201, "Adjustable DPI"],
  [0x2202, "Adjustable DPI advanced"],
  [0x8060, "Adjustable report rate"],
  [0x8071, "RGB effects"],
  [0x8100, "On-board profiles"],
]);

const ONBOARD_MODE = Object.freeze({
  NO_CHANGE: 0,
  ONBOARD: 1,
  HOST: 2,
});

const ONBOARD_MEMORY_TYPE = Object.freeze({
  WRITEABLE: 0,
  ROM: 1,
});

const DEFAULT_FILTERS = Object.freeze([
  { vendorId: 0x046d, productId: 0xc0a8 },
  { vendorId: 0x046d, productId: 0xc54d },
  { vendorId: 0x046d, productId: 0xab24 },
  { vendorId: 0x046d },
]);

const DIRECT_WIRED_PRODUCT_IDS = Object.freeze(new Set([0xc0a8]));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hex(value, width = 2) {
  return `0x${Number(value).toString(16).padStart(width, "0")}`;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
}

function parseHexBytes(input) {
  const clean = input
    .trim()
    .replace(/(?:0x|,|;|\[|\])/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!clean.length) return [];
  return clean.map((part) => {
    const value = Number.parseInt(part, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error(`Invalid byte: ${part}`);
    }
    return value;
  });
}

function readU16BE(bytes, offset) {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function writeU16BE(bytes, offset, value) {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function readU16LE(bytes, offset) {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function writeU16LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= (byte & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function reportTypeForParamCount(count) {
  if (count <= PARAM_LENGTH[REPORT.SHORT]) return REPORT.SHORT;
  if (count <= PARAM_LENGTH[REPORT.LONG]) return REPORT.LONG;
  if (count <= PARAM_LENGTH[REPORT.VERY_LONG]) return REPORT.VERY_LONG;
  throw new Error(`Too many HID++ parameters: ${count}`);
}

function normalizeIncomingReport(reportId, dataView) {
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
  const expectedWithoutId = REPORT_LENGTH[reportId] - 1;
  if (bytes.length === expectedWithoutId) {
    return new Uint8Array([reportId, ...bytes]);
  }
  if (bytes.length === REPORT_LENGTH[reportId] && bytes[0] === reportId) {
    return new Uint8Array(bytes);
  }
  return new Uint8Array([reportId, ...bytes]);
}

class HidppError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HidppError";
    Object.assign(this, details);
  }
}

class HidppTimeoutError extends HidppError {
  constructor(details = {}) {
    super("Timed out waiting for a HID++ response", details);
    this.name = "HidppTimeoutError";
  }
}

class Hidpp20Transport {
  constructor(device, options = {}) {
    this.device = device;
    this.deviceIndex = options.deviceIndex ?? 0x01;
    this.softwareId = options.softwareId ?? 0x08;
    this.timeoutMs = options.timeoutMs ?? 1200;
    this._pending = [];
    this._listeners = new Set();
    this._handleInputReport = this._handleInputReport.bind(this);
  }

  async open() {
    if (!this.device.opened) {
      await this.device.open();
    }
    this.device.addEventListener("inputreport", this._handleInputReport);
  }

  async close() {
    this.device.removeEventListener("inputreport", this._handleInputReport);
    if (this.device.opened) {
      await this.device.close();
    }
  }

  onReport(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _handleInputReport(event) {
    const report = normalizeIncomingReport(event.reportId, event.data);
    const frame = this._parseFrame(report);
    for (const listener of this._listeners) {
      listener(frame);
    }

    const index = this._pending.findIndex((pending) => pending.match(frame));
    if (index === -1) return;

    const [pending] = this._pending.splice(index, 1);
    clearTimeout(pending.timer);
    if (frame.error) {
      pending.reject(
        new HidppError(`HID++ device error ${hex(frame.error.code)} for feature ${hex(frame.error.featureIndex)}`, {
          frame,
          code: frame.error.code,
        }),
      );
      return;
    }
    pending.resolve(frame);
  }

  _parseFrame(report) {
    const reportId = report[0];
    const deviceIndex = report[1];
    const featureIndex = report[2];
    const address = report[3];
    const functionId = (address >> 4) & 0x0f;
    const softwareId = address & 0x0f;
    const parameters = report.slice(4);
    const frame = {
      reportId,
      deviceIndex,
      featureIndex,
      functionId,
      softwareId,
      parameters,
      raw: report,
      hex: bytesToHex(report),
    };

    if (featureIndex === HIDPP20_ERROR) {
      frame.error = {
        featureIndex: report[3],
        functionId: (report[4] >> 4) & 0x0f,
        softwareId: report[4] & 0x0f,
        code: report[5],
        data: report.slice(6),
      };
    }
    if (featureIndex === HIDPP10_ERROR) {
      frame.error = {
        featureIndex: report[3],
        functionId: (report[4] >> 4) & 0x0f,
        softwareId: report[4] & 0x0f,
        code: report[5],
        data: report.slice(6),
        hidpp10: true,
      };
    }
    return frame;
  }

  async call(featureIndex, functionId, parameters = [], options = {}) {
    const reportId = options.reportId ?? reportTypeForParamCount(parameters.length);
    const payloadLength = REPORT_LENGTH[reportId] - 1;
    const payload = new Uint8Array(payloadLength);
    payload[0] = options.deviceIndex ?? this.deviceIndex;
    payload[1] = featureIndex & 0xff;
    payload[2] = ((functionId & 0x0f) << 4) | ((options.softwareId ?? this.softwareId) & 0x0f);
    payload.set(parameters.slice(0, payloadLength - 3), 3);

    const expectedFeatureIndex = featureIndex;
    const expectedFunctionId = functionId & 0x0f;
    const expectedSoftwareId = (options.softwareId ?? this.softwareId) & 0x0f;
    const expectedDeviceIndex = options.deviceIndex ?? this.deviceIndex;

    const response = new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        match: (frame) => {
          if (frame.deviceIndex !== expectedDeviceIndex) return false;
          if (frame.error) {
            return (
              frame.error.featureIndex === expectedFeatureIndex &&
              frame.error.functionId === expectedFunctionId &&
              frame.error.softwareId === expectedSoftwareId
            );
          }
          return (
            frame.featureIndex === expectedFeatureIndex &&
            frame.functionId === expectedFunctionId &&
            frame.softwareId === expectedSoftwareId
          );
        },
      };
      pending.timer = setTimeout(() => {
        const index = this._pending.indexOf(pending);
        if (index !== -1) this._pending.splice(index, 1);
        reject(
          new HidppTimeoutError({
            featureIndex: expectedFeatureIndex,
            functionId: expectedFunctionId,
          }),
        );
      }, options.timeoutMs ?? this.timeoutMs);
      this._pending.push(pending);
    });

    await this.device.sendReport(reportId, payload);
    return response;
  }

  async rawReport(reportId, payloadBytes, options = {}) {
    const payloadLength = REPORT_LENGTH[reportId] - 1;
    if (payloadBytes.length > payloadLength) {
      throw new Error(`Report ${hex(reportId)} accepts ${payloadLength} payload bytes`);
    }
    const payload = new Uint8Array(payloadLength);
    payload.set(payloadBytes);
    let pending = null;
    let response = null;

    if (options.waitForAny) {
      response = new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          match: options.match ?? (() => true),
        };
        pending.timer = setTimeout(() => {
          const index = this._pending.indexOf(pending);
          if (index !== -1) this._pending.splice(index, 1);
          reject(new HidppTimeoutError());
        }, options.timeoutMs ?? this.timeoutMs);
        this._pending.push(pending);
      });
    }

    try {
      await this.device.sendReport(reportId, payload);
    } catch (error) {
      if (pending) {
        clearTimeout(pending.timer);
        const index = this._pending.indexOf(pending);
        if (index !== -1) this._pending.splice(index, 1);
      }
      throw error;
    }

    if (!response) return null;
    return response;
  }
}

class LogitechHidpp20Driver {
  constructor(transport) {
    this.transport = transport;
    this.features = new Map([[FEATURE.ROOT, { index: 0, id: FEATURE.ROOT, name: "Root" }]]);
  }

  static get filters() {
    return DEFAULT_FILTERS;
  }

  static async requestDevice(options = {}) {
    if (!("hid" in navigator)) {
      throw new Error("WebHID is not available in this browser. Use Chrome, Edge, or another Chromium browser.");
    }
    const [device] = await navigator.hid.requestDevice({
      filters: options.filters ?? DEFAULT_FILTERS,
    });
    if (!device) {
      throw new Error("No device selected");
    }
    return device;
  }

  static async fromDevice(device, options = {}) {
    const transport = new Hidpp20Transport(device, {
      ...options,
      deviceIndex: options.deviceIndex ?? LogitechHidpp20Driver.defaultDeviceIndex(device),
    });
    await transport.open();
    return new LogitechHidpp20Driver(transport);
  }

  static defaultDeviceIndex(device) {
    return DIRECT_WIRED_PRODUCT_IDS.has(device?.productId) ? 0xff : 0x01;
  }

  get device() {
    return this.transport.device;
  }

  get deviceIndex() {
    return this.transport.deviceIndex;
  }

  get productId() {
    return this.transport.device?.productId;
  }

  onReport(listener) {
    return this.transport.onReport(listener);
  }

  async close() {
    await this.transport.close();
  }

  async getProtocolVersion() {
    const response = await this.transport.call(0, 1, []);
    return {
      major: response.parameters[0],
      minor: response.parameters[1],
      raw: response,
    };
  }

  async getFeature(featureId) {
    const params = new Uint8Array(2);
    writeU16BE(params, 0, featureId);
    const response = await this.transport.call(0, 0, params);
    const feature = {
      id: featureId,
      index: response.parameters[0],
      type: response.parameters[1],
      version: response.parameters[2],
      obsolete: Boolean(response.parameters[1] & 0x80),
      hidden: Boolean(response.parameters[1] & 0x40),
      internal: Boolean(response.parameters[1] & 0x20),
      name: FEATURE_NAMES.get(featureId) ?? hex(featureId, 4),
    };
    if (feature.index !== 0) {
      this.features.set(featureId, feature);
    }
    return feature;
  }

  async featureIndex(featureId) {
    const cached = this.features.get(featureId);
    if (cached) return cached.index;
    const feature = await this.getFeature(featureId);
    if (feature.index === 0) {
      throw new HidppError(`Feature ${hex(featureId, 4)} is not supported`);
    }
    return feature.index;
  }

  async enumerateFeatures() {
    const featureSetIndex = await this.featureIndex(FEATURE.FEATURE_SET);
    const countResponse = await this.transport.call(featureSetIndex, 0, []);
    const count = countResponse.parameters[0];
    const features = [{ id: FEATURE.ROOT, index: 0, type: 0, version: null, name: "Root" }];
    for (let index = 1; index <= count; index += 1) {
      const response = await this.transport.call(featureSetIndex, 1, [index]);
      const id = readU16BE(response.parameters, 0);
      const type = response.parameters[2];
      const version = response.parameters[3];
      const feature = {
        id,
        index,
        type,
        version,
        obsolete: Boolean(type & 0x80),
        hidden: Boolean(type & 0x40),
        internal: Boolean(type & 0x20),
        name: FEATURE_NAMES.get(id) ?? hex(id, 4),
      };
      this.features.set(id, feature);
      features.push(feature);
      await sleep(4);
    }
    return features;
  }

  async getOnboardDescription() {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    const response = await this.transport.call(index, 0, []);
    const p = response.parameters;
    return {
      memoryModel: p[0],
      profileFormat: p[1],
      macroFormat: p[2],
      profileCount: p[3],
      romProfileCount: p[4],
      buttonCount: p[5],
      sectorCount: p[6],
      sectorSize: readU16BE(p, 7),
      mechanicalLayout: p[9],
      variousInfo: p[10],
      raw: response,
    };
  }

  async getOnboardMode() {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    const response = await this.transport.call(index, 2, []);
    return {
      mode: response.parameters[0],
      label: response.parameters[0] === ONBOARD_MODE.ONBOARD ? "onboard" : response.parameters[0] === ONBOARD_MODE.HOST ? "host" : "unknown",
      raw: response,
    };
  }

  async setOnboardMode(mode) {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    await this.transport.call(index, 1, [mode]);
  }

  async getCurrentProfile() {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    const response = await this.transport.call(index, 4, []);
    return {
      memoryType: response.parameters[0],
      profileIndex: response.parameters[1],
      raw: response,
    };
  }

  async setCurrentProfile(memoryType, profileIndex) {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    await this.transport.call(index, 3, [memoryType, profileIndex]);
  }

  async getCurrentDpiIndex() {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    const response = await this.transport.call(index, 11, []);
    return {
      dpiIndex: response.parameters[0],
      raw: response,
    };
  }

  async setCurrentDpiIndex(dpiIndex) {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    await this.transport.call(index, 12, [dpiIndex]);
  }

  async readOnboardLine(memoryType, page, offset) {
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    const params = new Uint8Array(4);
    params[0] = memoryType & 0xff;
    params[1] = page & 0xff;
    writeU16BE(params, 2, offset);
    const response = await this.transport.call(index, 5, params, { reportId: REPORT.LONG });
    return response.parameters.slice(0, 16);
  }

  async readOnboardSector(memoryType, page, sectorSize, onProgress = () => {}) {
    const lines = [];
    for (let offset = 0; offset < sectorSize; offset += 16) {
      const line = await this.readOnboardLine(memoryType, page, offset);
      lines.push(...line);
      onProgress({ offset, sectorSize });
      await sleep(8);
    }
    return new Uint8Array(lines.slice(0, sectorSize));
  }

  async writeOnboardBytes(page, offset, data, options = {}) {
    if (!options.dangerouslyAllowWrite) {
      throw new Error("writeOnboardBytes is disabled unless dangerouslyAllowWrite is true");
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const index = await this.featureIndex(FEATURE.ONBOARD_PROFILES);
    const start = new Uint8Array(6);
    start[0] = options.memoryType ?? ONBOARD_MEMORY_TYPE.WRITEABLE;
    start[1] = page & 0xff;
    writeU16BE(start, 2, offset);
    writeU16BE(start, 4, bytes.length);
    await this.transport.call(index, 6, start, { reportId: REPORT.LONG });

    for (let cursor = 0; cursor < bytes.length; cursor += 16) {
      const chunk = new Uint8Array(16);
      chunk.set(bytes.slice(cursor, cursor + 16));
      await this.transport.call(index, 7, chunk, { reportId: REPORT.LONG });
      await sleep(options.lineDelayMs ?? 8);
    }

    await this.transport.call(index, 8, []);
  }

  async getOnboardProfileHeaders(description = null) {
    const sectorSize = description?.sectorSize ?? (await this.getOnboardDescription()).sectorSize;
    let memoryType = ONBOARD_MEMORY_TYPE.WRITEABLE;
    let bytes = await this.readOnboardSector(memoryType, 0, sectorSize);
    const emptyControl =
      bytes.slice(0, 4).every((value) => value === 0x00) || bytes.slice(0, 4).every((value) => value === 0xff);
    if (emptyControl) {
      memoryType = ONBOARD_MEMORY_TYPE.ROM;
      bytes = await this.readOnboardSector(memoryType, 0, sectorSize);
    }

    const headers = [];
    for (let offset = 0; offset + 3 < bytes.length; offset += 4) {
      const sector = readU16BE(bytes, offset);
      if (sector === 0xffff) break;
      headers.push({
        profileIndex: headers.length,
        sector,
        enabled: bytes[offset + 2],
        offset,
        sourceMemoryType: memoryType,
      });
    }
    return { headers, memoryType, raw: bytes };
  }

  async readOnboardProfile(profileIndex, description = null) {
    const onboardDescription = description ?? (await this.getOnboardDescription());
    const { headers } = await this.getOnboardProfileHeaders(onboardDescription);
    const header = headers[profileIndex];
    if (!header) {
      throw new HidppError(`On-board profile ${profileIndex + 1} is not available`);
    }
    const memoryType = (header.sector >> 8) & 0xff;
    const page = header.sector & 0xff;
    const bytes = await this.readOnboardSector(memoryType, page, onboardDescription.sectorSize);
    return {
      profileIndex,
      sector: header.sector,
      enabled: header.enabled,
      reportRate: bytes[0],
      resolutionDefaultIndex: bytes[1],
      resolutionShiftIndex: bytes[2],
      resolutions: Array.from({ length: 5 }, (_, index) => readU16LE(bytes, 3 + index * 2)),
      writeCount: readU16LE(bytes, 18),
      raw: bytes,
    };
  }

  async setOnboardProfileDpi(profileIndex, dpiIndex, dpi, description = null) {
    const onboardDescription = description ?? (await this.getOnboardDescription());
    const profile = await this.readOnboardProfile(profileIndex, onboardDescription);
    const bytes = new Uint8Array(profile.raw);
    const clampedDpiIndex = Math.max(0, Math.min(4, dpiIndex));
    writeU16LE(bytes, 3 + clampedDpiIndex * 2, dpi);
    const crc = crc16Ccitt(bytes.slice(0, onboardDescription.sectorSize - 2));
    writeU16BE(bytes, onboardDescription.sectorSize - 2, crc);

    const memoryType = (profile.sector >> 8) & 0xff;
    const page = profile.sector & 0xff;
    await this.writeOnboardBytes(page, 0, bytes, {
      dangerouslyAllowWrite: true,
      memoryType,
    });

    const written = await this.readOnboardProfile(profileIndex, onboardDescription);
    return {
      profileIndex,
      dpiIndex: clampedDpiIndex,
      dpi,
      sector: profile.sector,
      before: profile.resolutions,
      after: written.resolutions,
      crc,
    };
  }

  async getDpiSensors() {
    const index = await this.featureIndex(FEATURE.ADJUSTABLE_DPI);
    const countResponse = await this.transport.call(index, 0, []);
    const count = countResponse.parameters[0];
    const sensors = [];
    for (let sensorIndex = 0; sensorIndex < count; sensorIndex += 1) {
      const listResponse = await this.transport.call(index, 1, [sensorIndex]);
      const values = [];
      let step = null;
      for (let offset = 1; offset + 1 < listResponse.parameters.length; offset += 2) {
        const value = readU16BE(listResponse.parameters, offset);
        if (!value) break;
        if (value > 0xe000) step = value - 0xe000;
        else values.push(value);
      }

      const currentResponse = await this.transport.call(index, 2, [sensorIndex]);
      sensors.push({
        index: sensorIndex,
        list: values,
        step,
        current: readU16BE(currentResponse.parameters, 1),
        default: readU16BE(currentResponse.parameters, 3),
      });
    }
    return sensors;
  }

  async setSensorDpi(sensorIndex, dpi) {
    const index = await this.featureIndex(FEATURE.ADJUSTABLE_DPI);
    const params = new Uint8Array(3);
    params[0] = sensorIndex & 0xff;
    writeU16BE(params, 1, dpi);
    await this.transport.call(index, 3, params);
  }

  async getExtendedDpi(sensorIndex = 0) {
    const index = await this.featureIndex(FEATURE.ADJUSTABLE_DPI_ADVANCED);
    const response = await this.transport.call(index, 5, [sensorIndex & 0xff], { reportId: REPORT.LONG });
    const parameters = response.parameters;
    const currentX = readU16BE(parameters, 1);
    const defaultX = readU16BE(parameters, 3);
    const currentY = readU16BE(parameters, 5);
    const defaultY = readU16BE(parameters, 7);
    return {
      sensorIndex: parameters[0] ?? sensorIndex,
      current: currentX || defaultX,
      default: defaultX || currentX,
      x: currentX || defaultX,
      y: currentY || defaultY || currentX || defaultX,
      defaultY,
      lod: parameters[9] ?? 0x02,
      raw: response,
    };
  }

  async setExtendedDpi(sensorIndex, dpi, options = {}) {
    const index = await this.featureIndex(FEATURE.ADJUSTABLE_DPI_ADVANCED);
    const params = new Uint8Array(6);
    const normalizedDpi = Math.round(Number(dpi));
    const yDpi = Math.round(Number(options.y ?? normalizedDpi));
    params[0] = sensorIndex & 0xff;
    writeU16BE(params, 1, normalizedDpi);
    writeU16BE(params, 3, yDpi);
    params[5] = options.lod ?? 0x02;
    await this.transport.call(index, 6, params, { reportId: REPORT.LONG });
  }

  async getReportRateList() {
    const index = await this.featureIndex(FEATURE.ADJUSTABLE_REPORT_RATE);
    const response = await this.transport.call(index, 0, []);
    const bitflags = response.parameters[0];
    const candidates = [
      { ms: 8, hz: 125, bit: 0x08 },
      { ms: 4, hz: 250, bit: 0x04 },
      { ms: 2, hz: 500, bit: 0x02 },
      { ms: 1, hz: 1000, bit: 0x01 },
    ];
    return {
      bitflags,
      rates: candidates.filter((rate) => bitflags & rate.bit),
      raw: response,
    };
  }

  async getReportRate() {
    const index = await this.featureIndex(FEATURE.ADJUSTABLE_REPORT_RATE);
    const response = await this.transport.call(index, 1, [0]);
    const ms = response.parameters[0];
    return {
      ms,
      hz: ms ? Math.round(1000 / ms) : null,
      raw: response,
    };
  }

  async setReportRateMs(ms) {
    const index = await this.featureIndex(FEATURE.ADJUSTABLE_REPORT_RATE);
    await this.transport.call(index, 2, [ms]);
  }

  async rawCall(featureIdOrIndex, functionId, params = [], options = {}) {
    const featureIndex = options.byIndex ? featureIdOrIndex : await this.featureIndex(featureIdOrIndex);
    return this.transport.call(featureIndex, functionId, params, options);
  }

  async rawReport(reportId, payloadBytes, options = {}) {
    return this.transport.rawReport(reportId, payloadBytes, options);
  }
}

export {
  FEATURE,
  FEATURE_NAMES,
  HIDPP20_ERROR,
  ONBOARD_MEMORY_TYPE,
  ONBOARD_MODE,
  REPORT,
  Hidpp20Transport,
  HidppError,
  LogitechHidpp20Driver,
  bytesToHex,
  hex,
  parseHexBytes,
};
