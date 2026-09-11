"use client";
import { useState } from "react";
import { budgetEdges, currencies, defaultFilters, featureLabels, filterDevices, money, priceOf, verifiedDate, type Currency, type Device, type Feature, type Filters } from "@/src/lib/devices/model";

export function DeviceComparison({ devices }: { devices: Device[] }) {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [low, high] = budgetEdges[filters.currency];
  const matches = filterDevices(devices, filters);
  return <>
    <section className="card stack" aria-label="Device filters">
      <label className="field">Price currency<select value={filters.currency} onChange={e => setFilters({ ...filters, currency: e.target.value as Currency })}>{currencies.map(c => <option key={c} value={c}>{({ INR: "₹ INR", USD: "$ USD", GBP: "£ GBP", AED: "AED" })[c]}</option>)}</select></label>
      <label className="field">Budget band<select value={filters.budget} onChange={e => setFilters({ ...filters, budget: e.target.value as Filters["budget"] })}>
        <option value="any">Any price, including unverified</option><option value="entry">Below {money(low, filters.currency)}</option><option value="mid">{money(low, filters.currency)} to below {money(high, filters.currency)}</option><option value="premium">{money(high, filters.currency)} and above</option>
      </select></label>
      <fieldset className="stack"><legend className="font-semibold">Must have (all selected)</legend>{(Object.entries(featureLabels) as [Feature, string][]).map(([key, label]) => <label key={key} className="check-label"><input type="checkbox" checked={filters.features.includes(key)} onChange={e => setFilters({ ...filters, features: e.target.checked ? [...filters.features, key] : filters.features.filter(f => f !== key) })}/>{label}</label>)}</fieldset>
      <label className="field">Advertised battery life<select value={filters.battery} onChange={e => setFilters({ ...filters, battery: Number(e.target.value) })}><option value="0">Any, including unverified</option>{[1, 3, 7, 14].map(days => <option key={days} value={days}>At least {days} {days === 1 ? "day" : "days"}</option>)}</select></label>
      <div className="field"><label htmlFor="device-screen">Screen</label><select id="device-screen" value={filters.screen} onChange={e => setFilters({ ...filters, screen: e.target.value as Filters["screen"] })}><option value="any">Either</option><option value="yes">With a screen</option><option value="no">No screen</option></select></div>
      <div className="field"><label htmlFor="device-updates">Update path</label><select id="device-updates" value={filters.updates} onChange={e => setFilters({ ...filters, updates: e.target.value as Filters["updates"] })}><option value="any">Any update path</option><option value="live">Live stream</option><option value="near_realtime">Automatic, near real-time</option><option value="delayed">Automatic, delayed</option><option value="partner">Partner access needed</option><option value="manual">Manual import</option></select></div>
      <button className="button secondary" onClick={() => setFilters(defaultFilters)}>Reset filters</button>
      <p className="muted">Budget uses the displayed device or first-year bundle price, not lifetime cost. Unverified prices are excluded by a budget filter. No currency conversion is used. Battery filtering uses the advertised upper limit for the stated mode; real use varies. Unknown battery life and disposable sensor wear are excluded by a battery filter.</p>
    </section>
    <p role="status">{matches.length} {matches.length === 1 ? "device" : "devices"} match</p>
    {matches.length === 0 && <p>No devices match all these filters. Try removing a requirement.</p>}
    {matches.length > 0 && <section className="card stack" aria-labelledby="update-comparison"><div><p className="eyebrow">Connection reality</p><h2 id="update-comparison" className="font-semibold">Features and expected update delay</h2></div>
      <p className="muted">Live means the device can expose an ongoing stream through an approved SDK. Near real-time starts only after the wearable or phone has synced to its cloud. HMS processes a received batch immediately; the vendor-controlled first leg is usually the limiting delay.</p>
      <div className="device-table-wrap"><table className="device-table"><thead><tr><th>Device</th><th>Measurements</th><th>HMS connection</th><th>Expected delay</th><th>Live stream possible?</th></tr></thead><tbody>{matches.map(d => <tr key={"updates/" + d.brand + "/" + d.model}><th>{d.brand} {d.model}</th><td>{d.metrics_supported.map(m => m.replaceAll("_", " ")).join(", ")}</td><td><span className={"update-badge " + d.update_class}>{d.update_class.replaceAll("_", " ")}</span><br/>{d.connection_path}</td><td>{d.latency_label}</td><td>{d.realtime_capable ? "Yes, with vendor/native access" : "No continuous HMS stream"}</td></tr>)}</tbody></table></div>
    </section>}
    {matches.map(d => {
      const price = priceOf(d, filters.currency), features = (Object.entries(featureLabels) as [Feature, string][]).filter(([key]) => d[key]).map(([, label]) => label);
      return <article className="card stack" key={d.brand + "/" + d.model} aria-label={d.brand + " " + d.model}>
        <div><p className="eyebrow">{d.category.replaceAll("_", " ")}</p><h2 className="font-semibold">{d.brand} {d.model}</h2></div>
        <div><p className="type-title">{price === null ? "Check price" : "From " + money(price, filters.currency)}</p><p className="muted">{price === null ? "Price not verified in " + filters.currency + ". Sources checked " : "Price verified "}<time dateTime={d.last_verified_at.slice(0, 10)}>{verifiedDate(d.last_verified_at)}</time>.</p></div>
        <p>{d.editorial_note}</p>
        <p><strong>Updates:</strong> {d.connection_path}. {d.latency_label}</p>
        <p className="muted">{d.realtime_capable ? "A live stream is technically possible with the vendor's approved native/partner access." : "This route does not provide a continuous live stream to HMS."}</p>
        {features.length > 0 && <p className="muted">Verified listed features: {features.join(", ")}</p>}
        <p className="muted">{d.has_screen ? "With a screen" : "No screen"}. {d.battery_days === null ? "Battery days not listed" : "Up to " + (d.battery_days < 2 ? d.battery_days * 24 + " hours" : d.battery_days + " days")}</p>
        {d.subscription_required && <p><strong>Paid membership for full features.</strong> {d.subscription_cost}</p>}
        <details><summary>Measurements and sources</summary><div className="stack mt-3"><p className="muted">Selected device-side measurements: {d.metrics_supported.map(m => m.replaceAll("_", " ")).join(", ")}. This is not an import compatibility list.</p>{d.source_urls.map((url, i) => <a className="text-link" href={url} key={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Manufacturer source {i + 1} ({new URL(url).hostname})</a>)}</div></details>
        {price === null && <a className="text-link" href={d.source_urls[0]} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Check price with manufacturer</a>}
      </article>;
    })}
    <p className="muted">Prices are a dated snapshot, not a live offer. Entry configurations are shown; taxes, import costs, delivery and ongoing services may differ. Only positively verified features are listed; an omitted feature is not a confirmed absence.</p>
  </>;
}
