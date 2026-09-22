import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import type { ConversationTurn } from "../../../shared/index.js";
import type { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import { TurnUsagePopover } from "./TurnUsagePopover.js";

export function TurnUsageAction({cache,turn,onOpenChange}:{cache:UsageQueryCache;turn:ConversationTurn;onOpenChange:(open:boolean)=>void}):React.JSX.Element|null {
  if(turn.status==="in_progress")return null;
  return <AvailableTurnUsage cache={cache} turnId={turn.id} onOpenChange={onOpenChange}/>;
}
function AvailableTurnUsage({cache,turnId,onOpenChange}:{cache:UsageQueryCache;turnId:string;onOpenChange:(open:boolean)=>void}):React.JSX.Element|null {
  const visible=useContext(ChatViewVisibilityContext);
  const state=useSyncExternalStore(useCallback(listener=>cache.subscribe(turnId,listener),[cache,turnId]),useCallback(()=>cache.getSnapshot(turnId),[cache,turnId]));
  useEffect(()=>visible?cache.activateAvailability(turnId):undefined,[cache,turnId,visible]);
  return state.available===true?<TurnUsagePopover cache={cache} turnId={turnId} onOpenChange={onOpenChange}/>:null;
}
