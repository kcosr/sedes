export interface PageMeasurement {
  readonly width: number;
  readonly viewportHeight: number;
  readonly naturalHeight: number;
  readonly contentWidth: number;
}

export interface PageSizingState {
  readonly width: number;
  readonly viewportHeight: number;
  readonly naturalHeight: number;
  readonly acceptedHeight: number;
  readonly frozen: boolean;
  readonly steps: number;
}

/** Also serialized into the document: keep this pure and self-contained. */
export function stabilizePageHeight(previous: PageSizingState | undefined, measurement: PageMeasurement): PageSizingState {
  const width = Math.max(1, Math.round(Number.isFinite(measurement.width) ? measurement.width : 1));
  const viewportHeight = Math.max(1, Math.min(8192, Math.ceil(Number.isFinite(measurement.viewportHeight) ? measurement.viewportHeight : 1)));
  const naturalHeight = Math.max(1, Math.min(8192, Math.ceil(Number.isFinite(measurement.naturalHeight) ? measurement.naturalHeight : 1)));
  const current = { width, viewportHeight, naturalHeight };
  if (!previous || previous.width !== width) return { ...current, acceptedHeight: naturalHeight, frozen: false, steps: 0 };
  const viewportDelta = viewportHeight - previous.viewportHeight;
  const naturalDelta = naturalHeight - previous.naturalHeight;
  if (Math.abs(viewportDelta) <= 1) {
    if (Math.abs(naturalDelta) <= 1) return { ...previous, ...current };
    return { ...current, acceptedHeight: naturalHeight, frozen: false, steps: 0 };
  }
  if (previous.frozen) return { ...previous, ...current };
  const steps = previous.steps + 1;
  const tracksViewport = Math.sign(viewportDelta) === Math.sign(naturalDelta) && Math.abs(naturalDelta) >= Math.abs(viewportDelta) - 1;
  const retainsOverflow = Math.abs(naturalHeight - viewportHeight) > 1;
  if ((tracksViewport && retainsOverflow) || steps >= 6) return { ...current, acceptedHeight: previous.acceptedHeight, frozen: true, steps };
  return { ...current, acceptedHeight: naturalHeight, frozen: false, steps };
}

/** Install before authored scripts. Captured globals remain usable when an
 * authored script declares its own parent, Math, Promise, or browser helpers.
 * The preview browser also installs this before navigation, so it is idempotent. */
export const PAGE_MEASUREMENT_INSTALL_SOURCE = `(function(host){
"use strict";
const define=host.Object.defineProperty,descriptor=host.Object.getOwnPropertyDescriptor;
if(descriptor(host,"__sedesMeasurePage")&&descriptor(host,"__sedesSettlePage"))return;
const document=host.document,Math=host.Math,parseFloat=host.parseFloat;
const getComputedStyle=host.getComputedStyle.bind(host),requestAnimationFrame=host.requestAnimationFrame.bind(host),Promise=host.Promise;
const measure=()=>{
const root=document.documentElement,body=document.body;
const viewportHeight=host.innerHeight||root.clientHeight||1;
let naturalHeight=1;
if(body){const margin=parseFloat(getComputedStyle(body).marginBottom)||0;naturalHeight=body.getBoundingClientRect().bottom+host.scrollY+margin;const children=body.querySelectorAll("*");for(let index=0;index<Math.min(children.length,5000);index++)naturalHeight=Math.max(naturalHeight,children[index].getBoundingClientRect().bottom+host.scrollY+margin);}
if(root.scrollHeight>viewportHeight+1)naturalHeight=Math.max(naturalHeight,root.scrollHeight);
return {width:host.innerWidth||root.clientWidth||1,viewportHeight,naturalHeight:Math.max(1,Math.ceil(naturalHeight)),contentWidth:Math.max(root.scrollWidth,body?.scrollWidth||0)};
};
define(host,"__sedesMeasurePage",{value:measure,writable:false,configurable:false});
define(host,"__sedesSettlePage",{value:()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))),writable:false,configurable:false});
})`;

/** Top-level this bypasses authored global lexical declarations in the realm. */
export const PAGE_MEASUREMENT_EXPRESSION = "this.__sedesMeasurePage()";
export const PAGE_SETTLE_EXPRESSION = "this.__sedesSettlePage()";
