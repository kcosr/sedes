import { describe, expect, it } from "vitest";
import {
  executionBackendKinds,
  executionConfigurationSchemas,
} from "../../src/server/agent-tools/execution/execution-configuration-contracts.js";
import { compileCanonicalAgentToolSchema } from "../../src/server/agent-tools/schema/canonical-json-schema.js";

const mutation = {mutationId:"019196f7-a0a8-7bc4-a89b-8cf013978401",expectedRevision:1};

describe("execution configuration input contracts",()=>{
  const configure=compileCanonicalAgentToolSchema(executionConfigurationSchemas["backend.configure"].input);
  const create=compileCanonicalAgentToolSchema(executionConfigurationSchemas["backend.create"].input);

  it.each(executionBackendKinds)("keeps %s kind creation-only",kind=>{
    const input={...mutation,environmentId:"019196f7-a0a8-7bc4-a89b-8cf013978405"};
    expect(create.check({...input,backend:{kind,label:"Backend",environmentVariables:{execution:{set:[{name:"MODE",binding:{kind:"literal",value:"test"}}]}}}})).toBe(true);
    expect(create.check({...input,backend:{label:"Backend"}})).toBe(false);
    expect(create.check({...input,backend:{kind}})).toBe(false);
    expect(configure.check({...mutation,backendId:"backend",changes:{kind}})).toBe(false);
    expect(configure.check({...mutation,backendId:"backend",changes:{kind,label:"Backend"}})).toBe(false);
    expect(configure.check({...mutation,backendId:"backend",changes:{label:"Backend"}})).toBe(true);
  });
});
