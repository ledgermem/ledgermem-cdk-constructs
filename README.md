# `@ledgermem/cdk-constructs`

AWS CDK constructs for deploying **LedgerMem** on AWS.

## Install

```bash
npm install @ledgermem/cdk-constructs aws-cdk-lib constructs
```

## Use

```ts
import { App, Stack } from "aws-cdk-lib";
import { LedgerMemCluster } from "@ledgermem/cdk-constructs";
import * as route53 from "aws-cdk-lib/aws-route53";

const app = new App();
const stack = new Stack(app, "Memory");

new LedgerMemCluster(stack, "LedgerMem", {
  domainName: "memory.example.com",
  hostedZone: route53.HostedZone.fromLookup(stack, "Z", { domainName: "example.com" }),
  desiredCount: 3,
});
```

That's it — `cdk deploy` and you have:

- ALB with TLS via ACM (DNS-validated)
- ECS Fargate service (`ghcr.io/ledgermem/api:latest`) behind the ALB
- Aurora PostgreSQL 16 with pgvector
- ElastiCache Redis
- API key in Secrets Manager
- DB credentials in Secrets Manager
- VPC with NAT gateway (or supply your own)

## Constructs

### `LedgerMemCluster`

Production-grade Fargate + Aurora + ElastiCache. See [`lib/ledgermem-cluster.ts`](lib/ledgermem-cluster.ts) for full props.

### `LedgerMemServerless`

Lambda + Aurora Serverless v2 + HTTP API. For low-volume / dev use.

## Cost note

`LedgerMemCluster` defaults provision ~$200–$300/mo at idle (1 NAT GW, 1 Aurora writer, 1 Aurora reader, 2 Fargate tasks, 1 Redis node). Use `LedgerMemServerless` for ~$30/mo idle.

## License

MIT
