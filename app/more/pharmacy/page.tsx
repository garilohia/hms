import { AppFrame } from "../../ui/frame";
import { PharmacySearch } from "./search";
export default function PharmacyPage() {
  return <AppFrame><div className="stack"><h1 className="page-title">Pharmacy</h1>
    <p>Use a medicine or product name already discussed with your doctor. HMS does not recommend medicines, choose a dose, check interactions or place an order.</p>
    <PharmacySearch/>
    <p className="muted">Link-only preview. No pharmacy API or partnership is connected. Prices, availability, prescription requirements and delivery are the external pharmacy’s responsibility. Do not enter your name, patient history or other private details in a search.</p>
  </div></AppFrame>;
}
