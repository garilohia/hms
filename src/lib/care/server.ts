import "server-only";
import {notFound,redirect} from "next/navigation";
import {authenticatedClient} from "../auth/server";
import {careCommand,careRpc} from "./commands";
export async function careRead(input:unknown) {
  const session=await authenticatedClient();if(!session)redirect("/sign-in");
  const rpc=careRpc(careCommand.parse(input)),{data,error}=await session.client.rpc(rpc.name,rpc.args);
  if(error?.code==="42501")notFound();
  if(error)throw new Error("Care-team view temporarily unavailable ("+error.code+").");
  return data as unknown;
}
