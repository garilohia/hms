"use client";
import { useState } from "react";
import { Apollo247Provider, Tata1mgProvider, type PharmacySearchLink } from "@/src/lib/pharmacy/providers";
const providers = { tata1mg: new Tata1mgProvider(), apollo247: new Apollo247Provider() };

export function PharmacySearch() {
  const [query, setQuery] = useState(""), [results, setResults] = useState<PharmacySearchLink[]>([]), [error, setError] = useState("");
  return <div className="card stack"><form className="stack" onSubmit={async event => {
    event.preventDefault(); setError("");
    try { setResults((await Promise.all(Object.values(providers).map(provider => provider.search(query)))).flat()); }
    catch { setResults([]); setError("Enter a search between 2 and 100 characters."); }
  }}>
    <label className="form-field">Product search<input minLength={2} maxLength={100} required value={query} onChange={event => { setQuery(event.target.value); setResults([]); }}/></label>
    <button className="button secondary">Prepare pharmacy links</button>
  </form>
    {results.map(result => <section key={result.provider} className="stack border-t border-slate-200 pt-4">
      <p>{result.provider === "tata1mg" ? "Tata 1mg" : "Apollo 24|7 / Apollo Pharmacy"}</p>
      <p className="muted">{result.prefilled ? "Opening this link sends only your search term to this pharmacy." : "On Apollo’s search page, enter: " + result.query + ". The link does not prefill your query."}</p>
      <a className="button secondary" href={providers[result.provider].deepLink(result)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{result.prefilled ? "Search on Tata 1mg" : "Open Apollo search"}</a>
    </section>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
