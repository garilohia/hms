"use client";
import { useEffect } from "react";
export function RegisterWorker() {
  useEffect(()=>{
    if("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js",{scope:"/",updateViaCache:"none"}).catch(()=>{});
  },[]);
  return null;
}
