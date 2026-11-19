import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Smartphone } from 'lucide-react';

/** NPCI UPI deep link. Any UPI app (GPay, PhonePe, Paytm, BHIM, bank apps) reads it, with the amount filled in. */
export function upiLink(upiId: string, payee: string, amount?: number, note?: string) {
  const p = new URLSearchParams({ pa: upiId, pn: payee.slice(0, 50), cu: 'INR' });
  if (amount) p.set('am', amount.toFixed(2));
  if (note) p.set('tn', note.slice(0, 50));
  return `upi://pay?${p.toString().replace(/\+/g, '%20')}`;
}

/** QR for a UPI ID with the exact amount, plus an "open UPI app" button for phones. */
export function UpiQr({ upiId, payee, amount, note, size = 208 }: { upiId: string; payee: string; amount?: number; note?: string; size?: number }) {
  const link = upiLink(upiId, payee, amount, note);
  const [src, setSrc] = useState('');
  useEffect(() => { QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: size * 2 }).then(setSrc).catch(() => setSrc('')); }, [link, size]);
  return (
    <div className="flex flex-col items-center gap-2">
      {src ? <img src={src} alt={`UPI QR for ${upiId}`} style={{ width: size, height: size }} className="rounded-lg border border-slate-200" /> : <div style={{ width: size, height: size }} className="rounded-lg bg-slate-50" />}
      <div className="text-xs text-slate-500">Scan with any UPI app{amount ? ' · amount is filled in' : ''}</div>
      <a href={link} className="btn-ghost border border-slate-200 text-sm md:hidden"><Smartphone size={16} />Open UPI app</a>
    </div>
  );
}
