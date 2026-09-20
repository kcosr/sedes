import { Capacitor } from "@capacitor/core";

export function isPackagedClient(): boolean {
  return Capacitor.isNativePlatform();
}

export function isAndroidClient(): boolean {
  return isPackagedClient() && Capacitor.getPlatform() === "android";
}

export function isElectronClient(): boolean {
  return isPackagedClient() && Capacitor.getPlatform() === "electron";
}
