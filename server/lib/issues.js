// Error codes: every red or amber state gets a code, what it means, the
// likely causes (most likely first) and what to check.
//
// Codes are Estate Monitor's own, so one code means the same thing whichever
// vendor reported it. Each issue also keeps the vendor's raw value (e.g. the
// Webex errorCode "cameraNotDetected" or Logitech Sync "Offline") so it can be
// looked up with the vendor.

export const ERROR_CODES = {
  'EM-NET-001': {
    title: 'Device offline',
    area: 'Network and power',
    meaning: 'The vendor cloud has lost contact with the device. It is switched off, cannot reach the internet, or cannot reach the vendor\'s service.',
    causes: [
      'Power lost: unplugged, power strip switched off, or PoE switch port not supplying power',
      'Network cable unplugged or faulty, or the switch port is down or disabled',
      'Network change: wrong VLAN, no DHCP address, or a changed IP reservation',
      'Firewall or proxy now blocks the vendor\'s cloud addresses',
      'Device is rebooting or installing an update (clears by itself within about 15 minutes)',
    ],
    checks: [
      'Look at the device\'s power or status light',
      'Check the LAN cable and the switch port link light (see the room schematic for the port)',
      'Ping the device\'s IP address from the same network',
      'Check the firewall allows the vendor\'s cloud domains',
      'Power-cycle the device if it does not come back in 15 minutes',
    ],
  },
  'EM-NET-002': {
    title: 'Offline for a long time',
    area: 'Network and power',
    meaning: 'The device has been offline long enough that the vendor treats its registration as expired.',
    causes: [
      'Device removed, moved or put in storage without being deleted from the portal',
      'Long-term power or network outage in the room',
      'Device was factory reset and not re-registered',
    ],
    checks: [
      'Confirm the device is still in the room',
      'If it has moved, update or remove it in the vendor portal',
      'If it was reset, re-register it with a new activation code',
    ],
  },
  'EM-NET-003': {
    title: 'Not answering on the network',
    area: 'Network and power',
    meaning: 'A network monitor (such as Domotz) can no longer reach the device on the local network, although the monitor itself is online.',
    causes: [
      'Device switched off or lost power (check the PoE port or PDU outlet)',
      'Network cable unplugged, or the switch port is down',
      'The device\'s IP address changed (DHCP) and the monitor still looks at the old one',
      'Device has hung and stopped answering',
    ],
    checks: [
      'Check the device\'s power and link lights',
      'Look up its MAC address on the switch to find the port and its current IP',
      'Power-cycle the port or outlet from the monitor (device panel, Remote actions)',
    ],
  },
  'EM-PWR-001': {
    title: 'Device asleep (power saving)',
    area: 'Network and power',
    meaning: 'The device is in deep sleep or a power-saving mode and is not reporting.',
    causes: ['A scheduled power-saving or deep-sleep policy', 'Display or room power switched off out of hours'],
    checks: ['Check the device\'s standby and power-saving schedule', 'Wake it, or wait for the schedule to bring it back'],
  },
  'EM-PER-001': {
    title: 'Camera not detected',
    area: 'Peripherals',
    meaning: 'The main device cannot see its camera.',
    causes: [
      'Camera cable (USB, HDMI or network) loose or unplugged at either end',
      'Camera has no power, or its PoE port is not powering it',
      'Faulty cable or USB/HDBaseT extender on the camera run',
      'Camera plugged into the wrong port on the codec, hub or PC',
      'Camera firmware does not match the main unit after an update',
    ],
    checks: [
      'Reseat the camera cable at both ends (see the room schematic for the run)',
      'Check the camera\'s power light',
      'Try a known-good cable or bypass the extender',
      'Reboot the main unit so it re-detects peripherals',
    ],
  },
  'EM-PER-002': {
    title: 'Microphone not detected',
    area: 'Peripherals',
    meaning: 'A microphone (table mic, mic pod or ceiling mic) is not connected.',
    causes: ['Mic cable unplugged or damaged (often under the table)', 'Mic pod hub not powered or not connected', 'Ceiling mic\'s PoE port is down', 'Mic daisy chain broken at one pod'],
    checks: ['Follow the mic cable from the table to the hub', 'Check the hub and switch port lights', 'Swap in a known-good mic cable'],
  },
  'EM-PER-003': {
    title: 'Speaker not detected',
    area: 'Peripherals',
    meaning: 'The room\'s speaker is not connected or not responding.',
    causes: ['Speaker cable unplugged', 'Amplifier off or its input not connected', 'Speaker set to a different output in the room software'],
    checks: ['Check the speaker or amplifier cable and power', 'Check the audio output setting on the device'],
  },
  'EM-PER-004': {
    title: 'Display or HDMI output not detected',
    area: 'Peripherals',
    meaning: 'The device cannot see a screen on its video output.',
    causes: [
      'HDMI cable loose or faulty, or over its maximum length',
      'Display switched off, or on the wrong input',
      'HDMI extender, switcher or splitter on the run has lost power',
      'EDID or HDCP handshake failure after the display changed',
    ],
    checks: [
      'Check the display is on and set to the right input',
      'Reseat the HDMI cable at both ends (see the room schematic for the port)',
      'Power-cycle any extender or switcher on the run',
      'Try a short, known-good HDMI cable directly',
    ],
  },
  'EM-PER-005': {
    title: 'Hub not detected',
    area: 'Peripherals',
    meaning: 'A table hub or display hub in the system is not connected.',
    causes: ['Hub-to-hub network cable unplugged or damaged', 'Hub has no power', 'Cable run is too long or passes through an unsupported switch'],
    checks: ['Check the hub power light', 'Reseat the hub link cable at both ends', 'Run the hub link directly, not through a switch'],
  },
  'EM-PER-006': {
    title: 'Peripheral missing',
    area: 'Peripherals',
    meaning: 'A peripheral the device expects is not connected. The vendor did not say which one.',
    causes: ['A cable unplugged by a user (often USB or HDMI at the table)', 'A peripheral with no power', 'A peripheral replaced with a different model'],
    checks: ['Compare the room with its schematic to find what is missing', 'Check the device\'s peripheral list in the vendor portal'],
  },
  'EM-ENV-001': {
    title: 'Temperature too high',
    area: 'Environment',
    meaning: 'The device is running hotter than its safe range.',
    causes: ['Vents blocked or the device is in a closed cabinet', 'Fan failing or clogged with dust', 'Room or rack is too warm'],
    checks: ['Clear space around the vents', 'Check the cabinet or rack has airflow', 'Clean the vents; replace the unit if the fan is noisy or stopped'],
  },
  'EM-FW-001': {
    title: 'Firmware behind',
    area: 'Software',
    meaning: 'The device runs older firmware than the approved baseline (or than the newest version seen in the estate for this model).',
    causes: ['Automatic updates are switched off', 'The last update failed or was rolled back', 'The device was offline during its update window', 'The update channel is pinned to an older release'],
    checks: ['Check the update policy and channel in the vendor portal', 'Look for a failed update in the device\'s history', 'Schedule the update in the next maintenance window'],
  },
  'EM-SW-001': {
    title: 'Room software reports a problem',
    area: 'Software',
    meaning: 'The meeting-room software (for example Teams Rooms) reports an urgent problem.',
    causes: ['The room\'s resource account cannot sign in (password changed or expired, or MFA or conditional access blocking it)', 'A required peripheral is missing', 'The room app needs an update or has crashed'],
    checks: ['Check the room account can sign in', 'Check the peripherals list in the admin portal', 'Restart the room app or device'],
  },
  'EM-SW-002': {
    title: 'Room software reports a non-urgent issue',
    area: 'Software',
    meaning: 'The meeting-room software reports something that needs attention but the room still works.',
    causes: ['A software or firmware update is waiting', 'A non-critical peripheral (such as a sensor or controller) is missing', 'A configuration setting is out of policy'],
    checks: ['Review the issue in the platform\'s admin portal', 'Apply pending updates in the next maintenance window'],
  },
  'EM-REG-001': {
    title: 'Activation pending',
    area: 'Registration',
    meaning: 'The device is still activating or waiting for activation in the platform.',
    causes: ['Activation code not entered yet, or expired', 'The device cannot reach the activation service', 'The workspace or licence has not been assigned'],
    checks: ['Generate a new activation code', 'Check the workspace and licence in the admin portal'],
  },
  'EM-GEN-001': {
    title: 'Vendor reports an error',
    area: 'General',
    meaning: 'The vendor reports an error without saying what it is.',
    causes: ['A peripheral or hardware fault', 'A software fault on the device'],
    checks: ['Open the device in the vendor portal for the detailed error', 'Reboot the device'],
  },
  'EM-GEN-002': {
    title: 'Vendor reports a warning',
    area: 'General',
    meaning: 'The vendor reports a warning without saying what it is.',
    causes: ['A peripheral, configuration or software condition the vendor flags'],
    checks: ['Open the device in the vendor portal for the detail'],
  },
  'EM-GEN-003': {
    title: 'Status unknown',
    area: 'General',
    meaning: 'The vendor does not know the device\'s state.',
    causes: ['The device has just been added', 'The vendor service is having problems'],
    checks: ['Wait for the next sync', 'Check the API tracker for the vendor\'s API'],
  },
};

/** Map a vendor's free-text or code value for a fault to an Estate Monitor code. */
export function classifyFault(raw, fallback = 'EM-GEN-001') {
  const t = String(raw || '').toLowerCase();
  if (/temp|therm|overheat/.test(t)) return 'EM-ENV-001';
  if (/hub/.test(t)) return 'EM-PER-005';
  if (/camera|cam\b|video in/.test(t)) return 'EM-PER-001';
  if (/display|hdmi|monitor|screen|tv\b/.test(t)) return 'EM-PER-004';
  if (/mic/.test(t)) return 'EM-PER-002';
  if (/speaker|audio out/.test(t)) return 'EM-PER-003';
  if (/peripheral/.test(t)) return 'EM-PER-006';
  if (/sign.?in|account|password|credential/.test(t)) return 'EM-SW-001';
  if (/update|firmware|software/.test(t)) return 'EM-SW-002';
  return fallback;
}

export const issue = (code, source, raw = null) => ({ code, source, raw });

/** Add the code's meaning, causes and checks. */
export function explain(i) {
  const e = ERROR_CODES[i.code] || ERROR_CODES['EM-GEN-001'];
  return { ...i, ...e };
}
