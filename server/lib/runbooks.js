// Field instructions ("runbooks") for actions no vendor API can carry out.
// The text is written for a local site contact (SPOC) who is not an AV
// engineer: plain steps, what to look for, and what to report back.
// Steps are deliberately generic per device type; nothing here asks for a
// factory reset or a firmware change on site.

// Where the power usually comes from, per device type.
const POWER = {
  'Video bar': 'the power adapter cable at the back of the bar (some bars are powered over the network cable instead)',
  'Video system': 'the power cable at the back of the codec or compute unit, usually under the table or behind the display',
  'Touch controller': 'the network cable at the back of the touch panel or its table mount (touch panels are usually powered over that cable, PoE)',
  Camera: 'the camera\'s power adapter, or the cable from the camera to the codec or USB hub',
  'Whiteboard camera': 'the network cable or power adapter on the camera above the whiteboard',
  'Conference phone': 'the network cable at the back of the phone (most conference phones are powered over that cable, PoE)',
  'Desk phone': 'the network cable at the back of the phone',
  Display: 'the power switch or power cable of the screen (not the room\'s main circuit breaker)',
  'Room PC': 'the power button on the room PC or compute unit (hold it until the unit turns off), then its power cable',
  Microphone: 'the network cable to the microphone (ceiling and table mics are usually powered over that cable, PoE)',
  'Audio DSP': 'the power switch or power cable at the back of the audio processor in the rack',
  'Control processor': 'the power cable at the back of the control processor in the rack or under the table',
  'AV switcher': 'the power cable at the back of the switcher, encoder or decoder',
  'Signage player': 'the power adapter of the media player behind the screen',
  'Room sensor': 'the USB or network cable of the sensor',
  'Network switch': 'the switch\'s power cable (warning: every device on that switch restarts too)',
};
const DEFAULT_POWER = 'the device\'s power adapter or its network cable if it has no separate power';

const name = (d) => (String(d.model || '').toLowerCase().startsWith(String(d.make || '').toLowerCase()) ? d.model : `${d.make} ${d.model}`);

const identify = (d) => [
  `${name(d)} (${d.deviceType})`,
  `Room: ${d.room}, ${d.site}`,
  d.serial ? `Serial number: ${d.serial}` : null,
  d.mac ? `MAC address: ${d.mac}` : null,
  d.assetTag ? `Asset tag: ${d.assetTag}` : null,
  d.lastSeen ? `Last seen online: ${new Date(d.lastSeen).toUTCString()}` : null,
  d.healthReason ? `What the monitoring shows: ${d.healthReason}` : null,
].filter(Boolean);

/** Power-cycle steps for one device. */
export function powerCycleSteps(d) {
  const where = POWER[d.deviceType] || DEFAULT_POWER;
  const steps = [
    `Find the ${d.deviceType.toLowerCase()} in ${d.room}. Check the label or serial number matches the one above.`,
    'Make sure the room is not in use. If a meeting is running, wait until it ends.',
    'Note what you see before you touch anything: lights on the device (colour, blinking or steady), and any message on the room screen or touch panel.',
    `Disconnect ${where}.`,
    'Wait 30 seconds.',
    'Reconnect it firmly until it clicks or seats fully.',
    'Wait up to 5 minutes while it starts up. Lights may blink during this time.',
    'Check the room works: the touch panel shows the normal home screen and the room screen shows the meeting app.',
  ];
  if (d.deviceType === 'Network switch') steps.splice(1, 0, 'Tell people nearby first: every device on this switch goes offline for a few minutes.');
  return steps;
}

/** Inspection steps for a device that keeps dropping off. */
export function inspectSteps(d) {
  const where = POWER[d.deviceType] || DEFAULT_POWER;
  return [
    `Find the ${d.deviceType.toLowerCase()} in ${d.room}. Check the label or serial number matches the one above.`,
    'Check every cable on the device is pushed in fully: power, network and any USB or HDMI cable. Re-seat any that are loose.',
    `Follow ${where} back to the wall, floor box or network switch. Look for damage, tight bends, or a cable that moves when the table or chairs move.`,
    'Check the device is not hot to the touch, covered, or in direct sun, and that its air vents are clear.',
    'Check whether it is plugged into a power strip that is switched off at night, or a socket shared with cleaning equipment.',
    'Take a photo of the device and of its cable connections.',
    'If anything was loose or damaged, fix or replace the cable if you can, and say what you did in your reply.',
  ];
}

const REPORT = [
  'Reply to this email with:',
  '- whether the device came back (yes or no),',
  '- what the lights or screen showed before and after,',
  '- anything you noticed (loose cable, damage, the device was unplugged...).',
  'Please do not factory-reset the device or change its settings. If it does not come back, just tell us and we will take it from there.',
];

/** Field-dispatch email for a group of devices at one site. */
export function dispatchEmail({ kind, customerName, site, devices, contact, from = process.env.DISPATCH_SIGNATURE || 'The IT support team', ref }) {
  const verb = kind === 'inspect' ? 'check' : 'restart';
  const title = kind === 'inspect'
    ? `Please check ${devices.length === 1 ? 'a meeting room device' : `${devices.length} meeting room devices`} at ${site}`
    : `Please restart ${devices.length === 1 ? 'a meeting room device' : `${devices.length} meeting room devices`} at ${site}`;
  const steps = kind === 'inspect' ? inspectSteps : powerCycleSteps;
  const lines = [
    `Hello${contact?.name ? ` ${contact.name}` : ''},`,
    '',
    kind === 'inspect'
      ? `Our monitoring shows ${devices.length === 1 ? 'a device' : 'these devices'} at ${site} keep${devices.length === 1 ? 's' : ''} dropping off the network. Could you ${verb} ${devices.length === 1 ? 'it' : 'them'} when you have a moment? It takes about 10 minutes per device.`
      : `Our monitoring shows ${devices.length === 1 ? 'a device' : 'these devices'} at ${site} ${devices.length === 1 ? 'is' : 'are'} not working, and we can't restart ${devices.length === 1 ? 'it' : 'them'} remotely. Could you ${verb} ${devices.length === 1 ? 'it' : 'them'} on site? It takes about 5 minutes per device.`,
    '',
  ];
  devices.forEach((d, i) => {
    lines.push(`DEVICE ${i + 1} OF ${devices.length}`, ...identify(d).map((x) => `  ${x}`), '', '  Steps:');
    steps(d).forEach((s, j) => lines.push(`  ${j + 1}. ${s}`));
    lines.push('');
  });
  lines.push(...REPORT, '', 'Thank you,', from, '', `Reference: ${ref} (${customerName})`);
  return { subject: `${title} [${ref}]`, body: lines.join('\n') };
}

/** Where each vendor's firmware is updated, for engineer task emails. */
const PORTAL = {
  'poly-lens': 'Poly Lens (lens.poly.com) › Devices › select the devices › Software update',
  'logitech-sync': 'Logitech Sync Portal › Devices › select the devices › Update',
  'webex-control-hub': 'Control Hub › Devices › Software (choose the release channel), or select the devices and schedule an update',
  'zoom-rooms': 'Zoom admin portal › Room Management › Zoom Rooms › the room › Upgrade',
  'teams-rooms': 'Teams admin center › Teams devices › select the devices › Update, or the Teams Rooms Pro portal',
  'google-meet-hardware': 'Google Admin console › Devices › Google Meet hardware (updates follow the release channel)',
  'yealink-ymcs': 'YMCS › Device Management › select the devices › Update firmware',
  'neat-pulse': 'Neat Pulse › Devices › select the devices › Update',
  'crestron-xio': 'XiO Cloud › Devices › select the devices › Firmware upgrade',
  'qsys-reflect': 'Q-SYS Reflect or Q-SYS Designer › the Core › Update',
  'brightsign-bsn': 'BSN.cloud › Players › select the players › Update firmware',
  'sony-bravia': 'Sony BRAVIA management tool › select the displays › Software update',
  domotz: 'the manufacturer\'s own portal (Domotz monitors the device but does not update it)',
};

/** Task email for an engineer: firmware updates done in the vendor portal. */
export function firmwareEmail({ customerName, groups, ref }) {
  const lines = ['Hello,', '', `The daily estate check found devices for ${customerName} running firmware below the customer's approved baseline. Please update them in the vendor portal during the agreed maintenance window.`, ''];
  for (const g of groups) {
    lines.push(`${name(g)}: ${g.devices.length} device${g.devices.length === 1 ? '' : 's'} to update to ${g.target}`);
    lines.push(`  Where: ${PORTAL[g.oem] || 'the manufacturer\'s device management portal'}`);
    for (const d of g.devices.slice(0, 50)) lines.push(`  - ${d.room}, ${d.site}${d.serial ? ` (serial ${d.serial})` : ''}: now ${d.firmware}`);
    if (g.devices.length > 50) lines.push(`  ...and ${g.devices.length - 50} more (see the action in Estate Monitor).`);
    lines.push('');
  }
  lines.push('Devices restart during an update and calls in progress drop, so schedule it out of hours.', 'Reply when it is done; the next daily check confirms the new versions.', '', `Reference: ${ref}`);
  return { subject: `Firmware updates for ${customerName} [${ref}]`, body: lines.join('\n') };
}

/** Request to whoever handles renewals and replacements. */
export function lifecycleEmail({ customerName, kind, devices, ref }) {
  const warranty = kind === 'warranty';
  const lines = [
    'Hello,', '',
    warranty
      ? `The daily estate check found ${devices.length} device${devices.length === 1 ? '' : 's'} for ${customerName} whose warranty or support contract has expired or ends soon. Please arrange a renewal quote, or confirm the devices will be replaced.`
      : `The daily estate check found ${devices.length} device${devices.length === 1 ? '' : 's'} for ${customerName} past the lifecycle limit in the customer's baseline (end of sale, support or life). Please plan replacements.`,
    '',
  ];
  for (const d of devices.slice(0, 100)) {
    const when = warranty ? `warranty ${d.warrantyStatus === 'expired' ? 'ended' : 'ends'} ${d.warrantyExpires || 'unknown'}${d.contractRef ? `, contract ${d.contractRef}` : ''}` : `${d.lifecycle?.label || 'lifecycle limit reached'}${d.lifecycle?.date ? ` (${d.lifecycle.date})` : ''}`;
    lines.push(`- ${name(d)}${d.serial ? ` (serial ${d.serial})` : ''}, ${d.room}, ${d.site}: ${when}`);
  }
  if (devices.length > 100) lines.push(`...and ${devices.length - 100} more (see the action in Estate Monitor).`);
  lines.push('', `Reference: ${ref}`);
  return { subject: `${warranty ? 'Warranty renewals' : 'Device replacements'} for ${customerName} [${ref}]`, body: lines.join('\n') };
}
