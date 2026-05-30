# Logicool HID++ WebHID Driver

This is a browser-side HID++ 2.0 driver scaffold for Logicool/Logitech gaming devices, aimed at the PRO X2 SUPERSTRIKE over the C54D LIGHTSPEED receiver.

## What works

- Connects through WebHID to Logitech VID `0x046d`, including PID `0xc54d`.
- Sends and receives HID++ short and long reports.
- Reads HID++ protocol version and feature table.
- Reads on-board profiles feature `0x8100` description, mode, current profile, current DPI index, and memory pages.
- Sets on-board mode, current profile, current DPI index, and sensor DPI when the device exposes the matching features.
- Reads and sets report rate through feature `0x8060` when exposed.
- Parses classic USBPcap `.pcap` captures and can replay selected outgoing HID++ frames through WebHID.
- Sends the captured PRO X2 SUPERSTRIKE HITS frames directly from the HITS panel.
- Includes a raw feature/report console for continuing the reverse engineering work.

## Guardrails

Writing profile memory can corrupt the on-board profile area. The UI requires typing `WRITE ONBOARD` before it calls `writeOnboardBytes()`. Use the read path first and keep a dump of every page you plan to modify.

The Superstrike-specific analog/HITS profile layout is not fully mapped here. G HUB was operated directly and its settings database changed like this for the active custom analog preset:

- Left/right mouse buttons are `80` and `81`.
- Actuation slider writes `analogPreset.actuationPointValues["80"|"81"]`.
- Rapid trigger value writes `analogPreset.rapidTriggerValues["80"|"81"]`.
- Rapid trigger enable is represented by membership in `analogPreset.rapidTriggerExplicitStates`.
- Click haptics writes `analogPreset.clickHapticsValues["80"|"81"]`.

USBPcap capture after reboot confirmed that the HITS long report is:

```text
11 01 0c 1b <side> <actuation*4> <rapid*4+enabledBit> <haptics*4> 00...
side: left=00, right=01
enabledBit: rapid trigger on=1, off=0
```

Concrete captures:

```text
actuation 3, rapid 1 on, haptics 1: 11 01 0c 1b 00 0c 05 04 ...
actuation 4, rapid 1 on, haptics 1: 11 01 0c 1b 00 10 05 04 ...
actuation 3, rapid 2 on, haptics 1: 11 01 0c 1b 00 0c 09 04 ...
actuation 3, rapid 1 off, haptics 1: 11 01 0c 1b 00 0c 04 04 ...
actuation 3, rapid 1 on, haptics 2: 11 01 0c 1b 00 0c 05 08 ...
```

The HITS panel now uses sliders like G HUB and sends both left/right frames through WebHID. When `On-board` is checked, every mutating operation first switches the device to on-board mode through feature `0x8100`.

Captured files are in `captures/`:

```text
superstrike-actuation-3-4-3-usbpcap4.pcap
superstrike-haptics-1-2-1-usbpcap4.pcap
superstrike-rapid-1-2-1-usbpcap4.pcap
superstrike-rapid-toggle-off-on-usbpcap4.pcap
```

## Run

From this directory:

```powershell
python -m http.server 8765
```

Open:

```text
http://localhost:8765
```

Use Chrome, Edge, or another Chromium browser with WebHID support. WebHID requires a user gesture, so the device picker opens only after pressing Connect.

## Device index

Wireless Logitech receivers usually address the paired mouse as device index `01`. If a call times out, try `ff` for direct/wired mode or inspect raw reports to discover the active index.

## Useful raw calls

The raw feature panel takes a feature ID, function ID, and parameters. Examples:

```text
Feature 0001, function 00, params:          feature count
Feature 8100, function 00, params:          on-board description
Feature 8100, function 02, params:          current on-board mode
Feature 8100, function 04, params:          current profile
Feature 8100, function 0b, params:          current DPI index
Feature 2201, function 00, params:          sensor count
```

## USB capture path

USBPcap's kernel driver must be started as Administrator. From an elevated PowerShell in this directory:

```powershell
.\tools\capture-usbpcap-all.ps1 -DurationSeconds 20
```

On Windows builds with `sudo.exe`, this wrapper requests elevation:

```powershell
.\tools\capture-usbpcap-sudo.ps1 -DurationSeconds 20
```

While it is running, change exactly one setting in G HUB, then load the non-empty `.pcap` file in the USBPcap HID++ Replay panel. The useful fields are HID report ID `0x10`/`0x11`, device index, feature index, function nibble, software ID nibble, and parameters. The in-page parser supports classic `.pcap`; save Wireshark captures as pcap, not pcapng.

If `usbpcap-interfaces-*.txt` is empty and the status file says no control devices stayed open, reboot Windows after installing USBPcap. The driver is a USB class upper filter, so already-enumerated root hubs may not expose `\\.\USBPcapN` until reboot or root-hub re-enumeration.

## References used

- Chrome WebHID documentation: https://developer.chrome.com/docs/capabilities/hid
- WICG WebHID specification: https://wicg.github.io/webhid/
- Logitech HID++ 2.0 draft specification: https://lekensteyn.nl/files/logitech/logitech_hidpp_2.0_specification_draft_2012-06-04.pdf
- libratbag HID++ 2.0 implementation: https://github.com/libratbag/libratbag
- cvuchener/hidpp protocol tools: https://github.com/cvuchener/hidpp
