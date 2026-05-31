import {
  FEATURE,
  ONBOARD_MEMORY_TYPE,
  ONBOARD_MODE,
  REPORT,
  LogitechHidpp20Driver,
  bytesToHex,
  hex,
} from "./logitech-hidpp.js";

const $ = (selector) => document.querySelector(selector);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_RECEIVER_DEVICE_INDEX = 0x01;
const DEFAULT_WIRED_DEVICE_INDEX = 0xff;
const DEFAULT_PROFILE_INDEX = 0;
const DEFAULT_DPI_INDEX = 0;
const DIRECT_WIRED_PRODUCT_ID = 0xc0a8;
const G_HUB_ADVANCED_DPI_RANGE = Object.freeze({ min: 100, max: 32000, step: 100 });
const FALLBACK_REPORT_RATES = Object.freeze([
  { ms: 0.125, hz: 8000, capturedValue: 0x06 },
  { ms: 0.25, hz: 4000, capturedValue: 0x05 },
  { ms: 0.5, hz: 2000, capturedValue: 0x04 },
  { ms: 1, hz: 1000, capturedValue: 0x03 },
  { ms: 2, hz: 500, capturedValue: 0x02 },
  { ms: 4, hz: 250, capturedValue: 0x01 },
  { ms: 8, hz: 125, capturedValue: 0x00 },
]);
const STANDARD_REPORT_RATES = Object.freeze(FALLBACK_REPORT_RATES.filter((rate) => rate.ms >= 1));
const CAPTURED_ADVANCED_DPI_FEATURE_INDEX = 0x09;
const CAPTURED_ADVANCED_DPI_SET_FUNCTION = 0x06;
const CAPTURED_ADVANCED_DPI_COMMIT_FUNCTION = 0x07;
const CAPTURED_REPORT_RATE_FEATURE_INDEX = 0x0d;
const CAPTURED_REPORT_RATE_FUNCTION = 0x03;
const CAPTURED_RECEIVER_SOFTWARE_ID = 0x0d;
const CAPTURED_WIRED_SOFTWARE_ID = 0x0b;
const BHOP_FEATURE_INDEX = 0x0b;
const BHOP_WRITE_FUNCTION = 0x02;
const BHOP_SOFTWARE_ID = 0x0d;
const BHOP_TIMEOUT_RANGE = Object.freeze({ min: 100, max: 1000, step: 100 });
const HITS_FEATURE_INDEX = 0x0c;
const HITS_WRITE_FUNCTION = 0x01;
const HITS_SOFTWARE_ID = 0x0d;
const HIDPP_INVALID_ARGUMENT = 0x02;

const state = {
  driver: null,
  unsubscribe: null,
  features: [],
  onboardDescription: null,
  onboardProfiles: [],
  activeProfileIndex: DEFAULT_PROFILE_INDEX,
  currentDpiIndex: DEFAULT_DPI_INDEX,
  dpiSensors: [],
  reportRates: {
    wired: [...STANDARD_REPORT_RATES],
    wireless: [...FALLBACK_REPORT_RATES],
  },
  currentReportRate: {
    wired: 1,
    wireless: 1,
  },
  bhop: {
    enabled: false,
    timeout: 100,
  },
  extendedDpi: null,
};

const SUPERSTRIKE_HITS_MODEL = Object.freeze({
  buttonIds: {
    left: 80,
    right: 81,
  },
  capturedHidpp: {
    featureIndex: "0x0c",
    functionId: "0x1",
    softwareId: "0xd",
    hitsTemplate: "11 01 0c 1d <side:00|01> <actuation*4> <rapid*4+enabled> <haptics*4> 00...",
  },
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeToStep(value, { min, max, step }) {
  const numeric = Number(value);
  const safeValue = Number.isFinite(numeric) ? numeric : min;
  const snapped = Math.round((safeValue - min) / step) * step + min;
  return clamp(snapped, min, max);
}

function writeU16BE(bytes, offset, value) {
  bytes[offset] = (value >> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function unique(items) {
  return [...new Set(items.filter((item) => Number.isInteger(item)))];
}

function activeDeviceIndex() {
  return state.driver?.deviceIndex ?? DEFAULT_RECEIVER_DEVICE_INDEX;
}

function isDirectWiredDevice(driver = state.driver) {
  return driver?.productId === DIRECT_WIRED_PRODUCT_ID;
}

function softwareIdForDeviceIndex(deviceIndex) {
  return deviceIndex === DEFAULT_WIRED_DEVICE_INDEX ? CAPTURED_WIRED_SOFTWARE_ID : CAPTURED_RECEIVER_SOFTWARE_ID;
}

function candidateDeviceIndexes(preferred = activeDeviceIndex()) {
  return unique([preferred, DEFAULT_RECEIVER_DEVICE_INDEX, DEFAULT_WIRED_DEVICE_INDEX]);
}

function channelDeviceCandidates(channel, driver = state.driver) {
  if (channel === "wired") {
    return candidateDeviceIndexes(isDirectWiredDevice(driver) ? DEFAULT_WIRED_DEVICE_INDEX : activeDeviceIndex());
  }
  return candidateDeviceIndexes(DEFAULT_RECEIVER_DEVICE_INDEX);
}

function buildShortPayload(deviceIndex, featureIndex, functionId, softwareId, params = []) {
  const payload = new Uint8Array(6);
  payload[0] = deviceIndex & 0xff;
  payload[1] = featureIndex & 0xff;
  payload[2] = ((functionId & 0x0f) << 4) | (softwareId & 0x0f);
  payload.set(params.slice(0, 3), 3);
  return payload;
}

function setOutput(selector, value) {
  const el = $(selector);
  el.value = String(value);
  el.textContent = String(value);
}

function hitsSideFromIndex(sideIndex) {
  return sideIndex === 1 ? "right" : "left";
}

function hitsSideIndex(side) {
  return side === "right" ? 1 : 0;
}

function hitsButtonId(side) {
  return SUPERSTRIKE_HITS_MODEL.buttonIds[side];
}

function hitsSideSettings(side) {
  return {
    side,
    sideIndex: hitsSideIndex(side),
    buttonId: hitsButtonId(side),
    actuation: Number($(`#${side}HitsActuation`).value),
    rapid: Number($(`#${side}HitsRapid`).value),
    haptics: Number($(`#${side}HitsHaptics`).value),
  };
}

function hitsSettings() {
  return ["left", "right"].map(hitsSideSettings);
}

function buildHitsSettingsPatch() {
  const settings = hitsSettings();
  return {
    targetButtonIds: settings.map((setting) => setting.buttonId),
    analogPreset: {
      actuationPointValues: Object.fromEntries(settings.map((setting) => [setting.buttonId, setting.actuation])),
      rapidTriggerExplicitStates: settings.map((setting) => setting.buttonId),
      rapidTriggerValues: Object.fromEntries(settings.map((setting) => [setting.buttonId, setting.rapid])),
      clickHapticsValues: Object.fromEntries(settings.map((setting) => [setting.buttonId, setting.haptics])),
    },
  };
}

function buildCapturedHitsPayload(sideIndex, deviceIndex = activeDeviceIndex()) {
  const { actuation, rapid, haptics } = hitsSideSettings(hitsSideFromIndex(sideIndex));
  const payload = new Uint8Array(19);
  payload.set([
    deviceIndex,
    HITS_FEATURE_INDEX,
    (HITS_WRITE_FUNCTION << 4) | HITS_SOFTWARE_ID,
    sideIndex & 0xff,
    Math.max(0, Math.min(0xff, actuation * 4)),
    Math.max(0, Math.min(0xff, rapid * 4 + 1)),
    Math.max(0, Math.min(0xff, haptics * 4)),
  ]);
  return payload;
}

function renderHitsModel() {
  for (const { side, actuation, rapid, haptics } of hitsSettings()) {
    setOutput(`#${side}Actuation`, actuation);
    setOutput(`#${side}Rapid`, rapid);
    setOutput(`#${side}Haptics`, haptics);
    setOutput(`#${side}MouseActuation`, actuation);
    setOutput(`#${side}MouseRapid`, rapid);
    setOutput(`#${side}MouseHaptics`, haptics);
    $(`#${side}ApLine`).style.setProperty("--ap-position", `${clamp(actuation, 1, 10) * 10}%`);
  }
}

function setStatus(text, kind = "idle") {
  const el = $("#status");
  el.textContent = text;
  el.dataset.kind = kind;
}

function log(line, data) {
  const out = $("#log");
  const time = new Date().toLocaleTimeString();
  const text = typeof data === "undefined" ? line : `${line}\n${JSON.stringify(data, null, 2)}`;
  out.textContent = `[${time}] ${text}\n\n${out.textContent}`.slice(0, 9000);
}

function renderDevice(device) {
  $("#deviceName").textContent = device.productName || "Logitech HID device";
  $("#deviceIds").textContent = `${hex(device.vendorId, 4)}:${hex(device.productId, 4)}`;
}

function hasFeature(featureId) {
  return state.features.some((feature) => feature.id === featureId);
}

function hasDpiFeature() {
  return hasFeature(FEATURE.ADJUSTABLE_DPI) || hasFeature(FEATURE.ADJUSTABLE_DPI_ADVANCED);
}

function connectionDeviceIndexes(device) {
  const defaultIndex = LogitechHidpp20Driver.defaultDeviceIndex(device);
  const receiverIndexes = [defaultIndex, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, DEFAULT_WIRED_DEVICE_INDEX];
  const directIndexes = [defaultIndex, DEFAULT_RECEIVER_DEVICE_INDEX, DEFAULT_WIRED_DEVICE_INDEX];
  return unique(device?.productId === 0xc54d || device?.productId === 0xab24 ? receiverIndexes : directIndexes);
}

function hasTargetMouseFeatures(features) {
  return features.some(
    (feature) =>
      feature.id === FEATURE.ONBOARD_PROFILES ||
      feature.id === FEATURE.ADJUSTABLE_DPI ||
      feature.id === FEATURE.ADJUSTABLE_DPI_ADVANCED,
  );
}

async function openResponsiveDriver(device) {
  const attempts = [];
  for (const deviceIndex of connectionDeviceIndexes(device)) {
    let driver = null;
    try {
      driver = await LogitechHidpp20Driver.fromDevice(device, { deviceIndex, timeoutMs: 800 });
      const version = await driver.getProtocolVersion();
      const features = await driver.enumerateFeatures();
      if (!hasTargetMouseFeatures(features)) {
        attempts.push({
          productId: hex(device.productId, 4),
          protocol: `${version.major}.${version.minor}`,
          reason: "target mouse features not found",
        });
        await driver.close();
        continue;
      }
      return { driver, version, features, attempts };
    } catch (error) {
      attempts.push({
        productId: hex(device.productId, 4),
        error: errorSummary(error),
      });
      if (driver) {
        try {
          await driver.close();
        } catch {
          // Ignore close errors while probing alternate HID++ targets.
        }
      }
    }
  }
  const error = new Error("HID++ 2.0 mouse interface was not found on this WebHID device");
  error.attempts = attempts;
  throw error;
}

function renderCapabilities() {
  const capabilities = [
    { label: "ON-BOARD", supported: hasFeature(FEATURE.ONBOARD_PROFILES) },
    { label: "DPI", supported: hasDpiFeature() },
    { label: "REPORT RATE", supported: hasFeature(FEATURE.ADJUSTABLE_REPORT_RATE) },
    { label: "WIRELESS", supported: true },
    { label: "WIRED", supported: true },
    { label: "HITS", supported: true },
    { label: "BHOP", supported: true },
  ];
  $("#capabilityList").replaceChildren(
    ...capabilities.map((item) => {
      const chip = document.createElement("span");
      chip.className = "capability-chip";
      chip.dataset.supported = String(item.supported);
      chip.textContent = item.label;
      return chip;
    }),
  );
}

function renderOnboardUnavailable() {
  const badge = $("#onboardBadge");
  badge.textContent = "UNAVAILABLE";
  badge.dataset.state = "error";
}

function renderOnboardState({ mode, profile, dpi, description }) {
  const badge = $("#onboardBadge");
  const isOnboard = mode?.mode === ONBOARD_MODE.ONBOARD;
  badge.textContent = isOnboard ? "ON" : mode?.label?.toUpperCase() || "UNKNOWN";
  badge.dataset.state = isOnboard ? "ok" : "warn";
  badge.title = `${description?.profileCount ?? 1} profile(s), active ${activeProfileIndexFromSector(profile?.sector) + 1}, DPI ${
    (dpi?.dpiIndex ?? activeDpiIndex()) + 1
  }`;
}

function activeProfileIndexFromSector(sector) {
  const index = state.onboardProfiles.findIndex((profile) => profile.sector === sector);
  if (index !== -1) return index;
  return selectedProfileIndex();
}

function selectedProfileIndex() {
  const count = Math.max(1, state.onboardProfiles.length || state.onboardDescription?.profileCount || 1);
  const active = clamp(Number.isInteger(state.activeProfileIndex) ? state.activeProfileIndex : DEFAULT_PROFILE_INDEX, 0, count - 1);
  if (!state.onboardProfiles.length || state.onboardProfiles[active]?.enabled) return active;
  const enabledIndex = state.onboardProfiles.findIndex((profile) => profile.enabled);
  return enabledIndex === -1 ? active : enabledIndex;
}

function activeDpiIndex() {
  return clamp(Number.isInteger(state.currentDpiIndex) ? state.currentDpiIndex : DEFAULT_DPI_INDEX, 0, 15);
}

async function syncOnboardLiveState(driver) {
  if (!hasFeature(FEATURE.ONBOARD_PROFILES)) return;
  const [mode, profile, dpi] = await Promise.all([
    driver.getOnboardMode(),
    driver.getCurrentProfile(),
    driver.getCurrentDpiIndex(),
  ]);
  state.activeProfileIndex = activeProfileIndexFromSector(profile.sector);
  state.currentDpiIndex = dpi.dpiIndex ?? DEFAULT_DPI_INDEX;
  renderOnboardState({ mode, profile, dpi, description: state.onboardDescription });
}

async function ensureOnboardReady(driver) {
  if (!hasFeature(FEATURE.ONBOARD_PROFILES)) {
    throw new Error("オンボードメモリ機能が見つかりません");
  }
  const profileIndex = selectedProfileIndex();
  const profileSector = state.onboardProfiles[profileIndex]?.sector ?? profileIndex;
  await driver.setOnboardMode(ONBOARD_MODE.ONBOARD);
  try {
    await driver.setCurrentProfile((profileSector >> 8) & 0xff, profileSector & 0xff);
  } catch (error) {
    if (error.code !== HIDPP_INVALID_ARGUMENT) throw error;
    log("profile activation skipped", {
      reason: "device rejected writable profile selection",
      featureIndex: error.frame?.error?.featureIndex,
      profileIndex,
      profileSector,
    });
  }
  $("#onboardBadge").textContent = "ON";
  $("#onboardBadge").dataset.state = "ok";
}

async function withDriver(action, busyText) {
  if (!state.driver) {
    setStatus("先に接続してください", "warn");
    return;
  }
  try {
    if (busyText) setStatus(busyText, "busy");
    await action(state.driver);
    setStatus("ready", "ok");
  } catch (error) {
    setStatus(error.message, "error");
    log("error", {
      message: error.message,
      name: error.name,
      code: error.code,
      frame: error.frame?.hex,
    });
  }
}

function isRetryableError(error) {
  return error?.name === "HidppTimeoutError" || /timed out|timeout/i.test(error?.message ?? "");
}

async function retryOperation(label, action, options = {}) {
  const maxAttempts = options.maxAttempts ?? 4;
  const maxMs = options.maxMs ?? 9000;
  const baseDelayMs = options.baseDelayMs ?? 220;
  const started = performance.now();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      const elapsed = performance.now() - started;
      if (!isRetryableError(error) || attempt >= maxAttempts || elapsed >= maxMs) {
        throw error;
      }
      const waitMs = Math.min(1600, Math.round(baseDelayMs * 1.8 ** (attempt - 1)));
      log(`${label} retry`, {
        attempt,
        nextAttempt: attempt + 1,
        waitMs,
        error: errorSummary(error),
      });
      setStatus(`${label} retry ${attempt + 1}/${maxAttempts}`, "busy");
      await delay(waitMs);
    }
  }

  throw lastError;
}

async function withOnboardMutation(action, busyText) {
  await withDriver(async (driver) => {
    await retryOperation(busyText ?? "operation", async () => {
      await ensureOnboardReady(driver);
      await action(driver);
      try {
        await syncOnboardLiveState(driver);
      } catch (error) {
        log("live state refresh skipped", errorSummary(error));
      }
    });
  }, busyText);
}

function errorSummary(error) {
  return {
    message: error.message,
    code: error.code,
    frame: error.frame?.hex,
  };
}

function capturedFrameMatcher(deviceIndex, featureIndex, functionId, softwareId) {
  return (frame) => {
    if (frame.deviceIndex !== deviceIndex) return false;
    if (frame.error) {
      return (
        frame.error.featureIndex === featureIndex &&
        frame.error.functionId === functionId &&
        frame.error.softwareId === softwareId
      );
    }
    return (
      frame.featureIndex === featureIndex &&
      frame.functionId === functionId &&
      frame.softwareId === softwareId
    );
  };
}

function capturedFeatureMatcher(deviceIndex, featureIndex) {
  return (frame) => {
    if (frame.deviceIndex !== deviceIndex) return false;
    if (frame.error) return frame.error.featureIndex === featureIndex;
    return frame.featureIndex === featureIndex;
  };
}

async function sendCapturedShort(driver, { deviceIndex, featureIndex, functionId, softwareId, params, timeoutMs = 700 }) {
  const payload = buildShortPayload(deviceIndex, featureIndex, functionId, softwareId, params);
  const response = await driver.rawReport(REPORT.SHORT, payload, {
    waitForAny: true,
    timeoutMs,
    match: capturedFrameMatcher(deviceIndex, featureIndex, functionId, softwareId),
  });
  return {
    report: `10 ${bytesToHex(payload)}`,
    response: response?.hex,
  };
}

function buildCapturedAdvancedDpiPayload(deviceIndex, softwareId, functionId, sensorIndex, dpi) {
  const payload = new Uint8Array(19);
  payload[0] = deviceIndex & 0xff;
  payload[1] = CAPTURED_ADVANCED_DPI_FEATURE_INDEX;
  payload[2] = ((functionId & 0x0f) << 4) | (softwareId & 0x0f);
  payload[3] = sensorIndex & 0xff;
  if (functionId === CAPTURED_ADVANCED_DPI_SET_FUNCTION) {
    writeU16BE(payload, 4, dpi);
    writeU16BE(payload, 6, dpi);
    payload[8] = 0x02;
  } else {
    payload[4] = 0x03;
    payload[5] = 0x00;
  }
  return payload;
}

async function writeCapturedAdvancedDpi(driver, sensorIndex, dpi) {
  const attempts = [];
  const normalizedDpi = normalizeToStep(dpi, sensorDpiRange(selectedSensor()));
  for (const deviceIndex of candidateDeviceIndexes(activeDeviceIndex())) {
    const softwareId = softwareIdForDeviceIndex(deviceIndex);
    const setPayload = buildCapturedAdvancedDpiPayload(
      deviceIndex,
      softwareId,
      CAPTURED_ADVANCED_DPI_SET_FUNCTION,
      sensorIndex,
      normalizedDpi,
    );
    const commitPayload = buildCapturedAdvancedDpiPayload(
      deviceIndex,
      softwareId,
      CAPTURED_ADVANCED_DPI_COMMIT_FUNCTION,
      sensorIndex,
      normalizedDpi,
    );
    try {
      await driver.rawReport(REPORT.LONG, setPayload, {
        waitForAny: true,
        timeoutMs: 550,
        match: capturedFeatureMatcher(deviceIndex, CAPTURED_ADVANCED_DPI_FEATURE_INDEX),
      });
      await delay(25);
      await driver.rawReport(REPORT.LONG, commitPayload, {
        waitForAny: true,
        timeoutMs: 550,
        match: capturedFeatureMatcher(deviceIndex, CAPTURED_ADVANCED_DPI_FEATURE_INDEX),
      });
      attempts.push({
        deviceIndex,
        softwareId,
        dpi: normalizedDpi,
        set: `11 ${bytesToHex(setPayload)}`,
        commit: `11 ${bytesToHex(commitPayload)}`,
        acknowledged: true,
      });
      return attempts;
    } catch (error) {
      attempts.push({
        deviceIndex,
        softwareId,
        dpi: normalizedDpi,
        set: `11 ${bytesToHex(setPayload)}`,
        commit: `11 ${bytesToHex(commitPayload)}`,
        error: errorSummary(error),
      });
    }
  }
  const fallbackIndex = activeDeviceIndex();
  const fallbackSoftwareId = softwareIdForDeviceIndex(fallbackIndex);
  const setPayload = buildCapturedAdvancedDpiPayload(
    fallbackIndex,
    fallbackSoftwareId,
    CAPTURED_ADVANCED_DPI_SET_FUNCTION,
    sensorIndex,
    normalizedDpi,
  );
  const commitPayload = buildCapturedAdvancedDpiPayload(
    fallbackIndex,
    fallbackSoftwareId,
    CAPTURED_ADVANCED_DPI_COMMIT_FUNCTION,
    sensorIndex,
    normalizedDpi,
  );
  await driver.rawReport(REPORT.LONG, setPayload);
  await delay(25);
  await driver.rawReport(REPORT.LONG, commitPayload);
  attempts.push({
    deviceIndex: fallbackIndex,
    softwareId: fallbackSoftwareId,
    dpi: normalizedDpi,
    set: `11 ${bytesToHex(setPayload)}`,
    commit: `11 ${bytesToHex(commitPayload)}`,
    acknowledged: false,
  });
  return attempts;
}

async function writeSelectedSensorDpi(driver, sensorIndex, dpi) {
  const result = {};
  let appliedToOnboardProfile = false;
  if (hasFeature(FEATURE.ONBOARD_PROFILES) && state.onboardDescription?.sectorSize) {
    const profileIndex = selectedProfileIndex();
    try {
      result.onboardProfile = await driver.setOnboardProfileDpiAll(profileIndex, dpi, state.onboardDescription);
      await driver.setCurrentDpiIndex(DEFAULT_DPI_INDEX);
      state.currentDpiIndex = DEFAULT_DPI_INDEX;
      state.extendedDpi = {
        sensorIndex,
        current: dpi,
        default: selectedSensor()?.default || 1600,
        y: dpi,
        lod: selectedSensor()?.lod ?? state.extendedDpi?.lod ?? 0x02,
      };
      appliedToOnboardProfile = true;
    } catch (error) {
      result.onboardProfile = { error: errorSummary(error) };
    }
  }

  if (appliedToOnboardProfile && hasFeature(FEATURE.ADJUSTABLE_DPI_ADVANCED)) {
    const sensor = selectedSensor();
    try {
      await driver.setExtendedDpi(sensorIndex, dpi, {
        y: dpi,
        lod: sensor?.lod ?? state.extendedDpi?.lod ?? 0x02,
      });
      result.liveAdvanced = "ok";
    } catch (error) {
      result.liveAdvanced = { error: errorSummary(error) };
    }
  } else if (appliedToOnboardProfile && hasFeature(FEATURE.ADJUSTABLE_DPI)) {
    try {
      await driver.setSensorDpi(sensorIndex, dpi);
      result.liveStandard = "ok";
    } catch (error) {
      result.liveStandard = { error: errorSummary(error) };
    }
  }

  if (!appliedToOnboardProfile && hasFeature(FEATURE.ADJUSTABLE_DPI)) {
    try {
      await driver.setSensorDpi(sensorIndex, dpi);
      result.standard = "ok";
    } catch (error) {
      result.standard = { error: errorSummary(error) };
    }
  }

  if (!appliedToOnboardProfile && hasFeature(FEATURE.ADJUSTABLE_DPI_ADVANCED)) {
    const sensor = selectedSensor();
    try {
      await driver.setExtendedDpi(sensorIndex, dpi, {
        y: dpi,
        lod: sensor?.lod ?? state.extendedDpi?.lod ?? 0x02,
      });
      result.extendedAdvanced = "ok";
      try {
        state.extendedDpi = await driver.getExtendedDpi(sensorIndex);
      } catch (error) {
        state.extendedDpi = {
          sensorIndex,
          current: dpi,
          default: sensor?.default || 1600,
          y: dpi,
          lod: sensor?.lod ?? state.extendedDpi?.lod ?? 0x02,
          refreshError: errorSummary(error),
        };
        result.extendedRefresh = { error: errorSummary(error) };
      }
    } catch (error) {
      result.extendedAdvanced = { error: errorSummary(error) };
    }
  } else if (!appliedToOnboardProfile && !hasFeature(FEATURE.ADJUSTABLE_DPI)) {
    result.capturedAdvanced = await writeCapturedAdvancedDpi(driver, sensorIndex, dpi);
  }

  if (hasFeature(FEATURE.ADJUSTABLE_DPI)) {
    try {
      state.dpiSensors = await driver.getDpiSensors();
    } catch (error) {
      result.standardRefresh = { error: errorSummary(error) };
    }
  } else if (hasFeature(FEATURE.ADJUSTABLE_DPI_ADVANCED)) {
    renderCapturedDpiControls(state.extendedDpi);
  }

  return result;
}

async function writeCapturedReportRate(driver, channel, ms) {
  const rate = rateByMs(channel, ms);
  const attempts = [];
  for (const deviceIndex of channelDeviceCandidates(channel, driver)) {
    const softwareId = channel === "wired" ? softwareIdForDeviceIndex(deviceIndex) : CAPTURED_RECEIVER_SOFTWARE_ID;
    const payload = buildShortPayload(deviceIndex, CAPTURED_REPORT_RATE_FEATURE_INDEX, CAPTURED_REPORT_RATE_FUNCTION, softwareId, [
      rate.capturedValue,
      0x00,
      0x00,
    ]);
    try {
      const response = await driver.rawReport(REPORT.SHORT, payload, {
        waitForAny: true,
        timeoutMs: 650,
        match: capturedFeatureMatcher(deviceIndex, CAPTURED_REPORT_RATE_FEATURE_INDEX),
      });
      return {
        channel,
        ms: rate.ms,
        hz: rate.hz,
        deviceIndex,
        softwareId,
        report: `10 ${bytesToHex(payload)}`,
        response: response?.hex,
      };
    } catch (error) {
      attempts.push({
        deviceIndex,
        softwareId,
        report: `10 ${bytesToHex(payload)}`,
        error: errorSummary(error),
      });
    }
  }

  const fallbackIndex = channelDeviceCandidates(channel, driver)[0] ?? activeDeviceIndex();
  const fallbackSoftwareId = channel === "wired" ? softwareIdForDeviceIndex(fallbackIndex) : CAPTURED_RECEIVER_SOFTWARE_ID;
  const fallbackPayload = buildShortPayload(
    fallbackIndex,
    CAPTURED_REPORT_RATE_FEATURE_INDEX,
    CAPTURED_REPORT_RATE_FUNCTION,
    fallbackSoftwareId,
    [rate.capturedValue, 0x00, 0x00],
  );
  await driver.rawReport(REPORT.SHORT, fallbackPayload);
  return {
    channel,
    ms: rate.ms,
    hz: rate.hz,
    deviceIndex: fallbackIndex,
    softwareId: fallbackSoftwareId,
    report: `10 ${bytesToHex(fallbackPayload)}`,
    acknowledged: false,
    attempts,
  };
}

async function writeCapturedBhop(driver) {
  const { enabled, timeout } = syncBhopInputs();
  const encodedTimeout = enabled ? timeout / 10 : 0;
  const attempts = [];
  const candidates = unique([DEFAULT_RECEIVER_DEVICE_INDEX, activeDeviceIndex(), DEFAULT_WIRED_DEVICE_INDEX]);
  for (const deviceIndex of candidates) {
    const softwareIds = unique([BHOP_SOFTWARE_ID, softwareIdForDeviceIndex(deviceIndex)]);
    for (const softwareId of softwareIds) {
      try {
        const frame = await sendCapturedShort(driver, {
          deviceIndex,
          featureIndex: BHOP_FEATURE_INDEX,
          functionId: BHOP_WRITE_FUNCTION,
          softwareId,
          params: [encodedTimeout, 0x00, 0x00],
          timeoutMs: 700,
        });
        return {
          enabled,
          timeout,
          encodedTimeout,
          deviceIndex,
          softwareId,
          ...frame,
        };
      } catch (error) {
        attempts.push({ deviceIndex, softwareId, error: errorSummary(error) });
      }
    }
  }

  const fallbackIndex = DEFAULT_RECEIVER_DEVICE_INDEX;
  const payload = buildShortPayload(fallbackIndex, BHOP_FEATURE_INDEX, BHOP_WRITE_FUNCTION, BHOP_SOFTWARE_ID, [
    encodedTimeout,
    0x00,
    0x00,
  ]);
  await driver.rawReport(REPORT.SHORT, payload);
  return {
    enabled,
    timeout,
    encodedTimeout,
    deviceIndex: fallbackIndex,
    softwareId: BHOP_SOFTWARE_ID,
    report: `10 ${bytesToHex(payload)}`,
    acknowledged: false,
    attempts,
  };
}

function sensorDpiRange(sensor) {
  const list = [...(sensor?.list ?? [])].filter(Boolean).sort((a, b) => a - b);
  const min = G_HUB_ADVANCED_DPI_RANGE.min;
  const max = Math.max(G_HUB_ADVANCED_DPI_RANGE.max, list[list.length - 1] ?? 0);
  const step = G_HUB_ADVANCED_DPI_RANGE.step;
  return { list, min, max, step };
}

function selectedSensor() {
  return state.dpiSensors[0] ?? null;
}

function selectedSensorDpi() {
  const sensor = selectedSensor();
  const range = sensorDpiRange(sensor);
  return normalizeToStep($("#sensorDpiInput").value || $("#sensorDpi").value, range);
}

function syncDpiInputs(value) {
  const sensor = selectedSensor();
  const range = sensorDpiRange(sensor);
  const dpi = normalizeToStep(value, range);
  $("#sensorDpi").value = String(dpi);
  $("#sensorDpiInput").value = String(dpi);
  if ([...$("#dpiPreset").options].some((option) => option.value === String(dpi))) {
    $("#dpiPreset").value = String(dpi);
  }
  return dpi;
}

function renderDpiControls() {
  if (!state.dpiSensors.length) {
    $("#dpiSensorMeta").textContent = "-";
    return;
  }

  const sensor = selectedSensor();
  const { list, min, max, step } = sensorDpiRange(sensor);
  const slider = $("#sensorDpi");
  const value = sensor.current || sensor.default || list[0] || 1600;
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  $("#sensorDpiInput").min = String(min);
  $("#sensorDpiInput").max = String(max);
  $("#sensorDpiInput").step = String(step);

  const presetSelect = $("#dpiPreset");
  const presetOptions = unique([...list, 400, 800, 1600, 3200, 4800, 6400]).filter((dpi) => dpi >= min && dpi <= max);
  presetSelect.replaceChildren(
    ...presetOptions.map((dpi) => {
      const option = document.createElement("option");
      option.value = String(dpi);
      option.textContent = `${dpi} DPI`;
      return option;
    }),
  );
  syncDpiInputs(value);
  $("#dpiSensorMeta").textContent = `${min}-${max} DPI / ${step} step`;
}

function renderCapturedDpiControls(advanced = null) {
  const current = advanced?.current || selectedSensorDpi() || 1600;
  state.dpiSensors = [
    {
      index: advanced?.sensorIndex ?? 0,
      list: [400, 800, 1600, 3200, 4800, 6400],
      step: G_HUB_ADVANCED_DPI_RANGE.step,
      current,
      default: advanced?.default || 1600,
      lod: advanced?.lod ?? 0x02,
      y: advanced?.y || current,
      capturedAdvanced: true,
    },
  ];
  renderDpiControls();
  $("#dpiSensorMeta").textContent = `${G_HUB_ADVANCED_DPI_RANGE.min}-${G_HUB_ADVANCED_DPI_RANGE.max} DPI / ${G_HUB_ADVANCED_DPI_RANGE.step} step`;
}

async function refreshAdvancedDpiControls(driver) {
  try {
    state.extendedDpi = await driver.getExtendedDpi(0);
    renderCapturedDpiControls(state.extendedDpi);
    log("advanced DPI loaded", {
      current: state.extendedDpi.current,
      default: state.extendedDpi.default,
      y: state.extendedDpi.y,
      lod: state.extendedDpi.lod,
    });
  } catch (error) {
    state.extendedDpi = { error: errorSummary(error) };
    renderCapturedDpiControls();
    log("advanced DPI read skipped", errorSummary(error));
  }
}

function reportRatesForChannel(channel) {
  const rates = state.reportRates[channel] ?? [];
  if (rates.length) return rates;
  return channel === "wireless" ? [...FALLBACK_REPORT_RATES] : [...STANDARD_REPORT_RATES];
}

function rateByMs(channel, ms) {
  return reportRatesForChannel(channel).find((rate) => rate.ms === Number(ms)) ?? reportRatesForChannel(channel)[0];
}

function mergeReportRates(...groups) {
  const byMs = new Map();
  for (const rate of groups.flat()) {
    const captured = FALLBACK_REPORT_RATES.find((item) => item.ms === rate.ms);
    byMs.set(rate.ms, {
      ...byMs.get(rate.ms),
      ...rate,
      capturedValue: rate.capturedValue ?? captured?.capturedValue,
    });
  }
  return [...byMs.values()].sort((a, b) => a.ms - b.ms);
}

function renderReportRateChannel(channel, currentMs = null) {
  const prefix = channel === "wired" ? "wired" : "wireless";
  const rates = reportRatesForChannel(channel);
  const select = $(`#${prefix}ReportRateMs`);
  select.replaceChildren(
    ...rates.map((rate, index) => {
      const option = document.createElement("option");
      option.value = String(rate.ms);
      option.textContent = `${rate.hz} Hz`;
      option.dataset.index = String(index);
      return option;
    }),
  );
  const current = rateByMs(channel, currentMs ?? state.currentReportRate[channel] ?? 1);
  if (!current) {
    return;
  }
  state.currentReportRate[channel] = current.ms;
  select.value = String(current.ms);
}

function renderReportRateControls(current = {}) {
  renderReportRateChannel("wireless", current.wireless ?? current.ms ?? null);
  renderReportRateChannel("wired", current.wired ?? current.ms ?? null);
}

function syncReportRateChannel(channel, ms) {
  const rate = rateByMs(channel, Number(ms));
  if (!rate) return null;
  const prefix = channel === "wired" ? "wired" : "wireless";
  $(`#${prefix}ReportRateMs`).value = String(rate.ms);
  state.currentReportRate[channel] = rate.ms;
  return rate;
}

function selectedBhopTimeout() {
  return normalizeToStep($("#bhopTimeoutInput").value || $("#bhopTimeout").value, BHOP_TIMEOUT_RANGE);
}

function syncBhopInputs(value = selectedBhopTimeout()) {
  const timeout = normalizeToStep(value, BHOP_TIMEOUT_RANGE);
  const enabled = $("#bhopEnabled").checked;
  state.bhop = { enabled, timeout };
  $("#bhopTimeout").value = String(timeout);
  $("#bhopTimeoutInput").value = String(timeout);
  setOutput("#bhopTimeoutValue", `${timeout}ミリ秒`);
  $("#bhopTimeout").disabled = !enabled;
  $("#bhopTimeoutInput").disabled = !enabled;
  return state.bhop;
}

function renderBhopControls() {
  $("#bhopTimeout").min = String(BHOP_TIMEOUT_RANGE.min);
  $("#bhopTimeout").max = String(BHOP_TIMEOUT_RANGE.max);
  $("#bhopTimeout").step = String(BHOP_TIMEOUT_RANGE.step);
  $("#bhopTimeoutInput").min = String(BHOP_TIMEOUT_RANGE.min);
  $("#bhopTimeoutInput").max = String(BHOP_TIMEOUT_RANGE.max);
  $("#bhopTimeoutInput").step = String(BHOP_TIMEOUT_RANGE.step);
  $("#bhopEnabled").checked = state.bhop.enabled;
  syncBhopInputs(state.bhop.timeout);
}

async function refreshConfigurableControls(driver) {
  if (hasFeature(FEATURE.ADJUSTABLE_DPI)) {
    state.dpiSensors = await driver.getDpiSensors();
    renderDpiControls();
  } else if (hasFeature(FEATURE.ADJUSTABLE_DPI_ADVANCED)) {
    await refreshAdvancedDpiControls(driver);
  }
  if (hasFeature(FEATURE.ADJUSTABLE_REPORT_RATE)) {
    const [list, current] = await Promise.all([driver.getReportRateList(), driver.getReportRate()]);
    const standardRates = mergeReportRates(list.rates.length ? list.rates : STANDARD_REPORT_RATES);
    state.reportRates = {
      wired: standardRates,
      wireless: mergeReportRates(FALLBACK_REPORT_RATES, standardRates),
    };
    state.currentReportRate = { wired: current.ms || 1, wireless: current.ms || 1 };
    renderReportRateControls({ wired: current.ms || 1, wireless: current.ms || 1 });
  } else {
    state.reportRates = {
      wired: [...STANDARD_REPORT_RATES],
      wireless: [...FALLBACK_REPORT_RATES],
    };
    renderReportRateControls(state.currentReportRate);
  }
  renderBhopControls();
  renderHitsModel();
}

async function refreshAll(driver) {
  const version = await driver.getProtocolVersion();
  $("#protocol").textContent = `${version.major}.${version.minor}`;

  state.features = await driver.enumerateFeatures();
  renderCapabilities();

  const onboardSupported = hasFeature(FEATURE.ONBOARD_PROFILES);
  if (!onboardSupported) {
    renderOnboardUnavailable();
    log("on-board profiles feature 0x8100 is not exposed by this interface");
  } else {
    state.onboardDescription = await driver.getOnboardDescription();
    try {
      const profileHeaders = await driver.getOnboardProfileHeaders(state.onboardDescription);
      state.onboardProfiles = profileHeaders.headers;
      log("on-board profile sectors loaded", {
        profiles: state.onboardProfiles.map(({ profileIndex, sector, enabled }) => ({ profileIndex, sector, enabled })),
      });
    } catch (error) {
      state.onboardProfiles = [];
      log("on-board profile sectors skipped", errorSummary(error));
    }
    state.activeProfileIndex = selectedProfileIndex();
    state.currentDpiIndex = DEFAULT_DPI_INDEX;
    await ensureOnboardReady(driver);
    await syncOnboardLiveState(driver);
    log("on-board memory mode enforced", {
      mode: "onboard",
      memoryType: ONBOARD_MEMORY_TYPE.WRITEABLE,
      profileIndex: selectedProfileIndex(),
    });
  }

  const dpiSupported = hasDpiFeature();
  $("#dpiPanel").hidden = !dpiSupported;
  $("#reportRatePanel").hidden = false;
  $("#bhopPanel").hidden = false;
  await refreshConfigurableControls(driver);
}

async function connect() {
  try {
    setStatus("device picker waiting", "busy");
    const device = await LogitechHidpp20Driver.requestDevice();
    renderDevice(device);
    if (state.unsubscribe) state.unsubscribe();
    if (state.driver) await state.driver.close();

    const opened = await openResponsiveDriver(device);
    const driver = opened.driver;
    state.driver = driver;
    state.unsubscribe = driver.onReport((frame) => {
      log("report", { raw: frame.hex });
    });
    await refreshAll(driver);
    setStatus("connected", "ok");
    log("connected", {
      productName: device.productName,
      vendorId: device.vendorId,
      productId: device.productId,
      probeAttempts: opened.attempts,
    });
  } catch (error) {
    setStatus(error.message, "error");
    log("connect failed", { message: error.message, name: error.name, attempts: error.attempts });
  }
}

async function writeHitsFrames(driver) {
  const frames = [];
  for (const { sideIndex } of hitsSettings()) {
    const attempts = [];
    let accepted = null;
    for (const deviceIndex of candidateDeviceIndexes(activeDeviceIndex())) {
      const payload = buildCapturedHitsPayload(sideIndex, deviceIndex);
      try {
        const response = await driver.rawReport(REPORT.LONG, payload, {
          waitForAny: true,
          timeoutMs: 900,
          match: (frame) => {
            if (!capturedFrameMatcher(deviceIndex, HITS_FEATURE_INDEX, HITS_WRITE_FUNCTION, HITS_SOFTWARE_ID)(frame)) {
              return false;
            }
            return frame.error || frame.parameters[0] === sideIndex;
          },
        });
        accepted = {
          sideIndex,
          report: `11 ${bytesToHex(payload)}`,
          response: response?.hex,
        };
        break;
      } catch (error) {
        attempts.push({
          sideIndex,
          deviceIndex,
          report: `11 ${bytesToHex(payload)}`,
          error: errorSummary(error),
        });
      }
    }
    frames.push(accepted ?? { sideIndex, acknowledged: false, attempts });
    await delay(40);
  }
  return frames;
}

async function applyOnboardProfile() {
  await withOnboardMutation(async (driver) => {
    const applied = {
      profileIndex: selectedProfileIndex(),
    };

    if (hasDpiFeature() && state.dpiSensors.length) {
      applied.dpi = {
        sensorIndex: selectedSensor()?.index ?? 0,
        dpi: selectedSensorDpi(),
      };
      syncDpiInputs(applied.dpi.dpi);
      Object.assign(applied.dpi, await writeSelectedSensorDpi(driver, applied.dpi.sensorIndex, applied.dpi.dpi));
    }

    applied.reportRate = {
      wireless: await writeCapturedReportRate(driver, "wireless", Number($("#wirelessReportRateMs").value)),
      wired: await writeCapturedReportRate(driver, "wired", Number($("#wiredReportRateMs").value)),
    };

    if (hasFeature(FEATURE.ADJUSTABLE_REPORT_RATE)) {
      const currentMs = Number($("#wiredReportRateMs").value || $("#wirelessReportRateMs").value || 1);
      try {
        if (currentMs >= 1) {
          await driver.setReportRateMs(currentMs);
          applied.reportRate.standard = await driver.getReportRate();
        } else {
          applied.reportRate.standard = "skipped for captured high-rate value";
        }
      } catch (error) {
        applied.reportRate.standard = { error: errorSummary(error) };
      }
    }

    applied.bhop = await writeCapturedBhop(driver);
    applied.hits = buildHitsSettingsPatch();
    applied.hitsFrames = await writeHitsFrames(driver);
    await refreshConfigurableControls(driver);
    log("on-board profile saved", applied);
  }, "writing on-board profile");
}

$("#connect").addEventListener("click", connect);
$("#refresh").addEventListener("click", () => withDriver(refreshAll, "refreshing"));
$("#applyOnboardProfile").addEventListener("click", applyOnboardProfile);

for (const selector of [
  "#leftHitsActuation",
  "#leftHitsRapid",
  "#leftHitsHaptics",
  "#rightHitsActuation",
  "#rightHitsRapid",
  "#rightHitsHaptics",
]) {
  $(selector).addEventListener("input", renderHitsModel);
  $(selector).addEventListener("change", renderHitsModel);
}

$("#sensorDpi").addEventListener("input", () => {
  syncDpiInputs($("#sensorDpi").value);
});
$("#sensorDpiInput").addEventListener("input", () => {
  syncDpiInputs($("#sensorDpiInput").value);
});
$("#sensorDpiInput").addEventListener("change", () => {
  syncDpiInputs($("#sensorDpiInput").value);
});
$("#dpiPreset").addEventListener("change", () => {
  if ($("#dpiPreset").value) {
    syncDpiInputs($("#dpiPreset").value);
  }
});
$("#wirelessReportRateMs").addEventListener("change", () =>
  syncReportRateChannel("wireless", Number($("#wirelessReportRateMs").value)),
);
$("#wiredReportRateMs").addEventListener("change", () => syncReportRateChannel("wired", Number($("#wiredReportRateMs").value)));
$("#bhopEnabled").addEventListener("change", () => syncBhopInputs());
$("#bhopTimeout").addEventListener("input", () => syncBhopInputs($("#bhopTimeout").value));
$("#bhopTimeoutInput").addEventListener("input", () => syncBhopInputs($("#bhopTimeoutInput").value));
$("#bhopTimeoutInput").addEventListener("change", () => syncBhopInputs($("#bhopTimeoutInput").value));

if (!("hid" in navigator)) {
  setStatus("WebHID 非対応ブラウザです。Chrome/Edge/Vivaldi の localhost で開いてください。", "error");
} else {
  setStatus("ready");
}
renderCapabilities();
renderReportRateControls(state.currentReportRate);
renderBhopControls();
renderHitsModel();
