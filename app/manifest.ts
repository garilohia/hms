import type { MetadataRoute } from "next";
export default function manifest():MetadataRoute.Manifest {
  return {id:"/",name:"HMS · Your health history",short_name:"HMS",description:"Your health history and doctor connection.",start_url:"/",scope:"/",display:"standalone",
    background_color:"#f4f7fb",theme_color:"#132f47",prefer_related_applications:false,
    icons:[{src:"/app-icon/192",sizes:"192x192",type:"image/png",purpose:"any"},{src:"/app-icon/512",sizes:"512x512",type:"image/png",purpose:"maskable"}]};
}
