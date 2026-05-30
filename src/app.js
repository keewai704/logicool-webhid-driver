import {
  FEATURE,
  ONBOARD_MEMORY_TYPE,
  ONBOARD_MODE,
  REPORT,
  LogitechHidpp20Driver,
  bytesToHex,
  hex,
  parseHexBytes,
} from "./logitech-hidpp.js";
import { parsePcap, summarizeFrames } from "./pcap-hidpp.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  driver: null,
  unsubscribe: null,
  features: [],
  lastSector: null,
  pcapFrames: [],
  selectedReplayFrames: [],
  dpiSensors: [],
  reportRates: [],
};

const SUPERSTRIKE_HITS_MODEL = Object.freeze({
  buttonIds: {
    left: 80,
    right: 81,
  },
  observedSettingsKeys: {
    actuation: "analogPreset.actuationPointValues[buttonId]",
    rapidTriggerEnabled: "analogPreset.rapidTriggerExplicitStates includes buttonId",
    rapidTrigger: "analogPreset.rapidTriggerValues[buttonId]",
    clickHaptics: "analogPreset.clickHapticsValues[buttonId]",
  },
  capturedHidpp: {
    featureIndex: "0x0c",
    functionId: "0x1",
    softwareId: "0xb",
    hitsTemplate: "11 01 0c 1b <side:00|01> <actuation*4> <rapid*4+enabled> <haptics*4> 00...",
  },
});

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
    0x01,
    0x0c,
    0x1b,
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
  $("#hitsActuationValue").value = $("#hitsActuation").value;
  $("#hitsRapidValue").value = $("#hitsRapid").value;
  $("#hitsHapticsValue").value = $("#hitsHaptics").value;
  $("#hitsModel").textContent = JSON.stringify(
    {
      observedInGHub: SUPERSTRIKE_HITS_MODEL,
      requestedPatch: buildHitsSettingsPatch(),
      outgoingReports: hitsPreviewFrames(),
    },
    null,
    2,
  );
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
  $("#collections").textContent = device.collections
    .map((collection) => {
      const inputs = collection.inputReports?.map((r) => hex(r.reportId)).join(", ") || "-";
      const outputs = collection.outputReports?.map((r) => hex(r.reportId)).join(", ") || "-";
      const features = collection.featureReports?.map((r) => hex(r.reportId)).join(", ") || "-";
      return `usagePage=${hex(collection.usagePage, 4)} usage=${hex(collection.usage, 4)} input=[${inputs}] output=[${outputs}] feature=[${features}]`;
    })
    .join("\n");
}

function renderFeatures(features) {
  const tbody = $("#features tbody");
  tbody.replaceChildren(
    ...features.map((feature) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${hex(feature.index)}</td>
        <td>${hex(feature.id, 4)}</td>
        <td>${feature.name}</td>
        <td>${feature.version ?? "-"}</td>
        <td>${[
          feature.hidden ? "hidden" : "",
          feature.obsolete ? "obsolete" : "",
          feature.internal ? "internal" : "",
        ].filter(Boolean).join(", ") || "-"}</td>
      `;
      return tr;
    }),
  );
}

function updateCurrentDpiOptions(index) {
  const select = $("#dpiIndex");
  select.value = String(index ?? 0);
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

function hasFeature(featureId) {
  return state.features.some((feature) => feature.id === featureId);
}

async function prepareOnboardMutation(driver) {
  if (!$("#forceOnboardWrites").checked || !hasFeature(FEATURE.ONBOARD_PROFILES)) return;
  await driver.setOnboardMode(ONBOARD_MODE.ONBOARD);
  $("#mode").value = String(ONBOARD_MODE.ONBOARD);
}

async function withOnboardMutation(action, busyText) {
  await withDriver(async (driver) => {
    await prepareOnboardMutation(driver);
    await action(driver);
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
      option.textContent = `sensor ${sensor.index}`;
      return option;
    }),
  );
  if (!state.dpiSensors.length) return;
  const selectedIndex = Number(sensorSelect.value || state.dpiSensors[0].index);
  const sensor = state.dpiSensors.find((item) => item.index === selectedIndex) ?? state.dpiSensors[0];
  sensorSelect.value = String(sensor.index);
  const { list, min, max, step } = sensorDpiRange(sensor);
  const slider = $("#sensorDpi");
  const value = sensor.current || sensor.default || list[0] || 1600;
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(Math.max(min, Math.min(max, value)));
  $("#sensorDpiValue").value = slider.value;
  const presetSelect = $("#dpiPreset");
  presetSelect.replaceChildren(
    ...list.map((dpi) => {
      const option = document.createElement("option");
      option.value = String(dpi);
      option.textContent = `${dpi} DPI`;
      return option;
    }),
  );
  if (list.includes(Number(slider.value))) presetSelect.value = slider.value;
  $("#dpiSensors").textContent = JSON.stringify(state.dpiSensors, null, 2);
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
  if (!current) return;
  select.value = String(current.ms);
  const slider = $("#reportRateSlider");
  slider.min = "0";
  slider.max = String(Math.max(0, state.reportRates.length - 1));
  slider.step = "1";
  slider.value = String(state.reportRates.findIndex((rate) => rate.ms === current.ms));
  $("#reportRateValue").value = `${current.hz} Hz`;
}

async function refreshAll(driver) {
  const version = await driver.getProtocolVersion();
  $("#protocol").textContent = `${version.major}.${version.minor}`;

  const features = await driver.enumerateFeatures();
  state.features = features;
  renderFeatures(features);

  const onboardSupported = features.some((feature) => feature.id === FEATURE.ONBOARD_PROFILES);
  $("#onboardPanel").hidden = !onboardSupported;
  if (!onboardSupported) {
    log("on-board profiles feature 0x8100 is not exposed by this interface");
  } else {
    const [desc, mode, profile, dpi] = await Promise.all([
      driver.getOnboardDescription(),
      driver.getOnboardMode(),
      driver.getCurrentProfile(),
      driver.getCurrentDpiIndex(),
    ]);
    $("#onboardDescription").textContent = JSON.stringify(desc, null, 2);
    $("#mode").value = String(mode.mode);
    $("#currentProfile").textContent = `memory=${profile.memoryType} profile=${profile.profileIndex}`;
    updateCurrentDpiOptions(dpi.dpiIndex);
    $("#sectorSize").value = String(desc.sectorSize || 256);
  }

  const dpiSupported = features.some((feature) => feature.id === FEATURE.ADJUSTABLE_DPI);
  $("#dpiPanel").hidden = !dpiSupported;
  if (dpiSupported) {
    state.dpiSensors = await driver.getDpiSensors();
    renderDpiControls();
  }

  const reportRateSupported = features.some((feature) => feature.id === FEATURE.ADJUSTABLE_REPORT_RATE);
  $("#reportRatePanel").hidden = !reportRateSupported;
  if (reportRateSupported) {
    const [list, current] = await Promise.all([driver.getReportRateList(), driver.getReportRate()]);
    state.reportRates = list.rates.length ? list.rates : [
      { ms: 1, hz: 1000 },
      { ms: 2, hz: 500 },
      { ms: 4, hz: 250 },
      { ms: 8, hz: 125 },
    ];
    renderReportRateControls(current.ms || 1);
    $("#reportRateState").textContent = JSON.stringify({ list, current }, null, 2);
  }

  renderHitsModel();
}

async function connect() {
  try {
    setStatus("device picker waiting", "busy");
    const device = await LogitechHidpp20Driver.requestDevice();
    renderDevice(device);
    if (state.unsubscribe) state.unsubscribe();
    if (state.driver) await state.driver.close();

    const deviceIndex = Number.parseInt($("#deviceIndex").value, 16);
    const driver = await LogitechHidpp20Driver.fromDevice(device, { deviceIndex });
    state.driver = driver;
    state.unsubscribe = driver.onReport((frame) => {
      $("#lastReport").textContent = frame.hex;
    });
    await refreshAll(driver);
    setStatus("connected", "ok");
    log("connected", { productName: device.productName, vendorId: device.vendorId, productId: device.productId });
  } catch (error) {
    setStatus(error.message, "error");
    log("connect failed", { message: error.message, name: error.name });
  }
}

async function readSector() {
  await withDriver(async (driver) => {
    const page = Number($("#page").value);
    const sectorSize = Number($("#sectorSize").value);
    const memoryType = Number($("#memoryType").value);
    const data = await driver.readOnboardSector(memoryType, page, sectorSize, ({ offset }) => {
      setStatus(`reading page ${page} @ ${offset}`, "busy");
    });
    state.lastSector = data;
    $("#sectorDump").textContent = Array.from({ length: Math.ceil(data.length / 16) }, (_, line) => {
      const offset = line * 16;
      return `${offset.toString(16).padStart(4, "0")}: ${bytesToHex(data.slice(offset, offset + 16))}`;
    }).join("\n");
    log("read on-board sector", { memoryType, page, sectorSize });
  }, "reading on-board memory");
}

async function rawFeatureCall() {
  await withDriver(async (driver) => {
    const feature = Number.parseInt($("#rawFeature").value, 16);
    const functionId = Number.parseInt($("#rawFunction").value, 16);
    const params = parseHexBytes($("#rawParams").value);
    const response = await driver.rawCall(feature, functionId, params);
    log("raw feature response", {
      reportId: hex(response.reportId),
      featureIndex: hex(response.featureIndex),
      functionId: hex(response.functionId),
      params: bytesToHex(response.parameters),
      raw: response.hex,
    });
  }, "sending raw feature call");
}

async function rawReport() {
  await withDriver(async (driver) => {
    const reportId = Number.parseInt($("#rawReportId").value, 16);
    const payload = parseHexBytes($("#rawReportPayload").value);
    const response = await driver.rawReport(reportId, payload, { waitForAny: $("#waitRaw").checked });
    log("raw report sent", {
      reportId: hex(reportId),
      payload: bytesToHex(payload),
      response: response?.hex,
    });
  }, "sending raw report");
}

async function setReportRate() {
  await withOnboardMutation(async (driver) => {
    await driver.setReportRateMs(Number($("#reportRateMs").value));
    const current = await driver.getReportRate();
    renderReportRateControls(current.ms);
    $("#reportRateState").textContent = JSON.stringify({ current }, null, 2);
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

async function parseCaptureFile() {
  const file = $("#pcapFile").files?.[0];
  if (!file) {
    setStatus("pcap file を選択してください", "warn");
    return;
  }
  try {
    setStatus("parsing pcap", "busy");
    const parsed = parsePcap(await file.arrayBuffer());
    state.pcapFrames = summarizeFrames(parsed.frames).filter((frame) => frame.direction === "out");
    state.selectedReplayFrames = [];
    renderPcapFrames(state.pcapFrames);
    log("pcap parsed", {
      linkType: parsed.linkType,
      packets: parsed.packets.length,
      hidppFrames: parsed.frames.length,
      outgoingUniqueFrames: state.pcapFrames.length,
    });
    setStatus("pcap parsed", "ok");
  } catch (error) {
    setStatus(error.message, "error");
    log("pcap parse failed", { message: error.message });
  }
}

function renderPcapFrames(frames) {
  const tbody = $("#pcapFrames tbody");
  tbody.replaceChildren(
    ...frames.slice(0, 250).map((frame, index) => {
      const tr = document.createElement("tr");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selectedReplayFrames.push(frame);
        else state.selectedReplayFrames = state.selectedReplayFrames.filter((item) => item !== frame);
      });
      const cells = [
        checkbox,
        String(index + 1),
        `${frame.direction} x${frame.count}`,
        hex(frame.reportId),
        hex(frame.deviceIndex),
        hex(frame.featureIndex),
        hex(frame.functionId),
        frame.paramsHex,
      ];
      for (const cell of cells) {
        const td = document.createElement("td");
        if (cell instanceof Node) td.append(cell);
        else td.textContent = cell;
        tr.append(td);
      }
      return tr;
    }),
  );
}

async function replaySelectedFrames() {
  await withDriver(async (driver) => {
    if (!state.selectedReplayFrames.length) throw new Error("再送するフレームを選択してください");
    for (const frame of state.selectedReplayFrames) {
      const payload = Array.from(frame.raw.slice(1));
      const response = await driver.rawReport(frame.reportId, payload, { waitForAny: $("#replayWait").checked });
      log("replayed frame", { frame: frame.hex, response: response?.hex });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }, "replaying captured HID++ frames");
}

async function applyCapturedHits() {
  await withOnboardMutation(async (driver) => {
    const frames = [];
    for (const sideIndex of hitsSideIndexesForTarget()) {
      const payload = buildCapturedHitsPayload(sideIndex);
      const response = await driver.rawReport(REPORT.LONG, payload, { waitForAny: true, timeoutMs: 1500 });
      frames.push({
        sideIndex,
        report: `11 ${bytesToHex(payload)}`,
        response: response?.hex,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    log("captured HITS applied", { settings: buildHitsSettingsPatch(), frames });
  }, "applying captured HITS frame");
}

async function armWriteAndRun() {
  await withOnboardMutation(async (driver) => {
    const arm = $("#writeArm").value.trim();
    if (arm !== "WRITE ONBOARD") {
      throw new Error('書き込みには "WRITE ONBOARD" と入力してください');
    }
    const page = Number($("#writePage").value);
    const offset = Number($("#writeOffset").value);
    const data = parseHexBytes($("#writeBytes").value);
    await driver.writeOnboardBytes(page, offset, data, { dangerouslyAllowWrite: true });
    log("write completed", { page, offset, bytes: bytesToHex(data) });
  }, "writing on-board memory");
}

$("#connect").addEventListener("click", connect);
$("#refresh").addEventListener("click", () => withDriver(refreshAll, "refreshing"));
$("#setMode").addEventListener("click", () =>
  withDriver((driver) => driver.setOnboardMode(Number($("#mode").value)), "setting mode"),
);
$("#setDpiIndex").addEventListener("click", () =>
  withOnboardMutation((driver) => driver.setCurrentDpiIndex(Number($("#dpiIndex").value)), "setting DPI index"),
);
$("#setCurrentProfile").addEventListener("click", () =>
  withOnboardMutation(
    (driver) => driver.setCurrentProfile(ONBOARD_MEMORY_TYPE.WRITEABLE, Number($("#profileIndex").value)),
    "setting current profile",
  ),
);
$("#readSector").addEventListener("click", readSector);
$("#setSensorDpi").addEventListener("click", setSensorDpi);
$("#setReportRate").addEventListener("click", setReportRate);
$("#rawCall").addEventListener("click", rawFeatureCall);
$("#rawReport").addEventListener("click", rawReport);
$("#parsePcap").addEventListener("click", parseCaptureFile);
$("#replayFrames").addEventListener("click", replaySelectedFrames);
$("#applyCapturedHits").addEventListener("click", applyCapturedHits);
$("#writeRun").addEventListener("click", armWriteAndRun);
for (const selector of ["#hitsTarget", "#hitsActuation", "#hitsRapidEnabled", "#hitsRapid", "#hitsHaptics"]) {
  $(selector).addEventListener("input", renderHitsModel);
  $(selector).addEventListener("change", renderHitsModel);
}
$("#sensorDpi").addEventListener("input", () => {
  $("#sensorDpiValue").value = $("#sensorDpi").value;
});
$("#dpiPreset").addEventListener("change", () => {
  if ($("#dpiPreset").value) {
    $("#sensorDpi").value = $("#dpiPreset").value;
    $("#sensorDpiValue").value = $("#dpiPreset").value;
  }
});
$("#dpiSensorIndex").addEventListener("change", renderDpiControls);
$("#reportRateMs").addEventListener("change", () => renderReportRateControls(Number($("#reportRateMs").value)));
$("#reportRateSlider").addEventListener("input", () => {
  const rate = state.reportRates[Number($("#reportRateSlider").value)];
  if (!rate) return;
  $("#reportRateMs").value = String(rate.ms);
  $("#reportRateValue").value = `${rate.hz} Hz`;
});

if (!("hid" in navigator)) {
  setStatus("WebHID 非対応ブラウザです。Chrome/Edge/Vivaldi の localhost で開いてください。", "error");
} else {
  setStatus("ready");
}
renderHitsModel();
