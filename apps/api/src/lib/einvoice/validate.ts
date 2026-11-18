/** GST master-data validation used before anything is sent to the IRP / e-way bill system. */

export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

const CP = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check character (Luhn mod 36 over the first 14 characters). */
export function gstinCheckChar(g: string): string {
  let factor = 2, sum = 0;
  for (let i = 13; i >= 0; i--) {
    const a = factor * CP.indexOf(g[i]);
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(a / 36) + (a % 36);
  }
  return CP[(36 - (sum % 36)) % 36];
}

/** Returns an error message, or null when the GSTIN is valid. */
export function gstinError(g: string | null | undefined, label: string): string | null {
  if (!g) return `${label} GSTIN is missing`;
  const v = g.trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return `${label} GSTIN ${g} is not in the GSTIN format`;
  if (!STATE_CODES[v.slice(0, 2)]) return `${label} GSTIN ${g} has an unknown state code ${v.slice(0, 2)}`;
  if (gstinCheckChar(v) !== v[14]) return `${label} GSTIN ${g} fails the check digit — please re-check it`;
  return null;
}

export function pincodeError(p: string | null | undefined, label: string): string | null {
  if (!p) return `${label} PIN code is missing`;
  return /^[1-9][0-9]{5}$/.test(p.trim()) ? null : `${label} PIN code ${p} must be 6 digits`;
}

export function stateError(s: string | null | undefined, label: string): string | null {
  if (!s) return `${label} state code is missing`;
  return STATE_CODES[s] ? null : `${label} state code ${s} is not a valid GST state code`;
}

/** Vehicle numbers as the e-way bill system accepts them, e.g. TS09UA1234. */
export function normaliseVehicleNo(v: string) {
  return v.replace(/[\s-]/g, '').toUpperCase();
}
export function vehicleNoError(v: string | null | undefined): string | null {
  if (!v) return 'Vehicle number is required';
  return /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(normaliseVehicleNo(v)) || /^(TM|BP)[A-Z0-9]{6,13}$/.test(normaliseVehicleNo(v))
    ? null : `Vehicle number ${v} is not in a valid format (e.g. TS09UA1234)`;
}

/** Amount → integer paise, to compare totals exactly. */
export const paise = (n: number) => Math.round(n * 100);
