// Room schematics: what is in a room and how it is cabled, port to port.
//
// {
//   nodes: [{ id, label, kind, block?, model?, deviceId?, location?, notes?, x?, y?,
//             ports?: [{ name, type, dir }] }],
//   links: [{ from, to, cable, fromPort?, toPort?, label?, length?, condition?, note? }],
//   notes?
// }
// kind:      core | controller | camera | audio | display | source | network | av | power | peripheral
// cable:     see CABLES. A port's type is one of the same values.
// dir:       in | out | io (bidirectional, e.g. LAN or USB)
// condition: ok | suspect | faulty (unset = not tested)

export const NODE_KINDS = ['core', 'controller', 'camera', 'audio', 'display', 'source', 'network', 'av', 'power', 'peripheral'];
export const CABLES = ['HDMI', 'DisplayPort', 'HDBaseT', 'USB', 'USB-C', 'Ethernet', 'PoE', 'Audio', 'Speaker', 'Fibre', 'Power', 'Wireless'];
export const PORT_DIRS = ['in', 'out', 'io'];
export const CONDITIONS = ['ok', 'suspect', 'faulty'];

const p = (name, type, dir) => ({ name, type, dir });
const many = (n, prefix, type, dir) => Array.from({ length: n }, (_, i) => p(`${prefix} ${i + 1}`, type, dir));

// Building blocks for the designer. Port names are typical for each kind of
// kit; every block's ports can be renamed, added or removed per room.
export const BLOCKS = [
  { id: 'video-bar', group: 'Video', name: 'Video bar', kind: 'core', ports: [p('HDMI out 1', 'HDMI', 'out'), p('HDMI out 2', 'HDMI', 'out'), p('HDMI in', 'HDMI', 'in'), p('USB-C host', 'USB-C', 'io'), p('USB-A', 'USB', 'io'), p('LAN', 'Ethernet', 'io'), p('Power', 'Power', 'in')] },
  { id: 'codec', group: 'Video', name: 'Video codec', kind: 'core', ports: [p('HDMI out 1', 'HDMI', 'out'), p('HDMI out 2', 'HDMI', 'out'), p('HDMI in 1', 'HDMI', 'in'), p('HDMI in 2', 'HDMI', 'in'), p('Camera in', 'USB', 'in'), p('Mic in', 'Audio', 'in'), p('Line out', 'Audio', 'out'), p('LAN', 'Ethernet', 'io'), p('Power', 'Power', 'in')] },
  { id: 'camera', group: 'Video', name: 'Camera', kind: 'camera', ports: [p('USB', 'USB', 'out'), p('HDMI out', 'HDMI', 'out'), p('LAN', 'PoE', 'io'), p('Power', 'Power', 'in')] },
  { id: 'content-camera', group: 'Video', name: 'Whiteboard camera', kind: 'camera', ports: [p('LAN', 'PoE', 'io'), p('USB', 'USB', 'out')] },
  { id: 'room-pc', group: 'Video', name: 'Room PC', kind: 'source', ports: [p('HDMI out 1', 'HDMI', 'out'), p('HDMI out 2', 'HDMI', 'out'), ...many(4, 'USB', 'USB', 'io'), p('LAN', 'Ethernet', 'io'), p('Power', 'Power', 'in')] },
  { id: 'controller', group: 'Control', name: 'Touch controller', kind: 'controller', ports: [p('LAN', 'PoE', 'io'), p('USB', 'USB', 'io')] },
  { id: 'scheduler', group: 'Control', name: 'Room scheduler', kind: 'controller', ports: [p('LAN', 'PoE', 'io')] },
  { id: 'display', group: 'Display', name: 'Display', kind: 'display', ports: [p('HDMI 1', 'HDMI', 'in'), p('HDMI 2', 'HDMI', 'in'), p('HDMI 3', 'HDMI', 'in'), p('LAN', 'Ethernet', 'io'), p('Power', 'Power', 'in')] },
  { id: 'projector', group: 'Display', name: 'Projector', kind: 'display', ports: [p('HDMI in', 'HDMI', 'in'), p('HDBaseT in', 'HDBaseT', 'in'), p('LAN', 'Ethernet', 'io'), p('Power', 'Power', 'in')] },
  { id: 'table-mic', group: 'Audio', name: 'Table microphone', kind: 'audio', ports: [p('Mic out', 'Audio', 'out')] },
  { id: 'ceiling-mic', group: 'Audio', name: 'Ceiling microphone', kind: 'audio', ports: [p('LAN', 'PoE', 'io')] },
  { id: 'speakerphone', group: 'Audio', name: 'Speakerphone', kind: 'audio', ports: [p('USB', 'USB', 'io'), p('LAN', 'PoE', 'io')] },
  { id: 'speaker', group: 'Audio', name: 'Speaker', kind: 'audio', ports: [p('Speaker in', 'Speaker', 'in')] },
  { id: 'dsp', group: 'Audio', name: 'Audio DSP', kind: 'audio', ports: [...many(4, 'Mic in', 'Audio', 'in'), p('Line out 1', 'Audio', 'out'), p('Line out 2', 'Audio', 'out'), p('USB', 'USB', 'io'), p('LAN', 'Ethernet', 'io'), p('Power', 'Power', 'in')] },
  { id: 'amplifier', group: 'Audio', name: 'Amplifier', kind: 'audio', ports: [p('Line in', 'Audio', 'in'), p('Speaker out', 'Speaker', 'out'), p('Power', 'Power', 'in')] },
  { id: 'hdmi-switch', group: 'AV signal', name: 'HDMI switcher', kind: 'av', ports: [...many(4, 'HDMI in', 'HDMI', 'in'), p('HDMI out', 'HDMI', 'out'), p('LAN', 'Ethernet', 'io'), p('Power', 'Power', 'in')] },
  { id: 'hdmi-splitter', group: 'AV signal', name: 'HDMI splitter', kind: 'av', ports: [p('HDMI in', 'HDMI', 'in'), p('HDMI out 1', 'HDMI', 'out'), p('HDMI out 2', 'HDMI', 'out'), p('Power', 'Power', 'in')] },
  { id: 'hdbt-tx', group: 'AV signal', name: 'HDBaseT transmitter', kind: 'av', ports: [p('HDMI in', 'HDMI', 'in'), p('HDBaseT out', 'HDBaseT', 'out'), p('Power', 'Power', 'in')] },
  { id: 'hdbt-rx', group: 'AV signal', name: 'HDBaseT receiver', kind: 'av', ports: [p('HDBaseT in', 'HDBaseT', 'in'), p('HDMI out', 'HDMI', 'out')] },
  { id: 'usb-extender', group: 'AV signal', name: 'USB extender', kind: 'av', ports: [p('USB host', 'USB', 'io'), p('USB device', 'USB', 'io'), p('Link', 'Ethernet', 'io')] },
  { id: 'usb-hub', group: 'AV signal', name: 'USB hub', kind: 'av', ports: [p('Upstream', 'USB', 'io'), ...many(4, 'Port', 'USB', 'io'), p('Power', 'Power', 'in')] },
  { id: 'wireless-share', group: 'AV signal', name: 'Wireless presentation', kind: 'av', ports: [p('HDMI out', 'HDMI', 'out'), p('LAN', 'Ethernet', 'io'), p('Wi-Fi', 'Wireless', 'io'), p('Power', 'Power', 'in')] },
  { id: 'table-box', group: 'Sources', name: 'Table connectivity box', kind: 'source', ports: [p('HDMI in (table)', 'HDMI', 'in'), p('USB-C in (table)', 'USB-C', 'in'), p('HDMI out', 'HDMI', 'out'), p('USB out', 'USB', 'io')] },
  { id: 'laptop', group: 'Sources', name: 'Guest laptop (BYOD)', kind: 'source', ports: [p('HDMI', 'HDMI', 'out'), p('USB-C', 'USB-C', 'io')] },
  { id: 'wall-plate', group: 'Sources', name: 'HDMI wall plate', kind: 'source', ports: [p('HDMI front', 'HDMI', 'in'), p('HDMI rear', 'HDMI', 'out')] },
  { id: 'switch', group: 'Network and power', name: 'Network switch', kind: 'network', ports: [...many(8, 'Port', 'PoE', 'io'), p('Uplink', 'Fibre', 'io')] },
  { id: 'wall-port', group: 'Network and power', name: 'Network wall port', kind: 'network', ports: [p('Port', 'Ethernet', 'io')] },
  { id: 'poe-injector', group: 'Network and power', name: 'PoE injector', kind: 'network', ports: [p('Data in', 'Ethernet', 'io'), p('PoE out', 'PoE', 'io'), p('Power', 'Power', 'in')] },
  { id: 'pdu', group: 'Network and power', name: 'Power strip / PDU', kind: 'power', ports: many(6, 'Outlet', 'Power', 'out') },
  { id: 'sensor', group: 'Other', name: 'Room sensor', kind: 'peripheral', ports: [p('LAN', 'PoE', 'io')] },
  { id: 'generic', group: 'Other', name: 'Other item', kind: 'peripheral', ports: [] },
];

const str = (v, max = 80) => (v === undefined || v === null ? undefined : String(v).slice(0, max).trim() || undefined);

/** Validate and normalise a schematic from the browser or an uploaded file. Throws on bad input. */
export function validateSchematic(input) {
  if (!input || typeof input !== 'object') throw new Error('Schematic must be an object with nodes and links');
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const links = Array.isArray(input.links) ? input.links : [];
  if (nodes.length > 80) throw new Error('A room schematic can have at most 80 items');
  if (links.length > 250) throw new Error('A room schematic can have at most 250 connections');
  const ids = new Set();
  const portsOf = new Map();
  const outNodes = nodes.map((n, i) => {
    const id = str(n.id, 40) || `n${i + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate item id "${id}"`);
    ids.add(id);
    const kind = NODE_KINDS.includes(n.kind) ? n.kind : 'peripheral';
    const node = { id, label: str(n.label) || id, kind };
    if (BLOCKS.some((b) => b.id === n.block)) node.block = n.block;
    for (const [k, max] of [['model', 80], ['deviceId', 300], ['location', 60], ['notes', 300]]) if (str(n[k], max)) node[k] = str(n[k], max);
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) { node.x = Math.max(0, Math.min(5000, Math.round(n.x))); node.y = Math.max(0, Math.min(5000, Math.round(n.y))); }
    if (Array.isArray(n.ports)) {
      if (n.ports.length > 40) throw new Error(`"${node.label}" has more than 40 ports`);
      const names = new Set();
      node.ports = [];
      for (const pt of n.ports) {
        const name = str(pt?.name, 40);
        if (!name) continue;
        if (names.has(name.toLowerCase())) throw new Error(`"${node.label}" has two ports called "${name}"`);
        names.add(name.toLowerCase());
        node.ports.push({ name, type: CABLES.includes(pt.type) ? pt.type : 'Ethernet', dir: PORT_DIRS.includes(pt.dir) ? pt.dir : 'io' });
      }
      portsOf.set(id, names);
    }
    return node;
  });
  const used = new Map();
  const outLinks = links.map((l, i) => {
    const from = str(l.from, 40); const to = str(l.to, 40);
    if (!ids.has(from) || !ids.has(to)) throw new Error(`Connection ${i + 1} refers to an unknown item`);
    if (from === to) throw new Error(`Connection ${i + 1} connects an item to itself`);
    const cable = CABLES.includes(l.cable) ? l.cable : 'Ethernet';
    const link = { from, to, cable };
    for (const k of ['fromPort', 'toPort']) if (str(l[k], 40)) link[k] = str(l[k], 40);
    for (const [end, port] of [[from, link.fromPort], [to, link.toPort]]) {
      if (!port || cable === 'Wireless') continue;
      const key = `${end}|${port.toLowerCase()}`;
      if (used.has(key)) {
        const label = outNodes.find((x) => x.id === end)?.label;
        throw new Error(`Port "${port}" on "${label}" has two cables plugged in (connections ${used.get(key)} and ${i + 1})`);
      }
      used.set(key, i + 1);
    }
    if (str(l.label, 24)) link.label = str(l.label, 24);
    const len = Number(l.length);
    if (l.length !== undefined && l.length !== null && l.length !== '' && Number.isFinite(len) && len > 0) link.length = Math.min(Math.round(len * 10) / 10, 1000);
    if (CONDITIONS.includes(l.condition)) link.condition = l.condition;
    if (str(l.note, 200)) link.note = str(l.note, 200);
    return link;
  });
  const out = { nodes: outNodes, links: outLinks, updatedAt: new Date().toISOString() };
  if (str(input.notes, 1000)) out.notes = str(input.notes, 1000);
  return out;
}

// Starting-point templates. Port names are typical for each product family;
// installers should adjust them to the room as built.
const RAW_TEMPLATES = [
  {
    id: 'logi-rallybar-appliance',
    name: 'Logitech Rally Bar appliance room',
    description: 'Rally Bar or Rally Bar Mini in appliance mode with a Tap IP controller and one display.',
    schematic: {
      nodes: [
        { id: 'bar', label: 'Rally Bar', kind: 'core', block: 'video-bar', model: 'Rally Bar' },
        { id: 'tap', label: 'Tap IP', kind: 'controller', block: 'controller', model: 'Tap IP' },
        { id: 'disp1', label: 'Front display', kind: 'display', block: 'display' },
        { id: 'laptop', label: 'Guest laptop (BYOD)', kind: 'source', block: 'laptop' },
        { id: 'switch', label: 'Network switch', kind: 'network', block: 'switch' },
      ],
      links: [
        { from: 'bar', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out 1', toPort: 'HDMI 1' },
        { from: 'laptop', to: 'bar', cable: 'HDMI', fromPort: 'HDMI', toPort: 'HDMI in', note: 'Content share' },
        { from: 'switch', to: 'bar', cable: 'Ethernet', fromPort: 'Port 1', toPort: 'LAN' },
        { from: 'switch', to: 'tap', cable: 'PoE', fromPort: 'Port 2', toPort: 'LAN' },
      ],
    },
  },
  {
    id: 'logi-pc-rally',
    name: 'Logitech Rally with room PC',
    description: 'Rally system with Table Hub and Display Hub, a Windows room PC, Tap touch controller and Scribe.',
    schematic: {
      nodes: [
        { id: 'pc', label: 'Room PC', kind: 'source', block: 'room-pc' },
        { id: 'tablehub', label: 'Rally Table Hub', kind: 'core', block: 'generic', model: 'Rally' },
        { id: 'displayhub', label: 'Rally Display Hub', kind: 'core', block: 'generic', model: 'Rally' },
        { id: 'cam', label: 'Rally camera', kind: 'camera', block: 'camera' },
        { id: 'mic', label: 'Rally Mic Pod', kind: 'audio', block: 'table-mic' },
        { id: 'tap', label: 'Tap', kind: 'controller', block: 'controller', model: 'Tap' },
        { id: 'scribe', label: 'Scribe', kind: 'camera', block: 'content-camera', model: 'Scribe' },
        { id: 'disp1', label: 'Front display', kind: 'display', block: 'display' },
        { id: 'switch', label: 'Network switch', kind: 'network', block: 'switch' },
      ],
      links: [
        { from: 'pc', to: 'tablehub', cable: 'USB', fromPort: 'USB 1', toPort: 'USB' },
        { from: 'tablehub', to: 'displayhub', cable: 'Ethernet', fromPort: 'Display Hub', toPort: 'Table Hub', note: 'Logitech CAT6 hub link' },
        { from: 'displayhub', to: 'cam', cable: 'Ethernet', fromPort: 'Camera', toPort: 'LAN' },
        { from: 'mic', to: 'tablehub', cable: 'Audio', fromPort: 'Mic out', toPort: 'Mic Pod', note: 'Mic Pod cable' },
        { from: 'pc', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out 1', toPort: 'HDMI 1' },
        { from: 'tap', to: 'pc', cable: 'USB', note: 'Strong USB cable' },
        { from: 'scribe', to: 'switch', cable: 'PoE' },
        { from: 'pc', to: 'switch', cable: 'Ethernet', toPort: 'Port 1' },
      ],
    },
  },
  {
    id: 'poly-studio-x',
    name: 'Poly Studio X series room',
    description: 'Poly Studio X30, X50 or X70 video bar with a TC8 or TC10 controller.',
    schematic: {
      nodes: [
        { id: 'bar', label: 'Poly Studio X50', kind: 'core', block: 'video-bar', model: 'Poly Studio X50' },
        { id: 'tc', label: 'Poly TC8', kind: 'controller', block: 'controller', model: 'Poly TC8' },
        { id: 'disp1', label: 'Front display', kind: 'display', block: 'display' },
        { id: 'laptop', label: 'Guest laptop (BYOD)', kind: 'source', block: 'laptop' },
        { id: 'switch', label: 'Network switch', kind: 'network', block: 'switch' },
      ],
      links: [
        { from: 'bar', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out 1', toPort: 'HDMI 1' },
        { from: 'laptop', to: 'bar', cable: 'HDMI', toPort: 'HDMI in', note: 'Content share' },
        { from: 'switch', to: 'bar', cable: 'Ethernet', toPort: 'LAN' },
        { from: 'switch', to: 'tc', cable: 'PoE', toPort: 'LAN', note: 'Paired to the video bar over the network' },
      ],
    },
  },
  {
    id: 'poly-g7500',
    name: 'Poly G7500 large room',
    description: 'G7500 codec with a Studio E70 camera, TC10 controller, Trio C60 and two displays.',
    schematic: {
      nodes: [
        { id: 'codec', label: 'Poly G7500', kind: 'core', block: 'codec', model: 'Poly G7500' },
        { id: 'cam', label: 'Poly Studio E70', kind: 'camera', block: 'camera', model: 'Poly Studio E70' },
        { id: 'tc', label: 'Poly TC10', kind: 'controller', block: 'controller', model: 'Poly TC10' },
        { id: 'trio', label: 'Poly Trio C60', kind: 'audio', block: 'speakerphone', model: 'Poly Trio C60' },
        { id: 'disp1', label: 'Left display', kind: 'display', block: 'display' },
        { id: 'disp2', label: 'Right display', kind: 'display', block: 'display' },
        { id: 'laptop', label: 'Guest laptop (BYOD)', kind: 'source', block: 'laptop' },
        { id: 'switch', label: 'Network switch', kind: 'network', block: 'switch' },
      ],
      links: [
        { from: 'codec', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out 1', toPort: 'HDMI 1' },
        { from: 'codec', to: 'disp2', cable: 'HDMI', fromPort: 'HDMI out 2', toPort: 'HDMI 1' },
        { from: 'cam', to: 'codec', cable: 'USB', toPort: 'Camera in' },
        { from: 'laptop', to: 'codec', cable: 'HDMI', toPort: 'HDMI in 1', note: 'Content share' },
        { from: 'switch', to: 'codec', cable: 'Ethernet', toPort: 'LAN' },
        { from: 'switch', to: 'tc', cable: 'PoE' },
        { from: 'switch', to: 'trio', cable: 'PoE', note: 'Paired with the G7500 as a speakerphone' },
      ],
    },
  },
  {
    id: 'byod-usb',
    name: 'BYOD huddle room (USB video bar)',
    description: 'A USB video bar such as Poly Studio connected to a room PC or guest laptop over USB.',
    schematic: {
      nodes: [
        { id: 'pc', label: 'Room PC or laptop', kind: 'source', block: 'room-pc' },
        { id: 'bar', label: 'Poly Studio', kind: 'core', block: 'video-bar', model: 'Poly Studio' },
        { id: 'disp1', label: 'Display', kind: 'display', block: 'display' },
        { id: 'switch', label: 'Network switch', kind: 'network', block: 'switch' },
      ],
      links: [
        { from: 'pc', to: 'bar', cable: 'USB', fromPort: 'USB 1', toPort: 'USB-C host' },
        { from: 'pc', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out 1', toPort: 'HDMI 1' },
        { from: 'pc', to: 'switch', cable: 'Ethernet' },
      ],
    },
  },
];

const PORT_FAMILY = { PoE: 'Ethernet', 'USB-C': 'USB', Speaker: 'Audio' };
const family = (t) => PORT_FAMILY[t] || t;
/** Can a cable of type `cable` plug into a port of type `port`? (PoE into LAN, USB-C into USB, ...) */
export const portFits = (port, cable) => family(port) === family(cable);
const IO_CABLES = new Set(['Ethernet', 'PoE', 'USB', 'USB-C', 'Fibre', 'Wireless']);

/**
 * Give every node a port list (from its building block) and every cable a
 * port at each end, so older schematics and templates open in the designer
 * port to port. Named ports a block lacks are added; unnamed cable ends take
 * the first free port that fits.
 */
export function withBlockPorts(schematic) {
  const out = structuredClone(schematic);
  out.nodes ||= []; out.links ||= [];
  for (const n of out.nodes) {
    if (Array.isArray(n.ports)) continue;
    const b = BLOCKS.find((x) => x.id === n.block) || BLOCKS.find((x) => x.kind === n.kind) || BLOCKS.find((x) => x.id === 'generic');
    n.block ||= b.id;
    n.ports = structuredClone(b.ports);
  }
  const node = new Map(out.nodes.map((n) => [n.id, n]));
  const used = new Set();
  const ends = (l) => [[l.from, 'fromPort', 'out'], [l.to, 'toPort', 'in']];
  const uniqueName = (n, base) => { let name = base; let i = 2; while (n.ports.some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${base} ${i++}`; return name; };
  for (const l of out.links) {
    for (const [id, key, dir] of ends(l)) {
      const n = node.get(id);
      if (!n || !l[key]) continue;
      let pt = n.ports.find((p) => p.name.toLowerCase() === l[key].toLowerCase());
      if (!pt) { pt = { name: l[key], type: l.cable, dir: IO_CABLES.has(l.cable) ? 'io' : dir }; n.ports.push(pt); }
      used.add(`${id}|${pt.name.toLowerCase()}`);
    }
  }
  for (const l of out.links) {
    for (const [id, key, dir] of ends(l)) {
      const n = node.get(id);
      if (!n || l[key]) continue;
      let pt = n.ports.find((p) => portFits(p.type, l.cable) && (p.dir === 'io' || p.dir === dir) && !used.has(`${id}|${p.name.toLowerCase()}`));
      if (!pt) { pt = { name: uniqueName(n, l.cable === 'PoE' ? 'LAN' : l.cable), type: l.cable, dir: IO_CABLES.has(l.cable) ? 'io' : dir }; n.ports.push(pt); }
      l[key] = pt.name;
      used.add(`${id}|${pt.name.toLowerCase()}`);
    }
  }
  return out;
}

export const SCHEMATIC_TEMPLATES = RAW_TEMPLATES.map((t) => ({ ...t, schematic: withBlockPorts(t.schematic) }));
