/* Static engineering configuration of the MOIL mines modelled by the platform.
 *
 * Locations are approximate public positions. Plan tonnages, fleet sizes, pumping capacity and
 * ore-body geometry are representative values for a prototype — every field here is exactly what
 * a MOIL mine plan / equipment register would supply, and replacing this file (or the database
 * seeded from it) with MOIL's own records is the production path.
 */

// Equipment classes. group = which production constraint the unit feeds.
//   headroom: nominal group capacity at target availability, as a multiple of the daily plan
export const EQUIPMENT_CLASSES = {
  // underground
  winder:     { label: 'Shaft winder / hoist',      group: 'hoisting', mtbf: 720,  mttr: 16,  beta: 1.3, pm: 500, critical: true },
  lhd:        { label: 'LHD loader (3.5 m³)',       group: 'loading',  mtbf: 150,  mttr: 18,  beta: 1.5, pm: 250 },
  jumbo:      { label: 'Twin-boom drill jumbo',     group: 'drilling', mtbf: 180,  mttr: 16,  beta: 1.4, pm: 250 },
  loco:       { label: 'Battery locomotive',        group: 'haulage',  mtbf: 300,  mttr: 12,  beta: 1.3, pm: 400 },
  ug_pump:    { label: 'Main dewatering pump',      group: 'pumping',  mtbf: 900,  mttr: 22, beta: 1.2, pm: 700, critical: true },
  // open cast
  excavator:  { label: 'Hydraulic excavator (3.8 m³)', group: 'loading', mtbf: 170, mttr: 20, beta: 1.5, pm: 250 },
  dumper:     { label: 'Rear dumper (35 t)',        group: 'haulage',  mtbf: 130,  mttr: 16,  beta: 1.6, pm: 250 },
  dth_drill:  { label: 'DTH blast-hole drill',      group: 'drilling', mtbf: 200,  mttr: 14,  beta: 1.4, pm: 250 },
  oc_pump:    { label: 'Pit dewatering pump',       group: 'pumping',  mtbf: 850,  mttr: 18,  beta: 1.2, pm: 600, critical: true },
  // both
  crusher:    { label: 'Primary crusher & screen',  group: 'crushing', mtbf: 420,  mttr: 14,  beta: 1.3, pm: 400, critical: true },
};

export const GROUP_HEADROOM = { loading: 1.16, haulage: 1.14, hoisting: 1.22, drilling: 1.2, crushing: 1.3 };
export const GROUP_TARGET_AVAIL = { loading: 0.85, haulage: 0.85, hoisting: 0.92, drilling: 0.85, crushing: 0.92, pumping: 0.9 };
export const GROUP_LABEL = { loading: 'Loading', haulage: 'Haulage', hoisting: 'Hoisting', drilling: 'Drilling', crushing: 'Crushing', pumping: 'Dewatering' };

export const MINES = [
  {
    id: 'balaghat', name: 'Balaghat Mine', district: 'Balaghat', state: 'Madhya Pradesh', lat: 21.842, lng: 80.235,
    method: 'UG', methodLabel: 'Underground (shaft)', annualPlanT: 600000, baseEff: 0.975, gradeMn: 42.5, shifts: 3,
    fleet: { winder: 1, lhd: 9, jumbo: 5, loco: 4, ug_pump: 3, crusher: 1 },
    water: { pumpM3h: 290, baseInflowM3h: 280, rainFactor: 1.1, sumpM3: 26000 },
    ore: { strikeAz: 72, dip: 65, strikeLenM: 2400, dipExtentM: 950, thickM: 7.2, gradeSd: 5.5, minedToM: 430, planDepthM: 720, lenses: 2 },
    rom: { stockDays: 18 }, subcropOffsetM: [-150, 60],
  },
  {
    id: 'ukwa', name: 'Ukwa Mine', district: 'Balaghat', state: 'Madhya Pradesh', lat: 21.972, lng: 80.468,
    method: 'UG', methodLabel: 'Underground (adit + incline)', annualPlanT: 190000, baseEff: 0.965, gradeMn: 40.2, shifts: 2,
    fleet: { winder: 1, lhd: 4, jumbo: 3, loco: 2, ug_pump: 2, crusher: 1 },
    water: { pumpM3h: 170, baseInflowM3h: 120, rainFactor: 1.2, sumpM3: 12000 },
    ore: { strikeAz: 64, dip: 60, strikeLenM: 1700, dipExtentM: 620, thickM: 5.6, gradeSd: 5.0, minedToM: 250, planDepthM: 460, lenses: 1 },
    rom: { stockDays: 14 }, subcropOffsetM: [80, -40],
  },
  {
    id: 'tirodi', name: 'Tirodi Mine', district: 'Balaghat', state: 'Madhya Pradesh', lat: 21.685, lng: 79.72,
    method: 'OC', methodLabel: 'Open cast (mechanised)', annualPlanT: 240000, baseEff: 0.96, gradeMn: 37.6, shifts: 2,
    fleet: { excavator: 4, dumper: 12, dth_drill: 3, oc_pump: 4, crusher: 1 },
    water: { pumpM3h: 290, catchmentHa: 58, baseInflowM3h: 25, sumpM3: 32000 },
    ore: { strikeAz: 80, dip: 55, strikeLenM: 2200, dipExtentM: 520, thickM: 6.6, gradeSd: 6.0, minedToM: 95, planDepthM: 170, lenses: 2 },
    rom: { stockDays: 12 }, subcropOffsetM: [0, 0],
  },
  {
    id: 'dongri', name: 'Dongri Buzurg Mine', district: 'Bhandara', state: 'Maharashtra', lat: 21.62, lng: 79.755,
    method: 'OC', methodLabel: 'Open cast (mechanised)', annualPlanT: 450000, baseEff: 0.97, gradeMn: 40.8, shifts: 3,
    fleet: { excavator: 6, dumper: 18, dth_drill: 5, oc_pump: 5, crusher: 1 },
    water: { pumpM3h: 300, catchmentHa: 85, baseInflowM3h: 30, sumpM3: 45000 },
    ore: { strikeAz: 76, dip: 50, strikeLenM: 2600, dipExtentM: 560, thickM: 8.8, gradeSd: 5.2, minedToM: 110, planDepthM: 210, lenses: 2 },
    rom: { stockDays: 16 }, subcropOffsetM: [120, 30],
  },
  {
    id: 'chikla', name: 'Chikla Mine', district: 'Bhandara', state: 'Maharashtra', lat: 21.56, lng: 79.7,
    method: 'UG', methodLabel: 'Underground (shaft)', annualPlanT: 160000, baseEff: 0.962, gradeMn: 41.0, shifts: 2,
    fleet: { winder: 1, lhd: 4, jumbo: 3, loco: 2, ug_pump: 2, crusher: 1 },
    water: { pumpM3h: 150, baseInflowM3h: 115, rainFactor: 1.1, sumpM3: 10000 },
    ore: { strikeAz: 70, dip: 70, strikeLenM: 1400, dipExtentM: 640, thickM: 5.0, gradeSd: 5.0, minedToM: 265, planDepthM: 480, lenses: 1 },
    rom: { stockDays: 12 }, subcropOffsetM: [-60, 20],
  },
  {
    id: 'kandri', name: 'Kandri Mine', district: 'Nagpur', state: 'Maharashtra', lat: 21.42, lng: 79.275,
    method: 'UG', methodLabel: 'Underground + open cast', annualPlanT: 150000, baseEff: 0.968, gradeMn: 42.1, shifts: 2,
    fleet: { winder: 1, lhd: 4, jumbo: 3, loco: 2, ug_pump: 2, crusher: 1 },
    water: { pumpM3h: 160, baseInflowM3h: 105, rainFactor: 1.15, sumpM3: 10000 },
    ore: { strikeAz: 66, dip: 60, strikeLenM: 1500, dipExtentM: 600, thickM: 5.4, gradeSd: 5.2, minedToM: 205, planDepthM: 430, lenses: 1 },
    rom: { stockDays: 12 }, subcropOffsetM: [40, -70],
  },
  {
    id: 'munsar', name: 'Munsar Mine', district: 'Nagpur', state: 'Maharashtra', lat: 21.398, lng: 79.3,
    method: 'UG', methodLabel: 'Underground (shaft)', annualPlanT: 120000, baseEff: 0.955, gradeMn: 38.9, shifts: 2,
    fleet: { winder: 1, lhd: 3, jumbo: 2, loco: 2, ug_pump: 2, crusher: 1 },
    water: { pumpM3h: 130, baseInflowM3h: 95, rainFactor: 1.1, sumpM3: 8000 },
    ore: { strikeAz: 74, dip: 65, strikeLenM: 1250, dipExtentM: 560, thickM: 4.6, gradeSd: 5.4, minedToM: 185, planDepthM: 390, lenses: 1 },
    rom: { stockDays: 10 }, subcropOffsetM: [-40, 0],
  },
  {
    id: 'gumgaon', name: 'Gumgaon Mine', district: 'Nagpur', state: 'Maharashtra', lat: 21.37, lng: 78.985,
    method: 'UG', methodLabel: 'Underground (shaft)', annualPlanT: 110000, baseEff: 0.958, gradeMn: 40.0, shifts: 2,
    fleet: { winder: 1, lhd: 3, jumbo: 2, loco: 2, ug_pump: 2, crusher: 1 },
    water: { pumpM3h: 125, baseInflowM3h: 90, rainFactor: 1.05, sumpM3: 8000 },
    ore: { strikeAz: 68, dip: 60, strikeLenM: 1300, dipExtentM: 600, thickM: 5.0, gradeSd: 5.0, minedToM: 225, planDepthM: 420, lenses: 1 },
    rom: { stockDays: 10 }, subcropOffsetM: [20, 50],
  },
];

export const MINE_BY_ID = Object.fromEntries(MINES.map((m) => [m.id, m]));

// Commercial / operating constants used by the prescriptive engine
export const ECONOMICS = {
  orePriceINRperT: 13500,          // blended realisation for 35–46 % Mn ore
  densityTperM3: 3.9,              // in-situ bulk density of Mn ore
  cutoffMnPct: 25,                 // reserve cut-off grade
  interceptMnPct: 15,              // assay threshold that defines an ore intercept in a drill log
  shiftHours: { 2: 14, 3: 21 },    // productive hours per day for a 2- / 3-shift roster
};
