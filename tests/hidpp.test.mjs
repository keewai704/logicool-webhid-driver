import assert from "node:assert/strict";
import {
  FEATURE,
  Hidpp20Transport,
  LogitechHidpp20Driver,
  bytesToHex,
} from "../src/logitech-hidpp.js";
import { parsePcap, summarizeFrames } from "../src/pcap-hidpp.js";

class FakeHidDevice extends EventTarget {
  constructor() {
    super();
    this.opened = false;
    this.sent = [];
  }

  async open() {
    this.opened = true;
  }

  async close() {
    this.opened = false;
  }

  async sendReport(reportId, payload) {
    this.sent.push([reportId, Array.from(payload)]);
    const deviceIndex = payload[0];
    const featureIndex = payload[1];
    const address = payload[2];
    const fn = address >> 4;
    const params = payload.slice(3);
    let responseParams = [];

    if (featureIndex === 0 && fn === 1) responseParams = [2, 0, 0];
    if (featureIndex === 0 && fn === 0 && params[0] === 0x00 && params[1] === 0x01) {
      responseParams = [7, 0, 0];
    }

    const reportLength = reportId === 0x10 ? 6 : 19;
    const response = new Uint8Array(reportLength);
    response[0] = deviceIndex;
    response[1] = featureIndex;
    response[2] = address;
    response.set(responseParams, 3);

    queueMicrotask(() => {
      const event = new Event("inputreport");
      Object.defineProperties(event, {
        reportId: { value: reportId },
        data: { value: new DataView(response.buffer) },
      });
      this.dispatchEvent(event);
    });
  }
}

const fake = new FakeHidDevice();
const transport = new Hidpp20Transport(fake, { deviceIndex: 1, softwareId: 8, timeoutMs: 50 });
await transport.open();
const driver = new LogitechHidpp20Driver(transport);

const version = await driver.getProtocolVersion();
assert.equal(version.major, 2);
assert.equal(version.minor, 0);
assert.equal(bytesToHex(new Uint8Array(fake.sent[0][1]).slice(0, 3)), "01 00 18");

const featureSet = await driver.getFeature(FEATURE.FEATURE_SET);
assert.equal(featureSet.index, 7);
assert.equal(fake.sent[1][0], 0x10);
assert.equal(bytesToHex(new Uint8Array(fake.sent[1][1]).slice(0, 5)), "01 00 08 00 01");

await driver.close();

function makeUsbpcapPcap(frame, setupPrefix = null) {
  const payload = setupPrefix ? new Uint8Array([...setupPrefix, ...frame]) : frame;
  const packetDataLength = 27 + payload.length;
  const buffer = new ArrayBuffer(24 + 16 + packetDataLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes.set([0xd4, 0xc3, 0xb2, 0xa1], 0);
  view.setUint16(4, 2, true);
  view.setUint16(6, 4, true);
  view.setUint32(16, 65535, true);
  view.setUint32(20, 249, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, packetDataLength, true);
  view.setUint32(36, packetDataLength, true);
  const start = 40;
  view.setUint16(start, 27, true);
  view.setUint32(start + 10, 0, true);
  view.setUint16(start + 14, 0x0009, true);
  view.setUint8(start + 16, 0);
  view.setUint16(start + 17, 1, true);
  view.setUint16(start + 19, 3, true);
  view.setUint8(start + 21, 0x02);
  view.setUint8(start + 22, setupPrefix ? 2 : 3);
  view.setUint32(start + 23, payload.length, true);
  bytes.set(payload, start + 27);
  return buffer;
}

const parsed = parsePcap(makeUsbpcapPcap(new Uint8Array([0x10, 0x01, 0x07, 0x08, 0x00, 0x01, 0x00])));
assert.equal(parsed.linkType, 249);
assert.equal(parsed.frames.length, 1);
assert.equal(parsed.frames[0].direction, "out");
assert.equal(bytesToHex(parsed.frames[0].raw), "10 01 07 08 00 01 00");
assert.equal(summarizeFrames(parsed.frames)[0].count, 1);

const report = new Uint8Array([
  0x11, 0x01, 0x0c, 0x1b, 0x00, 0x0c, 0x05, 0x08, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const controlSetup = new Uint8Array([0x21, 0x09, 0x11, 0x02, 0x02, 0x00, 0x14, 0x00]);
const controlParsed = parsePcap(makeUsbpcapPcap(report, controlSetup));
assert.equal(controlParsed.frames.length, 1);
assert.equal(controlParsed.frames[0].offset, 8);
assert.equal(bytesToHex(controlParsed.frames[0].raw), bytesToHex(report));

console.log("ok");
