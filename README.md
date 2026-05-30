# Logicool G HUB On-board Controller

Browser-side HID++ 2.0 controller for Logicool/Logitech gaming devices, aimed at the PRO X2 SUPERSTRIKE over the C54D LIGHTSPEED receiver.

## What works

- Connects through WebHID to Logitech VID `0x046d`, including PID `0xc54d`.
- Switches the device to on-board memory mode automatically after connect and before every mutating operation.
- Uses writable on-board profile slot `0` as the initial profile, then lets the UI select another writable slot when the device reports more profiles.
- Exposes the currently mapped on-board settings: profile slot, active DPI slot, sensor DPI, report rate, and PRO X2 SUPERSTRIKE HITS actuation/rapid/haptics.
- Keeps a visible log panel for connection, writes, responses, and errors.
- Keeps the USBPcap parser and capture tools in the repo for future reverse engineering, but the main UI no longer shows raw HID++ consoles or replay tables.

## Guardrails

Every write path calls on-board mode first through feature `0x8100`, then selects the writable profile slot before sending the setting write. The raw memory writer was removed from the UI because the mapped controls now cover the settings this app can safely write.

The Superstrike-specific analog/HITS profile layout is based on G HUB captures for the active custom analog preset:

- Left/right mouse buttons are `80` and `81`.
- Actuation writes `analogPreset.actuationPointValues["80"|"81"]`.
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

## Capture Tools

USBPcap's kernel driver must be started as Administrator. From an elevated PowerShell in this directory:

```powershell
.\tools\capture-usbpcap-all.ps1 -DurationSeconds 20
```

On Windows builds with `sudo.exe`, this wrapper requests elevation:

```powershell
.\tools\capture-usbpcap-sudo.ps1 -DurationSeconds 20
```

The parser supports classic `.pcap`; save Wireshark captures as pcap, not pcapng.

## References used

- Chrome WebHID documentation: https://developer.chrome.com/docs/capabilities/hid
- WICG WebHID specification: https://wicg.github.io/webhid/
- Logitech HID++ 2.0 draft specification: https://lekensteyn.nl/files/logitech/logitech_hidpp_2.0_specification_draft_2012-06-04.pdf
- libratbag HID++ 2.0 implementation: https://github.com/libratbag/libratbag
- cvuchener/hidpp protocol tools: https://github.com/cvuchener/hidpp
