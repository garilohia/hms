import {notFound} from "next/navigation";
import {ownedProfiles} from "@/src/lib/patient/server";
import {careRead} from "@/src/lib/care/server";
import {linkSchema,listSchema,transferSchema} from "@/src/lib/care/model";
import {AppFrame} from "../../ui/frame";
import {Family} from "./family";
import {Transfers} from "./transfers";
import {DependentDetails} from "./details";
export default async function FamilyPage({searchParams}:{searchParams:Promise<{profile?:string}>}) {
  const {profiles,session}=await ownedProfiles(),requested=(await searchParams).profile;
  const profile=profiles.find(p=>requested?p.id===requested:p.kind==="self");if(!profile)notFound();
  const [links,incoming,offers]=await Promise.all([careRead({kind:"list",section:"caregivers",userId:profile.id}),careRead({kind:"list",section:"incoming"}),careRead({kind:"transfer_list"})]);
  return <AppFrame profile={profile} profiles={profiles}><h1 className="page-title">Family and caregivers</h1><div className="stack">{profile.kind==="dependent"&&<DependentDetails profile={profile}/>}<Family profile={profile} profiles={profiles} accountCode={session.user.id} initialLinks={listSchema(linkSchema).parse(links)} initialIncoming={listSchema(linkSchema).parse(incoming)}/><Transfers profile={profile} actor={session.user.id} initial={listSchema(transferSchema).parse(offers)}/></div></AppFrame>;
}
