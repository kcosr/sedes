// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { TurnUsageAction } from "./TurnUsageAction.js";
const caches:UsageQueryCache[]=[];
afterEach(()=>{cleanup();caches.splice(0).forEach(cache=>cache.dispose());});
it("hides running and empty turns, then shows the action after durable usage arrives",async()=>{
  let available=false;
  const getUsage=vi.fn();
  const getUsageAvailability=vi.fn(async()=>({threadId:"thread",revision:"2",turns:[{turnId:"turn",available}]}));
  const cache=new UsageQueryCache("thread",{getUsage,getUsageAvailability});caches.push(cache);
  const turn={id:"turn",revision:1,status:"in_progress" as const,orderedItemIds:[]};
  const view=render(<TurnUsageAction cache={cache} turn={turn} onOpenChange={vi.fn()}/>);
  expect(screen.queryByRole("button",{name:"Turn usage and cost"})).toBeNull();
  expect(getUsageAvailability).not.toHaveBeenCalled();
  view.rerender(<TurnUsageAction cache={cache} turn={{...turn,status:"completed"}} onOpenChange={vi.fn()}/>);
  await waitFor(()=>expect(getUsageAvailability).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button",{name:"Turn usage and cost"})).toBeNull();
  available=true;cache.invalidate("2");
  expect(await screen.findByRole("button",{name:"Turn usage and cost"})).toBeVisible();
  expect(getUsage).not.toHaveBeenCalled();
});
