// Room schematics: what is in a room and how it is cabled.
//
// {
//   nodes: [{ id, label, kind, model?, deviceId?, x?, y? }],
//   links: [{ from, to, cable, fromPort?, toPort?, note? }]
// }
// kind:  core | controller | camera | audio | display | source | network | peripheral
// cable: HDMI | USB | USB-C | Ethernet | PoE | DisplayPort | Audio | Power | Wireless

export const NODE_KINDS = ['core', 'controller', 'camera', 'audio', 'display', 'source', 'network', 'peripheral'];
export const CABLES = ['HDMI', 'USB', 'USB-C', 'Ethernet', 'PoE', 'DisplayPort', 'Audio', 'Power', 'Wireless'];

const str = (v, max = 80) => (v === undefined || v === null ? undefined : String(v).slice(0, max).trim() || undefined);

/** Validate and normalise a schematic from the browser or an uploaded file. Throws on bad input. */
export function validateSchematic(input) {
  if (!input || typeof input !== 'object') throw new Error('Schematic must be an object with nodes and links');
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const links = Array.isArray(input.links) ? input.links : [];
  if (nodes.length > 60) throw new Error('A room schematic can have at most 60 items');
  if (links.length > 150) throw new Error('A room schematic can have at most 150 connections');
  const ids = new Set();
  const outNodes = nodes.map((n, i) => {
    const id = str(n.id, 40) || `n${i + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate item id "${id}"`);
    ids.add(id);
    const kind = NODE_KINDS.includes(n.kind) ? n.kind : 'peripheral';
    const node = { id, label: str(n.label) || id, kind };
    if (str(n.model)) node.model = str(n.model);
    if (str(n.deviceId, 300)) node.deviceId = str(n.deviceId, 300);
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) { node.x = Math.round(n.x); node.y = Math.round(n.y); }
    return node;
  });
  const outLinks = links.map((l, i) => {
    const from = str(l.from, 40); const to = str(l.to, 40);
    if (!ids.has(from) || !ids.has(to)) throw new Error(`Connection ${i + 1} refers to an unknown item`);
    if (from === to) throw new Error(`Connection ${i + 1} connects an item to itself`);
    const cable = CABLES.includes(l.cable) ? l.cable : 'Ethernet';
    const link = { from, to, cable };
    for (const k of ['fromPort', 'toPort']) if (str(l[k], 40)) link[k] = str(l[k], 40);
    if (str(l.note, 160)) link.note = str(l.note, 160);
    return link;
  });
  return { nodes: outNodes, links: outLinks, updatedAt: new Date().toISOString() };
}

// Starting-point templates. Port names are typical for each product family;
// installers should adjust them to the room as built.
export const SCHEMATIC_TEMPLATES = [
  {
    id: 'logi-rallybar-appliance',
    name: 'Logitech Rally Bar appliance room',
    description: 'Rally Bar or Rally Bar Mini in appliance mode with a Tap IP controller and one display.',
    schematic: {
      nodes: [
        { id: 'bar', label: 'Rally Bar', kind: 'core', model: 'Rally Bar' },
        { id: 'tap', label: 'Tap IP', kind: 'controller', model: 'Tap IP' },
        { id: 'disp1', label: 'Front display', kind: 'display' },
        { id: 'laptop', label: 'Guest laptop (BYOD)', kind: 'source' },
        { id: 'switch', label: 'Network switch', kind: 'network' },
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
        { id: 'pc', label: 'Room PC', kind: 'source' },
        { id: 'tablehub', label: 'Rally Table Hub', kind: 'core', model: 'Rally' },
        { id: 'displayhub', label: 'Rally Display Hub', kind: 'core', model: 'Rally' },
        { id: 'cam', label: 'Rally camera', kind: 'camera' },
        { id: 'mic', label: 'Rally Mic Pod', kind: 'audio' },
        { id: 'tap', label: 'Tap', kind: 'controller', model: 'Tap' },
        { id: 'scribe', label: 'Scribe', kind: 'camera', model: 'Scribe' },
        { id: 'disp1', label: 'Front display', kind: 'display' },
        { id: 'switch', label: 'Network switch', kind: 'network' },
      ],
      links: [
        { from: 'pc', to: 'tablehub', cable: 'USB', fromPort: 'USB 3.0', toPort: 'USB' },
        { from: 'tablehub', to: 'displayhub', cable: 'Ethernet', note: 'Logitech CAT6 hub link' },
        { from: 'displayhub', to: 'cam', cable: 'Ethernet', toPort: 'Camera' },
        { from: 'tablehub', to: 'mic', cable: 'Audio', note: 'Mic Pod cable' },
        { from: 'pc', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out', toPort: 'HDMI 1' },
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
        { id: 'bar', label: 'Poly Studio X50', kind: 'core', model: 'Poly Studio X50' },
        { id: 'tc', label: 'Poly TC8', kind: 'controller', model: 'Poly TC8' },
        { id: 'disp1', label: 'Front display', kind: 'display' },
        { id: 'laptop', label: 'Guest laptop (BYOD)', kind: 'source' },
        { id: 'switch', label: 'Network switch', kind: 'network' },
      ],
      links: [
        { from: 'bar', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out', toPort: 'HDMI 1' },
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
        { id: 'codec', label: 'Poly G7500', kind: 'core', model: 'Poly G7500' },
        { id: 'cam', label: 'Poly Studio E70', kind: 'camera', model: 'Poly Studio E70' },
        { id: 'tc', label: 'Poly TC10', kind: 'controller', model: 'Poly TC10' },
        { id: 'trio', label: 'Poly Trio C60', kind: 'audio', model: 'Poly Trio C60' },
        { id: 'disp1', label: 'Left display', kind: 'display' },
        { id: 'disp2', label: 'Right display', kind: 'display' },
        { id: 'laptop', label: 'Guest laptop (BYOD)', kind: 'source' },
        { id: 'switch', label: 'Network switch', kind: 'network' },
      ],
      links: [
        { from: 'codec', to: 'disp1', cable: 'HDMI', fromPort: 'HDMI out 1', toPort: 'HDMI 1' },
        { from: 'codec', to: 'disp2', cable: 'HDMI', fromPort: 'HDMI out 2', toPort: 'HDMI 1' },
        { from: 'cam', to: 'codec', cable: 'USB', toPort: 'Camera' },
        { from: 'laptop', to: 'codec', cable: 'HDMI', toPort: 'HDMI in' },
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
        { id: 'pc', label: 'Room PC or laptop', kind: 'source' },
        { id: 'bar', label: 'Poly Studio', kind: 'core', model: 'Poly Studio' },
        { id: 'disp1', label: 'Display', kind: 'display' },
        { id: 'switch', label: 'Network switch', kind: 'network' },
      ],
      links: [
        { from: 'pc', to: 'bar', cable: 'USB', fromPort: 'USB-A', toPort: 'USB-C' },
        { from: 'pc', to: 'disp1', cable: 'HDMI', toPort: 'HDMI 1' },
        { from: 'pc', to: 'switch', cable: 'Ethernet' },
      ],
    },
  },
];
