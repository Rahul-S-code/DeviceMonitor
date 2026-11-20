// End-of-sale / end-of-support / end-of-life data for the models in the
// estate, taken only from official manufacturer (or platform) pages.
//
// Rule: a date goes in only when the manufacturer has published it. Where no
// notice exists the dates stay null and the status says "not-announced", so
// the app never shows a guessed date. Each entry keeps the pages checked.
//
// status: 'announced'      the manufacturer published lifecycle dates
//         'discontinued'   the manufacturer marks it discontinued but gives no dates
//         'not-announced'  no end-of-sale or end-of-life notice published
import { modelKey } from './models.js';

export const LIFECYCLE_CHECKED_AT = '2026-11-20';

const SRC = {
  hpPolyLifecycle: { label: 'HP Poly Android Device Lifecycle Strategy (Dec 2025)', url: 'https://static.lens.poly.com/HP%20Poly%20Android%20Device%20Lifecycle%20Strategy%20December%202025.pdf' },
  hpPolyNoList: { label: 'HP Poly staff: lifecycle dates are not hosted publicly', url: 'https://h30434.www3.hp.com/t5/Meeting-Room-Solutions/I-need-to-know-the-End-of-Life-and-End-of-Support-for-the/td-p/9319404' },
  teamsAndroid: { label: 'Microsoft: Teams Rooms on Android certified devices', url: 'https://learn.microsoft.com/microsoftteams/devices/certified-hardware-android?tabs=firmware' },
  logiPolicy: { label: 'Logitech End of Support Policy for CollabOS devices', url: 'https://hub.sync.logitech.com/collabosguides/post/logitech-s-end-of-support-policy-for-collabos-devices-Zq1wFaeI79KBd7y' },
  logiEosn: { label: 'Logitech End of Sale Notices', url: 'https://hub.sync.logitech.com/end-of-sale-notice' },
  shure: { label: 'Shure product end-of-life policy', url: 'https://www.shure.com/en-us/support/product-end-of-life' },
  brightsign: { label: 'BrightSign End of Life (EOL) Policy and matrix', url: 'https://docs.brightsign.biz/releases/end-of-life-eol-policy' },
  crestronTsw1070R: { label: 'Crestron TSW-1070R-W product page', url: 'https://www.crestron.com/Products/Catalog/Control-and-Management/User-Interfaces/Touchscreen/TSW-1070R-W' },
  crestronHdmd: { label: 'Crestron HD-MD-400-C-E product page', url: 'https://www.crestron.com/Products/Catalog/Inactive/Discontinued/H/HD-MD-400-C-E' },
  hpTrioC60: { label: 'HP Poly Trio C60 product page', url: 'https://www.hp.com/us-en/shop/mdp/hybrid-work/trio-c60' },
  hpCcx600: { label: 'HP Poly CCX 600 product page', url: 'https://hp.com/us-en/poly/phones/desk-phones/ccx-600.html' },
};

const POLY_GEN1 = 'HP Poly names this a first-generation video device (successors: Studio X32, X52, X72 and G62) but publishes no end-of-sale or end-of-life date for it. HP says dates are given through HP support or resellers.';
const POLY_NONE = 'No HP Poly end-of-sale or end-of-life notice published. HP does not host a public lifecycle list; ask HP support or a reseller.';
const LOGI_POLICY = 'No Logitech End of Sale Notice yet. Under Logitech\'s CollabOS policy, support runs 5 years from the End of Sale Notice once one is issued.';
const LOGI_NONE = 'No Logitech End of Sale Notice published for this model.';
const NONE = 'No end-of-sale or end-of-life notice published by the manufacturer.';
const teams = (date, extra = '') => `Microsoft Teams Rooms certification ends ${date}${extra}; Microsoft then supports the Teams app on it for 2 more years.`;

const n = (make, model, status, note, refs, dates = {}) => ({
  make, model, status, note, refs,
  endOfSale: dates.endOfSale ?? null, endOfSupport: dates.endOfSupport ?? null, endOfLife: dates.endOfLife ?? null,
});

export const LIFECYCLE_CATALOGUE = [
  // Poly (HP)
  n('Poly', 'Poly Studio X30', 'not-announced', POLY_GEN1, [SRC.hpPolyLifecycle, SRC.hpPolyNoList]),
  n('Poly', 'Poly Studio X50', 'not-announced', POLY_GEN1, [SRC.hpPolyLifecycle, SRC.hpPolyNoList]),
  n('Poly', 'Poly Studio X70', 'not-announced', POLY_GEN1, [SRC.hpPolyLifecycle, SRC.hpPolyNoList]),
  n('Poly', 'Poly G7500', 'not-announced', POLY_GEN1, [SRC.hpPolyLifecycle, SRC.hpPolyNoList]),
  n('Poly', 'Poly TC8', 'not-announced', `${POLY_GEN1} ${teams('3 Sep 2026', ' (Microsoft shows re-certification pending)')}`, [SRC.hpPolyLifecycle, SRC.teamsAndroid]),
  n('Poly', 'Poly TC10', 'not-announced', `${POLY_NONE} ${teams('15 Aug 2028')}`, [SRC.teamsAndroid, SRC.hpPolyNoList]),
  n('Poly', 'Poly Studio E70', 'not-announced', POLY_NONE, [SRC.hpPolyNoList]),
  n('Poly', 'Poly Trio C60', 'not-announced', `${POLY_NONE} Still listed for sale by HP.`, [SRC.hpTrioC60, SRC.hpPolyNoList]),
  n('Poly', 'Poly CCX 600', 'not-announced', `${POLY_NONE} Still listed by HP.`, [SRC.hpCcx600, SRC.hpPolyNoList]),
  n('Poly', 'Poly Studio', 'not-announced', POLY_NONE, [SRC.hpPolyNoList]),
  // Logitech
  n('Logitech', 'Rally Bar', 'not-announced', `${LOGI_POLICY} ${teams('15 Aug 2028')}`, [SRC.logiPolicy, SRC.logiEosn, SRC.teamsAndroid]),
  n('Logitech', 'Rally Bar Mini', 'not-announced', `${LOGI_POLICY} ${teams('15 Aug 2028')}`, [SRC.logiPolicy, SRC.logiEosn, SRC.teamsAndroid]),
  n('Logitech', 'Tap IP', 'not-announced', `${LOGI_POLICY} ${teams('15 Aug 2028')}`, [SRC.logiPolicy, SRC.logiEosn, SRC.teamsAndroid]),
  n('Logitech', 'Sight', 'not-announced', LOGI_POLICY, [SRC.logiPolicy, SRC.logiEosn]),
  n('Logitech', 'Tap', 'not-announced', LOGI_NONE, [SRC.logiEosn]),
  n('Logitech', 'Rally', 'not-announced', LOGI_NONE, [SRC.logiEosn]),
  n('Logitech', 'Scribe', 'not-announced', LOGI_NONE, [SRC.logiEosn]),
  n('Logitech', 'Spot', 'not-announced', LOGI_NONE, [SRC.logiEosn]),
  // AV and network kit
  n('Yealink', 'Yealink CP965', 'not-announced', NONE, []),
  n('Yealink', 'Yealink RoomPanel', 'not-announced', NONE, []),
  n('Neat', 'Neat Pad', 'not-announced', `${NONE} ${teams('15 Aug 2028', ' for the first-generation Neat Pad (nf19a1)')}`, [SRC.teamsAndroid]),
  n('Crestron', 'Crestron TSW-1070', 'not-announced', 'No dated end-of-sale notice for the TSW-1070. Crestron marks the Crestron Home variant (TSW-1070R-W) as Discontinued, without dates.', [SRC.crestronTsw1070R]),
  n('Crestron', 'Crestron CP4N', 'not-announced', NONE, []),
  n('Crestron', 'Crestron HD-MD-400-C-E', 'discontinued', 'Crestron marks it Discontinued and points to the HD-MD-400-C-E KIT, which is also discontinued. No end-of-sale or end-of-support dates are published; contact Crestron True Blue Support for a replacement.', [SRC.crestronHdmd]),
  n('Biamp', 'Biamp Tesira FORTE X 1600', 'not-announced', NONE, []),
  n('Biamp', 'Biamp Parlé TCM-X', 'not-announced', NONE, []),
  n('Shure', 'Shure MXA920', 'not-announced', 'Not on Shure\'s end-of-life notifications. Shure gives at least 6 months\' notice before the last order date.', [SRC.shure]),
  n('Shure', 'Shure IntelliMix P300', 'not-announced', 'Not on Shure\'s end-of-life notifications. Shure gives at least 6 months\' notice before the last order date.', [SRC.shure]),
  n('Q-SYS', 'Core Nano', 'not-announced', NONE, []),
  n('Q-SYS', 'NV-32-H (Core Capable)', 'not-announced', NONE, []),
  n('Q-SYS', 'PTZ-12x72', 'not-announced', NONE, []),
  n('BrightSign', 'BrightSign XT1144', 'not-announced', 'BrightSign\'s EOL matrix (updated 10 Nov 2026) shows no EOL announcement; BrightSignOS updates and technical support continue. Support for it in the legacy BrightAuthor Classic software ends 31 Dec 2026.', [SRC.brightsign]),
  n('Sony', 'BRAVIA FW-85BZ40L', 'not-announced', NONE, []),
  n('NETGEAR', 'NETGEAR M4250-10G2XF-PoE+', 'not-announced', NONE, []),
];

const BY_KEY = new Map(LIFECYCLE_CATALOGUE.map((e) => [modelKey(e.make, e.model), e]));

/** Catalogue entry for a make and model, or null. */
export function lifecycleFor(make, model) {
  return BY_KEY.get(modelKey(make, model)) ?? null;
}

/**
 * Fill a model's lifecycle fields from the catalogue. Leaves alone any model
 * an admin has already given dates, a status or a notice link.
 * Returns true when it changed the model.
 */
export function applyLifecycle(m) {
  const e = lifecycleFor(m.make, m.model);
  if (!e) return false;
  if (m.lifecycleSource === 'admin' || m.endOfSale || m.endOfSupport || m.endOfLife || m.lifecycleUrl || m.lifecycleStatus) return false;
  Object.assign(m, {
    endOfSale: e.endOfSale, endOfSupport: e.endOfSupport, endOfLife: e.endOfLife,
    lifecycleStatus: e.status, lifecycleNote: e.note,
    lifecycleUrl: e.refs[0]?.url ?? null, lifecycleRefs: e.refs.map((r) => ({ ...r })),
    lifecycleCheckedAt: LIFECYCLE_CHECKED_AT, lifecycleSource: 'catalogue',
  });
  return true;
}
