// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";

afterEach(() => vi.unstubAllGlobals());
const policy = {
  id:"11111111-1111-4111-8111-111111111111", name:"Everyday", enabledToolIds:["thread.list"],
  resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false}, revision:0,
  createdAt:"2026-10-17T00:00:00.000Z",updatedAt:"2026-10-17T00:00:00.000Z",
};
const response = (value:unknown) => new Response(JSON.stringify(value),{status:200,headers:{"Content-Type":"application/json"}});

describe("ApiClient tool policy pages", () => {
  it("collects bounded pages without dropping entries", async () => {
    const second = {...policy,id:"22222222-2222-4222-8222-222222222222",name:"Research"};
    const fetch = vi.fn().mockResolvedValueOnce(response({items:[policy],nextCursor:"next-page"})).mockResolvedValueOnce(response({items:[second]}));
    vi.stubGlobal("fetch",fetch);
    expect(await new ApiClient().listToolPolicySets()).toEqual({items:[policy,second]});
    expect(String(fetch.mock.calls[1]![0])).toContain("/api/tool-policies?cursor=next-page");
  });

  it("preserves structured missing-policy details on API errors", async () => {
    const issue = {kind:"missing_policy_set",source:"backend",policySetId:policy.id};
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:"not_found",message:"The backend policy set was not found.",retryable:false,toolPolicyIssue:issue}}),{status:404,headers:{"Content-Type":"application/json"}})));
    await expect(new ApiClient().getToolPolicySet(policy.id)).rejects.toMatchObject({code:"not_found",details:issue});
  });

  it("rejects a repeated continuation rather than loop forever", async () => {
    vi.stubGlobal("fetch",vi.fn().mockImplementation(async () => response({items:[policy],nextCursor:"same-page"})));
    await expect(new ApiClient().listToolPolicySets()).rejects.toThrow("did not advance");
  });
});
