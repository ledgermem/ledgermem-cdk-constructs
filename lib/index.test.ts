import { describe, expect, it } from "vitest";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { MnemoCluster } from "./getmnemo-cluster.js";

describe("MnemoCluster", () => {
  it("provisions an Aurora cluster, ECS service, and Redis cache", () => {
    const app = new App();
    const stack = new Stack(app, "TestStack", { env: { account: "111111111111", region: "us-east-1" } });
    new MnemoCluster(stack, "Mnemo", { desiredCount: 1 });

    const t = Template.fromStack(stack);
    t.resourceCountIs("AWS::RDS::DBCluster", 1);
    t.resourceCountIs("AWS::ECS::Service", 1);
    t.resourceCountIs("AWS::ElastiCache::CacheCluster", 1);
    t.resourceCountIs("AWS::SecretsManager::Secret", 2); // db + api key
  });
});
