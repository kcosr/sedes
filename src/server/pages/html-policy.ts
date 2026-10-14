import { randomUUID } from "node:crypto";
import { defaultTreeAdapter, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { PAGE_RENDER_OVERHEAD_MAX_BYTES, PAGE_RESPONSE_MAX_BYTES } from "../../shared/protocol/pages.js";
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
const parent=host.parent,channel=host.name,freeze=host.Object.freeze,TypeError=host.TypeError;
const trim=host.Function.prototype.call.bind(host.String.prototype.trim),encoder=new host.TextEncoder(),encode=encoder.encode.bind(encoder);
const validId=host.RegExp.prototype.test.bind(/^[a-zA-Z0-9_-]{16,128}$/);
let producer,lastRequestId,disposed=false;
define(host,"sedes",{value:freeze({onSubmit(callback){if(typeof callback!=="function")throw new TypeError("onSubmit requires a synchronous text producer");if(disposed)return;producer=callback;send({type:"sedes:page-submit-ready",channel},"*");}}),writable:false,configurable:false});
addEventListener("message",event=>{
if(disposed||!event.isTrusted||event.source!==parent)return;
const data=event.data;if(!data||typeof data!=="object"||data.type!=="sedes:page-submit-request"||data.channel!==channel||typeof data.requestId!=="string"||!validId(data.requestId)||data.requestId===lastRequestId)return;
lastRequestId=data.requestId;
const reply={type:"sedes:page-submit-response",channel,requestId:data.requestId};
if(!producer)reply.error="not_registered";
else {try{const text=producer();if(typeof text!=="string"||!trim(text))reply.error="invalid_response";else if(text.length>${PAGE_RESPONSE_MAX_BYTES}||encode(text).byteLength>${PAGE_RESPONSE_MAX_BYTES})reply.error="response_too_large";else reply.text=text;}catch{reply.error="producer_failed";}}
send(reply,"*");
});
addEventListener("pagehide",()=>{disposed=true;producer=undefined;send({type:"sedes:page-submit-unavailable",channel},"*");},{once:true});
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
if(valid)frame.name=channel;
let loaded=false,failed=false,submitReady=false,pendingRequestId,lastRequestId;
const encoder=new TextEncoder();
const fail=()=>{if(failed)return;failed=true;frame.remove();if(valid)parent.postMessage({type:"sedes:page-error",channel},"*");};
frame.addEventListener("load",()=>{if(loaded)fail();else loaded=true;});frame.addEventListener("error",fail);
addEventListener("message",event=>{
if(failed||!valid)return;
const data=event.data;if(!data||typeof data!=="object")return;
if(event.source===parent){
if(!submitReady||data.type!=="sedes:page-submit-request"||data.channel!==channel||typeof data.requestId!=="string"||!/^[a-zA-Z0-9_-]{16,128}$/.test(data.requestId)||data.requestId===lastRequestId)return;
pendingRequestId=lastRequestId=data.requestId;frame.contentWindow.postMessage({type:"sedes:page-submit-request",channel,requestId:pendingRequestId},"*");return;
}
if(event.source!==frame.contentWindow)return;
if(data.type==="sedes:page-size"){if(Number.isInteger(data.height)&&data.height>=1&&data.height<=8192)parent.postMessage({type:"sedes:page-size",channel,height:data.height},"*");return;}
if(data.channel!==channel)return;
if(data.type==="sedes:page-submit-unavailable"){fail();return;}
if(data.type==="sedes:page-submit-ready"){submitReady=true;parent.postMessage({type:"sedes:page-submit-ready",channel},"*");return;}
if(data.type!=="sedes:page-submit-response"||!pendingRequestId||data.requestId!==pendingRequestId)return;
const reply={type:"sedes:page-submit-response",channel,requestId:pendingRequestId};pendingRequestId=undefined;
if(data.error==="not_registered"||data.error==="producer_failed"||data.error==="invalid_response"||data.error==="response_too_large")reply.error=data.error;
else if(typeof data.text!=="string"||!data.text.trim())reply.error="invalid_response";
else if(data.text.length>${PAGE_RESPONSE_MAX_BYTES}||encoder.encode(data.text).byteLength>${PAGE_RESPONSE_MAX_BYTES})reply.error="response_too_large";
else reply.text=data.text;
parent.postMessage(reply,"*");
});
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
