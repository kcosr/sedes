import { randomUUID } from "node:crypto";
import { defaultTreeAdapter, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { PAGE_RENDER_OVERHEAD_MAX_BYTES } from "../../shared/protocol/pages.js";
import { PAGE_MEASUREMENT_INSTALL_SOURCE, stabilizePageHeight } from "../../shared/page-sizing.js";

/** The trusted wrapper policy is inherited by its local srcdoc child.
 * frame-src blocks child self-navigation as well as new network frames. */
export const PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "font-src data:", "connect-src 'none'", "frame-src 'none'",
  "worker-src 'none'", "object-src 'none'", "media-src 'none'", "base-uri 'none'",
  "form-action 'none'", "sandbox allow-scripts",
].join("; ");

/** Host code is composed at delivery, so security updates apply to saved revisions. */
const PAGE_BOOTSTRAP = `<script>(function(host){
"use strict";
const document=host.document,Math=host.Math,Number=host.Number,Element=host.Element;
const define=host.Object.defineProperty,ResizeObserver=host.ResizeObserver,MutationObserver=host.MutationObserver;
const send=host.parent.postMessage.bind(host.parent),requestAnimationFrame=host.requestAnimationFrame.bind(host),addEventListener=host.addEventListener.bind(host);
for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","WebTransport"]){try{define(host,name,{value:undefined,writable:false,configurable:false});}catch{}}
${PAGE_MEASUREMENT_INSTALL_SOURCE}(host);
const measurePage=host.__sedesMeasurePage,stabilize=${stabilizePageHeight.toString()};
let scheduled=false,state;
const measure=()=>{scheduled=false;state=stabilize(state,measurePage());send({type:"sedes:page-size",height:state.acceptedHeight},"*");};
const schedule=()=>{if(!scheduled){scheduled=true;requestAnimationFrame(measure);}};
addEventListener("DOMContentLoaded",()=>{const observer=new ResizeObserver(schedule);observer.observe(document.documentElement);if(document.body)observer.observe(document.body);new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});schedule();},{once:true});
addEventListener("load",schedule,{once:true});addEventListener("resize",schedule);
addEventListener("click",event=>{if(event.target instanceof Element&&event.target.closest("a[href],area[href]"))event.preventDefault();},{capture:true});
addEventListener("submit",event=>event.preventDefault(),{capture:true});
})(this);</script>`;

export interface CapturedPageDocument {
  /** Escaped JSON string contents, without the enclosing quote delimiters. */
  readonly escapedHtml: string;
  /** UTF-16 offset at the start of the normalized document's head contents. */
  readonly bootstrapOffset: number;
}

const escapePayload = (value: string): string => JSON.stringify(value).slice(1, -1).replaceAll("<", "\\u003c");
const ESCAPED_BOOTSTRAP = escapePayload(PAGE_BOOTSTRAP);
const WRAPPER_PREFIX = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%;background:transparent}</style></head><body><script type="application/json" id="sedes-page-document">"`;
const WRAPPER_SUFFIX = `"</script><script>(()=>{
"use strict";
const channel=new URLSearchParams(location.hash.slice(1)).get("channel");
const valid=typeof channel==="string"&&/^[a-zA-Z0-9_-]{16,128}$/.test(channel);
const frame=document.createElement("iframe");frame.setAttribute("data-page-document","");frame.setAttribute("sandbox","allow-scripts");frame.title="Page content";frame.referrerPolicy="no-referrer";
let loaded=false,failed=false;
const fail=()=>{if(failed)return;failed=true;frame.remove();if(valid)parent.postMessage({type:"sedes:page-error",channel},"*");};
frame.addEventListener("load",()=>{if(loaded)fail();else loaded=true;});frame.addEventListener("error",fail);
addEventListener("message",event=>{if(failed||!valid||event.source!==frame.contentWindow)return;const data=event.data;if(!data||typeof data!=="object"||data.type!=="sedes:page-size"||!Number.isInteger(data.height)||data.height<1||data.height>8192)return;parent.postMessage({type:"sedes:page-size",channel,height:data.height},"*");});
const source=document.getElementById("sedes-page-document");frame.srcdoc=JSON.parse(source.textContent);source.remove();
if(valid)parent.postMessage({type:"sedes:page-wrapper-ready",channel},"*");
document.body.append(frame);
})();</script></body></html>`;

if (Buffer.byteLength(WRAPPER_PREFIX + ESCAPED_BOOTSTRAP + WRAPPER_SUFFIX, "utf8") > PAGE_RENDER_OVERHEAD_MAX_BYTES) {
  throw new Error("page_render_host_overhead_exceeded");
}

/** Use the importer's existing parsed DOM once; persist authored content only. */
export function capturePageDocument(document: DefaultTreeAdapterTypes.Document): CapturedPageDocument & { readonly authoredHtml: string } {
  const root = document.childNodes.find(node => "tagName" in node && node.tagName === "html");
  const head = root && "childNodes" in root ? root.childNodes.find(node => "tagName" in node && node.tagName === "head") : undefined;
  if (!head || !("tagName" in head)) throw new Error("page_document_head_missing");
  const marker = `sedes-page-bootstrap:${randomUUID()}`;
  const slot = defaultTreeAdapter.createCommentNode(marker);
  if (head.childNodes[0]) defaultTreeAdapter.insertBefore(head, slot, head.childNodes[0]);
  else defaultTreeAdapter.appendChild(head, slot);
  let serialized: string;
  try { serialized = serialize(document); }
  finally { defaultTreeAdapter.detachNode(slot); }
  const markup = `<!--${marker}-->`;
  const offset = serialized.indexOf(markup);
  if (offset < 0 || offset !== serialized.lastIndexOf(markup)) throw new Error("page_document_slot_missing");
  const before = serialized.slice(0, offset);
  const after = serialized.slice(offset + markup.length);
  const escapedBefore = escapePayload(before);
  return { authoredHtml: before + after, escapedHtml: escapedBefore + escapePayload(after), bootstrapOffset: escapedBefore.length };
}

/** Request-time work is string slicing and concatenation; no HTML parsing or
 * JSON re-encoding. Immutable authored payloads receive the current host code. */
export function renderPageDocument(document: CapturedPageDocument): string {
  const { escapedHtml, bootstrapOffset } = document;
  if (!Number.isSafeInteger(bootstrapOffset) || bootstrapOffset < 0 || bootstrapOffset > escapedHtml.length) {
    throw new Error("page_document_offset_invalid");
  }
  return WRAPPER_PREFIX + escapedHtml.slice(0, bootstrapOffset) + ESCAPED_BOOTSTRAP + escapedHtml.slice(bootstrapOffset) + WRAPPER_SUFFIX;
}
