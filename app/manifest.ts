import type { MetadataRoute } from "next";
import { colourTokens } from "@/src/lib/design/tokens";
export default function manifest():MetadataRoute.Manifest {
  return {id:"/",name:"HMS · Your health history",short_name:"HMS",description:"Your health history and doctor connection.",start_url:"/",scope:"/",display:"standalone",
    background_color:colourTokens.light.groundTop,theme_color:colourTokens.light.groundTop,prefer_related_applications:false,
    icons:[{src:"/app-icon/192",sizes:"192x192",type:"image/png",purpose:"any"},{src:"/app-icon/512",sizes:"512x512",type:"image/png",purpose:"maskable"}]};
}
