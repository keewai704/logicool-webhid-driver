import { REPORT, bytesToHex, hex } from "./logitech-hidpp.js";

const PCAP_MAGIC = new Map([
  [0xa1b2c3d4, { littleEndian: false, ns: false }],
  [0xd4c3b2a1, { littleEndian: true, ns: false }],
  [0xa1b23c4d, { littleEndian: false, ns: true }],
  [0x4d3cb2a1, { littleEndian: true, ns: true }],
]);

const REPORT_SIZE = Object.freeze({
  [REPORT.SHORT]: 7,
  [REPORT.LONG]: 20,
  [REPORT.VERY_LONG]: 64,
});

function readMagic(view) {
  return (
    (view.getUint8(0) << 24) |
    (view.getUint8(1) << 16) |
    (view.getUint8(2) << 8) |
    view.getUint8(3)
  ) >>> 0;
}

function parseUsbpcapHeader(bytes) {
  if (bytes.length < 27) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint16(0, true);
  if (headerLen < 27 || headerLen > bytes.length) return null;
  return {
    headerLen,
    status: view.getUint32(10, true),
    function: view.getUint16(14, true),
    info: view.getUint8(16),
    bus: view.getUint16(17, true),
    device: view.getUint16(19, true),
    endpoint: view.getUint8(21),
    transfer: view.getUint8(22),
    dataLength: view.getUint32(23, true),
  };
}

function hidppFrameAt(bytes, offset) {
  const reportId = bytes[offset];
  const size = REPORT_SIZE[reportId];
  if (!size || offset + size > bytes.length) return null;
  const frame = bytes.slice(offset, offset + size);
  const deviceIndex = frame[1];
  const featureIndex = frame[2];
  const address = frame[3];
  if (![0x00, 0x01, 0xff].includes(deviceIndex) && deviceIndex > 0x0f) return null;
  if (featureIndex === 0x00 && address === 0x00 && frame.slice(4).every((value) => value === 0)) return null;
  return {
    reportId,
    deviceIndex,
    featureIndex,
    functionId: (address >> 4) & 0x0f,
    softwareId: address & 0x0f,
    parameters: frame.slice(4),
    raw: frame,
    offset,
  };
}

function findHidppFrames(payload) {
  const frames = [];
  for (let offset = 0; offset < payload.length; offset += 1) {
    const frame = hidppFrameAt(payload, offset);
    if (frame) {
      frames.push(frame);
      offset += REPORT_SIZE[frame.reportId] - 1;
    }
  }
  return frames;
}

function hidPayloadsForPacket(payload, header) {
  if (!header || payload.length < 8) return [{ payload, baseOffset: 0 }];

  const requestType = payload[0];
  const request = payload[1];
  const reportId = payload[2];
  const reportType = payload[3];
  const length = payload[6] | (payload[7] << 8);
  const isHidClassRequest = (requestType & 0x60) === 0x20;
  const isSetReport = request === 0x09 && reportType === 0x02;
  const isKnownReport = REPORT_SIZE[reportId] && length >= REPORT_SIZE[reportId];

  if (header.transfer === 2 && isHidClassRequest && isSetReport && isKnownReport && payload.length >= 8 + length) {
    return [{ payload: payload.slice(8, 8 + length), baseOffset: 8 }];
  }

  return [{ payload, baseOffset: 0 }];
}

function parsePcap(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 24) throw new Error("PCAP is too short");
  const magic = readMagic(view);
  const format = PCAP_MAGIC.get(magic);
  if (magic === 0x0a0d0d0a) {
    throw new Error("PCAPNG is not supported yet. Use USBPcapCMD classic .pcap output.");
  }
  if (!format) throw new Error(`Unsupported PCAP magic ${hex(magic, 8)}`);
  const little = format.littleEndian;
  const linkType = view.getUint32(20, little);
  const packets = [];
  let offset = 24;
  let index = 0;

  while (offset + 16 <= view.byteLength) {
    const seconds = view.getUint32(offset, little);
    const fraction = view.getUint32(offset + 4, little);
    const includedLength = view.getUint32(offset + 8, little);
    const originalLength = view.getUint32(offset + 12, little);
    offset += 16;
    if (offset + includedLength > view.byteLength) break;
    const bytes = new Uint8Array(arrayBuffer, offset, includedLength);
    const header = linkType === 249 ? parseUsbpcapHeader(bytes) : null;
    const payload = header ? bytes.slice(header.headerLen) : bytes;
    const hidppFrames = hidPayloadsForPacket(payload, header).flatMap((candidate) =>
      findHidppFrames(candidate.payload).map((frame) => ({
        ...frame,
        offset: frame.offset + candidate.baseOffset,
      })),
    );
    packets.push({
      index,
      time: seconds + fraction / (format.ns ? 1_000_000_000 : 1_000_000),
      includedLength,
      originalLength,
      linkType,
      usbpcap: header,
      payload,
      hidppFrames,
    });
    offset += includedLength;
    index += 1;
  }

  return {
    linkType,
    packets,
    frames: packets.flatMap((packet) =>
      packet.hidppFrames.map((frame) => ({
        packetIndex: packet.index,
        time: packet.time,
        direction: ((packet.usbpcap?.endpoint ?? 0) & 0x80) ? "in" : "out",
        bus: packet.usbpcap?.bus,
        device: packet.usbpcap?.device,
        endpoint: packet.usbpcap?.endpoint,
        transfer: packet.usbpcap?.transfer,
        ...frame,
        hex: bytesToHex(frame.raw),
        paramsHex: bytesToHex(frame.parameters),
      })),
    ),
  };
}

function summarizeFrames(frames) {
  const seen = new Map();
  for (const frame of frames) {
    const key = [
      frame.direction,
      frame.reportId,
      frame.deviceIndex,
      frame.featureIndex,
      frame.functionId,
      frame.paramsHex,
    ].join("|");
    if (!seen.has(key)) {
      seen.set(key, { ...frame, count: 0 });
    }
    seen.get(key).count += 1;
  }
  return [...seen.values()];
}

export { parsePcap, summarizeFrames };
