import { createClient } from "@/utils/supabase/server";
import { deviceSchema } from "@/src/lib/devices/model";
import { AppFrame } from "../../ui/frame";
import { DeviceComparison } from "./comparison";

export default async function DevicesPage() {
  const supabase = await createClient();
  // Public reference data only. No service secret and no patient data are needed here.
  const { data, error } = await supabase.from("device_catalog").select("brand,model,category,price_inr,price_usd,price_gbp,price_aed,metrics_supported,battery_days,has_ecg,has_skin_temp,has_spo2,has_hrv,has_screen,subscription_required,subscription_cost,update_class,connection_path,latency_label,realtime_capable,source_urls,last_verified_at,editorial_note").order("brand").order("model").limit(500).abortSignal(AbortSignal.timeout(10_000));
  const parsed = deviceSchema.array().safeParse(data);
  return <AppFrame><div className="stack"><h1 className="page-title">Which device?</h1>
    <p>Compare device features, not medical suitability. HMS does not sell devices or receive a commission from these links.</p>
    <p className="muted">Connection status and delay are shown separately from device features. “Real-time capable” means a vendor offers a streaming path; it does not mean HMS has that licensed/native connection today. HRV methods and skin, wrist and clinical body temperatures are not interchangeable.</p>
    {error || !parsed.success ? <section className="card"><p role="alert">The catalogue could not be loaded. Please reload to try again.</p></section> : parsed.data.length === 0 ? <section className="card"><p>The verified catalogue has not been published yet.</p></section> : <DeviceComparison devices={parsed.data}/>}
    <p className="muted">Features are manufacturer claims, not an HMS accuracy test. ECG, SpO₂ and other features may have age, phone and country restrictions. Check current availability, suitability, warranty and export support with the manufacturer before purchase.</p>
  </div></AppFrame>;
}
