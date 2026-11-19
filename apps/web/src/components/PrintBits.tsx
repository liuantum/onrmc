/** Shared bits for printed documents (invoices, notes, challans): the plant's logo and the platform credit. */
export const BRAND_CREDIT = 'Platform developed by liuantum LLP';

export function DocLogo({ src }: { src?: string | null }) {
  return src ? <img src={src} alt="" className="h-16 w-auto max-w-[160px] shrink-0 object-contain" /> : null;
}

export function DocFooter() {
  return <div className="mt-8 border-t border-slate-200 pt-2 text-center text-[10px] text-slate-400">Generated on onrmc · {BRAND_CREDIT}</div>;
}
