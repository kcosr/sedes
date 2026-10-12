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
 * authored script declares its own parent, Math, Promise, WeakMap, or browser helpers.
 * The preview browser also installs this before navigation, so it is idempotent. */
export const PAGE_MEASUREMENT_INSTALL_SOURCE = `(function(host){
"use strict";
const define=host.Object.defineProperty,descriptor=host.Object.getOwnPropertyDescriptor;
if(descriptor(host,"__sedesMeasurePage")&&descriptor(host,"__sedesSettlePage"))return;
const document=host.document,Math=host.Math,parseFloat=host.parseFloat,WeakMap=host.WeakMap;
const getComputedStyle=host.getComputedStyle.bind(host),requestAnimationFrame=host.requestAnimationFrame.bind(host),Promise=host.Promise;
const measure=()=>{
const root=document.documentElement,body=document.body;
const viewportHeight=host.innerHeight||root.clientHeight||1;
let naturalHeight=1;
if(body){
const bodyStyle=getComputedStyle(body),rootStyle=getComputedStyle(root);
const margin=parseFloat(bodyStyle.marginBottom)||0;
naturalHeight=body.getBoundingClientRect().bottom+host.scrollY+margin;
// Overflow clips do not affect positioned descendants whose containing block
// is outside the clipping ancestor (CSS 2.1 11.1.1). Retain separate bounds for
// normal flow and each positioning containing block, including transformed or
// contained blocks, so escaping a clip does not discard applicable outer clips.
const bounds=new WeakMap(),unclipped={flow:Infinity,absolute:Infinity,fixed:Infinity};
const fixedContainer=(element,style)=>{
if(style.display==="contents")return false;
const changed=name=>style[name]&&style[name]!=="none";
const containment=style.contain.split(" "),willChange=style.willChange.split(",").map(value=>value.trim());
// Transforms and containment do not apply to non-replaced inline boxes;
// filters can still establish their fixed positioning containing block.
const atomic=style.display!=="inline"||element.namespaceURI==="http://www.w3.org/2000/svg";
return ["filter","backdropFilter"].some(changed)||["filter","backdrop-filter"].some(value=>willChange.includes(value))||atomic&&(
["transform","translate","rotate","scale","perspective"].some(changed)||
["layout","paint","strict","content"].some(value=>containment.includes(value))||
["transform","translate","rotate","scale","perspective","contain"].some(value=>willChange.includes(value))||
style.contentVisibility==="auto"||style.contentVisibility==="hidden");
};
const elementBounds=(element,style,rect,parent,usesOverflow=true)=>{
const inherited=style.position==="fixed"?parent.fixed:style.position==="absolute"?parent.absolute:parent.flow;
const overflow=style.overflowY||style.overflow;
const clips=usesOverflow&&(overflow==="hidden"||overflow==="clip"||overflow==="auto"||overflow==="scroll");
const flow=clips?Math.min(inherited,rect.bottom-(parseFloat(style.borderBottomWidth)||0)):inherited;
const fixes=fixedContainer(element,style),positions=style.display!=="contents"&&style.position!=="static";
return {inherited,flow,absolute:fixes||positions?flow:parent.absolute,fixed:fixes?flow:parent.fixed};
};
const children=body.querySelectorAll("*");
// Root overflow clips the viewport, which auto-height is still determining.
// Body overflow usually propagates there too, except when the root handles
// overflow itself or containment disables that HTML-specific propagation.
const bodyOverflowPropagates=rootStyle.overflowX==="visible"&&rootStyle.overflowY==="visible"&&
rootStyle.contain==="none"&&bodyStyle.contain==="none"&&
rootStyle.contentVisibility==="visible"&&bodyStyle.contentVisibility==="visible";
bounds.set(body,elementBounds(body,bodyStyle,body.getBoundingClientRect(),unclipped,!bodyOverflowPropagates));
for(let index=0;index<Math.min(children.length,5000);index++){
const child=children[index],rect=child.getBoundingClientRect(),style=getComputedStyle(child),parent=bounds.get(child.parentElement)||unclipped;
const state=elementBounds(child,style,rect,parent);
naturalHeight=Math.max(naturalHeight,Math.min(rect.bottom,state.inherited)+host.scrollY+margin);
bounds.set(child,state);
}
}
if(root.scrollHeight>viewportHeight+1)naturalHeight=Math.max(naturalHeight,root.scrollHeight);
return {width:host.innerWidth||root.clientWidth||1,viewportHeight,naturalHeight:Math.max(1,Math.ceil(naturalHeight)),contentWidth:Math.max(root.scrollWidth,body?.scrollWidth||0)};
};
define(host,"__sedesMeasurePage",{value:measure,writable:false,configurable:false});
define(host,"__sedesSettlePage",{value:()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))),writable:false,configurable:false});
})`;

/** Top-level this bypasses authored global lexical declarations in the realm. */
export const PAGE_MEASUREMENT_EXPRESSION = "this.__sedesMeasurePage()";
export const PAGE_SETTLE_EXPRESSION = "this.__sedesSettlePage()";
