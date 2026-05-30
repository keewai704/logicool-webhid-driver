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

const DEFAULT_DEVICE_INDEX = 0x01;
const DEFAULT_PROFILE_INDEX = 0;
const DEFAULT_DPI_SLOT = 0;
const DEFAULT_DPI_SLOT_COUNT = 5;
const HITS_FEATURE_INDEX = 0x0c;
const HITS_WRITE_FUNCTION = 0x01;
const HITS_PRESSURE_FUNCTION = 0x00;
const HITS_SOFTWARE_ID = 0x0d;
const HITS_PRESSURE_MAX = 5;
const HIDPP_INVALID_ARGUMENT = 0x02;

const state = {
  driver: null,
  unsubscribe: null,
  features: [],
  onboardDescription: null,
  dpiSensors: [],
  reportRates: [],
  pressureRaw: 0,
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

function setOutput(selector, value) {
  const el = $(selector);
  el.value = String(value);
  el.textContent = String(value);
}

function hitsButtonsForTarget() {
  const target = $("#hitsTarget").value;
  if (target === "left") return [SUPERSTRIKE_HITS_MODEL.buttonIds.left];
  if (target === "right") return [SUPERSTRIKE_HITS_MODEL.buttonIds.right];
  return [SUPERSTRIKE_HITS_MODEL.buttonIds.left, SUPERSTRIKE_HITS_MODEL.buttonIds.right];
}

function hitsSideIndexesForTarget() {
  const target = $("#hitsTarget").value;
  if (target === "left") return [0];
  if (target === "right") return [1];
  return [0, 1];
}

function hitsTargetLabel() {
  const target = $("#hitsTarget").value;
  if (target === "left") return "LEFT";
  if (target === "right") return "RIGHT";
  return "LEFT + RIGHT";
}

function buildHitsSettingsPatch() {
  const buttons = hitsButtonsForTarget();
  const actuation = Number($("#hitsActuation").value);
  const rapid = Number($("#hitsRapid").value);
  const haptics = Number($("#hitsHaptics").value);
  const rapidEnabled = $("#hitsRapidEnabled").checked;
  return {
    targetButtonIds: buttons,
    analogPreset: {
      actuationPointValues: Object.fromEntries(buttons.map((button) => [button, actuation])),
      rapidTriggerExplicitStates: rapidEnabled ? buttons : [],
      rapidTriggerValues: Object.fromEntries(buttons.map((button) => [button, rapid])),
      clickHapticsValues: Object.fromEntries(buttons.map((button) => [button, haptics])),
    },
  };
}

function buildCapturedHitsPayload(sideIndex) {
  const actuation = Number($("#hitsActuation").value);
  const rapid = Number($("#hitsRapid").value);
  const rapidEnabled = $("#hitsRapidEnabled").checked;
  const haptics = Number($("#hitsHaptics").value);
  const payload = new Uint8Array(19);
  payload.set([
    DEFAULT_DEVICE_INDEX,
    HITS_FEATURE_INDEX,
    (HITS_WRITE_FUNCTION << 4) | HITS_SOFTWARE_ID,
    sideIndex & 0xff,
    Math.max(0, Math.min(0xff, actuation * 4)),
    Math.max(0, Math.min(0xff, rapid * 4 + (rapidEnabled ? 1 : 0))),
    Math.max(0, Math.min(0xff, haptics * 4)),
  ]);
  return payload;
}

function hitsPreviewFrames() {
  return hitsSideIndexesForTarget().map((sideIndex) => `11 ${bytesToHex(buildCapturedHitsPayload(sideIndex))}`);
}

function renderHitsModel() {
  const actuation = $("#hitsActuation").value;
  const rapid = $("#hitsRapid").value;
  const haptics = $("#hitsHaptics").value;
  setOutput("#hitsActuationValue", actuation);
  setOutput("#hitsRapidValue", rapid);
  setOutput("#hitsHapticsValue", haptics);
  for (const selector of ["#leftActuation", "#rightActuation"]) $(selector).textContent = actuation;
  for (const selector of ["#leftRapid", "#rightRapid"]) $(selector).textContent = rapid;
  for (const selector of ["#leftHaptics", "#rightHaptics"]) $(selector).textContent = haptics;
  $("#hitsSummary").textContent = `${hitsTargetLabel()} / RT ${$("#hitsRapidEnabled").checked ? "ON" : "OFF"}`;
  $("#hitsFramePreview").textContent = `${hitsPreviewFrames().length} frame(s) ready`;
}

function renderHitsPressure(rawValue) {
  const raw = clamp(Number(rawValue) || 0, 0, HITS_PRESSURE_MAX);
  state.pressureRaw = raw;
  const percent = Math.round((raw / HITS_PRESSURE_MAX) * 100);
  $("#pressureRaw").textContent = `RAW ${raw}`;
  $("#pressureValue").textContent = `${percent}%`;
  $("#pressureFill").style.width = `${percent}%`;
  $("#pressureHint").textContent = raw ? "押し込み検出中" : "リリース";
}

function handleHitsPressureFrame(frame) {
  if (
    frame.reportId !== REPORT.LONG ||
    frame.deviceIndex !== DEFAULT_DEVICE_INDEX ||
    frame.featureIndex !== HITS_FEATURE_INDEX ||
    frame.functionId !== HITS_PRESSURE_FUNCTION ||
    frame.softwareId !== 0x00
  ) {
    return false;
  }
  renderHitsPressure(frame.parameters[0]);
  return true;
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

function renderCapabilities() {
  const capabilities = [
    { label: "ON-BOARD", supported: hasFeature(FEATURE.ONBOARD_PROFILES) },
    { label: "DPI", supported: hasFeature(FEATURE.ADJUSTABLE_DPI) },
    { label: "REPORT RATE", supported: hasFeature(FEATURE.ADJUSTABLE_REPORT_RATE) },
    { label: "HITS", supported: true },
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
  $("#profileStatus").textContent = "-";
  $("#dpiSlotStatus").textContent = "-";
  $("#onboardMeta").textContent = "-";
}

function renderOnboardState({ mode, profile, dpi, description }) {
  const badge = $("#onboardBadge");
  const isOnboard = mode?.mode === ONBOARD_MODE.ONBOARD;
  badge.textContent = isOnboard ? "ON" : mode?.label?.toUpperCase() || "UNKNOWN";
  badge.dataset.state = isOnboard ? "ok" : "warn";
  $("#profileStatus").textContent = `SLOT ${(profile?.profileIndex ?? selectedProfileIndex()) + 1}`;
  $("#dpiSlotStatus").textContent = `DPI ${(dpi?.dpiIndex ?? selectedDpiSlot()) + 1}`;
  $("#onboardMeta").textContent = `${description?.profileCount ?? 1} profile(s) / ${description?.sectorCount ?? "-"} sectors`;
}

function selectedProfileIndex() {
  const count = Math.max(1, state.onboardDescription?.profileCount ?? 1);
  const value = Number.parseInt($("#profileSlot").value || String(DEFAULT_PROFILE_INDEX), 10);
  return clamp(Number.isFinite(value) ? value : DEFAULT_PROFILE_INDEX, 0, count - 1);
}

function selectedDpiSlot() {
  const value = Number.parseInt($("#dpiSlot").value || String(DEFAULT_DPI_SLOT), 10);
  return clamp(Number.isFinite(value) ? value : DEFAULT_DPI_SLOT, 0, 15);
}

function updateProfileOptions(description, selected = DEFAULT_PROFILE_INDEX) {
  const select = $("#profileSlot");
  const count = Math.max(1, description?.profileCount ?? 1);
  const nextValue = clamp(selected, 0, count - 1);
  select.replaceChildren(
    ...Array.from({ length: count }, (_, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `SLOT ${index + 1}`;
      return option;
    }),
  );
  select.value = String(nextValue);
}

function updateDpiSlotOptions(selected = DEFAULT_DPI_SLOT) {
  const select = $("#dpiSlot");
  const count = Math.max(DEFAULT_DPI_SLOT_COUNT, selected + 1);
  select.replaceChildren(
    ...Array.from({ length: count }, (_, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `DPI ${index + 1}`;
      return option;
    }),
  );
  select.value = String(clamp(selected, 0, count - 1));
}

async function syncOnboardLiveState(driver) {
  if (!hasFeature(FEATURE.ONBOARD_PROFILES)) return;
  const [mode, profile, dpi] = await Promise.all([
    driver.getOnboardMode(),
    driver.getCurrentProfile(),
    driver.getCurrentDpiIndex(),
  ]);
  updateProfileOptions(state.onboardDescription, profile.profileIndex ?? DEFAULT_PROFILE_INDEX);
  updateDpiSlotOptions(dpi.dpiIndex ?? DEFAULT_DPI_SLOT);
  renderOnboardState({ mode, profile, dpi, description: state.onboardDescription });
}

async function ensureOnboardReady(driver) {
  if (!hasFeature(FEATURE.ONBOARD_PROFILES)) {
    throw new Error("オンボードメモリ機能が見つかりません");
  }
  const profileIndex = selectedProfileIndex();
  await driver.setOnboardMode(ONBOARD_MODE.ONBOARD);
  try {
    await driver.setCurrentProfile(ONBOARD_MEMORY_TYPE.WRITEABLE, profileIndex);
  } catch (error) {
    if (error.code !== HIDPP_INVALID_ARGUMENT) throw error;
    log("profile slot selection skipped", {
      reason: "device rejected writable profile selection",
      featureIndex: error.frame?.error?.featureIndex,
      profileIndex,
    });
  }
  $("#onboardBadge").textContent = "ON";
  $("#onboardBadge").dataset.state = "ok";
  $("#profileStatus").textContent = `SLOT ${profileIndex + 1}`;
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

async function withOnboardMutation(action, busyText) {
  await withDriver(async (driver) => {
    await ensureOnboardReady(driver);
    await action(driver);
    await syncOnboardLiveState(driver);
  }, busyText);
}

function sensorDpiRange(sensor) {
  const list = [...(sensor?.list ?? [])].filter(Boolean).sort((a, b) => a - b);
  const min = list[0] ?? 100;
  const max = list[list.length - 1] ?? 25600;
  const step = sensor?.step || 50;
  return { list, min, max, step };
}

function renderDpiControls() {
  const sensorSelect = $("#dpiSensorIndex");
  sensorSelect.replaceChildren(
    ...state.dpiSensors.map((sensor) => {
      const option = document.createElement("option");
      option.value = String(sensor.index);
      option.textContent = `Sensor ${sensor.index + 1}`;
      return option;
    }),
  );
  if (!state.dpiSensors.length) {
    $("#dpiSensorMeta").textContent = "-";
    return;
  }

  const selectedIndex = Number(sensorSelect.value || state.dpiSensors[0].index);
  const sensor = state.dpiSensors.find((item) => item.index === selectedIndex) ?? state.dpiSensors[0];
  sensorSelect.value = String(sensor.index);
  const { list, min, max, step } = sensorDpiRange(sensor);
  const slider = $("#sensorDpi");
  const value = sensor.current || sensor.default || list[0] || 1600;
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(clamp(value, min, max));
  setOutput("#sensorDpiValue", slider.value);

  const presetSelect = $("#dpiPreset");
  const presetOptions = list.length ? list : [Number(slider.value)];
  presetSelect.replaceChildren(
    ...presetOptions.map((dpi) => {
      const option = document.createElement("option");
      option.value = String(dpi);
      option.textContent = `${dpi} DPI`;
      return option;
    }),
  );
  if (presetOptions.includes(Number(slider.value))) presetSelect.value = slider.value;
  $("#dpiSensorMeta").textContent = `${min}-${max} DPI / ${step} step`;
}

function renderReportRateControls(currentMs = null) {
  const select = $("#reportRateMs");
  select.replaceChildren(
    ...state.reportRates.map((rate, index) => {
      const option = document.createElement("option");
      option.value = String(rate.ms);
      option.textContent = `${rate.hz} Hz`;
      option.dataset.index = String(index);
      return option;
    }),
  );
  const current = state.reportRates.find((rate) => rate.ms === currentMs) ?? state.reportRates[0];
  if (!current) {
    $("#reportRateText").textContent = "-";
    return;
  }
  select.value = String(current.ms);
  const slider = $("#reportRateSlider");
  const currentIndex = Math.max(0, state.reportRates.findIndex((rate) => rate.ms === current.ms));
  slider.min = "0";
  slider.max = String(Math.max(0, state.reportRates.length - 1));
  slider.step = "1";
  slider.value = String(currentIndex);
  setOutput("#reportRateValue", `${current.hz} Hz`);
  $("#reportRateText").textContent = `${current.hz} Hz`;
}

async function refreshConfigurableControls(driver) {
  if (hasFeature(FEATURE.ADJUSTABLE_DPI)) {
    state.dpiSensors = await driver.getDpiSensors();
    renderDpiControls();
  }
  if (hasFeature(FEATURE.ADJUSTABLE_REPORT_RATE)) {
    const [list, current] = await Promise.all([driver.getReportRateList(), driver.getReportRate()]);
    state.reportRates = list.rates.length
      ? list.rates
      : [
          { ms: 1, hz: 1000 },
          { ms: 2, hz: 500 },
          { ms: 4, hz: 250 },
          { ms: 8, hz: 125 },
        ];
    renderReportRateControls(current.ms || 1);
  }
  renderHitsModel();
}

async function refreshAll(driver) {
  const version = await driver.getProtocolVersion();
  $("#protocol").textContent = `${version.major}.${version.minor}`;

  state.features = await driver.enumerateFeatures();
  renderCapabilities();

  const onboardSupported = hasFeature(FEATURE.ONBOARD_PROFILES);
  $("#onboardPanel").hidden = !onboardSupported;
  if (!onboardSupported) {
    renderOnboardUnavailable();
    log("on-board profiles feature 0x8100 is not exposed by this interface");
  } else {
    state.onboardDescription = await driver.getOnboardDescription();
    updateProfileOptions(state.onboardDescription, DEFAULT_PROFILE_INDEX);
    updateDpiSlotOptions(DEFAULT_DPI_SLOT);
    await ensureOnboardReady(driver);
    await syncOnboardLiveState(driver);
    log("on-board memory mode enforced", {
      mode: "onboard",
      memoryType: ONBOARD_MEMORY_TYPE.WRITEABLE,
      profileIndex: selectedProfileIndex(),
    });
  }

  const dpiSupported = hasFeature(FEATURE.ADJUSTABLE_DPI);
  $("#dpiPanel").hidden = !dpiSupported;
  const reportRateSupported = hasFeature(FEATURE.ADJUSTABLE_REPORT_RATE);
  $("#reportRatePanel").hidden = !reportRateSupported;
  await refreshConfigurableControls(driver);
}

async function connect() {
  try {
    setStatus("device picker waiting", "busy");
    const device = await LogitechHidpp20Driver.requestDevice();
    renderDevice(device);
    if (state.unsubscribe) state.unsubscribe();
    if (state.driver) await state.driver.close();

    const driver = await LogitechHidpp20Driver.fromDevice(device, { deviceIndex: DEFAULT_DEVICE_INDEX });
    state.driver = driver;
    state.unsubscribe = driver.onReport((frame) => {
      if (handleHitsPressureFrame(frame)) return;
      log("report", { raw: frame.hex });
    });
    await refreshAll(driver);
    setStatus("connected", "ok");
    log("connected", {
      productName: device.productName,
      vendorId: device.vendorId,
      productId: device.productId,
    });
  } catch (error) {
    setStatus(error.message, "error");
    log("connect failed", { message: error.message, name: error.name });
  }
}

async function setCurrentProfile() {
  const profileIndex = selectedProfileIndex();
  await withOnboardMutation(async () => {
    log("profile slot requested", { memoryType: ONBOARD_MEMORY_TYPE.WRITEABLE, profileIndex });
  }, "setting profile");
}

async function setDpiSlot() {
  await withOnboardMutation(async (driver) => {
    const dpiIndex = selectedDpiSlot();
    await driver.setCurrentDpiIndex(dpiIndex);
    log("DPI slot selected", { dpiIndex });
  }, "setting DPI slot");
}

async function setReportRate() {
  await withOnboardMutation(async (driver) => {
    const ms = Number($("#reportRateMs").value);
    await driver.setReportRateMs(ms);
    const current = await driver.getReportRate();
    renderReportRateControls(current.ms);
    log("report rate set", current);
  }, "setting report rate");
}

async function setSensorDpi() {
  await withOnboardMutation(async (driver) => {
    const sensorIndex = Number($("#dpiSensorIndex").value || 0);
    const dpi = Number($("#sensorDpi").value);
    await driver.setSensorDpi(sensorIndex, dpi);
    state.dpiSensors = await driver.getDpiSensors();
    renderDpiControls();
    log("sensor DPI set", { sensorIndex, dpi });
  }, "setting sensor DPI");
}

async function writeHitsFrames(driver) {
  const frames = [];
  for (const sideIndex of hitsSideIndexesForTarget()) {
    const payload = buildCapturedHitsPayload(sideIndex);
    const response = await driver.rawReport(REPORT.LONG, payload, {
      waitForAny: true,
      timeoutMs: 1500,
      match: (frame) => {
        if (frame.deviceIndex !== DEFAULT_DEVICE_INDEX) return false;
        if (frame.error) {
          return (
            frame.error.featureIndex === HITS_FEATURE_INDEX &&
            frame.error.functionId === HITS_WRITE_FUNCTION &&
            frame.error.softwareId === HITS_SOFTWARE_ID
          );
        }
        return (
          frame.featureIndex === HITS_FEATURE_INDEX &&
          frame.functionId === HITS_WRITE_FUNCTION &&
          frame.softwareId === HITS_SOFTWARE_ID &&
          frame.parameters[0] === sideIndex
        );
      },
    });
    frames.push({
      sideIndex,
      report: `11 ${bytesToHex(payload)}`,
      response: response?.hex,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return frames;
}

async function applyCapturedHits() {
  await withOnboardMutation(async (driver) => {
    const frames = await writeHitsFrames(driver);
    log("HITS applied", { settings: buildHitsSettingsPatch(), frames });
  }, "applying HITS");
}

async function applyOnboardProfile() {
  await withOnboardMutation(async (driver) => {
    const applied = {
      profileIndex: selectedProfileIndex(),
      dpiSlot: selectedDpiSlot(),
    };

    await driver.setCurrentDpiIndex(applied.dpiSlot);

    if (hasFeature(FEATURE.ADJUSTABLE_DPI) && state.dpiSensors.length) {
      applied.dpi = {
        sensorIndex: Number($("#dpiSensorIndex").value || 0),
        dpi: Number($("#sensorDpi").value),
      };
      await driver.setSensorDpi(applied.dpi.sensorIndex, applied.dpi.dpi);
    }

    if (hasFeature(FEATURE.ADJUSTABLE_REPORT_RATE) && state.reportRates.length) {
      applied.reportRate = {
        ms: Number($("#reportRateMs").value),
        hz: Math.round(1000 / Number($("#reportRateMs").value)),
      };
      await driver.setReportRateMs(applied.reportRate.ms);
    }

    applied.hits = buildHitsSettingsPatch();
    applied.hitsFrames = await writeHitsFrames(driver);
    await refreshConfigurableControls(driver);
    log("on-board profile saved", applied);
  }, "writing on-board profile");
}

$("#connect").addEventListener("click", connect);
$("#refresh").addEventListener("click", () => withDriver(refreshAll, "refreshing"));
$("#applyOnboardProfile").addEventListener("click", applyOnboardProfile);
$("#setCurrentProfile").addEventListener("click", setCurrentProfile);
$("#setDpiSlot").addEventListener("click", setDpiSlot);
$("#setSensorDpi").addEventListener("click", setSensorDpi);
$("#setReportRate").addEventListener("click", setReportRate);
$("#applyCapturedHits").addEventListener("click", applyCapturedHits);

for (const selector of ["#hitsTarget", "#hitsActuation", "#hitsRapidEnabled", "#hitsRapid", "#hitsHaptics"]) {
  $(selector).addEventListener("input", renderHitsModel);
  $(selector).addEventListener("change", renderHitsModel);
}

$("#sensorDpi").addEventListener("input", () => {
  setOutput("#sensorDpiValue", $("#sensorDpi").value);
});
$("#dpiPreset").addEventListener("change", () => {
  if ($("#dpiPreset").value) {
    $("#sensorDpi").value = $("#dpiPreset").value;
    setOutput("#sensorDpiValue", $("#dpiPreset").value);
  }
});
$("#dpiSensorIndex").addEventListener("change", renderDpiControls);
$("#reportRateMs").addEventListener("change", () => renderReportRateControls(Number($("#reportRateMs").value)));
$("#reportRateSlider").addEventListener("input", () => {
  const rate = state.reportRates[Number($("#reportRateSlider").value)];
  if (!rate) return;
  $("#reportRateMs").value = String(rate.ms);
  setOutput("#reportRateValue", `${rate.hz} Hz`);
  $("#reportRateText").textContent = `${rate.hz} Hz`;
});
$("#profileSlot").addEventListener("change", () => {
  $("#profileStatus").textContent = `SLOT ${selectedProfileIndex() + 1}`;
});
$("#dpiSlot").addEventListener("change", () => {
  $("#dpiSlotStatus").textContent = `DPI ${selectedDpiSlot() + 1}`;
});

if (!("hid" in navigator)) {
  setStatus("WebHID 非対応ブラウザです。Chrome/Edge/Vivaldi の localhost で開いてください。", "error");
} else {
  setStatus("ready");
}
updateProfileOptions(null, DEFAULT_PROFILE_INDEX);
updateDpiSlotOptions(DEFAULT_DPI_SLOT);
renderCapabilities();
renderHitsModel();
renderHitsPressure(0);
